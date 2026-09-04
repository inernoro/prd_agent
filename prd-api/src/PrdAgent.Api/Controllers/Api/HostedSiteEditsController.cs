using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>网页托管入口 HTML 的微调、草稿、发布与回退。</summary>
[ApiController]
[Route("api/web-pages/{siteId}/edits")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class HostedSiteEditsController : ControllerBase
{
    private static readonly TimeSpan RunTtl = TimeSpan.FromHours(24);
    private readonly IHostedSiteService _sites;
    private readonly IHostedSiteRevisionService _revisions;
    private readonly IRunEventStore _events;
    private readonly IRunQueue _queue;
    private readonly MongoDbContext _db;
    private readonly ILogger<HostedSiteEditsController> _logger;
    private readonly IDesignArtifactProviderCatalog _providers;

    public HostedSiteEditsController(
        IHostedSiteService sites,
        IHostedSiteRevisionService revisions,
        IRunEventStore events,
        IRunQueue queue,
        MongoDbContext db,
        ILogger<HostedSiteEditsController> logger,
        IDesignArtifactProviderCatalog providers)
    {
        _sites = sites;
        _revisions = revisions;
        _events = events;
        _queue = queue;
        _db = db;
        _logger = logger;
        _providers = providers;
    }

    [HttpGet("runtime-capabilities")]
    public async Task<IActionResult> RuntimeCapabilities()
    {
        var runtimes = (await _providers.ListAsync(this.GetRequiredUserId(), CancellationToken.None))
            .Where(item => item.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal)
                           && item.Operations.Contains(DesignArtifactOperations.Edit, StringComparer.Ordinal))
            .ToList();
        return Ok(ApiResponse<object>.Ok(new
        {
            defaultRuntime = HostedSiteEditRuntimes.MapGateway,
            runtimes,
        }));
    }

    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun(string siteId, [FromBody] CreateHostedSiteEditRunRequest request)
    {
        var userId = this.GetRequiredUserId();
        var instruction = (request.Instruction ?? string.Empty).Trim();
        if (instruction.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请描述想修改什么"));
        if (instruction.Length > 4000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "修改要求不能超过 4000 个字符"));

        var knowledgeReferences = request.KnowledgeReferences ?? new List<HostedSiteKnowledgeReference>();
        if (knowledgeReferences.Count > 3)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "首版一次最多引用 3 篇知识"));
        if (knowledgeReferences.Any(x => string.IsNullOrWhiteSpace(x.EntryId) || string.IsNullOrWhiteSpace(x.Content)))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "引用知识缺少条目或正文"));
        if (knowledgeReferences.Sum(x => x.Content!.Length) > 60_000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "引用知识正文过长，请减少选择或缩短内容"));

        var runtime = string.IsNullOrWhiteSpace(request.Runtime)
            ? HostedSiteEditRuntimes.MapGateway
            : request.Runtime.Trim().ToLowerInvariant();
        var capability = await _providers.FindAsync(userId, runtime, CancellationToken.None);
        if (capability == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的页面修改运行时"));
        if (!capability.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal)
            || !capability.Operations.Contains(DesignArtifactOperations.Edit, StringComparer.Ordinal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "所选执行器不支持修改网页"));
        if (!capability.Enabled)
            return Conflict(ApiResponse<object>.Fail(
                "RUNTIME_NOT_READY",
                capability.Reason ?? "所选页面修改执行器尚未部署并通过健康检查"));

        try
        {
            await _sites.GetEditableEntryHtmlAsync(siteId, userId, CancellationToken.None);
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }

        var runId = Guid.NewGuid().ToString("N");
        var snapshots = knowledgeReferences.Select(x => new DesignKnowledgeSnapshot
        {
            EntryId = x.EntryId!.Trim(),
            StoreId = TrimOptional(x.StoreId, 120),
            StoreName = TrimOptional(x.StoreName, 200),
            Title = TrimTitle(x.Title),
            Content = x.Content!.Trim(),
            ContentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(x.Content!.Trim()))).ToLowerInvariant(),
        }).ToList();
        var run = new DesignArtifactRun
        {
            Id = runId,
            UserId = userId,
            Status = RunStatuses.Queued,
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Edit,
            SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
            Runtime = runtime,
            Instruction = instruction,
            TargetSiteId = siteId,
            KnowledgeReferences = snapshots,
            Progress = 2,
            Phase = "修改任务已进入队列",
        };
        await _db.DesignArtifactRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        var input = JsonSerializer.Serialize(new { SiteId = siteId });
        var meta = new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.DesignArtifact,
            Status = RunStatuses.Queued,
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            InputJson = input,
        };
        await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
        await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            runId,
            "phase",
            new { progress = 2, message = "修改任务已进入队列" },
            RunTtl,
            CancellationToken.None);
        await _queue.EnqueueAsync(RunKinds.DesignArtifact, runId, CancellationToken.None);
        return Accepted(ApiResponse<object>.Ok(new { runId, status = meta.Status, runtime }));
    }

    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string siteId, string runId, [FromQuery] long afterSeq = 0, CancellationToken ct = default)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        var userId = this.GetRequiredUserId();
        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct);
        if (meta == null || meta.CreatedByUserId != userId || !RunBelongsToSite(meta, siteId))
        {
            await WriteEventAsync(null, "error", JsonSerializer.Serialize(new
            {
                code = ErrorCodes.NOT_FOUND,
                message = "修改任务不存在",
            }), ct);
            return;
        }

        var cursor = Math.Max(0, afterSeq);
        var idleRounds = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var batch = await _events.GetEventsAsync(RunKinds.DesignArtifact, runId, cursor, 100, ct);
                foreach (var item in batch)
                {
                    await WriteEventAsync(item.Seq, item.EventName, item.PayloadJson, ct);
                    cursor = item.Seq;
                }
                if (batch.Count > 0)
                {
                    idleRounds = 0;
                    continue;
                }

                meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct);
                if (meta == null || meta.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled)
                    return;

                idleRounds++;
                if (idleRounds % 20 == 0)
                {
                    await Response.WriteAsync(": keepalive\n\n", ct);
                    await Response.Body.FlushAsync(ct);
                }
                await Task.Delay(500, ct);
            }
        }
        catch (OperationCanceledException)
        {
            // 浏览器断开只结束观察，不取消后台任务。
        }
        catch (ObjectDisposedException)
        {
            // 响应已关闭，后台任务仍继续。
        }
    }

    [HttpGet("revisions")]
    public async Task<IActionResult> ListRevisions(string siteId)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            await _revisions.EnsureCurrentSnapshotAsync(siteId, userId, ct: CancellationToken.None);
            var items = await _revisions.ListAsync(siteId, userId, CancellationToken.None);
            var current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(items.Select(x => ToDto(x, current.ContentVersion)).ToList()));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpGet("revisions/{revisionId}/preview")]
    public async Task<IActionResult> PreviewRevision(string siteId, string revisionId)
    {
        try
        {
            var item = await _revisions.GetAsync(siteId, revisionId, this.GetRequiredUserId(), CancellationToken.None);
            if (item == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在"));
            return Ok(ApiResponse<object>.Ok(new { revision = ToDto(item, null), html = item.Html }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpPost("revisions/{revisionId}/publish")]
    public async Task<IActionResult> PublishRevision(string siteId, string revisionId)
        => await MutateRevisionAsync(siteId, revisionId, rollback: false);

    [HttpPost("revisions/{revisionId}/rollback")]
    public async Task<IActionResult> RollbackRevision(string siteId, string revisionId)
        => await MutateRevisionAsync(siteId, revisionId, rollback: true);

    private async Task<IActionResult> MutateRevisionAsync(string siteId, string revisionId, bool rollback)
    {
        try
        {
            var result = rollback
                ? await _revisions.RollbackAsync(siteId, revisionId, this.GetRequiredUserId(), CancellationToken.None)
                : await _revisions.PublishAsync(siteId, revisionId, this.GetRequiredUserId(), CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new
            {
                revision = ToDto(result.Revision, result.Site.ContentVersion),
                site = result.Site,
            }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本或站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(ApiResponse<object>.Fail("REVISION_CONFLICT", ex.Message));
        }
    }

    private static object ToDto(HostedSiteRevision item, DateTime? currentContentVersion) => new
    {
        item.Id,
        item.SiteId,
        item.Status,
        item.Source,
        item.ParentRevisionId,
        item.SourceRunId,
        item.Instruction,
        item.Runtime,
        item.KnowledgeEntryIds,
        item.BasedOnContentVersion,
        item.PublishedContentVersion,
        item.CreatedAt,
        item.PublishedAt,
        isCurrent = currentContentVersion.HasValue && item.PublishedContentVersion == currentContentVersion,
    };

    private static bool RunBelongsToSite(RunMeta meta, string siteId)
    {
        try
        {
            using var doc = JsonDocument.Parse(meta.InputJson ?? "{}");
            return doc.RootElement.TryGetProperty("SiteId", out var value)
                   && value.GetString() == siteId;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string TrimTitle(string? value)
    {
        var title = string.IsNullOrWhiteSpace(value) ? "未命名知识" : value.Trim();
        return title.Length <= 200 ? title : title[..200];
    }

    private static string? TrimOptional(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private async Task WriteEventAsync(long? id, string eventName, string json, CancellationToken ct)
    {
        if (id.HasValue) await Response.WriteAsync($"id: {id.Value}\n", ct);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        foreach (var line in json.Replace("\r", string.Empty).Split('\n'))
            await Response.WriteAsync($"data: {line}\n", ct);
        await Response.WriteAsync("\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}

public sealed class CreateHostedSiteEditRunRequest
{
    public string? Instruction { get; set; }
    public string? Runtime { get; set; }
    public List<HostedSiteKnowledgeReference>? KnowledgeReferences { get; set; }
}

public sealed class HostedSiteKnowledgeReference
{
    public string? EntryId { get; set; }
    public string? StoreId { get; set; }
    public string? StoreName { get; set; }
    public string? Title { get; set; }
    public string? Content { get; set; }
}
