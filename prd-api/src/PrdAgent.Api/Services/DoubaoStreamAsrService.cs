using System.IO.Compression;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Services;

/// <summary>
/// 豆包流式 ASR WebSocket 客户端
/// 实现 ByteDance 自定义二进制帧协议，通过 WebSocket 发送音频分片并接收转录结果。
///
/// 协议帧格式（4 字节 header）：
/// [version(4bit)|headerSize(4bit)] [msgType(4bit)|flags(4bit)] [serialization(4bit)|compression(4bit)] [reserved]
/// 之后跟 seq(4bytes, big-endian) + payloadSize(4bytes, big-endian) + payload(gzip)
///
/// 流程：
/// 1. WebSocket 连接 → 发送 FullClientRequest（JSON 配置）
/// 2. 循环发送 AudioOnlyRequest（PCM 音频分片）
/// 3. 最后一片标记 NEG_WITH_SEQUENCE
/// 4. 接收 ServerFullResponse 直到 is_last_package
/// </summary>
public class DoubaoStreamAsrService
{
    private readonly ILogger<DoubaoStreamAsrService> _logger;

    public DoubaoStreamAsrService(ILogger<DoubaoStreamAsrService> logger)
    {
        _logger = logger;
    }

    // ═══════════════════════════════════════════════════════════
    // 协议常量
    // ═══════════════════════════════════════════════════════════

    private static class ProtocolVersion { public const byte V1 = 0b0001; }

    private static class MessageType
    {
        public const byte ClientFullRequest = 0b0001;
        public const byte ClientAudioOnlyRequest = 0b0010;
        public const byte ServerFullResponse = 0b1001;
        public const byte ServerErrorResponse = 0b1111;
    }

    private static class MsgFlags
    {
        public const byte PosSequence = 0b0001;
        public const byte NegSequence = 0b0010;
        public const byte NegWithSequence = 0b0011;
    }

    private static class Serialization { public const byte Json = 0b0001; }
    private static class Compression { public const byte Gzip = 0b0001; }

