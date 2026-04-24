using MongoDB.Bson;

namespace PrdAgent.Core.Models;

/// <summary>
/// 外部授权记录（TAPD / 语雀 / GitHub 等第三方系统的授权凭证聚合）。
///
/// 用途：将散落在各处的外部系统授权凭证收拢到统一入口，方便用户查看、管理、撤销。
/// - 每条记录属于一个用户（个人级，P0 不做团队共享）
/// - 凭证字段加密存储（CredentialsEncrypted），API 返回时脱敏
/// - 工作流通过 authId 引用本记录，运行时通过内部接口解密取凭证
///
/// 详见 doc/design.external-authorization.md
/// </summary>
public class ExternalAuthorization
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>授权类型 key：tapd / yuque / github</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>用户自取的显示名称（如"生产 TAPD 账号"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 加密后的凭证 JSON。
    /// 加密前结构示例：
    /// - TAPD: {"cookie":"...", "workspaceIds":["50116108"]}
    /// - 语雀: {"apiToken":"...", "namespace":"user-xxx"}
    /// - GitHub: 引用模式，指向 github_user_connections._id，不落敏感字段
    /// </summary>
    public string CredentialsEncrypted { get; set; } = string.Empty;

    /// <summary>
    /// 展示用的元数据（非敏感）。
    /// 例如 TAPD 的工作空间 ID 列表、语雀的 namespace、GitHub 的 login 等。
    /// </summary>
    public BsonDocument Metadata { get; set; } = new();

    /// <summary>状态：active / expired / revoked</summary>
    public string Status { get; set; } = "active";

    /// <summary>上次验证时间（调用第三方 API 验证凭证有效性）</summary>
    public DateTime? LastValidatedAt { get; set; }

    /// <summary>上次被工作流/其他模块引用时间</summary>
    public DateTime? LastUsedAt { get; set; }

    /// <summary>过期时间（OAuth 可能没有，Cookie 一般有）</summary>
    public DateTime? ExpiresAt { get; set; }

    /// <summary>撤销时间；非 null 即逻辑删除，记录保留用于审计</summary>
    public DateTime? RevokedAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
