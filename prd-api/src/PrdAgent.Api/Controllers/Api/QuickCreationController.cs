using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;

namespace PrdAgent.Api.Controllers.Api;

public sealed partial class DesignArtifactsController
{
    private const string QuickCreationSampleName = "需求评审的三个习惯.md";
    private const string QuickCreationSample = """
        刚加入团队的同学，第一次参加需求评审时常常不知道该看什么。这份说明只讲三个习惯，养成之后，评审会快很多。

        习惯一：先读目标
        打开需求，先找「这次要解决谁的什么问题」。如果一句话说不清，先别讨论方案，请提出人补一句目标。

        习惯二：再画边界
        写清楚这次不做什么。边界没写的需求，评审时最容易越聊越大。

        习惯三：最后对验收
        问一句：怎样算真的做完？能被别人照着检查的标准，才算验收标准。
        """;

    private static bool QuickCreationAcceptanceBranch() => DeploymentScope.Current != null
        && Environment.GetEnvironmentVariable("VITE_GIT_BRANCH") == "codex/dsn-1400e277-v6";

    private bool BrowserFilmEnabled() => _configuration.GetValue<bool?>("DesignRuntime:QuickCreation:BrowserFilmEnabled")
        ?? QuickCreationAcceptanceBranch();

    private bool QuickCreationEnabled() => _configuration.GetValue<bool>("DesignRuntime:QuickCreation:Enabled")
        || QuickCreationAcceptanceBranch();

    [HttpGet("/api/quick-creation/templates")]
    public IActionResult GetQuickCreationTemplates()
    {
        if (!QuickCreationEnabled()) return NotFound();
        var catalog = QuickCreationCatalog.Get();
        return Ok(ApiResponse<object>.Ok(new
        {
            items = catalog.Items.Select(item => new
            {
                item.Id, item.Name, item.NameEn, item.CategoryId, item.PosterUrl, item.Film, item.Line,
                item.DurationSec, item.PromptRef, item.NeedsImageTool,
            }),
            catalog.Categories,
            catalog.Source, browserFilm = BrowserFilmEnabled(),
        }));
    }

    [HttpPost("/api/quick-creation/attachments")]
    [RequestSizeLimit(6 * 1024 * 1024)]
    public async Task<IActionResult> UploadQuickCreationAttachment(
        [FromForm] IFormFile file, [FromServices] IAssetStorage storage, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var name = Path.GetFileName(file.FileName);
        var mime = Path.GetExtension(name).ToLowerInvariant() switch
        {
            ".md" or ".markdown" => "text/markdown",
            ".txt" => "text/plain",
            ".png" => "image/png",
            ".jpeg" or ".jpg" => "image/jpeg",
            ".webp" => "image/webp",
            _ => null,
        };
        if (mime == null) return QuickCreationError("支持 Markdown、TXT、PNG、JPEG 和 WebP，请改选文件");
        if (file.Length > DesignRunInputAttachments.MaxReferenceImageBytes)
            return QuickCreationError("单个附件不能超过 5 MB，请压缩或拆分后再试");
        await using var input = new MemoryStream();
        await file.CopyToAsync(input, ct);
        var bytes = input.ToArray();
        var isImage = mime.StartsWith("image/", StringComparison.Ordinal);
        if (isImage && GetQuickCreationImageError(mime, bytes) is { } imageError)
            return QuickCreationError(imageError);
        string? content = null;
        string? issue = null;
        if (!isImage)
        {
            try
            {
                content = DecodeQuickCreationText(bytes);
                issue = GetQuickCreationTextError(content);
            }
            catch (DecoderFallbackException)
            {
                issue = "无法按 UTF-8 读取文件，请重新保存为 UTF-8 或移除";
            }
        }
        return await SaveQuickCreationAttachmentAsync(name, mime, isImage ? "image" : "doc",
            content, issue, bytes, storage, ct);
    }

    [HttpPost("/api/quick-creation/attachments/text")]
    public async Task<IActionResult> AddQuickCreationText(
        [FromBody] QuickCreationTextRequest request, [FromServices] IAssetStorage storage, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var content = request.Text ?? string.Empty;
        var error = GetQuickCreationTextError(content);
        if (error != null) return QuickCreationError(error);
        return await SaveQuickCreationAttachmentAsync(TrimOptional(request.Name, 160) ?? "粘贴的正文.md",
            "text/markdown", "doc", content, null, Encoding.UTF8.GetBytes(content), storage, ct);
    }

    [HttpPost("/api/quick-creation/attachments/knowledge")]
    public async Task<IActionResult> AddQuickCreationKnowledge(
        [FromBody] DesignKnowledgeReferenceRequest request, [FromServices] IAssetStorage storage, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        if (request.EntryId == "sample-review-habits" && string.IsNullOrWhiteSpace(request.StoreId))
            return await SaveQuickCreationAttachmentAsync(QuickCreationSampleName, "text/markdown", "doc",
                QuickCreationSample, null, Encoding.UTF8.GetBytes(QuickCreationSample), storage, ct);
        if (string.IsNullOrWhiteSpace(request.EntryId) || string.IsNullOrWhiteSpace(request.StoreId))
            return QuickCreationError("请从知识库选择要加入的稿件");
        try
        {
            var rows = await _knowledgeSnapshots.ResolveAsync(this.GetRequiredUserId(),
                [new DesignKnowledgeReferenceIdentity(request.EntryId, request.StoreId, request.ContentHash)], ct);
            var source = rows.Single();
            var issue = GetQuickCreationTextError(source.Content);
            if (issue != null) return QuickCreationError(issue);
            return await SaveQuickCreationAttachmentAsync(TrimOptional(source.Title, 160) ?? "知识库稿件",
                "text/markdown", "kb", source.Content, null, Encoding.UTF8.GetBytes(source.Content), storage, ct);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            return KnowledgeReferenceFailure(ex);
        }
    }

