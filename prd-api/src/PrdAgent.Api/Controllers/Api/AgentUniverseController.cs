using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.AgentUniverse;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 智能体宇宙（Agent Universe）统一入口。
///
/// 一套标准把所有智能体接到一起（漫威宇宙式互通）：
/// 1) GET  capabilities —— 下发每个智能体的输入/输出/调用模式/交互形态契约（前后端 SSOT）
/// 2) POST invoke       —— 统一调用信封，一律路由到该智能体的**真实组件**（IAgentAdapter）
///
/// 核心原则：**只打通管道，绝不仿冒智能体**。invoke 永远把请求交给真实适配器去跑业务；
/// 找不到真实适配器就明确报错（NO_REAL_AGENT），不降级成硬编码提示词的"假聊天"。
/// 这样用户改了某个智能体的业务配置，本面板自动同步（系统里只有一处实现），不会漂移。
///
/// 所有产出统一为带类型的 SSE 事件（text / artifact / done / error），
/// 调用方（再加工抽屉 / 未来的 @艾特 / 工作流节点）只认这一套信封。
/// </summary>
[ApiController]
[Route("api/agent-universe")]
[Authorize]
[AdminController("ai-toolbox", AdminPermissionCatalog.AiToolboxUse)]
public class AgentUniverseController : ControllerBase
{
    private readonly IEnumerable<IAgentAdapter> _adapters;
    private readonly ILogger<AgentUniverseController> _logger;

    private static readonly JsonSerializerOptions JsonOptions =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AgentUniverseController(
        IEnumerable<IAgentAdapter> adapters,
        ILogger<AgentUniverseController> logger)
    {
        _adapters = adapters;
        _logger = logger;
    }

    /// <summary>
    /// 下发智能体能力契约清单（前端据此渲染选择器与对应交互）。
    /// </summary>
    [HttpGet("capabilities")]
    public IActionResult Capabilities()
    {
        return Ok(ApiResponse<object>.Ok(new { capabilities = AgentCapabilityRegistry.All }));
    }

    /// <summary>
    /// 统一调用信封（SSE 流式）。一律路由到真实 IAgentAdapter，绝不仿冒。
    /// </summary>
    [HttpPost("invoke")]
    [Produces("text/event-stream")]
    public async Task Invoke([FromBody] AgentInvokeRequest request)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = this.GetRequiredUserId();

        var cap = AgentCapabilityRegistry.Find(request.AgentKey);
        if (cap == null)
        {
            await WriteSseEventAsync("error", new { code = "UNKNOWN_AGENT", message = $"未知智能体: {request.AgentKey}" });
            return;
        }

        var text = (request.Text ?? string.Empty).Trim();
        var action = string.IsNullOrWhiteSpace(request.Action) ? cap.DefaultAction : request.Action!.Trim();

        // 一律路由到真实组件（IAgentAdapter）。找不到就报错，绝不用硬编码提示词仿冒。
        var adapter = _adapters.FirstOrDefault(a => a.AgentKey == cap.AgentKey && a.CanHandle(action));
        if (adapter == null)
        {
            await WriteSseEventAsync("error", new
            {
                code = "NO_REAL_AGENT",
                message = $"智能体 {cap.AgentKey} 暂无可用的真实组件（action={action}）",
            });
            return;
        }

        // 生成型：text 即画面描述（prompt）；其余把用户指令 + 参考文档合成为智能体输入
        var userMessage = cap.InvokeMode == AgentInvokeModes.Generation
            ? text
            : BuildDocUserMessage(text, request.DocumentContent);

        if (string.IsNullOrWhiteSpace(userMessage))
        {
            await WriteSseEventAsync("error", new { code = "EMPTY_INPUT", message = "请先输入内容" });
            return;
        }

