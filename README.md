# 返还文物入藏交接

美方返还文物艺术品与古生物化石从华盛顿、纽约两批移交后的**入藏交接后端**：以领域事件为唯一事实来源，贯通美方移交批次、法律依据、封签箱件、对象候选身份、状态检测、运输环境、保管责任、会审拼合与最终入藏决定。

本仓库保存领域词汇、事件契约、聚合状态折叠、应用服务不变量与读模型，供各参与方统一对象身份与版本语义。

## 业务主线与不变量

- **多套编号体系并存**：执法扣押号（seizure_no）、交接清单行号（line_no）、箱号（package_no）、国内保管单元号（object_no）、入藏号（accession_no）各自独立，全部以映射字段并存，互不替代。
- **拆套 / 并套 / 改名只追加，不覆盖**：开箱发现“一套”实为多个保管单元时，父单元流保留 `OBJECT_SPLIT`，子单元以 `split_from_object_id` 回指并继承原清单行与扣押号；并套结果单元以 `merged_from_object_ids` 保留来源；名称修订成对保留 previous/revised。
- **封签异常冻结相关箱件，不整批静默放行**：`SEAL_INSPECTED` 发现 broken/missing/tampered/number_mismatch 即对**该箱**追加 `PACKAGE_FROZEN`，冻结箱不得开箱、不得移交；须经 `PACKAGE_RELEASED` 显式审查放行。同批其他箱件不受影响。
- **疑似同源只能主张**：`MATCH_CLAIMED` 不等于授权；`OBJECT_JOINED` 必须引用会审 `MATCH_REVIEWED` 且 decision=approved 的主张（天龙山第17窟佛首/佛手同此流程）。
- **分类流程**：造像/陶俑 → `cultural_relic`（风格比对、彩绘、陶胎、清洗脱盐加固修复）；恐龙骨架/蛋化石 → `paleontological`（形态鉴定、骨组织切片、阴极发光、同窝关系、围岩加固、裂隙修复、支撑装架）。流程与对象类别串用会被拒绝。
- **交接双签生效**：`ACCEPTANCE_DRAFTED` 后须 handover 与 receiving 两方分别 `ACCEPTANCE_SIGNED`，第二签落库的同一事务内产生 `ACCEPTANCE_EFFECTIVE`；占有变更 `CUSTODY_TRANSFERRED` 必须引用生效交接单且标的在其范围内。
- **不产生双重占有**：命令 `request_id` 幂等（离线扫码补传重放返回首事件）；报关消息号 `customs_message_id` 跨流去重（重复报关消息不产生第二次占有变更）；占有链校验当前占有人必须等于移交方，乱序/陈旧消息被拒。
- **入藏前置**：身份已确认且无未解决争议，方可 `ACCESSION_CONFIRMED`；已拆/并退出的单元由现行单元入藏。
- **公共发布只暴露已确认信息**：候选身份、争议、检测细节、扣押号、内部保管人不出现；未确认或未入藏对象不能发布。

## 目录

- `contracts/domain.schema.json`：JSON Schema 2020-12。事件信封（event_id/event_type/aggregate_type/aggregate_id/occurred_at/version/summary，可带 payload/request_id/causation_id/correlation_id）、6 类聚合、31 类事件及每类 payload 的条件约束。
- `src/domain.js`：事件/聚合目录、对象类别→流程档案映射、payload 必填字段的代码侧镜像。
- `src/validator.js`：事件信封与 payload 结构校验（形状校验；业务不变量在服务层）。
- `src/store.js`：事件存储。聚合流单调版本号与乐观并发；`request_id`/`customs_message_id` 幂等；`JsonlEventStore` 支持 JSONL 落盘与重放。
- `src/aggregates.js`：6 个聚合的纯函数 reducer（批次、封签箱件、保管单元、交接单、匹配主张、发布）。
- `src/handoff-service.js`：`HandoffService` 应用服务，承载全部业务不变量。
- `src/projections.js`：读模型——保管总览（当前由谁保管）、对象档案（检测/处置/争议/谱系）、跨国返还凭证与责任链回查、公共目录。
- `data/sample.json`：一条华盛顿批次接收的联调样例。
- `tests/`：契约一致性测试 + 两批共 64 件套（华盛顿 38、纽约 26）端到端场景，共 25 项。

## 聚合与事件

| 聚合 | 事件 |
| --- | --- |
| `return_batch` | BATCH_RECEIVED, MANIFEST_AMENDED, CUSTOMS_MESSAGE_RECEIVED |
| `sealed_package` | PACKAGE_REGISTERED, SEAL_INSPECTED, PACKAGE_FROZEN, PACKAGE_RELEASED, PACKAGE_UNPACKED, TRANSPORT_ENVIRONMENT_RECORDED, CUSTODY_TRANSFERRED |
| `collection_object` | OBJECT_REGISTERED, OBJECT_SPLIT, OBJECT_MERGED, IDENTITY_PROPOSED/ASSESSED/CONFIRMED/REVISED, MATCH 外的 OBJECT_JOINED, EXAMINATION_RECORDED, TREATMENT_RECORDED, DISPUTE_RAISED/RESOLVED, CUSTODY_SCAN_RECORDED, CUSTODY_TRANSFERRED, ACCESSION_PROPOSED/CONFIRMED |
| `custody_acceptance` | ACCEPTANCE_DRAFTED, ACCEPTANCE_SIGNED, ACCEPTANCE_EFFECTIVE |
| `identity_match` | MATCH_CLAIMED, MATCH_REVIEWED |
| `publication_release` | PUBLICATION_ISSUED |

`version` 为事件在所属聚合流上的版本号，从 1 单调递增；同一业务流程以 `correlation_id` 串联，事件间因果以 `causation_id` 标注。

## 使用示例

```js
import { EventStore, JsonlEventStore } from "./src/store.js";
import { HandoffService } from "./src/handoff-service.js";
import { buildReadModel, custodyOverview, traceToReturn } from "./src/projections.js";

const svc = new HandoffService(new JsonlEventStore("./data/eventlog.jsonl"));

svc.receiveBatch({ /* batch_id, batch_no, source_city, legal_basis, manifest, request_id */ });
svc.registerPackage({ /* package_id, batch_id, manifest_line_nos, seals */ });
const r = svc.inspectSeals("pkg-w-01", { inspector: "王某", results: [{ seal_no: "SEAL-W01-A", result: "tampered" }] });
r.frozen; // true：涉事箱件已冻结，同批他箱不受影响
```

每个命令返回 `{ event, events, replayed }`：`replayed=true` 表示命中幂等索引、未产生新事件（离线补传/重复报关的安全重放）。

## 本地检查

```bash
npm test
```
