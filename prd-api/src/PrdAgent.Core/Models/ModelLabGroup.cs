namespace PrdAgent.Core.Models;

/// <summary>
/// 大模型实验室 - 实验室分组（仅实验室内部使用，与其它模块无关）
/// </summary>
public class ModelLabGroup
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    /// <summary>所属管理员（UserId）</summary>
    public string OwnerAdminId { get; set; } = string.Empty;

    public string Name { get; set; } = "未命名分组";

    public List<ModelLabSelectedModel> Models { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


