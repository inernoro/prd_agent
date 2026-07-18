using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.LlmGatewayHost;

public sealed record GatewayKeyAuthorization(
    bool Allowed,
    bool Authenticated,
    int StatusCode,
    string ErrorCode,
    string Detail,
    string? KeyId = null,
    string? TenantId = null,
    string? TeamId = null,
    bool LegacySharedKey = false,
    string? ClientCode = null,
    string? Environment = null,
    string? KeyPrefixSnapshot = null,
    string? ResolvedAppCallerCode = null);

public interface IGatewayScopedKeyAuthorizer
{
    Task<GatewayKeyAuthorization> AuthorizeAsync(
        string providedKey,
        string legacySharedKey,
        string sourceSystem,
        string appCallerCode,
        string ingressProtocol,
        string requiredScope,
        IPAddress? remoteIp,
        CancellationToken ct,
        bool allowSingleAppCallerInference = false);
}

public static class GatewayLegacyProbeScopes
{
    public const string Route = "legacy-preflight:route";
    public const string Readiness = "legacy-preflight:readiness";

    public static bool IsReadOnlyProbe(string scope)
        => scope is Route or Readiness;

    public static string ResolveServiceKeyScope(string scope)
        => scope switch
        {
            Route => "route:read",
            Readiness => "readiness:read",
            _ => scope,
        };

    public static string ResolveAuditCaller(string scope)
        => scope == Readiness
            ? "llmgw.legacy-preflight::readiness"
            : "llmgw.legacy-preflight::route";
}

public static class GatewayKeyPurposePolicy
{
    public static string ResolveEffectivePurpose(GatewayServiceKeyRecord record)
    {
        if (!string.IsNullOrWhiteSpace(record.Purpose))
            return record.Purpose.Trim().ToLowerInvariant();

        return string.Equals(record.SourceSystem, "map", StringComparison.OrdinalIgnoreCase)
            ? "runtime"
            : "external-platform";
    }

    public static bool AllowsDataPlaneRequest(GatewayServiceKeyRecord record, bool readOnlyProbe)
    {
        var purpose = ResolveEffectivePurpose(record);
        if (!string.Equals(record.SourceSystem, "map", StringComparison.OrdinalIgnoreCase))
            return purpose == "external-platform";

        return purpose == "runtime" || readOnlyProbe && purpose == "release-gate";
    }
}

public static class GatewaySuccessorObservationPolicy
{
    public static bool IsBusinessInvocationScope(string scope)
        => scope is "invoke" or "stream:invoke" or "raw:invoke";
}

public sealed class GatewayScopedKeyAuthorizer : IGatewayScopedKeyAuthorizer
{
    private readonly LlmGatewayDataContext _data;
    private readonly string _internalTenantId;

