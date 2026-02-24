# 工作流引擎 (Workflow Engine) 设计方案

> **文档版本**: v1.0
> **创建日期**: 2026-02-12
> **状态**: 规划中
> **appKey**: `workflow-agent`

---

## 1. 项目背景与目标

### 1.1 背景

团队每月需从 TAPD 等项目管理平台拉取数据，手动汇总生成质量会议总结文档。此过程涉及：数据采集 → 不规则数据清洗 → 统计分析 → 报告渲染，流程重复且耗时。

### 1.2 目标

构建**通用工作流引擎**，支持用户通过可视化编排将多个处理节点串联成自动化管线，定时或手动触发，端到端完成从数据采集到报告生成的全流程。

### 1.3 核心价值

| 维度 | 价值 |
|------|------|
| **通用性** | 不绑定 TAPD，支持任意数据源采集 + LLM 分析 + 代码统计 + 多格式渲染 |
| **可编排** | 节点可自由组合，支持从中间节点重跑 |
| **全自动** | 定时触发、自动执行、自动通知，无需人工干预 |
| **可追溯** | 每次执行保留完整历史（输入、中间产物、最终报告） |
| **可分享** | 产出物支持云链接分享（公开 / 需登录） |

---

## 2. 系统架构

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     工作流引擎 (Workflow Engine)                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    触发层 (Trigger Layer)                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │  │
│  │  │ Cron定时  │  │ 手动触发  │  │ Webhook  │  │ 事件驱动  │   │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                               │                                    │
│                               ▼                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                   编排层 (Orchestration Layer)               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │  │
│  │  │ 工作流解析器  │  │ 节点调度引擎  │  │ 制品路由器    │      │  │
│  │  │ (DAG Parser) │  │ (Scheduler)  │  │ (ArtifactBus)│      │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                               │                                    │
│                               ▼                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    节点层 (Node Layer)                       │  │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐  │  │
│  │  │ 数据采集   │ │ 脚本执行   │ │ LLM 分析  │ │ 代码统计   │  │  │
│  │  │ Collector │ │ Script    │ │ Analyzer  │ │ CodeExec   │  │  │
│  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘  │  │
│  │  ┌───────────┐ ┌───────────┐                               │  │
│  │  │ 渲染输出   │ │ 自定义节点 │                               │  │
│  │  │ Renderer  │ │ (扩展)    │                               │  │
│  │  └───────────┘ └───────────┘                               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                               │                                    │
│                               ▼                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                   产物层 (Artifact Layer)                    │  │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐               │  │
│  │  │ COS 存储   │  │ 分享链接   │  │ 通知分发   │               │  │
│  │  └───────────┘  └───────────┘  └───────────┘               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 基础设施 (Infrastructure)                    │  │
│  │  LLM Gateway │ Run/Worker │ Docker │ Automation │ RBAC     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 与现有系统的融合关系

| 现有系统 | 融合方式 |
|----------|----------|
| **Toolbox Run/Worker** | 工作流执行复用 Run/Worker 模式，新增 `RunKind = "workflow"` |
| **IToolboxEventStore** | 工作流节点事件复用 Redis 事件存储 + SSE 推送 |
| **LLM Gateway** | LLM 分析节点通过 Gateway 调用，注册 `workflow-agent.*` AppCallerCode |
| **Automation Hub** | 扩展 Cron 触发类型，定时触发工作流 |
| **COS 存储** | 产物隔离存储，新增 domain `workflow-agent` |
| **Admin 通知** | 执行完成/失败通知推送 |
| **Email 通道** | 可选：报告完成后邮件发送 |
| **开放平台** | 可选：通过 API 触发工作流执行 |
| **海鲜市场** | 工作流模板可发布到市场，支持 Fork |

---

## 3. 核心概念

### 3.1 概念模型

```
Workflow (工作流定义)
  ├── Nodes[] (节点定义数组)
  │   ├── Node A: 数据采集
  │   ├── Node B: LLM 分析
  │   ├── Node C: 代码统计
  │   └── Node D: 渲染输出
  ├── Edges[] (节点连线)
  │   ├── A → B
  │   ├── B → C
  │   └── C → D
  └── Triggers[] (触发方式)
      ├── cron: "0 9 1 * *" (每月1号9点)
      └── manual

WorkflowExecution (一次执行实例)
  ├── 关联 Workflow 定义
  ├── NodeExecutions[] (各节点执行记录)
  │   ├── NodeExec A: { status, artifacts[], logs }
  │   ├── NodeExec B: { status, artifacts[], logs }
  │   └── ...
  └── FinalArtifacts[] (最终产物)
```

### 3.2 核心术语

| 术语 | 说明 |
|------|------|
| **Workflow** | 工作流定义，包含节点 DAG 图 + 触发配置 |
| **Node** | 工作流中的单个处理节点，有明确的类型、输入、输出 |
| **Edge** | 节点间连线，定义数据流向 |
| **Artifact** | 节点产物（文本、JSON、图片、HTML 等） |
| **Execution** | 一次工作流执行实例，保留完整快照 |
| **ArtifactSlot** | 节点的输入/输出槽位定义 |

---

## 4. 节点类型设计

### 4.1 节点类型总览

| 类型 Key | 名称 | 输入 | 输出 | 执行环境 |
|----------|------|------|------|----------|
| `data-collector` | 数据采集 | 配置参数 | 原始数据文件 | 内置服务 |
| `script-executor` | 脚本执行 | 脚本包 + 参数 | 制品文件 | Docker 容器 |
| `llm-analyzer` | LLM 分析 | 上游产物 + 系统提示词 | 结构化文本/表格 | LLM Gateway |
| `llm-code-executor` | LLM 生成代码并执行 | 上游产物 + 指令 | 执行结果 | LLM + Docker |
| `renderer` | 渲染输出 | 上游产物 + 模板 | md / html / pdf | 内置服务 |

### 4.2 数据采集节点 (`data-collector`)

**用途**：从外部系统拉取数据。内置常用采集器，开箱即用。

