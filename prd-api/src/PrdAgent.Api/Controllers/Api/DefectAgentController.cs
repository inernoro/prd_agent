using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 缺陷管理 Agent Controller
/// 硬编码 appKey: defect-agent
/// </summary>
[ApiController]
[Route("api/defect-agent")]
[Authorize]
[AdminController("defect-agent", AdminPermissionCatalog.DefectAgentUse, WritePermission = AdminPermissionCatalog.DefectAgentReview)]
public sealed class DefectAgentController : ControllerBase
{
    private const string AppKey = "defect-agent";
    private const string RunKindReview = "defect-review";
    private const string RunKindFix = "defect-fix";

    private readonly MongoDbContext _db;
    private readonly IRunQueue _runQueue;
    private readonly IRunEventStore _runStore;
    private readonly ILogger<DefectAgentController> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public DefectAgentController(
        MongoDbContext db,
        IRunQueue runQueue,
        IRunEventStore runStore,
        ILogger<DefectAgentController> logger)
    {
        _db = db;
        _runQueue = runQueue;
        _runStore = runStore;
        _logger = logger;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    // ===========================
    // 缺陷 CRUD
    // ===========================

    /// <summary>创建缺陷</summary>
    [HttpPost("defects")]
    public async Task<IActionResult> CreateDefect([FromBody] CreateDefectRequest request)
    {
        var adminId = GetAdminId();
        _logger.LogInformation("[{AppKey}] CreateDefect by {UserId}", AppKey, adminId);

        var defect = new DefectReport
        {
            OwnerUserId = adminId,
            Title = request.Title,
            Description = request.Description ?? string.Empty,
            ReproSteps = request.ReproSteps ?? new(),
            ExpectedBehavior = request.ExpectedBehavior,
            ActualBehavior = request.ActualBehavior,
            Environment = request.Environment,
            AttachmentIds = request.AttachmentIds ?? new(),
            RepoConfigId = request.RepoConfigId,
            ProductId = request.ProductId,
            ModuleId = request.ModuleId,
            Tags = request.Tags ?? new(),
            Status = DefectStatus.Draft,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefectReports.InsertOneAsync(defect);
        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>列表查询</summary>
    [HttpGet("defects")]
    public async Task<IActionResult> ListDefects(
        [FromQuery] string? status = null,
        [FromQuery] string? priority = null,
        [FromQuery] int limit = 50,
        [FromQuery] int offset = 0)
    {
        var filter = Builders<DefectReport>.Filter.Empty;

        if (!string.IsNullOrEmpty(status) && Enum.TryParse<DefectStatus>(status, true, out var s))
            filter &= Builders<DefectReport>.Filter.Eq(x => x.Status, s);

        if (!string.IsNullOrEmpty(priority) && Enum.TryParse<DefectPriority>(priority, true, out var p))
            filter &= Builders<DefectReport>.Filter.Eq(x => x.Priority, p);

        var total = await _db.DefectReports.CountDocumentsAsync(filter);
        var items = await _db.DefectReports
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip(offset)
            .Limit(limit)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>获取详情</summary>
    [HttpGet("defects/{id}")]
    public async Task<IActionResult> GetDefect(string id)
    {
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));
        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>更新缺陷</summary>
    [HttpPut("defects/{id}")]
    public async Task<IActionResult> UpdateDefect(string id, [FromBody] UpdateDefectRequest request)
    {
        var adminId = GetAdminId();
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));
        if (defect.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail("FORBIDDEN", "无权编辑"));

        var update = Builders<DefectReport>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null) update = update.Set(x => x.Title, request.Title);
        if (request.Description != null) update = update.Set(x => x.Description, request.Description);
        if (request.ReproSteps != null) update = update.Set(x => x.ReproSteps, request.ReproSteps);
        if (request.ExpectedBehavior != null) update = update.Set(x => x.ExpectedBehavior, request.ExpectedBehavior);
        if (request.ActualBehavior != null) update = update.Set(x => x.ActualBehavior, request.ActualBehavior);
        if (request.Environment != null) update = update.Set(x => x.Environment, request.Environment);
        if (request.AttachmentIds != null) update = update.Set(x => x.AttachmentIds, request.AttachmentIds);
        if (request.Tags != null) update = update.Set(x => x.Tags, request.Tags);
        if (request.RepoConfigId != null) update = update.Set(x => x.RepoConfigId, request.RepoConfigId);

        await _db.DefectReports.UpdateOneAsync(x => x.Id == id, update);
        var updated = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { defect = updated }));
    }

    /// <summary>删除草稿</summary>
    [HttpDelete("defects/{id}")]
    public async Task<IActionResult> DeleteDefect(string id)
    {
        var adminId = GetAdminId();
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));
        if (defect.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail("FORBIDDEN", "无权删除"));
        if (defect.Status != DefectStatus.Draft)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只能删除草稿状态的缺陷"));

        await _db.DefectReports.DeleteOneAsync(x => x.Id == id);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ===========================
    // 状态操作
    // ===========================

    /// <summary>提交审核</summary>
    [HttpPost("defects/{id}/submit")]
    public async Task<IActionResult> SubmitDefect(string id)
    {
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));
        if (defect.Status != DefectStatus.Draft && defect.Status != DefectStatus.Rejected)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "当前状态不可提交"));

        await _db.DefectReports.UpdateOneAsync(
            x => x.Id == id,
            Builders<DefectReport>.Update
                .Set(x => x.Status, DefectStatus.Submitted)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        // 创建 AI 审核 Run
        var runId = Guid.NewGuid().ToString("N");
        await _runStore.SetRunAsync(RunKindReview, new RunMeta
        {
            RunId = runId,
            Status = RunStatuses.Queued,
            InputJson = JsonSerializer.Serialize(new { defectId = id }, JsonOptions)
        });
        await _runQueue.EnqueueAsync(RunKindReview, runId);

        _logger.LogInformation("[{AppKey}] Defect {DefectId} submitted, run {RunId} queued", AppKey, id, runId);
        return Ok(ApiResponse<object>.Ok(new { runId }));
    }

    /// <summary>触发修复</summary>
    [HttpPost("defects/{id}/fix")]
    public async Task<IActionResult> TriggerFix(string id)
    {
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));
        if (defect.Status != DefectStatus.Analyzed)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有已分析状态可触发修复"));

        await _db.DefectReports.UpdateOneAsync(
            x => x.Id == id,
            Builders<DefectReport>.Update
                .Set(x => x.Status, DefectStatus.Fixing)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        var runId = Guid.NewGuid().ToString("N");
        await _runStore.SetRunAsync(RunKindFix, new RunMeta
        {
            RunId = runId,
            Status = RunStatuses.Queued,
            InputJson = JsonSerializer.Serialize(new { defectId = id }, JsonOptions)
        });
        await _runQueue.EnqueueAsync(RunKindFix, runId);

        _logger.LogInformation("[{AppKey}] Defect {DefectId} fix triggered, run {RunId} queued", AppKey, id, runId);
        return Ok(ApiResponse<object>.Ok(new { runId }));
    }

    /// <summary>确认修复</summary>
    [HttpPost("defects/{id}/verify")]
    public async Task<IActionResult> VerifyFix(string id)
    {
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));
        if (defect.Status != DefectStatus.Merged)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有已合并状态可验证"));

        await _db.DefectReports.UpdateOneAsync(
            x => x.Id == id,
            Builders<DefectReport>.Update
                .Set(x => x.Status, DefectStatus.Verified)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { verified = true }));
    }

    /// <summary>关闭缺陷</summary>
    [HttpPost("defects/{id}/close")]
    public async Task<IActionResult> CloseDefect(string id)
    {
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));

        await _db.DefectReports.UpdateOneAsync(
            x => x.Id == id,
            Builders<DefectReport>.Update
                .Set(x => x.Status, DefectStatus.Closed)
                .Set(x => x.ClosedAt, DateTime.UtcNow)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { closed = true }));
    }

    /// <summary>重新打开/申诉</summary>
    [HttpPost("defects/{id}/reopen")]
    public async Task<IActionResult> ReopenDefect(string id)
    {
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));

        await _db.DefectReports.UpdateOneAsync(
            x => x.Id == id,
            Builders<DefectReport>.Update
                .Set(x => x.Status, DefectStatus.Submitted)
                .Set(x => x.ClosedAt, (DateTime?)null)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { reopened = true }));
    }

    // ===========================
    // 审核与修复记录
    // ===========================

    /// <summary>获取审核记录</summary>
    [HttpGet("defects/{id}/reviews")]
    public async Task<IActionResult> GetReviews(string id)
    {
        var reviews = await _db.DefectReviews
            .Find(x => x.DefectId == id)
            .SortBy(x => x.CreatedAt)
            .ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { reviews }));
    }

    /// <summary>获取修复记录</summary>
    [HttpGet("defects/{id}/fixes")]
    public async Task<IActionResult> GetFixes(string id)
    {
        var fixes = await _db.DefectFixes
            .Find(x => x.DefectId == id)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { fixes }));
    }

    // ===========================
    // Run / SSE
    // ===========================

    /// <summary>创建 AI 处理任务</summary>
    [HttpPost("defects/{id}/runs")]
    public async Task<IActionResult> CreateRun(string id, [FromBody] CreateRunRequest? request = null)
    {
        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "缺陷不存在"));

        var kind = request?.Kind ?? RunKindReview;
        var runId = Guid.NewGuid().ToString("N");

        await _runStore.SetRunAsync(kind, new RunMeta
        {
            RunId = runId,
            Status = RunStatuses.Queued,
            InputJson = JsonSerializer.Serialize(new { defectId = id }, JsonOptions)
        });
        await _runQueue.EnqueueAsync(kind, runId);

        return Ok(ApiResponse<object>.Ok(new { runId, kind }));
    }

    /// <summary>SSE 实时流</summary>
    [HttpGet("runs/{runId}/stream")]
    public async Task GetRunStream(string runId, [FromQuery] long afterSeq = 0, [FromQuery] string? kind = null)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["Connection"] = "keep-alive";

        var resolvedKind = kind ?? RunKindReview;
        var seq = afterSeq;
        var emptyCount = 0;

        while (!HttpContext.RequestAborted.IsCancellationRequested && emptyCount < 300)
        {
            var events = await _runStore.GetEventsAsync(resolvedKind, runId, seq, 50);
            if (events.Count > 0)
            {
                emptyCount = 0;
                foreach (var evt in events)
                {
                    seq = evt.Seq;
                    var data = JsonSerializer.Serialize(new { seq = evt.Seq, name = evt.EventName, payload = evt.PayloadJson }, JsonOptions);
                    await Response.WriteAsync($"data: {data}\n\n", HttpContext.RequestAborted);
                    await Response.Body.FlushAsync(HttpContext.RequestAborted);
                }

                // Check for terminal events
                var meta = await _runStore.GetRunAsync(resolvedKind, runId);
                if (meta?.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled)
                {
                    await Response.WriteAsync($"data: {{\"seq\":{seq},\"name\":\"done\",\"payload\":{{\"status\":\"{meta.Status}\"}}}}\n\n", HttpContext.RequestAborted);
                    await Response.Body.FlushAsync(HttpContext.RequestAborted);
                    break;
                }
            }
            else
            {
                emptyCount++;
                await Task.Delay(200, HttpContext.RequestAborted);
            }
        }
    }

    // ===========================
    // 仓库配置
    // ===========================

    /// <summary>添加仓库配置</summary>
    [HttpPost("repos")]
    public async Task<IActionResult> CreateRepoConfig([FromBody] CreateRepoConfigRequest request)
    {
        var adminId = GetAdminId();
        var config = new DefectRepoConfig
        {
            OwnerUserId = adminId,
            RepoOwner = request.RepoOwner,
            RepoName = request.RepoName,
            DefaultBranch = request.DefaultBranch ?? "main",
            PrBranchPrefix = request.PrBranchPrefix ?? "defect-agent/fix-",
            DefaultReviewers = request.DefaultReviewers ?? new(),
            DefaultLabels = request.DefaultLabels ?? new() { "bug", "ai-fix" },
            AuthMethod = request.AuthMethod,
            InstallationId = request.InstallationId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefectRepoConfigs.InsertOneAsync(config);
        return Ok(ApiResponse<object>.Ok(new { config }));
    }

    /// <summary>列表仓库配置</summary>
    [HttpGet("repos")]
    public async Task<IActionResult> ListRepoConfigs()
    {
        var configs = await _db.DefectRepoConfigs
            .Find(Builders<DefectRepoConfig>.Filter.Empty)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { configs }));
    }

    /// <summary>更新仓库配置</summary>
    [HttpPut("repos/{id}")]
    public async Task<IActionResult> UpdateRepoConfig(string id, [FromBody] UpdateRepoConfigRequest request)
    {
        var update = Builders<DefectRepoConfig>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.DefaultBranch != null) update = update.Set(x => x.DefaultBranch, request.DefaultBranch);
        if (request.PrBranchPrefix != null) update = update.Set(x => x.PrBranchPrefix, request.PrBranchPrefix);
        if (request.DefaultReviewers != null) update = update.Set(x => x.DefaultReviewers, request.DefaultReviewers);
        if (request.DefaultLabels != null) update = update.Set(x => x.DefaultLabels, request.DefaultLabels);
        if (request.IsActive.HasValue) update = update.Set(x => x.IsActive, request.IsActive.Value);

        var result = await _db.DefectRepoConfigs.UpdateOneAsync(x => x.Id == id, update);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "配置不存在"));

        var updated = await _db.DefectRepoConfigs.Find(x => x.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { config = updated }));
    }

    /// <summary>删除仓库配置</summary>
    [HttpDelete("repos/{id}")]
    public async Task<IActionResult> DeleteRepoConfig(string id)
    {
        var result = await _db.DefectRepoConfigs.DeleteOneAsync(x => x.Id == id);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "配置不存在"));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ===========================
    // 统计
    // ===========================

    /// <summary>统计概览</summary>
    [HttpGet("stats")]
    public async Task<IActionResult> GetStats()
    {
        var total = await _db.DefectReports.CountDocumentsAsync(Builders<DefectReport>.Filter.Empty);
        var open = await _db.DefectReports.CountDocumentsAsync(
            Builders<DefectReport>.Filter.Nin(x => x.Status, new[] { DefectStatus.Closed, DefectStatus.Verified }));
        var fixed = await _db.DefectReports.CountDocumentsAsync(
            Builders<DefectReport>.Filter.In(x => x.Status, new[] { DefectStatus.Merged, DefectStatus.Verified, DefectStatus.Closed }));

        return Ok(ApiResponse<object>.Ok(new { total, open, @fixed = fixed }));
    }

    /// <summary>健康检查</summary>
    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(ApiResponse<object>.Ok(new { status = "ok", appKey = AppKey }));
    }
}

