using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 自动化规则控制器
/// </summary>
[ApiController]
[Route("api/automations")]
[Authorize]
[AdminController("automations", AdminPermissionCatalog.AutomationsManage)]
public class AutomationRulesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAutomationHub _automationHub;
    private readonly IUserService _userService;
    private readonly ILogger<AutomationRulesController> _logger;

    public AutomationRulesController(
        MongoDbContext db,
        IAutomationHub automationHub,
        IUserService userService,
        ILogger<AutomationRulesController> logger)
    {
        _db = db;
        _automationHub = automationHub;
        _userService = userService;
        _logger = logger;
    }

    private string? GetUserId() => User.FindFirst("userId")?.Value ?? User.FindFirst("sub")?.Value;

    // ========== 规则 CRUD ==========

    /// <summary>
    /// 获取规则列表
    /// </summary>
    [HttpGet("rules")]
    [ProducesResponseType(typeof(ApiResponse<PagedRulesResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListRules(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? eventType = null,
        [FromQuery] bool? enabled = null)
    {
        if (page <= 0) page = 1;
        if (pageSize <= 0 || pageSize > 100) pageSize = 20;

        var filter = Builders<AutomationRule>.Filter.Empty;

        if (!string.IsNullOrWhiteSpace(eventType))
            filter &= Builders<AutomationRule>.Filter.Eq(r => r.EventType, eventType);

        if (enabled.HasValue)
            filter &= Builders<AutomationRule>.Filter.Eq(r => r.Enabled, enabled.Value);

        var total = await _db.AutomationRules.CountDocumentsAsync(filter);
        var rules = await _db.AutomationRules
            .Find(filter)
            .SortByDescending(r => r.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        var items = new List<RuleListItem>();
        foreach (var rule in rules)
        {
            var user = await _userService.GetByIdAsync(rule.CreatedBy);
            items.Add(new RuleListItem
            {
                Id = rule.Id,
                Name = rule.Name,
                Enabled = rule.Enabled,
                EventType = rule.EventType,
                Actions = rule.Actions.Select(a => new ActionSummary
                {
                    Type = a.Type,
                    WebhookUrl = a.WebhookUrl,
                    NotifyUserCount = a.NotifyUserIds?.Count ?? 0,
                    NotifyLevel = a.NotifyLevel
                }).ToList(),
                TitleTemplate = rule.TitleTemplate,
                ContentTemplate = rule.ContentTemplate,
                CreatedBy = rule.CreatedBy,
                CreatedByName = user?.DisplayName ?? user?.Username ?? "Unknown",
                CreatedAt = rule.CreatedAt,
                UpdatedAt = rule.UpdatedAt,
                LastTriggeredAt = rule.LastTriggeredAt,
                TriggerCount = rule.TriggerCount
            });
        }

        return Ok(ApiResponse<PagedRulesResponse>.Ok(new PagedRulesResponse
        {
            Items = items,
            Total = total,
            Page = page,
            PageSize = pageSize
        }));
    }

    /// <summary>
    /// 获取单个规则详情
    /// </summary>
    [HttpGet("rules/{id}")]
    public async Task<IActionResult> GetRule(string id)
    {
        var rule = await _db.AutomationRules.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (rule == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "规则不存在"));

        return Ok(ApiResponse<AutomationRule>.Ok(rule));
    }

    /// <summary>
    /// 创建规则
    /// </summary>
    [HttpPost("rules")]
    [ProducesResponseType(typeof(ApiResponse<AutomationRule>), StatusCodes.Status201Created)]
    public async Task<IActionResult> CreateRule([FromBody] CreateRuleRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "规则名称不能为空"));
        if (string.IsNullOrWhiteSpace(request.EventType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "事件类型不能为空"));
        if (request.Actions == null || request.Actions.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少需要一个动作"));

        // 验证动作
        foreach (var action in request.Actions)
        {
            if (action.Type == "webhook" && string.IsNullOrWhiteSpace(action.WebhookUrl))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "Webhook 动作需要配置 URL"));
            if (action.Type == "webhook" && action.WebhookUrl != null && !action.WebhookUrl.StartsWith("https://"))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "Webhook URL 必须以 https:// 开头"));
        }

        var rule = new AutomationRule
        {
            Name = request.Name,
            Enabled = request.Enabled,
            EventType = request.EventType,
            Actions = request.Actions,
            TitleTemplate = request.TitleTemplate,
            ContentTemplate = request.ContentTemplate,
            CreatedBy = GetUserId() ?? ""
        };

        await _db.AutomationRules.InsertOneAsync(rule);

        return CreatedAtAction(nameof(GetRule), new { id = rule.Id }, ApiResponse<AutomationRule>.Ok(rule));
    }

    /// <summary>
    /// 更新规则
    /// </summary>
    [HttpPut("rules/{id}")]
    public async Task<IActionResult> UpdateRule(string id, [FromBody] UpdateRuleRequest request)
    {
        var rule = await _db.AutomationRules.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (rule == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "规则不存在"));

        var update = Builders<AutomationRule>.Update
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        if (request.Name != null)
            update = update.Set(r => r.Name, request.Name);
        if (request.Enabled.HasValue)
            update = update.Set(r => r.Enabled, request.Enabled.Value);
        if (request.EventType != null)
            update = update.Set(r => r.EventType, request.EventType);
        if (request.Actions != null)
            update = update.Set(r => r.Actions, request.Actions);
        if (request.TitleTemplate != null)
            update = update.Set(r => r.TitleTemplate, request.TitleTemplate == "" ? null : request.TitleTemplate);
        if (request.ContentTemplate != null)
            update = update.Set(r => r.ContentTemplate, request.ContentTemplate == "" ? null : request.ContentTemplate);

        await _db.AutomationRules.UpdateOneAsync(r => r.Id == id, update);

        return Ok(ApiResponse<object>.Ok(new { message = "规则已更新" }));
    }

    /// <summary>
    /// 删除规则
    /// </summary>
    [HttpDelete("rules/{id}")]
    public async Task<IActionResult> DeleteRule(string id)
    {
        var result = await _db.AutomationRules.DeleteOneAsync(r => r.Id == id);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "规则不存在"));

        return Ok(ApiResponse<object>.Ok(new { message = "规则已删除" }));
    }

    /// <summary>
    /// 切换规则启用/禁用
    /// </summary>
    [HttpPost("rules/{id}/toggle")]
    public async Task<IActionResult> ToggleRule(string id)
    {
        var rule = await _db.AutomationRules.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (rule == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "规则不存在"));

        var update = Builders<AutomationRule>.Update
            .Set(r => r.Enabled, !rule.Enabled)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        await _db.AutomationRules.UpdateOneAsync(r => r.Id == id, update);

        return Ok(ApiResponse<object>.Ok(new { enabled = !rule.Enabled }));
    }

    /// <summary>
    /// 手动触发规则（测试用）
    /// </summary>
    [HttpPost("rules/{id}/trigger")]
    public async Task<IActionResult> TriggerRule(string id, [FromBody] TriggerRuleRequest request)
    {
        var payload = new AutomationEventPayload
        {
            EventType = request.EventType ?? "test.manual",
            Title = request.Title ?? "手动触发测试",
            Content = request.Content ?? "这是一条手动触发的测试通知",
            Values = request.Values
        };

        var result = await _automationHub.TriggerRuleAsync(id, payload);

        return Ok(ApiResponse<AutomationTriggerResult>.Ok(result));
    }

    // ========== 事件类型注册表 ==========

    /// <summary>
    /// 获取预定义的事件类型列表
    /// </summary>
    [HttpGet("event-types")]
    public IActionResult GetEventTypes()
    {
        return Ok(ApiResponse<object>.Ok(new { items = AutomationEventTypes.All }));
    }

    // ========== 动作类型注册表 ==========

    /// <summary>
    /// 获取支持的动作类型
    /// </summary>
    [HttpGet("action-types")]
    public IActionResult GetActionTypes()
    {
        var types = new List<object>
        {
            new { type = "webhook", label = "Webhook", description = "HTTP POST 到外部 URL" },
            new { type = "admin_notification", label = "站内信", description = "发送站内通知给指定用户" }
        };

        return Ok(ApiResponse<object>.Ok(new { items = types }));
    }
}

