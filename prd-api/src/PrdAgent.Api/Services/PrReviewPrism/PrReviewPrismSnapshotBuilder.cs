namespace PrdAgent.Api.Services.PrReviewPrism;

/// <summary>
/// PR 审查棱镜快照构建器：解析 PR URL + 拉取 GitHub 快照
/// </summary>
public sealed class PrReviewPrismSnapshotBuilder
{
    private readonly GitHubPrReviewPrismService _gitHubService;

    public PrReviewPrismSnapshotBuilder(GitHubPrReviewPrismService gitHubService)
    {
        _gitHubService = gitHubService;
    }

    public Task<PrReviewPrismSnapshot> BuildSnapshotAsync(string repoOwner, string repoName, int prNumber)
    {
        return _gitHubService.BuildSnapshotAsync(repoOwner, repoName, prNumber);
    }

    public Task<PrReviewPrismPrecheckResult> PrecheckPullRequestAsync(string repoOwner, string repoName, int prNumber)
    {
        return _gitHubService.PrecheckPullRequestAsync(repoOwner, repoName, prNumber);
    }

    public static bool TryParsePullRequestUrl(
        string url,
        out string? owner,
        out string? repo,
        out int prNumber)
    {
        return GitHubPrReviewPrismService.TryParsePullRequestUrl(url, out owner, out repo, out prNumber);
    }
}
