---
name: create-executor
description: "CLI Agent 执行器接入技能。引导创建新的执行器类型（如龙虾执行器），自动生成后端分发逻辑、前端注册、联调测试。触发词：'创建执行器', '接入执行器', 'create executor', '新增执行器', '/create-executor'。"
---

# Create Executor — 执行器接入向导

为 CLI Agent 执行器胶囊接入新的执行器类型，全流程自动化：创建 → 注册 → 联调 → 测试。

## 架构概览

```
┌───────────────────────────────────────────────────┐
│  CapsuleExecutor.ExecuteCliAgentAsync (入口分发)   │
│                                                   │
│  executorType ──┬── "builtin-llm"  ✅ 已实现       │
│                 ├── "docker"       ✅ 已实现       │
│                 ├── "api"          ✅ 已实现       │
│                 ├── "script"       ✅ 已实现       │
│                 └── "你的新类型"    🆕 由此技能创建  │
└───────────────────────────────────────────────────┘
```

## 接入范式

每个执行器都是一个静态方法，签名统一：

```csharp
private static async Task<CapsuleResult> ExecuteCliAgent_{Name}Async(
    IServiceProvider sp,
    WorkflowNode node,
    Dictionary<string, string> variables,
    CliAgentContext ctx,        // 公共上下文（spec/framework/style/prompt/迭代信息）
    StringBuilder sb,           // 日志
    ILogger logger,
    EmitEventDelegate? emitEvent)
```

### 输入：CliAgentContext（所有执行器共享）

| 字段 | 类型 | 说明 |
|------|------|------|
| `Spec` | string | 规范类型：none/spec/dri/dev/sdd |
| `Framework` | string | 框架：html/react/vue/nextjs/svelte/custom |
| `Style` | string | 风格：ui-ux-pro-max/minimal/dashboard/landing/doc/custom |
| `Prompt` | string | 用户输入的生成提示词 |
| `SpecInput` | string | 上游传入的产品规格文档 |
| `PreviousOutput` | string | 上一轮生成的 HTML（多轮迭代时非空） |
| `UserFeedback` | string | 用户修改意见（多轮迭代时非空） |
| `IsIteration` | bool | 是否为迭代轮次 |
| `TimeoutSeconds` | int | 超时时间 |
| `EnvVars` | Dict | 环境变量 |

### 输出：CapsuleResult

必须返回至少一个产物到 `cli-html-out` 槽位：

```csharp
return new CapsuleResult(new List<ExecutionArtifact>
{
    MakeTextArtifact(node, "cli-html-out", "生成页面", htmlContent, "text/html"),
    MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
}, sb.ToString());
```

## 创建流程

收到用户请求后，按以下步骤执行：

### Step 1: 收集执行器信息

向用户确认：
1. **执行器名称**（kebab-case，如 `lobster`）
2. **执行器类型**：属于哪类？
   - `docker-based`：需要 Docker 容器运行（如 OpenHands、Aider）
   - `api-based`：调用外部 HTTP API（如 Bolt.new、v0）
   - `local-process`：本地运行一个进程/CLI 命令
   - `llm-based`：调用 LLM Gateway 但用不同的 prompt 策略
3. **专有配置字段**：该执行器需要哪些独有的配置参数？
4. **交互协议**：该执行器如何接收 prompt，如何返回结果？

### Step 2: 后端实现（3 个文件）

#### 2.1 CapsuleTypeRegistry.cs — 注册 executorType 选项

在 `CapsuleTypeRegistry.CliAgentExecutor.ConfigSchema` 的 `executorType` 字段 Options 中追加新选项：

```csharp
new() { Value = "{name}", Label = "{显示名}" },
```

如果有专有配置字段，在 ConfigSchema 中追加：

```csharp
// ── {Name} 执行器配置 ──
new() { Key = "{name}Xxx", Label = "XXX", FieldType = "text", Required = false,
    HelpTip = "{Name} 执行器专用：..." },
```

#### 2.2 CapsuleExecutor.cs — 添加分发分支 + 实现方法

在 `ExecuteCliAgentAsync` 的 switch 中追加：

```csharp
"{name}" => await ExecuteCliAgent_{Name}Async(sp, node, variables, ctx, sb, logger, emitEvent),
```

然后实现执行器方法。模板：

