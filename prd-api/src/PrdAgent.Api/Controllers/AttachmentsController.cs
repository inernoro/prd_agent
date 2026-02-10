using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 附件上传 Controller（Desktop / 通用客户端）
/// </summary>
[ApiController]
[Route("api/v1/attachments")]
[Authorize]
public class AttachmentsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<AttachmentsController> _logger;

    /// <summary>5 MB per file</summary>
    private const long MaxUploadBytes = 5 * 1024 * 1024;

    private static readonly HashSet<string> AllowedMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/svg+xml",
    };

    public AttachmentsController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        ILogger<AttachmentsController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    /// <summary>
    /// 上传附件（multipart/form-data）
    /// 返回 attachmentId + url，客户端在发送消息时将 attachmentId 关联到 message
    /// </summary>
    [HttpPost]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> Upload([FromForm] IFormFile file, CancellationToken ct)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", "请选择要上传的文件"));

        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail("FILE_TOO_LARGE", $"文件大小不能超过 {MaxUploadBytes / 1024 / 1024}MB"));

        var mime = file.ContentType?.ToLowerInvariant() ?? "application/octet-stream";
        if (!AllowedMimeTypes.Contains(mime))
            return BadRequest(ApiResponse<object>.Fail("UNSUPPORTED_TYPE", $"不支持的文件类型: {mime}"));

        var userId = User.FindFirst("userId")?.Value ?? User.FindFirst("sub")?.Value ?? "";
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        // 存储到 COS / 本地
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: "attachments", type: "chat");

        var attachment = new Attachment
        {
            UploaderId = userId,
            FileName = file.FileName,
            MimeType = mime,
            Size = file.Length,
            Url = stored.Url,
            Type = AttachmentType.Image,
            UploadedAt = DateTime.UtcNow,
        };

        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: ct);

        _logger.LogInformation(
            "Attachment uploaded: {AttachmentId} by {UserId}, size={Size}, mime={Mime}",
            attachment.AttachmentId, userId, file.Length, mime);

        return Ok(ApiResponse<object>.Ok(new
        {
            attachmentId = attachment.AttachmentId,
            url = attachment.Url,
            fileName = attachment.FileName,
            mimeType = attachment.MimeType,
            size = attachment.Size,
        }));
    }

    /// <summary>
    /// 获取附件信息
    /// </summary>
    [HttpGet("{attachmentId}")]
    public async Task<IActionResult> Get(string attachmentId, CancellationToken ct)
    {
        var filter = Builders<Attachment>.Filter.Eq(a => a.AttachmentId, attachmentId);
        var attachment = await _db.Attachments.Find(filter).FirstOrDefaultAsync(ct);

        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "附件不存在"));

        return Ok(ApiResponse<object>.Ok(new
        {
            attachmentId = attachment.AttachmentId,
            url = attachment.Url,
            fileName = attachment.FileName,
            mimeType = attachment.MimeType,
            size = attachment.Size,
            uploadedAt = attachment.UploadedAt,
        }));
    }
}
