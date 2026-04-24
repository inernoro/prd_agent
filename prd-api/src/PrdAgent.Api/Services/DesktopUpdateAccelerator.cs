using System.Collections.Concurrent;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 桌面更新加速服务：从 GitHub 下载安装包 → 上传 COS → 返回加速 manifest。
/// 使用 SemaphoreSlim 防止同一 (version, target) 竞态重复下载。
/// </summary>
public class DesktopUpdateAccelerator
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<DesktopUpdateAccelerator> _logger;

    /// <summary>防竞态锁：每个 "{version}_{target}" 对应一个信号量</summary>
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();

    private const string GitHubManifestUrlTemplate =
        "https://github.com/inernoro/prd_agent/releases/latest/download/latest-{0}.json";

    private const string CosAssetDomain = PrdAgent.Infrastructure.Services.AssetStorage.AppDomainPaths.DomainDesktop;
    private const string CosAssetType = PrdAgent.Infrastructure.Services.AssetStorage.AppDomainPaths.TypeBin;

    public DesktopUpdateAccelerator(
        MongoDbContext db,
        IAssetStorage storage,
        IHttpClientFactory httpClientFactory,
        ILogger<DesktopUpdateAccelerator> logger)
    {
        _db = db;
        _storage = storage;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>
    /// 获取加速后的 manifest JSON。如果缓存已就绪，直接返回；否则触发异步下载并返回 null。
    /// </summary>
    public async Task<string?> TryGetAcceleratedManifestAsync(string target, CancellationToken ct)
    {
        // 1. 先从 GitHub 获取最新 manifest 以确定版本号
        var (githubManifest, version) = await FetchGitHubManifestAsync(target, ct);
        if (githubManifest == null || version == null)
            return null;

        // 2. 查询缓存
        var cache = await _db.DesktopUpdateCaches
            .Find(x => x.Version == version && x.Target == target)
            .FirstOrDefaultAsync(ct);

        // 3. 已就绪 → 直接返回
        if (cache?.Status == "ready" && cache.AcceleratedManifestJson != null)
            return cache.AcceleratedManifestJson;

        // 4. 正在下载中 → 返回 null（让客户端回退 GitHub）
        if (cache?.Status == "downloading")
            return null;

        // 5. 不存在或失败 → 触发异步下载（fire-and-forget）
        _ = Task.Run(() => DownloadAndCacheAsync(version, target, githubManifest));

        return null;
    }

    /// <summary>
    /// 获取指定 target 的缓存状态列表（管理后台查看）
    /// </summary>
    public async Task<List<DesktopUpdateCache>> GetCacheStatusAsync(CancellationToken ct)
    {
        return await _db.DesktopUpdateCaches
            .Find(_ => true)
            .SortByDescending(x => x.CreatedAt)
            .Limit(50)
            .ToListAsync(ct);
    }

    /// <summary>
    /// 手动触发指定版本+目标的加速缓存
    /// </summary>
    public async Task<string> TriggerCacheAsync(string target, CancellationToken ct)
    {
        var (githubManifest, version) = await FetchGitHubManifestAsync(target, ct);
        if (githubManifest == null || version == null)
            return "无法从 GitHub 获取 manifest";

        _ = Task.Run(() => DownloadAndCacheAsync(version, target, githubManifest));
        return $"已触发 {version}/{target} 的缓存任务";
    }

    /// <summary>
    /// 从 GitHub 获取 manifest JSON 和版本号
    /// </summary>
    private async Task<(string? manifestJson, string? version)> FetchGitHubManifestAsync(string target, CancellationToken ct)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("GitHubUpdate");
            var url = string.Format(GitHubManifestUrlTemplate, target);
            using var response = await client.GetAsync(url, ct);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("GitHub manifest fetch failed: {Status} for {Target}", response.StatusCode, target);
                return (null, null);
            }

            var json = await response.Content.ReadAsStringAsync(ct);

            // 解析 version 字段
            using var doc = JsonDocument.Parse(json);
            var version = doc.RootElement.TryGetProperty("version", out var vProp) ? vProp.GetString() : null;

            return (json, version);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to fetch GitHub manifest for {Target}", target);
            return (null, null);
        }
    }

    /// <summary>
    /// 下载安装包 → 上传 COS → 更新缓存记录。
    /// 使用 SemaphoreSlim 保证同一 (version, target) 只有一个下载任务。
    /// </summary>
    private async Task DownloadAndCacheAsync(string version, string target, string githubManifestJson)
    {
        var lockKey = $"{version}_{target}";
        var semaphore = _locks.GetOrAdd(lockKey, _ => new SemaphoreSlim(1, 1));

        if (!await semaphore.WaitAsync(0))
        {
            _logger.LogInformation("Skip duplicate download for {Key}", lockKey);
            return;
        }

        try
        {
            // 再次检查数据库（双重检查锁）
            var existing = await _db.DesktopUpdateCaches
                .Find(x => x.Version == version && x.Target == target && x.Status == "ready")
                .FirstOrDefaultAsync(CancellationToken.None);

            if (existing != null) return;

            // 解析 manifest 获取下载 URL 和签名
            using var doc = JsonDocument.Parse(githubManifestJson);
            var root = doc.RootElement;

            string? packageUrl = null;
            string? signature = null;

            // Tauri updater manifest 格式：{ "version": "x.y.z", "platforms": { "target": { "url": "...", "signature": "..." } } }
            if (root.TryGetProperty("platforms", out var platforms) &&
                platforms.TryGetProperty(target, out var platform))
            {
                packageUrl = platform.TryGetProperty("url", out var u) ? u.GetString() : null;
                signature = platform.TryGetProperty("signature", out var s) ? s.GetString() : null;
            }
            // 也支持扁平格式：{ "version": "x.y.z", "url": "...", "signature": "..." }
            else
            {
                packageUrl = root.TryGetProperty("url", out var u) ? u.GetString() : null;
                signature = root.TryGetProperty("signature", out var s) ? s.GetString() : null;
            }

            if (string.IsNullOrEmpty(packageUrl))
            {
                _logger.LogWarning("No package URL found in manifest for {Version}/{Target}", version, target);
                await UpsertCacheAsync(version, target, githubManifestJson, null, null, "failed", "manifest 中未找到下载 URL", null, packageUrl, signature);
                return;
            }

            // 创建/更新为 downloading 状态
            await UpsertCacheAsync(version, target, githubManifestJson, null, null, "downloading", null, null, packageUrl, signature);

            // 下载安装包
            _logger.LogInformation("Downloading update package: {Url}", packageUrl);
            var client = _httpClientFactory.CreateClient("GitHubUpdate");
            using var pkgResponse = await client.GetAsync(packageUrl, CancellationToken.None);

            if (!pkgResponse.IsSuccessStatusCode)
            {
                await UpsertCacheAsync(version, target, githubManifestJson, null, null, "failed",
                    $"下载失败: HTTP {pkgResponse.StatusCode}", null, packageUrl, signature);
                return;
            }

            var bytes = await pkgResponse.Content.ReadAsByteArrayAsync(CancellationToken.None);
            _logger.LogInformation("Downloaded {Size} bytes for {Version}/{Target}", bytes.Length, version, target);

            // 推断 MIME 类型
            var mime = "application/octet-stream";
            if (packageUrl.EndsWith(".msi", StringComparison.OrdinalIgnoreCase)) mime = "application/x-msi";
            else if (packageUrl.EndsWith(".nsis.zip", StringComparison.OrdinalIgnoreCase)) mime = "application/zip";
            else if (packageUrl.EndsWith(".dmg", StringComparison.OrdinalIgnoreCase)) mime = "application/x-apple-diskimage";
            else if (packageUrl.EndsWith(".AppImage", StringComparison.OrdinalIgnoreCase)) mime = "application/x-executable";
            else if (packageUrl.EndsWith(".deb", StringComparison.OrdinalIgnoreCase)) mime = "application/vnd.debian.binary-package";
            else if (packageUrl.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase)) mime = "application/gzip";

            // 上传到 COS
            var stored = await _storage.SaveAsync(bytes, mime, CancellationToken.None, CosAssetDomain, CosAssetType);
            _logger.LogInformation("Uploaded to COS: {Url}", stored.Url);

            // 生成加速后的 manifest（替换 url 为 COS 地址）
            var acceleratedManifest = BuildAcceleratedManifest(githubManifestJson, target, stored.Url);

            // 更新为 ready
            await UpsertCacheAsync(version, target, githubManifestJson, stored.Url, acceleratedManifest,
                "ready", null, bytes.Length, packageUrl, signature);

            _logger.LogInformation("Update cache ready for {Version}/{Target}", version, target);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to cache update for {Version}/{Target}", version, target);
            try
            {
                await UpsertCacheAsync(version, target, githubManifestJson, null, null, "failed",
                    ex.Message, null, null, null);
            }
            catch { /* 忽略二次失败 */ }
        }
        finally
        {
            semaphore.Release();
            // 清理不再需要的信号量
            _locks.TryRemove(lockKey, out _);
        }
    }

    /// <summary>
    /// 构建加速 manifest：将 url 替换为 COS 地址，保留 signature 等其他字段
    /// </summary>
    private static string BuildAcceleratedManifest(string originalJson, string target, string cosUrl)
    {
        using var doc = JsonDocument.Parse(originalJson);
        var root = doc.RootElement;

        using var ms = new System.IO.MemoryStream();
        using (var writer = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = true }))
        {
            writer.WriteStartObject();

            foreach (var prop in root.EnumerateObject())
            {
                if (prop.Name == "platforms" && prop.Value.ValueKind == JsonValueKind.Object)
                {
                    writer.WritePropertyName("platforms");
                    writer.WriteStartObject();
                    foreach (var platProp in prop.Value.EnumerateObject())
                    {
                        writer.WritePropertyName(platProp.Name);
                        if (platProp.Name == target && platProp.Value.ValueKind == JsonValueKind.Object)
                        {
                            writer.WriteStartObject();
                            foreach (var field in platProp.Value.EnumerateObject())
                            {
                                if (field.Name == "url")
                                    writer.WriteString("url", cosUrl);
                                else
                                    field.WriteTo(writer);
                            }
                            writer.WriteEndObject();
                        }
                        else
                        {
                            platProp.Value.WriteTo(writer);
                        }
                    }
                    writer.WriteEndObject();
                }
                else if (prop.Name == "url")
                {
                    // 扁平格式
                    writer.WriteString("url", cosUrl);
                }
                else
                {
                    prop.WriteTo(writer);
                }
            }

            writer.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(ms.ToArray());
    }

    /// <summary>
    /// Upsert 缓存记录（按 version + target）
    /// </summary>
    private async Task UpsertCacheAsync(
        string version, string target, string originalJson,
        string? cosUrl, string? acceleratedJson,
        string status, string? error, long? sizeBytes,
        string? githubPackageUrl, string? signature)
    {
        var now = DateTime.UtcNow;
        var filter = Builders<DesktopUpdateCache>.Filter.And(
            Builders<DesktopUpdateCache>.Filter.Eq(x => x.Version, version),
            Builders<DesktopUpdateCache>.Filter.Eq(x => x.Target, target));

        var update = Builders<DesktopUpdateCache>.Update
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.CreatedAt, now)
            .Set(x => x.OriginalManifestJson, originalJson)
            .Set(x => x.CosPackageUrl, cosUrl)
            .Set(x => x.AcceleratedManifestJson, acceleratedJson)
            .Set(x => x.Status, status)
            .Set(x => x.ErrorMessage, error)
            .Set(x => x.PackageSizeBytes, sizeBytes)
            .Set(x => x.GithubPackageUrl, githubPackageUrl)
            .Set(x => x.Signature, signature)
            .Set(x => x.UpdatedAt, now);

        await _db.DesktopUpdateCaches.UpdateOneAsync(
            filter, update, new UpdateOptions { IsUpsert = true }, CancellationToken.None);
    }
}
