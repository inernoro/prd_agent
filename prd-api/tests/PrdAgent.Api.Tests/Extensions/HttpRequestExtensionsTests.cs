using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Extensions;
using Xunit;

namespace PrdAgent.Api.Tests.Extensions;

public class HttpRequestExtensionsTests
{
    [Fact]
    public void ResolveServerUrl_UsesForwardedProtoWithPreservedHost()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "http";
        context.Request.Host = new HostString("map.ebcone.net");
        context.Request.Headers["X-Forwarded-Proto"] = "https";
        var config = new ConfigurationBuilder().Build();

        var result = context.Request.ResolveServerUrl(config);

        Assert.Equal("https://map.ebcone.net", result);
    }
}