```
┌──────────────────────────────────────┐
│         数据采集节点 (data-collector)  │
│                                      │
│  采集器类型 (collectorType):          │
│  ┌──────────┐ ┌──────────┐           │
│  │  TAPD    │ │  HTTP    │           │
│  │  (内置)   │ │  (通用)   │           │
│  └──────────┘ └──────────┘           │
│  ┌──────────┐ ┌──────────┐           │
│  │  数据库   │ │  自定义   │           │
│  │  (扩展)   │ │  (扩展)   │           │
│  └──────────┘ └──────────┘           │
│                                      │
│  输出 → artifacts[]                   │
│  ┌─────────────────────────────────┐ │
│  │ { type: "json", name: "bugs" } │ │
│  │ { type: "json", name: "stories"│ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

**内置采集器：TAPD**

```json
{
  "nodeType": "data-collector",
  "config": {
    "collectorType": "tapd",
    "tapd": {
      "apiUrl": "https://api.tapd.cn",
      "workspaceId": "{{secrets.TAPD_WORKSPACE_ID}}",
      "apiUser": "{{secrets.TAPD_API_USER}}",
      "apiPassword": "{{secrets.TAPD_API_PASSWORD}}",
      "resources": ["bugs", "stories", "iterations"],
      "dateRange": {
        "type": "relative",
        "value": "-30d"
      },
      "filters": {
        "status": ["new", "in_progress", "resolved", "closed"]
      }
    }
  }
}
```

**内置采集器：通用 HTTP**

```json
{
  "nodeType": "data-collector",
  "config": {
    "collectorType": "http",
    "http": {
      "method": "GET",
      "url": "https://api.example.com/data",
      "headers": {
        "Authorization": "Bearer {{secrets.API_TOKEN}}"
      },
      "pagination": {
        "type": "page",
        "pageParam": "page",
        "sizeParam": "limit",
        "maxPages": 10
      }
    }
  }
}
```

### 4.3 脚本执行节点 (`script-executor`)

**用途**：在 Docker 隔离环境中运行用户上传的脚本，用于处理复杂的数据采集或转换逻辑。

```
┌───────────────────────────────────────────────┐
│          脚本执行节点 (script-executor)          │
│                                               │
│  执行流程：                                    │
│  1. 拉取/使用缓存镜像                          │
│  2. 挂载输入制品到 /input/                     │
│  3. 挂载输出目录 /output/                      │
│  4. 运行入口脚本                               │
│  5. 收集 /output/ 下的所有文件作为产物          │
│  6. 销毁容器                                   │
│                                               │
│  安全约束：                                    │
│  - 无网络（可配置允许）                         │
│  - CPU/内存限制                                │
│  - 最大执行时间                                │
│  - 只读输入，写出仅到 /output/                 │
└───────────────────────────────────────────────┘
```

**配置示例**

```json
{
  "nodeType": "script-executor",
  "config": {
    "runtime": {
      "image": "python:3.11-slim",
      "entrypoint": "main.py",
      "args": ["--month", "{{vars.TARGET_MONTH}}"],
      "envVars": {
        "TAPD_TOKEN": "{{secrets.TAPD_TOKEN}}"
      }
    },
    "resources": {
      "cpuLimit": "1",
      "memoryLimit": "512m",
      "timeoutSeconds": 300,
      "networkEnabled": true
    },
    "scriptPackage": {
      "type": "upload",
      "attachmentId": "abc123"
    },
    "outputCollect": {
      "directory": "/output",
      "patterns": ["*.json", "*.csv", "*.md"]
    }
  }
}
```

**Docker 执行方案（Docker Socket 映射）**

由于当前部署环境为 docker-compose，通过映射 Docker Socket 实现容器管理：

```yaml
# docker-compose.yml 中追加挂载
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

```csharp
// 后端通过 Docker.DotNet SDK 管理容器生命周期
public class DockerScriptRunner : IScriptRunner
{
    private readonly DockerClient _docker;

    public async Task<ScriptResult> RunAsync(ScriptExecutionRequest request, CancellationToken ct)
    {
        // 1. 准备输入目录（上游产物）
        var inputDir = PrepareInputDirectory(request.InputArtifacts);

        // 2. 准备输出目录
        var outputDir = CreateTempOutputDirectory();

        // 3. 解压脚本包到工作目录
        var workDir = ExtractScriptPackage(request.ScriptPackageBytes);

        // 4. 创建并启动容器
        var container = await _docker.Containers.CreateContainerAsync(new CreateContainerParameters
        {
            Image = request.Image,  // e.g., "python:3.11-slim"
            Cmd = new[] { request.Entrypoint, ..request.Args },
            HostConfig = new HostConfig
            {
                Binds = new[]
                {
                    $"{inputDir}:/input:ro",     // 只读输入
                    $"{outputDir}:/output:rw",   // 可写输出
                    $"{workDir}:/workspace:ro"   // 脚本包
                },
                Memory = ParseMemory(request.MemoryLimit),     // 内存限制
                NanoCPUs = ParseCpu(request.CpuLimit),         // CPU 限制
                NetworkMode = request.NetworkEnabled ? "bridge" : "none"
            },
            WorkingDir = "/workspace",
            Env = request.EnvVars.Select(kv => $"{kv.Key}={kv.Value}").ToList()
        }, ct);

        await _docker.Containers.StartContainerAsync(container.ID, null, ct);

        // 5. 等待完成（带超时）
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(request.TimeoutSeconds));
        var waitResult = await _docker.Containers.WaitContainerAsync(container.ID, cts.Token);

        // 6. 收集日志
        var logs = await GetContainerLogsAsync(container.ID);

        // 7. 收集输出产物
        var artifacts = await CollectOutputArtifactsAsync(outputDir, request.OutputPatterns);

        // 8. 清理容器
        await _docker.Containers.RemoveContainerAsync(container.ID, new() { Force = true });

        return new ScriptResult
        {
            ExitCode = waitResult.StatusCode,
            Logs = logs,
            Artifacts = artifacts
        };
    }
}
```

### 4.4 LLM 分析节点 (`llm-analyzer`)

**用途**：将上游产物（任意格式文本）配合系统提示词送入大模型，输出结构化分析结果。

**设计策略**：根据数据量自适应选择方案：

```
数据量 < 50KB  → 直接全量送入 LLM，structured output 返回 JSON
数据量 50KB-500KB → 分片处理，每片独立分析，最后合并
数据量 > 500KB → LLM 生成提取代码 → 代码执行 → 结果校验
```

**配置示例**

```json
{
  "nodeType": "llm-analyzer",
  "config": {
    "systemPrompt": "你是一名数据分析专家。请分析以下 TAPD bug 数据...",
    "outputFormat": "json",
    "outputSchema": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "bugId": { "type": "string" },
          "module": { "type": "string" },
          "severity": { "type": "string" },
          "resolveTimeHours": { "type": "number" },
          "rootCause": { "type": "string" }
        }
      }
    },
    "inputMapping": {
      "mode": "inject",
      "template": "以下是本月的 Bug 数据（JSON 格式）：\n\n```json\n{{artifacts.bugs}}\n```\n\n请按以下规范提取结构化明细表..."
    },
    "retry": {
      "maxAttempts": 2,
      "validateOutput": true
    }
  }
}
```

**输入注入方式**

上游产物通过模板变量注入到 LLM 的用户消息中：

```
{{artifacts.<artifactName>}}     → 注入指定产物的文本内容
{{artifacts.<artifactName>.url}} → 注入产物的 COS URL（用于图片）
{{artifacts.*}}                  → 注入所有上游产物（按名称分段）
```

### 4.5 LLM 代码执行节点 (`llm-code-executor`)

**用途**：让 LLM 根据数据和指令生成统计代码，在 Docker 中执行代码，返回精确统计结果。适用于需要数值精确性的统计场景。

**执行流程**

```
┌─────────┐    ┌─────────┐    ┌──────────┐    ┌─────────┐
│ 上游产物 │ ──→│ LLM 生成 │ ──→│ Docker   │ ──→│ 收集结果 │
│ + 指令   │    │ 统计代码  │    │ 执行代码  │    │ (JSON)  │
└─────────┘    └─────────┘    └──────────┘    └─────────┘
                    │                              │
                    └──── 校验失败时重试 ────────────┘
```

