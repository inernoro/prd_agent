| fix | cds | 验收报告列表端点 projectId 规范化 slug→id（GET /api/reports + /report-folders），传 slug 不再命中空集 |
| perf | cds | peer-sync export 改异步读报告正文（libuv 线程池），避免大批量大报告导出阻塞单进程事件循环 |
| security | cds | peer-sync handshake/cancel 改为要求 HMAC 签名且只能撤销签名所属节点，防任意人凭 node id 撤销配对 |
| security | prd-api | CdsReportImportService 导入到显式 storeId 时校验归属，防把 CDS 报告写进别人私有知识库 |
| fix | prd-api | CdsReportImportService 增量游标只对默认全量镜像（无 projectId 过滤+同源）生效，过滤/换源导入改全量扫描且不回写共享水位，防项目 A 的游标永久跳过项目 B 旧报告 |
| fix | prd-api | CdsReportImportService 正文 contentHash 命中时仍同步标题/标签/元数据，防仅改 verdict/标题的报告在 MAP 镜像永久保留旧元数据 |
| fix | cds | 验收报告 PATCH 先校验 folderId（存在+同项目）再改内容，非法/跨项目文件夹不再先落盘内容后回 400 导致部分修改 |
