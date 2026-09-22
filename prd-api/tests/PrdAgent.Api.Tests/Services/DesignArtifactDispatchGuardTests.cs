using System.Runtime.CompilerServices;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class DesignArtifactDispatchGuardTests
{
    [Fact]
    public async Task RevokedKnowledge_ShouldFailBeforeAnyExecutorDispatch()
    {
        var resolver = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        resolver.Setup(service => service.ResolveForRunAsync(
                "user-a",
                It.Is<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(items =>
                    items.Count == 1
                    && items[0].EntryId == "entry-a"
                    && items[0].StoreId == "store-a"
                    && items[0].ExpectedContentHash == new string('a', 64)),
                CancellationToken.None))
            .ThrowsAsync(new DesignKnowledgeSnapshotException(
                ErrorCodes.NOT_FOUND,
                "引用知识不存在或当前账号无权读取"));
        var executor = new CountingExecutor();
        var run = BuildRun();

        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(async () =>
        {
            await foreach (var _ in HostedSiteEditRunWorker.ExecuteWithKnowledgeDispatchGuardAsync(
                               resolver.Object,
                               executor,
                               run,
                               null,
                               CancellationToken.None))
            {
            }
        });

        Assert.Equal(0, executor.PrepareCount);
        Assert.Equal(0, executor.CreateSessionCount);
        Assert.Equal(0, executor.GatewayCount);
        resolver.VerifyAll();
    }

    [Fact]
    public async Task UnchangedAuthorizedKnowledge_ShouldDispatchExactlyOnce()
    {
        var resolver = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        resolver.Setup(service => service.ResolveForRunAsync(
                "user-a",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ReturnsAsync(BuildRun().KnowledgeReferences);
        var executor = new CountingExecutor();

        await foreach (var _ in HostedSiteEditRunWorker.ExecuteWithKnowledgeDispatchGuardAsync(
                           resolver.Object,
                           executor,
                           BuildRun(),
                           null,
                           CancellationToken.None))
        {
        }

        Assert.Equal(1, executor.PrepareCount);
        Assert.Equal(1, executor.CreateSessionCount);
        Assert.Equal(1, executor.GatewayCount);
        resolver.VerifyAll();
    }

    [Fact]
    public void QualityEvidence_ShouldNotTreatClientInstructionAsKnowledgeProvenance()
    {
        var run = BuildRun();
        run.Instruction = "客户端声称收入增长 999%";

        var evidence = HostedSiteEditRunWorker.BuildQualityEvidence(run, null);

        Assert.DoesNotContain(run.Instruction, evidence, StringComparison.Ordinal);
        Assert.Contains("冻结正文", evidence, StringComparison.Ordinal);
    }

    private static DesignArtifactRun BuildRun() => new()
    {
        UserId = "user-a",
        Instruction = "生成网页",
        KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "entry-a",
                StoreId = "store-a",
                Content = "冻结正文",
                ContentHash = new string('a', 64),
            },
        ],
    };

    private sealed class CountingExecutor : IDesignArtifactExecutor
    {
        public int PrepareCount { get; private set; }
        public int CreateSessionCount { get; private set; }
        public int GatewayCount { get; private set; }

        public string Runtime => DesignArtifactRuntimes.MapGateway;

        public bool Supports(string artifactType, string operation) => true;

        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
            DesignArtifactRun run,
            string? currentHtml,
            [EnumeratorCancellation] CancellationToken ct)
        {
            // These counters model the first external effects inside both concrete
            // executors: workspace prepare/upload, CDS session creation, and Gateway dispatch.
            PrepareCount++;
            CreateSessionCount++;
            GatewayCount++;
            await Task.Yield();
            yield return new DesignArtifactExecutorChunk("delta", "ok");
        }
    }
}
