using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
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
    bool LegacySharedKey = false);

public sealed class GatewayScopedKeyAuthorizer
{
    private readonly LlmGatewayDataContext _data;

    public GatewayScopedKeyAuthorizer(LlmGatewayDataContext data) => _data = data;

    public async Task<GatewayKeyAuthorization> AuthorizeAsync(
        string providedKey,
        string legacySharedKey,
        string sourceSystem,
        string appCallerCode,
        string ingressProtocol,
        string requiredScope,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(providedKey))
            return new(false, false, 401, "GATEWAY_KEY_REQUIRED", "missing gateway key");

        if (FixedTimeEquals(providedKey, legacySharedKey))
            return new(true, true, 200, string.Empty, "legacy MAP shared key", LegacySharedKey: true);

        var hash = Sha256Hex(providedKey);
        var keys = _data.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys");
        var record = await keys.Find(x => x.KeyHash == hash).FirstOrDefaultAsync(ct);
        if (record == null || !record.Enabled || record.ExpiresAt is not null && record.ExpiresAt <= DateTime.UtcNow)
            return new(false, false, 401, "GATEWAY_KEY_INVALID", "invalid or expired gateway key");

        if (!Matches(record.SourceSystem, sourceSystem)
            || !MatchesAny(record.AppCallerCodes, appCallerCode)
            || !MatchesAny(record.IngressProtocols, ingressProtocol)
            || !MatchesAny(record.Scopes, requiredScope))
        {
            await _data.Database.GetCollection<MongoDB.Bson.BsonDocument>("llmgw_operation_audits").InsertOneAsync(
                new MongoDB.Bson.BsonDocument
                {
                    { "_id", Guid.NewGuid().ToString("N") },
                    { "Action", "service_key.scope_denied" },
                    { "TargetType", "llmgw_service_key" },
                    { "TargetId", record.Id },
                    { "TargetName", record.Name },
                    { "Success", false },
                    { "Reason", "scope-mismatch" },
                    { "Changes", new MongoDB.Bson.BsonDocument
                        {
                            { "sourceSystem", sourceSystem },
                            { "appCallerCode", appCallerCode },
                            { "ingressProtocol", ingressProtocol },
                            { "requiredScope", requiredScope },
                        }
                    },
                    { "CreatedAt", DateTime.UtcNow },
                }, cancellationToken: ct);
            return new(false, true, 403, "GATEWAY_KEY_SCOPE_DENIED", "gateway key scope does not allow this request", record.Id);
        }

        _ = keys.UpdateOneAsync(
            Builders<GatewayServiceKeyRecord>.Filter.Eq(x => x.Id, record.Id),
            Builders<GatewayServiceKeyRecord>.Update.Set(x => x.LastUsedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        return new(true, true, 200, string.Empty, "scoped key", record.Id);
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
}

public sealed record GatewayBudgetLease(string ReservationId, decimal ReservedUsd);

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
                    x.AppCallerCode == caller.AppCallerCode
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
            Builders<GatewayBudgetMonthRecord>.Filter.Eq(x => x.AppCallerCode, caller.AppCallerCode),
            Builders<GatewayBudgetMonthRecord>.Filter.Eq(x => x.RequestType, caller.RequestType),
            Builders<GatewayBudgetMonthRecord>.Filter.Eq(x => x.MonthStart, monthStart));
        FilterDefinition<GatewayBudgetMonthRecord> withinBudget = new MongoDB.Driver.BsonDocumentFilterDefinition<GatewayBudgetMonthRecord>(
            new MongoDB.Bson.BsonDocument("$expr", new MongoDB.Bson.BsonDocument("$lte", new MongoDB.Bson.BsonArray
            {
                new MongoDB.Bson.BsonDocument("$add", new MongoDB.Bson.BsonArray { "$ReservedUsd", "$SpentUsd", amount }),
                budget,
            })));

