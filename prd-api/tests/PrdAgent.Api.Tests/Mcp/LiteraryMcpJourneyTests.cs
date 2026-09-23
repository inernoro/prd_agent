using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public class LiteraryMcpJourneyTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SupersededFailureCannotChangeCurrentMarker(bool hasPreviousImage)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"literary_mcp_failure_{Guid.NewGuid():N}";
        var db = new MongoDbContext(connection, name);
        using var services = new ServiceCollection().BuildServiceProvider();
        var worker = new ImageGenRunWorker(db, services.GetRequiredService<IServiceScopeFactory>(),
            new InMemoryRunEventStore(), NullLogger<ImageGenRunWorker>.Instance,
            new LLMRequestContextAccessor(), new ConfigurationBuilder().Build());
        try
        {
            var workspace = new ImageMasterWorkspace
            {
                OwnerUserId = "writer",
                ArticleWorkflow = new() { Version = 1, Markers = new() { new() { Status = "running", RunId = "new-run", AssetId = hasPreviousImage ? "prior-asset" : null } } },
            };
            await db.ImageMasterWorkspaces.InsertOneAsync(workspace);
            var run = new ImageGenRun { Id = "old-run", WorkspaceId = workspace.Id, ArticleMarkerIndex = 0, ArticleWorkflowVersion = 1 };
            await worker.TryPatchArticleMarkerAsync(run, "error", "旧任务失败", null, null, CancellationToken.None);
            var marker = (await db.ImageMasterWorkspaces.Find(x => x.Id == workspace.Id).SingleAsync()).ArticleWorkflow!.Markers[0];
            Assert.Equal("running", marker.Status);
            Assert.Equal("new-run", marker.RunId);
            Assert.Null(marker.ErrorMessage);
            run.Id = "new-run";
            await worker.TryPatchArticleMarkerAsync(run, "error", "当前任务失败", null, null, CancellationToken.None);
            marker = (await db.ImageMasterWorkspaces.Find(x => x.Id == workspace.Id).SingleAsync()).ArticleWorkflow!.Markers[0];
            Assert.Equal(hasPreviousImage ? "done" : "error", marker.Status);
            Assert.Equal(hasPreviousImage ? null : "当前任务失败", marker.ErrorMessage);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task CreateGenerateReplayReadAndMoveAreOwnedAndVersioned()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"literary_mcp_journey_{Guid.NewGuid():N}";
        var db = new MongoDbContext(connection, name);
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var images = WithUser(new LiteraryImageOpenApiController(db, new FixedModelSelection()), "writer");
            Assert.IsType<BadRequestObjectResult>(await images.Move("missing", new() { FolderName = new string('夹', 81) }));
            Assert.IsType<BadRequestObjectResult>(await images.Generate("missing", new()
            {
                MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = new string('k', 201),
            }, CancellationToken.None));
            var created = Data(await drafts.CreateWorkspace(new()
            {
                Title = "验收文章", MarkedContent = "第一段。\n[插图]: 书店\n第二段。\n[插图]: 茶杯\n",
                FolderName = "初稿", ClientRequestId = "draft-1",
            }, CancellationToken.None));
            var id = created.GetProperty("workspaceId").GetString()!;
            Assert.Equal(id, Data(await drafts.CreateWorkspace(new() { ClientRequestId = "draft-1" }, CancellationToken.None))
                .GetProperty("workspaceId").GetString());
            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None));
            Assert.Equal(2, read.GetProperty("illustrations").GetArrayLength());
            Assert.Equal("初稿", read.GetProperty("folderName").GetString());
            // 真实文学详情接口不能把先落库的第二张/旧版图猜填到第一个标记。
            await db.ImageAssets.InsertOneAsync(new()
            {
                OwnerUserId = "writer", WorkspaceId = id, ArticleWorkflowVersion = 1,
                ArticleInsertionIndex = 1, Url = "https://example.test/second.png",
            });
            await db.ImageAssets.InsertOneAsync(new()
            {
                OwnerUserId = "writer", WorkspaceId = id, ArticleWorkflowVersion = 0,
                ArticleInsertionIndex = 0, Url = "https://example.test/stale.png",
            });
            // 无需先打开网页：只读图文导出也能精确恢复已保存但未写指针的当前版本资产。
            var recoveredRead = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None, "illustrated"));
            Assert.Contains("![配图 2](<https://example.test/second.png>)", recoveredRead.GetProperty("content").GetString());
            Assert.DoesNotContain("stale.png", recoveredRead.GetProperty("content").GetString());
            Assert.Empty((await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).ArticleWorkflow!.AssetIdByMarkerIndex);
            var ui = WithUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "writer");
            ui.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "writer") }, "Bearer"));
            Assert.IsType<OkObjectResult>(await ui.GetWorkspaceDetail(id));
            var beforeRun = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            Assert.Single(beforeRun.ArticleWorkflow!.AssetIdByMarkerIndex);
            Assert.True(beforeRun.ArticleWorkflow.AssetIdByMarkerIndex.ContainsKey("1"));
            Assert.Equal("idle", beforeRun.ArticleWorkflow.Markers[0].Status);
            Assert.Equal("done", beforeRun.ArticleWorkflow.Markers[1].Status);
            var request = new LiteraryImageOpenApiController.GenerateRequest { MarkerIndex = 1, WorkflowVersion = 1, ClientRequestId = "image-1" };
            // 仅隔离测试数据库拒绝入队写入，真实复现认领成功但 InsertOne 失败。
            var database = new MongoClient(connection).GetDatabase(name);
            await database.CreateCollectionAsync("image_gen_runs");
            await database.RunCommandAsync<BsonDocument>(new BsonDocument
            {
                { "collMod", "image_gen_runs" },
                { "validator", new BsonDocument("acceptanceRejectInsert", true) },
            });
            await Assert.ThrowsAsync<MongoWriteException>(() => images.Generate(id, request, CancellationToken.None));
            var rejected = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            Assert.Equal("error", rejected.ArticleWorkflow!.Markers[1].Status);
            Assert.Contains("重新生成", rejected.ArticleWorkflow.Markers[1].ErrorMessage);
            Assert.Equal(0, await db.ImageGenRuns.CountDocumentsAsync(x => x.WorkspaceId == id));
            await database.RunCommandAsync<BsonDocument>(new BsonDocument
            {
                { "collMod", "image_gen_runs" }, { "validator", new BsonDocument() },
            });
            var jobs = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => images.Generate(id, request, CancellationToken.None)));
            var runId = Data(jobs[0]).GetProperty("runId").GetString()!;
            Assert.All(jobs, job => Assert.Equal(runId, Data(job).GetProperty("runId").GetString()));
            Assert.Equal(1, await db.ImageGenRuns.CountDocumentsAsync(x => x.WorkspaceId == id));
            var run = await db.ImageGenRuns.Find(x => x.Id == runId).SingleAsync();
            Assert.Equal("literary-agent", run.AppKey);
            Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, run.AppCallerCode);
            Assert.Equal(1, run.ArticleWorkflowVersion);
            Assert.Equal(1, run.Total);
            Assert.Equal("gpt-image-2", run.LogicalModelPublicId);
            // 并发重试读不到 run 的极短窗口，也不能覆盖同一 run 的终态显示。
            await db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == id,
                Builders<ImageMasterWorkspace>.Update.Set("articleWorkflow.markers.1.status", "done"));
            Assert.True(await images.ClaimWorkflowAsync(beforeRun, run));
            await images.CompensateMissingRunAsync(run);
            Assert.Equal("done", (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).ArticleWorkflow!.Markers[1].Status);
            Assert.IsType<ConflictObjectResult>(await images.Generate(id, new() { MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = "image-1" }, CancellationToken.None));
            Assert.IsType<ConflictObjectResult>(await images.Generate(id, new() { MarkerIndex = 0, WorkflowVersion = 9, ClientRequestId = "image-stale" }, CancellationToken.None));
            var other = WithUser(new LiteraryImageOpenApiController(db, new FixedModelSelection()), "other");
            Assert.IsType<NotFoundObjectResult>(await other.Generate(id, request, CancellationToken.None));
            Assert.IsType<NotFoundObjectResult>(await other.GetRun(runId, CancellationToken.None));
            Assert.IsType<NotFoundObjectResult>(await other.Move(id, new() { FolderName = "别人的文件夹" }));

            Assert.False(Data(await images.GetRun(runId, CancellationToken.None)).GetProperty("finished").GetBoolean());
            await db.ImageGenRuns.UpdateOneAsync(x => x.Id == runId,
                Builders<ImageGenRun>.Update.Set(x => x.Status, ImageGenRunStatus.Cancelled));
            Assert.True(Data(await images.GetRun(runId, CancellationToken.None)).GetProperty("finished").GetBoolean());
            Assert.Equal(runId, Data(await images.Generate(id, request, CancellationToken.None)).GetProperty("runId").GetString());
            await images.Move(id, new() { FolderName = "验收归档" });
            await images.Move(id, new() { FolderName = "验收归档" });
            Assert.Equal(1, await db.ImageMasterWorkspaces.CountDocumentsAsync(x => x.OwnerUserId == "writer"));
            Assert.Equal("验收归档", Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None)).GetProperty("folderName").GetString());

            await db.ReferenceImageConfigs.InsertOneAsync(new() { AppKey = "literary-agent", CreatedByAdminId = "writer", IsActive = true, ImageSha256 = "abc", Prompt = "水彩风格" });
            var refId = Data(await images.Generate(id, new() { MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = "image-ref" }, CancellationToken.None)).GetProperty("runId").GetString();
            var refRun = await db.ImageGenRuns.Find(x => x.Id == refId).SingleAsync();
            Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Img2Img, refRun.AppCallerCode);
            Assert.StartsWith("水彩风格", refRun.Items[0].Prompt);
            // 精确复现初读与认领间改版：认领失败，不发布任何可执行任务。
            var snapshot = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            await db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == id,
                Builders<ImageMasterWorkspace>.Update.Inc(x => x.ArticleWorkflow!.Version, 1));
            Assert.False(await images.ClaimWorkflowAsync(snapshot, refRun));
            Assert.Equal(2, await db.ImageGenRuns.CountDocumentsAsync(x => x.WorkspaceId == id));
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task McpWorkspaceStaysPrivateUntilManualSubmitAndDeleteCascades()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"literary_mcp_privacy_{Guid.NewGuid():N}";
        var db = new MongoDbContext(connection, name);
        try
        {
            var assetStorage = new Mock<PrdAgent.Infrastructure.Services.AssetStorage.IAssetStorage>();
            var concurrentReferenceSha = new string('d', 64);
            Task<bool> cleanupTask;
            await using (var writerLease = await VideoAssetMutationLease.AcquireAsync(
                             db,
                             $"generated-image:{concurrentReferenceSha}",
                             CancellationToken.None))
            {
                var deletionService = new ImageMasterWorkspaceDeletionService(
                    db,
                    assetStorage.Object,
                    NullLogger.Instance);
                cleanupTask = deletionService.TryDeleteUnreferencedGeneratedImageAsync(
                    concurrentReferenceSha,
                    CancellationToken.None);
                await Task.Delay(150);
                Assert.False(cleanupTask.IsCompleted, cleanupTask.Exception?.ToString());
                await db.ReferenceImageConfigs.InsertOneAsync(new ReferenceImageConfig
                {
                    AppKey = "literary-agent",
                    CreatedByAdminId = "writer",
                    ImageSha256 = concurrentReferenceSha,
                });
            }
            Assert.False(await cleanupTask);
            await db.Users.InsertManyAsync([
                new User
                {
                    UserId = "writer",
                    Username = "writer",
                    DisplayName = "Writer",
                },
                new User
                {
                    UserId = "recipient",
                    Username = "recipient",
                    DisplayName = "Recipient",
                },
            ]);
            var openApi = WithUser(new LiteraryOpenApiController(db), "writer");
            var created = Data(await openApi.CreateWorkspace(new()
            {
                Title = "私有验收文章",
                Content = "这篇文章由 MCP 创建。",
                ClientRequestId = "privacy-1",
            }, CancellationToken.None));
            var workspaceId = created.GetProperty("workspaceId").GetString()!;
            var workspace = await db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId).SingleAsync();
            Assert.True(workspace.SuppressAutoSubmit);
            Assert.False(workspace.IsPublic);
            await db.ImageAssets.InsertOneAsync(new ImageAsset
            {
                OwnerUserId = "writer",
                WorkspaceId = workspaceId,
                Url = "https://example.test/private-cover.png",
            });

            var cloneResult = await new WorkspaceCloneService(
                db,
                NullLogger<WorkspaceCloneService>.Instance).CloneAsync(
                workspaceId,
                "recipient",
                CancellationToken.None);
            var clonedWorkspace = await db.ImageMasterWorkspaces
                .Find(x => x.Id == cloneResult.NewWorkspaceId)
                .SingleAsync();
            Assert.True(clonedWorkspace.SuppressAutoSubmit);
            Assert.False(clonedWorkspace.IsPublic);

            var submissions = WithAdminUser(new SubmissionsController(db, null!), "writer");
            var migration = Data(await submissions.MigrateLiterarySubmissions("writer"));
            Assert.Equal(1, migration.GetProperty("protectedWorkspaces").GetInt32());
            Assert.Equal(0, migration.GetProperty("newlySubmitted").GetInt32());
            var recipientMigration = Data(await submissions.MigrateLiterarySubmissions("recipient"));
            Assert.Equal(1, recipientMigration.GetProperty("protectedWorkspaces").GetInt32());
            Assert.Equal(0, recipientMigration.GetProperty("newlySubmitted").GetInt32());
            var legacyClientResult = await submissions.CreateSubmission(new()
            {
                ContentType = "literary",
                WorkspaceId = workspaceId,
            });
            Assert.IsType<ConflictObjectResult>(legacyClientResult);
            Assert.Equal(0, await db.Submissions.CountDocumentsAsync(x => x.WorkspaceId == workspaceId));
            Assert.False((await db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId).SingleAsync()).IsPublic);

            await db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == workspaceId,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.SuppressAutoSubmit, false));
            await db.McpCallLogs.InsertOneAsync(new McpCallLog
            {
                OwnerUserId = "writer",
                ToolName = "map_literary_create_workspace",
                Status = "success",
                KeyId = "legacy-direct-key",
                HttpStatus = 200,
                ArgumentsPreview = "直连 POST /api/open/literary/workspaces",
                CreatedAt = workspace.CreatedAt.AddMilliseconds(-10),
                DurationMs = 100,
            });
            var workspaceApi = WithAdminUser(
                new LiteraryAgentWorkspaceController(db, assetStorage.Object, NullLogger<LiteraryAgentWorkspaceController>.Instance),
                "writer");
            Assert.IsType<OkObjectResult>(await workspaceApi.GetWorkspaceDetail(workspaceId));
            Assert.True((await db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId).SingleAsync()).SuppressAutoSubmit);

            var ambiguousAt = DateTime.UtcNow;
            var ambiguousFirst = new ImageMasterWorkspace
            {
                OwnerUserId = "ambiguous",
                ScenarioType = "article-illustration",
                CreatedAt = ambiguousAt,
            };
            var ambiguousSecond = new ImageMasterWorkspace
            {
                OwnerUserId = "ambiguous",
                ScenarioType = "article-illustration",
                CreatedAt = ambiguousAt.AddMilliseconds(10),
            };
            await db.ImageMasterWorkspaces.InsertManyAsync([ambiguousFirst, ambiguousSecond]);
            await db.McpCallLogs.InsertOneAsync(new McpCallLog
            {
                OwnerUserId = "ambiguous",
                ToolName = "map_literary_create_workspace",
                Status = "success",
                KeyId = "ambiguous-direct-key",
                HttpStatus = 200,
                ArgumentsPreview = "直连 POST /api/open/literary/workspaces",
                CreatedAt = ambiguousAt.AddMilliseconds(-10),
                DurationMs = 100,
            });
            Assert.False(await LiteraryWorkspacePublicationPolicy.ResolveSuppressAutoSubmitAsync(
                db,
                ambiguousFirst,
                CancellationToken.None));
            Assert.False((await db.ImageMasterWorkspaces.Find(x => x.Id == ambiguousFirst.Id).SingleAsync()).SuppressAutoSubmit);

            await db.McpCallLogs.DeleteOneAsync(x => x.KeyId == "legacy-direct-key");
            await db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == workspaceId,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.SuppressAutoSubmit, false));
            await db.McpCallLogs.InsertOneAsync(new McpCallLog
            {
                OwnerUserId = "writer",
                ToolName = "map_literary_create_workspace",
                Status = "success",
                ArtifactKind = "workspace",
                ArtifactId = workspaceId,
            });
            var autoResult = await submissions.CreateSubmission(new()
            {
                ContentType = "literary",
                WorkspaceId = workspaceId,
                Trigger = "auto",
            });
            Assert.IsType<ConflictObjectResult>(autoResult);
            Assert.True((await db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId).SingleAsync()).SuppressAutoSubmit);

            var manualResult = await submissions.CreateSubmission(new()
            {
                ContentType = "literary",
                WorkspaceId = workspaceId,
                Trigger = "manual",
            });
            Assert.IsType<OkObjectResult>(manualResult);
            var submission = await db.Submissions.Find(x => x.WorkspaceId == workspaceId).SingleAsync();
            Assert.True((await db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId).SingleAsync()).IsPublic);

            var runId = Guid.NewGuid().ToString("N");
            await db.ImageGenRuns.InsertOneAsync(new ImageGenRun
            {
                Id = runId,
                OwnerAdminId = "writer",
                WorkspaceId = workspaceId,
                Status = ImageGenRunStatus.Running,
            });
            await db.ImageGenRunItems.InsertOneAsync(new ImageGenRunItem
            {
                OwnerAdminId = "writer",
                RunId = runId,
            });
            await db.ImageGenRunEvents.InsertOneAsync(new ImageGenRunEvent
            {
                OwnerAdminId = "writer",
                RunId = runId,
                Seq = 1,
            });
            await db.UploadArtifacts.InsertOneAsync(new UploadArtifact
            {
                RequestId = $"{runId}-0-0",
                CreatedByAdminId = "writer",
            });
            var sharedSha = new string('a', 64);
            await db.ImageAssets.InsertOneAsync(new ImageAsset
            {
                OwnerUserId = "writer",
                WorkspaceId = workspaceId,
                Sha256 = sharedSha,
            });
            var otherWorkspace = new ImageMasterWorkspace { OwnerUserId = "writer", Title = "保留的工作区" };
            await db.ImageMasterWorkspaces.InsertOneAsync(otherWorkspace);
            await db.ImageAssets.InsertOneAsync(new ImageAsset
            {
                OwnerUserId = "writer",
                WorkspaceId = otherWorkspace.Id,
                Sha256 = sharedSha,
            });
            var referenceConfigSha = new string('b', 64);
            await db.ImageAssets.InsertOneAsync(new ImageAsset
            {
                OwnerUserId = "writer",
                WorkspaceId = workspaceId,
                Sha256 = referenceConfigSha,
            });
            await db.ReferenceImageConfigs.InsertOneAsync(new ReferenceImageConfig
            {
                AppKey = "literary-agent",
                CreatedByAdminId = "writer",
                ImageSha256 = referenceConfigSha,
            });
            var legacyConfigSha = new string('c', 64);
            await db.ImageAssets.InsertOneAsync(new ImageAsset
            {
                OwnerUserId = "writer",
                WorkspaceId = workspaceId,
                Sha256 = legacyConfigSha,
            });
            await db.LiteraryAgentConfigs.InsertOneAsync(new LiteraryAgentConfig
            {
                Id = "literary-agent",
                ReferenceImageSha256 = legacyConfigSha,
            });
            await db.ImageMasterMessages.InsertOneAsync(new ImageMasterMessage
            {
                OwnerUserId = "writer",
                WorkspaceId = workspaceId,
            });
            await db.ImageMasterCanvases.InsertOneAsync(new ImageMasterCanvas
            {
                OwnerUserId = "writer",
                WorkspaceId = workspaceId,
            });
            await db.SubmissionLikes.InsertOneAsync(new SubmissionLike
            {
                SubmissionId = submission.Id,
                UserId = "reader",
            });
            Assert.IsType<ConflictObjectResult>(await workspaceApi.DeleteWorkspace(workspaceId, CancellationToken.None));
            Assert.Equal(1, await db.ImageMasterWorkspaces.CountDocumentsAsync(x => x.Id == workspaceId));
            Assert.Equal(1, await db.Submissions.CountDocumentsAsync(x => x.Id == submission.Id));

            await db.ImageGenRuns.UpdateOneAsync(
                x => x.Id == runId,
                Builders<ImageGenRun>.Update.Set(x => x.Status, ImageGenRunStatus.Cancelled));
            Assert.IsType<OkObjectResult>(await workspaceApi.DeleteWorkspace(workspaceId, CancellationToken.None));

            Assert.Equal(0, await db.ImageMasterWorkspaces.CountDocumentsAsync(x => x.Id == workspaceId));
            Assert.Equal(0, await db.ImageAssets.CountDocumentsAsync(x => x.WorkspaceId == workspaceId));
            Assert.Equal(0, await db.ImageMasterMessages.CountDocumentsAsync(x => x.WorkspaceId == workspaceId));
            Assert.Equal(0, await db.ImageMasterCanvases.CountDocumentsAsync(x => x.WorkspaceId == workspaceId));
            Assert.Equal(0, await db.Submissions.CountDocumentsAsync(x => x.Id == submission.Id));
            Assert.Equal(0, await db.SubmissionLikes.CountDocumentsAsync(x => x.SubmissionId == submission.Id));
            Assert.Equal(0, await db.ImageGenRuns.CountDocumentsAsync(x => x.Id == runId));
            Assert.Equal(0, await db.ImageGenRunItems.CountDocumentsAsync(x => x.RunId == runId));
            Assert.Equal(0, await db.ImageGenRunEvents.CountDocumentsAsync(x => x.RunId == runId));
            Assert.Equal(0, await db.UploadArtifacts.CountDocumentsAsync(x => x.RequestId == $"{runId}-0-0"));
            Assert.Equal(0, await db.UserRecentOpens.CountDocumentsAsync(x => x.EntityId == workspaceId));
            Assert.Equal(1, await db.ImageMasterWorkspaces.CountDocumentsAsync(x => x.Id == otherWorkspace.Id));
            Assert.Equal(1, await db.ImageMasterWorkspaces.CountDocumentsAsync(x => x.Id == cloneResult.NewWorkspaceId && x.SuppressAutoSubmit));
            Assert.Equal(1, await db.ImageAssets.CountDocumentsAsync(x => x.WorkspaceId == otherWorkspace.Id && x.Sha256 == sharedSha));
            Assert.Equal(1, await db.ReferenceImageConfigs.CountDocumentsAsync(x => x.ImageSha256 == referenceConfigSha));
            Assert.Equal(1, await db.LiteraryAgentConfigs.CountDocumentsAsync(x => x.ReferenceImageSha256 == legacyConfigSha));
            assetStorage.Verify(
                x => x.DeleteByShaAsync(
                    It.IsAny<string>(),
                    It.IsAny<CancellationToken>(),
                    It.IsAny<string?>(),
                    It.IsAny<string?>()),
                Times.Never);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public void LiteraryImageToolsHaveQuotaAndArtifactSemantics()
    {
        var generate = McpBuiltinTools.All.Single(x => x.Name == "map_literary_generate_image");
        Assert.True(McpUsageService.IsImageTool(generate));
        Assert.Equal(McpCapabilityCatalog.ScopeLiteraryUse, generate.RequiredScope);
        Assert.Equal(generate, McpBuiltinTools.MatchRouteTemplate("POST", "api/open/literary/workspaces/{workspaceId}/images"));
        var artifact = McpArtifactExtractor.Extract("map_literary_get_image_run", false,
            "{\"data\":{\"runId\":\"run1\",\"finished\":true,\"images\":[{\"url\":\"https://example.test/image.png\"}]}}");
        Assert.Equal("image-run", artifact.Kind);
        Assert.Equal("https://example.test/image.png", artifact.Url);
    }

    private static T WithUser<T>(T controller, string id) where T : ControllerBase
    {
        controller.ControllerContext = new() { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("boundUserId", id), new Claim("agentApiKeyId", "key-" + id),
            new Claim("scope", McpCapabilityCatalog.ScopeLiteraryUse),
        }, "ApiKey"));
        controller.Request.Scheme = "https";
        controller.Request.Host = new HostString("example.test");
        return controller;
    }

    private static T WithAdminUser<T>(T controller, string id) where T : ControllerBase
    {
        controller.ControllerContext = new() { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("sub", id),
            new Claim(ClaimTypes.NameIdentifier, id),
        }, "Bearer"));
        return controller;
    }

    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(
        Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value).Data);

    private sealed class FixedModelSelection : ILiteraryMcpModelSelectionService
    {
        public Task<LiteraryMcpModelSelection> ResolveForRunAsync(
            string ownerUserId, string agentApiKeyId, string appCallerCode, CancellationToken ct)
            => Task.FromResult(LiteraryMcpModelSelection.Selected("gpt-image-2"));

        public Task<LiteraryMcpModelSelection> ValidateFixedModelAsync(string logicalModelPublicId, CancellationToken ct)
            => Task.FromResult(LiteraryMcpModelSelection.Selected(logicalModelPublicId));
    }
}
