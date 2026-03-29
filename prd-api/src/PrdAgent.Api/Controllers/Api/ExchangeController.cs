using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
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
        SetTestAuthHeader(httpRequest, exchange.TargetAuthScheme, apiKey);

        // 设置转换器额外 headers
        var extraHeaders = transformer.GetExtraHeaders(exchange.TransformerConfig);
        if (extraHeaders != null)
        {
            foreach (var (key, value) in extraHeaders)
                httpRequest.Headers.TryAddWithoutValidation(key, value);
        }

        string rawResponseBody;
        int httpStatus;
        long durationMs;

        try
        {
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(120);

            var startedAt = DateTime.UtcNow;
            var response = await httpClient.SendAsync(httpRequest, ct);
            rawResponseBody = await response.Content.ReadAsStringAsync(ct);
            httpStatus = (int)response.StatusCode;

            // 异步转换器：submit+query 轮询
            if (transformer is IAsyncExchangeTransformer asyncTx)
            {
                var respHeaders = new Dictionary<string, string>();
                foreach (var h in response.Headers)
                    respHeaders[h.Key] = string.Join(", ", h.Value);

                if (asyncTx.IsTaskFailed(httpStatus, respHeaders, rawResponseBody, out var failError))
                {
                    durationMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                    return Ok(ApiResponse<object>.Ok(new
                    {
                        standardRequest = standardBody.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                        transformedRequest = transformedJson,
                        rawResponse = rawResponseBody,
                        transformedResponse = (string?)null,
                        error = failError,
                        httpStatus = (int?)httpStatus,
                        durationMs = (long?)durationMs,
                        isAsync = true
                    }));
                }

                if (asyncTx.IsTaskPending(httpStatus, respHeaders, rawResponseBody))
                {
                    var (queryUrl, queryBody, queryExtraHeaders) = asyncTx.BuildQueryRequest(
                        actualTargetUrl, httpStatus, respHeaders, rawResponseBody, exchange.TransformerConfig);

                    // 获取 submit 时的 X-Api-Request-Id
                    string? submitRequestId = null;
                    if (httpRequest.Headers.TryGetValues("X-Api-Request-Id", out var reqIds))
                        submitRequestId = reqIds.FirstOrDefault();

                    var maxAttempts = Math.Min(asyncTx.MaxPollAttempts, 120); // 测试模式最多 120 次
                    for (var i = 0; i < maxAttempts; i++)
                    {
                        await Task.Delay(asyncTx.PollIntervalMs, ct);

                        var qReq = new HttpRequestMessage(HttpMethod.Post, queryUrl)
                        {
                            Content = new StringContent(queryBody?.ToJsonString() ?? "{}", System.Text.Encoding.UTF8, "application/json")
                        };
                        SetTestAuthHeader(qReq, exchange.TargetAuthScheme, apiKey);
                        foreach (var (k, v) in queryExtraHeaders)
                            qReq.Headers.TryAddWithoutValidation(k, v);
                        if (submitRequestId != null)
                            qReq.Headers.TryAddWithoutValidation("X-Api-Request-Id", submitRequestId);

                        var qResp = await httpClient.SendAsync(qReq, ct);
                        rawResponseBody = await qResp.Content.ReadAsStringAsync(ct);
                        httpStatus = (int)qResp.StatusCode;

                        var qHeaders = new Dictionary<string, string>();
                        foreach (var h in qResp.Headers)
                            qHeaders[h.Key] = string.Join(", ", h.Value);

                        if (asyncTx.IsTaskComplete(httpStatus, qHeaders, rawResponseBody))
                            break;

                        if (asyncTx.IsTaskFailed(httpStatus, qHeaders, rawResponseBody, out var qErr))
                        {
                            durationMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                            return Ok(ApiResponse<object>.Ok(new
                            {
                                standardRequest = standardBody.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                                transformedRequest = transformedJson,
                                rawResponse = rawResponseBody,
                                transformedResponse = (string?)null,
                                error = qErr,
                                httpStatus = (int?)httpStatus,
                                durationMs = (long?)durationMs,
                                isAsync = true
                            }));
                        }
                    }
                }
            }

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
    /// 测试 Exchange 转换管线（音频文件上传版）：
    /// 接收音频文件 → 转 base64 → 构建标准请求 → 走完整 Exchange 管线
    /// </summary>
    [HttpPost("{id}/test-audio")]
    [RequestSizeLimit(100 * 1024 * 1024)] // 100MB
    public async Task<IActionResult> TestExchangeWithAudio(
        string id,
        [FromForm] IFormFile file,
        [FromForm] string? audioUrl,
        [FromForm] bool dryRun = false,
        CancellationToken ct = default)
    {
        var exchange = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (exchange == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        // 构建标准请求：优先使用 URL，否则用上传文件转 base64
        var standardBody = new JsonObject();

        if (!string.IsNullOrWhiteSpace(audioUrl))
        {
            standardBody["audio_url"] = audioUrl.Trim();
        }
        else if (file != null && file.Length > 0)
        {
            using var ms = new MemoryStream();
            await file.CopyToAsync(ms, ct);
            var base64 = Convert.ToBase64String(ms.ToArray());
            standardBody["audio_data"] = base64;
            standardBody["format"] = Path.GetExtension(file.FileName).TrimStart('.');
        }
        else
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传音频文件或提供 audio_url"));
        }

        // 复用 JSON 测试逻辑
        var testRequest = new ExchangeTestRequest
        {
            StandardRequestBody = standardBody.ToJsonString(),
            DryRun = dryRun
        };

        return await TestExchange(id, testRequest, ct);
    }

    /// <summary>
    /// 获取可用的导入模板列表（预设配置，用户只需提供 API Key 即可一键创建）
    /// </summary>
    [HttpGet("templates")]
    public IActionResult GetImportTemplates()
    {
        var templates = ExchangeTemplates.All.Select(t => new
        {
            t.Id,
            t.Name,
            t.Description,
            t.ApiKeyPlaceholder,
            t.ApiKeyHint,
            preset = new
            {
                t.Preset.Name,
                t.Preset.ModelAlias,
                t.Preset.TargetUrl,
                t.Preset.TargetAuthScheme,
                t.Preset.TransformerType,
                t.Preset.TransformerConfig,
                t.Preset.Enabled,
                t.Preset.Description
            }
        });

        return Ok(ApiResponse<object>.Ok(new { items = templates }));
    }

    /// <summary>
    /// 通过模板导入 Exchange（用户只需提供模板 ID + API Key）
    /// </summary>
    [HttpPost("import-from-template")]
    public async Task<IActionResult> ImportFromTemplate([FromBody] ImportFromTemplateRequest request, CancellationToken ct)
    {
        var template = ExchangeTemplates.All.FirstOrDefault(t => t.Id == request.TemplateId);
        if (template == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"模板 '{request.TemplateId}' 不存在"));

        if (string.IsNullOrWhiteSpace(request.ApiKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "API Key 不能为空"));

        // 检查别名冲突
        var alias = template.Preset.ModelAlias;
        var existing = await _db.ModelExchanges
            .Find(e => e.ModelAlias == alias)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"ModelAlias '{alias}' 已存在，该模板可能已导入"));

        var exchange = new ModelExchange
        {
            Name = template.Preset.Name,
            ModelAlias = template.Preset.ModelAlias,
            TargetUrl = template.Preset.TargetUrl,
            TargetApiKeyEncrypted = ApiKeyCrypto.Encrypt(request.ApiKey.Trim(), GetJwtSecret()),
            TargetAuthScheme = template.Preset.TargetAuthScheme ?? "Bearer",
            TransformerType = template.Preset.TransformerType ?? "passthrough",
            TransformerConfig = template.Preset.TransformerConfig,
            Enabled = template.Preset.Enabled,
            Description = template.Preset.Description
        };

        await _db.ModelExchanges.InsertOneAsync(exchange, cancellationToken: ct);

        _logger.LogInformation("[Exchange] 通过模板导入 Exchange: {Id} / {Name} / template={TemplateId}",
            exchange.Id, exchange.Name, request.TemplateId);

        return Ok(ApiResponse<object>.Ok(new { exchange.Id, exchange.Name, exchange.ModelAlias }));
    }

    private string GetJwtSecret() => _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";

    private static void SetTestAuthHeader(HttpRequestMessage req, string? authScheme, string? apiKey)
    {
        if (string.IsNullOrWhiteSpace(apiKey)) return;
        switch ((authScheme ?? "Bearer").ToLowerInvariant())
        {
            case "x-api-key":
            case "xapikey":
                req.Headers.TryAddWithoutValidation("x-api-key", apiKey);
                break;
            case "key":
                req.Headers.Authorization = new AuthenticationHeaderValue("Key", apiKey);
                break;
            case "doubao-asr":
                var parts = apiKey.Split('|', 2);
                var appId = parts.Length > 1 ? parts[0] : "";
                var accessToken = parts.Length > 1 ? parts[1] : apiKey;
                req.Headers.TryAddWithoutValidation("X-Api-App-Key", appId);
                req.Headers.TryAddWithoutValidation("X-Api-Access-Key", accessToken);
                break;
            default:
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
                break;
        }
    }
}

