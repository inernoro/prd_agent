using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 模型调度器系统配置管理
/// </summary>
[ApiController]
[Route("api/v1/admin/scheduler-config")]
[Authorize]
public class AdminSchedulerConfigController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminSchedulerConfigController> _logger;

    public AdminSchedulerConfigController(MongoDbContext db, ILogger<AdminSchedulerConfigController> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 获取系统配置
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetConfig()
    {
        var config = await _db.ModelSchedulerConfigs.Find(c => c.Id == "singleton").FirstOrDefaultAsync();

        if (config == null)
        {
            // 返回默认配置
            config = new ModelSchedulerConfig { Id = "singleton" };
        }

        return Ok(ApiResponse<ModelSchedulerConfig>.Ok(config));
    }

    /// <summary>
    /// 更新系统配置
    /// </summary>
    [HttpPut]
    public async Task<IActionResult> UpdateConfig([FromBody] UpdateSchedulerConfigRequest request)
    {
        var config = await _db.ModelSchedulerConfigs.Find(c => c.Id == "singleton").FirstOrDefaultAsync();

        if (config == null)
        {
            config = new ModelSchedulerConfig { Id = "singleton" };
        }

        // 更新降权策略
        if (request.ConsecutiveFailuresToDegrade.HasValue)
        {
            config.ConsecutiveFailuresToDegrade = request.ConsecutiveFailuresToDegrade.Value;
        }

        if (request.ConsecutiveFailuresToUnavailable.HasValue)
        {
            config.ConsecutiveFailuresToUnavailable = request.ConsecutiveFailuresToUnavailable.Value;
        }

        // 更新健康检查
        if (request.HealthCheckIntervalMinutes.HasValue)
        {
            config.HealthCheckIntervalMinutes = request.HealthCheckIntervalMinutes.Value;
        }

        if (request.HealthCheckTimeoutSeconds.HasValue)
        {
            config.HealthCheckTimeoutSeconds = request.HealthCheckTimeoutSeconds.Value;
        }

        if (!string.IsNullOrEmpty(request.HealthCheckPrompt))
        {
            config.HealthCheckPrompt = request.HealthCheckPrompt;
        }

        // 更新恢复策略
        if (request.AutoRecoveryEnabled.HasValue)
        {
            config.AutoRecoveryEnabled = request.AutoRecoveryEnabled.Value;
        }

        if (request.RecoverySuccessThreshold.HasValue)
        {
            config.RecoverySuccessThreshold = request.RecoverySuccessThreshold.Value;
        }

        // 更新统计配置
        if (request.StatsWindowMinutes.HasValue)
        {
            config.StatsWindowMinutes = request.StatsWindowMinutes.Value;
        }

        config.UpdatedAt = DateTime.UtcNow;

        // Upsert
        await _db.ModelSchedulerConfigs.ReplaceOneAsync(
            c => c.Id == "singleton",
            config,
            new ReplaceOptions { IsUpsert = true });

        _logger.LogInformation("更新调度器配置");

        return Ok(ApiResponse<ModelSchedulerConfig>.Ok(config));
    }
}

public class UpdateSchedulerConfigRequest
{
    public int? ConsecutiveFailuresToDegrade { get; set; }
    public int? ConsecutiveFailuresToUnavailable { get; set; }
    public int? HealthCheckIntervalMinutes { get; set; }
    public int? HealthCheckTimeoutSeconds { get; set; }
    public string? HealthCheckPrompt { get; set; }
    public bool? AutoRecoveryEnabled { get; set; }
    public int? RecoverySuccessThreshold { get; set; }
    public int? StatsWindowMinutes { get; set; }
}
