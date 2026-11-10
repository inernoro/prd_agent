using System.Diagnostics;
using System.Net;
using System.Text.Json;
using PrdAgent.GatewayTransport;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.Security;

namespace PrdAgent.LlmGw;

public sealed class UpstreamNetworkTestRequest { public int Samples { get; set; } = 3; public UpstreamProxyWrite? Proxy { get; set; } }
public sealed record UpstreamNetworkSample(int Attempt, bool Connected, int? HttpStatus, long ElapsedMs, string Message);
public sealed record UpstreamNetworkTestResult(string Route, string ProbedUrl, int SampleCount, int SuccessCount,
    double SuccessRate, double? AverageMs, long? MinMs, long? MaxMs, string TestedAt,
    IReadOnlyList<UpstreamNetworkSample> Samples);

public sealed class UpstreamProxyService(IMongoDatabase database, IConfiguration config, string internalTenantId)
{
    private IMongoCollection<BsonDocument> Tenants => database.GetCollection<BsonDocument>("llmgw_tenants");

    public async Task<BsonDocument?> GlobalAsync(string tenantId, CancellationToken ct = default)
        => UpstreamProxy.Read(await Tenants.Find(Builders<BsonDocument>.Filter.Eq("_id", tenantId)).FirstOrDefaultAsync(ct));

    public async Task<BsonDocument> BuildAsync(HttpContext http, UpstreamProxyWrite input, BsonDocument? previous = null, bool global = false)
    {
        var doc = UpstreamProxy.Build(input, previous, value => GwApiKeyCrypto.Encrypt(value, config), global);
        if (TenantAccess.GetRequired(http).TenantId != internalTenantId && UpstreamProxy.View(doc).Address is { } address)
        {
            var uri = new Uri(address);
            IPAddress[] addresses;
            try { addresses = await Dns.GetHostAddressesAsync(uri.IdnHost, http.RequestAborted); }
            catch (System.Net.Sockets.SocketException) { throw new ArgumentException("代理域名无法解析，请检查代理地址后重试"); }
            if (addresses.Length == 0 || addresses.Any(ip => !UpstreamProxy.IsPublicAddress(ip)))
                throw new ArgumentException("代理必须使用公网地址；不能连接网关的内网、回环或保留地址");
        }
        return doc;
    }

    public async Task<ResolvedUpstreamProxy?> ResolveAsync(HttpContext http, BsonDocument upstream)
        => UpstreamProxy.Resolve(UpstreamProxy.Read(upstream), await GlobalAsync(TenantAccess.GetRequired(http).TenantId, http.RequestAborted),
            encrypted => { var result = GwApiKeyCrypto.Decrypt(encrypted, config); return result.Success ? result.PlainText : null; });

    public HttpClient? CreateClient(HttpContext http, ResolvedUpstreamProxy? resolved)
    {
        return resolved is null ? null : new HttpClient(UpstreamProxy.CreateHandler(resolved, TenantAccess.GetRequired(http).TenantId != internalTenantId))
            { Timeout = TimeSpan.FromSeconds(15) };
    }