#region Request/Response Models

public class CreateRuleRequest
{
    public string Name { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public string EventType { get; set; } = string.Empty;
    public List<AutomationAction> Actions { get; set; } = new();
    public string? TitleTemplate { get; set; }
    public string? ContentTemplate { get; set; }
}

public class UpdateRuleRequest
{
    public string? Name { get; set; }
    public bool? Enabled { get; set; }
    public string? EventType { get; set; }
    public List<AutomationAction>? Actions { get; set; }
    public string? TitleTemplate { get; set; }
    public string? ContentTemplate { get; set; }
}

public class TriggerRuleRequest
{
    public string? EventType { get; set; }
    public string? Title { get; set; }
    public string? Content { get; set; }
    public List<string>? Values { get; set; }
}

public class RuleListItem
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public bool Enabled { get; set; }
    public string EventType { get; set; } = string.Empty;
    public List<ActionSummary> Actions { get; set; } = new();
    public string? TitleTemplate { get; set; }
    public string? ContentTemplate { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
    public string CreatedByName { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? LastTriggeredAt { get; set; }
    public long TriggerCount { get; set; }
}

public class ActionSummary
{
    public string Type { get; set; } = string.Empty;
    public string? WebhookUrl { get; set; }
    public int NotifyUserCount { get; set; }
    public string? NotifyLevel { get; set; }
}

public class PagedRulesResponse
{
    public List<RuleListItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

#endregion
