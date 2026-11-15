using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>Fixed client requests cross production ingress, gateway and adapters; only provider HTTP is simulated.</summary>
public class ProtocolCompatibilityReplayTests
{
    private static string Root => FindRoot();
    private static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "scripts/fixtures/llmgw-compat/requests.json"))) dir = dir.Parent;
        return dir?.FullName ?? throw new DirectoryNotFoundException("compat corpus missing");
    }
    public static IEnumerable<object[]> Cases()
    {
        var corpus = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "scripts/fixtures/llmgw-compat/requests.json")))!;
        foreach (var c in corpus["cases"]!.AsArray())
            foreach (var upstream in new[] { "openai", "claude" })
                yield return new object[] { c!["id"]!.GetValue<string>(), upstream };
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task Replay(string id, string upstream)
    {
        var corpus = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "scripts/fixtures/llmgw-compat/requests.json")))!;
        var cell = corpus["cases"]!.AsArray().Single(c => (string?)c!["id"] == id)!;
        var stream = cell["stream"]!.GetValue<bool>();
        var reasoningRejected = (string?)cell["kind"] == "reasoning" && upstream == "claude";
        var transport = new Provider(upstream, (string)cell["kind"]!, stream, (string)cell["protocol"]!);
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(r => r.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(new ModelResolutionResult
        {
            Success = true, ActualModel = "compat-model", ActualPlatformId = "compat-platform",
            Protocol = upstream, PlatformType = upstream, ApiUrl = "https://provider.invalid/v1", ApiKey = "synthetic",
            SupportsFunctionCalling = true, SupportsThinking = true,
            ParameterCapabilities = new() { ["reasoning"] = true, ["reasoning_effort"] = true },
        });
        var gateway = new LlmGateway(resolver.Object, transport, NullLogger<LlmGateway>.Instance);
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        builder.Services.AddSingleton<ILlmGateway>(gateway);
        builder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
        builder.Services.AddSingleton<IHttpContextAccessor, HttpContextAccessor>();
        builder.Services.AddSingleton<GatewayCancellationRegistry>();
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
        GatewayAuthorizedTaskFixture.Register(builder.Services);
        await using var app = builder.Build();
        app.MapGatewayServingEndpoints(new JsonSerializerOptions { PropertyNamingPolicy = null }, "compat-key", "compat-version");
        await app.StartAsync();
        using var client = GatewayAuthorizedTaskFixture.Client(app);
        client.DefaultRequestHeaders.Add("X-Gateway-Key", "compat-key");
        client.DefaultRequestHeaders.Add("X-Gateway-App-Caller", AppCallerRegistry.ReportAgent.Generate.Draft);
        client.DefaultRequestHeaders.Add("X-Gateway-Include-Thinking", "false");
        var path = ((string)cell["path"]!).Replace("{model}", "compat-model");
        using var response = await client.PostAsync(path, new StringContent(cell["body"]!.ToJsonString(), Encoding.UTF8, "application/json"));
        var raw = await response.Content.ReadAsStringAsync();
        Assert.False(string.IsNullOrWhiteSpace(raw));
        if (reasoningRejected)
        {
            Assert.Contains("PARAMETER_PROTOCOL_UNSUPPORTED", raw);
            Assert.Equal(0, transport.Calls);
        }
        else
        {
            Assert.True(response.IsSuccessStatusCode, raw);
            Assert.Equal(1, transport.Calls);
            Assert.Equal("compat-model", (string?)transport.Wire!["model"]);
            if (cell["parameter"] is { } parameter)
            {
                var key = (string)parameter!;
                Assert.True(JsonNode.DeepEquals(cell["body"]!["RequestBody"]![key], transport.Wire[key]));
            }
        }
        if (Environment.GetEnvironmentVariable("LLMGW_COMPAT_CAPTURE_DIR") is { Length: > 0 } output)
        {
            Directory.CreateDirectory(output);
            await File.WriteAllTextAsync(Path.Combine(output, $"{upstream}--{id}.json"), new JsonObject
            {
                ["sourceCommit"] = typeof(GatewayHttpEndpoints).Assembly
                    .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+').Last(),
                ["id"] = id, ["upstream"] = upstream, ["status"] = (int)response.StatusCode,
                ["contentType"] = response.Content.Headers.ContentType?.MediaType, ["raw"] = raw,
                ["rejected"] = reasoningRejected,
            }.ToJsonString());
        }
    }

    private sealed class Provider(string protocol, string kind, bool stream, string ingress) : IHttpClientFactory
    {
        private string Protocol => protocol;
        private string Kind => kind;
        private bool Stream => stream;
        private string Ingress => ingress;
        public int Calls;
        public JsonNode? Wire;
        public HttpClient CreateClient(string name) => new(new Handler(this));
        private sealed class Handler(Provider owner) : HttpMessageHandler
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                owner.Calls++;
                owner.Wire = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct));
                var claude = owner.Protocol == "claude";
                Assert.Equal(claude ? "/v1/messages" : "/v1/chat/completions", request.RequestUri!.AbsolutePath);
                if (owner.Kind == "tools")
                {
                    var t = owner.Wire!["tools"]!.AsArray().Single()!;
                    Assert.Equal("echo_city", (string?)(claude ? t["name"] : t["function"]!["name"]));
                    var schema = JsonNode.Parse("""{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}""");
                    Assert.True(JsonNode.DeepEquals(schema, claude ? t["input_schema"] : t["function"]!["parameters"]));
                    var choice = owner.Wire["tool_choice"];
                    Assert.NotNull(choice);
                    if (owner.Ingress == "gemini")
                    {
                        Assert.Equal("echo_city", (string?)(claude ? choice["name"] : choice["function"]!["name"]));
                        Assert.Equal(claude ? "tool" : "function", (string?)choice["type"]);
                    }
                    else if (claude) Assert.Equal("any", (string?)choice["type"]);
                    else Assert.Equal("required", (string?)choice);
                }
                var tool = owner.Kind == "tools";
                string raw;
                if (!owner.Stream)
                    raw = claude
                        ? (tool ? """{"content":[{"type":"tool_use","id":"call_fixture","name":"echo_city","input":{"city":"北京"}}],"stop_reason":"tool_use","usage":{"input_tokens":11,"output_tokens":7}}"""
                            : """{"content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":7}}""")
                        : (tool ? """{"choices":[{"message":{"tool_calls":[{"id":"call_fixture","type":"function","function":{"name":"echo_city","arguments":"{\"city\":\"北京\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}"""
                            : """{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}""");
                else
                {
                    string[] events = claude
                        ? (tool ? new[] {
                            """{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_fixture","name":"echo_city","input":{}}}""",
                            """{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}""",
                            """{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"北京\"}"}}""",
                            """{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}""" }
                          : new[] { """{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}""",
                            """{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}""" })
                        : (tool ? new[] {
                            """{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"echo_city","arguments":"{\"city\":"}}]}}]}""",
                            """{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"北京\"}"}}]}}]}""",
                            """{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}""",
                            """{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}""" }
                          : new[] { """{"choices":[{"delta":{"content":"O"}}]}""", """{"choices":[{"delta":{"content":"K"}}]}""",
                            """{"choices":[{"delta":{},"finish_reason":"stop"}]}""", """{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}""" });
                    if (claude)
                        events = new[] { """{"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"compat-model","content":[],"usage":{"input_tokens":11,"output_tokens":0,"cache_creation_input_tokens":3,"cache_read_input_tokens":5}}}""" }.Concat(events).ToArray();
                    raw = string.Join("", events.Select(e => "data: " + e + "\n\n")) + (claude ? "" : "data: [DONE]\n\n");
                }
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(raw, Encoding.UTF8, owner.Stream ? "text/event-stream" : "application/json") };
            }
        }
    }
}
