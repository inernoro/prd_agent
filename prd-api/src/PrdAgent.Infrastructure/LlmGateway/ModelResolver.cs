using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 模型调度执行器实现
/// </summary>
public class ModelResolver : IModelResolver
{
    private readonly MongoDbContext _db;
    private readonly IConfiguration _config;
    private readonly ILogger<ModelResolver> _logger;

    public ModelResolver(
        MongoDbContext db,
        IConfiguration config,
        ILogger<ModelResolver> logger)
    {
        _db = db;
        _config = config;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task<ModelResolutionResult> ResolveAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        var plan = new ModelResolutionPlan
        {
            AppCallerCode = appCallerCode,
            ModelType = modelType,
            ExpectedModel = expectedModel
        };

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";

        // ========== 第一步：查找 AppCaller 配置 ==========
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == appCallerCode)
            .FirstOrDefaultAsync(ct);

        List<ModelGroup>? candidateGroups = null;
        string resolutionType = "NotFound";

        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (requirement?.ModelGroupIds?.Count > 0)
            {
                // ========== 第二步：查找专属模型池 ==========
                candidateGroups = await _db.ModelGroups
                    .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                    .SortBy(g => g.Priority)
                    .ToListAsync(ct);

                if (candidateGroups.Count > 0)
                {
                    resolutionType = "DedicatedPool";
                    _logger.LogDebug(
                        "[ModelResolver] 找到专属模型池: AppCallerCode={Code}, PoolCount={Count}, PoolNames={Names}",
                        appCallerCode, candidateGroups.Count,
                        string.Join(", ", candidateGroups.Select(g => g.Name)));
                }
            }
        }

        // ========== 第三步：回退到默认模型池 ==========
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            candidateGroups = await _db.ModelGroups
                .Find(g => g.ModelType == modelType && g.IsDefaultForType)
                .SortBy(g => g.Priority)
                .ToListAsync(ct);

            if (candidateGroups.Count > 0)
            {
                resolutionType = "DefaultPool";
                _logger.LogDebug(
                    "[ModelResolver] 使用默认模型池: ModelType={Type}, PoolCount={Count}, PoolNames={Names}",
                    modelType, candidateGroups.Count,
                    string.Join(", ", candidateGroups.Select(g => g.Name)));
            }
        }

        // ========== 第四步：回退到传统配置 ==========
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            var legacyModel = await FindLegacyModelAsync(modelType, ct);

            _logger.LogInformation(
                "[ModelResolver] 查找传统配置: ModelType={Type}, Found={Found}, ModelName={Name}, PlatformId={PlatformId}",
                modelType, legacyModel != null, legacyModel?.Name, legacyModel?.PlatformId);

            if (legacyModel != null)
            {
                var platform = await _db.LLMPlatforms
                    .Find(p => p.Id == legacyModel.PlatformId && p.Enabled)
                    .FirstOrDefaultAsync(ct);

                if (platform == null)
                {
                    // 诊断：平台未找到的原因
                    var platformById = await _db.LLMPlatforms
                        .Find(p => p.Id == legacyModel.PlatformId)
                        .FirstOrDefaultAsync(ct);

                    _logger.LogWarning(
                        "[ModelResolver] 传统配置平台查找失败: PlatformId={PlatformId}, PlatformExists={Exists}, PlatformEnabled={Enabled}",
                        legacyModel.PlatformId,
                        platformById != null,
                        platformById?.Enabled);
                }

                if (platform != null)
                {
                    var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
                        ? null
                        : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);

                    _logger.LogInformation(
                        "[ModelResolver] 使用传统配置模型: ModelType={Type}, Model={Model}, Platform={Platform}",
                        modelType, legacyModel.ModelName, platform.Name);

                    return ModelResolutionResult.FromLegacy(expectedModel, legacyModel, platform, apiKey);
                }
            }
        }

        // ========== 第五步：无可用模型 ==========
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            _logger.LogWarning(
                "[ModelResolver] 未找到可用模型: AppCallerCode={Code}, ModelType={Type}",
                appCallerCode, modelType);

            return ModelResolutionResult.NotFound(expectedModel,
                $"未找到可用模型: AppCallerCode={appCallerCode}, ModelType={modelType}");
        }

        // ========== 第六步：从模型池中选择最佳模型 ==========
        foreach (var group in candidateGroups)
        {
            // 诊断：模型池内容
            _logger.LogInformation(
                "[ModelResolver] 检查模型池 {PoolName}: 模型数={Count}, 模型列表=[{Models}]",
                group.Name,
                group.Models?.Count ?? 0,
                string.Join(", ", group.Models?.Select(m =>
                    $"{m.ModelId}(Health={m.HealthStatus}, Platform={m.PlatformId})") ?? Array.Empty<string>()));

            var selectedModel = SelectBestModel(group);
            if (selectedModel == null)
            {
                _logger.LogWarning(
                    "[ModelResolver] 模型池 {PoolName} 中无可用模型（全部 Unavailable 或为空）",
                    group.Name);
                continue;
            }

            var platform = await _db.LLMPlatforms
                .Find(p => p.Id == selectedModel.PlatformId && p.Enabled)
                .FirstOrDefaultAsync(ct);

            if (platform == null)
            {
                // 诊断：平台查找失败
                var platformById = await _db.LLMPlatforms
                    .Find(p => p.Id == selectedModel.PlatformId)
                    .FirstOrDefaultAsync(ct);

                _logger.LogWarning(
                    "[ModelResolver] 模型池 {PoolName} 中的模型 {ModelId} 平台不可用: PlatformId={PlatformId}, Exists={Exists}, Enabled={Enabled}",
                    group.Name, selectedModel.ModelId, selectedModel.PlatformId,
                    platformById != null, platformById?.Enabled);
                continue;
            }

            var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
                ? null
                : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);

            _logger.LogInformation(
                "[ModelResolver] 调度完成\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ResolutionType: {ResolutionType}\n" +
                "  ModelGroup: {GroupName} ({GroupId})\n" +
                "  ExpectedModel: {Expected}\n" +
                "  ActualModel: {Actual}\n" +
                "  Platform: {Platform}\n" +
                "  HealthStatus: {Health}",
                appCallerCode, resolutionType, group.Name, group.Id,
                expectedModel ?? "(无)", selectedModel.ModelId,
                platform.Name, selectedModel.HealthStatus);

            return ModelResolutionResult.FromPool(
                resolutionType, expectedModel, selectedModel, group, platform, apiKey);
        }

        // ========== 第七步：模型池全部不可用，回退到传统配置 ==========
        _logger.LogInformation(
            "[ModelResolver] 模型池内所有模型不可用，尝试回退传统配置: AppCallerCode={Code}, ModelType={Type}",
            appCallerCode, modelType);

        var fallbackLegacyModel = await FindLegacyModelAsync(modelType, ct);

        _logger.LogInformation(
            "[ModelResolver] 传统配置回退查找: ModelType={Type}, Found={Found}, ModelName={Name}, PlatformId={PlatformId}",
            modelType, fallbackLegacyModel != null, fallbackLegacyModel?.Name, fallbackLegacyModel?.PlatformId);

        if (fallbackLegacyModel != null)
        {
            var fallbackPlatform = await _db.LLMPlatforms
                .Find(p => p.Id == fallbackLegacyModel.PlatformId && p.Enabled)
                .FirstOrDefaultAsync(ct);

            if (fallbackPlatform != null)
            {
                var apiKey = string.IsNullOrEmpty(fallbackPlatform.ApiKeyEncrypted)
                    ? null
                    : ApiKeyCrypto.Decrypt(fallbackPlatform.ApiKeyEncrypted, jwtSecret);

                _logger.LogInformation(
                    "[ModelResolver] 回退到传统配置模型: ModelType={Type}, Model={Model}, Platform={Platform}",
                    modelType, fallbackLegacyModel.ModelName, fallbackPlatform.Name);

                return ModelResolutionResult.FromLegacy(expectedModel, fallbackLegacyModel, fallbackPlatform, apiKey);
            }
            else
            {
                var platformById = await _db.LLMPlatforms
                    .Find(p => p.Id == fallbackLegacyModel.PlatformId)
                    .FirstOrDefaultAsync(ct);

                _logger.LogWarning(
                    "[ModelResolver] 传统配置平台查找失败: PlatformId={PlatformId}, Exists={Exists}, Enabled={Enabled}",
                    fallbackLegacyModel.PlatformId, platformById != null, platformById?.Enabled);
            }
        }

        // 所有模型池都没有可用模型，传统配置也没有
        _logger.LogWarning(
            "[ModelResolver] 所有调度方式均失败: AppCallerCode={Code}, ModelType={Type}",
            appCallerCode, modelType);

        return ModelResolutionResult.NotFound(expectedModel,
            "模型池内所有模型不可用且传统配置也未找到");
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
                    return result;
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

    /// <inheritdoc />
    public async Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId) ||
            string.IsNullOrWhiteSpace(resolution.ActualPlatformId) ||
            string.IsNullOrWhiteSpace(resolution.ActualModel))
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

            _logger.LogDebug(
                "[ModelResolver] 记录成功: Model={Model}, Group={Group}",
                resolution.ActualModel, resolution.ModelGroupName);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ModelResolver] 记录成功状态失败");
        }
    }

    /// <inheritdoc />
    public async Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId) ||
            string.IsNullOrWhiteSpace(resolution.ActualPlatformId) ||
            string.IsNullOrWhiteSpace(resolution.ActualModel))
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
                "[ModelResolver] 记录失败: Model={Model}, Failures={Count}, Status={Status}",
                resolution.ActualModel, newFailures, newStatus);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ModelResolver] 记录失败状态失败");
        }
    }

    #region Private Methods

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

        // 最后选择任意可用模型（排除 Unavailable）
        return group.Models
            .Where(m => m.HealthStatus != ModelHealthStatus.Unavailable)
            .OrderBy(m => m.Priority)
            .FirstOrDefault();
    }

    private async Task<LLMModel?> FindLegacyModelAsync(string modelType, CancellationToken ct)
    {
        LLMModel? result = modelType.ToLowerInvariant() switch
        {
            "chat" => await _db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefaultAsync(ct),
            "intent" => await _db.LLMModels.Find(m => m.IsIntent && m.Enabled).FirstOrDefaultAsync(ct),
            "vision" => await _db.LLMModels.Find(m => m.IsVision && m.Enabled).FirstOrDefaultAsync(ct),
            "generation" => await _db.LLMModels.Find(m => m.IsImageGen && m.Enabled).FirstOrDefaultAsync(ct),
            _ => null
        };

        // Debug: 如果未找到 generation 模型，额外查询诊断
        if (result == null && modelType.ToLowerInvariant() == "generation")
        {
            var allImageGenModels = await _db.LLMModels
                .Find(m => m.IsImageGen)
                .ToListAsync(ct);

            _logger.LogWarning(
                "[ModelResolver] 未找到启用的 generation 模型。" +
                "IsImageGen=true 的模型共 {Count} 个: {Models}",
                allImageGenModels.Count,
                string.Join(", ", allImageGenModels.Select(m => $"{m.Name}(Enabled={m.Enabled}, PlatformId={m.PlatformId})")));
        }

        return result;
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

    #endregion
}

