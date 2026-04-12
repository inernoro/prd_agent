using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// GitHub 操作基础设施组件 —— 统一的 GitHub REST API 入口。
///
/// 定位：
///   和 <see cref="PrdAgent.Infrastructure.LlmGateway.ILlmGateway"/> 同级的独立基础设施组件。
///   封装所有对 GitHub API 的 HTTP 调用，消灭散落在各模块（周报同步、PR 审查工作台、
///   未来的日报/检测功能等）里的重复 HttpClient/Authorization 胶水代码。
///
/// 职责：
///   - 发起 GitHub REST API 请求（使用调用方传入的 access token，不管凭证来源）
///   - 把 HTTP 错误分类为 <see cref="GitHubException"/> 领域异常
///   - 内置 SSRF 白名单校验、体积截断、404 两步探测等安全措施
///
/// 非职责：
///   - 不存储/加密/解析 OAuth token —— 见 <see cref="IGitHubOAuthService"/> 和
///     <see cref="GitHubUserConnection"/>
///   - 不做 per-user/per-app 授权判定 —— 由调用方的 Controller/Service 负责
///   - 不 cache 响应 —— 每次都打实网
///
/// 调用约定：
///   所有方法的第一参数都是 <paramref name="accessToken"/>——调用方按自己的授权模型
///   （per-user OAuth、per-app PAT、per-installation App token 等）解析出 token 后传入。
///   组件本身与凭证来源无关，天然支持 R5"各 app 单独授权"。
/// </summary>
public interface IGitHubClient
{
    /// <summary>
    /// 拉取一个 PR 的完整快照（含 files + linked issue）。
    /// 失败时抛 <see cref="GitHubException"/>，Code 字段指示具体原因。
    /// </summary>
    Task<PrReviewSnapshot> FetchPullRequestAsync(
        string accessToken,
        string owner,
        string repo,
        int number,
        CancellationToken ct);

    /// <summary>
    /// 细粒度版本：控制是否要一起拉取 files/linked issue（省配额场景）。
    /// </summary>
    Task<PrReviewSnapshot> FetchPullRequestAsync(
        string accessToken,
        string owner,
        string repo,
        int number,
        bool includeFilesAndIssue,
        CancellationToken ct);

    /// <summary>
    /// 并行拉取一个 PR 的完整审查历史（commits + reviews + comments + timeline + check-runs）。
    /// 子请求失败不致命——失败的字段返回空列表，调用方应检查 Errors 字段。
    /// </summary>
    Task<GitHubPrHistoryDto> FetchHistoryAsync(
        string accessToken,
        string owner,
        string repo,
        int number,
        string? headSha,
        CancellationToken ct);

    /// <summary>
    /// 按类型懒加载单个 tab 的数据，支持分页。
    /// 返回 items + hasMore 标记，hasMore=true 时前端显示"加载更多"按钮。
    /// 支持的 type：timeline / commits / reviews / reviewComments / issueComments / checkRuns
    /// </summary>
    Task<object> FetchHistorySliceAsync(
        string accessToken,
        string owner,
        string repo,
        int number,
        string? headSha,
        string type,
        int page,
        int perPage,
        CancellationToken ct);
}
