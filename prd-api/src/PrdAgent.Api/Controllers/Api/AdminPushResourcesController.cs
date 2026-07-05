using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/public/admin-push/resources")]
public sealed class AdminPushResourcesController : ControllerBase
{
    [HttpGet("{resourceKey}/icon.svg")]
    [Produces("image/svg+xml")]
    public IActionResult Icon([FromRoute] string resourceKey)
    {
        var resource = AdminPushNotificationService.FindResource(resourceKey);
        if (resource == null) return NotFound();

        var svg = AdminPushNotificationService.BuildResourceIconSvg(resource);
        Response.Headers.CacheControl = "public, max-age=86400";
        return Content(svg, "image/svg+xml; charset=utf-8");
    }
}
