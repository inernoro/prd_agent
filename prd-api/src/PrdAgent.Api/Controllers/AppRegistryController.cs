using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 应用注册中心 - 管理外部应用注册、路由规则、桩应用
/// </summary>
[ApiController]
[Route("api/app-registry")]
public class AppRegistryController : ControllerBase
{
    private readonly IAppRegistryService _service;
    private readonly ILogger<AppRegistryController> _logger;

    public AppRegistryController(IAppRegistryService service, ILogger<AppRegistryController> logger)
    {
        _service = service;
        _logger = logger;
    }

    // ==================== 应用管理 ====================

    /// <summary>获取所有已注册应用</summary>
    [HttpGet("apps")]
    public async Task<IActionResult> GetApps([FromQuery] bool includeInactive = false, CancellationToken ct = default)
    {
        var apps = await _service.GetAppsAsync(includeInactive, ct);
        return Ok(new { success = true, data = apps });
    }

    /// <summary>根据 AppId 获取应用详情</summary>
    [HttpGet("apps/{appId}")]
    public async Task<IActionResult> GetApp(string appId, CancellationToken ct = default)
    {
        var app = await _service.GetAppByIdAsync(appId, ct);
        if (app == null)
        {
            return NotFound(new { success = false, error = new { message = $"应用 {appId} 不存在" } });
        }
        return Ok(new { success = true, data = app });
    }

