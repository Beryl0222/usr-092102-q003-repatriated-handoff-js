# 返还文物入藏交接

本仓库保存返还文物入藏交接的领域词汇、事件约定与基础校验代码，便于各参与方在后续开发中统一对象身份和版本语义。

## 目录

- `contracts/domain.schema.json`：领域事件信封及稳定枚举。
- `data/sample.json`：一条可用于联调的中文业务样例。
- `src/`：事件基础字段校验。
- `tests/`：领域资料的一致性检查。

当前核心对象为return_batch、sealed_package、collection_object、custody_acceptance，已登记事件为BATCH_RECEIVED、SEAL_INSPECTED、IDENTITY_PROPOSED、CUSTODY_TRANSFERRED、ACCESSION_CONFIRMED。这些资料只约束基础交换格式，具体业务服务需要在保持兼容的前提下继续建设。

## 本地检查

```bash
npm test
```
