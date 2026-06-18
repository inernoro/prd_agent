| fix | prd-admin | 知识库插入图片/保存正文不再整页刷新回顶：保存后用服务端 updatedAt 推进 loadedContentKey 短路内容重拉，插入即所见、图片不再消失 |
| feat | prd-api | 知识库版本控制：新增 document_entry_versions 集合 + DocumentVersionService，每次保存留存快照（去重+留存上限100），新增 列出/查看/恢复 版本三端点；版本只存文本不碰图片资产，恢复不删除任何资产 |
| feat | prd-admin | 知识库文档编辑器新增「历史版本」弹窗：版本列表 + 正文预览 + 一键恢复（恢复就地更新预览不刷新） |
| feat | prd-api | 知识库大小统计端点 GET stores/{id}/size：正文/附件/图片/历史版本字节与数量聚合 |
| feat | prd-admin | 知识库标题栏新增大小徽章（总体量 + 图片数，tooltip 给出明细） |
| test | prd-api | 新增 DocumentVersionLogicTests（版本去重/递增/UTF-8 字节/图片外链文本快照安全性）6 例 |
| feat | prd-api | 订阅源/GitHub 同步覆盖文档正文前先把旧正文快照成版本（source=sync，去重）：订阅文档被远端同步覆盖时，用户本地插入的配图等改动不丢，可从历史版本恢复 |
| fix | prd-admin | 历史版本弹窗面板改用不透明 --bg-elevated（原 --bg-card 暗色为 rgba(255,255,255,0.08) 半透明，背景正文透出造成重叠）+ 阴影/轻背板模糊 |
