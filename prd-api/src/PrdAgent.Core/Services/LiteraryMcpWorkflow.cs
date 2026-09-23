using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>开放接口与网页共用配图标记格式；规划不调用模型，生成仍交给 ImageGenRunWorker。</summary>
public static class LiteraryMcpWorkflow
{
    public static string? Validate(string? content, string? markedContent, string? folderName)
    {
        if (folderName?.Trim().Length > 80) return "文件夹名称不能超过 80 字。";
        if (markedContent == null) return null;
        if (!string.IsNullOrEmpty(content)) return "content 与 markedContent 只能传一个，避免正文与配图位置不一致。";
        if (markedContent.Length > 200_000) return "带标记正文不能超过 200000 字。";
        var markers = ArticleMarkerExtractor.Extract(markedContent);
        if (markers.Count is < 1 or > 4) return "请在正文独立行使用 [插图]: 画面描述，单篇支持 1-4 个配图标记。";
        if (markers.Any(m => m.Text.Length > 4000)) return "每张配图的画面描述不能超过 4000 字。";
        if (string.IsNullOrWhiteSpace(PlainContent(markedContent))) return "请同时提供文章正文，不能只有配图标记。";
        return null;
    }

    public static string PlainContent(string markedContent)
    {
        var result = markedContent;
        foreach (var marker in ArticleMarkerExtractor.Extract(markedContent).AsEnumerable().Reverse())
            result = result.Remove(marker.StartPos, marker.EndPos - marker.StartPos);
        return result;
    }

    public static ArticleIllustrationWorkflow Prepare(string markedContent) => new()
    {
        Version = 1,
        Phase = 2,
        ExpectedImageCount = ArticleMarkerExtractor.Extract(markedContent).Count,
        Markers = ArticleMarkerExtractor.Extract(markedContent).Select(m => new ArticleIllustrationMarker
        {
            Index = m.Index, Text = m.Text, Status = "idle",
            PlanItem = new ArticleIllustrationPlanItem { Prompt = m.Text, Count = 1, Size = "1024x1024" },
        }).ToList(),
    };

    /// <summary>按标记索引替换而非按成功张数顺移：第二张先完成也不能占第一张的位置。</summary>
    public static string Render(string markedContent, IReadOnlyDictionary<int, string> urls)
    {
        var result = markedContent;
        foreach (var marker in ArticleMarkerExtractor.Extract(markedContent).AsEnumerable().Reverse())
        {
            if (!urls.TryGetValue(marker.Index, out var url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
                || (uri.Scheme != "https" && uri.Scheme != "http")) continue;
            result = result.Remove(marker.StartPos, marker.EndPos - marker.StartPos)
                .Insert(marker.StartPos, $"![配图 {marker.Index + 1}](<{uri.AbsoluteUri}>)");
        }
        return result;
    }
}