// ===========================
// 请求模型
// ===========================

public class CreateDefectRequest
{
    public string Title { get; set; } = null!;
    public string? Description { get; set; }
    public List<string>? ReproSteps { get; set; }
    public string? ExpectedBehavior { get; set; }
    public string? ActualBehavior { get; set; }
    public DefectEnvironment? Environment { get; set; }
    public List<string>? AttachmentIds { get; set; }
    public string? RepoConfigId { get; set; }
    public string? ProductId { get; set; }
    public string? ModuleId { get; set; }
    public List<string>? Tags { get; set; }
}

public class UpdateDefectRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public List<string>? ReproSteps { get; set; }
    public string? ExpectedBehavior { get; set; }
    public string? ActualBehavior { get; set; }
    public DefectEnvironment? Environment { get; set; }
    public List<string>? AttachmentIds { get; set; }
    public List<string>? Tags { get; set; }
    public string? RepoConfigId { get; set; }
}

public class CreateRunRequest
{
    public string? Kind { get; set; }
}

public class CreateRepoConfigRequest
{
    public string RepoOwner { get; set; } = null!;
    public string RepoName { get; set; } = null!;
    public string? DefaultBranch { get; set; }
    public string? PrBranchPrefix { get; set; }
    public List<string>? DefaultReviewers { get; set; }
    public List<string>? DefaultLabels { get; set; }
    public GitHubAuthMethod AuthMethod { get; set; }
    public string? InstallationId { get; set; }
}

public class UpdateRepoConfigRequest
{
    public string? DefaultBranch { get; set; }
    public string? PrBranchPrefix { get; set; }
    public List<string>? DefaultReviewers { get; set; }
    public List<string>? DefaultLabels { get; set; }
    public bool? IsActive { get; set; }
}
