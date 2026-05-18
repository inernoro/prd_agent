using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class InfraAgentRuntimeProfilesControllerTests
{
    [Fact]
    public async Task ListTemplates_ShouldExposeOfficialClaudeAgentSdkProfileTemplate()
    {
        var service = new Mock<IInfraAgentRuntimeProfileService>();
        service
            .Setup(x => x.ListTemplatesAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(InfraAgentRuntimeProfileTemplates.All.ToList());
        var controller = new InfraAgentRuntimeProfilesController(service.Object);

        var result = await controller.ListTemplates(CancellationToken.None);

        var ok = result.ShouldBeOfType<OkObjectResult>();
        var response = ok.Value.ShouldBeOfType<ApiResponse<object>>();
        var data = response.Data.ShouldNotBeNull();
        var itemsProperty = data.GetType().GetProperty("items").ShouldNotBeNull();
        var rawItems = itemsProperty.GetValue(data).ShouldNotBeNull();
        var items = rawItems.ShouldBeAssignableTo<IEnumerable<InfraAgentRuntimeProfileTemplateView>>().ToList();
        var template = items.Single(x => x.Id == InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4);
        template.Protocol.ShouldBe(InfraAgentRuntimeProtocols.Anthropic);
        template.BaseUrl.ShouldBe("https://api.anthropic.com");
        template.Model.ShouldBe("claude-sonnet-4-20250514");
        template.CompatibleRuntimeAdapters.ShouldContain(InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk);
    }

    [Fact]
    public async Task ListAdapterCompatibility_ShouldExposeOfficialSdkAndFallbackBoundaries()
    {
        var service = new Mock<IInfraAgentRuntimeProfileService>();
        service
            .Setup(x => x.ListAdapterCompatibilityAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(InfraAgentRuntimeAdapterCompatibility.All.ToList());
        var controller = new InfraAgentRuntimeProfilesController(service.Object);

        var result = await controller.ListAdapterCompatibility(CancellationToken.None);

        var ok = result.ShouldBeOfType<OkObjectResult>();
        var response = ok.Value.ShouldBeOfType<ApiResponse<object>>();
        var data = response.Data.ShouldNotBeNull();
        var itemsProperty = data.GetType().GetProperty("items").ShouldNotBeNull();
        var rawItems = itemsProperty.GetValue(data).ShouldNotBeNull();
        var items = rawItems.ShouldBeAssignableTo<IEnumerable<InfraAgentRuntimeAdapterCompatibilityView>>().ToList();
        var official = items.Single(x => x.Id == InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk);
        official.Status.ShouldBe("default-supported");
        official.RoutableByDefault.ShouldBeTrue();
        official.LoopOwner.ShouldBe("claude-agent-sdk");
        official.MapRole.ShouldBe("control-plane-only");
        official.SupportedTaskKinds.ShouldContain("code-review");
        official.CompatibleRuntimeProfileTemplateIds.ShouldContain(InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4);
        official.RequiredEvidenceGates.ShouldBe(new[] { "R0", "A0", "R1", "S1", "S2", "S3", "V1", "N6" });
        official.MissingAdapterContracts.ShouldBeEmpty();
        official.KnownIncompatibleProfilePatterns.ShouldContain(x => x.Contains("deepseek", StringComparison.OrdinalIgnoreCase));

        var codex = items.Single(x => x.Id == InfraAgentRuntimeAdapterCompatibility.CodexPlanned);
        codex.Status.ShouldBe("planned-not-routable");
        codex.RoutableByDefault.ShouldBeFalse();
        codex.RequiredEvidenceGates.ShouldContain("S1");
        codex.MissingAdapterContracts.ShouldContain("tool-approval");
        codex.NextActions.ShouldContain(x => x.Contains("不要把用户代码审查任务默认路由到 codex runtime", StringComparison.OrdinalIgnoreCase));

        var openAiAgents = items.Single(x => x.Id == InfraAgentRuntimeAdapterCompatibility.OpenAiAgentsSdkPlanned);
        openAiAgents.Status.ShouldBe("planned-not-routable");
        openAiAgents.RoutableByDefault.ShouldBeFalse();
        openAiAgents.MapRole.ShouldBe("control-plane-only");
        openAiAgents.SupportedTaskKinds.ShouldContain("non-code-orchestration-candidate");
        openAiAgents.RequiredEvidenceGates.ShouldContain("adapter-contract");
        openAiAgents.MissingAdapterContracts.ShouldContain("map-approval-bridge");
        openAiAgents.KnownIncompatibleProfilePatterns.ShouldContain(x => x.Contains("不能自动等价于代码审查 agent runtime", StringComparison.OrdinalIgnoreCase));
        openAiAgents.NextActions.ShouldContain(x => x.Contains("S1/S2/S3", StringComparison.OrdinalIgnoreCase));

        var googleAdk = items.Single(x => x.Id == InfraAgentRuntimeAdapterCompatibility.GoogleAdkPlanned);
        googleAdk.Status.ShouldBe("planned-not-routable");
        googleAdk.RoutableByDefault.ShouldBeFalse();
        googleAdk.LoopOwner.ShouldBe("google-adk");
        googleAdk.SupportedTaskKinds.ShouldContain("gemini-ecosystem-candidate");
        googleAdk.RequiredEvidenceGates.ShouldContain("adapter-contract");
        googleAdk.MissingAdapterContracts.ShouldContain("artifact");
        googleAdk.KnownIncompatibleProfilePatterns.ShouldContain(x => x.Contains("不能直接复用 Claude Agent SDK", StringComparison.OrdinalIgnoreCase));
        googleAdk.NextActions.ShouldContain(x => x.Contains("不要把代码审查任务默认路由到 google-adk", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ValidateApiKeyForTemplate_ShouldRejectMissingAnthropicKey(string? apiKey)
    {
        var template = InfraAgentRuntimeProfileTemplates.All.Single(x =>
            x.Id == InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4);

        var ex = Should.Throw<InfraAgentRuntimeProfileException>(() =>
            InfraAgentRuntimeProfileTemplates.ValidateApiKeyForTemplate(template, apiKey));

        ex.ErrorCode.ShouldBe(InfraAgentRuntimeProfileErrorCodes.ApiKeyRequired);
    }

    [Theory]
    [InlineData("sk-or-v1-test")]
    [InlineData("sk-proj-test")]
    [InlineData("inernoro Shenmemima..01")]
    public void ValidateApiKeyForTemplate_ShouldRejectNonAnthropicKeyShape(string apiKey)
    {
        var template = InfraAgentRuntimeProfileTemplates.All.Single(x =>
            x.Id == InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4);

        var ex = Should.Throw<InfraAgentRuntimeProfileException>(() =>
            InfraAgentRuntimeProfileTemplates.ValidateApiKeyForTemplate(template, apiKey));

        ex.ErrorCode.ShouldBe(InfraAgentRuntimeProfileErrorCodes.ApiKeyFormatInvalid);
        ex.Message.ShouldContain("sk-ant-");
    }

    [Fact]
    public void ValidateApiKeyForTemplate_ShouldAcceptAnthropicKeyShape()
    {
        var template = InfraAgentRuntimeProfileTemplates.All.Single(x =>
            x.Id == InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4);

        Should.NotThrow(() =>
            InfraAgentRuntimeProfileTemplates.ValidateApiKeyForTemplate(template, "sk-ant-test"));
    }

    [Fact]
    public async Task CreateFromTemplate_ShouldUseCurrentUserAndTemplateId()
    {
        var service = new Mock<IInfraAgentRuntimeProfileService>();
        var request = new CreateInfraAgentRuntimeProfileFromTemplateRequest("Team Claude", "sk-ant-test", true);
        var expected = new InfraAgentRuntimeProfileView(
            "profile-1",
            "Team Claude",
            InfraAgentRuntimes.ClaudeSdk,
            InfraAgentRuntimeProtocols.Anthropic,
            "https://api.anthropic.com",
            "claude-sonnet-4-20250514",
            2,
            4096,
            900,
            InfraAgentRuntimeNetworkPolicies.Restricted,
            30,
            true,
            true,
            DateTime.UtcNow,
            DateTime.UtcNow);
        service
            .Setup(x => x.CreateFromTemplateAsync(
                InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
                "user-1",
                request,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(expected);
        var controller = BuildController(service.Object, "user-1");

        var result = await controller.CreateFromTemplate(
            InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
            request,
            CancellationToken.None);

        var created = result.ShouldBeOfType<ObjectResult>();
        created.StatusCode.ShouldBe(StatusCodes.Status201Created);
        service.Verify(x => x.CreateFromTemplateAsync(
            InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
            "user-1",
            request,
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task CreateFromTemplate_ShouldMapDomainError()
    {
        var service = new Mock<IInfraAgentRuntimeProfileService>();
        var request = new CreateInfraAgentRuntimeProfileFromTemplateRequest(null, null, null);
        service
            .Setup(x => x.CreateFromTemplateAsync("missing", "user-1", request, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.TemplateNotFound,
                "运行配置模板不存在",
                StatusCodes.Status404NotFound));
        var controller = BuildController(service.Object, "user-1");

        var result = await controller.CreateFromTemplate("missing", request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status404NotFound);
        var response = objectResult.Value.ShouldBeOfType<ApiResponse<object>>();
        response.Error.ShouldNotBeNull().Code.ShouldBe(InfraAgentRuntimeProfileErrorCodes.TemplateNotFound);
    }

    [Fact]
    public async Task CreateDefaultFromTemplateAfterTest_ShouldUseBackendPromotionFlow()
    {
        var service = new Mock<IInfraAgentRuntimeProfileService>();
        var request = new CreateInfraAgentRuntimeProfileFromTemplateRequest("Team Claude", "sk-ant-test", true);
        var expected = new InfraAgentRuntimeProfileView(
            "profile-1",
            "Team Claude",
            InfraAgentRuntimes.ClaudeSdk,
            InfraAgentRuntimeProtocols.Anthropic,
            "https://api.anthropic.com",
            "claude-sonnet-4-20250514",
            2,
            4096,
            900,
            InfraAgentRuntimeNetworkPolicies.Restricted,
            30,
            true,
            true,
            DateTime.UtcNow,
            DateTime.UtcNow);
        var test = new InfraAgentRuntimeProfileTestResult(
            "profile-1",
            true,
            "ok",
            "模型配置可用，已收到上游响应。",
            InfraAgentRuntimeProtocols.Anthropic,
            "https://api.anthropic.com",
            "claude-sonnet-4-20250514",
            200,
            123);
        service
            .Setup(x => x.CreateDefaultFromTemplateAfterTestAsync(
                InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
                "user-1",
                request,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new InfraAgentRuntimeProfilePromotionResult(expected, test));
        var controller = BuildController(service.Object, "user-1");

        var result = await controller.CreateDefaultFromTemplateAfterTest(
            InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
            request,
            CancellationToken.None);

        var created = result.ShouldBeOfType<ObjectResult>();
        created.StatusCode.ShouldBe(StatusCodes.Status201Created);
        var response = created.Value.ShouldBeOfType<ApiResponse<object>>();
        var data = response.Data.ShouldNotBeNull();
        data.GetType().GetProperty("item").ShouldNotBeNull().GetValue(data).ShouldBe(expected);
        data.GetType().GetProperty("test").ShouldNotBeNull().GetValue(data).ShouldBe(test);
        service.Verify(x => x.CreateDefaultFromTemplateAfterTestAsync(
            InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
            "user-1",
            request,
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task CreateDefaultFromTemplateAfterTest_ShouldMapFailedProfileTest()
    {
        var service = new Mock<IInfraAgentRuntimeProfileService>();
        var request = new CreateInfraAgentRuntimeProfileFromTemplateRequest("Team Claude", "bad-key", true);
        service
            .Setup(x => x.CreateDefaultFromTemplateAfterTestAsync(
                InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
                "user-1",
                request,
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ProfileTestFailed,
                "候选模型配置测试失败：invalid key",
                StatusCodes.Status422UnprocessableEntity));
        var controller = BuildController(service.Object, "user-1");

        var result = await controller.CreateDefaultFromTemplateAfterTest(
            InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4,
            request,
            CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status422UnprocessableEntity);
        var response = objectResult.Value.ShouldBeOfType<ApiResponse<object>>();
        response.Error.ShouldNotBeNull().Code.ShouldBe(InfraAgentRuntimeProfileErrorCodes.ProfileTestFailed);
    }

    private static InfraAgentRuntimeProfilesController BuildController(
        IInfraAgentRuntimeProfileService service,
        string userId)
    {
        var identity = new ClaimsIdentity(new[] { new Claim("sub", userId) }, "test");
        return new InfraAgentRuntimeProfilesController(service)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(identity)
                }
            }
        };
    }
}
