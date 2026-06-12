namespace PrdAgent.Core.Models;

/// <summary>产品管理应用级设置。</summary>
public class ProductAgentSettings
{
    public const string SingletonId = "product-agent-settings";

    public string Id { get; set; } = SingletonId;
    public List<string> AdminIds { get; set; } = new();
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string UpdatedBy { get; set; } = string.Empty;
}
