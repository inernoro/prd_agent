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
| fix | prd-api | 版本恢复 ApplyContentToEntryAsync 对无 DocumentId 短文档也用 ContentIndex 做基线快照，与 UpdateEntryContent 一致 —— Bugbot |
| fix | prd-admin | 历史版本切换时先清空 detail + 加载中禁用恢复 + handleRestore 校验 detail.id==selectedId，避免拿上一条快照误恢复 —— Bugbot |
| fix | prd-api | 编辑/恢复/AI再加工写入正文改为内容寻址+共享保护：旧 ParsedPrd 被别的 entry 共享时不就地覆盖（避免改到他人正文），独占时复用旧 id 不产生孤儿 —— Codex P1 |
| fix | prd-api | 历史版本 列出/查看 端点改为要求写权限，避免公开库只读访客取回作者已删除的旧版本正文 —— Codex P1 |
| fix | prd-api | 知识库大小统计按 MIME 判定图片（上传附件 Type 统一为 Document），修复上传图片统计为 0 图 —— Codex P2 |
| fix | prd-admin | DocBrowser loadEntryContent 加 fetchId 防过期响应 + commitLocalSave 作废在途加载，保护「保存不刷新」不被慢请求回滚 —— Bugbot |
| fix | prd-admin | 历史版本弹窗切换 entry 时先清空 versions/selectedId，避免残留上一篇版本列表 —— Bugbot |
| fix | prd-api | 版本基线快照不再回退截断的 ContentIndex（2000字上限）：DocumentId 在但 ParsedPrd 丢失时宁可不快照，避免长文档留下截断的改动前版本 —— Bugbot |
| fix | prd-admin | commitLocalSave 记录刚保存内容；onSaveContent 返回 void 时 loadEntryContent 凭快照直接采纳新 key 跳过重拉，保存不刷新对所有调用方生效 —— Bugbot |
| fix | prd-admin | commitLocalSave 作废在途加载时同步清 contentLoading，避免内容区卡在 loading 占位 —— Codex P2 |
| fix | prd-admin | 历史版本首条徽章「当前」改为「最新」，个别写入路径（替换文件）不产生版本时不误导为当前在线正文 —— Codex P2 |
| fix | prd-admin | 保存豁免重拉改为一次性（用完即清 lastSavedContentRef），只豁免保存紧接的那次重拉；之后订阅同步 bump updatedAt 仍正常重拉，不会一直拿本地旧文盖掉服务端已同步的新内容 —— Bugbot |
| fix | prd-admin | 知识库大小徽章 refreshKey 改为含各 entry updatedAt（原仅条目数）：编辑/恢复/替换改变体积但条目数不变时也刷新 —— Codex P2 |
| fix | prd-admin | 版本恢复回调硬化：preview 为 null 时也写出恢复正文（防空白）+ 校验恢复的是当前选中条目（防画错文档）+ 作废在途加载（防慢响应覆盖）—— Bugbot High/Medium |
| fix | prd-admin | commitLocalSave 同步内部 searchResults 的 updatedAt，避免搜索命中条目保存后 contentKey 不一致引发整页重拉闪烁 —— Bugbot |
| fix | prd-admin | loadEntryContent 改用 previewRef 读当前 preview（移除 preview 依赖），避免切文档时 setPreview(null) 改变回调标识触发二次加载、大文档下载两次 —— Codex P2 |
| fix | prd-api | 版本列表次级按 CreatedAt 倒序，并发重复 VersionNumber 时顺序确定（最新徽章不随机）；唯一性兜底索引建议入 guide.mongodb-indexes —— Codex/Bugbot P2 |
