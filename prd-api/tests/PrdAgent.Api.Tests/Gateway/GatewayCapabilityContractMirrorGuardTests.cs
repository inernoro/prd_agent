using PrdAgent.Core.Models;
using PrdAgent.LlmGw.LogicalModels;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 防「判据分裂再次漂移」的守卫。
///
/// 运行时（MAP ModelResolver + llmgw serving readiness）用的是
/// <see cref="GatewayCapabilityContract"/>；写入侧（llmgw console-api）按既定架构不引用
/// PrdAgent.*（镜像构建上下文只有 llmgw/console-api），保留一份镜像
/// <see cref="LogicalModelCapabilityPolicy"/>。
///
/// 2026-08-13 的事故根因就是这两侧各自演化：写入侧只认 image_generation、
/// 运行时也只认 image_generation，而正式数据是 image-gen——没有任何东西发现它们已经不一致。
/// 本测试把「两张表必须逐条相同」变成机械判据：任一侧新增规范能力或历史别名而另一侧没跟上，CI 立刻红。
///
/// 这条守卫必须能红：把任一侧的表改一个字，下面第一个用例就会失败。
/// </summary>
public sealed class GatewayCapabilityContractMirrorGuardTests
{
    [Fact]
    public void CanonicalCapabilities_AreIdenticalOnBothSides()
    {
        var runtime = GatewayCapabilityContract.CanonicalCapabilities.OrderBy(x => x, StringComparer.Ordinal).ToList();
        var console = LogicalModelCapabilityPolicy.CanonicalCapabilities.OrderBy(x => x, StringComparer.Ordinal).ToList();

        console.ShouldBe(
            runtime,
            "写入侧镜像与运行时契约的规范能力表必须逐条一致，"
            + "否则控制台写进去的值运行时不认，就是 2026-08-13 事故的复刻。");
    }

    [Fact]
    public void LegacyAliases_AreIdenticalOnBothSides()
    {
        var runtime = GatewayCapabilityContract.LegacyAliases
            .OrderBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => $"{x.Key}=>{x.Value}")
            .ToList();
        var console = LogicalModelCapabilityPolicy.LegacyAliases
            .OrderBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => $"{x.Key}=>{x.Value}")
            .ToList();

        console.ShouldBe(runtime, "历史别名表必须逐条一致，别名只在一侧登记等于没登记。");
    }

    [Fact]
    public void SchemaVersion_IsIdenticalOnBothSides()
    {
        LogicalModelCapabilityPolicy.SchemaVersion.ShouldBe(GatewayCapabilityContract.SchemaVersion);
        LogicalModelCapabilityPolicy.SchemaVersionField.ShouldBe(GatewayCapabilityContract.SchemaVersionField);
    }

    [Fact]
    public void ImageScenarioCapabilities_AreIdenticalOnBothSides()
    {
        LogicalModelCapabilityPolicy.ImageScenarioCapabilities
            .ShouldBe(GatewayCapabilityContract.ImageScenarioCapabilities);
    }

    /// <summary>
    /// 不只比表，还要比**行为**：同一组输入在两侧必须归一出同一个结果。
    /// 表一致但算法漂移（例如一侧忘了补场景能力）照样是分裂。
    /// </summary>
    [Theory]
    [InlineData("generation", new[] { "image-gen" })]
    [InlineData("generation", new[] { "image_generation" })]
    [InlineData("generation", new[] { "image_generation", "text2img" })]
    [InlineData("generation", new[] { "image_generation", "image_layering" })]
    [InlineData("generation", new[] { "IMAGE-GEN", "  img2img  " })]
    [InlineData("generation", new[] { "image-gen", "made-up" })]
    [InlineData("chat", new[] { "chat", "function_calling" })]
    [InlineData("chat", new[] { "image_generation" })]
    [InlineData("generation", new string[0])]
    public void NormalizeBehaviour_IsIdenticalOnBothSides(string modelType, string[] input)
    {
        var runtime = GatewayCapabilityContract.Normalize(modelType, input);
        var console = LogicalModelCapabilityPolicy.NormalizeDetailed(modelType, input);

        console.Persisted.ShouldBe(runtime.Persisted);
        console.Canonical.ShouldBe(runtime.Canonical);
        console.Unknown.ShouldBe(runtime.Unknown);
        console.Changed.ShouldBe(runtime.Changed);
    }
}
