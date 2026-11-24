using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Infrastructure.Services.AssetStorage;
using System.Security.Claims;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services.DefectAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class DefectSubmissionPersistenceTests
{
    [Fact]
    public void RequestIdentity_PreservesOwnerOperationAndWholeKey()
    {
        var prefix = new string('x', 200);
        var id = DefectSubmissionPersistence.RequestId("create", "owner", prefix + "a");
        id.ShouldBe(DefectSubmissionPersistence.RequestId("create", "owner", " " + prefix + "a "));
        id.ShouldNotBe(DefectSubmissionPersistence.RequestId("create", "other", prefix + "a"));
        id.ShouldNotBe(DefectSubmissionPersistence.RequestId("attachment:one", "owner", prefix + "a"));
        id.ShouldNotBe(DefectSubmissionPersistence.RequestId("create", "owner", prefix + "b"));
        DefectSubmissionPersistence.RequestId("create", "owner", " ").ShouldBeNull();
    }

    [Fact]
    public async Task LostCreateResponse_AndConcurrentReplay_ReturnOneDurableDraft()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var id = DefectSubmissionPersistence.RequestId("create", "owner", "request")!;
        var results = await Task.WhenAll(Enumerable.Range(0, 24).Select(i =>
            DefectSubmissionPersistence.CreateOrRecoverAsync(fixture.Collection,
                new DefectReport { Id = id, ReporterId = "owner", RawContent = "original", CreationFingerprint = "first" }, default)));
        results.Select(x => x.Id).Distinct().Count().ShouldBe(1);
        (await fixture.Collection.CountDocumentsAsync(FilterDefinition<DefectReport>.Empty)).ShouldBe(1);
        await fixture.Collection.UpdateOneAsync(x => x.Id == id,
            Builders<DefectReport>.Update.Set(x => x.RawContent, "edited"));
        var recovered = await DefectSubmissionPersistence.CreateOrRecoverAsync(fixture.Collection,
            new DefectReport { Id = id, ReporterId = "owner", RawContent = "different", CreationFingerprint = "conflict" }, default);
        recovered.RawContent.ShouldBe("edited");
        recovered.CreationFingerprint.ShouldBe("first"); // 控制器据此返回409，同键异内容不能覆盖已存内容。
    }

    [Fact]
    public async Task ParallelAttachments_AndLostResponseReplay_KeepAllFilesExactlyOnce()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner" };
        await fixture.Collection.InsertOneAsync(draft);
        await Task.WhenAll(Enumerable.Range(0, 64).Select(i =>
            DefectSubmissionPersistence.AppendAttachmentAsync(fixture.Collection, draft.Id,
                new DefectAttachment { Id = $"file-{i % 16}", RequestFingerprint = "original", FileName = $"{i % 16}.png" }, default)));
        var current = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        current.Attachments.Count.ShouldBe(16);
        current.Attachments.Select(x => x.Id).Distinct().Count().ShouldBe(16);
        var replay = await DefectSubmissionPersistence.AppendAttachmentAsync(fixture.Collection, draft.Id,
            new DefectAttachment { Id = "file-0", RequestFingerprint = "different", FileName = "replacement.png" }, default);
        replay!.Attachments.Single(x => x.Id == "file-0").RequestFingerprint.ShouldBe("original");
        replay.Attachments.Count.ShouldBe(16);
    }

    [Fact]
    public async Task ConcurrentSubmit_ClaimsSideEffectsOnce_AndPreservesConcurrentAttachments()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner", RawContent = "report", AssigneeId = "assignee" };
        await fixture.Collection.InsertOneAsync(draft);
        var submission = Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, draft, default)));
        await Task.WhenAll(Enumerable.Range(0, 16).Select(i =>
            DefectSubmissionPersistence.AppendAttachmentAsync(fixture.Collection, draft.Id,
                new DefectAttachment { Id = $"file-{i}" }, default)));
        var winners = await submission;
        winners.Count(x => x != null).ShouldBe(1); // 只有这个分支会调用采集/通知/webhook。
        var submitted = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        submitted.Status.ShouldBe(DefectStatus.Submitted);
        submitted.SubmittedAt.ShouldNotBeNull();
        submitted.AssigneeUnread.ShouldBeTrue();
        submitted.Attachments.Count.ShouldBe(16);
        (await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, submitted, default)).ShouldBeNull();
        await fixture.Collection.UpdateOneAsync(x => x.Id == draft.Id,
            Builders<DefectReport>.Update.Set(x => x.Status, DefectStatus.Processing));
        (await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, draft, default)).ShouldBeNull();
        (await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync()).Status.ShouldBe(DefectStatus.Processing);
    }

    [Fact]
    public async Task SaveDraft_RechecksRevisionAndStatus_WithoutOverwritingAttachments()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner", RawContent = "original" };
        await fixture.Collection.InsertOneAsync(draft);
        await DefectSubmissionPersistence.AppendAttachmentAsync(fixture.Collection, draft.Id,
            new DefectAttachment { Id = "parallel" }, default);
        var update = Builders<DefectReport>.Update.Set(x => x.RawContent, "edited")
            .Set(x => x.Severity, DefectSeverity.Critical).Set(x => x.Priority, DefectPriority.High)
            .Set(x => x.AssigneeId, "new-assignee").Set(x => x.TemplateId, "template")
            .Set(x => x.ProjectId, "project").Set(x => x.TeamId, "team").Inc(x => x.EditRevision, 1);
        var saved = await DefectSubmissionPersistence.UpdateDraftAsync(fixture.Collection, draft, update, default);
        saved.Attachments.Single().Id.ShouldBe("parallel");
        saved.EditRevision.ShouldBe(1);
        saved.RawContent.ShouldBe("edited");
        saved.AssigneeId.ShouldBe("new-assignee");
        saved.TeamId.ShouldBe("team");
        (await DefectSubmissionPersistence.UpdateDraftAsync(fixture.Collection, draft, update, default)).ShouldBeNull();
        (await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, draft, default)).ShouldBeNull();
        (await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, saved, default)).ShouldNotBeNull();
        (await DefectSubmissionPersistence.UpdateDraftAsync(fixture.Collection, saved, update, default)).ShouldBeNull();
    }

    [Fact]
    public async Task LegacyDraftWithoutRevision_RemainsEditableAndSubmittable()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner", RawContent = "legacy" };
        await fixture.Collection.InsertOneAsync(draft);
        await fixture.Collection.UpdateOneAsync(x => x.Id == draft.Id,
            Builders<DefectReport>.Update.Unset(x => x.EditRevision));
        (await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, draft, default)).ShouldNotBeNull();
    }

    [Fact]
    public async Task Controller_RetryConflictAndRecovery_PersistEditedFieldsAndRejectStateRollback()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var storage = new Mock<IAssetStorage>();
        storage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
            .ReturnsAsync(new StoredAsset("hash", "https://storage.invalid/file.png", 3, "image/png"));
        var controller = new DefectAgentController(fixture.Db, null!, NullLogger<DefectAgentController>.Instance,
            storage.Object, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[]
                { new Claim("sub", "owner"), new Claim("name", "测试用户") }, "test")) }
            }
        };
        var request = new CreateDefectRequest { ClientRequestId = "compose", Content = "initial" };
        (await controller.CreateDefect(request, default)).ShouldBeOfType<OkObjectResult>();
        (await controller.CreateDefect(request, default)).ShouldBeOfType<OkObjectResult>();
        var conflict = (await controller.CreateDefect(new CreateDefectRequest
            { ClientRequestId = "compose", Content = "changed" }, default)).ShouldBeOfType<ConflictObjectResult>();
        ((ApiResponse<object>)conflict.Value!).Error!.Code.ShouldBe("IDEMPOTENCY_CONFLICT");
        (await fixture.Collection.CountDocumentsAsync(FilterDefinition<DefectReport>.Empty)).ShouldBe(1);
        var draft = await fixture.Collection.Find(FilterDefinition<DefectReport>.Empty).SingleAsync();
        await fixture.Db.Users.InsertOneAsync(new User { UserId = "assignee", Username = "assignee", DisplayName = "受理人" });
        await fixture.Db.DefectProjects.InsertOneAsync(new DefectProject { Id = "project", Name = "项目" });
        await fixture.Db.ReportTeams.InsertOneAsync(new ReportTeam { Id = "team", Name = "团队" });
        (await controller.UpdateDefect(draft.Id, new UpdateDefectRequest
        {
            Title = "edited title", Content = "edited content", TemplateId = "template",
            Severity = DefectSeverity.Critical, Priority = DefectPriority.High,
            AssigneeUserId = "assignee", ProjectId = "project", TeamId = "team"
        }, default)).ShouldBeOfType<OkObjectResult>();
        var edited = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        edited.RawContent.ShouldBe("edited content");
        edited.TemplateId.ShouldBe("template");
        edited.Severity.ShouldBe(DefectSeverity.Critical);
        edited.Priority.ShouldBe(DefectPriority.High);
        edited.AssigneeName.ShouldBe("受理人");
        edited.ProjectName.ShouldBe("项目");
        edited.TeamName.ShouldBe("团队");
        IFormFile File(byte value) => new FormFile(new MemoryStream(new byte[] { value, 2, 3 }), 0, 3, "file", "a.png")
            { Headers = new HeaderDictionary(), ContentType = "image/png" };
        var uploaded = (await controller.AddAttachment(draft.Id, File(1), "description", default, "file-key"))
            .ShouldBeOfType<OkObjectResult>();
        var replayed = (await controller.AddAttachment(draft.Id, File(1), "description", default, "file-key"))
            .ShouldBeOfType<OkObjectResult>();
        var uploadedJson = System.Text.Json.JsonSerializer.Serialize(((ApiResponse<object>)uploaded.Value!).Data);
        var replayedJson = System.Text.Json.JsonSerializer.Serialize(((ApiResponse<object>)replayed.Value!).Data);
        uploadedJson.ShouldContain("\"ClientRequestId\":\"file-key\"");
        replayedJson.ShouldBe(uploadedJson);
        (await controller.AddAttachment(draft.Id, File(1), "description", default, new string('x', 257)))
            .ShouldBeOfType<BadRequestObjectResult>();
        (await controller.AddAttachment(draft.Id, File(9), "description", default, "file-key")).ShouldBeOfType<ConflictObjectResult>();
        var uploadedAttachments = (await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync()).Attachments;
        uploadedAttachments.Count.ShouldBe(1);
        uploadedAttachments.Single().ClientRequestId.ShouldBe("file-key");
        storage.Verify(x => x.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()), Times.Once);
        await fixture.Collection.UpdateOneAsync(x => x.Id == draft.Id,
            Builders<DefectReport>.Update.Set(x => x.Status, DefectStatus.Processing).Set(x => x.SubmittedAt, DateTime.UtcNow));
        // 已流转请求重放不访问采集/通知依赖，也不能被草稿保存回退。
        (await controller.SubmitDefect(draft.Id, default)).ShouldBeOfType<OkObjectResult>();
        (await controller.UpdateDefect(draft.Id, new UpdateDefectRequest { Content = "rollback" }, default))
            .ShouldBeOfType<BadRequestObjectResult>();
        var final = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        final.Status.ShouldBe(DefectStatus.Processing);
        final.RawContent.ShouldBe("edited content");
        // 历史Submitted即使没有SubmittedAt，也能安全重放；不会再次触发副作用。
        await fixture.Collection.UpdateOneAsync(x => x.Id == draft.Id,
            Builders<DefectReport>.Update.Set(x => x.Status, DefectStatus.Submitted).Unset(x => x.SubmittedAt));
        (await controller.SubmitDefect(draft.Id, default)).ShouldBeOfType<OkObjectResult>();
        (await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync()).SubmittedAt.ShouldBeNull();
    }

    [Fact]
    public async Task Controller_AttachmentStorageFailure_ReturnsSafeTypedErrorAndPreservesDraft()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner", RawContent = "preserved draft" };
        await fixture.Collection.InsertOneAsync(draft);
        var storage = new Mock<IAssetStorage>();
        storage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
            .ThrowsAsync(new HttpRequestException("sensitive-storage-detail"));
        var controller = new DefectAgentController(fixture.Db, null!, NullLogger<DefectAgentController>.Instance,
            storage.Object, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[]
                { new Claim("sub", "owner") }, "test")) }
            }
        };
        var file = new FormFile(new MemoryStream(new byte[] { 1 }), 0, 1, "file", "a.png")
            { Headers = new HeaderDictionary(), ContentType = "image/png" };
        var result = (await controller.AddAttachment(draft.Id, file, null, default, "file-key"))
            .ShouldBeOfType<ObjectResult>();
        result.StatusCode.ShouldBe(503);
        var response = (ApiResponse<object>)result.Value!;
        response.Error!.Code.ShouldBe("ATTACHMENT_STORAGE_FAILED");
        response.Error.Message.ShouldNotContain("sensitive-storage-detail");
        var current = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        current.Status.ShouldBe(DefectStatus.Draft);
        current.RawContent.ShouldBe("preserved draft");
        current.Attachments.ShouldBeEmpty();
    }

    [Theory]
    [InlineData("read")]
    [InlineData("comment")]
    [InlineData("severity")]
    [InlineData("folder")]
    public async Task StaleMetadataWrite_PreservesConcurrentAttachmentEditedContentAndSubmission(string writer)
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner", RawContent = "original", CreationFingerprint = "creation" };
        await fixture.Collection.InsertOneAsync(draft);
        // 确定性地把其他写入放在元数据读旧快照和真正保存之间，不依赖随机线程时序。
        var stale = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        await DefectSubmissionPersistence.AppendAttachmentAsync(fixture.Collection, draft.Id,
            new DefectAttachment { Id = "new-attachment" }, default);
        var edited = await DefectSubmissionPersistence.UpdateDraftAsync(fixture.Collection, draft,
            Builders<DefectReport>.Update.Set(x => x.RawContent, "edited")
                .Push(x => x.Versions, new DefectVersion { Version = 1, RawContent = "original" })
                .Inc(x => x.Version, 1).Inc(x => x.EditRevision, 1), default);
        var submitted = await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, edited, default);
        submitted.EditRevision.ShouldBe(2);
        var update = writer switch
        {
            "read" => Builders<DefectReport>.Update.Set(x => x.ReporterUnread, false),
            "comment" => Builders<DefectReport>.Update.Set(x => x.ReporterUnread, false)
                .Set(x => x.AssigneeUnread, true).Set(x => x.LastCommentBy, DefectUnreadBy.Reporter),
            "severity" => Builders<DefectReport>.Update.Set(x => x.Severity, DefectSeverity.Critical).Inc(x => x.EditRevision, 1),
            _ => Builders<DefectReport>.Update.Set(x => x.FolderId, "target-folder")
        };
        var saved = await DefectSubmissionPersistence.UpdateFieldsAsync(fixture.Collection, stale.Id, update, default);
        saved.Attachments.Single().Id.ShouldBe("new-attachment");
        saved.RawContent.ShouldBe("edited");
        saved.Status.ShouldBe(DefectStatus.Submitted);
        saved.SubmittedAt.ShouldNotBeNull();
        saved.EditRevision.ShouldBe(writer == "severity" ? 3 : 2);
        saved.Version.ShouldBe(2);
        saved.Versions.Single().RawContent.ShouldBe("original");
        saved.CreationFingerprint.ShouldBe("creation");
        if (writer == "folder") saved.FolderId.ShouldBe("target-folder");
        if (writer == "severity") saved.Severity.ShouldBe(DefectSeverity.Critical);
    }

    [Fact]
    public async Task StateWrite_PreservesNewAttachmentAndIndependentMetadata_AndConsumesSnapshot()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var defect = new DefectReport { ReporterId = "owner", Status = DefectStatus.Assigned };
        await fixture.Collection.InsertOneAsync(defect);
        // 历史没有revision字段也应被状态动作正常接管并推进到1。
        await fixture.Collection.UpdateOneAsync(x => x.Id == defect.Id, Builders<DefectReport>.Update.Unset(x => x.EditRevision).Unset(x => x.ReporterId));
        // 状态操作也用于管理员处理旧数据；Reporter字段缺失不应额外变成状态CAS条件。
        var snapshot = DefectSubmissionPersistence.StateSnapshot(defect);
        await DefectSubmissionPersistence.AppendAttachmentAsync(fixture.Collection, defect.Id,
            new DefectAttachment { Id = "parallel-file" }, default);
        await DefectSubmissionPersistence.UpdateFieldsAsync(fixture.Collection, defect.Id,
            Builders<DefectReport>.Update.Set(x => x.FolderId, "parallel-folder"), default);
        var updated = await DefectSubmissionPersistence.UpdateStateAsync(fixture.Collection, snapshot,
            Builders<DefectReport>.Update.Set(x => x.Status, DefectStatus.Processing), default);
        updated.Status.ShouldBe(DefectStatus.Processing);
        updated.EditRevision.ShouldBe(1);
        updated.Attachments.Single().Id.ShouldBe("parallel-file");
        updated.FolderId.ShouldBe("parallel-folder");
        (await DefectSubmissionPersistence.UpdateStateAsync(fixture.Collection, snapshot,
            Builders<DefectReport>.Update.Set(x => x.Status, DefectStatus.Rejected), default)).ShouldBeNull();
        (await fixture.Collection.Find(x => x.Id == defect.Id).SingleAsync()).Status.ShouldBe(DefectStatus.Processing);
    }

    [Fact]
    public async Task AwaitingRoundTrip_ActualBlockEndpointRejectsOldSubmitAndEdit_ThenAllowsFreshEdit()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner", AssigneeId = "owner", Status = DefectStatus.Awaiting, RawContent = "before" };
        await fixture.Collection.InsertOneAsync(draft);
        var requestA = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        var requestB = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        var submitted = await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, requestB, default);
        var run = new DefectAutomationRun { CreatedBy = "owner", CurrentDefectId = draft.Id };
        await fixture.Db.DefectAutomationRuns.InsertOneAsync(run);
        var controller = OwnerController(fixture);
        (await controller.BlockAutomationWorkflow(new BlockDefectAutomationWorkflowRequest
        { RunId = run.Id, DefectId = draft.Id, FailureReason = "补充复现步骤", StopRun = false }, default))
            .ShouldBeOfType<OkObjectResult>();
        var awaiting = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        awaiting.Status.ShouldBe(DefectStatus.Awaiting);
        (await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, requestA, default)).ShouldBeNull();
        submitted.EditRevision.ShouldBe(1);
        awaiting.EditRevision.ShouldBe(2);
        (await DefectSubmissionPersistence.UpdateDraftAsync(fixture.Collection, requestA,
            Builders<DefectReport>.Update.Set(x => x.RawContent, "stale").Inc(x => x.EditRevision, 1), default)).ShouldBeNull();
        var edited = await DefectSubmissionPersistence.UpdateDraftAsync(fixture.Collection, awaiting,
            Builders<DefectReport>.Update.Set(x => x.RawContent, "new details").Inc(x => x.EditRevision, 1), default);
        (await DefectSubmissionPersistence.TrySubmitAsync(fixture.Collection, edited, default)).ShouldNotBeNull();
        var final = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        final.RawContent.ShouldBe("new details");
        final.EditRevision.ShouldBe(4);
    }

    [Fact]
    public async Task StateWrite_RejectsSnapshotOlderThanSavedDraft()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var draft = new DefectReport { ReporterId = "owner", RawContent = "original" };
        await fixture.Collection.InsertOneAsync(draft);
        var stateSnapshot = DefectSubmissionPersistence.StateSnapshot(draft);
        await DefectSubmissionPersistence.UpdateDraftAsync(fixture.Collection, draft,
            Builders<DefectReport>.Update.Set(x => x.RawContent, "newer").Inc(x => x.EditRevision, 1), default);
        (await DefectSubmissionPersistence.UpdateStateAsync(fixture.Collection, stateSnapshot,
            Builders<DefectReport>.Update.Set(x => x.Status, DefectStatus.Verifying), default)).ShouldBeNull();
        var saved = await fixture.Collection.Find(x => x.Id == draft.Id).SingleAsync();
        saved.RawContent.ShouldBe("newer");
        saved.Status.ShouldBe(DefectStatus.Draft);
    }

    private static DefectAgentController OwnerController(MongoFixture fixture)
        => new(fixture.Db, null!, NullLogger<DefectAgentController>.Instance,
            null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[]
                { new Claim("sub", "owner"), new Claim("name", "测试用户") }, "test")) }
            }
        };

    private sealed class MongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;
        public IMongoCollection<DefectReport> Collection { get; }
        public MongoDbContext Db { get; }
        private MongoFixture(MongoClient client, string connection, string database)
        {
            _client = client;
            _databaseName = database;
            Db = new MongoDbContext(connection, database);
            Collection = Db.DefectReports;
        }
        public static async Task<MongoFixture> CreateAsync()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://localhost:27018";
            var settings = MongoClientSettings.FromConnectionString(connection);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new MongoFixture(client, connection, $"defect_submission_race_{Guid.NewGuid():N}");
        }
        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
