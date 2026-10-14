using System.Reflection;
using System.Text.Json;
using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
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
        var writer = new Mock<IMiduoPlanetSsoAuditWriter>();
        writer.Setup(x => x.BeginAsync(It.IsAny<ApiRequestLog>())).ReturnsAsync(true);
        writer.Setup(x => x.CompleteAsync(It.IsAny<ApiRequestLog>())).ReturnsAsync(true);
        ApiRequestLog? stored = null;
        writer.Setup(x => x.CompleteAsync(It.IsAny<ApiRequestLog>())).Callback<ApiRequestLog>(x => stored = x).ReturnsAsync(true);
        var controller = new MiduoPlanetSsoController(null!, null!, null!, null!, null!, null!, factory.Object,
            NullLogger<MiduoPlanetSsoController>.Instance, writer.Object)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.Items["RequestId"] = "incoming-request-1";
        var optionsType = typeof(MiduoPlanetSsoController).GetNestedType("MiduoPlanetSsoOptions", BindingFlags.NonPublic)!;
        var options = Activator.CreateInstance(optionsType, nonPublic: true)!;
        foreach (var (key, value) in new[] { ("BaseUrl", "https://sso.example.test"), ("AppCode", "test-app"), ("AppSecret", "test-secret"), ("SubjectType", "mobile") })
            optionsType.GetProperty(key)!.SetValue(options, value);
        var method = typeof(MiduoPlanetSsoController).GetMethod("ValidateLoginTokenAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var task = (Task)method.Invoke(controller, new[] { options, "test-token", "admin", (object)CancellationToken.None })!;
        await task;
        var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
        var profile = result.GetType().GetField("Item1")!.GetValue(result);
        if (expected == null) Assert.NotNull(profile);
        else Assert.Null(profile);
        Assert.Equal(expected, result.GetType().GetField("Item2")!.GetValue(result));
        Assert.NotNull(stored);
        Assert.Equal("incoming-request-1", stored.RequestId);
        Assert.Equal("outbound", stored.Direction);
        Assert.Equal(status, stored.StatusCode);
        Assert.NotNull(stored.EndedAt);
        using var audit = JsonDocument.Parse(stored.ResponseBody!);
        Assert.True(audit.RootElement.GetProperty("responseReceived").GetBoolean());
        Assert.Equal(expected, audit.RootElement.GetProperty("localErrorCode").GetString());
        writer.Verify(x => x.BeginAsync(It.IsAny<ApiRequestLog>()), Times.Once);
        writer.Verify(x => x.CompleteAsync(It.IsAny<ApiRequestLog>()), Times.Once);
    }

    [Theory]
    [InlineData("transport", "transport_error", false)]
    [InlineData("timeout", "timeout", false)]
    [InlineData("partial", "response_read_error", true)]
    [InlineData("oversize", "response_too_large", true)]
    [InlineData("malformed", "parse_error", true)]
    public async Task ExchangeFailure_ShouldPersistItsStageAndPartialResponse(string scenario, string stage, bool received)
    {
        ApiRequestLog? stored = null;
        var writer = new Mock<IMiduoPlanetSsoAuditWriter>();
        writer.Setup(x => x.BeginAsync(It.IsAny<ApiRequestLog>())).ReturnsAsync(true);
        writer.Setup(x => x.CompleteAsync(It.IsAny<ApiRequestLog>())).Callback<ApiRequestLog>(x => stored = x).ReturnsAsync(true);
        var handler = new AuditFailureHandler(scenario);
        var (profile, error) = await ExchangeAsync(handler, writer.Object);
        Assert.Null(profile);
        Assert.Equal("SSO_PROVIDER_UNAVAILABLE", error);
        Assert.NotNull(stored);
        using var evidence = JsonDocument.Parse(stored.ResponseBody!);
        Assert.Equal(stage, evidence.RootElement.GetProperty("stage").GetString());
        Assert.Equal(received, evidence.RootElement.GetProperty("responseReceived").GetBoolean());
        if (scenario is "partial" or "oversize")
        {
            Assert.True(stored.ResponseBodyTruncated);
            Assert.True(evidence.RootElement.GetProperty("captureTruncated").GetBoolean());
            Assert.Equal("captured_prefix", evidence.RootElement.GetProperty("fingerprintScope").GetString());
            Assert.True(stored.ResponseBodyBytes > 0);
        }
        Assert.DoesNotContain("test-token", stored.ResponseBody!);
        writer.Verify(x => x.CompleteAsync(It.IsAny<ApiRequestLog>()), Times.Once);
    }

    [Theory]
    [InlineData(false, true, 0)]
    [InlineData(true, false, 1)]
    public async Task AuditFailure_ShouldPreventUnloggedLoginAndAvoidConsumingTokenBeforePreparation(bool begin, bool complete, int sends)
    {
        var writer = new Mock<IMiduoPlanetSsoAuditWriter>();
        writer.Setup(x => x.BeginAsync(It.IsAny<ApiRequestLog>())).ReturnsAsync(begin);
        writer.Setup(x => x.CompleteAsync(It.IsAny<ApiRequestLog>())).ReturnsAsync(complete);
        var handler = new AuditFailureHandler("valid");
        var (profile, error) = await ExchangeAsync(handler, writer.Object);
        Assert.Null(profile);
        Assert.Equal("SSO_AUDIT_UNAVAILABLE", error);
        Assert.Equal(sends, handler.Sends);
        writer.Verify(x => x.CompleteAsync(It.IsAny<ApiRequestLog>()), begin ? Times.Once() : Times.Never());
    }

    private static async Task<(object? Profile, string? Error)> ExchangeAsync(HttpMessageHandler handler, IMiduoPlanetSsoAuditWriter writer)
    {
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(100) };
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient("SafeOutbound")).Returns(client);
        var controller = new MiduoPlanetSsoController(null!, null!, null!, null!, null!, null!, factory.Object,
            NullLogger<MiduoPlanetSsoController>.Instance, writer)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.Items["RequestId"] = "incoming-failure-test";
        var optionsType = typeof(MiduoPlanetSsoController).GetNestedType("MiduoPlanetSsoOptions", BindingFlags.NonPublic)!;
        var options = Activator.CreateInstance(optionsType, nonPublic: true)!;
        foreach (var (key, value) in new[] { ("BaseUrl", "https://sso.example.test"), ("AppCode", "test-app"), ("AppSecret", "test-secret"), ("SubjectType", "mobile") })
            optionsType.GetProperty(key)!.SetValue(options, value);
        var method = typeof(MiduoPlanetSsoController).GetMethod("ValidateLoginTokenAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var task = (Task)method.Invoke(controller, new[] { options, "test-token", "admin", (object)CancellationToken.None })!;
        await task;
        var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
        return (result.GetType().GetField("Item1")!.GetValue(result), (string?)result.GetType().GetField("Item2")!.GetValue(result));
    }

    private sealed class AuditFailureHandler(string scenario) : HttpMessageHandler
    {
        public int Sends { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Sends++;
            if (scenario == "transport") throw new HttpRequestException("fixture transport unavailable");
            if (scenario == "timeout") await Task.Delay(Timeout.Infinite, cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = scenario == "partial"
                ? new StreamContent(new PartialFailureStream())
                : new StringContent(scenario == "oversize" ? new string('x', MiduoPlanetSsoAudit.MaxCaptureBytes + 20)
                    : scenario == "malformed" ? "{broken token=test-token" : "{\"return_data\":{\"valid\":true,\"mobile\":\"18600000000\"}}") };
        }
    }

    private sealed class PartialFailureStream : MemoryStream
    {
        private bool _read;
        public PartialFailureStream() : base(System.Text.Encoding.UTF8.GetBytes("{\"return_code\":0,")) { }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_read) throw new IOException("fixture incomplete body");
            _read = true;
            return base.ReadAsync(buffer, cancellationToken);
        }
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
