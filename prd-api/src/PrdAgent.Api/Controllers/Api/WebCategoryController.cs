using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页/知识库自定义分类。任何登录用户都能管理自己的分类（按 OwnerUserId 隔离），
/// 并对绑定了生成器（Markdown 模板）的分类执行「按分类生成」→ 产出托管网页或知识库条目。
/// </summary>
[ApiController]
[Route("api/web-categories")]
[Authorize]
public class WebCategoryController : ControllerBase
{
    private readonly IWebCategoryService _categories;
    private readonly ILogger<WebCategoryController> _logger;

    public WebCategoryController(
        IWebCategoryService categories,
        ILogger<WebCategoryController> logger)
    {
        _categories = categories;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>列出我的全部分类</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var userId = GetUserId();
        var items = await _categories.ListAsync(userId, ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建分类</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] WebCategoryRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分类名称不能为空"));

        var userId = GetUserId();
        var created = await _categories.CreateAsync(userId, req.ToModel(), ct);
        return Ok(ApiResponse<object>.Ok(created));
    }

    /// <summary>更新分类</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] WebCategoryRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        var updated = await _categories.UpdateAsync(id, userId, req.ToModel(), ct);
        if (updated == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分类不存在或无权修改"));
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除分类</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var ok = await _categories.DeleteAsync(id, userId, ct);
        if (!ok)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分类不存在或无权删除"));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>按分类生成网页 / 知识库条目</summary>
    [HttpPost("{id}/generate")]
    public async Task<IActionResult> Generate(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var result = await _categories.GenerateAsync(id, userId, ct);
        return Ok(ApiResponse<object>.Ok(result));
    }
}

/// <summary>分类创建/更新请求体（创建与更新共用）</summary>
public class WebCategoryRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public int SortOrder { get; set; }
    /// <summary>none | skill | markdown</summary>
    public string? GeneratorType { get; set; }
    public string? GeneratorSkillId { get; set; }
    public string? GeneratorMarkdown { get; set; }
    /// <summary>web | document-store</summary>
    public string? GenerateTarget { get; set; }
    public string? GenerateStoreId { get; set; }

    public WebCategory ToModel() => new()
    {
        Name = Name ?? string.Empty,
        Description = Description,
        SortOrder = SortOrder,
        GeneratorType = GeneratorType ?? WebCategoryGeneratorType.None,
        GeneratorSkillId = GeneratorSkillId,
        GeneratorMarkdown = GeneratorMarkdown,
        GenerateTarget = GenerateTarget ?? WebCategoryGenerateTarget.Web,
        GenerateStoreId = GenerateStoreId,
    };
}
