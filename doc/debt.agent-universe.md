# 智能体宇宙 · 债务台账

> **版本**：v3.0 | **日期**：2026-06-02 | **状态**：no-fake 重构 + 参数选择器已落地并预览域名实测通过
> **关联设计**：`design.agent-universe.md`

记录"智能体宇宙"主动声明的已知边界、后续可补项、需用户判断的分叉，避免下一次 session 没人记得。

## 一、已落地并验收（no-fake + 参数选择器）

- 统一信封 `invoke` **只路由到真实 `IAgentAdapter`**，删除硬编码提示词的"假聊天"（`RunChatAsync` + 注册表 `SystemPrompt` 已移除）。找不到真实适配器 → 报错 `NO_REAL_AGENT`，不仿冒。
- 注册表只登记有真实组件的 4 个：visual（text2img 真生图）/ literary（write_content）/ defect（extract_defect）/ prd（analyze_prd）。
- `VisualAgentAdapter` 改走真实生图引擎 `OpenAIImageClient.GenerateUnifiedAsync`（修复手搓 quality 被模型拒绝）。
- 参数选择器：`GET agents/{key}/parameters` 从**智能体自己原有的池**（`ai-toolbox.agent.visual`）拉真实可选项；模型 ≥2 才给模型选择器，尺寸取首个模型注册表里的真实尺寸（≥2 才给）；`invoke` 的 `parameters` 透传到适配器 → 真实引擎。

**预览域名实测（2026-06-02，HTTP 取证）**：
- capabilities = 4 个真实智能体；调已下架的 report-agent → `UNKNOWN_AGENT`（无仿冒兜底）。
- literary → 真实 `LiteraryAgentAdapter` 文本；visual → 真实图片（`cfi.miduo.org/.../*.png`，HTTP 200 / image/png）。
- 参数接口返回 `size` 5 个真实选项；无 model 选择器（当前池仅 1 个模型，无可选项，按规则不显示）。
- 选不同尺寸真实出图且输出随之变化（默认 1536×1024 vs 选 1344×768 → 1254×1254），证明参数贯穿到真实引擎。

## 二、已知边界（诚实记录）

| 边界 | 说明 |
|------|------|
| 尺寸非像素精确 | 当前池模型 `gpt-image-2-all`（apiyi）对尺寸**松散解释**，不产出像素精确目标尺寸（选 1344×768 实出 1254×1254）。这是该真实模型的特性；按用户"用原来的池"指令不替换。要像素精确，在模型池换一个严格支持尺寸的生图模型即可（前端零改动，接口自动列新池真实选项）。 |
| 尺寸选项源 | 选项取自池**首个**模型的注册表配置；若池内多模型尺寸不同，切模型时尺寸未级联刷新（当前池单模型，暂不涉及）。 |
| 多轮上下文 | 适配器单轮（single-shot），chat 类每次提交独立一轮、不带前几轮上下文。再加工场景可接受；如需多轮需改适配器或信封侧聚合。 |

## 三、需用户判断业务逻辑的分叉

| # | 分叉 | 需你定 |
|---|------|--------|
| 1 | 没有真实组件的智能体（周报/PM/PA/任务树/翻译/摘要/代码审查/数据分析，已下架）是否逐个接各自真实后端服务（非 chat 仿冒）？接哪些、优先级？ |

## 四、待后续验收的增量

| # | 项 | 说明 |
|---|------|------|
| 1 | **文学"图文一体"配图** | `generate_illustration` 产出的是插图描述文本，不是图片。真正配图需链式：literary `generate_illustration`（文本）→ visual `text2img`（图片）。契约互通第一个范例，待做+验收。 |
| 2 | **@艾特行内调用** | 文档/对话里 @ 智能体行内触发，复用同一 `invoke` 信封。待做+验收。 |
| 3 | **img2img / compose** | `VisualAgentAdapter` 的 img2img/compose 仍是占位；信封已能传 `imageUrls`，待接通+验收。 |
| 4 | **视频生成** | `video-agent` 无可单轮跑的真实组件（视频是长任务 Run/Worker），未登记，单独波次。 |

## 五、验收标准（用户硬性要求：通过才算数）

每个增量交付前必须：后端 CDS 编译通过；真实路径验证（SSE/日志看到确实调真实 adapter）；视觉出图预览域名实测；写明自测路径与结论。
