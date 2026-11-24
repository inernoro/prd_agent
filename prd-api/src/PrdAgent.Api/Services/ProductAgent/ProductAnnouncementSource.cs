using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record AnnouncementPage(IReadOnlyList<ProductAnnouncement> Items, bool HasNext);

/// <summary>指定公开列表的有限解析器，不执行网页内容，也不跟随页面中的任意地址。</summary>
public static class ProductAnnouncementSource
{
    public const string ListUrl = "https://helper.weixin12315.com/945f";
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(1);
    private static readonly Regex Anchors = new("<a\\b[^>]*href\\s*=\\s*[\"'](?<url>[^\"']+)[\"'][^>]*>(?<text>.*?)</a>", RegexOptions.IgnoreCase | RegexOptions.Singleline, RegexTimeout);
    private static readonly Regex Tags = new("<[^>]+>", RegexOptions.Singleline, RegexTimeout);
    private static readonly Regex Version = new(@"V\s*(\d{1,6})\s*\.\s*(\d{1,6})\s*\.\s*(\d{1,6})(?![\d.])", RegexOptions.IgnoreCase, RegexTimeout);

    public static bool TryAnnouncementUrl(string? value, out Uri uri)
    {
        uri = null!;
        if (!Uri.TryCreate(new Uri(ListUrl), WebUtility.HtmlDecode(value ?? ""), out var candidate)
            || candidate.Scheme != "https" || candidate.Host != "helper.weixin12315.com" || !candidate.IsDefaultPort || candidate.UserInfo.Length != 0
            || !Regex.IsMatch(candidate.AbsolutePath, @"^/945f/[A-Za-z0-9_-]+$", RegexOptions.None, RegexTimeout)) return false;
        uri = candidate;
        return true;
    }

    public static void EnrichTitle(ProductAnnouncement item)
    {
        var matches = Version.Matches(item.Title);
        if (matches.Count != 1) return;
        item.ApplicationName = ApplicationKey(item.Title[..matches[0].Index].Trim(' ', '-', '—', '：', ':'));
        item.Version = VersionKey(matches[0].Value) ?? "";
    }

    private static string Text(string html) => Regex.Replace(WebUtility.HtmlDecode(Tags.Replace(html, "")), @"\s+", " ", RegexOptions.None, RegexTimeout).Trim();

    private static bool IsDateParagraph(string value) => Regex.IsMatch(value,
        @"^\d{4}\s*[年/-]\s*\d{1,2}\s*[月/-]\s*\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$", RegexOptions.None, RegexTimeout);

