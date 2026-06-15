| feat | prd-api | MAP 知识库传输协议 v1.1：新增 peer_sync_runs 同步运行台账（进行中/发出去/收进来/历史）+ GET /api/peer-sync/runs 端点 |
| feat | prd-api | 跨节点同步支持「强制对齐」：align=remote/local/both（远端为准/本地为准/同时对准），新增 SyncApplyMode.Mirror 镜像删除语义 |
| feat | prd-api | 同步契约补全：bundle 携带 contentHash/sortOrder/category + 主文档/置顶血缘 + 默认排序，修复置顶/分类/排序不同步 |
| feat | prd-api | 知识库支持服务端持久化默认排序 DefaultSortMode（换设备/重登录/刷新保持） |
| docs | doc | 新增 spec.map-kb-transfer-protocol.md（MAP-KBTP v1 对外协议 + 第三方接入方法） |
