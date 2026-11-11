using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.ModelUpgrades;

namespace PrdAgent.LlmGw.ModelReferences;

public sealed record ReferencePlanRequest(string SourceLogicalId, string TargetLogicalId, string ClientRequestId);
public sealed record ReferenceRevisionRequest(long Revision);
public sealed class ModelReferencePlanQueries(IMongoDatabase gateway)
{
    public async Task<(List<ReferenceMigrationPlan> Items, long Total, long UnresolvedTotal)> ListAsync(string tenantId, CancellationToken ct)
    {
        var plans = gateway.GetCollection<ReferenceMigrationPlan>(MongoModelReferenceStore.JournalCollection);
        var f = Builders<ReferenceMigrationPlan>.Filter;
        var tenant = f.Eq(x => x.TenantId, tenantId);
        var unresolved = f.Or(f.Ne(x => x.Status, "completed"), f.Ne(x => x.Coverage.RegistryHash, ModelReferenceRegistry.Hash),
            f.Ne(x => x.Coverage.Verified, true), f.Eq(x => x.Coverage.ValidUntil, null), f.Lte(x => x.Coverage.ValidUntil, DateTime.UtcNow));
        var items = await plans.Find(tenant & unresolved).SortByDescending(x => x.UpdatedAt).Limit(100).ToListAsync(ct);
        if (items.Count < 100) items.AddRange(await plans.Find(tenant & f.Not(unresolved)).SortByDescending(x => x.UpdatedAt).Limit(100 - items.Count).ToListAsync(ct));
        return (items, await plans.CountDocumentsAsync(tenant, cancellationToken: ct), await plans.CountDocumentsAsync(tenant & unresolved, cancellationToken: ct));
    }
}

