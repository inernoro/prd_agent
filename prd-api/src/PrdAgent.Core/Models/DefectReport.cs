namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷报告
/// </summary>
public class DefectReport
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>缺陷编号（如 DEF-2025-0001，自动生成）</summary>
    public string DefectNo { get; set; } = string.Empty;

    /// <summary>使用的模板 ID</summary>
    public string? TemplateId { get; set; }

    /// <summary>缺陷标题（AI 提取或用户填写）</summary>
    public string? Title { get; set; }

    /// <summary>用户原始输入文本</summary>
    public string RawContent { get; set; } = string.Empty;

    /// <summary>AI 提取后的结构化数据</summary>
    public Dictionary<string, string> StructuredData { get; set; } = new();

    /// <summary>附件列表</summary>
    public List<DefectAttachment> Attachments { get; set; } = new();

    /// <summary>
    /// 缺陷状态：
    /// - draft: 草稿
    /// - reviewing: AI 审核中
    /// - awaiting: 待补充信息
    /// - submitted: 已提交
    /// - assigned: 已指派
    /// - processing: 处理中
    /// - resolved: 已解决
    /// - rejected: 已拒绝
    /// - closed: 已关闭
    /// </summary>
    public string Status { get; set; } = DefectStatus.Draft;

    /// <summary>严重程度：blocker, critical, major, minor, suggestion</summary>
    public string? Severity { get; set; }

    /// <summary>优先级：high, medium, low</summary>
    public string? Priority { get; set; }

    /// <summary>
    /// 产品管理智能体内的处理优先级：见 ProductItemGrade（p0/p1/p2/p3）。与 Severity（严重程度）独立。
    /// TAPD「缺陷等级」导入映射到 Severity，不写入本字段。
    /// </summary>
    public string? Grade { get; set; }

    /// <summary>当前缺失的必填字段</summary>
    public List<string> MissingFields { get; set; } = new();

    /// <summary>报告人 UserId</summary>
    public string ReporterId { get; set; } = string.Empty;

    /// <summary>报告人头像文件名</summary>
    public string? ReporterAvatarFileName { get; set; }

    /// <summary>报告人显示名称（冗余，便于展示）</summary>
    public string? ReporterName { get; set; }

    /// <summary>被指派人 UserId</summary>
    public string? AssigneeId { get; set; }

    /// <summary>被指派人头像文件名</summary>
    public string? AssigneeAvatarFileName { get; set; }

    /// <summary>被指派人显示名称（冗余，便于展示）</summary>
    public string? AssigneeName { get; set; }

    /// <summary>报告人未读</summary>
    public bool ReporterUnread { get; set; }

    /// <summary>被指派人未读</summary>
    public bool AssigneeUnread { get; set; }

    /// <summary>
    /// 最近一次评论来自谁（用于“对方已评论”展示）：
    /// - reporter | assignee
    /// </summary>
    public string? LastCommentBy { get; set; }

    /// <summary>指派时间</summary>
    public DateTime? AssignedAt { get; set; }

    /// <summary>解决说明</summary>
    public string? Resolution { get; set; }

    /// <summary>解决人 UserId</summary>
    public string? ResolvedById { get; set; }

    /// <summary>解决人头像文件名</summary>
    public string? ResolvedByAvatarFileName { get; set; }

    /// <summary>解决人名称</summary>
    public string? ResolvedByName { get; set; }

    /// <summary>是否由 AI Agent 自动解决</summary>
    public bool IsAiResolved { get; set; }

    /// <summary>解决该缺陷的 AI Agent 名称</summary>
    public string? ResolvedByAgentName { get; set; }

    /// <summary>拒绝原因</summary>
    public string? RejectReason { get; set; }

    /// <summary>拒绝人 UserId</summary>
    public string? RejectedById { get; set; }

    /// <summary>拒绝人头像文件名</summary>
    public string? RejectedByAvatarFileName { get; set; }

    /// <summary>拒绝人名称</summary>
    public string? RejectedByName { get; set; }

    /// <summary>正式提交时间</summary>
    public DateTime? SubmittedAt { get; set; }

    /// <summary>解决时间</summary>
    public DateTime? ResolvedAt { get; set; }

    /// <summary>关闭时间</summary>
    public DateTime? ClosedAt { get; set; }

    /// <summary>当前版本号</summary>
    public int Version { get; set; } = 1;

    /// <summary>版本历史</summary>
    public List<DefectVersion> Versions { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>是否已删除（软删除）</summary>
    public bool IsDeleted { get; set; } = false;

    /// <summary>删除时间</summary>
    public DateTime? DeletedAt { get; set; }

    /// <summary>删除人 UserId</summary>
    public string? DeletedBy { get; set; }

    /// <summary>所属文件夹 ID（null 表示未分类/根目录）</summary>
    public string? FolderId { get; set; }

    // ===== Phase 1: 项目 + 团队维度 =====

    /// <summary>所属项目 ID</summary>
    public string? ProjectId { get; set; }

    /// <summary>所属项目名称（冗余，便于展示和搜索）</summary>
    public string? ProjectName { get; set; }

    /// <summary>所属团队 ID（复用 report_teams）</summary>
    public string? TeamId { get; set; }

    /// <summary>所属团队名称（冗余）</summary>
    public string? TeamName { get; set; }

    // ===== 产品管理智能体（product-agent）追溯引用 =====
    // 缺陷追溯需求：由 product-agent 写入，defect-agent 不感知这些字段（仅追加，不改既有逻辑）。

    /// <summary>产品管理智能体绑定的流程定义 Id（状态 Key 与 Status 一致）。</summary>
    public string? WorkflowDefId { get; set; }

    /// <summary>产品内缺陷划分：缺陷 / 非产品缺陷，见 ProductDefectLinkageCatalog。</summary>
    public string? ProductDefectClassification { get; set; }

    /// <summary>追溯到的产品 ID（product-agent.products）</summary>
    public string? TracedProductId { get; set; }

    /// <summary>追溯到的需求 ID（product-agent.requirements）</summary>
    public string? TracedRequirementId { get; set; }

    /// <summary>追溯到的产品版本 ID（product-agent.product_versions）</summary>
    public string? TracedVersionId { get; set; }

    /// <summary>追溯到的功能 ID（product-agent.features）</summary>
    public string? TracedFeatureId { get; set; }

    /// <summary>产品管理历史导入来源系统。</summary>
    public string? ProductSourceSystem { get; set; }

    /// <summary>来源系统中的唯一 ID，用于幂等导入。</summary>
    public string? ProductExternalId { get; set; }

    // ===== Phase 2: 待验收 =====

    /// <summary>验收人 UserId（通常是 reporter）</summary>
    public string? VerifiedById { get; set; }

    /// <summary>验收人名称</summary>
    public string? VerifiedByName { get; set; }

    /// <summary>验收时间</summary>
    public DateTime? VerifiedAt { get; set; }

    /// <summary>验收不通过原因</summary>
    public string? VerifyFailReason { get; set; }

    // ===== Phase 3: 超时催办 =====

    /// <summary>最后催办时间（防止重复催办）</summary>
    public DateTime? LastEscalatedAt { get; set; }

    /// <summary>催办次数</summary>
    public int EscalationCount { get; set; } = 0;
}

