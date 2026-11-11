using MongoDB.Driver;
using MongoDB.Bson;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;
using Moq;
using System.Reflection;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Tests.Services;

public partial class VideoSceneConcurrencyTests
{
    private static Task<bool> RecoverGeneration(VideoGenRunWorker worker) => (Task<bool>)typeof(VideoGenRunWorker)
        .GetMethod("RecoverInterruptedGenerationAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
        .Invoke(worker, [CancellationToken.None])!;

    private static Task ExpireGeneration(VideoSceneTestDatabase test, string permitId, int dispatches = 0)
        => test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .UpdateOneAsync(x => x.Id == permitId, new BsonDocument("$set", new BsonDocument
            { ["Executions.0.LeaseUntil"] = DateTime.UnixEpoch, ["Executions.0.DispatchCount"] = dispatches }));

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData("video-agent")]
    [InlineData("visual-agent")]
    public async Task GenerationRecovery_DirectZeroDispatchContinuesOriginalValidationWithoutSubmitting(string appKey)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("direct-recovery-validation", test.OwnerId, SceneItemStatus.Draft);
        run.AppKey = appKey; run.Mode = VideoGenMode.Direct; run.Status = VideoGenRunStatus.Rendering; run.DirectPrompt = "";
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var old = lease;
        if (appKey == "visual-agent") await test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .UpdateOneAsync(x => x.Id == run.TaskPermitId, Builders<GatewayTaskPermitRecord>.Update.Set(x => x.AllowedAppCallerCodes,
                [AppCallerRegistry.VisualAgent.VideoGen.Generate]));
        await ExpireGeneration(test, run.TaskPermitId!);
        using var worker = test.CreateWorker(coordinator, generationRecovery: true);
        (await RecoverGeneration(worker)).ShouldBeTrue();
        var fresh = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        fresh.Status.ShouldBe(VideoGenRunStatus.Failed); fresh.ErrorCode.ShouldBe("EMPTY_PROMPT");
        fresh.TaskPermitId.ShouldBe(run.TaskPermitId); test.VideoClient.Invocations.Count.ShouldBe(0);
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task GenerationRecovery_ReusesOriginalBudgetAndRealLeaseAcrossDualDatabases(bool scenePrompt, bool firstInvalid)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync(dualGateway: true);
        var run = firstInvalid ? NewRun("recover-llm", test.OwnerId, SceneItemStatus.Generating, SceneItemStatus.Generating)
            : NewRun("recover-llm", test.OwnerId, SceneItemStatus.Generating);
        var targetIndex = firstInvalid ? 1 : 0;
        var executionId = scenePrompt ? $"{run.Id}_scene_{targetIndex}" : run.Id;
        run.Status = scenePrompt ? VideoGenRunStatus.Editing : VideoGenRunStatus.Scripting;
        run.ArticleMarkdown = "本机合成文稿，不调用外部服务";
        var (coordinator, oldLease) = await test.SaveAuthorizedRunAsync(run);
        await using var old = oldLease;
        TaskExecutionLease? sceneLease = null;
        if (scenePrompt)
        {
            run.Scenes[targetIndex].TaskPermitId = run.TaskPermitId;
            if (firstInvalid) run.Scenes[0].TaskPermitId = "missing-original-permit";
            await test.Context.VideoGenRuns.UpdateOneAsync(x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes));
            sceneLease = await coordinator.AcquireAsync(run.TaskPermitId!, executionId, default);
            await test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
                .UpdateOneAsync(x => x.Id == run.TaskPermitId, new BsonDocument("$set", new BsonDocument("Executions.1.LeaseUntil", DateTime.UnixEpoch)));
            // Dispose 旧代次不能完成后续新代次；测试继续在同一次原账本执行。
        }
        else await ExpireGeneration(test, run.TaskPermitId!);
        await using var previousSceneLease = sceneLease;
        var calls = 0;
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(x => x.ResolveModelAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution { Success = true });
        gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Returns(async (GatewayRawRequest _, GatewayModelResolution _, CancellationToken ct) =>
            {
                var proof = TaskExecutionContext.Current?.Lease;
                proof.ShouldNotBeNull(); proof.PermitId.ShouldBe(run.TaskPermitId);
                proof.RunId.ShouldBe(executionId);
                (await coordinator.ValidateAsync(proof, beforeDispatch: true, ct)).ShouldBeTrue();
                calls++;
                var content = scenePrompt ? "local replacement prompt" : "{\"scenes\":[{\"prompt\":\"local scene\",\"topic\":\"local\",\"duration\":5}]}";
                return new GatewayRawResponse { Success = true, Content = System.Text.Json.JsonSerializer.Serialize(new
                    { choices = new[] { new { message = new { content } } } }) };
            });
        using var worker = test.CreateGenerationWorker(coordinator, gateway.Object);
        (await RecoverGeneration(worker)).ShouldBeTrue();
        var fresh = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        fresh.Status.ShouldBe(VideoGenRunStatus.Editing); calls.ShouldBe(1);
        fresh.Scenes[targetIndex].Prompt.ShouldBe(scenePrompt ? "local replacement prompt" : "local scene");
        (await RecoverGeneration(worker)).ShouldBeFalse(); calls.ShouldBe(1);
        var permit = await test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .Find(x => x.Id == run.TaskPermitId).SingleAsync();
        permit.MaxCalls.ShouldBe(4); permit.MaxRuns.ShouldBe(2);
        permit.Executions.Single(x => x.RunId == (executionId)).DispatchCount.ShouldBe(1);
        (await test.Context.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName).CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty)).ShouldBe(0);
        test.VideoClient.Invocations.Count.ShouldBe(0);
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData("active")]
    [InlineData("dispatched")]
    [InlineData("known-job")]
    [InlineData("cancelled")]
    [InlineData("deleted")]
    [InlineData("foreign-scope")]
    [InlineData("foreign-owner")]
    [InlineData("foreign-tenant")]
    [InlineData("foreign-source")]
    [InlineData("foreign-caller")]
    [InlineData("revoked")]
    [InlineData("expired-permit")]
    public async Task GenerationRecovery_NeverReplaysOrMutatesUnqualifiedBusinessTasks(string boundary)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("generation-boundary", test.OwnerId, SceneItemStatus.Draft);
        run.Mode = VideoGenMode.Direct; run.Status = VideoGenRunStatus.Rendering;
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var old = lease;
        if (boundary != "active") await ExpireGeneration(test, run.TaskPermitId!, boundary is "dispatched" or "known-job" ? 1 : 0);
        if (boundary == "known-job") { run.DirectVideoJobId = "existing-only"; run.DirectVideoCost = null; run.DirectVideoUpstreamStatus = "processing"; }
        if (boundary == "cancelled") run.CancelRequested = true;
        if (boundary == "deleted") run.DeletionRequestedAt = DateTime.UtcNow;
        if (boundary == "foreign-scope") run.DeploymentSlug = "some-other-revision";
        // 精确替换本人合成对象；业务过滤和许可查询均须独立拒绝。
        await test.Context.VideoGenRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        var change = boundary switch
        {
            "foreign-owner" => new BsonDocument("ActorUserId", "other-owner"),
            "foreign-tenant" => new BsonDocument("TenantId", "other-tenant"),
            "foreign-source" => new BsonDocument("SourceDeployment", "other-deployment"),
            "foreign-caller" => new BsonDocument("AllowedAppCallerCodes", new BsonArray { "other.caller" }),
            "revoked" => new BsonDocument("RevokedAt", DateTime.UtcNow),
            "expired-permit" => new BsonDocument("ExpiresAt", DateTime.UnixEpoch),
            _ => null,
        };
        if (change != null) await test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .UpdateOneAsync(x => x.Id == run.TaskPermitId, new BsonDocument("$set", change));
        var before = (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument();
        using var worker = test.CreateWorker(coordinator, generationRecovery: true);
        (await RecoverGeneration(worker)).ShouldBeFalse();
        (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument().ShouldBe(before);
        test.VideoClient.Invocations.Count.ShouldBe(0);
        if (boundary is "known-job" or "dispatched")
        {
            var permit = await test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName).Find(x => x.Id == run.TaskPermitId).SingleAsync();
            permit.Executions[0].State.ShouldBe(TaskExecutionLeaseStates.OutcomeUnknown);
        }
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GenerationRecovery_OwnerSelectsSameBranchRevisionOnlyWhenOriginalExecutionIsDormant(bool active)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("generation-owner-scope", test.OwnerId, SceneItemStatus.Draft);
        run.Status = VideoGenRunStatus.Scripting; run.DeploymentSlug = "project::branch::revision::old";
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var old = lease;
        if (!active) await ExpireGeneration(test, run.TaskPermitId!);
        var recovery = new VideoGenerationRecovery(test.Context, test.Data, coordinator, GenerationConfiguration());
        const string current = "project::branch::revision::new";
        await recovery.PrepareOwnedReadAsync(run, "another-owner", run.AppKey, current, "project::branch", default);
        run.DeploymentSlug.ShouldBe("project::branch::revision::old");
        await recovery.PrepareOwnedReadAsync(run, test.OwnerId, run.AppKey, current, "project::branch", default);
        run.DeploymentSlug.ShouldBe(active ? "project::branch::revision::old" : current);
        var fresh = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        fresh.DeploymentSlug.ShouldBe(run.DeploymentSlug); fresh.TaskPermitId.ShouldBe(run.TaskPermitId);
        if (!active) (await coordinator.ValidateAsync(lease.Proof, false, default)).ShouldBeFalse();
        test.VideoClient.Invocations.Count.ShouldBe(0);
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task GenerationRecovery_UnknownReceiptIsResponseOnlyAndActiveKnownJobKeepsNormalProgress()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("generation-read-only", test.OwnerId, SceneItemStatus.Draft);
        run.Mode = VideoGenMode.Direct; run.Status = VideoGenRunStatus.Rendering;
        run.DirectVideoJobId = "existing-job"; run.DirectVideoCost = null;
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var old = lease;
        var recovery = new VideoGenerationRecovery(test.Context, test.Data, coordinator, GenerationConfiguration());
        await recovery.PrepareOwnedReadAsync(run, test.OwnerId, run.AppKey, null, null, default);
        run.ErrorCode.ShouldBeNull();
        await ExpireGeneration(test, run.TaskPermitId!, 1);
        (await recovery.AcquireAsync(run, default))!.ErrorCode.ShouldBe("VIDEO_RECOVERY_OUTCOME_UNKNOWN");
        await recovery.PrepareOwnedReadAsync(run, test.OwnerId, run.AppKey, null, null, default);
        VideoGenerationUserError.SanitizeForResponse(run).ErrorMessage.ShouldContain("避免重复费用");
        run.Status.ShouldBe(VideoGenRunStatus.Rendering); run.CancelRequested.ShouldBeFalse();
        run.DirectVideoCost.ShouldBeNull(); run.DirectVideoReconciledAt.ShouldBeNull();
        var fresh = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        fresh.ErrorCode.ShouldBeNull(); fresh.DirectVideoJobId.ShouldBe("existing-job");
        fresh.DirectVideoReconciledAt.ShouldBeNull(); test.VideoClient.Invocations.Count.ShouldBe(0);
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task InterruptedScripting_BeforeAnyDispatch_ResumesOriginalExecution()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("generation-before-send", test.OwnerId, SceneItemStatus.Draft);
        run.Mode = VideoGenMode.Storyboard; run.Status = VideoGenRunStatus.Scripting;
        run.ArticleMarkdown = "";
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var old = lease;
        await test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .UpdateOneAsync(x => x.Id == run.TaskPermitId,
                new BsonDocument("$set", new BsonDocument("Executions.0.LeaseUntil", DateTime.UnixEpoch)));
        using var worker = test.CreateWorker(coordinator, generationRecovery: true);
        await worker.StartAsync(default);
        try
        {
            var deadline = DateTime.UtcNow.AddSeconds(5);
            VideoGenRun fresh;
            do { await Task.Delay(100); fresh = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync(); }
            while (fresh.Status == VideoGenRunStatus.Scripting && DateTime.UtcNow < deadline);
            fresh.Status.ShouldBe(VideoGenRunStatus.Failed);
            fresh.ErrorCode.ShouldBe("EMPTY_ARTICLE");
            fresh.TaskPermitId.ShouldBe(run.TaskPermitId);
            fresh.CancelRequested.ShouldBeFalse();
            test.VideoClient.Invocations.Count.ShouldBe(0);
        }
        finally { await worker.StopAsync(default); }
    }
}
