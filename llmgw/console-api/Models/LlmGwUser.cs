using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.LlmGw.Models;

/// <summary>
/// 网关自有账户（独立账户体系，与 MAP/prd-api 用户表无关）。
/// 存放在 llm_gateway.llmgw_console_users；MAP 不负责该账号体系。
/// </summary>
[BsonIgnoreExtraElements]
public class LlmGwUser
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Username { get; set; } = string.Empty;

    /// <summary>PBKDF2 格式：pbkdf2$iterations$saltB64$hashB64</summary>
    public string PasswordHash { get; set; } = string.Empty;

    public string DisplayName { get; set; } = string.Empty;

    /// <summary>外部身份提供方；MAP 一键登录账号固定为 map，独立口令账号为空。</summary>
    public string? IdentityProvider { get; set; }

    /// <summary>外部身份不可变主体。MAP 账号按 map:{userId} 绑定，不以可变用户名关联。</summary>
    public string? ExternalSubjectId { get; set; }

    public bool IsActive { get; set; } = true;

    /// <summary>
    /// 首登强制改密标记。缺省弱口令（admin/admin）种子账号置 true，登录后前端强制跳「设置新口令」，
    /// 改密成功前 mcp=1 的 token 不放行 /gw/logs*（服务端策略门 + 前端守卫双保险）。
    /// LLMGW_ADMIN_PASSWORD 只用于首次 bootstrap 或破玻璃重置，不作为长期口令权威。
    /// </summary>
    public bool MustChangePassword { get; set; }

    /// <summary>
    /// 口令是否已被真人主动改过（认领）。change-password 成功后置 true。
    /// 认领后重启不再被 LLMGW_ADMIN_PASSWORD 覆盖；只有 LLMGW_ADMIN_FORCE_RESET 会破玻璃重置。
    /// </summary>
    public bool PasswordChangedByUser { get; set; }

    /// <summary>
    /// 用户安全会话版本。改密、停用或强制退出时递增，使已经签发的 JWT 立即失效。
    /// </summary>
    public long SecurityVersion { get; set; } = 1;

    public string[] Scopes { get; set; } = Array.Empty<string>();

    /// <summary>
    /// 服务端维护的租户目录，只用于登录后定位候选 membership；权限权威仍是
    /// llmgw_memberships，客户端不能写入或覆盖该列表。
    /// </summary>
    public List<string> TenantIds { get; set; } = new();

    public string? DefaultTenantId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? LastLoginAt { get; set; }
}
