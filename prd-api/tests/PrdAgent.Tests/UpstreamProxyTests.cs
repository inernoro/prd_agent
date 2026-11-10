using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using PrdAgent.GatewayTransport;
using MongoDB.Bson;
using Xunit;

namespace PrdAgent.Tests;

public class UpstreamProxyTests
{
    private static BsonDocument Config(string mode, string? address = null)
        => UpstreamProxy.Build(new() { Mode = mode, Address = address }, null, value => "cipher:" + value);

    [Fact]
    public void InheritanceOverrideAndDirectHaveExplicitPrecedence()
    {
        var global = Config("custom", "http://global.example:8080");
        Assert.Equal("http://global.example:8080", UpstreamProxy.Resolve(null, global, _ => null)!.Address);
        Assert.Equal("http://global.example:8080", UpstreamProxy.Resolve(Config("inherit"), global, _ => null)!.Address);
        Assert.Equal("direct", UpstreamProxy.Resolve(Config("direct"), global, _ => null)!.Mode);
        Assert.Equal("socks5://single.example:1080", UpstreamProxy.Resolve(Config("custom", "socks5://single.example:1080"), global, _ => null)!.Address);
        Assert.Null(UpstreamProxy.Resolve(null, null, _ => null));
    }

    [Fact]
    public void ResolvedProxySurvivesInProcessConversionButIsNotSerialized()
    {
        var proxy = new ResolvedUpstreamProxy("custom", "http://proxy.example:8080", "user", "secret");
        var result = new PrdAgent.Core.LlmGateway.ModelResolutionResult { Success = true, UpstreamProxy = proxy };
        var converted = result.ToGatewayResolution();
        Assert.Same(proxy, converted.UpstreamProxy);
        Assert.DoesNotContain("proxy.example", JsonSerializer.Serialize(converted));
        Assert.DoesNotContain("secret", proxy.ToString());
    }

    [Theory]
    [InlineData("http://user:password@proxy.example:8080")]
    [InlineData("ftp://proxy.example:8080")]
    [InlineData("http://proxy.example:8080/path")]
    [InlineData("http://proxy.example:8080?password=secret")]
    public void RejectsCredentialsInUrlAndUnsupportedAddresses(string address)
        => Assert.Throws<ArgumentException>(() => Config("custom", address));

    [Fact]
    public void CredentialsAreEncryptedPreservedClearedAndNeverReturned()
    {
        var input = new UpstreamProxyWrite { Mode = "custom", Address = "http://proxy.example:8080", Username = "account", Password = "proxy-password" };
        var doc = UpstreamProxy.Build(input, null, value => "encrypted-" + value);
        Assert.False(doc.Contains("Password"));
        Assert.Equal("encrypted-" + Convert.ToBase64String(Encoding.UTF8.GetBytes("proxy-password")), doc["PasswordEncrypted"].AsString);
        Assert.DoesNotContain("proxy-password", JsonSerializer.Serialize(UpstreamProxy.View(doc)));
        var resolved = UpstreamProxy.Resolve(doc, null, _ => Convert.ToBase64String(Encoding.UTF8.GetBytes("proxy-password")));
        Assert.DoesNotContain("proxy-password", JsonSerializer.Serialize(resolved));
        input.Password = "";
        var unchanged = UpstreamProxy.Build(input, doc, _ => throw new Exception("不应重新加密空密码"));
        Assert.Equal(doc["PasswordEncrypted"], unchanged["PasswordEncrypted"]);
        Assert.Throws<InvalidOperationException>(() => UpstreamProxy.Resolve(doc, null, _ => null));
        input.ClearPassword = true;
        Assert.False(UpstreamProxy.View(UpstreamProxy.Build(input, doc, _ => "unused")).HasPassword);
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.0.0.5")]
    [InlineData("169.254.169.254")]
    [InlineData("::1")]
    [InlineData("::ffff:10.0.0.5")]
    [InlineData("fc00::1")]
    public async Task ExternalTenantsCannotUsePrivateProxyEndpoints(string address)
    {
        Assert.False(UpstreamProxy.IsPublicAddress(IPAddress.Parse(address)));
        var formatted = address.Contains(':') ? $"[{address}]" : address;
        using var client = new HttpClient(UpstreamProxy.CreateHandler(new("custom", $"http://{formatted}:12345", null, null), true));
        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync("https://upstream.invalid/models"));
    }

    [Fact]
    public async Task HttpProxyReceivesTargetDomainWithoutLocalDnsAndDoesNotFollowRedirects()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var capture = Task.Run(async () =>
            {
                using var peer = await listener.AcceptTcpClientAsync(cts.Token);
                using var stream = peer.GetStream();
                var request = await ReadHeadersAsync(stream, cts.Token);
                await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), cts.Token);
                return request;
            }, cts.Token);
            using var client = new HttpClient(UpstreamProxy.CreateHandler(new("custom", $"http://127.0.0.1:{port}", null, null), false));
            using var response = await client.GetAsync("http://target-never-resolved.invalid/models", cts.Token);
            Assert.Equal(HttpStatusCode.Found, response.StatusCode);
            Assert.Contains("GET http://target-never-resolved.invalid/models HTTP/1.1", await capture);
        }
        finally { listener.Stop(); }
    }

    [Fact]
    public async Task Socks5ProxyReceivesDomainAndUsesRemoteDns()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var capture = Task.Run(async () =>
            {
                using var peer = await listener.AcceptTcpClientAsync(cts.Token);
                using var stream = peer.GetStream();
                var greeting = new byte[2]; await stream.ReadExactlyAsync(greeting, cts.Token);
                var methods = new byte[greeting[1]]; await stream.ReadExactlyAsync(methods, cts.Token);
                await stream.WriteAsync(new byte[] { 5, 0 }, cts.Token);
                var command = new byte[5]; await stream.ReadExactlyAsync(command, cts.Token);
                Assert.Equal(3, command[3]); // 域名类型，不能提前解析成 IP。
                var name = new byte[command[4]]; await stream.ReadExactlyAsync(name, cts.Token);
                var targetPort = new byte[2]; await stream.ReadExactlyAsync(targetPort, cts.Token);
                await stream.WriteAsync(new byte[] { 5, 0, 0, 1, 127, 0, 0, 1, 0, 80 }, cts.Token);
                await ReadHeadersAsync(stream, cts.Token);
                await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"), cts.Token);
                return Encoding.ASCII.GetString(name);
            }, cts.Token);
            using var client = new HttpClient(UpstreamProxy.CreateHandler(new("custom", $"socks5://127.0.0.1:{port}", null, null), false));
            using var response = await client.GetAsync("http://socks-target.invalid/models", cts.Token);
            Assert.True(response.IsSuccessStatusCode);
            Assert.Equal("socks-target.invalid", await capture);
        }
        finally { listener.Stop(); }
    }

    private static async Task<string> ReadHeadersAsync(Stream stream, CancellationToken ct)
    {
        var bytes = new List<byte>();
        var one = new byte[1];
        while (bytes.Count < 16384)
        {
            await stream.ReadExactlyAsync(one, ct); bytes.Add(one[0]);
            if (bytes.Count >= 4 && Encoding.ASCII.GetString(bytes.TakeLast(4).ToArray()) == "\r\n\r\n")
                return Encoding.ASCII.GetString(bytes.ToArray());
        }
        throw new InvalidOperationException("探测报文超过测试上限");
    }
}