    public GatewayScopedKeyAuthorizer(LlmGatewayDataContext data, IConfiguration? configuration = null)
    {
        _data = data;
        _internalTenantId = configuration?["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } configured
            ? configured
            : "tenant_map_internal";
    }

    public async Task<GatewayKeyAuthorization> AuthorizeAsync(
        string providedKey,
        string legacySharedKey,
        string sourceSystem,
        string appCallerCode,
        string ingressProtocol,
        string requiredScope,
        IPAddress? remoteIp,
        CancellationToken ct,
        bool allowSingleAppCallerInference = false)
    {
        if (string.IsNullOrWhiteSpace(providedKey))
            return new(false, false, 401, "GATEWAY_KEY_REQUIRED", "missing gateway key");

        if (FixedTimeEquals(providedKey, legacySharedKey))
            return await AuthorizeLegacyKeyAsync(sourceSystem, appCallerCode, ingressProtocol, requiredScope, ct);

        var hash = Sha256Hex(providedKey);
        var keys = _data.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys");
        var directory = _data.Database.GetCollection<GatewayServiceKeyDirectoryRecord>("llmgw_service_key_directory");
        var locator = await directory.Find(x => x.KeyHash == hash).FirstOrDefaultAsync(ct);
        var record = locator is null
            ? null
            : await keys.Find(x => x.TenantId == locator.TenantId && x.Id == locator.ServiceKeyId && x.KeyHash == hash).FirstOrDefaultAsync(ct);
        if (record == null || string.IsNullOrWhiteSpace(record.TenantId))
            return new(false, false, 401, "GATEWAY_KEY_INVALID", "invalid or expired gateway key");
        var effectiveAppCallerCode = allowSingleAppCallerInference
            ? ResolveSingleAppCallerCode(record) ?? appCallerCode
            : appCallerCode;
        if (!record.Enabled || record.ExpiresAt is not null && record.ExpiresAt <= DateTime.UtcNow)
        {
            return new(
                false,
                true,
                401,
                "GATEWAY_KEY_INVALID",
                "invalid or expired gateway key",
                record.Id,
                record.TenantId,
                record.TeamId,
                ClientCode: ResolveClientCode(record),
                Environment: ResolveEnvironment(record),
                KeyPrefixSnapshot: record.KeyPrefix);
        }

        var lifecycleDenied = await CheckLifecycleAsync(record, effectiveAppCallerCode, ct);
        if (lifecycleDenied is not null)
            return lifecycleDenied;

        var readOnlyProbe = GatewayLegacyProbeScopes.IsReadOnlyProbe(requiredScope);
        var serviceKeyScope = GatewayLegacyProbeScopes.ResolveServiceKeyScope(requiredScope);
        if (!GatewayKeyPurposePolicy.AllowsDataPlaneRequest(record, readOnlyProbe))
        {
            await WriteKeyDeniedAuditAsync(record, "service_key.purpose_denied", "purpose-mismatch", new BsonDocument
            {
                { "purpose", GatewayKeyPurposePolicy.ResolveEffectivePurpose(record) },
                { "requiredScope", serviceKeyScope },
                { "readOnlyProbe", readOnlyProbe },
            }, ct);
            return new(
                false,
                true,
                403,
                "GATEWAY_KEY_PURPOSE_DENIED",
                "gateway key purpose does not allow this data-plane request",
                record.Id,
                record.TenantId,
                record.TeamId,
                ClientCode: ResolveClientCode(record),
                Environment: ResolveEnvironment(record),
                KeyPrefixSnapshot: record.KeyPrefix);
        }
        if (!readOnlyProbe
            && (!Matches(record.SourceSystem, sourceSystem)
                || !MatchesAny(record.AppCallerCodes, effectiveAppCallerCode))
            || !MatchesAny(record.IngressProtocols, ingressProtocol)
            || !MatchesAny(record.Scopes, serviceKeyScope))
        {
            await _data.Database.GetCollection<MongoDB.Bson.BsonDocument>("llmgw_operation_audits").InsertOneAsync(
                new MongoDB.Bson.BsonDocument
                {
                    { "_id", Guid.NewGuid().ToString("N") },
                    { "TenantId", record.TenantId },
                    { "TeamId", string.IsNullOrWhiteSpace(record.TeamId) ? MongoDB.Bson.BsonNull.Value : record.TeamId },
                    { "Action", "service_key.scope_denied" },
                    { "TargetType", "llmgw_service_key" },
                    { "TargetId", record.Id },
                    { "TargetName", record.Name },
                    { "Success", false },
                    { "Reason", "scope-mismatch" },
                    { "Changes", new MongoDB.Bson.BsonDocument
                        {
                            { "sourceSystem", sourceSystem },
                            { "appCallerCode", effectiveAppCallerCode },
                            { "ingressProtocol", ingressProtocol },
                            { "requiredScope", serviceKeyScope },
                        }
                    },
                    { "CreatedAt", DateTime.UtcNow },
                }, cancellationToken: ct);
            return new(
                false,
                true,
                403,
                "GATEWAY_KEY_SCOPE_DENIED",
                "gateway key scope does not allow this request",
                record.Id,
                record.TenantId,
                record.TeamId,
                ClientCode: ResolveClientCode(record),
                Environment: ResolveEnvironment(record),
                KeyPrefixSnapshot: record.KeyPrefix);
        }

        if (record.AllowedCidrs.Count > 0
            && (remoteIp is null || !record.AllowedCidrs.Any(cidr => ContainsAddress(cidr, remoteIp))))
        {
            await WriteKeyDeniedAuditAsync(record, "service_key.source_ip_denied", "source-ip-denied", new MongoDB.Bson.BsonDocument
            {
                { "remoteIp", remoteIp?.ToString() ?? string.Empty },
            }, ct);
            return new(
                false,
                true,
                403,
                "GATEWAY_KEY_SOURCE_IP_DENIED",
                "gateway key does not allow this source IP",
                record.Id,
                record.TenantId,
                record.TeamId,
                ClientCode: ResolveClientCode(record),
                Environment: ResolveEnvironment(record),
                KeyPrefixSnapshot: record.KeyPrefix);
        }

        if (record.RateLimitPerMinute is > 0)
        {
            var now = DateTime.UtcNow;
            var windowStart = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, DateTimeKind.Utc);
            var windows = _data.Database.GetCollection<GatewayServiceKeyRateWindowRecord>("llmgw_service_key_rate_windows");
            var filter = Builders<GatewayServiceKeyRateWindowRecord>.Filter.And(
                Builders<GatewayServiceKeyRateWindowRecord>.Filter.Eq(x => x.TenantId, record.TenantId),
                Builders<GatewayServiceKeyRateWindowRecord>.Filter.Eq(x => x.ServiceKeyId, record.Id),
                Builders<GatewayServiceKeyRateWindowRecord>.Filter.Eq(x => x.WindowStart, windowStart));
            var update = Builders<GatewayServiceKeyRateWindowRecord>.Update
                .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
                .SetOnInsert(x => x.TenantId, record.TenantId)
                .SetOnInsert(x => x.ServiceKeyId, record.Id)
                .SetOnInsert(x => x.WindowStart, windowStart)
                .SetOnInsert(x => x.ExpiresAt, windowStart.AddMinutes(2))
                .Inc(x => x.Count, 1);
            GatewayServiceKeyRateWindowRecord window;
            try
            {
                window = await windows.FindOneAndUpdateAsync(
                    filter,
                    update,
                    new FindOneAndUpdateOptions<GatewayServiceKeyRateWindowRecord>
                    {
                        IsUpsert = true,
                        ReturnDocument = ReturnDocument.After,
                    },
                    ct);
            }
            catch (MongoException ex) when (IsDuplicateKey(ex))
            {
                // 同一分钟的首批并发请求可能同时观察到窗口不存在；唯一索引只允许一个 upsert 成功。
                // 竞争者改为非 upsert 原子递增，不能把正常限流请求放大成 500。
                window = await windows.FindOneAndUpdateAsync(
                    filter,
                    update,
                    new FindOneAndUpdateOptions<GatewayServiceKeyRateWindowRecord>
                    {
                        IsUpsert = false,
                        ReturnDocument = ReturnDocument.After,
                    },
                    ct) ?? throw new InvalidOperationException("service key rate window disappeared after duplicate upsert");
            }
            if (window.Count > record.RateLimitPerMinute.Value)
            {
                await WriteKeyDeniedAuditAsync(record, "service_key.rate_limited", "rate-limited", new MongoDB.Bson.BsonDocument
                {
                    { "windowStart", windowStart },
                    { "count", window.Count },
                    { "limit", record.RateLimitPerMinute.Value },
                }, ct);
                return new(
                    false,
                    true,
                    429,
                    "GATEWAY_KEY_RATE_LIMITED",
                    "gateway key per-minute rate limit exceeded",
                    record.Id,
                    record.TenantId,
                    record.TeamId,
                    ClientCode: ResolveClientCode(record),
                    Environment: ResolveEnvironment(record),
                    KeyPrefixSnapshot: record.KeyPrefix);
            }
        }

        _ = keys.UpdateOneAsync(
            Builders<GatewayServiceKeyRecord>.Filter.And(
                Builders<GatewayServiceKeyRecord>.Filter.Eq(x => x.TenantId, record.TenantId),
                Builders<GatewayServiceKeyRecord>.Filter.Eq(x => x.Id, record.Id)),
            Builders<GatewayServiceKeyRecord>.Update.Set(x => x.LastUsedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        // 退场判断只接受真实 invoke/stream/raw 业务调用。route、readiness、请求查询、
        // 取消与任何 preflight 都只能证明控制面可用，不能证明业务流量已经切换。
        if (GatewaySuccessorObservationPolicy.IsBusinessInvocationScope(serviceKeyScope))
            await RecordSuccessorObservationAsync(record, effectiveAppCallerCode, ingressProtocol, ct);
        return new(
            true,
            true,
            200,
            string.Empty,
            "scoped key",
            record.Id,
            record.TenantId,
            record.TeamId,
            ClientCode: ResolveClientCode(record),
            Environment: ResolveEnvironment(record),
            KeyPrefixSnapshot: record.KeyPrefix,
            ResolvedAppCallerCode: effectiveAppCallerCode);
    }

    private static string? ResolveSingleAppCallerCode(GatewayServiceKeyRecord record)
    {
        var normalizedCallers = record.AppCallerCodes
            .Select(x => x.Trim())
            .Where(x => x.Length > 0)
            .ToList();
        if (normalizedCallers.Any(x => x == "*"))
            return null;

        var callers = normalizedCallers
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        return callers.Count == 1 ? callers[0] : null;
    }

    private async Task<GatewayKeyAuthorization> AuthorizeLegacyKeyAsync(
        string sourceSystem,
        string appCallerCode,
        string ingressProtocol,
        string requiredScope,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var cutover = await _data.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .Find(x => x.TenantId == _internalTenantId)
            .FirstOrDefaultAsync(ct);
        var readOnlyProbe = GatewayLegacyProbeScopes.IsReadOnlyProbe(requiredScope);
        var normalizedSource = readOnlyProbe ? "map" : sourceSystem.Trim().ToLowerInvariant();
        var normalizedCaller = readOnlyProbe
            ? GatewayLegacyProbeScopes.ResolveAuditCaller(requiredScope)
            : appCallerCode.Trim();
        var normalizedProtocol = ingressProtocol.Trim().ToLowerInvariant();
        var externalDenied = !readOnlyProbe && !string.Equals(normalizedSource, "map", StringComparison.Ordinal);
        var callerMissing = !readOnlyProbe && string.IsNullOrWhiteSpace(normalizedCaller);
        var callerDenied = !readOnlyProbe
                           && cutover?.AllowedAppCallerCodes.Count > 0
                           && !cutover.AllowedAppCallerCodes.Contains(normalizedCaller, StringComparer.OrdinalIgnoreCase);
        var deadlineReached = cutover?.DeadlineAt is not null && cutover.DeadlineAt <= now;
        var revoked = string.Equals(cutover?.Status, "revoked", StringComparison.OrdinalIgnoreCase);
        var allowed = !externalDenied && !callerMissing && !callerDenied && !deadlineReached && !revoked;
        var decision = externalDenied ? "external-forbidden"
            : callerMissing ? "app-caller-required"
            : callerDenied ? "app-caller-not-in-inventory"
            : deadlineReached ? "deadline-reached"
            : revoked ? "revoked"
            : readOnlyProbe ? "read-only-preflight-allowed"
            : "allowed";
        await RecordLegacyUsageAsync(normalizedSource, normalizedCaller, normalizedProtocol, allowed, decision, now, ct);

        if (allowed)
        {
            return new(
                true, true, 200, string.Empty, "legacy MAP shared key",
                KeyId: "legacy-map-shared",
                TenantId: _internalTenantId,
                LegacySharedKey: true,
                ClientCode: "map-internal",
                Environment: "production",
                KeyPrefixSnapshot: "internal");
        }

        return new(
            false,
            true,
            externalDenied || callerMissing || callerDenied ? 403 : 401,
            externalDenied ? "GATEWAY_LEGACY_KEY_EXTERNAL_FORBIDDEN"
                : callerMissing ? "GATEWAY_LEGACY_KEY_APP_CALLER_REQUIRED"
                : callerDenied ? "GATEWAY_LEGACY_KEY_APP_CALLER_DENIED"
                : "GATEWAY_LEGACY_KEY_REVOKED",
            decision,
            KeyId: "legacy-map-shared",
            TenantId: _internalTenantId,
            LegacySharedKey: true,
            ClientCode: "map-internal",
            Environment: "production",
            KeyPrefixSnapshot: "internal");
    }

    private async Task RecordLegacyUsageAsync(
        string sourceSystem,
        string appCallerCode,
        string ingressProtocol,
        bool allowed,
        string decision,
        DateTime now,
        CancellationToken ct)
    {
        var collection = _data.Database.GetCollection<GatewayLegacyKeyUsageRecord>("llmgw_legacy_key_usage");
        var filter = Builders<GatewayLegacyKeyUsageRecord>.Filter.And(
            Builders<GatewayLegacyKeyUsageRecord>.Filter.Eq(x => x.TenantId, _internalTenantId),
            Builders<GatewayLegacyKeyUsageRecord>.Filter.Eq(x => x.SourceSystem, sourceSystem),
            Builders<GatewayLegacyKeyUsageRecord>.Filter.Eq(x => x.AppCallerCode, appCallerCode),
            Builders<GatewayLegacyKeyUsageRecord>.Filter.Eq(x => x.IngressProtocol, ingressProtocol));
        var update = Builders<GatewayLegacyKeyUsageRecord>.Update
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.TenantId, _internalTenantId)
            .SetOnInsert(x => x.SourceSystem, sourceSystem)
            .SetOnInsert(x => x.AppCallerCode, appCallerCode)
            .SetOnInsert(x => x.IngressProtocol, ingressProtocol)
            .SetOnInsert(x => x.FirstSeenAt, now)
            .Set(x => x.LastSeenAt, now)
            .Set(x => x.LastDecision, decision)
            .Inc(x => x.TotalCount, 1)
            .Inc(x => x.AllowedCount, allowed ? 1 : 0)
            .Inc(x => x.RejectedCount, allowed ? 0 : 1);
        try
        {
            await collection.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = true }, ct);
        }
        catch (MongoException ex) when (IsDuplicateKey(ex))
        {
            await collection.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = false }, ct);
        }
    }

    private Task RecordSuccessorObservationAsync(
        GatewayServiceKeyRecord record,
        string appCallerCode,
        string ingressProtocol,
        CancellationToken ct)
    {
        if (!string.Equals(record.Environment, "production", StringComparison.OrdinalIgnoreCase)
            || GatewayKeyPurposePolicy.ResolveEffectivePurpose(record) != "runtime")
            return Task.CompletedTask;

        var normalizedCaller = appCallerCode.Trim();
        var normalizedProtocol = ingressProtocol.Trim().ToLowerInvariant();
        var callerPattern = new BsonRegularExpression($"^(?:{Regex.Escape(normalizedCaller)}|\\*)$", "i");
        var protocolPattern = new BsonRegularExpression($"^(?:{Regex.Escape(normalizedProtocol)}|\\*)$", "i");

        return _data.Database.GetCollection<BsonDocument>("llmgw_legacy_key_cutovers").UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", record.TenantId),
                Builders<BsonDocument>.Filter.AnyEq("SuccessorServiceKeyIds", record.Id),
                Builders<BsonDocument>.Filter.Regex("AllowedAppCallerCodes", callerPattern),
                Builders<BsonDocument>.Filter.Regex("RequiredIngressProtocols", protocolPattern),
                Builders<BsonDocument>.Filter.Ne("Status", "revoked")),
            Builders<BsonDocument>.Update
                .Inc("SuccessorObservedCount", 1)
                .Inc($"SuccessorObservationCounts.{record.Id}", 1)
                .Set("LastSuccessorUsedAt", DateTime.UtcNow),
            cancellationToken: ct);
    }

    public static string Sha256Hex(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static bool FixedTimeEquals(string left, string right)
    {
        var a = SHA256.HashData(Encoding.UTF8.GetBytes(left));
        var b = SHA256.HashData(Encoding.UTF8.GetBytes(right));
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static bool Matches(string configured, string actual)
        => !string.IsNullOrWhiteSpace(configured)
           && (configured.Trim() == "*"
               || string.Equals(configured.Trim(), actual.Trim(), StringComparison.OrdinalIgnoreCase));

    private static bool MatchesAny(IEnumerable<string>? configured, string actual)
    {
        var values = configured?.Where(x => !string.IsNullOrWhiteSpace(x)).ToList() ?? [];
        return values.Count > 0 && values.Any(x => Matches(x, actual));
    }

    private static bool ContainsAddress(string cidr, IPAddress address)
    {
        if (!IPNetwork.TryParse(cidr, out var network)) return false;
        var normalizedAddress = address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
        return network.Contains(normalizedAddress);
    }

    private static bool IsDuplicateKey(MongoException exception)
        => exception is MongoCommandException { Code: 11000 or 11001 }
           || exception is MongoWriteException { WriteError.Category: ServerErrorCategory.DuplicateKey };

    private async Task<GatewayKeyAuthorization?> CheckLifecycleAsync(
        GatewayServiceKeyRecord record,
        string appCallerCode,
        CancellationToken ct)
    {
        var tenantFilter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", record.TenantId),
            Builders<BsonDocument>.Filter.Eq("Status", "active"));
        if (await _data.Database.GetCollection<BsonDocument>("llmgw_tenants")
                .CountDocumentsAsync(tenantFilter, cancellationToken: ct) != 1)
        {
            return await RejectLifecycleAsync(
                record,
                "service_key.tenant_inactive",
                "tenant-inactive",
                "GATEWAY_KEY_TENANT_INACTIVE",
                "service key tenant is not active",
                ct);
        }

        if (!string.IsNullOrWhiteSpace(record.CreatedByUserId))
        {
            var membershipFilter = Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", record.TenantId),
                Builders<BsonDocument>.Filter.Eq("UserId", record.CreatedByUserId),
                Builders<BsonDocument>.Filter.Eq("Status", "active"));
            var membership = await _data.Database.GetCollection<BsonDocument>("llmgw_memberships")
                .Find(membershipFilter)
                .Project(Builders<BsonDocument>.Projection.Include("Role").Include("TeamIds"))
                .FirstOrDefaultAsync(ct);
            if (membership is null)
            {
                return await RejectLifecycleAsync(
                    record,
                    "service_key.owner_inactive",
                    "owner-membership-inactive",
                    "GATEWAY_KEY_OWNER_INACTIVE",
                    "service key owner membership is not active",
                    ct);
            }

            var role = membership.TryGetValue("Role", out var roleValue) && roleValue.IsString
                ? roleValue.AsString.Trim().ToLowerInvariant()
                : null;
            if (role is not ("owner" or "admin" or "developer"))
            {
                return await RejectLifecycleAsync(
                    record,
                    "service_key.owner_role_denied",
                    "owner-role-denied",
                    "GATEWAY_KEY_OWNER_ROLE_DENIED",
                    "service key owner role no longer allows key usage",
                    ct);
            }

            if (role == "developer")
            {
                if (string.IsNullOrWhiteSpace(record.TeamId))
                {
                    return await RejectLifecycleAsync(
                        record,
                        "service_key.owner_team_required",
                        "owner-team-required",
                        "GATEWAY_KEY_OWNER_TEAM_REQUIRED",
                        "developer service key must be bound to a team",
                        ct);
                }

                var activeTeamIds = membership.TryGetValue("TeamIds", out var teamIdsValue) && teamIdsValue.IsBsonArray
                    ? teamIdsValue.AsBsonArray
                        .Where(x => x.IsString)
                        .Select(x => x.AsString)
                    : Enumerable.Empty<string>();
                if (!activeTeamIds.Contains(record.TeamId, StringComparer.Ordinal))
                {
                    return await RejectLifecycleAsync(
                        record,
                        "service_key.owner_team_denied",
                        "owner-team-denied",
                        "GATEWAY_KEY_OWNER_TEAM_DENIED",
                        "service key owner no longer belongs to this team",
                        ct);
                }
            }
        }

        if (string.IsNullOrWhiteSpace(record.TeamId))
            return null;

        var teamFilter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", record.TeamId),
            Builders<BsonDocument>.Filter.Eq("TenantId", record.TenantId),
            Builders<BsonDocument>.Filter.Eq("Status", "active"));
        if (await _data.Database.GetCollection<BsonDocument>("llmgw_teams")
                .CountDocumentsAsync(teamFilter, cancellationToken: ct) != 1)
        {
            return await RejectLifecycleAsync(
                record,
                "service_key.team_inactive",
                "team-inactive",
                "GATEWAY_KEY_TEAM_INACTIVE",
                "service key team is not active",
                ct);
        }

        var normalizedAppCallerCode = GatewayAppCallerIdentity.NormalizePart(appCallerCode);
        var callers = await _data.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers")
            .Find(Builders<GatewayAppCallerRecord>.Filter.And(
                    Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.TenantId, record.TenantId),
                    Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.AppCallerCode, normalizedAppCallerCode)),
                new FindOptions { Collation = GatewayAppCallerIdentity.Collation })
            .ToListAsync(ct);
        if (callers.Count > 0
            && callers.Any(x => !string.Equals(x.TeamId, record.TeamId, StringComparison.Ordinal)))
        {
            return await RejectLifecycleAsync(
                record,
                "service_key.app_caller_team_denied",
                "app-caller-team-mismatch",
                "GATEWAY_KEY_TEAM_MISMATCH",
                "service key team does not own this appCaller",
                ct);
        }

        return null;
    }

    private async Task<GatewayKeyAuthorization> RejectLifecycleAsync(
        GatewayServiceKeyRecord record,
        string action,
        string reason,
        string errorCode,
        string detail,
        CancellationToken ct)
    {
        await WriteKeyDeniedAuditAsync(record, action, reason, new BsonDocument
        {
            { "createdByUserId", record.CreatedByUserId },
        }, ct);
        return new(
            false,
            true,
            403,
            errorCode,
            detail,
            record.Id,
            record.TenantId,
            record.TeamId,
            ClientCode: ResolveClientCode(record),
            Environment: ResolveEnvironment(record),
            KeyPrefixSnapshot: record.KeyPrefix);
    }

    private static string ResolveClientCode(GatewayServiceKeyRecord record)
        => string.IsNullOrWhiteSpace(record.ClientCode) ? record.SourceSystem : record.ClientCode.Trim();

    private static string ResolveEnvironment(GatewayServiceKeyRecord record)
        => string.IsNullOrWhiteSpace(record.Environment) ? "unknown" : record.Environment.Trim().ToLowerInvariant();

    private Task WriteKeyDeniedAuditAsync(
        GatewayServiceKeyRecord record,
        string action,
        string reason,
        MongoDB.Bson.BsonDocument changes,
        CancellationToken ct)
        => _data.Database.GetCollection<MongoDB.Bson.BsonDocument>("llmgw_operation_audits").InsertOneAsync(
            new MongoDB.Bson.BsonDocument
            {
                { "_id", Guid.NewGuid().ToString("N") },
                { "TenantId", record.TenantId },
                { "TeamId", string.IsNullOrWhiteSpace(record.TeamId) ? MongoDB.Bson.BsonNull.Value : record.TeamId },
                { "Action", action },
                { "TargetType", "llmgw_service_key" },
                { "TargetId", record.Id },
                { "TargetName", record.Name },
                { "Success", false },
                { "Reason", reason },
                { "Changes", changes },
                { "CreatedAt", DateTime.UtcNow },
            }, cancellationToken: ct);
}

