using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// PRD 预览页“本章提问”服务：仅基于当前章节内容回答，不落库。
/// </summary>
public class PreviewAskService : IPreviewAskService
{
    private readonly ILLMClient _llmClient;
    private readonly ISessionService _sessionService;
    private readonly IDocumentService _documentService;
    private readonly IPromptManager _promptManager;
    private readonly ILLMRequestContextAccessor _llmRequestContext;

    public PreviewAskService(
        ILLMClient llmClient,
        ISessionService sessionService,
        IDocumentService documentService,
        IPromptManager promptManager,
        ILLMRequestContextAccessor llmRequestContext)
    {
        _llmClient = llmClient;
        _sessionService = sessionService;
        _documentService = documentService;
        _promptManager = promptManager;
        _llmRequestContext = llmRequestContext;
    }

    public async IAsyncEnumerable<PreviewAskStreamEvent> AskInSectionAsync(
        string sessionId,
        string headingId,
        string? headingTitle,
        string question,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var q = (question ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(q))
        {
            yield return new PreviewAskStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.CONTENT_EMPTY,
                ErrorMessage = "问题不能为空"
            };
            yield break;
        }

        var hId = (headingId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(hId))
        {
            yield return new PreviewAskStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = "未识别到当前章节（headingId 为空）"
            };
            yield break;
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            yield return new PreviewAskStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.SESSION_NOT_FOUND,
                ErrorMessage = "会话不存在或已过期"
            };
            yield break;
        }

        var document = await _documentService.GetByIdAsync(session.DocumentId);
        if (document == null)
        {
            yield return new PreviewAskStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.DOCUMENT_NOT_FOUND,
                ErrorMessage = "文档不存在或已过期"
            };
            yield break;
        }

        var raw = document.RawContent ?? string.Empty;
        var sectionMarkdown = ExtractSectionMarkdown(raw, hId);
        if (string.IsNullOrWhiteSpace(sectionMarkdown))
        {
            yield return new PreviewAskStreamEvent
            {
                Type = "error",
                ErrorCode = "SECTION_NOT_FOUND",
                ErrorMessage = "未找到对应章节内容（可能是标题变更或解析失败）"
            };
            yield break;
        }

        // 控制上下文最大长度（避免过长导致请求膨胀）
        const int maxSectionChars = 24000;
        if (sectionMarkdown.Length > maxSectionChars)
        {
            sectionMarkdown = sectionMarkdown[..maxSectionChars] + "\n\n（已截断：章节内容过长）\n";
        }

        // 构建 system prompt：仅注入本章节内容
        var systemPrompt = _promptManager.BuildSystemPrompt(session.CurrentRole, sectionMarkdown);
        var systemPromptRedacted = _promptManager.BuildSystemPrompt(session.CurrentRole, "[SECTION_CONTENT_REDACTED]");
        var docHash = Sha256Hex(raw);

        var requestId = Guid.NewGuid().ToString();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: session.GroupId,
            SessionId: session.SessionId,
            UserId: null,
            ViewRole: session.CurrentRole.ToString(),
            DocumentChars: sectionMarkdown.Length,
            DocumentHash: docHash,
            SystemPromptRedacted: systemPromptRedacted));

        yield return new PreviewAskStreamEvent { Type = "start", RequestId = requestId };

        var ht = (headingTitle ?? string.Empty).Trim();
        var userPrompt =
            $"你正在查看 PRD 的当前章节：{(string.IsNullOrWhiteSpace(ht) ? hId : ht)}。\n" +
            "请仅基于该章节内容回答；如果该章节缺少信息，请明确说明缺失点，并提出需要补充哪些内容。\n\n" +
            $"问题：{q}\n";

        var messages = new List<LLMMessage> { new() { Role = "user", Content = userPrompt } };

        await foreach (var chunk in _llmClient.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return new PreviewAskStreamEvent { Type = "delta", RequestId = requestId, Content = chunk.Content };
            }
            else if (chunk.Type == "error")
            {
                yield return new PreviewAskStreamEvent
                {
                    Type = "error",
                    RequestId = requestId,
                    ErrorCode = ErrorCodes.LLM_ERROR,
                    ErrorMessage = chunk.ErrorMessage ?? "LLM 调用失败"
                };
                yield break;
            }
        }

        yield return new PreviewAskStreamEvent { Type = "done", RequestId = requestId };
    }

    /// <summary>
    /// 从 RawContent 中按 headingId 抽取当前章节的 markdown（含 heading 行）。\n
    /// 规则：按照与前端 github-slugger 相同的 headingId 生成顺序解析 headings。\n
    /// </summary>
    private static string ExtractSectionMarkdown(string rawMarkdown, string headingId)
    {
        if (string.IsNullOrWhiteSpace(rawMarkdown)) return string.Empty;
        var lines = rawMarkdown.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
        var slugger = new GithubSluggerLike();
        var headings = ExtractHeadings(lines, slugger);
        if (headings.Count == 0) return string.Empty;

        var idx = headings.FindIndex(h => string.Equals(h.HeadingId, headingId, StringComparison.Ordinal));
        if (idx < 0) return string.Empty;

        var start = headings[idx].LineIdx0;
        var endExclusive = (idx + 1 < headings.Count) ? headings[idx + 1].LineIdx0 : lines.Length;
        start = Math.Max(0, Math.Min(lines.Length, start));
        endExclusive = Math.Max(start + 1, Math.Min(lines.Length, endExclusive));
        return string.Join("\n", lines[start..endExclusive]).Trim();
    }

    private sealed record HeadingRow(int Level, string Title, int LineIdx0, string HeadingId);

    private static List<HeadingRow> ExtractHeadings(string[] lines, GithubSluggerLike slugger)
    {
        var list = new List<HeadingRow>(128);
        var headingPattern = new Regex(@"^\s*(#{1,6})\s+(.+?)\s*$", RegexOptions.Compiled);

        bool inFence = false;
        string? fenceToken = null;
        var fencePattern = new Regex(@"^\s*(```+|~~~+)\s*(\w+)?\s*$", RegexOptions.Compiled);

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i] ?? string.Empty;

            var fence = fencePattern.Match(line);
            if (fence.Success)
            {
                var token = fence.Groups[1].Value;
                if (!inFence)
                {
                    inFence = true;
                    fenceToken = token;
                }
                else if (!string.IsNullOrEmpty(fenceToken) && line.TrimStart().StartsWith(fenceToken, StringComparison.Ordinal))
                {
                    inFence = false;
                    fenceToken = null;
                }
                continue;
            }

            if (inFence) continue;

            var m = headingPattern.Match(line);
            if (!m.Success) continue;

            var level = m.Groups[1].Value.Length;
            var title = NormalizeHeadingText(m.Groups[2].Value);
            if (string.IsNullOrWhiteSpace(title)) continue;

            var id = slugger.Slug(title);
            list.Add(new HeadingRow(level, title, i, id));
        }

        return list;
    }

    private static string NormalizeHeadingText(string raw)
    {
        var s = (raw ?? string.Empty);
        s = Regex.Replace(s, @"\s+#+\s*$", string.Empty).Trim();
        s = Regex.Replace(s, @"\s+", " ").Trim();
        return s;
    }

    private static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// 轻量 github-slugger 兼容实现（与前端 MarkdownRenderer 的 slug 行为保持一致）。\n
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
            s = s.ToLowerInvariant();

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
            }

            var raw = sb.ToString();
            raw = Regex.Replace(raw, @"-+", "-").Trim('-');
            return raw;
        }
    }
}