```csharp
// ── 执行器: {Name} ──

private static async Task<CapsuleResult> ExecuteCliAgent_{Name}Async(
    IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
    CliAgentContext ctx, StringBuilder sb, ILogger logger, EmitEventDelegate? emitEvent)
{
    // 1. 提取专有配置
    var myConfig = ReplaceVariables(GetConfigString(node, "{name}Xxx") ?? "", variables).Trim();
    sb.AppendLine($"[{name}] config: {myConfig}");

    // 2. 发射进度事件
    if (emitEvent != null)
        await emitEvent("cli-agent-phase", new { phase = "running", message = "执行中…" });

    // 3. 执行核心逻辑
    //    - Docker: Process.Start("docker", args)
    //    - API: httpClient.PostAsync(endpoint, payload)
    //    - Local: Process.Start(command, args)
    //    - LLM: gateway.GenerateAsync(request)
    var html = "<!DOCTYPE html><html><body>TODO</body></html>";

    // 4. 多轮迭代处理
    if (ctx.IsIteration)
    {
        // 把 ctx.PreviousOutput + ctx.UserFeedback 传给执行器
        // 让它在上一轮基础上修改
    }

    // 5. 返回结果
    if (emitEvent != null)
        await emitEvent("cli-agent-phase", new { phase = "completed", message = "完成" });

    return new CapsuleResult(new List<ExecutionArtifact>
    {
        MakeTextArtifact(node, "cli-html-out", "生成页面", html, "text/html"),
        MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
    }, sb.ToString());
}
```

#### 2.3 WorkflowModels.cs — 无需修改

执行器类型是 config 字段，不是 CapsuleType，不需要改 WorkflowModels。

### Step 3: 前端注册

在 `prd-admin/src/pages/workflow-agent/capsuleRegistry.tsx` 中**无需修改**——执行器类型是配置表单的 select 选项，由后端 ConfigSchema 驱动，前端自动渲染。

### Step 4: 编译验证

```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

### Step 5: 联调测试

使用工作流胶囊测试接口验证：

```bash
# 测试新执行器
curl -X POST http://localhost:5000/api/workflow-agent/capsules/test-run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AI_ACCESS_KEY" \
  -d '{
    "nodeType": "cli-agent-executor",
    "config": {
      "executorType": "{name}",
      "prompt": "生成一个简单的 Hello World 页面",
      "framework": "html",
      "style": "minimal"
    },
    "inputArtifacts": []
  }'
```

验证点：
- [ ] 返回 200 且 artifacts 包含 `cli-html-out`
- [ ] HTML 内容有效（包含 `<!DOCTYPE html>`）
- [ ] 日志产物包含执行器名称标记

### Step 6: 多轮迭代测试

```bash
# 第 2 轮：传入上轮结果 + 反馈
curl -X POST http://localhost:5000/api/workflow-agent/capsules/test-run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AI_ACCESS_KEY" \
  -d '{
    "nodeType": "cli-agent-executor",
    "config": {
      "executorType": "{name}",
      "prompt": "产品展示页",
      "framework": "html",
      "style": "ui-ux-pro-max"
    },
    "inputArtifacts": [
      {
        "slotId": "cli-prev-in",
        "name": "previousOutput",
        "mimeType": "text/html",
        "inlineContent": "<html>...上轮结果...</html>"
      },
      {
        "slotId": "cli-feedback-in",
        "name": "userFeedback",
        "mimeType": "text/plain",
        "inlineContent": "标题太小了，配色换成蓝色"
      }
    ]
  }'
```

### Step 7: 提交

完成后提交代码，changelog 碎片示例：

```
| feat | prd-api | 新增 {Name} 执行器，支持 xxx |
```

## 已有执行器清单

| executorType | 名称 | 依赖 | 适用场景 |
|---|---|---|---|
| `builtin-llm` | 内置 LLM | ILlmGateway | 无需额外环境，直接 LLM 生成 HTML |
| `docker` | Docker 容器 | docker CLI | 运行任意容器化 CLI 工具 |
| `api` | 外部 API | HTTP | 调用 OpenHands/Bolt.new 等外部服务 |
| `script` | Jint 脚本 | 无 | JavaScript 沙箱内简单生成 |

## 扩展点设计

新执行器**只需改 2 个文件**：
1. `CapsuleTypeRegistry.cs`：注册 executorType 选项 + 专有配置字段
2. `CapsuleExecutor.cs`：添加 switch 分支 + 实现方法

**不需要改**：WorkflowModels、前端代码、前端 contracts、capsuleRegistry.tsx。

这就是接入范式：所有执行器共享输入输出协议（CliAgentContext → CapsuleResult），差异只在执行逻辑。
