using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 矩阵 A（读取侧）+ 矩阵 B（场景路由判定）：能力契约本体。
///
/// 这些断言用的是**生产运行时同一个函数**——ModelResolver 与 llmgw serving readiness
/// 都只转发到 <see cref="GatewayCapabilityContract"/>，所以这里绿灯代表的是真实判据绿灯，
/// 不是「测试自己造了一份近似逻辑然后自己验自己」。
/// </summary>
public sealed class GatewayCapabilityContractTests
{
    private const string Text2ImgCaller = "visual-agent.image.text2img::generation";
    private const string Img2ImgCaller = "visual-agent.image.img2img::generation";
    private const string VisionCaller = "visual-agent.image.vision::generation";
    private const string LayeringCaller = "visual-agent.image.layering::generation";

    // ---------- A. 能力兼容 ----------

    /// <summary>A1/A2：正式环境存量的 image-gen 与规范值 image_generation 行为必须一致。</summary>
    [Theory]
    [InlineData("image_generation", Text2ImgCaller)]
    [InlineData("image_generation", Img2ImgCaller)]
    [InlineData("image_generation", VisionCaller)]
    [InlineData("image-gen", Text2ImgCaller)]
    [InlineData("image-gen", Img2ImgCaller)]
    [InlineData("image-gen", VisionCaller)]
    [InlineData("IMAGE-GEN", Text2ImgCaller)]
    [InlineData("image_gen", Text2ImgCaller)]
    public void GenericImageCapability_ServesEveryImageScenario(string capability, string appCallerCode)
    {
        GatewayCapabilityContract
            .SupportsAppCallerScenario([capability], null, appCallerCode)
            .ShouldBeTrue();
    }

    /// <summary>
    /// 事故复刻用例：正式数据形态（逻辑模型只写 image-gen）在 text2img 场景下必须可路由。
    /// 把 image-gen 从别名表里删掉，这条会红——它就是那两小时全站生图不可用的机械判据。
    /// </summary>
    [Fact]
    public void ProductionLegacyShape_ImageGenOnly_RemainsRoutable()
    {
        var productionShapedCapabilities = new List<string> { "image-gen" };

        GatewayCapabilityContract
            .SupportsAppCallerScenario(productionShapedCapabilities, [], Text2ImgCaller)
            .ShouldBeTrue("正式环境逻辑生图模型的存量能力值就是 image-gen，运行时必须认它");
    }

    /// <summary>A4：场景之间不许串线。</summary>
    [Theory]
    [InlineData("text2img", Img2ImgCaller)]
    [InlineData("text2img", VisionCaller)]
    [InlineData("img2img", Text2ImgCaller)]
    [InlineData("vision_generation", Text2ImgCaller)]
    public void DeclaredScenario_DoesNotLeakIntoOtherScenarios(string capability, string appCallerCode)
    {
        GatewayCapabilityContract
            .SupportsAppCallerScenario(["image_generation", capability], null, appCallerCode)
            .ShouldBeFalse();
    }

    [Theory]
    [InlineData("text2img", Text2ImgCaller)]
    [InlineData("img2img", Img2ImgCaller)]
    [InlineData("vision_generation", VisionCaller)]
    public void DeclaredScenario_ServesItsOwnScenario(string capability, string appCallerCode)
    {
        GatewayCapabilityContract
            .SupportsAppCallerScenario(["image_generation", capability], null, appCallerCode)
            .ShouldBeTrue();
    }

    /// <summary>A5：分层是动作能力，永远不进普通生图，只能被专用 appCaller 点名。</summary>
    [Theory]
    [InlineData(Text2ImgCaller)]
    [InlineData(Img2ImgCaller)]
    [InlineData(VisionCaller)]
    public void ImageLayering_NeverEntersGeneralGeneration(string appCallerCode)
    {
        var capabilities = new[] { "image_generation", "image_layering", "text2img", "img2img", "vision_generation" };

        GatewayCapabilityContract.SupportsAppCallerScenario(capabilities, null, appCallerCode).ShouldBeFalse();
        GatewayCapabilityContract.SupportsAppCallerScenario(capabilities, null, LayeringCaller).ShouldBeTrue();
    }

    /// <summary>分层的 kebab 写法（image-layering）同样必须被隔离——只认一种写法就是漏判。</summary>
    [Fact]
    public void ImageLayering_KebabAlias_IsAlsoIsolated()
    {
        GatewayCapabilityContract
            .SupportsAppCallerScenario(["image-layering"], null, Text2ImgCaller)
            .ShouldBeFalse();
        GatewayCapabilityContract
            .IsOperationOnly(null, ["image-layering"])
            .ShouldBeTrue();
        GatewayCapabilityContract
            .IsOperationOnly("image-layering", null)
            .ShouldBeTrue();
    }

    /// <summary>
    /// A5 的数据侧：分层模型不得被「补齐」成看起来能文生图。
    /// 路由上它已被短路隔离，但数据里留下相反的记录会误导下一个读它的人。
    /// </summary>
    [Fact]
    public void ImageLayering_DoesNotGetGeneralScenariosBackfilled()
    {
        var result = GatewayCapabilityContract.Normalize(
            "generation",
            ["image_generation", "image_layering"]);

        result.Persisted.ShouldBe(["image_generation", "image_layering"]);
        result.ScenarioBackfilled.ShouldBeFalse();
    }

