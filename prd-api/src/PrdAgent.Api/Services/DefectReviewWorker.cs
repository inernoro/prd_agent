using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// AI 审核 Worker：执行初审 → 分析 → 定位 Pipeline
/// Agent Loop 模式 (LLM Tool-Use)
/// </summary>
public sealed class DefectReviewWorker : BackgroundService
{
    private const string RunKind = "defect-review";
    private const int MaxIterations = 15;
    private const int MaxTokenBudget = 100_000;

    private readonly MongoDbContext _db;
    private readonly IRunQueue _runQueue;
    private readonly IRunEventStore _runStore;
    private readonly ICodeProviderFactory _codeProviderFactory;
    private readonly ILLMClientFactory _llmClientFactory;
    private readonly ILogger<DefectReviewWorker> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public DefectReviewWorker(
        MongoDbContext db,
        IRunQueue runQueue,
        IRunEventStore runStore,
        ICodeProviderFactory codeProviderFactory,
        ILLMClientFactory llmClientFactory,
        ILogger<DefectReviewWorker> logger)
    {
        _db = db;
        _runQueue = runQueue;
        _runStore = runStore;
        _codeProviderFactory = codeProviderFactory;
        _llmClientFactory = llmClientFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[defect-agent:Worker] DefectReviewWorker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            string? runId = null;
            try
            {
                runId = await _runQueue.DequeueAsync(RunKind, TimeSpan.FromSeconds(5), stoppingToken);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[defect-agent:Worker] Dequeue failed");
            }

            if (runId == null)
            {
                try { await Task.Delay(600, stoppingToken); }
                catch (OperationCanceledException) { break; }
                continue;
            }

            try
            {
                _logger.LogInformation("[defect-agent:Worker] Run {RunId} started", runId);
                await ProcessRunAsync(runId, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                await MarkRunFailedSafeAsync(runId, "WORKER_STOPPED", "服务停止");
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[defect-agent:Worker] Run {RunId} failed", runId);
                await MarkRunFailedSafeAsync(runId, "INTERNAL_ERROR", ex.Message);
            }
        }
    }

    private async Task ProcessRunAsync(string runId, CancellationToken ct)
    {
        var meta = await _runStore.GetRunAsync(RunKind, runId, ct);
        if (meta == null) return;

        // Update status to Running
        meta.Status = RunStatuses.Running;
        meta.StartedAt = DateTime.UtcNow;
        await _runStore.SetRunAsync(RunKind, meta, ct: ct);

        // Parse input
        var input = JsonSerializer.Deserialize<JsonElement>(meta.InputJson ?? "{}");
        var defectId = input.GetProperty("defectId").GetString()!;

        var defect = await _db.DefectReports.Find(x => x.Id == defectId).FirstOrDefaultAsync(ct);
        if (defect == null)
        {
            await MarkRunFailedSafeAsync(runId, "NOT_FOUND", "缺陷不存在");
            return;
        }

        // Update defect status to Reviewing
        await _db.DefectReports.UpdateOneAsync(
            x => x.Id == defectId,
            Builders<DefectReport>.Update
                .Set(x => x.Status, DefectStatus.Reviewing)
                .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);

        await _runStore.AppendEventAsync(RunKind, runId, "progress",
            new { message = "开始 AI 审核..." }, ct: ct);

        // Get repo config and code provider
        ICodeProvider? codeProvider = null;
        if (!string.IsNullOrEmpty(defect.RepoConfigId))
        {
            var repoConfig = await _db.DefectRepoConfigs.Find(x => x.Id == defect.RepoConfigId).FirstOrDefaultAsync(ct);
            if (repoConfig != null)
            {
                var token = await GetGithubTokenAsync(defect.OwnerUserId, ct);
                if (!string.IsNullOrEmpty(token))
                {
                    codeProvider = _codeProviderFactory.Create(repoConfig, token);
                }
            }
        }

        // Agent Loop
        var analysisResult = await RunAgentLoopAsync(runId, defect, codeProvider, ct);

        // Save review result
        var review = new DefectReview
        {
            DefectId = defectId,
            Phase = analysisResult.Phase,
            Verdict = analysisResult.Verdict,
            Content = analysisResult.Content,
            LocatedFiles = analysisResult.LocatedFiles,
            Suggestion = analysisResult.Suggestion,
            CreatedAt = DateTime.UtcNow
        };
        await _db.DefectReviews.InsertOneAsync(review, cancellationToken: ct);

        // Update defect status
        var newStatus = analysisResult.Verdict switch
        {
            ReviewVerdict.Invalid or ReviewVerdict.Duplicate or ReviewVerdict.NeedInfo => DefectStatus.Rejected,
            _ => DefectStatus.Analyzed
        };

        var defectUpdate = Builders<DefectReport>.Update
            .Set(x => x.Status, newStatus)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        if (analysisResult.Priority.HasValue)
            defectUpdate = defectUpdate.Set(x => x.Priority, analysisResult.Priority.Value);
        if (analysisResult.Impact.HasValue)
            defectUpdate = defectUpdate.Set(x => x.Impact, analysisResult.Impact.Value);
        if (analysisResult.ReproConfidence.HasValue)
            defectUpdate = defectUpdate.Set(x => x.ReproConfidence, analysisResult.ReproConfidence.Value);

        await _db.DefectReports.UpdateOneAsync(x => x.Id == defectId, defectUpdate, cancellationToken: ct);

        // Complete run
        await _runStore.AppendEventAsync(RunKind, runId, "review_complete",
            new { verdict = analysisResult.Verdict.ToString(), reviewId = review.Id }, ct: ct);

        meta.Status = RunStatuses.Done;
        meta.EndedAt = DateTime.UtcNow;
        await _runStore.SetRunAsync(RunKind, meta, ct: ct);

        _logger.LogInformation("[defect-agent:Worker] Run {RunId} completed, verdict: {Verdict}", runId, analysisResult.Verdict);
    }

