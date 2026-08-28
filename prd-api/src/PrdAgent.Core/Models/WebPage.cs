using System.Security.Cryptography;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 托管站点 — 用户上传 HTML/ZIP 或工作流自动生成的可运行网页
///
/// BsonIgnoreExtraElements: schema 演进期间 DB 文档可能出现 model 类还没
/// 同步过来的字段（例如 WrappedAssetType 历史上一度只在脏数据里、最近才在
/// main 正式补回 model），不忽略则反序列化抛 FormatException 让 List 端点 500。
/// 保留这个 attribute 当作未来 schema drift 的常态防御。
/// </summary>
[BsonIgnoreExtraElements]
public class HostedSite
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>站点标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>站点描述</summary>
    public string? Description { get; set; }

    // ── 来源分类 ──

    /// <summary>来源类型：upload | workflow | api</summary>
    public string SourceType { get; set; } = "upload";

    /// <summary>来源引用（如 workflowExecutionId）</summary>
    public string? SourceRef { get; set; }

    // ── COS 存储 ──

    /// <summary>COS 上的目录前缀: web-hosting/sites/{siteId}/</summary>
    public string CosPrefix { get; set; } = string.Empty;

    /// <summary>入口文件名 (默认 index.html)</summary>
    public string EntryFile { get; set; } = "index.html";

    /// <summary>
    /// 自动包装的资产类型（"pdf" / "video" / "markdown" / null=非包装站）。
    /// 当用户上传单个 PDF/视频/Markdown 时，Controller 会现场生成 index.html
    /// 壳子 + 原文件，打包成 ZIP 走托管路径；此字段标记原始资产类型，下游
    /// 据此选直接打开原始文件 URL（避免 sandbox iframe 嵌套被屏蔽）或走
    /// 专用缩略图占位。值由 BuildWrapperZip 调用方写入。
    /// </summary>
    public string? WrappedAssetType { get; set; }

    /// <summary>完整入口 URL (COS public URL + cosPrefix + entryFile)</summary>
    public string SiteUrl { get; set; } = string.Empty;

    /// <summary>站点包含的文件清单</summary>
    public List<HostedSiteFile> Files { get; set; } = new();

    /// <summary>站点总大小 (bytes)</summary>
    public long TotalSize { get; set; }

    // ── 元信息 ──

    /// <summary>用户标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>分类文件夹</summary>
    public string? Folder { get; set; }

    /// <summary>封面图 URL</summary>
    public string? CoverImageUrl { get; set; }

    /// <summary>
    /// PDF 包装站的原始 PDF 直链。不入库（由 CosKey + ContentVersion 算出），只在返回给前端前挂上。
    ///
    /// 存在的理由：上传 .pdf 会被包成「index.html 壳子 + 原 PDF」，壳子用 PDF.js 把 PDF 画成 canvas
    /// （移动端 WebView 在 iframe 里渲染不了 PDF，只能这么做），但壳子依赖第三方 CDN。桌面端要绕开壳子
    /// 直接交给浏览器原生阅读器，就得拿到这个直链。
    ///
    /// 此前它只出现在分享视图的 SharedSiteInfo 上，站内列表拿不到，于是站内大预览的「绕开壳子」
    /// 分支永远走不到——判据在、数据不在（predicate-and-wiring-discipline 形状 2）。
    /// </summary>
    [BsonIgnore]
    public string? PdfAssetUrl { get; set; }

    // ── 所有权 ──

    /// <summary>所属用户 ID</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>
    /// 分享到的团队 ID 列表 —— 出现在这些团队的「网页托管」团队视图里。
    /// 空列表表示纯个人站点（个人路径不受影响）。仅网页托管模块消费此字段。
    /// </summary>
    public List<string> SharedTeamIds { get; set; } = new();

    /// <summary>
    /// 团队空间分组归属（WebPageGroup.Id，专题或日常分类）。
    /// null = 未归入任何分组。仅站点在团队空间内时有意义；个人空间用 Folder 组织。
    /// </summary>
    public string? GroupId { get; set; }

    /// <summary>浏览次数</summary>
    public long ViewCount { get; set; }

    // ── 公开可见性 ──

    /// <summary>
    /// 入口文件是不是一套幻灯片（reveal.js / impress.js / remark / deck.js）。
    ///
    /// 上传/替换时扫一次入口 HTML 的真实签名落库，不是运行时猜的——设计稿把「幻灯片」
    /// 列为五种内容形态之一，而 SlideNavCompatVersion 是无条件盖在所有站点上的垫片版本号，
    /// 不能当 deck 标记用（那是「不成立的证据」）。老数据没有这个字段，前端按 false 处理。
    /// </summary>
    public bool IsSlideDeck { get; set; }

    /// <summary>可见性：private = 仅自己可见 | public = 出现在个人公开页 /u/:username</summary>
    public string Visibility { get; set; } = "private";

    /// <summary>首次设为 public 的时间（用于公开页排序）</summary>
    public DateTime? PublishedAt { get; set; }

    /// <summary>
    /// 是否允许被评论。默认 true（站点天然开放评论），owner 可在站点上关闭。
    ///
    /// 注意：默认值刻意为 true —— Mongo 反序列化老文档（无此字段）时保留初始化器的值，
    /// 因此存量站点会被识别为"允许评论"，符合"网页托管允许被评论"的发布预期。
    /// owner 关闭后写入 false，下游 ListComments / AddComment 据此放行或拒绝。
    /// </summary>
    public bool CommentsEnabled { get; set; } = true;

    // ── 向我提问（访客对着这个页面问 AI） ──

    /// <summary>
    /// 是否开放「向我提问」。默认 **false** —— 与 CommentsEnabled 刻意相反。
    ///
    /// 评论是纯存储、零边际成本，所以默认开；提问每一次都要烧 token 和钱，
    /// 存量站点绝不能因为 Mongo 反序列化老文档（无此字段）就"顺带被打开"。
    /// 初始化器为 false，老文档反序列化后恒为关闭，owner 必须显式打开。
    /// </summary>
    public bool AskEnabled { get; set; }

    /// <summary>提问面板的欢迎语；空则前端用站点标题兜底</summary>
    public string? AskWelcome { get; set; }

    /// <summary>
    /// 站点级开场问题题库 —— owner 在「提问设置」里维护的候选池。
    /// 分享链接可以从这个池子里各自挑几条（见 WebPageShareLink.AskSuggestedQuestions）；
    /// 没挑的链接直接用这里的全量（截前 N 条）。
    /// </summary>
    public List<string> AskSuggestedQuestions { get; set; } = new();

    /// <summary>
    /// 这批开场问题是谁写的。
    ///
    ///   null / "auto" —— 系统读正文自动生成的，内容一换就重算
    ///   "manual"      —— owner 在提问设置里动过手，此后自动生成不再覆盖它
    ///
    /// 没有这个标记的话，owner 精心改的几句会在下次重新上传时被静默冲掉，
    /// 而他根本不知道发生过（改动消失是最难查的一类缺陷）。
    /// </summary>
    public string? AskQuestionsSource { get; set; }

    /// <summary>
    /// 上一次自动生成是针对哪个 ContentVersion 算的。
    ///
    /// 与 ContentVersion 相等就不重跑——一次上传一次调用，正文没变不重算。
    /// 读不出正文（纯视频包装站等）时也会盖上这个戳，否则每次有人打开页面
    /// 都要为一个永远读不出正文的站点重试一遍。
    /// </summary>
    public DateTime? AskQuestionsGeneratedFor { get; set; }

    /// <summary>是否允许未登录访客提问。false = 只有登录用户能问（默认，防白嫖 token）</summary>
    public bool AskAllowAnonymous { get; set; }

    /// <summary>本站点每日提问次数上限（0 = 用系统默认值）</summary>
    public int AskDailyLimit { get; set; }

    /// <summary>提问配置最后修改时间 / 修改人（审计用，排查"谁把它打开了"）</summary>
    public DateTime? AskConfigUpdatedAt { get; set; }
    public string? AskConfigUpdatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 内容版本时间戳：仅在创建 / 重新上传（内容真正变化）时更新，
    /// 元数据改动（改标题、改可见性、改共享团队）不动它。
    /// 用作 SiteUrl / pdfAssetUrl 的 ?v= 缓存指纹，确保"内容不变命中缓存、重新上传击穿缓存"。
    ///
    /// 注意：**禁止**给这里加 `= DateTime.UtcNow` 初始化器。Mongo 反序列化老文档（无此字段）
    /// 时会保留初始化器的值——若为 UtcNow，则每次读取都得到当前时间，?v 每次都变，
    /// 反而把缓存击穿（Codex PR #686 P2 抓到）。保持默认 default(DateTime) 才是确定值；
    /// 所有创建路径都会显式赋 now，老文档则在读取侧回退到 CreatedAt（见 TryBuildPdfAssetUrl）。
    /// </summary>
    public DateTime ContentVersion { get; set; }

    /// <summary>
    /// 已注入的「幻灯片翻页方向兼容垫片」版本号。0 = 从未注入（存量旧站）。
    /// 上传时注入当前版本；startup backfill 把 &lt; 当前版本的站点重新注入并升级，
    /// 让垫片代码升级后存量站点自动获得新版（无需用户重传）。详见 HostedSiteService.SlideNavVersion。
    /// </summary>
    public int SlideNavCompatVersion { get; set; }
}

