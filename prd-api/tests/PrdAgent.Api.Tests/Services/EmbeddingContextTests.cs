using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class EmbeddingContextTests
{
    [Fact]
    public void KnowledgeConversationDoesNotReplayPriorAssistantQuotesAfterRevocation()
    {
        var messages = new[]
        {
            new PrdAgent.Core.Models.ChatAgentMessage { Role = "user", TurnId = "old", Content = "查询内部方案" },
            new PrdAgent.Core.Models.ChatAgentMessage { Role = "assistant", TurnId = "old", Content = "旧原文中存在的机密摘录" },
            new PrdAgent.Core.Models.ChatAgentMessage { Role = "user", TurnId = "current", Content = "再说一次" }
        };
        var history = PrdAgent.Infrastructure.Services.ChatAgent.ChatAgentService.BuildCurrentHistory(messages, "current", true);
        Assert.Equal(2, history.Count);
        Assert.All(history, message => Assert.Equal("user", message.Role));
        Assert.DoesNotContain(history, message => message.Content.Contains("机密摘录"));
        Assert.Equal(3, PrdAgent.Infrastructure.Services.ChatAgent.ChatAgentService.BuildCurrentHistory(messages, "current", false).Count);
    }

    [Fact]
    public void ChatTaskAdmitsOnlyRegisteredKnowledgeEmbeddingCallers()
    {
        var policy = PrdAgent.Api.Services.BackgroundTasks.TaskAdmissionPolicies.Find(
            "PrdAgent.Api.Controllers.Api.ChatAgentController", "SendMessage");
        Assert.NotNull(policy);
        Assert.Contains(PrdAgent.Core.Models.AppCallerRegistry.Admin.KnowledgeBase.Index, policy.AppCallers);
        Assert.Contains(PrdAgent.Core.Models.AppCallerRegistry.Admin.KnowledgeBase.Query, policy.AppCallers);
        Assert.DoesNotContain(PrdAgent.Core.Models.AppCallerRegistry.Admin.WebHosting.Ask, policy.AppCallers);
    }

    [Fact]
    public async Task ResolveAndSendRetainTenantAndCallerAndRestoreOuterScope()
    {
        var accessor = new LLMRequestContextAccessor();
        var outer = new LlmRequestContext("request", null, "session", "owner", null, null, null, null,
            TenantId: "tenant", RunId: "run");
        using var scope = accessor.BeginScope(outer);
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var resolution = new GatewayModelResolution { Success = true, ActualModel = "embedding-test" };
        gateway.Setup(g => g.ResolveModelAsync("caller", "embedding", null, null, null, CancellationToken.None))
            .Callback(() =>
            {
                Assert.Equal("owner", accessor.Current?.UserId);
                Assert.Equal("tenant", accessor.Current?.TenantId);
                Assert.Equal("caller", accessor.Current?.AppCallerCode);
            }).ReturnsAsync(resolution);
        gateway.Setup(g => g.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), resolution, CancellationToken.None))
            .Callback<GatewayRawRequest, GatewayModelResolution, CancellationToken>((request, _, _) =>
            {
                Assert.Equal("tenant", request.Context?.TenantId);
                Assert.Equal("owner", request.Context?.UserId);
                Assert.Equal("run", request.Context?.RunId);
                Assert.Equal("session", request.Context?.SessionId);
                Assert.Equal("caller", accessor.Current?.AppCallerCode);
            }).ReturnsAsync(new GatewayRawResponse { Success = true, Content = """{"data":[{"index":0,"embedding":[1,0]}]}""" });
        var service = new EmbeddingService(gateway.Object, NullLogger<EmbeddingService>.Instance, accessor);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var result = await service.EmbedAsync(new[] { "无敏感测试文本" }, "caller", "owner", cancelled.Token);
        Assert.True(result.Success);
        Assert.Same(outer, accessor.Current);
        gateway.VerifyAll();
    }
}
