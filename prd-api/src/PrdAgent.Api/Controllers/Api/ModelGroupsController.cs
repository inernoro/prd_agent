using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 模型分组管理
/// </summary>
[ApiController]
[Route("api/mds/model-groups")]
[Authorize]
[AdminController("mds", AdminPermissionCatalog.ModelsRead, WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class ModelGroupsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IModelPoolQueryService _modelPoolQuery;
    private readonly ILogger<ModelGroupsController> _logger;
    private readonly IConfiguration _config;

    public ModelGroupsController(MongoDbContext db, IModelPoolQueryService modelPoolQuery, ILogger<ModelGroupsController> logger, IConfiguration config)
    {
        _db = db;
        _modelPoolQuery = modelPoolQuery;
        _logger = logger;
        _config = config;
    }

    private static bool IsRegisteredAppCallerForType(string appCallerCode, string modelType)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode) || string.IsNullOrWhiteSpace(modelType)) return false;
        var def = AppCallerRegistrationService.FindByAppCode(appCallerCode);
        return def != null && def.ModelTypes.Contains(modelType);
    }

    /// <summary>
    /// 获取模型分组列表
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetModelGroups([FromQuery] string? modelType = null)
    {
        var filter = string.IsNullOrEmpty(modelType)
            ? Builders<ModelGroup>.Filter.Empty
            : Builders<ModelGroup>.Filter.Eq(g => g.ModelType, modelType);

        var groups = await _db.ModelGroups
            .Find(filter)
            .SortByDescending(g => g.IsDefaultForType)
            .ThenBy(g => g.Priority)
            .ThenBy(g => g.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<List<ModelGroup>>.Ok(groups));
    }

    /// <summary>
    /// 只读：模型池健康 + fallback 率告警总览。
    /// 把"死池被静默兜底 / 高 fallback 率"这种静默降级一眼暴露成一级告警。
    /// 纯读，无副作用：仅聚合 model_groups（健康状态）与 llmrequestlogs（fallback 统计），不写任何集合、不碰 serving 路径。
    /// </summary>
    [HttpGet("health-overview")]
    public async Task<IActionResult> HealthOverview([FromQuery] int days = 7)
    {
        days = Math.Clamp(days, 1, 30);
        var from = DateTime.UtcNow.AddDays(-days);

        // ============ 1. 模型池健康（来自 model_groups 文档的 Models[].HealthStatus） ============
        var groups = await _db.ModelGroups
            .Find(Builders<ModelGroup>.Filter.Empty)
            .SortByDescending(g => g.IsDefaultForType)
            .ThenBy(g => g.Priority)
            .ThenBy(g => g.CreatedAt)
            .ToListAsync();

        var pools = groups.Select(g =>
        {
            var healthy = g.Models.Count(m => m.HealthStatus == ModelHealthStatus.Healthy);
            var degraded = g.Models.Count(m => m.HealthStatus == ModelHealthStatus.Degraded);
            var unavailable = g.Models.Count(m => m.HealthStatus == ModelHealthStatus.Unavailable);
            // worstStatus：池内最差的健康状态（有 Unavailable > Degraded > Healthy）
            var worst = unavailable > 0 ? "Unavailable" : degraded > 0 ? "Degraded" : "Healthy";
            return new
            {
                id = g.Id,
                code = g.Code,
                name = g.Name,
                modelType = g.ModelType,
                isDefaultForType = g.IsDefaultForType,
                healthyCount = healthy,
                degradedCount = degraded,
                unavailableCount = unavailable,
                worstStatus = worst,
            };
        }).ToList();

        // ============ 2. fallback 率（按 modelType，复用 model-stats 的聚合风格） ============
        // 注意：llmrequestlogs 是共享基础设施，可能混入其他部署/分支的记录；这里只按时间窗 + modelType 聚合，
        // 用于"率"的趋势观察，不做精确归因（参见 cross-project-isolation 规则）。
        // RequestType 字段承载 modelType 语义（chat/intent/vision/generation 等）。
        var matchDoc = Builders<LlmRequestLog>.Filter
            .Gte(x => x.StartedAt, from)
            .Render(new RenderArgs<LlmRequestLog>(
                _db.LlmRequestLogs.DocumentSerializer,
                _db.LlmRequestLogs.Settings.SerializerRegistry));

        // modelType 解析：优先取 AppCallerCode 的 "::{model-type}" 后缀（app-caller-registry 规则保证为
        // chat/intent/vision/generation 等规范值，与池 ModelType 同口径），缺失时回退 RequestType，再回退 unknown。
        BsonDocument modelTypeExpr = new("$let", new BsonDocument
        {
            { "vars", new BsonDocument
                {
                    { "idx", new BsonDocument("$indexOfBytes", new BsonArray { new BsonDocument("$ifNull", new BsonArray { "$AppCallerCode", "" }), "::" }) },
                }
            },
            { "in", new BsonDocument("$cond", new BsonArray
                {
                    new BsonDocument("$gt", new BsonArray { "$$idx", -1 }),
                    new BsonDocument("$substrBytes", new BsonArray
                    {
                        "$AppCallerCode",
                        new BsonDocument("$add", new BsonArray { "$$idx", 2 }),
                        1000,
                    }),
                    new BsonDocument("$ifNull", new BsonArray { "$RequestType", "unknown" }),
                })
            },
        });

        // 2a. 按 modelType 统计 total + fallbackCount
        var typePipeline = new[]
        {
            new BsonDocument("$match", matchDoc),
            new BsonDocument("$project", new BsonDocument
            {
                { "modelType", modelTypeExpr },
                { "isFallback", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$IsFallback", true }),
                        1, 0
                    })
                },
            }),
            new BsonDocument("$group", new BsonDocument
            {
                { "_id", "$modelType" },
                { "total", new BsonDocument("$sum", 1) },
                { "fallbackCount", new BsonDocument("$sum", "$isFallback") },
            }),
            new BsonDocument("$sort", new BsonDocument("total", -1)),
        };
        var typeRows = await _db.LlmRequestLogs.Aggregate<BsonDocument>(typePipeline).ToListAsync();

        // 2b. 按 (modelType, fallbackReason) 统计 top reasons（仅 fallback 记录）
        var reasonPipeline = new[]
        {
            new BsonDocument("$match", matchDoc),
            new BsonDocument("$match", new BsonDocument("IsFallback", true)),
            new BsonDocument("$project", new BsonDocument
            {
                { "modelType", modelTypeExpr },
                { "reason", new BsonDocument("$ifNull", new BsonArray { "$FallbackReason", "(未记录原因)" }) },
            }),
            new BsonDocument("$group", new BsonDocument
            {
                { "_id", new BsonDocument { { "modelType", "$modelType" }, { "reason", "$reason" } } },
                { "count", new BsonDocument("$sum", 1) },
            }),
            new BsonDocument("$sort", new BsonDocument("count", -1)),
        };
        var reasonRows = await _db.LlmRequestLogs.Aggregate<BsonDocument>(reasonPipeline).ToListAsync();

        static long ToLong(BsonValue? v) => v == null || v.IsBsonNull ? 0L : v.ToInt64();
        static string ToStr(BsonValue? v) => v == null || v.IsBsonNull ? string.Empty : v.ToString() ?? string.Empty;

        // 把 reason 行按 modelType 归组，取每组前 3
        var reasonsByType = reasonRows
            .GroupBy(d => ToStr(d.GetValue("_id", new BsonDocument()).AsBsonDocument.GetValue("modelType", BsonNull.Value)))
            .ToDictionary(
                g => g.Key,
                g => g.Take(3).Select(d => new
                {
                    reason = ToStr(d.GetValue("_id").AsBsonDocument.GetValue("reason", BsonNull.Value)),
                    count = ToLong(d.GetValue("count", BsonNull.Value)),
                }).ToList());

        var fallbackByType = typeRows.Select(d =>
        {
            var modelType = ToStr(d.GetValue("_id", BsonNull.Value));
            var total = ToLong(d.GetValue("total", BsonNull.Value));
            var fallbackCount = ToLong(d.GetValue("fallbackCount", BsonNull.Value));
            var rate = total > 0 ? (double)fallbackCount / total : 0d;
            reasonsByType.TryGetValue(modelType, out var topReasons);
            return new
            {
                modelType,
                total,
                fallbackCount,
                fallbackRate = Math.Round(rate, 4),
                topFallbackReasons = topReasons ?? new(),
            };
        }).ToList();

        // ============ 3. 一级告警汇总 ============
        const double HighFallbackThreshold = 0.2;
        var alarms = new List<HealthAlarm>();

        // 3a. 死池：有 Unavailable 模型的池 -> critical
        foreach (var p in pools.Where(p => p.unavailableCount > 0))
        {
            alarms.Add(new HealthAlarm
            {
                Level = "critical",
                Kind = "dead-pool",
                Target = string.IsNullOrWhiteSpace(p.code) ? p.name : p.code,
                PoolId = p.id,
                ModelType = p.modelType,
                Detail = $"模型池「{(string.IsNullOrWhiteSpace(p.name) ? p.code : p.name)}」存在 {p.unavailableCount} 个不可用(Unavailable)模型"
                         + (p.isDefaultForType ? "（该类型默认池，命中请求会被静默兜底到其他模型）" : ""),
            });
        }

        // 3b. 高 fallback：fallbackRate >= 0.2 的 modelType -> warning
        foreach (var f in fallbackByType.Where(f => f.fallbackRate >= HighFallbackThreshold && f.total > 0))
        {
            var topReason = f.topFallbackReasons.Count > 0 ? f.topFallbackReasons[0].reason : null;
            alarms.Add(new HealthAlarm
            {
                Level = "warning",
                Kind = "high-fallback",
                Target = f.modelType,
                ModelType = f.modelType,
                Detail = $"近 {days} 天「{f.modelType}」类型 fallback 率 {Math.Round(f.fallbackRate * 100, 1)}%"
                         + $"（{f.fallbackCount}/{f.total}）"
                         + (string.IsNullOrWhiteSpace(topReason) ? "" : $"，主要原因：{topReason}"),
            });
        }

        // critical 排前面
        var orderedAlarms = alarms
            .OrderByDescending(a => a.Level == "critical")
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            days,
            pools,
            fallbackByType,
            alarms = orderedAlarms,
        }));
    }

    /// <summary>
    /// 按 Code 查询模型池列表（按优先级排序）
    /// </summary>
    [HttpGet("by-code/{code}")]
    public async Task<IActionResult> GetModelGroupsByCode(string code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_CODE", "Code 不能为空"));
        }

        var groups = await _db.ModelGroups
            .Find(g => g.Code == code)
            .SortBy(g => g.Priority)
            .ThenBy(g => g.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<List<ModelGroup>>.Ok(groups));
    }

    /// <summary>
    /// 按应用标识获取模型池列表（互斥优先级：专属池 > 默认池 > 默认生图）
    /// 只返回最高优先级来源的模型池，不同来源不会同时返回
    /// </summary>
    /// <param name="appCallerCode">应用标识（如 visual-agent.image.text2img::generation）</param>
    /// <param name="modelType">模型类型（如 generation）</param>
    [HttpGet("for-app")]
    public async Task<IActionResult> GetModelGroupsForApp(
        [FromQuery] string? appCallerCode,
        [FromQuery] string modelType)
    {
        if (string.IsNullOrWhiteSpace(modelType))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_MODEL_TYPE", "modelType 不能为空"));
        }
        if (!string.IsNullOrWhiteSpace(appCallerCode) && !IsRegisteredAppCallerForType(appCallerCode, modelType))
        {
            return BadRequest(ApiResponse<object>.Fail("APP_CODE_NOT_REGISTERED", "appCallerCode 未注册或不支持该 modelType"));
        }

        var pools = await _modelPoolQuery.GetModelPoolsAsync(appCallerCode, modelType);

        // 管理端点保留富 DTO（含 CreatedAt/UpdatedAt 及完整 ModelGroupItem）
        var result = pools.Select(p => new ModelGroupForAppResponse
        {
            Id = p.Id,
            Name = p.Name,
            Code = p.Code,
            Priority = p.Priority,
            ModelType = p.ModelType,
            IsDefaultForType = p.IsDefaultForType,
            Description = p.Description,
            Models = p.Models.Select(m => new ModelGroupItem
            {
                ModelId = m.ModelId,
                PlatformId = m.PlatformId,
                Priority = m.Priority,
                HealthStatus = Enum.TryParse<ModelHealthStatus>(m.HealthStatus, out var hs) ? hs : ModelHealthStatus.Healthy
            }).ToList(),
            ResolutionType = p.ResolutionType,
            IsDedicated = p.IsDedicated,
            IsDefault = p.IsDefault,
            IsLegacy = p.IsLegacy
        }).ToList();

        return Ok(ApiResponse<List<ModelGroupForAppResponse>>.Ok(result));
    }

    /// <summary>
    /// 测试模型加载优先级逻辑（仅用于验证）
    /// 返回不同场景下的模型加载结果表格
    /// </summary>
    [HttpGet("test-priority")]
    public async Task<IActionResult> TestModelLoadingPriority([FromQuery] string modelType = "generation")
    {
        var testCases = new List<object>();

        // 获取所有 appCallerCode 用于测试
        var appCallers = await _db.LLMAppCallers.Find(_ => true).ToListAsync();
        var defaultPools = await _db.ModelGroups.Find(g => g.ModelType == modelType && g.IsDefaultForType).ToListAsync();
        var legacyModel = modelType == "generation"
            ? await _db.LLMModels.Find(m => m.IsImageGen && m.Enabled).FirstOrDefaultAsync()
            : null;

        // 场景1: 测试有专属模型池的 appCallerCode
        foreach (var app in appCallers)
        {
            var requirement = app.ModelRequirements.FirstOrDefault(r => r.ModelType == modelType);
            if (requirement != null && requirement.ModelGroupIds.Count > 0)
            {
                var dedicatedGroups = await _db.ModelGroups
                    .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                    .ToListAsync();

                if (dedicatedGroups.Count > 0)
                {
                    testCases.Add(new
                    {
                        scenario = "场景1: 有专属模型池",
                        appCallerCode = app.AppCode,
                        hasDedicatedPool = true,
                        hasDefaultPool = defaultPools.Count > 0,
                        hasLegacyModel = legacyModel != null,
                        expectedResult = "只返回专属模型池",
                        actualResultType = "DedicatedPool",
                        returnedCodes = dedicatedGroups.Select(g => g.Code).ToList(),
                        returnedCount = dedicatedGroups.Count
                    });
                }
            }
        }

        // 场景2: 测试无专属但有默认模型池
        var testAppWithoutDedicated = appCallers.FirstOrDefault(a =>
            !a.ModelRequirements.Any(r => r.ModelType == modelType && r.ModelGroupIds.Count > 0));

        if (defaultPools.Count > 0)
        {
            testCases.Add(new
            {
                scenario = "场景2: 无专属池，有默认池",
                appCallerCode = testAppWithoutDedicated?.AppCode ?? "(任意无绑定的appCode)",
                hasDedicatedPool = false,
                hasDefaultPool = true,
                hasLegacyModel = legacyModel != null,
                expectedResult = "只返回默认模型池",
                actualResultType = "DefaultPool",
                returnedCodes = defaultPools.Select(g => g.Code).ToList(),
                returnedCount = defaultPools.Count
            });
        }

        // 场景3: 测试无模型池但有默认生图模型
        if (defaultPools.Count == 0 && legacyModel != null)
        {
            testCases.Add(new
            {
                scenario = "场景3: 无模型池，有默认生图",
                appCallerCode = "(任意appCode)",
                hasDedicatedPool = false,
                hasDefaultPool = false,
                hasLegacyModel = true,
                expectedResult = "只返回默认生图模型",
                actualResultType = "DirectModel",
                returnedCodes = new List<string> { legacyModel.ModelName },
                returnedCount = 1
            });
        }

        // 如果没有任何测试场景，说明配置不完整
        if (testCases.Count == 0)
        {
            testCases.Add(new
            {
                scenario = "无有效配置",
                message = "当前没有配置任何模型池或默认生图模型"
            });
        }

        // 汇总当前配置状态
        var summary = new
        {
            modelType,
            totalAppCallers = appCallers.Count,
            appCallersWithDedicatedPool = appCallers.Count(a =>
                a.ModelRequirements.Any(r => r.ModelType == modelType && r.ModelGroupIds.Count > 0)),
            defaultPoolCount = defaultPools.Count,
            defaultPoolCodes = defaultPools.Select(g => new { g.Code, g.Name }).ToList(),
            hasLegacyModel = legacyModel != null,
            legacyModelName = legacyModel?.ModelName
        };

        return Ok(ApiResponse<object>.Ok(new
        {
            summary,
            testCases,
            priorityRules = new[]
            {
                "优先级1: 专属模型池 (appCallerCode 绑定的 ModelGroupIds)",
                "优先级2: 默认模型池 (IsDefaultForType = true)",
                "优先级3: 默认生图模型 (IsImageGen = true, 仅 generation 类型)"
            },
            exclusiveRule = "互斥显示：只返回最高优先级来源的模型，不同来源不会同时返回"
        }));
    }

    /// <summary>
    /// 获取单个模型分组
    /// </summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetModelGroup(string id)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));
        }

        return Ok(ApiResponse<ModelGroup>.Ok(group));
    }

    /// <summary>
    /// 创建模型分组
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateModelGroup([FromBody] CreateModelGroupRequest request)
    {
        // 验证模型类型
        if (!ModelTypes.AllTypes.Contains(request.ModelType))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_MODEL_TYPE", $"无效的模型类型: {request.ModelType}"));
        }

        // 如果要设为默认，先取消同类型的其他默认分组
        if (request.IsDefaultForType)
        {
            var existingDefault = await _db.ModelGroups
                .Find(g => g.ModelType == request.ModelType && g.IsDefaultForType)
                .FirstOrDefaultAsync();

            if (existingDefault != null)
            {
                // 自动取消旧的默认分组
                await _db.ModelGroups.UpdateOneAsync(
                    g => g.Id == existingDefault.Id,
                    Builders<ModelGroup>.Update
                        .Set(g => g.IsDefaultForType, false)
                        .Set(g => g.UpdatedAt, DateTime.UtcNow));

                _logger.LogInformation(
                    "自动取消旧默认分组: {OldGroupId} ({OldGroupName})，新默认将是: {NewGroupName}",
                    existingDefault.Id, existingDefault.Name, request.Name);
            }
        }

        var group = new ModelGroup
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = request.Name,
            Code = request.Code ?? string.Empty,
            Priority = request.Priority ?? 50,
            ModelType = request.ModelType,
            IsDefaultForType = request.IsDefaultForType,
            StrategyType = request.StrategyType ?? 0,
            Description = request.Description,
            Models = request.Models ?? new List<ModelGroupItem>(),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.ModelGroups.InsertOneAsync(group);

        _logger.LogInformation("创建模型分组: {GroupId}, 名称: {Name}, Code: {Code}, 优先级: {Priority}, 类型: {ModelType}",
            group.Id, group.Name, group.Code, group.Priority, group.ModelType);

        return Ok(ApiResponse<ModelGroup>.Ok(group));
    }

    /// <summary>
    /// 更新模型分组
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateModelGroup(string id, [FromBody] UpdateModelGroupRequest request)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));
        }

        // 更新基本信息
        if (!string.IsNullOrEmpty(request.Name))
        {
            group.Name = request.Name;
        }

        // 更新 Code（允许更新）
        if (request.Code != null)
        {
            group.Code = request.Code;
        }

        // 更新 Priority
        if (request.Priority.HasValue)
        {
            group.Priority = request.Priority.Value;
        }

        // 更新 ModelType（可选）
        if (!string.IsNullOrWhiteSpace(request.ModelType) && request.ModelType != group.ModelType)
        {
            if (!ModelTypes.AllTypes.Contains(request.ModelType))
            {
                return BadRequest(ApiResponse<object>.Fail("INVALID_MODEL_TYPE", $"无效的模型类型: {request.ModelType}"));
            }
            group.ModelType = request.ModelType;
        }

        if (request.Description != null)
        {
            group.Description = request.Description;
        }

        // 更新策略类型
        if (request.StrategyType.HasValue)
        {
            group.StrategyType = request.StrategyType.Value;
        }

        // 更新模型列表
        if (request.Models != null)
        {
            group.Models = request.Models;
        }

        // 更新默认分组标记（自动取消旧默认）
        if (request.IsDefaultForType.HasValue && request.IsDefaultForType.Value != group.IsDefaultForType)
        {
            if (request.IsDefaultForType.Value)
            {
                // 自动取消同类型的其他默认分组
                var existingDefault = await _db.ModelGroups
                    .Find(g => g.ModelType == group.ModelType && g.IsDefaultForType && g.Id != id)
                    .FirstOrDefaultAsync();

                if (existingDefault != null)
                {
                    await _db.ModelGroups.UpdateOneAsync(
                        g => g.Id == existingDefault.Id,
                        Builders<ModelGroup>.Update
                            .Set(g => g.IsDefaultForType, false)
                            .Set(g => g.UpdatedAt, DateTime.UtcNow));

                    _logger.LogInformation(
                        "自动取消旧默认分组: {OldGroupId} ({OldGroupName})，新默认将是: {GroupName}",
                        existingDefault.Id, existingDefault.Name, group.Name);
                }
            }

            group.IsDefaultForType = request.IsDefaultForType.Value;
        }

        // 如果修改了类型且当前为默认分组，自动取消新类型的其他默认分组
        if (!string.IsNullOrWhiteSpace(request.ModelType) && group.IsDefaultForType)
        {
            var existingDefault = await _db.ModelGroups
                .Find(g => g.ModelType == group.ModelType && g.IsDefaultForType && g.Id != id)
                .FirstOrDefaultAsync();

            if (existingDefault != null)
            {
                await _db.ModelGroups.UpdateOneAsync(
                    g => g.Id == existingDefault.Id,
                    Builders<ModelGroup>.Update
                        .Set(g => g.IsDefaultForType, false)
                        .Set(g => g.UpdatedAt, DateTime.UtcNow));

                _logger.LogInformation(
                    "更改类型后自动取消旧默认分组: {OldGroupId} ({OldGroupName})",
                    existingDefault.Id, existingDefault.Name);
            }
        }

        group.UpdatedAt = DateTime.UtcNow;

        await _db.ModelGroups.ReplaceOneAsync(g => g.Id == id, group);

        _logger.LogInformation("更新模型分组: {GroupId}", id);

        return Ok(ApiResponse<ModelGroup>.Ok(group));
    }

    /// <summary>
    /// 删除模型分组
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteModelGroup(string id)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));
        }

        // 检查是否有应用正在使用该分组
        var appsUsingGroup = await _db.LLMAppCallers
            .Find(a => a.ModelRequirements.Any(r => r.ModelGroupIds.Contains(id)))
            .CountDocumentsAsync();

        if (appsUsingGroup > 0)
        {
            return BadRequest(ApiResponse<object>.Fail(
                "GROUP_IN_USE",
                $"该分组正在被 {appsUsingGroup} 个应用使用，无法删除"));
        }

        await _db.ModelGroups.DeleteOneAsync(g => g.Id == id);

        _logger.LogInformation("删除模型分组: {GroupId}", id);

        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 获取正在使用该模型分组的应用列表（用于删除受阻时展示并支持一键解绑）
    /// </summary>
    [HttpGet("{id}/usage")]
    public async Task<IActionResult> GetModelGroupUsage(string id)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));
        }

        var apps = await _db.LLMAppCallers
            .Find(a => a.ModelRequirements.Any(r => r.ModelGroupIds.Contains(id)))
            .ToListAsync();

        var usages = apps.Select(a => new ModelGroupUsageItem
        {
            AppId = a.Id,
            AppCode = a.AppCode,
            DisplayName = string.IsNullOrWhiteSpace(a.DisplayName) ? a.AppCode : a.DisplayName,
            ModelTypes = a.ModelRequirements
                .Where(r => r.ModelGroupIds.Contains(id))
                .Select(r => r.ModelType)
                .Distinct()
                .ToList()
        }).ToList();

        return Ok(ApiResponse<List<ModelGroupUsageItem>>.Ok(usages));
    }

    /// <summary>
    /// 解绑应用对该模型分组的引用。
    /// 不传 appIds（或为空）则解绑所有使用该分组的应用。解绑后该应用对应类型将回落到默认分组。
    /// </summary>
    [HttpPost("{id}/unbind")]
    public async Task<IActionResult> UnbindModelGroup(string id, [FromBody] UnbindModelGroupRequest? request)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));
        }

        var targetAppIds = request?.AppIds;
        var hasTargets = targetAppIds != null && targetAppIds.Count > 0;

        var apps = await _db.LLMAppCallers
            .Find(a => a.ModelRequirements.Any(r => r.ModelGroupIds.Contains(id)))
            .ToListAsync();

        var unboundCount = 0;
        foreach (var app in apps)
        {
            if (hasTargets && !targetAppIds!.Contains(app.Id))
            {
                continue;
            }

            var changed = false;
            foreach (var req in app.ModelRequirements)
            {
                if (req.ModelGroupIds.Remove(id))
                {
                    changed = true;
                }
            }

            if (changed)
            {
                app.UpdatedAt = DateTime.UtcNow;
                await _db.LLMAppCallers.ReplaceOneAsync(a => a.Id == app.Id, app);
                unboundCount++;
            }
        }

        _logger.LogInformation("解绑模型分组 {GroupId} 的应用引用，共 {Count} 个", id, unboundCount);

        return Ok(ApiResponse<object>.Ok(new { groupId = id, unboundCount }));
    }

    /// <summary>
    /// 重置模型池中指定模型的健康状态
    /// </summary>
    /// <param name="id">模型池 ID</param>
    /// <param name="modelId">模型 ID（ModelGroupItem.ModelId）</param>
    [HttpPost("{id}/reset-model-health")]
    public async Task<IActionResult> ResetModelHealth(string id, [FromQuery] string modelId)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));
        }

        var model = group.Models?.FirstOrDefault(m => m.ModelId == modelId);
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", $"模型 {modelId} 不在该分组中"));
        }

        var oldStatus = model.HealthStatus;

        // 重置健康状态
        var filter = Builders<ModelGroup>.Filter.And(
            Builders<ModelGroup>.Filter.Eq(g => g.Id, id),
            Builders<ModelGroup>.Filter.ElemMatch(g => g.Models, m => m.ModelId == modelId));

        var update = Builders<ModelGroup>.Update
            .Set("Models.$.HealthStatus", ModelHealthStatus.Healthy)
            .Set("Models.$.ConsecutiveFailures", 0)
            .Set("Models.$.ConsecutiveSuccesses", 0)
            .Set("Models.$.LastSuccessAt", DateTime.UtcNow);

        var result = await _db.ModelGroups.UpdateOneAsync(filter, update);

        if (result.ModifiedCount == 0)
        {
            return BadRequest(ApiResponse<object>.Fail("UPDATE_FAILED", "更新失败"));
        }

        _logger.LogInformation(
            "重置模型健康状态: GroupId={GroupId}, ModelId={ModelId}, OldStatus={Old}, NewStatus=Healthy",
            id, modelId, oldStatus);

        return Ok(ApiResponse<object>.Ok(new
        {
            groupId = id,
            modelId,
            oldStatus = oldStatus.ToString(),
            newStatus = "Healthy"
        }));
    }

    /// <summary>
    /// 批量重置模型池中所有模型的健康状态
    /// </summary>
    [HttpPost("{id}/reset-all-health")]
    public async Task<IActionResult> ResetAllModelsHealth(string id)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();

        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));
        }

        if (group.Models == null || group.Models.Count == 0)
        {
            return Ok(ApiResponse<object>.Ok(new { groupId = id, resetCount = 0 }));
        }

        // 重置所有模型的健康状态
        var resetModels = group.Models.Select(m => new ModelGroupItem
        {
            ModelId = m.ModelId,
            PlatformId = m.PlatformId,
            Priority = m.Priority,
            HealthStatus = ModelHealthStatus.Healthy,
            ConsecutiveFailures = 0,
            ConsecutiveSuccesses = 0,
            LastSuccessAt = DateTime.UtcNow,
            LastFailedAt = m.LastFailedAt,
            EnablePromptCache = m.EnablePromptCache,
            MaxTokens = m.MaxTokens
        }).ToList();

        var update = Builders<ModelGroup>.Update
            .Set(g => g.Models, resetModels)
            .Set(g => g.UpdatedAt, DateTime.UtcNow);

        await _db.ModelGroups.UpdateOneAsync(g => g.Id == id, update);

        _logger.LogInformation(
            "批量重置模型健康状态: GroupId={GroupId}, ResetCount={Count}",
            id, resetModels.Count);

        return Ok(ApiResponse<object>.Ok(new
        {
            groupId = id,
            resetCount = resetModels.Count,
            models = resetModels.Select(m => new { m.ModelId, newStatus = "Healthy" })
        }));
    }

    /// <summary>
    /// 测试模型池端点连通性
    /// 向池中所有端点（或指定端点）发送测试请求，返回连通性和延迟信息
    /// </summary>
    /// <param name="id">模型池 ID</param>
    /// <param name="endpointId">可选：指定要测试的端点 ID（格式: platformId:modelId）</param>
    /// <param name="prompt">测试提示词（默认: "Say hello in 10 words."）</param>
    [HttpPost("{id}/test")]
    public async Task<IActionResult> TestModelPool(
        string id,
        [FromQuery] string? endpointId = null,
        [FromQuery] string prompt = "Say hello in 10 words.")
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();
        if (group == null)
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));

        if (group.Models == null || group.Models.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("EMPTY_POOL", "模型池中没有配置模型"));

        // 获取平台配置
        var platformIds = group.Models.Select(m => m.PlatformId).Distinct().ToList();
        var platforms = await _db.LLMPlatforms
            .Find(p => platformIds.Contains(p.Id))
            .ToListAsync();

        // 构建模型池
        var httpDispatcher = new HttpPoolDispatcher(new DefaultHttpClientFactory());
        var factory = new ModelPoolFactory(httpDispatcher, _logger);
        var pool = factory.Create(group, platforms, _config);

        // 执行测试
        var testRequest = new PoolTestRequest
        {
            Prompt = prompt,
            ModelType = group.ModelType,
            TimeoutSeconds = 30,
            MaxTokens = 100
        };

        var results = await pool.TestEndpointsAsync(endpointId, testRequest);
        var healthSnapshot = pool.GetHealthSnapshot();

        return Ok(ApiResponse<object>.Ok(new
        {
            poolId = id,
            poolName = group.Name,
            strategyType = ((PoolStrategyType)group.StrategyType).ToString(),
            testResults = results.Select(r => new
            {
                r.EndpointId,
                r.ModelId,
                r.PlatformName,
                r.Success,
                r.StatusCode,
                r.LatencyMs,
                r.ResponsePreview,
                r.ErrorMessage,
                tokenUsage = r.TokenUsage != null ? new
                {
                    r.TokenUsage.InputTokens,
                    r.TokenUsage.OutputTokens,
                    r.TokenUsage.TotalTokens
                } : null,
                r.TestedAt
            }),
            healthSnapshot = new
            {
                healthSnapshot.HealthyCount,
                healthSnapshot.DegradedCount,
                healthSnapshot.UnavailableCount,
                healthSnapshot.TotalCount,
                healthSnapshot.IsFullyUnavailable,
                endpoints = healthSnapshot.Endpoints.Select(e => new
                {
                    e.EndpointId,
                    e.ModelId,
                    status = e.Status.ToString(),
                    e.HealthScore,
                    e.AverageLatencyMs
                })
            }
        }));
    }

    /// <summary>
    /// 获取模型池健康快照
    /// </summary>
    [HttpGet("{id}/health")]
    public async Task<IActionResult> GetPoolHealth(string id)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();
        if (group == null)
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));

        // 直接从 ModelGroupItem 构建健康快照（不需要实例化模型池）
        var snapshot = new
        {
            poolId = id,
            poolName = group.Name,
            strategyType = ((PoolStrategyType)group.StrategyType).ToString(),
            totalEndpoints = group.Models?.Count ?? 0,
            healthyCount = group.Models?.Count(m => m.HealthStatus == ModelHealthStatus.Healthy) ?? 0,
            degradedCount = group.Models?.Count(m => m.HealthStatus == ModelHealthStatus.Degraded) ?? 0,
            unavailableCount = group.Models?.Count(m => m.HealthStatus == ModelHealthStatus.Unavailable) ?? 0,
            endpoints = group.Models?.Select(m => new
            {
                endpointId = $"{m.PlatformId}:{m.ModelId}",
                m.ModelId,
                m.PlatformId,
                status = m.HealthStatus.ToString(),
                m.ConsecutiveFailures,
                m.ConsecutiveSuccesses,
                m.LastSuccessAt,
                m.LastFailedAt
            })
        };

        return Ok(ApiResponse<object>.Ok(snapshot));
    }

    /// <summary>
    /// 快捷创建带降级链的模型池
    /// 一次性创建 ModelGroup 并可选绑定 AppCaller
    /// </summary>
    [HttpPost("quick-setup")]
    public async Task<IActionResult> QuickSetup([FromBody] QuickSetupRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(new { error = "name 不能为空" });
        if (string.IsNullOrWhiteSpace(request.ModelType))
            return BadRequest(new { error = "modelType 不能为空" });
        if (request.Models == null || request.Models.Count == 0)
            return BadRequest(new { error = "至少需要一个模型" });

        // 验证所有平台存在
        var platformIds = request.Models.Select(m => m.PlatformId).Distinct().ToList();
        var platforms = await _db.LLMPlatforms
            .Find(p => platformIds.Contains(p.Id))
            .ToListAsync(ct);

        var missingPlatforms = platformIds.Except(platforms.Select(p => p.Id)).ToList();
        if (missingPlatforms.Count > 0)
        {
            return BadRequest(new { error = $"平台不存在: {string.Join(", ", missingPlatforms)}" });
        }

        // 创建 ModelGroup
        var group = new ModelGroup
        {
            Name = request.Name,
            Code = request.Code ?? request.Name,
            ModelType = request.ModelType,
            Priority = request.Priority ?? 50,
            IsDefaultForType = request.IsDefaultForType,
            StrategyType = request.Strategy ?? 0, // 默认 FailFast（调度已化简为只有 FailFast）
            Description = request.Description,
            Models = request.Models.Select((m, i) => new ModelGroupItem
            {
                ModelId = m.ModelId,
                PlatformId = m.PlatformId,
                Priority = m.Priority ?? (i + 1),
                HealthStatus = ModelHealthStatus.Healthy,
                MaxTokens = m.MaxTokens,
                EnablePromptCache = m.EnablePromptCache
            }).ToList()
        };

        await _db.ModelGroups.InsertOneAsync(group, cancellationToken: ct);

        // 可选：绑定 AppCaller
        if (!string.IsNullOrWhiteSpace(request.BindToAppCallerCode))
        {
            var appCaller = await _db.LLMAppCallers
                .Find(a => a.AppCode == request.BindToAppCallerCode)
                .FirstOrDefaultAsync(ct);

            if (appCaller != null)
            {
                var requirement = appCaller.ModelRequirements
                    .FirstOrDefault(r => r.ModelType == request.ModelType);

                if (requirement != null)
                {
                    if (!requirement.ModelGroupIds.Contains(group.Id))
                    {
                        requirement.ModelGroupIds.Add(group.Id);
                    }
                }
                else
                {
                    appCaller.ModelRequirements.Add(new AppModelRequirement
                    {
                        ModelType = request.ModelType,
                        ModelGroupIds = new List<string> { group.Id }
                    });
                }

                await _db.LLMAppCallers.ReplaceOneAsync(
                    a => a.Id == appCaller.Id, appCaller, cancellationToken: ct);

                _logger.LogInformation(
                    "[QuickSetup] 模型池已绑定 AppCaller: Pool={Pool}, AppCaller={AppCaller}",
                    group.Name, request.BindToAppCallerCode);
            }
            else
            {
                _logger.LogWarning(
                    "[QuickSetup] AppCaller 不存在，跳过绑定: {AppCaller}", request.BindToAppCallerCode);
            }
        }

        _logger.LogInformation(
            "[QuickSetup] 快捷创建模型池成功: Name={Name}, Models={Count}, Strategy={Strategy}",
            group.Name, group.Models.Count, (PoolStrategyType)group.StrategyType);

        return Ok(group);
    }
}

