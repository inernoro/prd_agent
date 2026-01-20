using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 全局设置
/// </summary>
[ApiController]
[Route("api/v1/admin/settings")]
[Authorize]
[AdminController("admin-data", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
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
            requestBodyMaxChars = settings.RequestBodyMaxChars ?? LlmLogLimits.DefaultRequestBodyMaxChars,
            answerMaxChars = settings.AnswerMaxChars ?? LlmLogLimits.DefaultAnswerMaxChars,
            errorMaxChars = settings.ErrorMaxChars ?? LlmLogLimits.DefaultErrorMaxChars,
            httpLogBodyMaxChars = settings.HttpLogBodyMaxChars ?? LlmLogLimits.DefaultHttpLogBodyMaxChars,
            jsonFallbackMaxChars = settings.JsonFallbackMaxChars ?? LlmLogLimits.DefaultJsonFallbackMaxChars,
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

        if (request.RequestBodyMaxChars.HasValue)
            update = update.Set(s => s.RequestBodyMaxChars, request.RequestBodyMaxChars);
        if (request.AnswerMaxChars.HasValue)
            update = update.Set(s => s.AnswerMaxChars, request.AnswerMaxChars);
        if (request.ErrorMaxChars.HasValue)
            update = update.Set(s => s.ErrorMaxChars, request.ErrorMaxChars);
        if (request.HttpLogBodyMaxChars.HasValue)
            update = update.Set(s => s.HttpLogBodyMaxChars, request.HttpLogBodyMaxChars);
        if (request.JsonFallbackMaxChars.HasValue)
            update = update.Set(s => s.JsonFallbackMaxChars, request.JsonFallbackMaxChars);

        var options = new UpdateOptions { IsUpsert = true };
        await _db.AppSettings.UpdateOneAsync(s => s.Id == "global", update, options);

        // 刷新缓存
        var settingsService = HttpContext.RequestServices.GetRequiredService<PrdAgent.Core.Interfaces.IAppSettingsService>();
        await settingsService.RefreshAsync();

        return Ok(ApiResponse<object>.Ok(new
        {
            request.EnablePromptCache,
            requestBodyMaxChars = request.RequestBodyMaxChars ?? LlmLogLimits.DefaultRequestBodyMaxChars,
            answerMaxChars = request.AnswerMaxChars ?? LlmLogLimits.DefaultAnswerMaxChars,
            errorMaxChars = request.ErrorMaxChars ?? LlmLogLimits.DefaultErrorMaxChars,
            httpLogBodyMaxChars = request.HttpLogBodyMaxChars ?? LlmLogLimits.DefaultHttpLogBodyMaxChars,
            jsonFallbackMaxChars = request.JsonFallbackMaxChars ?? LlmLogLimits.DefaultJsonFallbackMaxChars
        }));
    }
}

public class UpdateLlmSettingsRequest
{
    public bool EnablePromptCache { get; set; } = true;
    public int? RequestBodyMaxChars { get; set; }
    public int? AnswerMaxChars { get; set; }
    public int? ErrorMaxChars { get; set; }
    public int? HttpLogBodyMaxChars { get; set; }
    public int? JsonFallbackMaxChars { get; set; }
}


