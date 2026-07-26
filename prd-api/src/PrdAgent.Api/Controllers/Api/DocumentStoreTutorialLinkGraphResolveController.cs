using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>按产品路由从已发布图谱解析可访问的教程知识库。</summary>
[ApiController]
[Route("api/document-store/tutorial-link-graphs")]
[Authorize]
public sealed class DocumentStoreTutorialLinkGraphResolveController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ITeamService _teams;

    public DocumentStoreTutorialLinkGraphResolveController(MongoDbContext db, ITeamService teams)
    {
        _db = db;
        _teams = teams;
    }

    [HttpGet("resolve")]
    public async Task<IActionResult> Resolve(
        [FromQuery] string publisher,
        [FromQuery] string route,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(publisher) || !IsSafeRoute(route))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "publisher 或 route 无效"));
        }

        var clientType = User.FindFirst("clientType")?.Value;
        var sessionKey = User.FindFirst("sessionKey")?.Value;
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        if (!string.Equals(clientType, "admin", StringComparison.Ordinal) || string.IsNullOrWhiteSpace(sessionKey))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("MAP_SSO_BROWSER_SESSION_REQUIRED", "请使用 MAP 管理后台登录后查看关联教程"));
        }

        var userId = this.GetRequiredUserId();
        if (!isRoot)
        {
            var user = await _db.Users.Find(item => item.UserId == userId).FirstOrDefaultAsync(ct);
            if (user == null || user.Status != UserStatus.Active || user.UserType != UserType.Human || user.Role != UserRole.ADMIN)
            {
                return StatusCode(StatusCodes.Status403Forbidden,
                    ApiResponse<object>.Fail("MAP_ADMIN_REQUIRED", "只有 MAP 管理员可以查看跨系统教程关系"));
            }
        }

        var teamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        var graphs = await _db.TutorialLinkGraphs
            .Find(graph => graph.Publisher == publisher && graph.Published != null)
            .SortByDescending(graph => graph.UpdatedAt)
            .ToListAsync(ct);

        foreach (var graph in graphs)
        {
            var surfaces = graph.Published!.Surfaces
                .Where(surface => surface.Routes.Any(pattern => RouteMatches(pattern, route)))
                .ToArray();
            if (surfaces.Length == 0) continue;

            var store = await _db.DocumentStores.Find(item => item.Id == graph.StoreId).FirstOrDefaultAsync(ct);
            if (store == null || (!isRoot && store.OwnerId != userId && !store.SharedTeamIds.Any(teamIds.Contains))) continue;

            var sourceIds = surfaces.SelectMany(surface => surface.TutorialSourceIds)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToArray();
            var entries = await _db.DocumentEntries.Find(entry => entry.StoreId == store.Id && !entry.IsFolder).ToListAsync(ct);
            var tutorials = entries
                .Where(entry => entry.Metadata.TryGetValue("publisher", out var entryPublisher)
                    && entryPublisher == publisher
                    && entry.Metadata.TryGetValue("sourceId", out var sourceId)
                    && sourceIds.Contains(sourceId, StringComparer.Ordinal))
                .Select(entry => new
                {
                    sourceId = entry.Metadata["sourceId"],
                    entryId = entry.Id,
                    entry.Title,
                })
                .OrderBy(entry => entry.sourceId, StringComparer.Ordinal)
                .ToArray();

            return Ok(ApiResponse<object>.Ok(new
            {
                storeId = store.Id,
                storeName = store.Name,
                requestedRoute = route,
                graphSha256 = graph.Published.GraphSha256,
                surfaces = surfaces.Select(surface => new
                {
                    surface.Id,
                    surface.Label,
                    surface.Routes,
                    sourceIds = surface.TutorialSourceIds,
                }),
                tutorials,
            }));
        }

        return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "当前页面没有可访问的关联教程"));
    }

    internal static bool RouteMatches(string pattern, string route)
    {
        if (string.Equals(pattern, route, StringComparison.Ordinal)) return true;
        var expected = pattern.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        var actual = route.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (expected.Length != actual.Length) return false;
        return expected.Zip(actual).All(parts => parts.First.StartsWith(':')
            || string.Equals(parts.First, parts.Second, StringComparison.Ordinal));
    }

    private static bool IsSafeRoute(string route)
        => route.Length is > 0 and <= 512
            && route.StartsWith('/')
            && !route.StartsWith("//", StringComparison.Ordinal)
            && !route.Any(char.IsControl);
}