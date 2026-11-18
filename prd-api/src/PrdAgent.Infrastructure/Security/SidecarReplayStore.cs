using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Security;

public enum ReplayResult { Accepted, Rejected, Unavailable }

/// <summary>Approval identity is global to a run, not to a process or credential issuance.</summary>
public sealed record SidecarReplayBinding(string RunId, string Subject, string CredentialHash,
    string ApprovalId, string Tool, string? InputHash, long ExpiresAt)
{
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    public string Id(string kind) => Hash(JsonSerializer.Serialize(new[] { kind, RunId, kind == "run" ? "" : ApprovalId }));
}

public sealed record SidecarRunState(ReplayResult Result, string? State = null);

public interface ISidecarReplayStore
{
    Task<SidecarRunState> ControlRunAsync(SidecarReplayBinding binding, string operation, CancellationToken ct);
    Task<SidecarRunState> CancelOwnedRunAsync(string runId, string subject, CancellationToken ct);
    Task<ReplayResult> ReserveRunAsync(SidecarReplayBinding binding, CancellationToken ct);
    Task<ReplayResult> RegisterApprovalAsync(SidecarReplayBinding binding, CancellationToken ct);
    Task<ReplayResult> ClaimWaitAsync(SidecarReplayBinding binding, CancellationToken ct);
    Task<ReplayResult> FinishWaitAsync(SidecarReplayBinding binding, bool allowed, bool callbackTool, CancellationToken ct);
    Task<ReplayResult> ConsumeAsync(SidecarReplayBinding binding, CancellationToken ct);
}

/// <summary>
/// Single-document Mongo CAS with majority+journal acknowledgement. No cache or retry can authorize execution.
/// Tombstones are retained: expiration rejects use, it never makes an old approval ID reusable.
/// A crash or uncertain acknowledgement burns the attempt; at-most-once dispatch, not exactly-once effects.
/// </summary>
public sealed class MongoSidecarReplayStore : ISidecarReplayStore
{
    public const string CollectionName = "sidecar_replay_records";
    private readonly IMongoCollection<BsonDocument> _records;
    private readonly ILogger<MongoSidecarReplayStore> _logger;

    public MongoSidecarReplayStore(LlmGatewayDataContext data, ILogger<MongoSidecarReplayStore> logger)
    {
        _records = data.Database.GetCollection<BsonDocument>(CollectionName)
            .WithWriteConcern(WriteConcern.WMajority.With(journal: true, wTimeout: TimeSpan.FromSeconds(5)));
        _logger = logger;
    }

    public Task<ReplayResult> ReserveRunAsync(SidecarReplayBinding b, CancellationToken ct) => InsertAsync(b, "run", "running", ct);
    public Task<ReplayResult> RegisterApprovalAsync(SidecarReplayBinding b, CancellationToken ct) => InsertAsync(b, "approval", "requested", ct);
    public Task<ReplayResult> ClaimWaitAsync(SidecarReplayBinding b, CancellationToken ct) => TransitionAsync(b, "requested", "waiting", ct);
    public Task<ReplayResult> FinishWaitAsync(SidecarReplayBinding b, bool allowed, bool callbackTool, CancellationToken ct) =>
        TransitionAsync(b, "waiting", allowed && callbackTool ? "approved" : "consumed", ct);
    public Task<ReplayResult> ConsumeAsync(SidecarReplayBinding b, CancellationToken ct) => TransitionAsync(b, "approved", "consumed", ct);

