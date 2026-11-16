using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class DocumentStoreController
{
    private IMongoCollection<WritingTeaching> WritingTeachings => _db.Database.GetCollection<WritingTeaching>("document_writing_teaching");

    [HttpGet("entries/{entryId}/writing/teaching")]
    public async Task<IActionResult> GetWritingTeaching(string entryId)
    {
        var (entry, _, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var activeId = entry!.ActiveWritingTeachingId;
        var teaching = activeId == null ? null : await WritingTeachings.Find(t => t.Id == activeId && t.EntryId == entryId && t.StoreId == entry.StoreId).FirstOrDefaultAsync();
        teaching ??= await WritingTeachings.Find(t => t.EntryId == entryId && t.StoreId == entry.StoreId).SortByDescending(t => t.CreatedAt).FirstOrDefaultAsync();
        if (teaching != null && teaching.Status is "queued" or "scripting" or "voicing" or "rendering" or "saving") {
            var run = await _db.DocumentStoreAgentRuns.Find(r => r.Id == teaching.ActiveRunId).FirstOrDefaultAsync();
            if (run == null && teaching.UpdatedAt < DateTime.UtcNow.AddMinutes(-5)
                || run?.Status is DocumentStoreRunStatus.Failed or DocumentStoreRunStatus.Cancelled) {
                var update = Builders<WritingTeaching>.Update.Set(t => t.Status, "failed")
                    .Set(t => t.Failure, run?.ErrorMessage ?? "制作任务未能继续，已保存的脚本与配音仍保留。")
                    .Inc(t => t.Revision, 1).Set(t => t.UpdatedAt, DateTime.UtcNow);
                var recovered = await WritingTeachings.UpdateOneAsync(t => t.Id == teaching.Id && t.Revision == teaching.Revision && t.ActiveRunId == teaching.ActiveRunId, update);
                if (recovered.ModifiedCount == 1) await _db.DocumentEntries.UpdateOneAsync(e => e.Id == entryId && e.WritingTeachingRunId == teaching.ActiveRunId,
                    Builders<DocumentEntry>.Update.Set(e => e.WritingTeachingRunId, null).Set(e => e.WritingTeachingClaimedAt, null));
                teaching = await WritingTeachings.Find(t => t.Id == teaching.Id).FirstOrDefaultAsync();
            }
        }
        var recoveryPending = await RepairWritingTeachingClaimAsync(entry, teaching);
        return Ok(ApiResponse<object>.Ok(new { teaching, recoveryPending, sourceVersion = entry!.Writing?.Published?.Version,
            sourceFingerprint = entry.Writing?.Published is { } currentSource ? WritingTeachingPolicy.SourceFingerprint(currentSource) : null, canApprove = entry!.Writing?.AuthorId == GetUserId(),
            sourceCurrent = teaching == null || entry.Writing?.Published is { } publication && WritingTeachingPolicy.Matches(teaching, publication) }));
    }

    private async Task<bool> RepairWritingTeachingClaimAsync(DocumentEntry entry, WritingTeaching? teaching)
    {
        var lockedRun = entry.WritingTeachingRunId;
        if (lockedRun == null || teaching?.Status == "unknown") return false;
        var run = await _db.DocumentStoreAgentRuns.Find(r => r.Id == lockedRun).FirstOrDefaultAsync();
        if (run?.Status is DocumentStoreRunStatus.Queued or DocumentStoreRunStatus.Running) return false;
        var claimedAt = entry.WritingTeachingClaimedAt ?? teaching?.UpdatedAt ?? DateTime.UtcNow;
        if (run == null && claimedAt >= DateTime.UtcNow.AddMinutes(-5)) return true;
        // 两次持久写入之间重启也可恢复；按锁身份CAS，不能释放另一个窗口的新锁。
        await _db.DocumentEntries.UpdateOneAsync(e => e.Id == entry.Id && e.WritingTeachingRunId == lockedRun,
            Builders<DocumentEntry>.Update.Set(e => e.WritingTeachingRunId, null).Set(e => e.WritingTeachingClaimedAt, null));
        return false;
    }

    [HttpPost("entries/{entryId}/writing/teaching")]
    public async Task<IActionResult> GenerateWritingTeaching(string entryId, [FromBody] WritingTeachingRequest request)
    {
        var (entry, _, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var source = entry!.Writing?.Published;
        if (source == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先确认并发布文档，再制作教学"));
        if (request.RequestId.Length is < 16 or > 80 || !request.RequestId.All(char.IsAsciiLetterOrDigit) || request.Instructions.Length > 2000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "制作请求无效，请重新提交"));
        if (request.SourceVersion != source.Version || request.SourceFingerprint != WritingTeachingPolicy.SourceFingerprint(source)) return WritingConflict();
        if (TaskAdmissionService.ResolveOrigin(User, GetUserId()).Origin != TaskExecutionOrigins.Interactive)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请由作者在文档工作区发起教学制作"));
        var fingerprint = WritingDeliveryPolicy.Hash(new { entryId, source.Version, request.SourceFingerprint, request.Instructions });
        var id = WritingDeliveryPolicy.Hash(new { GetUserId = GetUserId(), entryId, request.RequestId });
        var previous = await WritingTeachings.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (previous != null) return previous.RequestFingerprint == fingerprint
            ? Ok(ApiResponse<object>.Ok(new { teaching = previous })) : WritingConflict();
        var speech = HttpContext.RequestServices.GetRequiredService<SpeechGenerationService>();
        var settings = await speech.GetSettingsAsync();
        var profile = settings.Profiles.FirstOrDefault(p => p.Enabled && p.IsDefault) ?? settings.Profiles.FirstOrDefault(p => p.Enabled);
        if (profile == null || profile.MaxTextChars < 180 || !profile.Formats.Contains("mp3") || string.IsNullOrWhiteSpace(profile.DefaultVoiceId))
            return UnprocessableEntity(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前环境缺少可用的中文解说能力，请在智能体接入台的语音创作中配置音色与MP3输出"));
        // 通过业务准入后才创建付费许可；普通查询、预览与审批没有模型执行权。
        var authority = await HttpContext.RequestServices.GetRequiredService<TaskAdmissionService>()
            .AdmitAuthenticatedPaidBranchAsync(HttpContext, HttpContext.RequestAborted);
        using var execution = TaskExecutionContext.Enter(authority);
        var run = new DocumentStoreAgentRun { Kind = WritingTeachingPolicy.RunKind, SourceEntryId = entryId, StoreId = entry.StoreId,
            UserId = GetUserId(), OwnerInstanceId = InstanceIdentity.Get(_config), TaskPermitId = authority.PermitId,
            Status = DocumentStoreRunStatus.Queued, CustomPrompt = id, Phase = "等待编排教学" };
        var teaching = new WritingTeaching { Id = id, EntryId = entryId, StoreId = entry.StoreId, OwnerId = GetUserId(), AuthorId = entry.Writing!.AuthorId,
            Source = WritingTeachingPolicy.Freeze(source), SourceFingerprint = request.SourceFingerprint, RequestFingerprint = fingerprint,
            Instructions = request.Instructions, ActiveRunId = run.Id, ProfileId = profile.Id, ProfileRevision = profile.Revision, VoiceId = profile.DefaultVoiceId,
            LandscapeKey = $"writing-teaching/{entry.StoreId}/{id}/landscape.mp4.enc", PortraitKey = $"writing-teaching/{entry.StoreId}/{id}/portrait.mp4.enc" };
        try { await WritingTeachings.InsertOneAsync(teaching); }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) {
            var replay = await WritingTeachings.Find(t => t.Id == id).FirstOrDefaultAsync();
            return replay?.RequestFingerprint == fingerprint ? Ok(ApiResponse<object>.Ok(new { teaching = replay })) : WritingConflict();
        }
        // 每份文档只有一个制作入口；固定ID先落库，再用条目受保护的制作锁CAS防并发双启动。
        var guard = Builders<DocumentEntry>.Filter.Eq(e => e.Id, entryId)
            & Builders<DocumentEntry>.Filter.Eq(e => e.Writing!.Published!.Version, source.Version)
            & Builders<DocumentEntry>.Filter.Eq(e => e.WritingTeachingRunId, null);
        var claimed = await _db.DocumentEntries.UpdateOneAsync(guard, Builders<DocumentEntry>.Update
            .Set(e => e.ActiveWritingTeachingId, id).Set(e => e.WritingTeachingRunId, run.Id).Set(e => e.WritingTeachingClaimedAt, DateTime.UtcNow));
        if (claimed.ModifiedCount != 1) {
            await WritingTeachings.DeleteOneAsync(t => t.Id == id && t.Status == "queued");
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "另一窗口已开始制作，请刷新查看"));
        }
        try { await _db.DocumentStoreAgentRuns.InsertOneAsync(run); }
        catch { return StatusCode(503, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "排队结果尚待确认，请刷新查看原制作任务，勿重复提交")); }
        return Ok(ApiResponse<object>.Ok(new { teaching }));
    }

    [HttpPost("entries/{entryId}/writing/teaching/{teachingId}/resume")]
    public async Task<IActionResult> ResumeWritingTeaching(string entryId, string teachingId, [FromBody] WritingTeachingResumeRequest request)
    {
        var (entry, _, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var teaching = await WritingTeachings.Find(t => t.Id == teachingId && t.EntryId == entryId && t.StoreId == entry!.StoreId).FirstOrDefaultAsync();
        if (teaching == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "教学不存在"));
        if (teaching.OwnerId != GetUserId()) return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "请由原制作人恢复任务，或由作者发起新的制作"));
        if (teaching.Status != "failed" || teaching.Revision != request.Revision) return WritingConflict();
        if (entry!.Writing?.Published is not { } source || !WritingTeachingPolicy.Matches(teaching, source))
            return UnprocessableEntity(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档已有新发布版，请制作新版本教学"));
        if (TaskAdmissionService.ResolveOrigin(User, GetUserId()).Origin != TaskExecutionOrigins.Interactive)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请在作者工作区恢复教学制作"));
        var authority = await HttpContext.RequestServices.GetRequiredService<TaskAdmissionService>()
            .AdmitAuthenticatedPaidBranchAsync(HttpContext, HttpContext.RequestAborted);
        var run = new DocumentStoreAgentRun { Kind = WritingTeachingPolicy.RunKind, SourceEntryId = entryId, StoreId = entry.StoreId,
            UserId = GetUserId(), OwnerInstanceId = InstanceIdentity.Get(_config), TaskPermitId = authority.PermitId,
            Status = DocumentStoreRunStatus.Queued, CustomPrompt = teachingId, Phase = "恢复已保存的教学制作" };
        var locked = await _db.DocumentEntries.UpdateOneAsync(Builders<DocumentEntry>.Filter.Eq(e => e.Id, entryId)
            & Builders<DocumentEntry>.Filter.Eq(e => e.WritingTeachingRunId, null),
            Builders<DocumentEntry>.Update.Set(e => e.WritingTeachingRunId, run.Id).Set(e => e.ActiveWritingTeachingId, teachingId).Set(e => e.WritingTeachingClaimedAt, DateTime.UtcNow));
        if (locked.ModifiedCount != 1) return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已有教学正在制作，请刷新查看"));
        var update = await WritingTeachings.UpdateOneAsync(t => t.Id == teachingId && t.Revision == request.Revision && t.Status == "failed",
            Builders<WritingTeaching>.Update.Set(t => t.ActiveRunId, run.Id).Set(t => t.ExecutionId, "").Set(t => t.Status, "queued")
                .Set(t => t.Failure, null).Set(t => t.Phase, run.Phase).Set(t => t.UpdatedAt, DateTime.UtcNow).Inc(t => t.Revision, 1));
        if (update.ModifiedCount != 1) {
            await _db.DocumentEntries.UpdateOneAsync(e => e.Id == entryId && e.WritingTeachingRunId == run.Id,
                Builders<DocumentEntry>.Update.Set(e => e.WritingTeachingRunId, null).Set(e => e.WritingTeachingClaimedAt, null));
            return WritingConflict();
        }
        try { await _db.DocumentStoreAgentRuns.InsertOneAsync(run); }
        catch { return StatusCode(503, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "恢复排队结果尚待确认，请刷新查看原任务")); }
        return Ok(ApiResponse<object>.Ok(new { teaching = await WritingTeachings.Find(t => t.Id == teachingId).FirstOrDefaultAsync() }));
    }

    [HttpPost("entries/{entryId}/writing/teaching/{teachingId}/approve")]
    public async Task<IActionResult> ApproveWritingTeaching(string entryId, string teachingId, [FromBody] WritingTeachingApproval request)
    {
        var (entry, _, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var teaching = await WritingTeachings.Find(t => t.Id == teachingId && t.EntryId == entryId && t.StoreId == entry!.StoreId).FirstOrDefaultAsync();
        if (teaching == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "教学不存在"));
        if (teaching.AuthorId != GetUserId()) return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "教学表达需由文档作者预览并批准"));
        if (teaching.Status != "ready" || teaching.Revision != request.Revision || teaching.ArtifactFingerprint != request.ArtifactFingerprint
            || request.ArtifactFingerprint != WritingTeachingPolicy.ArtifactFingerprint(teaching)
            || request.SourceVersion != teaching.Source.Version || request.SourceFingerprint != teaching.SourceFingerprint) return WritingConflict();
        // 审批明确批准该来源版本；即使另一个窗口发布下一版，也不能让此批准认领下一版。

        var result = await WritingTeachings.UpdateOneAsync(t => t.Id == teachingId && t.Revision == request.Revision && t.Status == "ready"
            && t.ArtifactFingerprint == request.ArtifactFingerprint,
            Builders<WritingTeaching>.Update.Set(t => t.Status, "approved").Set(t => t.ApprovedBy, GetUserId()).Set(t => t.ApprovedAt, DateTime.UtcNow)
                .Set(t => t.UpdatedAt, DateTime.UtcNow).Inc(t => t.Revision, 1));
        if (result.ModifiedCount != 1) return WritingConflict();
        return Ok(ApiResponse<object>.Ok(new { teaching = await WritingTeachings.Find(t => t.Id == teachingId).FirstOrDefaultAsync() }));
    }

    [HttpGet("entries/{entryId}/writing/teaching/{teachingId}/media")]
    public async Task<IActionResult> ReadWritingTeachingMedia(string entryId, string teachingId, [FromQuery] bool portrait = false)
    {
        var (entry, store, error) = await LoadReadableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var teaching = await WritingTeachings.Find(t => t.Id == teachingId && t.EntryId == entryId && t.StoreId == entry!.StoreId).FirstOrDefaultAsync();
        if (teaching == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "教学不存在"));
        var canWrite = await CanWriteStoreAsync(store!, GetUserId(), await _teams.GetMyTeamIdsAsync(GetUserId()));
        if (teaching.Status != "approved" && (!canWrite || teaching.Status != "ready"))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "教学尚未批准，仅写作成员可在工作区预览成品"));
        var key = portrait ? teaching.PortraitKey : teaching.LandscapeKey;
        var bytes = await _assetStorage.TryDownloadBytesAsync(key, HttpContext.RequestAborted);
        if (bytes == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成片暂不可用，请重试"));
        var protector = HttpContext.RequestServices.GetRequiredService<IDataProtectionProvider>().CreateProtector("writing-teaching", teaching.StoreId, teaching.Id);
        try { bytes = protector.Unprotect(bytes); }
        catch (System.Security.Cryptography.CryptographicException) { return StatusCode(503, ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前环境无法解密教学视频，请联系管理员检查持久化密钥")); }
        if (Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant() != (portrait ? teaching.PortraitSha256 : teaching.LandscapeSha256))
            return StatusCode(503, ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "成片校验未通过，请联系管理员核对文件"));
        return File(bytes, "video/mp4", enableRangeProcessing: true);
    }
}

public class WritingTeachingRequest
{
    public string RequestId { get; set; } = "";
    public int SourceVersion { get; set; }
    public string SourceFingerprint { get; set; } = "";
    public string Instructions { get; set; } = "";
}
public class WritingTeachingApproval
{
    public long Revision { get; set; }
    public string ArtifactFingerprint { get; set; } = "";
    public int SourceVersion { get; set; }
    public string SourceFingerprint { get; set; } = "";
}

public class WritingTeachingResumeRequest { public long Revision { get; set; } }
