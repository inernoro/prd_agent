using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 业务侧模型目录适配器。
///
/// 模型池路由已经退场，业务选择器必须与运行时解析器读取同一份对外逻辑模型目录。
/// 这里保留旧 DTO 只是为了兼容尚未迁移的 Controller 和前端，不能再自行查询 MAP 的
/// <c>model_groups</c> / <c>llm_models</c>；否则页面会继续展示运行时已经不认识的旧成员名。
/// </summary>
public class ModelPoolQueryService : IModelPoolQueryService
{
    private readonly ILlmGateway _gateway;

    public ModelPoolQueryService(ILlmGateway gateway)
    {
        _gateway = gateway;
    }

    public async Task<List<ModelPoolForAppResult>> GetModelPoolsAsync(
        string? appCallerCode, string modelType, CancellationToken ct = default)
    {
        var requestedCaller = appCallerCode?.Trim();
        var catalogCaller = string.IsNullOrWhiteSpace(requestedCaller)
            ? ResolveRegisteredCatalogCaller(modelType)
            : requestedCaller;
        var available = await _gateway.GetAvailablePoolsAsync(
            catalogCaller,
            modelType,
            ct);
        if (string.IsNullOrWhiteSpace(appCallerCode))
        {
            available = available.Where(pool => pool.IsDefault).ToList();
        }
        return available
            .Select(pool => MapToResult(pool, modelType))
            .OrderByDescending(pool => pool.IsDefault)
            .ThenBy(pool => pool.Priority)
            .ThenBy(pool => pool.Code, StringComparer.Ordinal)
            .ToList();
    }

    internal static string ResolveRegisteredCatalogCaller(string modelType)
    {
        var systemCatalogCaller = modelType switch
        {
            ModelTypes.Chat => AppCallerRegistry.System.HealthProbe.Chat,
            ModelTypes.Intent => AppCallerRegistry.System.HealthProbe.Intent,
            ModelTypes.Vision => AppCallerRegistry.System.HealthProbe.Vision,
            ModelTypes.ImageGen => AppCallerRegistry.System.HealthProbe.Generation,
            _ => null,
        };
        if (systemCatalogCaller is not null)
            return systemCatalogCaller;

        var caller = AppCallerRegistrationService.GetAllDefinitions()
            .Where(definition => definition.ModelTypes.Contains(modelType, StringComparer.OrdinalIgnoreCase))
            .OrderBy(definition => definition.Priority)
            .ThenBy(definition => definition.AppCode, StringComparer.Ordinal)
            .Select(definition => definition.AppCode)
            .FirstOrDefault();
        return caller ?? throw new InvalidOperationException($"没有注册支持 {modelType} 的目录调用方。");
    }

    internal static ModelPoolForAppResult MapToResult(AvailableModelPool pool, string modelType)
    {
        return new ModelPoolForAppResult
        {
            Id = pool.Id,
            Name = pool.Name,
            Code = pool.Code,
            Priority = pool.Priority,
            ModelType = modelType,
            IsDefaultForType = pool.IsDefault,
            Description = pool.Description,
            Models = pool.Models.Select(model => new ModelPoolModelItem
            {
                ModelId = model.ModelId,
                PlatformId = model.PlatformId,
                Priority = model.Priority,
                HealthStatus = model.HealthStatus,
            }).ToList(),
            ResolutionType = pool.ResolutionType,
            IsDedicated = pool.IsDedicated,
            IsDefault = pool.IsDefault,
            IsLegacy = string.Equals(pool.ResolutionType, "DirectModel", StringComparison.Ordinal),
            AverageDurationMs = pool.AverageDurationMs,
            RecentTenRequests = pool.RecentTenRequests,
            RecentTenSuccessRatePercent = pool.RecentTenSuccessRatePercent,
            Capabilities = pool.Capabilities.ToList(),
        };
    }
}
