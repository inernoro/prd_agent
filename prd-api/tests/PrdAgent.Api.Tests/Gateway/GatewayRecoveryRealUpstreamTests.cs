using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Tests.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 显式点名执行的两次付费上限验收。故障上游与路由快照只存在本机，
/// 真实备用经现有预览网关的临时白名单 Key 执行，不读取或修改供应商密钥。
/// 默认 CI 排除 Manual；没有授权参数时在任何网络/数据库动作前失败。
/// </summary>
public sealed class GatewayRecoveryRealUpstreamTests
{
    [Fact, Trait("Category", "Manual")]
    public async Task AuthorizedBackup_RecoversSameModelAndTools_WhileLocksAndUnknownResultsNeverReplay()
    {
        Assert.Equal("two-bounded-calls", Required("LLMGW_RECOVERY_REAL_APPROVAL"));
        var address = new Uri(Required("LLMGW_RECOVERY_REAL_BASE"));
        Assert.Equal("https", address.Scheme);
        Assert.Empty(address.UserInfo);
        var production = Environment.GetEnvironmentVariable("MAP_PROD_HOST");
        Assert.False(Uri.TryCreate(production, UriKind.Absolute, out var prod) && prod.Host == address.Host);
        var model = Required("LLMGW_RECOVERY_REAL_MODEL");
        var logicalId = Required("LLMGW_RECOVERY_REAL_LOGICAL_ID");
        var key = Required("LLMGW_RECOVERY_REAL_KEY");
        var operation = Required("LLMGW_RECOVERY_REAL_OPERATION");
        var evidence = Path.GetFullPath(Required("LLMGW_RECOVERY_REAL_EVIDENCE"));
        Assert.False(File.Exists(evidence), "已有执行证据时先核账，不覆盖后重提");

        await using var database = await RunMongoFixture.CreateAsync("gateway_recovery_real");
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var fault = builder.Build();
        var acceptedModels = new ConcurrentQueue<string>();
        fault.Run(async http =>
        {
            var body = (await JsonNode.ParseAsync(http.Request.Body))!.AsObject();
            acceptedModels.Enqueue(body["model"]!.GetValue<string>());
            if (http.Request.Path == "/stall")
                await Task.Delay(Timeout.Infinite, http.RequestAborted);
            else
            {
                http.Response.StatusCode = 429;
                await http.Response.WriteAsync("{\"error\":{\"message\":\"isolated rejection before execution\"}}");
            }
        });
        await fault.StartAsync();
        var local = fault.Urls.Single();
        var factory = new BoundedFactory(address.Host);
        var storage = Mock.Of<IAssetStorage>();
        var background = new LlmRequestLogBackground(database.Db, NullLogger<LlmRequestLogBackground>.Instance,
            storage, factory, Mock.Of<ISafeOutboundUrlValidator>());
        var settings = new Mock<IAppSettingsService>();
        settings.Setup(x => x.GetSettingsAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new AppSettings());
        var writer = new LlmRequestLogWriter(database.Db, NullLogger<LlmRequestLogWriter>.Instance, background,
            settings.Object, storage, new ConfigurationBuilder().Build());
        var gateway = new LlmGateway(Mock.Of<IModelResolver>(), factory, NullLogger<LlmGateway>.Instance, writer);
        var cases = new List<object>();
        try
        {
            var recovered = await Call("rejection", local, "/reject");
            AssertSuccessfulTools(recovered);
            Assert.Single(factory.Sent);

            var pinned = await Call("pinned", local, "/reject", pinned: true);
            Assert.False(pinned.Success);
            Assert.Equal(429, pinned.StatusCode);
            Assert.Single(factory.Sent);

            var unknown = await Call("unknown", local, "/stall", timeout: 1);
            Assert.False(unknown.Success);
            Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", unknown.ErrorCode);
            Assert.Single(factory.Sent);

            using var refused = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            refused.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            var refusedUrl = $"http://127.0.0.1:{((IPEndPoint)refused.LocalEndPoint!).Port}";
            var connected = await Call("refused", refusedUrl, "/reject");
            AssertSuccessfulTools(connected);
            Assert.Equal(2, factory.Sent.Count);
            Assert.All(acceptedModels, actual => Assert.Equal(model, actual));
            Assert.All(factory.Sent, sent => Assert.Equal(model, sent.Model));
            Assert.Equal(3, acceptedModels.Count); // 连接拒绝没有到达本机上游。

            using var logDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            List<LlmRequestLog> logs;
            do
            {
                logs = await database.Db.LlmRequestLogs.Find(_ => true).ToListAsync(logDeadline.Token);
                if (logs.Count == 4 && logs.All(log => log.EndedAt.HasValue)) break;
                await Task.Delay(20, logDeadline.Token);
            } while (true);
            Assert.All(logs, log => Assert.NotEmpty(log.ProviderAttempts!));
            Assert.Equal(2, logs.Count(log => log.Status == "succeeded"));
            Assert.Equal(2, logs.Count(log => log.Status == "failed"));
            var rejection = logs.Single(log => log.RequestId == operation + "-rejection");
            Assert.Equal(2, rejection.ProviderAttempts!.Count(a => a.Stage == "send"));
            Assert.Contains("next_candidate", rejection.ProviderAttempts.First(a => a.Stage == "send").Reason);
            var refusedLog = logs.Single(log => log.RequestId == operation + "-refused");
            Assert.False(refusedLog.ProviderAttempts!.First(a => a.Stage == "send").ReachedProvider);
        }
        finally
        {
            var logs = await database.Db.LlmRequestLogs.Find(_ => true).ToListAsync();
            Directory.CreateDirectory(Path.GetDirectoryName(evidence)!);
            await File.WriteAllTextAsync(evidence, JsonSerializer.Serialize(new
            {
                Model = model, LogicalModelId = logicalId, RealCalls = factory.Sent.Count,
                Cases = cases, Sent = factory.Sent.ToArray(),
                Logs = logs.Select(log => new { log.RequestId, log.Model, log.Status, log.StatusCode,
                    log.InputTokens, log.OutputTokens, log.EstimatedCostUsd, log.ProviderAttempts }),
            }, new JsonSerializerOptions { WriteIndented = true }));
        }

        async Task<GatewayRawResponse> Call(string name, string primaryUrl, string path, bool pinned = false, int timeout = 30)
        {
            var retry = new ModelResolutionResult
            {
                Success = true, LogicalModelId = logicalId, LogicalModelPublicId = model, ResolutionType = "LogicalModel",
                ActualModel = model, ActualPlatformId = "authorized-preview-proxy", ActualPlatformName = "Bound gateway to OpenAI",
                Protocol = "openai", PlatformType = "openai", ApiUrl = address.GetLeftPart(UriPartial.Authority),
                ApiKey = key, OfferingId = "authorized-preview-proxy", OfferingEndpointPath = "/api/v1/chat/completions",
            };
            var resolution = new ModelResolutionResult
            {
                Success = true, LogicalModelId = logicalId, LogicalModelPublicId = model, ResolutionType = "LogicalModel",
                ActualModel = model, ActualPlatformId = "isolated-fault", ActualPlatformName = "Isolated fault fixture",
                Protocol = "openai", PlatformType = "openai", ApiUrl = primaryUrl, ApiKey = "fixture-only",
                OfferingId = "isolated-fault", OfferingEndpointPath = path, RetryCandidates = [retry],
            };
            var body = JsonNode.Parse("""
                {"messages":[{"role":"user","content":"Call continuity_probe with code OK."}],
                 "max_tokens":32,"reasoning_effort":"none","tools":[{"type":"function","function":{
                    "name":"continuity_probe","parameters":{"type":"object","properties":{"code":{"type":"string","enum":["OK"]}},
                    "required":["code"],"additionalProperties":false}}}],
                 "tool_choice":{"type":"function","function":{"name":"continuity_probe"}}}
                """)!.AsObject();
            var watch = Stopwatch.StartNew();
            var response = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.OpenApi.Proxy.Chat, ModelType = ModelTypes.Chat,
                ExpectedModel = model, RequiredLogicalModelPublicId = model, RequestBody = body,
                RequiredOfferingId = pinned ? "isolated-fault" : null, TimeoutSeconds = timeout,
                Context = new GatewayRequestContext { RequestId = operation + "-" + name },
                ExtraHeaders = new Dictionary<string, string> { ["Idempotency-Key"] = operation + "-" + name },
            }, resolution.ToGatewayResolution());
            cases.Add(new { Name = name, response.Success, response.StatusCode, response.ErrorCode,
                DurationMs = watch.ElapsedMilliseconds, response.LogId,
                BusinessResponseId = response.Success ? JsonNode.Parse(response.Content!)?["id"]?.GetValue<string>() : null });
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(timeout + 2));
            return response;
        }

        void AssertSuccessfulTools(GatewayRawResponse response)
        {
            Assert.True(response.Success, response.ErrorCode);
            var result = JsonNode.Parse(response.Content!)!;
            Assert.Equal(model, result["model"]!.GetValue<string>());
            var tool = result["choices"]![0]!["message"]!["tool_calls"]![0]!["function"]!;
            Assert.Equal("continuity_probe", tool["name"]!.GetValue<string>());
            Assert.Equal("OK", JsonNode.Parse(tool["arguments"]!.GetValue<string>())!["code"]!.GetValue<string>());
            Assert.InRange(result["usage"]!["completion_tokens"]!.GetValue<int>(), 1, 32);
        }
    }

    private static string Required(string key)
        => Environment.GetEnvironmentVariable(key) is { Length: > 0 } value ? value
            : throw new InvalidOperationException($"手工付费验收缺少授权参数 {key}");

    private sealed record SentRequest(string Model, string Operation, int OutputCap);

    private sealed class BoundedFactory(string remoteHost) : IHttpClientFactory
    {
        private readonly string _remoteHost = remoteHost;
        public ConcurrentQueue<SentRequest> Sent { get; } = new();
        private int _calls;
        public HttpClient CreateClient(string name) => new(new Guard(this));
        private sealed class Guard(BoundedFactory owner) : DelegatingHandler(new SocketsHttpHandler())
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                if (request.RequestUri!.Host == owner._remoteHost)
                {
                    if (Interlocked.Increment(ref owner._calls) > 2)
                        throw new InvalidOperationException("已达到两次真实调用硬上限，禁止追加发送");
                    var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!;
                    var cap = body["max_completion_tokens"]?.GetValue<int>() ?? body["max_tokens"]!.GetValue<int>();
                    Assert.InRange(cap, 1, 32);
                    owner.Sent.Enqueue(new SentRequest(body["model"]!.GetValue<string>(),
                        request.Headers.GetValues("Idempotency-Key").Single(), cap));
                }
                return await base.SendAsync(request, ct);
            }
        }
    }
}