    public Task<SidecarRunState> CancelOwnedRunAsync(string runId, string subject, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(runId) || string.IsNullOrWhiteSpace(subject))
            return Task.FromResult(new SidecarRunState(ReplayResult.Rejected));
        return ControlAsync(new BsonDocument { ["Kind"] = "run", ["RunId"] = runId, ["Subject"] = subject }, "cancel", ct);
    }

    public Task<SidecarRunState> ControlRunAsync(SidecarReplayBinding b, string operation, CancellationToken ct)
    {
        if (!Valid(b)) return Task.FromResult(new SidecarRunState(ReplayResult.Rejected));
        return ControlAsync(new BsonDocument { ["_id"] = b.Id("run"), ["Subject"] = b.Subject,
            ["CredentialHash"] = b.CredentialHash,
            ["ExpiresAt"] = new BsonDateTime(DateTimeOffset.FromUnixTimeSeconds(b.ExpiresAt).UtcDateTime) }, operation, ct);
    }

    private async Task<SidecarRunState> ControlAsync(FilterDefinition<BsonDocument> owner, string operation, CancellationToken ct)
    {
        if (operation is not ("status" or "cancel" or "complete" or "fail")) return new(ReplayResult.Rejected);
        try
        {
            // Expired workers cannot revive an active record. Terminal records are immutable.
            await _records.UpdateOneAsync(owner & Builders<BsonDocument>.Filter.In("State", new[] { "running", "cancel_requested" })
                & new BsonDocument("$expr", new BsonDocument("$lte", new BsonArray { "$ExpiresAt", "$$NOW" })),
                Builders<BsonDocument>.Update.Set("State", "expired"), cancellationToken: ct);
            if (operation != "status")
            {
                var active = owner & Builders<BsonDocument>.Filter.In("State", new[] { "running", "cancel_requested" });
                // One atomic pipeline resolves cancellation/completion races. Cancellation intent is never overwritten by success.
                var next = operation == "cancel" ? (BsonValue)"cancel_requested" : new BsonDocument("$cond", new BsonArray {
                    new BsonDocument("$eq", new BsonArray { "$State", "cancel_requested" }), "cancelled",
                    operation == "complete" ? "completed" : "failed" });
                var update = new PipelineUpdateDefinition<BsonDocument>(new[] { new BsonDocument("$set", new BsonDocument {
                    ["State"] = next, ["TransitionedAt"] = "$$NOW" }) });
                await _records.UpdateOneAsync(active, update, cancellationToken: ct);
            }
            var record = await _records.Find(owner).FirstOrDefaultAsync(ct);
            return record is null ? new(ReplayResult.Rejected) : new(ReplayResult.Accepted, record["State"].AsString);
        }
        catch (Exception e) when (StorageFailure(e)) { return new(Unavailable(e)); }
    }

    private async Task<ReplayResult> InsertAsync(SidecarReplayBinding b, string kind, string state, CancellationToken ct)
    {
        if (!Valid(b) || kind == "approval" && string.IsNullOrEmpty(b.InputHash)) return ReplayResult.Rejected;
        try
        {
            await _records.InsertOneAsync(new BsonDocument
            {
                ["_id"] = b.Id(kind), ["Kind"] = kind, ["RunId"] = b.RunId, ["Subject"] = b.Subject,
                ["CredentialHash"] = b.CredentialHash, ["ApprovalId"] = b.ApprovalId, ["Tool"] = b.Tool,
                ["InputHash"] = b.InputHash is null ? BsonNull.Value : new BsonString(b.InputHash),
                ["ExpiresAt"] = new BsonDateTime(DateTimeOffset.FromUnixTimeSeconds(b.ExpiresAt).UtcDateTime),
                ["State"] = state,
            }, cancellationToken: ct);
            // Use server time even for reservation. Expired inserts remain burned, never granted.
            var live = await _records.Find(Live(b, kind)).AnyAsync(ct);
            return live ? ReplayResult.Accepted : ReplayResult.Rejected;
        }
        catch (MongoWriteException e) when (e.WriteError.Category == ServerErrorCategory.DuplicateKey) { return ReplayResult.Rejected; }
        catch (Exception e) when (StorageFailure(e)) { return Unavailable(e); }
    }

    private async Task<ReplayResult> TransitionAsync(SidecarReplayBinding b, string from, string to, CancellationToken ct)
    {
        if (!Valid(b) || from == "approved" && string.IsNullOrEmpty(b.InputHash)) return ReplayResult.Rejected;
        try
        {
            var filter = Live(b, "approval") & Builders<BsonDocument>.Filter.Eq("State", from);
            if (b.InputHash is not null) filter &= Builders<BsonDocument>.Filter.Eq("InputHash", b.InputHash);
            var result = await _records.UpdateOneAsync(filter,
                Builders<BsonDocument>.Update.Set("State", to).CurrentDate("TransitionedAt"), cancellationToken: ct);
            return result.IsAcknowledged && result.ModifiedCount == 1 ? ReplayResult.Accepted : ReplayResult.Rejected;
        }
        catch (Exception e) when (StorageFailure(e)) { return Unavailable(e); }
    }

    private static FilterDefinition<BsonDocument> Live(SidecarReplayBinding b, string kind) => new BsonDocument
    {
        ["_id"] = b.Id(kind), ["RunId"] = b.RunId, ["Subject"] = b.Subject,
        ["CredentialHash"] = b.CredentialHash, ["Tool"] = b.Tool,
        ["ExpiresAt"] = new BsonDateTime(DateTimeOffset.FromUnixTimeSeconds(b.ExpiresAt).UtcDateTime),
        ["$expr"] = new BsonDocument("$gt", new BsonArray { "$ExpiresAt", "$$NOW" }),
    };
    private static bool Valid(SidecarReplayBinding b) => !string.IsNullOrWhiteSpace(b.RunId)
        && !string.IsNullOrWhiteSpace(b.Subject) && !string.IsNullOrWhiteSpace(b.CredentialHash)
        && b.ExpiresAt > 0 && b.ExpiresAt <= 253402300799;
    private static bool StorageFailure(Exception e) => e is MongoException or TimeoutException or OperationCanceledException or IOException;
    private ReplayResult Unavailable(Exception e)
    {
        _logger.LogWarning("Sidecar replay store unavailable ({ErrorType}); execution denied", e.GetType().Name);
        return ReplayResult.Unavailable;
    }
}
