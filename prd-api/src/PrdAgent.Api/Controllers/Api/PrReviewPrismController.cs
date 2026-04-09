using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.PrReviewPrism;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// PR审查棱镜（独立于产品评审员 review-agent）：
/// 提交 GitHub PR 链接并拉取 L1 Gate 与决策卡可视化结果。
/// </summary>
[ApiController]
[Route("api/pr-review-prism")]
[Authorize]
[AdminController("pr-review-prism", AdminPermissionCatalog.PrReviewPrismUse)]
public sealed class PrReviewPrismController : ControllerBase
{
    private const string AppKey = "pr-review-prism";
    private readonly MongoDbContext _db;
    private readonly PrReviewPrismSnapshotBuilder _snapshotBuilder;
    private readonly ILogger<PrReviewPrismController> _logger;

    public PrReviewPrismController(
        MongoDbContext db,
        PrReviewPrismSnapshotBuilder snapshotBuilder,
        ILogger<PrReviewPrismController> logger)
    {
        _db = db;
        _snapshotBuilder = snapshotBuilder;
        _logger = logger;
    }

    /// <summary>
    /// 健康检查 / 占位：确认具备 pr-review-prism.use 后可调用。
    /// </summary>
    [HttpGet("status")]
    public IActionResult GetStatus()
    {
        return Ok(ApiResponse<object>.Ok(new
        {
            appKey = AppKey,
            phase = "active",
            message = "PR审查棱镜已接入 GitHub 审查结果可视化，可提交 PR 链接并查看 Gate/决策卡结果。",
        }));
    }

