using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

public class DesktopBrandingResponse
{
    public string DesktopName { get; set; } = "PRD Agent";
    public string DesktopSubtitle { get; set; } = "智能PRD解读助手";
    public string WindowTitle { get; set; } = "PRD Agent";
    public string LoginIconKey { get; set; } = "login_icon.png";
    public string LoginBackgroundKey { get; set; } = "";
    public string? LoginIconUrl { get; set; } // 完整 URL（带回退逻辑）
    public string? LoginBackgroundUrl { get; set; } // 完整 URL（带回退逻辑）
    public Dictionary<string, string> Assets { get; set; } = new(); // 所有资源的 key -> URL 映射（带回退逻辑）
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public static DesktopBrandingResponse From(AppSettings settings)
    {
        var name = (settings.DesktopName ?? string.Empty).Trim();
        var subtitle = (settings.DesktopSubtitle ?? string.Empty).Trim();
        var windowTitle = (settings.DesktopWindowTitle ?? string.Empty).Trim();
        var key = (settings.DesktopLoginIconKey ?? string.Empty).Trim().ToLowerInvariant();
        var bgKey = (settings.DesktopLoginBackgroundKey ?? string.Empty).Trim().ToLowerInvariant();

        var nameFinal = string.IsNullOrWhiteSpace(name) ? "PRD Agent" : name;
        var subtitleFinal = string.IsNullOrWhiteSpace(subtitle) ? "智能PRD解读助手" : subtitle;
        var windowTitleFinal = string.IsNullOrWhiteSpace(windowTitle) ? nameFinal : windowTitle;

        return new DesktopBrandingResponse
        {
            DesktopName = nameFinal,
            DesktopSubtitle = subtitleFinal,
            WindowTitle = windowTitleFinal,
            LoginIconKey = string.IsNullOrWhiteSpace(key) ? "login_icon.png" : key,
            LoginBackgroundKey = string.IsNullOrWhiteSpace(bgKey) ? string.Empty : bgKey,
            UpdatedAt = settings.UpdatedAt,
        };
    }
}


