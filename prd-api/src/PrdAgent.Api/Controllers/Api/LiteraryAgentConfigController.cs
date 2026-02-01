using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using SixLabors.ImageSharp;
using System.Security.Claims;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 文学创作 Agent 配置管理（底图/参考图等）
/// </summary>
[ApiController]
[Route("api/literary-agent/config")]
[Authorize]
[AdminController("literary-agent", AdminPermissionCatalog.LiteraryAgentUse)]
public class LiteraryAgentConfigController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<LiteraryAgentConfigController> _logger;

    private const string AppKey = "literary-agent";
    private const long MaxUploadBytes = 10 * 1024 * 1024; // 10MB

    /// <summary>
    /// 默认的参考图风格提示词
    /// </summary>
    public const string DefaultReferenceImagePrompt = "请参考图中的风格、色调、构图和视觉元素来生成图片，保持整体美学风格的一致性。";

    public LiteraryAgentConfigController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        ILogger<LiteraryAgentConfigController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    // 硬编码的 appCallerCode（应用身份隔离原则）
    private static class AppCallerCodes
    {
        /// <summary>文学创作配图-文生图（无参考图）</summary>
        public const string Text2Img = "literary-agent.illustration.text2img::generation";
        
        /// <summary>文学创作配图-图生图（有风格参考图）</summary>
        public const string Img2Img = "literary-agent.illustration.img2img::generation";
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    #region 模型查询（无参数，内部硬编码 appCallerCode）

    /// <summary>
    /// 获取文学创作"文生图"可用的模型池列表（无参考图场景）
    /// 内部使用硬编码的 appCallerCode: literary-agent.illustration.text2img::generation
    /// </summary>
    [HttpGet("models/text2img")]
    public async Task<IActionResult> GetText2ImgModels(CancellationToken ct)
    {
        return await GetModelsForAppCallerCode(AppCallerCodes.Text2Img, ct);
    }

    /// <summary>
    /// 获取文学创作"图生图"可用的模型池列表（有风格参考图场景）
    /// 内部使用硬编码的 appCallerCode: literary-agent.illustration.img2img::generation
    /// </summary>
    [HttpGet("models/img2img")]
    public async Task<IActionResult> GetImg2ImgModels(CancellationToken ct)
    {
        return await GetModelsForAppCallerCode(AppCallerCodes.Img2Img, ct);
    }

    /// <summary>
    /// 获取配图生成可用的模型池（兼容旧接口，根据是否有激活的参考图自动选择）
    /// </summary>
    [HttpGet("models/image-gen")]
    public async Task<IActionResult> GetImageGenModels(CancellationToken ct)
    {
        // 检查是否有激活的参考图配置
        var hasActiveRefImage = await _db.ReferenceImageConfigs
            .Find(x => x.AppKey == AppKey && x.IsActive)
            .AnyAsync(ct);

        // 有参考图用 img2img，没有用 text2img
        var appCallerCode = hasActiveRefImage ? AppCallerCodes.Img2Img : AppCallerCodes.Text2Img;
        return await GetModelsForAppCallerCode(appCallerCode, ct);
    }

    /// <summary>
    /// 获取两种场景的模型池（文生图 + 图生图）
    /// 前端可一次性获取，用于同时显示两个模型状态
    /// </summary>
    [HttpGet("models/all")]
    public async Task<IActionResult> GetAllImageGenModels(CancellationToken ct)
    {
        var text2imgTask = GetModelPoolsForAppCallerCode(AppCallerCodes.Text2Img, ct);
        var img2imgTask = GetModelPoolsForAppCallerCode(AppCallerCodes.Img2Img, ct);

        await Task.WhenAll(text2imgTask, img2imgTask);

        return Ok(ApiResponse<object>.Ok(new
        {
            text2img = new
            {
                appCallerCode = AppCallerCodes.Text2Img,
                pools = text2imgTask.Result
            },
            img2img = new
            {
                appCallerCode = AppCallerCodes.Img2Img,
                pools = img2imgTask.Result
            }
        }));
    }

    /// <summary>
    /// 通用方法：根据 appCallerCode 获取模型池列表
    /// </summary>
    private async Task<IActionResult> GetModelsForAppCallerCode(string appCallerCode, CancellationToken ct)
    {
        var result = await GetModelPoolsForAppCallerCode(appCallerCode, ct);
        return Ok(ApiResponse<List<ModelPoolForAppResponse>>.Ok(result));
    }

    /// <summary>
    /// 通用方法：根据 appCallerCode 获取模型池列表（内部使用）
    /// </summary>
    private async Task<List<ModelPoolForAppResponse>> GetModelPoolsForAppCallerCode(string appCallerCode, CancellationToken ct)
    {
        const string modelType = "generation";
        var result = new List<ModelPoolForAppResponse>();

        // Step 1: 查找专属模型池（最高优先级）
        var app = await _db.LLMAppCallers.Find(a => a.AppCode == appCallerCode).FirstOrDefaultAsync(ct);
        if (app != null)
        {
            var requirement = app.ModelRequirements.FirstOrDefault(r => r.ModelType == modelType);
            if (requirement != null && requirement.ModelGroupIds.Count > 0)
            {
                var dedicatedGroups = await _db.ModelGroups
                    .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                    .SortBy(g => g.Priority)
                    .ThenBy(g => g.CreatedAt)
                    .ToListAsync(ct);

                if (dedicatedGroups.Count > 0)
                {
                    foreach (var group in dedicatedGroups)
                    {
                        result.Add(MapToResponse(group, "DedicatedPool", isDedicated: true));
                    }
                    return result;
                }
            }
        }

        // Step 2: 查找默认模型池
        var defaultGroups = await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .SortBy(g => g.Priority)
            .ThenBy(g => g.CreatedAt)
            .ToListAsync(ct);

        if (defaultGroups.Count > 0)
        {
            foreach (var group in defaultGroups)
            {
                result.Add(MapToResponse(group, "DefaultPool", isDefault: true));
            }
            return result;
        }

        // Step 3: 传统配置（isImageGen）
        var legacyModel = await _db.LLMModels
            .Find(m => m.IsImageGen && m.Enabled)
            .FirstOrDefaultAsync(ct);

        if (legacyModel != null)
        {
            result.Add(new ModelPoolForAppResponse
            {
                Id = $"legacy-{legacyModel.Id}",
                Name = $"默认生图 - {legacyModel.Name}",
                Code = legacyModel.ModelName,
                Priority = 1,
                ModelType = modelType,
                IsDefaultForType = false,
                Models = new List<ModelPoolItemResponse>
                {
                    new()
                    {
                        ModelId = legacyModel.ModelName,
                        PlatformId = legacyModel.PlatformId ?? string.Empty,
                        Priority = 1,
                        HealthStatus = "Healthy"
                    }
                },
                ResolutionType = "DirectModel",
                IsDedicated = false,
                IsDefault = false,
                IsLegacy = true
            });
        }

        return result;
    }

    private static ModelPoolForAppResponse MapToResponse(
        ModelGroup group,
        string resolutionType,
        bool isDedicated = false,
        bool isDefault = false,
        bool isLegacy = false)
    {
        return new ModelPoolForAppResponse
        {
            Id = group.Id,
            Name = group.Name,
            Code = group.Code,
            Priority = group.Priority,
            ModelType = group.ModelType,
            IsDefaultForType = group.IsDefaultForType,
            Description = group.Description,
            Models = group.Models?.Select(m => new ModelPoolItemResponse
            {
                ModelId = m.ModelId,
                PlatformId = m.PlatformId,
                Priority = m.Priority,
                HealthStatus = m.HealthStatus.ToString()
            }).ToList() ?? new List<ModelPoolItemResponse>(),
            ResolutionType = resolutionType,
            IsDedicated = isDedicated,
            IsDefault = isDefault,
            IsLegacy = isLegacy
        };
    }

    #endregion

    #region 底图配置 CRUD

    /// <summary>
    /// 获取所有底图配置列表
    /// </summary>
    [HttpGet("reference-images")]
    public async Task<IActionResult> ListReferenceImages(CancellationToken ct)
    {
        var configs = await _db.ReferenceImageConfigs
            .Find(x => x.AppKey == AppKey)
            .SortByDescending(x => x.IsActive)
            .ThenByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items = configs }));
    }

    /// <summary>
    /// 创建新的底图配置
    /// </summary>
    [HttpPost("reference-images")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> CreateReferenceImage(
        [FromForm] string name,
        [FromForm] string? prompt,
        [FromForm] IFormFile file,
        CancellationToken ct)
    {
        var adminId = GetAdminId();

        if (string.IsNullOrWhiteSpace(name))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "name 不能为空"));
        }

        if (_assetStorage is not TencentCosStorage)
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));
        }

        if (file == null || file.Length <= 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        }

        if (file.Length > MaxUploadBytes)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大，最大支持 10MB"));
        }

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        if (bytes.Length == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));
        }

        // 验证图片格式
        SixLabors.ImageSharp.Formats.IImageFormat? format;
        try
        {
            format = Image.DetectFormat(bytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Invalid reference image upload.");
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片解析失败"));
        }

        if (format == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片格式不支持"));
        }

        var mime = string.IsNullOrWhiteSpace(format.DefaultMimeType) ? "image/png" : format.DefaultMimeType;

        // 保存到 COS（使用 VisualAgent 域名，与 Worker 读取保持一致）
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct,
            domain: AppDomainPaths.DomainVisualAgent,
            type: AppDomainPaths.TypeImg);

        var now = DateTime.UtcNow;
        var config = new ReferenceImageConfig
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = name.Trim(),
            Prompt = string.IsNullOrWhiteSpace(prompt) ? DefaultReferenceImagePrompt : prompt.Trim(),
            ImageSha256 = stored.Sha256,
            ImageUrl = stored.Url,
            IsActive = false,
            AppKey = AppKey,
            CreatedByAdminId = adminId,
            CreatedAt = now,
            UpdatedAt = now
        };

        await _db.ReferenceImageConfigs.InsertOneAsync(config, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { config }));
    }

    /// <summary>
    /// 更新底图配置（名称和提示词）
    /// </summary>
    [HttpPut("reference-images/{id}")]
    public async Task<IActionResult> UpdateReferenceImage(
        string id,
        [FromBody] UpdateReferenceImageRequest request,
        CancellationToken ct)
    {
        var config = await _db.ReferenceImageConfigs
            .Find(x => x.Id == id && x.AppKey == AppKey)
            .FirstOrDefaultAsync(ct);

        if (config == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "配置不存在"));
        }

        if (!string.IsNullOrWhiteSpace(request.Name))
        {
            config.Name = request.Name.Trim();
        }

        if (request.Prompt != null) // 允许设置为空字符串
        {
            config.Prompt = request.Prompt.Trim();
        }

        config.UpdatedAt = DateTime.UtcNow;

        await _db.ReferenceImageConfigs.ReplaceOneAsync(x => x.Id == id, config, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { config }));
    }

    /// <summary>
    /// 更新底图配置的图片
    /// </summary>
    [HttpPut("reference-images/{id}/image")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> UpdateReferenceImageFile(
        string id,
        [FromForm] IFormFile file,
        CancellationToken ct)
    {
        var config = await _db.ReferenceImageConfigs
            .Find(x => x.Id == id && x.AppKey == AppKey)
            .FirstOrDefaultAsync(ct);

        if (config == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "配置不存在"));
        }

        if (_assetStorage is not TencentCosStorage)
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));
        }

        if (file == null || file.Length <= 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        }

        if (file.Length > MaxUploadBytes)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大，最大支持 10MB"));
        }

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        if (bytes.Length == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));
        }

        // 验证图片格式
        SixLabors.ImageSharp.Formats.IImageFormat? format;
        try
        {
            format = Image.DetectFormat(bytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Invalid reference image upload.");
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片解析失败"));
        }

        if (format == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片格式不支持"));
        }

        var mime = string.IsNullOrWhiteSpace(format.DefaultMimeType) ? "image/png" : format.DefaultMimeType;

        // 保存到 COS（使用 VisualAgent 域名，与 Worker 读取保持一致）
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct,
            domain: AppDomainPaths.DomainVisualAgent,
            type: AppDomainPaths.TypeImg);

        config.ImageSha256 = stored.Sha256;
        config.ImageUrl = stored.Url;
        config.UpdatedAt = DateTime.UtcNow;

        await _db.ReferenceImageConfigs.ReplaceOneAsync(x => x.Id == id, config, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { config }));
    }

    /// <summary>
    /// 删除底图配置
    /// </summary>
    [HttpDelete("reference-images/{id}")]
    public async Task<IActionResult> DeleteReferenceImage(string id, CancellationToken ct)
    {
        var config = await _db.ReferenceImageConfigs
            .Find(x => x.Id == id && x.AppKey == AppKey)
            .FirstOrDefaultAsync(ct);

        if (config == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "配置不存在"));
        }

        await _db.ReferenceImageConfigs.DeleteOneAsync(x => x.Id == id, ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 激活底图配置
    /// </summary>
    [HttpPost("reference-images/{id}/activate")]
    public async Task<IActionResult> ActivateReferenceImage(string id, CancellationToken ct)
    {
        var config = await _db.ReferenceImageConfigs
            .Find(x => x.Id == id && x.AppKey == AppKey)
            .FirstOrDefaultAsync(ct);

        if (config == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "配置不存在"));
        }

        // 先取消所有其他配置的激活状态
        await _db.ReferenceImageConfigs.UpdateManyAsync(
            x => x.AppKey == AppKey && x.IsActive,
            Builders<ReferenceImageConfig>.Update.Set(x => x.IsActive, false),
            cancellationToken: ct);

        // 激活当前配置
        config.IsActive = true;
        config.UpdatedAt = DateTime.UtcNow;
        await _db.ReferenceImageConfigs.ReplaceOneAsync(x => x.Id == id, config, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { config }));
    }

    /// <summary>
    /// 取消激活底图配置
    /// </summary>
    [HttpPost("reference-images/{id}/deactivate")]
    public async Task<IActionResult> DeactivateReferenceImage(string id, CancellationToken ct)
    {
        var config = await _db.ReferenceImageConfigs
            .Find(x => x.Id == id && x.AppKey == AppKey)
            .FirstOrDefaultAsync(ct);

        if (config == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "配置不存在"));
        }

        config.IsActive = false;
        config.UpdatedAt = DateTime.UtcNow;
        await _db.ReferenceImageConfigs.ReplaceOneAsync(x => x.Id == id, config, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { config }));
    }

    /// <summary>
    /// 获取当前激活的底图配置
    /// </summary>
    [HttpGet("reference-images/active")]
    public async Task<IActionResult> GetActiveReferenceImage(CancellationToken ct)
    {
        var config = await _db.ReferenceImageConfigs
            .Find(x => x.AppKey == AppKey && x.IsActive)
            .FirstOrDefaultAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { config }));
    }

    #endregion

    #region 兼容旧 API（保持向后兼容）

    /// <summary>
    /// 获取文学创作 Agent 配置（兼容旧 API）
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetConfig(CancellationToken ct)
    {
        // 尝试从新的 ReferenceImageConfigs 获取激活的配置
        var activeConfig = await _db.ReferenceImageConfigs
            .Find(x => x.AppKey == AppKey && x.IsActive)
            .FirstOrDefaultAsync(ct);

        if (activeConfig != null)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                id = AppKey,
                referenceImageSha256 = activeConfig.ImageSha256,
                referenceImageUrl = activeConfig.ImageUrl,
                referenceImagePrompt = activeConfig.Prompt,
                activeConfigId = activeConfig.Id,
                activeConfigName = activeConfig.Name,
                createdAt = activeConfig.CreatedAt,
                updatedAt = activeConfig.UpdatedAt
            }));
        }

        // 回退到旧的 LiteraryAgentConfigs
        var config = await _db.LiteraryAgentConfigs
            .Find(x => x.Id == AppKey)
            .FirstOrDefaultAsync(ct);

        if (config != null)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                id = config.Id,
                referenceImageSha256 = config.ReferenceImageSha256,
                referenceImageUrl = config.ReferenceImageUrl,
                referenceImagePrompt = (string?)null,
                activeConfigId = (string?)null,
                activeConfigName = (string?)null,
                createdAt = config.CreatedAt,
                updatedAt = config.UpdatedAt
            }));
        }

        // 返回空配置
        return Ok(ApiResponse<object>.Ok(new
        {
            id = AppKey,
            referenceImageSha256 = (string?)null,
            referenceImageUrl = (string?)null,
            referenceImagePrompt = (string?)null,
            activeConfigId = (string?)null,
            activeConfigName = (string?)null,
            createdAt = DateTime.UtcNow,
            updatedAt = DateTime.UtcNow
        }));
    }

    /// <summary>
    /// 上传底图/参考图（兼容旧 API - 创建新配置并激活）
    /// </summary>
    [HttpPost("reference-image")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> UploadReferenceImage([FromForm] IFormFile file, CancellationToken ct)
    {
        var adminId = GetAdminId();

        if (_assetStorage is not TencentCosStorage)
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));
        }

        if (file == null || file.Length <= 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        }

        if (file.Length > MaxUploadBytes)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大，最大支持 10MB"));
        }

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        if (bytes.Length == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));
        }

        // 验证图片格式
        SixLabors.ImageSharp.Formats.IImageFormat? format;
        try
        {
            format = Image.DetectFormat(bytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Invalid reference image upload.");
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片解析失败"));
        }

        if (format == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片格式不支持"));
        }

        var mime = string.IsNullOrWhiteSpace(format.DefaultMimeType) ? "image/png" : format.DefaultMimeType;

        // 保存到 COS（使用 VisualAgent 域名，与 Worker 读取保持一致）
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct,
            domain: AppDomainPaths.DomainVisualAgent,
            type: AppDomainPaths.TypeImg);

        var now = DateTime.UtcNow;

        // 先取消所有其他配置的激活状态
        await _db.ReferenceImageConfigs.UpdateManyAsync(
            x => x.AppKey == AppKey && x.IsActive,
            Builders<ReferenceImageConfig>.Update.Set(x => x.IsActive, false),
            cancellationToken: ct);

        // 创建新配置并激活
        var newConfig = new ReferenceImageConfig
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = $"底图配置 {now:yyyyMMdd-HHmmss}",
            Prompt = DefaultReferenceImagePrompt,
            ImageSha256 = stored.Sha256,
            ImageUrl = stored.Url,
            IsActive = true,
            AppKey = AppKey,
            CreatedByAdminId = adminId,
            CreatedAt = now,
            UpdatedAt = now
        };

        await _db.ReferenceImageConfigs.InsertOneAsync(newConfig, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            sha256 = stored.Sha256,
            url = stored.Url,
            config = new
            {
                id = AppKey,
                referenceImageSha256 = newConfig.ImageSha256,
                referenceImageUrl = newConfig.ImageUrl,
                referenceImagePrompt = newConfig.Prompt,
                activeConfigId = newConfig.Id,
                activeConfigName = newConfig.Name,
                createdAt = newConfig.CreatedAt,
                updatedAt = newConfig.UpdatedAt
            }
        }));
    }

    /// <summary>
    /// 清除底图/参考图（兼容旧 API - 取消所有激活）
    /// </summary>
    [HttpDelete("reference-image")]
    public async Task<IActionResult> ClearReferenceImage(CancellationToken ct)
    {
        // 取消所有配置的激活状态
        await _db.ReferenceImageConfigs.UpdateManyAsync(
            x => x.AppKey == AppKey && x.IsActive,
            Builders<ReferenceImageConfig>.Update.Set(x => x.IsActive, false),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            cleared = true,
            config = new
            {
                id = AppKey,
                referenceImageSha256 = (string?)null,
                referenceImageUrl = (string?)null,
                referenceImagePrompt = (string?)null,
                activeConfigId = (string?)null,
                activeConfigName = (string?)null,
                createdAt = DateTime.UtcNow,
                updatedAt = DateTime.UtcNow
            }
        }));
    }

    #endregion
}

