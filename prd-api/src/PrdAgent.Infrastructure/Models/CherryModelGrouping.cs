using System;
using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Models;

/// <summary>
/// Cherry Studio 兼容：模型默认分组规则（用于“管理弹窗”一致性）
/// - getDefaultGroupName：完全按 Cherry 源码行为实现
/// - dashscope 的 qwen 细分：按 groupQwenModels 的前缀正则实现
/// </summary>
public static partial class CherryModelGrouping
{
    // Cherry: ['aihubmix','silicon','ocoolai','o3','dmxapi']
    private static readonly string[] StrongSeparatorProviders = ["aihubmix", "silicon", "ocoolai", "o3", "dmxapi"];

    /// <summary>
    /// Cherry getDefaultGroupName(id, provider)
    /// </summary>
    public static string GetDefaultGroupName(string id, string? provider)
    {
        var str = (id ?? string.Empty).ToLowerInvariant();

        // 定义分隔符
        string[] firstDelimiters = ["/", " ", ":"];
        string[] secondDelimiters = ["-", "_"];

        var p = (provider ?? string.Empty).Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(p) && Array.Exists(StrongSeparatorProviders, x => x == p))
        {
            firstDelimiters = ["/", " ", "-", "_", ":"];
            secondDelimiters = Array.Empty<string>();
        }

        // 第一类分隔规则
        foreach (var delimiter in firstDelimiters)
        {
            if (str.Contains(delimiter, StringComparison.Ordinal))
            {
                var parts = str.Split(delimiter);
                return parts.Length > 0 ? parts[0] : str;
            }
        }

        // 第二类分隔规则
        foreach (var delimiter in secondDelimiters)
        {
            if (str.Contains(delimiter, StringComparison.Ordinal))
            {
                var parts = str.Split(delimiter);
                return parts.Length > 1 ? parts[0] + "-" + parts[1] : parts[0];
            }
        }

        return str;
    }

    /// <summary>
    /// Cherry groupQwenModels：仅在 dashscope provider 下对以 qwen 开头的模型做细分分组
    /// </summary>
    public static string GetDashscopeQwenGroupKey(string modelIdLowerBase)
    {
        var s = (modelIdLowerBase ?? string.Empty).ToLowerInvariant();
        var m = QwenPrefixRegex().Match(s);
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    public static string GetLowerBaseModelName(string modelId)
    {
        // Cherry 的 getLowerBaseModelName 语义：拿到“基础模型名”（通常去掉前缀命名空间）
        // 这里做一个稳健近似：
        // - 取最后一个 '/' 之后
        // - 再取最后一个 ':' 之后
        var s = (modelId ?? string.Empty).Trim().ToLowerInvariant();
        var slash = s.LastIndexOf('/');
        if (slash >= 0 && slash < s.Length - 1) s = s[(slash + 1)..];
        var colon = s.LastIndexOf(':');
        if (colon >= 0 && colon < s.Length - 1) s = s[(colon + 1)..];
        return s;
    }

    [GeneratedRegex("^(qwen(?:\\d+\\.\\d+|2(?:\\.\\d+)?|-\\d+b|-(?:max|coder|vl)))", RegexOptions.IgnoreCase | RegexOptions.Compiled)]
    private static partial Regex QwenPrefixRegex();
}


