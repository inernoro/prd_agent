using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
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

    public ModelGroupsController(MongoDbContext db, ILogger<ModelGroupsController> logger)
    {
        _db = db;
        _logger = logger;
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
    /// <param name="appCallerCode">应用标识（如 visual-agent.image::generation）</param>
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

        // 检查是否已存在同类型的默认分组
        if (request.IsDefaultForType)
        {
            var existingDefault = await _db.ModelGroups
                .Find(g => g.ModelType == request.ModelType && g.IsDefaultForType)
                .FirstOrDefaultAsync();

            if (existingDefault != null)
            {
                return BadRequest(ApiResponse<object>.Fail(
                    "DEFAULT_GROUP_EXISTS",
                    $"该类型已存在默认分组: {existingDefault.Name}"));
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

        // 更新模型列表
        if (request.Models != null)
        {
            group.Models = request.Models;
        }

        // 更新默认分组标记
        if (request.IsDefaultForType.HasValue && request.IsDefaultForType.Value != group.IsDefaultForType)
        {
            if (request.IsDefaultForType.Value)
            {
                // 检查是否已存在其他默认分组
                var existingDefault = await _db.ModelGroups
                    .Find(g => g.ModelType == group.ModelType && g.IsDefaultForType && g.Id != id)
                    .FirstOrDefaultAsync();

                if (existingDefault != null)
                {
                    return BadRequest(ApiResponse<object>.Fail(
                        "DEFAULT_GROUP_EXISTS",
                        $"该类型已存在默认分组: {existingDefault.Name}"));
                }
            }

            group.IsDefaultForType = request.IsDefaultForType.Value;
        }

        // 如果修改了类型且当前为默认分组，需要验证新类型是否已有默认分组
        if (!string.IsNullOrWhiteSpace(request.ModelType) && group.IsDefaultForType)
        {
            var existingDefault = await _db.ModelGroups
                .Find(g => g.ModelType == group.ModelType && g.IsDefaultForType && g.Id != id)
                .FirstOrDefaultAsync();

            if (existingDefault != null)
            {
                return BadRequest(ApiResponse<object>.Fail(
                    "DEFAULT_GROUP_EXISTS",
                    $"该类型已存在默认分组: {existingDefault.Name}"));
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
