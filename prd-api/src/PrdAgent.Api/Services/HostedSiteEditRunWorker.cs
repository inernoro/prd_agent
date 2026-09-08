using System.Text;
using System.Runtime.CompilerServices;
using MongoDB.Driver;
using PrdAgent.Api.Filters;
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

    internal async Task ProcessAsync(string runId, CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var publicLifecycle = scope.ServiceProvider.GetRequiredService<IWebPageDesignArtifactLifecycleAdapter>();
        var lifecycle = scope.ServiceProvider.GetRequiredService<IDesignArtifactLifecycleService>();
        var leaseOwner = $"{_instanceId}:{Guid.NewGuid():N}";
        var run = await TryClaimWithLifecycleAsync(
            db,
            lifecycle,
            runId,
            leaseOwner,
            DateTime.UtcNow,
            LeaseDuration,
            ct);
        if (run == null) return;

        var projection = new RunProjection(_logger, runId);
        var meta = new RunMeta
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
        await projection.WriteAsync(() => _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None));
        await UpdatePhaseAsync(db, run, leaseOwner, publicLifecycle, projection, 8,
            run.Operation == DesignArtifactOperations.Edit ? "正在读取当前页面" : "正在整理知识与页面目标");

        var sites = scope.ServiceProvider.GetRequiredService<IHostedSiteService>();
        var revisions = scope.ServiceProvider.GetRequiredService<IHostedSiteRevisionService>();
        var activityRecorder = scope.ServiceProvider.GetRequiredService<IActivityActionRecorder>();
        var knowledgeSnapshots = scope.ServiceProvider.GetRequiredService<IDesignKnowledgeSnapshotResolver>();
        var executor = scope.ServiceProvider
            .GetServices<IDesignArtifactExecutor>()
            .FirstOrDefault(x => x.Runtime == run.Runtime && x.Supports(run.ArtifactType, run.Operation));

        using var executionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var initialLeaseDeadline = run.LeaseExpiresAt ?? DateTime.UtcNow;
        var heartbeatTask = MaintainHeartbeatAsync(db, run.Id, leaseOwner, initialLeaseDeadline, executionCts);
        var cancellationWatchTask = WatchForCancellationAsync(db, run.Id, leaseOwner, executionCts);
        try
        {
            executionCts.Token.ThrowIfCancellationRequested();
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
                executionCts.Token.ThrowIfCancellationRequested();
            }

            var knowledgeChars = run.KnowledgeReferences.Sum(x => x.Content.Length);
            var executorInputHtml = NormalizeExecutorInput(run, editable?.Html);
            if ((executorInputHtml?.Length ?? 0) + knowledgeChars > MaxModelInputChars)
                throw new InvalidOperationException("页面与知识正文过长，首版最多支持约 24 万字符，请减少引用或精简内容");

            await UpdatePhaseAsync(db, run, leaseOwner, publicLifecycle, projection, 18,
                run.Operation == DesignArtifactOperations.Edit ? "正在理解页面结构与修改要求" : "正在规划页面结构与视觉层级");
            executionCts.Token.ThrowIfCancellationRequested();

            var output = new StringBuilder();
            var sawFirstText = false;
            IReadOnlyList<DesignWorkspaceFile>? verifiedFiles = null;
            // 统一 dispatch 门必须紧贴 ExecuteAsync；OpenDesign 的 workspace Prepare/上传和
            // MapGateway 的 LLM 调用都发生在 ExecuteAsync 内，因此撤权失败时两条路径均为 0 次外发。
            await foreach (var chunk in ExecuteWithKnowledgeDispatchGuardAsync(
                               knowledgeSnapshots,
                               executor,
                               run,
                               executorInputHtml,
                               executionCts.Token))
            {
                executionCts.Token.ThrowIfCancellationRequested();
                if (chunk.VerifiedFiles != null)
                {
                    if (verifiedFiles != null)
                        throw new InvalidOperationException("设计执行器重复提交了产物文件包，请重新生成");
                    verifiedFiles = chunk.VerifiedFiles;
                }
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    output.Append(chunk.Content);
                    if (!sawFirstText)
                    {
                        sawFirstText = true;
                        await UpdatePhaseAsync(db, run, leaseOwner, publicLifecycle, projection, 36, "页面已经开始生成");
                    }
                    await projection.WriteAsync(() => _events.AppendEventAsync(
                        RunKinds.DesignArtifact,
                        runId,
                        "delta",
                        new { text = chunk.Content },
                        RunTtl,
                        CancellationToken.None));
                    continue;
                }

                if (chunk.Type == "thinking" && !string.IsNullOrEmpty(chunk.Content))
                {
                    await projection.WriteAsync(() => _events.AppendEventAsync(
                        RunKinds.DesignArtifact,
                        runId,
                        "thinking",
                        new { text = chunk.Content },
                        RunTtl,
                        CancellationToken.None));
                    continue;
                }
            }

            executionCts.Token.ThrowIfCancellationRequested();
            var html = HardenExecutorOutput(output.ToString(), verifiedFiles);
            var qualityEvidence = BuildQualityEvidence(run, editable);
            HostedSiteRevisionRules.ValidateGeneratedContentQuality(html, qualityEvidence);
            await UpdatePhaseAsync(db, run, leaseOwner, publicLifecycle, projection, 88,
                run.Operation == DesignArtifactOperations.Edit ? "正在校验并保存草稿" : "正在校验并保存托管网页");
            executionCts.Token.ThrowIfCancellationRequested();

            if (run.ContractVersion == DesignArtifactContractVersions.Current)
            {
                if (verifiedFiles == null)
                    throw new InvalidOperationException("OpenDesign 没有提交受信产物文件包，请重新生成");
                await publicLifecycle.CommitManifestAsync(
                    run.Id,
                    verifiedFiles,
                    new DesignArtifactLifecycleLeaseAuthority(leaseOwner),
                    CancellationToken.None);
            }

            executionCts.Token.ThrowIfCancellationRequested();
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
                executionCts.Token,
                verifiedFiles);
            run.ArtifactSiteId = persisted.SiteId;
            run.ArtifactRevisionId = persisted.RevisionId;
            if (run.ContractVersion == DesignArtifactContractVersions.Current
                && !await RecordProducedArtifactAsync(
                    db,
                    run.Id,
                    leaseOwner,
                    persisted.SiteId,
                    persisted.RevisionId,
                    CancellationToken.None))
            {
                throw new DesignArtifactRunLeaseLostException(run.Id);
            }
            object donePayload = run.Operation == DesignArtifactOperations.Edit
                ? new { revisionId = persisted.RevisionId, siteId = persisted.SiteId, status = persisted.RevisionStatus }
                : new { siteId = persisted.SiteId, siteUrl = persisted.SiteUrl, title = persisted.Title, revisionId = persisted.RevisionId };

            run.Status = RunStatuses.Done;
            run.Progress = 100;
            run.Phase = run.Operation == DesignArtifactOperations.Edit ? "草稿已生成" : "网页已生成并保存";
            run.CompletedAt = DateTime.UtcNow;
            run.UpdatedAt = DateTime.UtcNow;
            if (run.ContractVersion == DesignArtifactContractVersions.Current)
            {
                try
                {
                    await publicLifecycle.CompleteAsync(
                        run.Id,
                        new DesignArtifactLifecycleLeaseAuthority(leaseOwner),
                        CancellationToken.None);
                    if (run.Operation == DesignArtifactOperations.Generate)
                    {
                        await publicLifecycle.BindPublishedAsync(
                            run.Id,
                            persisted.SiteId,
                            persisted.RevisionId,
                            CancellationToken.None);
                    }
                }
                catch (Exception ex)
                {
                    // 产物已形成且有 SourceRunId/ProducedArtifact 围栏，不能把瞬时账本失败改写为失败并删除。
                    // 保留 committing/done，恢复器会继续 complete 或 published 绑定。
                    _logger.LogWarning(ex, "OpenDesign 网页公共生命周期待恢复 runId={RunId}", run.Id);
                    throw new DesignArtifactRunLeaseLostException(run.Id);
                }
            }
            else if (!await CompleteRunOrCompensateArtifactAsync(
                         db,
                         run,
                         leaseOwner,
                         persisted,
                         sites,
                         revisions,
                         run.Phase,
                         run.CompletedAt.Value,
                         CancellationToken.None))
            {
                throw new DesignArtifactRunLeaseLostException(run.Id);
            }

            if (run.Operation == DesignArtifactOperations.Generate)
            {
                try
                {
                    await RecordGeneratedSitePublicationAsync(
                        db,
                        activityRecorder,
                        run,
                        CancellationToken.None);
                }
                catch (Exception ex)
                {
                    // 审计是可恢复投影，不得把已完成的站点生成反写成失败。
                    _logger.LogWarning(ex, "生成站点发布动态写入失败，等待恢复补记 runId={RunId}", run.Id);
                }
            }

            meta.Status = RunStatuses.Done;
            meta.EndedAt = DateTime.UtcNow;
            await projection.WriteAsync(() => _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None));
            await projection.WriteAsync(() => _events.AppendEventAsync(
                RunKinds.DesignArtifact,
                runId,
                "done",
                donePayload,
                RunTtl,
                CancellationToken.None));
        }
        catch (DesignArtifactRunLeaseLostException)
        {
            executionCts.Cancel();
            if (await HasRequestedCancellationAsync(db, runId, leaseOwner))
                await MarkCancelledAsync(runId, "设计任务已取消，未生成或发布新版本", leaseOwner);
            else
                _logger.LogWarning("设计产物 Run 已失去执行租约 runId={RunId}", runId);
        }
        catch (KeyNotFoundException)
        {
            await MarkErrorAsync(runId, "站点不存在或你没有修改权限", leaseOwner);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            await MarkErrorAsync(runId, ex.Message, leaseOwner);
        }
        catch (DesignArtifactExecutionCancelledException)
        {
            if (await HasRequestedCancellationAsync(db, runId, leaseOwner))
                await MarkCancelledAsync(runId, "设计任务已取消，未生成或发布新版本", leaseOwner);
            else
                await MarkErrorAsync(runId, "远程设计会话提前停止，请重新发起任务", leaseOwner);
        }
        catch (InvalidOperationException ex)
        {
            await MarkErrorAsync(runId, ex.Message, leaseOwner);
        }
        catch (OperationCanceledException) when (executionCts.IsCancellationRequested)
        {
            if (await HasRequestedCancellationAsync(db, runId, leaseOwner))
                await MarkCancelledAsync(runId, "设计任务已取消，未生成或发布新版本", leaseOwner);
            else
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
            try { await cancellationWatchTask; }
            catch (OperationCanceledException) { }
        }
    }

    internal static string BuildQualityEvidence(DesignArtifactRun run, HostedSiteEditableEntry? editable) =>
        string.Join(
            "\n",
            new[]
            {
                // Client-authored title/instruction are generation requests, not evidence
                // that can substantiate measured or sensitive claims.
                string.Join("\n", run.KnowledgeReferences.Select(item => $"{item.Title}\n{item.Content}")),
                editable == null ? string.Empty : HostedSiteRevisionRules.ExtractVisibleText(editable.Html),
            }.Where(value => !string.IsNullOrWhiteSpace(value)));

    internal static async Task RevalidateKnowledgeForDispatchAsync(
        IDesignKnowledgeSnapshotResolver resolver,
        string userId,
        IReadOnlyList<DesignKnowledgeSnapshot> frozenSnapshots,
        CancellationToken ct)
    {
        if (frozenSnapshots.Count == 0) return;
        await resolver.ResolveForRunAsync(
            userId,
            frozenSnapshots.Select(item => new DesignKnowledgeReferenceIdentity(
                item.EntryId,
                item.StoreId ?? string.Empty,
                item.ContentHash)).ToList(),
            ct);
    }

    internal static async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteWithKnowledgeDispatchGuardAsync(
        IDesignKnowledgeSnapshotResolver resolver,
        IDesignArtifactExecutor executor,
        DesignArtifactRun run,
        string? currentHtml,
        [EnumeratorCancellation] CancellationToken ct)
    {
        await RevalidateKnowledgeForDispatchAsync(
            resolver,
            run.UserId,
            run.KnowledgeReferences,
            CancellationToken.None);
        await foreach (var chunk in executor.ExecuteAsync(run, currentHtml, ct))
            yield return chunk;
    }

    private async Task UpdatePhaseAsync(
        MongoDbContext db,
        DesignArtifactRun run,
        string leaseOwner,
        IWebPageDesignArtifactLifecycleAdapter publicLifecycle,
        RunProjection projection,
        int progress,
        string message)
    {
        run.Progress = progress;
        run.Phase = message;
        run.Status = RunStatuses.Running;
        run.UpdatedAt = DateTime.UtcNow;
        if (run.ContractVersion == DesignArtifactContractVersions.Current)
        {
            await publicLifecycle.AppendPhaseAsync(
                run.Id,
                new DesignArtifactLifecycleLeaseAuthority(leaseOwner),
                progress,
                message,
                CancellationToken.None);
        }
        else if (!await PersistPhaseAsync(
                     db,
                     run.Id,
                     leaseOwner,
                     progress,
                     message,
                     run.UpdatedAt,
                     CancellationToken.None))
        {
            throw new DesignArtifactRunLeaseLostException(run.Id);
        }
        await projection.WriteAsync(() => _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            run.Id,
            "phase",
            new { progress, message },
            RunTtl,
            CancellationToken.None));
    }

    private Task MarkErrorAsync(string runId, string message, string leaseOwner)
        => MarkTerminalAsync(
            runId,
            message,
            leaseOwner,
            RunStatuses.Error,
            "error",
            "DESIGN_ARTIFACT_FAILED");

    private async Task MarkCancelledAsync(string runId, string message, string leaseOwner)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var current = await db.DesignArtifactRuns.Find(item => item.Id == runId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (current == null || current.Status == RunStatuses.Cancelled) return;
        if (current.Status != RunStatuses.Running
            || current.LeaseOwnerId != leaseOwner
            || !current.CancelRequestedAt.HasValue
            || current.ProducedArtifactSiteId != null
            || current.ProducedArtifactRevisionId != null)
            return;

        DesignArtifactRun? cancelled = null;
        if (current.ContractVersion == DesignArtifactContractVersions.Current)
        {
            var lifecycle = scope.ServiceProvider.GetRequiredService<IDesignArtifactLifecycleService>();
            try
            {
                cancelled = await lifecycle.CancelAsync(
                    new CancelDesignArtifactSessionRequest(
                        current.Id,
                        current.UserId,
                        new DesignArtifactLifecycleExpectation(
                            current.LifecycleVersion,
                            current.WorkspaceRef?.BaseRevision,
                            current.VersionBoundary?.BaseContentHash,
                            leaseOwner)),
                    CancellationToken.None);
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
            {
                return;
            }
        }
        else
        {
            var cancelledAt = DateTime.UtcNow;
            cancelled = await db.DesignArtifactRuns.FindOneAndUpdateAsync<DesignArtifactRun, DesignArtifactRun>(
                item => item.Id == runId
                        && item.Status == RunStatuses.Running
                        && item.LeaseOwnerId == leaseOwner
                        && item.CancelRequestedAt != null
                        && item.ProducedArtifactSiteId == null
                        && item.ProducedArtifactRevisionId == null,
                Builders<DesignArtifactRun>.Update
                    .Set(item => item.Status, RunStatuses.Cancelled)
                    .Set(item => item.Error, null)
                    .Set(item => item.Phase, message)
                    .Set(item => item.CancelledAt, cancelledAt)
                    .Set(item => item.CompletedAt, cancelledAt)
                    .Set(item => item.UpdatedAt, cancelledAt)
                    .Set(item => item.LeaseExpiresAt, null),
                new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                CancellationToken.None);
        }
        if (cancelled == null) return;

        var projection = new RunProjection(_logger, runId);
        var meta = new RunMeta { RunId = runId, Kind = RunKinds.DesignArtifact,
            CreatedByUserId = cancelled.UserId, CreatedAt = cancelled.CreatedAt };
        meta.Status = RunStatuses.Cancelled;
        meta.EndedAt = cancelled.CancelledAt ?? DateTime.UtcNow;
        meta.ErrorCode = null;
        meta.ErrorMessage = null;
        await projection.WriteAsync(() => _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None));
        await projection.WriteAsync(() => _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            runId,
            "cancelled",
            new { code = "DESIGN_ARTIFACT_CANCELLED", message },
            RunTtl,
            CancellationToken.None));
    }

    private async Task MarkTerminalAsync(
        string runId,
        string message,
        string leaseOwner,
        string status,
        string eventName,
        string? errorCode)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var current = await db.DesignArtifactRuns.Find(x => x.Id == runId)
            .FirstOrDefaultAsync(CancellationToken.None);
        var usesPublicLifecycle = current?.ContractVersion == DesignArtifactContractVersions.Current
                                  && current.Runtime == DesignArtifactRuntimes.OpenDesign;
        if (usesPublicLifecycle)
        {
            var publicLifecycle = scope.ServiceProvider.GetRequiredService<IWebPageDesignArtifactLifecycleAdapter>();
            var stableCode = errorCode == null
                ? "open_design_run_cancelled"
                : WebPageDesignArtifactLifecycleAdapter.ExecutionFailureCode;
            await publicLifecycle.FailAsync(
                runId,
                stableCode,
                new DesignArtifactLifecycleLeaseAuthority(leaseOwner),
                CancellationToken.None);
            status = RunStatuses.Error;
            eventName = "error";
            errorCode = stableCode;
        }
        var update = Builders<DesignArtifactRun>.Update
            .Set(x => x.Status, status)
            .Set(x => x.Error, errorCode == null ? null : message)
            .Set(x => x.Phase, message)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .Set(x => x.CompletedAt, DateTime.UtcNow)
            .Set(x => x.LeaseExpiresAt, null);
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == runId
                 && (usesPublicLifecycle
                     ? x.Status == RunStatuses.Error
                     : x.Status == RunStatuses.Running || x.Status == RunStatuses.Committing)
                 && x.LeaseOwnerId == leaseOwner,
            update,
            cancellationToken: CancellationToken.None);
        if (write.ModifiedCount == 0) return;

        var projection = new RunProjection(_logger, runId);
        var meta = new RunMeta { RunId = runId, Kind = RunKinds.DesignArtifact,
            CreatedByUserId = current!.UserId, CreatedAt = current.CreatedAt };
        meta.Status = status;
        meta.EndedAt = DateTime.UtcNow;
        meta.ErrorCode = errorCode;
        meta.ErrorMessage = errorCode == null ? null : message;
        await projection.WriteAsync(() => _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None));
        await projection.WriteAsync(() => _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            runId,
            eventName,
            new { code = errorCode, message },
            RunTtl,
            CancellationToken.None));
    }

    // Redis 只投影当前执行的界面事件。一次失败后停止本次执行的投影，
    // 避免每个 token 重试拖慢模型；Mongo 阶段、产物和终态仍走原有权威写入。
    private sealed class RunProjection(ILogger logger, string runId)
    {
        private bool _unavailable;

        public async Task WriteAsync(Func<Task> write)
        {
            if (_unavailable) return;
            try
            {
                await write();
            }
            catch (Exception ex)
            {
                _unavailable = true;
                logger.LogWarning(ex, "设计任务实时投影不可用，继续执行并由 Mongo 恢复进度 runId={RunId}", runId);
            }
        }
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

    internal static async Task WatchForCancellationAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        CancellationTokenSource executionCts)
    {
        while (!executionCts.IsCancellationRequested)
        {
            var current = await db.DesignArtifactRuns.Find(item => item.Id == runId)
                .Project(item => new
                {
                    item.Status,
                    item.LeaseOwnerId,
                    item.CancelRequestedAt,
                })
                .FirstOrDefaultAsync(CancellationToken.None);
            if (current == null
                || current.Status is not (RunStatuses.Running or RunStatuses.Committing)
                || !string.Equals(current.LeaseOwnerId, leaseOwner, StringComparison.Ordinal))
            {
                executionCts.Cancel();
                return;
            }
            if (current.Status == RunStatuses.Running && current.CancelRequestedAt.HasValue)
            {
                executionCts.Cancel();
                return;
            }
            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(250), executionCts.Token);
            }
            catch (OperationCanceledException) when (executionCts.IsCancellationRequested)
            {
                return;
            }
        }
    }

    internal static async Task<bool> HasRequestedCancellationAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner)
    {
        return await db.DesignArtifactRuns.Find(item => item.Id == runId
                                                        && item.Status == RunStatuses.Running
                                                        && item.LeaseOwnerId == leaseOwner
                                                        && item.CancelRequestedAt != null
                                                        && item.ProducedArtifactSiteId == null
                                                        && item.ProducedArtifactRevisionId == null)
            .AnyAsync(CancellationToken.None);
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
        var publicLifecycle = scope.ServiceProvider.GetRequiredService<IWebPageDesignArtifactLifecycleAdapter>();
        await publicLifecycle.RecoverPendingAsync(100, CancellationToken.None);
        await RecoverInterruptedRunsAsync(
            db,
            _queue,
            _events,
            DateTime.UtcNow,
            ct,
            scope.ServiceProvider.GetRequiredService<IHostedSiteService>(),
            scope.ServiceProvider.GetRequiredService<IHostedSiteRevisionService>(),
            scope.ServiceProvider.GetRequiredService<IAssetStorage>(),
            scope.ServiceProvider.GetRequiredService<IActivityActionRecorder>(),
            publicLifecycle,
            scope.ServiceProvider.GetRequiredService<IDesignArtifactLifecycleService>());
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
        CancellationToken ct,
        IReadOnlyList<DesignWorkspaceFile>? verifiedFiles = null)
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
                draft = verifiedFiles == null
                    ? await revisions.CreateDraftAsync(
                        run.TargetSiteId,
                        run.UserId,
                        html,
                        run.Instruction,
                        run.Runtime,
                        run.Id,
                        parent.Id,
                        run.KnowledgeReferences.Select(x => x.EntryId).ToList(),
                        editable.ContentVersion,
                        ct)
                    : await revisions.CreateVerifiedDraftAsync(
                        run.TargetSiteId,
                        run.UserId,
                        html,
                        BuildVerifiedHostedSiteFiles(verifiedFiles, html),
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
            if (verifiedFiles != null)
            {
                site = await sites.CreateFromVerifiedFilesAsync(
                    run.UserId,
                    BuildVerifiedHostedSiteFiles(verifiedFiles, html),
                    run.Title,
                    "由知识驱动设计生成",
                    "design-agent",
                    run.Id,
                    new List<string> { "知识生成" },
                    null,
                    leaseOwner,
                    ct);
            }
            else
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
            }
            if (!await RenewLeaseAsync(
                    db,
                    run.Id,
                    leaseOwner,
                    DateTime.UtcNow,
                    leaseDuration,
                    CancellationToken.None))
                throw new DesignArtifactRunLeaseLostException(run.Id);

            var current = await sites.GetEditableEntryHtmlAsync(site.Id, run.UserId, ct);
            var baseline = verifiedFiles == null
                ? await revisions.EnsureGeneratedSnapshotAsync(
                    site.Id,
                    run.UserId,
                    current,
                    run.Runtime,
                    run.Id,
                    run.KnowledgeReferences.Select(item => item.EntryId).ToList(),
                    ct)
                : await revisions.EnsureGeneratedVerifiedSnapshotAsync(
                    site.Id,
                    run.UserId,
                    current,
                    BuildVerifiedHostedSiteFiles(verifiedFiles, html),
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
                if (run.ContractVersion == DesignArtifactContractVersions.Current)
                    await sites.CompensateGeneratedSiteWithLeaseAsync(site?.Id, run.Id, run.UserId, leaseOwner, CancellationToken.None);
                else
                    await sites.CompensateGeneratedSiteAsync(site?.Id, run.Id, run.UserId, CancellationToken.None);
            }
            catch (Exception cleanupEx)
            {
                await MarkCleanupPendingAsync(db, run.Id, cleanupEx, DateTime.UtcNow);
            }
            throw;
        }
    }

    internal static IReadOnlyList<HostedSiteVerifiedFile> BuildVerifiedHostedSiteFiles(
        IReadOnlyList<DesignWorkspaceFile> files,
        string hardenedHtml)
    {
        var hostedFiles = files.Select(file =>
        {
            byte[] content;
            try
            {
                content = Convert.FromBase64String(file.ContentBase64);
            }
            catch (FormatException)
            {
                throw new InvalidOperationException("设计产物文件损坏，请重新生成");
            }
            return new HostedSiteVerifiedFile(file.Path, content, file.Sha256, file.MediaType);
        }).ToArray();
        var entry = hostedFiles.SingleOrDefault(file => file.Path == "index.html")
                    ?? throw new InvalidOperationException("设计产物入口缺失，请重新生成");
        if (!string.Equals(
                System.Text.Encoding.UTF8.GetString(entry.Content),
                hardenedHtml,
                StringComparison.Ordinal))
            throw new InvalidOperationException("设计产物入口与最终安全版本不一致，请重新生成");
        return hostedFiles;
    }

    internal static string HardenExecutorOutput(
        string rawHtml,
        IReadOnlyList<DesignWorkspaceFile>? verifiedFiles)
    {
        var hardened = HostedSiteRevisionRules.HardenGeneratedHtml(
            NormalizeTrustedSystemCspEnvelope(rawHtml));
        if (verifiedFiles != null)
            _ = BuildVerifiedHostedSiteFiles(verifiedFiles, hardened);
        return hardened;
    }

    internal static string? NormalizeExecutorInput(DesignArtifactRun run, string? currentHtml)
    {
        if (string.IsNullOrEmpty(currentHtml)
            || run.Operation != DesignArtifactOperations.Edit
            || run.Runtime != DesignArtifactRuntimes.MapGateway)
        {
            return currentHtml;
        }

        return NormalizeTrustedSystemCspEnvelope(currentHtml);
    }

    internal static string NormalizeTrustedSystemCspEnvelope(string html)
    {
        var stripped = HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(html);
        if (string.Equals(stripped, html, StringComparison.Ordinal)) return html;

        // 输入与输出共用此边界，避免相邻的重复系统包装被两个阶段各剥离一次。
        var strippedAgain = HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(stripped);
        return string.Equals(strippedAgain, stripped, StringComparison.Ordinal) ? stripped : html;
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
                .Set(x => x.CleanupPublishAttemptId, null)
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
                 && (x.Status == RunStatuses.Running
                     || x.ContractVersion == DesignArtifactContractVersions.Current
                     && x.Status == RunStatuses.Committing)
                 && x.CancelRequestedAt == null
                 && x.CleanupLeaseOwnerId == null
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
        var filter = fb.Eq(x => x.Id, runId)
                     & fb.Eq(x => x.Status, RunStatuses.Queued)
                     & fb.Eq(x => x.CleanupLeaseOwnerId, null)
                     & fb.Eq(x => x.CancelRequestedAt, null);
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

    internal static async Task<DesignArtifactRun?> TryClaimWithLifecycleAsync(
        MongoDbContext db,
        IDesignArtifactLifecycleService lifecycle,
        string runId,
        string leaseOwner,
        DateTime now,
        TimeSpan leaseDuration,
        CancellationToken ct)
    {
        var candidate = await db.DesignArtifactRuns.Find(run => run.Id == runId)
            .FirstOrDefaultAsync(ct);
        if (candidate?.ContractVersion != DesignArtifactContractVersions.Current)
            return await TryClaimAsync(db, runId, leaseOwner, now, leaseDuration, ct);
        if (candidate.Status != RunStatuses.Queued) return null;
        try
        {
            return await lifecycle.StartAsync(
                new StartDesignArtifactSessionRequest(
                    candidate.Id,
                    candidate.UserId,
                    new DesignArtifactLifecycleExpectation(
                        candidate.LifecycleVersion,
                        candidate.WorkspaceRef?.BaseRevision,
                        candidate.VersionBoundary?.BaseContentHash),
                    leaseOwner,
                    now + leaseDuration),
                CancellationToken.None);
        }
        catch (DesignArtifactLifecycleException ex)
            when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
        {
            return null;
        }
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
                 && x.CleanupLeaseOwnerId == null
                 && x.LeaseOwnerId == leaseOwner
                 && x.LeaseExpiresAt > now,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.HeartbeatAt, now)
                .Set(x => x.LeaseExpiresAt, now + leaseDuration)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        // Mongo 以毫秒存储时间；同毫秒续租可能不改变字节，但匹配仍证明租约有效。
        return write.MatchedCount == 1;
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
                 && x.CleanupLeaseOwnerId == null
                 && x.LeaseOwnerId == leaseOwner
                 && x.LeaseExpiresAt > completedAt,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Done)
                .Set(x => x.Progress, 100)
                .Set(x => x.Phase, phase)
                .Set(x => x.ArtifactSiteId, artifactSiteId)
                .Set(x => x.ArtifactRevisionId, artifactRevisionId)
                .Set(x => x.CleanupPending, false)
                .Set(x => x.CleanupArtifactSiteId, null)
                .Set(x => x.CleanupPublishAttemptId, null)
                .Set(x => x.CleanupAssetKeys, new List<string>())
                .Set(x => x.CleanupSiteRecordDeleted, false)
                .Set(x => x.CleanupLastError, null)
                .Set(x => x.CompletedAt, completedAt)
                .Max(x => x.UpdatedAt, completedAt),
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    internal static async Task<bool> RecordProducedArtifactAsync(
        MongoDbContext db,
        string runId,
        string leaseOwner,
        string siteId,
        string revisionId,
        CancellationToken ct)
    {
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            run => run.Id == runId
                   && run.ContractVersion == DesignArtifactContractVersions.Current
                   && run.Status == RunStatuses.Committing
                   && run.CleanupLeaseOwnerId == null
                   && run.LeaseOwnerId == leaseOwner
                   && run.LeaseExpiresAt > DateTime.UtcNow,
            Builders<DesignArtifactRun>.Update
                .Set(run => run.ProducedArtifactSiteId, siteId)
                .Set(run => run.ProducedArtifactRevisionId, revisionId)
                .Set(run => run.UpdatedAt, DateTime.UtcNow),
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
        IAssetStorage? workspaceStorage = null,
        IActivityActionRecorder? activityRecorder = null,
        IWebPageDesignArtifactLifecycleAdapter? publicLifecycle = null,
        IDesignArtifactLifecycleService? lifecycle = null)
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

        // 补偿认领后进程退出时任务仍是 Committing。先接管过期清理意图，
        // 再重新读取任务恢复可信结果，不能只清空 owner 后允许重新发布。
        if (sites != null)
        {
            var interruptedCleanup = await db.DesignArtifactRuns
                .Find(x => x.Status == RunStatuses.Committing
                           && x.Operation == DesignArtifactOperations.Generate
                           && x.CleanupPending
                           && (x.CleanupStartedAt != null || x.CleanupLeaseOwnerId != null)
                           && x.LeaseOwnerId != null
                           && x.LeaseExpiresAt != null && x.LeaseExpiresAt <= now
                           && (x.CleanupLeaseExpiresAt == null || x.CleanupLeaseExpiresAt <= now)
                           && x.ProducedArtifactSiteId == null && x.ProducedArtifactRevisionId == null)
                .Limit(100)
                .ToListAsync(ct);
            foreach (var candidate in interruptedCleanup)
            {
                try
                {
                    await sites.RecoverGeneratedSiteCleanupAsync(
                        candidate.Id, candidate.UserId, candidate.LeaseOwnerId!, CancellationToken.None);
                }
                catch
                {
                    // 持久清理意图仍在；本轮不重新发布，下一轮继续接管。
                }
            }
        }

        var staleRunning = await db.DesignArtifactRuns
            .Find(x => (x.Status == RunStatuses.Running || x.Status == RunStatuses.Committing)
                       && ((x.LeaseExpiresAt != null && x.LeaseExpiresAt <= now)
                           || (x.LeaseExpiresAt == null && x.UpdatedAt <= now - LeaseDuration)))
            .Limit(100)
            .ToListAsync(ct);
        foreach (var candidate in staleRunning)
        {
            if (candidate.CleanupStartedAt != null || candidate.CleanupLeaseOwnerId != null)
                continue;

            if (candidate.CancelRequestedAt.HasValue)
            {
                if (await FinalizeRecoveredCancellationAsync(db, events, candidate, lifecycle, now))
                    continue;
            }

            if (lifecycle != null
                && candidate.ContractVersion == DesignArtifactContractVersions.Current
                && candidate.Runtime == DesignArtifactRuntimes.OpenDesign
                && !string.IsNullOrWhiteSpace(candidate.WorkspaceResultAssetKey)
                && string.IsNullOrWhiteSpace(candidate.ProducedArtifactSiteId)
                && string.IsNullOrWhiteSpace(candidate.ProducedArtifactRevisionId)
                && !string.IsNullOrWhiteSpace(candidate.LeaseOwnerId)
                && candidate.LeaseExpiresAt.HasValue)
            {
                try
                {
                    var resumed = await lifecycle.ResumeResultReadyAsync(
                        new ResumeResultReadyDesignArtifactSessionRequest(
                            candidate.Id,
                            candidate.UserId,
                            new DesignArtifactLifecycleExpectation(
                                candidate.LifecycleVersion,
                                candidate.WorkspaceRef?.BaseRevision,
                                candidate.VersionBoundary?.BaseContentHash,
                                candidate.LeaseOwnerId,
                                candidate.LeaseExpiresAt,
                                Recovery: true)),
                        CancellationToken.None);
                    try
                    {
                        await queue.EnqueueAsync(RunKinds.DesignArtifact, resumed.Id, CancellationToken.None);
                    }
                    catch
                    {
                        // Mongo queued 状态是权威恢复意图；下一轮 queue recovery 会继续补投。
                    }
                    try
                    {
                        await events.AppendEventAsync(
                            RunKinds.DesignArtifact,
                            resumed.Id,
                            "phase",
                            new { progress = resumed.Progress, message = resumed.Phase },
                            RunTtl,
                            CancellationToken.None);
                    }
                    catch
                    {
                        // Redis 仅为兼容投影。
                    }
                    continue;
                }
                catch (DesignArtifactLifecycleException ex)
                    when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
                {
                    // 另一个恢复器或原 Worker 已推进，不能把新状态反写为中断失败。
                    continue;
                }
            }

            var interruptedMessage = "服务重启中断了本次设计任务，请重新发起";
            var usesPublicLifecycle = publicLifecycle != null
                                      && candidate.ContractVersion == DesignArtifactContractVersions.Current
                                      && candidate.Runtime == DesignArtifactRuntimes.OpenDesign
                                      && !string.IsNullOrWhiteSpace(candidate.LeaseOwnerId)
                                      && candidate.LeaseExpiresAt.HasValue;
            if (usesPublicLifecycle)
            {
                try
                {
                    await publicLifecycle!.FailAsync(
                        candidate.Id,
                        WebPageDesignArtifactLifecycleAdapter.InterruptedFailureCode,
                        new DesignArtifactLifecycleLeaseAuthority(
                            candidate.LeaseOwnerId!,
                            candidate.LeaseExpiresAt,
                            Recovery: true),
                        CancellationToken.None);
                }
                catch (DesignArtifactLifecycleException ex)
                    when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
                {
                    continue;
                }
            }
            var write = await db.DesignArtifactRuns.UpdateOneAsync(
                x => x.Id == candidate.Id
                     && x.Status == (usesPublicLifecycle ? RunStatuses.Error : candidate.Status)
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

        if (activityRecorder != null)
            await RecoverGeneratedSitePublicationActivitiesAsync(db, activityRecorder, ct);
    }

    private static async Task<bool> FinalizeRecoveredCancellationAsync(
        MongoDbContext db,
        IRunEventStore events,
        DesignArtifactRun candidate,
        IDesignArtifactLifecycleService? lifecycle,
        DateTime cancelledAt)
    {
        DesignArtifactRun? cancelled;
        if (candidate.ContractVersion == DesignArtifactContractVersions.Current)
        {
            if (lifecycle == null
                || string.IsNullOrWhiteSpace(candidate.LeaseOwnerId)
                || !candidate.LeaseExpiresAt.HasValue)
                return false;
            try
            {
                cancelled = await lifecycle.CancelAsync(
                    new CancelDesignArtifactSessionRequest(
                        candidate.Id,
                        candidate.UserId,
                        new DesignArtifactLifecycleExpectation(
                            candidate.LifecycleVersion,
                            candidate.WorkspaceRef?.BaseRevision,
                            candidate.VersionBoundary?.BaseContentHash,
                            candidate.LeaseOwnerId,
                            candidate.LeaseExpiresAt,
                            Recovery: true)),
                    CancellationToken.None);
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
            {
                return true;
            }
        }
        else
        {
            cancelled = await db.DesignArtifactRuns.FindOneAndUpdateAsync<DesignArtifactRun, DesignArtifactRun>(
                item => item.Id == candidate.Id
                        && item.Status == RunStatuses.Running
                        && item.LeaseOwnerId == candidate.LeaseOwnerId
                        && item.LeaseExpiresAt == candidate.LeaseExpiresAt
                        && item.CancelRequestedAt == candidate.CancelRequestedAt
                        && item.ProducedArtifactSiteId == null
                        && item.ProducedArtifactRevisionId == null,
                Builders<DesignArtifactRun>.Update
                    .Set(item => item.Status, RunStatuses.Cancelled)
                    .Set(item => item.Phase, "设计任务已取消")
                    .Set(item => item.Error, null)
                    .Set(item => item.CancelledAt, cancelledAt)
                    .Set(item => item.CompletedAt, cancelledAt)
                    .Set(item => item.UpdatedAt, cancelledAt)
                    .Set(item => item.LeaseExpiresAt, null),
                new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                CancellationToken.None);
            if (cancelled == null) return true;
        }

        try
        {
            var meta = await events.GetRunAsync(RunKinds.DesignArtifact, candidate.Id, CancellationToken.None)
                       ?? new RunMeta
                       {
                           RunId = candidate.Id,
                           Kind = RunKinds.DesignArtifact,
                           CreatedByUserId = candidate.UserId,
                           CreatedAt = candidate.CreatedAt,
                       };
            meta.Status = RunStatuses.Cancelled;
            meta.EndedAt = cancelled.CancelledAt ?? cancelledAt;
            meta.ErrorCode = null;
            meta.ErrorMessage = null;
            await events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
            await events.AppendEventAsync(
                RunKinds.DesignArtifact,
                candidate.Id,
                "cancelled",
                new { code = "DESIGN_ARTIFACT_CANCELLED", message = "设计任务已取消，未生成或发布新版本" },
                RunTtl,
                CancellationToken.None);
        }
        catch
        {
            // Mongo 终态是权威事实；Redis 投影由查询/SSE 回退补偿。
        }
        return true;
    }

    internal static async Task<bool> RecordGeneratedSitePublicationAsync(
        MongoDbContext db,
        IActivityActionRecorder activityRecorder,
        DesignArtifactRun run,
        CancellationToken ct)
    {
        if (run.Status != RunStatuses.Done
            || run.ArtifactType != DesignArtifactTypes.WebPage
            || run.Operation != DesignArtifactOperations.Generate
            || string.IsNullOrWhiteSpace(run.ArtifactSiteId)
            || !run.CompletedAt.HasValue)
            return false;

        var authoritativeRun = await db.DesignArtifactRuns.Find(item =>
                item.Id == run.Id
                && item.Status == RunStatuses.Done
                && item.ArtifactType == DesignArtifactTypes.WebPage
                && item.Operation == DesignArtifactOperations.Generate
                && item.ArtifactSiteId != null
                && item.CompletedAt != null
                && item.PublishedActivityProjectionCompletedAt == null)
            .FirstOrDefaultAsync(ct);
        if (authoritativeRun == null) return false;

        var site = await db.HostedSites.Find(item =>
                item.Id == authoritativeRun.ArtifactSiteId
                && item.OwnerUserId == authoritativeRun.UserId
                && item.SourceType == "design-agent"
                && item.SourceRef == authoritativeRun.Id)
            .FirstOrDefaultAsync(ct);
        if (site == null)
        {
            var skippedAt = DateTime.UtcNow;
            await db.DesignArtifactRuns.UpdateOneAsync(
                item => item.Id == authoritativeRun.Id
                        && item.Status == RunStatuses.Done
                        && item.ArtifactType == DesignArtifactTypes.WebPage
                        && item.Operation == DesignArtifactOperations.Generate
                        && item.ArtifactSiteId == authoritativeRun.ArtifactSiteId
                        && item.CompletedAt == authoritativeRun.CompletedAt
                        && item.PublishedActivityProjectionCompletedAt == null,
                Builders<DesignArtifactRun>.Update
                    .Set(item => item.PublishedActivityProjectionCompletedAt, skippedAt)
                    .Set(item => item.PublishedActivityProjectionOutcome, "skipped")
                    .Set(item => item.PublishedActivityProjectionCode, "site_missing_or_mismatch"),
                cancellationToken: CancellationToken.None);
            run.PublishedActivityProjectionCompletedAt = skippedAt;
            run.PublishedActivityProjectionOutcome = "skipped";
            run.PublishedActivityProjectionCode = "site_missing_or_mismatch";
            return false;
        }

        var inserted = await activityRecorder.RecordDomainAsync(
            ActivityActionRegistry.GeneratedSitePublished,
            authoritativeRun.UserId,
            site.Id,
            site.Title,
            BuildGeneratedSitePublicationDeduplicationKey(authoritativeRun.Id),
            authoritativeRun.CompletedAt!.Value,
            ct);
        var recordedAt = DateTime.UtcNow;
        await db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == authoritativeRun.Id
                    && item.Status == RunStatuses.Done
                    && item.ArtifactType == DesignArtifactTypes.WebPage
                    && item.Operation == DesignArtifactOperations.Generate
                    && item.ArtifactSiteId == site.Id
                    && item.CompletedAt == authoritativeRun.CompletedAt
                    && item.PublishedActivityProjectionCompletedAt == null,
            Builders<DesignArtifactRun>.Update
                .Set(item => item.PublishedActivityRecordedAt, recordedAt)
                .Set(item => item.PublishedActivityProjectionCompletedAt, recordedAt)
                .Set(item => item.PublishedActivityProjectionOutcome, "recorded")
                .Set(item => item.PublishedActivityProjectionCode, null),
            cancellationToken: CancellationToken.None);
        run.PublishedActivityRecordedAt = recordedAt;
        run.PublishedActivityProjectionCompletedAt = recordedAt;
        run.PublishedActivityProjectionOutcome = "recorded";
        run.PublishedActivityProjectionCode = null;
        return inserted;
    }

    internal static async Task<int> RecoverGeneratedSitePublicationActivitiesAsync(
        MongoDbContext db,
        IActivityActionRecorder activityRecorder,
        CancellationToken ct)
    {
        var filter = Builders<DesignArtifactRun>.Filter.Eq(run => run.Status, RunStatuses.Done)
                     & Builders<DesignArtifactRun>.Filter.Eq(run => run.ArtifactType, DesignArtifactTypes.WebPage)
                     & Builders<DesignArtifactRun>.Filter.Eq(run => run.Operation, DesignArtifactOperations.Generate)
                     & Builders<DesignArtifactRun>.Filter.Type(
                         run => run.ArtifactSiteId,
                         MongoDB.Bson.BsonType.String)
                     & Builders<DesignArtifactRun>.Filter.Type(
                         run => run.CompletedAt,
                         MongoDB.Bson.BsonType.DateTime);
        var inserted = 0;
        const int batchSize = 100;
        const int maxBatches = 10;
        var attemptedIds = new List<string>();
        Exception? firstRetryableError = null;
        for (var batch = 0; batch < maxBatches; batch++)
        {
            var pageFilter = filter & Builders<DesignArtifactRun>.Filter.Eq(
                run => run.PublishedActivityProjectionCompletedAt,
                null);
            if (attemptedIds.Count > 0)
                pageFilter &= Builders<DesignArtifactRun>.Filter.Nin(run => run.Id, attemptedIds);
            var candidates = await db.DesignArtifactRuns
                .Find(pageFilter)
                .SortByDescending(run => run.CompletedAt)
                .Limit(batchSize)
                .ToListAsync(ct);
            if (candidates.Count == 0) break;
            foreach (var candidate in candidates)
            {
                attemptedIds.Add(candidate.Id);
                try
                {
                    if (await RecordGeneratedSitePublicationAsync(
                            db,
                            activityRecorder,
                            candidate,
                            CancellationToken.None))
                        inserted++;
                }
                catch (Exception ex)
                {
                    firstRetryableError ??= ex;
                }
            }
            if (candidates.Count < batchSize) break;
        }
        if (firstRetryableError != null)
            throw new InvalidOperationException("生成站点发布动态仍有待重试项", firstRetryableError);
        return inserted;
    }

    internal static string BuildGeneratedSitePublicationDeduplicationKey(string runId) =>
        $"design-artifact:{runId}:site-published";

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
                        .Set(x => x.CleanupPublishAttemptId, null)
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
