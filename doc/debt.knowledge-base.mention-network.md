# 知识库引用网络 已知债务台账

> **版本**：v1.1 | **日期**：2026-06-11 | **状态**：开放（v2 已落 4 件套，剩余转 v3）

## v2 进度更新（2026-06-11 晚，commit `28610fc`）

本轮落地 4 件套，§1.1 / §1.2 / §1.3 / §1.4 部分已**消除**：

| § | 事项 | 状态 |
|---|---|---|
| 1.1 | 编辑器 `[[` 自动补全 | ✅ `WikilinkAutocomplete.tsx` 已挂入 DocBrowser 编辑模式，调 `/api/mentions/stores/:id/suggest`，上下键 + Enter + Esc 全通 |
| 1.2 | 编辑器 `@` 触发 | ✅ 同组件同时识别 `@`，中文 IME 友好 |
| 1.3 | 悬停预览卡 | ✅ `WikilinkHoverCard.tsx` + `MarkdownViewer` 派发 `wikilink:hover` 事件，蓝链浮 280px 预览（标题 + 摘要 + 「双链目标」徽章 + 「点击跳转 · 鼠标移开关闭」） |
| 1.4（部分） | 「文档不存在」虚链 UX 兜底 | ✅ MarkdownViewer 查 `wikilinkCache` 判断目标是否存在，不存在→橙色虚线下划线 + 悬停浮橙色提示卡 |
| 1.4（完整） | AI 自动补链（保存时扫描"提到 X 但没标 [[]]"） | ❌ 转 v3，见 §1.4 |

剩余条目按下述 §1 / §2 / §3 / §4 处理，编号保持不变以兼容历史引用。



> **关联文档**：`design.knowledge-base.mention-network.md`（本设计的主文档，本文是其遗留事项台账）

## 一、MVP 已知边界（2026-06-11 上线时明确告知用户）

### 1. 编辑器 `[[` 自动补全 — ✅ 已消除（v2，2026-06-11，commit `28610fc`）
落地组件：`prd-admin/src/components/doc-browser/WikilinkAutocomplete.tsx`。

### 2. 编辑器 `@` 触发 — ✅ 已消除（v2，2026-06-11，commit `28610fc`）
同组件同时识别 `@`，中文 IME 友好。

### 3. wikilink 悬停预览卡 — ✅ 已消除（v2，2026-06-11，commit `28610fc`）
落地：`MarkdownViewer` 派发 `wikilink:hover` / `wikilink:unhover`，`WikilinkHoverCard.tsx` 全局监听并查 `lib/wikilinkCache.ts` 渲染卡片。蓝链 = 存在卡，橙链 = 「文档不存在」卡。

### 4. AI 自动补链（推荐气泡）— ⚠️ 仅完成 UX 兜底（虚链提示），AI 推荐部分仍未做
v2 已落「文档不存在」橙色虚链 + 悬停提示，但**主动 AI 扫描"提到 X 但没标 `[[]]`"** 仍未做。完整实现：
- 在 `AppCallerRegistry` 加 `document-store.suggest-wikilinks::chat`
- 新增 `LinkSuggestService`（参考 `LlmGateway` 调用样例）
- 在 `UpdateEntryContent` 异步触发（不阻塞保存）
- 前端 `BacklinksPanel` 旁挂一个「待确认链接」组件
- 用户「采纳」时回写正文 `[[xxx]]`，再次保存触发 `MentionService.ResyncDocumentMentionsAsync`

### 5. 跨库引用未支持
`MentionService.ResyncDocumentMentionsAsync` 只在同库 `StoreId` 内按标题匹配。跨库引用需要扩展协议（如 `[[storeA::标题]]`）+ Resolver 路由。

### 6. 跨实体引用未支持（缺陷 / PR / 周报）
`Mention` 模型已通用化（FromType / ToType 都是字符串），但解析器层 hard-code 了 `Document`。扩展路径：
- 抽象 `IMentionResolver` 接口（GetTitle / GetSummary / GetUrl）
- DI 注册各实体的 resolver
- `MentionService.ResyncMentionsAsync` 接受实体类型参数

### 7. 别名（aka）未实现
文档 model 没有 `Aliases: List<string>` 字段。MVP 只支持精确标题匹配。

