using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 系统初始化
/// </summary>
[ApiController]
[Route("api/v1/admin/init")]
[Authorize]
public class AdminInitController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminInitController> _logger;

    public AdminInitController(MongoDbContext db, ILogger<AdminInitController> logger)
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
    /// 初始化/同步应用（幂等操作）
    /// 策略：
    /// 1. 如果应用不存在 -> 创建新应用
    /// 2. 如果应用已存在 -> 保留用户配置，只更新元数据（DisplayName、Description）
    /// 3. 不会覆盖用户自定义的 ModelRequirements
    /// </summary>
    [HttpPost("default-apps")]
    public async Task<IActionResult> InitDefaultApps()
    {
        var created = new List<string>();
        var updated = new List<string>();
        var skipped = new List<string>();

        // 从注册表获取所有应用定义
        var definitions = AppCallerRegistrationService.GetAllDefinitions();

        foreach (var def in definitions)
        {
            // 检查是否已存在
            var existing = await _db.LLMAppCallers.Find(a => a.AppCode == def.AppCode).FirstOrDefaultAsync();

            if (existing != null)
            {
                // 应用已存在，检查是否需要更新元数据
                bool needsUpdate = false;
                
                // 只更新元数据，不覆盖用户配置
                if (existing.DisplayName != def.DisplayName)
                {
                    existing.DisplayName = def.DisplayName;
                    needsUpdate = true;
                }
                
                if (existing.Description != def.Description)
                {
                    existing.Description = def.Description;
                    needsUpdate = true;
                }
                
                // 如果是自动注册的应用且没有自定义需求，可以更新默认需求
                if (existing.IsAutoRegistered && (existing.ModelRequirements == null || existing.ModelRequirements.Count == 0))
                {
                    existing.ModelRequirements = def.ModelTypes.Select(mt => new AppModelRequirement
                    {
                        ModelType = mt,
                        Purpose = $"用于{def.DisplayName}",
                        IsRequired = true,
                        ModelGroupId = null
                    }).ToList();
                    needsUpdate = true;
                }
                
                if (needsUpdate)
                {
                    existing.UpdatedAt = DateTime.UtcNow;
                    await _db.LLMAppCallers.ReplaceOneAsync(a => a.Id == existing.Id, existing);
                    updated.Add(def.AppCode);
                    _logger.LogInformation("更新应用元数据: {AppCode}", def.AppCode);
                }
                else
                {
                    skipped.Add(def.AppCode);
                    _logger.LogInformation("应用已存在且无需更新: {AppCode}", def.AppCode);
                }
                
                continue;
            }

            // 创建新应用
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
                IsAutoRegistered = false, // 初始化的应用标记为非自动注册
                TotalCalls = 0,
                SuccessCalls = 0,
                FailedCalls = 0,
                LastCalledAt = null,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };

            await _db.LLMAppCallers.InsertOneAsync(app);
            created.Add(def.AppCode);

            _logger.LogInformation("创建应用: {AppCode} - {DisplayName}", def.AppCode, def.DisplayName);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            created,
            updated,
            skipped,
            total = definitions.Count,
            message = $"创建 {created.Count} 个，更新 {updated.Count} 个，跳过 {skipped.Count} 个"
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
        await InitDefaultGroups();
        results.Add("默认分组已初始化");

        // 2. 迁移模型
        await MigrateModels();
        results.Add("模型已迁移到分组");

        // 3. 创建默认配置
        await InitDefaultConfig();
        results.Add("系统配置已初始化");

        // 4. 创建/同步默认应用
        await InitDefaultApps();
        results.Add("默认应用已初始化");

        return Ok(ApiResponse<object>.Ok(new
            {
                AppCode = "chat.sendMessage",
                DisplayName = "聊天消息",
                Description = "用户发送聊天消息时的 LLM 调用",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Chat, Purpose = "生成回复内容", IsRequired = true }
                }
            },
            new
            {
                AppCode = "chat.intentRecognition",
                DisplayName = "意图识别",
                Description = "识别用户消息意图",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Intent, Purpose = "快速识别用户意图", IsRequired = true }
                }
            },
            new
            {
                AppCode = "prd.analyze",
                DisplayName = "PRD 分析",
                Description = "分析 PRD 文档内容",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Chat, Purpose = "分析文档内容", IsRequired = true }
                }
            },
            new
            {
                AppCode = "prd.preview",
                DisplayName = "PRD 预览问答",
                Description = "PRD 文档预览时的问答",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Chat, Purpose = "回答预览问题", IsRequired = true }
                }
            },
            new
            {
                AppCode = "gap.detect",
                DisplayName = "Gap 检测",
                Description = "检测对话中的信息缺口",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Chat, Purpose = "分析信息缺口", IsRequired = true }
                }
            },
            new
            {
                AppCode = "gap.summarize",
                DisplayName = "Gap 总结",
                Description = "总结 Gap 内容",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Chat, Purpose = "生成总结", IsRequired = true }
                }
            },
            new
            {
                AppCode = "imageGen.generate",
                DisplayName = "图片生成",
                Description = "生成图片",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.ImageGen, Purpose = "生成图片", IsRequired = true }
                }
            },
            new
            {
                AppCode = "imageGen.verify",
                DisplayName = "图片验证",
                Description = "验证生成的图片质量",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Vision, Purpose = "验证图片内容", IsRequired = true }
                }
            },
            new
            {
                AppCode = "visualAgent.analyze",
                DisplayName = "视觉 Agent 分析",
                Description = "视觉创作 Agent 的图片分析",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Vision, Purpose = "分析图片内容", IsRequired = true },
                    new { ModelType = ModelTypes.Chat, Purpose = "生成分析报告", IsRequired = true }
                }
            },
            new
            {
                AppCode = "literaryAgent.generate",
                DisplayName = "文学 Agent 生成",
                Description = "文学创作 Agent 的内容生成",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Chat, Purpose = "生成文学内容", IsRequired = true },
                    new { ModelType = ModelTypes.ImageGen, Purpose = "生成配图", IsRequired = false }
                }
            },
            new
            {
                AppCode = "openPlatform.proxy",
                DisplayName = "开放平台代理",
                Description = "开放平台的 LLM 调用代理",
                Requirements = new[]
                {
                    new { ModelType = ModelTypes.Chat, Purpose = "处理第三方请求", IsRequired = true }
                }
            }
        };

        foreach (var def in defaultApps)
        {
            // 检查是否已存在
            var existing = await _db.LLMAppCallers.Find(a => a.AppCode == def.AppCode).FirstOrDefaultAsync();

            if (existing != null)
            {
                _logger.LogInformation("应用已存在: {AppCode}", def.AppCode);
                continue;
            }

            var app = new LLMAppCaller
            {
                Id = Guid.NewGuid().ToString("N"),
                AppCode = def.AppCode,
                DisplayName = def.DisplayName,
                Description = def.Description,
                ModelRequirements = def.Requirements.Select(r => new AppModelRequirement
                {
                    ModelType = r.ModelType,
                    Purpose = r.Purpose,
                    IsRequired = r.IsRequired,
                    ModelGroupId = null // 使用默认分组
                }).ToList(),
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

            _logger.LogInformation("创建默认应用: {AppCode} - {DisplayName}", def.AppCode, def.DisplayName);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            created,
            message = $"成功创建 {created.Count} 个默认应用"
        }));
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
