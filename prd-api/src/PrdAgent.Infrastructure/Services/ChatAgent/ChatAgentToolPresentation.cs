using System.Text.Json;

namespace PrdAgent.Infrastructure.Services.ChatAgent;

/// <summary>
/// 工具卡的展示层翻译：把运行时给的原始工具事件，翻成前端能直接画的一张卡。
///
/// 独立成类是为了能被直接断言——这里的每一条判据（工具名怎么归一、成败以什么为准、
/// 产物取哪几个字段）删掉之后功能都不会报错，只会静默画错，必须有守卫盯着。
/// </summary>
public static class ChatAgentToolPresentation
{
    /// <summary>工具卡载荷。字段即前端渲染契约，改名等于改协议。</summary>
    public sealed record ToolCardPayload(
        string? ToolUseId,
        string? Tool,
        string Label,
        bool Ok,
        string? Message,
        string? ImageUrl,
        string? EntryId,
        string? StoreName,
        string? Title,
        string? OpenPath);

    /// <summary>
    /// 官方 SDK 把我们注册的工具挂在内置 MCP server 下，模型看到的名字是
    /// mcp__map__chat_save_note 这种带前缀的形式，回传的 tool_use 事件也带着前缀。
    /// 下面所有按工具名分派的判据（标签 / 阶段 / 产物字段）都以裸名为准，
    /// 所以在进入判据之前先统一剥掉前缀——否则每一把工具都会静默落进兜底分支，
    /// 用户看到的永远是「工具 · 执行」。
    /// </summary>
    public static string? NormalizeToolName(string? tool)
    {
        if (string.IsNullOrEmpty(tool) || !tool.StartsWith("mcp__", StringComparison.Ordinal)) return tool;
        var lastSeparator = tool.LastIndexOf("__", StringComparison.Ordinal);
        if (lastSeparator < 0 || lastSeparator + 2 >= tool.Length) return tool;
        return tool[(lastSeparator + 2)..];
    }

    /// <summary>工具卡上给用户看的名字。用产物语言，不用函数名。</summary>
    public static string ToolLabel(string? tool) => NormalizeToolName(tool) switch
    {
        "chat_generate_image" => "生成图片",
        "chat_save_note" => "写入知识库",
        "kb_search" => "检索知识库",
        "kb_read" => "读取知识库",
        var other => other ?? "工具",
    };

    /// <summary>工具卡的阶段名。等待期屏幕上要有推进感，不能是一个转圈。</summary>
    public static string[] ToolSteps(string? tool) => NormalizeToolName(tool) switch
    {
        "chat_generate_image" => new[] { "排队", "模型出图", "写入素材库" },
        "chat_save_note" => new[] { "整理内容", "选定空间", "写入并建链接" },
        "kb_search" => new[] { "理解问题", "检索" },
        "kb_read" => new[] { "定位条目", "读取原文" },
        _ => new[] { "执行" },
    };

    /// <summary>
    /// 工具结果翻成前端能直接画的载荷：成败、产物（图片地址 / 知识库条目）、人话说明。
    /// 工具返回的是给模型看的 JSON，这里只挑用户看得见的那几项，其余不外泄。
    /// </summary>
    /// <param name="isError">
    /// 运行时给的失败标记。成败只认它：工具桥失败时回传的 content 是一句纯文本原因
    /// （不是带 success 字段的 JSON），嗅 content 判不出来，会把失败画成完成。
    /// 取不到（老运行时不发这个字段）时不臆造判据，维持「未知按成功画」，但产物为空。
    /// </param>
    public static ToolCardPayload BuildToolCardPayload(
        string? toolName, string? toolUseId, string? content, bool? isError)
    {
        var tool = NormalizeToolName(toolName);
        string? imageUrl = null, entryId = null, storeName = null, openPath = null, title = null;
        var ok = true;
        string? message = null;

        if (!string.IsNullOrWhiteSpace(content))
        {
            try
            {
                using var doc = JsonDocument.Parse(content!);
                var root = doc.RootElement;
                if (root.ValueKind == JsonValueKind.Object)
                {
                    if (root.TryGetProperty("imageUrl", out var u) && u.ValueKind == JsonValueKind.String)
                        imageUrl = u.GetString();
                    if (root.TryGetProperty("entryId", out var e) && e.ValueKind == JsonValueKind.String)
                        entryId = e.GetString();
                    if (root.TryGetProperty("storeName", out var sn) && sn.ValueKind == JsonValueKind.String)
                        storeName = sn.GetString();
                    if (root.TryGetProperty("openPath", out var op) && op.ValueKind == JsonValueKind.String)
                        openPath = op.GetString();
                    if (root.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String)
                        title = t.GetString();
                    if (root.TryGetProperty("total", out var tot) && tot.ValueKind == JsonValueKind.Number)
                        message = $"命中 {tot.GetInt32()} 条";
                }
            }
            catch (JsonException)
            {
                // 工具返回的不是 JSON（少见）：不当失败处理，只是没有可展示的产物。
            }
        }

        if (isError == true)
        {
            ok = false;
            // 失败时 content 就是那句人话原因，直接透出，别吞；过长的堆栈只留开头。
            var reason = (content ?? string.Empty).Trim();
            message = reason.Length == 0 ? "这一步没成功"
                : reason.Length > 200 ? reason[..200] + "…"
                : reason;
        }

        return new ToolCardPayload(
            toolUseId, tool, ToolLabel(tool), ok, message,
            imageUrl, entryId, storeName, title, openPath);
    }
}
