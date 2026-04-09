using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.PrReviewPrism;

public sealed class GitHubPrReviewPrismService
{
    private const string GateCheckName = "PR审查棱镜 L1 Gate";
    private const string MarkerBegin = "<!-- pr-review-prism-decision-card:begin -->";
    private const string MarkerEnd = "<!-- pr-review-prism-decision-card:end -->";
    private const string LegacyMarkerBegin = "<!-- pr-architect-decision-card:begin -->";
    private const string LegacyMarkerEnd = "<!-- pr-architect-decision-card:end -->";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private static readonly Regex PrUrlRegex = new(
        @"^https?://github\.com/(?<owner>[^/\s]+)/(?<repo>[^/\s]+)/pull/(?<number>\d+)(?:[/?#].*)?$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;

    public GitHubPrReviewPrismService(
        IHttpClientFactory httpClientFactory,
        IConfiguration config)
    {
        _httpClientFactory = httpClientFactory;
        _config = config;
    }

    public static bool TryParsePullRequestUrl(
        string rawUrl,
        out string? owner,
        out string? repo,
        out int prNumber)
    {
        owner = null;
        repo = null;
        prNumber = 0;
        if (string.IsNullOrWhiteSpace(rawUrl))
        {
            return false;
        }

        var normalized = rawUrl.Trim();
        if (normalized.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[..^4];
        }

        var match = PrUrlRegex.Match(normalized);
        if (!match.Success)
        {
            return false;
        }

        var parsedOwner = match.Groups["owner"].Value.Trim();
        var parsedRepo = match.Groups["repo"].Value.Trim();
        if (!int.TryParse(match.Groups["number"].Value, out var parsedPrNumber) || parsedPrNumber <= 0)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(parsedOwner) || string.IsNullOrWhiteSpace(parsedRepo))
        {
            return false;
        }

        owner = parsedOwner;
        repo = parsedRepo;
        prNumber = parsedPrNumber;
        return true;
    }

    public async Task<PrReviewPrismSnapshot> BuildSnapshotAsync(string repoOwner, string repoName, int prNumber)
    {
        var token = ResolveGitHubToken();
        if (string.IsNullOrWhiteSpace(token))
        {
            throw new InvalidOperationException("缺少 GitHub Token 配置（GitHub:Token）");
        }

        var client = _httpClientFactory.CreateClient("GitHubApi");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        client.DefaultRequestHeaders.UserAgent.Clear();
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("PrdAgent", "1.0"));
        client.DefaultRequestHeaders.Remove("X-GitHub-Api-Version");
        client.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");

        var pr = await GetPullRequestAsync(client, repoOwner, repoName, prNumber, CancellationToken.None);
        if (pr == null)
        {
            throw new InvalidOperationException("无法获取 GitHub PR 信息，请检查仓库权限与链接");
        }

        var snapshot = new PrReviewPrismSnapshot
        {
            RepoOwner = repoOwner,
            RepoName = repoName,
            PullRequestNumber = prNumber,
            PullRequestTitle = pr.Title ?? string.Empty,
            PullRequestAuthor = pr.User?.Login ?? string.Empty,
            PullRequestState = pr.MergedAt != null ? "merged" : (pr.State ?? "open"),
            PullRequestUrl = pr.HtmlUrl ?? $"https://github.com/{repoOwner}/{repoName}/pull/{prNumber}",
            HeadSha = pr.Head?.Sha,
            LastFetchedAt = DateTime.UtcNow,
        };

        var checkRun = await GetGateCheckRunAsync(client, repoOwner, repoName, snapshot.HeadSha, CancellationToken.None);
        if (checkRun == null)
        {
            snapshot.GateStatus = PrReviewPrismGateStatuses.Missing;
        }
        else
        {
            snapshot.GateStatus = checkRun.Status == "completed"
                ? PrReviewPrismGateStatuses.Completed
                : PrReviewPrismGateStatuses.Pending;
            snapshot.GateConclusion = checkRun.Conclusion;
            snapshot.GateDetailsUrl = checkRun.DetailsUrl;
        }

        var decisionCard = await GetDecisionCardAsync(client, repoOwner, repoName, prNumber, CancellationToken.None);
        if (decisionCard != null)
        {
            snapshot.DecisionSuggestion = decisionCard.DecisionSuggestion;
            snapshot.RiskScore = decisionCard.RiskScore;
            snapshot.ConfidencePercent = decisionCard.ConfidencePercent;
            snapshot.BlockersTriggered = decisionCard.BlockersTriggered;
            snapshot.Blockers = decisionCard.Blockers;
            snapshot.Advisories = decisionCard.Advisories;
            snapshot.FocusQuestions = decisionCard.FocusQuestions;
            snapshot.DecisionCardCommentUrl = decisionCard.CommentUrl;
            snapshot.DecisionCardUpdatedAt = decisionCard.UpdatedAt;
        }

