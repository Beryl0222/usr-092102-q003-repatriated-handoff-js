/**
 * 读模型：从事件存储折叠结果派生管理视图。
 * - custodyOverview：每个对象当前由谁保管
 * - objectDossier：对象经历过的检测、争议、名称链、候选身份
 * - traceToReturn：从一件入藏品回查跨国返还凭证与完整责任链
 * - publicCatalog：公共发布视图，只暴露已确认信息
 */

import { loadAll } from "./aggregates.js";
import { objectWorkflowProfiles } from "./domain.js";

export function buildReadModel(store) {
  const aggregates = loadAll(store);

  // 保管单元谱系：split_from / merged_from 构成的有向图（子 → 父）
  const parentsOf = new Map();
  const childrenOf = new Map();
  const link = (map, k, v) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(v);
  };
  for (const [id, obj] of aggregates.collection_object) {
    if (obj.lineage.split_from) {
      link(parentsOf, id, obj.lineage.split_from);
      link(childrenOf, obj.lineage.split_from, id);
    }
    for (const src of obj.lineage.merged_from) {
      link(parentsOf, id, src);
      link(childrenOf, src, id);
    }
  }

  const closure = (start, map) => {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const nxt of map.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return seen;
  };

  return {
    aggregates,
    parentsOf,
    childrenOf,
    ancestorsOf: (id) => closure(id, parentsOf),
    descendantsOf: (id) => closure(id, childrenOf),
  };
}

const KIND_LABEL = {
  statue: "造像",
  figurine: "陶俑",
  dinosaur_skeleton: "恐龙骨架",
  egg_fossil: "蛋化石",
};

/** 对象是否为现行保管单元（未拆套、未被并套）。 */
export function isLiveObject(model, objectId) {
  const obj = model.aggregates.collection_object.get(objectId);
  if (!obj) return false;
  if (obj.lineage.splits.length > 0) return false;
  for (const [, o] of model.aggregates.collection_object) {
    if (o.lineage.merged_from.includes(objectId)) return false;
  }
  return true;
}

/**
 * 管理视图：每个现行保管单元当前由谁保管、在哪个箱、属于哪个批次。
 */
export function custodyOverview(model) {
  const rows = [];
  for (const [id, obj] of model.aggregates.collection_object) {
    const pkg = model.aggregates.sealed_package.get(obj.package_id);
    rows.push({
      object_id: id,
      object_no: obj.object_no,
      current_name: obj.current_name,
      object_kind: obj.object_kind,
      kind_label: KIND_LABEL[obj.object_kind] ?? obj.object_kind,
      live: isLiveObject(model, id),
      current_custodian: obj.current_custodian ?? null,
      custody_chain: obj.custody.map((c) => ({ ...c })),
      last_scan: obj.scans.at(-1)
        ? {
            custodian: obj.scans.at(-1).custodian,
            scanned_at: obj.scans.at(-1).scanned_at,
            uploaded_at: obj.scans.at(-1).uploaded_at,
            offline: obj.scans.at(-1).offline,
            location: obj.scans.at(-1).location,
          }
        : null,
      package_id: obj.package_id,
      package_no: pkg?.package_no ?? null,
      package_status: pkg?.status ?? null,
      batch_id: obj.batch_id,
      accession: obj.accession ? { ...obj.accession } : null,
      open_dispute_count: [...obj.disputes.values()].filter((d) => d.status === "open").length,
    });
  }
  rows.sort((a, b) => a.object_no.localeCompare(b.object_no));
  return rows;
}

/**
 * 对象档案：管理人员核对某件对象经历了哪些检测与争议。
 */
