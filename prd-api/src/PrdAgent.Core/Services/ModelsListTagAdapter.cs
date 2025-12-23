namespace PrdAgent.Core.Services;

public static class ModelsListTagAdapter
{
    /// <summary>
    /// 根据供应商 /models 返回的“自带字段”（domain/task_type/features/modalities 等）推导 tags。
    /// 返回 null 表示“无可确定标签”；unknownReason 非空表示“看起来有标签信息但未能映射”，用于日志提醒管理员更新规则。
    /// </summary>
    public static List<string>? InferTags(
        string providerId,
        string endpoint,
        string modelId,
        string? domain,
        IReadOnlyCollection<string>? taskTypes,
        bool? functionCalling,
        IReadOnlyCollection<string>? inputModalities,
        IReadOnlyCollection<string>? outputModalities,
        out string? unknownReason)
    {
        unknownReason = null;

        var isArk = IsVolcesArkModelsEndpoint(providerId, endpoint);
        if (!isArk)
        {
            // 当前仅为 Ark 做“自带标签”适配，其它供应商保持现状（避免误伤）。
            return null;
        }

        var tags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var d = (domain ?? string.Empty).Trim();
        var tt = taskTypes?.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).ToList() ?? new List<string>();

        // Embedding
        if (string.Equals(d, "Embedding", StringComparison.OrdinalIgnoreCase)
            || tt.Any(x => x.Contains("Embedding", StringComparison.OrdinalIgnoreCase)))
        {
            tags.Add("embedding");
        }

        // TextGeneration / LLM：默认作为“推理”模型（UI 的推理 Tab 兜底入口）
        if (string.Equals(d, "LLM", StringComparison.OrdinalIgnoreCase)
            || tt.Any(x => x.Contains("TextGeneration", StringComparison.OrdinalIgnoreCase)))
        {
            tags.Add("reasoning");
        }

        // Vision / VLM
        if (string.Equals(d, "VLM", StringComparison.OrdinalIgnoreCase)
            || tt.Any(x => x.Contains("Visual", StringComparison.OrdinalIgnoreCase)))
        {
            tags.Add("vision");
            // VLM 仍然属于可对话/推理范畴（只是多了视觉能力）
            tags.Add("reasoning");
        }

        static bool HasImageOrVideo(IReadOnlyCollection<string>? mods) =>
            mods != null && mods.Any(x => string.Equals(x, "image", StringComparison.OrdinalIgnoreCase)
                                          || string.Equals(x, "video", StringComparison.OrdinalIgnoreCase));

        if (HasImageOrVideo(inputModalities) || HasImageOrVideo(outputModalities))
        {
            tags.Add("vision");
            tags.Add("reasoning");
        }

        // Tools / function calling
        if (functionCalling == true) tags.Add("function_calling");

        // Web search（Ark 常见在 id/version 上体现 browsing）
        if (!string.IsNullOrWhiteSpace(modelId) && modelId.Contains("browsing", StringComparison.OrdinalIgnoreCase))
        {
            tags.Add("web_search");
        }

        if (tags.Count > 0) return tags.Select(NormalizeTag).Distinct(StringComparer.Ordinal).ToList();

        // 没推导出 tags：如果模型返回里明显包含“可推导信号”，则提示管理员补映射
        var hasSignals =
            !string.IsNullOrWhiteSpace(d)
            || tt.Count > 0
            || functionCalling.HasValue
            || (inputModalities != null && inputModalities.Count > 0)
            || (outputModalities != null && outputModalities.Count > 0);

        if (hasSignals)
        {
            unknownReason = $"domain={d}, taskTypes=[{string.Join(",", tt)}], functionCalling={functionCalling}";
        }

        return null;
    }

    private static string NormalizeTag(string tag)
    {
        var t = (tag ?? string.Empty).Trim().ToLowerInvariant();
        return t;
    }

    private static bool IsVolcesArkModelsEndpoint(string providerId, string endpoint)
    {
        if (Uri.TryCreate(endpoint, UriKind.Absolute, out var uri))
        {
            if (uri.Host.EndsWith("volces.com", StringComparison.OrdinalIgnoreCase))
            {
                if (uri.AbsolutePath.EndsWith("/api/v3/models", StringComparison.OrdinalIgnoreCase)) return true;
            }
        }

        if (!string.IsNullOrWhiteSpace(endpoint)
            && endpoint.Contains("volces.com", StringComparison.OrdinalIgnoreCase)
            && endpoint.Contains("/api/v3/models", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.Equals(providerId, "volces", StringComparison.OrdinalIgnoreCase)
            || string.Equals(providerId, "ark", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }
}


