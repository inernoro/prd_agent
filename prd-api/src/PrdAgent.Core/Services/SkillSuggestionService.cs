using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// MVP 版技能候选抽取：
/// - 仅基于最新一轮 user/assistant 对话做规则化识别
/// - 达到阈值才返回建议，避免噪声提示
/// </summary>
public class SkillSuggestionService : ISkillSuggestionService
{
    private static readonly string[] RepeatKeywords =
    {
        "每次", "以后", "固定", "重复", "复用", "模板", "流程", "规范", "标准", "批量"
    };

    private static readonly string[] StructureKeywords =
    {
        "步骤", "清单", "表格", "json", "markdown", "字段", "格式", "结构化", "输出"
    };

    private static readonly Regex HeadingRegex = new(@"(?m)^#{1,4}\s+\S+", RegexOptions.Compiled);
    private static readonly Regex ListRegex = new(@"(?m)^\s*([-*]|\d+\.)\s+\S+", RegexOptions.Compiled);
    private static readonly Regex TableRegex = new(@"(?m)^\|.+\|$", RegexOptions.Compiled);
    private static readonly Regex JsonFenceRegex = new(@"```(?:json|yaml|yml)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex SkillExecutionPrefixRegex = new(@"^【[^】]{1,40}】", RegexOptions.Compiled);
    private static readonly Regex SpaceRegex = new(@"\s+", RegexOptions.Compiled);
    private static readonly Regex PunctTrimRegex = new(@"^[\s`~!@#$%^&*()_+\-=\[\]{};:'"",.<>/?\\|]+|[\s`~!@#$%^&*()_+\-=\[\]{};:'"",.<>/?\\|]+$", RegexOptions.Compiled);

    private readonly IMessageRepository _messageRepository;
    private readonly ISkillService _skillService;

    public SkillSuggestionService(
        IMessageRepository messageRepository,
        ISkillService skillService)
    {
        _messageRepository = messageRepository;
        _skillService = skillService;
    }

    public async Task<SkillSuggestion?> GetLatestSuggestionAsync(
        string sessionId,
        string userId,
        string? assistantMessageId = null,
        CancellationToken ct = default)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        var uid = (userId ?? string.Empty).Trim();
        var targetAssistantId = (assistantMessageId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid) || string.IsNullOrWhiteSpace(uid))
        {
            return null;
        }

        var recent = await _messageRepository.FindBySessionAsync(sid, before: null, limit: 30);
        if (recent.Count == 0) return null;

        var assistant = ResolveAssistantMessage(recent, targetAssistantId);
        if (assistant == null) return null;
        if (IsLikelyErrorMessage(assistant.Content)) return null;

        var userMessage = await ResolveUserMessageAsync(recent, assistant);
        if (userMessage == null) return null;

        var userText = (userMessage.Content ?? string.Empty).Trim();
        var assistantText = (assistant.Content ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(userText) || string.IsNullOrWhiteSpace(assistantText))
        {
            return null;
        }

        // 技能执行回放（例如【技能名】...）不再二次沉淀，避免建议噪声。
        if (SkillExecutionPrefixRegex.IsMatch(userText))
        {
            return null;
        }

        var score = ComputeSkillabilityScore(userText, assistantText);
        if (score < 0.58d)
        {
            return null;
        }

        var title = BuildTitle(userText);
        if (string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        var normalizedTitle = NormalizeText(title);
        var visibleSkills = await _skillService.GetVisibleSkillsAsync(uid, roleFilter: null, ct);
        var duplicated = visibleSkills.Any(s =>
            s.Visibility == SkillVisibility.Personal &&
            string.Equals((s.OwnerUserId ?? string.Empty).Trim(), uid, StringComparison.Ordinal) &&
            string.Equals(NormalizeText(s.Title), normalizedTitle, StringComparison.Ordinal));

        if (duplicated)
        {
            return null;
        }

        var tags = BuildTags(userText, assistantText);
        var description = BuildDescription(userText);
        var suggestionId = BuildSuggestionId(sid, userMessage.Id, assistant.Id, title);

        return new SkillSuggestion
        {
            SuggestionId = suggestionId,
            SessionId = sid,
            SourceUserMessageId = userMessage.Id,
            SourceAssistantMessageId = assistant.Id,
            Title = title,
            Description = description,
            Reason = BuildReason(userText, assistantText),
            Confidence = Math.Round(score, 2, MidpointRounding.AwayFromZero),
            Tags = tags,
            Draft = new SkillSuggestionDraft
            {
                Title = title,
                Description = description,
                Category = InferCategory(userText),
                Tags = tags,
                Input = new SkillInputConfig
                {
                    ContextScope = "prd",
                    AcceptsUserInput = true,
                    UserInputPlaceholder = "可补充本次执行变量（可选）",
                    AcceptsAttachments = false,
                    Parameters = new List<SkillParameter>()
                },
                Execution = new SkillExecutionConfig
                {
                    PromptTemplate = BuildPromptTemplate(userText),
                    ModelType = "chat",
                    SystemPromptOverride = null
                },
                Output = new SkillOutputConfig
                {
                    Mode = "chat",
                    EchoToChat = false
                }
            }
        };
    }

