using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

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
    private readonly IModelDomainService _modelDomainService;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    
    private const string ModelsCacheKeyPrefix = "platform:models:";
    private static readonly TimeSpan ModelsCacheExpiry = TimeSpan.FromHours(24);
    private static readonly TimeSpan ReclassifyIdempotencyExpiry = TimeSpan.FromMinutes(15);
    
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
        IHttpClientFactory httpClientFactory,
        IModelDomainService modelDomainService,
        ILLMRequestContextAccessor ctxAccessor)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _cache = cache;
        _httpClientFactory = httpClientFactory;
        _modelDomainService = modelDomainService;
        _ctxAccessor = ctxAccessor;
    }

    private string GetAdminId() => User.FindFirst("sub")?.Value ?? User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? "unknown";

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
            providerId = string.IsNullOrWhiteSpace(p.ProviderId) ? p.PlatformType : p.ProviderId,
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
            providerId = string.IsNullOrWhiteSpace(platform.ProviderId) ? platform.PlatformType : platform.ProviderId,
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
            ProviderId = string.IsNullOrWhiteSpace(request.ProviderId) ? null : request.ProviderId.Trim(),
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
            .Set(p => p.ProviderId, string.IsNullOrWhiteSpace(request.ProviderId) ? null : request.ProviderId.Trim())
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
    /// 使用“主模型”对平台可用模型列表做智能分类/分组，并写回已配置模型（llmmodels）
    /// </summary>
    [HttpPost("/api/v1/admin/platforms/{id}/reclassify-models")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ReclassifyModels(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var platform = await _db.LLMPlatforms.Find(p => p.Id == id).FirstOrDefaultAsync(ct);
        if (platform == null)
        {
            return NotFound(ApiResponse<object>.Fail("PLATFORM_NOT_FOUND", "平台不存在"));
        }

        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var idemCacheKey = $"{ModelsCacheKeyPrefix}{id}:reclassify:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<object>(idemCacheKey);
            if (cached != null)
            {
                return Ok(ApiResponse<object>.Ok(cached));
            }
        }

        // 1) 拉取平台可用模型列表（全量）
        var available = await GetModelsForPlatform(platform);
        if (available.Count == 0)
        {
            var payloadEmpty = new
            {
                platformId = id,
                providerId = platform.ProviderId,
                platformType = platform.PlatformType,
                availableCount = 0,
                configuredCount = 0,
                updatedCount = 0,
                items = Array.Empty<object>()
            };
            return Ok(ApiResponse<object>.Ok(payloadEmpty));
        }

        // 2) 调用主模型进行分类（可能需要分片）
        var providerId = (string.IsNullOrWhiteSpace(platform.ProviderId) ? platform.PlatformType : platform.ProviderId!).Trim().ToLowerInvariant();
        var client = await _modelDomainService.GetClientAsync(ModelPurpose.MainChat, ct);

        var requestId = Guid.NewGuid().ToString("N");
        using var _ = _ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: adminId,
            ViewRole: "ADMIN",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[MODEL_RECLASSIFY]",
            RequestType: "reasoning",
            RequestPurpose: "admin.platforms.reclassify"));

        var results = new List<ModelClassifyResult>();
        const int chunkSize = 180;
        for (var i = 0; i < available.Count; i += chunkSize)
        {
            var chunk = available.Skip(i).Take(chunkSize).ToList();
            var chunkRes = await ClassifyAvailableModelsAsync(client, providerId, platform.PlatformType, chunk, ct);
            results.AddRange(chunkRes);
        }

        // 3) 写回已配置模型（llmmodels）：按 platformId + modelName 匹配
        var configured = await _db.LLMModels.Find(m => m.PlatformId == id).ToListAsync(ct);
        var map = results
            .Where(r => !string.IsNullOrWhiteSpace(r.ModelName))
            .Select(r => new { Key = (r.ModelName ?? string.Empty).Trim().ToLowerInvariant(), Value = r })
            .Where(x => !string.IsNullOrWhiteSpace(x.Key))
            .GroupBy(x => x.Key)
            .ToDictionary(g => g.Key, g => g.First().Value);

        var updates = new List<WriteModel<LLMModel>>();
        var diffs = new List<object>();
        foreach (var m in configured)
        {
            var key = (m.ModelName ?? string.Empty).Trim().ToLowerInvariant();
            if (!map.TryGetValue(key, out var r)) continue;

            var nextGroup = string.IsNullOrWhiteSpace(r.Group) ? m.Group : r.Group!.Trim();
            var llmCaps = BuildLlmCapabilities(r, DateTime.UtcNow);

            // 合并策略：保留非 llm 来源条目（未来可写入 user 覆盖），覆盖/替换 llm 条目
            var existingCaps = m.Capabilities ?? new List<LLMModelCapability>();
            var kept = existingCaps.Where(x => !string.Equals(x.Source, "llm", StringComparison.OrdinalIgnoreCase)).ToList();
            var mergedCaps = kept.Concat(llmCaps).ToList();

            var needUpdate = !string.Equals(m.Group ?? string.Empty, nextGroup ?? string.Empty, StringComparison.Ordinal)
                             || !CapabilitiesSemanticallyEqual(existingCaps, mergedCaps);
            if (!needUpdate) continue;

            diffs.Add(new
            {
                modelId = m.Id,
                modelName = m.ModelName,
                oldGroup = m.Group,
                newGroup = nextGroup
            });

            var u = Builders<LLMModel>.Update
                .Set(x => x.Group, nextGroup)
                .Set("capabilities", mergedCaps)
                .Set(x => x.UpdatedAt, DateTime.UtcNow);

            updates.Add(new UpdateOneModel<LLMModel>(
                Builders<LLMModel>.Filter.Eq(x => x.Id, m.Id),
                u));
        }

        if (updates.Count > 0)
        {
            await _db.LLMModels.BulkWriteAsync(updates, new BulkWriteOptions { IsOrdered = false }, ct);
        }

        var payload = new
        {
            platformId = id,
            providerId,
            platformType = platform.PlatformType,
            availableCount = available.Count,
            configuredCount = configured.Count,
            updatedCount = updates.Count,
            items = diffs
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var idemCacheKey = $"{ModelsCacheKeyPrefix}{id}:reclassify:{adminId}:{idemKey}";
            await _cache.SetAsync(idemCacheKey, payload, ReclassifyIdempotencyExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }

    private static bool CapabilitiesSemanticallyEqual(List<LLMModelCapability>? a, List<LLMModelCapability>? b)
    {
        a ??= new List<LLMModelCapability>();
        b ??= new List<LLMModelCapability>();
        // 仅比较 type/source/value（忽略 updatedAt/confidence）
        static string KeyOf(LLMModelCapability x) =>
            $"{(x.Type ?? "").Trim().ToLowerInvariant()}|{(x.Source ?? "").Trim().ToLowerInvariant()}|{x.Value}";
        var sa = new HashSet<string>(a.Select(KeyOf));
        var sb = new HashSet<string>(b.Select(KeyOf));
        return sa.SetEquals(sb);
    }

    private static List<LLMModelCapability> BuildLlmCapabilities(ModelClassifyResult r, DateTime now)
    {
        var tags = r.Tags ?? new List<string>();
        var set = new HashSet<string>(tags.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim().ToLowerInvariant()));

        var allTypes = new[]
        {
            "vision", "embedding", "rerank", "function_calling", "web_search", "reasoning", "free"
        };

        var caps = new List<LLMModelCapability>();
        foreach (var t in allTypes)
        {
            var v = set.Contains(t);
            caps.Add(new LLMModelCapability
            {
                Type = t,
                Source = "llm",
                Value = v,
                IsUserSelected = null,
                Confidence = r.Confidence,
                UpdatedAt = now
            });
        }
        return caps;
    }

    private async Task<List<ModelClassifyResult>> ClassifyAvailableModelsAsync(
        ILLMClient client,
        string providerId,
        string platformType,
        List<AvailableModelDto> models,
        CancellationToken ct)
    {
        var systemPrompt =
            "你是模型管理后台的分类器。你的任务：为给定平台的一组模型做“分组(group) + 多标签(tags)”分类。\n" +
            "你必须严格只输出 JSON 数组（不要 Markdown、不要解释、不要多余文本）。\n\n" +
            "输出数组每个元素结构：\n" +
            "{\n" +
            "  \"modelName\": string,  // 必须等于输入的 modelName\n" +
            "  \"group\": string,      // 分组 key，尽量稳定、可读、全小写\n" +
            "  \"tags\": string[],     // 仅允许这些值：vision, embedding, rerank, function_calling, web_search, reasoning, free\n" +
            "  \"confidence\": number  // 0-1，可选\n" +
            "}\n\n" +
            "分组建议：按产品家族/系列（例如 doubao-vision, doubao-1.5, qwen2.5, gpt-4o 等），避免过长；不要返回空字符串。\n" +
            "标签规则：一个模型可同时拥有多个标签；不确定时可只给 reasoning。\n";

        var input = new
        {
            providerId,
            platformType,
            models = models.Select(m => new { modelName = m.ModelName, displayName = m.DisplayName, group = m.Group }).ToList()
        };

        var userMsg = JsonSerializer.Serialize(input, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        });

        var messages = new List<LLMMessage> { new() { Role = "user", Content = userMsg } };
        var raw = await CollectToTextAsync(client, systemPrompt, messages, ct);
        return ParseClassifyResults(raw);
    }

    private static async Task<string> CollectToTextAsync(
        ILLMClient client,
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken ct)
    {
        var sb = new StringBuilder();
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, ct).WithCancellation(ct))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException(chunk.ErrorMessage ?? ErrorCodes.LLM_ERROR);
            }
        }
        return sb.ToString();
    }

    private static List<ModelClassifyResult> ParseClassifyResults(string raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return new List<ModelClassifyResult>();

        // 去掉 ```json ... ``` 包裹
        if (s.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNl = s.IndexOf('\n');
            if (firstNl >= 0) s = s[(firstNl + 1)..];
            var lastFence = s.LastIndexOf("```", StringComparison.Ordinal);
            if (lastFence >= 0) s = s[..lastFence];
            s = s.Trim();
        }

        // 尝试截取数组
        var start = s.IndexOf('[');
        var end = s.LastIndexOf(']');
        if (start >= 0 && end > start)
        {
            s = s[start..(end + 1)];
        }

        try
        {
            var arr = JsonSerializer.Deserialize<List<ModelClassifyResult>>(s, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
            return arr ?? new List<ModelClassifyResult>();
        }
        catch
        {
            return new List<ModelClassifyResult>();
        }
    }

    private class ModelClassifyResult
    {
        public string? ModelName { get; set; }
        public string? Group { get; set; }
        public List<string>? Tags { get; set; }
        public double? Confidence { get; set; }
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
        var providerId = (string.IsNullOrWhiteSpace(platform.ProviderId) ? platform.PlatformType : platform.ProviderId!).Trim().ToLowerInvariant();

        using var client = _httpClientFactory.CreateClient("LoggedHttpClient");
        client.Timeout = TimeSpan.FromSeconds(30);
        client.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");

        var response = await client.GetAsync(apiUrl);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<ModelsApiResponse>();
        if (json?.Data == null) return new List<object>();

        return json.Data
            .Where(m => !string.IsNullOrEmpty(m.Id))
            // Cherry: OpenAI 列表接口会返回 tts/whisper/speech 等非对话模型，这里做最小过滤（避免 UI 噪音）
            .Where(m => IsSupportedOpenAiCompatModelId(m.Id, providerId))
            .Select(m => (object)new
            {
                modelName = m.Id,
                displayName = m.Id,
                group = ResolveCherryGroup(m.Id, providerId)
            })
            .ToList();
    }

    private static bool IsSupportedOpenAiCompatModelId(string modelId, string providerId)
    {
        if (string.IsNullOrWhiteSpace(modelId)) return false;
        // 仅对 openai provider 做过滤，避免误伤其它供应商自定义 id
        if (!string.Equals(providerId, "openai", StringComparison.OrdinalIgnoreCase)) return true;
        var baseName = PrdAgent.Infrastructure.Models.CherryModelGrouping.GetLowerBaseModelName(modelId);
        // NOT_SUPPORTED_REGEX = /(?:^tts|whisper|speech)/i
        return !(baseName.StartsWith("tts", StringComparison.OrdinalIgnoreCase)
                 || baseName.StartsWith("whisper", StringComparison.OrdinalIgnoreCase)
                 || baseName.StartsWith("speech", StringComparison.OrdinalIgnoreCase));
    }

    private static string ResolveCherryGroup(string modelId, string providerId)
    {
        // dashscope 特例：对 qwen* 模型做前缀细分（等价 Cherry 的 groupQwenModels）
        if (string.Equals(providerId, "dashscope", StringComparison.OrdinalIgnoreCase))
        {
            var baseName = PrdAgent.Infrastructure.Models.CherryModelGrouping.GetLowerBaseModelName(modelId);
            if (baseName.StartsWith("qwen", StringComparison.OrdinalIgnoreCase))
            {
                var qwenKey = PrdAgent.Infrastructure.Models.CherryModelGrouping.GetDashscopeQwenGroupKey(baseName);
                if (!string.IsNullOrWhiteSpace(qwenKey)) return qwenKey;
            }
        }
        return PrdAgent.Infrastructure.Models.CherryModelGrouping.GetDefaultGroupName(modelId, providerId);
    }

    private string GetModelsEndpoint(string apiUrl)
    {
        // 统一按配置规则拼接（/、#、默认）
        // 注意：# 结尾表示“原样使用”，因此若要拉取 models，用户需直接填写 models endpoint#
        return PrdAgent.Infrastructure.LLM.OpenAICompatUrl.BuildEndpoint(apiUrl, "models");
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
    public string? ProviderId { get; set; }
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
    public string? ProviderId { get; set; }
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

