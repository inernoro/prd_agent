# 智能体宇宙 · 设计

> **版本**：v1.0 | **日期**：2026-06-02 | **状态**：MVP 已落地（再加工抽屉接入；视觉创作走真实生图；后端待 CDS 编译验证）
> **关联实现**：`prd-api/.../Models/AgentUniverse/AgentCapability.cs`、`AgentCapabilityRegistry.cs`、`prd-api/.../Controllers/Api/AgentUniverseController.cs`、`prd-admin/.../services/real/agentUniverse.ts`、`prd-admin/.../pages/document-store/ReprocessChatDrawer.tsx`
> **关联设计**：`.claude/rules/app-identity.md`（应用身份）、`.claude/rules/llm-gateway.md`（网关）、`debt.agent-universe.md`（债务台账）
> **一句话**：把"每个智能体各搞各的调用方式、再加工还把视觉创作降级成假聊天"升级为"一套能力契约 + 一套调用信封，让所有智能体像漫威宇宙那样按统一标准互通"。

---

## 1. 管理摘要

之前"再加工"有三个问题，根因都在"智能体没有契约、调用没有标准"：

1. **选了就发**：在文档对话里选一个智能体，没等用户说话就用默认指令自动发了一轮——用户莫名其妙。
2. **捏造智能体**：选"视觉创作"实际只走了一条通用文本聊天链路，喂一段"你是视觉设计师"的提示词，**根本不生图**，所以出不来画面/架构图，像换了层皮的聊天机器人。
3. **没有统一标准**：每个智能体的"输入是什么、输出是什么、怎么被调用"散落在各处，前端只能把所有东西当聊天处理，智能体之间也无法互相拼装。

本设计立两根支柱解决：

- **能力契约（Capability Contract）**：每个智能体声明四件事——接受什么输入、产出什么输出、以什么模式被调用、前端该渲染什么交互。后端是唯一权威源（SSOT），前端拉取后据此渲染，不再各自硬编码。
- **调用信封（Invocation Envelope）**：所有入口（再加工 / 未来的 @艾特 / 工作流节点）都走同一个 `invoke` 接口，按契约的调用模式路由——生成型路由到真实生图适配器、文本型走网关聊天——产出统一为带类型的事件（文本 / 思考 / 图片 / 完成 / 错误）。

落地后："选了不再自动发"，"视觉创作真出图、可一键插进文档"，"加新智能体只改注册表一处、前端自动适配"。

---

## 2. 产品定位：漫威宇宙式互通

把每个智能体想成漫威里的一个英雄：各有各的能力（钢铁侠会飞、奇异博士开传送门），但他们能并肩作战，靠的是**一套共同的世界规则**。本系统的"共同规则"就是能力契约 + 调用信封：

- 任何智能体只要登记了契约，就自动出现在所有支持"宇宙调用"的入口里；
- 任何入口只要会发调用信封、会读统一事件，就能驱动任意智能体；
- 一个智能体的输出（如文学创作产出的插图描述）可以成为另一个智能体的输入（视觉创作据此生图）——这就是"互相调用"的标准接口。

这套标准刻意**不抄竞品的多 Agent 框架**，而是把本系统已经存在的砖块（`IAgentAdapter` 适配器、LLM Gateway、Run/Worker、Artifact）用一层薄契约串起来。

---

## 3. 用户场景

### 场景 A：把文档配图（视觉创作）
用户在知识库打开一篇文档 → 点"再加工" → 选「视觉创作智能体」→ 输入框提示变成"描述你想要的画面" → 用户输入"赛博朋克城市夜景" → 点「生成图片」→ 抽屉里流式显示生成过程并最终展示图片 → 用户点「插入文档」把图片写回正文。

### 场景 B：把文档改写成故事（文学创作）
选「文学创作智能体」→ 提示变成"告诉我怎么改写这篇文档" → 输入"改写成第一人称散文" → 流式输出文本 → 「替换原文 / 追加末尾 / 另存为新文档」。

### 场景 C：从文档提取缺陷（缺陷管理）
选「缺陷管理智能体」→ 按钮变成「提取缺陷」→ 输出结构化的缺陷字段（标题 / 复现步骤 / 严重程度）→ 可写回或另存。

三个场景用的是**同一个抽屉、同一个调用信封**，差异完全由能力契约驱动。

---

## 4. 核心能力

### 4.1 能力契约字段

| 字段 | 含义 | 示例（视觉创作） |
|------|------|------------------|
| `agentKey` | 智能体标识 | `visual-agent` |
| `inputs` | 接受的输入类型 | `[text, image]` |
| `outputs` | 产出的输出类型 | `[image]` |
| `invokeMode` | 调用模式（决定后端路由） | `generation` |
| `interaction` | 交互形态（决定前端渲染） | `prompt-to-image` |
| `defaultAction` | 默认适配器动作 | `text2img` |
| `inputHint` / `actionLabel` | 输入提示 / 按钮文案 | "描述你想要的画面" / "生成图片" |

