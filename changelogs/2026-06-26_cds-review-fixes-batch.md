| fix | cds | 验收报告列表端点 projectId 规范化 slug→id（GET /api/reports + /report-folders），传 slug 不再命中空集 |
| perf | cds | peer-sync export 改异步读报告正文（libuv 线程池），避免大批量大报告导出阻塞单进程事件循环 |
| security | cds | peer-sync handshake/cancel 改为要求 HMAC 签名且只能撤销签名所属节点，防任意人凭 node id 撤销配对 |
| security | prd-api | CdsReportImportService 导入到显式 storeId 时校验归属，防把 CDS 报告写进别人私有知识库 |
