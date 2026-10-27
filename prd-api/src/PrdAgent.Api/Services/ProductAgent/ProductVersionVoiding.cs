using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>作废只标记业务记录并保留编号；与物理删除及来源释放完全分开。</summary>
public static class ProductVersionVoiding
{
    public static async Task<bool> ApplyAsync(MongoDbContext db, string collectionName, string id,
        string applicationId, string expectedOwner, string actor, string reason)
    {
        if (collectionName is not ("product_initiations" or "product_releases" or "version_registrations"))
            throw new ArgumentException("不支持的版本记录", nameof(collectionName));
        if (ProductVersionClaimGuard.NormalizeRemovalReason(reason) == null)
            throw new ArgumentException("作废理由至少填写6个字符", nameof(reason));
        await using var lease = await ProductVersionApplicationLease.AcquireAsync(db, new[] { applicationId });
        var collection = db.Database.GetCollection<BsonDocument>(collectionName);
        var f = Builders<BsonDocument>.Filter;
        var current = await collection.Find(f.Eq("_id", id) & f.Ne("IsDeleted", true)).FirstOrDefaultAsync();
        if (current == null || current.GetValue("Status", "").AsString == "voided"
            || current.GetValue("CreatedBy", "").AsString != expectedOwner) return false;
        var notification = current.GetValue("ClaimNotification", BsonNull.Value);
        var noticeStatus = notification.IsBsonDocument ? notification.AsBsonDocument.GetValue("Status", "").AsString : null;
        if (noticeStatus == "sending") return false;
        var now = DateTime.UtcNow;
        var update = Builders<BsonDocument>.Update.Set("Status", "voided")
            .Set("StatusBeforeVoid", current.GetValue("Status", ""))
            .Set("VoidReason", reason.Trim()).Set("VoidedBy", actor).Set("VoidedAt", now).Set("UpdatedAt", now);
        var unchanged = f.Eq("_id", id) & f.Ne("IsDeleted", true) & f.Eq("CreatedBy", current.GetValue("CreatedBy", BsonNull.Value))
            & f.Eq("Status", current.GetValue("Status", BsonNull.Value))
            & f.Eq("UpdatedAt", current.GetValue("UpdatedAt", BsonNull.Value));
        if (notification.IsBsonDocument)
        {
            unchanged &= f.Eq("ClaimNotification.Status", noticeStatus);
            if (noticeStatus is "pending" or "waiting_identity" or "debug_pending")
                update = update.Set("ClaimNotification.Status", "cancelled");
        }
        else unchanged &= f.Eq("ClaimNotification", BsonNull.Value);
        await lease.EnsureHeldAsync();
        return (await collection.UpdateOneAsync(unchanged, update, cancellationToken: CancellationToken.None)).ModifiedCount == 1;
    }
}
