namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 统一收件箱条目 — 跨系统导入通道的中转站。
///
/// ⚠️ 骨架状态（2026-04-16）：仅定义数据模型与集合注册，**Controller / Service / Device Flow 认证留待下一次迭代开发**。
///
/// 设计目标：
/// - 外部系统（Manus / Cursor / 其他知识库）通过 SDK 一键推送任意数据到本系统
/// - 认证使用交互式 Device Flow（参考 <c>cds/src/routes/github-oauth.ts</c>），默认 30 天有效，可选永久
/// - 数据先落 Inbox 缓冲，用户在 Inbox 页确认后再归档到对应业务集合（hosted_sites / document_stores / skills / ...）
/// - 默认路径：公开页（Visibility=public 的 HostedSite）无需 Inbox，Inbox 是用户显式开启的接收通道
///
/// 下次 Agent 接手清单：
/// 1. 新建 <c>InboxController</c>：<c>POST /api/inbox/ingest</c>（Bearer Token 认证）
/// 2. 新建 Device Flow 端点：<c>POST /api/inbox/device-start</c> + <c>POST /api/inbox/device-poll</c>
/// 3. 新建 <c>InboxService</c>：Token 生成 / 校验 / 过期处理、Type 路由到对应业务集合
/// 4. 前端 <c>InboxPage</c>：已接收列表 + 确认归档 / 丢弃、Device 绑定管理
/// 5. SDK：单文件 shell 脚本 <c>map-push</c>（curl + jq）
/// </summary>
public class InboxItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>接收者用户 ID</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>数据类型：article | agent | skill | document | web-page</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>原始载荷（JSON 字符串，保留发送方原始结构）</summary>
    public string Payload { get; set; } = string.Empty;

    /// <summary>来源标识（如 "manus" / "cursor" / "custom-cli/v1"），由 SDK 自报</summary>
    public string? Source { get; set; }

    /// <summary>来源绑定的 Device ID（认证 token 对应的设备）</summary>
    public string? DeviceId { get; set; }

    /// <summary>状态：pending（待处理）| archived（已归档到业务集合）| discarded（用户丢弃）</summary>
    public string Status { get; set; } = "pending";

    /// <summary>归档后对应的业务集合 + ID（如 "hosted_sites:abc123"）</summary>
    public string? ArchivedRef { get; set; }

    public DateTime ReceivedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ProcessedAt { get; set; }
}
