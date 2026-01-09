using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

public sealed class OpenPlatformApiKeyRepository : IOpenPlatformApiKeyRepository
{
    private readonly IMongoCollection<OpenPlatformApiKey> _col;

    public OpenPlatformApiKeyRepository(IMongoCollection<OpenPlatformApiKey> col)
    {
        _col = col;
    }

    public async Task<OpenPlatformApiKey?> GetByIdAsync(string id)
    {
        var keyId = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(keyId)) return null;
        return await _col.Find(x => x.Id == keyId).FirstOrDefaultAsync();
    }

    public async Task<List<OpenPlatformApiKey>> ListByOwnerAsync(string ownerUserId)
    {
        var uid = (ownerUserId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid)) return new List<OpenPlatformApiKey>();
        return await _col.Find(x => x.OwnerUserId == uid)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();
    }

    public async Task InsertAsync(OpenPlatformApiKey key)
    {
        await _col.InsertOneAsync(key);
    }

    public async Task ReplaceAsync(OpenPlatformApiKey key)
    {
        await _col.ReplaceOneAsync(x => x.Id == key.Id, key, new ReplaceOptions { IsUpsert = false });
    }
}

