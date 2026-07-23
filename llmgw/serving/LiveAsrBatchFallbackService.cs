using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// 流式供应商不可用时的滚动窗口 ASR。它在录音过程中持续消费 PCM，
/// 每五秒经健康的批量 ASR 池转写一次，停止时只处理最后一个尾包。
/// </summary>
public sealed class LiveAsrBatchFallbackService
{
    public const int SampleRate = 16_000;
    public const int WindowSeconds = 5;
    public const int BytesPerSample = 2;
    public const int WindowBytes = SampleRate * WindowSeconds * BytesPerSample;
    public const int MinimumProviderSeconds = 15;
    public const int SpeechAmplitudeThreshold = 128;

    private readonly ILlmGateway _gateway;
    private readonly IModelResolver _resolver;
    private readonly ILogger<LiveAsrBatchFallbackService> _logger;

    public LiveAsrBatchFallbackService(
        ILlmGateway gateway,
        IModelResolver resolver,
        ILogger<LiveAsrBatchFallbackService> logger)
    {
        _gateway = gateway;
        _resolver = resolver;
        _logger = logger;
    }

    public async Task<LiveAsrSessionResult> TranscribeAsync(
        IReadOnlyList<ModelResolutionResult> candidates,
        ChannelReader<LiveAsrAudioFrame> frames,
        Func<LiveAsrEvent, Task> emit)
    {
        var provider = candidates.FirstOrDefault()?.ActualPlatformName;
        var model = candidates.FirstOrDefault()?.ActualModel;
        await emit(new LiveAsrEvent
        {
            Type = LiveAsrEventTypes.Ready,
            Provider = provider,
            Model = model,
            Message = "流式供应商不可用，已切换到滚动窗口实时转写",
        });

        using var pending = new MemoryStream();
        var transcriptParts = new List<string>();
        var windowIndex = 0;

        await foreach (var frame in frames.ReadAllAsync(CancellationToken.None))
        {
            if (frame.IsFinal)
                break;

            pending.Write(frame.Pcm);
            while (pending.Length >= WindowBytes)
            {
                var bytes = TakePrefix(pending, WindowBytes);
                windowIndex++;
                var text = await TranscribeWindowAsync(candidates, bytes, windowIndex, emit);
                if (text is null)
                {
                    return new LiveAsrSessionResult
                    {
                        Degraded = true,
                        Transcript = JoinTranscript(transcriptParts),
                        Provider = provider,
                        Model = model,
                        Error = "滚动窗口 ASR 调用失败",
                    };
                }

                if (!string.IsNullOrWhiteSpace(text))
                {
                    transcriptParts.Add(text.Trim());
                    await emit(new LiveAsrEvent
                    {
                        Type = LiveAsrEventTypes.Partial,
                        Text = JoinTranscript(transcriptParts),
                        Stable = true,
                        Provider = provider,
                        Model = model,
                        Message = "备用实时转写正在运行",
                    });
                }
            }
        }

        if (pending.Length >= SampleRate * BytesPerSample)
        {
            windowIndex++;
            var text = await TranscribeWindowAsync(candidates, pending.ToArray(), windowIndex, emit);
            if (text is null)
            {
                return new LiveAsrSessionResult
                {
                    Degraded = true,
                    Transcript = JoinTranscript(transcriptParts),
                    Provider = provider,
                    Model = model,
                    Error = "最后一个滚动窗口 ASR 调用失败",
                };
            }
            if (!string.IsNullOrWhiteSpace(text))
                transcriptParts.Add(text.Trim());
        }

        var transcript = JoinTranscript(transcriptParts);
        if (string.IsNullOrWhiteSpace(transcript))
        {
            return new LiveAsrSessionResult
            {
                Degraded = true,
                Provider = provider,
                Model = model,
                Error = "没有识别到有效语音",
            };
        }

        await emit(new LiveAsrEvent
        {
            Type = LiveAsrEventTypes.Final,
            Text = transcript,
            Stable = true,
            Provider = provider,
            Model = model,
            Message = "备用实时转写已完成",
        });
        return new LiveAsrSessionResult
        {
            Completed = true,
            Transcript = transcript,
            Provider = provider,
            Model = model,
        };
    }