        GatewayBudgetMonthRecord? updated;
        try
        {
            await months.UpdateOneAsync(
                identity,
                Builders<GatewayBudgetMonthRecord>.Update
                    .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
                    .SetOnInsert(x => x.AppCallerCode, caller.AppCallerCode)
                    .SetOnInsert(x => x.RequestType, caller.RequestType)
                    .SetOnInsert(x => x.MonthStart, monthStart)
                    .SetOnInsert(x => x.SpentUsd, 0)
                    .SetOnInsert(x => x.ReservedUsd, 0)
                    .Set(x => x.BudgetUsd, budget)
                    .Set(x => x.UpdatedAt, now),
                new UpdateOptions { IsUpsert = true },
                ct);
            updated = await months.FindOneAndUpdateAsync(
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
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            updated = null;
        }

        if (updated == null)
        {
            await reservations.UpdateOneAsync(
                x => x.Id == reservation.Id && x.Status == "pending",
                Builders<GatewayBudgetReservationRecord>.Update
                    .Set(x => x.Status, "rejected")
                    .Set(x => x.Detail, "monthly-budget-exceeded")
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            var current = await months.Find(identity).FirstOrDefaultAsync(ct);
            return GatewayBudgetAdmission.Reject("APP_CALLER_MONTHLY_BUDGET_EXCEEDED", budget, (current?.ReservedUsd ?? 0) + (current?.SpentUsd ?? 0));
        }

        await reservations.UpdateOneAsync(
            x => x.Id == reservation.Id && x.Status == "pending",
            Builders<GatewayBudgetReservationRecord>.Update
                .Set(x => x.Status, "reserved")
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        return GatewayBudgetAdmission.Allow(budget, updated.ReservedUsd + updated.SpentUsd, new GatewayBudgetLease(reservation.Id, amount));
    }

    public async Task FinalizeAsync(GatewayBudgetLease lease, int responseStatusCode, bool pipelineThrew)
    {
        try
        {
            if (pipelineThrew || responseStatusCode >= 500)
            {
                await SetReservationStatusAsync(lease.ReservationId, "unknown", "upstream-outcome-unknown", adjustMonth: false, settle: false, CancellationToken.None);
                return;
            }

            if (responseStatusCode >= 400)
            {
                await SetReservationStatusAsync(lease.ReservationId, "released", "request-rejected-before-success", adjustMonth: true, settle: false, CancellationToken.None);
                return;
            }

            await SetReservationStatusAsync(lease.ReservationId, "settled", "conservative-reservation-settlement", adjustMonth: true, settle: true, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[GatewayBudget] finalize failed reservation={ReservationId}; reservation remains fail-closed", lease.ReservationId);
        }
    }

    public async Task ReleaseExpiredAsync(CancellationToken ct)
    {
        var reservations = _data.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
        var expired = await reservations.Find(x =>
                (x.Status == "pending" || x.Status == "reserved" || x.Status == "unknown")
                && x.ExpiresAt <= DateTime.UtcNow)
            .Limit(500)
            .ToListAsync(ct);
        foreach (var item in expired)
            await SetReservationStatusAsync(
                item.Id,
                "released-expired",
                "reservation-expired",
                adjustMonth: item.Status != "pending",
                settle: false,
                ct);
    }

    private async Task SetReservationStatusAsync(
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
                x => x.Id == current.Id,
                Builders<GatewayBudgetReservationRecord>.Update.Set(x => x.SettledUsd, current.ReservedUsd),
                cancellationToken: ct);
        }

        var months = _data.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months");
        var update = Builders<GatewayBudgetMonthRecord>.Update
            .Inc(x => x.ReservedUsd, -current.ReservedUsd)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (settle) update = update.Inc(x => x.SpentUsd, current.ReservedUsd);
        await months.UpdateOneAsync(x =>
            x.AppCallerCode == current.AppCallerCode
            && x.RequestType == current.RequestType
            && x.MonthStart == current.MonthStart, update, cancellationToken: ct);
    }
}

public enum GatewayExecutionBeginState
{
    Started,
    Replay,
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
    private readonly LlmGatewayDataContext _data;

    public GatewayRequestExecutionStore(LlmGatewayDataContext data) => _data = data;

    public async Task<GatewayExecutionBeginResult> BeginAsync(
        string appCallerCode,
        string requestId,
        string operation,
        string fingerprint,
        CancellationToken ct)
    {
        var records = _data.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions");
        var record = new GatewayRequestExecutionRecord
        {
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
                    x.AppCallerCode == appCallerCode
                    && x.RequestId == requestId
                    && x.Operation == operation)
                .FirstAsync(ct);
            if (!string.Equals(existing.Fingerprint, fingerprint, StringComparison.Ordinal))
                return new(GatewayExecutionBeginState.Conflict, existing.Id);
            return existing.Status switch
            {
                "completed" when !string.IsNullOrWhiteSpace(existing.ResponseJson)
                    => new(GatewayExecutionBeginState.Replay, existing.Id, existing.ResponseJson),
                "unknown" => new(GatewayExecutionBeginState.Unknown, existing.Id),
                "failed" => new(GatewayExecutionBeginState.Failed, existing.Id),
                _ => new(GatewayExecutionBeginState.Running, existing.Id),
            };
        }
    }

    public Task CompleteAsync(string executionId, string responseJson, CancellationToken ct)
        => UpdateAsync(executionId, "completed", responseJson, null, ct);

    public Task UnknownAsync(string executionId, string errorCode, CancellationToken ct)
        => UpdateAsync(executionId, "unknown", null, errorCode, ct);

    public Task FailAsync(string executionId, string errorCode, CancellationToken ct)
        => UpdateAsync(executionId, "failed", null, errorCode, ct);

