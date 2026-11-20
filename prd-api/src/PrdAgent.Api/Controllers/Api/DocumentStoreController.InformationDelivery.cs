using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class DocumentStoreController
{
    [HttpPost("stores/{storeId}/information-delivery/{runId}/archive")]
    public async Task<IActionResult> ArchiveInformationDelivery(
        string storeId, string runId, [FromBody] ArchiveInformationDeliveryRequest request,
        [FromServices] IDesignArtifactWorkspaceBroker broker,
        [FromServices] IDesignKnowledgeSnapshotResolver sources,
        [FromServices] IHostedSiteService hosting,
        CancellationToken ct)
    {
        var actor = GetUserId();
        var (store, denied) = await LoadWritableStoreAsync(storeId, actor);
        if (denied != null) return denied;
        if (store == null || store.IsPublic)
            return Conflict(ApiResponse<object>.Fail("DELIVERY_PUBLIC_STORE", "请选择有访问控制的知识库作为交付范围"));
        if (request.Target is not ("web-hosting" or "knowledge-base") || !request.AuthorConfirmed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择归档去向并确认成品和来源"));
        if (request.Target == "web-hosting")
        {
            // 知识库业务路由只走库权限校验，不一定有管理中间件注入的权限声明。
            var permissions = User.HasClaim("authType", "agent-apikey") ? null : await GetEffectivePermissionsAsync();
            if (!AdminPermissionMiddleware.HasVerifiedPermission(HttpContext, AdminPermissionCatalog.WebPagesWrite, permissions))
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要网页托管写权限才能归档到网页托管"));
        }
        var frontend = _config["CDS_PREVIEW_URL"] ?? _config["App:FrontendBaseUrl"] ?? Request.ResolveExternalBaseUrl();
        Uri? frontendBase = null;
        if (request.Target == "web-hosting" && (!Uri.TryCreate(frontend, UriKind.Absolute, out frontendBase)
                || frontendBase.Scheme is not ("https" or "http") || frontendBase.UserInfo.Length != 0))
            return StatusCode(503, ApiResponse<object>.Fail("DELIVERY_ORIGIN_UNAVAILABLE", "当前环境未提供可访问的成品入口"));
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.UserId == actor && item.DeliveryTemplateId != null, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "信息传递任务不存在"));
        if (run.Status != RunStatuses.Done || run.DeliveryCorrectionsClosedAt == null
            || run.DeliveryAppliedRevision != run.DeliveryCorrectionRevision
            || run.WorkspaceResultSha256 == null || run.WorkspaceResultSha256 != request.ResultHash)
            return Conflict(ApiResponse<object>.Fail("DELIVERY_DRAFT_CHANGED", "请重新读取已就绪的成品，并确认当前版本"));
        if (run.DeliveryMediaFormats?.Any(format => run.DeliveryMediaFiles?.Any(file => file.Format == format) != true) == true)
            return Conflict(ApiResponse<object>.Fail("DELIVERY_MEDIA_NOT_READY", "请等已选的音频和视频生成完毕再归档"));
        var archive = run.DeliveryArchive;
        List<DesignKnowledgeArchiveAuthority>? sourceAuthority = null;
        if (archive == null || run.DeliveryArchiveSourceAuthority == null)
        {
            try
            {
                sourceAuthority = run.KnowledgeReferences.Count == 0 ? [] : await sources.CaptureArchiveAuthorityAsync(
                    actor, run.KnowledgeReferences, run.KnowledgeOriginals, ct);
            }
            catch (DesignKnowledgeSnapshotException) when (archive != null)
            {
                // An idempotent author request can still use an archive with verified historical authority.
            }
            catch (DesignKnowledgeSnapshotException)
            {
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "来源已不可访问"));
            }
        }
        if (archive != null && !await CanReadPublishedDeliverySourcesAsync(run, actor, sources, ct))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "来源已不可访问"));
        try
        {
            if (run.UploadedSources?.Count > 0)
                await DesignRunInputAttachments.ResolveSourcesAsync(_db, actor,
                    run.UploadedSources.Select(source => source.AttachmentId).ToList(), ct);
        }
        catch (DesignRunInputException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上传来源已不可访问"));
        }

        var package = await broker.ReadDeliveryResultAsync(run);
        InformationDeliveryTemplates.EnsureReadyCourse(package);
        var scope = Builders<DesignArtifactRun>.Filter.Where(item => item.Id == run.Id
            && item.UserId == actor && item.DeploymentSlug == run.DeploymentSlug
            && item.Status == RunStatuses.Done && item.WorkspaceResultSha256 == request.ResultHash);
        if (archive == null)
        {
            var reservation = new InformationDeliveryArchive
            {
                Target = request.Target,
                StoreId = store.Id,
                ResultHash = run.WorkspaceResultSha256,
                CanShareUploads = request.CanShareUploads,
                ConfirmedAt = DateTime.UtcNow,
            };
            run = await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
                scope & Builders<DesignArtifactRun>.Filter.Eq(item => item.DeliveryArchive, null),
                Builders<DesignArtifactRun>.Update.Set(item => item.DeliveryArchive, reservation)
                    .Set(item => item.DeliveryArchiveSourceAuthority, sourceAuthority),
                new FindOneAndUpdateOptions<DesignArtifactRun> { ReturnDocument = ReturnDocument.After }, ct)
                ?? await _db.DesignArtifactRuns.Find(scope).FirstOrDefaultAsync(ct);
            archive = run?.DeliveryArchive;
        }
        if (run == null || archive == null || archive.Target != request.Target || archive.StoreId != store.Id
            || archive.ResultHash != request.ResultHash || archive.CanShareUploads != request.CanShareUploads)
            return Conflict(ApiResponse<object>.Fail("DELIVERY_DESTINATION_CONFLICT", "此版本已确认另一种交付方式，请打开已归档成品"));

        if (sourceAuthority != null && run.DeliveryArchiveSourceAuthority == null)
        {
            // An author repeating the exact confirmation can attest an unchanged source for a legacy archive.
            await _db.DesignArtifactRuns.UpdateOneAsync(scope & Builders<DesignArtifactRun>.Filter.Where(item =>
                item.DeliveryArchiveSourceAuthority == null && item.DeliveryArchive != null
                && item.DeliveryArchive.StoreId == store.Id && item.DeliveryArchive.Target == request.Target
                && item.DeliveryArchive.ResultHash == request.ResultHash && item.DeliveryArchive.CanShareUploads == request.CanShareUploads),
                Builders<DesignArtifactRun>.Update.Set(item => item.DeliveryArchiveSourceAuthority, sourceAuthority),
                cancellationToken: ct);
        }

        var readerPath = DeliveryReaderPath(store.Id, runId);
        if (archive.ArtifactId != null)
            return Ok(ApiResponse<object>.Ok(new { artifactId = archive.ArtifactId, readerPath, archive.Target }));
        string artifactId;
        if (archive.Target == "web-hosting")
        {
            // The hosted site bears a link. The verified content stays behind the source and store checks.
            var target = new Uri(frontendBase!, readerPath).AbsoluteUri;
            var html = $"""
                <!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
                <title>信息传递</title><main><h1>信息传递</h1>
                <p><a href="{WebUtility.HtmlEncode(target)}" target="_blank" rel="noopener">打开已归档成品</a></p></main></html>
                """;
            var site = await hosting.CreateFromHtmlIdempotentAsync(actor, Encoding.UTF8.GetBytes(html), "delivery.html",
                "信息传递 · 已归档成品", "打开成品时检查知识库和来源权限", null, ["信息传递"],
                "information-delivery", $"delivery:{runId}:{archive.ResultHash}", CancellationToken.None);
            artifactId = site.Id;
        }
        else
        {
            artifactId = await WriteInformationDeliveryEntryAsync(store, run, archive, readerPath, ct);
        }

        await _db.DesignArtifactRuns.UpdateOneAsync(
            scope & Builders<DesignArtifactRun>.Filter.Eq(item => item.DeliveryArchive!.ArtifactId, null),
            Builders<DesignArtifactRun>.Update.Set(item => item.DeliveryArchive!.ArtifactId, artifactId),
            cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { artifactId, readerPath, archive.Target }));
    }

    [HttpGet("stores/{storeId}/information-delivery/{runId}/archive")]
    public async Task<IActionResult> ReadInformationDeliveryArchive(
        string storeId, string runId,
        [FromServices] IDesignArtifactWorkspaceBroker broker,
        [FromServices] IDesignKnowledgeSnapshotResolver sources,
        CancellationToken ct)
    {
        var actor = GetUserId();
        var (store, denied) = await LoadReadableStoreAsync(storeId, actor);
        if (denied != null) return denied;
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.DeliveryArchive != null && item.DeliveryArchive.StoreId == storeId
                && item.DeliveryArchive.ArtifactId != null && item.Status == RunStatuses.Done, ct);
        var archive = run?.DeliveryArchive;
        if (store == null || store.IsPublic || run == null || archive == null || run.WorkspaceResultSha256 != archive.ResultHash
            || (actor != run.UserId && run.UploadedSources?.Count > 0 && !archive.CanShareUploads)
            || !await CanReadPublishedDeliverySourcesAsync(run, actor, sources, ct))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成品不存在或你没有读取来源的权限"));
        try
        {
            if (run.UploadedSources?.Count > 0)
                await DesignRunInputAttachments.ResolveSourcesAsync(_db, run.UserId,
                    run.UploadedSources.Select(source => source.AttachmentId).ToList(), ct);
        }
        catch (DesignRunInputException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "原上传来源已不可访问"));
        }

        // An archive record may be removed from its selected destination later.
        var present = await CanReadDeliveryPublicationAsync(run, storeId, ct);
        if (!present) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "已找不到归档记录"));

        var package = await broker.ReadDeliveryResultAsync(run);
        InformationDeliveryTemplates.EnsureReadyCourse(package);
        Response.Headers.CacheControl = "no-store";
        return Ok(ApiResponse<object>.Ok(new
        {
            title = run.Title,
            archive.ConfirmedAt,
            archive.ResultHash,
            media = run.DeliveryMediaFiles,
            html = package.IndexHtml,
            course = Encoding.UTF8.GetString(Convert.FromBase64String(
                package.Files.Single(item => item.Path == InformationDeliveryTemplates.CoursePath).ContentBase64)),
            authorDecisions = (run.DeliveryCorrections ?? []).Where(item => item.Revision <= run.DeliveryAppliedRevision)
                .OrderBy(item => item.Revision).Select(item => new { item.Id, item.Revision, item.Text }),
            sources = run.KnowledgeReferences.Select(source => new { kind = "knowledge", source.Title, source.Content, source.ContentHash })
                .Concat((run.UploadedSources ?? new List<DesignUploadedSource>()).Select(source =>
                    new { kind = "upload", Title = source.FileName, source.Content, source.ContentHash })),
        }));
    }

    private async Task<string> WriteInformationDeliveryEntryAsync(
        DocumentStore store, DesignArtifactRun run, InformationDeliveryArchive archive, string readerPath, CancellationToken ct)
    {
        const string title = "信息传递 · 已归档成品";
        var entryId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"delivery:{store.Id}:{run.Id}")))
            .ToLowerInvariant()[..32];
        var content = $"# {title}\n\n[打开经过确认的成品]({readerPath})\n";
        var parsed = await _documentService.ParseAsync(content);
        parsed.Id = entryId;
        parsed.Title = title;
        await _db.Documents.ReplaceOneAsync(item => item.Id == entryId, parsed, new ReplaceOptions { IsUpsert = true }, ct);
        var entries = Builders<DocumentEntry>.Update;
        await _db.DocumentEntries.UpdateOneAsync(item => item.Id == entryId,
            entries.SetOnInsert(item => item.StoreId, store.Id)
                .SetOnInsert(item => item.DocumentId, parsed.Id)
                .SetOnInsert(item => item.Title, title)
                .SetOnInsert(item => item.CreatedBy, run.UserId)
                .SetOnInsert(item => item.CreatedAt, archive.ConfirmedAt)
                .SetOnInsert(item => item.UpdatedAt, archive.ConfirmedAt)
                .SetOnInsert(item => item.ContentType, "text/markdown")
                .SetOnInsert(item => item.SourceType, DocumentSourceType.Import)
                .SetOnInsert(item => item.FileSize, Encoding.UTF8.GetByteCount(content)),
            new UpdateOptions { IsUpsert = true }, ct);
        await _db.DocumentStores.UpdateOneAsync(
            Builders<DocumentStore>.Filter.Eq(item => item.Id, store.Id)
                & !Builders<DocumentStore>.Filter.AnyEq(item => item.InformationDeliveryCountedEntryIds!, entryId),
            Builders<DocumentStore>.Update.Inc(item => item.DocumentCount, 1)
                .AddToSet(item => item.InformationDeliveryCountedEntryIds!, entryId).Set(item => item.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        return entryId;
    }

    internal static string DeliveryReaderPath(string storeId, string runId) =>
        $"/document-store/{Uri.EscapeDataString(storeId)}/delivery/{Uri.EscapeDataString(runId)}/read";

    private static async Task<bool> CanReadDeliveryKnowledgeAsync(
        DesignArtifactRun run, string actor, IDesignKnowledgeSnapshotResolver resolver, CancellationToken ct)
    {
        try
        {
            if (run.KnowledgeReferences.Count == 0) return true;
            var references = run.KnowledgeReferences.Select(source =>
                new DesignKnowledgeReferenceIdentity(source.EntryId, source.StoreId ?? string.Empty)).ToArray();
            await resolver.ResolveAsync(actor, references, ct);
            return true;
        }
        catch (DesignKnowledgeSnapshotException)
        {
            return false;
        }
    }

    private static async Task<bool> CanReadPublishedDeliverySourcesAsync(
        DesignArtifactRun run, string actor, IDesignKnowledgeSnapshotResolver resolver, CancellationToken ct)
    {
        try
        {
            if (run.KnowledgeReferences.Count == 0) return true;
            await resolver.RequireArchiveReadAccessAsync(actor, run.KnowledgeReferences, run.KnowledgeOriginals,
                run.DeliveryArchiveSourceAuthority, run.DeliveryArchive!.ConfirmedAt, ct);
            return true;
        }
        catch (DesignKnowledgeSnapshotException)
        {
            return false;
        }
    }
}

public sealed record ArchiveInformationDeliveryRequest(
    string Target, string ResultHash, bool AuthorConfirmed, bool CanShareUploads);
