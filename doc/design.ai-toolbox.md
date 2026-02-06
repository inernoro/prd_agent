# AI 百宝箱 (AI Toolbox) 设计方案

> **文档版本**: v1.0
> **创建日期**: 2026-02-03
> **状态**: 规划中

---

## 1. 项目愿景

借鉴蚂蚁百宝箱（Tbox）的设计哲学，构建一个企业级 AI 百宝箱平台，实现：

- **成果即服务（SaaO）**：用户下达自然语言指令，直接获得 PRD 文档、技术方案、数据报告等完整成果
- **多智能体协同**：整合现有 4 个 Agent（PRD/Visual/Literary/Defect），实现"专家团"协作
- **意图驱动交互**：从"人找功能"转变为"AI 懂你"，自动识别意图并调度合适的智能体
- **工作流编排**：支持可视化定义多 Agent 协作流程
- **开放生态**：插件系统 + 智能体市场

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         AI 百宝箱 (AI Toolbox)                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     统一入口层 (Unified Entry)                    │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │   │
│  │  │ 自然语言输入 │  │  快捷指令   │  │  工作流触发  │              │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                   │                                     │
│                                   ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                   智能调度层 (Orchestration)                      │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │   │
│  │  │   意图识别引擎   │  │   任务规划引擎   │  │  动态编排引擎   │  │   │
│  │  │ (Intent Engine) │  │ (Task Planner)  │  │ (Orchestrator)  │  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                   │                                     │
│                                   ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                   专家智能体层 (Expert Agents)                    │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │   │
│  │  │PRD Agent │ │Visual    │ │Literary  │ │Defect    │            │   │
│  │  │(需求分析) │ │Agent     │ │Agent     │ │Agent     │            │   │
│  │  │          │ │(视觉创作) │ │(文学创作) │ │(缺陷管理) │            │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘            │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │   │
│  │  │Report    │ │Code      │ │Data      │ │Document  │            │   │
│  │  │Agent     │ │Agent     │ │Agent     │ │Agent     │ ... (扩展) │   │
│  │  │(报告生成) │ │(代码助手) │ │(数据分析) │ │(文档转换) │            │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                   │                                     │
│                                   ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                   成果生成层 (Artifact Generation)                │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │   │
│  │  │ Markdown│ │   PPT   │ │  网页   │ │  图表   │ │  代码   │   │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                   │                                     │
│                                   ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                   基础设施层 (Infrastructure)                     │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │   │
│  │  │  LLM Gateway  │  │  Run/Worker   │  │  权限系统     │        │   │
│  │  │  (模型调度)    │  │  (任务执行)    │  │  (RBAC)      │        │   │
│  │  └───────────────┘  └───────────────┘  └───────────────┘        │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │   │
│  │  │  插件系统     │  │  海鲜市场     │  │  日志/监控    │        │   │
│  │  │  (Plugins)    │  │  (Marketplace)│  │  (Observability) │     │   │
│  │  └───────────────┘  └───────────────┘  └───────────────┘        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 与现有架构的融合

| 现有组件 | 在百宝箱中的角色 | 扩展方向 |
|----------|------------------|----------|
| LLM Gateway | 底层模型调度 | 新增意图识别专用模型池 |
| Run/Worker | 任务执行引擎 | 新增 `ToolboxRunWorker` 支持多 Agent 协同 |
| 海鲜市场 | 配置共享平台 | 扩展为"智能体市场"，支持 Agent 发布 |
| AppCallerRegistry | 应用标识注册 | 新增 `ai-toolbox.*` 系列 AppCallerCode |
| 4 个现有 Agent | 专家智能体 | 封装为可被调度的"能力单元" |

---

## 3. 核心模块设计

### 3.1 智能调度层

#### 3.1.1 意图识别引擎 (Intent Engine)

**职责**：将用户自然语言转换为结构化的任务描述

