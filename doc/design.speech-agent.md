# 演讲智能体 · 技术设计

> **版本**：v0.1 (MVP) | **日期**：2026-06-06 | **状态**：开发中
>
> 对应产品规格：`doc/spec.speech-agent.md`

## 一、管理摘要

- **架构哲学**：复用现有砖块，不造新轮子。LLM 调用走 ILlmGateway，Mongo 用 prd-api 的标准模式，前端走 prd-admin 的标准路由 + Zustand。
- **新增组件**：
  - 后端：`SpeechAgentController` + `SpeechAgentService` + 2 个 Model + 4 个 AppCallerCode + 1 个 Permission
  - 前端：`/speech-agent` 系列 3 个页面 + `services/contracts/speechAgent.ts` + `services/real/speechAgent.ts`
- **数据存储**：2 个新集合 `speech_decks`、`speech_nodes`
- **流式协议**：MVP 用内联 SSE，Phase 2 升级为 Run/Worker + afterSeq 断线续传
- **关键风险已规避**：compute-then-send 单次 resolve、`BeginScope` 显式设置 UserId、`CancellationToken.None` 写 DB

## 二、产品定位

把"用户手上一段长文" → "可上台讲的演讲材料"。规则#9 中的【位置】是侧边栏「智能体」分组，新增条目 `wip: true`。

## 三、用户场景流转

```
列表页 (/speech-agent)
  └─ 新建 → 创建页 (/speech-agent/new)
       └─ 提交 → 编辑器 (/speech-agent/:id?autoStart=1)
            ├─ SSE 流式生成：thinking → typing → node × N → done
            └─ 节点编辑（PATCH）
```

## 四、核心能力

### 4.1 后端 Controller `SpeechAgentController`

`[Route("api/speech-agent")]`，硬编码 appKey `speech-agent`，权限 `AdminPermissionCatalog.SpeechAgentUse`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/decks?page=&pageSize=` | 列出当前用户的演讲 |
| POST | `/decks` | 创建演讲（draft 状态） |
| GET | `/decks/:id` | 详情 + 节点列表 |
| PATCH | `/decks/:id` | 改标题 / 受众 / 风格 / 深度 / 主题 |
| DELETE | `/decks/:id` | 级联删节点 |
| POST | `/decks/:id/generate` | SSE 流式生成（核心入口） |
| PATCH | `/decks/:id/nodes/:nodeId` | 改节点标题 / 要点 / 备注 |

### 4.2 后端 Service `SpeechAgentService`

`GenerateMindmapAsync(deck, onTyping, onThinking, onModel)`：
1. 构造 prompt（系统提示词 = 演讲教练 + JSON Schema；用户消息 = 截断到 16K 字的原文）
2. 走 `ILlmGateway.StreamAsync`，AppCallerCode = `speech-agent.mindmap.outline::chat`
3. 流式回调 typing / thinking；Start chunk 捕获 model + platform
4. 完整内容 buffer 完成 → 解析 JSON（容错：fenced block + 找 `{...}` 边界）→ 扁平化成 `List<SpeechNode>`
5. 逐节点 InsertOne，每条 yield NodeUpserted 事件
6. 全部完成更新 Deck.Status = `ready`

### 4.3 LLM 调用契约（compute-then-send 规则）

- **单次 resolve**：用 `_gateway.StreamAsync(request)`，请求体里只指定 `AppCallerCode + ModelType`，让 Gateway 自己一次性 resolve 选模型——发送阶段绝不再 resolve
- **`BeginScope` 必设**：Controller 在调 Service 前 `using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(...))`，UserId 走 `this.GetRequiredUserId()`
- **流式参数**：`include_reasoning: true` + `IncludeThinking: true`（让 OpenRouter / 推理模型不卡住 reasoning）
- **temperature 0.5**：偏稳定但保留少量创造性

### 4.4 SSE 协议

```
event: phase     data: {phase: "preparing"|"analyzing", message: "..."}
event: model     data: {model: "...", platform: "..."}
event: thinking  data: {text: "..."}          // 推理流，可选
event: typing    data: {text: "..."}          // 模型 token 流
event: node      data: {node: SpeechNode}     // 解析完成后逐节点推
event: done      data: {nodeCount, elapsedMs}
event: error     data: {message: "..."}
```

前端走 `useSseStream` hook，`onEvent` 映射处理。

## 五、架构与数据设计

### 5.1 数据模型

```
SpeechDeck (speech_decks)
├── Id (Guid hex)
├── OwnerUserId
├── Title
├── Mode = "mindmap"            // 预留扩展点
├── SourceType: paste/document/upload
├── SourceRefId?                 // 知识库/附件 id
├── SourceText (≤16K 字)
├── Audience / Style / Depth
├── Theme = "default"
├── Status: draft/generating/ready/failed
├── Model / Platform             // 从 Start chunk 落库
├── NodeCount                    // 冗余，列表展示
├── PublishedSiteId?             // Phase 2
└── CreatedAt / UpdatedAt

SpeechNode (speech_nodes)
├── Id
├── DeckId
├── ParentId?  (root = null)
├── Order / Depth
├── Title / BulletPoints[]
├── SpeakerNotes?                // Phase 2 自动生成
├── ImageAssetId?                // Phase 2 配图
└── Status: pending/generating/ready/failed
```

### 5.2 集合注册

`MongoDbContext.cs`：
```csharp
public IMongoCollection<SpeechDeck> SpeechDecks => _database.GetCollection<SpeechDeck>("speech_decks");
public IMongoCollection<SpeechNode> SpeechNodes => _database.GetCollection<SpeechNode>("speech_nodes");
```

## 六、AppCallerCode 注册

`AppCallerRegistry.cs::SpeechAgent` 块（kebab-case 强制）：
- `speech-agent.mindmap.outline::chat` — 大纲生成（MVP 在用）
- `speech-agent.mindmap.speaker-notes::chat` — 备注生成（Phase 2 在用）

## 七、权限

- `AdminPermissionCatalog.SpeechAgentUse = "speech-agent.use"`
- 加入 admin / viewer / agent_tester 三个内建角色

## 八、前端结构

```
prd-admin/src/pages/speech-agent/
├── SpeechAgentListPage.tsx      // /speech-agent
├── SpeechAgentCreatePage.tsx    // /speech-agent/new
├── SpeechAgentEditorPage.tsx    // /speech-agent/:deckId
├── SpeechMindmapView.tsx        // 按 depth 分列的简易视图
└── index.ts

prd-admin/src/services/
├── contracts/speechAgent.ts     // TypeScript types
└── real/speechAgent.ts          // apiRequest 包装
```

路由通过 `navRegistry.tsx` 三个 entry 注册（`/speech-agent` 带 nav meta、`/new` 和 `/:deckId` 仅注册路由）。

## 九、风险与对策

| 风险 | 对策 |
|---|---|
| LLM 输出非 JSON 卡住 | `ExtractJsonObject` 容错：剥 fenced block + 找 `{...}` 边界 |
| 长文档超 token | `SourceText` 入库前截到 16K 字；Phase 2 加 chunk → 段级 outline → 全局 refine |
| 客户端断开后 LLM 仍在跑 | 已用 `CancellationToken.None` 写 DB；MVP 仅丢前端事件，Phase 2 升级 Run/Worker |
| 节点数膨胀 | MVP 提示词限定深度 2-4 + 一级章节 4-7 个；Phase 2 加节点折叠/虚拟化 |
| 主题色对比度 | 全部用 Tailwind token；编辑器目前以暗色为主，白天主题待 Phase 2 适配 |