**配置示例**

```json
{
  "nodeType": "llm-code-executor",
  "config": {
    "instruction": "请根据以下结构化 Bug 明细数据，编写 Python 脚本进行统计分析...",
    "codeLanguage": "python",
    "codeImage": "python:3.11-slim",
    "installDeps": ["pandas"],
    "maxRetries": 3,
    "validation": {
      "expectOutputFile": "/output/stats.json",
      "jsonSchema": {
        "type": "object",
        "required": ["totalBugs", "bySeverity", "byModule"]
      }
    }
  }
}
```

**执行细节**

```csharp
public class LlmCodeExecutorNodeHandler : INodeHandler
{
    public async IAsyncEnumerable<NodeEvent> ExecuteAsync(NodeExecutionContext ctx, CancellationToken ct)
    {
        var inputData = ctx.GetUpstreamArtifactsAsText();

        for (int attempt = 0; attempt < ctx.Config.MaxRetries; attempt++)
        {
            // 1. LLM 生成代码
            yield return NodeEvent.Progress($"正在生成统计代码 (第 {attempt + 1} 次)...");

            var codePrompt = $"""
                {ctx.Config.Instruction}

                输入数据：
                ```json
                {inputData}
                ```

                要求：
                - 读取 /input/data.json
                - 输出结果到 /output/stats.json
                - 仅使用标准库 + {string.Join(",", ctx.Config.InstallDeps)}
                """;

            var code = await _gateway.SendAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.WorkflowAgent.CodeGen.Chat,
                ModelType = "chat",
                RequestBody = BuildMessages(codePrompt)
            }, CancellationToken.None);

            var extractedCode = ExtractCodeBlock(code.Content);

            // 2. Docker 容器执行
            yield return NodeEvent.Progress("正在执行统计代码...");

            var result = await _scriptRunner.RunAsync(new ScriptExecutionRequest
            {
                Image = ctx.Config.CodeImage,
                EntrypointCode = extractedCode,
                InputArtifacts = ctx.InputArtifacts,
                TimeoutSeconds = 60,
                NetworkEnabled = false
            }, CancellationToken.None);

            // 3. 校验结果
            if (result.ExitCode == 0 && ValidateOutput(result, ctx.Config.Validation))
            {
                yield return NodeEvent.Artifact(result.Artifacts);
                yield return NodeEvent.Completed();
                yield break;
            }

            // 失败，反馈错误给 LLM 重试
            yield return NodeEvent.Progress($"执行失败 (exit={result.ExitCode})，重试中...");
            inputData += $"\n\n上次代码执行失败，错误信息：\n{result.Logs}\n请修复代码。";
        }

        yield return NodeEvent.Failed("代码生成与执行达到最大重试次数");
    }
}
```

### 4.6 渲染输出节点 (`renderer`)

**用途**：将统计数据/分析结果渲染为最终可分享的报告。

**支持格式**

| 格式 | 方案 | 下载 | 云链接分享 |
|------|------|------|-----------|
| Markdown | 模板引擎渲染 | Y | Y (在线预览) |
| HTML | LLM 生成 + 模板 | Y | Y (静态托管) |
| PDF | Puppeteer / wkhtmltopdf (HTML → PDF) | Y | Y |

**配置示例**

```json
{
  "nodeType": "renderer",
  "config": {
    "outputFormats": ["html", "md", "pdf"],
    "template": {
      "type": "llm-generate",
      "systemPrompt": "你是一名数据可视化专家。根据以下统计数据，生成一个精美的 HTML 报告页面...",
      "styleHints": "使用现代化设计，包含图表（ECharts CDN），配色专业"
    },
    "sharing": {
      "enabled": true,
      "accessLevel": "public",
      "expiresIn": "30d"
    }
  }
}
```

**HTML 报告云链接分享**

```
生成 HTML → 上传 COS → 创建 ShareLink 记录 → 返回短链接

短链接格式: https://{domain}/s/{shareToken}
```

---

## 5. 数据模型

### 5.1 MongoDB 新增集合

| 集合名 | 用途 |
|--------|------|
| `workflows` | 工作流定义 |
| `workflow_executions` | 执行实例 |
| `workflow_secrets` | 加密存储的凭证（API Key 等） |
| `workflow_schedules` | 定时调度配置 |
| `share_links` | 分享链接管理 |

### 5.2 Workflow（工作流定义）

```csharp
public class Workflow : IForkable
{
    // 基础信息
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Icon { get; set; }              // lucide-react 图标名
    public List<string> Tags { get; set; } = new();

    // DAG 定义
    public List<WorkflowNode> Nodes { get; set; } = new();
    public List<WorkflowEdge> Edges { get; set; } = new();

    // 变量定义（用户填写的运行时参数）
    public List<WorkflowVariable> Variables { get; set; } = new();

    // 触发配置
    public List<WorkflowTrigger> Triggers { get; set; } = new();

    // 状态
    public bool IsEnabled { get; set; } = true;
    public DateTime? LastExecutedAt { get; set; }
    public long ExecutionCount { get; set; }

    // 所有权
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // IForkable（海鲜市场发布）
    public string? OwnerUserId { get; set; }
    public bool IsPublic { get; set; }
    public int ForkCount { get; set; }
    public string? ForkedFromId { get; set; }
    public string? ForkedFromOwnerName { get; set; }
    public string? ForkedFromOwnerAvatar { get; set; }

    public string[] GetCopyableFields() => new[]
    {
        "Name", "Description", "Icon", "Tags",
        "Nodes", "Edges", "Variables", "Triggers"
    };

    public string GetConfigType() => "workflow";
    public string GetDisplayName() => Name;
    public string? GetOwnerUserId() => OwnerUserId;
    public void SetOwnerUserId(string userId) => OwnerUserId = userId;

    public void OnForked()
    {
        Name = $"{Name} (副本)";
        IsEnabled = false;               // Fork 后默认禁用，需用户配置凭证后启用
        Triggers = new List<WorkflowTrigger>();  // 清空触发器，防止误触发
        LastExecutedAt = null;
        ExecutionCount = 0;
    }
}
```

### 5.3 WorkflowNode（节点定义）

```csharp
public class WorkflowNode
{
    public string NodeId { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Name { get; set; } = string.Empty;
    public string NodeType { get; set; } = string.Empty;   // data-collector, script-executor, llm-analyzer, llm-code-executor, renderer

    // 节点特定配置（JSON 对象，根据 NodeType 不同结构不同）
    public BsonDocument Config { get; set; } = new();

    // 输入槽位定义
    public List<ArtifactSlot> InputSlots { get; set; } = new();

    // 输出槽位定义
    public List<ArtifactSlot> OutputSlots { get; set; } = new();

    // 可视化位置（前端画布坐标）
    public NodePosition? Position { get; set; }

    // 重试策略
    public RetryPolicy? Retry { get; set; }
}

public class ArtifactSlot
{
    public string SlotId { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Name { get; set; } = string.Empty;           // 槽位名称 (e.g., "bugs", "stats")
    public string DataType { get; set; } = "text";            // text, json, image, binary
    public bool Required { get; set; } = true;
    public string? Description { get; set; }
}

public class NodePosition
{
    public double X { get; set; }
    public double Y { get; set; }
}

public class RetryPolicy
{
    public int MaxAttempts { get; set; } = 1;
    public int DelaySeconds { get; set; } = 5;
}
```