        var context = new AgentExecutionContext
        {
            RunId = Guid.NewGuid().ToString("N"),
            TraceId = "agent-universe-" + Guid.NewGuid().ToString("N"),
            StepId = Guid.NewGuid().ToString("N"),
            UserId = userId,
            UserMessage = userMessage,
            Action = action,
            Input = new Dictionary<string, object>(),
        };
        if (request.ImageUrls is { Count: > 0 })
        {
            context.Input["imageUrl"] = request.ImageUrls[0];
        }
        // 透传面板选择的参数（如尺寸/模型）给真实智能体；适配器按需读取（无则用其默认）
        if (request.Parameters != null)
        {
            foreach (var kv in request.Parameters)
            {
                if (!string.IsNullOrWhiteSpace(kv.Value))
                    context.Input[kv.Key] = kv.Value;
            }
        }

        await WriteSseEventAsync("start", new
        {
            agentKey = cap.AgentKey,
            invokeMode = cap.InvokeMode,
            action,
            timestamp = DateTime.UtcNow,
        });

        try
        {
            // CancellationToken.None：客户端断开不取消服务器任务（server-authority.md）
            await foreach (var chunk in adapter.StreamExecuteAsync(context, CancellationToken.None))
            {
                switch (chunk.Type)
                {
                    case AgentChunkType.Text:
                        if (!string.IsNullOrEmpty(chunk.Content))
                            await WriteSseEventAsync("text", new { content = chunk.Content });
                        break;

                    case AgentChunkType.Artifact:
                        if (chunk.Artifact != null)
                            await WriteSseEventAsync("artifact", new
                            {
                                kind = chunk.Artifact.Type.ToString().ToLowerInvariant(),
                                url = chunk.Artifact.Url,
                                name = chunk.Artifact.Name,
                                mimeType = chunk.Artifact.MimeType,
                                content = chunk.Artifact.Content,
                            });
                        break;

                    case AgentChunkType.Error:
                        await WriteSseEventAsync("error", new { message = chunk.Content ?? "智能体执行失败" });
                        return;

                    case AgentChunkType.Done:
                        // 文本已逐块下发，Done 携带的 finalContent 此处不重复推送
                        break;
                }
            }

            await WriteSseEventAsync("done", new { timestamp = DateTime.UtcNow });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Agent universe invoke failed: {AgentKey}", cap.AgentKey);
            try { await WriteSseEventAsync("error", new { message = "智能体执行异常，请稍后重试" }); }
            catch { /* ignore */ }
        }
    }

    /// <summary>chat / 结构化模式下，把用户指令与参考文档合成为适配器的 UserMessage。</summary>
    private static string BuildDocUserMessage(string text, string? documentContent)
    {
        if (string.IsNullOrWhiteSpace(documentContent)) return text;
        if (string.IsNullOrWhiteSpace(text)) return documentContent!;
        return $"{text}\n\n[参考文档]\n{documentContent}";
    }

    private async Task WriteSseEventAsync(string eventName, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, JsonOptions);
            await Response.WriteAsync($"event: {eventName}\n");
            await Response.WriteAsync($"data: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }
}

/// <summary>统一调用信封请求体。</summary>
public class AgentInvokeRequest
{
    /// <summary>智能体标识（必填，对应 AgentCapability.AgentKey）。</summary>
    public string AgentKey { get; set; } = string.Empty;

    /// <summary>覆盖默认适配器动作（可选，留空走契约 DefaultAction）。</summary>
    public string? Action { get; set; }

    /// <summary>用户指令 / 文生图的画面描述。</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>参考文档全文（可选，chat / 结构化模式作为输入上下文合成）。</summary>
    public string? DocumentContent { get; set; }

    /// <summary>参考图 URL（可选，img2img / vision 用）。</summary>
    public List<string>? ImageUrls { get; set; }

    /// <summary>面板选择的智能体参数（如 size / model），透传给真实适配器。</summary>
    public Dictionary<string, string>? Parameters { get; set; }

    /// <summary>多轮历史（仅短气泡文本，不含文档）。</summary>
    public List<AgentInvokeHistoryItem>? History { get; set; }
}

/// <summary>历史消息项。</summary>
public class AgentInvokeHistoryItem
{
    public string Role { get; set; } = "user";
    public string Content { get; set; } = string.Empty;
}
