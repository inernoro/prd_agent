---
name: create-executor
description: "全自动接入 CLI Agent 执行器。用户只需说出执行器名称和用途，Claude 自动完成：读取代码 → 生成执行器 → 注册 → 自测 → 完成。触发词：'创建执行器', '接入执行器', 'create executor', '新增执行器', '/create-executor'。"
---

# Create Executor — 全自动执行器接入

你是一个执行器接入 Agent。用户只需告诉你执行器名称和用途，你自主完成全部接入工作。

## 执行协议

收到请求后，**不要问问题**，直接按以下步骤自主执行。只在需要用户提供密钥/凭据时才暂停询问。

### Phase 1: 理解环境（静默执行）

1. 读取 `prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs`，找到 `ExecuteCliAgentAsync` 入口方法和已有执行器（搜索 `ExecuteCliAgent_`）
2. 读取 `prd-api/src/PrdAgent.Core/Models/CapsuleTypeRegistry.cs`，找到 `CliAgentExecutor` 的 ConfigSchema
3. 确认已有执行器列表和 executorType switch 分支

### Phase 2: 生成执行器代码

根据用户描述，生成执行器实现。必须遵循接入范式：

**方法签名（固定）：**
```csharp
private static async Task<CapsuleResult> ExecuteCliAgent_{PascalName}Async(
    IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables,
    CliAgentContext ctx, StringBuilder sb, ILogger logger, EmitEventDelegate? emitEvent)
```

**输入：CliAgentContext（已有，不要修改）**
- `ctx.Spec` / `ctx.Framework` / `ctx.Style` / `ctx.Prompt` — 通用配置
- `ctx.SpecInput` — 上游产品规格
- `ctx.PreviousOutput` — 上轮 HTML（多轮迭代）
- `ctx.UserFeedback` — 用户修改意见（多轮迭代）
- `ctx.IsIteration` — 是否迭代轮
- `ctx.TimeoutSeconds` / `ctx.EnvVars` — 资源限制

**输出（固定）：必须返回 cli-html-out 槽位**
```csharp
return new CapsuleResult(new List<ExecutionArtifact>
{
    MakeTextArtifact(node, "cli-html-out", "生成页面", html, "text/html"),
    MakeTextArtifact(node, "cli-log-out", "日志", sb.ToString()),
}, sb.ToString());
```

**多轮迭代（必须支持）：**
```csharp
if (ctx.IsIteration)
{
    // 把 ctx.PreviousOutput + ctx.UserFeedback 传给执行逻辑
    // 要求在上轮基础上增量修改，不要全部重写
}
```

**进度事件（必须发射）：**
```csharp
if (emitEvent != null)
    await emitEvent("cli-agent-phase", new { phase = "running", message = "描述当前步骤…" });
```

### Phase 3: 注册（改 2 个文件）

**文件 1: `CapsuleTypeRegistry.cs`**

在 CliAgentExecutor 的 ConfigSchema 中找到 `executorType` 的 Options 列表，追加：
```csharp
new() { Value = "{kebab-name}", Label = "{显示名称}" },
```

如果执行器有专有配置，在 ConfigSchema 末尾（`timeoutSeconds` 之前）追加字段：
```csharp
// ── {Name} 执行器配置 ──
new() { Key = "{kebabName}Config", Label = "xxx", FieldType = "text", Required = false, HelpTip = "{Name} 执行器专用：..." },
```

**文件 2: `CapsuleExecutor.cs`**

在 `ExecuteCliAgentAsync` 方法的 switch 中追加分支：
```csharp
"{kebab-name}" => await ExecuteCliAgent_{PascalName}Async(sp, node, variables, ctx, sb, logger, emitEvent),
```

然后在 `// ── CLI Agent 工具方法 ──` 注释之前插入执行器方法实现。

### Phase 4: 编译验证

执行：
```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

如果有编译错误，自行修复后重新编译，直到零错误。

### Phase 5: 自测

构造一个最小测试用例，验证执行器可以运行：

```bash
# 自测方法：直接在 C# 中构造 WorkflowNode 调用执行器
# 如果环境有 dotnet，写一个简单的测试脚本
cd prd-api && dotnet build --no-restore
```

编译通过即为 Phase 5 通过（实际运行时测试需要完整环境）。

对于可以静态验证的部分：
- 确认 switch 分支的字符串与 Registry Option Value 一致
- 确认方法签名与分发调用一致
- 确认返回了 cli-html-out 槽位的 artifact

### Phase 6: 完成

1. 创建 changelog 碎片：`changelogs/YYYY-MM-DD_{name}-executor.md`
2. 向用户报告：

```
✅ {Name} 执行器接入完成

改动文件：
  - CapsuleTypeRegistry.cs：注册 executorType="{kebab-name}" + {N} 个专有配置
  - CapsuleExecutor.cs：新增 ExecuteCliAgent_{PascalName}Async ({N} 行)

执行器类型：{类型描述}
多轮迭代：✅ 支持
编译检查：✅ 通过

用户可在工作流编辑器中添加「CLI Agent 执行器」胶囊，执行器类型选择「{显示名}」即可使用。
```

## 执行器分类参考

| 类型 | 核心逻辑 | 示例 |
|------|---------|------|
| **LLM 策略型** | 调用 ILlmGateway，不同 system prompt | 专业文档生成器、PPT 页面生成器 |
| **Docker 容器型** | Process.Start("docker", args) | OpenHands、Aider、自定义镜像 |
| **API 调用型** | HttpClient.PostAsync | Bolt.new、v0、自建微服务 |
| **CLI 进程型** | Process.Start(command) | 本地 Node.js 脚本、Python 工具 |
| **混合型** | LLM 生成 prompt → 传给外部工具 | LLM 审题 + CLI 执行 |

### LLM Gateway 调用范式（关键！）

调用 ILlmGateway 时必须使用 `SendAsync` + `RequestBody`（OpenAI messages 格式），**不存在** `GenerateAsync`/`SystemPrompt`/`UserMessage`：

```csharp
var gateway = sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
var messages = new System.Text.Json.Nodes.JsonArray
{
    new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
    new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userPrompt },
};
var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
{
    AppCallerCode = "page-agent.generate::chat",
    ModelType = "chat",
    TimeoutSeconds = ctx.TimeoutSeconds,
    RequestBody = new System.Text.Json.Nodes.JsonObject { ["messages"] = messages },
};
var response = await gateway.SendAsync(request, CancellationToken.None);
var content = response?.Content ?? "";
```

## 已注册执行器

读取代码后以实际为准，截至技能创建时：

| Value | 名称 | 依赖 |
|-------|------|------|
| `builtin-llm` | 内置 LLM | ILlmGateway |
| `docker` | Docker 容器 | docker CLI |
| `api` | 外部 API | IHttpClientFactory |
| `script` | Jint 脚本 | 无 |
