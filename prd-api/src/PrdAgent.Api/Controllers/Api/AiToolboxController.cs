using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// AI 百宝箱 Controller
/// 统一入口，支持自然语言驱动的多 Agent 协同
/// </summary>
[ApiController]
[Route("api/ai-toolbox")]
[Authorize]
[AdminController("ai-toolbox", AdminPermissionCatalog.AiToolboxUse)]
public class AiToolboxController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IIntentClassifier _intentClassifier;
    private readonly IToolboxOrchestrator _orchestrator;
    private readonly IToolboxEventStore _eventStore;
    private readonly IRunQueue _runQueue;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<AiToolboxController> _logger;

    private const string AppKey = "ai-toolbox";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AiToolboxController(
        MongoDbContext db,
        IIntentClassifier intentClassifier,
        IToolboxOrchestrator orchestrator,
        IToolboxEventStore eventStore,
        IRunQueue runQueue,
        ILlmGateway gateway,
        ILogger<AiToolboxController> logger)
    {
        _db = db;
        _intentClassifier = intentClassifier;
        _orchestrator = orchestrator;
        _eventStore = eventStore;
        _runQueue = runQueue;
        _gateway = gateway;
        _logger = logger;
    }

    private string GetUserId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    private string? GetUserName() =>
        User.FindFirst("name")?.Value;

    /// <summary>
    /// 发送消息到百宝箱
    /// 自动识别意图并路由到合适的 Agent
    /// </summary>
    [HttpPost("chat")]
    [ProducesResponseType(typeof(ApiResponse<ToolboxChatResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Chat([FromBody] ToolboxChatRequest request, CancellationToken ct)
    {
        var userId = GetUserId();

        // 验证输入
        var message = (request.Message ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(message))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "消息内容不能为空"));
        }

        if (message.Length > 10000)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "消息内容过长（最大 10000 字符）"));
        }

        _logger.LogInformation("百宝箱收到消息: UserId={UserId}, Length={Length}", userId, message.Length);

        // Step 1: 意图识别
        var intent = await _intentClassifier.ClassifyAsync(message, ct);

        _logger.LogInformation("意图识别完成: PrimaryIntent={Intent}, Confidence={Confidence}, Agents={Agents}",
            intent.PrimaryIntent, intent.Confidence, string.Join(",", intent.SuggestedAgents));

        // Step 2: 创建运行记录
        var run = new ToolboxRun
        {
            Id = ObjectId.GenerateNewId().ToString(),
            UserId = userId,
            SessionId = request.SessionId,
            UserMessage = message,
            Intent = intent,
            PlannedAgents = intent.SuggestedAgents,
            Status = ToolboxRunStatus.Pending
        };

        // 根据意图创建执行步骤
        for (var i = 0; i < intent.SuggestedAgents.Count; i++)
        {
            var agentKey = intent.SuggestedAgents[i];
            var agentDef = AgentRegistry.GetByKey(agentKey);

            run.Steps.Add(new ToolboxRunStep
            {
                Index = i,
                AgentKey = agentKey,
                AgentDisplayName = agentDef?.DisplayName ?? agentKey,
                Action = GetDefaultActionForAgent(agentKey, intent, i, intent.SuggestedAgents.Count),
                Input = new Dictionary<string, object>
                {
                    ["userMessage"] = message,
                    ["entities"] = intent.Entities
                }
            });
        }

        // 保存运行记录
        await _db.ToolboxRuns.InsertOneAsync(run, cancellationToken: ct);

        _logger.LogInformation("百宝箱 Run 已创建: RunId={RunId}, Steps={StepCount}", run.Id, run.Steps.Count);

        // Step 3: 根据选项决定是否自动执行
        var autoExecute = request.Options?.AutoExecute ?? true;
        if (autoExecute && run.Steps.Count > 0)
        {
            // 入队等待后台执行
            await _runQueue.EnqueueAsync(ToolboxRunWorker.RunKind, run.Id, ct);
            _logger.LogInformation("Run 已入队: {RunId}", run.Id);
        }

        // 返回响应
        var response = new ToolboxChatResponse
        {
            RunId = run.Id,
            Intent = intent,
            PlannedAgents = intent.SuggestedAgents.Select(key =>
            {
                var def = AgentRegistry.GetByKey(key);
                return new AgentInfo
                {
                    AgentKey = key,
                    DisplayName = def?.DisplayName ?? key,
                    Description = def?.Description ?? string.Empty
                };
            }).ToList(),
            Steps = run.Steps.Select(s => new StepInfo
            {
                StepId = s.StepId,
                Index = s.Index,
                AgentKey = s.AgentKey,
                AgentDisplayName = s.AgentDisplayName,
                Action = s.Action,
                Status = s.Status.ToString().ToLowerInvariant()
            }).ToList(),
            Status = autoExecute ? "queued" : "pending",
            SseUrl = $"/api/ai-toolbox/runs/{run.Id}/stream"
        };

        return Ok(ApiResponse<ToolboxChatResponse>.Ok(response));
    }

    /// <summary>
    /// 仅进行意图识别（不执行）
    /// </summary>
    [HttpPost("analyze")]
    [ProducesResponseType(typeof(ApiResponse<IntentResult>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Analyze([FromBody] ToolboxAnalyzeRequest request, CancellationToken ct)
    {
        var message = (request.Message ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(message))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "消息内容不能为空"));
        }

        var intent = await _intentClassifier.ClassifyAsync(message, ct);
        return Ok(ApiResponse<IntentResult>.Ok(intent));
    }

    /// <summary>
    /// 手动触发执行
    /// </summary>
    [HttpPost("runs/{runId}/execute")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ExecuteRun(string runId, CancellationToken ct)
    {
        var userId = GetUserId();
        var run = await _db.ToolboxRuns.Find(x => x.Id == runId && x.UserId == userId).FirstOrDefaultAsync(ct);

        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "运行记录不存在"));
        }

        if (run.Status != ToolboxRunStatus.Pending)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"当前状态不允许执行: {run.Status}"));
        }

        await _runQueue.EnqueueAsync(ToolboxRunWorker.RunKind, run.Id, ct);
        return Ok(ApiResponse<object>.Ok(new { message = "已加入执行队列" }));
    }

    /// <summary>
    /// 获取运行记录详情
    /// </summary>
    [HttpGet("runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<ToolboxRun>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var userId = GetUserId();
        runId = (runId ?? string.Empty).Trim();

        if (string.IsNullOrWhiteSpace(runId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        }

        var run = await _db.ToolboxRuns.Find(x => x.Id == runId && x.UserId == userId).FirstOrDefaultAsync(ct);
        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "运行记录不存在"));
        }

        return Ok(ApiResponse<ToolboxRun>.Ok(run));
    }

    /// <summary>
    /// 获取用户的运行历史
    /// </summary>
    [HttpGet("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListRuns(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var filter = Builders<ToolboxRun>.Filter.Eq(x => x.UserId, userId);
        var total = await _db.ToolboxRuns.CountDocumentsAsync(filter, cancellationToken: ct);

        var runs = await _db.ToolboxRuns
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            items = runs.Select(r => new
            {
                r.Id,
                r.UserMessage,
                intent = r.Intent?.PrimaryIntent,
                status = r.Status.ToString().ToLowerInvariant(),
                agentCount = r.PlannedAgents.Count,
                r.CreatedAt,
                r.CompletedAt
            }),
            total,
            page,
            pageSize
        }));
    }

    /// <summary>
    /// 获取可用的 Agent 列表
    /// </summary>
    [HttpGet("agents")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public IActionResult ListAgents()
    {
        var agents = AgentRegistry.All.Select(a => new
        {
            a.AgentKey,
            a.DisplayName,
            a.Description,
            a.SupportedIntents,
            a.SupportedActions
        });

        return Ok(ApiResponse<object>.Ok(new { agents }));
    }

    /// <summary>
    /// SSE 流式获取运行事件
    /// </summary>
    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string runId, [FromQuery] long? afterSeq, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();
        runId = (runId ?? string.Empty).Trim();

        var run = await _db.ToolboxRuns.Find(x => x.Id == runId && x.UserId == userId).FirstOrDefaultAsync(ct);
        if (run == null)
        {
            await WriteEventAsync("error", new { code = "NOT_FOUND", message = "运行记录不存在" }, ct);
            return;
        }

        var lastSeq = afterSeq ?? 0;

        // 首先发送历史事件（断线重连场景）
        await foreach (var evt in _eventStore.GetEventsAsync(runId, lastSeq, ct))
        {
            await WriteEventAsync(GetEventName(evt.Type), evt, ct);
            lastSeq = evt.Seq;
        }

        // 如果 Run 已完成，直接返回
        if (run.Status is ToolboxRunStatus.Completed or ToolboxRunStatus.Failed or ToolboxRunStatus.Cancelled)
        {
            await WriteEventAsync("done", new
            {
                runId = run.Id,
                status = run.Status.ToString().ToLowerInvariant(),
                finalResponse = run.FinalResponse,
                artifacts = run.Artifacts
            }, ct);
            return;
        }

        // 轮询等待新事件
        var pollInterval = TimeSpan.FromMilliseconds(500);
        var timeout = TimeSpan.FromMinutes(10);
        var startTime = DateTime.UtcNow;

        while (!ct.IsCancellationRequested && DateTime.UtcNow - startTime < timeout)
        {
            // 获取新事件
            var hasNewEvents = false;
            await foreach (var evt in _eventStore.GetEventsAsync(runId, lastSeq, ct))
            {
                await WriteEventAsync(GetEventName(evt.Type), evt, ct);
                lastSeq = evt.Seq;
                hasNewEvents = true;

                // 如果是完成或失败事件，结束流
                if (evt.Type is ToolboxRunEventType.RunCompleted or ToolboxRunEventType.RunFailed)
                {
                    return;
                }
            }

            if (!hasNewEvents)
            {
                // 发送心跳
                await WriteEventAsync("ping", new { timestamp = DateTime.UtcNow }, ct);
                await Task.Delay(pollInterval, ct);
            }

            // 重新检查 Run 状态
            run = await _db.ToolboxRuns.Find(x => x.Id == runId).FirstOrDefaultAsync(ct);
            if (run?.Status is ToolboxRunStatus.Completed or ToolboxRunStatus.Failed or ToolboxRunStatus.Cancelled)
            {
                await WriteEventAsync("done", new
                {
                    runId = run.Id,
                    status = run.Status.ToString().ToLowerInvariant(),
                    finalResponse = run.FinalResponse,
                    artifacts = run.Artifacts
                }, ct);
                return;
            }
        }
    }

    private async Task WriteEventAsync(string eventName, object data, CancellationToken ct)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, JsonOptions);
            await Response.WriteAsync($"event: {eventName}\n", ct);
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
        catch (OperationCanceledException)
        {
            // 客户端断开连接
        }
        catch (ObjectDisposedException)
        {
            // 连接已关闭
        }
    }

    private static string GetEventName(ToolboxRunEventType type) => type switch
    {
        ToolboxRunEventType.RunStarted => "run_started",
        ToolboxRunEventType.StepStarted => "step_started",
        ToolboxRunEventType.StepProgress => "step_progress",
        ToolboxRunEventType.StepArtifact => "step_artifact",
        ToolboxRunEventType.StepCompleted => "step_completed",
        ToolboxRunEventType.StepFailed => "step_failed",
        ToolboxRunEventType.RunCompleted => "run_completed",
        ToolboxRunEventType.RunFailed => "run_failed",
        _ => "unknown"
    };

    #region ToolboxItem CRUD

    /// <summary>
    /// 获取自定义工具列表
    /// </summary>
    [HttpGet("items")]
    public async Task<IActionResult> ListItems(
        [FromQuery] string? category,
        [FromQuery] string? keyword,
        CancellationToken ct)
    {
        var userId = GetUserId();
        var filterBuilder = Builders<ToolboxItem>.Filter;
        var filter = filterBuilder.Eq(x => x.CreatedByUserId, userId);

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var keywordFilter = filterBuilder.Or(
                filterBuilder.Regex(x => x.Name, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                filterBuilder.Regex(x => x.Description, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))
            );
            filter &= keywordFilter;
        }

        var items = await _db.ToolboxItems
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(200)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 获取工具详情
    /// </summary>
    [HttpGet("items/{id}")]
    public async Task<IActionResult> GetItem(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var item = await _db.ToolboxItems.Find(x => x.Id == id && x.CreatedByUserId == userId).FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工具不存在"));

        return Ok(ApiResponse<ToolboxItem>.Ok(item));
    }

    /// <summary>
    /// 创建自定义工具
    /// </summary>
    [HttpPost("items")]
    public async Task<IActionResult> CreateItem([FromBody] CreateToolboxItemRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "名称不能为空"));
        if (string.IsNullOrWhiteSpace(request.Prompt))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "系统提示词不能为空"));

        var userId = GetUserId();
        var item = new ToolboxItem
        {
            Id = ObjectId.GenerateNewId().ToString(),
            Name = request.Name.Trim(),
            Description = (request.Description ?? string.Empty).Trim(),
            Icon = request.Icon ?? "Bot",
            Tags = request.Tags ?? new List<string>(),
            SystemPrompt = request.Prompt.Trim(),
            WelcomeMessage = request.WelcomeMessage,
            ConversationStarters = request.ConversationStarters ?? new List<string>(),
            EnabledTools = request.EnabledTools ?? new List<string>(),
            Temperature = Math.Clamp(request.Temperature ?? 0.7, 0, 1),
            EnableMemory = request.EnableMemory ?? false,
            CreatedByUserId = userId,
            CreatedByName = GetUserName(),
        };

        await _db.ToolboxItems.InsertOneAsync(item, cancellationToken: ct);
        return Ok(ApiResponse<ToolboxItem>.Ok(item));
    }

    /// <summary>
    /// 更新工具
    /// </summary>
    [HttpPut("items/{id}")]
    public async Task<IActionResult> UpdateItem(string id, [FromBody] CreateToolboxItemRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var item = await _db.ToolboxItems.Find(x => x.Id == id && x.CreatedByUserId == userId).FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工具不存在"));

        var update = Builders<ToolboxItem>.Update
            .Set(x => x.Name, (request.Name ?? item.Name).Trim())
            .Set(x => x.Description, (request.Description ?? item.Description).Trim())
            .Set(x => x.Icon, request.Icon ?? item.Icon)
            .Set(x => x.Tags, request.Tags ?? item.Tags)
            .Set(x => x.SystemPrompt, (request.Prompt ?? item.SystemPrompt).Trim())
            .Set(x => x.WelcomeMessage, request.WelcomeMessage ?? item.WelcomeMessage)
            .Set(x => x.ConversationStarters, request.ConversationStarters ?? item.ConversationStarters)
            .Set(x => x.EnabledTools, request.EnabledTools ?? item.EnabledTools)
            .Set(x => x.Temperature, Math.Clamp(request.Temperature ?? item.Temperature, 0, 1))
            .Set(x => x.EnableMemory, request.EnableMemory ?? item.EnableMemory)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.ToolboxItems.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);
        var updated = await _db.ToolboxItems.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<ToolboxItem>.Ok(updated));
    }

    /// <summary>
    /// 删除工具
    /// </summary>
    [HttpDelete("items/{id}")]
    public async Task<IActionResult> DeleteItem(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var result = await _db.ToolboxItems.DeleteOneAsync(x => x.Id == id && x.CreatedByUserId == userId, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工具不存在"));

        return Ok(ApiResponse<object>.Ok(new { message = "已删除" }));
    }

    /// <summary>
    /// 运行工具（创建 Run 并入队）
    /// </summary>
    [HttpPost("items/{id}/run")]
    public async Task<IActionResult> RunItem(string id, [FromBody] RunToolboxItemRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var item = await _db.ToolboxItems.Find(x => x.Id == id && x.CreatedByUserId == userId).FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工具不存在"));

        // 增加使用次数
        await _db.ToolboxItems.UpdateOneAsync(
            x => x.Id == id,
            Builders<ToolboxItem>.Update.Inc(x => x.UsageCount, 1),
            cancellationToken: ct);

        // 使用 direct-chat 流式返回
        return Ok(ApiResponse<object>.Ok(new
        {
            runId = ObjectId.GenerateNewId().ToString(),
            itemId = id,
            status = "use_direct_chat"
        }));
    }

    #endregion

    #region Direct Chat (SSE Streaming)

    /// <summary>
    /// 直接对话（SSE 流式）
    /// 用于普通版 Agent 和自定义智能体的对话，绕过复杂的意图编排流程
    /// </summary>
    [HttpPost("direct-chat")]
    [Produces("text/event-stream")]
    public async Task DirectChat([FromBody] DirectChatRequest request)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        // 验证
        var message = (request.Message ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(message))
        {
            await WriteSseEventAsync("error", new { code = "INVALID", message = "消息内容不能为空" });
            return;
        }

        // 确定系统提示词
        string systemPrompt;
        double temperature = 0.7;
        string appCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat;

        if (!string.IsNullOrWhiteSpace(request.ItemId))
        {
            // 自定义智能体：从 DB 加载配置
            var item = await _db.ToolboxItems.Find(x => x.Id == request.ItemId && x.CreatedByUserId == userId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (item == null)
            {
                await WriteSseEventAsync("error", new { code = "NOT_FOUND", message = "智能体不存在" });
                return;
            }
            systemPrompt = item.SystemPrompt;
            temperature = item.Temperature;

            // 增加使用次数
            await _db.ToolboxItems.UpdateOneAsync(
                x => x.Id == request.ItemId,
                Builders<ToolboxItem>.Update.Inc(x => x.UsageCount, 1),
                cancellationToken: CancellationToken.None);
        }
        else if (!string.IsNullOrWhiteSpace(request.AgentKey))
        {
            // 内置普通版 Agent：使用预定义系统提示词
            systemPrompt = GetBuiltinAgentSystemPrompt(request.AgentKey);
            appCallerCode = GetAgentAppCallerCode(request.AgentKey);
        }
        else
        {
            // 通用对话
            systemPrompt = "你是 AI 百宝箱的智能助手，能够帮助用户完成各种任务。请根据用户的需求提供专业、准确的回答。";
        }

        // 构建消息列表
        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt }
        };

        // 添加历史消息
        if (request.History != null)
        {
            foreach (var h in request.History.TakeLast(20))
            {
                messages.Add(new JsonObject
                {
                    ["role"] = h.Role,
                    ["content"] = h.Content
                });
            }
        }

        // 添加当前消息
        messages.Add(new JsonObject { ["role"] = "user", ["content"] = message });

        // 调用 LLM Gateway
        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = temperature,
                ["max_tokens"] = 4000
            },
            Context = new GatewayRequestContext
            {
                UserId = userId,
                QuestionText = message
            }
        };

        _logger.LogInformation("Direct chat: UserId={UserId}, AgentKey={AgentKey}, ItemId={ItemId}",
            userId, request.AgentKey, request.ItemId);

        try
        {
            await WriteSseEventAsync("start", new { timestamp = DateTime.UtcNow });

            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (!string.IsNullOrEmpty(chunk.Content))
                {
                    try
                    {
                        await WriteSseEventAsync("text", new { content = chunk.Content });
                    }
                    catch (OperationCanceledException) { /* 客户端断开 */ }
                    catch (ObjectDisposedException) { /* 连接关闭 */ }
                }

                if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteSseEventAsync("error", new { message = chunk.Error ?? "LLM 调用失败" });
                    return;
                }
            }

            await WriteSseEventAsync("done", new { timestamp = DateTime.UtcNow });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Direct chat failed");
            try
            {
                await WriteSseEventAsync("error", new { message = "服务处理异常，请稍后重试" });
            }
            catch { /* ignore */ }
        }
    }

    /// <summary>
    /// 基础能力对话（SSE 流式）
    /// </summary>
    [HttpPost("capabilities/{capabilityKey}/chat")]
    [Produces("text/event-stream")]
    public async Task CapabilityChat(string capabilityKey, [FromBody] DirectChatRequest request)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();
        var message = (request.Message ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(message))
        {
            await WriteSseEventAsync("error", new { code = "INVALID", message = "消息内容不能为空" });
            return;
        }

        // 获取能力配置
        var (systemPrompt, modelType, appCallerCode) = GetCapabilityConfig(capabilityKey);
        if (systemPrompt == null)
        {
            await WriteSseEventAsync("error", new { code = "NOT_FOUND", message = $"未知能力: {capabilityKey}" });
            return;
        }

        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt }
        };

        if (request.History != null)
        {
            foreach (var h in request.History.TakeLast(20))
            {
                messages.Add(new JsonObject { ["role"] = h.Role, ["content"] = h.Content });
            }
        }
        messages.Add(new JsonObject { ["role"] = "user", ["content"] = message });

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = modelType,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = 0.7,
                ["max_tokens"] = 4000
            },
            Context = new GatewayRequestContext { UserId = userId, QuestionText = message }
        };

        try
        {
            await WriteSseEventAsync("start", new { capability = capabilityKey, timestamp = DateTime.UtcNow });

            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (!string.IsNullOrEmpty(chunk.Content))
                {
                    try
                    {
                        await WriteSseEventAsync("text", new { content = chunk.Content });
                    }
                    catch (OperationCanceledException) { }
                    catch (ObjectDisposedException) { }
                }

                if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteSseEventAsync("error", new { message = chunk.Error ?? "调用失败" });
                    return;
                }
            }

            await WriteSseEventAsync("done", new { timestamp = DateTime.UtcNow });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Capability chat failed: {Key}", capabilityKey);
            try
            {
                await WriteSseEventAsync("error", new { message = "服务处理异常，请稍后重试" });
            }
            catch { /* ignore */ }
        }
    }

    #endregion

    #region Helpers

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

    /// <summary>
    /// 内置普通版 Agent 系统提示词
    /// </summary>
    private static string GetBuiltinAgentSystemPrompt(string agentKey) => agentKey switch
    {
        "code-reviewer" => """
            你是一位资深的代码审查专家。你的职责是：
            1. 分析代码的质量、可读性和可维护性
            2. 发现潜在的 Bug、安全漏洞和性能问题
            3. 提供具体的改进建议和最佳实践
            4. 评估代码的架构设计合理性
            请用结构化的方式输出审查结果，包括：问题严重程度（Critical/Warning/Info）、问题描述、建议修改方案。
            """,
        "translator" => """
            你是一位专业的多语言翻译专家，精通中文、英文、日文、韩文等主要语言。你的翻译原则：
            1. 准确传达原文含义，不添加或遗漏信息
            2. 符合目标语言的表达习惯和文化背景
            3. 专业术语保持一致性
            4. 对于歧义之处，提供多种可能的翻译
            请自动检测源语言，默认翻译为中文（如果源语言是中文则翻译为英文）。
            """,
        "summarizer" => """
            你是一位内容摘要专家，擅长从长文本中提取关键信息。你的工作方式：
            1. 识别文本的核心主题和关键论点
            2. 提取重要数据、事实和结论
            3. 保持摘要的逻辑连贯性
            4. 根据内容长度生成适当比例的摘要
            请按以下格式输出：
            **核心要点**：（3-5 个要点）
            **详细摘要**：（结构化总结）
            **关键数据**：（如有数字或数据）
            """,
        "data-analyst" => """
            你是一位数据分析专家，擅长数据解读和可视化建议。你的能力包括：
            1. 分析数据趋势、异常和模式
            2. 提供统计分析思路和方法建议
            3. 推荐合适的数据可视化图表类型
            4. 给出数据驱动的业务洞察
            请用结构化方式回答，包含：分析思路、关键发现、可视化建议、行动建议。
            """,
        "prd-agent" => "你是一位专业的产品经理，擅长 PRD 分析和需求解读。帮助用户分析需求文档，发现潜在问题，回答产品相关问题。",
        "visual-agent" => "你是一位视觉设计专家，帮助用户描述和规划视觉创作需求，提供设计建议和创意方向。",
        "literary-agent" => "你是一位文学创作专家，擅长各类文体的创作和润色。可以帮助用户创作文章、故事、诗歌等文学作品，也可以对已有内容进行润色和改进。",
        "defect-agent" => "你是一位质量保证专家，擅长缺陷分析和管理。帮助用户从描述中提取结构化的缺陷信息，包括标题、描述、复现步骤、严重程度等。",
        _ => "你是 AI 百宝箱的智能助手，能够帮助用户完成各种任务。请根据用户的需求提供专业、准确的回答。"
    };

    private static string GetAgentAppCallerCode(string agentKey) => agentKey switch
    {
        "prd-agent" => AppCallerRegistry.AiToolbox.Agents.PrdChat,
        "visual-agent" => AppCallerRegistry.AiToolbox.Agents.VisualChat,
        "literary-agent" => AppCallerRegistry.AiToolbox.Agents.LiteraryChat,
        "defect-agent" => AppCallerRegistry.AiToolbox.Agents.DefectChat,
        _ => AppCallerRegistry.AiToolbox.Orchestration.Chat
    };

    /// <summary>
    /// 基础能力配置
    /// </summary>
    private static (string? systemPrompt, string modelType, string appCallerCode) GetCapabilityConfig(string key) => key switch
    {
        "text-gen" => (
            "你是一位智能文本生成助手，能够根据用户需求生成高质量的文本内容。",
            ModelTypes.Chat,
            AppCallerRegistry.AiToolbox.Orchestration.Chat
        ),
        "reasoning" => (
            "你是一位逻辑推理专家，擅长复杂问题的分析和多步骤推理。请展示你的推理过程，用清晰的步骤说明你是如何得出结论的。",
            ModelTypes.Chat,
            AppCallerRegistry.AiToolbox.Orchestration.Chat
        ),
        "web-search" => (
            "你是一位信息搜索助手。虽然你无法直接访问互联网，但你可以基于已有知识回答问题，并建议用户可以搜索的关键词和方向。",
            ModelTypes.Chat,
            AppCallerRegistry.AiToolbox.Orchestration.Chat
        ),
        "code-interpreter" => (
            "你是一位编程专家，可以帮助用户编写、解释和调试代码。支持 Python、JavaScript、TypeScript、C#、Go、Java 等主流编程语言。请在回答中提供可执行的代码示例。",
            ModelTypes.Chat,
            AppCallerRegistry.AiToolbox.Orchestration.Chat
        ),
        "file-reader" => (
            "你是一位文档分析专家，帮助用户理解和分析文档内容。请根据用户提供的文本进行分析和解答。",
            ModelTypes.Chat,
            AppCallerRegistry.AiToolbox.Orchestration.Chat
        ),
        "mcp-tools" => (
            "你是 MCP (Model Context Protocol) 工具集成助手。帮助用户了解和使用 MCP 工具扩展 AI 的能力。",
            ModelTypes.Chat,
            AppCallerRegistry.AiToolbox.Orchestration.Chat
        ),
        "image-gen" => (
            "你是一位图片生成助手。帮助用户优化图片描述提示词（Prompt），提供构图和风格建议。注意：当前通过文本对话提供建议，实际图片生成请使用视觉设计师工具。",
            ModelTypes.Chat,
            AppCallerRegistry.AiToolbox.Orchestration.Chat
        ),
        _ => (null!, string.Empty, string.Empty)
    };

    #endregion

    /// <summary>
    /// 根据 Agent 和意图确定默认动作
    /// </summary>
    private static string GetDefaultActionForAgent(string agentKey, IntentResult intent, int stepIndex, int totalSteps)
    {
        // 多步骤串行场景：如果是 visual-agent 且不是第一步，说明需要基于前序内容生成图
        if (agentKey == "visual-agent" && stepIndex > 0)
        {
            return "text2img"; // 基于前序内容生成图
        }

        // 如果是 literary-agent 且后面还有 visual-agent，说明是"写文章+配图"场景
        if (agentKey == "literary-agent" && intent.PrimaryIntent == IntentTypes.Composite)
        {
            return "write_content";
        }

        return agentKey switch
        {
            "prd-agent" => "analyze_prd",
            "visual-agent" => "text2img",
            "literary-agent" => intent.PrimaryIntent == IntentTypes.ImageGen ? "generate_illustration" : "write_content",
            "defect-agent" => "extract_defect",
            _ => "execute"
        };
    }
}

