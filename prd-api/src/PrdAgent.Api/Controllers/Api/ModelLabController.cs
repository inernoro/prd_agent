using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Prompts.Templates;
using PrdAgent.Api.Services;
using static PrdAgent.Core.Models.AppCallerRegistry;
using PrdAgent.Core.LlmGateway;

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
    private readonly BusinessModelReferenceService _modelReferences;
    private readonly IVisualModelPolicyService _visualModels;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly PrdAgent.Core.LlmGateway.ILlmGateway _gateway;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ModelLabController(
        MongoDbContext db,
        IModelLabRepository repo,
        ILLMRequestContextAccessor ctxAccessor,
        PrdAgent.Core.LlmGateway.ILlmGateway gateway,
        BusinessModelReferenceService modelReferences,
        IVisualModelPolicyService visualModels)
    {
        _db = db;
        _repo = repo;
        _modelReferences = modelReferences;
        _visualModels = visualModels;
        _ctxAccessor = ctxAccessor;
        _gateway = gateway;
    }

    private string GetAdminId() => this.GetRequiredUserId();

    [HttpGet("model-options")]
    public async Task<IActionResult> GetModelOptions([FromQuery] string purpose = "chat", CancellationToken ct = default)
    {
        if (purpose is not ("chat" or "image" or "image-batch"))
            return BadRequest(ApiResponse<object>.Fail("INVALID_PURPOSE", "请选择对话、单次生图或批量生图用途。"));
        try { return Ok(ApiResponse<object>.Ok(new { items = await OptionsForPurposeAsync(purpose, ct) })); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { return StatusCode(503, ApiResponse<object>.Fail("MODEL_CATALOG_UNAVAILABLE", "暂时无法读取此用途的模型目录，请稍后重试。")); }
    }

    private Task<IReadOnlyList<BusinessModelOption>> OptionsAsync(CancellationToken ct = default)
        => _modelReferences.GetOptionsAsync(Admin.ModelLab.Run, ModelTypes.Chat, ct);

    private async Task<IReadOnlyList<BusinessModelOption>> OptionsForPurposeAsync(string purpose, CancellationToken ct)
        => purpose == "chat" ? await OptionsAsync(ct)
            : BusinessModelReferenceService.ProjectOptions(await _visualModels.ListAsync(purpose == "image"
                ? VisualAgent.Image.Text2Img : VisualAgent.ImageGen.BatchGenerate, ct));

    private async Task<(IReadOnlyList<BusinessModelOption> Options, bool HasUnknown)> UnionCatalogAsync()
    {
        var catalogs = await Task.WhenAll(new[] { "chat", "image", "image-batch" }.Select(async purpose =>
        {
            try { return (Options: await OptionsForPurposeAsync(purpose, CancellationToken.None), Unknown: false); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            { return (Options: (IReadOnlyList<BusinessModelOption>)Array.Empty<BusinessModelOption>(), Unknown: true); }
        }));
        var options = catalogs.SelectMany(x => x.Options).GroupBy(x => x.LogicalModelId, StringComparer.Ordinal)
            .Select(group => group.FirstOrDefault(x => x.Available) ?? group.First()).ToList();
        return (options, catalogs.Any(x => x.Unknown));
    }

    private async Task<(List<ModelLabSelectedModel> Models, IActionResult? Failure)> NormalizeForSaveAsync(
        IEnumerable<ModelLabSelectedModel> incoming, IReadOnlyList<ModelLabSelectedModel>? existing)
    {
        var catalog = await UnionCatalogAsync();
        if (!ModelLabModelReferences.TryNormalize(catalog.Options, incoming, existing, out var models, out var reason))
            return (models, catalog.HasUnknown
                ? StatusCode(503, ApiResponse<object>.Fail("MODEL_CATALOG_UNAVAILABLE", "部分用途目录暂时不可用，未保存新模型引用；请稍后重试。"))
                : BadRequest(ApiResponse<object>.Fail("MODEL_REFERENCE_INVALID", reason ?? "请明确选择当前授权逻辑模型。")));
        ModelLabModelReferences.Annotate(models, catalog.Options, catalog.HasUnknown);
        return (models, null);
    }

    private async Task AnnotateReadAsync(IEnumerable<ModelLabSelectedModel> models)
    {
        var catalog = await UnionCatalogAsync();
        ModelLabModelReferences.Annotate(models, catalog.Options, catalog.HasUnknown);
    }

    private IActionResult ConfigurationConflict()
        => Conflict(ApiResponse<object>.Fail("MODEL_CONFIGURATION_CONFLICT", "配置已被其他操作更新；请刷新后重新编辑，当前模型引用未被覆盖。"));

    [HttpGet("experiments")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListExperiments([FromQuery] string? search, [FromQuery] int page = 1, [FromQuery] int pageSize = 20)
    {
        var adminId = GetAdminId();
        var items = await _repo.ListExperimentsAsync(adminId, search, page, pageSize);
        await AnnotateReadAsync(items.SelectMany(x => x.SelectedModels));
        return Ok(ApiResponse<object>.Ok(new { items, page, pageSize }));
    }

    [HttpPost("experiments")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateExperiment([FromBody] UpsertExperimentRequest request)
    {
        var adminId = GetAdminId();
        var selection = await NormalizeForSaveAsync(request.SelectedModels ?? new(), null);
        if (selection.Failure is { } failure) return failure;
        var exp = new ModelLabExperiment
        {
            OwnerAdminId = adminId,
            Name = string.IsNullOrWhiteSpace(request.Name) ? "未命名实验" : request.Name.Trim(),
            Suite = request.Suite ?? ModelLabSuite.Speed,
            SelectedModels = selection.Models,
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
        await AnnotateReadAsync(exp.SelectedModels);
        return Ok(ApiResponse<object>.Ok(exp));
    }

    [HttpPut("experiments/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateExperiment(string id, [FromBody] UpsertExperimentRequest request)
    {
        var adminId = GetAdminId();
        var exp = await _repo.GetExperimentAsync(id, adminId);
        if (exp == null) return NotFound(ApiResponse<object>.Fail("EXPERIMENT_NOT_FOUND", "实验不存在"));

        var expectedUpdatedAt = exp.UpdatedAt;
        var selection = await NormalizeForSaveAsync(request.SelectedModels ?? exp.SelectedModels, exp.SelectedModels);
        if (selection.Failure is { } failure) return failure;
        exp.Name = string.IsNullOrWhiteSpace(request.Name) ? exp.Name : request.Name.Trim();
        exp.Suite = request.Suite ?? exp.Suite;
        exp.SelectedModels = selection.Models;
        exp.PromptTemplateId = request.PromptTemplateId;
        exp.PromptText = request.PromptText;
        exp.Params = request.Params ?? exp.Params;

        if (!await _repo.UpdateExperimentAsync(exp, expectedUpdatedAt))
            return ConfigurationConflict();
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
        await AnnotateReadAsync(items.SelectMany(x => x.Models));
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("model-sets")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpsertModelSet([FromBody] UpsertModelSetRequest request)
    {
        var adminId = GetAdminId();
        var existing = string.IsNullOrWhiteSpace(request.Id) ? null : await _repo.GetModelSetAsync(request.Id, adminId);
        var selection = await NormalizeForSaveAsync(request.Models ?? existing?.Models ?? new(), existing?.Models);
        if (selection.Failure is { } failure) return failure;
        var set = existing ?? new ModelLabModelSet { Id = request.Id ?? Guid.NewGuid().ToString(), OwnerAdminId = adminId };
        set.Name = string.IsNullOrWhiteSpace(request.Name) ? set.Name : request.Name.Trim();
        set.Models = selection.Models;

        var saved = await _repo.UpsertModelSetAsync(set, existing?.UpdatedAt);
        if (saved is null) return ConfigurationConflict();
        return Ok(ApiResponse<object>.Ok(saved));
    }

    [HttpGet("lab-groups")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListLabGroups([FromQuery] string? search, [FromQuery] int limit = 50)
    {
        var adminId = GetAdminId();
        var items = await _repo.ListLabGroupsAsync(adminId, search, limit);
        await AnnotateReadAsync(items.SelectMany(x => x.Models));
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("lab-groups")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpsertLabGroup([FromBody] UpsertLabGroupRequest request)
    {
        var adminId = GetAdminId();
        var existing = string.IsNullOrWhiteSpace(request.Id) ? null : await _repo.GetLabGroupAsync(request.Id, adminId);
        var selection = await NormalizeForSaveAsync(request.Models ?? existing?.Models ?? new(), existing?.Models);
        if (selection.Failure is { } failure) return failure;
        var g = existing ?? new ModelLabGroup { Id = request.Id ?? Guid.NewGuid().ToString(), OwnerAdminId = adminId };
        g.Name = string.IsNullOrWhiteSpace(request.Name) ? g.Name : request.Name.Trim();
        g.Models = selection.Models;

        try
        {
            var saved = await _repo.UpsertLabGroupAsync(g, existing?.UpdatedAt);
            if (saved is null) return ConfigurationConflict();
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
                    await RunOneModelAsync(sm, run, effective, writeLock, queueMs, cancellationToken);
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

    private async Task RunOneModelAsync(ModelLabSelectedModel selected, ModelLabRun run,
        EffectiveRunRequest effective, SemaphoreSlim writeLock, long queueMs, CancellationToken ct)
    {
        // 只传已经验证的逻辑公开标识；物理线路与凭据由网关在真实发送时解析一次。
        var client = _gateway.CreateClient(Admin.ModelLab.Run, ModelTypes.Chat, maxTokens: 4096,
            temperature: 0.2, expectedModel: selected.ModelId);
        await RunStreamWithClientAsync(client, selected, run, effective, effective.EnablePromptCache ?? true, writeLock, queueMs, ct);
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

        var userMessage = new LLMMessage { Role = "user", Content = prompt };

        // 识图模式：将图片附加到 user message
        if (effective.ImageBase64List.Count > 0)
        {
            userMessage.Attachments = effective.ImageBase64List
                .Select(b64 =>
                {
                    var isDataUri = b64.StartsWith("data:", StringComparison.OrdinalIgnoreCase);
                    string? mime = null;
                    string? rawBase64 = null;
                    if (isDataUri)
                    {
                        // 解析 data:image/png;base64,xxxx
                        var commaIdx = b64.IndexOf(',');
                        if (commaIdx > 0)
                        {
                            var header = b64[..commaIdx]; // data:image/png;base64
                            rawBase64 = b64[(commaIdx + 1)..];
                            var semiIdx = header.IndexOf(';');
                            if (semiIdx > 5) mime = header[5..semiIdx]; // image/png
                        }
                    }
                    return new LLMAttachment
                    {
                        Type = "image",
                        Url = isDataUri ? b64 : $"data:image/png;base64,{b64}",
                        MimeType = mime ?? "image/png",
                        Base64Data = rawBase64 ?? (isDataUri ? null : b64)
                    };
                })
                .ToList();
        }

        var messages = new List<LLMMessage> { userMessage };

        var requestType = effective.Suite == ModelLabSuite.Intent ? "intent" : "reasoning";
        var appCallerCode = Admin.ModelLab.Run;
        var repeatN = Math.Max(1, effective.Params.RepeatN);

        // repeatN > 1 时：每次请求都作为独立 item 回显（前端按 itemId 渲染为独立 block）
        for (var i = 0; i < repeatN; i++)
        {
            var item = new ModelLabRunItem
            {
                OwnerAdminId = run.OwnerAdminId,
                RunId = run.Id,
                ExperimentId = run.ExperimentId,
                LogicalModelId = selected.LogicalModelId,
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
                logicalModelId = item.LogicalModelId,
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
                AppCallerCode: appCallerCode,
                ModelResolutionType: ModelResolutionType.LogicalModel,
                LogicalModelPublicId: selected.ModelId));

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

        if (request.IncludeMainModelAsStandard == true)
            return EffectiveRunRequest.Fail("MODEL_REFERENCE_REQUIRED", "不再自动追加物理主模型；请从授权逻辑模型目录明确选择对照模型。");
        if (request.Models is null && exp is null && request.ModelIds?.Count > 0)
            return EffectiveRunRequest.Fail("MODEL_REFERENCE_REQUIRED", "旧模型编号不能继续执行，请从授权逻辑模型目录重新选择模型。");
        var selectedModels = request.Models ?? exp?.SelectedModels ?? new();
        if (selectedModels.Count == 0)
            return EffectiveRunRequest.Fail("NO_MODELS", "未选择任何模型");
        IReadOnlyList<BusinessModelOption> options;
        try { options = await OptionsAsync(ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { return EffectiveRunRequest.Fail("MODEL_CATALOG_UNAVAILABLE", "暂时无法核对模型目录，未启动实验；请稍后重试。"); }
        if (!ModelLabModelReferences.TryNormalize(options, selectedModels, null, out var normalized, out var reason))
            return EffectiveRunRequest.Fail("MODEL_REFERENCE_INVALID", reason ?? "模型引用已失效，请重新选择授权逻辑模型。");
        var models = normalized.DistinctBy(x => x.LogicalModelId, StringComparer.Ordinal).ToList();

        // 识图模式：过滤空白项，限制数量
        var imageBase64List = (request.ImageBase64List ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Take(10)
            .ToList();

        return EffectiveRunRequest.Ok(
            experimentId: exp?.Id,
            suite: suite,
            promptText: promptText,
            expectedFormat: string.IsNullOrWhiteSpace(request.ExpectedFormat) ? null : request.ExpectedFormat,
            imagePlanMaxItems: fmt is "imagegenplan" or "image_gen_plan" or "image-gen-plan" ? imagePlanMaxItems : 10,
            systemPromptOverride: fmt is "imagegenplan" or "image_gen_plan" or "image-gen-plan" ? systemPromptOverride : null,
            @params: p,
            enablePromptCache: request.EnablePromptCache,
            models: models,
            imageBase64List: imageBase64List);
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

    /// <summary>
    /// 可选：识图模式下传入的图片 Base64 列表（data URI 或纯 base64）。
    /// 每张图片将作为 LLMAttachment 附加到 user message 中。
    /// </summary>
    public List<string>? ImageBase64List { get; set; }
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
    public List<string> ImageBase64List { get; private set; } = new();

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
        List<ModelLabSelectedModel> models,
        List<string>? imageBase64List = null) => new()
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
        Models = models,
        ImageBase64List = imageBase64List ?? new()
    };
}
