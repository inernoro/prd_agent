using MongoDB.Bson.Serialization.Attributes;

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
[BsonIgnoreExtraElements]
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

    /// <summary>
    /// 这把钥匙此刻还打不打得开门 —— 「能用」的唯一判据。
    ///
    /// 鉴权（<c>LookupByPlaintextAsync</c>）、接入台面板、密钥列表的状态标签都读这一处：
    /// 各自照着 <c>IsActive</c> 判会让面板把一把过了宽限期的钥匙显示成「已连接、已授权」，
    /// 而它发的每一个请求都被鉴权拒掉 —— 用户看到的和智能体遇到的是两回事。
    /// </summary>
    /// <param name="inGrace">true 表示已过期但还在宽限期内（可用，但该提示续期）。</param>
    public static bool IsUsableAt(AgentApiKey key, DateTime nowUtc, out bool inGrace)
    {
        inGrace = false;
        if (!key.IsActive || key.RevokedAt.HasValue) return false;
        if (!key.ExpiresAt.HasValue) return true;
        if (key.ExpiresAt.Value >= nowUtc) return true;
        var graceEnd = key.ExpiresAt.Value.AddDays(Math.Max(0, key.GracePeriodDays));
        if (graceEnd < nowUtc) return false;
        inGrace = true;
        return true;
    }

    // ── OpenApi 对外网关：按 Key 模型白名单（客户可在白名单内自选，避免总池调度误伤客户） ──
    //
    // 白名单元素 = 客户在请求 body 的 model 字段可填的模型 id（如 "deepseek/deepseek-v3.2"），
    // 也兼容模型池 Code（ModelResolver 的 expectedModel 通道按 id/前缀/池Code 三档匹配）。
    // 语义：
    //   - 白名单非空：client model 命中白名单 → 用之；client 不填 → 用白名单第一个作默认；
    //     client 填了白名单外的 → 400 model_not_allowed（返回允许清单）。
    //   - 白名单为空：未绑定，回落 default:chat / default:image 默认池（client model 被忽略）。

    /// <summary>OpenApi chat 端点的模型白名单（model id 或池 Code）；空=未绑定走默认 chat 池。第一个为默认。</summary>
    public List<string> OpenApiChatModels { get; set; } = new();

    /// <summary>OpenApi 生图端点的模型白名单（model id 或池 Code）；空=未绑定走默认 image 池。第一个为默认。</summary>
    public List<string> OpenApiImageModels { get; set; } = new();

    /// <summary>每日 token 配额（OpenApi 网关用）；null=不限。Phase 2 配额预警消费此字段。</summary>
    public long? OpenApiDailyTokenQuota { get; set; }

    /// <summary>每日请求数配额（OpenApi 网关用）；null=不限。Phase 2 消费。</summary>
    public long? OpenApiDailyRequestQuota { get; set; }

    /// <summary>每分钟请求速率上限（OpenApi 网关用）；null=用系统默认。Phase 2 按 Key 限流桶消费。</summary>
    public int? OpenApiRateLimitPerMin { get; set; }

    // ── 接入台（MCP）配额：与 OpenApi 网关那套分开，语义不同（那边算 token，这边算动作次数） ──
    //
    // 三个值都可空，空 = 用系统默认（见 McpUsageService 的默认值）。
    // 默认值定成「一个人一天正常用不到、脚本跑飞了会撞上」的量级：智能体重试成本极低，
    // 没有上限时一个循环就能把当天的模型额度烧光。

    /// <summary>每日生图张数上限；null=系统默认 50。</summary>
    public int? McpDailyImageQuota { get; set; }

    /// <summary>每日写入类动作次数上限（建站、写文档、写正文…）；null=系统默认 200。</summary>
    public int? McpDailyWriteQuota { get; set; }

    /// <summary>每分钟工具调用次数上限；null=系统默认 60。</summary>
    public int? McpRateLimitPerMin { get; set; }
}
