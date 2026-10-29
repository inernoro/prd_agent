using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// 阶段 0 的次数保护。它不是美元预算，也不以部署版本或用户归属推断任务身份。
/// 旧调用缺少执行来源时仍受 general 基线约束；可信自动任务额外受独立窗口约束。
/// </summary>
public sealed record GatewayMinimumRequestIdentity(string Origin, string? SourceDeployment)
{
    public bool Automatic => Origin == "automatic";
    public static GatewayMinimumRequestIdentity General { get; } = new("general", null);

    public static GatewayMinimumRequestIdentity Resolve(
        HttpContext http,
        GatewayKeyAuthorization authorization,
        string sourceSystem,
        string ingressProtocol)
    {
        if (!authorization.Allowed || !authorization.Authenticated)
            return General;
        if (http.Items[GatewayTaskAdmission.HttpContextPermitKey] is GatewayTaskPermitRecord permit)
            return permit.Origin == TaskExecutionOrigins.Interactive
                ? General : new("automatic", permit.SourceDeployment);
        // 无内部任务事实的服务key归入自动额度。用户头、来源头和UserId不能借到人工额度。
        return new("automatic", null);
    }
}

public sealed record GatewayMinimumProtectionDecision(
    bool Rejected,
    string Scope,
    string Origin,
    int WindowSeconds,
    DateTime WindowStart,
    long Count,
    int Limit)
{
    public string ErrorCode => Origin == "automatic" ? "AUTOMATIC_CONSUMPTION_LIMITED" : "GATEWAY_SAFETY_LIMITED";
    public string Message => Origin == "automatic"
        ? "后台自动任务已达到平台请求上限，已停止本次调用；请在网关请求记录查看预警并核对任务范围。"
        : "请求频率已达到平台保护上限，请稍后重试；管理员可在网关请求记录查看预警并调整已授权额度。";

    public static GatewayMinimumProtectionDecision Allow { get; } = new(false, "", "general", 0, DateTime.MinValue, 0, 0);
}

public sealed class GatewayMinimumProtectionCoordinator
{
    public const string WindowsCollection = "llmgw_consumption_rate_windows";
    public const string AlertsCollection = "llmgw_consumption_alerts";
    private readonly LlmGatewayDataContext _data;
    private readonly IConfiguration _configuration;
    private readonly ILogger<GatewayMinimumProtectionCoordinator> _logger;
    private readonly SemaphoreSlim _indexLock = new(1, 1);
    private bool _indexesReady;

    public GatewayMinimumProtectionCoordinator(
        LlmGatewayDataContext data,
        IConfiguration configuration,
        ILogger<GatewayMinimumProtectionCoordinator> logger)
        => (_data, _configuration, _logger) = (data, configuration, logger);