public static class ModelReferenceEndpoints
{
    public static IServiceCollection AddModelReferences(this IServiceCollection services, IMongoDatabase gateway,
        IMongoDatabase map, IConfiguration configuration, string internalTenantId)
    {
        services.AddSingleton(new ModelReferenceCatalog(gateway, map, internalTenantId));
        services.AddSingleton(new ModelReferencePlanQueries(gateway));
        services.AddSingleton<IModelReferenceTargetValidator>(sp => sp.GetRequiredService<ModelReferenceCatalog>());
        services.AddSingleton<IModelReferenceStore>(new MongoModelReferenceStore(gateway, map, internalTenantId));
        services.AddSingleton<IRuntimeModelReferenceSnapshotProvider>(ModelReferenceRuntimeAuthority.Create(map, configuration));
        services.AddSingleton(sp => new ModelReferenceUsageCatalog(gateway, sp.GetRequiredService<IModelReferenceStore>(),
            sp.GetRequiredService<ModelReferenceCatalog>(), internalTenantId));
        // Registered explicitly after the actual MAP runtime snapshot adapter is installed.
        services.AddSingleton(sp => new ModelReferenceEngine(sp.GetRequiredService<IModelReferenceStore>(), internalTenantId,
            sp.GetService<IRuntimeModelReferenceSnapshotProvider>(), sp.GetRequiredService<IModelReferenceTargetValidator>()));
        services.AddHostedService(sp => new ModelReferenceVerificationWorker(gateway, sp.GetRequiredService<ModelReferenceEngine>(), configuration,
            sp.GetRequiredService<ILogger<ModelReferenceVerificationWorker>>()));
        return services;
    }
    public static void MapModelReferences(this WebApplication app, JsonSerializerOptions json)
    {
        async Task<IResult> Execute(Func<Task<object>> action)
        {
            try { return Results.Json(ApiEnvelope<object>.Ok(await action()), json); }
            catch (ModelReferenceException e) { return Results.Json(ApiEnvelope<object>.Fail(e.Code, e.Message), json, statusCode: 409); }
        }
        void RequireWriteAuthority()
        {
            if (ModelUpgradeDeploymentAuthority.BlockReason(app.Configuration) is { } reason)
                throw new ModelReferenceException("REFERENCE_DEPLOYMENT_BLOCKED", reason);
        }
        app.MapGet("/gw/model-reference-migrations/plans", (HttpContext http, ModelReferencePlanQueries queries) => Execute(async () =>
        {
            var tenant = TenantAccess.GetRequired(http).TenantId;
            var plans = await queries.ListAsync(tenant, http.RequestAborted);
            return new { items = plans.Items.Select(PublicPlan).ToList(), plans.Total, plans.UnresolvedTotal, hasMore = plans.Total > plans.Items.Count };
        })).RequireAuthorization("LogsRead");
        app.MapGet("/gw/model-reference-migrations/coverage", (HttpContext http, string sourceLogicalId, string targetLogicalId,
            ModelReferenceCatalog catalog, ModelReferenceEngine engine) => Execute(async () =>
        {
            var mapping = await catalog.BuildAsync(TenantAccess.GetRequired(http).TenantId, sourceLogicalId, targetLogicalId, http.RequestAborted);
            return await engine.InspectAsync(mapping, http.RequestAborted);
        })).RequireAuthorization("LogsRead");
        app.MapGet("/gw/model-reference-migrations/repairable-usages", (HttpContext http, ModelReferenceUsageCatalog usages) => Execute(async () =>
            new { items = await usages.ReadAsync(TenantAccess.GetRequired(http).TenantId, http.RequestAborted) })).RequireAuthorization("LogsRead");
        app.MapPost("/gw/model-reference-migrations/plans/from-usage", (HttpContext http, ReferenceUsagePlanRequest body,
            ModelReferenceUsageCatalog usages, ModelReferenceEngine engine) => Execute(async () =>
        {
            RequireWriteAuthority();
            var actor = TenantAccess.GetRequired(http);
            var mapping = await usages.BuildAsync(actor.TenantId, body, http.RequestAborted);
            return PublicPlan(await engine.PlanAsync(mapping, actor.UserId, body.ClientRequestId, CancellationToken.None));
        })).RequireAuthorization("ConfigWrite");
        app.MapPost("/gw/model-reference-migrations/plans", (HttpContext http, ReferencePlanRequest body,
            ModelReferenceCatalog catalog, ModelReferenceEngine engine) => Execute(async () =>
        {
            RequireWriteAuthority();
            var actor = TenantAccess.GetRequired(http);
            var mapping = await catalog.BuildAsync(actor.TenantId, body.SourceLogicalId, body.TargetLogicalId, http.RequestAborted);
            return PublicPlan(await engine.PlanAsync(mapping, actor.UserId, body.ClientRequestId, CancellationToken.None));
        })).RequireAuthorization("ConfigWrite");
        app.MapGet("/gw/model-reference-migrations/plans/by-request/{clientRequestId}", (HttpContext http, string clientRequestId,
            ModelReferenceEngine engine) => Execute(async () =>
        {
            var actor = TenantAccess.GetRequired(http);
            var plan = await engine.GetByRequestAsync(actor.TenantId, actor.UserId, clientRequestId, http.RequestAborted);
            return PublicPlan(plan ?? throw new ModelReferenceException("REFERENCE_PLAN_NOT_FOUND", "计划尚未建立，请等待原请求状态后再核对。"));
        })).RequireAuthorization("LogsRead");
        app.MapGet("/gw/model-reference-migrations/plans/{intentId}", (HttpContext http, string intentId,
            ModelReferenceEngine engine) => Execute(async () => PublicPlan(await engine.GetAsync(intentId,
                TenantAccess.GetRequired(http).TenantId, http.RequestAborted)))).RequireAuthorization("LogsRead");
        app.MapPost("/gw/model-reference-migrations/plans/{intentId}/apply", (HttpContext http, string intentId,
            ReferenceRevisionRequest body, ModelReferenceEngine engine) => Execute(async () =>
        {
            RequireWriteAuthority();
            // The durable intent owns retries; a client disconnect cannot abandon half-applied model fields.
            return PublicPlan(await engine.ApplyAsync(intentId, TenantAccess.GetRequired(http).TenantId, body.Revision, CancellationToken.None));
        })).RequireAuthorization("ConfigWrite");
        app.MapPost("/gw/model-reference-migrations/plans/{intentId}/verify", (HttpContext http, string intentId,
            ReferenceRevisionRequest body, ModelReferenceEngine engine) => Execute(async () =>
        {
            RequireWriteAuthority();
            return PublicPlan(await engine.VerifyPlanAsync(intentId, TenantAccess.GetRequired(http).TenantId, body.Revision, CancellationToken.None));
        })).RequireAuthorization("ConfigWrite");
    }
    // BSON journal values and CAS conditions are intentionally not part of the HTTP response.
    internal static object PublicPlan(ReferenceMigrationPlan plan)
    {
        if (plan.Coverage.RegistryHash != ModelReferenceRegistry.Hash)
        {
            plan.Coverage.Verified = false; plan.Coverage.ValidUntil = null;
            plan.Coverage.Consumers.RemoveAll(x => x.Key == "registry.changed");
            plan.Coverage.Consumers.Add(new() { Key = "registry.changed", Unknown = 1, Reasons = ["模型使用位置注册表已更新，请重新进行完整检查。"] });
            plan.Status = "blocked";
        }
        return new { plan.IntentId, plan.Revision, plan.TenantId, plan.ActorId, plan.Mapping, plan.Coverage, plan.Status, plan.CreatedAt, plan.UpdatedAt };
    }
}
