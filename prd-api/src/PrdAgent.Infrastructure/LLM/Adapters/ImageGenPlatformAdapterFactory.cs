namespace PrdAgent.Infrastructure.LLM.Adapters;

/// <summary>
/// 图片生成平台适配器工厂
/// 根据 API URL 和模型名称选择合适的适配器
/// </summary>
public static class ImageGenPlatformAdapterFactory
{
    private static readonly OpenAIPlatformAdapter OpenAIAdapter = new();
    private static readonly VolcesPlatformAdapter VolcesAdapter = new();

    /// <summary>
    /// 获取适配器
    /// </summary>
    /// <param name="apiUrl">API 基础 URL</param>
    /// <param name="modelName">模型名称（可选，用于未来基于模型配置选择适配器）</param>
    /// <param name="platformType">显式指定的平台类型（可选，优先级最高）</param>
    /// <returns>适配器实例</returns>
    public static IImageGenPlatformAdapter GetAdapter(
        string? apiUrl,
        string? modelName = null,
        string? platformType = null)
    {
        // 1. 优先使用显式指定的平台类型
        if (!string.IsNullOrWhiteSpace(platformType))
        {
            return GetAdapterByType(platformType);
        }

        // 2. 尝试从模型适配器配置获取平台类型
        if (!string.IsNullOrWhiteSpace(modelName))
        {
            var modelConfig = ImageGenModelAdapterRegistry.TryMatch(modelName);
            if (modelConfig?.PlatformType != null)
            {
                return GetAdapterByType(modelConfig.PlatformType);
            }
        }

        // 3. Fallback：通过 URL host 自动检测
        if (IsVolcesApi(apiUrl))
        {
            return VolcesAdapter;
        }

        // 默认使用 OpenAI 兼容适配器
        return OpenAIAdapter;
    }

    /// <summary>
    /// 根据平台类型获取适配器
    /// </summary>
    public static IImageGenPlatformAdapter GetAdapterByType(string platformType)
    {
        return platformType.ToLowerInvariant() switch
        {
            "volces" => VolcesAdapter,
            "openai" => OpenAIAdapter,
            _ => OpenAIAdapter
        };
    }

    /// <summary>
    /// 检测是否是 Volces API
    /// 兼容 ark.*.volces.com 和 *.volces.com
    /// </summary>
    public static bool IsVolcesApi(string? apiUrl)
    {
        var raw = (apiUrl ?? string.Empty).Trim();
        raw = raw.TrimEnd('#');
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var u)) return false;
        if (!u.Host.EndsWith("volces.com", StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }

    /// <summary>
    /// 获取所有已注册的适配器
    /// </summary>
    public static IEnumerable<IImageGenPlatformAdapter> GetAllAdapters()
    {
        yield return OpenAIAdapter;
        yield return VolcesAdapter;
    }
}
