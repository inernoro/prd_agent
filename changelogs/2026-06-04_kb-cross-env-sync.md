| feat | prd-api | 知识库跨环境/本地库↔库同步引擎：新增 DocumentStoreSyncController（令牌链接配对 + 双向手动推送 + 血缘 ID 幂等 upsert + 签名快照变更检测），令牌永久有效，复用 export/import 数据形态 |
| feat | prd-api | DocumentStore 新增 SyncToken 字段 + 新增 document_store_sync_links 集合（DocumentStoreSyncLink 配对记录） |
| feat | prd-admin | 知识库新增「跨环境同步」页签：启动链接（粘贴对方链接，跨环境/本地两库二选一）+ 生成连接链接 + 配对列表（单向/双向切换 + 立即同步 + 撤销）；知识库详情右上角显示同步状态徽章（已同步/待同步/出错） |
