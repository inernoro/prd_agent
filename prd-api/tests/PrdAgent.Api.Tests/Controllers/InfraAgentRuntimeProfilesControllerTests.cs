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
}
