using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
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
[Route("api/v1/admin/models")]
[Authorize]
public class AdminModelsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminModelsController> _logger;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IIdGenerator _idGenerator;

    public AdminModelsController(
        MongoDbContext db,
        ILogger<AdminModelsController> logger,
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        IIdGenerator idGenerator)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _httpClientFactory = httpClientFactory;
        _idGenerator = idGenerator;
    }

    /// <summary>
    /// 获取所有模型
    /// </summary>
    [HttpGet]
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
    [HttpGet("{id}")]
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
    [HttpPost]
    public async Task<IActionResult> CreateModel([FromBody] CreateModelRequest request)
    {
        // 检查模型名唯一性（按 platformId + modelId(ModelName) 维度；允许跨平台同名）
        var reqPid = (request.PlatformId ?? string.Empty).Trim();
        var reqMid = (request.ModelName ?? string.Empty).Trim();
        var existing = await _db.LLMModels.Find(m =>
                (m.PlatformId ?? string.Empty) == reqPid
                && m.ModelName == reqMid)
            .FirstOrDefaultAsync();
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

        var reqMaxTokens = request.MaxTokens.HasValue && request.MaxTokens.Value > 0 ? request.MaxTokens : null;
        var model = new LLMModel
        {
            Id = await _idGenerator.GenerateIdAsync("model"),
            Name = request.Name,
            ModelName = reqMid,
            ApiUrl = request.ApiUrl,
            ApiKeyEncrypted = string.IsNullOrEmpty(request.ApiKey) ? null : EncryptApiKey(request.ApiKey),
            PlatformId = request.PlatformId,
            Group = request.Group,
            Timeout = request.Timeout,
            MaxRetries = request.MaxRetries,
            MaxConcurrency = request.MaxConcurrency,
            MaxTokens = reqMaxTokens,
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
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateModel(string id, [FromBody] UpdateModelRequest request)
    {
        // 检查模型名唯一性（按 platformId + modelId(ModelName) 维度；排除自身）
        var reqPid = (request.PlatformId ?? string.Empty).Trim();
        var reqMid = (request.ModelName ?? string.Empty).Trim();
        var existing = await _db.LLMModels.Find(m =>
                m.Id != id
                && (m.PlatformId ?? string.Empty) == reqPid
                && m.ModelName == reqMid)
            .FirstOrDefaultAsync();
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE_MODEL", "模型名称已存在"));
        }

        var reqMaxTokens = request.MaxTokens.HasValue && request.MaxTokens.Value > 0 ? request.MaxTokens : null;
        var update = Builders<LLMModel>.Update
            .Set(m => m.Name, request.Name)
            .Set(m => m.ModelName, request.ModelName)
            .Set(m => m.ApiUrl, request.ApiUrl)
            .Set(m => m.PlatformId, request.PlatformId)
            .Set(m => m.Group, request.Group)
            .Set(m => m.Timeout, request.Timeout)
            .Set(m => m.MaxRetries, request.MaxRetries)
            .Set(m => m.MaxConcurrency, request.MaxConcurrency)
            .Set(m => m.MaxTokens, reqMaxTokens)
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
    [HttpDelete("{id}")]
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
    [HttpDelete("all")]
    public async Task<IActionResult> DeleteAllModels()
    {
        var result = await _db.LLMModels.DeleteManyAsync(_ => true);
        _logger.LogInformation("All models deleted: {Count} models", result.DeletedCount);
        return Ok(ApiResponse<object>.Ok(new { deletedCount = result.DeletedCount }));
    }

    /// <summary>
    /// 测试模型连接
    /// </summary>
    [HttpPost("{id}/test")]
    public async Task<IActionResult> TestModel(string id)
    {
        var model = await _db.LLMModels.Find(m => m.Id == id).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        // 获取API配置（可能需要从平台继承）
        var (apiUrl, apiKey, platformType) = await ResolveApiConfig(model);
        if (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_CONFIG", "API配置不完整"));
        }

        var startTime = DateTime.UtcNow;
        try
        {
            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromMilliseconds(Math.Min(model.Timeout, 30000));
            var endpoint = GetModelsEndpoint(apiUrl);
            var isAnthropic = string.Equals(platformType, "anthropic", StringComparison.OrdinalIgnoreCase)
                              || apiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase);

            if (isAnthropic)
            {
                client.DefaultRequestHeaders.Remove("x-api-key");
                client.DefaultRequestHeaders.Add("x-api-key", apiKey);
                client.DefaultRequestHeaders.Remove("anthropic-version");
                client.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
            }
            else
            {
                client.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");
            }

            var response = await client.GetAsync(endpoint);
            
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
    [HttpPut("priorities")]
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
        // 兼容：支持 (platformId, modelId=ModelName) 与旧的 (modelId=内部Id)
        var reqPid = (request.PlatformId ?? string.Empty).Trim();
        var reqMid = (request.ModelId ?? string.Empty).Trim();
        var model = string.IsNullOrWhiteSpace(reqPid)
            ? await _db.LLMModels.Find(m => m.Id == reqMid).FirstOrDefaultAsync()
            : await _db.LLMModels.Find(m => m.PlatformId == reqPid && m.ModelName == reqMid).FirstOrDefaultAsync();
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
            m => m.Id == model.Id,
            Builders<LLMModel>.Update
                .Set(m => m.IsMain, true)
                .Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Main model set: {Id}", model.Id);
        return Ok(ApiResponse<object>.Ok(new { platformId = model.PlatformId, modelId = model.ModelName, isMain = true }));
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
        // 兼容：支持 (platformId, modelId=ModelName) 与旧的 (modelId=内部Id)
        var reqPid = (request.PlatformId ?? string.Empty).Trim();
        var reqMid = (request.ModelId ?? string.Empty).Trim();
        var model = string.IsNullOrWhiteSpace(reqPid)
            ? await _db.LLMModels.Find(m => m.Id == reqMid).FirstOrDefaultAsync()
            : await _db.LLMModels.Find(m => m.PlatformId == reqPid && m.ModelName == reqMid).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsIntent, false));
        await _db.LLMModels.UpdateOneAsync(
            m => m.Id == model.Id,
            Builders<LLMModel>.Update.Set(m => m.IsIntent, true).Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Intent model set: {Id}", model.Id);
        return Ok(ApiResponse<object>.Ok(new { platformId = model.PlatformId, modelId = model.ModelName, isIntent = true }));
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
        // 兼容：支持 (platformId, modelId=ModelName) 与旧的 (modelId=内部Id)
        var reqPid = (request.PlatformId ?? string.Empty).Trim();
        var reqMid = (request.ModelId ?? string.Empty).Trim();
        var model = string.IsNullOrWhiteSpace(reqPid)
            ? await _db.LLMModels.Find(m => m.Id == reqMid).FirstOrDefaultAsync()
            : await _db.LLMModels.Find(m => m.PlatformId == reqPid && m.ModelName == reqMid).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsVision, false));
        await _db.LLMModels.UpdateOneAsync(
            m => m.Id == model.Id,
            Builders<LLMModel>.Update.Set(m => m.IsVision, true).Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("Vision model set: {Id}", model.Id);
        return Ok(ApiResponse<object>.Ok(new { platformId = model.PlatformId, modelId = model.ModelName, isVision = true }));
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
        // 兼容：支持 (platformId, modelId=ModelName) 与旧的 (modelId=内部Id)
        var reqPid = (request.PlatformId ?? string.Empty).Trim();
        var reqMid = (request.ModelId ?? string.Empty).Trim();
        var model = string.IsNullOrWhiteSpace(reqPid)
            ? await _db.LLMModels.Find(m => m.Id == reqMid).FirstOrDefaultAsync()
            : await _db.LLMModels.Find(m => m.PlatformId == reqPid && m.ModelName == reqMid).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsImageGen, false));
        await _db.LLMModels.UpdateOneAsync(
            m => m.Id == model.Id,
            Builders<LLMModel>.Update.Set(m => m.IsImageGen, true).Set(m => m.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("ImageGen model set: {Id}", model.Id);
        return Ok(ApiResponse<object>.Ok(new { platformId = model.PlatformId, modelId = model.ModelName, isImageGen = true }));
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
    [HttpPost("batch-from-platform")]
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
            var existing = await _db.LLMModels
                .Find(m => m.PlatformId == request.PlatformId && m.ModelName == modelInfo.ModelName)
                .FirstOrDefaultAsync();
            if (existing != null)
            {
                skippedModels.Add(modelInfo.ModelName);
                continue;
            }

            var model = new LLMModel
            {
                Id = await _idGenerator.GenerateIdAsync("model"),
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

    private async Task<(string? apiUrl, string? apiKey, string? platformType)> ResolveApiConfig(LLMModel model)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : DecryptApiKey(model.ApiKeyEncrypted);
        string? platformType = null;

        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            if (platform != null)
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= DecryptApiKey(platform.ApiKeyEncrypted);
                platformType ??= platform.PlatformType;
            }
        }

        return (apiUrl, apiKey, platformType);
    }

    private string GetChatEndpoint(string apiUrl)
    {
        // 统一按配置规则拼接（/、#、默认）
        return PrdAgent.Infrastructure.LLM.OpenAICompatUrl.BuildEndpoint(apiUrl, "chat/completions");
    }

    private string GetModelsEndpoint(string apiUrl)
    {
        // 统一按配置规则拼接（/、#、默认）
        return PrdAgent.Infrastructure.LLM.OpenAICompatUrl.BuildEndpoint(apiUrl, "models");
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
        maxTokens = m.MaxTokens,
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

    /// <summary>
    /// 获取模型的平台适配信息
    /// </summary>
    [HttpGet("{id}/adapter-info")]
    public async Task<IActionResult> GetModelAdapterInfo(string id)
    {
        var model = await _db.LLMModels.Find(m => m.Id == id).FirstOrDefaultAsync();
        if (model == null)
        {
            return NotFound(ApiResponse<object>.Fail("MODEL_NOT_FOUND", "模型不存在"));
        }

        // 获取平台信息
        string? platformApiUrl = null;
        if (!string.IsNullOrWhiteSpace(model.PlatformId))
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync();
            platformApiUrl = platform?.ApiUrl ?? model.ApiUrl;
        }
        else
        {
            platformApiUrl = model.ApiUrl;
        }

        // 尝试匹配 vveai 适配器
        var adapterInfo = Infrastructure.LLM.VveaiModelAdapterRegistry.GetAdapterInfo(platformApiUrl, model.ModelName);

        if (adapterInfo == null)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                matched = false,
                modelId = id,
                modelName = model.ModelName,
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            matched = adapterInfo.Matched,
            modelId = id,
            modelName = model.ModelName,
            adapterName = adapterInfo.AdapterName,
            displayName = adapterInfo.DisplayName,
            provider = adapterInfo.Provider,
            sizeConstraint = new
            {
                type = adapterInfo.SizeConstraintType,
                description = adapterInfo.SizeConstraintDescription,
            },
            allowedSizes = adapterInfo.AllowedSizes,
            allowedRatios = adapterInfo.AllowedRatios,
            sizeParamFormat = adapterInfo.SizeParamFormat,
            limitations = new
            {
                mustBeDivisibleBy = adapterInfo.MustBeDivisibleBy,
                maxWidth = adapterInfo.MaxWidth,
                maxHeight = adapterInfo.MaxHeight,
                minWidth = adapterInfo.MinWidth,
                minHeight = adapterInfo.MinHeight,
                maxPixels = adapterInfo.MaxPixels,
                notes = adapterInfo.Notes,
            },
            supportsImageToImage = adapterInfo.SupportsImageToImage,
            supportsInpainting = adapterInfo.SupportsInpainting,
        }));
    }

    /// <summary>
    /// 批量获取多个模型的适配信息
    /// </summary>
    [HttpPost("adapter-info/batch")]
    public async Task<IActionResult> GetModelsAdapterInfoBatch([FromBody] List<string> modelIds)
    {
        if (modelIds == null || modelIds.Count == 0)
        {
            return Ok(ApiResponse<object>.Ok(new Dictionary<string, object>()));
        }

        var ids = modelIds.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().Take(100).ToList();
        var models = await _db.LLMModels.Find(m => ids.Contains(m.Id)).ToListAsync();

        // 获取所有相关平台
        var platformIds = models.Where(m => !string.IsNullOrWhiteSpace(m.PlatformId)).Select(m => m.PlatformId!).Distinct().ToList();
        var platforms = await _db.LLMPlatforms.Find(p => platformIds.Contains(p.Id)).ToListAsync();
        var platformMap = platforms.ToDictionary(p => p.Id, p => p);

        var result = new Dictionary<string, object>();
        foreach (var model in models)
        {
            string? platformApiUrl = null;
            if (!string.IsNullOrWhiteSpace(model.PlatformId) && platformMap.TryGetValue(model.PlatformId, out var plat))
            {
                platformApiUrl = plat.ApiUrl ?? model.ApiUrl;
            }
            else
            {
                platformApiUrl = model.ApiUrl;
            }

            var adapterInfo = Infrastructure.LLM.VveaiModelAdapterRegistry.GetAdapterInfo(platformApiUrl, model.ModelName);
            if (adapterInfo != null && adapterInfo.Matched)
            {
                result[model.Id] = new
                {
                    matched = true,
                    adapterName = adapterInfo.AdapterName,
                    displayName = adapterInfo.DisplayName,
                    provider = adapterInfo.Provider,
                    sizeConstraintType = adapterInfo.SizeConstraintType,
                    allowedSizesCount = adapterInfo.AllowedSizes.Count,
                    allowedRatios = adapterInfo.AllowedRatios,
                    notes = adapterInfo.Notes,
                };
            }
            else
            {
                result[model.Id] = new { matched = false };
            }
        }

        return Ok(ApiResponse<object>.Ok(result));
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
    public int? MaxTokens { get; set; }
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
    public int? MaxTokens { get; set; }
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
    public string? PlatformId { get; set; }
}

public class SetPurposeModelRequest
{
    public string ModelId { get; set; } = string.Empty;
    public string? PlatformId { get; set; }
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
