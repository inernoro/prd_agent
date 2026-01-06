using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// Desktop 客户端品牌配置（匿名可读）
/// </summary>
[ApiController]
[Route("api/v1/desktop/branding")]
[AllowAnonymous]
public class DesktopBrandingController : ControllerBase
{
    private readonly IAppSettingsService _settingsService;
    private readonly MongoDbContext _db;
    private static readonly Regex FileNameKeyRegex = new(@"^[a-z0-9][a-z0-9_\-.]{0,127}$", RegexOptions.Compiled);

    public DesktopBrandingController(IAppSettingsService settingsService, MongoDbContext db)
    {
        _settingsService = settingsService;
        _db = db;
    }

    /// <summary>
    /// 解析资源 URL（带回退逻辑）：先查指定 skin，再回退到默认
    /// </summary>
    private async Task<string?> ResolveAssetUrlAsync(string key, string? skin, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;

        var k = key.Trim().ToLowerInvariant();
        
        // 1. 先尝试找指定皮肤的资源
        if (!string.IsNullOrWhiteSpace(skin))
        {
            var s = skin.Trim().ToLowerInvariant();
            var skinAsset = await _db.DesktopAssets
                .Find(x => x.Key == k && x.Skin == s)
                .Limit(1)
                .FirstOrDefaultAsync(ct);
            if (skinAsset != null) return skinAsset.Url;
        }

        // 2. 回退到默认
        var defaultAsset = await _db.DesktopAssets
            .Find(x => x.Key == k && (x.Skin == null || x.Skin == string.Empty))
            .Limit(1)
            .FirstOrDefaultAsync(ct);
        return defaultAsset?.Url;
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<DesktopBrandingResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Get([FromQuery] string? skin, CancellationToken ct)
    {
        var settings = await _settingsService.GetSettingsAsync(ct);
        var resp = DesktopBrandingResponse.From(settings);

        // 兜底校验：避免错误配置注入路径（只允许文件名、全小写）
        var key = (resp.LoginIconKey ?? string.Empty).Trim().ToLowerInvariant();
        // 注意：key 现在不包含扩展名（例如 "login_icon" 而非 "login_icon.png"）
        // 移除扩展名（兼容旧配置）
        if (key.Contains('.')) key = key.Substring(0, key.LastIndexOf('.'));
        resp.LoginIconKey = FileNameKeyRegex.IsMatch(key) ? key : "login_icon";

        var bgKey = (resp.LoginBackgroundKey ?? string.Empty).Trim().ToLowerInvariant();
        // 移除扩展名（兼容旧配置）
        if (bgKey.Contains('.')) bgKey = bgKey.Substring(0, bgKey.LastIndexOf('.'));
        // 默认背景：若未配置，则使用 bg
        if (string.IsNullOrWhiteSpace(bgKey)) bgKey = "bg";
        resp.LoginBackgroundKey = FileNameKeyRegex.IsMatch(bgKey) ? bgKey : "bg";

        // 文本兜底与截断（避免异常配置导致 UI 爆布局）
        resp.DesktopName = string.IsNullOrWhiteSpace(resp.DesktopName) ? "PRD Agent" : resp.DesktopName.Trim();
        if (resp.DesktopName.Length > 64) resp.DesktopName = resp.DesktopName[..64];

        resp.DesktopSubtitle = string.IsNullOrWhiteSpace(resp.DesktopSubtitle) ? "智能PRD解读助手" : resp.DesktopSubtitle.Trim();
        if (resp.DesktopSubtitle.Length > 64) resp.DesktopSubtitle = resp.DesktopSubtitle[..64];

        resp.WindowTitle = string.IsNullOrWhiteSpace(resp.WindowTitle) ? resp.DesktopName : resp.WindowTitle.Trim();
        if (resp.WindowTitle.Length > 64) resp.WindowTitle = resp.WindowTitle[..64];

        // 规范化 skin 参数：white/dark，空字符串视为 null（使用默认）
        var skinNormalized = string.IsNullOrWhiteSpace(skin) ? null : skin.Trim().ToLowerInvariant();
        if (skinNormalized != null && skinNormalized != "white" && skinNormalized != "dark")
        {
            skinNormalized = null; // 不支持的 skin 回退到默认
        }

        // 解析完整 URL（带回退逻辑）
        // Desktop 端传入 skin 参数（white/dark），后端自动回退到默认
        resp.LoginIconUrl = await ResolveAssetUrlAsync(resp.LoginIconKey, skinNormalized, ct);
        resp.LoginBackgroundUrl = await ResolveAssetUrlAsync(resp.LoginBackgroundKey, skinNormalized, ct);

        // 获取所有资源的 URL 映射（key -> URL，使用指定的 skin）
        var allKeys = await _db.DesktopAssetKeys.Find(_ => true).ToListAsync(ct);
        var assets = new Dictionary<string, string>();
        foreach (var keyDef in allKeys)
        {
            var k = keyDef.Key ?? string.Empty;
            if (string.IsNullOrWhiteSpace(k)) continue;
            
            var url = await ResolveAssetUrlAsync(k, skinNormalized, ct);
            if (!string.IsNullOrWhiteSpace(url))
            {
                assets[k] = url;
            }
        }
        resp.Assets = assets;

        return Ok(ApiResponse<DesktopBrandingResponse>.Ok(resp));
    }
}


