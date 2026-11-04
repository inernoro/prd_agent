using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>只读核对生图目录；健康检查不能抢占真实请求的恢复租约。</summary>
internal static class VisualModelRouteProbe
{
    internal static async Task<(int Failures, string Output)> CheckAsync(
        IVisualModelPolicyService visualModels, CancellationToken ct)
    {
        try
        {
            // 读取原始配置，失效引用不能先被运行时过滤掉。
            var policy = await visualModels.ReadStoredAsync(ct);
            var openModels = policy.Models.Select(x => x.ModelId?.Trim())
                .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            var defaultModel = policy.DefaultModelId?.Trim() ?? string.Empty;
            if (openModels.Count == 0 || string.IsNullOrWhiteSpace(defaultModel))
                return (1, "视觉创作没有配置开放模型或默认生图模型");

            var failures = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var covered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var checkedRoutes = 0;
            var defaultInTextCatalog = false;
            foreach (var appCaller in VisualModelPolicyService.AppCallers)
            {
                // DiscoverAsync 已经过实际线路构建、场景授权和名录门，但不占用半开租约。
                var catalog = await visualModels.DiscoverAsync(appCaller, ct);
                if (appCaller == AppCallerRegistry.VisualAgent.Image.Text2Img)
                    defaultInTextCatalog = catalog.Any(x => string.Equals(x.Model.Code, defaultModel, StringComparison.OrdinalIgnoreCase));
                foreach (var model in catalog.Where(x => openModels.Contains(x.Model.Code)))
                {
                    covered.Add(model.Model.Code);
                    checkedRoutes++;
                    if (!model.Model.Models.Any(member => member.HealthStatus is "Healthy" or "Degraded"))
                        failures.Add($"{model.Model.Code}:MODEL_UNAVAILABLE");
                }
            }
            foreach (var missing in openModels.Except(covered, StringComparer.OrdinalIgnoreCase))
                failures.Add($"{missing}:NOT_IN_SCENARIO_CATALOG");
            if (!defaultInTextCatalog) failures.Add($"{defaultModel}:DEFAULT_NOT_TEXT2IMG");
            return (failures.Count, failures.Count == 0
                ? $"{openModels.Count} 个开放模型的 {checkedRoutes} 条生图场景路由当前可用"
                : $"生图场景路由有 {failures.Count} 处异常：{string.Join("、", failures.Take(5))}");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            return (1, $"默认生图路由预检失败：{ex.GetType().Name}");
        }
    }
}