/// <summary>
/// 内存模型调度器（用于单元测试）
/// 允许注入 Mock 数据而无需数据库
/// </summary>
public class InMemoryModelResolver : IModelResolver
{
    private readonly List<LLMAppCaller> _appCallers = new();
    private readonly List<ModelGroup> _modelGroups = new();
    private readonly List<LLMModel> _legacyModels = new();
    private readonly List<LLMPlatform> _platforms = new();
    private readonly Dictionary<string, string> _apiKeys = new();

    /// <summary>
    /// 添加 AppCaller 配置
    /// </summary>
    public InMemoryModelResolver WithAppCaller(LLMAppCaller appCaller)
    {
        _appCallers.Add(appCaller);
        return this;
    }

    /// <summary>
    /// 添加模型池
    /// </summary>
    public InMemoryModelResolver WithModelGroup(ModelGroup group)
    {
        _modelGroups.Add(group);
        return this;
    }

    /// <summary>
    /// 添加传统模型配置
    /// </summary>
    public InMemoryModelResolver WithLegacyModel(LLMModel model)
    {
        _legacyModels.Add(model);
        return this;
    }

    /// <summary>
    /// 添加平台配置
    /// </summary>
    public InMemoryModelResolver WithPlatform(LLMPlatform platform, string? apiKey = null)
    {
        _platforms.Add(platform);
        if (!string.IsNullOrWhiteSpace(apiKey))
            _apiKeys[platform.Id] = apiKey;
        return this;
    }

