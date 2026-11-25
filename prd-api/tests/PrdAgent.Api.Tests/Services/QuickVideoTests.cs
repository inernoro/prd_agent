using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Api.Services.QuickCreate;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class QuickVideoTests
{
    [Fact]
    public void QuickCreateAdmissionPermitsWritingAndSpeech()
    {
        var policy = Assert.IsType<TaskAdmissionPolicy>(TaskAdmissionPolicies.Find("PrdAgent.Api.Controllers.Api.QuickCreateController", "Create"));
        Assert.Equal(new[] { AppCallerRegistry.Admin.WebHosting.GenerateHtml, AppCallerRegistry.McpSpeech.Synthesize }, policy.AppCallers);
        Assert.Equal(4, policy.InteractiveMaxCalls);
        Assert.Equal(4, policy.AgentMaxCalls);
    }

    [Fact]
    public void SourceExcerptMustComeFromTheSubmittedDocument()
    {
        const string article = "架构决策记录包括背景、决定和后果。保留理由以便交接。";
        const string scene = """{"heading":"决策","note":"保留理由","narration":"写清背景、决定和后果。","source_excerpt":"记录包括背景、决定和后果"}""";
        var script = $$"""{"scenes":[{{scene}},{{scene}},{{scene}}]}""";
        Assert.Equal(3, QuickVideoRenderer.ParseScenes(script, article).Count);
        Assert.Throws<FormatException>(() => QuickVideoRenderer.ParseScenes(script, "这是完全不同的原文内容。"));
    }

    [Fact]
    public async Task ThirtyIndependentAuthors_AreClaimedOnceAndRemainScopeIsolated()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION");
        if (string.IsNullOrWhiteSpace(connection)) return;
        var databaseName = "test_quick_video_claim_" + Guid.NewGuid().ToString("N");
        var mongo = new MongoClient(connection);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["MongoDB:ConnectionString"] = connection,
            ["MongoDB:DatabaseName"] = databaseName,
        }).Build();
        var db = new MongoDbContext(connection, databaseName);
        await using var provider = new ServiceCollection().BuildServiceProvider();
        using var first = new QuickVideoWorker(db, provider.GetRequiredService<IServiceScopeFactory>(),
            Mock.Of<IAssetStorage>(), NullLogger<QuickVideoWorker>.Instance, configuration) { QueueDeploymentScope = "quick-test" };
        using var second = new QuickVideoWorker(db, provider.GetRequiredService<IServiceScopeFactory>(),
            Mock.Of<IAssetStorage>(), NullLogger<QuickVideoWorker>.Instance, configuration) { QueueDeploymentScope = "quick-test" };

        try
        {
            var work = Enumerable.Range(1, 30).Select(i => new QuickVideoRun
            {
                Id = $"job-{i}", OwnerUserId = $"author-{i}", DeploymentSlug = "quick-test",
                TemplateId = "sketchnote", ArticleTitle = $"稿件 {i}", ArticleMarkdown = "提交的原稿内容。",
            }).ToList();
            work.Add(new QuickVideoRun { Id = "other-scope", OwnerUserId = "another-author", DeploymentSlug = "other" });
            await db.QuickVideoRuns.InsertManyAsync(work);
            var claimed = await Task.WhenAll(Enumerable.Range(0, 30)
                .Select(i => (i % 2 == 0 ? first : second).ClaimQueuedTemplateRunAsync(default)));

            Assert.All(claimed, run =>
            {
                Assert.NotNull(run);
                Assert.Equal(QuickVideoStatus.Running, run.Status);
                Assert.Equal("scripting", run.CurrentPhase);
                Assert.NotNull(run.LeaseUntil);
            });
            Assert.Equal(30, claimed.Select(run => run!.Id).Distinct().Count());
            Assert.Null(await first.ClaimQueuedTemplateRunAsync(default));
            var untouched = await db.QuickVideoRuns.Find(run => run.Id == "other-scope").SingleAsync();
            Assert.Equal(QuickVideoStatus.Queued, untouched.Status);
        }
        finally
        {
            await mongo.DropDatabaseAsync(databaseName);
        }
    }
}