#region Request/Response Models

/// <summary>
/// 百宝箱聊天请求
/// </summary>
public class ToolboxChatRequest
{
    /// <summary>
    /// 用户消息
    /// </summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>
    /// 会话 ID（可选，用于关联上下文）
    /// </summary>
    public string? SessionId { get; set; }

    /// <summary>
    /// 选项
    /// </summary>
    public ToolboxChatOptions? Options { get; set; }
}

/// <summary>
/// 聊天选项
/// </summary>
public class ToolboxChatOptions
{
    /// <summary>
    /// 是否自动执行（默认 true）
    /// </summary>
    public bool AutoExecute { get; set; } = true;

    /// <summary>
    /// 优先使用的 Agent 列表
    /// </summary>
    public List<string>? PreferredAgents { get; set; }
}

/// <summary>
/// 意图分析请求
/// </summary>
public class ToolboxAnalyzeRequest
{
    /// <summary>
    /// 用户消息
    /// </summary>
    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// 百宝箱聊天响应
/// </summary>
public class ToolboxChatResponse
{
    /// <summary>
    /// 运行 ID
    /// </summary>
    public string RunId { get; set; } = string.Empty;

    /// <summary>
    /// 意图识别结果
    /// </summary>
    public IntentResult? Intent { get; set; }

