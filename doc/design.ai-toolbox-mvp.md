# AI 百宝箱 MVP 规划

> **目标**: 用最小代价验证核心价值 - "自然语言驱动多 Agent 协同"

---

## 1. MVP 核心原则

```
砍功能，不砍体验
复用现有，不造轮子
端到端跑通，不求完美
```

---

## 2. MVP 范围定义

### 2.1 包含 (In Scope)

| 功能 | 说明 | 复用现有 |
|------|------|----------|
| 统一对话入口 | 一个输入框，接收自然语言 | 复用 AiChatPage 样式 |
| 意图识别 | 识别用户想用哪个 Agent | LLM Gateway |
| Agent 路由 | 根据意图调度对应 Agent | 新建路由逻辑 |
| 单 Agent 执行 | 调用现有 Agent 能力 | 现有 4 个 Agent |
| 双 Agent 串行 | A 的输出作为 B 的输入 | 新建编排逻辑 |
| 执行状态展示 | 显示当前执行到哪一步 | Run/Worker + SSE |
| Markdown 成果 | 输出 Markdown 格式结果 | 现有消息渲染 |

### 2.2 不包含 (Out of Scope for MVP)

| 功能 | 原因 | 后续 Phase |
|------|------|------------|
| 可视化工作流编辑 | 开发量大，非核心验证 | Phase 4 |
| PPT/PDF 生成 | 格式转换复杂 | Phase 3 |
| 插件系统 | 生态建设，优先级低 | Phase 5 |
| 智能体市场 | 需要先有用户创建内容 | Phase 5 |
| 并行 Agent 执行 | 串行已能验证价值 | Phase 2 |
| 自定义 Agent | 先用内置 Agent | Phase 5 |

---

## 3. MVP 架构（极简版）

```
┌─────────────────────────────────────────────────┐
│           AI 百宝箱 MVP                          │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │        前端: ToolboxChatPage              │  │
│  │  [输入框] → [执行状态] → [结果展示]         │  │
│  └───────────────────────────────────────────┘  │
│                      │                          │
│                      ▼                          │
│  ┌───────────────────────────────────────────┐  │
│  │        AiToolboxController                │  │
│  │  POST /api/ai-toolbox/chat                │  │
│  └───────────────────────────────────────────┘  │
│                      │                          │
│                      ▼                          │
│  ┌───────────────────────────────────────────┐  │
│  │        ToolboxService                     │  │
│  │  1. 意图识别 (IntentClassifier)           │  │
│  │  2. 路由分发 (AgentRouter)                │  │
│  │  3. 执行编排 (SimpleOrchestrator)         │  │
│  └───────────────────────────────────────────┘  │
│                      │                          │
│         ┌───────────┼───────────┐              │
│         ▼           ▼           ▼              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │PRD Agent │ │Visual    │ │Literary  │ ...   │
│  │(现有)    │ │Agent     │ │Agent     │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## 4. 分阶段实施计划

### Phase 0: 统一入口 + 意图路由（3-4 天）

**目标**: 用户输入自然语言，系统识别意图并路由到对应 Agent

#### 后端任务

```
□ 创建 AiToolboxController
  - AppKey: "ai-toolbox"
  - Route: /api/ai-toolbox

□ 实现 IntentClassifier
  - 输入: 用户消息
  - 输出: { intent: "prd_analysis" | "image_gen" | "writing" | "defect", confidence }
  - 实现: 调用 LLM Gateway 做分类

□ 实现 AgentRouter
  - 根据 intent 返回应该调用哪个 Agent 的信息

□ 注册 AppCallerCode
  - ai-toolbox.intent::intent
  - ai-toolbox.chat::chat
```

#### 前端任务

```
□ 创建 ToolboxChatPage
  - 路由: /ai-toolbox
  - 复用 AiChatPage 的输入框和消息列表样式

□ 显示意图识别结果
  - "我理解您想要: [PRD分析] → 正在调用 PRD Agent..."
```

#### 验收标准

```
输入: "帮我分析这个PRD有什么问题"
输出: 识别为 prd_analysis，显示将调用 PRD Agent
```

---

### Phase 0.5: 单 Agent 执行验证（2-3 天）

**目标**: 意图识别后，真正调用对应 Agent 并返回结果

#### 后端任务

```
□ 创建 IAgentAdapter 接口
  public interface IAgentAdapter
  {
      string AgentKey { get; }
      Task<AgentResponse> ExecuteAsync(string userMessage, Dictionary<string, object> context, CancellationToken ct);
  }

