using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class InfraAgentSessionsControllerTests
{
    [Fact]
    public void HasRecentHealthyProbe_ShouldTreatRecentlyProbedConnectionAsUsable()
    {
        // 871ab45 把判定改成看 LongTokenExpiresAt 是否在未来，原测试只塞 LastProbedAt
        // 已经过时（PR #612 在合并 main 后修）。LastProbeOk + 未过期 token = "可用"。
        var connection = new InfraConnection
        {
            Status = "revoked",
            LastProbeOk = true,
            LastProbedAt = DateTime.UtcNow.AddMinutes(-1),
            // HasRecentHealthyProbe 同时校验 LongTokenExpiresAt > UtcNow；
            // 不设则默认 DateTime.MinValue → 断言 false。补 setup 让两者自洽。
            LongTokenExpiresAt = DateTime.UtcNow.AddDays(1),
        };

        InfraAgentSessionService.HasRecentHealthyProbe(connection).ShouldBeTrue();
    }

    [Fact]
    public async Task Create_ShouldReturnCreated_AndUseCurrentUser()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var request = new CreateInfraAgentSessionRequest("conn-1", null, null, "测试会话", null, null);
        var expected = BuildSessionView("session-1", "user-1");

        service
            .Setup(x => x.CreateAsync("user-1", request, It.IsAny<CancellationToken>()))
            .ReturnsAsync(expected);

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Create(request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status201Created);
        service.Verify(x => x.CreateAsync("user-1", request, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task Create_ShouldMapDomainErrorToHttpStatus()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var request = new CreateInfraAgentSessionRequest("conn-1", null, null, null, null, null);

        service
            .Setup(x => x.CreateAsync("user-1", request, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotActive,
                "CDS 连接不可用，请先探活或重新授权",
                StatusCodes.Status409Conflict));

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Create(request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status409Conflict);
    }

    [Fact]
    public async Task Get_ShouldReturnNotFound_WhenSessionDoesNotBelongToUser()
    {
        var service = new Mock<IInfraAgentSessionService>();
        service
            .Setup(x => x.GetAsync("user-1", "session-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync((InfraAgentSessionView?)null);

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Get("session-1", CancellationToken.None);

        result.ShouldBeOfType<NotFoundObjectResult>();
    }

    [Fact]
    public async Task Archive_ShouldMapRunningSessionError()
    {
        var service = new Mock<IInfraAgentSessionService>();
        service
            .Setup(x => x.ArchiveAsync("user-1", "session-1", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.SessionStillRunning,
                "运行中的远程会话需要先停止，再归档",
                StatusCodes.Status409Conflict));

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Archive("session-1", CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status409Conflict);
    }

    [Fact]
    public async Task Stop_ShouldMapDomainError()
    {
        var service = new Mock<IInfraAgentSessionService>();
        service
            .Setup(x => x.StopAsync("user-1", "session-1", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotActive,
                "CDS 系统级授权已撤销，请删除后重新授权",
                StatusCodes.Status409Conflict));

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Stop("session-1", CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status409Conflict);
    }

    [Fact]
    public async Task Start_ShouldMapRuntimeUnavailableToServiceUnavailable()
    {
        var service = new Mock<IInfraAgentSessionService>();
        service
            .Setup(x => x.StartAsync("user-1", "session-1", It.IsAny<StartInfraAgentSessionRequest>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.RuntimeUnavailable,
                "CDS Agent runtime pool 不可用：adapter=legacy-sidecar-adapter, instances=0, healthy=0",
                StatusCodes.Status503ServiceUnavailable));

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Start("session-1", new StartInfraAgentSessionRequest(null, null), CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status503ServiceUnavailable);
    }

    [Fact]
    public async Task SendMessage_ShouldMapRuntimeUnavailableToServiceUnavailable()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var request = new SendInfraAgentMessageRequest("请检查当前仓库");
        service
            .Setup(x => x.SendMessageAsync("user-1", "session-1", request, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.RuntimeUnavailable,
                "CDS Agent runtime pool 不可用：adapter=legacy-sidecar-adapter, instances=0, healthy=0",
                StatusCodes.Status503ServiceUnavailable));

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.SendMessage("session-1", request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status503ServiceUnavailable);
    }

    [Fact]
    public async Task CollectArtifacts_ShouldReturnSession()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var expected = BuildSessionView("session-1", "user-1");
        service
            .Setup(x => x.CollectArtifactsAsync("user-1", "session-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(expected);

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.CollectArtifacts("session-1", CancellationToken.None);

        var objectResult = result.ShouldBeOfType<OkObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status200OK);
        service.Verify(x => x.CollectArtifactsAsync("user-1", "session-1", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task RunReadonlyChecks_ShouldReturnSession()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var expected = BuildSessionView("session-1", "user-1");
        service
            .Setup(x => x.RunReadonlyChecksAsync("user-1", "session-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(expected);

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.RunReadonlyChecks("session-1", CancellationToken.None);

        var objectResult = result.ShouldBeOfType<OkObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status200OK);
        service.Verify(x => x.RunReadonlyChecksAsync("user-1", "session-1", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task ManualTakeover_ShouldUseCurrentUser()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var request = new ManualTakeoverRequest(true, "检查远程页面");
        var expected = BuildSessionView("session-1", "user-1");
        service
            .Setup(x => x.SetManualTakeoverAsync("user-1", "session-1", request, It.IsAny<CancellationToken>()))
            .ReturnsAsync(expected);

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.ManualTakeover("session-1", request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<OkObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status200OK);
        service.Verify(x => x.SetManualTakeoverAsync("user-1", "session-1", request, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task ManualInput_ShouldMapDomainError()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var request = new ManualInputRequest("人工记录");
        service
            .Setup(x => x.AddManualInputAsync("user-1", "session-1", request, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ManualTakeoverRequired,
                "请先开启人工接管，再记录人工输入",
                StatusCodes.Status409Conflict));

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.ManualInput("session-1", request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status409Conflict);
    }

    [Fact]
    public async Task ListMessages_ShouldUseCurrentUser()
    {
        var service = new Mock<IInfraAgentSessionService>();
        service
            .Setup(x => x.ListMessagesAsync("user-1", "session-1", 50, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<InfraAgentMessageView>
            {
                new("msg-1", "session-1", InfraAgentMessageRoles.User, "请巡检代码", InfraAgentMessageStatuses.Completed, DateTime.UtcNow)
            });

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.ListMessages("session-1", 50, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<OkObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status200OK);
        service.Verify(x => x.ListMessagesAsync("user-1", "session-1", 50, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task RuntimeStatus_ShouldRefreshDiscovery_WhenRequested()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var router = new Mock<IClaudeSidecarRouter>();
        var registry = new Mock<IDynamicSidecarRegistry>();
        router
            .Setup(x => x.GetDiagnosticsAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SidecarPoolDiagnostics(
                false,
                0,
                0,
                Array.Empty<SidecarInstanceDiagnostics>()));
        registry
            .Setup(x => x.RefreshAsync(It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        var controller = BuildController(service.Object, "user-1", router.Object, registry.Object);

        var result = await controller.RuntimeStatus(refreshDiscovery: true, CancellationToken.None);

        result.ShouldBeOfType<OkObjectResult>();
        registry.Verify(x => x.RefreshAsync(It.IsAny<CancellationToken>()), Times.Once);
        router.Verify(x => x.GetDiagnosticsAsync(It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task RuntimeStatus_ShouldExposeDesiredOfficialSdkAdapter()
    {
        var previous = Environment.GetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar);
        var service = new Mock<IInfraAgentSessionService>();
        var router = new Mock<IClaudeSidecarRouter>();
        router
            .Setup(x => x.GetDiagnosticsAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SidecarPoolDiagnostics(
                false,
                0,
                0,
                Array.Empty<SidecarInstanceDiagnostics>()));
        try
        {
            Environment.SetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar, null);
            var controller = BuildController(service.Object, "user-1", router.Object);

            var result = await controller.RuntimeStatus(refreshDiscovery: false, CancellationToken.None);

            var objectResult = result.ShouldBeOfType<OkObjectResult>();
            objectResult.StatusCode.ShouldBe(StatusCodes.Status200OK);
            var response = objectResult.Value.ShouldBeOfType<ApiResponse<object>>();
            var data = response.Data.ShouldNotBeNull();
            var diagnosticsProperty = data.GetType().GetProperty("diagnostics").ShouldNotBeNull();
            var diagnostics = diagnosticsProperty.GetValue(data).ShouldBeOfType<SidecarPoolDiagnostics>();
            diagnostics.DesiredRuntimeAdapter.ShouldBe("claude-agent-sdk");
        }
        finally
        {
            Environment.SetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar, previous);
        }
    }

    private static InfraAgentSessionsController BuildController(
        IInfraAgentSessionService service,
        string userId,
        IClaudeSidecarRouter? sidecarRouter = null,
        IDynamicSidecarRegistry? sidecarRegistry = null,
        IInfraAgentRuntimeAdapter? runtimeAdapter = null)
    {
        var claims = new List<Claim>
        {
            new("sub", userId)
        };
        var identity = new ClaimsIdentity(claims, "test");
        var principal = new ClaimsPrincipal(identity);

        return new InfraAgentSessionsController(service, sidecarRouter, sidecarRegistry, runtimeAdapter)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = principal
                }
            }
        };
    }

    private static InfraAgentSessionView BuildSessionView(string id, string userId)
    {
        var now = DateTime.UtcNow;
        return new InfraAgentSessionView(
            id,
            userId,
            "conn-1",
            "cds",
            "shared-service",
            null,
            null,
            null,
            "infra-agent-session-test",
            InfraAgentRuntimes.ClaudeSdk,
            null,
            null,
            null,
            null,
            null,
            null,
            2,
            4096,
            900,
            InfraAgentRuntimeNetworkPolicies.Restricted,
            30,
            "confirm-dangerous",
            null,
            "测试会话",
            InfraAgentSessionStatuses.Idle,
            false,
            false,
            null,
            null,
            null,
            now,
            now,
            null,
            null);
    }
}
