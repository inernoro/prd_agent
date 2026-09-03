using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 视觉创作开放接口 —— 供外部智能体（MCP 连接器）用一句话生成图片。
///
/// 鉴权：Bearer sk-ak-xxxx + scope visual-agent:use（签发时已与用户自己的 visual-agent.use 权限位取过交集）。
///
/// 与 ImageGenController.CreateRun 的关系：这里是它的一个**收窄子集**，不是复制。
/// 智能体只给 prompt，模型走「视觉创作允许模型」策略里的默认项（与 ImageGenController 同一个
/// VisualModelPolicy.Select 判据），不接受 platformId / configModelId / appCallerCode 这些内部参数 ——
/// 让智能体填这些只会让它猜到失败（最小输入原则）。
///
/// 生成是异步的：入队返回 runId，由 ImageGenRunWorker 执行；查进度走 runs/{runId}。
/// 入队盖 DeploymentScope.Current，避免共享库里别的部署抢走这条 run（跨部署隔离规则通道 8）。
/// </summary>
[ApiController]
[Route("api/open/visual")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class VisualOpenApiController : ControllerBase
{
    public const string ScopeUse = McpCapabilityCatalog.ScopeVisualUse;

    /// <summary>一次最多几张。比人工界面的 20 张收得更紧：智能体重试成本低，别让它一口气烧掉整天额度。</summary>
    private const int MaxImagesPerCall = 4;

    private readonly MongoDbContext _db;
    private readonly IVisualModelPolicyService _visualModels;

    public VisualOpenApiController(MongoDbContext db, IVisualModelPolicyService visualModels)
    {
        _db = db;
        _visualModels = visualModels;
    }

    private string GetBoundUserId()
    {
        var id = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(id))
            throw new UnauthorizedAccessException("Missing boundUserId claim");
        return id;
    }

    /// <summary>列出当前开放给智能体的生图模型（就是视觉创作工作区允许的那一个）。</summary>
    [HttpGet("models")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> ListModels(CancellationToken ct)
    {
        var policy = await _visualModels.ReadAsync(ct);
        var selected = policy.Select(null);
        return Ok(ApiResponse<object>.Ok(new
        {
            defaultModel = selected,
            configured = !string.IsNullOrWhiteSpace(selected),
            hint = string.IsNullOrWhiteSpace(selected)
                ? "管理员还没为视觉创作配默认模型，去「视觉创作 → 模型策略」选一个再来。"
                : null,
        }));
    }

    public class GenerateImageRequest
    {
        public string? Prompt { get; set; }
        /// <summary>如 1024x1024 / 1024x1536；留空用 1024x1024。</summary>
        public string? Size { get; set; }
        public int? Count { get; set; }
        /// <summary>幂等键：智能体重试不会重复烧额度。</summary>
        public string? ClientRequestId { get; set; }
    }

    /// <summary>入队一次生图。返回 runId，用 runs/{runId} 查结果。</summary>
    [HttpPost("images")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> Generate([FromBody] GenerateImageRequest req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var prompt = (req?.Prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(prompt))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空"));
        if (prompt.Length > 4000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "prompt 超过 4000 字，请精简"));

        var count = Math.Clamp(req!.Count ?? 1, 1, MaxImagesPerCall);
        var size = string.IsNullOrWhiteSpace(req.Size) ? "1024x1024" : req.Size!.Trim();

        // 模型：与 ImageGenController 同一个判据 —— 视觉创作只跑策略允许的那个模型
        var policy = await _visualModels.ReadAsync(ct);
        var modelId = policy.Select(null);
        if (string.IsNullOrWhiteSpace(modelId))
            return BadRequest(ApiResponse<object>.Fail("VISUAL_MODEL_NOT_ALLOWED",
                "视觉创作还没配默认生图模型，智能体没法出图。请管理员到「视觉创作 → 模型策略」选一个模型后重试。"));

        var idemKey = BuildIdempotencyKey(req.ClientRequestId);
        if (idemKey != null)
        {
            var existed = await _db.ImageGenRuns
                .Find(x => x.OwnerAdminId == userId && x.IdempotencyKey == idemKey)
                .FirstOrDefaultAsync(ct);
            if (existed != null)
                return Ok(ApiResponse<object>.Ok(new { runId = existed.Id, deduplicated = true }));
        }

        var run = new ImageGenRun
        {
            OwnerAdminId = userId,
            Status = ImageGenRunStatus.ScopedQueued,
            DeploymentSlug = DeploymentScope.Current,
            PlatformId = "logical-model",
            ModelId = modelId,
            LogicalModelPublicId = modelId,
            ModelResolutionType = PrdAgent.Core.Models.ModelResolutionType.LogicalModel,
            Size = size,
            ResponseFormat = "b64_json",
            MaxConcurrency = Math.Min(count, 3),
            Items = new List<ImageGenRunPlanItem> { new() { Prompt = prompt, Count = count, Size = size } },
            Total = count,
            Done = 0,
            Failed = 0,
            CancelRequested = false,
            LastSeq = 0,
            IdempotencyKey = idemKey,
            AppCallerCode = VisualAgent.Image.Text2Img,
            AppKey = "visual-agent",
            CreatedAt = DateTime.UtcNow,
        };

        try
        {
            await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: ct);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && idemKey != null)
        {
            var existed = await _db.ImageGenRuns
                .Find(x => x.OwnerAdminId == userId && x.IdempotencyKey == idemKey)
                .FirstOrDefaultAsync(ct);
            if (existed != null)
                return Ok(ApiResponse<object>.Ok(new { runId = existed.Id, deduplicated = true }));
            throw;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id,
            total = count,
            status = "queued",
            hint = "生成需要十几秒到一分钟；用 runs/{runId} 查进度与结果地址。",
        }));
    }

    /// <summary>查一次生图任务的进度与产物。</summary>
    [HttpGet("runs/{runId}")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == userId).FirstOrDefaultAsync(ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "run 不存在"));

        var items = await _db.ImageGenRunItems
            .Find(x => x.RunId == runId && x.OwnerAdminId == userId)
            .SortBy(x => x.ItemIndex).ThenBy(x => x.ImageIndex)
            .ToListAsync(ct);

        // 只回图片地址，不回 base64：一张图的 base64 就能把智能体的上下文顶满
        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id,
            status = run.Status.ToString(),
            total = run.Total,
            done = run.Done,
            failed = run.Failed,
            images = items.Select(x => new
            {
                index = x.ImageIndex,
                status = x.Status.ToString(),
                url = x.Url,
                revisedPrompt = x.RevisedPrompt,
                errorMessage = x.ErrorMessage,
            }),
            finished = run.Done + run.Failed >= run.Total,
        }));
    }

    private string? BuildIdempotencyKey(string? clientRequestId)
    {
        if (string.IsNullOrWhiteSpace(clientRequestId)) return null;
        var keyId = User.FindFirst("agentApiKeyId")?.Value ?? "unknown";
        var raw = clientRequestId.Trim();
        if (raw.Length > 120) raw = raw[..120];
        // 与 ImageGenController 一致：幂等键带部署作用域，防前端确定性键跨分支撞唯一索引
        return DeploymentScope.ScopeIdempotencyKey($"mcp:{keyId}:{raw}");
    }
}
