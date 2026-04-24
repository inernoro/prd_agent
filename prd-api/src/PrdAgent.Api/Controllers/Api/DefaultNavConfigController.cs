using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 全局默认导航配置。
/// </summary>
[ApiController]
[Route("api/settings/default-nav")]
[Authorize]
[AdminController("settings", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public class DefaultNavConfigController : ControllerBase
{
    private readonly MongoDbContext _db;

    public DefaultNavConfigController(MongoDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var config = await _db.DefaultNavConfigs
            .Find(x => x.Id == "singleton")
            .FirstOrDefaultAsync(ct)
            ?? new DefaultNavConfig();

        return Ok(ApiResponse<DefaultNavConfigResponse>.Ok(DefaultNavConfigResponse.From(config)));
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] UpdateDefaultNavConfigRequest? request, CancellationToken ct)
    {
        var config = new DefaultNavConfig
        {
            Id = "singleton",
            NavOrder = request?.NavOrder ?? new List<string>(),
            NavHidden = request?.NavHidden ?? new List<string>(),
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefaultNavConfigs.ReplaceOneAsync(
            x => x.Id == "singleton",
            config,
            new ReplaceOptions { IsUpsert = true },
            ct);

        return Ok(ApiResponse<DefaultNavConfigResponse>.Ok(DefaultNavConfigResponse.From(config)));
    }

    [HttpPost("apply-to-all-users")]
    public async Task<IActionResult> ApplyToAllUsers(CancellationToken ct)
    {
        var update = Builders<UserPreferences>.Update
            .Set(x => x.NavOrder, new List<string>())
            .Set(x => x.NavHidden, new List<string>())
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var result = await _db.UserPreferences.UpdateManyAsync(
            Builders<UserPreferences>.Filter.Empty,
            update,
            cancellationToken: ct);

        return Ok(ApiResponse<ApplyDefaultNavToAllUsersResponse>.Ok(new ApplyDefaultNavToAllUsersResponse
        {
            MatchedCount = result.MatchedCount,
            ModifiedCount = result.ModifiedCount
        }));
    }
}

public class UpdateDefaultNavConfigRequest
{
    public List<string>? NavOrder { get; set; }
    public List<string>? NavHidden { get; set; }
}

public class DefaultNavConfigResponse
{
    public List<string> NavOrder { get; set; } = new();
    public List<string> NavHidden { get; set; } = new();
    public DateTime UpdatedAt { get; set; }

    public static DefaultNavConfigResponse From(DefaultNavConfig config)
    {
        return new DefaultNavConfigResponse
        {
            NavOrder = config.NavOrder ?? new List<string>(),
            NavHidden = config.NavHidden ?? new List<string>(),
            UpdatedAt = config.UpdatedAt
        };
    }
}

public class ApplyDefaultNavToAllUsersResponse
{
    public long MatchedCount { get; set; }
    public long ModifiedCount { get; set; }
}
