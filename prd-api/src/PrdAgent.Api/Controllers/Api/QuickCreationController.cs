using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

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

    private bool QuickCreationEnabled() => _configuration.GetValue<bool>("DesignRuntime:QuickCreation:Enabled")
        || (DeploymentScope.Current != null
            && Environment.GetEnvironmentVariable("VITE_GIT_BRANCH") == "codex/dsn-1400e277-v6");

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
            catalog.Source,
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
        if (isImage && !ValidQuickCreationImage(mime, bytes))
            return QuickCreationError("图片内容无法识别，请重新导出为受支持的格式再试");
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
            attachment.ExtractedText = DecodeQuickCreationText(bytes);
            attachment.QuickCreationReadError = GetQuickCreationTextError(attachment.ExtractedText);
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

    [HttpPost("/api/quick-creation/runs")]
    public async Task<IActionResult> CreateQuickCreationRun([FromBody] QuickCreationRunRequest request, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        if (request.Kind is not ("video" or "web")) return QuickCreationError("请选择网页或视频");
        if (QuickCreationCatalog.Find(request.TemplateId) is not { } template)
            return QuickCreationError("这个风格不在当前目录，请重新选择");
        if (request.Ask?.Length > 3500) return QuickCreationError("创作要求太长，请缩短后再提交");
        var ids = request.AttachmentIds?.Distinct(StringComparer.Ordinal).ToList() ?? [];
        if (ids.Count is 0 or > DesignRunInputAttachments.QuickCreationAttachmentLimit
            || ids.Any(id => string.IsNullOrWhiteSpace(id) || id.Length > 80))
            return QuickCreationError("请放入一至十份可用资料");
        var userId = this.GetRequiredUserId();
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
                _db, userId, ids.Where(id => byId[id].QuickCreationKind == "image").ToList(), ct);
        }
        catch (DesignRunInputException ex)
        {
            return QuickCreationError(ex.Message);
        }
        var film = request.Kind == "video";
        if (film && OpenDesignTransportResolver.Resolve(_configuration).Transport != OpenDesignTransport.Service)
            return Conflict(ApiResponse<object>.Fail("RUNTIME_NOT_READY", "视频执行服务暂不可用，稿件仍可改做网页"));
        var guide = QuickCreationCatalog.ReadGuide(template);
        var ask = request.Ask?.Trim() ?? string.Empty;
        var input = new QuickCreationInput
        {
            TemplateId = template.Id, StyleSha256 = QuickCreationCatalog.Hash(guide), Ask = ask, AttachmentIds = ids,
            FilmTimeoutSeconds = film ? Math.Clamp(_configuration.GetValue<int?>("DesignRuntime:QuickCreation:FilmTimeoutSeconds") ?? 7200, 3300, 7200) : null,
        };
        var instruction = film
            ? $"用原版 Lemo-Opuscar 技能把附件稿件做成代码视频。风格：{template.Name}（{template.Id}）。完整读取随任务提供的 {template.PromptRef}，按原样说明执行。使用中文配音和同步字幕，交付可播放的 MP4。"
            : $"把附件稿件做成可阅读的网页。完整读取 {template.PromptRef}，按「{template.Name}」借鉴配色、字体与版式。正文以稿件为准。";
        return await CreateRunCoreAsync(new CreateDesignArtifactRunRequest
        {
            ArtifactType = film ? DesignArtifactTypes.CodeFilm : DesignArtifactTypes.WebPage,
            Instruction = ask.Length == 0 ? instruction : instruction + "\n\n用户要求：\n" + ask,
            Title = request.Title ?? Path.GetFileNameWithoutExtension(byId[sourceIds[0]].FileName),
            AttachmentIds = sourceIds,
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
        var completed = QuickCreationScope() & filter.Eq(row => row.Status, RunStatuses.Done);
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

    [HttpPost("/api/quick-creation/runs/{runId}/publish")]
    public async Task<IActionResult> PublishQuickCreationRun(
        string runId, [FromServices] IDesignArtifactWorkspaceBroker broker,
        [FromServices] OpenDesignServiceArtifactExecutor recovery, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run == null) return NotFound();
        if (run.Status != RunStatuses.Done)
            return Conflict(ApiResponse<object>.Fail("RUN_NOT_COMPLETE", "成品还未生成，请回到本次任务查看"));
        if (run.QuickCreationPublishedAt != null)
            return Ok(ApiResponse<object>.Ok(await ToQuickRunAsync(run, ct)));
        var siteId = run.ArtifactSiteId;
        if (run.ArtifactType == DesignArtifactTypes.CodeFilm)
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
    public async Task<IActionResult> RetryQuickCreationRun(string runId, [FromBody] QuickCreationRetryRequest request, CancellationToken ct)
    {
        if (!QuickCreationEnabled()) return NotFound();
        var run = await FindOwnedQuickRunAsync(runId, ct);
        if (run?.QuickCreation == null) return NotFound();
        if (run.Status != RunStatuses.Error || request.Action != "requeue")
            return Conflict(ApiResponse<object>.Fail("RUN_RETRY_NOT_AVAILABLE", "这条任务目前无法按该操作恢复，原稿仍保留"));
        if (QuickCreationCatalog.Find(run.QuickCreation.TemplateId) is not { } template
            || run.QuickCreation.StyleSha256 != template.GuideSha256)
            return Conflict(ApiResponse<object>.Fail("STYLE_CHANGED", "原风格版本已变化，请先回看原稿再新建"));

        // 使用原稿重新排队，保留旧任务。只有执行器提供了保全检查点时才能承诺从某一幕续做。
        await using var lease = await VideoAssetMutationLease.AcquireAsync(_db, "quick-creation-retry:" + run.Id, ct);
        var already = await _db.DesignArtifactRuns.Find(row => row.UserId == run.UserId
                && row.QuickCreation != null && row.RetryOfRunId == run.Id && row.DeploymentSlug == DeploymentScope.Current)
            .SortByDescending(row => row.CreatedAt).FirstOrDefaultAsync(ct);
        if (already != null) return Accepted(ApiResponse<object>.Ok(await ToQuickRunAsync(already, ct)));
        return await CreateRunCoreAsync(new CreateDesignArtifactRunRequest
        {
            ArtifactType = run.ArtifactType, Instruction = run.Instruction, Title = run.Title,
            AttachmentIds = run.UploadedSources?.Select(item => item.AttachmentId).ToList(),
        }, run.QuickCreation, run.ReferenceImages, run.DesignDirection, retryOfRunId: run.Id);
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
        var stageStatus = status switch { "done" => "done", "failed" => "failed", "running" => "running", _ => "pending" };
        object? failure = status == "failed" ? new
        {
            stageKey = run.PhaseCode,
            message = run.Status == RunStatuses.Cancelled ? "任务已停止，稿件和要求仍可回看" : "这次没有生成完，原稿和要求已保存",
            saved = new[] { "稿件", "创作要求", "所选风格" },
            actions = run.Status == RunStatuses.Error ? new[] { "requeue" } : Array.Empty<string>(),
        } : null;
        return new
        {
            run.Id, run.Title, kind = QuickKind(run), templateId = input.TemplateId,
            ask = includePrivate ? input.Ask : string.Empty,
            attachments = input.AttachmentIds.Where(byId.ContainsKey).Select(id => ToQuickAttachment(byId[id])),
            status, queue, elapsedSec = ElapsedSeconds(run, now), failure,
            remainSec = status == "running" && estimate is { } seconds ? Math.Max(0, seconds - ElapsedSeconds(run, now)) : (int?)null,
            estimateBasis = estimate.HasValue ? "近期同风格成功任务的执行时长中位数" : null,
            durationSec = run.QuickCreationMedia?.DurationSec,
            captions = run.QuickCreationMedia?.Captions,
            stages = new[] { new { key = run.PhaseCode, label = run.Phase, status = stageStatus, run.Progress } },
            media = run.ArtifactType == DesignArtifactTypes.CodeFilm && status == "done"
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
            QuickCreationKind = kind, ExtractedText = content, QuickCreationReadError = issue,
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(ToQuickAttachment(attachment)));
    }

    private static object ToQuickAttachment(Attachment attachment) => new
    {
        id = attachment.AttachmentId, kind = attachment.QuickCreationKind, name = attachment.FileName,
        meta = $"{attachment.Size / 1024.0:0.#} KB", status = attachment.QuickCreationReadError == null ? "ready" : "failed",
        chars = attachment.ExtractedText?.Length, error = attachment.QuickCreationReadError,
        excerpt = attachment.ExtractedText is { Length: > 8000 } text ? text[..8000] : attachment.ExtractedText,
    };

    private static string DecodeQuickCreationText(byte[] bytes) => new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');

    private static string? GetQuickCreationTextError(string content) =>
        string.IsNullOrWhiteSpace(content) ? "文件没有可读文字，请重新上传或移除"
        : content.Length > DesignRunInputAttachments.QuickCreationCharacterLimit ? "单份稿件超过 2 万字，请精简后重传" : null;

    private static bool ValidQuickCreationImage(string mime, byte[] bytes) => mime switch
    {
        "image/png" => bytes.AsSpan().StartsWith(new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a }),
        "image/jpeg" => bytes.AsSpan().StartsWith(new byte[] { 0xff, 0xd8, 0xff }),
        "image/webp" => bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8)
            && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8),
        _ => false,
    };

    private BadRequestObjectResult QuickCreationError(string message) =>
        BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message));
}

public sealed record QuickCreationTextRequest(string? Name, string? Text);
public sealed record QuickCreationRunRequest(string? Kind, string? TemplateId, string? Ask, List<string>? AttachmentIds, string? Title);
public sealed record QuickCreationRetryRequest(string? Action);
