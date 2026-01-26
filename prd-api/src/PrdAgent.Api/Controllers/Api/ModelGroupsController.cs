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
    /// 按应用标识获取模型池列表（按优先级排序：专属池 > 默认池）
    /// 用于前端加载可用模型列表，按正确的优先级顺序展示
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
        var addedGroupIds = new HashSet<string>();

        // Step 1: 查找 appCallerCode 绑定的专属模型池
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
                        .ToListAsync();

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
                            // 标记来源
                            ResolutionType = "DedicatedPool",
                            IsDedicated = true,
                            IsDefault = group.IsDefaultForType
                        });
                        addedGroupIds.Add(group.Id);
                    }
                }
            }
        }

        // Step 2: 查找该类型的默认模型池
        var defaultGroups = await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType && !addedGroupIds.Contains(g.Id))
            .SortBy(g => g.Priority)
            .ToListAsync();

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
                // 标记来源
                ResolutionType = "DefaultPool",
                IsDedicated = false,
                IsDefault = true
            });
            addedGroupIds.Add(group.Id);
        }

        // Step 3: 查找传统配置的 isImageGen 模型（仅当 modelType 为 generation 时）
        if (modelType == "generation")
        {
            var legacyModel = await _db.LLMModels
                .Find(m => m.IsImageGen && m.Enabled)
                .FirstOrDefaultAsync();

            if (legacyModel != null)
            {
                // 构造虚拟模型池
                result.Add(new ModelGroupForAppResponse
                {
                    Id = $"legacy-{legacyModel.Id}",
                    Name = $"默认生图 - {legacyModel.Name}",
                    Code = $"legacy-generation",
                    Priority = 9999, // 最低优先级
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
                    UpdatedAt = legacyModel.UpdatedAt ?? legacyModel.CreatedAt,
                    // 标记来源
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
