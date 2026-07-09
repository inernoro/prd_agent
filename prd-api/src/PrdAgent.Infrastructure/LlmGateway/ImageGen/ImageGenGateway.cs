namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>
/// IImageGenGateway 的实现：生图统一入口的事实落点。
/// 对外暴露统一接口，内部委托 OpenAIImageClient.GenerateUnifiedAsync 完成
/// "解析模型调度 → 经 ImageGenRequestBuilder 构建上游请求体 → 发送 → 解析响应"。
///
/// 边界：参数构建（模型配置 → 上游请求体的尺寸/格式/重命名转换）统一走
/// ImageGenRequestBuilder + ImageGenModelAdapterRegistry；OpenAIImageClient 已退化为
/// "纯发送器 + 响应解析"，不再在自身内联拼装标准文生图请求体。
/// </summary>
public sealed class ImageGenGateway : IImageGenGateway
{
    private readonly IImageGenerationClient _imageClient;

    public ImageGenGateway(IImageGenerationClient imageClient)
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
