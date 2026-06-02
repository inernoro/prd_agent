# 智能体宇宙 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-02 | **状态**：MVP 已落地，以下为已知边界
> **关联设计**：`design.agent-universe.md`

记录"智能体宇宙"MVP 主动声明的已知边界与后续可补项，避免下一次 session 没人记得。

## 已知边界

| # | 边界 | 现状 | 后续 |
|---|------|------|------|
| 1 | 仅 `visual-agent` 走真实生成适配器 | generation 模式只接了 `VisualAgentAdapter.text2img` | 缺陷/任务树的结构化抽取目前走 chat 路径（用结构化提示词输出 Markdown），未来可接 `DefectAgentAdapter.extract_defect` 走适配器结构化产出 |
| 2 | 文学创作"图文一体"未实现 | 契约 `outputs` 暂为 `[text]`，`interaction=chat-stream` | 接 `article-to-illustrated`：文本产出后调用 `visual-agent` 配图（这是契约互通的范例场景）|
| 3 | 调用信封仅再加工抽屉接入 | `ReprocessChatDrawer` 已用 `invokeAgent` | 后续把 @艾特、工作流节点、智能体首页都迁到同一信封 |
| 4 | img2img / compose 仍是占位 | `VisualAgentAdapter` 的 img2img/compose 为 MVP 占位（适配器历史代码）| 用 `imageUrls` 输入接通图生图 |
| 5 | 视频生成未纳入信封 | `video-agent` 未登记契约 | 视频是长任务，需 Run/Worker，单独波次 |
| 6 | 自定义工具 / 我的快捷智能体仍走旧 direct-chat | 它们本就是用户自定义 system prompt 的聊天体，无契约 | 可选：给它们生成"动态契约"统一进信封 |
| 7 | 后端未本地编译 | 开发环境无 dotnet SDK | 依赖 CDS 自动部署编译；建议补一个 `AgentCapabilityRegistry` 一致性单测（断言 generation 智能体都有对应适配器动作）由 CI 跑 |

## 待补测试

- 后端：`AgentCapabilityRegistry` 单测——每个 `invokeMode=generation` 的契约，其 `agentKey + defaultAction` 必须能被某个 `IAgentAdapter.CanHandle` 命中（防契约↔适配器漂移）。
- 前端：再加工抽屉的"选中不自动发送"行为断言（Vitest，模拟 pickToolbox 后 messages 为空）。
- 端到端：视觉创作生图 → 插入文档的真人/Playwright 取证（依赖模型池可用）。
