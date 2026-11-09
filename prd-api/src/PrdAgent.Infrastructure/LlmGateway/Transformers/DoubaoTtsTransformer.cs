using System.Security.Cryptography;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// 豆包 TTS HTTP Chunked/SSE V3。官方契约：
/// https://www.volcengine.com/docs/6561/1598757
/// resourceId 必须显式配置，它同时决定模型版本与计费商品，不能猜默认值。
/// 推荐 XApiKey；旧双凭据认证使用 DoubaoTts（AppID|AccessToken）。
/// </summary>
public sealed class DoubaoTtsTransformer : IRawExchangeResponseTransformer
{
    public const int MaximumAudioBytes = GatewaySpeechResponseLimits.MaxAudioBytes;
    public const int MaximumResponseBytes = 48 * 1024 * 1024;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly HashSet<int> SampleRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000];

    public string TransformerType => "doubao-tts";
    public int MaxResponseBytes => MaximumResponseBytes;

    public string? ResolveTargetUrl(string baseUrl, JsonObject standardBody, Dictionary<string, object>? config) => null;

    public Dictionary<string, string>? GetExtraHeaders(Dictionary<string, object>? config)
    {
        var resourceId = ConfigString(config, "resourceId");
        if (string.IsNullOrWhiteSpace(resourceId) || resourceId.Any(char.IsControl))
            throw new ArgumentException("豆包 TTS 必须配置有效的 resourceId；资源决定模型版本与计费方式。");
        return new Dictionary<string, string>
        {
            ["X-Api-Resource-Id"] = resourceId,
            ["X-Api-Request-Id"] = Guid.NewGuid().ToString(),
            ["X-Control-Require-Usage-Tokens-Return"] = "*",
        };
    }

    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        // 在构造任何网络请求之前校验资源配置。
        _ = GetExtraHeaders(config);
        var input = RequiredString(standardBody, "input");
        var voice = RequiredString(standardBody, "voice");
        if (standardBody["instructions"] is not null)
            throw new ArgumentException("豆包 TTS 此协议不接受 OpenAI instructions；请选择该音色支持的情感参数。");
        var format = OptionalString(standardBody, "response_format") ?? "mp3";
        // 流式 wav 会重复携带文件头，不能通过拼接分片冒充一个合法 wav。
        if (format is not ("mp3" or "ogg_opus" or "pcm"))
            throw new ArgumentException("豆包 TTS HTTP V3 支持 mp3、ogg_opus、pcm；不能直接拼接流式 wav。");
        var audio = new JsonObject { ["format"] = format };
        if (standardBody["speed"] is not null)
        {
            var speed = Number(standardBody, "speed");
            if (speed is < 0.5 or > 2)
                throw new ArgumentException("豆包 TTS 语速倍率必须在 0.5 到 2 之间。");
            audio["speech_rate"] = (speed - 1) * 100;
        }
        if (standardBody["sample_rate"] is not null)
        {
            var rate = Number(standardBody, "sample_rate");
            if (rate != Math.Truncate(rate) || !SampleRates.Contains((int)rate))
                throw new ArgumentException("豆包 TTS 采样率不在支持范围内。");
            audio["sample_rate"] = (int)rate;
        }
        if (standardBody["emotion"] is not null)
            audio["emotion"] = RequiredString(standardBody, "emotion");
        if (standardBody["emotion_scale"] is not null)
        {
            if (audio["emotion"] is null)
                throw new ArgumentException("情绪强度必须与情绪一起指定。");
            var scale = Number(standardBody, "emotion_scale");
            if (scale is < 1 or > 5)
                throw new ArgumentException("豆包 TTS 情绪强度必须在 1 到 5 之间。");
            audio["emotion_scale"] = scale;
        }

        return new JsonObject
        {
            ["user"] = new JsonObject { ["uid"] = ConfigString(config, "uid") ?? "map-mcp-speech" },
            ["req_params"] = new JsonObject
            {
                ["text"] = input,
                ["speaker"] = voice,
                ["audio_params"] = audio,
            },
        };
    }

    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
        => throw new NotSupportedException("豆包 TTS 响应必须通过原始分片转换器处理并检查结束码。");

    public ExchangeRawResponse TransformRawResponse(
        ReadOnlyMemory<byte> rawResponse,
        string? contentType,
        JsonObject standardRequest,
        Dictionary<string, object>? config)
    {
        var audit = new JsonObject
        {
            ["protocol"] = TransformerType,
            ["received_bytes"] = rawResponse.Length,
            ["content_type"] = contentType is { Length: <= 128 } ? contentType : "[omitted]",
            ["response_sha256"] = Convert.ToHexString(SHA256.HashData(rawResponse.Span)).ToLowerInvariant(),
            ["media_omitted"] = "base64 audio and sentence text are not stored in audit",
        };
        ExchangeRawResponse Fail(string code, string message)
        {
            audit["local_error"] = code;
            audit["parsed"] ??= false;
            return new ExchangeRawResponse(false, audit.ToJsonString(), ErrorCode: code, ErrorMessage: message);
        }

        if (rawResponse.Length > MaximumResponseBytes)
        {
            audit["truncated"] = true;
            audit["truncation_reason"] = "response_byte_limit";
            return Fail("TTS_RESPONSE_TOO_LARGE", "语音服务返回内容超过上限，请缩短文本后重试。");
        }

        try
        {
            var format = OptionalString(standardRequest, "response_format") ?? "mp3";
            if (format is not ("mp3" or "ogg_opus" or "pcm"))
                return Fail("TTS_RESPONSE_FORMAT_INVALID", "语音输出格式与该上游协议不匹配。");
            using var audio = new MemoryStream();
            using var reader = new StringReader(StrictUtf8.GetString(rawResponse.Span));
            var completed = false;
            var frames = 0;
            var codes = new JsonArray();
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                var json = line.Trim();
                if (json.Length == 0 || json.StartsWith(':') || json.StartsWith("event:", StringComparison.Ordinal)) continue;
                if (json.StartsWith("data:", StringComparison.Ordinal)) json = json[5..].TrimStart();
                if (++frames > 100_000)
                    return Fail("TTS_RESPONSE_TOO_MANY_FRAMES", "语音服务返回分片数量异常。");
                using var frame = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
                var root = frame.RootElement;
                if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("code", out var codeNode)
                    || codeNode.ValueKind != JsonValueKind.Number || !codeNode.TryGetInt32(out var code))
                    return Fail("TTS_RESPONSE_INVALID", "语音服务返回了无法识别的分片。");
                if (codes.Count < 16) codes.Add(code);
                audit["provider_codes"] = codes.DeepClone();
                if (root.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String)
                {
                    var message = msg.GetString() ?? string.Empty;
                    audit["provider_message"] = RedactMessage(message, standardRequest);
                    audit["provider_message_sha256"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(message))).ToLowerInvariant();
                }
                if (completed)
                    return Fail("TTS_RESPONSE_TRAILING_FRAME", "语音服务在结束标记后仍返回了额外内容。");
                if (code != 0 && code != 20000000)
                {
                    audit["parsed"] = true;
                    audit["provider_code"] = code;
                    return Fail("TTS_UPSTREAM_FAILED", "语音服务未完成生成，请检查音色、资源授权或服务额度；诊断信息已记录。");
                }
                if (root.TryGetProperty("data", out var data) && data.ValueKind != JsonValueKind.Null)
                {
                    if (data.ValueKind != JsonValueKind.String)
                        return Fail("TTS_RESPONSE_INVALID_AUDIO", "语音服务返回了无效的音频分片。");
                    var encoded = data.GetString()!;
                    if (encoded.Length > ((MaximumAudioBytes - audio.Length + 2) / 3) * 4)
                        return Fail("TTS_AUDIO_TOO_LARGE", "生成的音频超过保存上限，请缩短文本后重试。");
                    var chunk = Convert.FromBase64String(encoded);
                    if (audio.Length + chunk.Length > MaximumAudioBytes)
                        return Fail("TTS_AUDIO_TOO_LARGE", "生成的音频超过保存上限，请缩短文本后重试。");
                    audio.Write(chunk);
                }
                if (code == 20000000)
                {
                    completed = true;
                    if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object
                        && usage.TryGetProperty("text_words", out var words)
                        && words.ValueKind == JsonValueKind.Number && words.TryGetInt64(out var count) && count >= 0)
                        audit["usage"] = new JsonObject { ["text_words"] = count };
                }
            }
            audit["parsed"] = true;
            audit["frames"] = frames;
            audit["audio_bytes"] = audio.Length;
            audit["completed"] = completed;
            if (!completed)
                return Fail("TTS_RESPONSE_INCOMPLETE", "语音服务连接结束，但未收到合成完成标记；请先检查原任务，避免重复生成。");
            if (audio.Length == 0)
                return Fail("TTS_RESPONSE_EMPTY", "语音服务报告完成，但未返回音频。");
            return new ExchangeRawResponse(true, audit.ToJsonString(), audio.ToArray(), format switch
            {
                "ogg_opus" => "audio/ogg",
                "pcm" => "audio/pcm",
                _ => "audio/mpeg",
            });
        }
        catch (JsonException)
        {
            return Fail("TTS_RESPONSE_INVALID", "语音服务返回内容无法解析；诊断信息已记录。");
        }
        catch (FormatException)
        {
            return Fail("TTS_RESPONSE_INVALID_AUDIO", "语音服务返回的音频编码无效；诊断信息已记录。");
        }
        catch (DecoderFallbackException)
        {
            return Fail("TTS_RESPONSE_INVALID", "语音服务返回内容的字符编码无效；诊断信息已记录。");
        }
    }

    private static string? ConfigString(Dictionary<string, object>? config, string key)
        => config is not null && config.TryGetValue(key, out var value) ? value?.ToString()?.Trim() : null;

    private static string RequiredString(JsonObject body, string key)
        => OptionalString(body, key) is { Length: > 0 } value ? value : throw new ArgumentException($"语音请求缺少有效的 {key}。");

    private static string? OptionalString(JsonObject body, string key)
    {
        if (body[key] is null) return null;
        return body[key] is JsonValue value && value.TryGetValue<string>(out var text)
            ? text : throw new ArgumentException($"语音参数 {key} 必须是字符串。");
    }

    private static double Number(JsonObject body, string key)
        => body[key] is JsonValue value && value.GetValueKind() == JsonValueKind.Number
            && double.TryParse(value.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number)
            ? number : throw new ArgumentException($"语音参数 {key} 必须是有限数字。");

    private static string RedactMessage(string message, JsonObject request)
    {
        // 上游错误可能回显朗读稿、指令或凭据。只保留有界的去标识原因和原文摘要。
        foreach (var key in new[] { "input", "instructions" })
            if (request[key] is JsonValue value && value.TryGetValue<string>(out var sensitive) && !string.IsNullOrEmpty(sensitive))
                message = message.Replace(sensitive, "[text omitted]", StringComparison.Ordinal);
        if (message.Length > 2048) message = message[..2048] + "[truncated]";
        message = Regex.Replace(message, @"(?i)(bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)", "[credential omitted]", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        message = Regex.Replace(message, @"\b[^\s@]+@[^\s@]+\.[^\s@]+\b", "[email omitted]", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        message = Regex.Replace(message, @"[A-Za-z0-9_+/@.=-]{12,}|\b\d{7,}\b", "[identifier omitted]", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        return message.Length <= 240 ? message : message[..240] + "[truncated]";
    }
}
