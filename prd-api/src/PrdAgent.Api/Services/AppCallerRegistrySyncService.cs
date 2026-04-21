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

        // 预加载可用模型组，用于新 AppCaller 的自动绑定（避免手动操作）
        var allModelGroups = await db.ModelGroups.Find(_ => true).ToListAsync(ct);
        var defaultChatGroupId = allModelGroups
            .Where(g => !string.Equals(g.Name, "videogen-default", StringComparison.OrdinalIgnoreCase))
            .Where(g => g.Name?.Contains("video", StringComparison.OrdinalIgnoreCase) != true)
            .Select(g => g.Id)
            .FirstOrDefault();

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

                existing.ModelRequirements.Add(new AppModelRequirement
                {
                    ModelType = modelType,
                    Purpose = $"用于{def.DisplayName}",
                    IsRequired = true,
                    ModelGroupIds = new List<string>()
                });
                changed = true;
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
}
