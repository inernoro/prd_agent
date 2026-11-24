using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

internal readonly record struct ImageGenRunCancellationResult(bool Found, bool BecameTerminal);

/// <summary>
/// 可信取消入口原子保存终态并发出结束事件；撤权后的旧 Worker 只负责停止上游，不能再写回。
/// </summary>
internal static class ImageGenRunCancellation
{
    internal static async Task<ImageGenRunCancellationResult> RequestAsync(
        MongoDbContext db,
        IRunEventStore runStore,
        string runId,
        string ownerAdminId,
        string? appKey,
        CancellationToken ct)
    {
        var owned = Builders<ImageGenRun>.Filter.Eq(x => x.Id, runId)
                    & Builders<ImageGenRun>.Filter.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (!string.IsNullOrWhiteSpace(appKey))
        {
            owned &= Builders<ImageGenRun>.Filter.Eq(x => x.AppKey, appKey);
        }

        var current = await db.ImageGenRuns.Find(owned).FirstOrDefaultAsync(ct);
        if (current == null) return new ImageGenRunCancellationResult(false, false);
        if (current.Status is ImageGenRunStatus.Completed or ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled)
            return new ImageGenRunCancellationResult(true, false);

        var active = owned
            & Builders<ImageGenRun>.Filter.Eq(x => x.AppKey, current.AppKey)
            & Builders<ImageGenRun>.Filter.Eq(x => x.WorkspaceId, current.WorkspaceId)
            & Builders<ImageGenRun>.Filter.Eq(x => x.TaskPermitId, current.TaskPermitId)
            & Builders<ImageGenRun>.Filter.In(
            x => x.Status,
            [ImageGenRunStatus.Queued, ImageGenRunStatus.ScopedQueued, ImageGenRunStatus.Running]);
        var endedAt = DateTime.UtcNow;
        var cancelled = await db.ImageGenRuns.FindOneAndUpdateAsync(
            active,
            Builders<ImageGenRun>.Update
                .Set(x => x.CancelRequested, true)
                .Set(x => x.Status, ImageGenRunStatus.Cancelled)
                .Set(x => x.EndedAt, endedAt)
                .Unset(x => x.ErrorCode)
                .Unset(x => x.ErrorMessage),
            new FindOneAndUpdateOptions<ImageGenRun, ImageGenRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            ct);

        if (cancelled != null)
        {
            await runStore.AppendEventAsync(
                RunKinds.ImageGen,
                cancelled.Id,
                "run",
                new
                {
                    type = "runDone",
                    runId = cancelled.Id,
                    total = cancelled.Total,
                    done = cancelled.Done,
                    failed = cancelled.Failed,
                    status = ImageGenRunStatus.Cancelled.ToString(),
                    errorCode = (string?)null,
                    errorMessage = (string?)null,
                    endedAt,
                },
                ttl: TimeSpan.FromHours(24),
                ct: CancellationToken.None);
            return new ImageGenRunCancellationResult(true, true);
        }

        // 已经处于终态或重复取消时保持幂等成功；只有真实不存在或越权才返回未找到。
        var exists = await db.ImageGenRuns.Find(owned).AnyAsync(ct);
        return new ImageGenRunCancellationResult(exists, false);
    }
}