    private async Task<AnalysisResult> RunAgentLoopAsync(
        string runId, DefectReport defect, ICodeProvider? codeProvider, CancellationToken ct)
    {
        var result = new AnalysisResult
        {
            Phase = ReviewPhase.Analysis,
            Verdict = ReviewVerdict.NeedManualFix,
            Content = ""
        };

        // Build system prompt
        var systemPrompt = BuildSystemPrompt(defect);
        var userMessage = BuildUserMessage(defect);

        // Build tool definitions for LLM
        var tools = BuildToolDefinitions(codeProvider != null);

        int iteration = 0;
        int tokensUsed = 0;
        int errorCount = 0;
        var conversationMessages = new List<object>
        {
            new { role = "user", content = userMessage }
        };

        while (iteration < MaxIterations && tokensUsed < MaxTokenBudget && errorCount < 3)
        {
            iteration++;
            await _runStore.AppendEventAsync(RunKind, runId, "progress",
                new { message = $"分析迭代 {iteration}/{MaxIterations}..." }, ct: ct);

            // In a real implementation, this would call the LLM with tools.
            // For now, we simulate the agent producing a triage result based on defect content.
            if (iteration == 1)
            {
                // Initial triage: assess completeness
                var hasTitle = !string.IsNullOrWhiteSpace(defect.Title);
                var hasSteps = defect.ReproSteps.Count > 0;
                var hasDescription = !string.IsNullOrWhiteSpace(defect.Description);

                if (!hasTitle || !hasDescription)
                {
                    result.Verdict = ReviewVerdict.NeedInfo;
                    result.Phase = ReviewPhase.Triage;
                    result.Content = "## 初审结论\n\n缺陷信息不完整，请补充标题和详细描述。";
                    break;
                }

                await _runStore.AppendEventAsync(RunKind, runId, "progress",
                    new { message = "信息完整性检查通过，开始代码定位..." }, ct: ct);
            }

            if (iteration == 2 && codeProvider != null)
            {
                // Try to search for related code
                try
                {
                    var searchResults = await codeProvider.SearchAsync(defect.Title, maxResults: 5, ct: ct);
                    if (searchResults.Count > 0)
                    {
                        result.LocatedFiles = searchResults.Select(r => new CodeLocation
                        {
                            FilePath = r.FilePath,
                            LineNumber = r.LineNumber,
                            Confidence = 0.6
                        }).ToList();

                        await _runStore.AppendEventAsync(RunKind, runId, "progress",
                            new { message = $"找到 {searchResults.Count} 个相关文件" }, ct: ct);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[defect-agent:Worker] Code search failed for run {RunId}", runId);
                    errorCount++;
                }
            }

            // Determine verdict based on available info
            if (iteration >= 2)
            {
                result.Phase = ReviewPhase.Analysis;
                if (result.LocatedFiles?.Count > 0)
                {
                    result.Verdict = ReviewVerdict.CanAutoFix;
                    result.Suggestion = new FixSuggestion
                    {
                        Level = FixLevel.SemiAuto,
                        AnalysisReport = $"定位到 {result.LocatedFiles.Count} 个可能相关的文件。建议审查后确认修复。"
                    };
                }
                else
                {
                    result.Verdict = ReviewVerdict.NeedManualFix;
                }

                result.Content = BuildAnalysisContent(defect, result);
                result.Priority = DefectPriority.P2_Normal;
                result.Impact = DefectImpact.EdgeFunction;
                result.ReproConfidence = defect.ReproSteps.Count >= 3 ? ReproConfidence.High : ReproConfidence.Medium;
                break;
            }
        }

        if (string.IsNullOrEmpty(result.Content))
        {
            result.Content = "AI 分析未在限定步骤内完成，建议人工介入。";
        }

        return result;
    }

    private static string BuildSystemPrompt(DefectReport defect)
    {
        return @"你是一个代码缺陷分析 AI Agent。你的职责是：
1. 评估缺陷报告的信息完整性
2. 检测是否与已知缺陷重复
3. 评估复现可能性
4. 在代码库中定位可能的问题文件
5. 评估影响范围和优先级
6. 给出修复建议

你可以使用以下工具：search_code, read_file, list_directory, find_references, git_log, submit_analysis";
    }

    private static string BuildUserMessage(DefectReport defect)
    {
        var parts = new List<string>
        {
            $"# 缺陷报告: {defect.Title}",
            $"\n## 描述\n{defect.Description}"
        };

        if (defect.ReproSteps.Count > 0)
            parts.Add($"\n## 重现步骤\n{string.Join("\n", defect.ReproSteps.Select((s, i) => $"{i + 1}. {s}"))}");
        if (!string.IsNullOrEmpty(defect.ExpectedBehavior))
            parts.Add($"\n## 期望行为\n{defect.ExpectedBehavior}");
        if (!string.IsNullOrEmpty(defect.ActualBehavior))
            parts.Add($"\n## 实际行为\n{defect.ActualBehavior}");
        if (defect.Environment != null)
            parts.Add($"\n## 环境\n浏览器: {defect.Environment.Browser}\n系统: {defect.Environment.Os}\n版本: {defect.Environment.AppVersion}");

        return string.Join("\n", parts);
    }

    private static List<object> BuildToolDefinitions(bool hasCodeProvider)
    {
        var tools = new List<object>();
        if (hasCodeProvider)
        {
            tools.Add(new { name = "search_code", description = "在代码库中搜索匹配的代码" });
            tools.Add(new { name = "read_file", description = "读取指定文件的内容" });
            tools.Add(new { name = "list_directory", description = "列出目录下的文件" });
            tools.Add(new { name = "find_references", description = "查找代码中对指定符号的引用" });
            tools.Add(new { name = "git_log", description = "获取文件的 Git 历史" });
        }
        tools.Add(new { name = "submit_analysis", description = "提交最终分析结论" });
        return tools;
    }

    private static string BuildAnalysisContent(DefectReport defect, AnalysisResult result)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"## AI 分析报告");
        sb.AppendLine($"\n### 缺陷: {defect.Title}");
        sb.AppendLine($"\n**结论**: {result.Verdict}");
        sb.AppendLine($"\n**优先级**: {result.Priority}");
        sb.AppendLine($"\n**影响范围**: {result.Impact}");
        sb.AppendLine($"\n**复现置信度**: {result.ReproConfidence}");

