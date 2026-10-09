using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[CollectionDefinition("Design deployment environment", DisableParallelization = true)]
public sealed class DesignDeploymentEnvironmentCollection;

/// <summary>只在显式 loopback 独立 Mongo 上写随机合成库，不读取应用连接或调用模型。</summary>
[Collection("Design deployment environment")]
public sealed class DesignArtifactDeploymentIsolationTests : IAsyncLifetime
{
    private const string CurrentScope = "project-a::branch-a::revision::revision-a";
    private readonly Dictionary<string, string?> _previousEnvironment = new();
    private MongoDbContext _db = null!;
    private LlmGatewayDataContext _gateway = null!;
    private readonly InMemoryRunEventStore _events = new();
    private readonly InMemoryRunQueue _queue = new();
    private string _databaseName = "";
    private string _connection = "";
    private static DateTime Now => new(DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);

    public async Task InitializeAsync()
    {
        _connection = Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION") ?? "";
        var url = new MongoUrl(_connection);
        Assert.Single(url.Servers);
        Assert.Equal("127.0.0.1", url.Server.Host);
        Assert.Equal(27389, url.Server.Port);
        Assert.Null(url.Username);
        _databaseName = $"design_scope_synthetic_{Guid.NewGuid():N}";
        _db = new MongoDbContext(_connection, _databaseName);
        _gateway = new LlmGatewayDataContext(_connection, _databaseName);
        Assert.Empty(await (await _db.Database.ListCollectionNamesAsync()).ToListAsync());
        foreach (var (name, value) in new[] { ("CDS_PROJECT_ID", "project-a"), ("VITE_GIT_BRANCH", "branch-a"), ("GIT_COMMIT", "revision-a") })
        {
            _previousEnvironment[name] = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }
        Assert.Equal(CurrentScope, DeploymentScope.Current);
    }

    [DesignScopeMongoFact]
    public async Task NewCollection_IsInvisibleToLegacyWorkers_AndDoesNotStampDeserializedHistory()
    {
        Assert.Equal("design_artifact_runs_v2", _db.DesignArtifactRuns.CollectionNamespace.CollectionName);
        var run = Run("new-run", RunStatuses.Queued);
        await InsertAsync(run, CurrentScope);
        Assert.Empty(await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs")
            .Find(item => item.Status == RunStatuses.Queued).ToListAsync());
        var old = new BsonDocument { { "_id", "legacy-missing-scope" }, { "UserId", "owner" } };
        var read = MongoDB.Bson.Serialization.BsonSerializer.Deserialize<DesignArtifactRun>(old).ToBsonDocument();
        Assert.True(!read.TryGetValue("DeploymentSlug", out var scope) || scope.IsBsonNull);
    }

    [DesignScopeMongoTheory]
    [InlineData("project-b::branch-a::revision::revision-a")]
    [InlineData("project-a::branch-b::revision::revision-a")]
    [InlineData("project-a::branch-a::revision::revision-b")]
    [InlineData(null)]
    public async Task ClaimAndLeaseWrites_RejectForeignDeployment(string? otherScope)
    {
        var now = Now;
        var queued = Run("foreign-queued", RunStatuses.Queued);
        await InsertAsync(queued, otherScope);
        Assert.Null(await HostedSiteEditRunWorker.TryClaimAsync(_db, queued.Id, "worker", now, TimeSpan.FromMinutes(2), default));

        var active = Run("foreign-active", RunStatuses.Running);
        active.LeaseOwnerId = "worker";
        active.LeaseExpiresAt = now.AddMinutes(2);
        await InsertAsync(active, otherScope);
        Assert.False(await HostedSiteEditRunWorker.RenewLeaseAsync(_db, active.Id, "worker", now, TimeSpan.FromMinutes(2), default));
        Assert.False(await HostedSiteEditRunWorker.PersistPhaseAsync(_db, active.Id, "worker", 50, "异部署不得写入", now, default));
        Assert.False(await HostedSiteEditRunWorker.BeginCommitAsync(_db, active.Id, "worker", now, TimeSpan.FromMinutes(2), default));

        active.Id = "foreign-committing";
        active.Status = RunStatuses.Committing;
        await InsertAsync(active, otherScope);
        Assert.False(await HostedSiteEditRunWorker.CompleteRunAsync(_db, active.Id, "worker", "site", "revision", "完成", now, default));

        var owned = Run("owned-queued", RunStatuses.Queued);
        await InsertAsync(owned, CurrentScope);
        Assert.NotNull(await HostedSiteEditRunWorker.TryClaimAsync(_db, owned.Id, "worker", now, TimeSpan.FromMinutes(2), default));
        Assert.True(await HostedSiteEditRunWorker.RenewLeaseAsync(_db, owned.Id, "worker", now, TimeSpan.FromMinutes(2), default));
    }

