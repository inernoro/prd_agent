using System.Reflection;
using Microsoft.Extensions.Configuration;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 模型可见性（Codex P1，2026-09-15）。`.claude/rules/ai-model-visibility.md` 的判定标准是
/// 「用户会因为换了个模型感知到结果差异 → 必须显示模型名」，网页生成与改写正落在里面。
/// Start 是唯一带解析结果的分片：模型池换人或故障转移之后，真正跑这一次的模型只在那里出现一次；
/// 执行器循环原先只留文本、思考与错误，把它整个丢掉，面板于是永远只显示运行时名字。
/// </summary>
public sealed class DesignArtifactModelVisibilityTests
{
    [Fact]
    public async Task StartChunkResolutionBecomesAModelChunkBeforeAnyText()
    {
        var chunks = new[]
        {
            new GatewayStreamChunk
            {
                Type = GatewayChunkType.Start,
                Resolution = new GatewayModelResolution
                {
                    Success = true,
                    ActualModel = "anthropic/claude-sonnet-4-6",
                    ActualPlatformName = "OpenRouter",
                },
            },
            new GatewayStreamChunk { Type = GatewayChunkType.Thinking, Content = "想一下" },
            new GatewayStreamChunk { Type = GatewayChunkType.Text, Content = "<html>" },
        };

        var produced = await RunExecutorAsync(chunks);

        Assert.Equal(new[] { "model", "thinking", "delta" }, produced.Select(x => x.Type).ToArray());
        var model = produced[0].ResolvedModel;
        Assert.NotNull(model);
        Assert.Equal("anthropic/claude-sonnet-4-6", model!.Model);
        Assert.Equal("OpenRouter", model.Platform);
        // 内容字段同样带模型名，调用方不必解包 record 才能记日志。
        Assert.Equal("anthropic/claude-sonnet-4-6", produced[0].Content);
    }

    [Fact]
    public async Task ModelChunkIsEmittedOnceAndNeverInvented()
    {
        var produced = await RunExecutorAsync(new[]
        {
            // 解析结果缺失或模型名为空时不许编一个出来（no-rootless-tree）。
            new GatewayStreamChunk { Type = GatewayChunkType.Start },
            new GatewayStreamChunk
            {
                Type = GatewayChunkType.Start,
                Resolution = new GatewayModelResolution { Success = true, ActualModel = "   " },
            },
            new GatewayStreamChunk
            {
                Type = GatewayChunkType.Start,
                Resolution = new GatewayModelResolution { Success = true, ActualModel = "gpt-5" },
            },
            // 故障转移会再来一个 Start；面板只认第一次落定的那个，不来回跳。
            new GatewayStreamChunk
            {
                Type = GatewayChunkType.Start,
                Resolution = new GatewayModelResolution { Success = true, ActualModel = "gpt-5-mini" },
            },
            new GatewayStreamChunk { Type = GatewayChunkType.Text, Content = "<html>" },
        });

        var models = produced.Where(x => x.Type == "model").ToArray();
        var single = Assert.Single(models);
        Assert.Equal("gpt-5", single.ResolvedModel!.Model);
        // 平台名上游没给就兜底到网关，不留空字符串。
        Assert.Equal("LLM Gateway", single.ResolvedModel.Platform);
    }

    // 真验收抓到的那一条（2026-09-15）：执行器发了、SSE 也推了，但 worker 只改了内存里的 run
    // 对象，而它全程用 Update.Set 逐字段写库——于是 DTO 字段在、值恒为 null，刷新后面板空着。
    // 单测测的是「函数对不对」，落库这一步得单独钉：worker 里必须有一条把这两个字段写进去的更新。
    [Fact]
    public void WorkerPersistsTheResolvedModelInsteadOfOnlyMutatingMemory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !File.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api",
                   "Services", "HostedSiteEditRunWorker.cs")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var source = File.ReadAllText(Path.Combine(directory!.FullName, "prd-api", "src", "PrdAgent.Api",
            "Services", "HostedSiteEditRunWorker.cs"));
        // companion：真的读到了这个文件，否则下面两条会对着空串判绿。
        Assert.Contains("chunk.Type == \"model\"", source, StringComparison.Ordinal);
        Assert.Contains("Set(item => item.ResolvedModel", source, StringComparison.Ordinal);
        Assert.Contains("Set(item => item.ResolvedPlatform", source, StringComparison.Ordinal);
    }

    private static async Task<IReadOnlyList<DesignArtifactExecutorChunk>> RunExecutorAsync(
        IReadOnlyList<GatewayStreamChunk> chunks)
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Loose);
        gateway.Setup(x => x.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Returns(ToAsync(chunks));
        var accessor = new Mock<ILLMRequestContextAccessor>(MockBehavior.Loose);
        accessor.Setup(x => x.BeginScope(It.IsAny<LlmRequestContext>())).Returns(new NoopScope());
        var executor = new MapGatewayDesignArtifactExecutor(
            gateway.Object, accessor.Object, new ConfigurationBuilder().Build());
        var run = new DesignArtifactRun
        {
            UserId = "viewer-user",
            Instruction = "做一页介绍",
            LlmRequestPolicy = new DesignArtifactLlmRequestPolicy { Model = "frozen-model" },
        };
        var produced = new List<DesignArtifactExecutorChunk>();
        await foreach (var chunk in executor.ExecuteAsync(run, null, CancellationToken.None))
            produced.Add(chunk);
        // companion：执行器真的跑出了东西，否则下面的断言会对着空列表判绿。
        Assert.NotEmpty(produced);
        return produced;
    }

    private static async IAsyncEnumerable<GatewayStreamChunk> ToAsync(IReadOnlyList<GatewayStreamChunk> items)
    {
        foreach (var item in items)
        {
            await Task.Yield();
            yield return item;
        }
    }

    private sealed class NoopScope : IDisposable
    {
        public void Dispose() { }
    }
}
