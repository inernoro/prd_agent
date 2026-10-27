using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record ProductVersionClearPreview(string Kind, string KindLabel, int RecordCount,
    string ConfirmPhrase, string Token);
public sealed record ProductVersionClearResult(string Kind, long ClearedCount, long SkippedCount, string? BackupId);

/// <summary>临时调试：持有应用队列后按ID及修改版本物理删除，删除记录不再参与发号。</summary>
public static class ProductVersionDebugClear
{
    public static bool IsValidKind(string kind) => kind is "internal" or "formal";
    public static string Confirmation(string kind) => kind == "internal" ? "清空T记录" : "清空V记录";

    private static async Task<ProductVersionWorkflowSnapshot> ReadAsync(MongoDbContext db, string kind)
    {
        if (!IsValidKind(kind)) throw new ArgumentException("版本类型无效", nameof(kind));
        var snapshot = new ProductVersionWorkflowSnapshot { SourceType = "debug_clear_" + kind };
        if (kind == "internal")
            snapshot.Initiations = await db.ProductInitiations.Find(_ => true).SortBy(x => x.Id).ToListAsync();
        else
            snapshot.Releases = await db.ProductReleases.Find(_ => true).SortBy(x => x.Id).ToListAsync();
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
        var applications = await db.Products.Find(_ => true).Project(x => x.Id).ToListAsync();
        if (applications.Count == 0) applications.Add("product-version-clear");
        await using var versionLease = await ProductVersionApplicationLease.AcquireAsync(db, applications);
        var snapshot = await ReadAsync(db, kind);
        if (!string.Equals(Token(kind, snapshot), expectedToken, StringComparison.Ordinal)) return null;
        var count = snapshot.Initiations.Count + snapshot.Releases.Count;
        if (count == 0)
        {
            await ProductVersionClaimGuard.ReleaseDeletedSourceClaimsForKindAsync(db, kind);
            return new(kind, 0, 0, null);
        }
        var now = DateTime.UtcNow;
        snapshot.Name = $"调试清空{(kind == "internal" ? "T" : "V")}备份 {now:yyyy-MM-dd HH:mm:ss} UTC";
        snapshot.CreatedBy = userId;
        await versionLease.EnsureHeldAsync();
        snapshot.CreatedAt = now;
        snapshot.ImportedCount = count;
        // 必须先成功保存整份所见记录；备份失败时不得开始任何清理。
        await db.ProductVersionWorkflowSnapshots.InsertOneAsync(snapshot, cancellationToken: CancellationToken.None);
        long cleared = 0;
        if (kind == "internal")
        {
            foreach (var item in snapshot.Initiations)
            {
                await versionLease.EnsureHeldAsync();
                var target = "initiation:" + item.Id;
                await ProductVersionClaimGuard.MarkSourceRemovalAsync(db, target);
                var removed = await db.ProductInitiations.DeleteOneAsync(x => x.Id == item.Id && x.UpdatedAt == item.UpdatedAt, CancellationToken.None);
                cleared += removed.DeletedCount;
                if (removed.DeletedCount > 0) await ProductVersionClaimGuard.ReleaseDeletedSourceClaimsAsync(db, target);
            }
        }
        else
        {
            foreach (var item in snapshot.Releases)
            {
                await versionLease.EnsureHeldAsync();
                var target = "release:" + item.Id;
                await ProductVersionClaimGuard.MarkSourceRemovalAsync(db, target);
                var removed = await db.ProductReleases.DeleteOneAsync(x => x.Id == item.Id && x.UpdatedAt == item.UpdatedAt, CancellationToken.None);
                cleared += removed.DeletedCount;
                if (removed.DeletedCount > 0) await ProductVersionClaimGuard.ReleaseDeletedSourceClaimsAsync(db, target);
            }
        }
        // 只释放已实际物理删除目标的业务来源，条件删除跳过的有效记录仍保留占用。
        await ProductVersionClaimGuard.ReleaseDeletedSourceClaimsForKindAsync(db, kind);
        // 原评审、独立审计快照和旧数字占号都不是号码基准。
        return new(kind, cleared, count - cleared, snapshot.Id);
    }
}
