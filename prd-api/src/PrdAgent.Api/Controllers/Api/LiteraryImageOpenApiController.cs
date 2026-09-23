using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>文学 MCP 只入队与查询，执行、资产保存与标记回填使用网页同一个 Worker。</summary>
[ApiController]
[Route("api/open/literary")]
[Authorize(AuthenticationSchemes = "ApiKey")]
[RequireScope(McpCapabilityCatalog.ScopeLiteraryUse)]
public class LiteraryImageOpenApiController(MongoDbContext db) : ControllerBase
{
    private string UserId => User.FindFirst("boundUserId")?.Value
        ?? throw new UnauthorizedAccessException("Missing boundUserId claim");

    public class GenerateRequest
    {
        public int? MarkerIndex { get; set; }
        public int? WorkflowVersion { get; set; }
        public string? ClientRequestId { get; set; }
    }

    [HttpPost("workspaces/{workspaceId}/images")]
    public async Task<IActionResult> Generate(string workspaceId, [FromBody] GenerateRequest req, CancellationToken ct)
    {
        if (req.MarkerIndex is null or < 0 || req.WorkflowVersion is null or < 1
            || string.IsNullOrWhiteSpace(req.ClientRequestId) || req.ClientRequestId.Length > 200)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                "请传 markerIndex、workflowVersion 和 1-200 字的 clientRequestId；前两项来自读取工作区，重试保持同一个 clientRequestId。"));
        var userId = UserId;
        var fingerprint = McpIdempotency.Fingerprint("mcp-literary-image", McpIdempotency.ScopedByKey(User, req.ClientRequestId));
        var idem = DeploymentScope.ScopeIdempotencyKey($"mcp:{fingerprint}");
        var previous = await db.ImageGenRuns.Find(x => x.OwnerAdminId == userId && x.IdempotencyKey == idem).FirstOrDefaultAsync(ct);
        if (previous != null) return Replay(previous, workspaceId, req);

        var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId && x.OwnerUserId == userId
            && x.ScenarioType == "article-illustration").FirstOrDefaultAsync(ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文学工作区不存在或不属于你。"));
        if (ws.ArticleWorkflow?.Version != req.WorkflowVersion)
            return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED", "正文或配图方案已变化，请重新读取工作区后再生成。"));
        var marker = ws.ArticleWorkflow.Markers.FirstOrDefault(m => m.Index == req.MarkerIndex);
        if (marker == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
            "配图标记不存在。新建时可传 markedContent，或先在文学创作页面生成配图标记。"));
        var prompt = string.IsNullOrWhiteSpace(marker.DraftText) ? marker.Text : marker.DraftText;
        if (string.IsNullOrWhiteSpace(prompt) || prompt.Length > 4000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "配图描述需为 1-4000 字，请先在页面调整标记。"));

        var reference = await db.ReferenceImageConfigs.Find(x => x.AppKey == "literary-agent"
            && x.IsActive && x.CreatedByAdminId == userId).FirstOrDefaultAsync(ct);
        var sha = string.IsNullOrWhiteSpace(reference?.ImageSha256) ? null : reference.ImageSha256.Trim().ToLowerInvariant();
        // 与页面的历史配置兼容；先确定实际参考图，再选择场景，避免 text2img / img2img 分叉。
        if (sha == null)
        {
            var legacy = await db.LiteraryAgentConfigs.Find(x => x.Id == "literary-agent").FirstOrDefaultAsync(ct);
            sha = string.IsNullOrWhiteSpace(legacy?.ReferenceImageSha256) ? null : legacy.ReferenceImageSha256.Trim().ToLowerInvariant();
        }
        var effectivePrompt = sha != null && !string.IsNullOrWhiteSpace(reference?.Prompt)
            ? $"{reference.Prompt}\n\n{prompt}" : prompt;
        var run = new ImageGenRun
        {
            Id = McpIdempotency.Fingerprint("literary-run", idem)!,
            OwnerAdminId = userId, WorkspaceId = ws.Id,
            AppKey = "literary-agent",
            AppCallerCode = sha == null ? LiteraryAgent.Illustration.Text2Img : LiteraryAgent.Illustration.Img2Img,
            InitImageAssetSha256 = sha,
            ArticleMarkerIndex = marker.Index, ArticleWorkflowVersion = req.WorkflowVersion,
            Status = ImageGenRunStatus.ScopedQueued, DeploymentSlug = DeploymentScope.Current,
            IdempotencyKey = idem, Total = 1, MaxConcurrency = 1,
            Size = "1024x1024", ResponseFormat = "b64_json",
            Items = new() { new() { Prompt = effectivePrompt, DisplayPrompt = prompt, Count = 1, Size = "1024x1024" } },
            CreatedAt = DateTime.UtcNow,
        };
        try { await db.ImageGenRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None); }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            previous = await db.ImageGenRuns.Find(x => x.OwnerAdminId == userId && x.IdempotencyKey == idem).FirstOrDefaultAsync(CancellationToken.None);
            if (previous == null) throw;
            return Replay(previous, workspaceId, req);
        }
        // 不把任务生成后的显示状态写成全量 workflow，避免覆盖并发完成的其它配图。
        var filter = Builders<ImageMasterWorkspace>.Filter;
        var stampPath = $"articleWorkflow.assetRunAtByMarkerIndex.{marker.Index}";
        await db.ImageMasterWorkspaces.UpdateOneAsync(
            filter.And(filter.Eq(x => x.Id, ws.Id), filter.Eq(x => x.OwnerUserId, userId),
                filter.Eq(x => x.ArticleWorkflow!.Version, req.WorkflowVersion.Value),
                filter.Or(filter.Exists(stampPath, false), filter.Lt(stampPath, run.CreatedAt))),
            Builders<ImageMasterWorkspace>.Update.Set($"articleWorkflow.markers.{marker.Index}.runId", run.Id)
                .Set($"articleWorkflow.markers.{marker.Index}.status", "running"),
            cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { runId = run.Id, status = "queued", total = 1,
            hint = "每 5 秒调用 map_literary_get_image_run 查询；完成后用 map_literary_get_workspace 的 format=illustrated 读取图文稿。" }));
    }

    private IActionResult Replay(ImageGenRun previous, string workspaceId, GenerateRequest req)
        => previous.WorkspaceId != workspaceId || previous.ArticleMarkerIndex != req.MarkerIndex
            || previous.ArticleWorkflowVersion != req.WorkflowVersion
            ? Conflict(ApiResponse<object>.Fail("IDEMPOTENCY_CONFLICT", "这个 clientRequestId 已用于另一项配图请求，请为新的请求使用新的值。"))
            : Ok(ApiResponse<object>.Ok(new { runId = previous.Id, deduplicated = true }));

    [HttpGet("image-runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var userId = UserId;
        var run = await db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == userId && x.AppKey == "literary-agent").FirstOrDefaultAsync(ct);
        if (run == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "配图任务不存在或不属于你。"));
        var items = await db.ImageGenRunItems.Find(x => x.RunId == runId && x.OwnerAdminId == userId).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id, status = run.Status.ToString(), total = run.Total, done = run.Done, failed = run.Failed,
            finished = VisualOpenApiController.IsRunFinished(run.Status, run.Done, run.Failed, run.Total),
            error = VisualOpenApiController.RunFailure(run, items.Count),
            images = items.Select(x => new { index = x.ImageIndex, status = x.Status.ToString(),
                url = Request.ResolveAbsoluteUrl(x.Url), errorMessage = x.ErrorMessage == null ? null : McpArtifactExtractor.UserFacing(x.ErrorMessage) }),
        }));
    }

    public class MoveRequest { public string? FolderName { get; set; } }

    [HttpPost("workspaces/{workspaceId}/folder")]
    public async Task<IActionResult> Move(string workspaceId, [FromBody] MoveRequest req)
    {
        if (req.FolderName == null || req.FolderName.Trim().Length > 80)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请传 0-80 字的 folderName；空字符串表示移回未分类。"));
        var userId = UserId;
        var folder = string.IsNullOrWhiteSpace(req.FolderName) ? null : req.FolderName.Trim();
        var result = await db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == workspaceId && x.OwnerUserId == userId && x.ScenarioType == "article-illustration",
            Builders<ImageMasterWorkspace>.Update.Set(x => x.FolderName, folder).Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        return result.MatchedCount == 0
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文学工作区不存在或不属于你。"))
            : Ok(ApiResponse<object>.Ok(new { workspaceId, folderName = folder, published = false }));
    }
}