### 8. 改名时不会更新已有 wiki 链接
改了文档标题，其他文档正文里的 `[[旧标题]]` 不会自动改成 `[[新标题]]`。但**双链反向解析仍然走 ID（不走标题字面）**，所以"被引用"卡片不会丢，只是正文里的 anchor 文字停留在旧标题。改进：保存或改名时遍历 mentions 找到引用方，自动重写正文（需要权衡：是否要修改用户没保存的内容）。

### 9. 宇宙图无 AI 推荐"虚线"连接
原型设计稿里有"AI 检测到这两篇可能也该连"的虚线，未在 MVP 实现。

### 10. 宇宙图节点 ≥ 500 性能未压测
当前一次性返回全图数据 + 一次性力导向计算。10000 节点级别可能卡顿。需要：
- 节点数 ≥ 阈值时切换 WebGL 渲染（PixiJS / Sigma.js）
- 分层加载（按 category 折叠成"超级节点"）
- 力导向用 web worker 异步算

### 11. 宇宙图无时间轴回放
原型设计稿里有"看知识网怎么长出来"的功能，未实现。

### 12. 宇宙图无按团队分色
现按 `category` 字段哈希取色。"按用户" / "按团队"维度需要后端在 graph 接口里额外返回 createdBy + ownerTeamId。

### 13. 宇宙图设置面板的滑块改不触发立即重绘
当前 stateRef + onChange 改 ref，但渲染循环本身在跑，所以下一帧就生效。**已生效**，无 bug，但设置面板里的"已选值"label 没显示当前数值。改进：把 Display / Forces 滑块也走 useState 而非 ref。

### 14. UniverseGraphPage 没有 `[stay-on-page]` 防滥用
宇宙图持续 60fps 跑物理引擎，CPU 占用偏高。用户切走 tab 时应自动 pause requestAnimationFrame。

### 15. MongoDB 索引未建
`mentions` 集合的 `{scopeId}`, `{toType, toId}`, `{fromType, fromId}` 索引未建。当前数据量小，不影响；到 1 万 mentions 以上时需手动建（遵循 `no-auto-index` 规则，不能自动建）。

### 16. 标题撞名时取最早创建的
同库内多篇同名文档时，`MentionService` 取 `GroupBy(Title).First()` 即"最早创建的"。可能链错。改进：取「最近更新的」可能更符合用户预期；或在 UI 层提示用户选择。

## 二、技术债务

### T1. WikiLinkParser 不识别 markdown 代码块内的 `[[xxx]]`
正则全文匹配，包括代码块和行内代码。用户写 markdown 代码示例时可能误伤。改进：用 remark AST 走 mdast → 只在 paragraph / list-item 等正文节点扫。

### T2. 上下文截取按字符不按 UTF-16 surrogate pair
对 emoji 等 surrogate pair 字符在 60 字符截取边界可能切坏。改进：用 `Intl.Segmenter` 或 grapheme-splitter。

### T3. 反向链接面板没分页
一篇热门文档可能被 100+ 篇引用，全部一次性渲染。改进：分页或「显示前 10 条 / 展开更多」。

### T4. MentionsController 没区分 read-only 共享访问
当前权限走 `[AdminController]` + 内部 `CanReadAsync`。如果未来加分享链接公开访问（非登录用户），需要新增 public 端点（参考 `DocumentStoreController` 的 publicShare 系列）。

## 三、用户提出但暂未承诺的功能

- 拖文档进编辑器变成链接（`@` 的另一种触发方式）
- 工具栏「插入文档引用」按钮
- 选中文字 → 浮出「链到文档」（像微信选中弹「复制/翻译」）
- 双击宇宙图节点直接弹出文档预览侧抽屉（不离开宇宙）

## 四、风险监控

- **滥用风险**：恶意用户可能在文档里写一大堆 `[[]]` 撑账本。当前 `MentionService` 用 HashSet 去重，单文档对单 to 只保留一条；但 1 篇文档可链到 1000 个不同 to 仍然成立。需限流：单文档 mentions 上限（如 200）+ 告警。
- **隐私风险**：反向链接面板会暴露「谁引用了我」。如果跨用户/跨团队可见 mentions，可能泄露对方在编辑什么文档。MVP 通过 `CanReadAsync` 控制 store 级访问，OK；但跨库引用 v2 时需要重新审计权限路径。
- **性能风险**：参考 §1 的 10、15 项。
