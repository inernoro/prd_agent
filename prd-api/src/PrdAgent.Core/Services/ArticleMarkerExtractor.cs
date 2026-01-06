using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 文章配图标记提取器：提取和替换 [[...]] 标记
/// </summary>
public static class ArticleMarkerExtractor
{
    private static readonly Regex MarkerRegex = new(@"\[插图\]\s*:\s*(.+?)(?=\n|$)", RegexOptions.Compiled | RegexOptions.Multiline);

    /// <summary>
    /// 从文章内容中提取所有 [[...]] 标记
    /// </summary>
    public static List<ArticleMarker> Extract(string content)
    {
        var markers = new List<ArticleMarker>();
        var matches = MarkerRegex.Matches(content ?? string.Empty);

        for (int i = 0; i < matches.Count; i++)
        {
            var match = matches[i];
            markers.Add(new ArticleMarker
            {
                Index = i,
                Text = match.Groups[1].Value,
                StartPos = match.Index,
                EndPos = match.Index + match.Length
            });
        }

        return markers;
    }

    /// <summary>
    /// 将文章中的 [[...]] 标记替换为实际图片 Markdown 链接
    /// </summary>
    public static string ReplaceMarkersWithImages(string content, List<ImageAsset> assets)
    {
        var sortedAssets = assets
            .Where(a => a.ArticleInsertionIndex.HasValue)
            .OrderBy(a => a.ArticleInsertionIndex)
            .ToList();

        var result = content;
        var offset = 0;

        foreach (var asset in sortedAssets)
        {
            var marker = MarkerRegex.Match(result, offset);
            if (!marker.Success) break;

            var altText = asset.OriginalMarkerText ?? "配图";
            var replacement = $"![{altText}]({asset.Url})";
            result = result.Remove(marker.Index, marker.Length)
                          .Insert(marker.Index, replacement);
            offset = marker.Index + replacement.Length;
        }

        return result;
    }
}

/// <summary>
/// 文章配图标记数据模型
/// </summary>
public class ArticleMarker
{
    public int Index { get; set; }
    public string Text { get; set; } = string.Empty;
    public int StartPos { get; set; }
    public int EndPos { get; set; }
}

