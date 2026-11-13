using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Logs;

public static class LogTraceEndpoints
{
    public static void MapLogTraceEndpoints(this WebApplication app, IMongoCollection<BsonDocument> logs,
        IMongoDatabase mapDatabase, Func<BsonDocument, LlmLogListItem> mapLog,
        Func<BsonDocument, List<ProviderAttemptDto>> mapAttempts, JsonSerializerOptions json, string internalTenantId)
    {
        app.MapGet("/gw/logs/trace", async (HttpContext http, string reference, string? anchorId, int? page) =>
        {
            if (string.IsNullOrWhiteSpace(reference) || reference.Length > 256)
                return Results.Json(ApiEnvelope<object>.Fail("INVALID_REFERENCE", "请输入不超过 256 字的业务操作或请求编号"), json, statusCode: 400);
            var f = Builders<BsonDocument>.Filter;
            var referenceFilter = LogTraceQuery.Reference(reference.Trim());
            var seedFilter = TenantAccess.FilterTeamScope(http, referenceFilter);
            // 白名单投影：关联入口不读取提示词、响应正文或资产地址。
            var fields = new[] { "RequestId", "RunId", "LogicalRequestId", "ProviderTaskId", "PlatformId" };
            var seedProjection = fields.Aggregate(seed: Builders<BsonDocument>.Projection.Include("_id"),
                func: (projection, field) => projection.Include(field));
            var anchorFilter = anchorId is null ? seedFilter : f.And(seedFilter, f.Eq("_id", anchorId));
            var anchor = await logs.Find(anchorFilter).Project(seedProjection).SortBy(x => x["_id"]).FirstOrDefaultAsync(http.RequestAborted);
            if (anchor is null)
                return Results.Json(ApiEnvelope<object>.Fail("NOT_FOUND", "授权范围内没有此记录"), json, statusCode: 404);
            var root = LogTraceQuery.Root(anchor);
            var split = root.IndexOf(':');
            var rootFilter = f.Eq(root[..split], root[(split + 1)..]);
            if (anchorId is null && await logs.Find(f.And(seedFilter, f.Not(rootFilter))).AnyAsync(http.RequestAborted))
            {
                var candidates = await logs.Find(seedFilter).Project(seedProjection).SortBy(x => x["_id"]).Limit(101).ToListAsync(http.RequestAborted);
                return Results.Json(ApiEnvelope<object>.Ok(new {
                    ambiguous = true, hasMoreCandidates = candidates.Count > 100,
                    candidates = candidates.Take(100).Select(doc => new { id = LogTraceQuery.Text(doc, "_id"),
                        requestId = LogTraceQuery.Text(doc, "RequestId"), runId = LogTraceQuery.Text(doc, "RunId"), logicalRequestId = LogTraceQuery.Text(doc, "LogicalRequestId") })
                }), json);
            }
            if (string.IsNullOrEmpty(LogTraceQuery.Text(anchor, "RunId")))
            {
                // 精确日志编号也可能指向无 RunId 的旧行。先在授权关联范围内消歧，
                // 不能因 seed 只有一行就把复用逻辑编号的多个明确运行合成一条链。
                var explicitRuns = TenantAccess.FilterTeamScope(http, LogTraceQuery.Related(anchor))
                    & f.Type("RunId", BsonType.String) & f.Ne("RunId", "");
                var runGroups = await logs.Aggregate().Match(explicitRuns).Project(seedProjection)
                    .SortBy(x => x["_id"])
                    .Group<BsonDocument>(new BsonDocument {
                        { "_id", "$RunId" }, { "record", new BsonDocument("$first", "$$ROOT") }
                    }).SortBy(x => x["_id"]).Limit(101).ToListAsync(http.RequestAborted);
                if (runGroups.Count > 1)
                    return Results.Json(ApiEnvelope<object>.Ok(new {
                        ambiguous = true, hasMoreCandidates = runGroups.Count > 100,
                        candidates = runGroups.Take(100).Select(group => group["record"].AsBsonDocument)
                            .Select(doc => new { id = LogTraceQuery.Text(doc, "_id"),
                                requestId = LogTraceQuery.Text(doc, "RequestId"), runId = LogTraceQuery.Text(doc, "RunId"),
                                logicalRequestId = LogTraceQuery.Text(doc, "LogicalRequestId") })
                    }), json);
                // 唯一明确运行只用于本次关联查询，不改写旧日志的 RunId。
                if (runGroups.Count == 1) anchor["RunId"] = runGroups[0]["_id"];
            }
            var related = TenantAccess.FilterTeamScope(http, LogTraceQuery.Related(anchor));
            var p = Math.Max(1, page ?? 1);
            if (p > 1_000_000) return Results.Json(ApiEnvelope<object>.Fail("INVALID_PAGE", "页码超出范围"), json, statusCode: 400);
            const int size = 50;
            var total = await logs.CountDocumentsAsync(related, cancellationToken: http.RequestAborted);
            var projection = Builders<BsonDocument>.Projection.Include("_id");
            foreach (var property in typeof(LlmLogListItem).GetProperties())
            {
                var field = property.Name == "Transport" ? "GatewayTransport" : property.Name;
                projection = projection.Include(field);
            }
            foreach (var field in new[] { "ProviderAttempts", "Path", "HttpMethod", "IsHealthProbe", "WriterInstanceId", "LifecycleReason", "LifecycleReconciledAt" })
                projection = projection.Include(field);
            var docs = await logs.Find(related).Project(projection)
                .Sort(Builders<BsonDocument>.Sort.Ascending("StartedAt").Ascending("_id"))
                .Skip((p - 1) * size).Limit(size).ToListAsync(http.RequestAborted);
            object? business = null;
            var access = TenantAccess.GetRequired(http);
            if (access.TenantId == internalTenantId && LogTraceQuery.Text(anchor, "RunId") is { Length: > 0 } runId)
            {
                var businessFilter = f.Eq("_id", runId);
                if (access.Role is not (LlmGwTenantRoles.Owner or LlmGwTenantRoles.Admin))
                    businessFilter &= f.In("OwnerAdminId", new[] { access.UserId, access.ExternalUserId }.Where(x => !string.IsNullOrEmpty(x)));
                var run = await mapDatabase.GetCollection<BsonDocument>("video_gen_runs").Find(businessFilter)
                    .Project(Builders<BsonDocument>.Projection.Include("Status").Include("DirectVideoJobId")
                        .Include("VideoAssetSha256").Include("DirectVideoUpstreamStatus").Include("DirectVideoReconciledAt"))
                    .FirstOrDefaultAsync(http.RequestAborted);
                if (run is not null) business = new { runId, status = LogTraceQuery.Text(run, "Status"),
                    providerTaskId = LogTraceQuery.Text(run, "DirectVideoJobId"), artifactSha256 = LogTraceQuery.Text(run, "VideoAssetSha256"),
                    upstreamStatus = LogTraceQuery.Text(run, "DirectVideoUpstreamStatus") };
            }
            var items = new List<object>();
            foreach (var doc in docs)
            {
                var legacy = LogTraceQuery.IsLegacySummary(doc);
                var log = mapLog(doc);
                long sameReceipt = 0;
                if (!legacy && !string.IsNullOrEmpty(log.ProviderRequestId) && !string.IsNullOrEmpty(log.PlatformId))
                    sameReceipt = await logs.CountDocumentsAsync(f.And(related, f.Not(LogTraceQuery.LegacySummary),
                        f.Eq("ProviderRequestId", log.ProviderRequestId), f.Eq("PlatformId", log.PlatformId)), cancellationToken: http.RequestAborted);
                items.Add(new { log, recordKind = legacy ? "legacy-summary" : "request", sameReceiptRecords = sameReceipt,
                    attempts = legacy ? new List<ProviderAttemptDto>() : mapAttempts(doc),
                    lifecycleReason = LogTraceQuery.Text(doc, "LifecycleReason"),
                    evidenceGap = log.Status == "running" && string.IsNullOrEmpty(LogTraceQuery.Text(doc, "WriterInstanceId"))
                        ? "历史记录缺少写入实例租约，无法证明仍在运行或已经失败" : null });
            }
            return Results.Json(ApiEnvelope<object>.Ok(new { ambiguous = false, reference, anchorId = LogTraceQuery.Text(anchor, "_id"),
                total, page = p, pageSize = size, items, business }), json);
        }).RequireAuthorization("LogsRead");
    }
}
