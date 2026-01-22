using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - LLM配置控制器
/// </summary>
[ApiController]
[Route("api/mds/llm-configs")]
[Authorize]
[AdminController("mds", AdminPermissionCatalog.ModelsRead, WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class LLMConfigController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<LLMConfigController> _logger;
    private readonly IConfiguration _config;
    private readonly IIdGenerator _idGenerator;

    public LLMConfigController(
        MongoDbContext db, 
        ILogger<LLMConfigController> logger,
        IConfiguration config,
        IIdGenerator idGenerator)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _idGenerator = idGenerator;
    }

    /// <summary>
    /// 获取LLM配置列表
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetConfigs()
    {
        var configs = await _db.LLMConfigs.Find(_ => true)
            .SortByDescending(c => c.IsActive)
            .ThenByDescending(c => c.CreatedAt)
            .ToListAsync();

        var response = configs.Select(c => new
        {
            c.Id,
            c.Provider,
            c.Model,
            c.ApiEndpoint,
            c.MaxTokens,
            c.Temperature,
            c.TopP,
            c.RateLimitPerMinute,
            c.IsActive,
            c.EnablePromptCache,
            c.CreatedAt,
            c.UpdatedAt,
            apiKeyMasked = ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(c.ApiKeyEncrypted, GetJwtSecret()))
        });

        return Ok(ApiResponse<object>.Ok(response));
    }

    /// <summary>
    /// 创建LLM配置
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateConfig([FromBody] CreateLLMConfigRequest request)
    {
        var config = new LLMConfig
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Provider = request.Provider,
            Model = request.Model,
            ApiKeyEncrypted = ApiKeyCrypto.Encrypt(request.ApiKey, GetJwtSecret()),
            ApiEndpoint = request.ApiEndpoint,
            MaxTokens = request.MaxTokens,
            Temperature = request.Temperature,
            TopP = request.TopP,
            RateLimitPerMinute = request.RateLimitPerMinute,
            IsActive = request.IsActive,
            EnablePromptCache = request.EnablePromptCache
        };

        await _db.LLMConfigs.InsertOneAsync(config);

        _logger.LogInformation("LLM config created: {Provider} - {Model}", config.Provider, config.Model);

        return CreatedAtAction(nameof(GetConfigs), ApiResponse<object>.Ok(new { config.Id }));
    }

    /// <summary>
    /// 更新LLM配置
    /// </summary>
    [HttpPut("{configId}")]
    public async Task<IActionResult> UpdateConfig(string configId, [FromBody] UpdateLLMConfigRequest request)
    {
        var update = Builders<LLMConfig>.Update
            .Set(c => c.Model, request.Model)
            .Set(c => c.ApiEndpoint, request.ApiEndpoint)
            .Set(c => c.MaxTokens, request.MaxTokens)
            .Set(c => c.Temperature, request.Temperature)
            .Set(c => c.TopP, request.TopP)
            .Set(c => c.RateLimitPerMinute, request.RateLimitPerMinute)
            .Set(c => c.IsActive, request.IsActive)
            .Set(c => c.EnablePromptCache, request.EnablePromptCache)
            .Set(c => c.UpdatedAt, DateTime.UtcNow);

        if (!string.IsNullOrEmpty(request.ApiKey))
        {
            update = update.Set(c => c.ApiKeyEncrypted, ApiKeyCrypto.Encrypt(request.ApiKey, GetJwtSecret()));
        }

        var result = await _db.LLMConfigs.UpdateOneAsync(c => c.Id == configId, update);

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("CONFIG_NOT_FOUND", "配置不存在"));
        }

        _logger.LogInformation("LLM config updated: {ConfigId}", configId);

        return Ok(ApiResponse<object>.Ok(new { configId }));
    }

    /// <summary>
    /// 删除LLM配置
    /// </summary>
    [HttpDelete("{configId}")]
    public async Task<IActionResult> DeleteConfig(string configId)
    {
        var result = await _db.LLMConfigs.DeleteOneAsync(c => c.Id == configId);

        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("CONFIG_NOT_FOUND", "配置不存在"));
        }

        _logger.LogInformation("LLM config deleted: {ConfigId}", configId);

        return NoContent();
    }

    /// <summary>
    /// 设置为默认配置
    /// </summary>
    [HttpPost("{configId}/activate")]
    public async Task<IActionResult> ActivateConfig(string configId)
    {
        // 先禁用所有
        await _db.LLMConfigs.UpdateManyAsync(
            _ => true,
            Builders<LLMConfig>.Update.Set(c => c.IsActive, false));

        // 激活选中的
        var result = await _db.LLMConfigs.UpdateOneAsync(
            c => c.Id == configId,
            Builders<LLMConfig>.Update
                .Set(c => c.IsActive, true)
                .Set(c => c.UpdatedAt, DateTime.UtcNow));

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("CONFIG_NOT_FOUND", "配置不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { configId, isActive = true }));
    }

    private string GetJwtSecret() => _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
}

public class CreateLLMConfigRequest
{
    public string Provider { get; set; } = "Claude";
    public string Model { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public string? ApiEndpoint { get; set; }
    public int MaxTokens { get; set; } = 4096;
    public double Temperature { get; set; } = 0.7;
    public double TopP { get; set; } = 0.95;
    public int RateLimitPerMinute { get; set; } = 60;
    public bool IsActive { get; set; } = false;
    /// <summary>是否启用Prompt Caching（Claude可节省90%输入token费用）</summary>
    public bool EnablePromptCache { get; set; } = true;
}

public class UpdateLLMConfigRequest
{
    public string Model { get; set; } = string.Empty;
    public string? ApiKey { get; set; }
    public string? ApiEndpoint { get; set; }
    public int MaxTokens { get; set; } = 4096;
    public double Temperature { get; set; } = 0.7;
    public double TopP { get; set; } = 0.95;
    public int RateLimitPerMinute { get; set; } = 60;
    public bool IsActive { get; set; } = false;
    /// <summary>是否启用Prompt Caching（Claude可节省90%输入token费用）</summary>
    public bool EnablePromptCache { get; set; } = true;
}
