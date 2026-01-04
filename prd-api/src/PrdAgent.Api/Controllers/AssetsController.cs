using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 资源信息（Desktop 只读消费）
/// </summary>
[ApiController]
[Route("api/v1/assets")]
[Authorize]
public class AssetsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AssetsController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// Desktop：获取可用皮肤列表（仅返回 skin 名称，不返回 URL 规则）
    /// </summary>
    [HttpGet("desktop/skins")]
    [ProducesResponseType(typeof(ApiResponse<DesktopSkinsResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetDesktopSkins(CancellationToken ct)
    {
        var list = await _db.DesktopAssetSkins
            .Find(x => x.Enabled)
            .SortBy(x => x.Name)
            .ToListAsync(ct);

        var skins = list
            .Select(x => (x.Name ?? string.Empty).Trim())
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        // white/dark 默认建议：若库中无配置则返回空，让 Desktop 走本地默认；避免后端强行“写死”与未来皮肤冲突
        return Ok(ApiResponse<DesktopSkinsResponse>.Ok(new DesktopSkinsResponse { Skins = skins }));
    }
}


