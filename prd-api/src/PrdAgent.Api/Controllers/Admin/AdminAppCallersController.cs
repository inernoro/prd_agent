using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 应用调用者管理
/// </summary>
[ApiController]
[Route("api/v1/admin/app-callers")]
[Authorize]
public class AdminAppCallersController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminAppCallersController> _logger;

    public AdminAppCallersController(MongoDbContext db, ILogger<AdminAppCallersController> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 获取应用列表
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetAppCallers([FromQuery] int page = 1, [FromQuery] int pageSize = 50)
    {
        var skip = (page - 1) * pageSize;

        var total = await _db.LLMAppCallers.CountDocumentsAsync(_ => true);

        var apps = await _db.LLMAppCallers
            .Find(_ => true)
            .SortByDescending(a => a.LastCalledAt)
            .Skip(skip)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new
        {
            items = apps,
            total,
            page,
            pageSize
        }));
    }

    /// <summary>
    /// 获取单个应用
    /// </summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetAppCaller(string id)
    {
        var app = await _db.LLMAppCallers.Find(a => a.Id == id).FirstOrDefaultAsync();

        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail("APP_CALLER_NOT_FOUND", "应用不存在"));
        }

        return Ok(ApiResponse<LLMAppCaller>.Ok(app));
    }

    /// <summary>
    /// 创建应用
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateAppCaller([FromBody] CreateAppCallerRequest request)
    {
        // 检查 appCode 是否已存在
        var existing = await _db.LLMAppCallers.Find(a => a.AppCode == request.AppCode).FirstOrDefaultAsync();

        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("APP_CODE_EXISTS", "应用标识已存在"));
        }

        var app = new LLMAppCaller
        {
            Id = Guid.NewGuid().ToString("N"),
            AppCode = request.AppCode,
            DisplayName = request.DisplayName ?? request.AppCode,
            Description = request.Description,
            ModelRequirements = request.ModelRequirements ?? new List<AppModelRequirement>(),
            IsAutoRegistered = false,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.LLMAppCallers.InsertOneAsync(app);

        _logger.LogInformation("创建应用: {AppCode}", app.AppCode);

        return Ok(ApiResponse<LLMAppCaller>.Ok(app));
    }

    /// <summary>
    /// 更新应用
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateAppCaller(string id, [FromBody] UpdateAppCallerRequest request)
    {
        var app = await _db.LLMAppCallers.Find(a => a.Id == id).FirstOrDefaultAsync();

        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail("APP_CALLER_NOT_FOUND", "应用不存在"));
        }

        // 更新基本信息
        if (!string.IsNullOrEmpty(request.DisplayName))
        {
            app.DisplayName = request.DisplayName;
        }

        if (request.Description != null)
        {
            app.Description = request.Description;
        }

        // 更新模型需求
        if (request.ModelRequirements != null)
        {
            app.ModelRequirements = request.ModelRequirements;
        }

        app.UpdatedAt = DateTime.UtcNow;

        await _db.LLMAppCallers.ReplaceOneAsync(a => a.Id == id, app);

        _logger.LogInformation("更新应用: {AppCode}", app.AppCode);

        return Ok(ApiResponse<LLMAppCaller>.Ok(app));
    }

    /// <summary>
    /// 删除应用
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteAppCaller(string id)
    {
        var app = await _db.LLMAppCallers.Find(a => a.Id == id).FirstOrDefaultAsync();

        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail("APP_CALLER_NOT_FOUND", "应用不存在"));
        }

        await _db.LLMAppCallers.DeleteOneAsync(a => a.Id == id);

        _logger.LogInformation("删除应用: {AppCode}", app.AppCode);

        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 获取应用调用统计
    /// </summary>
    [HttpGet("{id}/stats")]
    public async Task<IActionResult> GetAppCallerStats(string id)
    {
        var app = await _db.LLMAppCallers.Find(a => a.Id == id).FirstOrDefaultAsync();

        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail("APP_CALLER_NOT_FOUND", "应用不存在"));
        }

        // 计算成功率
        var successRate = app.TotalCalls > 0
            ? (double)app.SuccessCalls / app.TotalCalls * 100
            : 0;

        var stats = new
        {
            appCode = app.AppCode,
            displayName = app.DisplayName,
            totalCalls = app.TotalCalls,
            successCalls = app.SuccessCalls,
            failedCalls = app.FailedCalls,
            successRate = Math.Round(successRate, 2),
            lastCalledAt = app.LastCalledAt,
            modelRequirements = app.ModelRequirements
        };

        return Ok(ApiResponse<object>.Ok(stats));
    }

    /// <summary>
    /// 全局扫描：从日志中发现未注册的应用
    /// </summary>
    [HttpPost("scan")]
    public Task<IActionResult> ScanApps()
    {
        // TODO: 实现从 LlmRequestLog 中扫描 AppCallerCode 的逻辑
        // 当前返回空列表
        return Task.FromResult<IActionResult>(Ok(ApiResponse<object>.Ok(new
        {
            discovered = new List<string>(),
            message = "扫描功能将在日志增强后实现"
        })));
    }
}

public class CreateAppCallerRequest
{
    public string AppCode { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public string? Description { get; set; }
    public List<AppModelRequirement>? ModelRequirements { get; set; }
}

public class UpdateAppCallerRequest
{
    public string? DisplayName { get; set; }
    public string? Description { get; set; }
    public List<AppModelRequirement>? ModelRequirements { get; set; }
}
