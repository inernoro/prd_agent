using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 应用设置服务实现（带内存缓存）
/// </summary>
public class AppSettingsService : IAppSettingsService
{
    private readonly MongoDbContext _db;
    private readonly IMemoryCache _cache;
    private const string CacheKey = "AppSettings:Global";
    private static readonly TimeSpan CacheExpiration = TimeSpan.FromMinutes(5);

    public AppSettingsService(MongoDbContext db, IMemoryCache cache)
    {
        _db = db;
        _cache = cache;
    }

    public async Task<AppSettings> GetSettingsAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue<AppSettings>(CacheKey, out var cached))
        {
            return cached!;
        }

        var settings = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        if (settings == null)
        {
            settings = new AppSettings
            {
                Id = "global",
                EnablePromptCache = true,
                UpdatedAt = DateTime.UtcNow
            };
            await _db.AppSettings.InsertOneAsync(settings, cancellationToken: ct);
        }

        _cache.Set(CacheKey, settings, CacheExpiration);
        return settings;
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        _cache.Remove(CacheKey);
        await GetSettingsAsync(ct);
    }
}

