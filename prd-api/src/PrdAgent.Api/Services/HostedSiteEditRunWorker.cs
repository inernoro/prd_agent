using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 统一设计产物后台执行器。首版执行网页生成与网页微调；HTTP 只创建任务，
/// 生成、产物落库与终态写入均在服务器端闭环。
/// </summary>
public sealed class HostedSiteEditRunWorker : BackgroundService
{
    private static readonly TimeSpan RunTtl = TimeSpan.FromHours(24);
    internal static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(2);
    internal static readonly TimeSpan RecoveryInterval = TimeSpan.FromSeconds(15);
    internal static readonly TimeSpan QueueRecoveryDelay = TimeSpan.FromSeconds(10);
    private const int MaxModelInputChars = 240_000;

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunQueue _queue;
    private readonly IRunEventStore _events;
    private readonly ILogger<HostedSiteEditRunWorker> _logger;
    private readonly string _instanceId = $"{Environment.MachineName}:{Guid.NewGuid():N}";

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
        var nextRecoveryAt = DateTime.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            string? runId = null;
            try
            {
                if (DateTime.UtcNow >= nextRecoveryAt)
                {
                    await ReconcileAsync(stoppingToken);
                    nextRecoveryAt = DateTime.UtcNow + RecoveryInterval;
                }
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
            }
        }
    }

    private async Task ProcessAsync(string runId, CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var leaseOwner = $"{_instanceId}:{Guid.NewGuid():N}";
        var run = await TryClaimAsync(db, runId, leaseOwner, DateTime.UtcNow, LeaseDuration, ct);
        if (run == null) return;

        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct) ?? new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.DesignArtifact,
            CreatedByUserId = run.UserId,
            CreatedAt = run.CreatedAt,
        };
        if (run == null || string.IsNullOrWhiteSpace(run.UserId) || string.IsNullOrWhiteSpace(run.Instruction))
        {
            await MarkErrorAsync(runId, "设计任务参数不完整", leaseOwner);
            return;
        }

        meta.Status = RunStatuses.Running;
        meta.StartedAt ??= DateTime.UtcNow;
        await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
        await UpdatePhaseAsync(db, run, leaseOwner, 8,
            run.Operation == DesignArtifactOperations.Edit ? "正在读取当前页面" : "正在整理知识与页面目标");

        var sites = scope.ServiceProvider.GetRequiredService<IHostedSiteService>();
        var revisions = scope.ServiceProvider.GetRequiredService<IHostedSiteRevisionService>();
        var executor = scope.ServiceProvider
            .GetServices<IDesignArtifactExecutor>()
            .FirstOrDefault(x => x.Runtime == run.Runtime && x.Supports(run.ArtifactType, run.Operation));

        using var executionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var initialLeaseDeadline = run.LeaseExpiresAt ?? DateTime.UtcNow;
        var heartbeatTask = MaintainHeartbeatAsync(db, run.Id, leaseOwner, initialLeaseDeadline, executionCts);
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
                if (!await RenewLeaseAsync(
                        db,
                        run.Id,
                        leaseOwner,
                        DateTime.UtcNow,
                        LeaseDuration,
                        CancellationToken.None))
                    throw new DesignArtifactRunLeaseLostException(run.Id);
                parent = await revisions.EnsureCurrentSnapshotAsync(
                    run.TargetSiteId,
                    run.UserId,
                    editable,
                    executionCts.Token);
            }

            var knowledgeChars = run.KnowledgeReferences.Sum(x => x.Content.Length);
            if ((editable?.Html.Length ?? 0) + knowledgeChars > MaxModelInputChars)
                throw new InvalidOperationException("页面与知识正文过长，首版最多支持约 24 万字符，请减少引用或精简内容");

            await UpdatePhaseAsync(db, run, leaseOwner, 18,
                run.Operation == DesignArtifactOperations.Edit ? "正在理解页面结构与修改要求" : "正在规划页面结构与视觉层级");

            var output = new StringBuilder();
            var sawFirstText = false;
            await foreach (var chunk in executor.ExecuteAsync(run, editable?.Html, executionCts.Token))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    output.Append(chunk.Content);
                    if (!sawFirstText)
                    {
                        sawFirstText = true;
                        await UpdatePhaseAsync(db, run, leaseOwner, 36, "页面已经开始生成");
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

            var html = HostedSiteRevisionRules.HardenGeneratedHtml(output.ToString());
            var qualityEvidence = BuildQualityEvidence(run, editable);
            HostedSiteRevisionRules.ValidateGeneratedContentQuality(html, qualityEvidence);
            await UpdatePhaseAsync(db, run, leaseOwner, 88,
                run.Operation == DesignArtifactOperations.Edit ? "正在校验并保存草稿" : "正在校验并保存托管网页");

            var persisted = await PersistArtifactWithLeaseAsync(
                db,
                run,
                leaseOwner,
                html,
                parent,
                editable,
                sites,
                revisions,
                DateTime.UtcNow,
                LeaseDuration,
                executionCts.Token);
            run.ArtifactSiteId = persisted.SiteId;
            run.ArtifactRevisionId = persisted.RevisionId;
            object donePayload = run.Operation == DesignArtifactOperations.Edit
                ? new { revisionId = persisted.RevisionId, siteId = persisted.SiteId, status = persisted.RevisionStatus }
                : new { siteId = persisted.SiteId, siteUrl = persisted.SiteUrl, title = persisted.Title, revisionId = persisted.RevisionId };

            run.Status = RunStatuses.Done;
            run.Progress = 100;
            run.Phase = run.Operation == DesignArtifactOperations.Edit ? "草稿已生成" : "网页已生成并保存";
            run.CompletedAt = DateTime.UtcNow;
            run.UpdatedAt = DateTime.UtcNow;
            if (!await CompleteRunOrCompensateArtifactAsync(
                    db,
                    run,
                    leaseOwner,
                    persisted,
                    sites,
                    revisions,
                    run.Phase,
                    run.CompletedAt.Value,
                    CancellationToken.None))
                throw new DesignArtifactRunLeaseLostException(run.Id);

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
        catch (DesignArtifactRunLeaseLostException)
        {
            executionCts.Cancel();
            _logger.LogWarning("设计产物 Run 已失去执行租约 runId={RunId}", runId);
        }
        catch (KeyNotFoundException)
        {
            await MarkErrorAsync(runId, "站点不存在或你没有修改权限", leaseOwner);
        }
        catch (InvalidOperationException ex)
        {
            await MarkErrorAsync(runId, ex.Message, leaseOwner);
        }
        catch (OperationCanceledException) when (executionCts.IsCancellationRequested)
        {
            _logger.LogWarning("设计产物 Run 已失去执行租约 runId={RunId}", runId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "设计产物 Run 执行失败 runId={RunId}", runId);
            await MarkErrorAsync(runId, "设计任务执行失败，请稍后重试", leaseOwner);
        }
        finally
        {
            executionCts.Cancel();
            try { await heartbeatTask; }
            catch (OperationCanceledException) { }
        }
    }

    internal static string BuildQualityEvidence(DesignArtifactRun run, HostedSiteEditableEntry? editable) =>
        string.Join(
            "\n",
            new[]
            {
                run.Title,
                run.Instruction,
                string.Join("\n", run.KnowledgeReferences.Select(item => $"{item.Title}\n{item.Content}")),
                editable == null ? string.Empty : HostedSiteRevisionRules.ExtractVisibleText(editable.Html),
            }.Where(value => !string.IsNullOrWhiteSpace(value)));

    private async Task UpdatePhaseAsync(
        MongoDbContext db,
        DesignArtifactRun run,
        string leaseOwner,
        int progress,
        string message)
    {
        run.Progress = progress;
        run.Phase = message;
        run.Status = RunStatuses.Running;
        run.UpdatedAt = DateTime.UtcNow;
        if (!await PersistPhaseAsync(
                db,
                run.Id,
                leaseOwner,
                progress,
                message,
                run.UpdatedAt,
                CancellationToken.None))
            throw new DesignArtifactRunLeaseLostException(run.Id);
        await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            run.Id,
            "phase",
            new { progress, message },
            RunTtl,
            CancellationToken.None);
    }

    private async Task MarkErrorAsync(string runId, string message, string leaseOwner)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var update = Builders<DesignArtifactRun>.Update
            .Set(x => x.Status, RunStatuses.Error)
            .Set(x => x.Error, message)
            .Set(x => x.Phase, message)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .Set(x => x.CompletedAt, DateTime.UtcNow)
            .Set(x => x.LeaseExpiresAt, null);
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId
                 && (x.Status == RunStatuses.Running || x.Status == RunStatuses.Committing)
                 && x.LeaseOwnerId == leaseOwner,
            update,
            cancellationToken: CancellationToken.None);
        if (write.ModifiedCount == 0) return;

        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, CancellationToken.None)
                   ?? new RunMeta { RunId = runId, Kind = RunKinds.DesignArtifact };
        meta.Status = RunStatuses.Error;
        meta.EndedAt = DateTime.UtcNow;
        meta.ErrorCode = "DESIGN_ARTIFACT_FAILED";
        meta.ErrorMessage = message;
        await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
        await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            runId,
            "error",
            new { code = "DESIGN_ARTIFACT_FAILED", message },
            RunTtl,
            CancellationToken.None);
    }

    private async Task MaintainHeartbeatAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        DateTime initialLeaseDeadline,
        CancellationTokenSource executionCts)
    {
        await RunLeaseHeartbeatLoopAsync(
            (now, cancellationToken) => RenewLeaseAsync(
                db,
                runId,
                leaseOwner,
                now,
                LeaseDuration,
                cancellationToken),
            initialLeaseDeadline,
            LeaseDuration,
            LeaseDuration / 3,
            () => DateTime.UtcNow,
            executionCts,
            ex => _logger.LogWarning(ex, "设计产物 Run 心跳写入失败 runId={RunId}", runId));
    }

    internal static async Task RunLeaseHeartbeatLoopAsync(
        Func<DateTime, CancellationToken, Task<bool>> renew,
        DateTime initialLeaseDeadline,
        TimeSpan leaseDuration,
        TimeSpan heartbeatInterval,
        Func<DateTime> utcNow,
        CancellationTokenSource executionCts,
        Action<Exception>? onRenewError = null)
    {
        var confirmedDeadline = initialLeaseDeadline;
        while (!executionCts.IsCancellationRequested)
        {
            var remaining = confirmedDeadline - utcNow();
            if (remaining <= TimeSpan.Zero)
            {
                executionCts.Cancel();
                return;
            }

            var delay = remaining < heartbeatInterval ? remaining : heartbeatInterval;
            try
            {
                await Task.Delay(delay, executionCts.Token);
                var now = utcNow();
                var renewBudget = confirmedDeadline - now;
                if (renewBudget <= TimeSpan.Zero)
                {
                    executionCts.Cancel();
                    return;
                }
                using var renewCts = CancellationTokenSource.CreateLinkedTokenSource(executionCts.Token);
                renewCts.CancelAfter(renewBudget);
                if (!await renew(now, renewCts.Token))
                {
                    executionCts.Cancel();
                    return;
                }
                confirmedDeadline = now + leaseDuration;
            }
            catch (OperationCanceledException) when (executionCts.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                onRenewError?.Invoke(ex);
                if (utcNow() >= confirmedDeadline)
                {
                    executionCts.Cancel();
                    return;
                }
            }
        }
    }

    private async Task ReconcileAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        await RecoverInterruptedRunsAsync(
            db,
            _queue,
            _events,
            DateTime.UtcNow,
            ct,
            scope.ServiceProvider.GetRequiredService<IHostedSiteService>(),
            scope.ServiceProvider.GetRequiredService<IHostedSiteRevisionService>(),
            scope.ServiceProvider.GetRequiredService<IAssetStorage>());
    }

    internal static async Task<PersistedDesignArtifact> PersistArtifactWithLeaseAsync(
        MongoDbContext db,
        DesignArtifactRun run,
        string leaseOwner,
        string html,
        HostedSiteRevision? parent,
        HostedSiteEditableEntry? editable,
        IHostedSiteService sites,
        IHostedSiteRevisionService revisions,
        DateTime now,
        TimeSpan leaseDuration,
        CancellationToken ct)
    {
        if (!await BeginCommitAsync(db, run.Id, leaseOwner, now, leaseDuration, CancellationToken.None))
            throw new DesignArtifactRunLeaseLostException(run.Id);

        if (run.Operation == DesignArtifactOperations.Edit)
        {
            if (string.IsNullOrWhiteSpace(run.TargetSiteId) || parent == null || editable == null)
                throw new InvalidOperationException("页面修改任务缺少待保存的版本上下文");
            HostedSiteRevision? draft = null;
            try
            {
                draft = await revisions.CreateDraftAsync(
                    run.TargetSiteId,
                    run.UserId,
                    html,
                    run.Instruction,
                    run.Runtime,
                    run.Id,
                    parent.Id,
                    run.KnowledgeReferences.Select(x => x.EntryId).ToList(),
                    editable.ContentVersion,
                    ct);
                if (!await RenewLeaseAsync(
                        db,
                        run.Id,
                        leaseOwner,
                        DateTime.UtcNow,
                        leaseDuration,
                        CancellationToken.None))
                    throw new DesignArtifactRunLeaseLostException(run.Id);
                return new PersistedDesignArtifact(run.TargetSiteId, draft.Id, draft.Status, null, null);
            }
            catch
            {
                try
                {
                    await revisions.CompensateUnpublishedDraftAsync(
                        run.TargetSiteId,
                        run.Id,
                        run.UserId,
                        draft?.Id,
                        CancellationToken.None);
                }
                catch (Exception cleanupEx)
                {
                    await MarkCleanupPendingAsync(db, run.Id, cleanupEx, DateTime.UtcNow);
                }
                throw;
            }
        }

        HostedSite? site = null;
        try
        {
            site = await sites.CreateFromContentAsync(
                run.UserId,
                html,
                run.Title,
                "由知识驱动设计生成",
                "design-agent",
                run.Id,
                new List<string> { "知识生成" },
                null,
                ct);
            if (!await RenewLeaseAsync(
                    db,
                    run.Id,
                    leaseOwner,
                    DateTime.UtcNow,
                    leaseDuration,
                    CancellationToken.None))
                throw new DesignArtifactRunLeaseLostException(run.Id);

            var current = await sites.GetEditableEntryHtmlAsync(site.Id, run.UserId, ct);
            var baseline = await revisions.EnsureGeneratedSnapshotAsync(
                site.Id,
                run.UserId,
                current,
                run.Runtime,
                run.Id,
                run.KnowledgeReferences.Select(item => item.EntryId).ToList(),
                ct);
            if (!await RenewLeaseAsync(
                    db,
                    run.Id,
                    leaseOwner,
                    DateTime.UtcNow,
                    leaseDuration,
                    CancellationToken.None))
                throw new DesignArtifactRunLeaseLostException(run.Id);
            return new PersistedDesignArtifact(site.Id, baseline.Id, baseline.Status, site.SiteUrl, site.Title);
        }
        catch
        {
            try
            {
                await sites.CompensateGeneratedSiteAsync(site?.Id, run.Id, run.UserId, CancellationToken.None);
            }
            catch (Exception cleanupEx)
            {
                await MarkCleanupPendingAsync(db, run.Id, cleanupEx, DateTime.UtcNow);
            }
            throw;
        }
    }

    internal static async Task<bool> CompleteRunOrCompensateArtifactAsync(
        MongoDbContext db,
        DesignArtifactRun run,
        string leaseOwner,
        PersistedDesignArtifact artifact,
        IHostedSiteService sites,
        IHostedSiteRevisionService revisions,
        string phase,
        DateTime completedAt,
        CancellationToken ct)
    {
        var completed = await CompleteRunAsync(
            db,
            run.Id,
            leaseOwner,
            artifact.SiteId,
            artifact.RevisionId,
            phase,
            completedAt,
            ct);
        if (completed) return true;

        try
        {
            if (run.Operation == DesignArtifactOperations.Edit)
            {
                await revisions.CompensateUnpublishedDraftAsync(
                    artifact.SiteId,
                    run.Id,
                    run.UserId,
                    artifact.RevisionId,
                    CancellationToken.None);
                await ClearCleanupPendingAsync(db, run.Id, completedAt);
            }
            else
            {
                await sites.CompensateGeneratedSiteAsync(
                    artifact.SiteId,
                    run.Id,
                    run.UserId,
                    CancellationToken.None);
            }
        }
        catch (Exception cleanupEx)
        {
            await MarkCleanupPendingAsync(db, run.Id, cleanupEx, completedAt);
        }

        return false;
    }

    internal static async Task MarkCleanupPendingAsync(
        MongoDbContext db,
        string runId,
        Exception error,
        DateTime attemptedAt)
    {
        var message = error.Message.Length <= 500 ? error.Message : error.Message[..500];
        await db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId
                 && (x.Status == RunStatuses.Committing || x.Status == RunStatuses.Error),
            Builders<DesignArtifactRun>.Update
                .Set(x => x.CleanupPending, true)
                .Set(x => x.CleanupAttemptedAt, attemptedAt)
                .Set(x => x.CleanupLastError, message),
            cancellationToken: CancellationToken.None);
    }

    private static Task ClearCleanupPendingAsync(MongoDbContext db, string runId, DateTime attemptedAt) =>
        db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId && x.Status == RunStatuses.Error && x.CleanupPending,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.CleanupPending, false)
                .Set(x => x.CleanupAttemptedAt, attemptedAt)
                .Set(x => x.CleanupArtifactSiteId, null)
                .Set(x => x.CleanupAssetKeys, new List<string>())
                .Set(x => x.CleanupSiteRecordDeleted, false)
                .Set(x => x.CleanupLastError, null),
            cancellationToken: CancellationToken.None);

    internal static async Task<bool> BeginCommitAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        DateTime now,
        TimeSpan leaseDuration,
        CancellationToken ct)
    {
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId
                 && x.Status == RunStatuses.Running
                 && x.LeaseOwnerId == leaseOwner
                 && x.LeaseExpiresAt > now,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Committing)
                .Set(x => x.HeartbeatAt, now)
                .Set(x => x.LeaseExpiresAt, now + leaseDuration)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    internal static async Task<DesignArtifactRun?> TryClaimAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        DateTime now,
        TimeSpan leaseDuration,
        CancellationToken ct)
    {
        var fb = Builders<DesignArtifactRun>.Filter;
        var filter = fb.Eq(x => x.Id, runId) & fb.Eq(x => x.Status, RunStatuses.Queued);
        return await db.DesignArtifactRuns.FindOneAndUpdateAsync(
            filter,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Running)
                .Set(x => x.LeaseOwnerId, leaseOwner)
                .Set(x => x.LeaseExpiresAt, now + leaseDuration)
                .Set(x => x.HeartbeatAt, now)
                .Set(x => x.UpdatedAt, now),
            new FindOneAndUpdateOptions<DesignArtifactRun> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    internal static async Task<bool> RenewLeaseAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        DateTime now,
        TimeSpan leaseDuration,
        CancellationToken ct)
    {
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId
                 && (x.Status == RunStatuses.Running || x.Status == RunStatuses.Committing)
                 && x.LeaseOwnerId == leaseOwner
                 && x.LeaseExpiresAt > now,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.HeartbeatAt, now)
                .Set(x => x.LeaseExpiresAt, now + leaseDuration)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    internal static async Task<bool> PersistPhaseAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        int progress,
        string phase,
        DateTime updatedAt,
        CancellationToken ct)
    {
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId
                 && x.Status == RunStatuses.Running
                 && x.LeaseOwnerId == leaseOwner
                 && x.LeaseExpiresAt > updatedAt,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Progress, progress)
                .Set(x => x.Phase, phase)
                .Max(x => x.UpdatedAt, updatedAt),
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    internal static async Task<bool> CompleteRunAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        string? artifactSiteId,
        string? artifactRevisionId,
        string phase,
        DateTime completedAt,
        CancellationToken ct)
    {
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId
                 && x.Status == RunStatuses.Committing
                 && x.LeaseOwnerId == leaseOwner
                 && x.LeaseExpiresAt > completedAt,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Done)
                .Set(x => x.Progress, 100)
                .Set(x => x.Phase, phase)
                .Set(x => x.ArtifactSiteId, artifactSiteId)
                .Set(x => x.ArtifactRevisionId, artifactRevisionId)
                .Set(x => x.CompletedAt, completedAt)
                .Max(x => x.UpdatedAt, completedAt),
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    internal static async Task RecoverInterruptedRunsAsync(
        MongoDbContext db,
        IRunQueue queue,
        IRunEventStore events,
        DateTime now,
        CancellationToken ct,
        IHostedSiteService? sites = null,
        IHostedSiteRevisionService? revisions = null,
        IAssetStorage? workspaceStorage = null)
    {
        if (workspaceStorage != null)
            await RecoverRejectedWorkspaceResultsAsync(db, workspaceStorage, now, ct);

        // 上一轮已经终结但清理失败的任务先重试；本轮新发现的任务只尝试一次，避免故障时紧密重试。
        var pendingCleanup = await db.DesignArtifactRuns
            .Find(x => x.Status == RunStatuses.Error && x.CleanupPending)
            .Limit(100)
            .ToListAsync(ct);
        foreach (var candidate in pendingCleanup)
            await TryCompensateRecoveredRunAsync(db, candidate, sites, revisions, now);

        var staleRunning = await db.DesignArtifactRuns
            .Find(x => (x.Status == RunStatuses.Running || x.Status == RunStatuses.Committing)
                       && ((x.LeaseExpiresAt != null && x.LeaseExpiresAt <= now)
                           || (x.LeaseExpiresAt == null && x.UpdatedAt <= now - LeaseDuration)))
            .Limit(100)
            .ToListAsync(ct);
        foreach (var candidate in staleRunning)
        {
            var interruptedMessage = "服务重启中断了本次设计任务，请重新发起";
            var write = await db.DesignArtifactRuns.UpdateOneAsync(
                x => x.Id == candidate.Id
                     && x.Status == candidate.Status
                     && x.LeaseOwnerId == candidate.LeaseOwnerId
                     && x.LeaseExpiresAt == candidate.LeaseExpiresAt,
                Builders<DesignArtifactRun>.Update
                    .Set(x => x.Status, RunStatuses.Error)
                    .Set(x => x.Error, interruptedMessage)
                    .Set(x => x.Phase, interruptedMessage)
                    .Set(x => x.UpdatedAt, now)
                    .Set(x => x.CompletedAt, now)
                    .Set(x => x.LeaseExpiresAt, null)
                    .Set(x => x.CleanupPending, candidate.Status == RunStatuses.Committing)
                    .Set(x => x.CleanupLastError, candidate.Status == RunStatuses.Committing
                        ? "等待清理未完成的设计产物"
                        : null),
                cancellationToken: CancellationToken.None);
            if (write.ModifiedCount == 0) continue;

            if (candidate.Status == RunStatuses.Committing)
                await TryCompensateRecoveredRunAsync(db, candidate, sites, revisions, now);

            var meta = await events.GetRunAsync(RunKinds.DesignArtifact, candidate.Id, CancellationToken.None)
                       ?? new RunMeta
                       {
                           RunId = candidate.Id,
                           Kind = RunKinds.DesignArtifact,
                           CreatedByUserId = candidate.UserId,
                           CreatedAt = candidate.CreatedAt,
                       };
            meta.Status = RunStatuses.Error;
            meta.EndedAt = now;
            meta.ErrorCode = "DESIGN_ARTIFACT_INTERRUPTED";
            meta.ErrorMessage = interruptedMessage;
            await events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
            await events.AppendEventAsync(
                RunKinds.DesignArtifact,
                candidate.Id,
                "error",
                new { code = "DESIGN_ARTIFACT_INTERRUPTED", message = interruptedMessage },
                RunTtl,
                CancellationToken.None);
        }

        var queueCandidates = await db.DesignArtifactRuns
            .Find(x => x.Status == RunStatuses.Queued
                       && x.UpdatedAt <= now - QueueRecoveryDelay
                       && (x.RecoveryEnqueuedAt == null || x.RecoveryEnqueuedAt <= now - RecoveryInterval))
            .Limit(100)
            .ToListAsync(ct);
        foreach (var candidate in queueCandidates)
        {
            var write = await db.DesignArtifactRuns.UpdateOneAsync(
                x => x.Id == candidate.Id
                     && x.Status == RunStatuses.Queued
                     && x.RecoveryEnqueuedAt == candidate.RecoveryEnqueuedAt,
                Builders<DesignArtifactRun>.Update.Set(x => x.RecoveryEnqueuedAt, now),
                cancellationToken: CancellationToken.None);
            if (write.ModifiedCount == 1)
                await queue.EnqueueAsync(RunKinds.DesignArtifact, candidate.Id, CancellationToken.None);
        }
    }

    internal static async Task<int> RecoverRejectedWorkspaceResultsAsync(
        MongoDbContext db,
        IAssetStorage storage,
        DateTime attemptedAt,
        CancellationToken ct,
        string? processEpoch = null)
    {
        var pendingWrites = await db.DesignArtifactRuns
            .Find(x => x.WorkspaceResultAssetKey == null
                       && x.WorkspacePendingResultAssetKey != null
                       && x.WorkspacePendingResultAssetKey != string.Empty
                       && x.WorkspacePendingResultAttemptId != null
                       && x.WorkspacePendingResultAttemptId != string.Empty)
            .Limit(100)
            .ToListAsync(ct);
        var recovered = 0;
        foreach (var candidate in pendingWrites)
        {
            if (await DesignArtifactWorkspaceBroker.RecoverPendingWorkspaceResultAsync(
                    db,
                    storage,
                    candidate,
                    attemptedAt,
                    ct,
                    processEpoch: processEpoch))
                recovered++;
        }

        // 兼容修复前已经落库的晚到结果清理线索。
        var candidates = await db.DesignArtifactRuns
            .Find(x => x.WorkspaceResultAssetKey == null
                       && x.WorkspaceRejectedResultAssetKey != null
                       && x.WorkspaceRejectedResultAssetKey != string.Empty)
            .Limit(100)
            .ToListAsync(ct);
        foreach (var candidate in candidates)
        {
            var key = candidate.WorkspaceRejectedResultAssetKey!;
            try
            {
                await storage.DeleteByKeyAsync(key, CancellationToken.None);
                var write = await db.DesignArtifactRuns.UpdateOneAsync(
                    x => x.Id == candidate.Id
                         && x.WorkspaceResultAssetKey == null
                         && x.WorkspaceRejectedResultAssetKey == key,
                    Builders<DesignArtifactRun>.Update
                        .Set(x => x.WorkspaceResultSha256, null)
                        .Set(x => x.WorkspaceRejectedResultAssetKey, null)
                        .Set(x => x.WorkspaceRejectedResultCleanupAttemptedAt, null)
                        .Set(x => x.WorkspaceRejectedResultCleanupError, null)
                        .Set(x => x.UpdatedAt, attemptedAt),
                    cancellationToken: CancellationToken.None);
                if (write.ModifiedCount == 1) recovered++;
            }
            catch (Exception ex)
            {
                var message = string.IsNullOrWhiteSpace(ex.Message) ? ex.GetType().Name : ex.Message;
                if (message.Length > 500) message = message[..500];
                await db.DesignArtifactRuns.UpdateOneAsync(
                    x => x.Id == candidate.Id
                         && x.WorkspaceResultAssetKey == null
                         && x.WorkspaceRejectedResultAssetKey == key,
                    Builders<DesignArtifactRun>.Update
                        .Set(x => x.WorkspaceRejectedResultCleanupAttemptedAt, attemptedAt)
                        .Set(x => x.WorkspaceRejectedResultCleanupError, message)
                        .Set(x => x.UpdatedAt, attemptedAt),
                    cancellationToken: CancellationToken.None);
            }
        }
        return recovered;
    }

    internal static async Task TryCompensateRecoveredRunAsync(
        MongoDbContext db,
        DesignArtifactRun run,
        IHostedSiteService? sites,
        IHostedSiteRevisionService? revisions,
        DateTime attemptedAt)
    {
        try
        {
            if (run.Operation == DesignArtifactOperations.Edit)
            {
                if (revisions == null || string.IsNullOrWhiteSpace(run.TargetSiteId))
                    throw new InvalidOperationException("页面草稿补偿服务或目标站点不可用");
                await revisions.CompensateUnpublishedDraftAsync(
                    run.TargetSiteId,
                    run.Id,
                    run.UserId,
                    run.ArtifactRevisionId,
                    CancellationToken.None);
                await db.DesignArtifactRuns.UpdateOneAsync(
                    x => x.Id == run.Id && x.Status == RunStatuses.Error && x.CleanupPending,
                    Builders<DesignArtifactRun>.Update
                        .Set(x => x.CleanupPending, false)
                        .Set(x => x.CleanupAttemptedAt, attemptedAt)
                        .Set(x => x.CleanupArtifactSiteId, null)
                        .Set(x => x.CleanupAssetKeys, new List<string>())
                        .Set(x => x.CleanupSiteRecordDeleted, false)
                        .Set(x => x.CleanupLastError, null),
                    cancellationToken: CancellationToken.None);
            }
            else
            {
                if (sites == null)
                    throw new InvalidOperationException("生成站点补偿服务不可用");
                await sites.CompensateGeneratedSiteAsync(
                    run.ArtifactSiteId,
                    run.Id,
                    run.UserId,
                    CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            var message = ex.Message.Length <= 500 ? ex.Message : ex.Message[..500];
            await db.DesignArtifactRuns.UpdateOneAsync(
                x => x.Id == run.Id && x.Status == RunStatuses.Error && x.CleanupPending,
                Builders<DesignArtifactRun>.Update
                    .Set(x => x.CleanupAttemptedAt, attemptedAt)
                    .Set(x => x.CleanupLastError, message),
                cancellationToken: CancellationToken.None);
        }
    }

}

internal sealed record PersistedDesignArtifact(
    string SiteId,
    string RevisionId,
    string RevisionStatus,
    string? SiteUrl,
    string? Title);

internal sealed class DesignArtifactRunLeaseLostException(string runId)
    : InvalidOperationException($"Design artifact run lease lost: {runId}");
