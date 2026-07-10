using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayProductionGovernanceScriptTests
{
    [Fact]
    public void GovernanceAcceptance_ShouldBeDryRunByDefaultAndCleanTemporaryState()
    {
        var script = File.ReadAllText(LocateRepoFile("scripts/llmgw-prod-governance-acceptance.sh"));

        Assert.Contains("LLMGW_GOVERNANCE_ACCEPTANCE_EXECUTE:-0", script);
        Assert.Contains("paid upstream calls: 0", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("fake_upstream.py", script);
        Assert.Contains("PlatformType: 'openai'", script);
        Assert.Contains("Protocol: 'openai'", script);
        Assert.Contains("cleanup_database", script);
        Assert.Contains("db.llmgw_app_callers.deleteMany", script);
        Assert.Contains("db.llmgw_service_keys.deleteMany", script);
        Assert.Contains("llmgw_service_keys", File.ReadAllText(LocateRepoFile("prd-api/src/PrdAgent.LlmGateway/GatewayRuntimeGovernance.cs")));
    }

    [Fact]
    public void GovernanceAcceptance_ShouldCoverAllRuntimeGovernanceGates()
    {
        var script = File.ReadAllText(LocateRepoFile("scripts/llmgw-prod-governance-acceptance.sh"));

        Assert.Contains("budget_atomic_reservation=pass", script);
        Assert.Contains("provider_concurrency=pass", script);
        Assert.True(script.Split("ResourceKey: /llmgw-acceptance/").Length - 1 >= 2);
        Assert.Contains("lifecycle_dry_run=pass", script);
        Assert.Contains("serving_failover=pass", script);
        Assert.Contains("scoped_service_key=pass", script);
        Assert.Contains("temporary_data_cleanup=pass", script);
    }

    private static string LocateRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new FileNotFoundException($"找不到仓库文件: {relativePath}");
    }
}