    /// <summary>发布时间取正文落款；未右对齐时只认最后非空正文段落的纯日期，不扫业务正文。</summary>
    public static (string PublishedAtRaw, string FooterTimeRaw) ParseDetail(string html, string expectedTitle)
    {
        var headings = Regex.Matches(html, @"<(?:h1|title)\b[^>]*>(?<text>.*?)</(?:h1|title)>", RegexOptions.IgnoreCase | RegexOptions.Singleline, RegexTimeout);
        var expected = Text(expectedTitle);
        if (expected.Length == 0 || !headings.Any(x => Text(x.Groups["text"].Value).Contains(expected, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("公告详情内容未识别，请在抓取记录中重试该公告。");
        var paragraphs = Regex.Matches(html, "<div\\b[^>]*class=[\"'][^\"']*editor_js--paragraph__align-right[^\"']*[\"'][^>]*>(?<text>.*?)</div>", RegexOptions.IgnoreCase | RegexOptions.Singleline, RegexTimeout);
        var published = paragraphs.Select(x => Text(x.Groups["text"].Value)).LastOrDefault(IsDateParagraph) ?? "";
        if (published.Length == 0)
        {
            // /cab8 的真实落款未设右对齐；只允许最后一个非空 editor 段落兜底。
            var bodyParagraphs = Regex.Matches(html, "<div\\b[^>]*class=[\"'][^\"']*\\beditor_js--paragraph\\b[^\"']*[\"'][^>]*>(?<text>.*?)</div>", RegexOptions.IgnoreCase | RegexOptions.Singleline, RegexTimeout);
            var last = bodyParagraphs.Select(x => Text(x.Groups["text"].Value)).LastOrDefault(x => x.Length != 0);
            if (last != null && IsDateParagraph(last)) published = last;
        }
        var footer = Regex.Match(html, "<div\\b[^>]*class=[\"']flex items-center mt-10 text-xs text-gray-400[\"'][^>]*>(?<content>.*?)</div>\\s*</div>", RegexOptions.IgnoreCase | RegexOptions.Singleline, RegexTimeout);
        var time = footer.Success ? Regex.Match(footer.Groups["content"].Value, "<div\\b[^>]*class=[\"']ml-1[\"'][^>]*>(?<text>.*)", RegexOptions.IgnoreCase | RegexOptions.Singleline, RegexTimeout) : Match.Empty;
        return (published, time.Success ? Text(time.Groups["text"].Value) : "");
    }

    public static DateTime? ParseSourceTime(string? value)
    {
        var formats = new[] { "yyyy年M月d日", "yyyy年M月d", "yyyy-M-d", "yyyy/M/d", "yyyy-M-d H:mm", "yyyy-M-d H:mm:ss", "yyyy年M月d日 H:mm", "yyyy年M月d日 H:mm:ss" };
        return DateTime.TryParseExact(value?.Trim(), formats, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var local)
            ? DateTime.SpecifyKind(local.AddHours(-8), DateTimeKind.Utc) : null;
    }

    public static AnnouncementPage ParsePage(string html, int page)
    {
        var items = new List<ProductAnnouncement>();
        var hasNext = false;
        foreach (Match anchor in Anchors.Matches(html))
        {
            if (!Uri.TryCreate(new Uri(ListUrl), WebUtility.HtmlDecode(anchor.Groups["url"].Value), out var uri)
                || uri.Scheme != "https" || uri.Host != "helper.weixin12315.com" || !uri.IsDefaultPort) continue;
            if (uri.AbsolutePath == "/945f" && uri.Query == $"?page={page + 1}") hasNext = true;
            if (!TryAnnouncementUrl(uri.AbsoluteUri, out _)) continue;
            var title = WebUtility.HtmlDecode(Tags.Replace(anchor.Groups["text"].Value, "")).Trim();
            // 列表中同一条目可能有图片和标题两个链接，只保留有文字的标题。
            if (title.Length == 0) continue;
            var url = uri.GetLeftPart(UriPartial.Path);
            if (items.Any(x => x.Url == url)) continue;
            var item = new ProductAnnouncement { Id = uri.Segments[^1], Url = url, Title = title, SourcePage = page };
            EnrichTitle(item);
            items.Add(item);
        }
        if (items.Count == 0) throw new InvalidDataException("公告列表没有可识别条目，已保留上次抓取位置，请稍后重试。");
        return new(items, hasNext);
    }

    public static string ApplicationKey(string? value)
    {
        var key = ProductVersionPlanMatching.CanonicalApplicationName(value);
        // 均来自用户确认或公开列表中已观察到的应用名称；不做跨应用模糊猜测。
        return key switch {
            "品牌后台基础" => "品牌商后台基础",
            _ => key,
        };
    }

    public static string? VersionKey(string? value)
    {
        var match = Version.Match(value ?? "");
        return match.Success ? $"V{int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture)}.{int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture)}.{int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture)}" : null;
    }

    public static string? TitleKey(string title)
    {
        var matches = Version.Matches(title);
        if (matches.Count != 1) return null;
        var app = ApplicationKey(title[..matches[0].Index].Trim(' ', '-', '—', '：', ':'));
        return app.Length == 0 ? null : app + ":" + VersionKey(matches[0].Value);
    }

    public static ProductWorkdayCalendar ParseCalendar(string json, int year)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.GetProperty("year").GetInt32() != year) throw new InvalidDataException("法定工作日日历年份不一致。");
        var papers = root.GetProperty("papers").EnumerateArray().Select(x => x.GetString() ?? "").ToList();
        if (!papers.Any(x => Uri.TryCreate(x, UriKind.Absolute, out var uri) && uri.Scheme == "https"
            && (uri.Host == "gov.cn" || uri.Host.EndsWith(".gov.cn", StringComparison.Ordinal))))
            throw new InvalidDataException("法定工作日日历缺少官方公告依据。");
        var calendar = new ProductWorkdayCalendar { Id = year.ToString(CultureInfo.InvariantCulture), Year = year, Papers = papers };
        foreach (var day in root.GetProperty("days").EnumerateArray())
        {
            var raw = day.GetProperty("date").GetString() ?? "";
            if (!DateOnly.TryParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) || date.Year != year)
                throw new InvalidDataException("法定工作日日历日期无效。");
            if (!calendar.Overrides.TryAdd(raw, !day.GetProperty("isOffDay").GetBoolean()))
                throw new InvalidDataException("法定工作日日历存在重复日期。");
        }
        if (calendar.Overrides.Count == 0) throw new InvalidDataException("法定工作日日历未公布，暂不执行定时更新。");
        return calendar;
    }

    public static DateTime MonthlySlotUtc(int year, int month, ProductWorkdayCalendar calendar)
    {
        if (calendar.Year != year) throw new InvalidDataException("缺少本年度法定工作日日历。");
        var date = new DateOnly(year, month, 1);
        while (date.Month == month)
        {
            var works = calendar.Overrides.TryGetValue(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), out var overridden)
                ? overridden : date.DayOfWeek is not DayOfWeek.Saturday and not DayOfWeek.Sunday;
            // 北京时间08:00恰为UTC00:00，中国不使用夏令时。
            if (works) return DateTime.SpecifyKind(date.ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc);
            date = date.AddDays(1);
        }
        throw new InvalidDataException("本月没有有效法定工作日。");
    }
}
