using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class TaskBusinessIntentTests
{
    [Fact]
    public async Task CanonicalJsonAndMultipart_AreIndependentOfPropertyOrderAndBoundary()
    {
        var first = Json("{\"b\":2,\"a\":1}", "same-intent");
        var second = Json("{\"a\":1,\"b\":2}", "same-intent");
        var one = await Resolve(first); var two = await Resolve(second);
        Assert.Equal(one, two);
        second = Json("{\"a\":2,\"b\":2}", "same-intent");
        Assert.NotEqual(one.Fingerprint, (await Resolve(second)).Fingerprint);
        DefaultHttpContext Form(string boundary)
        {
            var http = new DefaultHttpContext(); http.Request.Path = "/new-operation";
            http.Request.ContentType = "multipart/form-data; boundary=" + boundary;
            http.Request.Method = "POST"; http.Request.Headers["Idempotency-Key"] = "file-intent";
            http.Request.Form = new FormCollection(new Dictionary<string, Microsoft.Extensions.Primitives.StringValues> { ["title"] = "same" },
                new FormFileCollection { new FormFile(new MemoryStream(Encoding.UTF8.GetBytes("same-file")), 0, 9, "file", "sample.txt") { Headers = new HeaderDictionary(), ContentType = "text/plain" } });
            return http;
        }
        Assert.Equal(await Resolve(Form("one")), await Resolve(Form("two")));
    }

    [Theory]
    [InlineData(TaskExecutionOrigins.Interactive)]
    [InlineData(TaskExecutionOrigins.Agent)]
    public async Task NewBusiness_OmittingStableIntent_IsRejectedByPlatform(string origin)
    {
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => TaskBusinessIntent.ResolveAsync(
            Json("{}", null), "future.registered.operation", origin, false, default));
        Assert.Equal("TASK_INTENT_REQUIRED", error.Code);
    }

    [Fact]
    public async Task ExplicitNewOperationsRemainDistinct_AndLegacyInteractiveStreamStillWorks()
    {
        var first = await TaskBusinessIntent.ResolveAsync(Json("{}", null), "PrdAgent.Api.Controllers.Api.ModelLabController.RunStream", TaskExecutionOrigins.Interactive, false, default);
        var second = await TaskBusinessIntent.ResolveAsync(Json("{}", null), "PrdAgent.Api.Controllers.Api.ModelLabController.RunStream", TaskExecutionOrigins.Interactive, false, default);
        Assert.NotEqual(first.Key, second.Key);
        Assert.Equal(first.Fingerprint, second.Fingerprint);
        Assert.NotEqual((await Resolve(Json("{}", "one"))).Key, (await Resolve(Json("{}", "two"))).Key);
    }

    [Theory]
    [InlineData("initialize", false)]
    [InlineData("tools/list", false)]
    [InlineData("ping", false)]
    [InlineData("tools/call", true)]
    public async Task ReadOnlyMcpHandshake_DoesNotNeedPaidAdmission(string method, bool paid)
    {
        var http = Json("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"" + method + "\"}", null);
        Assert.Equal(paid, await TaskBusinessIntent.IsMcpToolCallAsync(http, default));
        Assert.Equal(0, http.Request.Body.Position);
    }

    [Theory]
    [InlineData("map_visual_list_models", false)]
    [InlineData("map_visual_generate_image", true)]
    [InlineData("unregistered_read_tool", true)]
    public async Task McpReadTools_SkipOnlyRegisteredGetAdmission(string name, bool paid)
    {
        var http = Json(JsonSerializer.Serialize(new { method = "tools/call", @params = new { name } }), null);
        Assert.Equal(paid, await TaskBusinessIntent.IsMcpToolCallAsync(http, default));
        Assert.Equal(0, http.Request.Body.Position);
    }

    [Fact]
    public async Task McpWriteIntent_UsesClientRequestId_AndIgnoresTransportIdOnly()
    {
        Task<TaskBusinessIntent> Intent(int id, string prompt) => TaskBusinessIntent.ResolveAsync(Json(
            JsonSerializer.Serialize(new { jsonrpc = "2.0", id, method = "tools/call", @params = new {
                name = "map_visual_generate_image", arguments = new { clientRequestId = "stable-image-submit", prompt }
            } }), null), "PrdAgent.Api.Controllers.McpGatewayController.Handle", TaskExecutionOrigins.Agent, false, default);
        var first = await Intent(1, "sample");
        Assert.Equal("stable-image-submit", first.Key);
        Assert.Equal(first, await Intent(2, "sample"));
        Assert.NotEqual(first.Fingerprint, (await Intent(3, "changed")).Fingerprint);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => TaskBusinessIntent.ResolveAsync(
            Json("{\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"map_visual_generate_image\"}}", null),
            "PrdAgent.Api.Controllers.McpGatewayController.Handle", TaskExecutionOrigins.Agent, false, default));
    }

    private static Task<TaskBusinessIntent> Resolve(HttpContext http) => TaskBusinessIntent.ResolveAsync(http,
        "future.registered.operation", TaskExecutionOrigins.Interactive, false, default);
    private static DefaultHttpContext Json(string body, string? key)
    {
        var http = new DefaultHttpContext(); http.Request.Path = "/new-operation";
        http.Request.Method = "POST"; http.Request.ContentType = "application/json";
        http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        if (key is not null) http.Request.Headers["Idempotency-Key"] = key;
        return http;
    }
}
