using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Moq;
using System.Security.Claims;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 生成任务的目标空间在**创建请求**这一刻冻结，并在同一刻校验（Codex P2，2026-09-15）。
///
/// 此前归属只活在浏览器的完成回调里：用户在终态事件到达前关掉页面或切走，服务端照样把
/// 站点生成完，但它会留在个人空间；换个标签页恢复也重建不出原来的目标。
///
/// 校验必须排在这里——用户还在场，不通过可以当场告诉他。推迟到建站时才校验，用户多半已经
/// 走了，剩下的只有「静默落回个人空间」这一种结局。
/// </summary>
public sealed class GenerationDestinationFreezeTests
{
    private static DesignArtifactsController BuildController(IHostedSiteService sites)
    {
        var controller = new DesignArtifactsController(
            null!,
            Mock.Of<IRunEventStore>(),
            Mock.Of<IRunQueue>(),
            Mock.Of<IDesignArtifactProviderCatalog>(),
            Mock.Of<IDesignKnowledgeSnapshotResolver>(),
            null!,
            Mock.Of<IDesignArtifactCancellationCoordinator>(),
            new ConfigurationBuilder().Build(),
            sites);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "user-1")], "test")),
            },
        };
        return controller;
    }

    private static CreateDesignArtifactRunRequest Request(string? destinationTeamId) => new()
    {
        ArtifactType = DesignArtifactTypes.WebPage,
        Instruction = "给销售同事做一页产品说明",
        DestinationTeamId = destinationTeamId,
        KnowledgeReferences = [new() { EntryId = "entry-1", StoreId = "store-1" }],
    };

    [Fact]
    public async Task RejectsDestinationTheUserCannotPublishInto()
    {
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(x => x.CanPublishIntoTeamAsync("user-1", "team-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(false);

        var result = await BuildController(sites.Object).CreateRun(Request("team-1"));

        var denied = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, denied.StatusCode);
        sites.Verify(
            x => x.CanPublishIntoTeamAsync("user-1", "team-1", It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task DoesNotAskAboutPermissionWhenGeneratingIntoPersonalSpace()
    {
        // Strict：个人空间这条路一次都不许去问团队权限，问了就当场失败。
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);

        var result = await BuildController(sites.Object).CreateRun(Request(null));

        // 这一关放行了（后面会因为别的原因停下，但绝不是 403 目标空间）。
        if (result is ObjectResult objectResult)
            Assert.NotEqual(403, objectResult.StatusCode);
        sites.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ChecksPermissionBeforeResolvingKnowledge()
    {
        // 校验必须排在知识解析之前：既省掉一次白做的解析，也保证「不许放进这个空间」
        // 是用户按下发起时立刻得到的答复，而不是等一圈之后的模糊失败。
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(x => x.CanPublishIntoTeamAsync("user-1", "team-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(false);

        var controller = new DesignArtifactsController(
            null!,
            Mock.Of<IRunEventStore>(),
            Mock.Of<IRunQueue>(),
            Mock.Of<IDesignArtifactProviderCatalog>(),
            knowledge.Object,
            null!,
            Mock.Of<IDesignArtifactCancellationCoordinator>(),
            new ConfigurationBuilder().Build(),
            sites.Object);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "user-1")], "test")),
            },
        };

        var denied = Assert.IsType<ObjectResult>(await controller.CreateRun(Request("team-1")));
        Assert.Equal(403, denied.StatusCode);
        knowledge.VerifyNoOtherCalls();
    }
}
