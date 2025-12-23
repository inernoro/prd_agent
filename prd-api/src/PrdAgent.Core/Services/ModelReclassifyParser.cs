using System.Text.Json;

namespace PrdAgent.Core.Services;

public sealed class ModelReclassifyParseException : Exception
{
    public ModelReclassifyParseException(string message) : base(message) { }
    public ModelReclassifyParseException(string message, Exception innerException) : base(message, innerException) { }
}

public sealed record ModelReclassifyResult(
    string ModelName,
    string Group,
    List<string> Tags,
    double? Confidence);

public static class ModelReclassifyParser
{
    private static readonly HashSet<string> AllowedTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "vision", "embedding", "rerank", "function_calling", "web_search", "reasoning", "free"
    };

    public static List<ModelReclassifyResult> ParseOrThrow(string raw, IReadOnlyCollection<string> expectedModelNames)
    {
        if (expectedModelNames == null || expectedModelNames.Count == 0)
        {
            throw new ArgumentException("expectedModelNames 不能为空", nameof(expectedModelNames));
        }

        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s))
        {
            throw new ModelReclassifyParseException("输出为空（期望 JSON 数组）");
        }

        s = StripCodeFence(s);
        s = ExtractJsonArray(s);

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(s);
        }
        catch (Exception ex)
        {
            throw new ModelReclassifyParseException("不是有效 JSON（无法解析）", ex);
        }

        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new ModelReclassifyParseException("不是有效 JSON 数组（根节点必须为 array）");
            }

            var expected = expectedModelNames
                .Select(NormalizeModelName)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToHashSet(StringComparer.Ordinal);

            if (expected.Count == 0)
            {
                throw new ModelReclassifyParseException("expectedModelNames 无有效值");
            }

            var results = new List<ModelReclassifyResult>();
            var seen = new HashSet<string>(StringComparer.Ordinal);

            foreach (var el in doc.RootElement.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Object)
                {
                    throw new ModelReclassifyParseException("数组元素必须为 object");
                }

                if (!TryGetString(el, "modelName", out var modelNameRaw))
                {
                    throw new ModelReclassifyParseException("缺少字段 modelName（string）");
                }
                var modelName = modelNameRaw.Trim();
                var key = NormalizeModelName(modelName);
                if (string.IsNullOrWhiteSpace(key))
                {
                    throw new ModelReclassifyParseException("modelName 不能为空");
                }
                if (!expected.Contains(key))
                {
                    throw new ModelReclassifyParseException($"出现未在输入中声明的 modelName：{modelName}");
                }
                if (!seen.Add(key))
                {
                    throw new ModelReclassifyParseException($"modelName 重复：{modelName}");
                }

                if (!TryGetString(el, "group", out var groupRaw))
                {
                    throw new ModelReclassifyParseException($"modelName={modelName} 缺少字段 group（string）");
                }
                var group = groupRaw.Trim();
                if (string.IsNullOrWhiteSpace(group))
                {
                    throw new ModelReclassifyParseException($"modelName={modelName} 的 group 不能为空");
                }

                if (!el.TryGetProperty("tags", out var tagsEl) || tagsEl.ValueKind != JsonValueKind.Array)
                {
                    throw new ModelReclassifyParseException($"modelName={modelName} 缺少字段 tags（string[]）");
                }

                var tags = new List<string>();
                foreach (var t in tagsEl.EnumerateArray())
                {
                    if (t.ValueKind != JsonValueKind.String)
                    {
                        throw new ModelReclassifyParseException($"modelName={modelName} 的 tags 必须为 string[]");
                    }
                    var tag = (t.GetString() ?? string.Empty).Trim().ToLowerInvariant();
                    if (string.IsNullOrWhiteSpace(tag)) continue;
                    if (!AllowedTags.Contains(tag))
                    {
                        throw new ModelReclassifyParseException($"modelName={modelName} 的 tags 包含不支持的值：{tag}");
                    }
                    tags.Add(tag);
                }

                double? confidence = null;
                if (el.TryGetProperty("confidence", out var confEl))
                {
                    if (confEl.ValueKind == JsonValueKind.Number)
                    {
                        if (confEl.TryGetDouble(out var v)) confidence = v;
                    }
                    else if (confEl.ValueKind != JsonValueKind.Null && confEl.ValueKind != JsonValueKind.Undefined)
                    {
                        throw new ModelReclassifyParseException($"modelName={modelName} 的 confidence 必须为 number 或 null");
                    }
                }

                results.Add(new ModelReclassifyResult(modelName, group, tags, confidence));
            }

            // 要求覆盖本 chunk 的所有模型（避免“解析一半导致部分写回”）
            if (seen.Count != expected.Count)
            {
                var missing = expected.Except(seen).Take(5).ToList();
                var sample = missing.Count == 0 ? "" : $"，例如：{string.Join(", ", missing)}";
                throw new ModelReclassifyParseException($"分类结果缺少 {expected.Count - seen.Count} 个模型{sample}");
            }

            return results;
        }
    }

    private static bool TryGetString(JsonElement obj, string prop, out string value)
    {
        value = string.Empty;
        if (!obj.TryGetProperty(prop, out var el) || el.ValueKind != JsonValueKind.String) return false;
        value = el.GetString() ?? string.Empty;
        return true;
    }

    private static string NormalizeModelName(string s) => (s ?? string.Empty).Trim().ToLowerInvariant();

    private static string StripCodeFence(string s)
    {
        // 去掉 ```json ... ``` 或 ``` ... ``` 包裹
        if (!s.StartsWith("```", StringComparison.Ordinal)) return s;
        var firstNl = s.IndexOf('\n');
        if (firstNl >= 0) s = s[(firstNl + 1)..];
        var lastFence = s.LastIndexOf("```", StringComparison.Ordinal);
        if (lastFence >= 0) s = s[..lastFence];
        return s.Trim();
    }

    private static string ExtractJsonArray(string s)
    {
        // 尝试截取第一个 [ 到最后一个 ] 之间内容（兼容 LLM 输出前后夹杂说明文本）
        var start = s.IndexOf('[');
        var end = s.LastIndexOf(']');
        if (start >= 0 && end > start) return s[start..(end + 1)];
        return s;
    }
}


