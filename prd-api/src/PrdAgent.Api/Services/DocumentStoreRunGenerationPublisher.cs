using System.Runtime.ExceptionServices;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 在持有 <see cref="DocumentStoreRunOutputLease"/> 时发布转录任务代次。
/// 若 run 插入明确失败，则条件回滚代次；若驱动报告未知结果但 run 已落库，则按 runId 幂等确认。
/// </summary>
internal static class DocumentStoreRunGenerationPublisher
{
    internal static async Task<DocumentEntry?> PublishAsync(
        MongoDbContext db,
        string generationEntryId,
        DocumentStoreAgentRun run,
        CancellationToken cancellationToken,
        Func<DocumentStoreAgentRun, CancellationToken, Task>? insertRun = null)
    {
        var generationEntry = await db.DocumentEntries.FindOneAndUpdateAsync(
            Builders<DocumentEntry>.Filter.Eq(entry => entry.Id, generationEntryId),
            Builders<DocumentEntry>.Update.Inc(entry => entry.AgentOutputGeneration, 1),
            new FindOneAndUpdateOptions<DocumentEntry, DocumentEntry>
            {
                ReturnDocument = ReturnDocument.After,
            },
            cancellationToken);
        if (generationEntry == null)
            return null;

        run.OutputGeneration = generationEntry.AgentOutputGeneration;
        insertRun ??= (candidate, token) =>
            db.DocumentStoreAgentRuns.InsertOneAsync(candidate, cancellationToken: token);

        try
        {
            await insertRun(run, cancellationToken);
            return generationEntry;
        }
        catch (Exception insertException)
        {
            // Mongo 写入可能在服务端成功、客户端却因断线收到异常。先按确定 runId 回读，
            // 匹配即视为幂等成功，不能回滚一个已经有对应任务的代次。
            var existing = await db.DocumentStoreAgentRuns
                .Find(candidate => candidate.Id == run.Id)
                .FirstOrDefaultAsync(cancellationToken);
            if (MatchesPublishedRun(existing, run))
                return generationEntry;

            var previousGeneration = generationEntry.AgentOutputGeneration - 1;
            var rollback = await db.DocumentEntries.UpdateOneAsync(
                entry => entry.Id == generationEntryId
                         && entry.AgentOutputGeneration == generationEntry.AgentOutputGeneration,
                Builders<DocumentEntry>.Update.Set(
                    entry => entry.AgentOutputGeneration,
                    previousGeneration),
                cancellationToken: cancellationToken);
            if (rollback.ModifiedCount != 1)
            {
                throw new InvalidOperationException(
                    $"任务 {run.Id} 插入失败，且代次 {generationEntry.AgentOutputGeneration} 回滚失败。",
                    insertException);
            }

            ExceptionDispatchInfo.Capture(insertException).Throw();
            throw;
        }
    }

