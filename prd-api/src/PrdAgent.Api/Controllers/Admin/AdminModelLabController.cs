using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 大模型实验室（模型对比/测速/意图测试）
/// </summary>
[ApiController]
[Route("api/v1/admin/model-lab")]
[Authorize(Roles = "ADMIN")]
public class AdminModelLabController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IModelLabRepository _repo;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILlmRequestLogWriter _logWriter;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly ILogger<ClaudeClient> _claudeLogger;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AdminModelLabController(
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
        var globalEnablePromptCache = _db.AppSettings.Find(s => s.Id == "global").FirstOrDefault()?.EnablePromptCache ?? true;

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
        var maxConc = Math.Clamp(effective.Params.MaxConcurrency, 1, 10);
        var sem = new SemaphoreSlim(maxConc, maxConc);
        var tasks = new List<Task>();

        foreach (var sm in effective.Models)
        {
            tasks.Add(Task.Run(async () =>
            {
                await sem.WaitAsync(cancellationToken);
                try
                {
                    await RunOneModelAsync(sm, run, jwtSecret, globalEnablePromptCache, effective, writeLock, cancellationToken);
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
        bool globalEnablePromptCache,
        EffectiveRunRequest effective,
        SemaphoreSlim writeLock,
        CancellationToken ct)
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
            Success = false
        };

        await _repo.InsertRunItemAsync(item);
        await WriteWithLockAsync(writeLock, "model", new { type = "modelStart", runId = run.Id, itemId = item.Id, modelId = item.ModelId, displayName = item.DisplayName, modelName = item.ModelName }, ct);

        var model = await _db.LLMModels.Find(m => m.Id == selected.ModelId).FirstOrDefaultAsync(ct);
        // 兼容“未配置模型”：前端可能传入 modelId=modelName（平台可用模型列表），此时 llmmodels 查不到，需要回退到平台配置直接调用
        if (model == null)
        {
            if (string.IsNullOrWhiteSpace(selected.PlatformId) || string.IsNullOrWhiteSpace(selected.ModelName))
            {
                item.Success = false;
                item.ErrorCode = "MODEL_NOT_FOUND";
                item.ErrorMessage = "模型不存在";
                item.EndedAt = DateTime.UtcNow;
                await _repo.UpdateRunItemAsync(item);
                await WriteWithLockAsync(writeLock, "model", new { type = "modelError", runId = run.Id, itemId = item.Id, modelId = item.ModelId, errorCode = item.ErrorCode, errorMessage = item.ErrorMessage }, ct);
                return;
            }

            var platform = await _db.LLMPlatforms.Find(p => p.Id == selected.PlatformId).FirstOrDefaultAsync(ct);
            if (platform == null || !platform.Enabled)
            {
                item.Success = false;
                item.ErrorCode = "PLATFORM_NOT_FOUND";
                item.ErrorMessage = "平台不存在或未启用";
                item.EndedAt = DateTime.UtcNow;
                await _repo.UpdateRunItemAsync(item);
                await WriteWithLockAsync(writeLock, "model", new { type = "modelError", runId = run.Id, itemId = item.Id, modelId = item.ModelId, errorCode = item.ErrorCode, errorMessage = item.ErrorMessage }, ct);
                return;
            }

            var (platformApiUrl, platformApiKey, fallbackPlatformType) = ResolveApiConfigForPlatform(platform, jwtSecret);
            if (string.IsNullOrWhiteSpace(platformApiUrl) || string.IsNullOrWhiteSpace(platformApiKey))
            {
                item.Success = false;
                item.ErrorCode = "INVALID_CONFIG";
                item.ErrorMessage = "平台 API 配置不完整";
                item.EndedAt = DateTime.UtcNow;
                await _repo.UpdateRunItemAsync(item);
                await WriteWithLockAsync(writeLock, "model", new { type = "modelError", runId = run.Id, itemId = item.Id, modelId = item.ModelId, errorCode = item.ErrorCode, errorMessage = item.ErrorMessage }, ct);
                return;
            }

            var enablePromptCacheForPlatform = globalEnablePromptCache && (effective.EnablePromptCache ?? true);

            var httpClient2 = _httpClientFactory.CreateClient("LoggedHttpClient");
            httpClient2.BaseAddress = new Uri(platformApiUrl.TrimEnd('/'));

            var modelName = selected.ModelName.Trim();
            ILLMClient client2 = fallbackPlatformType == "anthropic" || platformApiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase)
                ? new ClaudeClient(httpClient2, platformApiKey, modelName, 4096, 0.2, enablePromptCacheForPlatform, _claudeLogger, _logWriter, _ctxAccessor)
                : new OpenAIClient(httpClient2, platformApiKey, modelName, 4096, 0.2, enablePromptCacheForPlatform, _logWriter, _ctxAccessor);

            // 继续使用下方通用逻辑（systemPrompt/prompt/stream）
            await RunStreamWithClientAsync(client2, selected, run, item, effective, enablePromptCacheForPlatform, writeLock, ct);
            return;
        }

        if (!model.Enabled)
        {
            item.Success = false;
            item.ErrorCode = "MODEL_NOT_FOUND";
            item.ErrorMessage = "模型不存在或未启用";
            item.EndedAt = DateTime.UtcNow;
            await _repo.UpdateRunItemAsync(item);
            await WriteWithLockAsync(writeLock, "model", new { type = "modelError", runId = run.Id, itemId = item.Id, modelId = item.ModelId, errorCode = item.ErrorCode, errorMessage = item.ErrorMessage }, ct);
            return;
        }

        var (apiUrl, apiKey, platformType) = ResolveApiConfigForModel(model, jwtSecret);
        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            item.Success = false;
            item.ErrorCode = "INVALID_CONFIG";
            item.ErrorMessage = "模型 API 配置不完整";
            item.EndedAt = DateTime.UtcNow;
            await _repo.UpdateRunItemAsync(item);
            await WriteWithLockAsync(writeLock, "model", new { type = "modelError", runId = run.Id, itemId = item.Id, modelId = item.ModelId, errorCode = item.ErrorCode, errorMessage = item.ErrorMessage }, ct);
            return;
        }

        var enablePromptCache = globalEnablePromptCache && (model.EnablePromptCache ?? true) && (effective.EnablePromptCache ?? true);

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        httpClient.BaseAddress = new Uri(apiUrl.TrimEnd('/'));

        ILLMClient client = platformType == "anthropic" || apiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase)
            ? new ClaudeClient(httpClient, apiKey, model.ModelName, 4096, 0.2, enablePromptCache, _claudeLogger, _logWriter, _ctxAccessor)
            : new OpenAIClient(httpClient, apiKey, model.ModelName, 4096, 0.2, enablePromptCache, _logWriter, _ctxAccessor);

        await RunStreamWithClientAsync(client, selected, run, item, effective, enablePromptCache, writeLock, ct);
        return;

    }

    private async Task RunStreamWithClientAsync(
        ILLMClient client,
        ModelLabSelectedModel selected,
        ModelLabRun run,
        ModelLabRunItem item,
        EffectiveRunRequest effective,
        bool enablePromptCache,
        SemaphoreSlim writeLock,
        CancellationToken ct)
    {
        var systemPrompt = effective.Suite switch
        {
            ModelLabSuite.Intent =>
                "你是意图识别模型。请对用户输入进行意图分类，并严格输出 JSON：{\"intent\":\"...\",\"confidence\":0-1,\"reason\":\"...\"}。不要输出额外内容。",
            _ => ""
        };

        var prompt = string.IsNullOrWhiteSpace(effective.PromptText)
            ? "你好，请用一句话简短回复。"
            : effective.PromptText!;

        var messages = new List<LLMMessage> { new() { Role = "user", Content = prompt } };

        // 旁路记录上下文（不记录 prompt 原文）
        var requestId = Guid.NewGuid().ToString("N");
        using var _ = _ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: run.OwnerAdminId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[MODEL_LAB]"));

        var ttftSum = 0L;
        var totalSum = 0L;
        string? preview = null;

        for (var i = 0; i < Math.Max(1, effective.Params.RepeatN); i++)
        {
            var startedAt = DateTime.UtcNow;
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
                            await WriteWithLockAsync(writeLock, "model", new { type = "firstToken", runId = run.Id, itemId = item.Id, modelId = item.ModelId, ttftMs = ttft }, ct);
                        }

                        if (sb.Length < 512)
                        {
                            sb.Append(chunk.Content);
                        }

                        // 将 delta 转发给前端用于拼接展示（不落库）
                        await WriteWithLockAsync(writeLock, "model", new { type = "delta", runId = run.Id, itemId = item.Id, modelId = item.ModelId, content = chunk.Content }, ct);
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
                await WriteWithLockAsync(writeLock, "model", new { type = "modelError", runId = run.Id, itemId = item.Id, modelId = item.ModelId, errorCode = item.ErrorCode, errorMessage = item.ErrorMessage }, ct);
                return;
            }

            var endAt = DateTime.UtcNow;
            var ttftMs = (long)((firstTokenAt ?? endAt) - startedAt).TotalMilliseconds;
            var totalMs = (long)(endAt - startedAt).TotalMilliseconds;
            ttftSum += ttftMs;
            totalSum += totalMs;
            preview = sb.ToString();
        }

        item.Success = true;
        item.TtftMs = ttftSum / Math.Max(1, effective.Params.RepeatN);
        item.TotalMs = totalSum / Math.Max(1, effective.Params.RepeatN);
        item.ResponsePreview = preview;
        item.FirstTokenAt = item.TtftMs.HasValue ? item.StartedAt.AddMilliseconds(item.TtftMs.Value) : null;
        item.EndedAt = DateTime.UtcNow;

        await _repo.UpdateRunItemAsync(item);
        await WriteWithLockAsync(writeLock, "model", new
        {
            type = "modelDone",
            runId = run.Id,
            itemId = item.Id,
            modelId = item.ModelId,
            ttftMs = item.TtftMs,
            totalMs = item.TotalMs,
            preview = item.ResponsePreview
        }, ct);
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

        var models = new List<ModelLabSelectedModel>();
        if (exp?.SelectedModels?.Count > 0)
        {
            models = exp.SelectedModels;
        }
        else if (request.Models?.Count > 0)
        {
            models = request.Models;
        }
        else if (request.ModelIds?.Count > 0)
        {
            var ids = request.ModelIds.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct().ToList();
            var ms = await _db.LLMModels.Find(m => ids.Contains(m.Id)).ToListAsync(ct);
            models = ms.Select(m => new ModelLabSelectedModel
            {
                ModelId = m.Id,
                PlatformId = m.PlatformId ?? string.Empty,
                Name = m.Name,
                ModelName = m.ModelName,
                Group = m.Group
            }).ToList();
        }

        if (models.Count == 0)
        {
            return EffectiveRunRequest.Fail("NO_MODELS", "未选择任何模型");
        }

        return EffectiveRunRequest.Ok(
            experimentId: exp?.Id,
            suite: suite,
            promptText: promptText,
            @params: p,
            enablePromptCache: request.EnablePromptCache,
            models: models);
    }

    private (string? apiUrl, string? apiKey, string? platformType) ResolveApiConfigForModel(LLMModel model, string jwtSecret)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : DecryptApiKey(model.ApiKeyEncrypted, jwtSecret);
        string? platformType = null;

        if (model.PlatformId != null)
        {
            var platform = _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefault();
            platformType = platform?.PlatformType?.ToLowerInvariant();
            if (platform != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= DecryptApiKey(platform.ApiKeyEncrypted, jwtSecret);
            }
        }

        return (apiUrl, apiKey, platformType);
    }

    private static (string? apiUrl, string? apiKey, string? platformType) ResolveApiConfigForPlatform(LLMPlatform platform, string jwtSecret)
    {
        var apiUrl = platform.ApiUrl;
        var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted) ? null : DecryptApiKey(platform.ApiKeyEncrypted, jwtSecret);
        var platformType = platform.PlatformType?.ToLowerInvariant();
        return (apiUrl, apiKey, platformType);
    }

    private static string DecryptApiKey(string encryptedKey, string secretKey)
    {
        if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;

        try
        {
            var parts = encryptedKey.Split(':');
            if (parts.Length != 2) return string.Empty;

            var keyBytes = Encoding.UTF8.GetBytes(secretKey.Length >= 32 ? secretKey[..32] : secretKey.PadRight(32));
            var iv = Convert.FromBase64String(parts[0]);
            var encryptedBytes = Convert.FromBase64String(parts[1]);

            using var aes = Aes.Create();
            aes.Key = keyBytes;
            aes.IV = iv;

            using var decryptor = aes.CreateDecryptor();
            var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
            return Encoding.UTF8.GetString(decryptedBytes);
        }
        catch
        {
            return string.Empty;
        }
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
    public ModelLabParams Params { get; private set; } = new();
    public bool? EnablePromptCache { get; private set; }
    public List<ModelLabSelectedModel> Models { get; private set; } = new();

    public static EffectiveRunRequest Fail(string code, string message) => new()
    {
        Success = false,
        ErrorCode = code,
        ErrorMessage = message
    };

    public static EffectiveRunRequest Ok(string? experimentId, ModelLabSuite suite, string? promptText, ModelLabParams @params, bool? enablePromptCache, List<ModelLabSelectedModel> models) => new()
    {
        Success = true,
        ExperimentId = experimentId,
        Suite = suite,
        PromptText = promptText,
        Params = @params,
        EnablePromptCache = enablePromptCache,
        Models = models
    };
}


