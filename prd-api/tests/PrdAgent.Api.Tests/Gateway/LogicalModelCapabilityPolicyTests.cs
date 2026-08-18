using PrdAgent.LlmGw.LogicalModels;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 矩阵 A：能力兼容与迁移（写入侧）。
/// </summary>
public sealed class LogicalModelCapabilityPolicyTests
{
    [Fact]
    public void GenericImageGeneration_NormalizesToAllImageScenarios()
    {
        var capabilities = LogicalModelCapabilityPolicy.Normalize(
            "generation",
            [" image_generation "]);

        capabilities.ShouldBe([
            "image_generation",
            "text2img",
            "img2img",
            "vision_generation",
        ]);
    }

    /// <summary>A1：正式环境存量的 image-gen 必须归一成 image_generation 并补齐场景。</summary>
    [Theory]
    [InlineData("image-gen")]
    [InlineData("image_gen")]
    [InlineData("IMAGE-GEN")]
    public void LegacyImageGenAlias_MigratesToCanonicalGeneration(string legacy)
    {
        var capabilities = LogicalModelCapabilityPolicy.Normalize("generation", [legacy]);

        capabilities.ShouldBe([
            "image_generation",
            "text2img",
            "img2img",
            "vision_generation",
        ]);
    }

    /// <summary>A3：用途名 generation 落到存储层能力名 image_generation。</summary>
    [Fact]
    public void UsageAliasImageGeneration_MapsToStorageCapability()
    {
        LogicalModelCapabilityPolicy.TryCanonicalize("image-generation")
            .ShouldBe("image_generation");
        LogicalModelCapabilityPolicy.TryCanonicalize("video-gen")
            .ShouldBe("video_generation");
    }

    [Fact]
    public void ExplicitScenarioSelection_IsPreservedWithoutBroadening()
    {
        var capabilities = LogicalModelCapabilityPolicy.Normalize(
            "generation",
            ["image_generation", "text2img"]);

        capabilities.ShouldBe(["image_generation", "text2img"]);
    }

    /// <summary>A5：分层能力不会被补成普通生图场景。</summary>
    [Fact]
    public void ImageLayering_DoesNotGainGeneralImageScenarios()
    {
        var capabilities = LogicalModelCapabilityPolicy.Normalize(
            "generation",
            ["image_generation", "image_layering"]);

        capabilities.ShouldBe(["image_generation", "image_layering"]);
    }

    /// <summary>A6：未知能力不得被静默丢弃，必须原样保留并点名。</summary>
    [Fact]
    public void UnknownCapability_IsPreservedAndReported()
    {
        var result = LogicalModelCapabilityPolicy.NormalizeDetailed(
            "generation",
            ["image-gen", "totally-made-up-capability"]);

        result.Persisted.ShouldContain("totally-made-up-capability");
        result.Unknown.ShouldBe(["totally-made-up-capability"]);
        result.Canonical.ShouldNotContain("totally-made-up-capability");
    }

    /// <summary>A7：归一化幂等——把结果再喂一次不产生任何变化。</summary>
    [Theory]
    [InlineData("generation", new[] { "image-gen" })]
    [InlineData("generation", new[] { "image_generation", "img2img" })]
    [InlineData("generation", new[] { "image_generation", "image_layering" })]
    [InlineData("chat", new[] { "chat", "function_calling" })]
    [InlineData("generation", new[] { "image-gen", "unknown-token" })]
    public void Normalize_IsIdempotent(string modelType, string[] input)
    {
        var once = LogicalModelCapabilityPolicy.NormalizeDetailed(modelType, input);
        var twice = LogicalModelCapabilityPolicy.NormalizeDetailed(modelType, once.Persisted);

        twice.Persisted.ShouldBe(once.Persisted);
        twice.Changed.ShouldBeFalse();
    }

    /// <summary>A8：归一后的结果里不允许残留任何历史别名。</summary>
    [Fact]
    public void NormalizedResult_ContainsNoLegacyAlias()
    {
        foreach (var alias in LogicalModelCapabilityPolicy.LegacyAliases.Keys)
        {
            var persisted = LogicalModelCapabilityPolicy.Normalize("generation", [alias]);
            persisted.ShouldNotContain(alias);
        }
    }

    [Fact]
    public void EmptyAndWhitespaceTokens_AreDropped()
    {
        var result = LogicalModelCapabilityPolicy.NormalizeDetailed("chat", ["", "  ", "chat"]);

        result.Persisted.ShouldBe(["chat"]);
        result.Unknown.ShouldBeEmpty();
    }
}
