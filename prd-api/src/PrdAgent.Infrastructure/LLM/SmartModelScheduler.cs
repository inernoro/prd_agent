using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 智能模型调度器 - 负责根据应用需求选择最佳模型并处理降权恢复
/// </summary>
public class SmartModelScheduler : ISmartModelScheduler
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILlmRequestLogWriter _logWriter;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly ILogger<ClaudeClient> _claudeLogger;
    private readonly ILogger<SmartModelScheduler> _logger;

    public SmartModelScheduler(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILlmRequestLogWriter logWriter,
        ILLMRequestContextAccessor ctxAccessor,
        ILogger<ClaudeClient> claudeLogger,
        ILogger<SmartModelScheduler> logger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logWriter = logWriter;
        _ctxAccessor = ctxAccessor;
        _claudeLogger = claudeLogger;
        _logger = logger;
    }

    public async Task<ILLMClient> GetClientAsync(string appCallerCode, string modelType, CancellationToken ct = default)
    {
        var result = await GetClientWithGroupInfoAsync(appCallerCode, modelType, ct);
        return result.Client;
    }

    public async Task<ScheduledClientResult> GetClientWithGroupInfoAsync(string appCallerCode, string modelType, CancellationToken ct = default)
    {
        return await GetClientWithGroupInfoAsync(appCallerCode, modelType, expectedModelCode: null, ct);
    }

    /// <summary>
    /// 获取 LLM 客户端（支持指定期望的模型 Code）
    /// </summary>
    /// <param name="appCallerCode">应用调用者标识</param>
    /// <param name="modelType">模型类型</param>
    /// <param name="expectedModelCode">期望的模型 Code（用于匹配模型池）</param>
    /// <param name="ct">取消令牌</param>
    public async Task<ILLMClient> GetClientAsync(string appCallerCode, string modelType, string? expectedModelCode, CancellationToken ct = default)
    {
        var result = await GetClientWithGroupInfoAsync(appCallerCode, modelType, expectedModelCode, ct);
        return result.Client;
    }

    /// <summary>
    /// 获取 LLM 客户端及模型池信息（支持指定期望的模型 Code）
    /// </summary>
    public async Task<ScheduledClientResult> GetClientWithGroupInfoAsync(string appCallerCode, string modelType, string? expectedModelCode, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(appCallerCode))
        {
            throw new ArgumentException("必须提供应用标识 appCallerCode", nameof(appCallerCode));
        }

        if (string.IsNullOrEmpty(modelType))
        {
            throw new ArgumentException("必须提供模型类型 modelType", nameof(modelType));
        }

        // 获取或创建应用调用者
        var app = await GetOrCreateAppCallerAsync(appCallerCode, ct);

        // 查找该应用对该类型模型的需求
        var requirement = app.ModelRequirements.FirstOrDefault(r => r.ModelType == modelType);

        // 如果应用没有配置该类型的需求，自动添加并使用默认分组
        if (requirement == null)
        {
            requirement = await AddDefaultRequirementAsync(app, modelType, ct);
        }

        // 获取绑定的模型分组（支持多模型池）
        var group = await GetModelGroupFromRequirementAsync(requirement, modelType, expectedModelCode, ct);

        if (group == null || group.Models.Count == 0)
        {
            throw new InvalidOperationException($"未找到可用的模型分组（appCallerCode: {appCallerCode}, 类型: {modelType}）");
        }

        // 从分组中选择最佳模型
        var bestModel = SelectBestModelFromGroup(group);

        if (bestModel == null)
        {
            throw new InvalidOperationException($"分组中没有可用的模型（appCallerCode: {appCallerCode}, 类型: {modelType}, 分组: {group.Name}）");
        }

        // 检查测试桩配置（用于故障模拟）
        await CheckTestStubAsync(bestModel, group.Id, ct);

        // 创建客户端
        var client = await CreateClientForModelAsync(bestModel, group.Id, ct);

        // 返回客户端及模型池信息
        return new ScheduledClientResult(
            Client: client,
            ModelGroupId: group.Id,
            ModelGroupName: group.Name,
            IsDefaultModelGroup: group.IsDefaultForType);
    }

    public async Task<LLMAppCaller> GetOrCreateAppCallerAsync(string appCallerCode, CancellationToken ct = default)
    {
        var existing = await _db.LLMAppCallers.Find(a => a.AppCode == appCallerCode).FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            return existing;
        }

        // 自动注册新应用
        var newApp = new LLMAppCaller
        {
            Id = Guid.NewGuid().ToString("N"),
            AppCode = appCallerCode,
            DisplayName = appCallerCode, // 默认使用 code 作为显示名称
            Description = "自动注册",
            IsAutoRegistered = true,
            ModelRequirements = new List<AppModelRequirement>(),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.LLMAppCallers.InsertOneAsync(newApp, cancellationToken: ct);

        _logger.LogInformation("自动注册应用: {AppCode}", appCallerCode);

        return newApp;
    }

    public async Task RecordCallResultAsync(
        string groupId,
        string modelId,
        string platformId,
        bool success,
        string? error = null,
        CancellationToken ct = default)
    {
        var config = await GetConfigAsync(ct);

        var group = await _db.ModelGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync(ct);
        if (group == null) return;

        var modelItem = group.Models.FirstOrDefault(m => m.ModelId == modelId && m.PlatformId == platformId);
        if (modelItem == null) return;

        if (success)
        {
            // 成功调用
            modelItem.LastSuccessAt = DateTime.UtcNow;
            modelItem.ConsecutiveSuccesses++;
            modelItem.ConsecutiveFailures = 0; // 重置失败计数

            // 恢复逻辑
            if (config.AutoRecoveryEnabled &&
                modelItem.HealthStatus != ModelHealthStatus.Healthy &&
                modelItem.ConsecutiveSuccesses >= config.RecoverySuccessThreshold)
            {
                _logger.LogInformation(
                    "模型恢复健康: {ModelId} (连续成功{Count}次)",
                    modelId,
                    modelItem.ConsecutiveSuccesses);

                modelItem.HealthStatus = ModelHealthStatus.Healthy;
                modelItem.ConsecutiveSuccesses = 0;
            }
        }
        else
        {
            // 失败调用
            modelItem.LastFailedAt = DateTime.UtcNow;
            modelItem.ConsecutiveFailures++;
            modelItem.ConsecutiveSuccesses = 0; // 重置成功计数

            // 降权逻辑
            if (modelItem.ConsecutiveFailures >= config.ConsecutiveFailuresToUnavailable)
            {
                _logger.LogWarning(
                    "模型标记为不可用: {ModelId} (连续失败{Count}次)",
                    modelId,
                    modelItem.ConsecutiveFailures);

                modelItem.HealthStatus = ModelHealthStatus.Unavailable;
            }
            else if (modelItem.ConsecutiveFailures >= config.ConsecutiveFailuresToDegrade)
            {
                _logger.LogWarning(
                    "模型标记为降权: {ModelId} (连续失败{Count}次)",
                    modelId,
                    modelItem.ConsecutiveFailures);

                modelItem.HealthStatus = ModelHealthStatus.Degraded;
            }
        }

        // 更新分组
        group.UpdatedAt = DateTime.UtcNow;
        await _db.ModelGroups.ReplaceOneAsync(g => g.Id == groupId, group, cancellationToken: ct);
    }

    public async Task HealthCheckAsync(CancellationToken ct = default)
    {
        var config = await GetConfigAsync(ct);

        if (!config.AutoRecoveryEnabled)
        {
            return;
        }

        var groups = await _db.ModelGroups.Find(_ => true).ToListAsync(ct);

        foreach (var group in groups)
        {
            var unavailableModels = group.Models
                .Where(m => m.HealthStatus == ModelHealthStatus.Unavailable)
                .ToList();

            foreach (var modelItem in unavailableModels)
            {
                try
                {
                    _logger.LogInformation("健康检查: {ModelId}", modelItem.ModelId);

                    var ok = await CheckModelsEndpointAsync(modelItem, group.Id, config, ct);
                    if (ok)
                    {
                        // 探测成功，记录成功结果（会触发恢复逻辑）
                        await RecordCallResultAsync(group.Id, modelItem.ModelId, modelItem.PlatformId, true, null, ct);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "健康检查异常: {ModelId}", modelItem.ModelId);
                }
            }
        }
    }

    private async Task<bool> CheckModelsEndpointAsync(
        ModelGroupItem modelItem,
        string groupId,
        ModelSchedulerConfig config,
        CancellationToken ct)
    {
        // 直接通过 platformId 查询平台信息，不依赖 LLMModels 表
        if (string.IsNullOrEmpty(modelItem.PlatformId))
        {
            _logger.LogWarning("健康检查失败，模型配置缺少平台ID: {ModelId}", modelItem.ModelId);
            return false;
        }

        var platform = await _db.LLMPlatforms.Find(p => p.Id == modelItem.PlatformId).FirstOrDefaultAsync(ct);
        if (platform == null)
        {
            _logger.LogWarning("健康检查失败，平台不存在: platformId={PlatformId}, modelId={ModelId}", modelItem.PlatformId, modelItem.ModelId);
            return false;
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        var apiUrl = platform.ApiUrl;
        var apiKey = ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
        var platformType = platform.PlatformType?.ToLowerInvariant();
        var platformId = platform.Id;
        var platformName = platform.Name;

        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            _logger.LogWarning("健康检查失败，平台 API 配置不完整: platformId={PlatformId}, modelId={ModelId}", modelItem.PlatformId, modelItem.ModelId);
            return false;
        }

        var endpoint = OpenAICompatUrl.BuildEndpoint(apiUrl, "models");
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            _logger.LogWarning("健康检查失败，无效 models 接口: {ModelId}", modelItem.ModelId);
            return false;
        }

        using var client = _httpClientFactory.CreateClient("LoggedHttpClient");
        client.Timeout = TimeSpan.FromSeconds(Math.Max(1, config.HealthCheckTimeoutSeconds));

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
            client.DefaultRequestHeaders.Remove("Authorization");
            client.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");
        }

        var requestId = Guid.NewGuid().ToString("N");
        var startedAt = DateTime.UtcNow;
        var (apiBase, path) = OpenAICompatUrl.SplitApiBaseAndPath(endpoint, client.BaseAddress);
        var headers = new Dictionary<string, string>
        {
            ["content-type"] = "application/json"
        };
        // 部分脱敏，保留前后4字符便于调试
        if (isAnthropic)
        {
            headers["x-api-key"] = LlmLogRedactor.RedactApiKey(apiKey);
            headers["anthropic-version"] = "2023-06-01";
        }
        else
        {
            headers["Authorization"] = $"Bearer {LlmLogRedactor.RedactApiKey(apiKey)}";
        }

        var logId = await _logWriter.StartAsync(new LlmLogStart(
            RequestId: requestId,
            Provider: platformType ?? "unknown",
            Model: "(models)",
            ApiBase: apiBase,
            Path: path,
            HttpMethod: "GET",
            RequestHeadersRedacted: headers,
            RequestBodyRedacted: "",
            RequestBodyHash: null,
            QuestionText: null,
            SystemPromptChars: null,
            SystemPromptHash: null,
            SystemPromptText: null,
            MessageCount: null,
            GroupId: groupId,
            SessionId: null,
            UserId: null,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            UserPromptChars: null,
            StartedAt: startedAt,
            RequestType: "health-check",
            RequestPurpose: "model-health-check",
            PlatformId: platformId,
            PlatformName: platformName), ct);

        try
        {
            using var response = await client.GetAsync(endpoint, ct);
            if (!string.IsNullOrWhiteSpace(logId))
            {
                _logWriter.MarkFirstByte(logId!, DateTime.UtcNow);
            }

            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                if (!string.IsNullOrWhiteSpace(logId))
                {
                    _logWriter.MarkError(
                        logId!,
                        $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}\n{body}",
                        (int)response.StatusCode);
                }
                return false;
            }

            if (!string.IsNullOrWhiteSpace(logId))
            {
                var endedAt = DateTime.UtcNow;
                _logWriter.MarkDone(logId!, new LlmLogDone(
                    StatusCode: (int)response.StatusCode,
                    ResponseHeaders: ToHeaderDictionary(response),
                    InputTokens: null,
                    OutputTokens: null,
                    CacheCreationInputTokens: null,
                    CacheReadInputTokens: null,
                    TokenUsageSource: "missing",
                    ImageSuccessCount: null,
                    AnswerText: null,
                    AssembledTextChars: 0,
                    AssembledTextHash: null,
                    Status: "succeeded",
                    EndedAt: endedAt,
                    DurationMs: (long)Math.Max(0, (endedAt - startedAt).TotalMilliseconds)));
            }

            return true;
        }
        catch (Exception ex)
        {
            if (!string.IsNullOrWhiteSpace(logId))
            {
                _logWriter.MarkError(logId!, ex.Message);
            }
            _logger.LogWarning(ex, "健康检查 /models 异常: {ModelId}", modelItem.ModelId);
            return false;
        }
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

    private async Task<AppModelRequirement> AddDefaultRequirementAsync(
        LLMAppCaller app,
        string modelType,
        CancellationToken ct)
    {
        // 查找该类型的默认分组
        var defaultGroup = await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .FirstOrDefaultAsync(ct);

        var requirement = new AppModelRequirement
        {
            ModelType = modelType,
            Purpose = $"使用{modelType}类型模型",
            ModelGroupIds = defaultGroup != null ? new List<string> { defaultGroup.Id } : new List<string>(),
            IsRequired = true
        };

        app.ModelRequirements.Add(requirement);
        app.UpdatedAt = DateTime.UtcNow;

        await _db.LLMAppCallers.ReplaceOneAsync(a => a.Id == app.Id, app, cancellationToken: ct);

        _logger.LogInformation("为应用 {AppCode} 添加模型类型需求: {ModelType}", app.AppCode, modelType);

        return requirement;
    }

    /// <summary>
    /// 从应用需求中获取模型分组（支持多模型池选择）
    /// </summary>
    private async Task<ModelGroup?> GetModelGroupFromRequirementAsync(
        AppModelRequirement requirement,
        string modelType,
        string? expectedModelCode,
        CancellationToken ct)
    {
        // 1. 如果指定了期望的模型 Code，优先按 Code 查找
        if (!string.IsNullOrEmpty(expectedModelCode))
        {
            var groupByCode = await GetModelGroupByCodeAsync(expectedModelCode, modelType, ct);
            if (groupByCode != null)
            {
                _logger.LogDebug("使用期望的模型 Code: {Code}, 分组: {GroupId}", expectedModelCode, groupByCode.Id);
                return groupByCode;
            }
            _logger.LogWarning("未找到期望的模型 Code: {Code}，尝试使用绑定的模型池", expectedModelCode);
        }

        // 2. 从绑定的模型池中选择
        if (requirement.ModelGroupIds.Count > 0)
        {
            // 获取所有绑定的模型池
            var groups = await _db.ModelGroups
                .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                .ToListAsync(ct);

            if (groups.Count > 0)
            {
                // 如果只有一个模型池，直接返回
                if (groups.Count == 1)
                {
                    return groups[0];
                }

                // 多个模型池时，随机选择一个（用于负载均衡）
                var random = new Random();
                var selected = groups[random.Next(groups.Count)];
                _logger.LogDebug("从 {Count} 个模型池中随机选择: {GroupId}", groups.Count, selected.Id);
                return selected;
            }
        }

        // 3. 使用该类型的默认分组
        return await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// 按 Code 查找模型池（按优先级选择最高优先级的）
    /// </summary>
    private async Task<ModelGroup?> GetModelGroupByCodeAsync(string code, string modelType, CancellationToken ct)
    {
        // 查找匹配 Code 的所有模型池，按优先级排序
        var groups = await _db.ModelGroups
            .Find(g => g.Code == code && g.ModelType == modelType)
            .SortBy(g => g.Priority)
            .ToListAsync(ct);

        if (groups.Count == 0)
        {
            // 如果指定类型没有，尝试查找任意类型
            groups = await _db.ModelGroups
                .Find(g => g.Code == code)
                .SortBy(g => g.Priority)
                .ToListAsync(ct);
        }

        // 返回优先级最高（Priority 值最小）的模型池
        return groups.FirstOrDefault();
    }

    private async Task<ModelGroup?> GetModelGroupAsync(string? groupId, string modelType, CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(groupId))
        {
            var group = await _db.ModelGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync(ct);
            if (group != null) return group;
        }

        // 使用该类型的默认分组
        return await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .FirstOrDefaultAsync(ct);
    }

    private ModelGroupItem? SelectBestModelFromGroup(ModelGroup group)
    {
        // 按优先级和健康状态选择最佳模型
        // 1. 优先选择健康的模型
        // 2. 其次选择降权的模型
        // 3. 跳过不可用的模型
        // 4. 在同等健康状态下，按优先级排序

        var healthyModels = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Healthy)
            .OrderBy(m => m.Priority)
            .ToList();

        if (healthyModels.Any())
        {
            return healthyModels.First();
        }

        var degradedModels = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Degraded)
            .OrderBy(m => m.Priority)
            .ToList();

        if (degradedModels.Any())
        {
            _logger.LogWarning("使用降权模型: {ModelId}", degradedModels.First().ModelId);
            return degradedModels.First();
        }

        // 所有模型都不可用
        return null;
    }

    private async Task<ILLMClient> CreateClientForModelAsync(
        ModelGroupItem modelItem,
        string groupId,
        CancellationToken ct)
    {
        // 直接通过 platformId 查询平台信息，不依赖 LLMModels 表（LLMModels 只是收藏夹）
        // modelItem.ModelId 存储的是模型名称（如 deepseek-ai/DeepSeek-R1-Distill-Qwen-32B）
        // modelItem.PlatformId 存储的是平台 ID

        if (string.IsNullOrEmpty(modelItem.PlatformId))
        {
            throw new InvalidOperationException($"模型配置缺少平台ID: modelId={modelItem.ModelId}");
        }

        var platform = await _db.LLMPlatforms.Find(p => p.Id == modelItem.PlatformId).FirstOrDefaultAsync(ct);
        if (platform == null)
        {
            throw new InvalidOperationException($"平台不存在: platformId={modelItem.PlatformId}");
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        var apiUrl = platform.ApiUrl;
        var apiKey = ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
        var platformType = platform.PlatformType?.ToLowerInvariant();
        var platformId = platform.Id;
        var platformName = platform.Name;

        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            throw new InvalidOperationException($"平台 API 配置不完整: platformId={modelItem.PlatformId}, platformName={platformName}");
        }

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        var apiUrlTrim = apiUrl.Trim();
        httpClient.BaseAddress = new Uri(apiUrlTrim.TrimEnd('#').TrimEnd('/') + "/");

        // 模型池项级配置（模型池是决定缓存的唯一来源）
        var enablePromptCache = modelItem.EnablePromptCache ?? true;
        var maxTokens = modelItem.MaxTokens ?? 4096;

        // 模型名称直接使用 modelItem.ModelId
        var modelName = modelItem.ModelId;

        if (platformType == "anthropic" || apiUrl.Contains("anthropic.com"))
        {
            return new ClaudeClient(
                httpClient,
                apiKey,
                modelName,
                maxTokens,
                0.2,
                enablePromptCache,
                _claudeLogger,
                _logWriter,
                _ctxAccessor,
                platformId,
                platformName);
        }

        var chatEndpointOrPath = apiUrlTrim.EndsWith("#", StringComparison.Ordinal)
            ? apiUrlTrim.TrimEnd('#')
            : (apiUrlTrim.EndsWith("/", StringComparison.Ordinal) ? "chat/completions" : "v1/chat/completions");

        return new OpenAIClient(
            httpClient,
            apiKey,
            modelName,
            maxTokens,
            0.2,
            enablePromptCache,
            _logWriter,
            _ctxAccessor,
            chatEndpointOrPath,
            platformId,
            platformName);
    }

    private async Task<ModelSchedulerConfig> GetConfigAsync(CancellationToken ct)
    {
        var config = await _db.ModelSchedulerConfigs.Find(c => c.Id == "singleton").FirstOrDefaultAsync(ct);

        if (config == null)
        {
            // 创建默认配置
            config = new ModelSchedulerConfig { Id = "singleton" };
            await _db.ModelSchedulerConfigs.InsertOneAsync(config, cancellationToken: ct);
        }

        return config;
    }

    /// <summary>
    /// 检查测试桩配置，模拟故障场景
    /// </summary>
    private async Task CheckTestStubAsync(ModelGroupItem modelItem, string groupId, CancellationToken ct)
    {
        var stub = await _db.ModelTestStubs
            .Find(s => s.ModelId == modelItem.ModelId && s.PlatformId == modelItem.PlatformId && s.Enabled)
            .FirstOrDefaultAsync(ct);

        if (stub == null)
        {
            return; // 无测试桩配置，正常执行
        }

        _logger.LogInformation(
            "检测到测试桩: {ModelId}, 模式: {FailureMode}, 失败率: {FailureRate}%",
            modelItem.ModelId,
            stub.FailureMode,
            stub.FailureRate);

        // 根据故障模式处理
        switch (stub.FailureMode)
        {
            case FailureMode.AlwaysFail:
                // 始终失败
                await RecordCallResultAsync(groupId, modelItem.ModelId, modelItem.PlatformId, false, 
                    stub.ErrorMessage ?? "测试桩：始终失败", ct);
                throw new InvalidOperationException(stub.ErrorMessage ?? "测试桩：始终失败");

            case FailureMode.Random:
                // 随机失败
                var random = new Random();
                if (random.Next(100) < stub.FailureRate)
                {
                    await RecordCallResultAsync(groupId, modelItem.ModelId, modelItem.PlatformId, false,
                        stub.ErrorMessage ?? "测试桩：随机失败", ct);
                    throw new InvalidOperationException(stub.ErrorMessage ?? "测试桩：随机失败");
                }
                break;

            case FailureMode.Timeout:
                // 模拟超时
                await Task.Delay(stub.LatencyMs > 0 ? stub.LatencyMs : 30000, ct);
                await RecordCallResultAsync(groupId, modelItem.ModelId, modelItem.PlatformId, false,
                    stub.ErrorMessage ?? "测试桩：超时", ct);
                throw new TimeoutException(stub.ErrorMessage ?? "测试桩：超时");

            case FailureMode.SlowResponse:
                // 慢响应（延迟但不失败）
                if (stub.LatencyMs > 0)
                {
                    _logger.LogWarning("测试桩：添加延迟 {Latency}ms", stub.LatencyMs);
                    await Task.Delay(stub.LatencyMs, ct);
                }
                break;

            case FailureMode.ConnectionReset:
                // 连接重置
                await RecordCallResultAsync(groupId, modelItem.ModelId, modelItem.PlatformId, false,
                    stub.ErrorMessage ?? "测试桩：连接重置", ct);
                throw new System.Net.Http.HttpRequestException(stub.ErrorMessage ?? "测试桩：连接重置");

            case FailureMode.Intermittent:
                // 间歇性故障（每N次失败一次）
                var failInterval = stub.FailureRate > 0 ? stub.FailureRate : 5;
                // 简单实现：使用时间戳模拟
                if (DateTime.UtcNow.Second % failInterval == 0)
                {
                    await RecordCallResultAsync(groupId, modelItem.ModelId, modelItem.PlatformId, false,
                        stub.ErrorMessage ?? "测试桩：间歇性故障", ct);
                    throw new InvalidOperationException(stub.ErrorMessage ?? "测试桩：间歇性故障");
                }
                break;

            case FailureMode.None:
            default:
                // 无故障，正常执行
                break;
        }
    }
}