    /// <summary>
    /// 计划执行的 Agent 列表
    /// </summary>
    public List<AgentInfo> PlannedAgents { get; set; } = new();

    /// <summary>
    /// 执行步骤
    /// </summary>
    public List<StepInfo> Steps { get; set; } = new();

    /// <summary>
    /// 运行状态
    /// </summary>
    public string Status { get; set; } = string.Empty;

    /// <summary>
    /// SSE 流式事件 URL
    /// </summary>
    public string SseUrl { get; set; } = string.Empty;
}

/// <summary>
/// Agent 信息
/// </summary>
public class AgentInfo
{
    public string AgentKey { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
}

/// <summary>
/// 步骤信息
/// </summary>
public class StepInfo
{
    public string StepId { get; set; } = string.Empty;
    public int Index { get; set; }
    public string AgentKey { get; set; } = string.Empty;
    public string AgentDisplayName { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
}

/// <summary>
/// 创建/更新工具请求
/// </summary>
public class CreateToolboxItemRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public List<string>? Tags { get; set; }
    public string? Prompt { get; set; }
    public string? WelcomeMessage { get; set; }
    public List<string>? ConversationStarters { get; set; }
    public List<string>? EnabledTools { get; set; }
    public double? Temperature { get; set; }
    public bool? EnableMemory { get; set; }
}

/// <summary>
/// 运行工具请求
/// </summary>
public class RunToolboxItemRequest
{
    public string Input { get; set; } = string.Empty;
}

/// <summary>
/// 直接对话请求
/// </summary>
public class DirectChatRequest
{
    /// <summary>用户消息</summary>
    public string? Message { get; set; }

    /// <summary>内置 Agent Key（如 code-reviewer, translator 等）</summary>
    public string? AgentKey { get; set; }

    /// <summary>自定义智能体 ID（优先于 AgentKey）</summary>
    public string? ItemId { get; set; }

    /// <summary>对话历史</summary>
    public List<ChatHistoryMessage>? History { get; set; }
}

/// <summary>
/// 对话历史消息
/// </summary>
public class ChatHistoryMessage
{
    public string Role { get; set; } = "user";
    public string Content { get; set; } = string.Empty;
}

#endregion
