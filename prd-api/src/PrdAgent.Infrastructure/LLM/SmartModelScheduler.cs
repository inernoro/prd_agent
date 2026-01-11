using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
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

        // 获取绑定的模型分组（如果未配置则使用该类型的默认分组）
        var group = await GetModelGroupAsync(requirement.ModelGroupId, modelType, ct);

        if (group == null || group.Models.Count == 0)
        {
            throw new InvalidOperationException($"未找到可用的模型分组（类型：{modelType}）");
        }

        // 从分组中选择最佳模型
        var bestModel = SelectBestModelFromGroup(group);

        if (bestModel == null)
        {
            throw new InvalidOperationException($"分组中没有可用的模型（类型：{modelType}）");
        }

        // 检查测试桩配置（用于故障模拟）
        await CheckTestStubAsync(bestModel, group.Id, ct);

        // 创建并返回客户端
        return await CreateClientForModelAsync(bestModel, group.Id, ct);
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

                    // 创建临时客户端进行探测
                    var client = await CreateClientForModelAsync(modelItem, group.Id, ct);

                    // 发送轻量探测请求
                    var messages = new List<LLMMessage>();
                    var hasResponse = false;

                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(config.HealthCheckTimeoutSeconds));
                    await foreach (var chunk in client.StreamGenerateAsync(
                        config.HealthCheckPrompt,
                        messages,
                        enablePromptCache: false,
                        cts.Token))
                    {
                        if (chunk.Type == "error")
                        {
                            _logger.LogWarning("健康检查失败: {ModelId}, 错误: {Error}", modelItem.ModelId, chunk.ErrorMessage);
                            break;
                        }

                        hasResponse = true;
                        break; // 只要有响应就算成功
                    }

                    if (hasResponse)
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
            ModelGroupId = defaultGroup?.Id, // 可能为null，后续会使用默认分组
            IsRequired = true
        };

        app.ModelRequirements.Add(requirement);
        app.UpdatedAt = DateTime.UtcNow;

        await _db.LLMAppCallers.ReplaceOneAsync(a => a.Id == app.Id, app, cancellationToken: ct);

        _logger.LogInformation("为应用 {AppCode} 添加模型类型需求: {ModelType}", app.AppCode, modelType);

        return requirement;
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
        var model = await _db.LLMModels.Find(m => m.Id == modelItem.ModelId).FirstOrDefaultAsync(ct);
        if (model == null)
        {
            throw new InvalidOperationException($"模型不存在: {modelItem.ModelId}");
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";

        var (apiUrl, apiKey, platformType, platformId, platformName) = await ResolveApiConfigForModelAsync(model, jwtSecret, ct);

        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            throw new InvalidOperationException("模型 API 配置不完整");
        }

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        var apiUrlTrim = apiUrl.Trim();
        httpClient.BaseAddress = new Uri(apiUrlTrim.TrimEnd('#').TrimEnd('/') + "/");

        var enablePromptCache = model.EnablePromptCache ?? true;
        var maxTokens = model.MaxTokens.HasValue && model.MaxTokens.Value > 0 ? model.MaxTokens.Value : 4096;

        if (platformType == "anthropic" || apiUrl.Contains("anthropic.com"))
        {
            return new ClaudeClient(
                httpClient,
                apiKey,
                model.ModelName,
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
            model.ModelName,
            maxTokens,
            0.2,
            enablePromptCache,
            _logWriter,
            _ctxAccessor,
            chatEndpointOrPath,
            platformId,
            platformName);
    }

    private async Task<(string? apiUrl, string? apiKey, string? platformType, string? platformId, string? platformName)>
        ResolveApiConfigForModelAsync(LLMModel model, string jwtSecret, CancellationToken ct)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : DecryptApiKey(model.ApiKeyEncrypted, jwtSecret);
        string? platformType = null;
        string? platformId = model.PlatformId;
        string? platformName = null;

        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync(ct);
            platformType = platform?.PlatformType?.ToLowerInvariant();
            platformName = platform?.Name;

            if (platform != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= DecryptApiKey(platform.ApiKeyEncrypted, jwtSecret);
            }
        }

        return (apiUrl, apiKey, platformType, platformId, platformName);
    }

    private string DecryptApiKey(string encrypted, string secret)
    {
        try
        {
            var keyBytes = System.Text.Encoding.UTF8.GetBytes(secret.PadRight(32).Substring(0, 32));
            using var aes = System.Security.Cryptography.Aes.Create();
            aes.Key = keyBytes;
            aes.IV = new byte[16];
            aes.Mode = System.Security.Cryptography.CipherMode.CBC;
            aes.Padding = System.Security.Cryptography.PaddingMode.PKCS7;

            using var decryptor = aes.CreateDecryptor();
            var encryptedBytes = Convert.FromBase64String(encrypted);
            var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
            return System.Text.Encoding.UTF8.GetString(decryptedBytes);
        }
        catch
        {
            return encrypted;
        }
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
