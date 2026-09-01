namespace PrdAgent.Core.Models;

/// <summary>MAP 视觉创作的业务菜单。只引用网关公开模型，不保存供应商或路由配置。</summary>
public sealed class VisualModelPolicy
{
    public int Revision { get; set; }
    public string DefaultModelId { get; set; } = string.Empty;
    public List<VisualModelEntry> Models { get; set; } = [];
    public DateTime? UpdatedAt { get; set; }
    public string? UpdatedBy { get; set; }

    public string? Validate()
    {
        if (Revision < 0) return "配置版本无效，请刷新后重试。";
        if (Models is null || Models.Count is < 1 or > 30) return "请选择 1 至 30 个开放模型。";
        if (Models.Any(x => x is null || string.IsNullOrWhiteSpace(x.ModelId) || x.ModelId.Length > 200
                            || (x.Description?.Length ?? 0) > 500)) return "模型标识或业务说明不符合要求。";
        if (Models.Select(x => x.ModelId).Distinct(StringComparer.Ordinal).Count() != Models.Count)
            return "开放模型不能重复。";
        return Models.Any(x => x.ModelId == DefaultModelId) ? null : "默认模型必须在开放列表中。";
    }

    public string? Select(string? requestedModelId)
    {
        var selected = string.IsNullOrWhiteSpace(requestedModelId) ? DefaultModelId : requestedModelId.Trim();
        return Models?.Any(x => x is not null && x.ModelId == selected) == true ? selected : null;
    }
}

public sealed class VisualModelEntry
{
    public string ModelId { get; set; } = string.Empty;
    /// <summary>保存时由网关目录补全；故障时用于保留可辨认的菜单，不用于路由。</summary>
    public string DisplayName { get; set; } = string.Empty;
    public string? Description { get; set; }
}