public sealed record GatewayBudgetLease(string TenantId, string ReservationId, decimal ReservedUsd);

public sealed record GatewayBudgetAdmission(
    bool Allowed,
    string ErrorCode,
    decimal BudgetUsd,
    decimal ReservedAndSpentUsd,
    GatewayBudgetLease? Lease)
{
    public static GatewayBudgetAdmission Allow(decimal budget = 0, decimal used = 0, GatewayBudgetLease? lease = null)
        => new(true, string.Empty, budget, used, lease);

    public static GatewayBudgetAdmission Reject(string code, decimal budget, decimal used)
        => new(false, code, budget, used, null);
}

public sealed class GatewayBudgetCoordinator
{
    public const string HttpContextLeaseKey = "llmgw.budget.lease";
    public const string HttpContextOutcomeUnknownKey = "llmgw.budget.outcome-unknown";
    private readonly LlmGatewayDataContext _data;
    private readonly ILogger<GatewayBudgetCoordinator> _logger;

    public GatewayBudgetCoordinator(LlmGatewayDataContext data, ILogger<GatewayBudgetCoordinator> logger)
    {
        _data = data;
        _logger = logger;
    }

    public async Task<GatewayBudgetAdmission> ReserveAsync(
        GatewayAppCallerRecord caller,
        string requestId,
        CancellationToken ct)
    {
        if (caller.MonthlyBudgetUsd is null or <= 0)
            return GatewayBudgetAdmission.Allow();

        if (caller.BudgetReservationUsd is null or <= 0)
            return GatewayBudgetAdmission.Reject("APP_CALLER_BUDGET_RESERVATION_UNCONFIGURED", caller.MonthlyBudgetUsd.Value, 0);

        var budget = caller.MonthlyBudgetUsd.Value;
        var amount = caller.BudgetReservationUsd.Value;
        if (amount > budget)
            return GatewayBudgetAdmission.Reject("APP_CALLER_BUDGET_RESERVATION_EXCEEDS_MONTHLY", budget, 0);

        var now = DateTime.UtcNow;
        var monthStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var reservations = _data.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
        var reservation = new GatewayBudgetReservationRecord
        {
            TenantId = caller.TenantId,
            AppCallerCode = caller.AppCallerCode,
            RequestType = caller.RequestType,
            RequestId = requestId,
            MonthStart = monthStart,
            ReservedUsd = amount,
            Status = "pending",
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = now.AddHours(24),
        };
        try
        {
            await reservations.InsertOneAsync(reservation, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            var existing = await reservations.Find(x =>
                    x.TenantId == caller.TenantId
                    && x.AppCallerCode == caller.AppCallerCode
                    && x.RequestType == caller.RequestType
                    && x.RequestId == requestId)
                .FirstOrDefaultAsync(ct);
            return GatewayBudgetAdmission.Reject(
                existing?.Status == "settled" ? "GATEWAY_REQUEST_ALREADY_SETTLED" : "GATEWAY_REQUEST_IN_PROGRESS",
                budget,
                existing?.ReservedUsd ?? 0);
        }

        var months = _data.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months");
        var identity = Builders<GatewayBudgetMonthRecord>.Filter.And(
            Builders<GatewayBudgetMonthRecord>.Filter.Eq(x => x.TenantId, caller.TenantId),
            Builders<GatewayBudgetMonthRecord>.Filter.Eq(x => x.AppCallerCode, caller.AppCallerCode),
            Builders<GatewayBudgetMonthRecord>.Filter.Eq(x => x.RequestType, caller.RequestType),
            Builders<GatewayBudgetMonthRecord>.Filter.Eq(x => x.MonthStart, monthStart));
        FilterDefinition<GatewayBudgetMonthRecord> withinBudget = new MongoDB.Driver.BsonDocumentFilterDefinition<GatewayBudgetMonthRecord>(
            new MongoDB.Bson.BsonDocument("$expr", new MongoDB.Bson.BsonDocument("$lte", new MongoDB.Bson.BsonArray
            {
                new MongoDB.Bson.BsonDocument("$add", new MongoDB.Bson.BsonArray { "$ReservedUsd", "$SpentUsd", amount }),
                budget,
            })));

        async Task<GatewayBudgetMonthRecord?> TryReserveMonthAsync()
            => await months.FindOneAndUpdateAsync(
                identity & withinBudget,
                Builders<GatewayBudgetMonthRecord>.Update
                    .Set(x => x.BudgetUsd, budget)
                    .Set(x => x.UpdatedAt, now)
                    .Inc(x => x.ReservedUsd, amount),
                new FindOneAndUpdateOptions<GatewayBudgetMonthRecord>
                {
                    IsUpsert = false,
                    ReturnDocument = ReturnDocument.After,
                },
                ct);

        GatewayBudgetMonthRecord? updated;
        try
        {
            await months.UpdateOneAsync(
                identity,
                Builders<GatewayBudgetMonthRecord>.Update
                    .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
                    .SetOnInsert(x => x.TenantId, caller.TenantId)
                    .SetOnInsert(x => x.AppCallerCode, caller.AppCallerCode)
                    .SetOnInsert(x => x.RequestType, caller.RequestType)
                    .SetOnInsert(x => x.MonthStart, monthStart)
                    .SetOnInsert(x => x.SpentUsd, 0)
                    .SetOnInsert(x => x.ReservedUsd, 0)
                    .Set(x => x.BudgetUsd, budget)
                    .Set(x => x.UpdatedAt, now),
                new UpdateOptions { IsUpsert = true },
                ct);
            updated = await TryReserveMonthAsync();
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 两个请求可能同时在月初创建同一条月份记录。唯一索引只允许一个 upsert
            // 获胜；失败方必须在已存在记录上重试原子预占，不能误报预算耗尽。
            updated = await TryReserveMonthAsync();
        }

        if (updated == null)
        {
            await reservations.UpdateOneAsync(
                x => x.TenantId == caller.TenantId && x.Id == reservation.Id && x.Status == "pending",
                Builders<GatewayBudgetReservationRecord>.Update
                    .Set(x => x.Status, "rejected")
                    .Set(x => x.Detail, "monthly-budget-exceeded")
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            var current = await months.Find(identity).FirstOrDefaultAsync(ct);
            return GatewayBudgetAdmission.Reject("APP_CALLER_MONTHLY_BUDGET_EXCEEDED", budget, (current?.ReservedUsd ?? 0) + (current?.SpentUsd ?? 0));
        }

        await reservations.UpdateOneAsync(
            x => x.TenantId == caller.TenantId && x.Id == reservation.Id && x.Status == "pending",
            Builders<GatewayBudgetReservationRecord>.Update
                .Set(x => x.Status, "reserved")
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        return GatewayBudgetAdmission.Allow(budget, updated.ReservedUsd + updated.SpentUsd, new GatewayBudgetLease(caller.TenantId, reservation.Id, amount));
    }

    public async Task FinalizeAsync(
        GatewayBudgetLease lease,
        int responseStatusCode,
        bool pipelineThrew,
        bool outcomeUnknown = false)
    {
        try
        {
            if (outcomeUnknown || pipelineThrew || responseStatusCode >= 500)
            {
                await SetReservationStatusAsync(lease.TenantId, lease.ReservationId, "unknown", "upstream-outcome-unknown", adjustMonth: false, settle: false, CancellationToken.None);
                return;
            }

            if (responseStatusCode >= 400)
            {
                await SetReservationStatusAsync(lease.TenantId, lease.ReservationId, "released", "request-rejected-before-success", adjustMonth: true, settle: false, CancellationToken.None);
                return;
            }

            await SetReservationStatusAsync(lease.TenantId, lease.ReservationId, "settled", "conservative-reservation-settlement", adjustMonth: true, settle: true, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[GatewayBudget] finalize failed reservation={ReservationId}; reservation remains fail-closed", lease.ReservationId);
        }
    }

    public async Task ReleaseExpiredAsync(CancellationToken ct)
    {
        var reservations = _data.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
        var tenantIds = await reservations.Distinct<string>(
            "TenantId",
            Builders<GatewayBudgetReservationRecord>.Filter.Ne(x => x.TenantId, "")).ToListAsync(ct);
        foreach (var tenantId in tenantIds)
        {
            var expired = await reservations.Find(x =>
                    x.TenantId == tenantId
                    && (x.Status == "pending" || x.Status == "reserved" || x.Status == "unknown")
                    && x.ExpiresAt <= DateTime.UtcNow)
                .Limit(500)
                .ToListAsync(ct);
            foreach (var item in expired)
            {
                var outcomeUnknown = item.Status == "unknown";
                await SetReservationStatusAsync(
                    tenantId,
                    item.Id,
                    outcomeUnknown ? "settled-unknown-expired" : "released-expired",
                    outcomeUnknown ? "unknown-outcome-conservative-settlement" : "reservation-expired",
                    adjustMonth: item.Status != "pending",
                    settle: outcomeUnknown,
                    ct);
            }
        }
    }

    private async Task SetReservationStatusAsync(
        string tenantId,
        string reservationId,
        string targetStatus,
        string detail,
        bool adjustMonth,
        bool settle,
        CancellationToken ct)
    {
        var reservations = _data.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
        var current = await reservations.FindOneAndUpdateAsync(
            Builders<GatewayBudgetReservationRecord>.Filter.And(
                Builders<GatewayBudgetReservationRecord>.Filter.Eq(x => x.TenantId, tenantId),
                Builders<GatewayBudgetReservationRecord>.Filter.Eq(x => x.Id, reservationId),
                Builders<GatewayBudgetReservationRecord>.Filter.In(x => x.Status, new[] { "pending", "reserved", "unknown" })),
            Builders<GatewayBudgetReservationRecord>.Update
                .Set(x => x.Status, targetStatus)
                .Set(x => x.Detail, detail)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<GatewayBudgetReservationRecord> { ReturnDocument = ReturnDocument.Before },
            ct);
        if (current == null || !adjustMonth) return;

        if (settle)
        {
            await reservations.UpdateOneAsync(
                x => x.TenantId == current.TenantId && x.Id == current.Id,
                Builders<GatewayBudgetReservationRecord>.Update.Set(x => x.SettledUsd, current.ReservedUsd),
                cancellationToken: ct);
        }

        var months = _data.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months");
        var update = Builders<GatewayBudgetMonthRecord>.Update
            .Inc(x => x.ReservedUsd, -current.ReservedUsd)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (settle) update = update.Inc(x => x.SpentUsd, current.ReservedUsd);
        await months.UpdateOneAsync(x =>
            x.TenantId == current.TenantId
            && x.AppCallerCode == current.AppCallerCode
            && x.RequestType == current.RequestType
            && x.MonthStart == current.MonthStart, update, cancellationToken: ct);
    }
}

public enum GatewayExecutionBeginState
{
    Started,
    Replay,
    ReplayUnavailable,
    Running,
    Unknown,
    Failed,
    Conflict,
}

public sealed record GatewayExecutionBeginResult(
    GatewayExecutionBeginState State,
    string ExecutionId,
    string? ResponseJson = null);

public sealed class GatewayRequestExecutionStore
{
    public const int MaxReplayResponseBytes = 8 * 1024 * 1024;
    private readonly LlmGatewayDataContext _data;
    private readonly ILogger<GatewayRequestExecutionStore>? _logger;

    public GatewayRequestExecutionStore(
        LlmGatewayDataContext data,
        ILogger<GatewayRequestExecutionStore>? logger = null)
    {
        _data = data;
        _logger = logger;
    }

    public async Task<GatewayExecutionBeginResult> BeginAsync(
        string tenantId,
        string appCallerCode,
        string requestId,
        string operation,
        string fingerprint,
        CancellationToken ct)
    {
        var records = _data.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions");
        var record = new GatewayRequestExecutionRecord
        {
            TenantId = tenantId,
            AppCallerCode = appCallerCode,
            RequestId = requestId,
            Operation = operation,
            Fingerprint = fingerprint,
            Status = "running",
        };
        try
        {
            await records.InsertOneAsync(record, cancellationToken: ct);
            return new(GatewayExecutionBeginState.Started, record.Id);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            var existing = await records.Find(x =>
                    x.TenantId == tenantId
                    && x.AppCallerCode == appCallerCode
                    && x.RequestId == requestId
                    && x.Operation == operation)
                .FirstAsync(ct);
            if (!string.Equals(existing.Fingerprint, fingerprint, StringComparison.Ordinal))
                return new(GatewayExecutionBeginState.Conflict, existing.Id);
            return existing.Status switch
            {
                "completed" when !string.IsNullOrWhiteSpace(existing.ResponseJson)
                    => new(GatewayExecutionBeginState.Replay, existing.Id, existing.ResponseJson),
                "completed-unreplayable" => new(GatewayExecutionBeginState.ReplayUnavailable, existing.Id),
                "unknown" => new(GatewayExecutionBeginState.Unknown, existing.Id),
                "failed" => new(GatewayExecutionBeginState.Failed, existing.Id),
                _ => new(GatewayExecutionBeginState.Running, existing.Id),
            };
        }
    }

    public async Task CompleteAsync(string tenantId, string executionId, string responseJson, CancellationToken ct)
    {
        var responseTooLarge = Encoding.UTF8.GetByteCount(responseJson) > MaxReplayResponseBytes;

        try
        {
            if (responseTooLarge)
                await MarkReplayUnavailableAsync(tenantId, executionId, "GATEWAY_REPLAY_RESPONSE_TOO_LARGE", ct);
            else
                await UpdateAsync(tenantId, executionId, "completed", responseJson, null, ct);
        }
        catch (MongoException ex)
        {
            // 幂等快照是辅助能力。上游已经成功后，Mongo 单文档限制或暂时写失败不能
            // 反转用户响应；记录为不可重放并对后续同 requestId 保持 fail-closed。
            _logger?.LogWarning(ex, "[GatewayIdempotency] replay snapshot unavailable execution={ExecutionId}", executionId);
            if (!responseTooLarge)
            {
                try
                {
                    await MarkReplayUnavailableAsync(tenantId, executionId, "GATEWAY_REPLAY_SNAPSHOT_UNAVAILABLE", CancellationToken.None);
                }
                catch (Exception fallbackEx)
                {
                    _logger?.LogError(fallbackEx, "[GatewayIdempotency] failed to persist replay-unavailable state execution={ExecutionId}", executionId);
                }
            }
        }
    }

    public Task UnknownAsync(string tenantId, string executionId, string errorCode, CancellationToken ct)
        => UpdateAsync(tenantId, executionId, "unknown", null, errorCode, ct);

    public Task FailAsync(string tenantId, string executionId, string errorCode, CancellationToken ct)
        => UpdateAsync(tenantId, executionId, "failed", null, errorCode, ct);

    public async Task<GatewayRequestExecutionRecord?> GetAsync(
        string tenantId,
        string appCallerCode,
        string requestId,
        string operation,
        CancellationToken ct)
    {
        GatewayRequestExecutionRecord? record = await _data.Database
            .GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions")
            .Find(x => x.TenantId == tenantId
                       && x.AppCallerCode == appCallerCode
                       && x.RequestId == requestId
                       && x.Operation == operation)
            .FirstOrDefaultAsync(ct);
        return record;
    }

    private async Task UpdateAsync(string tenantId, string id, string status, string? responseJson, string? errorCode, CancellationToken ct)
    {
        var records = _data.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions");
        await records.UpdateOneAsync(
            x => x.TenantId == tenantId && x.Id == id && x.Status == "running",
            Builders<GatewayRequestExecutionRecord>.Update
                .Set(x => x.Status, status)
                .Set(x => x.ResponseJson, responseJson)
                .Set(x => x.ErrorCode, errorCode)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }

    private Task MarkReplayUnavailableAsync(string tenantId, string executionId, string errorCode, CancellationToken ct)
        => UpdateAsync(tenantId, executionId, "completed-unreplayable", null, errorCode, ct);

    public static string Fingerprint(GatewayRawRequest request)
    {
        var multipartFiles = request.MultipartFiles?
            .OrderBy(x => x.Key, StringComparer.Ordinal)
            .Select(x =>
            {
                var content = x.Value.Content ?? Array.Empty<byte>();
                return new
                {
                    FieldName = x.Key,
                    x.Value.FileName,
                    x.Value.MimeType,
                    SizeBytes = content.LongLength,
                    Sha256 = Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(),
                };
            })
            .ToArray();
        var multipartRefs = request.MultipartFileRefs?
            .OrderBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => new
            {
                FieldName = x.Key,
                x.Value.RefKey,
                x.Value.FileName,
                x.Value.MimeType,
                x.Value.SizeBytes,
                x.Value.Sha256,
                x.Value.Url,
            })
            .ToArray();

        return Fingerprint(new
        {
            request.AppCallerCode,
            request.ModelType,
            request.EndpointPath,
            request.ExpectedModel,
            request.PinnedPlatformId,
            request.PinnedModelId,
            RequestBody = request.RequestBody?.ToJsonString(),
            request.IsMultipart,
            MultipartFields = request.MultipartFields?.OrderBy(x => x.Key, StringComparer.Ordinal).ToArray(),
            MultipartFiles = multipartFiles,
            MultipartFileRefs = multipartRefs,
            request.HttpMethod,
            ExtraHeaders = request.ExtraHeaders?.OrderBy(x => x.Key, StringComparer.Ordinal).ToArray(),
            request.TimeoutSeconds,
            request.ExpectBinaryResponse,
            request.Context,
        });
    }

    public static string Fingerprint<T>(T value)
        => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value))).ToLowerInvariant();
}

public sealed class GatewayCancellationRegistry
{
    private readonly ConcurrentDictionary<GatewayCancellationKey, CancellationTokenSource> _requests = new();

