using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record ProductVersionClearPreview(string Kind, string KindLabel, int RecordCount,
    string ConfirmPhrase, string Token, int LegacyRecordCount);
public sealed record ProductVersionClearResult(string Kind, long ClearedCount, long SkippedCount, string? BackupId,
    string? LegacyBackupId = null, long RemainingCount = 0);

/// <summary>临时调试：持有应用队列后按ID及修改版本物理删除，删除记录不再参与发号。</summary>
public static class ProductVersionDebugClear
{
    public static bool IsValidKind(string kind) => kind is "internal" or "formal";
    public static string Confirmation(string kind) => kind == "internal" ? "清空T记录" : "清空V记录";

    private static async Task<(ProductVersionWorkflowSnapshot Snapshot, List<VersionRegistration> Legacy)> ReadAsync(
        MongoDbContext db, string kind)
    {
        if (!IsValidKind(kind)) throw new ArgumentException("版本类型无效", nameof(kind));
        var snapshot = new ProductVersionWorkflowSnapshot { SourceType = "debug_clear_" + kind };
        if (kind == "internal")
            snapshot.Initiations = await db.ProductInitiations.Find(_ => true).SortBy(x => x.Id).ToListAsync();
        else
            snapshot.Releases = await db.ProductReleases.Find(_ => true).SortBy(x => x.Id).ToListAsync();
        var legacy = await db.VersionRegistrations.Find(x => x.Kind == kind).SortBy(x => x.Id).ToListAsync();
        return (snapshot, legacy);
    }

    private static string Token(string kind, ProductVersionWorkflowSnapshot snapshot, List<VersionRegistration> legacy)
    {
        var rows = kind == "internal"
            ? snapshot.Initiations.Select(x => $"{x.Id}:{x.UpdatedAt.Ticks}:{x.TCode}")
            : snapshot.Releases.Select(x => $"{x.Id}:{x.UpdatedAt.Ticks}:{x.VCode}");
        var legacyRows = legacy.Select(x => $"{x.Id}:{x.UpdatedAt.Ticks}:{x.Code}");
        var payload = kind + "\nworkflow\n" + string.Join("\n", rows) + "\nlegacy\n" + string.Join("\n", legacyRows);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));
    }

    public static async Task<ProductVersionClearPreview> PreviewAsync(MongoDbContext db, string kind)
    {
        var (snapshot, legacy) = await ReadAsync(db, kind);
        return new(kind, kind == "internal" ? "内部版本（T）" : "正式版本（V）",
            snapshot.Initiations.Count + snapshot.Releases.Count + legacy.Count,
            Confirmation(kind), Token(kind, snapshot, legacy), legacy.Count);
    }

    public static async Task<ProductVersionClearResult?> ClearAsync(MongoDbContext db, string kind, string expectedToken, string userId)
    {
        var applications = await db.Products.Find(_ => true).Project(x => x.Id).ToListAsync();
        if (applications.Count == 0) applications.Add("product-version-clear");
        await using var versionLease = await ProductVersionApplicationLease.AcquireAsync(db, applications);
        var (snapshot, legacy) = await ReadAsync(db, kind);
        if (!string.Equals(Token(kind, snapshot, legacy), expectedToken, StringComparison.Ordinal)) return null;
        var workflowCount = snapshot.Initiations.Count + snapshot.Releases.Count;
        var count = workflowCount + legacy.Count;
        if (count == 0)
        {
            await ProductVersionClaimGuard.ReleaseDeletedSourceClaimsForKindAsync(db, kind);
            return new(kind, 0, 0, null);
        }
        var now = DateTime.UtcNow;
        var code = kind == "internal" ? "T" : "V";
        await versionLease.EnsureHeldAsync();
        // 两类备份沿用各自的存档权限。所有备份写入成功后才开始清理。
        if (workflowCount > 0)
        {
            snapshot.Name = $"调试清空{code}备份 {now:yyyy-MM-dd HH:mm:ss} UTC";
            snapshot.CreatedBy = userId;
            snapshot.CreatedAt = now;
            snapshot.ImportedCount = workflowCount;
            await db.ProductVersionWorkflowSnapshots.InsertOneAsync(snapshot, cancellationToken: CancellationToken.None);
        }
        VersionRegistrationSnapshot? legacyBackup = null;
        if (legacy.Count > 0)
        {
            legacyBackup = new()
            {
                Name = $"调试清空旧登记{code}备份 {now:yyyy-MM-dd HH:mm:ss} UTC",
                SourceType = VersionRegistrationSnapshotSourceType.DebugClear,
                CreatedBy = userId,
                CreatedAt = now,
                ImportedCount = legacy.Count,
                Records = legacy,
            };
            await db.VersionRegistrationSnapshots.InsertOneAsync(legacyBackup, cancellationToken: CancellationToken.None);
        }
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
        foreach (var item in legacy)
        {
            await versionLease.EnsureHeldAsync();
            var removed = await db.VersionRegistrations.DeleteOneAsync(
                x => x.Id == item.Id && x.Kind == kind && x.UpdatedAt == item.UpdatedAt, CancellationToken.None);
            cleared += removed.DeletedCount;
        }
        // 只释放已实际物理删除目标的业务来源，条件删除跳过的有效记录仍保留占用。
        await ProductVersionClaimGuard.ReleaseDeletedSourceClaimsForKindAsync(db, kind);
        var remainingWorkflow = kind == "internal"
            ? await db.ProductInitiations.CountDocumentsAsync(_ => true)
            : await db.ProductReleases.CountDocumentsAsync(_ => true);
        var remainingLegacy = await db.VersionRegistrations.CountDocumentsAsync(x => x.Kind == kind);
        return new(kind, cleared, count - cleared, workflowCount > 0 ? snapshot.Id : null,
            legacyBackup?.Id, remainingWorkflow + remainingLegacy);
    }
}
