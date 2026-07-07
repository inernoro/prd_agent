using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[ApiExplorerSettings(IgnoreApi = true)]
[Route("api/ops/llmgw/canary")]
public sealed class LlmGatewayOpsCanaryController : ControllerBase
{
    private const string DefaultAppCallerCode = AppCallerRegistry.TranscriptAgent.Transcribe.Audio;
    private readonly IHttpClientFactory _httpFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<HttpLlmGatewayClient> _gatewayLogger;
    private readonly ILogger<LlmGatewayOpsCanaryController> _logger;
    private readonly ILLMRequestContextAccessor _ctxAccessor;
    private readonly IAssetStorage _assetStorage;

    public LlmGatewayOpsCanaryController(
        IHttpClientFactory httpFactory,
        IConfiguration config,
        ILogger<HttpLlmGatewayClient> gatewayLogger,
        ILogger<LlmGatewayOpsCanaryController> logger,
        ILLMRequestContextAccessor ctxAccessor,
        IAssetStorage assetStorage)
    {
        _httpFactory = httpFactory;
        _config = config;
        _gatewayLogger = gatewayLogger;
        _logger = logger;
        _ctxAccessor = ctxAccessor;
        _assetStorage = assetStorage;
    }

    [HttpPost("asr")]
    public async Task<IActionResult> RunAsrCanary([FromBody] LlmGatewayAsrCanaryRequest? request, CancellationToken ct)
    {
        if (!GatewayKeyMatches())
        {
            return Unauthorized(new LlmGatewayAsrCanaryResponse(
                Success: false,
                RequestId: "",
                AppCallerCode: request?.AppCallerCode ?? DefaultAppCallerCode,
                Stage: "auth",
                Model: null,
                StatusCode: 401,
                ErrorCode: "GATEWAY_KEY_INVALID",
                ErrorMessage: "X-Gateway-Key 不正确。",
                ContentPreview: null,
                ContentType: null,
                AudioBytes: 0));
        }

        var appCallerCode = string.IsNullOrWhiteSpace(request?.AppCallerCode)
            ? DefaultAppCallerCode
            : request!.AppCallerCode.Trim();
        var requestId = string.IsNullOrWhiteSpace(request?.RequestId)
            ? "llmgw-asr-canary-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ")
            : request!.RequestId.Trim();
        var audio = CreateSilentWav();
        var timeoutSeconds = Math.Clamp(request?.TimeoutSeconds ?? 120, 15, 600);

        var gateway = new HttpLlmGatewayClient(
            _httpFactory,
            _config,
            _gatewayLogger,
            _ctxAccessor,
            _assetStorage);

