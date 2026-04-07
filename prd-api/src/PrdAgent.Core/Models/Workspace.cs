namespace PrdAgent.Core.Models;

/// <summary>
/// 工作空间 — CLI Agent 的持久化交互会话。
/// 用户与 Agent 多轮对话，每轮产出文件/页面，统一显示和控制。
/// </summary>
public class Workspace
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所有者</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>工作空间名称（用户可编辑）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>状态：idle | running | completed | error</summary>
    public string Status { get; set; } = WorkspaceStatuses.Idle;

    // ── Agent 配置 ──

    /// <summary>执行器类型：builtin-llm | docker | api | script | lobster | ...</summary>
    public string ExecutorType { get; set; } = "builtin-llm";

    /// <summary>Docker 镜像（docker 执行器用）</summary>
    public string? DockerImage { get; set; }

    /// <summary>API 端点（api 执行器用）</summary>
    public string? ApiEndpoint { get; set; }

    /// <summary>运行中的容器 ID（docker 执行器用，容器复用）</summary>
    public string? ContainerId { get; set; }

    // ── 生成配置 ──

    /// <summary>框架：html | react | vue | nextjs | svelte | custom</summary>
    public string Framework { get; set; } = "html";

    /// <summary>风格：ui-ux-pro-max | minimal | dashboard | landing | doc | custom</summary>
    public string Style { get; set; } = "ui-ux-pro-max";

    /// <summary>规范类型：none | spec | dri | dev | sdd</summary>
    public string Spec { get; set; } = "none";

    // ── 状态追踪 ──

    /// <summary>已交互轮数</summary>
    public int RoundCount { get; set; }

    /// <summary>对话历史（用户指令 + Agent 回复）</summary>
    public List<WorkspaceMessage> Messages { get; set; } = new();

    /// <summary>最新产物的 HostedSite ID</summary>
    public string? LatestSiteId { get; set; }

    /// <summary>最新预览 URL</summary>
    public string? LatestPreviewUrl { get; set; }

    /// <summary>最新生成的 HTML 内容（用于下一轮迭代传入）</summary>
    public string? LatestHtmlOutput { get; set; }

    /// <summary>错误信息（status=error 时）</summary>
    public string? ErrorMessage { get; set; }

    // ── 时间戳 ──

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastActiveAt { get; set; }
}

/// <summary>
/// 工作空间消息（用户指令或 Agent 回复）
/// </summary>
public class WorkspaceMessage
{
    /// <summary>user | assistant</summary>
    public string Role { get; set; } = "user";

    /// <summary>消息内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>轮次编号</summary>
    public int Round { get; set; }

    /// <summary>关联的 HostedSite ID（assistant 消息可能有预览）</summary>
    public string? SiteId { get; set; }

    /// <summary>预览 URL</summary>
    public string? PreviewUrl { get; set; }

    /// <summary>变更的文件数</summary>
    public int FilesChanged { get; set; }

    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}

public static class WorkspaceStatuses
{
    public const string Idle = "idle";
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Error = "error";
}
