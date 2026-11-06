using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class WorkflowWebpageDesignServiceTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task FailedReportReplayResumesStoredResultWithoutNewModelAndPreservesHistory()
    {
        await using var f = await Fixture.CreateAsync(CapsuleTypes.ReportGenerator, savedResultOnly: true);
        f.HoldQueue = true;
        var original = f.Service.ExecuteAsync(f.Node, new(), f.Inputs, f.Invocation);
        DesignArtifactRun? run = null;
        for (var attempt = 0; run == null && attempt < 1000; attempt++)
        { run = await f.Db.DesignArtifactRuns.Find(_ => true).FirstOrDefaultAsync(); if (run == null) await Task.Delay(10); }
        Assert.NotNull(run);
        await f.Db.DesignArtifactRuns.UpdateOneAsync(item => item.Id == run.Id, Builders<DesignArtifactRun>.Update
            .Set(item => item.Status, RunStatuses.Running).Set(item => item.Progress, 85));
        var lifecycle = f.Provider.GetRequiredService<IDesignArtifactLifecycleService>();
        run = await lifecycle.FailAsync(new(run.Id, run.UserId,
            new(run.LifecycleVersion, run.WorkspaceRef!.BaseRevision, run.VersionBoundary!.BaseContentHash), "open_design_execution_failed"));
        await Assert.ThrowsAsync<WorkflowDesignException>(() => original.WaitAsync(TimeSpan.FromSeconds(10)));
        var packagePath = Environment.GetEnvironmentVariable("WORKFLOW_SAVED_RESULT_PATH");
        var files = new[] { StubOpenDesign.File("index.html", StubOpenDesign.Html, "text/html"),
            StubOpenDesign.File("assets/theme.css", "body{color:#123}", "text/css"), StubOpenDesign.File("manifest.json", "{}", "application/json") };
        var package = string.IsNullOrWhiteSpace(packagePath)
            ? JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = DesignArtifactWorkspaceBroker.SchemaVersion,
                sessionId = run.Id, runId = run.Id, baseRevision = run.WorkspaceRef!.BaseRevision,
                files = DesignArtifactWorkspaceContract.RebuildPublicManifest(files) }, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            : await System.IO.File.ReadAllBytesAsync(packagePath);
        using var envelope = JsonDocument.Parse(package);
        var previousId = run.Id;
        run.Id = envelope.RootElement.GetProperty("runId").GetString()!;
        foreach (var item in run.LifecycleEvents) item.RunId = run.Id;
        run.WorkspaceRef!.WorkspaceId = $"webpage-{run.Id}";
        run.WorkspaceBaseRevision = envelope.RootElement.GetProperty("baseRevision").GetString();
        run.WorkspaceRef.BaseRevision = run.WorkspaceBaseRevision;
        var parsed = DesignArtifactWorkspaceContract.ParseAndValidateResult(package, run.Id, run.WorkspaceBaseRevision!, DesignArtifactWorkspaceBroker.MaxOutputBytes);
        run.WorkspaceResultAssetKey = "isolated/saved-result.json";
        run.WorkspaceResultSha256 = Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant();
        run.WorkspaceManifestSha256 = parsed.Files.Single(file => file.Path == "manifest.json").Sha256;
        run.RuntimeModelCallCount = 21;
        await f.Db.DesignArtifactRuns.DeleteOneAsync(item => item.Id == previousId);
        await f.Db.DesignArtifactRuns.InsertOneAsync(run);
        var failedAt = DateTime.UtcNow;
        await f.Db.WorkflowExecutions.UpdateOneAsync(_ => true, Builders<WorkflowExecution>.Update
            .Set(item => item.Status, WorkflowExecutionStatus.Failed).Set(item => item.CompletedAt, failedAt)
            .Set(item => item.ErrorMessage, "保留原失败")
            .Set("NodeExecutions.0.Status", NodeExecutionStatus.Failed).Set("NodeExecutions.0.DesignRunId", run.Id)
            .Set("NodeExecutions.0.InputArtifacts", f.Inputs).Set("NodeExecutions.0.ErrorCode", "open_design_execution_failed")
            .Set("NodeExecutions.0.Logs", "原失败日志").Set("NodeExecutions.1.Status", NodeExecutionStatus.Skipped));
        byte[] currentBytes = [0];
        f.Storage.Setup(item => item.TryDownloadBytesAsync(run.WorkspaceResultAssetKey, It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => currentBytes);
        f.Gateway.Invocations.Clear(); f.HoldQueue = false;
        Assert.Equal("WORKFLOW_DESIGN_FORBIDDEN", (await Assert.ThrowsAsync<WorkflowDesignException>(() =>
            f.Service.ExecuteAsync(f.Node, new(), f.Inputs, f.Invocation with { UserId = "manager", OperationId = "recovery-owner-check" }))).Code);
        Assert.Equal("WORKFLOW_DESIGN_CONFLICT", (await Assert.ThrowsAsync<WorkflowDesignException>(() =>
            f.Service.ExecuteAsync(f.Node, new(), [new() { InlineContent = "已变化的输入" }], f.Invocation with { OperationId = "recovery-input-check" }))).Code);
        var rejected = Assert.IsType<OkObjectResult>(await OwnerApi(f).ReplayNode("workflow-execution", "report"));
        var rejectedDto = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(rejected.Value).Data,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("failed", rejectedDto.GetProperty("result").GetProperty("status").GetString());
        Assert.Equal(1, await f.Db.DesignArtifactRuns.CountDocumentsAsync(_ => true));
        Assert.Empty(f.Gateway.Invocations);
        currentBytes = package;
        var replay = Assert.IsType<OkObjectResult>(await OwnerApi(f).ReplayNode("workflow-execution", "report").WaitAsync(TimeSpan.FromSeconds(20)));
        var dto = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(replay.Value).Data,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("result");
        Assert.Equal("completed", dto.GetProperty("status").GetString());
        Assert.Equal(run.Id, dto.GetProperty("artifacts")[0].GetProperty("designDelivery").GetProperty("runId").GetString());
        var saved = await f.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, saved.Status);
        Assert.Equal(21, saved.RuntimeModelCallCount);
        Assert.Equal(run.WorkspaceResultSha256, saved.WorkspaceResultSha256);
        Assert.Equal(JsonSerializer.Serialize(run.LifecycleEvents), JsonSerializer.Serialize(saved.LifecycleEvents.Take(run.LifecycleEvents.Count)));
        Assert.Contains(saved.LifecycleEvents, item => item.Type == DesignArtifactLifecycleEventTypes.Recovered);
        Assert.All(saved.LifecycleEvents.Skip(run.LifecycleEvents.Count), item => Assert.True(item.Progress >= 85));
        var revision = await f.Db.HostedSiteRevisions.Find(item => item.Id == saved.ProducedArtifactRevisionId).SingleAsync();
        Assert.Equal(parsed.Files.Count, revision.VerifiedFiles.Count);
        foreach (var file in parsed.Files)
            Assert.Equal(Convert.FromBase64String(file.ContentBase64), Assert.Single(revision.VerifiedFiles, item => item.Path == file.Path).Content);
        Assert.IsType<OkObjectResult>(await OwnerApi(f).ReplayNode("workflow-execution", "publish"));
        await f.Service.ExecuteAsync(f.Node, new(), f.Inputs, f.Invocation with { OperationId = "repeat-recovery" });
        var history = await f.Db.WorkflowExecutions.Find(_ => true).SingleAsync();
        Assert.Equal(WorkflowExecutionStatus.Failed, history.Status);
        Assert.Equal("保留原失败", history.ErrorMessage);
        Assert.Equal(failedAt.ToUniversalTime().Ticks / TimeSpan.TicksPerMillisecond, history.CompletedAt!.Value.Ticks / TimeSpan.TicksPerMillisecond);
        Assert.Equal(NodeExecutionStatus.Failed, history.NodeExecutions[0].Status);
        Assert.Equal("open_design_execution_failed", history.NodeExecutions[0].ErrorCode);
        Assert.Equal("原失败日志", history.NodeExecutions[0].Logs);
        Assert.Equal(NodeExecutionStatus.Skipped, history.NodeExecutions[1].Status);
        Assert.Single(history.NodeExecutions[0].OutputArtifacts);
        Assert.Single(history.NodeExecutions[1].InputArtifacts);
        Assert.Equal(1, await f.Db.DesignArtifactRuns.CountDocumentsAsync(_ => true));
        Assert.Equal(1, await f.Db.HostedSites.CountDocumentsAsync(_ => true));
        Assert.Empty(f.Gateway.Invocations);
        f.Http.VerifyNoOtherCalls(); f.Grants.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task HtmlNodeWithoutAuthoritativeContextMustNotSendDirectModelRequest()
    {
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Returns(DirectHtml());
        using var services = new ServiceCollection().AddSingleton(gateway.Object).AddHttpClient().BuildServiceProvider();
        var failure = await Record.ExceptionAsync(() => CapsuleExecutor.ExecuteWebpageGeneratorAsync(
            services, new WorkflowNode { NodeId = "html", NodeType = CapsuleTypes.WebpageGenerator },
            new() { ["__triggeredBy"] = "forged-owner", ["__executionId"] = "forged-execution" },
            [new ExecutionArtifact { InlineContent = "既有测试资料" }]));
        Assert.NotNull(failure);
        gateway.Verify(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(CapsuleTypes.WebpageGenerator, ModelTypes.Code)]
    [InlineData(CapsuleTypes.ReportGenerator, ModelTypes.Chat)]
    [Trait("Category", TestCategories.Integration)]
    public async Task HtmlNodeUsesOriginalRouteAndSharedWorkerPreservesWholeDelivery(string type, string modelType)
    {
        await using var f = await Fixture.CreateAsync(type);
        var staleNodes = (await f.Db.WorkflowExecutions.Find(_ => true).SingleAsync()).NodeExecutions;
        var signals = new List<string>();
        var result = await CapsuleExecutor.ExecuteAsync(f.Provider, NullLogger.Instance, f.Node, new(), f.Inputs,
            (name, _) => { signals.Add(name); return Task.CompletedTask; }, f.Invocation).WaitAsync(TimeSpan.FromSeconds(15));
        var output = Assert.Single(result.Artifacts);
        var delivery = Assert.IsType<WorkflowDesignDelivery>(output.DesignDelivery);
        Assert.Equal("configured-report-slot", output.SlotId);
        var run = await f.Db.DesignArtifactRuns.Find(item => item.Id == delivery.RunId).SingleAsync();
        Assert.Equal("workflow-pool", run.LlmRequestPolicy!.ModelPoolId);
        Assert.Equal(WorkflowWebpageDesignService.RouteFor(type).Caller, DesignArtifactGatewayGrantService.CallerFor(run));
        f.Gateway.Verify(item => item.ResolveModelMetadataAsync(WorkflowWebpageDesignService.RouteFor(type).Caller,
            modelType, null, null, null, It.IsAny<CancellationToken>()), Times.Once);
        f.Gateway.Verify(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        Assert.Equal(RunStatuses.Done, run.Status);
        Assert.NotNull(run.PublishBindingOperationId);
        Assert.Equal(run.ProducedArtifactRevisionId, delivery.RevisionId);
        var revision = await f.Db.HostedSiteRevisions.Find(item => item.Id == delivery.RevisionId).SingleAsync();
        Assert.Equal(HostedSiteRevisionSources.Baseline, revision.Source);
        Assert.Null((await f.Db.HostedSites.Find(item => item.Id == delivery.SiteId).SingleAsync()).PublishedRevisionId);
        Assert.Contains(revision.VerifiedFiles, file => file.Path == "assets/theme.css" && Encoding.UTF8.GetString(file.Content) == "body{color:#123}");
        Assert.Equal(revision.VerifiedFiles.Count, delivery.FileCount);
        Assert.Contains(".versions/", delivery.Url);
        Assert.Contains("node-design-progress", signals);
        using var frozenInputs = JsonDocument.Parse(run.UploadedSources![0].Content);
        Assert.Equal(f.Inputs[0].InlineContent, frozenInputs.RootElement[0].GetProperty("InlineContent").GetString());
        var repeated = await f.Service.ExecuteAsync(f.Node, new(), f.Inputs, f.Invocation);
        Assert.Equal(delivery.RunId, repeated.Artifacts[0].DesignDelivery!.RunId);
        Assert.Equal(output.ArtifactId, repeated.Artifacts[0].ArtifactId);
        Assert.Equal(1, f.Executor.Calls);
        Assert.Equal(1, await f.Db.DesignArtifactRuns.CountDocumentsAsync(_ => true));
        var bulk = typeof(WorkflowRunWorker).GetMethod("BulkUpdateNodeExecutionsAsync", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        await (Task)bulk.Invoke(null, [f.Db, "workflow-execution", staleNodes])!;
        Assert.Equal(run.Id, (await f.Db.WorkflowExecutions.Find(_ => true).SingleAsync()).NodeExecutions[0].DesignRunId);
        await f.Db.WorkflowExecutions.UpdateOneAsync(item => item.Id == "workflow-execution",
            Builders<WorkflowExecution>.Update.Set("NodeExecutions.0.OutputArtifacts", result.Artifacts)
                .Set("NodeExecutions.0.Status", NodeExecutionStatus.Completed).Set("NodeExecutions.0.InputArtifacts", f.Inputs));
        var published = await CapsuleExecutor.ExecuteSitePublisherAsync(f.Provider,
            new WorkflowNode { NodeId = "publish", NodeType = CapsuleTypes.SitePublisher, Config = new() { ["title"] = "保留整包" } },
            new(), result.Artifacts, f.Invocation with { NodeId = "publish" });
        Assert.Contains(delivery.SiteId, published.Artifacts[0].InlineContent);
        Assert.IsType<OkObjectResult>(await OwnerApi(f).ResumeFromNode("workflow-execution", "publish"));
        var resumedExecution = await f.Db.WorkflowExecutions.Find(item => item.Id != "workflow-execution").SingleAsync();
        var resumedPublish = await CapsuleExecutor.ExecuteSitePublisherAsync(f.Provider,
            new WorkflowNode { NodeId = "publish", NodeType = CapsuleTypes.SitePublisher, Config = new() { ["title"] = "继承整包" } },
            new(), result.Artifacts, new("workflow-owner", resumedExecution.Id, "publish", resumedExecution.Id, "workflow-owner"));
        Assert.Contains(delivery.SiteId, resumedPublish.Artifacts[0].InlineContent);
        Assert.Equal(1, f.Executor.Calls);
        await f.Db.WorkflowExecutions.UpdateOneAsync(item => item.Id == "workflow-execution",
            Builders<WorkflowExecution>.Update.Set("NodeExecutions.1.InputArtifacts", result.Artifacts));
        Assert.IsType<OkObjectResult>(await OwnerApi(f).ReplayNode("workflow-execution", "publish"));
        Assert.Equal(1, f.Executor.Calls);

        Assert.Equal(1, await f.Db.HostedSites.CountDocumentsAsync(_ => true));
        Assert.Equal(revision.VerifiedFiles.Count, (await f.Db.HostedSiteRevisions.Find(item => item.Id == delivery.RevisionId).SingleAsync()).VerifiedFiles.Count);
        var package = Assert.IsType<FileContentResult>(await OwnerApi(f).DownloadDesignPackage(delivery.RunId));
        using (var zip = new System.IO.Compression.ZipArchive(new MemoryStream(package.FileContents)))
        {
            Assert.Equal(revision.VerifiedFiles.Count, zip.Entries.Count);
            foreach (var file in revision.VerifiedFiles)
            {
                using var stream = zip.GetEntry(file.Path)!.Open();
                using var bytes = new MemoryStream(); await stream.CopyToAsync(bytes);
                Assert.Equal(file.Content, bytes.ToArray());
            }
        }
        Assert.Equal("WORKFLOW_DESIGN_FORBIDDEN", (await Assert.ThrowsAsync<WorkflowDesignException>(() =>
            f.Service.DownloadPackageAsync(delivery.RunId, "other-owner"))).Code);
        var legacy = new ExecutionArtifact { ArtifactId = "legacy-html", Name = "先选中的报告.html", MimeType = "text/html",
            InlineContent = "<!doctype html><html><body>先选中的旧报告</body></html>" };
        var siteBoundary = Mock.Get(f.Provider.GetRequiredService<IHostedSiteService>());
        siteBoundary.Setup(item => item.CreateFromContentAsync("workflow-owner", legacy.InlineContent, It.IsAny<string?>(),
                It.IsAny<string?>(), "workflow", It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>(), null))
            .ReturnsAsync(new HostedSite { Id = "legacy-selected", SiteUrl = "https://assets.example.test/legacy/index.html" });
        var mixed = await CapsuleExecutor.ExecuteSitePublisherAsync(f.Provider,
            new WorkflowNode { NodeId = "publish", NodeType = CapsuleTypes.SitePublisher }, new(), [legacy, output], f.Invocation with { NodeId = "publish" });
        Assert.Contains("legacy-selected", mixed.Artifacts[0].InlineContent);
        siteBoundary.Verify(item => item.CreateFromContentAsync("workflow-owner", legacy.InlineContent, It.IsAny<string?>(),
            It.IsAny<string?>(), "workflow", It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>(), null), Times.Once);
        Assert.Equal(revision.VerifiedFiles.Count, (await f.Db.HostedSiteRevisions.Find(item => item.Id == delivery.RevisionId).SingleAsync()).VerifiedFiles.Count);
        await f.Db.WorkflowExecutions.UpdateOneAsync(item => item.Id == resumedExecution.Id,
            Builders<WorkflowExecution>.Update.Unset(item => item.ResumedFromExecutionId));
        await Assert.ThrowsAsync<WorkflowDesignException>(() => f.Service.ResolveDeliveryAsync(output,
            new("workflow-owner", resumedExecution.Id, "publish", resumedExecution.Id, "workflow-owner")));
        var replay = Assert.IsType<OkObjectResult>(await OwnerApi(f).ReplayNode("workflow-execution", "report"));
        var dto = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(replay.Value).Data,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("result").GetProperty("artifacts")[0];
        Assert.False(string.IsNullOrWhiteSpace(dto.GetProperty("cosUrl").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(dto.GetProperty("designDelivery").GetProperty("downloadPath").GetString()));
        var snapshotCount = await f.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true);
        await f.Db.HostedSites.UpdateOneAsync(item => item.Id == delivery.SiteId,
            Builders<HostedSite>.Update.Set(item => item.CreatedAt, revision.PublishedContentVersion!.Value)
                .Set(item => item.ContentVersion, default(DateTime)));
        Assert.Equal(delivery.SiteId, (await f.Service.ResolveDeliveryAsync(output, f.Invocation with { NodeId = "publish" })).Id);
        Assert.Equal(snapshotCount, await f.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true));
        await f.Db.HostedSites.UpdateOneAsync(item => item.Id == delivery.SiteId,
            Builders<HostedSite>.Update.Set(item => item.ContentVersion, revision.PublishedContentVersion!.Value.AddSeconds(1)));
        Assert.Equal("WORKFLOW_DESIGN_CONFLICT", (await Assert.ThrowsAsync<WorkflowDesignException>(() =>
            f.Service.ResolveDeliveryAsync(output, f.Invocation with { NodeId = "publish" }))).Code);
        Assert.Equal(snapshotCount, await f.Db.HostedSiteRevisions.CountDocumentsAsync(_ => true));
        Assert.Null((await f.Db.HostedSites.Find(item => item.Id == delivery.SiteId).SingleAsync()).PublishedRevisionId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ExplicitCancellationTargetsSameRunAndDisconnectedObservationDoesNotResend()
    {
        await CancelledBeforeWorkerClaimDoesNotStartAsync();
        await using var f = await Fixture.CreateAsync(CapsuleTypes.WebpageGenerator);
        f.Executor.Block = true;
        var sourceNode = new WorkflowNode { NodeId = "saved-source", NodeType = CapsuleTypes.ReportGenerator };
        await f.Db.WorkflowExecutions.UpdateOneAsync(_ => true, Builders<WorkflowExecution>.Update
            .Push(item => item.NodeSnapshot, sourceNode).Push(item => item.NodeExecutions, new NodeExecution
            { NodeId = sourceNode.NodeId, Status = NodeExecutionStatus.Completed, OutputArtifacts = f.Inputs })
            .Push(item => item.EdgeSnapshot, new WorkflowEdge { SourceNodeId = sourceNode.NodeId, TargetNodeId = "report" }));
        var worker = new WorkflowRunWorker(f.Provider.GetRequiredService<IServiceScopeFactory>(), f.Queue.Object, f.Events, NullLogger<WorkflowRunWorker>.Instance);
        var process = typeof(WorkflowRunWorker).GetMethod("ProcessExecutionAsync", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var waiting = (Task)process.Invoke(worker, ["workflow-execution"])!;
        await f.Executor.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var run = await f.Db.DesignArtifactRuns.Find(_ => true).SingleAsync();
        // 服务器在同一业务身份上恢复等待；独立前端代表另证断流只重连 GET。
        var resumed = f.Service.ExecuteAsync(f.Node, new(), f.Inputs, f.Invocation);
        var ownerApi = OwnerApi(f);
        var hostingApi = new PrdAgent.Api.Controllers.Api.DesignArtifactsController(f.Db, f.Events, f.Queue.Object,
            f.Catalog.Object, Mock.Of<IDesignKnowledgeSnapshotResolver>(), null!, Mock.Of<IDesignArtifactCancellationCoordinator>(),
            new ConfigurationBuilder().Build(), f.Provider.GetRequiredService<IHostedSiteService>())
        { ControllerContext = ownerApi.ControllerContext };
        var noHostingTask = Assert.IsType<OkObjectResult>(await hostingApi.GetActiveRun(DesignArtifactOperations.Generate));
        Assert.Null(Assert.IsType<ApiResponse<object?>>(noHostingTask.Value).Data);
        var wrongRestart = Assert.IsType<ConflictObjectResult>(await hostingApi.RestartRun(run.Id, new()));
        Assert.Equal("WORKFLOW_RESTART_REQUIRES_NODE", Assert.IsType<ApiResponse<object>>(wrongRestart.Value).Error!.Code);
        await f.Db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun { Id = "legacy-hosting", UserId = "workflow-owner",
            DeploymentSlug = DeploymentScope.Current, Runtime = DesignArtifactRuntimes.OpenDesign, Status = RunStatuses.Running });
        await f.Db.DesignArtifactRuns.UpdateOneAsync(item => item.Id == "legacy-hosting",
            Builders<DesignArtifactRun>.Update.Unset(item => item.SourceSurface));
        var oldHostingTask = Assert.IsType<OkObjectResult>(await hostingApi.GetActiveRun(DesignArtifactOperations.Generate));
        var selected = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object?>>(oldHostingTask.Value).Data);
        Assert.Equal("legacy-hosting", selected.GetProperty("runId").GetString());
        await f.Db.DesignArtifactRuns.DeleteOneAsync(item => item.Id == "legacy-hosting");
        Assert.IsType<OkObjectResult>(await ownerApi.CancelExecution("workflow-execution"));
        await waiting.WaitAsync(TimeSpan.FromSeconds(10));
        var complete = Assert.Single(await f.Events.GetEventsAsync(RunKinds.Workflow, "workflow-execution", 0, 100),
            item => item.EventName == "execution-completed");
        using var terminal = JsonDocument.Parse(complete.PayloadJson);
        var stored = await f.Db.WorkflowExecutions.Find(_ => true).SingleAsync();
        Assert.Equal(WorkflowExecutionStatus.Cancelled, terminal.RootElement.GetProperty("status").GetString());
        Assert.Equal(stored.NodeExecutions.Count(item => item.Status == NodeExecutionStatus.Completed), terminal.RootElement.GetProperty("completedNodes").GetInt32());
        Assert.Equal(stored.NodeExecutions.Count(item => item.Status == NodeExecutionStatus.Failed), terminal.RootElement.GetProperty("failedNodes").GetInt32());
        Assert.Equal(stored.NodeExecutions.Count(item => item.Status == NodeExecutionStatus.Skipped), terminal.RootElement.GetProperty("skippedNodes").GetInt32());
        Assert.Equal("WORKFLOW_DESIGN_CANCELLED", (await Assert.ThrowsAsync<WorkflowDesignException>(() => resumed.WaitAsync(TimeSpan.FromSeconds(10)))).Code);
        var cancelled = await f.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Cancelled, cancelled.Status);
        Assert.Equal(1, f.Executor.Calls);
        Assert.Equal(1, await f.Db.DesignArtifactRuns.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await f.Db.HostedSites.CountDocumentsAsync(_ => true));
        var controller = new PrdAgent.Api.Controllers.Api.WorkflowAgentController(f.Db, f.Queue.Object, f.Events, f.Gateway.Object,
            new WorkflowAiFillService(f.Gateway.Object, f.Db, NullLogger<WorkflowAiFillService>.Instance),
            new PrdAgent.Core.Services.WorkflowValidationService(), NullLogger<PrdAgent.Api.Controllers.Api.WorkflowAgentController>.Instance)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new System.Security.Claims.ClaimsPrincipal(
            new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.NameIdentifier, "other-owner")], "test")) } } };
        controller.Response.Body = new MemoryStream();
        await controller.StreamExecution("workflow-execution");
        Assert.Equal(403, controller.Response.StatusCode);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task UnavailableDesignDoesNotFallBackAndMarkdownKeepsItsOriginalContract()
    {
        await using var f = await Fixture.CreateAsync(CapsuleTypes.ReportGenerator);
        f.Catalog.Setup(item => item.FindAsync(It.IsAny<string>(), DesignArtifactRuntimes.OpenDesign, It.IsAny<CancellationToken>()))
            .ReturnsAsync((DesignArtifactProviderCapability?)null);
        Assert.Equal("WORKFLOW_DESIGN_UNAVAILABLE", (await Assert.ThrowsAsync<WorkflowDesignException>(() =>
            f.Service.ExecuteAsync(f.Node, new(), f.Inputs, f.Invocation))).Code);
        Assert.Equal(0, await f.Db.DesignArtifactRuns.CountDocumentsAsync(_ => true));
        Assert.Equal(0, f.Executor.Calls);
        f.Node.Config["format"] = "markdown";
        var markdown = await CapsuleExecutor.ExecuteReportGeneratorAsync(f.Provider, f.Node, new(), f.Inputs);
        Assert.Equal("text/markdown", markdown.Artifacts[0].MimeType);
        f.Gateway.Verify(item => item.StreamAsync(It.Is<GatewayRequest>(request => request.AppCallerCode == AppCallerRegistry.WorkflowAgent.ReportGenerator.Chat),
            It.IsAny<CancellationToken>()), Times.Once);
    }

    private static PrdAgent.Api.Controllers.Api.WorkflowAgentController OwnerApi(Fixture f)
    {
        return new PrdAgent.Api.Controllers.Api.WorkflowAgentController(f.Db, f.Queue.Object, f.Events, f.Gateway.Object,
            new WorkflowAiFillService(f.Gateway.Object, f.Db, NullLogger<WorkflowAiFillService>.Instance),
            new PrdAgent.Core.Services.WorkflowValidationService(), NullLogger<PrdAgent.Api.Controllers.Api.WorkflowAgentController>.Instance)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { RequestServices = f.Provider,
            User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
                [new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.NameIdentifier, "workflow-owner")], "test")) } } };
    }

    private static async Task CancelledBeforeWorkerClaimDoesNotStartAsync()
    {
        await using var f = await Fixture.CreateAsync(CapsuleTypes.WebpageGenerator);
        await f.Db.WorkflowExecutions.UpdateOneAsync(item => item.Id == "workflow-execution",
            Builders<WorkflowExecution>.Update.Set(item => item.Status, WorkflowExecutionStatus.Queued));
        var loaded = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var logger = new Mock<ILogger<WorkflowRunWorker>>();
        logger.Setup(item => item.Log(It.IsAny<LogLevel>(), It.IsAny<EventId>(), It.IsAny<It.IsAnyType>(),
            It.IsAny<Exception?>(), It.IsAny<Func<It.IsAnyType, Exception?, string>>()))
            .Callback(new InvocationAction(call =>
            {
                if (!call.Arguments[2].ToString()!.StartsWith("Processing execution:", StringComparison.Ordinal)) return;
                loaded.TrySetResult();
                resume.Task.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
            }));
        var worker = new WorkflowRunWorker(f.Provider.GetRequiredService<IServiceScopeFactory>(), f.Queue.Object, f.Events, logger.Object);
        var method = typeof(WorkflowRunWorker).GetMethod("ProcessExecutionAsync", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var processing = Task.Run(async () => await (Task)method.Invoke(worker, ["workflow-execution"])!);
        await loaded.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try { Assert.IsType<OkObjectResult>(await OwnerApi(f).CancelExecution("workflow-execution")); }
        finally { resume.TrySetResult(); }
        await processing.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(WorkflowExecutionStatus.Cancelled, (await f.Db.WorkflowExecutions.Find(_ => true).SingleAsync()).Status);
        Assert.Equal(0, f.Executor.Calls);
        Assert.Equal(0, await f.Db.DesignArtifactRuns.CountDocumentsAsync(_ => true));
        Assert.DoesNotContain(await f.Events.GetEventsAsync(RunKinds.Workflow, "workflow-execution", 0, 100), item => item.EventName == "execution-started");
        var observer = OwnerApi(f); observer.Response.Body = new MemoryStream();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        await observer.StreamExecution("workflow-execution", cancellationToken: deadline.Token);
        var streamText = Encoding.UTF8.GetString(((MemoryStream)observer.Response.Body).ToArray());
        Assert.Contains("event: execution-completed", streamText);
        Assert.Contains("\"status\":\"cancelled\"", streamText);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly RunMongoFixture mongo;
        public MongoDbContext Db => mongo.Db;
        public Mock<ILlmGateway> Gateway { get; } = new();
        public Mock<IDesignArtifactProviderCatalog> Catalog { get; } = new();
        public Mock<IRunQueue> Queue { get; } = new();
        public Mock<IAssetStorage> Storage { get; private set; } = null!;
        public Mock<IHttpClientFactory> Http { get; } = new(MockBehavior.Strict);
        public Mock<IDesignArtifactGatewayGrantService> Grants { get; } = new(MockBehavior.Strict);
        public IDesignArtifactWorkspaceBroker Broker { get; private set; } = null!;
        public bool HoldQueue { get; set; }
        public InMemoryRunEventStore Events { get; } = new();
        public ServiceProvider Provider { get; private set; } = null!;
        public WorkflowWebpageDesignService Service { get; private set; } = null!;
        public StubOpenDesign Executor { get; }
        public WorkflowNode Node { get; }
        public WorkflowDesignInvocation Invocation => new("workflow-owner", "workflow-execution", Node.NodeId, "workflow-execution", "workflow-owner");
        public List<ExecutionArtifact> Inputs { get; } = [new() { ArtifactId = "saved-source", Name = "既有报告资料", MimeType = "text/plain", InlineContent = "已有数据：交接三项、验证两项。" }];
        private readonly List<Task> workers = new();
        private HostedSiteEditRunWorker worker = null!;
        private DesignArtifactCancellationCoordinator cancellation = null!;
        private Fixture(RunMongoFixture mongo, string type)
        {
            this.mongo = mongo; Executor = new(Db);
            Node = new WorkflowNode { NodeId = "report", NodeType = type, Name = "已有报告",
                OutputSlots = [new ArtifactSlot { SlotId = "configured-report-slot", Name = "report" }],
                Config = new() { ["format"] = "html", ["reportTemplate"] = "整理既有资料" } };
            var existingReport = Environment.GetEnvironmentVariable("WORKFLOW_EXISTING_REPORT_PATH");
            if (!string.IsNullOrWhiteSpace(existingReport))
            { Inputs[0].InlineContent = System.IO.File.ReadAllText(existingReport); Inputs[0].MimeType = "text/html"; }
        }
        public static async Task<Fixture> CreateAsync(string type, bool savedResultOnly = false)
        {
            var settings = MongoClientSettings.FromConnectionString(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017");
            Assert.All(settings.Servers, server => Assert.Contains(server.Host, new[] { "127.0.0.1", "localhost", "::1" }));
            var f = new Fixture(await RunMongoFixture.CreateAsync("workflow_design"), type);
            await f.Db.WorkflowExecutions.InsertOneAsync(new WorkflowExecution { Id = "workflow-execution", TriggeredBy = "workflow-owner", Status = WorkflowExecutionStatus.Running,
                NodeSnapshot = [f.Node, new() { NodeId = "publish", NodeType = CapsuleTypes.SitePublisher }],
                EdgeSnapshot = [new() { SourceNodeId = "report", TargetNodeId = "publish" }],
                NodeExecutions = [new() { NodeId = "report" }, new() { NodeId = "publish" }] });
            f.Gateway.Setup(item => item.ResolveModelMetadataAsync(It.IsAny<string>(), It.IsAny<string>(), null, null, null, It.IsAny<CancellationToken>()))
                .ReturnsAsync(new GatewayModelResolution { Success = true, ModelGroupId = "workflow-pool" });
            f.Gateway.Setup(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>())).Returns(DirectHtml());
            f.Catalog.Setup(item => item.FindAsync(It.IsAny<string>(), DesignArtifactRuntimes.OpenDesign, It.IsAny<CancellationToken>()))
                .ReturnsAsync(new DesignArtifactProviderCapability(DesignArtifactRuntimes.OpenDesign, "OpenDesign", DesignArtifactAdapterKinds.RemoteAgent,
                    DesignArtifactExecutionOwners.CdsRemoteAgent, DesignArtifactIsolationModes.SessionContainer, [DesignArtifactTypes.WebPage],
                    [DesignArtifactOperations.Generate], [DesignArtifactSourceSurfaces.Workflow], true, true, true, null, null));
            var sites = new Mock<IHostedSiteService>();
            var storage = new Mock<IAssetStorage>(); storage.Setup(item => item.BuildUrlForKey(It.IsAny<string>())).Returns((string key) => "https://assets.example.test/" + key);
            f.Storage = storage;
            f.Broker = new DesignArtifactWorkspaceBroker(f.Db, storage.Object, new EphemeralDataProtectionProvider(),
                new ConfigurationBuilder().Build(), f.Grants.Object);
            var revisions = new HostedSiteRevisionService(f.Db, sites.Object, storage.Object);
            sites.Setup(item => item.PrepareHtmlForHosting(It.IsAny<byte[]>(), "index.html")).Returns((byte[] bytes, string _) => bytes);
            sites.Setup(item => item.CreateFromVerifiedFilesAsync("workflow-owner", It.IsAny<IReadOnlyList<HostedSiteVerifiedFile>>(), It.IsAny<string?>(), It.IsAny<string?>(),
                "design-agent", It.IsAny<string>(), It.IsAny<List<string>?>(), null, It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns(async (string owner, IReadOnlyList<HostedSiteVerifiedFile> files, string? title, string? _, string _, string sourceRun,
                    List<string>? _, string? _, string _, CancellationToken _) =>
                {
                    var site = new HostedSite { Id = "site-" + sourceRun, OwnerUserId = owner, Title = title ?? "", SourceRef = sourceRun,
                        SourceType = "design-agent", ContentVersion = DateTime.UtcNow, SiteUrl = "https://assets.example.test/site/index.html",
                        Files = files.Select(file => new HostedSiteFile { Path = file.Path, CosKey = "sites/site-" + sourceRun + "/.versions/first/" + file.Path, Size = file.Content.Length, MimeType = file.MimeType }).ToList() };
                    await f.Db.HostedSites.InsertOneAsync(site); return site;
                });
            sites.Setup(item => item.GetEditableEntryHtmlAsync(It.IsAny<string>(), "workflow-owner", It.IsAny<CancellationToken>()))
                .Returns(async (string id, string _, CancellationToken _) => { var site = await f.Db.HostedSites.Find(item => item.Id == id).SingleAsync(); return new HostedSiteEditableEntry(site, StubOpenDesign.Html, site.ContentVersion == default ? site.CreatedAt : site.ContentVersion); });
            sites.Setup(item => item.GetByIdAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns(async (string id, string owner, CancellationToken _) => (HostedSite?)await f.Db.HostedSites.Find(item => item.Id == id && item.OwnerUserId == owner).FirstOrDefaultAsync());
            sites.Setup(item => item.UpdateAsync(It.IsAny<string>(), "workflow-owner", It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string?>(), null, It.IsAny<CancellationToken>()))
                .Returns(async (string id, string _, string? _, string? _, List<string>? _, string? _, string? _, CancellationToken _) => (HostedSite?)await f.Db.HostedSites.Find(item => item.Id == id).FirstOrDefaultAsync());
            var lifecycle = new DesignArtifactLifecycleService(f.Db, f.Events);
            var adapter = new WebPageDesignArtifactLifecycleAdapter(f.Db, lifecycle, Mock.Of<IDesignArtifactWorkspaceBroker>(), NullLogger<WebPageDesignArtifactLifecycleAdapter>.Instance);
            f.cancellation = new DesignArtifactCancellationCoordinator(f.Db, lifecycle, f.Events);
            f.Service = new WorkflowWebpageDesignService(f.Db, f.Queue.Object, f.Events, f.Catalog.Object, f.Gateway.Object, sites.Object, revisions, storage.Object,
                f.Broker, lifecycle, f.cancellation, NullLogger<WorkflowWebpageDesignService>.Instance);
            f.Provider = new ServiceCollection().AddSingleton(f.Db).AddSingleton(sites.Object).AddSingleton<IHostedSiteRevisionService>(revisions)
                .AddSingleton<IDesignArtifactLifecycleService>(lifecycle).AddSingleton<IWebPageDesignArtifactLifecycleAdapter>(adapter)
                .AddSingleton(Mock.Of<IDesignKnowledgeSnapshotResolver>()).AddSingleton(Mock.Of<IActivityActionRecorder>())
                .AddSingleton<IDesignArtifactExecutor>(savedResultOnly
                    ? new OpenDesignServiceArtifactExecutor(f.Http.Object, f.Broker, f.Grants.Object, new ConfigurationBuilder().Build(), NullLogger<OpenDesignServiceArtifactExecutor>.Instance)
                    : f.Executor).AddSingleton(f.Gateway.Object).AddSingleton<IWorkflowWebpageDesignService>(f.Service).AddHttpClient().BuildServiceProvider();
            f.worker = new HostedSiteEditRunWorker(f.Provider.GetRequiredService<IServiceScopeFactory>(), f.Queue.Object, f.Events, NullLogger<HostedSiteEditRunWorker>.Instance);
            f.Queue.Setup(item => item.EnqueueAsync(RunKinds.DesignArtifact, It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns((string _, string id, CancellationToken _) => { if (!f.HoldQueue) f.workers.Add(f.worker.ProcessAsync(id, CancellationToken.None)); return Task.CompletedTask; });
            return f;
        }
        public async ValueTask DisposeAsync()
        {
            foreach (var run in await Db.DesignArtifactRuns.Find(item => item.Status == RunStatuses.Running || item.Status == RunStatuses.Queued).ToListAsync())
                await cancellation.RequestAsync(run.Id, run.UserId);
            await Task.WhenAll(workers).WaitAsync(TimeSpan.FromSeconds(10)); worker.Dispose(); await Provider.DisposeAsync(); await mongo.DisposeAsync();
        }
    }
    private sealed class StubOpenDesign(MongoDbContext db) : IDesignArtifactExecutor
    {
        public static readonly string Html = HostedSiteRevisionRules.HardenVerifiedPackageHtml("<!doctype html><html><head><link rel=\"stylesheet\" href=\"assets/theme.css\"></head><body><main><h1>已有报告</h1><p>交接三项、验证两项。</p></main></body></html>", ["index.html", "assets/theme.css", "manifest.json"]);
        public string Runtime => DesignArtifactRuntimes.OpenDesign;
        public int Calls { get; private set; }
        public bool Block { get; set; }
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Supports(string artifactType, string operation) => artifactType == DesignArtifactTypes.WebPage;
        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(DesignArtifactRun run, string? _, [EnumeratorCancellation] CancellationToken ct)
        {
            Calls++; Started.TrySetResult();
            if (Block) await Task.Delay(Timeout.Infinite, ct);
            await db.DesignArtifactRuns.UpdateOneAsync(item => item.Id == run.Id, Builders<DesignArtifactRun>.Update
                .Set(item => item.WorkspaceResultAssetKey, "test/result.json").Set(item => item.WorkspaceResultSha256, new string('a', 64))
                .Set(item => item.WorkspaceManifestSha256, new string('b', 64)));
            var files = new[] { File("index.html", Html, "text/html"), File("assets/theme.css", "body{color:#123}", "text/css"), File("manifest.json", "{}", "application/json") };
            yield return new DesignArtifactExecutorChunk("delta", Html, files);
        }
        public static DesignWorkspaceFile File(string path, string content, string mediaType)
        {
            var bytes = Encoding.UTF8.GetBytes(content);return new(path, Convert.ToBase64String(bytes), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), bytes.Length, mediaType);
        }
    }

    private static async IAsyncEnumerable<GatewayStreamChunk> DirectHtml(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        await Task.Yield();
        yield return GatewayStreamChunk.Text("<!doctype html><html><head><title>既有报告</title></head><body><h1>本机假数据</h1></body></html>");
        yield return GatewayStreamChunk.Done("stop", null);
    }
}
