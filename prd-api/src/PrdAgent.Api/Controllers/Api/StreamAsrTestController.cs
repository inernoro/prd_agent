using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 流式 ASR 测试端点（独立 Controller，无权限限制）
/// 用于验证 DoubaoStreamAsrService 的 WebSocket 二进制协议
/// </summary>
[ApiController]
[Route("api/test")]
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
    public async Task<IActionResult> TestStreamAsr(
        [FromBody] StreamAsrTestInput input,
        [FromServices] DoubaoStreamAsrService streamAsr,
        CancellationToken ct)
    {
        var (audioData, error) = await DownloadAudio(input.AudioUrl, ct);
        if (error != null) return Ok(ApiResponse<object>.Ok(new { error }));
        if (string.IsNullOrWhiteSpace(input.ApiKey))
            return BadRequest(ApiResponse<object>.Fail("INVALID", "请提供 apiKey"));

        var (appKey, accessKey) = ParseApiKey(input.ApiKey);
        var config = BuildConfig(input.ResourceId);

        var startedAt = DateTime.UtcNow;
        var result = await streamAsr.TranscribeAsync(
            input.WsUrl ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
            appKey, accessKey, audioData!, config, ct);
        var durationMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;

        return Ok(ApiResponse<object>.Ok(new
        {
            success = result.Success,
            text = result.FullText,
            segmentCount = result.Segments.Count,
            segments = result.Segments.Select(s => new { s.Text, s.DurationSec }),
            responseFrameCount = result.Responses.Count,
            error = result.Error,
            durationMs,
            audioSizeBytes = audioData!.Length,
            wsUrl = input.WsUrl ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream"
        }));
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
        [FromServices] DoubaoStreamAsrService streamAsr,
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

        var startedAt = DateTime.UtcNow;

        try
        {
            // 1. 下载音频
            await SendEvent("stage", new { stage = "downloading", message = "正在下载音频文件..." });
            var (audioData, dlError) = await DownloadAudio(input.AudioUrl, ct);
            if (dlError != null)
            {
                await SendEvent("error", new { error = dlError });
                return;
            }
            await SendEvent("stage", new { stage = "downloaded", message = $"音频下载完成 ({audioData!.Length / 1024}KB)", sizeBytes = audioData.Length });

            if (string.IsNullOrWhiteSpace(input.ApiKey))
            {
                await SendEvent("error", new { error = "请提供 apiKey" });
                return;
            }

            var (appKey, accessKey) = ParseApiKey(input.ApiKey);
            var config = BuildConfig(input.ResourceId);
            var wsUrl = input.WsUrl ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";

            // 2. 使用带回调的转录方法
            await SendEvent("stage", new { stage = "processing", message = "正在处理音频..." });

            var result = await streamAsr.TranscribeWithCallbackAsync(
                wsUrl, appKey, accessKey, audioData, config,
                onStage: async (stage, msg) => await SendEvent("stage", new { stage, message = msg }),
                onProgress: async (sent, total) => await SendEvent("progress", new { sent, total }),
                onFrame: async (seq, text, isLast) => await SendEvent("frame", new { seq, text, isLast }),
                ct: ct);

            var durationMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;

            // 3. 最终结果
            await SendEvent("result", new
            {
                success = result.Success,
                text = result.FullText,
                segmentCount = result.Segments.Count,
                segments = result.Segments.Select(s => new { s.Text, s.DurationSec }),
                responseFrameCount = result.Responses.Count,
                error = result.Error,
                durationMs,
                audioSizeBytes = audioData.Length
            });

            await SendEvent("stage", new { stage = "done", message = $"转录完成 ({durationMs}ms)" });
        }
        catch (Exception ex)
        {
            await SendEvent("error", new { error = ex.Message });
        }
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
