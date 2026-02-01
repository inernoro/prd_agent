using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using static PrdAgent.Core.Models.AppCallerRegistry;

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
    private readonly ILogger<LiteraryAgentImageGenController> _logger;

    private const string AppKey = "literary-agent";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public LiteraryAgentImageGenController(
        MongoDbContext db,
        IRunEventStore runStore,
        ILogger<LiteraryAgentImageGenController> logger)
    {
        _db = db;
        _runStore = runStore;
        _logger = logger;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    private static bool IsRegisteredImageGenAppCaller(string? appCallerCode)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode)) return false;
        var def = AppCallerRegistrationService.FindByAppCode(appCallerCode);
        return def != null && def.ModelTypes.Contains(ModelTypes.ImageGen);
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

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
            if (existed != null)
            {
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

        // 检查是否有激活的参考图配置
        bool hasActiveReferenceImage = false;
        if (initImageAssetSha256 == null)
        {
            var activeRefConfig = await _db.ReferenceImageConfigs
                .Find(x => x.AppKey == AppKey && x.IsActive)
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

        // 参考图风格提示词（用于追加到生图 prompt）
        string? referenceImagePrompt = null;

        // 若未指定参考图，自动从配置中获取底图
        if (initImageAssetSha256 == null)
        {
            // 优先从新的 ReferenceImageConfigs 获取激活的配置
            var activeRefConfig = await _db.ReferenceImageConfigs
                .Find(x => x.AppKey == AppKey && x.IsActive)
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
        if (!string.IsNullOrWhiteSpace(referenceImagePrompt) && initImageAssetSha256 != null)
        {
            for (var i = 0; i < plan.Count; i++)
            {
                plan[i].Prompt = $"{referenceImagePrompt}\n\n{plan[i].Prompt}";
            }
        }

        var run = new ImageGenRun
        {
            OwnerAdminId = adminId,
            Status = ImageGenRunStatus.Queued,
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
            InitImageAssetSha256 = initImageAssetSha256,
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

        var res = await _db.ImageGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.OwnerAdminId == adminId && x.AppKey == AppKey,
            Builders<ImageGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        if (res.MatchedCount == 0)
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