    public async Task<GatewayMinimumProtectionDecision> CheckAsync(
        string tenantId,
        string appCallerCode,
        string requestType,
        string? teamId,
        string requestId,
        GatewayMinimumRequestIdentity identity,
        int? tenantRateLimitPerMinute,
        int? callerRateLimitPerMinute,
        CancellationToken ct)
    {
        await EnsureIndexesAsync(ct);
        var caller = GatewayAppCallerIdentity.NormalizePart(appCallerCode);
        var type = GatewayAppCallerIdentity.NormalizePart(requestType);
        var limits = new List<(string Scope, string Origin, int Seconds, int Limit)>();
        if (identity.Automatic)
        {
            // 自动任务越限后先拒绝，不让其持续重试耗尽正常用户共用的 general 窗口。
            AddLimits(limits, "app-caller", "automatic", "AutomaticAppCaller", 20, 100, 500);
            AddLimits(limits, "tenant", "automatic", "AutomaticTenant", 60, 300, 1500);
        }
        // 一般与自动基线独立，自动任务成功也不占用正常用户的 fallback 额度。
        // 已明确配置的正数 RPM 继续由既有共享限流执行，仍覆盖全部调用。
        if (!identity.Automatic)
        {
            if (tenantRateLimitPerMinute is null or <= 0)
                AddLimits(limits, "tenant", "general", "Tenant", 600, 6000, 20000);
            if (callerRateLimitPerMinute is null or <= 0)
                AddLimits(limits, "app-caller", "general", "AppCaller", 120, 1000, 5000);
        }

        var now = DateTime.UtcNow;
        foreach (var (scope, origin, seconds, limit) in limits)
        {
            var windowStart = WindowStart(now, seconds);
            // tenant 合并所有调用方和请求类型；caller 合并全部实例和部署版本。
            var counterCaller = scope == "tenant" ? "$tenant" : caller;
            var counterType = scope == "tenant" ? "$aggregate" : type;
            var windowId = Identity("window", tenantId, counterCaller, counterType, scope, origin, seconds, windowStart);
            var windows = _data.Database.GetCollection<BsonDocument>(WindowsCollection);
            var filter = Builders<BsonDocument>.Filter.Eq("_id", windowId)
                         & Builders<BsonDocument>.Filter.Eq("TenantId", tenantId);
            var update = Builders<BsonDocument>.Update
                .SetOnInsert("TenantId", tenantId)
                .SetOnInsert("AppCallerCode", counterCaller)
                .SetOnInsert("RequestType", counterType)
                .SetOnInsert("Scope", scope)
                .SetOnInsert("Origin", origin)
                .SetOnInsert("WindowSeconds", seconds)
                .SetOnInsert("WindowStart", windowStart)
                .SetOnInsert("ExpiresAt", windowStart.AddSeconds(seconds).AddDays(2))
                .Inc("Count", 1);
            BsonDocument window;
            try
            {
                window = await windows.FindOneAndUpdateAsync(filter, update,
                    new FindOneAndUpdateOptions<BsonDocument> { IsUpsert = true, ReturnDocument = ReturnDocument.After }, ct);
            }
            catch (MongoException ex) when (IsDuplicate(ex))
            {
                window = await windows.FindOneAndUpdateAsync(filter, update,
                    new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After }, ct)
                    ?? throw new InvalidOperationException("shared safety counter disappeared after duplicate upsert");
            }
            var count = window["Count"].ToInt64();
            await ObserveAsync(tenantId, counterCaller, counterType, scope == "tenant" ? null : teamId,
                requestId, identity.SourceDeployment, scope, origin, seconds, windowStart, count, limit, ct);
            if (count > limit)
                return new(true, scope, origin, seconds, windowStart, count, limit);
        }
        return GatewayMinimumProtectionDecision.Allow;
    }

    public async Task ObserveAsync(
        string tenantId,
        string appCallerCode,
        string requestType,
        string? teamId,
        string requestId,
        string? sourceDeployment,
        string scope,
        string origin,
        int seconds,
        DateTime windowStart,
        long count,
        int limit,
        CancellationToken ct)
    {
        if (limit <= 0 || count < Math.Max(1, (long)Math.Ceiling(limit * WarningPercent / 100m))) return;
        var kind = count > limit ? "blocked" : "warning";
        var id = Identity("alert", tenantId, appCallerCode, requestType, scope, origin, seconds, windowStart) + ":" + kind;
        var now = DateTime.UtcNow;
        var update = Builders<BsonDocument>.Update
            .SetOnInsert("TenantId", tenantId)
            .SetOnInsert("AppCallerCode", appCallerCode)
            .SetOnInsert("RequestType", requestType)
            .SetOnInsert("TeamId", teamId is null ? (BsonValue)BsonNull.Value : new BsonString(teamId))
            .SetOnInsert("WindowStart", windowStart)
            .SetOnInsert("WindowSeconds", seconds)
            .SetOnInsert("Scope", scope)
            .SetOnInsert("Origin", origin)
            .SetOnInsert("SourceDeployment", sourceDeployment is null ? (BsonValue)BsonNull.Value : new BsonString(sourceDeployment))
            .SetOnInsert("Kind", kind)
            .SetOnInsert("Metric", "requests")
            .SetOnInsert("RequestId", requestId)
            .SetOnInsert("CreatedAt", now)
            .SetOnInsert("Status", "open")
            .Set("UpdatedAt", now)
            .Set("Limit", limit)
            .Set("ThresholdPercent", WarningPercent)
            .Max("Count", count);
        try
        {
            var alerts = _data.Database.GetCollection<BsonDocument>(AlertsCollection);
            var filter = Builders<BsonDocument>.Filter.Eq("_id", id) & Builders<BsonDocument>.Filter.Eq("TenantId", tenantId);
            try { await alerts.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = true }, ct); }
            catch (MongoException ex) when (IsDuplicate(ex))
            {
                await alerts.UpdateOneAsync(filter, update, cancellationToken: ct);
            }
        }
        catch (Exception ex)
        {
            // 通知及告警落库故障不得清零计数、放开硬限制或使正常用户请求失败。
            _logger.LogError(ex, "[GatewaySafety] durable alert unavailable for tenant {TenantId}, scope {Scope}, kind {Kind}", tenantId, scope, kind);
        }
    }

    private int WarningPercent => Math.Clamp(_configuration.GetValue("LlmGateway:MinimumProtection:WarningPercent", 80), 1, 100);

    private void AddLimits(List<(string, string, int, int)> limits, string scope, string origin, string prefix,
        int minute, int hour, int day)
    {
        limits.Add((scope, origin, 60, PositiveLimit(prefix + "PerMinute", minute)));
        limits.Add((scope, origin, 3600, PositiveLimit(prefix + "PerHour", hour)));
        limits.Add((scope, origin, 86400, PositiveLimit(prefix + "PerDay", day)));
    }

    private int PositiveLimit(string name, int fallback)
    {
        var value = _configuration.GetValue("LlmGateway:MinimumProtection:" + name, fallback);
        return value > 0 ? value : fallback;
    }

    private async Task EnsureIndexesAsync(CancellationToken ct)
    {
        if (_indexesReady) return;
        await _indexLock.WaitAsync(ct);
        try
        {
            if (_indexesReady) return;
            await _data.Database.GetCollection<BsonDocument>(WindowsCollection).Indexes.CreateOneAsync(
                new CreateIndexModel<BsonDocument>(Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
                    new CreateIndexOptions { Name = "ttl_llmgw_consumption_windows", ExpireAfter = TimeSpan.Zero }), cancellationToken: ct);
            await _data.Database.GetCollection<BsonDocument>(AlertsCollection).Indexes.CreateOneAsync(
                new CreateIndexModel<BsonDocument>(Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Status").Descending("CreatedAt"),
                    new CreateIndexOptions { Name = "idx_llmgw_consumption_alerts_tenant_status_created" }), cancellationToken: ct);
            _indexesReady = true;
        }
        finally { _indexLock.Release(); }
    }

    public static void ApplyHeaders(HttpContext http, GatewayMinimumProtectionDecision decision)
    {
        if (!decision.Rejected) return;
        var reset = decision.WindowStart.AddSeconds(decision.WindowSeconds);
        http.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling((reset - DateTime.UtcNow).TotalSeconds)).ToString();
        http.Response.Headers["X-RateLimit-Limit"] = decision.Limit.ToString();
        http.Response.Headers["X-RateLimit-Remaining"] = "0";
        http.Response.Headers["X-RateLimit-Reset"] = new DateTimeOffset(reset).ToUnixTimeSeconds().ToString();
        http.Response.Headers["X-LLMGW-Safety-Scope"] = decision.Scope;
        http.Response.Headers["X-LLMGW-Safety-Origin"] = decision.Origin;
        http.Response.Headers["X-LLMGW-Safety-Window-Seconds"] = decision.WindowSeconds.ToString();
    }

    private static DateTime WindowStart(DateTime now, int seconds)
        => new(now.Ticks - now.Ticks % TimeSpan.FromSeconds(seconds).Ticks, DateTimeKind.Utc);

    private static string Identity(string prefix, string tenant, string caller, string type, string scope, string origin, int seconds, DateTime start)
        => prefix + ":" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(
            new { tenant, caller, type, scope, origin, seconds, start = start.Ticks })))).ToLowerInvariant();

    private static bool IsDuplicate(MongoException ex)
        => ex is MongoWriteException { WriteError.Category: ServerErrorCategory.DuplicateKey }
           || ex is MongoCommandException { Code: 11000 or 11001 };
}
