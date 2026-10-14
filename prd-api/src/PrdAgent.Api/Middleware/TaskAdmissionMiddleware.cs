using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Middleware;

public sealed class TaskAdmissionMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http, TaskAdmissionService admission)
    {
        var identity = await admission.AdmitRequestAsync(http, CancellationToken.None);
        using var execution = TaskExecutionContext.Enter(identity);
        await next(http);
    }
}
