using PrdAgent.Api.Controllers.Api;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class DocumentStoreTutorialLinkGraphResolveControllerTests
{
    [Theory]
    [InlineData("/logs", "/logs", true)]
    [InlineData("/logs/:requestId", "/logs/req-1", true)]
    [InlineData("/logs/:requestId", "/logs", false)]
    [InlineData("/models/:modelId", "/models/model-a/settings", false)]
    [InlineData("/usage", "/logs", false)]
    public void RouteMatches_UsesExactSegmentsAndNamedParameters(string pattern, string route, bool expected)
    {
        DocumentStoreTutorialLinkGraphResolveController.RouteMatches(pattern, route).ShouldBe(expected);
    }
}
