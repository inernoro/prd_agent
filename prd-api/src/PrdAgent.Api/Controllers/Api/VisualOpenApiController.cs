using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Mcp;
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

    /// <summary>size 的形状：两个 2-5 位数字，中间一个 x。有限形状用正则钉死，不当自由文本存。</summary>
    private static readonly System.Text.RegularExpressions.Regex SizePattern =
        new(@"^\d{2,5}x\d{2,5}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>一次最多几张。比人工界面的 20 张收得更紧：智能体重试成本低，别让它一口气烧掉整天额度。</summary>
    private const int MaxImagesPerCall = 4;

    private readonly MongoDbContext _db;
    private readonly IVisualModelPolicyService _visualModels;

    public VisualOpenApiController(MongoDbContext db, IVisualModelPolicyService visualModels)
    {
        _db = db;
        _visualModels = visualModels;
    }

    /// <summary>智能体生图落在哪个工作区：找不到就建一个，用户在视觉创作里能直接看到它。</summary>
    private const string AgentWorkspaceTitle = "智能体生图";

    /// <summary>
    /// 找到（或建出）这把密钥主人的「智能体生图」工作区。
    ///
    /// 用确定性 id，避免并发的两次生图各建一个：同一个用户永远只有这一个。
    /// 不复用他手动建的工作区 —— 智能体产出的图混进用户正在编的画布里，是他没要求过的副作用。
    /// </summary>
    private async Task<string> EnsureAgentWorkspaceAsync(string userId, CancellationToken ct)
    {
        var wsId = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"mcp-visual-ws:{userId}"))).ToLowerInvariant()[..32];

        var existed = await _db.ImageMasterWorkspaces
            .Find(x => x.Id == wsId && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (existed != null) return existed.Id;

        var now = DateTime.UtcNow;
        var assetsHash = Guid.NewGuid().ToString("N");
        var ws = new ImageMasterWorkspace
        {
            Id = wsId,
            OwnerUserId = userId,
            Title = AgentWorkspaceTitle,
            ScenarioType = "image-gen",
            MemberUserIds = new List<string>(),
            AssetsHash = assetsHash,
            CanvasHash = string.Empty,
            ContentHash = LiteraryWorkspaceHash.ComputeContentHash(string.Empty, assetsHash),
            CreatedAt = now,
            UpdatedAt = now,
            LastOpenedAt = now,
        };
        try
        {
            await _db.ImageMasterWorkspaces.InsertOneAsync(ws, cancellationToken: CancellationToken.None);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 并发的另一次生图先建好了，用它的就行
        }
        return wsId;
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

    /// <summary>
    /// 本次要出几张图。闸门（AgentApiKeyUsageFilter）与真正入队必须读同一个数：
    /// 两处各 clamp 一遍的话，占的坑早晚和实际出图数对不上。
    /// </summary>
    internal static int ResolveImageCount(GenerateImageRequest? req) => Math.Clamp(req?.Count ?? 1, 1, MaxImagesPerCall);

    /// <summary>
    /// 显式给了范围外的张数就报错 —— 省略仍然按 1 张。
    ///
    /// clamp 留着（闸门要在真正入队之前算出要占几个坑，那个数必须和控制器用的一致），
    /// 但**悄悄把 8 改成 4** 是另一回事：调用方拿到的图数和它要的不一样，而且是要花钱的那种不一样。
    /// 与分享链有效期同一个道理：「没说」和「说了但说错了」是两件事，schema 里写着 1-4
    /// 只是描述，网关不拿 schema 校验参数。
    /// </summary>
    internal static string? ValidateImageCount(GenerateImageRequest? req)
        => req?.Count is { } c && (c < 1 || c > MaxImagesPerCall)
            ? $"count 需要在 1-{MaxImagesPerCall} 之间，收到 {c}。想用默认的 1 张就别传这个字段。"
            : null;

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

        var countError = ValidateImageCount(req);
        if (countError != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, countError));
        var count = ResolveImageCount(req);
        // req 上面已经按可空处理（req?.Prompt），这里保持同一口径：body 缺失时走默认尺寸。
        var size = string.IsNullOrWhiteSpace(req?.Size) ? "1024x1024" : req.Size!.Trim();
        // size 是有限形状，不是自由文本：它会原样落进 ImageGenRun.Size 并被送去上游。
        // 不校验的话，这里就是又一处「调用方给什么就存什么」——上游只会回一个看不懂的错，
        // 而智能体拿不到「你把尺寸写错了」这个能照着改的说法。
        if (!SizePattern.IsMatch(size))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"size 只能是「宽x高」这种形状（如 1024x1024 / 1024x1536），收到的是「{size}」"));

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

        // 必须绑一个真实工作区。ImageGenRunWorker 只在 run.WorkspaceId 非空时才把结果落进
        // 资产存储并回填画布；不绑的话，配着 ResponseFormat=b64_json 的这条 run 跑完只会把
        // base64 留在 run item 里，而 GetRun 只回 Url —— 智能体拿到 url: null，
        // 「图片进你自己的视觉创作工作区」这句承诺也一个字都没兑现。
        var workspaceId = await EnsureAgentWorkspaceAsync(userId, ct);

        var run = new ImageGenRun
        {
            OwnerAdminId = userId,
            WorkspaceId = workspaceId,
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
            await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
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
                url = Request.ResolveAbsoluteUrl(x.Url),
                revisedPrompt = x.RevisedPrompt,
                errorMessage = x.ErrorMessage,
            }),
            // 「跑完了没有」必须先认终态，不能只数计数器：用户中途取消时，还没开始的那几张
            // 既不算 done 也不算 failed，于是 done + failed 永远小于 total —— 跟着这个标志轮询的
            // 智能体会一直问下去，直到被限流挡住。它其实早就结束了，只是这个判据看不见。
            finished = IsRunFinished(run.Status, run.Done, run.Failed, run.Total),
            // 整条 run 被拒时的原因。没有它的话，「模型被下架」这类在排图之前就驳回的失败，
            // 调用方只能看到 Failed + 空 images —— 而 runs/{runId} 正是我们给智能体的那条
            // 恢复路径，它到这儿就断了：既不知道为什么，也不知道下一步该做什么。
            error = RunFailure(run, items.Count),
        }));
    }

    /// <summary>
    /// 整条 run 的失败原因（没有就返回 null，不占调用方的上下文）。
    ///
    /// 三件事一起给：机器认的码、人能读的一句话、下一步做什么。
    /// 消息先过一遍 <see cref="McpArtifactExtractor.UserFacing"/> —— 这条路上的
    /// errorMessage 有一支来自 `ex.Message`，原样回出去就是把内部细节递给外部调用方。
    /// </summary>
    internal static RunFailureInfo? RunFailure(ImageGenRun run, int itemCount)
    {
        if (run.Status != ImageGenRunStatus.Failed) return null;
        // 逐张失败已经在 images[].errorMessage 里说清楚了，这里不重复一遍。
        if (string.IsNullOrWhiteSpace(run.ErrorCode) && itemCount > 0) return null;

        var code = string.IsNullOrWhiteSpace(run.ErrorCode) ? ErrorCodes.INTERNAL_ERROR : run.ErrorCode!;
        var message = string.IsNullOrWhiteSpace(run.ErrorMessage)
            // 存量 run 没有这两个字段（本次之前入库的），别装作知道原因。
            ? "这次生成没跑起来，服务端没有留下可读的原因。"
            : McpArtifactExtractor.UserFacing(run.ErrorMessage!);
        return new RunFailureInfo(code, message, RunFailureNextStep(code));
    }

    /// <summary>失败之后该做什么 —— 按错误码给一条能执行的下一步，而不是「请稍后重试」。</summary>
    internal static string RunFailureNextStep(string code) => code switch
    {
        "VISUAL_MODEL_NOT_ALLOWED" =>
            "可用模型变了（被下架或改了策略）。这次的 run 不用再查了，重新发起一次即可 —— 服务端会挑当前允许的默认模型。",
        ErrorCodes.INVALID_FORMAT =>
            "请求本身不合法，重试多少次都是同一个结果。按上面这句话改掉参数再发起一次。",
        ErrorCodes.RATE_LIMITED =>
            "这次要的图太多了。拆成几次、每次少要几张再发起。",
        "WORKER_STOPPED" =>
            "服务端在这次生成中途重启了，和你的参数无关。原样重新发起一次即可。",
        _ => "重新发起一次；一直是这个错就把 runId 和时间告诉管理员。",
    };

    /// <summary>整条 run 的失败原因：机器认的码、人能读的一句话、下一步做什么。</summary>
    internal sealed record RunFailureInfo(string Code, string Message, string NextStep);

    /// <summary>
    /// 这次生图跑完了没有 —— 唯一判定源。
    ///
    /// 两条都要：状态到了终态就是结束（取消、失败、完成），这是权威的那一条；
    /// 计数器凑齐了也算（worker 落终态与写计数之间有一小段，别让调用方在那儿多问一轮）。
    /// 只认计数器就会漏掉取消，只认状态就会在收尾那一瞬多轮询一次。
    /// </summary>
    internal static bool IsRunFinished(ImageGenRunStatus status, int done, int failed, int total)
        => status is ImageGenRunStatus.Completed or ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled
            || done + failed >= total;

    private string? BuildIdempotencyKey(string? clientRequestId)
    {
        // 先压成定长指纹再落库：ImageGenRun.IdempotencyKey 带唯一索引、还要当查询键，
        // 而 clientRequestId 是调用方给的无界字符串 —— 原样存等于让它决定文档多大。
        var digest = McpIdempotency.Fingerprint("mcp-visual", McpIdempotency.ScopedByKey(User, clientRequestId));
        // 与 ImageGenController 一致：幂等键带部署作用域，防前端确定性键跨分支撞唯一索引
        return digest == null ? null : DeploymentScope.ScopeIdempotencyKey($"mcp:{digest}");
    }
}
