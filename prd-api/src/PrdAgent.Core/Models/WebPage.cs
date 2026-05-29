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

    // ── 所有权 ──

    /// <summary>所属用户 ID</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>
    /// 分享到的团队 ID 列表 —— 出现在这些团队的「网页托管」团队视图里。
    /// 空列表表示纯个人站点（个人路径不受影响）。仅网页托管模块消费此字段。
    /// </summary>
    public List<string> SharedTeamIds { get; set; } = new();

    /// <summary>浏览次数</summary>
    public long ViewCount { get; set; }

    // ── 公开可见性 ──

    /// <summary>可见性：private = 仅自己可见 | public = 出现在个人公开页 /u/:username</summary>
    public string Visibility { get; set; } = "private";

    /// <summary>首次设为 public 的时间（用于公开页排序）</summary>
    public DateTime? PublishedAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
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

    /// <summary>分享创建者用户 ID</summary>
    public string ShareOwnerUserId { get; set; } = string.Empty;

    /// <summary>观看时间</summary>
    public DateTime ViewedAt { get; set; } = DateTime.UtcNow;

    /// <summary>IP 地址</summary>
    public string? IpAddress { get; set; }

    /// <summary>User-Agent</summary>
    public string? UserAgent { get; set; }
}
