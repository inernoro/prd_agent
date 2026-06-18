| fix | prd-admin | 知识库插入图片/保存正文不再整页刷新回顶：保存后用服务端 updatedAt 推进 loadedContentKey 短路内容重拉，插入即所见、图片不再消失 |
| feat | prd-api | 知识库版本控制：新增 document_entry_versions 集合 + DocumentVersionService，每次保存留存快照（去重+留存上限100），新增 列出/查看/恢复 版本三端点；版本只存文本不碰图片资产，恢复不删除任何资产 |
| feat | prd-admin | 知识库文档编辑器新增「历史版本」弹窗：版本列表 + 正文预览 + 一键恢复（恢复就地更新预览不刷新） |
| feat | prd-api | 知识库大小统计端点 GET stores/{id}/size：正文/附件/图片/历史版本字节与数量聚合 |
| feat | prd-admin | 知识库标题栏新增大小徽章（总体量 + 图片数，tooltip 给出明细） |
| test | prd-api | 新增 DocumentVersionLogicTests（版本去重/递增/UTF-8 字节/图片外链文本快照安全性）6 例 |
| feat | prd-api | 订阅源/GitHub 同步覆盖文档正文前先把旧正文快照成版本（source=sync，去重）：订阅文档被远端同步覆盖时，用户本地插入的配图等改动不丢，可从历史版本恢复 |
| fix | prd-admin | 历史版本弹窗面板改用不透明 --bg-elevated（原 --bg-card 暗色为 rgba(255,255,255,0.08) 半透明，背景正文透出造成重叠）+ 阴影/轻背板模糊 |
| feat | prd-admin | 编辑订阅/GitHub 每日同步文档时顶部显示警示横幅：手动修改（含插入配图）可能被下次同步覆盖，改动已留存历史版本可恢复 |
| feat | prd-admin | 知识库列表卡片副标题新增体量徽章（懒加载，滚动进视口才取 size），库外即可纵览每个知识库多大 |
| fix | prd-api | UpdateEntryContent 用单一时间戳写库与返回（原两次 DateTime.UtcNow 差几毫秒，前端缓存键与列表重载不一致会触发多余重拉回顶）—— Bugbot |
| fix | prd-admin | 历史版本列表 RelativeTime 加 refreshIntervalMs=0（列表场景禁用每实例刷新定时器，最多 100 行）—— Bugbot |
| fix | prd-api | GitHub 同步 SHA 缓存复用分支补齐覆盖前后版本快照（原仅 live-fetch 分支快照，缓存分支会静默覆盖本地改动无法恢复）—— Codex |
| fix | prd-api | AI 再加工写回（reprocess apply replace/append）接入版本快照，历史可撤销 AI 改写 —— Codex |
| fix | prd-admin | 历史版本「恢复」按钮不再因「是最新快照」禁用（存在不产生版本的写入路径时会挡住撤销）—— Codex |
| fix | prd-api | 版本恢复 ApplyContentToEntryAsync：DocumentId 指向的 ParsedPrd 行丢失时也 upsert 落库正文，避免恢复后重载空白 —— Bugbot High |
| fix | prd-api | DeleteStore 级联删除 document_entry_versions，避免删库后版本全文残留泄漏 —— Bugbot |
| fix | prd-api | GitHub 同步删除远端已不存在的子条目时级联删除其历史版本，与手动删除一致 —— Bugbot |
| fix | prd-api | AI 再加工写回对无 DocumentId 短文档也快照改动前基线（ContentIndex 即完整正文），保证可撤销 —— Bugbot |
| fix | prd-api | 版本恢复前的基线快照来源由 sync 改为 edit，避免历史里把手动编辑误显示为「外部同步」—— Bugbot |
| fix | prd-api | UpdateEntryContent：DocumentId 指向 ParsedPrd 丢失时也 upsert 落库正文（原只在 doc!=null 时保存→重载空白）；无 DocumentId 短文档用 ContentIndex 做基线快照 —— Bugbot High/Medium |
| fix | prd-admin | 历史版本列表加载加 fetchId 防过期响应守卫（切换文档后慢响应不覆盖当前列表）—— Bugbot |