    // ═══════════════════════════════════════════════════════════
    // 公共方法
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// 执行流式 ASR 转录
    /// </summary>
    /// <param name="wsUrl">WebSocket URL (wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream)</param>
    /// <param name="appKey">豆包 App Key</param>
    /// <param name="accessKey">豆包 Access Key</param>
    /// <param name="audioData">音频文件原始字节（WAV 或其他格式，非 WAV 会尝试解析为 raw PCM）</param>
    /// <param name="config">额外配置</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>完整的转录结果（所有响应合并）</returns>
    public async Task<StreamAsrResult> TranscribeAsync(
        string wsUrl,
        string appKey,
        string accessKey,
        byte[] audioData,
        Dictionary<string, object>? config = null,
        CancellationToken ct = default)
    {
        var result = new StreamAsrResult();
        var segmentDurationMs = 200;
        var sampleRate = 16000;

        // 解析 WAV 获取音频参数和 PCM 数据
        byte[] pcmData;
        int channels = 1, bitsPerSample = 16, actualRate = sampleRate;

        if (IsWavFile(audioData))
        {
            var wavInfo = ReadWavInfo(audioData);
            channels = wavInfo.Channels;
            bitsPerSample = wavInfo.BitsPerSample;
            actualRate = wavInfo.SampleRate;
            pcmData = wavInfo.PcmData;
            _logger.LogInformation("[DoubaoStreamAsr] WAV 解析: channels={Ch}, bits={Bits}, rate={Rate}, pcm={PcmLen}bytes",
                channels, bitsPerSample, actualRate, pcmData.Length);
        }
        else
        {
            // 非 WAV 直接作为 raw PCM 处理
            pcmData = audioData;
            _logger.LogInformation("[DoubaoStreamAsr] 非 WAV 格式, 按 raw PCM 处理, size={Size}bytes", pcmData.Length);
        }

        // 计算分片大小
        var bytesPerSec = channels * (bitsPerSample / 8) * actualRate;
        var segmentSize = bytesPerSec * segmentDurationMs / 1000;
        if (segmentSize <= 0) segmentSize = 3200;

        // 分片
        var segments = SplitAudio(pcmData, segmentSize);
        _logger.LogInformation("[DoubaoStreamAsr] 音频分片: {Count} 片, 每片 {Size} bytes", segments.Count, segmentSize);

        // 构建认证头
        var resourceId = config?.GetValueOrDefault("resourceId")?.ToString() ?? "volc.bigasr.sauc.duration";
        var requestId = Guid.NewGuid().ToString();
        var headers = new Dictionary<string, string>
        {
            ["X-Api-Resource-Id"] = resourceId,
            ["X-Api-Request-Id"] = requestId,
            ["X-Api-Access-Key"] = accessKey,
            ["X-Api-App-Key"] = appKey
        };

        using var ws = new ClientWebSocket();
        foreach (var (key, value) in headers)
            ws.Options.SetRequestHeader(key, value);

        try
        {
            // 1. 连接
            await ws.ConnectAsync(new Uri(wsUrl), ct);
            _logger.LogInformation("[DoubaoStreamAsr] WebSocket 已连接: {Url}", wsUrl);

            var seq = 1;

            // 2. 发送 FullClientRequest
            var fullRequest = BuildFullClientRequest(seq, channels, bitsPerSample, actualRate, config);
            await ws.SendAsync(new ArraySegment<byte>(fullRequest), WebSocketMessageType.Binary, true, ct);
            _logger.LogInformation("[DoubaoStreamAsr] 已发送 FullClientRequest, seq={Seq}", seq);
            seq++;

            // 接收 FullClientRequest 的响应
            var initResp = await ReceiveOneAsync(ws, ct);
            if (initResp.Code != 0)
            {
                result.Error = $"初始化失败: code={initResp.Code}";
                return result;
            }

            // 3. 发送音频分片 + 接收响应
            var sendTask = Task.Run(async () =>
            {
                for (var i = 0; i < segments.Count; i++)
                {
                    var isLast = i == segments.Count - 1;
                    var audioRequest = BuildAudioOnlyRequest(seq, segments[i], isLast);
                    await ws.SendAsync(new ArraySegment<byte>(audioRequest), WebSocketMessageType.Binary, true, CancellationToken.None);

                    if (!isLast)
                    {
                        seq++;
                        await Task.Delay(segmentDurationMs, CancellationToken.None);
                    }
                }
                _logger.LogInformation("[DoubaoStreamAsr] 所有音频分片已发送");
            }, CancellationToken.None);

            // 4. 持续接收响应直到最后一个包
            var responses = new List<AsrResponseFrame>();
            while (true)
            {
                var resp = await ReceiveOneAsync(ws, CancellationToken.None);
                responses.Add(resp);

                if (resp.PayloadMsg != null)
                {
                    _logger.LogDebug("[DoubaoStreamAsr] 收到响应: seq={Seq}, last={Last}",
                        resp.PayloadSequence, resp.IsLastPackage);
                }

                if (resp.IsLastPackage || resp.Code != 0)
                    break;
            }

            await sendTask;

            // 5. 合并结果
            result.Responses = responses;
            result.Success = responses.All(r => r.Code == 0);
            result.FullText = ExtractFullText(responses);
            result.Segments = ExtractSegments(responses);

            _logger.LogInformation("[DoubaoStreamAsr] 转录完成, text_length={Len}, segments={SegCount}",
                result.FullText.Length, result.Segments.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[DoubaoStreamAsr] 转录失败");
            result.Error = ex.Message;
        }
        finally
        {
            if (ws.State == WebSocketState.Open)
            {
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); }
                catch { /* ignore close errors */ }
            }
        }

