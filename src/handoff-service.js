import { objectWorkflowProfiles } from "./domain.js";
import {
  loadAggregate,
  loadAll,
} from "./aggregates.js";
import { newEventId } from "./store.js";

export class DomainRuleError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "DomainRuleError";
    this.code = code;
  }
}

/**
 * 入藏交接应用服务。所有写操作以领域事件落库，跨聚合的业务不变量在这里守卫：
 * - 交接单双方签署后才生效，占有变更必须引用生效交接单；
 * - 封签异常只冻结相关箱件（不整批放行），冻结箱件不得开箱、不得移交；
 * - 同源构件只能“提出匹配主张”，会审 approved 后才允许拼合；
 * - 造像/陶俑与恐龙骨架/蛋化石适用不同鉴定/保护流程；
 * - 拆套、并套、改名全部以事件保留原清单映射与名称链；
 * - request_id / customs_message_id 幂等，离线补传与重复报关不产生双重占有。
 */
export class HandoffService {
  #store;
  #now;

  constructor(store, { now = () => new Date() } = {}) {
    this.#store = store;
    this.#now = now;
  }

  get store() {
    return this.#store;
  }

  #ts(at) {
    return at ?? this.#now().toISOString();
  }

  /**
   * 追加事件（自动计算流版本）。
   * @returns {{event: object, replayed: boolean}}
   */
  #emit(type, id, eventType, summary, payload, meta = {}) {
    const version = this.#store.versionOf(type, id) + 1;
    const event = {
      event_id: meta.eventId ?? newEventId(eventType.toLowerCase()),
      event_type: eventType,
      aggregate_type: type,
      aggregate_id: id,
      occurred_at: this.#ts(meta.at),
      version,
      summary,
      payload,
    };
    if (meta.requestId) event.request_id = meta.requestId;
    if (meta.correlationId) event.correlation_id = meta.correlationId;
    if (meta.causationId) event.causation_id = meta.causationId;
    return this.#store.append(event, { requestId: meta.requestId });
  }

  /** 命令级幂等：同一 requestId 重放直接返回首次结果，不产生任何新事件。 */
  #dedupe(requestId) {
    if (requestId && this.#store.hasRequest(requestId)) {
      return { replayed: true, event: this.#store.getByRequest(requestId), events: [this.#store.getByRequest(requestId)] };
    }
    return null;
  }

  #index() {
    const all = loadAll(this.#store);
    const mergedAway = new Set();
    const splitParents = new Set();
    for (const [id, obj] of all.collection_object) {
      if (obj.lineage.splits.length > 0) splitParents.add(id);
      if (obj.lineage.merged_by_event) {
        for (const sid of obj.lineage.merged_by_event.source_object_ids) mergedAway.add(sid);
      }
    }
    return { all, mergedAway, splitParents };
  }

  // ── 美方移交批次 ────────────────────────────────────────────────

  receiveBatch(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const batchId = cmd.batch_id;
    if (this.#store.versionOf("return_batch", batchId) > 0) {
      throw new DomainRuleError("BATCH_EXISTS", `批次 ${batchId} 已接收，不能重复建批`);
    }
    return this.#emit("return_batch", batchId, "BATCH_RECEIVED",
      `接收 ${cmd.source_city === "washington" ? "华盛顿" : "纽约"} 移交批次 ${cmd.batch_no}`,
      {
        batch_no: cmd.batch_no,
        source_city: cmd.source_city,
        handover_party: cmd.handover_party,
        receiving_party: cmd.receiving_party,
        legal_basis: cmd.legal_basis,
        handover_location: cmd.handover_location,
        handover_at: this.#ts(cmd.handover_at),
        manifest: cmd.manifest,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  amendManifest(batchId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const batch = this.#requireBatch(batchId);
    return this.#emit("return_batch", batchId, "MANIFEST_AMENDED",
      `批次 ${batch.batch_no} 交接清单修订：${cmd.reason}`,
      { reason: cmd.reason, lines: cmd.lines, amended_by: cmd.amended_by },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  /** 报关消息：同一报关消息号重复到达只登记一次，绝不触发第二次占有变更。 */
  receiveCustomsMessage(batchId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    this.#requireBatch(batchId);
    const hit = this.#store.findEvent(
      (e) => e.event_type === "CUSTOMS_MESSAGE_RECEIVED" && e.payload?.customs_message_id === cmd.customs_message_id,
    );
    if (hit) {
      return { replayed: true, event: hit, events: [hit], duplicate_customs_message: true };
    }
    return this.#emit("return_batch", batchId, "CUSTOMS_MESSAGE_RECEIVED",
      `收到报关消息 ${cmd.customs_message_id}`,
      {
        customs_message_id: cmd.customs_message_id,
        received_at: this.#ts(cmd.received_at ?? cmd.at),
        manifest_line_nos: cmd.manifest_line_nos ?? [],
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  // ── 封签箱件 ────────────────────────────────────────────────────

  registerPackage(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const batch = this.#requireBatch(cmd.batch_id);
    for (const lineNo of cmd.manifest_line_nos) {
      if (!batch.manifest.has(lineNo)) {
        throw new DomainRuleError("MANIFEST_LINE_UNKNOWN", `清单行 ${lineNo} 不在批次 ${batch.batch_no} 中`);
      }
    }
    if (this.#store.versionOf("sealed_package", cmd.package_id) > 0) {
      throw new DomainRuleError("PACKAGE_EXISTS", `箱件 ${cmd.package_id} 已登记`);
    }
    return this.#emit("sealed_package", cmd.package_id, "PACKAGE_REGISTERED",
      `登记封签箱件 ${cmd.package_no}（批次 ${batch.batch_no}）`,
      {
        package_no: cmd.package_no,
        batch_id: cmd.batch_id,
        manifest_line_nos: cmd.manifest_line_nos,
        seals: cmd.seals,
        gross_weight_kg: cmd.gross_weight_kg,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  /**
   * 封签查验：任一签体破损/缺失/被拆动/号不符，立即冻结“该箱件”，
   * 同批其他箱件不受影响，更不会整批静默放行。
   */
  inspectSeals(packageId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const pkg = this.#requirePackage(packageId);
    const results = [];
    const events = [];
    const inspectedAt = this.#ts(cmd.inspected_at ?? cmd.at);
    for (const sealNo of cmd.seal_nos ?? []) {
      if (!pkg.seals.has(sealNo)) {
        results.push({ seal_no: sealNo, result: "number_mismatch", note: "箱上封签号与登记不符" });
      }
    }
    for (const r of cmd.results ?? []) results.push(r);

    let r = this.#emit("sealed_package", packageId, "SEAL_INSPECTED",
      `箱件 ${pkg.package_no} 封签查验`,
      { inspected_at: inspectedAt, inspector: cmd.inspector, results },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: inspectedAt });
    events.push(r.event);

    const bad = results.filter((x) => x.result !== "intact");
    if (bad.length > 0 && pkg.status !== "frozen") {
      const frozenAt = this.#ts(cmd.at ?? cmd.inspected_at);
      const f = this.#emit("sealed_package", packageId, "PACKAGE_FROZEN",
        `箱件 ${pkg.package_no} 封签异常，冻结待查：${bad.map((b) => `${b.seal_no}:${b.result}`).join("，")}`,
        {
          reason: bad.map((b) => `封签 ${b.seal_no} ${b.result}${b.note ? `（${b.note}）` : ""}`).join("；"),
          frozen_by: cmd.inspector,
          frozen_at: frozenAt,
          affected_seal_nos: bad.map((b) => b.seal_no),
        },
        { correlationId: cmd.correlation_id, causationId: r.event.event_id, at: frozenAt });
      events.push(f.event);
    }
    return { replayed: false, event: events[0], events, frozen: bad.length > 0 };
  }

  /** 冻结箱件经异常审查后方可放行；放行是显式动作，绝不“静默放行”。 */
  releasePackage(packageId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const pkg = this.#requirePackage(packageId);
    if (pkg.status !== "frozen") {
      throw new DomainRuleError("PACKAGE_NOT_FROZEN", `箱件 ${pkg.package_no} 当前未冻结，无需放行`);
    }
    return this.#emit("sealed_package", packageId, "PACKAGE_RELEASED",
      `箱件 ${pkg.package_no} 异常审查后放行`,
      {
        resolution_note: cmd.resolution_note,
        reviewed_by: cmd.reviewed_by,
        released_at: this.#ts(cmd.released_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  unpackPackage(packageId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const pkg = this.#requirePackage(packageId);
    if (pkg.status === "frozen") {
      throw new DomainRuleError("PACKAGE_FROZEN",
        `箱件 ${pkg.package_no} 因封签异常处于冻结状态，不得开箱；须先完成异常审查并放行`);
    }
    if (pkg.status === "unpacked") {
      throw new DomainRuleError("ALREADY_UNPACKED", `箱件 ${pkg.package_no} 已开箱`);
    }
    return this.#emit("sealed_package", packageId, "PACKAGE_UNPACKED",
      `箱件 ${pkg.package_no} 开箱清点`,
      { unpacked_at: this.#ts(cmd.unpacked_at ?? cmd.at), unpacked_by: cmd.unpacked_by, note: cmd.note },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  recordTransportEnvironment(packageId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const pkg = this.#requirePackage(packageId);
    return this.#emit("sealed_package", packageId, "TRANSPORT_ENVIRONMENT_RECORDED",
      `箱件 ${pkg.package_no} 运输环境记录${cmd.offline_backfill ? "（离线补传）" : ""}`,
      {
        leg_from: cmd.leg_from,
        leg_to: cmd.leg_to,
        recorded_at: this.#ts(cmd.recorded_at ?? cmd.at),
        offline_backfill: Boolean(cmd.offline_backfill),
        readings: cmd.readings,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  // ── 保管单元登记与拆套/并套 ─────────────────────────────────────

  registerObject(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const pkg = this.#requirePackage(cmd.package_id);
    if (pkg.status !== "unpacked") {
      throw new DomainRuleError("PACKAGE_NOT_UNPACKED",
        `箱件 ${pkg.package_no} 尚未开箱，不能登记保管单元`);
    }
    const batch = this.#requireBatch(cmd.batch_id);
    if (!batch.manifest.has(cmd.manifest_line_no)) {
      throw new DomainRuleError("MANIFEST_LINE_UNKNOWN", `清单行 ${cmd.manifest_line_no} 不在批次中`);
    }
    if (this.#store.versionOf("collection_object", cmd.object_id) > 0) {
      throw new DomainRuleError("OBJECT_EXISTS", `保管单元 ${cmd.object_id} 已登记`);
    }
    const line = batch.manifest.get(cmd.manifest_line_no);
    return this.#emit("collection_object", cmd.object_id, "OBJECT_REGISTERED",
      `登记保管单元 ${cmd.object_no}（${cmd.provisional_name}），映射清单行 ${cmd.manifest_line_no}/扣押号 ${cmd.seizure_no ?? line.seizure_no}`,
      {
        object_no: cmd.object_no,
        batch_id: cmd.batch_id,
        package_id: cmd.package_id,
        manifest_line_no: cmd.manifest_line_no,
        seizure_no: cmd.seizure_no ?? line.seizure_no,
        object_kind: cmd.object_kind,
        provisional_name: cmd.provisional_name,
        split_from_object_id: cmd.split_from_object_id,
        merged_from_object_ids: cmd.merged_from_object_ids,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  /**
   * 拆套：开箱后发现“一套”实为多个可独立保管单元。
   * 父对象流追加 OBJECT_SPLIT（原清单映射保留在父对象上），子单元各自建档并回指父对象。
   */
  splitObject(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const parent = this.#requireObject(objectId);
    if (parent.lineage.splits.length > 0) {
      throw new DomainRuleError("ALREADY_SPLIT", `保管单元 ${parent.object_no} 已拆套，不能重复拆分`);
    }
    const events = [];
    const splitAt = this.#ts(cmd.split_at ?? cmd.at);
    const s = this.#emit("collection_object", objectId, "OBJECT_SPLIT",
      `保管单元 ${parent.object_no} 拆分为 ${cmd.children.length} 个保管单元：${cmd.reason}`,
      {
        reason: cmd.reason,
        child_object_ids: cmd.children.map((c) => c.object_id),
        split_at: splitAt,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: splitAt });
    events.push(s.event);
    for (const child of cmd.children) {
      const c = this.#emit("collection_object", child.object_id, "OBJECT_REGISTERED",
        `拆套子单元 ${child.object_no}（源自 ${parent.object_no}，保留清单行 ${parent.manifest_line_no}）`,
        {
          object_no: child.object_no,
          batch_id: parent.batch_id,
          package_id: parent.package_id,
          manifest_line_no: parent.manifest_line_no,
          seizure_no: parent.seizure_no,
          object_kind: child.object_kind ?? parent.object_kind,
          provisional_name: child.provisional_name ?? `${parent.provisional_name}（拆套件）`,
          split_from_object_id: objectId,
        },
        { correlationId: cmd.correlation_id, causationId: s.event.event_id, at: splitAt });
      events.push(c.event);
    }
    return { replayed: false, event: events[0], events };
  }

  /** 并套：多个保管单元并入一个新保管单元，来源单元的清单映射通过 merged_from 保留。 */
  mergeObjects(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const { all, mergedAway, splitParents } = this.#index();
    const sources = cmd.source_object_ids.map((id) => {
      const o = all.collection_object.get(id);
      if (!o) throw new DomainRuleError("OBJECT_UNKNOWN", `保管单元 ${id} 不存在`);
      if (mergedAway.has(id) || splitParents.has(id)) {
        throw new DomainRuleError("OBJECT_RETIRED", `保管单元 ${id} 已拆/并，不能再次并套`);
      }
      return o;
    });
    const kinds = new Set(sources.map((o) => o.object_kind));
    if (kinds.size > 1) {
      throw new DomainRuleError("KIND_MISMATCH", `并套要求同类对象，发现：${[...kinds].join("/")}`);
    }
    if (this.#store.versionOf("collection_object", cmd.result_object_id) > 0) {
      throw new DomainRuleError("OBJECT_EXISTS", `并套结果单元 ${cmd.result_object_id} 已存在`);
    }
    const first = sources[0];
    const events = [];
    const mergedAt = this.#ts(cmd.merged_at ?? cmd.at);
    const reg = this.#emit("collection_object", cmd.result_object_id, "OBJECT_REGISTERED",
      `并套结果单元 ${cmd.result_object_no}（来源 ${sources.map((o) => o.object_no).join("、")}）`,
      {
        object_no: cmd.result_object_no,
        batch_id: first.batch_id,
        package_id: first.package_id,
        manifest_line_no: first.manifest_line_no,
        seizure_no: first.seizure_no,
        object_kind: first.object_kind,
        provisional_name: cmd.provisional_name ?? `${first.provisional_name}（并套件）`,
        merged_from_object_ids: cmd.source_object_ids,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: mergedAt });
    events.push(reg.event);
    const m = this.#emit("collection_object", cmd.result_object_id, "OBJECT_MERGED",
      `并套：${cmd.reason}`,
      {
        reason: cmd.reason,
        source_object_ids: cmd.source_object_ids,
        resulting_object_id: cmd.result_object_id,
        merged_at: mergedAt,
      },
      { correlationId: cmd.correlation_id, causationId: reg.event.event_id, at: mergedAt });
    events.push(m.event);
    return { replayed: false, event: events[0], events };
  }

  // ── 候选身份与名称修订 ─────────────────────────────────────────

  proposeIdentity(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    this.#requireObject(objectId);
    return this.#emit("collection_object", objectId, "IDENTITY_PROPOSED",
      `提出候选身份：${cmd.proposed_name}`,
      {
        candidate_id: cmd.candidate_id,
        proposed_name: cmd.proposed_name,
        period: cmd.period,
        attribution: cmd.attribution,
        confidence: cmd.confidence,
        evidence_refs: cmd.evidence_refs ?? [],
        proposed_by: cmd.proposed_by,
        proposed_at: this.#ts(cmd.proposed_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  assessIdentity(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const obj = this.#requireObject(objectId);
    if (!obj.candidates.has(cmd.candidate_id)) {
      throw new DomainRuleError("CANDIDATE_UNKNOWN", `候选身份 ${cmd.candidate_id} 不存在`);
    }
    this.#requireProfileForKind(obj, cmd.workflow_profile);
    return this.#emit("collection_object", objectId, "IDENTITY_ASSESSED",
      `候选身份 ${cmd.candidate_id} 经${cmd.workflow_profile === "cultural_relic" ? "文物" : "古生物"}流程鉴定：${cmd.finding}`,
      {
        candidate_id: cmd.candidate_id,
        workflow_profile: cmd.workflow_profile,
        finding: cmd.finding,
        opinion: cmd.opinion,
        report_ref: cmd.report_ref,
        assessed_by: cmd.assessed_by,
        assessed_at: this.#ts(cmd.assessed_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  confirmIdentity(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const obj = this.#requireObject(objectId);
    const candidate = obj.candidates.get(cmd.candidate_id);
    if (!candidate) throw new DomainRuleError("CANDIDATE_UNKNOWN", `候选身份 ${cmd.candidate_id} 不存在`);
    return this.#emit("collection_object", objectId, "IDENTITY_CONFIRMED",
      `确认身份：${cmd.confirmed_name}`,
      {
        candidate_id: cmd.candidate_id,
        confirmed_name: cmd.confirmed_name ?? candidate.proposed_name,
        attribution: cmd.attribution ?? candidate.attribution,
        confirmed_by: cmd.confirmed_by,
        confirmed_at: this.#ts(cmd.confirmed_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  /** 名称修订：previous/revised 成对留存，名称链永不覆盖。 */
  reviseName(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const obj = this.#requireObject(objectId);
    if (cmd.previous_name !== obj.current_name) {
      throw new DomainRuleError("NAME_MISMATCH",
        `当前名称为「${obj.current_name}」，与修订前名称「${cmd.previous_name}」不符`);
    }
    return this.#emit("collection_object", objectId, "IDENTITY_REVISED",
      `名称修订：${cmd.previous_name} → ${cmd.revised_name}`,
      {
        previous_name: cmd.previous_name,
        revised_name: cmd.revised_name,
        reason: cmd.reason,
        revised_by: cmd.revised_by,
        revised_at: this.#ts(cmd.revised_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  // ── 同源匹配主张与会审、拼合 ───────────────────────────────────

  claimMatch(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const { all } = this.#index();
    const objects = cmd.object_ids.map((id) => {
      const o = all.collection_object.get(id);
      if (!o) throw new DomainRuleError("OBJECT_UNKNOWN", `构件 ${id} 不存在`);
      return o;
    });
    const expectedRelation = {
      statue: "same_original_work",
      figurine: "same_original_work",
      dinosaur_skeleton: "same_skeleton",
      egg_fossil: "same_clutch",
    };
    for (const o of objects) {
      if (expectedRelation[o.object_kind] !== cmd.relation) {
        throw new DomainRuleError("RELATION_KIND_MISMATCH",
          `${o.object_kind} 类对象只能提出 ${expectedRelation[o.object_kind]} 主张，不能主张 ${cmd.relation}`);
      }
    }
    if (this.#store.versionOf("identity_match", cmd.match_id) > 0) {
      throw new DomainRuleError("MATCH_EXISTS", `匹配主张 ${cmd.match_id} 已存在`);
    }
    return this.#emit("identity_match", cmd.match_id, "MATCH_CLAIMED",
      `提出同源匹配主张：${cmd.hypothesis}`,
      {
        match_no: cmd.match_no,
        object_ids: cmd.object_ids,
        relation: cmd.relation,
        hypothesis: cmd.hypothesis,
        evidence_refs: cmd.evidence_refs ?? [],
        claimed_by: cmd.claimed_by,
        claimed_at: this.#ts(cmd.claimed_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  reviewMatch(matchId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const match = this.#requireMatch(matchId);
    if (match.review) {
      throw new DomainRuleError("MATCH_ALREADY_REVIEWED", `匹配主张 ${match.match_no} 已会审`);
    }
    return this.#emit("identity_match", matchId, "MATCH_REVIEWED",
      `会审匹配主张 ${match.match_no}：${cmd.decision}`,
      {
        decision: cmd.decision,
        panel_ref: cmd.panel_ref,
        panel_members: cmd.panel_members,
        opinion: cmd.opinion,
        reviewed_at: this.#ts(cmd.reviewed_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  /** 拼合：必须引用会审 approved 的匹配主张，否则一律拒绝（主张本身绝不等于拼合授权）。 */
  joinObjects(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const match = this.#requireMatch(cmd.match_id);
    if (match.status !== "approved") {
      throw new DomainRuleError("MATCH_NOT_APPROVED",
        `匹配主张 ${match.match_no} 未经会审通过（当前状态：${match.status}），不得拼合`);
    }
    for (const id of cmd.object_ids) {
      if (!match.object_ids.includes(id)) {
        throw new DomainRuleError("JOIN_SCOPE_MISMATCH", `构件 ${id} 不在会审通过的匹配范围内`);
      }
      this.#requireObject(id);
    }
    const events = [];
    const joinedAt = this.#ts(cmd.joined_at ?? cmd.at);
    for (const id of cmd.object_ids) {
      const j = this.#emit("collection_object", id, "OBJECT_JOINED",
        `依据会审 ${match.review.panel_ref} 拼合同源构件`,
        {
          match_id: cmd.match_id,
          object_ids: cmd.object_ids,
          resulting_object_id: cmd.resulting_object_id,
          joined_at: joinedAt,
          joined_by: cmd.joined_by,
        },
        { requestId: id === cmd.object_ids[0] ? cmd.request_id : undefined, correlationId: cmd.correlation_id, at: joinedAt });
      events.push(j.event);
    }
    return { replayed: false, event: events[0], events };
  }

  // ── 检测、保护处置与争议 ────────────────────────────────────────

  recordExamination(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const obj = this.#requireObject(objectId);
    this.#requireProfileForKind(obj, cmd.workflow_profile);
    return this.#emit("collection_object", objectId, "EXAMINATION_RECORDED",
      `${cmd.workflow_profile === "cultural_relic" ? "文物" : "古生物"}状态检测：${cmd.examination_type}`,
      {
        examination_no: cmd.examination_no,
        workflow_profile: cmd.workflow_profile,
        examination_type: cmd.examination_type,
        methods: cmd.methods ?? [],
        findings: cmd.findings,
        condition_rating: cmd.condition_rating,
        report_ref: cmd.report_ref,
        examiner: cmd.examiner,
        examined_at: this.#ts(cmd.examined_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  recordTreatment(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const obj = this.#requireObject(objectId);
    this.#requireProfileForKind(obj, cmd.workflow_profile);
    return this.#emit("collection_object", objectId, "TREATMENT_RECORDED",
      `${cmd.workflow_profile === "cultural_relic" ? "文物" : "古生物"}保护处置：${cmd.treatment_type}`,
      {
        treatment_no: cmd.treatment_no,
        workflow_profile: cmd.workflow_profile,
        treatment_type: cmd.treatment_type,
        materials: cmd.materials ?? [],
        result: cmd.result,
        conservator: cmd.conservator,
        treated_at: this.#ts(cmd.treated_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  raiseDispute(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    this.#requireObject(objectId);
    return this.#emit("collection_object", objectId, "DISPUTE_RAISED",
      `提出争议（${cmd.category}）：${cmd.description.slice(0, 40)}`,
      {
        dispute_no: cmd.dispute_no,
        category: cmd.category,
        description: cmd.description,
        raised_by: cmd.raised_by,
        raised_at: this.#ts(cmd.raised_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  resolveDispute(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const obj = this.#requireObject(objectId);
    const dispute = obj.disputes.get(cmd.dispute_no);
    if (!dispute) throw new DomainRuleError("DISPUTE_UNKNOWN", `争议 ${cmd.dispute_no} 不存在`);
    if (dispute.status === "resolved") {
      throw new DomainRuleError("DISPUTE_CLOSED", `争议 ${cmd.dispute_no} 已解决`);
    }
    return this.#emit("collection_object", objectId, "DISPUTE_RESOLVED",
      `争议 ${cmd.dispute_no} 已解决`,
      {
        dispute_no: cmd.dispute_no,
        resolution: cmd.resolution,
        resolved_by: cmd.resolved_by,
        resolved_at: this.#ts(cmd.resolved_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  // ── 交接签署与占有链 ────────────────────────────────────────────

  draftAcceptance(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    this.#requireBatch(cmd.batch_id);
    const { all } = this.#index();
    for (const ref of cmd.item_refs) {
      const map = ref.scope_type === "sealed_package" ? all.sealed_package : all.collection_object;
      if (!map.has(ref.scope_id)) {
        throw new DomainRuleError("REF_UNKNOWN", `交接范围引用不存在：${ref.scope_type}/${ref.scope_id}`);
      }
    }
    if (this.#store.versionOf("custody_acceptance", cmd.acceptance_id) > 0) {
      throw new DomainRuleError("ACCEPTANCE_EXISTS", `交接单 ${cmd.acceptance_id} 已存在`);
    }
    return this.#emit("custody_acceptance", cmd.acceptance_id, "ACCEPTANCE_DRAFTED",
      `起草交接单 ${cmd.acceptance_no}`,
      {
        acceptance_no: cmd.acceptance_no,
        batch_id: cmd.batch_id,
        handover_party: cmd.handover_party,
        receiving_party: cmd.receiving_party,
        item_refs: cmd.item_refs,
        drafted_at: this.#ts(cmd.drafted_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  /**
   * 签署：任一方签署都不生效；第二方签署完成的同一事务内追加 ACCEPTANCE_EFFECTIVE。
   * 同一方重复签署被拒绝。
   */
  signAcceptance(acceptanceId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const acc = this.#requireAcceptance(acceptanceId);
    if (acc.effective) {
      throw new DomainRuleError("ACCEPTANCE_EFFECTIVE", `交接单 ${acc.acceptance_no} 已生效，不能补签`);
    }
    if (acc.signatures[cmd.party]) {
      throw new DomainRuleError("PARTY_ALREADY_SIGNED", `${cmd.party === "handover" ? "移交方" : "接收方"}已签署`);
    }
    const events = [];
    const signedAt = this.#ts(cmd.signed_at ?? cmd.at);
    const s = this.#emit("custody_acceptance", acceptanceId, "ACCEPTANCE_SIGNED",
      `${cmd.party === "handover" ? "移交方" : "接收方"}签署交接单 ${acc.acceptance_no}`,
      {
        party: cmd.party,
        signatory: cmd.signatory,
        signature_ref: cmd.signature_ref,
        signed_at: signedAt,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: signedAt });
    events.push(s.event);

    const after = loadAggregate(this.#store, "custody_acceptance", acceptanceId);
    if (after.signatures.handover && after.signatures.receiving) {
      const effectiveAt = this.#ts(cmd.effective_at ?? cmd.at);
      const f = this.#emit("custody_acceptance", acceptanceId, "ACCEPTANCE_EFFECTIVE",
        `交接单 ${acc.acceptance_no} 双方签署完成，交接生效`,
        { effective_at: effectiveAt },
        { correlationId: cmd.correlation_id, causationId: s.event.event_id, at: effectiveAt });
      events.push(f.event);
    }
    return { replayed: false, event: events[0], events, effective: events.length === 2 };
  }

  /** 离线扫码：只登记保管记录，uploaded_at 允许晚于 scanned_at；request_id 去重防重复补传。 */
  recordCustodyScan(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    this.#requireObject(objectId);
    const scannedAt = this.#ts(cmd.scanned_at ?? cmd.at);
    const uploadedAt = this.#ts(cmd.uploaded_at ?? cmd.at);
    return this.#emit("collection_object", objectId, "CUSTODY_SCAN_RECORDED",
      `保管扫码：${cmd.custodian}${cmd.offline ? "（离线补传）" : ""}`,
      {
        scan_no: cmd.scan_no,
        custodian: cmd.custodian,
        scanned_at: scannedAt,
        uploaded_at: uploadedAt,
        offline: Boolean(cmd.offline ?? uploadedAt !== scannedAt),
        location: cmd.location,
        note: cmd.note,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at ?? uploadedAt });
  }

  /**
   * 占有变更：必须引用已双方签署生效的交接单，且标的必须在交接单范围内；
   * 冻结箱件及其内对象不得移交；from_custodian 必须等于当前占有人，
   * 重放/乱序消息无法造成第二次占有变更（重复报关消息根本不产生本类事件）。
   */
  transferCustody(scopeType, scopeId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    if (!["sealed_package", "collection_object"].includes(scopeType)) {
      throw new DomainRuleError("SCOPE_UNSUPPORTED", `占有变更范围只能是箱件或保管单元`);
    }
    const acc = this.#requireAcceptance(cmd.acceptance_id);
    if (!acc.effective) {
      throw new DomainRuleError("ACCEPTANCE_NOT_EFFECTIVE",
        `交接单 ${acc.acceptance_no} 尚未经双方签署生效，不得移交占有`);
    }
    const inScope = acc.item_refs.some((r) => r.scope_type === scopeType && r.scope_id === scopeId);
    if (!inScope) {
      throw new DomainRuleError("NOT_IN_ACCEPTANCE_SCOPE", `${scopeType}/${scopeId} 不在交接单 ${acc.acceptance_no} 范围内`);
    }

    if (scopeType === "sealed_package") {
      const pkg = this.#requirePackage(scopeId);
      if (pkg.status === "frozen") {
        throw new DomainRuleError("PACKAGE_FROZEN", `箱件 ${pkg.package_no} 已冻结，不得移交`);
      }
      const last = pkg.custody[pkg.custody.length - 1];
      if (last && last.to !== cmd.from_custodian) {
        throw new DomainRuleError("CUSTODY_CHAIN_BROKEN",
          `箱件当前占有人为 ${last.to}，与移交方 ${cmd.from_custodian} 不符，拒绝重复/越权移交`);
      }
    } else {
      const { mergedAway, splitParents, all } = this.#index();
      const obj = all.collection_object.get(scopeId);
      if (!obj) throw new DomainRuleError("OBJECT_UNKNOWN", `保管单元 ${scopeId} 不存在`);
      if (splitParents.has(scopeId)) {
        throw new DomainRuleError("OBJECT_SPLIT_RETIRED", `保管单元 ${obj.object_no} 已拆套，占有由其子单元承担`);
      }
      if (mergedAway.has(scopeId)) {
        throw new DomainRuleError("OBJECT_MERGED_RETIRED", `保管单元 ${obj.object_no} 已并套，占有由并套结果单元承担`);
      }
      const pkg = all.sealed_package.get(obj.package_id);
      if (pkg?.status === "frozen") {
        throw new DomainRuleError("PACKAGE_FROZEN", `所在箱件 ${pkg.package_no} 已冻结，对象不得移交`);
      }
      const last = obj.custody[obj.custody.length - 1];
      if (last && last.to !== cmd.from_custodian) {
        throw new DomainRuleError("CUSTODY_CHAIN_BROKEN",
          `对象当前占有人为 ${last.to}，与移交方 ${cmd.from_custodian} 不符，拒绝重复/越权移交`);
      }
    }

    const summaryScope = scopeType === "sealed_package" ? "箱件" : "保管单元";
    return this.#emit(scopeType, scopeId, "CUSTODY_TRANSFERRED",
      `${summaryScope}占有移交：${cmd.from_custodian} → ${cmd.to_custodian}（交接单 ${acc.acceptance_no}）`,
      {
        acceptance_id: cmd.acceptance_id,
        from_custodian: cmd.from_custodian,
        to_custodian: cmd.to_custodian,
        transferred_at: this.#ts(cmd.transferred_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  // ── 入藏决定与公共发布 ─────────────────────────────────────────

  proposeAccession(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const { mergedAway, splitParents } = this.#index();
    this.#requireObject(objectId);
    if (splitParents.has(objectId)) {
      throw new DomainRuleError("OBJECT_SPLIT_RETIRED", "已拆套父单元应由子单元办理入藏");
    }
    if (mergedAway.has(objectId)) {
      throw new DomainRuleError("OBJECT_MERGED_RETIRED", "已并套来源单元应由结果单元办理入藏");
    }
    return this.#emit("collection_object", objectId, "ACCESSION_PROPOSED",
      `拟入藏 ${cmd.proposed_institution}`,
      {
        proposed_institution: cmd.proposed_institution,
        proposed_by: cmd.proposed_by,
        proposed_at: this.#ts(cmd.proposed_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  confirmAccession(objectId, cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const { mergedAway, splitParents } = this.#index();
    const obj = this.#requireObject(objectId);
    if (splitParents.has(objectId)) {
      throw new DomainRuleError("OBJECT_SPLIT_RETIRED", `保管单元 ${obj.object_no} 已拆套，应由子单元入藏`);
    }
    if (mergedAway.has(objectId)) {
      throw new DomainRuleError("OBJECT_MERGED_RETIRED", `保管单元 ${obj.object_no} 已并套，应由结果单元入藏`);
    }
    if (!obj.confirmed_candidate_id) {
      throw new DomainRuleError("IDENTITY_NOT_CONFIRMED", `保管单元 ${obj.object_no} 身份尚未确认，不能入藏`);
    }
    const openDisputes = [...obj.disputes.values()].filter((d) => d.status === "open");
    if (openDisputes.length > 0) {
      throw new DomainRuleError("DISPUTE_OPEN", `尚有 ${openDisputes.length} 项未解决争议，不能办理入藏`);
    }
    return this.#emit("collection_object", objectId, "ACCESSION_CONFIRMED",
      `办理入藏：${cmd.institution} 藏 ${obj.current_name}（入藏号 ${cmd.accession_no}）`,
      {
        accession_no: cmd.accession_no,
        institution: cmd.institution,
        registered_name: cmd.registered_name ?? obj.current_name,
        confirmed_at: this.#ts(cmd.confirmed_at ?? cmd.at),
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  issuePublication(cmd) {
    const dup = this.#dedupe(cmd.request_id);
    if (dup) return dup;
    const { all } = this.#index();
    for (const id of cmd.object_ids) {
      const obj = all.collection_object.get(id);
      if (!obj) throw new DomainRuleError("OBJECT_UNKNOWN", `发布对象 ${id} 不存在`);
      if (!obj.confirmed_candidate_id) {
        throw new DomainRuleError("UNCONFIRMED_NOT_PUBLISHABLE",
          `对象 ${obj.object_no} 身份未确认，疑似信息不得公开发布`);
      }
      if (!obj.accession) {
        throw new DomainRuleError("NOT_ACCESSIONED", `对象 ${obj.object_no} 尚未入藏，不能公开发布`);
      }
    }
    return this.#emit("publication_release", cmd.release_id, "PUBLICATION_ISSUED",
      `公开发布 ${cmd.release_no}：${cmd.object_ids.length} 件已确认入藏品`,
      {
        release_no: cmd.release_no,
        title: cmd.title,
        issued_at: this.#ts(cmd.issued_at ?? cmd.at),
        object_ids: cmd.object_ids,
      },
      { requestId: cmd.request_id, correlationId: cmd.correlation_id, at: cmd.at });
  }

  // ── 加载辅助 ────────────────────────────────────────────────────

  #requireBatch(id) {
    const batch = loadAggregate(this.#store, "return_batch", id);
    if (!batch.exists) throw new DomainRuleError("BATCH_UNKNOWN", `批次 ${id} 不存在`);
    return batch;
  }

  #requirePackage(id) {
    const pkg = loadAggregate(this.#store, "sealed_package", id);
    if (!pkg.exists) throw new DomainRuleError("PACKAGE_UNKNOWN", `箱件 ${id} 不存在`);
    return pkg;
  }

  #requireObject(id) {
    const obj = loadAggregate(this.#store, "collection_object", id);
    if (!obj.exists) throw new DomainRuleError("OBJECT_UNKNOWN", `保管单元 ${id} 不存在`);
    return obj;
  }

  #requireAcceptance(id) {
    const acc = loadAggregate(this.#store, "custody_acceptance", id);
    if (!acc.exists) throw new DomainRuleError("ACCEPTANCE_UNKNOWN", `交接单 ${id} 不存在`);
    return acc;
  }

  #requireMatch(id) {
    const match = loadAggregate(this.#store, "identity_match", id);
    if (!match.exists) throw new DomainRuleError("MATCH_UNKNOWN", `匹配主张 ${id} 不存在`);
    return match;
  }

  #requireProfileForKind(obj, profile) {
    const expected = objectWorkflowProfiles[obj.object_kind];
    if (profile !== expected) {
      throw new DomainRuleError("WORKFLOW_PROFILE_MISMATCH",
        `${obj.object_kind} 必须走 ${expected} 流程，不能使用 ${profile}`);
    }
  }
}
