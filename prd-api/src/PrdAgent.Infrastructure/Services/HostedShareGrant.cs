using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

public static class HostedShareGrant
{
    public const string Prefix = "grant:";
    public static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    public static string CookieName(string token) => "hosted-share-" + Digest(token)[..24];
    // Bind to the current credential: reset immediately invalidates issued grants.
    public static string Version(WebPageShareLink share) => Digest(share.PasswordHash + ":" + share.PasswordSalt + ":" + (share.PasswordHash == null ? share.Password : ""));
    public static async Task<string> IssueAsync(MongoDbContext db, WebPageShareLink share, CancellationToken ct)
    {
        var value = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var collection = db.Database.GetCollection<BsonDocument>("hosted_share_grants");
        await collection.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
            Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"), new CreateIndexOptions { ExpireAfter = TimeSpan.Zero }), cancellationToken: ct);
        await collection.InsertOneAsync(new BsonDocument { { "_id", Digest(value) }, { "ShareId", share.Id },
            { "Version", Version(share) }, { "ExpiresAt", DateTime.UtcNow.AddMinutes(30) } }, cancellationToken: ct);
        return Prefix + value;
    }
    public static async Task<bool> VerifyAsync(MongoDbContext db, WebPageShareLink share, string grant, CancellationToken ct)
    {
        if (!grant.StartsWith(Prefix, StringComparison.Ordinal) || grant.Length != Prefix.Length + 64) return false;
        var filter = Builders<BsonDocument>.Filter;
        return await db.Database.GetCollection<BsonDocument>("hosted_share_grants").Find(
            filter.Eq("_id", Digest(grant[Prefix.Length..])) & filter.Eq("ShareId", share.Id)
            & filter.Eq("Version", Version(share)) & filter.Gt("ExpiresAt", DateTime.UtcNow)).AnyAsync(ct);
    }
}
