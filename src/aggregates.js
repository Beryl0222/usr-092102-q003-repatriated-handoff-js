/**
 * 纯函数聚合 reducer：把一条聚合流上的事件折叠成当前状态。
 * 所有跨编号体系映射（扣押号、清单行、箱号、保管单元、入藏号）都保留在状态里，
 * 拆套/并套/改名只追加记录，从不覆盖历史。
 */

export function foldStream(events, init, reducer) {
  let state = init();
  for (const event of events) state = reducer(state, event);
  return state;
}

export function initReturnBatch() {
  return {
    exists: false,
    batch_no: null,
    source_city: null,
    handover_party: null,
    receiving_party: null,
    legal_basis: null,
    handover_location: null,
    handover_at: null,
    manifest: new Map(),
    manifest_history: new Map(),
    amendments: [],
    customs_messages: new Map(),
  };
}

export function reduceReturnBatch(state, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "BATCH_RECEIVED": {
      const next = { ...state, exists: true };
      next.batch_no = p.batch_no;
      next.source_city = p.source_city;
      next.handover_party = p.handover_party;
      next.receiving_party = p.receiving_party ?? null;
      next.legal_basis = p.legal_basis;
      next.handover_location = p.handover_location ?? null;
      next.handover_at = p.handover_at;
      for (const line of p.manifest) upsertManifestLine(next, line, e);
      return next;
    }
    case "MANIFEST_AMENDED": {
      const next = { ...state, amendments: [...state.amendments, { reason: p.reason, amended_by: p.amended_by, at: e.occurred_at }] };
      for (const line of p.lines) upsertManifestLine(next, line, e);
      return next;
    }
    case "CUSTOMS_MESSAGE_RECEIVED":
      return {
        ...state,
        customs_messages: new Map(state.customs_messages).set(p.customs_message_id, {
          received_at: p.received_at,
          manifest_line_nos: p.manifest_line_nos ?? [],
          event_id: e.event_id,
        }),
      };
    default:
      return state;
  }
}

function upsertManifestLine(state, line, event) {
  const history = state.manifest_history.get(line.line_no) ?? [];
  history.push({ line: { ...line }, event_id: event.event_id, at: event.occurred_at });
  state.manifest_history.set(line.line_no, history);
  state.manifest.set(line.line_no, { ...line });
}

export function initSealedPackage() {
  return {
    exists: false,
    package_no: null,
    batch_id: null,
    manifest_line_nos: [],
    seals: new Map(),
    status: null,
    registered_at: null,
    last_inspection: null,
    anomalies: [],
    freezes: [],
    released: [],
    unpacked_at: null,
    env_readings: [],
    custody: [],
  };
}

export function reduceSealedPackage(state, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "PACKAGE_REGISTERED": {
      const seals = new Map();
      for (const s of p.seals) seals.set(s.seal_no, { seal_type: s.seal_type, result: null, note: null });
      return {
        ...state,
        exists: true,
        package_no: p.package_no,
        batch_id: p.batch_id,
        manifest_line_nos: [...p.manifest_line_nos],
        seals,
        gross_weight_kg: p.gross_weight_kg ?? null,
        status: "registered",
        registered_at: e.occurred_at,
      };
    }
    case "SEAL_INSPECTED": {
      const seals = new Map(state.seals);
      const anomalies = [...state.anomalies];
      for (const r of p.results) {
        const prev = seals.get(r.seal_no) ?? { seal_type: null };
        seals.set(r.seal_no, { ...prev, result: r.result, note: r.note ?? prev.note, evidence_ref: r.evidence_ref ?? prev.evidence_ref });
        if (r.result !== "intact") {
          anomalies.push({ seal_no: r.seal_no, result: r.result, inspected_at: p.inspected_at, event_id: e.event_id });
        }
      }
      return {
        ...state,
        seals,
        anomalies,
        status: state.status === "frozen" ? "frozen" : "inspected",
        last_inspection: { at: p.inspected_at, inspector: p.inspector, event_id: e.event_id },
      };
    }
    case "PACKAGE_FROZEN":
      return {
        ...state,
        status: "frozen",
        freezes: [...state.freezes, {
          reason: p.reason, frozen_by: p.frozen_by, at: p.frozen_at,
          affected_seal_nos: p.affected_seal_nos ?? [], event_id: e.event_id,
        }],
      };
    case "PACKAGE_RELEASED":
      return {
        ...state,
        status: "released",
        released: [...state.released, { note: p.resolution_note, by: p.reviewed_by, at: p.released_at, event_id: e.event_id }],
      };
    case "PACKAGE_UNPACKED":
      return { ...state, status: "unpacked", unpacked_at: p.unpacked_at, unpacked_by: p.unpacked_by };
    case "TRANSPORT_ENVIRONMENT_RECORDED":
      return {
        ...state,
        env_readings: [
          ...state.env_readings,
          { leg: [p.leg_from, p.leg_to], recorded_at: p.recorded_at, offline_backfill: Boolean(p.offline_backfill), readings: p.readings },
        ],
      };
    case "CUSTODY_TRANSFERRED":
      return {
        ...state,
        custody: [...state.custody, { from: p.from_custodian, to: p.to_custodian, at: p.transferred_at, acceptance_id: p.acceptance_id }],
      };
    default:
      return state;
  }
}

