using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 大模型实验室 - 自定义模型集合（可复用的一键加入列表）
/// </summary>
[AppOwnership(AppNames.ModelLab, AppNames.ModelLabDisplay, IsPrimary = true)]
public class ModelLabModelSet
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string OwnerAdminId { get; set; } = string.Empty;

    public string Name { get; set; } = "未命名集合";

    public List<ModelLabSelectedModel> Models { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


