using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models.CcasAgent;

/// <summary>
/// 赋码采集关联系统智能体 — 设备素材库条目。
/// 一条记录对应一张已生成入库的产线设备图片，按设备类型 + 风格分类，供流程图绘制时复用。
/// </summary>
[AppOwnership(AppNames.CcasAgent, AppNames.CcasAgentDisplay, IsPrimary = true)]
public class CcasEquipmentAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>素材所有者（创建人）UserId</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>设备类型/中文名（如：裹包机 / 龙门架 / 工业相机 / 工控机 / 灌装车间 / 箱码垛工位）</summary>
    public string EquipmentType { get; set; } = string.Empty;

    /// <summary>风格预设 key（见 CcasEquipmentStyles）</summary>
    public string StyleKey { get; set; } = string.Empty;

    /// <summary>实际送给生图模型的 prompt（含风格修饰词）</summary>
    public string Prompt { get; set; } = string.Empty;

    /// <summary>用户原始输入（用于二次微调）</summary>
    public string? OriginalUserInput { get; set; }

    /// <summary>素材主图 URL（可能带平台水印；前端展示用）</summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>原图无水印 URL（供流程图节点引用，避免水印叠加）。无水印场景下与 Url 相同</summary>
    public string? OriginalUrl { get; set; }

    public string Mime { get; set; } = "image/png";
    public int Width { get; set; }
    public int Height { get; set; }
    public long SizeBytes { get; set; }

    /// <summary>使用的生图模型名（来自 GatewayResolution，用于 AI 模型可见性原则）</summary>
    public string? Model { get; set; }
    public string? PlatformName { get; set; }

    /// <summary>是否被收藏（个人偏好；同设备多风格下用来快速筛优选）</summary>
    public bool IsFavorite { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>风格预设清单（前端选择 + 后端 prompt 注入）。修改时同步前端 ccasEquipmentStyles。</summary>
public static class CcasEquipmentStyles
{
    public record StylePreset(string Key, string Label, string PromptHint);

    public static readonly IReadOnlyList<StylePreset> Presets = new List<StylePreset>
    {
        new("isometric-3d",
            "等距 3D 拟物",
            "isometric 3D illustration, industrial equipment, photorealistic materials, soft studio lighting, clean white background, no logo, no text, no watermark, technical product render"),
        new("industrial-line",
            "工业线稿",
            "clean industrial line drawing, black outline on white background, technical schematic style, equipment blueprint, no shading, no text, no watermark"),
        new("flat-cartoon",
            "卡通扁平",
            "flat cartoon vector illustration, friendly mascot style, simplified shapes, vibrant solid colors, clean background, no text, no watermark"),
        new("photorealistic",
            "高保真写实",
            "photorealistic studio shot, industrial equipment on factory floor, soft diffused lighting, detailed materials and textures, no text, no watermark"),
        new("vector-sop",
            "矢量 SOP 风",
            "minimal vector icon style, two-tone flat design, technical SOP manual illustration, clean lines, white background, no text, no watermark"),
        new("3d-render",
            "3D 渲染",
            "high-quality 3D rendered industrial equipment, octane render, studio lighting, neutral grey background, photo-realistic textures, no text, no watermark"),
        new("user-upload",
            "用户上传",
            "user uploaded equipment photograph or illustration"),
    };

    public static StylePreset? FindByKey(string key)
        => Presets.FirstOrDefault(p => string.Equals(p.Key, key, StringComparison.OrdinalIgnoreCase));
}
