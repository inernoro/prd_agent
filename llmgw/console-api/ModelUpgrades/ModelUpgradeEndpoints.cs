using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.ModelReferences;

namespace PrdAgent.LlmGw.ModelUpgrades;

public static class ModelUpgradeEndpoints
{
    public static IServiceCollection AddModelUpgrades(this IServiceCollection services, IMongoDatabase gateway, IMongoDatabase map,
        IConfiguration configuration, string internalTenantId)
    {
        services.AddSingleton<IModelUpgradeDiscovery>(new ModelUpgradeDiscovery(new UpstreamProxyService(gateway, configuration, internalTenantId), configuration, internalTenantId, gateway));
        services.AddSingleton(sp => new ModelUpgradeService(gateway, map, sp.GetRequiredService<IModelUpgradeDiscovery>(), internalTenantId, sp.GetRequiredService<ILogger<ModelUpgradeService>>(), configuration,
            sp.GetRequiredService<ModelReferenceEngine>(), sp.GetRequiredService<ModelReferenceCatalog>()));
        services.AddSingleton(new ModelBindingProbeService(gateway, configuration, internalTenantId));
        services.AddHostedService<ModelUpgradeWorker>();
        return services;
    }
    public static void MapModelUpgrades(this WebApplication app, JsonSerializerOptions json)
    {
        async Task<IResult> Execute(Func<Task<object>> action)
        {
            try { return Results.Json(ApiEnvelope<object>.Ok(await action()), json); }
            catch (ModelUpgradeException e) { return Results.Json(ApiEnvelope<object>.Fail(e.Code, e.Message), json, statusCode: e.Status); }
        }
        app.MapGet("/gw/model-upgrades", (HttpContext http, ModelUpgradeService service) => Execute(async () => new { items = await service.ListAsync(TenantAccess.GetRequired(http).TenantId) })).RequireAuthorization("LogsRead");
        app.MapGet("/gw/model-upgrades/{logicalId}", (HttpContext http, string logicalId, ModelUpgradeService service) => Execute(async () => await service.ReadAsync(TenantAccess.GetRequired(http).TenantId, logicalId))).RequireAuthorization("LogsRead");
        app.MapPut("/gw/model-upgrades/{logicalId}", (HttpContext http, string logicalId, ModelUpgradePolicyWrite body, ModelUpgradeService service) => Execute(async () => await service.SavePolicyAsync(TenantAccess.GetRequired(http), logicalId, body))).RequireAuthorization("ConfigWrite");
        app.MapGet("/gw/logical-models/{logicalId}/offerings/{offeringId}/test", (HttpContext http, string logicalId, string offeringId, ModelBindingProbeService service) => Execute(async () => await service.ReadLatestAsync(TenantAccess.GetRequired(http), logicalId, offeringId, http.RequestAborted))).RequireAuthorization("ConfigWrite");
        app.MapPost("/gw/logical-models/{logicalId}/offerings/{offeringId}/test", (HttpContext http, string logicalId, string offeringId, ModelBindingProbeWrite body, ModelBindingProbeService service) => Execute(async () => await service.StartAsync(TenantAccess.GetRequired(http), logicalId, offeringId, body, http.RequestAborted))).RequireAuthorization("ConfigWrite");
        app.MapGet("/gw/logical-models/{logicalId}/offerings/{offeringId}/test/{requestId}", (HttpContext http, string logicalId, string offeringId, string requestId, ModelBindingProbeService service) => Execute(async () => await service.ReadAsync(TenantAccess.GetRequired(http), logicalId, offeringId, requestId, http.RequestAborted))).RequireAuthorization("ConfigWrite");
        foreach (var action in new[] { "check", "validate", "promote", "rollback" })
        {
            var operation = action;
            app.MapPost("/gw/model-upgrades/{logicalId}/" + operation, (HttpContext http, string logicalId, ModelUpgradeAction body, ModelUpgradeService service) => Execute(async () => await service.QueueAsync(TenantAccess.GetRequired(http), logicalId, operation, body))).RequireAuthorization("ConfigWrite");
        }
    }
}
