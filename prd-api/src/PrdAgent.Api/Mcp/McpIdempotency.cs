using System.Security.Claims;

namespace PrdAgent.Api.Mcp;

/// <summary>
/// 智能体给的 clientRequestId 怎么变成幂等键 —— 唯一判定源。
///
/// 原来这段判断在三个开放层控制器里各抄了一份（视觉 / 知识库 / 网页托管），
/// 于是它按 predicate-and-wiring-discipline.md 形状 3 漂了：同一个「截到 120 字」
/// 的缺陷同时活在三处，Codex 只在其中一处发现它。收敛到这里之后，各控制器只负责
/// 拼自己那截前缀或作用域，不再各自决定怎么归一化。
///
/// **不截断**是这里的关键决定：下游要么再做一次 SHA-256（确定性 id），要么把整串
/// 存进 SourceRef 逐字比对，长度本来就不构成问题；而截断会让「前 120 字相同、
/// 后面不同」的两个合法幂等键压成同一个，第二次写入被报成幂等命中、悄悄不做 ——
/// 调用方拿到 success 却什么都没写，是这套接口里最难查的一类错。
/// </summary>
internal static class McpIdempotency
{
    /// <summary>取签发这次调用的那把密钥的 id；拿不到时用一个稳定的占位值。</summary>
    internal static string KeyIdOf(ClaimsPrincipal? user)
        => user?.FindFirst("agentApiKeyId")?.Value ?? "unknown";

    /// <summary>
    /// 归一化调用方给的幂等键：去掉首尾空白，全空白或没给则返回 null（= 不做幂等）。
    /// 不做长度截断，理由见类型注释。
    /// </summary>
    internal static string? Normalize(string? clientRequestId)
        => string.IsNullOrWhiteSpace(clientRequestId) ? null : clientRequestId.Trim();

    /// <summary>
    /// 归一化并带上密钥 id：两把密钥用了同一个 clientRequestId 时互不干扰。
    /// 返回 `{keyId}:{归一化后的键}`；没给幂等键则返回 null。
    /// </summary>
    internal static string? ScopedByKey(ClaimsPrincipal? user, string? clientRequestId)
    {
        var raw = Normalize(clientRequestId);
        return raw == null ? null : $"{KeyIdOf(user)}:{raw}";
    }
}
