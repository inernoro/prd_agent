using MongoDB.Driver;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using System.Text.Json;

namespace PrdAgent.Api.Services.DefectAgent;

/// <summary>以 Mongo 文档唯一主键和原子字段更新保证提交重试安全，不依赖进程锁或附加索引。</summary>
internal static class DefectSubmissionPersistence
{
    internal static string? RequestId(string kind, string ownerId, string? clientRequestId)
    {
        var key = McpIdempotency.Normalize(clientRequestId);
        return key == null ? null : McpIdempotency.Fingerprint($"defect-{kind}",
            DeploymentScope.ScopeDurableIdempotencyKey(JsonSerializer.Serialize(new[] { ownerId, key })));
    }

    internal static string PayloadFingerprint<T>(T payload)
        => McpIdempotency.Fingerprint("defect-payload", JsonSerializer.Serialize(payload))!;

    internal static async Task<DefectReport> CreateOrRecoverAsync(
        IMongoCollection<DefectReport> collection, DefectReport draft, CancellationToken ct)
    {
        try
        {
            await collection.InsertOneAsync(draft, cancellationToken: ct);
            return draft;
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            var recovered = await collection.Find(x => x.Id == draft.Id).FirstOrDefaultAsync(ct);
            if (recovered == null) throw;
            return recovered;
        }
    }

    internal static FilterDefinition<DefectReport> StateSnapshot(DefectReport draft)
        => Builders<DefectReport>.Filter.And(
            Builders<DefectReport>.Filter.Eq(x => x.Id, draft.Id),
            Builders<DefectReport>.Filter.Eq(x => x.Status, draft.Status),
            // 历史文档未写版本字段时等价于版本零。
            draft.EditRevision == 0
                ? Builders<DefectReport>.Filter.Or(Builders<DefectReport>.Filter.Eq(x => x.EditRevision, 0),
                    Builders<DefectReport>.Filter.Exists(x => x.EditRevision, false))
                : Builders<DefectReport>.Filter.Eq(x => x.EditRevision, draft.EditRevision));

    private static FilterDefinition<DefectReport> EditableSnapshot(DefectReport draft)
        => StateSnapshot(draft) & Builders<DefectReport>.Filter.Eq(x => x.ReporterId, draft.ReporterId)
            & Builders<DefectReport>.Filter.In(x => x.Status,
            new[] { DefectStatus.Draft, DefectStatus.Awaiting });

    /// <summary>只更新调用方拥有的字段；不把旧快照中的附件、内容或版本整文档写回。</summary>
    internal static Task<DefectReport> UpdateFieldsAsync(IMongoCollection<DefectReport> collection,
        string id, UpdateDefinition<DefectReport> update, CancellationToken ct)
        => collection.FindOneAndUpdateAsync(Builders<DefectReport>.Filter.Eq(x => x.Id, id), update,
            new FindOneAndUpdateOptions<DefectReport> { ReturnDocument = ReturnDocument.After }, ct);

    internal static Task<DefectReport> UpdateStateAsync(IMongoCollection<DefectReport> collection,
        FilterDefinition<DefectReport> snapshot, UpdateDefinition<DefectReport> update, CancellationToken ct)
        => collection.FindOneAndUpdateAsync(snapshot, update.Inc(x => x.EditRevision, 1),
            new FindOneAndUpdateOptions<DefectReport> { ReturnDocument = ReturnDocument.After }, ct);

    internal static Task<DefectReport> UpdateDraftAsync(IMongoCollection<DefectReport> collection,
        DefectReport draft, UpdateDefinition<DefectReport> update, CancellationToken ct)
        => collection.FindOneAndUpdateAsync(EditableSnapshot(draft), update,
            new FindOneAndUpdateOptions<DefectReport> { ReturnDocument = ReturnDocument.After }, ct);

    internal static Task<DefectReport> TrySubmitAsync(IMongoCollection<DefectReport> collection,
        DefectReport draft, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var update = Builders<DefectReport>.Update.Inc(x => x.EditRevision, 1).Set(x => x.Status, DefectStatus.Submitted)
            .Set(x => x.SubmittedAt, now).Set(x => x.UpdatedAt, now)
            .Set(x => x.ReporterUnread, false).Set(x => x.AssigneeUnread, !string.IsNullOrEmpty(draft.AssigneeId));
        return collection.FindOneAndUpdateAsync(EditableSnapshot(draft), update,
            new FindOneAndUpdateOptions<DefectReport> { ReturnDocument = ReturnDocument.After }, ct);
    }

    internal static async Task<DefectReport?> AppendAttachmentAsync(IMongoCollection<DefectReport> collection,
        string defectId, DefectAttachment attachment, CancellationToken ct)
    {
        var filter = Builders<DefectReport>.Filter.Eq(x => x.Id, defectId)
            & !Builders<DefectReport>.Filter.ElemMatch(x => x.Attachments, x => x.Id == attachment.Id);
        await collection.UpdateOneAsync(filter,
            Builders<DefectReport>.Update.Push(x => x.Attachments, attachment).Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        return await collection.Find(x => x.Id == defectId).FirstOrDefaultAsync(ct);
    }
}
