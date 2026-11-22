using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace PrdAgent.Api.Filters;

// Resource filter runs before model binding, including multipart and JSON allocation.
public sealed class DevelopmentStubFilter(IHostEnvironment environment, IConfiguration configuration) : IAsyncResourceFilter
{
    private static readonly SemaphoreSlim Slots = new(2, 2);
    public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
    {
        if (!environment.IsDevelopment() || !configuration.GetValue<bool>("DevelopmentStub:Enabled"))
        {
            context.Result = new NotFoundResult();
            return;
        }
        var expected = configuration["DevelopmentStub:ApiKey"];
        var supplied = context.HttpContext.Request.Headers.Authorization.ToString();
        if (string.IsNullOrWhiteSpace(expected) || expected.Length < 32 ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes("Bearer " + expected)),
                SHA256.HashData(Encoding.UTF8.GetBytes(supplied))))
        {
            context.Result = new UnauthorizedResult();
            return;
        }
        if (!await Slots.WaitAsync(0, context.HttpContext.RequestAborted))
        {
            context.Result = new StatusCodeResult(429);
            return;
        }
        try { await next(); }
        finally { Slots.Release(); }
    }
}
