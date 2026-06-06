namespace PrdAgent.Core.Models;

/// <summary>
/// 文档空间（文档存储容器）
/// </summary>
public class DocumentStore
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>空间名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>空间描述</summary>
    public string? Description { get; set; }

    /// <summary>创建者 UserId</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>来源应用标识（可选绑定，如 prd-agent / literary-agent）</summary>
    public string? AppKey { get; set; }

    /// <summary>标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>可管理的分类清单（知识库一等维度；条目的 Category 取自此列表。空=未启用分类）</summary>
    public List<string> Categories { get; set; } = new();

    /// <summary>是否公开（其他用户可浏览）</summary>
    public bool IsPublic { get; set; }

    /// <summary>
    /// 分享到的团队 ID 列表 —— 出现在这些团队的「知识库」团队视图里。
    /// 空列表表示纯个人空间（个人路径不受影响）。仅知识库模块消费此字段。
    /// 与 OwnerId（我的）、IsPublic（app 级公开）是三条独立的访问轴。
    /// </summary>
    public List<string> SharedTeamIds { get; set; } = new();

    /// <summary>主文档条目 ID（进入空间时默认展示的文档，类似 GitHub README）</summary>
    public string? PrimaryEntryId { get; set; }

    /// <summary>置顶条目 ID 列表（多个文档可置顶，影响排序）</summary>
    public List<string> PinnedEntryIds { get; set; } = new();

    /// <summary>用户自定义 tag 颜色映射（tagName → 调色板 key：red/orange/yellow/green/teal/blue/purple/gray）。
    /// 缺省时前端按 tag 名哈希自动分色。详见 prd-admin/src/lib/tagPalette.ts。</summary>
    public Dictionary<string, string> TagColors { get; set; } = new();

    /// <summary>空间内文档数量（冗余计数，便于列表展示）</summary>
    public int DocumentCount { get; set; }

    /// <summary>点赞数（冗余计数，便于列表排序）</summary>
    public int LikeCount { get; set; }

    /// <summary>查看次数（冗余计数）</summary>
    public int ViewCount { get; set; }

    /// <summary>收藏数（冗余计数）</summary>
    public int FavoriteCount { get; set; }

    /// <summary>封面图 URL（公开知识库展示用）</summary>
    public string? CoverImageUrl { get; set; }

    /// <summary>
    /// 知识库模板键（null = 普通库，不做结构约束）。
    /// 非空时，写入条目会按 AcceptanceTemplateRegistry 对应模板校验必填 metadata / 正文 section。
    /// 当前内置：acceptance-report-v2（验收报告）。
    /// </summary>
    public string? TemplateKey { get; set; }

    /// <summary>
    /// 绑定的 PM 项目 ID（非空表示这是某个项目的「项目知识库」）。
    /// 非空时访问控制走「项目成员」判定，而非个人/团队三轴；并从个人/公开列表中隐藏。
    /// </summary>
    public string? PmProjectId { get; set; }

    /// <summary>
    /// 跨环境同步令牌（永久有效，null = 尚未开启远端同步）。
    /// 远端环境凭此令牌调用本环境的 sync 端点读写本库；仅放行本库，撤销链接时清空。
    /// 详见 DocumentStoreSyncController。
    /// </summary>
    public string? SyncToken { get; set; }

    /// <summary>
    /// 绑定的产品管理对象（product-agent），格式 "product:{id}" 或 "version:{id}"。
    /// 非空表示这是某产品/版本的知识库（整体库 / 版本库），从个人/公开列表中隐藏，
    /// 只在 product-agent 对应 tab 内访问。
    /// </summary>
    public string? ProductKnowledgeRef { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
