using System.Reflection;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Arena;

public class ArenaLogicalWorkerTests
{
    [Theory]
    [InlineData("empty", false)]
    [InlineData("thinking", false)]
    [InlineData("error", false)]
    [InlineData("answer", true)]
    public async Task SelectedLogicalModelUsesGatewayWithoutPhysicalPinsAndRequiresAnswer(string kind, bool expected)
    {
        var client = new Mock<ILLMClient>(MockBehavior.Strict);
        client.Setup(x => x.StreamGenerateAsync("", It.IsAny<List<LLMMessage>>(), false, It.IsAny<CancellationToken>()))
            .Returns(Chunks(kind));
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.GetAvailablePoolsAsync(AppCallerRegistry.Desktop.Arena.BattleChat, ModelTypes.Chat, It.IsAny<CancellationToken>()))
            .ReturnsAsync([new AvailableModelPool { Id = "logical-id", Code = "current-public-name", ResolutionType = "LogicalModel", Models = [new PoolModelInfo { HealthStatus = "Healthy" }] }]);
        gateway.Setup(x => x.CreateClient(AppCallerRegistry.Desktop.Arena.BattleChat, ModelTypes.Chat,
            4096, 0.2, false, "current-public-name", null, null)).Returns(client.Object);
        var events = new List<string>();
        var store = new Mock<IRunEventStore>(MockBehavior.Strict);
        store.Setup(x => x.AppendEventAsync(RunKinds.Arena, "run", "model", It.IsAny<object>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, string, object, TimeSpan?, CancellationToken>((_, _, _, payload, _, _) => events.Add(System.Text.Json.JsonSerializer.Serialize(payload)))
            .ReturnsAsync(1);
        using var services = new ServiceCollection().BuildServiceProvider();
        var worker = new ArenaRunWorker(services.GetRequiredService<IServiceScopeFactory>(), Mock.Of<IRunQueue>(), store.Object,
            new ConfigurationBuilder().Build(), NullLogger<ArenaRunWorker>.Instance);
        var slotType = typeof(ArenaRunWorker).GetNestedType("ArenaSlotInput", BindingFlags.NonPublic)!;
        var slot = Activator.CreateInstance(slotType, "slot", "logical-id", "logical-model", "stale-public-name", "A", 0)!;
        var method = typeof(ArenaRunWorker).GetMethod("RunOneSlotAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var task = (Task<bool>)method.Invoke(worker, ["run", slot, "测试", "user", new List<LLMAttachment>(), null,
            gateway.Object, Mock.Of<ILLMRequestContextAccessor>(), new Dictionary<string, StringBuilder> { ["slot"] = new() }, CancellationToken.None])!;
        Assert.Equal(expected, await task);
        Assert.Equal(expected, events.Any(x => x.Contains("modelDone")));
        Assert.Equal(!expected, events.Any(x => x.Contains("modelError")));
        gateway.VerifyAll();
        client.VerifyAll();
    }

    private static async IAsyncEnumerable<LLMStreamChunk> Chunks(string kind)
    {
        await Task.CompletedTask;
        if (kind == "thinking") yield return new() { Type = "thinking", Content = "正在分析" };
        if (kind == "error") yield return new() { Type = "error", ErrorMessage = "模拟失败" };
        if (kind == "answer") yield return new() { Type = "delta", Content = "实际回答" };
        yield return new() { Type = "done" };
    }
}
