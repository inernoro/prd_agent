using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 知识库受控发布图片接口。与正文发布共用最小权限 AgentApiKey，避免调用普通用户
/// 图片路由时因缺少 JWT 的 sub claim 失败。
/// </summary>
[ApiController]
[Route("api/open/document-store/publisher")]
[Authorize(AuthenticationSchemes = "ApiKey")]
[RequireScope(DocumentStoreOpenApiController.ScopeWrite)]
public sealed class DocumentStorePublisherAssetsController : ControllerBase
{
    internal const long MaxImageBytes = 20 * 1024 * 1024;

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;

    public DocumentStorePublisherAssetsController(MongoDbContext db, IAssetStorage assetStorage)
    {
        _db = db;
        _assetStorage = assetStorage;
    }

    [HttpPost("stores/{storeId}/images")]
    [RequestSizeLimit(MaxImageBytes)]
    public async Task<IActionResult> UploadImage(
        string storeId,
        [FromForm] IFormFile file,
        CancellationToken ct = default)
    {
        var ownerId = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(ownerId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var store = await _db.DocumentStores.Find(candidate => candidate.Id == storeId
                                                               && candidate.OwnerId == ownerId
                                                               && candidate.PmProjectId == null
                                                               && candidate.ProductKnowledgeRef == null
                                                               && candidate.ShituCategoryRef == null)
            .FirstOrDefaultAsync(ct);
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择要上传的图片"));
        if (file.Length > MaxImageBytes)
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT,
                $"图片大小不能超过 {MaxImageBytes / 1024 / 1024}MB"));

        await using var stream = new MemoryStream();
        await file.CopyToAsync(stream, ct);
        var bytes = stream.ToArray();
        var mime = DetectImageMime(bytes);
        if (mime == null)
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT,
                "只支持内容有效的 PNG、JPEG 或 WebP 图片"));

        var stored = await _assetStorage.SaveAsync(
            bytes,
            mime,
            ct,
            domain: AppDomainPaths.DomainCds,
            type: AppDomainPaths.TypeImg,
            fileName: file.FileName);

        return Ok(ApiResponse<object>.Ok(new
        {
            url = stored.Url,
            sha256 = stored.Sha256,
            mime = stored.Mime,
            sizeBytes = stored.SizeBytes,
        }));
    }

    internal static string? DetectImageMime(ReadOnlySpan<byte> data)
    {
        if (data.Length >= 8
            && data[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
            return "image/png";
        if (data.Length >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff)
            return "image/jpeg";
        if (data.Length >= 12
            && data[..4].SequenceEqual("RIFF"u8)
            && data.Slice(8, 4).SequenceEqual("WEBP"u8))
            return "image/webp";
        return null;
    }
}