    private static Message? ResolveAssistantMessage(List<Message> recent, string assistantMessageId)
    {
        if (!string.IsNullOrWhiteSpace(assistantMessageId))
        {
            return recent
                .LastOrDefault(m =>
                    m.Role == MessageRole.Assistant &&
                    !m.IsDeleted &&
                    m.Id == assistantMessageId &&
                    !string.IsNullOrWhiteSpace(m.Content));
        }

        return recent
            .LastOrDefault(m =>
                m.Role == MessageRole.Assistant &&
                !m.IsDeleted &&
                !string.IsNullOrWhiteSpace(m.Content));
    }

    private async Task<Message?> ResolveUserMessageAsync(List<Message> recent, Message assistant)
    {
        if (!string.IsNullOrWhiteSpace(assistant.ReplyToMessageId))
        {
            var fromRecent = recent.LastOrDefault(m => m.Id == assistant.ReplyToMessageId && m.Role == MessageRole.User && !m.IsDeleted);
            if (fromRecent != null) return fromRecent;

            var fromDb = await _messageRepository.FindByIdAsync(assistant.ReplyToMessageId);
            if (fromDb != null && !fromDb.IsDeleted && fromDb.Role == MessageRole.User)
            {
                return fromDb;
            }
        }

        return recent
            .Where(m => !m.IsDeleted && m.Role == MessageRole.User && m.Timestamp <= assistant.Timestamp)
            .OrderByDescending(m => m.Timestamp)
            .FirstOrDefault();
    }

    private static bool IsLikelyErrorMessage(string content)
    {
        var text = (content ?? string.Empty).Trim();
        if (text.Length == 0) return true;
        return text.StartsWith("请求失败：", StringComparison.Ordinal) ||
               text.StartsWith("LLM调用失败", StringComparison.Ordinal) ||
               text.StartsWith("服务器内部错误", StringComparison.Ordinal);
    }

    private static double ComputeSkillabilityScore(string userText, string assistantText)
    {
        var score = 0d;
        var normalizedUser = userText.ToLowerInvariant();
        var normalizedAssistant = assistantText.ToLowerInvariant();

        if (normalizedUser.Length >= 18) score += 0.2d;
        if (ContainsAny(normalizedUser, RepeatKeywords)) score += 0.24d;
        if (ContainsAny(normalizedUser, StructureKeywords)) score += 0.2d;
        if (HasStructuredOutput(normalizedAssistant)) score += 0.24d;

        // 明确的动作词，表示这是“可执行任务”而不是闲聊。
        if (ContainsAny(normalizedUser, new[] { "生成", "整理", "提取", "拆解", "归纳", "输出", "编写", "分析" }))
        {
            score += 0.12d;
        }

        return Math.Min(1d, score);
    }

    private static bool HasStructuredOutput(string assistantText)
    {
        return HeadingRegex.IsMatch(assistantText) ||
               ListRegex.IsMatch(assistantText) ||
               TableRegex.IsMatch(assistantText) ||
               JsonFenceRegex.IsMatch(assistantText);
    }