/// <summary>
/// 简单的 HttpClientFactory 实现，用于测试端点
/// </summary>
internal class DefaultHttpClientFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new();
}

public class CreateModelGroupRequest
{
    public string Name { get; set; } = string.Empty;
    /// <summary>对外暴露的模型名字（允许重复）</summary>
    public string? Code { get; set; }
    /// <summary>优先级（数字越小优先级越高，默认50）</summary>
    public int? Priority { get; set; }
    public string ModelType { get; set; } = string.Empty;
    public bool IsDefaultForType { get; set; } = false;
    public string? Description { get; set; }
    /// <summary>模型列表</summary>
    public List<ModelGroupItem>? Models { get; set; }
    /// <summary>调度策略类型 (0=FailFast, 1=Race, 2=Sequential, 3=RoundRobin, 4=WeightedRandom, 5=LeastLatency)</summary>
    public int? StrategyType { get; set; }
}

/// <summary>
/// 解绑模型分组的请求
/// </summary>
public class UnbindModelGroupRequest
{
    /// <summary>要解绑的应用 ID 列表；为空或不传则解绑全部使用该分组的应用</summary>
    public List<string>? AppIds { get; set; }
}

/// <summary>
/// 模型分组占用情况（哪个应用在用）
/// </summary>
public class ModelGroupUsageItem
{
    /// <summary>应用 ID</summary>
    public string AppId { get; set; } = string.Empty;
    /// <summary>应用标识码</summary>
    public string AppCode { get; set; } = string.Empty;
    /// <summary>应用显示名称</summary>
    public string DisplayName { get; set; } = string.Empty;
    /// <summary>该应用在哪些模型类型上引用了此分组</summary>
    public List<string> ModelTypes { get; set; } = new();
}

