| feat | prd-api | MAP 知识库传输协议 v1.1：新增 peer_sync_runs 同步运行台账（进行中/发出去/收进来/历史）+ GET /api/peer-sync/runs 端点 |
| feat | prd-api | 跨节点同步支持「强制对齐」：align=remote/local/both（远端为准/本地为准/同时对准），新增 SyncApplyMode.Mirror 镜像删除语义 |
| feat | prd-api | 同步契约补全：bundle 携带 contentHash/sortOrder/category + 主文档/置顶血缘 + 默认排序，修复置顶/分类/排序不同步 |
| feat | prd-api | 知识库支持服务端持久化默认排序 DefaultSortMode（换设备/重登录/刷新保持） |
| feat | prd-admin | 知识库新增「同步中心」弹窗：进行中/发出去/收进来/历史四视图 + 强制对齐三选项（远端为准/本地为准/同时对准，删除需二次确认），有任务时入口转圈 |
| feat | prd-admin | 知识库文档列表新增排序控件（默认/最新创建/最近更新），选中即服务端持久化，刷新/重登录不重置 |
| feat | prd-admin | 知识库「同步」按钮轮询运行台账，进行中时转圈+脉冲+「同步中…」文案，明确告知正在同步 |
| polish | prd-admin | 知识库顶栏收敛：发布/关系图谱/统计/订阅收进「更多」下拉，常驻仅留 同步/分享/上传文档，改善折叠屏布局 |
| docs | doc | 新增 spec.knowledge-base.transfer-protocol.md（MAP-KBTP v1 对外协议 + 第三方接入方法） |
