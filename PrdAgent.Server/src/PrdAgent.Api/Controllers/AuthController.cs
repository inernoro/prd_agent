using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;

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
    private readonly ILoginAttemptService _loginAttemptService;
    private readonly ILogger<AuthController> _logger;

    public AuthController(
        IUserService userService, 
        IJwtService jwtService,
        ILoginAttemptService loginAttemptService,
        ILogger<AuthController> logger)
    {
        _userService = userService;
        _jwtService = jwtService;
        _loginAttemptService = loginAttemptService;
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
            // 验证密码强度
            var passwordError = PasswordValidator.Validate(request.Password);
            if (passwordError != null)
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.WEAK_PASSWORD, 
                    passwordError));
            }

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
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status429TooManyRequests)]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        // 检查是否被锁定
        if (await _loginAttemptService.IsLockedAsync(request.Username))
        {
            var remainingSeconds = await _loginAttemptService.GetLockoutRemainingSecondsAsync(request.Username);
            return StatusCode(StatusCodes.Status429TooManyRequests,
                ApiResponse<object>.Fail(
                    ErrorCodes.ACCOUNT_LOCKED,
                    $"账号已被锁定，请在 {remainingSeconds} 秒后重试"));
        }

        var user = await _userService.ValidateCredentialsAsync(request.Username, request.Password);
        
        if (user == null)
        {
            // 记录失败尝试
            await _loginAttemptService.RecordFailedAttemptAsync(request.Username);
            
            _logger.LogWarning("Failed login attempt for user: {Username}", request.Username);
            
            return Unauthorized(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_CREDENTIALS, 
                "用户名或密码错误"));
        }

        if (user.Status == UserStatus.Disabled)
        {
            return StatusCode(StatusCodes.Status403Forbidden, 
                ApiResponse<object>.Fail(ErrorCodes.ACCOUNT_DISABLED, "账号已被禁用"));
        }

        // 登录成功，重置失败次数
        await _loginAttemptService.ResetAttemptsAsync(request.Username);

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
    /// 验证密码强度
    /// </summary>
    [HttpPost("validate-password")]
    [ProducesResponseType(typeof(ApiResponse<PasswordValidationResponse>), StatusCodes.Status200OK)]
    public IActionResult ValidatePassword([FromBody] ValidatePasswordRequest request)
    {
        var error = PasswordValidator.Validate(request.Password);
        var score = PasswordValidator.GetStrengthScore(request.Password);

        var response = new PasswordValidationResponse
        {
            IsValid = error == null,
            Message = error,
            StrengthScore = score,
            StrengthLevel = score switch
            {
                >= 80 => "strong",
                >= 60 => "medium",
                >= 40 => "weak",
                _ => "very_weak"
            }
        };

        return Ok(ApiResponse<PasswordValidationResponse>.Ok(response));
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

/// <summary>
/// 密码验证请求
/// </summary>
public class ValidatePasswordRequest
{
    public string Password { get; set; } = string.Empty;
}

/// <summary>
/// 密码验证响应
/// </summary>
public class PasswordValidationResponse
{
    public bool IsValid { get; set; }
    public string? Message { get; set; }
    public int StrengthScore { get; set; }
    public string StrengthLevel { get; set; } = string.Empty;
}
