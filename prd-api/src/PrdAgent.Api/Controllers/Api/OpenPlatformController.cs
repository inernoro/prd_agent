using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 开放平台控制器
/// </summary>
[ApiController]
[Route("api/open-platform")]
[Authorize]
[AdminController("open-platform", AdminPermissionCatalog.OpenPlatformManage)]
public class OpenPlatformController : ControllerBase
{
    private readonly IOpenPlatformService _openPlatformService;
    private readonly IWebhookNotificationService _webhookService;
    private readonly IUserService _userService;
    private readonly IGroupService _groupService;
    private readonly ILogger<OpenPlatformController> _logger;

    public OpenPlatformController(
        IOpenPlatformService openPlatformService,
        IWebhookNotificationService webhookService,
        IUserService userService,
        IGroupService groupService,
        ILogger<OpenPlatformController> logger)
    {
        _openPlatformService = openPlatformService;
        _webhookService = webhookService;
        _userService = userService;
        _groupService = groupService;
        _logger = logger;
    }

    /// <summary>
    /// 获取应用列表（分页）
    /// </summary>
    [HttpGet("apps")]
    [ProducesResponseType(typeof(ApiResponse<PagedAppsResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetApps(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? search = null)
    {
        if (page <= 0) page = 1;
        if (pageSize <= 0 || pageSize > 100) pageSize = 20;

        var (apps, total) = await _openPlatformService.GetAppsAsync(page, pageSize, search);

        var items = new List<AppListItem>();
        foreach (var app in apps)
        {
            var user = await _userService.GetByIdAsync(app.BoundUserId);
            Group? group = null;
            if (!string.IsNullOrWhiteSpace(app.BoundGroupId))
            {
                group = await _groupService.GetByIdAsync(app.BoundGroupId);
            }

            items.Add(new AppListItem
            {
                Id = app.Id,
                AppName = app.AppName,
                Description = app.Description,
                BoundUserId = app.BoundUserId,
                BoundUserName = user?.DisplayName ?? user?.Username ?? "Unknown",
                BoundGroupId = app.BoundGroupId,
                BoundGroupName = group?.GroupName,
                IgnoreUserSystemPrompt = app.IgnoreUserSystemPrompt,
                DisableGroupContext = app.DisableGroupContext,
                ConversationSystemPrompt = app.ConversationSystemPrompt,
                IsActive = app.IsActive,
                CreatedAt = app.CreatedAt,
                LastUsedAt = app.LastUsedAt,
                TotalRequests = app.TotalRequests,
                ApiKeyMasked = $"sk-***{app.ApiKeyHash[^8..]}",
                WebhookEnabled = app.WebhookEnabled,
                WebhookUrl = app.WebhookUrl,
                TokenQuotaLimit = app.TokenQuotaLimit,
                TokensUsed = app.TokensUsed,
                QuotaWarningThreshold = app.QuotaWarningThreshold
            });
        }

        var response = new PagedAppsResponse
        {
            Items = items,
            Total = total,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<PagedAppsResponse>.Ok(response));
    }

    /// <summary>
    /// 创建应用
    /// </summary>
    [HttpPost("apps")]
    [ProducesResponseType(typeof(ApiResponse<CreateAppResponse>), StatusCodes.Status201Created)]
    public async Task<IActionResult> CreateApp([FromBody] CreateAppRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.AppName))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用名称不能为空"));
        }

        if (string.IsNullOrWhiteSpace(request.BoundUserId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "必须绑定用户"));
        }

