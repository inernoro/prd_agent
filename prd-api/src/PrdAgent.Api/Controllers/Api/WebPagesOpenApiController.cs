using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

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

    /// <summary>单页 HTML 上限 4MB —— 再大的东西不该由一次工具调用塞过来。</summary>
    private const int MaxHtmlChars = 4_000_000;

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
        if (html.Length > MaxHtmlChars)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"HTML 超过 {MaxHtmlChars / 1000} KB 上限，请精简或拆成多页"));

        // 幂等：同一把密钥 + 同一个 clientRequestId 只建一次站
        var sourceRef = BuildSourceRef(req!.ClientRequestId);
        if (sourceRef != null)
        {
            // PublishPendingAt == null：只认**已经传完**的站点。还在占坑的那条不算数 ——
            // 回它就是把一个还打不开的地址当「去重成功」交出去。落到下面的创建路径上，
            // 服务端会接手把内容补传完（Mongo 的 == null 同时命中缺字段的存量记录）。
            var existed = await _db.HostedSites
                .Find(s => s.OwnerUserId == userId && s.SourceRef == sourceRef && s.PublishPendingAt == null)
                .FirstOrDefaultAsync(ct);
            if (existed != null)
                return Ok(ApiResponse<object>.Ok(new
                {
                    siteId = existed.Id,
                    title = existed.Title,
                    url = existed.SiteUrl,
                    deduplicated = true,
                }));
        }

        // 上面那次查询只挡得住「先后两次」的重试；超时重试与原请求叠在一起时两边都查不到，
        // 于是各建一个站。所以带幂等键时把站点 id 也压成确定性的：并发的第二次会在 _id 上撞主键，
        // 捕获后回既有站点。COS 对象 key 由 siteId 决定，两次写的是同一个 key，不会留孤儿。
        var deterministicId = sourceRef == null ? null : DeterministicSiteId(sourceRef);
        HostedSite site;
        try
        {
            site = await _sites.CreateFromContentAsync(
                userId, html,
                string.IsNullOrWhiteSpace(req.Title) ? null : req.Title!.Trim(),
                string.IsNullOrWhiteSpace(req.Description) ? null : req.Description!.Trim(),
                sourceType: "api", sourceRef: sourceRef,
                tags: req.Tags, folder: string.IsNullOrWhiteSpace(req.Folder) ? null : req.Folder!.Trim(),
                ct: ct, siteId: deterministicId);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && deterministicId != null)
        {
            var raced = await _db.HostedSites
                .Find(x => x.Id == deterministicId && x.OwnerUserId == userId && x.PublishPendingAt == null)
                .FirstOrDefaultAsync(ct);
            // 找不到「已传完」的那条，就要分清是哪种情况：
            //   - 撞上的是**别人正在传**的占坑记录（服务端只在租约过期时才接手，所以它抛到这里）
            //     → 回 409 让智能体稍后拿同一个键再试一次，别报 500，也别报成功；
            //   - 其余（根本不是这个 id 撞的）→ 原样抛。
            if (raced == null)
            {
                var stillPublishing = await _db.HostedSites
                    .Find(x => x.Id == deterministicId && x.OwnerUserId == userId && x.PublishPendingAt != null)
                    .AnyAsync(ct);
                if (!stillPublishing) throw;
                return Conflict(ApiResponse<object>.Fail("SITE_PUBLISH_IN_PROGRESS",
                    "同一个 clientRequestId 的上一次发布还没完成 —— 可能仍在进行，也可能刚好中断了。"
                    + "等一两分钟用同一个键再调一次：成了就直接拿到那次的结果，断了则由这一次接着传完。"));
            }
            return Ok(ApiResponse<object>.Ok(new
            {
                siteId = raced.Id,
                title = raced.Title,
                url = raced.SiteUrl,
                deduplicated = true,
            }));
        }
        catch (PublishLeaseLostException ex)
        {
            // 收尾时租约已经不在这次手上：库里那份内容不是这次传的，不能算成功。
            return Conflict(ApiResponse<object>.Fail("SITE_PUBLISH_IN_PROGRESS", ex.Message));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            siteId = site.Id,
            title = site.Title,
            url = site.SiteUrl,
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
                url = s.SiteUrl,
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
        var (share, reused) = await _sites.CreateShareWithReuseInfoAsync(
            userId, await ResolveDisplayNameAsync(userId, ct),
            siteId, siteIds: null, shareType: "single",
            title: string.IsNullOrWhiteSpace(req?.Title) ? site.Title : req!.Title!.Trim(),
            description: string.IsNullOrWhiteSpace(req?.Description) ? null : req!.Description!.Trim(),
            password: null, expiresInDays: days,
            ct: ct,
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
            // 复用了既有链接 = 这次没产生新副作用。必须如实报出来：网关按这个字段把已占的
            // 日写入额度退回去，不报的话，智能体每重试一次就白扣一格，而它只拿到同一条链接。
            deduplicated = reused,
        }));
    }

    /// <summary>把幂等键压成确定性站点 id（32 位十六进制，与随机 id 同形）。</summary>
    private static string DeterministicSiteId(string sourceRef)
        => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"mcp-site:{sourceRef}"))).ToLowerInvariant()[..32];

    private string? BuildSourceRef(string? clientRequestId)
    {
        if (string.IsNullOrWhiteSpace(clientRequestId)) return null;
        var keyId = User.FindFirst("agentApiKeyId")?.Value ?? "unknown";
        var raw = clientRequestId.Trim();
        if (raw.Length > 120) raw = raw[..120];
        return $"mcp:{keyId}:{raw}";
    }
}
