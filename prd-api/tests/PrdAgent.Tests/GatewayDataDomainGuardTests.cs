using System.Diagnostics;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// LLM Gateway 数据域守卫：MAP 业务日志继续归 MAP，GW serving 请求日志与 shadow 证据归 llm_gateway。
/// 这是 full-cutover S0.5 的硬前置，防止后续装配改动把证据重新写回 prdagent。
/// </summary>
public class GatewayDataDomainGuardTests
{
    [Fact]
    public void WorkloadIdentity_IsServerDerivedFilterableAndNeverStoresKeyMaterialInRequestLog()
    {
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var serving = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var servingProgram = ReadRepoFile("llmgw/serving/Program.cs");
        var logWriter = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var activity = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");

        Assert.Contains("public string? ServiceKeyId", logModel);
        Assert.Contains("public string? ClientCode", logModel);
        Assert.Contains("public string? Environment", logModel);
        Assert.Contains("public string? ServiceKeyPrefix", logModel);
        Assert.DoesNotContain("public string? KeyHash", logModel);
        Assert.Contains("ingress.Context.ServiceKeyId = authorization.KeyId", serving);
        Assert.Contains("ingress.Context.ClientCode = authorization.ClientCode", serving);
        Assert.Contains("fb.Eq(\"ServiceKeyId\", serviceKeyId.Trim())", console);
        Assert.Contains("fb.Eq(\"ClientCode\", clientCode.Trim())", console);
        Assert.Contains("filterClientCode", activity);
        Assert.Contains("filterEnvironment", activity);
        Assert.Contains("filterServiceKeyId", activity);
        Assert.Contains("LlmRequestLogContextItems.LifecycleStarted", serving);
        Assert.Contains("MarkLifecycleStarted();", logWriter);
        Assert.Contains("sp.GetRequiredService<IHttpContextAccessor>()", servingProgram);
    }

    [Fact]
    public void CostEvidenceAndLegacyCutover_AreTenantScopedAuditableAndFailClosed()
    {
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var costEvidence = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmCostEvidence.cs");
        var logBackground = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogBackground.cs");
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var governanceRecords = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayGovernanceRecords.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var runtime = ReadRepoFile("llmgw/serving/GatewayRuntimeGovernance.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var dtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var costPolicy = ReadRepoFile("llmgw/console-api/Costs/CostReconciliationPolicy.cs");

        Assert.Contains("public string? PriceSnapshotHash", logModel);
        Assert.Contains("public string? ProviderRequestId", logModel);
        Assert.Contains("public decimal? ProviderReportedCost", logModel);
        var importDto = dtos[dtos.IndexOf("class CostReconciliationImportRequest", StringComparison.Ordinal)..dtos.IndexOf("class CostReconciliationItem", StringComparison.Ordinal)];
        Assert.Contains("public decimal? ProviderReportedCost", importDto);
        Assert.Contains("SHA256.HashData", costEvidence);
        Assert.Contains("LlmCostEvidence.ResolveProviderRequestId(done.ResponseHeaders)", logBackground);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(gateway, "LlmCostEvidence.BuildSafeResponseHeaders").Count >= 3);
        Assert.DoesNotContain("TenantId", dtos[dtos.IndexOf("class CostReconciliationImportRequest", StringComparison.Ordinal)..dtos.IndexOf("class CostReconciliationItem", StringComparison.Ordinal)]);
        Assert.Contains("BILLING_WINDOW_TEAM_AMBIGUOUS", console);
        Assert.Contains("BILLING_WINDOW_OVERLAP", console);
        Assert.Contains("PROVIDER_REQUEST_COVERED_BY_WINDOW", console);
        Assert.Contains("providerReportedCost is null", console);
        Assert.Contains("coveringWindowFilters.Add(Builders<BsonDocument>.Filter.Eq(\"ServiceKeyId\", BsonNull.Value))", console);
        Assert.Contains("BILLING_WINDOW_CONTAINS_RECONCILED_REQUEST", console);
        Assert.Contains("var actualAggregate = await costReconciliations.Aggregate()", console);
        Assert.Contains("var statusAggregate = await costReconciliations.Aggregate()", console);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(console, "await ApplyMatchedRequestLogAsync\\(\\);").Count >= 2);
        Assert.Contains("Filter.Type(\"ProviderReportedCost\", BsonType.Decimal128)", console);
        Assert.Contains("{ \"TenantId\", access.TenantId }", console);
        Assert.Contains("{ \"TeamId\", reconciliationTeamId is null ? BsonNull.Value : reconciliationTeamId }", console);
        Assert.Contains("idx_llmgw_logs_tenant_provider_request", initializer);
        Assert.Contains("idx_llmgw_service_key_tenant_workload_purpose", initializer);
        Assert.Contains("idx_llmgw_service_key_tenant_workload_purpose", console);
        Assert.Contains("uniq_llmgw_cost_tenant_provider_external", initializer);
        Assert.Contains("uniq_llmgw_cost_tenant_provider_request", initializer);
        Assert.Contains("uniq_llmgw_cost_import_lock_tenant_provider_team", initializer);
        Assert.Contains("CostImportScopeLock.TryAcquireAsync", console);
        Assert.Contains("CostImportScopeLock.TryRenewAsync", console);
        Assert.Contains("CostImportScopeLock.ReleaseAsync", console);
        Assert.True(console.LastIndexOf("CostImportScopeLock.TryAcquireAsync", StringComparison.Ordinal)
                    < console.IndexOf("var overlapFilter", StringComparison.Ordinal));
        Assert.True(console.IndexOf("CostImportScopeLock.TryRenewAsync", StringComparison.Ordinal)
                    < console.IndexOf("await costReconciliations.InsertOneAsync(record)", StringComparison.Ordinal));
        Assert.Contains("Ascending(\"TenantId\").Ascending(\"TeamId\").Ascending(\"ServiceKeyId\")", initializer);
        Assert.Contains("return new(\"fx-unavailable\", null, null, null)", costPolicy);

