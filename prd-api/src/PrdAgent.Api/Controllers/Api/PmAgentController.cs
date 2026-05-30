using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 项目管理智能体 — 立项、任务看板/甘特图、AI 需求拆解。
/// appKey 硬编码 pm-agent（应用身份隔离，见 .claude/rules/app-identity.md）。
/// </summary>
[ApiController]
[Route("api/pm")]
[Authorize]
[AdminController("pm-agent", AdminPermissionCatalog.PmAgentUse)]
public class PmAgentController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly PmAgentService _pmService;
    private readonly ILogger<PmAgentController> _logger;

    public PmAgentController(MongoDbContext db, PmAgentService pmService, ILogger<PmAgentController> logger)
    {
        _db = db;
        _pmService = pmService;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    // ─────────────────────────────────────────────
    // 项目 CRUD（立项 / 列表 / 详情 / 更新 / 删除）
    // ─────────────────────────────────────────────

    /// <summary>立项注册 — 创建项目</summary>
    [HttpPost("projects")]
    public async Task<IActionResult> CreateProject([FromBody] CreatePmProjectRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "项目名称不能为空"));
        if (string.IsNullOrWhiteSpace(request.BusinessGoal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "业务目标不能为空"));
        if (!PmProjectType.All.Contains(request.ProjectType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的项目类型"));

        var userId = GetUserId();
        var leaderId = string.IsNullOrWhiteSpace(request.LeaderId) ? userId : request.LeaderId.Trim();

        // Leader 名称冗余（便于展示）
        var leader = await _db.Users.Find(u => u.UserId == leaderId).FirstOrDefaultAsync();

        var project = new PmProject
        {
            ProjectNo = await GenerateProjectNoAsync(),
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            BusinessGoal = request.BusinessGoal.Trim(),
            ProjectType = request.ProjectType,
            OperationSubType = request.ProjectType == PmProjectType.Operation ? request.OperationSubType : null,
            Lifecycle = PmProjectLifecycle.Registered,
            LeaderId = leaderId,
            LeaderName = leader?.DisplayName,
            MemberIds = request.MemberIds ?? new(),
            StrategyAlignment = request.StrategyAlignment?.Trim(),
            PlannedStartAt = request.PlannedStartAt,
            PlannedEndAt = request.PlannedEndAt,
            Budget = request.Budget,
            OwnerId = userId,
        };

        await _db.PmProjects.InsertOneAsync(project);
        _logger.LogInformation("[pm-agent] Project created: {ProjectNo} '{Title}' by {UserId}", project.ProjectNo, project.Title, userId);
        return Ok(ApiResponse<object>.Ok(project));
    }

    /// <summary>项目列表（我创建的 + 我参与的）</summary>
    [HttpGet("projects")]
    public async Task<IActionResult> ListProjects([FromQuery] int page = 1, [FromQuery] int pageSize = 20, [FromQuery] string? type = null)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var b = Builders<PmProject>.Filter;
        var filter = b.And(
            b.Eq(p => p.IsDeleted, false),
            b.Or(b.Eq(p => p.OwnerId, userId), b.Eq(p => p.LeaderId, userId), b.AnyEq(p => p.MemberIds, userId))
        );
        if (!string.IsNullOrWhiteSpace(type) && PmProjectType.All.Contains(type))
            filter = b.And(filter, b.Eq(p => p.ProjectType, type));

        var total = await _db.PmProjects.CountDocumentsAsync(filter);
        var items = await _db.PmProjects.Find(filter)
            .SortByDescending(p => p.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>项目详情（含任务列表）</summary>
    [HttpGet("projects/{projectId}")]
    public async Task<IActionResult> GetProject(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var tasks = await _db.PmTasks.Find(t => t.ProjectId == projectId)
            .SortBy(t => t.OrderKey).ThenBy(t => t.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { project, tasks }));
    }

    /// <summary>更新项目（含生命周期推进）</summary>
    [HttpPut("projects/{projectId}")]
    public async Task<IActionResult> UpdateProject(string projectId, [FromBody] UpdatePmProjectRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmProject>.Update.Set(p => p.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null) update = update.Set(p => p.Title, request.Title.Trim());
        if (request.Description != null) update = update.Set(p => p.Description, request.Description.Trim());
        if (request.BusinessGoal != null) update = update.Set(p => p.BusinessGoal, request.BusinessGoal.Trim());
        if (request.StrategyAlignment != null) update = update.Set(p => p.StrategyAlignment, request.StrategyAlignment.Trim());
        if (request.PlannedStartAt.HasValue) update = update.Set(p => p.PlannedStartAt, request.PlannedStartAt);
        if (request.PlannedEndAt.HasValue) update = update.Set(p => p.PlannedEndAt, request.PlannedEndAt);
        if (request.Budget.HasValue) update = update.Set(p => p.Budget, request.Budget);
        if (request.ActualCost.HasValue) update = update.Set(p => p.ActualCost, request.ActualCost);
        if (request.ValueCoefficient.HasValue) update = update.Set(p => p.ValueCoefficient, Math.Max(0, request.ValueCoefficient.Value));
        if (request.WipLimits != null) update = update.Set(p => p.WipLimits, request.WipLimits.Where(kv => PmTaskStatus.All.Contains(kv.Key) && kv.Value > 0).ToDictionary(kv => kv.Key, kv => kv.Value));
        if (request.MemberIds != null) update = update.Set(p => p.MemberIds, request.MemberIds);
        if (request.Lifecycle != null && PmProjectLifecycle.All.Contains(request.Lifecycle))
        {
            update = update.Set(p => p.Lifecycle, request.Lifecycle);
            if (request.Lifecycle == PmProjectLifecycle.Closing || request.Lifecycle == PmProjectLifecycle.Evaluated)
                update = update.Set(p => p.ClosedAt, DateTime.UtcNow);
        }

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除项目（软删除 + 级联删除任务）</summary>
    [HttpDelete("projects/{projectId}")]
    public async Task<IActionResult> DeleteProject(string projectId)
    {
        var userId = GetUserId();
        var project = await _db.PmProjects.Find(p => p.Id == projectId && (p.OwnerId == userId || p.LeaderId == userId)).FirstOrDefaultAsync();
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权删除"));

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update.Set(p => p.IsDeleted, true).Set(p => p.UpdatedAt, DateTime.UtcNow));
        await _db.PmTasks.DeleteManyAsync(t => t.ProjectId == projectId);

        _logger.LogInformation("[pm-agent] Project deleted: {ProjectId} by {UserId}", projectId, userId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 干系人 + NPSS 结案评价（Phase 2）
    // ─────────────────────────────────────────────

    /// <summary>整体替换项目干系人列表（权力利益矩阵分类）</summary>
    [HttpPut("projects/{projectId}/stakeholders")]
    public async Task<IActionResult> SetStakeholders(string projectId, [FromBody] SetStakeholdersRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var stakeholders = (request.Stakeholders ?? new()).Select(s => new PmStakeholder
        {
            Id = string.IsNullOrWhiteSpace(s.Id) ? Guid.NewGuid().ToString("N") : s.Id!,
            Name = (s.Name ?? "").Trim(),
            UserId = s.UserId,
            Role = PmStakeholderRole.All.Contains(s.Role ?? "") ? s.Role! : PmStakeholderRole.Other,
            Power = s.Power == PmStakeholderAxis.High ? PmStakeholderAxis.High : PmStakeholderAxis.Low,
            Interest = s.Interest == PmStakeholderAxis.High ? PmStakeholderAxis.High : PmStakeholderAxis.Low,
            // 保留已有打分（若同 Id 已存在）
            Score = project.Stakeholders.FirstOrDefault(e => e.Id == s.Id)?.Score,
        }).Where(s => !string.IsNullOrEmpty(s.Name)).ToList();

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update.Set(p => p.Stakeholders, stakeholders).Set(p => p.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { stakeholders }));
    }

    /// <summary>结案评价（NPSS）：提交干系人打分 → 加权计算满意度 + 等级 → 落库并推进生命周期</summary>
    [HttpPost("projects/{projectId}/evaluate")]
    public async Task<IActionResult> Evaluate(string projectId, [FromBody] EvaluateRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.Stakeholders.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先维护项目干系人，再进行评价"));

        // 应用本次打分（按干系人 Id）
        var scoreMap = request.Scores ?? new();
        foreach (var s in project.Stakeholders)
        {
            if (scoreMap.TryGetValue(s.Id, out var v))
                s.Score = Math.Clamp(v, 0, 10);
        }

        var scored = project.Stakeholders.Where(s => s.Score.HasValue).ToList();
        if (scored.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少需要一位干系人打分"));

        var evaluation = ComputeNpss(scored, userId);

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update
                .Set(p => p.Stakeholders, project.Stakeholders)
                .Set(p => p.Evaluation, evaluation)
                .Set(p => p.Lifecycle, PmProjectLifecycle.Evaluated)
                .Set(p => p.ClosedAt, project.ClosedAt ?? DateTime.UtcNow)
                .Set(p => p.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[pm-agent] Project evaluated: {ProjectId} satisfaction={Score} grade={Grade}",
            projectId, evaluation.SatisfactionScore, evaluation.Grade);
        return Ok(ApiResponse<object>.Ok(new { evaluation }));
    }

    /// <summary>
    /// NPSS 加权满意度计算：按角色组求平均 → 角色权重重归一化（受益方为其他 2 倍）→ 加权汇总。
    /// </summary>
    private static PmEvaluation ComputeNpss(List<PmStakeholder> scored, string evaluatedBy)
    {
        var roleAverages = scored
            .GroupBy(s => s.Role)
            .ToDictionary(g => g.Key, g => g.Average(s => (double)s.Score!.Value));

        // 仅对"在场角色组"重归一化基准权重
        var presentWeightSum = roleAverages.Keys.Sum(r => PmStakeholderRole.BaseWeights.GetValueOrDefault(r, 0.1));
        if (presentWeightSum <= 0) presentWeightSum = 1;

        var weighted10 = roleAverages.Sum(kv =>
            kv.Value * (PmStakeholderRole.BaseWeights.GetValueOrDefault(kv.Key, 0.1) / presentWeightSum));

        return new PmEvaluation
        {
            SatisfactionScore = Math.Round(weighted10 * 10, 1), // 0-100
            Grade = PmEvaluationGrade.FromScore10(weighted10),
            RoleAverages = roleAverages.ToDictionary(kv => kv.Key, kv => Math.Round(kv.Value, 1)),
            EvaluatedAt = DateTime.UtcNow,
            EvaluatedBy = evaluatedBy,
        };
    }

    // ─────────────────────────────────────────────
    // 组织级 NPSS 仪表盘 + 奖金（Phase 3）
    // ─────────────────────────────────────────────

    /// <summary>
    /// 组织级 NPSS 仪表盘（支持财年盘点）：NPSS（成功占比−失败占比）+ 奖金测算 + 等级分布
    /// + 财年/季度盘点 + 优秀项目 + 成本侧进度留痕（按时交付率 / 预算控制率）。
    /// </summary>
    [HttpGet("dashboard")]
    public async Task<IActionResult> Dashboard([FromQuery] int? fiscalYear = null)
    {
        var cfg = await GetOrCreateRewardConfigAsync();
        var startMonth = Math.Clamp(cfg.FiscalYearStartMonth, 1, 12);

        var all = await _db.PmProjects
            .Find(p => !p.IsDeleted && p.Evaluation != null)
            .ToListAsync();

        // 每个项目归属的财年（按评价时间）
        var availableFiscalYears = all
            .Select(p => FiscalYearOf(p.Evaluation!.EvaluatedAt, startMonth))
            .Distinct().OrderByDescending(y => y).ToList();

        // 按财年筛选（未指定则全部）
        var scope = fiscalYear.HasValue
            ? all.Where(p => FiscalYearOf(p.Evaluation!.EvaluatedAt, startMonth) == fiscalYear.Value).ToList()
            : all;

        object BuildStats(List<PmProject> list)
        {
            var s = list.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Success);
            var m = list.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Mediocre);
            var f = list.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Fail);
            var t = list.Count;
            return new
            {
                totalEvaluated = t,
                successCount = s,
                mediocreCount = m,
                failCount = f,
                npss = t > 0 ? (int)Math.Round((s - f) * 100.0 / t) : 0,
                totalBonus = list.Sum(p => ComputeBonus(p, cfg)),
            };
        }

        var rows = scope
            .OrderByDescending(p => p.Evaluation!.EvaluatedAt)
            .Select(p => new
            {
                id = p.Id,
                projectNo = p.ProjectNo,
                title = p.Title,
                projectType = p.ProjectType,
                operationSubType = p.OperationSubType,
                grade = p.Evaluation!.Grade,
                satisfactionScore = p.Evaluation!.SatisfactionScore,
                valueCoefficient = p.ValueCoefficient,
                isExcellent = p.IsExcellent,
                bonus = ComputeBonus(p, cfg),
            })
            .ToList();

        // 季度盘点（仅在选定财年时有意义）
        var quarters = fiscalYear.HasValue
            ? Enumerable.Range(1, 4).Select(q =>
            {
                var qList = scope.Where(p => FiscalQuarterOf(p.Evaluation!.EvaluatedAt, startMonth) == q).ToList();
                return new { quarter = q, stats = BuildStats(qList) };
            }).ToList<object>()
            : new List<object>();

        // 成本侧进度留痕
        var withPlan = scope.Where(p => p.PlannedEndAt.HasValue && p.ClosedAt.HasValue).ToList();
        var onTime = withPlan.Count(p => p.ClosedAt!.Value <= p.PlannedEndAt!.Value);
        var withBudget = scope.Where(p => p.Budget.HasValue && p.Budget.Value > 0 && p.ActualCost.HasValue).ToList();
        var budgetOk = withBudget.Count(p => p.ActualCost!.Value <= p.Budget!.Value);

        var scopeSuccess = scope.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Success);
        var scopeMediocre = scope.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Mediocre);
        var scopeFail = scope.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Fail);
        var scopeNpss = scope.Count > 0 ? (int)Math.Round((scopeSuccess - scopeFail) * 100.0 / scope.Count) : 0;

        return Ok(ApiResponse<object>.Ok(new
        {
            // 兼容旧字段（前端总览直接用）
            totalEvaluated = scope.Count,
            successCount = scopeSuccess,
            mediocreCount = scopeMediocre,
            failCount = scopeFail,
            npss = scopeNpss,
            baseline = 36,
            totalBonus = rows.Sum(r => r.bonus),
            projects = rows,
            rewardConfig = cfg,
            // Phase 4
            fiscalYear,
            availableFiscalYears,
            quarters,
            excellentProjects = rows.Where(r => r.isExcellent).ToList(),
            costMetrics = new
            {
                onTimeRate = withPlan.Count > 0 ? (int)Math.Round(onTime * 100.0 / withPlan.Count) : -1,
                onTimeBase = withPlan.Count,
                budgetControlRate = withBudget.Count > 0 ? (int)Math.Round(budgetOk * 100.0 / withBudget.Count) : -1,
                budgetBase = withBudget.Count,
                totalBudget = scope.Sum(p => p.Budget ?? 0),
                totalActualCost = scope.Sum(p => p.ActualCost ?? 0),
            },
        }));
    }

    private static int FiscalYearOf(DateTime d, int startMonth) => d.Month >= startMonth ? d.Year : d.Year - 1;
    private static int FiscalQuarterOf(DateTime d, int startMonth) => (((d.Month - startMonth) % 12 + 12) % 12) / 3 + 1;

    /// <summary>评选 / 取消评选优秀项目</summary>
    [HttpPost("projects/{projectId}/excellence")]
    public async Task<IActionResult> ToggleExcellence(string projectId, [FromBody] ToggleExcellenceRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmProject>.Update
            .Set(p => p.IsExcellent, request.IsExcellent)
            .Set(p => p.ExcellenceAwardedAt, request.IsExcellent ? DateTime.UtcNow : (DateTime?)null)
            .Set(p => p.UpdatedAt, DateTime.UtcNow);
        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId, update);
        return Ok(ApiResponse<object>.Ok(new { id = projectId, isExcellent = request.IsExcellent }));
    }

    /// <summary>获取奖金配置（PMO 细则）</summary>
    [HttpGet("reward-config")]
    public async Task<IActionResult> GetRewardConfig()
    {
        var cfg = await GetOrCreateRewardConfigAsync();
        return Ok(ApiResponse<object>.Ok(cfg));
    }

    /// <summary>更新奖金配置 + M.O.R.E 组织自评</summary>
    [HttpPut("reward-config")]
    public async Task<IActionResult> UpdateRewardConfig([FromBody] UpdateRewardConfigRequest request)
    {
        var cfg = await GetOrCreateRewardConfigAsync();
        if (request.StrategicBase.HasValue) cfg.StrategicBase = Math.Max(0, request.StrategicBase.Value);
        if (request.InnovationBase.HasValue) cfg.InnovationBase = Math.Max(0, request.InnovationBase.Value);
        if (request.OperationRoutineBase.HasValue) cfg.OperationRoutineBase = Math.Max(0, request.OperationRoutineBase.Value);
        if (request.MoreVision.HasValue) cfg.MoreVision = Math.Clamp(request.MoreVision.Value, 0, 100);
        if (request.MoreOutcome.HasValue) cfg.MoreOutcome = Math.Clamp(request.MoreOutcome.Value, 0, 100);
        if (request.MoreRapid.HasValue) cfg.MoreRapid = Math.Clamp(request.MoreRapid.Value, 0, 100);
        if (request.MoreEmpowered.HasValue) cfg.MoreEmpowered = Math.Clamp(request.MoreEmpowered.Value, 0, 100);
        if (request.FiscalYearStartMonth.HasValue) cfg.FiscalYearStartMonth = Math.Clamp(request.FiscalYearStartMonth.Value, 1, 12);
        if (request.ExcellenceBonusBase.HasValue) cfg.ExcellenceBonusBase = Math.Max(0, request.ExcellenceBonusBase.Value);
        cfg.UpdatedAt = DateTime.UtcNow;

        await _db.PmRewardConfigs.ReplaceOneAsync(c => c.Id == cfg.Id, cfg, new ReplaceOptions { IsUpsert = true });
        return Ok(ApiResponse<object>.Ok(cfg));
    }

    /// <summary>项目奖金计算：基数 × 价值系数 × (满意度/100)；满意度&lt;60 或 定向整改/专项督办 → 0</summary>
    private static decimal ComputeBonus(PmProject p, PmRewardConfig cfg)
    {
        if (p.Evaluation == null) return 0;
        // 定向整改 / 专项督办无奖金
        if (p.ProjectType == PmProjectType.Operation &&
            (p.OperationSubType == PmOperationSubType.Rectification || p.OperationSubType == PmOperationSubType.Supervision))
            return 0;

        var satisfaction = p.Evaluation.SatisfactionScore; // 0-100
        if (satisfaction < 60) return 0;

        var baseAmount = p.ProjectType switch
        {
            PmProjectType.Strategic => cfg.StrategicBase,
            PmProjectType.Innovation => cfg.InnovationBase,
            _ => cfg.OperationRoutineBase,
        };
        // 优秀项目额外叠加优秀奖金基数
        if (p.IsExcellent) baseAmount += cfg.ExcellenceBonusBase;
        return Math.Round(baseAmount * (decimal)p.ValueCoefficient * (decimal)(satisfaction / 100.0), 2);
    }

    private async Task<PmRewardConfig> GetOrCreateRewardConfigAsync()
    {
        var cfg = await _db.PmRewardConfigs.Find(c => c.Id == "default").FirstOrDefaultAsync();
        if (cfg == null)
        {
            cfg = new PmRewardConfig();
            await _db.PmRewardConfigs.InsertOneAsync(cfg);
        }
        return cfg;
    }

    // ─────────────────────────────────────────────
    // 任务 CRUD（看板 / 列表 / 甘特图）
    // ─────────────────────────────────────────────

    /// <summary>创建单个任务</summary>
    [HttpPost("projects/{projectId}/tasks")]
    public async Task<IActionResult> CreateTask(string projectId, [FromBody] CreatePmTaskRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务标题不能为空"));

        var task = new PmTask
        {
            ProjectId = projectId,
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            ParentTaskId = request.ParentTaskId,
            Status = PmTaskStatus.All.Contains(request.Status ?? "") ? request.Status! : PmTaskStatus.Backlog,
            Priority = PmTaskPriority.All.Contains(request.Priority ?? "") ? request.Priority! : PmTaskPriority.None,
            AssigneeId = request.AssigneeId,
            EstimateDays = request.EstimateDays,
            StartAt = request.StartAt,
            DueAt = request.DueAt,
            DependsOn = request.DependsOn ?? new(),
            Labels = request.Labels ?? new(),
            OrderKey = request.OrderKey ?? DateTime.UtcNow.Ticks,
            CreatedBy = userId,
        };
        await FillAssigneeNameAsync(task);
        await _db.PmTasks.InsertOneAsync(task);
        await RecalcTaskCountAsync(projectId);
        return Ok(ApiResponse<object>.Ok(task));
    }

    /// <summary>批量创建任务（确认 AI 拆解草稿 → 落库，dependsOnTitles 映射为 ID）</summary>
    [HttpPost("projects/{projectId}/tasks/batch")]
    public async Task<IActionResult> BatchCreateTasks(string projectId, [FromBody] BatchCreatePmTasksRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (request.Tasks == null || request.Tasks.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务列表为空"));

        var baseOrder = DateTime.UtcNow.Ticks;
        var created = new List<PmTask>();
        // 第一遍：建任务并建立 标题→Id 映射（供依赖映射）
        var titleToId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < request.Tasks.Count; i++)
        {
            var d = request.Tasks[i];
            var task = new PmTask
            {
                ProjectId = projectId,
                Title = (d.Title ?? "未命名任务").Trim(),
                Description = d.Description?.Trim(),
                Status = PmTaskStatus.Backlog,
                Priority = PmTaskPriority.All.Contains(d.Priority ?? "") ? d.Priority! : PmTaskPriority.Medium,
                EstimateDays = d.EstimateDays,
                Labels = d.Labels ?? new(),
                SourceRef = d.SourceRef,
                Source = PmTaskSource.AiDecompose,
                OrderKey = baseOrder + i,
                CreatedBy = userId,
            };
            created.Add(task);
            titleToId[task.Title] = task.Id;
        }
        // 第二遍：映射 dependsOnTitles → DependsOn(ids)
        for (var i = 0; i < request.Tasks.Count; i++)
        {
            var titles = request.Tasks[i].DependsOnTitles ?? new();
            created[i].DependsOn = titles
                .Where(t => titleToId.ContainsKey(t))
                .Select(t => titleToId[t])
                .Where(id => id != created[i].Id)
                .ToList();
        }

        await _db.PmTasks.InsertManyAsync(created);
        await RecalcTaskCountAsync(projectId);
        _logger.LogInformation("[pm-agent] Batch created {Count} tasks for project {ProjectId}", created.Count, projectId);
        return Ok(ApiResponse<object>.Ok(new { items = created, count = created.Count }));
    }

    /// <summary>更新任务（状态/优先级/负责人/时间/排序/依赖）</summary>
    [HttpPut("tasks/{taskId}")]
    public async Task<IActionResult> UpdateTask(string taskId, [FromBody] UpdatePmTaskRequest request)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        var project = await FindAccessibleProjectAsync(task.ProjectId, userId);
        if (project == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));

        var update = Builders<PmTask>.Update.Set(t => t.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null) update = update.Set(t => t.Title, request.Title.Trim());
        if (request.Description != null) update = update.Set(t => t.Description, request.Description.Trim());
        if (request.Status != null && PmTaskStatus.All.Contains(request.Status)) update = update.Set(t => t.Status, request.Status);
        if (request.Priority != null && PmTaskPriority.All.Contains(request.Priority)) update = update.Set(t => t.Priority, request.Priority);
        if (request.AssigneeId != null)
        {
            update = update.Set(t => t.AssigneeId, request.AssigneeId);
            var assignee = await _db.Users.Find(u => u.UserId == request.AssigneeId).FirstOrDefaultAsync();
            update = update.Set(t => t.AssigneeName, assignee?.DisplayName);
        }
        if (request.EstimateDays.HasValue) update = update.Set(t => t.EstimateDays, request.EstimateDays);
        if (request.StartAt.HasValue) update = update.Set(t => t.StartAt, request.StartAt);
        if (request.DueAt.HasValue) update = update.Set(t => t.DueAt, request.DueAt);
        if (request.DependsOn != null) update = update.Set(t => t.DependsOn, request.DependsOn);
        if (request.Labels != null) update = update.Set(t => t.Labels, request.Labels);
        if (request.OrderKey.HasValue) update = update.Set(t => t.OrderKey, request.OrderKey.Value);

        await _db.PmTasks.UpdateOneAsync(t => t.Id == taskId, update);
        if (request.Status != null) await RecalcTaskCountAsync(task.ProjectId);

        // 变更留痕（仅记录关键字段）
        var changes = new List<PmTaskActivity>();
        if (request.Status != null && PmTaskStatus.All.Contains(request.Status) && request.Status != task.Status)
            changes.Add(BuildChange(task, userId, "status", task.Status, request.Status));
        if (request.Priority != null && PmTaskPriority.All.Contains(request.Priority) && request.Priority != task.Priority)
            changes.Add(BuildChange(task, userId, "priority", task.Priority, request.Priority));
        if (request.AssigneeId != null && request.AssigneeId != (task.AssigneeId ?? ""))
            changes.Add(BuildChange(task, userId, "assignee", task.AssigneeName ?? task.AssigneeId, request.AssigneeId));
        if (changes.Count > 0)
        {
            var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
            foreach (var c in changes) c.UserName = actorName;
            await _db.PmTaskActivities.InsertManyAsync(changes);
        }
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    private static PmTaskActivity BuildChange(PmTask task, string userId, string field, string? from, string? to) => new()
    {
        TaskId = task.Id, ProjectId = task.ProjectId, Type = PmActivityType.Change,
        UserId = userId, Field = field, FromValue = from, ToValue = to,
    };

    /// <summary>任务活动记录（评论 + 变更日志）</summary>
    [HttpGet("tasks/{taskId}/activities")]
    public async Task<IActionResult> GetActivities(string taskId)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (await FindAccessibleProjectAsync(task.ProjectId, userId) == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));

        var items = await _db.PmTaskActivities.Find(a => a.TaskId == taskId)
            .SortByDescending(a => a.CreatedAt).Limit(200).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>发表任务评论</summary>
    [HttpPost("tasks/{taskId}/comments")]
    public async Task<IActionResult> AddComment(string taskId, [FromBody] AddCommentRequest request)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (await FindAccessibleProjectAsync(task.ProjectId, userId) == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "评论内容不能为空"));

        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var activity = new PmTaskActivity
        {
            TaskId = taskId, ProjectId = task.ProjectId, Type = PmActivityType.Comment,
            UserId = userId, UserName = actorName, Content = request.Content.Trim(),
        };
        await _db.PmTaskActivities.InsertOneAsync(activity);
        return Ok(ApiResponse<object>.Ok(activity));
    }

    /// <summary>批量操作任务（改状态/优先级/负责人 或 删除）</summary>
    [HttpPost("projects/{projectId}/tasks/bulk")]
    public async Task<IActionResult> BulkTasks(string projectId, [FromBody] BulkTasksRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProjectAsync(projectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        var ids = (request.TaskIds ?? new()).Distinct().ToList();
        if (ids.Count == 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未选择任务"));

        var filter = Builders<PmTask>.Filter.And(
            Builders<PmTask>.Filter.Eq(t => t.ProjectId, projectId),
            Builders<PmTask>.Filter.In(t => t.Id, ids));

        if (request.Delete == true)
        {
            var del = await _db.PmTasks.DeleteManyAsync(filter);
            await RecalcTaskCountAsync(projectId);
            return Ok(ApiResponse<object>.Ok(new { deletedCount = del.DeletedCount }));
        }

        var update = Builders<PmTask>.Update.Set(t => t.UpdatedAt, DateTime.UtcNow);
        var touched = false;
        if (request.Status != null && PmTaskStatus.All.Contains(request.Status)) { update = update.Set(t => t.Status, request.Status); touched = true; }
        if (request.Priority != null && PmTaskPriority.All.Contains(request.Priority)) { update = update.Set(t => t.Priority, request.Priority); touched = true; }
        if (request.AssigneeId != null)
        {
            var assignee = await _db.Users.Find(u => u.UserId == request.AssigneeId).FirstOrDefaultAsync();
            update = update.Set(t => t.AssigneeId, request.AssigneeId).Set(t => t.AssigneeName, assignee?.DisplayName);
            touched = true;
        }
        if (!touched) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无有效变更"));

        var res = await _db.PmTasks.UpdateManyAsync(filter, update);
        if (request.Status != null) await RecalcTaskCountAsync(projectId);
        return Ok(ApiResponse<object>.Ok(new { matched = res.MatchedCount, modified = res.ModifiedCount }));
    }

    /// <summary>删除任务（级联删除子任务 + 清理依赖引用）</summary>
    [HttpDelete("tasks/{taskId}")]
    public async Task<IActionResult> DeleteTask(string taskId)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        var project = await FindAccessibleProjectAsync(task.ProjectId, userId);
        if (project == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));

        // 收集子任务（BFS）
        var toDelete = new List<string> { taskId };
        var queue = new Queue<string>();
        queue.Enqueue(taskId);
        while (queue.Count > 0)
        {
            var pid = queue.Dequeue();
            var children = await _db.PmTasks.Find(t => t.ProjectId == task.ProjectId && t.ParentTaskId == pid).Project(t => t.Id).ToListAsync();
            foreach (var c in children) { toDelete.Add(c); queue.Enqueue(c); }
        }
        var result = await _db.PmTasks.DeleteManyAsync(t => toDelete.Contains(t.Id));
        // 清理其余任务对被删任务的依赖引用
        await _db.PmTasks.UpdateManyAsync(
            t => t.ProjectId == task.ProjectId,
            Builders<PmTask>.Update.PullAll(t => t.DependsOn, toDelete));
        await RecalcTaskCountAsync(task.ProjectId);
        return Ok(ApiResponse<object>.Ok(new { deletedCount = result.DeletedCount }));
    }

    // ─────────────────────────────────────────────
    // AI 需求拆解（SSE 流式，提案不落库）
    // ─────────────────────────────────────────────

    /// <summary>AI 拆解需求为任务草稿（SSE 流式；用户确认后调 tasks/batch 落库）</summary>
    [HttpPost("projects/{projectId}/decompose")]
    [Produces("text/event-stream")]
    public async Task Decompose(string projectId, [FromBody] DecomposeRequest? request = null)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
        {
            Response.StatusCode = 404;
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        await WriteSseEvent("stage", new { stage = "decomposing", message = "正在分析业务目标，拆解任务…" });

        string? llmError = null;
        var count = 0;
        await foreach (var draft in _pmService.DecomposeAsync(
            project, request?.RequirementText, userId,
            onError: err => llmError = err,
            onContent: async text => await WriteSseEvent("typing", new { text }),
            onThinking: async text => await WriteSseEvent("thinking", new { text })))
        {
            count++;
            await WriteSseEvent("task", draft);
            await WriteSseEvent("stage", new { stage = "drafting", message = $"已拆解 {count} 个任务…" });
        }

        if (llmError != null)
            await WriteSseEvent("error", new { message = llmError });
        await WriteSseEvent("done", new { totalNew = count, error = llmError });
    }

    // ── 辅助方法 ──

    private async Task<PmProject?> FindAccessibleProjectAsync(string projectId, string userId)
    {
        var b = Builders<PmProject>.Filter;
        return await _db.PmProjects.Find(b.And(
            b.Eq(p => p.Id, projectId),
            b.Eq(p => p.IsDeleted, false),
            b.Or(b.Eq(p => p.OwnerId, userId), b.Eq(p => p.LeaderId, userId), b.AnyEq(p => p.MemberIds, userId))
        )).FirstOrDefaultAsync();
    }

    private async Task<string> GenerateProjectNoAsync()
    {
        var year = DateTime.UtcNow.Year;
        var prefix = $"PM-{year}-";
        var count = await _db.PmProjects.CountDocumentsAsync(p => p.ProjectNo.StartsWith(prefix));
        return $"{prefix}{(count + 1):D4}";
    }

    private async Task FillAssigneeNameAsync(PmTask task)
    {
        if (string.IsNullOrWhiteSpace(task.AssigneeId)) return;
        var assignee = await _db.Users.Find(u => u.UserId == task.AssigneeId).FirstOrDefaultAsync();
        task.AssigneeName = assignee?.DisplayName;
    }

    private async Task RecalcTaskCountAsync(string projectId)
    {
        var total = await _db.PmTasks.CountDocumentsAsync(t => t.ProjectId == projectId);
        var done = await _db.PmTasks.CountDocumentsAsync(t => t.ProjectId == projectId && t.Status == PmTaskStatus.Done);
        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update
                .Set(p => p.TaskCount, (int)total)
                .Set(p => p.DoneTaskCount, (int)done)
                .Set(p => p.UpdatedAt, DateTime.UtcNow));
    }

    private async Task WriteSseEvent(string eventName, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            await Response.WriteAsync($"event: {eventName}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }
}

// ── 请求模型 ──

public class CreatePmProjectRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string BusinessGoal { get; set; } = string.Empty;
    public string ProjectType { get; set; } = PmProjectType.Operation;
    public string? OperationSubType { get; set; }
    public string? LeaderId { get; set; }
    public List<string>? MemberIds { get; set; }
    public string? StrategyAlignment { get; set; }
    public DateTime? PlannedStartAt { get; set; }
    public DateTime? PlannedEndAt { get; set; }
    public decimal? Budget { get; set; }
}

