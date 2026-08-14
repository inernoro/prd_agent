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
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None);

        await Should.ThrowAsync<InvalidOperationException>(() =>
            DocumentStoreRunGenerationPublisher.PublishAsync(
                fixture.Db,
                entry.Id,
                run,
                outputLease,
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
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None);

        var published = await DocumentStoreRunGenerationPublisher.PublishAsync(
            fixture.Db,
            entry.Id,
            run,
            outputLease,
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
    public async Task GenerationPublisher_InsertAndReadbackFailure_ShouldNotAdvanceGeneration()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-publish-double-failure", 7);
        var run = Run(
            "run-publish-double-failure",
            entry.Id,
            "user-1",
            "self",
            DateTime.UtcNow,
            null,
            DocumentStoreRunStatus.Queued);
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None);

        var error = await Should.ThrowAsync<InvalidOperationException>(() =>
            DocumentStoreRunGenerationPublisher.PublishAsync(
                fixture.Db,
                entry.Id,
                run,
                outputLease,
                CancellationToken.None,
                (_, _) => throw new TimeoutException("injected marker insert failure"),
                (_, _) => throw new TimeoutException("injected marker readback failure")));

        error.Message.ShouldContain("正文代次尚未推进");
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(7);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(item => item.Id == run.Id))
            .ShouldBe(0);
    }

    [Fact]
    public async Task PendingCreation_MarkerCommittedButClientAndReadbackFailed_ShouldReconcileAfterRestart()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-publish-marker-unknown", 3);
        var run = Run(
            "run-publish-marker-unknown",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            DateTime.UtcNow,
            null,
            DocumentStoreRunStatus.Queued);
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);

        await using (var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
                         fixture.Db,
                         entry.Id,
                         run.Kind,
                         CancellationToken.None))
        {
            await Should.ThrowAsync<InvalidOperationException>(() =>
                DocumentStoreRunGenerationPublisher.PublishAsync(
                    fixture.Db,
                    entry.Id,
                    run,
                    outputLease,
                    CancellationToken.None,
                    async (candidate, token) =>
                    {
                        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(
                            candidate,
                            cancellationToken: token);
                        throw new TimeoutException("injected marker response loss");
                    },
                    (_, _) => throw new TimeoutException("injected marker readback outage")));

            (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
                .AgentOutputGeneration.ShouldBe(3);
            var marker = await fixture.Db.DocumentStoreAgentRuns
                .Find(item => item.Id == run.Id)
                .SingleAsync();
            marker.Status.ShouldBe(DocumentStoreRunStatus.Publishing);
            marker.OutputGeneration.ShouldBe(3);
            (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(
                    item => item.Id == run.Id && item.Status == DocumentStoreRunStatus.Queued))
                .ShouldBe(0);
        }

        await CreateRecoveryWorker(fixture).RecoverPendingRunCreationsAsync();

        var recovered = await fixture.Db.DocumentStoreAgentRuns
            .Find(item => item.Id == run.Id)
            .SingleAsync();
        recovered.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        recovered.OutputGeneration.ShouldBe(4);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(4);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(item => item.Id == run.Id))
            .ShouldBe(1);
    }

    [Fact]
    public async Task PendingCreation_AfterGenerationAdvanced_ShouldFinalizeOnceWithoutSecondIncrement()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-publish-resume-after-generation", 6);
        var marker = Run(
            "run-publish-resume-after-generation",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            DateTime.UtcNow,
            null,
            DocumentStoreRunStatus.Publishing);
        marker.OutputGeneration = 5;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(marker);
        var worker = CreateRecoveryWorker(fixture);

        await worker.RecoverPendingRunCreationsAsync();
        await worker.RecoverPendingRunCreationsAsync();

        var recovered = await fixture.Db.DocumentStoreAgentRuns
            .Find(item => item.Id == marker.Id)
            .SingleAsync();
        recovered.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        recovered.OutputGeneration.ShouldBe(6);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(6);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(item => item.Id == marker.Id))
            .ShouldBe(1);
    }

    [Fact]
    public async Task PendingRestyleCreation_AfterWorkerReconciles_ShouldReuseSameRunOnHttpRetry()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-publish-restyle-retry", 4);
        var firstRun = Run(
            "run-publish-restyle-original",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            DateTime.UtcNow,
            null,
            DocumentStoreRunStatus.Queued,
            "meeting");
        firstRun.RestyleOfRunId = "prior-transcribe-run";
        firstRun.StyleContext = "参会人：甲、乙";
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);

        await using (var firstLease = await DocumentStoreRunOutputLease.AcquireAsync(
                         fixture.Db,
                         entry.Id,
                         firstRun.Kind,
                         CancellationToken.None))
        {
            await Should.ThrowAsync<InvalidOperationException>(() =>
                DocumentStoreRunGenerationPublisher.PublishAsync(
                    fixture.Db,
                    entry.Id,
                    firstRun,
                    firstLease,
                    CancellationToken.None,
                    async (candidate, token) =>
                    {
                        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(
                            candidate,
                            cancellationToken: token);
                        throw new TimeoutException("injected restyle marker response loss");
                    },
                    (_, _) => throw new TimeoutException("injected restyle marker readback outage")));
        }

        await CreateRecoveryWorker(fixture).RecoverPendingRunCreationsAsync();
        var retryRun = Run(
            "run-publish-restyle-http-retry",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            DateTime.UtcNow.AddSeconds(1),
            null,
            DocumentStoreRunStatus.Queued,
            "meeting");
        retryRun.RestyleOfRunId = firstRun.RestyleOfRunId;
        retryRun.StyleContext = firstRun.StyleContext;
        await using var retryLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            retryRun.Kind,
            CancellationToken.None);

        var published = await DocumentStoreRunGenerationPublisher.PublishAsync(
            fixture.Db,
            entry.Id,
            retryRun,
            retryLease,
            CancellationToken.None);

        published.ShouldNotBeNull();
        retryRun.Id.ShouldBe(firstRun.Id);
        retryRun.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        retryRun.OutputGeneration.ShouldBe(5);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(5);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(
                item => item.SourceEntryId == entry.Id && item.RestyleOfRunId == firstRun.RestyleOfRunId))
            .ShouldBe(1);
    }

    [Fact]
    public async Task RestyleRetry_ShouldNotReuseSameRequestFromSupersededGeneration()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-restyle-stale-retry", 6);
        var staleSameRequest = Run(
            "run-restyle-stale-same-request",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            DateTime.UtcNow.AddMinutes(-2),
            null,
            DocumentStoreRunStatus.Queued,
            "meeting");
        staleSameRequest.RestyleOfRunId = "prior-transcribe-run";
        staleSameRequest.StyleContext = "参会人：甲、乙";
        staleSameRequest.OutputGeneration = 5;
        var currentDifferentRequest = Run(
            "run-restyle-current-different-request",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            DateTime.UtcNow.AddMinutes(-1),
            null,
            DocumentStoreRunStatus.Queued,
            "summary");
        currentDifferentRequest.RestyleOfRunId = staleSameRequest.RestyleOfRunId;
        currentDifferentRequest.OutputGeneration = 6;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertManyAsync(
            [staleSameRequest, currentDifferentRequest]);

        var retry = Run(
            "run-restyle-current-retry",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            DateTime.UtcNow,
            null,
            DocumentStoreRunStatus.Queued,
            staleSameRequest.TemplateKey);
        retry.RestyleOfRunId = staleSameRequest.RestyleOfRunId;
        retry.StyleContext = staleSameRequest.StyleContext;
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            retry.Kind,
            CancellationToken.None);

        var published = await DocumentStoreRunGenerationPublisher.PublishAsync(
            fixture.Db,
            entry.Id,
            retry,
            outputLease,
            CancellationToken.None);

        published.ShouldNotBeNull();
        retry.Id.ShouldBe("run-restyle-current-retry");
        retry.Id.ShouldNotBe(staleSameRequest.Id);
        retry.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        retry.OutputGeneration.ShouldBe(7);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(7);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(
                item => item.SourceEntryId == entry.Id))
            .ShouldBe(3);
    }

    [Fact]
    public async Task RecoveryPublisher_ShouldRollbackWhenRunRequeueDefinitelyFails()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-recovery-rollback", 4);
        var run = Run("run-recovery-rollback", entry.Id, "user-1", "self", DateTime.UtcNow, DateTime.UtcNow);
        run.OutputGeneration = entry.AgentOutputGeneration;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None);

        await Should.ThrowAsync<InvalidOperationException>(() =>
            DocumentStoreRunGenerationPublisher.RequeueExistingAsync(
                fixture.Db,
                entry.Id,
                run,
                outputLease,
                "recovery-attempt-rollback",
                RecoveryRunFilter(run),
                RecoveryRunUpdate,
                CancellationToken.None,
                (_, _, _) => throw new InvalidOperationException("injected requeue failure")));

        var persistedEntry = await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync();
        persistedEntry.AgentOutputGeneration.ShouldBe(4);
        var persistedRun = await fixture.Db.DocumentStoreAgentRuns.Find(item => item.Id == run.Id).SingleAsync();
        persistedRun.Status.ShouldBe(DocumentStoreRunStatus.Running);
        persistedRun.OutputGeneration.ShouldBe(4);
        persistedRun.RecoveryAttemptId.ShouldBeEmpty();
        persistedRun.PendingRecoveryOutputGeneration.ShouldBeNull();
        persistedRun.AutomaticRetryCount.ShouldBe(0);
    }

    [Fact]
    public async Task RecoveryPublisher_ShouldAcceptUnknownOutcomeWhenRunRequeueLanded()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-recovery-unknown", 7);
        var run = Run("run-recovery-unknown", entry.Id, "user-1", "self", DateTime.UtcNow, DateTime.UtcNow);
        run.OutputGeneration = entry.AgentOutputGeneration;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None);

        var published = await DocumentStoreRunGenerationPublisher.RequeueExistingAsync(
            fixture.Db,
            entry.Id,
            run,
            outputLease,
            "recovery-attempt-unknown",
            RecoveryRunFilter(run),
            RecoveryRunUpdate,
            CancellationToken.None,
            async (filter, update, token) =>
            {
                await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
                    filter,
                    update,
                    cancellationToken: token);
                throw new TimeoutException("injected unknown requeue result");
            });

        published.ShouldNotBeNull();
        published.AgentOutputGeneration.ShouldBe(8);
        var persistedRun = await fixture.Db.DocumentStoreAgentRuns.Find(item => item.Id == run.Id).SingleAsync();
        persistedRun.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        persistedRun.OutputGeneration.ShouldBe(8);
        persistedRun.RecoveryAttemptId.ShouldBe("recovery-attempt-unknown");
        persistedRun.PendingRecoveryOutputGeneration.ShouldBeNull();
        persistedRun.AutomaticRetryCount.ShouldBe(1);
    }

    [Fact]
    public async Task RecoveryPublisher_ConditionalRollbackShouldNotOverwriteLaterGeneration()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-recovery-conflict", 2);
        var run = Run("run-recovery-conflict", entry.Id, "user-1", "self", DateTime.UtcNow, DateTime.UtcNow);
        run.OutputGeneration = entry.AgentOutputGeneration;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None);

        await Should.ThrowAsync<InvalidOperationException>(() =>
            DocumentStoreRunGenerationPublisher.RequeueExistingAsync(
                fixture.Db,
                entry.Id,
                run,
                outputLease,
                "recovery-attempt-conflict",
                RecoveryRunFilter(run),
                RecoveryRunUpdate,
                CancellationToken.None,
                async (_, _, token) =>
                {
                    await fixture.Db.DocumentEntries.UpdateOneAsync(
                        item => item.Id == entry.Id && item.AgentOutputGeneration == 3,
                        Builders<DocumentEntry>.Update.Set(item => item.AgentOutputGeneration, 4),
                        cancellationToken: token);
                    throw new TimeoutException("injected later generation");
                }));

        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(4);
        var persistedRun = await fixture.Db.DocumentStoreAgentRuns.Find(item => item.Id == run.Id).SingleAsync();
        persistedRun.Status.ShouldBe(DocumentStoreRunStatus.Running);
        persistedRun.OutputGeneration.ShouldBe(2);
        persistedRun.PendingRecoveryOutputGeneration.ShouldBe(3);
    }

    [Fact]
    public async Task RecoveryPublisher_ShouldResumePersistedAttemptAfterCrashBetweenWrites()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-recovery-resume", 6);
        var run = Run("run-recovery-resume", entry.Id, "user-1", "self", DateTime.UtcNow, DateTime.UtcNow);
        run.OutputGeneration = 5;
        run.RecoveryAttemptId = "recovery-attempt-resume";
        run.PendingRecoveryOutputGeneration = 6;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);
        await using var outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None);

        var published = await DocumentStoreRunGenerationPublisher.RequeueExistingAsync(
            fixture.Db,
            entry.Id,
            run,
            outputLease,
            run.RecoveryAttemptId,
            RecoveryRunFilter(run),
            RecoveryRunUpdate,
            CancellationToken.None);

        published.ShouldNotBeNull();
        published.AgentOutputGeneration.ShouldBe(6);
        var persistedRun = await fixture.Db.DocumentStoreAgentRuns.Find(item => item.Id == run.Id).SingleAsync();
        persistedRun.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        persistedRun.OutputGeneration.ShouldBe(6);
        persistedRun.PendingRecoveryOutputGeneration.ShouldBeNull();
        persistedRun.AutomaticRetryCount.ShouldBe(1);
    }

    [Fact]
    public async Task PendingRecovery_WithFreshHeartbeat_ShouldFenceOldExecutionAndStillRequeue()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var entry = RecoveryEntry("entry-pending-fresh-heartbeat", 9);
        var run = Run(
            "recording-archive-transcribe-pending-fresh-heartbeat",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            now,
            now);
        run.OutputGeneration = 8;
        run.RecoveryAttemptId = "recovery-attempt-fresh-heartbeat";
        run.PendingRecoveryOutputGeneration = 9;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        (await DocumentStoreAgentWorker.TryRenewHeartbeatAsync(
            fixture.Db.DocumentStoreAgentRuns,
            run.Id,
            run.ExecutionId,
            now.AddSeconds(15),
            CancellationToken.None)).ShouldBeFalse();
        (await fixture.Db.DocumentStoreAgentRuns
                .Find(DocumentStoreAgentWorker.CurrentExecutionFilter(run))
                .AnyAsync())
            .ShouldBeFalse();

        await CreateRecoveryWorker(fixture).RecoverInterruptedRunsAsync();

        var recovered = await fixture.Db.DocumentStoreAgentRuns
            .Find(item => item.Id == run.Id)
            .SingleAsync();
        recovered.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        recovered.OutputGeneration.ShouldBe(9);
        recovered.RecoveryAttemptId.ShouldBe("recovery-attempt-fresh-heartbeat");
        recovered.PendingRecoveryOutputGeneration.ShouldBeNull();
        recovered.ExecutionId.ShouldBeEmpty();
        recovered.AutomaticRetryCount.ShouldBe(1);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(recovered.OutputGeneration);
    }

    [Fact]
    public async Task PendingRecovery_AfterOldExecutionBecameTerminal_ShouldStillRequeue()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var now = DateTime.UtcNow;
        var entry = RecoveryEntry("entry-pending-terminal", 12);
        var run = Run(
            "recording-archive-transcribe-pending-terminal",
            entry.Id,
            "user-1",
            "prd-agent:test::main",
            now,
            null,
            DocumentStoreRunStatus.Failed);
        run.OutputGeneration = 11;
        run.RecoveryAttemptId = "recovery-attempt-terminal";
        run.PendingRecoveryOutputGeneration = 12;
        run.FailureCode = "TRANSCRIPTION_RUN_SUPERSEDED";
        run.ErrorMessage = "旧执行已终态";
        run.EndedAt = now;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        await CreateRecoveryWorker(fixture).RecoverInterruptedRunsAsync();

        var recovered = await fixture.Db.DocumentStoreAgentRuns
            .Find(item => item.Id == run.Id)
            .SingleAsync();
        recovered.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        recovered.OutputGeneration.ShouldBe(12);
        recovered.RecoveryAttemptId.ShouldBe("recovery-attempt-terminal");
        recovered.PendingRecoveryOutputGeneration.ShouldBeNull();
        recovered.ExecutionId.ShouldBeEmpty();
        recovered.FailureCode.ShouldBeNull();
        recovered.ErrorMessage.ShouldBeNull();
        recovered.EndedAt.ShouldBeNull();
        recovered.AutomaticRetryCount.ShouldBe(1);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(recovered.OutputGeneration);
    }

    [Fact]
    public async Task RecoveryPublisher_LostLeaseCannotRollbackReplacementAttempt()
    {
        await using var fixture = await RecordingRunMongoFixture.CreateAsync();
        var entry = RecoveryEntry("entry-recovery-lease-handoff", 3);
        var run = Run(
            "run-recovery-lease-handoff",
            entry.Id,
            "user-1",
            "self",
            DateTime.UtcNow,
            DateTime.UtcNow);
        run.OutputGeneration = entry.AgentOutputGeneration;
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        await using var staleLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None,
            leaseDuration: TimeSpan.FromMilliseconds(150),
            renewalInterval: TimeSpan.FromSeconds(5),
            acquireTimeout: TimeSpan.FromSeconds(1));
        var finalizeEntered = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFinalize = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var staleRecovery = DocumentStoreRunGenerationPublisher.RequeueExistingAsync(
            fixture.Db,
            entry.Id,
            run,
            staleLease,
            "recovery-attempt-lease-handoff",
            RecoveryRunFilter(run),
            RecoveryRunUpdate,
            CancellationToken.None,
            async (_, _, token) =>
            {
                finalizeEntered.TrySetResult(true);
                await releaseFinalize.Task.WaitAsync(token);
                return false;
            });

        await finalizeEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(TimeSpan.FromMilliseconds(250));
        await using var replacementLease = await DocumentStoreRunOutputLease.AcquireAsync(
            fixture.Db,
            entry.Id,
            run.Kind,
            CancellationToken.None,
            leaseDuration: TimeSpan.FromSeconds(5),
            renewalInterval: TimeSpan.FromSeconds(1),
            acquireTimeout: TimeSpan.FromSeconds(2));
        releaseFinalize.TrySetResult(true);

        await Should.ThrowAsync<DocumentStoreRunLeaseLostException>(() => staleRecovery);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(4);
        var pending = await fixture.Db.DocumentStoreAgentRuns
            .Find(item => item.Id == run.Id)
            .SingleAsync();
        pending.Status.ShouldBe(DocumentStoreRunStatus.Running);
        pending.OutputGeneration.ShouldBe(3);
        pending.PendingRecoveryOutputGeneration.ShouldBe(4);
        pending.AutomaticRetryCount.ShouldBe(0);

        var published = await DocumentStoreRunGenerationPublisher.RequeueExistingAsync(
            fixture.Db,
            entry.Id,
            pending,
            replacementLease,
            pending.RecoveryAttemptId,
            RecoveryRunFilter(pending),
            RecoveryRunUpdate,
            CancellationToken.None);

        published.ShouldNotBeNull();
        published.AgentOutputGeneration.ShouldBe(4);
        var recovered = await fixture.Db.DocumentStoreAgentRuns
            .Find(item => item.Id == run.Id)
            .SingleAsync();
        recovered.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        recovered.OutputGeneration.ShouldBe(4);
        recovered.PendingRecoveryOutputGeneration.ShouldBeNull();
        recovered.AutomaticRetryCount.ShouldBe(1);
        (await fixture.Db.DocumentEntries.Find(item => item.Id == entry.Id).SingleAsync())
            .AgentOutputGeneration.ShouldBe(recovered.OutputGeneration);
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

    private static DocumentEntry RecoveryEntry(string id, long generation)
        => new()
        {
            Id = id,
            StoreId = "store-1",
            Title = "录音.m4a",
            AgentOutputGeneration = generation,
        };

    private static FilterDefinition<DocumentStoreAgentRun> RecoveryRunFilter(DocumentStoreAgentRun run)
        => Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(item => item.Id, run.Id),
            Builders<DocumentStoreAgentRun>.Filter.Eq(item => item.Status, DocumentStoreRunStatus.Running),
            Builders<DocumentStoreAgentRun>.Filter.Eq(item => item.ExecutionId, run.ExecutionId));

    private static UpdateDefinition<DocumentStoreAgentRun> RecoveryRunUpdate(long generation)
        => Builders<DocumentStoreAgentRun>.Update
            .Set(item => item.Status, DocumentStoreRunStatus.Queued)
            .Set(item => item.ExecutionId, string.Empty)
            .Set(item => item.OutputGeneration, generation)
            .Inc(item => item.AutomaticRetryCount, 1);

    private static DocumentStoreAgentWorker CreateRecoveryWorker(RecordingRunMongoFixture fixture)
    {
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
        return new DocumentStoreAgentWorker(
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<DocumentStoreAgentWorker>.Instance);
    }

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