        return snapshot;
    }

    private string? ResolveGitHubToken()
    {
        return _config["GitHub:Token"]
            ?? _config["GitHub:ApiToken"]
            ?? _config["GitHub__Token"]
            ?? _config["PR_REVIEW_PRISM_GITHUB_TOKEN"];
    }

    private static async Task<PullRequestDto?> GetPullRequestAsync(
        HttpClient client,
        string owner,
        string repo,
        int prNumber,
        CancellationToken ct)
    {
        var url = $"https://api.github.com/repos/{owner}/{repo}/pulls/{prNumber}";
        using var resp = await client.GetAsync(url, ct);
        if (!resp.IsSuccessStatusCode)
        {
            return null;
        }

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        return await JsonSerializer.DeserializeAsync<PullRequestDto>(stream, JsonOptions, ct);
    }

    private static async Task<CheckRunDto?> GetGateCheckRunAsync(
        HttpClient client,
        string owner,
        string repo,
        string? headSha,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(headSha))
        {
            return null;
        }

        var url = $"https://api.github.com/repos/{owner}/{repo}/commits/{headSha}/check-runs";
        using var resp = await client.GetAsync(url, ct);
        if (!resp.IsSuccessStatusCode)
        {
            return null;
        }

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        var payload = await JsonSerializer.DeserializeAsync<CheckRunsResponseDto>(stream, JsonOptions, ct);
        return payload?.CheckRuns?.FirstOrDefault(x => string.Equals(x.Name, GateCheckName, StringComparison.Ordinal));
    }

    private static async Task<DecisionCardDto?> GetDecisionCardAsync(
        HttpClient client,
        string owner,
        string repo,
        int prNumber,
        CancellationToken ct)
    {
        var url = $"https://api.github.com/repos/{owner}/{repo}/issues/{prNumber}/comments?per_page=100";
        using var resp = await client.GetAsync(url, ct);
        if (!resp.IsSuccessStatusCode)
        {
            return null;
        }

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        var comments = await JsonSerializer.DeserializeAsync<List<IssueCommentDto>>(stream, JsonOptions, ct) ?? new List<IssueCommentDto>();
        var target = comments
            .Where(c => !string.IsNullOrWhiteSpace(c.Body))
            .LastOrDefault(c => ContainsDecisionCardMarkers(c.Body!));
        if (target == null)
        {
            return null;
        }

        return ParseDecisionCard(target);
    }

    private static bool ContainsDecisionCardMarkers(string body)
    {
        return (body.Contains(MarkerBegin, StringComparison.Ordinal) && body.Contains(MarkerEnd, StringComparison.Ordinal))
               || (body.Contains(LegacyMarkerBegin, StringComparison.Ordinal) && body.Contains(LegacyMarkerEnd, StringComparison.Ordinal));
    }

    private static DecisionCardDto ParseDecisionCard(IssueCommentDto comment)
    {
        var lines = (comment.Body ?? string.Empty)
            .Split('\n', StringSplitOptions.TrimEntries)
            .Select(x => x.Trim())
            .ToList();

        string? decision = null;
        int? riskScore = null;
        int? confidence = null;
        bool? blockersTriggered = null;
        var blockers = new List<string>();
        var advisories = new List<string>();
        var focus = new List<string>();

        var section = string.Empty;
        foreach (var line in lines)
        {
            if (line.StartsWith("### ", StringComparison.Ordinal))
            {
                section = line;
                continue;
            }

            if (line.StartsWith("- 建议:", StringComparison.Ordinal))
            {
                decision = NormalizeBacktickValue(line[(line.IndexOf(':') + 1)..]);
                continue;
            }

            if (line.StartsWith("- 风险分:", StringComparison.Ordinal))
            {
                riskScore = ParseLeadingInt(NormalizeBacktickValue(line[(line.IndexOf(':') + 1)..]));
                continue;
            }

            if (line.StartsWith("- 置信度:", StringComparison.Ordinal))
            {
                confidence = ParseLeadingInt(NormalizeBacktickValue(line[(line.IndexOf(':') + 1)..]));
                continue;
            }

            if (line.StartsWith("- 触发硬阻断:", StringComparison.Ordinal))
            {
                var value = NormalizeBacktickValue(line[(line.IndexOf(':') + 1)..]);
                blockersTriggered = value.Equals("yes", StringComparison.OrdinalIgnoreCase)
                                    || value.Equals("true", StringComparison.OrdinalIgnoreCase);
                continue;
            }

            if (section.StartsWith("### C.", StringComparison.Ordinal) && line.StartsWith("- ", StringComparison.Ordinal))
            {
                var value = line[2..].Trim();
                if (!value.Equals("None", StringComparison.OrdinalIgnoreCase))
                {
                    blockers.Add(value);
                }
                continue;
            }

            if (section.StartsWith("### D.", StringComparison.Ordinal) && line.StartsWith("- ", StringComparison.Ordinal))
            {
                var value = line[2..].Trim();
                if (!value.Equals("None", StringComparison.OrdinalIgnoreCase))
                {
                    advisories.Add(value);
                }
                continue;
            }

            if (section.StartsWith("### E.", StringComparison.Ordinal))
            {
                if (line.Length > 2 && char.IsDigit(line[0]) && line[1] == '.')
                {
                    var value = line[2..].Trim();
                    if (!value.Equals("N/A", StringComparison.OrdinalIgnoreCase))
                    {
                        focus.Add(value);
                    }
                }
            }
        }

        return new DecisionCardDto
        {
            DecisionSuggestion = decision,
            RiskScore = riskScore,
            ConfidencePercent = confidence,
            BlockersTriggered = blockersTriggered,
            Blockers = blockers,
            Advisories = advisories,
            FocusQuestions = focus.Take(3).ToList(),
            CommentUrl = comment.HtmlUrl,
            UpdatedAt = comment.UpdatedAt,
        };
    }

    private static string NormalizeBacktickValue(string raw)
    {
        return raw.Trim().Trim('`').Trim();
    }

    private static int? ParseLeadingInt(string raw)
    {
        var digits = new string(raw.TakeWhile(char.IsDigit).ToArray());
        if (int.TryParse(digits, out var v))
        {
            return v;
        }

        return null;
    }

    private sealed class PullRequestDto
    {
        public string? Title { get; set; }
        public string? State { get; set; }
        public DateTime? MergedAt { get; set; }
        public string? HtmlUrl { get; set; }
        public PullRequestUserDto? User { get; set; }
        public PullRequestHeadDto? Head { get; set; }
    }

    private sealed class PullRequestUserDto
    {
        public string? Login { get; set; }
    }

    private sealed class PullRequestHeadDto
    {
        public string? Sha { get; set; }
    }

    private sealed class CheckRunsResponseDto
    {
        public List<CheckRunDto>? CheckRuns { get; set; }
    }

    private sealed class CheckRunDto
    {
        public string? Name { get; set; }
        public string? Status { get; set; }
        public string? Conclusion { get; set; }
        public string? DetailsUrl { get; set; }
    }

    private sealed class IssueCommentDto
    {
        public string? Body { get; set; }
        public string? HtmlUrl { get; set; }
        public DateTime? UpdatedAt { get; set; }
    }
}

