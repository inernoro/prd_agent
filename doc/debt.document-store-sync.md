# debt.document-store-sync

| 字段 | 内容 |
|---|---|
| 模块 | 知识库跨环境 / 本地库↔库 同步（`DocumentStoreSyncController` + `SyncManagerPanel`） |
| 状态 | open（首版已交付，2026-06-04；以下为已知边界） |
| 关联 | `prd-api/.../Controllers/Api/DocumentStoreSyncController.cs`、`prd-admin/src/pages/document-store/SyncManagerPanel.tsx`、集合 `document_store_sync_links`、`DocumentStore.SyncToken`、设计文档 `design.document-store-sync.md` |
| 提出 | 用户需求：两个环境（或同环境两个库）之间互相同步知识库内容，令牌永久有效、支持单向/双向、手动触发 + 改动检测 |

---

## 已知边界（首版有意不做，后续可补）

1. **不传播删除**：同步只做「新增 / 更新」幂等 upsert，永不删除对端条目。一侧删了文档，另一侧仍保留（符合「不丢数据」，但两侧会渐渐不一致）。后续可加「软删除标记 + 同步删除」开关。
2. **只同步文本正文**：Markdown / 文本条目同步正文；二进制附件（PDF / 图片 / 音视频）只在 bundle 里标 skipped，不搬文件体（与现有 export/import 一致）。需要搬附件得走附件存储跨环境复制。
3. **双向冲突 = 本地优先（无字段级合并）**：`both` 方向用「上次同步的两侧签名快照」判定哪侧改了；两侧都改的真冲突，共享条目以本地为准覆盖对端（用户已确认「不自动合并冲突」）。无三方合并、无 diff 选择。
4. **变更检测为库级粒度**：`待同步 / 同步完成` 基于整库签名（lineage|UpdatedAt|title 哈希）与上次同步快照对比，不是条目级。极端情况下「A 改一条、B 改另一条」会被判为两侧都改走冲突分支，而非各自合并。
5. **令牌为 per-store 永久令牌**：存在 `DocumentStore.SyncToken`，无 TTL（用户明确要求不过期）。撤销靠「撤销令牌 / 撤销配对」手动操作。令牌泄露 = 对端可读写该库，需用户自行保管链接。
6. **跨环境需网络互通**：remote 配对要求两个环境能互相 HTTP 访问（受 `ISafeOutboundUrlValidator` SSRF 约束，私网地址会被拒）。本地库↔库配对无此要求，走 DB 直读写。
7. **同步为同步阻塞调用**：`run` 端点同步执行 build/apply（含跨环境 HTTP），大库可能较慢。未来可改 Run/Worker 异步 + 进度 SSE（呼应 CLAUDE.md §6）。
8. **页面教程未补步**：文档空间新增「跨环境同步」页签，`document-store-page-guide` 暂未加对应 Tour 步骤（`.claude/rules/onboarding-tips.md`）。后续可补一步指向 `library-tabs` 锚点讲解同步入口。

## 后续可做（按价值排序）

- [ ] 删除传播（软删除标记 + 双向删除开关）
- [ ] 附件二进制跨环境搬运
- [ ] 同步异步化（Run/Worker + 进度 SSE），大库不阻塞
- [ ] 条目级变更检测 + 两侧各改不同条目时自动各自合并（不再一律走冲突）
- [ ] 冲突可视化：列出冲突条目让用户逐条选「用本地 / 用对端」
- [ ] 页面教程补「跨环境同步」一步
