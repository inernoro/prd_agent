# debt.knowledge-base-versioning

> 类型：工程债务台账（debt.*）
> 模块：知识库（document-store）版本控制 / 图片插入 / 大小统计
> 状态：进行中（MVP 已落地，下列为已知边界与后续可补）
> 最近更新：2026-06-16

## 背景

2026-06-16 客户演示反馈三类问题，本轮处理：

1. 插入图片/保存正文时整页刷新回到顶部，多图时定位丢失；github 订阅文档插入图片后图片"刷新一下消失"。
2. 知识库修改后没有版本，希望存历史版本（参考"文学创作版本曾导致图片丢失"，要更谨慎、可用独立存储、加测试）。
3. 希望看到知识库大小 / 图片大小。

## 本轮已落地

- **图片插入不刷新（根因修复）**：`DocBrowser` 的内容重拉 effect 以 `loadedContentKey=${entryId}:${updatedAt}` 为缓存键。
  此前每次本地保存会把父级 `entries[].updatedAt` 改新 → `selectedEntryData` 变化 → effect 用新 key 触发
  `loadEntryContent`（`setPreview(null)` 闪烁 + 滚动回顶 + 重新拉取，github 文档还可能拉回旧正文把图片盖没）。
  修复：保存路径统一走 `commitLocalSave`，用服务端返回的 `updatedAt` 把 `loadedContentKey` 推进到同一版本，
  effect 命中缓存键短路，不再重拉。`onSaveContent` 返回类型加 `{ updatedAt? }`。
- **版本控制**：独立集合 `document_entry_versions` + `DocumentVersionService`。`UpdateEntryContent` 每次保存
  先留改动前基线、再留新内容（hash 去重，留存上限 100）。新增端点：
  `GET entries/{id}/versions`、`GET entries/{id}/versions/{vid}`、`POST entries/{id}/versions/{vid}/restore`。
  恢复 = 把目标版本文本写回当前正文（恢复前先把当前内容快照保留），全程**只写文本、不删除任何图片资产**。
- **大小统计**：`GET stores/{id}/size` 聚合正文/附件/图片/历史版本字节与数量；前端标题栏徽章展示。

## 吸取「文学创作版本删图片」教训（已规避）

文学创作旧坑根因：版本切换时按 `ArticleInsertionIndex != null` **批量删除 image_asset**，且只按 SHA256 引用计数，
导致回看旧版本图片没了（见 `doc/report.2026-W12.md` PR #303）。

知识库版本**从机制上不会重演**：KB 正文里的图片是 markdown 外链 URL（COS / 外部），不是受版本管理的 image_asset。
版本快照只存文本；恢复 = 写回文本，URL 始终有效，**不触发任何资产删除**。单测
`DocumentVersionLogicTests.ImageMarkdown_PreservedInSnapshot_TextOnly_NoAssetTouched` 固化该不变量。

## 已知边界 / 后续可补

- **github / RSS 每日同步覆盖**：后台定时同步仍可能用远端（无图）正文覆盖本地手动编辑（属罕见、非即时路径）。
  本轮不改同步语义；安全网是版本历史——被覆盖前的用户内容已快照，可在「历史版本」一键恢复。
  后续可补：同步覆盖手动编辑前先 `SnapshotAsync(source=sync)`（`ApplyContentToEntryAsync` 已具备能力，
  但 RSS/GitHub Worker 的写入路径尚未接入版本快照，是当前主要缺口），或给手动编辑过的订阅条目加"本地优先/冲突提示"。
- **大小统计口径**：`totalBytes` = 正文字节 + 附件字节（图片含在附件里）。markdown 里**外链图片 URL** 的真实
  字节无法不发请求得知，故未计入 `imageBytes`（`imageBytes` 仅统计 `Attachment.Type=Image` 的上传图片）。
  ParsedPrd 内容寻址去重时，多 entry 共享同一 Document 会在按 entry 累加正文字节时少量重复/偏差，当前按
  documentId 去重后求和，足够"判断大小量级"，非精确账单级。
- **版本留存上限 100**：超出裁剪最旧。极重度编辑的文档更早的历史会丢；如需永久留存可调大或冷归档。
- **版本 diff**：弹窗目前是「整篇正文预览 + 恢复」，未做逐行 diff 高亮，后续可补。
- **大小徽章刷新**：`refreshKey` 绑 `entries.length`，增删条目即时刷新；同一条文档内容增大不一定即时刷新，
  重进库或增删条目后准确。
- **索引**：`document_entry_versions` 未建索引（项目规则禁止应用自动建索引）。按 `EntryId`/`StoreId` 查询量大时，
  需 DBA 手动建 `{EntryId:1, VersionNumber:-1}` 与 `{StoreId:1}` 索引（见 `doc/guide.mongodb-indexes.md`）。
