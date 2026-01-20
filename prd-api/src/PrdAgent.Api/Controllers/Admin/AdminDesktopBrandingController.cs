using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - Desktop 品牌配置（名称/登录图标 key）
/// </summary>
[ApiController]
[Route("api/v1/admin/settings/desktop")]
[Authorize]
[AdminController("admin-assets", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public class AdminDesktopBrandingController : ControllerBase
{
    private readonly MongoDbContext _db;

    // 与 Desktop 资源规则对齐：key 仅允许“文件名”（不允许子目录），且必须全小写
    private static readonly Regex FileNameKeyRegex = new(@"^[a-z0-9][a-z0-9_\-.]{0,127}$", RegexOptions.Compiled);

    public AdminDesktopBrandingController(MongoDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<DesktopBrandingResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var settings = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct)
                       ?? new AppSettings { Id = "global", EnablePromptCache = true, UpdatedAt = DateTime.UtcNow };

        var resp = DesktopBrandingResponse.From(settings);
        return Ok(ApiResponse<DesktopBrandingResponse>.Ok(resp));
    }

    [HttpPut]
    [ProducesResponseType(typeof(ApiResponse<DesktopBrandingResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Put([FromBody] UpdateDesktopBrandingRequest request, CancellationToken ct)
    {
        var name = (request.DesktopName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            name = "PRD Agent";
        }
        if (name.Length > 64)
        {
            name = name[..64];
        }

        var subtitle = (request.DesktopSubtitle ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(subtitle))
        {
            subtitle = "智能PRD解读助手";
        }
        if (subtitle.Length > 64)
        {
            subtitle = subtitle[..64];
        }

        var windowTitle = (request.WindowTitle ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(windowTitle))
        {
            windowTitle = name;
        }
        if (windowTitle.Length > 64)
        {
            windowTitle = windowTitle[..64];
        }

        var key = (request.LoginIconKey ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(key))
        {
            key = "login_icon.png";
        }
        if (!FileNameKeyRegex.IsMatch(key))
        {
            return Ok(ApiResponse<DesktopBrandingResponse>.Fail("INVALID_FORMAT", "loginIconKey 仅允许文件名（小写字母/数字/下划线/中划线/点），且不允许包含子目录"));
        }

        var bgKey = (request.LoginBackgroundKey ?? string.Empty).Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(bgKey) && !FileNameKeyRegex.IsMatch(bgKey))
        {
            return Ok(ApiResponse<DesktopBrandingResponse>.Fail("INVALID_FORMAT", "loginBackgroundKey 仅允许文件名（小写字母/数字/下划线/中划线/点），且不允许包含子目录；为空表示使用内置背景"));
        }

        var now = DateTime.UtcNow;
        var update = Builders<AppSettings>.Update
            .Set(x => x.DesktopName, name)
            .Set(x => x.DesktopSubtitle, subtitle)
            .Set(x => x.DesktopWindowTitle, windowTitle)
            .Set(x => x.DesktopLoginIconKey, key)
            .Set(x => x.DesktopLoginBackgroundKey, bgKey)
            .Set(x => x.UpdatedAt, now);

        await _db.AppSettings.UpdateOneAsync(x => x.Id == "global", update, new UpdateOptions { IsUpsert = true }, ct);

        // 刷新缓存
        var settingsService = HttpContext.RequestServices.GetRequiredService<IAppSettingsService>();
        await settingsService.RefreshAsync(ct);

        var updated = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct)
                     ?? new AppSettings { Id = "global", EnablePromptCache = true, UpdatedAt = now };

        return Ok(ApiResponse<DesktopBrandingResponse>.Ok(DesktopBrandingResponse.From(updated)));
    }
}


