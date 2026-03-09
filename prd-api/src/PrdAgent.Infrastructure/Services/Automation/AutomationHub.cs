using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Automation;

/// <summary>
/// 自动化中枢实现：接收事件 → 匹配规则 → 分发动作 + 触发事件驱动工作流
/// </summary>
public class AutomationHub : IAutomationHub
{
    private readonly MongoDbContext _db;
    private readonly Dictionary<string, IActionExecutor> _executors;
    private readonly IRunQueue _runQueue;
    private readonly ILogger<AutomationHub> _logger;

    public AutomationHub(
        MongoDbContext db,
        IEnumerable<IActionExecutor> executors,
        IRunQueue runQueue,
        ILogger<AutomationHub> logger)
    {
        _db = db;
        _executors = executors.ToDictionary(e => e.ActionType, e => e);
        _runQueue = runQueue;
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

            // ── 1. 传统自动化规则 ──
            var rules = await FindMatchingRulesAsync(eventType);

            if (rules.Count > 0)
            {
                _logger.LogInformation(
                    "Event {EventType} matched {Count} automation rule(s)",
                    eventType, rules.Count);

                foreach (var rule in rules)
                {
                    try
                    {
                        var effectivePayload = ApplyTemplates(rule, payload);
                        await ExecuteActionsAsync(rule, effectivePayload);

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

            // ── 2. 事件驱动工作流 ──
            await TriggerEventWorkflowsAsync(eventType, payload);
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

    // ─────────────────────────────────────────────────────────
    // 事件驱动工作流集成
    // ─────────────────────────────────────────────────────────

    /// <summary>
    /// 查找包含匹配事件触发器的已启用工作流，为每个创建执行实例并入队。
    /// </summary>
    private async Task TriggerEventWorkflowsAsync(string eventType, AutomationEventPayload payload)
    {
        try
        {
            // 查找所有已启用的工作流
            var workflows = await _db.Workflows
                .Find(w => w.IsEnabled)
                .ToListAsync();

            var matched = new List<Workflow>();
            foreach (var wf in workflows)
            {
                // 检查是否有 event-trigger 节点且 eventType 匹配
                foreach (var node in wf.Nodes)
                {
                    if (node.NodeType != CapsuleTypes.EventTrigger) continue;

                    var nodeEventType = GetNodeConfigString(node, "eventType");
                    var customEventType = GetNodeConfigString(node, "customEventType");

                    // 优先使用自定义事件类型
                    var effectiveEventType = !string.IsNullOrWhiteSpace(customEventType) ? customEventType : nodeEventType;
                    if (string.IsNullOrWhiteSpace(effectiveEventType)) continue;

                    if (IsEventMatch(effectiveEventType, eventType))
                    {
                        matched.Add(wf);
                        break; // 一个工作流匹配一次即可
                    }
                }

                // 也检查 Trigger 配置中的 event 触发器（兼容旧模型）
                foreach (var trigger in wf.Triggers)
                {
                    if (trigger.Type != WorkflowTriggerTypes.Event) continue;
                    if (string.IsNullOrWhiteSpace(trigger.EventType)) continue;

                    if (IsEventMatch(trigger.EventType, eventType))
                    {
                        if (!matched.Contains(wf))
                            matched.Add(wf);
                        break;
                    }
                }
            }

            if (matched.Count == 0)
            {
                _logger.LogDebug("No event-triggered workflows matched for {EventType}", eventType);
                return;
            }

            _logger.LogInformation(
                "Event {EventType} matched {Count} workflow(s)",
                eventType, matched.Count);

            foreach (var wf in matched)
            {
                try
                {
                    await CreateAndEnqueueWorkflowExecutionAsync(wf, eventType, payload);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to trigger workflow {WorkflowId} for event {EventType}",
                        wf.Id, eventType);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TriggerEventWorkflowsAsync failed for {EventType}", eventType);
        }
    }

    /// <summary>
    /// 创建工作流执行实例，注入事件载荷变量，入队到 RunQueue。
    /// </summary>
    private async Task CreateAndEnqueueWorkflowExecutionAsync(
        Workflow workflow,
        string eventType,
        AutomationEventPayload payload)
    {
        // 构建执行变量：将事件数据注入为系统变量供 event-trigger 节点使用
        var variables = new Dictionary<string, string>();

        // 工作流定义的默认变量
        foreach (var v in workflow.Variables)
        {
            if (!string.IsNullOrEmpty(v.DefaultValue))
                variables[v.Key] = v.DefaultValue;
        }

        // 注入事件上下文（双下划线前缀为系统保留变量）
        variables["__eventType"] = eventType;
        variables["__eventTitle"] = payload.Title;
        variables["__eventContent"] = payload.Content;
        variables["__eventSourceId"] = payload.SourceId ?? "";

        // 注入事件自定义变量（带 __event_ 前缀，避免与用户变量冲突）
        if (payload.Variables != null)
        {
            foreach (var kvp in payload.Variables)
            {
                variables[$"__event_{kvp.Key}"] = kvp.Value;
            }
        }

        // 创建执行实例
        var execution = new WorkflowExecution
        {
            WorkflowId = workflow.Id,
            WorkflowName = workflow.Name,
            TriggerType = WorkflowTriggerTypes.Event,
            TriggeredBy = "system",
            TriggeredByName = $"事件: {eventType}",
            Variables = variables,
            NodeSnapshot = workflow.Nodes,
            EdgeSnapshot = workflow.Edges,
            NodeExecutions = workflow.Nodes.Select(n => new NodeExecution
            {
                NodeId = n.NodeId,
                NodeName = n.Name,
                NodeType = n.NodeType,
                Status = NodeExecutionStatus.Pending,
            }).ToList(),
        };

        await _db.WorkflowExecutions.InsertOneAsync(execution);

        // 更新工作流统计
        var wfUpdate = Builders<Workflow>.Update
            .Set(w => w.LastExecutedAt, DateTime.UtcNow)
            .Inc(w => w.ExecutionCount, 1);
        await _db.Workflows.UpdateOneAsync(w => w.Id == workflow.Id, wfUpdate);

        // 入队执行
        await _runQueue.EnqueueAsync(RunKinds.Workflow, execution.Id);

        _logger.LogInformation(
            "Event-triggered workflow execution created: {ExecutionId} for workflow {WorkflowName} ({WorkflowId}), event={EventType}",
            execution.Id, workflow.Name, workflow.Id, eventType);
    }

    /// <summary>
    /// 判断配置的事件类型模式是否匹配实际事件（支持通配符 *）
    /// </summary>
    private static bool IsEventMatch(string pattern, string actualEventType)
    {
        if (pattern == actualEventType) return true;

        // 通配符匹配：visual-agent.* 匹配 visual-agent.image-gen.completed
        if (pattern.EndsWith(".*"))
        {
            var prefix = pattern[..^1]; // remove trailing *
            return actualEventType.StartsWith(prefix, StringComparison.Ordinal);
        }

        return false;
    }

    /// <summary>
    /// 从节点配置中获取字符串值
    /// </summary>
    private static string? GetNodeConfigString(WorkflowNode node, string key)
    {
        if (!node.Config.TryGetValue(key, out var value) || value == null)
            return null;
        return value.ToString();
    }
}