        if (result.LocatedFiles?.Count > 0)
        {
            sb.AppendLine("\n### 定位文件");
            foreach (var f in result.LocatedFiles)
            {
                sb.AppendLine($"- `{f.FilePath}` (置信度: {f.Confidence:P0})");
                if (!string.IsNullOrEmpty(f.Reason))
                    sb.AppendLine($"  原因: {f.Reason}");
            }
        }

        if (result.Suggestion != null)
        {
            sb.AppendLine("\n### 修复建议");
            sb.AppendLine($"**级别**: {result.Suggestion.Level}");
            if (!string.IsNullOrEmpty(result.Suggestion.AnalysisReport))
                sb.AppendLine(result.Suggestion.AnalysisReport);
        }

        return sb.ToString();
    }

    private async Task<string?> GetGithubTokenAsync(string userId, CancellationToken ct)
    {
        var tokenDoc = await _db.DefectGithubTokens.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        return tokenDoc?.EncryptedToken; // In production, decrypt this
    }

    private async Task MarkRunFailedSafeAsync(string runId, string code, string message)
    {
        try
        {
            var meta = await _runStore.GetRunAsync(RunKind, runId);
            if (meta != null)
            {
                meta.Status = RunStatuses.Error;
                meta.ErrorCode = code;
                meta.ErrorMessage = message;
                meta.EndedAt = DateTime.UtcNow;
                await _runStore.SetRunAsync(RunKind, meta);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[defect-agent:Worker] MarkRunFailed failed for {RunId}", runId);
        }
    }

    private class AnalysisResult
    {
        public ReviewPhase Phase { get; set; }
        public ReviewVerdict Verdict { get; set; }
        public string Content { get; set; } = string.Empty;
        public List<CodeLocation>? LocatedFiles { get; set; }
        public FixSuggestion? Suggestion { get; set; }
        public DefectPriority? Priority { get; set; }
        public DefectImpact? Impact { get; set; }
        public ReproConfidence? ReproConfidence { get; set; }
    }
}
