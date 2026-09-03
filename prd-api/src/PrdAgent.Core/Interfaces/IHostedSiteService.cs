using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 托管站点领域服务 — 文件上传、ZIP 解压、COS 存储、分享链接
/// 供 Controller 和 Worker/Agent 共同使用的统一入口
/// </summary>
public interface IHostedSiteService
{
    // ── 创建 ──

    /// <summary>从 HTML 文件字节创建站点</summary>
    Task<HostedSite> CreateFromHtmlAsync(
        string userId, byte[] htmlBytes, string fileName,
        string? title, string? description, string? folder, List<string>? tags,
        CancellationToken ct = default);

    /// <summary>从 ZIP 文件字节创建站点；wrappedAssetType 由调用方在生成"壳子+资产"包装 ZIP 时显式传入</summary>
    /// <param name="uploadId">
    /// 可选。传了就把解包进度写进 <see cref="IUploadProgressService"/>，
    /// 供前端另开一路轮询展示「已解包 N / M 个文件」。不传 = 不记录，老调用方零影响。
    /// </param>
    Task<HostedSite> CreateFromZipAsync(
        string userId, byte[] zipBytes,
        string? title, string? description, string? folder, List<string>? tags,
        string? wrappedAssetType = null,
        CancellationToken ct = default,
        string? uploadId = null);

    /// <summary>从 HTML 字符串创建站点（供工作流/Agent 调用）</summary>
    /// <param name="siteId">
    /// 可选：由调用方指定站点 id。用于幂等 —— 调用方把幂等键压成确定性 id 传进来，
    /// 并发重复请求会在 _id 上撞主键（而不是各自建出一个站），调用方捕获后返回既有站点。
    /// 不传则随机生成。
    /// </param>
    Task<HostedSite> CreateFromContentAsync(
        string userId, string htmlContent,
        string? title, string? description,
        string sourceType, string? sourceRef,
        List<string>? tags, string? folder,
        CancellationToken ct = default,
        string? siteId = null);

    // ── 替换内容 ──

    /// <summary>重新上传站点文件（HTML 或 ZIP），替换原有内容；wrappedAssetType 由调用方按原始资产类型显式传入（"pdf"/"video"/"markdown"），普通 HTML/ZIP 传 null 会清空 marker</summary>
    /// <param name="uploadId">可选，同 <see cref="CreateFromZipAsync"/>。</param>
    Task<HostedSite> ReuploadAsync(
        string siteId, string userId,
        byte[] fileBytes, string fileName,
        string? wrappedAssetType = null,
        CancellationToken ct = default,
        string? uploadId = null);

    /// <summary>回填存量 PDF 包装站的 WrappedAssetType marker（一次性维护任务，由 HostedSiteBackfillService 启动调用）</summary>
    Task<int> BackfillPdfWrapperMarkersAsync(CancellationToken ct = default);

    /// <summary>存量站点回填幻灯片翻页方向兼容垫片（版本 &lt; 当前的站点重新注入升级，无需用户重传）。</summary>
    Task<int> BackfillSlideNavCompatAsync(CancellationToken ct = default);

    // ── 查询 ──

    Task<HostedSite?> GetByIdAsync(string siteId, string userId, CancellationToken ct = default);

    Task<(List<HostedSite> Items, long Total)> ListAsync(
        string userId, string? keyword, string? folder,
        string? tag, string? sourceType, string sort,
        int skip, int limit, string? scope = null, string? teamId = null,
        CancellationToken ct = default);

    /// <summary>设置站点分享到的团队（「分享到团队」操作，仅 owner 可调）。返回更新后的站点，无权或不存在返回 null</summary>
    Task<HostedSite?> SetSharedTeamsAsync(string siteId, string userId, List<string> teamIds, CancellationToken ct = default);

    /// <summary>
    /// 把自己的站点物理复制一份进团队空间（COS 文件完整拷贝，副本与原件互相独立）。
    /// groupId 可选：副本直接归入目标团队的专题/日常分类。
    /// 站点不存在/非 owner 抛 KeyNotFoundException；目标团队无编辑权抛 UnauthorizedAccessException。
    /// </summary>
    Task<HostedSite> CopyToTeamAsync(string siteId, string userId, string teamId, string? groupId, CancellationToken ct = default);