public class UpdateModelGroupRequest
{
    public string? Name { get; set; }
    /// <summary>对外暴露的模型名字（允许重复）</summary>
    public string? Code { get; set; }
    /// <summary>优先级（数字越小优先级越高）</summary>
    public int? Priority { get; set; }
    /// <summary>模型类型（chat/intent/vision/image-gen等）</summary>
    public string? ModelType { get; set; }
    public string? Description { get; set; }
    public List<ModelGroupItem>? Models { get; set; }
    public bool? IsDefaultForType { get; set; }
    /// <summary>调度策略类型 (0=FailFast, 1=Race, 2=Sequential, 3=RoundRobin, 4=WeightedRandom, 5=LeastLatency)</summary>
    public int? StrategyType { get; set; }
}

/// <summary>
/// 按应用标识获取模型池的响应，包含来源标记
/// </summary>
public class ModelGroupForAppResponse
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Code { get; set; } = string.Empty;
    public int Priority { get; set; }
    public string ModelType { get; set; } = string.Empty;
    public bool IsDefaultForType { get; set; }
    public string? Description { get; set; }
    public List<ModelGroupItem> Models { get; set; } = new();
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    // 来源标记
    /// <summary>解析类型：DedicatedPool(专属池)、DefaultPool(默认池)、DirectModel(传统配置)</summary>
    public string ResolutionType { get; set; } = string.Empty;
    /// <summary>是否为该应用的专属模型池</summary>
    public bool IsDedicated { get; set; }
    /// <summary>是否为该类型的默认模型池</summary>
    public bool IsDefault { get; set; }
    /// <summary>是否为传统配置模型（isImageGen 等标记）</summary>
    public bool IsLegacy { get; set; }
}

