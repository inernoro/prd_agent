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
public class DocumentsController : ControllerBase
{
    private readonly IDocumentService _documentService;
    private readonly ISessionService _sessionService;
    private readonly ILogger<DocumentsController> _logger;

    public DocumentsController(
        IDocumentService documentService,
        ISessionService sessionService,
        ILogger<DocumentsController> logger)
    {
        _documentService = documentService;
        _sessionService = sessionService;
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
            // 解析文档
            var parsed = await _documentService.ParseAsync(request.Content);
            
            // 保存文档（缓存）
            await _documentService.SaveAsync(parsed);
            
            // 创建会话
            var session = await _sessionService.CreateAsync(parsed.Id);

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
