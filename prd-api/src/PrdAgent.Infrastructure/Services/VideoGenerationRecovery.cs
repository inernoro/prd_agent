using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Infrastructure.Services;

/// <summary>重新进入原执行许可；不补发许可、不推测供应商终态、不重放已有发送。</summary>
public sealed class VideoGenerationRecovery(
    MongoDbContext db, LlmGatewayDataContext data, ITaskExecutionCoordinator coordinator, IConfiguration configuration)
{
    public sealed record Target(string PermitId, string ExecutionId, string Caller, int SceneIndex = -1);
    public sealed record Acquisition(Target Target, TaskExecutionLease? Lease, string? ErrorCode);

    public static Target? Describe(VideoGenRun run, int? sceneIndex = null)
    {
        if (run.CancelRequested || run.DeletionRequestedAt != null
            || run.AppKey is not ("video-agent" or "visual-agent")) return null;
        if (run.Mode == VideoGenMode.Storyboard && run.Status == VideoGenRunStatus.Scripting
            && !string.IsNullOrWhiteSpace(run.TaskPermitId))
            return new(run.TaskPermitId, run.Id, AppCallerRegistry.VideoAgent.Script.Chat);
        if (run.Mode == VideoGenMode.Direct && run.Status == VideoGenRunStatus.Rendering
            && !string.IsNullOrWhiteSpace(run.TaskPermitId))
            return new(run.TaskPermitId, run.Id, run.AppKey == "visual-agent"
                ? AppCallerRegistry.VisualAgent.VideoGen.Generate : AppCallerRegistry.VideoAgent.VideoGen.Generate);
        if (run.Mode != VideoGenMode.Storyboard || run.Status != VideoGenRunStatus.Editing) return null;
        var index = sceneIndex ?? run.Scenes.FindIndex(x => x.Status == SceneItemStatus.Generating);
        if (index < 0 || index >= run.Scenes.Count || run.Scenes[index].Status != SceneItemStatus.Generating
            || string.IsNullOrWhiteSpace(run.Scenes[index].TaskPermitId)) return null;
        return new(run.Scenes[index].TaskPermitId!, $"{run.Id}_scene_{index}", AppCallerRegistry.VideoAgent.Script.Chat, index);
    }

    private async Task<GatewayTaskPermitRecord?> ReadPermitAsync(VideoGenRun run, Target target, CancellationToken ct)
    {
        var tenant = configuration["LlmGateway:InternalTenantId"]?.Trim();
        if (string.IsNullOrEmpty(tenant)) tenant = GatewayTenantDefaults.InternalTenantId;
        var f = Builders<GatewayTaskPermitRecord>.Filter;
        return await data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .Find(f.Eq(x => x.Id, target.PermitId) & f.Eq(x => x.ActorUserId, run.OwnerAdminId)
                & f.Eq(x => x.TenantId, tenant) & f.Eq(x => x.SourceDeployment, TaskPermitDeployment.Resolve(configuration))
                & f.Eq(x => x.ExecutionContractVersion, TaskExecutionCoordinator.ContractVersion)
                & f.AnyEq(x => x.AllowedAppCallerCodes, target.Caller) & f.Eq(x => x.RevokedAt, null)
                & new BsonDocument("$expr", new BsonDocument("$gt", new BsonArray { "$ExpiresAt", "$$NOW" })))
            .FirstOrDefaultAsync(ct);
    }

    public async Task<Acquisition?> AcquireAsync(VideoGenRun run, CancellationToken ct, int? sceneIndex = null)
    {
        var target = Describe(run, sceneIndex);
        if (target == null) return null;
        if (await ReadPermitAsync(run, target, ct) == null)
            return new(target, null, "VIDEO_RECOVERY_NOT_ADMITTED");
        try
        {
            var lease = await coordinator.AcquireAsync(target.PermitId, target.ExecutionId, ct);
            // 即使零发送账本可领取，也不把已知作业的普通生成权扩大为核账许可。
            if (run.Mode == VideoGenMode.Direct && !string.IsNullOrWhiteSpace(run.DirectVideoJobId))
            {
                await using (lease) { await lease.TryReleaseForRetryAsync(CancellationToken.None); }
                return new(target, null, "VIDEO_RECOVERY_OUTCOME_UNKNOWN");
            }
            return new(target, lease, null);
        }
        catch (TaskExecutionAdmissionException ex)
        {
            return new(target, null, ex.Code == "TASK_EXECUTION_UNAVAILABLE" ? null
                : ex.Code == "TASK_EXECUTION_OUTCOME_UNKNOWN" ? "VIDEO_RECOVERY_OUTCOME_UNKNOWN"
                : "VIDEO_RECOVERY_NOT_ADMITTED");
        }
    }

    public static FilterDefinition<VideoGenRun> Snapshot(VideoGenRun run, Target target)
    {
        var f = Builders<VideoGenRun>.Filter;
        var filter = f.Eq(x => x.Id, run.Id) & f.Eq(x => x.OwnerAdminId, run.OwnerAdminId)
            & f.Eq(x => x.AppKey, run.AppKey) & f.Eq(x => x.Mode, run.Mode) & f.Eq(x => x.Status, run.Status)
            & f.Eq(x => x.DeploymentSlug, run.DeploymentSlug) & f.Eq(x => x.TaskPermitId, run.TaskPermitId)
            & f.Eq(x => x.CancelRequested, false) & f.Eq(x => x.DeletionRequestedAt, null)
            & f.Eq(x => x.LatestExportTaskId, run.LatestExportTaskId)
            & f.Eq(x => x.Scenes, run.Scenes);
        return target.SceneIndex < 0 ? filter & f.Eq(x => x.DirectVideoJobId, run.DirectVideoJobId)
            : filter & f.Eq($"Scenes.{target.SceneIndex}.Status", SceneItemStatus.Generating)
                & f.Eq($"Scenes.{target.SceneIndex}.TaskPermitId", target.PermitId);
    }

    /// <summary>只由已鉴权本人 GET 调用。响应提示不写入业务终态；迁移只占用并交还原零发送租约。</summary>
    public async Task PrepareOwnedReadAsync(VideoGenRun run, string ownerId, string appKey,
        string? current, string? durable, CancellationToken ct)
    {
        var target = Describe(run);
        if (target == null || run.OwnerAdminId != ownerId || run.AppKey != appKey
            || !VideoGenService.IsExportBranchScope(run.DeploymentSlug, current, durable)) return;
        var permit = await ReadPermitAsync(run, target, ct);
        var entry = permit?.Executions.SingleOrDefault(x => x.RunId == target.ExecutionId);
        var code = permit == null ? "VIDEO_RECOVERY_NOT_ADMITTED"
            : entry?.State is TaskExecutionLeaseStates.OutcomeUnknown or TaskExecutionLeaseStates.Completed
                ? "VIDEO_RECOVERY_OUTCOME_UNKNOWN" : null;
        if (code != null) { ShowBlocked(run, code); return; }
        if (run.DeploymentSlug == current) return;
        // 移动父任务前，不能留下另一个镜头在旧版本继续写。
        if (target.SceneIndex >= 0 && run.Scenes.Where((_, i) => i != target.SceneIndex)
            .Any(x => x.Status is not (SceneItemStatus.Draft or SceneItemStatus.Done or SceneItemStatus.Error))) return;
        var acquired = await AcquireAsync(run, ct);
        if (acquired?.Lease is not { } lease)
        { if (acquired?.ErrorCode != null) ShowBlocked(run, acquired.ErrorCode); return; }
        await using (lease)
        {
            using var context = TaskExecutionContext.Enter(lease.Identity);
            try
            {
                var moved = await db.VideoGenRuns.UpdateOneAsync(Snapshot(run, target),
                    Builders<VideoGenRun>.Update.Set(x => x.DeploymentSlug, current), cancellationToken: CancellationToken.None);
                if (moved.MatchedCount == 1) run.DeploymentSlug = current;
            }
            finally { await lease.TryReleaseForRetryAsync(CancellationToken.None); }
        }
    }

    private static void ShowBlocked(VideoGenRun run, string code)
    {
        run.ErrorCode = code;
        run.ErrorMessage = VideoGenerationUserError.ForPersistence(code, null);
        run.CurrentPhase = "generation-recovery-blocked";
    }
}
