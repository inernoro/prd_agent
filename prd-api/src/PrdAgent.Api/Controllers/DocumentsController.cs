using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 文档控制器
/// </summary>
[ApiController]
[Route("api/v1/documents")]
[Authorize]
public class DocumentsController : ControllerBase
{
    private readonly IDocumentService _documentService;
    private readonly ISessionService _sessionService;
    private readonly IGroupService _groupService;
    private readonly ILogger<DocumentsController> _logger;

    private static string? GetUserId(ClaimsPrincipal user)
    {
        // 兼容 JwtBearer 默认 claim 映射（sub/nameid）与自定义（sub）
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
               ?? user.FindFirst("sub")?.Value
               ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
               ?? user.FindFirst("nameid")?.Value;
    }

    public DocumentsController(
        IDocumentService documentService,
        ISessionService sessionService,
        IGroupService groupService,
        ILogger<DocumentsController> logger)
    {
        _documentService = documentService;
        _sessionService = sessionService;
        _groupService = groupService;
        _logger = logger;
    }

    /// <summary>
    /// 上传PRD文档
    /// </summary>
    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<UploadDocumentResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status413PayloadTooLarge)]
    public async Task<IActionResult> Upload([FromBody] UploadDocumentRequest request)
    {
        // 验证请求参数
        var (isRequestValid, requestErrorMessage) = request.Validate();
        if (!isRequestValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, requestErrorMessage!));
        }

        // 综合验证：内容、大小、格式、Token数
        var validationResult = DocumentValidator.Validate(request.Content);
        if (!validationResult.IsValid)
        {
            var statusCode = validationResult.ErrorCode switch
            {
                "DOCUMENT_TOO_LARGE" => StatusCodes.Status413PayloadTooLarge,
                _ => StatusCodes.Status400BadRequest
            };

            return StatusCode(statusCode, ApiResponse<object>.Fail(
                validationResult.ErrorCode!,
                validationResult.ErrorMessage!));
        }

        try
        {
            var userId = GetUserId(User);
            if (string.IsNullOrWhiteSpace(userId))
            {
                return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
            }

            // 解析文档
            var parsed = await _documentService.ParseAsync(request.Content);
            
            // 保存文档（缓存）
            await _documentService.SaveAsync(parsed);
            
            // 创建会话
            var session = await _sessionService.CreateAsync(parsed.Id);
            // 个人会话：绑定 ownerUserId，便于 IM 形态的会话列表展示
            session.OwnerUserId = userId;
            // 标题：默认使用 PRD 标题（更复杂的标题生成由客户端/后台策略决定）
            session.Title = parsed.Title;
            await _sessionService.UpdateAsync(session);

            var response = new UploadDocumentResponse
            {
                SessionId = session.SessionId,
                Document = new DocumentInfo
                {
                    Id = parsed.Id,
                    Title = parsed.Title,
                    CharCount = parsed.CharCount,
                    TokenEstimate = parsed.TokenEstimate,
                    Sections = parsed.Sections.Select(SectionInfo.FromSection).ToList()
                }
            };

            _logger.LogInformation("Document uploaded: {Title}, Chars: {Chars}, Tokens: {Tokens}", 
                parsed.Title, parsed.CharCount, parsed.TokenEstimate);

            return Ok(ApiResponse<UploadDocumentResponse>.Ok(response));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 验证文档（不保存）
    /// </summary>
    [HttpPost("validate")]
    [ProducesResponseType(typeof(ApiResponse<DocumentValidationResponse>), StatusCodes.Status200OK)]
    public IActionResult ValidateDocument([FromBody] UploadDocumentRequest request)
    {
        // 验证请求参数
        var (isRequestValid, requestErrorMessage) = request.Validate();
        if (!isRequestValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, requestErrorMessage!));
        }

        var validationResult = DocumentValidator.Validate(request.Content);

        var response = new DocumentValidationResponse
        {
            IsValid = validationResult.IsValid,
            ErrorCode = validationResult.ErrorCode,
            ErrorMessage = validationResult.ErrorMessage,
            EstimatedTokens = validationResult.IsValid 
                ? validationResult.EstimatedTokens 
                : DocumentValidator.EstimateTokens(request.Content),
            MaxTokens = DocumentValidator.MaxTokens,
            CharCount = request.Content?.Length ?? 0,
            MaxSizeBytes = DocumentValidator.MaxDocumentSize
        };

        return Ok(ApiResponse<DocumentValidationResponse>.Ok(response));
    }

    /// <summary>
    /// 获取文档信息
    /// </summary>
    [HttpGet("{documentId}")]
    [ProducesResponseType(typeof(ApiResponse<DocumentInfo>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetDocument(string documentId)
    {
        var document = await _documentService.GetByIdAsync(documentId);
        
        if (document == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.DOCUMENT_NOT_FOUND, 
                "文档不存在或已过期"));
        }

        var response = new DocumentInfo
        {
            Id = document.Id,
            Title = document.Title,
            CharCount = document.CharCount,
            TokenEstimate = document.TokenEstimate,
            Sections = document.Sections.Select(SectionInfo.FromSection).ToList()
        };

        return Ok(ApiResponse<DocumentInfo>.Ok(response));
    }

    /// <summary>
    /// 获取文档原始内容（用于预览）
    /// </summary>
    [HttpGet("{documentId}/content")]
    [ProducesResponseType(typeof(ApiResponse<DocumentContentInfo>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetDocumentContent(string documentId, [FromQuery] string groupId)
    {
        if (string.IsNullOrWhiteSpace(groupId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupId 不能为空"));
        }

        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        // 必须是群组成员且该文档必须是群组当前绑定的 PRD，避免通过 hash 猜测 documentId 越权读取
        var isMember = await _groupService.IsMemberAsync(groupId, userId);
        if (!isMember)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));
        }

        if (!string.Equals(group.PrdDocumentId, documentId, StringComparison.OrdinalIgnoreCase))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "该文档未绑定到当前群组"));
        }

        var document = await _documentService.GetByIdAsync(documentId);
        if (document == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.DOCUMENT_NOT_FOUND,
                "文档不存在或已过期"));
        }

        // 注意：禁止在日志中记录 Content（PRD 原文）
        var response = new DocumentContentInfo
        {
            Id = document.Id,
            Title = document.Title,
            Content = document.RawContent,
            MermaidRenderCacheVersion = document.MermaidRenderCacheVersion,
            MermaidRenders = document.MermaidRenders
        };

        return Ok(ApiResponse<DocumentContentInfo>.Ok(response));
    }
}

/// <summary>
/// 文档验证响应
/// </summary>
public class DocumentValidationResponse
{
    public bool IsValid { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public int EstimatedTokens { get; set; }
    public int MaxTokens { get; set; }
    public int CharCount { get; set; }
    public int MaxSizeBytes { get; set; }
}
