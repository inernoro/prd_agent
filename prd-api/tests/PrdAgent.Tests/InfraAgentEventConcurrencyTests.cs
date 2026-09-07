using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 需要真实 Mongo 的事件序号并发验证；默认测试任务可排除 Category=Manual，
/// 发布前由验收流水线显式执行。
/// </summary>
[Trait("Category", "Manual")]
public class InfraAgentEventConcurrencyTests : IAsyncLifetime
{
    private readonly string _connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
        ?? "mongodb://127.0.0.1:27017";
    private readonly string _databaseName = $"infra_agent_event_concurrency_{Guid.NewGuid():N}";
    private MongoClient _client = null!;
    private MongoDbContext _db = null!;

    public async Task InitializeAsync()
    {
        var settings = MongoClientSettings.FromConnectionString(_connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
        _client = new MongoClient(settings);
        await _client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
        _db = new MongoDbContext(_connectionString, _databaseName);
    }

    public async Task DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);

    [Fact]
    public async Task ConcurrentAllocatorsReturnUniqueMonotonicSequences()
    {
        const string sessionId = "map-concurrent";
        await _db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
        {
            Id = sessionId,
            UserId = "user",
            ConnectionId = "connection",
            EventSeq = 0,
            EventSeqInitialized = true
        });

        var tasks = Enumerable.Range(0, 100)
            .Select(_ => InfraAgentSessionService.ReserveEventSeqRangeAsync(
                _db, sessionId, 1, CancellationToken.None));
        var allocated = await Task.WhenAll(tasks);

