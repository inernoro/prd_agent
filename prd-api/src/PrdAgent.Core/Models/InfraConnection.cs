namespace PrdAgent.Core.Models;

/// <summary>
/// 基础设施连接（MAP 端持久化形态）。
///
/// 通过 spec.cds-map-pairing-protocol（剪贴板配对密钥）与外部部署平台
/// （CDS / 未来的 k8s / nomad / agent-cli 等）建立双向信任连接。配对完成
/// 后，本系统通过 LongTokenEncrypted（IDataProtector 加密）调用对端 API。
///
/// - 明文 LongToken 不出库；只存 IDataProtector 密文
/// - PartnerId / PartnerBaseUrl 由对端在 accept 阶段返回，配对后即固定
/// - Status 仅 active / revoked / unreachable 三态；系统级长期授权不按时间自动过期，
///   只有显式删除、撤销或本地密钥无法解密才会失效
/// </summary>
public class InfraConnection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>对端类型："cds" | 未来 "k8s" / "nomad" / "agent-cli"</summary>
    public string Partner { get; set; } = "cds";

    /// <summary>对端显示名（来自 accept 响应或剪贴板 cdsName）</summary>
    public string PartnerName { get; set; } = string.Empty;

    /// <summary>对端实例稳定 ID（来自剪贴板 cdsId）</summary>
    public string PartnerId { get; set; } = string.Empty;

    /// <summary>对端公开访问 URL（来自剪贴板 cdsBaseUrl）</summary>
    public string PartnerBaseUrl { get; set; } = string.Empty;

    /// <summary>IDataProtector 加密的长效 token，明文不出库。</summary>
    public string LongTokenEncrypted { get; set; } = string.Empty;

    /// <summary>长效 token 过期时间。系统级长期授权使用远未来时间，仅用于 UI 展示。</summary>
    public DateTime LongTokenExpiresAt { get; set; }

    /// <summary>对端给本 MAP 创建的 shared-service 项目 ID</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>实例发现 URL（相对路径，需拼接 PartnerBaseUrl）</summary>
    public string InstanceDiscoveryUrl { get; set; } = string.Empty;

    /// <summary>这条连接允许调用的能力 scope 列表</summary>
    public List<string> Scopes { get; set; } = new();

    /// <summary>active | revoked | unreachable</summary>
    public string Status { get; set; } = "active";

    /// <summary>创建/绑定本连接的用户 ID（调用方）</summary>
    public string CreatedByUserId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>最近一次健康探测时间（GET InstanceDiscoveryUrl）</summary>
    public DateTime? LastProbedAt { get; set; }

    /// <summary>最近一次探测是否成功；null 表示从未探测</summary>
    public bool? LastProbeOk { get; set; }

    /// <summary>最近一次探测错误描述（探测成功时 null）</summary>
    public string? LastProbeError { get; set; }
}
