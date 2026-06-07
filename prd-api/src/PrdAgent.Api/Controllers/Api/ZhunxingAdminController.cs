using System.Linq;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
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
[AdminController("zhunxing-agent", AdminPermissionCatalog.ZhunxingAgentRead, WritePermission = AdminPermissionCatalog.ZhunxingAgentRead)]
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

    /// <summary>
    /// 管理端问答入口（走 /api 前缀，便于 Web 管理后台通过网关转发访问）。
    /// </summary>
    [HttpPost("ask")]
    public async Task<IActionResult> Ask([FromBody] ZhunxingAskRequest request, CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var result = await _knowledgeService.AskAsync(userId, request, ct);
            return Ok(ApiResponse<ZhunxingAskResponse>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToHashSet(StringComparer.Ordinal);
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private HashSet<string> GetPermissionSet()
    {
        return User.FindAll("permissions").Select(c => c.Value).ToHashSet(StringComparer.Ordinal);
    }

    private static string? NormalizeDepartment(string? department)
    {
        if (string.IsNullOrWhiteSpace(department))
            return null;

        var normalized = department.Trim().ToLowerInvariant();
        return ZhunxingDepartments.All.Contains(normalized, StringComparer.Ordinal)
            ? normalized
            : null;
    }

    private bool CanManageDepartment(HashSet<string> permissions, string department)
    {
        if (string.IsNullOrWhiteSpace(department))
            return false;
        return GetManageableDepartments(permissions).ContainsKey(department);
    }

    private Dictionary<string, string> GetManageableDepartments(HashSet<string> permissions)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (permissions.Contains(AdminPermissionCatalog.Super)
            || permissions.Contains(AdminPermissionCatalog.ZhunxingAgentDepartmentAllManage))
        {
            foreach (var dept in ZhunxingDepartments.All)
            {
                result[dept] = dept;
            }
            return result;
        }

        foreach (var dept in ZhunxingDepartments.All)
        {
            var scopedPerm = $"zhunxing-agent.department.{dept}.manage";
            if (permissions.Contains(scopedPerm))
            {
                result[dept] = dept;
            }
        }

        var queue = new Queue<string>(result.Keys);
        while (queue.Count > 0)
        {
            var parent = queue.Dequeue();
            if (!ZhunxingDepartmentHierarchy.Children.TryGetValue(parent, out var children))
                continue;

            foreach (var child in children)
            {
                if (result.ContainsKey(child))
                    continue;
                result[child] = parent;
                queue.Enqueue(child);
            }
        }

        return result;
    }

    private static string GetDepartmentLabel(string department)
    {
        return ZhunxingDepartments.Labels.TryGetValue(department, out var label)
            ? label
            : department;
    }

    private IActionResult? EnsureWritePermission()
    {
        if (HasPermission(AdminPermissionCatalog.ZhunxingAgentWrite))
            return null;

        return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "缺少准星写权限"));
    }

    private IActionResult? EnsureDepartmentPermission(string department, string actionLabel)
    {
        var normalizedDepartment = NormalizeDepartment(department);
        if (string.IsNullOrWhiteSpace(normalizedDepartment))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "ownerDepartment 不合法或未配置"));

        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        var permissions = GetPermissionSet();
        if (CanManageDepartment(permissions, normalizedDepartment))
            return null;

        return StatusCode(
            StatusCodes.Status403Forbidden,
            ApiResponse<object>.Fail(
                ErrorCodes.PERMISSION_DENIED,
                $"缺少部门维护权限：当前无权{actionLabel} {GetDepartmentLabel(normalizedDepartment)}文档"));
    }

    [HttpGet("access-scope")]
    public IActionResult GetAccessScope()
    {
        var permissions = GetPermissionSet();
        var writable = permissions.Contains(AdminPermissionCatalog.Super)
            || permissions.Contains(AdminPermissionCatalog.ZhunxingAgentWrite);
        var canManageAll = permissions.Contains(AdminPermissionCatalog.Super)
            || permissions.Contains(AdminPermissionCatalog.ZhunxingAgentDepartmentAllManage);
        var manageableDepartmentMap = GetManageableDepartments(permissions);
        var manageableDepartments = manageableDepartmentMap.Keys.ToList();
        var inheritedDepartments = manageableDepartmentMap
            .Where(x => !string.Equals(x.Key, x.Value, StringComparison.Ordinal))
            .ToDictionary(x => x.Key, x => x.Value, StringComparer.Ordinal);

        return Ok(ApiResponse<ZhunxingAccessScopeResult>.Ok(new ZhunxingAccessScopeResult
        {
            Writable = writable,
            CanManageAllDepartments = canManageAll,
            ManageableDepartments = manageableDepartments,
            DepartmentLabels = ZhunxingDepartments.Labels.ToDictionary(x => x.Key, x => x.Value, StringComparer.Ordinal),
            InheritedDepartments = inheritedDepartments,
        }));
    }

    [HttpPost("feedback")]
    public async Task<IActionResult> SubmitFeedback([FromBody] CreateZhunxingAskFeedbackRequest request, CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var result = await _knowledgeService.SubmitAskFeedbackAsync(userId, request, ct);
            return Ok(ApiResponse<ZhunxingAskFeedbackResult>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpGet("feedbacks/summary")]
    public async Task<IActionResult> GetFeedbackSummary([FromQuery] int top = 10, CancellationToken ct = default)
    {
        var summary = await _knowledgeService.GetFeedbackSummaryAsync(top, ct);
        return Ok(ApiResponse<ZhunxingFeedbackSummary>.Ok(summary));
    }

    [HttpGet("subscriptions/me")]
    public async Task<IActionResult> GetMyTopicSubscription(CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        var result = await _knowledgeService.GetTopicSubscriptionAsync(userId, ct);
        return Ok(ApiResponse<ZhunxingTopicSubscriptionResult>.Ok(result));
    }

    [HttpPut("subscriptions/me")]
    public async Task<IActionResult> UpdateMyTopicSubscription([FromBody] UpdateZhunxingTopicSubscriptionRequest request, CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var result = await _knowledgeService.UpdateTopicSubscriptionAsync(userId, request, ct);
            return Ok(ApiResponse<ZhunxingTopicSubscriptionResult>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpGet("subscriptions/me/updates")]
    public async Task<IActionResult> GetMyTopicUpdates([FromQuery] int days = 30, [FromQuery] int top = 20, CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var result = await _knowledgeService.GetTopicUpdatesAsync(userId, days, top, ct);
            return Ok(ApiResponse<ZhunxingTopicUpdateFeed>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpGet("heatmap")]
    public async Task<IActionResult> GetKnowledgeHeatmap([FromQuery] int days = 30, [FromQuery] int top = 8, CancellationToken ct = default)
    {
        var result = await _knowledgeService.GetKnowledgeHeatmapAsync(days, top, ct);
        return Ok(ApiResponse<ZhunxingKnowledgeHeatmap>.Ok(result));
    }

    [HttpGet("feedbacks")]
    public async Task<IActionResult> ListFeedbacks(
        [FromQuery] string? feedbackType = null,
        [FromQuery] string? status = null,
        [FromQuery] bool? matched = null,
        [FromQuery] string? keyword = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var result = await _knowledgeService.ListFeedbacksAsync(
            feedbackType,
            status,
            matched,
            keyword,
            page,
            pageSize,
            ct);
        return Ok(ApiResponse<ZhunxingFeedbackListResult>.Ok(result));
    }

    [HttpPatch("feedbacks/{feedbackId}/workflow")]
    public async Task<IActionResult> UpdateFeedbackWorkflow(
        [FromRoute] string feedbackId,
        [FromBody] UpdateZhunxingFeedbackWorkflowRequest request,
        CancellationToken ct = default)
    {
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        try
        {
            var operatorUserId = this.GetRequiredUserId();
            var result = await _knowledgeService.UpdateFeedbackWorkflowAsync(operatorUserId, feedbackId, request, ct);
            return Ok(ApiResponse<ZhunxingFeedbackListItem>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
    }

    [HttpPost("feedbacks/{feedbackId}/replay")]
    public async Task<IActionResult> ReplayFeedback(
        [FromRoute] string feedbackId,
        [FromBody] ReplayZhunxingFeedbackRequest request,
        CancellationToken ct = default)
    {
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        try
        {
            var operatorUserId = this.GetRequiredUserId();
            var result = await _knowledgeService.ReplayFeedbackAsync(operatorUserId, feedbackId, request, ct);
            return Ok(ApiResponse<ZhunxingFeedbackReplayResult>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
    }

    [HttpPost("feedbacks/{feedbackId}/follow-up")]
    public async Task<IActionResult> MarkFeedbackFollowUp(
        [FromRoute] string feedbackId,
        [FromBody] MarkZhunxingFeedbackFollowUpRequest request,
        CancellationToken ct = default)
    {
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        try
        {
            var operatorUserId = this.GetRequiredUserId();
            var result = await _knowledgeService.MarkFeedbackFollowUpAsync(operatorUserId, feedbackId, request, ct);
            return Ok(ApiResponse<ZhunxingFeedbackFollowUpResult>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
    }

    [HttpGet("documents")]
    public async Task<IActionResult> ListDocuments([FromQuery] bool includeInactive = false, CancellationToken ct = default)
    {
        var docs = await _knowledgeService.ListDocumentsAsync(includeInactive, ct);
        return Ok(ApiResponse<object>.Ok(new { items = docs }));
    }

    [HttpGet("categories")]
    public async Task<IActionResult> ListCategories([FromQuery] bool includeInactive = false, CancellationToken ct = default)
    {
        var items = await _knowledgeService.ListCategoriesAsync(includeInactive, ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("categories")]
    public async Task<IActionResult> CreateCategory([FromBody] CreateZhunxingCategoryRequest request, CancellationToken ct = default)
    {
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        try
        {
            var userId = this.GetRequiredUserId();
            var category = await _knowledgeService.CreateCategoryAsync(request, userId, ct);
            return Ok(ApiResponse<object>.Ok(category));
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

    [HttpGet("tags")]
    public async Task<IActionResult> ListTags([FromQuery] bool includeInactive = false, CancellationToken ct = default)
    {
        var items = await _knowledgeService.ListTagsAsync(includeInactive, ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("tags")]
    public async Task<IActionResult> CreateTag([FromBody] CreateZhunxingTagRequest request, CancellationToken ct = default)
    {
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        try
        {
            var userId = this.GetRequiredUserId();
            var tag = await _knowledgeService.CreateTagAsync(request, userId, ct);
            return Ok(ApiResponse<object>.Ok(tag));
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

    [HttpGet("documents/{documentId}/timeline")]
    public async Task<IActionResult> GetDocumentTimeline([FromRoute] string documentId, CancellationToken ct = default)
    {
        try
        {
            var result = await _knowledgeService.GetDocumentVersionTimelineAsync(documentId, ct);
            return Ok(ApiResponse<ZhunxingDocumentVersionTimelineResult>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
    }

    [HttpGet("documents/diff")]
    public async Task<IActionResult> GetDocumentDiff(
        [FromQuery] string sourceDocumentId,
        [FromQuery] string targetDocumentId,
        CancellationToken ct = default)
    {
        try
        {
            var result = await _knowledgeService.GetDocumentDiffAsync(sourceDocumentId, targetDocumentId, ct);
            return Ok(ApiResponse<ZhunxingDocumentDiffResult>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
    }

    [HttpPost("documents/expire-now")]
    public async Task<IActionResult> ExpireDocuments(CancellationToken ct = default)
    {
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        var userId = this.GetRequiredUserId();
        var result = await _knowledgeService.ExpireDocumentsAsync(userId, ct);
        return Ok(ApiResponse<ZhunxingExpireDocumentsResult>.Ok(result));
    }

    [HttpPost("documents")]
    public async Task<IActionResult> CreateDocument([FromBody] CreateZhunxingDocumentRequest request, CancellationToken ct = default)
    {
        var normalizedDepartment = NormalizeDepartment(request.OwnerDepartment);
        if (string.IsNullOrWhiteSpace(normalizedDepartment))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "ownerDepartment 不能为空，且必须是已定义部门"));

        request.OwnerDepartment = normalizedDepartment;
        var denied = EnsureDepartmentPermission(normalizedDepartment, "维护");
        if (denied != null)
            return denied;

        try
        {
            if (!string.IsNullOrWhiteSpace(request.PreviousVersionDocumentId))
            {
                var previous = await _knowledgeService.GetDocumentByIdAsync(request.PreviousVersionDocumentId, ct);
                if (previous == null)
                    return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上一版本文档不存在"));

                var previousDepartment = NormalizeDepartment(previous.OwnerDepartment);
                if (!string.IsNullOrWhiteSpace(previousDepartment))
                {
                    var previousDenied = EnsureDepartmentPermission(previousDepartment, "关联版本");
                    if (previousDenied != null)
                        return previousDenied;
                }
            }

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
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        var doc = await _knowledgeService.GetDocumentByIdAsync(request.DocumentId, ct);
        if (doc == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "关联文档不存在"));

        var ownerDepartment = NormalizeDepartment(doc.OwnerDepartment);
        if (string.IsNullOrWhiteSpace(ownerDepartment))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "关联文档未配置 ownerDepartment，暂不允许维护"));

        denied = EnsureDepartmentPermission(ownerDepartment, "维护");
        if (denied != null)
            return denied;

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

    [HttpDelete("documents/{documentId}")]
    public async Task<IActionResult> DeactivateDocument([FromRoute] string documentId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(documentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "documentId 不能为空"));

        var doc = await _knowledgeService.GetDocumentByIdAsync(documentId, ct);
        if (doc == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识文档不存在"));

        var ownerDepartment = NormalizeDepartment(doc.OwnerDepartment);
        if (string.IsNullOrWhiteSpace(ownerDepartment))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档未配置 ownerDepartment，暂不允许删除"));

        var denied = EnsureDepartmentPermission(ownerDepartment, "删除");
        if (denied != null)
            return denied;

        var userId = this.GetRequiredUserId();
        var deactivated = await _knowledgeService.DeactivateDocumentAsync(documentId, userId, ct);
        return Ok(ApiResponse<object>.Ok(deactivated));
    }

    /// <summary>
    /// 初始化《米多公司考勤管理办法》样例知识条款（用于快速跑通）。
    /// </summary>
    [HttpPost("bootstrap/attendance")]
    public async Task<IActionResult> BootstrapAttendance(CancellationToken ct = default)
    {
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

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
        var denied = EnsureWritePermission();
        if (denied != null)
            return denied;

        var app = await _appRegistryService.GetAppByIdAsync("zhunxing-agent", ct);
        var appCreated = false;
        if (app == null)
        {
            app = await _appRegistryService.RegisterAppAsync(new RegisterAppRequest
            {
                AppId = "zhunxing-agent",
                AppName = "准星",
                Description = "企业AI知识中枢，覆盖问答、流程决策与风险预警。",
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
