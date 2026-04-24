using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// 装饰器：包裹真实的 IAssetStorage 实现，每次写入/删除操作自动登记到 asset_registry 集合。
/// 不修改 IAssetStorage 接口，不改任何调用点——纯 DI 层透明注入。
///
/// scope 自动推断规则：
///   domain=="logs" OR type=="log"                    → "log"
///   key 含 "icon/desktop/" 或 "icon/backups/head/"   → "system"
///   其余                                              → "user"
///
/// 注意：AI 生成的内容（scope="generated"）需要后续在具体 Worker 中通过
///       RegistryAssetStorage.OverrideNextScope("generated") 显式标记。
/// </summary>
public sealed class RegistryAssetStorage : IAssetStorage
{
    private readonly IAssetStorage _inner;
    private readonly MongoDbContext _db;
    private readonly string _providerName;
    private readonly ILogger<RegistryAssetStorage> _logger;

    /// <summary>
    /// AsyncLocal 允许调用方在特定上下文中覆盖 scope（如 Worker 中标记 "generated"）。
    /// </summary>
    private static readonly AsyncLocal<string?> _scopeOverride = new();

    public RegistryAssetStorage(
        IAssetStorage inner,
        MongoDbContext db,
        string providerName,
        ILogger<RegistryAssetStorage> logger)
    {
        _inner = inner;
        _db = db;
        _providerName = providerName;
        _logger = logger;
    }

    /// <summary>
    /// 设置当前异步上下文的 scope 覆盖。在 using 块结束时自动还原。
    /// 用法：using (RegistryAssetStorage.ScopeAs("generated")) { ... 多次 SaveAsync ... }
    /// 也支持简单的一次性标记：RegistryAssetStorage.OverrideNextScope("generated");
    /// </summary>
    public static IDisposable ScopeAs(string scope)
    {
        _scopeOverride.Value = scope;
        return new ScopeRestorer();
    }

    /// <summary>
    /// 一次性标记：下一次 SaveAsync 使用后自动清除。
    /// </summary>
    public static void OverrideNextScope(string scope)
    {
        _scopeOverride.Value = $"once:{scope}";
    }

    private sealed class ScopeRestorer : IDisposable
    {
        public void Dispose() => _scopeOverride.Value = null;
    }

    public async Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null)
    {
        var result = await _inner.SaveAsync(bytes, mime, ct, domain, type);
        await LogRegistryAsync("write", null, result.Sha256, result.Url, domain, type, mime, result.SizeBytes);
        return result;
    }

    public async Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        return await _inner.TryReadByShaAsync(sha256, ct, domain, type);
    }

    public async Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        await _inner.DeleteByShaAsync(sha256, ct, domain, type);
        await LogRegistryAsync("delete", null, sha256, null, domain, type, null, 0);
    }

    public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
    {
        return _inner.TryBuildUrlBySha(sha256, mime, domain, type);
    }

    public async Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
    {
        return await _inner.TryDownloadBytesAsync(key, ct);
    }

    public async Task<bool> ExistsAsync(string key, CancellationToken ct)
    {
        return await _inner.ExistsAsync(key, ct);
    }

    public async Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct)
    {
        await _inner.UploadToKeyAsync(key, bytes, contentType, ct);
        var url = _inner.BuildUrlForKey(key);
        await LogRegistryAsync("write", key, null, url, InferDomainFromKey(key), InferTypeFromKey(key), contentType, bytes.Length);
    }

    public string BuildUrlForKey(string key)
    {
        return _inner.BuildUrlForKey(key);
    }

    public async Task DeleteByKeyAsync(string key, CancellationToken ct)
    {
        await _inner.DeleteByKeyAsync(key, ct);
        await LogRegistryAsync("delete", key, null, null, InferDomainFromKey(key), InferTypeFromKey(key), null, 0);
    }

    public string BuildSiteKey(string siteId, string filePath)
    {
        return _inner.BuildSiteKey(siteId, filePath);
    }

    // ========================== Registry ==========================

    private async Task LogRegistryAsync(string operation, string? key, string? sha256, string? url, string? domain, string? type, string? mime, long sizeBytes)
    {
        try
        {
            var scope = ConsumeOverrideOrInfer(domain, type, key);
            var entry = new AssetRegistryEntry
            {
                Operation = operation,
                Provider = _providerName,
                Key = key ?? string.Empty,
                Sha256 = sha256,
                Url = url ?? string.Empty,
                Domain = domain,
                Type = type,
                Mime = mime,
                SizeBytes = sizeBytes,
                Scope = scope,
            };
            await _db.AssetRegistry.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            // registry 登记失败不应影响主流程
            _logger.LogWarning(ex, "AssetRegistry log failed. op={Op} key={Key} sha={Sha}", operation, key, sha256);
        }
    }

    private static string ConsumeOverrideOrInfer(string? domain, string? type, string? key)
    {
        // 1. 显式覆盖
        var over = _scopeOverride.Value;
        if (!string.IsNullOrWhiteSpace(over))
        {
            if (over.StartsWith("once:", StringComparison.Ordinal))
            {
                // 一次性：用后清除
                _scopeOverride.Value = null;
                return over["once:".Length..];
            }
            // 持久性（ScopeAs）：不清除，由 Dispose 还原
            return over;
        }

        // 2. 自动推断
        var d = (domain ?? string.Empty).ToLowerInvariant();
        var t = (type ?? string.Empty).ToLowerInvariant();
        var k = (key ?? string.Empty).ToLowerInvariant();

        // log scope
        if (d == "logs" || t == "log") return "log";

        // system scope
        if (k.Contains("icon/desktop/") || k.Contains("icon/backups/head/")) return "system";

        // 默认 user（最安全的分类——宁可把 generated 误分为 user，也不把 user 误分为 system）
        return "user";
    }

    private static string? InferDomainFromKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        var parts = key.Trim('/').Split('/');
        // key 格式: {prefix?}/{domain}/{type}/{sha}.{ext} 或 {domain}/{type}/{sha}.{ext}
        // 或 web-hosting/sites/{siteId}/...  或 icon/desktop/...
        if (parts.Length >= 3)
        {
            var candidate = parts.Length >= 4 ? parts[^3] : parts[0];
            return candidate;
        }
        return null;
    }

    private static string? InferTypeFromKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        var parts = key.Trim('/').Split('/');
        if (parts.Length >= 3)
        {
            var candidate = parts.Length >= 4 ? parts[^2] : parts[1];
            return candidate;
        }
        return null;
    }
}
