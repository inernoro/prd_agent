using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>仅识别明确的一至三稿标记，预览与保存共用，不把版本号或重试次数当稿次。</summary>
public static class ProductInitiationPlanDefaults
{
    private static readonly Regex DraftMarker = new(@"(?<![\d一二三四五六七八九十])第?\s*([123一二三])\s*稿",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static int MeetingDraftCount(string? title, string? fileName = null)
    {
        foreach (var value in new[] { title, fileName })
        {
            var match = DraftMarker.Match(value ?? string.Empty);
            if (!match.Success) continue;
            return match.Groups[1].Value switch { "2" or "二" => 2, "3" or "三" => 3, _ => 1 };
        }
        return 1;
    }
}