    [HttpPost("/api/quick-creation/attachments/{attachmentId}/read")]
    public async Task<IActionResult> RetryQuickCreationAttachment(
        string attachmentId, [FromServices] IAssetStorage storage, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var userId = this.GetRequiredUserId();
        var filter = Builders<Attachment>.Filter.Where(row => row.AttachmentId == attachmentId
            && row.UploaderId == userId && row.QuickCreationKind != null);
        var attachment = await _db.Attachments.Find(filter).FirstOrDefaultAsync(ct);
        if (attachment == null) return NotFound();
        if (attachment.QuickCreationReadError == null)
            return Ok(ApiResponse<object>.Ok(ToQuickAttachment(attachment)));
        if (attachment.StorageKey is not { Length: > 0 } key)
            return QuickCreationError("原文件不可读取，请重新上传");
        var bytes = await storage.TryDownloadBytesAsync(key, ct);
        if (bytes == null) return QuickCreationError("原文件暂时没有读到，可以稍后重试或重新上传");
        try
        {
            var content = DecodeQuickCreationText(bytes);
            attachment.QuickCreationReadError = GetQuickCreationTextError(content);
            attachment.ExtractedText = attachment.QuickCreationReadError == null ? content : null;
            await _db.Attachments.UpdateOneAsync(filter, Builders<Attachment>.Update
                .Set(row => row.ExtractedText, attachment.ExtractedText)
                .Set(row => row.QuickCreationReadError, attachment.QuickCreationReadError), cancellationToken: ct);
        }
        catch (DecoderFallbackException)
        {
            return QuickCreationError("文件仍无法读取，请另存为 UTF-8 后重新上传");
        }
        return Ok(ApiResponse<object>.Ok(ToQuickAttachment(attachment)));
    }

    [HttpGet("/api/quick-creation/attachments/{attachmentId}/image")]
    public async Task<IActionResult> ReadQuickCreationAttachmentImage(
        string attachmentId, [FromServices] IAssetStorage storage, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var userId = this.GetRequiredUserId();
        var attachment = await _db.Attachments.Find(row => row.AttachmentId == attachmentId
            && row.UploaderId == userId && row.QuickCreationKind == "image" && row.QuickCreationReadError == null)
            .FirstOrDefaultAsync(ct);
        if (attachment?.StorageKey is not { Length: > 0 } key
            || attachment.MimeType is not ("image/png" or "image/jpeg" or "image/webp")) return NotFound();
        var bytes = await storage.TryDownloadBytesAsync(key, ct);
        if (bytes == null || bytes.LongLength != attachment.Size || !ValidQuickCreationImage(attachment.MimeType, bytes))
            return NotFound();
        Response.Headers.CacheControl = "private, no-store";
        return File(bytes, attachment.MimeType);
    }

    [HttpPost("/api/quick-creation/estimate")]
    public async Task<IActionResult> EstimateQuickCreation([FromBody] QuickCreationEstimateRequest request, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        if (request.Kind != "video" || !QuickCreationDuration.TryRead(request.Duration, out var duration))
            return QuickCreationError("请选择有效的成片时长");
        var ids = request.AttachmentIds?.Distinct(StringComparer.Ordinal).ToList() ?? [];
        if (ids.Any(id => !Guid.TryParseExact(id, "N", out _))) return QuickCreationError("有资料无法识别，请重新添加");
        var userId = this.GetRequiredUserId();
        var rows = ids.Count == 0 ? new List<Attachment>() : await _db.Attachments.Find(row => row.UploaderId == userId
            && ids.Contains(row.AttachmentId) && row.QuickCreationKind != null && row.QuickCreationReadError == null).ToListAsync(ct);
        if (rows.Count != ids.Count) return QuickCreationError("有资料没有读到，请检查后再估算");
        var chars = QuickCreationDuration.CountCharacters(rows.Where(row => row.QuickCreationKind != "image").Select(row => row.ExtractedText));
        return Ok(ApiResponse<object>.Ok(QuickCreationDuration.Estimate(chars, duration)));
    }