### 5.4 WorkflowEdge（连线）

```csharp
public class WorkflowEdge
{
    public string EdgeId { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string SourceNodeId { get; set; } = string.Empty;
    public string SourceSlotId { get; set; } = string.Empty;   // 源节点的输出槽位
    public string TargetNodeId { get; set; } = string.Empty;
    public string TargetSlotId { get; set; } = string.Empty;   // 目标节点的输入槽位
}
```

### 5.5 WorkflowTrigger（触发方式）

```csharp
public class WorkflowTrigger
{
    public string TriggerId { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Type { get; set; } = "manual";    // manual, cron, webhook, event

    // Cron 配置
    public string? CronExpression { get; set; }      // e.g., "0 9 1 * *" (每月1号9点)
    public string? Timezone { get; set; } = "Asia/Shanghai";

    // Webhook 配置
    public string? WebhookId { get; set; }           // 自动生成的接入点 ID

    // 事件配置（对接 AutomationHub）
    public string? EventType { get; set; }           // e.g., "defect-agent.report.created"

    // 运行时变量覆盖
    public Dictionary<string, string>? VariableOverrides { get; set; }
}
```

### 5.6 WorkflowVariable（运行时变量）

```csharp
public class WorkflowVariable
{
    public string Key { get; set; } = string.Empty;       // e.g., "TARGET_MONTH"
    public string Label { get; set; } = string.Empty;     // e.g., "目标月份"
    public string Type { get; set; } = "string";          // string, number, date, select
    public string? DefaultValue { get; set; }             // 可用模板：{{now.year}}-{{now.month}}
    public List<string>? Options { get; set; }            // type=select 时的选项
    public bool Required { get; set; } = true;
    public bool IsSecret { get; set; }                    // 是否为敏感值（加密存储）
}
```

### 5.7 WorkflowExecution（执行实例）

```csharp
public class WorkflowExecution
{
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();
    public string WorkflowId { get; set; } = string.Empty;
    public string WorkflowName { get; set; } = string.Empty;    // 快照，不依赖当前定义

    // 触发信息
    public string TriggerType { get; set; } = "manual";         // manual, cron, webhook, event
    public string? TriggeredBy { get; set; }                    // userId (manual) / "system" (cron)

    // 运行时变量（本次执行的实际值）
    public Dictionary<string, string> Variables { get; set; } = new();

    // 工作流定义快照（保证历史可追溯）
    public List<WorkflowNode> NodeSnapshot { get; set; } = new();
    public List<WorkflowEdge> EdgeSnapshot { get; set; } = new();

    // 节点执行状态
    public List<NodeExecution> NodeExecutions { get; set; } = new();

    // 整体状态
    public string Status { get; set; } = ExecutionStatus.Queued;
    // Queued → Running → Completed / Failed / Cancelled

    // 最终产物
    public List<ExecutionArtifact> FinalArtifacts { get; set; } = new();

    // 分享
    public List<string> ShareLinkIds { get; set; } = new();

    // 时间追踪
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public long? DurationMs { get; set; }
    public string? ErrorMessage { get; set; }

    // SSE 重连序列号
    public long LastSeq { get; set; }
}

public static class ExecutionStatus
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}
```

### 5.8 NodeExecution（节点执行记录）

```csharp
public class NodeExecution
{
    public string NodeId { get; set; } = string.Empty;
    public string NodeName { get; set; } = string.Empty;
    public string NodeType { get; set; } = string.Empty;

    public string Status { get; set; } = "pending";
    // pending → running → completed / failed / skipped

    // 输入产物引用（来自上游节点的输出）
    public List<ArtifactRef> InputArtifactRefs { get; set; } = new();

    // 输出产物
    public List<ExecutionArtifact> OutputArtifacts { get; set; } = new();

    // 执行日志（截断保留最后 10KB）
    public string? Logs { get; set; }

    // 重试信息
    public int AttemptCount { get; set; }
    public string? ErrorMessage { get; set; }

    // 时间
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public long? DurationMs { get; set; }
}

public class ArtifactRef
{
    public string SourceNodeId { get; set; } = string.Empty;
    public string SlotId { get; set; } = string.Empty;
    public string ArtifactId { get; set; } = string.Empty;
}
```

### 5.9 ExecutionArtifact（执行产物）

```csharp
public class ExecutionArtifact
{
    public string ArtifactId { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string MimeType { get; set; } = "text/plain";
    public string SlotId { get; set; } = string.Empty;        // 所属输出槽位

    // 存储方式（二选一）
    public string? InlineContent { get; set; }                 // 小文本直接内联（< 64KB）
    public string? CosKey { get; set; }                        // 大文件存 COS
    public string? CosUrl { get; set; }                        // COS 公开 URL

    public long SizeBytes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
```

### 5.10 ShareLink（分享链接）

```csharp
public class ShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Token { get; set; } = GenerateToken();       // 短链接 token (12 字符)

    // 关联资源
    public string ResourceType { get; set; } = "workflow-execution";  // 可扩展到其他资源
    public string ResourceId { get; set; } = string.Empty;

    // 访问控制
    public string AccessLevel { get; set; } = "public";        // public = 任何人, authenticated = 需登录
    public string? Password { get; set; }                      // 可选：访问密码

    // 产物信息（冗余，方便渲染分享页面）
    public string? Title { get; set; }
    public string? PreviewHtml { get; set; }                   // HTML 预览内容
    public List<ShareArtifactRef> Artifacts { get; set; } = new();

    // 统计
    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    // 所有权
    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; }                   // null = 永不过期
    public bool IsRevoked { get; set; }                        // 手动撤销

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');  // URL-safe, 12 chars
}

public class ShareArtifactRef
{
    public string ArtifactId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string MimeType { get; set; } = string.Empty;
    public string? Url { get; set; }
}
```

---

## 6. 制品契约与节点间数据流

### 6.1 制品注入机制

节点间数据传递通过**制品注入（Artifact Injection）**实现：上游节点产出的制品，在下游节点中通过模板变量引用。

```
┌──────────┐    artifacts    ┌──────────┐    artifacts    ┌──────────┐
│  Node A  │ ──────────────→ │  Node B  │ ──────────────→ │  Node C  │
│ 数据采集  │  bugs.json     │ LLM分析   │  明细表.json    │ 代码统计  │
│          │  stories.json  │          │                 │          │
└──────────┘                └──────────┘                 └──────────┘
```

### 6.2 注入模板语法

在 LLM 节点的 `systemPrompt` 或 `inputMapping.template` 中使用以下语法引用上游产物：

