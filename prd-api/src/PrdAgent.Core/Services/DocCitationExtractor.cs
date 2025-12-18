using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 从 PRD 文档中提取“引用依据”候选：章节 + 原文片段。
/// 目标：即使不完美，也要稳定给出 Top-N 依据，允许多处标黄。
/// </summary>
public static class DocCitationExtractor
{
    private const int MaxCitationsDefault = 12;

    private sealed record Candidate(
        string HeadingTitle,
        string HeadingId,
        string ParagraphText,
        string ParagraphTextClean);

    private sealed record Scored(Candidate Candidate, double Score);

    public static List<DocCitation> Extract(ParsedPrd prd, string assistantText, int maxCitations = MaxCitationsDefault)
    {
        maxCitations = Math.Max(0, Math.Min(50, maxCitations));
        if (maxCitations == 0) return new List<DocCitation>();

        if (prd == null) return new List<DocCitation>();
        var doc = prd.RawContent ?? string.Empty;
        if (string.IsNullOrWhiteSpace(doc)) return new List<DocCitation>();

        var answer = NormalizeWhitespace(assistantText);
        if (string.IsNullOrWhiteSpace(answer)) return new List<DocCitation>();

        // 1) 生成章节 headingId（需与前端 github-slugger 顺序一致）
        var slugger = new GithubSluggerLike();

        // 2) 生成候选段落
        var candidates = BuildCandidates(prd, slugger);
        if (candidates.Count == 0) return new List<DocCitation>();

        // 3) 从回答抽取关键词
        var keywords = ExtractKeywords(answer);
        if (keywords.Count == 0) return new List<DocCitation>();

        // 4) 打分并取 Top-N
        var scored = new List<Scored>(candidates.Count);
        foreach (var c in candidates)
        {
            if (c.ParagraphTextClean.Length < 18) continue;
            var s = ScoreCandidate(c, keywords);
            if (s <= 0) continue;
            scored.Add(new Scored(c, s));
        }

        if (scored.Count == 0) return new List<DocCitation>();

        // 同一段落可能被多次命中：去重（按 HeadingId + excerpt 近似去重）
        var top = scored
            .OrderByDescending(x => x.Score)
            .Take(maxCitations * 3)
            .ToList();

        var outList = new List<DocCitation>(maxCitations);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var rank = 1;

        foreach (var x in top)
        {
            if (outList.Count >= maxCitations) break;

            var excerpt = BuildExcerpt(x.Candidate.ParagraphTextClean, keywords);
            if (string.IsNullOrWhiteSpace(excerpt)) continue;

            // key 用 excerpt 的 hash-like（截断）避免过长
            var k = $"{x.Candidate.HeadingId}::{NormalizeWhitespace(excerpt)}";
            if (!seen.Add(k)) continue;

            outList.Add(new DocCitation
            {
                HeadingTitle = x.Candidate.HeadingTitle,
                HeadingId = x.Candidate.HeadingId,
                Excerpt = excerpt,
                Score = Math.Round(x.Score, 4),
                Rank = rank++
            });
        }

        return outList;
    }

    private static List<Candidate> BuildCandidates(ParsedPrd prd, GithubSluggerLike slugger)
    {
        var candidates = new List<Candidate>(256);

        void WalkSections(IEnumerable<Section> sections)
        {
            foreach (var s in sections)
            {
                var title = (s?.Title ?? string.Empty).Trim();
                if (!string.IsNullOrWhiteSpace(title))
                {
                    var headingText = NormalizeHeadingText(title);
                    var headingId = slugger.Slug(headingText);

                    // Section.Content：通常是该章节正文（不含 heading 行）
                    var body = s?.Content ?? string.Empty;
                    foreach (var para in SplitParagraphs(body))
                    {
                        var raw = para.Trim();
                        if (raw.Length < 12) continue;

                        var clean = CleanMarkdownToText(raw);
                        clean = NormalizeWhitespace(clean);
                        if (clean.Length < 18) continue;

                        candidates.Add(new Candidate(headingText, headingId, raw, clean));
                    }
                }

                if (s?.Children != null && s.Children.Count > 0)
                {
                    WalkSections(s.Children);
                }
            }
        }

        WalkSections(prd.Sections ?? new List<Section>());
        return candidates;
    }

