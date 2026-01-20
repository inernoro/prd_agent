using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 模型测试与故障模拟
/// </summary>
[ApiController]
[Route("api/lab/model-test")]
[Authorize]
[AdminController("mds", AdminPermissionCatalog.ModelsRead, WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class ModelTestController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ISmartModelScheduler _scheduler;
    private readonly ILogger<ModelTestController> _logger;

    public ModelTestController(
        MongoDbContext db,
        ISmartModelScheduler scheduler,
        ILogger<ModelTestController> logger)
    {
        _db = db;
        _scheduler = scheduler;
        _logger = logger;
    }

    /// <summary>
    /// 获取所有测试桩配置
    /// </summary>
    [HttpGet("stubs")]
    public async Task<IActionResult> GetTestStubs()
    {
        var stubs = await _db.ModelTestStubs.Find(_ => true).ToListAsync();
        return Ok(ApiResponse<List<ModelTestStub>>.Ok(stubs));
    }

    /// <summary>
    /// 创建或更新测试桩配置
    /// </summary>
    [HttpPut("stubs")]
    public async Task<IActionResult> UpsertTestStub([FromBody] UpsertTestStubRequest request)
    {
        var existing = await _db.ModelTestStubs
            .Find(s => s.ModelId == request.ModelId && s.PlatformId == request.PlatformId)
            .FirstOrDefaultAsync();

        if (existing != null)
        {
            // 更新现有配置
            existing.Enabled = request.Enabled;
            existing.FailureMode = request.FailureMode;
            existing.FailureRate = request.FailureRate;
            existing.LatencyMs = request.LatencyMs;
            existing.ErrorMessage = request.ErrorMessage;
            existing.Description = request.Description;
            existing.UpdatedAt = DateTime.UtcNow;

            await _db.ModelTestStubs.ReplaceOneAsync(s => s.Id == existing.Id, existing);

            _logger.LogInformation(
                "更新测试桩: {ModelId}, 模式: {FailureMode}, 失败率: {FailureRate}%",
                request.ModelId,
                request.FailureMode,
                request.FailureRate);

            return Ok(ApiResponse<ModelTestStub>.Ok(existing));
        }
        else
        {
            // 创建新配置
            var stub = new ModelTestStub
            {
                Id = Guid.NewGuid().ToString("N"),
                ModelId = request.ModelId,
                PlatformId = request.PlatformId,
                Enabled = request.Enabled,
                FailureMode = request.FailureMode,
                FailureRate = request.FailureRate,
                LatencyMs = request.LatencyMs,
                ErrorMessage = request.ErrorMessage,
                Description = request.Description,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };

            await _db.ModelTestStubs.InsertOneAsync(stub);

            _logger.LogInformation(
                "创建测试桩: {ModelId}, 模式: {FailureMode}, 失败率: {FailureRate}%",
                request.ModelId,
                request.FailureMode,
                request.FailureRate);

            return Ok(ApiResponse<ModelTestStub>.Ok(stub));
        }
    }

    /// <summary>
    /// 删除测试桩配置
    /// </summary>
    [HttpDelete("stubs/{id}")]
    public async Task<IActionResult> DeleteTestStub(string id)
    {
        var result = await _db.ModelTestStubs.DeleteOneAsync(s => s.Id == id);

        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("STUB_NOT_FOUND", "测试桩不存在"));
        }

        _logger.LogInformation("删除测试桩: {StubId}", id);

        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 清空所有测试桩配置
    /// </summary>
    [HttpPost("stubs/clear")]
    public async Task<IActionResult> ClearTestStubs()
    {
        var result = await _db.ModelTestStubs.DeleteManyAsync(_ => true);

        _logger.LogInformation("清空所有测试桩，共删除 {Count} 个", result.DeletedCount);

        return Ok(ApiResponse<object>.Ok(new
        {
            deletedCount = result.DeletedCount,
            message = $"已清空 {result.DeletedCount} 个测试桩配置"
        }));
    }

    /// <summary>
    /// 模拟故障：手动触发模型降权
    /// </summary>
    [HttpPost("simulate/downgrade")]
    public async Task<IActionResult> SimulateDowngrade([FromBody] SimulateDowngradeRequest request)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == request.GroupId).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "分组不存在"));
        }

        var modelItem = group.Models.FirstOrDefault(m =>
            m.ModelId == request.ModelId && m.PlatformId == request.PlatformId);

        if (modelItem == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不在该分组中"));
        }

        // 模拟连续失败
        for (int i = 0; i < request.FailureCount; i++)
        {
            await _scheduler.RecordCallResultAsync(
                request.GroupId,
                request.ModelId,
                request.PlatformId,
                false,
                "模拟故障");
        }

        _logger.LogInformation(
            "模拟降权: {ModelId}, 失败次数: {Count}",
            request.ModelId,
            request.FailureCount);

        // 重新获取更新后的分组
        group = await _db.ModelGroups.Find(g => g.Id == request.GroupId).FirstOrDefaultAsync();
        modelItem = group?.Models.FirstOrDefault(m =>
            m.ModelId == request.ModelId && m.PlatformId == request.PlatformId);

        return Ok(ApiResponse<object>.Ok(new
        {
            modelId = request.ModelId,
            healthStatus = modelItem?.HealthStatus.ToString(),
            consecutiveFailures = modelItem?.ConsecutiveFailures,
            message = "已模拟故障"
        }));
    }

    /// <summary>
    /// 模拟恢复：手动触发模型恢复
    /// </summary>
    [HttpPost("simulate/recover")]
    public async Task<IActionResult> SimulateRecover([FromBody] SimulateRecoverRequest request)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == request.GroupId).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "分组不存在"));
        }

        var modelItem = group.Models.FirstOrDefault(m =>
            m.ModelId == request.ModelId && m.PlatformId == request.PlatformId);

        if (modelItem == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不在该分组中"));
        }

        // 模拟连续成功
        for (int i = 0; i < request.SuccessCount; i++)
        {
            await _scheduler.RecordCallResultAsync(
                request.GroupId,
                request.ModelId,
                request.PlatformId,
                true);
        }

        _logger.LogInformation(
            "模拟恢复: {ModelId}, 成功次数: {Count}",
            request.ModelId,
            request.SuccessCount);

        // 重新获取更新后的分组
        group = await _db.ModelGroups.Find(g => g.Id == request.GroupId).FirstOrDefaultAsync();
        modelItem = group?.Models.FirstOrDefault(m =>
            m.ModelId == request.ModelId && m.PlatformId == request.PlatformId);

        return Ok(ApiResponse<object>.Ok(new
        {
            modelId = request.ModelId,
            healthStatus = modelItem?.HealthStatus.ToString(),
            consecutiveSuccesses = modelItem?.ConsecutiveSuccesses,
            message = "已模拟恢复"
        }));
    }

    /// <summary>
    /// 执行健康检查（手动触发）
    /// </summary>
    [HttpPost("health-check")]
    public async Task<IActionResult> TriggerHealthCheck()
    {
        _logger.LogInformation("手动触发健康检查");

        await _scheduler.HealthCheckAsync();

        return Ok(ApiResponse<object>.Ok(new
        {
            message = "健康检查已执行"
        }));
    }

    /// <summary>
    /// 获取分组监控数据
    /// </summary>
    [HttpGet("groups/{groupId}/monitoring")]
    public async Task<IActionResult> GetGroupMonitoring(string groupId)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "分组不存在"));
        }

        var monitoring = group.Models.Select(m => new
        {
            modelId = m.ModelId,
            platformId = m.PlatformId,
            priority = m.Priority,
            healthStatus = m.HealthStatus.ToString(),
            consecutiveFailures = m.ConsecutiveFailures,
            consecutiveSuccesses = m.ConsecutiveSuccesses,
            lastFailedAt = m.LastFailedAt,
            lastSuccessAt = m.LastSuccessAt,
            // 计算健康度评分（0-100）
            healthScore = CalculateHealthScore(m)
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            groupId,
            groupName = group.Name,
            modelType = group.ModelType,
            models = monitoring
        }));
    }

    private int CalculateHealthScore(ModelGroupItem model)
    {
        if (model.HealthStatus == ModelHealthStatus.Unavailable)
        {
            return 0;
        }

        if (model.HealthStatus == ModelHealthStatus.Degraded)
        {
            return 50 - (model.ConsecutiveFailures * 10);
        }

        // Healthy
        var score = 100;

        // 如果有失败记录，稍微降低分数
        if (model.LastFailedAt.HasValue)
        {
            var hoursSinceFailure = (DateTime.UtcNow - model.LastFailedAt.Value).TotalHours;
            if (hoursSinceFailure < 1)
            {
                score -= 10;
            }
        }

        return Math.Max(0, score);
    }
}

public class UpsertTestStubRequest
{
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public FailureMode FailureMode { get; set; } = FailureMode.None;
    public int FailureRate { get; set; } = 0; // 0-100
    public int LatencyMs { get; set; } = 0;
    public string? ErrorMessage { get; set; }
    public string? Description { get; set; }
}

public class SimulateDowngradeRequest
{
    public string GroupId { get; set; } = string.Empty;
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;
    public int FailureCount { get; set; } = 3;
}

public class SimulateRecoverRequest
{
    public string GroupId { get; set; } = string.Empty;
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;
    public int SuccessCount { get; set; } = 2;
}
