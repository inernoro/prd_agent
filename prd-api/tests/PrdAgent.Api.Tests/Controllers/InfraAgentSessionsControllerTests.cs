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
                "CDS Agent runtime pool 不可用：adapter=sidecar-runtime-adapter, instances=0, healthy=0",
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
                "CDS Agent runtime pool 不可用：adapter=sidecar-runtime-adapter, instances=0, healthy=0",
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

    [Fact]
    public async Task RuntimeStatus_ShouldExposeDefaultRuntimeProfileCompatibility()
    {
        var previous = Environment.GetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar);
        var service = new Mock<IInfraAgentSessionService>();
        var router = new Mock<IClaudeSidecarRouter>();
        var profiles = new Mock<IInfraAgentRuntimeProfileService>();
        router
            .Setup(x => x.GetDiagnosticsAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SidecarPoolDiagnostics(
                true,
                1,
                1,
                Array.Empty<SidecarInstanceDiagnostics>(),
                NextActions: Array.Empty<string>()));
        profiles
            .Setup(x => x.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<InfraAgentRuntimeProfileView>
            {
                new(
                    "profile-1",
                    "OpenRouter DeepSeek",
                    InfraAgentRuntimes.ClaudeSdk,
                    "openai-compatible",
                    "https://openrouter.ai/api/v1",
                    "deepseek/deepseek-v4-pro",
                    2,
                    4096,
                    900,
                    InfraAgentRuntimeNetworkPolicies.Restricted,
                    30,
                    true,
                    true,
                    DateTime.UtcNow,
                    DateTime.UtcNow)
            });
        try
        {
            Environment.SetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar, null);
            var controller = BuildController(service.Object, "user-1", router.Object, runtimeProfiles: profiles.Object);

            var result = await controller.RuntimeStatus(refreshDiscovery: false, CancellationToken.None);

            var objectResult = result.ShouldBeOfType<OkObjectResult>();
            objectResult.StatusCode.ShouldBe(StatusCodes.Status200OK);
            var response = objectResult.Value.ShouldBeOfType<ApiResponse<object>>();
            var data = response.Data.ShouldNotBeNull();
            var diagnosticsProperty = data.GetType().GetProperty("diagnostics").ShouldNotBeNull();
            var diagnostics = diagnosticsProperty.GetValue(data).ShouldBeOfType<SidecarPoolDiagnostics>();
            var defaultProfile = diagnostics.DefaultRuntimeProfile.ShouldNotBeNull();
            defaultProfile.CompatibleWithDesiredRuntimeAdapter.ShouldBeFalse();
            defaultProfile.Warning.ShouldNotBeNull().ShouldContain("Claude/Anthropic");
            defaultProfile.CompatibilityReasonCode.ShouldBe("openai-compatible-non-claude-model");
            defaultProfile.CompatibilityReason.ShouldNotBeNull().ShouldContain("OpenAI-compatible");
            defaultProfile.CompatibilityNextActions.ShouldNotBeNull()
                .ShouldContain(x => x.Contains("不要把代码审查任务路由到 claude-agent-sdk", StringComparison.Ordinal));
            var repairPlan = diagnostics.RuntimeProfileRepairPlan.ShouldNotBeNull();
            repairPlan.Gate.ShouldBe("R1");
            repairPlan.State.ShouldBe("blocked");
            repairPlan.TargetTemplateId.ShouldBe(InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4);
            repairPlan.TargetProtocol.ShouldBe(InfraAgentRuntimeProtocols.Anthropic);
            repairPlan.TargetModel.ShouldBe("claude-sonnet-4-20250514");
            repairPlan.CurrentProfile.ShouldNotBeNull().Name.ShouldBe("OpenRouter DeepSeek");
            repairPlan.NextActions.ShouldContain(x => x.Contains("准备默认 Claude 配置", StringComparison.Ordinal));
            var nextCyclePlan = diagnostics.NextCyclePlan.ShouldNotBeNull();
            nextCyclePlan.Cycle.ShouldBe("official-sdk-provider-closure");
            nextCyclePlan.State.ShouldBe("profile-blocked");
            nextCyclePlan.Items.Single(x => x.Code == "N1").Status.ShouldBe("blocked");
            nextCyclePlan.Items.Single(x => x.Code == "N2").BlockedBy.ShouldBe("R1");
            nextCyclePlan.StopConditions.ShouldContain(x => x.Contains("N1-N5", StringComparison.Ordinal));
            var debugCommands = diagnostics.DebugCommands.ShouldNotBeNull();
            debugCommands.Single(x => x.Code == "official-sdk-boundary").Command.ShouldBe("bash scripts/smoke-cds-agent-official-sdk-boundary.sh");
            debugCommands.Single(x => x.Code == "r1-apply").BlockedBy.ShouldBe("Anthropic API key");
            debugCommands.Single(x => x.Code == "provider-cycle").Status.ShouldBe("blocked");
            debugCommands.Single(x => x.Code == "provider-cycle").BlockedBy.ShouldBe("R1");
            var executionPanel = diagnostics.ExecutionPanel.ShouldNotBeNull();
            executionPanel.Status.ShouldBe("profile-blocked");
            executionPanel.CommercialComplete.ShouldBeFalse();
            executionPanel.CurrentBlockingGate.ShouldBe("R0");
            executionPanel.BlockingReason.ShouldContain("instanceCount=1 healthyCount=1 officialInstances=0");
            executionPanel.DeploymentAdvice.ShouldContain("doctor");
            executionPanel.NextCommand.ShouldBe("bash scripts/doctor-cds-agent-runtime.sh");
            executionPanel.GateCounts["pass"].ShouldBe(2);
            executionPanel.GateCounts["pending"].ShouldBe(5);
            var nextActions = diagnostics.NextActions.ShouldNotBeNull();
            nextActions.ShouldContain("为 Claude Agent SDK 路径选择 Claude/Anthropic 兼容 runtime profile，或将该任务改走普通 OpenAI-compatible gateway");
        }
        finally
        {
            Environment.SetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar, previous);
        }
    }

    [Fact]
    public async Task RuntimeStatus_ShouldExposeCommercialReadinessLedger()
    {
        var previous = Environment.GetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar);
        var service = new Mock<IInfraAgentSessionService>();
        var router = new Mock<IClaudeSidecarRouter>();
        var profiles = new Mock<IInfraAgentRuntimeProfileService>();
        router
            .Setup(x => x.GetDiagnosticsAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SidecarPoolDiagnostics(
                true,
                1,
                1,
                new[]
                {
                    new SidecarInstanceDiagnostics(
                        "sidecar-1",
                        "http://sidecar",
                        "test",
                        Array.Empty<string>(),
                        true,
                        true,
                        200,
                        true,
                        true,
                        false,
                        true,
                        InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk,
                        null,
                        null,
                        LoopOwner: InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk,
                        SdkLoopEnabled: true)
                },
                NextActions: Array.Empty<string>()));
        profiles
            .Setup(x => x.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<InfraAgentRuntimeProfileView>
            {
                new(
                    "profile-1",
                    "OpenRouter DeepSeek",
                    InfraAgentRuntimes.ClaudeSdk,
                    InfraAgentRuntimeProtocols.OpenAiCompatible,
                    "https://openrouter.ai/api/v1",
                    "deepseek/deepseek-v4-pro",
                    2,
                    4096,
                    900,
                    InfraAgentRuntimeNetworkPolicies.Restricted,
                    30,
                    true,
                    true,
                    DateTime.UtcNow,
                    DateTime.UtcNow)
            });
        try
        {
            Environment.SetEnvironmentVariable(InfraAgentRuntimeAdapterDefaults.RuntimeAdapterEnvVar, null);
            var controller = BuildController(service.Object, "user-1", router.Object, runtimeProfiles: profiles.Object);

            var result = await controller.RuntimeStatus(refreshDiscovery: false, CancellationToken.None);

            var objectResult = result.ShouldBeOfType<OkObjectResult>();
            var response = objectResult.Value.ShouldBeOfType<ApiResponse<object>>();
            var data = response.Data.ShouldNotBeNull();
            var diagnosticsProperty = data.GetType().GetProperty("diagnostics").ShouldNotBeNull();
            var diagnostics = diagnosticsProperty.GetValue(data).ShouldBeOfType<SidecarPoolDiagnostics>();
            var readiness = diagnostics.CommercialReadiness.ShouldNotBeNull();
            readiness.Overall.ShouldBe("profile-blocked");
            readiness.Gates.Single(x => x.Code == "R0").Status.ShouldBe("pass");
            readiness.Gates.Single(x => x.Code == "A0").Status.ShouldBe("pass");
            readiness.Gates.Single(x => x.Code == "T1").Status.ShouldBe("pass");
            var r1Gate = readiness.Gates.Single(x => x.Code == "R1");
            r1Gate.Status.ShouldBe("pending");
            r1Gate.ReasonCode.ShouldBe("openai-compatible-non-claude-model");
            readiness.Gates.Single(x => x.Code == "S1").ReasonCode.ShouldBe("openai-compatible-non-claude-model");
            readiness.Gates.Single(x => x.Code == "S2").ReasonCode.ShouldBe("openai-compatible-non-claude-model");
            readiness.Gates.Single(x => x.Code == "S3").ReasonCode.ShouldBe("openai-compatible-non-claude-model");
            readiness.Pending.ShouldContain(x => x.StartsWith("R1:", StringComparison.Ordinal));
            var repairPlan = diagnostics.RuntimeProfileRepairPlan.ShouldNotBeNull();
            repairPlan.State.ShouldBe("blocked");
            repairPlan.TargetBaseUrl.ShouldBe("https://api.anthropic.com");
            var nextCyclePlan = diagnostics.NextCyclePlan.ShouldNotBeNull();
            nextCyclePlan.Items.Select(x => x.Code).ShouldBe(new[] { "N1", "N2", "N3", "N4", "N5", "N6" });
            nextCyclePlan.Items.Single(x => x.Code == "N6").Status.ShouldBe("ready-to-run");
            nextCyclePlan.Items.Single(x => x.Code == "N6").NextActions.ShouldNotBeNull()
                .ShouldContain("bash scripts/smoke-cds-agent-non-code-compatibility.sh");
            var debugCommands = diagnostics.DebugCommands.ShouldNotBeNull();
            debugCommands.Select(x => x.Code).ShouldContain("doctor");
            debugCommands.Select(x => x.Code).ShouldContain("official-sdk-boundary");
            debugCommands.Single(x => x.Code == "non-code-compat").Command.ShouldBe("bash scripts/smoke-cds-agent-non-code-compatibility.sh");
            var executionPanel = diagnostics.ExecutionPanel.ShouldNotBeNull();
            executionPanel.Status.ShouldBe("profile-blocked");
            executionPanel.CommercialComplete.ShouldBeFalse();
            executionPanel.CurrentBlockingGate.ShouldBe("R1");
            executionPanel.BlockingReason.ShouldContain("Anthropic/Claude-compatible");
            executionPanel.DeploymentAdvice.ShouldContain("不要靠重新部署解决 R1");
            executionPanel.NextCommand.ShouldBe("bash scripts/smoke-cds-agent-r1-profile-repair.sh");
            executionPanel.GateCounts["pass"].ShouldBe(3);
            executionPanel.GateCounts["pending"].ShouldBe(4);
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
        IInfraAgentRuntimeAdapter? runtimeAdapter = null,
        IInfraAgentRuntimeProfileService? runtimeProfiles = null)
    {
        var claims = new List<Claim>
        {
            new("sub", userId)
        };
        var identity = new ClaimsIdentity(claims, "test");
        var principal = new ClaimsPrincipal(identity);

        return new InfraAgentSessionsController(service, sidecarRouter, sidecarRegistry, runtimeAdapter, runtimeProfiles)
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
