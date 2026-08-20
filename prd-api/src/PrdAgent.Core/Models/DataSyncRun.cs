namespace PrdAgent.Core.Models;

/// <summary>
/// 一次「从另一台 MAP 拉数据」的执行记录（本站作为目标站时使用）。
///
/// 一次授权对应一条 Run，跑完即终态；要再同步必须重新走一次授权跳转。这是产品约束
/// 不是技术限制：动态授权的意义就在于「批准的是这一次」，如果一次批准能复用，
/// 那它和长期凭据没有区别。
/// </summary>
public class DataSyncRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>发起这次同步的本站管理员</summary>
    public string OperatorUserId { get; set; } = string.Empty;

    /// <summary>源站根地址，如 https://map.example.com</summary>
    public string SourceOrigin { get; set; } = string.Empty;

    /// <summary>源站自报的站点名，仅用于界面展示</summary>
    public string SourceLabel { get; set; } = string.Empty;

    /// <summary>本次获批的分组 key</summary>
    public List<string> Groups { get; set; } = new();

    /// <summary>本次要拉的集合，按获批分组展开后固化——避免源站白名单中途变化导致范围漂移</summary>
    public List<string> Collections { get; set; } = new();

    /// <summary>
    /// 导出令牌的散列。明文只在换取时短暂存在于内存并随请求发出，落库的永远是散列，
    /// 这样即使有人拿到这条 Run 记录也重放不了导出。
    /// </summary>
    public string ExportTokenHash { get; set; } = string.Empty;

    public DateTime ExportTokenExpiresAt { get; set; }

    /// <summary>pending / running / succeeded / failed / cancelled</summary>
    public string Status { get; set; } = "pending";

    /// <summary>true = 只统计不写库</summary>
    public bool DryRun { get; set; }

    /// <summary>true = 同 Id 文档以源站为准覆盖；false（默认）= 跳过已存在的</summary>
    public bool OverwriteExisting { get; set; }

    /// <summary>每个集合的进度。key 为集合名。</summary>
    public Dictionary<string, DataSyncCollectionProgress> Progress { get; set; } = new();

    /// <summary>被源站清空、需要在本站手工补填的字段：集合名 -> 字段名列表</summary>
    public Dictionary<string, List<string>> PendingSecretFields { get; set; } = new();

    public string? Error { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? FinishedAt { get; set; }
}

public class DataSyncCollectionProgress
{
    /// <summary>源站上报的总数（manifest 阶段拿到）</summary>
    public long SourceTotal { get; set; }

    /// <summary>已拉取的文档数</summary>
    public long Fetched { get; set; }

    /// <summary>实际写入的新文档数</summary>
    public long Inserted { get; set; }

    /// <summary>因本地已存在同 Id 而跳过的数量</summary>
    public long Skipped { get; set; }

    /// <summary>覆盖模式下更新的数量</summary>
    public long Updated { get; set; }

    /// <summary>断点续传游标：上一批最后一个 _id 的扩展 JSON 表示</summary>
    public string? Cursor { get; set; }

    /// <summary>true = 这个集合已经拉完</summary>
    public bool Done { get; set; }
}
