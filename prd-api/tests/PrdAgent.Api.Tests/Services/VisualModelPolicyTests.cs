using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class VisualModelPolicyTests
{
    private const string FutureDefaultModel = "future-image-default-2099";
    private const string FutureOptionalModel = "future-image-optional-2099";

    private static VisualModelPolicy Policy() => new()
    {
        DefaultModelId = FutureDefaultModel,
        Models =
        [
            new() { ModelId = FutureOptionalModel, DisplayName = "未来可选模型" },
            new() { ModelId = FutureDefaultModel, DisplayName = "未来默认模型" },
        ],
    };

    private static GatewayImageModel Model(string id) => new()
    {
        Model = new AvailableModelPool { Id = "id-" + id, Code = id, Name = id, IsDefault = true, Models = [new PoolModelInfo { ModelId = id }] },
    };

    [Fact]
    public void DefaultIsExplicit_NotListOrderOrGatewayDefault()
    {
        var result = VisualModelPolicyService.Project(Policy(), [Model(FutureDefaultModel), Model(FutureOptionalModel), Model("another-future-model")]);
        Assert.Equal(new[] { FutureOptionalModel, FutureDefaultModel }, result.Select(x => x.Code));
        Assert.False(result[0].IsDefault);
        Assert.True(result[1].IsDefault);
    }

    [Fact]
    public void UnavailableDefaultRemainsVisible_ButLosesExecutableDefaultFlag()
    {
        var result = VisualModelPolicyService.Project(Policy(), [Model(FutureOptionalModel)]);
        var unavailable = Assert.Single(result, x => x.Code == FutureDefaultModel);
        Assert.Equal(FutureDefaultModel, unavailable.Code);
        Assert.Equal("未来默认模型", unavailable.Name);
        Assert.False(unavailable.IsDefault);
        Assert.Empty(unavailable.Models);
    }

    [Fact]
    public void RuntimePolicyIntersectsGatewayCatalog_WithoutInventingFallback()
    {
        var result = VisualModelPolicyService.ReconcileForRuntime(Policy(), [Model(FutureOptionalModel)]);

        Assert.Equal([FutureOptionalModel], result.Models.Select(x => x.ModelId));
        Assert.Equal(string.Empty, result.DefaultModelId);
        Assert.Null(result.Select(null));
        Assert.Equal(FutureOptionalModel, result.Select(FutureOptionalModel));
    }

    [Theory]
    [InlineData("future-image-model-2099")]
    [InlineData("vendor-neutral-image-edit-v42")]
    [InlineData("newly-added-model-without-code-change")]
    public void RuntimeReconciliationUsesExactPublicIdForEveryImageModel(string publicId)
    {
        var stored = new VisualModelPolicy
        {
            DefaultModelId = publicId,
            Models = [new() { ModelId = publicId, DisplayName = publicId }],
        };

        var present = VisualModelPolicyService.ReconcileForRuntime(stored, [Model(publicId)]);
        Assert.Equal(publicId, present.DefaultModelId);
        Assert.Equal(publicId, Assert.Single(present.Models).ModelId);

        var deleted = VisualModelPolicyService.ReconcileForRuntime(stored, []);
        Assert.Equal(string.Empty, deleted.DefaultModelId);
        Assert.Empty(deleted.Models);
        Assert.Null(deleted.Select(null));
    }

    [Fact]
    public void RenameIsDeletePlusAdd_AndNeverSilentlyRebindsTheOldPolicy()
    {
        var stored = new VisualModelPolicy
        {
            DefaultModelId = "future-image-before-rename",
            Models = [new() { ModelId = "future-image-before-rename", DisplayName = "重命名前" }],
        };

        var afterGatewayRename = VisualModelPolicyService.ReconcileForRuntime(
            stored,
            [Model("future-image-after-rename")]);

        Assert.Empty(afterGatewayRename.Models);
        Assert.Equal(string.Empty, afterGatewayRename.DefaultModelId);
        Assert.Null(afterGatewayRename.Select(null));
    }

    [Theory]
    [InlineData(null, FutureDefaultModel)]
    [InlineData(FutureOptionalModel, FutureOptionalModel)]
    [InlineData("renamed-future-model", null)]
    [InlineData("new-model", null)]
    public void SelectionUsesOnlyBusinessAllowlist(string? requested, string? expected)
        => Assert.Equal(expected, Policy().Select(requested));

    [Fact]
    public void MissingPolicyDoesNotInventDefault() => Assert.Null(new VisualModelPolicy().Select(null));

    [Fact]
    public void InvalidDefaultAndDuplicateEntriesAreRejected()
    {
        var policy = Policy();
        Assert.Null(policy.Validate());
        policy.DefaultModelId = "not-open";
        Assert.NotNull(policy.Validate());
        policy.DefaultModelId = FutureDefaultModel;
        policy.Models.Add(new() { ModelId = FutureDefaultModel });
        Assert.NotNull(policy.Validate());
    }

    [Theory]
    [InlineData("1024x1024", true)]
    [InlineData("1536x1024", true)]
    [InlineData("1024x1536", true)]
    [InlineData("2048x2048", false)]
    [InlineData("1024", false)]
    public void GatewayValidatesTheSameSizesItPublishes(string size, bool valid)
    {
        var resolved = new GatewayModelResolution { Success = true, ActualModel = "gpt-image-1" };
        var error = GatewayImageModelCatalog.ValidateRequest(new GatewayCanonicalImageRequest { Prompt = "白桃", Size = size }, resolved);
        Assert.Equal(valid, error is null);
        if (valid) Assert.Contains(GatewayImageModelCatalog.Describe(resolved)!.SizesByResolution.Values.SelectMany(x => x), x => x.Size == size);
    }
}
