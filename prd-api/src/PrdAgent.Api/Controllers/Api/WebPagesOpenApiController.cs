using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Api.Mcp;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页托管开放接口 —— 供外部智能体（MCP 连接器）把写好的一页 HTML 直接托管出来。
///
/// 鉴权：Authorization: Bearer sk-ak-xxxx（AgentApiKey）+ scope web-pages:read / web-pages:write。
///
/// 为什么单独建：WebPagesController 走 JWT + GetRequiredUserId()（只读 sub），sk-ak 没有 sub 会 401。
/// 这里走 ApiKey + RequireScope + boundUserId，业务落盘复用 IHostedSiteService（与人工上传同一条路径）。
///
/// 收敛掉的东西（智能体不需要、也不该碰）：
/// - 只收 HTML 文本，不收 zip / 二进制上传（MCP 传不了二进制，见接入台设计的「暂不支持」）
/// - 不提供删除、不提供公开（public）分享：分享一律 owner-only，收不回来的动作第一期不开放
/// </summary>
[ApiController]
[Route("api/open/web-pages")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class WebPagesOpenApiController : ControllerBase
{
    public const string ScopeRead = "web-pages:read";
    public const string ScopeWrite = "web-pages:write";

    /// <summary>
    /// 单页 HTML 上限 4MB —— 再大的东西不该由一次工具调用塞过来。
    ///
    /// 按**字节**算，不按字符数：一页中文 HTML 里一个汉字是 3 个 UTF-8 字节，
    /// 拿 string.Length 判等于给中文页面开了三倍的口子，而对外承诺的、真正落进对象存储的
    /// 都是字节。工具描述里写着 4MB，这里就得是 4MB。
    /// </summary>
    private const int MaxHtmlBytes = 4 * 1024 * 1024;

    private readonly IHostedSiteService _sites;
    private readonly MongoDbContext _db;

    public WebPagesOpenApiController(IHostedSiteService sites, MongoDbContext db)
    {
        _sites = sites;
        _db = db;
    }

    private string GetBoundUserId()
    {
        var id = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(id))
            throw new UnauthorizedAccessException("Missing boundUserId claim");
        return id;
    }

    private async Task<string> ResolveDisplayNameAsync(string userId, CancellationToken ct)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        return user?.DisplayName ?? user?.Username ?? userId;
    }

    public class PublishPageRequest
    {
        public string? HtmlContent { get; set; }
        public string? Title { get; set; }
        public string? Description { get; set; }
        public string? Folder { get; set; }
        public List<string>? Tags { get; set; }
        /// <summary>幂等键：智能体重试时不会重复建站。</summary>
        public string? ClientRequestId { get; set; }
    }

    /// <summary>把一段 HTML 托管成站点，返回可访问地址。</summary>
    [HttpPost("pages")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> PublishPage([FromBody] PublishPageRequest req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var html = req?.HtmlContent ?? string.Empty;
        if (string.IsNullOrWhiteSpace(html))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "htmlContent 不能为空"));
        var htmlBytes = System.Text.Encoding.UTF8.GetByteCount(html);
        if (htmlBytes > MaxHtmlBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"HTML 超过 {MaxHtmlBytes / 1024 / 1024} MB 上限（按 UTF-8 字节算，中文一个字约 3 字节），请精简或拆成多页"));

        // 幂等：同一把密钥 + 同一个 clientRequestId 只建一次站
        var sourceRef = BuildSourceRef(req!.ClientRequestId);
        if (sourceRef != null)
        {
            var existed = await _db.HostedSites
                .Find(s => s.OwnerUserId == userId && s.SourceRef == sourceRef)
                .FirstOrDefaultAsync(ct);
            if (existed != null)
                return Ok(ApiResponse<object>.Ok(new
                {
                    siteId = existed.Id,
                    title = existed.Title,
                    url = Request.ResolveAbsoluteUrl(existed.SiteUrl),
                    deduplicated = true,
                }));
        }

        // 上面那次查询挡的是「先后两次」的重试 —— 那是真实重试的常态（丢了回应、几秒后再来一次）。
        // **叠在一起**的两次两边都查不到，于是各建一个站。这一点是明知的取舍，不再在应用层收敛：
        // 曾经用「确定性 id + 占坑 + 租约 + 接手补传」去收敛它，连续三轮 review 都在长新洞，
        // 根因是发布要跨对象存储与 Mongo 两套系统做原子动作，而对象存储没有条件写入原语。
        // 多出一个站是浪费，不是坏数据。收敛方案见 doc/debt.platform.md 边界 12。
        HostedSite site;
        try
        {
            site = await _sites.CreateFromContentAsync(
            userId, html,
            string.IsNullOrWhiteSpace(req.Title) ? null : req.Title!.Trim(),
            string.IsNullOrWhiteSpace(req.Description) ? null : req.Description!.Trim(),
            sourceType: "api", sourceRef: sourceRef,
            tags: req.Tags, folder: string.IsNullOrWhiteSpace(req.Folder) ? null : req.Folder!.Trim(),
            // 服务端自己的令牌，不跟调用方的连接走：对象已经用 CancellationToken.None 传上去了，
            // 若插库那一步跟着 RequestAborted 被取消，对象就成了没人指向的孤儿，而且因为没有
            // SourceRef 行，同一个 clientRequestId 的重试会再传一个对象（server-authority）。
            ct: CancellationToken.None,
            // 上限也交给落盘那一层按变换后的真实字节再判一次：服务端会重写绝对路径、
            // 注入近 10KB 的翻页垫片，只在这里校验入参等于承诺 4MB 却存进去 4MB 多。
            maxStoredBytes: MaxHtmlBytes);
        }
        catch (InvalidOperationException ex)
        {
            // 「处理后超上限」是调用方能自己解决的事（精简内容），给 400 + 说清为什么比它提交的大，
            // 不要甩一个 500 让智能体以为是服务端抽风然后原样重试。
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            siteId = site.Id,
            title = site.Title,
            url = Request.ResolveAbsoluteUrl(site.SiteUrl),
            visibility = site.Visibility,
        }));
    }

    /// <summary>列出我托管的站点（最新在前）。</summary>
    [HttpGet("pages")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> ListPages([FromQuery] string? keyword, [FromQuery] int limit, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var resolved = limit is > 0 and <= 100 ? limit : 20;
        var (items, total) = await _sites.ListAsync(
            userId, keyword, folder: null, tag: null, sourceType: null,
            sort: "newest", skip: 0, limit: resolved, ct: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            total,
            items = items.Select(s => new
            {
                siteId = s.Id,
                title = s.Title,
                description = s.Description,
                url = Request.ResolveAbsoluteUrl(s.SiteUrl),
                folder = s.Folder,
                tags = s.Tags ?? new List<string>(),
                createdAt = s.CreatedAt,
            })
        }));
    }

    public class CreateShareRequest
    {
        public string? Title { get; set; }
        public string? Description { get; set; }
        /// <summary>有效期天数，1-90，默认 7。</summary>
        public int? ExpiresInDays { get; set; }
    }

    /// <summary>
    /// 给某个站点建一条分享链接。
    /// 一律 owner-only（只有我和我的团队打得开）—— 公开发布不在第一期开放给智能体的动作里。
    /// </summary>
    [HttpPost("pages/{siteId}/share")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> CreateShare(string siteId, [FromBody] CreateShareRequest? req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var site = await _sites.GetByIdAsync(siteId, userId, ct);
        if (site == null || site.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或不属于你"));

        var days = req?.ExpiresInDays is > 0 and <= 90 ? req!.ExpiresInDays!.Value : 7;
        var (share, reusedUnchanged) = await _sites.CreateShareWithReuseInfoAsync(
            userId, await ResolveDisplayNameAsync(userId, ct),
            siteId, siteIds: null, shareType: "single",
            title: string.IsNullOrWhiteSpace(req?.Title) ? site.Title : req!.Title!.Trim(),
            description: string.IsNullOrWhiteSpace(req?.Description) ? null : req!.Description!.Trim(),
            password: null, expiresInDays: days,
            // 服务端自己的令牌：这一步已经在改库了，调用方断开时 Mongo 可能已经提交而驱动抛取消，
            // 用量过滤器会据此把已占的写入额度退回去，重试于是又建/又续一条（server-authority）。
            ct: CancellationToken.None,
            purpose: "share",
            // 走服务端的复用路径（同用户 + 同站点 + 同访问级别 + 未吊销即复用，并把有效期刷新为本次所选）。
            // forceNew=true 是给「用户在面板上明确点了新建」用的；智能体超时重试可不是那个意思 ——
            // 每重试一次多一条链接、多扣一次写入额度，而它本来只想要一条。
            forceNew: false,
            visibility: "owner-only");

        // 路径与 WebPagesController.CreateShare 一致（/s/wp/{token}），但**必须回绝对地址**：
        // 智能体拿到的相对路径会被它自己的客户端按自己的域名解析（Claude / Codex 那边），
        // 用户点开只会 404 —— 这条链接的全部意义就是「能点开」。
        var baseUrl = Request.ResolveExternalBaseUrl();
        return Ok(ApiResponse<object>.Ok(new
        {
            shareId = share.Id,
            token = share.Token,
            shareUrl = $"{baseUrl}/s/wp/{share.Token}",
            expiresAt = share.ExpiresAt,
            visibility = share.Visibility,
            // 只有「复用且一个字段都没动」才报幂等命中：网关按这个字段把已占的日写入额度退回去。
            // 复用路径会刷新有效期、必要时改密码/标题并追一条续期审计 —— 那些都是真写入，
            // 报成没副作用就等于让同一个键无限续期而不扣额度。
            deduplicated = reusedUnchanged,
        }));
    }

    /// <summary>
    /// 幂等键压成定长指纹再进库。去掉 120 字截断之后，这一路成了唯一把调用方原文
    /// 存进 Mongo（HostedSite.SourceRef，还要当查询键）的地方 —— nginx 收 30MB body，
    /// 一个超长键就能造出一条同样大的文档。知识库与文学创作本来就哈希，这里对齐它们：
    /// 哈希保住「长键互不坍缩」，同时不把无界输入落库。
    /// </summary>
    private string? BuildSourceRef(string? clientRequestId)
    {
        var digest = McpIdempotency.Fingerprint("mcp-site", McpIdempotency.ScopedByKey(User, clientRequestId));
        return digest == null ? null : $"mcp:{digest}";
    }
}