public class UpdatePmProjectRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? BusinessGoal { get; set; }
    public string? StrategyAlignment { get; set; }
    public string? Lifecycle { get; set; }
    public DateTime? PlannedStartAt { get; set; }
    public DateTime? PlannedEndAt { get; set; }
    public decimal? Budget { get; set; }
    public decimal? ActualCost { get; set; }
    public double? ValueCoefficient { get; set; }
    public Dictionary<string, int>? WipLimits { get; set; }
    public List<string>? MemberIds { get; set; }
}

public class AddCommentRequest
{
    public string Content { get; set; } = string.Empty;
}

public class BulkTasksRequest
{
    public List<string> TaskIds { get; set; } = new();
    public bool? Delete { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
}

public class UpdateRewardConfigRequest
{
    public decimal? StrategicBase { get; set; }
    public decimal? InnovationBase { get; set; }
    public decimal? OperationRoutineBase { get; set; }
    public int? MoreVision { get; set; }
    public int? MoreOutcome { get; set; }
    public int? MoreRapid { get; set; }
    public int? MoreEmpowered { get; set; }
    public int? FiscalYearStartMonth { get; set; }
    public decimal? ExcellenceBonusBase { get; set; }
}

public class ToggleExcellenceRequest
{
    public bool IsExcellent { get; set; }
}

public class CreatePmTaskRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? ParentTaskId { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
    public double? EstimateDays { get; set; }
    public DateTime? StartAt { get; set; }
    public DateTime? DueAt { get; set; }
    public List<string>? DependsOn { get; set; }
    public List<string>? Labels { get; set; }
    public double? OrderKey { get; set; }
}

public class BatchCreatePmTasksRequest
{
    public List<PmTaskDraftInput> Tasks { get; set; } = new();
}

public class PmTaskDraftInput
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Priority { get; set; }
    public double? EstimateDays { get; set; }
    public List<string>? DependsOnTitles { get; set; }
    public string? SourceRef { get; set; }
    public List<string>? Labels { get; set; }
}

public class UpdatePmTaskRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
    public double? EstimateDays { get; set; }
    public DateTime? StartAt { get; set; }
    public DateTime? DueAt { get; set; }
    public List<string>? DependsOn { get; set; }
    public List<string>? Labels { get; set; }
    public double? OrderKey { get; set; }
}

public class DecomposeRequest
{
    /// <summary>可选的需求文档/补充材料文本（零摩擦输入：粘贴/上传后传入）</summary>
    public string? RequirementText { get; set; }
}

public class SetStakeholdersRequest
{
    public List<StakeholderInput> Stakeholders { get; set; } = new();
}

public class StakeholderInput
{
    public string? Id { get; set; }
    public string? Name { get; set; }
    public string? UserId { get; set; }
    public string? Role { get; set; }
    public string? Power { get; set; }
    public string? Interest { get; set; }
}

public class EvaluateRequest
{
    /// <summary>干系人打分：stakeholderId → 分数(0-10)</summary>
    public Dictionary<string, int> Scores { get; set; } = new();
}
