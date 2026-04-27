using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.Authorization;

/// <summary>
/// GitHub 授权处理器（只读映射，不参与真正的 OAuth 流程）。
///
/// GitHub 的 OAuth Device Flow 由现有 PR 审查模块负责，凭证存于
/// github_user_connections 集合。本 handler 仅用于：
/// 1. 外部授权中心列表展示 GitHub 条目
/// 2. 不支持通过本中心添加/编辑——只读
///
/// 真正的 GitHub 授权流程请走 /api/github-oauth/device-flow/start
/// </summary>
public class GitHubAuthHandler : IAuthTypeHandler
{
    public string TypeKey => "github";
    public string DisplayName => "GitHub";

    public IReadOnlyList<AuthFieldDefinition> CredentialFields => new[]
    {
        // GitHub 不走本中心的表单，而是跳转到 OAuth Device Flow
        // 这里留一个占位字段是为了保持接口一致性
        new AuthFieldDefinition
        {
            Key = "_readonly",
            Label = "GitHub 授权请前往 PR 审查模块发起 OAuth 授权",
            Type = "text",
            Required = false,
        },
    };

    public Task<AuthValidationResult> ValidateAsync(Dictionary<string, string> credentials, CancellationToken ct)
    {
        // GitHub 的有效性由现有 PR 审查模块维护，本中心不主动验证
        return Task.FromResult(AuthValidationResult.Success());
    }

    public Task<Dictionary<string, object>> ExtractMetadataAsync(Dictionary<string, string> credentials, CancellationToken ct)
    {
        return Task.FromResult(new Dictionary<string, object>());
    }

    public Dictionary<string, string> MaskCredentials(Dictionary<string, string> credentials)
    {
        return new Dictionary<string, string>(); // 不返回任何凭证字段
    }
}
