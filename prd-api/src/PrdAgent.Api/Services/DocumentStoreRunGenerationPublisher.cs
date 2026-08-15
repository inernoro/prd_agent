using System.Runtime.ExceptionServices;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 在持有 <see cref="DocumentStoreRunOutputLease"/> 时发布转录任务代次。
/// 首次创建先插入不可领取的 publishing run marker，再推进 entry generation，最后切到 queued；
/// 任一步结果未知时都可由周期 reconciliation 沿同一 runId 幂等续跑。
/// </summary>
internal static class DocumentStoreRunGenerationPublisher
{
    internal static async Task<DocumentEntry?> PublishAsync(
        MongoDbContext db,
        string generationEntryId,
        DocumentStoreAgentRun run,
        DocumentStoreRunOutputLease.LeaseHandle outputLease,
        CancellationToken cancellationToken,
        Func<DocumentStoreAgentRun, CancellationToken, Task>? insertRun = null,
        Func<string, CancellationToken, Task<DocumentStoreAgentRun?>>? readRun = null)
    {
        await outputLease.EnsureHeldAsync(cancellationToken);
        var generationEntry = await db.DocumentEntries
            .Find(entry => entry.Id == generationEntryId)
            .FirstOrDefaultAsync(cancellationToken);
        if (generationEntry == null)
            return null;
        run.GenerationEntryId = generationEntryId;

        // restyle 的首次响应可能在 marker 已落库后丢失。周期 Worker 若已把它收敛为
        // queued/running，HTTP 重试必须复用同一精确请求，不能再推进一代并制造必然
        // superseded 的重复任务。普通完整转录仍保留 Controller 既有的定向去重语义。
        if (!string.IsNullOrWhiteSpace(run.RestyleOfRunId))
        {
            var inFlightRestyles = await db.DocumentStoreAgentRuns
                .Find(Builders<DocumentStoreAgentRun>.Filter.And(
                    RequestGenerationEntryFilter(generationEntryId, run),
                    Builders<DocumentStoreAgentRun>.Filter.Eq(
                        candidate => candidate.Kind,
                        DocumentStoreAgentRunKind.Transcribe),
                    Builders<DocumentStoreAgentRun>.Filter.Eq(candidate => candidate.UserId, run.UserId),
                    Builders<DocumentStoreAgentRun>.Filter.Eq(
                        candidate => candidate.RestyleOfRunId,
                        run.RestyleOfRunId),
                    Builders<DocumentStoreAgentRun>.Filter.In(
                        candidate => candidate.Status,
                        [DocumentStoreRunStatus.Queued, DocumentStoreRunStatus.Running])))
                .ToListAsync(cancellationToken);
            var reusable = inFlightRestyles.FirstOrDefault(candidate =>
                candidate.OutputGeneration == generationEntry.AgentOutputGeneration
                && MatchesSameRequest(candidate, run));
            if (reusable != null)
            {
                run.Id = reusable.Id;
                run.Status = reusable.Status;
                run.OutputGeneration = reusable.OutputGeneration;
                return generationEntry;
            }
        }

        // 先收敛同一条目的遗留 publishing marker，避免上一次响应丢失后再次点击
        // 产生两个持有同一 base generation 的 marker。
        var pendingMarkers = await db.DocumentStoreAgentRuns
            .Find(Builders<DocumentStoreAgentRun>.Filter.And(
                RequestGenerationEntryFilter(generationEntryId, run),
                Builders<DocumentStoreAgentRun>.Filter.Eq(
                    candidate => candidate.Kind,
                    DocumentStoreAgentRunKind.Transcribe),
                Builders<DocumentStoreAgentRun>.Filter.Eq(
                    candidate => candidate.Status,
                    DocumentStoreRunStatus.Publishing)))
            .SortBy(candidate => candidate.CreatedAt)
            .ToListAsync(cancellationToken);
        foreach (var marker in pendingMarkers)
        {
            await ResolveAndBackfillGenerationEntryIdAsync(db, marker, cancellationToken);
            var reconciledEntry = await ReconcilePublishingRunAsync(
                db,
                marker.Id,
                outputLease,
                cancellationToken);
            var reconciledRun = await db.DocumentStoreAgentRuns
                .Find(candidate => candidate.Id == marker.Id)
                .FirstOrDefaultAsync(cancellationToken);
            if (reconciledRun != null
                && reconciledRun.Status is DocumentStoreRunStatus.Queued or DocumentStoreRunStatus.Running
                && reconciledEntry != null
                && reconciledRun.OutputGeneration == reconciledEntry.AgentOutputGeneration
                && MatchesSameRequest(reconciledRun, run))
            {
                run.Id = reconciledRun.Id;
                run.Status = reconciledRun.Status;
                run.OutputGeneration = reconciledRun.OutputGeneration;
                return reconciledEntry;
            }
        }

        generationEntry = await db.DocumentEntries
            .Find(entry => entry.Id == generationEntryId)
            .FirstOrDefaultAsync(cancellationToken);
        if (generationEntry == null)
            return null;

        run.OutputGeneration = generationEntry.AgentOutputGeneration;
        run.Status = DocumentStoreRunStatus.Publishing;
        insertRun ??= (candidate, token) =>
            db.DocumentStoreAgentRuns.InsertOneAsync(candidate, cancellationToken: token);
        readRun ??= async (runId, token) => await db.DocumentStoreAgentRuns
            .Find(candidate => candidate.Id == runId)
            .FirstOrDefaultAsync(token);

        try
        {
            await insertRun(run, cancellationToken);
        }
        catch (Exception insertException)
        {
            try
            {
                var existing = await readRun(run.Id, cancellationToken);
                if (!MatchesPublishingMarker(existing, run))
                {
                    ExceptionDispatchInfo.Capture(insertException).Throw();
                }
            }
            catch (Exception readException) when (readException != insertException)
            {
                // marker 写入结果和回读结果都未知时，entry generation 尚未推进。
                // 若 marker 实际落库，周期 reconciliation 会继续；若未落库则无需回滚。
                throw new InvalidOperationException(
                    $"任务 {run.Id} 的创建 marker 结果未知，正文代次尚未推进。",
                    new AggregateException(insertException, readException));
            }
        }

        var published = await ReconcilePublishingRunAsync(
            db,
            run.Id,
            outputLease,
            cancellationToken);
        var persisted = await db.DocumentStoreAgentRuns
            .Find(candidate => candidate.Id == run.Id)
            .FirstOrDefaultAsync(cancellationToken);
        if (persisted != null)
        {
            run.Status = persisted.Status;
            run.OutputGeneration = persisted.OutputGeneration;
        }
        return published;
    }

