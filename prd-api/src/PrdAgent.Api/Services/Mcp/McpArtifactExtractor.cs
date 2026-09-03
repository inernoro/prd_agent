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
                    if (!string.IsNullOrWhiteSpace(msg)) return Trim(msg);
                }
                var top = ReadString(root, "message");
                if (!string.IsNullOrWhiteSpace(top)) return Trim(top);
            }
        }
        catch { /* 不是 JSON 就退回原文截断 */ }
        return Trim(responseBody);
    }

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
}