export function objectDossier(model, objectId) {
  const obj = model.aggregates.collection_object.get(objectId);
  if (!obj) return null;
  const pkg = model.aggregates.sealed_package.get(obj.package_id);
  const batch = model.aggregates.return_batch.get(obj.batch_id);
  return {
    object_id: objectId,
    object_no: obj.object_no,
    object_kind: obj.object_kind,
    kind_label: KIND_LABEL[obj.object_kind] ?? obj.object_kind,
    workflow_profile: objectWorkflowProfiles[obj.object_kind],
    current_name: obj.current_name,
    provisional_name: obj.provisional_name,
    name_history: obj.name_history.map((n) => ({ ...n })),
    cross_reference: {
      batch_id: obj.batch_id,
      batch_no: batch?.batch_no ?? null,
      manifest_line_no: obj.manifest_line_no,
      seizure_no: obj.seizure_no,
      package_id: obj.package_id,
      package_no: pkg?.package_no ?? null,
    },
    lineage: {
      split_from: obj.lineage.split_from,
      merged_from: [...obj.lineage.merged_from],
      splits: obj.lineage.splits.map((s) => ({ ...s })),
      joins: obj.lineage.joins.map((j) => ({ ...j })),
      ancestors: [...model.ancestorsOf(objectId)],
      descendants: [...model.descendantsOf(objectId)],
    },
    identity: {
      confirmed_candidate_id: obj.confirmed_candidate_id,
      confirmed_attribution: obj.confirmed_attribution ?? null,
      candidates: [...obj.candidates.values()].map((c) => ({
        candidate_id: c.candidate_id,
        proposed_name: c.proposed_name,
        period: c.period,
        attribution: c.attribution,
        confidence: c.confidence,
        status: c.status,
        proposed_by: c.proposed_by,
        proposed_at: c.proposed_at,
        assessment_count: c.assessments.length,
        latest_finding: c.assessments.at(-1)?.finding ?? null,
      })),
    },
    examinations: obj.examinations.map((x) => ({ ...x })),
    treatments: obj.treatments.map((t) => ({ ...t })),
    disputes: [...obj.disputes.values()].map((d) => ({ ...d })),
    custody: {
      current: obj.current_custodian,
      chain: obj.custody.map((c) => ({ ...c })),
      scans: obj.scans.map((s) => ({ ...s })),
    },
    accession_proposal: obj.accession_proposal ? { ...obj.accession_proposal } : null,
    accession: obj.accession ? { ...obj.accession } : null,
  };
}

/**
 * 从一件（已入藏）对象回查跨国返还凭证与完整责任链：
 * 法律依据 → 美方移交批次/报关 → 封签箱件 → 交接签署 → 占有链 → 入藏决定。
 * 谱系对象（拆/并套）通过祖先与后代扩展交接范围匹配。
 */
