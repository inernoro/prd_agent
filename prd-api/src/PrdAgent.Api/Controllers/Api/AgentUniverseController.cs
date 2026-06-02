using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.AgentUniverse;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 智能体宇宙（Agent Universe）统一入口。
///
/// 一套标准把所有智能体接到一起（漫威宇宙式互通）：
/// 1) GET  capabilities —— 下发每个智能体的输入/输出/调用模式/交互形态契约（前后端 SSOT）
/// 2) POST invoke       —— 统一调用信封：根据契约的 InvokeMode 路由
///       generation → 对应 IAgentAdapter（真实生图，产出 image artifact）
///       chat/structured/transform → LLM Gateway 文本链路（用契约里的专属 SystemPrompt）
///
/// 所有产出统一为带类型的 SSE 事件（text / thinking / artifact / done / error），
/// 调用方（再加工抽屉 / 未来的 @艾特 / 工作流节点）只认这一套信封。
/// </summary>
[ApiController]
[Route("api/agent-universe")]
[Authorize]
[AdminController("ai-toolbox", AdminPermissionCatalog.AiToolboxUse)]
public class AgentUniverseController : ControllerBase
{
    private readonly ILlmGateway _gateway;
    private readonly IEnumerable<IAgentAdapter> _adapters;
    private readonly ILogger<AgentUniverseController> _logger;

    private static readonly JsonSerializerOptions JsonOptions =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AgentUniverseController(
        ILlmGateway gateway,
        IEnumerable<IAgentAdapter> adapters,
        ILogger<AgentUniverseController> logger)
    {
        _gateway = gateway;
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
    /// 统一调用信封（SSE 流式）。按能力契约的 InvokeMode 路由到适配器或通用 chat。
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

        // 生成型：路由到对应适配器，产出真实图片 artifact。找不到适配器则降级 chat。
        if (cap.InvokeMode == AgentInvokeModes.Generation)
        {
            var adapter = _adapters.FirstOrDefault(a => a.AgentKey == cap.AgentKey && a.CanHandle(action));
            if (adapter != null)
            {
                await RunAdapterAsync(adapter, cap, action, text, request, userId);
                return;
            }
            _logger.LogWarning("Agent universe: generation 智能体 {AgentKey} 未找到适配器动作 {Action}，降级 chat", cap.AgentKey, action);
        }

        await RunChatAsync(cap, text, request, userId);
    }

    /// <summary>
    /// 适配器路径：把 IAgentAdapter 的流式块映射成统一信封事件。
    /// </summary>
    private async Task RunAdapterAsync(
        IAgentAdapter adapter, AgentCapability cap, string action,
        string text, AgentInvokeRequest request, string userId)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            await WriteSseEventAsync("error", new { code = "EMPTY_INPUT", message = "请先输入描述内容" });
            return;
        }

        var context = new AgentExecutionContext
        {
            RunId = Guid.NewGuid().ToString("N"),
            TraceId = "agent-universe-" + Guid.NewGuid().ToString("N"),
            StepId = Guid.NewGuid().ToString("N"),
            UserId = userId,
            UserMessage = text,
            Action = action,
            Input = new Dictionary<string, object>(),
        };
        if (request.ImageUrls is { Count: > 0 })
        {
            context.Input["imageUrl"] = request.ImageUrls[0];
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
            _logger.LogError(ex, "Agent universe adapter invoke failed: {AgentKey}", cap.AgentKey);
            try { await WriteSseEventAsync("error", new { message = "智能体执行异常，请稍后重试" }); }
            catch { /* ignore */ }
        }
    }

    /// <summary>
    /// Chat 路径：用契约里的专属 SystemPrompt 走 LLM Gateway 文本链路。
    /// </summary>
    private async Task RunChatAsync(
        AgentCapability cap, string text, AgentInvokeRequest request, string userId)
    {
        if (string.IsNullOrWhiteSpace(text) && string.IsNullOrWhiteSpace(request.DocumentContent))
        {
            await WriteSseEventAsync("error", new { code = "INVALID", message = "消息内容不能为空" });
            return;
        }

        var systemPrompt = string.IsNullOrWhiteSpace(cap.SystemPrompt)
            ? "你是一位专业的智能助手，请根据用户需求提供准确、有条理的回答。"
            : cap.SystemPrompt;

        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt }
        };

        if (request.History != null)
        {
            foreach (var h in request.History.TakeLast(20))
            {
                if (string.IsNullOrWhiteSpace(h.Content)) continue;
                messages.Add(new JsonObject { ["role"] = h.Role, ["content"] = h.Content });
            }
        }

        // 当前轮：用户指令 + 参考文档（文档作为输入上下文，与历史里的短气泡解耦，避免重复嵌文档）
        var userContent = text;
        if (!string.IsNullOrWhiteSpace(request.DocumentContent))
        {
            userContent = string.IsNullOrWhiteSpace(text)
                ? request.DocumentContent!
                : $"{text}\n\n[参考文档]\n{request.DocumentContent}";
        }
        messages.Add(new JsonObject { ["role"] = "user", ["content"] = userContent });

        var appCaller = string.IsNullOrWhiteSpace(cap.ChatAppCallerCode)
            ? AppCallerRegistry.AiToolbox.Orchestration.Chat
            : cap.ChatAppCallerCode;

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = appCaller,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = true,
            RequestBody = new JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = 0.7,
                ["max_tokens"] = 4000,
            },
            Context = new GatewayRequestContext { UserId = userId, QuestionText = text },
        };

        try
        {
            GatewayTokenUsage? tokenUsage = null;

            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start)
                {
                    await WriteSseEventAsync("start", new
                    {
                        agentKey = cap.AgentKey,
                        invokeMode = cap.InvokeMode,
                        model = chunk.Resolution?.ActualModel,
                        platform = chunk.Resolution?.ActualPlatformName,
                        timestamp = DateTime.UtcNow,
                    });
                }
                else if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseEventAsync("thinking", new { content = chunk.Content }); }
                    catch (OperationCanceledException) { }
                    catch (ObjectDisposedException) { }
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseEventAsync("text", new { content = chunk.Content }); }
                    catch (OperationCanceledException) { }
                    catch (ObjectDisposedException) { }
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    tokenUsage = chunk.TokenUsage;
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteSseEventAsync("error", new { message = chunk.Error ?? "LLM 调用失败" });
                    return;
                }
            }

            await WriteSseEventAsync("done", new
            {
                promptTokens = tokenUsage?.InputTokens,
                completionTokens = tokenUsage?.OutputTokens,
                totalTokens = tokenUsage?.TotalTokens,
                timestamp = DateTime.UtcNow,
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Agent universe chat invoke failed: {AgentKey}", cap.AgentKey);
            try { await WriteSseEventAsync("error", new { message = "服务处理异常，请稍后重试" }); }
            catch { /* ignore */ }
        }
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

    /// <summary>参考文档全文（可选，chat 模式作为输入上下文注入）。</summary>
    public string? DocumentContent { get; set; }

    /// <summary>参考图 URL（可选，img2img / vision 用）。</summary>
    public List<string>? ImageUrls { get; set; }

    /// <summary>多轮历史（仅短气泡文本，不含文档）。</summary>
    public List<AgentInvokeHistoryItem>? History { get; set; }
}

/// <summary>历史消息项。</summary>
public class AgentInvokeHistoryItem
{
    public string Role { get; set; } = "user";
    public string Content { get; set; } = string.Empty;
}