public sealed class PrReviewPrismSnapshot
{
    public string RepoOwner { get; set; } = string.Empty;
    public string RepoName { get; set; } = string.Empty;
    public int PullRequestNumber { get; set; }
    public string PullRequestTitle { get; set; } = string.Empty;
    public string PullRequestAuthor { get; set; } = string.Empty;
    public string PullRequestState { get; set; } = "open";
    public string PullRequestUrl { get; set; } = string.Empty;
    public string? HeadSha { get; set; }
    public string GateStatus { get; set; } = PrReviewPrismGateStatuses.Pending;
    public string? GateConclusion { get; set; }
    public string? GateDetailsUrl { get; set; }
    public string? DecisionSuggestion { get; set; }
    public int? RiskScore { get; set; }
    public int? ConfidencePercent { get; set; }
    public bool? BlockersTriggered { get; set; }
    public List<string> Blockers { get; set; } = new();
    public List<string> Advisories { get; set; } = new();
    public List<string> FocusQuestions { get; set; } = new();
    public string? DecisionCardCommentUrl { get; set; }
    public DateTime? DecisionCardUpdatedAt { get; set; }
    public DateTime LastFetchedAt { get; set; } = DateTime.UtcNow;
}

public sealed class DecisionCardDto
{
    public string? DecisionSuggestion { get; set; }
    public int? RiskScore { get; set; }
    public int? ConfidencePercent { get; set; }
    public bool? BlockersTriggered { get; set; }
    public List<string> Blockers { get; set; } = new();
    public List<string> Advisories { get; set; } = new();
    public List<string> FocusQuestions { get; set; } = new();
    public string? CommentUrl { get; set; }
    public DateTime? UpdatedAt { get; set; }
}
