# 模型中继虚拟平台 (Exchange as Virtual Platform) 设计方案

> **版本**：v1.0 | **日期**：2026-04-16 | **状态**：已实现

## 一、管理摘要

- **解决什么问题**：模型中继（Exchange）原本是"单入口单别名"的代理，不能携带多个模型；在平台列表中以魔法字符串 `__exchange__` 标识，用户无法自定义名称，UI 展示混乱。
- **方案概述**：将每条 Exchange 升级为"虚拟平台"——拥有用户自定义名称、管理多个 `ExchangeModel` 子条目，在平台管理页与真实平台并排展示，模型池可直接按 Exchange.Id 绑定。
- **业务价值**：用户可以用一条 Gemini 中继挂载 5 个模型，给平台取有意义的名字（"我的 Gemini"），在模型管理、模型池、可用模型对话框中均能正常选用。
- **影响范围**：`ModelExchange`（数据模型）、`ExchangeController`、`PlatformsController`、`ModelResolver`、`LlmGateway`（URL 模板/鉴权），前端 ExchangeManagePage、ModelManagePage、ModelPoolManagePage、PlatformAvailableModelsDialog。
- **预计风险**：低 — 严格向后兼容，旧 `__exchange__` 模型池条目通过双路径 ModelResolver 继续工作。

---

## 2. 背景与问题

### 2.1 旧设计痛点

旧 Exchange 是"一条记录 = 一个代理端点 + 一个别名"：

```
ModelExchange {
  ModelAlias: "gemini-2.0-flash"          // 单别名
  ModelAliases: ["gemini-1.5-pro"]        // 附加别名
  TargetUrl: "https://generativelanguage.googleapis.com/..."
}
```

模型池条目通过硬编码魔法字符串引用中继：

```
ModelGroupItem {
  PlatformId: "__exchange__",   // ← 硬编码魔法字符串，所有中继共享
  ModelId: "gemini-2.0-flash"
}
```

痛点：
1. 所有中继共用同一 `__exchange__` 标识，无法区分"我的 Gemini"和"公司 OpenRouter"
2. 模型只能以字符串别名方式存储，无法携带 DisplayName、ModelType 等元数据
3. UI 中不支持用户给中继起名字，平台列表里显示"模型中继 (Exchange) · __exchange__"，极不友好
4. URL 无法携带 `{model}` 模板，每个模型需要不同中继条目

### 2.2 目标

- 每条 Exchange 作为独立虚拟平台（有真实 Id、有自定义 Name）
- Exchange 可挂载 N 个 `ExchangeModel`（ModelId + DisplayName + ModelType + Enabled）
- URL 支持 `{model}` 占位符（在 Gateway 分发时替换为实际 ModelId）
- 向后兼容旧 `__exchange__` 模型池条目

---

## 3. 数据模型

### 3.1 ModelExchange（MongoDB 集合：`model_exchanges`）

```
ModelExchange {
  Id: string (MongoDB ObjectId)
  Name: string                       // 用户自定义虚拟平台名，如 "我的 Gemini"
  TargetUrl: string                  // 支持 {model} 占位符
  TargetApiKeyEncrypted: string
  TargetAuthScheme: string           // bearer / x-api-key / x-goog-api-key / ...
  TransformerType: string            // none / gemini-native / ...
  TransformerConfig: JsonObject?
  Enabled: bool

  // 新字段（主数据）
  Models: List<ExchangeModel>        // 挂载的模型列表（空则降级读旧字段）

  // 旧字段（兼容）
  ModelAlias: string?                // 单模型旧格式
  ModelAliases: List<string>?        // 多别名旧格式

  CreatedAt / UpdatedAt: DateTime
}

ExchangeModel {
  ModelId: string        // 发送给上游 API 的真实模型 ID
  DisplayName: string?   // 用户友好显示名称
  ModelType: string      // chat / vision / generation / tts / asr / embedding
  Description: string?
  Enabled: bool
}
```

**`GetEffectiveModels()` 扩展方法**：若 `Models` 非空则直接返回；否则从旧字段 `ModelAlias`/`ModelAliases` 合成 ExchangeModel 列表（惰性迁移，不回写数据库）。

### 3.2 ModelGroupItem（模型池条目）

```
ModelGroupItem {
  PlatformId: string   // 新：Exchange.Id（真实 MongoDB ID）
                       // 旧："__exchange__"（仍然支持，向后兼容）
  ModelId: string      // ExchangeModel.ModelId
}
```

---

## 4. URL 模板机制

`TargetUrl` 支持 `{model}` 占位符，Gateway 在分发时替换：

```
https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
↓
https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
```

实现：`LlmGateway.ResolveEndpointTemplate(urlTemplate, actualModel)`。

若 URL 不含 `{model}`，保持原样（单模型场景向后兼容）。

---

## 5. 鉴权扩展

`SetAuthHeader()` 新增两种 Gemini 鉴权方案：

| TargetAuthScheme | HTTP 头 |
|---|---|
| `x-goog-api-key` | `x-goog-api-key: {key}` |
| `xgoogapikey`（别名） | `x-goog-api-key: {key}` |

---

## 6. 协议转换器：GeminiNativeTransformer

Gemini REST API 与 OpenAI API 格式不兼容，引入 `GeminiNativeTransformer`：

