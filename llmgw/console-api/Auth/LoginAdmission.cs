using System.Net;
using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.Auth;

// A single bounded document makes all three reservations atomic, including across replicas.
// Server time defines the window. At most GlobalLimit distinct accounts/IPs are retained.
public sealed class LoginAdmission(IMongoDatabase database)
{
    public const int GlobalLimit = 120, IpLimit = 20, AccountLimit = 5;
    private readonly IMongoCollection<BsonDocument> budgets = database.GetCollection<BsonDocument>("llmgw_login_admission").WithWriteConcern(WriteConcern.WMajority);

    private long denied, unavailable;
    public void RecordDenied() => Interlocked.Increment(ref denied);
    public void RecordUnavailable() => Interlocked.Increment(ref unavailable);

    // One aggregate write per instance/minute, not one audit document per rejected request.
    public async Task RunAuditLoopAsync(ILogger logger, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                var rejected = Interlocked.Exchange(ref denied, 0);
                var failed = Interlocked.Exchange(ref unavailable, 0);
                if (rejected + failed == 0) continue;
                try
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await budgets.UpdateOneAsync(new BsonDocument("_id", "denied-summary"),
                        new BsonDocument
                        {
                            { "$inc", new BsonDocument { { "Denied", rejected }, { "Unavailable", failed } } },
                            { "$set", new BsonDocument { { "Action", "auth.login_admission" }, { "LastFlushedAt", DateTime.UtcNow } } }
                        }, cancellationToken: timeout.Token);
                }
                catch (Exception ex) when (ex is MongoException or OperationCanceledException or TimeoutException)
                {
                    logger.LogWarning("Login admission audit flush unavailable; denied={Denied}, unavailable={Unavailable}", rejected, failed);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        try { await budgets.InsertOneAsync(new BsonDocument { { "_id", "login" }, { "Window", BsonDateTime.Create(DateTime.UnixEpoch) }, { "Total", 0 }, { "Accounts", new BsonDocument() }, { "Ips", new BsonDocument() } }, cancellationToken: ct); }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { }
        try { await budgets.InsertOneAsync(new BsonDocument { { "_id", "denied-summary" }, { "Denied", 0L }, { "Unavailable", 0L } }, cancellationToken: ct); }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { }
    }

    public async Task<bool> TryAcquireAsync(string username, IPAddress? address, CancellationToken ct = default)
    {
        var account = Digest(username);
        var ip = Digest(NormalizeIp(address));
        var window = new BsonDocument("$dateTrunc", new BsonDocument { { "date", "$$NOW" }, { "unit", "minute" } });
        var fresh = new BsonDocument("$ne", new BsonArray { "$Window", window });
        BsonDocument Count(string path) => new("$ifNull", new BsonArray { "$" + path, 0 });
        var filter = new BsonDocument { { "_id", "login" }, { "$expr", new BsonDocument("$or", new BsonArray
        {
            fresh, new BsonDocument("$and", new BsonArray
            {
                new BsonDocument("$lt", new BsonArray { "$Total", GlobalLimit }),
                new BsonDocument("$lt", new BsonArray { Count("Accounts." + account), AccountLimit }),
                new BsonDocument("$lt", new BsonArray { Count("Ips." + ip), IpLimit })
            })
        }) } };
        BsonDocument Increment(string path) => new("$add", new BsonArray { Count(path), 1 });
        BsonDocument Map(string name, string key) => new("$cond", new BsonArray
        {
            fresh, new BsonDocument(key, 1), new BsonDocument("$mergeObjects", new BsonArray
            { "$" + name, new BsonDocument(key, Increment(name + "." + key)) })
        });
        var update = new BsonDocument("$set", new BsonDocument
        {
            { "Window", window }, { "Total", new BsonDocument("$cond", new BsonArray { fresh, 1, Increment("Total") }) },
            { "Accounts", Map("Accounts", account) }, { "Ips", Map("Ips", ip) }
        });
        var result = await budgets.UpdateOneAsync(filter, new PipelineUpdateDefinition<BsonDocument>(new[] { update }), cancellationToken: ct);
        return result.ModifiedCount == 1;
    }

    public static string NormalizeIp(IPAddress? address)
    {
        if (address is null) return "unknown";
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            var bytes = address.GetAddressBytes(); Array.Clear(bytes, 8, 8);
            return new IPAddress(bytes).ToString() + "/64";
        }
        return address.ToString();
    }

    private static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