public class UpdateReferenceImageRequest
{
    public string? Name { get; set; }
    public string? Prompt { get; set; }
}

public class UpdateLiteraryAgentConfigRequest
{
    public string? ReferenceImageSha256 { get; set; }
    public string? ReferenceImageUrl { get; set; }
}

/// <summary>
/// 应用模型池响应（简化版，用于应用内部查询）
/// </summary>
public class ModelPoolForAppResponse
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Code { get; set; } = string.Empty;
    public int Priority { get; set; }
    public string ModelType { get; set; } = string.Empty;
    public bool IsDefaultForType { get; set; }
    public string? Description { get; set; }
    public List<ModelPoolItemResponse> Models { get; set; } = new();

    /// <summary>解析类型：DedicatedPool(专属池)、DefaultPool(默认池)、DirectModel(传统配置)</summary>
    public string ResolutionType { get; set; } = string.Empty;
    /// <summary>是否为该应用的专属模型池</summary>
    public bool IsDedicated { get; set; }
    /// <summary>是否为该类型的默认模型池</summary>
    public bool IsDefault { get; set; }
    /// <summary>是否为传统配置模型</summary>
    public bool IsLegacy { get; set; }
}

/// <summary>
/// 模型池中的模型项响应
/// </summary>
public class ModelPoolItemResponse
{
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;
    public int Priority { get; set; }
    public string HealthStatus { get; set; } = "Healthy";
}