    Task<List<string>> ListFoldersAsync(string userId, CancellationToken ct = default);

    Task<List<TagCountResult>> ListTagsAsync(string userId, CancellationToken ct = default);

    // ── 更新 / 删除 ──

    Task<HostedSite?> UpdateAsync(
        string siteId, string userId,
        string? title, string? description,
        List<string>? tags, string? folder, string? coverImageUrl,
        CancellationToken ct = default);

    Task<bool> DeleteAsync(string siteId, string userId, CancellationToken ct = default);

    Task<long> BatchDeleteAsync(List<string> siteIds, string userId, CancellationToken ct = default);

    // ── 可见性 ──

    /// <summary>切换站点可见性（private / public），首次 public 时写入 PublishedAt</summary>
    Task<HostedSite?> SetVisibilityAsync(string siteId, string userId, string visibility, CancellationToken ct = default);

    /// <summary>按用户名获取该用户所有公开的站点（公开页聚合，无需登录）</summary>
    Task<List<HostedSite>> ListPublicByUserIdAsync(string ownerUserId, int limit = 60, CancellationToken ct = default);

    /// <summary>按用户获取该用户全部站点（公开 + 私有）。用于项目内成员作品聚合：项目经理/成员在项目空间内查看队友的
    /// 网页托管作品，不受 owner 公开与否限制（站点文件本身按 URL 直达，Visibility 仅控制公开页是否列出）。</summary>
    Task<List<HostedSite>> ListAllByUserIdAsync(string ownerUserId, int limit = 60, CancellationToken ct = default);

    // ── 分享 ──

    /// <summary>
    /// 创建分享链接。
    /// - forceNew=true：用户在分享面板中显式点「新建分享」，无论是否存在可复用条目都新建（默认行为，PR 2026-05-28 起）
    /// - forceNew=false：站点访问便捷链等内部场景，保留服务端去重 + 续期复用
    /// - visibility：owner-only（默认，仅创建者/团队成员可访问）/ logged-in / public
    /// </summary>
    Task<WebPageShareLink> CreateShareAsync(
        string userId, string displayName,
        string? siteId, List<string>? siteIds, string shareType,
        string? title, string? description,
        string? password, int expiresInDays,
        CancellationToken ct = default,
        string purpose = "share",
        bool forceNew = false,
        string visibility = "owner-only",
        bool allocateShortLink = false,
        List<string>? askSuggestedQuestions = null);

    /// <summary>
    /// 与 <see cref="CreateShareAsync"/> 同一条路径，另外告诉调用方这条链接是**复用**来的还是新建的。
    /// 复用意味着这次调用没产生新副作用，调用方据此可以把已占的额度退回去。
    /// </summary>
    Task<(WebPageShareLink Link, bool Reused)> CreateShareWithReuseInfoAsync(
        string userId, string displayName,
        string? siteId, List<string>? siteIds, string shareType,
        string? title, string? description,
        string? password, int expiresInDays,
        CancellationToken ct = default,
        string purpose = "share",
        bool forceNew = false,
        string visibility = "owner-only",
        bool allocateShortLink = false,
        List<string>? askSuggestedQuestions = null);

    /// <summary>
    /// 事后为某条已存在的分享按需分配数字短链 /s/{seq}（用户在分享面板点「生成数字短链」）。
    /// 幂等：已有则返回原 Seq。返回分配后的 ShortSeq（&gt;0 成功）。
    /// 仅创建者可调用；visit 便捷链不支持。
    /// </summary>
    Task<long> EnsureShortLinkAsync(string userId, string shareId, CancellationToken ct = default);

