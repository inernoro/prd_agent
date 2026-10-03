using System.Security.Cryptography;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 录音分片的对象存储意图、校验、读取和回收。Mongo 只保存新分片的清单；
/// 历史 Data 字段只读，迁移时先写对象再原子移除内联字节。
/// </summary>
public static class DocumentRecordingChunkStore
{
    public static string Sha256(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    public static bool PayloadMatches(DocumentRecordingUploadChunk chunk, byte[] bytes)
        => chunk.SizeBytes == bytes.LongLength
           && (chunk.Data is { Length: > 0 }
               ? chunk.Data.AsSpan().SequenceEqual(bytes)
               : string.Equals(chunk.Sha256, Sha256(bytes), StringComparison.OrdinalIgnoreCase));

    public static bool RetryMatches(IReadOnlyList<DocumentRecordingUploadChunk> chunks, byte[] bytes)
        => chunks.Count > 0 && chunks.All(chunk => PayloadMatches(chunk, bytes) && IsReadable(chunk));

    public static async Task<bool> ConfirmedRetryMatchesAsync(
        IReadOnlyList<DocumentRecordingUploadChunk> chunks,
        byte[] bytes,
        IAssetStorage storage,
        IMongoCollection<DocumentRecordingUploadChunk> collection,
        CancellationToken cancellationToken)
    {
        if (!RetryMatches(chunks, bytes)) return false;
        foreach (var chunk in chunks.Where(c => !string.IsNullOrWhiteSpace(c.StorageKey)))
        {
            var key = chunk.StorageKey!;
            var remote = await storage.TryDownloadBytesAsync(key, cancellationToken);
            if (remote == null || !remote.AsSpan().SequenceEqual(bytes))
            {
                await storage.UploadToKeyAsync(key, bytes, "application/octet-stream", cancellationToken);
                var current = await collection.Find(c => c.Id == chunk.Id)
                    .FirstOrDefaultAsync(cancellationToken);
                if (current == null || current.Deleting || current.StorageKey != key)
                {
                    await storage.DeleteByKeyAsync(key, cancellationToken);
                    return false;
                }
            }
        }
        return true;
    }

    private static bool IsReadable(DocumentRecordingUploadChunk chunk)
        => !chunk.Deleting && (chunk.Data is { Length: > 0 }
           || (chunk.ObjectStored && !string.IsNullOrWhiteSpace(chunk.StorageKey)));

    public static async Task<(DocumentRecordingUploadChunk Chunk, bool Inserted, bool PayloadMatches)>
        EnsureObjectChunkAsync(
            IMongoCollection<DocumentRecordingUploadChunk> chunks,
            IAssetStorage storage,
            string ownerInstanceId,
            string sessionId,
            int index,
            byte[] bytes,
            CancellationToken cancellationToken)
    {
        var digest = Sha256(bytes);
        var key = storage.BuildRecordingChunkKey(sessionId, index, digest);
        var candidate = new DocumentRecordingUploadChunk
        {
            Id = $"recording-chunk-{sessionId}-{index}",
            SessionId = sessionId,
            OwnerInstanceId = ownerInstanceId,
            Index = index,
            SizeBytes = bytes.LongLength,
            Sha256 = digest,
            StorageKey = key,
            ObjectStored = false,
        };

        DocumentRecordingUploadChunk? existing = null;
        var inserted = false;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            existing = await chunks.Find(c => c.SessionId == sessionId && c.Index == index)
                .FirstOrDefaultAsync(cancellationToken);
            if (existing != null) break;
            try
            {
                await chunks.InsertOneAsync(candidate, cancellationToken: cancellationToken);
                existing = candidate;
                inserted = true;
                break;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 同编号并发请求争用确定性 _id；回读胜出者再验证摘要。
            }
        }
        if (existing == null)
            throw new InvalidOperationException("录音分片并发状态无法收敛，请查询偏移后重试");
        if (!PayloadMatches(existing, bytes))
            return (existing, inserted, false);
        if (existing.Deleting)
            throw new InvalidOperationException("录音分片正在清理，请查询上传状态后重试");
        if (existing.Data is { Length: > 0 })
            return (existing, inserted, true); // 兼容未迁移的旧会话
        if (string.IsNullOrWhiteSpace(existing.StorageKey))
            throw new InvalidOperationException("录音分片缺少对象位置，请查询偏移后重试");

        // 意图先入库，但只有对象写入成功并确认标记后才能推进会话偏移。
        // 同摘要并发写同一 key 是幂等的；失败留下可恢复意图，不返回已保护。
        var confirmedBytes = existing.ObjectStored
            ? await storage.TryDownloadBytesAsync(existing.StorageKey, cancellationToken)
            : null;
        if (confirmedBytes == null || !confirmedBytes.AsSpan().SequenceEqual(bytes))
        {
            await storage.UploadToKeyAsync(existing.StorageKey, bytes, "application/octet-stream", cancellationToken);
            var updated = await chunks.UpdateOneAsync(
                c => c.Id == existing.Id && c.Sha256 == digest
                     && c.StorageKey == existing.StorageKey && !c.Deleting,
                Builders<DocumentRecordingUploadChunk>.Update.Set(c => c.ObjectStored, true),
                cancellationToken: cancellationToken);
            if (updated.MatchedCount != 1)
            {
                var current = await chunks.Find(c => c.Id == existing.Id)
                    .FirstOrDefaultAsync(cancellationToken);
                if (current == null || current.Deleting || current.StorageKey != existing.StorageKey)
                    await storage.DeleteByKeyAsync(existing.StorageKey, cancellationToken);
                throw new InvalidOperationException("录音分片状态已变化，请查询偏移后重试");
            }
            existing.ObjectStored = true;
        }
        return (existing, inserted, true);
    }