□ 实现 4 个适配器（封装现有 Agent 调用）
  - PrdAgentAdapter → 调用现有 PRD 相关 Service
  - VisualAgentAdapter → 调用 ImageGenService
  - LiteraryAgentAdapter → 调用 LiteraryAgent 相关 Service
  - DefectAgentAdapter → 调用 DefectAgent Service

□ 创建 ToolboxRunWorker
  - 复用 Run/Worker 模式
  - 执行 Agent 调用，流式返回结果
```

#### 前端任务

```
□ 对接 SSE 流式展示
  - 显示 Agent 执行中的流式输出
  - 显示最终结果
```

#### 验收标准

```
输入: "帮我生成一张夕阳下的猫咪图片"
输出:
  1. 识别意图: image_gen
  2. 调用 Visual Agent
  3. 返回生成的图片
```

---

### Phase 1: 双 Agent 串行协同（3-4 天）

**目标**: 支持 A Agent 输出作为 B Agent 输入的串行执行

#### 后端任务

```
□ 实现 SimpleOrchestrator
  - 分析用户请求是否需要多 Agent
  - 生成简单的执行计划 [Agent1 → Agent2]
  - 串行执行，传递中间结果

□ 扩展意图识别
  - 识别复合意图: "写文章+配图" → [literary, visual]
  - 返回 Agent 序列而非单个 Agent
```

#### 前端任务

```
□ 显示执行计划
  - "执行计划: 1. Literary Agent 写文章 → 2. Visual Agent 生成配图"

□ 显示分步进度
  - ✅ Step 1: 文章已生成
  - ⏳ Step 2: 正在生成配图...
```

#### 验收标准

```
输入: "帮我写一段关于春天的文字，并配一张插图"
输出:
  1. 识别为复合意图 [writing, image_gen]
  2. Step 1: Literary Agent 生成文字
  3. Step 2: Visual Agent 基于文字生成配图
  4. 返回文字 + 图片
```

---

### Phase 1.5: 基础成果展示（2 天）

**目标**: 美化成果展示，支持下载

#### 后端任务

```
□ 统一成果格式
  public class ToolboxArtifact
  {
      public string Type { get; set; }  // "markdown", "image", "code"
      public string Content { get; set; }
      public string Url { get; set; }
      public string FileName { get; set; }
  }
```

#### 前端任务

```
□ 成果卡片组件
  - Markdown 渲染
  - 图片预览
  - 下载按钮

□ 复制/分享功能
```

---

## 5. 技术实现细节

### 5.1 意图识别 Prompt

```
你是一个意图分类器。根据用户输入，判断用户想要执行的任务类型。

可选类型：
- prd_analysis: PRD分析、需求解读、缺口检测
- image_gen: 图片生成、视觉创作、配图
- writing: 写作、文章、文案、文学创作
- defect: 缺陷提交、Bug报告、问题追踪
- composite: 需要多个能力组合（如"写文章+配图"）

用户输入: {user_message}

输出 JSON:
{
  "primary_intent": "类型",
  "secondary_intents": ["如果是composite，列出需要的能力"],
  "confidence": 0.0-1.0,
  "reasoning": "简短解释"
}
```

### 5.2 Controller 代码框架

```csharp
[ApiController]
[Route("api/ai-toolbox")]
[Authorize]
[AdminController("ai-toolbox", AdminPermissionCatalog.ToolboxUse)]
public class AiToolboxController : ControllerBase
{
    private const string AppKey = "ai-toolbox";

    private readonly IIntentClassifier _intentClassifier;
    private readonly IAgentRouter _agentRouter;
    private readonly IToolboxOrchestrator _orchestrator;

    [HttpPost("chat")]
    public async Task<IActionResult> Chat([FromBody] ToolboxChatRequest request, CancellationToken ct)
    {
        // 1. 意图识别
        var intent = await _intentClassifier.ClassifyAsync(request.Message, ct);

        // 2. 路由决策
        var agents = _agentRouter.Route(intent);

        // 3. 创建执行 Run
        var runId = await _orchestrator.CreateRunAsync(request.Message, agents, ct);

        return Ok(new { runId, intent, agents });
    }

