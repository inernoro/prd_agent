using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Automation;

/// <summary>
/// 自动化中枢实现：接收事件 → 匹配规则 → 分发动作
/// </summary>
public class AutomationHub : IAutomationHub
{
    private readonly MongoDbContext _db;
    private readonly Dictionary<string, IActionExecutor> _executors;
    private readonly ILogger<AutomationHub> _logger;

    public AutomationHub(
        MongoDbContext db,
        IEnumerable<IActionExecutor> executors,
        ILogger<AutomationHub> logger)
    {
        _db = db;
        _executors = executors.ToDictionary(e => e.ActionType, e => e);
        _logger = logger;
    }

    public async Task PublishEventAsync(
        string eventType,
        string title,
        string content,
        List<string>? values = null,
        Dictionary<string, string>? variables = null,
        string? sourceId = null)
    {
        try
        {
            var payload = new AutomationEventPayload
            {
                EventType = eventType,
                Title = title,
                Content = ResolveContent(content, values),
                Values = values,
                Variables = variables,
                SourceId = sourceId
            };

            // 查找匹配的规则
            var rules = await FindMatchingRulesAsync(eventType);

            if (rules.Count == 0)
            {
                _logger.LogDebug("No automation rules matched for event {EventType}", eventType);
                return;
            }

            _logger.LogInformation(
                "Event {EventType} matched {Count} automation rule(s)",
                eventType, rules.Count);

            foreach (var rule in rules)
            {
                try
                {
                    // 应用模板覆盖
                    var effectivePayload = ApplyTemplates(rule, payload);

                    await ExecuteActionsAsync(rule, effectivePayload);

                    // 更新触发统计
                    var update = Builders<AutomationRule>.Update
                        .Set(r => r.LastTriggeredAt, DateTime.UtcNow)
                        .Inc(r => r.TriggerCount, 1);
                    await _db.AutomationRules.UpdateOneAsync(r => r.Id == rule.Id, update);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to execute rule {RuleId} for event {EventType}",
                        rule.Id, eventType);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AutomationHub.PublishEventAsync failed for {EventType}", eventType);
        }
    }

    public async Task<AutomationTriggerResult> TriggerRuleAsync(string ruleId, AutomationEventPayload payload)
    {
        var rule = await _db.AutomationRules
            .Find(r => r.Id == ruleId)
            .FirstOrDefaultAsync();

        if (rule == null)
        {
            return new AutomationTriggerResult
            {
                RuleId = ruleId,
                RuleName = "(not found)",
                ActionResults = new List<ActionExecuteResult>
                {
                    new() { Success = false, ErrorMessage = "Rule not found" }
                }
            };
        }

        // 解析内容
        payload.Content = ResolveContent(payload.Content, payload.Values);
        var effectivePayload = ApplyTemplates(rule, payload);

        var results = await ExecuteActionsAsync(rule, effectivePayload);

        return new AutomationTriggerResult
        {
            RuleId = rule.Id,
            RuleName = rule.Name,
            ActionResults = results
        };
    }

    /// <summary>
    /// 查找所有匹配事件类型的启用规则
    /// </summary>
    private async Task<List<AutomationRule>> FindMatchingRulesAsync(string eventType)
    {
        // 先查精确匹配
        var filter = Builders<AutomationRule>.Filter.And(
            Builders<AutomationRule>.Filter.Eq(r => r.Enabled, true),
            Builders<AutomationRule>.Filter.Eq(r => r.EventType, eventType)
        );

        var rules = await _db.AutomationRules.Find(filter).ToListAsync();

        // 再查通配符匹配（如 open-platform.* 匹配 open-platform.quota.warning）
        var wildcardFilter = Builders<AutomationRule>.Filter.And(
            Builders<AutomationRule>.Filter.Eq(r => r.Enabled, true),
            Builders<AutomationRule>.Filter.Regex(r => r.EventType, @"\.\*$")
        );

        var wildcardRules = await _db.AutomationRules.Find(wildcardFilter).ToListAsync();

        foreach (var wr in wildcardRules)
        {
            var prefix = wr.EventType[..^1]; // remove trailing *
            if (eventType.StartsWith(prefix, StringComparison.Ordinal))
            {
                rules.Add(wr);
            }
        }

        return rules;
    }

    /// <summary>
    /// 执行规则的动作链
    /// </summary>
    private async Task<List<ActionExecuteResult>> ExecuteActionsAsync(
        AutomationRule rule,
        AutomationEventPayload payload)
    {
        var results = new List<ActionExecuteResult>();

        foreach (var action in rule.Actions)
        {
            if (!_executors.TryGetValue(action.Type, out var executor))
            {
                _logger.LogWarning("No executor registered for action type {ActionType}", action.Type);
                results.Add(new ActionExecuteResult
                {
                    Success = false,
                    ErrorMessage = $"Unknown action type: {action.Type}"
                });
                continue;
            }

            try
            {
                var result = await executor.ExecuteAsync(rule, action, payload);
                results.Add(result);

                _logger.LogInformation(
                    "Action {ActionType} for rule {RuleId}: {Status}",
                    action.Type, rule.Id, result.Success ? "Success" : result.ErrorMessage);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Action {ActionType} failed for rule {RuleId}", action.Type, rule.Id);
                results.Add(new ActionExecuteResult
                {
                    Success = false,
                    ErrorMessage = ex.Message
                });
            }
        }

        return results;
    }

    /// <summary>
    /// 应用规则的模板覆盖
    /// </summary>
    private static AutomationEventPayload ApplyTemplates(AutomationRule rule, AutomationEventPayload original)
    {
        var payload = new AutomationEventPayload
        {
            EventType = original.EventType,
            Title = original.Title,
            Content = original.Content,
            Values = original.Values,
            Variables = original.Variables,
            SourceId = original.SourceId
        };

        if (!string.IsNullOrWhiteSpace(rule.TitleTemplate))
        {
            payload.Title = ReplaceVariables(rule.TitleTemplate, original);
        }

        if (!string.IsNullOrWhiteSpace(rule.ContentTemplate))
        {
            payload.Content = ResolveContent(
                ReplaceVariables(rule.ContentTemplate, original),
                original.Values);
        }

        return payload;
    }

    /// <summary>
    /// 替换模板中的 {{key}} 变量
    /// </summary>
    private static string ReplaceVariables(string template, AutomationEventPayload payload)
    {
        var result = template
            .Replace("{{title}}", payload.Title)
            .Replace("{{eventType}}", payload.EventType)
            .Replace("{{sourceId}}", payload.SourceId ?? "");

        if (payload.Variables != null)
        {
            foreach (var kvp in payload.Variables)
            {
                result = result.Replace($"{{{{{kvp.Key}}}}}", kvp.Value);
            }
        }

        return result;
    }

    /// <summary>
    /// 替换 {{value}} 占位符
    /// </summary>
    private static string ResolveContent(string content, List<string>? values)
    {
        if (string.IsNullOrEmpty(content) || values == null || values.Count == 0)
            return content;

        var result = content;
        foreach (var value in values)
        {
            var idx = result.IndexOf("{{value}}", StringComparison.Ordinal);
            if (idx < 0) break;
            result = result[..idx] + value + result[(idx + "{{value}}".Length)..];
        }
        return result;
    }
}
