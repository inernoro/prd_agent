namespace PrdAgent.Core.Models;

/// <summary>
/// 每个 PRD Agent 用户自己的 GitHub OAuth 连接。
/// 由 pr-review 应用使用：用户授权后，代表该用户调用 GitHub REST API 拉取 PR 数据。
/// 单用户单连接——重新授权会覆盖同 UserId 记录。
/// </summary>
public class GitHubUserConnection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>PRD Agent 内部 UserId（唯一索引）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>GitHub 账号 login（用户名）</summary>
    public string GitHubLogin { get; set; } = string.Empty;

    /// <summary>GitHub 账号的数字 ID（用于身份指纹，防同名漂移）</summary>
    public string GitHubUserId { get; set; } = string.Empty;

    /// <summary>GitHub 头像 URL</summary>
    public string? AvatarUrl { get; set; }

    /// <summary>
    /// 加密后的 access token（格式：IV:Cipher，见 ApiKeyCrypto）。
    /// 解密密钥来自 Jwt:Secret；若 Jwt:Secret 缺失，启动时 fail-fast，避免弱默认。
    /// </summary>
    public string AccessTokenEncrypted { get; set; } = string.Empty;

    /// <summary>授权时授予的 scope 列表（以逗号分隔），例如 "repo,read:user"</summary>
    public string Scopes { get; set; } = string.Empty;

    /// <summary>授权连接建立时间（首次授权 or 重新授权）</summary>
    public DateTime ConnectedAt { get; set; } = DateTime.UtcNow;

    /// <summary>最近一次使用该 token 调用 GitHub 的时间（用于可观测性，非必需）</summary>
    public DateTime? LastUsedAt { get; set; }
}