        Assert.Contains("public string Purpose { get; set; } = string.Empty", governanceRecords);
        Assert.Contains("ROTATION_IDENTITY_MISMATCH", console);
        Assert.Contains("rotatedPurpose, purpose", console);
        Assert.Contains("GATEWAY_LEGACY_KEY_EXTERNAL_FORBIDDEN", runtime);
        Assert.Contains("x => x.TenantId == _internalTenantId", runtime);
        Assert.Contains("SuccessorObservationCounts", governanceRecords);
        Assert.Contains(".Inc($\"SuccessorObservationCounts.{record.Id}\", 1)", runtime);
        Assert.Contains("SuccessorObservationCounts.{successorId}", console);
        Assert.Contains("new BsonRegularExpression(\"^production$\", \"i\")", console);
        Assert.Contains("new BsonRegularExpression(\"^runtime$\", \"i\")", console);
        Assert.Contains("LegacySuccessorScopePolicy.FindMissing(successor.AsStringList(\"Scopes\"), requiredScopes)", console);
        Assert.Contains(".Set(\"RequiredScopes\", new BsonArray(requiredScopes))", console);
        Assert.Contains("record.Environment, \"production\"", runtime);
        Assert.Contains("GatewayKeyPurposePolicy.AllowsDataPlaneRequest", runtime);
        Assert.Contains("GATEWAY_KEY_PURPOSE_DENIED", runtime);
        Assert.Contains("GatewaySuccessorObservationPolicy.IsBusinessInvocationScope(serviceKeyScope)", runtime);
        Assert.Contains("LEGACY_REVOCATION_FINAL", console);
        Assert.Contains("TenantAccess.Filter(http)", console);
    }

    [Fact]
    public void ServiceKeyRotation_RequiresClientCutoverBeforeOldKeyRevocation()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/ServiceKeysPage.tsx");

        Assert.Contains("/gw/service-keys/{id}/rotation/client-cutover", console);
        Assert.Contains("ROTATION_CLIENT_SWITCH_REQUIRED", console);
        Assert.Contains("ROTATION_SOURCE_STAGE_INVALID", console);
        Assert.Contains("string.IsNullOrWhiteSpace(successorId)", console);
        Assert.Contains("var legacySourceClientCode = rotatedKey.AsNullableString(\"SourceSystem\")", console);
        Assert.Contains("Regex.IsMatch(legacySourceClientCode", console);
        Assert.Contains(".Set(\"ClientCode\", clientCode)", console);
        Assert.Contains(".Set(\"Environment\", environment)", console);
        Assert.Contains("predecessorRotationState = !string.IsNullOrWhiteSpace(rotatedKey.AsNullableString(\"RotatesKeyId\"))", console);
        Assert.Contains("{ \"PredecessorRotationState\", predecessorRotationState is null ? BsonNull.Value : predecessorRotationState }", console);
        Assert.Contains(".Set(\"RotationState\", restoreState)", console);
        Assert.Contains("BsonDocument? stableSuccessor = null", console);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"IssuanceState\", \"creating\")", console);
        Assert.Contains(".Set(\"IssuanceState\", \"delivering\")", console);
        Assert.Contains("http.Response.OnCompleted(async () =>", console);
        Assert.Contains(".Set(\"IssuanceState\", \"issued\")", console);
        Assert.Contains("DateTime.UtcNow.AddSeconds(-30)", console);
        Assert.Contains("SERVICE_KEY_AUDIT_FAILED", console);
        Assert.Contains("throwOnFailure: true", console);
        Assert.Contains("await RollbackIssuanceAsync();", console);
        Assert.Contains("SERVICE_KEY_ISSUANCE_PENDING", console);
        Assert.Contains("轮换新密钥已被并发撤销", console);
        Assert.Contains("successorIdentityFilter & Builders<BsonDocument>.Filter.Eq(\"RotationState\", \"new-key-created\")", console);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"RotationState\", \"awaiting-client-cutover\")", console);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"RotationState\", \"abort-in-progress\")", console);
        Assert.Contains("service_key.rotation_abort", console);
        Assert.Contains("\"awaiting-client-cutover\"", console);
        Assert.Contains("\"client-switched\"", console);
        Assert.Contains("\"old-key-revoked\"", console);
        Assert.Contains("\"completed\"", console);
        Assert.Contains("确认已切换", page);
        Assert.Contains("撤销旧钥并完成", page);
        Assert.Contains("&& !item.rotatedByKeyId", page);
    }
    [Fact]
    public void Api_ShadowWriter_UsesGatewayDataContext()
    {
        var program = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");

        Assert.Contains("new LlmGatewayDataContext(mongoConnectionString, llmGatewayDatabaseName)", program);
        Assert.Contains("ILlmShadowComparisonWriter>(sp =>", program);
        Assert.Contains("sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.DoesNotContain(
            "AddScoped<PrdAgent.Core.Interfaces.ILlmShadowComparisonWriter,\n    PrdAgent.Infrastructure.LlmGateway.LlmShadowComparisonWriter>()",
            program);
    }

    [Fact]
    public void Serving_RuntimeData_UsesGatewayContext_WhileResolverKeepsOptionalMapFallbackContext()
    {
        var program = ReadRepoFile("llmgw/serving/Program.cs");

        Assert.Contains("builder.Services.AddSingleton(new MongoDbContext(mongoConn, mongoDb));", program);
        Assert.Contains("builder.Services.AddSingleton(new LlmGatewayDataContext(gatewayMongoConn, gatewayDb));", program);
        Assert.Contains("builder.Configuration[\"LlmGateway:MongoConnectionString\"]", program);
        Assert.Contains("new LlmRequestLogBackground(\n        sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.Contains("new LlmRequestLogWriter(\n        sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.Contains("new GatewayAppSettingsService(", program);
        Assert.Contains("AddHostedService<GatewayRuntimeSettingsInitializer>()", program);
        Assert.Contains("sp.GetRequiredService<LlmGatewayDataContext>().Context,\n        sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.ModelPool.PoolFailoverNotifier>>()", program);
        Assert.Contains("new RegistryAssetStorage(inner, db, providerName, regLogger, \"llmgw_asset_registry\")", program);
        Assert.Contains("GetCollection<PrdAgent.Core.Models.LLMPlatform>(\"llmgw_platforms\")", program);
        Assert.DoesNotContain("AddSingleton<PrdAgent.Core.Interfaces.IAppSettingsService, PrdAgent.Infrastructure.Services.AppSettingsService>()", program);
        Assert.Contains("AddScoped<PrdAgent.Infrastructure.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>()", program);
    }

    [Fact]
    public void GatewayOwnedModelConfig_ModelsIgnoreExtraMetadataFields()
    {
        var modelGroup = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ModelGroup.cs");
        var modelExchange = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ModelExchange.cs");

        Assert.Contains("using MongoDB.Bson.Serialization.Attributes;", modelGroup);
        Assert.Contains("[BsonIgnoreExtraElements]\npublic class ModelGroup", modelGroup);
        Assert.Contains("using MongoDB.Bson.Serialization.Attributes;", modelExchange);
        Assert.Contains("[BsonIgnoreExtraElements]\npublic class ModelExchange", modelExchange);
    }

    [Fact]
    public void ShadowReadEndpoints_UseGatewayDatabase()
    {
        var servingEndpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var smoke = ReadRepoFile("scripts/gw-smoke.py");

        Assert.Contains("services.GetService<LlmGatewayDataContext>()?.Context", servingEndpoints);
        Assert.Contains("var logs = gatewayDatabase.GetCollection<BsonDocument>(\"llmrequestlogs\");", consoleProgram);
        Assert.DoesNotContain("var logs = mapDatabase.GetCollection<BsonDocument>(\"llmrequestlogs\");", consoleProgram);
        Assert.Contains("var shadows = gatewayDatabase.GetCollection<BsonDocument>(\"llmshadow_comparisons\");", consoleProgram);
        Assert.DoesNotContain("var shadows = mapDatabase.GetCollection<BsonDocument>(\"llmshadow_comparisons\");", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Ne(\"IsHealthProbe\", true)", consoleProgram);
        Assert.Contains("\"IsHealthProbe\": True", smoke);
        Assert.Contains("bool? IsHealthProbe = null", ReadRepoFile("prd-api/src/PrdAgent.Core/Interfaces/ILLMRequestContextAccessor.cs"));
        Assert.Contains("IsHealthProbe: ctx?.IsHealthProbe", servingEndpoints);
        Assert.Contains("IsHealthProbe = current?.IsHealthProbe", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/HttpLlmClient.cs"));
        Assert.Contains("IsHealthProbe = scopeCtx?.IsHealthProbe", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayLLMClient.cs"));
        Assert.Contains("var runId = ResolveCompatRunId(http, body)", servingEndpoints);
        Assert.Contains("RunId = runId", servingEndpoints);
        Assert.Contains("ResolveHeader(http, \"X-Gateway-Run-Id\")", servingEndpoints);
        Assert.Contains("RunId = d.AsNullableString(\"RunId\")", consoleProgram);
        Assert.Contains("string? releaseCommit,\n    string? runId, string? requestId, string? sessionId", consoleProgram);
        Assert.Contains("fb.Eq(\"RunId\", runId.Trim())", consoleProgram);
        Assert.Contains("fb.Eq(\"RequestId\", requestId.Trim())", consoleProgram);
        Assert.Contains("fb.Eq(\"SessionId\", sessionId.Trim())", consoleProgram);
        Assert.Contains("LastObservedRequestId", servingEndpoints);
        Assert.Contains("LastObservedSessionId", servingEndpoints);
        Assert.Contains("LastObservedRunId", servingEndpoints);
        Assert.Contains("private static AppCallerStatusDecision CheckAppCallerStatus", servingEndpoints);
        Assert.Contains("GatewayAppCallerPolicy.AllowsTraffic(normalized)", servingEndpoints);
        Assert.Contains("APP_CALLER_DISABLED", servingEndpoints);
        Assert.Contains("StatusCodes.Status403Forbidden", servingEndpoints);
        Assert.Contains("if (decision.Status.Rejected)", servingEndpoints);
        Assert.Contains("if (await TryWriteGovernanceErrorAsync(http, governance)) return;", servingEndpoints);
        Assert.Contains("var governanceResult = GovernanceResult(http, governance, jsonOpts);", servingEndpoints);
        Assert.Contains("app.MapPost(\"/gw/v1/profile-test\", async (\n            HttpContext http,", servingEndpoints);
        Assert.Contains("RequestId = requestId", servingEndpoints);
        Assert.Contains("Context = profileContext", servingEndpoints);
        Assert.Contains("GatewayTransport = GatewayTransports.Http", servingEndpoints);
        Assert.Contains("AppCallerTitle = profileTitle", servingEndpoints);
        Assert.Contains("PinnedModelId = profileRequest.Model", servingEndpoints);
        Assert.Contains("gateway.TestUpstreamProfileAsync(profileRequest, cancellation?.Token ?? CancellationToken.None)", servingEndpoints);
        Assert.Contains("public GatewayRequestContext? Context { get; init; }", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs"));
        Assert.Contains("SourceSystem = sourceContext?.SourceSystem", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs"));
        Assert.Contains("IngressProtocol = sourceContext?.IngressProtocol", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs"));
        var runtimeProfileService = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs");
        Assert.Contains("Context = new GatewayRequestContext", runtimeProfileService);
        Assert.Contains("SourceSystem = \"map\"", runtimeProfileService);
        Assert.Contains("ModelPolicy = \"pinned\"", runtimeProfileService);
        Assert.Contains("LastObservedRequestId = d.AsNullableString(\"LastObservedRequestId\")", consoleProgram);
        Assert.Contains("fb.Regex(\"LastObservedRequestId\", pattern)", consoleProgram);
        Assert.Contains("ValidateActiveGatewayAppCallerConfigAsync", consoleProgram);
        Assert.Contains("ObservedIngressProtocols", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs"));
        Assert.Contains(".AddToSet(x => x.ObservedIngressProtocols, ingressProtocol)", servingEndpoints);
        Assert.Contains("ObservedIngressProtocols = GetObservedIngressProtocols(d)", consoleProgram);
        Assert.Contains("fb.AnyEq(\"ObservedIngressProtocols\"", consoleProgram);
        Assert.Contains("active appCaller 必须绑定 llm_gateway.llmgw_model_pools", consoleProgram);
        Assert.Contains("active appCaller 必须使用 modelPolicy=auto/pool/pinned", consoleProgram);
        var modelResolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.DoesNotContain("active-appcaller-auto-policy-without-gateway-pool", modelResolver);
        Assert.Contains("allowMapFallback: !gatewayConfigRequired", modelResolver);
        Assert.Contains("TryGetGatewayRegistryGroupsAsync", modelResolver);
        Assert.Contains("GatewayAppCallerPolicy.AllowsTraffic", modelResolver);
        Assert.Contains("FindGatewayOwnedDefaultModelPoolsAsync", modelResolver);
        Assert.Contains("gatewayRegistry.TrafficRejected", modelResolver);
        Assert.Contains("DisableMapConfigFallbackForRegisteredAppCallers", modelResolver);
        Assert.Contains("if (!gatewayConfigRequired)", modelResolver);
        Assert.True(
            modelResolver.IndexOf("if (!gatewayConfigRequired)", StringComparison.Ordinal)
            < modelResolver.IndexOf("_db.LLMAppCallers", StringComparison.Ordinal),
            "GW-only 模式必须在任何 MAP appCaller 查询前短路");
        Assert.True(
            modelResolver.IndexOf("gatewayRegistry.Groups.Count == 0 && gatewayConfigRequired", StringComparison.Ordinal)
            < modelResolver.IndexOf("var pinned = await TryResolvePinnedModelAsync", StringComparison.Ordinal),
            "GW-only 模式必须先拒绝缺失专用池，再处理 pinned 精确模型，避免绕过 appCaller 治理边界");
        Assert.Contains("FindGatewayOwnedOrMapPlatformAsync(platformId, enabledOnly: true, ct, allowMapFallback)", modelResolver);
        Assert.Contains("normalized-to-supported-model-policy", consoleProgram);
        Assert.Contains("IsSupportedAppCallerModelPolicy(currentModelPolicy)", consoleProgram);
        Assert.Contains("路由策略保留或补齐为 {targetModelPolicy}", consoleProgram);
        Assert.Contains("HasUsableGatewayPoolMemberAsync", consoleProgram);
        Assert.Contains("m.AsNullableBool(\"Enabled\") ?? true", consoleProgram);
        Assert.Contains("string.Equals(m.AsNullableString(\"DisplayName\"), modelId, StringComparison.Ordinal)", consoleProgram);
        Assert.Contains("gw-pool-without-usable-member", consoleProgram);
        Assert.Contains("没有可解析、非 unavailable 的成员", consoleProgram);
        Assert.Contains("ActiveWithUsableGatewayPool", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("ActiveBoundPoolWithoutUsableMember", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("activeBoundPoolWithoutUsableMember == 0", consoleProgram);
        Assert.Contains("activeAppCallerMapFallbackCutoverPrerequisitesReady", consoleProgram);
        Assert.Contains("http-full 阶段会开启运行态 fail-closed 开关", consoleProgram);
        Assert.Contains("currentCommitHttpTransportReady", consoleProgram);
        Assert.Contains("pre-http shadow/seed 日志不阻断进入 http-full", consoleProgram);
        Assert.Contains("activeBoundPoolWithoutUsableMember", ReadRepoFile("scripts/llmgw-release-gate.py"));
        Assert.Contains("activeBoundPoolWithoutUsableMember", ReadRepoFile("scripts/llmgw-config-authority-apply.py"));
        Assert.Contains("activeBoundPoolWithoutUsableMember", ReadRepoFile("scripts/llmgw-rollout-ledger.py"));
        Assert.Contains("默认模型池必须至少包含一个可用成员", consoleProgram);
        Assert.Contains("DEFAULT_POINTER_REQUIRED", consoleProgram);
        Assert.Contains("DefaultPoolId", consoleProgram);
        Assert.Contains("action: \"pool.set_default\"", consoleProgram);
        Assert.Contains("ValidateDefaultGatewayPoolMembersAsync", consoleProgram);
        Assert.Contains("默认模型池必须保留至少一个可用成员", consoleProgram);
        Assert.Contains("TenantAccess.FilterTeamScope(http, logFilter)", consoleProgram);
        Assert.Contains("fb.Eq(\"ModelPoolId\", modelPoolId.Trim())", consoleProgram);
        Assert.Contains("action: \"pool.models.bulk_import\"", consoleProgram);
        Assert.Contains("action: wasExisting ? \"pool.model.update\" : \"pool.model.add\"", consoleProgram);
        Assert.Contains("action: \"pool.model.remove\"", consoleProgram);
        Assert.Contains("ValidateBulkActiveGatewayAppCallerConfigAsync", consoleProgram);
        var logsTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        Assert.Contains("runId?: string", logsTypes);
        Assert.Contains("requestId?: string", logsTypes);
        Assert.Contains("sessionId?: string", logsTypes);
        Assert.Contains("lastObservedRequestId?: string | null", logsTypes);
        Assert.Contains("lastObservedSessionId?: string | null", logsTypes);
        Assert.Contains("lastObservedRunId?: string | null", logsTypes);
        Assert.Contains("observedIngressProtocols?: string[]", logsTypes);
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        Assert.Contains("runId: filterRunId.trim() || undefined", logsView);
        Assert.Contains("requestId: filterRequestId.trim() || undefined", logsView);
        Assert.Contains("sessionId: filterSessionId.trim() || undefined", logsView);
        Assert.Contains("initialQueryValue('requestId')", logsView);
        var appCallersPage = ReadRepoFile("llmgw/web/src/pages/AppCallersPage.tsx");
        Assert.Contains("logsHref('requestId', item.lastObservedRequestId)", appCallersPage);
        Assert.Contains("logsHref('sessionId', item.lastObservedSessionId)", appCallersPage);
        Assert.Contains("logsHref('runId', item.lastObservedRunId)", appCallersPage);
        Assert.Contains("item.observedIngressProtocols?.length", appCallersPage);
        Assert.Contains("RunId = string.IsNullOrWhiteSpace(start.RunId) ? null : start.RunId.Trim()", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs"));
    }

    [Fact]
    public void ProgramPoolRegistry_UsesTenantScopedAtomicPointerAndAppendOnlyManagedPools()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var registry = ReadRepoFile("llmgw/console-api/ModelPools/GatewayModelPoolTypeRegistry.cs");
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/ModelPoolsPage.tsx");

        Assert.Contains("llmgw_model_pool_types", console);
        Assert.Contains("fb.Eq(\"TenantId\", tenantId), fb.Eq(\"Code\", modelType)", console);
        Assert.Contains("FindOneAndUpdateAsync", console);
        Assert.Contains("DefaultSwitchPendingUntil", console);
        Assert.Contains("PoolVersionGuard", console);
        Assert.Contains("APPEND_ONLY_POOL", console);
        Assert.Contains("Builders<BsonDocument>.Update.Push(\"Models\"", console);
        Assert.Contains("if (IsManagedAppendOnlyPool(poolDoc)) continue;", console);
        Assert.Contains("GatewayModelPoolTypeRegistry.IsCompatible(modelDoc, poolModelType)", console);
        Assert.Contains("MODEL_DISABLED", console);
        Assert.Contains("PLATFORM_DISABLED", console);
        Assert.Contains("modelId = modelDoc.AsNullableString(\"ModelName\") ?? modelDoc.AsNullableString(\"Name\") ?? modelDoc.GetStringOrEmpty(\"_id\")", console);
        Assert.DoesNotContain("!Flag(model, \"IsImageGen\")", registry);
        Assert.Contains("GetCollection<BsonDocument>(\"llmgw_model_pool_types\")", resolver);
        Assert.Contains("PinnedModel 不在 appCaller 专用模型池内", resolver);
        Assert.Contains("有则增加，无则不变", page);
        Assert.Contains("按平台规则补齐", page);
        Assert.Contains("pool.appendOnly ? 'compatible' : filterMode", page);
        Assert.Contains("已过滤已有成员与不匹配模型", page);
        Assert.Contains("return false;", page);
    }

    [Fact]
    public void Console_ExposesProtocolCoverageFromGatewayLogsAndRegistry()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var webApi = ReadRepoFile("llmgw/web/src/lib/api.ts");
        var webTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var overviewPage = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");
        var protocolAudit = ReadRepoFile("scripts/llmgw-protocol-router-audit.py");
        var protocolCanary = ReadRepoFile("scripts/llmgw-protocol-canary.py");

        Assert.Contains("public sealed class ProtocolCoverageData", consoleDtos);
        Assert.Contains("public sealed class ProtocolCoverageItem", consoleDtos);
        Assert.Contains("DroppedParameterRequests", consoleDtos);
        Assert.Contains("app.MapGet(\"/gw/protocol-coverage\"", consoleProgram);
        Assert.Contains("TargetIngressProtocols", consoleProgram);
        Assert.Contains("NormalizeIngressProtocol", consoleProgram);
        Assert.Contains("GetObservedIngressProtocols", consoleProgram);
        Assert.Contains("Where(d => GetObservedIngressProtocols(d).Contains(protocol.Key", consoleProgram);
        Assert.Contains("IsRuntimeGovernedAppCallerStatus", consoleProgram);
        Assert.Contains("HasDroppedParameters", consoleProgram);
        Assert.Contains("protocol_runtime_coverage", consoleProgram);
        Assert.Contains("appcaller_ingress_registry_coverage", consoleProgram);
        Assert.Contains(".Include(\"ObservedIngressProtocols\")", consoleProgram);
        Assert.Contains("registryObservedProtocols", consoleProgram);
        Assert.Contains("missingRegistryProtocols", consoleProgram);
        Assert.Contains("missingIngressProtocols", consoleProgram);
        Assert.Contains("/gw/protocol-coverage?releaseCommit=", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Ne(\"IsHealthProbe\", true)", consoleProgram);
        Assert.Contains("GetCollection<BsonDocument>(\"llmgw_app_callers\")", consoleProgram);
        Assert.Contains("GetCollection<BsonDocument>(\"llmrequestlogs\")", consoleProgram);
        Assert.Contains("ProtocolCoverageData", webTypes);
        Assert.Contains("ProtocolCoverageItem", webTypes);
        Assert.Contains("getProtocolCoverage", webApi);
        Assert.Contains("getProtocolCoverage({ releaseCommit: protocolReleaseCommit, sinceHours: 24 })", overviewPage);
        Assert.Contains("new URLSearchParams(window.location.search).get('releaseCommit')", overviewPage);
        Assert.Contains("ProtocolCoveragePanel", overviewPage);
        Assert.Contains("协议入口覆盖", overviewPage);
        Assert.Contains("case 'protocol_runtime_coverage':", overviewPage);
        Assert.Contains("case 'appcaller_ingress_registry_coverage':", overviewPage);
        Assert.Contains("appcaller_ingress_registry_coverage: [", overviewPage);
        Assert.Contains("protocolCanaryRequired", overviewPage);
        Assert.Contains("protocolCanaryJson", overviewPage);
        Assert.Contains("app.MapGet(\\\"/gw/protocol-coverage\\\"", protocolAudit);
        Assert.Contains("ProtocolCoveragePanel", protocolAudit);
        Assert.Contains("protocol_runtime_coverage", protocolAudit);
        Assert.Contains("LLM Gateway four-protocol runtime canary", protocolCanary);
        Assert.Contains("appCaller ingress registry coverage", protocolCanary);
        Assert.Contains("TARGET_PROTOCOLS = (\"gw-native\", \"openai-compatible\", \"claude-compatible\", \"gemini-compatible\")", protocolCanary);
        Assert.Contains("parser.add_argument(\"--execute\", action=\"store_true\"", protocolCanary);
        Assert.Contains("dry-run only; add --execute to create runtime logs", protocolCanary);
        Assert.DoesNotContain("IsHealthProbe", protocolCanary);
        Assert.Contains("X-Gateway-Model-Policy", protocolCanary);
        Assert.Contains("LLMGW_PROTOCOL_CANARY_JSON_OUT", protocolCanary);
        Assert.Contains("--max-runtime-calls", protocolCanary);
        Assert.Contains("LLMGW_PROTOCOL_CANARY_MAX_RUNTIME_CALLS", protocolCanary);
        Assert.Contains("--no-reuse-existing", protocolCanary);
        Assert.Contains("--allow-empty-expect-commit", protocolCanary);
        Assert.Contains("_existing_report_covers", protocolCanary);
        Assert.Contains("reusedExisting=true; no runtime LLM calls were created", protocolCanary);
        Assert.Contains("missing --expect-commit for --execute", protocolCanary);
        Assert.Contains("selected protocols exceed --max-runtime-calls", protocolCanary);
    }

    [Fact]
    public void ConsoleWriteOperations_AreAuditedToGatewayDatabase()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("var operationAudits = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_operation_audits\");", consoleProgram);
        Assert.Contains("WriteOperationAuditAsync", consoleProgram);
        Assert.Contains("action: \"auth.change_password\"", consoleProgram);
        Assert.Contains("action: \"platform.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"model.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"pool.set_default\"", consoleProgram);
        Assert.Contains("WriteSystemOperationAuditAsync", consoleProgram);
        Assert.Contains("action: \"admin.force_reset\"", consoleProgram);
        Assert.Contains("action: \"admin.force_reset_bootstrap\"", consoleProgram);
        Assert.Contains("action: \"admin.bootstrap\"", consoleProgram);
        Assert.Contains("action: \"admin.reactivate\"", consoleProgram);
        Assert.Contains("\"team.create\"", consoleProgram);
        Assert.Contains("\"membership.create\"", consoleProgram);
        Assert.Contains("\"membership.update\"", consoleProgram);
        Assert.DoesNotContain("action: \"admin.deactivate_legacy_users\"", consoleProgram);
        Assert.Contains("Console.Error.WriteLine($\"[LlmGw] operation audit write failed:", consoleProgram);
        Assert.Contains("Console.Error.WriteLine($\"[LlmGw] system operation audit write failed:", consoleProgram);
        Assert.DoesNotContain("mapDatabase.GetCollection<BsonDocument>(\"llmgw_operation_audits\")", consoleProgram);
    }

    [Fact]
    public void TenantBoundaryPropagation_PreservesVerifiedTenantAndInternalLogFallback()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var logWriter = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs");

        Assert.Contains("GetMetadata<IAllowAnonymous>()", consoleProgram);
        Assert.True(
            endpoints.Split("TenantId = ingress.Context?.TenantId", StringSplitOptions.None).Length - 1 >= 2,
            "native 与 raw 路由重建都必须使用 service key 校验后写入的 ingress tenant");
        Assert.True(
            endpoints.Split("TeamId = ingress.Context?.TeamId", StringSplitOptions.None).Length - 1 >= 2,
            "native 与 raw 路由重建都必须使用 service key 校验后写入的 ingress team");
        Assert.Contains("TenantId = ResolveTenantId(start.TenantId)", logWriter);
        Assert.Contains("configuration[\"LlmGateway:InternalTenantId\"]", logWriter);
        Assert.Contains("? _internalTenantId", logWriter);
        Assert.Contains("GatewayTenantDefaults.InternalTenantId", logWriter);
        Assert.DoesNotContain("TenantId = start.TenantId ?? string.Empty", logWriter);
    }

    [Fact]
    public void InternalTenantFallbacks_UseConfigurationAcrossLogsShadowConcurrencyAndLegacyKeys()
    {
        var apiProgram = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var shadow = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ShadowLlmGateway.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

        Assert.Contains("configuration?[\"LlmGateway:InternalTenantId\"]", shadow);
        Assert.DoesNotContain("?? GatewayTenantDefaults.InternalTenantId", shadow);
        Assert.Contains("configuration?[\"LlmGateway:InternalTenantId\"]", gateway);
        Assert.Contains("string.IsNullOrWhiteSpace(tenantId) ? _internalTenantId : tenantId", gateway);
        Assert.Contains("app.Configuration[\"LlmGateway:InternalTenantId\"]", endpoints);
        Assert.Contains("TenantId: internalTenantId", endpoints);
        Assert.Contains("configuration: sp.GetRequiredService<IConfiguration>()", apiProgram);
    }

    [Fact]
    public void RawIdempotency_NormalizesVerifiedTenantContextBeforeFingerprinting()
    {
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var nativeStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/raw\"", StringComparison.Ordinal);
        var compatStart = endpoints.IndexOf("private static async Task ExecuteRawWithIdempotencyAsync", StringComparison.Ordinal);

        Assert.True(nativeStart >= 0 && compatStart > nativeStart, "找不到 raw 幂等入口");
        Assert.True(
            endpoints.IndexOf("request = ApplyVerifiedRawRequestContext(http, request, ingress);", nativeStart, StringComparison.Ordinal)
            < endpoints.IndexOf("GatewayRequestExecutionStore.Fingerprint(request)", nativeStart, StringComparison.Ordinal),
            "native raw 必须在 fingerprint 前覆盖服务端 tenant/team");
        Assert.True(
            endpoints.IndexOf("request = ApplyVerifiedRawRequestContext(http, request, ingress);", compatStart, StringComparison.Ordinal)
            < endpoints.IndexOf("GatewayRequestExecutionStore.Fingerprint(request)", compatStart, StringComparison.Ordinal),
            "兼容 raw 必须在 fingerprint 前覆盖服务端 tenant/team");
        Assert.Contains("ingress.Context.TenantId = GetVerifiedTenantId(http)", endpoints);
        Assert.Contains("ingress.Context.TeamId = GetVerifiedTeamId(http)", endpoints);
    }

    [Fact]
    public void TeamRename_MapsTenantScopedUniqueNameCollisionToConflict()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var updateStart = consoleProgram.IndexOf("app.MapPut(\"/gw/teams/{id}\"", StringComparison.Ordinal);
        var memberStart = consoleProgram.IndexOf("app.MapPost(\"/gw/members\"", updateStart, StringComparison.Ordinal);
        var updateBlock = consoleProgram[updateStart..memberStart];

        Assert.Contains("x.Id == id && x.TenantId == access.TenantId", updateBlock);
        Assert.Contains("ServerErrorCategory.DuplicateKey", updateBlock);
        Assert.Contains("Fail(\"TEAM_CONFLICT\", \"当前租户已存在同名团队\")", updateBlock);
        Assert.Contains("jsonOptions, 409", updateBlock);
    }

    [Fact]
    public void ServiceKeyWrites_HaveDedicatedDeveloperPermissionWithoutConfigWrite()
    {
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var listStart = consoleProgram.IndexOf("app.MapGet(\"/gw/service-keys\"", StringComparison.Ordinal);
        var createStart = consoleProgram.IndexOf("app.MapPost(\"/gw/service-keys\"", StringComparison.Ordinal);
        var deleteStart = consoleProgram.IndexOf("app.MapDelete(\"/gw/service-keys/{id}\"", createStart, StringComparison.Ordinal);
        var shadowStart = consoleProgram.IndexOf("// 影子比对", deleteStart, StringComparison.Ordinal);

        Assert.Contains("public const string ServiceKeyWrite = \"service-key:write\"", access);
        Assert.Contains("LlmGwTenantRoles.Developer => permission is LogsRead or RequestBodyRead or UsageRead or AppCallerWrite or ServiceKeyWrite", access);
        Assert.DoesNotContain("LlmGwTenantRoles.Developer => permission is LogsRead or RequestBodyRead or UsageRead or ConfigWrite", access);
        Assert.Contains("options.AddPolicy(\"ServiceKeyWrite\"", consoleProgram);
        Assert.Contains("CreatedByUserId", consoleProgram[listStart..createStart]);
        Assert.Contains("RequireAuthorization(\"ServiceKeyWrite\")", consoleProgram[listStart..createStart]);
        Assert.Contains("CreatedByUserId", consoleProgram[createStart..deleteStart]);
        Assert.Contains("RequireAuthorization(\"ServiceKeyWrite\")", consoleProgram[createStart..deleteStart]);
        Assert.Contains("CreatedByUserId", consoleProgram[deleteStart..shadowStart]);
        Assert.Contains("RequireAuthorization(\"ServiceKeyWrite\")", consoleProgram[deleteStart..shadowStart]);
    }

    [Fact]
    public void ServingCidrGate_ConsumesOnlyTheProxyAppendedRightmostHop()
    {
        var servingProgram = ReadRepoFile("llmgw/serving/Program.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

        Assert.Contains("options.ForwardLimit = 1", servingProgram);
        Assert.Contains("options.KnownNetworks.Clear()", servingProgram);
        Assert.Contains("options.KnownProxies.Clear()", servingProgram);
        Assert.True(
            servingProgram.IndexOf("app.UseForwardedHeaders()", StringComparison.Ordinal)
            < servingProgram.IndexOf("app.MapGatewayServingEndpoints", StringComparison.Ordinal),
            "CIDR 鉴权前必须先把代理追加的最右侧来源地址解析到 RemoteIpAddress");
        Assert.Contains("context.Connection.RemoteIpAddress", endpoints);
    }

    [Fact]
    public void NativeQuickstart_UsesTheSameSourceSystemInHeaderAndBody()
    {
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");

        Assert.Contains("X-Gateway-Source: external", quickstart);
        Assert.Contains("sourceSystem: 'external'", quickstart);
        Assert.Contains("/gw/v1/invoke", quickstart);
        Assert.Contains("VITE_LLMGW_SERVING_BASE_URL", quickstart);
        Assert.DoesNotContain("hostname.replace('-llmgw-web.', '.')", quickstart);
        Assert.Contains("return new URL(window.location.href).origin", quickstart);
        Assert.DoesNotContain("gateway.example.com", quickstart);
    }

    [Fact]
    public void FinalPlatformAcceptance_UsesAuthenticatedTenantContextAndFourPublicProtocols()
    {
        var acceptance = ReadRepoFile("scripts/llmgw-prod-governance-acceptance.sh");
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");
        var home = ReadRepoFile("llmgw/web/src/pages/HomePage.tsx");

        Assert.Contains("$console_base/auth/login", acceptance);
        Assert.Contains("$console_base/auth/context", acceptance);
        Assert.Contains("TenantId: tenantId", acceptance);
        Assert.DoesNotContain("LLMGW_JWT_SECRET", acceptance);
        Assert.DoesNotContain("urlsafe_b64encode", acceptance);
        Assert.DoesNotContain("deleteMany({ AppCallerCode: caller })", acceptance);
        Assert.DoesNotContain("findOne({ AppCallerCode:", acceptance);

        foreach (var protocol in new[] { "GW Native", "OpenAI", "Claude", "Gemini" })
        {
            Assert.Contains($"label: '{protocol}'", quickstart);
            Assert.Contains($"'{protocol}'", home);
        }

        Assert.DoesNotContain("'OpenAI Chat'", home);
        Assert.DoesNotContain("'OpenAI Responses'", home);
    }

    [Fact]
    public void ProductionReleaseSafety_IsPersistedAsRuleDebtAndAgentTrigger()
    {
        var rule = ReadRepoFile("doc/rule.platform.production-release-safety.md");
        var debt = ReadRepoFile("doc/debt.platform.production-release.md");
        var agentRule = ReadRepoFile(".claude/rules/production-release-safety.md");
        var codexRule = ReadRepoFile(".Codex/rules/production-release-safety.md");
        var agents = ReadRepoFile("AGENTS.md");
        var hotfixSkill = ReadRepoFile(".claude/skills/production-hotfix-release/SKILL.md");
        var cdsDeploySkill = ReadRepoFile(".claude/skills/cds-deploy-pipeline/SKILL.md");
        var smokeSkill = ReadRepoFile(".claude/skills/smoke-test/SKILL.md");
        var acceptanceSkill = ReadRepoFile(".claude/skills/acceptance-checklist/SKILL.md");
        var handoffSkill = ReadRepoFile(".claude/skills/task-handoff-checklist/SKILL.md");

        Assert.Contains("公网 HTML 与入口资源是完成门", codexRule);
        Assert.Contains("doc/rule.platform.production-release-safety.md", agentRule);
        Assert.Contains("production-release-safety.md", agents);
        Assert.Contains("`GET /` 返回 200", rule);
        Assert.Contains("`umask 077`", rule);
        Assert.Contains("`./exec_dep.sh release` 的兼容合同是部署 latest", rule);
        Assert.Contains("自动恢复 previous", rule);
        Assert.Contains("首次把目录设置为 `700` 的具体进程无法从现有证据中确定", rule);
        Assert.Contains("2026-07-12-atomic-static-release", debt);
        Assert.Contains("2026-07-12-public-surface-smoke", debt);
        Assert.Contains("2026-07-12-release-command-compatibility", debt);
        Assert.Contains("2026-07-12-release-forensic-ledger", debt);
        foreach (var skill in new[] { hotfixSkill, cdsDeploySkill, smokeSkill, acceptanceSkill, handoffSkill })
            Assert.Contains("doc/rule.platform.production-release-safety.md", skill);
        Assert.Contains("API smoke 通过后继续使用 `preview-url` 与 `acceptance-checklist`", smokeSkill);
        Assert.Contains("实际入口 JS/CSS", hotfixSkill);
        Assert.Contains("previous/回滚验证", acceptanceSkill);
        Assert.Contains("不能写完成", handoffSkill);
    }

    [Fact]
    public void ProductionStaticDist_RequiresEntryAssetsAndNormalizesPermissions()
    {
        var deploy = ReadRepoFile("exec_dep.sh");
        var validator = ReadRepoFile("scripts/validate-static-dist.sh");
        var behaviorTest = ReadRepoFile("scripts/tests/validate-static-dist.test.sh");

        Assert.Contains("[ ! -s deploy/web/dist/index.html ]", deploy);
        Assert.Contains("scripts/validate-static-dist.sh --normalize deploy/web/dist", deploy);
        Assert.Contains("find \"$static_root\" -type d -exec chmod 755 {} +", validator);
        Assert.Contains("find \"$static_root\" -type f -exec chmod 644 {} +", validator);
        Assert.Contains("index.html does not reference a local JavaScript entry asset", validator);
        Assert.Contains("referenced entry asset is missing or empty", validator);
        Assert.Contains("umask 077", behaviorTest);
        Assert.Contains("expected missing index validation to fail", behaviorTest);
        Assert.Contains("expected missing entry asset validation to fail", behaviorTest);
    }

    [Fact]
    public void TenantOverviewAndLearningCenter_AreTenantScopedAndExplainTheFullAccessChain()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var dtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var webApi = ReadRepoFile("llmgw/web/src/lib/api.ts");
        var webTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var home = ReadRepoFile("llmgw/web/src/pages/HomePage.tsx");
        var learning = ReadRepoFile("llmgw/web/src/pages/LearningCenterPage.tsx");
        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");

        const string overviewSignature = "app.MapGet(\"/gw/overview\", async (HttpContext http, string? from, string? to) =>";
        var overviewStart = console.IndexOf(overviewSignature, StringComparison.Ordinal);
        var overviewEnd = console.IndexOf("app.MapGet(\"/gw/protocol-coverage\"", overviewStart, StringComparison.Ordinal);
        Assert.True(overviewStart >= 0 && overviewEnd > overviewStart, "找不到租户首页聚合端点");
        var overview = console[overviewStart..overviewEnd];

        Assert.Contains(overviewSignature, overview);
        Assert.Contains("TenantAccess.FilterTeamScope(http, fb.And(", overview);
        Assert.Contains("serviceKeys.Find(TenantAccess.FilterTeamScope(http, fb.Empty))", overview);
        Assert.Contains("fb.Ne(\"IsHealthProbe\", true)", overview);
        Assert.Contains("from/to 必须是有效的 UTC 日期时间", overview);
        Assert.Contains("TenantAccess.HasPermission(http.User, LlmGwPermissions.LogsRead)", overview);
        Assert.Contains("RequireAuthorization(\"UsageRead\")", overview);
        Assert.DoesNotContain("string? tenantId", overview);
        Assert.DoesNotContain("EstimatedCostUsd = 0", overview);
        Assert.Contains("public sealed class TenantOverviewData", dtos);
        Assert.Contains("public sealed class ServiceKeyOverview", dtos);
        Assert.Contains("TenantOverviewData", webTypes);
        Assert.Contains("getTenantOverview", webApi);
        Assert.Contains("getTenantOverview({ from: from.toISOString(), to: to.toISOString() })", home);
        Assert.Contains("CNY 与 USD 不做无汇率相加", home);
        Assert.Contains("无请求时不显示 0%", home);

        Assert.Contains("path=\"/learn\"", app);
        Assert.Contains("to: '/learn', label: '学习中心'", layout);
        Assert.Contains("to=\"/learn\"", layout);
        foreach (var concept in new[] { "租户", "团队与用户", "appCaller", "租户接入密钥", "模型池", "模型", "Provider", "Exchange", "请求记录", "用量与费用" })
        {
            Assert.Contains(concept, learning);
        }
    }

    [Fact]
    public void PromptPolicy_IsTenantScopedChatVisionOnlyAndLogsMetadataWithoutPolicyBody()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var serving = ReadRepoFile("llmgw/serving/GatewayPromptPolicyApplier.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");

        Assert.Contains("uniq_llmgw_prompt_policy_tenant_caller_type_version", console);
        Assert.Contains("Builders<BsonDocument>.IndexKeys.Ascending(\"TenantId\").Ascending(\"AppCallerCode\").Ascending(\"RequestType\").Ascending(\"Version\")", console);
        const string teamIndex = "Builders<BsonDocument>.IndexKeys.Ascending(\"TenantId\").Ascending(\"TeamId\").Ascending(\"UpdatedAt\")";
        Assert.Contains(teamIndex, console);
        Assert.Contains(teamIndex, initializer);
        Assert.Contains("fb.Eq(\"TenantId\", tenantId)", serving);
        Assert.Contains("requestType is not (\"chat\" or \"vision\")", serving);
        Assert.DoesNotContain("GatewayPromptPolicyApplier.ApplyAsync(services, request, ingress)", endpoints);
        Assert.Contains("RedactAppliedPromptPolicy(requestBody, request.Context)", gateway);
        Assert.Contains("PromptPolicyId: request.Context?.PromptPolicyId", gateway);
        Assert.Contains("PromptPolicyHash: request.Context?.PromptPolicyHash", gateway);
        Assert.Contains("SystemPromptText: string.IsNullOrWhiteSpace(request.Context?.PromptPolicyId) ? request.Context?.SystemPromptText : null", gateway);
    }

    [Fact]
    public void Compose_DeclaresGatewayDatabaseName_ForApiAndServing()
    {
        var dockerCompose = ReadRepoFile("docker-compose.yml");
        var cdsCompose = ReadRepoFile("cds-compose.yml");

        Assert.Contains("LlmGateway__DatabaseName=${LLMGW_DATABASE_NAME:-llm_gateway}", dockerCompose);
        Assert.Contains("LlmGateway__Mode=${LLMGW_MODE}", dockerCompose);
        Assert.DoesNotContain("LlmGateway__Mode=${LLMGW_MODE:-inproc}", dockerCompose);
        Assert.Contains("LlmGateway__Mode: \"inproc\"", cdsCompose);
        Assert.True(
            dockerCompose.Split("LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers=", StringSplitOptions.None).Length - 1 >= 3,
            "api、llmgw-serve、llmgw 必须同时收到 registered appCaller 配置权威退场开关");
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers: \"${LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_REGISTERED_APP_CALLERS:-false}\"", cdsCompose);
        Assert.True(
            cdsCompose.Split("LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers:", StringSplitOptions.None).Length - 1 >= 2,
            "CDS api 与 llmgw-serve 必须同时收到 registered appCaller 配置权威退场开关");
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        Assert.Contains("llmgw_app_caller_duplicate_archive", initializer);
        Assert.Contains("app_caller.deduplicate", initializer);
        Assert.Contains("duplicate.ToBsonDocument()", initializer);
        Assert.True(
            initializer.IndexOf("archive.ReplaceOneAsync", StringComparison.Ordinal)
            < initializer.IndexOf("callers.DeleteManyAsync", StringComparison.Ordinal),
            "重复 appCaller 必须先完整归档再删除");
        Assert.Contains("LlmGateway__HttpAppCallerAllowlist=${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}", dockerCompose);
        Assert.Contains("LlmGateway__ShadowFullSamplePercent=${LLMGW_SHADOW_FULL_SAMPLE_PERCENT:-0}", dockerCompose);
        Assert.Contains("LlmGateway__ShadowFullSampleAppCallerAllowlist=${LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST:-}", dockerCompose);
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForActiveAppCallers=${LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS:-false}", dockerCompose);
        Assert.Contains("LlmGateway__RolloutLedgerPath=/app/.llmgw-release-evidence/rollout-ledger.jsonl", dockerCompose);
        Assert.Contains("./.llmgw-release-evidence:/app/.llmgw-release-evidence:ro", dockerCompose);
        Assert.Contains("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:-}", dockerCompose);
        Assert.Contains("LLMGW_ADMIN_FORCE_RESET=${LLMGW_ADMIN_FORCE_RESET:-}", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:?", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_USER", dockerCompose);
        Assert.Contains("LlmGateway__DatabaseName: llm_gateway", cdsCompose);
        Assert.Contains("控制台账号长期权威是 llm_gateway.llmgw_console_users", cdsCompose);
    }

    [Fact]
    public void ShadowForceSampling_PropagatesAcrossQueuedRuns()
    {
        var imageRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ImageGenRun.cs");
        var transcriptRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/TranscriptRun.cs");
        var documentRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/DocumentStoreAgentRun.cs");
        var videoGenRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/VideoGenModels.cs");
        var videoToDocRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/VideoToDocModels.cs");

        foreach (var model in new[] { imageRun, transcriptRun, documentRun, videoGenRun, videoToDocRun })
        {
            Assert.Contains("public bool ForceFullShadowSample { get; set; }", model);
        }

        var imageController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs");
        var imageMasterController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs");
        var transcriptController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/TranscriptAgentController.cs");
        var documentController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs");
        var videoController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs");
        var videoService = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/VideoGenService.cs");

        foreach (var creator in new[] { imageController, imageMasterController, transcriptController, documentController, videoController, videoService })
        {
            Assert.Contains("ForceFullShadowSample = _llmRequestContext.Current?.ForceFullShadowSample == true", creator);
        }

        var imageWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");
        var transcriptWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/TranscriptRunWorker.cs");
        var subtitleProcessor = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/SubtitleGenerationProcessor.cs");
        var reprocessProcessor = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ContentReprocessProcessor.cs");
        var videoWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs");
        var videoToDocWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/VideoToDocRunWorker.cs");

        foreach (var worker in new[] { imageWorker, transcriptWorker, subtitleProcessor, reprocessProcessor, videoWorker, videoToDocWorker })
        {
            Assert.Contains("ForceFullShadowSample: run.ForceFullShadowSample", worker);
        }
    }

    [Fact]
    public void ExecDep_RequiresReleaseGateBeforeFullHttpOrCanaryMode()
    {
        var script = ReadRepoFile("exec_dep.sh");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("run_llmgw_release_gate_if_needed", script);
        Assert.Contains("check_fast_release_intent", script);
        Assert.Contains("PRD_AGENT_RELEASE_INTENT_FILE", script);
        Assert.Contains(".prd-agent-release-intent.env", script);
        Assert.Contains("PRD_AGENT_REQUIRE_FAST_INTENT", script);
        Assert.Contains("PRD_AGENT_IGNORE_FAST_INTENT", script);
        Assert.Contains("fast.sh / exec_dep.sh release ref mismatch", script);
        Assert.Contains("guard_llmgw_prod_stage_context_if_needed", script);
        Assert.Contains("Release intent: matched fast.sh warmup", script);
        Assert.Contains("LLMGW_HTTP_APP_CALLER_ALLOWLIST", script);
        Assert.Contains("read_dotenv_value", script);
        Assert.Contains("config_value LLMGW_MODE LlmGateway__Mode", script);
        Assert.Contains("config_value LLMGW_HTTP_APP_CALLER_ALLOWLIST LlmGateway__HttpAppCallerAllowlist", script);
        Assert.Contains("config_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT LlmGateway__ShadowFullSamplePercent", script);
        Assert.Contains("config_value LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST LlmGateway__ShadowFullSampleAppCallerAllowlist", script);
        Assert.Contains("mode_raw=\"$(llmgw_mode_value)\"", script);
        Assert.Contains("LLMGW_POST_DEPLOY_VERIFY_NEEDED", script);
        Assert.Contains("LLMGW_POST_DEPLOY_GATE_BASE", script);
        Assert.Contains("run_llmgw_post_deploy_verification_if_needed", script);
        Assert.Contains("allowlist_compact", script);
        Assert.Contains("LLMGW_CANARY_STAGE", script);
        Assert.Contains("canary_allowed_app_callers=\"report-agent.generate::chat\"", script);
        Assert.Contains("canary_allowed_app_callers=\"report-agent.generate::chat prd-agent-desktop.chat.sendmessage::chat open-platform-agent.proxy::chat\"", script);
        Assert.Contains("canary_allowed_app_callers=\"visual-agent.image.vision::generation\"", script);
        Assert.Contains("canary_allowed_app_callers=\"visual-agent.image-gen.generate::generation visual-agent.image.text2img::generation visual-agent.image.img2img::generation\"", script);
        Assert.Contains("canary_allowed_app_callers=\"video-agent.videogen::video-gen visual-agent.videogen::video-gen document-store.subtitle::asr transcript-agent.transcribe::asr video-agent.v2d.transcribe::asr video-agent.video-to-text::asr\"", script);
        Assert.Contains("LLM Gateway canary 发布设置了 LLMGW_HTTP_APP_CALLER_ALLOWLIST，但未设置 LLMGW_CANARY_STAGE", script);
        Assert.Contains("LLM Gateway canary 阶段 $canary_stage 不允许入口 $app_trimmed", script);
        Assert.Contains("LLM Gateway canary stage: $canary_stage allowlist=$allowlist_compact", script);
        Assert.Contains("LLMGW_SHADOW_FULL_SAMPLE_PERCENT", script);
        Assert.Contains("shadow_sample_allowlist_compact", script);
        Assert.Contains("shadow_sample_enabled=0", script);
        Assert.Contains("if [ -n \"$shadow_sample_allowlist_compact\" ]; then", script);
        Assert.Contains("release_gate_required=0", script);
        Assert.Contains("if [ \"$release_gate_required\" != \"1\" ] && [ \"$shadow_sample_enabled\" != \"1\" ]; then", script);
        Assert.Contains("LLMGW_PROD_STAGE_ACTIVE", script);
        Assert.Contains("LLMGW_PROD_STAGE", script);
        Assert.Contains("必须通过 scripts/llmgw-prod-stage.sh 执行", script);
        Assert.Contains("绕过 rollout ledger、生产预检和阶段顺序审计", script);
        Assert.Contains("shadow sample startup", script);
        Assert.Contains("serving/smoke verification runs after compose up", script);
        Assert.Contains("LLM Gateway http/canary/shadow sample 发布需要提供 LLMGW_GATE_BASE 或 GW_BASE", script);
        Assert.Contains("LLM Gateway http/canary/shadow sample 发布需要提供 LLMGW_GATE_KEY/GW_KEY 或 LLMGW_SERVE_KEY", script);
        Assert.Contains("expect_commit=\"${TAG#sha-}\"", script);
        Assert.DoesNotContain("args=\"$args --expect-commit $expect_commit\"", script);
        Assert.Contains("probe_args=\"$probe_args --expect-commit $expect_commit\"", script);
        Assert.Contains("LLMGW_GATE_HEALTH_SAMPLES", script);
        Assert.Contains("LLMGW_GATE_HEALTH_INTERVAL_SECONDS", script);
        Assert.Contains("--health-samples ${LLMGW_GATE_HEALTH_SAMPLES:-3}", script);
        Assert.Contains("--health-interval ${LLMGW_GATE_HEALTH_INTERVAL_SECONDS:-5}", script);
        Assert.Contains("LLMGW_GATE_SHADOW_SINCE_HOURS", script);
        Assert.Contains("--since-hours ${LLMGW_GATE_SHADOW_SINCE_HOURS:-48}", script);
        Assert.Contains("LLMGW_GATE_MIN_COVERAGE_HOURS", script);
        Assert.Contains("--min-coverage-hours $gate_min_coverage_hours", script);
        Assert.Contains("默认要求 shadow 证据覆盖 24 小时", script);
        Assert.Contains("LLMGW_GATE_FULL_HTTP_APP_CALLERS", script);
        Assert.Contains("gate_app_callers_raw=\"${LLMGW_GATE_FULL_HTTP_APP_CALLERS:-report-agent.generate::chat", script);
        Assert.Contains("prd-agent-desktop.chat.sendmessage::chat", script);
        Assert.Contains("prd-agent-desktop.preview-ask.section::chat", script);
        Assert.Contains("open-platform-agent.proxy::chat", script);
        Assert.Contains("open-api.proxy::chat", script);
        Assert.Contains("open-api.proxy::generation", script);
        Assert.Contains("prd-agent-web.model-lab.run::chat", script);
        Assert.Contains("prd-agent.arena.battle::chat", script);
        Assert.Contains("tutorial-email.generate::chat", script);
        Assert.Contains("visual-agent.image-gen.generate::generation", script);
        Assert.Contains("visual-agent.image.text2img::generation", script);
        Assert.Contains("visual-agent.image.img2img::generation", script);
        Assert.Contains("visual-agent.image.vision::generation", script);
        Assert.Contains("video-agent.videogen::video-gen", script);
        Assert.Contains("document-store.subtitle::asr", script);
        Assert.Contains("transcript-agent.transcribe::asr", script);
        Assert.Contains("video-agent.v2d.transcribe::asr", script);
        Assert.Contains("video-agent.video-to-text::asr", script);
        Assert.Contains("LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_APP_CALLERS，默认要求核心入口逐个达标", script);
        Assert.Contains("LLMGW_GATE_REQUIRED_KINDS", script);
        Assert.Contains("required_kinds_raw=\"${LLMGW_GATE_REQUIRED_KINDS:-}\"", script);
        Assert.Contains("if [ \"$mode\" = \"http\" ] && [ \"$maintenance_release\" != \"1\" ] && [ -z \"$required_kinds_compact\" ]; then", script);
        Assert.Contains("full_http_kind_min=\"${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}\"", script);
        Assert.Contains("required_kinds_raw=\"send:${full_http_kind_min},stream:${full_http_kind_min},raw:${full_http_kind_min}\"", script);
        Assert.Contains("LLMGW_GATE_CANARY_KIND_MIN", script);
        Assert.Contains("required_kinds_raw=\"send:${canary_kind_min}\"", script);
        Assert.Contains("required_kinds_raw=\"stream:${canary_kind_min}\"", script);
        Assert.Contains("required_kinds_raw=\"raw:${canary_kind_min}\"", script);
        Assert.Contains("LLM Gateway release gate: canary 阶段 $canary_stage 未设置 LLMGW_GATE_REQUIRED_KINDS，默认要求 $required_kinds_raw", script);
        Assert.Contains("args=\"$args --require-kind $kind_req_trimmed\"", script);
        Assert.Contains("LLMGW_GATE_REQUIRED_APP_KINDS", script);
        Assert.Contains("LLMGW_GATE_FULL_HTTP_APP_KINDS", script);
        Assert.Contains("required_app_kinds_raw=\"${LLMGW_GATE_REQUIRED_APP_KINDS:-}\"", script);
        Assert.Contains("full_http_app_kind_min=\"${LLMGW_GATE_FULL_HTTP_APP_KIND_MIN:-${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}}\"", script);
        Assert.Contains("report-agent.generate::chat:send:", script);
        Assert.Contains("prd-agent-desktop.chat.sendmessage::chat:stream:", script);
        Assert.Contains("prd-agent-desktop.preview-ask.section::chat:stream:", script);
        Assert.Contains("open-platform-agent.proxy::chat:stream:", script);
        Assert.Contains("open-api.proxy::chat:send:", script);
        Assert.Contains("open-api.proxy::generation:raw:", script);
        Assert.Contains("prd-agent-web.model-lab.run::chat:stream:", script);
        Assert.Contains("prd-agent.arena.battle::chat:stream:", script);
        Assert.Contains("tutorial-email.generate::chat:send:", script);
        Assert.Contains("visual-agent.image-gen.generate::generation:raw:", script);
        Assert.Contains("visual-agent.image.text2img::generation:raw:", script);
        Assert.Contains("visual-agent.image.img2img::generation:raw:", script);
        Assert.Contains("visual-agent.image.vision::generation:raw:", script);
        Assert.Contains("video-agent.videogen::video-gen:raw:", script);
        Assert.Contains("visual-agent.videogen::video-gen:raw:", script);
        Assert.Contains("document-store.subtitle::asr:raw:", script);
        Assert.Contains("transcript-agent.transcribe::asr:raw:", script);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw:", script);
        Assert.Contains("video-agent.video-to-text::asr:raw:", script);
        Assert.Contains("LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_REQUIRED_APP_KINDS，默认要求核心 send/stream/raw 入口逐个具备 app-kind 样本", script);
        Assert.Contains("LLMGW_GATE_CANARY_APP_KIND_MIN", script);
        Assert.Contains("LLMGW_GATE_CANARY_APP_KINDS", script);
        Assert.Contains("LLM Gateway release gate: canary 阶段 $canary_stage 默认要求 raw app-kind 样本逐个达标", script);
        Assert.Contains("args=\"$args --require-app-kind $app_kind_req_trimmed\"", script);
        Assert.Contains("for app in ${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}; do", script);
        Assert.Contains("LLM Gateway release gate: required before deploy (selected shadow evidence commit; new commit probes run after compose up)", script);
        Assert.Contains("shadow_release_commit=\"$(printf '%s' \"${LLMGW_GATE_SHADOW_RELEASE_COMMIT:-$expect_commit}\" | xargs || true)\"", script);
        Assert.Contains("args=\"$args --shadow-release-commit $shadow_release_commit\"", script);
        Assert.Contains("LLMGW_GATE_JSON_OUT", script);
        Assert.Contains("args=\"$args --json-out $LLMGW_GATE_JSON_OUT\"", script);
        Assert.Contains("LLMGW_GATE_REPORT_MD", script);
        Assert.Contains("args=\"$args --report-md $LLMGW_GATE_REPORT_MD\"", script);
        Assert.Contains("python3 scripts/llmgw-release-gate.py", script);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE", script);
        Assert.Contains("scripts/gw-smoke.py", script);
        Assert.Contains("LLMGW_GATE_SMOKE_TIMEOUT_SECONDS", script);
        Assert.Contains("GW_SMOKE_JSON_OUT", script);
        Assert.Contains("GW_SMOKE_REPORT_MD", script);
        Assert.Contains("GW_EXPECT_COMMIT=\"$expect_commit\"", script);
        Assert.Contains("GW_BASE=\"$gate_base\" GW_KEY=\"$gate_key\" GW_TIMEOUT=\"${LLMGW_GATE_SMOKE_TIMEOUT_SECONDS:-120}\" GW_EXPECT_COMMIT=\"$expect_commit\" python3 scripts/gw-smoke.py", script);
        Assert.Contains("LLMGW_GATE_RUN_SERVING_PROBE", script);
        Assert.Contains("LLMGW_SERVING_PROBE_JSON_OUT", script);
        Assert.Contains("LLMGW_SERVING_PROBE_REPORT_MD", script);
        Assert.Contains("scripts/llmgw-serving-probe.py", script);
        Assert.Contains("scripts/llmgw-disk-space-guard.sh", script);
        Assert.Contains("LLMGW_DEPLOY_DISK_GUARD_PATH", script);
        Assert.Contains("LLMGW_DEPLOY_MIN_FREE_MB:-4096", script);
        Assert.Contains("LLM Gateway exec_dep deploy", script);
        Assert.Contains("provider_audit_required=0", script);
        Assert.Contains("if [ \"$mode\" = \"http\" ] || [ \"$canary_stage\" = \"video-asr\" ]; then", script);
        Assert.Contains("scripts/llmgw-prod-provider-config-audit.py", script);
        Assert.Contains("LLMGW_PROVIDER_AUDIT_JSON_OUT", script);
        Assert.Contains("LLMGW_PROVIDER_AUDIT_REPORT_MD", script);
        Assert.Contains("LLMGW_PROVIDER_AUDIT_SEED_EVIDENCE_JSON", script);
        Assert.Contains("LLM Gateway provider config audit: required before deploy", script);
        var providerAudit = ReadRepoFile("scripts/llmgw-prod-provider-config-audit.py");
        Assert.Contains("OpenRouter /videos requests", providerAudit);
        Assert.Contains("Volcengine Ark OpenAI chat base URL", providerAudit);
        Assert.Contains("dedicated Volcengine video adapter", providerAudit);
        Assert.Contains("externalBlockers", providerAudit);
        Assert.Contains("modelPoolConfig", providerAudit);
        Assert.Contains("asr_credential_rejected", providerAudit);
        Assert.Contains("asr_authorization_failed", providerAudit);
        Assert.Contains("asr_channel_unavailable", providerAudit);
        Assert.Contains("video_channel_unavailable", providerAudit);
        Assert.Contains("video_model_not_open", providerAudit);
        Assert.Contains("--self-test", providerAudit);
        Assert.Contains("_self_test_report", providerAudit);
        Assert.Contains("requiredCodes", providerAudit);
        Assert.Contains("missingCodes", providerAudit);
        Assert.Contains("requiredPairs", providerAudit);
        Assert.Contains("missingPairs", providerAudit);
        Assert.Contains("provider_audit_external_blocker_self_test", readiness);
        Assert.Contains("probe_args=\"--base $gate_base\"", script);
        Assert.Contains("python3 scripts/llmgw-serving-probe.py $probe_args", script);
        Assert.Contains("LLM Gateway post-deploy serving probe: required", script);
        Assert.Contains("LLM Gateway post-deploy D-layer smoke: required", script);
        Assert.Contains("LLMGW_POST_DEPLOY_RUN_PROTOCOL_CANARY", script);
        Assert.Contains("LLMGW_POST_DEPLOY_PROTOCOL_CANARY_JSON_OUT", script);
        Assert.Contains("LLMGW_POST_DEPLOY_PROTOCOL_CANARY_REPORT_MD", script);
        Assert.Contains("LLMGW_POST_DEPLOY_PROTOCOL_CANARY_MAX_RUNTIME_CALLS", script);
        Assert.Contains("protocol_canary_json_dir=\"$(dirname -- \"$protocol_canary_json\")\"", script);
        Assert.Contains("protocol_canary_md_dir=\"$(dirname -- \"$protocol_canary_md\")\"", script);
        Assert.Contains("mkdir -p \"$protocol_canary_json_dir\"", script);
        Assert.Contains("mkdir -p \"$protocol_canary_md_dir\"", script);
        Assert.Contains("LLM Gateway post-deploy protocol canary: required before runtime gates", script);
        Assert.Contains("LLM Gateway post-deploy protocol canary: disabled; not passing unverified JSON to runtime gates", script);
        Assert.Contains("python3 scripts/llmgw-protocol-canary.py", script);
        Assert.Contains("protocol_canary_arg=\"--protocol-canary-json $protocol_canary_json\"", script);
        Assert.Contains("$protocol_canary_arg --require-runtime-gates", script);
        Assert.Contains("[ \"$mode\" = \"http\" ] && [ \"$maintenance_release\" = \"1\" ]", script);
        Assert.Contains("skipped for audited full-http maintenance release", script);
        Assert.Contains("LLM Gateway post-deploy runtime gates: allowing self-finalizing full_http_rollout_ledger only", script);
        Assert.Contains("--allow-pending-http-full-ledger", script);
        Assert.Contains("LLMGW_GATE_SERVING_PROBE_SAMPLES", script);
        Assert.Contains("LLMGW_GATE_SERVING_PROBE_INTERVAL_SECONDS", script);
        Assert.Contains("LLMGW_SKIP_RELEASE_GATE=1", script);
        Assert.Contains("LLMGW_SKIP_RELEASE_GATE=1 is not allowed when LLM Gateway release evidence is required", script);
        Assert.Contains("Use scripts/llmgw-rollback-inproc.sh for emergency rollback", script);
        Assert.DoesNotContain("已跳过发布证据门", script);
        var protocolCanaryIdx = script.IndexOf("python3 scripts/llmgw-protocol-canary.py", StringComparison.Ordinal);
        var runtimeGatesIdx = script.IndexOf("--require-runtime-gates", StringComparison.Ordinal);
        Assert.True(protocolCanaryIdx >= 0 && runtimeGatesIdx >= 0 && protocolCanaryIdx < runtimeGatesIdx);
    }

    [Fact]
    public void FastAndExecDep_KeepApiAndGatewayImagesOnSameReleaseRef()
    {
        var fast = ReadRepoFile("fast.sh");
        var execDep = ReadRepoFile("exec_dep.sh");

        Assert.Contains("PRD_AGENT_RELEASE_INTENT_FILE", fast);
        Assert.Contains(".prd-agent-release-intent.env", fast);
        Assert.Contains("write_release_intent", fast);
        Assert.Contains("RELEASE_TAG=%s", fast);
        Assert.Contains("RELEASE_REF_TYPE=%s", fast);
        Assert.Contains("REPO=%s", fast);
        Assert.Contains("PRD_AGENT_API_IMAGE=%s", fast);
        Assert.Contains("PRD_AGENT_LLMGW_IMAGE=%s", fast);
        Assert.Contains("PRD_AGENT_LLMGW_SERVE_IMAGE=%s", fast);
        Assert.Contains("PRD_AGENT_LLMGW_WEB_IMAGE=%s", fast);
        Assert.Contains("Release intent written:", fast);

        Assert.Contains("intent_value", execDep);
        Assert.Contains("check_fast_release_intent", execDep);
        Assert.Contains("PRD_AGENT_REQUIRE_FAST_INTENT=1", execDep);
        Assert.Contains("PRD_AGENT_IGNORE_FAST_INTENT=1", execDep);
        Assert.Contains("intent_tag", execDep);
        Assert.Contains("intent_repo", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_API_IMAGE", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_LLMGW_IMAGE", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_LLMGW_SERVE_IMAGE", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_LLMGW_WEB_IMAGE", execDep);
        Assert.Contains("persist_release_image_pins", execDep);
        Assert.Contains("PRD_AGENT_PERSIST_IMAGE_PINS", execDep);
        Assert.Contains("PRD_AGENT_API_IMAGE_VALUE", execDep);
        Assert.Contains("Release image pins: persisted to", execDep);
        Assert.Contains("fast.sh / exec_dep.sh image mismatch", execDep);
        Assert.Contains("fast.sh warmed:", execDep);
        Assert.Contains("exec_dep wants:", execDep);
        Assert.Contains("fast.sh repo:", execDep);
        Assert.Contains("exec_dep repo:", execDep);
        Assert.Contains("Release intent: matched fast.sh warmup", execDep);
    }

    [Fact]
    public void MaintenanceRelease_InheritsOnlyAuditedShadowEvidence_AndRechecksNewCommit()
    {
        var stage = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var deploy = ReadRepoFile("exec_dep.sh");
        var ledger = ReadRepoFile("scripts/llmgw-rollout-ledger.py");

        Assert.Contains("--maintenance-from-commit", stage);
        Assert.Contains("llmgw-rollout-ledger.py maintenance-baseline", stage);
        Assert.Contains("--json-out \"$maintenance_baseline_json\"", stage);
        Assert.Contains("maintenance evidence commit must differ from the new release commit", stage);
        Assert.Contains("shadow_evidence_commit=\"$(python3 - \"$maintenance_baseline_json\"", stage);
        Assert.Contains("--shadow-evidence-commit \"$shadow_evidence_commit\"", stage);
        Assert.Contains("--maintenance-baseline-commit \"$maintenance_from_commit\"", stage);
        Assert.Contains("--maintenance-baseline-json \"$maintenance_baseline_json\"", stage);
        Assert.Contains("export LLMGW_GATE_SHADOW_RELEASE_COMMIT=\"$shadow_evidence_commit\"", stage);
        Assert.Contains("export LLMGW_MAINTENANCE_BASELINE_COMMIT=\"$maintenance_from_commit\"", stage);
        Assert.Contains("export LLMGW_MAINTENANCE_BASELINE_JSON=\"$maintenance_baseline_json\"", stage);
        Assert.Contains("LLMGW_GATE_SHADOW_RELEASE_COMMIT:-$expect_commit", deploy);
        Assert.Contains("LLM Gateway maintenance release: audited baseline accepted", deploy);
        Assert.Contains("args=\"--base $gate_base --min-total 0 --min-per-app 0\"", deploy);
        Assert.Contains("[ \"$maintenance_release\" != \"1\" ]", deploy);
        Assert.Contains("{ [ \"$mode\" = \"http\" ] && [ \"$maintenance_release\" != \"1\" ]; }", deploy);
        Assert.Contains("config-authority inherited from audited full-http maintenance baseline", deploy);
        Assert.Contains("LLMGW_POST_DEPLOY_EXPECT_COMMIT=\"$expect_commit\"", deploy);
        Assert.Contains("shadowEvidenceCommit", ledger);
        Assert.Contains("maintenanceBaselineCommit", ledger);
        Assert.Contains("maintenanceBaselineJson", ledger);
        Assert.Contains("allow_skipped_runtime_gates=bool(maintenance_baseline_commit)", ledger);
        Assert.Contains("args.shadow_evidence_commit or args.commit", ledger);
        Assert.Contains("def maintenance_baseline(args: argparse.Namespace)", ledger);
        Assert.Contains("maintenance baseline is stale because a later negative event exists", ledger);
        Assert.Contains("maintenance baseline release gate has no shadow checks", ledger);
        Assert.Contains("shadow_evidence_commit = _normalize_commit(stage_evidence.get(\"shadowEvidenceCommit\")) or commit", ledger);
        Assert.Contains("deployment_receipt=", stage);
        Assert.Contains("LLM Gateway deploy-once: receipt exists", stage);
        Assert.Contains("LLMGW_VERIFY_ONLY=1", stage);
        Assert.Contains("LLMGW_STAGE_FORCE_REDEPLOY_REASON", stage);
        Assert.Contains("LLMGW_DEPLOY_RECEIPT_FILE", deploy);
        Assert.Contains("LLM Gateway verify-only: preserving current containers", deploy);
    }

    [Fact]
    public void RolloutLedger_StageReport_AllowsAuditedShadowCommitDifferentFromReleaseCommit()
    {
        var root = LocateRepoRoot();
        var tempDir = Path.Combine(Path.GetTempPath(), "llmgw-maintenance-report-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            const string releaseCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            const string shadowCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            var route = new
            {
                ok = true,
                selfTestStatus = "ok",
                mode = "dry-run",
                upstreamCalled = false,
                total = 4,
                passed = 4,
                protocols = new[] { "gw-native", "openai-compatible", "claude-compatible", "gemini-compatible" },
            };
            var protocolRouter = WriteJson("protocol-router.json", new
            {
                verdict = "pass",
                scope = "static-code-and-document-evidence",
                targetComplete = false,
                runtimeEvidenceComplete = false,
                progressPercent = 90,
                remainingRuntimeGates = new[] { "current_commit_http_transport" },
            });
            var preflight = WriteJson("preflight.json", new
            {
                verdict = "pass",
                expectCommit = releaseCommit,
                mode = "start",
                checks = new[] { new { name = "gateway_route_self_test", ok = true, detail = System.Text.Json.JsonSerializer.Serialize(route) } },
            });
            var serving = WriteJson("serving.json", new
            {
                verdict = "pass",
                expectedCommit = releaseCommit,
                healthSamples = new[] { new { commit = releaseCommit } },
                routeSelfTest = route,
            });
            var releaseGate = WriteJson("release-gate.json", new
            {
                verdict = "pass",
                shadowReleaseCommit = shadowCommit,
                shadowChecks = new[] { new { label = "maintenance", releaseCommit = shadowCommit } },
                configAuthority = new
                {
                    required = true,
                    ok = true,
                    status = "ready",
                    mapFallbackObjectsRemaining = 0,
                    activeAppCallerMapFallbackReady = true,
                    activeBoundPoolWithoutUsableMember = 0,
                },
                runtimeGates = new
                {
                    required = false,
                    ok = false,
                    readyForHttpFull = false,
                    remainingRuntimeGates = Array.Empty<string>(),
                    allowedPendingRuntimeGates = Array.Empty<string>(),
                },
            });
            var maintenanceBaseline = WriteJson("maintenance-baseline.json", new
            {
                verdict = "pass",
                commit = shadowCommit,
                shadowEvidenceCommit = shadowCommit,
            });
            var report = Path.Combine(tempDir, "stage.json");

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py", "stage-report",
                    "--json-out", report,
                    "--stage", "http-full",
                    "--status", "success",
                    "--commit", releaseCommit,
                    "--shadow-evidence-commit", shadowCommit,
                    "--maintenance-baseline-commit", shadowCommit,
                    "--maintenance-baseline-json", maintenanceBaseline,
                    "--disable-map-config-fallback-for-active-app-callers", "true",
                    "--protocol-router-audit-json", protocolRouter,
                    "--prod-preflight-json", preflight,
                    "--serving-probe-json", serving,
                    "--release-gate-json", releaseGate,
                    "--release-gate-required", "1",
                    "--smoke-required", "0",
                }
            })!;
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(process.ExitCode == 0, stderr + stdout);
            var reportJson = File.ReadAllText(report);
            Assert.Contains($"\"shadowEvidenceCommit\": \"{shadowCommit}\"", reportJson);
            Assert.Contains($"\"maintenanceBaselineCommit\": \"{shadowCommit}\"", reportJson);
            Assert.Contains($"\"maintenanceBaselineJson\": \"{maintenanceBaseline.Replace("\\", "\\\\")}\"", reportJson);

            var ledger = Path.Combine(tempDir, "rollout.jsonl");
            using var appendProcess = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py", "append",
                    "--ledger", ledger,
                    "--stage", "http-full",
                    "--status", "success",
                    "--commit", releaseCommit,
                    "--evidence-json", report,
                    "--shadow-evidence-commit", shadowCommit,
                    "--maintenance-baseline-commit", shadowCommit,
                    "--maintenance-baseline-json", maintenanceBaseline,
                    "--disable-map-config-fallback-for-active-app-callers", "true",
                    "--protocol-router-audit-json", protocolRouter,
                    "--prod-preflight-json", preflight,
                    "--serving-probe-json", serving,
                    "--release-gate-json", releaseGate,
                    "--release-gate-required", "1",
                    "--smoke-required", "0",
                }
            })!;
            var appendStdout = appendProcess.StandardOutput.ReadToEnd();
            var appendStderr = appendProcess.StandardError.ReadToEnd();
            appendProcess.WaitForExit();

            Assert.True(appendProcess.ExitCode == 0, appendStderr + appendStdout);
            Assert.Contains($"\"maintenanceBaselineCommit\": \"{shadowCommit}\"", File.ReadAllText(ledger));

            var rejectedReport = Path.Combine(tempDir, "stage-without-maintenance-marker.json");
            using var rejectedProcess = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py", "stage-report",
                    "--json-out", rejectedReport,
                    "--stage", "http-full",
                    "--status", "success",
                    "--commit", releaseCommit,
                    "--shadow-evidence-commit", shadowCommit,
                    "--disable-map-config-fallback-for-active-app-callers", "true",
                    "--protocol-router-audit-json", protocolRouter,
                    "--prod-preflight-json", preflight,
                    "--serving-probe-json", serving,
                    "--release-gate-json", releaseGate,
                    "--release-gate-required", "1",
                    "--smoke-required", "0",
                }
            })!;
            var rejectedStdout = rejectedProcess.StandardOutput.ReadToEnd();
            var rejectedStderr = rejectedProcess.StandardError.ReadToEnd();
            rejectedProcess.WaitForExit();

            Assert.NotEqual(0, rejectedProcess.ExitCode);
            Assert.Contains("runtimeGates is not required+ok+ready", rejectedStderr + rejectedStdout);

            string WriteJson(string name, object value)
            {
                var path = Path.Combine(tempDir, name);
                File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(value));
                return path;
            }
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void AppCallerRouteObservations_DoNotUseOnlyTheLastRequest()
    {
        var endpoint = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var request = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("ObservedModelPolicies", request);
        Assert.Contains("ObservedModelPoolIds", request);
        Assert.Contains("ObservedParameterPolicies", request);
        Assert.Contains("AddToSet(x => x.ObservedModelPolicies, modelPolicy)", endpoint);
        Assert.Contains("AddToSet(x => x.ObservedModelPoolIds, modelPoolId)", endpoint);
        Assert.Contains("observedValues.Contains(configured)", console);
        Assert.Contains("BuildFieldDriftExpr(\"ModelPolicy\", \"LastObservedModelPolicy\", \"ObservedModelPolicies\")", console);
    }

    [Fact]
    public void GatewaySmoke_LabelsReleaseProbeAsHttpTransport()
    {
        var smoke = ReadRepoFile("scripts/gw-smoke.py");

        Assert.Contains("\"GatewayTransport\": \"http\"", smoke);
        Assert.Contains("\"SourceSystem\": \"release-probe\"", smoke);
        Assert.Contains("\"IngressProtocol\": \"gw-native\"", smoke);
        Assert.DoesNotContain("\"Context\": {\"UserId\": \"smoke-test\", \"IsHealthProbe\": True}", smoke);
    }

    [Fact]
    public void ShadowComparisonReadEndpoints_CanFilterByKind()
    {
        var servingEndpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var releaseGate = ReadRepoFile("scripts/llmgw-release-gate.py");

        Assert.Contains("string? kind", servingEndpoints);
        Assert.Contains("string? releaseCommit", servingEndpoints);
        Assert.Contains("double? sinceHours", servingEndpoints);
        Assert.Contains("Builders<LlmShadowComparison>.Filter.Eq(x => x.Kind, kind.Trim())", servingEndpoints);
        Assert.Contains("Builders<LlmShadowComparison>.Filter.Eq(x => x.ReleaseCommit, normalizedReleaseCommit)", servingEndpoints);
        Assert.Contains("Builders<LlmShadowComparison>.Filter.Gte(x => x.ComparedAt, since.Value)", servingEndpoints);
        Assert.Contains("releaseCommit = normalizedReleaseCommit", servingEndpoints);
        Assert.Contains("firstComparedAt = first", servingEndpoints);
        Assert.Contains("lastComparedAt = last", servingEndpoints);
        Assert.Contains("coverageHours", servingEndpoints);
        Assert.Contains("string? kind", consoleProgram);
        Assert.Contains("string? releaseCommit", consoleProgram);
        Assert.Contains("double? sinceHours", consoleProgram);
        Assert.Contains("fb.Eq(\"Kind\", kind.Trim())", consoleProgram);
        Assert.Contains("fb.Eq(\"ReleaseCommit\", normalizedReleaseCommit)", consoleProgram);
        Assert.Contains("FirstComparedAt", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("CoverageHours", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("ReleaseCommit", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("query_items[\"kind\"] = kind", releaseGate);
        Assert.Contains("query_items[\"releaseCommit\"] = normalized_release_commit", releaseGate);
        Assert.Contains("query_items[\"sinceHours\"] = f\"{since_hours:g}\"", releaseGate);
        Assert.Contains("--shadow-release-commit", releaseGate);
        Assert.Contains("\"shadowReleaseCommit\"", releaseGate);
        Assert.Contains("--since-hours", releaseGate);
        Assert.Contains("--min-coverage-hours", releaseGate);
        Assert.Contains("\"shadowSinceHours\"", releaseGate);
        Assert.Contains("\"minCoverageHours\"", releaseGate);
        Assert.Contains("\"coverageHours\"", releaseGate);
        Assert.Contains("观察时长不足", releaseGate);
        Assert.Contains("--require-kind", releaseGate);
        Assert.Contains("--require-app-kind", releaseGate);
        Assert.Contains("--health-samples", releaseGate);
        Assert.Contains("--health-interval", releaseGate);
        Assert.Contains("--require-runtime-gates", releaseGate);
        Assert.Contains("--allow-pending-http-full-ledger", releaseGate);
        Assert.Contains("--protocol-canary-json", releaseGate);
        Assert.Contains("_protocol_canary_check", releaseGate);
        Assert.Contains("\"protocolCanary\"", releaseGate);
        Assert.Contains("protocol canary mode 不是 execute", releaseGate);
        Assert.Contains("protocol canary 缺少协议样本", releaseGate);
        Assert.Contains("allowedPendingRuntimeGates", releaseGate);
        Assert.Contains("selfFinalizingHttpFullLedger", releaseGate);
        Assert.Contains("remaining == [\"full_http_rollout_ledger\"]", releaseGate);
        Assert.Contains("appcaller_ingress_registry_coverage", releaseGate);
        Assert.Contains("blocked runtime gates missing registry facts", releaseGate);
        Assert.Contains("\"stable\"", releaseGate);
        Assert.Contains("--json-out", releaseGate);
        Assert.Contains("--report-md", releaseGate);
        Assert.Contains("\"shadowChecks\"", releaseGate);
    }

    [Fact]
    public void ProtocolRouterAudit_AcceptsAssembledChangelogWhenFragmentWasConsumed()
    {
        var root = LocateRepoRoot();
        var report = Path.Combine(Path.GetTempPath(), $"llmgw-protocol-router-audit-{Guid.NewGuid():N}.json");

        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-protocol-router-audit.py",
                    "--json-out", report,
                }
            })!;
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(process.ExitCode == 0, stderr + stdout);
            var reportJson = File.ReadAllText(report);
            Assert.Contains("\"verdict\": \"pass\"", reportJson);
            Assert.Contains("\"name\": \"readiness_and_changelog_capture_protocol_router_progress\"", reportJson);
            Assert.Contains("\"CHANGELOG.md\"", reportJson);
        }
        finally
        {
            File.Delete(report);
        }
    }

    [Fact]
    public void ConsoleRuntimeGateEvidenceLinks_CanDeepLinkToFilteredEvidence()
    {
        var overview = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        var shadowPage = ReadRepoFile("llmgw/web/src/pages/ShadowPage.tsx");
        var auditsPage = ReadRepoFile("llmgw/web/src/pages/AuditsPage.tsx");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var consoleTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var protocolAudit = ReadRepoFile("scripts/llmgw-protocol-router-audit.py");

        Assert.Contains("public List<RuntimeGateLink> Links { get; set; } = new();", consoleDtos);
        Assert.Contains("public sealed class RuntimeGateLink", consoleDtos);
        Assert.Contains("static RuntimeGateLink Link", consoleProgram);
        Assert.Contains("static List<RuntimeGateLink> RuntimeGateLinks", consoleProgram);
        Assert.Contains("Links = RuntimeGateLinks(id, gateFacts, runtimeCommit)", consoleProgram);
        Assert.Contains("/audits?targetType=llmgw_config_authority", consoleProgram);

        Assert.Contains("function runtimeGateActionLinks", overview);
        Assert.Contains("item.links && item.links.length > 0 ? item.links : runtimeGateActionLinks", overview);
        Assert.Contains("const releaseCommit = (facts.releaseCommit || gates.releaseCommit || '').trim();", overview);
        Assert.Contains("const releaseQuery = releaseCommit ? `?releaseCommit=${encodeURIComponent(releaseCommit)}` : '';", overview);
        Assert.Contains("case 'current_commit_http_transport':", overview);
        Assert.Contains("case 'dropped_parameter_runtime_evidence':", overview);
        Assert.Contains("case 'appcaller_runtime_coverage':", overview);
        Assert.Contains("case 'appcaller_ingress_registry_coverage':", overview);
        Assert.Contains("case 'protocol_runtime_coverage':", overview);
        Assert.Contains("case 'shadow_runtime_evidence':", overview);
        Assert.Contains("case 'full_http_rollout_ledger':", overview);
        Assert.Contains("/logs${releaseQuery}", overview);
        Assert.Contains("/shadow${releaseQuery}", overview);
        Assert.Contains("/app-callers?status=active", overview);
        Assert.Contains("/app-callers?drift=any", overview);
        Assert.Contains("/audits?targetType=llmgw_config_authority", overview);

        Assert.Contains("initialQueryValue('releaseCommit')", logsView);
        Assert.Contains("releaseCommit: filterReleaseCommit.trim() || undefined", logsView);
        Assert.Contains("placeholder=\"发布提交\"", logsView);
        Assert.Contains("setFilterReleaseCommit('')", logsView);

        Assert.Contains("useSearchParams", shadowPage);
        Assert.Contains("searchParams.get('releaseCommit')", shadowPage);
        Assert.Contains("searchParams.get('appCallerCode')", shadowPage);
        Assert.Contains("searchParams.get('kind')", shadowPage);
        Assert.Contains("searchParams.get('sinceHours')", shadowPage);
        Assert.Contains("searchParams.get('quick')", shadowPage);
        Assert.Contains("releaseCommit: releaseCommit.trim() || undefined", shadowPage);
        Assert.Contains("kind: kind.trim() || undefined", shadowPage);
        Assert.Contains("sinceHours: Number.isFinite(parsedSinceHours) && parsedSinceHours > 0 ? parsedSinceHours : undefined", shadowPage);

        Assert.Contains("useSearchParams", auditsPage);
        Assert.Contains("searchParams.get('targetType')", auditsPage);
        Assert.Contains("targetType: targetType || undefined", auditsPage);

        Assert.Contains("links?: RuntimeGateLink[]", consoleTypes);
        Assert.Contains("export type RuntimeGateLink", consoleTypes);

        Assert.Contains("runtimeGateActionLinks", protocolAudit);
        Assert.Contains("Links = RuntimeGateLinks", protocolAudit);
        Assert.Contains("initialQueryValue('releaseCommit')", protocolAudit);
        Assert.Contains("/audits?targetType=llmgw_config_authority", protocolAudit);
        Assert.Contains("\"runtimeEvidenceComplete\": False", protocolAudit);
        Assert.Contains("\"progressPercent\": None", protocolAudit);
        Assert.Contains("staticEvidencePercent covers code/doc evidence only", protocolAudit);
        Assert.DoesNotContain("\"progressPercent\": static_percent", protocolAudit);
    }

    [Fact]
    public void ConsoleRuntimeGate_MaintenanceReleaseRetainsOnlyQualifiedPriorShadowEvidence()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("retainedShadowMatchesPreviousFullHttp", consoleProgram);
        Assert.Contains("ReadSuccessfulHttpFullRolloutCommits", consoleProgram);
        Assert.Contains("successfulHttpFullCommits", consoleProgram);
        Assert.Contains("retainedShadowCandidates.FirstOrDefault", consoleProgram);
        Assert.Contains("!ReadJsonBool(root, \"releaseGateRequired\")", consoleProgram);
        Assert.Contains("!ReadJsonBool(root, \"protocolCanaryRequired\")", consoleProgram);
        Assert.Contains("configAuthorityLedgerEvidence.Ready", consoleProgram);
        Assert.Contains("httpTransportLogs == releaseLogTotal", consoleProgram);
        Assert.Contains("missingIngressProtocols.Count == 0", consoleProgram);
        Assert.Contains("protocolFailedLogs == 0", consoleProgram);
        Assert.Contains("missingRuntimeCoverageAppCallers.Count == 0", consoleProgram);
        Assert.Contains("canRetainPreviousShadowEvidence ? \"retained\" : \"waiting\"", consoleProgram);
        Assert.Contains("首次切流必须跑当前 commit 的真实 appCaller shadow 样本", consoleProgram);
    }

    [Fact]
    public void ExecDep_ProvidesNoUnderscoreCompatibilityWrapper()
    {
        var wrapper = ReadRepoFile("execdep.sh");

        Assert.Contains("exec_dep.sh", wrapper);
        Assert.Contains("exec \"$script_dir/exec_dep.sh\" \"$@\"", wrapper);
    }

    [Fact]
    public void ReportAgentChatBootstrap_UsesIsolatedDedicatedPoolByDefault()
    {
        var shell = ReadRepoFile("scripts/llmgw-prod-chat-pool-bootstrap.sh");
        var script = ReadRepoFile("scripts/llmgw-prod-chat-pool-bootstrap.js");

        Assert.Contains("LLMGW_CHAT_BOOTSTRAP_ISOLATE_POOL:-1", shell);
        Assert.Contains("LLMGW_CHAT_BOOTSTRAP_POOL_CODE:-report-agent-weekly", shell);
        Assert.Contains("const nextModels = isolatePool ? [modelItem]", script);
        Assert.Contains("ModelGroupIds: isolatePool ? [pool._id]", script);
        Assert.Contains("isolated bootstrap refuses pool with Code=", script);
        Assert.Contains("IsDefaultForType: false", script);
        Assert.Contains("const gatewayDb = db.getSiblingDB(gatewayDbName)", script);
        Assert.Contains("GW authority caller must resolve exactly once", script);
        Assert.Contains("isolated GW authority bootstrap requires caller binding", script);
        Assert.Contains("tenantSource: callerTenantId ? \"caller\" : \"server-internal-default\"", script);
        Assert.Contains("otherGatewayReferences.length > 0", script);
        Assert.Contains("ModelPolicy: \"pool\"", script);
        Assert.Contains("TenantId: tenantId", script);
        Assert.Contains("GW authority post-write verification failed", script);
        Assert.Contains("backup_collection \"$gateway_db\" llmgw_model_pools", shell);
        Assert.Contains("--collection \"$backup_collection_name\" --archive --gzip", shell);
        Assert.Contains("SHA256SUMS", shell);
        Assert.DoesNotContain("LLMGW_CHAT_BOOTSTRAP_TENANT_ID", shell + script);
        Assert.DoesNotContain("const defaultPool = db.model_groups.findOne", script);
    }

    [Fact]
    public void ProdStageRunner_SequencesShadowCanaryHttpAndRollbackWithoutKeyCli()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var ledger = ReadRepoFile("scripts/llmgw-rollout-ledger.py");
        var preflight = ReadRepoFile("scripts/llmgw-prod-preflight.py");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLM Gateway production stage runner", script);
        Assert.Contains("shadow-start", script);
        Assert.Contains("canary-intent-text", script);
        Assert.Contains("canary-chat", script);
        Assert.Contains("canary-streaming", script);
        Assert.Contains("canary-vision", script);
        Assert.Contains("canary-image", script);
        Assert.Contains("canary-video-asr", script);
        Assert.Contains("rollback-rehearsal", script);
        Assert.Contains("http-full", script);
        Assert.Contains("rollback-inproc", script);
        Assert.Contains("execute=0", script);
        Assert.Contains("--execute", script);
        Assert.Contains("--min-observation-hours", script);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", script);
        Assert.Contains("LLMGW_STAGE_MIN_FREE_MB", script);
        Assert.Contains("LLMGW_STAGE_DISK_GUARD_PATH", script);
        Assert.Contains("run_stage_disk_guard", script);
        Assert.Contains("scripts/llmgw-disk-space-guard.sh", script);
        Assert.Contains("LLM Gateway production stage $stage", script);
        Assert.Contains("--main-ref", script);
        Assert.Contains("LLMGW_RELEASE_MAIN_REF", script);
        Assert.Contains("validate_main_ancestry", script);
        Assert.Contains("if [ \"$stage\" = \"rollback-inproc\" ]; then", script);
        Assert.Contains("if [ \"$stage\" = \"rollback-rehearsal\" ]; then", script);
        Assert.Contains("LLM Gateway rollback rehearsal: release main SHA recorded without ancestry enforcement", script);
        Assert.Contains("git merge-base --is-ancestor", script);
        Assert.Contains("release commit does not include latest main", script);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH", script);
        Assert.Contains("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH", script);
        Assert.Contains("validate_release_tree", script);
        Assert.Contains("critical_paths", script);
        Assert.Contains("docker-compose.yml", script);
        Assert.Contains("cds-compose.yml", script);
        Assert.Contains("execdep.sh", script);
        Assert.Contains("deploy/nginx/conf.d/branches/_standalone.conf", script);
        Assert.Contains("scripts/llmgw-map-shadow-seed.py", script);
        Assert.Contains("scripts/llmgw-report-agent-shadow-seed.py", script);
        Assert.Contains("git show \"$commit:<critical rollout/deploy files>\" | cmp local files", script);
        Assert.Contains("local rollout/deploy files must match --commit", script);
        Assert.Contains("release file differs from release commit", script);
        Assert.Contains("LLM Gateway release tree: OK", script);
        Assert.Contains("LLMGW_ALLOW_OUT_OF_ORDER_REASON", script);
        Assert.Contains("--allow-out-of-order-reason", script);
        Assert.Contains("requires --allow-out-of-order-reason", script);
        Assert.Contains("allowOutOfOrderReason", script);
        Assert.Contains("minObservationHours", script);
        Assert.Contains("LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY", script);
        Assert.DoesNotContain("--key", script);
        Assert.DoesNotContain("--gateway-key", script);
        Assert.Contains("mode=\"shadow\"", script);
        Assert.Contains("mode=\"http\"", script);
        Assert.Contains("report-agent.generate::chat,prd-agent-desktop.chat.sendmessage::chat,open-platform-agent.proxy::chat", script);
        Assert.Contains("visual-agent.image-gen.generate::generation,visual-agent.image.text2img::generation,visual-agent.image.img2img::generation", script);
        Assert.Contains("video-agent.videogen::video-gen,visual-agent.videogen::video-gen,document-store.subtitle::asr,transcript-agent.transcribe::asr,video-agent.v2d.transcribe::asr,video-agent.video-to-text::asr", script);
        Assert.Contains("export PRD_AGENT_REQUIRE_FAST_INTENT=\"${PRD_AGENT_REQUIRE_FAST_INTENT:-1}\"", script);
        Assert.Contains("export LLMGW_PROD_STAGE_ACTIVE=1", script);
        Assert.Contains("export LLMGW_PROD_STAGE=\"$stage\"", script);
        Assert.Contains("release-gate.json", script);
        Assert.Contains("serving-probe.json", script);
        Assert.Contains("gw-smoke.json", script);
        Assert.Contains("smoke_required=1", script);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE:-1", script);
        Assert.Contains("--smoke-required \"$smoke_required\"", script);
        Assert.Contains("stage-report", script);
        Assert.Contains("export LLMGW_GATE_JSON_OUT=\"${LLMGW_GATE_JSON_OUT:-$release_gate_json}\"", script);
        Assert.Contains("export LLMGW_GATE_REPORT_MD=\"${LLMGW_GATE_REPORT_MD:-$release_gate_md}\"", script);
        Assert.Contains("export LLMGW_SERVING_PROBE_JSON_OUT=\"${LLMGW_SERVING_PROBE_JSON_OUT:-$serving_probe_json}\"", script);
        Assert.Contains("export GW_SMOKE_JSON_OUT=\"${GW_SMOKE_JSON_OUT:-$smoke_json}\"", script);
        Assert.Contains("rollout-ledger.jsonl", script);
        Assert.Contains("--allow-out-of-order", script);
        Assert.Contains("validate_ledger_order", script);
        Assert.Contains("append_ledger_entry success", script);
        Assert.Contains("record_failed_stage_on_exit", script);
        Assert.Contains("append_ledger_entry failed", script);
        Assert.Contains("LLM Gateway production stage failed; appending failed rollout ledger entry.", script);
        Assert.Contains("trap record_failed_stage_on_exit EXIT", script);
        Assert.Contains("append_ledger_entry rollback", script);
        Assert.Contains("rollout_ledger_status=\"rollback\"", script);
        var failureTrap = script[
            script.IndexOf("record_failed_stage_on_exit()", StringComparison.Ordinal)..script.IndexOf("trap record_failed_stage_on_exit EXIT", StringComparison.Ordinal)];
        Assert.DoesNotContain("rollback-inproc", failureTrap);
        Assert.Contains("prod-preflight.json", script);
        Assert.Contains("video-canary.json", script);
        Assert.Contains("LLMGW_STAGE_RUN_VIDEO_CANARY", script);
        Assert.Contains("run_video_canary_evidence", script);
        Assert.Contains("scripts/llmgw-video-exchange-canary.py", script);
        Assert.Contains("LLMGW_VIDEO_CANARY_JSON_OUT", script);
        Assert.Contains("--video-canary-json \"$video_canary_json\"", script);
        Assert.Contains("--video-canary-required \"$run_video_canary\"", script);
        Assert.Contains("videoCanaryJson", script);
        Assert.Contains("videoCanaryRequired", script);
        Assert.Contains("run_prod_preflight", script);
        Assert.Contains("scripts/llmgw-prod-preflight.py --mode start", script);
        Assert.Contains("LLMGW_STAGE_MAP_BASE or PRD_AGENT_BASE", script);
        Assert.Contains("LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS=1", script);
        Assert.Contains("This does not bypass gateway release gates or completion-mode direct-transport checks.", script);
        Assert.Contains("preflight += \" --map-base ${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}\"", script);
        Assert.Contains("map_base=\"$(printf '%s' \"${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}\" | xargs || true)\"", script);
        Assert.Contains("preflight_args=\"$preflight_args --map-base $map_base\"", script);
        Assert.Contains("allow_missing_map_logs_waiver_for_stage()", script);
        Assert.Contains("canary-*|http-full)", script);
        Assert.Contains("elif [ \"${LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS:-0}\" = \"1\" ] && allow_missing_map_logs_waiver_for_stage; then", script);
        Assert.Contains("preflight_args=\"$preflight_args --allow-missing-map-logs\"", script);
        Assert.Contains("suffix=\"$suffix --allow-missing-map-logs\"", script);
        Assert.Contains("--prod-preflight-json \"$prod_preflight_json\"", script);
        Assert.Contains("scripts/llmgw-rollout-ledger.py validate", script);
        Assert.Contains("scripts/llmgw-rollout-ledger.py append", script);
        Assert.Contains("./fast.sh --commit \"$commit\"", script);
        Assert.Contains("./exec_dep.sh --commit \"$commit\"", script);
        Assert.Contains("scripts/llmgw-rollback-inproc.sh", script);
        Assert.Contains("LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh", script);

        Assert.Contains("LLM Gateway rollout ledger", ledger);
        Assert.Contains("STAGES = [", ledger);
        Assert.Contains("ROLLBACK_REHEARSAL_STAGE = \"rollback-rehearsal\"", ledger);
        Assert.Contains("_stage_requires_rehearsal", ledger);
        Assert.Contains("\"shadow-start\"", ledger);
        Assert.Contains("\"canary-video-asr\"", ledger);
        Assert.Contains("\"http-full\"", ledger);
        Assert.Contains("missing_success", ledger);
        Assert.Contains("requires rollback rehearsal success for the same commit", ledger);
        Assert.Contains("allow-out-of-order", ledger);
        Assert.Contains("allow-out-of-order-reason", ledger);
        Assert.Contains("\"allowOutOfOrder\": _bool_flag(args.allow_out_of_order)", ledger);
        Assert.Contains("\"allowOutOfOrderReason\": args.allow_out_of_order_reason.strip()", ledger);
        Assert.Contains("allowOutOfOrder missing reason", ledger);
        Assert.Contains("\"status\": args.status", ledger);
        Assert.Contains("\"evidenceJson\": args.evidence_json", ledger);
        Assert.Contains("\"prodPreflightJson\": args.prod_preflight_json", ledger);
        Assert.Contains("_require_prod_preflight_for_commit", ledger);
        Assert.Contains("production preflight evidence", ledger);
        Assert.Contains("\"servingProbeJson\": args.serving_probe_json", ledger);
        Assert.Contains("\"smokeJson\": args.smoke_json", ledger);
        Assert.Contains("\"smokeRequired\": _bool_flag(args.smoke_required)", ledger);
        Assert.Contains("append_parser.add_argument(\"--smoke-required\", default=\"1\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--smoke-required\", default=\"1\")", ledger);
        Assert.Contains("\"rollbackRehearsal\": args.stage == ROLLBACK_REHEARSAL_STAGE", ledger);
        Assert.Contains("\"releaseMainRef\": args.main_ref", ledger);
        Assert.Contains("\"releaseMainSha\": args.main_sha.lower()", ledger);
        Assert.Contains("missing releaseMainSha", ledger);
        Assert.Contains("min_observation_hours", ledger);
        Assert.Contains("rollout stage observation window not satisfied", ledger);
        Assert.Contains("_latest_success_evidence_failures", ledger);
        Assert.Contains("_existing_success_evidence_failures", ledger);
        Assert.Contains("rollout stage prior evidence validation failed", ledger);
        Assert.Contains("prior stage evidence invalid before rollout", ledger);
        Assert.Contains("existing prior stage evidence invalid before out-of-order rollout", ledger);
        Assert.Contains("rollout target success is stale because a later negative event exists", ledger);
        Assert.Contains("_entries_after", ledger);
        Assert.Contains("\"minStageObservationHours\": args.min_stage_observation_hours", ledger);
        Assert.Contains("_require_pass_json", ledger);
        Assert.Contains("_require_stage_evidence_for_commit", ledger);
        Assert.Contains("_require_stage_evidence_matches_entry", ledger);
        Assert.Contains("_require_serving_probe_for_commit", ledger);
        Assert.Contains("_require_smoke_for_commit", ledger);
        Assert.Contains("_require_release_gate_for_commit", ledger);
        Assert.Contains("runtimeEvidenceComplete must remain false in static audit evidence", ledger);
        Assert.Contains("progressPercent must not report 100 while targetComplete=false", ledger);
        Assert.Contains("allowedPendingRuntimeGates", ledger);
        Assert.Contains("selfFinalizingHttpFullLedger", ledger);
        Assert.Contains("pending_http_full_ledger_only", ledger);
        Assert.Contains("allowedPending=", ledger);
        Assert.Contains("\"providerAuditExternalBlockers\": provider_external_blockers", ledger);
        Assert.Contains("_provider_external_blockers", ledger);
        Assert.Contains("contains external blockers", ledger);
        Assert.Contains("providerExternalBlockers", ledger);
        Assert.Contains("_require_prod_health_preflight_for_commit", ledger);
        Assert.Contains("\"prodHealthPreflightJson\": args.prod_health_preflight_json", ledger);
        Assert.Contains("\"prodHealthPreflightRequired\": _bool_flag(args.prod_health_preflight_required)", ledger);
        Assert.Contains("append_parser.add_argument(\"--prod-health-preflight-json\", default=\"\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--prod-health-preflight-json\", default=\"\")", ledger);
        Assert.Contains("production health preflight evidence", ledger);
        Assert.Contains("_require_protocol_canary_for_commit", ledger);
        Assert.Contains("\"protocolCanaryJson\": args.protocol_canary_json", ledger);
        Assert.Contains("\"protocolCanaryRequired\": _bool_flag(args.protocol_canary_required)", ledger);
        Assert.Contains("append_parser.add_argument(\"--protocol-canary-json\", default=\"\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--protocol-canary-json\", default=\"\")", ledger);
        Assert.Contains("protocol canary evidence", ledger);
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("latestProtocolCanaryRequired", consoleProgram);
        Assert.Contains("latestHasProtocolCanaryJson", consoleProgram);
        Assert.Contains("missing.Add(\"protocolCanaryRequired\")", consoleProgram);
        Assert.Contains("missing.Add(\"protocolCanaryJson\")", consoleProgram);
        Assert.Contains("_canary_external_blockers", ledger);
        Assert.Contains("_merge_blockers", ledger);
        Assert.Contains("\"externalBlockers\": all_external_blockers", ledger);
        Assert.Contains("\"videoCanaryJson\": args.video_canary_json", ledger);
        Assert.Contains("\"videoCanaryRequired\": _bool_flag(args.video_canary_required)", ledger);
        Assert.Contains("\"videoCanaryExternalBlockers\": video_canary_external_blockers", ledger);
        Assert.Contains("_require_video_canary", ledger);
        Assert.Contains("video canary evidence", ledger);
        Assert.Contains("\"asrHttpCanaryJson\": args.asr_http_canary_json", ledger);
        Assert.Contains("\"asrHttpCanaryRequired\": _bool_flag(args.asr_http_canary_required)", ledger);
        Assert.Contains("\"asrHttpCanaryExternalBlockers\": asr_http_canary_external_blockers", ledger);
        Assert.Contains("_require_asr_http_canary", ledger);
        Assert.Contains("ASR HTTP canary evidence", ledger);
        Assert.Contains("missing expectedCommit for same-commit evidence", ledger);
        Assert.Contains("releaseMainSha mismatch", ledger);
        Assert.Contains("shadowReleaseCommit mismatch", ledger);
        Assert.Contains("health sample commit mismatch", ledger);
        Assert.Contains("D-layer smoke healthCommit mismatch", ledger);
        Assert.Contains("commit mismatch", ledger);
        Assert.Contains("missing shadowChecks for same-commit evidence", ledger);
        Assert.Contains("stage-report", ledger);
        Assert.Contains("ROLLOUT_SEQUENCE", ledger);
        Assert.Contains("audit", ledger);
        Assert.Contains("requireTargetSuccess", ledger);
        Assert.Contains("LLM Gateway rollout ledger audit", ledger);
        Assert.Contains("ensure_ascii=False", ledger);
        Assert.DoesNotContain("--key", ledger);

        Assert.Contains("LLM Gateway production preflight", preflight);
        Assert.Contains("--mode", preflight);
        Assert.Contains("start", preflight);
        Assert.Contains("completion", preflight);
        Assert.Contains("LLMGW_STAGE_MAP_BASE", preflight);
        Assert.Contains("missing PRD_AGENT_BASE, LLMGW_STAGE_MAP_BASE, or --map-base", preflight);
        Assert.Contains("map_logs_scope", preflight);
        Assert.Contains("map_direct_transport_absent", preflight);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_SINCE_HOURS", preflight);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_PAGE_SIZE", preflight);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_MAX_PAGES", preflight);
        Assert.Contains("directTransportSinceHours", preflight);
        Assert.Contains("gatewayTransport", preflight);
        Assert.Contains("\"direct\"", preflight);
        Assert.Contains("gateway_protected_requires_key", preflight);
        Assert.Contains("gateway_key_configured", preflight);
        Assert.Contains("rollout_ledger_start_ready", preflight);
        Assert.Contains("rollout_ledger_completion", preflight);
        Assert.Contains("PRD_AGENT_API_KEY", preflight);
        Assert.Contains("LLMGW_GATE_BASE", preflight);
        Assert.Contains("LLMGW_GATE_KEY", preflight);
        Assert.Contains("LLMGW_SERVE_KEY", preflight);
        Assert.Contains("scripts/llmgw-rollout-ledger.py", preflight);
        Assert.Contains("--require-target-success", preflight);
        Assert.Contains("\"expectCommit\"", preflight);
        Assert.DoesNotContain("print(key", preflight);
        Assert.DoesNotContain("LLMGW_GATE_KEY=\"", preflight);

        Assert.Contains("prod_stage_runner_sequences_shadow_canary_http_and_rollback", readiness);
        Assert.Contains("scripts/llmgw-prod-stage.sh", readiness);
        Assert.Contains("scripts/llmgw-rollout-ledger.py", readiness);
        Assert.Contains("scripts/llmgw-prod-preflight.py", readiness);
        Assert.Contains("map_direct_transport_absent", readiness);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_SINCE_HOURS", readiness);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_PAGE_SIZE", readiness);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_MAX_PAGES", readiness);
        Assert.Contains("directTransportSinceHours", readiness);
        Assert.Contains("gatewayTransport", readiness);
        Assert.Contains("preflightExecutable", readiness);
        Assert.Contains("ledgerExecutable", readiness);
        Assert.Contains("prod-preflight.json", readiness);
        Assert.Contains("video-canary.json", readiness);
        Assert.Contains("LLMGW_STAGE_RUN_VIDEO_CANARY", readiness);
        Assert.Contains("run_video_canary_evidence", readiness);
        Assert.Contains("scripts/llmgw-video-exchange-canary.py", readiness);
        Assert.Contains("LLMGW_VIDEO_CANARY_JSON_OUT", readiness);
        Assert.Contains("--video-canary-json \\\"$video_canary_json\\\"", readiness);
        Assert.Contains("--video-canary-required \\\"$run_video_canary\\\"", readiness);
        Assert.Contains("--asr-http-canary-json \\\"$asr_http_canary_json\\\"", readiness);
        Assert.Contains("--asr-http-canary-required \\\"$run_asr_http_canary\\\"", readiness);
        Assert.Contains("videoCanaryJson", readiness);
        Assert.Contains("videoCanaryRequired", readiness);
        Assert.Contains("asrHttpCanaryJson", readiness);
        Assert.Contains("asrHttpCanaryRequired", readiness);
        Assert.Contains("run_prod_preflight", readiness);
        Assert.Contains("scripts/llmgw-prod-preflight.py --mode start", readiness);
        Assert.Contains("--prod-preflight-json \\\"$prod_preflight_json\\\"", readiness);
        Assert.Contains("run_prod_health_preflight", readiness);
        Assert.Contains("scripts/llmgw-prod-health-preflight.py", readiness);
        Assert.Contains("prod-health-preflight.json", readiness);
        Assert.Contains("--prod-health-preflight-json \\\"$prod_health_preflight_json\\\"", readiness);
        Assert.Contains("--prod-health-preflight-required \\\"$prod_health_preflight_required\\\"", readiness);
        Assert.Contains("prodHealthPreflightRequired", readiness);
        Assert.Contains("protocol-canary.json", readiness);
        Assert.Contains("LLMGW_STAGE_RUN_PROTOCOL_CANARY", readiness);
        Assert.Contains("LLMGW_STAGE_PROTOCOL_CANARY_MAX_RUNTIME_CALLS", readiness);
        Assert.Contains("protocol_canary_default=1", readiness);
        Assert.Contains("canary-*|http-full", readiness);
        Assert.Contains("run_protocol_canary_evidence", readiness);
        Assert.Contains("scripts/llmgw-protocol-canary.py", readiness);
        Assert.Contains("--expect-commit \\\"$commit\\\"", readiness);
        Assert.Contains("--max-runtime-calls \\\"$protocol_canary_max_runtime_calls\\\"", readiness);
        Assert.Contains("--protocol-canary-json \\\"$protocol_canary_json\\\"", readiness);
        Assert.Contains("--protocol-canary-required \\\"$run_protocol_canary\\\"", readiness);
        Assert.Contains("protocolCanaryJson", readiness);
        Assert.Contains("protocolCanaryRequired", readiness);
        Assert.Contains("serving-probe.json", readiness);
        Assert.Contains("rollout-status.json", readiness);
        Assert.Contains("rolloutStatusRequired", readiness);
        Assert.Contains("rolloutStatusJson", readiness);
        Assert.Contains("run_rollout_status_ready_gate", readiness);
        Assert.Contains("scripts/llmgw-rollout-status.py", readiness);
        Assert.Contains("--require-ready", readiness);
        var releaseTreeIdx = script.IndexOf("validate_release_tree", StringComparison.Ordinal);
        var statusGateIdx = script.IndexOf("run_rollout_status_ready_gate", StringComparison.Ordinal);
        Assert.True(releaseTreeIdx >= 0 && statusGateIdx >= 0 && releaseTreeIdx < statusGateIdx);
        Assert.Contains("GW_SMOKE_JSON_OUT", readiness);
        Assert.Contains("--smoke-required \\\"$smoke_required\\\"", readiness);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE:-1", readiness);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", readiness);
        Assert.Contains("LLMGW_RELEASE_MAIN_REF", readiness);
        Assert.Contains("validate_main_ancestry", readiness);
        Assert.Contains("if [ \\\"$stage\\\" = \\\"rollback-inproc\\\" ]; then", readiness);
        Assert.Contains("if [ \\\"$stage\\\" = \\\"rollback-rehearsal\\\" ]; then", readiness);
        Assert.Contains("LLM Gateway rollback rehearsal: release main SHA recorded without ancestry enforcement", readiness);
        Assert.Contains("release commit does not include latest main", readiness);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH", readiness);
        Assert.Contains("validate_release_tree", readiness);
        Assert.Contains("local rollout/deploy files must match --commit", readiness);
        Assert.Contains("release file differs from release commit", readiness);
        Assert.Contains("LLMGW_ALLOW_OUT_OF_ORDER_REASON", readiness);
        Assert.Contains("--allow-out-of-order-reason", readiness);
        Assert.Contains("allowOutOfOrderReason", readiness);
        Assert.Contains("requires rollback rehearsal success for the same commit", readiness);
        Assert.Contains("rollout stage observation window not satisfied", readiness);
        Assert.Contains("--run-rollout-ledger", readiness);
        Assert.Contains("rollout_ledger_completion_state", readiness);
        Assert.Contains("scripts/llmgw-rollout-ledger.py", readiness);
        Assert.Contains("--require-rollout-complete", readiness);
        Assert.Contains("runtimeEvidenceComplete", readiness);
        Assert.Contains("progressPercent", readiness);
        Assert.Contains("leaksKeyArg", readiness);
    }

    [Fact]
    public void ProdStageWorkflow_RunsStageRunnerOnProductionRunnerAndUploadsEvidence()
    {
        var workflow = ReadRepoFile(".github/workflows/llmgw-prod-stage.yml");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");
        var treePrecheck = ReadRepoFile("scripts/llmgw-prod-tree-precheck.py");

        Assert.Contains("LLM Gateway Production Stage", workflow);
        Assert.Contains("workflow_dispatch:", workflow);
        Assert.Contains("stage:", workflow);
        Assert.Contains("shadow-start", workflow);
        Assert.Contains("rollback-rehearsal", workflow);
        Assert.Contains("canary-intent-text", workflow);
        Assert.Contains("canary-chat", workflow);
        Assert.Contains("canary-streaming", workflow);
        Assert.Contains("canary-vision", workflow);
        Assert.Contains("canary-image", workflow);
        Assert.Contains("canary-video-asr", workflow);
        Assert.Contains("http-full", workflow);
        Assert.Contains("rollback-inproc", workflow);
        Assert.Contains("execute:", workflow);
        Assert.Contains("default: false", workflow);
        Assert.Contains("commit:\n        description: \"40-char release commit. Required for every non-rollback-inproc stage.\"\n        required: false", workflow);
        Assert.Contains("runner_labels_json", workflow);
        Assert.Contains("[\\\"self-hosted\\\",\\\"prd-agent-prod\\\"]", workflow);
        Assert.Contains("allow_release_tree_mismatch", workflow);
        Assert.Contains("INPUT_ALLOW_RELEASE_TREE_MISMATCH", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH=1", workflow);
        Assert.Contains("allow_missing_map_logs", workflow);
        Assert.Contains("INPUT_ALLOW_MISSING_MAP_LOGS", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS=1", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH", workflow);
        Assert.Contains("release_tree_mismatch_bypass", workflow);
        Assert.Contains("environment: production", workflow);
        Assert.Contains("PRD_AGENT_PROD_BASE", workflow);
        Assert.Contains("PRD_AGENT_PROD_API_KEY", workflow);
        Assert.Contains("LLMGW_PROD_GATE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_GATE_KEY", workflow);
        Assert.Contains("PRD_AGENT_PROD_GITHUB_TOKEN", workflow);
        Assert.Contains("RUNNER_ADMIN_TOKEN_CONFIGURED", workflow);
        Assert.Contains("args+=(--allow-api-unavailable)", workflow);
        Assert.Contains("timeout-minutes: 30", workflow);
        Assert.Contains("rollout_evidence_run_id", workflow);
        Assert.Contains("actions: read", workflow);
        Assert.Contains("logs:read access", workflow);
        Assert.Contains("fetch-depth: 0", workflow);
        Assert.Contains("actions/download-artifact@v4", workflow);
        Assert.Contains("Restore previous rollout evidence", workflow);
        Assert.Contains("Restore trusted production maintenance evidence", workflow);
        Assert.Contains("PRODUCTION_EVIDENCE_SOURCE: /root/inernoro/prd_agent/.llmgw-release-evidence", workflow);
        Assert.DoesNotContain("production_evidence_source:", workflow);
        Assert.Contains("scripts/llmgw-prod-evidence-restore.py", workflow);
        Assert.Contains("--require-owner-uid 0", workflow);
        Assert.Contains("production-evidence-baseline-audit.json", workflow);
        Assert.Contains("llmgw-prod-stage-{0}", workflow);
        Assert.Contains("default branch", ReadRepoFile("doc/plan.llm-gateway.full-cutover.md"));
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ \"$stage\" != \"config-authority\" ] && [ -z \"$map_base\" ]", workflow);
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ \"$stage\" != \"config-authority\" ] && [ \"$allow_missing_map_logs\" != \"true\" ] && [ -z \"$(printf '%s' \"${PRD_AGENT_API_KEY:-}\" | xargs)\" ]", workflow);
        Assert.Contains("stage $stage requires rollout_evidence_run_id so prior rollout ledger evidence is restored", workflow);
        Assert.Contains("scripts/llmgw-prod-stage.sh", workflow);
        Assert.Contains("--stage \"$stage\"", workflow);
        Assert.Contains("--commit \"$commit\"", workflow);
        Assert.Contains("--execute", workflow);
        Assert.Contains("--dry-run", workflow);
        Assert.Contains("--repo \"$repo\"", workflow);
        Assert.Contains("--sample-percent \"$sample_percent\"", workflow);
        Assert.Contains("--min-observation-hours \"$min_observation_hours\"", workflow);
        Assert.Contains("--main-ref \"$main_ref\"", workflow);
        Assert.Contains("maintenance_from_commit", workflow);
        Assert.Contains("INPUT_MAINTENANCE_FROM_COMMIT", workflow);
        Assert.Contains("args+=(--maintenance-from-commit \"$maintenance_from_commit\")", workflow);
        Assert.Contains("maintenance_from_commit is only valid for stage http-full", workflow);
        Assert.Contains("Audit recorded maintenance release", workflow);
        Assert.Contains("scripts/llmgw-rollout-ledger.py maintenance-baseline", workflow);
        Assert.Contains("--evidence-dir \".llmgw-release-evidence\"", workflow);
        Assert.Contains("--allow-out-of-order-reason \"$allow_out_of_order_reason\"", workflow);
        Assert.Contains("scripts/llmgw-prod-tree-precheck.py", workflow);
        Assert.Contains("[ \"$execute\" = \"true\" ] && [ \"$stage\" != \"rollback-inproc\" ]", workflow);
        Assert.Contains("--allow-mismatch", workflow);
        Assert.Contains("emergency bypass is enabled; continuing to stage runner", workflow);
        Assert.Contains("--json-out \".llmgw-release-evidence/tree-precheck.json\"", workflow);
        Assert.Contains("--report-md \".llmgw-release-evidence/tree-precheck.md\"", workflow);
        Assert.Contains("scripts/llmgw-rollout-ledger.py audit", workflow);
        Assert.Contains("--require-target-success", workflow);
        Assert.Contains("stage-audit.json", workflow);
        Assert.Contains("stage-audit.md", workflow);
        Assert.Contains("actions/upload-artifact@v4", workflow);
        Assert.Contains(".llmgw-release-evidence/", workflow);
        Assert.DoesNotContain("echo \"$PRD_AGENT_API_KEY\"", workflow);
        Assert.DoesNotContain("echo \"$LLMGW_GATE_KEY\"", workflow);

        Assert.Contains("prod_stage_workflow_runs_on_production_runner_and_uploads_rollout_evidence", readiness);
        Assert.Contains(".github/workflows/llmgw-prod-stage.yml", readiness);
        Assert.Contains("leaksStageSecret", readiness);
        Assert.Contains("treePrecheckExecutable", readiness);
        Assert.Contains("treePrecheckDestructive", readiness);
        Assert.Contains("Restore previous rollout evidence", readiness);
        Assert.Contains("Restore trusted production maintenance evidence", readiness);

        var runnerPrecheck = ReadRepoFile("scripts/llmgw-prod-runner-precheck.py");
        Assert.Contains("--allow-api-unavailable", runnerPrecheck);
        Assert.Contains("deferred-to-stage-job", runnerPrecheck);
        Assert.Contains("runner_job_handshake", runnerPrecheck);

        var evidenceRestore = ReadRepoFile("scripts/llmgw-prod-evidence-restore.py");
        Assert.Contains("Restore the minimum trusted rollout evidence", evidenceRestore);
        Assert.Contains("trusted evidence must not be a symlink", evidenceRestore);
        Assert.Contains("trusted evidence escapes source root", evidenceRestore);
        Assert.Contains("trusted evidence is world-writable", evidenceRestore);
        Assert.Contains("missing successful http-full baseline", evidenceRestore);
        Assert.Contains("LLM Gateway production evidence restore self-test: PASS", evidenceRestore);

        Assert.Contains("LLM Gateway production release tree precheck", treePrecheck);
        Assert.Contains("CRITICAL_PATHS", treePrecheck);
        Assert.Contains("scripts/llmgw-prod-stage.sh", treePrecheck);
        Assert.Contains("scripts/llmgw-map-shadow-seed.py", treePrecheck);
        Assert.Contains("scripts/llmgw-report-agent-shadow-seed.py", treePrecheck);
        Assert.Contains("scripts/llmgw-rollout-status.py", treePrecheck);
        Assert.Contains("scripts/llmgw-shadow-coverage-report.py", treePrecheck);
        Assert.Contains("scripts/llmgw-shadow-sample-plan.py", treePrecheck);
        Assert.Contains("allowMismatch", treePrecheck);
        Assert.Contains("allowMismatchSource", treePrecheck);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH", treePrecheck);
        Assert.Contains("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH", treePrecheck);
        Assert.Contains("--allow-mismatch", treePrecheck);
        Assert.Contains("pathChecks", treePrecheck);
        Assert.Contains("missing-local", treePrecheck);
        Assert.Contains("missing-release", treePrecheck);
        Assert.Contains("differs", treePrecheck);
        Assert.DoesNotContain("git reset", treePrecheck);
        Assert.DoesNotContain("git checkout --", treePrecheck);
        Assert.DoesNotContain("docker compose up", treePrecheck);
    }

    [Fact]
    public void RolloutLedgerAudit_FailsWhenTargetSuccessWasLaterRolledBack()
    {
        var root = LocateRepoRoot();
        var tempDir = Path.Combine(Path.GetTempPath(), "llmgw-ledger-audit-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            var mainSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            var stageJson = Path.Combine(tempDir, "stage.json");
            var prodPreflightJson = Path.Combine(tempDir, "prod-preflight.json");
            var servingJson = Path.Combine(tempDir, "serving.json");
            var smokeJson = Path.Combine(tempDir, "smoke.json");
            var ledger = Path.Combine(tempDir, "ledger.jsonl");

            File.WriteAllText(stageJson, $$"""
            {"verdict":"pass","commit":"{{commit}}","releaseMainRef":"origin/main","releaseMainSha":"{{mainSha}}"}
            """);
            File.WriteAllText(prodPreflightJson, $$"""
            {"verdict":"pass","mode":"start","expectCommit":"{{commit}}","checks":[]}
            """);
            File.WriteAllText(servingJson, $$"""
            {"verdict":"pass","expectedCommit":"{{commit}}","healthSamples":[{"commit":"{{commit}}"}]}
            """);
            File.WriteAllText(smokeJson, $$"""
            {"verdict":"pass","expectedCommit":"{{commit}}","healthCommit":"{{commit}}"}
            """);

            File.WriteAllText(ledger, $$"""
            {"recordedAt":"2026-07-07T00:00:00+00:00","stage":"shadow-start","status":"success","commit":"{{commit}}","evidenceJson":"{{JsonPath(stageJson)}}","prodPreflightJson":"{{JsonPath(prodPreflightJson)}}","servingProbeJson":"{{JsonPath(servingJson)}}","smokeJson":"{{JsonPath(smokeJson)}}","releaseMainRef":"origin/main","releaseMainSha":"{{mainSha}}","allowOutOfOrder":false}
            {"recordedAt":"2026-07-07T01:00:00+00:00","stage":"rollback-inproc","status":"rollback","commit":"{{commit}}","evidenceJson":"","servingProbeJson":"","smokeJson":"","releaseMainRef":"origin/main","releaseMainSha":"{{mainSha}}","allowOutOfOrder":false}
            """);

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py",
                    "audit",
                    "--ledger",
                    ledger,
                    "--commit",
                    commit,
                    "--target-stage",
                    "shadow-start",
                    "--require-target-success",
                    "--min-observation-hours",
                    "0"
                }
            })!;

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.NotEqual(0, process.ExitCode);
            Assert.Contains("rollout target success is stale because a later negative event exists", stderr + stdout);
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }

        static string JsonPath(string path) => path.Replace("\\", "\\\\");
    }

    [Fact]
    public void ReadinessAudit_RequireRolloutCompleteFailsWithoutHttpFullLedger()
    {
        var root = LocateRepoRoot();
        var tempDir = Path.Combine(Path.GetTempPath(), "llmgw-readiness-completion-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            var ledger = Path.Combine(tempDir, "rollout-ledger.jsonl");
            File.WriteAllText(ledger, string.Empty);

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-readiness-audit.py",
                    "--expect-commit",
                    commit,
                    "--rollout-ledger",
                    ledger,
                    "--rollout-target-stage",
                    "http-full",
                    "--rollout-min-observation-hours",
                    "0",
                    "--require-rollout-complete",
                    "--print-json"
                }
            })!;

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            var combined = stderr + stdout;
            Assert.NotEqual(0, process.ExitCode);
            Assert.Contains("rollout_ledger_completion_state", combined);
            Assert.Contains("missing success stage for commit: stage=http-full", combined);
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }

    [Fact]
    public void RollbackScript_ReturnsApiToInprocWithoutDatabaseRollback()
    {
        var script = ReadRepoFile("scripts/llmgw-rollback-inproc.sh");

        Assert.Contains("export LLMGW_MODE=inproc", script);
        Assert.Contains("export LLMGW_HTTP_APP_CALLER_ALLOWLIST=", script);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=0", script);
        Assert.Contains("up -d --no-deps --force-recreate \"$service_name\"", script);
        Assert.Contains("LLMGW_ROLLBACK_DRY_RUN", script);
        Assert.Contains("LLM Gateway rollback dry-run", script);
        Assert.Contains("database: unchanged", script);
        Assert.Contains("images: unchanged", script);
        Assert.Contains("LLMGW_ROLLBACK_API_SERVICE:-api", script);
        Assert.DoesNotContain("down -v", script);
        Assert.DoesNotContain("docker volume rm", script);
        Assert.DoesNotContain("mongodump", script);
        Assert.DoesNotContain("mongorestore", script);
        Assert.DoesNotContain("db.dropDatabase", script);
        Assert.DoesNotContain("git checkout", script);
    }

    [Fact]
    public void ReadinessAudit_ComposesStaticRollbackDotnetAndLiveReleaseGates()
    {
        var script = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLM Gateway full-cutover readiness audit", script);
        Assert.Contains("release_gate_supports_required_shadow_and_health_gates", script);
        Assert.Contains("exec_dep_gates_http_canary_and_shadow_sample_release", script);
        Assert.Contains("rollback_script_is_safe_and_executable", script);
        Assert.Contains("direct_client_ratchet_baselines_are_empty", script);
        Assert.Contains("multipart_http_path_has_refs_rehydrate_and_hash_guard", script);
        Assert.Contains("compose_exposes_gateway_mode_and_data_domain_controls", script);
        Assert.Contains("adminPasswordRequired", script);
        Assert.Contains("adminUserEnv", script);
        Assert.Contains("rollback_dry_run", script);
        Assert.Contains("gw_smoke_d_layer", script);
        Assert.Contains("--run-dotnet", script);
        Assert.Contains("--run-smoke", script);
        Assert.Contains("scripts/gw-smoke.py", script);
        Assert.Contains("gateway_protocol_and_shadow_unit_tests", script);
        Assert.Contains("GatewayPinnedModelTests", script);
        Assert.Contains("GatewayProtocolFidelityTests", script);
        Assert.Contains("ClaudeToolTranslationTests", script);
        Assert.Contains("ShadowLlmGatewayTests", script);
        Assert.Contains("gateway_http_boundary_unit_tests", script);
        Assert.Contains("GatewayMultipartHttpTests", script);
        Assert.Contains("GatewayKeyGateContractTests", script);
        Assert.Contains("HttpLlmGatewayClientFailureTests", script);
        Assert.Contains("gateway_cross_process_matrix_tests", script);
        Assert.Contains("CrossProcessServingSelfTest", script);
        Assert.Contains("CrossProcessServingErrorLoadTests", script);
        Assert.Contains("GatewayServingEndpointContractTests", script);
        Assert.Contains("gateway_media_contract_tests", script);
        Assert.Contains("GatewayDoubaoStreamAsrTests", script);
        Assert.Contains("OpenRouterVideoClientGatewayTests", script);
        Assert.Contains("GW_TIMEOUT", script);
        Assert.Contains("GW_EXPECT_COMMIT", ReadRepoFile("scripts/gw-smoke.py"));
        Assert.Contains("--require-release-gate", script);
        Assert.Contains("scripts/llmgw-release-gate.py", script);
        Assert.Contains("GW_KEY", script);
        Assert.Contains("LLMGW_GATE_SHADOW_SINCE_HOURS", script);
        Assert.Contains("shadow_coverage_report_available", script);
        Assert.Contains("--run-shadow-coverage", script);
        Assert.Contains("scripts/llmgw-shadow-coverage-report.py", script);
        Assert.Contains("serving_probe_available", script);
        Assert.Contains("fast_writes_same_commit_release_intent", script);
        Assert.Contains("prod_health_preflight_is_readonly_commit_gate", script);
        Assert.Contains("scripts/llmgw-prod-health-preflight.py", script);
        var prodHealthPreflight = ReadRepoFile("scripts/llmgw-prod-health-preflight.py");
        Assert.Contains("Read-only LLM Gateway production health preflight", prodHealthPreflight);
        Assert.Contains("/gw/v1/healthz", prodHealthPreflight);
        Assert.Contains("--expect-current-head", prodHealthPreflight);
        Assert.Contains("--check-auth-boundary", prodHealthPreflight);
        Assert.Contains("healthz commit mismatch", prodHealthPreflight);
        Assert.Contains("auth boundary expected 401", prodHealthPreflight);
        Assert.Contains("never calls model providers", prodHealthPreflight);
        Assert.Contains("--run-serving-probe", script);
        Assert.Contains("scripts/llmgw-serving-probe.py", script);
        Assert.Contains("serving_stability_and_auth_probe", script);
        Assert.Contains("--run-cds-runtime", script);
        Assert.Contains("cds_runtime_uses_release_gateway_profiles", script);
        Assert.Contains("branch status is not running", script);
        Assert.Contains("lastDeployDispatchCommitSha mismatch", script);
        Assert.Contains("LLMGW_CDS_RELEASE_PROFILES", script);
        Assert.Contains("api-prd-agent,llmgw-prd-agent,llmgw-serve-prd-agent", script);
        Assert.Contains("--run-rollout-ledger", script);
        Assert.Contains("rollout_ledger_completion_state", script);
        Assert.Contains("LLMGW_ROLLOUT_LEDGER", script);
        Assert.Contains("LLMGW_ROLLOUT_TARGET_STAGE", script);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", script);
        Assert.Contains("--require-rollout-complete", script);
        Assert.Contains("args.run_rollout_ledger or args.require_rollout_complete", script);
        Assert.Contains("LLMGW_READINESS_JSON_OUT", script);
        Assert.Contains("LLMGW_READINESS_REPORT_MD", script);
    }

    [Fact]
    public void ServingProbe_ChecksHealthCommitStabilityAndNoKeyAuth()
    {
        var script = ReadRepoFile("scripts/llmgw-serving-probe.py");

        Assert.Contains("LLM Gateway serving probe", script);
        Assert.Contains("/healthz", script);
        Assert.Contains("/readyz", script);
        Assert.Contains("_request(base, \"/readyz\", key=key)", script);
        Assert.Contains("readyz not ready", script);
        Assert.Contains("components", script);
        Assert.Contains("--expect-commit", script);
        Assert.Contains("--samples", script);
        Assert.Contains("--interval", script);
        Assert.Contains("--protected-path", script);
        Assert.Contains("--protected-endpoint", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/send\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/stream\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/client-stream\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/raw\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/profile-test\"", script);
        Assert.Contains("expectedCommit", script);
        Assert.Contains("healthSamples", script);
        Assert.Contains("protectedChecks", script);
        Assert.Contains("commit drift", script);
        Assert.Contains("protected endpoint {method} {path} should reject missing key with 401", script);
        Assert.Contains("LLMGW_SERVING_PROBE_JSON_OUT", script);
        Assert.Contains("LLMGW_SERVING_PROBE_REPORT_MD", script);
    }

    [Fact]
    public void ProductionServing_HasDeterministicComposeIdentityDeepReadinessAndTwoInstances()
    {
        var compose = ReadRepoFile("docker-compose.yml");
        var cdsCompose = ReadRepoFile("cds-compose.yml");
        var deploy = ReadRepoFile("exec_dep.sh");
        var stage = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var endpoint = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var readiness = ReadRepoFile("llmgw/serving/GatewayServingReadinessProbe.cs");
        var nginx = ReadRepoFile("deploy/nginx/conf.d/branches/_standalone.conf");
        var imageNginx = ReadRepoFile("deploy/nginx/nginx.conf");
        var providerAudit = ReadRepoFile("scripts/llmgw-prod-provider-config-audit.py");
        var topologyPreflight = ReadRepoFile("scripts/llmgw-prod-topology-preflight.sh");
        var cdsServingStart = cdsCompose.LastIndexOf("\n  llmgw-serve:\n", StringComparison.Ordinal);
        var cdsServingEnd = cdsCompose.IndexOf("\n  llmgw-web:\n", cdsServingStart, StringComparison.Ordinal);
        Assert.True(cdsServingStart >= 0 && cdsServingEnd > cdsServingStart, "CDS llmgw-serve service block missing");
        var cdsServing = cdsCompose[cdsServingStart..cdsServingEnd];
        var cdsConsoleStart = cdsCompose.LastIndexOf("\n  llmgw:\n", StringComparison.Ordinal);
        Assert.True(cdsConsoleStart >= 0 && cdsServingStart > cdsConsoleStart, "CDS llmgw service block missing");
        var cdsConsole = cdsCompose[cdsConsoleStart..cdsServingStart];
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("PRD_AGENT_COMPOSE_PROJECT_NAME", deploy);
        Assert.Contains("COMPOSE_PROJECT_NAME", deploy);
        Assert.Contains("PRD_AGENT_COMPOSE_PROJECT_NAME", stage);
        Assert.Contains("AI_ACCESS_KEY=${AI_ACCESS_KEY:-}", compose);
        Assert.Contains("wait_for_llmgw_serving_readiness", deploy);
        Assert.Contains("llmgw-prod-topology-preflight.sh", deploy);
        Assert.Contains("LLMGW_SERVE_BASE_URL must be", topologyPreflight);
        Assert.Contains("LLMGW_READINESS_ASSET_PROBE_KEY", topologyPreflight);
        Assert.Contains("LLMGW_READINESS_REQUIRE_ASSET_PROBE=true", topologyPreflight);
        Assert.Contains("location = /health", nginx);
        Assert.Contains("proxy_pass http://api:8080/health;", nginx);
        Assert.Contains("location = /health", imageNginx);
        Assert.Contains("proxy_pass http://api:8080/health;", imageNginx);
        Assert.Contains("[ \"$health\" != \"healthy\" ]", deploy);
        Assert.Contains("llmgw-serve-b:", compose);
        Assert.Contains("condition: service_healthy", compose);
        Assert.Contains("/gw/v1/healthz", compose);
        Assert.Contains("LlmGateway__Readiness__RequireAssetProbe: \"false\"", cdsServing);
        Assert.Contains("LlmGateway__MongoConnectionString", cdsServing);
        Assert.Contains("LlmGateway__MongoConnectionString", cdsConsole);
        Assert.True(
            compose.Split("LlmGateway__MongoConnectionString", StringSplitOptions.None).Length - 1 >= 3,
            "正式 compose 的控制台与两份 serving 必须使用同一 GW Mongo 配置入口");
        Assert.Contains("config[\"LlmGateway:MongoConnectionString\"]", consoleProgram);
        Assert.Contains("gatewayMongoClient.GetDatabase(gatewayDbName)", consoleProgram);
        Assert.Contains("cds.readiness-path: \"/gw/v1/healthz\"", cdsServing);
        Assert.Contains("LlmGateway__ServeBaseUrl=${LLMGW_SERVE_BASE_URL:-http://gateway}", compose);
        Assert.DoesNotContain("http://gateway/gw/v1", compose);
        Assert.Contains("MapGet(\"/gw/v1/readyz\"", endpoint);
        Assert.DoesNotContain("map-mongo", readiness);
        Assert.Contains("gateway-mongo", readiness);
        Assert.Contains("asset-storage", readiness);
        Assert.Contains("key-integrity", readiness);
        Assert.Contains("router", readiness);
        Assert.Contains("routableCallers", readiness);
        Assert.Contains("IsPoolRoutableForRequestType", readiness);
        Assert.Contains("pool.IsDefaultForType", readiness);
        Assert.Contains("HasEnabledBackend", readiness);
        Assert.Contains("governed.Count > 0 && routableCallers == 0", readiness);
        Assert.Contains("exceptionType={ExceptionType}", readiness);
        Assert.DoesNotContain("ex.Message", readiness);
        Assert.Contains("server llmgw-serve:8091", nginx);
        Assert.Contains("server llmgw-serve-b:8091", nginx);
        Assert.Contains("llmgw-serve-b:8091 backup", nginx);
        Assert.Contains("proxy_next_upstream", nginx);
        Assert.DoesNotContain("non_idempotent", nginx);
        Assert.Contains("gatewayDb.llmgw_app_callers", providerAudit);
        Assert.Contains("gatewayDb.llmgw_model_pools", providerAudit);
        Assert.Contains("deferredUnboundGroups", providerAudit);
        Assert.Contains("unbound-to-production-appCaller", providerAudit);
        Assert.Contains("ASR appCaller RequestType mismatch", providerAudit);
        Assert.Contains("video appCaller RequestType mismatch", providerAudit);
    }

    [Fact]
    public void ShadowCoverageReport_RendersExplicitCoverageCellsWithoutLeakingKey()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-coverage-report.py");
        var endpoint = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

        Assert.Contains("LLM Gateway shadow coverage", script);
        Assert.Contains("/shadow-comparisons", script);
        Assert.Contains("--app-caller", script);
        Assert.Contains("--kind", script);
        Assert.Contains("--require-kind", script);
        Assert.Contains("--require-app-kind", script);
        Assert.Contains("_parse_kind_requirement", script);
        Assert.Contains("_parse_app_kind_requirement", script);
        Assert.Contains("_upsert_cell_spec", script);
        Assert.Contains("--min-per-cell", script);
        Assert.Contains("LLMGW_HTTP_APP_CALLER_ALLOWLIST", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_JSON_OUT", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_REPORT_MD", script);
        Assert.Contains("critical", script);
        Assert.Contains("httpFail", script);
        Assert.Contains("coverageHours", script);
        Assert.Contains("--min-coverage-hours", script);
        Assert.Contains("--release-commit", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_RELEASE_COMMIT", script);
        Assert.Contains("releaseCommit", script);
        Assert.Contains("minCoverageHours", script);
        Assert.Contains("覆盖时长不足", script);
        Assert.Contains("--failure-sample-limit", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_FAILURE_SAMPLE_LIMIT", script);
        Assert.Contains("failureSamples", script);
        Assert.Contains("Failure Samples", script);
        Assert.Contains("httpError", script);
        Assert.Contains("failureLimit", endpoint);
        Assert.Contains("failureRecent", endpoint);
        Assert.Contains("Filter.Eq(x => x.HttpOk, false)", endpoint);
        Assert.DoesNotContain("for app in app_callers:\n            for kind in kinds:", script);
        Assert.DoesNotContain("print(key", script);
        Assert.DoesNotContain("GW_KEY=\"", script);
    }

    [Fact]
    public void ShadowWatchWorkflow_RunsScheduledEvidenceGateWithoutLeakingKey()
    {
        var workflow = ReadRepoFile(".github/workflows/llmgw-shadow-watch.yml");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("cron: \"17 */6 * * *\"", workflow);
        Assert.Contains("workflow_dispatch:", workflow);
        Assert.Contains("LLMGW_PROD_GATE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_GATE_KEY", workflow);
        Assert.Contains("--run-serving-probe", workflow);
        Assert.Contains("--run-shadow-coverage", workflow);
        Assert.Contains("--require-release-gate", workflow);
        Assert.Contains("--min-coverage-hours \"$MIN_COVERAGE_HOURS\"", workflow);
        Assert.Contains("WATCH_APP_CALLERS", workflow);
        Assert.Contains("WATCH_COVERAGE_KINDS", workflow);
        Assert.Contains("WATCH_REQUIRED_KINDS", workflow);
        Assert.Contains("WATCH_REQUIRED_APP_KINDS", workflow);
        Assert.Contains("visual-agent.image-gen.generate::generation", workflow);
        Assert.Contains("visual-agent.image-gen.generate::generation:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.v2d.transcribe::asr", workflow);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.video-to-text::asr", workflow);
        Assert.Contains("video-agent.video-to-text::asr:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("actions/upload-artifact@v4", workflow);

        Assert.Contains("_redact_cmd", readiness);
        Assert.Contains("if item in {\"--key\", \"--gateway-key\"}", readiness);
        Assert.Contains("\"cmd\": _redact_cmd(cmd)", readiness);
        Assert.Contains("--min-coverage-hours", readiness);
        Assert.Contains("str(args.min_coverage_hours)", readiness);
        Assert.Contains("cmd.extend([\"--require-kind\", item])", readiness);
        Assert.Contains("cmd.extend([\"--require-app-kind\", item])", readiness);
        Assert.Contains("visual-agent.image-gen.generate::generation:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.video-to-text::asr:raw:${MIN_PER_CELL}", workflow);
    }

    [Fact]
    public void ShadowSampleWindow_RestoresSamplingAndDoesNotLeakGatewayKeyInArgv()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-sample-window.sh");

        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN:-1", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_RESTORE_PERCENT:-1", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_COMPOSE_TIMEOUT_SECONDS:-180", script);
        Assert.Contains("执行模式必须设置 LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS", script);
        Assert.Contains("up -d --force-recreate \"$api_service\"", script);
        Assert.Contains("trap restore_sampling EXIT INT TERM", script);
        Assert.Contains("trap - EXIT INT TERM", script);
        Assert.Contains("set_env_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT \"$restore_percent\"", script);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=\"$restore_percent\"", script);
        Assert.Contains("wait_api_ready \"$restore_percent\"", script);
        Assert.Contains("restore_failed=0", script);
        Assert.Contains("shadow sample restore failed", script);
        Assert.Contains("LLMGW_GATE_KEY=\"$gate_key\" python3", script);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=\"$sample_percent\"", script);
        Assert.Contains("redact_seed_flags", script);
        Assert.Contains("--asr-video-url", script);
        Assert.Contains("seedFlags: $(redact_seed_flags \"$seed_flags\")", script);
        Assert.DoesNotContain("--gw-key \"$gate_key\"", script);
        Assert.DoesNotContain("echo \"$gate_key\"", script);
    }

    [Fact]
    public void ShadowSampleAccumulator_RunsBatchedWindowsAndCoverageWithoutLeakingGatewayKeyInArgv()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-sample-accumulate.sh");

        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_DRY_RUN:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_PROFILE", script);
        Assert.Contains("canary-intent-text", script);
        Assert.Contains("--include-report-agent-generate", script);
        Assert.Contains("report-agent.generate::chat:send:30", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT", script);
        Assert.Contains("避免混用旧 commit shadow 样本", script);
        Assert.Contains("release_commit_trimmed=\"$(printf '%s' \"$release_commit\" | xargs || true)\"", script);
        Assert.Contains("seed_run_flags=\"$seed_flags\"", script);
        Assert.Contains("seed_run_flags=\"$seed_run_flags --release-commit $release_commit_trimmed\"", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_BATCHES:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES", script);
        Assert.Contains("max_batches=\"${LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES:-3}\"", script);
        Assert.Contains("超过本 profile 默认上限", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_PREFLIGHT_COVERAGE:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_ALLOW_AFTER_PASS:-0", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_ENFORCE_PLAN:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_ALLOW_WINDOW_EXTENSION:-0", script);
        Assert.Contains("--allow-window-extension", script);
        Assert.Contains("coverage already satisfies gate; skip seeding", script);
        Assert.Contains("preflight-shadow-coverage.json", script);
        Assert.Contains("llmgw-shadow-sample-plan.py", script);
        Assert.Contains("preflight-shadow-sample-plan.json", script);
        Assert.Contains("canRunRecommendedBatches", script);
        Assert.Contains("recommendedBatches", script);
        Assert.Contains("requested batches=$batches exceeds planner recommendation=$plan_recommended", script);
        Assert.Contains("refusing to over-sample", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS", script);
        Assert.Contains("执行模式必须设置 LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS", script);
        Assert.Contains("llmgw-shadow-sample-window.sh", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN=0", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS=\"$seed_run_flags\"", script);
        Assert.Contains("batch-$batch_id-shadow-sample-window.json", script);
        Assert.Contains("llmgw-shadow-coverage-report.py", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_RUN_COVERAGE:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MIN_PER_CELL:-30", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MIN_COVERAGE_HOURS:-24", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_REQUIRED_KINDS", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_REQUIRED_APP_KINDS", script);
        Assert.Contains("redact_seed_flags", script);
        Assert.Contains("seedFlags: $(redact_seed_flags \"$seed_flags\")", script);
        Assert.Contains("--require-kind $trimmed", script);
        Assert.Contains("--require-app-kind $trimmed", script);
        Assert.Contains("GW_KEY=\"$gate_key\" python3", script);
        Assert.DoesNotContain("--key \"$gate_key\"", script);
        Assert.DoesNotContain("--gw-key \"$gate_key\"", script);
        Assert.DoesNotContain("seedFlags: $seed_flags", script);
        Assert.DoesNotContain("echo \"$gate_key\"", script);
    }

    [Fact]
    public void ShadowSampleAccumulatorMonitor_FailsIfSamplingStaysHighWithoutWindow()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-accumulate-monitor.sh");

        Assert.Contains("LLM Gateway shadow accumulator monitor", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MONITOR_RUN_DIR", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MONITOR_SAFE_PERCENT:-1", script);
        Assert.Contains("LlmGateway__ShadowFullSamplePercent", script);
        Assert.Contains("LLMGW_SHADOW_FULL_SAMPLE_PERCENT", script);
        Assert.Contains("window_running=0", script);
        Assert.Contains("no sample window is running", script);
        Assert.Contains("batchFailedStepCount", script);
        Assert.DoesNotContain("GW_KEY", script);
        Assert.DoesNotContain("LLMGW_SERVE_KEY", script);
        Assert.DoesNotContain("--key", script);
    }

    [Fact]
    public void ProdPreflightWorkflow_RunsStartAndCompletionPreflightWithoutLeakingKeys()
    {
        var workflow = ReadRepoFile(".github/workflows/llmgw-prod-preflight.yml");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLM Gateway Production Preflight", workflow);
        Assert.Contains("workflow_dispatch:", workflow);
        Assert.Contains("mode:", workflow);
        Assert.Contains("- start", workflow);
        Assert.Contains("- completion", workflow);
        Assert.Contains("rollout_evidence_run_id", workflow);
        Assert.Contains("actions: read", workflow);
        Assert.Contains("PRD_AGENT_PROD_BASE", workflow);
        Assert.Contains("PRD_AGENT_PROD_API_KEY", workflow);
        Assert.Contains("LLMGW_PROD_GATE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_GATE_KEY", workflow);
        Assert.Contains("LLMGW_PROD_EXPECT_COMMIT", workflow);
        Assert.Contains("actions/download-artifact@v4", workflow);
        Assert.Contains("Restore rollout evidence for completion", workflow);
        Assert.Contains("llmgw-prod-stage-{0}", workflow);
        Assert.Contains(".llmgw-release-evidence/", workflow);
        Assert.Contains("default branch", ReadRepoFile("doc/plan.llm-gateway.full-cutover.md"));
        Assert.Contains("completion mode requires rollout_evidence_run_id", workflow);
        Assert.Contains("completion mode could not find .llmgw-release-evidence/rollout-ledger.jsonl after artifact restore", workflow);
        Assert.Contains("logs:read access", workflow);
        Assert.Contains("scripts/llmgw-prod-preflight.py", workflow);
        Assert.Contains("--mode \"$mode\"", workflow);
        Assert.Contains("--map-base \"$map_base\"", workflow);
        Assert.Contains("--gw-base \"$gw_base\"", workflow);
        Assert.Contains("--expect-commit \"$expect_commit\"", workflow);
        Assert.Contains("--rollout-target-stage \"$ROLLOUT_TARGET_STAGE\"", workflow);
        Assert.Contains("--rollout-min-observation-hours \"$ROLLOUT_MIN_OBSERVATION_HOURS\"", workflow);
        Assert.Contains("artifacts/llmgw-prod-preflight/prod-preflight.json", workflow);
        Assert.Contains("actions/upload-artifact@v4", workflow);
        Assert.DoesNotContain("echo \"$PRD_AGENT_API_KEY\"", workflow);
        Assert.DoesNotContain("echo \"$LLMGW_GATE_KEY\"", workflow);

        Assert.Contains("prod_preflight_workflow_uploads_redacted_start_completion_report", readiness);
        Assert.Contains("leaksPreflightSecret", readiness);
        Assert.Contains("Restore rollout evidence for completion", readiness);
        Assert.Contains("default branch", readiness);
    }

    [Fact]
    public void ProdExternalBackup_CanBypassComposeExtensionsWithMongoContainer()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-external-backup.sh");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLMGW_EXTERNAL_BACKUP_MONGO_CONTAINER", script);
        Assert.Contains("mongoContainer", script);
        Assert.Contains("remote_mongo_dump()", script);
        Assert.Contains("docker exec -i '$mongo_container' mongodump", script);
        Assert.Contains("docker compose -f '$compose_file' exec -T '$mongo_service' mongodump", script);
        Assert.Contains("write_remote_container_snapshot", script);
        Assert.Contains("docker ps --format", script);
        Assert.Contains("env.snapshot.redacted", script);
        Assert.Contains("gzip -t \"$backup_dir/$db.archive.gz\"", script);
        Assert.Contains("SHA256SUMS", script);
        Assert.DoesNotContain("rm -", script);
        Assert.DoesNotContain("dropDatabase", script);
        Assert.DoesNotContain("docker volume rm", script);

        Assert.Contains("LLMGW_EXTERNAL_BACKUP_MONGO_CONTAINER", readiness);
        Assert.Contains("docker exec -i '$mongo_container'", readiness);
        Assert.Contains("mongodump --db '$db'$collection_arg --archive", readiness);
    }

    [Fact]
    public void ProdVideoCallerBootstrap_BacksUpBeforeBindingVisualVideoCaller()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-video-caller-bootstrap.sh");
        var js = ReadRepoFile("scripts/llmgw-prod-video-caller-bootstrap.js");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLMGW_VIDEO_BOOTSTRAP_DRY_RUN:-1", script);
        Assert.Contains("LLM Gateway video caller bootstrap dry-run: backup skipped", script);
        Assert.Contains("llmgw-disk-space-guard.sh", script);
        Assert.Contains("mongodump --db \"$mongo_db\" --archive", script);
        Assert.Contains("mongo-$mongo_db-video-caller-bootstrap.archive.gz", script);
        Assert.Contains("LLMGW_VIDEO_BOOTSTRAP_SOURCE_CALLER", script);
        Assert.Contains("video-agent.videogen::video-gen", script);
        Assert.Contains("LLMGW_VIDEO_BOOTSTRAP_TARGET_CALLERS", script);
        Assert.Contains("visual-agent.videogen::video-gen", script);

        Assert.Contains("source video appCaller missing", js);
        Assert.Contains("source video appCaller has no video-gen ModelGroupIds", js);
        Assert.Contains("source video appCaller references missing video-gen pools", js);
        Assert.Contains("target video appCallers missing", js);
        Assert.Contains("ModelType: \"video-gen\"", js);
        Assert.Contains("ModelGroupIds: poolIds", js);
        Assert.Contains("LLM Gateway video caller bootstrap dry-run: no data changed", js);

        Assert.Contains("prod_video_caller_bootstrap_is_backed_up_and_dry_run_first", readiness);
    }

    [Fact]
    public void MapShadowSeed_CoversVisualVideoRawGate()
    {
        var script = ReadRepoFile("scripts/llmgw-map-shadow-seed.py");
        var plan = ReadRepoFile("doc/plan.llm-gateway.full-cutover.md");

        Assert.Contains("--include-desktop-chat-run", script);
        Assert.Contains("--include-open-platform", script);
        Assert.Contains("--include-open-api-chat", script);
        Assert.Contains("--include-open-api-image", script);
        Assert.Contains("--include-model-lab-run", script);
        Assert.Contains("--include-arena-run", script);
        Assert.Contains("--include-report-agent-generate", script);
        Assert.Contains("--skip-text-seeds", script);
        Assert.Contains("skipTextSeeds", script);
        Assert.Contains("--skip-text-seeds cannot be combined", script);
        Assert.Contains("--skip-text-seeds requires at least one image, vision, video, or ASR include flag", script);
        Assert.Contains("focused_non_text_seed_requested", script);
        Assert.Contains("llmgw-report-agent-shadow-seed.py", script);
        Assert.Contains("\"LLMGW_SHADOW_SAMPLE_KEY\": FORCE_SHADOW_SAMPLE_KEY", script);
        Assert.Contains("/api/v1/chat-runs/", script);
        Assert.Contains("/api/lab/model/runs/stream", script);
        Assert.Contains("/api/lab/arena/runs", script);
        Assert.Contains("resolve_chat_model_from_gateway", script);
        Assert.Contains("/pools", script);
        Assert.Contains("\"modelType\": \"chat\"", script);
        Assert.Contains("HealthStatus", script);
        Assert.Contains("looks_like_non_chat_model", script);
        Assert.Contains("seedance", script);
        Assert.Contains("seedream", script);
        Assert.Contains("prd-agent-desktop.chat.sendmessage::chat", plan);
        Assert.Contains("open-platform-agent.proxy::chat", plan);
        Assert.Contains("open-api.proxy::chat", plan);
        Assert.Contains("open-api.proxy::generation", plan);
        Assert.Contains("prd-agent-web.model-lab.run::chat", plan);
        Assert.Contains("prd-agent.arena.battle::chat", plan);
        Assert.Contains("--include-report-agent-generate", plan);
        Assert.Contains("report-agent.generate::chat/send", plan);
        Assert.Contains("--include-visual-video-direct", script);
        Assert.Contains("--include-video-to-doc-asr", script);
        Assert.Contains("--include-video-to-text-asr-workflow", script);
        Assert.Contains("--asr-video-url", script);
        Assert.Contains("/api/visual-agent/video-gen/runs", script);
        Assert.Contains("/api/video-agent/v2d/runs", script);
        Assert.Contains("/api/workflow-agent/workflows", script);
        Assert.Contains("video-to-text", script);
        Assert.Contains("wait_visual_video_run", script);
        Assert.Contains("visual-agent.videogen::video-gen:raw", plan);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw", plan);
        Assert.Contains("video-agent.video-to-text::asr:raw", plan);
        Assert.Contains("--include-visual-video-direct", plan);
        Assert.Contains("--include-video-to-doc-asr", plan);
        Assert.Contains("--include-video-to-text-asr-workflow", plan);
        Assert.Contains("No people, no faces, no logos, no letters, no readable text, no symbols.", script);
        Assert.Contains("Static test card with color blocks only, no text.", script);
        Assert.DoesNotContain("black text only", script);
        Assert.DoesNotContain("small black label", script);
        Assert.DoesNotContain("combined comparison card", script);
    }

    [Fact]
    public void ProdAsrCredentialRotate_UsesApiEncryptionAfterBackup()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-asr-credential-rotate.sh");
        var py = ReadRepoFile("scripts/llmgw-prod-asr-credential-rotate.py");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLMGW_ASR_CREDENTIAL_ROTATE_DRY_RUN:-1", script);
        Assert.Contains("LLMGW_ASR_NEW_KEY", script);
        Assert.Contains("LLM Gateway ASR credential rotate dry-run: backup skipped", script);
        Assert.Contains("llmgw-disk-space-guard.sh", script);
        Assert.Contains("mongodump --db \"$mongo_db\" --collection model_exchanges --archive", script);
        Assert.Contains("ROOT_ACCESS_USERNAME", script);
        Assert.Contains("ROOT_ACCESS_PASSWORD", script);
        Assert.Contains("llmgw-prod-asr-credential-rotate.py", script);

        Assert.Contains("never prints the new key", py);
        Assert.Contains("/api/mds/exchanges", py);
        Assert.Contains("\"targetApiKey\": new_key", py);
        Assert.Contains("DoubaoAsr", py);
        Assert.Contains("XApiKey", py);
        Assert.Contains("newKeyShape", py);
        Assert.DoesNotContain("TargetApiKeyEncrypted", py);

        Assert.Contains("asr_credential_rotate_is_backup_first_and_api_encrypted", readiness);
    }

    [Fact]
    public void GwSmoke_CoversStreamingAndClientStreamBoundaries()
    {
        var script = ReadRepoFile("scripts/gw-smoke.py");

        Assert.Contains("\"/invoke\"", script);
        Assert.Contains("invoke[{mtype}]", script);
        Assert.Contains("\"/send\"", script);
        Assert.Contains("send-compat[chat]", script);
        Assert.Contains("_sse_req", script);
        Assert.Contains("\"/stream\"", script);
        Assert.Contains("stream[chat]", script);
        Assert.Contains("\"/client-stream\"", script);
        Assert.Contains("client-stream[chat]", script);
        Assert.Contains("GW_SMOKE_PROMPT", script);
        Assert.Contains("GW_SMOKE_MAX_TOKENS", script);
        Assert.Contains("GW_SMOKE_REQUEST_TIMEOUT_SECONDS", script);
        Assert.Contains("\"Messages\": [{\"Role\": \"user\", \"Content\": SMOKE_PROMPT}]", script);
        Assert.Contains("GW_SMOKE_JSON_OUT", script);
        Assert.Contains("GW_SMOKE_REPORT_MD", script);
        Assert.Contains("\"verdict\": \"pass\" if passed == len(rows) else \"fail\"", script);
    }

    [Fact]
    public void ShadowRawEvidence_UsesExplicitFullSampleAllowlistAndRollbackClearsIt()
    {
        var apiProgram = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var shadowGateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ShadowLlmGateway.cs");
        var prodStage = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var rollback = ReadRepoFile("scripts/llmgw-rollback-inproc.sh");
        var restore = ReadRepoFile("scripts/llmgw-restore-shadow-safe.sh");

        Assert.Contains("LlmGateway:ShadowFullSampleAppCallerAllowlist", apiProgram);
        Assert.Contains("fullSampleAllowlist: shadowFullSampleAllowlist", apiProgram);
        Assert.Contains("_fullSampleAllowlist.Contains(appCallerCode)", shadowGateway);
        Assert.Contains("LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST", prodStage);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=\"$shadow_full_sample_allowlist\"", prodStage);
        Assert.Contains("llmgw_shadow_sample_allowlist_value()", ReadRepoFile("exec_dep.sh"));
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=", rollback);
        Assert.Contains("\"LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST\": \"\"", restore);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=", restore);
        Assert.Contains("preserve_release_image_vars", restore);
        Assert.Contains("preserve_image_var PRD_AGENT_API_IMAGE prdagent-api", restore);
        Assert.Contains("RESTORE_PRD_AGENT_API_IMAGE", restore);
        Assert.Contains("\"PRD_AGENT_API_IMAGE\": os.environ.get(\"RESTORE_PRD_AGENT_API_IMAGE\", \"\")", restore);
    }

    [Fact]
    public void ModelResolver_FailClosesRawDedicatedPoolsBeforeLegacyFallback()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");

        Assert.Contains("ShouldFailClosedWhenDedicatedPoolUnavailable", resolver);
        Assert.Contains("ModelTypes.VideoGen", resolver);
        Assert.Contains("ModelTypes.Asr", resolver);
        Assert.Contains("跳过 expectedModel 的 LLMModels 直连兜底", resolver);
        Assert.Contains("拒绝降级 legacy 直连", resolver);
    }

    [Fact]
    public void ModelResolver_AvailablePoolsFailClosedBeforeMapFallbackForExternalTenants()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var methodStart = resolver.IndexOf("public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync", StringComparison.Ordinal);
        var mapFallback = resolver.IndexOf("var appCaller = await _db.LLMAppCallers", methodStart, StringComparison.Ordinal);
        var externalTenantGuard = resolver.IndexOf(
            "if (!string.Equals(CurrentTenantId, _internalTenantId, StringComparison.Ordinal))",
            methodStart,
            StringComparison.Ordinal);

        Assert.True(methodStart >= 0 && mapFallback > methodStart, "找不到 available-pools MAP fallback");
        Assert.True(
            externalTenantGuard > methodStart && externalTenantGuard < mapFallback,
            "外部租户必须在读取 MAP LLMAppCallers/ModelGroups 前 fail closed");
    }

    [Fact]
    public void ImageGenRunWorker_DoesNotSilentlyDowngradeReferenceImageRunsToText2Img()
    {
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");

        Assert.Contains("expectedReferenceCount", worker);
        Assert.Contains("IMAGE_REF_UNAVAILABLE", worker);
        Assert.Contains("参考图加载不完整", worker);
        Assert.Contains("loadedImageRefs.Count < expectedReferenceCount", worker);
        Assert.Contains("Builders<ImageGenRun>.Update.Set(x => x.AppCallerCode, appCallerCode)", worker);
        Assert.Contains("AppCallerRegistry.VisualAgent.Image.Img2Img", worker);
        Assert.Contains("AppCallerRegistry.VisualAgent.Image.VisionGen", worker);
    }

    [Fact]
    public void ShadowForceSample_IsKeyCheckedAndDoesNotRequireApiRestart()
    {
        var apiProgram = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var context = ReadRepoFile("prd-api/src/PrdAgent.Core/Interfaces/ILLMRequestContextAccessor.cs");
        var accessor = ReadRepoFile("prd-api/src/PrdAgent.Core/Services/LLMRequestContextAccessor.cs");
        var shadowGateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ShadowLlmGateway.cs");
        var seed = ReadRepoFile("scripts/llmgw-map-shadow-seed.py");
        var reportSeed = ReadRepoFile("scripts/llmgw-report-agent-shadow-seed.py");
        var accumulator = ReadRepoFile("scripts/llmgw-shadow-sample-accumulate.sh");

        Assert.Contains("X-Llmgw-Shadow-Sample-Key", apiProgram);
        Assert.Contains("FixedTimeEqualsNonEmpty", apiProgram);
        Assert.Contains("ForceFullShadowSample: true", apiProgram);
        Assert.Contains("bool ForceFullShadowSample = false", context);
        Assert.Contains("prev?.ForceFullShadowSample == true", accessor);
        Assert.Contains("_ctx?.Current?.ForceFullShadowSample == true", shadowGateway);
        Assert.Contains("--force-shadow-sample", seed);
        Assert.Contains("X-Llmgw-Shadow-Sample-Key", seed);
        Assert.Contains("\"LLMGW_SHADOW_SAMPLE_KEY\": FORCE_SHADOW_SAMPLE_KEY", seed);
        Assert.DoesNotContain("cmd.extend([\"--shadow-sample-key\"", seed);
        Assert.Contains("SHADOW_SAMPLE_KEY = args.shadow_sample_key.strip()", reportSeed);
        Assert.Contains("headers[\"X-Llmgw-Shadow-Sample-Key\"] = SHADOW_SAMPLE_KEY", reportSeed);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_FORCE_SAMPLE", accumulator);
        Assert.Contains("--force-shadow-sample", accumulator);
        Assert.Contains("python3 \"$seed_script\"", accumulator);
        Assert.Contains("\"$window_script\"", accumulator);
    }

    [Fact]
    public void ShadowSamplePlan_IsReadOnlyAndCapsRecommendedBatches()
    {
        var planner = ReadRepoFile("scripts/llmgw-shadow-sample-plan.py");

        Assert.Contains("Plan bounded LLM Gateway shadow sample top-up batches", planner);
        Assert.Contains("This script is read-only", planner);
        Assert.Contains("--coverage-json", planner);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_PLAN_MAX_BATCHES", planner);
        Assert.Contains("recommendedBatches", planner);
        Assert.Contains("canRunRecommendedBatches", planner);
        Assert.Contains("bounded-top-up", planner);
        Assert.Contains("coverage-read-failure", planner);
        Assert.Contains("coverageReadReady", planner);
        Assert.Contains("_coverage_failure_reason", planner);
        Assert.Contains("_is_benign_coverage_failure", planner);
        Assert.Contains("coverageFailures", planner);
        Assert.Contains("coverage.get(\"failures\")", planner);
        Assert.Contains("already-ready", planner);
        Assert.Contains("wait-coverage-window", planner);
        Assert.Contains("window-extension-top-up", planner);
        Assert.Contains("--allow-window-extension", planner);
        Assert.Contains("_can_extend_window", planner);
        Assert.DoesNotContain("urllib.request", planner);
        Assert.DoesNotContain("subprocess.run", planner);
        Assert.DoesNotContain("requests.", planner);
    }

    [Fact]
    public void RolloutStatus_CanFailAsReleaseGateWithoutCallingProviders()
    {
        var status = ReadRepoFile("scripts/llmgw-rollout-status.py");

        Assert.Contains("Read-only LLM Gateway rollout status board", status);
        Assert.Contains("It never calls MAP seed endpoints and never calls model providers.", status);
        Assert.Contains("--require-ready", status);
        Assert.Contains("--require-action", status);
        Assert.Contains("_required_action_failure", status);
        Assert.Contains("LLM Gateway rollout status: NOT READY", status);
        Assert.Contains("require_release_ready", status);
        Assert.Contains("releaseStatus=", status);
        Assert.Contains("healthOk=", status);
        Assert.Contains("nextEligibleAt=", status);
        Assert.Contains("ready-for-release-gate", status);
    }

    [Fact]
    public void ConsoleLogsSummary_ExposesProtocolRouterDistributions()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var consoleTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");

        foreach (var field in new[] { "SourceSystem", "IngressProtocol", "ModelPolicy" })
        {
            Assert.Contains($".Include(\"{field}\")", consoleProgram);
            Assert.Contains($"BuildBucket(docs, \"{field}\", fallbackKey: \"unknown\")", consoleProgram);
        }

        Assert.Contains("public List<LogsBucketItem> SourceSystemDistribution", consoleDtos);
        Assert.Contains("public List<LogsBucketItem> IngressProtocolDistribution", consoleDtos);
        Assert.Contains("public List<LogsBucketItem> ModelPolicyDistribution", consoleDtos);
        Assert.Contains("sourceSystemDistribution: LogsBucketItem[]", consoleTypes);
        Assert.Contains("ingressProtocolDistribution: LogsBucketItem[]", consoleTypes);
        Assert.Contains("modelPolicyDistribution: LogsBucketItem[]", consoleTypes);
        Assert.Contains("<DistributionStrip label=\"入口协议\"", logsView);
        Assert.Contains("items={summary?.ingressProtocolDistribution}", logsView);
        Assert.Contains("onSelect={setFilterIngressProtocol}", logsView);
        Assert.Contains("<DistributionStrip label=\"路由策略\"", logsView);
        Assert.Contains("items={summary?.modelPolicyDistribution}", logsView);
        Assert.Contains("onSelect={setFilterModelPolicy}", logsView);
        Assert.Contains("<DistributionStrip label=\"来源系统\"", logsView);
        Assert.Contains("items={summary?.sourceSystemDistribution}", logsView);
        Assert.Contains("onSelect={setFilterSourceSystem}", logsView);
    }

    [Fact]
    public void ExternalConsole_CostSummaryPreservesUnknownAndCurrencyBoundaries()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var consoleTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");

        Assert.Contains(".Include(\"EstimatedCost\")", consoleProgram);
        Assert.Contains(".Include(\"EstimatedCostCurrency\")", consoleProgram);
        Assert.Contains(".Include(\"InputPricePerMillion\")", consoleProgram);
        Assert.Contains(".Include(\"OutputPricePerMillion\")", consoleProgram);
        Assert.Contains("x.Amount is not null && x.Currency is not null && x.Complete", consoleProgram);
        Assert.Contains("GroupBy(x => x.Currency!", consoleProgram);
        Assert.Contains("UnknownCostRequests = docs.Count - pricedDocs.Count", consoleProgram);
        Assert.Contains("EstimatedCostUsd = usdDocs.Count == 0 ? null", consoleProgram);
        Assert.DoesNotContain("EstimatedCostUsd = docs.Sum", consoleProgram);
        Assert.Contains("public decimal? EstimatedCostUsd", consoleDtos);
        Assert.Contains("public List<EstimatedCostBucket> EstimatedCosts", consoleDtos);
        Assert.Contains("estimatedCostUsd?: number | null", consoleTypes);
        Assert.Contains("unknownCostRequests: number", consoleTypes);
        Assert.Contains("priceCoveragePercent: number", consoleTypes);
        Assert.Contains("按价格快照原币种分组，不做无汇率换算", logsView);
    }

    [Fact]
    public void ExternalConsole_UsesSidebarAndKeepsOperationsOffHomePage()
    {
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");
        var home = ReadRepoFile("llmgw/web/src/pages/HomePage.tsx");
        var governance = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");

        foreach (var group in new[] { "工作区", "路由", "开发者", "组织", "治理", "设置" })
            Assert.Contains($"label: '{group}'", layout);
        Assert.Contains("<aside className={`lg-console-sidebar", layout);
        Assert.Contains("className=\"lg-tenant-switcher\"", layout);
        Assert.Contains("按 requestId 定位请求", layout);
        Assert.Contains("健康状态", home);
        Assert.Contains("Quickstart", home);
        Assert.Contains("最近请求", home);
        Assert.Contains("费用可信度", home);
        Assert.DoesNotContain("RuntimeGatePanel", home);
        Assert.DoesNotContain("TOPOLOGY", home);
        Assert.Contains("RuntimeGatePanel", governance);
        Assert.Contains("TOPOLOGY", governance);
    }

    [Fact]
    public void TenantSwitcher_ResolvesMembershipsFromServerUserAndTenantIds()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var endpointStart = consoleProgram.IndexOf("app.MapGet(\"/gw/auth/tenants\"", StringComparison.Ordinal);
        var endpointEnd = consoleProgram.IndexOf("app.MapPost(\"/gw/auth/switch-tenant\"", endpointStart, StringComparison.Ordinal);
        Assert.True(endpointStart >= 0 && endpointEnd > endpointStart);
        var endpoint = consoleProgram[endpointStart..endpointEnd];

        Assert.Contains("access.UserId", endpoint);
        Assert.Contains("Filter.In(x => x.TenantId, authorizedTenantIds)", endpoint);
        Assert.Contains("Filter.Eq(x => x.UserId, access.UserId)", endpoint);
        Assert.DoesNotContain("[FromBody]", endpoint);
        Assert.DoesNotContain("body.", endpoint);
    }

    [Fact]
    public void Console_InternalOperationsVisibility_ComesFromServerTenantContext()
    {
        var tenantModel = ReadRepoFile("llmgw/console-api/Models/LlmGwTenantModels.cs");
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");

        Assert.Contains("public bool IsInternal { get; set; }", tenantModel);
        Assert.Contains("bool IsInternalTenant", access);
        Assert.Contains("tenant.IsInternal", access);
        Assert.Contains("IsInternal = access.IsInternalTenant", consoleProgram);
        Assert.Contains("IsInternal = tenant.IsInternal", consoleProgram);
        Assert.Contains("function RequireInternalTenant", app);
        Assert.Contains("tenant?.isInternal ?", app);
        Assert.Contains("internalOnly: true", layout);
        Assert.DoesNotContain("TenantId", app);
    }

    [Fact]
    public void Console_Productization_UsesRealOriginSafeTestAndGuidedEmptyStates()
    {
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");
        var serviceKeys = ReadRepoFile("llmgw/web/src/pages/ServiceKeysPage.tsx");
        var logs = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        var theme = ReadRepoFile("llmgw/web/src/lib/theme.ts");
        var servingProgram = ReadRepoFile("llmgw/serving/Program.cs");

        Assert.Contains("return new URL(window.location.href).origin", quickstart);
        Assert.Contains("createGatewayAppCaller", quickstart);
        Assert.Contains("createServiceKey", quickstart);
        Assert.Contains("X-Gateway-Dry-Run", quickstart);
        Assert.Contains("protocolDefinition(bundle.protocol).path", quickstart);
        Assert.Contains("upstreamCalled === false", quickstart);
        Assert.Contains("/logs?requestId=", quickstart);
        Assert.Contains("Agent Skill", quickstart);
        Assert.Contains("credentials: 'omit'", quickstart);
        Assert.DoesNotContain("gateway.example.com", quickstart);
        Assert.DoesNotContain("localStorage", quickstart);
        Assert.DoesNotContain("sessionStorage", quickstart);
        Assert.Contains("invoke, route:read", serviceKeys);
        Assert.Contains("gw-native, openai-compatible, claude-compatible, gemini-compatible", serviceKeys);
        Assert.Contains("平台内部服务使用部署级内部身份", serviceKeys);
        Assert.Contains("创建第一把密钥", serviceKeys);
        Assert.Contains("去快速接入", logs);
        Assert.Contains("查看示例说明", logs);
        Assert.Contains("跟随系统", ReadRepoFile("llmgw/web/src/pages/SettingsPage.tsx"));
        Assert.Contains("prefers-color-scheme: light", theme);
        Assert.Contains("WithMethods(HttpMethods.Get, HttpMethods.Post)", servingProgram);
        Assert.Contains("\"X-Gateway-Dry-Run\"", servingProgram);
        Assert.Contains("WithExposedHeaders(\"X-Request-Id\", \"X-Gateway-Upstream-Called\")", servingProgram);
        Assert.Contains("app.UseCors(BrowserDryRunCors)", servingProgram);
    }

    [Fact]
    public void AgentFirstQuickstart_KeepsTenantAuthorityAndUnknownCostBoundaries()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");
        var webNginx = ReadRepoFile("llmgw/web/nginx.conf");
        var devCompose = ReadRepoFile("docker-compose.dev.yml");

        var createStart = console.IndexOf("app.MapPost(\"/gw/app-callers\"", StringComparison.Ordinal);
        var createEnd = console.IndexOf("RequireAuthorization(\"AppCallerWrite\")", createStart, StringComparison.Ordinal);
        Assert.True(createStart >= 0 && createEnd > createStart);
        var createEndpoint = console[createStart..createEnd];
        Assert.Contains("TenantAccess.GetRequired(http)", createEndpoint);
        Assert.Contains("TenantAccess.Filter(http, identity)", createEndpoint);
        Assert.Contains("x.TenantId == access.TenantId", createEndpoint);
        Assert.DoesNotContain("body.TenantId", createEndpoint);
        Assert.Contains("uniq_llmgw_app_callers_tenant_code_request_type", console);
        Assert.Contains("APP_CALLER_AUDIT_FAILED", createEndpoint);
        Assert.Contains("gwAppCallers.DeleteOneAsync(TenantAccess.Filter(http", createEndpoint);
        Assert.Contains("AppCallerWrite", access);

        Assert.Contains("TryHandleQuickstartDryRunAsync", endpoints);
        Assert.Contains("authorization.TenantId", endpoints);
        Assert.Contains("authorization.TeamId", endpoints);
        Assert.Contains("authorization.KeyId", endpoints);
        Assert.Contains("authorization.ClientCode", endpoints);
        Assert.Contains("authorization.Environment", endpoints);
        Assert.Contains("\"gateway-dry-run\"", endpoints);
        Assert.Contains("\"quickstart-dry-run-no-upstream\"", endpoints);
        var dryRunStart = endpoints.IndexOf("private static async Task<bool> TryHandleQuickstartDryRunAsync", StringComparison.Ordinal);
        var dryRunEnd = endpoints.IndexOf("private static bool IsQuickstartDryRunPath", dryRunStart, StringComparison.Ordinal);
        var dryRunEndpoint = endpoints[dryRunStart..dryRunEnd];
        Assert.DoesNotContain("EstimatedCost", dryRunEndpoint);
        var logWriteIndex = dryRunEndpoint.IndexOf("llmrequestlogs", StringComparison.Ordinal);
        var observationUpdateIndex = dryRunEndpoint.IndexOf(".Inc(x => x.TotalSeen, 1)", StringComparison.Ordinal);
        Assert.True(logWriteIndex >= 0 && observationUpdateIndex > logWriteIndex);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(console, "TeamId = d.AsNullableString\\(\\\"TeamId\\\"\\)").Count >= 4);

        Assert.Contains("scopes: ['invoke']", quickstart);
        Assert.Contains("ingressProtocols: [selectedProtocol.ingressProtocol]", quickstart);
        Assert.DoesNotContain("tenantId:", quickstart);
        Assert.DoesNotContain("['*']", quickstart);
        Assert.Contains("location ^~ /gw/v1/", webNginx);
        Assert.Contains("location ^~ /v1/", webNginx);
        Assert.Contains("location ^~ /v1beta/", webNginx);
        Assert.Contains("location ^~ /gemini/v1beta/", webNginx);
        Assert.Contains("client_max_body_size 30m;", webNginx);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(webNginx, "proxy_pass http://\\$llmgw_serving_upstream:8091;").Count == 4);
        Assert.Contains("llmgw-serve:", devCompose);
        Assert.Contains("dockerfile: llmgw/serving/Dockerfile", devCompose);
        Assert.Contains("- llmgw-serve", devCompose);
    }

    [Fact]
    public void ExternalTenant_CannotMasqueradeAsMapServiceKeyPurpose()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/ServiceKeysPage.tsx");
        var createStart = console.IndexOf("app.MapPost(\"/gw/service-keys\"", StringComparison.Ordinal);
        var deleteStart = console.IndexOf("app.MapDelete(\"/gw/service-keys/{id}\"", createStart, StringComparison.Ordinal);
        var createEndpoint = console[createStart..deleteStart];

        Assert.Contains("if (sourceSystem == \"*\")", createEndpoint);
        Assert.Contains("INVALID_KEY_SOURCE", createEndpoint);
        Assert.Contains("!tenant.IsInternalTenant && (isMapSource || purpose != \"external-platform\")", createEndpoint);
        Assert.Contains("INTERNAL_KEY_PURPOSE_FORBIDDEN", createEndpoint);
        Assert.Contains("const isInternalTenant = tenant?.isInternal === true", page);
        Assert.Contains("外部租户身份由服务端固定，不能伪装为 MAP", page);
        Assert.Contains("isInternalTenant ? <div", page);
    }

    [Fact]
    public void ConsoleOnlyStartup_BackfillsLegacyGatewayDocumentsBeforeTenantFiltering()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var backfillCall = console.IndexOf(
            "await BackfillInternalTenantAsync(gatewayDatabase, internalTenantId, CancellationToken.None);",
            StringComparison.Ordinal);
        var firstTenantFilteredEndpoint = console.IndexOf(
            "lifecycleRuns.Find(TenantAccess.Filter(http))",
            StringComparison.Ordinal);

        Assert.True(backfillCall >= 0, "console-only 启动必须执行 internal tenant 历史回填");
        Assert.True(
            firstTenantFilteredEndpoint > backfillCall,
            "TenantAccess.Filter 生效前必须完成历史 TenantId 回填");
        foreach (var collection in new[]
                 {
                     "llmrequestlogs",
                     "llmshadow_comparisons",
                     "llmgw_operation_audits",
                     "llmgw_login_audits",
                     "llmgw_lifecycle_runs",
                     "llmgw_app_callers",
                     "llmgw_model_pools",
                     "llmgw_platforms",
                     "llmgw_models",
                     "llmgw_model_exchanges",
                     "llmgw_service_keys",
                 })
        {
            Assert.Contains($"\"{collection}\"", console);
        }
        Assert.Contains("Filter.Exists(\"TenantId\", false)", console);
        Assert.Contains("Filter.Eq(\"TenantId\", BsonNull.Value)", console);
        Assert.Contains("Update.Set(\"TenantId\", tenantId)", console);
    }

    [Fact]
    public void ConsoleDefaultPoolSwitch_UsesTenantScopedAtomicPointer()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var endpointStart = console.IndexOf(
            "app.MapPut(\"/gw/pools/{id}/default\"",
            StringComparison.Ordinal);
        var endpointEnd = console.IndexOf(
            "app.MapPut(\"/gw/pools/{id}/claim\"",
            endpointStart,
            StringComparison.Ordinal);
        Assert.True(endpointStart >= 0, "找不到默认模型池切换端点");
        Assert.True(endpointEnd > endpointStart, "默认模型池切换端点边界无效");
        var endpoint = console[endpointStart..endpointEnd];

        Assert.Contains("fb.Eq(\"TenantId\", tenantId), fb.Eq(\"Code\", modelType)", endpoint);
        Assert.Contains("FindOneAndUpdateAsync", endpoint);
        Assert.Contains(".Set(\"DefaultPoolId\", id)", endpoint);
        Assert.Contains("PoolVersionGuard", endpoint);
        Assert.Contains("DefaultSwitchPendingUntil", endpoint);
        Assert.DoesNotContain("targetPools.UpdateManyAsync", endpoint);
    }

    [Fact]
    public void ModelLabAndArena_PinSelectedModelThroughGateway()
    {
        var modelLab = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ModelLabController.cs");
        var arenaWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ArenaRunWorker.cs");

        Assert.Contains("_gateway.CreateClient(", modelLab);
        Assert.Contains("Admin.ModelLab.Run", modelLab);
        Assert.Contains("expectedModel: modelName", modelLab);
        Assert.Contains("pinnedPlatformId: platform.Id", modelLab);
        Assert.Contains("pinnedModelId: modelName", modelLab);
        Assert.Contains("expectedModel: model.ModelName", modelLab);
        Assert.Contains("pinnedPlatformId: resolvedPlatformId", modelLab);
        Assert.Contains("pinnedModelId: model.ModelName", modelLab);
        Assert.Contains("ModelResolutionType: ModelResolutionType.DirectModel", modelLab);

        Assert.Contains("gateway.CreateClient(", arenaWorker);
        Assert.Contains("AppCallerRegistry.Desktop.Arena.BattleChat", arenaWorker);
        Assert.Contains("expectedModel: slot.ModelId", arenaWorker);
        Assert.Contains("pinnedPlatformId: platform.Id", arenaWorker);
        Assert.Contains("pinnedModelId: slot.ModelId", arenaWorker);
        Assert.Contains("ModelResolutionType: ModelResolutionType.DirectModel", arenaWorker);
    }

    [Fact]
    public void GatewayProductionHardening_HasExecutableLifecycleBudgetKeyCancelAndIdempotencyGuards()
    {
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var runtime = ReadRepoFile("llmgw/serving/GatewayRuntimeGovernance.cs");
        var concurrency = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayProviderConcurrencyCoordinator.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var httpClient = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/HttpLlmGatewayClient.cs");
        var stage = ReadRepoFile("scripts/llmgw-prod-stage.sh");

        Assert.Contains("idx_llmgw_logs_tenant_time_caller_type_transport", initializer);
        Assert.Contains("ttl_llmgw_logs_started", initializer);
        Assert.Contains("uniq_llmgw_budget_month", initializer);
        Assert.Contains("uniq_llmgw_execution_request", initializer);
        Assert.Contains("uniq_llmgw_service_key_hash", initializer);
        Assert.Contains("uniq_llmgw_multipart_ref", initializer);
        Assert.Contains("uniq_llmgw_provider_concurrency_slot", initializer);
        Assert.Contains("ttl_llmgw_provider_concurrency_slot", initializer);
        Assert.Contains("LlmGateway:Retention:EnableTtlIndexes", initializer);
        Assert.Contains("EnsureBudgetConfigurationIntegrityAsync", initializer);
        Assert.Contains("APP_CALLER_BUDGET_MIGRATION_REQUIRED", initializer);

        Assert.Contains("class GatewayBudgetCoordinator", runtime);
        Assert.Contains("FindOneAndUpdateAsync", runtime);
        Assert.Contains("class GatewayRequestExecutionStore", runtime);
        Assert.Contains("GatewayExecutionBeginState.Unknown", runtime);
        Assert.Contains("class GatewayScopedKeyAuthorizer", runtime);
        Assert.Contains("GATEWAY_KEY_SCOPE_DENIED", runtime);
        Assert.Contains("class GatewayCancellationRegistry", runtime);
        Assert.Contains("class GatewayDataLifecycleWorker", runtime);
        Assert.Contains("GatewayLifecycleRunRecord", runtime);
        Assert.Contains("Status = \"dry-run-complete\"", runtime);
        Assert.Contains("EnsureRetentionTtlIndexesAsync", runtime);
        Assert.True(
            runtime.IndexOf("await lifecycle.InsertOneAsync(run", StringComparison.Ordinal)
            < runtime.IndexOf("EnsureRetentionTtlIndexesAsync", runtime.IndexOf("await lifecycle.InsertOneAsync(run", StringComparison.Ordinal), StringComparison.Ordinal),
            "必须先持久化 dry-run，再创建会触发删除的 TTL 索引");
        Assert.Contains("ttl_llmgw_login_audits", initializer);
        Assert.Contains("LlmGateway:Retention:AuditDays", initializer);
        Assert.Contains("TimeSpan.FromDays(auditDays)", initializer);
        Assert.True(
            runtime.IndexOf("await _budgets.ReleaseExpiredAsync(ct);", StringComparison.Ordinal)
            < runtime.IndexOf("if (apply)", runtime.IndexOf("var multipart", StringComparison.Ordinal), StringComparison.Ordinal),
            "预算过期结算必须独立于 retention apply 开关");

        Assert.Contains("class GatewayProviderConcurrencyCoordinator", concurrency);
        Assert.Contains("PROVIDER_CONCURRENCY_EXHAUSTED", concurrency);
        Assert.Contains("FindOneAndUpdateAsync", concurrency);
        Assert.Contains("MongoCommandException ex) when (ex.Code is 11000 or 11001)", concurrency);
        Assert.Contains("AcquireProviderConcurrencyAsync", gateway);
        Assert.Contains("GatewayProviderConcurrencyCoordinator? concurrencyCoordinator = null", gateway);

        Assert.Contains("/gw/v1/requests/{requestId}/cancel", endpoints);
        Assert.Contains("RunWithRequestCancellationAsync", endpoints);
        Assert.Contains("ExecuteRawWithIdempotencyAsync", endpoints);
        Assert.Contains("GATEWAY_OUTCOME_UNKNOWN", endpoints);
        var nativeStreamStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/stream\"", StringComparison.Ordinal);
        var nativeStreamEnd = endpoints.IndexOf("app.MapPost(\"/gw/v1/raw\"", nativeStreamStart, StringComparison.Ordinal);
        Assert.Contains(
            "HttpContextOutcomeUnknownKey",
            endpoints[nativeStreamStart..nativeStreamEnd]);
        var clientStreamStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/client-stream\"", StringComparison.Ordinal);
        var clientStreamEnd = endpoints.IndexOf("app.MapGet(\"/gw/v1/shadow-comparisons\"", clientStreamStart, StringComparison.Ordinal);
        Assert.Contains(
            "HttpContextOutcomeUnknownKey",
            endpoints[clientStreamStart..clientStreamEnd]);
        var imageHelperStart = endpoints.IndexOf("private static async Task ExecuteRawWithIdempotencyAsync", StringComparison.Ordinal);
        var imageHelperEnd = endpoints.IndexOf("private static async Task SendOpenAiCompatibleAsync", imageHelperStart, StringComparison.Ordinal);
        var imageHelper = endpoints[imageHelperStart..imageHelperEnd];
        Assert.True(
            imageHelper.IndexOf("store.BeginAsync", StringComparison.Ordinal)
            < imageHelper.IndexOf("RecordAndCheckAppCallerGovernanceAsync", StringComparison.Ordinal),
            "图片兼容入口的幂等 replay 必须在预算预占与限流前返回");
        var rawEndpointStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/raw\"", StringComparison.Ordinal);
        var rawEndpointEnd = endpoints.IndexOf("app.MapPost(\"/gw/v1/profile-test\"", rawEndpointStart, StringComparison.Ordinal);
        var rawEndpoint = endpoints[rawEndpointStart..rawEndpointEnd];
        Assert.True(
            rawEndpoint.IndexOf("executionStore.BeginAsync", StringComparison.Ordinal)
            < rawEndpoint.IndexOf("RecordAndCheckAppCallerGovernanceAsync", StringComparison.Ordinal),
            "raw 幂等 replay 必须在预算预占与限流前返回");
        Assert.Contains("path.Equals(\"/gw/v1/profile-test\"", endpoints);
        Assert.Contains("return \"profile:test\"", endpoints);
        Assert.Contains("NormalizeGatewayStatusCode(value.Success, value.StatusCode)", endpoints);
        Assert.Contains("ResolveScopedAuthorizationInputsAsync", endpoints);
        Assert.Contains("ShouldInspectAuthorizationBody", endpoints);
        Assert.Contains("GATEWAY_APP_CALLER_MISMATCH", endpoints);
        Assert.Contains("ReadJsonBool(root, \"stream\")", endpoints);
        Assert.Contains("path.Equals(\"/gw/v1/client-stream\"", endpoints);
        Assert.Contains("path.Contains(\":streamGenerateContent\"", endpoints);
        Assert.DoesNotContain("Request.ContentType?.Contains(\"json\"", endpoints);
        Assert.Contains("CleanupMultipartRefsAsync", endpoints);
        Assert.Contains("protectedGatewayPath", endpoints);
        Assert.DoesNotContain("!path.StartsWith(\"/gw/v1/readyz\"", endpoints);
        Assert.Contains("llmgw_multipart_objects", httpClient);
        Assert.Contains("X-Gateway-App-Caller", httpClient);
        Assert.Contains("TryDeserializeRawResponse", httpClient);
        Assert.Contains("TryDeserializeGatewayResponse", httpClient);
        Assert.Contains("ResolveCompatibleDefaultAppCaller", endpoints);

        Assert.Contains("ensure_serving_probe_evidence", stage);
        Assert.Contains("collecting missing serving probe evidence without upstream model calls", stage);
        Assert.Contains("LLMGW_GATE_KEY=\"$gate_key\" python3 scripts/llmgw-serving-probe.py", stage);

        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("ValidateBudgetConfiguration", console);
        Assert.Contains("配置月预算时必须同时配置大于 0 的单次预算预占", console);
        Assert.Contains("单次预算预占不能超过月预算", console);
    }

    [Fact]
    public void GatewayFinalAcceptance_IsOneShotBoundedAndStopsOnFailure()
    {
        var script = ReadRepoFile("scripts/llmgw-final-acceptance.py");
        var seed = ReadRepoFile("scripts/llmgw-map-shadow-seed.py");
        var compose = ReadRepoFile("docker-compose.yml");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("CELLS = (\"text\", \"stream\", \"image\", \"vision\", \"asr\", \"video\")", script);
        Assert.Contains("automatic full rerun is forbidden", script);
        Assert.Contains("serving commit mismatch", script);
        Assert.Contains("lifecycle apply/index gate is not ready", script);
        Assert.Contains("no later cells executed", script);
        Assert.Contains("\"maxUpstreamCalls\": 1", script);
        Assert.Contains("\"maxSubmitCalls\": 1", script);
        Assert.Contains("CELLS.index(args.resume_cell)", script);
        Assert.Contains("--max-canary-calls\", \"1", script);
        Assert.Contains("--include-report-agent-generate", script);
        Assert.Contains("--include-image-worker-vision", script);
        Assert.Contains("--poll-status\", \"--download-result", script);
        Assert.Contains("args.include_report_agent_generate", seed);
        Assert.Contains("LlmGateway__Retention__RequestLogDays=${LLMGW_RETENTION_REQUEST_LOG_DAYS:-90}", compose);
        Assert.Contains("LlmGateway__Retention__SensitiveBodyDays=${LLMGW_RETENTION_SENSITIVE_BODY_DAYS:-7}", compose);
        Assert.Contains("LlmGateway__Retention__ShadowDays=${LLMGW_RETENTION_SHADOW_DAYS:-30}", compose);
        Assert.Contains("LlmGateway__Retention__AuditDays=${LLMGW_RETENTION_AUDIT_DAYS:-180}", compose);
        Assert.Contains("LlmGateway__Retention__SuccessfulMultipartHours=${LLMGW_RETENTION_SUCCESSFUL_MULTIPART_HOURS:-24}", compose);
        Assert.Contains("LlmGateway__Retention__FailedMultipartHours=${LLMGW_RETENTION_FAILED_MULTIPART_HOURS:-72}", compose);
        Assert.Contains("MapGet(\"/gw/lifecycle/status\"", console);
    }

    [Fact]
    public void GatewayProductBoundary_UsesRootLlmGwPathsWithoutLegacyDirectories()
    {
        var root = LocateRepoRoot();
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "console-api")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "web")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "serving")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "deploy")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "docs")));
        Assert.False(Directory.Exists(Path.Combine(root, "prd-llmgw")));
        Assert.False(Directory.Exists(Path.Combine(root, "prd-llmgw-web")));
        Assert.False(Directory.Exists(Path.Combine(root, "prd-api", "src", "PrdAgent.LlmGateway")));

        var solution = ReadRepoFile("prd-api/PrdAgent.sln");
        var workflow = ReadRepoFile(".github/workflows/branch-image.yml");
        var devCompose = ReadRepoFile("docker-compose.dev.yml");
        Assert.Contains("..\\llmgw\\serving\\PrdAgent.LlmGateway.csproj", solution);
        Assert.Contains("llmgw/console-api/**", workflow);
        Assert.Contains("llmgw/web/**", workflow);
        Assert.Contains("llmgw/serving/**", workflow);
        Assert.Contains("context: .", workflow);
        Assert.Contains("file: ./llmgw/serving/Dockerfile", workflow);
        Assert.Contains("context: ./llmgw/console-api", devCompose);
        Assert.Contains("context: ./llmgw/web", devCompose);
    }

    [Fact]
    public void TenantHardening_EnforcesTeamReadScopeAndIdentityLifecycle()
    {
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var user = ReadRepoFile("llmgw/console-api/Models/LlmGwUser.cs");
        var jwt = ReadRepoFile("llmgw/console-api/Auth/GwJwt.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var runtime = ReadRepoFile("llmgw/serving/GatewayRuntimeGovernance.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

        Assert.Contains("FilterTeamScope", access);
        Assert.Contains("UserSecurityVersionClaim", access);
        Assert.Contains("user.SecurityVersion != securityVersion", access);
        Assert.Contains("x.Status == \"active\"", access);
        Assert.Contains("public long SecurityVersion", user);
        Assert.Contains("TenantAccess.UserSecurityVersionClaim", jwt);

        Assert.Contains("WILDCARD_SCOPE_DENIED", console);
        Assert.Contains("WILDCARD_CONFIRMATION_REQUIRED", console);
        Assert.Contains("service_key.create_wildcard", console);
        Assert.Contains("TEAM_SCOPE_REQUIRED", console);
        Assert.Contains("APP_CALLER_TEAM_MISMATCH", console);
        Assert.Contains("membership.invalidate_sessions", console);
        Assert.Contains("TryAcquireTenantOwnerMutationLockAsync", console);
        Assert.Contains("MEMBERSHIP_VERSION_CONFLICT", console);
        Assert.Contains("idempotentReplay = true", console);
        Assert.Contains("invalidatedMemberships", console);
        Assert.Contains("revokedServiceKeys", console);
        Assert.Contains("disabledAppCallers", console);
        Assert.Contains("RollbackTenantCreationAsync", console);
        Assert.Contains("RollbackMemberCreationAsync", console);
        Assert.True(
            console.Split("TenantAccess.FilterTeamScope(http", StringSplitOptions.None).Length - 1 >= 10,
            "日志、首页、协议覆盖、会话、详情和 appCaller 读取必须统一使用团队范围过滤");

        Assert.Contains("service_key.tenant_inactive", runtime);
        Assert.Contains("service_key.team_inactive", runtime);
        Assert.Contains("service_key.owner_inactive", runtime);
        Assert.Contains("service_key.owner_role_denied", runtime);
        Assert.Contains("service_key.owner_team_denied", runtime);
        Assert.Contains("service_key.app_caller_team_denied", runtime);
        Assert.Contains("AppCallerStatusDecision.Reject(appCallerCode, requestType, \"team-disabled\")", endpoints);
        Assert.Contains("app_caller.team_ownership_denied", endpoints);
        Assert.Contains("GATEWAY_APP_CALLER_MISMATCH", endpoints);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var root = LocateRepoRoot();
        var full = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    }
}
