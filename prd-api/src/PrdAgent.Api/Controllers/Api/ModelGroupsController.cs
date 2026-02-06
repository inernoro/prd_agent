using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Helpers;
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
    private readonly ILogger<ModelGroupsController> _logger;
    private readonly IConfiguration _config;

    public ModelGroupsController(MongoDbContext db, ILogger<ModelGroupsController> logger, IConfiguration config)
    {
        _db = db;
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

        var result = new List<ModelGroupForAppResponse>();

        // Step 1: 查找 appCallerCode 绑定的专属模型池（最高优先级）
        if (!string.IsNullOrWhiteSpace(appCallerCode))
        {
            var app = await _db.LLMAppCallers.Find(a => a.AppCode == appCallerCode).FirstOrDefaultAsync();
            if (app != null)
            {
                var requirement = app.ModelRequirements.FirstOrDefault(r => r.ModelType == modelType);
                if (requirement != null && requirement.ModelGroupIds.Count > 0)
                {
                    var dedicatedGroups = await _db.ModelGroups
                        .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                        .SortBy(g => g.Priority)
                        .ThenBy(g => g.CreatedAt)
                        .ToListAsync();

                    if (dedicatedGroups.Count > 0)
                    {
                        // 有专属模型池，只返回专属模型池
                        foreach (var group in dedicatedGroups)
                        {
                            result.Add(new ModelGroupForAppResponse
                            {
                                Id = group.Id,
                                Name = group.Name,
                                Code = group.Code,
                                Priority = group.Priority,
                                ModelType = group.ModelType,
                                IsDefaultForType = group.IsDefaultForType,
                                Description = group.Description,
                                Models = group.Models,
                                CreatedAt = group.CreatedAt,
                                UpdatedAt = group.UpdatedAt,
                                ResolutionType = "DedicatedPool",
                                IsDedicated = true,
                                IsDefault = false,
                                IsLegacy = false
                            });
                        }
                        return Ok(ApiResponse<List<ModelGroupForAppResponse>>.Ok(result));
                    }
                }
            }
        }

        // Step 2: 没有专属模型池，查找该类型的默认模型池
        var defaultGroups = await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .SortBy(g => g.Priority)
            .ThenBy(g => g.CreatedAt)
            .ToListAsync();

        if (defaultGroups.Count > 0)
        {
            // 有默认模型池，只返回默认模型池
            foreach (var group in defaultGroups)
            {
                result.Add(new ModelGroupForAppResponse
                {
                    Id = group.Id,
                    Name = group.Name,
                    Code = group.Code,
                    Priority = group.Priority,
                    ModelType = group.ModelType,
                    IsDefaultForType = group.IsDefaultForType,
                    Description = group.Description,
                    Models = group.Models,
                    CreatedAt = group.CreatedAt,
                    UpdatedAt = group.UpdatedAt,
                    ResolutionType = "DefaultPool",
                    IsDedicated = false,
                    IsDefault = true,
                    IsLegacy = false
                });
            }
            return Ok(ApiResponse<List<ModelGroupForAppResponse>>.Ok(result));
        }

        // Step 3: 没有模型池，查找传统配置的默认生图模型（仅当 modelType 为 generation 时）
        if (modelType == "generation")
        {
            var legacyModel = await _db.LLMModels
                .Find(m => m.IsImageGen && m.Enabled)
                .FirstOrDefaultAsync();

            if (legacyModel != null)
            {
                result.Add(new ModelGroupForAppResponse
                {
                    Id = $"legacy-{legacyModel.Id}",
                    Name = $"默认生图 - {legacyModel.Name}",
                    Code = legacyModel.ModelName, // 使用模型名称作为 code
                    Priority = 1,
                    ModelType = modelType,
                    IsDefaultForType = false,
                    Description = "传统配置的默认生图模型（isImageGen）",
                    Models = new List<ModelGroupItem>
                    {
                        new ModelGroupItem
                        {
                            ModelId = legacyModel.ModelName,
                            PlatformId = legacyModel.PlatformId ?? string.Empty,
                            Priority = 1,
                            HealthStatus = ModelHealthStatus.Healthy,
                            EnablePromptCache = legacyModel.EnablePromptCache,
                            MaxTokens = legacyModel.MaxTokens
                        }
                    },
                    CreatedAt = legacyModel.CreatedAt,
                    UpdatedAt = legacyModel.UpdatedAt,
                    ResolutionType = "DirectModel",
                    IsDedicated = false,
                    IsDefault = false,
                    IsLegacy = true
                });
            }
        }

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
    /// 重置模型池中指定模型的健康状态
    /// </summary>
    /// <param name="id">模型池 ID</param>
    /// <param name="modelId">模型 ID（ModelGroupItem.ModelId）</param>
    [HttpPost("{id}/models/{modelId}/reset-health")]
    public async Task<IActionResult> ResetModelHealth(string id, string modelId)
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

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";

        // 构建模型池
        var httpDispatcher = new HttpPoolDispatcher(new DefaultHttpClientFactory());
        var factory = new ModelPoolFactory(httpDispatcher, _logger);
        var pool = factory.Create(group, platforms, jwtSecret);

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
    /// 预测下一次请求的调度路径
    /// 根据当前策略和健康状态，模拟下一次请求会命中哪些端点
    /// </summary>
    [HttpGet("{id}/predict")]
    public async Task<IActionResult> PredictNextDispatch(string id)
    {
        var group = await _db.ModelGroups.Find(g => g.Id == id).FirstOrDefaultAsync();
        if (group == null)
            return NotFound(ApiResponse<object>.Fail("MODEL_GROUP_NOT_FOUND", "模型分组不存在"));

        if (group.Models == null || group.Models.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { poolId = id, endpoints = Array.Empty<object>(), strategy = "FailFast", description = "模型池为空" }));

        var strategyType = (PoolStrategyType)group.StrategyType;
        var platformIds = group.Models.Select(m => m.PlatformId).Distinct().ToList();
        var platforms = await _db.LLMPlatforms.Find(p => platformIds.Contains(p.Id)).ToListAsync();
        var platformMap = platforms.ToDictionary(p => p.Id);

        // 构建端点列表并计算健康分数
        var endpoints = group.Models.Select((m, idx) =>
        {
            var platform = platformMap.GetValueOrDefault(m.PlatformId);
            var healthStatus = m.HealthStatus.ToString();
            var isAvailable = m.HealthStatus != ModelHealthStatus.Unavailable;
            var isHealthy = m.HealthStatus == ModelHealthStatus.Healthy;

            // 计算健康分数 (100 = 完美, 0 = 不可用)
            double healthScore = isAvailable
                ? (isHealthy ? 100.0 - m.ConsecutiveFailures * 10 : 50.0 - m.ConsecutiveFailures * 5)
                : 0;
            healthScore = Math.Max(0, Math.Min(100, healthScore));

            return new
            {
                endpointId = $"{m.PlatformId}:{m.ModelId}",
                modelId = m.ModelId,
                platformId = m.PlatformId,
                platformName = platform?.Name ?? m.PlatformId,
                priority = m.Priority,
                healthStatus,
                isAvailable,
                healthScore,
                consecutiveFailures = m.ConsecutiveFailures,
                index = idx
            };
        }).ToList();

        var available = endpoints.Where(e => e.isAvailable)
            .OrderBy(e => e.healthStatus == "Healthy" ? 0 : 1)
            .ThenBy(e => e.priority)
            .Select(e => new PredictEndpointInfo(e.endpointId, e.modelId, e.priority, e.healthStatus))
            .ToList();

        // 根据策略预测调度路径
        var prediction = strategyType switch
        {
            PoolStrategyType.FailFast => PredictFailFast(available),
            PoolStrategyType.Race => PredictRace(available),
            PoolStrategyType.Sequential => PredictSequential(available),
            PoolStrategyType.RoundRobin => PredictRoundRobin(available),
            PoolStrategyType.WeightedRandom => PredictWeightedRandom(available),
            PoolStrategyType.LeastLatency => PredictLeastLatency(available),
            _ => PredictFailFast(available)
        };

        return Ok(ApiResponse<object>.Ok(new
        {
            poolId = id,
            poolName = group.Name,
            strategy = strategyType.ToString(),
            strategyDescription = GetStrategyDescription(strategyType),
            allEndpoints = endpoints,
            prediction
        }));
    }

    private record PredictEndpointInfo(string EndpointId, string ModelId, int Priority, string HealthStatus);

    private static object PredictFailFast(List<PredictEndpointInfo> available)
    {
        if (available.Count == 0)
            return new { type = "FailFast", description = "无可用端点", steps = Array.Empty<object>() };

        var ep = available[0];
        return new
        {
            type = "FailFast",
            description = "选择最优端点，失败直接返回错误",
            steps = new object[]
            {
                new { order = 1, ep.EndpointId, ep.ModelId, action = "request", label = "发送请求", isTarget = true }
            }
        };
    }

    private static object PredictRace(List<PredictEndpointInfo> available)
    {
        if (available.Count == 0)
            return new { type = "Race", description = "无可用端点", steps = Array.Empty<object>() };

        var steps = available.Select(ep => (object)new
        {
            order = 1, ep.EndpointId, ep.ModelId, action = "parallel", label = "并行请求", isTarget = true
        }).ToList();

        return new { type = "Race", description = "同时请求所有端点，取最快返回的结果", steps };
    }

    private static object PredictSequential(List<PredictEndpointInfo> available)
    {
        if (available.Count == 0)
            return new { type = "Sequential", description = "无可用端点", steps = Array.Empty<object>() };

        var steps = available.Select((ep, i) => (object)new
        {
            order = i + 1,
            ep.EndpointId,
            ep.ModelId,
            action = i == 0 ? "request" : "fallback",
            label = i == 0 ? "首选请求" : $"第{i + 1}备选",
            isTarget = i == 0
        }).ToList();

        return new { type = "Sequential", description = "按优先级依次尝试，失败则顺延", steps };
    }

    private static object PredictRoundRobin(List<PredictEndpointInfo> available)
    {
        if (available.Count == 0)
            return new { type = "RoundRobin", description = "无可用端点", steps = Array.Empty<object>() };

        var steps = available.Select((ep, i) => (object)new
        {
            order = i + 1,
            ep.EndpointId,
            ep.ModelId,
            action = "rotate",
            label = $"轮询 #{i + 1}",
            isTarget = i == 0,
            weight = 1.0 / available.Count
        }).ToList();

        return new { type = "RoundRobin", description = "在健康端点间均匀轮转", steps };
    }

    private static object PredictWeightedRandom(List<PredictEndpointInfo> available)
    {
        if (available.Count == 0)
            return new { type = "WeightedRandom", description = "无可用端点", steps = Array.Empty<object>() };

        var weights = available.Select(ep =>
        {
            double w = 1.0 / Math.Max(1, ep.Priority);
            if (ep.HealthStatus != "Healthy") w *= 0.5;
            return w;
        }).ToList();
        var totalWeight = weights.Sum();

        var steps = available.Select((ep, i) =>
        {
            double pct = totalWeight > 0 ? weights[i] / totalWeight * 100 : 0;
            return (object)new
            {
                order = i + 1,
                ep.EndpointId,
                ep.ModelId,
                action = "weighted",
                label = $"概率 {pct:F1}%",
                isTarget = i == 0,
                weight = weights[i],
                probability = Math.Round(pct, 1)
            };
        }).ToList();

        return new { type = "WeightedRandom", description = "按权重随机选择端点", steps };
    }

    private static object PredictLeastLatency(List<PredictEndpointInfo> available)
    {
        if (available.Count == 0)
            return new { type = "LeastLatency", description = "无可用端点", steps = Array.Empty<object>() };

        var steps = available.Select((ep, i) => (object)new
        {
            order = i + 1,
            ep.EndpointId,
            ep.ModelId,
            action = i == 0 ? "request" : "standby",
            label = i == 0 ? "最低延迟（首选）" : "备选",
            isTarget = i == 0
        }).ToList();

        return new { type = "LeastLatency", description = "优先选择历史延迟最低的端点", steps };
    }

    private static string GetStrategyDescription(PoolStrategyType type) => type switch
    {
        PoolStrategyType.FailFast => "选择最优端点发送请求，失败直接返回错误",
        PoolStrategyType.Race => "同时向所有端点发送请求，取最快成功的结果",
        PoolStrategyType.Sequential => "按优先级依次尝试端点，失败后自动切换下一个",
        PoolStrategyType.RoundRobin => "在所有健康端点间均匀轮转分配请求",
        PoolStrategyType.WeightedRandom => "根据优先级权重随机选择端点",
        PoolStrategyType.LeastLatency => "跟踪历史延迟数据，优先选择响应最快的端点",
        _ => "未知策略"
    };
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
