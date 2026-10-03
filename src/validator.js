import {
  aggregateEventTypes,
  aggregateTypes,
  eventTypes,
  objectKinds,
  objectWorkflowProfiles,
  payloadRequired,
} from "./domain.js";

const required = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const enums = {
  source_city: ["washington", "new_york"],
  seal_result: ["intact", "broken", "missing", "tampered", "number_mismatch"],
  object_kind: objectKinds,
  workflow_profile: ["cultural_relic", "paleontological"],
  identity_finding: ["support", "doubt", "inconclusive"],
  match_relation: ["same_original_work", "same_skeleton", "same_clutch"],
  match_decision: ["approved", "rejected", "needs_more_evidence"],
  dispute_category: ["identity", "condition", "custody", "attribution"],
  condition_rating: ["good", "fair", "poor", "critical"],
  signing_party: ["handover", "receiving"],
  legal_basis_type: ["bilateral_agreement", "court_order", "customs_forfeiture", "voluntary_return"],
  env_metric: ["temp_c", "humidity_rh", "shock_g", "tilt_deg"],
  item_scope_type: ["sealed_package", "collection_object"],
};

/**
 * 事件信封与载荷的结构校验。业务不变量（双签、冻结、会审等）在应用服务层校验，
 * 这里只负责“形状是否合法”。
 * @param {Record<string, unknown>} record
 * @returns {string[]} 错误信息列表，空数组表示通过
 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (errors.length > 0) return errors;

  if (typeof record.event_id !== "string" || record.event_id.length === 0) {
    errors.push("event_id 必须是非空字符串");
  }
  if (!eventTypes.includes(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if (!aggregateTypes.includes(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是 ISO 8601 date-time");
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是正整数");
  }
  if (typeof record.summary !== "string" || record.summary.length === 0) {
    errors.push("summary 必须是非空字符串");
  }
  if (
    eventTypes.includes(record.event_type) &&
    aggregateTypes.includes(record.aggregate_type) &&
    !aggregateEventTypes[record.aggregate_type].includes(record.event_type)
  ) {
    errors.push(
      `事件 ${record.event_type} 不属于聚合流 ${record.aggregate_type}`,
    );
  }

  const need = payloadRequired[record.event_type];
  if (need) {
    if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
      errors.push(`${record.event_type} 必须携带对象型 payload`);
      return errors;
    }
    for (const field of need) {
      if (!(field in record.payload)) errors.push(`payload 缺少字段：${field}`);
    }
    errors.push(...validatePayload(record.event_type, record.payload));
  }

  return errors;
}

function checkEnum(errors, path, value, allowed) {
  if (value !== undefined && !allowed.includes(value)) {
    errors.push(`${path} 取值非法：${String(value)}（允许：${allowed.join("/")}）`);
  }
}

function checkDateTime(errors, path, value) {
  if (value !== undefined && (typeof value !== "string" || !ISO_DATE_TIME.test(value))) {
    errors.push(`${path} 必须是 ISO 8601 date-time`);
  }
}

function validatePayload(eventType, p) {
  const errors = [];
  const at = (field) => `payload.${field}`;

  switch (eventType) {
    case "BATCH_RECEIVED": {
      checkEnum(errors, at("source_city"), p.source_city, enums.source_city);
      if (typeof p.legal_basis !== "object" || p.legal_basis === null) {
        errors.push("payload.legal_basis 必须是对象");
      } else {
        checkEnum(errors, "payload.legal_basis.basis_type", p.legal_basis.basis_type, enums.legal_basis_type);
        if (!p.legal_basis.reference) errors.push("payload.legal_basis.reference 缺失");
        checkDateTime(errors, "payload.legal_basis.issued_at", p.legal_basis.issued_at);
      }
      if (!Array.isArray(p.manifest) || p.manifest.length === 0) {
        errors.push("payload.manifest 必须是非空数组");
      } else {
        p.manifest.forEach((line, i) => {
          for (const f of ["line_no", "seizure_no", "declared_name", "declared_quantity", "unit"]) {
            if (!(f in line)) errors.push(`payload.manifest[${i}] 缺少字段：${f}`);
          }
          if (line.unit && !["件", "套"].includes(line.unit)) {
            errors.push(`payload.manifest[${i}].unit 只能是 件/套`);
          }
        });
      }
      checkDateTime(errors, at("handover_at"), p.handover_at);
      break;
    }
    case "MANIFEST_AMENDED": {
      if (!Array.isArray(p.lines) || p.lines.length === 0) {
        errors.push("payload.lines 必须是非空数组");
      }
      break;
    }
    case "CUSTOMS_MESSAGE_RECEIVED":
      checkDateTime(errors, at("received_at"), p.received_at);
      break;
    case "PACKAGE_REGISTERED": {
      if (!Array.isArray(p.manifest_line_nos) || p.manifest_line_nos.length === 0) {
        errors.push("payload.manifest_line_nos 必须是非空数组");
      }
      if (!Array.isArray(p.seals) || p.seals.length === 0) {
        errors.push("payload.seals 必须是非空数组");
      } else {
        p.seals.forEach((s, i) => {
          if (!s.seal_no) errors.push(`payload.seals[${i}].seal_no 缺失`);
          if (!s.seal_type) errors.push(`payload.seals[${i}].seal_type 缺失`);
        });
      }
      break;
    }
    case "SEAL_INSPECTED": {
      if (!Array.isArray(p.results) || p.results.length === 0) {
        errors.push("payload.results 必须是非空数组");
      } else {
        p.results.forEach((r, i) => {
          if (!r.seal_no) errors.push(`payload.results[${i}].seal_no 缺失`);
          checkEnum(errors, `payload.results[${i}].result`, r.result, enums.seal_result);
        });
      }
      checkDateTime(errors, at("inspected_at"), p.inspected_at);
      break;
    }
    case "PACKAGE_FROZEN":
      checkDateTime(errors, at("frozen_at"), p.frozen_at);
      break;
    case "PACKAGE_RELEASED":
      checkDateTime(errors, at("released_at"), p.released_at);
      break;
    case "PACKAGE_UNPACKED":
      checkDateTime(errors, at("unpacked_at"), p.unpacked_at);
      break;
    case "TRANSPORT_ENVIRONMENT_RECORDED": {
      checkDateTime(errors, at("recorded_at"), p.recorded_at);
      if (!Array.isArray(p.readings) || p.readings.length === 0) {
        errors.push("payload.readings 必须是非空数组");
      } else {
        p.readings.forEach((r, i) => {
          checkEnum(errors, `payload.readings[${i}].metric`, r.metric, enums.env_metric);
          if (typeof r.value !== "number") errors.push(`payload.readings[${i}].value 必须是数值`);
          checkDateTime(errors, `payload.readings[${i}].observed_at`, r.observed_at);
        });
      }
      break;
    }
    case "OBJECT_REGISTERED":
      checkEnum(errors, at("object_kind"), p.object_kind, enums.object_kind);
      break;
    case "OBJECT_SPLIT":
      if (!Array.isArray(p.child_object_ids) || p.child_object_ids.length < 2) {
        errors.push("payload.child_object_ids 至少包含 2 个拆出保管单元");
      }
      checkDateTime(errors, at("split_at"), p.split_at);
      break;
    case "OBJECT_MERGED":
      if (!Array.isArray(p.source_object_ids) || p.source_object_ids.length < 2) {
        errors.push("payload.source_object_ids 至少包含 2 个来源对象");
      }
      checkDateTime(errors, at("merged_at"), p.merged_at);
      break;
    case "IDENTITY_PROPOSED":
      checkDateTime(errors, at("proposed_at"), p.proposed_at);
      if (p.confidence !== undefined) checkEnum(errors, at("confidence"), p.confidence, ["low", "medium", "high"]);
      break;
    case "IDENTITY_ASSESSED": {
      checkEnum(errors, at("workflow_profile"), p.workflow_profile, enums.workflow_profile);
      checkEnum(errors, at("finding"), p.finding, enums.identity_finding);
      checkDateTime(errors, at("assessed_at"), p.assessed_at);
      break;
    }
    case "IDENTITY_CONFIRMED":
      checkDateTime(errors, at("confirmed_at"), p.confirmed_at);
      break;
    case "IDENTITY_REVISED":
      checkDateTime(errors, at("revised_at"), p.revised_at);
      break;
    case "MATCH_CLAIMED":
      if (!Array.isArray(p.object_ids) || p.object_ids.length < 2) {
        errors.push("payload.object_ids 至少包含 2 个构件");
      }
      checkEnum(errors, at("relation"), p.relation, enums.match_relation);
      checkDateTime(errors, at("claimed_at"), p.claimed_at);
      break;
    case "MATCH_REVIEWED":
      checkEnum(errors, at("decision"), p.decision, enums.match_decision);
      checkDateTime(errors, at("reviewed_at"), p.reviewed_at);
      break;
    case "OBJECT_JOINED":
      if (!Array.isArray(p.object_ids) || p.object_ids.length < 2) {
        errors.push("payload.object_ids 至少包含 2 个拼合构件");
      }
      checkDateTime(errors, at("joined_at"), p.joined_at);
      break;
    case "EXAMINATION_RECORDED":
      checkEnum(errors, at("workflow_profile"), p.workflow_profile, enums.workflow_profile);
      checkEnum(errors, at("condition_rating"), p.condition_rating, enums.condition_rating);
      checkDateTime(errors, at("examined_at"), p.examined_at);
      break;
    case "TREATMENT_RECORDED":
      checkEnum(errors, at("workflow_profile"), p.workflow_profile, enums.workflow_profile);
      checkDateTime(errors, at("treated_at"), p.treated_at);
      break;
    case "DISPUTE_RAISED":
      checkEnum(errors, at("category"), p.category, enums.dispute_category);
      checkDateTime(errors, at("raised_at"), p.raised_at);
      break;
    case "DISPUTE_RESOLVED":
      checkDateTime(errors, at("resolved_at"), p.resolved_at);
      break;
    case "ACCEPTANCE_DRAFTED": {
      checkDateTime(errors, at("drafted_at"), p.drafted_at);
      if (!Array.isArray(p.item_refs) || p.item_refs.length === 0) {
        errors.push("payload.item_refs 必须是非空数组");
      } else {
        p.item_refs.forEach((ref, i) => {
          checkEnum(errors, `payload.item_refs[${i}].scope_type`, ref.scope_type, enums.item_scope_type);
          if (!ref.scope_id) errors.push(`payload.item_refs[${i}].scope_id 缺失`);
        });
      }
      break;
    }
    case "ACCEPTANCE_SIGNED":
      checkEnum(errors, at("party"), p.party, enums.signing_party);
      checkDateTime(errors, at("signed_at"), p.signed_at);
      break;
    case "ACCEPTANCE_EFFECTIVE":
      checkDateTime(errors, at("effective_at"), p.effective_at);
      break;
    case "CUSTODY_SCAN_RECORDED":
      checkDateTime(errors, at("scanned_at"), p.scanned_at);
      checkDateTime(errors, at("uploaded_at"), p.uploaded_at);
      if (p.uploaded_at && p.scanned_at && Date.parse(p.uploaded_at) < Date.parse(p.scanned_at)) {
        errors.push("payload.uploaded_at 不能早于 scanned_at（离线补传允许更晚）");
      }
      break;
    case "CUSTODY_TRANSFERRED":
      checkDateTime(errors, at("transferred_at"), p.transferred_at);
      if (!p.from_custodian || !p.to_custodian) {
        errors.push("payload.from_custodian / payload.to_custodian 均不能为空");
      }
      break;
    case "ACCESSION_PROPOSED":
      checkDateTime(errors, at("proposed_at"), p.proposed_at);
      break;
    case "ACCESSION_CONFIRMED":
      checkDateTime(errors, at("confirmed_at"), p.confirmed_at);
      break;
    case "PUBLICATION_ISSUED":
      checkDateTime(errors, at("issued_at"), p.issued_at);
      if (!Array.isArray(p.object_ids) || p.object_ids.length === 0) {
        errors.push("payload.object_ids 必须是非空数组");
      }
      break;
    default:
      break;
  }

  return errors;
}

/**
 * 对象类别与流程档案是否匹配（造像/陶俑 ↔ cultural_relic，骨架/蛋化石 ↔ paleontological）。
 */
export function workflowProfileMatchesKind(kind, profile) {
  return objectWorkflowProfiles[kind] === profile;
}
