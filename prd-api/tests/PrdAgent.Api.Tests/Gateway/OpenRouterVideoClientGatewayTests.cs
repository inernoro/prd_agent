using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Tests.Gateway;

public class OpenRouterVideoClientGatewayTests
{
    [Fact]
    public void VideoErrors_ShouldNeverExposeProviderDiagnosticsToUsers()
    {
        var quota = VideoGenerationUserError.FromGateway(new GatewayRawResponse
        {
            Success = false,
            StatusCode = 402,
            ErrorCode = "LLM_QUOTA_EXCEEDED",
            ErrorMessage = "大模型平台额度已用尽或被限额。上游信息：Insufficient credits. Add more using https://openrouter.ai/settings/credits",
        });
        var generic = VideoGenerationUserError.FromGateway(new GatewayRawResponse
        {
            Success = false,
            StatusCode = 500,
            ErrorCode = "PROVIDER_ERROR",
            Content = "{\"error\":{\"message\":\"provider token invalid at https://provider.example/settings\"}}",
        });

        quota.ShouldBe(GatewayQuotaAlertPolicy.UserReadableQuotaMessage);
        generic.ShouldBe(VideoGenerationUserError.ServiceUnavailable());
        quota.ShouldNotContain("上游信息");
        quota.ShouldNotContain("http");
        generic.ShouldNotContain("provider");
        generic.ShouldNotContain("http");
    }

    [Fact]
    public void VideoErrors_ShouldKeepKnownRecoveryActionsWithoutRawProtocolDetails()
    {
        VideoGenerationUserError.FromDiagnostic(
                "Duration 6s is not supported for this model. Supported durations: 5, 10s")
            .ShouldBe("当前模型不支持 6 秒视频，仅支持 5, 10 秒。请改用支持的时长后重试。");
        VideoGenerationUserError.FromDiagnostic("upstream timeout", 408)
            .ShouldBe("视频生成等待超时，请稍后重试。");
        VideoGenerationUserError.FromDiagnostic("bad request details", 400)
            .ShouldBe("当前视频模型无法处理这次请求，请检查描述、参考图和视频参数后重试。");
    }

    [Fact]
    public void PersistenceGate_ShouldSanitizeWorkerAndHistoricalRunErrors()
    {
        const string upstream = "大模型平台额度已用尽或被限额，请充值或更换 API Key。上游信息：Insufficient credits. Add more using https://openrouter.ai/settings/credits";
        var run = new VideoGenRun
        {
            ErrorCode = "VIDEOGEN_ERROR",
            ErrorMessage = upstream,
            ExportErrorMessage = "ffmpeg provider failed at https://provider.example/log",
            Scenes = [new VideoGenScene { ErrorMessage = upstream }],
        };

        VideoGenerationUserError.ForPersistence("VIDEOGEN_ERROR", upstream)
            .ShouldBe(GatewayQuotaAlertPolicy.UserReadableQuotaMessage);
        VideoGenerationUserError.ForPersistence("EMPTY_PROMPT", "directPrompt 为空")
            .ShouldBe("视频描述为空，请返回并输入内容后重试。");
        VideoGenerationUserError.ForPersistence("DOWNLOAD_FAILED", upstream)
            .ShouldBe(VideoGenerationUserError.DownloadUnavailable());

        VideoGenerationUserError.SanitizeForResponse(run);
        run.ErrorMessage.ShouldBe(GatewayQuotaAlertPolicy.UserReadableQuotaMessage);
        run.ExportErrorMessage.ShouldBe("视频导出暂时失败，请稍后重试。若持续出现，请联系管理员。");
        run.Scenes.Single().ErrorMessage.ShouldBe(GatewayQuotaAlertPolicy.UserReadableQuotaMessage);
        run.ErrorMessage.ShouldNotContain("上游信息");
        run.ExportErrorMessage.ShouldNotContain("http");
        run.Scenes.Single().ErrorMessage.ShouldNotContain("API Key");
    }

    [Fact]
    public void PersistenceGate_ShouldKeepSafeActionableVideoStates()
    {
        VideoGenerationUserError.ForPersistence("MODEL_RESOLVE_FAILED", "模型调度失败: provider token invalid")
            .ShouldBe("当前没有可用的视频生成模型，请联系管理员检查模型配置后重试。");
        VideoGenerationUserError.ForPersistence("EXPORT_FAILED", "存在尚未生成的视频分镜")
            .ShouldBe("仍有分镜尚未生成，请完成全部分镜后再导出。");
        VideoGenerationUserError.ForPersistence("SCENE_RENDER_FAILED", "生成提交进程已中断")
            .ShouldContain("手动重试");
    }

