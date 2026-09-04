using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 统一设计产物后台执行器。首版执行网页生成与网页微调；HTTP 只创建任务，
/// 生成、产物落库与终态写入均在服务器端闭环。
/// </summary>
public sealed class HostedSiteEditRunWorker : BackgroundService
{
    private static readonly TimeSpan RunTtl = TimeSpan.FromHours(24);
    private const int MaxModelInputChars = 240_000;

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunQueue _queue;
    private readonly IRunEventStore _events;
    private readonly ILogger<HostedSiteEditRunWorker> _logger;

    public HostedSiteEditRunWorker(
        IServiceScopeFactory scopeFactory,
        IRunQueue queue,
        IRunEventStore events,
        ILogger<HostedSiteEditRunWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _queue = queue;
        _events = events;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            string? runId = null;
            try
            {
                runId = await _queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.FromSeconds(1), stoppingToken);
                if (string.IsNullOrWhiteSpace(runId))
                {
                    await Task.Delay(250, stoppingToken);
                    continue;
                }
                await ProcessAsync(runId, CancellationToken.None);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "设计产物 Run 执行失败 runId={RunId}", runId);
                if (!string.IsNullOrWhiteSpace(runId))
                    await MarkErrorAsync(runId, "设计任务执行失败，请稍后重试");
            }
        }
    }

    private async Task ProcessAsync(string runId, CancellationToken ct)
    {
        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct);
        if (meta == null || meta.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled)
            return;

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var run = await db.DesignArtifactRuns.Find(x => x.Id == runId).FirstOrDefaultAsync(ct);
        if (run == null || string.IsNullOrWhiteSpace(run.UserId) || string.IsNullOrWhiteSpace(run.Instruction))
        {
            await MarkErrorAsync(runId, "设计任务参数不完整");
            return;
        }

        meta.Status = RunStatuses.Running;
        meta.StartedAt = DateTime.UtcNow;
        await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
        await UpdatePhaseAsync(db, run, 8,
            run.Operation == DesignArtifactOperations.Edit ? "正在读取当前页面" : "正在整理知识与页面目标");

        var sites = scope.ServiceProvider.GetRequiredService<IHostedSiteService>();
        var revisions = scope.ServiceProvider.GetRequiredService<IHostedSiteRevisionService>();
        var executor = scope.ServiceProvider
            .GetServices<IDesignArtifactExecutor>()
            .FirstOrDefault(x => x.Runtime == run.Runtime && x.Supports(run.ArtifactType, run.Operation));

        try
        {
            if (executor == null)
                throw new InvalidOperationException("所选设计执行器尚未部署或不支持当前任务，请先使用 MAP 模型");

            HostedSiteEditableEntry? editable = null;
            HostedSiteRevision? parent = null;
            if (run.Operation == DesignArtifactOperations.Edit)
            {
                if (string.IsNullOrWhiteSpace(run.TargetSiteId))
                    throw new InvalidOperationException("页面修改任务缺少目标站点");
                editable = await sites.GetEditableEntryHtmlAsync(run.TargetSiteId, run.UserId, CancellationToken.None);
                parent = await revisions.EnsureCurrentSnapshotAsync(
                    run.TargetSiteId,
                    run.UserId,
                    editable,
                    CancellationToken.None);
            }

            var knowledgeChars = run.KnowledgeReferences.Sum(x => x.Content.Length);
            if ((editable?.Html.Length ?? 0) + knowledgeChars > MaxModelInputChars)
                throw new InvalidOperationException("页面与知识正文过长，首版最多支持约 24 万字符，请减少引用或精简内容");

            await UpdatePhaseAsync(db, run, 18,
                run.Operation == DesignArtifactOperations.Edit ? "正在理解页面结构与修改要求" : "正在规划页面结构与视觉层级");

            var output = new StringBuilder();
            var sawFirstText = false;
            await foreach (var chunk in executor.ExecuteAsync(run, editable?.Html, CancellationToken.None))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    output.Append(chunk.Content);
                    if (!sawFirstText)
                    {
                        sawFirstText = true;
                        await UpdatePhaseAsync(db, run, 36, "页面已经开始生成");
                    }
                    await _events.AppendEventAsync(
                        RunKinds.DesignArtifact,
                        runId,
                        "delta",
                        new { text = chunk.Content },
                        RunTtl,
                        CancellationToken.None);
                    continue;
                }

                if (chunk.Type == "thinking" && !string.IsNullOrEmpty(chunk.Content))
                {
                    await _events.AppendEventAsync(
                        RunKinds.DesignArtifact,
                        runId,
                        "thinking",
                        new { text = chunk.Content },
                        RunTtl,
                        CancellationToken.None);
                    continue;
                }
            }

            var html = HostedSiteRevisionRules.NormalizeGeneratedHtml(output.ToString());
            HostedSiteRevisionRules.ValidateHtml(html);
            await UpdatePhaseAsync(db, run, 88,
                run.Operation == DesignArtifactOperations.Edit ? "正在校验并保存草稿" : "正在校验并保存托管网页");

            object donePayload;
            if (run.Operation == DesignArtifactOperations.Edit)
            {
                var draft = await revisions.CreateDraftAsync(
                    run.TargetSiteId!,
                    run.UserId,
                    html,
                    run.Instruction,
                    run.Runtime,
                    runId,
                    parent!.Id,
                    run.KnowledgeReferences.Select(x => x.EntryId).ToList(),
                    editable!.ContentVersion,
                    CancellationToken.None);
                run.ArtifactSiteId = run.TargetSiteId;
                run.ArtifactRevisionId = draft.Id;
                donePayload = new { revisionId = draft.Id, siteId = run.TargetSiteId, status = draft.Status };
            }
            else
            {
                var site = await sites.CreateFromContentAsync(
                    run.UserId,
                    html,
                    run.Title,
                    "由知识驱动设计生成",
                    "design-agent",
                    runId,
                    new List<string> { "知识生成" },
                    null,
                    CancellationToken.None);
                var current = await sites.GetEditableEntryHtmlAsync(site.Id, run.UserId, CancellationToken.None);
                var baseline = await revisions.EnsureCurrentSnapshotAsync(site.Id, run.UserId, current, CancellationToken.None);
                run.ArtifactSiteId = site.Id;
                run.ArtifactRevisionId = baseline.Id;
                donePayload = new { siteId = site.Id, siteUrl = site.SiteUrl, title = site.Title, revisionId = baseline.Id };
            }

            run.Status = RunStatuses.Done;
            run.Progress = 100;
            run.Phase = run.Operation == DesignArtifactOperations.Edit ? "草稿已生成" : "网页已生成并保存";
            run.CompletedAt = DateTime.UtcNow;
            run.UpdatedAt = DateTime.UtcNow;
            await db.DesignArtifactRuns.ReplaceOneAsync(x => x.Id == run.Id, run, cancellationToken: CancellationToken.None);

            meta.Status = RunStatuses.Done;
            meta.EndedAt = DateTime.UtcNow;
            await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
            await _events.AppendEventAsync(
                RunKinds.DesignArtifact,
                runId,
                "done",
                donePayload,
                RunTtl,
                CancellationToken.None);
        }
        catch (KeyNotFoundException)
        {
            await MarkErrorAsync(runId, "站点不存在或你没有修改权限");
        }
        catch (InvalidOperationException ex)
        {
            await MarkErrorAsync(runId, ex.Message);
        }
    }

    private async Task UpdatePhaseAsync(MongoDbContext db, DesignArtifactRun run, int progress, string message)
    {
        run.Progress = progress;
        run.Phase = message;
        run.Status = RunStatuses.Running;
        run.UpdatedAt = DateTime.UtcNow;
        await db.DesignArtifactRuns.ReplaceOneAsync(x => x.Id == run.Id, run, cancellationToken: CancellationToken.None);
        await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            run.Id,
            "phase",
            new { progress, message },
            RunTtl,
            CancellationToken.None);
    }

    private async Task MarkErrorAsync(string runId, string message)
    {
        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, CancellationToken.None);
        if (meta != null)
        {
            meta.Status = RunStatuses.Error;
            meta.EndedAt = DateTime.UtcNow;
            meta.ErrorCode = "DESIGN_ARTIFACT_FAILED";
            meta.ErrorMessage = message;
            await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
        }

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var update = Builders<DesignArtifactRun>.Update
            .Set(x => x.Status, RunStatuses.Error)
            .Set(x => x.Error, message)
            .Set(x => x.Phase, message)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .Set(x => x.CompletedAt, DateTime.UtcNow);
        await db.DesignArtifactRuns.UpdateOneAsync(x => x.Id == runId, update, cancellationToken: CancellationToken.None);
        await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            runId,
            "error",
            new { code = "DESIGN_ARTIFACT_FAILED", message },
            RunTtl,
            CancellationToken.None);
    }

}