/// <summary>
/// 健康总览的一级告警条目（只读，仅用于序列化返回）
/// </summary>
public class HealthAlarm
{
    /// <summary>告警级别：critical（死池）/ warning（高 fallback）</summary>
    public string Level { get; set; } = "warning";
    /// <summary>告警类型：dead-pool / high-fallback</summary>
    public string Kind { get; set; } = string.Empty;
    /// <summary>告警目标（池 Code/Name 或 modelType）</summary>
    public string Target { get; set; } = string.Empty;
    /// <summary>关联的模型池 ID（仅 dead-pool 有值）</summary>
    public string? PoolId { get; set; }
    /// <summary>关联的模型类型</summary>
    public string? ModelType { get; set; }
    /// <summary>人类可读的告警详情</summary>
    public string Detail { get; set; } = string.Empty;
}

/// <summary>
/// 快捷创建带降级链的模型池
/// </summary>
public class QuickSetupRequest
{
    /// <summary>模型池名称</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>对外暴露的模型名字</summary>
    public string? Code { get; set; }
    /// <summary>模型类型（chat/intent/vision/generation 等）</summary>
    public string ModelType { get; set; } = string.Empty;
    /// <summary>优先级（默认 50）</summary>
    public int? Priority { get; set; }
    /// <summary>是否设为该类型的默认池</summary>
    public bool IsDefaultForType { get; set; }
    /// <summary>调度策略（默认 2=Sequential 顺序降级）</summary>
    public int? Strategy { get; set; }
    /// <summary>描述</summary>
    public string? Description { get; set; }
    /// <summary>模型列表（按降级优先级排列）</summary>
    public List<QuickSetupModelItem> Models { get; set; } = new();
    /// <summary>可选：自动绑定到指定 AppCallerCode</summary>
    public string? BindToAppCallerCode { get; set; }
}

/// <summary>
/// 快捷创建模型池的模型项
/// </summary>
public class QuickSetupModelItem
{
    /// <summary>模型 ID</summary>
    public string ModelId { get; set; } = string.Empty;
    /// <summary>平台 ID</summary>
    public string PlatformId { get; set; } = string.Empty;
    /// <summary>优先级（可选，默认按顺序自动分配 1, 2, 3...）</summary>
    public int? Priority { get; set; }
    /// <summary>最大输出 Token 数</summary>
    public int? MaxTokens { get; set; }
    /// <summary>是否启用 Prompt Cache</summary>
    public bool? EnablePromptCache { get; set; }
}