/// <summary>站点文件清单项</summary>
public class HostedSiteFile
{
    /// <summary>相对路径 (如 "index.html", "css/style.css")</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>COS 完整 key</summary>
    public string CosKey { get; set; } = string.Empty;

    /// <summary>文件大小 (bytes)</summary>
    public long Size { get; set; }

    /// <summary>MIME 类型</summary>
    public string MimeType { get; set; } = string.Empty;
}

/// <summary>
/// 网页分享链接 — 基于 Token 的分享机制（密码保护 + 过期时间）
/// </summary>
[BsonIgnoreExtraElements]
public class WebPageShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>短 Token（用于 URL）</summary>
    public string Token { get; set; } = GenerateToken();

    /// <summary>关联的站点 ID（单站点分享时）</summary>
    public string? SiteId { get; set; }

    /// <summary>关联的站点 ID 列表（合集分享时）</summary>
    public List<string> SiteIds { get; set; } = new();

    /// <summary>
    /// 这条分享到底指向哪几个站点 —— 合集分享看 SiteIds，存量单站点分享只有 SiteId。
    ///
    /// 抽出来是因为「两个字段一起认」这件事在读路径上被各写了一遍（鉴权、阅读、另存、
    /// 分享列表…），少认一个字段的表现是**存量单站点分享整条被漏掉**，而且不报错：
    /// 访客数一栏就因此对这类分享一直显示 0。判据分裂成多份然后各自漂移的典型
    /// （predicate-and-wiring-discipline 形状 3），新代码一律走这一个。
    ///
    /// SiteId 排在前面：单站点分享的语义主体就是它。
    /// </summary>
    public List<string> TargetSiteIds()
    {
        var ids = new List<string>();
        if (!string.IsNullOrEmpty(SiteId)) ids.Add(SiteId);
        foreach (var id in SiteIds)
        {
            if (!string.IsNullOrEmpty(id) && !ids.Contains(id)) ids.Add(id);
        }
        return ids;
    }

    /// <summary>分享类型：single = 单站点, collection = 合集</summary>
    public string ShareType { get; set; } = "single";

    /// <summary>
    /// 用途：share = 用户主动分享（自选有效期/密码，出现在分享管理列表）；
    /// visit = 站点「访问」便捷链（恒为公开永久，与用户分享互不复用、互不篡改，不进分享列表）。
    /// 旧记录无此字段，反序列化为默认 "share"，按用户分享对待。
    /// </summary>
    public string Purpose { get; set; } = "share";

    /// <summary>分享标题</summary>
    public string? Title { get; set; }

    /// <summary>分享描述</summary>
    public string? Description { get; set; }

    /// <summary>访问级别：public = 任何人 | password = 需密码</summary>
    public string AccessLevel { get; set; } = "public";

    /// <summary>
    /// 明文密码 —— 仅旧分享和创建时"按密码去重"使用。
    /// 新分享统一以 PasswordHash + PasswordSalt 存储；校验路径优先 Hash，
    /// 仅在 PasswordHash 为空时回退到本字段（向后兼容存量数据）。
    /// </summary>
    public string? Password { get; set; }

    /// <summary>密码 Hash (PBKDF2-SHA256, base64)。新分享必填；旧分享为空时走明文回退路径</summary>
    public string? PasswordHash { get; set; }

    /// <summary>密码盐 (16 bytes base64)。与 PasswordHash 配对，缺一个就视为旧分享</summary>
    public string? PasswordSalt { get; set; }

    /// <summary>
    /// 最近 N 次尝试时间戳（滑动窗口速率限制专用，单位 UTC）。
    /// 不按 IP 锁定 —— 容器/反向代理下 IP 不可靠，且公司局域网 NAT 出口同 IP，
    /// 一人输错会让所有同事被锁。改用 per-shareLink 滑动窗口：1 分钟内 ≥ 10 次尝试就拒绝。
    /// 窗口自然滚动过期，不需要任何"解锁"操作；列表只保留近 1 分钟内的条目，长度恒定。
    /// </summary>
    public List<DateTime> RecentAttempts { get; set; } = new();

    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    /// <summary>统一短链 Seq（来自 short_links 集合，旧记录为 0 表示无短链）</summary>
    public long ShortSeq { get; set; }

    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建者显示名称（快照）</summary>
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; }
    public bool IsRevoked { get; set; }

    /// <summary>
    /// 撤销时刻。存量已撤销的链接没有这个字段（为 null），列表会退回「已撤销」四个字不带日期——
    /// 不拿 CreatedAt 顶替：那是创建时间，冒充成撤销时间会直接误导人。
    /// </summary>
    public DateTime? RevokedAt { get; set; }

    /// <summary>
    /// 撤销原因（可选，用户撤销时自己填的一句话，如「误发已收回」）。
    /// 撤销不可逆，几周后回头看列表时这句话是唯一能想起当初为什么撤的线索。
    /// </summary>
    public string? RevokedReason { get; set; }

    /// <summary>
    /// 链接可见性：
    /// - owner-only：仅创建者或所属站点的 SharedTeamIds 成员可访问（新建分享面板默认勾选）
    /// - logged-in：任何登录用户可访问
    /// - public：任何人（含未登录）可访问，受 AccessLevel 密码门控
    ///
    /// 字段默认值为空字符串：
    /// (a) 旧分享文档没这个字段，反序列化得到 "" → ViewShareAsync 识别为 legacy → 按 public 处理
    ///     这样保护存量公开链接，避免发布瞬间所有旧链接被拒绝
    /// (b) 新建分享时 CreateShareAsync 必须显式赋值（owner-only / logged-in / public），杜绝裸默认
    /// (c) visit 便捷链恒为 public
    ///
    /// 不再依赖延迟 30s 的 backfill —— legacy 兼容直接在读路径完成。
    /// </summary>
    public string Visibility { get; set; } = string.Empty;

    /// <summary>
    /// 续期审计历史（每次创建复用 / 显式续期都追加一条）。
    /// 用于排查"莫名其妙过期"——可以看到这个链接的 ExpiresAt 被谁、什么时候、改成什么值。
    /// </summary>
    public List<ShareRenewalEvent> RenewalHistory { get; set; } = new();

    /// <summary>
    /// 唯一 IP 数（基于 ShareViewLogs 的 distinct IP 聚合缓存）。
    /// 列表查询时如发现该值与 ViewCount 比例严重失衡（如 ViewCount > 缓存值 + 50）则在线重算；
    /// 不参与高频写路径（避免每次访问聚合 distinct count）。
    /// </summary>
    public long UniqueIpCount { get; set; }

    /// <summary>
    /// 本条分享链接自选的开场问题（创建分享时从站点题库里勾选，也可现场加自定义的）。
    ///
    /// 三态语义，**禁止**给这里加 `= new()` 初始化器 —— 加了就把「没选」和「选了空」
    /// 糊成同一个值，等于永远读不出"这条链接明确不要开场问题"：
    ///   - null       = 没选过（存量分享反序列化落这里）→ 继承站点题库 HostedSite.AskSuggestedQuestions
    ///   - 空列表 []  = 明确选了"一个都不显示"→ 面板不出开场问题
    ///   - 非空列表   = 本链接只显示这几条
    ///
    /// 同一个坑 ContentVersion 上面已经栽过一次（初始化器让老文档读出错误的活跃值），
    /// 三态取舍统一收在 <see cref="AskOpeningQuestions.Resolve"/>，不许在别处各判一遍。
    /// </summary>
    public List<string>? AskSuggestedQuestions { get; set; }

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}

