using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 矩阵 D4/D5 + 矩阵 E：readiness 用生产同款判据，且用**正式环境的数据形态**回放。
///
/// 事故的形状是：配置存量是 image-gen（旧值），运行时判据只认 image_generation，
/// 于是真实生图候选数为 0，而 readiness 只检查「池在不在、有没有成员、平台开没开」，一路绿灯。
/// 下面第一组用例把那一天的数据形态原样喂进 readiness，要求它变红。
/// </summary>
public sealed class GatewayScenarioCapabilityReadinessTests
{
    private const string Text2ImgCaller = "visual-agent.image.text2img::generation";
    private const string Img2ImgCaller = "visual-agent.image.img2img::generation";
    private const string ChatCaller = "prd-agent.chat::chat";

    private static GatewayAppCallerRecord Caller(string code, string requestType, string status = "active")
        => new() { AppCallerCode = code, RequestType = requestType, Status = status };

    private static GatewayLogicalModel Logical(
        string id,
        string modelType,
        IEnumerable<string> capabilities,
        bool enabled = true,
        IEnumerable<string>? allowedCallers = null)
        => new()
        {
            Id = id,
            PublicId = id,
            ModelType = modelType,
            Enabled = enabled,
            Capabilities = capabilities.ToList(),
            AllowedAppCallerCodes = (allowedCallers ?? []).ToList(),
        };

    private static GatewayModelOffering Offering(
        string logicalModelId,
        bool enabled = true,
        ModelHealthStatus health = ModelHealthStatus.Healthy)
        => new()
        {
            Id = $"offering-{logicalModelId}-{health}",
            LogicalModelId = logicalModelId,
            Enabled = enabled,
            HealthStatus = health,
        };

    // ---------- E. 正式数据形态回放 ----------

    /// <summary>
    /// E1/E2：正式环境形态——逻辑生图模型 Capabilities 只有历史值 image-gen，
    /// 没有 CapabilitySchemaVersion，Offering 与平台都正常。
    /// 修复后必须判定「可路由」；把别名支持撤掉，这条立刻红。
    /// </summary>
    [Fact]
    public void 正式数据形态_只有image_gen历史值_必须判定为可路由()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation"), Caller(Img2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image-gen"])],
            [Offering("logical-image")]);

        snapshot.ScenarioCallers.ShouldBe(2);
        snapshot.RoutableCallers.ShouldBe(2);
        snapshot.BrokenCallers.ShouldBeEmpty();
    }

    /// <summary>
    /// D4：能力名彻底不兼容（既不是规范值也不是已登记别名）时，
    /// readiness 必须在用户失败之前就把这些 appCaller 点名报出来。
    /// </summary>
    [Fact]
    public void 能力名不兼容时_readiness点名报出不可路由的appCaller()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["some-unregistered-capability"])],
            [Offering("logical-image")]);

        snapshot.RoutableCallers.ShouldBe(0);
        snapshot.BrokenCallers.ShouldBe([Text2ImgCaller]);
    }

    /// <summary>D5：恢复配置（把能力改回规范值）后自动转绿，不需要重启。</summary>
    [Fact]
    public void 配置恢复后_readiness自动转绿()
    {
        var broken = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["nonsense"])],
            [Offering("logical-image")]);
        var repaired = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image_generation"])],
            [Offering("logical-image")]);

        broken.RoutableCallers.ShouldBe(0);
        repaired.RoutableCallers.ShouldBe(1);
        repaired.BrokenCallers.ShouldBeEmpty();
    }

    /// <summary>逻辑模型能力对，但没有任何可用 Offering，同样不算可路由。</summary>
    [Theory]
    [InlineData(false, ModelHealthStatus.Healthy)]
    [InlineData(true, ModelHealthStatus.Unavailable)]
    public void 能力匹配但无可用Offering_不算可路由(bool offeringEnabled, ModelHealthStatus health)
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image_generation"])],
            [Offering("logical-image", offeringEnabled, health)]);

        snapshot.RoutableCallers.ShouldBe(0);
        snapshot.BrokenCallers.ShouldBe([Text2ImgCaller]);
    }

    /// <summary>停用的逻辑模型不参与判定。</summary>
    [Fact]
    public void 停用的逻辑模型_不参与可路由判定()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image_generation"], enabled: false)],
            [Offering("logical-image")]);

        snapshot.RoutableCallers.ShouldBe(0);
    }

    /// <summary>
    /// 故障域隔离：img2img 的能力配错，不得把 text2img 也判成不可路由。
    /// readiness 报「1/2 可路由 + 点名坏的那个」，而不是整体不可用。
    /// </summary>
    [Fact]
    public void 一个场景配错_不把另一个场景一起判死()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation"), Caller(Img2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image_generation", "text2img"])],
            [Offering("logical-image")]);

        snapshot.ScenarioCallers.ShouldBe(2);
        snapshot.RoutableCallers.ShouldBe(1);
        snapshot.BrokenCallers.ShouldBe([Img2ImgCaller]);
    }

    /// <summary>非场景类 appCaller（对话）不进入本项判定，避免给它们发明约束。</summary>
    [Fact]
    public void 非场景appCaller_不进入场景能力判定()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(ChatCaller, "chat")],
            [Logical("logical-chat", "chat", ["chat"])],
            [Offering("logical-chat")]);

        snapshot.ScenarioCallers.ShouldBe(0);
        snapshot.BrokenCallers.ShouldBeEmpty();
    }

    /// <summary>显式 allowlist 仍然生效：能力对但没被授权的 appCaller 依旧不可路由。</summary>
    [Fact]
    public void 显式allowlist未授权时_仍判不可路由()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical(
                "logical-image",
                "generation",
                ["image_generation"],
                allowedCallers: ["someone.else.text2img::generation"])],
            [Offering("logical-image")]);

        snapshot.RoutableCallers.ShouldBe(0);
    }

    /// <summary>
    /// 存量没有 CapabilitySchemaVersion 的文档（E3）在运行时判定上必须与已迁移文档等价——
    /// 契约版本只影响迁移是否重算，不影响路由是否放行。
    /// </summary>
    [Fact]
    public void 未打契约版本的存量文档_路由判定与已迁移文档一致()
    {
        var legacyShape = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image-gen"])],
            [Offering("logical-image")]);
        var migratedShape = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical(
                "logical-image",
                "generation",
                GatewayCapabilityContract.Normalize("generation", ["image-gen"]).Persisted)],
            [Offering("logical-image")]);

        legacyShape.RoutableCallers.ShouldBe(migratedShape.RoutableCallers);
        legacyShape.RoutableCallers.ShouldBe(1);
    }
}