    [Fact]
    public void HistoricalErrorEvents_ShouldBeSanitizedDuringReplay()
    {
        const string upstream = "provider token invalid at https://provider.example/settings";
        var runPayload = VideoGenerationUserError.SanitizeEventPayload(
            "run.error",
            $"{{\"code\":\"VIDEOGEN_ERROR\",\"message\":\"{upstream}\"}}");
        var scenePayload = VideoGenerationUserError.SanitizeEventPayload(
            "scene.render.error",
            $"{{\"sceneIndex\":1,\"message\":\"{upstream}\"}}");
        var progressPayload = "{\"progress\":35}";

        JsonNode.Parse(runPayload)!["message"]!.GetValue<string>()
            .ShouldBe(VideoGenerationUserError.ServiceUnavailable());
        runPayload.ShouldNotContain("provider");
        runPayload.ShouldNotContain("http");
        scenePayload.ShouldNotContain("token");
        VideoGenerationUserError.SanitizeEventPayload("phase.progress", progressPayload)
            .ShouldBe(progressPayload);
    }

    [Fact]
    public async Task SubmitStatusAndDownload_ShouldUseGatewayRawPath()
    {
        var gateway = new CapturingGateway();
        var contextAccessor = new LLMRequestContextAccessor();
        using var contextScope = contextAccessor.BeginScope(new LlmRequestContext(
            RequestId: "req-1",
            GroupId: null,
            SessionId: "video-run-1",
            UserId: "user-1",
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: ModelTypes.VideoGen,
            AppCallerCode: AppCallerRegistry.VideoAgent.VideoGen.Generate,
            RunId: "video-run-1",
            LogicalRequestId: "video-run-1"));
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(new HttpClient(new CapturingHandler(_ => throw new NotSupportedException()))),
            new AllowingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance,
            contextAccessor);

