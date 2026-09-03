using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// MAP MCP 连接器网关 —— 把 MAP 的开放接口翻译成 MCP（Model Context Protocol）工具，
/// 让 Claude / Codex 等支持 MCP 的客户端把 MAP 当"连接器"接入。
///
/// 传输：Streamable HTTP（单端点 POST /mcp，JSON-RPC 2.0）。
/// 鉴权：复用 sk-ak AgentApiKey（ApiKey 认证方案）。网关只读 scope claim，不自己验密钥。
/// 工具来源：
///   1. 内置工具（McpBuiltinTools）—— 海鲜市场 / 知识库，固定 scope
///   2. 动态工具 —— AgentOpenEndpoint 登记表，agent.* scope
/// tools/call 回环转发当前 Bearer 到真实接口，真实接口的鉴权/权限仍是最终闸门（零业务侵入）。
///
/// 设计文档：doc/design.platform.map-mcp-connector.md
/// </summary>
[ApiController]
[Route("api/mcp")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class McpGatewayController : ControllerBase
{
    private const string ProtocolVersionDefault = "2025-06-18";
    private const string ServerName = "MAP MCP Connector";
    private const string ServerVersion = "1.0.0";

    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpFactory;
    private readonly IServer _server;
    private readonly ILogger<McpGatewayController> _logger;
    private readonly McpUsageService _usage;

    public McpGatewayController(
        MongoDbContext db,
        IHttpClientFactory httpFactory,
        IServer server,
        ILogger<McpGatewayController> logger,
        McpUsageService usage)
    {
        _db = db;
        _httpFactory = httpFactory;
        _server = server;
        _logger = logger;
        _usage = usage;
    }

    /// <summary>MCP 主端点。接收 JSON-RPC（单条或批量），返回 JSON-RPC 响应。</summary>
    [HttpPost]
    public async Task<IActionResult> Handle(CancellationToken ct)
    {
        string raw;
        using (var reader = new StreamReader(Request.Body, Encoding.UTF8))
            raw = await reader.ReadToEndAsync(ct);

        JsonNode? root;
        try { root = JsonNode.Parse(raw); }
        catch { return JsonRpc(RpcError(null, -32700, "Parse error")); }

        if (root is JsonArray arr)
        {
            var responses = new JsonArray();
            foreach (var item in arr)
            {
                var r = await HandleOneAsync(item, ct);
                if (r != null) responses.Add(r);
            }
            return responses.Count == 0 ? StatusCode(202) : (IActionResult)JsonRpc(responses);
        }

        var single = await HandleOneAsync(root, ct);
        return single == null ? StatusCode(202) : (IActionResult)JsonRpc(single);
    }

    /// <summary>本网关不提供 GET 服务端推流（v1 工具均为一次性返回）。</summary>
    [HttpGet]
    public IActionResult Get() => StatusCode(405);

    // ======================================================================
    // JSON-RPC 分发
    // ======================================================================

    private async Task<JsonNode?> HandleOneAsync(JsonNode? msg, CancellationToken ct)
    {
        if (msg is not JsonObject obj)
            return RpcError(null, -32600, "Invalid Request");

        // 非抛出式读取 method（客户端可能发 "method": 1 等畸形值，GetValue<string> 会抛 → 500）。
        var method = AsString(obj["method"]);

        // JSON-RPC 2.0：通知 = "id" 成员【缺失】（不是 id:null）。只有缺失才不回响应；
        // 显式 "id": null 仍是请求，须回带 null id 的响应（否则该客户端会一直等）。
        var hasId = obj.TryGetPropertyValue("id", out var idNode);
        if (!hasId) return null;
        var id = idNode;

        if (string.IsNullOrEmpty(method))
            return RpcError(id, -32600, "Invalid Request: method 必须是非空字符串");

        switch (method)
        {
            case "initialize":
                return RpcResult(id, BuildInitializeResult(obj));
            case "ping":
                return RpcResult(id, new JsonObject());
            case "tools/list":
                return RpcResult(id, await BuildToolsListAsync(ct));
            case "tools/call":
                return await HandleToolsCallAsync(id, obj["params"] as JsonObject, ct);
            default:
                return RpcError(id, -32601, $"Method not found: {method}");
        }
    }

    private JsonObject BuildInitializeResult(JsonObject request)
    {
        // 仅实现一个协议版本：始终回我方支持的版本，不回声客户端任意版本（符合 MCP 协商语义，
        // 版本不一致时由客户端决定是否继续），避免谎称支持任意 revision。
        return new JsonObject
        {
            ["protocolVersion"] = ProtocolVersionDefault,
            ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
            ["serverInfo"] = new JsonObject { ["name"] = ServerName, ["version"] = ServerVersion },
        };
    }

    // ======================================================================
    // tools/list
    // ======================================================================

    private async Task<JsonObject> BuildToolsListAsync(CancellationToken ct)
    {
        var scopes = OwnedScopes();
        var boundUserId = User.FindFirst("boundUserId")?.Value;
        var tools = new JsonArray();

        // 内置工具：持有对应固定 scope（含写隐含读）才可见
        foreach (var t in McpBuiltinTools.All)
        {
            if (ScopeSatisfies(scopes, t.RequiredScope))
                tools.Add(BuiltinToolToJson(t));
        }

        // 动态工具：AgentOpenEndpoint 登记表，scope 交集 + 反向白名单过滤
        var endpoints = await _db.AgentOpenEndpoints.Find(e => e.IsActive).ToListAsync(ct);
        foreach (var e in endpoints)
        {
            if (!DynamicToolVisible(e, scopes, boundUserId)) continue;
            tools.Add(DynamicToolToJson(e));
        }

        return new JsonObject { ["tools"] = tools };
    }

    /// <summary>
    /// 这条登记的开放接口，对持这组 scope 的密钥可不可见。
    ///
    /// 判据只此一处：接入台的「这把钥匙能看到什么」自检要跟 tools/list 报同一份清单，
    /// 各写一份必然漂 —— 自检说 0 个工具、实际连上去有一堆，或者反过来。
    /// </summary>
    internal static bool DynamicToolVisible(AgentOpenEndpoint e, HashSet<string> scopes, string? boundUserId)
    {
        if (!e.IsActive) return false;
        var reqScopes = e.RequiredScopes ?? new List<string>();
        if (!reqScopes.Any(scopes.Contains)) return false;
        if (e.AllowedCallerUserIds is { Count: > 0 } wl && (boundUserId == null || !wl.Contains(boundUserId)))
            return false;
        return true;
    }

    internal static JsonObject BuiltinToolToJson(McpToolDef t)
    {
        var props = new JsonObject();
        var required = new JsonArray();
        foreach (var p in t.Params)
        {
            var ps = new JsonObject { ["type"] = p.Type, ["description"] = p.Description };
            if (p.EnumValues is { Length: > 0 })
            {
                var ea = new JsonArray();
                foreach (var v in p.EnumValues) ea.Add(v);
                ps["enum"] = ea;
            }
            props[p.Name] = ps;
            if (p.Required) required.Add(p.Name);
        }
        var schema = new JsonObject { ["type"] = "object", ["properties"] = props };
        if (required.Count > 0) schema["required"] = required;
        return new JsonObject
        {
            ["name"] = t.Name,
            ["description"] = t.Description,
            ["inputSchema"] = schema,
        };
    }

    private static JsonObject DynamicToolToJson(AgentOpenEndpoint e)
    {
        var desc = string.IsNullOrWhiteSpace(e.Description) ? e.Title : $"{e.Title} — {e.Description}";
        var schema = InferSchema(e.RequestExampleJson);
        AddPathParamsAsRequired(schema, e.Path);
        return new JsonObject
        {
            ["name"] = DynamicToolName(e),
            ["description"] = desc,
            ["inputSchema"] = schema,
        };
    }

    /// <summary>把 Path 里的 {param} 占位补进 inputSchema 的 properties + required；
    /// 否则 MCP 客户端不知道要传该值，路径替换后残留 {param} 致下游 404。</summary>
    private static void AddPathParamsAsRequired(JsonObject schema, string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        if (schema["properties"] is not JsonObject props)
        {
            props = new JsonObject();
            schema["properties"] = props;
        }
        if (schema["required"] is not JsonArray required)
        {
            required = new JsonArray();
            schema["required"] = required;
        }
        foreach (Match m in Regex.Matches(path, @"\{([^}/]+)\}"))
        {
            var name = m.Groups[1].Value;
            if (!props.ContainsKey(name))
                props[name] = new JsonObject { ["type"] = "string", ["description"] = $"路径参数 {name}" };
            if (!required.Any(x => x is not null && x.GetValue<string>() == name))
                required.Add(name);
        }
    }

    // ======================================================================
    // tools/call
    // ======================================================================

    private async Task<JsonObject> HandleToolsCallAsync(JsonNode? id, JsonObject? prms, CancellationToken ct)
    {
        var name = AsString(prms?["name"]);
        var args = prms?["arguments"] as JsonObject ?? new JsonObject();
        if (string.IsNullOrWhiteSpace(name))
            return RpcError(id, -32602, "Missing tool name");

        var scopes = OwnedScopes();
        var boundUserId = User.FindFirst("boundUserId")?.Value;
        var startedAt = DateTime.UtcNow;

        // 每一次工具调用都记一笔：接入台「刚刚发生了什么」要能回答「谁、用什么、做了什么、产出在哪」。
        // 被挡下来的（scope 不足 / 配额触顶）同样记，否则用户只会看到智能体那边一句语焉不详的失败。
        var log = new McpCallLog
        {
            OwnerUserId = boundUserId ?? string.Empty,
            KeyId = User.FindFirst("agentApiKeyId")?.Value ?? User.FindFirst("appId")?.Value ?? string.Empty,
            KeyName = User.FindFirst("appName")?.Value ?? string.Empty,
            ToolName = name!,
            ArgumentsPreview = McpUsageService.SummarizeArguments(args),
            CreatedAt = startedAt,
        };

        // 内置工具
        var bt = McpBuiltinTools.All.FirstOrDefault(t => t.Name == name);
        if (bt != null)
        {
            log.Capability = McpCapabilityCatalog.ByScope(bt.RequiredScope)?.Key;
            log.IsWrite = McpUsageService.IsWriteTool(bt);
            log.ImageCount = McpUsageService.IsImageTool(bt) ? ReadRequestedImageCount(args) : 0;

            if (!ScopeSatisfies(scopes, bt.RequiredScope))
                return await DeniedAsync(id, log, $"权限不足：此工具需要 scope {bt.RequiredScope}，当前密钥未授权。", ct);

            // 闸门放行时会为日额度原子占坑；下面任何一条没真跑成的路径都要把坑退回去，
            // 否则一次参数写错就白扣一张图的额度。
            var verdict = await _usage.CheckAsync(log.KeyId, bt, log.ImageCount, ct);
            if (!verdict.Allowed)
                return await DeniedAsync(id, log, verdict.Reason!, ct);

            var (path, body, err) = BuildBuiltinRequest(bt, args);
            if (err != null)
            {
                await ReleaseReservationAsync(log.KeyId, verdict, ct);
                return await DeniedAsync(id, log, err, ct);
            }

            var (status, respBody) = await LoopbackAsync(bt.Method, path, body, ct);
            await RecordFinishedAsync(log, status, respBody, startedAt, verdict, ct);
            return ToolCallResult(id, status, respBody);
        }

        // 动态工具
        var endpoints = await _db.AgentOpenEndpoints.Find(e => e.IsActive).ToListAsync(ct);
        var match = endpoints.FirstOrDefault(e => DynamicToolName(e) == name);
        if (match == null)
            return await DeniedAsync(id, log, $"工具不存在或不可用: {name}", ct);

        var ms = match.RequiredScopes ?? new List<string>();
        if (!ms.Any(scopes.Contains))
            return await DeniedAsync(id, log, "权限不足：当前密钥未授权此工具所需 scope。", ct);
        if (match.AllowedCallerUserIds is { Count: > 0 } wl &&
            (boundUserId == null || !wl.Contains(boundUserId)))
            return await DeniedAsync(id, log, "调用方不在此接口的白名单内。", ct);

        var isGetDyn = string.Equals(match.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase);
        log.IsWrite = !isGetDyn;

        // 动态工具没有内置工具那样的能力归属，只过速率闸（传 null 跳过日额度）
        var dynVerdict = await _usage.CheckAsync(log.KeyId, null, 0, ct);
        if (!dynVerdict.Allowed)
            return await DeniedAsync(id, log, dynVerdict.Reason!, ct);

        // 先替换 Path 中的 {param} 占位（取自 arguments），已用于路径的键不再进 query/body
        var consumed = new HashSet<string>(StringComparer.Ordinal);
        var dynPath = SubstitutePathParams(match.Path, args, consumed);
        var pathAndQuery = isGetDyn ? AppendQuery(dynPath, args, consumed) : dynPath;
        JsonNode? dynBody = isGetDyn ? null : BodyExcluding(args, consumed);
        var (st, rb) = await LoopbackAsync(match.HttpMethod, pathAndQuery, dynBody, ct);
        await RecordFinishedAsync(log, st, rb, startedAt, dynVerdict, ct);
        return ToolCallResult(id, st, rb);
    }

    /// <summary>把闸门占的日额度退回去（调用没真的跑成时）。</summary>
    private Task ReleaseReservationAsync(string keyId, McpQuotaVerdict verdict, CancellationToken ct)
        => verdict.ReservedKind == null
            ? Task.CompletedTask
            // 按占坑那天退，不按现在是哪天 —— 跨过 UTC 午夜的调用会退错日子
            : _usage.ReleaseAsync(keyId, verdict.ReservedKind, verdict.ReservedAmount, verdict.ReservedDay, ct);

    /// <summary>被闸门挡下：记一条 denied，再把原因原样回给智能体（它会转述给用户）。</summary>
    private async Task<JsonObject> DeniedAsync(JsonNode? id, McpCallLog log, string reason, CancellationToken ct)
    {
        log.Status = "denied";
        log.ErrorMessage = reason;
        log.DurationMs = (int)(DateTime.UtcNow - log.CreatedAt).TotalMilliseconds;
        await _usage.LogAsync(log, ct);
        return ToolError(id, reason);
    }

    /// <summary>
    /// 调用完成：记成败、耗时，认产物，并把不该算数的配额退回去。
    ///
    /// 两种要退：调用没跑成（非 2xx），以及幂等命中 —— 后者下游只是把已存在的东西原样回来，
    /// 没有新的副作用，再扣一次额度等于惩罚「响应丢了所以重试」这件本来就正常的事。
    /// </summary>
    private async Task RecordFinishedAsync(
        McpCallLog log, int status, string respBody, DateTime startedAt, McpQuotaVerdict verdict, CancellationToken ct)
    {
        log.HttpStatus = status;
        log.Status = status is >= 200 and < 300 ? "success" : "error";
        log.DurationMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;

        if (log.Status == "error")
        {
            await ReleaseReservationAsync(log.KeyId, verdict, ct);
            log.ErrorMessage = McpArtifactExtractor.ExtractErrorMessage(respBody);
        }
        else if (McpArtifactExtractor.IsDeduplicated(respBody))
        {
            await ReleaseReservationAsync(log.KeyId, verdict, ct);
            log.Deduplicated = true;
            log.ImageCount = 0;
            log.IsWrite = false;
            var dedupArtifact = McpArtifactExtractor.Extract(log.ToolName, respBody);
            log.ArtifactKind = dedupArtifact.Kind;
            log.ArtifactId = dedupArtifact.Id;
            log.ArtifactUrl = dedupArtifact.Url;
            log.ArtifactTitle = dedupArtifact.Title;
        }
        else
        {
            var artifact = McpArtifactExtractor.Extract(log.ToolName, respBody);
            log.ArtifactKind = artifact.Kind;
            log.ArtifactId = artifact.Id;
            log.ArtifactUrl = artifact.Url;
            log.ArtifactTitle = artifact.Title;
        }
        await _usage.LogAsync(log, ct);
    }

    /// <summary>生图工具的张数（用于日额度预判）；缺省 1，越界交给下游收敛。</summary>
    private static int ReadRequestedImageCount(JsonObject args)
    {
        if (args.TryGetPropertyValue("count", out var node) && node is JsonValue v)
        {
            if (v.TryGetValue<int>(out var i)) return Math.Clamp(i, 1, 4);
            if (v.TryGetValue<double>(out var d)) return Math.Clamp((int)d, 1, 4);
        }
        return 1;
    }

    internal static (string path, JsonNode? body, string? err) BuildBuiltinRequest(McpToolDef t, JsonObject args)
    {
        var path = t.PathTemplate;
        var query = new List<string>();
        JsonObject? body = null;

        foreach (var p in t.Params)
        {
            var has = args.TryGetPropertyValue(p.Name, out var val) && val != null;
            if (!has)
            {
                if (p.Required) return (string.Empty, null, $"缺少必填参数: {p.Name}");
                continue;
            }

            switch (p.In)
            {
                case "path":
                    path = path.Replace("{" + p.Name + "}", Uri.EscapeDataString(JsonValToString(val!)));
                    break;
                case "query":
                    query.Add($"{Uri.EscapeDataString(p.Name)}={Uri.EscapeDataString(JsonValToString(val!))}");
                    break;
                case "body":
                    (body ??= new JsonObject())[p.Name] = val!.DeepClone();
                    break;
            }
        }

        if (query.Count > 0)
            path += (path.Contains('?') ? "&" : "?") + string.Join("&", query);
        return (path, body, null);
    }

    /// <summary>回环 HTTP 到自身真实接口，转发当前请求的 Authorization（同一把 sk-ak）。</summary>
    private async Task<(int status, string body)> LoopbackAsync(string method, string pathAndQuery, JsonNode? body, CancellationToken ct)
    {
        var baseUrl = ResolveLoopbackBase();
        if (string.IsNullOrEmpty(baseUrl))
            return (502, "{\"error\":\"无法解析本地回环地址，已拒绝转发（不回落入站 Host）\"}");
        var client = _httpFactory.CreateClient("McpLoopback");
        using var req = new HttpRequestMessage(new HttpMethod(method), baseUrl + pathAndQuery);

        var auth = Request.Headers["Authorization"].ToString();
        if (!string.IsNullOrWhiteSpace(auth))
            req.Headers.TryAddWithoutValidation("Authorization", auth);
        // ApiKeyAuthenticationHandler 也接受 X-AI-Access-Key 作为 fallback 鉴权头，一并转发，
        // 否则用该头鉴权的客户端 tools/call 回环会丢凭据 → 下游 401。
        var aiKey = Request.Headers["X-AI-Access-Key"].ToString();
        if (!string.IsNullOrWhiteSpace(aiKey))
            req.Headers.TryAddWithoutValidation("X-AI-Access-Key", aiKey);

        // 转发外部主机信息，让下游 ResolveServerUrl 构造公网绝对 URL（而非回环 127.0.0.1）。
        // 否则海鲜市场 official skills / 任何按请求 host 拼 URL 的接口会在结果里返回 localhost 链接。
        var clientBase = Request.Headers["X-Client-Base-Url"].ToString();
        if (!string.IsNullOrWhiteSpace(clientBase))
            req.Headers.TryAddWithoutValidation("X-Client-Base-Url", clientBase);
        var fwdHost = Request.Headers["X-Forwarded-Host"].ToString();
        if (string.IsNullOrWhiteSpace(fwdHost) && Request.Host.HasValue)
            fwdHost = Request.Host.Value;
        if (!string.IsNullOrWhiteSpace(fwdHost))
        {
            req.Headers.TryAddWithoutValidation("X-Forwarded-Host", fwdHost);
            var fwdProto = Request.Headers["X-Forwarded-Proto"].ToString();
            if (string.IsNullOrWhiteSpace(fwdProto)) fwdProto = Request.Scheme;
            req.Headers.TryAddWithoutValidation("X-Forwarded-Proto", fwdProto);
        }

        if (body != null && !string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
            req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");

        try
        {
            // server-authority.md：下游可能是长任务（如周报 / agent 生成），不得因 MCP 客户端瞬断或
            // 超时而取消服务端工作（MCP Streamable HTTP 把断开视为非取消）。用 CancellationToken.None，
            // 由 McpLoopback 的 120s 超时兜底，避免无界悬挂。
            using var resp = await client.SendAsync(req, CancellationToken.None);
            var text = await resp.Content.ReadAsStringAsync(CancellationToken.None);
            return ((int)resp.StatusCode, text);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MCP] 回环调用失败 {Method} {Path}", method, pathAndQuery);
            // 用 JsonObject 序列化，ex.Message 里的引号/反斜杠/换行会被正确转义，不破坏 JSON 信封
            var errBody = new JsonObject { ["error"] = $"回环调用失败: {ex.Message}" }.ToJsonString();
            return (502, errBody);
        }
    }

    /// <summary>解析自身 Kestrel 本地监听地址（127.0.0.1:port），绕过反向代理与网络策略。</summary>
    private string? ResolveLoopbackBase()
    {
        // 候选来源：Kestrel 实际监听地址 + ASPNETCORE_URLS 环境变量。优先 http，避免对自身做 TLS 主机名校验。
        var candidates = new List<string>();
        var feat = _server.Features.Get<IServerAddressesFeature>();
        if (feat?.Addresses != null) candidates.AddRange(feat.Addresses);
        var envUrls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS");
        if (!string.IsNullOrWhiteSpace(envUrls))
            candidates.AddRange(envUrls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

        var addr = candidates.FirstOrDefault(a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                   ?? candidates.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(addr))
        {
            addr = addr.Replace("://0.0.0.0", "://127.0.0.1")
                       .Replace("://[::]", "://127.0.0.1")
                       .Replace("://+", "://127.0.0.1")
                       .Replace("://*", "://127.0.0.1");
            return addr.TrimEnd('/');
        }
        // 失败关闭：解析不到本地监听地址时返回 null，绝不回落入站 Host。
        // 否则被伪造的 Host 头会把转发的 sk-ak（且本 client 关了证书校验）发到攻击者主机。
        return null;
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    private HashSet<string> OwnedScopes() =>
        User.FindAll("scope").Select(c => c.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>非抛出式把 JsonNode 读成 string；非字符串 / 缺失返回 null（防畸形 JSON-RPC 字段抛 500）。</summary>
    internal static string? AsString(JsonNode? n) =>
        n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>
    /// scope 满足判断。判据只此一处，落在 McpCapabilityCatalog：`{res}:write` 隐含 `{res}:read`，
    /// 让只持有写 scope 的密钥也能用同一块能力的只读工具（与 REST 行为一致）。
    /// 早先这里写死了 document-store 一对，新增 web-pages 读写档时就会漏 —— 判据别按资源名硬编码。
    /// </summary>
    internal static bool ScopeSatisfies(HashSet<string> owned, string required)
        => McpCapabilityCatalog.ScopeSatisfies(owned, required);

    internal static string DynamicToolName(AgentOpenEndpoint e)
    {
        var action = "call";
        var first = (e.RequiredScopes ?? new List<string>()).FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(first))
        {
            var idx = first.IndexOf(':');
            if (idx >= 0 && idx < first.Length - 1) action = first[(idx + 1)..];
        }
        // 末尾带【完整】endpoint id（Guid N，32 hex）作后缀，id 全局唯一 ⇒ 工具名必唯一
        // （6 位前缀理论上仍可能撞）；tools/list 与 tools/call 都走本函数，命名天然一致。
        var suffix = "__" + e.Id;
        var basePart = $"{e.AgentKey}__{action}";
        var maxBase = Math.Max(0, 64 - suffix.Length);
        if (basePart.Length > maxBase) basePart = basePart[..maxBase];
        return Regex.Replace(basePart + suffix, "[^a-zA-Z0-9_-]", "_");
    }

    internal static JsonObject InferSchema(string? exampleJson)
    {
        var schema = new JsonObject { ["type"] = "object" };
        if (!string.IsNullOrWhiteSpace(exampleJson))
        {
            try
            {
                if (JsonNode.Parse(exampleJson) is JsonObject o)
                {
                    var props = new JsonObject();
                    foreach (var kv in o)
                        props[kv.Key] = new JsonObject { ["type"] = JsonTypeOf(kv.Value) };
                    schema["properties"] = props;
                }
            }
            catch { /* 示例非法就退回宽松 schema */ }
        }
        schema["additionalProperties"] = true;
        return schema;
    }

    private static string JsonTypeOf(JsonNode? n)
    {
        if (n is JsonArray) return "array";
        if (n is JsonObject) return "object";
        if (n is JsonValue v)
        {
            if (v.TryGetValue<bool>(out _)) return "boolean";
            if (v.TryGetValue<long>(out _) || v.TryGetValue<double>(out _)) return "number";
        }
        return "string";
    }

    private static string JsonValToString(JsonNode n)
    {
        if (n is JsonValue v)
        {
            if (v.TryGetValue<string>(out var s)) return s;
            if (v.TryGetValue<bool>(out var b)) return b ? "true" : "false";
            if (v.TryGetValue<long>(out var l)) return l.ToString(CultureInfo.InvariantCulture);
            if (v.TryGetValue<double>(out var d)) return d.ToString(CultureInfo.InvariantCulture);
        }
        return n.ToJsonString();
    }

    private static string AppendQuery(string path, JsonObject args, HashSet<string>? skip = null)
    {
        var q = new List<string>();
        foreach (var kv in args)
        {
            if (kv.Value == null) continue;
            if (skip != null && skip.Contains(kv.Key)) continue;
            q.Add($"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(JsonValToString(kv.Value))}");
        }
        if (q.Count == 0) return path;
        return path + (path.Contains('?') ? "&" : "?") + string.Join("&", q);
    }

    /// <summary>替换 Path 模板里的 {param} 占位为 arguments 对应值（URL 编码）；记录已消费的键。未提供的占位原样保留（让其 404 暴露问题）。</summary>
    internal static string SubstitutePathParams(string path, JsonObject args, HashSet<string> consumed)
    {
        return Regex.Replace(path, @"\{([^}/]+)\}", m =>
        {
            var key = m.Groups[1].Value;
            if (args.TryGetPropertyValue(key, out var v) && v != null)
            {
                consumed.Add(key);
                return Uri.EscapeDataString(JsonValToString(v));
            }
            return m.Value;
        });
    }

    /// <summary>构造请求体：排除已用于路径替换的键。无消费键时直接返回原 args。</summary>
    private static JsonNode? BodyExcluding(JsonObject args, HashSet<string> consumed)
    {
        if (consumed.Count == 0) return args;
        var body = new JsonObject();
        foreach (var kv in args)
            if (!consumed.Contains(kv.Key) && kv.Value != null)
                body[kv.Key] = kv.Value.DeepClone();
        return body;
    }

    // ── JSON-RPC 信封 ──

    private static JsonObject RpcResult(JsonNode? id, JsonNode result) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id?.DeepClone(),
        ["result"] = result,
    };

    private static JsonObject RpcError(JsonNode? id, int code, string message) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id?.DeepClone(),
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };

    /// <summary>工具执行类错误走 result.isError（MCP 约定），让模型可读到并自我纠错。</summary>
    private static JsonObject ToolError(JsonNode? id, string message) => RpcResult(id, new JsonObject
    {
        ["content"] = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = message } },
        ["isError"] = true,
    });

    private static JsonObject ToolCallResult(JsonNode? id, int status, string body)
    {
        var isError = status is < 200 or >= 300;
        return RpcResult(id, new JsonObject
        {
            ["content"] = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = body } },
            ["isError"] = isError,
        });
    }

    private ContentResult JsonRpc(JsonNode node) => new()
    {
        Content = node.ToJsonString(),
        ContentType = "application/json",
        StatusCode = 200,
    };
}
