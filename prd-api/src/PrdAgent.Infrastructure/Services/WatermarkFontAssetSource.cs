using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

public interface IWatermarkFontAssetSource
{
    IReadOnlyList<WatermarkFontAsset> LoadAll();
}

public sealed class MongoWatermarkFontAssetSource : IWatermarkFontAssetSource
{
    private readonly MongoDbContext _db;

    public MongoWatermarkFontAssetSource(MongoDbContext db)
    {
        _db = db;
    }

    public IReadOnlyList<WatermarkFontAsset> LoadAll()
    {
        return _db.WatermarkFontAssets.Find(_ => true).ToList();
    }
}