        var submit = await client.SubmitAsync(new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate,
            Model = "openrouter/test-video",
            Prompt = "生成一个产品演示视频",
            FirstFrameImageUrl = "https://example.test/frame.png",
            LastFrameImageUrl = "https://example.test/last.png",
            ReferenceImageUrls = ["https://example.test/character.png"],
            AspectRatio = "16:9",
            Resolution = "720p",
            DurationSeconds = 6,
            GenerateAudio = true,
            Seed = 42,
            UserId = "user-1",
            RequestId = "req-1",
        });

        submit.Success.ShouldBeTrue(submit.ErrorMessage);
        submit.JobId.ShouldBe("job-123");
        submit.ActualModel.ShouldBe("openrouter/test-video");
        submit.ActualDurationSeconds.ShouldBe(5);

        var status = await client.GetStatusAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "job-123");
        status.Status.ShouldBe("completed");
        status.VideoUrl.ShouldBe("https://example.test/video.mp4");

        var download = await client.DownloadVideoBytesAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "job-123");
        download.Success.ShouldBeTrue(download.ErrorMessage);
        download.Bytes.ShouldBe([1, 2, 3, 4]);
        download.ContentType.ShouldBe("video/mp4");

        gateway.ResolveCalls.Count.ShouldBe(1);
        gateway.ResolveCalls[0].AppCallerCode.ShouldBe(AppCallerRegistry.VideoAgent.VideoGen.Generate);
        gateway.ResolveCalls[0].ModelType.ShouldBe(ModelTypes.VideoGen);
        gateway.ResolveCalls[0].ExpectedModel.ShouldBe("openrouter/test-video");

        gateway.RawCalls.Count.ShouldBe(3);

        var submitCall = gateway.RawCalls[0];
        submitCall.Request.AppCallerCode.ShouldBe(AppCallerRegistry.VideoAgent.VideoGen.Generate);
        submitCall.Request.ModelType.ShouldBe(ModelTypes.VideoGen);
        submitCall.Request.EndpointPath.ShouldBe("/videos");
        submitCall.Request.HttpMethod.ShouldBe("POST");
        submitCall.Request.Context.ShouldNotBeNull();
        submitCall.Request.Context!.RequestId.ShouldBe("req-1");
        submitCall.Request.Context.UserId.ShouldBe("user-1");
        submitCall.Request.Context.QuestionText.ShouldBe("生成一个产品演示视频");
        submitCall.Request.Context.RunId.ShouldBe("video-run-1");
        submitCall.Request.Context.LogicalRequestId.ShouldBe("video-run-1");
        submitCall.Request.Context.ProviderTaskId.ShouldBeNull();
        submitCall.Resolution.ActualModel.ShouldBe("openrouter/test-video");
        submitCall.Request.RequestBody.ShouldNotBeNull();
        submitCall.Request.RequestBody!["model"]!.GetValue<string>().ShouldBe("openrouter/test-video");
        submitCall.Request.RequestBody!["prompt"]!.GetValue<string>().ShouldBe("生成一个产品演示视频");
        submitCall.Request.RequestBody!["duration"]!.GetValue<int>().ShouldBe(5);
        var frameImages = submitCall.Request.RequestBody!["frame_images"]!.AsArray();
        frameImages.Count.ShouldBe(3);
        frameImages[0]!["frame_type"]!.GetValue<string>().ShouldBe("first_frame");
        frameImages[1]!["frame_type"]!.GetValue<string>().ShouldBe("last_frame");
        frameImages[2]!["frame_type"]!.GetValue<string>().ShouldBe("reference_image");

        var statusCall = gateway.RawCalls[1];
        statusCall.Request.EndpointPath.ShouldBe("/videos/job-123");
        statusCall.Request.HttpMethod.ShouldBe("GET");
        statusCall.Resolution.ShouldBe(gateway.Resolution);
        statusCall.Request.Context.ShouldNotBeNull();
        statusCall.Request.Context!.RequestId.ShouldBeNull();
        statusCall.Request.Context.RunId.ShouldBe("video-run-1");
        statusCall.Request.Context.LogicalRequestId.ShouldBe("video-run-1");
        statusCall.Request.Context.ProviderTaskId.ShouldBe("job-123");

        var downloadCall = gateway.RawCalls[2];
        downloadCall.Request.EndpointPath.ShouldBe("/videos/job-123/content?index=0");
        downloadCall.Request.HttpMethod.ShouldBe("GET");
        downloadCall.Request.ExpectBinaryResponse.ShouldBeTrue();
        downloadCall.Resolution.ShouldBe(gateway.Resolution);
        downloadCall.Request.Context.ShouldNotBeNull();
        downloadCall.Request.Context!.LogicalRequestId.ShouldBe("video-run-1");
        downloadCall.Request.Context.ProviderTaskId.ShouldBe("job-123");
    }

    [Fact]
    public async Task DirectDownload_ShouldExposeAuthenticatedResponseStreamWithoutGatewayBuffering()
    {
        var gateway = new CapturingGateway();
        var requestCount = 0;
        var http = new HttpClient(new CapturingHandler(request =>
        {
            requestCount++;
            request.RequestUri!.ToString().ShouldBe("https://openrouter.ai/api/v1/videos/job-123/content?index=0");
            request.Headers.Authorization!.Scheme.ShouldBe("Bearer");
            request.Headers.Authorization.Parameter.ShouldBe("sk-test");
            request.Headers.GetValues("X-OpenRouter-Title").Single()
                .ShouldBe($"G-{AppCallerRegistry.VideoAgent.VideoGen.Generate}");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(new MemoryStream([4, 3, 2, 1]))
                {
                    Headers =
                    {
                        ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json"),
                        ContentLength = 4,
                    },
                },
            });
        }));
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(http),
            new AllowingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance);

        await using var opened = await client.OpenVideoStreamForOfferingAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            "job-123",
            0,
            "openrouter/test-video",
            null);

        opened.Success.ShouldBeTrue(opened.ErrorMessage);
        opened.ContentType.ShouldBe("video/mp4");
        opened.ContentLength.ShouldBe(4);
        using var copy = new MemoryStream();
        await opened.Content!.CopyToAsync(copy);
        copy.ToArray().ShouldBe([4, 3, 2, 1]);
        requestCount.ShouldBe(1);
        gateway.RawCalls.ShouldBeEmpty();
    }

    [Fact]
    public async Task RestartedPollingClient_ShouldResolveStatusAndDownloadWithRecordedModel()
    {
        var gateway = new CapturingGateway();
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(new HttpClient(new CapturingHandler(_ => throw new NotSupportedException()))),
            new AllowingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance);

        var status = await client.GetStatusAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            "job-123",
            "recorded/video-model");
        var download = await client.DownloadVideoBytesAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            "job-123",
            expectedModel: "recorded/video-model");

        status.IsCompleted.ShouldBeTrue();
        download.Success.ShouldBeTrue(download.ErrorMessage);
        gateway.ResolveCalls.Count.ShouldBe(2);
        gateway.ResolveCalls.ShouldAllBe(call => call.ExpectedModel == "recorded/video-model");
    }

    [Fact]
    public async Task ProviderRetry_ShouldPersistAndReuseSuccessfulOffering()
    {
        var initial = new GatewayModelResolution
        {
            Success = true,
            ResolutionType = "LogicalModel",
            LogicalModelPublicId = "video2",
            OfferingId = "offering-primary",
            ActualModel = "video-primary",
        };
        var successful = new GatewayModelResolution
        {
            Success = true,
            ResolutionType = "LogicalModel",
            LogicalModelPublicId = "video2",
            OfferingId = "offering-backup",
            ActualModel = "video-backup",
        };
        var gateway = new CapturingGateway(initial, successful);
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(new HttpClient(new CapturingHandler(_ => throw new NotSupportedException()))),
            new AllowingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance);

        var submit = await client.SubmitAsync(new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate,
            Model = "video2",
            Prompt = "生成视频",
        });
        submit.ActualModel.ShouldBe("video-backup");
        submit.OfferingId.ShouldBe("offering-backup");

        await client.GetStatusForOfferingAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            submit.JobId!,
            submit.ActualModel,
            submit.OfferingId);
        gateway.RawCalls[1].Resolution.ShouldBe(successful);

        var restartedClient = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(new HttpClient(new CapturingHandler(_ => throw new NotSupportedException()))),
            new AllowingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance);
        await restartedClient.GetStatusForOfferingAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            submit.JobId!,
            submit.ActualModel,
            submit.OfferingId);
        gateway.OfferingResolveCalls.ShouldContain("offering-backup");
    }

    [Fact]
    public async Task SubmitWithoutContext_ShouldBindProviderTaskAsLogicalFallback()
    {
        var gateway = new CapturingGateway();
        var logWriter = new CapturingLogWriter();
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(new HttpClient(new CapturingHandler(_ => throw new NotSupportedException()))),
            new AllowingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance,
            contextAccessor: null,
            logWriter: logWriter);

        var submit = await client.SubmitAsync(new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate,
            Prompt = "直连视频任务",
        });
        var status = await client.GetStatusAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            submit.JobId!);

        submit.Success.ShouldBeTrue(submit.ErrorMessage);
        status.IsCompleted.ShouldBeTrue();
        logWriter.BindCalls.ShouldBe(
        [
            ("submit-log-1", "job-123", "job-123")
        ]);
        gateway.RawCalls[0].Request.Context!.LogicalRequestId.ShouldBeNull();
        gateway.RawCalls[1].Request.Context!.LogicalRequestId.ShouldBe("job-123");
    }

    [Fact]
    public async Task VolcengineVideoExchange_ShouldUseGatewayStatusAndDownloadSignedUrl()
    {
        var gateway = new CapturingGateway(new GatewayModelResolution
        {
            Success = true,
            ResolutionType = "DedicatedPool",
            ActualModel = "doubao-seedance-2-0-fast-260128",
            ActualPlatformId = "exchange-volc-video",
            ActualPlatformName = "Exchange:火山方舟 Seedance 视频生成",
            PlatformType = "exchange",
            Protocol = "exchange",
            ApiUrl = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
            ApiKey = "ark-test",
            IsExchange = true,
            ExchangeId = "exchange-volc-video",
            ExchangeName = "火山方舟 Seedance 视频生成",
            ExchangeTransformerType = "volcengine-video",
            ExchangeAuthScheme = "Bearer",
        });
        var downloadHttp = new HttpClient(new CapturingHandler(request =>
        {
            request.RequestUri!.ToString().ShouldBe("https://tos.example.test/video.mp4");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent([9, 8, 7])
                {
                    Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("video/mp4") }
                },
            });
        }));
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(downloadHttp),
            new AllowingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance);

        var submit = await client.SubmitAsync(new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate,
            Model = "doubao-seedance-2-0-fast-260128",
            Prompt = "产品演示视频",
        });

        submit.Success.ShouldBeTrue(submit.ErrorMessage);
        submit.JobId.ShouldBe("cgt-123");

        var status = await client.GetStatusAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "cgt-123");
        status.IsCompleted.ShouldBeTrue();
        status.VideoUrl.ShouldBe("https://tos.example.test/video.mp4");

        var download = await client.DownloadVideoBytesAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "cgt-123");
        download.Success.ShouldBeTrue(download.ErrorMessage);
        download.Bytes.ShouldBe([9, 8, 7]);

        gateway.RawCalls.Count.ShouldBe(3);
        gateway.RawCalls[0].Request.EndpointPath.ShouldBe("/videos");
        gateway.RawCalls[1].Request.HttpMethod.ShouldBe("GET");
        gateway.RawCalls[1].Request.RequestBody.ShouldNotBeNull();
        gateway.RawCalls[1].Request.RequestBody!["_gateway_operation"]!.GetValue<string>().ShouldBe("status");
        gateway.RawCalls[1].Request.RequestBody!["task_id"]!.GetValue<string>().ShouldBe("cgt-123");
        gateway.RawCalls[2].Request.RequestBody!["task_id"]!.GetValue<string>().ShouldBe("cgt-123");
    }

    [Fact]
    public async Task ProviderVideoRedirects_ShouldValidateEveryHopBeforeDownload()
    {
        var gateway = new CapturingGateway(VolcengineResolution());
        var requestCount = 0;
        var downloadHttp = new HttpClient(new CapturingHandler(_ =>
        {
            requestCount++;
            return Task.FromResult(requestCount == 1
                ? new HttpResponseMessage(HttpStatusCode.Redirect)
                {
                    Headers = { Location = new Uri("https://cdn.example.test/final.mp4") },
                }
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new ByteArrayContent([7, 6, 5]),
                });
        }));
        var validator = new AllowingUrlValidator();
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(downloadHttp),
            validator,
            NullLogger<OpenRouterVideoClient>.Instance);

        var download = await client.DownloadVideoBytesAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            "cgt-123");

        download.Success.ShouldBeTrue(download.ErrorMessage);
        requestCount.ShouldBe(2);
        validator.ValidatedUrls.ShouldBe([
            "https://tos.example.test/video.mp4",
            "https://cdn.example.test/final.mp4",
        ]);
    }

    [Fact]
    public async Task ProviderVideoUrlRejectedBySafetyPolicy_ShouldNotReachHttpClient()
    {
        var gateway = new CapturingGateway(VolcengineResolution());
        var requestCount = 0;
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(new HttpClient(new CapturingHandler(_ =>
            {
                requestCount++;
                throw new InvalidOperationException("不应发送请求");
            }))),
            new RejectingUrlValidator(),
            NullLogger<OpenRouterVideoClient>.Instance);

        var download = await client.DownloadVideoBytesAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            "cgt-123");

        download.Success.ShouldBeFalse();
        download.ErrorMessage.ShouldBe("视频下载地址不可用，请稍后重试或重新生成");
        requestCount.ShouldBe(0);
    }

    private static GatewayModelResolution VolcengineResolution() => new()
    {
        Success = true,
        ResolutionType = "DedicatedPool",
        ActualModel = "doubao-seedance-2-0-fast-260128",
        ActualPlatformId = "exchange-volc-video",
        ActualPlatformName = "Exchange:火山方舟 Seedance 视频生成",
        PlatformType = "exchange",
        Protocol = "exchange",
        ApiUrl = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
        ApiKey = "ark-test",
        IsExchange = true,
        ExchangeId = "exchange-volc-video",
        ExchangeName = "火山方舟 Seedance 视频生成",
        ExchangeTransformerType = "volcengine-video",
        ExchangeAuthScheme = "Bearer",
    };

    private sealed class CapturingGateway : ILlmGateway
    {
        public CapturingGateway()
            : this(new GatewayModelResolution
            {
                Success = true,
                ResolutionType = "DedicatedPool",
                ActualModel = "openrouter/test-video",
                ActualPlatformId = "openrouter",
                ActualPlatformName = "OpenRouter",
                PlatformType = "openrouter",
                ApiUrl = "https://openrouter.ai/api/v1",
                ApiKey = "sk-test",
            })
        {
        }

        public CapturingGateway(
            GatewayModelResolution resolution,
            GatewayModelResolution? submitResponseResolution = null)
        {
            Resolution = resolution;
            SubmitResponseResolution = submitResponseResolution;
        }

        public GatewayModelResolution Resolution { get; }
        public GatewayModelResolution? SubmitResponseResolution { get; }

        public List<(string AppCallerCode, string ModelType, string? ExpectedModel)> ResolveCalls { get; } = [];
        public List<string> OfferingResolveCalls { get; } = [];
        public List<(GatewayRawRequest Request, GatewayModelResolution Resolution)> RawCalls { get; } = [];

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
        {
            ResolveCalls.Add((appCallerCode, modelType, expectedModel));
            return Task.FromResult(Resolution);
        }

        public Task<GatewayModelResolution> ResolveOfferingAsync(
            string appCallerCode,
            string modelType,
            string offeringId,
            CancellationToken ct = default)
        {
            OfferingResolveCalls.Add(offeringId);
            return Task.FromResult(SubmitResponseResolution ?? Resolution);
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request,
            GatewayModelResolution resolution,
            CancellationToken ct = default)
        {
            RawCalls.Add((request, resolution));
            if (resolution.IsExchange
                && string.Equals(resolution.ExchangeTransformerType, "volcengine-video", StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult(request.RequestBody?["_gateway_operation"]?.GetValue<string>() == "status"
                    ? new GatewayRawResponse
                    {
                        Success = true,
                        StatusCode = 200,
                        ContentType = "application/json",
                        Content = """
                                  {"status":"completed","unsigned_urls":["https://tos.example.test/video.mp4"],"usage":{"cost":0.56}}
                                  """,
                    }
                    : new GatewayRawResponse
                    {
                        Success = true,
                        StatusCode = 200,
                        ContentType = "application/json",
                        Content = """
                                  {"id":"cgt-123","status":"pending"}
                                  """,
                    });
            }

            return Task.FromResult(request.EndpointPath switch
            {
                "/videos" => new GatewayRawResponse
                {
                    Success = true,
                    StatusCode = 200,
                    ContentType = "application/json",
                    Resolution = SubmitResponseResolution,
                    LogId = "submit-log-1",
                    Content = """
                              {"id":"job-123","usage":{"cost":0.12}}
                              """,
                },
                "/videos/job-123" => new GatewayRawResponse
                {
                    Success = true,
                    StatusCode = 200,
                    ContentType = "application/json",
                    Content = """
                              {"status":"completed","unsigned_urls":["https://example.test/video.mp4"],"usage":{"cost":0.34}}
                              """,
                },
                "/videos/job-123/content?index=0" => new GatewayRawResponse
                {
                    Success = true,
                    StatusCode = 200,
                    ContentType = "application/json",
                    BinaryContent = [1, 2, 3, 4],
                },
                _ => new GatewayRawResponse
                {
                    Success = false,
                    StatusCode = 404,
                    ErrorCode = "UNEXPECTED_PATH",
                    ErrorMessage = request.EndpointPath,
                }
            });
        }

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();

        public IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());

        public ILLMClient CreateClient(
            string appCallerCode,
            string modelType,
            int maxTokens = 4096,
            double temperature = 0.2,
            bool includeThinking = false,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null)
            => throw new NotSupportedException();
    }

    private sealed class CapturingLogWriter : ILlmRequestLogWriter
    {
        public List<(string LogId, string ProviderTaskId, string? FallbackLogicalRequestId)> BindCalls { get; } = [];

        public Task<string?> StartAsync(LlmLogStart start, CancellationToken ct = default)
            => Task.FromResult<string?>(null);

        public Task BindProviderTaskAsync(
            string logId,
            string providerTaskId,
            string? fallbackLogicalRequestId = null,
            CancellationToken ct = default)
        {
            BindCalls.Add((logId, providerTaskId, fallbackLogicalRequestId));
            return Task.CompletedTask;
        }

        public void MarkFirstByte(string logId, DateTime at)
        {
        }

        public void MarkDone(string logId, LlmLogDone done)
        {
        }

        public void MarkError(string logId, string error, int? statusCode = null)
        {
        }
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _handler;

        public CapturingHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => _handler(request);
    }

    private sealed class AllowingUrlValidator : ISafeOutboundUrlValidator
    {
        public List<string> ValidatedUrls { get; } = [];

        public Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default)
        {
            var value = url ?? throw new InvalidOperationException(purpose);
            ValidatedUrls.Add(value);
            return Task.FromResult(new Uri(value, UriKind.Absolute));
        }

        public bool IsSafeAddress(IPAddress address) => true;
    }

    private sealed class RejectingUrlValidator : ISafeOutboundUrlValidator
    {
        public Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default)
            => throw new InvalidOperationException("blocked");

        public bool IsSafeAddress(IPAddress address) => false;
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;

        public SingleClientFactory(HttpClient client)
        {
            _client = client;
        }

        public HttpClient CreateClient(string name) => _client;
    }
}