    /// <summary>
    /// 在同一输出租约内为既有 run 推进代次并原地重排。run 更新发生异常时，先用固定
    /// recoveryAttemptId 回读确认服务端是否已提交；明确未提交才按新代次 CAS 回滚 entry。
    /// </summary>
    internal static async Task<DocumentEntry?> RequeueExistingAsync(
        MongoDbContext db,
        string generationEntryId,
        DocumentStoreAgentRun current,
        DocumentStoreRunOutputLease.LeaseHandle outputLease,
        string recoveryAttemptId,
        FilterDefinition<DocumentStoreAgentRun> runFilter,
        Func<long, UpdateDefinition<DocumentStoreAgentRun>> buildRunUpdate,
        CancellationToken cancellationToken,
        Func<
            FilterDefinition<DocumentStoreAgentRun>,
            UpdateDefinition<DocumentStoreAgentRun>,
            CancellationToken,
            Task<bool>>? updateRun = null)
    {
        if (string.IsNullOrWhiteSpace(recoveryAttemptId))
            throw new ArgumentException("恢复操作身份不能为空。", nameof(recoveryAttemptId));

        await outputLease.EnsureHeldAsync(cancellationToken);
        var nextGeneration = current.PendingRecoveryOutputGeneration
                             ?? checked(current.OutputGeneration + 1);
        if (!current.PendingRecoveryOutputGeneration.HasValue)
        {
            try
            {
                var marker = await db.DocumentStoreAgentRuns.UpdateOneAsync(
                    runFilter,
                    Builders<DocumentStoreAgentRun>.Update
                        .Set(run => run.RecoveryAttemptId, recoveryAttemptId)
                        .Set(run => run.PendingRecoveryOutputGeneration, nextGeneration),
                    cancellationToken: cancellationToken);
                if (marker.ModifiedCount != 1)
                    return null;
            }
            catch
            {
                var marked = await db.DocumentStoreAgentRuns
                    .Find(run => run.Id == current.Id)
                    .FirstOrDefaultAsync(cancellationToken);
                if (!MatchesPendingRecovery(marked, current, recoveryAttemptId, nextGeneration))
                    throw;
            }
        }

        await outputLease.EnsureHeldAsync(cancellationToken);
        DocumentEntry? generationEntry;
        try
        {
            generationEntry = await db.DocumentEntries.FindOneAndUpdateAsync(
                Builders<DocumentEntry>.Filter.And(
                    Builders<DocumentEntry>.Filter.Eq(entry => entry.Id, generationEntryId),
                    Builders<DocumentEntry>.Filter.Eq(
                        entry => entry.AgentOutputGeneration,
                        current.OutputGeneration)),
                Builders<DocumentEntry>.Update.Set(
                    entry => entry.AgentOutputGeneration,
                    nextGeneration),
                new FindOneAndUpdateOptions<DocumentEntry, DocumentEntry>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                cancellationToken);
        }
        catch
        {
            generationEntry = await db.DocumentEntries
                .Find(entry => entry.Id == generationEntryId)
                .FirstOrDefaultAsync(cancellationToken);
            if (generationEntry?.AgentOutputGeneration != nextGeneration)
                throw;
        }
        if (generationEntry == null)
        {
            generationEntry = await db.DocumentEntries
                .Find(entry => entry.Id == generationEntryId)
                .FirstOrDefaultAsync(cancellationToken);
        }
        if (generationEntry == null)
            return null;
        if (generationEntry.AgentOutputGeneration != nextGeneration)
            return null;

        var update = buildRunUpdate(nextGeneration)
            .Set(run => run.RecoveryAttemptId, recoveryAttemptId)
            .Set(run => run.PendingRecoveryOutputGeneration, null);
        var finalizeFilter = Builders<DocumentStoreAgentRun>.Filter.And(
            runFilter,
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                run => run.RecoveryAttemptId,
                recoveryAttemptId),
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                run => run.PendingRecoveryOutputGeneration,
                nextGeneration));
        updateRun ??= async (filter, definition, token) =>
        {
            var result = await db.DocumentStoreAgentRuns.UpdateOneAsync(
                filter,
                definition,
                cancellationToken: token);
            return result.ModifiedCount == 1;
        };

        Exception? updateException = null;
        var updated = false;
        try
        {
            await outputLease.EnsureHeldAsync(cancellationToken);
            updated = await updateRun(finalizeFilter, update, cancellationToken);
        }
        catch (Exception ex)
        {
            updateException = ex;
        }

        if (updated)
            return generationEntry;

        // Mongo 写入可能在服务端成功、客户端却因断线收到异常。固定恢复身份与新代次
        // 同时匹配，说明本次重排已经落库；即使它随后已被新 execution 认领也不能回滚。
        var existing = await db.DocumentStoreAgentRuns
            .Find(run => run.Id == current.Id)
            .FirstOrDefaultAsync(cancellationToken);
        if (MatchesRecoveredRun(existing, current, recoveryAttemptId, nextGeneration))
            return generationEntry;

        if (!MatchesPendingRecovery(existing, current, recoveryAttemptId, nextGeneration))
        {
            throw new InvalidOperationException(
                $"任务 {current.Id} 恢复重排结果未知，保留输出代次 {nextGeneration} 等待下轮收敛。",
                updateException);
        }

        // 只有当前输出租约持有者才能做逆向代次写入。若 finalize 期间租约已过期
        // 并被接管，旧恢复者必须 fail-closed，由新持有者沿用 marker 收敛。
        await outputLease.EnsureHeldAsync(cancellationToken);
        var rollback = await db.DocumentEntries.UpdateOneAsync(
            entry => entry.Id == generationEntryId
                     && entry.AgentOutputGeneration == nextGeneration,
            Builders<DocumentEntry>.Update.Set(
                entry => entry.AgentOutputGeneration,
                current.OutputGeneration),
            cancellationToken: cancellationToken);
        if (rollback.ModifiedCount != 1)
        {
            throw new InvalidOperationException(
                $"任务 {current.Id} 恢复重排失败，且输出代次 {nextGeneration} 条件回滚失败。",
                updateException);
        }

        // 代次已明确回滚，清理本次 marker；若该写结果未知，marker 留存也安全，
        // 下轮 reconciliation 会继续同一 attempt 并重新推进同一代次。
        try
        {
            await db.DocumentStoreAgentRuns.UpdateOneAsync(
                Builders<DocumentStoreAgentRun>.Filter.And(
                    Builders<DocumentStoreAgentRun>.Filter.Eq(run => run.Id, current.Id),
                    Builders<DocumentStoreAgentRun>.Filter.Eq(
                        run => run.RecoveryAttemptId,
                        recoveryAttemptId),
                    Builders<DocumentStoreAgentRun>.Filter.Eq(
                        run => run.PendingRecoveryOutputGeneration,
                        nextGeneration),
                    Builders<DocumentStoreAgentRun>.Filter.Eq(
                        run => run.OutputGeneration,
                        current.OutputGeneration)),
                Builders<DocumentStoreAgentRun>.Update
                    .Set(run => run.RecoveryAttemptId, string.Empty)
                    .Set(run => run.PendingRecoveryOutputGeneration, null),
                cancellationToken: cancellationToken);
        }
        catch
        {
            // marker 的存在是 fail-closed 状态；不得覆盖原始重排异常。
        }

        if (updateException != null)
        {
            ExceptionDispatchInfo.Capture(updateException).Throw();
        }

        throw new InvalidOperationException($"任务 {current.Id} 恢复重排未提交，输出代次已安全回滚。");
    }

    private static bool MatchesPublishedRun(
        DocumentStoreAgentRun? existing,
        DocumentStoreAgentRun expected)
        => existing != null
           && existing.SourceEntryId == expected.SourceEntryId
           && existing.StoreId == expected.StoreId
           && existing.UserId == expected.UserId
           && existing.Kind == expected.Kind
           && existing.OutputGeneration == expected.OutputGeneration;

    private static bool MatchesRecoveredRun(
        DocumentStoreAgentRun? existing,
        DocumentStoreAgentRun expected,
        string recoveryAttemptId,
        long outputGeneration)
        => existing != null
           && existing.Id == expected.Id
           && existing.SourceEntryId == expected.SourceEntryId
           && existing.StoreId == expected.StoreId
           && existing.UserId == expected.UserId
           && existing.Kind == expected.Kind
           && existing.RecoveryAttemptId == recoveryAttemptId
           && existing.OutputGeneration == outputGeneration
           && existing.PendingRecoveryOutputGeneration == null;

    private static bool MatchesPendingRecovery(
        DocumentStoreAgentRun? existing,
        DocumentStoreAgentRun expected,
        string recoveryAttemptId,
        long outputGeneration)
        => existing != null
           && existing.Id == expected.Id
           && existing.SourceEntryId == expected.SourceEntryId
           && existing.StoreId == expected.StoreId
           && existing.UserId == expected.UserId
           && existing.Kind == expected.Kind
           && existing.OutputGeneration == expected.OutputGeneration
           && existing.RecoveryAttemptId == recoveryAttemptId
           && existing.PendingRecoveryOutputGeneration == outputGeneration;
}