```csharp
// 意图识别结果
public class IntentResult
{
    public string PrimaryIntent { get; set; }      // 主意图: "generate_prd", "create_image", "analyze_data"
    public string[] SecondaryIntents { get; set; } // 次要意图
    public Dictionary<string, object> Entities { get; set; } // 实体: { "topic": "用户登录", "style": "简约" }
    public double Confidence { get; set; }         // 置信度
    public string[] SuggestedAgents { get; set; }  // 建议的 Agent 列表
}

// 意图到Agent的映射
public static class IntentAgentMapping
{
    public static readonly Dictionary<string, string[]> Map = new()
    {
        ["generate_prd"] = new[] { "prd-agent" },
        ["create_image"] = new[] { "visual-agent", "literary-agent" },
        ["analyze_defect"] = new[] { "defect-agent" },
        ["write_article"] = new[] { "literary-agent" },
        ["generate_report"] = new[] { "report-agent", "data-agent" },
        ["complex_task"] = new[] { "prd-agent", "visual-agent", "literary-agent" }, // 多Agent协同
    };
}
```

#### 3.1.2 任务规划引擎 (Task Planner)

**职责**：将复杂任务分解为可执行的子任务序列

```csharp
// 任务执行计划
public class ExecutionPlan
{
    public string PlanId { get; set; }
    public string UserRequest { get; set; }        // 原始用户请求
    public List<TaskNode> Tasks { get; set; }      // 任务节点列表
    public Dictionary<string, string> Context { get; set; } // 共享上下文
}

public class TaskNode
{
    public string TaskId { get; set; }
    public string AgentKey { get; set; }           // "prd-agent", "visual-agent" 等
    public string Action { get; set; }             // Agent 内的具体动作
    public Dictionary<string, object> Input { get; set; }
    public string[] DependsOn { get; set; }        // 依赖的前置任务
    public TaskStatus Status { get; set; }
}
```

**任务分解示例**：

用户输入：*"帮我写一篇关于 AI 发展的文章，配上插图，最后生成 PPT"*

```json
{
  "planId": "plan_001",
  "tasks": [
    {
      "taskId": "t1",
      "agentKey": "literary-agent",
      "action": "generate_outline",
      "input": { "topic": "AI发展", "style": "专业" },
      "dependsOn": []
    },
    {
      "taskId": "t2",
      "agentKey": "literary-agent",
      "action": "write_content",
      "input": { "outlineRef": "${t1.output}" },
      "dependsOn": ["t1"]
    },
    {
      "taskId": "t3",
      "agentKey": "visual-agent",
      "action": "generate_illustrations",
      "input": { "contentRef": "${t2.output}", "count": 5 },
      "dependsOn": ["t2"]
    },
    {
      "taskId": "t4",
      "agentKey": "document-agent",
      "action": "generate_ppt",
      "input": { "contentRef": "${t2.output}", "imagesRef": "${t3.output}" },
      "dependsOn": ["t2", "t3"]
    }
  ]
}
```

#### 3.1.3 动态编排引擎 (Orchestrator)

**职责**：根据执行计划调度 Agent 执行，管理任务状态和数据流转

```csharp
public interface IToolboxOrchestrator
{
    // 创建执行计划
    Task<ExecutionPlan> CreatePlanAsync(string userRequest, CancellationToken ct);

    // 执行计划（返回 Run ID，后台异步执行）
    Task<string> ExecutePlanAsync(ExecutionPlan plan, CancellationToken ct);

    // 获取执行状态
    Task<PlanExecutionStatus> GetStatusAsync(string planId, CancellationToken ct);

    // 取消执行
    Task CancelAsync(string planId, CancellationToken ct);
}
```

---

### 3.2 专家智能体层

#### 3.2.1 统一 Agent 接口

所有 Agent 实现统一接口，便于调度层调用：

```csharp
public interface IExpertAgent
{
    // Agent 元信息
    string AgentKey { get; }                      // "prd-agent", "visual-agent" 等
    string DisplayName { get; }                   // "PRD 分析师", "视觉设计师"
    string[] SupportedActions { get; }            // 支持的动作列表
    string[] InputSchemas { get; }                // 输入参数 JSON Schema

    // 能力检查
    bool CanHandle(string action, Dictionary<string, object> input);

    // 执行动作
    Task<AgentResult> ExecuteAsync(
        string action,
        Dictionary<string, object> input,
        Dictionary<string, string> context,
        CancellationToken ct);

    // 流式执行（支持 SSE）
    IAsyncEnumerable<AgentChunk> StreamExecuteAsync(
        string action,
        Dictionary<string, object> input,
        Dictionary<string, string> context,
        CancellationToken ct);
}

public class AgentResult
{
    public bool Success { get; set; }
    public object Output { get; set; }            // 结构化输出
    public string[] ArtifactIds { get; set; }     // 生成的成果物 ID
    public Dictionary<string, object> Metadata { get; set; }
}
```