数据类型枚举：`text / document / image / audio / structured / video`。
调用模式枚举：`chat / generation / structured / transform`。
交互形态枚举：`chat-stream / prompt-to-image / article-to-illustrated / form-submit`。

### 4.2 调用模式路由

| invokeMode | 后端路由 | 产出 |
|------------|----------|------|
| `generation` | 对应 `IAgentAdapter`（如 `VisualAgentAdapter.text2img`） | 文本进度 + 图片 artifact |
| `chat` | LLM Gateway 流式（用契约里的专属 SystemPrompt） | 流式文本 |
| `structured` | LLM Gateway 流式（结构化输出提示词） | 结构化文本 |
| `transform` | LLM Gateway 流式（整篇改写） | 文本 |

> 当前只有 `visual-agent`（generation）会路由到适配器产出真实图片；其余智能体走网关聊天链路，但每个都有**专属、具体**的系统提示词（来自注册表 SSOT），不再是"通用百宝箱助手"。

### 4.3 已登记的智能体（12 个）

视觉创作、文学创作、缺陷管理、周报、任务树、项目管理、行政秘书、PRD 解读、代码审查、翻译、摘要、数据分析。新增只需在 `AgentCapabilityRegistry.All` 加一条。

---

## 5. 架构

```
前端（再加工抽屉 / 未来 @艾特 / 工作流节点）
   │  GET  /api/agent-universe/capabilities   ← 拉契约，渲染选择器 + 对应交互
   │  POST /api/agent-universe/invoke (SSE)    ← 统一调用信封
   ▼
AgentUniverseController
   ├─ 按 agentKey 查 AgentCapabilityRegistry（SSOT）
   ├─ invokeMode==generation 且有适配器 → IAgentAdapter.StreamExecuteAsync
   │        └─ VisualAgentAdapter → LLM Gateway 生图 → 图片 artifact
   └─ 否则 → ILlmGateway.StreamAsync（契约的 SystemPrompt）→ 文本
   ▼
统一 SSE 事件：start / thinking / text / artifact / done / error
```

关键点：契约是**唯一**新增的抽象层；适配器、网关、Artifact 全是系统已有的砖块。控制器复用 `ai-toolbox` 应用身份与 `ai-toolbox.use` 权限（与 `TranscriptAgentController` 同样复用，符合 `app-identity.md`）。

## 6. 接口设计

### GET /api/agent-universe/capabilities
返回 `{ success, data: { capabilities: AgentCapability[] } }`。`systemPrompt` / `appCallerCode` 不下发（`[JsonIgnore]`，前端无业务逻辑）。

### POST /api/agent-universe/invoke （SSE）
请求体：
```json
{ "agentKey": "visual-agent", "text": "赛博朋克城市夜景",
  "documentContent": "可选，chat 模式作为输入上下文", "history": [], "imageUrls": [] }
```
SSE 事件：
| 事件 | data | 说明 |
|------|------|------|
| `start` | `{agentKey, invokeMode, model?, platform?}` | 开始（含模型可见性，对齐 `ai-model-visibility.md`）|
| `thinking` | `{content}` | 思考过程 |
| `text` | `{content}` | 文本增量 |
| `artifact` | `{kind, url, name, mimeType, content}` | 成果物（图片 url）|
| `done` | `{totalTokens?, ...}` | 完成 |
| `error` | `{message}` | 失败 |

## 7. 关联设计文档

- `.claude/rules/app-identity.md`：应用身份隔离（控制器硬编码 appKey）
- `.claude/rules/llm-gateway.md`：所有 LLM 调用必须过 Gateway
- `.claude/rules/compute-then-send.md`：生图适配器已遵循"先 resolve 后 send"
- `debt.agent-universe.md`：本期未还的工程债（见下）

## 8. 风险与边界

| 风险 | 说明 | 缓解 |
|------|------|------|
| 后端无本地 SDK 验证 | 开发环境无 dotnet | 走 CDS 自动部署编译验证（`cds-first-verification.md`）|
| 生图依赖模型池 | 视觉创作需 ImageGen 模型池可用 | 池不可用时适配器返回 error，前端展示失败 |
| 契约与适配器漂移 | generation 智能体若无对应适配器 | 控制器降级 chat + 告警日志；后续补注册表↔适配器一致性测试（见 debt）|
| 多入口尚未接入 | 当前仅再加工抽屉接入信封 | @艾特 / 工作流节点为后续波次（见 debt）|
