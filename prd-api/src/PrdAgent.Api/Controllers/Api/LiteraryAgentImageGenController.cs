using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using static PrdAgent.Core.Models.AppCallerRegistry;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 文学创作 Agent 图片生成
/// 遵循应用身份隔离原则，文学创作有自己的图片生成入口
/// </summary>
[ApiController]
[Route("api/literary-agent/image-gen")]
[Authorize]
[AdminController("literary-agent", AdminPermissionCatalog.LiteraryAgentUse)]
public class LiteraryAgentImageGenController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _runStore;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<LiteraryAgentImageGenController> _logger;

    private const string AppKey = "literary-agent";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public LiteraryAgentImageGenController(
        MongoDbContext db,
        IRunEventStore runStore,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<LiteraryAgentImageGenController> logger)
    {
        _db = db;
        _runStore = runStore;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    private string GetAdminId() => this.GetRequiredUserId();

    private static bool IsRegisteredImageGenAppCaller(string? appCallerCode)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode)) return false;
        var def = AppCallerRegistrationService.FindByAppCode(appCallerCode);
        return def != null && def.ModelTypes.Contains(ModelTypes.ImageGen);
    }

    /// <summary>
    /// 预查询将要使用的生图模型（不发送请求）
    /// 用于前端在生成前展示实际调度到的模型名称
    /// </summary>
    [HttpGet("resolve-model")]
    public async Task<IActionResult> ResolveModel([FromQuery] bool hasInitImage = false, CancellationToken ct = default)
    {
        var appCallerCode = hasInitImage
            ? LiteraryAgent.Illustration.Img2Img
            : LiteraryAgent.Illustration.Text2Img;

        try
        {
            var resolution = await _gateway.ResolveModelAsync(appCallerCode, "generation", null, ct: ct);

            if (resolution == null || !resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                return Ok(ApiResponse<object>.Ok(new { resolved = false }));
            }

            return Ok(ApiResponse<object>.Ok(new
            {
                resolved = true,
                model = resolution.ActualModel,
                platform = resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                poolId = resolution.ModelGroupId,
                poolName = resolution.ModelGroupName,
                resolutionType = resolution.ResolutionType,
            }));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LiteraryAgent] 预解析生图模型失败: {AppCallerCode}", appCallerCode);
            return Ok(ApiResponse<object>.Ok(new { resolved = false }));
        }
    }

    /// <summary>
    /// 获取当前文学配图场景下逻辑模型的图片能力。不能复用视觉创作的同名端点：
    /// 两个应用的允许目录不同，拿视觉白名单校验文学模型会把合法模型错误拒绝为 400。
    /// </summary>
    [HttpGet("adapter-info")]
    public async Task<IActionResult> GetAdapterInfo([FromQuery] string modelId, CancellationToken ct)
    {
        var requested = modelId?.Trim();
        if (string.IsNullOrWhiteSpace(requested))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "modelId 不能为空"));

        var adminId = GetAdminId();
        var hasReference = await _db.ReferenceImageConfigs
            .Find(x => x.AppKey == AppKey && x.IsActive && x.CreatedByAdminId == adminId
                && x.ImageSha256 != null && x.ImageSha256 != string.Empty)
            .AnyAsync(ct);
        if (!hasReference)
        {
            var legacy = await _db.LiteraryAgentConfigs.Find(x => x.Id == AppKey).FirstOrDefaultAsync(ct);
            hasReference = !string.IsNullOrWhiteSpace(legacy?.ReferenceImageSha256);
        }

        var appCallerCode = hasReference
            ? LiteraryAgent.Illustration.Img2Img
            : LiteraryAgent.Illustration.Text2Img;
        var item = (await GatewayImageModelCatalog.ReadAsync(_gateway, appCallerCode, ct))
            .FirstOrDefault(x => string.Equals(x.Model.Code, requested, StringComparison.Ordinal));
        var info = item?.ImageCapabilities;
        if (info is null)
            return BadRequest(ApiResponse<object>.Fail("LITERARY_MODEL_CAPABILITIES_UNAVAILABLE",
                "该模型未开放给当前文学配图场景，或能力信息暂不可用，请刷新后重新选择。"));

        return Ok(ApiResponse<object>.Ok(new
        {
            matched = info.Matched,
            modelId = requested,
            adapterName = info.AdapterName,
            displayName = item!.Model.Code,
            info.Provider,
            info.OfficialDocUrl,
            info.LastUpdated,
            sizeConstraint = new { type = info.SizeConstraintType, description = info.SizeConstraintDescription },
            info.SizesByResolution,
            info.SizeParamFormat,
            info.SizesNotApplicable,
            sizeControl = new { source = "llmgw" },
            limitations = new { info.MustBeDivisibleBy, info.MaxWidth, info.MaxHeight, info.MinWidth, info.MinHeight, info.MaxPixels, info.Notes },
            info.SupportsImageToImage,
            info.SupportsInpainting,
            info.IsAdaptive,
        }));
    }

    /// <summary>
    /// 预查询文生提示词（Chat）调度模型，无专属模型池时显示自动调度模型名称
    /// </summary>
    [HttpGet("resolve-chat-model")]
    public async Task<IActionResult> ResolveChatModel(CancellationToken ct)
    {
        var appCallerCode = LiteraryAgent.Content.Chat;

        try
        {
            var resolution = await _gateway.ResolveModelAsync(appCallerCode, "chat", null, ct: ct);

            if (resolution == null || !resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                return Ok(ApiResponse<object>.Ok(new { resolved = false }));
            }

            return Ok(ApiResponse<object>.Ok(new
            {
                resolved = true,
                model = resolution.ActualModel,
                platform = resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                poolId = resolution.ModelGroupId,
                poolName = resolution.ModelGroupName,
                resolutionType = resolution.ResolutionType,
            }));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LiteraryAgent] 预解析提示词模型失败: {AppCallerCode}", appCallerCode);
            return Ok(ApiResponse<object>.Ok(new { resolved = false }));
        }
    }

    /// <summary>
    /// 创建生图任务（runId）：用于断线可恢复的批量/单张生图
    /// 内部硬编码 appKey = "literary-agent"
    /// </summary>
    [HttpPost("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateRun([FromBody] CreateImageGenRunRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].FirstOrDefault() ?? string.Empty).Trim();
        if (idemKey.Length > 200) idemKey = idemKey[..200];
        // 幂等键按部署作用域隔离（Codex P1，见 DeploymentScope.ScopeIdempotencyKey 注释）
        idemKey = DeploymentScope.ScopeIdempotencyKey(idemKey);

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
            if (existed != null)
            {
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
                return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
            }
        }

        // 模型信息可选：如果不提供，Worker 会根据 appCallerCode 从模型池自动解析
        var cfgModelId = (request?.ConfigModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(cfgModelId)) cfgModelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var modelNameLegacy = (request?.ModelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelNameLegacy)) modelNameLegacy = null;
        modelId ??= modelNameLegacy;

        // 如果提供了 configModelId，尝试从数据库查找模型
        if (!string.IsNullOrWhiteSpace(cfgModelId))
        {
            var m = await _db.LLMModels.Find(x => x.Id == cfgModelId && x.Enabled).FirstOrDefaultAsync(ct);
            if (m != null)
            {
                platformId = m.PlatformId;
                modelId = m.ModelName;
            }
            // 如果 configModelId 无效，清空它，让 Worker 从模型池解析
            else
            {
                cfgModelId = null;
            }
        }
        // 注意：不再强制要求提供模型信息
        // 如果 platformId/modelId 为空，Worker 会根据 appCallerCode 从绑定的模型池自动解析

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();
        var maxConc = Math.Clamp(request?.MaxConcurrency ?? 3, 1, 10);

        var items = request?.Items ?? new List<ImageGenRunPlanItemInput>();
        if (items.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "items 不能为空"));
        }
        // 清洗与限制：单条最多 5 张，总计最多 20 张
        var plan = new List<ImageGenRunPlanItem>();
        var total = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var p = (items[i].Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(p)) continue;
            var c = Math.Clamp(items[i].Count <= 0 ? 1 : items[i].Count, 1, 5);
            var s = (items[i].Size ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(s)) s = null;
            plan.Add(new ImageGenRunPlanItem { Prompt = p, Count = c, Size = s });
            total += c;
            if (total > 20) break;
        }
        if (plan.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "items 不能为空（无有效 prompt）"));
        }
        if (total > 20)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, $"单次最多生成 20 张（当前 {total} 张）"));
        }

        // 可选：绑定 WorkspaceId（若提供，生成的图片会自动保存到 COS）
        var workspaceId = (request?.WorkspaceId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(workspaceId)) workspaceId = null;

        // 参考图/底图 SHA256（提前检查，用于决定 appCallerCode）
        var initImageAssetSha256 = (request?.InitImageAssetSha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(initImageAssetSha256)) initImageAssetSha256 = null;

        // 这篇文章记住了风格 / 水印（智能体或网页上为这篇指定过）：网页生图同样按它来。
        // 以前这里只认账号当前启用的那套，同一篇文章在网页上重画一张，水印就换成了账号默认，
        // 一篇文章里出现两种水印。判据与开放接口共用 LiteraryIllustrationChoices，一处说了算。
        var articlePrefsApplied = false;
        string? articleReferencePrompt = null;
        string? articleWatermarkId = null;
        if (initImageAssetSha256 == null && workspaceId != null)
        {
            var prefsWs = await _db.ImageMasterWorkspaces
                .Find(x => x.Id == workspaceId && x.ScenarioType == "article-illustration")
                .FirstOrDefaultAsync(ct);
            // 只有作者本人生图才套文章设定：记住的风格 / 水印 ID 属于作者账号，协作者账号里查不到，
            // 套上去只会静默退回协作者自己的默认（水印在出图时还会因归属不符被丢掉）。协作者照旧按自己账号的设定。
            var canUse = prefsWs != null && prefsWs.OwnerUserId == adminId;
            if (canUse && prefsWs!.IllustrationPrefs != null)
            {
                var chosen = await PrdAgent.Api.Services.LiteraryIllustrationChoices.ResolveForArticleAsync(_db, adminId, prefsWs.IllustrationPrefs, ct);
                articlePrefsApplied = true;
                initImageAssetSha256 = chosen.style.Sha;
                articleReferencePrompt = chosen.style.PromptPrefix;
                articleWatermarkId = chosen.watermark.WatermarkId;
                foreach (var note in chosen.notes)
                    _logger.LogWarning("LiteraryAgent 网页生图沿用文章设定时降级：{Note} workspace={WorkspaceId}", note, workspaceId);

                // 页面按「账号当前启用的风格」挑的模型池（文生图 / 图生图）。文章自己的风格让场景翻转时，
                // 页面钉住的模型属于另一个池，不能带过去——交给 Worker 按正确场景从模型池解析。
                var accountActive = await _db.ReferenceImageConfigs
                    .Find(x => x.AppKey == AppKey && x.IsActive && x.CreatedByAdminId == adminId)
                    .FirstOrDefaultAsync(ct);
                var accountIsImg2Img = accountActive != null && !string.IsNullOrWhiteSpace(accountActive.ImageSha256);
                if ((initImageAssetSha256 != null) != accountIsImg2Img && (platformId != null || modelId != null || cfgModelId != null))
                {
                    _logger.LogInformation("LiteraryAgent 文章设定改变了生图场景，放弃页面钉住的模型 {PlatformId}/{ModelId}，改由模型池解析。workspace={WorkspaceId}",
                        platformId, modelId, workspaceId);
                    platformId = null;
                    modelId = null;
                    cfgModelId = null;
                }
            }
        }

        // 检查是否有激活的参考图配置（必须按用户隔离）
        bool hasActiveReferenceImage = false;
        if (initImageAssetSha256 == null && !articlePrefsApplied)
        {
            var activeRefConfig = await _db.ReferenceImageConfigs
                .Find(x => x.AppKey == AppKey && x.IsActive && x.CreatedByAdminId == adminId)
                .FirstOrDefaultAsync(ct);
            hasActiveReferenceImage = activeRefConfig != null && !string.IsNullOrWhiteSpace(activeRefConfig.ImageSha256);
        }

        // 根据是否有参考图选择 Text2Img 或 Img2Img（应用身份隔离原则）
        var resolvedAppCallerCode = (request?.AppCallerCode ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(resolvedAppCallerCode))
        {
            resolvedAppCallerCode = (initImageAssetSha256 != null || hasActiveReferenceImage)
                ? LiteraryAgent.Illustration.Img2Img
                : LiteraryAgent.Illustration.Text2Img;
        }
        if (!IsRegisteredImageGenAppCaller(resolvedAppCallerCode))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "appCallerCode 未注册或不支持 imageGen"));
        }

        // 文学创作场景：关联的配图标记索引
        var articleMarkerIndex = request?.ArticleMarkerIndex;
        // 盖上发起时的配图方案版本：改稿 / 重新规划后，这个还在跑的旧任务不能再回填到新一版的标记上
        // （Worker 按版本过滤回填；MCP 发起的任务一直带版本，网页这条路此前漏了）。
        int? articleWorkflowVersion = null;
        if (articleMarkerIndex.HasValue && !string.IsNullOrWhiteSpace(workspaceId))
        {
            var markerWs = await _db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId).FirstOrDefaultAsync(ct);
            if (markerWs?.ScenarioType == "article-illustration" && markerWs.ArticleWorkflow != null)
                articleWorkflowVersion = markerWs.ArticleWorkflow.Version;
        }

        // 参考图风格提示词（用于追加到生图 prompt）
        string? referenceImagePrompt = articleReferencePrompt;

        // 若未指定参考图（且这篇文章没有自己的设定），自动从当前用户的配置中获取底图
        if (initImageAssetSha256 == null && !articlePrefsApplied)
        {
            // 优先从新的 ReferenceImageConfigs 获取当前用户激活的配置
            var activeRefConfig = await _db.ReferenceImageConfigs
                .Find(x => x.AppKey == AppKey && x.IsActive && x.CreatedByAdminId == adminId)
                .FirstOrDefaultAsync(ct);

            if (activeRefConfig != null && !string.IsNullOrWhiteSpace(activeRefConfig.ImageSha256))
            {
                initImageAssetSha256 = activeRefConfig.ImageSha256.Trim().ToLowerInvariant();
                referenceImagePrompt = activeRefConfig.Prompt;
            }
            else
            {
                // 回退到旧的 LiteraryAgentConfigs
                var literaryConfig = await _db.LiteraryAgentConfigs.Find(x => x.Id == AppKey).FirstOrDefaultAsync(ct);
                if (literaryConfig != null && !string.IsNullOrWhiteSpace(literaryConfig.ReferenceImageSha256))
                {
                    initImageAssetSha256 = literaryConfig.ReferenceImageSha256.Trim().ToLowerInvariant();
                }
            }
        }

        // 如果有参考图风格提示词，追加到每个 plan item 的 prompt 中
        // DisplayPrompt 在追加前保存原始用户 prompt，避免系统提示词泄漏到消息记录
        if (!string.IsNullOrWhiteSpace(referenceImagePrompt) && initImageAssetSha256 != null)
        {
            for (var i = 0; i < plan.Count; i++)
            {
                plan[i].DisplayPrompt = plan[i].Prompt;
                plan[i].Prompt = $"{referenceImagePrompt}\n\n{plan[i].Prompt}";
            }
        }

        var run = new ImageGenRun
        {
            OwnerAdminId = adminId,
            Status = ImageGenRunStatus.ScopedQueued,
            DeploymentSlug = DeploymentScope.Current,
            ConfigModelId = cfgModelId,
            PlatformId = platformId,
            ModelId = modelId,
            Size = size,
            ResponseFormat = responseFormat,
            MaxConcurrency = maxConc,
            Items = plan,
            Total = total,
            Done = 0,
            Failed = 0,
            CancelRequested = false,
            LastSeq = 0,
            IdempotencyKey = string.IsNullOrWhiteSpace(idemKey) ? null : idemKey,
            WorkspaceId = workspaceId,
            AppCallerCode = resolvedAppCallerCode,
            AppKey = AppKey, // 硬编码 literary-agent
            ArticleMarkerIndex = articleMarkerIndex,
            ArticleWorkflowVersion = articleWorkflowVersion,
            WatermarkConfigId = articleWatermarkId,
            InitImageAssetSha256 = initImageAssetSha256,
            ForceFullShadowSample = _llmRequestContext.Current?.ForceFullShadowSample == true,
            CreatedAt = DateTime.UtcNow
        };

        try
        {
            await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 幂等键冲突：返回已存在的 runId
            var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
            if (existed != null)
            {
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
                return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
            }
            throw;
        }

        _logger.LogInformation("LiteraryAgent ImageGenRun 已创建: runId={RunId}, total={Total}, appCallerCode={AppCallerCode}", run.Id, total, resolvedAppCallerCode);

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
    }

    /// <summary>
    /// 获取生图任务详情
    /// </summary>
    [HttpGet("runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<ImageGenRun>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        }

        var run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId && x.AppKey == AppKey).FirstOrDefaultAsync(ct);
        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, "run 不存在"));
        }

        return Ok(ApiResponse<ImageGenRun>.Ok(run));
    }

    /// <summary>
    /// SSE 流式获取生图任务事件
    /// </summary>
    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string runId, [FromQuery] int? afterSeq, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId && x.AppKey == AppKey).FirstOrDefaultAsync(cancellationToken);
        if (run == null)
        {
            await WriteEventAsync(null, "error", JsonSerializer.Serialize(new { code = ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, message = "run 不存在" }, JsonOptions), cancellationToken);
            return;
        }

        long lastSeq = afterSeq ?? 0;
        var lastKeepAliveAt = DateTime.UtcNow;

        while (!cancellationToken.IsCancellationRequested)
        {
            var events = await _runStore.GetEventsAsync(RunKinds.ImageGen, runId, lastSeq, limit: 100, cancellationToken);
            if (events.Count > 0)
            {
                foreach (var ev in events)
                {
                    await WriteEventAsync(ev.Seq.ToString(), ev.EventName, ev.PayloadJson, cancellationToken);
                    lastSeq = ev.Seq;
                }
                lastKeepAliveAt = DateTime.UtcNow;
            }
            else
            {
                // keepalive：避免代理/浏览器超时关闭连接
                if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
                {
                    await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                }

                // 如果 run 已结束且已追到最新 seq，则关闭 SSE
                run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId).FirstOrDefaultAsync(cancellationToken);
                if (run == null) break;
                if (run.Status is ImageGenRunStatus.Completed or ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled)
                {
                    if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 2) break;
                }

                await Task.Delay(650, cancellationToken);
            }
        }
    }

    /// <summary>
    /// 请求取消生图任务
    /// </summary>
    [HttpPost("runs/{runId}/cancel")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> CancelRun(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        }

        var res = await PrdAgent.Api.Services.ImageGenRunCancellation.RequestAsync(
            _db,
            _runStore,
            runId,
            adminId,
            AppKey,
            ct);

        if (!res.Found)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, "run 不存在"));
        }

        return Ok(ApiResponse<object>.Ok(true));
    }

    private async Task WriteEventAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            await Response.WriteAsync($"id: {id}\n", ct);
        }
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}