        Assert.Equal(Enumerable.Range(1, 100).Select(x => (long)x), allocated.OrderBy(x => x));
        Assert.Equal(100, allocated.Distinct().Count());
    }

    [Fact]
    public async Task LegacySessionInitializesCounterAbovePersistedEventsOnce()
    {
        const string sessionId = "map-legacy";
        await _db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
        {
            Id = sessionId,
            UserId = "user",
            ConnectionId = "connection",
            EventSeq = 0,
            EventSeqInitialized = false
        });
        await _db.InfraAgentEvents.InsertOneAsync(new InfraAgentEvent
        {
            SessionId = sessionId,
            Seq = 41,
            Type = InfraAgentEventTypes.Log
        });

        var tasks = Enumerable.Range(0, 20)
            .Select(_ => InfraAgentSessionService.ReserveEventSeqRangeAsync(
                _db, sessionId, 1, CancellationToken.None));
        var allocated = await Task.WhenAll(tasks);

        Assert.Equal(Enumerable.Range(42, 20).Select(x => (long)x), allocated.OrderBy(x => x));
        var session = await _db.InfraAgentSessions.Find(x => x.Id == sessionId).SingleAsync();
        Assert.True(session.EventSeqInitialized);
        Assert.Equal(61, session.EventSeq);
    }

    [Fact]
    public async Task ConcurrentRemoteEventClaimHasExactlyOneWinner()
    {
        var sourceKey = InfraAgentSessionService.BuildCdsEventSourceDedupKey(
            "cds-source", 9, InfraAgentEventTypes.Done, "{\"finalText\":\"done\"}");
        var eventId = InfraAgentSessionService.BuildCdsEventStorageId("map-session", sourceKey);

        var attempts = Enumerable.Range(0, 50).Select(index =>
            InfraAgentSessionService.TryInsertCdsClaimedEventAsync(
                _db.InfraAgentEvents,
                new InfraAgentEvent
                {
                    Id = eventId,
                    SessionId = "map-session",
                    Seq = index + 1,
                    Type = InfraAgentEventTypes.Done,
                    PayloadJson = "{\"finalText\":\"done\"}",
                    CdsSeq = 9,
                    CdsSourceSessionId = "cds-source",
                    SourceDedupKey = sourceKey
                },
                CancellationToken.None));
        var winners = await Task.WhenAll(attempts);

        Assert.Single(winners.Where(x => x));
        Assert.Equal(1, await _db.InfraAgentEvents.CountDocumentsAsync(x => x.Id == eventId));
    }

    [Fact]
    public async Task ClaimedDoneEventRepairsProjectionExactlyOnceAfterCrashGap()
    {
        const string sessionId = "map-projection-repair";
        const string sourceSessionId = "cds-projection-repair";
        const string clientMessageId = "client-message";
        var createdAt = DateTime.UtcNow.AddSeconds(-1);
        var sourceKey = InfraAgentSessionService.BuildCdsEventSourceDedupKey(
            sourceSessionId,
            12,
            InfraAgentEventTypes.Done,
            "{\"clientMessageId\":\"client-message\",\"finalText\":\"finished\"}");
        var eventId = InfraAgentSessionService.BuildCdsEventStorageId(sessionId, sourceKey);
        await _db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
        {
            Id = sessionId,
            UserId = "user",
            ConnectionId = "connection",
            CdsSessionId = sourceSessionId,
            Status = InfraAgentSessionStatuses.Running,
            ActiveMessageId = clientMessageId,
            EventSeqInitialized = true
        });
        await _db.InfraAgentMessages.InsertOneAsync(new InfraAgentMessage
        {
            Id = clientMessageId,
            SessionId = sessionId,
            Role = InfraAgentMessageRoles.User,
            Content = "build",
            Status = InfraAgentMessageStatuses.Streaming,
            CreatedAt = createdAt
        });
        // 模拟 importer 已赢得事件 claim，随即在任何副作用之前崩溃。
        await _db.InfraAgentEvents.InsertOneAsync(new InfraAgentEvent
        {
            Id = eventId,
            SessionId = sessionId,
            Seq = 1,
            Type = InfraAgentEventTypes.Done,
            PayloadJson = "{\"clientMessageId\":\"client-message\",\"finalText\":\"finished\"}",
            CdsSeq = 12,
            CdsSourceSessionId = sourceSessionId,
            SourceDedupKey = sourceKey,
            CreatedAt = createdAt.AddMilliseconds(500)
        });

        var repairs = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ =>
            InfraAgentSessionService.ProjectCdsDoneEventAsync(
                _db,
                sessionId,
                sourceSessionId,
                eventId,
                clientMessageId,
                "finished",
                createdAt.AddMilliseconds(500),
                CancellationToken.None)));

        Assert.All(repairs, Assert.True);
        var session = await _db.InfraAgentSessions.Find(x => x.Id == sessionId).SingleAsync();
        var outbound = await _db.InfraAgentMessages.Find(x => x.Id == clientMessageId).SingleAsync();
        var replies = await _db.InfraAgentMessages
            .Find(x => x.SessionId == sessionId && x.Role == InfraAgentMessageRoles.Assistant)
            .ToListAsync();
        Assert.Equal(InfraAgentSessionStatuses.Idle, session.Status);
        Assert.Null(session.ActiveMessageId);
        Assert.Equal(clientMessageId, session.LastCompletedMessageId);
        Assert.Equal(InfraAgentMessageStatuses.Completed, outbound.Status);
        Assert.Equal(sourceSessionId, outbound.CdsSourceSessionId);
        var reply = Assert.Single(replies);
        Assert.Equal(InfraAgentSessionService.BuildCdsAssistantMessageStorageId(sessionId, eventId), reply.Id);
        Assert.Equal(clientMessageId, reply.ReplyToMessageId);
        Assert.Equal("finished", reply.Content);
    }

    [Fact]
    public async Task LateOldTurnErrorCannotFailNewTurnInSameCdsGeneration()
    {
        const string sessionId = "map-turn-fence";
        const string sourceSessionId = "cds-shared-generation";
        await _db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
        {
            Id = sessionId,
            UserId = "user",
            ConnectionId = "connection",
            CdsSessionId = sourceSessionId,
            Status = InfraAgentSessionStatuses.Running,
            ActiveMessageId = "old-message",
            EventSeqInitialized = true
        });

        // 模拟旧轮投影读取通过后，另一 importer 完成旧轮并由新发送领取会话。
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == sessionId && x.ActiveMessageId == "old-message",
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Idle)
                .Set(x => x.ActiveMessageId, null));
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == sessionId && x.Status == InfraAgentSessionStatuses.Idle && x.ActiveMessageId == null,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Running)
                .Set(x => x.ActiveMessageId, "new-message"));

        var staleError = await _db.InfraAgentSessions.UpdateOneAsync(
            InfraAgentSessionService.BuildCdsFailedTurnWritableFilter(
                sessionId,
                sourceSessionId,
                "old-message",
                [InfraAgentSessionStatuses.Running, InfraAgentSessionStatuses.Idle, InfraAgentSessionStatuses.Failed]),
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
                .Set(x => x.ActiveMessageId, null));

        Assert.Equal(0, staleError.MatchedCount);
        var persisted = await _db.InfraAgentSessions.Find(x => x.Id == sessionId).SingleAsync();
        Assert.Equal(InfraAgentSessionStatuses.Running, persisted.Status);
        Assert.Equal("new-message", persisted.ActiveMessageId);
    }

    [Fact]
    public async Task StaleCompletedCleanupSnapshotCannotStopNewActiveTurn()
    {
        const string sessionId = "map-stop-turn-fence";
        var cleanupRequestedAt = DateTime.UtcNow.AddSeconds(-1);
        await _db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
        {
            Id = sessionId,
            UserId = "user",
            ConnectionId = "connection",
            CdsSessionId = "cds-generation",
            Status = InfraAgentSessionStatuses.Idle,
            ActiveMessageId = null,
            CleanupRequestedAt = cleanupRequestedAt,
            EventSeqInitialized = true
        });
        var staleSnapshot = await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId)
            .SingleAsync();

        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == sessionId && x.Status == InfraAgentSessionStatuses.Idle && x.ActiveMessageId == null,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Running)
                .Set(x => x.ActiveMessageId, "new-message"));

        var staleStop = await _db.InfraAgentSessions.UpdateOneAsync(
            InfraAgentSessionService.BuildCdsStopTransitionFilter(
                staleSnapshot,
                "user",
                sessionId,
                DateTime.UtcNow),
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Stopping)
                .Set(x => x.ActiveMessageId, null)
                .Set(x => x.StopLeaseOwner, "stale-stop"));

        Assert.Equal(0, staleStop.ModifiedCount);
        var persisted = await _db.InfraAgentSessions.Find(x => x.Id == sessionId).SingleAsync();
        Assert.Equal(InfraAgentSessionStatuses.Running, persisted.Status);
        Assert.Equal("new-message", persisted.ActiveMessageId);
        Assert.Equal(cleanupRequestedAt, persisted.CleanupRequestedAt);
    }

    [Fact]
    public async Task LateOldGenerationCannotOverwriteCurrentSessionStatus()
    {
        const string sessionId = "map-generation";
        await _db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
        {
            Id = sessionId,
            UserId = "user",
            ConnectionId = "connection",
            CdsSessionId = "cds-new",
            Status = InfraAgentSessionStatuses.Running,
            EventSeqInitialized = true
        });

        var stale = await _db.InfraAgentSessions.UpdateOneAsync(
            InfraAgentSessionService.BuildCdsGenerationWritableFilter(sessionId, "cds-old"),
            Builders<InfraAgentSession>.Update.Set(x => x.Status, InfraAgentSessionStatuses.Failed));
        var current = await _db.InfraAgentSessions.UpdateOneAsync(
            InfraAgentSessionService.BuildCdsGenerationWritableFilter(sessionId, "cds-new"),
            Builders<InfraAgentSession>.Update.Set(x => x.Status, InfraAgentSessionStatuses.Idle));

        Assert.Equal(0, stale.MatchedCount);
        Assert.Equal(1, current.MatchedCount);
        var persisted = await _db.InfraAgentSessions.Find(x => x.Id == sessionId).SingleAsync();
        Assert.Equal(InfraAgentSessionStatuses.Idle, persisted.Status);
        Assert.Equal("cds-new", persisted.CdsSessionId);
    }

    [Fact]
    public async Task CurrentGenerationReadExcludesLateOldRemoteEventsButKeepsLocalEvents()
    {
        await _db.InfraAgentEvents.InsertManyAsync([
            new InfraAgentEvent { Id = "local", SessionId = "map-read", Seq = 1, Type = InfraAgentEventTypes.Log },
            new InfraAgentEvent { Id = "old", SessionId = "map-read", Seq = 2, Type = InfraAgentEventTypes.Error, CdsSourceSessionId = "cds-old" },
            new InfraAgentEvent { Id = "new", SessionId = "map-read", Seq = 3, Type = InfraAgentEventTypes.Done, CdsSourceSessionId = "cds-new" }
        ]);

        var visible = await _db.InfraAgentEvents
            .Find(InfraAgentSessionService.BuildVisibleEventFilter("map-read", "cds-new", 0))
            .SortBy(x => x.Seq)
            .ToListAsync();
        var creatingVisible = await _db.InfraAgentEvents
            .Find(InfraAgentSessionService.BuildVisibleEventFilter("map-read", null, 0))
            .SortBy(x => x.Seq)
            .ToListAsync();

        Assert.Equal(["local", "new"], visible.Select(x => x.Id));
        Assert.Equal(["local"], creatingVisible.Select(x => x.Id));
    }

    [Fact]
    public async Task MessageReadHidesOrphanedRemoteRepliesButKeepsCausalHistory()
    {
        await _db.InfraAgentMessages.InsertManyAsync([
            new InfraAgentMessage { Id = "user", SessionId = "map-messages", Role = InfraAgentMessageRoles.User, Content = "new request" },
            new InfraAgentMessage { Id = "legacy", SessionId = "map-messages", Role = InfraAgentMessageRoles.Assistant, Content = "legacy" },
            new InfraAgentMessage { Id = "old-linked", SessionId = "map-messages", Role = InfraAgentMessageRoles.Assistant, Content = "old linked", CdsSourceSessionId = "cds-old", ReplyToMessageId = "old-user" },
            new InfraAgentMessage { Id = "old-orphan", SessionId = "map-messages", Role = InfraAgentMessageRoles.Assistant, Content = "old orphan", CdsSourceSessionId = "cds-old" },
            new InfraAgentMessage { Id = "current", SessionId = "map-messages", Role = InfraAgentMessageRoles.Assistant, Content = "current", CdsSourceSessionId = "cds-new" }
        ]);

        var visible = await _db.InfraAgentMessages
            .Find(InfraAgentSessionService.BuildVisibleMessageFilter("map-messages", "cds-new"))
            .ToListAsync();
        var creatingVisible = await _db.InfraAgentMessages
            .Find(InfraAgentSessionService.BuildVisibleMessageFilter("map-messages", null))
            .ToListAsync();

        Assert.Equal(["current", "legacy", "old-linked", "user"], visible.Select(x => x.Id).OrderBy(x => x));
        Assert.Equal(["legacy", "old-linked", "user"], creatingVisible.Select(x => x.Id).OrderBy(x => x));
    }

    [Fact]
    public async Task StaleDispatchAcknowledgementCannotReopenCompletedTurn()
    {
        const string sessionId = "map-completed-turn";
        await _db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
        {
            Id = sessionId,
            UserId = "user",
            ConnectionId = "connection",
            CdsSessionId = "cds-current",
            Status = InfraAgentSessionStatuses.Idle,
            ActiveMessageId = null,
            EventSeqInitialized = true
        });

        var staleAcknowledgement = await _db.InfraAgentSessions.UpdateOneAsync(
            InfraAgentSessionService.BuildCdsActiveTurnWritableFilter(
                sessionId,
                "cds-current",
                "already-completed-message"),
            Builders<InfraAgentSession>.Update.Set(x => x.Status, InfraAgentSessionStatuses.Running));

        Assert.Equal(0, staleAcknowledgement.MatchedCount);
        var persisted = await _db.InfraAgentSessions.Find(x => x.Id == sessionId).SingleAsync();
        Assert.Equal(InfraAgentSessionStatuses.Idle, persisted.Status);
        Assert.Null(persisted.ActiveMessageId);
    }
}