    // 同项目同分支、另一个 revision 的「运行中且租约早已到期」任务不再属于「异部署、不许碰」：
    // 那正是分支重新部署后留下的孤儿（#135），由 RetiredRevision_* 用例单独约束。
    // 这里只保留真正的异部署——别的项目、别的分支——它们无论租约如何都原样不动。
    [DesignScopeMongoTheory]
    [InlineData("project-b::branch-a::revision::revision-a")]
    [InlineData("project-a::branch-b::revision::revision-a")]
    [InlineData("project-a::branch-b")]
    [InlineData("project-b::branch-a")]
    public async Task Recovery_RequeuesOnlyOwnedRuns_AndLeavesForeignExecutionAndCleanupUnchanged(string otherScope)
    {
        var now = Now;
        foreach (var scope in new[] { CurrentScope, otherScope })
        {
            var prefix = scope == CurrentScope ? "owned" : "foreign";
            await InsertAsync(Run($"{prefix}-queued", RunStatuses.Queued), scope);
            var active = Run($"{prefix}-active", RunStatuses.Running);
            active.LeaseOwnerId = "retired-worker";
            active.LeaseExpiresAt = now.AddMinutes(-1);
            await InsertAsync(active, scope);
            var rejected = Run($"{prefix}-rejected", RunStatuses.Error);
            rejected.WorkspaceRejectedResultAssetKey = $"{prefix}-object";
            await InsertAsync(rejected, scope);
        }
        var before = await Raw("foreign-active");
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(item => item.DeleteByKeyAsync("owned-object", CancellationToken.None)).Returns(Task.CompletedTask);
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, now, default, workspaceStorage: storage.Object);
        Assert.Equal("owned-queued", await _queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Null(await _queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal(before, await Raw("foreign-active"));
        Assert.Equal(RunStatuses.Error, (await Read("owned-active")).Status);
        Assert.Equal("foreign-object", (await Read("foreign-rejected")).WorkspaceRejectedResultAssetKey);
        Assert.Null((await Read("owned-rejected")).WorkspaceRejectedResultAssetKey);
        storage.Verify(item => item.DeleteByKeyAsync("owned-object", CancellationToken.None), Times.Once);
        storage.VerifyNoOtherCalls();
    }

    // ───────────── 分支重新部署后上一版留下的孤儿任务（#135） ─────────────

    private const string RetiredScope = "project-a::branch-a::revision::revision-retired";

    /// <summary>上一版 revision 的执行方已经退出：租约早已到期、没人续租、结果也没落定。</summary>
    private static DesignArtifactRun OrphanedGeneration(string id, bool publicLifecycle = false)
    {
        var run = Run(id, RunStatuses.Running);
        run.ArtifactType = DesignArtifactTypes.WebPage;
        run.Operation = DesignArtifactOperations.Generate;
        run.Runtime = DesignArtifactRuntimes.OpenDesign;
        run.LeaseOwnerId = "retired-worker:lease";
        run.LeaseExpiresAt = Now.AddMinutes(-3);
        run.Progress = 40;
        run.Phase = "正在生成页面";
        if (publicLifecycle)
        {
            run.ContractVersion = DesignArtifactContractVersions.Current;
            run.LifecycleVersion = 3;
        }
        return run;
    }

    [DesignScopeMongoTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RetiredRevision_OrphanedRun_IsSettledAsFailedWithTheRedeployReason(bool publicLifecycle)
    {
        var orphan = OrphanedGeneration("orphan-running", publicLifecycle);
        await InsertAsync(orphan, RetiredScope);
        var adapter = new Mock<IWebPageDesignArtifactLifecycleAdapter>(MockBehavior.Strict);
        adapter.Setup(item => item.FailAsync(
                orphan.Id,
                WebPageDesignArtifactLifecycleAdapter.InterruptedFailureCode,
                It.Is<DesignArtifactLifecycleLeaseAuthority>(lease => lease.Recovery
                                                                      && lease.LeaseOwnerId == orphan.LeaseOwnerId),
                CancellationToken.None))
            // 真实 adapter 在这一步把公共生命周期推进到 error；桩只做同一件状态写入。
            .Returns(() => _db.DesignArtifactRuns.UpdateOneAsync(
                item => item.Id == orphan.Id,
                Builders<DesignArtifactRun>.Update.Set(item => item.Status, RunStatuses.Error)));

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            _db, _queue, _events, Now, default, publicLifecycle: adapter.Object, lifecycle: Lifecycle());

        var settled = await Read(orphan.Id);
        Assert.Equal(RunStatuses.Error, settled.Status);
        Assert.Equal(HostedSiteEditRunWorker.RedeployInterruptedMessage, settled.Error);
        Assert.Equal(HostedSiteEditRunWorker.RedeployInterruptedMessage, settled.Phase);
        Assert.Null(settled.LeaseExpiresAt);
        // 接管之后归本 revision 管：此后的读写、恢复都按本部署作用域走。
        Assert.Equal(CurrentScope, settled.DeploymentSlug);
        Assert.Equal(publicLifecycle ? 1 : 0, adapter.Invocations.Count);
        var terminal = (await _events.GetEventsAsync(RunKinds.DesignArtifact, orphan.Id, 0, 100)).Last();
        Assert.Equal("error", terminal.EventName);
        Assert.Contains("分支重新部署", terminal.PayloadJson);

        // 查询接口与任务记录同口径：它现在说「失败」，不再说「在跑」。
        var read = Assert.IsType<OkObjectResult>(await GenerationController().GetRun(orphan.Id));
        Assert.Contains(RunStatuses.Error, System.Text.Json.JsonSerializer.Serialize(read.Value));
    }

    [DesignScopeMongoTheory]
    [InlineData("lease-still-held")]
    [InlineData("lease-just-lapsed")]
    public async Task RetiredRevision_RunStillWithinItsLeaseOrGrace_IsLeftToItsOwnWorker(string shape)
    {
        // 滚动部署时上一版容器可能还活着并在续租；刚到期的也给它一段余量，不抢在它自己收尾之前。
        var run = OrphanedGeneration(shape);
        run.LeaseExpiresAt = shape == "lease-still-held"
            ? Now.AddMinutes(1)
            : Now - HostedSiteEditRunWorker.RetiredRevisionAdoptionGrace + TimeSpan.FromSeconds(5);
        await InsertAsync(run, RetiredScope);
        var before = await Raw(run.Id);

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, Now, default);

        Assert.Equal(before, await Raw(run.Id));
    }

