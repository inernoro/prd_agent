using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests;

public class ChatAgentResponseEnvelopeTests
{
    // Execute the MVC formatter: inspecting ObjectResult.Value alone misses wire-shape failures.
    [Theory]
    [InlineData(0, "items")]
    [InlineData(1, "item")]
    [InlineData(2, "item")]
    [InlineData(3, "item")]
    [InlineData(4, "deleted")]
    [InlineData(5, "items")]
    [InlineData(6, "turnId")]
    public async Task OrdinarySuccessResponsesKeepClientEnvelopeAndDataShape(int action, string dataKey)
    {
        var service = Service();
        var controller = Controller(service.Object);
        IActionResult result = action switch
        {
            0 => await controller.ListSessions(default),
            1 => await controller.CreateSession(new("测试会话", null), default),
            2 => await controller.GetSession("session", default),
            3 => await controller.RenameSession("session", new("重命名"), default),
            4 => await controller.DeleteSession("session", default),
            5 => await controller.ListMessages("session", 200, default),
            _ => await controller.SendMessage("session", new("测试消息"), default),
        };
        var (status, wire) = await Format(result, controller.HttpContext);
        Assert.Equal(200, status);
        AssertClientEnvelope(wire, true);
        Assert.Equal(JsonValueKind.Null, wire.GetProperty("error").ValueKind);
        var data = wire.GetProperty("data");
        Assert.True(data.TryGetProperty(dataKey, out var value));
        if (dataKey == "item") Assert.Equal("session", value.GetProperty("id").GetString());
        if (dataKey == "items") Assert.Equal(JsonValueKind.Array, value.ValueKind);
        if (dataKey == "deleted") Assert.True(value.GetBoolean());
        if (dataKey == "turnId")
        {
            Assert.Equal("turn", value.GetString());
            Assert.Equal(3, data.GetProperty("seq").GetInt64());
            Assert.False(data.TryGetProperty("accepted", out _));
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task OrdinaryFailuresSerializeNullDataAndStructuredCode(int action)
    {
        var service = Service();
        service.Setup(x => x.GetSessionAsync("user", "session", It.IsAny<CancellationToken>()))
            .ReturnsAsync((ChatAgentSessionView?)null);
        service.Setup(x => x.RenameSessionAsync("user", "session", It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((ChatAgentSessionView?)null);
        service.Setup(x => x.DeleteSessionAsync("user", "session", It.IsAny<CancellationToken>())).ReturnsAsync(false);
        service.Setup(x => x.SendMessageAsync("user", "session", It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("这一轮尚未结束"));
        var controller = Controller(service.Object);
        IActionResult result = action switch
        {
            0 => await controller.GetSession("session", default),
            1 => await controller.RenameSession("session", new("重命名"), default),
            2 => await controller.DeleteSession("session", default),
            _ => await controller.SendMessage("session", new("测试消息"), default),
        };
        var (status, wire) = await Format(result, controller.HttpContext);
        Assert.Equal(action == 3 ? 400 : 404, status);
        AssertClientEnvelope(wire, false);
        Assert.Equal(JsonValueKind.Null, wire.GetProperty("data").ValueKind);
        Assert.Equal(action == 3 ? "CHAT_MESSAGE_REJECTED" : ErrorCodes.SESSION_NOT_FOUND,
            wire.GetProperty("error").GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(wire.GetProperty("error").GetProperty("message").GetString()));
    }

    [Fact]
    public async Task StreamKeepsUnwrappedSseEvents()
    {
        var service = Service();
        service.Setup(x => x.ReadEventsAsync("user", "session", 0, 200, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ChatAgentEventPage(Array.Empty<ChatAgentEventView>(), 0, false));
        var controller = Controller(service.Object);
        await controller.Stream("session");
        controller.Response.Body.Position = 0;
        var text = await new StreamReader(controller.Response.Body).ReadToEndAsync();
        Assert.Equal("id: 0\nevent: idle\ndata: {}\n\n", text);
        Assert.StartsWith("text/event-stream", controller.Response.ContentType);
    }

    private static void AssertClientEnvelope(JsonElement wire, bool success)
    {
        // Same three-field boundary used by the real frontend apiClient.isApiResponseLike.
        Assert.Equal(success, wire.GetProperty("success").GetBoolean());
        Assert.True(wire.TryGetProperty("data", out _));
        Assert.True(wire.TryGetProperty("error", out _));
    }

    private static Mock<IChatAgentService> Service()
    {
        var service = new Mock<IChatAgentService>();
        var view = new ChatAgentSessionView("session", "测试会话", null, "default", false, 0, null,
            DateTime.UnixEpoch, DateTime.UnixEpoch);
        service.Setup(x => x.ListSessionsAsync("user", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new[] { view });
        service.Setup(x => x.CreateSessionAsync("user", It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(view);
        service.Setup(x => x.GetSessionAsync("user", "session", It.IsAny<CancellationToken>())).ReturnsAsync(view);
        service.Setup(x => x.RenameSessionAsync("user", "session", It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(view);
        service.Setup(x => x.DeleteSessionAsync("user", "session", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        service.Setup(x => x.ListMessagesAsync("user", "session", 200, It.IsAny<CancellationToken>()))
            .ReturnsAsync(Array.Empty<ChatAgentMessageView>());
        service.Setup(x => x.SendMessageAsync("user", "session", It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ChatAgentTurnAccepted("turn", "user-message", "assistant-message", 3));
        return service;
    }

    private static ChatAgentController Controller(IChatAgentService service) => new(service,
        NullLogger<ChatAgentController>.Instance)
    {
        ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "user") }, "test")),
                Response = { Body = new MemoryStream() },
            },
        },
    };

    private static async Task<(int Status, JsonElement Wire)> Format(IActionResult result, HttpContext http)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddControllers().AddJsonOptions(options =>
        {
            options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            options.JsonSerializerOptions.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
            options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
            options.JsonSerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
        });
        await using var provider = services.BuildServiceProvider();
        http.RequestServices = provider;
        await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
        http.Response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(http.Response.Body);
        return (http.Response.StatusCode, document.RootElement.Clone());
    }
}
