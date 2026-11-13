using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using Xunit;

namespace PrdAgent.Tests;

public class GatewayLogicalModelIdentityTests
{
    [Theory]
    [InlineData("image-quality", true)]
    [InlineData(" IMAGE-2-ALL ", true)]
    [InlineData("gpt-image-2-all", true)]
    [InlineData("gpt-image-2", false)]
    [InlineData("gpt-image-3", false)]
    [InlineData("unregistered-model", false)]
    [InlineData("", false)]
    public void OnlyCanonicalAndExplicitCompatibilityNamesAreAccepted(string requested, bool accepted)
        => Assert.Equal(accepted, GatewayLogicalModelIdentity.Accepts(requested, "image-quality",
            ["image-2-all", "gpt-image-2-all"]));

    [Fact]
    public void AliasCannotAuthorizeMissingCanonicalIdentity()
        => Assert.False(GatewayLogicalModelIdentity.Accepts("image-2-all", null, ["image-2-all"]));

    [Fact]
    public void LegacyDocumentsRemainFixedAndHaveNoImplicitAliases()
    {
        var model = BsonSerializer.Deserialize<GatewayLogicalModel>(new BsonDocument
        {
            { "_id", "legacy" }, { "PublicId", "gpt-image-2" },
        });
        Assert.Equal("fixed", model.IdentityKind);
        Assert.Empty(model.Aliases);
    }

    [Fact]
    public void ResolvedAliasesCrossGatewayBoundaryWithoutChangingCanonicalIdentity()
    {
        var result = new ModelResolutionResult
        {
            Success = true, LogicalModelPublicId = "image-quality", ActualModel = "gpt-image-2.6-flare",
            ExpectedModel = "image-2-all", AcceptedModelAliases = ["image-2-all"],
        }.ToGatewayResolution();
        Assert.Equal("image-quality", result.LogicalModelPublicId);
        Assert.Equal("gpt-image-2.6-flare", result.ActualModel);
        Assert.True(GatewayLogicalModelIdentity.Accepts(result.ExpectedModel, result.LogicalModelPublicId, result.AcceptedModelAliases));
        Assert.False(GatewayLogicalModelIdentity.Accepts("gpt-image-2", result.LogicalModelPublicId, result.AcceptedModelAliases));
    }
    [Theory]
    [InlineData("image-quality", true)]
    [InlineData("image-2-all", true)]
    [InlineData("gpt-image-2", false)]
    [InlineData("another-model", false)]
    public async Task StrictLogicalBoundaryAcceptsOnlyResolvedIdentity(string requested, bool success)
    {
        ILlmGateway gateway = new IdentityGateway();
        var result = await gateway.ResolveRequiredLogicalModelAsync("visual-agent.image.text2img::generation", "generation", requested);
        Assert.Equal(success, result.Success);
        if (success) Assert.Equal("image-quality", result.LogicalModelPublicId);
    }

    private sealed class IdentityGateway : ILlmGateway
    {
        public Task<GatewayModelResolution> ResolveModelAsync(string appCallerCode, string modelType,
            string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null,
            CancellationToken ct = default) => Task.FromResult(new GatewayModelResolution
            { Success = true, LogicalModelPublicId = "image-quality", ExpectedModel = expectedModel,
                ActualModel = "gpt-image-2.6-flare", AcceptedModelAliases = ["image-2-all"] });
        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default) => throw new NotSupportedException();
        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
        { await Task.CompletedTask; yield break; }
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest request, GatewayModelResolution resolution,
            CancellationToken ct = default) => throw new NotSupportedException();
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string appCallerCode, string modelType,
            CancellationToken ct = default) => throw new NotSupportedException();
        public PrdAgent.Core.Interfaces.ILLMClient CreateClient(string appCallerCode, string modelType,
            int maxTokens = 4096, double temperature = 0.2, bool includeThinking = false,
            string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null) => throw new NotSupportedException();
    }

}
