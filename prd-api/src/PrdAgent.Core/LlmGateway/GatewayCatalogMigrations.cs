namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 名录门要的那几条「存量补标记」迁移：由控制台在启动时跑，数据面据此判断自己能不能收紧。
///
/// 为什么数据面要读它：这道门只认放行标记，而标记是控制台的一次性迁移补上去的。
/// 两者跑在不同容器里、彼此没有启动顺序（compose 里都只依赖 Mongo，serving 的就绪探针
/// 也只看自己活没活），所以「控制台还没迁完 / 迁失败了」与「数据面已经开始收紧」完全可能同时成立——
/// 那一刻存量模型会集体收到 MODEL_NOT_IN_CATALOG，一次控制面故障就这样扩大成了数据面故障。
/// `llm-gateway.md` 规则 7 明确禁止这件事：控制台不是请求执行的前置依赖，辅助链路故障不得扩大到数据面。
///
/// 所以判据不是「配置写着 enforce 吗」，而是「补标记这件事真的做完了吗」：
/// 库里这几个 id 都留下完成时间，才算有资格拦；读不到、没读完、读失败，一律退回只记录不拦。
///
/// 这几个 id 与控制台里逐条 RunCatalogGrandfatherAsync / 兑换所盖戳所用的字符串是同一批，
/// 两侧隔着仓库目录（console-api 不引用本工程），由 ModelCatalogGuardTests 的镜像守卫钉住。
/// </summary>
public static class GatewayCatalogMigrations
{
    /// <summary>控制台记录一次性迁移的集合名。</summary>
    public const string CollectionName = "llmgw_migrations";

    /// <summary>完成时间字段：只有它存在才算跑完（只有 ClaimedAt 说明认领了但没写完）。</summary>
    public const string CompletedAtField = "CompletedAt";

    /// <summary>名录门上线前入库的模型补标记。</summary>
    public const string GrandfatherV1 = "model-catalog-grandfather-v1";

    /// <summary>厂商段口径收紧后重跑一次：旧口径下曾被剥前缀认成名录内的，现在要按新口径补标记。</summary>
    public const string GrandfatherV2StrictVendorPrefix = "model-catalog-grandfather-v2-strict-vendor-prefix";

    /// <summary>兑换所里逐条别名补标记（新形态兑换所的 Models 元素）。</summary>
    public const string ExchangeModelAllowanceV1 = "exchange-model-allowance-v1";

    /// <summary>标点口径收紧后再跑一次：旧口径把 `.` `_` 合并成 `-`，靠标点合成的别名现在要按新口径补标记。</summary>
    public const string GrandfatherV3StrictPunctuation = "model-catalog-grandfather-v3-strict-punctuation";

    /// <summary>全部跑完，数据面才有资格从「只记录」升到「真拦」。</summary>
    public static readonly string[] RequiredIds =
    {
        GrandfatherV1,
        GrandfatherV2StrictVendorPrefix,
        ExchangeModelAllowanceV1,
        GrandfatherV3StrictPunctuation,
    };
}
