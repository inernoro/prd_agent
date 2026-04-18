| fix | prd-api | 缺陷列表接口同时接受 filter/limit/offset 与 mine/page/pageSize，修复前端契约漂移导致 filter=assigned 被静默丢弃、pageSize 回落到默认 20 条使用户看不到自己的缺陷
| fix | prd-api | 缺陷列表 MaxPageSize 提升到 500，支持单次拉取覆盖真实账号全量数据；filter=submitted/assigned/all 直接映射到 ReporterId/AssigneeId 服务端筛选
| fix | prd-admin | 缺陷 store 拉取 limit 从 100 提升到 500 匹配后端新上限，并新增 defectsTotal 字段；列表顶部当 total > 已加载条数时显式提示"共 N 条，请用筛选缩小范围"避免用户误以为数据丢失
| fix | prd-desktop | list_defects Tauri 命令显式传 ?limit=500，修复用户看不到 20 条之外的缺陷
