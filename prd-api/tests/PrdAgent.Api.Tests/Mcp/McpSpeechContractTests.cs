using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class McpSpeechContractTests
{
    [Fact]
    public void GenerateOnlyGrantDiscoversReadToolsButReadOnlyCannotGenerate()
    {
        Assert.True(McpCapabilityCatalog.ScopeSatisfies(new[] { McpCapabilityCatalog.ScopeSpeechGenerate }, McpCapabilityCatalog.ScopeSpeechRead));
        Assert.False(McpCapabilityCatalog.ScopeSatisfies(new[] { McpCapabilityCatalog.ScopeSpeechRead }, McpCapabilityCatalog.ScopeSpeechGenerate));
        var capability = McpCapabilityCatalog.All.Single(x => x.Key == "speech");
        Assert.Equal(6, McpCapabilityCatalog.ToolsOf(capability).Count);
        Assert.DoesNotContain(McpCapabilityCatalog.ToolsOf(capability), x => x.PathTemplate.Contains("settings"));
    }

    [Fact]
    public void UnknownProviderFeatureIsRejectedInsteadOfSilentlyDropped()
    {
        var tool = McpBuiltinTools.All.Single(x => x.Name == "map_speech_generate");
        var schema = McpGatewayController.BuiltinToolToJson(tool)["inputSchema"]!;
        Assert.False(schema["additionalProperties"]!.GetValue<bool>());
        var request = McpGatewayController.BuildBuiltinRequest(tool, new JsonObject { ["text"] = "需要朗读", ["unsupported_feature"] = true });
        Assert.NotNull(request.err);
        Assert.Null(request.body);
        var accepted = McpGatewayController.BuildBuiltinRequest(tool, new JsonObject { ["text"] = "需要朗读", ["speed"] = 1.25 });
        Assert.Null(accepted.err);
        Assert.Equal(1.25, accepted.body!["speed"]!.GetValue<double>());
    }

    [Fact]
    public void SpeechAuditDoesNotCopyNarrationOrVoiceInstructions()
    {
        var preview = McpUsageService.SummarizeArguments(new JsonObject
        {
            ["text"] = "私密朗读稿", ["instructions"] = "私密风格要求", ["voiceId"] = "configured-voice", ["speed"] = 1,
        }, "map_speech_generate");
        Assert.DoesNotContain("私密朗读稿", preview!);
        Assert.DoesNotContain("私密风格要求", preview!);
        Assert.Contains("configured-voice", preview!);
    }

    [Theory]
    [InlineData("queued")]
    [InlineData("completed")]
    [InlineData("failed")]
    [InlineData("unknown")]
    public void AsyncArtifactPreservesTaskStatusAlongsideHistoryLink(string status)
    {
        var body = JsonSerializer.Serialize(new { success = true, data = new { runId = "run-1", title = "旁白", status } });
        var artifact = McpArtifactExtractor.Extract("map_speech_get_run", false, body);
        Assert.Equal("audio-run", artifact.Kind);
        Assert.Equal(status, artifact.Status);
        Assert.Equal("/mcp-console?tab=speech&run=run-1", artifact.Url);
    }

    [Fact]
    public void DirectRequestCannotSupplyEndpointOrCredentials()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<SpeechCreateRequest>(
            """{"text":"朗读稿","endpoint":"https://untrusted.example","apiKey":"do-not-accept"}""",
            new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }
}