    public Task<ModelResolutionResult> ResolveAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        // Step 1: 查找 AppCaller
        var appCaller = _appCallers.FirstOrDefault(a => a.AppCode == appCallerCode);
        List<ModelGroup>? candidateGroups = null;
        string resolutionType = "NotFound";

        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (requirement?.ModelGroupIds?.Count > 0)
            {
                // Step 2: 专属模型池
                candidateGroups = _modelGroups
                    .Where(g => requirement.ModelGroupIds.Contains(g.Id))
                    .OrderBy(g => g.Priority)
                    .ToList();

                if (candidateGroups.Count > 0)
                    resolutionType = "DedicatedPool";
            }
        }

        // Step 3: 默认模型池
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            candidateGroups = _modelGroups
                .Where(g => g.ModelType == modelType && g.IsDefaultForType)
                .OrderBy(g => g.Priority)
                .ToList();

            if (candidateGroups.Count > 0)
                resolutionType = "DefaultPool";
        }

        // Step 4: 传统配置
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            var legacyModel = modelType.ToLowerInvariant() switch
            {
                "chat" => _legacyModels.FirstOrDefault(m => m.IsMain && m.Enabled),
                "intent" => _legacyModels.FirstOrDefault(m => m.IsIntent && m.Enabled),
                "vision" => _legacyModels.FirstOrDefault(m => m.IsVision && m.Enabled),
                "generation" => _legacyModels.FirstOrDefault(m => m.IsImageGen && m.Enabled),
                _ => null
            };

            if (legacyModel != null)
            {
                var platform = _platforms.FirstOrDefault(p => p.Id == legacyModel.PlatformId && p.Enabled);
                if (platform != null)
                {
                    _apiKeys.TryGetValue(platform.Id, out var apiKey);
                    return Task.FromResult(ModelResolutionResult.FromLegacy(
                        expectedModel, legacyModel, platform, apiKey));
                }
            }
        }

        // Step 5: 无可用模型
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            return Task.FromResult(ModelResolutionResult.NotFound(expectedModel,
                $"未找到可用模型: AppCallerCode={appCallerCode}, ModelType={modelType}"));
        }

        // Step 6: 从模型池选择
        foreach (var group in candidateGroups)
        {
            var selectedModel = group.Models?
                .Where(m => m.HealthStatus != ModelHealthStatus.Unavailable)
                .OrderBy(m => m.HealthStatus == ModelHealthStatus.Healthy ? 0 : 1)
                .ThenBy(m => m.Priority)
                .FirstOrDefault();

            if (selectedModel == null)
                continue;

            var platform = _platforms.FirstOrDefault(p => p.Id == selectedModel.PlatformId && p.Enabled);
            if (platform == null)
                continue;

            _apiKeys.TryGetValue(platform.Id, out var apiKey);
            return Task.FromResult(ModelResolutionResult.FromPool(
                resolutionType, expectedModel, selectedModel, group, platform, apiKey));
        }

        return Task.FromResult(ModelResolutionResult.NotFound(expectedModel,
            "模型池内所有模型不可用"));
    }

    public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        var result = new List<AvailableModelPool>();

        // 专属池
        var appCaller = _appCallers.FirstOrDefault(a => a.AppCode == appCallerCode);
        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (requirement?.ModelGroupIds?.Count > 0)
            {
                var dedicatedGroups = _modelGroups
                    .Where(g => requirement.ModelGroupIds.Contains(g.Id))
                    .OrderBy(g => g.Priority);

                foreach (var group in dedicatedGroups)
                {
                    result.Add(MapToAvailablePool(group, "DedicatedPool", true, false));
                }

                if (result.Count > 0)
                    return Task.FromResult(result);
            }
        }

        // 默认池
        var defaultGroups = _modelGroups
            .Where(g => g.ModelType == modelType && g.IsDefaultForType)
            .OrderBy(g => g.Priority);

        foreach (var group in defaultGroups)
        {
            result.Add(MapToAvailablePool(group, "DefaultPool", false, true));
        }

        return Task.FromResult(result);
    }

    public Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        // 内存版本：更新 Models 列表中的健康状态
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            return Task.CompletedTask;

        var group = _modelGroups.FirstOrDefault(g => g.Id == resolution.ModelGroupId);
        var model = group?.Models?.FirstOrDefault(m =>
            m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);

        if (model != null)
        {
            model.ConsecutiveSuccesses++;
            model.ConsecutiveFailures = 0;
            model.HealthStatus = ModelHealthStatus.Healthy;
            model.LastSuccessAt = DateTime.UtcNow;
        }

        return Task.CompletedTask;
    }

    public Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            return Task.CompletedTask;

        var group = _modelGroups.FirstOrDefault(g => g.Id == resolution.ModelGroupId);
        var model = group?.Models?.FirstOrDefault(m =>
            m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);

        if (model != null)
        {
            model.ConsecutiveFailures++;
            model.ConsecutiveSuccesses = 0;
            model.HealthStatus = model.ConsecutiveFailures >= 5 ? ModelHealthStatus.Unavailable :
                                 model.ConsecutiveFailures >= 3 ? ModelHealthStatus.Degraded :
                                 ModelHealthStatus.Healthy;
            model.LastFailedAt = DateTime.UtcNow;
        }

        return Task.CompletedTask;
    }

    private AvailableModelPool MapToAvailablePool(
        ModelGroup group,
        string resolutionType,
        bool isDedicated,
        bool isDefault)
    {
        return new AvailableModelPool
        {
            Id = group.Id,
            Name = group.Name,
            Code = group.Code,
            Priority = group.Priority,
            ResolutionType = resolutionType,
            IsDedicated = isDedicated,
            IsDefault = isDefault,
            Models = (group.Models ?? new List<ModelGroupItem>())
                .Select(m =>
                {
                    var platform = _platforms.FirstOrDefault(p => p.Id == m.PlatformId);
                    return new PoolModelInfo
                    {
                        ModelId = m.ModelId,
                        PlatformId = m.PlatformId,
                        PlatformName = platform?.Name,
                        Priority = m.Priority,
                        HealthStatus = m.HealthStatus.ToString(),
                        HealthScore = m.HealthStatus switch
                        {
                            ModelHealthStatus.Healthy => 100,
                            ModelHealthStatus.Degraded => 50,
                            _ => 0
                        }
                    };
                })
                .ToList()
        };
    }
}