    /// <summary>A6：未知能力不被静默丢弃。</summary>
    [Fact]
    public void UnknownCapability_IsSurfacedNotSwallowed()
    {
        var result = GatewayCapabilityContract.Normalize("generation", ["image-gen", "brand-new-thing"]);

        result.Unknown.ShouldBe(["brand-new-thing"]);
        result.Persisted.ShouldContain("brand-new-thing");
        result.Canonical.ShouldNotContain("brand-new-thing");
        GatewayCapabilityContract.UnknownTokens(["brand-new-thing"]).ShouldBe(["brand-new-thing"]);
    }

    /// <summary>未知能力不参与路由判定：它既不放行也不冒充场景声明。</summary>
    [Fact]
    public void UnknownCapability_DoesNotAffectRouting()
    {
        GatewayCapabilityContract
            .SupportsAppCallerScenario(["image-gen", "brand-new-thing"], null, Text2ImgCaller)
            .ShouldBeTrue();
        GatewayCapabilityContract
            .SupportsAppCallerScenario(["brand-new-thing"], null, Text2ImgCaller)
            .ShouldBeFalse();
    }

    /// <summary>A7：归一化幂等。</summary>
    [Theory]
    [InlineData("generation", new[] { "image-gen" })]
    [InlineData("generation", new[] { "image_generation", "img2img" })]
    [InlineData("chat", new[] { "chat" })]
    public void Normalize_IsIdempotent(string modelType, string[] input)
    {
        var once = GatewayCapabilityContract.Normalize(modelType, input);
        var twice = GatewayCapabilityContract.Normalize(modelType, once.Persisted);

        twice.Persisted.ShouldBe(once.Persisted);
        twice.Changed.ShouldBeFalse();
    }

    /// <summary>A8：归一后不残留任何历史别名。</summary>
    [Fact]
    public void Normalize_LeavesNoLegacyAlias()
    {
        foreach (var alias in GatewayCapabilityContract.LegacyAliases.Keys)
        {
            GatewayCapabilityContract.Normalize("generation", [alias])
                .Persisted.ShouldNotContain(alias);
        }
    }

    /// <summary>别名表必须是「有限」的：每个别名都指向一个真实存在的规范能力。</summary>
    [Fact]
    public void EveryLegacyAlias_PointsToACanonicalCapability()
    {
        foreach (var (alias, canonical) in GatewayCapabilityContract.LegacyAliases)
        {
            GatewayCapabilityContract.CanonicalCapabilities.ShouldContain(
                canonical,
                $"别名 {alias} 指向了一个不存在的规范能力 {canonical}");
            GatewayCapabilityContract.CanonicalCapabilities.ShouldNotContain(
                alias,
                $"{alias} 同时出现在规范表与别名表里，归一化会自指");
        }
    }

    // ---------- B. 路由约束 ----------

    /// <summary>B7 的判定基础：显式 allowlist 配了就必须命中，不因能力匹配而放宽。</summary>
    [Fact]
    public void ExplicitAllowlist_StillGatesEvenWhenCapabilityMatches()
    {
        GatewayCapabilityContract
            .SupportsAppCallerScenario(
                ["image_generation", "text2img"],
                ["another.image.text2img::generation"],
                Text2ImgCaller)
            .ShouldBeFalse();

        GatewayCapabilityContract
            .SupportsAppCallerScenario(
                ["image_generation", "text2img"],
                [Text2ImgCaller],
                Text2ImgCaller)
            .ShouldBeTrue();
    }

    /// <summary>非图片 appCaller 不得被凭空发明一条能力约束。</summary>
    [Theory]
    [InlineData("map.chat::chat")]
    [InlineData("prd-agent.chat::chat")]
    [InlineData("visual-agent.image.text2img::chat")]
    public void NonScenarioCaller_HasNoInventedRequirement(string appCallerCode)
    {
        GatewayCapabilityContract.RequiredScenarioCapability(appCallerCode).ShouldBeNull();
        GatewayCapabilityContract.SupportsAppCallerScenario(["chat"], null, appCallerCode).ShouldBeTrue();
    }

    [Theory]
    [InlineData(Text2ImgCaller, "text2img")]
    [InlineData("literary-agent.illustration.img2img::generation", "img2img")]
    [InlineData(VisionCaller, "vision_generation")]
    public void RequiredScenarioCapability_IsDerivedFromAppCallerSuffix(string appCallerCode, string expected)
    {
        GatewayCapabilityContract.RequiredScenarioCapability(appCallerCode).ShouldBe(expected);
    }

    [Fact]
    public void EmptyCapabilities_NeverServeAnImageScenario()
    {
        GatewayCapabilityContract.SupportsAppCallerScenario(null, null, Text2ImgCaller).ShouldBeFalse();
        GatewayCapabilityContract.SupportsAppCallerScenario([], [], Text2ImgCaller).ShouldBeFalse();
    }
}
