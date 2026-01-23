using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 文档（用于按需预览知识库文档原文，避免把大内容写进日志）
/// </summary>
[ApiController]
[Route("api/data/documents")]
[Authorize]
[AdminController("data", AdminPermissionCatalog.DataRead, WritePermission = AdminPermissionCatalog.DataWrite)]
public class DocumentsController : ControllerBase
{
    private readonly IKnowledgeBaseService _kbService;
    private readonly IGroupService _groupService;

    public DocumentsController(IKnowledgeBaseService kbService, IGroupService groupService)
    {
        _kbService = kbService;
        _groupService = groupService;
    }

    /// <summary>
    /// 获取知识库文档文本内容（用于后台日志/排障预览）
    /// 注意：仅 ADMIN 可调用；仍校验 documentId 必须属于该群组的知识库，避免任意读取。
    /// </summary>
    [HttpGet("{documentId}/content")]
    [ProducesResponseType(typeof(ApiResponse<KbDocumentContentResponse>), StatusCodes.Status200OK)]
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

        // 安全兜底：校验该文档确实属于此群组的知识库
        var kbDoc = await _kbService.GetByIdAsync(documentId);
        if (kbDoc == null || !string.Equals(kbDoc.GroupId, groupId, StringComparison.Ordinal))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "该文档不属于当前群组的知识库"));
        }

        var response = new KbDocumentContentResponse
        {
            DocumentId = kbDoc.DocumentId,
            FileName = kbDoc.FileName,
            TextContent = kbDoc.TextContent
        };

        return Ok(ApiResponse<KbDocumentContentResponse>.Ok(response));
    }
}

public class KbDocumentContentResponse
{
    public string DocumentId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string? TextContent { get; set; }
}


