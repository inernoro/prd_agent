using System.Reflection;
using System.Text.Json;
using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class MiduoPlanetSsoControllerTests
{
    [Theory]
    [InlineData(200, "{\"return_data\":{\"valid\":false}}", "SSO_TOKEN_INVALID")]
    [InlineData(200, "{\"return_data\":{\"valid\":true}}", "SSO_PROFILE_INCOMPLETE")]
    [InlineData(503, "{}", "SSO_PROVIDER_UNAVAILABLE")]
    [InlineData(200, "{\"return_data\":{\"valid\":true,\"mobile\":\"18600000000\"}}", null)]
    public async Task TokenExchange_ShouldPreserveValidIdentityAndDistinguishFailures(int status, string json, string? expected)
    {
        using var client = new HttpClient(new ValidationResponseHandler(status, json));
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient("SafeOutbound")).Returns(client);
        var controller = new MiduoPlanetSsoController(null!, null!, null!, null!, null!, null!, factory.Object,
            NullLogger<MiduoPlanetSsoController>.Instance);
        var optionsType = typeof(MiduoPlanetSsoController).GetNestedType("MiduoPlanetSsoOptions", BindingFlags.NonPublic)!;
        var options = Activator.CreateInstance(optionsType, nonPublic: true)!;
        foreach (var (key, value) in new[] { ("BaseUrl", "https://sso.example.test"), ("AppCode", "test-app"), ("AppSecret", "test-secret"), ("SubjectType", "mobile") })
            optionsType.GetProperty(key)!.SetValue(options, value);
        var method = typeof(MiduoPlanetSsoController).GetMethod("ValidateLoginTokenAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var task = (Task)method.Invoke(controller, new[] { options, "test-token", (object)CancellationToken.None })!;
        await task;
        var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
        var profile = result.GetType().GetField("Item1")!.GetValue(result);
        if (expected == null) Assert.NotNull(profile);
        else Assert.Null(profile);
        Assert.Equal(expected, result.GetType().GetField("Item2")!.GetValue(result));
    }

    private sealed class ValidationResponseHandler(int status, string json) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(json) });
    }

    [Theory]
    [InlineData("{\"return_data\":{\"valid\":false,\"message\":\"令牌不存在或已过期\",\"mobile\":\"18600000000\"}}", "mobile", "SSO_TOKEN_INVALID")]
    [InlineData("{\"return_data\":{\"valid\":false,\"message\":\"用户不存在或不可用\"}}", "mobile", "SSO_USER_UNAVAILABLE")]
    [InlineData("{}", "mobile", "SSO_PROVIDER_UNAVAILABLE")]
    [InlineData("{\"return_code\":401,\"return_data\":{\"valid\":false}}", "mobile", "SSO_PROVIDER_UNAVAILABLE")]
    [InlineData("{\"return_data\":{\"valid\":\"unknown\"}}", "mobile", "SSO_PROVIDER_UNAVAILABLE")]
    [InlineData("{\"return_data\":{\"valid\":true}}", "mobile", "SSO_PROFILE_INCOMPLETE")]
    [InlineData("{\"return_data\":{\"valid\":true,\"mobile\":\"---\"}}", "mobile", "SSO_PROFILE_INCOMPLETE")]
    [InlineData("{\"return_data\":{\"valid\":true,\"mobile\":\"18600000000\"}}", "mobile", null)]
    [InlineData("{\"return_data\":{\"valid\":\"true\",\"wework_userid\":\"employee-1\"}}", "wework_userid", null)]
    public void Validation_ShouldDistinguishRejectionFromMissingIdentityWithoutBypassingValidity(
        string json, string subjectType, string? expected)
    {
        using var doc = JsonDocument.Parse(json);
        var method = typeof(MiduoPlanetSsoController).GetMethod("GetValidationError", BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        Assert.Equal(expected, method.Invoke(null, new object[] { doc.RootElement, subjectType }));
    }

    [Fact]
    public void BuildAutoUsername_ShouldBeStableAndNotExposeMobile()
    {
        var first = Invoke<string>("BuildAutoUsername", "APP00013", "mobile", "18620111008");
        var second = Invoke<string>("BuildAutoUsername", "app00013", "mobile", "186 2011 1008");

        Assert.Equal(first, second);
        Assert.StartsWith("miduo_", first);
        Assert.DoesNotContain("186", first);
        Assert.DoesNotContain("1008", first);
        Assert.InRange(first.Length, 10, 32);
    }

    [Fact]
    public void NormalizeDisplayName_ShouldFallbackToMaskedSubject()
    {
        var displayName = Invoke<string>("NormalizeDisplayName", "", "mobile", "18620111008", "miduo_test");

        Assert.Equal("米多用户 186****1008", displayName);
    }

    [Fact]
    public void MaskSubjectValue_ShouldMaskMobile()
    {
        var masked = Invoke<string>("MaskSubjectValue", "mobile", "18620111008");

        Assert.Equal("186****1008", masked);
    }

    private static T Invoke<T>(string name, params object?[] args)
    {
        var method = typeof(MiduoPlanetSsoController).GetMethod(
            name,
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return Assert.IsType<T>(method.Invoke(null, args));
    }
}
