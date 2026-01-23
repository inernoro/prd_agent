using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

[ApiController]
[Route("api/v1/prd-comments")]
[Authorize]
public class PrdCommentsController : ControllerBase
{
    private readonly IGroupService _groupService;
    private readonly IUserService _userService;
    private readonly IPrdCommentRepository _commentRepo;
    private readonly IIdGenerator _idGenerator;

    private static string? GetUserId(ClaimsPrincipal user)
    {
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
               ?? user.FindFirst("sub")?.Value
               ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
               ?? user.FindFirst("nameid")?.Value;
    }

    public PrdCommentsController(
        IGroupService groupService, 
        IUserService userService, 
        IPrdCommentRepository commentRepo,
        IIdGenerator idGenerator)
    {
        _groupService = groupService;
        _userService = userService;
        _commentRepo = commentRepo;
        _idGenerator = idGenerator;
    }

    private async Task<(bool Ok, IActionResult? ErrorResult)> EnsureCanAccessDocumentAsync(string documentId, string groupId)
    {
        if (string.IsNullOrWhiteSpace(groupId))
        {
            return (false, BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupId 不能为空")));
        }

        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return (false, Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权")));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return (false, NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在")));
        }

        var isMember = await _groupService.IsMemberAsync(groupId, userId);
        if (!isMember)
        {
            return (false, StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员")));
        }

        // 知识库多文档：不再做单文档绑定校验（文档由 kb_documents 管理）

        return (true, null);
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<List<PrdCommentInfo>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> List([FromQuery] string documentId, [FromQuery] string groupId, [FromQuery] string? headingId, [FromQuery] int limit = 50)
    {
        if (string.IsNullOrWhiteSpace(documentId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "documentId 不能为空"));
        }

        var (ok, err) = await EnsureCanAccessDocumentAsync(documentId, groupId);
        if (!ok) return err!;

        var list = await _commentRepo.ListAsync(documentId, headingId, limit);
        var resp = list.Select(PrdCommentInfo.FromEntity).ToList();
        return Ok(ApiResponse<List<PrdCommentInfo>>.Ok(resp));
    }

    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<PrdCommentInfo>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Create([FromBody] CreatePrdCommentRequest request)
    {
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        var (ok, err) = await EnsureCanAccessDocumentAsync(request.DocumentId, request.GroupId);
        if (!ok) return err!;

        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var user = await _userService.GetByIdAsync(userId);
        if (user == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var entity = new PrdComment
        {
            Id = await _idGenerator.GenerateIdAsync("comment"),
            DocumentId = request.DocumentId.Trim(),
            HeadingId = request.HeadingId.Trim(),
            HeadingTitleSnapshot = (request.HeadingTitleSnapshot ?? string.Empty).Trim(),
            AuthorUserId = user.UserId,
            AuthorDisplayName = user.DisplayName,
            Content = request.Content.Trim(),
            CreatedAt = DateTime.UtcNow,
        };

        await _commentRepo.InsertAsync(entity);
        return Ok(ApiResponse<PrdCommentInfo>.Ok(PrdCommentInfo.FromEntity(entity)));
    }

    [HttpDelete("{commentId}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Delete(string commentId, [FromQuery] string groupId)
    {
        if (string.IsNullOrWhiteSpace(commentId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "commentId 不能为空"));
        }

        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var comment = await _commentRepo.GetByIdAsync(commentId);
        if (comment == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.PRD_COMMENT_NOT_FOUND, "评论不存在"));
        }

        var (ok, err) = await EnsureCanAccessDocumentAsync(comment.DocumentId, groupId);
        if (!ok) return err!;

        var user = await _userService.GetByIdAsync(userId);
        if (user == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (user.Role != UserRole.ADMIN && !string.Equals(comment.AuthorUserId, userId, StringComparison.OrdinalIgnoreCase))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅作者或管理员可删除评论"));
        }

        await _commentRepo.DeleteAsync(commentId);
        return Ok(ApiResponse<object>.Ok(new object()));
    }
}
