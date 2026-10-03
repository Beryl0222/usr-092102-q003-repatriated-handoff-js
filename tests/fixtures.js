/**
 * 端到端测试夹具：两批共 64 件套（华盛顿 38、纽约 26）。
 */

import { EventStore } from "../src/store.js";
import { HandoffService } from "../src/handoff-service.js";

export const WA = "batch-wa-2026-09";
export const NY = "batch-ny-2026-11";

export const PKG_W1 = "pkg-w-01";
export const PKG_W2 = "pkg-w-02";
export const PKG_N1 = "pkg-n-01";

export const OBJ_SET = "obj-w-set";
export const OBJ_HEAD = "obj-w-head";
export const OBJ_HAND = "obj-w-hand";
export const OBJ_FIG = "obj-w-fig";
export const OBJ_STATUE = "obj-w-statue";
export const OBJ_SKEL = "obj-n-skel";
export const OBJ_EGG_A = "obj-n-egg-a";
export const OBJ_EGG_B = "obj-n-egg-b";
export const OBJ_CLUTCH = "obj-n-clutch";

export const ACC_WA = "acc-wa-001";
export const MATCH_HEAD_HAND = "match-tls17-head-hand";

const T = "2026-09-";

export function makeService() {
  const store = new EventStore();
  const svc = new HandoffService(store);
  return { store, svc };
}

function manifestLines(prefix, city, count, overrides = {}) {
  const lines = [];
  for (let i = 1; i <= count; i += 1) {
    const lineNo = `${prefix}-${String(i).padStart(2, "0")}`;
    lines.push({
      line_no: lineNo,
      seizure_no: `${city}-SEIZ-2026-${String(i).padStart(3, "0")}`,
      declared_name: `${city === "W" ? "华盛顿" : "纽约"}批返还物 ${i}`,
      declared_quantity: 1,
      unit: "件",
      ...(overrides[lineNo] ?? {}),
    });
  }
  return lines;
}

/** 38 + 26 = 64 件套，编号体系各不相干。 */
export function washingtonManifest() {
  return manifestLines("w", "W", 38, {
    "w-01": { declared_name: "彩绘陶俑", declared_quantity: 1, unit: "件", package_hint: PKG_W1 },
    "w-02": { declared_name: "石质构件残件", package_hint: PKG_W1 },
    "w-03": {
      declared_name: "天龙山石窟石雕造像构件（一套）",
      declared_quantity: 1,
      unit: "套",
      package_hint: PKG_W1,
    },
    "w-04": { declared_name: "石雕佛坐像残件", package_hint: PKG_W2 },
  });
}

export function newYorkManifest() {
  return manifestLines("n", "N", 26, {
    "n-01": { declared_name: "恐龙骨架化石", package_hint: PKG_N1 },
    "n-02": { declared_name: "蛋化石（同一窝 6 枚）", declared_quantity: 6, unit: "件", package_hint: PKG_N1 },
  });
}

/** 建两批、收报关消息（含重复消息）。 */
export function setupBatches(svc) {
  svc.receiveBatch({
    batch_id: WA,
    batch_no: "WA-2026-038",
    source_city: "washington",
    handover_party: "美国国土安全调查处（HSI）",
    receiving_party: "国家文物返还协调组",
    handover_location: "中国驻美使馆",
    handover_at: `${T}11T10:00:00Z`,
    legal_basis: {
      basis_type: "court_order",
      reference: "US-DC-CR-2026-038",
      issued_at: `${T}05T09:00:00Z`,
    },
    manifest: washingtonManifest(),
    request_id: "cmd-batch-wa",
  });
  svc.receiveBatch({
    batch_id: NY,
    batch_no: "NY-2026-026",
    source_city: "new_york",
    handover_party: "曼哈顿地区检察官办公室",
    receiving_party: "国家文物返还协调组",
    handover_location: "纽约交还仪式",
    handover_at: `${T}12T15:00:00Z`,
    legal_basis: {
      basis_type: "bilateral_agreement",
      reference: "CN-US-CUL-1979-AMEND-2024",
      issued_at: "2024-01-01T00:00:00Z",
    },
    manifest: newYorkManifest(),
    request_id: "cmd-batch-ny",
  });
}

export function setupPackages(svc) {
  svc.registerPackage({
    package_id: PKG_W1,
    package_no: "CASE-WA-01",
    batch_id: WA,
    manifest_line_nos: ["w-01", "w-02", "w-03"],
    seals: [{ seal_no: "SEAL-W01-A", seal_type: "钢线封签" }],
    request_id: "cmd-pkg-w1",
  });
  svc.registerPackage({
    package_id: PKG_W2,
    package_no: "CASE-WA-02",
    batch_id: WA,
    manifest_line_nos: ["w-04"],
    seals: [{ seal_no: "SEAL-W02-A", seal_type: "钢线封签" }],
    request_id: "cmd-pkg-w2",
  });
  svc.registerPackage({
    package_id: PKG_N1,
    package_no: "CASE-NY-01",
    batch_id: NY,
    manifest_line_nos: ["n-01", "n-02"],
    seals: [{ seal_no: "SEAL-N01-A", seal_type: "卡扣封签" }],
    request_id: "cmd-pkg-n1",
  });
}

/** 完整主流程所需的全部时间戳集中处，避免测试体内散落魔法字符串。 */
export const TIMES = Object.freeze({
  sealInspect: `${T}13T08:00:00Z`,
  freezeReview: `${T}13T14:00:00Z`,
  unpack: `${T}14T09:00:00Z`,
  identity: `${T}16T09:00:00Z`,
  panelReview: `${T}19T09:00:00Z`,
  join: `${T}20T10:00:00Z`,
  scan: `${T}14T02:00:00Z`,
  scanUpload: `${T}15T20:00:00Z`,
  sign: `${T}22T10:00:00Z`,
  transfer: `${T}22T11:00:00Z`,
  accession: `${T}25T10:00:00Z`,
  publish: `${T}28T10:00:00Z`,
});
