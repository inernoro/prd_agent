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
    /// <summary>这批用例默认都在同一个租户里；跨租户那条单独有用例。</summary>
    private const string Tenant = "tenant-alpha";

    private const string Text2ImgCaller = "visual-agent.image.text2img::generation";
    private const string Img2ImgCaller = "visual-agent.image.img2img::generation";
    private const string ChatCaller = "prd-agent.chat::chat";

    private static GatewayAppCallerRecord Caller(
        string code,
        string requestType,
        string status = "active",
        string tenant = Tenant)
        => new() { AppCallerCode = code, RequestType = requestType, Status = status, TenantId = tenant };

    /// <summary>
    /// 默认 <paramref name="isDefaultForType"/> = true，因为不点名的请求只有两条路能落到一个模型上：
    /// 被它认领，或者它是这个用途的默认。两样都没有的模型在运行时**一次都不会被选中**，
    /// 拿它当「配置正常」的样本就是在描述一个跑不起来的环境。
    /// 要构造「认领了这个调用方」的样本就传 <paramref name="claims"/>。
    /// </summary>
    private static GatewayLogicalModel Logical(
        string id,
        string modelType,
        IEnumerable<string> capabilities,
        bool enabled = true,
        IEnumerable<string>? allowedCallers = null,
        string tenant = Tenant,
        bool isDefaultForType = true,
        IEnumerable<string>? claims = null,
        int displayOrder = 100)
        => new()
        {
            Id = id,
            PublicId = id,
            TenantId = tenant,
            ModelType = modelType,
            Enabled = enabled,
            Capabilities = capabilities.ToList(),
            AllowedAppCallerCodes = (allowedCallers ?? []).ToList(),
            IsDefaultForType = isDefaultForType,
            DefaultForAppCallerCodes = (claims ?? []).ToList(),
            DisplayOrder = displayOrder,
        };

    /// <summary>「这些对外模型至少有一条真能用的线路」——视图算好的那个集合。</summary>
    private static IReadOnlySet<string> Routable(params string[] logicalModelIds)
        => new HashSet<string>(logicalModelIds, StringComparer.Ordinal);

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
            Routable("logical-image"),
            internalTenantId: Tenant);

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
            Routable("logical-image"),
            internalTenantId: Tenant);

        snapshot.RoutableCallers.ShouldBe(0);
        snapshot.BrokenCallers.ShouldBe([Text2ImgCaller]);
    }

    /// <summary>
    /// 认领是排他的：被认领的那一条不具备场景能力时，**不许**拿另一条无关模型顶上。
    ///
    /// 运行时先按认领挑出那一条，挑中之后成败就看它自己，不会回头去试用途默认。
    /// 这个组件曾经写成「同用途里有没有一条又能路由又满足能力的」——于是
    /// 「认领它的模型不具备该能力、而另一条恰好具备」时判绿，而那个调用方每一次请求都失败。
    /// </summary>
    [Fact]
    public void 认领的那一条不具备能力时_不拿别的模型顶上()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [
                // 认领了这个调用方，但能力对不上——运行时会选中它并失败。
                Logical(
                    "logical-claimed",
                    "generation",
                    ["some-unregistered-capability"],
                    isDefaultForType: false,
                    claims: [Text2ImgCaller],
                    displayOrder: 10),
                // 能力齐、也能路由，但它既没认领这个调用方、也轮不到——运行时一次都不会选中它。
                Logical("logical-capable", "generation", ["image_generation"], displayOrder: 20),
            ],
            Routable("logical-claimed", "logical-capable"),
            internalTenantId: Tenant);

        snapshot.RoutableCallers.ShouldBe(0);
        snapshot.BrokenCallers.ShouldBe([Text2ImgCaller]);
    }

    /// <summary>
    /// 同一条链的另一半：认领的那一条线路全挂时，同样不许由用途默认顶上。
    /// </summary>
    [Fact]
    public void 认领的那一条线路全挂时_不拿用途默认顶上()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [
                Logical(
                    "logical-claimed",
                    "generation",
                    ["image_generation"],
                    isDefaultForType: false,
                    claims: [Text2ImgCaller],
                    displayOrder: 10),
                Logical("logical-default", "generation", ["image_generation"], displayOrder: 20),
            ],
            // 认领的那一条没有可用线路，用途默认有。
            Routable("logical-default"),
            internalTenantId: Tenant);

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
            Routable("logical-image"),
            internalTenantId: Tenant);
        var repaired = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image_generation"])],
            Routable("logical-image"),
            internalTenantId: Tenant);

        broken.RoutableCallers.ShouldBe(0);
        repaired.RoutableCallers.ShouldBe(1);
        repaired.BrokenCallers.ShouldBeEmpty();
    }

    /// <summary>
    /// 逻辑模型能力对，但没有一条线路真能用，同样不算可路由。
    ///
    /// 「哪些线路算可用」由 BuildTenantRoutingViewAsync 一处算（停用、熔断、指向已停用的
    /// 物理模型或兑换所、过不了名录门，都不进这个集合），纯函数收到的已经是筛过的结果。
    /// 这里刻意不再喂裸的线路集合——喂线路就等于把那个判据又交回给每个调用方各判一次。
    /// </summary>
    [Fact]
    public void 能力匹配但没有可用线路_不算可路由()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical("logical-image", "generation", ["image_generation"])],
            Routable(),
            internalTenantId: Tenant);

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
            Routable("logical-image"),
            internalTenantId: Tenant);

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
            Routable("logical-image"),
            internalTenantId: Tenant);

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
            Routable("logical-chat"),
            internalTenantId: Tenant);

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
            Routable("logical-image"),
            internalTenantId: Tenant);

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
            Routable("logical-image"),
            internalTenantId: Tenant);
        var migratedShape = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation")],
            [Logical(
                "logical-image",
                "generation",
                GatewayCapabilityContract.Normalize("generation", ["image-gen"]).Persisted)],
            Routable("logical-image"),
            internalTenantId: Tenant);

        legacyShape.RoutableCallers.ShouldBe(migratedShape.RoutableCallers);
        legacyShape.RoutableCallers.ShouldBe(1);
    }

    /// <summary>
    /// 别的租户的模型不许让这个租户的调用方显示成可路由。
    ///
    /// 运行时解析每一次查询都带 `TenantId == 当前租户`，所以租户 B 配了一个能力齐全的模型，
    /// 租户 A 的请求一条都解析不到。就绪判据不带租户的话，一个「没有任何调用方能用」的
    /// 多租户部署照样报绿——灯亮着，功能是死的，与 2026-08-13 那次同形。
    /// </summary>
    [Fact]
    public void 别的租户的模型不算这个租户的可路由()
    {
        var snapshot = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation", tenant: "tenant-alpha")],
            [Logical("logical-image", "generation", ["image_generation"], tenant: "tenant-beta")],
            Routable("logical-image"),
            internalTenantId: Tenant);

        snapshot.ScenarioCallers.ShouldBe(1);
        snapshot.RoutableCallers.ShouldBe(0);
        snapshot.BrokenCallers.ShouldBe([Text2ImgCaller]);
    }

    /// <summary>
    /// 调用方没写租户（存量记录）时落到宿主的内部租户，与运行时拿不到请求上下文时的兜底同源。
    /// 模型侧**不做**同样的兜底：运行时是严格相等，一条 TenantId 为空的模型它一条都不选中，
    /// 这里跟着严格，宽了就又回到「这里绿、那里红」。
    /// </summary>
    [Fact]
    public void 调用方没写租户时落到内部租户()
    {
        var hosted = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation", tenant: "")],
            [Logical("logical-image", "generation", ["image_generation"], tenant: "llmgw-internal")],
            Routable("logical-image"),
            internalTenantId: "llmgw-internal");
        hosted.RoutableCallers.ShouldBe(1);

        var emptyModelTenant = GatewayServingReadinessProbe.EvaluateScenarioCapability(
            [Caller(Text2ImgCaller, "generation", tenant: "")],
            [Logical("logical-image", "generation", ["image_generation"], tenant: "")],
            Routable("logical-image"),
            internalTenantId: "llmgw-internal");
        emptyModelTenant.RoutableCallers.ShouldBe(
            0,
            "模型侧不许跟着兜底：运行时用的是严格相等，空租户模型一条都选不中");
    }
}