        // 验证用户存在
        var user = await _userService.GetByIdAsync(request.BoundUserId);
        if (user == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "绑定的用户不存在"));
        }

        // 验证群组存在（如果指定）
        if (!string.IsNullOrWhiteSpace(request.BoundGroupId))
        {
            var group = await _groupService.GetByIdAsync(request.BoundGroupId);
            if (group == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "绑定的群组不存在"));
            }
        }

        // 如果未提供对话系统提示词，使用默认值
        var conversationPrompt = string.IsNullOrWhiteSpace(request.ConversationSystemPrompt)
            ? PrdAgent.Infrastructure.Prompts.PromptManager.DefaultConversationSystemPrompt
            : request.ConversationSystemPrompt;
        
        var (app, apiKey) = await _openPlatformService.CreateAppAsync(
            request.AppName,
            request.Description,
            request.BoundUserId,
            request.BoundGroupId,
            request.IgnoreUserSystemPrompt,
            request.DisableGroupContext,
            conversationPrompt);

        var response = new CreateAppResponse
        {
            Id = app.Id,
            AppName = app.AppName,
            Description = app.Description,
            BoundUserId = app.BoundUserId,
            BoundGroupId = app.BoundGroupId,
            IsActive = app.IsActive,
            CreatedAt = app.CreatedAt,
            ApiKey = apiKey // 仅此一次返回明文
        };

        return CreatedAtAction(nameof(GetApps), new { }, ApiResponse<CreateAppResponse>.Ok(response));
    }

    /// <summary>
    /// 更新应用
    /// </summary>
    [HttpPut("apps/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateApp(string id, [FromBody] UpdateAppRequest request)
    {
        var app = await _openPlatformService.GetAppByIdAsync(id);
        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用不存在"));
        }

        // 验证用户存在（如果更新）
        if (!string.IsNullOrWhiteSpace(request.BoundUserId))
        {
            var user = await _userService.GetByIdAsync(request.BoundUserId);
            if (user == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "绑定的用户不存在"));
            }
        }

        // 验证群组存在（如果更新）
        if (!string.IsNullOrWhiteSpace(request.BoundGroupId))
        {
            var group = await _groupService.GetByIdAsync(request.BoundGroupId);
            if (group == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "绑定的群组不存在"));
            }
        }

        var success = await _openPlatformService.UpdateAppAsync(
            id,
            request.AppName,
            request.Description,
            request.BoundUserId,
            request.BoundGroupId,
            request.IgnoreUserSystemPrompt,
            request.DisableGroupContext,
            request.ConversationSystemPrompt);

        if (!success)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "更新失败"));
        }

        return Ok(ApiResponse<object>.Ok(new { message = "更新成功" }));
    }

    /// <summary>
    /// 删除应用
    /// </summary>
    [HttpDelete("apps/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DeleteApp(string id)
    {
        var success = await _openPlatformService.DeleteAppAsync(id);
        if (!success)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { message = "删除成功" }));
    }

    /// <summary>
    /// 重新生成 API Key
    /// </summary>
    [HttpPost("apps/{id}/regenerate-key")]
    [ProducesResponseType(typeof(ApiResponse<RegenerateKeyResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RegenerateKey(string id)
    {
        var newApiKey = await _openPlatformService.RegenerateApiKeyAsync(id);
        if (newApiKey == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用不存在"));
        }

        var response = new RegenerateKeyResponse
        {
            ApiKey = newApiKey
        };

        return Ok(ApiResponse<RegenerateKeyResponse>.Ok(response));
    }

    /// <summary>
    /// 切换应用启用状态
    /// </summary>
    [HttpPost("apps/{id}/toggle")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ToggleAppStatus(string id)
    {
        var success = await _openPlatformService.ToggleAppStatusAsync(id);
        if (!success)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { message = "状态切换成功" }));
    }

    /// <summary>
    /// 获取请求日志（分页）
    /// </summary>
    [HttpGet("logs")]
    [ProducesResponseType(typeof(ApiResponse<PagedLogsResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetLogs(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? appId = null,
        [FromQuery] DateTime? startTime = null,
        [FromQuery] DateTime? endTime = null,
        [FromQuery] int? statusCode = null)
    {
        if (page <= 0) page = 1;
        if (pageSize <= 0 || pageSize > 100) pageSize = 20;

        var (logs, total) = await _openPlatformService.GetRequestLogsAsync(
            page, pageSize, appId, startTime, endTime, statusCode);

        var items = new List<LogListItem>();
        foreach (var log in logs)
        {
            var app = await _openPlatformService.GetAppByIdAsync(log.AppId);

            items.Add(new LogListItem
            {
                Id = log.Id,
                AppId = log.AppId,
                AppName = app?.AppName ?? "Unknown",
                RequestId = log.RequestId,
                StartedAt = log.StartedAt,
                EndedAt = log.EndedAt,
                DurationMs = log.DurationMs,
                Method = log.Method,
                Path = log.Path,
                StatusCode = log.StatusCode,
                ErrorCode = log.ErrorCode,
                GroupId = log.GroupId,
                SessionId = log.SessionId,
                InputTokens = log.InputTokens,
                OutputTokens = log.OutputTokens
            });
        }

        var response = new PagedLogsResponse
        {
            Items = items,
            Total = total,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<PagedLogsResponse>.Ok(response));
    }

    // ========== Webhook 配置管理 ==========

    /// <summary>
    /// 获取应用 Webhook 配置
    /// </summary>
    [HttpGet("apps/{id}/webhook")]
    [ProducesResponseType(typeof(ApiResponse<WebhookConfigResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetWebhookConfig(string id)
    {
        var app = await _openPlatformService.GetAppByIdAsync(id);
        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用不存在"));
        }

        var response = new WebhookConfigResponse
        {
            WebhookUrl = app.WebhookUrl,
            WebhookSecretMasked = string.IsNullOrWhiteSpace(app.WebhookSecret)
                ? null
                : $"****{app.WebhookSecret[Math.Max(0, app.WebhookSecret.Length - 4)..]}",
            WebhookEnabled = app.WebhookEnabled,
            TokenQuotaLimit = app.TokenQuotaLimit,
            TokensUsed = app.TokensUsed,
            QuotaWarningThreshold = app.QuotaWarningThreshold,
            LastQuotaWarningAt = app.LastQuotaWarningAt
        };

        return Ok(ApiResponse<WebhookConfigResponse>.Ok(response));
    }

    /// <summary>
    /// 更新应用 Webhook 配置
    /// </summary>
    [HttpPut("apps/{id}/webhook")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateWebhookConfig(string id, [FromBody] UpdateWebhookConfigRequest request)
    {
        var app = await _openPlatformService.GetAppByIdAsync(id);
        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用不存在"));
        }

        // 验证 Webhook URL 格式
        if (!string.IsNullOrWhiteSpace(request.WebhookUrl))
        {
            if (!Uri.TryCreate(request.WebhookUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https")
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "Webhook 地址必须为 HTTPS 协议"));
            }
        }

        // 如果前端传了 webhookSecret 的掩码值（****开头），保留原值
        var webhookSecret = request.WebhookSecret;
        if (!string.IsNullOrEmpty(webhookSecret) && webhookSecret.StartsWith("****"))
        {
            webhookSecret = app.WebhookSecret;
        }

        var success = await _openPlatformService.UpdateWebhookConfigAsync(
            id,
            request.WebhookUrl,
            webhookSecret,
            request.WebhookEnabled,
            request.TokenQuotaLimit,
            request.QuotaWarningThreshold);

        if (!success)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "更新失败"));
        }

        return Ok(ApiResponse<object>.Ok(new { message = "Webhook 配置已更新" }));
    }

    /// <summary>
    /// 测试 Webhook 连通性
    /// </summary>
    [HttpPost("apps/{id}/webhook/test")]
    [ProducesResponseType(typeof(ApiResponse<WebhookTestResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> TestWebhook(string id)
    {
        var app = await _openPlatformService.GetAppByIdAsync(id);
        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "应用不存在"));
        }

        if (string.IsNullOrWhiteSpace(app.WebhookUrl))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先配置 Webhook 地址"));
        }

        var deliveryLog = await _webhookService.SendTestNotificationAsync(app.WebhookUrl, app.WebhookSecret);

        var response = new WebhookTestResponse
        {
            Success = deliveryLog.Success,
            StatusCode = deliveryLog.StatusCode,
            DurationMs = deliveryLog.DurationMs,
            ErrorMessage = deliveryLog.ErrorMessage,
            ResponseBody = deliveryLog.ResponseBody
        };

        return Ok(ApiResponse<WebhookTestResponse>.Ok(response));
    }

    /// <summary>
    /// 获取 Webhook 投递日志
    /// </summary>
    [HttpGet("apps/{id}/webhook/logs")]
    [ProducesResponseType(typeof(ApiResponse<PagedWebhookLogsResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetWebhookLogs(
        string id,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        if (page <= 0) page = 1;
        if (pageSize <= 0 || pageSize > 100) pageSize = 20;

        var (logs, total) = await _webhookService.GetDeliveryLogsAsync(id, page, pageSize);

        var response = new PagedWebhookLogsResponse
        {
            Items = logs.Select(l => new WebhookLogItem
            {
                Id = l.Id,
                Type = l.Type,
                Title = l.Title,
                StatusCode = l.StatusCode,
                Success = l.Success,
                ErrorMessage = l.ErrorMessage,
                DurationMs = l.DurationMs,
                RetryCount = l.RetryCount,
                CreatedAt = l.CreatedAt
            }).ToList(),
            Total = total,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<PagedWebhookLogsResponse>.Ok(response));
    }
}

#region Request/Response Models

public class CreateAppRequest
{
    public string AppName { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string BoundUserId { get; set; } = string.Empty;
    public string? BoundGroupId { get; set; }
    public bool IgnoreUserSystemPrompt { get; set; } = true;
    /// <summary>是否禁用群上下文，禁用后仅使用用户传递的上下文（默认 true）</summary>
    public bool DisableGroupContext { get; set; } = true;
    /// <summary>
    /// 对话系统提示词（可选）。非空时使用该值作为系统提示词覆盖默认提示词。
    /// 如果未提供或为空，系统会自动填充默认对话提示词。
    /// </summary>
    public string? ConversationSystemPrompt { get; set; }
}

public class UpdateAppRequest
{
    public string? AppName { get; set; }
    public string? Description { get; set; }
    public string? BoundUserId { get; set; }
    public string? BoundGroupId { get; set; }
    public bool? IgnoreUserSystemPrompt { get; set; }
    public bool? DisableGroupContext { get; set; }
    /// <summary>
    /// 对话系统提示词（可选）。非空时使用该值作为系统提示词覆盖默认提示词。
    /// </summary>
    public string? ConversationSystemPrompt { get; set; }
}

public class CreateAppResponse
{
    public string Id { get; set; } = string.Empty;
    public string AppName { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string BoundUserId { get; set; } = string.Empty;
    public string? BoundGroupId { get; set; }
    public bool IsActive { get; set; }
    public DateTime CreatedAt { get; set; }
    public string ApiKey { get; set; } = string.Empty;
}

public class RegenerateKeyResponse
{
    public string ApiKey { get; set; } = string.Empty;
}

public class AppListItem
{
    public string Id { get; set; } = string.Empty;
    public string AppName { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string BoundUserId { get; set; } = string.Empty;
    public string BoundUserName { get; set; } = string.Empty;
    public string? BoundGroupId { get; set; }
    public string? BoundGroupName { get; set; }
    public bool IgnoreUserSystemPrompt { get; set; }
    public bool DisableGroupContext { get; set; }
    /// <summary>对话系统提示词（可选）。非空时表示启用对话模式。</summary>
    public string? ConversationSystemPrompt { get; set; }
    public bool IsActive { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastUsedAt { get; set; }
    public long TotalRequests { get; set; }
    public string ApiKeyMasked { get; set; } = string.Empty;
    // Webhook 配置摘要
    public bool WebhookEnabled { get; set; }
    public string? WebhookUrl { get; set; }
    public long TokenQuotaLimit { get; set; }
    public long TokensUsed { get; set; }
    public long QuotaWarningThreshold { get; set; }
}

public class PagedAppsResponse
{
    public List<AppListItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

public class LogListItem
{
    public string Id { get; set; } = string.Empty;
    public string AppId { get; set; } = string.Empty;
    public string AppName { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public DateTime StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public long? DurationMs { get; set; }
    public string Method { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public int StatusCode { get; set; }
    public string? ErrorCode { get; set; }
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
}

public class PagedLogsResponse
{
    public List<LogListItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

// ========== Webhook 相关模型 ==========

public class UpdateWebhookConfigRequest
{
    public string? WebhookUrl { get; set; }
    public string? WebhookSecret { get; set; }
    public bool WebhookEnabled { get; set; }
    public long TokenQuotaLimit { get; set; }
    public long QuotaWarningThreshold { get; set; } = 100000;
}

public class WebhookConfigResponse
{
    public string? WebhookUrl { get; set; }
    /// <summary>掩码后的密钥（如 ****abcd）</summary>
    public string? WebhookSecretMasked { get; set; }
    public bool WebhookEnabled { get; set; }
    public long TokenQuotaLimit { get; set; }
    public long TokensUsed { get; set; }
    public long QuotaWarningThreshold { get; set; }
    public DateTime? LastQuotaWarningAt { get; set; }
}

public class WebhookTestResponse
{
    public bool Success { get; set; }
    public int? StatusCode { get; set; }
    public long? DurationMs { get; set; }
    public string? ErrorMessage { get; set; }
    public string? ResponseBody { get; set; }
}

public class WebhookLogItem
{
    public string Id { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public int? StatusCode { get; set; }
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
    public long? DurationMs { get; set; }
    public int RetryCount { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class PagedWebhookLogsResponse
{
    public List<WebhookLogItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

#endregion
