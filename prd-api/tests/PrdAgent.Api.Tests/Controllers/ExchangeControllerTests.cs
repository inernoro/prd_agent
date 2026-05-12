using System.Reflection;
using System.Text.Json;
using PrdAgent.Api.Controllers.Api;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class ExchangeControllerTests
{
    [Fact]
    public void SafeControllerErrorPayload_ShouldNotExposeExceptionInternals()
    {
        var method = typeof(ExchangeController).GetMethod(
            "BuildSafeControllerErrorPayload",
            BindingFlags.Static | BindingFlags.NonPublic);

        method.ShouldNotBeNull();
        var payload = method.Invoke(null, new object?[] { "exchange-1", "trace-1" });
        var json = JsonSerializer.Serialize(payload);

        json.ShouldContain("exchange_sse_failed");
        json.ShouldContain("trace-1");
        json.ShouldNotContain("exceptionType");
        json.ShouldNotContain("stack");
        json.ShouldNotContain("System.");
        json.ShouldNotContain("InvalidOperationException");
    }
}
