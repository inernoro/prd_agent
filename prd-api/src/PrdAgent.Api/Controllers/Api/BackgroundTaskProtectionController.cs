using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/logs/background-task-protection")]
[Authorize]
[AdminController("logs", AdminPermissionCatalog.LogsRead)]
public sealed class BackgroundTaskProtectionController(BackgroundTaskAdmissionRegistry registry) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(ApiResponse<object>.Ok(new
    {
        sourceDeployment = registry.SourceDeployment,
        sharedAutomaticEnabled = registry.SharedAutomaticEnabled,
        tasks = registry.Snapshot().Select(x => new
        {
            service = x.Service,
            kind = x.Kind.ToString(),
            x.Allowed,
            x.Reason,
            x.CheckedAt,
        }),
    }));
}
