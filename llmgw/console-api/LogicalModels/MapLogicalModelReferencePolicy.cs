using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// LLM Gateway 删除逻辑模型前，对 MAP 侧“仍会参与未来执行”的公开模型引用做统一审计。
///
/// 网关拥有模型目录，MAP 拥有业务开放策略和任务；两边没有数据库外键。若删除只检查网关自身，
/// MAP 会继续保存一个已经不存在的 PublicId，最终出现“仍是默认，但不可用”或在途任务执行失败。
/// 新增一种 MAP 配置引用时，应把过滤器集中补在这里，并在镜像测试里对照实体字段与状态枚举。
///
/// 历史日志、用户最近选择等非权威引用不阻断删除：它们不会发起未来调用。业务策略、模型绑定密钥
/// 和未终结任务会阻断，因为它们仍可能把这个 PublicId 送进网关。
/// </summary>
public static class MapLogicalModelReferencePolicy
{
    // 这些是可复用的未来执行配置，不包括 battle/run/log 等历史快照。
    public const string ArenaSlotsCollectionName = "arena_slots";
    public const string ModelLabExperimentsCollectionName = "model_lab_experiments";
    public const string ModelLabModelSetsCollectionName = "model_lab_model_sets";
    public const string ModelLabGroupsCollectionName = "model_lab_groups";
    public const string BusinessLogicalModelField = "LogicalModelId";

    public sealed record BusinessReferenceQuery(
        string CollectionName, string Usage, FilterDefinition<BsonDocument> Filter);

    /// <summary>业务配置中的 LogicalModelId 是 GW 内部 ID，不是 PublicId。</summary>
    public static IReadOnlyList<BusinessReferenceQuery> BuildBusinessLogicalModelQueries(string logicalModelId)
        => BusinessQueries(Builders<BsonDocument>.Filter.Eq(BusinessLogicalModelField, logicalModelId));

    /// <summary>
    /// 只保护尚未迁移的物理绑定。已明确绑定逻辑模型后，保留的旧 pair 只是迁移来源，不能继续阻断退役。
    /// null 同时匹配缺失字段；数组必须 ElemMatch，避免将不同成员的字段拼成一条引用。
    /// </summary>
    public static IReadOnlyList<BusinessReferenceQuery> BuildLegacyPlatformQueries(string platformId)
    {
        var fb = Builders<BsonDocument>.Filter;
        return BusinessQueries(fb.And(
            fb.In(BusinessLogicalModelField, new BsonValue[] { BsonNull.Value, "" }),
            fb.Eq("PlatformId", platformId),
            fb.Type("ModelId", BsonType.String),
            fb.Ne("ModelId", "")));
    }

    private static IReadOnlyList<BusinessReferenceQuery> BusinessQueries(FilterDefinition<BsonDocument> memberFilter)
    {
        var fb = Builders<BsonDocument>.Filter;
        return new BusinessReferenceQuery[]
        {
            new(ArenaSlotsCollectionName, "模型竞技场槽位", memberFilter),
            new(ModelLabExperimentsCollectionName, "模型实验台实验", fb.ElemMatch<BsonDocument>("SelectedModels", memberFilter)),
            new(ModelLabModelSetsCollectionName, "模型实验台模型集合", fb.ElemMatch<BsonDocument>("Models", memberFilter)),
            new(ModelLabGroupsCollectionName, "模型实验台分组", fb.ElemMatch<BsonDocument>("Models", memberFilter)),
        };
    }

    public const string AppSettingsCollectionName = "appsettings";
    public const string VisualPolicyDefaultField = "VisualModelPolicy.DefaultModelId";
    public const string VisualPolicyModelsField = "VisualModelPolicy.Models.ModelId";

    public const string AgentApiKeysCollectionName = "agent_api_keys";
    public const string AgentKeyModelModeField = "McpLiteraryImageModelMode";
    public const string AgentKeyFixedModelField = "McpLiteraryImageModelPublicId";
    public const string AgentKeyOpenApiChatModelsField = "OpenApiChatModels";
    public const string AgentKeyOpenApiImageModelsField = "OpenApiImageModels";
    public const int AgentKeyFixedModelMode = 1;

    public const string ImageRunsCollectionName = "image_gen_runs";
    public const string ImageRunStatusField = "Status";
    public const string ImageRunLogicalModelField = "LogicalModelPublicId";
    public const string ImageRunPlatformField = "PlatformId";
    public const string ImageRunModelField = "ModelId";
    public const string LogicalModelPlatformId = "logical-model";

    /// <summary>ImageGenRunStatus 的终态枚举值：Completed、Failed、Cancelled。</summary>
    public static readonly int[] TerminalImageRunStatuses = [2, 3, 4];

    public static FilterDefinition<BsonDocument> BuildVisualPolicyFilter(string publicId)
    {
        var fb = Builders<BsonDocument>.Filter;
        return fb.Or(
            fb.Eq(VisualPolicyDefaultField, publicId),
            fb.Eq(VisualPolicyModelsField, publicId));
    }

    public static FilterDefinition<BsonDocument> BuildAgentApiKeyReferenceFilter(string publicId)
    {
        var fb = Builders<BsonDocument>.Filter;
        return fb.Or(
            fb.And(
                fb.Eq(AgentKeyModelModeField, AgentKeyFixedModelMode),
                fb.Eq(AgentKeyFixedModelField, publicId)),
            fb.Eq(AgentKeyOpenApiChatModelsField, publicId),
            fb.Eq(AgentKeyOpenApiImageModelsField, publicId));
    }

    public static FilterDefinition<BsonDocument> BuildInFlightImageRunFilter(string publicId)
    {
        var fb = Builders<BsonDocument>.Filter;
        return fb.And(
            fb.Nin(ImageRunStatusField, TerminalImageRunStatuses),
            fb.Or(
                fb.Eq(ImageRunLogicalModelField, publicId),
                fb.And(
                    fb.Eq(ImageRunPlatformField, LogicalModelPlatformId),
                    fb.Eq(ImageRunModelField, publicId))));
    }
}
