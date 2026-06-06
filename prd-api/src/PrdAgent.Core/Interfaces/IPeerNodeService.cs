using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 系统级跨节点互传的节点身份与 HMAC 鉴权服务。详见 doc/design.peer-sync.md §5.1。
/// </summary>
public interface IPeerNodeService
{
    /// <summary>取本节点稳定标识（复用 AppSettings.MapInstanceId，首次惰性生成）。</summary>
    Task<string> GetSelfNodeIdAsync(CancellationToken ct = default);

    /// <summary>生成 HMAC 签名头：返回 (ts, sign)。body 为已序列化的请求体（无则空串）。</summary>
    (string ts, string sign) Sign(string sharedSecret, string method, string path, string body);

    /// <summary>校验对端请求签名（时间戳偏移超 maxSkew 拒绝，防重放）。</summary>
    bool Verify(string sharedSecret, string method, string path, string body, string ts, string sign);
}
