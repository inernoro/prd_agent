using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Bson;
using MongoDB.Bson.IO;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record ProductReleaseBackupFile(string Format, int RecordCount, DateTime ExportedAt, string Payload);
public sealed record ProductReleaseRestoreResult(int Total, int ToRestore, int Existing, int Conflicts, int Restored);

public sealed class ProductReleaseBackup(MongoDbContext db, IDataProtectionProvider protection)
{
    public const string Format = "map-formal-version-backup-v1";
    private const int MaxPayloadBytes = 16 * 1024 * 1024;
    public const int RequestLimit = 24 * 1024 * 1024;
    private IMongoCollection<BsonDocument> Documents => db.Database.GetCollection<BsonDocument>(db.ProductReleases.CollectionNamespace.CollectionName);
    private IDataProtector ProofProtector => protection.CreateProtector(Format, db.Database.DatabaseNamespace.DatabaseName);

    public async Task<ProductReleaseBackupFile> ExportAsync(CancellationToken token)
    {
        var records = await Documents.Find(FilterDefinition<BsonDocument>.Empty)
            .Sort(Builders<BsonDocument>.Sort.Ascending("_id")).ToListAsync(token);
        var exportedAt = DateTime.UtcNow;
        var bytes = Encoding.UTF8.GetBytes(new BsonDocument
        {
            { "exportedAt", exportedAt }, { "releases", new BsonArray(records) },
        }.ToJson(new JsonWriterSettings { OutputMode = JsonOutputMode.CanonicalExtendedJson }));
        if (bytes.Length > MaxPayloadBytes) throw new InvalidDataException("正式版本备份超过文件上限，请联系管理员处理。");
        return new(Format, records.Count, exportedAt, Convert.ToBase64String(ProofProtector.Protect(bytes)));
    }

    public async Task<ProductReleaseRestoreResult> RestoreAsync(ProductReleaseBackupFile file, bool preview, CancellationToken token)
    {
        var backup = Read(file);
        var keys = backup.Select(row => row.Record.ProductId).Concat(backup.Where(row => row.Record.IsTemporaryOptimization)
            .Select(row => "temporary-optimization:" + row.Record.PlanName.Trim())).Append("formal-version-restore");
        await using var lease = preview ? null : await ProductVersionApplicationLease.AcquireAsync(db, keys);
        var existing = await db.ProductReleases.Find(FilterDefinition<ProductRelease>.Empty).ToListAsync(token);
        var existingIds = existing.Select(row => row.Id).ToHashSet(StringComparer.Ordinal);
        var backupById = backup.ToDictionary(row => row.Record.Id, row => row.Record, StringComparer.Ordinal);
        var versionKeys = existing.Where(row => !row.IsDeleted && !string.IsNullOrWhiteSpace(row.VCode))
            .Where(row => !backupById.TryGetValue(row.Id, out var original) || original.IsDeleted || VersionKey(original) != VersionKey(row))
            .Select(VersionKey).ToHashSet();
        var titles = existing.Where(row => !row.IsDeleted && row.IsTemporaryOptimization)
            .Where(row => !backupById.TryGetValue(row.Id, out var original) || original.IsDeleted
                || !original.IsTemporaryOptimization || original.PlanName.Trim() != row.PlanName.Trim())
            .Select(row => row.PlanName.Trim()).ToHashSet(StringComparer.Ordinal);
        var candidates = backup.Where(row => !existingIds.Contains(row.Record.Id)).ToList();
        var conflicts = candidates.Count(row => !row.Record.IsDeleted && (
            (!string.IsNullOrWhiteSpace(row.Record.VCode) && versionKeys.Contains(VersionKey(row.Record)))
            || (row.Record.IsTemporaryOptimization && titles.Contains(row.Record.PlanName.Trim()))));
        var restored = 0;
        if (!preview && conflicts == 0)
        {
            foreach (var batch in candidates.Chunk(100))
            {
                await lease!.EnsureHeldAsync();
                foreach (var row in batch) FreezeNotification(row.Document);
                await Documents.InsertManyAsync(batch.Select(row => row.Document), cancellationToken: CancellationToken.None);
                restored += batch.Length;
            }
        }
        return new(backup.Count, candidates.Count - conflicts, backup.Count - candidates.Count, conflicts, restored);
    }

    private static (string ProductId, string Code) VersionKey(ProductRelease row) =>
        (row.ProductId, row.VCode.Trim().ToUpperInvariant());

    private List<(BsonDocument Document, ProductRelease Record)> Read(ProductReleaseBackupFile file)
    {
        if (file.Format != Format || string.IsNullOrWhiteSpace(file.Payload)
            || file.Payload.Length > (MaxPayloadBytes + 512) / 3 * 4)
            throw new InvalidDataException("请选择 MAP 导出的正式版本完整备份。");
        try
        {
            var bytes = ProofProtector.Unprotect(Convert.FromBase64String(file.Payload));
            if (bytes.Length > MaxPayloadBytes)
                throw new InvalidDataException("备份内容未通过校验，请重新选择原始备份。");
            var document = BsonSerializer.Deserialize<BsonDocument>(Encoding.UTF8.GetString(bytes));
            var rows = document["releases"].AsBsonArray.Select(value =>
            {
                var row = value.AsBsonDocument;
                return (Document: row, Record: BsonSerializer.Deserialize<ProductRelease>(row));
            }).ToList();
            if (rows.Count != file.RecordCount || rows.Select(row => row.Record.Id).Distinct(StringComparer.Ordinal).Count() != rows.Count)
                throw new InvalidDataException("备份记录数量或标识不一致。");
            return rows;
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or BsonSerializationException)
        {
            throw new InvalidDataException("备份校验失败，请选择当前 MAP 环境导出的原始文件。", ex);
        }
    }

    private static void FreezeNotification(BsonDocument release)
    {
        if (!release.TryGetValue("ClaimNotification", out var value) || !value.IsBsonDocument) return;
        var notice = value.AsBsonDocument;
        if (notice.GetValue("Status", "").AsString is not ("pending" or "waiting_identity" or "sending" or "debug_pending")) return;
        notice["Status"] = "unknown";
        notice["Error"] = "备份恢复保留通知记录，待发送通知不会自动重发。";
        notice["LeaseId"] = BsonNull.Value;
    }
}
