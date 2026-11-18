using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Controllers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Services;

public class DiagnosticsConnectionSecurityTests(ITestOutputHelper output)
{
    private static readonly IPAddress Public = IPAddress.Parse("93.184.216.34");
    private static readonly Uri Target = new("http://diagnostics.invalid:8443");

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("169.254.169.254")]
    [InlineData("169.254.1.1")]
    [InlineData("10.0.0.1")]
    [InlineData("172.16.0.1")]
    [InlineData("192.168.1.1")]
    [InlineData("::1")]
    [InlineData("::ffff:127.0.0.1")]
    [InlineData("::ffff:169.254.169.254")]
    [InlineData("::ffff:10.0.0.1")]
    [InlineData("fe80::1")]
    [InlineData("fc00::1")]
    [InlineData("64:ff9b::a00:1")]
    [InlineData("2002:a00:1::")]
    public async Task ChangedDnsAndMixedAnswers_AreRejectedBeforeAnyConnection(string blocked)
    {
        var connections = 0;
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, _) => Task.FromResult(new[] { Public, IPAddress.Parse(blocked) }),
            (_, _) => { connections++; return ValueTask.FromResult<Stream>(new MemoryStream()); });
        var result = await RunController(connector);
        Assert.Single(result.Tests);
        Assert.Equal("URL 安全校验", result.Tests[0].Name);
        Assert.Equal("failed", result.Tests[0].Status);
        Assert.Equal(0, connections);
    }

    [Fact]
    public async Task SnapshotSurvivesDnsChangesAndMutation_WithFallbackOnlyToApprovedAddresses()
    {
        var answers = new[] { Public, IPAddress.Parse("1.1.1.1") };
        var resolved = 0;
        var attempts = new List<string>();
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, _) => { resolved++; return Task.FromResult(answers); },
            (ep, _) =>
            {
                attempts.Add(ep.ToString());
                if (ep.Address.Equals(Public)) throw new SocketException((int)SocketError.ConnectionRefused);
                return ValueTask.FromResult<Stream>(new MemoryStream());
            });
        var target = await connector.PrepareAsync(Target, default);
        answers[1] = IPAddress.Loopback;
        using var stream = await connector.ConnectAsync(target, default);
        using var second = await connector.ConnectAsync(target, default);
        Assert.Equal(1, resolved);
        Assert.Equal(new[] { "93.184.216.34:8443", "1.1.1.1:8443", "93.184.216.34:8443", "1.1.1.1:8443" }, attempts);
    }

    [Fact]
    public async Task ConnectionCancellation_DoesNotTryAnotherAddress()
    {
        var attempts = 0;
        using var cancel = new CancellationTokenSource();
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, _) => Task.FromResult(new[] { Public, IPAddress.Parse("1.1.1.1") }),
            (_, ct) =>
            {
                attempts++;
                cancel.Cancel();
                return ValueTask.FromCanceled<Stream>(ct);
            });
        var target = await connector.PrepareAsync(Target, default);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => connector.ConnectAsync(target, cancel.Token).AsTask());
        Assert.Equal(1, attempts);
    }

    [Fact]
    public async Task HttpTargetMismatch_IsRejectedWithoutConnection()
    {
        var attempts = 0;
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, _) => Task.FromResult(new[] { Public }),
            (_, _) => { attempts++; return ValueTask.FromResult<Stream>(Stream.Null); });
        var target = await connector.PrepareAsync(Target, default);
        using var client = new HttpClient(connector.CreateHandler(target));
        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync("http://other.invalid:8443"));
        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync("http://diagnostics.invalid:8444"));
        Assert.Equal(0, attempts);
    }

    [Fact]
    public async Task LocalHttpFixture_DnsApiPingChatSucceed_WithoutResolvingAgain()
    {
        await using var fixture = new LocalFixture(async (stream, ct) =>
        {
            using var reader = new StreamReader(stream, leaveOpen: true);
            string? line;
            while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync(ct))) { }
            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"), ct);
        });
        output.WriteLine($"Approved endpoint 93.184.216.34:8443; test transport connects only to {fixture.Endpoint}");
        var resolves = 0;
        var attempts = new ConcurrentBag<string>();
        var connector = FixtureConnector(fixture, attempts, () => ++resolves == 1 ? Public : IPAddress.Loopback);
        var result = await RunController(connector);
        Assert.All(result.Tests, test => Assert.Equal("success", test.Status));
        Assert.Equal(new[] { "DNS", "API", "Ping", "Chat", "Agent" }, result.Tests.Select(t => t.Name));
        Assert.Equal(1, resolves);
        Assert.Equal(3, attempts.Count);
        Assert.All(attempts, endpoint => Assert.Equal("93.184.216.34:8443", endpoint));
        Assert.All(fixture.Peers, peer => Assert.True(IPAddress.IsLoopback(peer.Address)));
    }

    [Fact]
    public async Task LocalTlsFixture_PreservesSni_RejectsUntrustedCertificate()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=diagnostics.invalid", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("diagnostics.invalid");
        request.CertificateExtensions.Add(san.Build());
        using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
        var names = new ConcurrentBag<string>();
        await using var fixture = new LocalFixture(async (stream, ct) =>
        {
            using var tls = new SslStream(stream, leaveInnerStreamOpen: true);
            await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
            {
                ServerCertificateSelectionCallback = (_, name) => { names.Add(name ?? ""); return cert; }
            }, ct);
        });
        var attempts = new ConcurrentBag<string>();
        var connector = FixtureConnector(fixture, attempts, () => Public);
        var result = await RunController(connector, "https://diagnostics.invalid:8443");
        Assert.Equal("failed", result.Tests.Single(t => t.Name == "SSL").Status);
        Assert.Equal("success", result.Tests.Single(t => t.Name == "Ping").Status);
        Assert.NotEmpty(names);
        Assert.All(names, name => Assert.Equal("diagnostics.invalid", name));
        Assert.All(attempts, endpoint => Assert.Equal("93.184.216.34:8443", endpoint));
    }

    [Fact]
    public async Task LocalTrustedTlsFixture_PinnedHttpsSucceedsWithHostnameValidation()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=diagnostics.invalid", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("diagnostics.invalid");
        request.CertificateExtensions.Add(san.Build());
        using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
        await using var fixture = new LocalFixture(async (stream, ct) =>
        {
            using var tls = new SslStream(stream, leaveInnerStreamOpen: true);
            await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = cert }, ct);
            using var reader = new StreamReader(tls, leaveOpen: true);
            while (!string.IsNullOrEmpty(await reader.ReadLineAsync(ct))) { }
            await tls.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"), ct);
        });
        var attempts = new ConcurrentBag<string>();
        var connector = FixtureConnector(fixture, attempts, () => Public);
        var target = await connector.PrepareAsync(new Uri("https://diagnostics.invalid:8443"), default);
        using var handler = Assert.IsType<SocketsHttpHandler>(connector.CreateHandler(target));
        Assert.Null(handler.SslOptions.RemoteCertificateValidationCallback);
        // Test-local trust store trusts precisely the fixture certificate, retaining hostname/chain validation.
        // No process or OS trust settings and no production validation callback are changed.
        handler.SslOptions.CertificateChainPolicy = new X509ChainPolicy
        {
            TrustMode = X509ChainTrustMode.CustomRootTrust,
            RevocationMode = X509RevocationMode.NoCheck
        };
        handler.SslOptions.CertificateChainPolicy.CustomTrustStore.Add(cert);
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        using var response = await client.GetAsync(target.Uri);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("OK", await response.Content.ReadAsStringAsync());
        Assert.Equal("93.184.216.34:8443", Assert.Single(attempts));
        output.WriteLine($"HTTPS pinned endpoint 93.184.216.34:8443, test-only transport {fixture.Endpoint}, validated name diagnostics.invalid");
    }

    [Fact]
    public async Task LocalSilentTlsFixture_HandshakeAndHttpTimeouts_AreBounded()
    {
        await using var fixture = new LocalFixture((_, ct) => Task.Delay(Timeout.Infinite, ct));
        var connector = FixtureConnector(fixture, new(), () => Public);
        var result = await RunController(connector, "https://diagnostics.invalid:8443").WaitAsync(TimeSpan.FromSeconds(25));
        Assert.Equal("failed", result.Tests.Single(t => t.Name == "SSL").Status);
        Assert.InRange(result.Tests.Single(t => t.Name == "SSL").Duration, 4000, 10000);
        Assert.Equal("failed", result.Tests.Single(t => t.Name == "API").Status);
        Assert.Equal("failed", result.Tests.Single(t => t.Name == "Chat").Status);
        Assert.Equal("success", result.Tests.Single(t => t.Name == "Ping").Status);
    }

    [Fact]
    public async Task RequestCancellation_StopsHandshakeAndRemainingSteps()
    {
        using var cancel = new CancellationTokenSource();
        var handshakeStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fixture = new LocalFixture(async (stream, ct) =>
        {
            var firstByte = new byte[1];
            if (await stream.ReadAsync(firstByte, ct) == 1)
                handshakeStarted.TrySetResult();
            await Task.Delay(Timeout.Infinite, ct);
        });
        var attempts = new ConcurrentBag<string>();
        var connector = FixtureConnector(fixture, attempts, () => Public);
        var request = RunController(connector, "https://diagnostics.invalid:8443", cancel.Token);
        try
        {
            await handshakeStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally
        {
            await cancel.CancelAsync();
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        Assert.Single(attempts);
    }

    [Fact]
    public async Task ConnectionTimeouts_AreBoundedInController()
    {
        var attempts = 0;
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, _) => Task.FromResult(new[] { Public }),
            async (_, ct) => { attempts++; await Task.Delay(Timeout.Infinite, ct); return Stream.Null; });
        var result = await RunController(connector).WaitAsync(TimeSpan.FromSeconds(25));
        foreach (var name in new[] { "API", "Ping", "Chat" })
        {
            var test = result.Tests.Single(t => t.Name == name);
            Assert.Equal("failed", test.Status);
            Assert.InRange(test.Duration, 4000, 10000);
        }
        Assert.Equal(3, attempts);
    }

    [Fact]
    public async Task ResolverCancellation_StopsBeforeTransport()
    {
        using var cancel = new CancellationTokenSource();
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, ct) =>
            {
                cancel.Cancel();
                return Task.FromCanceled<IPAddress[]>(ct);
            },
            (_, _) => throw new InvalidOperationException("Transport must not run"));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => RunController(connector, ct: cancel.Token));
    }

    [Theory]
    [InlineData("http://127.0.0.1")]
    [InlineData("http://[::ffff:169.254.169.254]")]
    [InlineData("http://localhost.")]
    [InlineData("http://name:password@diagnostics.invalid")]
    [InlineData("ftp://diagnostics.invalid")]
    public async Task UnsafeLiteralOrUrl_DoesNotResolveOrConnect(string url)
    {
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, _) => throw new InvalidOperationException("Resolver must not run"),
            (_, _) => throw new InvalidOperationException("Transport must not run"));
        var result = await RunController(connector, url);
        Assert.Single(result.Tests);
        Assert.Equal("failed", result.Tests[0].Status);
        Assert.DoesNotContain("must not run", result.Tests[0].Message);
    }

    [Fact]
    public async Task EmptyDnsAnswer_FailsBeforeConnection()
    {
        var connector = new SafeOutboundDiagnosticConnector(new SafeOutboundUrlValidator(),
            (_, _) => Task.FromResult(Array.Empty<IPAddress>()),
            (_, _) => throw new InvalidOperationException("Transport must not run"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => connector.PrepareAsync(Target, default));
    }

    [Fact]
    public async Task ProductionSocketTransport_ConnectsToExactlyApprovedLocalFixture()
    {
        await using var fixture = new LocalFixture((_, ct) => Task.Delay(Timeout.Infinite, ct));
        output.WriteLine($"Production socket transport approved and connected endpoint: {fixture.Endpoint}");
        var connector = new SafeOutboundDiagnosticConnector(new FixtureOnlyValidator(fixture.Endpoint.Address));
        var target = await connector.PrepareAsync(new Uri($"http://{fixture.Endpoint}"), default);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var stream = await connector.ConnectAsync(target, timeout.Token);
        Assert.IsType<NetworkStream>(stream);
        Assert.Equal(fixture.Endpoint.Address, Assert.Single(target.Addresses));
    }

    private sealed class FixtureOnlyValidator(IPAddress fixtureAddress) : ISafeOutboundUrlValidator
    {
        public Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default) => Task.FromResult(new Uri(url!));
        public bool IsSafeAddress(IPAddress address) => address.Equals(fixtureAddress);
    }

    private static SafeOutboundDiagnosticConnector FixtureConnector(LocalFixture fixture, ConcurrentBag<string> attempts, Func<IPAddress> answer) =>
        new(new SafeOutboundUrlValidator(), (_, _) => Task.FromResult(new[] { answer() }), async (endpoint, ct) =>
        {
            attempts.Add(endpoint.ToString());
            // Only the test transport maps approved public endpoints to this owned loopback listener.
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            try { await socket.ConnectAsync(fixture.Endpoint, ct); return new NetworkStream(socket, ownsSocket: true); }
            catch { socket.Dispose(); throw; }
        });

    private static async Task<NetworkDiagnosticsResult> RunController(SafeOutboundDiagnosticConnector connector,
        string url = "http://diagnostics.invalid:8443", CancellationToken ct = default)
    {
        var controller = new DiagnosticsController(NullLogger<DiagnosticsController>.Instance,
            new ConfigurationBuilder().Build(), connector)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { RequestAborted = ct } } };
        var response = Assert.IsType<OkObjectResult>(await controller.NetworkDiagnostics(new() { ClientUrl = url }));
        return Assert.IsType<ApiResponse<NetworkDiagnosticsResult>>(response.Value).Data!;
    }

    private sealed class LocalFixture : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _run;
        public IPEndPoint Endpoint => (IPEndPoint)_listener.LocalEndpoint;
        public ConcurrentBag<IPEndPoint> Peers { get; } = new();
        public LocalFixture(Func<Stream, CancellationToken, Task> serve)
        {
            _listener.Start();
            _run = RunAsync(serve);
        }
        private async Task RunAsync(Func<Stream, CancellationToken, Task> serve)
        {
            var handlers = new List<Task>();
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    var socket = await _listener.AcceptSocketAsync(_stop.Token);
                    Peers.Add((IPEndPoint)socket.RemoteEndPoint!);
                    handlers.Add(HandleAsync(socket, serve));
                }
            }
            catch (OperationCanceledException) { }
            finally { await Task.WhenAll(handlers); }
        }
        private async Task HandleAsync(Socket socket, Func<Stream, CancellationToken, Task> serve)
        {
            using var stream = new NetworkStream(socket, ownsSocket: true);
            try { await serve(stream, _stop.Token); }
            catch (Exception ex) when (ex is IOException or AuthenticationException or OperationCanceledException) { }
        }
        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();
            await _run;
            _listener.Stop();
            _stop.Dispose();
        }
    }
}
