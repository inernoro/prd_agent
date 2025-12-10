using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 用户认证控制器
/// </summary>
[ApiController]
[Route("api/v1/auth")]
public class AuthController : ControllerBase
{
    private readonly IUserService _userService;
    private readonly IJwtService _jwtService;
    private readonly ILogger<AuthController> _logger;

    public AuthController(
        IUserService userService, 
        IJwtService jwtService,
        ILogger<AuthController> logger)
    {
        _userService = userService;
        _jwtService = jwtService;
        _logger = logger;
    }

    /// <summary>
    /// 用户注册
    /// </summary>
    [HttpPost("register")]
    [ProducesResponseType(typeof(ApiResponse<RegisterResponse>), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request)
    {
        try
        {
            // 验证邀请码
            var isValid = await _userService.ValidateInviteCodeAsync(request.InviteCode);
            if (!isValid)
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.INVALID_INVITE_CODE, 
                    "邀请码无效或已使用"));
            }

            var user = await _userService.RegisterAsync(
                request.Username,
                request.Password,
                request.InviteCode,
                request.Role,
                request.DisplayName);

            var response = new RegisterResponse
            {
                UserId = user.UserId,
                Username = user.Username,
                Role = user.Role,
                CreatedAt = user.CreatedAt
            };

            _logger.LogInformation("User registered: {Username}", user.Username);

            return CreatedAtAction(nameof(Register), ApiResponse<RegisterResponse>.Ok(response));
        }
        catch (ArgumentException ex)
        {
            var errorCode = ex.Message.Contains("用户名") 
                ? ErrorCodes.USERNAME_EXISTS 
                : ErrorCodes.INVALID_INVITE_CODE;
            return BadRequest(ApiResponse<object>.Fail(errorCode, ex.Message));
        }
    }

    /// <summary>
    /// 用户登录
    /// </summary>
    [HttpPost("login")]
    [ProducesResponseType(typeof(ApiResponse<LoginResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        var user = await _userService.ValidateCredentialsAsync(request.Username, request.Password);
        
        if (user == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_CREDENTIALS, 
                "用户名或密码错误"));
        }

        if (user.Status == UserStatus.Disabled)
        {
            return StatusCode(StatusCodes.Status403Forbidden, 
                ApiResponse<object>.Fail(ErrorCodes.ACCOUNT_DISABLED, "账号已被禁用"));
        }

        // 更新最后登录时间
        await _userService.UpdateLastLoginAsync(user.UserId);

        var accessToken = _jwtService.GenerateAccessToken(user);
        var refreshToken = _jwtService.GenerateRefreshToken();

        var response = new LoginResponse
        {
            AccessToken = accessToken,
            RefreshToken = refreshToken,
            ExpiresIn = 86400, // 24小时
            User = new UserInfo
            {
                UserId = user.UserId,
                Username = user.Username,
                DisplayName = user.DisplayName,
                Role = user.Role
            }
        };

        _logger.LogInformation("User logged in: {Username}", user.Username);

        return Ok(ApiResponse<LoginResponse>.Ok(response));
    }

    /// <summary>
    /// 刷新令牌
    /// </summary>
    [HttpPost("refresh")]
    [ProducesResponseType(typeof(ApiResponse<LoginResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> RefreshToken([FromBody] RefreshTokenRequest request)
    {
        // TODO: 实现刷新令牌逻辑
        // 需要存储刷新令牌并验证
        await Task.CompletedTask;
        return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "刷新令牌无效"));
    }
}

