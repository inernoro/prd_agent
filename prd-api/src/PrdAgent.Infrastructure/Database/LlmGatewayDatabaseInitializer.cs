using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 在 serving 接收流量前收敛 GW 自有数据结构。
/// </summary>
public sealed class LlmGatewayDatabaseInitializer : IHostedService
{
    private const string AppCallerCollectionName = "llmgw_app_callers";
    private const string DuplicateArchiveCollectionName = "llmgw_app_caller_duplicate_archive";
    private const string OperationAuditCollectionName = "llmgw_operation_audits";
    private readonly LlmGatewayDataContext _data;
    private readonly ILogger<LlmGatewayDatabaseInitializer> _logger;

    public LlmGatewayDatabaseInitializer(
        LlmGatewayDataContext data,
        ILogger<LlmGatewayDatabaseInitializer> logger)
    {
        _data = data;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var callers = _data.Database.GetCollection<GatewayAppCallerRecord>(AppCallerCollectionName);
        await ConsolidateDuplicateAppCallersAsync(callers, cancellationToken);

        var indexes = new[]
        {
            new CreateIndexModel<GatewayAppCallerRecord>(
                Builders<GatewayAppCallerRecord>.IndexKeys
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType),
                new CreateIndexOptions
                {
                    Name = "uniq_llmgw_app_callers_code_request_type",
                    Unique = true,
                    Collation = GatewayAppCallerIdentity.Collation,
                }),
            new CreateIndexModel<GatewayAppCallerRecord>(
                Builders<GatewayAppCallerRecord>.IndexKeys
                    .Ascending(x => x.Status)
                    .Ascending(x => x.RequestType)
                    .Descending(x => x.LastSeenAt),
                new CreateIndexOptions { Name = "idx_llmgw_app_callers_status_type_seen" }),
        };
        await callers.Indexes.CreateManyAsync(indexes, cancellationToken);
        _logger.LogInformation("[LlmGatewayData] appCaller 唯一性与查询索引已就绪");
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task ConsolidateDuplicateAppCallersAsync(
        IMongoCollection<GatewayAppCallerRecord> callers,
        CancellationToken ct)
    {
        var records = await callers.Find(_ => true).ToListAsync(ct);
        var duplicateGroups = records
            .Where(x => !string.IsNullOrWhiteSpace(x.AppCallerCode) && !string.IsNullOrWhiteSpace(x.RequestType))
            .GroupBy(
                x => (x.AppCallerCode.Trim(), x.RequestType.Trim()),
                StringTupleComparer.OrdinalIgnoreCase)
            .Where(x => x.Count() > 1)
            .ToList();

        foreach (var group in duplicateGroups)
        {
            var ordered = group
                .OrderBy(x => string.Equals(x.Status, "discovered", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
                .ThenByDescending(x => x.UpdatedAt)
                .ThenByDescending(x => x.LastSeenAt)
                .ToList();
            var survivor = ordered[0];
            var duplicates = ordered.Skip(1).ToList();
            var duplicateIds = duplicates.Select(x => x.Id).ToList();
            var protocols = ordered
                .SelectMany(x => x.ObservedIngressProtocols ?? [])
                .Append(survivor.IngressProtocol)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var update = Builders<GatewayAppCallerRecord>.Update
                .Set(x => x.AppCallerCode, group.Key.Item1)
                .Set(x => x.RequestType, group.Key.Item2)
                .Set(x => x.ObservedIngressProtocols, protocols)
                .Set(x => x.TotalSeen, ordered.Sum(x => Math.Max(0, x.TotalSeen)))
                .Set(x => x.FirstSeenAt, ordered.Min(x => x.FirstSeenAt))
                .Set(x => x.LastSeenAt, ordered.Max(x => x.LastSeenAt))
                .Set(x => x.CreatedAt, ordered.Min(x => x.CreatedAt))
                .Set(x => x.UpdatedAt, ordered.Max(x => x.UpdatedAt));

            // Preserve every source document before deleting duplicates. The archive uses the
            // original duplicate id as its own id, so a crash/retry remains idempotent.
            var archive = _data.Database.GetCollection<BsonDocument>(DuplicateArchiveCollectionName);
            foreach (var duplicate in duplicates)
            {
                var archiveDocument = new BsonDocument
                {
                    { "_id", duplicate.Id },
                    { "AppCallerCode", group.Key.Item1 },
                    { "RequestType", group.Key.Item2 },
                    { "SurvivorId", survivor.Id },
                    { "ArchivedAt", DateTime.UtcNow },
                    { "Reason", "duplicate-before-unique-index" },
                    { "Original", duplicate.ToBsonDocument() },
                };
                await archive.ReplaceOneAsync(
                    Builders<BsonDocument>.Filter.Eq("_id", duplicate.Id),
                    archiveDocument,
                    new ReplaceOptions { IsUpsert = true },
                    ct);
            }

            await callers.UpdateOneAsync(x => x.Id == survivor.Id, update, cancellationToken: ct);
            var deleteResult = await callers.DeleteManyAsync(x => duplicateIds.Contains(x.Id), ct);

            var audits = _data.Database.GetCollection<BsonDocument>(OperationAuditCollectionName);
            await audits.InsertOneAsync(new BsonDocument
            {
                { "_id", Guid.NewGuid().ToString("N") },
                { "Action", "app_caller.deduplicate" },
                { "TargetType", "llmgw_app_caller" },
                { "TargetId", survivor.Id },
                { "TargetName", $"{group.Key.Item1}::{group.Key.Item2}" },
                { "ActorUserId", BsonNull.Value },
                { "ActorUsername", "system" },
                { "Success", true },
                { "Reason", "prepare-unique-index" },
                { "Changes", new BsonDocument
                    {
                        { "survivorId", survivor.Id },
                        { "archivedDuplicateIds", new BsonArray(duplicateIds) },
                        { "deletedCount", deleteResult.DeletedCount },
                    }
                },
                { "RemoteIp", BsonNull.Value },
                { "UserAgent", "llmgw-database-initializer" },
                { "CreatedAt", DateTime.UtcNow },
            }, cancellationToken: ct);
            _logger.LogWarning(
                "[LlmGatewayData] 合并重复 appCaller: Code={Code}, RequestType={RequestType}, Survivor={Survivor}, Removed={Removed}",
                group.Key.Item1,
                group.Key.Item2,
                survivor.Id,
                deleteResult.DeletedCount);
        }
    }

    private sealed class StringTupleComparer : IEqualityComparer<(string, string)>
    {
        public static StringTupleComparer OrdinalIgnoreCase { get; } = new();

        public bool Equals((string, string) x, (string, string) y)
            => string.Equals(x.Item1, y.Item1, StringComparison.OrdinalIgnoreCase)
               && string.Equals(x.Item2, y.Item2, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode((string, string) obj)
            => HashCode.Combine(
                StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item1),
                StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item2));
    }
}
