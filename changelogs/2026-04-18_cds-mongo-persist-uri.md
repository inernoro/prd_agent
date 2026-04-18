| feat | cds | `switch-to-mongo` / `switch-to-json` 端点现在会把 CDS_STORAGE_MODE / CDS_MONGO_URI / CDS_MONGO_DB upsert/remove 到 `cds/.cds.env`，重启自动延续 Mongo 模式，不再退回 JSON |
| feat | cds | 新增 `cds/src/infra/env-file.ts` — 原子 upsert/removeKey 工具（chmod 600 + 转义 " \\ $） |
| test | cds | env-file 9 新测试全绿（创建/替换/保留其他/删除/转义/权限/错误 key） |
