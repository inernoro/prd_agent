# AI 文本辅助（Text Assist）— 通用 Domain · 计划

## 定位

一个**跨应用复用**的轻量 AI 文本辅助服务，任何页面都可以一键调用：
- 网页托管：根据 HTML 内容自动生成标题、描述、标签
- 视觉创作：AI 取名字（工作区标题）
- 缺陷管理：AI 润色缺陷描述
- 周报：AI 优化周报表述
- ...未来任何需要 AI 填充/润色/取名 的场景

## 核心设计

### 后端：通用 TextAssist 端点

**不是独立 Controller**，而是一个通用 Service + 在各 Controller 中按需暴露端点。

原因：遵循「应用身份隔离原则」，AppCallerCode 由各应用自己定义，不能混成一个大杂烩。

```
TextAssistService (通用服务)
  ├── GenerateAsync(appCallerCode, systemPrompt, userContent, outputFormat) → string
  └── StreamAsync(appCallerCode, systemPrompt, userContent, outputFormat) → IAsyncEnumerable

各 Controller 调用时传入自己的 AppCallerCode：
  WebPagesController     → "web-hosting.text-assist::intent"
  VisualAgentController  → "visual-agent.workspace-title::intent" (已有)
  DefectAgentController  → "defect-agent.polish::chat" (已有)
```

### 请求/响应模型

```csharp
// 请求
public class TextAssistRequest
{
    /// <summary>AI 任务类型</summary>
    public string Task { get; set; } = string.Empty;  // "auto-fill" | "polish" | "rename" | "summarize" | "tag"

    /// <summary>输入内容（文件内容、已有文本等）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>额外上下文（可选，如文件名、已有标题等）</summary>
    public Dictionary<string, string>? Context { get; set; }
}

// 响应（JSON 结构化输出）
public class TextAssistResult
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }
    public string? Text { get; set; }  // 通用文本输出（润色、取名等）
}
```

### 前端：通用 Hook

```typescript
// useTextAssist.ts — 任何页面都能用
function useTextAssist() {
  const [loading, setLoading] = useState(false);

  const assist = async (apiUrl: string, request: TextAssistRequest): Promise<TextAssistResult> => {
    setLoading(true);
    try {
      const res = await apiRequest(apiUrl, { method: 'POST', body: request });
      return res.data;
    } finally {
      setLoading(false);
    }
  };

  return { assist, loading };
}
```

前端 UI 组件：一个 ✨ 按钮，放在表单旁边，点击触发 AI 填充。

## 实现步骤

### Step 1: 后端 TextAssistService（通用服务层）

**文件**: `PrdAgent.Infrastructure/Services/TextAssist/TextAssistService.cs`

- 注入 `ILlmGateway`
- `GenerateAsync(appCallerCode, task, content, context)` → 非流式，收集完整响应
- 内置 system prompt 模板：根据 task 类型自动选择 prompt
- JSON 输出格式约束（让 LLM 返回结构化 JSON）
- 温度用 intent 级别（0.3），快速响应

**文件**: `PrdAgent.Core/Models/TextAssist.cs`

- `TextAssistRequest` / `TextAssistResult` 模型

### Step 2: 注册 AppCallerCode

**文件**: `PrdAgent.Core/Models/AppCallerRegistry.cs`

新增 `WebHosting` 分组：
```csharp
public static class WebHosting
{
    [AppCallerMetadata("网页托管-文本辅助", "根据网页内容自动生成标题、描述、标签", ...)]
    public const string TextAssist = "web-hosting.text-assist::intent";
}
```

### Step 3: WebPagesController 新增端点

**文件**: `PrdAgent.Api/Controllers/Api/WebPagesController.cs`

```csharp
[HttpPost("text-assist")]
public async Task<IActionResult> TextAssist([FromBody] TextAssistRequest request)
{
    var result = await _textAssistService.GenerateAsync(
        AppCallerRegistry.WebHosting.TextAssist,
        request.Task,
        request.Content,
        request.Context);
    return Ok(ApiResponse.Success(result));
}
```

前端上传文件后，读取文件内容（HTML text），调用此端点，AI 返回 { title, description, tags }。

### Step 4: 前端 Hook + UI

**文件**: `prd-admin/src/hooks/useTextAssist.ts`

通用 hook，接受 API URL，返回 { assist, loading }。

**文件**: `prd-admin/src/services/real/webPages.ts`

新增 `textAssistSite(content, context)` 函数。

**文件**: `prd-admin/src/pages/WebPagesPage.tsx` — UploadEditDialog

- 用户选择文件后，自动（或点按钮）读取 HTML 文本内容
- 调用 text-assist API
- AI 返回后自动填充 title / description / tags
- 加载中显示 shimmer 动画

### Step 5: DI 注册

**文件**: `PrdAgent.Api/Program.cs` 或 `ServiceCollectionExtensions`

注册 `TextAssistService` 为 Scoped。

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `PrdAgent.Core/Models/TextAssist.cs` | 新建 | 请求/响应模型 |
| `PrdAgent.Core/Models/AppCallerRegistry.cs` | 修改 | 新增 WebHosting 分组 |
| `PrdAgent.Infrastructure/Services/TextAssist/TextAssistService.cs` | 新建 | 核心服务 |
| `PrdAgent.Api/Controllers/Api/WebPagesController.cs` | 修改 | 新增 text-assist 端点 |
| `PrdAgent.Api/Program.cs` 或 DI 配置 | 修改 | 注册服务 |
| `prd-admin/src/hooks/useTextAssist.ts` | 新建 | 通用前端 hook |
| `prd-admin/src/services/real/webPages.ts` | 修改 | 新增 API 函数 |
| `prd-admin/src/services/api.ts` | 修改 | 新增路由 |
| `prd-admin/src/pages/WebPagesPage.tsx` | 修改 | UploadEditDialog 加入 AI 填充按钮 |

## 设计决策

1. **非流式** — auto-fill 场景内容短（title + desc + tags），不需要流式，一次性返回 JSON 更简单
2. **Intent 模型类型** — 使用轻量 intent 模型，响应快、成本低
3. **通用 Service + 分散 Controller** — 服务层通用，但入口按应用隔离，符合架构原则
4. **前端通用 hook** — 任何页面都能复用，只需传不同的 API URL
