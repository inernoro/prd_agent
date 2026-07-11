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

public interface IGatewayScopedKeyAuthorizer
{
    Task<GatewayKeyAuthorization> AuthorizeAsync(
        string providedKey,
        string legacySharedKey,
        string sourceSystem,
        string appCallerCode,
        string ingressProtocol,
        string requiredScope,
        CancellationToken ct);
}

public sealed class GatewayScopedKeyAuthorizer : IGatewayScopedKeyAuthorizer
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
        {
            var outcomeUnknown = item.Status == "unknown";
            await SetReservationStatusAsync(
                item.Id,
                outcomeUnknown ? "settled-unknown-expired" : "released-expired",
                outcomeUnknown ? "unknown-outcome-conservative-settlement" : "reservation-expired",
                adjustMonth: item.Status != "pending",
                settle: outcomeUnknown,
                ct);
        }
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
                "completed-unreplayable" => new(GatewayExecutionBeginState.ReplayUnavailable, existing.Id),
                "unknown" => new(GatewayExecutionBeginState.Unknown, existing.Id),
                "failed" => new(GatewayExecutionBeginState.Failed, existing.Id),
                _ => new(GatewayExecutionBeginState.Running, existing.Id),
            };
        }
    }

    public async Task CompleteAsync(string executionId, string responseJson, CancellationToken ct)
    {
        var responseTooLarge = Encoding.UTF8.GetByteCount(responseJson) > MaxReplayResponseBytes;

        try
        {
            if (responseTooLarge)
                await MarkReplayUnavailableAsync(executionId, "GATEWAY_REPLAY_RESPONSE_TOO_LARGE", ct);
            else
                await UpdateAsync(executionId, "completed", responseJson, null, ct);
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
                    await MarkReplayUnavailableAsync(executionId, "GATEWAY_REPLAY_SNAPSHOT_UNAVAILABLE", CancellationToken.None);
                }
                catch (Exception fallbackEx)
                {
                    _logger?.LogError(fallbackEx, "[GatewayIdempotency] failed to persist replay-unavailable state execution={ExecutionId}", executionId);
                }
            }
        }
    }

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

    private Task MarkReplayUnavailableAsync(string executionId, string errorCode, CancellationToken ct)
        => UpdateAsync(executionId, "completed-unreplayable", null, errorCode, ct);

    public static string Fingerprint(GatewayRawRequest request)
    {
        var multipartFiles = request.MultipartFiles?
            .OrderBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => new
            {
                FieldName = x.Key,
                x.Value.FileName,
                x.Value.MimeType,
                SizeBytes = x.Value.Content.LongLength,
                Sha256 = Convert.ToHexString(SHA256.HashData(x.Value.Content)).ToLowerInvariant(),
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
        var now = DateTime.UtcNow;
        var apply = _configuration.GetValue("LlmGateway:Retention:ApplyChanges", false);
        var sensitiveDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:SensitiveBodyDays", 7));
        var requestLogDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:RequestLogDays", 90));
        var shadowDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:ShadowDays", 30));
        var auditDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:AuditDays", 180));
        var logs = _data.Database.GetCollection<MongoDB.Bson.BsonDocument>("llmrequestlogs");
        var sensitiveFilter = Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("StartedAt", now.AddDays(-sensitiveDays))
                              & Builders<MongoDB.Bson.BsonDocument>.Filter.Or(
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Ne("RequestBodyRedacted", ""),
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("QuestionText", true),
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("AnswerText", true),
                                  Builders<MongoDB.Bson.BsonDocument>.Filter.Exists("ThinkingText", true));
        var sensitiveCount = await logs.CountDocumentsAsync(sensitiveFilter, cancellationToken: ct);
        var multipart = _data.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects");
        var expiredFilter = Builders<GatewayMultipartObjectRecord>.Filter.Ne(x => x.Status, "deleted")
                            & Builders<GatewayMultipartObjectRecord>.Filter.Lte(x => x.ExpiresAt, now);
        var expiredMultipartCount = await multipart.CountDocumentsAsync(expiredFilter, cancellationToken: ct);
        var expired = await multipart.Find(expiredFilter).SortBy(x => x.ExpiresAt).Limit(200).ToListAsync(ct);
        var indexStatus = await ReadRetentionIndexStatusAsync(ct);
        var lifecycle = _data.Database.GetCollection<GatewayLifecycleRunRecord>("llmgw_lifecycle_runs");
        var run = new GatewayLifecycleRunRecord
        {
            Mode = apply ? "apply" : "dry-run",
            Status = "dry-run-complete",
            StartedAt = now,
            DryRunCompletedAt = DateTime.UtcNow,
            SensitiveLogs = sensitiveCount,
            ExpiredRequestLogs = await CountExpiredAsync("llmrequestlogs", "StartedAt", now.AddDays(-requestLogDays), ct),
            ExpiredShadowComparisons = await CountExpiredAsync("llmshadow_comparisons", "ComparedAt", now.AddDays(-shadowDays), ct),
            ExpiredOperationAudits = await CountExpiredAsync("llmgw_operation_audits", "CreatedAt", now.AddDays(-auditDays), ct),
            ExpiredLoginAudits = await CountExpiredAsync("llmgw_login_audits", "CreatedAt", now.AddDays(-auditDays), ct),
            ExpiredMultipartObjects = expiredMultipartCount,
            OldestExpiredRequestLogAt = await OldestAsync("llmrequestlogs", "StartedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("StartedAt", now.AddDays(-requestLogDays)), ct),
            OldestSensitiveLogAt = await OldestAsync("llmrequestlogs", "StartedAt", sensitiveFilter, ct),
            OldestExpiredShadowAt = await OldestAsync("llmshadow_comparisons", "ComparedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("ComparedAt", now.AddDays(-shadowDays)), ct),
            OldestExpiredOperationAuditAt = await OldestAsync("llmgw_operation_audits", "CreatedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("CreatedAt", now.AddDays(-auditDays)), ct),
            OldestExpiredLoginAuditAt = await OldestAsync("llmgw_login_audits", "CreatedAt", Builders<MongoDB.Bson.BsonDocument>.Filter.Lt("CreatedAt", now.AddDays(-auditDays)), ct),
            OldestExpiredMultipartAt = expired.FirstOrDefault()?.ExpiresAt,
            RetentionIndexesReady = indexStatus.Count == 0,
            MissingRetentionIndexes = indexStatus.ToArray(),
        };
        await lifecycle.InsertOneAsync(run, cancellationToken: ct);

        // Budget reservation expiry is runtime accounting, not data retention. It must run
        // even while destructive retention remains in dry-run mode.
        await _budgets.ReleaseExpiredAsync(ct);

        if (apply)
        {
            await _databaseInitializer.EnsureRetentionTtlIndexesAsync(ct);
            indexStatus = await ReadRetentionIndexStatusAsync(ct);
            await lifecycle.UpdateOneAsync(x => x.Id == run.Id,
                Builders<GatewayLifecycleRunRecord>.Update
                    .Set(x => x.RetentionIndexesReady, indexStatus.Count == 0)
                    .Set(x => x.MissingRetentionIndexes, indexStatus.ToArray()),
                cancellationToken: ct);
        }

        if (apply)
        {
            var redacted = sensitiveCount > 0
                ? (await logs.UpdateManyAsync(sensitiveFilter,
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
                    deleted++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[GatewayLifecycle] multipart cleanup failed ref={RefKey}", item.RefKey);
                }
            }

            await lifecycle.UpdateOneAsync(x => x.Id == run.Id,
                Builders<GatewayLifecycleRunRecord>.Update
                    .Set(x => x.Status, "applied")
                    .Set(x => x.RedactedSensitiveLogs, redacted)
                    .Set(x => x.DeletedMultipartObjects, deleted)
                    .Set(x => x.CompletedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }

        _logger.LogInformation(
            "[GatewayLifecycle] mode={Mode} sensitiveLogs={SensitiveLogs} expiredMultipart={ExpiredMultipart} indexesReady={IndexesReady} runId={RunId}",
            apply ? "apply" : "dry-run",
            sensitiveCount,
            expiredMultipartCount,
            indexStatus.Count == 0,
            run.Id);
    }

    private async Task<long> CountExpiredAsync(string collectionName, string field, DateTime cutoff, CancellationToken ct)
    {
        var collection = _data.Database.GetCollection<MongoDB.Bson.BsonDocument>(collectionName);
        return await collection.CountDocumentsAsync(
            Builders<MongoDB.Bson.BsonDocument>.Filter.Lt(field, cutoff), cancellationToken: ct);
    }

    private async Task<DateTime?> OldestAsync(
        string collectionName,
        string field,
        FilterDefinition<MongoDB.Bson.BsonDocument> filter,
        CancellationToken ct)
    {
        var document = await _data.Database.GetCollection<MongoDB.Bson.BsonDocument>(collectionName)
            .Find(filter)
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
