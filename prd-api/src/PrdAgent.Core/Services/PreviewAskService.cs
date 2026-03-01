using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Core.Services;

/// <summary>
/// PRD 预览页"本章提问"服务：仅基于当前章节内容回答，不落库。
/// </summary>
public class PreviewAskService : IPreviewAskService
{
    private readonly ILlmGateway _gateway;
    private readonly ISessionService _sessionService;
    private readonly IDocumentService _documentService;
    private readonly IPromptManager _promptManager;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IAppSettingsService _settingsService;
    private readonly ISystemPromptService _systemPromptService;

    public PreviewAskService(
        ILlmGateway gateway,
        ISessionService sessionService,
        IDocumentService documentService,
        IPromptManager promptManager,
        ILLMRequestContextAccessor llmRequestContext,
        IAppSettingsService settingsService,
        ISystemPromptService systemPromptService)
    {
        _gateway = gateway;
        _sessionService = sessionService;
        _documentService = documentService;
        _promptManager = promptManager;
        _llmRequestContext = llmRequestContext;
        _settingsService = settingsService;
        _systemPromptService = systemPromptService;
    }

    public async IAsyncEnumerable<PreviewAskStreamEvent> AskInSectionAsync(
        string sessionId,
        string headingId,
        string? headingTitle,
        string question,
        UserRole? answerAsRole = null,
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

        var effectiveAnswerRole = answerAsRole ?? session.CurrentRole;

        // “本章提问”也视为会话活跃：刷新 LastActiveAt 与 TTL，避免用户在预览页连续使用但会话仍自然过期。
        await _sessionService.RefreshActivityAsync(sessionId);

        // "本章提问"基于主文档（首个文档）的章节内容进行回答
        var primaryDocId = session.GetAllDocumentIds().FirstOrDefault() ?? session.DocumentId;
        var document = await _documentService.GetByIdAsync(primaryDocId);
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
        var sectionMarkdown = ExtractSectionMarkdown(raw, hId, headingTitle);
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

        // 控制上下文长度：
        // - "本章提问"需要强调本章内容，但也希望模型可参考全文（避免漏掉跨章节信息）
        // - 若全文过长，会顶爆上下文，因此对"全文参考"做上限截断；本章内容仍优先保留。
        // 使用系统配置的字符限制（默认 200k，所有大模型请求输入的字符限制统一来源）
        var settings = await _settingsService.GetSettingsAsync(cancellationToken);
        var maxChars = LlmLogLimits.GetRequestBodyMaxChars(settings);
        // 章节内容限制为配置的 12%（经验值：章节不应占用过多上下文）
        var maxSectionChars = (int)(maxChars * 0.12);
        // 全文参考限制为配置的 45%（经验值：过大容易导致上下文超限/延迟飙升）
        var maxFullPrdChars = (int)(maxChars * 0.45);

        var sectionForPrompt = sectionMarkdown;
        if (sectionForPrompt.Length > maxSectionChars)
        {
            sectionForPrompt = sectionForPrompt[..maxSectionChars] + "\n\n（已截断：章节内容过长）\n";
        }

        var fullForPrompt = raw;
        if (fullForPrompt.Length > maxFullPrdChars)
        {
            fullForPrompt = fullForPrompt[..maxFullPrdChars] + "\n\n（已截断：PRD 全文过长，仅提供前半部分作为参考）\n";
        }

        // 构建 system prompt（PRD 不再注入 system；改为 user/context message 传入）
        var systemPrompt = await _systemPromptService.GetSystemPromptAsync(effectiveAnswerRole, cancellationToken);
        var systemPromptRedacted = systemPrompt;
        var docHash = Sha256Hex(raw);

        var requestId = Guid.NewGuid().ToString();
        var appCallerCode = Desktop.PreviewAsk.SectionChat;
        var llmClient = _gateway.CreateClient(appCallerCode, "chat");
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: session.GroupId,
            SessionId: session.SessionId,
            UserId: null,
            ViewRole: effectiveAnswerRole.ToString(),
            DocumentChars: sectionMarkdown.Length,
            DocumentHash: docHash,
            SystemPromptRedacted: systemPromptRedacted,
            RequestType: "reasoning",
            RequestPurpose: appCallerCode));

        yield return new PreviewAskStreamEvent { Type = "start", RequestId = requestId };

        var ht = (headingTitle ?? string.Empty).Trim();
        var displayTitle = string.IsNullOrWhiteSpace(ht) ? hId : ht;
        // 资料（可包含全文参考 + 当前章节原文），日志侧会按标记脱敏，不落库 PRD 原文
        var context =
            "[[CONTEXT:PRD]]\n" +
            "<PRD_FULL_REFERENCE>\n" +
            fullForPrompt + "\n" +
            "</PRD_FULL_REFERENCE>\n\n" +
            $"<PRD_SECTION headingId=\"{hId}\" title=\"{displayTitle}\">\n" +
            sectionForPrompt + "\n" +
            "</PRD_SECTION>\n" +
            "[[/CONTEXT:PRD]]";

        var userPrompt =
            $"你正在查看 PRD 的当前章节：{displayTitle}（headingId={hId}）。\n" +
            "我已在上一条资料中提供“PRD 全文参考（可能截断）”与“当前章节原文”。\n" +
            "回答时请优先依据“当前章节原文”，并明确引用章节要点；若必须引用其他章节才能回答，可引用全文参考中的相关段落并说明来自其他章节。\n" +
            "如果本章缺少信息且全文参考也未覆盖，必须明确写“PRD 未覆盖/未找到”，并说明需要补充什么信息（不要编造）。\n\n" +
            "# 问题\n" +
            q + "\n";

        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = context },
            new() { Role = "user", Content = userPrompt }
        };

        await foreach (var chunk in llmClient.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
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
    private static string ExtractSectionMarkdown(string rawMarkdown, string headingId, string? headingTitle)
    {
        if (string.IsNullOrWhiteSpace(rawMarkdown)) return string.Empty;
        var lines = rawMarkdown.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
        var slugger = new GithubSluggerLike();
        var headings = ExtractHeadings(lines, slugger);
        if (headings.Count == 0) return string.Empty;

        var idx = headings.FindIndex(h => string.Equals(h.HeadingId, headingId, StringComparison.Ordinal));
        if (idx < 0 && !string.IsNullOrWhiteSpace(headingTitle))
        {
            // 兼容：前端标题渲染会剥离部分 inline markdown（如 **加粗**、`code`、[link](url)）。
            // 如果后端原文标题包含这些标记，slug 会不一致，导致找不到 headingId。
            // 这里用“渲染后的标题文本”回退定位章节。
            var ht = NormalizeHeadingText(StripInlineMarkdown(headingTitle));
            if (!string.IsNullOrWhiteSpace(ht))
            {
                idx = headings.FindIndex(h => string.Equals(h.Title, ht, StringComparison.Ordinal));
            }
        }
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
            var title = NormalizeHeadingText(StripInlineMarkdown(m.Groups[2].Value));
            if (string.IsNullOrWhiteSpace(title)) continue;

            var id = slugger.Slug(title);
            list.Add(new HeadingRow(level, title, i, id));
        }

        return list;
    }

    /// <summary>
    /// 将标题行中的常见 inline markdown 语法剥离为“渲染后文本”，以便与前端 react-markdown 的 heading 文本一致。
    /// 目标：修复包含 **强调**、`code`、[link](url)、![img](url)、HTML 标签 等情况下 headingId 生成不一致的问题。
    /// </summary>
    private static string StripInlineMarkdown(string raw)
    {
        var s = raw ?? string.Empty;
        if (s.Length == 0) return string.Empty;

        // 图片/链接：保留可见文本
        s = Regex.Replace(s, @"!\[([^\]]*)\]\([^)]+\)", "$1");
        s = Regex.Replace(s, @"\[(.*?)\]\([^)]+\)", "$1");

        // inline code：去掉反引号
        s = Regex.Replace(s, @"`([^`]+)`", "$1");

        // 处理强调（多轮，覆盖简单嵌套）
        for (var i = 0; i < 2; i++)
        {
            s = Regex.Replace(s, @"\*\*([^*]+)\*\*", "$1");
            s = Regex.Replace(s, @"__([^_]+)__", "$1");
            s = Regex.Replace(s, @"\*([^*]+)\*", "$1");
            s = Regex.Replace(s, @"_([^_]+)_", "$1");
        }

        // HTML 标签
        s = Regex.Replace(s, @"<[^>]+>", string.Empty);

        // 去掉转义符（保留字符本身）
        s = Regex.Replace(s, @"\\([\\`*_{}\[\]()#+\-.!])", "$1");

        return s;
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

