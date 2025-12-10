using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 会话控制器
/// </summary>
[ApiController]
[Route("api/v1/sessions")]
public class SessionsController : ControllerBase
{
    private readonly ISessionService _sessionService;
    private readonly ILogger<SessionsController> _logger;

    public SessionsController(
        ISessionService sessionService,
        ILogger<SessionsController> logger)
    {
        _sessionService = sessionService;
        _logger = logger;
    }

    /// <summary>
    /// 获取会话信息
    /// </summary>
    [HttpGet("{sessionId}")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetSession(string sessionId)
    {
        var session = await _sessionService.GetByIdAsync(sessionId);
        
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.SESSION_NOT_FOUND, 
                "会话不存在或已过期"));
        }

        var response = MapToResponse(session);
        return Ok(ApiResponse<SessionResponse>.Ok(response));
    }

    /// <summary>
    /// 切换角色
    /// </summary>
    [HttpPut("{sessionId}/role")]
    [ProducesResponseType(typeof(ApiResponse<SwitchRoleResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> SwitchRole(string sessionId, [FromBody] SwitchRoleRequest request)
    {
        try
        {
            var session = await _sessionService.SwitchRoleAsync(sessionId, request.Role);
            
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
    public async Task<IActionResult> DeleteSession(string sessionId)
    {
        await _sessionService.DeleteAsync(sessionId);
        return NoContent();
    }

    private static SessionResponse MapToResponse(Session session)
    {
        return new SessionResponse
        {
            SessionId = session.SessionId,
            GroupId = session.GroupId,
            DocumentId = session.DocumentId,
            CurrentRole = session.CurrentRole,
            Mode = session.Mode,
            GuideStep = session.GuideStep,
            CreatedAt = session.CreatedAt,
            LastActiveAt = session.LastActiveAt
        };
    }
}



