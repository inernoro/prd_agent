using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.LlmGw.Models;

/// <summary>
/// 网关自有账户（独立账户体系，与 MAP/prd-api 用户表无关）。
/// 存放在共享 Mongo 的 llmgw_users 集合。
/// </summary>
[BsonIgnoreExtraElements]
public class LlmGwUser
{
    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Username { get; set; } = string.Empty;

    /// <summary>PBKDF2 格式：pbkdf2$iterations$saltB64$hashB64</summary>
    public string PasswordHash { get; set; } = string.Empty;

    public string DisplayName { get; set; } = string.Empty;

    public bool IsActive { get; set; } = true;

    /// <summary>
    /// 首登强制改密标记。缺省弱口令（admin/admin）种子账号置 true，登录后前端强制跳「设置新口令」，
    /// 改密成功前 mcp=1 的 token 不放行 /gw/logs*（服务端策略门 + 前端守卫双保险）。
    /// 运维显式配置 LLMGW_ADMIN_PASSWORD 的账号视为已知口令，不置该标记。
    /// </summary>
    public bool MustChangePassword { get; set; }

    /// <summary>
    /// 口令是否已被真人主动改过（认领）。change-password 成功后置 true。
    /// 默认模式下：未认领的账号（含历史遗留、无该字段的旧文档=false）每次启动确定性自愈回 admin/admin，
    /// 保证控制台永远可从 admin/admin 进入；已认领的账号则保留口令、绝不回退。
    /// </summary>
    public bool PasswordChangedByUser { get; set; }

    public string[] Scopes { get; set; } = Array.Empty<string>();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
