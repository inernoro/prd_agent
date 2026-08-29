namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 路由解析失败的结构化原因。
///
/// 为什么必须拆开：能力名不兼容、appCaller 未绑池、池空、成员全熔断、平台关闭、Provider 故障、
/// Offering 配置错误，过去全部被包装成同一个 IMAGE_GEN_UNAVAILABLE，
/// 用户只看到「当前没有可用的生图服务」，管理员据此误判为供应商宕机，
/// 每次都要从零复现才能定位。拆成独立错误码之后：
/// 普通用户拿到「结果 + 恢复动作」，管理员日志拿到「哪个 appCaller / 逻辑模型 / Offering / 哪一阶段」。
///
/// 判据只此一份：Resolver 产出 <see cref="ModelResolutionResult.FailureCode"/>，
/// 应用层只做展示映射，禁止再按错误文案做字符串匹配来猜原因。
/// </summary>
public static class GatewayRouteFailure
{
    /// <summary>配置本身不兼容：所选池 / 模型不在 appCaller 允许范围，或请求与配置语义冲突。</summary>
    public const string RouteConfigIncompatible = "ROUTE_CONFIG_INCOMPATIBLE";

    /// <summary>appCaller 没有绑定任何可用模型池（含未注册、未激活、未绑池）。</summary>
    public const string AppCallerPoolUnbound = "APPCALLER_POOL_UNBOUND";

    /// <summary>绑定的模型池存在但没有成员。</summary>
    public const string ModelPoolEmpty = "MODEL_POOL_EMPTY";

    /// <summary>池里有成员，但全部处于不可用（熔断 / healthy 判定为 Unavailable）。</summary>
    public const string ModelPoolAllUnavailable = "MODEL_POOL_ALL_UNAVAILABLE";

    /// <summary>逻辑模型存在，但它声明的能力不支持当前 appCaller 的场景。</summary>
    public const string LogicalModelCapabilityMismatch = "LOGICAL_MODEL_CAPABILITY_MISMATCH";

    /// <summary>逻辑模型有 Offering，但一条都解析不出可用上游（目标缺失 / 协议缺失 / 凭据不可解密）。</summary>
    public const string OfferingUnresolvable = "OFFERING_UNRESOLVABLE";

    /// <summary>命中的平台被关闭。</summary>
    public const string PlatformDisabled = "PLATFORM_DISABLED";

    /// <summary>上游 Provider 故障。</summary>
    public const string ProviderUnavailable = "PROVIDER_UNAVAILABLE";

    /// <summary>上游 Provider 配额 / 限流耗尽。</summary>
    public const string ProviderQuotaExceeded = "PROVIDER_QUOTA_EXCEEDED";

    /// <summary>网关配置面本身读不到（Mongo 不可达 / 配置权威缺失），与「配置错了」区分开。</summary>
    public const string GatewayConfigUnavailable = "GATEWAY_CONFIG_UNAVAILABLE";

    /// <summary>
    /// 选中的模型既不在内置名录里，也没有被管理员显式放行。
    ///
    /// 与「池空 / 全熔断」分开是有意的：那两个说的是「没有可用成员」，这个说的是
    /// **「这个成员不该被用」**——它绕过了控制台的白名单门（例如有人直接往库里写模型文档），
    /// 处置动作完全不同：不是等恢复、不是补成员，是去确认这个模型该不该存在。
    /// </summary>
    public const string ModelNotInCatalog = "MODEL_NOT_IN_CATALOG";

    /// <summary>全部结构化原因，供守卫测试与前端映射表对齐使用。</summary>
    public static readonly IReadOnlyList<string> All =
    [
        RouteConfigIncompatible,
        AppCallerPoolUnbound,
        ModelPoolEmpty,
        ModelPoolAllUnavailable,
        LogicalModelCapabilityMismatch,
        OfferingUnresolvable,
        PlatformDisabled,
        ProviderUnavailable,
        ProviderQuotaExceeded,
        GatewayConfigUnavailable,
        ModelNotInCatalog,
    ];

    /// <summary>
    /// 普通用户看到的文案：说清「现在是什么结果」+「他能做什么」。
    /// 一律不暴露 appCaller、池 ID、Offering ID 等内部标识。
    /// </summary>
    public static string UserMessage(string? failureCode)
        => failureCode switch
        {
            ProviderQuotaExceeded => "当前模型用量已达上限，请稍后再试或联系管理员调整配额。",
            ProviderUnavailable => "上游模型服务暂时故障，请稍后重试。",
            ModelPoolAllUnavailable => "当前可用模型都在恢复中，请稍后重试。",
            GatewayConfigUnavailable => "模型配置服务暂时不可用，请稍后重试。",
            RouteConfigIncompatible
                or AppCallerPoolUnbound
                or ModelPoolEmpty
                or LogicalModelCapabilityMismatch
                or OfferingUnresolvable
                or PlatformDisabled
                or ModelNotInCatalog => "该功能的模型配置尚未就绪，重试无法解决，请联系管理员处理。",
            _ => "当前服务暂时不可用，请稍后重试。若持续出现，请联系管理员。",
        };

    /// <summary>
    /// 管理员侧的处置提示。与用户文案分开，避免为了让用户看懂而丢掉可定位信息。
    /// </summary>
    public static string AdminHint(string? failureCode)
        => failureCode switch
        {
            RouteConfigIncompatible => "核对该 appCaller 的 AllowedModelPoolIds 与本次请求指定的模型池是否一致。",
            AppCallerPoolUnbound => "在 GW 控制台为该 appCaller 绑定模型池，或激活对应的 requestType 默认池。",
            ModelPoolEmpty => "该模型池没有成员，补充成员或改绑到有成员的池。",
            ModelPoolAllUnavailable => "池内成员全部熔断，检查上游可用性与半开恢复窗口。",
            LogicalModelCapabilityMismatch =>
                "逻辑模型声明的能力不覆盖该场景。核对 Capabilities 是否已归一到规范值（image_generation / text2img / img2img / vision_generation）。",
            OfferingUnresolvable => "Offering 指向的上游模型或 Exchange 解析不出来，核对 TargetKind / TargetId / 协议 / 凭据。",
            PlatformDisabled => "命中的平台处于关闭状态，启用平台或改绑其它上游。",
            ProviderUnavailable => "上游 Provider 故障，查看该 Offering 的失败率与上游状态页。",
            ProviderQuotaExceeded => "上游配额或速率限制耗尽，调整配额或降低并发。",
            GatewayConfigUnavailable => "网关配置面不可读，先恢复配置数据库连通性，再复查路由。",
            ModelNotInCatalog =>
                "选中的模型不在内置名录里，也没有被管理员显式放行——正常从控制台导入的模型不会出现这种状态，"
                + "先确认它是怎么进库的（直接写库？旧数据？），再决定是从池里移除，还是到 Provider 页重新导入并显式放行。",
            _ => "未分类的路由失败，请补充错误码分类后再处理。",
        };

    /// <summary>该失败是否属于「重试不会自行恢复」的配置类问题。</summary>
    public static bool IsConfigurationFault(string? failureCode)
        => failureCode is RouteConfigIncompatible
            or AppCallerPoolUnbound
            or ModelPoolEmpty
            or LogicalModelCapabilityMismatch
            or OfferingUnresolvable
            or PlatformDisabled
            or ModelNotInCatalog;
}
