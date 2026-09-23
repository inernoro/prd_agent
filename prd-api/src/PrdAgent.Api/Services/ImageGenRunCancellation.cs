using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

internal readonly record struct ImageGenRunCancellationResult(bool Found, bool BecameTerminal);

/// <summary>
/// 生图取消的原子状态机。排队态直接进入终态；运行态只写取消位，由 Worker 中断上游请求并收尾。
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

        var pending = owned & Builders<ImageGenRun>.Filter.In(
            x => x.Status,
            [ImageGenRunStatus.Queued, ImageGenRunStatus.ScopedQueued]);
        var endedAt = DateTime.UtcNow;
        var cancelled = await db.ImageGenRuns.FindOneAndUpdateAsync(
            pending,
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

        // 与 Worker 的原子 claim 形成完整竞态闭环：若 claim 先把排队态改成 Running，
        // 这里立即写 CancelRequested，Worker 的 watcher 会取消正在等待的上游 HTTP。
        var running = await db.ImageGenRuns.UpdateOneAsync(
            owned & Builders<ImageGenRun>.Filter.Eq(x => x.Status, ImageGenRunStatus.Running),
            Builders<ImageGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);
        if (running.MatchedCount > 0)
        {
            return new ImageGenRunCancellationResult(true, false);
        }

        // 已经处于终态或重复取消时保持幂等成功；只有真实不存在或越权才返回未找到。
        var exists = await db.ImageGenRuns.Find(owned).AnyAsync(ct);
        return new ImageGenRunCancellationResult(exists, false);
    }
}
