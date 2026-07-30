using System.Runtime.CompilerServices;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

internal static class TestAssetStorageEnvironment
{
    internal const string ExplicitProviderVariable = "PRD_AGENT_TEST_ASSETS_PROVIDER";

    [ModuleInitializer]
    internal static void Initialize()
    {
        // 测试进程不得继承开发机或发布机器上的正式 COS/R2 选择。需要专门验证
        // 某个云提供商时必须通过测试专用变量显式选择，不能复用生产 ASSETS_PROVIDER。
        var explicitProvider = (Environment.GetEnvironmentVariable(ExplicitProviderVariable)
            ?? string.Empty).Trim();
        var provider = string.IsNullOrWhiteSpace(explicitProvider)
            ? "local"
            : explicitProvider;
        Environment.SetEnvironmentVariable("ASSETS_PROVIDER", provider);
        Environment.SetEnvironmentVariable("ASSETS_EXPECTED_PROVIDER", provider);
        if (string.Equals(provider, "local", StringComparison.OrdinalIgnoreCase))
        {
            Environment.SetEnvironmentVariable(
                "ASSETS_LOCAL_DIR",
                Path.Combine(Path.GetTempPath(), $"prd-agent-api-tests-assets-{Environment.ProcessId}"));
        }
    }
}

public sealed class TestAssetStorageEnvironmentTests
{
    [Fact]
    public void TestHost_ShouldIgnoreAmbientProductionProviderByDefault()
    {
        var explicitProvider = (Environment.GetEnvironmentVariable(
            TestAssetStorageEnvironment.ExplicitProviderVariable) ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(explicitProvider))
            return;

        Environment.GetEnvironmentVariable("ASSETS_PROVIDER").ShouldBe("local");
        Environment.GetEnvironmentVariable("ASSETS_EXPECTED_PROVIDER").ShouldBe("local");
        var localDir = Environment.GetEnvironmentVariable("ASSETS_LOCAL_DIR");
        localDir.ShouldNotBeNull();
        localDir.ShouldContain("prd-agent-api-tests-assets-");
    }
}