    public void MapEndpoints(WebApplication app, JsonSerializerOptions json)
    {
        IResult Ok<T>(T data) => Results.Json(ApiEnvelope<T>.Ok(data), json);
        IResult Fail(string code, string message, int status = 400) => Results.Json(ApiEnvelope<object>.Fail(code, message), json, statusCode: status);

        app.MapGet("/gw/upstream-proxy", async (HttpContext http, CancellationToken ct) =>
            Ok(UpstreamProxy.View(await GlobalAsync(TenantAccess.GetRequired(http).TenantId, ct), "direct")))
            .RequireAuthorization("LogsRead");

        app.MapPut("/gw/upstream-proxy", async (HttpContext http, UpstreamProxyWrite body) =>
        {
            var tenantId = TenantAccess.GetRequired(http).TenantId;
            try
            {
                var doc = await BuildAsync(http, body, await GlobalAsync(tenantId, http.RequestAborted), global: true);
                var result = await Tenants.UpdateOneAsync(Builders<BsonDocument>.Filter.Eq("_id", tenantId),
                    Builders<BsonDocument>.Update.Set(UpstreamProxy.Field, doc).Set("UpdatedAt", DateTime.UtcNow), cancellationToken: http.RequestAborted);
                if (result.MatchedCount == 0) return Fail("NOT_FOUND", "当前组织不存在，请重新登录", 404);
                await AuditAsync(http, "upstream-proxy.update", tenantId, new BsonDocument
                {
                    { "mode", UpstreamProxy.View(doc).Mode }, { "address", (BsonValue?)UpstreamProxy.View(doc).Address ?? BsonNull.Value },
                    { "hasPassword", UpstreamProxy.View(doc).HasPassword },
                }, CancellationToken.None);
                return Ok(UpstreamProxy.View(doc, "direct"));
            }
            catch (ArgumentException ex) { return Fail("INVALID_PROXY", ex.Message); }
            catch (InvalidOperationException) { return Fail("PROXY_SECRET_UNAVAILABLE", "代理密码未能加密，请检查网关的加密配置后重试"); }
        }).RequireAuthorization("ConfigWrite");

        app.MapPost("/gw/upstreams/{kind}/{id}/network-test", async (HttpContext http, string kind, string id, UpstreamNetworkTestRequest body) =>
        {
            if (kind is not ("platform" or "exchange")) return Fail("INVALID_KIND", "请选择供应方或转接上游");
            if (body.Samples is < 1 or > 5) return Fail("INVALID_SAMPLES", "连续测试次数必须在 1 到 5 次之间");
            var collection = database.GetCollection<BsonDocument>(kind == "platform" ? "llmgw_platforms" : "llmgw_model_exchanges");
            var upstream = await collection.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id))).FirstOrDefaultAsync(http.RequestAborted);
            if (upstream is null) return Fail("NOT_FOUND", "上游不存在或尚未导入网关，请刷新后重试", 404);
            var rawUrl = upstream.GetValue(kind == "platform" ? "ApiUrl" : "TargetUrl", "").AsString;
            // HEAD 不发送推理或任务请求，避免连通性测试产生模型费用。
            // 带模型占位符的地址只取服务根路径；WebSocket 使用对应 HTTPS 握手目标。
            rawUrl = rawUrl.Replace("{model}", "network-probe", StringComparison.Ordinal);
            if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https" or "wss")
                || uri.UserInfo.Length > 0) return Fail("INVALID_URL", "请先保存有效的上游地址，再测试连接");
            var probeUri = new UriBuilder(uri) { Scheme = uri.Scheme == "wss" ? "https" : uri.Scheme, Query = "", Fragment = "" }.Uri;
            var publicOnly = TenantAccess.GetRequired(http).TenantId != internalTenantId;
            // 代理解析目标域名时也拒绝显式内网目标；实际 TCP 对端（代理或目标）另在 handler 中固定校验。
            if (publicOnly && (probeUri.IsLoopback || IPAddress.TryParse(probeUri.IdnHost, out var literal) && !UpstreamProxy.IsPublicAddress(literal)))
                return Fail("UNSAFE_TARGET", "上游地址不能指向内网、回环或保留地址");
            ResolvedUpstreamProxy? resolved;
            try
            {
                resolved = body.Proxy is null ? await ResolveAsync(http, upstream)
                    : UpstreamProxy.Resolve(await BuildAsync(http, body.Proxy), await GlobalAsync(TenantAccess.GetRequired(http).TenantId, http.RequestAborted),
                        encrypted => { var key = GwApiKeyCrypto.Decrypt(encrypted, config); return key.Success ? key.PlainText : null; });
            }
            catch (ArgumentException ex) { return Fail("INVALID_PROXY", ex.Message); }
            catch (InvalidOperationException ex) { return Fail("INVALID_PROXY", ex.Message); }
            var route = resolved?.Mode == "custom"
                ? (body.Proxy is not null ? "临时测试代理" : UpstreamProxy.View(UpstreamProxy.Read(upstream)).Mode == "inherit" ? "全局代理" : "独立代理")
                : resolved is null ? "部署默认" : "直连";
            using var client = new HttpClient(UpstreamProxy.CreateHandler(resolved ?? new("system", null, null, null), publicOnly))
                { Timeout = Timeout.InfiniteTimeSpan };
            var samples = new List<UpstreamNetworkSample>();
            var testId = Guid.NewGuid().ToString("N");
            for (var index = 1; index <= body.Samples; index++)
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);
                deadline.CancelAfter(TimeSpan.FromSeconds(5));
                var startedAt = DateTime.UtcNow;
                var sw = Stopwatch.StartNew();
                int? status = null;
                string? contentType = null;
                string? upstreamRequestId = null;
                string? failureStage = null;
                string message;
                bool connected;
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Head, probeUri);
                    // 要测新建连接的波动，不能反复复用同一条已经成功的 keep-alive 连接。
                    request.Headers.ConnectionClose = true;
                    using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                    status = (int)response.StatusCode;
                    contentType = response.Content.Headers.ContentType?.MediaType;
                    upstreamRequestId = response.Headers.TryGetValues("x-request-id", out var ids) ? ids.FirstOrDefault() : null;
                    connected = status != 407;
                    message = status switch
                    {
                        407 => "代理要求认证，请检查代理账号和密码",
                        401 or 403 => "已连通，上游拒绝当前请求；请检查访问权限，并运行上游连接测试",
                        404 or 405 => "已连通，上游不提供此探测接口；请继续用模型连接测试确认服务可用",
                        >= 500 => "已收到响应，上游或代理返回服务异常",
                        _ => "已收到响应",
                    };
                }
                catch (OperationCanceledException)
                {
                    connected = false;
                    failureStage = http.RequestAborted.IsCancellationRequested ? "request-canceled" : "response-timeout";
                    message = http.RequestAborted.IsCancellationRequested
                        ? "客户端已中断连接测试，未收到响应"
                        : "5 秒内未收到响应，请检查代理、上游地址或稍后重试";
                }
                catch (HttpRequestException)
                { connected = false; failureStage = "connection"; message = "连接失败，请检查代理地址、认证信息及上游是否可访问"; }
                sw.Stop();
                var sample = new UpstreamNetworkSample(index, connected, status, sw.ElapsedMilliseconds, message);
                samples.Add(sample);
                await AuditAsync(http, "upstream.network-test", id, new BsonDocument
                {
                    { "testId", testId }, { "attempt", index }, { "kind", kind }, { "method", "HEAD" },
                    { "targetHost", probeUri.IdnHost }, { "route", route }, { "startedAt", startedAt }, { "endedAt", DateTime.UtcNow },
                    { "elapsedMs", sample.ElapsedMs }, { "receivedResponse", status.HasValue }, { "connected", sample.Connected },
                    { "httpStatus", (BsonValue?)status ?? BsonNull.Value }, { "contentType", (BsonValue?)contentType ?? BsonNull.Value },
                    { "upstreamRequestId", upstreamRequestId is null ? BsonNull.Value : new BsonString(new string(upstreamRequestId.Where(c => !char.IsControl(c)).Take(128).ToArray())) },
                    { "message", sample.Message }, { "responseBodyOmittedReason", "HEAD 请求没有响应正文；只保留安全响应头及本地判定" },
                    { "failureStage", (BsonValue?)failureStage ?? BsonNull.Value },
                    { "timeoutMs", 5000 },
                }, CancellationToken.None);
                // 请求取消也先持久化本次实际探测，再停止后续采样并传播取消。
                http.RequestAborted.ThrowIfCancellationRequested();
            }
            var successful = samples.Where(x => x.Connected).Select(x => x.ElapsedMs).ToArray();
            return Ok(new UpstreamNetworkTestResult(route, probeUri.GetLeftPart(UriPartial.Path), samples.Count, successful.Length,
                100d * successful.Length / samples.Count, successful.Length == 0 ? null : Math.Round(successful.Average(), 1),
                successful.Length == 0 ? null : successful.Min(), successful.Length == 0 ? null : successful.Max(), DateTime.UtcNow.ToString("O"), samples));
        }).RequireAuthorization("ConfigWrite");
    }

    private Task AuditAsync(HttpContext http, string action, string targetId, BsonDocument evidence, CancellationToken ct)
        => database.GetCollection<BsonDocument>("llmgw_operation_audits").InsertOneAsync(new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") }, { "TenantId", TenantAccess.GetRequired(http).TenantId },
            { "ActorUsername", TenantAccess.GetRequired(http).Username }, { "Action", action },
            { "TargetType", "upstream" }, { "TargetId", targetId }, { "Success", action != "upstream.network-test" || evidence.GetValue("connected", false).AsBoolean },
            { "CreatedAt", DateTime.UtcNow }, { "Changes", evidence },
        }, cancellationToken: ct);
}
