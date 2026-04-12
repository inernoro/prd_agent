using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 存储同步 — 系统资产跨 Provider 迁移（从旧域名 HTTP 下载 → 上传到当前 Provider）。
/// </summary>
[ApiController]
[Route("api/storage")]
[Authorize]
[AdminController("settings", AdminPermissionCatalog.SettingsWrite)]
public class StorageSyncController : ControllerBase
{
    private readonly IAssetStorage _storage;
    private readonly MongoDbContext _db;
    private readonly IConfiguration _cfg;
    private readonly ILogger<StorageSyncController> _logger;
    private readonly IHttpClientFactory _httpFactory;

    public StorageSyncController(
        IAssetStorage storage,
        MongoDbContext db,
        IConfiguration cfg,
        ILogger<StorageSyncController> logger,
        IHttpClientFactory httpFactory)
    {
        _storage = storage;
        _db = db;
        _cfg = cfg;
        _logger = logger;
        _httpFactory = httpFactory;
    }

    /// <summary>
    /// 查看系统资产清单及其在当前 Provider 中的存在状态。
    /// </summary>
    [HttpGet("system-assets")]
    public async Task<IActionResult> ListSystemAssets(CancellationToken ct)
    {
        var results = new List<object>();
        foreach (var path in SystemAssetManifest.All())
        {
            var exists = await _storage.ExistsAsync(path, ct);
            var url = _storage.BuildUrlForKey(path);
            results.Add(new { path, exists, url });
        }

        var total = results.Count;
        var present = results.Count(r => (bool)r.GetType().GetProperty("exists")!.GetValue(r)!);

        return Ok(ApiResponse<object>.Ok(new
        {
            total,
            present,
            missing = total - present,
            items = results
        }));
    }

    /// <summary>
    /// 从源域名同步系统资产到当前 Provider。
    /// sourceBaseUrl 示例：https://i.miduo.org（旧 COS 域名）
    /// </summary>
    [HttpPost("sync-system-assets")]
    public async Task<IActionResult> SyncSystemAssets(
        [FromBody] SyncSystemAssetsRequest request,
        CancellationToken ct)
    {
        var sourceBase = (request.SourceBaseUrl ?? string.Empty).Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(sourceBase))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "sourceBaseUrl 不能为空"));

        var dryRun = request.DryRun;
        var provider = (_cfg["ASSETS_PROVIDER"] ?? "tencentCos").Trim();
        var http = _httpFactory.CreateClient();
        http.Timeout = TimeSpan.FromSeconds(30);

        var results = new List<object>();
        var synced = 0;
        var skipped = 0;
        var failed = 0;

        foreach (var path in SystemAssetManifest.All())
        {
            try
            {
                // 检查目标是否已存在
                var exists = await _storage.ExistsAsync(path, ct);
                if (exists && !request.Force)
                {
                    results.Add(new { path, status = "skipped", reason = "already_exists" });
                    skipped++;
                    continue;
                }

                if (dryRun)
                {
                    results.Add(new { path, status = "would_sync", source = $"{sourceBase}/{path}" });
                    continue;
                }

                // 从源下载
                var sourceUrl = $"{sourceBase}/{path}";
                using var resp = await http.GetAsync(sourceUrl, ct);
                if (!resp.IsSuccessStatusCode)
                {
                    results.Add(new { path, status = "failed", reason = $"source_http_{(int)resp.StatusCode}", source = sourceUrl });
                    failed++;
                    continue;
                }

                var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
                if (bytes.Length == 0)
                {
                    results.Add(new { path, status = "failed", reason = "empty_content" });
                    failed++;
                    continue;
                }

                var mime = resp.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";

                // 上传到当前 Provider
                RegistryAssetStorage.OverrideNextScope("system");
                await _storage.UploadToKeyAsync(path, bytes, mime, ct);
                var targetUrl = _storage.BuildUrlForKey(path);

                results.Add(new { path, status = "synced", sizeBytes = bytes.Length, mime, targetUrl });
                synced++;

                _logger.LogInformation("SystemAsset synced: {Path} ({Size} bytes) from {Source}",
                    path, bytes.Length, sourceBase);
            }
            catch (Exception ex)
            {
                results.Add(new { path, status = "failed", reason = ex.Message });
                failed++;
                _logger.LogWarning(ex, "SystemAsset sync failed: {Path}", path);
            }
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            provider,
            sourceBaseUrl = sourceBase,
            dryRun,
            summary = new { total = SystemAssetManifest.Count, synced, skipped, failed },
            items = results
        }));
    }

    /// <summary>
    /// 同步用户头像：扫描 users 集合中所有有 AvatarFileName 的用户，
    /// 从源域名下载头像文件并上传到当前 Provider。
    /// </summary>
    [HttpPost("sync-user-avatars")]
    public async Task<IActionResult> SyncUserAvatars(
        [FromBody] SyncSystemAssetsRequest request,
        CancellationToken ct)
    {
        var sourceBase = (request.SourceBaseUrl ?? string.Empty).Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(sourceBase))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "sourceBaseUrl 不能为空"));

        var provider = (_cfg["ASSETS_PROVIDER"] ?? "tencentCos").Trim();
        var http = _httpFactory.CreateClient();
        http.Timeout = TimeSpan.FromSeconds(30);

        // 扫描所有有头像的用户
        var users = await _db.Users
            .Find(u => u.AvatarFileName != null && u.AvatarFileName != "")
            .Project(u => new { u.Username, u.AvatarFileName })
            .ToListAsync(ct);

        var results = new List<object>();
        var synced = 0;
        var skipped = 0;
        var failed = 0;

        foreach (var user in users)
        {
            var fileName = (user.AvatarFileName ?? "").Trim().ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(fileName)) continue;

            var path = $"{AvatarUrlBuilder.AvatarPathPrefix}/{fileName}";
            try
            {
                var exists = await _storage.ExistsAsync(path, ct);
                if (exists && !request.Force)
                {
                    results.Add(new { path, user = user.Username, status = "skipped", reason = "already_exists" });
                    skipped++;
                    continue;
                }

                if (request.DryRun)
                {
                    results.Add(new { path, user = user.Username, status = "would_sync" });
                    continue;
                }

                var sourceUrl = $"{sourceBase}/{path}";
                using var resp = await http.GetAsync(sourceUrl, ct);
                if (!resp.IsSuccessStatusCode)
                {
                    results.Add(new { path, user = user.Username, status = "failed", reason = $"source_http_{(int)resp.StatusCode}" });
                    failed++;
                    continue;
                }

                var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
                var mime = resp.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";

                RegistryAssetStorage.OverrideNextScope("user");
                await _storage.UploadToKeyAsync(path, bytes, mime, ct);

                results.Add(new { path, user = user.Username, status = "synced", sizeBytes = bytes.Length });
                synced++;
            }
            catch (Exception ex)
            {
                results.Add(new { path, user = user.Username, status = "failed", reason = ex.Message });
                failed++;
            }
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            provider,
            sourceBaseUrl = sourceBase,
            dryRun = request.DryRun,
            summary = new { total = users.Count, synced, skipped, failed },
            items = results
        }));
    }

    public class SyncSystemAssetsRequest
    {
        /// <summary>源域名（如 https://i.miduo.org）</summary>
        public string SourceBaseUrl { get; set; } = string.Empty;

        /// <summary>仅预览不执行</summary>
        public bool DryRun { get; set; }

        /// <summary>即使目标已存在也覆盖</summary>
        public bool Force { get; set; }
    }
}
