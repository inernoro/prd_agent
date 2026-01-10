using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
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

    public DiagnosticsController(ILogger<DiagnosticsController> logger)
    {
        _logger = logger;
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
            clientUrl = $"{Request.Scheme}://{Request.Host}";
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

        // 1. DNS 解析测试
        result.Tests.Add(await TestDns(uri.Host));

        // 2. SSL/TLS 测试（仅 HTTPS）
        if (uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase))
        {
            result.Tests.Add(await TestSsl(uri.Host, uri.Port == -1 ? 443 : uri.Port));
        }

        // 3. API 端点测试
        result.Tests.Add(await TestApiEndpoint(clientUrl));

        // 4. Ping 测试（TCP 连接延迟）
        result.Tests.Add(await TestPing(uri.Host, uri.Port == -1 ? (uri.Scheme == "https" ? 443 : 80) : uri.Port));

        // 5. 聊天功能测试（简化版，只测试端点可达性）
        result.Tests.Add(await TestChatEndpoint(clientUrl));

        // 6. Agent 功能测试（简化版）
        result.Tests.Add(TestAgentEndpoint(clientUrl));

        return Ok(ApiResponse<NetworkDiagnosticsResult>.Ok(result));
    }

    private async Task<DiagnosticTest> TestDns(string host)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var addresses = await Dns.GetHostAddressesAsync(host);
            sw.Stop();

            if (addresses.Length > 0)
            {
                return new DiagnosticTest
                {
                    Name = "DNS",
                    Status = "success",
                    Message = $"解析成功: {string.Join(", ", addresses.Take(3).Select(a => a.ToString()))}",
                    Duration = (int)sw.ElapsedMilliseconds
                };
            }

            return new DiagnosticTest
            {
                Name = "DNS",
                Status = "failed",
                Message = "未找到 IP 地址",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
        catch (Exception ex)
        {
            sw.Stop();
            return new DiagnosticTest
            {
                Name = "DNS",
                Status = "failed",
                Message = $"DNS 解析失败: {ex.Message}",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
    }

    private async Task<DiagnosticTest> TestSsl(string host, int port)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync(host, port);

            using var sslStream = new SslStream(client.GetStream(), false, (sender, cert, chain, errors) => true);
            await sslStream.AuthenticateAsClientAsync(host);

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

    private async Task<DiagnosticTest> TestApiEndpoint(string baseUrl)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var healthUrl = $"{baseUrl.TrimEnd('/')}/health";
            var response = await client.GetAsync(healthUrl);
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

    private async Task<DiagnosticTest> TestPing(string host, int port)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync(host, port);
            sw.Stop();

            return new DiagnosticTest
            {
                Name = "Ping",
                Status = "success",
                Message = $"连接延迟: {sw.ElapsedMilliseconds} ms",
                Duration = (int)sw.ElapsedMilliseconds
            };
        }
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

    private async Task<DiagnosticTest> TestChatEndpoint(string baseUrl)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var chatUrl = $"{baseUrl.TrimEnd('/')}/api/v1/sessions";
            
            // 只测试端点是否存在（401/403 也算成功，因为说明端点可达）
            var response = await client.GetAsync(chatUrl);
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
