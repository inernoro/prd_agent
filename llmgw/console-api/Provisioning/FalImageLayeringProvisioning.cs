using MongoDB.Bson;

namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// fal.ai 图片分层能力的一键安装蓝图。
/// LLMGW 只发布通用逻辑能力，不创建或绑定任何业务系统的 appCaller。
/// </summary>
public static class FalImageLayeringProvisioning
{
    public const string CapabilityId = "image-layering";
    public const string ExchangeName = "fal.ai Qwen Image Layered";
    public const string ExchangeNameNormalized = "fal.ai qwen image layered";
    public const string ModelId = "fal-qwen-image-layered";
    public const string TargetUrl = "https://fal.run/fal-ai/qwen-image-layered";
    public const string TransformerType = "fal-image-layered";
    public const string RequestType = "generation";
    public const string LogicalModelName = "图片分层";

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
        "fal.ai 原生图片语义分层上游，由 LLMGW 统一适配",
        null);

    public static BsonDocument BuildLogicalModelDocument(
        string tenantId,
        string logicalModelId,
        DateTime now) => new()
    {
        ["_id"] = logicalModelId,
        ["TenantId"] = tenantId,
        ["PublicId"] = CapabilityId,
        ["PublicIdNormalized"] = CapabilityId,
        ["Name"] = LogicalModelName,
        ["ModelType"] = RequestType,
        ["Capabilities"] = new BsonArray { "image_generation", "image_layering" },
        ["AllowedAppCallerCodes"] = new BsonArray(),
        ["RoutingStrategy"] = "priority",
        ["Enabled"] = true,
        ["DisplayOrder"] = 20,
        ["Description"] = "通用图片分层能力。调用方只依赖公开标识 image-layering，不感知 fal.ai、Endpoint 或凭据。",
        ["CreatedAt"] = now,
        ["UpdatedAt"] = now,
    };

    public static BsonDocument BuildOfferingDocument(
        string tenantId,
        string offeringId,
        string logicalModelId,
        string exchangeId,
        DateTime now) => new()
    {
        ["_id"] = offeringId,
        ["TenantId"] = tenantId,
        ["LogicalModelId"] = logicalModelId,
        ["TargetKind"] = "exchange",
        ["TargetId"] = exchangeId,
        ["UpstreamModelId"] = ModelId,
        ["Protocol"] = TransformerType,
        ["Priority"] = 10,
        ["Weight"] = 100,
        ["Enabled"] = true,
        ["HealthStatus"] = 0,
        ["ConsecutiveFailures"] = 0,
        ["ConsecutiveSuccesses"] = 0,
        ["Notes"] = "fal.ai Qwen Image Layered 原生供给",
        ["CreatedAt"] = now,
        ["UpdatedAt"] = now,
    };
}
