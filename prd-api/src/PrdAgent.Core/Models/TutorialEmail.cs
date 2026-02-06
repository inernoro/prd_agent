namespace PrdAgent.Core.Models;

/// <summary>
/// 教程邮件序列定义（如 "新用户引导"、"功能更新通知"）
/// </summary>
public class TutorialEmailSequence
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>序列唯一标识（如 onboarding、feature-update-v2）</summary>
    public string SequenceKey { get; set; } = string.Empty;

    /// <summary>序列名称（管理后台展示用）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>序列描述</summary>
    public string? Description { get; set; }

    /// <summary>触发类型：registration=注册后自动、manual=手动、feature-release=版本发布</summary>
    public string TriggerType { get; set; } = "manual";

    /// <summary>序列步骤（按 dayOffset 排序）</summary>
    public List<TutorialEmailStep> Steps { get; set; } = new();

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 序列中的单个步骤
/// </summary>
public class TutorialEmailStep
{
    /// <summary>第几天发送（相对于 enrollment 开始日期，0=当天）</summary>
    public int DayOffset { get; set; }

    /// <summary>邮件标题</summary>
    public string Subject { get; set; } = string.Empty;

    /// <summary>邮件模板 ID</summary>
    public string TemplateId { get; set; } = string.Empty;

    /// <summary>跳过条件描述（预留，可扩展为表达式引擎）</summary>
    public string? SkipCondition { get; set; }
}

/// <summary>
/// 邮件模板（HTML 内容 + 变量定义）
/// </summary>
public class TutorialEmailTemplate
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模板名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>HTML 内容（支持 {{变量}} 占位符）</summary>
    public string HtmlContent { get; set; } = string.Empty;

    /// <summary>模板变量列表（如 userName, productName）</summary>
    public List<string> Variables { get; set; } = new();

    /// <summary>关联的截图资源 ID 列表</summary>
    public List<string> AssetIds { get; set; } = new();

    /// <summary>预览用缩略图 URL</summary>
    public string? ThumbnailUrl { get; set; }

    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 截图/图片素材
/// </summary>
public class TutorialEmailAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>文件名</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>CDN/OSS 公网 URL</summary>
    public string FileUrl { get; set; } = string.Empty;

    /// <summary>标签（便于按功能/版本归类）</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>文件大小（字节）</summary>
    public long FileSize { get; set; }

    /// <summary>MIME 类型</summary>
    public string? ContentType { get; set; }

    public string? UploadedBy { get; set; }
    public DateTime UploadedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 用户邮件序列订阅记录
/// </summary>
public class TutorialEmailEnrollment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>目标邮箱</summary>
    public string Email { get; set; } = string.Empty;

    /// <summary>序列 Key</summary>
    public string SequenceKey { get; set; } = string.Empty;

    /// <summary>当前已完成步骤索引（-1=尚未开始）</summary>
    public int CurrentStepIndex { get; set; } = -1;

    /// <summary>状态：active=进行中、completed=已完成、unsubscribed=已退订</summary>
    public string Status { get; set; } = "active";

    /// <summary>下次发送时间</summary>
    public DateTime? NextSendAt { get; set; }

    /// <summary>订阅开始时间</summary>
    public DateTime EnrolledAt { get; set; } = DateTime.UtcNow;

    /// <summary>已发送历史</summary>
    public List<TutorialEmailSentRecord> SentHistory { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 已发送邮件记录
/// </summary>
public class TutorialEmailSentRecord
{
    /// <summary>步骤索引</summary>
    public int StepIndex { get; set; }

    /// <summary>发送时间</summary>
    public DateTime SentAt { get; set; } = DateTime.UtcNow;

    /// <summary>是否发送成功</summary>
    public bool Success { get; set; }

    /// <summary>失败原因</summary>
    public string? ErrorMessage { get; set; }
}
