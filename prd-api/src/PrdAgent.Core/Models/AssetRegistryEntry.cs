namespace PrdAgent.Core.Models;

/// <summary>
/// 资产登记簿：每次存储写入/删除操作自动登记，用于未来跨存储迁移和系统/用户资源分离。
/// </summary>
public class AssetRegistryEntry
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>操作类型：write / delete</summary>
    public string Operation { get; set; } = "write";

    /// <summary>存储 Provider（tencentCos / cloudflareR2）</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>对象 key（含 prefix，如 data/visual-agent/img/xxx.png）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>SHA256（content-addressed 存储的去重标识）</summary>
    public string? Sha256 { get; set; }

    /// <summary>公开访问 URL</summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>业务领域（visual-agent / prd-agent / watermark 等）</summary>
    public string? Domain { get; set; }

    /// <summary>资源类型（img / doc / font / audio / video / log 等）</summary>
    public string? Type { get; set; }

    /// <summary>MIME 类型</summary>
    public string? Mime { get; set; }

    /// <summary>文件大小（字节）</summary>
    public long SizeBytes { get; set; }

    /// <summary>
    /// 资源归属范围：
    /// - system: 系统级（默认头像、内置字体、桌面皮肤）
    /// - user: 用户生成（上传的图片/文档/附件/自定义字体）
    /// - generated: AI 生成（生图/生视频/AI 报告）
    /// - log: 日志/审计（LLM 日志、错误日志）
    /// </summary>
    public string Scope { get; set; } = "user";

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
