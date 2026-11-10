using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

[Trait("Category", "Integration")]
public class VisualPendingCanvasRecoveryTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MissingPendingNodeIsRecoveredFromOwnedRunWithoutRewritingStoredCanvas(bool detail)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = "visual_pending_recovery_" + Guid.NewGuid().ToString("N");
        var db = new MongoDbContext(connection, name);
        var ws = new ImageMasterWorkspace { OwnerUserId = "owner" };
        const string original = """{"schemaVersion":1,"elements":[{"id":"kept","kind":"image","src":"https://example.test/kept.png","x":30,"y":40}]}""";
        var canvas = new ImageMasterCanvas { WorkspaceId = ws.Id, OwnerUserId = "owner", PayloadJson = original };
        var pending = new ImageGenRun { OwnerAdminId = "owner", WorkspaceId = ws.Id, TargetCanvasKey = "pending", Status = ImageGenRunStatus.Running, Items = [new() { DisplayPrompt = "原请求", Prompt = "内部前缀原请求" }] };
        try
        {
            await db.ImageMasterWorkspaces.InsertOneAsync(ws);
            await db.ImageMasterCanvases.InsertOneAsync(canvas);
            await db.ImageGenRuns.InsertManyAsync([
                pending,
                new() { OwnerAdminId = "other", WorkspaceId = ws.Id, TargetCanvasKey = "other-owner", Status = ImageGenRunStatus.Running },
                new() { OwnerAdminId = "owner", WorkspaceId = "other", TargetCanvasKey = "other-workspace", Status = ImageGenRunStatus.Running },
                new() { OwnerAdminId = "owner", WorkspaceId = ws.Id, TargetCanvasKey = "completed", Status = ImageGenRunStatus.Completed },
                new() { OwnerAdminId = "owner", WorkspaceId = ws.Id, TargetCanvasKey = "kept", Status = ImageGenRunStatus.Running, AppCallerCode = AppCallerRegistry.VisualAgent.Image.Layering },
            ]);
            var controller = new ImageMasterController(db, null!, null!, null!, NullLogger<ImageMasterController>.Instance, null!, null!, null!, null!, null!);
            controller.ControllerContext = new() { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "owner"), new Claim("sub", "owner")], "Bearer")) } };
            var result = detail ? await controller.GetWorkspaceDetail(ws.Id) : await controller.GetWorkspaceCanvas(ws.Id, default);
            var data = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data");
            using var recovered = JsonDocument.Parse(data.GetProperty("canvas").GetProperty("payloadJson").GetString()!);
            var elements = recovered.RootElement.GetProperty("elements").EnumerateArray().ToArray();
            Assert.Equal(2, elements.Length);
            var node = Assert.Single(elements, x => x.GetProperty("id").GetString() == "pending");
            Assert.Equal("running", node.GetProperty("status").GetString());
            Assert.Equal(pending.Id, node.GetProperty("runId").GetString());
            Assert.Equal("原请求", node.GetProperty("name").GetString());
            Assert.Equal(30, elements[0].GetProperty("x").GetInt32());
            Assert.Equal("https://example.test/kept.png", elements[0].GetProperty("src").GetString());
            Assert.Equal(original, (await db.ImageMasterCanvases.Find(x => x.Id == canvas.Id).SingleAsync()).PayloadJson);
            Assert.Equal(5, await db.ImageGenRuns.CountDocumentsAsync(FilterDefinition<ImageGenRun>.Empty));
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }
}
