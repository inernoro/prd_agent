using System.Text.Json.Nodes;

namespace PrdAgent.Api.Services.Mcp;

/// <summary>
/// 从工具回环调用的响应里认出「产物」—— 接入台的调用记录要能一点就打开智能体刚做出来的东西。
///
/// 按**键名**认，不按工具名维护一张映射表：新增一个返回 siteId/entryId 的工具时，
/// 记录里自动就有产物，不需要有人记得回来加一行（判据分裂成两份然后漂移的老形状）。
/// </summary>
public static class McpArtifactExtractor
{
    public sealed record Artifact(string? Kind, string? Id, string? Url, string? Title);

    private static readonly (string Key, string Kind)[] IdKeys =
    {
        ("siteId", "site"),
        ("shareId", "share"),
        ("entryId", "entry"),
        ("storeId", "store"),
        ("workspaceId", "workspace"),
        ("runId", "image-run"),
        ("skillId", "skill"),
    };

    private static readonly string[] UrlKeys = { "url", "shareUrl", "downloadUrl", "siteUrl" };
    private static readonly string[] TitleKeys = { "title", "name" };

    /// <param name="producesArtifacts">
    /// 这次调用是不是「做出了东西」。取工具的写入语义（<c>McpUsageService.IsWriteTool</c>），
    /// 不再看工具名里有没有 `_get_` —— 名字片段判不准：knowledge_base_read_entry 是纯读，
    /// 名字里却没有 `_get_`，它回的 data.entryId 会被当成这次的产物；将来加个
    /// map_kb_fetch_xxx 一样漏。判据要跟着语义走，不跟着命名习惯走。
    /// </param>
    public static Artifact Extract(string toolName, bool producesArtifacts, string? responseBody)
    {
        var data = ReadDataObject(responseBody);
        if (data == null) return new Artifact(null, null, null, null);

        string? kind = null, id = null;
        foreach (var (key, k) in IdKeys)
        {
            var v = ReadString(data, key);
            if (string.IsNullOrWhiteSpace(v)) continue;
            kind = k;
            id = v;
            break;
        }

        // 读类工具即使带 id 也不算产物：产物是「这次做出来的东西」，不是「这次看了的东西」。
        // 例外是生图任务：图是上一次 generate 做出来的，但那次调用只拿得到 runId，
        // 地址要等跑完才有 —— 不在这里放行，用户就永远没有一个能点开图的记录。
        if (!producesArtifacts && kind != "image-run")
            return new Artifact(null, null, null, null);

        string? url = null;
        foreach (var key in UrlKeys)
        {
            url = ReadString(data, key);
            if (!string.IsNullOrWhiteSpace(url)) break;
        }
        // 生图这类工具的地址挂在数组里（data.images[].url），顶层没有 url。
        // 只认顶层的话，跑完的生图记录永远是「有 runId、没有可点开的产物」——
        // 而「一点就打开刚做出来的东西」正是这条记录存在的理由。
        //
        // 但下探只对**已经认出是生图任务**的响应做。无差别扫所有数组会把列表类工具坑掉：
        // map_web_list_pages 回的是 data.items[]，第一条既有站点的地址会被当成「这次做出来的东西」，
        // 记录上于是长出一个指向别处的「打开」按钮 —— 产物是这次做出来的，不是这次看到的。
        if (string.IsNullOrWhiteSpace(url) && kind == "image-run") url = ReadFirstUrlInArrays(data);

        string? title = null;
        foreach (var key in TitleKeys)
        {
            title = ReadString(data, key);
            if (!string.IsNullOrWhiteSpace(title)) break;
        }

        // 有些写入工具压根不返回地址：建库、建条目、建文学工作区回的只有 id。
        // 那几条记录于是只有「产物类型 + id」，面板上既没有「打开」也看不到 id ——
        // 而「一点就打开智能体刚做出来的东西」正是这块面板存在的理由。
        // 所以按 kind + 手上的 id 反推站内路由（都是本仓库真实在用的深链形态，见下）。
        if (string.IsNullOrWhiteSpace(url)) url = BuildInternalRoute(kind, id, data);

        if (kind == null && string.IsNullOrWhiteSpace(url)) return new Artifact(null, null, null, null);
        return new Artifact(kind, id, url, title);
    }

    /// <summary>下游是不是把幂等命中的既有产物原样回来了（各开放层统一回 data.deduplicated=true）。</summary>
    public static bool IsDeduplicated(string? responseBody)
    {
        var data = ReadDataObject(responseBody);
        return data != null
               && data.TryGetPropertyValue("deduplicated", out var node)
               && node is JsonValue v
               && v.TryGetValue<bool>(out var flag)
               && flag;
    }