export function traceToReturn(model, objectId) {
  const root = model.aggregates.collection_object.get(objectId);
  if (!root) return null;

  const relatedObjectIds = new Set([objectId, ...model.ancestorsOf(objectId), ...model.descendantsOf(objectId)]);

  // 会审匹配的同案构件（如佛首↔佛手）一并纳入责任链回查范围
  for (const [, match] of model.aggregates.identity_match) {
    if (match.object_ids.some((id) => relatedObjectIds.has(id))) {
      for (const id of match.object_ids) relatedObjectIds.add(id);
    }
  }

  // 谱系上的批次与箱件（拆/并套可能跨箱）
  const batchIds = new Set();
  const packageIds = new Set();
  for (const id of relatedObjectIds) {
    const o = model.aggregates.collection_object.get(id);
    if (o) {
      batchIds.add(o.batch_id);
      packageIds.add(o.package_id);
    }
  }

  const batches = [...batchIds].map((bid) => {
    const b = model.aggregates.return_batch.get(bid);
    return {
      batch_id: bid,
      batch_no: b?.batch_no ?? null,
      source_city: b?.source_city ?? null,
      handover_party: b?.handover_party ?? null,
      receiving_party: b?.receiving_party ?? null,
      handover_at: b?.handover_at ?? null,
      legal_basis: b?.legal_basis ?? null,
      customs_messages: [...(b?.customs_messages ?? new Map()).values()].map((m) => ({ ...m })),
      manifest_lines: [...(b?.manifest ?? new Map()).entries()]
        .filter(([lineNo]) => lineageTouchesManifestLine(model, relatedObjectIds, lineNo))
        .map(([line_no, line]) => ({ line_no, ...line })),
    };
  });

  const packages = [...packageIds].map((pid) => {
    const p = model.aggregates.sealed_package.get(pid);
    return {
      package_id: pid,
      package_no: p?.package_no ?? null,
      status: p?.status ?? null,
      seals: [...(p?.seals ?? new Map()).entries()].map(([seal_no, s]) => ({ seal_no, ...s })),
      anomalies: p?.anomalies ?? [],
      freezes: p?.freezes ?? [],
      releases: p?.released ?? [],
      unpacked_at: p?.unpacked_at ?? null,
      environment_legs: p?.env_readings ?? [],
      custody_chain: p?.custody ?? [],
    };
  });

  // 交接单：范围中出现本谱系任一对象或其所在箱件即纳入
  const acceptances = [];
  for (const [aid, acc] of model.aggregates.custody_acceptance) {
    const touches = acc.item_refs.some(
      (r) =>
        (r.scope_type === "collection_object" && relatedObjectIds.has(r.scope_id)) ||
        (r.scope_type === "sealed_package" && packageIds.has(r.scope_id)),
    );
    if (!touches) continue;
    acceptances.push({
      acceptance_id: aid,
      acceptance_no: acc.acceptance_no,
      handover_party: acc.handover_party,
      receiving_party: acc.receiving_party,
      item_refs: acc.item_refs.map((r) => ({ ...r })),
      signatures: Object.fromEntries(
        Object.entries(acc.signatures).map(([k, v]) => [k, { ...v }]),
      ),
      effective: acc.effective,
      effective_at: acc.effective_at,
    });
  }

  // 占有链合并：对象自身 + 谱系 + 箱件
  const custodyChain = [];
  for (const id of relatedObjectIds) {
    const o = model.aggregates.collection_object.get(id);
    for (const c of o?.custody ?? []) custodyChain.push({ scope: "collection_object", scope_id: id, ...c });
  }
  for (const pid of packageIds) {
    const p = model.aggregates.sealed_package.get(pid);
    for (const c of p?.custody ?? []) custodyChain.push({ scope: "sealed_package", scope_id: pid, ...c });
  }
  custodyChain.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // 会审与拼合记录（如存在）
  const joinRecords = [];
  for (const id of relatedObjectIds) {
    const o = model.aggregates.collection_object.get(id);
    for (const j of o?.lineage.joins ?? []) {
      const match = model.aggregates.identity_match.get(j.match_id);
      joinRecords.push({ object_id: id, ...j, match: match ? summarizeMatch(match) : null });
    }
  }

  return {
    object_id: objectId,
    object_no: root.object_no,
    current_name: root.current_name,
    accession: root.accession ? { ...root.accession } : null,
    batches,
    packages,
    acceptances,
    custody_chain: custodyChain,
    joins: joinRecords,
    lineage_object_ids: [...relatedObjectIds],
  };
}

function lineageTouchesManifestLine(model, objectIds, lineNo) {
  for (const id of objectIds) {
    const o = model.aggregates.collection_object.get(id);
    if (o?.manifest_line_no === lineNo) return true;
  }
  return false;
}

function summarizeMatch(m) {
  return {
    match_no: m.match_no,
    relation: m.relation,
    hypothesis: m.hypothesis,
    status: m.status,
    review: m.review ? { decision: m.review.decision, panel_ref: m.review.panel_ref, at: m.review.at } : null,
  };
}

/**
 * 公共发布目录：只暴露已确认且已入藏的信息。
 * 不暴露：候选身份/疑似归属、争议、检测与处置细节、扣押号、保管人内部信息、未入藏对象。
 */
export function publicCatalog(model) {
  const items = [];
  for (const [id, obj] of model.aggregates.collection_object) {
    if (!obj.confirmed_candidate_id || !obj.accession) continue;
    if (!isLiveObject(model, id)) continue;
    const batch = model.aggregates.return_batch.get(obj.batch_id);
    items.push({
      public_id: obj.accession.accession_no,
      name: obj.accession.registered_name,
      object_kind: obj.object_kind,
      kind_label: KIND_LABEL[obj.object_kind] ?? obj.object_kind,
      attribution: obj.confirmed_attribution
        ? {
            // 只发布已确认归属；未确认字段不出现
            ...(obj.confirmed_attribution.site ? { site: obj.confirmed_attribution.site } : {}),
            ...(obj.confirmed_attribution.cave ? { cave: obj.confirmed_attribution.cave } : {}),
            ...(obj.confirmed_attribution.component ? { component: obj.confirmed_attribution.component } : {}),
          }
        : null,
      holding_institution: obj.accession.institution,
      accessioned_at: obj.accession.at,
      return: batch
        ? { source_city: batch.source_city, handover_party: batch.handover_party, handover_at: batch.handover_at }
        : null,
    });
  }
  items.sort((a, b) => a.public_id.localeCompare(b.public_id));
  return items;
}
