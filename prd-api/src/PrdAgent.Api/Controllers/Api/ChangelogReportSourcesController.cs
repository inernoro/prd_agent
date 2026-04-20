using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 更新中心「周报来源」配置 CRUD。
/// 全员共享 —— 任何登录用户可创建 / 编辑 / 删除 / 排序。
/// 每条来源 = 一个展示名 + 绑定的知识库 ID + 文件名关键词。
/// 存储：changelog_report_sources 集合。
/// </summary>
[ApiController]
[Route("api/changelog/sources")]
[Authorize]
[AdminController("changelog", AdminPermissionCatalog.Access)]
public class ChangelogReportSourcesController : ControllerBase
{
    private readonly MongoDbContext _db;

    public ChangelogReportSourcesController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>列出所有周报来源（按 SortOrder、CreatedAt 排序）</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var items = await _db.ChangelogReportSources
            .Find(FilterDefinition<ChangelogReportSource>.Empty)
            .SortBy(s => s.SortOrder)
            .ThenBy(s => s.CreatedAt)
            .ToListAsync(ct)
            .ConfigureAwait(false);
        return Ok(ApiResponse<List<ChangelogReportSourceDto>>.Ok(
            items.ConvertAll(MapDto)));
    }

    /// <summary>创建新周报来源</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] ChangelogReportSourceUpsertDto body, CancellationToken ct)
    {
        var err = Validate(body);
        if (err != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err));

        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;
        var src = new ChangelogReportSource
        {
            Name = body.Name!.Trim(),
            StoreId = body.StoreId!.Trim(),
            Prefix = (body.Prefix ?? string.Empty).Trim(),
            Description = string.IsNullOrWhiteSpace(body.Description) ? null : body.Description!.Trim(),
            SortOrder = body.SortOrder ?? 0,
            CreatedBy = userId,
            UpdatedBy = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ChangelogReportSources.InsertOneAsync(src, cancellationToken: ct).ConfigureAwait(false);
        return Ok(ApiResponse<ChangelogReportSourceDto>.Ok(MapDto(src)));
    }

    /// <summary>更新周报来源（全员可编辑）</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] ChangelogReportSourceUpsertDto body, CancellationToken ct)
    {
        var err = Validate(body);
        if (err != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err));

        var userId = this.GetRequiredUserId();
        var update = Builders<ChangelogReportSource>.Update
            .Set(s => s.Name, body.Name!.Trim())
            .Set(s => s.StoreId, body.StoreId!.Trim())
            .Set(s => s.Prefix, (body.Prefix ?? string.Empty).Trim())
            .Set(s => s.Description, string.IsNullOrWhiteSpace(body.Description) ? null : body.Description!.Trim())
            .Set(s => s.SortOrder, body.SortOrder ?? 0)
            .Set(s => s.UpdatedBy, userId)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);
        var result = await _db.ChangelogReportSources.UpdateOneAsync(
            s => s.Id == id, update, cancellationToken: ct).ConfigureAwait(false);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "周报来源不存在"));

        var updated = await _db.ChangelogReportSources
            .Find(s => s.Id == id).FirstOrDefaultAsync(ct).ConfigureAwait(false);
        return Ok(ApiResponse<ChangelogReportSourceDto>.Ok(MapDto(updated!)));
    }

    /// <summary>删除周报来源（全员可删除）</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var result = await _db.ChangelogReportSources
            .DeleteOneAsync(s => s.Id == id, ct).ConfigureAwait(false);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "周报来源不存在"));
        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    private static string? Validate(ChangelogReportSourceUpsertDto body)
    {
        if (body == null) return "请求体不能为空";
        if (string.IsNullOrWhiteSpace(body.Name)) return "名称不能为空";
        if (body.Name.Length > 60) return "名称过长（上限 60 字符）";
        if (string.IsNullOrWhiteSpace(body.StoreId)) return "请选择知识库";
        if ((body.Prefix ?? string.Empty).Length > 120) return "关键词过长（上限 120 字符）";
        if ((body.Description ?? string.Empty).Length > 300) return "描述过长（上限 300 字符）";
        return null;
    }

    private static ChangelogReportSourceDto MapDto(ChangelogReportSource s) => new()
    {
        Id = s.Id,
        Name = s.Name,
        StoreId = s.StoreId,
        Prefix = s.Prefix,
        Description = s.Description,
        SortOrder = s.SortOrder,
        CreatedBy = s.CreatedBy,
        UpdatedBy = s.UpdatedBy,
        CreatedAt = s.CreatedAt.ToString("o"),
        UpdatedAt = s.UpdatedAt.ToString("o"),
    };

    public sealed class ChangelogReportSourceDto
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string StoreId { get; set; } = string.Empty;
        public string Prefix { get; set; } = string.Empty;
        public string? Description { get; set; }
        public int SortOrder { get; set; }
        public string CreatedBy { get; set; } = string.Empty;
        public string UpdatedBy { get; set; } = string.Empty;
        public string CreatedAt { get; set; } = string.Empty;
        public string UpdatedAt { get; set; } = string.Empty;
    }

    public sealed class ChangelogReportSourceUpsertDto
    {
        public string? Name { get; set; }
        public string? StoreId { get; set; }
        public string? Prefix { get; set; }
        public string? Description { get; set; }
        public int? SortOrder { get; set; }
    }
}