    /// <summary>
    /// 返回 PR 审查棱镜可用性与初始化配置状态（GitHub Token + 顶层设计基线）。
    /// </summary>
    [HttpGet("setup-status")]
    public IActionResult GetSetupStatus([FromQuery] string? repo = null)
    {
        var targetRepo = NormalizeRepoKey(repo);
        var githubTokenConfigured = IsGitHubTokenConfigured();
        var topDesign = InspectTopDesignSetup(targetRepo);

        var guidance = new List<string>();
        if (!string.IsNullOrWhiteSpace(repo) && targetRepo == null)
        {
            guidance.Add("repo 参数格式错误，应为 owner/repo 或 GitHub PR 链接");
        }

        if (!githubTokenConfigured)
        {
            guidance.Add("请先在后端配置 GitHub Token（GitHub:Token 或 PR_REVIEW_PRISM_GITHUB_TOKEN）");
        }

        if (!topDesign.RepoRootDetected)
        {
            guidance.Add("未检测到仓库根目录，无法校验顶层设计基线文件");
        }
        else
        {
            if (!topDesign.DesignSourcesExists)
            {
                guidance.Add("缺少 .github/pr-architect/design-sources.yml");
            }
            else if (topDesign.UsesBootstrapPlaceholder)
            {
                guidance.Add("当前 design-sources 仍是 bootstrap 占位源，请初始化真实顶设基线");
            }

            if (!topDesign.RepoBindingsExists || !topDesign.RepoBindingsHasRepositoryEntry)
            {
                guidance.Add("请在 .github/pr-architect/repo-bindings.yml 配置当前仓库绑定");
            }
            else if (!string.IsNullOrWhiteSpace(targetRepo) && !topDesign.RepoBindingMatchedTargetRepo)
            {
                guidance.Add($"仓库 {targetRepo} 尚未在 repo-bindings.yml 中完成绑定");
            }

            if (!topDesign.TopDesignDocExists || !topDesign.AnchorsExists || !topDesign.ContextsExists || !topDesign.SlicesExists)
            {
                guidance.Add("建议执行 `bash scripts/init-pr-prism-basis.sh`（零参数自动识别）初始化最薄顶设文档");
            }
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            githubTokenConfigured,
            topDesign,
            readyForFullRefresh = githubTokenConfigured && topDesign.Ready,
            guidance,
        }));
    }

    /// <summary>
    /// 导出“仓库专属 Skill 包”（zip），用于在新仓库一键落地 PR 审查棱镜最小接入。
    /// </summary>
    [HttpPost("bootstrap-skill-package")]
    public IActionResult ExportBootstrapSkillPackage([FromBody] PrReviewPrismRepoSkillPackageRequest req)
    {
        var normalizedRepo = NormalizeRepoKey(req.Repo);
        if (normalizedRepo == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "repo 参数格式错误，应为 owner/repo"));
        }

        var normalizedContext = NormalizeContextId(req.Context);
        var repoSlug = normalizedRepo.Replace("/", "-", StringComparison.Ordinal).ToLowerInvariant();
        var normalizedOwner = NormalizeGitHubOwner(req.Owner, fallback: normalizedRepo.Split('/')[0]);
        var normalizedAnchorId = NormalizeAnchorId(req.AnchorId, fallback: $"ANCHOR-{repoSlug.ToUpperInvariant()}-01");

        var root = TryFindRepoRoot();
        if (root == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未检测到仓库根目录，暂时无法导出接入包"));
        }

        var bootstrapScriptPath = Path.Combine(root, "scripts", "bootstrap-pr-prism.sh");
        var initScriptPath = Path.Combine(root, "scripts", "init-pr-prism-basis.sh");
        if (!System.IO.File.Exists(bootstrapScriptPath) || !System.IO.File.Exists(initScriptPath))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 bootstrap 脚本，请先确保 scripts/bootstrap-pr-prism.sh 与 scripts/init-pr-prism-basis.sh 存在"));
        }

        var bootstrapScript = System.IO.File.ReadAllText(bootstrapScriptPath);
        var initScript = System.IO.File.ReadAllText(initScriptPath);
        var skillMarkdown = BuildRepoBootstrapSkillMarkdown(normalizedRepo, normalizedOwner, normalizedContext, normalizedAnchorId);
        var guideMarkdown = BuildRepoBootstrapGuideMarkdown(normalizedRepo, normalizedOwner, normalizedContext, normalizedAnchorId);

        var zipBytes = BuildBootstrapSkillPackageZip(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["scripts/bootstrap-pr-prism.sh"] = bootstrapScript,
            ["scripts/init-pr-prism-basis.sh"] = initScript,
            [".claude/skills/pr-prism-bootstrap/SKILL.md"] = skillMarkdown,
            ["doc/guide.pr-prism-bootstrap-package.md"] = guideMarkdown,
        });

        return Ok(ApiResponse<object>.Ok(new
        {
            fileName = $"pr-prism-bootstrap-skill-{repoSlug}.zip",
            contentBase64 = Convert.ToBase64String(zipBytes),
        }));
    }

    [HttpPost("submissions")]
    public async Task<IActionResult> CreateSubmission([FromBody] CreatePrReviewPrismSubmissionRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.PullRequestUrl))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "pullRequestUrl 不能为空"));
        }

        var parse = PrReviewPrismSnapshotBuilder.TryParsePullRequestUrl(req.PullRequestUrl, out var owner, out var repo, out var prNumber);
        if (!parse)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "pullRequestUrl 不是有效的 GitHub PR 链接"));
        }

        var userId = this.GetRequiredUserId();
        var displayName = User.FindFirst("displayName")?.Value
                          ?? User.FindFirst("name")?.Value
                          ?? userId;

        var normalizedOwner = owner!.ToLowerInvariant();
        var normalizedRepo = repo!.ToLowerInvariant();
        var normalizedUrl = $"https://github.com/{normalizedOwner}/{normalizedRepo}/pull/{prNumber}";

        var existing = await _db.PrReviewPrismSubmissions
            .Find(x => x.OwnerUserId == userId
                       && x.RepoOwner == normalizedOwner
                       && x.RepoName == normalizedRepo
                       && x.PullRequestNumber == prNumber)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (existing != null)
        {
            existing.Note = string.IsNullOrWhiteSpace(req.Note) ? existing.Note : req.Note.Trim();
            existing.PullRequestUrl = normalizedUrl;
            existing.UpdatedAt = DateTime.UtcNow;

            try
            {
                var snapshot = await _snapshotBuilder.BuildSnapshotAsync(normalizedOwner, normalizedRepo, prNumber);
                ApplySnapshot(existing, snapshot);
                existing.LastRefreshError = null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "PrReviewPrism refresh existing failed: {Owner}/{Repo}#{Pr}", normalizedOwner, normalizedRepo, prNumber);
                existing.LastRefreshError = ex.Message;
                existing.GateStatus = PrReviewPrismGateStatuses.Error;
            }

            await _db.PrReviewPrismSubmissions.ReplaceOneAsync(
                x => x.Id == existing.Id,
                existing,
                cancellationToken: CancellationToken.None);

            return Ok(ApiResponse<object>.Ok(new { submission = existing, reused = true }));
        }

        var submission = new PrReviewPrismSubmission
        {
            OwnerUserId = userId,
            OwnerDisplayName = displayName,
            RepoOwner = normalizedOwner,
            RepoName = normalizedRepo,
            PullRequestNumber = prNumber,
            PullRequestUrl = normalizedUrl,
            Note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim(),
            GateStatus = PrReviewPrismGateStatuses.Pending,
        };

        try
        {
            var snapshot = await _snapshotBuilder.BuildSnapshotAsync(normalizedOwner, normalizedRepo, prNumber);
            ApplySnapshot(submission, snapshot);
            submission.LastRefreshError = null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReviewPrism initial refresh failed: {Owner}/{Repo}#{Pr}", normalizedOwner, normalizedRepo, prNumber);
            submission.LastRefreshError = ex.Message;
            submission.GateStatus = PrReviewPrismGateStatuses.Error;
        }

        await _db.PrReviewPrismSubmissions.InsertOneAsync(submission, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { submission, reused = false }));
    }

    [HttpGet("submissions")]
    public async Task<IActionResult> ListSubmissions(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? gateStatus = null,
        [FromQuery] string? q = null)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var userId = this.GetRequiredUserId();
        var filterBuilder = Builders<PrReviewPrismSubmission>.Filter;
        var allowedGateStatus = new[]
        {
            PrReviewPrismGateStatuses.Pending,
            PrReviewPrismGateStatuses.Completed,
            PrReviewPrismGateStatuses.Missing,
            PrReviewPrismGateStatuses.Error
        };
        string? normalizedGateStatus = null;
        if (!string.IsNullOrWhiteSpace(gateStatus))
        {
            normalizedGateStatus = gateStatus.Trim().ToLowerInvariant();
            if (!allowedGateStatus.Contains(normalizedGateStatus))
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.INVALID_FORMAT,
                    $"gateStatus 不支持：{gateStatus}"));
            }
        }

        var baseFilter = filterBuilder.Eq(x => x.OwnerUserId, userId);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var keyword = q.Trim();
            var regex = new MongoDB.Bson.BsonRegularExpression(keyword, "i");
            baseFilter &= filterBuilder.Or(
                filterBuilder.Regex(x => x.PullRequestTitle, regex),
                filterBuilder.Regex(x => x.RepoOwner, regex),
                filterBuilder.Regex(x => x.RepoName, regex),
                filterBuilder.Regex(x => x.Note, regex));
        }

        var filter = baseFilter;
        if (!string.IsNullOrWhiteSpace(normalizedGateStatus))
        {
            filter &= filterBuilder.Eq(x => x.GateStatus, normalizedGateStatus);
        }

        var gateStatusCounts = new
        {
            all = await _db.PrReviewPrismSubmissions.CountDocumentsAsync(baseFilter, cancellationToken: CancellationToken.None),
            pending = await _db.PrReviewPrismSubmissions.CountDocumentsAsync(
                baseFilter & filterBuilder.Eq(x => x.GateStatus, PrReviewPrismGateStatuses.Pending),
                cancellationToken: CancellationToken.None),
            completed = await _db.PrReviewPrismSubmissions.CountDocumentsAsync(
                baseFilter & filterBuilder.Eq(x => x.GateStatus, PrReviewPrismGateStatuses.Completed),
                cancellationToken: CancellationToken.None),
            missing = await _db.PrReviewPrismSubmissions.CountDocumentsAsync(
                baseFilter & filterBuilder.Eq(x => x.GateStatus, PrReviewPrismGateStatuses.Missing),
                cancellationToken: CancellationToken.None),
            error = await _db.PrReviewPrismSubmissions.CountDocumentsAsync(
                baseFilter & filterBuilder.Eq(x => x.GateStatus, PrReviewPrismGateStatuses.Error),
                cancellationToken: CancellationToken.None),
        };

        var total = await _db.PrReviewPrismSubmissions.CountDocumentsAsync(filter, cancellationToken: CancellationToken.None);
        var items = await _db.PrReviewPrismSubmissions
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize, gateStatusCounts }));
    }

    [HttpGet("submissions/{id}")]
    public async Task<IActionResult> GetSubmission(string id)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewPrismSubmissions
            .Find(x => x.Id == id && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "提交记录不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { submission = item }));
    }

    [HttpPost("submissions/{id}/refresh")]
    public async Task<IActionResult> RefreshSubmission(string id)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewPrismSubmissions
            .Find(x => x.Id == id && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "提交记录不存在"));
        }

        try
        {
            var snapshot = await _snapshotBuilder.BuildSnapshotAsync(item.RepoOwner, item.RepoName, item.PullRequestNumber);
            ApplySnapshot(item, snapshot);
            item.LastRefreshError = null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReviewPrism refresh failed: {Id}", id);
            item.LastRefreshError = ex.Message;
            item.GateStatus = PrReviewPrismGateStatuses.Error;
            item.UpdatedAt = DateTime.UtcNow;
        }

        await _db.PrReviewPrismSubmissions.ReplaceOneAsync(
            x => x.Id == item.Id,
            item,
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { submission = item }));
    }

    [HttpPost("submissions/batch-refresh")]
    public async Task<IActionResult> BatchRefreshSubmissions([FromBody] BatchRefreshPrReviewPrismSubmissionsRequest req)
    {
        if (req.Ids == null || req.Ids.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "ids 不能为空"));
        }

        if (req.Ids.Count > 100)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "ids 最多支持 100 条"));
        }

        var targetIds = req.Ids
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();

        if (targetIds.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "ids 不能为空"));
        }

        var userId = this.GetRequiredUserId();
        var items = await _db.PrReviewPrismSubmissions
            .Find(x => x.OwnerUserId == userId && targetIds.Contains(x.Id))
            .ToListAsync(CancellationToken.None);
        var itemById = items.ToDictionary(x => x.Id, StringComparer.Ordinal);

        var refreshedSubmissions = new List<PrReviewPrismSubmission>(items.Count);
        var failures = new List<PrReviewPrismBatchRefreshFailure>();
        var successCount = 0;

        foreach (var submissionId in targetIds)
        {
            if (!itemById.TryGetValue(submissionId, out var item))
            {
                failures.Add(new PrReviewPrismBatchRefreshFailure
                {
                    Id = submissionId,
                    Code = ErrorCodes.NOT_FOUND,
                    Message = "提交记录不存在",
                });
                continue;
            }

            var refreshSucceeded = true;
            try
            {
                var snapshot = await _snapshotBuilder.BuildSnapshotAsync(item.RepoOwner, item.RepoName, item.PullRequestNumber);
                ApplySnapshot(item, snapshot);
                item.LastRefreshError = null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "PrReviewPrism batch refresh failed: {Id}", submissionId);
                item.LastRefreshError = ex.Message;
                item.GateStatus = PrReviewPrismGateStatuses.Error;
                item.UpdatedAt = DateTime.UtcNow;
                refreshSucceeded = false;
                failures.Add(new PrReviewPrismBatchRefreshFailure
                {
                    Id = submissionId,
                    Code = ErrorCodes.LLM_ERROR,
                    Message = ex.Message,
                });
            }

            await _db.PrReviewPrismSubmissions.ReplaceOneAsync(
                x => x.Id == item.Id,
                item,
                cancellationToken: CancellationToken.None);

            refreshedSubmissions.Add(item);
            if (refreshSucceeded)
            {
                successCount += 1;
            }
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            total = targetIds.Count,
            successCount,
            failureCount = failures.Count,
            submissions = refreshedSubmissions,
            failures,
        }));
    }

    [HttpDelete("submissions/{id}")]
    public async Task<IActionResult> DeleteSubmission(string id)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.PrReviewPrismSubmissions.DeleteOneAsync(
            x => x.Id == id && x.OwnerUserId == userId,
            cancellationToken: CancellationToken.None);

        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "提交记录不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    private static void ApplySnapshot(PrReviewPrismSubmission target, PrReviewPrismSnapshot snapshot)
    {
        target.RepoOwner = snapshot.RepoOwner;
        target.RepoName = snapshot.RepoName;
        target.PullRequestNumber = snapshot.PullRequestNumber;
        target.PullRequestUrl = snapshot.PullRequestUrl;
        target.PullRequestTitle = snapshot.PullRequestTitle;
        target.PullRequestAuthor = snapshot.PullRequestAuthor;
        target.PullRequestState = snapshot.PullRequestState;
        target.HeadSha = snapshot.HeadSha;
        target.GateStatus = snapshot.GateStatus;
        target.GateConclusion = snapshot.GateConclusion;
        target.GateDetailsUrl = snapshot.GateDetailsUrl;
        target.DecisionSuggestion = snapshot.DecisionSuggestion;
        target.RiskScore = snapshot.RiskScore;
        target.ConfidencePercent = snapshot.ConfidencePercent;
        target.BlockersTriggered = snapshot.BlockersTriggered;
        target.Blockers = snapshot.Blockers;
        target.Advisories = snapshot.Advisories;
        target.FocusQuestions = snapshot.FocusQuestions;
        target.DecisionCardCommentUrl = snapshot.DecisionCardCommentUrl;
        target.DecisionCardUpdatedAt = snapshot.DecisionCardUpdatedAt;
        target.LastRefreshedAt = DateTime.UtcNow;
        target.UpdatedAt = DateTime.UtcNow;
    }

    private bool IsGitHubTokenConfigured()
    {
        var token = HttpContext.RequestServices
            .GetRequiredService<IConfiguration>()["GitHub:Token"]
            ?? HttpContext.RequestServices.GetRequiredService<IConfiguration>()["GitHub:ApiToken"]
            ?? HttpContext.RequestServices.GetRequiredService<IConfiguration>()["GitHub__Token"]
            ?? HttpContext.RequestServices.GetRequiredService<IConfiguration>()["PR_REVIEW_PRISM_GITHUB_TOKEN"];

        return !string.IsNullOrWhiteSpace(token);
    }

    private static PrReviewPrismTopDesignSetupStatus InspectTopDesignSetup(string? targetRepo)
    {
        var root = TryFindRepoRoot();
        if (root == null)
        {
            return new PrReviewPrismTopDesignSetupStatus
            {
                RepoRootDetected = false,
                TargetRepo = targetRepo,
            };
        }

        var designSourcesPath = Path.Combine(root, ".github", "pr-architect", "design-sources.yml");
        var repoBindingsPath = Path.Combine(root, ".github", "pr-architect", "repo-bindings.yml");
        var topDesignDocPath = Path.Combine(root, "doc", "top-design", "main.md");
        var anchorsPath = Path.Combine(root, "doc", "top-design", "anchors.yml");
        var contextsPath = Path.Combine(root, "doc", "top-design", "contexts.yml");
        var slicesPath = Path.Combine(root, "doc", "top-design", "slices.yml");

        var status = new PrReviewPrismTopDesignSetupStatus
        {
            RepoRootDetected = true,
            RepoRoot = root,
            TargetRepo = targetRepo,
            DesignSourcesExists = System.IO.File.Exists(designSourcesPath),
            RepoBindingsExists = System.IO.File.Exists(repoBindingsPath),
            TopDesignDocExists = System.IO.File.Exists(topDesignDocPath),
            AnchorsExists = System.IO.File.Exists(anchorsPath),
            ContextsExists = System.IO.File.Exists(contextsPath),
            SlicesExists = System.IO.File.Exists(slicesPath),
        };

        if (status.DesignSourcesExists)
        {
            var text = System.IO.File.ReadAllText(designSourcesPath);
            status.UsesBootstrapPlaceholder = text.Contains("bootstrap-ddd-anchor", StringComparison.OrdinalIgnoreCase)
                                              || text.Contains("top-design.bootstrap.md", StringComparison.OrdinalIgnoreCase)
                                              || text.Contains("bootstrap-replace", StringComparison.OrdinalIgnoreCase);

            status.ActiveSourceId = ReadYamlScalar(text, "active_source_id");
            status.ActiveVersion = ReadYamlScalar(text, "active_version");
        }

        if (status.RepoBindingsExists)
        {
            var text = System.IO.File.ReadAllText(repoBindingsPath);
            status.RepoBindingsHasRepositoryEntry = text.Contains("- repo:", StringComparison.OrdinalIgnoreCase);
            status.RepoBindingMatchedTargetRepo = string.IsNullOrWhiteSpace(targetRepo)
                ? status.RepoBindingsHasRepositoryEntry
                : text.Contains($"repo: \"{targetRepo}\"", StringComparison.OrdinalIgnoreCase)
                  || text.Contains($"repo: '{targetRepo}'", StringComparison.OrdinalIgnoreCase)
                  || text.Contains($"repo: {targetRepo}", StringComparison.OrdinalIgnoreCase);
        }

        var repoBindingReady = string.IsNullOrWhiteSpace(targetRepo)
            ? status.RepoBindingsHasRepositoryEntry
            : status.RepoBindingMatchedTargetRepo;

        status.Ready = status.DesignSourcesExists
                       && status.RepoBindingsExists
                       && repoBindingReady
                       && !status.UsesBootstrapPlaceholder
                       && status.TopDesignDocExists
                       && status.AnchorsExists
                       && status.ContextsExists
                       && status.SlicesExists;

        return status;
    }

    private static string? TryFindRepoRoot()
    {
        var probes = new[]
        {
            Directory.GetCurrentDirectory(),
            AppContext.BaseDirectory
        };

        foreach (var probe in probes)
        {
            var cursor = new DirectoryInfo(probe);
            while (cursor != null)
            {
                var marker = Path.Combine(cursor.FullName, ".github", "pr-architect", "design-sources.yml");
                if (System.IO.File.Exists(marker))
                {
                    return cursor.FullName;
                }

                cursor = cursor.Parent;
            }
        }

        return null;
    }

    private static string? ReadYamlScalar(string text, string key)
    {
        var lines = text.Split('\n');
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (!line.StartsWith($"{key}:", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var value = line[(key.Length + 1)..].Trim().Trim('"', '\'');
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }

        return null;
    }

    private static string? NormalizeRepoKey(string? repo)
    {
        if (string.IsNullOrWhiteSpace(repo))
        {
            return null;
        }

        var trimmed = repo.Trim();
        var fromPrUrl = Regex.Match(trimmed, @"^https?://github\.com/(?<owner>[^/\s]+)/(?<name>[^/\s]+)/pull/\d+", RegexOptions.IgnoreCase);
        if (fromPrUrl.Success)
        {
            return $"{fromPrUrl.Groups["owner"].Value.ToLowerInvariant()}/{fromPrUrl.Groups["name"].Value.ToLowerInvariant()}";
        }

        var fromRepo = Regex.Match(trimmed, @"^(?<owner>[^/\s]+)/(?<name>[^/\s]+)$", RegexOptions.IgnoreCase);
        if (fromRepo.Success)
        {
            return $"{fromRepo.Groups["owner"].Value.ToLowerInvariant()}/{fromRepo.Groups["name"].Value.ToLowerInvariant()}";
        }

        return null;
    }

    private static byte[] BuildBootstrapSkillPackageZip(IReadOnlyDictionary<string, string> files)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, content) in files)
            {
                var entry = zip.CreateEntry(path, CompressionLevel.NoCompression);
                using var stream = entry.Open();
                using var writer = new StreamWriter(stream);
                writer.Write(content);
            }
        }

        return memory.ToArray();
    }

    private static string NormalizeGitHubOwner(string? value, string fallback)
    {
        var candidate = (value ?? string.Empty).Trim();
        if (Regex.IsMatch(candidate, "^[A-Za-z0-9-]+$"))
        {
            return candidate;
        }

        return fallback;
    }

    private static string NormalizeContextId(string? value)
    {
        var candidate = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(candidate))
        {
            return "engineering-governance";
        }

        var normalized = Regex.Replace(candidate, "[^a-z0-9-]+", "-").Trim('-');
        return string.IsNullOrWhiteSpace(normalized) ? "engineering-governance" : normalized;
    }

    private static string NormalizeAnchorId(string? value, string fallback)
    {
        var candidate = (value ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(candidate))
        {
            return candidate;
        }

        return fallback;
    }

    private static string BuildRepoBootstrapSkillMarkdown(string repo, string owner, string context, string anchorId)
    {
        return $"""
---
name: pr-prism-bootstrap
description: 一键初始化新仓库的 PR 审查棱镜依据（最薄顶层设计 + 绑定配置）。
---

# PR Review Prism Bootstrap（仓库专属模板）

目标仓库：`{repo}`

## 零参数初始化（推荐）

```bash
bash scripts/bootstrap-pr-prism.sh
```

## 显式参数初始化（可复制直接用）

```bash
bash scripts/bootstrap-pr-prism.sh --repo "{repo}" --owner "{owner}" --context "{context}"
```

## 验收要点

1. `doc/top-design/*` 文件已生成；
2. `.github/pr-architect/design-sources.yml` active source 不再是占位；
3. `.github/pr-architect/repo-bindings.yml` 存在 `repo: "{repo}"`；
4. `anchor id` 建议使用：`{anchorId}`。
""";
    }

    private static string BuildRepoBootstrapGuideMarkdown(string repo, string owner, string context, string anchorId)
    {
        return $"""
# PR审查棱镜接入包（仓库专属）

目标仓库：`{repo}`

## 1. 把 zip 内容解压到仓库根目录

应包含：

- `scripts/bootstrap-pr-prism.sh`
- `scripts/init-pr-prism-basis.sh`
- `.claude/skills/pr-prism-bootstrap/SKILL.md`

## 2. 执行初始化

推荐：

```bash
bash scripts/bootstrap-pr-prism.sh
```

失败兜底：

```bash
bash scripts/bootstrap-pr-prism.sh --repo "{repo}" --owner "{owner}" --context "{context}"
```

## 3. 最小验收

- `doc/top-design/main.md` 已生成；
- `doc/top-design/anchors.yml` 包含 `{anchorId}`；
- `.github/pr-architect/repo-bindings.yml` 存在 `repo: "{repo}"`。
""";
    }
}

