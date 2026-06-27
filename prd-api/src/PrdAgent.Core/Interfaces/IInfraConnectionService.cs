using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 基础设施连接管理服务（MAP 端）。详见 spec.cds.map-pairing-protocol。
/// </summary>
public interface IInfraConnectionService
{
    /// <summary>
    /// 用户从 CDS 复制密钥后粘贴：解析剪贴板 → 调对端 accept → 加密落库。
    /// 返回脱敏视图（不含明文 LongToken）。
    /// </summary>
    Task<InfraConnectionPublicView> PasteAsync(string clipboardText, string userId, CancellationToken ct);

    /// <summary>
    /// OAuth-like CDS 连接：根据用户输入的 CDS 地址生成跳转授权 URL。
    /// state 为短期签名令牌，callback 时用于防串改和恢复 cdsBaseUrl。
    /// </summary>
    Task<CdsAuthorizationStartView> StartCdsAuthorizationAsync(string cdsBaseUrl, string mapBaseUrl, string userId, CancellationToken ct);

    /// <summary>
    /// OAuth-like CDS 连接：CDS 授权后回跳 MAP，MAP 用 code 换 longToken 并加密落库。
    /// </summary>
    Task<InfraConnectionPublicView> CompleteCdsAuthorizationAsync(string code, string state, string userId, CancellationToken ct);

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
    /// 解密 LongToken 明文。失败只返回 null，不修改连接状态。
    /// 连接状态只允许由用户显式探活或授权流程更新，避免后台读取把新授权连接误标坏。
    /// </summary>
    Task<string?> TryUnprotectLongTokenAsync(string id, CancellationToken ct, bool revokeOnFailure = true);

    /// <summary>
    /// 自愈：若连接被标记为 revoked，但本地长期凭据仍能成功解密（说明授权本身有效，
    /// 多半是 DataProtection key 轮换/环境重建导致的误吊销），则把状态恢复为 active 并返回 true。
    /// 用于「授权一次即可」——避免一次解密抖动逼用户反复重新授权。
    /// </summary>
    Task<bool> TryReactivateIfTokenValidAsync(string id, CancellationToken ct);

    /// <summary>删除本地系统级授权。long token 不按时间自动过期，删除即停止本系统继续使用。</summary>
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

public record CdsAuthorizationStartView(
    string AuthorizeUrl,
    string State,
    string CdsBaseUrl,
    DateTime ExpiresAt
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
    public const string CdsBaseUrlInvalid = "cds_base_url_invalid";
    public const string AuthorizationStateInvalid = "authorization_state_invalid";
    public const string AuthorizationCodeInvalid = "authorization_code_invalid";
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