/// <summary>
/// 分享链接续期/有效期变更审计记录（写入 WebPageShareLink.RenewalHistory）
/// </summary>
public class ShareRenewalEvent
{
    public DateTime At { get; set; } = DateTime.UtcNow;

    /// <summary>操作类型：created | reused | renewed | revoked | visibility-changed</summary>
    public string Action { get; set; } = string.Empty;

    /// <summary>触发操作的用户 ID</summary>
    public string? ByUserId { get; set; }

    /// <summary>变更前的过期时间</summary>
    public DateTime? OldExpiresAt { get; set; }

    /// <summary>变更后的过期时间</summary>
    public DateTime? NewExpiresAt { get; set; }

    /// <summary>变更说明（如 "extended by 30 days" / "reuse refreshed"）</summary>
    public string? Note { get; set; }
}

/// <summary>
/// 分享链接观看记录 — 记录每次访问的来源信息
/// </summary>
public class ShareViewLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>分享链接 Token</summary>
    public string ShareToken { get; set; } = string.Empty;

    /// <summary>分享链接 ID</summary>
    public string ShareId { get; set; } = string.Empty;

    /// <summary>观看者用户 ID（未登录为 null）</summary>
    public string? ViewerUserId { get; set; }

    /// <summary>观看者显示名称（未登录为 null）</summary>
    public string? ViewerName { get; set; }

    /// <summary>观看者头像文件名快照（未登录为 null）</summary>
    public string? ViewerAvatarFileName { get; set; }

    /// <summary>分享创建者用户 ID</summary>
    public string ShareOwnerUserId { get; set; } = string.Empty;

    /// <summary>观看时间</summary>
    public DateTime ViewedAt { get; set; } = DateTime.UtcNow;

    /// <summary>IP 地址</summary>
    public string? IpAddress { get; set; }

    /// <summary>User-Agent</summary>
    public string? UserAgent { get; set; }
}