    private async Task<string?> TranscribeWindowAsync(
        IReadOnlyList<ModelResolutionResult> candidates,
        byte[] pcm,
        int windowIndex,
        Func<LiveAsrEvent, Task> emit)
    {
        // 纯静音窗口不发给多模态模型。否则部分模型会把静音补全成
        // “请播放音频”等解释性文本，既污染原文又产生无效调用成本。
        if (!HasLikelySpeech(pcm))
            return string.Empty;

        var wave = EncodeWave(pcm, MinimumProviderSeconds);
        for (var index = 0; index < candidates.Count; index++)
        {
            var candidate = candidates[index];
            for (var providerAttempt = 1; providerAttempt <= 2; providerAttempt++)
            {
                await emit(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Status,
                    Provider = candidate.ActualPlatformName,
                    Model = candidate.ActualModel,
                    Attempt = (index * 2) + providerAttempt,
                    TotalAttempts = candidates.Count * 2,
                    Message = providerAttempt == 1
                        ? $"正在识别第 {windowIndex} 个实时片段"
                        : $"正在校验第 {windowIndex} 个实时片段",
                });

                try
                {
                    var response = await _gateway.SendRawWithResolutionAsync(
                        BuildRequest(candidate, wave),
                        candidate.ToGatewayResolution(),
                        CancellationToken.None);
                    var text = response.Success && !string.IsNullOrWhiteSpace(response.Content)
                        ? ExtractText(response.Content)
                        : null;
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        if (IsNoSpeech(text))
                        {
                            await _resolver.RecordSuccessAsync(candidate, CancellationToken.None);
                            return string.Empty;
                        }
                        if (!LooksLikeAssistantReply(text))
                        {
                            await _resolver.RecordSuccessAsync(candidate, CancellationToken.None);
                            return text.Trim();
                        }
                        _logger.LogWarning(
                            "滚动窗口 ASR 返回解释性回答，已拒绝写入原文 window={Window} candidate={Candidate} providerAttempt={ProviderAttempt}",
                            windowIndex,
                            candidate.ActualModel,
                            providerAttempt);
                        continue;
                    }

                    _logger.LogWarning(
                        "滚动窗口 ASR 候选返回空结果 window={Window} candidate={Candidate} status={Status} code={Code} providerAttempt={ProviderAttempt}",
                        windowIndex,
                        candidate.ActualModel,
                        response.StatusCode,
                        response.ErrorCode,
                        providerAttempt);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        ex,
                        "滚动窗口 ASR 候选失败 window={Window} candidate={Candidate} providerAttempt={ProviderAttempt}",
                        windowIndex,
                        candidate.ActualModel,
                        providerAttempt);
                }
            }
            await _resolver.RecordFailureAsync(candidate, CancellationToken.None);
        }

        return null;
    }

    public static IReadOnlyList<ModelResolutionResult> SelectBatchCandidates(
        ModelResolutionResult resolution)
    {
        return new[] { resolution }
            .Concat(resolution.RetryCandidates ?? [])
            .Where(candidate =>
                candidate.Success
                && !(candidate.IsExchange
                    && string.Equals(
                        candidate.ExchangeTransformerType,
                        "doubao-asr-stream",
                        StringComparison.OrdinalIgnoreCase)))
            .GroupBy(
                candidate => $"{candidate.ActualPlatformId}::{candidate.ActualModel}",
                StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .Take(LiveAsrCandidatePolicy.MaxAttempts)
            .ToList();
    }

    public static byte[] EncodeWave(byte[] pcm, int minimumSeconds)
    {
        var minimumBytes = SampleRate * BytesPerSample * Math.Max(0, minimumSeconds);
        var dataLength = Math.Max(pcm.Length, minimumBytes);
        var result = new byte[44 + dataLength];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(result, 0);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(4, 4), 36 + dataLength);
        Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(result, 8);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(16, 4), 16);
        BinaryPrimitives.WriteInt16LittleEndian(result.AsSpan(20, 2), 1);
        BinaryPrimitives.WriteInt16LittleEndian(result.AsSpan(22, 2), 1);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(24, 4), SampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(28, 4), SampleRate * BytesPerSample);
        BinaryPrimitives.WriteInt16LittleEndian(result.AsSpan(32, 2), BytesPerSample);
        BinaryPrimitives.WriteInt16LittleEndian(result.AsSpan(34, 2), 16);
        Encoding.ASCII.GetBytes("data").CopyTo(result, 36);
        BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(40, 4), dataLength);
        pcm.CopyTo(result, 44);
        return result;
    }

    public static string? ExtractText(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
                return text.GetString();
            if (root.TryGetProperty("result", out var result)
                && result.TryGetProperty("text", out var resultText)
                && resultText.ValueKind == JsonValueKind.String)
                return resultText.GetString();
            if (root.TryGetProperty("choices", out var choices)
                && choices.ValueKind == JsonValueKind.Array
                && choices.GetArrayLength() > 0
                && choices[0].TryGetProperty("message", out var message)
                && message.TryGetProperty("content", out var content))
            {
                if (content.ValueKind == JsonValueKind.String)
                    return content.GetString();
                if (content.ValueKind == JsonValueKind.Array)
                {
                    return string.Concat(content.EnumerateArray()
                        .Where(item => item.TryGetProperty("text", out var part)
                            && part.ValueKind == JsonValueKind.String)
                        .Select(item => item.GetProperty("text").GetString()));
                }
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
    }

    private static GatewayRawRequest BuildRequest(ModelResolutionResult candidate, byte[] wave)
    {
        if (candidate.IsExchange
            && string.Equals(candidate.ExchangeTransformerType, "doubao-asr", StringComparison.OrdinalIgnoreCase))
        {
            return BaseRequest(
                candidate,
                requestBody: new JsonObject { ["audio_data"] = Convert.ToBase64String(wave) });
        }

        if (ShouldUseChatAudio(candidate))
        {
            return BaseRequest(
                candidate,
                endpointPath: "/v1/chat/completions",
                requestBody: new JsonObject
                {
                    ["model"] = candidate.ActualModel,
                    ["modalities"] = new JsonArray("text"),
                    ["messages"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["role"] = "user",
                            ["content"] = new JsonArray
                            {
                                new JsonObject
                                {
                                    ["type"] = "text",
                                    ["text"] = "音频已附在本消息中。请逐字转写，只输出音频里真实说出的话，不要解释、确认或要求播放音频；没有人声时只输出 NO_SPEECH。",
                                },
                                new JsonObject
                                {
                                    ["type"] = "input_audio",
                                    ["input_audio"] = new JsonObject
                                    {
                                        ["data"] = Convert.ToBase64String(wave),
                                        ["format"] = "wav",
                                    },
                                },
                            },
                        },
                    },
                });
        }

        return BaseRequest(
            candidate,
            endpointPath: "/v1/audio/transcriptions",
            multipartFields: new Dictionary<string, object>
            {
                ["model"] = candidate.ActualModel ?? "whisper-1",
                ["response_format"] = "verbose_json",
                ["timestamp_granularities[]"] = "segment",
            },
            multipartFiles: new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
            {
                ["file"] = ("live-window.wav", wave, "audio/wav"),
            });
    }

    private static GatewayRawRequest BaseRequest(
        ModelResolutionResult candidate,
        string? endpointPath = null,
        JsonObject? requestBody = null,
        Dictionary<string, object>? multipartFields = null,
        Dictionary<string, (string FileName, byte[] Content, string MimeType)>? multipartFiles = null)
    {
        return new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ModelType = ModelTypes.Asr,
            ExpectedModel = candidate.ActualModel,
            PinnedPlatformId = candidate.ActualPlatformId,
            PinnedModelId = candidate.ActualModel,
            EndpointPath = endpointPath,
            RequestBody = requestBody,
            IsMultipart = multipartFiles is not null,
            MultipartFields = multipartFields,
            MultipartFiles = multipartFiles,
            TimeoutSeconds = 90,
            Context = new GatewayRequestContext
            {
                RequestId = $"live-window-{Guid.NewGuid():N}",
            },
        };
    }

    private static bool ShouldUseChatAudio(ModelResolutionResult candidate)
    {
        var model = candidate.ActualModel?.Trim().ToLowerInvariant() ?? string.Empty;
        if (model.Contains("whisper", StringComparison.Ordinal) || model.Length == 0)
            return false;
        if (!model.Contains("audio", StringComparison.Ordinal)
            && !model.Contains("gemini", StringComparison.Ordinal))
            return false;

        var protocol = candidate.Protocol?.Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(protocol) && protocol != "unknown")
            return protocol is "openai" or "openai-compatible" or "openrouter";

        var platform = candidate.PlatformType?.Trim().ToLowerInvariant();
        return platform is not ("google" or "gemini" or "anthropic" or "claude" or "exchange");
    }

    private static byte[] TakePrefix(MemoryStream stream, int count)
    {
        var source = stream.ToArray();
        var prefix = source.AsSpan(0, count).ToArray();
        stream.SetLength(0);
        stream.Write(source, count, source.Length - count);
        return prefix;
    }

    private static bool IsNoSpeech(string text)
        => text.Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase);

    public static bool LooksLikeAssistantReply(string text)
    {
        var normalized = text.Trim();
        if (normalized.Length == 0)
            return false;

        var mentionsAudio = normalized.Contains("音频", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("audio", StringComparison.OrdinalIgnoreCase);
        if (!mentionsAudio)
            return false;

        return normalized.StartsWith("请提供", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("请上传", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("请播放", StringComparison.OrdinalIgnoreCase)
            || (normalized.StartsWith("好的", StringComparison.OrdinalIgnoreCase)
                && (normalized.Contains("请提供", StringComparison.OrdinalIgnoreCase)
                    || normalized.Contains("请上传", StringComparison.OrdinalIgnoreCase)
                    || normalized.Contains("请播放", StringComparison.OrdinalIgnoreCase)))
            || normalized.Contains("无法访问", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("无法听到", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("我将为您", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("我将开始", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("provide the audio", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("please provide the audio", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("upload the audio", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("please upload the audio", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("play the audio", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("please play the audio", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("cannot access the audio", StringComparison.OrdinalIgnoreCase);
    }

    public static bool HasLikelySpeech(byte[] pcm)
    {
        if (pcm.Length < BytesPerSample)
            return false;

        var samples = pcm.Length / BytesPerSample;
        var requiredActiveSamples = Math.Max(8, samples / 100);
        var activeSamples = 0;
        for (var offset = 0; offset + 1 < pcm.Length; offset += BytesPerSample)
        {
            var amplitude = Math.Abs((int)BinaryPrimitives.ReadInt16LittleEndian(
                pcm.AsSpan(offset, BytesPerSample)));
            if (amplitude < SpeechAmplitudeThreshold)
                continue;
            activeSamples++;
            if (activeSamples >= requiredActiveSamples)
                return true;
        }
        return false;
    }

    private static string JoinTranscript(IEnumerable<string> parts)
        => string.Join(" ", parts.Where(part => !string.IsNullOrWhiteSpace(part))).Trim();
}
