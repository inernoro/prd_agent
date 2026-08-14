using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class StalledTranscriptionRunRecoveryTests
{
    [Fact]
    public async Task Reaper_ShouldOnlyTerminateMatchingStalledRuns_ThenAllowNewRun()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = new DateTime(2026, 8, 14, 12, 0, 0, DateTimeKind.Utc);
        var runs = fixture.Db.DocumentStoreAgentRuns;
        var candidates = new[]
        {
            Run("stale-self", "entry-1", "user-1", "self", now.AddHours(-2), now.AddHours(-2)),
            Run("stale-unowned", "entry-1", "user-1", null, now.AddHours(-2), null, DocumentStoreRunStatus.Queued),
            Run("fresh-heartbeat", "entry-1", "user-1", "self", now.AddHours(-3), now.AddMinutes(-1)),
            Run("scheduled-retry", "entry-1", "user-1", "self", now.AddHours(-3), null, DocumentStoreRunStatus.Queued),
            Run("expired-retry", "entry-1", "user-1", "self", now.AddHours(-3), null, DocumentStoreRunStatus.Queued),
            Run("other-user", "entry-1", "user-2", "self", now.AddHours(-2), now.AddHours(-2)),
            Run("other-style", "entry-1", "user-1", "self", now.AddHours(-2), now.AddHours(-2), templateKey: "meeting"),
            Run("foreign-owner", "entry-1", "user-1", "other", now.AddHours(-2), now.AddHours(-2)),
        };
        candidates.Single(r => r.Id == "scheduled-retry").AutomaticRetryNextAt = now.AddMinutes(5);
        candidates.Single(r => r.Id == "expired-retry").AutomaticRetryNextAt = now.AddHours(-2);
        await runs.InsertManyAsync(candidates);

        var reaped = await StalledTranscriptionRunRecovery.ReapAsync(
            runs,
            "entry-1",
            "user-1",
            null,
            null,
            null,
            ["self"],
            now,
            CancellationToken.None);

        reaped.ShouldBe(3);
        (await runs.Find(r => r.Id == "stale-self").SingleAsync()).Status
            .ShouldBe(DocumentStoreRunStatus.Failed);
        (await runs.Find(r => r.Id == "stale-unowned").SingleAsync()).FailureCode
            .ShouldBe(StalledTranscriptionRunRecovery.FailureCode);
        foreach (var id in new[] { "fresh-heartbeat", "scheduled-retry", "other-user", "other-style", "foreign-owner" })
        {
            var preserved = await runs.Find(r => r.Id == id).SingleAsync();
            preserved.Status.ShouldBe(id == "scheduled-retry"
                ? DocumentStoreRunStatus.Queued
                : DocumentStoreRunStatus.Running);
        }

        var replacement = Run(
            "replacement",
            "entry-1",
            "user-1",
            "self",
            now,
            null,
            DocumentStoreRunStatus.Queued);
        await runs.InsertOneAsync(replacement);
        replacement.Id.ShouldNotBe("stale-self");
        (await runs.Find(r => r.Id == "replacement").AnyAsync()).ShouldBeTrue();
    }

    [Fact]
    public async Task OutputLease_ShouldSerializeReaperAgainstWorkerTerminalWrite()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var run = Run("run-1", "entry-1", "user-1", "self", now.AddHours(-2), now.AddHours(-2));
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        var workerLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            "entry-1",
            DocumentStoreAgentRunKind.Transcribe,
            CancellationToken.None);
        var reaperTask = Task.Run(async () =>
        {
            await using var reaperLease = await DocumentStoreRunOutputLease.AcquireAsync(
                fixture.Db,
                "entry-1",
                DocumentStoreAgentRunKind.Transcribe,
                CancellationToken.None);
            return await StalledTranscriptionRunRecovery.ReapAsync(
                fixture.Db.DocumentStoreAgentRuns,
                "entry-1",
                "user-1",
                null,
                null,
                null,
                ["self"],
                now,
                CancellationToken.None);
        });

        await Task.Delay(250);
        reaperTask.IsCompleted.ShouldBeFalse();
        await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id && r.Status == DocumentStoreRunStatus.Running,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.Status, DocumentStoreRunStatus.Done)
                .Set(r => r.EndedAt, now));
        await workerLease.DisposeAsync();

        (await reaperTask).ShouldBe(0);
        (await fixture.Db.DocumentStoreAgentRuns.Find(r => r.Id == run.Id).SingleAsync()).Status
            .ShouldBe(DocumentStoreRunStatus.Done);
    }

    [Fact]
    public async Task OutputLease_ShouldFailClosedAfterExpiredHolderIsReplaced()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var oldLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            "entry-expired-lease",
            DocumentStoreAgentRunKind.Transcribe,
            CancellationToken.None,
            leaseDuration: TimeSpan.FromMilliseconds(150),
            renewalInterval: TimeSpan.FromSeconds(5),
            acquireTimeout: TimeSpan.FromSeconds(2));

        await Task.Delay(250);
        await using var replacementLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            "entry-expired-lease",
            DocumentStoreAgentRunKind.Transcribe,
            CancellationToken.None,
            leaseDuration: TimeSpan.FromSeconds(5),
            renewalInterval: TimeSpan.FromSeconds(1),
            acquireTimeout: TimeSpan.FromSeconds(2));

        await Should.ThrowAsync<DocumentStoreRunLeaseLostException>(() =>
            oldLease.EnsureHeldAsync(CancellationToken.None));
        oldLease.IsLost.ShouldBeTrue();
        oldLease.LostToken.IsCancellationRequested.ShouldBeTrue();
        await oldLease.DisposeAsync();

        // 旧 holder 释放时只能按自己的 owner 删除，不能误删 replacement 的租约。
        await replacementLease.EnsureHeldAsync(CancellationToken.None);
        replacementLease.IsLost.ShouldBeFalse();
    }

    [Fact]
    public async Task OutputGeneration_ShouldFenceOldWorkerAfterStalledRunWasReplaced()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var entry = new DocumentEntry
        {
            Id = "entry-1",
            StoreId = "store-1",
            Title = "录音.m4a",
            AgentOutputGeneration = 0,
        };
        var run = Run("run-old", entry.Id, "user-1", "self", now.AddHours(-2), now.AddHours(-2));
        run.OutputGeneration = 0;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        await using (var reaperLease = await DocumentStoreRunOutputLease.AcquireAsync(
                         fixture.Db,
                         entry.Id,
                         DocumentStoreAgentRunKind.Transcribe,
                         CancellationToken.None))
        {
            (await StalledTranscriptionRunRecovery.ReapAsync(
                fixture.Db.DocumentStoreAgentRuns,
                entry.Id,
                run.UserId,
                null,
                null,
                null,
                ["self"],
                now,
                CancellationToken.None)).ShouldBe(1);
            await fixture.Db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                Builders<DocumentEntry>.Update.Inc(e => e.AgentOutputGeneration, 1));
        }

        await using var staleWorkerLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            DocumentStoreAgentRunKind.Transcribe,
            CancellationToken.None);
        var staleWrite = await fixture.Db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entry.Id && e.AgentOutputGeneration == run.OutputGeneration,
            Builders<DocumentEntry>.Update.Set(e => e.ContentIndex, "旧任务不应写入"));

        staleWrite.MatchedCount.ShouldBe(0);
        (await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync()).ContentIndex
            .ShouldBeNull();
    }

    [Fact]
    public async Task GenerationPublisher_ShouldRollbackWhenRunInsertDefinitelyFails()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = new DocumentEntry
        {
            Id = "entry-publish-rollback",
            StoreId = "store-1",
            Title = "录音.m4a",
            AgentOutputGeneration = 7,
        };
        var run = Run(
            "run-publish-rollback",
            entry.Id,
            "user-1",
            "self",
            DateTime.UtcNow,
            null,
            DocumentStoreRunStatus.Queued);
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);

        await Should.ThrowAsync<InvalidOperationException>(() =>
            DocumentStoreRunGenerationPublisher.PublishAsync(
                fixture.Db,
                entry.Id,
                run,
                CancellationToken.None,
                (_, _) => throw new InvalidOperationException("injected insert failure")));

        var persistedEntry = await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        persistedEntry.AgentOutputGeneration.ShouldBe(7);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(r => r.Id == run.Id)).ShouldBe(0);
    }

    [Fact]
    public async Task GenerationPublisher_ShouldAcceptUnknownInsertOutcomeWhenRunExists()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = new DocumentEntry
        {
            Id = "entry-publish-unknown",
            StoreId = "store-1",
            Title = "录音.m4a",
            AgentOutputGeneration = 3,
        };
        var run = Run(
            "run-publish-unknown",
            entry.Id,
            "user-1",
            "self",
            DateTime.UtcNow,
            null,
            DocumentStoreRunStatus.Queued);
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);

        var published = await DocumentStoreRunGenerationPublisher.PublishAsync(
            fixture.Db,
            entry.Id,
            run,
            CancellationToken.None,
            async (candidate, token) =>
            {
                await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(
                    candidate,
                    cancellationToken: token);
                throw new TimeoutException("injected unknown result");
            });

        published.ShouldNotBeNull();
        published.AgentOutputGeneration.ShouldBe(4);
        (await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(4);
        (await fixture.Db.DocumentStoreAgentRuns.Find(r => r.Id == run.Id).SingleAsync())
            .OutputGeneration.ShouldBe(4);
    }

    [Fact]
    public async Task SupersededRun_ShouldImmediatelyBecomeTerminal_ExactlyOnce()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var run = Run("run-old", "entry-1", "user-1", "self", now, now);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        (await DocumentStoreAgentWorker.TryMarkSupersededAsync(
            fixture.Db.DocumentStoreAgentRuns,
            run,
            now,
            CancellationToken.None)).ShouldBeTrue();
        (await DocumentStoreAgentWorker.TryMarkSupersededAsync(
            fixture.Db.DocumentStoreAgentRuns,
            run,
            now.AddSeconds(1),
            CancellationToken.None)).ShouldBeFalse();

        var terminal = await fixture.Db.DocumentStoreAgentRuns.Find(r => r.Id == run.Id).SingleAsync();
        terminal.Status.ShouldBe(DocumentStoreRunStatus.Failed);
        terminal.FailureCode.ShouldBe("TRANSCRIPTION_RUN_SUPERSEDED");
        terminal.HeartbeatAt.ShouldBeNull();
        terminal.EndedAt.ShouldNotBeNull();
        terminal.EndedAt.Value.ShouldBe(now, TimeSpan.FromMilliseconds(1));
    }

    [Fact]
    public async Task ReclaimedSameRun_ShouldAssignNewGenerationAndFenceStaleExecutionFromAllWrites()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        const string owner = "prd-agent:test::main";
        var entry = new DocumentEntry
        {
            Id = "entry-same-run-reclaim",
            StoreId = "store-1",
            Title = "录音.m4a",
            AgentOutputGeneration = 7,
            ContentIndex = "新执行认领前的正文",
        };
        var staleExecution = Run(
            "recording-archive-transcribe-same-run-reclaim",
            entry.Id,
            "user-1",
            owner,
            now.AddMinutes(-5),
            now.AddMinutes(-5));
        staleExecution.ExecutionId = "execution-old";
        staleExecution.OutputGeneration = entry.AgentOutputGeneration;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(staleExecution);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = "test",
                ["Deployment:Identity"] = "prd-agent:test",
                ["Changelog:GitHubBranch"] = "main",
            })
            .Build();
        var services = new ServiceCollection()
            .AddSingleton(fixture.Db)
            .AddSingleton<IConfiguration>(configuration)
            .BuildServiceProvider();
        var worker = new DocumentStoreAgentWorker(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<DocumentStoreAgentWorker>.Instance);

        await worker.RecoverInterruptedRunsAsync();
        var requeued = await fixture.Db.DocumentStoreAgentRuns
            .Find(run => run.Id == staleExecution.Id)
            .SingleAsync();
        requeued.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        requeued.ExecutionId.ShouldBeEmpty();
        requeued.OutputGeneration.ShouldBe(staleExecution.OutputGeneration + 1);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(requeued.OutputGeneration);

        const string newExecutionId = "execution-new";
        var reclaimWrite = await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            run => run.Id == staleExecution.Id && run.Status == DocumentStoreRunStatus.Queued,
            Builders<DocumentStoreAgentRun>.Update
                .Set(run => run.Status, DocumentStoreRunStatus.Running)
                .Set(run => run.ExecutionId, newExecutionId)
                .Set(run => run.StartedAt, now)
                .Set(run => run.HeartbeatAt, now));
        reclaimWrite.ModifiedCount.ShouldBe(1);
        var reclaimed = await fixture.Db.DocumentStoreAgentRuns
            .Find(run => run.Id == staleExecution.Id)
            .SingleAsync();
        reclaimed.OutputGeneration.ShouldBe(requeued.OutputGeneration);

        (await DocumentStoreAgentWorker.TryRenewHeartbeatAsync(
            fixture.Db.DocumentStoreAgentRuns,
            staleExecution.Id,
            staleExecution.ExecutionId,
            now.AddSeconds(1),
            CancellationToken.None)).ShouldBeFalse();
        (await DocumentStoreAgentWorker.TryRenewHeartbeatAsync(
            fixture.Db.DocumentStoreAgentRuns,
            reclaimed.Id,
            reclaimed.ExecutionId,
            now.AddSeconds(2),
            CancellationToken.None)).ShouldBeTrue();

        await using (var staleOutputLease = await DocumentStoreRunOutputLease.AcquireAsync(
                         fixture.Db,
                         entry.Id,
                         DocumentStoreAgentRunKind.Transcribe,
                         CancellationToken.None))
        {
            await Should.ThrowAsync<DocumentStoreRunLeaseLostException>(() =>
                DocumentStoreAgentWorker.EnsureCurrentExecutionAsync(
                    fixture.Db.DocumentStoreAgentRuns,
                    staleExecution,
                    CancellationToken.None));
        }
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .ContentIndex.ShouldBe("新执行认领前的正文");

        const string replacementNote = "# 转录全文\n\n新执行发布的正文";
        const string staleNote = "# 转录全文\n\n旧执行迟到的正文";
        var documents = new Dictionary<string, ParsedPrd>(StringComparer.Ordinal);
        var documentService = new Mock<IDocumentService>();
        documentService.Setup(service => service.GetByIdAsync(It.IsAny<string>()))
            .ReturnsAsync((string id) => documents.GetValueOrDefault(id));
        documentService.Setup(service => service.ParseAsync(It.IsAny<string>()))
            .ReturnsAsync((string content) => Parsed(ContentId(content), content));
        documentService.Setup(service => service.SaveAsync(It.IsAny<ParsedPrd>()))
            .ReturnsAsync((ParsedPrd document) =>
            {
                documents[document.Id] = document;
                return document;
            });
        var apply = new ContentReprocessApplyService(
            documentService.Object,
            new DocumentStoreAssetNormalizer(
                new NullAssetStorage(),
                NullLogger<DocumentStoreAssetNormalizer>.Instance),
            new DocumentVersionService(fixture.Db),
            NullLogger<ContentReprocessApplyService>.Instance);
        var replacementEntry = await fixture.Db.DocumentEntries
            .Find(item => item.Id == entry.Id)
            .SingleAsync();
        await apply.SaveContentAsync(
            replacementEntry,
            replacementNote,
            reclaimed.UserId,
            fixture.Db,
            expectedOutputGeneration: reclaimed.OutputGeneration);
        await Should.ThrowAsync<DocumentStoreRunLeaseLostException>(() => apply.SaveContentAsync(
            entry,
            staleNote,
            staleExecution.UserId,
            fixture.Db,
            expectedOutputGeneration: staleExecution.OutputGeneration));
        var publishedEntry = await fixture.Db.DocumentEntries
            .Find(item => item.Id == entry.Id)
            .SingleAsync();
        publishedEntry.DocumentId.ShouldBe(ContentId(replacementNote));
        documents[publishedEntry.DocumentId!].RawContent.ShouldBe(replacementNote);

        var staleProgress = await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            DocumentStoreAgentWorker.CurrentExecutionFilter(staleExecution),
            Builders<DocumentStoreAgentRun>.Update.Set(run => run.Progress, 90));
        staleProgress.MatchedCount.ShouldBe(0);
        (await DocumentStoreAgentWorker.TryMarkSupersededAsync(
            fixture.Db.DocumentStoreAgentRuns,
            staleExecution,
            now.AddSeconds(3),
            CancellationToken.None)).ShouldBeFalse();
        var staleTerminal = await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            DocumentStoreAgentWorker.CurrentExecutionFilter(staleExecution),
            Builders<DocumentStoreAgentRun>.Update.Set(run => run.Status, DocumentStoreRunStatus.Done));
        staleTerminal.MatchedCount.ShouldBe(0);

        var newTerminal = await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            DocumentStoreAgentWorker.CurrentExecutionFilter(reclaimed),
            Builders<DocumentStoreAgentRun>.Update
                .Set(run => run.Status, DocumentStoreRunStatus.Done)
                .Set(run => run.EndedAt, now.AddSeconds(4)));
        newTerminal.ModifiedCount.ShouldBe(1);
        var terminal = await fixture.Db.DocumentStoreAgentRuns
            .Find(run => run.Id == staleExecution.Id)
            .SingleAsync();
        terminal.Status.ShouldBe(DocumentStoreRunStatus.Done);
        terminal.ExecutionId.ShouldBe(newExecutionId);
        terminal.FailureCode.ShouldBeNull();
    }

    [Fact]
    public async Task RestyleWrite_ShouldNotOverwriteNewTranscriptPublishedByLaterGeneration()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        const string oldNote = "# 摘要\n\n旧摘要\n\n# 转录全文\n\n旧原文";
        const string newNote = "# 摘要\n\n新摘要\n\n# 转录全文\n\n新原文";
        const string staleRestyle = "# 摘要\n\n迟到的旧整理\n\n# 转录全文\n\n旧原文";
        var staleEntry = new DocumentEntry
        {
            Id = "entry-restyle",
            StoreId = "store-1",
            Title = "录音笔记",
            DocumentId = "doc-old",
            AgentOutputGeneration = 0,
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(staleEntry);

        var documents = new Dictionary<string, ParsedPrd>(StringComparer.Ordinal)
        {
            ["doc-old"] = Parsed("doc-old", oldNote),
        };
        var documentService = new Mock<IDocumentService>();
        documentService.Setup(service => service.GetByIdAsync(It.IsAny<string>()))
            .ReturnsAsync((string id) => documents.GetValueOrDefault(id));
        documentService.Setup(service => service.ParseAsync(It.IsAny<string>()))
            .ReturnsAsync((string content) => Parsed(ContentId(content), content));
        documentService.Setup(service => service.SaveAsync(It.IsAny<ParsedPrd>()))
            .ReturnsAsync((ParsedPrd document) =>
            {
                documents[document.Id] = document;
                return document;
            });
        var apply = new ContentReprocessApplyService(
            documentService.Object,
            new DocumentStoreAssetNormalizer(
                new NullAssetStorage(),
                NullLogger<DocumentStoreAssetNormalizer>.Instance),
            new DocumentVersionService(fixture.Db),
            NullLogger<ContentReprocessApplyService>.Instance);

        var currentEntry = await fixture.Db.DocumentEntries.FindOneAndUpdateAsync(
            Builders<DocumentEntry>.Filter.Eq(entry => entry.Id, staleEntry.Id),
            Builders<DocumentEntry>.Update.Inc(entry => entry.AgentOutputGeneration, 1),
            new FindOneAndUpdateOptions<DocumentEntry, DocumentEntry> { ReturnDocument = ReturnDocument.After });
        currentEntry.ShouldNotBeNull();
        await apply.SaveContentAsync(
            currentEntry,
            newNote,
            "user-1",
            fixture.Db,
            expectedOutputGeneration: currentEntry.AgentOutputGeneration);

        await Should.ThrowAsync<DocumentStoreRunLeaseLostException>(() => apply.SaveContentAsync(
            staleEntry,
            staleRestyle,
            "user-1",
            fixture.Db,
            expectedOutputGeneration: staleEntry.AgentOutputGeneration));

        var published = await fixture.Db.DocumentEntries
            .Find(entry => entry.Id == staleEntry.Id)
            .SingleAsync();
        published.AgentOutputGeneration.ShouldBe(1);
        published.DocumentId.ShouldBe(ContentId(newNote));
        published.DocumentId.ShouldNotBeNull();
        documents[published.DocumentId!].RawContent.ShouldBe(newNote);
    }

    [Fact]
    public async Task PublishedTranscript_ShouldRemainSuccessfulWhenVersionSnapshotFails()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        const string oldNote = "# 转录全文\n\n旧原文";
        const string newNote = "# 转录全文\n\n新原文";
        var entry = new DocumentEntry
        {
            Id = "entry-snapshot-failure",
            StoreId = "store-1",
            Title = "录音笔记",
            DocumentId = "doc-old",
            AgentOutputGeneration = 1,
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);

        var documents = new Dictionary<string, ParsedPrd>(StringComparer.Ordinal)
        {
            ["doc-old"] = Parsed("doc-old", oldNote),
        };
        var documentService = new Mock<IDocumentService>();
        documentService.Setup(service => service.GetByIdAsync(It.IsAny<string>()))
            .ReturnsAsync((string id) => documents.GetValueOrDefault(id));
        documentService.Setup(service => service.ParseAsync(It.IsAny<string>()))
            .ReturnsAsync((string content) => Parsed(ContentId(content), content));
        documentService.Setup(service => service.SaveAsync(It.IsAny<ParsedPrd>()))
            .ReturnsAsync((ParsedPrd document) =>
            {
                documents[document.Id] = document;
                return document;
            });
        var snapshots = new FailingVersionSnapshotWriter();
        var apply = new ContentReprocessApplyService(
            documentService.Object,
            new DocumentStoreAssetNormalizer(
                new NullAssetStorage(),
                NullLogger<DocumentStoreAssetNormalizer>.Instance),
            snapshots,
            NullLogger<ContentReprocessApplyService>.Instance);

        await apply.SaveContentAsync(
            entry,
            newNote,
            "user-1",
            fixture.Db,
            expectedOutputGeneration: entry.AgentOutputGeneration);

        snapshots.Attempts.ShouldBe(2);
        var published = await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        published.DocumentId.ShouldBe(ContentId(newNote));
        documents[published.DocumentId!].RawContent.ShouldBe(newNote);
    }

    [Fact]
    public async Task InterruptedRecovery_ShouldHandleStoreLevelRunWithoutStarvingEntryRuns()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var owner = "prd-agent:test::main";
        var autoLink = Run(
            "stale-autolink",
            string.Empty,
            "user-1",
            owner,
            now.AddMinutes(-5),
            now.AddMinutes(-5));
        autoLink.Kind = DocumentStoreAgentRunKind.AutoLink;
        var transcription = Run(
            "stale-transcribe",
            "entry-1",
            "user-1",
            owner,
            now.AddMinutes(-5),
            now.AddMinutes(-5));
        await fixture.Db.DocumentStoreAgentRuns.InsertManyAsync([autoLink, transcription]);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = "test",
                ["Deployment:Identity"] = "prd-agent:test",
                ["Changelog:GitHubBranch"] = "main",
            })
            .Build();
        var services = new ServiceCollection()
            .AddSingleton(fixture.Db)
            .AddSingleton<IConfiguration>(configuration)
            .BuildServiceProvider();
        var worker = new DocumentStoreAgentWorker(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<DocumentStoreAgentWorker>.Instance);

        await worker.RecoverInterruptedRunsAsync();

        (await fixture.Db.DocumentStoreAgentRuns.Find(run => run.Id == autoLink.Id).SingleAsync())
            .FailureCode.ShouldBe("WORKER_INTERRUPTED");
        (await fixture.Db.DocumentStoreAgentRuns.Find(run => run.Id == transcription.Id).SingleAsync())
            .FailureCode.ShouldBe("WORKER_INTERRUPTED");
    }

    private static ParsedPrd Parsed(string id, string content)
        => new()
        {
            Id = id,
            Title = "录音笔记",
            RawContent = content,
            CharCount = content.Length,
        };

    private static string ContentId(string content)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    private static DocumentStoreAgentRun Run(
        string id,
        string entryId,
        string userId,
        string? owner,
        DateTime createdAt,
        DateTime? heartbeatAt,
        string status = DocumentStoreRunStatus.Running,
        string? templateKey = null)
        => new()
        {
            Id = id,
            Kind = DocumentStoreAgentRunKind.Transcribe,
            SourceEntryId = entryId,
            StoreId = "store-1",
            UserId = userId,
            OwnerInstanceId = owner,
            ExecutionId = status == DocumentStoreRunStatus.Running ? "execution-1" : string.Empty,
            Status = status,
            TemplateKey = templateKey,
            CreatedAt = createdAt,
            StartedAt = status == DocumentStoreRunStatus.Running ? createdAt : null,
            HeartbeatAt = heartbeatAt,
        };

    private sealed class RecordingRunMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private RecordingRunMongoFixture(
            MongoClient client,
            string connectionString,
            string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<RecordingRunMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new RecordingRunMongoFixture(
                client,
                connectionString,
                $"recording_run_recovery_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync()
            => await _client.DropDatabaseAsync(_databaseName);
    }

    private sealed class FailingVersionSnapshotWriter : IDocumentVersionSnapshotWriter
    {
        internal int Attempts { get; private set; }

        public Task<DocumentEntryVersion?> SnapshotAsync(
            string entryId,
            string storeId,
            string content,
            string source,
            string userId,
            string? userName,
            string? restoredFromVersionId = null,
            CancellationToken ct = default)
        {
            Attempts++;
            return Task.FromException<DocumentEntryVersion?>(
                new InvalidOperationException("injected snapshot failure"));
        }
    }
}