export function initCollectionObject() {
  return {
    exists: false,
    object_no: null,
    object_kind: null,
    provisional_name: null,
    current_name: null,
    name_history: [],
    batch_id: null,
    package_id: null,
    manifest_line_no: null,
    seizure_no: null,
    lineage: { split_from: null, merged_from: [], splits: [], joins: [] },
    candidates: new Map(),
    confirmed_candidate_id: null,
    examinations: [],
    treatments: [],
    disputes: new Map(),
    scans: [],
    custody: [],
    current_custodian: null,
    accession_proposal: null,
    accession: null,
  };
}

export function reduceCollectionObject(state, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "OBJECT_REGISTERED":
      return {
        ...state,
        exists: true,
        object_no: p.object_no,
        object_kind: p.object_kind,
        provisional_name: p.provisional_name,
        current_name: p.provisional_name,
        batch_id: p.batch_id,
        package_id: p.package_id,
        manifest_line_no: p.manifest_line_no,
        seizure_no: p.seizure_no ?? null,
        lineage: {
          ...state.lineage,
          split_from: p.split_from_object_id ?? null,
          merged_from: p.merged_from_object_ids ?? [],
        },
      };
    case "OBJECT_SPLIT":
      return {
        ...state,
        lineage: { ...state.lineage, splits: [...state.lineage.splits, { child_object_ids: p.child_object_ids, reason: p.reason, at: p.split_at ?? e.occurred_at, event_id: e.event_id }] },
      };
    case "OBJECT_MERGED":
      // 事件挂在并套结果对象流上；来源对象在投影层由 lineage.merged_from 反查标记。
      return {
        ...state,
        lineage: { ...state.lineage, merged_by_event: { source_object_ids: p.source_object_ids, reason: p.reason, at: p.merged_at ?? e.occurred_at, event_id: e.event_id } },
      };
    case "IDENTITY_PROPOSED": {
      const candidates = new Map(state.candidates);
      candidates.set(p.candidate_id, {
        candidate_id: p.candidate_id,
        proposed_name: p.proposed_name,
        period: p.period ?? null,
        attribution: p.attribution ?? null,
        confidence: p.confidence ?? null,
        evidence_refs: p.evidence_refs ?? [],
        proposed_by: p.proposed_by,
        proposed_at: p.proposed_at,
        assessments: [],
        status: "proposed",
      });
      return { ...state, candidates };
    }
    case "IDENTITY_ASSESSED": {
      const candidates = new Map(state.candidates);
      const c = candidates.get(p.candidate_id);
      if (c) {
        candidates.set(p.candidate_id, {
          ...c,
          assessments: [...c.assessments, {
            workflow_profile: p.workflow_profile, finding: p.finding, opinion: p.opinion ?? null,
            report_ref: p.report_ref ?? null, by: p.assessed_by, at: p.assessed_at,
          }],
        });
      }
      return { ...state, candidates };
    }
    case "IDENTITY_CONFIRMED": {
      const candidates = new Map(state.candidates);
      const c = candidates.get(p.candidate_id);
      if (c) candidates.set(p.candidate_id, { ...c, status: "confirmed", confirmed_by: p.confirmed_by, confirmed_at: p.confirmed_at });
      return {
        ...state,
        candidates,
        confirmed_candidate_id: p.candidate_id,
        current_name: p.confirmed_name,
        confirmed_attribution: p.attribution ?? c?.attribution ?? null,
      };
    }
    case "IDENTITY_REVISED": {
      const revision = { previous_name: p.previous_name, revised_name: p.revised_name, reason: p.reason, by: p.revised_by, at: p.revised_at, event_id: e.event_id };
      return { ...state, name_history: [...state.name_history, revision], current_name: p.revised_name };
    }
    case "OBJECT_JOINED":
      return {
        ...state,
        lineage: {
          ...state.lineage,
          joins: [...state.lineage.joins, {
            match_id: p.match_id, object_ids: p.object_ids,
            resulting_object_id: p.resulting_object_id ?? null,
            at: p.joined_at, by: p.joined_by, event_id: e.event_id,
          }],
        },
      };
    case "EXAMINATION_RECORDED":
      return { ...state, examinations: [...state.examinations, { ...p }] };
    case "TREATMENT_RECORDED":
      return { ...state, treatments: [...state.treatments, { ...p }] };
    case "DISPUTE_RAISED": {
      const disputes = new Map(state.disputes);
      disputes.set(p.dispute_no, {
        dispute_no: p.dispute_no, category: p.category, description: p.description,
        raised_by: p.raised_by, raised_at: p.raised_at, resolution: null, status: "open",
      });
      return { ...state, disputes };
    }
    case "DISPUTE_RESOLVED": {
      const disputes = new Map(state.disputes);
      const d = disputes.get(p.dispute_no);
      if (d) {
        disputes.set(p.dispute_no, { ...d, resolution: p.resolution, resolved_by: p.resolved_by, resolved_at: p.resolved_at, status: "resolved" });
      }
      return { ...state, disputes };
    }
    case "CUSTODY_SCAN_RECORDED":
      return {
        ...state,
        scans: [...state.scans, {
          scan_no: p.scan_no, custodian: p.custodian, scanned_at: p.scanned_at,
          uploaded_at: p.uploaded_at ?? p.scanned_at, offline: Boolean(p.offline),
          location: p.location ?? null, note: p.note ?? null,
        }],
      };
    case "CUSTODY_TRANSFERRED": {
      const transfer = { from: p.from_custodian, to: p.to_custodian, at: p.transferred_at, acceptance_id: p.acceptance_id };
      return { ...state, custody: [...state.custody, transfer], current_custodian: p.to_custodian };
    }
    case "ACCESSION_PROPOSED":
      return {
        ...state,
        accession_proposal: { institution: p.proposed_institution, by: p.proposed_by, at: p.proposed_at },
      };
    case "ACCESSION_CONFIRMED":
      return {
        ...state,
        accession: {
          accession_no: p.accession_no, institution: p.institution,
          registered_name: p.registered_name, at: p.confirmed_at,
        },
        current_name: p.registered_name,
      };
    default:
      return state;
  }
}

