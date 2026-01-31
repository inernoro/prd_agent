using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway.Adapters;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// LLM Gateway 核心实现 - 所有大模型调用的守门员
/// </summary>
public class LlmGateway : ILlmGateway
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<LlmGateway> _logger;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly Dictionary<string, IGatewayAdapter> _adapters = new(StringComparer.OrdinalIgnoreCase);

    public LlmGateway(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<LlmGateway> logger,
        ILlmRequestLogWriter? logWriter = null)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
        _logWriter = logWriter;

        // 注册适配器
        RegisterAdapter(new OpenAIGatewayAdapter());
        RegisterAdapter(new ClaudeGatewayAdapter());
    }

    private void RegisterAdapter(IGatewayAdapter adapter)
    {
        _adapters[adapter.PlatformType] = adapter;
    }

    /// <inheritdoc />
    public async Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
    {
        var startedAt = DateTime.UtcNow;
        string? logId = null;

        try
        {
            // 1. 解析模型
            var resolution = await ResolveModelInternalAsync(
                request.AppCallerCode, request.ModelType, request.ExpectedModel, ct);

            if (string.IsNullOrWhiteSpace(resolution.ActualModel) ||
                string.IsNullOrWhiteSpace(resolution.ActualPlatformId))
            {
                return GatewayResponse.Fail("MODEL_NOT_FOUND", "未找到可用模型", 404);
            }

            // 2. 获取平台配置
            var platform = await GetPlatformAsync(resolution.ActualPlatformId, ct);
            if (platform == null)
            {
                return GatewayResponse.Fail("PLATFORM_NOT_FOUND", "平台配置不存在", 404);
            }

            // 3. 选择适配器
            var adapter = GetAdapter(platform.PlatformType);
            if (adapter == null)
            {
                return GatewayResponse.Fail("UNSUPPORTED_PLATFORM", $"不支持的平台类型: {platform.PlatformType}", 400);
            }

            // 4. 构建请求
            var requestBody = request.GetEffectiveRequestBody();
            requestBody["model"] = resolution.ActualModel;
            requestBody["stream"] = false;

            var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
            var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
                ? null
                : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);

            var endpoint = adapter.BuildEndpoint(platform.ApiUrl, request.ModelType);
            var httpRequest = adapter.BuildHttpRequest(endpoint, apiKey, requestBody, request.EnablePromptCache);

            // 5. 写入日志（开始）
            logId = await StartLogAsync(request, resolution, endpoint, requestBody, startedAt, ct);

            // 6. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway] 发送请求\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ExpectedModel: {ExpectedModel}\n" +
                "  ActualModel: {ActualModel}\n" +
                "  Platform: {Platform}\n" +
                "  Endpoint: {Endpoint}",
                request.AppCallerCode,
                request.ExpectedModel ?? "(无)",
                resolution.ActualModel,
                resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                endpoint);

            var response = await httpClient.SendAsync(httpRequest, ct);
            var responseBody = await response.Content.ReadAsStringAsync(ct);

            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;

            // 7. 解析响应
            GatewayTokenUsage? tokenUsage = null;
            if (response.IsSuccessStatusCode)
            {
                tokenUsage = adapter.ParseTokenUsage(responseBody);
            }

            // 8. 更新健康状态
            if (resolution.ModelGroupId != null)
            {
                if (response.IsSuccessStatusCode)
                {
                    await RecordSuccessAsync(resolution, ct);
                }
                else
                {
                    await RecordFailureAsync(resolution, ct);
                }
            }

            // 9. 写入日志（完成）
            await FinishLogAsync(logId, response, responseBody, tokenUsage, durationMs, ct);

            if (!response.IsSuccessStatusCode)
            {
                var errorMsg = TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}";
                return GatewayResponse.Fail("LLM_ERROR", errorMsg, (int)response.StatusCode);
            }

            return new GatewayResponse
            {
                Success = true,
                StatusCode = (int)response.StatusCode,
                Content = responseBody,
                Resolution = resolution,
                TokenUsage = tokenUsage,
                DurationMs = durationMs,
                LogId = logId
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[LlmGateway] 请求失败");
            if (logId != null)
            {
                _logWriter?.MarkError(logId, ex.Message);
            }
            return GatewayResponse.Fail("GATEWAY_ERROR", ex.Message);
        }
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
        GatewayRequest request,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var startedAt = DateTime.UtcNow;
        string? logId = null;
        DateTime? firstByteAt = null;
        var textBuilder = new StringBuilder();

        GatewayModelResolution? resolution = null;
        GatewayTokenUsage? tokenUsage = null;

        try
        {
            // 1. 解析模型
            resolution = await ResolveModelInternalAsync(
                request.AppCallerCode, request.ModelType, request.ExpectedModel, ct);

            if (string.IsNullOrWhiteSpace(resolution.ActualModel) ||
                string.IsNullOrWhiteSpace(resolution.ActualPlatformId))
            {
                yield return GatewayStreamChunk.Fail("未找到可用模型");
                yield break;
            }

            // 2. 获取平台配置
            var platform = await GetPlatformAsync(resolution.ActualPlatformId, ct);
            if (platform == null)
            {
                yield return GatewayStreamChunk.Fail("平台配置不存在");
                yield break;
            }

            // 3. 选择适配器
            var adapter = GetAdapter(platform.PlatformType);
            if (adapter == null)
            {
                yield return GatewayStreamChunk.Fail($"不支持的平台类型: {platform.PlatformType}");
                yield break;
            }

            // 4. 构建请求
            var requestBody = request.GetEffectiveRequestBody();
            requestBody["model"] = resolution.ActualModel;
            requestBody["stream"] = true;

            var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
            var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
                ? null
                : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);

            var endpoint = adapter.BuildEndpoint(platform.ApiUrl, request.ModelType);
            var httpRequest = adapter.BuildHttpRequest(endpoint, apiKey, requestBody, request.EnablePromptCache);

            // 5. 写入日志（开始）
            logId = await StartLogAsync(request, resolution, endpoint, requestBody, startedAt, ct);

            // 6. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway] 发送流式请求\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ExpectedModel: {ExpectedModel}\n" +
                "  ActualModel: {ActualModel}\n" +
                "  Platform: {Platform}",
                request.AppCallerCode,
                request.ExpectedModel ?? "(无)",
                resolution.ActualModel,
                resolution.ActualPlatformName ?? resolution.ActualPlatformId);

            using var response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);

            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync(ct);
                var errorMsg = TryExtractErrorMessage(errorBody) ?? $"HTTP {(int)response.StatusCode}";
                yield return GatewayStreamChunk.Fail(errorMsg);

                if (resolution.ModelGroupId != null)
                {
                    await RecordFailureAsync(resolution, ct);
                }
                yield break;
            }

            // 发送开始块（包含调度信息）
            yield return GatewayStreamChunk.Start(resolution);

            // 7. 读取流式响应
            using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream);

            string? finishReason = null;

            while (!reader.EndOfStream)
            {
                var line = await reader.ReadLineAsync(ct);
                if (string.IsNullOrEmpty(line)) continue;

                if (!line.StartsWith("data:")) continue;
                var data = line.Substring(5).Trim();

                if (data == "[DONE]")
                {
                    break;
                }

                // 标记首字节
                if (firstByteAt == null)
                {
                    firstByteAt = DateTime.UtcNow;
                    _logWriter?.MarkFirstByte(logId, firstByteAt.Value);
                }

                // 解析 SSE 数据
                var chunk = adapter.ParseStreamChunk(data);
                if (chunk == null) continue;

                if (!string.IsNullOrEmpty(chunk.Content))
                {
                    textBuilder.Append(chunk.Content);
                    yield return chunk;
                }

                if (!string.IsNullOrEmpty(chunk.FinishReason))
                {
                    finishReason = chunk.FinishReason;
                }

                if (chunk.TokenUsage != null)
                {
                    tokenUsage = chunk.TokenUsage;
                }
            }

            // 8. 更新健康状态（成功）
            if (resolution.ModelGroupId != null)
            {
                await RecordSuccessAsync(resolution, ct);
            }

            // 9. 发送完成块
            yield return GatewayStreamChunk.Done(finishReason, tokenUsage);

            // 10. 写入日志（完成）
            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;
            var assembledText = textBuilder.ToString();

            await FinishStreamLogAsync(logId, assembledText, tokenUsage, durationMs, ct);
        }
        finally
        {
            // 确保日志在异常情况下也能关闭
        }
    }

    /// <inheritdoc />
    public async Task<ImageGenGatewayResponse> GenerateImageAsync(
        ImageGenGatewayRequest request,
        CancellationToken ct = default)
    {
        // TODO: 实现图片生成
        // 当前先返回未实现错误，后续迁移 OpenAIImageClient 逻辑
        throw new NotImplementedException("图片生成功能正在迁移中");
    }

    /// <inheritdoc />
    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        return await ResolveModelInternalAsync(appCallerCode, modelType, expectedModel, ct);
    }

    /// <inheritdoc />
    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        var result = new List<AvailableModelPool>();

        // 1. 查找专属模型池
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == appCallerCode)
            .FirstOrDefaultAsync(ct);

        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (requirement?.ModelGroupIds?.Count > 0)
            {
                var dedicatedGroups = await _db.ModelGroups
                    .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                    .SortBy(g => g.Priority)
                    .ToListAsync(ct);

                foreach (var group in dedicatedGroups)
                {
                    result.Add(await MapToAvailablePoolAsync(group, "DedicatedPool", true, false, ct));
                }

                if (result.Count > 0)
                    return result; // 有专属池就不返回默认池
            }
        }

        // 2. 查找默认模型池
        var defaultGroups = await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .SortBy(g => g.Priority)
            .ToListAsync(ct);

        foreach (var group in defaultGroups)
        {
            result.Add(await MapToAvailablePoolAsync(group, "DefaultPool", false, true, ct));
        }

        return result;
    }

    #region Private Methods

    private async Task<GatewayModelResolution> ResolveModelInternalAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel,
        CancellationToken ct)
    {
        // 1. 查找 AppCaller 绑定的专属模型池
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == appCallerCode)
            .FirstOrDefaultAsync(ct);

        List<ModelGroup>? candidateGroups = null;
        string resolutionType = "Unknown";

        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (requirement?.ModelGroupIds?.Count > 0)
            {
                candidateGroups = await _db.ModelGroups
                    .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                    .SortBy(g => g.Priority)
                    .ToListAsync(ct);

                if (candidateGroups.Count > 0)
                {
                    resolutionType = "DedicatedPool";
                }
            }
        }

        // 2. 回退到默认模型池
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            candidateGroups = await _db.ModelGroups
                .Find(g => g.ModelType == modelType && g.IsDefaultForType)
                .SortBy(g => g.Priority)
                .ToListAsync(ct);

            if (candidateGroups.Count > 0)
            {
                resolutionType = "DefaultPool";
            }
        }

        // 3. 回退到传统配置（IsMain, IsImageGen 等）
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            var legacyModel = await FindLegacyModelAsync(modelType, ct);
            if (legacyModel != null)
            {
                var platform = await _db.LLMPlatforms
                    .Find(p => p.Id == legacyModel.PlatformId)
                    .FirstOrDefaultAsync(ct);

                return new GatewayModelResolution
                {
                    ResolutionType = "Legacy",
                    ExpectedModel = expectedModel,
                    ActualModel = legacyModel.ModelName,
                    ActualPlatformId = legacyModel.PlatformId ?? string.Empty,
                    ActualPlatformName = platform?.Name
                };
            }
        }

        // 4. 无可用模型
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            _logger.LogWarning(
                "[LlmGateway] 未找到可用模型\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ModelType: {ModelType}",
                appCallerCode, modelType);

            return new GatewayModelResolution
            {
                ResolutionType = "NotFound",
                ExpectedModel = expectedModel
            };
        }

        // 5. 从模型池中选择最佳模型（考虑健康状态）
        var selectedGroup = candidateGroups[0];
        var selectedModel = SelectBestModel(selectedGroup);

        if (selectedModel == null)
        {
            return new GatewayModelResolution
            {
                ResolutionType = resolutionType,
                ExpectedModel = expectedModel,
                ModelGroupId = selectedGroup.Id,
                ModelGroupName = selectedGroup.Name,
                ModelGroupCode = selectedGroup.Code
            };
        }

        var selectedPlatform = await _db.LLMPlatforms
            .Find(p => p.Id == selectedModel.PlatformId)
            .FirstOrDefaultAsync(ct);

        _logger.LogInformation(
            "[LlmGateway] 模型调度完成\n" +
            "  AppCallerCode: {AppCallerCode}\n" +
            "  ModelType: {ModelType}\n" +
            "  ResolutionType: {ResolutionType}\n" +
            "  ModelGroupName: {GroupName}\n" +
            "  ExpectedModel: {Expected}\n" +
            "  ActualModel: {Actual}\n" +
            "  Platform: {Platform}",
            appCallerCode, modelType, resolutionType,
            selectedGroup.Name,
            expectedModel ?? "(无)",
            selectedModel.ModelId,
            selectedPlatform?.Name ?? selectedModel.PlatformId);

        return new GatewayModelResolution
        {
            ResolutionType = resolutionType,
            ExpectedModel = expectedModel,
            ActualModel = selectedModel.ModelId,
            ActualPlatformId = selectedModel.PlatformId,
            ActualPlatformName = selectedPlatform?.Name,
            ModelGroupId = selectedGroup.Id,
            ModelGroupName = selectedGroup.Name,
            ModelGroupCode = selectedGroup.Code,
            ModelPriority = selectedModel.Priority,
            HealthStatus = selectedModel.HealthStatus.ToString()
        };
    }

    private ModelGroupItem? SelectBestModel(ModelGroup group)
    {
        if (group.Models == null || group.Models.Count == 0)
            return null;

        // 优先选择健康的模型，按优先级排序
        var healthy = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Healthy)
            .OrderBy(m => m.Priority)
            .FirstOrDefault();

        if (healthy != null)
            return healthy;

        // 其次选择降权的模型
        var degraded = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Degraded)
            .OrderBy(m => m.Priority)
            .FirstOrDefault();

        if (degraded != null)
            return degraded;

        // 最后选择任意可用模型
        return group.Models
            .Where(m => m.HealthStatus != ModelHealthStatus.Unavailable)
            .OrderBy(m => m.Priority)
            .FirstOrDefault();
    }

    private async Task<LLMModel?> FindLegacyModelAsync(string modelType, CancellationToken ct)
    {
        return modelType.ToLowerInvariant() switch
        {
            "chat" => await _db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefaultAsync(ct),
            "intent" => await _db.LLMModels.Find(m => m.IsIntent && m.Enabled).FirstOrDefaultAsync(ct),
            "vision" => await _db.LLMModels.Find(m => m.IsVision && m.Enabled).FirstOrDefaultAsync(ct),
            "generation" => await _db.LLMModels.Find(m => m.IsImageGen && m.Enabled).FirstOrDefaultAsync(ct),
            _ => null
        };
    }

    private async Task<LLMPlatform?> GetPlatformAsync(string platformId, CancellationToken ct)
    {
        return await _db.LLMPlatforms
            .Find(p => p.Id == platformId && p.Enabled)
            .FirstOrDefaultAsync(ct);
    }

    private IGatewayAdapter? GetAdapter(string? platformType)
    {
        if (string.IsNullOrWhiteSpace(platformType))
            return _adapters.GetValueOrDefault("openai"); // 默认 OpenAI

        if (_adapters.TryGetValue(platformType, out var adapter))
            return adapter;

        // OpenAI 兼容
        return _adapters.GetValueOrDefault("openai");
    }

    private async Task<AvailableModelPool> MapToAvailablePoolAsync(
        ModelGroup group,
        string resolutionType,
        bool isDedicated,
        bool isDefault,
        CancellationToken ct)
    {
        var models = new List<PoolModelInfo>();

        foreach (var model in group.Models ?? new List<ModelGroupItem>())
        {
            var platform = await _db.LLMPlatforms
                .Find(p => p.Id == model.PlatformId)
                .FirstOrDefaultAsync(ct);

            models.Add(new PoolModelInfo
            {
                ModelId = model.ModelId,
                PlatformId = model.PlatformId,
                PlatformName = platform?.Name,
                Priority = model.Priority,
                HealthStatus = model.HealthStatus.ToString(),
                HealthScore = CalculateHealthScore(model)
            });
        }

        return new AvailableModelPool
        {
            Id = group.Id,
            Name = group.Name,
            Code = group.Code,
            Priority = group.Priority,
            ResolutionType = resolutionType,
            IsDedicated = isDedicated,
            IsDefault = isDefault,
            Models = models
        };
    }

    private static int CalculateHealthScore(ModelGroupItem model)
    {
        return model.HealthStatus switch
        {
            ModelHealthStatus.Healthy => 100 - Math.Min(model.ConsecutiveFailures * 5, 20),
            ModelHealthStatus.Degraded => 50 - Math.Min(model.ConsecutiveFailures * 10, 40),
            ModelHealthStatus.Unavailable => 0,
            _ => 50
        };
    }

    private async Task RecordSuccessAsync(GatewayModelResolution resolution, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            return;

        try
        {
            var filter = Builders<ModelGroup>.Filter.And(
                Builders<ModelGroup>.Filter.Eq(g => g.Id, resolution.ModelGroupId),
                Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                    m => m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel));

            var update = Builders<ModelGroup>.Update
                .Inc("Models.$.ConsecutiveSuccesses", 1)
                .Set("Models.$.ConsecutiveFailures", 0)
                .Set("Models.$.HealthStatus", ModelHealthStatus.Healthy)
                .Set("Models.$.LastSuccessAt", DateTime.UtcNow);

            await _db.ModelGroups.UpdateOneAsync(filter, update, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 记录成功状态失败");
        }
    }

    private async Task RecordFailureAsync(GatewayModelResolution resolution, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            return;

        try
        {
            // 先获取当前失败次数
            var group = await _db.ModelGroups
                .Find(g => g.Id == resolution.ModelGroupId)
                .FirstOrDefaultAsync(ct);

            var model = group?.Models?.FirstOrDefault(m =>
                m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);

            if (model == null) return;

            var newFailures = model.ConsecutiveFailures + 1;
            var newStatus = newFailures >= 5 ? ModelHealthStatus.Unavailable :
                            newFailures >= 3 ? ModelHealthStatus.Degraded :
                            ModelHealthStatus.Healthy;

            var filter = Builders<ModelGroup>.Filter.And(
                Builders<ModelGroup>.Filter.Eq(g => g.Id, resolution.ModelGroupId),
                Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                    m => m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel));

            var update = Builders<ModelGroup>.Update
                .Inc("Models.$.ConsecutiveFailures", 1)
                .Set("Models.$.ConsecutiveSuccesses", 0)
                .Set("Models.$.HealthStatus", newStatus)
                .Set("Models.$.LastFailedAt", DateTime.UtcNow);

            await _db.ModelGroups.UpdateOneAsync(filter, update, cancellationToken: ct);

            _logger.LogWarning(
                "[LlmGateway] 模型失败计数: {Model} -> {Failures}次, 状态: {Status}",
                resolution.ActualModel, newFailures, newStatus);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 记录失败状态失败");
        }
    }

    private async Task<string?> StartLogAsync(
        GatewayRequest request,
        GatewayModelResolution resolution,
        string endpoint,
        JsonObject requestBody,
        DateTime startedAt,
        CancellationToken ct)
    {
        if (_logWriter == null) return null;

        try
        {
            var requestJson = requestBody.ToJsonString();
            var redactedJson = LlmLogRedactor.RedactJson(requestJson);

            return await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: request.Context?.RequestId ?? Guid.NewGuid().ToString("N"),
                    Provider: resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                    Model: resolution.ActualModel,
                    ApiBase: new Uri(endpoint).GetLeftPart(UriPartial.Authority),
                    Path: new Uri(endpoint).AbsolutePath.TrimStart('/'),
                    HttpMethod: "POST",
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json"
                    },
                    RequestBodyRedacted: redactedJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(redactedJson),
                    QuestionText: request.Context?.QuestionText,
                    SystemPromptChars: request.Context?.SystemPromptChars,
                    SystemPromptHash: null,
                    SystemPromptText: request.Context?.SystemPromptText,
                    MessageCount: null,
                    GroupId: request.Context?.GroupId,
                    SessionId: request.Context?.SessionId,
                    UserId: request.Context?.UserId,
                    ViewRole: request.Context?.ViewRole,
                    DocumentChars: request.Context?.DocumentChars,
                    DocumentHash: request.Context?.DocumentHash,
                    UserPromptChars: request.Context?.QuestionText?.Length,
                    StartedAt: startedAt,
                    RequestType: request.ModelType,
                    RequestPurpose: request.AppCallerCode,
                    PlatformId: resolution.ActualPlatformId,
                    PlatformName: resolution.ActualPlatformName,
                    ModelResolutionType: resolution.ResolutionType,
                    ModelGroupId: resolution.ModelGroupId,
                    ModelGroupName: resolution.ModelGroupName),
                ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 写入日志失败");
            return null;
        }
    }

    private async Task FinishLogAsync(
        string? logId,
        HttpResponseMessage response,
        string responseBody,
        GatewayTokenUsage? tokenUsage,
        long durationMs,
        CancellationToken ct)
    {
        if (_logWriter == null || logId == null) return;

        try
        {
            var status = response.IsSuccessStatusCode ? "succeeded" : "failed";
            var answerText = responseBody.Length > 10000
                ? responseBody.Substring(0, 10000) + "...[truncated]"
                : responseBody;

            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: (int)response.StatusCode,
                    ResponseHeaders: new Dictionary<string, string>
                    {
                        ["content-type"] = response.Content.Headers.ContentType?.ToString() ?? "application/json"
                    },
                    InputTokens: tokenUsage?.InputTokens,
                    OutputTokens: tokenUsage?.OutputTokens,
                    CacheCreationInputTokens: tokenUsage?.CacheCreationInputTokens,
                    CacheReadInputTokens: tokenUsage?.CacheReadInputTokens,
                    TokenUsageSource: tokenUsage?.Source ?? "missing",
                    ImageSuccessCount: null,
                    AnswerText: answerText,
                    AssembledTextChars: responseBody.Length,
                    AssembledTextHash: LlmLogRedactor.Sha256Hex(responseBody),
                    Status: status,
                    EndedAt: DateTime.UtcNow,
                    DurationMs: durationMs));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成日志失败");
        }
    }

    private async Task FinishStreamLogAsync(
        string? logId,
        string assembledText,
        GatewayTokenUsage? tokenUsage,
        long durationMs,
        CancellationToken ct)
    {
        if (_logWriter == null || logId == null) return;

        try
        {
            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: 200,
                    ResponseHeaders: new Dictionary<string, string>
                    {
                        ["content-type"] = "text/event-stream"
                    },
                    InputTokens: tokenUsage?.InputTokens,
                    OutputTokens: tokenUsage?.OutputTokens,
                    CacheCreationInputTokens: tokenUsage?.CacheCreationInputTokens,
                    CacheReadInputTokens: tokenUsage?.CacheReadInputTokens,
                    TokenUsageSource: tokenUsage?.Source ?? "missing",
                    ImageSuccessCount: null,
                    AnswerText: assembledText.Length > 5000 ? assembledText.Substring(0, 5000) + "..." : assembledText,
                    AssembledTextChars: assembledText.Length,
                    AssembledTextHash: LlmLogRedactor.Sha256Hex(assembledText),
                    Status: "succeeded",
                    EndedAt: DateTime.UtcNow,
                    DurationMs: durationMs));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成流式日志失败");
        }
    }

    private static string? TryExtractErrorMessage(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            if (doc.RootElement.TryGetProperty("error", out var error))
            {
                if (error.TryGetProperty("message", out var msg))
                    return msg.GetString();
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    #endregion
}
