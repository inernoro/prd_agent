using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

public partial class VideoAgentController
{
    private const string TemplatePublishSource = "video-template:";

    [HttpGet("templates")]
    public async Task<IActionResult> ListTemplates([FromServices] SpeechGenerationService speech)
    {
        var canGenerate = await HasTemplatePermissionAsync(AdminPermissionCatalog.McpSpeechGenerate);
        return Ok(ApiResponse<object>.Ok(new
        {
            canGenerate,
            speechReady = canGenerate && await VideoGenRunWorker.GetTemplateSpeechProfileAsync(speech) != null,
            items = VideoTemplateCatalog.Items.Select(item => new { item.Id, item.Name, item.Description }),
        }));
    }

    public sealed record CreateTemplateRequest(string TemplateId, Guid TemplateRequestId, string? ArticleTitle, string ArticleMarkdown);

    [HttpPost("templates/runs")]
    public async Task<IActionResult> CreateTemplate([FromBody] CreateTemplateRequest request,
        [FromServices] SpeechGenerationService speech, CancellationToken ct)
    {
        if (!await HasTemplatePermissionAsync(AdminPermissionCatalog.McpSpeechGenerate))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "当前账号没有生成配音的权限。"));
        if (await VideoGenRunWorker.GetTemplateSpeechProfileAsync(speech) == null)
            return StatusCode(503, ApiResponse<object>.Fail("TEMPLATE_SPEECH_UNAVAILABLE", "当前环境尚未配置火山引擎普通配音。"));
        try
        {
            var runId = await _videoGenService.CreateRunAsync(AppKey, GetAdminId(), new CreateVideoGenRunRequest
            {
                Mode = VideoGenMode.Template, TemplateId = request.TemplateId, TemplateRequestId = request.TemplateRequestId,
                ArticleTitle = request.ArticleTitle, ArticleMarkdown = request.ArticleMarkdown,
            }, ct);
            return Ok(ApiResponse<object>.Ok(new { runId }));
        }
        catch (ArgumentException error)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error.Message));
        }
    }

    [HttpPost("runs/{runId}/publish")]
    public async Task<IActionResult> PublishTemplate(string runId, [FromServices] IHostedSiteService sites, CancellationToken ct)
    {
        if (!await HasTemplatePermissionAsync(AdminPermissionCatalog.WebPagesWrite))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "当前账号没有发布到网页托管的权限。"));

        var owner = GetAdminId();
        var run = await _videoGenService.GetRunAsync(runId, owner, AppKey, ct);
        if (run == null || run.Mode != VideoGenMode.Template)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "找不到这条模板视频。"));
        if (run.Status != VideoGenRunStatus.Completed || string.IsNullOrWhiteSpace(run.VideoAssetSha256))
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "视频生成完成后才能发布。"));

        var sourceRef = TemplatePublishSource + run.Id;
        var filter = Builders<VideoGenRun>.Filter.Where(x => x.Id == run.Id && x.OwnerAdminId == owner && x.AppKey == AppKey
            && x.Mode == VideoGenMode.Template && x.Status == VideoGenRunStatus.Completed && x.DeletionRequestedAt == null);
        var now = DateTime.UtcNow;
        var lease = now.AddMinutes(5);
        var claim = await _db.VideoGenRuns.UpdateOneAsync(filter & Builders<VideoGenRun>.Filter.Where(x => x.PublishLeaseUntil == null || x.PublishLeaseUntil < now),
            Builders<VideoGenRun>.Update.Set(x => x.PublishLeaseUntil, lease), cancellationToken: ct);
        if (claim.ModifiedCount != 1)
            return Conflict(ApiResponse<object>.Fail("PUBLISH_IN_PROGRESS", "正在发布这条视频，请稍后查看结果。"));

        var ownerLease = filter & Builders<VideoGenRun>.Filter.Eq(x => x.PublishLeaseUntil, lease);
        try
        {
            var existing = await _db.HostedSites.Find(x => x.OwnerUserId == owner && x.SourceRef == sourceRef)
                .SortBy(x => x.CreatedAt).FirstOrDefaultAsync(ct);
            if (existing == null)
            {
                var asset = await _assetStorage.TryReadByShaAsync(run.VideoAssetSha256, ct,
                    domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);
                if (asset == null)
                    return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成片暂时无法读取，请稍后重新发布。"));
                var title = run.ArticleTitle ?? "模板视频";
                var zip = WebPagesController.BuildWrapperZip("video.mp4", asset.Value.bytes, ".mp4", title);
                existing = await sites.CreateFromZipAsync(owner, zip, title, null, null, [], "video", ct, sourceRef: sourceRef);
            }
            await _db.VideoGenRuns.UpdateOneAsync(ownerLease, Builders<VideoGenRun>.Update.Set(x => x.PublishedSiteId, existing.Id),
                cancellationToken: CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { siteId = existing.Id }));
        }
        catch (InvalidOperationException error)
        {
            _logger.LogWarning(error, "模板视频发布失败 run={RunId}", run.Id);
            return StatusCode(503, ApiResponse<object>.Fail("VIDEO_PUBLISH_FAILED", "成片已保留。网页托管暂时无法发布，请重试。"));
        }
        finally
        {
            await _db.VideoGenRuns.UpdateOneAsync(ownerLease, Builders<VideoGenRun>.Update.Unset(x => x.PublishLeaseUntil),
                cancellationToken: CancellationToken.None);
        }
    }

    private async Task<bool> HasTemplatePermissionAsync(string permission)
    {
        var service = HttpContext.RequestServices.GetRequiredService<IAdminPermissionService>();
        var grants = await service.GetEffectivePermissionsAsync(GetAdminId(), User.FindFirst("isRoot")?.Value == "1", CancellationToken.None);
        return grants.Contains(AdminPermissionCatalog.Super) || grants.Contains(permission)
            || permission == AdminPermissionCatalog.McpSpeechGenerate && grants.Contains(AdminPermissionCatalog.McpSpeechManage);
    }
}
