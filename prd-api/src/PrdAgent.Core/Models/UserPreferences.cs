using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 用户偏好设置（每个用户一条记录，userId 作为主键）
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
[BsonIgnoreExtraElements]
public class UserPreferences
{
    /// <summary>用户 ID（作为 MongoDB _id）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 导航项排序（存储导航项 key 的有序列表）。
    /// 仅存储用户自定义的顺序，不存在的导航项会追加到末尾。
    /// </summary>
    public List<string>? NavOrder { get; set; }

    /// <summary>
    /// 主题/皮肤配置
    /// </summary>
    public ThemeConfig? ThemeConfig { get; set; }

    /// <summary>
    /// 视觉代理偏好设置
    /// </summary>
    public VisualAgentPreferences? VisualAgentPreferences { get; set; }

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 主题/皮肤配置
/// </summary>
[BsonIgnoreExtraElements]
public class ThemeConfig
{
    /// <summary>版本号，用于数据迁移</summary>
    public int Version { get; set; } = 1;

    /// <summary>色深级别：darker | default | lighter</summary>
    public string ColorDepth { get; set; } = "default";

    /// <summary>透明度级别：solid | default | translucent</summary>
    public string Opacity { get; set; } = "default";

    /// <summary>是否启用全局 glow 效果</summary>
    public bool EnableGlow { get; set; } = true;

    /// <summary>侧边栏玻璃效果模式：auto | always | never</summary>
    public string SidebarGlass { get; set; } = "always";

    /// <summary>性能模式：auto | quality | performance</summary>
    public string PerformanceMode { get; set; } = "performance";
}

/// <summary>
/// 视觉代理偏好设置
/// </summary>
[BsonIgnoreExtraElements]
public class VisualAgentPreferences
{
    /// <summary>是否自动选择模型（true 时使用后端默认模型）</summary>
    public bool ModelAuto { get; set; } = true;

    /// <summary>用户手动选择的模型 ID（仅当 ModelAuto=false 时有效）</summary>
    public string? ModelId { get; set; }

    /// <summary>
    /// 生成类型筛选（默认 'all' 显示所有类型的模型）
    /// 可选值：all | text2img | img2img | vision
    /// </summary>
    public string? GenerationType { get; set; }

    /// <summary>是否启用直连模式（跳过 prompt 解析，默认 true）</summary>
    public bool DirectPrompt { get; set; } = true;

    /// <summary>用户自定义快捷指令（最多 10 个）</summary>
    public List<QuickActionConfig>? QuickActions { get; set; }
}

/// <summary>
/// 快捷指令配置（用于视觉创作图片快捷操作栏的 DIY 指令）
/// </summary>
public class QuickActionConfig
{
    /// <summary>唯一标识</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>显示名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>提示词模板</summary>
    public string Prompt { get; set; } = string.Empty;

    /// <summary>图标名称（lucide-react 图标 key，可选）</summary>
    public string? Icon { get; set; }
}