```
{{artifact:<sourceNodeId>.<slotName>}}         → 注入产物文本内容
{{artifact:<sourceNodeId>.<slotName>.url}}     → 注入产物 COS URL
{{artifact:<sourceNodeId>.<slotName>.name}}    → 注入产物文件名
{{artifact:<sourceNodeId>.*}}                  → 注入该节点所有产物
{{var:<variableKey>}}                          → 注入运行时变量
{{now.year}} / {{now.month}} / {{now.date}}    → 当前时间
```

### 6.3 解析流程

```csharp
public class ArtifactInjector
{
    /// <summary>
    /// 将上游产物内容注入到模板文本中
    /// </summary>
    public async Task<string> InjectAsync(
        string template,
        Dictionary<string, List<ExecutionArtifact>> upstreamArtifacts,
        Dictionary<string, string> variables)
    {
        var result = template;

        // 1. 注入产物内容
        var artifactPattern = @"\{\{artifact:(\w+)\.(\w+|\*)(?:\.(url|name))?\}\}";
        result = await Regex.ReplaceAsync(result, artifactPattern, async match =>
        {
            var nodeId = match.Groups[1].Value;
            var slotName = match.Groups[2].Value;
            var property = match.Groups[3].Value;

            if (slotName == "*")
                return await GetAllArtifactsText(upstreamArtifacts[nodeId]);

            var artifact = FindArtifact(upstreamArtifacts, nodeId, slotName);
            return property switch
            {
                "url" => artifact?.CosUrl ?? "",
                "name" => artifact?.Name ?? "",
                _ => await GetArtifactContent(artifact)
            };
        });

        // 2. 注入变量
        result = Regex.Replace(result, @"\{\{var:(\w+)\}\}", match =>
            variables.GetValueOrDefault(match.Groups[1].Value, ""));

        // 3. 注入时间
        var now = DateTime.Now;
        result = result
            .Replace("{{now.year}}", now.Year.ToString())
            .Replace("{{now.month}}", now.Month.ToString("D2"))
            .Replace("{{now.date}}", now.ToString("yyyy-MM-dd"));

        return result;
    }
}
```

### 6.4 大文件处理策略

| 产物大小 | 存储方式 | 注入方式 |
|----------|----------|----------|
| < 64 KB | `InlineContent` 内联存储 | 直接替换模板变量 |
| 64KB - 2MB | COS 存储 | 下载后替换模板变量 |
| > 2MB | COS 存储 | 注入 URL，由 LLM 描述或分片处理 |

---

## 7. 执行引擎

### 7.1 WorkflowRunWorker（后台工作线程）

复用现有 Run/Worker 模式，新增 `RunKind = "workflow"`：

```csharp
public class WorkflowRunWorker : BackgroundService
{
    public const string RunKind = "workflow";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var runId = await _runQueue.DequeueAsync(RunKind, TimeSpan.FromSeconds(1), stoppingToken);
            if (string.IsNullOrWhiteSpace(runId))
            {
                await Task.Delay(300, stoppingToken);
                continue;
            }

            using var scope = _serviceProvider.CreateScope();
            await ProcessExecutionAsync(scope.ServiceProvider, runId.Trim(), stoppingToken);
        }
    }

    private async Task ProcessExecutionAsync(IServiceProvider sp, string executionId, CancellationToken ct)
    {
        var db = sp.GetRequiredService<MongoDbContext>();
        var execution = await db.WorkflowExecutions.Find(x => x.Id == executionId).FirstOrDefaultAsync(CancellationToken.None);
        if (execution == null) return;

        var orchestrator = sp.GetRequiredService<IWorkflowOrchestrator>();
        var eventStore = sp.GetRequiredService<IToolboxEventStore>();

        try
        {
            execution.Status = ExecutionStatus.Running;
            execution.StartedAt = DateTime.UtcNow;
            await db.WorkflowExecutions.ReplaceOneAsync(x => x.Id == executionId, execution, cancellationToken: CancellationToken.None);

            await foreach (var evt in orchestrator.ExecuteAsync(execution, CancellationToken.None))
            {
                await eventStore.AppendEventAsync($"wf:{executionId}", evt, CancellationToken.None);
                UpdateExecutionFromEvent(execution, evt);
                await db.WorkflowExecutions.ReplaceOneAsync(x => x.Id == executionId, execution, cancellationToken: CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            execution.Status = ExecutionStatus.Failed;
            execution.ErrorMessage = ex.Message;
            await db.WorkflowExecutions.ReplaceOneAsync(x => x.Id == executionId, execution, cancellationToken: CancellationToken.None);
        }

        execution.CompletedAt = DateTime.UtcNow;
        execution.DurationMs = (long)(execution.CompletedAt.Value - execution.StartedAt!.Value).TotalMilliseconds;
        await db.WorkflowExecutions.ReplaceOneAsync(x => x.Id == executionId, execution, cancellationToken: CancellationToken.None);

        // 发布自动化事件（通知/webhook）
        await PublishCompletionEvent(sp, execution);
    }
}
```

### 7.2 DAG 执行编排器

