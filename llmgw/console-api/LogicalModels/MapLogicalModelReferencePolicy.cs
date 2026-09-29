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