    private static IEnumerable<string> SplitParagraphs(string markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) yield break;

        // 移除 fenced code block（避免误命中代码）
        var withoutFence = Regex.Replace(markdown, @"(^|\n)\s*(```+|~~~+)[\s\S]*?(\n\s*\2\s*)(?=\n|$)", "\n", RegexOptions.Multiline);

        // 按空行切分
        var parts = Regex.Split(withoutFence, @"\n\s*\n+");
        foreach (var p in parts)
        {
            var t = p?.Trim();
            if (string.IsNullOrWhiteSpace(t)) continue;
            yield return t;
        }
    }

    private static string CleanMarkdownToText(string markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return string.Empty;

        var s = markdown;

        // inline code
        s = Regex.Replace(s, @"`([^`]+)`", "$1");
        // images: ![alt](url) -> alt
        s = Regex.Replace(s, @"!\[([^\]]*)\]\([^\)]*\)", "$1");
        // links: [text](url) -> text
        s = Regex.Replace(s, @"\[([^\]]+)\]\([^\)]*\)", "$1");
        // emphasis/bold
        s = s.Replace("**", "").Replace("__", "").Replace("*", "").Replace("_", "");
        // blockquote markers
        s = Regex.Replace(s, @"^\s*>+\s?", "", RegexOptions.Multiline);
        // list markers
        s = Regex.Replace(s, @"^\s*([-*+]|\d+\.)\s+", "", RegexOptions.Multiline);
        // heading markers（防御性）
        s = Regex.Replace(s, @"^\s*#{1,6}\s+", "", RegexOptions.Multiline);
        // tables pipes
        s = s.Replace("|", " ");

        return s;
    }

    private static string NormalizeWhitespace(string input)
    {
        var s = (input ?? string.Empty).Replace("\r\n", "\n");
        s = Regex.Replace(s, @"\s+", " ").Trim();
        return s;
    }

    private static string NormalizeHeadingText(string raw)
    {
        var s = (raw ?? string.Empty);
        s = Regex.Replace(s, @"\s+#+\s*$", string.Empty).Trim();
        s = Regex.Replace(s, @"\s+", " ").Trim();
        return s;
    }

    private static Dictionary<string, int> ExtractKeywords(string answer)
    {
        // 同时兼容中文词块/英文单词/数字：取较稳定的 token
        var dict = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        void Add(string token)
        {
            var t = (token ?? string.Empty).Trim();
            if (t.Length < 2) return;
            if (t.Length > 24) t = t[..24];
            dict.TryGetValue(t, out var c);
            dict[t] = c + 1;
        }

        // CJK 连续块（2+）
        foreach (Match m in Regex.Matches(answer, @"[\u4e00-\u9fff]{2,}", RegexOptions.CultureInvariant))
        {
            Add(m.Value);
        }

        // 英文/数字词
        foreach (Match m in Regex.Matches(answer, @"[A-Za-z]{3,}|\d{2,}", RegexOptions.CultureInvariant))
        {
            Add(m.Value);
        }

        // 取 top 40（按频次*长度）
        var top = dict
            .Select(kv => new { kv.Key, kv.Value, W = kv.Value * Math.Min(8, kv.Key.Length) })
            .OrderByDescending(x => x.W)
            .Take(40)
            .ToList();

        return top.ToDictionary(x => x.Key, x => x.Value, StringComparer.OrdinalIgnoreCase);
    }

    private static double ScoreCandidate(Candidate c, Dictionary<string, int> keywords)
    {
        var text = c.ParagraphTextClean;
        if (string.IsNullOrWhiteSpace(text)) return 0;

        double score = 0;
        var lower = text.ToLowerInvariant();

        foreach (var kv in keywords)
        {
            var k = kv.Key;
            if (k.Length < 2) continue;

            var kLower = k.ToLowerInvariant();
            if (lower.Contains(kLower, StringComparison.Ordinal))
            {
                // 长词加权更高，避免噪声
                score += Math.Min(6, k.Length) * 1.0;
            }
        }

        // 标题命中略加分
        if (!string.IsNullOrWhiteSpace(c.HeadingTitle))
        {
            var ht = c.HeadingTitle.ToLowerInvariant();
            foreach (var kv in keywords)
            {
                var kLower = kv.Key.ToLowerInvariant();
                if (ht.Contains(kLower, StringComparison.Ordinal))
                {
                    score += 2.0;
                }
            }
        }

        // 长度归一：太长的段落轻微折损
        if (text.Length > 400) score *= 0.9;
        if (text.Length > 900) score *= 0.85;

        return score;
    }

    private static string BuildExcerpt(string paragraphClean, Dictionary<string, int> keywords)
    {
        var text = paragraphClean;
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;

        // 找最早出现的高权重关键词位置
        var bestIdx = -1;
        var bestWeight = -1;
        var lower = text.ToLowerInvariant();

        foreach (var kv in keywords)
        {
            var k = kv.Key;
            var idx = lower.IndexOf(k.ToLowerInvariant(), StringComparison.Ordinal);
            if (idx < 0) continue;
            var w = Math.Min(10, k.Length) * 10 + Math.Min(5, kv.Value);
            if (bestIdx < 0 || idx < bestIdx || (idx == bestIdx && w > bestWeight))
            {
                bestIdx = idx;
                bestWeight = w;
            }
        }

        const int targetLen = 120;
        if (bestIdx < 0)
        {
            // 无明确关键词：直接截断
            return text.Length <= targetLen ? text : text[..targetLen] + "…";
        }

        var start = Math.Max(0, bestIdx - 40);
        var end = Math.Min(text.Length, start + targetLen);
        var slice = text[start..end];
        if (start > 0) slice = "…" + slice;
        if (end < text.Length) slice = slice + "…";
        return slice;
    }

    /// <summary>
    /// 一个轻量的 github-slugger 兼容实现（足够与前端保持一致）。
    /// </summary>
    private sealed class GithubSluggerLike
    {
        private readonly Dictionary<string, int> _seen = new(StringComparer.Ordinal);

        public string Slug(string value)
        {
            var baseSlug = GithubSlug(value);
            if (string.IsNullOrWhiteSpace(baseSlug)) baseSlug = "section";

            if (!_seen.TryGetValue(baseSlug, out var n))
            {
                _seen[baseSlug] = 0;
                return baseSlug;
            }

            n += 1;
            _seen[baseSlug] = n;
            return $"{baseSlug}-{n}";
        }

        private static string GithubSlug(string value)
        {
            var s = (value ?? string.Empty).Trim();
            if (s.Length == 0) return string.Empty;

            // 归一化：小写 + 兼容 unicode
            s = s.ToLowerInvariant();

            // 去掉常见标点（保留 unicode 字母/数字）
            var sb = new StringBuilder(s.Length);
            foreach (var ch in s)
            {
                if (char.IsWhiteSpace(ch))
                {
                    sb.Append('-');
                    continue;
                }

                if (ch == '-') { sb.Append('-'); continue; }
                if (ch == '_') { sb.Append('_'); continue; }

                var cat = char.GetUnicodeCategory(ch);
                if (cat is UnicodeCategory.LetterNumber or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LowercaseLetter or UnicodeCategory.UppercaseLetter or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter or UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark)
                {
                    sb.Append(ch);
                }
                // 其它类别视为分隔符/删除
            }

            // 合并多余的 '-'
            var raw = sb.ToString();
            raw = Regex.Replace(raw, @"-+", "-").Trim('-');
            return raw;
        }
    }
}
