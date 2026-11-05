using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ShortVideoRunCleanupTests
{
    [Theory]
    [InlineData("queued", false)]
    [InlineData("running", false)]
    [InlineData("done", true)]
    [InlineData("failed", true)]
    public async Task Cleanup_OnlyDeletesOwnedTerminalRunAndPreservesStoredMaterial(string status, bool deletable)
    {
        await using var fixture = await RunMongoFixture.CreateAsync("short_video_cleanup");
        var run = new ShortVideoMaterialRun { UserId = "owner", Status = status };
        var foreign = new ShortVideoMaterialRun { UserId = "another-owner", Status = "done" };
        var material = new DocumentStore { OwnerId = "owner", Name = "stsmk-短视频素材" };
        run.StoreId = material.Id;
        await fixture.Db.ShortVideoMaterialRuns.InsertManyAsync([run, foreign]);
        await fixture.Db.DocumentStores.InsertOneAsync(material);
        var controller = new ShortVideoMaterialController(fixture.Db, null!, new ConfigurationBuilder().Build(),
            null!, NullLogger<ShortVideoMaterialController>.Instance)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "owner")], "test"))
                }
            }
        };

        Assert.IsType<NotFoundObjectResult>(await controller.DeleteRun(foreign.Id));
        Assert.NotNull(await fixture.Db.ShortVideoMaterialRuns.Find(x => x.Id == foreign.Id).FirstOrDefaultAsync());
        var response = await controller.DeleteRun(run.Id);
        if (deletable)
        {
            Assert.IsType<OkObjectResult>(response);
            Assert.Null(await fixture.Db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync());
            Assert.IsType<NotFoundObjectResult>(await controller.GetRun(run.Id));
            Assert.IsType<NotFoundObjectResult>(await controller.DeleteRun(run.Id));
        }
        else
        {
            Assert.IsType<ConflictObjectResult>(response);
            Assert.NotNull(await fixture.Db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync());
        }
        Assert.NotNull(await fixture.Db.DocumentStores.Find(x => x.Id == material.Id).FirstOrDefaultAsync());
    }
}
