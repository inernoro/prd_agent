using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IOpenPlatformApiKeyRepository
{
    Task<OpenPlatformApiKey?> GetByIdAsync(string id);
    Task<List<OpenPlatformApiKey>> ListByOwnerAsync(string ownerUserId);
    Task InsertAsync(OpenPlatformApiKey key);
    Task ReplaceAsync(OpenPlatformApiKey key);
}

