using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

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
    /// 把归一化后的幂等键压成 32 位十六进制指纹（与随机 id 同形）。传 null 原样返回 null。
    ///
    /// 为什么必须过这一道：`clientRequestId` 是调用方给的**无界**字符串，nginx 那层收到 30MB body
    /// 都算合法。凡是把它落进 Mongo 的路径（确定性文档 id、`SourceRef`、`IdempotencyKey`），
    /// 原样存就等于让调用方决定文档大小 —— 一个超长键就能把文档撑大甚至顶破 16MB 上限，
    /// 让一次本来合法的写入在插入时炸。哈希同时保住「长键互不坍缩」：截断会把
    /// 「前 N 字相同、后面不同」的两个键压成同一个，第二次写入被报成幂等命中、悄悄不做。
    ///
    /// 这四个开放层原来各写了一份 SHA-256（网页托管内联、知识库 DeterministicId、
    /// 文学 Sha256Hex），而视觉创作那一路**一份都没有** —— 判据分裂之后漏掉的那个兄弟
    /// （predicate-and-wiring-discipline 形状 3）。收敛到这里，让后来者没有第二个口径可走偏。
    /// </summary>
    internal static string? Fingerprint(string kind, string? scopedKey)
        => scopedKey == null
            ? null
            : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{kind}:{scopedKey}")))
                .ToLowerInvariant()[..32];

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
