using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 「我的风格」：每人自己的网页生成风格。只属于创建它的人——读、改、删、用于生成都按当前登录用户核对归属，
/// 别人的编号与不存在的一样返回 404（不暴露存在性）。读走网页托管读权限，写走写权限（与发起生成同一道闸）。
/// </summary>
[ApiController]
[Route("api/design-artifacts/personal-styles")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class PersonalDesignStylesController : ControllerBase
{
    private readonly IPersonalDesignStyleService _styles;
    private readonly IPersonalStyleDerivationService _derivation;
    private readonly IDesignSystemCatalog _catalog;

    public PersonalDesignStylesController(
        IPersonalDesignStyleService styles,
        IPersonalStyleDerivationService derivation,
        IDesignSystemCatalog catalog)
    {
        _styles = styles;
        _derivation = derivation;
        _catalog = catalog;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        var items = await _styles.ListAsync(this.GetRequiredUserId(), CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new
        {
            items = items.Select(ToView).ToList(),
            limit = PersonalDesignStyle.MaxPerUser,
        }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var style = await _styles.GetOwnedAsync(this.GetRequiredUserId(), id, CancellationToken.None);
        return style == null
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这套风格不存在或已被删除"))
            : Ok(ApiResponse<object>.Ok(ToView(style)));
    }

    /// <summary>
    /// 从自己的一张网页和/或一段描述里提取风格草稿（确定性解析 CSS，不调模型，通常一秒内返回）。
    /// 只返回草稿，不落库；用户审阅、改完再 POST 保存。
    /// </summary>
    [HttpPost("derive")]
    public async Task<IActionResult> Derive([FromBody] DerivePersonalStyleRequest request)
    {
        try
        {
            var draft = await _derivation.DeriveAsync(
                this.GetRequiredUserId(), request?.SiteId, request?.Note, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(draft));
        }
        catch (PersonalDesignStyleException ex)
        {
            return Failure(ex);
        }
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] PersonalDesignStyleInput request)
    {
        try
        {
            var style = await _styles.CreateAsync(this.GetRequiredUserId(), request ?? new PersonalDesignStyleInput(), CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(ToView(style)));
        }
        catch (PersonalDesignStyleException ex)
        {
            return Failure(ex);
        }
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] PersonalDesignStyleInput request)
    {
        try
        {
            var style = await _styles.UpdateAsync(this.GetRequiredUserId(), id, request ?? new PersonalDesignStyleInput(), CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(ToView(style)));
        }
        catch (PersonalDesignStyleException ex)
        {
            return Failure(ex);
        }
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        try
        {
            await _styles.DeleteAsync(this.GetRequiredUserId(), id, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
        }
        catch (PersonalDesignStyleException ex)
        {
            return Failure(ex);
        }
    }

    private IActionResult Failure(PersonalDesignStyleException ex)
    {
        var body = ApiResponse<object>.Fail(ex.Code, ex.Message);
        return ex.Code switch
        {
            ErrorCodes.NOT_FOUND => NotFound(body),
            ErrorCodes.PERMISSION_DENIED => StatusCode(403, body),
            ErrorCodes.QUOTA_EXCEEDED or ErrorCodes.DUPLICATE => Conflict(body),
            _ => BadRequest(body),
        };
    }

    private object ToView(PersonalDesignStyle style)
    {
        var baseEntry = _catalog.Find(style.BaseDesignSystemId);
        return new
        {
            style.Id,
            styleId = PersonalDesignStyle.StyleIdPrefix + style.Id,
            style.Name,
            style.Instruction,
            style.Swatches,
            style.Fonts,
            style.BaseDesignSystemId,
            baseDesignSystemName = baseEntry?.Name,
            // 骨架下线了就明说：生成时会拒绝并提示换一个，这里先在画廊上挂出来。
            baseDesignSystemAvailable = baseEntry != null,
            style.SourceSiteId,
            style.SourceSiteTitle,
            style.SourceNote,
            style.SystemFilledFields,
            style.CreatedAt,
            style.UpdatedAt,
        };
    }
}

public sealed class DerivePersonalStyleRequest
{
    public string? SiteId { get; set; }

    public string? Note { get; set; }
}
