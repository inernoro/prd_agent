using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 系统初始化
/// </summary>
[ApiController]
[Route("api/data/init")]
[Authorize]
[AdminController("data", AdminPermissionCatalog.SettingsWrite)]
public class InitController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<InitController> _logger;

    public InitController(MongoDbContext db, ILogger<InitController> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 初始化默认模型分组
    /// </summary>
    [HttpPost("default-groups")]
    public async Task<IActionResult> InitDefaultGroups()
    {
        var created = new List<string>();

        // 定义4个基础类型的默认分组
        var defaultGroups = new[]
        {
            new { ModelType = ModelTypes.Chat, Name = "默认对话分组", Description = "通用对话模型" },
            new { ModelType = ModelTypes.Intent, Name = "默认意图分组", Description = "快速意图识别模型" },
            new { ModelType = ModelTypes.Vision, Name = "默认视觉分组", Description = "图片识别模型" },
            new { ModelType = ModelTypes.ImageGen, Name = "默认生图分组", Description = "图片生成模型" }
        };

        foreach (var def in defaultGroups)
        {
            // 检查是否已存在
            var existing = await _db.ModelGroups
                .Find(g => g.ModelType == def.ModelType && g.IsDefaultForType)
                .FirstOrDefaultAsync();

            if (existing != null)
            {
                _logger.LogInformation("默认分组已存在: {ModelType}", def.ModelType);
                continue;
            }

            var group = new ModelGroup
            {
                Id = Guid.NewGuid().ToString("N"),
                Name = def.Name,
                ModelType = def.ModelType,
                IsDefaultForType = true,
                Description = def.Description,
                Models = new List<ModelGroupItem>(),
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };

            await _db.ModelGroups.InsertOneAsync(group);
            created.Add(def.ModelType);

            _logger.LogInformation("创建默认分组: {ModelType} - {Name}", def.ModelType, def.Name);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            created,
            message = $"成功创建 {created.Count} 个默认分组"
        }));
    }

    /// <summary>
    /// 迁移现有模型到默认分组
    /// </summary>
    [HttpPost("migrate-models")]
    public async Task<IActionResult> MigrateModels()
    {
        var migrated = 0;

        // 获取所有启用的模型
        var models = await _db.LLMModels.Find(m => m.Enabled).ToListAsync();

        foreach (var model in models)
        {
            string? targetType = null;

            // 根据旧的标记判断模型类型
            if (model.IsMain)
            {
                targetType = ModelTypes.Chat;
            }
            else if (model.IsIntent)
            {
                targetType = ModelTypes.Intent;
            }
            else if (model.IsVision)
            {
                targetType = ModelTypes.Vision;
            }
            else if (model.IsImageGen)
            {
                targetType = ModelTypes.ImageGen;
            }

            if (targetType == null) continue;

            // 查找对应类型的默认分组
            var group = await _db.ModelGroups
                .Find(g => g.ModelType == targetType && g.IsDefaultForType)
                .FirstOrDefaultAsync();

            if (group == null)
            {
                _logger.LogWarning("未找到默认分组: {ModelType}", targetType);
                continue;
            }

            // 检查是否已在分组中
            if (group.Models.Any(m => m.ModelId == model.Id))
            {
                continue;
            }

            // 添加到分组
            group.Models.Add(new ModelGroupItem
            {
                ModelId = model.Id,
                PlatformId = model.PlatformId ?? "",
                Priority = group.Models.Count + 1,
                HealthStatus = ModelHealthStatus.Healthy,
                LastSuccessAt = null,
                LastFailedAt = null,
                ConsecutiveFailures = 0,
                ConsecutiveSuccesses = 0
            });

            group.UpdatedAt = DateTime.UtcNow;

            await _db.ModelGroups.ReplaceOneAsync(g => g.Id == group.Id, group);

            migrated++;

            _logger.LogInformation("迁移模型到分组: {ModelName} -> {GroupName}", model.Name, group.Name);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            migrated,
            message = $"成功迁移 {migrated} 个模型"
        }));
    }

    /// <summary>
    /// 创建默认系统配置
    /// </summary>
    [HttpPost("default-config")]
    public async Task<IActionResult> InitDefaultConfig()
    {
        var existing = await _db.ModelSchedulerConfigs.Find(c => c.Id == "singleton").FirstOrDefaultAsync();

        if (existing != null)
        {
            return Ok(ApiResponse<object>.Ok(new { message = "系统配置已存在" }));
        }

        var config = new ModelSchedulerConfig
        {
            Id = "singleton",
            UpdatedAt = DateTime.UtcNow
        };

        await _db.ModelSchedulerConfigs.InsertOneAsync(config);

        _logger.LogInformation("创建默认系统配置");

        return Ok(ApiResponse<ModelSchedulerConfig>.Ok(config));
    }

    /// <summary>
    /// 初始化应用（全删全插策略）
    /// 策略：
    /// 1. 删除所有 IsSystemDefault=true 的应用
    /// 2. 从代码注册表重新插入最新的系统默认应用
    /// 3. 保留 IsSystemDefault=false 的用户自定义应用
    /// </summary>
    [HttpPost("default-apps")]
    public async Task<IActionResult> InitDefaultApps()
    {
        var deleted = new List<string>();
        var created = new List<string>();

        // 步骤 1：删除所有系统默认应用
        var systemDefaultApps = await _db.LLMAppCallers
            .Find(a => a.IsSystemDefault == true)
            .ToListAsync();

        foreach (var app in systemDefaultApps)
        {
            await _db.LLMAppCallers.DeleteOneAsync(a => a.Id == app.Id);
            deleted.Add(app.AppCode);
            _logger.LogInformation("删除系统默认应用: {AppCode}", app.AppCode);
        }

        // 步骤 2：从注册表获取最新定义
        var definitions = AppCallerRegistrationService.GetAllDefinitions();

        // 步骤 3：重新插入系统默认应用
        foreach (var def in definitions)
        {
            var app = new LLMAppCaller
            {
                Id = Guid.NewGuid().ToString("N"),
                AppCode = def.AppCode,
                DisplayName = def.DisplayName,
                Description = def.Description,
                ModelRequirements = def.ModelTypes.Select(mt => new AppModelRequirement
                {
                    ModelType = mt,
                    Purpose = $"用于{def.DisplayName}",
                    IsRequired = true,
                    ModelGroupId = null // 使用默认分组
                }).ToList(),
                IsSystemDefault = true,  // 标记为系统默认
                IsAutoRegistered = false,
                TotalCalls = 0,
                SuccessCalls = 0,
                FailedCalls = 0,
                LastCalledAt = null,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };

            await _db.LLMAppCallers.InsertOneAsync(app);
            created.Add(def.AppCode);

            _logger.LogInformation("创建系统默认应用: {AppCode} - {DisplayName}", def.AppCode, def.DisplayName);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            deleted,
            created,
            message = $"删除 {deleted.Count} 个旧应用，创建 {created.Count} 个新应用"
        }));
    }
    
    /// <summary>
    /// 全局扫描：从日志中发现未注册的应用（占位符）
    /// TODO: 需要先在 LlmRequestLog 中添加 AppCallerCode 字段
    /// </summary>
    [HttpPost("scan")]
    public Task<IActionResult> ScanApps()
    {
        // 移到这里，与 AppCallers 控制器中的重复方法合并
        return Task.FromResult<IActionResult>(Ok(ApiResponse<object>.Ok(new
        {
            discovered = new List<string>(),
            message = "扫描功能将在日志增强后实现"
        })));
    }

    /// <summary>
    /// 一键初始化（创建分组 + 迁移模型 + 创建配置 + 创建应用）
    /// </summary>
    [HttpPost("all")]
    public async Task<IActionResult> InitAll()
    {
        var results = new List<string>();

        // 1. 创建默认分组
        var groupsResult = await InitDefaultGroups();
        results.Add("默认分组已初始化");

        // 2. 迁移模型
        var migrateResult = await MigrateModels();
        results.Add("模型已迁移到分组");

        // 3. 创建默认配置
        var configResult = await InitDefaultConfig();
        results.Add("系统配置已初始化");

        // 4. 创建默认应用
        var appsResult = await InitDefaultApps();
        results.Add("默认应用已初始化");

        return Ok(ApiResponse<object>.Ok(new
        {
            steps = results,
            message = "系统初始化完成"
        }));
    }
}
