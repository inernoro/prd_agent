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

    private static bool MatchesPublishedRun(
        DocumentStoreAgentRun? existing,
        DocumentStoreAgentRun expected)
        => existing != null
           && existing.SourceEntryId == expected.SourceEntryId
           && existing.StoreId == expected.StoreId
           && existing.UserId == expected.UserId
           && existing.Kind == expected.Kind
           && existing.OutputGeneration == expected.OutputGeneration;
}