#### 3.2.2 现有 Agent 适配

将现有 4 个 Agent 封装为 `IExpertAgent` 实现：

| Agent | 适配类 | 支持的 Actions |
|-------|--------|----------------|
| PRD Agent | `PrdExpertAgent` | `analyze_prd`, `generate_questions`, `detect_gaps`, `answer_question` |
| Visual Agent | `VisualExpertAgent` | `text2img`, `img2img`, `compose`, `describe_image` |
| Literary Agent | `LiteraryExpertAgent` | `generate_outline`, `write_content`, `polish`, `generate_illustration` |
| Defect Agent | `DefectExpertAgent` | `extract_defect`, `classify`, `generate_report`, `track_status` |

#### 3.2.3 新增 Agent 规划

| Agent | AppKey | 用途 | 优先级 |
|-------|--------|------|--------|
| **Report Agent** | `report-agent` | 数据报告生成（图表 + 分析文字） | P1 |
| **Document Agent** | `document-agent` | 文档格式转换（Markdown → PPT/Word/PDF） | P1 |
| **Code Agent** | `code-agent` | 代码生成、解释、重构 | P2 |
| **Data Agent** | `data-agent` | 数据分析、可视化 | P2 |
| **Search Agent** | `search-agent` | 信息检索、知识聚合 | P2 |

---

### 3.3 成果生成层

#### 3.3.1 成果物类型

```csharp
public enum ArtifactType
{
    Markdown,           // Markdown 文档
    Html,               // 可交互网页
    Ppt,                // PPT 演示文稿
    Pdf,                // PDF 文档
    Image,              // 图片
    Chart,              // 图表（ECharts/Mermaid）
    Code,               // 代码片段
    DataTable,          // 数据表格
    Audio,              // 音频（播客）
    Video,              // 视频
}

public class Artifact
{
    public string Id { get; set; }
    public ArtifactType Type { get; set; }
    public string Name { get; set; }
    public string MimeType { get; set; }
    public string StorageUrl { get; set; }        // 存储位置
    public string PreviewUrl { get; set; }        // 预览链接
    public Dictionary<string, object> Metadata { get; set; }
    public DateTime CreatedAt { get; set; }
}
```

#### 3.3.2 成果生成器

```csharp
public interface IArtifactGenerator
{
    ArtifactType[] SupportedTypes { get; }

    Task<Artifact> GenerateAsync(
        ArtifactType type,
        object content,
        Dictionary<string, object> options,
        CancellationToken ct);
}

// 实现示例
public class PptGenerator : IArtifactGenerator
{
    public ArtifactType[] SupportedTypes => new[] { ArtifactType.Ppt };

    public async Task<Artifact> GenerateAsync(...)
    {
        // 使用 PPTX 库生成 PowerPoint
        // 1. 解析 Markdown 内容结构
        // 2. 应用模板样式
        // 3. 插入图片
        // 4. 生成并上传文件
    }
}
```

---

### 3.4 工作流编排系统

#### 3.4.1 工作流定义

```csharp
public class Workflow
{
    public string Id { get; set; }
    public string Name { get; set; }
    public string Description { get; set; }
    public string OwnerId { get; set; }
    public bool IsPublic { get; set; }            // 是否发布到市场
    public List<WorkflowNode> Nodes { get; set; }
    public List<WorkflowEdge> Edges { get; set; }
    public Dictionary<string, object> Variables { get; set; } // 全局变量
}

public class WorkflowNode
{
    public string NodeId { get; set; }
    public string NodeType { get; set; }          // "start", "agent", "condition", "loop", "end"
    public string AgentKey { get; set; }          // 当 NodeType=agent 时
    public string Action { get; set; }
    public Dictionary<string, object> Config { get; set; }
    public Position Position { get; set; }        // 画布位置
}

public class WorkflowEdge
{
    public string From { get; set; }
    public string To { get; set; }
    public string Condition { get; set; }         // 条件表达式
}
```

