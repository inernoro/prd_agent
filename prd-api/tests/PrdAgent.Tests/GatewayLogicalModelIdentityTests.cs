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
}
