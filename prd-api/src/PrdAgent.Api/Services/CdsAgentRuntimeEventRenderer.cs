using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

internal static class CdsAgentRuntimeEventRenderer
{
    public static string Render(InfraAgentEventView evt)
    {
        try
        {
            using var doc = JsonDocument.Parse(evt.PayloadJson);
            var root = doc.RootElement;
            return evt.Type switch
            {
                InfraAgentEventTypes.TextDelta when root.TryGetProperty("text", out var text) =>
                    text.GetString() ?? string.Empty,
                InfraAgentEventTypes.Done when root.TryGetProperty("finalText", out var finalText) =>
                    finalText.GetString() ?? string.Empty,
                InfraAgentEventTypes.Error =>
                    RenderError(root),
                InfraAgentEventTypes.Status =>
                    RenderStatus(root),
                InfraAgentEventTypes.ToolCall =>
                    $"工具调用：{root}",
                InfraAgentEventTypes.ToolResult =>
                    $"工具结果：{root}",
                InfraAgentEventTypes.Hook =>
                    $"Hook：{root}",
                _ => string.Empty
            };
        }
        catch
        {
            return evt.PayloadJson;
        }
    }

    /// <summary>
    /// 渲染运行状态事件，让工作流输出明确显示当前是 official 还是 lite（优雅降级）模式，
    /// 而不是只在 /cds-agent 页面才看得到。仅渲染 running 这类带 mode 的状态，避免噪音。
    /// </summary>
    internal static string RenderStatus(JsonElement root)
    {
        var status = TryString(root, "status");
        var mode = TryString(root, "mode");
        if (string.IsNullOrWhiteSpace(mode))
        {
            return string.Empty;
        }

        var modeLabel = string.Equals(mode, "lite", StringComparison.OrdinalIgnoreCase)
            ? "Lite 预览（只读）"
            : "官方 SDK";
        var parts = new List<string> { $"运行模式：{modeLabel}" };
        if (!string.IsNullOrWhiteSpace(status)) parts.Add($"状态={status}");

        var degradeReason = TryString(root, "degradeReason");
        if (string.Equals(mode, "lite", StringComparison.OrdinalIgnoreCase))
        {
            var reasonNote = degradeReason switch
            {
                "r1_profile_incompatible" => "默认模型非 Claude/Anthropic 兼容，已降级为只读审查",
                "sidecar_not_configured" => "官方 SDK runtime 未就绪，已降级为只读审查",
                _ => "已降级为只读审查（不修改文件、不执行命令、无需审批）"
            };
            parts.Add(reasonNote);
        }

        return string.Join(" · ", parts);
    }

    private static string RenderError(JsonElement root)
    {
        var code = TryString(root, "code");
        var message = TryString(root, "message");
        var recoveryKind = TryString(root, "recoveryKind");
        var retryable = TryBool(root, "retryable");
        var nextActions = TryStringArray(root, "nextActions");
        var source = TryString(root, "source");
        var runtimeAdapter = TryString(root, "runtimeAdapter");
        var runtimeInstance = TryString(root, "runtimeInstance");

        var parts = new List<string> { "错误" };
        if (!string.IsNullOrWhiteSpace(code)) parts.Add(code);
        if (!string.IsNullOrWhiteSpace(recoveryKind)) parts.Add($"recovery={recoveryKind}");
        if (retryable.HasValue) parts.Add($"retryable={(retryable.Value ? "yes" : "no")}");
        if (!string.IsNullOrWhiteSpace(runtimeAdapter)) parts.Add($"adapter={runtimeAdapter}");
        if (!string.IsNullOrWhiteSpace(runtimeInstance)) parts.Add($"instance={runtimeInstance}");
        if (!string.IsNullOrWhiteSpace(source)) parts.Add($"source={source}");

        var head = string.Join(" · ", parts);
        var body = string.IsNullOrWhiteSpace(message) ? head : $"{head}: {message}";
        if (nextActions.Count == 0) return body;

        return $"{body}\n下一步: {string.Join("；", nextActions.Take(3))}";
    }

    private static string TryString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static bool? TryBool(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True
            ? true
            : root.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.False
                ? false
                : null;

    private static List<string> TryStringArray(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return new List<string>();
        }

        return value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!)
            .ToList();
    }
}
