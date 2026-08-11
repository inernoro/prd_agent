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
    public void GetCompatibleOwnerIds_CdsNeverAdoptsLegacyOwnerForAFeatureBranch()
    {
        var configuration = BuildConfiguration("prd-agent:cds", "codex/example", "Production", cdsProjectId: "prd-agent");

        Assert.Equal(
            ["prd-agent:cds::codex/example"],
            InstanceIdentity.GetCompatibleOwnerIds(configuration));
    }

    [Fact]
    public void GetCompatibleOwnerIds_OnlyIncludesExplicitlyRetiredLegacyOwner()
    {
        var cds = BuildConfiguration("prd-agent:cds", "main", "Production", cdsProjectId: "prd-agent");
        var production = BuildConfiguration(
            "prd-agent:production", "main", "Production",
            adoptLegacyBranchOwners: true,
            retiredLegacyBranchOwnerIds: "main");
        var featureProduction = BuildConfiguration(
            "prd-agent:production", "codex/example", "Production",
            adoptLegacyBranchOwners: true,
            retiredLegacyBranchOwnerIds: "main");

        Assert.Equal(["prd-agent:cds::main"], InstanceIdentity.GetCompatibleOwnerIds(cds));
        Assert.Equal(
            ["prd-agent:production::main", "main"],
            InstanceIdentity.GetCompatibleOwnerIds(production));
        Assert.Equal(
            ["prd-agent:production::codex/example"],
            InstanceIdentity.GetCompatibleOwnerIds(featureProduction));
    }

    private static IConfiguration BuildConfiguration(
        string? deploymentIdentity,
        string? branch,
        string? environment,
        string? revision = null,
        string? cdsProjectId = null,
        bool? adoptLegacyBranchOwners = null,
        string? retiredLegacyBranchOwnerIds = null)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Deployment:Identity"] = deploymentIdentity,
                ["Changelog:GitHubBranch"] = branch,
                ["ASPNETCORE_ENVIRONMENT"] = environment,
                ["Changelog:GitCommit"] = revision,
                ["CDS_PROJECT_ID"] = cdsProjectId,
                ["Deployment:AdoptLegacyBranchOwners"] = adoptLegacyBranchOwners?.ToString(),
                ["Deployment:RetiredLegacyBranchOwnerIds"] = retiredLegacyBranchOwnerIds,
            })
            .Build();
}
