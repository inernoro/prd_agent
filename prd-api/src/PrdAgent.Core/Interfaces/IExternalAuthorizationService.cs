using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 外部授权中心服务接口。
/// 封装加密存储、凭证解析、状态流转等核心逻辑。
/// </summary>
public interface IExternalAuthorizationService
{
    Task<List<ExternalAuthorization>> ListByUserAsync(string userId, CancellationToken ct);

    Task<ExternalAuthorization?> GetAsync(string userId, string id, CancellationToken ct);

    Task<ExternalAuthorization> CreateAsync(
        string userId,
        string type,
        string name,
        Dictionary<string, string> credentials,
        CancellationToken ct);

    Task<ExternalAuthorization> UpdateAsync(
        string userId,
        string id,
        string? name,
        Dictionary<string, string>? credentials,
        CancellationToken ct);

    Task RevokeAsync(string userId, string id, CancellationToken ct);

    Task<AuthValidationResult> ValidateAsync(string userId, string id, CancellationToken ct);

    /// <summary>
    /// 解密并返回明文凭证。
    /// ⚠ 仅供工作流引擎等内部服务调用，不可暴露给前端。
    /// 调用时会更新 LastUsedAt 并记录审计日志。
    /// </summary>
    Task<Dictionary<string, string>?> ResolveCredentialsAsync(
        string userId,
        string id,
        string consumer,
        CancellationToken ct);

    /// <summary>
    /// 获取脱敏凭证（供前端展示）。
    /// </summary>
    Task<Dictionary<string, string>?> GetMaskedCredentialsAsync(
        string userId,
        string id,
        CancellationToken ct);
}
