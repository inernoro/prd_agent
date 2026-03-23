using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 会话控制器
/// </summary>
[ApiController]
[Route("api/v1/sessions")]
[Authorize]
public class SessionsController : ControllerBase
{
    private readonly ISessionService _sessionService;
    private readonly IDocumentService _documentService;
    private readonly MongoDbContext _db;
    private readonly ILogger<SessionsController> _logger;
    private readonly IFileContentExtractor _fileContentExtractor;

    /// <summary>文件上传允许的文档 MIME 类型（不含图片）</summary>
    private static readonly HashSet<string> AllowedDocumentMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "text/plain", "text/markdown", "text/csv", "text/html", "text/xml",
        "application/pdf", "application/json", "application/xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-powerpoint",
    };

    /// <summary>扩展名→MIME 推断（浏览器可能发送 octet-stream）</summary>
    private static readonly Dictionary<string, string> ExtensionToMime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".md"] = "text/markdown", [".mdc"] = "text/markdown", [".txt"] = "text/plain",
        [".csv"] = "text/csv", [".json"] = "application/json", [".xml"] = "application/xml",
        [".html"] = "text/html", [".htm"] = "text/html",
        [".pdf"] = "application/pdf",
        [".doc"] = "application/msword",
        [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".xls"] = "application/vnd.ms-excel",
        [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        [".ppt"] = "application/vnd.ms-powerpoint",
        [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };

    /// <summary>20 MB per file</summary>
    private const long MaxUploadBytes = 20 * 1024 * 1024;

    public SessionsController(
        ISessionService sessionService,
        IDocumentService documentService,
        MongoDbContext db,
        ILogger<SessionsController> logger,
        IFileContentExtractor fileContentExtractor)
    {
        _sessionService = sessionService;
        _documentService = documentService;
        _db = db;
        _logger = logger;
        _fileContentExtractor = fileContentExtractor;
    }

    private static string? GetUserId(ClaimsPrincipal user)
        => user.FindFirst("sub")?.Value ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    private async Task<bool> IsAdminAsync(string userId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userId)) return false;
        var u = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        return u?.Role == UserRole.ADMIN;
    }

    private async Task<bool> CanAccessSessionAsync(Session session, string userId, CancellationToken ct = default)
    {
        if (session == null || string.IsNullOrWhiteSpace(userId)) return false;
        if (session.DeletedAtUtc != null) return false;

        // 个人会话：必须 owner
        if (!string.IsNullOrWhiteSpace(session.OwnerUserId))
        {
            return string.Equals(session.OwnerUserId, userId, StringComparison.Ordinal);
        }

        // 群组会话：必须是成员（ADMIN 也需要是成员，避免“跨群随便读”）
        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            var gid = session.GroupId.Trim();
            var count = await _db.GroupMembers.CountDocumentsAsync(
                x => x.GroupId == gid && x.UserId == userId,
                cancellationToken: ct);
            return count > 0;
        }

        // 兜底：无 owner / 无 groupId 的异常数据，拒绝访问
        return false;
    }

    /// <summary>
    /// 获取会话列表（IM 形态：个人会话）
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<SessionListResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListSessions([FromQuery] bool includeArchived = false, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var filter = Builders<Session>.Filter.Eq(x => x.OwnerUserId, userId)
                     & Builders<Session>.Filter.Eq(x => x.DeletedAtUtc, null);
        if (!includeArchived)
        {
            filter &= Builders<Session>.Filter.Eq(x => x.ArchivedAtUtc, null);
        }

        var items = await _db.Sessions
            .Find(filter)
            .SortByDescending(x => x.LastActiveAt)
            .Limit(200)
            .ToListAsync(ct);

        return Ok(ApiResponse<SessionListResponse>.Ok(new SessionListResponse
        {
            Items = items.Select(MapToResponse).ToList()
        }));
    }

    /// <summary>
    /// 获取会话信息
    /// </summary>
    [HttpGet("{sessionId}")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetSession(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.SESSION_NOT_FOUND, 
                "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        // 读操作也视为“活跃”：用于桌面端/管理端做轻量 keep-alive
        await _sessionService.RefreshActivityAsync(sessionId);

        var response = MapToResponse(session);
        return Ok(ApiResponse<SessionResponse>.Ok(response));
    }

    /// <summary>
    /// 切换角色
    /// </summary>
    [HttpPut("{sessionId}/role")]
    [ProducesResponseType(typeof(ApiResponse<SwitchRoleResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> SwitchRole(string sessionId, [FromBody] SwitchRoleRequest request, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        // 仅 ADMIN 允许“切换回答机器人”（语义：选择 bot，而不是更改成员身份）
        var isAdmin = await IsAdminAsync(userId, ct);
        if (!isAdmin)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        try
        {
            var session = await _sessionService.SwitchRoleAsync(sessionId, request.Role);

            // 个人会话仅允许 owner 切换；群会话只允许群成员切换（用于调试）
            var canAccess = await CanAccessSessionAsync(session, userId, ct);
            if (!canAccess)
            {
                return StatusCode(StatusCodes.Status403Forbidden,
                    ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
            }
            
            var response = new SwitchRoleResponse
            {
                SessionId = session.SessionId,
                CurrentRole = session.CurrentRole
            };

            _logger.LogInformation("Session {SessionId} role switched to {Role}", 
                sessionId, request.Role);

            return Ok(ApiResponse<SwitchRoleResponse>.Ok(response));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.SESSION_NOT_FOUND, 
                "会话不存在或已过期"));
        }
    }

    /// <summary>
    /// 删除会话
    /// </summary>
    [HttpDelete("{sessionId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> DeleteSession(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }
        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        await _sessionService.DeleteAsync(sessionId);
        return NoContent();
    }

    /// <summary>
    /// 归档会话（个人会话 IM 形态）
    /// </summary>
    [HttpPost("{sessionId}/archive")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Archive(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        // 群会话暂不支持归档（避免影响群内共享对话体验）
        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "群会话不支持归档"));
        }

        var now = DateTime.UtcNow;
        await _db.Sessions.UpdateOneAsync(
            x => x.SessionId == session.SessionId && x.DeletedAtUtc == null,
            Builders<Session>.Update
                .Set(x => x.ArchivedAtUtc, now)
                .Set(x => x.LastActiveAt, now),
            cancellationToken: ct);

        var updated = await _sessionService.GetByIdAsync(session.SessionId);
        if (updated == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }
        return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
    }

    /// <summary>
    /// 取消归档会话
    /// </summary>
    [HttpPost("{sessionId}/unarchive")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Unarchive(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "群会话不支持归档"));
        }

        var now = DateTime.UtcNow;
        await _db.Sessions.UpdateOneAsync(
            x => x.SessionId == session.SessionId && x.DeletedAtUtc == null,
            Builders<Session>.Update
                .Set(x => x.ArchivedAtUtc, null)
                .Set(x => x.LastActiveAt, now),
            cancellationToken: ct);

        var updated = await _sessionService.GetByIdAsync(session.SessionId);
        if (updated == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }
        return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
    }

    /// <summary>
    /// 向会话追加文档（多文档支持）
    /// </summary>
    [HttpPost("{sessionId}/documents")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> AddDocument(string sessionId, [FromBody] AddDocumentToSessionRequest request, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (string.IsNullOrWhiteSpace(request.Content))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档内容不能为空"));
        }

        // 内容验证
        var validationResult = DocumentValidator.Validate(request.Content);
        if (!validationResult.IsValid)
        {
            return BadRequest(ApiResponse<object>.Fail(
                validationResult.ErrorCode!,
                validationResult.ErrorMessage!));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        // 解析并保存文档
        var parsed = await _documentService.ParseAsync(request.Content);
        await _documentService.SaveAsync(parsed);

        // 追加到会话（含文档类型）
        var docType = string.IsNullOrWhiteSpace(request.DocumentType) ? "reference" : request.DocumentType.Trim().ToLowerInvariant();
        var updated = await _sessionService.AddDocumentAsync(sessionId, parsed.Id, docType);

        _logger.LogInformation("Document added to session {SessionId}: {Title}, Chars: {Chars}",
            sessionId, parsed.Title, parsed.CharCount);

        return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
    }

    /// <summary>
    /// 向会话追加文档（文件上传，支持 PDF/Word/Excel/PPT/文本）
    /// </summary>
    [HttpPost("{sessionId}/documents/upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> UploadDocument(
        string sessionId,
        [FromForm] IFormFile file,
        [FromQuery] string? documentType = null,
        CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择要上传的文件"));

        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail("FILE_TOO_LARGE", $"文件大小不能超过 {MaxUploadBytes / 1024 / 1024}MB"));

        // MIME 推断（浏览器可能发送 octet-stream）
        var mime = file.ContentType?.ToLowerInvariant() ?? "application/octet-stream";
        if (mime == "application/octet-stream" && file.FileName != null)
        {
            var ext = Path.GetExtension(file.FileName);
            if (!string.IsNullOrEmpty(ext) && ExtensionToMime.TryGetValue(ext, out var inferred))
                mime = inferred;
        }

        if (!AllowedDocumentMimeTypes.Contains(mime))
            return BadRequest(ApiResponse<object>.Fail("UNSUPPORTED_TYPE", $"不支持的文件类型: {mime}"));

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        // 读取文件字节并提取文本
        byte[] bytes;
        using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        string? content;
        if (_fileContentExtractor.IsSupported(mime))
        {
            content = _fileContentExtractor.Extract(bytes, mime, file.FileName);
        }
        else
        {
            content = System.Text.Encoding.UTF8.GetString(bytes);
        }

        if (string.IsNullOrWhiteSpace(content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法从文件中提取文本内容"));

        // 内容验证
        var validationResult = DocumentValidator.Validate(content);
        if (!validationResult.IsValid)
            return BadRequest(ApiResponse<object>.Fail(validationResult.ErrorCode!, validationResult.ErrorMessage!));

        // 解析并保存文档（文件名作为标题提示）
        var parsed = await _documentService.ParseAsync(content);

        // 如果解析后标题为空，用文件名作为标题
        if (string.IsNullOrWhiteSpace(parsed.Title) && !string.IsNullOrWhiteSpace(file.FileName))
        {
            parsed.Title = Path.GetFileNameWithoutExtension(file.FileName);
        }

        await _documentService.SaveAsync(parsed);

        var docType = string.IsNullOrWhiteSpace(documentType) ? "reference" : documentType.Trim().ToLowerInvariant();
        var updated = await _sessionService.AddDocumentAsync(sessionId, parsed.Id, docType);

        _logger.LogInformation(
            "Document uploaded to session {SessionId}: {Title}, Chars: {Chars}, MIME: {Mime}",
            sessionId, parsed.Title, parsed.CharCount, mime);

        return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
    }

    /// <summary>
    /// 从会话移除文档
    /// </summary>
    [HttpDelete("{sessionId}/documents/{documentId}")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> RemoveDocument(string sessionId, string documentId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        try
        {
            var updated = await _sessionService.RemoveDocumentAsync(sessionId, documentId);
            _logger.LogInformation("Document removed from session {SessionId}: {DocumentId}", sessionId, documentId);
            return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 更新文档类型
    /// </summary>
    [HttpPatch("{sessionId}/documents/{documentId}/type")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateDocumentType(string sessionId, string documentId, [FromBody] UpdateDocumentTypeRequest request, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        if (!request.IsValid())
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的文档类型，可选值：product/technical/design/reference"));

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        if (!session.GetAllDocumentIds().Contains(documentId))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "文档不在当前会话中"));

        var updated = await _sessionService.UpdateDocumentTypeAsync(sessionId, documentId, request.DocumentType.ToLowerInvariant());
        return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
    }

    private static List<SessionDocumentMetaDto> BuildDocumentMetas(Session session)
    {
        return session.GetAllDocumentIds().Select(did => new SessionDocumentMetaDto
        {
            DocumentId = did,
            DocumentType = session.GetDocumentType(did),
        }).ToList();
    }

    private static SessionResponse MapToResponse(Session session)
    {
        return new SessionResponse
        {
            SessionId = session.SessionId,
            GroupId = session.GroupId,
            OwnerUserId = session.OwnerUserId,
            DocumentId = session.DocumentId,
            DocumentIds = session.GetAllDocumentIds(),
            DocumentMetas = BuildDocumentMetas(session),
            Title = session.Title,
            CurrentRole = session.CurrentRole,
            Mode = session.Mode,
            CreatedAt = session.CreatedAt,
            LastActiveAt = session.LastActiveAt,
            ArchivedAtUtc = session.ArchivedAtUtc,
            DeletedAtUtc = session.DeletedAtUtc
        };
    }
}
