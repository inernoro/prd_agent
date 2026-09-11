using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests;

public sealed class DesignArtifactWorkspaceContractTests
{
    [Theory]
    [InlineData(DesignArtifactOperations.Generate)]
    [InlineData(DesignArtifactOperations.Edit)]
    public async Task ResponsesProxyPreservesTwoRoundToolInputsAndUsesFrozenMapConfiguration(string operation)
    {
        var run = BuildRun();
        run.Operation = operation;
        run.LlmRequestPolicy = new DesignArtifactLlmRequestPolicy
        {
            Model = "frozen-codex-model", PinnedPlatformId = "map-platform", PinnedModelId = "map-model-id",
            Temperature = 0.45, TopP = 0.9, ReasoningMode = "effort", ReasoningEffort = "low",
            OutputTokenMode = "omit", RequireDeclaredParameters = true,
        };
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091", ["LlmGwServe:ApiKey"] = "gateway-test-key",
            ["DesignArtifactRuntime:Model"] = "changed-model",
        }).Build();
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(x => x.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>())).ReturnsAsync(run);
        var inputs = new[]
        {
            """[{"role":"user","content":[{"type":"input_text","text":"读取资料并写出 index.html"}]}]""",
            """[{"role":"user","content":[{"type":"input_text","text":"读取资料并写出 index.html"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"brief.md\"}"},{"type":"function_call_output","call_id":"call_1","output":"产品有三个卖点"}]""",
        };
        const string eventStream = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n";
        foreach (var input in inputs)
        {
            var original = JsonNode.Parse("""
                {"model":"runtime-choice","model_pool_id":"untrusted-pool","model_policy":"pool",
                 "pinned_platform_id":"untrusted-platform","pinned_model_id":"untrusted-model",
                 "provider":{"order":["untrusted-provider"],"model_policy":"pinned"},
                 "store":false,"stream":true,"temperature":1.5,"top_p":0.1,"max_output_tokens":4096,
                 "reasoning":{"effort":"high","summary":"auto"},"include":["reasoning.encrypted_content"],
                 "tools":[{"type":"function","name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}],
                 "tool_choice":"auto","parallel_tool_calls":true}
                """)!.AsObject();
            original["input"] = JsonNode.Parse(input);
            var handler = new CapturingHandler(responseBody: eventStream, responseMediaType: "text/event-stream");
            var controller = BuildResponsesProxy(broker.Object, handler, configuration, original.ToJsonString());
            controller.Request.Headers["X-Gateway-User-Id"] = "untrusted-user";
            controller.Request.Headers["X-Gateway-Run-Id"] = "untrusted-run";

            await controller.ProxyResponses(run.Id, CancellationToken.None);

            Assert.Equal(200, controller.Response.StatusCode);
            Assert.Equal("/gw/v1/responses", handler.RequestUri!.AbsolutePath);
            Assert.StartsWith("text/event-stream", controller.Response.ContentType);
            Assert.Equal("no", controller.Response.Headers["X-Accel-Buffering"].ToString());
            Assert.Equal(eventStream, Encoding.UTF8.GetString(((MemoryStream)controller.Response.Body).ToArray()));
            var sent = handler.Body!;
            Assert.Equal("frozen-codex-model", sent["model"]!.GetValue<string>());
            Assert.Equal("map-platform", sent["pinned_platform_id"]!.GetValue<string>());
            Assert.Equal("map-model-id", sent["pinned_model_id"]!.GetValue<string>());
            Assert.False(sent.ContainsKey("model_pool_id"));
            Assert.False(sent["provider"]!.AsObject().ContainsKey("order"));
            Assert.True(sent["provider"]!["require_parameters"]!.GetValue<bool>());
            Assert.Equal(0.45, sent["temperature"]!.GetValue<double>());
            Assert.Equal(0.9, sent["top_p"]!.GetValue<double>());
            Assert.Equal("low", sent["reasoning"]!["effort"]!.GetValue<string>());
            Assert.Equal("auto", sent["reasoning"]!["summary"]!.GetValue<string>());
            foreach (var field in new[] { "input", "tools", "tool_choice", "parallel_tool_calls", "include", "store", "stream" })
                Assert.True(JsonNode.DeepEquals(original[field], sent[field]), field);
            foreach (var field in new[] { "messages", "n", "max_tokens", "max_completion_tokens", "max_output_tokens", "reasoning_effort" })
                Assert.False(sent.ContainsKey(field), field);
            Assert.Equal(run.Id, handler.Header("X-Gateway-Run-Id"));
            Assert.Equal(run.UserId, handler.Header("X-Gateway-User-Id"));
            Assert.Equal("map", handler.Header("X-Gateway-Source"));
            Assert.Equal("gateway-test-key", handler.Header("X-Gateway-Key"));
            Assert.Equal(operation == DesignArtifactOperations.Edit
                ? AppCallerRegistry.Admin.WebHosting.EditHtml
                : AppCallerRegistry.Admin.WebHosting.GenerateHtml, handler.Header("X-Gateway-App-Caller"));
        }
        broker.Verify(x => x.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>()), Times.Exactly(2));
        broker.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"messages\":[]}")]
    [InlineData("{\"input\":42}")]
    [InlineData("invalid-json")]
    public async Task ResponsesProxyRejectsMalformedContextBeforeCallingGateway(string body)
    {
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        var handler = new CapturingHandler();
        var controller = BuildResponsesProxy(broker.Object, handler, new ConfigurationBuilder().Build(), body);
        await controller.ProxyResponses("run-invalid-context", CancellationToken.None);
        Assert.Equal(409, controller.Response.StatusCode);
        Assert.Null(handler.Body);
        broker.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ResponsesProxyRejectsInvalidTicketBeforeCallingGateway()
    {
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(x => x.ReserveModelCallAsync("another-run", "model-ticket", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new UnauthorizedAccessException());
        var handler = new CapturingHandler();
        var controller = BuildResponsesProxy(broker.Object, handler, new ConfigurationBuilder().Build(), """{"input":[],"store":false}""");
        await controller.ProxyResponses("another-run", CancellationToken.None);
        Assert.Equal(401, controller.Response.StatusCode);
        Assert.Null(handler.Body);
        broker.VerifyAll();
    }

    [Fact]
    public void ResponsesProxyHasAnActualHttpRoute()
    {
        var method = typeof(DesignArtifactRuntimeController).GetMethod(nameof(DesignArtifactRuntimeController.ProxyResponses))!;
        var route = Assert.Single(method.GetCustomAttributes(typeof(HttpPostAttribute), inherit: true).Cast<HttpPostAttribute>());
        Assert.Equal("llm/v1/responses", route.Template);
    }

    [Fact]
    public void ResponsesWithoutMapModelFailInsteadOfUsingRuntimeOrDefaultSelection()
    {
        var body = JsonNode.Parse("""{"model":"runtime-default","input":[],"store":false}""")!.AsObject();
        Assert.Throws<InvalidOperationException>(() => new DesignArtifactModelSelection(null, null).ApplyToResponsesRequest(body));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ResponsesSamplingKeepsNativeShapeWithoutInjectingChatParameters(bool omitReasoning)
    {
        var body = JsonNode.Parse("""{"model":"runtime","input":"写网页","store":false,"max_output_tokens":10000,"reasoning":{"effort":"high"},"provider":{"pinnedModelId":"remote"},"pinned_model_id":"remote"}""")!.AsObject();
        var selection = new DesignArtifactModelSelection(null, "map-selected")
        {
            Policy = omitReasoning ? new DesignArtifactLlmRequestPolicy { ReasoningMode = "omit" } : null,
        };
        selection.ApplyToResponsesRequest(body);
        Assert.Equal("map-selected", body["model"]!.GetValue<string>());
        Assert.Equal(10000, body["max_output_tokens"]!.GetValue<int>());
        Assert.Equal(!omitReasoning, body.ContainsKey("reasoning"));
        foreach (var field in new[] { "n", "max_tokens", "reasoning_effort", "provider", "pinned_model_id" }) Assert.False(body.ContainsKey(field));
    }

    private static DesignArtifactRuntimeController BuildResponsesProxy(
        IDesignArtifactWorkspaceBroker broker, HttpMessageHandler handler, IConfiguration configuration, string requestBody)
    {
        var controller = new DesignArtifactRuntimeController(broker, new SingleClientFactory(handler), configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var bytes = Encoding.UTF8.GetBytes(requestBody);
        controller.Request.Body = new MemoryStream(bytes);
        controller.Request.ContentLength = bytes.Length;
        controller.Request.Headers.Authorization = "Bearer model-ticket";
        controller.Response.Body = new MemoryStream();
        return controller;
    }

    [Theory]
    [InlineData("Temperature", "NaN")]
    [InlineData("Temperature", "Infinity")]
    [InlineData("Temperature", "2.1")]
    [InlineData("TopP", "-0.1")]
    [InlineData("TopP", "1.1")]
    [InlineData("top_p", "0.5")]
    [InlineData("ReasoningMode", "unsupported")]
    [InlineData("OutputTokenMode", "limit")]
    [InlineData("OutputTokenMode", "16384")]
    [InlineData("ReasoningEffort", "high")]
    [InlineData("PinnedPlatformId", "half-pin")]
    [InlineData("RequireDeclaredParameters", "true")]
    public void FrozenSampling_InvalidConfigurationFailsBeforeRunCreation(string key, string value)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { [$"DesignArtifactRuntime:RequestPolicy:{key}"] = value }).Build();
        Assert.Throws<InvalidOperationException>(() => DesignArtifactModelSelection.CaptureForNewRun(config));
    }

    [Fact]
    public void FrozenSampling_CaptureIsIndependentAndLegacyIsNeverBackfilled()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignArtifactRuntime:Model"] = "model-a",
            ["DesignArtifactRuntime:RequestPolicy:Temperature"] = "0.4",
            ["DesignArtifactRuntime:RequestPolicy:TopP"] = "0.9",
            ["DesignArtifactRuntime:RequestPolicy:ReasoningMode"] = "effort",
            ["DesignArtifactRuntime:RequestPolicy:ReasoningEffort"] = "low",
        }).Build();
        var run = BuildRun();
        run.LlmRequestPolicy = DesignArtifactModelSelection.CaptureForNewRun(config);
        var persisted = BsonSerializer.Deserialize<DesignArtifactRun>(run.ToBson());
        config["DesignArtifactRuntime:Model"] = "model-b";
        config["DesignArtifactRuntime:RequestPolicy:Temperature"] = "1.4";
        var selected = DesignArtifactModelSelection.ForRun(persisted, config);
        Assert.Equal("model-a", selected.ForMapClient());
        var body = JsonNode.Parse("""{"temperature":1.7,"topP":0.1,"reasoning":{"effort":"high"},"thinking":true,"reasoning_effort":"high"}""")!.AsObject();
        selected.ApplyRequestParameters(body);
        Assert.Equal(0.4, body["temperature"]!.GetValue<double>());
        Assert.Equal(0.9, body["top_p"]!.GetValue<double>());
        Assert.Equal("low", body["reasoning_effort"]!.GetValue<string>());
        Assert.False(body.ContainsKey("topP")); Assert.False(body.ContainsKey("reasoning")); Assert.False(body.ContainsKey("thinking"));
        Assert.Equal("model-b", DesignArtifactModelSelection.CaptureForNewRun(config).Model);
        var legacy = BuildRun(); var before = legacy.ToBson();
        Assert.Equal("model-b", DesignArtifactModelSelection.ForRun(legacy, config).ForMapClient());
        Assert.Null(legacy.LlmRequestPolicy); Assert.Equal(before, legacy.ToBson());
        var unspecified = BuildRun(); unspecified.LlmRequestPolicy = new DesignArtifactLlmRequestPolicy();
        Assert.Null(DesignArtifactModelSelection.ForRun(unspecified, config).ForMapClient());
        var native = JsonNode.Parse("""{"temperature":0.45,"top_p":0.8,"reasoning":{"effort":"high"}}""")!.AsObject();
        var old = native.ToJsonString(); DesignArtifactModelSelection.ForRun(unspecified, config).ApplyRequestParameters(native);
        Assert.Equal(old, native.ToJsonString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void FrozenOutputOmit_IsExplicitAndSurvivesConfigurationChanges(bool strict)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignArtifactRuntime:RequestPolicy:OutputTokenMode"] = "omit",
            ["DesignArtifactRuntime:RequestPolicy:Temperature"] = "0.45",
            ["DesignArtifactRuntime:RequestPolicy:TopP"] = "1",
            ["DesignArtifactRuntime:RequestPolicy:ReasoningMode"] = "omit",
            ["DesignArtifactRuntime:RequestPolicy:RequireDeclaredParameters"] = strict.ToString(),
        }).Build();
        var run = BuildRun();
        run.LlmRequestPolicy = DesignArtifactModelSelection.CaptureForNewRun(config);
        run = BsonSerializer.Deserialize<DesignArtifactRun>(run.ToBson());
        config["DesignArtifactRuntime:RequestPolicy:OutputTokenMode"] = null;
        var body = JsonNode.Parse("""{"max_tokens":16384,"max_completion_tokens":32768,"max_output_tokens":8192,"n":1}""")!.AsObject();
        DesignArtifactModelSelection.ForRun(run, config).ApplyRequestParameters(body);
        foreach (var key in new[] { "max_tokens", "max_completion_tokens", "max_output_tokens" }) Assert.False(body.ContainsKey(key));
        Assert.Equal(1, body["n"]!.GetValue<int>());
        var legacy = BuildRun();
        var legacyBefore = legacy.ToBson();
        config["DesignArtifactRuntime:RequestPolicy:OutputTokenMode"] = "omit";
        var original = JsonNode.Parse("""{"max_tokens":16384,"max_completion_tokens":32768,"max_output_tokens":8192}""")!.AsObject();
        var preserved = original.ToJsonString();
        DesignArtifactModelSelection.ForRun(legacy, config).ApplyRequestParameters(original);
        Assert.Equal(preserved, original.ToJsonString());
        Assert.Equal(legacyBefore, legacy.ToBson());
        run.LlmRequestPolicy = new DesignArtifactLlmRequestPolicy
        { Temperature = 0.45, TopP = 1, ReasoningMode = "omit", RequireDeclaredParameters = true };
        DesignArtifactModelSelection.ForRun(run, config).ApplyRequestParameters(original);
        foreach (var key in new[] { "max_tokens", "max_completion_tokens", "max_output_tokens" }) Assert.True(original.ContainsKey(key));
    }

    [Theory]
    [InlineData(DesignArtifactOperations.Generate)]
    [InlineData(DesignArtifactOperations.Edit)]
    public async Task FrozenSampling_RunSnapshotOverridesChangedConfigurationOnBothTransports(string operation)
    {
        var run = BuildRun();
        run.Operation = operation;
        var document = run.ToBsonDocument();
        document["LlmRequestPolicy"] = new BsonDocument
        {
            ["Version"] = 1, ["Model"] = "frozen-model", ["Temperature"] = 0.61, ["TopP"] = 0.87,
            ["ReasoningMode"] = "omit", ["RequireDeclaredParameters"] = true,
            ["PinnedPlatformId"] = "frozen-platform", ["PinnedModelId"] = "frozen-model-id",
        };
        run = BsonSerializer.Deserialize<DesignArtifactRun>(document);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignArtifactRuntime:Model"] = "changed-model",
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091", ["LlmGwServe:ApiKey"] = "test",
        }).Build();
        GatewayRequest? sent = null;
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(x => x.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Callback<GatewayRequest, CancellationToken>((value, _) => sent = value).Returns(DesignResponse());
        var context = new Mock<ILLMRequestContextAccessor>();
        context.Setup(x => x.BeginScope(It.IsAny<LlmRequestContext>())).Returns(Mock.Of<IDisposable>());
        await foreach (var _ in new MapGatewayDesignArtifactExecutor(gateway.Object, context.Object, configuration)
                           .ExecuteAsync(run, null, CancellationToken.None)) { }
        Assert.Equal("frozen-model", sent!.ExpectedModel);
        Assert.Equal("frozen-platform", sent.PinnedPlatformId);
        Assert.Equal("frozen-model-id", sent.PinnedModelId);
        Assert.Equal(0.61, sent.RequestBody!["temperature"]!.GetValue<double>());
        Assert.Equal(0.87, sent.RequestBody["top_p"]!.GetValue<double>());
        Assert.Equal("strict-require", sent.Context!.ParameterPolicy);
        Assert.False(sent.IncludeThinking);
        var broker = new Mock<IDesignArtifactWorkspaceBroker>();
        broker.Setup(x => x.ReserveModelCallAsync(run.Id, "ticket", It.IsAny<CancellationToken>())).ReturnsAsync(run);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            configuration["DesignArtifactRuntime:Model"] = "changed-again";
            var handler = new CapturingHandler();
            var proxy = new DesignArtifactRuntimeController(broker.Object, new SingleClientFactory(handler), configuration,
                NullLogger<DesignArtifactRuntimeController>.Instance)
                { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            var bytes = Encoding.UTF8.GetBytes("""{"model":"runtime","temperature":1.2,"top_p":0.2,"reasoning":{"effort":"high"},"reasoning_effort":"high","messages":[],"max_tokens":32768}""");
            proxy.Request.Body = new MemoryStream(bytes); proxy.Request.ContentLength = bytes.Length;
            proxy.Request.Headers.Authorization = "Bearer ticket"; proxy.Response.Body = new MemoryStream();
            await proxy.ProxyChatCompletions(run.Id, CancellationToken.None);
            Assert.Equal(200, proxy.Response.StatusCode);
            Assert.Equal("frozen-model", handler.Body!["model"]!.GetValue<string>());
            Assert.Equal(sent.PinnedPlatformId, handler.Body["pinned_platform_id"]!.GetValue<string>());
            Assert.Equal(sent.PinnedModelId, handler.Body["pinned_model_id"]!.GetValue<string>());
            Assert.Equal(sent.RequestBody["temperature"]!.ToJsonString(), handler.Body["temperature"]!.ToJsonString());
            Assert.Equal(sent.RequestBody["top_p"]!.ToJsonString(), handler.Body["top_p"]!.ToJsonString());
            Assert.False(handler.Body.ContainsKey("reasoning")); Assert.False(handler.Body.ContainsKey("reasoning_effort"));
            Assert.True(handler.Body["provider"]!["require_parameters"]!.GetValue<bool>());
            Assert.Equal("false", handler.Header("X-Gateway-Include-Thinking"));
            Assert.Equal(32768, handler.Body["max_tokens"]!.GetValue<int>());
        }
    }

    [Theory]
    [InlineData(DesignArtifactOperations.Generate, " gpt-4.1 ", "gpt-4.1")]
    [InlineData(DesignArtifactOperations.Edit, " gpt-4.1 ", "gpt-4.1")]
    [InlineData(DesignArtifactOperations.Generate, null, null)]
    [InlineData(DesignArtifactOperations.Edit, null, null)]
    [InlineData(DesignArtifactOperations.Generate, "  ", null)]
    public async Task MapAndOpenDesignUseTheSameConfiguredModelOrAuto(
        string operation, string? configuredModel, string? expectedModel)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignArtifactRuntime:Model"] = configuredModel,
            ["DesignArtifactRuntime:ModelPoolId"] = " ",
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091",
            ["LlmGwServe:ApiKey"] = "gateway-secret",
            ["DesignArtifactRuntime:MaxCompletionTokens"] = "1",
        }).Build();
        var run = BuildRun();
        run.Operation = operation;
        run.Status = RunStatuses.Running;
        var caller = operation == DesignArtifactOperations.Edit
            ? AppCallerRegistry.Admin.WebHosting.EditHtml
            : AppCallerRegistry.Admin.WebHosting.GenerateHtml;
        var temperature = operation == DesignArtifactOperations.Edit ? 0.25 : 0.45;
        GatewayRequest? sent = null;
        LlmRequestContext? auditScope = null;
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Callback<GatewayRequest, CancellationToken>((request, _) => sent = request)
            .Returns(DesignResponse());
        var context = new Mock<ILLMRequestContextAccessor>(MockBehavior.Strict);
        context.Setup(item => item.BeginScope(It.Is<LlmRequestContext>(value => value.RunId == run.Id)))
            .Callback<LlmRequestContext>(value => auditScope = value)
            .Returns(Mock.Of<IDisposable>());
        var executor = new MapGatewayDesignArtifactExecutor(gateway.Object, context.Object, configuration);
        var chunks = new List<DesignArtifactExecutorChunk>();
        await foreach (var chunk in executor.ExecuteAsync(run, null, CancellationToken.None)) chunks.Add(chunk);
        Assert.Collection(chunks,
            chunk => { Assert.Equal("thinking", chunk.Type); Assert.Equal("synthetic thinking", chunk.Content); },
            chunk => { Assert.Equal("delta", chunk.Type); Assert.Equal("<html>synthetic</html>", chunk.Content); });
        Assert.NotNull(sent);
        Assert.Equal(caller, sent.AppCallerCode);
        Assert.Equal(ModelTypes.Chat, sent.ModelType);
        Assert.Equal(expectedModel, sent.ExpectedModel);
        Assert.True(sent.Stream);
        Assert.True(sent.IncludeThinking);
        Assert.True(sent.EnablePromptCache);
        Assert.Equal(120, sent.TimeoutSeconds);
        Assert.Equal(temperature, sent.RequestBody!["temperature"]!.GetValue<double>());
        Assert.False(sent.RequestBody.ContainsKey("max_tokens"));
        Assert.False(sent.RequestBody.ContainsKey("max_completion_tokens"));
        var wireBody = JsonNode.Parse(JsonSerializer.Serialize(sent))!["RequestBody"]!.AsObject();
        Assert.False(wireBody.ContainsKey("max_tokens"));
        Assert.False(wireBody.ContainsKey("max_completion_tokens"));
        Assert.Equal(run.Id, sent.Context!.RunId);
        Assert.Equal(run.Id, sent.Context.SessionId);
        Assert.Equal(run.UserId, sent.Context.UserId);
        Assert.Equal("map", sent.Context.SourceSystem);
        Assert.NotNull(auditScope);
        Assert.Equal(auditScope.RequestId, sent.Context.RequestId);
        Assert.Equal(auditScope.DocumentChars, sent.Context.DocumentChars);
        Assert.Equal(caller, auditScope.AppCallerCode);
        Assert.Equal(DesignArtifactPromptBuilder.BuildSystemPrompt(operation), sent.RequestBody["messages"]![0]!["content"]!.GetValue<string>());
        Assert.Equal(DesignArtifactPromptBuilder.BuildUserPrompt(run, null), sent.RequestBody["messages"]![1]!["content"]!.GetValue<string>());
        Assert.Equal(sent.Context.SystemPromptText, sent.RequestBody["messages"]![0]!["content"]!.GetValue<string>());
        Assert.Equal(sent.Context.QuestionText, sent.RequestBody["messages"]![1]!["content"]!.GetValue<string>());
        // VerifyNoOtherCalls also rejects a fallback to CreateClient's implicit 4096 default.
        gateway.Verify(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()), Times.Once);
        gateway.VerifyNoOtherCalls();

        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(item => item.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>()))
            .ReturnsAsync(run);
        var handler = new CapturingHandler();
        var proxy = new DesignArtifactRuntimeController(
            broker.Object, new SingleClientFactory(handler), configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var request = Encoding.UTF8.GetBytes("{\"model\":\"untrusted-model\",\"model_pool_id\":\"untrusted-pool\",\"modelPoolId\":\"untrusted-pool\",\"model_policy\":\"pool\",\"modelPolicy\":\"pool\",\"messages\":[]}");
        proxy.Request.Body = new MemoryStream(request);
        proxy.Request.ContentLength = request.Length;
        proxy.Request.Headers.Authorization = "Bearer model-ticket";
        proxy.Request.Headers["X-Gateway-Include-Thinking"] = "false";
        proxy.Response.Body = new MemoryStream();
        await proxy.ProxyChatCompletions(run.Id, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, proxy.Response.StatusCode);
        Assert.NotNull(handler.Body);
        Assert.Equal(expectedModel, handler.Body!["model"]?.GetValue<string>());
        Assert.Equal(expectedModel != null, handler.Body.ContainsKey("model"));
        Assert.False(handler.Body.ContainsKey("max_tokens"));
        Assert.False(handler.Body.ContainsKey("max_completion_tokens"));
        foreach (var key in new[] { "model_pool_id", "modelPoolId", "model_policy", "modelPolicy" })
            Assert.False(handler.Body.ContainsKey(key));
        Assert.Equal(caller, handler.Header("X-Gateway-App-Caller"));
        Assert.Equal(run.Id, handler.Header("X-Gateway-Run-Id"));
        Assert.Equal(string.Empty, handler.Header("X-Gateway-Include-Thinking")); // legacy ignores remote control header
        broker.VerifyAll();
    }

    [Fact]
    public async Task MapConfiguredPoolFailsBeforeCreatingAnyModelClient()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignArtifactRuntime:ModelPoolId"] = "pool-chat-premium",
            ["DesignArtifactRuntime:Model"] = "gpt-4.1",
        }).Build();
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var context = new Mock<ILLMRequestContextAccessor>(MockBehavior.Strict);
        var executor = new MapGatewayDesignArtifactExecutor(gateway.Object, context.Object, configuration);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await foreach (var _ in executor.ExecuteAsync(BuildRun(), null, CancellationToken.None)) { }
        });

        Assert.Contains("当前执行器暂不支持已配置的模型选择方式", error.Message, StringComparison.Ordinal);
        gateway.Verify(item => item.CreateClient(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<int>(), It.IsAny<double>(), It.IsAny<bool>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()), Times.Never);
        gateway.Verify(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        gateway.VerifyNoOtherCalls();
        context.VerifyNoOtherCalls();
    }

    private static async IAsyncEnumerable<GatewayStreamChunk> DesignResponse()
    {
        await Task.CompletedTask;
        yield return GatewayStreamChunk.Thinking("synthetic thinking");
        yield return GatewayStreamChunk.Text("<html>synthetic</html>");
        yield return GatewayStreamChunk.Done("stop", null);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MapStreamRetainsSanitizedErrorAndCancellationBoundaries(bool cancelled)
    {
        using var cancellation = new CancellationTokenSource();
        if (cancelled) cancellation.Cancel();
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(item => item.StreamAsync(It.IsAny<GatewayRequest>(), cancellation.Token))
            .Returns(FailingDesignResponse(cancellation.Token));
        var context = new Mock<ILLMRequestContextAccessor>(MockBehavior.Strict);
        context.Setup(item => item.BeginScope(It.IsAny<LlmRequestContext>())).Returns(Mock.Of<IDisposable>());
        var executor = new MapGatewayDesignArtifactExecutor(gateway.Object, context.Object, new ConfigurationBuilder().Build());
        async Task Execute()
        {
            await foreach (var _ in executor.ExecuteAsync(BuildRun(), null, cancellation.Token))
                Assert.Fail("失败或取消后不能继续输出内容");
        }

        if (cancelled)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(Execute);
        else
        {
            var error = await Assert.ThrowsAsync<InvalidOperationException>(Execute);
            Assert.Equal("模型暂时无法完成页面设计，请稍后重试", error.Message);
            Assert.DoesNotContain("provider-secret", error.Message, StringComparison.Ordinal);
        }
        gateway.Verify(item => item.StreamAsync(It.IsAny<GatewayRequest>(), cancellation.Token), Times.Once);
        gateway.VerifyNoOtherCalls();
    }

    private static async IAsyncEnumerable<GatewayStreamChunk> FailingDesignResponse(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        await Task.CompletedTask;
        yield return GatewayStreamChunk.Fail("provider-secret", "UPSTREAM_FAILED");
        yield return GatewayStreamChunk.Text("must not render");
    }

    [Theory]
    [InlineData(36)]
    [InlineData(72)]
    [InlineData(96)]
    public void LegacyModelCallLimitIsIgnoredWhileAuditCountSurvives(int legacyLimit)
    {
        var legacy = new DesignArtifactRun { RuntimeModelCallCount = 120 }.ToBsonDocument();
        legacy["RuntimeModelCallLimit"] = legacyLimit;

        var restored = BsonSerializer.Deserialize<DesignArtifactRun>(legacy);

        Assert.Equal(120, restored.RuntimeModelCallCount);
        Assert.False(restored.ToBsonDocument().Contains("RuntimeModelCallLimit"));
        Assert.DoesNotContain("runtimeModelCallLimit",
            JsonSerializer.Serialize(restored, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
            StringComparison.Ordinal);
    }

    [Fact]
    public void ModelCallAdmissionRetainsRunLeaseAndTicketFencesWithoutACountGate()
    {
        var now = DateTime.UtcNow;
        var filter = DesignArtifactWorkspaceBroker.BuildActiveWorkspaceFilter("run-active", "worker-owner", now);
        var rendered = filter.Render(new RenderArgs<DesignArtifactRun>(
            BsonSerializer.LookupSerializer<DesignArtifactRun>(), BsonSerializer.SerializerRegistry));

        Assert.Equal("run-active", rendered["_id"].AsString);
        Assert.Equal(RunStatuses.Running, rendered["Status"].AsString);
        Assert.Equal("worker-owner", rendered["LeaseOwnerId"].AsString);
        Assert.Equal(new BsonDateTime(now), rendered["LeaseExpiresAt"]["$gt"]);
        Assert.Equal(new BsonDateTime(now), rendered["RuntimeTicketExpiresAt"]["$gt"]);
        Assert.Equal(5, rendered.ElementCount);
        Assert.False(rendered.Contains("RuntimeModelCallCount"));
        Assert.False(rendered.Contains("RuntimeModelCallLimit"));
    }

    [Theory]
    [InlineData("{\"messages\":[]}")]
    [InlineData("{\"messages\":[],\"max_tokens\":16384,\"n\":8,\"best_of\":8}")]
    [InlineData("{\"messages\":[],\"max_completion_tokens\":32768}")]
    [InlineData("{\"messages\":[],\"max_tokens\":16384,\"max_completion_tokens\":32768}")]
    [InlineData("{\"messages\":[],\"max_tokens\":\"unbounded\",\"max_completion_tokens\":{}}")]
    public void MapPreservesRuntimeTokenParametersAndOnlyEnforcesSingleOutput(string json)
    {
        var body = JsonNode.Parse(json)!.AsObject();
        var original = body.DeepClone().AsObject();

        DesignArtifactRuntimeController.ApplySingleOutputContract(body);

        foreach (var key in new[] { "max_tokens", "max_completion_tokens" })
        {
            Assert.Equal(original.ContainsKey(key), body.ContainsKey(key));
            Assert.True(JsonNode.DeepEquals(original[key], body[key]));
        }
        Assert.Equal(1, body["n"]?.GetValue<int>());
        Assert.Null(body["best_of"]);
    }

    [Fact]
    public void MapPromptsMatchTheDeclarativeOnlyArtifactGate()
    {
        var generate = DesignArtifactPromptBuilder.BuildSystemPrompt(DesignArtifactOperations.Generate);
        var edit = DesignArtifactPromptBuilder.BuildSystemPrompt(DesignArtifactOperations.Edit);

        Assert.Contains("不得输出任何 <script>", generate, StringComparison.Ordinal);
        Assert.Contains("不得输出任何 <script>", edit, StringComparison.Ordinal);
        Assert.Contains("事实、数字、日期、金额、联系方式和链接只能来自", generate, StringComparison.Ordinal);
        Assert.Contains("不得保留无行为的启用按钮", edit, StringComparison.Ordinal);
        Assert.DoesNotContain("只使用内联 CSS 与原生 JavaScript", generate, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{\"model\":\"map-managed\",\"messages\":[]}")]
    [InlineData("{\"model\":\"map-managed\",\"max_tokens\":16384,\"messages\":[]}")]
    [InlineData("{\"model\":\"map-managed\",\"max_completion_tokens\":32768,\"messages\":[]}")]
    [InlineData("{\"model\":\"map-managed\",\"max_tokens\":\"invalid\",\"max_completion_tokens\":{},\"messages\":[]}")]
    public async Task ModelProxyUsesMapSourceAndKeepsOpenDesignRunAttribution(string requestJson)
    {
        var run = BuildRun();
        run.Id = "run-model-proxy-1";
        run.Status = RunStatuses.Running;
        run.Operation = DesignArtifactOperations.Generate;
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(item => item.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>()))
            .ReturnsAsync(run);
        var handler = new CapturingHandler();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091",
            ["LlmGwServe:ApiKey"] = "gateway-secret",
            ["DesignArtifactRuntime:Model"] = "gpt-4.1-mini",
            ["DesignArtifactRuntime:MaxCompletionTokens"] = "1",
        }).Build();
        var controller = new DesignArtifactRuntimeController(
            broker.Object,
            new SingleClientFactory(handler),
            configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var requestBytes = Encoding.UTF8.GetBytes(requestJson);
        controller.Request.Body = new MemoryStream(requestBytes);
        controller.Request.ContentLength = requestBytes.Length;
        controller.Request.Headers.Authorization = "Bearer model-ticket";
        controller.Response.Body = new MemoryStream();

        await controller.ProxyChatCompletions(run.Id, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, controller.Response.StatusCode);
        Assert.Equal("map", handler.Header("X-Gateway-Source"));
        Assert.Equal(AppCallerRegistry.Admin.WebHosting.GenerateHtml, handler.Header("X-Gateway-App-Caller"));
        Assert.Equal(run.UserId, handler.Header("X-Gateway-User-Id"));
        Assert.Equal(run.Id, handler.Header("X-Gateway-Run-Id"));
        Assert.Equal("gateway-secret", handler.Header("X-Gateway-Key"));
        Assert.True(handler.RequestTokenCanBeCanceled);
        Assert.Equal("gpt-4.1-mini", handler.Body?["model"]?.GetValue<string>());
        var original = JsonNode.Parse(requestJson)!.AsObject();
        foreach (var key in new[] { "max_tokens", "max_completion_tokens" })
        {
            Assert.Equal(original.ContainsKey(key), handler.Body!.ContainsKey(key));
            Assert.True(JsonNode.DeepEquals(original[key], handler.Body[key]));
        }
        broker.VerifyAll();
    }

    [Fact]
    public async Task ModelProxyDoesNotExposeUpstreamProviderFailureBody()
    {
        var run = BuildRun();
        run.Id = "run-model-proxy-secret";
        run.Status = RunStatuses.Running;
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(item => item.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>()))
            .ReturnsAsync(run);
        var handler = new CapturingHandler(
            System.Net.HttpStatusCode.BadGateway,
            "{\"error\":{\"message\":\"provider-secret-name internal-model-route\"}}");
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091",
            ["LlmGwServe:ApiKey"] = "gateway-secret",
            ["DesignArtifactRuntime:Model"] = "gpt-4.1-mini",
        }).Build();
        var controller = new DesignArtifactRuntimeController(
            broker.Object,
            new SingleClientFactory(handler),
            configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var requestBytes = Encoding.UTF8.GetBytes("{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}");
        controller.Request.Body = new MemoryStream(requestBytes);
        controller.Request.ContentLength = requestBytes.Length;
        controller.Request.Headers.Authorization = "Bearer model-ticket";
        controller.Response.Body = new MemoryStream();

        await controller.ProxyChatCompletions(run.Id, CancellationToken.None);

        Assert.Equal(StatusCodes.Status502BadGateway, controller.Response.StatusCode);
        controller.Response.Body.Position = 0;
        var publicBody = await new StreamReader(controller.Response.Body).ReadToEndAsync();
        Assert.Contains("DESIGN_RUNTIME_MODEL_REJECTED", publicBody, StringComparison.Ordinal);
        Assert.DoesNotContain("provider-secret-name", publicBody, StringComparison.Ordinal);
        Assert.DoesNotContain("internal-model-route", publicBody, StringComparison.Ordinal);
        broker.VerifyAll();
    }

    [Fact]
    public async Task ModelProxyStreamStopsWhenNoBytesArriveBeforeIdleDeadline()
    {
        await using var source = new NeverCompletingReadStream();
        await using var destination = new MemoryStream();
        using var totalDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            DesignArtifactRuntimeController.CopyWithIdleTimeoutAsync(
                source,
                destination,
                TimeSpan.FromMilliseconds(40),
                totalDeadline.Token));
    }

    [Fact]
    public async Task ModelProxyStreamStopsAtRunDeadlineEvenWhenIdleLimitIsLonger()
    {
        await using var source = new NeverCompletingReadStream();
        await using var destination = new MemoryStream();
        using var totalDeadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(40));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            DesignArtifactRuntimeController.CopyWithIdleTimeoutAsync(
                source,
                destination,
                TimeSpan.FromSeconds(10),
                totalDeadline.Token));
    }

    [Fact]
    public async Task ModelProxyContinuesDrainingUpstreamAfterBrowserDisconnects()
    {
        await using var source = new MemoryStream(Encoding.UTF8.GetBytes("first-second"));
        await using var disconnectedBrowser = new DisconnectingWriteStream();
        using var totalDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        await DesignArtifactRuntimeController.CopyWithIdleTimeoutAsync(
            source,
            disconnectedBrowser,
            TimeSpan.FromSeconds(1),
            totalDeadline.Token);

        Assert.Equal(source.Length, source.Position);
        Assert.Equal(1, disconnectedBrowser.WriteAttempts);
    }

    [Fact]
    public void ModelProxyTotalDeadlineUsesRunTicketAndHardUpperBound()
    {
        var now = new DateTime(2026, 9, 6, 0, 0, 0, DateTimeKind.Utc);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignArtifactRuntime:ProxyTimeoutSeconds"] = "3600",
        }).Build();

        var hardBound = DesignArtifactRuntimeController.ResolveProxyTotalTimeout(configuration, null, now);
        var runBound = DesignArtifactRuntimeController.ResolveProxyTotalTimeout(
            configuration,
            now.AddSeconds(20),
            now);

        Assert.Equal(TimeSpan.FromMinutes(15), hardBound);
        Assert.Equal(TimeSpan.FromSeconds(20), runBound);
        Assert.Throws<UnauthorizedAccessException>(() =>
            DesignArtifactRuntimeController.ResolveProxyTotalTimeout(configuration, now, now));
    }

    [Fact]
    public async Task ModelProxyUsesPoolRoutingFieldsInsteadOfPretendingPoolIdIsAModel()
    {
        var run = BuildRun();
        run.Id = "run-model-pool-proxy-1";
        run.Status = RunStatuses.Running;
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(item => item.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>()))
            .ReturnsAsync(run);
        var handler = new CapturingHandler();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091",
            ["LlmGwServe:ApiKey"] = "gateway-secret",
            ["DesignArtifactRuntime:ModelPoolId"] = "pool-chat-premium",
            ["DesignArtifactRuntime:Model"] = "gpt-4.1-mini",
        }).Build();
        var controller = new DesignArtifactRuntimeController(
            broker.Object,
            new SingleClientFactory(handler),
            configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var requestBytes = Encoding.UTF8.GetBytes("{\"model\":\"map-managed\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}");
        controller.Request.Body = new MemoryStream(requestBytes);
        controller.Request.ContentLength = requestBytes.Length;
        controller.Request.Headers.Authorization = "Bearer model-ticket";
        controller.Response.Body = new MemoryStream();

        await controller.ProxyChatCompletions(run.Id, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, controller.Response.StatusCode);
        Assert.Null(handler.Body?["model"]);
        Assert.Equal("pool-chat-premium", handler.Body?["model_pool_id"]?.GetValue<string>());
        Assert.Equal("pool", handler.Body?["model_policy"]?.GetValue<string>());
        broker.VerifyAll();
    }

    [Fact]
    public async Task WorkspaceMetadataRoundTripsThroughRegisteredAssetStoragePath()
    {
        var root = Path.Combine(Path.GetTempPath(), $"design-workspace-assets-{Guid.NewGuid():N}");
        try
        {
            IAssetStorage storage = new LocalAssetStorage(root);
            var payload = Encoding.UTF8.GetBytes("{\"schemaVersion\":\"map-design-workspace-v1\"}");

            var stored = await DesignArtifactWorkspaceBroker.SaveWorkspaceMetadataAsync(
                storage,
                payload,
                "run-workspace-1.json",
                CancellationToken.None);

            Assert.Equal(AppDomainPaths.DomainWebHosting, AppDomainPaths.NormDomain(AppDomainPaths.DomainWebHosting));
            Assert.Equal(AppDomainPaths.TypeMeta, AppDomainPaths.NormType(AppDomainPaths.TypeMeta));
            Assert.NotNull(stored.Key);
            Assert.StartsWith(
                $"{AppDomainPaths.DomainWebHosting}/{AppDomainPaths.TypeMeta}/",
                stored.Key,
                StringComparison.Ordinal);
            Assert.Equal(payload, await storage.TryDownloadBytesAsync(stored.Key!, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void InputPackageMaterializesKnowledgeAndCurrentPageAsFiles()
    {
        var run = BuildRun();

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(
            run,
            "<!doctype html><html><body>旧页面</body></html>");

        Assert.Equal(DesignArtifactWorkspaceBroker.SchemaVersion, package.SchemaVersion);
        Assert.Equal(run.Id, package.RunId);
        Assert.Equal(64, package.BaseRevision.Length);
        Assert.Contains(package.Files, file => file.Path == "brief/task.json");
        Assert.Contains(package.Files, file => file.Path.StartsWith("knowledge/01-", StringComparison.Ordinal));
        Assert.Contains(package.Files, file => file.Path == "current/index.html");
        foreach (var file in package.Files)
        {
            var bytes = Convert.FromBase64String(file.ContentBase64);
            Assert.Equal(file.Size, bytes.LongLength);
            Assert.Equal(Hash(bytes), file.Sha256);
        }

        var taskFile = Assert.Single(package.Files, file => file.Path == "brief/task.json");
        using var task = JsonDocument.Parse(Convert.FromBase64String(taskFile.ContentBase64));
        var quality = task.RootElement.GetProperty("qualityContract");
        Assert.Equal("map-design-artifact-quality-v1", quality.GetProperty("schemaVersion").GetString());
        Assert.Equal(
            ["server-knowledge", "server-current-visible-content"],
            quality.GetProperty("factualSources").EnumerateArray().Select(value => value.GetString() ?? string.Empty).ToArray());
        Assert.False(quality.GetProperty("userSuppliedInputsAreFactualProvenance").GetBoolean());
        var input = task.RootElement.GetProperty("input");
        Assert.Equal(
            DesignArtifactInputAuthorities.UserSupplied,
            input.GetProperty("userSupplied").GetProperty("authority").GetString());
        Assert.Equal(
            "server-authoritative-snapshot",
            input.GetProperty("serverKnowledge").GetProperty("authority").GetString());
        Assert.True(quality.GetProperty("measuredClaimsRequireSource").GetBoolean());
        Assert.True(quality.GetProperty("sensitiveFactsRequireSource").GetBoolean());
        Assert.True(quality.GetProperty("contextBoundMetricsReviewRequired").GetBoolean());
        Assert.False(quality.GetProperty("visibleDraftMarkersAllowed").GetBoolean());
        Assert.False(quality.GetProperty("emptyOrMissingFragmentTargetsAllowed").GetBoolean());
        Assert.False(quality.GetProperty("inertEnabledButtonsAllowed").GetBoolean());
        Assert.True(quality.GetProperty("finalReviewRequired").GetBoolean());
        Assert.Empty(quality.GetProperty("visibleTextOccurrenceConstraints").EnumerateArray());
    }

    [Fact]
    public void InputPackageTaskMatchesSharedCrossRuntimeGoldenContract()
    {
        var package = DesignArtifactWorkspaceContract.BuildInputPackage(
            BuildRun(),
            "<!doctype html><html><body>旧页面</body></html>");
        var taskFile = Assert.Single(package.Files, file => file.Path == "brief/task.json");
        var actual = JsonNode.Parse(Convert.FromBase64String(taskFile.ContentBase64));
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "Fixtures", "opendesign-task-v1.json");
        var expected = JsonNode.Parse(File.ReadAllText(fixturePath));

        Assert.Equal(expected?.ToJsonString(), actual?.ToJsonString());
    }

    [Theory]
    [InlineData("在主标题下方新增一行短句“只出现一次的验收标记”", "只出现一次的验收标记")]
    [InlineData("请添加文案「唯一发布标记」到页面底部", "唯一发布标记")]
    [InlineData("逐项检查每个模块；在标题下方新增短句“当前子句唯一标记”", "当前子句唯一标记")]
    [InlineData("请检查每个模块，然后在标题下方新增短句“唯一标记文本”", "唯一标记文本")]
    [InlineData("在标题下方新增短句“唯一标记文本”，再检查每个按钮", "唯一标记文本")]
    public void InputPackageCompilesExplicitSingleTextInsertionIntoOccurrenceConstraint(
        string instruction,
        string expectedText)
    {
        var run = BuildRun();
        run.Instruction = instruction;

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);

        var taskFile = Assert.Single(package.Files, file => file.Path == "brief/task.json");
        using var task = JsonDocument.Parse(Convert.FromBase64String(taskFile.ContentBase64));
        var constraint = Assert.Single(
            task.RootElement.GetProperty("qualityContract")
                .GetProperty("visibleTextOccurrenceConstraints")
                .EnumerateArray());
        Assert.Equal(expectedText, constraint.GetProperty("text").GetString());
        Assert.Equal(1, constraint.GetProperty("minOccurrences").GetInt32());
        Assert.Equal(1, constraint.GetProperty("maxOccurrences").GetInt32());
    }

    [Theory]
    [InlineData("给所有卡片分别添加“相同标签”")]
    [InlineData("给每张卡片添加文案“相同标签”")]
    [InlineData("在各栏中新增短句“栏目标记”")]
    [InlineData("把“旧标题”替换为“新标题”")]
    [InlineData("新增一个段落解释“知识库”的概念")]
    public void InputPackageDoesNotInventSingleOccurrenceForMultiPlacementOrReplacement(string instruction)
    {
        var run = BuildRun();
        run.Instruction = instruction;

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);

        var taskFile = Assert.Single(package.Files, file => file.Path == "brief/task.json");
        using var task = JsonDocument.Parse(Convert.FromBase64String(taskFile.ContentBase64));
        Assert.Empty(
            task.RootElement.GetProperty("qualityContract")
                .GetProperty("visibleTextOccurrenceConstraints")
                .EnumerateArray());
    }

    [Fact]
    public void MapQualityEvidenceIncludesKnowledgeTitlesAndOnlyVisibleCurrentContent()
    {
        var run = BuildRun();
        run.KnowledgeReferences[0].Title = "2026-10-01 发布计划与 40 分钟指南";
        var current = new HostedSiteEditableEntry(
            new HostedSite(),
            "<!doctype html><html><body><p>当前可见事实</p><div hidden>平台已服务999个项目</div></body></html>",
            DateTime.UtcNow);

        var evidence = HostedSiteEditRunWorker.BuildQualityEvidence(run, current);

        Assert.Contains("2026-10-01 发布计划与 40 分钟指南", evidence, StringComparison.Ordinal);
        Assert.Contains("当前可见事实", evidence, StringComparison.Ordinal);
        Assert.DoesNotContain("999个项目", evidence, StringComparison.Ordinal);
        HostedSiteRevisionRules.ValidateGeneratedContentQuality(
            "<!doctype html><html><body><p>2026-10-01，完整阅读约40分钟。</p></body></html>",
            evidence);
    }

    [Fact]
    public void InputPackageRemovesOnlyMapDeliveryWrappersFromEditablePage()
    {
        var run = BuildRun();
        var html = $"""
            <!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="{HostedSiteRevisionRules.GeneratedArtifactCsp}">
            <script data-cds-offline-guard>addEventListener('click', block, true)</script>
            </head><body><main>真实页面</main>
            <script>window.location.hash = '#kept-for-output-review'</script>
            <!--map-slide-nav-compat--><script>window.location.pathname</script>
            </body></html>
            """;

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, html);
        var current = Assert.Single(package.Files, file => file.Path == "current/index.html");
        var editableHtml = Encoding.UTF8.GetString(Convert.FromBase64String(current.ContentBase64));

        Assert.DoesNotContain("map-slide-nav-compat", editableHtml, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("data-cds-offline-guard", editableHtml, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Content-Security-Policy", editableHtml, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("真实页面", editableHtml, StringComparison.Ordinal);
        Assert.Contains("window.location.hash", editableHtml, StringComparison.Ordinal);
    }

    [Fact]
    public void InputPackageSizeUsesSerializedBase64PackageInsteadOfRawCharacterEstimate()
    {
        var run = BuildRun();
        run.KnowledgeReferences.Clear();
        var rawHtml = $"<!doctype html><html><body>{new string('a', 800_000)}</body></html>";
        Assert.True(Encoding.UTF8.GetByteCount(rawHtml) < DesignArtifactWorkspaceBroker.MaxInputBytes);

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, rawHtml);
        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ValidateInputPackageSize(
                package,
                DesignArtifactWorkspaceBroker.MaxInputBytes));

        Assert.Contains("打包后超过远程工作区 1MB 上限", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResultPackageRejectsBytesBeyondConfiguredLimitBeforeParsing()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                new byte[1_025],
                "run-workspace-1",
                "base-revision",
                1_024));

        Assert.Contains("大小不符合要求", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void VerifiedEditPackageReachesPublicationValidationWithoutGenerationReports(bool includeResources)
    {
        var html = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><head><title>修改后</title></head><body><h1>修改后</h1></body></html>");
        var publicFiles = new List<DesignWorkspaceFile> { BuildFile("index.html", html, "text/html") };
        if (includeResources)
        {
            publicFiles.Add(BuildFile("assets/site.css", "body { color: blue; }", "text/css"));
            publicFiles.Add(BuildFile("assets/app.js", "void 0;", "text/javascript; charset=utf-8"));
            publicFiles.Add(BuildFile("assets/cover.png", "unchanged-image-fixture", "image/png"));
        }
        var package = new DesignWorkspacePackage(DesignArtifactWorkspaceBroker.SchemaVersion,
            "edit-roundtrip", "old-revision", publicFiles.Append(BuildManifest(publicFiles.ToArray())).ToArray());

        var verified = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            JsonSerializer.SerializeToUtf8Bytes(package, DesignArtifactWorkspaceContract.JsonOptions),
            "edit-roundtrip", "old-revision", DesignArtifactWorkspaceBroker.MaxOutputBytes);
        var publicationFiles = verified.Files.Select(file => new HostedSiteVerifiedFile(
            file.Path, Convert.FromBase64String(file.ContentBase64), file.Sha256, file.MediaType)).ToArray();
        var accepted = HostedSiteService.ValidateVerifiedGeneratedFiles(publicationFiles);

        Assert.Equal(publicFiles.Count + 1, accepted.Length);
        foreach (var original in publicFiles)
        {
            var published = Assert.Single(accepted.Where(file => file.Path == original.Path));
            Assert.Equal(Convert.FromBase64String(original.ContentBase64), published.Content);
            Assert.Equal(original.Sha256, published.Sha256);
            Assert.Equal(original.MediaType, published.MimeType);
        }
    }

    [Fact]
    public void VerifiedCdsHardenedResultCanBeHardenedAgainWithExactlyOneSystemCsp()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var cdsHtml = $"<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"{HostedSiteRevisionRules.GeneratedArtifactCsp}\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>CDS result</title></head><body>ok</body></html>";
        var htmlFile = BuildFile("index.html", cdsHtml, "text/html");
        var manifest = BuildManifest(htmlFile);
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [htmlFile, manifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var verified = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            bytes,
            run.Id,
            input.BaseRevision,
            DesignArtifactWorkspaceBroker.MaxOutputBytes);
        var trustedPayload = HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(verified.IndexHtml);
        var hardenedAgain = HostedSiteRevisionRules.HardenGeneratedHtml(trustedPayload);

        Assert.Single(System.Text.RegularExpressions.Regex.Matches(
                hardenedAgain,
                "Content-Security-Policy",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Cast<System.Text.RegularExpressions.Match>());
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(
                hardenedAgain,
                @"<head\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Cast<System.Text.RegularExpressions.Match>());
        Assert.Contains("name=\"viewport\"", hardenedAgain, StringComparison.Ordinal);
        Assert.Contains("CDS result", hardenedAgain, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(UntrustedSystemMetaVariants))]
    public void TrustedCdsBoundaryDoesNotStripMovedDuplicateOrCustomHttpEquiv(string html)
    {
        var boundaryResult = HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(html);

        Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.HardenGeneratedHtml(boundaryResult));
    }

    public static IEnumerable<object[]> UntrustedSystemMetaVariants()
    {
        var exact = $"<head><meta http-equiv=\"Content-Security-Policy\" content=\"{HostedSiteRevisionRules.GeneratedArtifactCsp}\"></head>";
        yield return [$"<!doctype html><html><head><title>before</title><meta http-equiv=\"Content-Security-Policy\" content=\"{HostedSiteRevisionRules.GeneratedArtifactCsp}\"></head><body></body></html>"];
        yield return [$"<!doctype html><html>{exact}{exact}<body></body></html>"];
        yield return ["<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></head><body></body></html>"];
        yield return ["<!doctype html><html><head><meta http-equiv=\"re&#102;resh\" content=\"0;url=https://evil.example\"></head><body></body></html>"];
    }

    [Fact]
    public void ResultRequiresMatchingRevisionAndVerifiedIndexHtml()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var html = Encoding.UTF8.GetBytes("<!doctype html><html><body>新页面</body></html>");
        var htmlFile = new DesignWorkspaceFile("index.html", Convert.ToBase64String(html), Hash(html), html.Length, "text/html");
        var manifest = BuildManifest(htmlFile);
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [htmlFile, manifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var parsed = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            bytes,
            run.Id,
            input.BaseRevision,
            DesignArtifactWorkspaceBroker.MaxOutputBytes);

        Assert.Contains("新页面", parsed.IndexHtml);
    }

    [Fact]
    public void PublicSixFilePackage_ShouldBeByteIdenticalAcrossDifferentPrivateKnowledgeSets()
    {
        var firstRun = BuildRun();
        var secondRun = BuildRun();
        secondRun.Id = "run-workspace-private-2";
        secondRun.KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "entry-private-2",
                Title = "另一份私有资料",
                Content = "另一份不同的私有正文",
                ContentHash = "private-content-hash-2",
            },
        ];
        var firstInput = DesignArtifactWorkspaceContract.BuildInputPackage(firstRun, null);
        var secondInput = DesignArtifactWorkspaceContract.BuildInputPackage(secondRun, null);
        Assert.NotEqual(firstInput.BaseRevision, secondInput.BaseRevision);

        var publicFiles = new[]
        {
            BuildFile("assets/accessibility-static-report.json", "{\"schemaVersion\":\"a11y-v1\"}", "application/json; charset=utf-8"),
            BuildFile("assets/design-tokens.json", "{\"schemaVersion\":\"tokens-v1\"}", "application/json; charset=utf-8"),
            BuildFile("assets/page-outline.json", "{\"schemaVersion\":\"outline-v1\"}", "application/json; charset=utf-8"),
            BuildFile("assets/provenance.json", "{\"publicInput\":\"hardened-index-html\"}", "application/json; charset=utf-8"),
            BuildFile("index.html", "<!doctype html><html><body><main>公开页面</main></body></html>", "text/html; charset=utf-8"),
        };
        var completePublicPackage = publicFiles.Append(BuildManifest(publicFiles))
            .OrderBy(file => file.Path, StringComparer.Ordinal)
            .ToArray();

        ParsedDesignWorkspaceResult Parse(DesignArtifactRun run, string privateBaseRevision)
        {
            var envelope = new DesignWorkspacePackage(
                DesignArtifactWorkspaceBroker.SchemaVersion,
                run.Id,
                privateBaseRevision,
                completePublicPackage);
            return DesignArtifactWorkspaceContract.ParseAndValidateResult(
                JsonSerializer.SerializeToUtf8Bytes(envelope, DesignArtifactWorkspaceContract.JsonOptions),
                run.Id,
                privateBaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes);
        }

        var firstPublic = Parse(firstRun, firstInput.BaseRevision).Files.OrderBy(file => file.Path).ToArray();
        var secondPublic = Parse(secondRun, secondInput.BaseRevision).Files.OrderBy(file => file.Path).ToArray();
        Assert.Equal(6, firstPublic.Length);
        Assert.True(firstPublic.SequenceEqual(secondPublic));
        Assert.DoesNotContain(firstInput.BaseRevision, Encoding.UTF8.GetString(
            Convert.FromBase64String(firstPublic.Single(file => file.Path == "manifest.json").ContentBase64)),
            StringComparison.Ordinal);
        Assert.DoesNotContain(secondInput.BaseRevision, Encoding.UTF8.GetString(
            Convert.FromBase64String(secondPublic.Single(file => file.Path == "manifest.json").ContentBase64)),
            StringComparison.Ordinal);
    }

    [Fact]
    public void PublicArtifactRevision_MatchesCdsGoldenVector()
    {
        var revision = DesignArtifactWorkspaceContract.ComputePublicArtifactRevision([
            new DesignArtifactManifestFile(
                "index.html",
                new string('a', 64),
                123,
                "text/html; charset=utf-8"),
        ]);

        Assert.Equal("682a9da217538a26e9451dd11888ae0ceef1fe807e7728c3c0b840536700de61", revision);
    }

    [Theory]
    [InlineData("other-run", null)]
    [InlineData(null, "other-revision")]
    public void ResultRejectsAnotherTaskOrSourceRevision(string? resultRunId, string? resultBaseRevision)
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var htmlFile = BuildFile("index.html", "<!doctype html><html><body>新页面</body></html>", "text/html");
        var manifest = BuildManifest(htmlFile);
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            resultRunId ?? run.Id,
            resultBaseRevision ?? input.BaseRevision,
            [htmlFile, manifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                run.Id,
                input.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes));

        Assert.Contains("版本不匹配", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResultRejectsManifestThatDoesNotMatchVerifiedFiles()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var html = Encoding.UTF8.GetBytes("<!doctype html><html><body>新页面</body></html>");
        var htmlFile = new DesignWorkspaceFile("index.html", Convert.ToBase64String(html), Hash(html), html.Length, "text/html");
        var incorrectManifest = BuildManifest(htmlFile with { Sha256 = new string('a', 64) });
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [htmlFile, incorrectManifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                run.Id,
                input.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes));

        Assert.Contains("清单与文件校验结果不一致", error.Message);
    }

    [Fact]
    public void ResultRejectsPrivateRevisionSmuggledIntoPublicManifest()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var htmlFile = BuildFile("index.html", "<!doctype html><html><body>新页面</body></html>", "text/html");
        var manifest = BuildManifest(htmlFile);
        var manifestValue = JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(manifest.ContentBase64)))!.AsObject();
        manifestValue["baseRevision"] = input.BaseRevision;
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(manifestValue, DesignArtifactWorkspaceContract.JsonOptions);
        var smuggledManifest = new DesignWorkspaceFile(
            "manifest.json",
            Convert.ToBase64String(manifestBytes),
            Hash(manifestBytes),
            manifestBytes.LongLength,
            "application/json");
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [htmlFile, smuggledManifest]);

        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions),
                run.Id,
                input.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes));

        Assert.Contains("清单格式不正确", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/index.html")]
    [InlineData("assets/../secret.txt")]
    [InlineData("assets/..")]
    [InlineData("assets/./logo.png")]
    [InlineData("assets//logo.png")]
    [InlineData("assets\\..\\secret.txt")]
    [InlineData(" assets/logo.png")]
    public void ResultRejectsNonCanonicalOrTraversalPathEvenWhenHashMatches(string path)
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var content = Encoding.UTF8.GetBytes("secret");
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [new DesignWorkspaceFile(path, Convert.ToBase64String(content), Hash(content), content.Length, "text/plain")]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                run.Id,
                input.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes));

        Assert.Contains("不允许", error.Message);
    }

    private static DesignArtifactRun BuildRun() => new()
    {
        Id = "run-workspace-1",
        UserId = "user-1",
        Title = "网页标题",
        Operation = DesignArtifactOperations.Edit,
        SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
        Instruction = "把主色改成蓝色并保留正文",
        KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "entry-1",
                Title = "产品 资料",
                Content = "产品定位与核心卖点",
                ContentHash = "source-hash",
            },
        ],
    };

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static DesignWorkspaceFile BuildManifest(params DesignWorkspaceFile[] files)
    {
        var manifestFiles = files
            .OrderBy(file => file.Path, StringComparer.Ordinal)
            .Select(file => new DesignArtifactManifestFile(file.Path, file.Sha256, file.Size, file.MediaType))
            .ToArray();
        var manifest = new DesignArtifactManifest(
            DesignArtifactWorkspaceBroker.ManifestSchemaVersion,
            DesignArtifactWorkspaceContract.ComputePublicArtifactRevision(manifestFiles),
            "index.html",
            manifestFiles);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(manifest, DesignArtifactWorkspaceContract.JsonOptions);
        return new DesignWorkspaceFile(
            "manifest.json",
            Convert.ToBase64String(bytes),
            Hash(bytes),
            bytes.Length,
            "application/json");
    }

    private static DesignWorkspaceFile BuildFile(string path, string content, string mediaType)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return new DesignWorkspaceFile(path, Convert.ToBase64String(bytes), Hash(bytes), bytes.Length, mediaType);
    }

    private sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class CapturingHandler(
        System.Net.HttpStatusCode responseStatus = System.Net.HttpStatusCode.OK,
        string responseBody = "{\"id\":\"gateway-response\"}",
        string responseMediaType = "application/json") : HttpMessageHandler
    {
        private IReadOnlyDictionary<string, string[]> _headers = new Dictionary<string, string[]>();

        public JsonObject? Body { get; private set; }

        public Uri? RequestUri { get; private set; }

        public bool RequestTokenCanBeCanceled { get; private set; }

        public string Header(string name) => _headers.TryGetValue(name, out var values)
            ? Assert.Single(values)
            : string.Empty;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestTokenCanBeCanceled = cancellationToken.CanBeCanceled;
            RequestUri = request.RequestUri;
            _headers = request.Headers.ToDictionary(item => item.Key, item => item.Value.ToArray(), StringComparer.OrdinalIgnoreCase);
            Body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken)) as JsonObject;
            return new HttpResponseMessage(responseStatus)
            {
                Content = new StringContent(responseBody, Encoding.UTF8, responseMediaType),
            };
        }
    }

    private sealed class NeverCompletingReadStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }
    }

    private sealed class DisconnectingWriteStream : Stream
    {
        public int WriteAttempts { get; private set; }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() => throw new IOException("browser disconnected");
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new IOException("browser disconnected");

        public override ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            WriteAttempts++;
            return ValueTask.FromException(new IOException("browser disconnected"));
        }
    }
}
