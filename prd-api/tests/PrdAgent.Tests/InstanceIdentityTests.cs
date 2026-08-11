using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Tests;

public sealed class InstanceIdentityTests
{
    [Fact]
    public void Get_SeparatesCdsAndProductionEvenWhenBranchMatches()
    {
        var cds = BuildConfiguration("prd-agent:cds", "main", "Production");
        var production = BuildConfiguration("prd-agent:production", "main", "Production");

        Assert.Equal("prd-agent:cds::main", InstanceIdentity.Get(cds));
        Assert.Equal("prd-agent:production::main", InstanceIdentity.Get(production));
        Assert.NotEqual(InstanceIdentity.Get(cds), InstanceIdentity.Get(production));
    }

    [Fact]
    public void Get_RemainsStableAcrossRollingDeploymentRevisions()
    {
        var firstRevision = BuildConfiguration("prd-agent:production", "main", "Production", "revision-a");
        var secondRevision = BuildConfiguration("prd-agent:production", "main", "Production", "revision-b");

        Assert.Equal(InstanceIdentity.Get(firstRevision), InstanceIdentity.Get(secondRevision));
    }

    [Fact]
    public void Get_FallsBackToEnvironmentScopedIdentityWhenDeploymentIdentityIsMissing()
    {
        var configuration = BuildConfiguration(null, " codex/example ", "Development");

        Assert.Equal("prd-agent:development::codex/example", InstanceIdentity.Get(configuration));
    }

    [Fact]
    public void GetCompatibleOwnerIds_AdoptsLegacyOwnerForTheSameFeatureBranch()
    {
        var configuration = BuildConfiguration("prd-agent:cds", "codex/example", "Production", cdsProjectId: "prd-agent");

        Assert.Equal(
            ["prd-agent:cds::codex/example", "codex/example"],
            InstanceIdentity.GetCompatibleOwnerIds(configuration));
    }

    [Fact]
    public void GetCompatibleOwnerIds_LegacyMainIsOwnedOnlyByProduction()
    {
        var cds = BuildConfiguration("prd-agent:cds", "main", "Production", cdsProjectId: "prd-agent");
        var production = BuildConfiguration("prd-agent:production", "main", "Production");

        Assert.Equal(["prd-agent:cds::main"], InstanceIdentity.GetCompatibleOwnerIds(cds));
        Assert.Equal(
            ["prd-agent:production::main", "main"],
            InstanceIdentity.GetCompatibleOwnerIds(production));
    }

    private static IConfiguration BuildConfiguration(
        string? deploymentIdentity,
        string? branch,
        string? environment,
        string? revision = null,
        string? cdsProjectId = null)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Deployment:Identity"] = deploymentIdentity,
                ["Changelog:GitHubBranch"] = branch,
                ["ASPNETCORE_ENVIRONMENT"] = environment,
                ["Changelog:GitCommit"] = revision,
                ["CDS_PROJECT_ID"] = cdsProjectId,
            })
            .Build();
}