    [HttpGet("runs/{runId}/events")]
    public async Task StreamEvents(string runId, [FromQuery] int afterSeq = 0, CancellationToken ct)
    {
        // SSE 流式返回执行事件
        Response.ContentType = "text/event-stream";
        // ...
    }
}
```

### 5.3 数据库集合（MVP）

```
toolbox_runs
├── _id: string
├── userId: string
├── userMessage: string
├── intent: { primary, secondary[], confidence }
├── agents: string[]  // ["literary-agent", "visual-agent"]
├── status: "pending" | "running" | "completed" | "failed"
├── steps: [
│   { agentKey, status, startedAt, completedAt, output }
│ ]
├── artifacts: [
│   { type, content, url, fileName }
│ ]
├── createdAt: datetime
└── completedAt: datetime
```

---

## 6. 文件清单

### 后端新增文件

```
prd-api/src/PrdAgent.Api/
├── Controllers/Api/
│   └── AiToolboxController.cs          # 主 Controller
└── Services/
    └── Toolbox/
        ├── IIntentClassifier.cs        # 意图识别接口
        ├── IntentClassifier.cs         # 意图识别实现
        ├── IAgentRouter.cs             # 路由接口
        ├── AgentRouter.cs              # 路由实现
        ├── IToolboxOrchestrator.cs     # 编排接口
        ├── SimpleOrchestrator.cs       # 简单编排实现
        ├── ToolboxRunWorker.cs         # 后台 Worker
        └── Adapters/
            ├── IAgentAdapter.cs        # Agent 适配器接口
            ├── PrdAgentAdapter.cs
            ├── VisualAgentAdapter.cs
            ├── LiteraryAgentAdapter.cs
            └── DefectAgentAdapter.cs

prd-api/src/PrdAgent.Core/
├── Models/
│   └── Toolbox/
│       ├── ToolboxRun.cs               # Run 模型
│       ├── IntentResult.cs             # 意图结果
│       └── ToolboxArtifact.cs          # 成果物
└── AppCallerRegistry.cs                # 添加 ToolboxAgent 节
```

### 前端新增文件

```
prd-admin/src/
├── pages/
│   └── ai-toolbox/
│       ├── ToolboxChatPage.tsx         # 主页面
│       └── components/
│           ├── ToolboxInput.tsx        # 输入框
│           ├── IntentBadge.tsx         # 意图标签
│           ├── ExecutionPlan.tsx       # 执行计划展示
│           ├── StepProgress.tsx        # 步骤进度
│           └── ArtifactCard.tsx        # 成果卡片
├── services/
│   └── toolboxService.ts               # API 调用
└── stores/
    └── toolboxStore.ts                 # 状态管理
```

---

## 7. 预估工时

| 阶段 | 后端 | 前端 | 总计 |
|------|------|------|------|
| Phase 0: 意图路由 | 2d | 1.5d | 3.5d |
| Phase 0.5: 单 Agent | 2d | 1d | 3d |
| Phase 1: 双 Agent | 2.5d | 1.5d | 4d |
| Phase 1.5: 成果展示 | 0.5d | 1.5d | 2d |
| **总计** | **7d** | **5.5d** | **12.5d** |

---

## 8. 我的建议

### 8.1 第一步先做什么？

**建议从 Phase 0 的后端开始**：

1. **先建 Controller 骨架** - 确定 API 契约
2. **再做意图识别** - 这是整个系统的"大脑"
3. **最后做前端** - 有了后端 API 才能联调

### 8.2 快速验证的捷径

如果想更快看到效果，可以：

```
跳过方案: 先不做 ToolboxRunWorker
替代方案: 直接在 Controller 里同步执行
         等 MVP 验证后再改为 Run/Worker 异步模式

优点: 减少 2 天工作量
缺点: 长任务会阻塞，后续需要重构
```

### 8.3 风险提示

| 风险 | 概率 | 应对 |
|------|------|------|
| 意图识别不准 | 中 | 先用规则兜底，LLM 识别失败时让用户手选 |
| Agent 适配复杂 | 低 | 现有 Agent 已有清晰接口，适配工作量可控 |
| 串行编排状态管理 | 中 | 用简单的状态机，不要过度设计 |

### 8.4 MVP 成功标准

```
✅ 能通过自然语言触发现有 4 个 Agent 中的任意一个
✅ 能执行 "写文章 + 配图" 这样的双 Agent 串行任务
✅ 用户能看到执行进度
✅ 用户能看到最终成果并下载
```

---

## 9. 下一步行动

如果现在开始实施，建议按此顺序：

```
Day 1-2:
  □ 创建 AiToolboxController 骨架
  □ 实现 IntentClassifier（含 Prompt 调试）
  □ 注册 AppCallerCode
  □ 写单元测试验证意图识别

Day 3-4:
  □ 实现 4 个 AgentAdapter
  □ 实现 AgentRouter
  □ 端到端测试单 Agent 调用

Day 5-6:
  □ 创建前端 ToolboxChatPage
  □ 对接后端 API
  □ 实现意图展示和结果渲染

Day 7-8:
  □ 实现 SimpleOrchestrator
  □ 支持双 Agent 串行
  □ 前端执行计划和进度展示

Day 9-10:
  □ 成果展示美化
  □ 端到端测试
  □ Bug 修复和优化
```
