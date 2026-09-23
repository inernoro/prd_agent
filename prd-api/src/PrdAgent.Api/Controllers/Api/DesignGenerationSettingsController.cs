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

    public DesignGenerationSettingsController(
        IDesignGenerationSettingsService settings,
        IAdminPermissionService permissions)
    {
        _settings = settings;
        _permissions = permissions;
    }

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        var settings = await _settings.GetAsync(CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(ToView(settings, await CanEditAsync())));
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] DesignGenerationSettingsUpdate request)
    {
        try
        {
            var saved = await _settings.SaveAsync(request ?? new DesignGenerationSettingsUpdate(), this.GetRequiredUserId(), CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(ToView(saved, canEdit: true)));
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

    internal static object ToView(DesignGenerationEffectiveSettings settings, bool canEdit)
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
            platformContract = DesignGenerationDefaults.PlatformContract,
            promptFingerprint = fingerprint,
            updatedAt = settings.UpdatedAt,
            updatedBy = settings.UpdatedByName,
            canEdit,
        };
    }
}
