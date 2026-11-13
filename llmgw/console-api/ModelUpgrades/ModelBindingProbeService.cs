using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed record ModelBindingProbeWrite(string ClientRequestId, string AppCallerCode, decimal MaxCostUsd);

/// <summary>手动逐线路验收复用单次预算队列；不修改升级策略、默认或线上线路。</summary>
public sealed class ModelBindingProbeService(IMongoDatabase database, IConfiguration configuration, string internalTenantId)
{
    private IMongoCollection<BsonDocument> Queue => database.GetCollection<BsonDocument>(ModelUpgradeService.ValidationCollectionName);
    private Task<BsonDocument?> Find(string collection, string tenant, string id, CancellationToken ct)
        => database.GetCollection<BsonDocument>(collection).Find(new BsonDocument { { "TenantId", tenant }, { "_id", id } }).FirstOrDefaultAsync(ct)!;
    public async Task<object> ReadLatestAsync(TenantAccessContext actor, string logicalId, string offeringId, CancellationToken ct)
    {
        var job = await Queue.Find(new BsonDocument { { "TenantId", actor.TenantId }, { "Operation", "binding-test" },
            { "LogicalModelId", logicalId }, { "CandidateOfferingId", offeringId } }).Sort(new BsonDocument("CreatedAt", -1)).FirstOrDefaultAsync(ct);
        return job is null ? new { requestId = "", status = "not-run", message = "尚未执行服务测试。" } : await ReadViewAsync(actor.TenantId, job, ct);
    }
    public async Task<object> ReadAsync(TenantAccessContext actor, string logicalId, string offeringId, string requestId, CancellationToken ct)
    {
        var job = await Queue.Find(new BsonDocument { { "TenantId", actor.TenantId }, { "_id", requestId },
            { "Operation", "binding-test" }, { "LogicalModelId", logicalId }, { "CandidateOfferingId", offeringId } }).FirstOrDefaultAsync(ct);
        if (job is null) throw Error("NOT_FOUND", "测试记录不存在，请刷新后核对。", 404);
        return await ReadViewAsync(actor.TenantId, job, ct);
    }
    public async Task<object> StartAsync(TenantAccessContext actor, string logicalId, string offeringId, ModelBindingProbeWrite write, CancellationToken ct)
    {
        if (actor.TenantId != internalTenantId || string.IsNullOrWhiteSpace(actor.ExternalUserId))
            throw Error("PROBE_MAP_IDENTITY_REQUIRED", "请从 MAP 登录内部组织后发起服务测试；当前仍可测试网络。");
        if (!configuration.GetValue<bool>("LlmGateway:ModelUpgrades:CanaryEnabled"))
            throw Error("PROBE_EXECUTOR_UNAVAILABLE", "当前环境未开启受预算测试执行器，请联系管理员配置后重试。");
        if (!Guid.TryParse(write.ClientRequestId, out _) || write.MaxCostUsd is <= 0 or > 1
            || string.IsNullOrWhiteSpace(write.AppCallerCode) || write.AppCallerCode.Length > 128)
            throw Error("PROBE_INPUT_INVALID", "请选择调用用途、填写 0 到 1 美元的正数预算后重试。", 400);
        var identity = string.Join("\n", actor.TenantId, actor.UserId, logicalId, offeringId, write.ClientRequestId);
        var requestId = "binding-test-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
        var fingerprint = string.Join("\n", write.AppCallerCode.Trim(), write.MaxCostUsd.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var previous = await Queue.Find(new BsonDocument { { "_id", requestId }, { "TenantId", actor.TenantId } }).FirstOrDefaultAsync(ct);
        if (previous is not null)
        {
            if (previous.GetStringOrEmpty("ProbeRequestFingerprint") != fingerprint) throw Error("PROBE_REQUEST_CHANGED", "同一次测试的参数已变化，请先核对原测试结果。", 409);
            return await ReadViewAsync(actor.TenantId, previous, ct);
        }
        var logical = await Find("llmgw_logical_models", actor.TenantId, logicalId, ct) ?? throw Error("NOT_FOUND", "模型不存在，请刷新列表。", 404);
        var offering = await Find("llmgw_model_offerings", actor.TenantId, offeringId, ct) ?? throw Error("NOT_FOUND", "线路不存在，请刷新列表。", 404);
        if (logical.AsNullableBool("Enabled") != true || offering.GetStringOrEmpty("LogicalModelId") != logicalId || offering.AsNullableBool("Enabled") != true)
            throw Error("PROBE_ROUTE_DISABLED", "模型或线路未启用，请先核对配置。", 409);
        if (offering.GetStringOrEmpty("TargetKind") != "model")
            throw Error("PROBE_PRICE_SPEC_REQUIRED", "此适配器尚未登记受预算验收规格；请先使用网络测试，并登记费用和请求规格后再启用服务测试。", 409);
        var model = await Find("llmgw_models", actor.TenantId, offering.GetStringOrEmpty("TargetId"), ct) ?? throw Error("NOT_FOUND", "上游型号不存在，请重新绑定。", 404);
        var provider = await Find("llmgw_platforms", actor.TenantId, model.GetStringOrEmpty("PlatformId"), ct) ?? throw Error("NOT_FOUND", "上游不存在，请重新绑定。", 404);
        if (model.AsNullableBool("Enabled") != true || provider.AsNullableBool("Enabled") != true)
            throw Error("PROBE_UPSTREAM_DISABLED", "所选上游或型号已停用，请先核对配置。", 409);
        var wire = ModelUpgradeWire.Capture(offering, model, provider);
        var type = logical.GetStringOrEmpty("ModelType");
        var normalized = wire.Protocol.Trim().ToLowerInvariant();
        if (normalized is "openai-compatible" or "openrouter" or "gemini-compatible") normalized = "openai";
        if (normalized is "anthropic" or "claude-compatible") normalized = "claude";
        if (type is not ("chat" or "generation") || normalized != "openai" && !(type == "chat" && normalized == "claude"))
            throw Error("PROBE_FORMAT_SPEC_REQUIRED", "当前服务测试尚未登记这种调用格式的安全规格，请使用网络测试并补全适配器验收规格。", 409);
        if (!IsKnownProbePath(type, normalized, wire.EndpointPath))
            throw Error("PROBE_PATH_SPEC_REQUIRED", "此请求路径尚未登记测试请求格式，请选择标准路径或先补全适配器规格。", 409);
        var input = model.AsNullableDecimal("InputPricePerMillion") ?? 0;
        var output = model.AsNullableDecimal("OutputPricePerMillion") ?? 0;
        if (!ModelUpgradeRules.HasKnownPrice(model) || input <= 0 || output <= 0 || model.AsNullableDecimal("PricePerCall") is not null || model.GetStringOrEmpty("PriceCurrency") != "USD")
            throw Error("PROBE_PRICE_REQUIRED", "所选型号缺少近期美元用量价格，请先登记价格再执行付费测试。", 409);
        if (type == "generation" && !ModelUpgradeRules.HasCanaryEnvelope(wire.UpstreamModelId, write.MaxCostUsd, input, output))
            throw Error("PROBE_IMAGE_SPEC_REQUIRED", "此图片型号未登记安全测试规格，或预算不足，请先核对规格与预算。", 409);
        var now = DateTime.UtcNow;
        var revision = new BsonArray(new[] { logical, provider, model }.Select(doc => new BsonDocument {
            { "id", doc["_id"] }, { "updatedAt", doc.GetValue("UpdatedAt", BsonNull.Value) } })).ToJson();
        var job = new BsonDocument { { "_id", requestId }, { "TenantId", actor.TenantId }, { "Operation", "binding-test" },
            { "ProbeRequestFingerprint", fingerprint }, { "LogicalModelId", logicalId }, { "CandidateLogicalModelPublicId", logical.GetStringOrEmpty("PublicId") },
            { "CandidateOfferingId", offeringId }, { "OfferingVersion", wire.OfferingVersion }, { "EndpointPath", (BsonValue?)wire.EndpointPath ?? BsonNull.Value },
            { "Protocol", wire.Protocol }, { "ProviderId", provider.GetStringOrEmpty("_id") }, { "Provider", provider.GetStringOrEmpty("Name") },
            { "ModelId", model.GetStringOrEmpty("_id") }, { "UpstreamModelId", wire.UpstreamModelId }, { "ModelType", type },
            { "CandidateFingerprint", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(revision))).ToLowerInvariant() },
            { "ActorConsoleUserId", actor.UserId }, { "ActorUserId", actor.ExternalUserId }, { "AppCallerCode", write.AppCallerCode.Trim() },
            { "UnitCostUpperBoundUsd", new Decimal128(write.MaxCostUsd) }, { "PriceVersion", model.AsNullableUtcDateTime("UpdatedAt")?.ToString("O") ?? "" },
            { "ExecutionRequestedBy", "manual" }, { "Status", "pending" }, { "CreatedAt", now }, { "UpdatedAt", now }, { "ExpiresAt", now.AddMinutes(10) } };
        try { await Queue.InsertOneAsync(job, cancellationToken: ct); }
        catch (MongoWriteException e) when (e.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            var existing = await Queue.Find(new BsonDocument { { "_id", requestId }, { "TenantId", actor.TenantId } }).FirstOrDefaultAsync(ct);
            if (existing is null || existing.GetStringOrEmpty("ProbeRequestFingerprint") != fingerprint)
                throw Error("PROBE_REQUEST_CHANGED", "同一次测试的参数已变化，请核对原测试结果。", 409);
            return await ReadViewAsync(actor.TenantId, existing, ct);
        }
        return View(job);
    }
    private async Task<object> ReadViewAsync(string tenant, BsonDocument job, CancellationToken ct)
    {
        var logical = await Find("llmgw_logical_models", tenant, job.GetStringOrEmpty("LogicalModelId"), ct);
        var offering = await Find("llmgw_model_offerings", tenant, job.GetStringOrEmpty("CandidateOfferingId"), ct);
        var model = await Find("llmgw_models", tenant, job.GetStringOrEmpty("ModelId"), ct);
        var provider = await Find("llmgw_platforms", tenant, job.GetStringOrEmpty("ProviderId"), ct);
        var current = logical is not null && offering is not null && model is not null && provider is not null;
        if (current)
        {
            var revision = new BsonArray(new[] { logical!, provider!, model! }.Select(doc => new BsonDocument {
                { "id", doc["_id"] }, { "updatedAt", doc.GetValue("UpdatedAt", BsonNull.Value) } })).ToJson();
            current = job.GetStringOrEmpty("CandidateFingerprint") == Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(revision))).ToLowerInvariant()
                && job.GetStringOrEmpty("OfferingVersion") == ModelUpgradeWire.Fingerprint(offering!);
        }
        return View(job, current);
    }
    public static bool IsKnownProbePath(string type, string protocol, string? endpoint)
    {
        if (string.IsNullOrWhiteSpace(endpoint)) return true;
        var path = Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) ? uri.AbsolutePath : endpoint;
        if (path.Contains('?') || path.Contains('#')) return false;
        path = path.Trim('/');
        var suffix = type == "generation" ? "images/generations" : protocol == "claude" ? "messages" : "chat/completions";
        return string.Equals(path, suffix, StringComparison.OrdinalIgnoreCase) || path.EndsWith("/" + suffix, StringComparison.OrdinalIgnoreCase);
    }
    private static object View(BsonDocument job, bool current = true) => new {
        requestId = job.GetStringOrEmpty("_id"), status = !current && job.GetStringOrEmpty("Status") is not ("pending" or "running") ? "stale" : job.GetStringOrEmpty("Status") == "pending" && job.AsNullableUtcDateTime("ExpiresAt") <= DateTime.UtcNow ? "expired" : job.GetStringOrEmpty("Status"),
        message = !current ? "配置已变化，此记录只代表原线路；请核对原测试结束后重新测试。" : job.AsNullableString("Message") ?? "已登记，等待受预算执行器；最多发送一次。",
        outputUrl = current ? job.AsNullableString("OutputUrl") : null, offeringId = job.GetStringOrEmpty("CandidateOfferingId"),
        upstreamModelId = job.GetStringOrEmpty("UpstreamModelId"), updatedAt = job.AsNullableUtcDateTime("UpdatedAt")?.ToString("O"),
        httpStatus = job.AsNullableInt("HttpStatus"), failureKind = job.AsNullableString("FailureKind"),
    };
    private static ModelUpgradeException Error(string code, string message, int status = 409) => new(code, message, status);
}
