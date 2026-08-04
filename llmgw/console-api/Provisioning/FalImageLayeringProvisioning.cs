using MongoDB.Bson;

namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// fal.ai 图片分层能力的一键接入蓝图。
/// LLMGW 持有上游密钥、Exchange、专用模型池和 appCaller 绑定；MAP 业务侧只消费统一模型能力。
/// </summary>
public static class FalImageLayeringProvisioning
{
    public const string CapabilityId = "image-layering";
    public const string ExchangeName = "fal.ai Qwen Image Layered";
    public const string ExchangeNameNormalized = "fal.ai qwen image layered";
    public const string ModelId = "fal-qwen-image-layered";
    public const string TargetUrl = "https://fal.run/fal-ai/qwen-image-layered";
    public const string TransformerType = "fal-image-layered";
    public const string PoolName = "视觉创作图片分层";
    public const string PoolCode = "visual-agent-image-layering";
    public const string AppCallerCode = "visual-agent.image.layering::generation";
    public const string RequestType = "generation";

    public static NormalizedExchangeDraft CreateExchangeDraft(string apiKey) => new(
        ExchangeName,
        ExchangeNameNormalized,
        [
            new NormalizedExchangeModelDraft(
                ModelId,
                "Qwen Image Layered",
                RequestType,
                "将输入图片拆解为多个可独立编辑的 RGBA 图层",
                true),
        ],
        TargetUrl,
        apiKey,
        "Key",
        TransformerType,
        true,
        "fal.ai 原生图片语义分层能力，由 LLMGW 统一适配并提供给 MAP 视觉创作",
        null);

    public static BsonDocument BuildPoolDocument(
        string tenantId,
        string poolId,
        string exchangeId,
        DateTime now) => new()
    {
        ["_id"] = poolId,
        ["TenantId"] = tenantId,
        ["Name"] = PoolName,
        ["Code"] = PoolCode,
        ["Priority"] = 10,
        ["ModelType"] = RequestType,
        ["IsDefaultForType"] = false,
        ["StrategyType"] = 0,
        ["Models"] = new BsonArray([BuildPoolMember(exchangeId)]),
        ["AllowedAppCallerCodes"] = new BsonArray { AppCallerCode },
        ["Description"] = "仅供视觉创作图片分层使用，不进入普通文生图或图生图模型选择",
        ["SourceCollection"] = "llmgw_model_pools",
        ["Authority"] = "llm_gateway",
        ["ClaimedAt"] = now,
        ["CreatedAt"] = now,
        ["UpdatedAt"] = now,
        ["Version"] = 1L,
    };

    public static BsonDocument BuildPoolMember(string exchangeId) => new()
    {
        ["ModelId"] = ModelId,
        ["PlatformId"] = exchangeId,
        ["Priority"] = 1,
        ["HealthStatus"] = 0,
        ["ConsecutiveFailures"] = 0,
        ["ConsecutiveSuccesses"] = 0,
        ["IsMain"] = false,
        ["IsIntent"] = false,
        ["IsVision"] = false,
        ["IsImageGen"] = true,
        ["Capabilities"] = new BsonArray
        {
            new BsonDocument { ["Type"] = "image_generation", ["Source"] = "system", ["Value"] = true },
            new BsonDocument { ["Type"] = "image_layering", ["Source"] = "system", ["Value"] = true },
        },
    };

    public static BsonDocument BuildAppCallerDocument(
        string tenantId,
        string? teamId,
        string appCallerId,
        string poolId,
        DateTime now)
    {
        var document = new BsonDocument
        {
            ["_id"] = appCallerId,
            ["TenantId"] = tenantId,
            ["AppCallerCode"] = AppCallerCode,
            ["RequestType"] = RequestType,
            ["SourceSystem"] = "map",
            ["IngressProtocol"] = "gw-native",
            ["ObservedIngressProtocols"] = new BsonArray(),
            ["Title"] = "视觉创作图片分层",
            ["Status"] = "configured",
            ["ModelPoolId"] = poolId,
            ["ModelPolicy"] = "auto",
            ["ParameterPolicy"] = "default-drop",
            ["ObservedModelPoolIds"] = new BsonArray(),
            ["ObservedModelPolicies"] = new BsonArray(),
            ["ObservedParameterPolicies"] = new BsonArray(),
            ["TotalSeen"] = 0L,
            ["FirstSeenAt"] = now,
            ["LastSeenAt"] = now,
            ["CreatedAt"] = now,
            ["UpdatedAt"] = now,
        };
        if (!string.IsNullOrWhiteSpace(teamId)) document["TeamId"] = teamId;
        return document;
    }
}
