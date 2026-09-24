using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页生成设置：默认执行器、自查强度、风格预设、三段可编辑提示词与只读平台契约。
/// 读：网页托管读权限（生成弹窗要用风格列表）；写：网页托管写权限。
/// </summary>
[ApiController]
[Route("api/design-artifacts/generation-settings")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class DesignGenerationSettingsController : ControllerBase
{
    private readonly IDesignGenerationSettingsService _settings;
    private readonly IAdminPermissionService _permissions;
    private readonly IDesignSystemCatalog _catalog;

    public DesignGenerationSettingsController(
        IDesignGenerationSettingsService settings,
        IAdminPermissionService permissions,
        IDesignSystemCatalog catalog)
    {
        _settings = settings;
        _permissions = permissions;
        _catalog = catalog;
    }

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        var settings = await _settings.GetAsync(CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(ToView(settings, await CanEditAsync(), _catalog)));
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] DesignGenerationSettingsUpdate request)
    {
        try
        {
            var saved = await _settings.SaveAsync(request ?? new DesignGenerationSettingsUpdate(), this.GetRequiredUserId(), CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(ToView(saved, canEdit: true, _catalog)));
        }
        catch (DesignGenerationSettingsException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    private async Task<bool> CanEditAsync()
    {
        var fromClaims = User.FindAll("permissions").Select(c => c.Value).ToList();
        if (fromClaims.Count > 0) return fromClaims.Contains(AdminPermissionCatalog.WebPagesWrite);
        if (string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal)) return true;
        var perms = await _permissions.GetEffectivePermissionsAsync(this.GetRequiredUserId(), false);
        return perms.Contains(AdminPermissionCatalog.WebPagesWrite);
    }

    /// <summary>
    /// 设置视图。每套风格的 <c>swatches</c> 是只读派生值（取自该风格设计系统的真实 tokens：[--fg, --bg, --accent]），
    /// PUT 时提交的 swatches 会被忽略；<c>swatchesReadOnly</c> 把这一点写进契约。
    /// <c>sampleUrl</c> 是该风格真实样张的地址（不含查询串，可追加 title / format），
    /// 设计系统不在快照里时为 null——没有真实样张就不给地址。
    /// </summary>
    internal static object ToView(DesignGenerationEffectiveSettings settings, bool canEdit, IDesignSystemCatalog catalog)
    {
        string? fingerprint = null;
        try { fingerprint = DesignGenerationSettingsService.Freeze(settings, null).PromptFingerprint; }
        catch (DesignGenerationSettingsException) { }
        return new
        {
            defaultRuntime = settings.DefaultRuntime,
            reviewMode = settings.ReviewMode,
            styles = settings.Styles.Select(style => new
            {
                style.Id,
                style.Name,
                style.Description,
                style.DesignSystemId,
                style.Swatches,
                sampleUrl = catalog.Find(style.DesignSystemId) is { } system
                    ? DesignSystemSampleRenderer.SamplePath(system.Id)
                    : null,
                style.Enabled,
                style.IsDefault,
                style.BuiltIn,
            }),
            prompts = new
            {
                generate = new
                {
                    value = settings.GeneratePrompt,
                    isDefault = settings.GeneratePromptIsDefault,
                    defaultValue = DesignGenerationDefaults.GeneratePrompt,
                },
                edit = new
                {
                    value = settings.EditPrompt,
                    isDefault = settings.EditPromptIsDefault,
                    defaultValue = DesignGenerationDefaults.EditPrompt,
                },
                review = new
                {
                    value = settings.ReviewPrompt,
                    isDefault = settings.ReviewPromptIsDefault,
                    defaultValue = DesignGenerationDefaults.ReviewPrompt,
                },
            },
            swatchesReadOnly = true,
            designSystemCatalog = new { engineVersion = catalog.EngineVersion, count = catalog.All.Count },
            platformContract = DesignGenerationDefaults.PlatformContract,
            promptFingerprint = fingerprint,
            updatedAt = settings.UpdatedAt,
            updatedBy = settings.UpdatedByName,
            canEdit,
        };
    }
}