export function initCustodyAcceptance() {
  return {
    exists: false,
    acceptance_no: null,
    batch_id: null,
    handover_party: null,
    receiving_party: null,
    item_refs: [],
    signatures: {},
    effective: false,
    effective_at: null,
    drafted_at: null,
  };
}

export function reduceCustodyAcceptance(state, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "ACCEPTANCE_DRAFTED":
      return {
        ...state,
        exists: true,
        acceptance_no: p.acceptance_no,
        batch_id: p.batch_id,
        handover_party: p.handover_party,
        receiving_party: p.receiving_party,
        item_refs: [...p.item_refs],
        drafted_at: p.drafted_at,
      };
    case "ACCEPTANCE_SIGNED": {
      const signatures = {
        ...state.signatures,
        [p.party]: { signatory: p.signatory, signature_ref: p.signature_ref ?? null, at: p.signed_at },
      };
      return { ...state, signatures };
    }
    case "ACCEPTANCE_EFFECTIVE":
      return { ...state, effective: true, effective_at: p.effective_at };
    default:
      return state;
  }
}

export function initIdentityMatch() {
  return { exists: false, match_no: null, object_ids: [], relation: null, hypothesis: null, claim: null, review: null };
}

export function reduceIdentityMatch(state, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "MATCH_CLAIMED":
      return {
        ...state,
        exists: true,
        match_no: p.match_no,
        object_ids: [...p.object_ids],
        relation: p.relation,
        hypothesis: p.hypothesis,
        evidence_refs: p.evidence_refs ?? [],
        claim: { by: p.claimed_by, at: p.claimed_at },
        status: "claimed",
      };
    case "MATCH_REVIEWED":
      return {
        ...state,
        review: {
          decision: p.decision, panel_ref: p.panel_ref, panel_members: p.panel_members ?? [],
          opinion: p.opinion ?? null, at: p.reviewed_at,
        },
        status: p.decision === "approved" ? "approved" : p.decision === "rejected" ? "rejected" : "needs_more_evidence",
      };
    default:
      return state;
  }
}

export function initPublication() {
  return { exists: false, releases: [] };
}

export function reducePublication(state, e) {
  const p = e.payload ?? {};
  if (e.event_type === "PUBLICATION_ISSUED") {
    return {
      exists: true,
      releases: [...state.releases, { release_no: p.release_no, title: p.title ?? null, issued_at: p.issued_at, object_ids: [...p.object_ids] }],
    };
  }
  return state;
}

export const reducers = {
  return_batch: { init: initReturnBatch, reduce: reduceReturnBatch },
  sealed_package: { init: initSealedPackage, reduce: reduceSealedPackage },
  collection_object: { init: initCollectionObject, reduce: reduceCollectionObject },
  custody_acceptance: { init: initCustodyAcceptance, reduce: reduceCustodyAcceptance },
  identity_match: { init: initIdentityMatch, reduce: reduceIdentityMatch },
  publication_release: { init: initPublication, reduce: reducePublication },
};

/** 折叠事件存储中的某条聚合流。 */
export function loadAggregate(store, aggregateType, aggregateId) {
  const { init, reduce } = reducers[aggregateType];
  return foldStream(store.stream(aggregateType, aggregateId), init, reduce);
}

/** 折叠事件存储中的全部聚合，返回类型 → Map(id → state)。 */
export function loadAll(store) {
  const result = {};
  for (const [type, { init, reduce }] of Object.entries(reducers)) {
    const map = new Map();
    for (const e of store.allEvents()) {
      if (e.aggregate_type !== type) continue;
      const prev = map.get(e.aggregate_id) ?? init();
      map.set(e.aggregate_id, reduce(prev, e));
    }
    result[type] = map;
  }
  return result;
}
