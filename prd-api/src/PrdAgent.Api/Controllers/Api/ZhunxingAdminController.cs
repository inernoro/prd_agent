using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 准星管理接口：知识文档/条款维护 + 首版引导初始化。
/// </summary>
[ApiController]
[Route("api/zhunxing")]
[Authorize]
[AdminController("zhunxing-agent", AdminPermissionCatalog.ZhunxingAgentRead, WritePermission = AdminPermissionCatalog.ZhunxingAgentWrite)]
public class ZhunxingAdminController : ControllerBase
{
    private readonly IZhunxingKnowledgeService _knowledgeService;
    private readonly IAppRegistryService _appRegistryService;

    public ZhunxingAdminController(
        IZhunxingKnowledgeService knowledgeService,
        IAppRegistryService appRegistryService)
    {
        _knowledgeService = knowledgeService;
        _appRegistryService = appRegistryService;
    }

    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(ApiResponse<object>.Ok(new
        {
            appKey = "zhunxing-agent",
            status = "ok",
            mode = "bootstrap-ready",
        }));
    }

    [HttpGet("documents")]
    public async Task<IActionResult> ListDocuments([FromQuery] bool includeInactive = false, CancellationToken ct = default)
    {
        var docs = await _knowledgeService.ListDocumentsAsync(includeInactive, ct);
        return Ok(ApiResponse<object>.Ok(new { items = docs }));
    }

    [HttpPost("documents")]
    public async Task<IActionResult> CreateDocument([FromBody] CreateZhunxingDocumentRequest request, CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var doc = await _knowledgeService.CreateDocumentAsync(request, userId, ct);
            return Ok(ApiResponse<object>.Ok(doc));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, ex.Message));
        }
    }

    [HttpGet("clauses")]
    public async Task<IActionResult> ListClauses(
        [FromQuery] string? documentId = null,
        [FromQuery] bool includeInactive = false,
        CancellationToken ct = default)
    {
        var clauses = await _knowledgeService.ListClausesAsync(documentId, includeInactive, ct);
        return Ok(ApiResponse<object>.Ok(new { items = clauses }));
    }

    [HttpPost("clauses")]
    public async Task<IActionResult> CreateClause([FromBody] CreateZhunxingClauseRequest request, CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var clause = await _knowledgeService.CreateClauseAsync(request, userId, ct);
            return Ok(ApiResponse<object>.Ok(clause));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
    }

    /// <summary>
    /// 初始化《米多公司考勤管理办法》样例知识条款（用于快速跑通）。
    /// </summary>
    [HttpPost("bootstrap/attendance")]
    public async Task<IActionResult> BootstrapAttendance(CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        var result = await _knowledgeService.BootstrapAttendanceSampleAsync(userId, ct);
        return Ok(ApiResponse<object>.Ok(result));
    }

    /// <summary>
    /// 一键注册准星到 App Registry，并创建规范问答路由规则。
    /// </summary>
    [HttpPost("bootstrap/app-registry")]
    public async Task<IActionResult> BootstrapAppRegistry(CancellationToken ct = default)
    {
        var app = await _appRegistryService.GetAppByIdAsync("zhunxing-agent", ct);
        var appCreated = false;
        if (app == null)
        {
            app = await _appRegistryService.RegisterAppAsync(new RegisterAppRequest
            {
                AppId = "zhunxing-agent",
                AppName = "准星",
                Description = "公司规范与流程问答中枢",
                Version = "1.0.0",
                Endpoint = "/zhunxing/ask",
                SupportsStreaming = false,
                SupportsStatusCallback = false,
                AuthType = AppAuthType.Bearer,
                Capabilities = new AppCapabilities
                {
                    InputTypes = new List<string> { "text" },
                    OutputTypes = new List<string> { "text" },
                    SupportsAttachments = false,
                    TriggerKeywords = new List<string>
                    {
                        "规章", "制度", "规范", "流程", "交接", "考勤", "请假", "旷工",
                    },
                    UseCaseDescription = "回答公司制度、产研规范、市场销售交接流程问题",
                },
            }, ct);
            appCreated = true;
        }

        var rules = await _appRegistryService.GetRoutingRulesAsync(includeInactive: true, ct);
        var hasRule = rules.Any(x =>
            x.TargetAppId == "zhunxing-agent" &&
            x.Condition.Type == RuleConditionType.Keyword);

        var ruleCreated = false;
        RoutingRule? rule = null;
        if (!hasRule)
        {
            rule = await _appRegistryService.CreateRoutingRuleAsync(new CreateRoutingRuleRequest
            {
                Name = "准星-规范流程问答",
                Description = "将制度、规范、交接流程相关请求路由到准星",
                Priority = 20,
                TargetAppId = "zhunxing-agent",
                Condition = new RuleCondition
                {
                    Type = RuleConditionType.Keyword,
                    Keywords = new List<string>
                    {
                        "规章", "制度", "规范", "流程", "交接", "考勤", "请假", "旷工",
                    },
                },
            }, ct);
            ruleCreated = true;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            appCreated,
            ruleCreated,
            appId = app!.AppId,
            createdRuleId = rule?.Id,
        }));
    }
}
