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
    /// 测试 WebSocket 流式 ASR
    /// POST /api/test/stream-asr
    /// </summary>
    [HttpPost("stream-asr")]
    public async Task<IActionResult> TestStreamAsr(
        [FromBody] StreamAsrTestInput input,
        [FromServices] DoubaoStreamAsrService streamAsr,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.AudioUrl))
            return BadRequest(ApiResponse<object>.Fail("INVALID", "请提供 audioUrl"));
        if (string.IsNullOrWhiteSpace(input.ApiKey))
            return BadRequest(ApiResponse<object>.Fail("INVALID", "请提供 apiKey"));

        var wsUrl = input.WsUrl ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";

        // 下载音频
        byte[] audioData;
        try
        {
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(60);
            audioData = await httpClient.GetByteArrayAsync(input.AudioUrl, ct);
        }
        catch (Exception ex)
        {
            return Ok(ApiResponse<object>.Ok(new { error = $"下载音频失败: {ex.Message}" }));
        }

        // 解析 apiKey
        string appKey = "", accessKey = input.ApiKey;
        if (input.ApiKey.Contains('|'))
        {
            var parts = input.ApiKey.Split('|', 2);
            appKey = parts[0];
            accessKey = parts[1];
        }

        var config = new Dictionary<string, object>
        {
            ["resourceId"] = input.ResourceId ?? "volc.bigasr.sauc.duration",
            ["enableItn"] = true,
            ["enablePunc"] = true,
            ["enableDdc"] = true
        };

        var startedAt = DateTime.UtcNow;
        var result = await streamAsr.TranscribeAsync(wsUrl, appKey, accessKey, audioData, config, ct);
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
            audioSizeBytes = audioData.Length,
            wsUrl
        }));
    }
}

public class StreamAsrTestInput
{
    public string AudioUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string? WsUrl { get; set; }
    public string? ResourceId { get; set; }
}
