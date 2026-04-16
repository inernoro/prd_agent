using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 个人公开页 — 聚合展示某用户 Visibility=public 的托管网页。
///
/// 与点对点分享（WebPageShareLink，/s/wp/:token）的区别：
/// - 点对点：用户主动生成链接发给特定对象，私密
/// - 公开页：对应"拖到右上角 Dock 的 🌍 公开槽位"动作，放给所有人看，URL 直观（/u/:username）
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/public")]
public class PublicProfileController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IHostedSiteService _siteService;

    public PublicProfileController(MongoDbContext db, IHostedSiteService siteService)
    {
        _db = db;
        _siteService = siteService;
    }

    /// <summary>按用户名获取公开页数据（用户基本信息 + 公开托管站列表）</summary>
    [HttpGet("u/{username}")]
    public async Task<IActionResult> GetProfile(string username, [FromQuery] int limit = 60, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(username))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "用户名不能为空"));

        var user = await _db.Users
            .Find(x => x.Username == username && x.Status == UserStatus.Active)
            .FirstOrDefaultAsync(ct);

        if (user == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "用户不存在"));

        var sites = await _siteService.ListPublicByUserIdAsync(user.UserId, limit, ct);

        var profile = new
        {
            user = new
            {
                username = user.Username,
                displayName = string.IsNullOrWhiteSpace(user.DisplayName) ? user.Username : user.DisplayName,
                avatarFileName = user.AvatarFileName,
            },
            sites = sites.Select(s => new
            {
                id = s.Id,
                title = s.Title,
                description = s.Description,
                siteUrl = s.SiteUrl,
                coverImageUrl = s.CoverImageUrl,
                tags = s.Tags,
                viewCount = s.ViewCount,
                publishedAt = s.PublishedAt,
                updatedAt = s.UpdatedAt,
            }).ToList(),
            total = sites.Count,
        };

        return Ok(ApiResponse<object>.Ok(profile));
    }
}
