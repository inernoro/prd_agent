using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 流式 ASR 测试端点（独立 Controller，无权限限制）。
/// 该 WebSocket 直连测试已禁用，避免 MAP API 进程绕过 llmgw-serve。
/// </summary>
[ApiController]
[Route("api/test")]
[Authorize]
public class StreamAsrTestController : ControllerBase
{
    private readonly IHttpClientFactory _httpClientFactory;

    public StreamAsrTestController(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>
    /// 测试 WebSocket 流式 ASR（一次性返回）
    /// POST /api/test/stream-asr
    /// </summary>
    [HttpPost("stream-asr")]
    public IActionResult TestStreamAsr([FromBody] StreamAsrTestInput input)
    {
        return BadRequest(ApiResponse<object>.Fail(
            "LLMGW_ASR_STREAM_DIRECT_DISABLED",
            "WebSocket 流式 ASR 测试已禁用：MAP 不再允许在 API 进程内直连豆包上游。请改用 doubao-asr HTTP Exchange/Whisper ASR，或等该协议迁入 llmgw-serve。"));
    }

    /// <summary>
    /// 测试 WebSocket 流式 ASR（SSE 逐帧推送，实时显示进度）
    /// POST /api/test/stream-asr/sse
    ///
    /// SSE 事件类型：
    /// - stage:    阶段变化（downloading / converting / connecting / sending / result / done / error）
    /// - progress: 发送进度（sent=5, total=28）
    /// - frame:    每帧识别结果（seq, text, isLast）
    /// - result:   最终汇总
    /// </summary>
    [HttpPost("stream-asr/sse")]
    public async Task TestStreamAsrSse(
        [FromBody] StreamAsrTestInput input,
        CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");

        async Task SendEvent(string eventType, object data)
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            try
            {
                await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n", ct);
                await Response.Body.FlushAsync(ct);
            }
            catch (OperationCanceledException) { /* 客户端断开 */ }
        }

        await SendEvent("error", new
        {
            error = "WebSocket 流式 ASR 测试已禁用：MAP 不再允许在 API 进程内直连豆包上游。请改用 doubao-asr HTTP Exchange/Whisper ASR，或等该协议迁入 llmgw-serve。",
            code = "LLMGW_ASR_STREAM_DIRECT_DISABLED"
        });
    }

    // ═══════════════════════════════════════════════════════════

    private async Task<(byte[]? data, string? error)> DownloadAudio(string? url, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url))
            return (null, "请提供 audioUrl");
        try
        {
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(60);
            var data = await httpClient.GetByteArrayAsync(url, ct);
            return (data, null);
        }
        catch (Exception ex)
        {
            return (null, $"下载音频失败: {ex.Message}");
        }
    }

    private static (string appKey, string accessKey) ParseApiKey(string apiKey)
    {
        if (apiKey.Contains('|'))
        {
            var parts = apiKey.Split('|', 2);
            return (parts[0], parts[1]);
        }
        return ("", apiKey);
    }

    private static Dictionary<string, object> BuildConfig(string? resourceId)
    {
        return new Dictionary<string, object>
        {
            ["resourceId"] = resourceId ?? "volc.bigasr.sauc.duration",
            ["enableItn"] = true,
            ["enablePunc"] = true,
            ["enableDdc"] = true
        };
    }
}

public class StreamAsrTestInput
{
    public string AudioUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string? WsUrl { get; set; }
    public string? ResourceId { get; set; }
}
