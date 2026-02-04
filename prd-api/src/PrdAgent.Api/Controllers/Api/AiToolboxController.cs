using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

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
    private readonly ILogger<AiToolboxController> _logger;

    private const string AppKey = "ai-toolbox";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AiToolboxController(
        MongoDbContext db,
        IIntentClassifier intentClassifier,
        IToolboxOrchestrator orchestrator,
        IToolboxEventStore eventStore,
        IRunQueue runQueue,
        ILogger<AiToolboxController> logger)
    {
        _db = db;
        _intentClassifier = intentClassifier;
        _orchestrator = orchestrator;
        _eventStore = eventStore;
        _runQueue = runQueue;
        _logger = logger;
    }

    private string GetUserId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

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
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_STATE, $"当前状态不允许执行: {run.Status}"));
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

#endregion
