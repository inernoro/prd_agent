using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Moq;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class McpTaskReplayResponseTests
{
    [Theory]
    [InlineData("19")]
    [InlineData("\"rpc-next\"")]
    public async Task CachedMcpReplay_RebindsOnlyRpcId_WithoutRunningPaidDelegate(string currentId)
    {
        const string cached="{\"jsonrpc\":\"2.0\",\"id\":18,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"runId\\\":\\\"same-run\\\",\\\"status\\\":\\\"queued\\\"}\"}],\"isError\":false}}";
        var (http,permit,coordinator,nextRan)=await ReplayAsync(currentId,cached);
        Assert.False(nextRan);
        Assert.Equal(200,http.Response.StatusCode);
        Assert.Equal("true",http.Response.Headers["Idempotency-Replayed"].ToString());
        var output=JsonNode.Parse(Read(http))!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(currentId),output["id"]));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(cached)!["result"],output["result"]));
        Assert.Equal(cached,permit.AcceptedResponseBody);
        coordinator.Verify(x=>x.RegisterAsync(It.IsAny<GatewayTaskPermitRecord>(),true,It.IsAny<CancellationToken>()),Times.Once);
        coordinator.VerifyNoOtherCalls(); // replay 不 Acquire、不保存新响应，也不进入付费链路。
    }

    [Fact]
    public async Task CachedMcpError_RebindsIdAndPreservesError()
    {
        const string cached="{\"jsonrpc\":\"2.0\",\"id\":18,\"error\":{\"code\":-32602,\"message\":\"original refusal\",\"data\":{\"reason\":\"same\"}}}";
        var (http,_,coordinator,nextRan)=await ReplayAsync("20",cached);
        Assert.False(nextRan);
        Assert.Equal(20,JsonNode.Parse(Read(http))!["id"]!.GetValue<int>());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(cached)!["error"],JsonNode.Parse(Read(http))!["error"]));
        coordinator.Verify(x=>x.RegisterAsync(It.IsAny<GatewayTaskPermitRecord>(),true,It.IsAny<CancellationToken>()),Times.Once);
        coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("true")]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("1.5")]
    public async Task InvalidCurrentRpcId_DoesNotReplayCachedSuccess(string currentId)
    {
        var (http,_,_,nextRan)=await ReplayAsync(currentId,"{\"jsonrpc\":\"2.0\",\"id\":18,\"result\":{\"runId\":\"same\"}}");
        Assert.False(nextRan);
        Assert.Equal(409,http.Response.StatusCode);
        Assert.DoesNotContain("same",Read(http));
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("{\"jsonrpc\":\"2.0\",\"id\":18,\"result\":{},\"error\":{}}")]
    [InlineData("{\"jsonrpc\":\"2.0\",\"id\":18}")]
    [InlineData("{\"jsonrpc\":\"1.0\",\"id\":18,\"result\":{}}") ]
    [InlineData("{\"jsonrpc\":\"2.0\",\"id\":18,\"error\":{\"code\":\"bad\",\"message\":\"refused\"}}") ]
    [InlineData("{\"jsonrpc\":\"2.0\",\"id\":18,\"id\":19,\"result\":{}}") ]
    public async Task InvalidCachedRpcEnvelope_DoesNotClaimSuccessfulReplay(string cached)
    {
        var (http,_,_,nextRan)=await ReplayAsync("19",cached);
        Assert.False(nextRan);
        Assert.Equal(409,http.Response.StatusCode);
    }

    [Fact]
    public async Task RestCachedResponse_RemainsByteForByteUnchanged()
    {
        const string cached="{ \"id\" : 18, \"result\" : { \"value\" : \"same\" } }";
        var (http,_,_,nextRan)=await ReplayAsync("19",cached,false);
        Assert.False(nextRan);
        Assert.Equal(cached,Read(http));
    }

    private static async Task<(DefaultHttpContext Http,GatewayTaskPermitRecord Permit,Mock<ITaskExecutionCoordinator> Coordinator,bool NextRan)>
        ReplayAsync(string currentId,string cached,bool mcp=true)
    {
        var controller=mcp?typeof(McpGatewayController):typeof(PrdAgent.Api.Controllers.Api.ModelLabController);
        var action=mcp?"Handle":"RunStream";
        var descriptor=new ControllerActionDescriptor { ControllerTypeInfo=controller.GetTypeInfo(),ActionName=action,
            MethodInfo=controller.GetMethods().First(m=>m.Name==action) };
        var http=new DefaultHttpContext();
        http.SetEndpoint(new Endpoint(_=>Task.CompletedTask,new EndpointMetadataCollection(descriptor),action));
        http.User=new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.NameIdentifier,"owner"),
            new Claim("agentApiKeyId","registered-agent-reference") },"TestAgent"));
        http.Request.Method="POST";http.Request.Path=mcp?"/api/mcp":"/api/lab/run";http.Request.ContentType="application/json";
        var body=mcp?"{\"jsonrpc\":\"2.0\",\"id\":"+currentId+",\"method\":\"tools/call\",\"params\":{\"name\":\"map_visual_generate_image\",\"arguments\":{\"clientRequestId\":\"same-existing-request\",\"prompt\":\"same\"}}}":"{\"clientRequestId\":\"same-existing-request\"}";
        http.Request.Body=new MemoryStream(Encoding.UTF8.GetBytes(body));
        http.Response.Body=new MemoryStream();
        var permit=new GatewayTaskPermitRecord { Id="existing-permit",SourceTask=controller.FullName+"."+action,
            AcceptedResponseStatus=200,AcceptedResponseContentType="application/json",AcceptedResponseBody=cached };
        var coordinator=new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        coordinator.Setup(x=>x.RegisterAsync(It.IsAny<GatewayTaskPermitRecord>(),true,It.IsAny<CancellationToken>()))
            .ReturnsAsync(new TaskExecutionAdmission(permit,true,null));
        var data=new LlmGatewayDataContext("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=10","unit-test-no-network");
        var admission=new TaskAdmissionService(data,new ConfigurationBuilder().Build(),executions:coordinator.Object);
        var nextRan=false;
        await new TaskAdmissionMiddleware(_=>{nextRan=true;throw new InvalidOperationException("paid delegate must not execute during replay");}).InvokeAsync(http,admission);
        return (http,permit,coordinator,nextRan);
    }
    private static string Read(DefaultHttpContext http)=>Encoding.UTF8.GetString(((MemoryStream)http.Response.Body).ToArray());
}
