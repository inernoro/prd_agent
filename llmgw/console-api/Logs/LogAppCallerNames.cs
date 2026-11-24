using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.Logs;

public static class LogAppCallerNames
{
    public static string? Snapshot(BsonDocument log)
    {
        var code = log.AsNullableString("AppCallerCode");
        return MeaningfulName(log.AsNullableString("AppCallerCodeDisplayName"), code)
            ?? MeaningfulName(log.AsNullableString("AppCallerTitle"), code);
    }

    public static async Task FillMissingAsync(
        HttpContext http, IReadOnlyList<BsonDocument> logs,
        IMongoDatabase gatewayDatabase, IMongoDatabase mapDatabase, string internalTenantId)
    {
        var missing = logs.Where(log => Snapshot(log) is null
            && !string.IsNullOrWhiteSpace(log.AsNullableString("AppCallerCode"))).ToArray();
        if (missing.Length == 0) return;

        var filter = Builders<BsonDocument>.Filter;
        var projection = Builders<BsonDocument>.Projection;
        // 只让编号的匹配忽略大小写，保留租户与团队范围的精确匹配。
        var codes = missing.Select(log => log.GetStringOrEmpty("AppCallerCode").Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(code => new BsonRegularExpression($@"\A{Regex.Escape(code)}\z", "i"));
        var callers = await gatewayDatabase.GetCollection<BsonDocument>("llmgw_app_callers")
            .Find(TenantAccess.FilterTeamScope(http, filter.In("AppCallerCode", codes)))
            .Project(projection.Include("AppCallerCode").Include("RequestType").Include("TeamId").Include("Title"))
            .ToListAsync(http.RequestAborted);
        var callersByCode = callers.ToLookup(caller => caller.GetStringOrEmpty("AppCallerCode"), StringComparer.OrdinalIgnoreCase);

        var mapLogs = new List<BsonDocument>();
        var internalTenant = TenantAccess.GetRequired(http).TenantId == internalTenantId;
        foreach (var log in missing)
        {
            var code = log.GetStringOrEmpty("AppCallerCode").Trim();
            var title = RegisteredName(log, callersByCode[code]);
            if (title is not null)
                log["AppCallerCodeDisplayName"] = title;
            else if (internalTenant && string.Equals(log.AsNullableString("SourceSystem"), "map", StringComparison.OrdinalIgnoreCase))
                mapLogs.Add(log);
        }

        if (mapLogs.Count == 0) return;
        // MAP 内置调用方的名称可用于解释历史记录，包括被网关拒绝、尚未登记用途的请求。
        // 只读内置名称；网关的注册、路由与授权仍由网关库决定。
        var mapCodes = mapLogs.Select(log => log.GetStringOrEmpty("AppCallerCode").Trim().ToLowerInvariant()).Distinct();
        using var lookupDeadline = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);
        lookupDeadline.CancelAfter(TimeSpan.FromSeconds(1));
        List<BsonDocument> mapCallers;
        try
        {
            mapCallers = await mapDatabase.GetCollection<BsonDocument>("llm_app_callers")
                .Find(filter.In("AppCode", mapCodes) & filter.Eq("IsSystemDefault", true))
                .Project(projection.Include("AppCode").Include("DisplayName"))
                .ToListAsync(lookupDeadline.Token);
        }
        catch (Exception ex) when (!http.RequestAborted.IsCancellationRequested
            && ex is MongoException or TimeoutException or OperationCanceledException)
        {
            http.RequestServices.GetService<ILoggerFactory>()?.CreateLogger(nameof(LogAppCallerNames))
                .LogWarning("读取 MAP 内置调用方名称失败 ({ErrorType})。", ex.GetType().Name);
            return;
        }
        var mapCallersByCode = mapCallers.ToLookup(caller => caller.GetStringOrEmpty("AppCode"), StringComparer.OrdinalIgnoreCase);
        foreach (var log in mapLogs)
        {
            var code = log.GetStringOrEmpty("AppCallerCode").Trim();
            var names = mapCallersByCode[code]
                .Select(caller => MeaningfulName(caller.AsNullableString("DisplayName"), code))
                .Distinct().Take(2).ToArray();
            if (names is [string name]) log["AppCallerCodeDisplayName"] = name;
        }
    }

    public static string? RegisteredName(BsonDocument log, IEnumerable<BsonDocument> callers)
    {
        var code = log.GetStringOrEmpty("AppCallerCode").Trim();
        var teamId = log.AsNullableString("TeamId");
        var requestType = log.AsNullableString("RequestType")?.Trim();
        var candidates = callers.Where(caller =>
            string.Equals(caller.AsNullableString("AppCallerCode"), code, StringComparison.OrdinalIgnoreCase)
            && (string.IsNullOrEmpty(teamId) || caller.AsNullableString("TeamId") == teamId)
            && (string.IsNullOrEmpty(requestType)
                || string.Equals(caller.AsNullableString("RequestType"), requestType, StringComparison.OrdinalIgnoreCase)))
            .Take(2).ToArray();
        // 早期拒绝日志没有请求类型。只在这个编号能唯一对应可见用途时使用登记名称。
        return candidates is [var caller] ? MeaningfulName(caller.AsNullableString("Title"), code) : null;
    }

    private static string? MeaningfulName(string? value, string? code)
    {
        var name = value?.Trim();
        return string.IsNullOrEmpty(name) || string.Equals(name, code?.Trim(), StringComparison.OrdinalIgnoreCase)
            ? null : name;
    }
}