// ========== Exchange 导入模板（硬编码） ==========

public static class ExchangeTemplates
{
    public static readonly List<ExchangeTemplate> All = new()
    {
        new ExchangeTemplate
        {
            Id = "doubao-asr-xapikey",
            Name = "豆包大模型语音识别",
            Description = "字节跳动豆包 BigModel ASR，使用 x-api-key 认证，异步 submit+query 模式",
            ApiKeyPlaceholder = "x-api-key",
            ApiKeyHint = "在火山引擎控制台获取 API Key（UUID 格式）",
            Preset = new ExchangeTemplatePreset
            {
                Name = "豆包 ASR (BigModel)",
                ModelAlias = "doubao-asr-bigmodel",
                TargetUrl = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
                TargetAuthScheme = "XApiKey",
                TransformerType = "doubao-asr",
                TransformerConfig = new Dictionary<string, object>
                {
                    ["resourceId"] = "volc.bigasr.auc",
                    ["enableItn"] = true,
                    ["enablePunc"] = true,
                    ["enableDdc"] = true,
                    ["enableSpeakerInfo"] = true,
                    ["enableChannelSplit"] = true
                },
                Enabled = true,
                Description = "豆包大模型语音识别 - 异步模式 (submit+query)"
            }
        },
        new ExchangeTemplate
        {
            Id = "doubao-asr-stream",
            Name = "豆包流式语音识别 (WebSocket)",
            Description = "字节跳动豆包流式 ASR，通过 WebSocket 二进制协议实时推送音频分片，支持实时转录",
            ApiKeyPlaceholder = "AppID|AccessToken",
            ApiKeyHint = "格式：AppID|AccessToken，在火山引擎控制台获取",
            Preset = new ExchangeTemplatePreset
            {
                Name = "豆包 ASR (流式 WebSocket)",
                ModelAlias = "doubao-asr-stream",
                TargetUrl = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
                TargetAuthScheme = "DoubaoAsr",
                TransformerType = "doubao-asr-stream",
                TransformerConfig = new Dictionary<string, object>
                {
                    ["resourceId"] = "volc.bigasr.sauc.duration",
                    ["enableItn"] = true,
                    ["enablePunc"] = true,
                    ["enableDdc"] = true
                },
                Enabled = true,
                Description = "豆包流式语音识别 - WebSocket 二进制协议 (bigmodel_nostream)"
            }
        },
        new ExchangeTemplate
        {
            Id = "fal-image-gen",
            Name = "fal.ai 图片生成",
            Description = "fal.ai Nano Banana Pro 图片生成，支持文生图和图生图",
            ApiKeyPlaceholder = "fal.ai API Key",
            ApiKeyHint = "在 fal.ai 控制台获取 API Key",
            Preset = new ExchangeTemplatePreset
            {
                Name = "fal.ai Nano Banana Pro",
                ModelAlias = "fal-nano-banana-pro",
                TargetUrl = "https://fal.run/fal-ai/nano-banana-pro",
                TargetAuthScheme = "Key",
                TransformerType = "fal-image",
                Enabled = true,
                Description = "fal.ai 图片生成 - Nano Banana Pro"
            }
        }
    };
}

public class ExchangeTemplate
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string ApiKeyPlaceholder { get; set; } = "API Key";
    public string ApiKeyHint { get; set; } = string.Empty;
    public ExchangeTemplatePreset Preset { get; set; } = new();
}

public class ExchangeTemplatePreset
{
    public string Name { get; set; } = string.Empty;
    public string ModelAlias { get; set; } = string.Empty;
    public string TargetUrl { get; set; } = string.Empty;
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public Dictionary<string, object>? TransformerConfig { get; set; }
    public bool Enabled { get; set; } = true;
    public string? Description { get; set; }
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

public class ImportFromTemplateRequest
{
    /// <summary>模板 ID</summary>
    public string TemplateId { get; set; } = string.Empty;
    /// <summary>用户提供的 API Key</summary>
    public string ApiKey { get; set; } = string.Empty;
}
