using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 全局设置
/// </summary>
[ApiController]
[Route("api/v1/admin/settings")]
[Authorize(Roles = "ADMIN")]
public class AdminSettingsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AdminSettingsController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 获取 LLM 全局设置
    /// </summary>
    [HttpGet("llm")]
    public async Task<IActionResult> GetLlmSettings()
    {
        var settings = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync();
        if (settings == null)
        {
            settings = new AppSettings { Id = "global", EnablePromptCache = true, UpdatedAt = DateTime.UtcNow };
            await _db.AppSettings.InsertOneAsync(settings);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            settings.EnablePromptCache,
            settings.UpdatedAt
        }));
    }

    /// <summary>
    /// 更新 LLM 全局设置
    /// </summary>
    [HttpPut("llm")]
    public async Task<IActionResult> UpdateLlmSettings([FromBody] UpdateLlmSettingsRequest request)
    {
        var update = Builders<AppSettings>.Update
            .Set(s => s.EnablePromptCache, request.EnablePromptCache)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);

        var options = new UpdateOptions { IsUpsert = true };
        await _db.AppSettings.UpdateOneAsync(s => s.Id == "global", update, options);

        return Ok(ApiResponse<object>.Ok(new { request.EnablePromptCache }));
    }
}

public class UpdateLlmSettingsRequest
{
    public bool EnablePromptCache { get; set; } = true;
}


