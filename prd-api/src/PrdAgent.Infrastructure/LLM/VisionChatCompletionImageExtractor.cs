using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 从 chat/completions 响应中提取生成图片的通用解析器（多图生图 Vision 分支专用）。
///
/// 背景：gemini 系模型经 OpenAI 兼容聚合网关（PlatformType=openai）返回图片时，
/// 响应形态不止「content 纯字符串」一种：
///   (a) choices[].message.images[]，每项 image_url.url（OpenRouter / LiteLLM 风格）；
///   (b) message.content 为多模态数组（[{type:image_url,...},{type:text,...}]）。
/// 旧实现把 content 反序列化为 string，(b) 形态得到 null → 「Vision API 响应格式不支持」。
///
/// 纯静态解析：不发 HTTP、不读 DB，便于单元测试（VisionResponseImageExtractionTests）。
/// 解析优先级：
///   1. choices[].message.images[]（对象项取 image_url.url / image_url 字符串 / url；容忍纯字符串项）
///   2. 首个 message 的 content 为纯字符串 → 旧启发式（data URL / http URL / Markdown 图片 / 内嵌 JSON url|b64_json）
///   3. content 为多模态数组 → 收集 image_url 项，text 项拼接为文本兜底
/// 提取出的图片统一为字符串：data: URI 或 http(s) URL，由调用方映射到 ImageGenImage。
/// </summary>
public static class VisionChatCompletionImageExtractor
{
    // 原 OpenAIImageClient.TryExtractMarkdownImageUrl 的匹配规则（已迁移到此处）：![alt](http(s)://... 或 data:image/...)
    private static readonly Regex MarkdownImageRegex = new(
        @"!\[.*?\]\(((?:https?://[^\s\)]+)|(?:data:image/[^\s\)]+))\)",
        RegexOptions.Compiled);

