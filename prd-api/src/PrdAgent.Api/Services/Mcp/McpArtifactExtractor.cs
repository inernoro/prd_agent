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

    public static Artifact Extract(string toolName, string? responseBody)
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

        // 读类工具即使带 id 也不算产物：产物是「这次做出来的东西」，不是「这次看了的东西」
        if (kind != null && toolName.Contains("_get_", StringComparison.Ordinal) && kind != "image-run")
            return new Artifact(null, null, null, null);

        string? url = null;
        foreach (var key in UrlKeys)
        {
            url = ReadString(data, key);
            if (!string.IsNullOrWhiteSpace(url)) break;
        }

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
