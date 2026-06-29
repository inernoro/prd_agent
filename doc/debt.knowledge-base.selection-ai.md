# 知识库划词 AI 局部编辑 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-12 | **状态**：维护中

## 总览

模块范围：`prd-admin/src/components/doc-browser/`（SelectionAiPopover / SelectionImagePopover / selectionEdit.ts + DocBrowser 划词动作条）、
`prd-api/.../DocumentStoreController.cs`（selection-rewrite SSE 端点 + actions 清单）、
`prd-api/.../Services/SelectionRewriteActionRegistry.cs`（动作 SSOT）、
`AppCallerRegistry.DocumentStoreAgent.Selection.Rewrite`。

第一波落地：划词浮层从单一「添加评论」扩展为 评论 / AI 改写 / 配图 动作条；
AI 改写支持润色/精简/扩写/书面化/纠错 + 自定义指令，SSE 流式生成 + diff 对比 + 替换原文（唯一定位校验）/ 插到原文后；
配图内嵌视觉创作 mini 面板（appKey=visual-agent），按选区 + 文档上下文生成并插入选区段落之后。
写回复用既有 `PUT entries/{id}/content`，服务端自动重锚定行内评论 + 重算双链账本。以下为主动声明的已知边界。

## 已知边界（待后续偿还）

| # | 边界 | 现状 | 后续方向 |
|---|------|------|----------|
| 1 | 多处出现的选区定位 | 已升级为 DOM 序号指认（2026-06-12 Bugbot High 修复）：从真实 DOM Range 数"选区前同文出现次数"指认第几处；仅当 DOM 总数与正文统计不一致（评论气泡等副本混入 DOM）时仍禁用替换 | 如需进一步收窄禁用面：DOM 计数时排除浮层/批注 DOM 子树 |
| 2 | 无撤销 | 替换/插入直接走 PUT content 落库，无一键撤销（可通过再次编辑恢复） | 写回前在前端暂存上一版，提供 toast 内「撤销」按钮；或接入条目版本历史 |
| 3 | 并发编辑 | 选区快照与写回之间若他人改了正文，靠"重定位失败即拒绝"兜底，无乐观锁 | PUT content 增加 baseUpdatedAt 预检（409 冲突提示） |
| 4 | 配图定位失败兜底 | 选区无法在正文定位时图片追加到文末（toast 未单独提示落点） | 同 #1 提升定位成功率；失败时明确提示"已插入文末" |
| 5 | 改写动作集 | 首批 5 个内置动作 + 自定义指令；翻译/表格化/Mermaid 图等靠自定义指令 | 按使用数据沉淀高频自定义指令为内置动作（注册表加一行即可） |
| 6 | 仅文本类条目 | PDF/图片等非 `preview=text` 条目不露 AI 入口（改不了正文） | 暂无计划 |
| 7 | 富文本编辑模式 | AI 动作条只在阅读态出现；编辑态（textarea/富文本）内划词无 AI 入口 | 编辑态接 textarea selectionStart/End（offset 精确，无需消歧），成本低收益高 |
| 8 | 后端编译验证 | 开发环境无 dotnet SDK，C# 改动依赖 CDS push 后远端编译验证 | CDS 绿灯后此条自动关闭 |

## 第二波候选（涌现池收敛，未排期）

- 划词追问（解释这段 / 与全库知识对照）：只读也可用，输出进侧栏不改正文
- 划词转双链：选中概念一键 `[[包裹]]` 并建联（联动 mentions 账本）
- AI 改写建议以"行内评论"形式挂在选区上（复用 InlineComment 数据模型，作者审阅后采纳）
- 全文体检：逐段跑纠错/一致性检查，按段落生成批量建议

## 相关

- 接口：`POST /api/document-store/entries/{entryId}/selection-rewrite`（SSE：start/thinking/text/done/error）、`GET /api/document-store/selection-rewrite/actions`
- 单测：`prd-admin/src/components/doc-browser/__tests__/selectionEdit.test.ts`（定位/替换/插入/前缀拼接 14 例）
- 关联台账：`doc/debt.knowledge-base.inline-comment.md`（划词评论）、`doc/debt.knowledge-base.mention-network.md`（双链）
