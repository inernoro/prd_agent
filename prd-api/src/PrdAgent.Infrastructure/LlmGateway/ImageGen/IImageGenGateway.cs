namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>
/// 图片生成 Gateway 对外接口。
/// 调用方只需提供 appCallerCode + expectedModel + payload，
/// Gateway 内部处理模型调度、请求构建、HTTP 发送、响应解析。
/// 遵循 compute-then-send 原则：resolve 只做一次，send 阶段不再 re-resolve。
/// </summary>
public interface IImageGenGateway
{
    Task<ImageGenGatewayResult> GenerateImageAsync(
        string appCallerCode,
        string? expectedModel,
        ImageGenPayload payload,
        CancellationToken ct = default);
}
