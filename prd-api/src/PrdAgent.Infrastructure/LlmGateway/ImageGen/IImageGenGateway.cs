namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>
/// 图片生成统一入口（对外唯一）。
/// 调用方（ImageGenController / 视觉创作 / 各 Agent）只经本接口，
/// 不直接触碰 OpenAIImageClient、平台适配器或 ImageGenModelConfigs。
///
/// Gateway 内部职责：模型调度（resolve）→ 请求构建（ImageGenRequestBuilder 收口"模型配置 → 上游请求体"）
/// → HTTP 发送 → 响应解析。
/// 遵循 compute-then-send 原则：resolve 只做一次，send 阶段不再 re-resolve。
///
/// 加一个新生图模型 = 只在 ImageGenModelConfigs 加一条配置（含尺寸/参数格式/重命名/平台类型）；
/// 仅当上游协议形状全新时才需再加一个 IImageGenPlatformAdapter 实现。详见 ImageGenRequestBuilder。
/// </summary>
public interface IImageGenGateway
{
    Task<ImageGenGatewayResult> GenerateImageAsync(
        string appCallerCode,
        string? expectedModel,
        ImageGenPayload payload,
        CancellationToken ct = default);
}