    /// <summary>失败时给用户看的原因：优先接口自己的中文 message，退回一小段原文。</summary>
    public static string? ExtractErrorMessage(string? responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody)) return null;
        try
        {
            if (JsonNode.Parse(responseBody) is JsonObject root)
            {
                if (root["error"] is JsonObject err)
                {
                    var msg = ReadString(err, "message");
                    if (!string.IsNullOrWhiteSpace(msg)) return UserFacing(msg);
                }
                var top = ReadString(root, "message");
                if (!string.IsNullOrWhiteSpace(top)) return UserFacing(top);
            }
        }
        catch { /* 不是 JSON：见下面为什么不退回原文 */ }

        // 认不出结构化的 message 时**不回原文**。这段字符串会原样存进 McpCallLog.ErrorMessage，
        // 并在接入台上作为「失败原因」显示给普通用户 —— 而认不出结构的那种响应，恰恰最可能是
        // 代理页、框架的开发者错误页或异常堆栈，里面带着内部主机名与调用栈。
        // 原文只留在服务端日志里（调用方自己那一侧也拿得到真实响应），面板上给一句稳定的、
        // 能照着做下一步的说明。
        return UnrecognizedFailure;
    }

    /// <summary>认不出结构时给用户看的固定说法。原始响应体只进服务端日志，不进面板。</summary>
    internal const string UnrecognizedFailure = "下游返回了无法识别的错误，详细内容见服务端日志。请稍后重试；一直不行就把调用时间告诉管理员。";

    /// <summary>在 data 的数组字段里找第一个带 url 的元素（生图 images[]）。只下探一层，不做深搜，且只在已认出生图任务时调用。</summary>
    private static string? ReadFirstUrlInArrays(JsonObject data)
    {
        foreach (var kv in data)
        {
            if (kv.Value is not JsonArray arr) continue;
            foreach (var item in arr)
            {
                if (item is not JsonObject obj) continue;
                foreach (var key in UrlKeys)
                {
                    var v = ReadString(obj, key);
                    if (!string.IsNullOrWhiteSpace(v)) return v;
                }
            }
        }
        return null;
    }

    /// <summary>
    /// 只回地址的产物没有外链，就按类型反推站内深链。
    ///
    /// 三种形态都是仓库里真实在用的，不是我编的：
    ///   store     → `/document-store?store={id}`（DocumentStorePage 的 ?store= 深链）
    ///   entry     → `/document-store?store={storeId}&entry={id}`
    ///               —— parseDocumentStoreDeepLink 只在 store 存在时才读 entry，所以缺 storeId 就不给链接
    ///   workspace → `/literary-agent/{id}`（LiteraryAgentWorkspaceListPage 就是这么跳的）
    ///
    /// workspace 这一支依赖一个当前成立的事实：只有文学创作的开放接口会在响应里回 workspaceId
    ///（视觉创作那边 workspaceId 只在服务端内部用、不回给调用方）。哪天有别的场景开始回它，
    /// 这条映射就得跟着分场景，否则会把用户送到一个空白的文学工作区。
    ///
    /// 认不出来的（如还没跑完的生图 run）**不编地址**：给一个点开是 404 的按钮比没有按钮更糟。
    /// </summary>
    private static string? BuildInternalRoute(string? kind, string? id, JsonObject data)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        switch (kind)
        {
            case "store":
                return $"/document-store?store={Uri.EscapeDataString(id)}";
            case "entry":
            {
                var storeId = ReadString(data, "storeId");
                return string.IsNullOrWhiteSpace(storeId)
                    ? null
                    : $"/document-store?store={Uri.EscapeDataString(storeId)}&entry={Uri.EscapeDataString(id)}";
            }
            case "workspace":
                return $"/literary-agent/{Uri.EscapeDataString(id)}";
            default:
                return null;
        }
    }

    private static JsonObject? ReadDataObject(string? responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody)) return null;
        try
        {
            if (JsonNode.Parse(responseBody) is not JsonObject root) return null;
            // 平台统一响应体是 { success, data }；也兼容直接返回对象的接口
            return root["data"] as JsonObject ?? root;
        }
        catch { return null; }
    }

    private static string? ReadString(JsonObject obj, string key)
        => obj.TryGetPropertyValue(key, out var node) && node is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s)
            ? s
            : null;

    private static string Trim(string s) => s.Length > 300 ? s[..300] + "…" : s;

    /// <summary>
    /// 认出了 <c>error.message</c> 的形状，不等于那段字就能端给用户看。
    ///
    /// 这条路上的下游是**登记表里的动态接口**，谁登记的谁决定它回什么。它完全可以在
    /// <c>error.message</c> 里塞一整段异常、上游供应商的原文、内部端点地址，甚至连着凭据 ——
    /// 而这段字会原样存进 <c>McpCallLog.ErrorMessage</c>，再由接入台端给**普通 access 级**用户看。
    /// 上一版只按「形状认得出来」就放行，等于把「结构合法」当成了「内容安全」。
    ///
    /// 所以再过一道：像人话的短句照原样给；一看就是堆栈、错误页或带凭据的，
    /// 一律换成固定那句，原文只进服务端日志（调用方自己那一侧本来就拿得到真实响应）。
    /// 宁可退化成一句稳定的说明，也不把内部细节送上面板。
    /// </summary>
    internal static string UserFacing(string message)
        => LooksUserSafe(message) ? Trim(message) : UnrecognizedFailure;

    /// <summary>判据只此一处：多行/超长/带堆栈标志/带凭据形状/带地址的，都不算给人看的话。</summary>
    internal static bool LooksUserSafe(string message)
    {
        var s = message.Trim();
        if (s.Length == 0 || s.Length > 300) return false;
        // 多行几乎只有两种来源：堆栈和 HTML 错误页。用户面的一句话不需要换行。
        if (s.Contains('\n') || s.Contains('\r')) return false;
        foreach (var marker in LeakMarkers)
            if (s.Contains(marker, StringComparison.OrdinalIgnoreCase))
                return false;
        return true;
    }

    /// <summary>
    /// 一出现就判定「这不是给用户看的话」的标志。分三类：
    /// 堆栈与错误页（说明这是异常原文而不是提示语）、凭据形状（绝不能上面板）、
    /// 地址（下游的内部端点；用户对它无从下手，管理员看日志即可）。
    /// </summary>
    private static readonly string[] LeakMarkers =
    {
        "exception", "traceback", "stack trace", "stacktrace", " at ", "system.", "<html", "<!doctype",
        "bearer ", "authorization", "api_key", "apikey", "api-key", "password", "secret", "token=", "sk-",
        "http://", "https://",
    };
}
