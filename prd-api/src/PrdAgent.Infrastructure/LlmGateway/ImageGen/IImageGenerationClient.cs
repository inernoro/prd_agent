using PrdAgent.Core.Models;
using PrdAgent.Core.Models.MultiImage;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>
/// 生图请求的业务侧客户端边界。
/// API/Worker 层只依赖该接口，具体上游协议由网关侧实现承载。
/// </summary>
public interface IImageGenerationClient
{
    Task<ApiResponse<ImageGenResult>> GenerateUnifiedAsync(
        string prompt,
        int n,
        string? size,
        string? responseFormat,
        CancellationToken ct,
        string appCallerCode,
        List<string>? images = null,
        string? modelId = null,
        string? platformId = null,
        string? modelName = null,
        string? maskBase64 = null);

    Task<ApiResponse<ImageGenResult>> GenerateAsync(
        string prompt,
        int n,
        string? size,
        string? responseFormat,
        CancellationToken ct,
        string appCallerCode,
        string? modelId = null,
        string? platformId = null,
        string? modelName = null,
        string? initImageBase64 = null,
        bool initImageProvided = false,
        string? maskBase64 = null);

    Task<ApiResponse<ImageGenResult>> GenerateWithVisionAsync(
        string prompt,
        List<ImageRefData> imageRefs,
        string? size,
        CancellationToken ct,
        string appCallerCode,
        string? modelId = null,
        string? platformId = null,
        string? modelName = null);
}