#### 3.4.2 节点类型

| 节点类型 | 说明 | 图标 |
|----------|------|------|
| `start` | 工作流入口 | ▶️ |
| `end` | 工作流结束 | ⏹️ |
| `agent` | Agent 调用节点 | 🤖 |
| `llm` | 直接 LLM 调用 | 🧠 |
| `condition` | 条件分支 | 🔀 |
| `loop` | 循环节点 | 🔄 |
| `parallel` | 并行执行 | ⚡ |
| `human` | 人工审核 | 👤 |
| `code` | 代码执行 | 💻 |
| `plugin` | 插件调用 | 🔌 |

#### 3.4.3 前端可视化编辑器

基于 React Flow 实现拖拽式工作流编辑：

```typescript
// 工作流编辑器组件
const WorkflowEditor: React.FC = () => {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // 节点工具箱
  const nodeToolbox = [
    { type: 'agent', label: 'Agent 节点', agents: agentRegistry },
    { type: 'llm', label: 'LLM 调用' },
    { type: 'condition', label: '条件分支' },
    { type: 'loop', label: '循环' },
    { type: 'plugin', label: '插件' },
  ];

  return (
    <div className="workflow-editor">
      <ToolboxPanel items={nodeToolbox} />
      <ReactFlowCanvas
        nodes={nodes}
        edges={edges}
        onNodesChange={setNodes}
        onEdgesChange={setEdges}
      />
      <PropertyPanel selectedNode={selectedNode} />
    </div>
  );
};
```

---

### 3.5 插件系统

#### 3.5.1 插件接口

```csharp
public interface IToolboxPlugin
{
    string PluginId { get; }
    string DisplayName { get; }
    string Description { get; }
    string[] RequiredPermissions { get; }

    // 插件提供的能力
    PluginCapability[] Capabilities { get; }

    // 执行插件动作
    Task<PluginResult> ExecuteAsync(
        string capability,
        Dictionary<string, object> parameters,
        CancellationToken ct);
}

public class PluginCapability
{
    public string Name { get; set; }              // "search", "send_email", "query_database"
    public string Description { get; set; }
    public JsonSchema InputSchema { get; set; }
    public JsonSchema OutputSchema { get; set; }
}
```

#### 3.5.2 内置插件规划

| 插件 | 功能 | 优先级 |
|------|------|--------|
| **Web Search** | 网络搜索 | P1 |
| **File Reader** | 读取上传的文件（PDF/Word/Excel） | P1 |
| **Database Query** | 查询业务数据库 | P2 |
| **Email Sender** | 发送邮件通知 | P2 |
| **Webhook** | 调用外部 API | P2 |
| **Knowledge Base** | 查询知识库（RAG） | P2 |

#### 3.5.3 MCP 协议支持

参考蚂蚁百宝箱的 MCP 插件生态，支持标准化的插件协议：

```csharp
public interface IMcpPlugin : IToolboxPlugin
{
    // MCP 标准接口
    Task<McpCapabilities> GetCapabilitiesAsync();
    Task<McpResponse> InvokeAsync(McpRequest request);
}
```

---

### 3.6 智能体市场

扩展现有海鲜市场，支持用户创建的 Agent/工作流发布：

#### 3.6.1 市场条目类型

```typescript
// 扩展 CONFIG_TYPE_REGISTRY
export const CONFIG_TYPE_REGISTRY: Record<string, ConfigTypeDefinition<any>> = {
  // 现有类型
  prompt: { /* ... */ },
  refImage: { /* ... */ },
  watermark: { /* ... */ },

  // 新增类型
  workflow: {
    key: 'workflow',
    label: '工作流',
    icon: Workflow,
    color: { bg: 'rgba(168, 85, 247, 0.12)', ... },
    api: {
      listMarketplace: listWorkflowsMarketplace,
      publish: publishWorkflow,
      fork: forkWorkflow,
    },
    getDisplayName: (item) => item.name,
    PreviewRenderer: WorkflowPreviewRenderer,
  },

  customAgent: {
    key: 'customAgent',
    label: '自定义智能体',
    icon: Bot,
    color: { bg: 'rgba(34, 197, 94, 0.12)', ... },
    api: { /* ... */ },
    getDisplayName: (item) => item.name,
    PreviewRenderer: AgentPreviewRenderer,
  },
};
```

