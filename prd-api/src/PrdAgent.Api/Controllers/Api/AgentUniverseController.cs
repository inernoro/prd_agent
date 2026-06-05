using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.AgentUniverse;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;

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
    private readonly IModelPoolQueryService _modelPoolQuery;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<AgentUniverseController> _logger;

    private static readonly JsonSerializerOptions JsonOptions =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AgentUniverseController(
        IEnumerable<IAgentAdapter> adapters,
        IModelPoolQueryService modelPoolQuery,
        ILLMRequestContextAccessor llmRequestContext,
        MongoDbContext db,
        ILlmGateway gateway,
        ILogger<AgentUniverseController> logger)
    {
        _adapters = adapters;
        _modelPoolQuery = modelPoolQuery;
        _llmRequestContext = llmRequestContext;
        _db = db;
        _gateway = gateway;
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
    /// 下发某智能体的「可选参数」（如视觉的尺寸/模型）。
    /// 选项一律来自该智能体**真实**的池/模型配置（不另起炉灶、不编造）；
    /// 只有确实存在多个可选项时才下发对应选择器（"如果可选则自己选"）。
    /// </summary>
    [HttpGet("agents/{agentKey}/parameters")]
    public async Task<IActionResult> AgentParameters(string agentKey, CancellationToken ct)
    {
        var parameters = new List<AgentParameter>();

        var cap = AgentCapabilityRegistry.Find(agentKey);
        if (cap == null)
            return Ok(ApiResponse<object>.Ok(new { parameters }));

        if (agentKey == "visual-agent")
        {
            // 模型：从该智能体自己原有的池拉真实可选模型（ai-toolbox.agent.visual::generation），
            // 不去碰/统一别的池。
            var pools = await _modelPoolQuery.GetModelPoolsAsync(
                AppCallerRegistry.AiToolbox.Agents.VisualGeneration, "generation", ct);
            var modelIds = pools
                .SelectMany(p => p.Models)
                .Select(m => m.ModelId)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct()
                .ToList();

            // 「如果可选」：≥2 个模型才给选择器；只有 1 个就别假装能选
            if (modelIds.Count >= 2)
            {
                parameters.Add(new AgentParameter
                {
                    Key = "model",
                    Label = "模型",
                    Options = modelIds.Select(id => new AgentParameterOption { Value = id, Label = id }).ToList(),
                    Default = modelIds[0],
                });
            }

            // 尺寸：取首个（最高优先级）模型在适配器注册表里的真实尺寸列表
            var primaryModel = modelIds.FirstOrDefault();
            var sizes = new List<string>();
            if (!string.IsNullOrWhiteSpace(primaryModel))
            {
                var cfg = ImageGenModelAdapterRegistry.TryMatch(primaryModel);
                if (cfg != null)
                    sizes = ImageGenModelAdapterRegistry.GetAllSizesFromConfig(cfg).Distinct().ToList();
            }
            if (sizes.Count >= 2)
            {
                parameters.Add(new AgentParameter
                {
                    Key = "size",
                    Label = "尺寸",
                    Options = sizes.Select(s => new AgentParameterOption { Value = s, Label = s }).ToList(),
                    Default = sizes[0],
                });
            }
        }

        return Ok(ApiResponse<object>.Ok(new { parameters }));
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

        // 百宝箱自定义智能体（用户自建的通用智能体）：agentKey 形如 "custom:{itemId}"。
        // 走同一套 invoke 信封，实时从库加载它的 systemPrompt（单一数据源，改了立即生效），
        // 跑真实网关 chat —— 这不是仿冒：自定义 chat 智能体的"真实组件"就是它的 prompt+网关。
        // 新建任意自定义智能体 → 自动可经此路径调用，零代码接入。
        if ((request.AgentKey ?? string.Empty).StartsWith("custom:", StringComparison.Ordinal))
        {
            var itemId = request.AgentKey!["custom:".Length..];
            await RunCustomAgentAsync(itemId, request, userId);
            return;
        }

        var cap = AgentCapabilityRegistry.Find(request.AgentKey);
        if (cap == null)
        {
            await WriteSseEventAsync("error", new { code = "UNKNOWN_AGENT", message = $"未知智能体: {request.AgentKey}" });
            return;
        }

        // 权限隔离：统一 invoke 不能绕过各智能体自己的原生权限门（Codex P1）。每个能力对应
        // "{agentKey}.use"（visual-agent.use / defect-agent.use / literary-agent.use / prd-agent.use），
        // 与 ImageGenController / DefectAgentController 的 AdminController 门一致；root/super 自动放行。
        var requiredPerm = $"{cap.AgentKey}.use";
        if (!HasPermission(requiredPerm))
        {
            await WriteSseEventAsync("error", new
            {
                code = "PERMISSION_DENIED",
                message = $"需要「{cap.Name}」权限（{requiredPerm}），当前账号未开通，请联系管理员。",
            });
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

        // 多轮上下文：适配器没有独立 history 通道，把短气泡历史折叠进当前消息前缀，
        // 让 chat / 结构化智能体也能看到上文（Cursor High / Codex P2：invoke 丢 history）。生成型无需。
        if (cap.InvokeMode != AgentInvokeModes.Generation)
            userMessage = PrependHistory(userMessage, request.History);

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

        // 设置 LLM 请求上下文，让真实适配器 / 生图客户端拿到 UserId
        // （否则 [LlmLog] UserId 为空 告警 + 生成资产归属丢失；llm-gateway.md 规则）
        using var _llmScope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: request.DocumentContent?.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"agent-universe:{cap.AgentKey}:{action}",
            RequestType: cap.InvokeMode,
            AppCallerCode: null));

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
                    case AgentChunkType.Model:
                        // 真实解析到的模型 / 平台，单独发 model 事件给前端做「当前模型」可观测性展示
                        await WriteSseEventAsync("model", new { model = chunk.Model, platform = chunk.Platform });
                        break;

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

    /// <summary>
    /// 自定义百宝箱智能体的统一执行：实时读库取 systemPrompt（+知识库），跑真实网关 chat。
    /// systemPrompt 每次实时从 ToolboxItem 读取 = 单一数据源，用户改了配置立即生效、零漂移。
    /// </summary>
    private async Task RunCustomAgentAsync(string itemId, AgentInvokeRequest request, string userId)
    {
        var text = (request.Text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text) && string.IsNullOrWhiteSpace(request.DocumentContent))
        {
            await WriteSseEventAsync("error", new { code = "EMPTY_INPUT", message = "请先输入内容" });
            return;
        }

        // 可见性口径与 direct-chat 一致：自己创建的 + 他人公开的都可调用
        var item = await _db.ToolboxItems
            .Find(x => x.Id == itemId && (x.CreatedByUserId == userId || x.IsPublic))
            .FirstOrDefaultAsync(CancellationToken.None);
        if (item == null)
        {
            await WriteSseEventAsync("error", new { code = "NOT_FOUND", message = "智能体不存在或未公开" });
            return;
        }

        var systemPrompt = item.SystemPrompt ?? string.Empty;

        // 知识库注入：该智能体真实关联的资料（与 direct-chat 行为一致）
        if (item.KnowledgeBaseIds is { Count: > 0 })
        {
            var kbFilter = Builders<Attachment>.Filter.In(a => a.AttachmentId, item.KnowledgeBaseIds);
            var kbDocs = await _db.Attachments.Find(kbFilter).ToListAsync(CancellationToken.None);
            var kbParts = kbDocs
                .Where(d => !string.IsNullOrWhiteSpace(d.ExtractedText))
                .Select(d => $"=== {d.FileName} ===\n{d.ExtractedText}")
                .ToList();
            if (kbParts.Count > 0)
                systemPrompt += "\n\n## 知识库参考资料\n以下是该智能体的知识库内容，请基于这些内容回答：\n\n"
                                + string.Join("\n\n", kbParts);
        }

        // 工具能力注入：自定义体配置的 EnabledTools（webSearch/imageGen/...）必须像 direct-chat 一样
        // 折叠进 systemPrompt，否则统一 invoke 路径下这些能力静默丢失（Cursor/Codex P2）。
        systemPrompt = ToolboxPromptEnricher.EnrichSystemPromptWithTools(systemPrompt, item.EnabledTools);

        var userMessage = BuildDocUserMessage(text, request.DocumentContent);

        // 使用次数 +1（与 direct-chat 一致）
        await _db.ToolboxItems.UpdateOneAsync(
            x => x.Id == itemId,
            Builders<ToolboxItem>.Update.Inc(x => x.UsageCount, 1),
            cancellationToken: CancellationToken.None);

        using var _llmScope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: request.DocumentContent?.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"agent-universe:custom:{itemId}",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.AiToolbox.Orchestration.Chat));

        await WriteSseEventAsync("start", new
        {
            agentKey = "custom:" + itemId,
            invokeMode = "chat",
            action = "chat",
            timestamp = DateTime.UtcNow,
        });

        // 多轮历史：把短气泡历史插在 system 与当前 user 之间，恢复 direct-chat 的多轮上下文
        // （Cursor High / Codex P2：invoke 丢 history）。
        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
        };
        if (request.History is { Count: > 0 })
        {
            foreach (var h in request.History)
            {
                if (string.IsNullOrWhiteSpace(h.Content)) continue;
                messages.Add(new JsonObject
                {
                    ["role"] = h.Role == "assistant" ? "assistant" : "user",
                    ["content"] = h.Content,
                });
            }
        }
        messages.Add(new JsonObject { ["role"] = "user", ["content"] = userMessage });

        var gwReq = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = item.Temperature,
            },
            Context = new GatewayRequestContext { UserId = userId },
        };

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gwReq, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                    await WriteSseEventAsync("text", new { content = chunk.Content });
            }
            await WriteSseEventAsync("done", new { timestamp = DateTime.UtcNow });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Agent universe custom invoke failed: {ItemId}", itemId);
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

    /// <summary>把多轮历史（短气泡文本）折叠进当前用户消息前缀，让无独立 history 通道的适配器也能看到上文。</summary>
    private static string PrependHistory(string userMessage, List<AgentInvokeHistoryItem>? history)
    {
        if (history == null || history.Count == 0) return userMessage;
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("[对话历史]");
        foreach (var h in history)
        {
            if (string.IsNullOrWhiteSpace(h.Content)) continue;
            sb.AppendLine($"{(h.Role == "assistant" ? "助手" : "用户")}：{h.Content}");
        }
        sb.AppendLine();
        sb.AppendLine("[当前指令]");
        sb.Append(userMessage);
        return sb.ToString();
    }

    /// <summary>是否具备指定权限（中间件已把有效权限注入 permissions claim）。super 视为全通过。</summary>
    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
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
