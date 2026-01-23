namespace PrdAgent.Core.Models;

/// <summary>
/// 仓库配置
/// </summary>
public class DefectRepoConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerUserId { get; set; } = null!;
    public string RepoOwner { get; set; } = null!;
    public string RepoName { get; set; } = null!;
    public string DefaultBranch { get; set; } = "main";
    public string PrBranchPrefix { get; set; } = "defect-agent/fix-";
    public List<string> DefaultReviewers { get; set; } = new();
    public List<string> DefaultLabels { get; set; } = new() { "bug", "ai-fix" };
    public GitHubAuthMethod AuthMethod { get; set; }
    public string? InstallationId { get; set; }
    public bool IsActive { get; set; } = true;

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public enum GitHubAuthMethod { GitHubApp, PersonalAccessToken, OAuth }

/// <summary>
/// GitHub 授权凭据 (加密存储)
/// </summary>
public class DefectGithubToken
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = null!;
    public GitHubAuthMethod AuthMethod { get; set; }

    /// <summary>加密的 Token 值</summary>
    public string EncryptedToken { get; set; } = null!;

    /// <summary>关联的 RepoConfig ID</summary>
    public string? RepoConfigId { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
}
