/**
 * 领域事件信封字段约定与事件/聚合目录。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id
 * @property {string} event_type
 * @property {string} aggregate_type
 * @property {string} aggregate_id
 * @property {string} occurred_at
 * @property {number} version            该事件在所属聚合流上的版本号，从 1 递增
 * @property {string} summary
 * @property {Object} [payload]          业务载荷，形状由 event_type 决定
 * @property {string} [request_id]       命令幂等键（离线补传/重复报关去重）
 * @property {string} [causation_id]
 * @property {string} [correlation_id]
 */

export const domainEventFields = Object.freeze([
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "payload",
  "request_id",
  "causation_id",
  "correlation_id",
]);

/** 聚合类型 → 该流上允许出现的事件类型。 */
export const aggregateEventTypes = Object.freeze({
  return_batch: Object.freeze([
    "BATCH_RECEIVED",
    "MANIFEST_AMENDED",
    "CUSTOMS_MESSAGE_RECEIVED",
  ]),
  sealed_package: Object.freeze([
    "PACKAGE_REGISTERED",
    "SEAL_INSPECTED",
    "PACKAGE_FROZEN",
    "PACKAGE_RELEASED",
    "PACKAGE_UNPACKED",
    "TRANSPORT_ENVIRONMENT_RECORDED",
    "CUSTODY_TRANSFERRED",
  ]),
  collection_object: Object.freeze([
    "OBJECT_REGISTERED",
    "OBJECT_SPLIT",
    "OBJECT_MERGED",
    "IDENTITY_PROPOSED",
    "IDENTITY_ASSESSED",
    "IDENTITY_CONFIRMED",
    "IDENTITY_REVISED",
    "OBJECT_JOINED",
    "EXAMINATION_RECORDED",
    "TREATMENT_RECORDED",
    "DISPUTE_RAISED",
    "DISPUTE_RESOLVED",
    "CUSTODY_SCAN_RECORDED",
    "CUSTODY_TRANSFERRED",
    "ACCESSION_PROPOSED",
    "ACCESSION_CONFIRMED",
  ]),
  custody_acceptance: Object.freeze([
    "ACCEPTANCE_DRAFTED",
    "ACCEPTANCE_SIGNED",
    "ACCEPTANCE_EFFECTIVE",
  ]),
  identity_match: Object.freeze(["MATCH_CLAIMED", "MATCH_REVIEWED"]),
  publication_release: Object.freeze(["PUBLICATION_ISSUED"]),
});

export const eventTypes = Object.freeze(
  Object.values(aggregateEventTypes).flat(),
);

export const aggregateTypes = Object.freeze(Object.keys(aggregateEventTypes));

/**
 * 对象类别 → 鉴定/保护流程档案。
 * 造像、陶俑走文物流程；恐龙骨架、蛋化石走古生物化石流程。
 */
export const objectWorkflowProfiles = Object.freeze({
  statue: "cultural_relic",
  figurine: "cultural_relic",
  dinosaur_skeleton: "paleontological",
  egg_fossil: "paleontological",
});

export const objectKinds = Object.freeze(Object.keys(objectWorkflowProfiles));

/** 每个事件 payload 必填字段，契约的代码侧镜像（详见 contracts/domain.schema.json）。 */
export const payloadRequired = Object.freeze({
  BATCH_RECEIVED: ["batch_no", "source_city", "handover_party", "legal_basis", "handover_at", "manifest"],
  MANIFEST_AMENDED: ["reason", "lines"],
  CUSTOMS_MESSAGE_RECEIVED: ["customs_message_id", "received_at"],
  PACKAGE_REGISTERED: ["package_no", "batch_id", "manifest_line_nos", "seals"],
  SEAL_INSPECTED: ["inspected_at", "inspector", "results"],
  PACKAGE_FROZEN: ["reason", "frozen_by", "frozen_at"],
  PACKAGE_RELEASED: ["resolution_note", "reviewed_by", "released_at"],
  PACKAGE_UNPACKED: ["unpacked_at", "unpacked_by"],
  TRANSPORT_ENVIRONMENT_RECORDED: ["leg_from", "leg_to", "recorded_at", "readings"],
  OBJECT_REGISTERED: [
    "object_no", "batch_id", "package_id", "manifest_line_no", "object_kind", "provisional_name",
  ],
  OBJECT_SPLIT: ["reason", "child_object_ids"],
  OBJECT_MERGED: ["reason", "source_object_ids", "resulting_object_id"],
  IDENTITY_PROPOSED: ["candidate_id", "proposed_name", "proposed_by", "proposed_at"],
  IDENTITY_ASSESSED: ["candidate_id", "workflow_profile", "finding", "assessed_by", "assessed_at"],
  IDENTITY_CONFIRMED: ["candidate_id", "confirmed_name", "confirmed_by", "confirmed_at"],
  IDENTITY_REVISED: ["previous_name", "revised_name", "reason", "revised_by", "revised_at"],
  MATCH_CLAIMED: ["match_no", "object_ids", "relation", "hypothesis", "claimed_by", "claimed_at"],
  MATCH_REVIEWED: ["decision", "panel_ref", "reviewed_at"],
  OBJECT_JOINED: ["match_id", "object_ids", "joined_at", "joined_by"],
  EXAMINATION_RECORDED: [
    "examination_no", "workflow_profile", "examination_type", "examiner", "examined_at",
  ],
  TREATMENT_RECORDED: [
    "treatment_no", "workflow_profile", "treatment_type", "conservator", "treated_at",
  ],
  DISPUTE_RAISED: ["dispute_no", "category", "description", "raised_by", "raised_at"],
  DISPUTE_RESOLVED: ["dispute_no", "resolution", "resolved_by", "resolved_at"],
  ACCEPTANCE_DRAFTED: [
    "acceptance_no", "batch_id", "handover_party", "receiving_party", "item_refs", "drafted_at",
  ],
  ACCEPTANCE_SIGNED: ["party", "signatory", "signed_at"],
  ACCEPTANCE_EFFECTIVE: ["effective_at"],
  CUSTODY_SCAN_RECORDED: ["scan_no", "custodian", "scanned_at"],
  CUSTODY_TRANSFERRED: ["acceptance_id", "from_custodian", "to_custodian", "transferred_at"],
  ACCESSION_PROPOSED: ["proposed_institution", "proposed_by", "proposed_at"],
  ACCESSION_CONFIRMED: ["accession_no", "institution", "registered_name", "confirmed_at"],
  PUBLICATION_ISSUED: ["release_no", "issued_at", "object_ids"],
});