```csharp
public interface IWorkflowOrchestrator
{
    IAsyncEnumerable<ToolboxRunEvent> ExecuteAsync(
        WorkflowExecution execution,
        CancellationToken ct = default);

    /// <summary>
    /// 从指定节点重跑（保留该节点之前的产物）
    /// </summary>
    IAsyncEnumerable<ToolboxRunEvent> ResumeFromNodeAsync(
        WorkflowExecution execution,
        string fromNodeId,
        CancellationToken ct = default);
}

public class DagWorkflowOrchestrator : IWorkflowOrchestrator
{
    public async IAsyncEnumerable<ToolboxRunEvent> ExecuteAsync(
        WorkflowExecution execution,
        [EnumeratorCancellation] CancellationToken ct)
    {
        // 1. 构建 DAG 拓扑排序
        var sortedNodes = TopologicalSort(execution.NodeSnapshot, execution.EdgeSnapshot);

        // 2. 按拓扑序执行各节点
        var artifactStore = new Dictionary<string, List<ExecutionArtifact>>();
        long seq = 0;

        yield return ToolboxRunEvent.RunStarted(++seq);

        foreach (var node in sortedNodes)
        {
            var nodeExec = execution.NodeExecutions.First(n => n.NodeId == node.NodeId);

            // 跳过已完成的节点（从中间重跑场景）
            if (nodeExec.Status == "completed")
            {
                artifactStore[node.NodeId] = nodeExec.OutputArtifacts;
                continue;
            }

            yield return ToolboxRunEvent.StepStarted(node.NodeId, 0, node.NodeType, ++seq);

            // 3. 收集上游产物
            var upstreamArtifacts = CollectUpstreamArtifacts(node, execution.EdgeSnapshot, artifactStore);
            nodeExec.InputArtifactRefs = BuildArtifactRefs(upstreamArtifacts);

            // 4. 获取节点处理器
            var handler = _handlerFactory.GetHandler(node.NodeType);

            // 5. 执行节点
            nodeExec.Status = "running";
            nodeExec.StartedAt = DateTime.UtcNow;

            try
            {
                await foreach (var evt in handler.ExecuteAsync(new NodeExecutionContext
                {
                    Node = node,
                    UpstreamArtifacts = upstreamArtifacts,
                    Variables = execution.Variables,
                    ExecutionId = execution.Id
                }, CancellationToken.None))
                {
                    if (evt.Type == NodeEventType.Progress)
                        yield return ToolboxRunEvent.StepProgress(node.NodeId, evt.Content!, ++seq);
                    else if (evt.Type == NodeEventType.Artifact)
                    {
                        nodeExec.OutputArtifacts.AddRange(evt.Artifacts!);
                        foreach (var art in evt.Artifacts!)
                            yield return ToolboxRunEvent.StepArtifact(node.NodeId, MapToToolboxArtifact(art), ++seq);
                    }
                }

                nodeExec.Status = "completed";
                nodeExec.CompletedAt = DateTime.UtcNow;
                nodeExec.DurationMs = (long)(nodeExec.CompletedAt.Value - nodeExec.StartedAt.Value).TotalMilliseconds;
                artifactStore[node.NodeId] = nodeExec.OutputArtifacts;

                yield return ToolboxRunEvent.StepCompleted(node.NodeId, $"节点 {node.Name} 执行完成", ++seq);
            }
            catch (Exception ex)
            {
                nodeExec.Status = "failed";
                nodeExec.ErrorMessage = ex.Message;
                yield return ToolboxRunEvent.StepFailed(node.NodeId, ex.Message, ++seq);
                yield return ToolboxRunEvent.RunFailed($"节点 {node.Name} 执行失败: {ex.Message}", ++seq);
                yield break;
            }
        }

        // 6. 收集最终产物（最后一个节点的输出）
        var lastNode = sortedNodes.Last();
        execution.FinalArtifacts = artifactStore.GetValueOrDefault(lastNode.NodeId, new());

        yield return ToolboxRunEvent.RunCompleted("工作流执行完成", ++seq);
    }
}
```

### 7.3 从中间节点重跑

```
原始执行:  [A: completed] → [B: completed] → [C: failed] → [D: pending]

从 C 重跑:
  1. 创建新 Execution，复制节点快照
  2. 保留 A、B 的 NodeExecution 状态为 completed，沿用产物
  3. 重置 C、D 为 pending
  4. 编排器执行时跳过 completed 节点，从 C 开始执行
```

---

## 8. 定时调度

### 8.1 方案选择

扩展现有 `AutomationHub` 的触发类型，新增 `cron` 触发类型和专用 Worker：

```csharp
public class WorkflowScheduleWorker : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CheckAndTriggerDueWorkflowsAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Workflow schedule check failed");
            }

            // 每分钟检查一次
            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
        }
    }

    private async Task CheckAndTriggerDueWorkflowsAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var schedules = await _db.WorkflowSchedules
            .Find(s => s.IsEnabled && s.NextRunAt <= now)
            .ToListAsync(ct);

        foreach (var schedule in schedules)
        {
            // 创建执行实例
            var execution = await _workflowService.CreateExecutionAsync(
                schedule.WorkflowId,
                triggerType: "cron",
                triggeredBy: "system",
                variableOverrides: schedule.VariableOverrides);

            // 入队
            await _runQueue.EnqueueAsync(WorkflowRunWorker.RunKind, execution.Id);

            // 计算下次执行时间
            schedule.NextRunAt = CronExpression.Parse(schedule.CronExpression).GetNextOccurrence(now, schedule.Timezone);
            schedule.LastTriggeredAt = now;
            schedule.TriggerCount++;
            await _db.WorkflowSchedules.ReplaceOneAsync(s => s.Id == schedule.Id, schedule, cancellationToken: ct);

            _logger.LogInformation("Triggered workflow {WorkflowId} by schedule {ScheduleId}", schedule.WorkflowId, schedule.Id);
        }
    }
}
```

### 8.2 WorkflowSchedule 模型

```csharp
public class WorkflowSchedule
{
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();
    public string WorkflowId { get; set; } = string.Empty;
    public string CronExpression { get; set; } = string.Empty;
    public string Timezone { get; set; } = "Asia/Shanghai";

    public bool IsEnabled { get; set; } = true;
    public DateTime? NextRunAt { get; set; }
    public DateTime? LastTriggeredAt { get; set; }
    public long TriggerCount { get; set; }

    // 每次调度时的变量覆盖
    public Dictionary<string, string>? VariableOverrides { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
```

---

## 9. 分享机制

### 9.1 分享流程

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ 用户点击  │ ──→ │ 生成 ShareLink│ ──→ │ 返回短链接    │
│ "分享"按钮│     │ (含 token)   │     │ /s/{token}   │
└──────────┘     └──────────────┘     └──────────────┘

访问者打开链接:
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ GET /s/  │ ──→ │ 校验 token   │ ──→ │ 渲染分享页面  │
│ {token}  │     │ + 权限检查    │     │ (HTML 内联)   │
└──────────┘     └──────────────┘     └──────────────┘
```

### 9.2 访问控制

| 模式 | 行为 |
|------|------|
| `public` | 任何人凭链接可查看 |
| `authenticated` | 需要登录系统账号后查看 |

### 9.3 分享 Controller

```csharp
[ApiController]
[Route("s")]
public class ShareController : ControllerBase
{
    [HttpGet("{token}")]
    [AllowAnonymous]
    public async Task<IActionResult> ViewShare(string token)
    {
        var link = await _db.ShareLinks.Find(x => x.Token == token && !x.IsRevoked).FirstOrDefaultAsync();
        if (link == null) return NotFound();
        if (link.ExpiresAt.HasValue && link.ExpiresAt < DateTime.UtcNow) return Gone();

        // 权限检查
        if (link.AccessLevel == "authenticated")
        {
            var userId = GetUserIdOrNull();
            if (userId == null) return Unauthorized(new { loginRequired = true });
        }

        // 更新访问统计
        await _db.ShareLinks.UpdateOneAsync(
            x => x.Id == link.Id,
            Builders<ShareLink>.Update
                .Inc(x => x.ViewCount, 1)
                .Set(x => x.LastViewedAt, DateTime.UtcNow));

        // HTML 产物直接返回页面
        if (link.PreviewHtml != null)
            return Content(link.PreviewHtml, "text/html");

        // 其他产物返回下载信息
        return Ok(ApiResponse<object>.Ok(new
        {
            title = link.Title,
            artifacts = link.Artifacts
        }));
    }
}
```

---

## 10. 通知与集成

### 10.1 执行完成通知

工作流执行完成或失败时，通过 `AutomationHub` 发布事件：

```csharp
// 新增事件类型
new("workflow-agent.execution.completed", "工作流", "执行完成"),
new("workflow-agent.execution.failed", "工作流", "执行失败"),

