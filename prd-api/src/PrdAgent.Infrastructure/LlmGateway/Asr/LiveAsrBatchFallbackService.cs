using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.LlmGateway.Asr;

namespace PrdAgent.Infrastructure.LlmGateway.Asr;

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
    public const int ProviderValidationAttempts = 4;

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
        Func<LiveAsrEvent, Task> emit,
        Action? onUpstreamRequest,
        GatewayRequestContext requestContext)
    {
        string? provider = null;
        string? model = null;
        await emit(new LiveAsrEvent
        {
            Type = LiveAsrEventTypes.Ready,
            // 此时尚未有候选成功，不预报首选方案为实际执行方。真实身份从
            // 首个成功窗口开始写入 partial/final 与会话结果。
            Provider = null,
            Model = null,
            Message = "已启用分段实时转写，约 5 秒后显示第一段；录音仍会安全保存，结束后将用完整音频自动校准。",
        });

        // 候选状态属于整个录音会话，不属于单个五秒窗口。某候选完整失败后从
        // 本会话移除；成功候选晋升到首位，后续窗口不再反复等待已知故障方案。
        var sessionCandidates = candidates.ToList();
        using var pending = new MemoryStream();
        var transcriptParts = new List<string>();
        var windowIndex = 0;
        var expectedSequence = 1L;
        var completeAudioCoverage = true;
        var receivedFinalFrame = false;

        await foreach (var frame in frames.ReadAllAsync(CancellationToken.None))
        {
            if (frame.IsFinal)
            {
                receivedFinalFrame = true;
                completeAudioCoverage &= frame.Sequence == expectedSequence;
                break;

            }

            if (frame.Sequence != expectedSequence)
                completeAudioCoverage = false;
            expectedSequence = frame.Sequence + 1;

            pending.Write(frame.Pcm);
            while (pending.Length >= WindowBytes)
            {
                var bytes = TakePrefix(pending, WindowBytes);
                windowIndex++;
                var window = await TranscribeWindowAsync(
                    sessionCandidates,
                    bytes,
                    windowIndex,
                    emit,
                    onUpstreamRequest,
                    requestContext);
                if (!window.Succeeded)
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

                if (window.Candidate != null)
                {
                    provider = window.Candidate.ActualPlatformName;
                    model = window.Candidate.ActualModel;
                }
                if (!string.IsNullOrWhiteSpace(window.Text))
                {
                    transcriptParts.Add(window.Text.Trim());
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

        // 只要还有 PCM 就必须处理。结尾不足一秒也可能包含最后几个字；
        // EncodeWave 会补齐供应商要求的时长，静音门则负责跳过真正的空尾包。
        if (pending.Length > 0)
        {
            windowIndex++;
            var window = await TranscribeWindowAsync(
                sessionCandidates,
                pending.ToArray(),
                windowIndex,
                emit,
                onUpstreamRequest,
                requestContext);
            if (!window.Succeeded)
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
            if (window.Candidate != null)
            {
                provider = window.Candidate.ActualPlatformName;
                model = window.Candidate.ActualModel;
            }
            if (!string.IsNullOrWhiteSpace(window.Text))
                transcriptParts.Add(window.Text.Trim());
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

        if (!receivedFinalFrame || !completeAudioCoverage)
        {
            return new LiveAsrSessionResult
            {
                Degraded = true,
                Transcript = transcript,
                Provider = provider,
                Model = model,
                Error = "备用实时转写只覆盖部分录音，必须使用完整录音重新校准",
            };
        }

        const string calibrationMessage =
            "备用实时预览已生成，录音结束后将使用完整音频自动校准";
        await emit(new LiveAsrEvent
        {
            Type = LiveAsrEventTypes.Degraded,
            Text = transcript,
            Stable = false,
            Provider = provider,
            Model = model,
            ErrorCode = "LIVE_ASR_BATCH_REQUIRES_CALIBRATION",
            Message = calibrationMessage,
        });
        return new LiveAsrSessionResult
        {
            Degraded = true,
            Transcript = transcript,
            Provider = provider,
            Model = model,
            Error = calibrationMessage,
        };
    }

    private async Task<BatchWindowResult> TranscribeWindowAsync(
        List<ModelResolutionResult> candidates,
        byte[] pcm,
        int windowIndex,
        Func<LiveAsrEvent, Task> emit,
        Action? onUpstreamRequest,
        GatewayRequestContext requestContext)
    {
        // 纯静音窗口不发给多模态模型。否则部分模型会把静音补全成
        // “请播放音频”等解释性文本，既污染原文又产生无效调用成本。
        if (!HasLikelySpeech(pcm))
            return BatchWindowResult.Silent;

        var wave = EncodeWave(pcm, MinimumProviderSeconds);
        var orderedCandidates = candidates.ToArray();
        for (var index = 0; index < orderedCandidates.Length; index++)
        {
            var candidate = orderedCandidates[index];
            if (!AsrRequestContractPolicy.TryValidateOfferingEndpoint(
                    candidate.ActualModel,
                    candidate.Protocol,
                    candidate.PlatformType,
                    candidate.OfferingEndpointPath,
                    candidate.IsExchange,
                    out var routeError))
            {
                _logger.LogError(
                    "滚动窗口 ASR 拒绝不兼容的 Offering window={Window} offering={Offering} model={Model} endpoint={Endpoint} error={Error}",
                    windowIndex,
                    candidate.OfferingId,
                    candidate.ActualModel,
                    candidate.OfferingEndpointPath,
                    routeError);
                continue;
            }
            for (var providerAttempt = 1;
                 providerAttempt <= ProviderValidationAttempts;
                 providerAttempt++)
            {
                await emit(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Status,
                    Provider = candidate.ActualPlatformName,
                    Model = candidate.ActualModel,
                    Attempt = (index * ProviderValidationAttempts) + providerAttempt,
                    TotalAttempts = orderedCandidates.Length * ProviderValidationAttempts,
                    Message = providerAttempt == 1
                        ? $"正在识别第 {windowIndex} 个实时片段"
                        : $"正在进行第 {providerAttempt - 1} 次转写校验",
                });

                try
                {
                    var request = BuildRequest(candidate, wave, providerAttempt, requestContext);
                    onUpstreamRequest?.Invoke();
                    var response = await _gateway.SendRawWithResolutionAsync(
                        request,
                        candidate.ToGatewayResolution(),
                        CancellationToken.None);
                    var text = response.Success && !string.IsNullOrWhiteSpace(response.Content)
                        ? ExtractText(response.Content)
                        : null;
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        if (IsNoSpeech(text))
                        {
                            await RecordHealthBestEffortAsync(candidate, succeeded: true);
                            PromoteCandidate(candidates, candidate);
                            return new BatchWindowResult(true, string.Empty, candidate);
                        }
                        if (!LooksLikeAssistantReply(text))
                        {
                            await RecordHealthBestEffortAsync(candidate, succeeded: true);
                            PromoteCandidate(candidates, candidate);
                            return new BatchWindowResult(true, text.Trim(), candidate);
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
                    // 传输或供应商明确失败时立即切换，不把四次“回答校验”额度
                    // 浪费在已不可用的候选上。只有成功响应但文本无效才继续校验。
                    if (!response.Success)
                        break;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        ex,
                        "滚动窗口 ASR 候选失败 window={Window} candidate={Candidate} providerAttempt={ProviderAttempt}",
                        windowIndex,
                        candidate.ActualModel,
                        providerAttempt);
                    break;
                }
            }
            await RecordHealthBestEffortAsync(candidate, succeeded: false);
            candidates.Remove(candidate);
        }

        return BatchWindowResult.Failed;
    }

    private async Task RecordHealthBestEffortAsync(
        ModelResolutionResult candidate,
        bool succeeded)
    {
        try
        {
            if (succeeded)
                await _resolver.RecordSuccessAsync(candidate, CancellationToken.None);
            else
                await _resolver.RecordFailureAsync(candidate, CancellationToken.None);
        }
        catch (Exception ex)
        {
            // 健康度持久化只影响后续候选排序，不能丢弃已经识别出的窗口原文。
            _logger.LogWarning(
                ex,
                "滚动窗口 ASR 候选健康度写入失败 succeeded={Succeeded} candidate={Candidate}",
                succeeded,
                candidate.ActualModel);
        }
    }

    private static void PromoteCandidate(
        List<ModelResolutionResult> candidates,
        ModelResolutionResult candidate)
    {
        var index = candidates.IndexOf(candidate);
        if (index <= 0)
            return;
        candidates.RemoveAt(index);
        candidates.Insert(0, candidate);
    }

    private sealed record BatchWindowResult(
        bool Succeeded,
        string Text,
        ModelResolutionResult? Candidate)
    {
        public static BatchWindowResult Silent { get; } = new(true, string.Empty, null);
        public static BatchWindowResult Failed { get; } = new(false, string.Empty, null);
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

    private static GatewayRawRequest BuildRequest(
        ModelResolutionResult candidate,
        byte[] wave,
        int providerAttempt,
        GatewayRequestContext requestContext)
    {
        if (candidate.IsExchange
            && string.Equals(candidate.ExchangeTransformerType, "doubao-asr", StringComparison.OrdinalIgnoreCase))
        {
            return BaseRequest(
                candidate,
                requestContext,
                requestBody: new JsonObject { ["audio_data"] = Convert.ToBase64String(wave) });
        }

        if (ShouldUseChatAudio(candidate))
        {
            var prompt = providerAttempt == 1
                ? "音频已附在本消息的 input_audio 中。请逐字转写，只输出音频里真实说出的话，不要解释、确认或要求播放音频；没有人声时只输出 NO_SPEECH。"
                : $"这是第 {providerAttempt - 1} 次结果校验。必须读取本消息 input_audio 里的 WAV 音频，只输出真实人声原文；禁止要求用户再次提供、上传或播放音频。没有人声时只输出 NO_SPEECH。";
            return BaseRequest(
                candidate,
                requestContext,
                endpointPath: "/v1/chat/completions",
                requestBody: new JsonObject
                {
                    ["model"] = candidate.ActualModel,
                    ["modalities"] = new JsonArray("text"),
                    ["temperature"] = 0,
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
                                    ["text"] = prompt,
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
            requestContext,
            endpointPath: AsrRequestContractPolicy.TranscriptionsEndpoint,
            multipartFields: AsrRequestContractPolicy.BuildTranscriptionFields(candidate.ActualModel),
            multipartFiles: new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
            {
                ["file"] = ("live-window.wav", wave, "audio/wav"),
            });
    }

    private static GatewayRawRequest BaseRequest(
        ModelResolutionResult candidate,
        GatewayRequestContext requestContext,
        string? endpointPath = null,
        JsonObject? requestBody = null,
        Dictionary<string, object>? multipartFields = null,
        Dictionary<string, (string FileName, byte[] Content, string MimeType)>? multipartFiles = null)
    {
        return new GatewayRawRequest
        {
            RequiredOfferingId = candidate.OfferingId,
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
            // 原始请求必须携带 serving 已验证的租户与服务密钥身份。环境作用域只供
            // ModelResolver 使用，LlmGateway 的安全出站、归因和并发核算读取请求本身。
            Context = GatewayRequestContext.WithRequestId(
                requestContext,
                $"live-window-{Guid.NewGuid():N}"),
        };
    }

    private static bool ShouldUseChatAudio(ModelResolutionResult candidate)
        => AsrRequestContractPolicy.ShouldUseChatAudio(
            candidate.ActualModel,
            candidate.Protocol,
            candidate.PlatformType);

    private static byte[] TakePrefix(MemoryStream stream, int count)
    {
        var source = stream.ToArray();
        var prefix = source.AsSpan(0, count).ToArray();
        stream.SetLength(0);
        stream.Write(source, count, source.Length - count);
        return prefix;
    }

    private static bool IsNoSpeech(string text)
        => TranscribeNoteText.IsNoSpeechSentinel(text);

    public static bool LooksLikeAssistantReply(string text)
    {
        var normalized = text.Trim();
        if (normalized.Length == 0)
            return false;

        var mentionsAudio = normalized.Contains("音频", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("audio", StringComparison.OrdinalIgnoreCase);
        if (!mentionsAudio)
            return false;

        var startsLikeAssistant = normalized.StartsWith("好的", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("可以", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("请", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("please", StringComparison.OrdinalIgnoreCase);
        var requestsAudioInput = (normalized.Contains("请", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("please", StringComparison.OrdinalIgnoreCase))
            && (normalized.Contains("提供", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("上传", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("播放", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("发送", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("provide", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("upload", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("play", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("send", StringComparison.OrdinalIgnoreCase));
        var promisesTranscription = (normalized.StartsWith("我会", StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith("我将", StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith("I will", StringComparison.OrdinalIgnoreCase))
            && (normalized.Contains("转写", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("转录", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("transcribe", StringComparison.OrdinalIgnoreCase))
            && (normalized.Contains("立即", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("马上", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("开始", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("为您", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("帮您", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("right away", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("for you", StringComparison.OrdinalIgnoreCase));

        return (startsLikeAssistant && requestsAudioInput)
            || promisesTranscription
            || normalized.StartsWith("请提供", StringComparison.OrdinalIgnoreCase)
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