    public async Task<GatewayRequestExecutionRecord?> GetAsync(
        string appCallerCode,
        string requestId,
        string operation,
        CancellationToken ct)
    {
        GatewayRequestExecutionRecord? record = await _data.Database
            .GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions")
            .Find(x => x.AppCallerCode == appCallerCode
                       && x.RequestId == requestId
                       && x.Operation == operation)
            .FirstOrDefaultAsync(ct);
        return record;
    }

    private async Task UpdateAsync(string id, string status, string? responseJson, string? errorCode, CancellationToken ct)
    {
        var records = _data.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions");
        await records.UpdateOneAsync(
            x => x.Id == id && x.Status == "running",
            Builders<GatewayRequestExecutionRecord>.Update
                .Set(x => x.Status, status)
                .Set(x => x.ResponseJson, responseJson)
                .Set(x => x.ErrorCode, errorCode)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }

    public static string Fingerprint<T>(T value)
        => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value))).ToLowerInvariant();
}

public sealed class GatewayCancellationRegistry
{
    private readonly ConcurrentDictionary<GatewayCancellationKey, CancellationTokenSource> _requests = new();

    public GatewayCancellationLease Register(string appCallerCode, string requestId)
    {
        var key = GatewayCancellationKey.Create(appCallerCode, requestId);
        var cts = new CancellationTokenSource();
        if (!_requests.TryAdd(key, cts))
        {
            cts.Dispose();
            throw new InvalidOperationException($"requestId {requestId} is already running for appCaller {appCallerCode}");
        }
        return new GatewayCancellationLease(this, key, cts);
    }

    public bool Cancel(string appCallerCode, string requestId)
    {
        var key = GatewayCancellationKey.Create(appCallerCode, requestId);
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

public readonly record struct GatewayCancellationKey(string AppCallerCode, string RequestId)
{
    public static GatewayCancellationKey Create(string appCallerCode, string requestId)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode))
            throw new ArgumentException("appCallerCode is required", nameof(appCallerCode));
        if (string.IsNullOrWhiteSpace(requestId))
            throw new ArgumentException("requestId is required", nameof(requestId));
        return new(appCallerCode.Trim().ToLowerInvariant(), requestId.Trim());
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
    private readonly IConfiguration _configuration;
    private readonly ILogger<GatewayDataLifecycleWorker> _logger;

    public GatewayDataLifecycleWorker(
        LlmGatewayDataContext data,
        IAssetStorage storage,
        GatewayBudgetCoordinator budgets,
        IConfiguration configuration,
        ILogger<GatewayDataLifecycleWorker> logger)
    {
        _data = data;
        _storage = storage;
        _budgets = budgets;
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
        var apply = _configuration.GetValue("LlmGateway:Retention:ApplyChanges", false);
        var sensitiveDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:SensitiveBodyDays", 7));
        var logs = _data.Database.GetCollection<MongoDB.Bson.BsonDocument>("llmrequestlogs");
        var sensitiveFilter = Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("StartedAt", DateTime.UtcNow.AddDays(-sensitiveDays))
                              & Builders<MongoDB.Bson.BsonDocument>.Filter.Or(
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Ne("RequestBodyRedacted", ""),
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("QuestionText", true),
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("AnswerText", true),
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("ThinkingText", true));
        var sensitiveCount = await logs.CountDocumentsAsync(sensitiveFilter, cancellationToken: ct);
        if (apply && sensitiveCount > 0)
        {
            await logs.UpdateManyAsync(sensitiveFilter,
                Builders<MongoDB.Bson.BsonDocument>.Update
                    .Set("RequestBodyRedacted", "[retention-redacted]")
                    .Unset("QuestionText")
                    .Unset("AnswerText")
                    .Unset("ThinkingText")
                    .Unset("SystemPromptText")
                    .Unset("ResponseToolCalls"),
                cancellationToken: ct);
        }

        var multipart = _data.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects");
        var expired = await multipart.Find(x => x.Status != "deleted" && x.ExpiresAt <= DateTime.UtcNow).Limit(200).ToListAsync(ct);
        if (apply)
        {
            foreach (var item in expired)
            {
                try
                {
                    await _storage.DeleteByKeyAsync(item.RefKey, ct);
                    await multipart.UpdateOneAsync(x => x.Id == item.Id,
                        Builders<GatewayMultipartObjectRecord>.Update
                            .Set(x => x.Status, "deleted")
                            .Set(x => x.DeletedAt, DateTime.UtcNow)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[GatewayLifecycle] multipart cleanup failed ref={RefKey}", item.RefKey);
                }
            }
            await _budgets.ReleaseExpiredAsync(ct);
        }

        _logger.LogInformation(
            "[GatewayLifecycle] mode={Mode} sensitiveLogs={SensitiveLogs} expiredMultipart={ExpiredMultipart}",
            apply ? "apply" : "dry-run",
            sensitiveCount,
            expired.Count);
    }
}
