using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - LLM平台控制器
/// </summary>
[ApiController]
[Route("api/mds/platforms")]
[Authorize]
[AdminController("mds", AdminPermissionCatalog.ModelsRead, WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class PlatformsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<PlatformsController> _logger;
    private readonly IConfiguration _config;
    private readonly ICacheManager _cache;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IModelDomainService _modelDomainService;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly ILlmRequestLogWriter _logWriter;
    private readonly IIdGenerator _idGenerator;

    // v2：不再返回预设(demo)模型列表；同时通过升级 key 前缀避免旧缓存继续生效
    private const string ModelsCacheKeyPrefix = "platform:models:v2:";
    private static readonly TimeSpan ModelsCacheExpiry = TimeSpan.FromHours(24);
    private static readonly TimeSpan ReclassifyIdempotencyExpiry = TimeSpan.FromMinutes(15);

    public PlatformsController(
        MongoDbContext db,
        ILogger<PlatformsController> logger,
        IConfiguration config,
        ICacheManager cache,
        IHttpClientFactory httpClientFactory,
        IModelDomainService modelDomainService,
        ILlmGateway gateway,
        ILLMRequestContextAccessor ctxAccessor,
        ILlmRequestLogWriter logWriter,
        IIdGenerator idGenerator)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _cache = cache;
        _httpClientFactory = httpClientFactory;
        _modelDomainService = modelDomainService;
        _gateway = gateway;
        _ctxAccessor = ctxAccessor;
        _logWriter = logWriter;
        _idGenerator = idGenerator;
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
            apiKeyMasked = ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(p.ApiKeyEncrypted, GetJwtSecret())),
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
            apiKeyMasked = ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, GetJwtSecret())),
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
            Id = await _idGenerator.GenerateIdAsync("platform"),
            Name = request.Name,
            PlatformType = request.PlatformType,
            ProviderId = string.IsNullOrWhiteSpace(request.ProviderId) ? null : request.ProviderId.Trim(),
            ApiUrl = request.ApiUrl,
            ApiKeyEncrypted = ApiKeyCrypto.Encrypt(request.ApiKey, GetJwtSecret()),
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
            update = update.Set(p => p.ApiKeyEncrypted, ApiKeyCrypto.Encrypt(request.ApiKey, GetJwtSecret()));
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
    /// <param name="id">平台 ID</param>
    /// <param name="cascade">是否级联删除平台下的所有模型（默认 false）</param>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeletePlatform(string id, [FromQuery] bool cascade = false)
    {
        // 获取平台下的所有模型
        var platformModels = await _db.LLMModels.Find(m => m.PlatformId == id).ToListAsync();

        if (platformModels.Count > 0)
        {
            // 检查是否有模型被设置为四大类型（主模型/意图/识图/生图）
            var blockedModels = new List<string>();
            foreach (var m in platformModels)
            {
                var roles = new List<string>();
                if (m.IsMain) roles.Add("主模型");
                if (m.IsIntent) roles.Add("意图模型");
                if (m.IsVision) roles.Add("识图模型");
                if (m.IsImageGen) roles.Add("生图模型");
                if (roles.Count > 0)
                {
                    blockedModels.Add($"{m.Name}({string.Join("/", roles)})");
                }
            }
            if (blockedModels.Count > 0)
            {
                return BadRequest(ApiResponse<object>.Fail("HAS_SPECIAL_MODELS",
                    $"以下模型被设置为系统模型，请先取消设置后再删除平台：{string.Join("、", blockedModels)}"));
            }

            // 检查是否有模型被添加到模型池
            var modelIds = platformModels.Select(m => m.Id).ToHashSet();
            var groupsWithModels = await _db.ModelGroups
                .Find(g => g.Models.Any(item => modelIds.Contains(item.ModelId)))
                .ToListAsync();

            if (groupsWithModels.Count > 0)
            {
                var affectedGroups = groupsWithModels.Select(g => g.Name).Distinct().ToList();
                return BadRequest(ApiResponse<object>.Fail("HAS_MODEL_POOL_REFS",
                    $"平台下的模型被以下模型池引用，请先从模型池移除：{string.Join("、", affectedGroups)}"));
            }

            if (!cascade)
            {
                return BadRequest(ApiResponse<object>.Fail("HAS_MODELS", $"该平台下有{platformModels.Count}个模型，无法删除。如需级联删除，请添加 ?cascade=true 参数"));
            }

            // 级联删除：先删除平台下的所有模型
            var deleteModelsResult = await _db.LLMModels.DeleteManyAsync(m => m.PlatformId == id);
            _logger.LogInformation("Cascade deleted {Count} models for platform: {Id}", deleteModelsResult.DeletedCount, id);
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
        var models = await GetModelsForPlatform(platform, Admin.Platforms.AvailableModels);
        
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
        var models = await GetModelsForPlatform(platform, Admin.Platforms.RefreshModels);
        
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
    [HttpPost("{id}/reclassify-models")]
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
        var available = await GetModelsForPlatform(platform, Admin.Platforms.ReclassifyFetchModels);
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
        var appCallerCode = Admin.Platforms.Reclassify;
        var llmClient = _gateway.CreateClient(appCallerCode, "intent");

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
            RequestPurpose: appCallerCode));

        var results = new List<ModelClassifyResult>();
        const int chunkSize = 180;
        for (var i = 0; i < available.Count; i += chunkSize)
        {
            var chunk = available.Skip(i).Take(chunkSize).ToList();
            try
            {
                var chunkRes = await ClassifyAvailableModelsAsync(llmClient, providerId, platform.PlatformType, chunk, ct);
                results.AddRange(chunkRes);
            }
            catch (ModelReclassifyParseException ex)
            {
                _logger.LogWarning(ex,
                    "Invalid JSON returned by main model when reclassifying platform {PlatformId}. requestId={RequestId}",
                    id, requestId);
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"主模型未返回有效JSON：{ex.Message}"));
            }
        }

        // 3) 写回已配置模型（llmmodels）：按 platformId + modelId 匹配（字段名：ModelName）
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
        var expected = models.Select(m => m.ModelName ?? string.Empty).ToList();
        return ModelReclassifyParser.ParseOrThrow(raw, expected)
            .Select(r => new ModelClassifyResult
            {
                ModelName = r.ModelName,
                Group = r.Group,
                Tags = r.Tags,
                Confidence = r.Confidence
            })
            .ToList();
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
    private async Task<List<AvailableModelDto>> GetModelsForPlatform(LLMPlatform platform, string? requestPurpose = null)
    {
        // OpenAI兼容的平台尝试从API获取模型列表
        if (platform.PlatformType == "openai" || platform.PlatformType == "other")
        {
            try
            {
                var apiModels = await FetchModelsFromApi(platform, requestPurpose);
                if (apiModels.Count > 0)
                {
                    return apiModels;
                }
            }
            catch (Exception ex)
            {
                var providerId =
                    (string.IsNullOrWhiteSpace(platform.ProviderId) ? platform.PlatformType : platform.ProviderId!).Trim()
                        .ToLowerInvariant();
                var endpoint = GetModelsEndpoint(platform.ApiUrl);
                _logger.LogWarning(ex,
                    "Failed to fetch models from API for platform {PlatformId}. provider={ProviderId} endpoint={Endpoint}",
                    platform.Id,
                    providerId,
                    endpoint);
            }
        }

        // 不提供任何“预设(demo)模型”兜底：没有就返回空
        return new List<AvailableModelDto>();
    }

    /// <summary>
    /// 从API获取模型列表
    /// </summary>
    private async Task<List<AvailableModelDto>> FetchModelsFromApi(LLMPlatform platform, string? requestPurpose)
    {
        var endpoint = GetModelsEndpoint(platform.ApiUrl);
        var apiKey = ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, GetJwtSecret());
        var providerId = (string.IsNullOrWhiteSpace(platform.ProviderId) ? platform.PlatformType : platform.ProviderId!).Trim().ToLowerInvariant();
        var apiKeyEmpty = string.IsNullOrWhiteSpace(apiKey);

        using var client = _httpClientFactory.CreateClient("LoggedHttpClient");
        client.Timeout = TimeSpan.FromSeconds(30);
        client.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");

        // 写入 LLM 请求日志：平台拉取 models 接口也需要被记录（类型：更新模型）
        var requestId = Guid.NewGuid().ToString("N");
        var startedAt = DateTime.UtcNow;
        var adminId = GetAdminId();
        var (apiBase, path) = OpenAICompatUrl.SplitApiBaseAndPath(endpoint, client.BaseAddress);

        if (apiKeyEmpty)
        {
            // 不记录明文密钥；仅提示“可能没有解密出有效 key”（常见原因：Jwt:Secret 变更/长度不足导致解密失败、或平台未保存 key）
            _logger.LogWarning(
                "Platform API key is empty when fetching /models. platformId={PlatformId} provider={ProviderId} endpoint={Endpoint}",
                platform.Id,
                providerId,
                endpoint);
        }

        var start = new LlmLogStart(
            RequestId: requestId,
            Provider: providerId,
            Model: "(models)",
            ApiBase: apiBase,
            Path: path,
            HttpMethod: "GET",
            RequestHeadersRedacted: new Dictionary<string, string>
            {
                // 仅用于诊断是否“带了 key”：不泄露任何真实值
                ["Authorization"] = apiKeyEmpty ? "Bearer (empty)" : "Bearer ***"
            },
            RequestBodyRedacted: "",
            RequestBodyHash: null,
            QuestionText: null,
            SystemPromptChars: null,
            SystemPromptHash: null,
            SystemPromptText: null,
            MessageCount: null,
            GroupId: null,
            SessionId: null,
            UserId: adminId,
            ViewRole: "ADMIN",
            DocumentChars: null,
            DocumentHash: null,
            UserPromptChars: null,
            StartedAt: startedAt,
            RequestType: "update-model",
            RequestPurpose: string.IsNullOrWhiteSpace(requestPurpose) ? Admin.Platforms.FetchModels : requestPurpose.Trim(),
            PlatformId: platform.Id,
            PlatformName: platform.Name);

        var logId = await _logWriter.StartAsync(start);

        HttpResponseMessage response;
        string body;
        try
        {
            response = await client.GetAsync(endpoint);
            if (!string.IsNullOrWhiteSpace(logId))
            {
                // 这里以“拿到响应头”的时刻作为 FirstByteAt（GET models 不走 SSE，足够用于监控）
                _logWriter.MarkFirstByte(logId!, DateTime.UtcNow);
            }

            body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                if (!string.IsNullOrWhiteSpace(logId))
                {
                    _logWriter.MarkError(logId!, $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}\n{body}", (int)response.StatusCode);
                }
                response.EnsureSuccessStatusCode();
            }
        }
        catch (Exception ex)
        {
            if (!string.IsNullOrWhiteSpace(logId))
            {
                _logWriter.MarkError(logId!, ex.Message);
            }
            throw;
        }

        // 解析 JSON
        ModelsApiResponse? json;
        try
        {
            json = JsonSerializer.Deserialize<ModelsApiResponse>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch
        {
            json = null;
        }

        if (!string.IsNullOrWhiteSpace(logId))
        {
            var endedAt = DateTime.UtcNow;
            var durationMs = (long)Math.Max(0, (endedAt - startedAt).TotalMilliseconds);
            var prettyBody = TryPrettyJson(body);
            var assembledChars = string.IsNullOrEmpty(prettyBody) ? 0 : prettyBody.Length;
            var assembledHash = Sha256Hex(prettyBody ?? string.Empty);

            _logWriter.MarkDone(logId!, new LlmLogDone(
                StatusCode: (int)response.StatusCode,
                ResponseHeaders: ToHeaderDictionary(response),
                InputTokens: null,
                OutputTokens: null,
                CacheCreationInputTokens: null,
                CacheReadInputTokens: null,
                TokenUsageSource: "missing",
                ImageSuccessCount: null,
                AnswerText: prettyBody,
                ThinkingText: null,
                AssembledTextChars: assembledChars,
                AssembledTextHash: assembledHash,
                Status: "succeeded",
                EndedAt: endedAt,
                DurationMs: durationMs));
        }

        if (json?.Data == null) return new List<AvailableModelDto>();

        var unknownTagSamples = new List<string>();
        var unknownTagCount = 0;

        var list = json.Data
            .Where(m => !string.IsNullOrEmpty(m.Id))
            // Volces Ark 等部分供应商会在 /models 条目上标记 status=Shutdown（或类似），需要过滤掉不可用模型
            .Where(m => ModelsListStatusFilter.ShouldInclude(providerId, endpoint, m.Id, m.Status))
            // Cherry: OpenAI 列表接口会返回 tts/whisper/speech 等非对话模型，这里做最小过滤（避免 UI 噪音）
            .Where(m => IsSupportedOpenAiCompatModelId(m.Id, providerId))
            .Select(m =>
            {
                var tags = ModelsListTagAdapter.InferTags(
                    providerId,
                    endpoint,
                    m.Id,
                    m.Domain,
                    m.TaskType,
                    m.Features?.Tools?.FunctionCalling,
                    m.Modalities?.InputModalities,
                    m.Modalities?.OutputModalities,
                    out var unknownReason);
                if (!string.IsNullOrWhiteSpace(unknownReason))
                {
                    unknownTagCount++;
                    if (unknownTagSamples.Count < 10) unknownTagSamples.Add($"{m.Id} ({unknownReason})");
                }

                var displayName = !string.IsNullOrWhiteSpace(m.Name) ? m.Name : m.Id;
                return new AvailableModelDto
                {
                    ModelName = m.Id,
                    DisplayName = displayName,
                    Group = ResolveCherryGroup(m.Id, providerId),
                    Tags = tags
                };
            })
            .ToList();

        if (unknownTagCount > 0)
        {
            _logger.LogInformation(
                "Models list tag inference: provider={ProviderId} endpoint={Endpoint} has {Count} items with unknown tags (sample: {Sample})",
                providerId,
                endpoint,
                unknownTagCount,
                string.Join(", ", unknownTagSamples));
        }

        return list;
    }

    private static Dictionary<string, string> ToHeaderDictionary(HttpResponseMessage response)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var h in response.Headers)
        {
            dict[h.Key] = string.Join(", ", h.Value);
        }
        if (response.Content != null)
        {
            foreach (var h in response.Content.Headers)
            {
                dict[h.Key] = string.Join(", ", h.Value);
            }
        }
        return dict;
    }

    private static string TryPrettyJson(string raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return string.Empty;
        try
        {
            using var doc = JsonDocument.Parse(s);
            return JsonSerializer.Serialize(doc, new JsonSerializerOptions { WriteIndented = true });
        }
        catch
        {
            return raw ?? string.Empty;
        }
    }

    private static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
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

    private object MapModelResponse(LLMModel m) => new
    {
        m.Id,
        m.Name,
        m.ModelName,
        m.ApiUrl,
        apiKeyMasked = string.IsNullOrEmpty(m.ApiKeyEncrypted) ? null : ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(m.ApiKeyEncrypted, GetJwtSecret())),
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

    private string GetJwtSecret() => _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
}

public class ModelsApiResponse
{
    public List<ModelItem> Data { get; set; } = new();
}

public class ModelItem
{
    public string Id { get; set; } = string.Empty;
    public string? Status { get; set; }
    public string? Name { get; set; }
    public string? Domain { get; set; }
    [JsonPropertyName("task_type")]
    public List<string>? TaskType { get; set; }
    public ModelModalities? Modalities { get; set; }
    public ModelFeatures? Features { get; set; }
    [JsonPropertyName("token_limits")]
    public Dictionary<string, JsonElement>? TokenLimits { get; set; }
}

public class ModelModalities
{
    [JsonPropertyName("input_modalities")]
    public List<string>? InputModalities { get; set; }

    [JsonPropertyName("output_modalities")]
    public List<string>? OutputModalities { get; set; }
}

public class ModelFeatures
{
    public ModelTools? Tools { get; set; }

    [JsonPropertyName("structured_outputs")]
    public Dictionary<string, JsonElement>? StructuredOutputs { get; set; }
}

public class ModelTools
{
    [JsonPropertyName("function_calling")]
    public bool? FunctionCalling { get; set; }
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
    public List<string>? Tags { get; set; }
}


