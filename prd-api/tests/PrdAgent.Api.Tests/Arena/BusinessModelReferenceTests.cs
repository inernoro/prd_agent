using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Arena;

public class BusinessModelReferenceTests
{
    private static readonly BusinessModelOption Fixed = new("logical-fixed", "fixed-v2", "固定型号", true, null);
    private static readonly BusinessModelOption Stable = new("logical-stable", "quality", "稳定型号", true, null);

    [Fact]
    public void OldPhysicalNameCannotSilentlyBecomeLogicalOrDefault()
    {
        var result = BusinessModelReferenceService.Resolve([Fixed, Stable], null, "deleted-provider", "fixed-v2");
        Assert.False(result.Success);
        Assert.Equal("legacy", result.Status);
        Assert.Equal("fixed-v2", result.PublicId);
    }

    [Fact]
    public void MissingFixedIdentityCannotFallBackToStableOrRecreatedPublicName()
    {
        var result = BusinessModelReferenceService.Resolve([Fixed, Stable], "deleted-logical", "logical-model", "fixed-v2");
        Assert.False(result.Success);
        Assert.Equal("unavailable", result.Status);
        Assert.Equal("deleted-logical", result.LogicalModelId);
    }

    [Fact]
    public void InternalIdentitySurvivesPublicRenameAndProviderReplacement()
    {
        var result = BusinessModelReferenceService.Resolve([Fixed with { PublicId = "renamed-v2" }],
            Fixed.LogicalModelId, "retired-provider", "old-upstream-model");
        Assert.True(result.Success);
        Assert.Equal("renamed-v2", result.PublicId);
        Assert.Equal(Fixed.LogicalModelId, result.LogicalModelId);
    }

    [Fact]
    public void UnavailableModelRemainsVisibleButCannotExecute()
    {
        var result = BusinessModelReferenceService.Resolve([Fixed with { Available = false, Reason = "修复线路" }],
            Fixed.LogicalModelId, "logical-model", Fixed.PublicId);
        Assert.False(result.Success);
        Assert.Equal("修复线路", result.Reason);
        Assert.Equal(Fixed.LogicalModelId, result.LogicalModelId);
    }

    [Fact]
    public void ExplicitLegacyLogicalPublicIdCanUpgradeWithoutPhysicalGuessing()
    {
        var result = BusinessModelReferenceService.Resolve([Fixed], null, "logical-model", Fixed.PublicId);
        Assert.True(result.Success);
        Assert.Equal(Fixed.LogicalModelId, result.LogicalModelId);
    }

    [Theory]
    [InlineData("Healthy", false, true)]
    [InlineData("Degraded", false, true)]
    [InlineData("Unavailable", true, true)]
    [InlineData("Unavailable", false, false)]
    public async Task CatalogReadsHealthWithoutResolvingOrClaimingLease(string health, bool recovery, bool available)
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.GetAvailablePoolsAsync("arena::chat", "chat", It.IsAny<CancellationToken>()))
            .ReturnsAsync([
                new AvailableModelPool { Id = "logical-fixed", Code = "fixed-v2", Name = "固定型号", ResolutionType = "LogicalModel",
                    Models = [new PoolModelInfo { HealthStatus = health, IsRecoveryProbeAvailable = recovery }] },
                new AvailableModelPool { Id = "legacy-pool", Code = "legacy", ResolutionType = "DefaultPool" }
            ]);
        var options = await new BusinessModelReferenceService(gateway.Object).GetOptionsAsync("arena::chat", "chat", CancellationToken.None);
        Assert.Single(options);
        Assert.Equal(available, options[0].Available);
        gateway.VerifyAll(); // strict mock: any resolve / send / lease call fails the test.
    }

    [Fact]
    public async Task CatalogTransportFailureIsNotAnEmptySuccessfulDirectory()
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.GetAvailablePoolsAsync("arena::chat", "chat", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new HttpRequestException("directory down"));
        await Assert.ThrowsAsync<HttpRequestException>(() => new BusinessModelReferenceService(gateway.Object)
            .GetOptionsAsync("arena::chat", "chat", CancellationToken.None));
    }
}