    /// <summary>
    /// 尝试从 chat/completions 响应体中提取图片。
    /// </summary>
    /// <param name="responseContent">上游响应体原文（JSON）</param>
    /// <param name="images">提取到的图片列表（data: URI 或 http(s) URL）</param>
    /// <param name="textFallback">未提取到图片时可用的文本内容（模型的文字答复）</param>
    /// <param name="diagnostics">诊断信息：枚举响应里实际有什么（content 形态 / images[] 是否存在），用于错误提示与日志</param>
    /// <returns>提取到至少一张图片时为 true</returns>
    public static bool TryExtractImages(
        string? responseContent,
        out List<string> images,
        out string? textFallback,
        out string diagnostics)
    {
        images = new List<string>();
        textFallback = null;

        if (string.IsNullOrWhiteSpace(responseContent))
        {
            diagnostics = "响应体为空";
            return false;
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(responseContent);
        }
        catch (JsonException)
        {
            diagnostics = "响应体不是合法 JSON";
            return false;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("choices", out var choicesEl)
                || choicesEl.ValueKind != JsonValueKind.Array
                || choicesEl.GetArrayLength() == 0)
            {
                diagnostics = "无 choices";
                return false;
            }

            // -1 表示所有 message 上都没有 images[] 字段
            var imagesArrayItemCount = -1;

            // 优先级 1：message.images[]（遍历所有 choices，与单图路径的 OpenRouter 解析一致）
            foreach (var choice in choicesEl.EnumerateArray())
            {
                if (choice.ValueKind != JsonValueKind.Object
                    || !choice.TryGetProperty("message", out var msgEl)
                    || msgEl.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                if (!msgEl.TryGetProperty("images", out var imgsEl) || imgsEl.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                if (imagesArrayItemCount < 0) imagesArrayItemCount = 0;
                imagesArrayItemCount += imgsEl.GetArrayLength();

                foreach (var item in imgsEl.EnumerateArray())
                {
                    var url = ExtractImageUrlFromItem(item);
                    if (IsUsableImageUrl(url)) images.Add(url!.Trim());
                }
            }

            // content 解析（取首个带 message 的 choice，与旧行为 choices[0] 对齐）
            var contentKind = "缺失";
            foreach (var choice in choicesEl.EnumerateArray())
            {
                if (choice.ValueKind != JsonValueKind.Object
                    || !choice.TryGetProperty("message", out var msgEl)
                    || msgEl.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                if (!msgEl.TryGetProperty("content", out var contentEl))
                {
                    break;
                }

                switch (contentEl.ValueKind)
                {
                    case JsonValueKind.String:
                    {
                        var s = contentEl.GetString();
                        if (string.IsNullOrWhiteSpace(s))
                        {
                            contentKind = "空字符串";
                        }
                        else
                        {
                            contentKind = "字符串";
                            // 优先级 2：仅当 images[] 没有产出时才从 content 提取（images[] 优先）
                            if (images.Count == 0)
                            {
                                ExtractFromStringContent(s, images, ref textFallback);
                            }
                        }
                        break;
                    }
                    case JsonValueKind.Array:
                    {
                        // 优先级 3：多模态数组（本次修复的核心形态）。
                        // images[] 已产出可用图时不重复收集 content 里的图（images[] 优先），但仍统计与拼接文本。
                        var collectContentImages = images.Count == 0;
                        var imageItemCount = 0;
                        var textItemCount = 0;
                        var textSb = new StringBuilder();
                        foreach (var item in contentEl.EnumerateArray())
                        {
                            if (item.ValueKind != JsonValueKind.Object) continue;

                            var itemType = item.TryGetProperty("type", out var typeEl) && typeEl.ValueKind == JsonValueKind.String
                                ? typeEl.GetString()
                                : null;

                            if (string.Equals(itemType, "image_url", StringComparison.OrdinalIgnoreCase)
                                || item.TryGetProperty("image_url", out _))
                            {
                                imageItemCount++;
                                if (collectContentImages)
                                {
                                    var url = ExtractImageUrlFromItem(item);
                                    if (IsUsableImageUrl(url)) images.Add(url!.Trim());
                                }
                            }
                            else if (item.TryGetProperty("text", out var textEl) && textEl.ValueKind == JsonValueKind.String)
                            {
                                textItemCount++;
                                textSb.Append(textEl.GetString());
                            }
                        }

                        contentKind = $"多模态数组(图片项{imageItemCount}/文本项{textItemCount})";
                        if (textSb.Length > 0) textFallback = textSb.ToString();
                        break;
                    }
                    case JsonValueKind.Null:
                        contentKind = "null";
                        break;
                    default:
                        contentKind = contentEl.ValueKind.ToString();
                        break;
                }

                break; // 只看首个带 message 的 choice 的 content
            }

            diagnostics = $"choices={choicesEl.GetArrayLength()}, " +
                          $"images[]={(imagesArrayItemCount < 0 ? "缺失" : imagesArrayItemCount + " 项")}, " +
                          $"content={contentKind}";
            return images.Count > 0;
        }
    }

    /// <summary>
    /// 从 images[] / 多模态 content 数组的单个项中取图片 URL。
    /// 容忍形态：纯字符串项 / image_url 为对象（取 url）/ image_url 为字符串 / 直接带 url 字段。
    /// </summary>
    private static string? ExtractImageUrlFromItem(JsonElement item)
    {
        if (item.ValueKind == JsonValueKind.String)
        {
            return item.GetString();
        }

        if (item.ValueKind != JsonValueKind.Object) return null;

        if (item.TryGetProperty("image_url", out var iuEl))
        {
            if (iuEl.ValueKind == JsonValueKind.Object
                && iuEl.TryGetProperty("url", out var urlEl)
                && urlEl.ValueKind == JsonValueKind.String)
            {
                return urlEl.GetString();
            }
            if (iuEl.ValueKind == JsonValueKind.String)
            {
                return iuEl.GetString();
            }
        }

        if (item.TryGetProperty("url", out var directUrlEl) && directUrlEl.ValueKind == JsonValueKind.String)
        {
            return directUrlEl.GetString();
        }

        return null;
    }

    /// <summary>
    /// content 为纯字符串时的启发式提取（保持与旧实现行为一致）：
    /// data URL 整段 / http URL 整段 / Markdown 图片 / 内嵌 JSON 的 url|b64_json；都不中则记为文本兜底。
    /// </summary>
    private static void ExtractFromStringContent(string content, List<string> images, ref string? textFallback)
    {
        if (content.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
        {
            images.Add(content);
            return;
        }

        if (content.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            images.Add(content.Trim());
            return;
        }

        var mdMatch = MarkdownImageRegex.Match(content);
        if (mdMatch.Success && mdMatch.Groups.Count > 1 && !string.IsNullOrWhiteSpace(mdMatch.Groups[1].Value))
        {
            images.Add(mdMatch.Groups[1].Value.Trim());
            return;
        }

        // 尝试把 content 当作内嵌 JSON（{"url":...} 或 {"b64_json":...}）
        try
        {
            using var inner = JsonDocument.Parse(content);
            var innerRoot = inner.RootElement;
            if (innerRoot.ValueKind == JsonValueKind.Object)
            {
                if (innerRoot.TryGetProperty("url", out var urlEl) && urlEl.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(urlEl.GetString()))
                {
                    images.Add(urlEl.GetString()!.Trim());
                    return;
                }
                if (innerRoot.TryGetProperty("b64_json", out var b64El) && b64El.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(b64El.GetString()))
                {
                    images.Add($"data:image/png;base64,{b64El.GetString()}");
                    return;
                }
            }
        }
        catch (JsonException)
        {
            // 非 JSON：纯文本答复
        }

        textFallback = content;
    }

    private static bool IsUsableImageUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        var trimmed = url.Trim();
        return trimmed.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
               || trimmed.StartsWith("http", StringComparison.OrdinalIgnoreCase);
    }
}
