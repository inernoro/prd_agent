using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 自动化中枢：接收事件，匹配规则，分发到各动作执行器
/// </summary>
public interface IAutomationHub
{
    /// <summary>
    /// 发布事件。中枢会查找所有匹配的规则并执行动作链。
    /// </summary>
    Task PublishEventAsync(
        string eventType,
        string title,
        string content,
        List<string>? values = null,
        Dictionary<string, string>? variables = null,
        string? sourceId = null);

    /// <summary>
    /// 手动触发指定规则（用于测试）
    /// </summary>
    Task<AutomationTriggerResult> TriggerRuleAsync(string ruleId, AutomationEventPayload payload);
}

/// <summary>
/// 动作执行器接口（可插拔）
/// </summary>
public interface IActionExecutor
{
    /// <summary>支持的动作类型标识</summary>
    string ActionType { get; }

    /// <summary>执行动作</summary>
    Task<ActionExecuteResult> ExecuteAsync(
        AutomationRule rule,
        AutomationAction action,
        AutomationEventPayload payload);
}

/// <summary>
/// 动作执行结果
/// </summary>
public class ActionExecuteResult
{
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
    public Dictionary<string, object>? Details { get; set; }
}

/// <summary>
/// 规则触发结果
/// </summary>
public class AutomationTriggerResult
{
    public string RuleId { get; set; } = string.Empty;
    public string RuleName { get; set; } = string.Empty;
    public List<ActionExecuteResult> ActionResults { get; set; } = new();
    public bool AllSucceeded => ActionResults.All(r => r.Success);
}