    public static async Task<byte[]> AssembleAsync(
        IReadOnlyList<DocumentRecordingUploadChunk> chunks,
        int expectedCount,
        long expectedBytes,
        IAssetStorage storage,
        CancellationToken cancellationToken)
    {
        if (chunks.Count == 0 || expectedCount <= 0 || expectedBytes <= 0 || expectedBytes > int.MaxValue)
            throw new InvalidOperationException("录音归档分片数量或大小无效");
        var groups = chunks.GroupBy(chunk => chunk.Index).OrderBy(group => group.Key).ToArray();
        if (groups.Length != expectedCount)
            throw new InvalidOperationException("录音归档分片数量不完整");

        using var joined = new MemoryStream((int)expectedBytes);
        for (var index = 0; index < groups.Length; index++)
        {
            if (groups[index].Key != index)
                throw new InvalidOperationException($"录音归档缺少第 {index} 个分片");
            byte[]? first = null;
            foreach (var chunk in groups[index])
            {
                var data = await ReadVerifiedAsync(chunk, storage, cancellationToken);
                if (first != null && !first.AsSpan().SequenceEqual(data))
                    throw new InvalidOperationException($"录音归档第 {index} 个分片存在内容冲突");
                first ??= data;
            }
            joined.Write(first!);
        }
        if (joined.Length != expectedBytes)
            throw new InvalidOperationException("录音归档分片大小校验失败");
        return joined.ToArray();
    }

