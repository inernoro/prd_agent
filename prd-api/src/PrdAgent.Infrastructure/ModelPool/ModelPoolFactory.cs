using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池工厂 - 从 ModelGroup + 平台配置构建 IModelPool 实例
/// 渐进式改造的桥梁：将现有数据模型转换为独立模型池组件
/// </summary>
public class ModelPoolFactory
{
    private readonly IPoolHttpDispatcher _httpDispatcher;
    private readonly ILogger? _logger;

    public ModelPoolFactory(IPoolHttpDispatcher httpDispatcher, ILogger? logger = null)
    {
        _httpDispatcher = httpDispatcher;
        _logger = logger;
    }

    /// <summary>
    /// 从 ModelGroup 和平台列表构建模型池实例
    /// </summary>
    /// <param name="group">模型分组</param>
    /// <param name="platforms">平台配置列表（包含 API URL 和密钥）</param>
    /// <param name="configuration">API key 加密钥匙环配置</param>
    /// <returns>模型池实例</returns>
    public IModelPool Create(ModelGroup group, IReadOnlyList<LLMPlatform> platforms, IConfiguration configuration)
    {
        var endpoints = BuildEndpoints(group, platforms, configuration);

        // 调度策略已化简为只有 FailFast：非 FailFast 策略引擎是纯管理工具死代码，已删除。
        // group.StrategyType 字段保留（数据兼容，存量值均为 0=FailFast），但池一律按 FailFast 构建。
        return ModelPoolDispatcher.Create(
            poolId: group.Id,
            poolName: group.Name,
            endpoints: endpoints,
            strategyType: PoolStrategyType.FailFast,
            httpDispatcher: _httpDispatcher,
            healthTracker: BuildHealthTracker(group),
            logger: _logger);
    }

    public IModelPool Create(ModelGroup group, IReadOnlyList<LLMPlatform> platforms, string apiKeySecret)
    {
        var endpoints = BuildEndpoints(group, platforms, apiKeySecret);

        // 同上：一律 FailFast。
        return ModelPoolDispatcher.Create(
            poolId: group.Id,
            poolName: group.Name,
            endpoints: endpoints,
            strategyType: PoolStrategyType.FailFast,
            httpDispatcher: _httpDispatcher,
            healthTracker: BuildHealthTracker(group),
            logger: _logger);
    }

    /// <summary>
    /// 从 ModelGroup 构建端点列表
    /// </summary>
    public static List<PoolEndpoint> BuildEndpoints(
        ModelGroup group,
        IReadOnlyList<LLMPlatform> platforms,
        IConfiguration configuration)
    {
        var endpoints = new List<PoolEndpoint>();

        foreach (var model in group.Models ?? new List<ModelGroupItem>())
        {
            var platform = platforms.FirstOrDefault(p => p.Id == model.PlatformId && p.Enabled);
            if (platform == null) continue;

            var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(platform.ApiKeyEncrypted, configuration);

            endpoints.Add(new PoolEndpoint
            {
                EndpointId = $"{model.PlatformId}:{model.ModelId}",
                ModelId = model.ModelId,
                PlatformId = model.PlatformId,
                PlatformType = platform.PlatformType,
                PlatformName = platform.Name,
                ApiUrl = platform.ApiUrl,
                ApiKey = apiKey,
                Priority = model.Priority,
                MaxTokens = model.MaxTokens,
                EnablePromptCache = model.EnablePromptCache
            });
        }

        return endpoints;
    }

    public static List<PoolEndpoint> BuildEndpoints(
        ModelGroup group,
        IReadOnlyList<LLMPlatform> platforms,
        string apiKeySecret)
    {
        var endpoints = new List<PoolEndpoint>();

        foreach (var model in group.Models ?? new List<ModelGroupItem>())
        {
            var platform = platforms.FirstOrDefault(p => p.Id == model.PlatformId && p.Enabled);
            if (platform == null) continue;

            var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
                ? null
                : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, apiKeySecret);

            endpoints.Add(new PoolEndpoint
            {
                EndpointId = $"{model.PlatformId}:{model.ModelId}",
                ModelId = model.ModelId,
                PlatformId = model.PlatformId,
                PlatformType = platform.PlatformType,
                PlatformName = platform.Name,
                ApiUrl = platform.ApiUrl,
                ApiKey = apiKey,
                Priority = model.Priority,
                MaxTokens = model.MaxTokens,
                EnablePromptCache = model.EnablePromptCache
            });
        }

        return endpoints;
    }

    /// <summary>
    /// 从 ModelGroup 的现有健康数据构建 PoolHealthTracker
    /// 将 ModelGroupItem 的健康状态同步到 PoolHealthTracker
    /// </summary>
    private static PoolHealthTracker BuildHealthTracker(ModelGroup group)
    {
        var tracker = new PoolHealthTracker();

        foreach (var model in group.Models ?? new List<ModelGroupItem>())
        {
            var endpointId = $"{model.PlatformId}:{model.ModelId}";

            // 同步现有健康状态
            for (int i = 0; i < model.ConsecutiveFailures; i++)
                tracker.RecordFailure(endpointId);

            if (model.HealthStatus == ModelHealthStatus.Healthy && model.ConsecutiveSuccesses > 0)
            {
                // 如果是健康状态，记录一次成功来重置
                tracker.RecordSuccess(endpointId, 0);
            }
        }

        return tracker;
    }
}
