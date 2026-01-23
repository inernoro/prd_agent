using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 修复 Worker：生成 Patch → 创建 PR
/// Clone 仓库 → Agent 生成 Patch → 创建 Branch → Push → GitHub API 创建 PR
/// </summary>
public sealed class DefectFixWorker : BackgroundService
{
    private const string RunKind = "defect-fix";

    private readonly MongoDbContext _db;
    private readonly IRunQueue _runQueue;
    private readonly IRunEventStore _runStore;
    private readonly ICodeProviderFactory _codeProviderFactory;
    private readonly ILogger<DefectFixWorker> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public DefectFixWorker(
        MongoDbContext db,
        IRunQueue runQueue,
        IRunEventStore runStore,
        ICodeProviderFactory codeProviderFactory,
        ILogger<DefectFixWorker> logger)
    {
        _db = db;
        _runQueue = runQueue;
        _runStore = runStore;
        _codeProviderFactory = codeProviderFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[defect-agent:FixWorker] DefectFixWorker started");

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
                _logger.LogWarning(ex, "[defect-agent:FixWorker] Dequeue failed");
            }

            if (runId == null)
            {
                try { await Task.Delay(600, stoppingToken); }
                catch (OperationCanceledException) { break; }
                continue;
            }

            try
            {
                _logger.LogInformation("[defect-agent:FixWorker] Run {RunId} started", runId);
                await ProcessRunAsync(runId, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                await MarkRunFailedSafeAsync(runId, "WORKER_STOPPED", "服务停止");
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[defect-agent:FixWorker] Run {RunId} failed", runId);
                await MarkRunFailedSafeAsync(runId, "INTERNAL_ERROR", ex.Message);
            }
        }
    }

    private async Task ProcessRunAsync(string runId, CancellationToken ct)
    {
        var meta = await _runStore.GetRunAsync(RunKind, runId, ct);
        if (meta == null) return;

        meta.Status = RunStatuses.Running;
        meta.StartedAt = DateTime.UtcNow;
        await _runStore.SetRunAsync(RunKind, meta, ct: ct);

        var input = JsonSerializer.Deserialize<JsonElement>(meta.InputJson ?? "{}");
        var defectId = input.GetProperty("defectId").GetString()!;

        var defect = await _db.DefectReports.Find(x => x.Id == defectId).FirstOrDefaultAsync(ct);
        if (defect == null)
        {
            await MarkRunFailedSafeAsync(runId, "NOT_FOUND", "缺陷不存在");
            return;
        }

        await _runStore.AppendEventAsync(RunKind, runId, "progress",
            new { message = "开始修复流程..." }, ct: ct);

        // Load analysis result
        var review = await _db.DefectReviews
            .Find(x => x.DefectId == defectId && x.Phase == ReviewPhase.Analysis)
            .SortByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);

        if (review?.LocatedFiles == null || review.LocatedFiles.Count == 0)
        {
            await MarkRunFailedSafeAsync(runId, "NO_LOCATION", "无代码定位结果，无法自动修复");
            await _db.DefectReports.UpdateOneAsync(
                x => x.Id == defectId,
                Builders<DefectReport>.Update
                    .Set(x => x.Status, DefectStatus.Analyzed)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
            return;
        }

        // Get repo config
        if (string.IsNullOrEmpty(defect.RepoConfigId))
        {
            await MarkRunFailedSafeAsync(runId, "NO_REPO", "未配置关联仓库");
            return;
        }

        var repoConfig = await _db.DefectRepoConfigs.Find(x => x.Id == defect.RepoConfigId).FirstOrDefaultAsync(ct);
        if (repoConfig == null)
        {
            await MarkRunFailedSafeAsync(runId, "REPO_NOT_FOUND", "仓库配置不存在");
            return;
        }

        var token = await GetGithubTokenAsync(defect.OwnerUserId, ct);
        if (string.IsNullOrEmpty(token))
        {
            await MarkRunFailedSafeAsync(runId, "NO_TOKEN", "无 GitHub 授权 Token");
            return;
        }

        await _runStore.AppendEventAsync(RunKind, runId, "progress",
            new { message = "读取相关代码文件..." }, ct: ct);

        // Read located files
        var codeProvider = _codeProviderFactory.Create(repoConfig, token);
        var fileContents = new Dictionary<string, string>();

        foreach (var loc in review.LocatedFiles.Take(5)) // Limit to 5 files for safety
        {
            try
            {
                var content = await codeProvider.ReadFileAsync(loc.FilePath, ct: ct);
                fileContents[loc.FilePath] = content.Content;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[defect-agent:FixWorker] Failed to read {File}", loc.FilePath);
            }
        }

        await _runStore.AppendEventAsync(RunKind, runId, "progress",
            new { message = $"已读取 {fileContents.Count} 个文件，准备生成修复..." }, ct: ct);

        // Create fix record
        var branchName = $"{repoConfig.PrBranchPrefix}{defectId[..8]}-fix";
        var fix = new DefectFix
        {
            DefectId = defectId,
            ReviewId = review.Id,
            BranchName = branchName,
            Status = FixStatus.InProgress,
            Changes = review.LocatedFiles.Select(f => new FileChange
            {
                FilePath = f.FilePath,
                ChangeType = "modify",
                LinesAdded = 0,
                LinesRemoved = 0
            }).ToList(),
            CreatedAt = DateTime.UtcNow
        };
        await _db.DefectFixes.InsertOneAsync(fix, cancellationToken: ct);

        await _runStore.AppendEventAsync(RunKind, runId, "progress",
            new { message = "修复记录已创建，等待 LLM 生成修复代码..." }, ct: ct);

        // In a full implementation, this would:
        // 1. Call LLM to generate fix patch
        // 2. Clone repo, create branch, apply patch
        // 3. Push and create PR via GitHub API
        // For now, mark as pending manual fix

        fix.Status = FixStatus.Pending;
        await _db.DefectFixes.ReplaceOneAsync(x => x.Id == fix.Id, fix, cancellationToken: ct);

        await _runStore.AppendEventAsync(RunKind, runId, "fix_ready",
            new
            {
                fixId = fix.Id,
                branchName,
                files = review.LocatedFiles.Select(f => f.FilePath).ToList(),
                message = "修复方案已生成，待 LLM Patch 集成后自动创建 PR"
            }, ct: ct);

        // Complete run
        meta.Status = RunStatuses.Done;
        meta.EndedAt = DateTime.UtcNow;
        await _runStore.SetRunAsync(RunKind, meta, ct: ct);

        _logger.LogInformation("[defect-agent:FixWorker] Run {RunId} completed, fix {FixId}", runId, fix.Id);
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
            await _runStore.AppendEventAsync(RunKind, runId, "error",
                new { code, message });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[defect-agent:FixWorker] MarkRunFailed failed for {RunId}", runId);
        }
    }
}
