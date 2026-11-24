using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    private const int CommentFileLimit = 2 * 1024 * 1024;
    private const int CommentUploadLimit = 3 * CommentFileLimit + 64 * 1024;
    private static readonly JsonSerializerOptions CommentJson = new(JsonSerializerDefaults.Web);

    [HttpPost("{siteId}/comments")]
    [Consumes("multipart/form-data")]
    [RequestSizeLimit(CommentUploadLimit)]
    [RequestFormLimits(MultipartBodyLengthLimit = CommentUploadLimit, ValueLengthLimit = 32 * 1024)]
    public Task<IActionResult> AddSiteCommentWithFiles(string siteId, [FromForm] string comment, [FromForm] List<IFormFile> files) =>
        ReadCommentWithFilesAsync(comment, files, (request, attachments) => SaveSiteCommentAsync(siteId, request, attachments));

    [HttpPost("shares/view/{token}/comments")]
    [Consumes("multipart/form-data")]
    [RequestSizeLimit(CommentUploadLimit)]
    [RequestFormLimits(MultipartBodyLengthLimit = CommentUploadLimit, ValueLengthLimit = 32 * 1024)]
    public Task<IActionResult> AddShareCommentWithFiles(string token, [FromQuery] string? password,
        [FromForm] string comment, [FromForm] List<IFormFile> files) =>
        ReadCommentWithFilesAsync(comment, files, (request, attachments) => SaveShareCommentAsync(token, password, request, attachments));

    [HttpGet("{siteId}/comments/{commentId}/attachments/{index:int}")]
    public async Task<IActionResult> DownloadSiteCommentFile(string siteId, string commentId, int index, CancellationToken ct) =>
        await DownloadCommentFileAsync(await _siteService.GetByIdAsync(siteId, GetUserId(), ct), GetUserId(), commentId, index, ct);

    [HttpGet("shares/view/{token}/comments/{commentId}/attachments/{index:int}")]
    [AllowAnonymous]
    public async Task<IActionResult> DownloadShareCommentFile(string token, string commentId, int index,
        [FromQuery] string? password, [FromQuery] string? siteId, CancellationToken ct)
    {
        var viewer = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var access = await _siteService.ResolveShareSiteAsync(token, siteId, password, viewer, ct);
        if (access.Error != null)
            return MapCommentError(access.Error, access.HttpStatus, access.ErrorCode, access.RetryAfterSeconds);
        return await DownloadCommentFileAsync(access.Site, viewer, commentId, index, ct);
    }

    private async Task<IActionResult> DownloadCommentFileAsync(HostedSite? site, string? viewer, string commentId, int index, CancellationToken ct)
    {
        if (site == null || !site.CommentsEnabled || index < 0 || index >= 3) return MissingCommentFile();
        var row = await _db.HostedSiteComments.Find(c => c.Id == commentId && c.SiteId == site.Id && !c.IsDeleted).FirstOrDefaultAsync(ct);
        if (row == null || index >= row.Attachments.Count) return MissingCommentFile();
        var canSeeHistory = viewer != null && await _siteService.CanEditSiteAsync(site, viewer, ct);
        if (!HostedSiteCommentRules.CanViewReviewVersion(HostedSiteCommentRules.StoredVersion(row), HostedSiteService.EffectiveContentVersion(site), canSeeHistory))
            return MissingCommentFile();
        if (row.ParentId != null && !await _db.HostedSiteComments.Find(c => c.Id == row.ParentId && c.SiteId == site.Id && !c.IsDeleted).AnyAsync(ct))
            return MissingCommentFile();

        var attachment = row.Attachments[index];
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(attachment.Data, "application/octet-stream", attachment.Name);
    }

    private IActionResult MissingCommentFile() => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "评论附件不存在或无权访问"));

    private async Task<IActionResult> ReadCommentWithFilesAsync(string json, IReadOnlyList<IFormFile> files,
        Func<AddSiteCommentRequest, IReadOnlyList<HostedSiteCommentFile>, Task<IActionResult>> save)
    {
        AddSiteCommentRequest? request;
        try { request = JsonSerializer.Deserialize<AddSiteCommentRequest>(json, CommentJson); }
        catch (JsonException) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "评论内容格式不正确")); }
        if (request == null || files.Count is < 1 or > 3 || files.Any(file => file.Length is < 1 or > CommentFileLimit))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "每条评论最多添加 3 个附件，每个附件最多 2 MB"));

        var attachments = new List<HostedSiteCommentFile>(files.Count);
        foreach (var file in files)
        {
            var name = Path.GetFileName(file.FileName.Replace('\\', '/'));
            name = new string(name.Where(character => !char.IsControl(character)).Take(180).ToArray());
            using var buffer = new MemoryStream((int)file.Length);
            await file.CopyToAsync(buffer, HttpContext.RequestAborted);
            var data = buffer.ToArray();
            attachments.Add(new HostedSiteCommentFile
            {
                Name = string.IsNullOrWhiteSpace(name) ? "附件" : name,
                Length = data.Length,
                Sha256 = Convert.ToHexString(SHA256.HashData(data)),
                Data = data,
            });
        }

        return await save(request, attachments);
    }
}
