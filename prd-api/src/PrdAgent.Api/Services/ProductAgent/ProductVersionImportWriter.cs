using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed class ProductVersionImportConflictException(string message) : Exception(message);

/// <summary>导入只覆盖联合键对应的原记录；新记录使用稳定ID防止并发重复插入。</summary>
public static class ProductVersionImportWriter
{
    public static async Task<bool> SaveInitiationAsync(MongoDbContext db, ProductInitiation item)
    {
        var f = Builders<ProductInitiation>.Filter;
        var key = f.Eq(x => x.IsDeleted, false) & f.Or(f.Eq(x => x.LinkedProductId, item.ProductId),
            f.And(f.Eq(x => x.ProductId, item.ProductId), f.Or(f.Eq(x => x.LinkedProductId, null), f.Eq(x => x.LinkedProductId, ""))))
            & f.Regex(x => x.TCode, CodePattern(item.TCode!));
        var matches = await db.ProductInitiations.Find(key).Limit(2).ToListAsync();
        if (matches.Count > 1) throw new ProductVersionImportConflictException("该应用与版本号已有多条记录，请先调试清空后重新导入。");
        item.Id = matches.SingleOrDefault()?.Id ?? StableId("T", item.ProductId, item.TCode!);
        if (matches.Count == 0) await ReserveNewIdentityAsync(db, "T", item.ProductId, item.TCode!, "initiation:" + item.Id);
        return await SaveAsync(db.ProductInitiations, item, f.Eq(x => x.Id, item.Id) & key,
            "PlanName,PlanUrl,SystemName,AppName,ProjectType,CustomerSource,DemandSource,OwnerName,ProjectMemberNames,RequirementDescription,DepartmentName,FirstDraftMeetingAt,SecondDraftMeetingAt,ThirdDraftMeetingAt,ProjectAt,PlannedProjectAt,NeedUiDesign,IsAiPoc,DevelopmentStatus,Remark,LegacyData,UpdatedAt");
    }

    public static async Task<bool> SaveReleaseAsync(MongoDbContext db, ProductRelease item)
    {
        var f = Builders<ProductRelease>.Filter;
        var key = f.Eq(x => x.IsDeleted, false) & f.Eq(x => x.ProductId, item.ProductId) & f.Regex(x => x.VCode, CodePattern(item.VCode));
        var matches = await db.ProductReleases.Find(key).Limit(2).ToListAsync();
        if (matches.Count > 1) throw new ProductVersionImportConflictException("该应用与版本号已有多条记录，请先调试清空后重新导入。");
        item.Id = matches.SingleOrDefault()?.Id ?? StableId("V", item.ProductId, item.VCode);
        if (matches.Count == 0) await ReserveNewIdentityAsync(db, "V", item.ProductId, item.VCode, "release:" + item.Id);
        // 已关联正式版本不能借覆盖导入改换T来源。
        if (matches.Count == 1 && !string.IsNullOrWhiteSpace(item.TCode) && matches[0].TCode != item.TCode)
            throw new ProductVersionImportConflictException("该正式版本的T来源与原记录不同，未覆盖，请核对文件。");
        return await SaveAsync(db.ProductReleases, item, f.Eq(x => x.Id, item.Id) & key,
            "PlanName,AnnouncementUrl,SystemName,AppName,ProjectType,DepartmentName,DemandSource,RequirementDescription,OwnerName,ProjectMemberNames,ContractParty,Remark,IsGlobalOpen,OpenBrandScope,PlanUrl,PlannedReleaseAt,PlannedTrainingMinutes,ReleasedAt,LegacyData,UpdatedAt");
    }

    private static BsonRegularExpression CodePattern(string code) => new("^\\s*" + Regex.Escape(code.Trim()) + "\\s*$", "i");
    private static async Task ReserveNewIdentityAsync(MongoDbContext db, string kind, string productId, string code, string target)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(productId))).ToLowerInvariant();
        var key = $"workflow-code:{kind}:{hash}:{code}";
        if (await ProductVersionClaimGuard.TryReserveAsync(db.Database, key, target)) return;
        var claims = db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName);
        var old = await claims.Find(Builders<BsonDocument>.Filter.Eq("_id", key)).SingleAsync();
        var previous = old.GetValue("targetId", "").AsString;
        var parts = previous.Split(':');
        var removed = await claims.Find(Builders<BsonDocument>.Filter.Eq("_id", "source-removed:" + previous)).AnyAsync();
        // 只有明确删除过的旧占号允许历史重导；未知/在途发号不能被导入抢占。
        if (!removed || parts.Length != 2
            || (kind == "T" ? await db.ProductInitiations.Find(x => x.Id == parts[1] && !x.IsDeleted).AnyAsync()
                : await db.ProductReleases.Find(x => x.Id == parts[1] && !x.IsDeleted).AnyAsync()))
            throw new ProductVersionImportConflictException("该编号已有申领或导入正在处理，未新增重复记录，请刷新后重试。");
    }
    private static string StableId(string kind, string productId, string code) => "version-import-"
        + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(kind + "\n" + productId + "\n" + code.Trim().ToUpperInvariant()))).ToLowerInvariant();

    private static async Task<bool> SaveAsync<T>(IMongoCollection<T> collection, T item, FilterDefinition<T> filter, string editableFields)
    {
        var map = BsonClassMap.LookupClassMap(typeof(T));
        var document = item.ToBsonDocument();
        var editable = editableFields.Split(',').Select(x => map.GetMemberMap(x).ElementName).ToHashSet();
        var set = new BsonDocument(document.Elements.Where(x => editable.Contains(x.Name)));
        var insert = new BsonDocument(document.Elements.Where(x => !editable.Contains(x.Name)));
        // ID、申请人、创建/发号时间、类别、评审与下游字段只在首次插入时设置。
        var update = new BsonDocumentUpdateDefinition<T>(new BsonDocument { { "$set", set }, { "$setOnInsert", insert } });
        try
        {
            var result = await collection.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = true }, CancellationToken.None);
            return result.UpsertedId != null;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 另一上传已插入同一稳定ID；重试只能更新完全相同的联合键，不能覆盖变更过的编号。
            var result = await collection.UpdateOneAsync(filter, new BsonDocumentUpdateDefinition<T>(new BsonDocument("$set", set)), cancellationToken: CancellationToken.None);
            if (result.MatchedCount == 0) throw new ProductVersionImportConflictException("记录在导入期间已变化，请刷新后重试。");
            return false;
        }
    }
}
