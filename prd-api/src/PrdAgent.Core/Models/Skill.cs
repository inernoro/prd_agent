namespace PrdAgent.Core.Models;

/// <summary>
/// 统一技能模型（替代 PromptEntry + SkillEntry）
/// - 每个文档是一个独立技能，存储在 skills 集合
/// - 系统技能由管理员创建（visibility: system），不可删除
/// - 公共技能由管理员创建（visibility: public），可被所有用户看到
/// - 个人技能由用户创建（visibility: personal），仅创建者可见
/// </summary>
public class Skill
{
    public string Id { get; set; } = string.Empty;

    /// <summary>唯一标识（kebab-case）</summary>
    public string SkillKey { get; set; } = string.Empty;

    /// <summary>技能名称</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>技能描述</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>图标（emoji）</summary>
    public string? Icon { get; set; }

    /// <summary>分类</summary>
    public string Category { get; set; } = "general";

    /// <summary>标签</summary>
    public List<string> Tags { get; set; } = new();

    // === 可见性 ===

    /// <summary>可见性: system | public | personal</summary>
    public string Visibility { get; set; } = SkillVisibility.Public;

    /// <summary>个人技能的创建者（system/public 为 null）</summary>
    public string? OwnerUserId { get; set; }

    /// <summary>适用角色（空 = 全部角色可用）</summary>
    public List<UserRole> Roles { get; set; } = new();

    /// <summary>排序号</summary>
    public int Order { get; set; }

    // === 输入配置 ===

    /// <summary>输入配置</summary>
    public SkillInputConfig Input { get; set; } = new();

    // === 执行配置（仅服务端持有，不下发客户端） ===

    /// <summary>执行配置</summary>
    public SkillExecutionConfig Execution { get; set; } = new();

    // === 输出配置 ===

    /// <summary>输出配置</summary>
    public SkillOutputConfig Output { get; set; } = new();

    // === 元数据 ===

    /// <summary>是否启用</summary>
    public bool IsEnabled { get; set; } = true;

    /// <summary>是否为系统内置（不可删除）</summary>
    public bool IsBuiltIn { get; set; }

    /// <summary>使用次数</summary>
    public int UsageCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>技能可见性常量</summary>
public static class SkillVisibility
{
    /// <summary>系统内置（管理员管理，所有人可见）</summary>
    public const string System = "system";
    /// <summary>公共（管理员创建，所有人可见）</summary>
    public const string Public = "public";
    /// <summary>个人（用户自建，仅自己可见）</summary>
    public const string Personal = "personal";
}

/// <summary>技能输入配置</summary>
public class SkillInputConfig
{
    /// <summary>上下文范围: all | current | prd | none</summary>
    public string ContextScope { get; set; } = "prd";

    /// <summary>是否接受用户附加文本输入</summary>
    public bool AcceptsUserInput { get; set; }

    /// <summary>用户输入占位提示</summary>
    public string? UserInputPlaceholder { get; set; }

    /// <summary>是否接受附件</summary>
    public bool AcceptsAttachments { get; set; }

    /// <summary>可配置参数</summary>
    public List<SkillParameter> Parameters { get; set; } = new();
}

/// <summary>技能执行配置（服务端专有，不下发客户端）</summary>
public class SkillExecutionConfig
{
    /// <summary>提示词模板（支持 {{变量}} 占位符）</summary>
    public string PromptTemplate { get; set; } = string.Empty;

    /// <summary>系统提示词覆盖（null = 使用默认角色系统提示词）</summary>
    public string? SystemPromptOverride { get; set; }

    /// <summary>LLM Gateway 路由标识</summary>
    public string? AppCallerCode { get; set; }

    /// <summary>模型类型偏好</summary>
    public string ModelType { get; set; } = "chat";

    /// <summary>期望模型提示</summary>
    public string? ExpectedModel { get; set; }

    /// <summary>后处理工具链</summary>
    public List<SkillToolStep> ToolChain { get; set; } = new();
}

/// <summary>工具链步骤</summary>
public class SkillToolStep
{
    /// <summary>工具标识: chat, download, clipboard, create-defect 等</summary>
    public string ToolKey { get; set; } = string.Empty;

    /// <summary>工具专有配置</summary>
    public Dictionary<string, object> Config { get; set; } = new();

    /// <summary>是否可选（失败不中断流程）</summary>
    public bool Optional { get; set; }
}

/// <summary>技能输出配置</summary>
public class SkillOutputConfig
{
    /// <summary>输出模式: chat | download | clipboard</summary>
    public string Mode { get; set; } = "chat";

    /// <summary>下载模式的文件名模板</summary>
    public string? FileNameTemplate { get; set; }

    /// <summary>下载模式的 MIME 类型</summary>
    public string? MimeType { get; set; }

    /// <summary>非 chat 模式是否同时在对话中回显</summary>
    public bool EchoToChat { get; set; }
}

/// <summary>技能执行请求</summary>
public class SkillExecuteRequest
{
    /// <summary>会话 ID</summary>
    public string SessionId { get; set; } = string.Empty;

    /// <summary>用户附加文本</summary>
    public string? UserInput { get; set; }

    /// <summary>附件 ID 列表</summary>
    public List<string>? AttachmentIds { get; set; }

    /// <summary>参数覆盖</summary>
    public Dictionary<string, string>? Parameters { get; set; }

    /// <summary>上下文范围覆盖（null = 使用技能默认值）</summary>
    public string? ContextScopeOverride { get; set; }

    /// <summary>输出模式覆盖（null = 使用技能默认值）</summary>
    public string? OutputModeOverride { get; set; }
}
