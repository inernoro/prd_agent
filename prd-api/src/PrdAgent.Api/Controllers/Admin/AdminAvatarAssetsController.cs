using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 头像/通用资源（单文件）
/// </summary>
[ApiController]
[Route("api/v1/admin/assets/avatars")]
[Authorize]
[AdminController("admin-assets", AdminPermissionCatalog.AssetsRead, WritePermission = AdminPermissionCatalog.AssetsWrite)]
public class AdminAvatarAssetsController : ControllerBase
{
    private readonly ILogger<AdminAvatarAssetsController> _logger;
    private readonly IAssetStorage _assetStorage;

    private const long MaxUploadBytes = 5 * 1024 * 1024; // 5MB：头像应很小

    public AdminAvatarAssetsController(ILogger<AdminAvatarAssetsController> logger, IAssetStorage assetStorage)
    {
        _logger = logger;
        _assetStorage = assetStorage;
    }

    /// <summary>
    /// 上传/替换无头像兜底图（固定覆盖写）：COS 对象 key 固定为 icon/backups/head/nohead.png（全小写，不分皮肤）。
    /// </summary>
    [HttpPost("nohead")]
    [RequestSizeLimit(MaxUploadBytes)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UploadNoHead([FromForm] IFormFile file, CancellationToken ct)
    {
        if (file == null || file.Length <= 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        if (file.Length > MaxUploadBytes)
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大"));

        var ext = Path.GetExtension(file.FileName ?? string.Empty).Trim().ToLowerInvariant();
        var mime = (file.ContentType ?? string.Empty).Trim();
        if (ext != ".png" && mime != "image/png")
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "nohead 仅支持 png 格式"));
        }

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{AvatarUrlBuilder.DefaultNoHeadFile}".ToLowerInvariant();

        if (_assetStorage is not TencentCosStorage cos)
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));

        await cos.UploadBytesAsync(objectKey, bytes, "image/png", ct);

        // 返回相对 URL（完整 URL 由前端/服务端统一规则拼接）
        var url = $"/{objectKey}";

        _logger.LogInformation("Uploaded nohead avatar. key={Key} size={Size}", objectKey, bytes.Length);

        return Ok(ApiResponse<object>.Ok(new
        {
            key = AvatarUrlBuilder.DefaultNoHeadFile,
            path = objectKey,
            url,
            mime = "image/png",
            sizeBytes = bytes.Length
        }));
    }
}


