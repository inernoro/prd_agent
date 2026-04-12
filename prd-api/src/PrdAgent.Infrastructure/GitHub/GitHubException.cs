namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// GitHub 基础设施层统一错误码（与 GitHub REST API 对应的通用错误，
/// 不依赖任何具体应用——PR 审查、周报、日报等都复用同一套）。
///
/// 调用方（Controller / Service）根据 <see cref="GitHubException.Code"/>
/// 映射到 HTTP 状态码和前端文案。
/// </summary>
public static class GitHubErrorCodes
{
    /// <summary>用户尚未连接 GitHub（412 Precondition Required）</summary>
    public const string GITHUB_NOT_CONNECTED = "GITHUB_NOT_CONNECTED";

    /// <summary>用户保存的 GitHub token 无效或已过期（401）</summary>
    public const string GITHUB_TOKEN_EXPIRED = "GITHUB_TOKEN_EXPIRED";

    /// <summary>OAuth 配置缺失（503：管理员未配置 ClientId/ClientSecret）</summary>
    public const string GITHUB_OAUTH_NOT_CONFIGURED = "GITHUB_OAUTH_NOT_CONFIGURED";

    /// <summary>Device Flow token 已过期或签名无效（403）</summary>
    public const string DEVICE_FLOW_TOKEN_INVALID = "DEVICE_FLOW_TOKEN_INVALID";

    /// <summary>Device Flow 授权已过期（用户未在 15 分钟内完成）</summary>
    public const string DEVICE_FLOW_EXPIRED = "DEVICE_FLOW_EXPIRED";

    /// <summary>用户在 GitHub 页面拒绝了授权</summary>
    public const string DEVICE_FLOW_ACCESS_DENIED = "DEVICE_FLOW_ACCESS_DENIED";

    /// <summary>Device Flow 请求 GitHub API 失败（502）</summary>
    public const string DEVICE_FLOW_REQUEST_FAILED = "DEVICE_FLOW_REQUEST_FAILED";

    /// <summary>PR URL 格式错误或含不安全字符（400）</summary>
    public const string PR_URL_INVALID = "PR_URL_INVALID";

    /// <summary>仓库对当前 token 不可见——私有仓无权访问 or 仓库不存在（404）</summary>
    public const string GITHUB_REPO_NOT_VISIBLE = "GITHUB_REPO_NOT_VISIBLE";

    /// <summary>仓库可见但 PR 编号无效（404）</summary>
    public const string PR_NUMBER_INVALID = "PR_NUMBER_INVALID";

    /// <summary>GitHub 拒绝访问但不是 token 失效（403）</summary>
    public const string GITHUB_FORBIDDEN = "GITHUB_FORBIDDEN";

    /// <summary>GitHub 速率限制（429，附带 Reset 时间）</summary>
    public const string GITHUB_RATE_LIMITED = "GITHUB_RATE_LIMITED";

    /// <summary>GitHub 返回 5xx（502）</summary>
    public const string GITHUB_UPSTREAM_ERROR = "GITHUB_UPSTREAM_ERROR";
}

/// <summary>
/// GitHub 基础设施层领域异常 —— 通用 GitHub API 调用错误。
///
/// Controller 全局 catch 此类型，依据 <see cref="Code"/> + <see cref="HttpStatus"/>
/// 映射到 <see cref="Microsoft.AspNetCore.Mvc.ObjectResult"/>。
///
/// 应用层自己的领域异常（如 PR 审查的 ItemNotFound / Duplicate）可以继承本类，
/// 参见 <c>PrdAgent.Api.Services.PrReview.PrReviewException</c>。
/// </summary>
public class GitHubException : Exception
{
    public string Code { get; }
    public int HttpStatus { get; }

    public GitHubException(string code, int httpStatus, string message) : base(message)
    {
        Code = code;
        HttpStatus = httpStatus;
    }

    // ===== Generic GitHub factory methods =====

    public static GitHubException NotConnected() =>
        new(GitHubErrorCodes.GITHUB_NOT_CONNECTED, 412, "尚未连接 GitHub 账号，请先授权");

    public static GitHubException TokenExpired() =>
        new(GitHubErrorCodes.GITHUB_TOKEN_EXPIRED, 401, "GitHub 连接已过期，请重新授权");

    public static GitHubException UrlInvalid(string reason) =>
        new(GitHubErrorCodes.PR_URL_INVALID, 400, reason);

    public static GitHubException RepoNotVisible(string owner, string repo) =>
        new(GitHubErrorCodes.GITHUB_REPO_NOT_VISIBLE, 404,
            $"仓库 {owner}/{repo} 不存在，或你的 GitHub 账号无权访问（私有仓需要 repo scope）");

    public static GitHubException PrNumberInvalid(string owner, string repo, int number) =>
        new(GitHubErrorCodes.PR_NUMBER_INVALID, 404,
            $"仓库 {owner}/{repo} 可见，但 PR #{number} 不存在");

    public static GitHubException Forbidden() =>
        new(GitHubErrorCodes.GITHUB_FORBIDDEN, 403, "GitHub 拒绝访问该资源");

    public static GitHubException RateLimited(string? retryAfter) =>
        new(GitHubErrorCodes.GITHUB_RATE_LIMITED, 429,
            retryAfter != null
                ? $"GitHub 调用速率已达上限，请在 {retryAfter} 后重试"
                : "GitHub 调用速率已达上限，请稍后重试");

    public static GitHubException Upstream(int status) =>
        new(GitHubErrorCodes.GITHUB_UPSTREAM_ERROR, 502, $"GitHub API 异常（HTTP {status}）");

    public static GitHubException OAuthNotConfigured() =>
        new(GitHubErrorCodes.GITHUB_OAUTH_NOT_CONFIGURED, 503,
            "GitHub OAuth App 未配置，请联系管理员设置 GitHubOAuth:ClientId 并在 OAuth App 设置里勾选 Enable Device Flow");

    public static GitHubException DeviceFlowTokenInvalid() =>
        new(GitHubErrorCodes.DEVICE_FLOW_TOKEN_INVALID, 403, "授权会话无效或已过期，请重新发起连接");

    public static GitHubException DeviceFlowExpired() =>
        new(GitHubErrorCodes.DEVICE_FLOW_EXPIRED, 408, "授权已超时，请重新发起连接");

    public static GitHubException DeviceFlowAccessDenied() =>
        new(GitHubErrorCodes.DEVICE_FLOW_ACCESS_DENIED, 403, "你在 GitHub 页面拒绝了授权");

    public static GitHubException DeviceFlowRequestFailed(string reason) =>
        new(GitHubErrorCodes.DEVICE_FLOW_REQUEST_FAILED, 502, $"调用 GitHub Device Flow 失败：{reason}");
}