    [HttpPost("/api/quick-creation/runs")]
    public async Task<IActionResult> CreateQuickCreationRun([FromBody] QuickCreationRunRequest request, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        if (request.Kind is not ("video" or "web")) return QuickCreationError("请选择网页或视频");
        if (!QuickCreationDuration.TryRead(request.Duration, out var durationChoice))
            return QuickCreationError("请选择有效的成片时长");
        if (QuickCreationCatalog.Find(request.TemplateId) is not { } template)
            return QuickCreationError("这个风格不在当前目录，请重新选择");
        var ids = request.AttachmentIds?.Distinct(StringComparer.Ordinal).ToList() ?? [];
        if (ids.Any(id => string.IsNullOrWhiteSpace(id) || id.Length > 80))
            return QuickCreationError("有资料无法识别，请重新添加");
        var userId = this.GetRequiredUserId();
        if (request.BriefId != null && (!Guid.TryParseExact(request.BriefId, "N", out _)
            || request.BriefRevision is null or < 1 || request.BriefMode is not ("confirm" or "skip")))
            return QuickCreationError("请确认当前创作简报");
        await using var briefLease = request.BriefId == null ? null
            : await VideoAssetMutationLease.AcquireAsync(_db, $"quick-creation-brief:{userId}:{request.BriefId}", ct);
        QuickCreationBrief? brief = null;
        if (request.BriefId != null)
        {
            brief = await _db.QuickCreationBriefs.Find(OwnedBrief(request.BriefId)).FirstOrDefaultAsync(ct);
            if (brief == null) return NotFound();
            var existing = await _db.DesignArtifactRuns.Find(QuickCreationScope()
                & Builders<DesignArtifactRun>.Filter.Where(row => row.UserId == userId && row.QuickCreation != null
                    && row.RetryOfRunId == null && row.QuickCreation.BriefId == request.BriefId
                    && row.QuickCreation.BriefRevision == request.BriefRevision)).FirstOrDefaultAsync(ct);
            if (existing != null) return Accepted(ApiResponse<object>.Ok(await ToQuickRunAsync(existing, ct)));
            if (brief.Revision != request.BriefRevision || !BriefReady(brief) || brief.Kind != request.Kind
                || (brief.PendingTurnId != null && brief.PendingUntil > DateTime.UtcNow)
                || brief.StyleId != template.Id || !brief.AttachmentIds.SequenceEqual(ids)
                || (request.BriefMode == "confirm" && (brief.Kind != "video" || brief.Script.Count == 0)))
                return BriefConflict();
            if (brief.SourceTitle == null)
                ids.Add(await SaveBriefManuscriptAsync(brief, ct));
        }
        if (ids.Count == 0) return QuickCreationError("请放入至少一份可用稿件，或先完成创作简报");
        var rows = await _db.Attachments.Find(item => ids.Contains(item.AttachmentId) && item.UploaderId == userId
                && item.QuickCreationKind != null).ToListAsync(ct);
        if (rows.Count != ids.Count || rows.Any(row => row.QuickCreationReadError != null))
            return QuickCreationError("有资料没有读到，请在资料管理中检查后再生成");
        var byId = rows.ToDictionary(row => row.AttachmentId);
        var sourceIds = ids.Where(id => byId[id].QuickCreationKind != "image").ToList();
        if (sourceIds.Count == 0) return QuickCreationError("至少需要一份稿件或知识库文档");
        List<DesignReferenceImage> images;
        try
        {
            images = await DesignRunInputAttachments.ResolveImagesAsync(
                _db, userId, ids.Where(id => byId[id].QuickCreationKind == "image").ToList(), ct, quickCreation: true);
        }
        catch (DesignRunInputException ex)
        {
            return QuickCreationError(ex.Message);
        }
        var film = request.Kind == "video";
        var effectiveDurationChoice = request.Duration.HasValue ? durationChoice : brief?.DurationChoiceSec;
        var duration = film ? QuickCreationDuration.Estimate(
            brief != null && brief.SourceTitle == null ? 0 : QuickCreationDuration.CountCharacters(sourceIds.Select(id => byId[id].ExtractedText)),
            effectiveDurationChoice) : null;
        if (film && OpenDesignTransportResolver.Resolve(_configuration).Transport != OpenDesignTransport.Service)
            return Conflict(ApiResponse<object>.Fail("RUNTIME_NOT_READY", "视频执行服务暂不可用，稿件仍可改做网页"));
        var guide = QuickCreationCatalog.ReadGuide(template);
        var ask = request.Ask?.Trim() ?? string.Empty;
        if (brief != null)
        {
            var confirmed = new List<string> { ask };
            if (!string.IsNullOrWhiteSpace(brief.Audience)) confirmed.Add($"受众：{brief.Audience}");
            if (!string.IsNullOrWhiteSpace(brief.Duration)) confirmed.Add($"成品时长或篇幅：{brief.Duration}");
            if (request.BriefMode == "confirm")
                confirmed.Add("用户确认的分镜：\n" + string.Join("\n", brief.Script.Select(scene =>
                    $"{scene.Index}. {scene.DurationSec?.ToString() ?? "未定"}秒。画面：{scene.Visual}；旁白：{scene.Narration}")));
            ask = string.Join("\n", confirmed.Where(value => !string.IsNullOrWhiteSpace(value)));
        }
        var browserFilm = film && BrowserFilmEnabled();
        var input = new QuickCreationInput
        {
            TemplateId = template.Id, StyleSha256 = QuickCreationCatalog.Hash(guide), Ask = ask, AttachmentIds = ids,
            BriefId = brief?.Id, BriefRevision = brief?.Revision, BriefContentSource = brief == null ? null : brief.SourceTitle == null ? "chat" : "doc",
            BriefUserRequests = brief == null ? null : FreezeBriefUserRequests(brief.Messages),
            FilmTimeoutSeconds = duration is not null ? Math.Max(duration.GenerateMin[1] * 120,
                Math.Clamp(_configuration.GetValue<int?>("DesignRuntime:QuickCreation:FilmTimeoutSeconds") ?? 7200, 7200, 14400)) : null,
            TargetDurationSec = duration?.TargetSec, DurationChoiceSec = duration is null ? null : effectiveDurationChoice,
            PlannedScenes = duration?.Scenes, BrowserFilm = browserFilm,
            Trial = browserFilm && (request.Trial ?? duration?.TrialDefault ?? false),
        };
        var instruction = film
            ? $"用原版 Lemo-Opuscar 技能把附件稿件做成代码视频。风格：{template.Name}（{template.Id}）。完整读取随任务提供的 {template.PromptRef}，按原样说明执行。使用中文配音和同步字幕。" +
                (browserFilm ? " 交付方式以随任务提供的 brief/film-delivery.json 为准。" : "交付可播放的 MP4。")
            : $"把附件稿件做成可阅读的网页。完整读取 {template.PromptRef}，按「{template.Name}」借鉴配色、字体与版式。正文以稿件为准。";
        if (duration is not null)
            instruction += $" 成片目标约 {QuickCreationDuration.Label(duration.TargetSec)}，约 {duration.Scenes} 幕。以配音实测时长确定画面和字幕的时间轴。";
        if (input.BriefUserRequests is { Length: > 0 })
            instruction += $" 另请读取 {QuickCreationInput.BriefUserRequestsPath}，里面按顺序保留用户对作品的原话。";
        if (ask.Length > 0)
        {
            var inline = instruction + "\n\n用户要求：\n" + ask;
            input.UseWorkspaceRequest = inline.Length > MaxInlineInstructionChars;
            instruction = input.UseWorkspaceRequest
                ? instruction + $" 用户的完整要求见随任务提供的 {QuickCreationInput.WorkspaceRequestPath}。"
                : inline;
        }
        return await CreateRunCoreAsync(new CreateDesignArtifactRunRequest
        {
            ArtifactType = film ? DesignArtifactTypes.CodeFilm : DesignArtifactTypes.WebPage,
            Instruction = instruction,
            Title = brief?.SourceTitle ?? brief?.Title ?? request.Title ?? Path.GetFileNameWithoutExtension(byId[sourceIds[0]].FileName),
            AttachmentIds = sourceIds,
            DestinationTeamId = film ? null : request.DestinationTeamId,
        }, input, images, film ? null : QuickCreationCatalog.FreezeWebDirection(template));
    }