    public GatewayCancellationLease Register(string tenantId, string appCallerCode, string requestId)
    {
        var key = GatewayCancellationKey.Create(tenantId, appCallerCode, requestId);
        var cts = new CancellationTokenSource();
        if (!_requests.TryAdd(key, cts))
        {
            cts.Dispose();
            throw new InvalidOperationException($"requestId {requestId} is already running for appCaller {appCallerCode}");
        }
        return new GatewayCancellationLease(this, key, cts);
    }

    public bool Cancel(string tenantId, string appCallerCode, string requestId)
    {
        var key = GatewayCancellationKey.Create(tenantId, appCallerCode, requestId);
        return _requests.TryGetValue(key, out var cts) && Cancel(cts);
    }

    private static bool Cancel(CancellationTokenSource cts)
    {
        if (cts.IsCancellationRequested) return false;
        cts.Cancel();
        return true;
    }

    internal void Remove(GatewayCancellationKey key, CancellationTokenSource cts)
    {
        _requests.TryRemove(new KeyValuePair<GatewayCancellationKey, CancellationTokenSource>(key, cts));
        cts.Dispose();
    }
}

public readonly record struct GatewayCancellationKey(string TenantId, string AppCallerCode, string RequestId)
{
    public static GatewayCancellationKey Create(string tenantId, string appCallerCode, string requestId)
    {
        if (string.IsNullOrWhiteSpace(tenantId))
            throw new ArgumentException("tenantId is required", nameof(tenantId));
        if (string.IsNullOrWhiteSpace(appCallerCode))
            throw new ArgumentException("appCallerCode is required", nameof(appCallerCode));
        if (string.IsNullOrWhiteSpace(requestId))
            throw new ArgumentException("requestId is required", nameof(requestId));
        return new(tenantId.Trim(), appCallerCode.Trim().ToLowerInvariant(), requestId.Trim());
    }
}

public sealed class GatewayCancellationLease : IDisposable
{
    private readonly GatewayCancellationRegistry _owner;
    private readonly GatewayCancellationKey _key;
    private readonly CancellationTokenSource _cts;