/// <summary>
/// 缺陷版本历史记录
/// </summary>
public class DefectVersion
{
    /// <summary>版本号</summary>
    public int Version { get; set; }

    /// <summary>标题</summary>
    public string? Title { get; set; }

    /// <summary>原始内容</summary>
    public string RawContent { get; set; } = string.Empty;

    /// <summary>结构化数据</summary>
    public Dictionary<string, string>? StructuredData { get; set; }

    /// <summary>修改人 ID</summary>
    public string ModifiedBy { get; set; } = string.Empty;

    /// <summary>修改人名称</summary>
    public string? ModifiedByName { get; set; }

    /// <summary>修改时间</summary>
    public DateTime ModifiedAt { get; set; } = DateTime.UtcNow;

    /// <summary>修改说明</summary>
    public string? ChangeNote { get; set; }
}

/// <summary>
/// 缺陷附件
/// </summary>
public class DefectAttachment
{
    /// <summary>附件 ID</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>文件名</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>文件大小 (bytes)</summary>
    public long FileSize { get; set; }

    /// <summary>MIME 类型</summary>
    public string MimeType { get; set; } = string.Empty;

    /// <summary>存储 URL（兼容旧字段 CosUrl）</summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>缩略图 URL（图片类型）</summary>
    public string? ThumbnailUrl { get; set; }

    /// <summary>上传时间</summary>
    public DateTime UploadedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 附件类型：
    /// - file: 用户上传的普通文件（默认）
    /// - screenshot: 自动截图
    /// - log-request: 请求日志
    /// - log-error: 错误日志
    /// </summary>
    public string Type { get; set; } = DefectAttachmentType.File;

    /// <summary>
    /// 是否系统自动生成（日志类附件不可删除、前端不可下载）
    /// </summary>
    public bool IsSystemGenerated { get; set; } = false;

    /// <summary>
    /// AI 图片分析描述（截图类附件，前端 Vision 解析后持久化）
    /// </summary>
    public string? Description { get; set; }
}

/// <summary>
/// 缺陷附件类型常量
/// </summary>
public static class DefectAttachmentType
{
    /// <summary>用户上传的普通文件</summary>
    public const string File = "file";
    /// <summary>自动截图</summary>
    public const string Screenshot = "screenshot";
    /// <summary>请求日志</summary>
    public const string LogRequest = "log-request";
    /// <summary>错误日志</summary>
    public const string LogError = "log-error";
}

/// <summary>
/// 缺陷状态常量
/// </summary>
public static class DefectStatus
{
    public const string Draft = "draft";
    public const string Reviewing = "reviewing";
    public const string Awaiting = "awaiting";
    public const string Submitted = "submitted";
    public const string Assigned = "assigned";
    public const string Processing = "processing";
    public const string Resolved = "resolved";
    public const string Rejected = "rejected";
    public const string Closed = "closed";

    /// <summary>待验收（处理人标记解决后，由报告人验收）</summary>
    public const string Verifying = "verifying";

    public static readonly string[] All = { Draft, Reviewing, Awaiting, Submitted, Assigned, Processing, Resolved, Rejected, Closed, Verifying };
}

/// <summary>
/// 未读标记
/// </summary>
public static class DefectUnreadBy
{
    public const string Reporter = "reporter";
    public const string Assignee = "assignee";
    public static readonly string[] All = { Reporter, Assignee };
}

/// <summary>
/// 缺陷严重程度常量
/// </summary>
public static class DefectSeverity
{
    public const string Blocker = "blocker";
    public const string Critical = "critical";
    public const string Major = "major";
    public const string Minor = "minor";
    public const string Trivial = "trivial";
    public const string Suggestion = "suggestion";

    public static readonly string[] All = { Blocker, Critical, Major, Minor, Trivial, Suggestion };
}

/// <summary>
/// 缺陷优先级常量
/// </summary>
public static class DefectPriority
{
    public const string High = "high";
    public const string Medium = "medium";
    public const string Low = "low";

    public static readonly string[] All = { High, Medium, Low };
}
