using MongoDB.Bson;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 外部授权类型处理器接口。
/// 每种外部系统（TAPD / 语雀 / GitHub 等）实现一个 handler，在 DI 容器注册。
/// </summary>
public interface IAuthTypeHandler
{
    /// <summary>类型 key（tapd / yuque / github）</summary>
    string TypeKey { get; }

    /// <summary>显示名称（用于前端类型下拉）</summary>
    string DisplayName { get; }

    /// <summary>
    /// 凭证字段定义（供前端动态渲染表单）。
    /// 每个字段含 key / label / type (text/password/textarea) / placeholder / required
    /// </summary>
    IReadOnlyList<AuthFieldDefinition> CredentialFields { get; }

    /// <summary>
    /// 验证凭证有效性。调用第三方 API 尝试认证。
    /// </summary>
    Task<AuthValidationResult> ValidateAsync(Dictionary<string, string> credentials, CancellationToken ct);

    /// <summary>
    /// 从凭证中提取展示用的元数据（非敏感）。
    /// 例如从 TAPD Cookie 提取登录用户名和工作空间列表。
    /// </summary>
    Task<BsonDocument> ExtractMetadataAsync(Dictionary<string, string> credentials, CancellationToken ct);

    /// <summary>
    /// 对凭证进行脱敏处理（用于 API 返回给前端）。
    /// 例如 Cookie 显示为 `xxx...***...xxx`。
    /// </summary>
    Dictionary<string, string> MaskCredentials(Dictionary<string, string> credentials);
}

public class AuthFieldDefinition
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Type { get; set; } = "text"; // text / password / textarea
    public string? Placeholder { get; set; }
    public string? HelpText { get; set; }
    public bool Required { get; set; } = true;
}

public class AuthValidationResult
{
    public bool Ok { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public BsonDocument? Metadata { get; set; }

    public static AuthValidationResult Success(BsonDocument? metadata = null, DateTime? expiresAt = null)
        => new() { Ok = true, Metadata = metadata, ExpiresAt = expiresAt };

    public static AuthValidationResult Fail(string reason)
        => new() { Ok = false, ErrorMessage = reason };
}
