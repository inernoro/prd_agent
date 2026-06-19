namespace PrdAgent.Core.Models;

/// <summary>
/// 文档条目历史版本快照（知识库版本控制）。
///
/// 设计要点（吸取「文学创作版本导致图片丢失」的教训）：
/// - 知识库正文里的图片是 markdown 里的外链 URL（COS / 外部地址），不是受版本管理的 image_asset，
///   因此版本快照只存「正文文本」即可，恢复版本 = 把该文本写回当前正文，<b>绝不删除任何资产</b>，
///   图片 URL 始终有效 —— 从机制上杜绝「恢复版本把图片删没了」。
/// - 每条版本是<b>不可变快照</b>：只新增、不原地改；恢复操作本身也会先把当前内容快照成新版本再写回。
/// - 独立集合存储（document_entry_versions），与正文主表解耦，避免单文档膨胀。
/// </summary>
public class DocumentEntryVersion
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属文档条目 ID</summary>
    public string EntryId { get; set; } = string.Empty;

    /// <summary>所属文档空间 ID（便于按库聚合 / 级联清理）</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>版本序号（同一 entry 内自增，从 1 开始；越大越新）</summary>
    public int VersionNumber { get; set; }

    /// <summary>该版本完整正文（markdown / 纯文本）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>正文 SHA256（hex），用于去重，跳过无变化的保存</summary>
    public string ContentHash { get; set; } = string.Empty;

    /// <summary>字符数</summary>
    public int CharCount { get; set; }

    /// <summary>正文 UTF-8 字节数（用于版本存储占用统计）</summary>
    public long SizeBytes { get; set; }

    /// <summary>来源：edit 手动编辑 / restore 版本恢复 / sync 外部同步覆盖 / import 导入</summary>
    public string Source { get; set; } = DocumentVersionSource.Edit;

    /// <summary>当 Source=restore 时，指向被恢复的源版本 Id（便于追溯）</summary>
    public string? RestoredFromVersionId { get; set; }

    /// <summary>创建者（产生该版本的操作者）UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建者显示名（冗余，便于前端直接展示）</summary>
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>版本来源常量</summary>
public static class DocumentVersionSource
{
    /// <summary>用户手动编辑保存</summary>
    public const string Edit = "edit";

    /// <summary>恢复某个历史版本</summary>
    public const string Restore = "restore";

    /// <summary>外部订阅 / GitHub 同步覆盖前的留存快照</summary>
    public const string Sync = "sync";

    /// <summary>导入 / 迁移</summary>
    public const string Import = "import";
}