**请求转换（OpenAI → Gemini）**：

```
messages[{role, content}]  →  contents[{role, parts:[{text}]}]
system prompt              →  contents[0].parts[0].text（prepend）
image_url                  →  inlineData / fileData
response_modalities        →  generationConfig.responseModalities: ["IMAGE","TEXT"]
```

**响应转换（Gemini → OpenAI）**：

```
candidates[0].content.parts[{text}]      →  choices[0].message.content
candidates[0].content.parts[{inlineData}] →  content[{type:"image_url",image_url:{url:"data:…"}}]
usageMetadata.{promptTokenCount,…}        →  usage.{prompt_tokens,…}
```

注册方式：`TransformerRegistry` 中注册为 `"gemini-native"`。

---

## 7. API 设计

### 7.1 GET /api/mds/platforms — 返回真实 + 虚拟中继

```json
[
  { "id": "abc123", "name": "我的 Gemini", "platformType": "exchange",
    "kind": "exchange", "isVirtual": true, "transformerType": "gemini-native", ... },
  { "id": "xyz789", "name": "OpenAI", "platformType": "openai",
    "kind": "real", "isVirtual": false, ... }
]
```

前端通过 `kind` 字段区分，不再依赖 `id === "__exchange__"`。

### 7.2 GET /api/mds/platforms/{id}/available-models

- 若 `id` 是 Exchange.Id → 返回该中继的 ExchangeModel 列表
- 否则 → 返回真实平台的 LLMModel 列表（原有逻辑不变）

### 7.3 GET /api/mds/exchanges/for-pool

每个启用的 Exchange 下每个启用的 ExchangeModel 展开为一条选项：

```json
{
  "modelId": "gemini-2.5-flash",
  "displayName": "Gemini 2.5 Flash",
  "platformId": "abc123",          // Exchange.Id（真实 ID）
  "platformName": "我的 Gemini",
  "legacyPlatformId": "__exchange__"
}
```

### 7.4 POST /api/mds/exchanges/{id}/models/{modelId}/try-it

一键体验端点：用指定模型走完整转换管线，返回与 TestExchange 一致的 `ExchangeTestResult`。

---

## 8. ModelResolver 双路径查找

```
请求到达 ModelResolver.FindExchangeForPoolItemAsync(poolItem)
│
├─ poolItem.PlatformId == "__exchange__"（旧格式）
│   └─ 在所有 Exchange 中找 GetEffectiveModels().Any(m => m.ModelId == poolItem.ModelId)
│
└─ poolItem.PlatformId 是具体 Exchange.Id（新格式）
    └─ 直接按 Exchange.Id 查找，再验证模型存在
```

---

## 9. 前端架构变化

### 9.1 Platform 类型扩展

```ts
interface Platform {
  // 新增字段
  kind?: 'real' | 'exchange';
  isVirtual?: boolean;
  transformerType?: string;
}
```

### 9.2 ModelManagePage

- 并行拉取 `getExchanges()`，合成 `exchangeSynthModels`（id = `exchange::{exchangeId}::{modelId}`，platformId = Exchange.Id）
- `isExchangePlatform` 标志：隐藏 API 密钥/地址内联编辑，改为「前往编辑」跳转按钮
- 右键菜单：Exchange 平台只显示「在「模型中继」页编辑」（跳转 tab）
- 启用切换：Exchange 平台重定向至中继管理 tab，不调用真实平台 API

### 9.3 ModelPoolManagePage

不再前端合成 `__exchange__` 虚拟平台——后端 `/api/mds/platforms` 直接返回 Exchange 作为虚拟平台条目。

### 9.4 PlatformAvailableModelsDialog

通过 `platform.kind === 'exchange'` 判断虚拟平台，两种平台统一调用 `/api/mds/platforms/{id}/available-models`。

---

## 10. 预置模板：gemini-native

`ExchangeTemplates.All` 包含 `gemini-native` 模板，预置 5 个结构化模型：

| ModelId | DisplayName | ModelType |
|---|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | chat |
| `gemini-2.5-flash` | Gemini 2.5 Flash | chat |
| `gemini-2.0-flash` | Gemini 2.0 Flash | chat |
| `gemini-2.5-flash-image-preview` | Gemini 2.5 Flash（图像生成） | generation |
| `gemini-2.5-pro-image-preview` | Gemini 2.5 Pro（图像生成） | generation |

URL 模板：`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
鉴权：`x-goog-api-key`

---

## 11. 向后兼容策略

| 场景 | 旧数据 | 处理方式 |
|---|---|---|
| 模型池条目 `PlatformId = "__exchange__"` | 继续工作 | ModelResolver 双路径查找 |
| Exchange 无 `Models` 字段 | 只有 `ModelAlias`/`ModelAliases` | `GetEffectiveModels()` 惰性合成，不回写 |
| 前端使用 `id === "__exchange__"` 判断 | 旧代码 | 已全部替换为 `kind === 'exchange'` |

---

## 12. 关联设计文档

- `doc/rule.data-dictionary.md` — `model_exchanges` 集合字段描述
- `doc/design.llm-gateway.md` — ILlmGateway 统一调用接口
- `doc/spec.model-pool.md` — 模型池策略引擎规格