    /// <summary>
    /// 列出分享：默认包含未过期 + 过期 ≤ 7 天（允许续期）的链接。
    /// 过期 > 7 天的链接不返回，但保留 DB 行用于审计。
    ///
    /// <paramref name="includeRevoked"/> 默认 false —— 保持既有调用方行为不变。
    /// 传 true 时把已撤销的链接一并返回（分享管理面板的「已撤销」一层要用：
    /// 撤销不可逆，但用户仍需要看到「哪条被我撤了、什么时候撤的」并能重新分享，
    /// 直接从列表里消失等于这段历史无处可查）。
    /// </summary>
    /// <summary>
    /// 我建的分享链接。<paramref name="siteId"/> 非空时只返回指向该站点的（两个字段都认）。
    ///
    /// 不带 siteId 时结果按时间取最近 100 条。想判断「某个站点有没有活着的链接」必须带上
    /// siteId：否则它的链接落在这 100 条之外时会被判成「没有」，调用方据此再建一条重复的。
    /// </summary>
    Task<List<WebPageShareLink>> ListSharesAsync(
        string userId, CancellationToken ct = default, bool includeRevoked = false, string? siteId = null);

    /// <summary>
    /// 批量取站点标题（id → title）。分享列表的「指向的站点」一列要用。
    /// 查不到的 id（站点已删）不会出现在结果里，调用方自己决定怎么显示。
    /// </summary>
    Task<Dictionary<string, string>> GetTitlesByIdsAsync(IEnumerable<string> siteIds, CancellationToken ct = default);

    /// <summary>
    /// 续期某条分享链接。仅创建者可调用。
    /// - 链接已撤销：失败
    /// - 当前未过期：新过期时间 = max(now, ExpiresAt) + extendDays
    /// - 已过期 ≤ 7 天：新过期时间 = now + extendDays
    /// - 已过期 > 7 天：失败（视为彻底失效，用户应新建链接）
    /// </summary>
    Task<RenewShareResult> RenewShareAsync(string shareId, string userId, int extendDays, CancellationToken ct = default);

    /// <summary>
    /// 就地改一条已存在分享链接的设置（分享下拉面板里的「谁能打开 / 有效期」）。
    ///
    /// 与 <see cref="RenewShareAsync"/> 的区别：续期是**累加**（在现有到期日上加 N 天），
    /// 这里是**重设**（从现在起算 N 天，0 = 永久）——用户在面板里选「7 天」，期待的是
    /// 「这条链接还有 7 天」，不是「在原来剩的 3 天上再加 7 天」。
    ///
    /// 两个参数都是 null 表示不动该项（局部更新）。已撤销的链接一律拒绝：撤销不可逆，
    /// 允许改设置等于把死链复活。
    /// </summary>
    Task<UpdateShareSettingsResult> UpdateShareSettingsAsync(
        string shareId, string userId, string? visibility, int? expiresInDays, CancellationToken ct = default);

    /// <summary>
    /// 撤销分享链接（不可逆）。<paramref name="reason"/> 可选，记一句「为什么撤」。
    /// </summary>
    Task<bool> RevokeShareAsync(string shareId, string userId, string? reason = null, CancellationToken ct = default);

    Task<ShareViewResult?> ViewShareAsync(string token, string? password,
        string? viewerUserId = null, string? viewerName = null,
        string? ipAddress = null, string? userAgent = null,
        CancellationToken ct = default);

    /// <summary>获取分享的观看记录（供分享所有者查看）</summary>
    Task<List<ShareViewLog>> ListShareViewLogsAsync(string userId, string? shareToken, int limit = 100, CancellationToken ct = default);

    /// <summary>
    /// 获取某个站点的分享访问日志。仅站点 owner 可调；按站点维度聚合多条分享链接的日志，
    /// 用于分享面板底部「访问日志」区。
    /// </summary>
    Task<List<ShareViewLog>> ListShareViewLogsForSiteAsync(string siteId, string userId, int limit = 50, CancellationToken ct = default);

    /// <summary>
    /// 用户分享统计聚合：当前所有未撤销分享 + 活跃链接 + 时间窗内访问总量 / 独立访客 / 时间线。
    /// 用于「分享统计」Drawer（参考 Cloudflare 风格简化版）。
    /// siteId 非空时把统计范围收窄到该站点（用于站点卡上的「本站点统计」过滤按钮）。
    /// </summary>
    Task<ShareAnalyticsResult> GetShareAnalyticsAsync(string userId, int rangeDays, string? siteId = null, CancellationToken ct = default);

