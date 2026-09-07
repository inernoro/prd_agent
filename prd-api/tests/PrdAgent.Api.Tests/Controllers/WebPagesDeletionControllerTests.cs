using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class WebPagesDeletionControllerTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Delete_WhenObjectCleanupIsPending_ShouldReturnAcceptedWithoutClaimingDeleted()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.DeleteAsync("site-a", "owner-user", CancellationToken.None))
            .ThrowsAsync(new HostedSiteDeletionPendingException("site-a", attemptCount: 2));
        var controller = BuildController(sites.Object);

        var result = await controller.Delete("site-a");

        var accepted = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status202Accepted, accepted.StatusCode);
        var payload = JsonSerializer.SerializeToElement(accepted.Value, JsonOptions);
        Assert.True(payload.GetProperty("success").GetBoolean());
        var data = payload.GetProperty("data");
        Assert.False(data.GetProperty("deleted").GetBoolean());
        Assert.True(data.GetProperty("cleanupPending").GetBoolean());
        Assert.True(data.GetProperty("retryAutomatic").GetBoolean());
        Assert.Equal(2, data.GetProperty("attemptCount").GetInt32());
    }

    [Fact]
    public async Task Delete_WhenObjectCleanupCompletes_ShouldReturnDeleted()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.DeleteAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(true);
        var controller = BuildController(sites.Object);

        var result = await controller.Delete("site-a");

        var ok = Assert.IsType<OkObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(ok.Value, JsonOptions);
        var data = payload.GetProperty("data");
        Assert.True(data.GetProperty("deleted").GetBoolean());
        Assert.False(data.GetProperty("cleanupPending").GetBoolean());
    }

    [Fact]
    public async Task BatchDelete_WhenSomeCleanupIsPending_ShouldReturnAccurateCounts()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.BatchDeleteAsync(
                It.Is<List<string>>(ids => ids.SequenceEqual(new[] { "site-a", "site-b" })),
                "owner-user",
                CancellationToken.None))
            .ThrowsAsync(new HostedSiteDeletionPendingException(
                "site-b",
                attemptCount: 1,
                completedCount: 1,
                pendingCount: 1));
        var controller = BuildController(sites.Object);

        var result = await controller.BatchDelete(new BatchDeleteRequest
        {
            Ids = new List<string> { "site-a", "site-b" },
        });

        var accepted = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status202Accepted, accepted.StatusCode);
        var data = JsonSerializer.SerializeToElement(accepted.Value, JsonOptions).GetProperty("data");
        Assert.Equal(1, data.GetProperty("deletedCount").GetInt32());
        Assert.Equal(1, data.GetProperty("cleanupPendingCount").GetInt32());
        Assert.True(data.GetProperty("retryAutomatic").GetBoolean());
    }

    private static WebPagesController BuildController(IHostedSiteService sites)
    {
        var controller = new WebPagesController(
            sites,
            Mock.Of<IUploadProgressService>(),
            new MongoDbContext(
                "mongodb://127.0.0.1:27017",
                $"web_page_delete_unit_{Guid.NewGuid():N}"),
            Mock.Of<ITeamService>(),
            Mock.Of<IHttpClientFactory>());
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("sub", "owner-user") },
                    "test")),
            },
        };
        return controller;
    }
}
