using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Security;
using System.Diagnostics;
using System.Security.Cryptography.X509Certificates;
using System.Net.Security;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 网络诊断接口（用于客户端自检）
/// </summary>
[ApiController]
[Route("api/v1/diagnostics")]
public class DiagnosticsController : ControllerBase
{
    private readonly ILogger<DiagnosticsController> _logger;
    private readonly IConfiguration _config;
    private readonly SafeOutboundDiagnosticConnector _connector;

    public DiagnosticsController(
        ILogger<DiagnosticsController> logger,
        IConfiguration config,
        SafeOutboundDiagnosticConnector connector)
    {
        _logger = logger;
        _config = config;
        _connector = connector;
    }

    /// <summary>
    /// 网络诊断（多步骤测试）
    /// </summary>
    [HttpPost("network")]
    [ProducesResponseType(typeof(ApiResponse<NetworkDiagnosticsResult>), StatusCodes.Status200OK)]
    public async Task<IActionResult> NetworkDiagnostics([FromBody] NetworkDiagnosticsRequest request)
    {
        var result = new NetworkDiagnosticsResult
        {
            Timestamp = DateTime.UtcNow,
            Tests = new List<DiagnosticTest>()
        };

        var clientUrl = request.ClientUrl?.Trim();
        if (string.IsNullOrEmpty(clientUrl))
        {
            // 如果客户端未提供 URL，使用当前请求的 Host
            clientUrl = Request.ResolveServerUrl(_config);
        }

        Uri? uri = null;
        try
        {
            uri = new Uri(clientUrl);
        }
        catch
        {
            result.Tests.Add(new DiagnosticTest
            {
                Name = "URL 解析",
                Status = "failed",
                Message = "无效的 URL 格式",
                Duration = 0
            });
            return Ok(ApiResponse<NetworkDiagnosticsResult>.Ok(result));
        }

        var ct = HttpContext.RequestAborted;
        SafeDiagnosticTarget target;
        var dnsTimer = Stopwatch.StartNew();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            target = await _connector.PrepareAsync(uri, timeout.Token);
            dnsTimer.Stop();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            result.Tests.Add(new DiagnosticTest
            {
                Name = "URL 安全校验",
                Status = "failed",
                Message = ex.Message,
                Duration = 0
            });
            return Ok(ApiResponse<NetworkDiagnosticsResult>.Ok(result));
        }

        // 1. DNS 解析测试
        result.Tests.Add(new DiagnosticTest
        {
            Name = "DNS",
            Status = "success",
            Message = $"解析成功: {string.Join(", ", target.Addresses.Take(3))}",
            Duration = (int)dnsTimer.ElapsedMilliseconds
        });

        // 2. SSL/TLS 测试（仅 HTTPS）
        if (uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            result.Tests.Add(await TestSsl(target, ct));
        }

        var gatewayIsValid = Uri.TryCreate(_config["LlmGateway:ServeBaseUrl"] ?? "http://llmgw-serve:8091",
            UriKind.Absolute, out var gateway)
            && (gateway.Scheme == Uri.UriSchemeHttp || gateway.Scheme == Uri.UriSchemeHttps)
            && !string.IsNullOrEmpty(gateway.Host);
        using var guardedTransport = gatewayIsValid
            ? new MapModelEgressHandler("NetworkDiagnostics", gateway!)
            {
                InnerHandler = _connector.CreateHandler(target),
            }
            : null;
        using var httpClient = guardedTransport is null
            ? null
            : new HttpClient(guardedTransport, disposeHandler: false) { Timeout = TimeSpan.FromSeconds(5) };

        // 3. API 端点测试
        result.Tests.Add(httpClient is null
            ? HttpConfigurationFailure("API")
            : await TestApiEndpoint(httpClient, target.Uri, ct));

        // 4. Ping 测试（TCP 连接延迟）
        result.Tests.Add(await TestPing(target, ct));

        // 5. 聊天功能测试（简化版，只测试端点可达性）
        result.Tests.Add(httpClient is null
            ? HttpConfigurationFailure("Chat")
            : await TestChatEndpoint(httpClient, target.Uri, ct));

        // 6. Agent 功能测试（简化版）
        result.Tests.Add(TestAgentEndpoint(clientUrl));

