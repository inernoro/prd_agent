namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// PR Review V2 统一错误码。Controller 依据 Code 映射 HTTP 状态码和前端文案。
/// </summary>
public static class PrReviewErrorCodes
{
    /// <summary>用户尚未连接 GitHub（412 Precondition Required）</summary>
    public const string GITHUB_NOT_CONNECTED = "GITHUB_NOT_CONNECTED";

    /// <summary>用户保存的 GitHub token 无效或已过期（401）</summary>
    public const string GITHUB_TOKEN_EXPIRED = "GITHUB_TOKEN_EXPIRED";

    /// <summary>OAuth state 校验失败（403）</summary>
    public const string GITHUB_STATE_INVALID = "GITHUB_STATE_INVALID";

    /// <summary>OAuth code 换 token 失败（502）</summary>
    public const string GITHUB_OAUTH_EXCHANGE_FAILED = "GITHUB_OAUTH_EXCHANGE_FAILED";

    /// <summary>OAuth 配置缺失（503：管理员未配置 ClientId/ClientSecret）</summary>
    public const string GITHUB_OAUTH_NOT_CONFIGURED = "GITHUB_OAUTH_NOT_CONFIGURED";

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

    /// <summary>PR 记录不存在（404）</summary>
    public const string PR_ITEM_NOT_FOUND = "PR_ITEM_NOT_FOUND";

    /// <summary>同一用户已添加过同仓库同编号的 PR（409）</summary>
    public const string PR_ITEM_DUPLICATE = "PR_ITEM_DUPLICATE";
}

/// <summary>
/// 携带状态码和错误码的领域异常。
/// Controller 用全局 catch 映射到 <see cref="Microsoft.AspNetCore.Mvc.ObjectResult"/>。
/// </summary>
public sealed class PrReviewException : Exception
{
    public string Code { get; }
    public int HttpStatus { get; }

    public PrReviewException(string code, int httpStatus, string message) : base(message)
    {
        Code = code;
        HttpStatus = httpStatus;
    }

    public static PrReviewException NotConnected() =>
        new(PrReviewErrorCodes.GITHUB_NOT_CONNECTED, 412, "尚未连接 GitHub 账号，请先授权");

    public static PrReviewException TokenExpired() =>
        new(PrReviewErrorCodes.GITHUB_TOKEN_EXPIRED, 401, "GitHub 连接已过期，请重新授权");

    public static PrReviewException UrlInvalid(string reason) =>
        new(PrReviewErrorCodes.PR_URL_INVALID, 400, reason);

    public static PrReviewException RepoNotVisible(string owner, string repo) =>
        new(PrReviewErrorCodes.GITHUB_REPO_NOT_VISIBLE, 404,
            $"仓库 {owner}/{repo} 不存在，或你的 GitHub 账号无权访问（私有仓需要 repo scope）");

    public static PrReviewException PrNumberInvalid(string owner, string repo, int number) =>
        new(PrReviewErrorCodes.PR_NUMBER_INVALID, 404,
            $"仓库 {owner}/{repo} 可见，但 PR #{number} 不存在");

    public static PrReviewException Forbidden() =>
        new(PrReviewErrorCodes.GITHUB_FORBIDDEN, 403, "GitHub 拒绝访问该资源");

    public static PrReviewException RateLimited(string? retryAfter) =>
        new(PrReviewErrorCodes.GITHUB_RATE_LIMITED, 429,
            retryAfter != null
                ? $"GitHub 调用速率已达上限，请在 {retryAfter} 后重试"
                : "GitHub 调用速率已达上限，请稍后重试");

    public static PrReviewException Upstream(int status) =>
        new(PrReviewErrorCodes.GITHUB_UPSTREAM_ERROR, 502, $"GitHub API 异常（HTTP {status}）");

    public static PrReviewException ItemNotFound() =>
        new(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, 404, "PR 记录不存在或不属于你");

    public static PrReviewException Duplicate() =>
        new(PrReviewErrorCodes.PR_ITEM_DUPLICATE, 409, "你已经添加过这条 PR，可以直接刷新");

    public static PrReviewException OAuthNotConfigured() =>
        new(PrReviewErrorCodes.GITHUB_OAUTH_NOT_CONFIGURED, 503,
            "GitHub OAuth App 未配置，请联系管理员设置 GitHubOAuth:ClientId / GitHubOAuth:ClientSecret");

    public static PrReviewException StateInvalid() =>
        new(PrReviewErrorCodes.GITHUB_STATE_INVALID, 403, "OAuth state 校验失败，可能是伪造或已过期");

    public static PrReviewException OAuthExchangeFailed(string reason) =>
        new(PrReviewErrorCodes.GITHUB_OAUTH_EXCHANGE_FAILED, 502, $"GitHub 换 token 失败：{reason}");
}
