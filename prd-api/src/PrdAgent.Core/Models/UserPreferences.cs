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
    /// 数组中字符串 "---" 表示分隔横杆（可出现多次，连续的会在渲染时合并）。
    /// 为空时按后端菜单目录 + 分组默认顺序渲染。
    /// </summary>
    public List<string>? NavOrder { get; set; }

    /// <summary>
    /// 被用户隐藏的导航项 appKey 列表。隐藏后不在左侧导航显示，但保留页面访问权。
    /// </summary>
    public List<string>? NavHidden { get; set; }

    /// <summary>
    /// 主题/皮肤配置
    /// </summary>
    public ThemeConfig? ThemeConfig { get; set; }

    /// <summary>
    /// 视觉代理偏好设置
    /// </summary>
    public VisualAgentPreferences? VisualAgentPreferences { get; set; }

    /// <summary>
    /// 文学创作 Agent 偏好设置
    /// </summary>
    public LiteraryAgentPreferences? LiteraryAgentPreferences { get; set; }

    /// <summary>
    /// 周报 Agent 偏好设置
    /// </summary>
    public ReportAgentPreferences? ReportAgentPreferences { get; set; }

    /// <summary>
    /// Agent Switcher / 命令面板偏好（置顶、最近访问、使用统计）。
    /// 之前仅存 sessionStorage，换分支 / 浏览器 / 设备都会丢；改为云端同步。
    /// </summary>
    public AgentSwitcherPreferences? AgentSwitcherPreferences { get; set; }

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
/// 文学创作 Agent 偏好设置
/// </summary>
[BsonIgnoreExtraElements]
public class LiteraryAgentPreferences
{
    /// <summary>用户选择的生图模型池 ID</summary>
    public string? ImageModelId { get; set; }

    /// <summary>用户选择的文生提示词（对话/标记生成）模型池 ID</summary>
    public string? ChatModelId { get; set; }

    /// <summary>
    /// 配图锚点教程气泡是否已看过。
    /// 用户点击"知道啦"后置为 true，之后不再弹出。
    /// </summary>
    public bool? AnchorTutorialSeen { get; set; }
}

/// <summary>
/// 周报 Agent 偏好设置
/// </summary>
[BsonIgnoreExtraElements]
public class ReportAgentPreferences
{
    /// <summary>
    /// 是否启用 MAP 平台工作记录作为 AI 周报生成上下文
    /// </summary>
    public bool MapPlatformSourceEnabled { get; set; } = true;

    /// <summary>
    /// 日常记录页的自定义快捷标签（用户级）
    /// </summary>
    public List<string>? DailyLogCustomTags { get; set; }

    /// <summary>
    /// AI 生成周报草稿的自定义 Prompt（为空时使用系统默认 Prompt）
    /// </summary>
    public string? WeeklyReportPrompt { get; set; }
}

/// <summary>
/// Agent Switcher / 命令面板偏好（置顶 / 最近 / 常用）
/// </summary>
[BsonIgnoreExtraElements]
public class AgentSwitcherPreferences
{
    /// <summary>已置顶条目的 id 列表（上限约 20）</summary>
    public List<string>? PinnedIds { get; set; }

    /// <summary>最近访问记录（上限 20）</summary>
    public List<AgentSwitcherRecentVisit>? RecentVisits { get; set; }

    /// <summary>累计启动次数（id → count）</summary>
    public Dictionary<string, int>? UsageCounts { get; set; }
}

/// <summary>
/// Agent Switcher 最近访问记录项
/// </summary>
[BsonIgnoreExtraElements]
public class AgentSwitcherRecentVisit
{
    /// <summary>稳定 id（Agent key / toolbox id / utility id）</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>兼容旧字段：Agent key（非 Agent 为空）</summary>
    public string AgentKey { get; set; } = string.Empty;
    /// <summary>条目展示名</summary>
    public string AgentName { get; set; } = string.Empty;
    /// <summary>副标题</summary>
    public string Title { get; set; } = string.Empty;
    /// <summary>跳转路径</summary>
    public string Path { get; set; } = string.Empty;
    /// <summary>Lucide 图标名（可选）</summary>
    public string? Icon { get; set; }
    /// <summary>访问时间戳（ms since epoch）</summary>
    public long Timestamp { get; set; }
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
