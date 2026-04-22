namespace PrdAgent.Core.Models;

/// <summary>
/// Agent 开放接口 API Key 实体。
///
/// 用途：为外部 AI / Agent 提供长期 M2M 鉴权，访问海鲜市场开放接口、Agent 开放入口等。
/// - 每个 Key 绑定一个创建用户（OwnerUserId），调用时以该用户身份执行
/// - 通过 Scopes 限定调用范围（如 `marketplace.skills:read` / `marketplace.skills:write`）
/// - 默认 365 天有效期 + 7 天宽限期，过期前后均可在 UI 一键续期
///
/// 与 <see cref="OpenPlatformApp"/> 的区别：
/// - OpenPlatformApp 专用于 PRD 对话代理（含 Webhook、Token 配额、系统提示词覆盖等 chat 专属字段）
/// - AgentApiKey 专用于通用开放接口 M2M，纯鉴权载体，不带 chat 相关配置
/// </summary>
public class AgentApiKey
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>Key 展示名（如"我的 Cursor 工作站"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Key 说明（可选，如用途、调用方来源）</summary>
    public string? Description { get; set; }

    /// <summary>Key 所属用户 ID（调用时以该用户身份执行）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>API Key 哈希（SHA256，不存明文）</summary>
    public string ApiKeyHash { get; set; } = string.Empty;

    /// <summary>Key 前缀片段（明文前 12 字符，如 `sk-ak-abc12345`），仅用于 UI 展示以便用户识别</summary>
    public string KeyPrefix { get; set; } = string.Empty;

    /// <summary>
    /// 权限范围（scope 列表）。
    /// 约定格式：`{resource}:{action}`，例如：
    /// - `marketplace.skills:read`
    /// - `marketplace.skills:write`
    /// - `agent.open-api:call`（P3 Agent 开放接口）
    /// 空列表视为无权限（所有请求 403）。
    /// </summary>
    public List<string> Scopes { get; set; } = new();

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>过期时间；null 表示永不过期（需管理员权限，普通用户必须设置）</summary>
    public DateTime? ExpiresAt { get; set; }

    /// <summary>最后一次续期时间（审计用）</summary>
    public DateTime? LastRenewedAt { get; set; }

    /// <summary>最后一次使用时间</summary>
    public DateTime? LastUsedAt { get; set; }

    /// <summary>累计调用次数</summary>
    public long TotalRequests { get; set; }

    /// <summary>撤销时间；非 null 时 Key 立即失效</summary>
    public DateTime? RevokedAt { get; set; }

    /// <summary>
    /// 宽限期天数（过期后继续放行的天数）。
    /// 默认 7 天 —— 在此期间请求正常响应，但响应头 `X-AgentApiKey-Expiring` 会提示续期。
    /// </summary>
    public int GracePeriodDays { get; set; } = 7;
}
