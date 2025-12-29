namespace PrdAgent.Core.Models;

/// <summary>
/// 上传/生成产物索引（Mongo 只存引用与元数据；大内容存 COS）。
/// - 通过 requestId 与 LlmRequestLog.RequestId 关联，用于后台“图片预览”。
/// </summary>
public class UploadArtifact
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 关联 LLM 请求日志：LlmRequestLog.RequestId
    /// </summary>
    public string RequestId { get; set; } = string.Empty;

    /// <summary>
    /// input_image / output_image（全部小写）
    /// </summary>
    public string Kind { get; set; } = "output_image";

    /// <summary>
    /// 审计字段：创建该记录的管理员（可见性仍为 ADMIN 全局）
    /// </summary>
    public string CreatedByAdminId { get; set; } = string.Empty;

    public string? Prompt { get; set; }

    /// <summary>
    /// 当 output 有多张参考图时，记录 input artifacts 的 id 列表（用于 UI 胶片栏）。
    /// </summary>
    public List<string>? RelatedInputIds { get; set; }

    public string Sha256 { get; set; } = string.Empty;
    public string Mime { get; set; } = "image/png";
    public int Width { get; set; }
    public int Height { get; set; }
    public long SizeBytes { get; set; }

    /// <summary>
    /// COS 可访问 URL（稳定，不是临时签名 URL）
    /// </summary>
    public string CosUrl { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}


