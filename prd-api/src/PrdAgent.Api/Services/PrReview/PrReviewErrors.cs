using PrdAgent.Infrastructure.GitHub;

namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// PR Review V2 应用层专属错误码。
///
/// 通用 GitHub 层错误（Token 失效、仓库不可见、限流等）由
/// <see cref="PrdAgent.Infrastructure.GitHub.GitHubErrorCodes"/> 提供；
/// 这里只定义 PR 审查工作台自己的领域错误——"PR 记录不存在"、"重复添加"等
/// 与 GitHub API 无关、仅在本应用的持久层/业务层产生的错误。
/// </summary>
public static class PrReviewErrorCodes
{
    /// <summary>PR 记录不存在（404）</summary>
    public const string PR_ITEM_NOT_FOUND = "PR_ITEM_NOT_FOUND";

    /// <summary>同一用户已添加过同仓库同编号的 PR（409）</summary>
    public const string PR_ITEM_DUPLICATE = "PR_ITEM_DUPLICATE";
}

/// <summary>
/// PR Review V2 领域异常，继承自 <see cref="GitHubException"/>。
///
/// 继承动机：
///   - PR 审查 Controller 依赖 <see cref="GitHubException.Code"/> +
///     <see cref="GitHubException.HttpStatus"/> 字段做统一映射
///   - 继承后 Controller 只 catch <see cref="GitHubException"/> 即可一次性捕获
///     基础设施层抛出的通用错误 + 本类抛出的应用层错误
///   - 静态工厂方法按归属拆分：通用 GitHub 错误走 <c>GitHubException.X()</c>，
///     PR 审查专属错误走 <c>PrReviewException.X()</c>
///
/// 这样做避免了在基础设施层引入"PR 记录"等应用概念，保持组件的通用性。
/// </summary>
public sealed class PrReviewException : GitHubException
{
    public PrReviewException(string code, int httpStatus, string message)
        : base(code, httpStatus, message)
    {
    }

    // ===== PR Review application-specific factory methods =====
    // Generic GitHub errors live on GitHubException (see Infrastructure/GitHub/GitHubException.cs).

    public static PrReviewException ItemNotFound() =>
        new(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, 404, "PR 记录不存在或不属于你");

    public static PrReviewException Duplicate() =>
        new(PrReviewErrorCodes.PR_ITEM_DUPLICATE, 409, "你已经添加过这条 PR，可以直接刷新");
}
