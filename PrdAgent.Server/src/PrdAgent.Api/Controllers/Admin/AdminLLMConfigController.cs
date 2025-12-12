using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - LLM配置控制器
/// </summary>
[ApiController]
[Route("api/v1/admin/llm-configs")]
[Authorize(Roles = "ADMIN")]
public class AdminLLMConfigController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminLLMConfigController> _logger;
    private readonly IConfiguration _config;

    public AdminLLMConfigController(
        MongoDbContext db, 
        ILogger<AdminLLMConfigController> logger,
        IConfiguration config)
    {
        _db = db;
        _logger = logger;
        _config = config;
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
            c.CreatedAt,
            c.UpdatedAt,
            apiKeyMasked = MaskApiKey(DecryptApiKey(c.ApiKeyEncrypted))
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
            Provider = request.Provider,
            Model = request.Model,
            ApiKeyEncrypted = EncryptApiKey(request.ApiKey),
            ApiEndpoint = request.ApiEndpoint,
            MaxTokens = request.MaxTokens,
            Temperature = request.Temperature,
            TopP = request.TopP,
            RateLimitPerMinute = request.RateLimitPerMinute,
            IsActive = request.IsActive
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
            .Set(c => c.UpdatedAt, DateTime.UtcNow);

        if (!string.IsNullOrEmpty(request.ApiKey))
        {
            update = update.Set(c => c.ApiKeyEncrypted, EncryptApiKey(request.ApiKey));
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

    private string EncryptApiKey(string apiKey)
    {
        // 简化实现，生产环境应使用更安全的加密
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
}