        return result;
    }

    // ═══════════════════════════════════════════════════════════
    // 帧构建
    // ═══════════════════════════════════════════════════════════

    private byte[] BuildFullClientRequest(int seq, int channels, int bits, int rate, Dictionary<string, object>? config)
    {
        var header = new byte[]
        {
            (byte)((ProtocolVersion.V1 << 4) | 1),
            (byte)((MessageType.ClientFullRequest << 4) | MsgFlags.PosSequence),
            (byte)((Serialization.Json << 4) | Compression.Gzip),
            0x00
        };

        var payload = new JsonObject
        {
            ["user"] = new JsonObject { ["uid"] = "prd-agent" },
            ["audio"] = new JsonObject
            {
                ["format"] = "wav",
                ["codec"] = "raw",
                ["rate"] = rate,
                ["bits"] = bits,
                ["channel"] = channels
            },
            ["request"] = new JsonObject
            {
                ["model_name"] = "bigmodel",
                ["enable_itn"] = GetBool(config, "enableItn", true),
                ["enable_punc"] = GetBool(config, "enablePunc", true),
                ["enable_ddc"] = GetBool(config, "enableDdc", true),
                ["show_utterances"] = true,
                ["enable_nonstream"] = false
            }
        };

        var payloadBytes = GzipCompress(Encoding.UTF8.GetBytes(payload.ToJsonString()));

        using var ms = new MemoryStream();
        ms.Write(header, 0, header.Length);
        WriteInt32BigEndian(ms, seq);
        WriteUInt32BigEndian(ms, (uint)payloadBytes.Length);
        ms.Write(payloadBytes, 0, payloadBytes.Length);
        return ms.ToArray();
    }

    private static byte[] BuildAudioOnlyRequest(int seq, byte[] segment, bool isLast)
    {
        var flags = isLast ? MsgFlags.NegWithSequence : MsgFlags.PosSequence;
        var actualSeq = isLast ? -seq : seq;

        var header = new byte[]
        {
            (byte)((ProtocolVersion.V1 << 4) | 1),
            (byte)((MessageType.ClientAudioOnlyRequest << 4) | flags),
            (byte)((0 << 4) | Compression.Gzip), // 无序列化，有压缩
            0x00
        };

        var compressed = GzipCompress(segment);

        using var ms = new MemoryStream();
        ms.Write(header, 0, header.Length);
        WriteInt32BigEndian(ms, actualSeq);
        WriteUInt32BigEndian(ms, (uint)compressed.Length);
        ms.Write(compressed, 0, compressed.Length);
        return ms.ToArray();
    }

    // ═══════════════════════════════════════════════════════════
    // 帧解析
    // ═══════════════════════════════════════════════════════════

    private async Task<AsrResponseFrame> ReceiveOneAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[1024 * 1024]; // 1MB buffer
        using var ms = new MemoryStream();
        WebSocketReceiveResult wsResult;

        do
        {
            wsResult = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
            ms.Write(buffer, 0, wsResult.Count);
        } while (!wsResult.EndOfMessage);

        if (wsResult.MessageType == WebSocketMessageType.Close)
        {
            return new AsrResponseFrame { IsLastPackage = true };
        }

        return ParseResponse(ms.ToArray());
    }

    private AsrResponseFrame ParseResponse(byte[] msg)
    {
        var response = new AsrResponseFrame();

        if (msg.Length < 4) return response;

        var headerSize = msg[0] & 0x0f;
        var messageType = (byte)(msg[1] >> 4);
        var flags = (byte)(msg[1] & 0x0f);
        var serializationMethod = (byte)(msg[2] >> 4);
        var compression = (byte)(msg[2] & 0x0f);

        var payload = msg.AsSpan(headerSize * 4);

        // 解析 flags
        if ((flags & 0x01) != 0 && payload.Length >= 4)
        {
            response.PayloadSequence = ReadInt32BigEndian(payload);
            payload = payload[4..];
        }
        if ((flags & 0x02) != 0)
        {
            response.IsLastPackage = true;
        }
        if ((flags & 0x04) != 0 && payload.Length >= 4)
        {
            response.Event = ReadInt32BigEndian(payload);
            payload = payload[4..];
        }

        // 解析 message type
        if (messageType == MessageType.ServerFullResponse && payload.Length >= 4)
        {
            response.PayloadSize = ReadUInt32BigEndian(payload);
            payload = payload[4..];
        }
        else if (messageType == MessageType.ServerErrorResponse && payload.Length >= 8)
        {
            response.Code = ReadInt32BigEndian(payload);
            response.PayloadSize = ReadUInt32BigEndian(payload[4..]);
            payload = payload[8..];
        }

        if (payload.IsEmpty) return response;

        // 解压缩
        byte[] decompressed;
        if (compression == Compression.Gzip)
        {
            try
            {
                decompressed = GzipDecompress(payload.ToArray());
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[DoubaoStreamAsr] Gzip 解压失败");
                return response;
            }
        }
        else
        {
            decompressed = payload.ToArray();
        }

        // 解析 JSON payload
        if (serializationMethod == Serialization.Json && decompressed.Length > 0)
        {
            try
            {
                response.PayloadMsg = JsonSerializer.Deserialize<JsonElement>(decompressed);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[DoubaoStreamAsr] JSON 解析失败");
            }
        }

        return response;
    }

    // ═══════════════════════════════════════════════════════════
    // 结果提取
    // ═══════════════════════════════════════════════════════════

    private static string ExtractFullText(List<AsrResponseFrame> responses)
    {
        var sb = new StringBuilder();
        foreach (var resp in responses)
        {
            if (resp.PayloadMsg == null) continue;
            try
            {
                var payload = resp.PayloadMsg.Value;
                if (payload.TryGetProperty("result", out var resultArr) && resultArr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in resultArr.EnumerateArray())
                    {
                        if (item.TryGetProperty("text", out var text))
                            sb.Append(text.GetString());
                    }
                }
            }
            catch { /* skip */ }
        }
        return sb.ToString();
    }

    private static List<StreamAsrSegment> ExtractSegments(List<AsrResponseFrame> responses)
    {
        var segments = new List<StreamAsrSegment>();
        foreach (var resp in responses)
        {
            if (resp.PayloadMsg == null) continue;
            try
            {
                var payload = resp.PayloadMsg.Value;
                if (payload.TryGetProperty("result", out var resultArr) && resultArr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in resultArr.EnumerateArray())
                    {
                        var text = item.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                        if (string.IsNullOrWhiteSpace(text)) continue;

                        double duration = 0;
                        if (item.TryGetProperty("additions", out var additions) &&
                            additions.TryGetProperty("duration", out var dur))
                        {
                            var durStr = dur.GetString() ?? "0";
                            double.TryParse(durStr, out duration);
                            duration /= 1000.0;
                        }

                        segments.Add(new StreamAsrSegment { Text = text, DurationSec = duration });
                    }
                }
            }
            catch { /* skip */ }
        }
        return segments;
    }

    // ═══════════════════════════════════════════════════════════
    // WAV 解析
    // ═══════════════════════════════════════════════════════════

    private static bool IsWavFile(byte[] data)
    {
        return data.Length >= 44 &&
               data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F' &&
               data[8] == 'W' && data[9] == 'A' && data[10] == 'V' && data[11] == 'E';
    }

    private static WavInfo ReadWavInfo(byte[] data)
    {
        var channels = BitConverter.ToInt16(data, 22);
        var sampleRate = BitConverter.ToInt32(data, 24);
        var bitsPerSample = BitConverter.ToInt16(data, 34);

        // 查找 data 子块
        var pos = 36;
        while (pos < data.Length - 8)
        {
            var subId = Encoding.ASCII.GetString(data, pos, 4);
            var subSize = BitConverter.ToInt32(data, pos + 4);
            if (subId == "data")
            {
                var pcm = new byte[subSize];
                Array.Copy(data, pos + 8, pcm, 0, Math.Min(subSize, data.Length - pos - 8));
                return new WavInfo(channels, bitsPerSample, sampleRate, pcm);
            }
            pos += 8 + subSize;
        }

        // fallback: 跳过 44 字节 header
        var fallbackPcm = new byte[data.Length - 44];
        Array.Copy(data, 44, fallbackPcm, 0, fallbackPcm.Length);
        return new WavInfo(channels, bitsPerSample, sampleRate, fallbackPcm);
    }

    // ═══════════════════════════════════════════════════════════
    // 工具方法
    // ═══════════════════════════════════════════════════════════

    private static byte[] GzipCompress(byte[] data)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest))
        {
            gzip.Write(data, 0, data.Length);
        }
        return output.ToArray();
    }

    private static byte[] GzipDecompress(byte[] data)
    {
        using var input = new MemoryStream(data);
        using var gzip = new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        gzip.CopyTo(output);
        return output.ToArray();
    }

    private static void WriteInt32BigEndian(Stream s, int value)
    {
        var bytes = BitConverter.GetBytes(value);
        if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
        s.Write(bytes, 0, 4);
    }

    private static void WriteUInt32BigEndian(Stream s, uint value)
    {
        var bytes = BitConverter.GetBytes(value);
        if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
        s.Write(bytes, 0, 4);
    }

    private static int ReadInt32BigEndian(ReadOnlySpan<byte> data)
    {
        var bytes = data[..4].ToArray();
        if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
        return BitConverter.ToInt32(bytes, 0);
    }

    private static uint ReadUInt32BigEndian(ReadOnlySpan<byte> data)
    {
        var bytes = data[..4].ToArray();
        if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
        return BitConverter.ToUInt32(bytes, 0);
    }

    private static List<byte[]> SplitAudio(byte[] data, int segmentSize)
    {
        var segments = new List<byte[]>();
        for (var i = 0; i < data.Length; i += segmentSize)
        {
            var end = Math.Min(i + segmentSize, data.Length);
            var segment = new byte[end - i];
            Array.Copy(data, i, segment, 0, segment.Length);
            segments.Add(segment);
        }
        return segments;
    }

    private static bool GetBool(Dictionary<string, object>? config, string key, bool defaultValue)
    {
        if (config == null) return defaultValue;
        if (!config.TryGetValue(key, out var val)) return defaultValue;
        if (val is bool b) return b;
        if (val is string s && bool.TryParse(s, out var parsed)) return parsed;
        return defaultValue;
    }

    // ═══════════════════════════════════════════════════════════
    // 内部类型
    // ═══════════════════════════════════════════════════════════

    private record WavInfo(int Channels, int BitsPerSample, int SampleRate, byte[] PcmData);
}

/// <summary>流式 ASR 响应帧</summary>
public class AsrResponseFrame
{
    public int Code { get; set; }
    public int Event { get; set; }
    public bool IsLastPackage { get; set; }
    public int PayloadSequence { get; set; }
    public uint PayloadSize { get; set; }
    public JsonElement? PayloadMsg { get; set; }
}

/// <summary>流式 ASR 转录结果</summary>
public class StreamAsrResult
{
    public bool Success { get; set; }
    public string FullText { get; set; } = "";
    public List<StreamAsrSegment> Segments { get; set; } = new();
    public List<AsrResponseFrame> Responses { get; set; } = new();
    public string? Error { get; set; }
}

/// <summary>流式 ASR 分段</summary>
public class StreamAsrSegment
{
    public string Text { get; set; } = "";
    public double DurationSec { get; set; }
}
