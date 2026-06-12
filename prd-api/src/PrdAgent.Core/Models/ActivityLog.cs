namespace PrdAgent.Core.Models;

/// <summary>
/// 团队动态（工作日志）— 全平台白名单写操作留痕，支撑「张三 在 知识库 发布了文档《标题》」式时间线渲染。
/// 由 ActivityLogActionFilter 在白名单动作成功后自动写入，无需逐端点埋点。
/// 仅存 ActorId（显示名/头像在读取时批量解析）；TargetTitle 为写入时快照（对象删除后仍可展示）。
/// </summary>
public class ActivityLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>操作人 UserId（JWT sub）</summary>
    public string ActorId { get; set; } = string.Empty;

    /// <summary>模块 key（document-store / defect-agent / report-agent / visual-agent / literary-agent / web-pages）</summary>
    public string Module { get; set; } = string.Empty;

    /// <summary>模块中文名快照（如「知识库」），写入时固化避免 key 改名后历史错乱</summary>
    public string ModuleLabel { get; set; } = string.Empty;

    /// <summary>动作标识（Controller.Action 复合键，如 DocumentStore.AddEntry）</summary>
    public string Action { get; set; } = string.Empty;

    /// <summary>动作中文标签（如「发布了文档」）</summary>
    public string ActionLabel { get; set; } = string.Empty;

    /// <summary>操作对象 ID（路由子实体 id，按白名单条目声明的 key 提取）</summary>
    public string? TargetId { get; set; }

    /// <summary>操作对象标题快照（知识库名/文档标题/缺陷标题等），抓不到时为空、前端降级展示</summary>
    public string? TargetTitle { get; set; }

    /// <summary>操作对象深链（预留，一期留空）</summary>
    public string? TargetUrl { get; set; }

    /// <summary>HTTP 方法（排障用）</summary>
    public string Method { get; set; } = string.Empty;

    /// <summary>请求路径（排障用）</summary>
    public string Path { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