#### 3.6.2 IForkable 实现

```csharp
public class Workflow : IForkable
{
    // 业务字段
    public string Id { get; set; }
    public string Name { get; set; }
    public string Description { get; set; }
    public List<WorkflowNode> Nodes { get; set; }
    public List<WorkflowEdge> Edges { get; set; }

    // IMarketplaceItem 字段
    public string OwnerId { get; set; }
    public bool IsPublic { get; set; }
    public int ForkCount { get; set; }
    public string ForkedFromId { get; set; }
    // ...

    public string[] GetCopyableFields() => new[]
    {
        "Name", "Description", "Nodes", "Edges"
    };

    public void OnForked()
    {
        Name = $"{Name} (副本)";
        // 重置节点 ID，避免冲突
        foreach (var node in Nodes)
            node.NodeId = Guid.NewGuid().ToString("N")[..8];
    }
}
```

---

## 4. API 设计

### 4.1 统一入口 API

```
POST /api/ai-toolbox/chat
Content-Type: application/json

{
  "message": "帮我写一篇关于 AI 发展的文章，配上插图",
  "sessionId": "optional-session-id",
  "options": {
    "autoExecute": true,      // 自动执行还是仅返回计划
    "preferredAgents": [],    // 优先使用的 Agent
    "outputFormats": ["markdown", "ppt"]  // 期望的输出格式
  }
}

Response:
{
  "success": true,
  "data": {
    "runId": "run_abc123",
    "plan": { /* ExecutionPlan */ },
    "sseUrl": "/api/ai-toolbox/runs/run_abc123/events"
  }
}
```

### 4.2 执行状态 API

```
GET /api/ai-toolbox/runs/{runId}/status

Response:
{
  "runId": "run_abc123",
  "status": "running",
  "progress": 0.65,
  "currentTask": {
    "taskId": "t3",
    "agentKey": "visual-agent",
    "action": "generate_illustrations"
  },
  "completedTasks": ["t1", "t2"],
  "artifacts": [
    { "id": "art_001", "type": "markdown", "name": "文章草稿.md" }
  ]
}
```

### 4.3 工作流 API

```
# 创建工作流
POST /api/ai-toolbox/workflows

# 执行工作流
POST /api/ai-toolbox/workflows/{workflowId}/runs

# 工作流市场
GET /api/ai-toolbox/workflows/marketplace
POST /api/ai-toolbox/workflows/{id}/publish
POST /api/ai-toolbox/workflows/{id}/fork
```

### 4.4 AppCallerCode 规划

```csharp
public static class ToolboxAgent
{
    // 核心调度
    public const string IntentRecognition = "ai-toolbox.orchestration::intent";
    public const string TaskPlanning = "ai-toolbox.orchestration::chat";
    public const string Orchestration = "ai-toolbox.orchestration::chat";

    // 成果生成
    public const string GeneratePpt = "ai-toolbox.artifact.ppt::generation";
    public const string GeneratePdf = "ai-toolbox.artifact.pdf::generation";
    public const string GenerateChart = "ai-toolbox.artifact.chart::generation";

    // 工作流执行
    public const string WorkflowExecution = "ai-toolbox.workflow::chat";
}
```

---

## 5. 数据模型

### 5.1 MongoDB 集合规划

| 集合名 | 用途 |
|--------|------|
| `toolbox_sessions` | 百宝箱会话 |
| `toolbox_runs` | 执行记录 |
| `toolbox_plans` | 执行计划 |
| `toolbox_artifacts` | 生成的成果物 |
| `toolbox_workflows` | 工作流定义 |
| `toolbox_workflow_runs` | 工作流执行记录 |
| `toolbox_plugins` | 插件配置 |
| `toolbox_custom_agents` | 用户自定义 Agent |

