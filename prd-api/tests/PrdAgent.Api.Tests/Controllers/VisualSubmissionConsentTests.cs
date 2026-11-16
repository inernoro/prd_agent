using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class VisualSubmissionConsentTests
{
    [Fact]
    [Trait("Category", "Integration")]
    public async Task DisableSurvivesReloadWithdrawsGalleryAndBlocksLaterAutoSubmission()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"visual_submission_consent_{Guid.NewGuid():N}";
        var db = new MongoDbContext(connection, name);
        var workspace = new ImageMasterWorkspace { OwnerUserId = "owner", ScenarioType = "visual-creation", CoverAssetId = "cover" };
        var asset = new ImageAsset { OwnerUserId = "owner", WorkspaceId = workspace.Id, Url = "https://example.test/one.png" };
        var laterAsset = new ImageAsset { OwnerUserId = "owner", WorkspaceId = workspace.Id, Url = "https://example.test/two.png" };
        var posted = new Submission { OwnerUserId = "owner", WorkspaceId = workspace.Id, ImageAssetId = asset.Id, ContentType = "visual" };
        var otherWorkspace = new Submission { OwnerUserId = "owner", WorkspaceId = "other", ContentType = "visual" };
        var otherOwner = new Submission { OwnerUserId = "other", WorkspaceId = workspace.Id, ContentType = "visual" };
        try
        {
            await db.ImageMasterWorkspaces.InsertOneAsync(workspace);
            await db.ImageAssets.InsertManyAsync([asset, laterAsset]);
            await db.Submissions.InsertManyAsync([posted, otherWorkspace, otherOwner]);
            var workspaces = Workspaces(db, "owner");
            Assert.IsType<OkObjectResult>(await workspaces.UpdateWorkspace(workspace.Id, new() { SuppressAutoSubmit = true }, CancellationToken.None));

            // 重新读取数据库，不能拿内存里的按钮状态自证持久化。
            var reloaded = await db.ImageMasterWorkspaces.Find(x => x.Id == workspace.Id).SingleAsync();
            Assert.True(reloaded.SuppressAutoSubmit);
            Assert.False(reloaded.IsPublic);
            Assert.Equal("cover", reloaded.CoverAssetId);
            Assert.False((await db.Submissions.Find(x => x.Id == posted.Id).SingleAsync()).IsPublic);
            Assert.True((await db.Submissions.Find(x => x.Id == otherWorkspace.Id).SingleAsync()).IsPublic);
            Assert.True((await db.Submissions.Find(x => x.Id == otherOwner.Id).SingleAsync()).IsPublic);

            var submissions = Submissions(db, "owner");
            var automatic = Data(await submissions.AutoSubmit(new() { ImageAssetIds = [asset.Id, laterAsset.Id] }));
            Assert.Equal(0, automatic.GetProperty("submitted").GetInt32());
            Assert.Equal(2, automatic.GetProperty("protectedAssets").GetInt32());
            Assert.Equal(0, await db.Submissions.CountDocumentsAsync(x => x.ImageAssetId == laterAsset.Id));
            Assert.False(Data(await submissions.CheckSubmission(asset.Id, null)).GetProperty("submitted").GetBoolean());

            // 手动重新投稿复用原记录，保留点赞；它不会顺带开启未来的自动投稿。
            var manual = Data(await submissions.AutoSubmit(new() { ImageAssetIds = [asset.Id], Trigger = "manual" }));
            Assert.Equal(1, manual.GetProperty("submitted").GetInt32());
            Assert.True((await db.Submissions.Find(x => x.Id == posted.Id).SingleAsync()).IsPublic);
            Assert.Equal(1, await db.Submissions.CountDocumentsAsync(x => x.ImageAssetId == asset.Id));
            Assert.True((await db.ImageMasterWorkspaces.Find(x => x.Id == workspace.Id).SingleAsync()).SuppressAutoSubmit);

            Assert.IsType<OkObjectResult>(await workspaces.UpdateWorkspace(workspace.Id, new() { SuppressAutoSubmit = false }, CancellationToken.None));
            Assert.False((await db.ImageMasterWorkspaces.Find(x => x.Id == workspace.Id).SingleAsync()).SuppressAutoSubmit);
            Assert.Equal(1, Data(await submissions.AutoSubmit(new() { ImageAssetIds = [laterAsset.Id] })).GetProperty("submitted").GetInt32());
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task AnotherUserCannotChangeConsentOrRepublishOwnersImages()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"visual_submission_ownership_{Guid.NewGuid():N}";
        var db = new MongoDbContext(connection, name);
        var workspace = new ImageMasterWorkspace { OwnerUserId = "owner", SuppressAutoSubmit = true };
        var asset = new ImageAsset { OwnerUserId = "owner", WorkspaceId = workspace.Id };
        var submission = new Submission { OwnerUserId = "owner", WorkspaceId = workspace.Id, ImageAssetId = asset.Id, IsPublic = false };
        try
        {
            await db.ImageMasterWorkspaces.InsertOneAsync(workspace);
            await db.ImageAssets.InsertOneAsync(asset);
            await db.Submissions.InsertOneAsync(submission);
            var forbidden = Assert.IsType<ObjectResult>(await Workspaces(db, "other").UpdateWorkspace(
                workspace.Id, new() { SuppressAutoSubmit = false }, CancellationToken.None));
            Assert.Equal(403, forbidden.StatusCode);
            Assert.Equal(0, Data(await Submissions(db, "other").AutoSubmit(new() { ImageAssetIds = [asset.Id], Trigger = "manual" })).GetProperty("submitted").GetInt32());
            Assert.True((await db.ImageMasterWorkspaces.Find(x => x.Id == workspace.Id).SingleAsync()).SuppressAutoSubmit);
            Assert.False((await db.Submissions.Find(x => x.Id == submission.Id).SingleAsync()).IsPublic);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    private static ImageMasterController Workspaces(MongoDbContext db, string owner)
        => AsUser(new ImageMasterController(db, null!, null!, null!, NullLogger<ImageMasterController>.Instance,
            null!, null!, null!, null!, null!), owner);

    private static SubmissionsController Submissions(MongoDbContext db, string owner)
        => AsUser(new SubmissionsController(db, null!, NullLogger<SubmissionsController>.Instance), owner);

    private static T AsUser<T>(T controller, string owner) where T : ControllerBase
    {
        controller.ControllerContext = new() { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, owner), new Claim("sub", owner)], "Bearer"));
        return controller;
    }

    private static JsonElement Data(IActionResult result)
        => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data");
}
