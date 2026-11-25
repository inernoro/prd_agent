using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.QuickCreate;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/quick-create")]
[Authorize]
[AdminController("quick-create", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class QuickCreateController(
    MongoDbContext db,
    IAssetStorage storage,
    SpeechGenerationService speech,
    IAdminPermissionService permissions,
    IHostedSiteService hostedSites,
    ILogger<QuickCreateController> logger) : ControllerBase
{
    public sealed record CreateRequest(string TemplateId, Guid TemplateRequestId, string? ArticleTitle, string ArticleMarkdown);

    [HttpGet("templates")]
    public async Task<IActionResult> Templates()
    {
        var canGenerate = await CanGenerateAsync();
        return Ok(ApiResponse<object>.Ok(new
        {
            canGenerate,
            speechReady = canGenerate && await QuickVideoWorker.GetTemplateSpeechProfileAsync(speech) != null,
            items = QuickVideoTemplates.Items.Select(x => new { x.Id, x.Name, x.Description }),
        }));
    }

    [HttpPost("runs")]
    public async Task<IActionResult> Create([FromBody] CreateRequest request, CancellationToken ct)
    {
        if (!await CanGenerateAsync())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "当前账号没有快速创作所需的网页写入和配音权限。"));
        if (QuickVideoTemplates.Find(request.TemplateId) is not { } template || request.TemplateRequestId == Guid.Empty
            || request.ArticleMarkdown is not { Length: <= 100_000 } article || article.Trim().Length < 20
            || request.ArticleTitle?.Trim().Length > 150)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择模板。稿件须为 20 至 100,000 个字符，标题最多 150 字。"));
        if (await QuickVideoWorker.GetTemplateSpeechProfileAsync(speech) == null)
            return StatusCode(503, ApiResponse<object>.Fail("TEMPLATE_SPEECH_UNAVAILABLE", "当前环境暂未配置普通配音。"));

        var owner = this.GetRequiredUserId();
        var deployment = DeploymentScope.Current;
        var requestKey = DeploymentScope.ScopeIdempotencyKey($"quick-create:{owner}:{request.TemplateRequestId:D}");
        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(requestKey)))[..32].ToLowerInvariant();
        var title = string.IsNullOrWhiteSpace(request.ArticleTitle) ? template.Name : request.ArticleTitle.Trim();
        var run = new QuickVideoRun
        {
            Id = id, OwnerUserId = owner, DeploymentSlug = deployment, TaskPermitId = TaskExecutionContext.Current?.PermitId,
            TemplateId = template.Id, ArticleTitle = title, ArticleMarkdown = article,
        };
        try { await db.QuickVideoRuns.InsertOneAsync(run, cancellationToken: ct); }
        catch (MongoWriteException error) when (error.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            var previous = await db.QuickVideoRuns.Find(Owned(id, owner)).FirstOrDefaultAsync(ct);
            if (previous == null || previous.TemplateId != template.Id || previous.ArticleTitle != title || previous.ArticleMarkdown != article)
                return Conflict(ApiResponse<object>.Fail("IDEMPOTENCY_CONFLICT", "此提交标识已用于不同的稿件。"));
        }
        return Ok(ApiResponse<object>.Ok(new { runId = id }));
    }

    [HttpGet("runs")]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var owner = this.GetRequiredUserId();
        var rows = await db.QuickVideoRuns.Find(x => x.OwnerUserId == owner)
            .SortByDescending(x => x.CreatedAt).Limit(20).Project(x => new
            {
                x.Id, x.TemplateId, x.ArticleTitle, x.Status, x.CurrentPhase, x.CreatedAt, x.PublishedSiteId,
            }).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(rows));
    }

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> Run(string runId, CancellationToken ct)
    {
        var run = await db.QuickVideoRuns.Find(Owned(runId, this.GetRequiredUserId())).FirstOrDefaultAsync(ct);
        return run == null ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "找不到这条快速创作记录。"))
            : Ok(ApiResponse<QuickVideoRun>.Ok(run));
    }

    [HttpGet("runs/{runId}/download")]
    public async Task<IActionResult> Download(string runId, CancellationToken ct)
    {
        var run = await db.QuickVideoRuns.Find(Owned(runId, this.GetRequiredUserId())).FirstOrDefaultAsync(ct);
        var asset = run == null ? null : await ReadVideoAsync(run, ct);
        return asset == null ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成片暂时无法读取。"))
            : File(asset.Value.bytes, "video/mp4", enableRangeProcessing: true);
    }

    [HttpPost("runs/{runId}/publish")]
    public async Task<IActionResult> Publish(string runId, CancellationToken ct)
    {
        var owner = this.GetRequiredUserId();
        var filter = Owned(runId, owner);
        var run = await db.QuickVideoRuns.Find(filter).FirstOrDefaultAsync(ct);
        if (run == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "找不到这条快速创作记录。"));
        if (run.Status != QuickVideoStatus.Completed)
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "成片生成后即可发布。"));

        var now = DateTime.UtcNow;
        var lease = now.AddMinutes(5);
        var claim = await db.QuickVideoRuns.UpdateOneAsync(filter & Builders<QuickVideoRun>.Filter.Where(x => x.PublishLeaseUntil == null || x.PublishLeaseUntil < now),
            Builders<QuickVideoRun>.Update.Set(x => x.PublishLeaseUntil, lease), cancellationToken: ct);
        if (claim.ModifiedCount != 1)
            return Conflict(ApiResponse<object>.Fail("PUBLISH_IN_PROGRESS", "正在发布这条视频，请稍后查看。"));

        var holder = filter & Builders<QuickVideoRun>.Filter.Eq(x => x.PublishLeaseUntil, lease);
        try
        {
            var sourceRef = "quick-video:" + run.Id;
            var existing = await db.HostedSites.Find(x => x.OwnerUserId == owner && x.SourceRef == sourceRef).FirstOrDefaultAsync(ct);
            if (existing == null)
            {
                var asset = await ReadVideoAsync(run, ct);
                if (asset == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成片暂时无法读取，请稍后再试。"));
                var zip = WebPagesController.BuildWrapperZip("video.mp4", asset.Value.bytes, ".mp4", run.ArticleTitle);
                existing = await hostedSites.CreateFromZipAsync(owner, zip, run.ArticleTitle, null, null, [], "video", ct, sourceRef: sourceRef);
            }
            await db.QuickVideoRuns.UpdateOneAsync(holder, Builders<QuickVideoRun>.Update.Set(x => x.PublishedSiteId, existing.Id),
                cancellationToken: CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { siteId = existing.Id }));
        }
        catch (InvalidOperationException error)
        {
            logger.LogWarning(error, "发布快速创作视频失败 {RunId}", runId);
            return StatusCode(503, ApiResponse<object>.Fail("QUICK_VIDEO_PUBLISH_FAILED", "成片已保留。网页托管暂时无法发布，请稍后再试。"));
        }
        finally
        {
            await db.QuickVideoRuns.UpdateOneAsync(holder, Builders<QuickVideoRun>.Update.Unset(x => x.PublishLeaseUntil),
                cancellationToken: CancellationToken.None);
        }
    }

    private static FilterDefinition<QuickVideoRun> Owned(string id, string owner) =>
        Builders<QuickVideoRun>.Filter.Where(x => x.Id == id && x.OwnerUserId == owner);

    private Task<(byte[] bytes, string mime)?> ReadVideoAsync(QuickVideoRun run, CancellationToken ct) =>
        run.Status == QuickVideoStatus.Completed && run.VideoAssetSha256 is { } hash
            ? storage.TryReadByShaAsync(hash, ct, domain: AppDomainPaths.DomainWebHosting, type: AppDomainPaths.TypeVideo)
            : Task.FromResult<(byte[], string)?>(null);

    private async Task<bool> CanGenerateAsync()
    {
        var grants = await permissions.GetEffectivePermissionsAsync(this.GetRequiredUserId(), User.FindFirst("isRoot")?.Value == "1", CancellationToken.None);
        return grants.Contains(AdminPermissionCatalog.Super) || grants.Contains(AdminPermissionCatalog.WebPagesWrite)
            && (grants.Contains(AdminPermissionCatalog.McpSpeechGenerate) || grants.Contains(AdminPermissionCatalog.McpSpeechManage));
    }
}
