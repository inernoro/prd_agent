using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public class LiteraryMcpJourneyTests
{
    [Fact]
    public async Task CreateGenerateReplayReadAndMoveAreOwnedAndVersioned()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"literary_mcp_journey_{Guid.NewGuid():N}";
        var db = new MongoDbContext(connection, name);
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var images = WithUser(new LiteraryImageOpenApiController(db), "writer");
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
            var request = new LiteraryImageOpenApiController.GenerateRequest { MarkerIndex = 1, WorkflowVersion = 1, ClientRequestId = "image-1" };
            var jobs = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => images.Generate(id, request, CancellationToken.None)));
            var runId = Data(jobs[0]).GetProperty("runId").GetString()!;
            Assert.All(jobs, job => Assert.Equal(runId, Data(job).GetProperty("runId").GetString()));
            Assert.Equal(1, await db.ImageGenRuns.CountDocumentsAsync(x => x.WorkspaceId == id));
            var run = await db.ImageGenRuns.Find(x => x.Id == runId).SingleAsync();
            Assert.Equal("literary-agent", run.AppKey);
            Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, run.AppCallerCode);
            Assert.Equal(1, run.ArticleWorkflowVersion);
            Assert.Equal(1, run.Total);
            Assert.IsType<ConflictObjectResult>(await images.Generate(id, new() { MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = "image-1" }, CancellationToken.None));
            Assert.IsType<ConflictObjectResult>(await images.Generate(id, new() { MarkerIndex = 0, WorkflowVersion = 9, ClientRequestId = "image-stale" }, CancellationToken.None));
            var other = WithUser(new LiteraryImageOpenApiController(db), "other");
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

    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(
        Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value).Data);
}
