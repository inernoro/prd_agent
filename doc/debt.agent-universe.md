# 智能体宇宙 · 债务台账

> **版本**：v2.0 | **日期**：2026-06-02 | **状态**：no-fake 重构已落地，以下为已知边界与待用户判断项
> **关联设计**：`design.agent-universe.md`

记录"智能体宇宙"主动声明的已知边界、后续可补项、以及需用户判断业务逻辑的分叉，避免下一次 session 没人记得。

## 一、已落地（no-fake 原则）

- 统一信封 `invoke` **只路由到真实 `IAgentAdapter`**，删除了硬编码提示词的"假聊天"路径（`RunChatAsync` + 注册表 `SystemPrompt` 已移除）。
- 注册表只登记有真实组件的 4 个：visual（text2img 真生图）/ literary（write_content）/ defect（extract_defect）/ prd（analyze_prd）。
- 找不到真实适配器 → 明确报错 `NO_REAL_AGENT`，不降级仿冒。

## 二、需用户判断业务逻辑的分叉（滞后项）

| # | 分叉 | 现状 | 需你定 |
|---|------|------|--------|
| 1 | **视觉模型选择走哪个池** | 再加工的 `VisualAgentAdapter` 用 `ai-toolbox.agent.visual::generation` 池；主视觉创作页用 `visual-agent.image.text2img::generation` 池。两者可能是不同模型池。 | 模型选择器应列哪个池的模型？建议**统一到主视觉创作的池**（一处配置），否则面板里能选但适配器解析不到 → 失败。定了我再接模型选择器。 |
| 2 | **没有真实组件的智能体是否要接** | 周报/PM/PA/任务树/翻译/摘要/代码审查/数据分析已下架（无 adapter）。 | 要不要逐个接它们各自的真实后端服务（非 chat 仿冒）？接哪些、优先级？ |

## 三、本轮未做、待后续验收的增量

| # | 项 | 说明 |
|---|------|------|
| 1 | **参数选择器（尺寸/模型）** | 后端 `invoke` 已支持 `parameters` 透传到适配器 `Input`；但 `VisualAgentAdapter` 暂未读取 `size/model`（仍用默认 1024x1024），前端也未渲染选择器。等分叉 #1 定了池来源后一起做并验收（尺寸 + 模型）。 |
| 2 | **文学"图文一体"配图** | 文学的 `generate_illustration` 产出的是**插图描述文本**，不是图片。真正配图需链式：literary `generate_illustration`（文本）→ visual `text2img`（图片）。这是契约互通的第一个范例，待做+验收。 |
| 3 | **@艾特行内调用** | 在文档/对话里 @ 智能体行内触发，复用同一 `invoke` 信封。待做+验收。 |
| 4 | **多轮上下文** | 适配器是单轮（single-shot）。chat 类（literary/prd）在再加工里每次提交都是独立一轮，不带前几轮对话上下文。当前"再加工"场景可接受；如需多轮需改适配器或在信封侧聚合。 |
| 5 | **img2img / compose** | `VisualAgentAdapter` 的 img2img/compose 仍是占位；信封已能传 `imageUrls`，待接通+验收。 |
| 6 | **视频生成** | `video-agent` 无可在面板单轮跑的真实组件（视频是长任务 Run/Worker），未登记，单独波次。 |

## 四、验收标准（用户硬性要求：通过才算数）

每个增量交付前必须：
- 后端 CDS 编译通过（本地无 dotnet）。
- 真实路径验证：能在 LLM 日志 / SSE 看到**确实调用到真实 adapter**，不是仿冒。
- 视觉出图：预览域名真实生成图片并能插入文档（模型池已就绪）。
- 写明自测路径与结论。
