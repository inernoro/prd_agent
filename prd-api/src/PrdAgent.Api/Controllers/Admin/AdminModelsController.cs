using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - LLM模型控制器
/// </summary>
[ApiController]
[Route("api/v1/config")]
[Authorize(Roles = "ADMIN")]
public class AdminModelsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminModelsController> _logger;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;

    public AdminModelsController(
        MongoDbContext db,
        ILogger<AdminModelsController> logger,
        IConfiguration config,
        IHttpClientFactory httpClientFactory)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>
    /// 获取所有模型
    /// </summary>
    [HttpGet("models")]
    public async Task<IActionResult> GetModels()
    {
        var models = await _db.LLMModels.Find(_ => true)
            .SortBy(m => m.Priority)
            .ThenByDescending(m => m.CreatedAt)
            .ToListAsync();

        // 获取平台信息用于展示
        var platformIds = models.Where(m => m.PlatformId != null).Select(m => m.PlatformId!).Distinct().ToList();
        var platforms = await _db.LLMPlatforms.Find(p => platformIds.Contains(p.Id)).ToListAsync();
        var platformMap = platforms.ToDictionary(p => p.Id, p => p.Name);

        var response = models.Select(m => MapModelResponse(m, platformMap));
        return Ok(ApiResponse<object>.Ok(response));
    }

    /// <summary>
    /// 获取单个模型
    /// </summary>
    [HttpGet("models/{id}")]
    public async Task<IActionResult> GetModel(string id)
    {
        var model = await _db.LLMModels.Find(m => m.Id == id).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        string? platformName = null;
        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            platformName = platform?.Name;
        }

        return Ok(ApiResponse<object>.Ok(MapModelResponse(model, 
            platformName != null ? new Dictionary<string, string> { { model.PlatformId!, platformName } } : new())));
    }

    /// <summary>
    /// 创建模型
    /// </summary>
    [HttpPost("models")]
    public async Task<IActionResult> CreateModel([FromBody] CreateModelRequest request)
    {
        // 检查模型名唯一性
        var existing = await _db.LLMModels.Find(m => m.ModelName == request.ModelName).FirstOrDefaultAsync();
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE_MODEL", "模型名称已存在"));
        }

        // 如果指定了平台，验证平台存在
        if (!string.IsNullOrEmpty(request.PlatformId))
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == request.PlatformId).FirstOrDefaultAsync();
            if (platform == null)
            {
                return BadRequest(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "指定的平台不存在"));
            }
        }

        // 获取最大优先级
        var maxPriority = await _db.LLMModels.Find(_ => true)
            .SortByDescending(m => m.Priority)
            .Limit(1)
            .Project(m => m.Priority)
            .FirstOrDefaultAsync();

        var model = new LLMModel
        {
            Name = request.Name,
            ModelName = request.ModelName,
            ApiUrl = request.ApiUrl,
            ApiKeyEncrypted = string.IsNullOrEmpty(request.ApiKey) ? null : EncryptApiKey(request.ApiKey),
            PlatformId = request.PlatformId,
            Group = request.Group,
            Timeout = request.Timeout,
            MaxRetries = request.MaxRetries,
            MaxConcurrency = request.MaxConcurrency,
            Enabled = request.Enabled,
            Priority = request.Priority ?? maxPriority + 1,
            Remark = request.Remark,
            EnablePromptCache = request.EnablePromptCache
        };

        await _db.LLMModels.InsertOneAsync(model);
        _logger.LogInformation("Model created: {Name} ({ModelName})", model.Name, model.ModelName);

        return CreatedAtAction(nameof(GetModel), new { id = model.Id }, 
            ApiResponse<object>.Ok(new { model.Id }));
    }

    /// <summary>
    /// 更新模型
    /// </summary>
    [HttpPut("models/{id}")]
    public async Task<IActionResult> UpdateModel(string id, [FromBody] UpdateModelRequest request)
    {
        // 检查模型名唯一性（排除自身）
        var existing = await _db.LLMModels.Find(m => m.ModelName == request.ModelName && m.Id != id).FirstOrDefaultAsync();
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE_MODEL", "模型名称已存在"));
        }

        var update = Builders<LLMModel>.Update
            .Set(m => m.Name, request.Name)
            .Set(m => m.ModelName, request.ModelName)
            .Set(m => m.ApiUrl, request.ApiUrl)
            .Set(m => m.PlatformId, request.PlatformId)
            .Set(m => m.Group, request.Group)
            .Set(m => m.Timeout, request.Timeout)
            .Set(m => m.MaxRetries, request.MaxRetries)
            .Set(m => m.MaxConcurrency, request.MaxConcurrency)
            .Set(m => m.Enabled, request.Enabled)
            .Set(m => m.EnablePromptCache, request.EnablePromptCache)
            .Set(m => m.Remark, request.Remark)
            .Set(m => m.UpdatedAt, DateTime.UtcNow);

        if (request.Priority.HasValue)
        {
            update = update.Set(m => m.Priority, request.Priority.Value);
        }

        if (!string.IsNullOrEmpty(request.ApiKey))
        {
            update = update.Set(m => m.ApiKeyEncrypted, EncryptApiKey(request.ApiKey));
        }

        var result = await _db.LLMModels.UpdateOneAsync(m => m.Id == id, update);
        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        _logger.LogInformation("Model updated: {Id}", id);
        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 删除模型
    /// </summary>
    [HttpDelete("models/{id}")]
    public async Task<IActionResult> DeleteModel(string id)
    {
        var result = await _db.LLMModels.DeleteOneAsync(m => m.Id == id);
        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        _logger.LogInformation("Model deleted: {Id}", id);
        return NoContent();
    }

    /// <summary>
    /// 删除所有模型
    /// </summary>
    [HttpDelete("models/all")]
    public async Task<IActionResult> DeleteAllModels()
    {
        var result = await _db.LLMModels.DeleteManyAsync(_ => true);
        _logger.LogInformation("All models deleted: {Count} models", result.DeletedCount);
        return Ok(ApiResponse<object>.Ok(new { deletedCount = result.DeletedCount }));
    }

    /// <summary>
    /// 测试模型连接
    /// </summary>
    [HttpPost("models/{id}/test")]
    public async Task<IActionResult> TestModel(string id)
    {
        var model = await _db.LLMModels.Find(m => m.Id == id).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        // 获取API配置（可能需要从平台继承）
        var (apiUrl, apiKey) = await ResolveApiConfig(model);
        if (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_CONFIG", "API配置不完整"));
        }

        var startTime = DateTime.UtcNow;
        try
        {
            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromMilliseconds(Math.Min(model.Timeout, 30000));
            client.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");

            var requestBody = new
            {
                model = model.ModelName,
                messages = new[]
                {
                    new { role = "user", content = "Hi" }
                },
                max_tokens = 10,
                stream = false
            };

            var response = await client.PostAsJsonAsync(
                GetChatEndpoint(apiUrl), 
                requestBody);
            
            var duration = (int)(DateTime.UtcNow - startTime).TotalMilliseconds;

            if (response.IsSuccessStatusCode)
            {
                // 更新统计
                await _db.LLMModels.UpdateOneAsync(
                    m => m.Id == id,
                    Builders<LLMModel>.Update
                        .Inc(m => m.CallCount, 1)
                        .Inc(m => m.SuccessCount, 1)
                        .Inc(m => m.TotalDuration, duration));

                return Ok(ApiResponse<object>.Ok(new { success = true, duration }));
            }
            else
            {
                var error = await response.Content.ReadAsStringAsync();
                
                // 更新统计
                await _db.LLMModels.UpdateOneAsync(
                    m => m.Id == id,
                    Builders<LLMModel>.Update
                        .Inc(m => m.CallCount, 1)
                        .Inc(m => m.FailCount, 1));

                return Ok(ApiResponse<object>.Ok(new { 
                    success = false, 
                    duration,
                    error = $"HTTP {(int)response.StatusCode}: {error[..Math.Min(error.Length, 200)]}" 
                }));
            }
        }
        catch (Exception ex)
        {
            var duration = (int)(DateTime.UtcNow - startTime).TotalMilliseconds;
            
            // 更新统计
            await _db.LLMModels.UpdateOneAsync(
                m => m.Id == id,
                Builders<LLMModel>.Update
                    .Inc(m => m.CallCount, 1)
                    .Inc(m => m.FailCount, 1));

            return Ok(ApiResponse<object>.Ok(new { 
                success = false, 
                duration,
                error = ex.Message 
            }));
        }
    }

    /// <summary>
    /// 批量更新模型优先级（用于拖拽排序）
    /// </summary>
    [HttpPut("models/priorities")]
    public async Task<IActionResult> UpdatePriorities([FromBody] List<ModelPriorityUpdate> updates)
    {
        foreach (var item in updates)
        {
            await _db.LLMModels.UpdateOneAsync(
                m => m.Id == item.Id,
                Builders<LLMModel>.Update.Set(m => m.Priority, item.Priority));
        }

        _logger.LogInformation("Model priorities updated: {Count} models", updates.Count);
        return Ok(ApiResponse<object>.Ok(new { updated = updates.Count }));
    }

    /// <summary>
    /// 设置主模型
    /// </summary>
    [HttpPut("main-model")]
    public async Task<IActionResult> SetMainModel([FromBody] SetMainModelRequest request)
    {
        // 验证模型存在
        var model = await _db.LLMModels.Find(m => m.Id == request.ModelId).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        // 取消所有主模型标记
        await _db.LLMModels.UpdateManyAsync(
            _ => true,
            Builders<LLMModel>.Update.Set(m => m.IsMain, false));

        // 设置新的主模型
        await _db.LLMModels.UpdateOneAsync(
            m => m.Id == request.ModelId,
            Builders<LLMModel>.Update
                .Set(m => m.IsMain, true)
                .Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Main model set: {Id}", request.ModelId);
        return Ok(ApiResponse<object>.Ok(new { modelId = request.ModelId, isMain = true }));
    }

    /// <summary>
    /// 获取主模型
    /// </summary>
    [HttpGet("main-model")]
    public async Task<IActionResult> GetMainModel()
    {
        var model = await _db.LLMModels.Find(m => m.IsMain).FirstOrDefaultAsync();
        if (model == null)
        {
            return Ok(ApiResponse<object>.Ok(new { }));
        }

        string? platformName = null;
        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            platformName = platform?.Name;
        }

        return Ok(ApiResponse<object>.Ok(MapModelResponse(model,
            platformName != null ? new Dictionary<string, string> { { model.PlatformId!, platformName } } : new())));
    }

    /// <summary>
    /// 设置意图模型
    /// </summary>
    [HttpPut("intent-model")]
    public async Task<IActionResult> SetIntentModel([FromBody] SetPurposeModelRequest request)
    {
        var model = await _db.LLMModels.Find(m => m.Id == request.ModelId).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsIntent, false));
        await _db.LLMModels.UpdateOneAsync(
            m => m.Id == request.ModelId,
            Builders<LLMModel>.Update.Set(m => m.IsIntent, true).Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Intent model set: {Id}", request.ModelId);
        return Ok(ApiResponse<object>.Ok(new { modelId = request.ModelId, isIntent = true }));
    }

    /// <summary>
    /// 获取意图模型
    /// </summary>
    [HttpGet("intent-model")]
    public async Task<IActionResult> GetIntentModel()
    {
        var model = await _db.LLMModels.Find(m => m.IsIntent).FirstOrDefaultAsync();
        if (model == null) return Ok(ApiResponse<object>.Ok(new { }));

        string? platformName = null;
        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            platformName = platform?.Name;
        }

        return Ok(ApiResponse<object>.Ok(MapModelResponse(model,
            platformName != null ? new Dictionary<string, string> { { model.PlatformId!, platformName } } : new())));
    }

    /// <summary>
    /// 取消意图模型（清空 IsIntent 标记；调用侧将自动回退主模型执行）
    /// </summary>
    [HttpDelete("intent-model")]
    public async Task<IActionResult> ClearIntentModel()
    {
        await _db.LLMModels.UpdateManyAsync(
            m => m.IsIntent,
            Builders<LLMModel>.Update
                .Set(m => m.IsIntent, false)
                .Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Intent model cleared");
        return Ok(ApiResponse<object>.Ok(new { cleared = true }));
    }

    /// <summary>
    /// 设置图片识别模型
    /// </summary>
    [HttpPut("vision-model")]
    public async Task<IActionResult> SetVisionModel([FromBody] SetPurposeModelRequest request)
    {
        var model = await _db.LLMModels.Find(m => m.Id == request.ModelId).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsVision, false));
        await _db.LLMModels.UpdateOneAsync(
            m => m.Id == request.ModelId,
            Builders<LLMModel>.Update.Set(m => m.IsVision, true).Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Vision model set: {Id}", request.ModelId);
        return Ok(ApiResponse<object>.Ok(new { modelId = request.ModelId, isVision = true }));
    }

    /// <summary>
    /// 获取图片识别模型
    /// </summary>
    [HttpGet("vision-model")]
    public async Task<IActionResult> GetVisionModel()
    {
        var model = await _db.LLMModels.Find(m => m.IsVision).FirstOrDefaultAsync();
        if (model == null) return Ok(ApiResponse<object>.Ok(new { }));

        string? platformName = null;
        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            platformName = platform?.Name;
        }

        return Ok(ApiResponse<object>.Ok(MapModelResponse(model,
            platformName != null ? new Dictionary<string, string> { { model.PlatformId!, platformName } } : new())));
    }

    /// <summary>
    /// 取消图片识别模型（清空 IsVision 标记；调用侧将自动回退主模型执行）
    /// </summary>
    [HttpDelete("vision-model")]
    public async Task<IActionResult> ClearVisionModel()
    {
        await _db.LLMModels.UpdateManyAsync(
            m => m.IsVision,
            Builders<LLMModel>.Update
                .Set(m => m.IsVision, false)
                .Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Vision model cleared");
        return Ok(ApiResponse<object>.Ok(new { cleared = true }));
    }

    /// <summary>
    /// 设置图片生成模型
    /// </summary>
    [HttpPut("image-gen-model")]
    public async Task<IActionResult> SetImageGenModel([FromBody] SetPurposeModelRequest request)
    {
        var model = await _db.LLMModels.Find(m => m.Id == request.ModelId).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsImageGen, false));
        await _db.LLMModels.UpdateOneAsync(
            m => m.Id == request.ModelId,
            Builders<LLMModel>.Update.Set(m => m.IsImageGen, true).Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("ImageGen model set: {Id}", request.ModelId);
        return Ok(ApiResponse<object>.Ok(new { modelId = request.ModelId, isImageGen = true }));
    }

    /// <summary>
    /// 获取图片生成模型
    /// </summary>
    [HttpGet("image-gen-model")]
    public async Task<IActionResult> GetImageGenModel()
    {
        var model = await _db.LLMModels.Find(m => m.IsImageGen).FirstOrDefaultAsync();
        if (model == null) return Ok(ApiResponse<object>.Ok(new { }));

        string? platformName = null;
        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            platformName = platform?.Name;
        }

        return Ok(ApiResponse<object>.Ok(MapModelResponse(model,
            platformName != null ? new Dictionary<string, string> { { model.PlatformId!, platformName } } : new())));
    }

    /// <summary>
    /// 取消图片生成模型（清空 IsImageGen 标记；调用侧将自动回退主模型执行）
    /// </summary>
    [HttpDelete("image-gen-model")]
    public async Task<IActionResult> ClearImageGenModel()
    {
        await _db.LLMModels.UpdateManyAsync(
            m => m.IsImageGen,
            Builders<LLMModel>.Update
                .Set(m => m.IsImageGen, false)
                .Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("ImageGen model cleared");
        return Ok(ApiResponse<object>.Ok(new { cleared = true }));
    }

    /// <summary>
    /// 从平台批量添加模型
    /// </summary>
    [HttpPost("models/batch-from-platform")]
    public async Task<IActionResult> BatchAddFromPlatform([FromBody] BatchAddModelsRequest request)
    {
        var platform = await _db.LLMPlatforms.Find(p => p.Id == request.PlatformId).FirstOrDefaultAsync();
        if (platform == null)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        // 获取当前最大优先级
        var maxPriority = await _db.LLMModels.Find(_ => true)
            .SortByDescending(m => m.Priority)
            .Limit(1)
            .Project(m => m.Priority)
            .FirstOrDefaultAsync();

        var addedModels = new List<string>();
        var skippedModels = new List<string>();
        var priority = maxPriority + 1;

        foreach (var modelInfo in request.Models)
        {
            // 检查是否已存在
            var existing = await _db.LLMModels.Find(m => m.ModelName == modelInfo.ModelName).FirstOrDefaultAsync();
            if (existing != null)
            {
                skippedModels.Add(modelInfo.ModelName);
                continue;
            }

            var model = new LLMModel
            {
                Name = modelInfo.DisplayName ?? modelInfo.ModelName,
                ModelName = modelInfo.ModelName,
                PlatformId = request.PlatformId,
                Group = modelInfo.Group,
                Priority = priority++,
                Enabled = true,
                EnablePromptCache = true
            };

            await _db.LLMModels.InsertOneAsync(model);
            addedModels.Add(modelInfo.ModelName);
        }

        _logger.LogInformation("Batch added {Count} models from platform {PlatformId}", addedModels.Count, request.PlatformId);

        return Ok(ApiResponse<object>.Ok(new { 
            added = addedModels,
            skipped = skippedModels,
            addedCount = addedModels.Count,
            skippedCount = skippedModels.Count
        }));
    }

    private async Task<(string? apiUrl, string? apiKey)> ResolveApiConfig(LLMModel model)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : DecryptApiKey(model.ApiKeyEncrypted);

        // 如果模型没有配置，从平台继承
        if (model.PlatformId != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            if (platform != null)
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= DecryptApiKey(platform.ApiKeyEncrypted);
            }
        }

        return (apiUrl, apiKey);
    }

    private string GetChatEndpoint(string apiUrl)
    {
        apiUrl = apiUrl.TrimEnd('/');
        if (apiUrl.EndsWith("#"))
        {
            return apiUrl.TrimEnd('#');
        }
        if (apiUrl.EndsWith("/chat/completions"))
        {
            return apiUrl;
        }
        if (!apiUrl.Contains("/v1"))
        {
            return apiUrl + "/v1/chat/completions";
        }
        return apiUrl + "/chat/completions";
    }

    private object MapModelResponse(LLMModel m, Dictionary<string, string> platformMap) => new
    {
        m.Id,
        m.Name,
        m.ModelName,
        m.ApiUrl,
        apiKeyMasked = string.IsNullOrEmpty(m.ApiKeyEncrypted) ? null : MaskApiKey(DecryptApiKey(m.ApiKeyEncrypted)),
        m.PlatformId,
        platformName = m.PlatformId != null && platformMap.TryGetValue(m.PlatformId, out var name) ? name : null,
        m.Group,
        m.Timeout,
        m.MaxRetries,
        m.MaxConcurrency,
        m.Enabled,
        m.Priority,
        m.IsMain,
        m.IsIntent,
        m.IsVision,
        m.IsImageGen,
        enablePromptCache = m.EnablePromptCache ?? true,
        m.Remark,
        m.CallCount,
        m.TotalDuration,
        m.SuccessCount,
        m.FailCount,
        averageDuration = m.SuccessCount > 0 ? m.TotalDuration / m.SuccessCount : 0,
        successRate = m.CallCount > 0 ? Math.Round((double)m.SuccessCount / m.CallCount * 100, 2) : 0,
        m.CreatedAt,
        m.UpdatedAt
    };

    private string EncryptApiKey(string apiKey)
    {
        if (string.IsNullOrEmpty(apiKey)) return string.Empty;
        var key = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        var keyBytes = Encoding.UTF8.GetBytes(key[..32]);
        
        using var aes = Aes.Create();
        aes.Key = keyBytes;
        aes.GenerateIV();
        
        using var encryptor = aes.CreateEncryptor();
        var plainBytes = Encoding.UTF8.GetBytes(apiKey);
        var encryptedBytes = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);
        
        return Convert.ToBase64String(aes.IV) + ":" + Convert.ToBase64String(encryptedBytes);
    }

    private string DecryptApiKey(string encryptedKey)
    {
        try
        {
            if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;
            var parts = encryptedKey.Split(':');
            if (parts.Length != 2) return "";

            var key = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
            var keyBytes = Encoding.UTF8.GetBytes(key[..32]);
            var iv = Convert.FromBase64String(parts[0]);
            var encryptedBytes = Convert.FromBase64String(parts[1]);

            using var aes = Aes.Create();
            aes.Key = keyBytes;
            aes.IV = iv;

            using var decryptor = aes.CreateDecryptor();
            var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
            
            return Encoding.UTF8.GetString(decryptedBytes);
        }
        catch
        {
            return "";
        }
    }

    private string MaskApiKey(string apiKey)
    {
        if (string.IsNullOrEmpty(apiKey) || apiKey.Length < 8)
            return "****";
        
        return apiKey[..4] + "****" + apiKey[^4..];
    }
}

