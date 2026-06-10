namespace PrdAgent.Core.Models;

/// <summary>
/// MD 转 PPT 自定义模板：用户上传参考图，视觉模型提取风格规范（配色/字体气质/版式特征），
/// 生成时该规范作为 AI 的设计参照（产物即体验：模板 = 生成参照，不是 CSS 换皮）。
/// 不存原图（体积/隐私），只存提取出的文字规范 + 两个主色（UI 色点展示用）。
/// </summary>
public class MdToPptTemplate
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = string.Empty;

    /// <summary>模板名（用户命名，默认取参考图文件名）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>视觉模型从参考图提取的风格规范全文（生成时拼入系统提示词）</summary>
    public string StyleSpec { get; set; } = string.Empty;

    /// <summary>背景主色（hex，UI 色点展示）</summary>
    public string BgColor { get; set; } = "#1a1a1e";

    /// <summary>强调色（hex，UI 色点描边）</summary>
    public string AccentColor { get; set; } = "#a78bfa";

    /// <summary>提取所用模型（可观测）</summary>
    public string? ExtractModel { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