    private static bool ContainsAny(string text, IEnumerable<string> candidates)
    {
        foreach (var keyword in candidates)
        {
            if (text.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static string BuildTitle(string userText)
    {
        var normalized = NormalizeSentence(userText);
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return "自动沉淀技能";
        }

        var stripped = normalized
            .Replace("请你", string.Empty, StringComparison.Ordinal)
            .Replace("请", string.Empty, StringComparison.Ordinal)
            .Replace("帮我", string.Empty, StringComparison.Ordinal)
            .Replace("帮忙", string.Empty, StringComparison.Ordinal)
            .Trim();

        if (stripped.Length > 20)
        {
            stripped = stripped[..20].Trim();
        }

        stripped = PunctTrimRegex.Replace(stripped, string.Empty).Trim();
        return string.IsNullOrWhiteSpace(stripped) ? "自动沉淀技能" : stripped;
    }

    private static string BuildDescription(string userText)
    {
        var normalized = NormalizeSentence(userText);
        if (normalized.Length > 72)
        {
            normalized = normalized[..72].Trim() + "...";
        }
        return string.IsNullOrWhiteSpace(normalized)
            ? "由对话自动沉淀的可复用技能"
            : $"由对话自动沉淀：{normalized}";
    }

    private static string BuildReason(string userText, string assistantText)
    {
        var reasons = new List<string>();
        var lowerUser = userText.ToLowerInvariant();

        if (ContainsAny(lowerUser, RepeatKeywords))
        {
            reasons.Add("检测到重复/模板化表达");
        }
        if (ContainsAny(lowerUser, StructureKeywords))
        {
            reasons.Add("检测到结构化输出约束");
        }
        if (HasStructuredOutput(assistantText))
        {
            reasons.Add("本轮回复已形成稳定输出结构");
        }

        if (reasons.Count == 0)
        {
            reasons.Add("当前对话具备可复用任务特征");
        }

        return string.Join("；", reasons);
    }

    private static List<string> BuildTags(string userText, string assistantText)
    {
        var tags = new List<string>();
        var text = $"{userText}\n{assistantText}".ToLowerInvariant();

        void AddIf(bool condition, string tag)
        {
            if (!condition) return;
            if (tags.Contains(tag, StringComparer.Ordinal)) return;
            tags.Add(tag);
        }

        AddIf(text.Contains("prd", StringComparison.OrdinalIgnoreCase), "prd");
        AddIf(text.Contains("任务"), "task");
        AddIf(text.Contains("测试"), "qa");
        AddIf(text.Contains("开发"), "dev");
        AddIf(text.Contains("风险"), "risk");
        AddIf(text.Contains("清单"), "checklist");
        AddIf(text.Contains("模板"), "template");
        AddIf(text.Contains("总结"), "summary");
        AddIf(HasStructuredOutput(assistantText), "structured");

        if (tags.Count == 0) tags.Add("general");
        return tags.Take(6).ToList();
    }

    private static string InferCategory(string userText)
    {
        var text = userText.ToLowerInvariant();
        if (text.Contains("总结")) return "summary";
        if (text.Contains("提取")) return "extraction";
        if (text.Contains("检查") || text.Contains("校验")) return "check";
        if (text.Contains("优化")) return "optimization";
        if (text.Contains("生成")) return "generation";
        if (text.Contains("分析") || text.Contains("拆解")) return "analysis";
        return "general";
    }

    private static string BuildPromptTemplate(string userText)
    {
        var instruction = NormalizeSentence(userText);
        if (instruction.Length > 260)
        {
            instruction = instruction[..260].Trim() + "...";
        }

        return
            "你是 PRD Agent 技能执行助手，请严格完成以下任务。\n\n" +
            "任务指令：\n" +
            instruction + "\n\n" +
            "用户补充输入（可为空）：\n" +
            "{{userInput}}\n\n" +
            "执行要求：\n" +
            "1. 优先基于当前会话的 PRD 上下文；\n" +
            "2. 结果必须结构清晰、可执行；\n" +
            "3. 若信息不足，请明确写出“需补充”。";
    }

    private static string BuildSuggestionId(string sessionId, string userMessageId, string assistantMessageId, string title)
    {
        var material = $"{sessionId}|{userMessageId}|{assistantMessageId}|{NormalizeText(title)}";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return $"sugg-{Convert.ToHexString(bytes)[..16].ToLowerInvariant()}";
    }

    private static string NormalizeSentence(string text)
    {
        var s = (text ?? string.Empty).Trim();
        s = SpaceRegex.Replace(s, " ");
        return s;
    }

    private static string NormalizeText(string text)
    {
        var s = NormalizeSentence(text).ToLowerInvariant();
        return PunctTrimRegex.Replace(s, string.Empty).Trim();
    }
}
