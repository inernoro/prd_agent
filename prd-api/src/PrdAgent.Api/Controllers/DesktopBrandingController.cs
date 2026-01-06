using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

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
    private static readonly Regex FileNameKeyRegex = new(@"^[a-z0-9][a-z0-9_\-.]{0,127}$", RegexOptions.Compiled);

    public DesktopBrandingController(IAppSettingsService settingsService)
    {
        _settingsService = settingsService;
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<DesktopBrandingResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var settings = await _settingsService.GetSettingsAsync(ct);
        var resp = DesktopBrandingResponse.From(settings);

        // 兜底校验：避免错误配置注入路径（只允许文件名、全小写）
        var key = (resp.LoginIconKey ?? string.Empty).Trim().ToLowerInvariant();
        resp.LoginIconKey = FileNameKeyRegex.IsMatch(key) ? key : "login_icon.png";

        var bgKey = (resp.LoginBackgroundKey ?? string.Empty).Trim().ToLowerInvariant();
        // 默认背景：若未配置，则使用 bg.png（要求资源侧确保存在）
        if (string.IsNullOrWhiteSpace(bgKey)) bgKey = "bg.png";
        resp.LoginBackgroundKey = FileNameKeyRegex.IsMatch(bgKey) ? bgKey : "bg.png";

        return Ok(ApiResponse<DesktopBrandingResponse>.Ok(resp));
    }
}


