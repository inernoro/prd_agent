using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 文学创作提示词管理（按场景分类，全局共享）
/// </summary>
[ApiController]
[Route("api/v1/admin/literary-prompts")]
[Authorize]
[AdminController("literary-agent", AdminPermissionCatalog.AgentUse)]
public class AdminLiteraryPromptsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AdminLiteraryPromptsController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    /// <summary>
    /// 获取指定场景的提示词列表（支持全局共享）
    /// </summary>
    /// <param name="scenarioType">场景类型（可选）：null/"global"=全局，"article-illustration"=文章配图，"image-gen"=图片生成</param>
    /// <param name="ct"></param>
    /// <returns></returns>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? scenarioType, CancellationToken ct)
    {
        var filter = Builders<LiteraryPrompt>.Filter.Empty;

        // 场景筛选：支持全局共享（scenarioType=null/"global"）+ 指定场景
        if (!string.IsNullOrWhiteSpace(scenarioType) && scenarioType != "global")
        {
            // 查询：scenarioType == 指定值 OR scenarioType == null/"global"（全局共享）
            filter = Builders<LiteraryPrompt>.Filter.Or(
                Builders<LiteraryPrompt>.Filter.Eq(x => x.ScenarioType, scenarioType),
                Builders<LiteraryPrompt>.Filter.Eq(x => x.ScenarioType, null),
                Builders<LiteraryPrompt>.Filter.Eq(x => x.ScenarioType, "global")
            );
        }

        var items = await _db.LiteraryPrompts
            .Find(filter)
            .SortBy(x => x.ScenarioType)
            .ThenBy(x => x.Order)
            .ThenByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 创建提示词
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateLiteraryPromptRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "title 不能为空"));
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "content 不能为空"));

        var scenarioType = string.IsNullOrWhiteSpace(request.ScenarioType) || request.ScenarioType == "global"
            ? null
            : request.ScenarioType.Trim();

        // 自动计算 order：同一场景下最大 order + 1
        var maxOrder = await _db.LiteraryPrompts
            .Find(x => x.ScenarioType == scenarioType)
            .SortByDescending(x => x.Order)
            .Project(x => x.Order)
            .FirstOrDefaultAsync(ct);

        var prompt = new LiteraryPrompt
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            Title = request.Title.Trim(),
            Content = request.Content.Trim(),
            ScenarioType = scenarioType,
            Order = maxOrder + 1,
            IsSystem = false,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.LiteraryPrompts.InsertOneAsync(prompt, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { prompt }));
    }

    /// <summary>
    /// 更新提示词
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateLiteraryPromptRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var prompt = await _db.LiteraryPrompts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (prompt == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提示词不存在"));

        // 只有创建者可以编辑
        if (prompt.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限编辑此提示词"));

        if (!string.IsNullOrWhiteSpace(request.Title))
            prompt.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Content))
            prompt.Content = request.Content.Trim();
        if (request.ScenarioType != null)
        {
            prompt.ScenarioType = string.IsNullOrWhiteSpace(request.ScenarioType) || request.ScenarioType == "global"
                ? null
                : request.ScenarioType.Trim();
        }
        if (request.Order.HasValue && request.Order.Value > 0)
            prompt.Order = request.Order.Value;

        prompt.UpdatedAt = DateTime.UtcNow;

        await _db.LiteraryPrompts.ReplaceOneAsync(x => x.Id == id, prompt, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { prompt }));
    }

    /// <summary>
    /// 删除提示词
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var prompt = await _db.LiteraryPrompts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (prompt == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提示词不存在"));

        // 只有创建者可以删除
        if (prompt.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限删除此提示词"));

        // 系统预置不可删除
        if (prompt.IsSystem)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "系统预置提示词不可删除"));

        await _db.LiteraryPrompts.DeleteOneAsync(x => x.Id == id, ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }
}

public class CreateLiteraryPromptRequest
{
    public string Title { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string? ScenarioType { get; set; }
}

public class UpdateLiteraryPromptRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? ScenarioType { get; set; }
    public int? Order { get; set; }
}
