using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Prompts.Templates;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 大模型实验室（模型对比/测速/意图测试）
/// </summary>
[ApiController]
[Route("api/lab/model")]
[Authorize]
[AdminController("lab", AdminPermissionCatalog.LabRead, WritePermission = AdminPermissionCatalog.LabWrite)]
public class ModelLabController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IModelLabRepository _repo;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILlmRequestLogWriter _logWriter;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly ILogger<ClaudeClient> _claudeLogger;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ModelLabController(
        MongoDbContext db,
        IModelLabRepository repo,
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        ILlmRequestLogWriter logWriter,
        ILLMRequestContextAccessor ctxAccessor,
        ILogger<ClaudeClient> claudeLogger)
    {
        _db = db;
        _repo = repo;
        _config = config;
        _httpClientFactory = httpClientFactory;
        _logWriter = logWriter;
        _ctxAccessor = ctxAccessor;
        _claudeLogger = claudeLogger;
    }

    private string GetAdminId() => User.FindFirst("sub")?.Value ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value ?? "unknown";

    [HttpGet("experiments")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListExperiments([FromQuery] string? search, [FromQuery] int page = 1, [FromQuery] int pageSize = 20)
    {
        var adminId = GetAdminId();
        var items = await _repo.ListExperimentsAsync(adminId, search, page, pageSize);
        return Ok(ApiResponse<object>.Ok(new { items, page, pageSize }));
    }

    [HttpPost("experiments")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateExperiment([FromBody] UpsertExperimentRequest request)
    {
        var adminId = GetAdminId();
        var exp = new ModelLabExperiment
        {
            OwnerAdminId = adminId,
            Name = string.IsNullOrWhiteSpace(request.Name) ? "未命名实验" : request.Name.Trim(),
            Suite = request.Suite ?? ModelLabSuite.Speed,
            SelectedModels = request.SelectedModels ?? new List<ModelLabSelectedModel>(),
            PromptTemplateId = request.PromptTemplateId,
            PromptText = request.PromptText,
            Params = request.Params ?? new ModelLabParams()
        };

        await _repo.InsertExperimentAsync(exp);
        return Ok(ApiResponse<object>.Ok(exp));
    }

    [HttpGet("experiments/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetExperiment(string id)
    {
        var adminId = GetAdminId();
        var exp = await _repo.GetExperimentAsync(id, adminId);
        if (exp == null) return NotFound(ApiResponse<object>.Fail("EXPERIMENT_NOT_FOUND", "实验不存在"));
        return Ok(ApiResponse<object>.Ok(exp));
    }

    [HttpPut("experiments/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateExperiment(string id, [FromBody] UpsertExperimentRequest request)
    {
        var adminId = GetAdminId();
        var exp = await _repo.GetExperimentAsync(id, adminId);
        if (exp == null) return NotFound(ApiResponse<object>.Fail("EXPERIMENT_NOT_FOUND", "实验不存在"));

        exp.Name = string.IsNullOrWhiteSpace(request.Name) ? exp.Name : request.Name.Trim();
        exp.Suite = request.Suite ?? exp.Suite;
        exp.SelectedModels = request.SelectedModels ?? exp.SelectedModels;
        exp.PromptTemplateId = request.PromptTemplateId;
        exp.PromptText = request.PromptText;
        exp.Params = request.Params ?? exp.Params;

        await _repo.UpdateExperimentAsync(exp);
        return Ok(ApiResponse<object>.Ok(exp));
    }

    [HttpDelete("experiments/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DeleteExperiment(string id)
    {
        var adminId = GetAdminId();
        var ok = await _repo.DeleteExperimentAsync(id, adminId);
        if (!ok) return NotFound(ApiResponse<object>.Fail("EXPERIMENT_NOT_FOUND", "实验不存在"));
        return Ok(ApiResponse<object>.Ok(true));
    }

    [HttpGet("model-sets")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListModelSets([FromQuery] string? search, [FromQuery] int limit = 50)
    {
        var adminId = GetAdminId();
        var items = await _repo.ListModelSetsAsync(adminId, search, limit);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("model-sets")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpsertModelSet([FromBody] UpsertModelSetRequest request)
    {
        var adminId = GetAdminId();
        var set = new ModelLabModelSet
        {
            Id = request.Id ?? Guid.NewGuid().ToString(),
            OwnerAdminId = adminId,
            Name = string.IsNullOrWhiteSpace(request.Name) ? "未命名集合" : request.Name.Trim(),
            Models = request.Models ?? new List<ModelLabSelectedModel>()
        };

        var saved = await _repo.UpsertModelSetAsync(set);
        return Ok(ApiResponse<object>.Ok(saved));
    }

    [HttpGet("lab-groups")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListLabGroups([FromQuery] string? search, [FromQuery] int limit = 50)
    {
        var adminId = GetAdminId();
        var items = await _repo.ListLabGroupsAsync(adminId, search, limit);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("lab-groups")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpsertLabGroup([FromBody] UpsertLabGroupRequest request)
    {
        var adminId = GetAdminId();
        var g = new ModelLabGroup
        {
            Id = request.Id ?? Guid.NewGuid().ToString(),
            OwnerAdminId = adminId,
            Name = string.IsNullOrWhiteSpace(request.Name) ? "未命名分组" : request.Name.Trim(),
            Models = request.Models ?? new List<ModelLabSelectedModel>()
        };

        try
        {
            var saved = await _repo.UpsertLabGroupAsync(g);
            return Ok(ApiResponse<object>.Ok(saved));
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return Ok(ApiResponse<object>.Fail("INVALID_FORMAT", "分组名称已存在"));
        }
    }

    [HttpDelete("lab-groups/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DeleteLabGroup(string id)
    {
        var adminId = GetAdminId();
        var ok = await _repo.DeleteLabGroupAsync(id, adminId);
        if (!ok) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "分组不存在"));
        return Ok(ApiResponse<object>.Ok(true));
    }

    [HttpPost("runs/stream")]
    [Produces("text/event-stream")]
    public async Task RunStream([FromBody] RunStreamRequest request, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var adminId = GetAdminId();
        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("JWT Secret not configured");
        // 业务规则：不再使用“全局开关”，而是以“主模型 enablePromptCache”作为总开关
        var mainModel = await _db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefaultAsync(cancellationToken);
        var mainEnablePromptCache = mainModel == null ? false : (mainModel.EnablePromptCache ?? true);

        var effective = await ResolveEffectiveRunRequestAsync(adminId, request, cancellationToken);
        if (!effective.Success)
        {
            await WriteEventAsync("run", new { type = "error", errorCode = effective.ErrorCode, errorMessage = effective.ErrorMessage }, cancellationToken);
            return;
        }

        var run = new ModelLabRun
        {
            OwnerAdminId = adminId,
            ExperimentId = effective.ExperimentId,
            Suite = effective.Suite,
            RepeatN = effective.Params.RepeatN
        };

        await _repo.InsertRunAsync(run);
        await WriteEventAsync("run", new { type = "runStart", runId = run.Id, experimentId = run.ExperimentId, suite = run.Suite, repeatN = run.RepeatN }, cancellationToken);

        var writeLock = new SemaphoreSlim(1, 1);
        // 管理后台实验室需要支持更高并发（用于同时跑多模型对比）。
        // 注意：并发过高可能触发下游平台限流/网关限制；此处仅限制服务端自身调度上限。
        var maxConc = Math.Clamp(effective.Params.MaxConcurrency, 1, 50);
        var sem = new SemaphoreSlim(maxConc, maxConc);
        var tasks = new List<Task>();

        foreach (var sm in effective.Models)
        {
            tasks.Add(Task.Run(async () =>
            {
                var queuedAt = DateTime.UtcNow;
                await sem.WaitAsync(cancellationToken);
                try
                {
                    var queueMs = (long)Math.Max(0, (DateTime.UtcNow - queuedAt).TotalMilliseconds);
                    await RunOneModelAsync(sm, run, jwtSecret, mainEnablePromptCache, effective, writeLock, queueMs, cancellationToken);
                }
                finally
                {
                    sem.Release();
                }
            }, cancellationToken));
        }

        try
        {
            await Task.WhenAll(tasks);
            run.Status = ModelLabRunStatus.Completed;
        }
        catch (OperationCanceledException)
        {
            run.Status = ModelLabRunStatus.Cancelled;
        }
        catch
        {
            run.Status = ModelLabRunStatus.Failed;
        }
        finally
        {
            run.EndedAt = DateTime.UtcNow;
            await _repo.UpdateRunAsync(run);
        }

        await WriteEventAsync("run", new { type = "runDone", runId = run.Id, status = run.Status, endedAt = run.EndedAt }, cancellationToken);
    }

    private async Task RunOneModelAsync(
        ModelLabSelectedModel selected,
        ModelLabRun run,
        string jwtSecret,
        bool mainEnablePromptCache,
        EffectiveRunRequest effective,
        SemaphoreSlim writeLock,
        long queueMs,
        CancellationToken ct)
    {
        // 统一语义：
        // - selected.ModelId: 平台侧模型 ID（等价于旧语义的 ModelName）
        // - selected.PlatformId: 平台 ID
        // 兼容旧数据：ResolveEffectiveRunRequestAsync 会尽量把旧的“ModelId=llmmodels.id”转换为上述新语义。
        var platformId = (selected.PlatformId ?? string.Empty).Trim();
        var modelName = (string.IsNullOrWhiteSpace(selected.ModelName) ? selected.ModelId : selected.ModelName).Trim();

        // 已配置模型（llmmodels）：按 platformId + modelId 精确匹配（字段名：ModelName；避免跨平台同名冲突）
        var model = string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelName)
            ? null
            : await _db.LLMModels.Find(m => m.PlatformId == platformId && m.ModelName == modelName).FirstOrDefaultAsync(ct);

        // 未配置模型：直接使用平台配置 + modelName 调用
        if (model == null)
        {
            if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelName))
            {
                // 这里无法为 repeat 拆分具体 item（缺少必要信息），直接写一个错误 item，避免前端“无回显”。
                var errItem = new ModelLabRunItem
                {
                    OwnerAdminId = run.OwnerAdminId,
                    RunId = run.Id,
                    ExperimentId = run.ExperimentId,
                    ModelId = (selected.ModelId ?? string.Empty).Trim(),
                    PlatformId = platformId,
                    DisplayName = (selected.ModelId ?? string.Empty).Trim(),
                    ModelName = modelName,
                    Success = false,
                    ErrorCode = "MODEL_NOT_FOUND",
                    ErrorMessage = "模型不存在",
                    EndedAt = DateTime.UtcNow
                };
                await _repo.InsertRunItemAsync(errItem);
                await WriteWithLockAsync(writeLock, "model", new
                {
                    type = "modelStart",
                    runId = run.Id,
                    itemId = errItem.Id,
                    modelId = errItem.ModelId,
                    displayName = errItem.DisplayName,
                    modelName = errItem.ModelName,
                    queueMs,
                    repeatIndex = 1,
                    repeatN = 1
                }, ct);
                await WriteWithLockAsync(writeLock, "model", new
                {
                    type = "modelError",
                    runId = run.Id,
                    itemId = errItem.Id,
                    modelId = errItem.ModelId,
                    errorCode = errItem.ErrorCode,
                    errorMessage = errItem.ErrorMessage,
                    repeatIndex = 1,
                    repeatN = 1
                }, ct);
                return;
            }

            var platform = await _db.LLMPlatforms.Find(p => p.Id == platformId).FirstOrDefaultAsync(ct);
            if (platform == null || !platform.Enabled)
            {
                var errItem = new ModelLabRunItem
                {
                    OwnerAdminId = run.OwnerAdminId,
                    RunId = run.Id,
                    ExperimentId = run.ExperimentId,
                    ModelId = (selected.ModelId ?? string.Empty).Trim(),
                    PlatformId = platformId,
                    DisplayName = (selected.ModelId ?? string.Empty).Trim(),
                    ModelName = modelName,
                    Success = false,
                    ErrorCode = "PLATFORM_NOT_FOUND",
                    ErrorMessage = "平台不存在或未启用",
                    EndedAt = DateTime.UtcNow
                };
                await _repo.InsertRunItemAsync(errItem);
                await WriteWithLockAsync(writeLock, "model", new
                {
                    type = "modelStart",
                    runId = run.Id,
                    itemId = errItem.Id,
                    modelId = errItem.ModelId,
                    displayName = errItem.DisplayName,
                    modelName = errItem.ModelName,
                    queueMs,
                    repeatIndex = 1,
                    repeatN = 1
                }, ct);
                await WriteWithLockAsync(writeLock, "model", new
                {
                    type = "modelError",
                    runId = run.Id,
                    itemId = errItem.Id,
                    modelId = errItem.ModelId,
                    errorCode = errItem.ErrorCode,
                    errorMessage = errItem.ErrorMessage,
                    repeatIndex = 1,
                    repeatN = 1
                }, ct);
                return;
            }

            var (platformApiUrl, platformApiKey, fallbackPlatformType) = ResolveApiConfigForPlatform(platform, jwtSecret);
            if (string.IsNullOrWhiteSpace(platformApiUrl) || string.IsNullOrWhiteSpace(platformApiKey))
            {
                var errItem = new ModelLabRunItem
                {
                    OwnerAdminId = run.OwnerAdminId,
                    RunId = run.Id,
                    ExperimentId = run.ExperimentId,
                    ModelId = (selected.ModelId ?? string.Empty).Trim(),
                    PlatformId = platformId,
                    DisplayName = (selected.ModelId ?? string.Empty).Trim(),
                    ModelName = modelName,
                    Success = false,
                    ErrorCode = "INVALID_CONFIG",
                    ErrorMessage = "平台 API 配置不完整",
                    EndedAt = DateTime.UtcNow
                };
                await _repo.InsertRunItemAsync(errItem);
                await WriteWithLockAsync(writeLock, "model", new
                {
                    type = "modelStart",
                    runId = run.Id,
                    itemId = errItem.Id,
                    modelId = errItem.ModelId,
                    displayName = errItem.DisplayName,
                    modelName = errItem.ModelName,
                    queueMs,
                    repeatIndex = 1,
                    repeatN = 1
                }, ct);
                await WriteWithLockAsync(writeLock, "model", new
                {
                    type = "modelError",
                    runId = run.Id,
                    itemId = errItem.Id,
                    modelId = errItem.ModelId,
                    errorCode = errItem.ErrorCode,
                    errorMessage = errItem.ErrorMessage,
                    repeatIndex = 1,
                    repeatN = 1
                }, ct);
                return;
            }

            var enablePromptCacheForPlatform = mainEnablePromptCache && (effective.EnablePromptCache ?? true);

            var httpClient2 = _httpClientFactory.CreateClient("LoggedHttpClient");
            httpClient2.BaseAddress = new Uri(platformApiUrl.TrimEnd('/'));

            ILLMClient client2 = fallbackPlatformType == "anthropic" || platformApiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase)
                ? new ClaudeClient(httpClient2, platformApiKey, modelName, 4096, 0.2, enablePromptCacheForPlatform, _claudeLogger, _logWriter, _ctxAccessor, platform.Id, platform.Name)
                : new OpenAIClient(httpClient2, platformApiKey, modelName, 4096, 0.2, enablePromptCacheForPlatform, _logWriter, _ctxAccessor, null, platform.Id, platform.Name);

            // 继续使用下方通用逻辑（systemPrompt/prompt/stream）
            await RunStreamWithClientAsync(client2, selected, run, effective, enablePromptCacheForPlatform, writeLock, queueMs, ct);
            return;
        }

        if (!model.Enabled)
        {
            var errItem = new ModelLabRunItem
            {
                OwnerAdminId = run.OwnerAdminId,
                RunId = run.Id,
                ExperimentId = run.ExperimentId,
                ModelId = (selected.ModelId ?? string.Empty).Trim(),
                PlatformId = platformId,
                DisplayName = (selected.ModelId ?? string.Empty).Trim(),
                ModelName = modelName,
                Success = false,
                ErrorCode = "MODEL_NOT_FOUND",
                ErrorMessage = "模型不存在或未启用",
                EndedAt = DateTime.UtcNow
            };
            await _repo.InsertRunItemAsync(errItem);
            await WriteWithLockAsync(writeLock, "model", new
            {
                type = "modelStart",
                runId = run.Id,
                itemId = errItem.Id,
                modelId = errItem.ModelId,
                displayName = errItem.DisplayName,
                modelName = errItem.ModelName,
                queueMs,
                repeatIndex = 1,
                repeatN = 1
            }, ct);
            await WriteWithLockAsync(writeLock, "model", new
            {
                type = "modelError",
                runId = run.Id,
                itemId = errItem.Id,
                modelId = errItem.ModelId,
                errorCode = errItem.ErrorCode,
                errorMessage = errItem.ErrorMessage,
                repeatIndex = 1,
                repeatN = 1
            }, ct);
            return;
        }

        var (apiUrl, apiKey, platformType, resolvedPlatformId, resolvedPlatformName) = ResolveApiConfigForModel(model, jwtSecret);
        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            var errItem = new ModelLabRunItem
            {
                OwnerAdminId = run.OwnerAdminId,
                RunId = run.Id,
                ExperimentId = run.ExperimentId,
                ModelId = (selected.ModelId ?? string.Empty).Trim(),
                PlatformId = platformId,
                DisplayName = (selected.ModelId ?? string.Empty).Trim(),
                ModelName = modelName,
                Success = false,
                ErrorCode = "INVALID_CONFIG",
                ErrorMessage = "模型 API 配置不完整",
                EndedAt = DateTime.UtcNow
            };
            await _repo.InsertRunItemAsync(errItem);
            await WriteWithLockAsync(writeLock, "model", new
            {
                type = "modelStart",
                runId = run.Id,
                itemId = errItem.Id,
                modelId = errItem.ModelId,
                displayName = errItem.DisplayName,
                modelName = errItem.ModelName,
                queueMs,
                repeatIndex = 1,
                repeatN = 1
            }, ct);
            await WriteWithLockAsync(writeLock, "model", new
            {
                type = "modelError",
                runId = run.Id,
                itemId = errItem.Id,
                modelId = errItem.ModelId,
                errorCode = errItem.ErrorCode,
                errorMessage = errItem.ErrorMessage,
                repeatIndex = 1,
                repeatN = 1
            }, ct);
            return;
        }

        var enablePromptCache = mainEnablePromptCache && (model.EnablePromptCache ?? true) && (effective.EnablePromptCache ?? true);

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        httpClient.BaseAddress = new Uri(apiUrl.TrimEnd('/'));

        ILLMClient client = platformType == "anthropic" || apiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase)
            ? new ClaudeClient(httpClient, apiKey, model.ModelName, 4096, 0.2, enablePromptCache, _claudeLogger, _logWriter, _ctxAccessor, resolvedPlatformId, resolvedPlatformName)
            : new OpenAIClient(httpClient, apiKey, model.ModelName, 4096, 0.2, enablePromptCache, _logWriter, _ctxAccessor, null, resolvedPlatformId, resolvedPlatformName);

        await RunStreamWithClientAsync(client, selected, run, effective, enablePromptCache, writeLock, queueMs, ct);
        return;

    }

    private async Task RunStreamWithClientAsync(
        ILLMClient client,
        ModelLabSelectedModel selected,
        ModelLabRun run,
        EffectiveRunRequest effective,
        bool enablePromptCache,
        SemaphoreSlim writeLock,
        long queueMs,
        CancellationToken ct)
    {
        // 生产规则：不对 speed/intent/custom 默认注入 system prompt（避免“强加”输出格式/语义）。
        // 输出格式约束仅由前端显式选择 expectedFormat（JSON/MCP/FunctionCall）触发。
        var systemPrompt = "";

        // 专项测试：前端传 expectedFormat 时，强约束输出格式（system prompt 级）。
        var fmt = (effective.ExpectedFormat ?? string.Empty).Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(fmt))
        {
            if (fmt is "imagegenplan" or "image_gen_plan" or "image-gen-plan")
            {
                systemPrompt = await ResolveImageGenPlanSystemPromptAsync(run.OwnerAdminId, effective, ct);
            }
            else
            {
                systemPrompt = fmt switch
                {
                    "json" =>
                        "你是结构化输出模型。请根据用户输入生成结构化结果，并严格只输出 JSON（不要 Markdown/解释/多余字符）。\n" +
                        "要求：必须是合法 JSON（对象或数组）。",
                    "functioncall" or "function_call" or "function-call" =>
                        "你是函数调用规划模型。请根据用户输入选择一个合适的工具调用，并严格只输出 JSON（不要 Markdown/解释/多余字符）。\n" +
                        "JSON 格式（推荐）：{\"name\":\"tool_name\",\"arguments\":{...}}。\n" +
                        "也允许 OpenAI 风格：{\"tool_calls\":[{\"type\":\"function\",\"function\":{\"name\":\"tool_name\",\"arguments\":{...}}}]}。\n" +
                        "要求：必须是合法 JSON；arguments 必须是对象或可解析为对象的字符串。",
                    "mcp" =>
                        "你是 MCP（Model Context Protocol）调用规划模型。请根据用户输入生成 MCP 调用指令，并严格只输出 JSON（不要 Markdown/解释/多余字符）。\n" +
                        "JSON 格式（推荐）：{\"server\":\"server_id\",\"tool\":\"tool_name\",\"arguments\":{...}}。\n" +
                        "也允许资源读取：{\"server\":\"server_id\",\"uri\":\"resource://...\"}。\n" +
                        "也允许批量：{\"calls\":[{\"server\":\"server_id\",\"tool\":\"tool_name\",\"arguments\":{...}}]}。\n" +
                        "要求：必须是合法 JSON；必须包含 server 字段。",
                    _ => systemPrompt
                };
            }
        }

        var prompt = string.IsNullOrWhiteSpace(effective.PromptText)
            ? "你好，请用一句话简短回复。"
            : effective.PromptText!;

        var messages = new List<LLMMessage> { new() { Role = "user", Content = prompt } };

        var requestType = effective.Suite == ModelLabSuite.Intent ? "intent" : "reasoning";
        var repeatN = Math.Max(1, effective.Params.RepeatN);

        // repeatN > 1 时：每次请求都作为独立 item 回显（前端按 itemId 渲染为独立 block）
        for (var i = 0; i < repeatN; i++)
        {
            var item = new ModelLabRunItem
            {
                OwnerAdminId = run.OwnerAdminId,
                RunId = run.Id,
                ExperimentId = run.ExperimentId,
                ModelId = selected.ModelId,
                PlatformId = selected.PlatformId,
                DisplayName = string.IsNullOrWhiteSpace(selected.Name) ? selected.ModelName : selected.Name,
                ModelName = selected.ModelName,
                Success = false,
                StartedAt = DateTime.UtcNow
            };
            await _repo.InsertRunItemAsync(item);

            await WriteWithLockAsync(writeLock, "model", new
            {
                type = "modelStart",
                runId = run.Id,
                itemId = item.Id,
                modelId = item.ModelId,
                displayName = item.DisplayName,
                modelName = item.ModelName,
                queueMs = i == 0 ? queueMs : (long?)null,
                repeatIndex = i + 1,
                repeatN
            }, ct);

            // 旁路记录上下文（不记录 prompt 原文）——每次重复都生成独立 RequestId，避免日志串联/覆盖
            var requestId = Guid.NewGuid().ToString("N");
            using var _ = _ctxAccessor.BeginScope(new LlmRequestContext(
                RequestId: requestId,
                GroupId: null,
                SessionId: null,
                UserId: run.OwnerAdminId,
                ViewRole: null,
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[MODEL_LAB]",
                RequestType: requestType,
                RequestPurpose: "prd-agent-web::model-lab.run"));

            var startedAt = item.StartedAt;
            var firstTokenAt = (DateTime?)null;
            var sb = new StringBuilder();
            var sawFirstDelta = false;

            try
            {
                await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, enablePromptCache, ct).WithCancellation(ct))
                {
                    if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                    {
                        if (!sawFirstDelta)
                        {
                            sawFirstDelta = true;
                            firstTokenAt = DateTime.UtcNow;
                            var ttft = (long)(firstTokenAt.Value - startedAt).TotalMilliseconds;
                            await WriteWithLockAsync(writeLock, "model", new
                            {
                                type = "firstToken",
                                runId = run.Id,
                                itemId = item.Id,
                                modelId = item.ModelId,
                                ttftMs = ttft,
                                repeatIndex = i + 1,
                                repeatN
                            }, ct);
                        }

                        if (sb.Length < 512)
                        {
                            sb.Append(chunk.Content);
                        }

                        // 将 delta 转发给前端用于拼接展示（不落库）
                        await WriteWithLockAsync(writeLock, "model", new
                        {
                            type = "delta",
                            runId = run.Id,
                            itemId = item.Id,
                            modelId = item.ModelId,
                            content = chunk.Content,
                            repeatIndex = i + 1,
                            repeatN
                        }, ct);
                    }

                    if (chunk.Type == "error")
                    {
                        throw new InvalidOperationException(chunk.ErrorMessage ?? "LLM_ERROR");
                    }

                    if (chunk.Type == "done")
                    {
                        // 注意：不要在这里 break。
                        // 原因：OpenAIClient/ClaudeClient 在 yield return "done" 之后才会调用 logWriter.MarkDone 写入 AnswerText；
                        // 如果消费侧提前 break，会导致 async iterator 被提前 Dispose，从而跳过 MarkDone，出现“实验完成但日志 Answer 未记录”。
                        // 这里仅作为“完成信号”，继续等待迭代自然结束即可。
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                item.Success = false;
                item.ErrorCode = "LLM_ERROR";
                item.ErrorMessage = ex.Message;
                item.EndedAt = DateTime.UtcNow;
                await _repo.UpdateRunItemAsync(item);
                await WriteWithLockAsync(writeLock, "model", new
                {
                    type = "modelError",
                    runId = run.Id,
                    itemId = item.Id,
                    modelId = item.ModelId,
                    errorCode = item.ErrorCode,
                    errorMessage = item.ErrorMessage,
                    repeatIndex = i + 1,
                    repeatN
                }, ct);
                continue;
            }

            var endAt = DateTime.UtcNow;
            var ttftMs = (long)((firstTokenAt ?? endAt) - startedAt).TotalMilliseconds;
            var totalMs = (long)(endAt - startedAt).TotalMilliseconds;
            var preview = sb.ToString();

            item.Success = true;
            item.TtftMs = ttftMs;
            item.TotalMs = totalMs;
            item.ResponsePreview = preview;
            item.FirstTokenAt = item.TtftMs.HasValue ? item.StartedAt.AddMilliseconds(item.TtftMs.Value) : null;
            item.EndedAt = endAt;

            await _repo.UpdateRunItemAsync(item);
            await WriteWithLockAsync(writeLock, "model", new
            {
                type = "modelDone",
                runId = run.Id,
                itemId = item.Id,
                modelId = item.ModelId,
                ttftMs = item.TtftMs,
                totalMs = item.TotalMs,
                preview = item.ResponsePreview,
                repeatIndex = i + 1,
                repeatN
            }, ct);
        }
    }

    private async Task<string> ResolveImageGenPlanSystemPromptAsync(string adminId, EffectiveRunRequest effective, CancellationToken ct)
    {
        var overrideText = (effective.SystemPromptOverride ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(overrideText))
        {
            return overrideText;
        }

        var saved = await _db.AdminPromptOverrides
            .Find(x => x.OwnerAdminId == adminId && x.Key == "imageGenPlan")
            .FirstOrDefaultAsync(ct);
        if (!string.IsNullOrWhiteSpace(saved?.PromptText))
        {
            return saved!.PromptText;
        }

        return ImageGenPlanPrompt.Build(effective.ImagePlanMaxItems);
    }

    private async Task WriteWithLockAsync(SemaphoreSlim writeLock, string eventName, object payload, CancellationToken ct)
    {
        await writeLock.WaitAsync(ct);
        try
        {
            await WriteEventAsync(eventName, payload, ct);
        }
        finally
        {
            writeLock.Release();
        }
    }

    private async Task WriteEventAsync(string eventName, object payload, CancellationToken ct)
    {
        var data = JsonSerializer.Serialize(payload, JsonOptions);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {data}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    private async Task<EffectiveRunRequest> ResolveEffectiveRunRequestAsync(string adminId, RunStreamRequest request, CancellationToken ct)
    {
        ModelLabExperiment? exp = null;
        if (!string.IsNullOrWhiteSpace(request.ExperimentId))
        {
            exp = await _repo.GetExperimentAsync(request.ExperimentId.Trim(), adminId);
            if (exp == null)
            {
                return EffectiveRunRequest.Fail("EXPERIMENT_NOT_FOUND", "实验不存在");
            }
        }

        var suite = request.Suite ?? exp?.Suite ?? ModelLabSuite.Speed;
        var promptText = request.PromptText ?? exp?.PromptText;
        var p = request.Params ?? exp?.Params ?? new ModelLabParams();

        var fmt = (request.ExpectedFormat ?? string.Empty).Trim().ToLowerInvariant();
        var imagePlanMaxItems = Math.Clamp(request.ImagePlanMaxItems ?? 10, 1, 20);
        var systemPromptOverride = (request.SystemPromptOverride ?? string.Empty).Trim();
        if (systemPromptOverride.Length > 20_000)
        {
            return EffectiveRunRequest.Fail(ErrorCodes.INVALID_FORMAT, "systemPromptOverride 过长（最多 20000 字符）");
        }
        if (string.IsNullOrWhiteSpace(systemPromptOverride))
        {
            systemPromptOverride = null;
        }

        var models = new List<ModelLabSelectedModel>();
        // 规则：若前端显式传 models，则认为是“本次运行的临时模型列表”（例如临时禁用/过滤），优先级最高，不写入实验。
        if (request.Models?.Count > 0)
        {
            models = request.Models;
        }
        else if (exp?.SelectedModels?.Count > 0)
        {
            models = exp.SelectedModels;
        }
        else if (request.ModelIds?.Count > 0)
        {
            var ids = request.ModelIds.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct().ToList();
            var ms = await _db.LLMModels.Find(m => ids.Contains(m.Id)).ToListAsync(ct);
            models = ms.Select(m => new ModelLabSelectedModel
            {
                // 兼容：这里 request.ModelIds 仍视为“配置模型内部 id”，但落到运行时统一转换为 platform 语义
                ModelId = m.ModelName,
                PlatformId = m.PlatformId ?? string.Empty,
                Name = m.ModelName,
                ModelName = m.ModelName,
                Group = m.Group
            }).ToList();
        }

        if (models.Count == 0)
        {
            return EffectiveRunRequest.Fail("NO_MODELS", "未选择任何模型");
        }

        // 可选：追加主模型作为标准答案（便于对照）
        if (request.IncludeMainModelAsStandard == true)
        {
            var main = await _db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefaultAsync(ct);
            if (main != null)
            {
                var mainPid = (main.PlatformId ?? string.Empty).Trim();
                var mainMid = (main.ModelName ?? string.Empty).Trim();
                var mainKey = $"{mainPid}:{mainMid}".ToLowerInvariant();
                var has = models.Any(x =>
                {
                    var pid = (x.PlatformId ?? string.Empty).Trim();
                    var mid = (string.IsNullOrWhiteSpace(x.ModelName) ? x.ModelId : x.ModelName).Trim();
                    return $"{pid}:{mid}".ToLowerInvariant() == mainKey;
                });
                if (!has)
                {
                    if (string.IsNullOrWhiteSpace(mainPid) || string.IsNullOrWhiteSpace(mainMid)) { /* ignore */ }
                    models.Add(new ModelLabSelectedModel
                    {
                        ModelId = mainMid,
                        PlatformId = mainPid,
                        Name = $"标准答案 · {mainMid}".Trim(),
                        ModelName = mainMid,
                        Group = main.Group
                    });
                }
            }
        }

        // 统一规范化：确保每个模型都具备 platformId + modelId(=modelName) 的业务语义
        var normalized = new List<ModelLabSelectedModel>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var sm in models)
        {
            var pid = (sm.PlatformId ?? string.Empty).Trim();
            var mid = (sm.ModelId ?? string.Empty).Trim();
            var mname = (sm.ModelName ?? string.Empty).Trim();
            var group = sm.Group;

            if (string.IsNullOrWhiteSpace(mid)) continue;

            // 1) 兼容：如果传入的是内部 id（或旧实验数据），优先按 id 查一次，转换为平台语义
            var byId = await _db.LLMModels.Find(m => m.Id == mid).FirstOrDefaultAsync(ct);
            if (byId != null)
            {
                if (!string.IsNullOrWhiteSpace(byId.PlatformId)) pid = byId.PlatformId!.Trim();
                if (!string.IsNullOrWhiteSpace(byId.ModelName)) mname = byId.ModelName.Trim();
                mid = mname;
                group ??= byId.Group;
            }

            // 2) 若未显式给 ModelName，则视为与 ModelId 同义（平台侧模型ID）
            if (string.IsNullOrWhiteSpace(mname)) mname = mid;
            // 强制一致：ModelId == ModelName（业务侧只用 ModelId；ModelName 仅保留兼容字段）
            mid = mname;

            if (string.IsNullOrWhiteSpace(pid) || string.IsNullOrWhiteSpace(mid))
            {
                continue;
            }

            var key = $"{pid}:{mid}".Trim().ToLowerInvariant();
            if (!seen.Add(key)) continue;

            normalized.Add(new ModelLabSelectedModel
            {
                PlatformId = pid,
                ModelId = mid,
                ModelName = mname,
                Name = mid,
                Group = group
            });
        }

        if (normalized.Count == 0)
        {
            return EffectiveRunRequest.Fail("NO_MODELS", "未选择任何模型");
        }

        models = normalized;

        return EffectiveRunRequest.Ok(
            experimentId: exp?.Id,
            suite: suite,
            promptText: promptText,
            expectedFormat: string.IsNullOrWhiteSpace(request.ExpectedFormat) ? null : request.ExpectedFormat,
            imagePlanMaxItems: fmt is "imagegenplan" or "image_gen_plan" or "image-gen-plan" ? imagePlanMaxItems : 10,
            systemPromptOverride: fmt is "imagegenplan" or "image_gen_plan" or "image-gen-plan" ? systemPromptOverride : null,
            @params: p,
            enablePromptCache: request.EnablePromptCache,
            models: models);
    }

    private (string? apiUrl, string? apiKey, string? platformType, string? platformId, string? platformName) ResolveApiConfigForModel(LLMModel model, string jwtSecret)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(model.ApiKeyEncrypted, jwtSecret);
        string? platformType = null;
        string? platformId = model.PlatformId;
        string? platformName = null;

        if (model.PlatformId != null)
        {
            var platform = _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefault();
            platformType = platform?.PlatformType?.ToLowerInvariant();
            platformName = platform?.Name;
            if (platform != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
            }
        }

        return (apiUrl, apiKey, platformType, platformId, platformName);
    }

    private static (string? apiUrl, string? apiKey, string? platformType) ResolveApiConfigForPlatform(LLMPlatform platform, string jwtSecret)
    {
        var apiUrl = platform.ApiUrl;
        var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
        var platformType = platform.PlatformType?.ToLowerInvariant();
        return (apiUrl, apiKey, platformType);
    }

}

public class UpsertExperimentRequest
{
    public string? Name { get; set; }
    public ModelLabSuite? Suite { get; set; }
    public List<ModelLabSelectedModel>? SelectedModels { get; set; }
    public string? PromptTemplateId { get; set; }
    public string? PromptText { get; set; }
    public ModelLabParams? Params { get; set; }
}

public class UpsertModelSetRequest
{
    public string? Id { get; set; }
    public string? Name { get; set; }
    public List<ModelLabSelectedModel>? Models { get; set; }
}

public class UpsertLabGroupRequest
{
    public string? Id { get; set; }
    public string? Name { get; set; }
    public List<ModelLabSelectedModel>? Models { get; set; }
}

public class RunStreamRequest
{
    public string? ExperimentId { get; set; }
    public ModelLabSuite? Suite { get; set; }
    public string? PromptText { get; set; }
    /// <summary>
    /// 可选：专项测试期望输出格式（json / mcp / functionCall / imageGenPlan）。用于 system prompt 级约束。
    /// </summary>
    public string? ExpectedFormat { get; set; }

    /// <summary>
    /// 可选：当 ExpectedFormat=imageGenPlan 时生效。用于限制 items 数量（1-20）。
    /// </summary>
    public int? ImagePlanMaxItems { get; set; }

    /// <summary>
    /// 可选：当 ExpectedFormat=imageGenPlan 时生效。仅本次请求覆盖 system prompt。
    /// 不传时将优先使用管理员已保存的覆盖提示词；两者都无则回退默认模板。
    /// </summary>
    public string? SystemPromptOverride { get; set; }

    /// <summary>
    /// 可选：是否在本次对比中自动追加系统主模型作为“标准答案”。
    /// </summary>
    public bool? IncludeMainModelAsStandard { get; set; }
    public ModelLabParams? Params { get; set; }
    public bool? EnablePromptCache { get; set; }

    /// <summary>可选：直接传模型 ID 列表</summary>
    public List<string>? ModelIds { get; set; }

    /// <summary>可选：直接传完整模型信息</summary>
    public List<ModelLabSelectedModel>? Models { get; set; }
}

internal class EffectiveRunRequest
{
    public bool Success { get; private set; }
    public string? ErrorCode { get; private set; }
    public string? ErrorMessage { get; private set; }

    public string? ExperimentId { get; private set; }
    public ModelLabSuite Suite { get; private set; }
    public string? PromptText { get; private set; }
    public string? ExpectedFormat { get; private set; }
    public int ImagePlanMaxItems { get; private set; } = 10;
    public string? SystemPromptOverride { get; private set; }
    public ModelLabParams Params { get; private set; } = new();
    public bool? EnablePromptCache { get; private set; }
    public List<ModelLabSelectedModel> Models { get; private set; } = new();

    public static EffectiveRunRequest Fail(string code, string message) => new()
    {
        Success = false,
        ErrorCode = code,
        ErrorMessage = message
    };

    public static EffectiveRunRequest Ok(
        string? experimentId,
        ModelLabSuite suite,
        string? promptText,
        string? expectedFormat,
        int imagePlanMaxItems,
        string? systemPromptOverride,
        ModelLabParams @params,
        bool? enablePromptCache,
        List<ModelLabSelectedModel> models) => new()
    {
        Success = true,
        ExperimentId = experimentId,
        Suite = suite,
        PromptText = promptText,
        ExpectedFormat = expectedFormat,
        ImagePlanMaxItems = Math.Clamp(imagePlanMaxItems, 1, 20),
        SystemPromptOverride = systemPromptOverride,
        Params = @params,
        EnablePromptCache = enablePromptCache,
        Models = models
    };
}


