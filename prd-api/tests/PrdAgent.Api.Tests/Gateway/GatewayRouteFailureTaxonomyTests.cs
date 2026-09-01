using PrdAgent.Core.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 矩阵 D：错误分类与可定位性。
///
/// 过去七种完全不同的失败（能力名不兼容 / appCaller 未绑池 / 池空 / 全熔断 / 平台关闭 /
/// Provider 故障 / Offering 配置错误）都被包装成同一个 IMAGE_GEN_UNAVAILABLE，
/// 用户只看到「当前没有可用的生图服务」，管理员据此误判成供应商宕机。
/// 这组用例把「每种失败必须有独立错误码 + 能点名对象」变成机械判据。
/// </summary>
public sealed class GatewayRouteFailureTaxonomyTests
{
    /// <summary>D1：题面要求的十类原因一个都不能少。</summary>
    [Fact]
    public void AllRequiredFailureReasons_AreDefined()
    {
        GatewayRouteFailure.All.ShouldBe(
        [
            "ROUTE_CONFIG_INCOMPATIBLE",
            "APPCALLER_POOL_UNBOUND",
            "MODEL_POOL_EMPTY",
            "MODEL_POOL_ALL_UNAVAILABLE",
            "LOGICAL_MODEL_CAPABILITY_MISMATCH",
            "OFFERING_UNRESOLVABLE",
            "PLATFORM_DISABLED",
            "PROVIDER_UNAVAILABLE",
            "PROVIDER_QUOTA_EXCEEDED",
            "GATEWAY_CONFIG_UNAVAILABLE",
            "MODEL_NOT_IN_CATALOG",
        ],
        ignoreOrder: true);
    }

    /// <summary>每个错误码都要有自己的处置提示，不许集体落到兜底文案。</summary>
    [Fact]
    public void EveryFailureReason_HasItsOwnAdminHint()
    {
        var fallback = GatewayRouteFailure.AdminHint("SOMETHING_NOT_CLASSIFIED");
        var hints = GatewayRouteFailure.All.Select(GatewayRouteFailure.AdminHint).ToList();

        hints.ShouldNotContain(fallback);
        hints.Distinct(StringComparer.Ordinal).Count().ShouldBe(GatewayRouteFailure.All.Count);
    }

    /// <summary>D2：配置不兼容不得被说成 Provider 宕机——用户文案必须指向「联系管理员」而不是「稍后重试」。</summary>
    [Theory]
    [InlineData(GatewayRouteFailure.RouteConfigIncompatible)]
    [InlineData(GatewayRouteFailure.AppCallerPoolUnbound)]
    [InlineData(GatewayRouteFailure.ModelPoolEmpty)]
    [InlineData(GatewayRouteFailure.LogicalModelCapabilityMismatch)]
    [InlineData(GatewayRouteFailure.OfferingUnresolvable)]
    [InlineData(GatewayRouteFailure.PlatformDisabled)]
    [InlineData(GatewayRouteFailure.ModelNotInCatalog)]
    public void ConfigurationFaults_TellUserRetryWontHelp(string failureCode)
    {
        GatewayRouteFailure.IsConfigurationFault(failureCode).ShouldBeTrue();
        GatewayRouteFailure.UserMessage(failureCode).ShouldContain("联系管理员");
        GatewayRouteFailure.UserMessage(failureCode).ShouldNotContain("稍后重试");
    }

    /// <summary>瞬时故障相反：告诉用户重试，而不是叫他去找管理员改配置。</summary>
    [Theory]
    [InlineData(GatewayRouteFailure.ProviderUnavailable)]
    [InlineData(GatewayRouteFailure.ModelPoolAllUnavailable)]
    [InlineData(GatewayRouteFailure.GatewayConfigUnavailable)]
    public void TransientFaults_TellUserToRetry(string failureCode)
    {
        GatewayRouteFailure.IsConfigurationFault(failureCode).ShouldBeFalse();
        GatewayRouteFailure.UserMessage(failureCode).ShouldContain("稍后");
    }

    /// <summary>D3：管理员定位串必须点名 appCaller / 逻辑模型 / Offering / 池 / 失败阶段。</summary>
    [Fact]
    public void AdminDiagnostic_NamesEveryLocator()
    {
        var result = ModelResolutionResult.NotFound(
            "logical-image-1",
            "逻辑模型不支持当前 appCaller 场景",
            GatewayRouteFailure.LogicalModelCapabilityMismatch,
            "logical-model-capability",
            "visual-agent.image.text2img::generation",
            logicalModelPublicId: "logical-image-1",
            offeringId: "offering-7",
            modelPoolId: "pool-image");

        var diagnostic = result.AdminFailureDiagnostic;

        diagnostic.ShouldContain("LOGICAL_MODEL_CAPABILITY_MISMATCH");
        diagnostic.ShouldContain("logical-model-capability");
        diagnostic.ShouldContain("visual-agent.image.text2img::generation");
        diagnostic.ShouldContain("logical-image-1");
        diagnostic.ShouldContain("offering-7");
        diagnostic.ShouldContain("pool-image");
    }

    /// <summary>用户文案里绝不能出现内部标识。</summary>
    [Fact]
    public void UserMessage_NeverLeaksInternalIdentifiers()
    {
        foreach (var code in GatewayRouteFailure.All)
        {
            var message = GatewayRouteFailure.UserMessage(code);
            message.ShouldNotContain("appCaller");
            message.ShouldNotContain("pool");
            message.ShouldNotContain("offering");
            message.ShouldNotContain("::");
        }
    }

    /// <summary>结构化原因必须跨 serving → MAP 的 HTTP 边界透传，否则回到自由文本猜原因。</summary>
    [Fact]
    public void FailureCode_SurvivesGatewayResolutionRoundTrip()
    {
        var result = ModelResolutionResult.NotFound(
            "pool-image",
            "所选模型池不在 appCaller 允许范围内",
            GatewayRouteFailure.RouteConfigIncompatible,
            "strict-pool-contract",
            "visual-agent.image.text2img::generation",
            modelPoolId: "pool-image");

        var transported = result.ToGatewayResolution();

        transported.FailureCode.ShouldBe(GatewayRouteFailure.RouteConfigIncompatible);
        transported.FailureStage.ShouldBe("strict-pool-contract");
        transported.FailureAppCallerCode.ShouldBe("visual-agent.image.text2img::generation");
        transported.FailureModelPoolId.ShouldBe("pool-image");
    }
}
