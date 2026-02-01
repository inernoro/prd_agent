using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 应用调用者管理
/// </summary>
[ApiController]
[Route("api/open-platform/app-callers")]
[Authorize]
[AdminController("open-platform", AdminPermissionCatalog.OpenPlatformManage)]
public class AppCallersController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<AppCallersController> _logger;

    public AppCallersController(MongoDbContext db, ILlmGateway gateway, ILogger<AppCallersController> logger)
    {
        _db = db;
        _gateway = gateway;
        _logger = logger;
    }

    private static bool IsRegisteredAppCaller(string appCallerCode)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode)) return false;
        return AppCallerRegistrationService.FindByAppCode(appCallerCode) != null;
    }

    private static bool IsRegisteredAppCallerForType(string appCallerCode, string modelType)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode) || string.IsNullOrWhiteSpace(modelType)) return false;
        var def = AppCallerRegistrationService.FindByAppCode(appCallerCode);
        return def != null && def.ModelTypes.Contains(modelType);
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
        if (!IsRegisteredAppCaller(request.AppCode))
        {
            return BadRequest(ApiResponse<object>.Fail("APP_CODE_NOT_REGISTERED", "appCallerCode 未注册（请先在 AppCallerRegistry 中登记）"));
        }

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
        if (!IsRegisteredAppCaller(app.AppCode))
        {
            return BadRequest(ApiResponse<object>.Fail("APP_CODE_NOT_REGISTERED", "appCallerCode 未注册（请先在 AppCallerRegistry 中登记）"));
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

    /// <summary>
    /// 获取应用绑定的模型池列表
    /// </summary>
    [HttpGet("{id}/bound-pools")]
    public async Task<IActionResult> GetBoundModelPools(string id)
    {
        var app = await _db.LLMAppCallers.Find(a => a.Id == id).FirstOrDefaultAsync();

        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail("APP_CALLER_NOT_FOUND", "应用不存在"));
        }

        // 收集所有绑定的模型池 ID
        var groupIds = app.ModelRequirements
            .SelectMany(r => r.ModelGroupIds)
            .Where(id => !string.IsNullOrEmpty(id))
            .Distinct()
            .ToList();

        if (groupIds.Count == 0)
        {
            return Ok(ApiResponse<List<ModelGroup>>.Ok(new List<ModelGroup>()));
        }

        // 查询模型池详情
        var groups = await _db.ModelGroups
            .Find(g => groupIds.Contains(g.Id))
            .SortBy(g => g.Priority)
            .ToListAsync();

        return Ok(ApiResponse<List<ModelGroup>>.Ok(groups));
    }

    /// <summary>
    /// 更新应用的模型需求绑定（支持多模型池）
    /// </summary>
    [HttpPut("{id}/requirements/{modelType}/bindings")]
    public async Task<IActionResult> UpdateRequirementBindings(
        string id,
        string modelType,
        [FromBody] UpdateBindingsRequest request)
    {
        var app = await _db.LLMAppCallers.Find(a => a.Id == id).FirstOrDefaultAsync();

        if (app == null)
        {
            return NotFound(ApiResponse<object>.Fail("APP_CALLER_NOT_FOUND", "应用不存在"));
        }
        if (!IsRegisteredAppCallerForType(app.AppCode, modelType))
        {
            return BadRequest(ApiResponse<object>.Fail("APP_CODE_NOT_REGISTERED", "appCallerCode 未注册或不支持该 modelType"));
        }

        var requirement = app.ModelRequirements.FirstOrDefault(r => r.ModelType == modelType);
        if (requirement == null)
        {
            return NotFound(ApiResponse<object>.Fail("REQUIREMENT_NOT_FOUND", $"未找到 {modelType} 类型的模型需求"));
        }

        // 更新绑定的模型池 ID 列表
        requirement.ModelGroupIds = request.ModelGroupIds ?? new List<string>();

        app.UpdatedAt = DateTime.UtcNow;
        await _db.LLMAppCallers.ReplaceOneAsync(a => a.Id == id, app);

        _logger.LogInformation("更新应用 {AppCode} 的 {ModelType} 模型绑定: {GroupIds}",
            app.AppCode, modelType, string.Join(",", requirement.ModelGroupIds));

        return Ok(ApiResponse<LLMAppCaller>.Ok(app));
    }

    /// <summary>
    /// 解析单个应用实际会调用的模型
    /// 按优先级查找：1.专属模型池 2.默认模型池 3.传统配置模型
    /// </summary>
    [HttpGet("resolve-model")]
    public async Task<IActionResult> ResolveModel(
        [FromQuery] string appCallerCode,
        [FromQuery] string modelType,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode) || string.IsNullOrWhiteSpace(modelType))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_PARAMS", "appCallerCode 和 modelType 不能为空"));
        }
        if (!IsRegisteredAppCallerForType(appCallerCode, modelType))
        {
            return BadRequest(ApiResponse<object>.Fail("APP_CODE_NOT_REGISTERED", "appCallerCode 未注册或不支持该 modelType"));
        }

        var result = await _gateway.ResolveModelAsync(appCallerCode, modelType, null, ct);

        return Ok(ApiResponse<GatewayModelResolution?>.Ok(result));
    }

    /// <summary>
    /// 批量解析多个应用实际会调用的模型
    /// </summary>
    [HttpPost("resolve-models")]
    public async Task<IActionResult> ResolveModels(
        [FromBody] BatchResolveModelsRequest request,
        CancellationToken ct)
    {
        if (request.Items == null || request.Items.Count == 0)
        {
            return Ok(ApiResponse<Dictionary<string, ResolvedModelInfoDto?>>.Ok(new Dictionary<string, ResolvedModelInfoDto?>()));
        }
        if (request.Items.Any(x => !IsRegisteredAppCallerForType(x.AppCallerCode, x.ModelType)))
        {
            return BadRequest(ApiResponse<object>.Fail("APP_CODE_NOT_REGISTERED", "包含未注册或 modelType 不匹配的 appCallerCode"));
        }

        var results = new Dictionary<string, ResolvedModelInfoDto?>();

        // 并行解析所有模型
        var tasks = request.Items.Select(async item =>
        {
            var key = $"{item.AppCallerCode}::{item.ModelType}";
            var result = await _gateway.ResolveModelAsync(item.AppCallerCode, item.ModelType, null, ct);
            var dto = MapToResolvedModelInfo(result);
            return (key, dto);
        });

        var resolvedItems = await Task.WhenAll(tasks);

        foreach (var (key, result) in resolvedItems)
        {
            results[key] = result;
        }

        return Ok(ApiResponse<Dictionary<string, ResolvedModelInfoDto?>>.Ok(results));
    }

    /// <summary>
    /// 将 GatewayModelResolution 转换为前端期望的 ResolvedModelInfo 格式
    /// </summary>
    private static ResolvedModelInfoDto? MapToResolvedModelInfo(GatewayModelResolution? resolution)
    {
        if (resolution == null || !resolution.Success)
        {
            return null;
        }

        // 根据 ResolutionType 判断来源
        var source = resolution.ResolutionType switch
        {
            "Legacy" => "legacy",
            "DirectModel" => "legacy",
            _ => "pool"
        };

        return new ResolvedModelInfoDto
        {
            Source = source,
            ModelGroupId = resolution.ModelGroupId,
            ModelGroupName = resolution.ModelGroupName,
            IsDefaultForType = resolution.ResolutionType == "DefaultPool",
            PlatformId = resolution.ActualPlatformId,
            PlatformName = resolution.ActualPlatformName ?? "",
            ModelId = resolution.ActualModel,
            ModelDisplayName = resolution.ActualModel, // 暂时使用模型名作为显示名
            HealthStatus = resolution.HealthStatus ?? "Unknown",
            Stats = null, // 统计数据单独获取
            // 降级/回退信息
            IsFallback = resolution.IsFallback,
            FallbackReason = resolution.FallbackReason,
            ConfiguredPool = resolution.IsFallback ? new ConfiguredPoolInfo
            {
                PoolId = resolution.OriginalPoolId,
                PoolName = resolution.OriginalPoolName,
                Models = resolution.OriginalModels?.Select(m => new ConfiguredModelInfo
                {
                    ModelId = m.ModelId,
                    PlatformId = m.PlatformId,
                    HealthStatus = m.HealthStatus,
                    IsAvailable = m.IsAvailable
                }).ToList()
            } : null
        };
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

public class UpdateBindingsRequest
{
    /// <summary>绑定的模型池 ID 列表</summary>
    public List<string>? ModelGroupIds { get; set; }
}

/// <summary>
/// 批量解析模型请求
/// </summary>
public class BatchResolveModelsRequest
{
    /// <summary>要解析的应用模型类型列表</summary>
    public List<ResolveModelItem> Items { get; set; } = new();
}

public class ResolveModelItem
{
    /// <summary>应用标识（appCallerCode）</summary>
    public string AppCallerCode { get; set; } = string.Empty;
    /// <summary>模型类型</summary>
    public string ModelType { get; set; } = string.Empty;
}

/// <summary>
/// 模型解析结果 DTO（匹配前端 ResolvedModelInfo 接口）
/// </summary>
public class ResolvedModelInfoDto
{
    /// <summary>模型来源：pool（模型池）、legacy（传统配置）</summary>
    public string Source { get; set; } = "pool";

    /// <summary>模型池ID（如果来自模型池）</summary>
    public string? ModelGroupId { get; set; }

    /// <summary>模型池名称（如果来自模型池）</summary>
    public string? ModelGroupName { get; set; }

    /// <summary>是否为该类型的默认模型池</summary>
    public bool IsDefaultForType { get; set; }

    /// <summary>平台ID</summary>
    public string PlatformId { get; set; } = string.Empty;

    /// <summary>平台名称</summary>
    public string PlatformName { get; set; } = string.Empty;

    /// <summary>模型ID（实际调用名）</summary>
    public string ModelId { get; set; } = string.Empty;

    /// <summary>模型显示名称</summary>
    public string? ModelDisplayName { get; set; }

    /// <summary>健康状态</summary>
    public string HealthStatus { get; set; } = "Unknown";

    /// <summary>统计数据（暂为 null，单独获取）</summary>
    public object? Stats { get; set; }

    // ========== 降级/回退信息 ==========

    /// <summary>是否发生了降级/回退</summary>
    public bool IsFallback { get; set; }

    /// <summary>降级原因描述（如果 IsFallback=true）</summary>
    public string? FallbackReason { get; set; }

    /// <summary>原始配置的模型池信息（降级前）</summary>
    public ConfiguredPoolInfo? ConfiguredPool { get; set; }
}

/// <summary>
/// 配置的模型池信息（用于展示降级前的预期值）
/// </summary>
public class ConfiguredPoolInfo
{
    /// <summary>模型池 ID</summary>
    public string? PoolId { get; set; }

    /// <summary>模型池名称</summary>
    public string? PoolName { get; set; }

    /// <summary>模型池中的模型列表</summary>
    public List<ConfiguredModelInfo>? Models { get; set; }
}

/// <summary>
/// 配置的模型信息
/// </summary>
public class ConfiguredModelInfo
{
    /// <summary>模型 ID</summary>
    public string ModelId { get; set; } = string.Empty;

    /// <summary>平台 ID</summary>
    public string PlatformId { get; set; } = string.Empty;

    /// <summary>健康状态</summary>
    public string HealthStatus { get; set; } = "Unknown";

    /// <summary>是否可用</summary>
    public bool IsAvailable { get; set; }
}