    [HttpGet("/api/quick-creation/runs/{runId}")]
    public async Task<IActionResult> GetQuickCreationRun(string runId, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run != null) return Ok(ApiResponse<object>.Ok(await ToQuickRunAsync(run, ct)));
        var shared = await FindSharedQuickRunAsync(runId, ct);
        return shared == null ? NotFound() : Ok(ApiResponse<object>.Ok(await ToQuickRunAsync(shared, ct, includePrivate: false)));
    }

    [HttpGet("/api/quick-creation/works")]
    public async Task<IActionResult> ListQuickCreationWorks(CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var userId = this.GetRequiredUserId();
        var runs = await _db.DesignArtifactRuns.Find(QuickCreationScope() & Builders<DesignArtifactRun>.Filter.Eq(row => row.UserId, userId))
            .SortByDescending(row => row.CreatedAt).Limit(60).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            items = runs.Select(run => new
            {
                runId = run.Id, run.Title, kind = QuickKind(run), templateId = run.QuickCreation!.TemplateId,
                status = QuickStatus(run), publishStatus = run.QuickCreationPublishedAt.HasValue ? "done" : "none",
                summary = QuickStatus(run) == "failed" ? "原稿和要求已保存" : run.Phase,
                run.UpdatedAt,
            }),
            total = runs.Count,
        }));
    }

    [HttpGet("/api/quick-creation/assets")]
    public async Task<IActionResult> ListQuickCreationAssets([FromQuery] string? scope, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        if (scope is not ("mine" or "team")) return QuickCreationError("请选择我的产物或团队产物");
        var userId = this.GetRequiredUserId();
        var filter = Builders<DesignArtifactRun>.Filter;
        var completed = QuickCreationScope() & filter.Eq(row => row.Status, RunStatuses.Done)
            & filter.Ne(row => row.QuickCreation!.Trial, true);
        if (scope == "mine") completed &= filter.Eq(row => row.UserId, userId);
        else
        {
            // 只有进入团队空间且经过现有托管权限检查的产物会出现在团队列表。
            completed &= filter.Ne(row => row.QuickCreationPublishedSiteId, null);
        }
        var runs = await _db.DesignArtifactRuns.Find(completed).SortByDescending(row => row.UpdatedAt).Limit(80).ToListAsync(ct);
        var result = new List<object>();
        foreach (var run in runs)
        {
            var mine = run.UserId == userId;
            var ownerName = "我";
            if (scope == "team")
            {
                var site = await _sites.GetByIdAsync(run.QuickCreationPublishedSiteId!, userId, ct);
                if (site == null || site.SharedTeamIds.Count == 0 || mine) continue;
                ownerName = await _db.Users.Find(user => user.UserId == run.UserId)
                    .Project(user => user.DisplayName).FirstOrDefaultAsync(ct) ?? "团队成员";
            }
            result.Add(new
            {
                id = run.Id, runId = run.Id, run.Title, kind = QuickKind(run), templateId = run.QuickCreation!.TemplateId,
                ownerName, mine, durationSec = run.QuickCreationMedia?.DurationSec,
                publishStatus = run.QuickCreationPublishedAt.HasValue ? "done" : "none",
                siteId = run.QuickCreationPublishedSiteId, run.UpdatedAt,
            });
        }
        return Ok(ApiResponse<object>.Ok(new { items = result, total = result.Count }));
    }

    [HttpGet("/api/quick-creation/runs/{runId}/film-bundle")]
    public async Task<IActionResult> ReadQuickCreationBrowserFilm(string runId, [FromQuery] bool player,
        [FromServices] IDesignArtifactWorkspaceBroker broker, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct) ?? await FindSharedQuickRunAsync(runId, ct);
        if (run?.QuickCreation?.BrowserFilm != true || run.Status != RunStatuses.Done) return NotFound();
        var bytes = await ReadBrowserFilmBundleAsync(run, broker, ct);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.Append("X-Content-Type-Options", "nosniff");
        if (!player) return File(bytes, "application/json");
        Response.Headers.Append("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'");
        return Content(QuickCreationBrowserPlayback.RenderSandbox(bytes), "text/html", Encoding.UTF8);
    }

    private static async Task<byte[]> ReadBrowserFilmBundleAsync(DesignArtifactRun run, IDesignArtifactWorkspaceBroker broker, CancellationToken ct)
    {
        var package = await broker.ReadCommittedCodeFilmAsync(run, ct);
        return Convert.FromBase64String(package.Files.Single(file => file.Path == "film-bundle.json").ContentBase64);
    }

    [HttpPost("/api/quick-creation/runs/{runId}/export")]
    public async Task<IActionResult> QueueQuickCreationExport(string runId, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run?.QuickCreation is not { BrowserFilm: true, Trial: false } || run.Status != RunStatuses.Done) return NotFound();
        var filters = Builders<DesignArtifactRun>.Filter;
        var owner = filters.Eq(row => row.Id, run.Id) & filters.Eq(row => row.UserId, run.UserId);
        await _db.DesignArtifactRuns.UpdateOneAsync(owner & (filters.Eq(row => row.BrowserFilmExport, null)
            | filters.Eq(row => row.BrowserFilmExport!.Status, "failed")),
            Builders<DesignArtifactRun>.Update.Set(row => row.BrowserFilmExport, new QuickCreationBrowserExport()), cancellationToken: ct);
        return await ReadQuickCreationExport(runId, ct);
    }

    [HttpGet("/api/quick-creation/runs/{runId}/export")]
    public async Task<IActionResult> ReadQuickCreationExport(string runId, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run?.QuickCreation is not { BrowserFilm: true, Trial: false } || run.Status != RunStatuses.Done) return NotFound();
        var export = run.BrowserFilmExport;
        var queuedAt = export?.QueuedAt;
        var ahead = export?.Status == "queued" && queuedAt.HasValue ? await _db.DesignArtifactRuns.CountDocumentsAsync(QuickCreationExportWorker.Scope
            & Builders<DesignArtifactRun>.Filter.Where(row => row.Id != run.Id && row.BrowserFilmExport != null
                && (row.BrowserFilmExport.Status == "running" || (row.BrowserFilmExport.Status == "queued"
                    && row.BrowserFilmExport.QueuedAt < queuedAt.Value))), cancellationToken: ct) : 0;
        return Ok(ApiResponse<object>.Ok(new { status = export?.Status ?? "none", ahead, error = export?.Error,
            downloadAvailable = export?.Status == "done" && !string.IsNullOrWhiteSpace(export.AssetKey) }));
    }

    [HttpGet("/api/quick-creation/runs/{runId}/export/file")]
    public async Task<IActionResult> DownloadQuickCreationExport(string runId, [FromServices] IAssetStorage storage, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run?.BrowserFilmExport is not { Status: "done", AssetKey: { } key }) return NotFound();
        var bytes = await storage.TryDownloadBytesAsync(key, ct);
        if (bytes == null) return NotFound();
        Response.Headers.CacheControl = "private, no-store";
        return File(bytes, "video/mp4", run.Title + ".mp4");
    }

    [HttpPost("/api/quick-creation/runs/{runId}/publish")]
    public async Task<IActionResult> PublishQuickCreationRun(
        string runId, [FromServices] IDesignArtifactWorkspaceBroker broker,
        [FromServices] OpenDesignServiceArtifactExecutor recovery, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run == null) return NotFound();
        if (run.Status != RunStatuses.Done || run.QuickCreation?.Trial == true)
            return Conflict(ApiResponse<object>.Fail("RUN_NOT_COMPLETE", "成品还未生成，请回到本次任务查看"));
        if (run.QuickCreationPublishedAt != null)
            return Ok(ApiResponse<object>.Ok(await ToQuickRunAsync(run, ct)));
        var siteId = run.ArtifactSiteId;
        if (run.QuickCreation?.BrowserFilm == true)
        {
            await using var lease = await VideoAssetMutationLease.AcquireAsync(_db, "quick-creation-publish:" + run.Id, ct);
            var sourceRef = "code-film:" + run.Id;
            var site = await _db.HostedSites.Find(row => row.OwnerUserId == run.UserId && row.SourceRef == sourceRef).FirstOrDefaultAsync(ct);
            if (site == null)
            {
                var bytes = await ReadBrowserFilmBundleAsync(run, broker, ct);
                var zip = QuickCreationBrowserPlayback.BuildPublishedZip(run.Title, bytes);
                site = await _sites.CreateFromZipAsync(run.UserId, zip, run.Title, null, null, null, "html",
                    CancellationToken.None, sourceRef: sourceRef);
            }
            siteId = site.Id;
        }
        else if (run.ArtifactType == DesignArtifactTypes.CodeFilm)
        {
            var saved = await SaveCodeFilm(runId, broker, recovery, ct);
            if (saved is not OkObjectResult response) return saved;
            var data = System.Text.Json.JsonSerializer.SerializeToElement(response.Value,
                new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
            siteId = data.GetProperty("data").GetProperty("siteId").GetString();
        }
        if (siteId == null)
            return Conflict(ApiResponse<object>.Fail("SITE_NOT_AVAILABLE", "成品仍保留。网页托管暂时没有返回记录，请稍后重试"));
        await _db.DesignArtifactRuns.UpdateOneAsync(row => row.Id == run.Id && row.UserId == run.UserId
                && row.QuickCreationPublishedAt == null,
            Builders<DesignArtifactRun>.Update.Set(row => row.QuickCreationPublishedAt, DateTime.UtcNow)
                .Set(row => row.QuickCreationPublishedSiteId, siteId), cancellationToken: CancellationToken.None);
        var published = await FindOwnedQuickRunAsync(run.Id, CancellationToken.None) ?? run;
        return Ok(ApiResponse<object>.Ok(await ToQuickRunAsync(published, CancellationToken.None)));
    }

    [HttpPost("/api/quick-creation/runs/{runId}/retry")]
    public async Task<IActionResult> RetryQuickCreationRun(string runId, [FromBody] QuickCreationRetryRequest request,
        [FromServices] OpenDesignServiceArtifactExecutor recovery, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run?.QuickCreation == null) return NotFound();
        var resume = request.Action is "resume" or "retry-unit";
        var retryFilmScene = request.Action == "retry-unit" ? request.UnitIndex : null;
        if (run.Status != RunStatuses.Error || (!resume && request.Action != "requeue")
            || (request.Action == "retry-unit" && retryFilmScene is not (>= 1 and <= 100))
            || (resume && run.ArtifactType != DesignArtifactTypes.CodeFilm))
            return Conflict(ApiResponse<object>.Fail("RUN_RETRY_NOT_AVAILABLE", "这条任务目前无法按该操作恢复，原稿仍保留"));
        if (QuickCreationCatalog.Find(run.QuickCreation.TemplateId) is not { } template
            || run.QuickCreation.StyleSha256 != template.GuideSha256)
            return Conflict(ApiResponse<object>.Fail("STYLE_CHANGED", "原风格版本已变化，请先回看原稿再新建"));

        await using var lease = await VideoAssetMutationLease.AcquireAsync(_db, "quick-creation-retry:" + run.Id, ct);
        var resumeFrom = resume ? run.Id : null;
        var already = await _db.DesignArtifactRuns.Find(row => row.UserId == run.UserId
                && row.QuickCreation != null && row.RetryOfRunId == run.Id && row.DeploymentSlug == DeploymentScope.Current
                && row.ResumeFilmFromRunId == resumeFrom && row.RetryFilmSceneIndex == retryFilmScene)
            .SortByDescending(row => row.CreatedAt).FirstOrDefaultAsync(ct);
        if (already != null) return Accepted(ApiResponse<object>.Ok(await ToQuickRunAsync(already, ct)));
        if (resume)
        {
            var checkpoint = await recovery.ReadFilmProjectAsync(run, ct);
            if (checkpoint == null || (retryFilmScene.HasValue && checkpoint.IncompleteScene != retryFilmScene))
                return Conflict(ApiResponse<object>.Fail("FILM_CHECKPOINT_UNAVAILABLE", "暂时取不到对应的分镜或配音。稍后重试，或用原稿重新排队"));
        }
        return await CreateRunCoreAsync(new CreateDesignArtifactRunRequest
        {
            ArtifactType = run.ArtifactType, Instruction = run.Instruction, Title = run.Title,
            AttachmentIds = run.UploadedSources?.Select(item => item.AttachmentId).ToList(),
            DestinationTeamId = run.DestinationTeamId,
        }, run.QuickCreation, run.ReferenceImages, run.DesignDirection, retryOfRunId: run.Id, resumeFilm: resume ? run : null,
            retryFilmScene: retryFilmScene);
    }

    [HttpPost("/api/quick-creation/runs/{runId}/trial/approve")]
    public async Task<IActionResult> ApproveQuickCreationTrial(string runId,
        [FromServices] OpenDesignServiceArtifactExecutor recovery, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run?.QuickCreation is not { BrowserFilm: true, Trial: true } input || run.Status != RunStatuses.Done)
            return Conflict(ApiResponse<object>.Fail("TRIAL_NOT_AVAILABLE", "试看还未就绪，请稍后重试"));
        await using var lease = await VideoAssetMutationLease.AcquireAsync(_db, "quick-creation-trial:" + run.Id, ct);
        var already = await _db.DesignArtifactRuns.Find(QuickCreationScope() & Builders<DesignArtifactRun>.Filter.Where(row =>
            row.UserId == run.UserId && row.ResumeFilmFromRunId == run.Id && row.QuickCreation != null && !row.QuickCreation.Trial))
            .SortByDescending(row => row.CreatedAt).FirstOrDefaultAsync(ct);
        if (already != null) return Accepted(ApiResponse<object>.Ok(await ToQuickRunAsync(already, ct)));
        var checkpoint = await recovery.ReadFilmProjectAsync(run, ct);
        if (checkpoint is not { CompletedScenes: 2, NarrationClips: >= 2 })
            return Conflict(ApiResponse<object>.Fail("FILM_CHECKPOINT_UNAVAILABLE", "试看仍可播放，暂时取不到续做素材。请稍后再试"));
        return await CreateRunCoreAsync(new CreateDesignArtifactRunRequest
        {
            ArtifactType = run.ArtifactType, Instruction = run.Instruction, Title = run.Title,
            AttachmentIds = run.UploadedSources?.Select(item => item.AttachmentId).ToList(),
        }, input.ApproveTrial(), run.ReferenceImages, run.DesignDirection, retryOfRunId: run.Id, resumeFilm: run);
    }

    private FilterDefinition<DesignArtifactRun> QuickCreationScope()
    {
        var f = Builders<DesignArtifactRun>.Filter;
        var scope = DeploymentScope.CurrentDurable;
        return f.Ne(row => row.QuickCreation, null)
            & (scope == null ? f.Eq(row => row.DeploymentSlug, null) : DesignArtifactTimingStats.ScopeFilter(scope));
    }

    private async Task<DesignArtifactRun?> FindOwnedQuickRunAsync(string runId, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        return await _db.DesignArtifactRuns.Find(QuickCreationScope() & Builders<DesignArtifactRun>.Filter
            .Where(row => row.Id == runId && row.UserId == userId)).FirstOrDefaultAsync(ct);
    }

    private async Task<DesignArtifactRun?> FindSharedQuickRunAsync(string runId, CancellationToken ct)
    {
        var filter = Builders<DesignArtifactRun>.Filter;
        var run = await _db.DesignArtifactRuns.Find(QuickCreationScope() & filter.Where(row => row.Id == runId
                && row.Status == RunStatuses.Done && row.QuickCreationPublishedSiteId != null))
            .FirstOrDefaultAsync(ct);
        if (run?.QuickCreationPublishedSiteId == null) return null;
        var site = await _sites.GetByIdAsync(run.QuickCreationPublishedSiteId, this.GetRequiredUserId(), ct);
        return site is { SharedTeamIds.Count: > 0 } ? run : null;
    }

    private static string QuickStatus(DesignArtifactRun run) => run.Status switch
    {
        RunStatuses.Queued => "queued",
        RunStatuses.Running or RunStatuses.Committing => "running",
        RunStatuses.Done when run.QuickCreation?.Trial == true => "trial-ready",
        RunStatuses.Done => "done",
        _ => "failed",
    };

    private static string QuickKind(DesignArtifactRun run) =>
        run.ArtifactType == DesignArtifactTypes.CodeFilm ? "video" : "web";

    private async Task<object> ToQuickRunAsync(DesignArtifactRun run, CancellationToken ct, bool includePrivate = true)
    {
        var input = run.QuickCreation!;
        var status = QuickStatus(run);
        var attachments = includePrivate ? await _db.Attachments.Find(row => row.UploaderId == run.UserId
                && input.AttachmentIds.Contains(row.AttachmentId)).ToListAsync(ct) : new List<Attachment>();
        var byId = attachments.ToDictionary(row => row.AttachmentId);
        var now = DateTime.UtcNow;
        var estimate = status is "queued" or "running" ? await QuickCreationMedianAsync(run, ct) : null;
        object? queue = null;
        if (status == "queued")
        {
            var active = await _db.DesignArtifactRuns.Find(row => row.DeploymentSlug == run.DeploymentSlug
                    && row.ArtifactType == run.ArtifactType
                    && (row.Status == RunStatuses.Running || row.Status == RunStatuses.Committing))
                .SortBy(row => row.CreatedAt).Limit(30).ToListAsync(ct);
            var f = Builders<DesignArtifactRun>.Filter;
            var aheadFilter = f.Eq(row => row.DeploymentSlug, run.DeploymentSlug)
                & f.Eq(row => row.ArtifactType, run.ArtifactType) & f.Eq(row => row.Status, RunStatuses.Queued)
                & (f.Lt(row => row.CreatedAt, run.CreatedAt)
                   | (f.Eq(row => row.CreatedAt, run.CreatedAt) & f.Lt(row => row.Id, run.Id)));
            var ahead = await _db.DesignArtifactRuns.CountDocumentsAsync(aheadFilter, cancellationToken: ct);
            var ownAhead = await _db.DesignArtifactRuns.Find(aheadFilter & f.Eq(row => row.UserId, run.UserId))
                .SortBy(row => row.CreatedAt).Limit(10).ToListAsync(ct);
            var capacity = run.ArtifactType == DesignArtifactTypes.CodeFilm
                ? Math.Max(1, OpenDesignTransportResolver.CodeFilmSlots(_configuration).Count) : 1;
            var startInSec = estimate is { } median ? Math.Min(86_400,
                (int)Math.Min(1000, (active.Count + ahead) / capacity) * median) : (int?)null;
            queue = new
            {
                position = ahead + 1, ahead, running = active.Count, capacity, startInSec,
                runningItems = active.Where(row => row.UserId == run.UserId).Select(row => new
                {
                    ownerName = "我", row.Title, kind = QuickKind(row), elapsedSec = ElapsedSeconds(row, now),
                    remainSec = estimate is { } typical ? Math.Max(0, typical - ElapsedSeconds(row, now)) : (int?)null,
                }),
                aheadItems = ownAhead.Select(row => new
                {
                    ownerName = "我", row.Title, kind = QuickKind(row),
                }),
            };
        }
        var stageStatus = status switch { "done" or "trial-ready" => "done", "failed" => "failed", "running" => "running", _ => "pending" };
        var checkpoint = includePrivate && run.Status == RunStatuses.Error && run.ArtifactType == DesignArtifactTypes.CodeFilm
            ? await HttpContext.RequestServices.GetRequiredService<OpenDesignServiceArtifactExecutor>().ReadFilmProjectAsync(run, ct)
            : null;
        var saved = new List<string> { "稿件", "创作要求", "所选风格" };
        if (checkpoint is { CompletedScenes: > 0 }) saved.Add($"已完成的 {checkpoint.CompletedScenes} 幕");
        if (checkpoint is { NarrationClips: > 0 }) saved.Add($"已生成的 {checkpoint.NarrationClips} 段配音");
        var timedOut = run.RuntimeFailure?.Code == "open_design_run_timeout";
        var incompleteScene = timedOut ? null : checkpoint?.IncompleteScene;
        object? failure = status == "failed" ? new
        {
            stageKey = incompleteScene.HasValue ? "scene" : run.PhaseCode,
            unitIndex = incompleteScene,
            completedScenes = checkpoint?.CompletedScenes,
            message = run.Status == RunStatuses.Cancelled ? "任务已停止，稿件和要求仍可回看"
                : timedOut ? "生成超时，已停止"
                : run.RuntimeFailure?.Code == "code_film_checkpoint_unavailable" ? "没能取回上次保留的分镜或配音"
                : run.RuntimeFailure?.Code == "code_film_checkpoint_changed" ? "这次恢复改动了已完成的部分，原检查点仍保留"
                : incompleteScene.HasValue ? $"第 {incompleteScene} 幕没有完成"
                : "这次没有生成完，原稿和要求已保存",
            saved,
            actions = run.Status != RunStatuses.Error ? Array.Empty<string>()
                : incompleteScene.HasValue ? new[] { "retry-unit", "requeue" }
                : checkpoint != null ? new[] { "resume", "requeue" } : new[] { "requeue" },
        } : null;
        return new
        {
            run.Id, run.Title, kind = QuickKind(run), templateId = input.TemplateId,
            recoveryFromRunId = includePrivate ? run.ResumeFilmFromRunId : null,
            contentSource = includePrivate ? input.BriefContentSource : null,
            ask = includePrivate ? input.Ask : string.Empty,
            briefUserRequests = includePrivate ? input.BriefUserRequests : null,
            attachments = input.AttachmentIds.Where(byId.ContainsKey).Select(id => ToQuickAttachment(byId[id])),
            status, queue, elapsedSec = ElapsedSeconds(run, now), failure,
            remainSec = status == "running" && estimate is { } seconds ? Math.Max(0, seconds - ElapsedSeconds(run, now)) : (int?)null,
            estimateBasis = estimate.HasValue ? "近期同风格成功任务的执行时长中位数" : null,
            durationSec = run.QuickCreationMedia?.DurationSec,
            targetDurationSec = input.TargetDurationSec,
            bundleUrl = input.BrowserFilm && (status is "done" or "trial-ready") ? $"/api/quick-creation/runs/{run.Id}/film-bundle" : null,
            bundleBytes = run.QuickCreationMedia?.BundleBytes,
            trial = input.Trial || run.ResumeFilmFromRunId != null && input.BrowserFilm
                ? new { status = input.Trial ? status == "trial-ready" ? "ready" : "making" : "approved",
                    scenes = 2, seconds = run.QuickCreationMedia?.DurationSec, restScenes = Math.Max(0, (input.PlannedScenes ?? 4) - 2) }
                : null,
            durationChoice = input.DurationChoiceSec,
            captions = run.QuickCreationMedia?.Captions,
            captionsBurnedIn = run.QuickCreationMedia?.CaptionsBurnedIn,
            hasSubtitleFreePreview = run.QuickCreationMedia?.HasSubtitleFreePreview,
            stages = new[] { new { key = run.PhaseCode, label = run.Phase, status = stageStatus, run.Progress } },
            media = run.ArtifactType == DesignArtifactTypes.CodeFilm && !input.BrowserFilm && status == "done"
                ? new { url = $"/api/design-artifacts/runs/{run.Id}/film.mp4", mime = "video/mp4" } : null,
            previewSiteId = run.ArtifactType == DesignArtifactTypes.WebPage ? run.ArtifactSiteId : null,
            previewHtml = run.ArtifactType == DesignArtifactTypes.WebPage && run.ArtifactSiteId == null ? run.LatestPreviewHtml : null,
            publish = new { status = run.QuickCreationPublishedAt.HasValue ? "done" : "none", siteId = run.QuickCreationPublishedSiteId,
                siteTitle = run.Title, at = run.QuickCreationPublishedAt },
            run.CreatedAt, run.UpdatedAt,
        };
    }

    private Task<int?> QuickCreationMedianAsync(DesignArtifactRun run, CancellationToken ct)
    {
        var cache = HttpContext.RequestServices.GetRequiredService<IMemoryCache>();
        var templateId = run.QuickCreation!.TemplateId;
        return cache.GetOrCreateAsync<int?>($"quick-creation-duration:{run.DeploymentSlug}:{run.ArtifactType}:{templateId}", async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(1);
            var samples = await _db.DesignArtifactRuns.Find(QuickCreationScope()
                    & Builders<DesignArtifactRun>.Filter.Where(row => row.Status == RunStatuses.Done
                        && row.ArtifactType == run.ArtifactType && row.QuickCreation!.TemplateId == templateId
                        && row.ExecutionStartedAt != null && row.CompletedAt != null))
                .SortByDescending(row => row.CompletedAt).Limit(20)
                .Project(row => new { row.ExecutionStartedAt, row.CompletedAt }).ToListAsync(ct);
            var durations = samples.Select(row => (int)(row.CompletedAt!.Value - row.ExecutionStartedAt!.Value).TotalSeconds)
                .Where(value => value > 0).Order().ToArray();
            return durations.Length >= 3 ? durations[durations.Length / 2] : null;
        });
    }

    private static int ElapsedSeconds(DesignArtifactRun run, DateTime now) =>
        run.ExecutionStartedAt is { } started ? (int)Math.Max(0, ((run.CompletedAt ?? now) - started).TotalSeconds) : 0;

    private async Task<IActionResult> SaveQuickCreationAttachmentAsync(
        string name, string mime, string kind, string? content, string? issue, byte[] bytes, IAssetStorage storage, CancellationToken ct)
    {
        StoredAsset? stored = null;
        if (bytes.Length > 0)
        {
            stored = await storage.SaveAsync(bytes, mime, ct, domain: "prd-agent", type: kind == "image" ? "img" : "doc", fileName: name);
            if (string.IsNullOrWhiteSpace(stored.Key))
                return StatusCode(503, ApiResponse<object>.Fail("ATTACHMENT_STORAGE_UNAVAILABLE", "附件暂时无法保存，请在原页面重试"));
        }
        var attachment = new Attachment
        {
            AttachmentId = Guid.NewGuid().ToString("N"), UploaderId = this.GetRequiredUserId(), FileName = name,
            MimeType = mime, Size = bytes.Length, Url = stored?.Url ?? "", StorageKey = stored?.Key,
            Type = kind == "image" ? AttachmentType.Image : AttachmentType.Document,
            QuickCreationKind = kind, ExtractedText = issue == null ? content : null, QuickCreationReadError = issue,
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(ToQuickAttachment(attachment)));
    }

    private static object ToQuickAttachment(Attachment attachment) => new
    {
        id = attachment.AttachmentId, kind = attachment.QuickCreationKind, name = attachment.FileName,
        meta = $"{attachment.Size / 1024.0:0.#} KB", status = attachment.QuickCreationReadError == null ? "ready" : "failed",
        chars = attachment.ExtractedText?.Length, error = attachment.QuickCreationReadError,
        excerpt = attachment.QuickCreationReadError == null ? attachment.ExtractedText : null,
    };

    private static string DecodeQuickCreationText(byte[] bytes) => new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');

    private static string? GetQuickCreationTextError(string content) =>
        string.IsNullOrWhiteSpace(content) ? "文件没有可读文字，请重新上传或移除" : null;

    private static bool ValidQuickCreationImage(string mime, byte[] bytes) => mime switch
    {
        "image/png" => bytes.AsSpan().StartsWith(new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a }),
        "image/jpeg" => bytes.AsSpan().StartsWith(new byte[] { 0xff, 0xd8, 0xff }),
        "image/webp" => bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8)
            && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8),
        _ => false,
    };

    private static string? GetQuickCreationImageError(string mime, byte[] bytes)
    {
        const string unreadable = "图片内容无法读取，请重新导出为 PNG、JPEG 或 WebP 后再试";
        if (!ValidQuickCreationImage(mime, bytes)) return unreadable;
        try
        {
            var options = new DecoderOptions { MaxFrames = 1, SkipMetadata = true };
            var info = Image.Identify(options, bytes);
            if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > 64L * 1024 * 1024)
                return "参考图像素尺寸过大，请缩小图片后重新上传";
            using var decoded = Image.Load(options, bytes);
            return decoded.Width == info.Width && decoded.Height == info.Height ? null : unreadable;
        }
        catch (Exception error) when (error is UnknownImageFormatException or InvalidImageContentException or NotSupportedException or IOException)
        {
            return unreadable;
        }
    }

    private BadRequestObjectResult QuickCreationError(string message) =>
        BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message));

    internal static string FreezeBriefUserRequests(IEnumerable<QuickCreationBriefMessage> messages) =>
        string.Join("\n\n", messages
            .Where(message => message.Role == "user" && !AllowsBriefStart(message.Text, true))
            .Select(message => message.Text));

    private async Task<string> SaveBriefManuscriptAsync(QuickCreationBrief brief, CancellationToken ct)
    {
        var text = brief.Manuscript!;
        var key = QuickCreationCatalog.Hash(Encoding.UTF8.GetBytes($"brief/{brief.UserId}/{brief.Id}/{brief.Revision}"))[..32];
        var attachment = new Attachment
        {
            AttachmentId = key, UploaderId = brief.UserId, FileName = "对话创作稿件.md",
            MimeType = "text/markdown", Size = Encoding.UTF8.GetByteCount(text),
            Type = AttachmentType.Document, QuickCreationKind = "doc", ExtractedText = text,
        };
        await _db.Attachments.ReplaceOneAsync(row => row.AttachmentId == key && row.UploaderId == brief.UserId,
            attachment, new ReplaceOptions { IsUpsert = true }, ct);
        return key;
    }
}

public sealed record QuickCreationTextRequest(string? Name, string? Text);
public sealed record QuickCreationEstimateRequest(string? Kind, List<string>? AttachmentIds, JsonElement? Duration);
public sealed record QuickCreationRunRequest(string? Kind, string? TemplateId, string? Ask, List<string>? AttachmentIds, string? Title,
    string? DestinationTeamId = null, string? BriefId = null, int? BriefRevision = null, string? BriefMode = null, JsonElement? Duration = null, bool? Trial = null);
public sealed record QuickCreationRetryRequest(string? Action, int? UnitIndex = null);
