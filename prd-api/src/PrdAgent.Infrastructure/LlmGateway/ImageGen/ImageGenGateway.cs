using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>
/// IImageGenGateway 的适配器实现。
/// Phase 2 过渡实现：对外暴露统一接口，内部委托 OpenAIImageClient.GenerateUnifiedAsync。
/// Phase 3 将在此层直接实现 resolve + send 两阶段，彻底脱离对 OpenAIImageClient 的依赖。
/// </summary>
public sealed class ImageGenGateway : IImageGenGateway
{
    private readonly OpenAIImageClient _imageClient;

    public ImageGenGateway(OpenAIImageClient imageClient)
    {
        _imageClient = imageClient;
    }

    public async Task<ImageGenGatewayResult> GenerateImageAsync(
        string appCallerCode,
        string? expectedModel,
        ImageGenPayload payload,
        CancellationToken ct = default)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var images = payload.Images?.Count > 0 ? payload.Images.ToList() : null;

            var result = await _imageClient.GenerateUnifiedAsync(
                prompt: payload.Prompt,
                n: payload.N,
                size: payload.Size,
                responseFormat: payload.ResponseFormat,
                ct: ct,
                appCallerCode: appCallerCode,
                images: images,
                modelId: null,
                platformId: null,
                modelName: expectedModel,
                maskBase64: payload.MaskBase64);

            sw.Stop();

            if (!result.Success)
            {
                return ImageGenGatewayResult.Fail(
                    result.Error?.Code ?? "IMAGE_GEN_FAILED",
                    result.Error?.Message ?? "图片生成失败");
            }

            var data = result.Data;
            if (data == null)
                return ImageGenGatewayResult.Fail("NO_DATA", "图片生成返回空数据");

            var outputItems = (data.Images ?? []).Select(img => new ImageGenOutputItem
            {
                Url = img.Url,
                Base64 = img.Base64,
                MimeType = "image/png",
                RevisedPrompt = img.RevisedPrompt
            }).ToList();

            return new ImageGenGatewayResult
            {
                Success = true,
                StatusCode = 200,
                Images = outputItems,
                DurationMs = sw.ElapsedMilliseconds
            };
        }
        catch (Exception ex)
        {
            sw.Stop();
            return ImageGenGatewayResult.Fail("IMAGE_GEN_EXCEPTION", ex.Message);
        }
    }
}
