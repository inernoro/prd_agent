using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.OpenPlatform;

/// <summary>
/// 开放平台：API Key 管理（必须登录，Key 归属当前用户）
/// </summary>
[ApiController]
[Route("api/v1/open-platform/keys")]
[Authorize]
public sealed class OpenPlatformKeysController : ControllerBase
{
    private readonly IOpenPlatformApiKeyRepository _repo;
    private readonly IGroupService _groupService;

    public OpenPlatformKeysController(IOpenPlatformApiKeyRepository repo, IGroupService groupService)
    {
        _repo = repo;
        _groupService = groupService;
    }

    private static string? GetUserId(ClaimsPrincipal user)
        => user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
           ?? user.FindFirst("sub")?.Value
           ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? user.FindFirst("nameid")?.Value;

    [HttpGet]
    public async Task<IActionResult> ListMyKeys()
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var items = await _repo.ListByOwnerAsync(userId);
        var dto = items.Select(ToDto).ToList();
        return Ok(ApiResponse<List<OpenPlatformApiKeyDto>>.Ok(dto));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateOpenPlatformApiKeyRequest request)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var req = request ?? new CreateOpenPlatformApiKeyRequest();
        var (ok, err) = req.Validate();
        if (!ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "请求不合法"));

        // 授权群组必须是“当前用户所在的群组”（用户派生权限）
        foreach (var gid in req.GroupIds)
        {
            var isMember = await _groupService.IsMemberAsync(gid, userId);
            if (!isMember)
            {
                return StatusCode(StatusCodes.Status403Forbidden,
                    ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, $"无权限授权该群组：{gid}"));
            }
        }

        var keyId = Guid.NewGuid().ToString("N");
        var secret = GenerateSecretBase64Url(32);
        var apiKeyPlain = BuildApiKey(keyId, secret);

        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Sha256(salt, Encoding.UTF8.GetBytes(secret));

        var entity = new OpenPlatformApiKey
        {
            Id = keyId,
            OwnerUserId = userId,
            Name = req.Name,
            AllowedGroupIds = req.GroupIds,
            KeyPrefix = BuildKeyPrefix(keyId),
            SaltBase64 = Convert.ToBase64String(salt),
            SecretHashBase64 = Convert.ToBase64String(hash),
            CreatedAt = DateTime.UtcNow,
            LastUsedAt = null,
            RevokedAt = null
        };

        await _repo.InsertAsync(entity);

        return Ok(ApiResponse<CreateOpenPlatformApiKeyResponse>.Ok(new CreateOpenPlatformApiKeyResponse
        {
            ApiKey = apiKeyPlain,
            Key = ToDto(entity)
        }));
    }

    [HttpDelete("{keyId}")]
    public async Task<IActionResult> Revoke(string keyId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var id = (keyId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "keyId 不能为空"));

        var key = await _repo.GetByIdAsync(id);
        if (key == null || !string.Equals(key.OwnerUserId, userId, StringComparison.Ordinal))
        {
            // 统一提示，避免探测
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.OPEN_PLATFORM_KEY_NOT_FOUND, "Key 不存在"));
        }

        if (!key.RevokedAt.HasValue)
        {
            key.RevokedAt = DateTime.UtcNow;
            await _repo.ReplaceAsync(key);
        }

        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    private static OpenPlatformApiKeyDto ToDto(OpenPlatformApiKey x) => new()
    {
        Id = x.Id,
        OwnerUserId = x.OwnerUserId,
        Name = x.Name,
        KeyPrefix = x.KeyPrefix,
        AllowedGroupIds = x.AllowedGroupIds ?? new List<string>(),
        CreatedAt = x.CreatedAt,
        LastUsedAt = x.LastUsedAt,
        RevokedAt = x.RevokedAt
    };

    internal static string BuildApiKey(string keyId, string secret)
        => $"sk_prd_{keyId}_{secret}";

    internal static string BuildKeyPrefix(string keyId)
        => $"sk_prd_{keyId}_";

    private static string GenerateSecretBase64Url(int bytes)
    {
        var raw = RandomNumberGenerator.GetBytes(bytes);
        return Base64UrlEncode(raw);
    }

    private static string Base64UrlEncode(byte[] data)
    {
        var s = Convert.ToBase64String(data);
        s = s.Replace("+", "-").Replace("/", "_").TrimEnd('=');
        return s;
    }

    private static byte[] Sha256(byte[] salt, byte[] secret)
    {
        var all = new byte[salt.Length + secret.Length];
        Buffer.BlockCopy(salt, 0, all, 0, salt.Length);
        Buffer.BlockCopy(secret, 0, all, salt.Length, secret.Length);
        return SHA256.HashData(all);
    }
}