    internal static async Task<DocumentEntry?> ReconcilePublishingRunAsync(
        MongoDbContext db,
        string runId,
        DocumentStoreRunOutputLease.LeaseHandle outputLease,
        CancellationToken cancellationToken)
    {
        await outputLease.EnsureHeldAsync(cancellationToken);
        var marker = await db.DocumentStoreAgentRuns
            .Find(run => run.Id == runId)
            .FirstOrDefaultAsync(cancellationToken);
        if (marker == null)
            return null;
        await ResolveAndBackfillGenerationEntryIdAsync(db, marker, cancellationToken);
        if (marker.Status != DocumentStoreRunStatus.Publishing)
        {
            return await db.DocumentEntries
                .Find(entry => entry.Id == ResolveGenerationEntryId(marker))
                .FirstOrDefaultAsync(cancellationToken);
        }

        var generationEntryId = ResolveGenerationEntryId(marker);
        var baseGeneration = marker.OutputGeneration;
        var nextGeneration = checked(baseGeneration + 1);
        var entry = await db.DocumentEntries
            .Find(candidate => candidate.Id == generationEntryId)
            .FirstOrDefaultAsync(cancellationToken);
        if (entry == null)
        {
            await db.DocumentStoreAgentRuns.UpdateOneAsync(
                run => run.Id == marker.Id
                       && run.Status == DocumentStoreRunStatus.Publishing
                       && run.OutputGeneration == baseGeneration,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(run => run.Status, DocumentStoreRunStatus.Failed)
                    .Set(run => run.Phase, "转录输出目标不存在")
                    .Set(run => run.ErrorMessage, "转录输出目标已不存在，任务无法继续。")
                    .Set(run => run.FailureCode, "TRANSCRIPTION_OUTPUT_TARGET_NOT_FOUND")
                    .Set(run => run.EndedAt, DateTime.UtcNow),
                cancellationToken: cancellationToken);
            return null;
        }

        if (entry.AgentOutputGeneration == baseGeneration)
        {
            await outputLease.EnsureHeldAsync(cancellationToken);
            try
            {
                entry = await db.DocumentEntries.FindOneAndUpdateAsync(
                    Builders<DocumentEntry>.Filter.And(
                        Builders<DocumentEntry>.Filter.Eq(
                            candidate => candidate.Id,
                            generationEntryId),
                        Builders<DocumentEntry>.Filter.Eq(
                            candidate => candidate.AgentOutputGeneration,
                            baseGeneration)),
                    Builders<DocumentEntry>.Update.Set(
                        candidate => candidate.AgentOutputGeneration,
                        nextGeneration),
                    new FindOneAndUpdateOptions<DocumentEntry, DocumentEntry>
                    {
                        ReturnDocument = ReturnDocument.After,
                    },
                    cancellationToken);
            }
            catch
            {
                entry = await db.DocumentEntries
                    .Find(candidate => candidate.Id == generationEntryId)
                    .FirstOrDefaultAsync(cancellationToken);
                if (entry?.AgentOutputGeneration != nextGeneration)
                    throw;
            }
        }

        if (entry?.AgentOutputGeneration != nextGeneration)
        {
            await db.DocumentStoreAgentRuns.UpdateOneAsync(
                run => run.Id == marker.Id
                       && run.Status == DocumentStoreRunStatus.Publishing
                       && run.OutputGeneration == baseGeneration,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(run => run.Status, DocumentStoreRunStatus.Failed)
                    .Set(run => run.Phase, "已有更新的录音任务接管")
                    .Set(run => run.ErrorMessage, "创建任务的输出代次已失效，不会覆盖更新结果。")
                    .Set(run => run.FailureCode, "TRANSCRIPTION_RUN_SUPERSEDED")
                    .Set(run => run.EndedAt, DateTime.UtcNow),
                cancellationToken: cancellationToken);
            throw new DocumentStoreRunLeaseLostException(
                $"任务 {marker.Id} 的创建代次 {nextGeneration} 已被更新任务取代。");
        }

        await outputLease.EnsureHeldAsync(cancellationToken);
        var finalized = await db.DocumentStoreAgentRuns.UpdateOneAsync(
            run => run.Id == marker.Id
                   && run.Status == DocumentStoreRunStatus.Publishing
                   && run.OutputGeneration == baseGeneration,
            Builders<DocumentStoreAgentRun>.Update
                .Set(run => run.Status, DocumentStoreRunStatus.Queued)
                .Set(run => run.Phase, "排队中")
                .Set(run => run.OutputGeneration, nextGeneration),
            cancellationToken: cancellationToken);
        if (finalized.ModifiedCount != 1)
        {
            var existing = await db.DocumentStoreAgentRuns
                .Find(run => run.Id == marker.Id)
                .FirstOrDefaultAsync(cancellationToken);
            if (existing?.Status != DocumentStoreRunStatus.Queued
                || existing.OutputGeneration != nextGeneration)
            {
                throw new InvalidOperationException(
                    $"任务 {marker.Id} 的创建 marker 尚未完成，等待下轮协调。");
            }
        }

        return entry;
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

    private static bool MatchesPublishingMarker(
        DocumentStoreAgentRun? existing,
        DocumentStoreAgentRun expected)
        => existing != null
           && existing.Id == expected.Id
           && existing.SourceEntryId == expected.SourceEntryId
           && existing.StoreId == expected.StoreId
           && existing.UserId == expected.UserId
           && existing.Kind == expected.Kind
           && existing.Status == DocumentStoreRunStatus.Publishing
           && ResolveGenerationEntryId(existing) == ResolveGenerationEntryId(expected)
           && existing.OutputGeneration == expected.OutputGeneration;

    private static bool MatchesSameRequest(
        DocumentStoreAgentRun existing,
        DocumentStoreAgentRun requested)
        => existing.SourceEntryId == requested.SourceEntryId
           && existing.StoreId == requested.StoreId
           && existing.UserId == requested.UserId
           && existing.Kind == requested.Kind
           && existing.OwnerInstanceId == requested.OwnerInstanceId
           && ResolveGenerationEntryId(existing) == ResolveGenerationEntryId(requested)
           && existing.RestyleOfRunId == requested.RestyleOfRunId
           && existing.TemplateKey == requested.TemplateKey
           && existing.CustomPrompt == requested.CustomPrompt
           && existing.StyleContext == requested.StyleContext;

    internal static string ResolveGenerationEntryId(DocumentStoreAgentRun run)
        => string.IsNullOrWhiteSpace(run.GenerationEntryId)
            ? run.SourceEntryId
            : run.GenerationEntryId;

    internal static async Task<string> ResolveAndBackfillGenerationEntryIdAsync(
        MongoDbContext db,
        DocumentStoreAgentRun run,
        CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(run.GenerationEntryId))
            return run.GenerationEntryId;
        if (string.IsNullOrWhiteSpace(run.RestyleOfRunId))
            return run.SourceEntryId;

        var prior = await db.DocumentStoreAgentRuns
            .Find(candidate => candidate.Id == run.RestyleOfRunId)
            .FirstOrDefaultAsync(cancellationToken);
        if (prior == null || string.IsNullOrWhiteSpace(prior.OutputEntryId))
        {
            throw new DocumentStoreGenerationTargetUnresolvedException(
                $"整理任务 {run.Id} 无法解析输出代次目标，已停止恢复以保护源录音。");
        }

        var generationEntryId = prior.OutputEntryId;
        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            Builders<DocumentStoreAgentRun>.Filter.And(
                Builders<DocumentStoreAgentRun>.Filter.Eq(candidate => candidate.Id, run.Id),
                MissingGenerationEntryFilter()),
            Builders<DocumentStoreAgentRun>.Update.Set(
                candidate => candidate.GenerationEntryId,
                generationEntryId),
            cancellationToken: cancellationToken);
        run.GenerationEntryId = generationEntryId;
        return generationEntryId;
    }

    private static FilterDefinition<DocumentStoreAgentRun> RequestGenerationEntryFilter(
        string entryId,
        DocumentStoreAgentRun requested)
    {
        var filter = Builders<DocumentStoreAgentRun>.Filter;
        if (string.IsNullOrWhiteSpace(requested.RestyleOfRunId))
            return GenerationEntryFilter(entryId);
        return filter.Or(
            GenerationEntryFilter(entryId),
            filter.And(
                MissingGenerationEntryFilter(),
                filter.Eq(run => run.RestyleOfRunId, requested.RestyleOfRunId)));
    }

    private static FilterDefinition<DocumentStoreAgentRun> GenerationEntryFilter(string entryId)
    {
        var filter = Builders<DocumentStoreAgentRun>.Filter;
        return filter.Or(
            filter.Eq(run => run.GenerationEntryId, entryId),
            filter.And(
                MissingGenerationEntryFilter(),
                filter.Eq(run => run.SourceEntryId, entryId)));
    }

    private static FilterDefinition<DocumentStoreAgentRun> MissingGenerationEntryFilter()
    {
        var filter = Builders<DocumentStoreAgentRun>.Filter;
        return filter.Or(
            filter.Eq(run => run.GenerationEntryId, string.Empty),
            filter.Eq(run => run.GenerationEntryId, null!),
            filter.Exists(run => run.GenerationEntryId, false));
    }

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

internal sealed class DocumentStoreGenerationTargetUnresolvedException(string message)
    : InvalidOperationException(message);