    /// <summary>
    /// 分享诊断（admin only）：返回某个 Token 完整状态 + 续期历史 + 最近访问 + 一句话原因诊断，
    /// 用于排查"为什么这个链接过期了 / 看不到"投诉。
    /// </summary>
    Task<ShareDiagnosticsResult?> GetShareDiagnosticsAsync(string token, CancellationToken ct = default);

    /// <summary>将分享的站点保存到自己的托管（去重：同一 token 只保存一次）</summary>
    Task<SaveSharedSiteResult> SaveSharedSiteAsync(string token, string? password, string userId, CancellationToken ct = default);

    /// <summary>
    /// 一次性数据迁移：把所有现存非 visit 的分享链接的 Visibility 从默认 "owner-only" 改为 "public"，
    /// 仅作用于本次发布前已创建的链接（用 marker 字段或时间窗判定）。
    /// 由 WebPageVisibilityBackfillService 在启动时调用一次。
    /// </summary>
    Task<int> BackfillShareVisibilityAsync(CancellationToken ct = default);

    // ── 评论 ──

    /// <summary>切换站点是否允许评论（仅 owner / editor 可调）。返回更新后的站点；无权或不存在返回 null。</summary>
    Task<HostedSite?> SetCommentsEnabledAsync(string siteId, string userId, bool enabled, CancellationToken ct = default);

    // ── 向我提问 ──

    /// <summary>
    /// 写入站点的「向我提问」配置（仅 owner / editor 可调，与评论开关同一套角色门）。
    /// 返回更新后的站点；无权或不存在返回 null。
    /// </summary>
    /// <summary>
    /// 能不能维护该站点的提问配置（owner / editor）。与「站点可见」是两件事：
    /// GetByIdAsync 对任一共享团队成员（含 viewer）都放行，写路径不能拿它当权限。
    /// </summary>
    Task<bool> CanMaintainAskAsync(string siteId, string userId, CancellationToken ct = default);

    Task<HostedSite?> SetAskConfigAsync(string siteId, string userId, AskConfigUpdate update, CancellationToken ct = default);

    /// <summary>
    /// 直连 siteId 列出评论（owner / 有访问权的团队成员视角）。
    /// 校验 viewer 对站点的访问权（与 GetByIdAsync 同款 owner/team 规则）；无权或不存在返回 null。
    /// </summary>
    Task<SiteCommentsResult?> ListCommentsBySiteAsync(string siteId, string viewerUserId, CancellationToken ct = default);

    /// <summary>
    /// 经分享链接列出评论（公开访问路径）。校验分享访问门（撤销 / 过期 / 可见性 / 密码）。
    /// 通过后返回分享首个站点的评论；门禁不过时 Result.Error 非空。
    /// </summary>
    Task<SiteCommentsResult> ListCommentsByShareAsync(string token, string? password, string? viewerUserId, CancellationToken ct = default);

    /// <summary>直连 siteId 发表评论（需 viewer 对站点有访问权）。站点不存在 / 无权 / 评论关闭时 Error 非空。</summary>
    Task<AddCommentResult> AddCommentBySiteAsync(
        string siteId, string authorUserId, string authorName, string? avatarFileName,
        string content, CancellationToken ct = default);

    /// <summary>经分享链接发表评论（公开路径，需登录）。校验分享访问门 + 评论开关；通过后插入。</summary>
    Task<AddCommentResult> AddCommentByShareAsync(
        string token, string? password,
        string authorUserId, string authorName, string? avatarFileName,
        string content, string? ipAddress, CancellationToken ct = default);

    /// <summary>删除评论（作者本人或站点 owner）。无权 / 不存在返回 false。</summary>
    Task<bool> DeleteCommentAsync(string commentId, string userId, CancellationToken ct = default);

    /// <summary>
    /// 经分享链接解析出一个可读取正文的站点（公开访问路径）。校验分享门禁（撤销 / 过期 / 可见性 / 密码），
    /// 与 ListCommentsByShareAsync 同一套判定源。siteId 为空取分享首站点；指定时必须属于该分享。
    /// 供预览页取回站点入口 HTML 用（浏览器直接 fetch 托管域名会被 CORS 拦掉，必须走服务端同源代理）。
    /// </summary>
    Task<ShareSiteResolveResult> ResolveShareSiteAsync(
        string token, string? siteId, string? password, string? viewerUserId, CancellationToken ct = default);
}