// 发布事件
await _automationHub.PublishEventAsync(
    eventType: "workflow-agent.execution.completed",
    title: $"工作流 [{execution.WorkflowName}] 执行完成",
    content: $"耗时 {execution.DurationMs / 1000}s，产出 {execution.FinalArtifacts.Count} 个文件",
    variables: new Dictionary<string, string>
    {
        ["workflowId"] = execution.WorkflowId,
        ["executionId"] = execution.Id,
        ["shareUrl"] = shareUrl ?? ""
    });
```

### 10.2 邮件发送（可选）

对接现有 Email 通道，执行完成后发送报告邮件：

```csharp
// 工作流节点配置中可启用邮件通知
"notification": {
    "email": {
        "enabled": true,
        "recipients": ["team-lead@company.com"],
        "attachReport": true
    }
}
```

### 10.3 自动化规则集成

用户可在自动化规则中配置：

```
触发事件: workflow-agent.execution.completed
动作: webhook → 推送到企业微信/钉钉
动作: admin_notification → 通知相关人员
```

---

## 11. API 设计

### 11.1 Controller 结构

```csharp
[ApiController]
[Route("api/workflow-agent")]
[Authorize]
[AdminController("workflow-agent", AdminPermissionCatalog.WorkflowAgentUse)]
public class WorkflowAgentController : ControllerBase
{
    private const string AppKey = "workflow-agent";
}
```

### 11.2 端点清单

#### 工作流 CRUD

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/workflows` | 列表（分页，可按标签筛选） |
| POST | `/workflows` | 创建工作流 |
| GET | `/workflows/{id}` | 获取详情 |
| PUT | `/workflows/{id}` | 更新工作流定义 |
| DELETE | `/workflows/{id}` | 删除工作流 |
| POST | `/workflows/{id}/duplicate` | 复制工作流 |

#### 执行管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/workflows/{id}/execute` | 手动触发执行 |
| POST | `/executions/{id}/resume-from/{nodeId}` | 从指定节点重跑 |
| POST | `/executions/{id}/cancel` | 取消执行 |
| GET | `/executions` | 执行历史列表（按工作流筛选） |
| GET | `/executions/{id}` | 执行详情（含各节点状态和产物） |
| GET | `/executions/{id}/stream` | SSE 实时推送执行进度 |
| GET | `/executions/{id}/nodes/{nodeId}/logs` | 查看节点执行日志 |
| GET | `/executions/{id}/artifacts/{artifactId}/download` | 下载产物 |

#### 调度

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/workflows/{id}/schedules` | 查看调度配置 |
| POST | `/workflows/{id}/schedules` | 创建调度 |
| PUT | `/schedules/{id}` | 更新调度 |
| DELETE | `/schedules/{id}` | 删除调度 |
| POST | `/schedules/{id}/toggle` | 启用/禁用调度 |

#### 分享

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/executions/{id}/share` | 创建分享链接 |
| DELETE | `/shares/{id}` | 撤销分享 |
| GET | `/shares` | 我的分享列表 |

#### 凭证管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/secrets` | 列出凭证（仅名称，不返回值） |
| POST | `/secrets` | 添加凭证 |
| PUT | `/secrets/{key}` | 更新凭证值 |
| DELETE | `/secrets/{key}` | 删除凭证 |

#### 脚本包管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/scripts/upload` | 上传脚本压缩包 |
| GET | `/scripts` | 列出已上传的脚本包 |
| DELETE | `/scripts/{id}` | 删除脚本包 |

---

## 12. AppCallerRegistry 注册

```csharp
public static class WorkflowAgent
{
    public const string AppName = "工作流引擎";

    public static class Analyzer
    {
        [AppCallerMetadata(
            "LLM 数据分析",
            "工作流 LLM 分析节点，用于非结构化数据的结构化提取",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Analysis")]
        public const string Chat = "workflow-agent.analyzer::chat";
    }

    public static class CodeGen
    {
        [AppCallerMetadata(
            "代码生成",
            "工作流代码生成节点，LLM 生成统计/分析代码",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "CodeGen")]
        public const string Chat = "workflow-agent.codegen::chat";
    }

    public static class Renderer
    {
        [AppCallerMetadata(
            "报告渲染",
            "工作流渲染节点，LLM 生成 HTML/Markdown 报告",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Render")]
        public const string Chat = "workflow-agent.renderer::chat";
    }
}
```

---

## 13. 权限定义

```csharp
public static class AdminPermissionCatalog
{
    // 新增
    public const string WorkflowAgentUse = "workflow-agent:use";         // 使用工作流（创建、执行、查看自己的）
    public const string WorkflowAgentManage = "workflow-agent:manage";   // 管理所有工作流 + 查看所有执行记录
    public const string WorkflowAgentSecrets = "workflow-agent:secrets"; // 管理凭证
}
```

---

## 14. COS 存储结构

```
COS Bucket
└── workflow-agent/
    ├── scripts/                          # 用户上传的脚本包
    │   └── {userId}/{scriptId}.zip
    ├── artifacts/                         # 执行产物
    │   └── {executionId}/
    │       ├── {nodeId}/                  # 按节点隔离
    │       │   ├── bugs.json
    │       │   ├── stats.json
    │       │   └── report.html
    │       └── final/                     # 最终产物
    │           ├── report.html
    │           ├── report.md
    │           └── report.pdf
    └── shares/                            # 分享页面静态资源
        └── {shareToken}/
            └── index.html
```

---

## 15. 海鲜市场集成

工作流模板可发布到海鲜市场，其他用户可 Fork 使用。

### 前端类型注册

```typescript
// prd-admin/src/lib/marketplaceTypes.tsx
workflow: {
    key: 'workflow',
    label: '工作流',
    icon: GitBranch,
    color: {
        bg: 'rgba(59, 130, 246, 0.12)',
        text: 'rgba(59, 130, 246, 0.95)',
        border: 'rgba(59, 130, 246, 0.25)',
    },
    api: {
        listMarketplace: listWorkflowsMarketplace,
        publish: publishWorkflow,
        unpublish: unpublishWorkflow,
        fork: forkWorkflow,
    },
    getDisplayName: (item) => item.name,
    PreviewRenderer: WorkflowPreview,
},
```

### Fork 行为

Fork 时会复制工作流定义（节点、连线、变量定义），但**不复制**：
- 凭证（`secrets` 需要用户自行配置）
- 触发器（防止误触发）
- 执行历史

---

## 16. 前端页面规划

### 16.1 页面清单

| 页面 | 路由 | 说明 |
|------|------|------|
| 工作流列表 | `/workflow-agent` | 我的工作流 + 模板市场入口 |
| 工作流编辑器 | `/workflow-agent/{id}/edit` | 可视化 DAG 编辑（React Flow） |
| 执行历史 | `/workflow-agent/{id}/executions` | 执行记录列表 + 状态 |
| 执行详情 | `/workflow-agent/executions/{id}` | 各节点执行状态 + 产物浏览 + 日志 |
| 分享页面 | `/s/{token}` | 公开访问，渲染报告 |

### 16.2 工作流编辑器（核心页面）

