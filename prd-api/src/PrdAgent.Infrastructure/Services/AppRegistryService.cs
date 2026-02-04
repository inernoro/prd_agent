using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 应用注册中心服务实现
/// </summary>
public class AppRegistryService : IAppRegistryService
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<AppRegistryService> _logger;

    public AppRegistryService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        ILogger<AppRegistryService> logger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    // ==================== 应用管理 ====================

    public async Task<List<RegisteredApp>> GetAppsAsync(bool includeInactive = false, CancellationToken ct = default)
    {
        var filter = includeInactive
            ? Builders<RegisteredApp>.Filter.Empty
            : Builders<RegisteredApp>.Filter.Eq(x => x.IsActive, true);

        return await _db.RegisteredApps.Find(filter).SortBy(x => x.AppName).ToListAsync(ct);
    }

    public async Task<RegisteredApp?> GetAppByIdAsync(string appId, CancellationToken ct = default)
    {
        return await _db.RegisteredApps.Find(x => x.AppId == appId).FirstOrDefaultAsync(ct);
    }

    public async Task<RegisteredApp?> GetAppByMongoIdAsync(string id, CancellationToken ct = default)
    {
        return await _db.RegisteredApps.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
    }

    public async Task<RegisteredApp> RegisterAppAsync(RegisterAppRequest request, CancellationToken ct = default)
    {
        // 检查 AppId 是否已存在
        var existing = await GetAppByIdAsync(request.AppId, ct);
        if (existing != null)
        {
            throw new InvalidOperationException($"应用 {request.AppId} 已存在");
        }

        var app = new RegisteredApp
        {
            AppId = request.AppId,
            AppName = request.AppName,
            Description = request.Description,
            Icon = request.Icon,
            Version = request.Version,
            Capabilities = request.Capabilities ?? new AppCapabilities(),
            InputSchema = request.InputSchema ?? new AppInputSchema(),
            OutputSchema = request.OutputSchema ?? new AppOutputSchema(),
            Endpoint = request.Endpoint,
            SupportsStreaming = request.SupportsStreaming,
            SupportsStatusCallback = request.SupportsStatusCallback,
            CallbackUrl = request.CallbackUrl,
            AuthType = request.AuthType,
            ApiKey = request.ApiKey,
            IsBuiltin = false,
            IsStub = false,
            IsActive = true,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.RegisteredApps.InsertOneAsync(app, cancellationToken: ct);
        _logger.LogInformation("应用已注册: {AppId} - {AppName}", app.AppId, app.AppName);

        return app;
    }

    public async Task<RegisteredApp> UpdateAppAsync(string appId, UpdateAppRequest request, CancellationToken ct = default)
    {
        var app = await GetAppByIdAsync(appId, ct)
            ?? throw new InvalidOperationException($"应用 {appId} 不存在");

        var updates = new List<UpdateDefinition<RegisteredApp>>();

        if (request.AppName != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.AppName, request.AppName));
        if (request.Description != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.Description, request.Description));
        if (request.Icon != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.Icon, request.Icon));
        if (request.Version != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.Version, request.Version));
        if (request.Capabilities != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.Capabilities, request.Capabilities));
        if (request.InputSchema != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.InputSchema, request.InputSchema));
        if (request.OutputSchema != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.OutputSchema, request.OutputSchema));
        if (request.Endpoint != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.Endpoint, request.Endpoint));
        if (request.SupportsStreaming.HasValue) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.SupportsStreaming, request.SupportsStreaming.Value));
        if (request.SupportsStatusCallback.HasValue) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.SupportsStatusCallback, request.SupportsStatusCallback.Value));
        if (request.CallbackUrl != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.CallbackUrl, request.CallbackUrl));
        if (request.AuthType.HasValue) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.AuthType, request.AuthType.Value));
        if (request.ApiKey != null) updates.Add(Builders<RegisteredApp>.Update.Set(x => x.ApiKey, request.ApiKey));

        updates.Add(Builders<RegisteredApp>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow));

        var update = Builders<RegisteredApp>.Update.Combine(updates);
        await _db.RegisteredApps.UpdateOneAsync(x => x.AppId == appId, update, cancellationToken: ct);

        return (await GetAppByIdAsync(appId, ct))!;
    }

    public async Task DeleteAppAsync(string appId, CancellationToken ct = default)
    {
        var result = await _db.RegisteredApps.DeleteOneAsync(x => x.AppId == appId, ct);
        if (result.DeletedCount == 0)
        {
            throw new InvalidOperationException($"应用 {appId} 不存在");
        }
        _logger.LogInformation("应用已注销: {AppId}", appId);
    }

    public async Task<RegisteredApp> ToggleAppStatusAsync(string appId, CancellationToken ct = default)
    {
        var app = await GetAppByIdAsync(appId, ct)
            ?? throw new InvalidOperationException($"应用 {appId} 不存在");

        var newStatus = !app.IsActive;
        await _db.RegisteredApps.UpdateOneAsync(
            x => x.AppId == appId,
            Builders<RegisteredApp>.Update
                .Set(x => x.IsActive, newStatus)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        app.IsActive = newStatus;
        return app;
    }

    public async Task UpdateHeartbeatAsync(string appId, CancellationToken ct = default)
    {
        await _db.RegisteredApps.UpdateOneAsync(
            x => x.AppId == appId,
            Builders<RegisteredApp>.Update
                .Set(x => x.LastHeartbeatAt, DateTime.UtcNow)
                .Set(x => x.HealthStatus, AppHealthStatus.Healthy),
            cancellationToken: ct);
    }

    // ==================== 桩应用 ====================

    public async Task<RegisteredApp> CreateStubAppAsync(CreateStubAppRequest request, CancellationToken ct = default)
    {
        var existing = await GetAppByIdAsync(request.AppId, ct);
        if (existing != null)
        {
            throw new InvalidOperationException($"应用 {request.AppId} 已存在");
        }

        var app = new RegisteredApp
        {
            AppId = request.AppId,
            AppName = request.AppName,
            Description = request.Description ?? "桩应用（测试用）",
            Icon = request.Icon ?? "🧪",
            Version = "1.0.0",
            Capabilities = new AppCapabilities
            {
                InputTypes = new List<string> { "text" },
                OutputTypes = new List<string> { "text" },
            },
            InputSchema = new AppInputSchema(),
            OutputSchema = new AppOutputSchema { ReturnsReply = true },
            Endpoint = $"internal://stub/{request.AppId}",
            SupportsStreaming = false,
            SupportsStatusCallback = false,
            IsBuiltin = false,
            IsStub = true,
            StubConfig = request.StubConfig,
            IsActive = true,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.RegisteredApps.InsertOneAsync(app, cancellationToken: ct);
        _logger.LogInformation("桩应用已创建: {AppId} - {AppName}", app.AppId, app.AppName);

        return app;
    }

    public async Task<RegisteredApp> UpdateStubConfigAsync(string appId, StubAppConfig config, CancellationToken ct = default)
    {
        var app = await GetAppByIdAsync(appId, ct)
            ?? throw new InvalidOperationException($"应用 {appId} 不存在");

        if (!app.IsStub)
        {
            throw new InvalidOperationException($"应用 {appId} 不是桩应用，无法更新桩配置");
        }

        await _db.RegisteredApps.UpdateOneAsync(
            x => x.AppId == appId,
            Builders<RegisteredApp>.Update
                .Set(x => x.StubConfig, config)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return (await GetAppByIdAsync(appId, ct))!;
    }

    // ==================== 路由规则 ====================

    public async Task<List<RoutingRule>> GetRoutingRulesAsync(bool includeInactive = false, CancellationToken ct = default)
    {
        var filter = includeInactive
            ? Builders<RoutingRule>.Filter.Empty
            : Builders<RoutingRule>.Filter.Eq(x => x.IsActive, true);

        return await _db.RoutingRules.Find(filter).SortBy(x => x.Priority).ToListAsync(ct);
    }

    public async Task<RoutingRule?> GetRoutingRuleAsync(string id, CancellationToken ct = default)
    {
        return await _db.RoutingRules.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
    }

    public async Task<RoutingRule> CreateRoutingRuleAsync(CreateRoutingRuleRequest request, CancellationToken ct = default)
    {
        // 验证目标应用存在
        var targetApp = await GetAppByIdAsync(request.TargetAppId, ct)
            ?? throw new InvalidOperationException($"目标应用 {request.TargetAppId} 不存在");

        var rule = new RoutingRule
        {
            Name = request.Name,
            Description = request.Description,
            Priority = request.Priority,
            Condition = request.Condition,
            TargetAppId = request.TargetAppId,
            ActionParams = request.ActionParams ?? new Dictionary<string, object>(),
            IsActive = true,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.RoutingRules.InsertOneAsync(rule, cancellationToken: ct);
        _logger.LogInformation("路由规则已创建: {RuleName} -> {TargetApp}", rule.Name, rule.TargetAppId);

        return rule;
    }

    public async Task<RoutingRule> UpdateRoutingRuleAsync(string id, UpdateRoutingRuleRequest request, CancellationToken ct = default)
    {
        var rule = await GetRoutingRuleAsync(id, ct)
            ?? throw new InvalidOperationException($"路由规则 {id} 不存在");

        if (request.TargetAppId != null)
        {
            var targetApp = await GetAppByIdAsync(request.TargetAppId, ct)
                ?? throw new InvalidOperationException($"目标应用 {request.TargetAppId} 不存在");
        }

        var updates = new List<UpdateDefinition<RoutingRule>>();

        if (request.Name != null) updates.Add(Builders<RoutingRule>.Update.Set(x => x.Name, request.Name));
        if (request.Description != null) updates.Add(Builders<RoutingRule>.Update.Set(x => x.Description, request.Description));
        if (request.Priority.HasValue) updates.Add(Builders<RoutingRule>.Update.Set(x => x.Priority, request.Priority.Value));
        if (request.Condition != null) updates.Add(Builders<RoutingRule>.Update.Set(x => x.Condition, request.Condition));
        if (request.TargetAppId != null) updates.Add(Builders<RoutingRule>.Update.Set(x => x.TargetAppId, request.TargetAppId));
        if (request.ActionParams != null) updates.Add(Builders<RoutingRule>.Update.Set(x => x.ActionParams, request.ActionParams));

        updates.Add(Builders<RoutingRule>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow));

        var update = Builders<RoutingRule>.Update.Combine(updates);
        await _db.RoutingRules.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        return (await GetRoutingRuleAsync(id, ct))!;
    }

    public async Task DeleteRoutingRuleAsync(string id, CancellationToken ct = default)
    {
        var result = await _db.RoutingRules.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
        {
            throw new InvalidOperationException($"路由规则 {id} 不存在");
        }
    }

    public async Task<RoutingRule> ToggleRuleStatusAsync(string id, CancellationToken ct = default)
    {
        var rule = await GetRoutingRuleAsync(id, ct)
            ?? throw new InvalidOperationException($"路由规则 {id} 不存在");

        var newStatus = !rule.IsActive;
        await _db.RoutingRules.UpdateOneAsync(
            x => x.Id == id,
            Builders<RoutingRule>.Update
                .Set(x => x.IsActive, newStatus)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        rule.IsActive = newStatus;
        return rule;
    }

    // ==================== 路由调度 ====================

    public async Task<(RegisteredApp? App, RoutingRule? MatchedRule)> ResolveAppAsync(UnifiedAppRequest request, CancellationToken ct = default)
    {
        var rules = await GetRoutingRulesAsync(false, ct);

        foreach (var rule in rules.OrderBy(r => r.Priority))
        {
            if (MatchRule(rule, request))
            {
                var app = await GetAppByIdAsync(rule.TargetAppId, ct);
                if (app != null && app.IsActive)
                {
                    _logger.LogDebug("路由匹配: {RuleName} -> {AppId}", rule.Name, rule.TargetAppId);
                    return (app, rule);
                }
            }
        }

        // 没有匹配的规则，查找默认应用
        var defaultRule = rules.FirstOrDefault(r => r.Condition.Type == RuleConditionType.All);
        if (defaultRule != null)
        {
            var app = await GetAppByIdAsync(defaultRule.TargetAppId, ct);
            if (app != null && app.IsActive)
            {
                return (app, defaultRule);
            }
        }

        return (null, null);
    }

    private bool MatchRule(RoutingRule rule, UnifiedAppRequest request)
    {
        var condition = rule.Condition;

        // 检查通道
        if (!string.IsNullOrEmpty(condition.Channel) &&
            !condition.Channel.Equals(request.Source.Channel, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // 检查发送者
        if (!string.IsNullOrEmpty(condition.SenderPattern))
        {
            var pattern = condition.SenderPattern.Replace("*", ".*");
            if (!Regex.IsMatch(request.Source.SenderIdentifier, pattern, RegexOptions.IgnoreCase))
            {
                return false;
            }
        }

        // 根据类型匹配
        switch (condition.Type)
        {
            case RuleConditionType.Keyword:
                if (condition.Keywords.Count == 0) return true;
                var content = $"{request.Content.Subject} {request.Content.Body}".ToLower();
                return condition.Keywords.Any(k => content.Contains(k.ToLower()));

            case RuleConditionType.Regex:
                if (string.IsNullOrEmpty(condition.RegexPattern)) return true;
                var text = $"{request.Content.Subject} {request.Content.Body}";
                return Regex.IsMatch(text, condition.RegexPattern, RegexOptions.IgnoreCase);

            case RuleConditionType.User:
                return !string.IsNullOrEmpty(condition.UserId) &&
                       condition.UserId == request.Context.UserId;

            case RuleConditionType.Sender:
                return !string.IsNullOrEmpty(condition.SenderPattern) &&
                       Regex.IsMatch(request.Source.SenderIdentifier,
                           condition.SenderPattern.Replace("*", ".*"),
                           RegexOptions.IgnoreCase);

            case RuleConditionType.All:
                return true;

            default:
                return false;
        }
    }

    // ==================== 应用调用 ====================

    public async Task<UnifiedAppResponse> InvokeAppAsync(string appId, UnifiedAppRequest request, CancellationToken ct = default)
    {
        var app = await GetAppByIdAsync(appId, ct)
            ?? throw new InvalidOperationException($"应用 {appId} 不存在");

        if (!app.IsActive)
        {
            throw new InvalidOperationException($"应用 {appId} 已禁用");
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            UnifiedAppResponse response;

            if (app.IsStub)
            {
                response = await InvokeStubAppAsync(app, request, ct);
            }
            else if (app.Endpoint.StartsWith("internal://"))
            {
                response = await InvokeInternalAppAsync(app, request, ct);
            }
            else
            {
                response = await InvokeExternalAppAsync(app, request, ct);
            }

            sw.Stop();
            response.DurationMs = sw.ElapsedMilliseconds;

            // 更新统计
            await UpdateAppStatsAsync(appId, response.Status == AppResponseStatus.Success, sw.ElapsedMilliseconds, ct);

            return response;
        }
        catch (Exception ex)
        {
            sw.Stop();
            _logger.LogError(ex, "调用应用 {AppId} 失败", appId);

            await UpdateAppStatsAsync(appId, false, sw.ElapsedMilliseconds, ct);

            return new UnifiedAppResponse
            {
                RequestId = request.RequestId,
                Status = AppResponseStatus.Failed,
                Message = "应用调用失败",
                Error = new ResponseError
                {
                    Code = "INVOKE_ERROR",
                    Message = ex.Message,
                    Retryable = true,
                },
                DurationMs = sw.ElapsedMilliseconds,
            };
        }
    }

    private async Task<UnifiedAppResponse> InvokeStubAppAsync(RegisteredApp app, UnifiedAppRequest request, CancellationToken ct)
    {
        var config = app.StubConfig ?? new StubAppConfig();

        // 模拟延迟
        if (config.DelayMs > 0)
        {
            await Task.Delay(config.DelayMs, ct);
        }

        // 随机失败
        if (config.RandomFailure && Random.Shared.Next(100) < config.FailureProbability)
        {
            return new UnifiedAppResponse
            {
                RequestId = request.RequestId,
                Status = AppResponseStatus.Failed,
                Message = config.FailureMessage ?? "桩应用模拟失败",
                Error = new ResponseError
                {
                    Code = "STUB_FAILURE",
                    Message = config.FailureMessage ?? "桩应用模拟失败",
                    Retryable = true,
                },
            };
        }

        // 生成响应
        string responseContent;
        if (config.EchoInput)
        {
            responseContent = $"[回显] 主题: {request.Content.Subject}\n内容: {request.Content.Body}";
        }
        else if (!string.IsNullOrEmpty(config.ResponseTemplate))
        {
            responseContent = config.ResponseTemplate
                .Replace("{subject}", request.Content.Subject ?? "")
                .Replace("{body}", request.Content.Body)
                .Replace("{sender}", request.Source.SenderName ?? request.Source.SenderIdentifier)
                .Replace("{timestamp}", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        }
        else
        {
            responseContent = config.FixedResponse ?? $"桩应用 [{app.AppName}] 已收到请求";
        }

        return new UnifiedAppResponse
        {
            RequestId = request.RequestId,
            Status = AppResponseStatus.Success,
            Message = "桩应用处理成功",
            Result = new ResponseResult
            {
                Content = responseContent,
            },
            Reply = new ResponseReply
            {
                ShouldReply = true,
                Content = responseContent,
            },
        };
    }

    private Task<UnifiedAppResponse> InvokeInternalAppAsync(RegisteredApp app, UnifiedAppRequest request, CancellationToken ct)
    {
        // 内部应用调用（预留，后续可扩展）
        return Task.FromResult(new UnifiedAppResponse
        {
            RequestId = request.RequestId,
            Status = AppResponseStatus.Failed,
            Message = "内部应用调用暂未实现",
            Error = new ResponseError
            {
                Code = "NOT_IMPLEMENTED",
                Message = "内部应用调用暂未实现",
                Retryable = false,
            },
        });
    }

    private async Task<UnifiedAppResponse> InvokeExternalAppAsync(RegisteredApp app, UnifiedAppRequest request, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient();

        // 设置认证
        if (app.AuthType == AppAuthType.ApiKey && !string.IsNullOrEmpty(app.ApiKey))
        {
            client.DefaultRequestHeaders.Add("X-API-Key", app.ApiKey);
        }
        else if (app.AuthType == AppAuthType.Bearer && !string.IsNullOrEmpty(app.ApiKey))
        {
            client.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", app.ApiKey);
        }

        var json = JsonSerializer.Serialize(request, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });

        var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");

        var response = await client.PostAsync(app.Endpoint, content, ct);
        var responseBody = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            return new UnifiedAppResponse
            {
                RequestId = request.RequestId,
                Status = AppResponseStatus.Failed,
                Message = $"应用返回错误: {response.StatusCode}",
                Error = new ResponseError
                {
                    Code = response.StatusCode.ToString(),
                    Message = responseBody,
                    Retryable = (int)response.StatusCode >= 500,
                },
            };
        }

        try
        {
            var appResponse = JsonSerializer.Deserialize<UnifiedAppResponse>(responseBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });

            return appResponse ?? new UnifiedAppResponse
            {
                RequestId = request.RequestId,
                Status = AppResponseStatus.Failed,
                Message = "应用返回无效响应",
            };
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "解析应用响应失败: {Response}", responseBody);
            return new UnifiedAppResponse
            {
                RequestId = request.RequestId,
                Status = AppResponseStatus.Success,
                Message = "处理完成（响应格式非标准）",
                Result = new ResponseResult { Content = responseBody },
                Reply = new ResponseReply { ShouldReply = true, Content = responseBody },
            };
        }
    }

    private async Task UpdateAppStatsAsync(string appId, bool success, long durationMs, CancellationToken ct)
    {
        var update = success
            ? Builders<RegisteredApp>.Update
                .Inc(x => x.Stats.TotalInvocations, 1)
                .Inc(x => x.Stats.SuccessCount, 1)
                .Set(x => x.Stats.LastInvokedAt, DateTime.UtcNow)
            : Builders<RegisteredApp>.Update
                .Inc(x => x.Stats.TotalInvocations, 1)
                .Inc(x => x.Stats.FailureCount, 1)
                .Set(x => x.Stats.LastInvokedAt, DateTime.UtcNow);

        await _db.RegisteredApps.UpdateOneAsync(x => x.AppId == appId, update, cancellationToken: ct);
    }
}
