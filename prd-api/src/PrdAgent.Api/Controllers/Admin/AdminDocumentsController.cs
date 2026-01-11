using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 文档（用于按需预览 PRD 原文，避免把大内容写进日志）
/// </summary>
[ApiController]
[Route("api/v1/admin/documents")]
[Authorize]
public class AdminDocumentsController : ControllerBase
{
    private readonly IDocumentService _documentService;
    private readonly IGroupService _groupService;

    public AdminDocumentsController(IDocumentService documentService, IGroupService groupService)
    {
        _documentService = documentService;
        _groupService = groupService;
    }

    /// <summary>
    /// 获取文档原始内容（用于后台日志/排障预览）
    /// 注意：仅 ADMIN 可调用；仍校验 documentId 必须是 group 当前绑定 PRD，避免任意读取。
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

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        // 安全兜底：即便是管理员，也只允许读取“该群组当前绑定的 PRD”
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


