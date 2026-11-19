using Microsoft.Extensions.Configuration;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class ProductClaimNotificationAuthorityTests
{
    [Fact]
    public void DedicatedAuthorizationEnablesOnlyProductClaimNotifications()
    {
        var configuration = Configure("true", "false");

        Assert.Null(ProductClaimNotificationQueue.GetDeploymentBlockReason(configuration));
        Assert.False(DeploymentAuthority.CanRunSharedScheduledWork(configuration));
    }

    [Theory]
    [InlineData(null, "false", SharedScheduledWorkBlockReason.AuthorizationDisabled)]
    [InlineData("", "false", SharedScheduledWorkBlockReason.AuthorizationDisabled)]
    [InlineData("false", "true", SharedScheduledWorkBlockReason.AuthorizationDisabled)]
    [InlineData("invalid", "true", SharedScheduledWorkBlockReason.AuthorizationInvalid)]
    [InlineData(null, null, SharedScheduledWorkBlockReason.AuthorizationMissing)]
    public void DisabledMissingAndInvalidAuthorizationRemainBlocked(
        string? dedicated, string? shared, SharedScheduledWorkBlockReason reason)
    {
        Assert.Equal(reason, ProductClaimNotificationQueue.GetDeploymentBlockReason(Configure(dedicated, shared)));
    }

    [Fact]
    public void ExistingSharedAuthorizationRemainsCompatible()
    {
        var configuration = Configure(null, "true");

        Assert.Null(ProductClaimNotificationQueue.GetDeploymentBlockReason(configuration));
        Assert.True(DeploymentAuthority.CanRunSharedScheduledWork(configuration));
    }

    [Theory]
    [InlineData("CDS_PROJECT_ID", "prd-agent", SharedScheduledWorkBlockReason.BranchPreview)]
    [InlineData("Deployment:Identity", "", SharedScheduledWorkBlockReason.DeploymentIdentityMissing)]
    [InlineData(DeploymentAuthority.ManageGlobalNotificationKey, "false", SharedScheduledWorkBlockReason.SharedStateOptedOut)]
    public void DedicatedAuthorizationPreservesDeploymentIsolation(
        string key, string value, SharedScheduledWorkBlockReason reason)
    {
        var configuration = Configure("true", "false");
        configuration[key] = value;

        Assert.Equal(reason, ProductClaimNotificationQueue.GetDeploymentBlockReason(configuration));
        Assert.False(DeploymentAuthority.CanRunSharedScheduledWork(configuration));
    }

    private static IConfigurationRoot Configure(string? dedicated, string? shared) =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [DeploymentAuthority.DeploymentIdentityKey] = "product-claim:test",
            [DeploymentAuthority.SharedScheduledWorkEnabledKey] = shared,
            [ProductClaimNotificationQueue.NotificationsEnabledKey] = dedicated,
        }).Build();
}
