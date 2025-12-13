using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - LLM平台控制器
/// </summary>
[ApiController]
[Route("api/v1/platforms")]
[Authorize(Roles = "ADMIN")]
public class AdminPlatformsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminPlatformsController> _logger;
    private readonly IConfiguration _config;
    private readonly ICacheManager _cache;
    private readonly IHttpClientFactory _httpClientFactory;
    
    private const string ModelsCacheKeyPrefix = "platform:models:";
    private static readonly TimeSpan ModelsCacheExpiry = TimeSpan.FromHours(24);
    
    // 预设模型列表缓存
    private static readonly Dictionary<string, List<PresetModel>> PresetModels = new()
    {
        ["openai"] = new()
        {
            new("gpt-4o", "GPT-4o", "gpt-4o"),
            new("gpt-4o-mini", "GPT-4o Mini", "gpt-4o"),
            new("gpt-4-turbo", "GPT-4 Turbo", "gpt-4"),
            new("gpt-4", "GPT-4", "gpt-4"),
            new("gpt-3.5-turbo", "GPT-3.5 Turbo", "gpt-3.5"),
            new("o1", "o1", "o1"),
            new("o1-mini", "o1 Mini", "o1"),
            new("o1-preview", "o1 Preview", "o1"),
        },
        ["anthropic"] = new()
        {
            new("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet", "claude-3.5"),
            new("claude-3-5-haiku-20241022", "Claude 3.5 Haiku", "claude-3.5"),
            new("claude-3-opus-20240229", "Claude 3 Opus", "claude-3"),
            new("claude-3-sonnet-20240229", "Claude 3 Sonnet", "claude-3"),
            new("claude-3-haiku-20240307", "Claude 3 Haiku", "claude-3"),
        },
        ["qwen"] = new()
        {
            new("qwen-max", "Qwen Max", "qwen"),
            new("qwen-plus", "Qwen Plus", "qwen"),
            new("qwen-turbo", "Qwen Turbo", "qwen"),
            new("qwen-long", "Qwen Long", "qwen"),
            new("qwen2.5-72b-instruct", "Qwen2.5 72B", "qwen2.5"),
            new("qwen2.5-32b-instruct", "Qwen2.5 32B", "qwen2.5"),
            new("qwen2.5-14b-instruct", "Qwen2.5 14B", "qwen2.5"),
            new("qwen2.5-7b-instruct", "Qwen2.5 7B", "qwen2.5"),
        },
        ["zhipu"] = new()
        {
            new("glm-4-plus", "GLM-4 Plus", "glm-4"),
            new("glm-4-0520", "GLM-4", "glm-4"),
            new("glm-4-air", "GLM-4 Air", "glm-4"),
            new("glm-4-airx", "GLM-4 AirX", "glm-4"),
            new("glm-4-flash", "GLM-4 Flash", "glm-4"),
            new("glm-4-long", "GLM-4 Long", "glm-4"),
        },
        ["baidu"] = new()
        {
            new("ernie-4.0-8k", "ERNIE 4.0", "ernie"),
            new("ernie-4.0-turbo-8k", "ERNIE 4.0 Turbo", "ernie"),
            new("ernie-3.5-8k", "ERNIE 3.5", "ernie"),
            new("ernie-speed-128k", "ERNIE Speed", "ernie"),
            new("ernie-lite-8k", "ERNIE Lite", "ernie"),
        },
        ["google"] = new()
        {
            new("gemini-2.0-flash-exp", "Gemini 2.0 Flash", "gemini-2.0"),
            new("gemini-1.5-pro", "Gemini 1.5 Pro", "gemini-1.5"),
            new("gemini-1.5-flash", "Gemini 1.5 Flash", "gemini-1.5"),
            new("gemini-1.5-flash-8b", "Gemini 1.5 Flash 8B", "gemini-1.5"),
        },
        ["deepseek"] = new()
        {
            new("deepseek-chat", "DeepSeek Chat", "deepseek"),
            new("deepseek-reasoner", "DeepSeek Reasoner (R1)", "deepseek"),
        }
    };

    public AdminPlatformsController(
        MongoDbContext db,
        ILogger<AdminPlatformsController> logger,
        IConfiguration config,
        ICacheManager cache,
        IHttpClientFactory httpClientFactory)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _cache = cache;
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>
    /// 获取所有平台
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetPlatforms()
    {
        var platforms = await _db.LLMPlatforms.Find(_ => true)
            .SortByDescending(p => p.CreatedAt)
            .ToListAsync();

        var response = platforms.Select(p => new
        {
            p.Id,
            p.Name,
            p.PlatformType,
            p.ApiUrl,
            apiKeyMasked = MaskApiKey(DecryptApiKey(p.ApiKeyEncrypted)),
            p.Enabled,
            p.MaxConcurrency,
            p.Remark,
            p.CreatedAt,
            p.UpdatedAt
        });

        return Ok(ApiResponse<object>.Ok(response));
    }

    /// <summary>
    /// 获取单个平台
    /// </summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetPlatform(string id)
    {
        var platform = await _db.LLMPlatforms.Find(p => p.Id == id).FirstOrDefaultAsync();
        if (platform == null)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            platform.Id,
            platform.Name,
            platform.PlatformType,
            platform.ApiUrl,
            apiKeyMasked = MaskApiKey(DecryptApiKey(platform.ApiKeyEncrypted)),
            platform.Enabled,
            platform.MaxConcurrency,
            platform.Remark,
            platform.CreatedAt,
            platform.UpdatedAt
        }));
    }

    /// <summary>
    /// 创建平台
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreatePlatform([FromBody] CreatePlatformRequest request)
    {
        // 检查名称唯一性
        var existing = await _db.LLMPlatforms.Find(p => p.Name == request.Name).FirstOrDefaultAsync();
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE_NAME", "平台名称已存在"));
        }

        var platform = new LLMPlatform
        {
            Name = request.Name,
            PlatformType = request.PlatformType,
            ApiUrl = request.ApiUrl,
            ApiKeyEncrypted = EncryptApiKey(request.ApiKey),
            Enabled = request.Enabled,
            MaxConcurrency = request.MaxConcurrency,
            Remark = request.Remark
        };

        await _db.LLMPlatforms.InsertOneAsync(platform);
        _logger.LogInformation("Platform created: {Name} ({Type})", platform.Name, platform.PlatformType);

        return CreatedAtAction(nameof(GetPlatform), new { id = platform.Id }, 
            ApiResponse<object>.Ok(new { platform.Id }));
    }

    /// <summary>
    /// 更新平台
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdatePlatform(string id, [FromBody] UpdatePlatformRequest request)
    {
        // 检查名称唯一性（排除自身）
        var existing = await _db.LLMPlatforms.Find(p => p.Name == request.Name && p.Id != id).FirstOrDefaultAsync();
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE_NAME", "平台名称已存在"));
        }

        var update = Builders<LLMPlatform>.Update
            .Set(p => p.Name, request.Name)
            .Set(p => p.PlatformType, request.PlatformType)
            .Set(p => p.ApiUrl, request.ApiUrl)
            .Set(p => p.Enabled, request.Enabled)
            .Set(p => p.MaxConcurrency, request.MaxConcurrency)
            .Set(p => p.Remark, request.Remark)
            .Set(p => p.UpdatedAt, DateTime.UtcNow);

        if (!string.IsNullOrEmpty(request.ApiKey))
        {
            update = update.Set(p => p.ApiKeyEncrypted, EncryptApiKey(request.ApiKey));
        }

        var result = await _db.LLMPlatforms.UpdateOneAsync(p => p.Id == id, update);
        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        _logger.LogInformation("Platform updated: {Id}", id);
        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 删除平台
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeletePlatform(string id)
    {
        // 检查是否有关联模型
        var modelCount = await _db.LLMModels.CountDocumentsAsync(m => m.PlatformId == id);
        if (modelCount > 0)
        {
            return BadRequest(ApiResponse<object>.Fail("HAS_MODELS", $"该平台下有{modelCount}个模型，无法删除"));
        }

        var result = await _db.LLMPlatforms.DeleteOneAsync(p => p.Id == id);
        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        _logger.LogInformation("Platform deleted: {Id}", id);
        return NoContent();
    }

    /// <summary>
    /// 获取平台下已添加的模型
    /// </summary>
    [HttpGet("{id}/models")]
    public async Task<IActionResult> GetPlatformModels(string id)
    {
        var platform = await _db.LLMPlatforms.Find(p => p.Id == id).FirstOrDefaultAsync();
        if (platform == null)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        var models = await _db.LLMModels.Find(m => m.PlatformId == id)
            .SortBy(m => m.Priority)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(models.Select(MapModelResponse)));
    }

    /// <summary>
    /// 获取平台可用模型列表（优先从缓存获取，否则从API获取或使用预设列表）
    /// </summary>
    [HttpGet("{id}/available-models")]
    public async Task<IActionResult> GetAvailableModels(string id)
    {
        var platform = await _db.LLMPlatforms.Find(p => p.Id == id).FirstOrDefaultAsync();
        if (platform == null)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        // 尝试从缓存获取
        var cacheKey = ModelsCacheKeyPrefix + id;
        var cachedModels = await _cache.GetAsync<List<AvailableModelDto>>(cacheKey);
        if (cachedModels != null && cachedModels.Count > 0)
        {
            return Ok(ApiResponse<object>.Ok(cachedModels));
        }

        // 从API或预设获取模型列表
        var models = await GetModelsForPlatform(platform);
        
        // 缓存结果
        if (models.Count > 0)
        {
            await _cache.SetAsync(cacheKey, models, ModelsCacheExpiry);
        }

        return Ok(ApiResponse<object>.Ok(models));
    }

    /// <summary>
    /// 刷新平台模型列表（强制从API重新获取并更新缓存）
    /// </summary>
    [HttpPost("{id}/refresh-models")]
    public async Task<IActionResult> RefreshModels(string id)
    {
        var platform = await _db.LLMPlatforms.Find(p => p.Id == id).FirstOrDefaultAsync();
        if (platform == null)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        // 清除旧缓存
        var cacheKey = ModelsCacheKeyPrefix + id;
        await _cache.RemoveAsync(cacheKey);

        // 从API或预设获取模型列表
        var models = await GetModelsForPlatform(platform);
        
        // 缓存结果
        if (models.Count > 0)
        {
            await _cache.SetAsync(cacheKey, models, ModelsCacheExpiry);
        }

        return Ok(ApiResponse<object>.Ok(models));
    }

    /// <summary>
    /// 获取平台的模型列表（从API或预设）
    /// </summary>
    private async Task<List<AvailableModelDto>> GetModelsForPlatform(LLMPlatform platform)
    {
        // OpenAI兼容的平台尝试从API获取模型列表
        if (platform.PlatformType == "openai" || platform.PlatformType == "other")
        {
            try
            {
                var apiModels = await FetchModelsFromApi(platform);
                if (apiModels.Count > 0)
                {
                    return apiModels.Select(m => new AvailableModelDto
                    {
                        ModelName = ((dynamic)m).modelName,
                        DisplayName = ((dynamic)m).displayName,
                        Group = ((dynamic)m).group
                    }).ToList();
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to fetch models from API for platform {Id}", platform.Id);
            }
        }

        // 使用预设列表
        if (PresetModels.TryGetValue(platform.PlatformType, out var presets))
        {
            return presets.Select(p => new AvailableModelDto
            {
                ModelName = p.ModelName,
                DisplayName = p.DisplayName,
                Group = p.Group
            }).ToList();
        }

        return new List<AvailableModelDto>();
    }

    /// <summary>
    /// 从API获取模型列表
    /// </summary>
    private async Task<List<object>> FetchModelsFromApi(LLMPlatform platform)
    {
        var apiUrl = GetModelsEndpoint(platform.ApiUrl);
        var apiKey = DecryptApiKey(platform.ApiKeyEncrypted);

        using var client = _httpClientFactory.CreateClient("LoggedHttpClient");
        client.Timeout = TimeSpan.FromSeconds(30);
        client.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");

        var response = await client.GetAsync(apiUrl);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<ModelsApiResponse>();
        if (json?.Data == null) return new List<object>();

        return json.Data
            .Where(m => !string.IsNullOrEmpty(m.Id))
            .Select(m => (object)new
            {
                modelName = m.Id,
                displayName = m.Id,
                group = ExtractModelGroup(m.Id)
            })
            .ToList();
    }

    private string GetModelsEndpoint(string apiUrl)
    {
        apiUrl = apiUrl.TrimEnd('/');
        if (apiUrl.EndsWith("#"))
        {
            return apiUrl.TrimEnd('#') + "/models";
        }
        if (!apiUrl.Contains("/v1"))
        {
            return apiUrl + "/v1/models";
        }
        return apiUrl.Replace("/chat/completions", "/models");
    }

    private string ExtractModelGroup(string modelId)
    {
        // 从模型ID推断分组
        var lowerModel = modelId.ToLowerInvariant();
        if (lowerModel.Contains("gpt-4o")) return "gpt-4o";
        if (lowerModel.Contains("gpt-4")) return "gpt-4";
        if (lowerModel.Contains("gpt-3.5")) return "gpt-3.5";
        if (lowerModel.Contains("o1")) return "o1";
        if (lowerModel.Contains("claude-3-5") || lowerModel.Contains("claude-3.5")) return "claude-3.5";
        if (lowerModel.Contains("claude-3")) return "claude-3";
        if (lowerModel.Contains("deepseek")) return "deepseek";
        if (lowerModel.Contains("qwen")) return "qwen";
        if (lowerModel.Contains("glm")) return "glm";
        if (lowerModel.Contains("gemini")) return "gemini";
        return "other";
    }

    private object MapModelResponse(LLMModel m) => new
    {
        m.Id,
        m.Name,
        m.ModelName,
        m.ApiUrl,
        apiKeyMasked = string.IsNullOrEmpty(m.ApiKeyEncrypted) ? null : MaskApiKey(DecryptApiKey(m.ApiKeyEncrypted)),
        m.PlatformId,
        m.Group,
        m.Timeout,
        m.MaxRetries,
        m.MaxConcurrency,
        m.Enabled,
        m.Priority,
        m.IsMain,
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

public record PresetModel(string ModelName, string DisplayName, string Group);

public class ModelsApiResponse
{
    public List<ModelItem> Data { get; set; } = new();
}

public class ModelItem
{
    public string Id { get; set; } = string.Empty;
}

public class CreatePlatformRequest
{
    public string Name { get; set; } = string.Empty;
    public string PlatformType { get; set; } = "openai";
    public string ApiUrl { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public int MaxConcurrency { get; set; } = 5;
    public string? Remark { get; set; }
}

public class UpdatePlatformRequest
{
    public string Name { get; set; } = string.Empty;
    public string PlatformType { get; set; } = "openai";
    public string ApiUrl { get; set; } = string.Empty;
    public string? ApiKey { get; set; }
    public bool Enabled { get; set; } = true;
    public int MaxConcurrency { get; set; } = 5;
    public string? Remark { get; set; }
}

public class AvailableModelDto
{
    public string ModelName { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string? Group { get; set; }
}

