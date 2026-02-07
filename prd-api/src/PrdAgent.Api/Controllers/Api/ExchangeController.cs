using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 模型中继 (Exchange) 控制器
/// </summary>
[ApiController]
[Route("api/mds/exchanges")]
[Authorize]
[AdminController("mds", AdminPermissionCatalog.ModelsRead, WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class ExchangeController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ExchangeController> _logger;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ExchangeTransformerRegistry _transformerRegistry = new();

    public ExchangeController(MongoDbContext db, ILogger<ExchangeController> logger, IConfiguration config, IHttpClientFactory httpClientFactory)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>
    /// 获取所有 Exchange 配置
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetExchanges(CancellationToken ct)
    {
        var list = await _db.ModelExchanges
            .Find(FilterDefinition<ModelExchange>.Empty)
            .SortByDescending(e => e.CreatedAt)
            .ToListAsync(ct);

        var result = list.Select(e => new
        {
            e.Id,
            e.Name,
            e.ModelAlias,
            e.TargetUrl,
            apiKeyMasked = ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(e.TargetApiKeyEncrypted, GetJwtSecret())),
            e.TargetAuthScheme,
            e.TransformerType,
            e.TransformerConfig,
            e.Enabled,
            e.Description,
            e.CreatedAt,
            e.UpdatedAt,
            // 虚拟平台 ID，前端在模型池中使用
            platformId = ModelResolverConstants.ExchangePlatformId,
            platformName = ModelResolverConstants.ExchangePlatformName
        });

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 获取单个 Exchange 配置
    /// </summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetExchange(string id, CancellationToken ct)
    {
        var exchange = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (exchange == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        return Ok(ApiResponse<object>.Ok(new
        {
            exchange.Id,
            exchange.Name,
            exchange.ModelAlias,
            exchange.TargetUrl,
            apiKeyMasked = ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(exchange.TargetApiKeyEncrypted, GetJwtSecret())),
            exchange.TargetAuthScheme,
            exchange.TransformerType,
            exchange.TransformerConfig,
            exchange.Enabled,
            exchange.Description,
            exchange.CreatedAt,
            exchange.UpdatedAt
        }));
    }

    /// <summary>
    /// 创建 Exchange 配置
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateExchange([FromBody] CreateExchangeRequest request, CancellationToken ct)
    {
        // 校验 ModelAlias 唯一性
        var existing = await _db.ModelExchanges
            .Find(e => e.ModelAlias == request.ModelAlias.Trim())
            .FirstOrDefaultAsync(ct);
        if (existing != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"ModelAlias '{request.ModelAlias}' 已存在"));

        // 校验 TransformerType 是否已注册
        if (!string.IsNullOrWhiteSpace(request.TransformerType) &&
            _transformerRegistry.Get(request.TransformerType) == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"未知的转换器类型: {request.TransformerType}"));
        }

        var exchange = new ModelExchange
        {
            Name = request.Name.Trim(),
            ModelAlias = request.ModelAlias.Trim(),
            TargetUrl = request.TargetUrl.Trim(),
            TargetApiKeyEncrypted = ApiKeyCrypto.Encrypt(request.TargetApiKey ?? string.Empty, GetJwtSecret()),
            TargetAuthScheme = string.IsNullOrWhiteSpace(request.TargetAuthScheme) ? "Bearer" : request.TargetAuthScheme.Trim(),
            TransformerType = string.IsNullOrWhiteSpace(request.TransformerType) ? "passthrough" : request.TransformerType.Trim(),
            TransformerConfig = request.TransformerConfig,
            Enabled = request.Enabled,
            Description = request.Description?.Trim()
        };

        await _db.ModelExchanges.InsertOneAsync(exchange, cancellationToken: ct);

        _logger.LogInformation("[Exchange] 创建 Exchange: {Id} / {Name} / {ModelAlias}", exchange.Id, exchange.Name, exchange.ModelAlias);

        return Ok(ApiResponse<object>.Ok(new { exchange.Id }));
    }

    /// <summary>
    /// 更新 Exchange 配置
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateExchange(string id, [FromBody] UpdateExchangeRequest request, CancellationToken ct)
    {
        var existing = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (existing == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        // 检查 ModelAlias 唯一性（排除自身）
        if (!string.IsNullOrWhiteSpace(request.ModelAlias))
        {
            var conflict = await _db.ModelExchanges
                .Find(e => e.ModelAlias == request.ModelAlias.Trim() && e.Id != id)
                .FirstOrDefaultAsync(ct);
            if (conflict != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"ModelAlias '{request.ModelAlias}' 已被其他 Exchange 使用"));
        }

        // 校验 TransformerType
        if (!string.IsNullOrWhiteSpace(request.TransformerType) &&
            _transformerRegistry.Get(request.TransformerType) == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"未知的转换器类型: {request.TransformerType}"));
        }

        var update = Builders<ModelExchange>.Update
            .Set(e => e.Name, request.Name?.Trim() ?? existing.Name)
            .Set(e => e.ModelAlias, request.ModelAlias?.Trim() ?? existing.ModelAlias)
            .Set(e => e.TargetUrl, request.TargetUrl?.Trim() ?? existing.TargetUrl)
            .Set(e => e.TargetAuthScheme, request.TargetAuthScheme?.Trim() ?? existing.TargetAuthScheme)
            .Set(e => e.TransformerType, request.TransformerType?.Trim() ?? existing.TransformerType)
            .Set(e => e.TransformerConfig, request.TransformerConfig ?? existing.TransformerConfig)
            .Set(e => e.Enabled, request.Enabled ?? existing.Enabled)
            .Set(e => e.Description, request.Description?.Trim())
            .Set(e => e.UpdatedAt, DateTime.UtcNow);

        // 仅在提供了新 ApiKey 时更新
        if (!string.IsNullOrEmpty(request.TargetApiKey))
        {
            update = update.Set(e => e.TargetApiKeyEncrypted, ApiKeyCrypto.Encrypt(request.TargetApiKey, GetJwtSecret()));
        }

        await _db.ModelExchanges.UpdateOneAsync(e => e.Id == id, update, cancellationToken: ct);

        _logger.LogInformation("[Exchange] 更新 Exchange: {Id} / {Name}", id, request.Name);

        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 删除 Exchange 配置
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteExchange(string id, CancellationToken ct)
    {
        var result = await _db.ModelExchanges.DeleteOneAsync(e => e.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        _logger.LogInformation("[Exchange] 删除 Exchange: {Id}", id);

        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 获取所有已注册的转换器类型（供前端下拉选择）
    /// </summary>
    [HttpGet("transformer-types")]
    public IActionResult GetTransformerTypes()
    {
        var types = _transformerRegistry.GetRegisteredTypes()
            .Select(t => new { value = t, label = t })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = types }));
    }

    /// <summary>
    /// 获取 Exchange 列表（精简版，供模型池添加模型时选择）
    /// </summary>
    [HttpGet("for-pool")]
    public async Task<IActionResult> GetExchangesForPool(CancellationToken ct)
    {
        var filter = Builders<ModelExchange>.Filter.Eq(e => e.Enabled, true);
        var list = await _db.ModelExchanges
            .Find(filter)
            .SortBy(e => e.Name)
            .ToListAsync(ct);

        var result = list.Select(e => new
        {
            modelId = e.ModelAlias,
            platformId = ModelResolverConstants.ExchangePlatformId,
            platformName = ModelResolverConstants.ExchangePlatformName,
            displayName = $"[Exchange] {e.Name} ({e.ModelAlias})",
            e.TransformerType
        });

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 测试 Exchange 转换管线：标准请求 → 转换后请求 → 发送 → 响应转换
    /// 返回三个阶段的数据供前端展示
    /// </summary>
    [HttpPost("{id}/test")]
    public async Task<IActionResult> TestExchange(string id, [FromBody] ExchangeTestRequest request, CancellationToken ct)
    {
        var exchange = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (exchange == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        var transformer = _transformerRegistry.Get(exchange.TransformerType);
        if (transformer == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"转换器 '{exchange.TransformerType}' 未注册"));

        // 1. 解析标准请求体
        JsonObject standardBody;
        try
        {
            standardBody = JsonNode.Parse(request.StandardRequestBody)?.AsObject()
                           ?? new JsonObject();
        }
        catch (JsonException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"请求体 JSON 解析失败: {ex.Message}"));
        }

        // 2. 转换请求
        JsonObject transformedRequest;
        try
        {
            transformedRequest = transformer.TransformRequest(standardBody, exchange.TransformerConfig);
        }
        catch (Exception ex)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                standardRequest = standardBody.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                transformedRequest = (string?)null,
                rawResponse = (string?)null,
                transformedResponse = (string?)null,
                error = $"请求转换失败: {ex.Message}",
                httpStatus = (int?)null,
                durationMs = (long?)null
            }));
        }

        var transformedJson = transformedRequest.ToJsonString(new JsonSerializerOptions { WriteIndented = true });

        // 3. 如果只做转换预览（不实际发送），直接返回
        if (request.DryRun)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                standardRequest = standardBody.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                transformedRequest = transformedJson,
                rawResponse = (string?)null,
                transformedResponse = (string?)null,
                error = (string?)null,
                httpStatus = (int?)null,
                durationMs = (long?)null,
                isDryRun = true
            }));
        }

        // 4. 智能路由：根据请求内容决定实际目标 URL
        var actualTargetUrl = transformer.ResolveTargetUrl(exchange.TargetUrl, standardBody, exchange.TransformerConfig)
                              ?? exchange.TargetUrl;

        var apiKey = ApiKeyCrypto.Decrypt(exchange.TargetApiKeyEncrypted, GetJwtSecret());
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, actualTargetUrl)
        {
            Content = new StringContent(transformedRequest.ToJsonString(), System.Text.Encoding.UTF8, "application/json")
        };

        // 设置认证头
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            switch ((exchange.TargetAuthScheme ?? "Bearer").ToLowerInvariant())
            {
                case "x-api-key":
                case "xapikey":
                    httpRequest.Headers.TryAddWithoutValidation("x-api-key", apiKey);
                    break;
                case "key":
                    httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Key", apiKey);
                    break;
                default:
                    httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
                    break;
            }
        }

        string rawResponseBody;
        int httpStatus;
        long durationMs;

        try
        {
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(30);

            var startedAt = DateTime.UtcNow;
            var response = await httpClient.SendAsync(httpRequest, ct);
            rawResponseBody = await response.Content.ReadAsStringAsync(ct);
            httpStatus = (int)response.StatusCode;
            durationMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
        }
        catch (Exception ex)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                standardRequest = standardBody.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                transformedRequest = transformedJson,
                rawResponse = (string?)null,
                transformedResponse = (string?)null,
                error = $"HTTP 请求失败: {ex.Message}",
                httpStatus = (int?)null,
                durationMs = (long?)null
            }));
        }

        // 5. 转换响应
        string? transformedResponseJson = null;
        string? responseError = null;
        try
        {
            if (httpStatus >= 200 && httpStatus < 300)
            {
                var rawJson = JsonNode.Parse(rawResponseBody)?.AsObject();
                if (rawJson != null)
                {
                    var transformedResp = transformer.TransformResponse(rawJson, exchange.TransformerConfig);
                    transformedResponseJson = transformedResp.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
                }
            }
        }
        catch (Exception ex)
        {
            responseError = $"响应转换失败: {ex.Message}";
        }

        // 格式化原始响应
        string formattedRawResponse;
        try
        {
            var parsed = JsonNode.Parse(rawResponseBody);
            formattedRawResponse = parsed?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) ?? rawResponseBody;
        }
        catch
        {
            formattedRawResponse = rawResponseBody;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            standardRequest = standardBody.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
            transformedRequest = transformedJson,
            rawResponse = formattedRawResponse,
            transformedResponse = transformedResponseJson,
            error = responseError,
            httpStatus = (int?)httpStatus,
            durationMs = (long?)durationMs
        }));
    }

    /// <summary>
    /// 上传测试图片到目标平台 CDN（用于图生图测试）
    /// 目前支持 fal.ai 相关转换器，通过 fal.ai Storage API 上传
    /// </summary>
    [HttpPost("{id}/upload-test-image")]
    public async Task<IActionResult> UploadTestImage(string id, IFormFile file, CancellationToken ct)
    {
        var exchange = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (exchange == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        // 目前只有 fal.ai 相关转换器支持图片上传
        var supportedTypes = new[] { "fal-image", "fal-image-edit" };
        if (!supportedTypes.Contains(exchange.TransformerType, StringComparer.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"转换器类型 '{exchange.TransformerType}' 不支持图片上传"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择要上传的图片"));

        // 读取文件
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();

        // 上传到 fal.ai CDN Storage
        var apiKey = ApiKeyCrypto.Decrypt(exchange.TargetApiKeyEncrypted, GetJwtSecret());
        var httpClient = _httpClientFactory.CreateClient();
        httpClient.Timeout = TimeSpan.FromSeconds(60);

        const string falStorageUrl = "https://rest.alpha.fal.ai/storage/upload";
        var uploadRequest = new HttpRequestMessage(HttpMethod.Post, falStorageUrl)
        {
            Content = new ByteArrayContent(bytes)
        };
        uploadRequest.Content.Headers.ContentType =
            new System.Net.Http.Headers.MediaTypeHeaderValue(file.ContentType ?? "image/png");

        // fal.ai Storage API 始终使用 Key 认证
        uploadRequest.Headers.Authorization = new AuthenticationHeaderValue("Key", apiKey);

        try
        {
            var response = await httpClient.SendAsync(uploadRequest, ct);
            var responseBody = await response.Content.ReadAsStringAsync(ct);

            if (!response.IsSuccessStatusCode)
                return Ok(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR,
                    $"图片上传失败 (HTTP {(int)response.StatusCode}): {responseBody}"));

            var json = JsonNode.Parse(responseBody);
            var url = json?["url"]?.GetValue<string>();

            if (string.IsNullOrEmpty(url))
                return Ok(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR,
                    $"上传响应中未找到 URL: {responseBody}"));

            return Ok(ApiResponse<object>.Ok(new { url }));
        }
        catch (Exception ex)
        {
            return Ok(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"上传请求失败: {ex.Message}"));
        }
    }

    private string GetJwtSecret() => _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
}

// ========== Request DTOs ==========

public class CreateExchangeRequest
{
    public string Name { get; set; } = string.Empty;
    public string ModelAlias { get; set; } = string.Empty;
    public string TargetUrl { get; set; } = string.Empty;
    public string? TargetApiKey { get; set; }
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public Dictionary<string, object>? TransformerConfig { get; set; }
    public bool Enabled { get; set; } = true;
    public string? Description { get; set; }
}

public class UpdateExchangeRequest
{
    public string? Name { get; set; }
    public string? ModelAlias { get; set; }
    public string? TargetUrl { get; set; }
    public string? TargetApiKey { get; set; }
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public Dictionary<string, object>? TransformerConfig { get; set; }
    public bool? Enabled { get; set; }
    public string? Description { get; set; }
}

public class ExchangeTestRequest
{
    /// <summary>标准 OpenAI 格式的请求体 JSON 字符串</summary>
    public string StandardRequestBody { get; set; } = "{}";
    /// <summary>仅预览转换结果，不实际发送请求</summary>
    public bool DryRun { get; set; }
}
