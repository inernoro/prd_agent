namespace PrdAgent.Core.Models;

/// <summary>
/// 一次「从另一台 MAP 拉数据」的执行记录（本站作为目标站时使用）。
///
/// 一条 Run 跑一次，跑完即终态；要再同步必须重新走一次授权跳转。这是产品约束
/// 不是技术限制：动态授权的意义就在于「批准的是这一次」，如果一次批准能复用，
/// 那它和长期凭据没有区别。
///
/// **唯一的例外：试跑之后可以就地转正成一次真跑**（<see cref="PromotedToRunId"/>）。
/// 原来的规则是「一次授权 = 一条 Run」，于是「看一眼会搬什么」这个动作要花掉一次批准，
/// 真搬得让人再点一次同意——2026-08-21 的两次真实迁移都卡死在这一步，
/// 第二次同意点不了，4 万多条数据读得出来却写不进去。
///
/// 转正不等于「批准可复用」：搬的是**同一批数据**（范围在试跑时就已冻结，不再重新
/// 询问源站）、同一张票（还带着原来的两小时硬过期）、且**至多一次**。
/// 试跑本来就不写任何东西，把它算成一次消耗才是当初没想清楚的地方。
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
    /// 对照表上真实展示过的集合清单，由 Plan 写入；执行只跑这一份。
    ///
    /// 为什么不直接用 <see cref="Collections"/>：对照表是操作者唯一一次看清「要写什么」的
    /// 机会，所以**屏幕上看到的必须等于实际会写的**。源站与目标站版本错位时，源站清单里
    /// 可能少了某个已授权的集合；若执行仍按授权清单跑，没出现在屏幕上的集合照样被写进库，
    /// 那道确认关口就形同虚设。空 = 还没看过对照表，此时不允许开始。
    /// </summary>
    public List<string> PlannedCollections { get; set; } = new();

    /// <summary>
    /// 对照表上源站报的那份契约，逐集合固化：总条数 + 源站会清空哪些字段。key 为集合名。
    ///
    /// 这两样都是**只有源站知道**的事实，清单里已经送过来、对照表上也显示过，
    /// 原来却在渲染完那一屏之后就丢掉了，于是下游各自出问题：
    /// 进度里的 sourceTotal 永远是 0（字段声明着「manifest 阶段拿到」却从没人赋值），
    /// 而脱敏处理全部退回按**目标站**的白名单算——两边名单不一致时，只被源站列为敏感的
    /// 字段送到就是空的，本站认不出它：待补清单不报，覆盖模式下也不接回，
    /// 于是本站一份能用的凭据被源站的空值顶掉，还没有任何提示。
    ///
    /// 与 <see cref="PlannedCollections"/> 同一次条件更新写入，两者不会各自漂移。
    /// 空 = 存量 Run（本字段落地之前建的），下游按老语义退回目标站白名单。
    /// </summary>
    public Dictionary<string, DataSyncPlannedCollection> PlannedManifest { get; set; } = new();

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

    /// <summary>
    /// 这次试跑转正成的那条真跑。**同一条 Run 只能转正一次**，靠「这个字段还是空的」
    /// 做条件更新来保证——两个标签页同时点、或者手快点两下，都只会有一条真跑。
    ///
    /// 非空还意味着这张票已经交给那条真跑了，本条不能再转正。
    /// </summary>
    public string? PromotedToRunId { get; set; }

    /// <summary>这条真跑是从哪次试跑转正来的。用来在界面上把两条串成一次操作。</summary>
    public string? PromotedFromRunId { get; set; }

    public string? Error { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? FinishedAt { get; set; }
}

/// <summary>源站在清单里报的、关于某个集合的那份事实。只有源站知道，本站算不出来。</summary>
public class DataSyncPlannedCollection
{
    /// <summary>源站上报的总条数</summary>
    public long SourceTotal { get; set; }

    /// <summary>源站会在出口清空的字段（已按本次授权条件算过生效值）</summary>
    public List<string> RedactFields { get; set; } = new();
}

public class DataSyncCollectionProgress
{
    /// <summary>源站上报的总数（manifest 阶段拿到）</summary>
    public long SourceTotal { get; set; }

    /// <summary>已拉取的文档数</summary>
    public long Fetched { get; set; }

    /// <summary>
    /// **实际**写入的新文档数。试跑时恒为 0——把「打算写」记成「写了」，
    /// 会让一次只统计的试跑在界面上显示「写入 N 条」，那是在对操作者说谎。
    /// </summary>
    public long Inserted { get; set; }

    /// <summary>因本地已存在同 Id 而跳过的数量</summary>
    public long Skipped { get; set; }

    /// <summary>**实际**覆盖更新的数量。试跑时恒为 0，理由同 <see cref="Inserted"/>。</summary>
    public long Updated { get; set; }

    /// <summary>真跑将会新增的条数。试跑靠它给出「预计新增」，真跑时与 Inserted 相等。</summary>
    public long PlannedInsert { get; set; }

    /// <summary>真跑将会覆盖的条数。试跑靠它给出「预计覆盖」，真跑时与 Updated 相等。</summary>
    public long PlannedUpdate { get; set; }

    /// <summary>
    /// 已改写成本站地址的资产字段数。
    ///
    /// 附件搬的只有元数据，地址是**源站**的绝对地址。不改的话，两站不共用同一个桶
    /// （或公网前缀不同）时，同步过来的图片、录音、导出文件全部指回源站。
    /// </summary>
    public long AssetUrlsRebased { get; set; }

    /// <summary>
    /// 是绝对地址、却认不出对象 key，只能原样留着的资产字段数。
    ///
    /// **这几条就是搬完之后仍然可能打不开的**。单独计数而不是并进上面那个：
    /// 「改了 N 条」和「还有 M 条没救」是两件事，混成一个数字等于把缺口藏起来。
    /// </summary>
    public long AssetUrlsUnresolved { get; set; }

    /// <summary>断点续传游标：上一批最后一个 _id 的扩展 JSON 表示</summary>
    public string? Cursor { get; set; }

    /// <summary>true = 这个集合已经拉完</summary>
    public bool Done { get; set; }
}
