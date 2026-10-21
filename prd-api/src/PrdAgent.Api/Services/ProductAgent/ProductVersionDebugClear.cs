using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record ProductVersionClearPreview(string Kind, string KindLabel, int RecordCount,
    string ConfirmPhrase, string Token);
public sealed record ProductVersionClearResult(string Kind, long ClearedCount, long SkippedCount, string? BackupId);

/// <summary>临时调试：仅手动清理所见产品流程记录。先备份、再按ID及修改版本软删除，不重置编号。</summary>
public static class ProductVersionDebugClear
{
    public static bool IsValidKind(string kind) => kind is "internal" or "formal";
    public static string Confirmation(string kind) => kind == "internal" ? "清空T记录" : "清空V记录";

    private static async Task<ProductVersionWorkflowSnapshot> ReadAsync(MongoDbContext db, string kind)
    {
        if (!IsValidKind(kind)) throw new ArgumentException("版本类型无效", nameof(kind));
        var snapshot = new ProductVersionWorkflowSnapshot { SourceType = "debug_clear_" + kind };
        if (kind == "internal")
            snapshot.Initiations = await db.ProductInitiations.Find(x => !x.IsDeleted).SortBy(x => x.Id).ToListAsync();
        else
            snapshot.Releases = await db.ProductReleases.Find(x => !x.IsDeleted).SortBy(x => x.Id).ToListAsync();
        return snapshot;
    }

    private static string Token(string kind, ProductVersionWorkflowSnapshot snapshot)
    {
        var rows = kind == "internal"
            ? snapshot.Initiations.Select(x => $"{x.Id}:{x.UpdatedAt.Ticks}:{x.TCode}")
            : snapshot.Releases.Select(x => $"{x.Id}:{x.UpdatedAt.Ticks}:{x.VCode}");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(kind + "\n" + string.Join("\n", rows))));
    }

    public static async Task<ProductVersionClearPreview> PreviewAsync(MongoDbContext db, string kind)
    {
        var snapshot = await ReadAsync(db, kind);
        return new(kind, kind == "internal" ? "内部版本（T）" : "正式版本（V）",
            snapshot.Initiations.Count + snapshot.Releases.Count,
            Confirmation(kind), Token(kind, snapshot));
    }

    public static async Task<ProductVersionClearResult?> ClearAsync(MongoDbContext db, string kind, string expectedToken, string userId)
    {
        var snapshot = await ReadAsync(db, kind);
        if (!string.Equals(Token(kind, snapshot), expectedToken, StringComparison.Ordinal)) return null;
        var count = snapshot.Initiations.Count + snapshot.Releases.Count;
        if (count == 0) return new(kind, 0, 0, null);
        var now = DateTime.UtcNow;
        snapshot.Name = $"调试清空{(kind == "internal" ? "T" : "V")}备份 {now:yyyy-MM-dd HH:mm:ss} UTC";
        snapshot.CreatedBy = userId;
        snapshot.CreatedAt = now;
        snapshot.ImportedCount = count;
        // 必须先成功保存整份所见记录；备份失败时不得开始任何清理。
        await db.ProductVersionWorkflowSnapshots.InsertOneAsync(snapshot, cancellationToken: CancellationToken.None);
        long cleared;
        if (kind == "internal")
        {
            var writes = snapshot.Initiations.Select(item => new UpdateOneModel<ProductInitiation>(
                Builders<ProductInitiation>.Filter.Where(x => x.Id == item.Id && !x.IsDeleted && x.UpdatedAt == item.UpdatedAt),
                Builders<ProductInitiation>.Update.Set(x => x.IsDeleted, true).Set(x => x.UpdatedAt, now)));
            cleared = (await db.ProductInitiations.BulkWriteAsync(writes, cancellationToken: CancellationToken.None)).ModifiedCount;
        }
        else
        {
            var writes = snapshot.Releases.Select(item => new UpdateOneModel<ProductRelease>(
                Builders<ProductRelease>.Filter.Where(x => x.Id == item.Id && !x.IsDeleted && x.UpdatedAt == item.UpdatedAt),
                Builders<ProductRelease>.Update.Set(x => x.IsDeleted, true).Set(x => x.UpdatedAt, now)));
            cleared = (await db.ProductReleases.BulkWriteAsync(writes, cancellationToken: CancellationToken.None)).ModifiedCount;
        }
        // 记录实体与关联、旧登记、永久编号占用和其他业务均保留，不产生悬空物理引用。
        return new(kind, cleared, count - cleared, snapshot.Id);
    }
}
