using System.Xml.Linq;
using Microsoft.AspNetCore.DataProtection.Repositories;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// Stores ASP.NET Core DataProtection keys in MongoDB so encrypted system credentials survive container rebuilds.
/// </summary>
public sealed class MongoDataProtectionXmlRepository : IXmlRepository
{
    private const string CollectionName = "data_protection_keys";
    private readonly IMongoCollection<BsonDocument> _collection;

    public MongoDataProtectionXmlRepository(MongoDbContext db)
    {
        _collection = db.Database.GetCollection<BsonDocument>(CollectionName);
    }

    public IReadOnlyCollection<XElement> GetAllElements()
    {
        var docs = _collection.Find(Builders<BsonDocument>.Filter.Empty).ToList();
        return docs
            .Select(doc => doc.TryGetValue("xml", out var value) && value.IsString ? value.AsString : null)
            .Where(xml => !string.IsNullOrWhiteSpace(xml))
            .Select(xml => XElement.Parse(xml!))
            .ToList();
    }

    public void StoreElement(XElement element, string friendlyName)
    {
        var now = DateTime.UtcNow;
        var doc = new BsonDocument
        {
            { "_id", string.IsNullOrWhiteSpace(friendlyName) ? Guid.NewGuid().ToString("N") : friendlyName },
            { "friendlyName", friendlyName ?? string.Empty },
            { "xml", element.ToString(SaveOptions.DisableFormatting) },
            { "updatedAt", now },
            { "createdAt", now },
        };

        var update = Builders<BsonDocument>.Update
            .Set("friendlyName", doc["friendlyName"])
            .Set("xml", doc["xml"])
            .Set("updatedAt", now)
            .SetOnInsert("createdAt", now);

        _collection.UpdateOne(
            Builders<BsonDocument>.Filter.Eq("_id", doc["_id"]),
            update,
            new UpdateOptions { IsUpsert = true });
    }
}