/// <summary>站点「向我提问」配置的写入入参（owner 在提问设置抽屉里改的那几项）。</summary>
public class AskConfigUpdate
{
    /// <summary>是否开放提问</summary>
    public bool Enabled { get; set; }

    /// <summary>面板欢迎语（空则前端用站点标题兜底）</summary>
    public string? Welcome { get; set; }

    /// <summary>站点级开场问题题库；分享时可从中挑选</summary>
    public List<string>? SuggestedQuestions { get; set; }

    /// <summary>是否允许未登录访客提问</summary>
    public bool AllowAnonymous { get; set; }

    /// <summary>每日提问上限（0 = 用系统默认）</summary>
    public int DailyLimit { get; set; }
}

/// <summary>分享链接解析结果：拿到站点，或拿到一个可映射成 HTTP 状态的门禁错误。</summary>
public class ShareSiteResolveResult
{
    public HostedSite? Site { get; set; }

    /// <summary>
    /// 门禁通过时带回分享链接本身。提问端点要读它的 AskSuggestedQuestions
    /// （本链接自选的开场问题）；只有 Site 的话调用方就得再查一次库，
    /// 而且会绕开这里已经做完的门禁判定。
    /// </summary>
    public WebPageShareLink? Share { get; set; }

    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
    /// <summary>错误码：not_found / expired / VISIBILITY_DENIED / UNAUTHORIZED / rate_limited</summary>
    public string? ErrorCode { get; set; }
    /// <summary>HttpStatus = 429 时填充，告知前端 N 秒后再试</summary>
    public int? RetryAfterSeconds { get; set; }
}

public class HostedSiteCommentDto
{
    public string Id { get; set; } = string.Empty;
    public string SiteId { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string AuthorUserId { get; set; } = string.Empty;
    public string AuthorName { get; set; } = "用户";
    public string? AuthorAvatarFileName { get; set; }
    public DateTime CreatedAt { get; set; }
    /// <summary>当前 viewer 是否可删除本评论（作者本人或站点 owner）</summary>
    public bool CanDelete { get; set; }
}

public class SiteCommentsResult
{
    public string SiteId { get; set; } = string.Empty;
    public bool CommentsEnabled { get; set; } = true;
    /// <summary>当前 viewer 是否可发表（已登录 + 评论开启）</summary>
    public bool CanComment { get; set; }
    public List<HostedSiteCommentDto> Comments { get; set; } = new();
    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
    /// <summary>错误码：not_found / expired / VISIBILITY_DENIED / UNAUTHORIZED / rate_limited</summary>
    public string? ErrorCode { get; set; }
    /// <summary>HttpStatus = 429 时填充，告知前端 N 秒后再试</summary>
    public int? RetryAfterSeconds { get; set; }
}

public class AddCommentResult
{
    public HostedSiteCommentDto? Comment { get; set; }
    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
    public string? ErrorCode { get; set; }
    /// <summary>HttpStatus = 429 时填充，告知前端 N 秒后再试</summary>
    public int? RetryAfterSeconds { get; set; }
}

public class TagCountResult
{
    public string Tag { get; set; } = string.Empty;
    public int Count { get; set; }
}

public class ShareViewResult
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string ShareType { get; set; } = "single";
    public DateTime CreatedAt { get; set; }
    public string? CreatedBy { get; set; }
    public string? CreatedByName { get; set; }
    public List<SharedSiteInfo> Sites { get; set; } = new();

    /// <summary>
    /// 本次分享的「向我提问」呈现配置（首站点的开关 + 本链接实际该显示的开场问题）。
    /// 随分享视图一起返回，省掉一次额外的受门禁保护的往返；关闭时为 null。
    /// </summary>
    public ShareAskInfo? Ask { get; set; }

    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
    /// <summary>错误码：visibility_denied / expired / wrong_password / rate_limited / not_found</summary>
    public string? ErrorCode { get; set; }
    /// <summary>HttpStatus = 429 时填充，告知前端 N 秒后再试（驱动倒计时 UI）</summary>
    public int? RetryAfterSeconds { get; set; }
}

