using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

public class DesktopBrandingResponse
{
    public string DesktopName { get; set; } = "PRD Agent";
    public string LoginIconKey { get; set; } = "login_icon.png";
    public string LoginBackgroundKey { get; set; } = "";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public static DesktopBrandingResponse From(AppSettings settings)
    {
        var name = (settings.DesktopName ?? string.Empty).Trim();
        var key = (settings.DesktopLoginIconKey ?? string.Empty).Trim().ToLowerInvariant();
        var bgKey = (settings.DesktopLoginBackgroundKey ?? string.Empty).Trim().ToLowerInvariant();

        return new DesktopBrandingResponse
        {
            DesktopName = string.IsNullOrWhiteSpace(name) ? "PRD Agent" : name,
            LoginIconKey = string.IsNullOrWhiteSpace(key) ? "login_icon.png" : key,
            LoginBackgroundKey = string.IsNullOrWhiteSpace(bgKey) ? string.Empty : bgKey,
            UpdatedAt = settings.UpdatedAt,
        };
    }
}


