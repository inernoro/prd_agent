using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 模型分组管理
/// </summary>
[ApiController]
[Route("api/v1/admin/model-groups")]
[Authorize]
public class AdminModelGroupsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminModelGroupsController> _logger;

    public AdminModelGroupsController(MongoDbContext db, ILogger<AdminModelGroupsController> logger)
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
            Models = new List<ModelGroupItem>(),
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
}

public class UpdateModelGroupRequest
{
    public string? Name { get; set; }
    /// <summary>对外暴露的模型名字（允许重复）</summary>
    public string? Code { get; set; }
    /// <summary>优先级（数字越小优先级越高）</summary>
    public int? Priority { get; set; }
    public string? Description { get; set; }
    public List<ModelGroupItem>? Models { get; set; }
    public bool? IsDefaultForType { get; set; }
}
