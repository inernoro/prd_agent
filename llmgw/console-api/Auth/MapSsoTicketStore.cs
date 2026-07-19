using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.Auth;

public static class MapSsoTicketStore
{
    public const string Purpose = "map-console-login";
    public const string Audience = "llmgw-console";

    public static string HashCode(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code))).ToLowerInvariant();

    public static async Task<BsonDocument?> TryClaimAsync(
        IMongoCollection<BsonDocument> tickets,
        string code,
        DateTime now,
        CancellationToken cancellationToken = default)
    {
        return await tickets.FindOneAndUpdateAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("CodeHash", HashCode(code)),
                Builders<BsonDocument>.Filter.Eq("Purpose", Purpose),
                Builders<BsonDocument>.Filter.Eq("Audience", Audience),
                Builders<BsonDocument>.Filter.Eq("MapRole", "ADMIN"),
                Builders<BsonDocument>.Filter.Eq("State", "issued"),
                Builders<BsonDocument>.Filter.Gt("ExpiresAt", now)),
            Builders<BsonDocument>.Update
                .Set("State", "claimed")
                .Set("ConsumedAt", now),
            new FindOneAndUpdateOptions<BsonDocument, BsonDocument> { ReturnDocument = ReturnDocument.After },
            cancellationToken);
    }
}