### 5.2 核心模型

```csharp
// 百宝箱会话
public class ToolboxSession
{
    public string Id { get; set; }
    public string UserId { get; set; }
    public string Title { get; set; }
    public List<ToolboxMessage> Messages { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

// 执行 Run
public class ToolboxRun
{
    public string Id { get; set; }
    public string SessionId { get; set; }
    public string UserRequest { get; set; }
    public ExecutionPlan Plan { get; set; }
    public RunStatus Status { get; set; }
    public List<string> ArtifactIds { get; set; }
    public Dictionary<string, object> Context { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}
```

---

## 6. 前端页面规划

### 6.1 页面结构

```
prd-admin/src/pages/
├── ai-toolbox/
│   ├── ToolboxChatPage.tsx       # 主对话界面（统一入口）
│   ├── ToolboxWorkflowPage.tsx   # 工作流编辑器
│   ├── ToolboxMarketPage.tsx     # 智能体/工作流市场
│   ├── ToolboxHistoryPage.tsx    # 执行历史
│   └── components/
│       ├── ChatInput.tsx         # 智能输入框（支持快捷指令）
│       ├── PlanPreview.tsx       # 执行计划预览
│       ├── ArtifactViewer.tsx    # 成果物预览
│       ├── WorkflowCanvas.tsx    # 工作流画布
│       └── AgentSelector.tsx     # Agent 选择器
```

### 6.2 主界面设计

```
┌────────────────────────────────────────────────────────────────┐
│  🧰 AI 百宝箱                              [历史] [市场] [设置]  │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │        欢迎使用 AI 百宝箱                                 │  │
│  │        告诉我你想做什么，我来帮你完成                      │  │
│  │                                                          │  │
│  │   快捷指令：                                              │  │
│  │   [📝 写文章] [🖼️ 生成图片] [📊 数据分析] [📄 生成报告]    │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  💬 帮我写一篇关于 AI 发展的文章，配上插图，生成 PPT       │  │
│  │                                              [发送 ➤]     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  执行计划                                          [执行] [编辑]│
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ✅ 1. 生成文章大纲 (Literary Agent)                      │  │
│  │  ⏳ 2. 撰写文章内容 (Literary Agent)          进行中 65%  │  │
│  │  ⏸️ 3. 生成配图 (Visual Agent)                 等待中      │  │
│  │  ⏸️ 4. 生成 PPT (Document Agent)              等待中      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  生成的成果                                                    │
│  ┌────────────┐ ┌────────────┐                                │
│  │ 📄          │ │ 🖼️          │                                │
│  │ AI发展.md  │ │ 插图1.png  │  ...                            │
│  │ [预览][下载]│ │ [预览][下载]│                                │
│  └────────────┘ └────────────┘                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 7. 实施路线图

### Phase 1: 基础框架 (4 周)

- [ ] **后端**
  - [ ] 创建 `AiToolboxController` (AppKey: `ai-toolbox`)
  - [ ] 实现 `IExpertAgent` 接口
  - [ ] 适配现有 4 个 Agent
  - [ ] 实现基础意图识别
  - [ ] 创建 `ToolboxRunWorker`

- [ ] **前端**
  - [ ] 创建 `ToolboxChatPage` 主界面
  - [ ] 实现执行计划展示
  - [ ] 实现成果物预览

- [ ] **数据库**
  - [ ] 创建 `toolbox_*` 系列集合
  - [ ] 注册 AppCallerCode

### Phase 2: 多 Agent 协同 (4 周)

- [ ] **后端**
  - [ ] 实现任务规划引擎
  - [ ] 实现动态编排引擎
  - [ ] 支持 Agent 间数据传递
  - [ ] 实现并行执行

- [ ] **前端**
  - [ ] 优化执行进度展示
  - [ ] 添加任务依赖可视化

### Phase 3: 成果生成 (3 周)

- [ ] **后端**
  - [ ] 实现 PPT 生成器
  - [ ] 实现 PDF 生成器
  - [ ] 实现图表生成器

- [ ] **前端**
  - [ ] 成果物在线预览
  - [ ] 成果物下载/分享

### Phase 4: 工作流编排 (4 周)

- [ ] **后端**
  - [ ] 工作流 CRUD API
  - [ ] 工作流执行引擎
  - [ ] 条件/循环节点支持

- [ ] **前端**
  - [ ] 基于 React Flow 的画布编辑器
  - [ ] 节点属性配置面板
  - [ ] 工作流调试器

### Phase 5: 生态建设 (4 周)

- [ ] **后端**
  - [ ] 插件系统框架
  - [ ] 内置插件实现
  - [ ] 智能体市场 API

- [ ] **前端**
  - [ ] 智能体/工作流市场页面
  - [ ] 插件管理界面

---

## 8. 与现有系统的集成

### 8.1 权限集成

```csharp
public static class AdminPermissionCatalog
{
    // 新增权限
    public const string ToolboxUse = "ai-toolbox:use";
    public const string ToolboxManageWorkflow = "ai-toolbox:manage-workflow";
    public const string ToolboxPublish = "ai-toolbox:publish";
    public const string ToolboxAdmin = "ai-toolbox:admin";
}
```

### 8.2 LLM Gateway 集成

所有 Agent 调用通过 Gateway：

```csharp
public class VisualExpertAgent : IExpertAgent
{
    private readonly ILlmGateway _gateway;

