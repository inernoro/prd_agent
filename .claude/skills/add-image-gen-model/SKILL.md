---
name: add-image-gen-model
description: 添加视觉创作生图模型。优先在 LLMGW 创建逻辑模型与 Offering；只有出现新的图片协议或参数契约时才修改代码适配器。触发词："添加生图模型"、"新增生图模型配置"、"配置新的生图模型"、"add image gen model"。
---

# 添加生图模型

> 版本：v2.0.0 | 状态：已落地

## 核心原则

视觉创作只认识稳定的逻辑模型 PublicId；Provider、密钥、真实模型标识、Endpoint、协议和故障切换全部由 LLMGW 管理。

新增模型分两类：

1. 配置型接入：已有协议能表达该模型，只改 LLMGW 数据，不发版。
2. 协议型接入：上游请求或响应形态是新契约，先补代码适配器与测试，再配置 LLMGW。

禁止为了多显示几个选项而在前端硬编码模型。没有健康 Offering 的逻辑模型不进入视觉创作列表。

## 四层契约

### 1. 上游模型或 Exchange

在 LLMGW 的“路由 → Provider / 模型 / Exchange”创建或复用真实上游，必须确认：

- Provider、Base URL 和通讯密钥有效。
- 上游模型标识来自供应商当前官方目录，不凭名称猜测。
- 图片生成能力已声明；需要参考图时还要确认图片输入能力。
- 测试与正式环境分别配置密钥。

### 2. 逻辑模型

在“路由 → 逻辑模型”创建稳定 PublicId，例如：

- `image2`
- `nanobanana-2`
- `nanobanana-2-lite`

模型类型使用 `generation`，能力按真实支持范围选择：

- `image_generation`
- `text2img`
- `img2img`
- `vision_generation`

PublicId 不含 Provider、Endpoint 或供应商版本，保存后不要随上游切换频繁改名。

### 3. Offering

每个 Offering 只绑定一个上游模型或 Exchange。必须配置：

- 精确协议。
- 必要时填写上游模型覆盖和 Endpoint path。
- 优先级或权重。
- 已知的最大并发和 RPM；未知时留空，不填猜测值。

关键模型建议至少两条由不同 Provider 或 Endpoint 承载的 Offering。确定性协议、模型或权限错误只隔离该 Offering；同一逻辑模型还有健康 Offering 时仍可使用。

OpenRouter 当前专用图片 API 使用：

- 协议：`openrouter-image`
- Endpoint path：`images`
- 文生图字段：`model`、`prompt`、`n`、`size`
- 多图字段：`input_references`
- 响应：`data[].b64_json`、`data[].media_type`

旧的 `openrouter` 协议保留给仍使用 `chat/completions + modalities` 的兼容通道，不能和专用图片 API 混用。

### 4. appCaller 可见范围

视觉创作按能力授权：

- `visual-agent.image.text2img::generation`
- `visual-agent.image.img2img::generation`
- `visual-agent.image.vision::generation`

只授权真实支持的场景。未授权 appCaller、逻辑模型禁用、全部 Offering 禁用或隔离时，模型不得进入对应选择器。

## 何时需要改代码

只有以下情况才进入代码适配：

- 新协议或新 Endpoint 形态。
- 请求字段与现有协议不同。
- 多图、遮罩或尺寸参数需要新的转换规则。
- 响应图片不在现有解析形态中。

相关文件：

- `prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs`：根据每条 Offering 的协议从 canonical 图片请求重建 HTTP 请求。
- `prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs`：图片业务调用与响应落库。
- `prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigs.cs`：模型尺寸、比例和参数能力。
- `prd-admin/src/lib/imageGenAdapterConfigs.ts`：仅用于前端尺寸能力预览，不是模型目录。

后端与前端尺寸配置需要保持一致；更具体的 `ModelIdPattern` 必须排在通用前缀之前。

## 执行步骤

1. 读取 LLMGW 当前逻辑模型、Offering、上游模型和最近请求日志。
2. 对照供应商官方模型目录核实模型标识、输入输出能力和当前协议。
3. 判断是配置型接入还是协议型接入。
4. 协议型接入先添加请求重建、响应解析和单元测试；配置型接入跳过代码修改。
5. 在测试环境创建或更新逻辑模型与 Offering，授权对应 appCaller。
6. 发起最小真实请求并保存 requestId；文生图、图生图和多图能力分别验收。
7. 在请求日志核对 LogicalModelPublicId、OfferingId、实际 Provider、实际模型、协议和回退轨迹。
8. 只有真实请求成功后才允许模型进入视觉创作列表。
9. 在正式环境重复配置，不复制测试环境密钥。

## 完成门槛

- 视觉创作只显示逻辑模型，不泄漏 Provider、Endpoint、密钥或模型池成员。
- 至少一条 Offering 健康；关键模型建议有已验证的备用 Offering。
- 选择的 PublicId 与日志中的 LogicalModelPublicId 一致。
- 多 Offering 协议不同时，每次尝试都按自己的协议重新构建请求。
- 确定性故障展示用户可理解文案，技术错误只进入日志。
- 新协议有请求体、Endpoint、响应解析和故障切换测试。
- 视觉创作桌面与移动端完成真实路径验收。

## 不要做

- 不在前端硬编码一个没有健康 Offering 的模型。
- 不把多个 Provider 暴露成多个用户模型。
- 不用模型池代替逻辑模型目录。
- 不把 `chat/completions`、OpenAI Images、OpenRouter Images 或 Google `generateContent` 当成同一种 wire shape。
- 不用删除 Provider 或清空池作为回滚；禁用逻辑模型或 Offering 即可。

## 教程与验收

- 系统教程：`llmgw/tutorial/practical/01-add-gpt-image-2-all.md` 至 `04-verify-image-model.md`。
- 新增协议后同步更新教程，明确协议、Endpoint 和真实验收路径。
- 视觉验收必须从 MAP 的“模型网关”入口进入，再回到视觉创作验证选择器和真实出图。
