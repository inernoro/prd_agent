using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services;
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
    private readonly IAuthSessionService _authSessionService;
    private readonly IConfiguration _cfg;
    private readonly ILogger<AuthController> _logger;

    public AuthController(
        IUserService userService, 
        IJwtService jwtService,
        ILoginAttemptService loginAttemptService,
        IAuthSessionService authSessionService,
        IConfiguration cfg,
        ILogger<AuthController> logger)
    {
        _userService = userService;
        _jwtService = jwtService;
        _loginAttemptService = loginAttemptService;
        _authSessionService = authSessionService;
        _cfg = cfg;
        _logger = logger;
    }

    private bool IsRootEnabled()
    {
        var u = (_cfg["RootAccess:Username"] ?? string.Empty).Trim();
        var p = (_cfg["RootAccess:Password"] ?? string.Empty).Trim();
        return !string.IsNullOrWhiteSpace(u) && !string.IsNullOrWhiteSpace(p);
    }

    private bool IsRootCredential(string username, string password)
    {
        if (!IsRootEnabled()) return false;
        var u = (_cfg["RootAccess:Username"] ?? string.Empty).Trim();
        var p = (_cfg["RootAccess:Password"] ?? string.Empty).Trim();
        return string.Equals(u, (username ?? string.Empty).Trim(), StringComparison.Ordinal)
               && string.Equals(p, (password ?? string.Empty).Trim(), StringComparison.Ordinal);
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
            // 验证请求参数
            var (isValid, errorMessage) = request.Validate();
            if (!isValid)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
            }

            // 验证密码强度
            var passwordError = PasswordValidator.Validate(request.Password);
            if (passwordError != null)
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.WEAK_PASSWORD, 
                    passwordError));
            }

            // 验证邀请码
            var isInviteCodeValid = await _userService.ValidateInviteCodeAsync(request.InviteCode);
            if (!isInviteCodeValid)
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
        // 验证请求参数
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        // 检查是否被锁定
        if (await _loginAttemptService.IsLockedAsync(request.Username))
        {
            var remainingSeconds = await _loginAttemptService.GetLockoutRemainingSecondsAsync(request.Username);
            return StatusCode(StatusCodes.Status429TooManyRequests,
                ApiResponse<object>.Fail(
                    ErrorCodes.ACCOUNT_LOCKED,
                    $"账号已被锁定，请在 {remainingSeconds} 秒后重试"));
        }

        var ct = (request.ClientType ?? string.Empty).Trim().ToLowerInvariant();

        // root 破窗账户：不落库，固定“账号+密码”来自环境变量，重启生效
        if (ct == "admin" && IsRootCredential(request.Username, request.Password))
        {
            var rootUser = new User
            {
                UserId = "root",
                Username = "root",
                DisplayName = "ROOT",
                Role = UserRole.ADMIN,
                Status = UserStatus.Active
            };

            var tokenVersionRoot = await _authSessionService.GetTokenVersionAsync(rootUser.UserId, ct);
            var (sessionKeyRoot, refreshTokenRoot) = await _authSessionService.CreateRefreshSessionAsync(rootUser.UserId, ct);
            var accessTokenRoot = _jwtService.GenerateAccessToken(rootUser, ct, sessionKeyRoot, tokenVersionRoot);

            var responseRoot = new LoginResponse
            {
                AccessToken = accessTokenRoot,
                RefreshToken = refreshTokenRoot,
                SessionKey = sessionKeyRoot,
                ClientType = ct,
                ExpiresIn = 3600,
                User = new UserInfo
                {
                    UserId = rootUser.UserId,
                    Username = rootUser.Username,
                    DisplayName = rootUser.DisplayName,
                    Role = rootUser.Role,
                    UserType = rootUser.UserType,
                    BotKind = rootUser.BotKind,
                    AvatarFileName = null,
                    AvatarUrl = null
                }
            };

            _logger.LogWarning("ROOT login used (clientType=admin)");
            return Ok(ApiResponse<LoginResponse>.Ok(responseRoot));
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
        // 同步 touch “最后操作时间”（登录也算一次操作）
        await _userService.UpdateLastActiveAsync(user.UserId);

        var tokenVersion = await _authSessionService.GetTokenVersionAsync(user.UserId, ct);
        var (sessionKey, refreshToken) = await _authSessionService.CreateRefreshSessionAsync(user.UserId, ct);
        var accessToken = _jwtService.GenerateAccessToken(user, ct, sessionKey, tokenVersion);

        var avatarUrl = AvatarUrlBuilder.Build(_cfg, user);

        var response = new LoginResponse
        {
            AccessToken = accessToken,
            RefreshToken = refreshToken,
            SessionKey = sessionKey,
            ClientType = ct,
            ExpiresIn = 3600, // access token 默认 60 分钟（由 Jwt:AccessTokenMinutes 控制）
            User = new UserInfo
            {
                UserId = user.UserId,
                Username = user.Username,
                DisplayName = user.DisplayName,
                Role = user.Role,
                UserType = user.UserType,
                BotKind = user.BotKind,
                AvatarFileName = user.AvatarFileName,
                AvatarUrl = avatarUrl
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
        // 验证请求参数
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        var ct = (request.ClientType ?? string.Empty).Trim().ToLowerInvariant();
        var ok = await _authSessionService.ValidateRefreshTokenAsync(
            request.UserId,
            ct,
            request.SessionKey,
            request.RefreshToken);

        if (!ok)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "刷新令牌无效或已过期"));
        }

        // refresh 成功：签发新的 access token（tokenVersion 不变；踢下线通过 bump tokenVersion 实现）
        if (ct == "admin" && string.Equals((request.UserId ?? string.Empty).Trim(), "root", StringComparison.Ordinal) && IsRootEnabled())
        {
            var rootUser = new User
            {
                UserId = "root",
                Username = "root",
                DisplayName = "ROOT",
                Role = UserRole.ADMIN,
                Status = UserStatus.Active
            };
            var tokenVersionRoot = await _authSessionService.GetTokenVersionAsync(rootUser.UserId, ct);
            var accessTokenRoot = _jwtService.GenerateAccessToken(rootUser, ct, request.SessionKey, tokenVersionRoot);

            var responseRoot = new LoginResponse
            {
                AccessToken = accessTokenRoot,
                RefreshToken = request.RefreshToken,
                SessionKey = request.SessionKey,
                ClientType = ct,
                ExpiresIn = 3600,
                User = new UserInfo
                {
                    UserId = rootUser.UserId,
                    Username = rootUser.Username,
                    DisplayName = rootUser.DisplayName,
                    Role = rootUser.Role,
                    UserType = rootUser.UserType,
                    BotKind = rootUser.BotKind,
                    AvatarFileName = null,
                    AvatarUrl = null
                }
            };

            return Ok(ApiResponse<LoginResponse>.Ok(responseRoot));
        }

        var user = await _userService.GetByIdAsync(request.UserId!);
        if (user == null || user.Status == UserStatus.Disabled)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "账号无效"));
        }

        var tokenVersion = await _authSessionService.GetTokenVersionAsync(user.UserId, ct);
        var accessToken = _jwtService.GenerateAccessToken(user, ct, request.SessionKey, tokenVersion);

        var avatarUrl2 = AvatarUrlBuilder.Build(_cfg, user);

        var response = new LoginResponse
        {
            AccessToken = accessToken,
            RefreshToken = request.RefreshToken, // 本实现不旋转 refresh token（滑动续期已在 ValidateRefreshTokenAsync 中完成）
            SessionKey = request.SessionKey,
            ClientType = ct,
            ExpiresIn = 3600,
            User = new UserInfo
            {
                UserId = user.UserId,
                Username = user.Username,
                DisplayName = user.DisplayName,
                Role = user.Role,
                UserType = user.UserType,
                BotKind = user.BotKind,
                AvatarFileName = user.AvatarFileName,
                AvatarUrl = avatarUrl2
            }
        };

        return Ok(ApiResponse<LoginResponse>.Ok(response));
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
