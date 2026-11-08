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
using PrdAgent.Infrastructure.Security;
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
    private readonly ExchangeTransformerRegistry _transformerRegistry = new();

    /// <summary>
    /// 用于 JsonNode.ToJsonString() 的带缩进选项。必须继承自 JsonSerializerOptions.Default
    /// 以获得内置 TypeInfoResolver —— 否则序列化 JsonArray 的原始类型（string/int 等）
    /// 时会抛 "JsonSerializerOptions instance must specify a TypeInfoResolver setting" 异常。
    /// 项目启用了 AOT 友好的 source-gen 上下文 (AppJsonContext)，但 JsonNode 动态树无法被 source-gen，
    /// 必须回退到 Default 提供的内置转换器。
    /// </summary>
    private static readonly JsonSerializerOptions IndentedJsonOptions = new(JsonSerializerOptions.Default)
    {
        WriteIndented = true
    };

    public ExchangeController(MongoDbContext db, ILogger<ExchangeController> logger, IConfiguration config)
    {
        _db = db;
        _logger = logger;
        _config = config;
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

        var result = list.Select(BuildExchangeDto);

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 构造前端需要的 Exchange 视图对象：
    ///   - Models: 统一通过 GetEffectiveModels() 合成（新数据直接返回，旧数据从 ModelAlias 迁移）
    ///   - platformId: 每条 Exchange 使用自己的真实 Id 作为虚拟平台 ID（新模型池会用此 Id）
    ///   - platformName: 用户自定义的 Exchange Name，替代硬编码的 "模型中继 (Exchange)"
    ///   - legacyPlatformId: 继续暴露 "__exchange__"，前端需兼容旧模型池数据时用
    /// </summary>
    private object BuildExchangeDto(ModelExchange e)
    {
        var effectiveModels = e.GetEffectiveModels();
        return new
        {
            e.Id,
            e.Name,
            // 旧字段继续返回，供只读展示 / 老前端兼容
            e.ModelAlias,
            e.ModelAliases,
            // 新统一字段：模型列表
            models = effectiveModels.Select(m => new
            {
                m.ModelId,
                m.DisplayName,
                m.ModelType,
                m.Description,
                m.Enabled
            }).ToList(),
            e.TargetUrl,
            apiKeyMasked = ApiKeyCryptoKeyRing.Mask(e.TargetApiKeyEncrypted, _config),
            e.TargetAuthScheme,
            e.TransformerType,
            e.TransformerConfig,
            e.Enabled,
            e.Description,
            e.CreatedAt,
            e.UpdatedAt,
            // 虚拟平台标识：新数据用 Exchange 自身 Id，用户自定义的 Name 作为平台名
            platformId = e.Id,
            platformName = e.Name,
            platformKind = "exchange",
            isVirtualPlatform = true,
            // 兼容字段：旧模型池可能存了 __exchange__
            legacyPlatformId = ModelResolverConstants.ExchangePlatformId
        };
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

        return Ok(ApiResponse<object>.Ok(BuildExchangeDto(exchange)));
    }

    /// <summary>
    /// 创建 Exchange 配置。新接口主推 Models 列表；若只给 ModelAlias 也接受（按单模型处理）。
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateExchange([FromBody] CreateExchangeRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "Name 不能为空"));

        // Models 优先；若没给 Models 也要有 ModelAlias（单模型兼容）
        var normalizedModels = NormalizeExchangeModels(request.Models);
        if (normalizedModels.Count == 0 && string.IsNullOrWhiteSpace(request.ModelAlias))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                "必须至少提供一个模型（Models 列表）或 ModelAlias"));
        }

        // 校验 TransformerType
        if (!string.IsNullOrWhiteSpace(request.TransformerType) &&
            _transformerRegistry.Get(request.TransformerType) == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"未知的转换器类型: {request.TransformerType}"));
        }

        // Name 建议唯一（作为虚拟平台名，避免用户困惑），但不强校验以保持兼容
        var exchange = new ModelExchange
        {
            Name = request.Name.Trim(),
            ModelAlias = request.ModelAlias?.Trim() ?? string.Empty,
            ModelAliases = NormalizeModelAliases(request.ModelAliases),
            Models = normalizedModels,
            TargetUrl = request.TargetUrl.Trim(),
            TargetApiKeyEncrypted = ApiKeyCryptoKeyRing.Encrypt(request.TargetApiKey ?? string.Empty, _config),
            TargetAuthScheme = string.IsNullOrWhiteSpace(request.TargetAuthScheme) ? "Bearer" : request.TargetAuthScheme.Trim(),
            TransformerType = string.IsNullOrWhiteSpace(request.TransformerType) ? "passthrough" : request.TransformerType.Trim(),
            TransformerConfig = request.TransformerConfig,
            Enabled = request.Enabled,
            Description = request.Description?.Trim()
        };

        await _db.ModelExchanges.InsertOneAsync(exchange, cancellationToken: ct);

        _logger.LogInformation("[Exchange] 创建 Exchange: {Id} / {Name} / Models={ModelCount} / ModelAlias={ModelAlias}",
            exchange.Id, exchange.Name, exchange.Models.Count, exchange.ModelAlias);

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
            .Set(e => e.ModelAliases,
                request.ModelAliases != null ? NormalizeModelAliases(request.ModelAliases) : existing.ModelAliases)
            .Set(e => e.Models,
                request.Models != null ? NormalizeExchangeModels(request.Models) : existing.Models)
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
            update = update.Set(e => e.TargetApiKeyEncrypted, ApiKeyCryptoKeyRing.Encrypt(request.TargetApiKey, _config));
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
    /// 对于多模型 Exchange，Models 列表中每个启用的模型展开为一个可选项。
    /// 返回的 platformId 是该 Exchange 的真实 Id（每个中继是独立虚拟平台）。
    /// </summary>
    [HttpGet("for-pool")]
    public async Task<IActionResult> GetExchangesForPool(CancellationToken ct)
    {
        var filter = Builders<ModelExchange>.Filter.Eq(e => e.Enabled, true);
        var list = await _db.ModelExchanges
            .Find(filter)
            .SortBy(e => e.Name)
            .ToListAsync(ct);

        var result = new List<object>();
        foreach (var e in list)
        {
            foreach (var m in e.GetEffectiveModels().Where(m => m.Enabled))
            {
                result.Add(new
                {
                    modelId = m.ModelId,
                    platformId = e.Id, // 真实 Id，不再是 "__exchange__"
                    platformName = e.Name, // 用户自定义的平台名
                    displayName = string.IsNullOrWhiteSpace(m.DisplayName)
                        ? $"{e.Name} / {m.ModelId}"
                        : $"{e.Name} / {m.DisplayName}",
                    modelType = m.ModelType,
                    e.TransformerType,
                    platformKind = "exchange",
                    // 兼容：旧前端若按 __exchange__ 识别
                    legacyPlatformId = ModelResolverConstants.ExchangePlatformId
                });
            }
        }

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 一键体验指定模型：按 modelType 自动选一个合适的测试 prompt，走 Exchange 转换管线，
    /// 返回标准请求 / 转换请求 / 原始响应 / 转换响应的全套信息（复用 TestExchange 返回结构）。
    /// 不落 LlmRequestLogs（只是 smoke test）。
    /// </summary>
    [HttpPost("{id}/models/{modelId}/try-it")]
    public async Task<IActionResult> TryModel(string id, string modelId, [FromBody] TryModelRequest? request, CancellationToken ct)
    {
        var exchange = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (exchange == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        var effectiveModels = exchange.GetEffectiveModels();
        var target = effectiveModels.FirstOrDefault(m => m.ModelId == modelId && m.Enabled);
        if (target == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"模型 '{modelId}' 不存在或未启用"));

        // 按 modelType 选默认测试 prompt（允许用户覆盖）
        var userPrompt = request?.Prompt?.Trim();
        JsonObject standardBody = target.ModelType.ToLowerInvariant() switch
        {
            "generation" => new JsonObject
            {
                ["model"] = modelId,
                ["prompt"] = !string.IsNullOrEmpty(userPrompt) ? userPrompt : "A cute cat sitting on a wooden table",
                ["size"] = "1024x1024",
                ["n"] = 1
            },
            "asr" or "tts" => new JsonObject
            {
                ["model"] = modelId,
                ["text"] = !string.IsNullOrEmpty(userPrompt) ? userPrompt : "这是一段测试文本"
            },
            // chat / vision / 其它 → 走标准 messages 格式
            _ => new JsonObject
            {
                ["model"] = modelId,
                ["messages"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = !string.IsNullOrEmpty(userPrompt) ? userPrompt : "Hello, introduce yourself in one sentence."
                    }
                }
            }
        };

        // 复用 TestExchange 管线的内部逻辑：构造 ExchangeTestRequest 并调用
        var testReq = new ExchangeTestRequest
        {
            StandardRequestBody = standardBody.ToJsonString(),
            DryRun = request?.DryRun ?? false
        };
        return await TestExchange(id, testReq, ct);
    }

    /// <summary>
    /// 规范化 ModelAliases 输入：去空、trim、去重。
    /// </summary>
    private static List<string> NormalizeModelAliases(List<string>? input)
    {
        if (input == null || input.Count == 0) return new List<string>();
        return input
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// 规范化 Models 输入：ModelId 去空/trim、ModelType 默认 chat、按 ModelId 去重。
    /// </summary>
    private static List<ExchangeModel> NormalizeExchangeModels(List<ExchangeModelRequest>? input)
    {
        if (input == null || input.Count == 0) return new List<ExchangeModel>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<ExchangeModel>();
        foreach (var m in input)
        {
            if (m == null || string.IsNullOrWhiteSpace(m.ModelId)) continue;
            var modelId = m.ModelId.Trim();
            if (!seen.Add(modelId)) continue;
            result.Add(new ExchangeModel
            {
                ModelId = modelId,
                DisplayName = string.IsNullOrWhiteSpace(m.DisplayName) ? null : m.DisplayName!.Trim(),
                ModelType = string.IsNullOrWhiteSpace(m.ModelType) ? "chat" : m.ModelType!.Trim().ToLowerInvariant(),
                Description = string.IsNullOrWhiteSpace(m.Description) ? null : m.Description!.Trim(),
                Enabled = m.Enabled ?? true
            });
        }
        return result;
    }

    /// <summary>
    /// 测试 Exchange 转换管线：标准请求 → 转换后请求 → 发送 → 响应转换
    /// 返回三个阶段的数据供前端展示
    /// </summary>
    [HttpPost("{id}/test")]
    public async Task<IActionResult> TestExchange(string id, [FromBody] ExchangeTestRequest request, CancellationToken ct)
    {
        if (!request.DryRun)
            return StatusCode(StatusCodes.Status410Gone, ApiResponse<object>.Fail("MDS_WRITE_RETIRED",
                "模型测试入口已迁入模型网关，请从「模型网关」进入控制台执行测试。"));
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
                standardRequest = standardBody.ToJsonString(IndentedJsonOptions),
                transformedRequest = (string?)null,
                rawResponse = (string?)null,
                transformedResponse = (string?)null,
                error = $"请求转换失败: {ex.Message}",
                httpStatus = (int?)null,
                durationMs = (long?)null
            }));
        }

        var transformedJson = transformedRequest.ToJsonString(IndentedJsonOptions);

        // 只保留纯计算的转换预览，永不发送供应商请求。
        return Ok(ApiResponse<object>.Ok(new
        {
            standardRequest = standardBody.ToJsonString(IndentedJsonOptions),
            transformedRequest = transformedJson,
            rawResponse = (string?)null,
            transformedResponse = (string?)null,
            error = (string?)null,
            httpStatus = (int?)null,
            durationMs = (long?)null,
            isDryRun = true
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
    /// 测试 WebSocket 流式 ASR（SSE 逐帧推送，实时显示进度）
    /// 接收音频文件 → ffmpeg 转换 → WebSocket 二进制协议 → SSE 推送进度/帧/结果
    ///
    /// SSE 事件类型：
    /// - stage:    阶段变化（uploading / converting / connecting / sending / result / done / error）
    /// - progress: 发送进度（sent=5, total=28）
    /// - frame:    每帧识别结果（seq, text, isLast）
    /// - result:   最终汇总
    /// </summary>
    [HttpPost("{id}/test-stream-asr/sse")]
    [RequestSizeLimit(100 * 1024 * 1024)]
    public async Task TestStreamAsrSse(
        string id,
        [FromForm] IFormFile? file,
        [FromForm] string? audioUrl,
        CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");

        var jsonOpts = new JsonSerializerOptions(JsonSerializerOptions.Default)
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };
        async Task SendEvent(string eventType, object data)
        {
            var json = JsonSerializer.Serialize(data, jsonOpts);
            try
            {
                await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n", ct);
                await Response.Body.FlushAsync(ct);
            }
            catch (OperationCanceledException) { /* 客户端断开 */ }
        }

        try
        {
            // 查找 Exchange 配置
            var exchange = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
            if (exchange == null)
            {
                await SendEvent("error", new { error = "Exchange 不存在" });
                return;
            }

            if (exchange.TransformerType != "doubao-asr-stream")
            {
                await SendEvent("error", new { error = $"该 Exchange 类型为 {exchange.TransformerType}，不支持流式 ASR 测试" });
                return;
            }

            await SendEvent("error", new
            {
                error = "WebSocket 流式 ASR 直连测试已禁用：MAP 不再允许在 API 进程内直连豆包上游。该协议已迁入 LLM Gateway raw 路径，请通过业务 ASR 流程或 /gw/v1/raw 验证。",
                code = "LLMGW_ASR_STREAM_DIRECT_DISABLED",
                exchange = new { exchange.Id, exchange.Name, exchange.TransformerType }
            });
        }
        catch (Exception ex)
        {
            var requestId = HttpContext?.TraceIdentifier;
            _logger.LogError(
                ex,
                "[exchange] ASR SSE 测试异常中断: exchangeId={ExchangeId} requestId={RequestId}",
                id,
                requestId);

            await SendEvent("error", BuildSafeControllerErrorPayload(id, requestId));
        }
    }

    private static object BuildSafeControllerErrorPayload(string exchangeId, string? requestId)
    {
        return new
        {
            error = "测试过程异常中断，请检查 Exchange 配置或查看服务端日志。",
            errorCode = "exchange_sse_failed",
            exchangeId,
            requestId,
        };
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
                t.Preset.ModelAliases,
                models = t.Preset.Models?.Select(m => new
                {
                    m.ModelId,
                    m.DisplayName,
                    m.ModelType,
                    m.Description,
                    m.Enabled
                }),
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

        // 检查名称冲突（用户自定义平台名应该唯一可区分）
        var nameConflict = await _db.ModelExchanges
            .Find(e => e.Name == template.Preset.Name)
            .FirstOrDefaultAsync(ct);
        if (nameConflict != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"已存在同名中继 '{template.Preset.Name}'，该模板可能已导入。如需重复导入请先重命名或删除原有中继。"));

        var exchange = new ModelExchange
        {
            Name = template.Preset.Name,
            ModelAlias = template.Preset.ModelAlias,
            ModelAliases = NormalizeModelAliases(template.Preset.ModelAliases),
            Models = NormalizeExchangeModels(template.Preset.Models),
            TargetUrl = template.Preset.TargetUrl,
            TargetApiKeyEncrypted = ApiKeyCryptoKeyRing.Encrypt(request.ApiKey.Trim(), _config),
            TargetAuthScheme = template.Preset.TargetAuthScheme ?? "Bearer",
            TransformerType = template.Preset.TransformerType ?? "passthrough",
            TransformerConfig = template.Preset.TransformerConfig,
            Enabled = template.Preset.Enabled,
            Description = template.Preset.Description
        };

        await _db.ModelExchanges.InsertOneAsync(exchange, cancellationToken: ct);

        _logger.LogInformation("[Exchange] 通过模板导入 Exchange: {Id} / {Name} / template={TemplateId}",
            exchange.Id, exchange.Name, request.TemplateId);

        return Ok(ApiResponse<object>.Ok(new { exchange.Id, exchange.Name, modelCount = exchange.Models.Count }));
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
            Description = "字节跳动豆包流式 ASR，通过 WebSocket 二进制协议实时推送音频分片，支持实时转录，支持 x-api-key 单Key认证",
            ApiKeyPlaceholder = "x-api-key",
            ApiKeyHint = "在火山引擎控制台获取 API Key（UUID 格式），也支持 AppID|AccessToken 双Key格式",
            Preset = new ExchangeTemplatePreset
            {
                Name = "豆包 ASR (流式 WebSocket)",
                ModelAlias = "doubao-asr-stream",
                TargetUrl = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
                TargetAuthScheme = "XApiKey",
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
        },
        new ExchangeTemplate
        {
            Id = "fal-image-layered",
            Name = "fal.ai 图片语义分层",
            Description = "使用 Qwen-Image-Layered 将单张图片拆成可编辑 RGBA 图层",
            ApiKeyPlaceholder = "fal.ai API Key",
            ApiKeyHint = "在 fal.ai 控制台获取 API Key",
            Preset = new ExchangeTemplatePreset
            {
                Name = "fal.ai Qwen Image Layered",
                ModelAlias = "fal-qwen-image-layered",
                TargetUrl = "https://fal.run/fal-ai/qwen-image-layered",
                TargetAuthScheme = "Key",
                TransformerType = "fal-image-layered",
                Enabled = true,
                Description = "fal.ai 图片语义分层 - Qwen-Image-Layered"
            }
        },
        new ExchangeTemplate
        {
            Id = "volcengine-video",
            Name = "火山方舟 Seedance 视频生成",
            Description = "火山方舟原生视频生成 API，使用 /contents/generations/tasks 异步任务协议，适配 MAP 现有视频生成客户端。",
            ApiKeyPlaceholder = "Ark API Key",
            ApiKeyHint = "在火山方舟控制台获取 API Key，请求头使用 Authorization: Bearer",
            Preset = new ExchangeTemplatePreset
            {
                Name = "火山方舟 Seedance 视频生成",
                Models = new List<ExchangeModelRequest>
                {
                    new()
                    {
                        ModelId = "doubao-seedance-2-0-fast-260128",
                        DisplayName = "Doubao Seedance 2.0 Fast",
                        ModelType = "video-gen",
                        Enabled = true
                    },
                    new()
                    {
                        ModelId = "doubao-seedance-2-0-260128",
                        DisplayName = "Doubao Seedance 2.0",
                        ModelType = "video-gen",
                        Enabled = true
                    }
                },
                TargetUrl = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
                TargetAuthScheme = "Bearer",
                TransformerType = "volcengine-video",
                Enabled = true,
                Description = "火山方舟原生 Seedance 视频生成。submit 返回任务 ID，status 查询 content.video_url。"
            }
        },
        new ExchangeTemplate
        {
            Id = "gemini-native",
            Name = "Google Gemini 原生协议",
            Description = "Google Gemini Native API，一条中继承接多个 Gemini 模型。URL 模版中的 {model} 会在运行时替换为实际模型 ID，所以同一条中继可以同时挂接多个模型（文本对话 + 图像生成都能跑）。",
            ApiKeyPlaceholder = "Google API Key",
            ApiKeyHint = "在 https://aistudio.google.com/apikey 获取 API Key，请求头使用 x-goog-api-key",
            Preset = new ExchangeTemplatePreset
            {
                Name = "Google Gemini (原生)",
                // 新字段：直接给出结构化模型列表，显示名 + modelType 精准标注
                Models = new List<ExchangeModelRequest>
                {
                    new() { ModelId = "gemini-2.5-flash", DisplayName = "Gemini 2.5 Flash", ModelType = "chat", Enabled = true },
                    new() { ModelId = "gemini-2.5-pro", DisplayName = "Gemini 2.5 Pro", ModelType = "chat", Enabled = true },
                    new() { ModelId = "gemini-flash-latest", DisplayName = "Gemini Flash (Latest)", ModelType = "chat", Enabled = true },
                    new() { ModelId = "gemini-3.1-flash-image-preview", DisplayName = "Gemini 3.1 Flash Image", ModelType = "generation", Enabled = true },
                    new() { ModelId = "gemini-2.5-flash-image", DisplayName = "Gemini 2.5 Flash Image", ModelType = "generation", Enabled = true }
                },
                TargetUrl = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                TargetAuthScheme = "x-goog-api-key",
                TransformerType = "gemini-native",
                Enabled = true,
                Description = "Gemini 原生协议中继，一条虚拟平台承接多个模型。{model} 占位符在调度时被实际模型 ID 替换。"
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
    /// <summary>【旧字段】主模型别名（单模型场景）</summary>
    public string ModelAlias { get; set; } = string.Empty;
    /// <summary>【旧字段】附加别名列表</summary>
    public List<string>? ModelAliases { get; set; }
    /// <summary>【新字段】结构化模型列表（推荐）</summary>
    public List<ExchangeModelRequest>? Models { get; set; }
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
    /// <summary>虚拟平台名称，用户自定义（如 "我的 Gemini"）</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>【旧字段 · 兼容】主模型别名，仅在没给 Models 时使用</summary>
    public string? ModelAlias { get; set; }
    /// <summary>【旧字段 · 兼容】附加模型别名列表</summary>
    public List<string>? ModelAliases { get; set; }
    /// <summary>模型列表（新接口主推）</summary>
    public List<ExchangeModelRequest>? Models { get; set; }
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
    public List<string>? ModelAliases { get; set; }
    /// <summary>模型列表（新接口主推）</summary>
    public List<ExchangeModelRequest>? Models { get; set; }
    public string? TargetUrl { get; set; }
    public string? TargetApiKey { get; set; }
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public Dictionary<string, object>? TransformerConfig { get; set; }
    public bool? Enabled { get; set; }
    public string? Description { get; set; }
}

/// <summary>提交到后端的 ExchangeModel 条目</summary>
public class ExchangeModelRequest
{
    public string ModelId { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public string? ModelType { get; set; }
    public string? Description { get; set; }
    public bool? Enabled { get; set; }
}

/// <summary>一键体验请求体</summary>
public class TryModelRequest
{
    /// <summary>可选：覆盖默认测试 prompt</summary>
    public string? Prompt { get; set; }
    /// <summary>可选：只做请求转换预览，不真实调用上游</summary>
    public bool? DryRun { get; set; }
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

public class StreamAsrTestRequest
{
    /// <summary>音频文件 URL</summary>
    public string AudioUrl { get; set; } = string.Empty;
    /// <summary>API Key（单Key 或 AppID|AccessToken）</summary>
    public string ApiKey { get; set; } = string.Empty;
    /// <summary>WebSocket URL（可选，默认 bigmodel_nostream）</summary>
    public string? WsUrl { get; set; }
    /// <summary>Resource ID（可选）</summary>
    public string? ResourceId { get; set; }
}
