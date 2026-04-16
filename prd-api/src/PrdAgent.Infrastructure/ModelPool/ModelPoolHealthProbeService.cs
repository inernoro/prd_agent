using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池健康探活后台服务
/// 周期性扫描不健康模型端点，发送轻量级探活请求以自动恢复
/// </summary>
public sealed class ModelPoolHealthProbeService : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ModelPoolHealthProbeService> _logger;
    private readonly IConfiguration _config;

    /// <summary>正在探活的端点（并发锁，避免多个探活同时进行）</summary>
    private readonly ConcurrentDictionary<string, byte> _probing = new();

    /// <summary>上次探活时间（冷却期控制）</summary>
    private readonly ConcurrentDictionary<string, DateTime> _lastProbeTime = new();

    /// <summary>池子首次进入全部不可用的时间（用于计算故障持续时间）</summary>
    private readonly ConcurrentDictionary<string, DateTime> _poolExhaustedSince = new();

    public ModelPoolHealthProbeService(
        IServiceProvider serviceProvider,
        ILogger<ModelPoolHealthProbeService> logger,
        IConfiguration config)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
        _config = config;
    }

    private bool Enabled => _config.GetValue("ModelPool:HealthProbe:Enabled", true);
    private int IntervalSeconds => _config.GetValue("ModelPool:HealthProbe:IntervalSeconds", 180);
    private int CooldownSeconds => _config.GetValue("ModelPool:HealthProbe:CooldownSeconds", 600);
    private int ProbeTimeoutSeconds => _config.GetValue("ModelPool:HealthProbe:ProbeTimeoutSeconds", 15);
    private int MaxConcurrentProbes => _config.GetValue("ModelPool:HealthProbe:MaxConcurrentProbes", 5);

    /// <summary>
    /// 跳过探活的模型类型列表（逗号分隔）。
    /// 默认跳过 generation（图片生成）：图片生成 API 使用 /v1/images/generations 端点，
    /// 无法通过 chat completions 格式探活，否则探针永远失败 → 模型永远 Unhealthy → 无限重试。
    /// </summary>
    private HashSet<string> SkipModelTypes
    {
        get
        {
            var raw = _config.GetValue("ModelPool:HealthProbe:SkipModelTypes", "generation");
            return raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                      .Select(s => s.ToLowerInvariant())
                      .ToHashSet();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Enabled)
        {
            _logger.LogInformation("[HealthProbe] 探活服务已禁用");
            return;
        }

        var skipTypes = SkipModelTypes;
        _logger.LogInformation(
            "[HealthProbe] 探活服务已启动: Interval={Interval}s, Cooldown={Cooldown}s, MaxConcurrent={Max}, SkipTypes=[{Skip}]",
            IntervalSeconds, CooldownSeconds, MaxConcurrentProbes, string.Join(",", skipTypes));

        // 启动后延迟 30s 再开始，避免启动风暴
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunProbeRoundAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[HealthProbe] 探活轮次异常");
            }

            await Task.Delay(TimeSpan.FromSeconds(IntervalSeconds), stoppingToken);
        }

        _logger.LogInformation("[HealthProbe] 探活服务已停止");
    }

    private async Task RunProbeRoundAsync(CancellationToken ct)
    {
        using var scope = _serviceProvider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var notifier = scope.ServiceProvider.GetRequiredService<IPoolFailoverNotifier>();

        // 查找所有包含不健康模型的模型组
        var allGroups = await db.ModelGroups.Find(_ => true).ToListAsync(ct);

        var skipTypes = SkipModelTypes;

        var unhealthyGroups = allGroups
            .Where(g => g.Models?.Any(m =>
                m.HealthStatus == ModelHealthStatus.Degraded ||
                m.HealthStatus == ModelHealthStatus.Unavailable) == true)
            .Where(g => !skipTypes.Contains(g.ModelType?.ToLowerInvariant() ?? ""))
            .ToList();

        if (unhealthyGroups.Count == 0)
        {
            // 清理所有池耗尽记录（全部健康了）
            _poolExhaustedSince.Clear();
            return;
        }

        _logger.LogDebug("[HealthProbe] 发现 {Count} 个模型组含不健康端点", unhealthyGroups.Count);

        var probeTasks = new List<Task>();
        var probeCount = 0;

        foreach (var group in unhealthyGroups)
        {
            // 检查是否全部不可用 → 触发故障通知
            var allUnavailable = group.Models?.All(m => m.HealthStatus == ModelHealthStatus.Unavailable) == true;
            if (allUnavailable)
            {
                _poolExhaustedSince.TryAdd(group.Id, DateTime.UtcNow);

                try
                {
                    await notifier.NotifyPoolExhaustedAsync(group, ct);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[HealthProbe] 发送故障通知失败: Pool={Pool}", group.Name);
                }
            }

            foreach (var model in group.Models ?? [])
            {
                if (model.HealthStatus == ModelHealthStatus.Healthy)
                    continue;

                if (probeCount >= MaxConcurrentProbes)
                    break;

                var endpointKey = $"{group.Id}:{model.PlatformId}:{model.ModelId}";

                // 冷却期检查
                if (_lastProbeTime.TryGetValue(endpointKey, out var lastTime)
                    && (DateTime.UtcNow - lastTime).TotalSeconds < CooldownSeconds)
                {
                    continue;
                }

                // 并发锁检查
                if (!_probing.TryAdd(endpointKey, 0))
                    continue;

                probeCount++;
                probeTasks.Add(ProbeEndpointAsync(scope.ServiceProvider, db, notifier, group, model, endpointKey, ct));
            }
        }

        if (probeTasks.Count > 0)
        {
            _logger.LogInformation("[HealthProbe] 本轮发起 {Count} 个探活请求", probeTasks.Count);
            await Task.WhenAll(probeTasks);
        }
    }

    private async Task ProbeEndpointAsync(
        IServiceProvider sp,
        MongoDbContext db,
        IPoolFailoverNotifier notifier,
        ModelGroup group,
        ModelGroupItem model,
        string endpointKey,
        CancellationToken ct)
    {
        try
        {
            _lastProbeTime[endpointKey] = DateTime.UtcNow;

            var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";

            // 获取平台信息
            var platform = await db.LLMPlatforms
                .Find(p => p.Id == model.PlatformId && p.Enabled)
                .FirstOrDefaultAsync(ct);

            if (platform == null)
            {
                _logger.LogDebug("[HealthProbe] 平台不可用，跳过: Model={Model}, Platform={Platform}",
                    model.ModelId, model.PlatformId);
                return;
            }

            var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
                ? null
                : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);

            // 构建轻量探活请求
            var success = await SendProbeRequestAsync(sp, platform, model.ModelId, apiKey, group, ct);

            if (success)
            {
                // 恢复健康状态
                var filter = Builders<ModelGroup>.Filter.And(
                    Builders<ModelGroup>.Filter.Eq(g => g.Id, group.Id),
                    Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                        m => m.PlatformId == model.PlatformId && m.ModelId == model.ModelId));

                var update = Builders<ModelGroup>.Update
                    .Set("Models.$.HealthStatus", ModelHealthStatus.Healthy)
                    .Set("Models.$.ConsecutiveFailures", 0)
                    .Inc("Models.$.ConsecutiveSuccesses", 1)
                    .Set("Models.$.LastSuccessAt", DateTime.UtcNow);

                await db.ModelGroups.UpdateOneAsync(filter, update, cancellationToken: ct);

                _logger.LogInformation(
                    "[HealthProbe] ✅ 探活成功，模型已恢复: Pool={Pool}, Model={Model}@{Platform}",
                    group.Name, model.ModelId, platform.Name);

                // 发送恢复通知
                try
                {
                    var downDuration = _poolExhaustedSince.TryRemove(group.Id, out var exhaustedSince)
                        ? DateTime.UtcNow - exhaustedSince
                        : TimeSpan.Zero;

                    await notifier.NotifyPoolRecoveredAsync(group, model.ModelId, downDuration, ct);
                    await notifier.CloseUserFailureNotificationsAsync(group.ModelType, ct);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[HealthProbe] 发送恢复通知失败");
                }
            }
            else
            {
                _logger.LogDebug(
                    "[HealthProbe] ❌ 探活失败，保持当前状态: Pool={Pool}, Model={Model}@{Platform}, Status={Status}",
                    group.Name, model.ModelId, platform.Name, model.HealthStatus);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[HealthProbe] 探活异常: EndpointKey={Key}", endpointKey);
        }
        finally
        {
            _probing.TryRemove(endpointKey, out _);
        }
    }

    /// <summary>
    /// 发送轻量级探活请求（直接 HTTP，不走 Gateway 避免循环）
    /// </summary>
    private async Task<bool> SendProbeRequestAsync(
        IServiceProvider sp,
        LLMPlatform platform,
        string modelId,
        string? apiKey,
        ModelGroup group,
        CancellationToken ct)
    {
        var logWriter = sp.GetService<ILlmRequestLogWriter>();
        var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();

        var startedAt = DateTime.UtcNow;
        string? logId = null;

        try
        {
            // 构建最小化请求
            var requestBody = new JsonObject
            {
                ["model"] = modelId,
                ["messages"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = "hi"
                    }
                },
                ["max_tokens"] = 1,
                ["stream"] = false
            };

            // 确定 API endpoint
            var baseUrl = platform.ApiUrl?.TrimEnd('/') ?? "";
            var endpoint = platform.PlatformType?.ToLowerInvariant() == "claude"
                ? $"{baseUrl}/v1/messages"
                : $"{baseUrl}/v1/chat/completions";

            // 写入日志（标记为探活）
            var probeAppCallerCode = group.ModelType?.ToLowerInvariant() switch
            {
                "intent" => AppCallerRegistry.System.HealthProbe.Intent,
                "vision" => AppCallerRegistry.System.HealthProbe.Vision,
                "generation" => AppCallerRegistry.System.HealthProbe.Generation,
                _ => AppCallerRegistry.System.HealthProbe.Chat
            };

            if (logWriter != null)
            {
                logId = await logWriter.StartAsync(
                    new LlmLogStart(
                        RequestId: Guid.NewGuid().ToString("N"),
                        Provider: platform.Name,
                        Model: modelId,
                        ApiBase: baseUrl,
                        Path: "v1/chat/completions",
                        HttpMethod: "POST",
                        RequestHeadersRedacted: new Dictionary<string, string> { ["content-type"] = "application/json" },
                        RequestBodyRedacted: "[Health Probe]",
                        RequestBodyHash: null,
                        QuestionText: "[Health Probe] hi",
                        SystemPromptChars: null,
                        SystemPromptHash: null,
                        SystemPromptText: null,
                        MessageCount: 1,
                        GroupId: null,
                        SessionId: null,
                        UserId: null,
                        ViewRole: null,
                        DocumentChars: null,
                        DocumentHash: null,
                        UserPromptChars: 2,
                        StartedAt: startedAt,
                        RequestType: group.ModelType,
                        AppCallerCode: probeAppCallerCode,
                        PlatformId: platform.Id,
                        PlatformName: platform.Name,
                        ModelGroupId: group.Id,
                        ModelGroupName: group.Name,
                        IsHealthProbe: true),
                    ct);
            }

            // 发送 HTTP 请求
            var httpClient = httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(ProbeTimeoutSeconds);

            var httpRequest = new HttpRequestMessage(System.Net.Http.HttpMethod.Post, endpoint)
            {
                Content = new StringContent(
                    requestBody.ToJsonString(),
                    System.Text.Encoding.UTF8,
                    "application/json")
            };

            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                if (platform.PlatformType?.ToLowerInvariant() == "claude")
                {
                    httpRequest.Headers.TryAddWithoutValidation("x-api-key", apiKey);
                    httpRequest.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
                }
                else
                {
                    httpRequest.Headers.Authorization =
                        new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
                }
            }

            var response = await httpClient.SendAsync(httpRequest, ct);
            var durationMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;

            if (response.IsSuccessStatusCode)
            {
                if (logId != null)
                {
                    logWriter?.MarkDone(logId, new LlmLogDone(
                        StatusCode: (int)response.StatusCode,
                        ResponseHeaders: null,
                        InputTokens: null,
                        OutputTokens: null,
                        CacheCreationInputTokens: null,
                        CacheReadInputTokens: null,
                        TokenUsageSource: "missing",
                        ImageSuccessCount: null,
                        AnswerText: "[Health Probe OK]",
                        ThinkingText: null,
                        AssembledTextChars: 0,
                        AssembledTextHash: null,
                        Status: "succeeded",
                        EndedAt: DateTime.UtcNow,
                        DurationMs: durationMs));
                }
                return true;
            }
            else
            {
                var errorBody = await response.Content.ReadAsStringAsync(ct);
                var errorPreview = errorBody.Length > 200 ? errorBody[..200] : errorBody;

                if (logId != null)
                {
                    logWriter?.MarkError(logId, $"HTTP {(int)response.StatusCode}: {errorPreview}", (int)response.StatusCode);
                }

                _logger.LogDebug(
                    "[HealthProbe] HTTP {StatusCode} from {Model}@{Platform}: {Error}",
                    (int)response.StatusCode, modelId, platform.Name, errorPreview);

                return false;
            }
        }
        catch (TaskCanceledException)
        {
            if (logId != null)
            {
                logWriter?.MarkError(logId, "Probe timeout");
            }
            return false;
        }
        catch (HttpRequestException ex)
        {
            if (logId != null)
            {
                logWriter?.MarkError(logId, $"Network error: {ex.Message}");
            }
            return false;
        }
    }
}
