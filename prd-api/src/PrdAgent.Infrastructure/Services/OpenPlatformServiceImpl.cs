using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 开放平台服务的 MongoDB 实现
/// </summary>
public class OpenPlatformServiceImpl : OpenPlatformService
{
    private readonly MongoDbContext _db;

    public OpenPlatformServiceImpl(MongoDbContext db, IIdGenerator idGenerator)
        : base(idGenerator)
    {
        _db = db;
    }

    protected override async Task<OpenPlatformApp> InsertAppAsync(OpenPlatformApp app)
    {
        await _db.OpenPlatformApps.InsertOneAsync(app);
        return app;
    }

    protected override async Task<OpenPlatformApp?> FindAppByApiKeyHashAsync(string apiKeyHash)
    {
        return await _db.OpenPlatformApps
            .Find(a => a.ApiKeyHash == apiKeyHash && a.IsActive)
            .FirstOrDefaultAsync();
    }

    protected override async Task<OpenPlatformApp?> FindAppByIdAsync(string appId)
    {
        return await _db.OpenPlatformApps
            .Find(a => a.Id == appId)
            .FirstOrDefaultAsync();
    }

    protected override async Task<(List<OpenPlatformApp> apps, long total)> QueryAppsAsync(
        int skip,
        int limit,
        string? search)
    {
        var filter = Builders<OpenPlatformApp>.Filter.Empty;

        if (!string.IsNullOrWhiteSpace(search))
        {
            var searchFilter = Builders<OpenPlatformApp>.Filter.Or(
                Builders<OpenPlatformApp>.Filter.Regex(a => a.AppName, new MongoDB.Bson.BsonRegularExpression(search, "i")),
                Builders<OpenPlatformApp>.Filter.Regex(a => a.Description, new MongoDB.Bson.BsonRegularExpression(search, "i"))
            );
            filter = Builders<OpenPlatformApp>.Filter.And(filter, searchFilter);
        }

        var total = await _db.OpenPlatformApps.CountDocumentsAsync(filter);
        var apps = await _db.OpenPlatformApps
            .Find(filter)
            .SortByDescending(a => a.CreatedAt)
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        return (apps, total);
    }

    protected override async Task<bool> UpdateAppFieldsAsync(string appId, Dictionary<string, object> updates)
    {
        var updateDef = Builders<OpenPlatformApp>.Update;
        var updateList = new List<UpdateDefinition<OpenPlatformApp>>();

        foreach (var kvp in updates)
        {
            switch (kvp.Key)
            {
                case "AppName":
                    updateList.Add(updateDef.Set(a => a.AppName, (string)kvp.Value));
                    break;
                case "Description":
                    updateList.Add(updateDef.Set(a => a.Description, (string?)kvp.Value));
                    break;
                case "BoundUserId":
                    updateList.Add(updateDef.Set(a => a.BoundUserId, (string)kvp.Value));
                    break;
                case "BoundGroupId":
                    updateList.Add(updateDef.Set(a => a.BoundGroupId, (string?)kvp.Value));
                    break;
                case "ApiKeyHash":
                    updateList.Add(updateDef.Set(a => a.ApiKeyHash, (string)kvp.Value));
                    break;
                case "IsActive":
                    updateList.Add(updateDef.Set(a => a.IsActive, (bool)kvp.Value));
                    break;
                case "IgnoreUserSystemPrompt":
                    updateList.Add(updateDef.Set(a => a.IgnoreUserSystemPrompt, (bool)kvp.Value));
                    break;
                case "DisableGroupContext":
                    updateList.Add(updateDef.Set(a => a.DisableGroupContext, (bool)kvp.Value));
                    break;
                case "ConversationSystemPrompt":
                    updateList.Add(updateDef.Set(a => a.ConversationSystemPrompt, (string)kvp.Value));
                    break;
                case "TotalRequests":
                    updateList.Add(updateDef.Inc(a => a.TotalRequests, (int)kvp.Value));
                    break;
                case "LastUsedAt":
                    updateList.Add(updateDef.Set(a => a.LastUsedAt, (DateTime)kvp.Value));
                    break;
                case "WebhookUrl":
                    updateList.Add(updateDef.Set(a => a.WebhookUrl, (string?)kvp.Value));
                    break;
                case "WebhookSecret":
                    updateList.Add(updateDef.Set(a => a.WebhookSecret, (string?)kvp.Value));
                    break;
                case "WebhookEnabled":
                    updateList.Add(updateDef.Set(a => a.WebhookEnabled, (bool)kvp.Value));
                    break;
                case "TokenQuotaLimit":
                    updateList.Add(updateDef.Set(a => a.TokenQuotaLimit, (long)kvp.Value));
                    break;
                case "TokensUsed":
                    updateList.Add(updateDef.Set(a => a.TokensUsed, (long)kvp.Value));
                    break;
                case "QuotaWarningThreshold":
                    updateList.Add(updateDef.Set(a => a.QuotaWarningThreshold, (long)kvp.Value));
                    break;
                case "LastQuotaWarningAt":
                    updateList.Add(updateDef.Set(a => a.LastQuotaWarningAt, (DateTime?)kvp.Value));
                    break;
            }
        }

        if (updateList.Count == 0) return false;

        var result = await _db.OpenPlatformApps.UpdateOneAsync(
            a => a.Id == appId,
            updateDef.Combine(updateList)
        );

        // 用 MatchedCount 而非 ModifiedCount：即使值相同（未实际修改）也视为成功
        return result.MatchedCount > 0;
    }

    protected override async Task<bool> DeleteAppByIdAsync(string appId)
    {
        var result = await _db.OpenPlatformApps.DeleteOneAsync(a => a.Id == appId);
        return result.DeletedCount > 0;
    }

    protected override async Task InsertLogAsync(OpenPlatformRequestLog log)
    {
        await _db.OpenPlatformRequestLogs.InsertOneAsync(log);
    }

    protected override async Task<(List<OpenPlatformRequestLog> logs, long total)> QueryLogsAsync(
        int skip,
        int limit,
        string? appId,
        DateTime? startTime,
        DateTime? endTime,
        int? statusCode)
    {
        var filter = Builders<OpenPlatformRequestLog>.Filter.Empty;

        if (!string.IsNullOrWhiteSpace(appId))
            filter = Builders<OpenPlatformRequestLog>.Filter.And(filter,
                Builders<OpenPlatformRequestLog>.Filter.Eq(l => l.AppId, appId));

        if (startTime.HasValue)
            filter = Builders<OpenPlatformRequestLog>.Filter.And(filter,
                Builders<OpenPlatformRequestLog>.Filter.Gte(l => l.StartedAt, startTime.Value));

        if (endTime.HasValue)
            filter = Builders<OpenPlatformRequestLog>.Filter.And(filter,
                Builders<OpenPlatformRequestLog>.Filter.Lte(l => l.StartedAt, endTime.Value));

        if (statusCode.HasValue)
            filter = Builders<OpenPlatformRequestLog>.Filter.And(filter,
                Builders<OpenPlatformRequestLog>.Filter.Eq(l => l.StatusCode, statusCode.Value));

        var total = await _db.OpenPlatformRequestLogs.CountDocumentsAsync(filter);
        var logs = await _db.OpenPlatformRequestLogs
            .Find(filter)
            .SortByDescending(l => l.StartedAt)
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        return (logs, total);
    }
}