/// <summary>分享页渲染「向我提问」入口所需的一切（访客视角，不含 owner 才该看的配额等内部项）。</summary>
public class ShareAskInfo
{
    /// <summary>被提问的站点 ID（合集分享取首站点）</summary>
    public string SiteId { get; set; } = string.Empty;

    /// <summary>是否显示提问入口</summary>
    public bool Enabled { get; set; }

    /// <summary>是否允许未登录访客提问；false 时前端要引导登录而不是直接开问</summary>
    public bool AllowAnonymous { get; set; }

    /// <summary>欢迎语（可空，前端用站点标题兜底）</summary>
    public string? Welcome { get; set; }

    /// <summary>本链接实际该显示的开场问题（已过 AskOpeningQuestions.Resolve，前端直接渲染即可）</summary>
    public List<string> OpeningQuestions { get; set; } = new();
}

public class RenewShareResult
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public DateTime? NewExpiresAt { get; set; }
}

/// <summary>
/// 就地改分享设置的结果。回传**改完之后的实际值**而不是「改成功了」——
/// 面板那几行显示的就是这两个值，让前端拿请求参数去乐观更新，等于把服务端的规范化
/// （白名单回退、天数夹取）绕过去，界面会显示一个后端根本没存的值。
/// </summary>
public class UpdateShareSettingsResult
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string Visibility { get; set; } = string.Empty;
    public DateTime? ExpiresAt { get; set; }
}

/// <summary>
/// 分享链接「还能不能续期」的唯一判定源。
///
/// 这条判据原先在三处各写了一遍 <c>AddDays(-7)</c>（续期端点的拒绝分支、分享列表的
/// inGracePeriod、数据抽屉的可续条数），改一处忘一处就会让界面承诺一件后端会拒绝的事。
/// </summary>
public static class ShareRenewPolicy
{
    /// <summary>过期之后仍然允许续期的宽限天数。</summary>
    public const int GraceDays = 7;

    /// <summary>早于这个时刻过期的链接就出了宽限窗。</summary>
    public static DateTime GraceCutoff(DateTime now) => now.AddDays(-GraceDays);

    /// <summary>
    /// 这条链接现在能不能续期。与 RenewShareAsync 的两个拒绝分支同源：
    /// 已撤销不可续；过期超过宽限窗不可续（没有过期时间的一直可续）。
    /// </summary>
    public static bool CanRenew(bool isRevoked, DateTime? expiresAt, DateTime now)
        => !isRevoked && (!expiresAt.HasValue || expiresAt.Value >= GraceCutoff(now));
}

public class ShareAnalyticsResult
{
    public int TotalShares { get; set; }
    public int ActiveShares { get; set; }
    public int ExpiredShares { get; set; }
    /// <summary>已过期之中，续期真的能救回来的条数（未撤销且还在宽限窗内）。</summary>
    public int RenewableExpiredShares { get; set; }
    public long TotalViews { get; set; }
    public int UniqueIpCount { get; set; }
    /// <summary>
    /// 独立访客数是不是取自被截断的样本。TotalViews 走无上限聚合，而去重访客只能在
    /// 取回的那一批日志上算；命中上限时这个数只是下界，界面不得据它算人均。
    /// </summary>
    public bool VisitorSampleCapped { get; set; }
    public long CommentCount { get; set; }
    public List<ShareAnalyticsTimelineEntry> Timeline { get; set; } = new();
    public List<ShareAnalyticsLinkSummary> TopLinks { get; set; } = new();
    public List<ShareAnalyticsTrendPoint> Trend { get; set; } = new();
    public List<ShareAnalyticsHourlyPoint> Hourly { get; set; } = new();
    public List<ShareAnalyticsVisitorStats> TopVisitors { get; set; } = new();
    public List<ShareAnalyticsCommentEntry> RecentComments { get; set; } = new();
}