```
┌──────────────────────────────────────────────────────┐
│  工作流名称: 月度质量报告生成               [保存] [执行]  │
├──────────┬───────────────────────────────────────────┤
│          │                                           │
│ 节点面板  │           DAG 画布 (React Flow)            │
│          │                                           │
│ ┌──────┐ │     ┌─────────┐    ┌──────────┐          │
│ │采集器 │ │     │ TAPD采集 │───→│ LLM 分析  │          │
│ ├──────┤ │     └─────────┘    └──────────┘          │
│ │脚本   │ │                         │                │
│ ├──────┤ │                         ▼                │
│ │LLM   │ │                   ┌──────────┐           │
│ ├──────┤ │                   │ 代码统计  │           │
│ │代码   │ │                   └──────────┘           │
│ ├──────┤ │                         │                │
│ │渲染   │ │                         ▼                │
│ └──────┘ │                   ┌──────────┐           │
│          │                   │ HTML 渲染 │           │
│          │                   └──────────┘           │
│          │                                           │
├──────────┴───────────────────────────────────────────┤
│ 属性面板:  [选中节点的配置编辑区域]                       │
│ ┌──────────────────────────────────────────────────┐ │
│ │ 节点名称: TAPD 数据采集                            │ │
│ │ 采集器: TAPD                                      │ │
│ │ 工作空间 ID: {{secrets.TAPD_WORKSPACE_ID}}        │ │
│ │ 数据范围: 最近 30 天                               │ │
│ │ 资源类型: [x] Bugs  [x] Stories  [ ] Iterations  │ │
│ └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

---

## 17. TAPD 数据自动化案例（端到端示例）

### 17.1 工作流定义

```
月度质量会议报告生成工作流

变量:
  - TARGET_MONTH: 目标月份 (默认: {{now.year}}-{{now.month}})
  - WORKSPACE_ID: TAPD 工作空间 ID (Secret)

触发:
  - cron: "0 9 1 * *" (每月1日上午9点自动执行)
  - manual: 可手动触发

节点:
  A [数据采集] TAPD Bug 数据拉取
    → 输出: bugs.json
  B [数据采集] TAPD Story 数据拉取
    → 输出: stories.json
  C [LLM 分析] Bug 明细结构化
    → 输入: bugs.json + 系统提示词
    → 输出: bug_details.json (结构化表格)
  D [LLM 分析] Story 明细结构化
    → 输入: stories.json + 系统提示词
    → 输出: story_details.json (结构化表格)
  E [LLM 代码执行] 统计汇总
    → 输入: bug_details.json + story_details.json
    → 指令: 按模块统计 Bug 数量/严重程度/平均解决时间...
    → 输出: stats.json
  F [渲染] 生成 HTML 报告
    → 输入: stats.json + bug_details.json + story_details.json
    → 输出: report.html, report.md, report.pdf

连线:
  A → C
  B → D
  C → E
  D → E
  E → F
```

### 17.2 执行时间线

```
09:00:00  [触发] Cron 触发，创建 Execution
09:00:01  [A+B] 并行拉取 TAPD Bug + Story 数据 (约 30s)
09:00:32  [C+D] 并行 LLM 分析，结构化提取明细 (约 60s)
09:01:33  [E]   LLM 生成 Python 统计代码 → Docker 执行 (约 45s)
09:02:18  [F]   LLM 渲染 HTML 报告 (约 30s)
09:02:48  [完成] 上传 COS，创建分享链接，发送通知

总耗时: 约 3 分钟
```

---

## 18. 实现分期

### Phase 1: MVP（核心管线）

| 任务 | 说明 |
|------|------|
| Workflow + Execution 数据模型 | MongoDB 集合 + 索引 |
| WorkflowAgentController | CRUD + 执行 + 历史查询 |
| WorkflowRunWorker | 后台执行引擎 |
| DagWorkflowOrchestrator | DAG 拓扑排序 + 串行执行 |
| data-collector (HTTP) | 通用 HTTP 采集器 |
| llm-analyzer | LLM 分析节点 |
| renderer (md) | Markdown 渲染输出 |
| 前端列表页 + 简易 JSON 编辑器 | 基础管理 UI |

### Phase 2: Docker + 高级节点

| 任务 | 说明 |
|------|------|
| script-executor | Docker 容器隔离执行 |
| llm-code-executor | LLM 生成代码 + 执行 |
| data-collector (TAPD) | 内置 TAPD 采集器 |
| renderer (html/pdf) | HTML + PDF 渲染 |
| 从中间节点重跑 | ResumeFromNode API |
| DAG 并行执行 | 无依赖节点并行运行 |

### Phase 3: 编辑器 + 分享

| 任务 | 说明 |
|------|------|
| 可视化 DAG 编辑器 | React Flow 画布 |
| 分享链接系统 | ShareLink + 公开页面 |
| 定时调度 | Cron Worker |
| 凭证管理 UI | Secret 加密存储 |

### Phase 4: 生态

| 任务 | 说明 |
|------|------|
| 海鲜市场发布 | IForkable 实现 |
| 自动化事件集成 | 完成/失败通知 |
| 邮件通知 | 报告邮件推送 |
| 开放平台 Webhook 触发 | 外部系统触发工作流 |

---

## 19. 附录

### 19.1 技术选型

| 组件 | 方案 | 原因 |
|------|------|------|
| DAG 编辑 | React Flow | 成熟的 React DAG 编辑器，社区活跃 |
| Cron 解析 | Cronos (NuGet) | 轻量 cron 表达式解析库 |
| Docker 管理 | Docker.DotNet | 通过 Docker Socket 管理容器 |
| PDF 生成 | Puppeteer-Sharp / wkhtmltopdf | HTML → PDF 转换 |
| 模板引擎 | 自定义 `{{}}` 语法 | 与现有系统一致，简单够用 |

### 19.2 安全考量

| 风险 | 对策 |
|------|------|
| Docker 容器逃逸 | 限制 capabilities、只读根文件系统、禁用 privileged |
| 凭证泄露 | AES-256-GCM 加密存储、日志脱敏、不在前端返回明文 |
| 脚本恶意代码 | 网络隔离（默认 none）、CPU/内存/时间限制、禁止挂载宿主目录 |
| 分享链接滥用 | 可设过期时间、可撤销、访问频率限制 |
| LLM 生成危险代码 | 在沙箱中执行、仅允许写入 /output/ |

### 19.3 与现有 Toolbox 的关系

工作流引擎是 Toolbox 的**垂直扩展**，二者关系：

| 维度 | Toolbox | Workflow Engine |
|------|---------|----------------|
| 定位 | 自然语言驱动的即时任务 | 预定义管线的自动化批处理 |
| 触发 | 用户自然语言输入 | 定时 / 手动 / Webhook |
| 编排 | 意图识别 → 自动规划步骤 | 用户预定义 DAG |
| 执行 | 即时流式输出 | 后台批量执行 |
| 产物 | 对话中内联 | 独立存储 + 可分享 |
| 复用 | ToolboxItem 自定义 Agent | 工作流模板 + 海鲜市场 Fork |

两者共享基础设施：Run/Worker、EventStore、LLM Gateway、COS 存储。
