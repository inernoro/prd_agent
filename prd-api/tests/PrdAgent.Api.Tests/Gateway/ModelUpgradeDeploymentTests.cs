using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

internal static class ModelUpgradeTestConfiguration
{
    internal static IConfiguration AuthorizedProduction() => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        [ModelUpgradeDeploymentAuthority.WorkerEnabledKey] = "true",
        [ModelUpgradeDeploymentAuthority.WorkerDeploymentKey] = "test:production",
        ["Deployment:Identity"] = "test:production",
    }).Build();
}
public class ModelUpgradeDeploymentTests
{
    [Theory]
    [InlineData(null, null, null, null, null, false)]
    [InlineData("false", "production", null, null, "production", false)]
    [InlineData("true", null, null, null, "production", false)]
    [InlineData("true", "production", null, null, null, false)]
    [InlineData("true", "production", null, null, "standby", false)]
    [InlineData("true", "production", null, null, "production", true)]
    [InlineData("true", "project::main", "project", "main", null, true)]
    [InlineData("true", "project::main", "project", "feature/test", "project::main", false)]
    [InlineData("true", "project::main", "project", "prod/candidate", "project::main", false)]
    [InlineData("true", "project::main", "project", null, "project::main", false)]
    [InlineData("true", "other::main", "project", "main", null, false)]
    [InlineData("true", "project::main ", "project", "main", null, false)]
    public void OnlyExplicitMatchingDeploymentAndActualCdsMainAreAuthorized(string? enabled, string? expected, string? project, string? branch, string? identity, bool allowed)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [ModelUpgradeDeploymentAuthority.WorkerEnabledKey] = enabled,
            [ModelUpgradeDeploymentAuthority.WorkerDeploymentKey] = expected,
            ["CDS_PROJECT_ID"] = project, ["VITE_GIT_BRANCH"] = branch, ["Deployment:Identity"] = identity,
        }).Build();
        Assert.Equal(allowed, ModelUpgradeDeploymentAuthority.BlockReason(config) is null);
    }
    [Fact]
    public async Task DefaultDeniedTickDoesNotReadOrClaimAnySharedPolicy()
    {
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        var service = new ModelUpgradeService(database.Object, database.Object, Mock.Of<IModelUpgradeDiscovery>(), "tenant", NullLogger<ModelUpgradeService>.Instance);
        await service.TickAsync(CancellationToken.None);
        database.VerifyNoOtherCalls();
    }
    [Fact]
    public async Task UnauthorizedPreviewCannotSaveOrQueueSharedPolicy()
    {
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [ModelUpgradeDeploymentAuthority.WorkerEnabledKey] = "true",
            [ModelUpgradeDeploymentAuthority.WorkerDeploymentKey] = "project::main",
            ["CDS_PROJECT_ID"] = "project", ["VITE_GIT_BRANCH"] = "feature/test",
        }).Build();
        var service = new ModelUpgradeService(database.Object, database.Object, Mock.Of<IModelUpgradeDiscovery>(), "tenant", NullLogger<ModelUpgradeService>.Instance, config);
        var actor = new TenantAccessContext("tenant", "", true, "user", "admin", "member", 1, "admin", []);
        var save = await Assert.ThrowsAsync<ModelUpgradeException>(() => service.SavePolicyAsync(actor, "stable", new()));
        var queue = await Assert.ThrowsAsync<ModelUpgradeException>(() => service.QueueAsync(actor, "stable", "promote", new()));
        Assert.Equal("MODEL_UPGRADE_DEPLOYMENT_BLOCKED", save.Code);
        Assert.Equal("MODEL_UPGRADE_DEPLOYMENT_BLOCKED", queue.Code);
        await service.TickAsync(CancellationToken.None);
        database.VerifyNoOtherCalls();
    }
}
