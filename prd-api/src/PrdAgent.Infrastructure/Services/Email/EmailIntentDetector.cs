using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services.Email;

/// <summary>
/// 邮件意图检测器
/// 基于规则 + LLM 混合检测
/// </summary>
public class EmailIntentDetector : IEmailIntentDetector
{
    private readonly ILlmGateway? _llmGateway;
    private readonly ILogger<EmailIntentDetector> _logger;

    // 意图触发词配置
    private static readonly Dictionary<EmailIntentType, IntentTrigger> Triggers = new()
    {
        [EmailIntentType.Classify] = new IntentTrigger
        {
            AddressPatterns = new[] { "classify@", "分类@", "sort@" },
            SubjectPatterns = new[] { @"\[分类\]", @"\[归类\]", @"\[classify\]" }
        },
        [EmailIntentType.CreateTodo] = new IntentTrigger
        {
            AddressPatterns = new[] { "todo@", "待办@", "task@" },
            SubjectPatterns = new[] { @"\[待办\]", @"\[TODO\]", @"\[任务\]", @"请跟进", @"需要处理" }
        },
        [EmailIntentType.Summarize] = new IntentTrigger
        {
            AddressPatterns = new[] { "summary@", "摘要@" },
            SubjectPatterns = new[] { @"\[摘要\]", @"\[summary\]", @"\[总结\]" }
        },
        [EmailIntentType.FollowUp] = new IntentTrigger
        {
            AddressPatterns = new[] { "followup@", "跟进@" },
            SubjectPatterns = new[] { @"\[跟进\]", @"\[follow.?up\]", @"请回复", @"等待回复" }
        }
    };

    public EmailIntentDetector(ILogger<EmailIntentDetector> logger, ILlmGateway? llmGateway = null)
    {
        _logger = logger;
        _llmGateway = llmGateway;
    }

    public async Task<EmailIntent> DetectAsync(
        IEnumerable<string> toAddresses,
        string subject,
        string body,
        CancellationToken ct = default)
    {
        var addresses = toAddresses.ToList();

        // 1. 先用规则匹配（快速、确定性高）
        var ruleResult = DetectByRules(addresses, subject);
        if (ruleResult.Confidence > 0.8)
        {
            _logger.LogDebug("Intent detected by rules: {Type} ({Confidence:P0})", ruleResult.Type, ruleResult.Confidence);
            return ruleResult;
        }

        // 2. 如果规则匹配度低且有 LLM，用 LLM 辅助判断
        if (_llmGateway != null && ruleResult.Confidence < 0.5)
        {
            try
            {
                var llmResult = await DetectByLlmAsync(subject, body, ct);
                if (llmResult.Confidence > ruleResult.Confidence)
                {
                    _logger.LogDebug("Intent detected by LLM: {Type} ({Confidence:P0})", llmResult.Type, llmResult.Confidence);
                    return llmResult;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "LLM intent detection failed, falling back to rule result");
            }
        }

        // 3. 返回规则结果（可能是 Unknown）
        return ruleResult;
    }

    private EmailIntent DetectByRules(List<string> toAddresses, string subject)
    {
        var result = new EmailIntent { Type = EmailIntentType.Unknown, Confidence = 0 };

        foreach (var (intentType, trigger) in Triggers)
        {
            double confidence = 0;
            string? reason = null;

            // 检查收件地址
            foreach (var pattern in trigger.AddressPatterns)
            {
                if (toAddresses.Any(addr => addr.Contains(pattern, StringComparison.OrdinalIgnoreCase)))
                {
                    confidence = 0.95; // 地址匹配置信度很高
                    reason = $"收件地址包含 '{pattern}'";
                    break;
                }
            }

            // 检查主题（如果地址没匹配到）
            if (confidence < 0.9)
            {
                foreach (var pattern in trigger.SubjectPatterns)
                {
                    if (Regex.IsMatch(subject, pattern, RegexOptions.IgnoreCase))
                    {
                        confidence = Math.Max(confidence, 0.85);
                        reason = $"主题匹配 '{pattern}'";
                        break;
                    }
                }
            }

            if (confidence > result.Confidence)
            {
                result = new EmailIntent
                {
                    Type = intentType,
                    Confidence = confidence,
                    Reason = reason
                };
            }
        }

        // 如果没有明确匹配，尝试从主题中提取参数
        if (result.Type != EmailIntentType.Unknown)
        {
            ExtractParameters(subject, result);
        }

        return result;
    }

    private async Task<EmailIntent> DetectByLlmAsync(string subject, string body, CancellationToken ct)
    {
        // 截取正文前500字符避免 token 过多
        var truncatedBody = body.Length > 500 ? body[..500] + "..." : body;

        var prompt = $"""
            分析以下邮件，判断发件人的意图：

            主题：{subject}
            正文：{truncatedBody}

            请判断这封邮件属于以下哪种意图：
            1. classify - 需要对邮件内容进行分类归档
            2. todo - 包含待办事项或任务需要跟进
            3. summarize - 需要内容摘要
            4. followup - 需要跟进回复
            5. fyi - 仅供参考，无需处理
            6. unknown - 无法判断

            请用JSON格式回复：{{"intent": "xxx", "confidence": 0.8, "reason": "判断依据"}}
            只返回JSON，不要其他内容。
            """;

        // 这里应该调用 LLM Gateway，但为了简化先返回默认值
        // 实际实现时应该：
        // var response = await _llmGateway.SendAsync(new GatewayRequest { ... }, ct);
        // 解析 response.Content 中的 JSON

        await Task.CompletedTask;

        return new EmailIntent
        {
            Type = EmailIntentType.Unknown,
            Confidence = 0.3,
            Reason = "LLM fallback"
        };
    }

    private void ExtractParameters(string subject, EmailIntent intent)
    {
        // 提取截止日期
        var datePatterns = new[]
        {
            @"截止[：:]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})",
            @"deadline[：:]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})",
            @"(\d{1,2}月\d{1,2}日)前",
            @"(今天|明天|后天|下周[一二三四五六日])"
        };

        foreach (var pattern in datePatterns)
        {
            var match = Regex.Match(subject, pattern, RegexOptions.IgnoreCase);
            if (match.Success)
            {
                intent.Parameters["dueDate"] = match.Groups[1].Value;
                break;
            }
        }

        // 提取优先级
        if (Regex.IsMatch(subject, @"\[?紧急\]?|urgent|!{2,}", RegexOptions.IgnoreCase))
        {
            intent.Parameters["priority"] = "5";
        }
        else if (Regex.IsMatch(subject, @"\[?重要\]?|important", RegexOptions.IgnoreCase))
        {
            intent.Parameters["priority"] = "4";
        }
    }

    private record IntentTrigger
    {
        public string[] AddressPatterns { get; init; } = Array.Empty<string>();
        public string[] SubjectPatterns { get; init; } = Array.Empty<string>();
    }
}
