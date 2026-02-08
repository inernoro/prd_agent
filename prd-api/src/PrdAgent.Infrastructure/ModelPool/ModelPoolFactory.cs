using Microsoft.Extensions.Logging;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.ModelPool.Models;

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
    /// <param name="jwtSecret">解密 API Key 的密钥</param>
    /// <returns>模型池实例</returns>
    public IModelPool Create(ModelGroup group, IReadOnlyList<LLMPlatform> platforms, string jwtSecret)
    {
        var endpoints = BuildEndpoints(group, platforms, jwtSecret);
        var strategyType = (PoolStrategyType)group.StrategyType;

        return ModelPoolDispatcher.Create(
            poolId: group.Id,
            poolName: group.Name,
            endpoints: endpoints,
            strategyType: strategyType,
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
        string jwtSecret)
    {
        var endpoints = new List<PoolEndpoint>();

        foreach (var model in group.Models ?? new List<ModelGroupItem>())
        {
            var platform = platforms.FirstOrDefault(p => p.Id == model.PlatformId && p.Enabled);
            if (platform == null) continue;

            var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
                ? null
                : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);

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
