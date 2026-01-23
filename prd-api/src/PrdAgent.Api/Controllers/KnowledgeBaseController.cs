using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 知识库文档管理控制器
/// </summary>
[ApiController]
[Route("api/v1/groups/{groupId}/kb/documents")]
[Authorize]
public class KnowledgeBaseController : ControllerBase
{
    private readonly IKnowledgeBaseService _kbService;
    private readonly IGroupService _groupService;
    private readonly ILogger<KnowledgeBaseController> _logger;

    public KnowledgeBaseController(
        IKnowledgeBaseService kbService,
        IGroupService groupService,
        ILogger<KnowledgeBaseController> logger)
    {
        _kbService = kbService;
        _groupService = groupService;
        _logger = logger;
    }

    private static string? GetUserId(ClaimsPrincipal user)
    {
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
               ?? user.FindFirst("sub")?.Value
               ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
               ?? user.FindFirst("nameid")?.Value;
    }

    /// <summary>
    /// 获取群组知识库文档列表
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<List<KbDocumentResponse>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListDocuments(string groupId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        if (!await _groupService.IsMemberAsync(groupId, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));

        var docs = await _kbService.GetActiveDocumentsAsync(groupId);
        var response = docs.Select(MapToResponse).ToList();
        return Ok(ApiResponse<List<KbDocumentResponse>>.Ok(response));
    }

    /// <summary>
    /// 上传知识库文档（支持多文件）
    /// </summary>
    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<List<KbDocumentResponse>>), StatusCodes.Status201Created)]
    [RequestSizeLimit(110 * 1024 * 1024)] // 10 files * 10MB + overhead
    public async Task<IActionResult> UploadDocuments(
        string groupId,
        [FromForm] List<IFormFile> files,
        CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));

        if (group.OwnerId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可管理知识库"));

        if (files.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未选择文件"));

        if (files.Count > 10)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "单次最多上传10份文件"));

        var uploadFiles = new List<KbUploadFile>();
        foreach (var file in files)
        {
            using var ms = new MemoryStream();
            await file.CopyToAsync(ms, ct);
            uploadFiles.Add(new KbUploadFile
            {
                FileName = file.FileName,
                Content = ms.ToArray(),
                MimeType = file.ContentType,
                Size = file.Length
            });
        }

        try
        {
            var docs = await _kbService.UploadDocumentsAsync(groupId, userId, uploadFiles, ct);
            var response = docs.Select(MapToResponse).ToList();
            return StatusCode(201, ApiResponse<List<KbDocumentResponse>>.Ok(response));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 获取单个文档元信息
    /// </summary>
    [HttpGet("{documentId}")]
    [ProducesResponseType(typeof(ApiResponse<KbDocumentResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetDocument(string groupId, string documentId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        if (!await _groupService.IsMemberAsync(groupId, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));

        var doc = await _kbService.GetByIdAsync(documentId);
        if (doc == null || doc.GroupId != groupId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "文档不存在"));

        return Ok(ApiResponse<KbDocumentResponse>.Ok(MapToResponse(doc)));
    }

    /// <summary>
    /// 获取文档文本内容（用于预览）
    /// </summary>
    [HttpGet("{documentId}/content")]
    [ProducesResponseType(typeof(ApiResponse<KbDocumentContentResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetDocumentContent(string groupId, string documentId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        if (!await _groupService.IsMemberAsync(groupId, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));

        var doc = await _kbService.GetByIdAsync(documentId);
        if (doc == null || doc.GroupId != groupId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "文档不存在"));

        return Ok(ApiResponse<KbDocumentContentResponse>.Ok(new KbDocumentContentResponse
        {
            DocumentId = doc.DocumentId,
            FileName = doc.FileName,
            TextContent = doc.TextContent,
            FileUrl = doc.FileUrl
        }));
    }

    /// <summary>
    /// 替换文档
    /// </summary>
    [HttpPut("{documentId}")]
    [ProducesResponseType(typeof(ApiResponse<KbDocumentResponse>), StatusCodes.Status200OK)]
    [RequestSizeLimit(11 * 1024 * 1024)]
    public async Task<IActionResult> ReplaceDocument(
        string groupId,
        string documentId,
        [FromForm] IFormFile file,
        CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));

        if (group.OwnerId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可管理知识库"));

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        var uploadFile = new KbUploadFile
        {
            FileName = file.FileName,
            Content = ms.ToArray(),
            MimeType = file.ContentType,
            Size = file.Length
        };

        try
        {
            var doc = await _kbService.ReplaceDocumentAsync(documentId, groupId, uploadFile, ct);
            return Ok(ApiResponse<KbDocumentResponse>.Ok(MapToResponse(doc)));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 删除文档
    /// </summary>
    [HttpDelete("{documentId}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DeleteDocument(string groupId, string documentId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));

        if (group.OwnerId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可管理知识库"));

        try
        {
            await _kbService.DeleteDocumentAsync(documentId, groupId);
            return Ok(ApiResponse<object>.Ok(null));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    private static KbDocumentResponse MapToResponse(KbDocument doc)
    {
        return new KbDocumentResponse
        {
            DocumentId = doc.DocumentId,
            FileName = doc.FileName,
            FileType = doc.FileType.ToString().ToLowerInvariant(),
            FileSize = doc.FileSize,
            CharCount = doc.CharCount,
            TokenEstimate = doc.TokenEstimate,
            UploadedAt = doc.UploadedAt,
            ReplaceVersion = doc.ReplaceVersion,
            HasTextContent = doc.TextContent != null
        };
    }
}

public class KbDocumentResponse
{
    public string DocumentId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string FileType { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public int CharCount { get; set; }
    public int TokenEstimate { get; set; }
    public DateTime UploadedAt { get; set; }
    public int ReplaceVersion { get; set; }
    public bool HasTextContent { get; set; }
}

public class KbDocumentContentResponse
{
    public string DocumentId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string? TextContent { get; set; }
    public string FileUrl { get; set; } = string.Empty;
}