public sealed class PrReviewPrismTopDesignSetupStatus
{
    public bool RepoRootDetected { get; set; }
    public string? RepoRoot { get; set; }
    public string? TargetRepo { get; set; }
    public bool DesignSourcesExists { get; set; }
    public string? ActiveSourceId { get; set; }
    public string? ActiveVersion { get; set; }
    public bool UsesBootstrapPlaceholder { get; set; }
    public bool RepoBindingsExists { get; set; }
    public bool RepoBindingsHasRepositoryEntry { get; set; }
    public bool RepoBindingMatchedTargetRepo { get; set; }
    public bool TopDesignDocExists { get; set; }
    public bool AnchorsExists { get; set; }
    public bool ContextsExists { get; set; }
    public bool SlicesExists { get; set; }
    public bool Ready { get; set; }
}

public sealed class CreatePrReviewPrismSubmissionRequest
{
    public string PullRequestUrl { get; set; } = string.Empty;
    public string? Note { get; set; }
}

public sealed class BatchRefreshPrReviewPrismSubmissionsRequest
{
    public List<string> Ids { get; set; } = new();
}

public sealed class PrReviewPrismBatchRefreshFailure
{
    public string Id { get; set; } = string.Empty;
    public string Code { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
}

public sealed class PrReviewPrismRepoSkillPackageRequest
{
    public string Repo { get; set; } = string.Empty;
    public string? Owner { get; set; }
    public string? Context { get; set; }
    public string? AnchorId { get; set; }
}