    /// <summary>注册应用</summary>
    [HttpPost("apps")]
    public async Task<IActionResult> RegisterApp([FromBody] RegisterAppRequest request, CancellationToken ct = default)
    {
        try
        {
            var app = await _service.RegisterAppAsync(request, ct);
            return Ok(new { success = true, data = app });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>更新应用</summary>
    [HttpPut("apps/{appId}")]
    public async Task<IActionResult> UpdateApp(string appId, [FromBody] UpdateAppRequest request, CancellationToken ct = default)
    {
        try
        {
            var app = await _service.UpdateAppAsync(appId, request, ct);
            return Ok(new { success = true, data = app });
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>注销应用</summary>
    [HttpDelete("apps/{appId}")]
    public async Task<IActionResult> DeleteApp(string appId, CancellationToken ct = default)
    {
        try
        {
            await _service.DeleteAppAsync(appId, ct);
            return Ok(new { success = true });
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>切换应用状态</summary>
    [HttpPost("apps/{appId}/toggle")]
    public async Task<IActionResult> ToggleApp(string appId, CancellationToken ct = default)
    {
        try
        {
            var app = await _service.ToggleAppStatusAsync(appId, ct);
            return Ok(new { success = true, data = app });
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>应用心跳</summary>
    [HttpPost("apps/{appId}/heartbeat")]
    public async Task<IActionResult> Heartbeat(string appId, CancellationToken ct = default)
    {
        await _service.UpdateHeartbeatAsync(appId, ct);
        return Ok(new { success = true });
    }

    // ==================== 桩应用 ====================

    /// <summary>创建桩应用（用于测试）</summary>
    [HttpPost("stubs")]
    public async Task<IActionResult> CreateStubApp([FromBody] CreateStubAppRequest request, CancellationToken ct = default)
    {
        try
        {
            var app = await _service.CreateStubAppAsync(request, ct);
            return Ok(new { success = true, data = app });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>更新桩应用配置</summary>
    [HttpPut("stubs/{appId}/config")]
    public async Task<IActionResult> UpdateStubConfig(string appId, [FromBody] StubAppConfig config, CancellationToken ct = default)
    {
        try
        {
            var app = await _service.UpdateStubConfigAsync(appId, config, ct);
            return Ok(new { success = true, data = app });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { success = false, error = new { message = ex.Message } });
        }
    }

    // ==================== 路由规则 ====================

    /// <summary>获取所有路由规则</summary>
    [HttpGet("rules")]
    public async Task<IActionResult> GetRules([FromQuery] bool includeInactive = false, CancellationToken ct = default)
    {
        var rules = await _service.GetRoutingRulesAsync(includeInactive, ct);
        return Ok(new { success = true, data = rules });
    }

    /// <summary>获取路由规则详情</summary>
    [HttpGet("rules/{id}")]
    public async Task<IActionResult> GetRule(string id, CancellationToken ct = default)
    {
        var rule = await _service.GetRoutingRuleAsync(id, ct);
        if (rule == null)
        {
            return NotFound(new { success = false, error = new { message = $"规则 {id} 不存在" } });
        }
        return Ok(new { success = true, data = rule });
    }

    /// <summary>创建路由规则</summary>
    [HttpPost("rules")]
    public async Task<IActionResult> CreateRule([FromBody] CreateRoutingRuleRequest request, CancellationToken ct = default)
    {
        try
        {
            var rule = await _service.CreateRoutingRuleAsync(request, ct);
            return Ok(new { success = true, data = rule });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>更新路由规则</summary>
    [HttpPut("rules/{id}")]
    public async Task<IActionResult> UpdateRule(string id, [FromBody] UpdateRoutingRuleRequest request, CancellationToken ct = default)
    {
        try
        {
            var rule = await _service.UpdateRoutingRuleAsync(id, request, ct);
            return Ok(new { success = true, data = rule });
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>删除路由规则</summary>
    [HttpDelete("rules/{id}")]
    public async Task<IActionResult> DeleteRule(string id, CancellationToken ct = default)
    {
        try
        {
            await _service.DeleteRoutingRuleAsync(id, ct);
            return Ok(new { success = true });
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>切换规则状态</summary>
    [HttpPost("rules/{id}/toggle")]
    public async Task<IActionResult> ToggleRule(string id, CancellationToken ct = default)
    {
        try
        {
            var rule = await _service.ToggleRuleStatusAsync(id, ct);
            return Ok(new { success = true, data = rule });
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(new { success = false, error = new { message = ex.Message } });
        }
    }

    // ==================== 测试调用 ====================

    /// <summary>测试调用应用</summary>
    [HttpPost("invoke/{appId}")]
    public async Task<IActionResult> InvokeApp(string appId, [FromBody] UnifiedAppRequest request, CancellationToken ct = default)
    {
        try
        {
            var response = await _service.InvokeAppAsync(appId, request, ct);
            return Ok(new { success = true, data = response });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>测试路由解析（不实际调用）</summary>
    [HttpPost("resolve")]
    public async Task<IActionResult> ResolveApp([FromBody] UnifiedAppRequest request, CancellationToken ct = default)
    {
        var (app, rule) = await _service.ResolveAppAsync(request, ct);
        return Ok(new
        {
            success = true,
            data = new
            {
                matched = app != null,
                app = app != null ? new { app.AppId, app.AppName, app.Icon } : null,
                rule = rule != null ? new { rule.Id, rule.Name, rule.Condition.Type } : null,
            }
        });
    }

    // ==================== 协议文档 ====================

    /// <summary>获取统一协议规范</summary>
    [HttpGet("protocol")]
    public IActionResult GetProtocol()
    {
        return Ok(new
        {
            success = true,
            data = new
            {
                version = "1.0.0",
                description = "应用注册中心统一协议规范",
                request = new
                {
                    schema = "UnifiedAppRequest",
                    fields = new
                    {
                        requestId = "请求 ID（用于追踪）",
                        timestamp = "时间戳",
                        source = new
                        {
                            channel = "通道类型（email, sms, siri, webhook, api）",
                            senderIdentifier = "发送者标识",
                            senderName = "发送者名称",
                        },
                        content = new
                        {
                            subject = "主题/标题",
                            body = "正文内容",
                            contentType = "内容类型（text, html, markdown）",
                            attachments = "附件列表",
                        },
                        context = new
                        {
                            userId = "映射的用户 ID",
                            userName = "用户名",
                            sessionId = "会话 ID",
                            customPrompt = "自定义提示词",
                        },
                    },
                },
                response = new
                {
                    schema = "UnifiedAppResponse",
                    fields = new
                    {
                        requestId = "请求 ID",
                        status = "处理状态（Success, Failed, Pending, Processing, Timeout, Rejected）",
                        message = "状态消息",
                        result = new
                        {
                            content = "结果内容",
                            entityId = "创建的实体 ID",
                            entityType = "实体类型",
                        },
                        reply = new
                        {
                            shouldReply = "是否需要回复",
                            content = "回复内容",
                        },
                        error = new
                        {
                            code = "错误代码",
                            message = "错误消息",
                            retryable = "是否可重试",
                        },
                    },
                },
                example = new
                {
                    request = new UnifiedAppRequest
                    {
                        RequestId = "req_example_001",
                        Source = new RequestSource
                        {
                            Channel = "email",
                            SenderIdentifier = "user@example.com",
                            SenderName = "示例用户",
                        },
                        Content = new RequestContent
                        {
                            Subject = "关于登录功能的问题",
                            Body = "用户登录失败时应该显示什么提示？",
                        },
                        Context = new RequestContext
                        {
                            UserId = "user_123",
                        },
                    },
                    response = new UnifiedAppResponse
                    {
                        RequestId = "req_example_001",
                        Status = AppResponseStatus.Success,
                        Message = "处理成功",
                        Result = new ResponseResult
                        {
                            Content = "根据 PRD 文档，登录失败时应显示「用户名或密码错误」",
                        },
                        Reply = new ResponseReply
                        {
                            ShouldReply = true,
                            Content = "已为您查询，登录失败时应显示「用户名或密码错误」",
                        },
                    },
                },
            },
        });
    }
}