    public async Task<AgentResult> ExecuteAsync(...)
    {
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ToolboxAgent.VisualGeneration,
            ModelType = ModelTypes.ImageGen,
            // ...
        };

        var response = await _gateway.SendAsync(request, ct);
        // ...
    }
}
```

### 8.3 海鲜市场集成

工作流和自定义 Agent 复用现有 `IForkable` + `ForkService` 机制。

---

## 9. 技术选型

| 组件 | 技术选型 | 说明 |
|------|----------|------|
| 工作流画布 | React Flow | 成熟的 React 流程图库 |
| PPT 生成 | PptxGenJS / python-pptx | 服务端生成 |
| PDF 生成 | Puppeteer / wkhtmltopdf | HTML → PDF |
| 图表生成 | ECharts / Mermaid | 支持多种图表类型 |
| 状态机 | Stateless (.NET) | 工作流状态管理 |
| 任务队列 | 现有 Run/Worker | 复用现有架构 |

---

## 10. 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|----------|
| Agent 协同复杂度高 | 任务失败率上升 | 先支持简单串行，逐步增加并行/条件 |
| 意图识别准确率不足 | 用户体验差 | 提供计划编辑功能，支持手动调整 |
| 成果物格式多样 | 开发量大 | 优先支持 Markdown/PPT，逐步扩展 |
| 工作流编辑器复杂 | 用户学习成本高 | 提供模板库，支持从对话自动生成 |

---

## 11. 成功指标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 意图识别准确率 | > 85% | 首次识别正确的比例 |
| 任务完成率 | > 90% | 成功执行完成的任务比例 |
| 平均执行时间 | < 2 分钟 | 简单任务的端到端时间 |
| 用户满意度 | > 4.0/5.0 | 成果物质量评分 |
| 工作流复用率 | > 30% | 使用已有工作流的比例 |

---

## 12. 附录

### 12.1 参考资料

- [蚂蚁百宝箱 Tbox 介绍](https://finance.sina.com.cn/tech/2025-09-11/doc-infqcinm3783182.shtml)
- [华为云社区：蚂蚁百宝箱实践](https://bbs.huaweicloud.com/blogs/456270)
- [阿里云：TBox Agent SDK 指南](https://developer.aliyun.com/article/1686834)

### 12.2 术语表

| 术语 | 定义 |
|------|------|
| SaaO | Software as an Outcome，成果即服务 |
| Expert Agent | 专家智能体，具备特定领域能力的 AI 模块 |
| Orchestrator | 编排器，负责调度多个 Agent 协同工作 |
| Artifact | 成果物，Agent 生成的最终产出（文档、图片等） |
| Workflow | 工作流，预定义的 Agent 协作流程 |
