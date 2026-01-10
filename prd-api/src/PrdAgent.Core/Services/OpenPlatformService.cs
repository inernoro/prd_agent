using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 开放平台服务实现（抽象实现，具体数据访问由 Infrastructure 层提供）
/// </summary>
public abstract class OpenPlatformService : IOpenPlatformService
{
    protected readonly IIdGenerator _idGenerator;

    protected OpenPlatformService(IIdGenerator idGenerator)
    {
        _idGenerator = idGenerator;
    }

    // 抽象方法，由 Infrastructure 层实现
    protected abstract Task<OpenPlatformApp> InsertAppAsync(OpenPlatformApp app);
    protected abstract Task<OpenPlatformApp?> FindAppByApiKeyHashAsync(string apiKeyHash);
    protected abstract Task<OpenPlatformApp?> FindAppByIdAsync(string appId);
    protected abstract Task<(List<OpenPlatformApp> apps, long total)> QueryAppsAsync(int skip, int limit, string? search);
    protected abstract Task<bool> UpdateAppFieldsAsync(string appId, Dictionary<string, object> updates);
    protected abstract Task<bool> DeleteAppByIdAsync(string appId);
    protected abstract Task InsertLogAsync(OpenPlatformRequestLog log);
    protected abstract Task<(List<OpenPlatformRequestLog> logs, long total)> QueryLogsAsync(
        int skip, int limit, string? appId, DateTime? startTime, DateTime? endTime, int? statusCode);

    public async Task<(OpenPlatformApp app, string apiKey)> CreateAppAsync(
        string appName,
        string? description,
        string boundUserId,
        string? boundGroupId,
        bool ignoreUserSystemPrompt = true)
    {
        var apiKey = GenerateApiKey();
        var apiKeyHash = ComputeSha256(apiKey);

        var app = new OpenPlatformApp
        {
            Id = await _idGenerator.GenerateIdAsync("openplatformapp"),
            AppName = appName,
            Description = description,
            BoundUserId = boundUserId,
            BoundGroupId = boundGroupId,
            IgnoreUserSystemPrompt = ignoreUserSystemPrompt,
            ApiKeyHash = apiKeyHash,
            IsActive = true,
            CreatedAt = DateTime.UtcNow,
            TotalRequests = 0
        };

        await InsertAppAsync(app);
        return (app, apiKey);
    }

    public async Task<OpenPlatformApp?> GetAppByApiKeyAsync(string apiKey)
    {
        var apiKeyHash = ComputeSha256(apiKey);
        return await FindAppByApiKeyHashAsync(apiKeyHash);
    }

    public Task<OpenPlatformApp?> GetAppByIdAsync(string appId)
    {
        return FindAppByIdAsync(appId);
    }

    public async Task<(List<OpenPlatformApp> apps, long total)> GetAppsAsync(
        int page,
        int pageSize,
        string? search = null)
    {
        var skip = (page - 1) * pageSize;
        return await QueryAppsAsync(skip, pageSize, search);
    }

    public async Task<bool> UpdateAppAsync(
        string appId,
        string? appName = null,
        string? description = null,
        string? boundUserId = null,
        string? boundGroupId = null)
    {
        var updates = new Dictionary<string, object>();
        if (appName != null) updates["AppName"] = appName;
        if (description != null) updates["Description"] = description;
        if (boundUserId != null) updates["BoundUserId"] = boundUserId;
        if (boundGroupId != null) updates["BoundGroupId"] = boundGroupId;

        if (updates.Count == 0) return false;
        return await UpdateAppFieldsAsync(appId, updates);
    }

    public Task<bool> DeleteAppAsync(string appId)
    {
        return DeleteAppByIdAsync(appId);
    }

    public async Task<string?> RegenerateApiKeyAsync(string appId)
    {
        var app = await GetAppByIdAsync(appId);
        if (app == null) return null;

        var newApiKey = GenerateApiKey();
        var newApiKeyHash = ComputeSha256(newApiKey);

        var updates = new Dictionary<string, object> { ["ApiKeyHash"] = newApiKeyHash };
        var success = await UpdateAppFieldsAsync(appId, updates);
        return success ? newApiKey : null;
    }

    public async Task<bool> ToggleAppStatusAsync(string appId)
    {
        var app = await GetAppByIdAsync(appId);
        if (app == null) return false;

        var updates = new Dictionary<string, object> { ["IsActive"] = !app.IsActive };
        return await UpdateAppFieldsAsync(appId, updates);
    }

    public Task LogRequestAsync(OpenPlatformRequestLog log)
    {
        return InsertLogAsync(log);
    }

    public async Task<(List<OpenPlatformRequestLog> logs, long total)> GetRequestLogsAsync(
        int page,
        int pageSize,
        string? appId = null,
        DateTime? startTime = null,
        DateTime? endTime = null,
        int? statusCode = null)
    {
        var skip = (page - 1) * pageSize;
        return await QueryLogsAsync(skip, pageSize, appId, startTime, endTime, statusCode);
    }

    public async Task UpdateAppUsageAsync(string appId)
    {
        var updates = new Dictionary<string, object>
        {
            ["TotalRequests"] = 1, // 用于增量
            ["LastUsedAt"] = DateTime.UtcNow
        };
        await UpdateAppFieldsAsync(appId, updates);
    }

    protected static string GenerateApiKey()
    {
        var guid1 = Guid.NewGuid().ToString("N");
        var guid2 = Guid.NewGuid().ToString("N");
        return $"sk-{guid1}{guid2}"[..35];
    }

    protected static string ComputeSha256(string input)
    {
        using var sha256 = SHA256.Create();
        var bytes = Encoding.UTF8.GetBytes(input);
        var hash = sha256.ComputeHash(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
