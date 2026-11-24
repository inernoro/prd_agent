using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Bson.IO;
using MongoDB.Bson.Serialization;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class RunTaskProvenanceTests
{
    public static IEnumerable<object[]> DurableTaskTypes => new[]
    {
        typeof(RunMeta), typeof(ImageGenRun), typeof(TranscriptRun), typeof(DocumentStoreAgentRun),
        typeof(ShortVideoMaterialRun), typeof(DesignArtifactRun), typeof(WorkflowExecution),
        typeof(VideoGenRun), typeof(VideoGenScene), typeof(VideoToDocRun), typeof(MdToPptRun),
        typeof(RequirementAssessmentRun), typeof(ToolboxRun), typeof(DocumentRecordingUploadSession),
        typeof(ChatAgentMessage), typeof(InfraAgentMessage),
    }.Select(type => new object[] { type });

    [Theory]
    [MemberData(nameof(DurableTaskTypes))]
    public void NewAndMissingBsonRecords_DoNotCaptureAnUnrelatedAmbientPermit(Type type)
    {
        BsonClassMapRegistration.Register();
        using var ambient = TaskExecutionContext.Enter(new TaskExecutionIdentity("unrelated-active-request", "other-run"));
        var created = Assert.IsAssignableFrom<ITaskAuthorizedRun>(Activator.CreateInstance(type));
        Assert.Null(created.TaskPermitId);
        using var reader = new BsonDocumentReader(new BsonDocument());
        var oldRecord = Assert.IsAssignableFrom<ITaskAuthorizedRun>(BsonSerializer.Deserialize(reader, type));
        Assert.Null(oldRecord.TaskPermitId);
    }

    [Theory]
    [MemberData(nameof(DurableTaskTypes))]
    public void BsonRetainsServerProvenance_ButApiJsonCannotInjectOrExposeIt(Type type)
    {
        BsonClassMapRegistration.Register();
        var model = Assert.IsAssignableFrom<ITaskAuthorizedRun>(Activator.CreateInstance(type));
        model.TaskPermitId = "server-persisted-permit";
        var bson = model.ToBsonDocument(type);
        using var reader = new BsonDocumentReader(bson);
        var hydrated = Assert.IsAssignableFrom<ITaskAuthorizedRun>(BsonSerializer.Deserialize(reader, type));
        Assert.Equal(model.TaskPermitId, hydrated.TaskPermitId);
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var output = JsonSerializer.Serialize(model, type, options);
        Assert.DoesNotContain("server-persisted-permit", output, StringComparison.Ordinal);
        var fromRequest = Assert.IsAssignableFrom<ITaskAuthorizedRun>(JsonSerializer.Deserialize(
            "{\"taskPermitId\":\"request-forged-permit\"}", type, options));
        Assert.Null(fromRequest.TaskPermitId);
    }

    [Fact]
    public async Task InMemoryStore_RetainsOriginalSourceAcrossStatusUpdates_AndDoesNotAdoptCurrentRequest()
    {
        var store = new InMemoryRunEventStore();
        await store.SetRunAsync(RunKinds.Chat, new RunMeta { RunId = "admitted", TaskPermitId = "original" });
        await store.SetRunAsync(RunKinds.Chat, new RunMeta { RunId = "legacy" });
        using var other = TaskExecutionContext.Enter(new TaskExecutionIdentity("different-request", "different-run"));
        var recovered = (await store.GetRunAsync(RunKinds.Chat, "admitted"))!;
        recovered.Status = RunStatuses.Running;
        await store.SetRunAsync(RunKinds.Chat, recovered);
        await store.AppendEventAsync(RunKinds.Chat, "admitted", "progress", new { progress = 10 });
        Assert.Equal("original", (await store.GetRunAsync(RunKinds.Chat, "admitted"))!.TaskPermitId);
        Assert.Null((await store.GetRunAsync(RunKinds.Chat, "legacy"))!.TaskPermitId);
        await store.AppendEventAsync(RunKinds.Chat, "event-only", "progress", new { progress = 20 });
        Assert.Null((await store.GetRunAsync(RunKinds.Chat, "event-only"))!.TaskPermitId);
    }

    [Fact]
    public void RecordingOutboxRecovery_CopiesOnlyTheCompletedRecordingOperation()
    {
        var session = new DocumentRecordingUploadSession
        {
            Id = "recording", StoreId = "store", UserId = "user",
            TaskPermitId = "persisted-recording-operation", LiveTranscriptStatus = DocumentLiveTranscriptStatus.Degraded,
        };
        using var unrelated = TaskExecutionContext.Enter(new TaskExecutionIdentity("worker-ambient-permit", "different-run"));
        var first = DocumentRecordingArchiveWorker.BuildDeferredTranscriptionRun(session, "entry", "instance", true)!;
        var restarted = DocumentRecordingArchiveWorker.BuildDeferredTranscriptionRun(session, "entry", "instance", true)!;
        Assert.Equal(first.Id, restarted.Id);
        Assert.Equal(session.TaskPermitId, first.TaskPermitId);
        Assert.Equal(first.TaskPermitId, restarted.TaskPermitId);
        session.TaskPermitId = null;
        Assert.Null(DocumentRecordingArchiveWorker.BuildDeferredTranscriptionRun(session, "entry", "instance", true)!.TaskPermitId);
    }

    [Fact]
    public void LongLivedChatSessions_DoNotCarryATurnPermit()
    {
        Assert.Null(typeof(ChatAgentSession).GetProperty(nameof(ITaskAuthorizedRun.TaskPermitId)));
        Assert.Null(typeof(InfraAgentSession).GetProperty(nameof(ITaskAuthorizedRun.TaskPermitId)));
        var first = new ChatAgentTurnJob("session", "turn-1") { TaskPermitId = "first" };
        var next = new ChatAgentTurnJob("session", "turn-2");
        Assert.Equal("first", first.TaskPermitId);
        Assert.Null(next.TaskPermitId);
        var job = new InfraAgentRuntimeJob("user", "session", "message", "content", DateTime.UtcNow);
        Assert.Null(job.TaskPermitId);
    }
}
