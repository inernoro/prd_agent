using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

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
    private const int MaxDocumentSize = 10 * 1024 * 1024; // 10MB

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
        // 验证内容
        if (string.IsNullOrWhiteSpace(request.Content))
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.CONTENT_EMPTY, 
                "文档内容不能为空"));
        }

        // 验证大小
        if (request.Content.Length > MaxDocumentSize)
        {
            return StatusCode(StatusCodes.Status413PayloadTooLarge,
                ApiResponse<object>.Fail(
                    ErrorCodes.DOCUMENT_TOO_LARGE, 
                    "文档超出大小限制（最大10MB）"));
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

            _logger.LogInformation("Document uploaded: {Title}, Tokens: {Tokens}", 
                parsed.Title, parsed.TokenEstimate);

            return Ok(ApiResponse<UploadDocumentResponse>.Ok(response));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
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

