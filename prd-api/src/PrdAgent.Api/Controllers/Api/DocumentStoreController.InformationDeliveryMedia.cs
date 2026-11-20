using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

public partial class DocumentStoreController
{
    [HttpPost("stores/{storeId}/information-delivery/{runId}/media")]
    public async Task<IActionResult> AssembleInformationDeliveryMedia(
        string storeId, string runId, [FromBody] InformationDeliveryMediaRequest request,
        [FromServices] IDesignArtifactWorkspaceBroker broker,
        [FromServices] IDesignKnowledgeSnapshotResolver sources,
        [FromServices] SpeechGenerationService speech,
        [FromServices] IDataProtectionProvider protection,
        CancellationToken ct)
    {
        var actor = GetUserId();
        var (_, denied) = await LoadWritableStoreAsync(storeId, actor);
        if (denied != null) return denied;
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.UserId == actor && item.DeliveryTemplateId != null && item.Status == RunStatuses.Done, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成品尚未就绪"));
        if (!await CanReadDeliveryKnowledgeAsync(run, actor, sources, ct))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "来源已不可访问"));
        if (run.DeliveryMediaFiles?.Count > 0)
            return Ok(ApiResponse<object>.Ok(new { media = run.DeliveryMediaFiles }));
        var formats = run.DeliveryMediaFormats ?? [];
        if (formats.Count == 0 || request.SpeechRunIds == null || request.SpeechRunIds.Count is < 1 or > 12)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "此任务没有选择讲解媒体，或配音不完整"));

        var package = await broker.ReadDeliveryResultAsync(run);
        var chapters = InformationDeliveryTemplates.ReadReadyCourse(package);
        if (chapters.Count != request.SpeechRunIds.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先完成各章配音"));
        var voiceIds = new List<string>();
        for (var i = 0; i < chapters.Count; i++)
        {
            var voice = await speech.GetRunAsync(actor, request.SpeechRunIds[i]);
            if (voice == null || voice.Status != SpeechRunStatus.Completed || voice.Text != chapters[i].Narration
                || voice.Format != "mp3")
                return Conflict(ApiResponse<object>.Fail("DELIVERY_VOICE_NOT_READY", "配音尚未完成，或与这版课程不一致"));
            voiceIds.Add(voice.Id);
        }

        var lease = Guid.NewGuid().ToString("N");
        var now = DateTime.UtcNow;
        var updates = Builders<DesignArtifactRun>.Update;
        var filters = Builders<DesignArtifactRun>.Filter;
        var sameRun = filters.Where(item => item.Id == runId && item.UserId == actor && item.DeploymentSlug == run.DeploymentSlug
            && item.Status == RunStatuses.Done && item.WorkspaceResultSha256 == run.WorkspaceResultSha256);
        var claim = await _db.DesignArtifactRuns.UpdateOneAsync(sameRun
                & filters.Eq(item => item.DeliveryMediaFiles, null)
                & filters.Eq(item => item.DeliveryArchive, null)
                & (filters.Eq(item => item.DeliveryMediaLeaseUntil, null) | filters.Lt(item => item.DeliveryMediaLeaseUntil, now)),
            updates.Set(item => item.DeliveryMediaLeaseId, lease).Set(item => item.DeliveryMediaLeaseUntil, now.AddMinutes(6)),
            cancellationToken: ct);
        if (claim.MatchedCount == 0)
            return Conflict(ApiResponse<object>.Fail("DELIVERY_MEDIA_BUSY", "成品正在合成讲解或已归档，请刷新查看"));

        var inLease = sameRun & filters.Eq(item => item.DeliveryMediaLeaseId, lease);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        try
        {
            var voices = new List<byte[]>();
            var totalBytes = 0;
            foreach (var voiceId in voiceIds)
            {
                timeout.Token.ThrowIfCancellationRequested();
                var audio = await speech.ReadAudioAsync(actor, voiceId);
                if (audio.Bytes.Length is <= 0 or > 8 * 1024 * 1024 || totalBytes + audio.Bytes.Length > 32 * 1024 * 1024)
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "配音没有内容或超过大小限制"));
                totalBytes += audio.Bytes.Length;
                voices.Add(audio.Bytes);
            }
            var rendered = await InformationDeliveryMediaRenderer.RenderAsync(chapters, voices, formats, timeout.Token);
            var media = new List<InformationDeliveryMediaFile>();
            var protector = protection.CreateProtector("information-delivery-media", run.Id, run.WorkspaceResultSha256!);
            foreach (var file in rendered)
            {
                var hash = Convert.ToHexString(SHA256.HashData(file.Bytes)).ToLowerInvariant();
                var key = $"information-delivery/{run.Id}/{hash}.{file.Format}.enc";
                await _assetStorage.UploadToKeyAsync(key, protector.Protect(file.Bytes),
                    "application/octet-stream", timeout.Token, "private, no-store");
                media.Add(new InformationDeliveryMediaFile { Format = file.Format, ObjectKey = key, Sha256 = hash, Chapters = file.Chapters });
            }
            var saved = await _db.DesignArtifactRuns.UpdateOneAsync(inLease,
                updates.Set(item => item.DeliveryMediaFiles, media), cancellationToken: CancellationToken.None);
            if (saved.MatchedCount != 1)
                return Conflict(ApiResponse<object>.Fail("DELIVERY_MEDIA_BUSY", "合成任务已变化，请刷新查看"));
            return Ok(ApiResponse<object>.Ok(new { media }));
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or OperationCanceledException or SpeechException or CryptographicException)
        {
            _logger.LogWarning(ex, "Information delivery media assembly interrupted, runId={RunId}", runId);
            return Conflict(ApiResponse<object>.Fail("DELIVERY_MEDIA_RENDER_FAILED", "讲解媒体合成未完成，配音可继续使用，稍后重试"));
        }
        finally
        {
            await _db.DesignArtifactRuns.UpdateOneAsync(inLease,
                updates.Unset(item => item.DeliveryMediaLeaseId).Unset(item => item.DeliveryMediaLeaseUntil),
                cancellationToken: CancellationToken.None);
        }
    }

    [HttpGet("stores/{storeId}/information-delivery/{runId}/media/{format}")]
    public async Task<IActionResult> ReadInformationDeliveryMedia(
        string storeId, string runId, string format,
        [FromServices] IDesignKnowledgeSnapshotResolver sources,
        [FromServices] IDataProtectionProvider protection,
        CancellationToken ct)
    {
        var actor = GetUserId();
        var (store, denied) = await LoadReadableStoreAsync(storeId, actor);
        if (denied != null) return denied;
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.DeliveryTemplateId != null && item.Status == RunStatuses.Done, ct);
        var file = run?.DeliveryMediaFiles?.SingleOrDefault(item => item.Format == format);
        if (run == null || file == null || store == null || store.IsPublic
            || (actor != run.UserId && !await CanReadDeliveryPublicationAsync(run, storeId, ct))
            || (actor != run.UserId && run.UploadedSources?.Count > 0 && run.DeliveryArchive?.CanShareUploads != true)
            || !(run.DeliveryArchive == null
                ? await CanReadDeliveryKnowledgeAsync(run, actor, sources, ct)
                : await CanReadPublishedDeliverySourcesAsync(run, actor, sources, ct)))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "讲解媒体不存在或不可访问"));
        try
        {
            if (run.UploadedSources?.Count > 0)
                await DesignRunInputAttachments.ResolveSourcesAsync(_db, run.UserId,
                    run.UploadedSources.Select(source => source.AttachmentId).ToList(), ct);
        }
        catch (DesignRunInputException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上传资料已不可访问"));
        }
        var retained = await _assetStorage.TryDownloadBytesAsync(file.ObjectKey, ct);
        if (retained == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "讲解媒体暂不可读"));
        byte[] bytes;
        try
        {
            bytes = protection.CreateProtector("information-delivery-media", run.Id, run.WorkspaceResultSha256!).Unprotect(retained);
        }
        catch (CryptographicException)
        {
            return Conflict(ApiResponse<object>.Fail("DELIVERY_MEDIA_CHECKSUM", "讲解媒体校验失败"));
        }
        if (!string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), file.Sha256, StringComparison.OrdinalIgnoreCase))
            return Conflict(ApiResponse<object>.Fail("DELIVERY_MEDIA_CHECKSUM", "讲解媒体校验失败"));
        Response.Headers.CacheControl = "private, no-store";
        return File(bytes, format == "video" ? "video/mp4" : "audio/mpeg", enableRangeProcessing: true);
    }

    private async Task<bool> CanReadDeliveryPublicationAsync(DesignArtifactRun run, string storeId, CancellationToken ct)
    {
        var archive = run.DeliveryArchive;
        if (archive?.ArtifactId == null || archive.StoreId != storeId || archive.ResultHash != run.WorkspaceResultSha256)
            return false;
        return archive.Target == "web-hosting"
            ? await _db.HostedSites.Find(site => site.Id == archive.ArtifactId && site.OwnerUserId == run.UserId).AnyAsync(ct)
            : await _db.DocumentEntries.Find(entry => entry.Id == archive.ArtifactId && entry.StoreId == storeId).AnyAsync(ct);
    }
}

public sealed record InformationDeliveryMediaRequest(List<string>? SpeechRunIds);
