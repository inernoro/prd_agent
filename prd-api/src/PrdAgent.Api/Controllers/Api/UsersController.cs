using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Json;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 用户管理控制器
/// </summary>
[ApiController]
[Route("api/users")]
[Authorize]
[AdminController("users", AdminPermissionCatalog.UsersRead, WritePermission = AdminPermissionCatalog.UsersWrite)]
public class UsersController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<UsersController> _logger;
    private readonly ILoginAttemptService _loginAttemptService;
    private readonly IConfiguration _cfg;
    private readonly IAssetStorage _assetStorage;
    private readonly IIdGenerator _idGenerator;
    private static readonly Regex UsernameRegex = new(@"^[a-zA-Z0-9_]+$", RegexOptions.Compiled);
    private const long MaxAvatarUploadBytes = 5 * 1024 * 1024; // 5MB：头像应很小

    public UsersController(
        MongoDbContext db,
        ILogger<UsersController> logger,
        ILoginAttemptService loginAttemptService,
        IConfiguration cfg,
        IAssetStorage assetStorage,
        IIdGenerator idGenerator)
    {
        _db = db;
        _logger = logger;
        _loginAttemptService = loginAttemptService;
        _cfg = cfg;
        _assetStorage = assetStorage;
        _idGenerator = idGenerator;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private static (bool ok, string? error) ValidateUsername(string username)
    {
        if (string.IsNullOrWhiteSpace(username))
            return (false, "用户名不能为空");
        if (username.Length < 4 || username.Length > 32)
            return (false, "用户名长度需在4-32字符之间");
        if (!UsernameRegex.IsMatch(username))
            return (false, "用户名只能包含字母、数字和下划线");
        return (true, null);
    }

    private static (bool ok, string? error) ValidateAvatarFileName(string? avatarFileName)
    {
        if (string.IsNullOrWhiteSpace(avatarFileName)) return (true, null); // 允许清空
        var t = avatarFileName.Trim();
        if (t.Length > 120) return (false, "头像文件名过长");
        // 仅允许文件名，不允许路径/协议/查询串等
        if (t.Contains('/') || t.Contains('\\')) return (false, "头像文件名不允许包含路径分隔符");
        if (t.Contains("..")) return (false, "头像文件名不合法");
        if (!Regex.IsMatch(t, @"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")) return (false, "头像文件名不合法（仅允许字母数字及 . _ -）");
        return (true, null);
    }

    private static string? NormalizeAvatarImageExt(string? extOrDotExt)
    {
        var ext = (extOrDotExt ?? string.Empty).Trim().ToLowerInvariant();
        if (ext.StartsWith('.')) ext = ext[1..];
        if (string.IsNullOrWhiteSpace(ext)) return null;
        if (ext == "jpeg") ext = "jpg";
        return ext is "png" or "jpg" or "gif" or "webp" ? ext : null;
    }

    private static string? GuessAvatarImageExtFromMime(string? mime)
    {
        var m = (mime ?? string.Empty).Trim().ToLowerInvariant();
        if (m == "image/png") return "png";
        if (m == "image/jpeg") return "jpg";
        if (m == "image/gif") return "gif";
        if (m == "image/webp") return "webp";
        return null;
    }

    private static string GuessAvatarMimeFromExt(string ext)
    {
        var e = (ext ?? string.Empty).Trim().ToLowerInvariant();
        return e switch
        {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "application/octet-stream"
        };
    }

    private string? BuildAvatarUrl(User user)
        => AvatarUrlBuilder.Build(_cfg, user);

    /// <summary>
    /// 获取用户列表
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetUsers(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? role = null,
        [FromQuery] string? status = null,
        [FromQuery] string? search = null)
    {
        var filter = Builders<User>.Filter.Empty;

        if (!string.IsNullOrEmpty(role) && Enum.TryParse<UserRole>(role, true, out var r))
        {
            filter &= Builders<User>.Filter.Eq(u => u.Role, r);
        }

        if (!string.IsNullOrEmpty(status) && Enum.TryParse<UserStatus>(status, true, out var s))
        {
            filter &= Builders<User>.Filter.Eq(u => u.Status, s);
        }

        if (!string.IsNullOrEmpty(search))
        {
            filter &= Builders<User>.Filter.Or(
                Builders<User>.Filter.Regex(u => u.Username, new MongoDB.Bson.BsonRegularExpression(search, "i")),
                Builders<User>.Filter.Regex(u => u.DisplayName, new MongoDB.Bson.BsonRegularExpression(search, "i"))
            );
        }

        var total = await _db.Users.CountDocumentsAsync(filter);
        var users = await _db.Users.Find(filter)
            .SortByDescending(u => u.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        var items = await Task.WhenAll(users.Select(async u =>
        {
            var remaining = await _loginAttemptService.GetLockoutRemainingSecondsAsync(u.Username);
            return new UserListItem
            {
                UserId = u.UserId,
                Username = u.Username,
                DisplayName = u.DisplayName,
                Role = u.Role.ToString(),
                Status = u.Status.ToString(),
                UserType = u.UserType.ToString(),
                BotKind = u.UserType == UserType.Bot ? u.BotKind?.ToString() : null,
                AvatarFileName = u.AvatarFileName,
                AvatarUrl = BuildAvatarUrl(u),
                CreatedAt = u.CreatedAt,
                LastLoginAt = u.LastLoginAt,
                LastActiveAt = u.LastActiveAt,
                IsLocked = remaining > 0,
                LockoutRemainingSeconds = remaining,
                SystemRoleKey = u.SystemRoleKey
            };
        }));

        var response = new UserListResponse
        {
            Items = items.ToList(),
            Total = total,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<UserListResponse>.Ok(response));
    }

    /// <summary>
    /// 获取单个用户
    /// </summary>
    [HttpGet("{userId}")]
    public async Task<IActionResult> GetUser(string userId)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        var remaining = await _loginAttemptService.GetLockoutRemainingSecondsAsync(user.Username);
        var response = new UserDetailResponse
        {
            UserId = user.UserId,
            Username = user.Username,
            DisplayName = user.DisplayName,
            Role = user.Role.ToString(),
            Status = user.Status.ToString(),
            UserType = user.UserType.ToString(),
            BotKind = user.UserType == UserType.Bot ? user.BotKind?.ToString() : null,
            AvatarFileName = user.AvatarFileName,
            AvatarUrl = BuildAvatarUrl(user),
            CreatedAt = user.CreatedAt,
            LastLoginAt = user.LastLoginAt,
            LastActiveAt = user.LastActiveAt,
            IsLocked = remaining > 0,
            LockoutRemainingSeconds = remaining
        };

        return Ok(ApiResponse<UserDetailResponse>.Ok(response));
    }

    /// <summary>
    /// 更新用户头像（仅保存“头像文件名”，不保存域名/完整URL）
    /// </summary>
    [HttpPut("{userId}/avatar")]
    public async Task<IActionResult> UpdateUserAvatar(string userId, [FromBody] UpdateAvatarRequest request, CancellationToken ct)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        var fileName = (request?.AvatarFileName ?? string.Empty).Trim();
        fileName = string.IsNullOrWhiteSpace(fileName) ? null : fileName.ToLowerInvariant();

        var (ok2, err2) = ValidateAvatarFileName(fileName);
        if (!ok2) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err2 ?? "头像文件名不合法"));

        var update = Builders<User>.Update.Set(u => u.AvatarFileName, fileName);
        await _db.Users.UpdateOneAsync(u => u.UserId == userId, update, cancellationToken: ct);

        return Ok(ApiResponse<UserAvatarUpdateResponse>.Ok(new UserAvatarUpdateResponse
        {
            UserId = userId,
            AvatarFileName = fileName,
            UpdatedAt = DateTime.UtcNow
        }));
    }

    /// <summary>
    /// 上传并更新用户头像（上传图片 -> 覆盖写 COS -> 更新 users.avatarFileName）
    /// 约束：
    /// - 仅支持图片：png/jpg/gif/webp
    /// - 头像文件名固定为 {username}.{ext}（全小写）
    /// </summary>
    [HttpPost("{userId}/avatar/upload")]
    [RequestSizeLimit(MaxAvatarUploadBytes)]
    [ProducesResponseType(typeof(ApiResponse<UserAvatarUploadResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UploadUserAvatar([FromRoute] string userId, [FromForm] IFormFile file, CancellationToken ct)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));

        var user = await _db.Users.Find(u => u.UserId == uid).FirstOrDefaultAsync(ct);
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        if (file == null || file.Length <= 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        if (file.Length > MaxAvatarUploadBytes)
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大"));

        // 仅图片：优先从文件名扩展名推断，其次从 MIME 推断
        var ext = NormalizeAvatarImageExt(Path.GetExtension(file.FileName ?? string.Empty));
        var mime = (file.ContentType ?? string.Empty).Trim();
        if (ext == null)
        {
            ext = GuessAvatarImageExtFromMime(mime);
        }
        if (ext == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片格式：png/jpg/gif/webp"));
        }

        // 如果 MIME 不可信/为空，回填为与 ext 匹配的标准值
        if (string.IsNullOrWhiteSpace(mime) || mime == "application/octet-stream")
        {
            mime = GuessAvatarMimeFromExt(ext);
        }
        // 再次兜底：要求 MIME 必须是 image/*
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片上传"));
        }

        // 固定文件名策略：{username}.{ext}
        var usernameLower = (user.Username ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(usernameLower))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "用户数据异常：username 为空"));

        var avatarFileName = $"{usernameLower}.{ext}".ToLowerInvariant();
        var (ok, err) = ValidateAvatarFileName(avatarFileName);
        if (!ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "头像文件名不合法"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{avatarFileName}".ToLowerInvariant();

        if (_assetStorage is not TencentCosStorage cos)
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));

        await cos.UploadBytesAsync(objectKey, bytes, mime, ct);

        var now = DateTime.UtcNow;
        var update = Builders<User>.Update.Set(u => u.AvatarFileName, avatarFileName);
        await _db.Users.UpdateOneAsync(u => u.UserId == uid, update, cancellationToken: ct);

        user.AvatarFileName = avatarFileName;
        var avatarUrl = BuildAvatarUrl(user);

        _logger.LogInformation("Admin uploaded user avatar. userId={UserId} file={File} size={Size}",
            uid, avatarFileName, bytes.Length);

        return Ok(ApiResponse<UserAvatarUploadResponse>.Ok(new UserAvatarUploadResponse
        {
            UserId = uid,
            AvatarFileName = avatarFileName,
            AvatarUrl = avatarUrl,
            UpdatedAt = now
        }));
    }

    /// <summary>
    /// 创建用户（管理员）
    /// </summary>
    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateUser([FromBody] AdminCreateUserRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_users_create" && x.IdempotencyKey == idemKey)
                .FirstOrDefaultAsync(ct);
            if (cached != null && !string.IsNullOrWhiteSpace(cached.PayloadJson))
            {
                try
                {
                    var payload = JsonSerializer.Deserialize<JsonElement>(cached.PayloadJson);
                    return Ok(ApiResponse<object>.Ok(payload));
                }
                catch
                {
                    // ignore：幂等记录损坏时，降级为正常处理
                }
            }
        }

        var username = (request?.Username ?? string.Empty).Trim();
        var (uOk, uErr) = ValidateUsername(username);
        if (!uOk) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, uErr ?? "用户名不合法"));

        var displayName = (request?.DisplayName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(displayName)) displayName = username;
        if (displayName.Length > 50)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "显示名称不能超过50字符"));

        var roleRaw = (request?.Role ?? string.Empty).Trim();
        if (!Enum.TryParse<UserRole>(roleRaw, ignoreCase: true, out var role))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "role 不合法（PM/DEV/QA/ADMIN）"));

        var password = request?.Password ?? string.Empty;
        if (string.IsNullOrWhiteSpace(password))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "密码不能为空"));

        // 管理后台创建用户：不强制复杂度规则（避免与“用户名只能字母数字下划线”产生误导/冲突）
        // 仅保留非空与最大长度保护
        if (password.Length > 128)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "密码长度不能超过128位"));

        var existed = await _db.Users.Find(u => u.Username == username).Limit(1).FirstOrDefaultAsync(ct);
        if (existed != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.USERNAME_EXISTS, "用户名已存在"));

        var user = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = username,
            DisplayName = displayName,
            Role = role,
            Status = UserStatus.Active,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
            CreatedAt = DateTime.UtcNow
        };

        try
        {
            await _db.Users.InsertOneAsync(user, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.USERNAME_EXISTS, "用户名已存在"));
        }

        _logger.LogWarning("Admin created user: username={Username}, role={Role}", user.Username, user.Role);

        var payload2 = new AdminCreateUserResponse
        {
            UserId = user.UserId,
            Username = user.Username,
            DisplayName = user.DisplayName,
            Role = user.Role.ToString(),
            Status = user.Status.ToString(),
            CreatedAt = user.CreatedAt
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerAdminId = adminId,
                Scope = "admin_users_create",
                IdempotencyKey = idemKey,
                PayloadJson = JsonSerializer.Serialize(payload2),
                CreatedAt = DateTime.UtcNow
            };
            try
            {
                await _db.AdminIdempotencyRecords.InsertOneAsync(rec, cancellationToken: ct);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // ignore：并发写入同一 idemKey，保持幂等
            }
        }

        return Ok(ApiResponse<object>.Ok(payload2));
    }

    /// <summary>
    /// 批量创建用户（管理员）
    /// </summary>
    [HttpPost("bulk")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> BulkCreateUsers([FromBody] AdminBulkCreateUsersRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_users_bulk_create" && x.IdempotencyKey == idemKey)
                .FirstOrDefaultAsync(ct);
            if (cached != null && !string.IsNullOrWhiteSpace(cached.PayloadJson))
            {
                try
                {
                    var payload = JsonSerializer.Deserialize<JsonElement>(cached.PayloadJson);
                    return Ok(ApiResponse<object>.Ok(payload));
                }
                catch
                {
                    // ignore
                }
            }
        }

        var items = request?.Items ?? new List<AdminBulkCreateUserItem>();
        if (items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "items 不能为空"));
        if (items.Count > 200)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "批量创建数量过大（上限 200）"));

        var failed = new List<AdminBulkCreateUserError>();
        var valid = new List<(string username, string displayName, UserRole role, string password)>();

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var it in items)
        {
            var username = (it?.Username ?? string.Empty).Trim();
            var (uOk, uErr) = ValidateUsername(username);
            if (!uOk)
            {
                failed.Add(new AdminBulkCreateUserError { Username = username, Code = ErrorCodes.INVALID_FORMAT, Message = uErr ?? "用户名不合法" });
                continue;
            }

            if (!seen.Add(username))
            {
                failed.Add(new AdminBulkCreateUserError { Username = username, Code = ErrorCodes.INVALID_FORMAT, Message = "用户名重复" });
                continue;
            }

            var displayName = (it?.DisplayName ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(displayName)) displayName = username;
            if (displayName.Length > 50)
            {
                failed.Add(new AdminBulkCreateUserError { Username = username, Code = ErrorCodes.INVALID_FORMAT, Message = "显示名称不能超过50字符" });
                continue;
            }

            var roleRaw = (it?.Role ?? string.Empty).Trim();
            if (!Enum.TryParse<UserRole>(roleRaw, ignoreCase: true, out var role))
            {
                failed.Add(new AdminBulkCreateUserError { Username = username, Code = ErrorCodes.INVALID_FORMAT, Message = "role 不合法（PM/DEV/QA/ADMIN）" });
                continue;
            }

            var password = it?.Password ?? string.Empty;
            if (string.IsNullOrWhiteSpace(password))
            {
                failed.Add(new AdminBulkCreateUserError { Username = username, Code = ErrorCodes.INVALID_FORMAT, Message = "密码不能为空" });
                continue;
            }
            if (password.Length > 128)
            {
                failed.Add(new AdminBulkCreateUserError { Username = username, Code = ErrorCodes.INVALID_FORMAT, Message = "密码长度不能超过128位" });
                continue;
            }

            valid.Add((username, displayName, role, password));
        }

        // 已存在用户名（一次性查询）
        var validUsernames = valid.Select(x => x.username).ToArray();
        var existedUsernames = await _db.Users
            .Find(u => validUsernames.Contains(u.Username))
            .Project(u => u.Username)
            .ToListAsync(ct);

        var existedSet = new HashSet<string>(existedUsernames, StringComparer.Ordinal);
        foreach (var un in existedSet)
        {
            failed.Add(new AdminBulkCreateUserError { Username = un, Code = ErrorCodes.USERNAME_EXISTS, Message = "用户名已存在" });
        }

        var toCreate = valid.Where(x => !existedSet.Contains(x.username)).ToList();
        var docs = new List<User>();
        foreach (var x in toCreate)
        {
            docs.Add(new User
            {
                UserId = await _idGenerator.GenerateIdAsync("user"),
                Username = x.username,
                DisplayName = x.displayName,
                Role = x.role,
                Status = UserStatus.Active,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(x.password),
                CreatedAt = DateTime.UtcNow
            });
        }

        if (docs.Count > 0)
        {
            try
            {
                await _db.Users.InsertManyAsync(docs, new InsertManyOptions { IsOrdered = false }, ct);
            }
            catch (MongoBulkWriteException<User> ex)
            {
                // 处理并发导致的重复用户名
                foreach (var we in ex.WriteErrors)
                {
                    if (we.Category != ServerErrorCategory.DuplicateKey) continue;
                    if (we.Index < 0 || we.Index >= docs.Count) continue;
                    var username = docs[we.Index].Username;
                    failed.Add(new AdminBulkCreateUserError { Username = username, Code = ErrorCodes.USERNAME_EXISTS, Message = "用户名已存在" });
                }

                // 从成功列表中剔除失败的重复项
                var dupSet = new HashSet<string>(
                    failed.Where(x => x.Code == ErrorCodes.USERNAME_EXISTS).Select(x => x.Username),
                    StringComparer.Ordinal);
                docs = docs.Where(d => !dupSet.Contains(d.Username)).ToList();
            }
        }

        var createdItems = docs.Select(u => new AdminCreateUserResponse
        {
            UserId = u.UserId,
            Username = u.Username,
            DisplayName = u.DisplayName,
            Role = u.Role.ToString(),
            Status = u.Status.ToString(),
            CreatedAt = u.CreatedAt
        }).ToList();

        var payload2 = new AdminBulkCreateUsersResponse
        {
            RequestedCount = items.Count,
            CreatedCount = createdItems.Count,
            FailedCount = failed.Count,
            CreatedItems = createdItems,
            FailedItems = failed
        };

        _logger.LogWarning(
            "Admin bulk created users: requested={Requested} created={Created} failed={Failed}",
            payload2.RequestedCount,
            payload2.CreatedCount,
            payload2.FailedCount);

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerAdminId = adminId,
                Scope = "admin_users_bulk_create",
                IdempotencyKey = idemKey,
                PayloadJson = JsonSerializer.Serialize(payload2),
                CreatedAt = DateTime.UtcNow
            };
            try
            {
                await _db.AdminIdempotencyRecords.InsertOneAsync(rec, cancellationToken: ct);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // ignore
            }
        }

        return Ok(ApiResponse<object>.Ok(payload2));
    }

    /// <summary>
    /// 解除登录锁定（管理员）
    /// </summary>
    [HttpPost("{userId}/unlock")]
    [ProducesResponseType(typeof(ApiResponse<UnlockUserResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UnlockUser(string userId)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));
        }

        var user = await _db.Users.Find(u => u.UserId == uid).FirstOrDefaultAsync();
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        await _loginAttemptService.UnlockAsync(user.Username);
        _logger.LogInformation("Admin unlocked user login lockout: userId={UserId}, username={Username}", uid, user.Username);

        return Ok(ApiResponse<UnlockUserResponse>.Ok(new UnlockUserResponse
        {
            UserId = uid,
            Username = user.Username,
            UnlockedAt = DateTime.UtcNow
        }));
    }

    /// <summary>
    /// 更新用户状态
    /// </summary>
    [HttpPut("{userId}/status")]
    public async Task<IActionResult> UpdateStatus(string userId, [FromBody] UpdateStatusRequest request)
    {
        var result = await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.Status, request.Status));

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        _logger.LogInformation("User {UserId} status updated to {Status}", userId, request.Status);

        var response = new UserStatusUpdateResponse
        {
            UserId = userId,
            Status = request.Status.ToString()
        };

        return Ok(ApiResponse<UserStatusUpdateResponse>.Ok(response));
    }

    /// <summary>
    /// 更新用户角色
    /// </summary>
    [HttpPut("{userId}/role")]
    public async Task<IActionResult> UpdateRole(string userId, [FromBody] UpdateRoleRequest request)
    {
        var result = await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.Role, request.Role));

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        _logger.LogInformation("User {UserId} role updated to {Role}", userId, request.Role);

        var response = new UserRoleUpdateResponse
        {
            UserId = userId,
            Role = request.Role.ToString()
        };

        return Ok(ApiResponse<UserRoleUpdateResponse>.Ok(response));
    }

    /// <summary>
    /// 修改用户密码（管理员）
    /// </summary>
    [HttpPut("{userId}/password")]
    public async Task<IActionResult> UpdatePassword(string userId, [FromBody] UpdatePasswordRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Password))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "密码不能为空"));
        }

        var passwordError = PasswordValidator.Validate(request.Password);
        if (passwordError != null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.WEAK_PASSWORD, passwordError));
        }

        var passwordHash = BCrypt.Net.BCrypt.HashPassword(request.Password);
        var result = await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.PasswordHash, passwordHash));

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        _logger.LogInformation("User {UserId} password updated by admin", userId);

        var response = new UserPasswordUpdateResponse
        {
            UserId = userId,
            UpdatedAt = DateTime.UtcNow
        };

        return Ok(ApiResponse<UserPasswordUpdateResponse>.Ok(response));
    }

    /// <summary>
    /// 修改用户显示名称（仅 Human；用于管理后台修正姓名展示）
    /// </summary>
    [HttpPut("{userId}/display-name")]
    public async Task<IActionResult> UpdateDisplayName(string userId, [FromBody] UpdateDisplayNameRequest request, CancellationToken ct)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));
        }

        var user = await _db.Users.Find(u => u.UserId == uid).FirstOrDefaultAsync(ct);
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        // 仅允许修改人类用户姓名（机器人账号为系统内置/服务账号，避免误改）
        if (user.UserType != UserType.Human)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅人类用户允许修改姓名"));
        }

        var name = (request?.DisplayName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "姓名不能为空"));
        }
        if (name.Length > 50)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "姓名不能超过50字符"));
        }

        await _db.Users.UpdateOneAsync(u => u.UserId == uid, Builders<User>.Update.Set(u => u.DisplayName, name), cancellationToken: ct);
        _logger.LogInformation("User {UserId} displayName updated by admin", uid);

        return Ok(ApiResponse<UserDisplayNameUpdateResponse>.Ok(new UserDisplayNameUpdateResponse
        {
            UserId = uid,
            DisplayName = name,
            UpdatedAt = DateTime.UtcNow
        }));
    }

    /// <summary>
    /// 生成邀请码
    /// </summary>
    [HttpPost("invite-codes")]
    public async Task<IActionResult> GenerateInviteCode([FromBody] GenerateInviteCodeRequest request)
    {
        var adminId = User.FindFirst("sub")?.Value ?? "system";
        var codes = new List<string>();

        for (int i = 0; i < request.Count; i++)
        {
            var code = $"PRD-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
            await _db.InviteCodes.InsertOneAsync(new InviteCode
            {
                Code = code,
                CreatorId = adminId,
                ExpiresAt = request.ExpiresInDays.HasValue 
                    ? DateTime.UtcNow.AddDays(request.ExpiresInDays.Value) 
                    : null
            });
            codes.Add(code);
        }

        var response = new InviteCodeGenerateResponse { Codes = codes };
        return Ok(ApiResponse<InviteCodeGenerateResponse>.Ok(response));
    }

    /// <summary>
    /// 初始化用户（删除所有用户并创建默认管理员和机器人账号）
    /// </summary>
    [HttpPost("initialize")]
    [ProducesResponseType(typeof(ApiResponse<InitializeUsersResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> InitializeUsers(CancellationToken ct)
    {
        var adminId = GetAdminId();
        _logger.LogWarning("Admin {AdminId} is initializing users (will delete all existing users)", adminId);

        // 1. 删除所有用户
        var deleteResult = await _db.Users.DeleteManyAsync(_ => true, ct);
        _logger.LogInformation("Deleted {Count} users", deleteResult.DeletedCount);

        // 2. 创建默认管理员账号 (admin/admin)
        var adminUser = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = "admin",
            PasswordHash = BCrypt.Net.BCrypt.HashPassword("admin"),
            DisplayName = "管理员",
            Role = UserRole.ADMIN,
            Status = UserStatus.Active,
            UserType = UserType.Human,
            CreatedAt = DateTime.UtcNow
        };
        await _db.Users.InsertOneAsync(adminUser, cancellationToken: ct);
        _logger.LogInformation("Created admin user: {UserId}", adminUser.UserId);

        // 3. 创建三个机器人账号（使用独立的 robot 序列）
        var botUsers = new List<User>();
        
        var botPm = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("robot"),
            Username = "bot_pm",
            DisplayName = "产品经理机器人",
            Role = UserRole.PM,
            Status = UserStatus.Active,
            UserType = UserType.Bot,
            BotKind = BotKind.PM,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword($"bot-secret-{Guid.NewGuid():N}"),
            CreatedAt = DateTime.UtcNow
        };
        botUsers.Add(botPm);

        var botDev = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("robot"),
            Username = "bot_dev",
            DisplayName = "开发机器人",
            Role = UserRole.DEV,
            Status = UserStatus.Active,
            UserType = UserType.Bot,
            BotKind = BotKind.DEV,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword($"bot-secret-{Guid.NewGuid():N}"),
            CreatedAt = DateTime.UtcNow
        };
        botUsers.Add(botDev);

        var botQa = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("robot"),
            Username = "bot_qa",
            DisplayName = "测试机器人",
            Role = UserRole.QA,
            Status = UserStatus.Active,
            UserType = UserType.Bot,
            BotKind = BotKind.QA,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword($"bot-secret-{Guid.NewGuid():N}"),
            CreatedAt = DateTime.UtcNow
        };
        botUsers.Add(botQa);

        await _db.Users.InsertManyAsync(botUsers, cancellationToken: ct);
        _logger.LogInformation("Created {Count} bot users", botUsers.Count);

        var response = new InitializeUsersResponse
        {
            DeletedCount = deleteResult.DeletedCount,
            AdminUserId = adminUser.UserId,
            BotUserIds = botUsers.Select(b => b.UserId).ToList()
        };

        return Ok(ApiResponse<InitializeUsersResponse>.Ok(response));
    }
}

public class UpdateStatusRequest
{
    public UserStatus Status { get; set; }
}

public class UpdateRoleRequest
{
    public UserRole Role { get; set; }
}

public class GenerateInviteCodeRequest
{
    public int Count { get; set; } = 1;
    public int? ExpiresInDays { get; set; }
}

public class UpdatePasswordRequest
{
    public string Password { get; set; } = string.Empty;
}

public class UpdateDisplayNameRequest
{
    public string DisplayName { get; set; } = string.Empty;
}

public class UpdateAvatarRequest
{
    public string? AvatarFileName { get; set; }
}

public class AdminCreateUserRequest
{
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    /// <summary>PM/DEV/QA/ADMIN</summary>
    public string Role { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
}

public class AdminBulkCreateUsersRequest
{
    public List<AdminBulkCreateUserItem> Items { get; set; } = new();
}

public class AdminBulkCreateUserItem
{
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    /// <summary>PM/DEV/QA/ADMIN</summary>
    public string Role { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
}




