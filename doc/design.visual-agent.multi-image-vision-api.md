# 多图视觉生成 · 设计

> **版本**：v1.1 | **日期**：2026-07-17 | **状态**：已落地

## 管理摘要

- **问题**：单图编辑接口无法让模型同时理解多张参考图，限制了融合、拼贴和多素材创作。
- **决策**：按参考图数量选择文生图、单图编辑或多图 Vision 生成；多图请求通过统一图片客户端和模型解析链路发送。
- **结果**：视觉创作可使用多张有序参考图，同时保持单图和无图场景的兼容行为。

## 路由决策

| 输入 | 生成模式 | 约束 |
|---|---|---|
| 无参考图 | 文生图 | 只传文本与生成参数 |
| 一张参考图 | 单图编辑或图生图 | 保持既有编辑兼容路径 |
| 多张参考图 | Vision 多图生成 | 以稳定顺序传递图片与文本提示词 |

多图模式最多使用六张参考图；超出上限时服务端明确截断并记录原因，前端不得自行改变图片顺序。

## 核心决策

1. **图片顺序是契约**：用户选择顺序即模型接收顺序，日志和结果都应可追溯该顺序。
2. **模型能力由解析结果决定**：是否可走 Vision 由模型池与平台解析结论决定，不由前端猜测提供商能力。
3. **统一 Run 生命周期**：多图生成沿用视觉创作 Run、Worker、对象存储和 SSE 结果路径。
4. **响应兼容**：服务端兼容图片 URL、内联图片及 Markdown 图片形式；无法解析为图片时返回明确失败。

## 数据流

1. 用户选择参考图并提交提示词，Run 保存图片引用与顺序。
2. Worker 加载图片引用，计算生成模式和对应 AppCallerCode。
3. 图片客户端经模型池解析后构造多模态请求，保留请求顺序和日志元数据。
4. 结果图上传到对象存储，Worker 保存消息和制品并通过 SSE 推送完成或错误。

## 错误与回退

| 场景 | 处理 |
|---|---|
| 未配置可用 Vision 模型 | 终止当前 Run 并提示配置原因，不伪装为单图成功 |
| 图片数量超限 | 使用允许范围内的图片并向日志和用户说明 |
| 上游返回文本或非预期结构 | 解析失败并保留可诊断的错误摘要 |
| 网络或上游失败 | 记录 Run 错误，允许用户调整配置后重试 |

单图与无图场景不因多图能力不可用而退化；多图不自动改走不具备等价语义的单图接口。

## 实现来源

- 生成 Worker：`prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs`。
- 图片客户端：`prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs`。
- Vision 契约：`prd-api/src/PrdAgent.Core/Models/MultiImage/VisionApiModels.cs`。
- 多图领域服务：`prd-api/src/PrdAgent.Infrastructure/Services/MultiImageDomainService.cs`、`MultiImageComposeService.cs`。
- 关联设计：`design.visual-agent.multi-image-compose.md`、`design.platform.image-ref-and-persistence.md`。
