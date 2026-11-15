using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.ModelReferences;

/// <summary>Only reference fields and CAS metadata cross the storage boundary; credentials are never projected.</summary>
public sealed class MongoModelReferenceStore(IMongoDatabase gateway, IMongoDatabase map, string internalTenantId) : IModelReferenceStore
{
    public const string JournalCollection = "llmgw_model_reference_migrations";
    private const int MaximumDocuments = 50000;
    private IMongoCollection<ReferenceMigrationPlan> Plans => gateway.GetCollection<ReferenceMigrationPlan>(JournalCollection);
    private IMongoCollection<BsonDocument> Collection(ReferenceCollection c, string tenant)
    {
        if (c.Database == "map" && tenant != internalTenantId) throw new ModelReferenceException("MAP_TENANT_DENIED", "外部组织不能访问 MAP 配置。");
        return (c.Database == "map" ? map : gateway).GetCollection<BsonDocument>(c.Collection);
    }
    private static FilterDefinition<BsonDocument> Scope(string database, string tenant)
        => database == "map" ? Builders<BsonDocument>.Filter.Empty : Builders<BsonDocument>.Filter.Eq("TenantId", tenant);
    public static BsonDocument SafeProjection(ReferenceCollection c)
        => new(ModelReferenceRegistry.MetadataPaths.Concat(c.ProjectionPaths).Distinct(StringComparer.Ordinal).Select(p => new BsonElement(p, 1)));
    public async Task<IReadOnlyList<BsonDocument>> ReadAsync(ReferenceCollection definition, string tenantId, CancellationToken ct)
    {
        var docs = await Collection(definition, tenantId).Find(Scope(definition.Database, tenantId)).Project(SafeProjection(definition)).Limit(MaximumDocuments + 1).ToListAsync(ct);
        if (docs.Count > MaximumDocuments) throw new ModelReferenceException("REFERENCE_SCAN_LIMIT", "配置数量超出本次安全扫描上限，不能宣称全量覆盖。");
        return docs;
    }
    // Server-side schema inventory returns field paths only; it never returns complete config/secret values.
    // If server-side functions are unavailable this fails closed at the engine boundary.
    internal const string InventoryFunction = @"function(doc) {
      var out = [], re = /(^Model$|ModelId$|ModelIds$|ModelName$|ModelPoolId$|ModelPoolIds$|OfferingId$|PlatformId$|^ExpectedModel$|^DefaultModel$|^DefaultVideoModel$|^DirectVideoModel$|^OpenApi(Chat|Image)Models$|^McpLiteraryImageModel)/i;
      function walk(v,p,d) {
        if(d>16) { out.push('#schema-depth-limit'); return; }
        if(Array.isArray(v)) { for(var i=0;i<v.length;i++) walk(v[i],p+'[]',d+1); return; }
        if(v && typeof v==='object') for(var k in v) {
          if(!Object.prototype.hasOwnProperty.call(v,k)) continue;
          var safe=/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(k)?k:'#unknown-field';
          var q=p?p+'.'+safe:safe;
          if(re.test(k)) out.push(q);
          walk(v[k],q,d+1);
        }
      } walk(doc,'',0); return out;
    }";
    public async Task<IReadOnlyList<string>> SelectionPathsAsync(ReferenceCollection definition, string tenantId, CancellationToken ct)
    {
        var match = definition.Database == "map" ? new BsonDocument() : new BsonDocument("TenantId", tenantId);
        var pipeline = new[]
        {
            new BsonDocument("$match", match),
            new BsonDocument("$project", new BsonDocument { { "_id", 0 }, { "paths", new BsonDocument("$function", new BsonDocument { { "body", InventoryFunction }, { "args", new BsonArray { "$$ROOT" } }, { "lang", "js" } }) } }),
            new BsonDocument("$unwind", "$paths"), new BsonDocument("$group", new BsonDocument("_id", "$paths")), new BsonDocument("$limit", 1001),
        };
        var rows = await Collection(definition, tenantId).Aggregate<BsonDocument>(pipeline, cancellationToken: ct).ToListAsync(ct);
        if (rows.Count > 1000) throw new ModelReferenceException("REFERENCE_SCHEMA_LIMIT", "配置结构超出安全扫描上限，请先核对新结构。");
        return rows.Select(x => x["_id"].AsString).ToArray();
    }
    private ReferenceCollection Definition(ReferenceDocumentChange change)
        => ModelReferenceRegistry.Collections.Single(x => x.Collection == change.Collection && x.Database == change.Database);
    public static FilterDefinition<BsonDocument> CompareFilter(ReferenceDocumentChange change, string tenantId)
    {
        var f = Builders<BsonDocument>.Filter; var conditions = new List<FilterDefinition<BsonDocument>> { Scope(change.Database, tenantId), f.Eq("_id", change.RecordId) };
        foreach (var c in change.Conditions) conditions.Add(c.Existed ? f.And(f.Exists(c.Path), f.Eq(c.Path, c.Before)) : f.Exists(c.Path, false));
        foreach (var array in change.ArrayLengths) conditions.Add(new BsonDocument("$expr", new BsonDocument("$eq", new BsonArray {
            new BsonDocument("$size", new BsonDocument("$cond", new BsonArray { new BsonDocument("$isArray", "$" + array.Key), "$" + array.Key, new BsonArray() })), array.Value })));
        return f.And(conditions);
    }
    public async Task<bool> CompareAndSwapAsync(ReferenceDocumentChange change, string tenantId, CancellationToken ct)
    {
        var updates = change.Fields.Select(x => Builders<BsonDocument>.Update.Set(x.Path, x.After)).ToList();
        if (updates.Count == 0) return false;
        updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
        return (await Collection(Definition(change), tenantId).UpdateOneAsync(CompareFilter(change, tenantId), Builders<BsonDocument>.Update.Combine(updates), cancellationToken: ct)).MatchedCount == 1;
    }
    public async Task<bool> IsAppliedAsync(ReferenceDocumentChange change, string tenantId, CancellationToken ct)
    {
        var f = Builders<BsonDocument>.Filter;
        return await Collection(Definition(change), tenantId).Find(f.And(new[] { Scope(change.Database, tenantId), f.Eq("_id", change.RecordId) }
            .Concat(change.Fields.Select(x => f.And(f.Exists(x.Path), f.Eq(x.Path, x.After)))))).AnyAsync(ct);
    }
    public Task InsertPlanAsync(ReferenceMigrationPlan plan, CancellationToken ct) => Plans.InsertOneAsync(plan, cancellationToken: ct);
    public Task<ReferenceMigrationPlan?> ReadPlanAsync(string intentId, string tenantId, CancellationToken ct)
        => Plans.Find(x => x.Id == intentId && x.TenantId == tenantId).FirstOrDefaultAsync(ct)!;
    public async Task<bool> SavePlanAsync(ReferenceMigrationPlan plan, long expectedRevision, CancellationToken ct)
        => (await Plans.ReplaceOneAsync(x => x.Id == plan.Id && x.TenantId == plan.TenantId && x.Revision == expectedRevision, plan, cancellationToken: ct)).MatchedCount == 1;
}