    internal GatewayCancellationLease(GatewayCancellationRegistry owner, GatewayCancellationKey key, CancellationTokenSource cts)
    {
        _owner = owner;
        _key = key;
        _cts = cts;
    }

    public CancellationToken Token => _cts.Token;

    public void Dispose() => _owner.Remove(_key, _cts);
}

public sealed class GatewayDataLifecycleWorker : BackgroundService
{
    private readonly LlmGatewayDataContext _data;
    private readonly IAssetStorage _storage;
    private readonly GatewayBudgetCoordinator _budgets;
    private readonly LlmGatewayDatabaseInitializer _databaseInitializer;
    private readonly IConfiguration _configuration;
    private readonly ILogger<GatewayDataLifecycleWorker> _logger;

    public GatewayDataLifecycleWorker(
        LlmGatewayDataContext data,
        IAssetStorage storage,
        GatewayBudgetCoordinator budgets,
        LlmGatewayDatabaseInitializer databaseInitializer,
        IConfiguration configuration,
        ILogger<GatewayDataLifecycleWorker> logger)
    {
        _data = data;
        _storage = storage;
        _budgets = budgets;
        _databaseInitializer = databaseInitializer;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await RunSafeAsync(stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromHours(6));
        while (await timer.WaitForNextTickAsync(stoppingToken))
            await RunSafeAsync(stoppingToken);
    }

