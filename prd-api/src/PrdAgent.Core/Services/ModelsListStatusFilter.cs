namespace PrdAgent.Core.Services;

public static class ModelsListStatusFilter
{
    /// <summary>
    /// 针对部分厂商的 /models 响应，过滤掉“不可用/已关闭”的模型条目，避免噪音进入前台。
    /// </summary>
    public static bool ShouldInclude(string providerId, string endpoint, string modelId, string? status)
    {
        if (string.IsNullOrWhiteSpace(modelId)) return false;
        if (string.IsNullOrWhiteSpace(status)) return true;

        // Volces Ark: status = "Shutdown" 表示模型不可用，直接过滤
        if (IsVolcesArkModelsEndpoint(providerId, endpoint))
        {
            if (string.Equals(status.Trim(), "Shutdown", StringComparison.OrdinalIgnoreCase)) return false;
        }

        return true;
    }

    private static bool IsVolcesArkModelsEndpoint(string providerId, string endpoint)
    {
        // 优先按 endpoint host 判断（更可靠）
        if (Uri.TryCreate(endpoint, UriKind.Absolute, out var uri))
        {
            if (uri.Host.EndsWith("volces.com", StringComparison.OrdinalIgnoreCase))
            {
                // Ark 典型路径：/api/v3/models
                if (uri.AbsolutePath.EndsWith("/api/v3/models", StringComparison.OrdinalIgnoreCase)) return true;
            }
        }

        // 兜底：按字符串包含（兼容非标准 URL 或用户配置）
        if (!string.IsNullOrWhiteSpace(endpoint)
            && endpoint.Contains("volces.com", StringComparison.OrdinalIgnoreCase)
            && endpoint.Contains("/api/v3/models", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // 次级兜底：用户可能显式填 providerId
        if (string.Equals(providerId, "volces", StringComparison.OrdinalIgnoreCase)
            || string.Equals(providerId, "ark", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }
}


