using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 上传/生成产物索引（用于 LLM 日志页"图片预览"）
/// - Mongo 只存元数据与 COS URL，不存 base64
/// - ADMIN 全局可见
/// </summary>
[ApiController]
[Route("api/visual-agent/upload-artifacts")]
[Authorize]
[AdminController("visual-agent", AdminPermissionCatalog.VisualAgentUse)]
public class UploadArtifactsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public UploadArtifactsController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string requestId, [FromQuery] int limit = 50, CancellationToken ct = default)
    {
        var rid = (requestId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(rid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "requestId 不能为空"));
        }
        limit = Math.Clamp(limit, 1, 200);

        var items = await _db.UploadArtifacts
            .Find(x => x.RequestId == rid)
            .SortBy(x => x.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct = default)
    {
        var aid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(aid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        }

        // 任意 ADMIN 可删（按用户要求）。这里记录审计字段用于追踪。
        var actor = GetAdminId();
        var existed = await _db.UploadArtifacts.Find(x => x.Id == aid).FirstOrDefaultAsync(ct);
        if (existed == null)
        {
            return NotFound(ApiResponse<object>.Fail("ASSET_NOT_FOUND", "记录不存在"));
        }

        await _db.UploadArtifacts.DeleteOneAsync(x => x.Id == aid, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true, deletedBy = actor }));
    }
}