public class CreateModelRequest
{
    public string Name { get; set; } = string.Empty;
    public string ModelName { get; set; } = string.Empty;
    public string? ApiUrl { get; set; }
    public string? ApiKey { get; set; }
    public string? PlatformId { get; set; }
    public string? Group { get; set; }
    public int Timeout { get; set; } = 360000;
    public int MaxRetries { get; set; } = 3;
    public int MaxConcurrency { get; set; } = 5;
    public bool Enabled { get; set; } = true;
    public bool EnablePromptCache { get; set; } = true;
    public int? Priority { get; set; }
    public string? Remark { get; set; }
}

public class UpdateModelRequest
{
    public string Name { get; set; } = string.Empty;
    public string ModelName { get; set; } = string.Empty;
    public string? ApiUrl { get; set; }
    public string? ApiKey { get; set; }
    public string? PlatformId { get; set; }
    public string? Group { get; set; }
    public int Timeout { get; set; } = 360000;
    public int MaxRetries { get; set; } = 3;
    public int MaxConcurrency { get; set; } = 5;
    public bool Enabled { get; set; } = true;
    public bool EnablePromptCache { get; set; } = true;
    public int? Priority { get; set; }
    public string? Remark { get; set; }
}

public class ModelPriorityUpdate
{
    public string Id { get; set; } = string.Empty;
    public int Priority { get; set; }
}

public class SetMainModelRequest
{
    public string ModelId { get; set; } = string.Empty;
}

public class SetPurposeModelRequest
{
    public string ModelId { get; set; } = string.Empty;
}

public class BatchAddModelsRequest
{
    public string PlatformId { get; set; } = string.Empty;
    public List<BatchModelInfo> Models { get; set; } = new();
}

public class BatchModelInfo
{
    public string ModelName { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public string? Group { get; set; }
}

