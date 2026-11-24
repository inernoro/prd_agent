namespace PrdAgent.Api.Models.Responses;

/// <summary>首页资源单项（用于列表/上传返回）。</summary>
public class HomepageAssetDto
{
    public string Slot { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string Mime { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public DateTime? UpdatedAt { get; set; }

    /// <summary>生成这张图用的提示词（手工上传的为 null）。管理端用它回填生成弹窗。</summary>
    public string? Prompt { get; set; }
}