    private async Task RunSafeAsync(CancellationToken ct)
    {
        try { await RunOnceAsync(ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex) { _logger.LogError(ex, "[GatewayLifecycle] lifecycle pass failed; serving remains available"); }
    }

    private async Task RunOnceAsync(CancellationToken ct)
    {
        var internalTenantId = _configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } configuredTenantId
            ? configuredTenantId
            : GatewayTenantDefaults.InternalTenantId;
        var now = DateTime.UtcNow;
        var apply = _configuration.GetValue("LlmGateway:Retention:ApplyChanges", false);
        var sensitiveDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:SensitiveBodyDays", 7));
        var requestLogDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:RequestLogDays", 90));
        var shadowDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:ShadowDays", 30));
        var auditDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:AuditDays", 180));
        var logs = _data.Database.GetCollection<MongoDB.Bson.BsonDocument>("llmrequestlogs");
        var multipart = _data.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects");
        var indexStatus = await ReadRetentionIndexStatusAsync(ct);
        var lifecycle = _data.Database.GetCollection<GatewayLifecycleRunRecord>("llmgw_lifecycle_runs");
        var tenantIds = await ResolveLifecycleTenantIdsAsync(internalTenantId, ct);
        var passes = new List<(
            string TenantId,
            FilterDefinition<MongoDB.Bson.BsonDocument> SensitiveFilter,
            long SensitiveCount,
            IReadOnlyList<GatewayMultipartObjectRecord> ExpiredMultipart,
            long ExpiredMultipartCount,
            GatewayLifecycleRunRecord Run)>(tenantIds.Count);

        foreach (var tenantId in tenantIds)
        {
            var sensitiveFilter = Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("TenantId", tenantId)
                                  & Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("StartedAt", now.AddDays(-sensitiveDays))
                                  & Builders<MongoDB.Bson.BsonDocument>.Filter.Or(
                                      Builders<MongoDB.Bson.BsonDocument>.Filter.Ne("RequestBodyRedacted", ""),
                                      Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("QuestionText", true),
                                      Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("AnswerText", true),
                                      Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("ThinkingText", true));
            var sensitiveCount = await logs.CountDocumentsAsync(sensitiveFilter, cancellationToken: ct);
            var expiredFilter = Builders<GatewayMultipartObjectRecord>.Filter.Eq(x => x.TenantId, tenantId)
                                & Builders<GatewayMultipartObjectRecord>.Filter.Ne(x => x.Status, "deleted")
                                & Builders<GatewayMultipartObjectRecord>.Filter.Lte(x => x.ExpiresAt, now);
            var expiredMultipartCount = await multipart.CountDocumentsAsync(expiredFilter, cancellationToken: ct);
            var expired = await multipart.Find(expiredFilter).SortBy(x => x.ExpiresAt).Limit(200).ToListAsync(ct);
            var run = new GatewayLifecycleRunRecord
            {
                TenantId = tenantId,
                Mode = apply ? "apply" : "dry-run",
                Status = "dry-run-complete",
                StartedAt = now,
                DryRunCompletedAt = DateTime.UtcNow,
                SensitiveLogs = sensitiveCount,
                ExpiredRequestLogs = await CountExpiredAsync(tenantId, "llmrequestlogs", "StartedAt", now.AddDays(-requestLogDays), ct),
                ExpiredShadowComparisons = await CountExpiredAsync(tenantId, "llmshadow_comparisons", "ComparedAt", now.AddDays(-shadowDays), ct),
                ExpiredOperationAudits = await CountExpiredAsync(tenantId, "llmgw_operation_audits", "CreatedAt", now.AddDays(-auditDays), ct),
                ExpiredLoginAudits = await CountExpiredAsync(tenantId, "llmgw_login_audits", "CreatedAt", now.AddDays(-auditDays), ct),
                ExpiredMultipartObjects = expiredMultipartCount,
                OldestExpiredRequestLogAt = await OldestAsync(tenantId, "llmrequestlogs", "StartedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("StartedAt", now.AddDays(-requestLogDays)), ct),
                OldestSensitiveLogAt = await OldestAsync(tenantId, "llmrequestlogs", "StartedAt", sensitiveFilter, ct),
                OldestExpiredShadowAt = await OldestAsync(tenantId, "llmshadow_comparisons", "ComparedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("ComparedAt", now.AddDays(-shadowDays)), ct),
                OldestExpiredOperationAuditAt = await OldestAsync(tenantId, "llmgw_operation_audits", "CreatedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("CreatedAt", now.AddDays(-auditDays)), ct),
                OldestExpiredLoginAuditAt = await OldestAsync(tenantId, "llmgw_login_audits", "CreatedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("CreatedAt", now.AddDays(-auditDays)), ct),
                OldestExpiredMultipartAt = expired.FirstOrDefault()?.ExpiresAt,
                RetentionIndexesReady = indexStatus.Count == 0,
                MissingRetentionIndexes = indexStatus.ToArray(),
            };
            await lifecycle.InsertOneAsync(run, cancellationToken: ct);
            passes.Add((tenantId, sensitiveFilter, sensitiveCount, expired, expiredMultipartCount, run));
        }

        // Budget reservation expiry is runtime accounting, not data retention. It must run
        // even while destructive retention remains in dry-run mode.
        await _budgets.ReleaseExpiredAsync(ct);

        if (apply)
        {
            await _databaseInitializer.EnsureRetentionTtlIndexesAsync(ct);
            indexStatus = await ReadRetentionIndexStatusAsync(ct);
            foreach (var pass in passes)
            {
                await lifecycle.UpdateOneAsync(x => x.TenantId == pass.TenantId && x.Id == pass.Run.Id,
                    Builders<GatewayLifecycleRunRecord>.Update
                        .Set(x => x.RetentionIndexesReady, indexStatus.Count == 0)
                        .Set(x => x.MissingRetentionIndexes, indexStatus.ToArray()),
                    cancellationToken: ct);
            }
        }

        if (apply)
        {
            foreach (var pass in passes)
            {
                var redacted = pass.SensitiveCount > 0
                    ? (await logs.UpdateManyAsync(pass.SensitiveFilter,
                        Builders<MongoDB.Bson.BsonDocument>.Update
                            .Set("RequestBodyRedacted", "[retention-redacted]")
                            .Unset("QuestionText")
                            .Unset("AnswerText")
                            .Unset("ThinkingText")
                            .Unset("SystemPromptText")
                            .Unset("ResponseToolCalls"),
                        cancellationToken: ct)).ModifiedCount
                    : 0;
                long deleted = 0;
                foreach (var item in pass.ExpiredMultipart)
                {
                    try
                    {
                        await _storage.DeleteByKeyAsync(item.RefKey, ct);
                        await multipart.UpdateOneAsync(x => x.TenantId == pass.TenantId && x.Id == item.Id,
                            Builders<GatewayMultipartObjectRecord>.Update
                                .Set(x => x.Status, "deleted")
                                .Set(x => x.DeletedAt, DateTime.UtcNow)
                                .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
                        deleted++;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex,
                            "[GatewayLifecycle] multipart cleanup failed tenant={TenantId} ref={RefKey}",
                            pass.TenantId,
                            item.RefKey);
                    }
                }

                await lifecycle.UpdateOneAsync(x => x.TenantId == pass.TenantId && x.Id == pass.Run.Id,
                    Builders<GatewayLifecycleRunRecord>.Update
                        .Set(x => x.Status, "applied")
                        .Set(x => x.RedactedSensitiveLogs, redacted)
                        .Set(x => x.DeletedMultipartObjects, deleted)
                        .Set(x => x.CompletedAt, DateTime.UtcNow),
                    cancellationToken: ct);
            }
        }

        _logger.LogInformation(
            "[GatewayLifecycle] mode={Mode} tenants={TenantCount} sensitiveLogs={SensitiveLogs} expiredMultipart={ExpiredMultipart} indexesReady={IndexesReady} runIds={RunIds}",
            apply ? "apply" : "dry-run",
            passes.Count,
            passes.Sum(x => x.SensitiveCount),
            passes.Sum(x => x.ExpiredMultipartCount),
            indexStatus.Count == 0,
            string.Join(',', passes.Select(x => x.Run.Id)));
    }

    private async Task<List<string>> ResolveLifecycleTenantIdsAsync(string internalTenantId, CancellationToken ct)
    {
        var tenantIds = new HashSet<string>(StringComparer.Ordinal) { internalTenantId };
        var tenantSources = new (string CollectionName, string FieldName)[]
        {
            ("llmgw_tenants", "_id"),
            ("llmgw_app_callers", "TenantId"),
            ("llmgw_model_pools", "TenantId"),
            ("llmgw_platforms", "TenantId"),
            ("llmgw_models", "TenantId"),
            ("llmgw_model_exchanges", "TenantId"),
            ("llmgw_service_keys", "TenantId"),
            ("llmgw_service_key_rate_windows", "TenantId"),
            ("llmgw_prompt_policies", "TenantId"),
            ("llmrequestlogs", "TenantId"),
            ("llmshadow_comparisons", "TenantId"),
            ("llmgw_operation_audits", "TenantId"),
            ("llmgw_login_audits", "TenantId"),
            ("llmgw_lifecycle_runs", "TenantId"),
            ("llmgw_app_caller_rate_windows", "TenantId"),
            ("llmgw_budget_months", "TenantId"),
            ("llmgw_budget_reservations", "TenantId"),
            ("llmgw_request_executions", "TenantId"),
            ("llmgw_multipart_objects", "TenantId"),
            ("llmgw_provider_concurrency_slots", "TenantId"),
            ("llmgw_runtime_settings", "TenantId"),
            ("llmgw_asset_registry", "TenantId"),
        };
        foreach (var (collectionName, fieldName) in tenantSources)
        {
            var validTenant = Builders<MongoDB.Bson.BsonDocument>.Filter.And(
                Builders<MongoDB.Bson.BsonDocument>.Filter.Type(fieldName, MongoDB.Bson.BsonType.String),
                Builders<MongoDB.Bson.BsonDocument>.Filter.Ne(fieldName, ""));
            var values = await _data.Database.GetCollection<MongoDB.Bson.BsonDocument>(collectionName)
                .Distinct<string>(fieldName, validTenant)
                .ToListAsync(ct);
            foreach (var value in values.Where(x => !string.IsNullOrWhiteSpace(x)))
                tenantIds.Add(value.Trim());
        }
        return tenantIds.OrderBy(x => x, StringComparer.Ordinal).ToList();
    }

    private async Task<long> CountExpiredAsync(string tenantId, string collectionName, string field, DateTime cutoff, CancellationToken ct)
    {
        var collection = _data.Database.GetCollection<MongoDB.Bson.BsonDocument>(collectionName);
        return await collection.CountDocumentsAsync(
            Builders<MongoDB.Bson.BsonDocument>.Filter.And(
                Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("TenantId", tenantId),
                Builders<MongoDB.Bson.BsonDocument>.Filter.Lt(field, cutoff)), cancellationToken: ct);
    }

    private async Task<DateTime?> OldestAsync(
        string tenantId,
        string collectionName,
        string field,
        FilterDefinition<MongoDB.Bson.BsonDocument> filter,
        CancellationToken ct)
    {
        var document = await _data.Database.GetCollection<MongoDB.Bson.BsonDocument>(collectionName)
            .Find(Builders<MongoDB.Bson.BsonDocument>.Filter.And(
                Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("TenantId", tenantId),
                filter))
            .Sort(Builders<MongoDB.Bson.BsonDocument>.Sort.Ascending(field))
            .Project(Builders<MongoDB.Bson.BsonDocument>.Projection.Include(field).Exclude("_id"))
            .FirstOrDefaultAsync(ct);
        if (document is null || !document.TryGetValue(field, out var value) || !value.IsValidDateTime)
            return null;
        return value.ToUniversalTime();
    }

    private async Task<List<string>> ReadRetentionIndexStatusAsync(CancellationToken ct)
    {
        var expected = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["llmrequestlogs"] = ["ttl_llmgw_logs_started"],
            ["llmshadow_comparisons"] = ["ttl_llmgw_shadow_compared"],
            ["llmgw_operation_audits"] = ["ttl_llmgw_operation_audits"],
            ["llmgw_login_audits"] = ["ttl_llmgw_login_audits"],
            ["llmgw_lifecycle_runs"] = ["ttl_llmgw_lifecycle_runs"],
        };
        var missing = new List<string>();
        foreach (var (collectionName, names) in expected)
        {
            var indexes = await (await _data.Database.GetCollection<MongoDB.Bson.BsonDocument>(collectionName)
                .Indexes.ListAsync(ct)).ToListAsync(ct);
            var actual = indexes.Select(x => x.GetValue("name", "").AsString).ToHashSet(StringComparer.Ordinal);
            missing.AddRange(names.Where(name => !actual.Contains(name)).Select(name => $"{collectionName}/{name}"));
        }
        return missing;
    }
}
