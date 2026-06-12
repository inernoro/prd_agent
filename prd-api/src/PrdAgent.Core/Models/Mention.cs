namespace PrdAgent.Core.Models;

/// <summary>
/// 通用「@ 账本」：记录任意实体之间的引用关系。
///
/// 设计目标：双链 + 反向链接是平台能力，不绑定文档空间。任意未来新增实体
/// （缺陷、PR、周报、工作流、涌现节点 ...）登记自己的类型即可获得双链能力。
///
/// MVP（2026-06-11）：仅支持 document → document，FromType/ToType 限定为
/// MentionEntityType.Document；后续扩展只需新增类型常量 + 在 GraphService 注册
/// 对应实体的解析器。
///
/// 与 DocumentInlineComment 的区别：
/// - InlineComment：评论作用在选中字符片段上，是「人对文本的反馈」
/// - Mention：A 文档引用了 B 文档，是「文档之间的关系」
/// </summary>
public class Mention
{
    /// <summary>主键</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>引用源实体类型（如 "document"）</summary>
    public string FromType { get; set; } = string.Empty;

    /// <summary>引用源实体 ID（如 DocumentEntry.Id）</summary>
    public string FromId { get; set; } = string.Empty;

    /// <summary>被引用实体类型（如 "document"）</summary>
    public string ToType { get; set; } = string.Empty;

    /// <summary>被引用实体 ID（如 DocumentEntry.Id）</summary>
    public string ToId { get; set; } = string.Empty;

    /// <summary>用户在源中看到的字面文本（如 "知识库设计文档"，用于反向链接展示）</summary>
    public string AnchorText { get; set; } = string.Empty;

    /// <summary>引用所在的上下文（前后约 60 字符，反向链接面板高亮展示用）</summary>
    public string Context { get; set; } = string.Empty;

    /// <summary>
    /// 所属作用域（MVP：知识库 ID）。
    /// 用于按作用域查询全图（如「这个库的宇宙图」），跨库引用时该字段对应源所在库。
    /// </summary>
    public string? ScopeId { get; set; }

    /// <summary>
    /// 是否 AI 自动识别。
    /// - false：用户显式 [[xxx]] 标注
    /// - true：保存时 AI 服务端补链（保存正文不改、只补账本）
    /// </summary>
    public bool IsAutoDetected { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Mention 支持的实体类型常量</summary>
public static class MentionEntityType
{
    /// <summary>知识库文档条目（DocumentEntry）</summary>
    public const string Document = "document";
}
