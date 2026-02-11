using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 提示词设置（单例文档：Id 固定为 global）
/// - 每条配置项对应一个角色下的"提示词条目"：title + promptTemplate + order + promptKey
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class PromptSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    public List<PromptEntry> Prompts { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 单条提示词配置（对某一个角色有效）
/// </summary>
public class PromptEntry
{
    /// <summary>稳定标识（全局唯一）</summary>
    public string PromptKey { get; set; } = string.Empty;

    /// <summary>仅允许 PM/DEV/QA</summary>
    public UserRole Role { get; set; } = UserRole.PM;

    /// <summary>该角色下的排序号（从 1 开始）</summary>
    public int Order { get; set; }

    /// <summary>小标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>提示词模板</summary>
    public string PromptTemplate { get; set; } = string.Empty;

    /// <summary>
    /// 场景类型（可选）：
    /// - null/"global": 全局共享（所有场景可用）
    /// - "article-illustration": 文章配图专用
    /// - "image-gen": 图片生成专用
    /// - "other": 其他场景
    /// </summary>
    public string? ScenarioType { get; set; }
}

/// <summary>
/// 提示词 DTO（用于 ChatService 注入）
/// </summary>
public class RolePrompt
{
    public string Title { get; set; } = string.Empty;
    public string PromptTemplate { get; set; } = string.Empty;
}

/// <summary>
/// 技能定义（服务器端公共技能）
/// - 与提示词不同：技能有上下文范围、输出方式、参数等高级配置
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class SkillSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    public List<SkillEntry> Skills { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 单条技能配置
/// </summary>
public class SkillEntry
{
    /// <summary>技能唯一标识</summary>
    public string SkillKey { get; set; } = string.Empty;

    /// <summary>技能名称</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>技能描述</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>技能图标（emoji 或 icon name）</summary>
    public string? Icon { get; set; }

    /// <summary>分类标签</summary>
    public string? Category { get; set; }

    /// <summary>适用角色（为空表示所有角色可用）</summary>
    public List<UserRole> Roles { get; set; } = new();

    /// <summary>排序号</summary>
    public int Order { get; set; }

    /// <summary>
    /// 上下文范围：
    /// - "all": 读取所有对话上下文
    /// - "current": 仅当前消息
    /// - "prd": 仅 PRD 文档内容
    /// </summary>
    public string ContextScope { get; set; } = "all";

    /// <summary>
    /// 输出方式：
    /// - "chat": 对话框内显示
    /// - "download": 直接下载文件
    /// - "clipboard": 复制到剪贴板
    /// </summary>
    public string OutputMode { get; set; } = "chat";

    /// <summary>输出文件名模板（download 模式时使用，如 "{title}-report.md"）</summary>
    public string? OutputFileNameTemplate { get; set; }

    /// <summary>提示词模板</summary>
    public string PromptTemplate { get; set; } = string.Empty;

    /// <summary>技能参数（可选的变量槽）</summary>
    public List<SkillParameter>? Parameters { get; set; }

    /// <summary>是否启用</summary>
    public bool IsEnabled { get; set; } = true;
}

/// <summary>
/// 技能参数定义（变量槽）
/// </summary>
public class SkillParameter
{
    /// <summary>参数 key（用于模板替换 {{key}}）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>参数标签</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>参数类型：text, select, number</summary>
    public string Type { get; set; } = "text";

    /// <summary>默认值</summary>
    public string? DefaultValue { get; set; }

    /// <summary>select 类型的选项列表</summary>
    public List<string>? Options { get; set; }

    /// <summary>是否必填</summary>
    public bool Required { get; set; } = false;
}