    private static async Task<byte[]> ReadVerifiedAsync(
        DocumentRecordingUploadChunk chunk,
        IAssetStorage storage,
        CancellationToken cancellationToken)
    {
        byte[]? data = chunk.Data is { Length: > 0 }
            ? chunk.Data
            : chunk.ObjectStored && !string.IsNullOrWhiteSpace(chunk.StorageKey)
                ? await storage.TryDownloadBytesAsync(chunk.StorageKey, cancellationToken)
                : null;
        if (data == null || data.LongLength != chunk.SizeBytes
            || (!string.IsNullOrWhiteSpace(chunk.Sha256)
                && !string.Equals(Sha256(data), chunk.Sha256, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException($"录音归档第 {chunk.Index} 个分片缺失或校验失败");
        return data;
    }

    public static async Task DeleteChunksAsync(
        IMongoCollection<DocumentRecordingUploadChunk> chunks,
        IAssetStorage storage,
        IReadOnlyCollection<string> sessionIds,
        CancellationToken cancellationToken)
    {
        if (sessionIds.Count == 0) return;
        var records = await chunks.Find(c => sessionIds.Contains(c.SessionId))
            .ToListAsync(cancellationToken);
        foreach (var chunk in records)
            await DeleteChunkAsync(chunks, storage, chunk, cancellationToken);
    }

    public static async Task DeleteChunkAsync(
        IMongoCollection<DocumentRecordingUploadChunk> chunks,
        IAssetStorage storage,
        DocumentRecordingUploadChunk chunk,
        CancellationToken cancellationToken)
    {
        // 先标记回收意图，阻止并发上传或迁移重新写入；对象先删、清单后删。
        // 进程中断后尚存的清单就是补偿意图，下轮可再次删除同一 key。
        // 迁移可能在读取清单之后补写 StorageKey；条件不符必须重读。
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var marked = await chunks.UpdateOneAsync(
                c => c.Id == chunk.Id && c.StorageKey == chunk.StorageKey,
                Builders<DocumentRecordingUploadChunk>.Update.Set(c => c.Deleting, true),
                cancellationToken: cancellationToken);
            if (marked.MatchedCount != 1)
            {
                var changed = await chunks.Find(c => c.Id == chunk.Id)
                    .FirstOrDefaultAsync(cancellationToken);
                if (changed == null) return;
                chunk = changed;
                continue;
            }
            if (!string.IsNullOrWhiteSpace(chunk.StorageKey))
                await storage.DeleteByKeyAsync(chunk.StorageKey, cancellationToken);
            var deleted = await chunks.DeleteOneAsync(
                c => c.Id == chunk.Id && c.StorageKey == chunk.StorageKey && c.Deleting,
                cancellationToken);
            if (deleted.DeletedCount == 1) return;
            var latest = await chunks.Find(c => c.Id == chunk.Id)
                .FirstOrDefaultAsync(cancellationToken);
            if (latest == null) return;
            chunk = latest;
        }
        throw new InvalidOperationException("录音分片清理状态持续变化，等待下一轮重试");
    }

    public static async Task<int> DeleteOwnedOrphansAsync(
        IMongoCollection<DocumentRecordingUploadChunk> chunks,
        IAssetStorage storage,
        IReadOnlyCollection<string> orphanSessionIds,
        string ownerInstanceId,
        CancellationToken cancellationToken)
    {
        var deletedSessions = 0;
        foreach (var sessionId in orphanSessionIds)
        {
            var records = await chunks.Find(c => c.SessionId == sessionId)
                .ToListAsync(cancellationToken);
            // 没有父会话时无法再查 owner；只清理本部署对象或纯 Mongo 旧分片。
            if (records.Any(c => !string.IsNullOrWhiteSpace(c.StorageKey)
                                 && c.OwnerInstanceId != ownerInstanceId))
                continue;
            foreach (var chunk in records)
                await DeleteChunkAsync(chunks, storage, chunk, cancellationToken);
            deletedSessions++;
        }
        return deletedSessions;
    }

    public static async Task<bool> MigrateLegacyChunkAsync(
        IMongoCollection<DocumentRecordingUploadChunk> chunks,
        IAssetStorage storage,
        DocumentRecordingUploadChunk chunk,
        string ownerInstanceId,
        CancellationToken cancellationToken)
    {
        if (chunk.Data is not { Length: > 0 }) return false;
        var digest = Sha256(chunk.Data);
        var key = storage.BuildRecordingChunkKey(chunk.SessionId, chunk.Index, digest);
        await storage.UploadToKeyAsync(key, chunk.Data, "application/octet-stream", cancellationToken);
        var stored = await storage.TryDownloadBytesAsync(key, cancellationToken);
        if (stored == null || !stored.AsSpan().SequenceEqual(chunk.Data))
            throw new InvalidOperationException("录音分片对象回读校验失败，Mongo 原始字节已保留");
        var updated = await chunks.UpdateOneAsync(
            c => c.Id == chunk.Id && c.StorageKey == null && !c.Deleting
                 && c.SizeBytes == chunk.Data.LongLength,
            Builders<DocumentRecordingUploadChunk>.Update
                .Set(c => c.StorageKey, key)
                .Set(c => c.OwnerInstanceId, ownerInstanceId)
                .Set(c => c.Sha256, digest)
                .Set(c => c.ObjectStored, true)
                .Unset(c => c.Data),
            cancellationToken: cancellationToken);
        if (updated.ModifiedCount == 0)
        {
            var current = await chunks.Find(c => c.Id == chunk.Id)
                .FirstOrDefaultAsync(cancellationToken);
            if (current == null || current.Deleting || current.StorageKey != key)
                await storage.DeleteByKeyAsync(key, cancellationToken);
        }
        return updated.ModifiedCount == 1;
    }
}
