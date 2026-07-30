using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class RegistryAssetStorageProbeTests
{
    [Theory]
    [InlineData("_it/asset-storage-readiness/a.txt", true)]
    [InlineData("data/_it/asset-storage-readiness/a.txt", true)]
    [InlineData("/_IT/probe.txt", true)]
    [InlineData("prd-agent/doc/a.txt", false)]
    [InlineData("prd-agent/not_it/a.txt", false)]
    public void IsIntegrationTestKey_ShouldIsolateProbeObjectsFromAssetRegistry(
        string key,
        bool expected)
    {
        RegistryAssetStorage.IsIntegrationTestKey(key).ShouldBe(expected);
    }
}