        return Ok(ApiResponse<NetworkDiagnosticsResult>.Ok(result));
    }

    private static DiagnosticTest HttpConfigurationFailure(string name) => new()
    {
        Name = name,
        Status = "failed",
        Message = "网关 HTTP 诊断地址配置无效",
        Duration = 0
    };

    private async Task<DiagnosticTest> TestSsl(SafeDiagnosticTarget target, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            using var stream = await _connector.ConnectAsync(target, timeout.Token);
            using var sslStream = new SslStream(stream);
            await sslStream.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
            {
                TargetHost = target.Uri.IdnHost
            }, timeout.Token);

            sw.Stop();

            var cert = sslStream.RemoteCertificate as X509Certificate2;
            var certInfo = cert != null
                ? $"证书有效期至 {cert.NotAfter:yyyy-MM-dd}"
                : "证书信息不可用";

            return new DiagnosticTest
            {
                Name = "SSL",
                Status = "success",
                Message = $"SSL/TLS 连接成功, {certInfo}",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            sw.Stop();
            return new DiagnosticTest
            {
                Name = "SSL",
                Status = "failed",
                Message = $"SSL 连接失败: {ex.Message}",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
    }

    private static async Task<HttpResponseMessage> ProbeEndpointAsync(
        HttpClient client, Uri baseUri, string endpoint, CancellationToken ct)
    {
        var probe = new UriBuilder(baseUri)
        {
            Path = baseUri.AbsolutePath.TrimEnd('/') + endpoint,
            Query = string.Empty,
            Fragment = string.Empty,
        };
        using var request = new HttpRequestMessage(HttpMethod.Get, probe.Uri);
        request.Options.Set(MapModelEgressHandler.DisableRedirects, true);
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private async Task<DiagnosticTest> TestApiEndpoint(HttpClient client, Uri baseUri, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var response = await ProbeEndpointAsync(client, baseUri, "/health", ct);
            sw.Stop();

            if (response.IsSuccessStatusCode)
            {
                return new DiagnosticTest
                {
                    Name = "API",
                    Status = "success",
                    Message = $"API 端点可达 (HTTP {(int)response.StatusCode})",
                    Duration = (int)sw.ElapsedMilliseconds
                };
            }

            return new DiagnosticTest
            {
                Name = "API",
                Status = "failed",
                Message = $"API 端点返回错误 (HTTP {(int)response.StatusCode})",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            sw.Stop();
            return new DiagnosticTest
            {
                Name = "API",
                Status = "failed",
                Message = $"API 端点不可达: {ex.Message}",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
    }

    private async Task<DiagnosticTest> TestPing(SafeDiagnosticTarget target, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            using var stream = await _connector.ConnectAsync(target, timeout.Token);
            sw.Stop();

            return new DiagnosticTest
            {
                Name = "Ping",
                Status = "success",
                Message = $"连接延迟: {sw.ElapsedMilliseconds} ms",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            sw.Stop();
            return new DiagnosticTest
            {
                Name = "Ping",
                Status = "failed",
                Message = $"连接失败: {ex.Message}",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
    }

    private async Task<DiagnosticTest> TestChatEndpoint(HttpClient client, Uri baseUri, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            // 只测试端点是否存在（401/403 也算成功，因为说明端点可达）
            using var response = await ProbeEndpointAsync(client, baseUri, "/api/v1/sessions", ct);
            sw.Stop();

            var statusCode = (int)response.StatusCode;
            if (statusCode < 500)
            {
                return new DiagnosticTest
                {
                    Name = "Chat",
                    Status = "success",
                    Message = "聊天端点可达",
                    Duration = (int)sw.ElapsedMilliseconds
                };
            }

            return new DiagnosticTest
            {
                Name = "Chat",
                Status = "failed",
                Message = $"聊天端点错误 (HTTP {statusCode})",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            sw.Stop();
            return new DiagnosticTest
            {
                Name = "Chat",
                Status = "failed",
                Message = $"聊天端点不可达: {ex.Message}",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
    }

    private DiagnosticTest TestAgentEndpoint(string baseUrl)
    {
        // Agent 功能依赖认证，这里只做标记
        return new DiagnosticTest
        {
            Name = "Agent",
            Status = "success",
            Message = "需要登录后测试",
            Duration = 0
        };
    }
}

/// <summary>
/// 网络诊断请求
/// </summary>
public class NetworkDiagnosticsRequest
{
    /// <summary>
    /// 客户端要测试的 URL（可选，默认使用当前请求的 Host）
    /// </summary>
    public string? ClientUrl { get; set; }
}

/// <summary>
/// 网络诊断结果
/// </summary>
public class NetworkDiagnosticsResult
{
    public DateTime Timestamp { get; set; }
    public List<DiagnosticTest> Tests { get; set; } = new();
}

/// <summary>
/// 单项诊断测试结果
/// </summary>
public class DiagnosticTest
{
    /// <summary>
    /// 测试名称（DNS/SSL/API/Ping/Chat/Agent）
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 状态（success/failed/warning）
    /// </summary>
    public string Status { get; set; } = string.Empty;

    /// <summary>
    /// 详细信息
    /// </summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>
    /// 耗时（毫秒）
    /// </summary>
    public int Duration { get; set; }
}