public class ShareAnalyticsTimelineEntry
{
    public DateTime ViewedAt { get; set; }
    public string ShareToken { get; set; } = string.Empty;
    public string? ShareTitle { get; set; }
    public string ShareUrl { get; set; } = string.Empty;
    public string? ViewerUserId { get; set; }
    public string? ViewerName { get; set; }
    public string? ViewerAvatarFileName { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
    public string? ClientSummary { get; set; }
}

public class ShareAnalyticsLinkSummary
{
    public string ShareId { get; set; } = string.Empty;
    public string Token { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string ShareUrl { get; set; } = string.Empty;
    public long ViewCount { get; set; }
    public long UniqueIpCount { get; set; }
    public DateTime? LastViewedAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public string Visibility { get; set; } = "owner-only";
    public List<ShareAnalyticsVisitorSummary> Visitors { get; set; } = new();
}

public class ShareAnalyticsVisitorSummary
{
    public string? ViewerUserId { get; set; }
    public string ViewerName { get; set; } = "匿名访客";
    public string? ViewerAvatarFileName { get; set; }
    public long ViewCount { get; set; }
}

public class ShareAnalyticsTrendPoint
{
    public string Date { get; set; } = string.Empty;
    public long Views { get; set; }
    public long Comments { get; set; }
}

public class ShareAnalyticsHourlyPoint
{
    public int Hour { get; set; }
    public long Views { get; set; }
}

public class ShareAnalyticsVisitorStats
{
    public string? ViewerUserId { get; set; }
    public string ViewerName { get; set; } = "匿名访客";
    public string? ViewerAvatarFileName { get; set; }
    public long ViewCount { get; set; }
    public DateTime LastViewedAt { get; set; }
}

public class ShareAnalyticsCommentEntry
{
    public string Id { get; set; } = string.Empty;
    public string SiteId { get; set; } = string.Empty;
    public string SiteTitle { get; set; } = string.Empty;
    public string? ShareToken { get; set; }
    public string AuthorName { get; set; } = "用户";
    public string? AuthorAvatarFileName { get; set; }
    public string Content { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
}

public class ShareDiagnosticsResult
{
    public string Token { get; set; } = string.Empty;
    public string Id { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public string? CreatedBy { get; set; }
    public string? CreatedByName { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public bool IsRevoked { get; set; }
    public string Visibility { get; set; } = "owner-only";
    public string AccessLevel { get; set; } = "public";
    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }
    public List<ShareRenewalEvent> RenewalHistory { get; set; } = new();
    public List<ShareViewLog> RecentViews { get; set; } = new();
    /// <summary>一句话诊断：解释链接当前是否可访问，及为什么。</summary>
    public string DiagnosisSummary { get; set; } = string.Empty;
}

public class SaveSharedSiteResult
{
    public bool AlreadySaved { get; set; }
    public bool Saved { get; set; }
    public List<HostedSite> Sites { get; set; } = new();
    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
    /// <summary>HttpStatus = 429 时填充，告知前端 N 秒后再试</summary>
    public int? RetryAfterSeconds { get; set; }
}

public class SharedSiteInfo
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string SiteUrl { get; set; } = string.Empty;
    public string EntryFile { get; set; } = string.Empty;
    public long TotalSize { get; set; }
    public int FileCount { get; set; }
    public string? CoverImageUrl { get; set; }

    /// <summary>
    /// 仅当本站点是「PDF 包装站」（index.html 壳子 + 单个 .pdf 资产）时填充，
    /// 指向真实 PDF 文件的直链。前端拿到后应直接 iframe 这个 URL，让浏览器原生
    /// PDF Viewer 接管；否则嵌套 iframe + sandbox 会被 Chrome 屏蔽。
    /// </summary>
    public string? PdfAssetUrl { get; set; }

    /// <summary>
    /// 包装资产类型（pdf / video / markdown …），普通 HTML 站为 null。
    ///
    /// 前端要靠它判断「这个站点有没有可读的 HTML 正文」。包装站的入口同样是 index.html，
    /// 光看 entryFile 分不出来；而正文代理对任何非空包装类型都会拒绝，
    /// 前端不知情就会拿一个「预期之内的拒绝」当失败，在一个本来显示正常的直链预览上
    /// 盖一条错误角标。
    /// </summary>
    public string? WrappedAssetType { get; set; }
}
