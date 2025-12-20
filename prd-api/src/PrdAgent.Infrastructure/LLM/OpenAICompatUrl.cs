using System;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// OpenAI 兼容接口 baseURL 拼接规则（与前端配置一致）
/// 规则：
/// 1) 以 "/" 结尾：忽略 v1，直接拼接能力路径（如 chat/completions、models）
/// 2) 以 "#" 结尾：强制使用原地址（trim 掉 #，不做任何拼接）
/// 3) 其他：默认拼接 "/v1/{capabilityPath}"
/// </summary>
public static class OpenAICompatUrl
{
    public static string BuildEndpoint(string baseUrl, string capabilityPath)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) return string.Empty;
        if (string.IsNullOrWhiteSpace(capabilityPath)) return string.Empty;

        var raw = baseUrl.Trim();
        var cap = capabilityPath.Trim();
        cap = cap.TrimStart('/');

        // 规则二：以 # 结尾 —— 强制使用原地址（不做任何拼接）
        if (raw.EndsWith("#", StringComparison.Ordinal))
        {
            return raw.TrimEnd('#');
        }

        // 规则一：以 / 结尾 —— 忽略 v1，自动拼接能力路径
        if (raw.EndsWith("/", StringComparison.Ordinal))
        {
            var b = raw.TrimEnd('/') + "/";
            return b + cap;
        }

        // 规则三：其他情况 —— 默认拼接 /v1/{capabilityPath}
        var u = raw.TrimEnd('/');
        return u + "/v1/" + cap;
    }

    /// <summary>
    /// 解析 endpoint（可能是绝对 URL）对应的 ApiBase 与 Path（用于日志）
    /// </summary>
    public static (string? apiBase, string path) SplitApiBaseAndPath(string endpointOrPath, Uri? baseAddress)
    {
        var t = (endpointOrPath ?? string.Empty).Trim();
        if (Uri.TryCreate(t, UriKind.Absolute, out var abs))
        {
            var host = abs.IsDefaultPort ? abs.Host : $"{abs.Host}:{abs.Port}";
            var apiBase = $"{abs.Scheme}://{host}/";
            var path = abs.AbsolutePath.TrimStart('/');
            return (apiBase, path);
        }

        // 相对路径：尽量使用 BaseAddress 做 apiBase
        var apiBase2 = baseAddress?.ToString();
        var path2 = t.TrimStart('/');
        return (apiBase2, path2);
    }
}


