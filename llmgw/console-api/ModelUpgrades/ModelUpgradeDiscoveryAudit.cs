using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

/// <summary>沿用受租户审计入口；只保存目录 ID、白名单错误字段与无正文摘要。</summary>
public sealed class ModelUpgradeDiscoveryAudit(IMongoDatabase database, IConfiguration configuration)
{
    public const int BodyLimit = 4 * 1024 * 1024;
    public const int ModelIdLimit = 128;
    private IMongoCollection<BsonDocument> Audits => database.GetCollection<BsonDocument>("llmgw_operation_audits");
    private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static string Digest(string value) => Digest(Encoding.UTF8.GetBytes(value));
    private static string Identifier(string? value, string secret, int limit = 160)
    {
        if (string.IsNullOrEmpty(value)) return "";
        if (value.Length > limit || value.Contains(secret, StringComparison.Ordinal) && secret.Length > 0
            || Regex.IsMatch(value, @"(?i)(sk-[A-Za-z0-9_-]{8,}|bearer[: _-]|(?:password|api[_-]?key|token|secret)[=:])")
            || !Regex.IsMatch(value, @"^[A-Za-z0-9][A-Za-z0-9._:+/-]*$")) return "[omitted:" + Digest(value)[..16] + "]";
        return value;
    }
    private static BsonDocument ErrorField(JsonElement error, string name, string secret)
    {
        if (error.ValueKind != JsonValueKind.Object || !error.TryGetProperty(name, out var field)) return new("state", "missing");
        if (field.ValueKind == JsonValueKind.Null) return new("state", "null");
        if (name != "message" && field.ValueKind == JsonValueKind.Number && field.TryGetInt64(out var numericCode)) return new() { { "state", "present" }, { "type", "number" }, { "value", numericCode } };
        if (field.ValueKind != JsonValueKind.String) return new() { { "state", "wrong-type" }, { "type", field.ValueKind.ToString() } };
        var text = field.GetString()!;
        var state = text.Length == 0 ? "empty" : string.IsNullOrWhiteSpace(text) ? "whitespace" : "present";
        if (name != "message") return new() { { "state", state }, { "value", Identifier(text, secret, 96) }, { "length", text.Length } };
        // Untrusted free text can contain arbitrary credentials, PII or prompt fragments. Retain a safe reason category and digest.
        var reason = Regex.IsMatch(text, @"(?i)rate.?limit|too many requests") ? "rate-limit"
            : Regex.IsMatch(text, @"(?i)api.?key|authentication|unauthori[sz]ed|invalid credential") ? "authentication-rejected"
            : Regex.IsMatch(text, @"(?i)permission|forbidden|access denied") ? "permission-denied"
            : Regex.IsMatch(text, @"(?i)model.*(not found|unavailable)|unknown model") ? "model-unavailable" : "upstream-error";
        return new() { { "state", state }, { "summary", reason }, { "length", text.Length }, { "sha256", Digest(text) }, { "omitted", true }, { "omissionReason", "untrusted-free-text-may-contain-secrets-or-pii" } };
    }
    public static BsonDocument Snapshot(byte[] body, string secret, bool truncated)
    {
        var evidence = new BsonDocument { { "retainedBytes", body.Length }, { "bodySha256", Digest(body) },
            { "hashScope", truncated ? "retained-prefix" : "complete-body" }, { "bodyOmitted", true },
            { "omissionReason", "only-model-ids-and-safe-error-fields-are-retained" }, { "truncated", truncated } };
        try
        {
            using var json = JsonDocument.Parse(body);
            evidence["format"] = "json";
            var root = json.RootElement;
            var hasData = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("data", out _);
            var data = hasData ? root.GetProperty("data") : default;
            evidence["dataState"] = !hasData ? "missing" : data.ValueKind == JsonValueKind.Null ? "null" : data.ValueKind != JsonValueKind.Array ? "wrong-type" : data.GetArrayLength() == 0 ? "empty-array" : "array";
            if (data.ValueKind == JsonValueKind.Array)
            {
                var all = data.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Object && x.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String).Select(x => x.GetProperty("id").GetString()!).ToList();
                evidence["modelIds"] = new BsonArray(all.Take(ModelIdLimit).Select(x => Identifier(x, secret)));
                evidence["modelIdCount"] = all.Count; evidence["modelIdsTruncated"] = all.Count > ModelIdLimit;
                evidence["invalidModelEntryCount"] = data.GetArrayLength() - all.Count;
            }
            var error = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var e) ? e : default;
            evidence["error"] = new BsonDocument { { "code", ErrorField(error, "code", secret) }, { "type", ErrorField(error, "type", secret) }, { "message", ErrorField(error, "message", secret) } };
        }
        catch (JsonException) { evidence["format"] = "non-json-or-invalid-json"; evidence["summary"] = "原始正文未保存；以字节数与散列定位异常响应。"; }
        return evidence;
    }
    private static BsonDocument SafeHeaders(HttpResponseMessage response, string secret)
    {
        var headers = new BsonDocument();
        foreach (var key in new[] { "x-request-id", "request-id", "traceparent", "cf-ray" })
            if (response.Headers.TryGetValues(key, out var values)) headers[key] = Identifier(values.FirstOrDefault(), secret, 160);
        if (response.Headers.RetryAfter is { } retry) headers["retry-after"] = retry.Delta?.TotalSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? retry.Date?.ToUniversalTime().ToString("O") ?? "";
        if (response.Headers.Date is { } date) headers["date"] = date.ToUniversalTime().ToString("O");
        return headers;
    }
    public async Task<HashSet<string>> ExecuteAsync(ModelUpgradeState state, BsonDocument provider, Uri target, HttpClient client, string key, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("N");
        var started = DateTime.UtcNow;
        var changes = new BsonDocument { { "requestId", id }, { "application", "llmgw" }, { "operation", "models.list" }, { "attempt", 1 },
            { "providerId", provider.GetStringOrEmpty("_id") }, { "logicalModelId", state.LogicalModelId }, { "policyId", state.Id }, { "policyVersion", state.Version },
            { "method", "GET" }, { "targetOrigin", target.GetLeftPart(UriPartial.Authority) }, { "targetPathSha256", Digest(target.AbsolutePath) }, { "queryOmitted", true }, { "credentialSha256", Digest(key) },
            { "startedAt", started }, { "timeoutSeconds", 20 }, { "responseByteLimit", BodyLimit }, { "modelIdLimit", ModelIdLimit },
            { "providerUpdatedAt", provider.GetValue("UpdatedAt", BsonNull.Value) },
            { "build", Identifier(configuration["CDS_COMMIT_SHA"] ?? configuration["GIT_COMMIT"] ?? typeof(ModelUpgradeDiscoveryAudit).Assembly.GetName().Version?.ToString(), key) },
            { "deployment", Identifier(configuration[ModelUpgradeDeploymentAuthority.WorkerDeploymentKey], key) },
            { "instance", Identifier(Environment.MachineName, key) }, { "receivedResponse", false }, { "classification", "request-started" }, { "stage", "sending" } };
        var record = new BsonDocument { { "_id", id }, { "TenantId", state.TenantId }, { "Action", "model-upgrade.discovery.response" },
            { "TargetType", "llmgw_logical_model" }, { "TargetId", state.LogicalModelId }, { "ActorUserId", state.ActorConsoleUserId }, { "ActorUsername", state.ActorUsername },
            { "Success", false }, { "State", "pending" }, { "CreatedAt", started }, { "Changes", changes } };
        try { await Audits.InsertOneAsync(record, cancellationToken: CancellationToken.None); }
        catch { throw new ModelUpgradeException("DISCOVERY_AUDIT_FAILED", "目录请求审计未能写入，本次未发出请求；请恢复审计存储后重试。"); }
        var watch = Stopwatch.StartNew();
        Exception? failure = null; HashSet<string>? names = null;
        using var body = new MemoryStream();
        var truncated = false; var readCompleted = false;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(20));
            using var request = new HttpRequestMessage(HttpMethod.Get, target);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            changes["stage"] = "reading-body"; changes["receivedResponse"] = true; changes["httpStatus"] = (int)response.StatusCode;
            changes["contentType"] = Identifier(response.Content.Headers.ContentType?.MediaType, key, 96);
            changes["safeHeaders"] = SafeHeaders(response, key);
            changes["advertisedBytes"] = response.Content.Headers.ContentLength is { } length ? (BsonValue)length : BsonNull.Value;
            using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            var buffer = new byte[16384]; int read;
            while ((read = await stream.ReadAsync(buffer, timeout.Token)) > 0)
            {
                var keep = Math.Min(read, BodyLimit - (int)body.Length);
                await body.WriteAsync(buffer.AsMemory(0, keep), timeout.Token);
                if (keep != read) { truncated = true; break; }
            }
            readCompleted = !truncated;
            if (truncated) { changes["classification"] = "response-too-large"; throw new ModelUpgradeException("DISCOVERY_TOO_LARGE", "模型清单超过证据和解析限额，本次检查停止，原线路未改变。", 502); }
            if (!response.IsSuccessStatusCode) { changes["classification"] = "http-rejected"; throw new ModelUpgradeException("DISCOVERY_REJECTED", $"官方模型清单请求返回 HTTP {(int)response.StatusCode}；请检查权限或稍后重试。", 502); }
            changes["stage"] = "parsing";
            try
            {
                using var parsed = JsonDocument.Parse(body.ToArray());
                if (parsed.RootElement.ValueKind == JsonValueKind.Object && parsed.RootElement.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
                { changes["classification"] = "upstream-business-error"; throw new ModelUpgradeException("DISCOVERY_UPSTREAM_ERROR", "官方目录返回业务错误，原线路未改变；请查看脱敏响应审计。", 502); }
                names = ModelUpgradeDiscovery.ReadModelNames(body.ToArray()); changes["classification"] = "models-parsed";
            }
            catch (JsonException) { changes["classification"] = "invalid-json"; throw new ModelUpgradeException("DISCOVERY_PARSE_FAILED", "官方目录返回无法解析，原线路未改变；请查看脱敏响应审计。", 502); }
            catch (ModelUpgradeException) { if (changes["classification"] != "upstream-business-error") changes["classification"] = "invalid-model-list-shape"; throw; }
        }
        catch (OperationCanceledException) { changes["classification"] = ct.IsCancellationRequested ? "cancelled" : "timeout"; failure = new ModelUpgradeException("DISCOVERY_TIMEOUT", "目录请求未完成，请查看审计中的响应阶段并稍后重试。", 502); }
        catch (HttpRequestException) { changes["classification"] = "network-failure"; failure = new ModelUpgradeException("DISCOVERY_NETWORK_FAILED", "目录网络请求失败，原线路未改变；请检查网络或稍后重试。", 502); }
        catch (IOException) { changes["classification"] = "body-read-failure"; failure = new ModelUpgradeException("DISCOVERY_READ_FAILED", "目录响应未能完整读取，原线路未改变；请查看响应审计。", 502); }
        catch (ModelUpgradeException e) { failure = e; }
        catch (Exception) { changes["classification"] = "local-processing-failure"; failure = new ModelUpgradeException("DISCOVERY_PROCESSING_FAILED", "目录处理未能完成，请查看脱敏响应审计后重试。", 502); }
        changes["endedAt"] = DateTime.UtcNow; changes["elapsedMs"] = watch.ElapsedMilliseconds;
        changes["originalBytesKnown"] = readCompleted;
        changes["originalBytes"] = readCompleted ? (BsonValue)body.Length : BsonNull.Value;
        if (failure is null) changes["stage"] = "completed";
        changes["response"] = changes["receivedResponse"].AsBoolean
            ? Snapshot(body.ToArray(), key, truncated || !readCompleted)
            : new BsonDocument { { "bodyOmitted", true }, { "retainedBytes", 0 }, { "omissionReason", "no-response-received" } };
        try
        {
            var updated = await Audits.UpdateOneAsync(new BsonDocument { { "_id", id }, { "TenantId", state.TenantId } },
                Builders<BsonDocument>.Update.Set("Changes", changes).Set("State", failure is null ? "completed" : "failed").Set("Success", failure is null).Set("CompletedAt", DateTime.UtcNow), cancellationToken: CancellationToken.None);
            if (updated.MatchedCount != 1) throw new InvalidOperationException();
        }
        catch { throw new ModelUpgradeException("DISCOVERY_AUDIT_FAILED", "目录请求已结束，但响应审计未能保存；本次检查已阻止，请恢复审计存储后重试。"); }
        if (failure is not null) throw failure;
        return names!;
    }
}
