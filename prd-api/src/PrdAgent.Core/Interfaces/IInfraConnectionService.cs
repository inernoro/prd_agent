using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 基础设施连接管理服务（MAP 端）。详见 spec.cds-map-pairing-protocol。
/// </summary>
public interface IInfraConnectionService
{
    /// <summary>
    /// 用户从 CDS 复制密钥后粘贴：解析剪贴板 → 调对端 accept → 加密落库。
    /// 返回脱敏视图（不含明文 LongToken）。
    /// </summary>
    Task<InfraConnectionPublicView> PasteAsync(string clipboardText, string userId, CancellationToken ct);

    /// <summary>列表（脱敏视图）</summary>
    Task<List<InfraConnectionPublicView>> ListAsync(CancellationToken ct);

    /// <summary>取单条脱敏视图</summary>
    Task<InfraConnectionPublicView?> GetAsync(string id, CancellationToken ct);

    /// <summary>
    /// 获取原始实体（含密文 LongToken）。供 ClaudeSidecarRouter / DynamicSidecarRegistry
    /// 等内部消费方使用，禁止经 Controller 直接外露。
    /// </summary>
    Task<InfraConnection?> GetRawAsync(string id, CancellationToken ct);

    /// <summary>
    /// 解密 LongToken 明文。失败时把 connection.status 标 revoked 兜底，并返回 null。
    /// </summary>
    Task<string?> TryUnprotectLongTokenAsync(string id, CancellationToken ct);

    /// <summary>删除（不联动对端 revoke，由对端自身过期机制兜底）</summary>
    Task<bool> DeleteAsync(string id, CancellationToken ct);

    /// <summary>探活：GET 对端 InstanceDiscoveryUrl，刷新 LastProbedAt/LastProbeOk/LastProbeError。</summary>
    Task<InfraConnectionPublicView?> ProbeAsync(string id, CancellationToken ct);
}

/// <summary>
/// 脱敏后的 InfraConnection 视图（API 响应 / UI 列表用）。
/// 严格不含 LongTokenEncrypted。
/// </summary>
public record InfraConnectionPublicView(
    string Id,
    string Partner,
    string PartnerName,
    string PartnerId,
    string PartnerBaseUrl,
    string ProjectId,
    string InstanceDiscoveryUrl,
    IReadOnlyList<string> Scopes,
    string Status,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    DateTime? LastProbedAt,
    bool? LastProbeOk,
    string? LastProbeError,
    DateTime LongTokenExpiresAt
);

/// <summary>InfraConnection 协议错误码（spec §3.3）。</summary>
public static class InfraConnectionErrorCodes
{
    public const string ClipboardInvalidFormat = "clipboard_invalid_format";
    public const string ClipboardVersionNotSupported = "clipboard_version_not_supported";
    public const string PairingTokenExpired = "pairing_token_expired";
    public const string PairingTokenUsed = "pairing_token_used";
    public const string PairingTokenNotFound = "pairing_token_not_found";
    public const string ConnectionDuplicate = "connection_duplicate";
    public const string CdsUnreachable = "cds_unreachable";
    public const string AcceptResponseInvalid = "accept_response_invalid";
    public const string ConnectionNotFound = "connection_not_found";
    public const string TokenUnprotectFailed = "token_unprotect_failed";
}

/// <summary>InfraConnection 协议异常 —— Controller 统一捕获并按 HttpStatus + ErrorCode 返回。</summary>
public class InfraConnectionException : Exception
{
    public string ErrorCode { get; }
    public int HttpStatus { get; }

    public InfraConnectionException(string errorCode, string message, int httpStatus = 400)
        : base(message)
    {
        ErrorCode = errorCode;
        HttpStatus = httpStatus;
    }
}
