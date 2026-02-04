using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Email;

/// <summary>
/// 邮件意图检测器
/// 基于用户配置的工作流 + 规则 + LLM 混合检测
/// </summary>
public class EmailIntentDetector : IEmailIntentDetector
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway? _llmGateway;
    private readonly ILogger<EmailIntentDetector> _logger;

    // 主题关键词触发配置（作为 fallback）
    private static readonly Dictionary<EmailIntentType, string[]> SubjectTriggers = new()
    {
        [EmailIntentType.Classify] = new[] { @"\[分类\]", @"\[归类\]", @"\[classify\]" },
        [EmailIntentType.CreateTodo] = new[] { @"\[待办\]", @"\[TODO\]", @"\[任务\]", @"请跟进", @"需要处理" },
        [EmailIntentType.Summarize] = new[] { @"\[摘要\]", @"\[summary\]", @"\[总结\]" },
        [EmailIntentType.FollowUp] = new[] { @"\[跟进\]", @"\[follow.?up\]", @"请回复", @"等待回复" }
    };

    public EmailIntentDetector(MongoDbContext db, ILogger<EmailIntentDetector> logger, ILlmGateway? llmGateway = null)
    {
        _db = db;
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

        // 1. 从数据库加载工作流配置
        var workflows = await _db.EmailWorkflows
            .Find(w => w.IsActive)
            .SortBy(w => w.Priority)
            .ToListAsync(ct);

        // 2. 用工作流配置匹配收件地址
        var workflowResult = DetectByWorkflows(addresses, workflows);
        if (workflowResult.Confidence > 0.9)
        {
            _logger.LogDebug(
                "Intent detected by workflow: {Type} ({Confidence:P0}) - {Reason}",
                workflowResult.Type, workflowResult.Confidence, workflowResult.Reason);
            return workflowResult;
        }

        // 3. 用规则匹配主题关键词（fallback）
        var ruleResult = DetectBySubjectRules(subject);
        if (ruleResult.Confidence > 0.8)
        {
            _logger.LogDebug(
                "Intent detected by subject rules: {Type} ({Confidence:P0})",
                ruleResult.Type, ruleResult.Confidence);
            return ruleResult;
        }

        // 4. 如果规则匹配度低且有 LLM，用 LLM 辅助判断
        if (_llmGateway != null && workflowResult.Confidence < 0.5 && ruleResult.Confidence < 0.5)
        {
            try
            {
                var llmResult = await DetectByLlmAsync(subject, body, ct);
                if (llmResult.Confidence > Math.Max(workflowResult.Confidence, ruleResult.Confidence))
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

        // 5. 返回置信度最高的结果
        var finalResult = workflowResult.Confidence > ruleResult.Confidence ? workflowResult : ruleResult;

        // 6. 提取参数
        ExtractParameters(subject, finalResult);

        return finalResult;
    }

    /// <summary>
    /// 基于用户配置的工作流匹配
    /// </summary>
    private EmailIntent DetectByWorkflows(List<string> toAddresses, List<EmailWorkflow> workflows)
    {
        foreach (var workflow in workflows)
        {
            // 检查收件地址是否匹配工作流前缀
            foreach (var addr in toAddresses)
            {
                if (string.IsNullOrEmpty(addr)) continue;

                // 提取 @ 前的部分
                var atIndex = addr.IndexOf('@');
                if (atIndex <= 0) continue;

                var prefix = addr[..atIndex].ToLowerInvariant();

                if (prefix == workflow.AddressPrefix.ToLowerInvariant())
                {
                    return new EmailIntent
                    {
                        Type = workflow.IntentType,
                        Confidence = 0.95, // 精确匹配工作流，高置信度
                        Reason = $"匹配工作流：{workflow.DisplayName}",
                        Parameters = new Dictionary<string, string>
                        {
                            ["workflowId"] = workflow.Id,
                            ["workflowName"] = workflow.DisplayName,
                            ["targetAgent"] = workflow.TargetAgent ?? ""
                        }
                    };
                }
            }
        }

        return new EmailIntent { Type = EmailIntentType.Unknown, Confidence = 0 };
    }

    /// <summary>
    /// 基于主题关键词规则匹配
    /// </summary>
    private EmailIntent DetectBySubjectRules(string subject)
    {
        var result = new EmailIntent { Type = EmailIntentType.Unknown, Confidence = 0 };

        foreach (var (intentType, patterns) in SubjectTriggers)
        {
            foreach (var pattern in patterns)
            {
                if (Regex.IsMatch(subject, pattern, RegexOptions.IgnoreCase))
                {
                    return new EmailIntent
                    {
                        Type = intentType,
                        Confidence = 0.85,
                        Reason = $"主题匹配关键词：{pattern}"
                    };
                }
            }
        }

        return result;
    }

    private async Task<EmailIntent> DetectByLlmAsync(string subject, string body, CancellationToken ct)
    {
        // 截取正文前500字符避免 token 过多
        var truncatedBody = body.Length > 500 ? body[..500] + "..." : body;

        var prompt = $$"""
            分析以下邮件，判断发件人的意图：

            主题：{{subject}}
            正文：{{truncatedBody}}

            请判断这封邮件属于以下哪种意图：
            1. classify - 需要对邮件内容进行分类归档
            2. createtodo - 包含待办事项或任务需要跟进
            3. summarize - 需要内容摘要
            4. followup - 需要跟进回复
            5. fyi - 仅供参考，无需处理
            6. unknown - 无法判断

            请用JSON格式回复：{"intent": "xxx", "confidence": 0.8, "reason": "判断依据"}
            只返回JSON，不要其他内容。
            """;

        // 这里应该调用 LLM Gateway
        // 为简化先返回默认值，实际实现时调用:
        // var response = await _llmGateway.SendAsync(new GatewayRequest { ... }, ct);

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
}
