namespace PrdAgent.Api.Models.Requests;

public class UpdateDesktopBrandingRequest
{
    public string DesktopName { get; set; } = "PRD Agent";
    public string DesktopSubtitle { get; set; } = "智能PRD解读助手";
    public string WindowTitle { get; set; } = "PRD Agent";
    public string LoginIconKey { get; set; } = "login_icon.png";
    public string LoginBackgroundKey { get; set; } = "";
}


