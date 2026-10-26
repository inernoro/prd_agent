using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class VisualModelRouteProbeTests
{
    [Theory]
    [InlineData("Healthy", 0)]
    [InlineData("Degraded", 0)]
    [InlineData("Unavailable", 1)]
    public async Task RepeatedChecks_OnlyReadCatalog_AndDoNotClearFailure(string health, int failures)
    {
        var service = Service(health);
        for (var i = 0; i < 3; i++)
        {
            var result = await VisualModelRouteProbe.CheckAsync(service.Object, default);
            Assert.Equal(failures, result.Failures);
        }
        service.Verify(x => x.ReadStoredAsync(It.IsAny<CancellationToken>()), Times.Exactly(3));
        foreach (var caller in VisualModelPolicyService.AppCallers)
            service.Verify(x => x.DiscoverAsync(caller, It.IsAny<CancellationToken>()), Times.Exactly(3));
        service.VerifyNoOtherCalls(); // 没有保存配置、认领恢复或实际模型调用。
    }

    [Fact]
    public async Task MissingConfiguredModel_RemainsVisibleAsFailure()
    {
        var service = Service("Healthy");
        service.Setup(x => x.DiscoverAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<GatewayImageModel>());
        var result = await VisualModelRouteProbe.CheckAsync(service.Object, default);
        Assert.True(result.Failures > 0);
        Assert.Contains("NOT_IN_SCENARIO_CATALOG", result.Output);
        Assert.Contains("DEFAULT_NOT_TEXT2IMG", result.Output);
    }

    [Fact]
    public async Task CatalogFailure_CannotReportHealthy()
    {
        var service = Service("Healthy");
        service.Setup(x => x.DiscoverAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("test"));
        var result = await VisualModelRouteProbe.CheckAsync(service.Object, default);
        Assert.Equal(1, result.Failures);
    }

    [Fact]
    public void ProductionDeepHealth_UsesReadOnlyProbe_NotExecutionResolver()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "prd-api/src/PrdAgent.Api/Program.cs"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var source = File.ReadAllText(Path.Combine(dir.FullName, "prd-api/src/PrdAgent.Api/Program.cs"));
        var deepHealth = source[source.IndexOf("static async Task<IResult> DeepHealth(", StringComparison.Ordinal)..];
        Assert.Contains("VisualModelRouteProbe.CheckAsync", deepHealth);
        Assert.DoesNotContain("modelResolver.ResolveAsync", deepHealth);
        Assert.DoesNotContain("IModelResolver modelResolver", deepHealth);
    }

    private static Mock<IVisualModelPolicyService> Service(string health)
    {
        var service = new Mock<IVisualModelPolicyService>(MockBehavior.Strict);
        service.Setup(x => x.ReadStoredAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new VisualModelPolicy {
            DefaultModelId = "test-image", Models = [new() { ModelId = "test-image" }],
        });
        service.Setup(x => x.DiscoverAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync([
            new GatewayImageModel { Model = new AvailableModelPool { Code = "test-image",
                Models = [new PoolModelInfo { ModelId = "test-image", HealthStatus = health }] } },
        ]);
        return service;
    }
}