        using var scope = _ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: "ops-canary",
            ViewRole: "ops",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "llmgw-asr-canary",
            RequestType: ModelTypes.Asr,
            AppCallerCode: appCallerCode,
            GatewayTransport: GatewayTransports.Http));

        var resolution = await gateway.ResolveModelAsync(
            appCallerCode,
            ModelTypes.Asr,
            request?.ExpectedModel,
            request?.PinnedPlatformId,
            request?.PinnedModelId,
            ct);

        if (!resolution.Success)
        {
            return Ok(new LlmGatewayAsrCanaryResponse(
                Success: false,
                RequestId: requestId,
                AppCallerCode: appCallerCode,
                Stage: "resolve",
                Model: resolution.ActualModel,
                StatusCode: 0,
                ErrorCode: "RESOLUTION_FAILED",
                ErrorMessage: Truncate(resolution.ErrorMessage, 1000),
                ContentPreview: null,
                ContentType: null,
                AudioBytes: audio.Length));
        }

        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Asr,
            EndpointPath = "/v1/audio/transcriptions",
            ExpectedModel = resolution.ActualModel,
            PinnedPlatformId = request?.PinnedPlatformId,
            PinnedModelId = request?.PinnedModelId,
            IsMultipart = true,
            MultipartFields = new Dictionary<string, object>
            {
                ["model"] = resolution.ActualModel ?? request?.ExpectedModel ?? "whisper-1",
                ["response_format"] = "verbose_json",
                ["timestamp_granularities[]"] = "segment",
                ["language"] = request?.Language ?? "",
            },
            MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
            {
                ["file"] = ("llmgw-asr-canary.wav", audio, "audio/wav"),
            },
            TimeoutSeconds = timeoutSeconds,
            Context = new GatewayRequestContext
            {
                RequestId = requestId,
                UserId = "ops-canary",
                ViewRole = "ops",
                QuestionText = "LLM Gateway ASR canary",
                GatewayTransport = GatewayTransports.Http,
                IsHealthProbe = true,
            },
        };

        var raw = await gateway.SendRawWithResolutionAsync(rawRequest, resolution, ct);
        _logger.LogInformation(
            "LLM Gateway ASR canary completed. requestId={RequestId} appCaller={AppCallerCode} success={Success} status={StatusCode} model={Model}",
            requestId,
            appCallerCode,
            raw.Success,
            raw.StatusCode,
            resolution.ActualModel);

        return Ok(new LlmGatewayAsrCanaryResponse(
            Success: raw.Success,
            RequestId: requestId,
            AppCallerCode: appCallerCode,
            Stage: "raw",
            Model: resolution.ActualModel,
            StatusCode: raw.StatusCode,
            ErrorCode: raw.ErrorCode,
            ErrorMessage: Truncate(raw.ErrorMessage, 1000),
            ContentPreview: Truncate(raw.Content, 2000),
            ContentType: raw.ContentType,
            AudioBytes: audio.Length));
    }

    private bool GatewayKeyMatches()
    {
        var expected = (_config["LlmGwServe:ApiKey"] ?? string.Empty).Trim();
        var provided = Request.Headers["X-Gateway-Key"].ToString().Trim();
        if (expected.Length == 0 || provided.Length == 0)
        {
            return false;
        }

        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        var providedBytes = Encoding.UTF8.GetBytes(provided);
        return expectedBytes.Length == providedBytes.Length
            && CryptographicOperations.FixedTimeEquals(expectedBytes, providedBytes);
    }

    private static byte[] CreateSilentWav()
    {
        const int sampleRate = 16000;
        const short channels = 1;
        const short bitsPerSample = 16;
        const int samples = sampleRate / 10;
        var pcmBytes = samples * channels * bitsPerSample / 8;

        using var ms = new MemoryStream();
        using var writer = new BinaryWriter(ms, Encoding.ASCII, leaveOpen: true);
        writer.Write("RIFF"u8.ToArray());
        writer.Write(36 + pcmBytes);
        writer.Write("WAVE"u8.ToArray());
        writer.Write("fmt "u8.ToArray());
        writer.Write(16);
        writer.Write((short)1);
        writer.Write(channels);
        writer.Write(sampleRate);
        writer.Write(sampleRate * channels * bitsPerSample / 8);
        writer.Write((short)(channels * bitsPerSample / 8));
        writer.Write(bitsPerSample);
        writer.Write("data"u8.ToArray());
        writer.Write(pcmBytes);
        writer.Write(new byte[pcmBytes]);
        writer.Flush();
        return ms.ToArray();
    }

    private static string? Truncate(string? value, int max)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= max)
        {
            return value;
        }

        return value[..max] + "...";
    }
}

public sealed record LlmGatewayAsrCanaryRequest(
    string? AppCallerCode = null,
    string? ExpectedModel = null,
    string? PinnedPlatformId = null,
    string? PinnedModelId = null,
    string? Language = null,
    string? RequestId = null,
    int? TimeoutSeconds = null);

public sealed record LlmGatewayAsrCanaryResponse(
    bool Success,
    string RequestId,
    string AppCallerCode,
    string Stage,
    string? Model,
    int StatusCode,
    string? ErrorCode,
    string? ErrorMessage,
    string? ContentPreview,
    string? ContentType,
    int AudioBytes);
