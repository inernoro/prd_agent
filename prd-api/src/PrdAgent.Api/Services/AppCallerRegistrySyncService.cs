using System.Linq;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 启动时同步 AppCallerRegistry 到 llm_app_callers（增量、幂等、非破坏性）。
/// 目标：
/// 1) 新增代码中的 AppCallerDefinition 能自动入库，避免管理台“看不到”
/// 2) 不删除用户自定义应用，不重置已绑定模型池
/// </summary>
public sealed class AppCallerRegistrySyncService : IHostedService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<AppCallerRegistrySyncService> _logger;

    public AppCallerRegistrySyncService(
        IServiceProvider serviceProvider,
        ILogger<AppCallerRegistrySyncService> logger)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _serviceProvider.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            await SyncAsync(db, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "启动同步 AppCallerRegistry 失败");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task SyncAsync(MongoDbContext db, CancellationToken ct)
    {
        var definitions = AppCallerRegistrationService.GetAllDefinitions();
        var existingApps = await db.LLMAppCallers.Find(_ => true).ToListAsync(ct);
        var existingByCode = existingApps
            .GroupBy(x => x.AppCode, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

        // 预加载可用模型组，用于新 AppCaller 的 chat 自动绑定（必须与 ModelType=chat 对齐）
        var allModelGroups = await db.ModelGroups.Find(_ => true).ToListAsync(ct);
        var validGroupIds = new HashSet<string>(allModelGroups.Select(g => g.Id), StringComparer.Ordinal);
        var defaultChatGroupId = PickDefaultChatModelGroupId(allModelGroups);
        if (defaultChatGroupId == null)
        {
            _logger.LogWarning(
                "[AppCallerSync] 未找到可用的 chat 模型组（需 ModelType=chat 且至少含 1 个模型），跳过 chat 自动绑定");
        }

        var createdCount = 0;
        var updatedCount = 0;
        var unchangedCount = 0;

        foreach (var def in definitions)
        {
            if (!existingByCode.TryGetValue(def.AppCode, out var existing))
            {
                var requirements = BuildDefaultRequirements(def);
                // 新注册的 AppCaller 若需要 chat 模型，自动绑定环境中第一个可用模型组
                if (defaultChatGroupId != null)
                {
                    foreach (var req in requirements.Where(r => r.ModelType == "chat"))
                    {
                        if (req.ModelGroupIds.Count == 0)
                            req.ModelGroupIds.Add(defaultChatGroupId);
                    }
                }

                var app = new LLMAppCaller
                {
                    Id = Guid.NewGuid().ToString("N"),
                    AppCode = def.AppCode,
                    DisplayName = def.DisplayName,
                    Description = def.Description,
                    ModelRequirements = requirements,
                    IsSystemDefault = true,
                    IsAutoRegistered = false,
                    TotalCalls = 0,
                    SuccessCalls = 0,
                    FailedCalls = 0,
                    LastCalledAt = null,
                    CreatedAt = DateTime.UtcNow,
                    UpdatedAt = DateTime.UtcNow
                };

                try
                {
                    await db.LLMAppCallers.InsertOneAsync(app, cancellationToken: ct);
                    createdCount++;
                }
                catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                {
                    // 多实例并发启动下，可能已被其他实例创建，忽略即可。
                    _logger.LogDebug("AppCaller 并发创建已存在: {AppCode}", def.AppCode);
                }

                continue;
            }

            // 仅托管系统默认或历史自动注册项；用户自定义保持不变。
            if (!existing.IsSystemDefault && !existing.IsAutoRegistered)
            {
                unchangedCount++;
                continue;
            }

            var changed = false;
            if (!string.Equals(existing.DisplayName, def.DisplayName, StringComparison.Ordinal))
            {
                existing.DisplayName = def.DisplayName;
                changed = true;
            }

            if (!string.Equals(existing.Description ?? string.Empty, def.Description ?? string.Empty, StringComparison.Ordinal))
            {
                existing.Description = def.Description;
                changed = true;
            }

            if (!existing.IsSystemDefault)
            {
                existing.IsSystemDefault = true;
                changed = true;
            }

            if (existing.IsAutoRegistered)
            {
                existing.IsAutoRegistered = false;
                changed = true;
            }

            existing.ModelRequirements ??= new List<AppModelRequirement>();
            var existingTypes = existing.ModelRequirements
                .Select(r => r.ModelType)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            foreach (var modelType in def.ModelTypes)
            {
                if (existingTypes.Contains(modelType))
                    continue;

                var newReq = new AppModelRequirement
                {
                    ModelType = modelType,
                    Purpose = $"用于{def.DisplayName}",
                    IsRequired = true,
                    ModelGroupIds = new List<string>()
                };
                // 新增 chat 类型 requirement 时自动绑定环境内首个非视频 chat 模型组
                if (defaultChatGroupId != null && string.Equals(modelType, "chat", StringComparison.OrdinalIgnoreCase))
                {
                    newReq.ModelGroupIds.Add(defaultChatGroupId);
                }
                existing.ModelRequirements.Add(newReq);
                changed = true;
            }

            // 防御性回填：chat 的 ModelGroupIds 为空，或引用的组 ID 已从库中删除（脏数据），
            // 自动绑定默认 chat 模型组，避免 Gateway 解析失败
            if (defaultChatGroupId != null)
            {
                foreach (var req in existing.ModelRequirements
                             .Where(r => string.Equals(r.ModelType, "chat", StringComparison.OrdinalIgnoreCase)))
                {
                    req.ModelGroupIds ??= new List<string>();
                    var beforeCount = req.ModelGroupIds.Count;
                    req.ModelGroupIds = req.ModelGroupIds.Where(id => validGroupIds.Contains(id)).Distinct().ToList();
                    if (req.ModelGroupIds.Count == 0)
                    {
                        req.ModelGroupIds.Add(defaultChatGroupId);
                        changed = true;
                        _logger.LogInformation(
                            "[AppCallerSync] 自动回填 chat 模型组绑定: {AppCode} (清理后 {Before}->{After}) -> {GroupId}",
                            existing.AppCode, beforeCount, req.ModelGroupIds.Count, defaultChatGroupId);
                    }
                    else if (beforeCount != req.ModelGroupIds.Count)
                    {
                        changed = true;
                        _logger.LogInformation(
                            "[AppCallerSync] 移除无效 chat 模型组引用: {AppCode} 保留 {Count} 个有效 ID",
                            existing.AppCode, req.ModelGroupIds.Count);
                    }
                }
            }

            if (!changed)
            {
                unchangedCount++;
                continue;
            }

            existing.UpdatedAt = DateTime.UtcNow;
            await db.LLMAppCallers.ReplaceOneAsync(x => x.Id == existing.Id, existing, cancellationToken: ct);
            updatedCount++;
        }

        _logger.LogInformation(
            "AppCallerRegistry 启动同步完成: registry={RegistryCount}, created={Created}, updated={Updated}, unchanged={Unchanged}",
            definitions.Count, createdCount, updatedCount, unchangedCount);
    }

    private static List<AppModelRequirement> BuildDefaultRequirements(AppCallerDefinition def)
    {
        return def.ModelTypes.Select(modelType => new AppModelRequirement
        {
            ModelType = modelType,
            Purpose = $"用于{def.DisplayName}",
            IsRequired = true,
            ModelGroupIds = new List<string>()
        }).ToList();
    }

    /// <summary>
    /// 为 chat 类 AppCaller 选择默认模型组：优先 IsDefaultForType 的 chat 池，其次任意含模型的 chat 池。
    /// 禁止用非 chat 类型的分组冒充，否则 Gateway 仍无法解析。
    /// </summary>
    private static string? PickDefaultChatModelGroupId(IReadOnlyList<ModelGroup> groups)
    {
        var chatCandidates = groups
            .Where(g => string.Equals(g.ModelType, "chat", StringComparison.OrdinalIgnoreCase))
            .Where(g => g.Models is { Count: > 0 })
            .ToList();

        if (chatCandidates.Count == 0)
            return null;

        var preferred = chatCandidates.FirstOrDefault(g => g.IsDefaultForType);
        if (preferred != null)
            return preferred.Id;

        return chatCandidates
            .Where(g => !string.Equals(g.Name, "videogen-default", StringComparison.OrdinalIgnoreCase))
            .Where(g => g.Name?.Contains("video", StringComparison.OrdinalIgnoreCase) != true)
            .OrderBy(g => g.Priority)
            .Select(g => g.Id)
            .FirstOrDefault()
            ?? chatCandidates.OrderBy(g => g.Priority).Select(g => g.Id).FirstOrDefault();
    }
}
