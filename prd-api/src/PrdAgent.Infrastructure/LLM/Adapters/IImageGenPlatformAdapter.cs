using System.Text.Json;

namespace PrdAgent.Infrastructure.LLM.Adapters;

/// <summary>
/// 图片生成平台适配器接口
/// 抽象不同平台（OpenAI、Volces 等）的 API 差异
/// </summary>
public interface IImageGenPlatformAdapter
{
    /// <summary>
    /// 平台类型标识（如 "openai"、"volces"）
    /// </summary>
    string PlatformType { get; }

    /// <summary>
    /// 获取文生图端点路径
    /// </summary>
    string GetGenerationsEndpoint(string baseUrl);

    /// <summary>
    /// 获取图生图端点路径
    /// </summary>
    string GetEditsEndpoint(string baseUrl);

    /// <summary>
    /// 是否支持图生图（images/edits）
    /// </summary>
    bool SupportsImageToImage { get; }

    /// <summary>
    /// 构建文生图请求体
    /// </summary>
    /// <param name="model">模型名称</param>
    /// <param name="prompt">提示词</param>
    /// <param name="n">生成数量</param>
    /// <param name="size">尺寸（如 "1024x1024"）</param>
    /// <param name="responseFormat">响应格式（"url" 或 "b64_json"）</param>
    /// <param name="sizeParams">适配器配置的尺寸参数（可能是 width/height 分开）</param>
    /// <returns>请求体对象（用于 JSON 序列化）</returns>
    object BuildGenerationRequest(
        string model,
        string prompt,
        int n,
        string? size,
        string? responseFormat,
        Dictionary<string, object>? sizeParams = null);

    /// <summary>
    /// 构建图生图请求体
    /// </summary>
    object BuildEditRequest(
        string model,
        string prompt,
        int n,
        string? size,
        string? responseFormat);

    /// <summary>
    /// 序列化请求为 JSON
    /// </summary>
    string SerializeRequest(object request);

    /// <summary>
    /// 归一化尺寸（某些平台有最小尺寸要求）
    /// </summary>
    string? NormalizeSize(string? size);

    /// <summary>
    /// 获取日志记录用的 Provider 名称
    /// </summary>
    string ProviderNameForLog { get; }

    /// <summary>
    /// 是否强制使用 URL 响应格式（某些平台不支持 b64_json）
    /// </summary>
    bool ForceUrlResponseFormat { get; }

    /// <summary>
    /// 解析响应中的单个图片项
    /// </summary>
    ImageGenResponseItem ParseResponseItem(JsonElement item);

    /// <summary>
    /// 处理尺寸错误并返回建议的重试尺寸
    /// 返回 null 表示不需要重试
    /// </summary>
    string? HandleSizeError(string errorMessage, string? currentSize);
}

/// <summary>
/// 图片生成响应项
/// </summary>
public class ImageGenResponseItem
{
    public string? Url { get; set; }
    public string? Base64 { get; set; }
    public string? RevisedPrompt { get; set; }
    public string? ErrorMessage { get; set; }
    public string? ActualSize { get; set; }
}