    [DesignScopeMongoTheory]
    [InlineData("workspace-result-committed")]
    [InlineData("workspace-result-writing")]
    [InlineData("revision-already-written")]
    [InlineData("committing")]
    [InlineData("queued")]
    public async Task RetiredRevision_RunWhoseResultHasLanded_IsNeverMisjudgedAsFailed(string shape)
    {
        // 「结果已落定却没交付」另有台账（doc/debt.platform.open-design.md），本修复只收「执行方丢了任务」这一类。
        var run = OrphanedGeneration(shape);
        switch (shape)
        {
            case "workspace-result-committed":
                run.WorkspaceResultAssetKey = "web-hosting/results/committed.zip";
                break;
            case "workspace-result-writing":
                run.WorkspacePendingResultAssetKey = "web-hosting/results/writing.zip";
                break;
            case "revision-already-written":
                await _db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
                {
                    Id = "landed-revision", SiteId = "landed-site", SourceRunId = run.Id,
                });
                break;
            case "committing":
                run.Status = RunStatuses.Committing;
                break;
            case "queued":
                run.Status = RunStatuses.Queued;
                run.LeaseOwnerId = null;
                run.LeaseExpiresAt = null;
                break;
        }
        await InsertAsync(run, RetiredScope);
        var before = await Raw(run.Id);

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, Now, default);

        // 已写成托管版本的只多一个「不予接管」的记号，其余字段逐字不变。
        var after = await Raw(run.Id);
        const string skipped = nameof(DesignArtifactRun.RetiredRevisionSkippedAt);
        if (shape == "revision-already-written")
        {
            Assert.False(after[skipped].IsBsonNull);
            after[skipped] = BsonNull.Value;
        }
        Assert.Equal(before, after);
    }

    [DesignScopeMongoTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RetiredRevision_StopOnAnOrphanedRun_SettlesItInsteadOfAnsweringNotFound(bool publicLifecycle)
    {
        var orphan = OrphanedGeneration("orphan-stop", publicLifecycle);
        await InsertAsync(orphan, RetiredScope);

        var result = await ProductionWiredGenerationController().CancelRun(orphan.Id);

        var ok = Assert.IsType<OkObjectResult>(result);
        Assert.Contains(RunStatuses.Cancelled, System.Text.Json.JsonSerializer.Serialize(ok.Value));
        var settled = await Read(orphan.Id);
        Assert.Equal(RunStatuses.Cancelled, settled.Status);
        Assert.NotNull(settled.CancelledAt);
        Assert.Equal(CurrentScope, settled.DeploymentSlug);
        Assert.Equal("cancelled", (await _events.GetEventsAsync(RunKinds.DesignArtifact, orphan.Id, 0, 100)).Last().EventName);
    }

    [DesignScopeMongoFact]
    public async Task RetiredRevision_StopOnAnOrphanedEditRun_IsAcceptedAndSettledInsteadOfNotFound()
    {
        // 修改面板的停止走同一个协调器：同一类孤儿不许一边回 404、一边查询说在跑。
        var orphan = OrphanedGeneration("orphan-edit-stop");
        orphan.Operation = DesignArtifactOperations.Edit;
        orphan.TargetSiteId = "site";
        orphan.SourceSurface = DesignArtifactSourceSurfaces.WebHosting;
        await InsertAsync(orphan, RetiredScope);

        Assert.IsType<OkObjectResult>(await EditController().CancelRun("site", orphan.Id));
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, Now, default);

        var settled = await Read(orphan.Id);
        Assert.Equal(RunStatuses.Cancelled, settled.Status);
        Assert.Equal(CurrentScope, settled.DeploymentSlug);
    }

    [DesignScopeMongoFact]
    public async Task RetiredRevision_StopRecordedBeforeTheLeaseLapsed_IsSettledByRecovery()
    {
        // 停止意图登记在前、执行方随后退出：恢复器接管后按「已取消」收尾，而不是记成失败。
        var orphan = OrphanedGeneration("orphan-stop-then-recover");
        orphan.CancelRequestedAt = Now.AddMinutes(-2);
        orphan.CancelRequestedByUserId = "owner";
        await InsertAsync(orphan, RetiredScope);

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, Now, default);

        Assert.Equal(RunStatuses.Cancelled, (await Read(orphan.Id)).Status);
    }

    [DesignScopeMongoTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RetiredRevision_StopOnAnOrphanedRunWithoutALease_SettlesAtOnce(bool publicLifecycle)
    {
        // 判据接纳「没有租约、很久没更新」的旧任务；接管后停止必须当场收敛，不能因为缺租约干等下一轮。
        var orphan = OrphanedGeneration("orphan-stop-no-lease", publicLifecycle);
        orphan.LeaseOwnerId = null;
        orphan.LeaseExpiresAt = null;
        await InsertAsync(orphan, RetiredScope);

        var ok = Assert.IsType<OkObjectResult>(await ProductionWiredGenerationController().CancelRun(orphan.Id));

        Assert.Contains(RunStatuses.Cancelled, System.Text.Json.JsonSerializer.Serialize(ok.Value));
        var settled = await Read(orphan.Id);
        Assert.Equal(RunStatuses.Cancelled, settled.Status);
        Assert.Equal(CurrentScope, settled.DeploymentSlug);
    }

    [DesignScopeMongoFact]
    public async Task RetiredRevision_AdoptedInOnePassAndSettledInALaterOne_KeepsTheRedeployReason()
    {
        // 接管与终结可能不在同一轮（例如本轮待终结的任务超过批量上限）：原因记在任务上，不随那一轮的内存状态丢失。
        var orphan = OrphanedGeneration("orphan-adopted-earlier");
        await InsertAsync(orphan, RetiredScope);
        Assert.NotNull(await HostedSiteEditRunWorker.TryAdoptRetiredRevisionRunAsync(_db, await Read(orphan.Id), Now, default));

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, Now, default);

        var settled = await Read(orphan.Id);
        Assert.Equal(RunStatuses.Error, settled.Status);
        Assert.Equal(HostedSiteEditRunWorker.RedeployInterruptedMessage, settled.Error);
    }

    [DesignScopeMongoFact]
    public async Task RetiredRevision_StopThatLosesTheAdoptionRace_StillStopsTheRunNowOwnedHere()
    {
        // 停止接口读到上一版那份之后、接管之前，恢复器抢先把它接管到了本版本：
        // 停止不能拿过期的那份判成「其他部署」，而要照常停下本版本名下的它。
        var orphan = OrphanedGeneration("orphan-adopted-concurrently");
        await InsertAsync(orphan, RetiredScope);
        Assert.NotNull(await HostedSiteEditRunWorker.TryAdoptRetiredRevisionRunAsync(_db, await Read(orphan.Id), Now, default));

        var resolved = await new DesignArtifactCancellationCoordinator(_db, Lifecycle(), _events)
            .AdoptFromRetiredRevisionOrExplainAsync(orphan.Id, "owner", default);

        Assert.NotNull(resolved);
        Assert.Equal(CurrentScope, resolved!.DeploymentSlug);
    }

    [DesignScopeMongoFact]
    public async Task RetiredRevision_LandedRowsBeyondTheBatch_DoNotStarveAGenuineOrphan()
    {
        // 结果已写成托管版本的旧任务不会被接管；它们再多也不能占满批次，让排在后面的真孤儿永远轮不到。
        for (var i = 0; i < 101; i++)
        {
            var landed = OrphanedGeneration($"landed-{i:D3}");
            await InsertAsync(landed, RetiredScope);
            await _db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
            {
                Id = $"landed-revision-{i:D3}", SiteId = "landed-site", SourceRunId = landed.Id,
            });
        }
        var orphan = OrphanedGeneration("zz-genuine-orphan");
        await InsertAsync(orphan, RetiredScope);

        // 每轮只读有限的一批；已落定的被记下后不再被选中，真孤儿在有限轮数内一定轮得到。
        for (var pass = 0; pass < 3; pass++)
            await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(_db, _queue, _events, Now, default);

        var settled = await Read(orphan.Id);
        Assert.Equal(RunStatuses.Error, settled.Status);
        Assert.Equal(HostedSiteEditRunWorker.RedeployInterruptedMessage, settled.Error);
        foreach (var id in new[] { "landed-000", "landed-100" })
        {
            var landed = await Read(id);
            Assert.Equal(RetiredScope, landed.DeploymentSlug);
            Assert.Equal(RunStatuses.Running, landed.Status);
            Assert.NotNull(landed.RetiredRevisionSkippedAt);
        }
    }

    [DesignScopeMongoTheory]
    [InlineData(RetiredScope, DesignArtifactCancellationUnavailableException.RetiredRevisionCode)]
    [InlineData("project-a::branch-b::revision::revision-a", DesignArtifactCancellationUnavailableException.OtherDeploymentCode)]
    [InlineData("project-b::branch-a::revision::revision-a", DesignArtifactCancellationUnavailableException.OtherDeploymentCode)]
    public async Task StopOnARunThisRevisionCannotTouch_ExplainsWhyInsteadOfAnsweringNotFound(string scope, string code)
    {
        var run = OrphanedGeneration("not-mine-to-stop");
        run.LeaseExpiresAt = Now.AddMinutes(1);
        await InsertAsync(run, scope);
        var before = await Raw(run.Id);
        var controller = ProductionWiredGenerationController();

        // 查询看得到它……
        Assert.IsType<OkObjectResult>(await controller.GetRun(run.Id));
        // ……停止就不许说「不存在」。
        var conflict = Assert.IsType<ConflictObjectResult>(await controller.CancelRun(run.Id));
        Assert.Contains(code, System.Text.Json.JsonSerializer.Serialize(conflict.Value));
        Assert.Equal(before, await Raw(run.Id));
    }

    [DesignScopeMongoFact]
    public async Task LegacyHistory_RemainsReadableThroughAllPublicReads_ButCannotCancelOrAdvanceLifecycle()
    {
        var legacy = _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs");
        var done = Run("legacy-done", RunStatuses.Error);
        done.ContractVersion = DesignArtifactContractVersions.Current;
        done.LifecycleEvents = [new() { RunId = done.Id, Sequence = 1, Type = "error", Authoritative = true }];
        done.CompletedAt = Now;
        await legacy.InsertOneAsync(done);
        var queued = Run("legacy-queued", RunStatuses.Queued);
        queued.ContractVersion = DesignArtifactContractVersions.Current;
        await legacy.InsertOneAsync(queued);
        var before = await legacy.Find(item => item.Id == queued.Id).FirstAsync();
        var generation = GenerationController();
        Assert.IsType<OkObjectResult>(await generation.GetRun(done.Id));
        Assert.IsType<OkObjectResult>(await generation.GetContract(done.Id));
        Assert.IsType<OkObjectResult>(await generation.GetContractEvents(done.Id));
        Assert.IsType<OkObjectResult>(await generation.GetEvidence(done.Id));
        await generation.StreamRun(done.Id);
        Assert.Contains("event: error", await ReadResponse(generation));
        Assert.IsType<NotFoundObjectResult>(await generation.CancelRun(queued.Id));
        Assert.Null(await new DesignArtifactCancellationCoordinator(_db, Lifecycle()).RequestAsync(queued.Id, "owner"));
        var exception = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() => Lifecycle().AppendEventAsync(
            new AppendDesignArtifactEventRequest(queued.Id, "owner", DesignArtifactLifecycleEventTypes.Phase, "不应写入", 1)));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.NotFound, exception.Code);
        Assert.Equal(before.ToBsonDocument(), (await legacy.Find(item => item.Id == queued.Id).FirstAsync()).ToBsonDocument());

        done.Id = "legacy-edit-done";
        done.Operation = DesignArtifactOperations.Edit;
        done.TargetSiteId = "site";
        await legacy.InsertOneAsync(done);
        queued.Id = "legacy-edit-queued";
        queued.Operation = DesignArtifactOperations.Edit;
        queued.TargetSiteId = "site";
        await legacy.InsertOneAsync(queued);
        var edit = EditController();
        Assert.IsType<OkObjectResult>(await edit.GetRun("site", done.Id));
        await edit.StreamRun("site", done.Id);
        Assert.Contains("event: error", await ReadResponse(edit));
        Assert.IsType<NotFoundObjectResult>(await edit.CancelRun("site", queued.Id));
    }

    [DesignScopeMongoTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SharedWorkspaceObject_ReferencedByForeignOrLegacyHistory_IsNeverDeleted(bool legacyReference)
    {
        var pending = Run("pending", RunStatuses.Error);
        pending.WorkspacePendingResultAssetKey = "shared-object";
        pending.WorkspacePendingResultAttemptId = "attempt";
        pending.WorkspacePendingResultWriteState = DesignWorkspaceResultWriteStates.Stored;
        await InsertAsync(pending, CurrentScope);
        var winner = Run("winner", RunStatuses.Done);
        winner.WorkspaceResultAssetKey = "shared-object";
        if (legacyReference)
            await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs").InsertOneAsync(winner);
        else
            await InsertAsync(winner, "project-b::branch-a::revision::revision-a");
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        Assert.True(await DesignArtifactWorkspaceBroker.RecoverPendingWorkspaceResultAsync(_db, storage.Object, pending, Now, default));
        Assert.Null((await Read(pending.Id)).WorkspacePendingResultAssetKey);
        storage.VerifyNoOtherCalls();
    }

    [DesignScopeMongoFact]
    public async Task AllThreeCreationEntrypoints_FreezeCurrentScopeInTheNewCollection()
    {
        var provider = new Mock<IDesignArtifactProviderCatalog>();
        provider.Setup(item => item.FindAsync("owner", DesignArtifactRuntimes.MapGateway, CancellationToken.None))
            .ReturnsAsync(new DesignArtifactProviderCapability(
                DesignArtifactRuntimes.MapGateway, "测试执行器", DesignArtifactAdapterKinds.RemoteAgent,
                DesignArtifactExecutionOwners.CdsRemoteAgent, DesignArtifactIsolationModes.SessionContainer,
                [DesignArtifactTypes.WebPage], [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit],
                [DesignArtifactSourceSurfaces.WebHosting], true, true, true, null));
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>();
        knowledge.Setup(item => item.ResolveForRunAsync("owner", It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(), CancellationToken.None))
            .ReturnsAsync(new List<DesignKnowledgeSnapshot> { new() { EntryId = "entry", StoreId = "store", ContentHash = new string('a', 64) } });
        var generation = WithUser(new DesignArtifactsController(
            _db, _events, _queue, provider.Object, knowledge.Object, _gateway,
            new DesignArtifactCancellationCoordinator(_db, Lifecycle()), new ConfigurationBuilder().Build(), Mock.Of<IHostedSiteService>()));
        Assert.IsType<AcceptedResult>(await generation.CreateRun(new CreateDesignArtifactRunRequest {
            ArtifactType = DesignArtifactTypes.WebPage, Instruction = "生成测试网页",
            KnowledgeReferences = [new() { EntryId = "entry", StoreId = "store" }] }));
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(item => item.GetEditableEntryHtmlAsync("site", "owner", CancellationToken.None))
            .ReturnsAsync(new HostedSiteEditableEntry(new HostedSite { Id = "site", OwnerUserId = "owner",
                Files = [new() { Path = "index.html", CosKey = "site/index.html", MimeType = "text/html" }] },
                "<!doctype html><html><body>测试</body></html>", Now));
        var edit = WithUser(new HostedSiteEditsController(sites.Object, Mock.Of<IHostedSiteRevisionService>(),
            _events, _queue, _db, NullLogger<HostedSiteEditsController>.Instance, provider.Object, knowledge.Object,
            Mock.Of<IWebPageDesignArtifactLifecycleAdapter>(), new DesignArtifactCancellationCoordinator(_db, Lifecycle()),
            new ConfigurationBuilder().Build()));
        Assert.IsType<AcceptedResult>(await edit.CreateRun("site", new CreateHostedSiteEditRunRequest { Instruction = "修改测试网页" }));
        await Lifecycle().CreateSessionAsync(new CreateDesignArtifactSessionRequest(
            "lifecycle-created", "owner", DesignArtifactTypes.HtmlPpt, DesignArtifactOperations.Generate,
            DesignArtifactSourceSurfaces.HtmlPpt, DesignArtifactRuntimes.HtmlPptPipeline,
            new DesignArtifactWorkspaceRef { WorkspaceId = "workspace", Kind = DesignArtifactWorkspaceKinds.AdapterOwned,
                BaseRevision = "base", Adapter = "html-ppt" },
            new DesignArtifactVersionBoundary { BaseContentHash = new string('b', 64) },
            new DesignArtifactCapabilitySnapshot {
                CapabilityId = "html-ppt.v1", ArtifactType = DesignArtifactTypes.HtmlPpt,
                Runtime = DesignArtifactRuntimes.HtmlPptPipeline, Adapter = "html-ppt",
                WorkspaceKind = DesignArtifactWorkspaceKinds.AdapterOwned,
                SecurityProfile = DesignArtifactSecurityProfiles.HtmlPptInteractive,
                Operations = [DesignArtifactOperations.Generate], SourceSurfaces = [DesignArtifactSourceSurfaces.HtmlPpt] }));
        var runs = await _db.DesignArtifactRuns.Find(FilterDefinition<DesignArtifactRun>.Empty).ToListAsync();
        Assert.Equal(3, runs.Count);
        Assert.All(runs, run => Assert.Equal(CurrentScope, run.DeploymentSlug));
        Assert.Empty(await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs")
            .Find(FilterDefinition<DesignArtifactRun>.Empty).ToListAsync());
    }

    [DesignScopeMongoTheory]
    [InlineData("legacy")]
    [InlineData("foreign")]
    [InlineData("orphan")]
    public async Task HtmlPptRecovery_DoesNotRewriteForeignLegacyOrUnownedSourceRuns(string origin)
    {
        var source = new MdToPptRun {
            Id = "ppt-source", UserId = "owner", Status = "running", Op = "convert",
            Runtime = DesignArtifactRuntimes.HtmlPptPipeline, Provider = "open-design-html-ppt",
            ArtifactContractVersion = DesignArtifactContractVersions.Current, Title = "测试",
            SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt, UpdatedAt = Now.AddMinutes(-30) };
        await _db.MdToPptRuns.InsertOneAsync(source);
        var original = source.ToBsonDocument();
        if (origin != "orphan")
        {
            var ledger = Run(source.Id, RunStatuses.Running);
            ledger.ArtifactType = DesignArtifactTypes.HtmlPpt;
            ledger.Runtime = DesignArtifactRuntimes.HtmlPptPipeline;
            ledger.SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt;
            ledger.ContractVersion = DesignArtifactContractVersions.Current;
            if (origin == "legacy")
                await _db.Database.GetCollection<DesignArtifactRun>("design_artifact_runs").InsertOneAsync(ledger);
            else
                await InsertAsync(ledger, "project-a::branch-a::revision::retired");
        }
        var adapter = new HtmlPptDesignArtifactAdapter(_db, Lifecycle(), NullLogger<HtmlPptDesignArtifactAdapter>.Instance);
        Assert.Equal(0, await adapter.RecoverPendingAsync());
        Assert.Equal(original, (await _db.MdToPptRuns.Find(item => item.Id == source.Id).FirstAsync()).ToBsonDocument());
        Assert.False(await _db.DesignArtifactRuns.Find(item => item.Id == source.Id && item.DeploymentSlug == CurrentScope).AnyAsync());
        if (origin != "orphan")
            await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() => adapter.BeginAsync(source));
        Assert.False(await _db.DesignArtifactRuns.Find(item => item.Id == source.Id && item.DeploymentSlug == CurrentScope).AnyAsync());
    }

    [DesignScopeMongoFact]
    public async Task HtmlPptRecovery_FiltersForeignAndOrphanBacklogBeforeLimit()
    {
        var adapter = new HtmlPptDesignArtifactAdapter(_db, Lifecycle(), NullLogger<HtmlPptDesignArtifactAdapter>.Instance);
        foreach (var id in new[] { "foreign-oldest", "orphan-next", "owned-latest" })
        {
            var source = new MdToPptRun {
                Id = id, UserId = "owner", Status = "error", Op = "convert",
                Runtime = DesignArtifactRuntimes.HtmlPptPipeline, Provider = "open-design-html-ppt",
                ArtifactContractVersion = DesignArtifactContractVersions.Current, Title = "测试",
                SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt,
                UpdatedAt = Now.AddMinutes(id == "owned-latest" ? -20 : -40) };
            await _db.MdToPptRuns.InsertOneAsync(source);
            if (id == "foreign-oldest")
                await InsertAsync(Run(id, RunStatuses.Running), "project-b::branch-a::revision::revision-a");
            if (id == "owned-latest") await adapter.BeginAsync(source);
        }
        var before = await _db.MdToPptRuns.Find(item => item.Id != "owned-latest").SortBy(item => item.Id).ToListAsync();
        Assert.Equal(1, await adapter.RecoverPendingAsync(limit: 1));
        Assert.NotNull((await _db.MdToPptRuns.Find(item => item.Id == "owned-latest").FirstAsync()).ArtifactContractSynchronizedAt);
        var after = await _db.MdToPptRuns.Find(item => item.Id != "owned-latest").SortBy(item => item.Id).ToListAsync();
        Assert.Equal(before.Select(item => item.ToBsonDocument()), after.Select(item => item.ToBsonDocument()));
    }

    private DesignArtifactLifecycleService Lifecycle() => new(_db, _events);
    private DesignArtifactsController GenerationController() => WithUser(new DesignArtifactsController(
        _db, _events, _queue, Mock.Of<IDesignArtifactProviderCatalog>(), Mock.Of<IDesignKnowledgeSnapshotResolver>(),
        _gateway, new DesignArtifactCancellationCoordinator(_db, Lifecycle()), new ConfigurationBuilder().Build(), Mock.Of<IHostedSiteService>()));
    /// <summary>与生产 DI 相同的装配：取消协调器拿得到事件存储，执行方已不在时就地收敛。</summary>
    private DesignArtifactsController ProductionWiredGenerationController() => WithUser(new DesignArtifactsController(
        _db, _events, _queue, Mock.Of<IDesignArtifactProviderCatalog>(), Mock.Of<IDesignKnowledgeSnapshotResolver>(),
        _gateway, new DesignArtifactCancellationCoordinator(_db, Lifecycle(), _events), new ConfigurationBuilder().Build(), Mock.Of<IHostedSiteService>()));
    private HostedSiteEditsController EditController() => WithUser(new HostedSiteEditsController(
        Mock.Of<IHostedSiteService>(), Mock.Of<IHostedSiteRevisionService>(), _events, _queue, _db,
        NullLogger<HostedSiteEditsController>.Instance, Mock.Of<IDesignArtifactProviderCatalog>(),
        Mock.Of<IDesignKnowledgeSnapshotResolver>(), Mock.Of<IWebPageDesignArtifactLifecycleAdapter>(),
        new DesignArtifactCancellationCoordinator(_db, Lifecycle()), new ConfigurationBuilder().Build()));
    private static T WithUser<T>(T controller) where T : ControllerBase
    {
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
            User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "owner")], "test")) } };
        controller.Response.Body = new MemoryStream();
        return controller;
    }
    private static async Task<string> ReadResponse(ControllerBase controller)
    {
        controller.Response.Body.Position = 0;
        return await new StreamReader(controller.Response.Body, leaveOpen: true).ReadToEndAsync();
    }
    /// <summary>
    /// 上传已确认、随后那次「写完了」的状态落盘失败时，预约不该被永久钉在本代进程上
    /// （Codex P2，2026-09-15）。
    ///
    /// 恢复器按设计拒收「writing + 本代进程」的预约——那是为了不去删一份可能还在上传的对象。
    /// 但上传确认返回之后状态写失败时，这条保护就把唯一能收拾残局的动作也挡掉了：租约过期
    /// 也没人收得走，对象和预约一起留到进程重启（concurrency-gate-discipline：账本要周期收敛，
    /// 不能只靠重启）。调用方手里有「这一次上传确实收工了」的事实，据此放行。
    /// </summary>
    [DesignScopeMongoTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WritingReservation_IsRecoverableWhenTheWriterKnowsItFinished(bool writerFinished)
    {
        // run 必须是「活着且握着租约」的真实形状：提交正是在这个状态下发生的。
        // 上一版用已终态的 run，绕开了活跃窗口那道闸，于是这条用例绿得毫无意义。
        var pending = Run("writing-stranded", RunStatuses.Running);
        pending.LeaseOwnerId = "worker-a";
        pending.LeaseExpiresAt = Now.AddMinutes(5);
        pending.RuntimeTicketExpiresAt = Now.AddMinutes(5);
        pending.WorkspacePendingResultAssetKey = "stranded-object";
        pending.WorkspacePendingResultAttemptId = "attempt";
        pending.WorkspacePendingResultWriteState = DesignWorkspaceResultWriteStates.Writing;
        pending.WorkspacePendingResultProcessEpoch = DesignArtifactWorkspaceBroker.CurrentProcessEpoch;
        await InsertAsync(pending, CurrentScope);

        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        if (writerFinished)
        {
            storage.Setup(item => item.ExistsAsync("stranded-object", It.IsAny<CancellationToken>())).ReturnsAsync(true);
            storage.Setup(item => item.DeleteByKeyAsync("stranded-object", It.IsAny<CancellationToken>()))
                .Returns(Task.CompletedTask);
        }

        var recovered = await DesignArtifactWorkspaceBroker.RecoverPendingWorkspaceResultAsync(
            _db, storage.Object, pending, Now, default, writerFinished: writerFinished);

        // companion：不带这个事实时保护仍然成立——否则上面那一半会把「保护被削掉」也判成通过。
        Assert.Equal(writerFinished, recovered);
        storage.VerifyAll();
        var after = await Read(pending.Id);
        Assert.Equal(writerFinished ? null : "stranded-object", after.WorkspacePendingResultAssetKey);
    }

    [DesignScopeMongoFact]
    public async Task ServedModel_IsWrittenOnlyWhenItChanges_AndOnlyOnARunningRunOfThisDeployment()
    {
        var running = Run("served-running", RunStatuses.Running);
        var foreign = Run("served-foreign", RunStatuses.Running);
        var done = Run("served-done", RunStatuses.Done);
        await InsertAsync(running, CurrentScope);
        await InsertAsync(foreign, "project-b::branch-a::revision::revision-a");
        await InsertAsync(done, CurrentScope);
        var broker = new DesignArtifactWorkspaceBroker(
            _db,
            new Mock<IAssetStorage>(MockBehavior.Strict).Object,
            new Microsoft.AspNetCore.DataProtection.EphemeralDataProtectionProvider(),
            new ConfigurationBuilder().Build(),
            Mock.Of<IDesignArtifactGatewayGrantService>());

        Assert.True(await broker.RecordServedModelAsync(running.Id, "gpt-served", null, default));
        // 同一个模型的后续调用一条都不写：这就是「每次调用最多一次、不是每个分片一次」。
        Assert.False(await broker.RecordServedModelAsync(running.Id, "gpt-served", null, default));
        Assert.True(await broker.RecordServedModelAsync(running.Id, "gpt-served-2", null, default));
        Assert.False(await broker.RecordServedModelAsync(foreign.Id, "gpt-served", null, default));
        Assert.False(await broker.RecordServedModelAsync(done.Id, "gpt-served", null, default));

        Assert.Equal("gpt-served-2", (await Read(running.Id)).ResolvedModel);
        Assert.Null((await Read(foreign.Id)).ResolvedModel);
        Assert.Null((await Read(done.Id)).ResolvedModel);
    }

    [DesignScopeMongoFact]
    public async Task RuntimeGrant_IssueAuthorizeObserveAndRevoke_UsesOneRunScopedCredential()
    {
        var run = Run("grant-lifecycle", RunStatuses.Running);
        run.Operation = DesignArtifactOperations.Generate;
        run.LlmRequestPolicy = new DesignArtifactLlmRequestPolicy { Model = "default-chat-curated" };
        await InsertAsync(run, CurrentScope);
        await _gateway.Database.GetCollection<BsonDocument>("llmgw_tenants").InsertOneAsync(new BsonDocument
        {
            { "_id", GatewayTenantDefaults.InternalTenantId },
            { "Status", "active" },
        });
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://gateway",
            ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
        }).Build();
        var environment = new Mock<IHostEnvironment>();
        environment.SetupGet(item => item.EnvironmentName).Returns("Production");
        var service = new DesignArtifactGatewayGrantService(_gateway, _db, configuration, environment.Object);

        var issued = await service.IssueAsync(run, Now.AddMinutes(15), default);
        var stored = await _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .Find(item => item.Id == issued.Id)
            .SingleAsync();
        var expectedHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(issued.ApiKey)))
            .ToLowerInvariant();

        Assert.Equal("http://gateway/gw/v1", issued.BaseUrl);
        Assert.Equal("default-chat-curated", issued.Model);
        Assert.Equal(AppCallerRegistry.Admin.WebHosting.GenerateHtml, issued.AppCallerCode);
        Assert.Equal(expectedHash, stored.KeyHash);
        Assert.Equal(expectedHash[..12], stored.KeyPrefix);
        Assert.DoesNotContain(issued.ApiKey, stored.ToBsonDocument().ToJson(), StringComparison.Ordinal);

        var authorization = await new GatewayScopedKeyAuthorizer(_gateway).AuthorizeAsync(
            issued.ApiKey,
            "unrelated-legacy-key",
            "map",
            issued.AppCallerCode,
            "gw-native",
            "invoke",
            null,
            default);
        Assert.True(authorization.Allowed);
        Assert.Equal(run.Id, authorization.RuntimeGrant?.RunId);
        Assert.Equal(run.UserId, authorization.RuntimeGrant?.UserId);

        var usage = await service.ObserveAsync(issued.Id, run, default);
        Assert.Equal(1, usage.CallCount);
        Assert.Equal(1, (await Read(run.Id)).RuntimeModelCallCount);

        await service.RevokeAsync(issued.Id, default);
        Assert.Equal(0, await _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .CountDocumentsAsync(item => item.Id == issued.Id));
    }

    private static DesignArtifactRun Run(string id, string status) => new()
    {
        Id = id, UserId = "owner", Status = status, CreatedAt = Now.AddMinutes(-10), UpdatedAt = Now.AddMinutes(-5),
    };
    private Task InsertAsync(DesignArtifactRun run, string? scope)
    {
        var document = run.ToBsonDocument();
        document["DeploymentSlug"] = scope == null ? BsonNull.Value : scope;
        return _db.Database.GetCollection<BsonDocument>(_db.DesignArtifactRuns.CollectionNamespace.CollectionName).InsertOneAsync(document);
    }
    private Task<DesignArtifactRun> Read(string id) => _db.DesignArtifactRuns.Find(item => item.Id == id).FirstAsync();
    private Task<BsonDocument> Raw(string id) => _db.Database.GetCollection<BsonDocument>(
        _db.DesignArtifactRuns.CollectionNamespace.CollectionName).Find(new BsonDocument("_id", id)).FirstAsync();
    public async Task DisposeAsync()
    {
        foreach (var (name, value) in _previousEnvironment) Environment.SetEnvironmentVariable(name, value);
        if (_databaseName.StartsWith("design_scope_synthetic_", StringComparison.Ordinal))
            await new MongoClient(_connection).DropDatabaseAsync(_databaseName);
    }
}

public sealed class DesignScopeMongoFactAttribute : FactAttribute
{
    public DesignScopeMongoFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION")))
            Skip = "需要独立 Mongo 127.0.0.1:27389 与显式 DESIGN_RUN_MONGO_TEST_CONNECTION；不连接应用 Mongo。";
    }
}
public sealed class DesignScopeMongoTheoryAttribute : TheoryAttribute
{
    public DesignScopeMongoTheoryAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION")))
            Skip = "需要独立 Mongo 127.0.0.1:27389 与显式 DESIGN_RUN_MONGO_TEST_CONNECTION；不连接应用 Mongo。";
    }
}
