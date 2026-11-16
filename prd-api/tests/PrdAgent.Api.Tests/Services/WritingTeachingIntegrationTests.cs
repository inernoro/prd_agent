using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.Integration)]
public class WritingTeachingIntegrationTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        public MongoDbContext Db { get; }
        public Mock<IAssetStorage> Assets { get; } = new();
        public IDataProtectionProvider Protection { get; } = new EphemeralDataProtectionProvider();
        public DocumentEntry Entry { get; }
        public IMongoCollection<WritingTeaching> Teachings => Db.Database.GetCollection<WritingTeaching>("document_writing_teaching");
        private readonly TaskAdmissionService admission;
        private readonly SpeechGenerationService speech;
        public Fixture()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? throw new InvalidOperationException("Explicit isolated MONGODB_TEST_CONNECTION required");
            Db = new MongoDbContext(connection, "map_writing_teaching_test_" + Guid.NewGuid().ToString("N"));
            admission = new TaskAdmissionService(null!, new ConfigurationBuilder().Build(), executions: Mock.Of<ITaskExecutionCoordinator>());
            var host = new Mock<IHostEnvironment>(); host.SetupGet(h => h.EnvironmentName).Returns("WritingIntegration");
            speech = new SpeechGenerationService(Db, null!, null!, Protection, Assets.Object, null!, host.Object, NullLogger<SpeechGenerationService>.Instance);
            Entry = new DocumentEntry { Id = "entry", StoreId = "store", CreatedBy = "owner", Writing = new WritingDocumentState {
                AuthorId = "owner", ReviewerId = "owner", Title = "执行条件", Stage = "published", Published = new WritingPublication {
                    Version = 1, Title = "测试租户交接", Sections = new() { new WritingSection { Id = "s1", Title = "执行条件", Condition = "仅测试租户", Paragraphs = new() { new WritingParagraph { Id = "p1", Text = "失败停止，不得重复提交", Confirmed = true } } } }
                }
            } };
        }
        public async Task Init()
        {
            await Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "owner", IsPublic = true, Name = "隔离集成测试" });
            await Db.DocumentEntries.InsertOneAsync(Entry);
            var settings = await speech.GetSettingsAsync(); settings.Revision = 1;
            // 仅验证排队/权限协议：此fixture没有worker，不调用或伪造模型结果。
            settings.Profiles.Add(new SpeechProfile { Id = "profile", Revision = 1, Enabled = true, IsDefault = true, MaxTextChars = 2000, DefaultVoiceId = "voice", Formats = new() { "mp3" } });
            await Db.SpeechSettings.InsertOneAsync(settings);
        }
        public DocumentStoreController Controller(string action, string actor = "owner")
        {
            var teams = new Mock<ITeamService>(); teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            var services = new ServiceCollection().AddSingleton(speech).AddSingleton(admission).AddSingleton(Protection).BuildServiceProvider();
            var http = new DefaultHttpContext { RequestServices = services, User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", actor) }, "Bearer")) };
            http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(new ControllerActionDescriptor { ActionName = action, ControllerTypeInfo = typeof(DocumentStoreController).GetTypeInfo() }), "isolated-test"));
            TaskAdmissionRequestState.Get(http).Identity = new TaskExecutionIdentity("isolated-permit-" + Guid.NewGuid().ToString("N"));
            return new DocumentStoreController(Db, Assets.Object, null!, null!, null!, null!, null!, teams.Object,
                null!, null!, null!, null!, null!, null!, null!, null!, new ConfigurationBuilder().Build(),
                null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance) { ControllerContext = new ControllerContext { HttpContext = http } };
        }
        public WritingTeachingRequest Request(string id) => new() { RequestId = id, SourceVersion = 1, SourceFingerprint = WritingTeachingPolicy.SourceFingerprint(Entry.Writing!.Published!) };
        public WritingTeaching Ready(string id = "teaching")
        {
            var teaching = new WritingTeaching { Id = id, EntryId = "entry", StoreId = "store", OwnerId = "owner", AuthorId = "owner", Source = WritingTeachingPolicy.Freeze(Entry.Writing!.Published!), SourceFingerprint = WritingTeachingPolicy.SourceFingerprint(Entry.Writing.Published!), Status = "ready", ActiveRunId = "run", LandscapeKey = "private-key", LandscapeSha256 = Convert.ToHexString(SHA256.HashData(new byte[] { 1, 2, 3 })).ToLowerInvariant() };
            teaching.ArtifactFingerprint = WritingTeachingPolicy.ArtifactFingerprint(teaching); return teaching;
        }
        public ValueTask DisposeAsync() => new(Db.Database.Client.DropDatabaseAsync(Db.Database.DatabaseNamespace.DatabaseName));
    }
    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value, WritingDocumentPolicy.JsonOptions).GetProperty("data");

    [Fact]
    public async Task ConcurrentSubmissionsQueueOneRunAndSameRequestReplaysWithoutAnotherRun()
    {
        await using var f = new Fixture(); await f.Init();
        var first = f.Request(new string('a', 32)); var second = f.Request(new string('b', 32));
        var results = await Task.WhenAll(f.Controller("GenerateWritingTeaching").GenerateWritingTeaching("entry", first), f.Controller("GenerateWritingTeaching").GenerateWritingTeaching("entry", second));
        Assert.Single(results.OfType<OkObjectResult>()); Assert.Single(results.OfType<ConflictObjectResult>());
        Assert.Equal(1, await f.Db.DocumentStoreAgentRuns.CountDocumentsAsync(_ => true));
        Assert.Equal(1, await f.Teachings.CountDocumentsAsync(_ => true));
        var winner = results[0] is OkObjectResult ? first : second;
        Data(await f.Controller("GenerateWritingTeaching").GenerateWritingTeaching("entry", winner));
        Assert.Equal(1, await f.Db.DocumentStoreAgentRuns.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task OldCreationDateDoesNotReleaseANewlyResumedQueueLockBeforeRunInsert()
    {
        await using var f = new Fixture(); await f.Init();
        var teaching = f.Ready(); teaching.Status = "queued"; teaching.CreatedAt = DateTime.UtcNow.AddDays(-1); teaching.UpdatedAt = DateTime.UtcNow; teaching.ActiveRunId = "new-run";
        await f.Teachings.InsertOneAsync(teaching);
        await f.Db.DocumentEntries.UpdateOneAsync(e => e.Id == "entry", Builders<DocumentEntry>.Update.Set(e => e.ActiveWritingTeachingId, teaching.Id).Set(e => e.WritingTeachingRunId, "new-run").Set(e => e.WritingTeachingClaimedAt, DateTime.UtcNow));
        Assert.Equal("queued", Data(await f.Controller("GetWritingTeaching").GetWritingTeaching("entry")).GetProperty("teaching").GetProperty("status").GetString());
        Assert.Equal("new-run", (await f.Db.DocumentEntries.Find(e => e.Id == "entry").SingleAsync()).WritingTeachingRunId);
        Assert.IsType<ConflictObjectResult>(await f.Controller("GenerateWritingTeaching").GenerateWritingTeaching("entry", f.Request(new string('c', 32))));
        Assert.Empty(await f.Db.DocumentStoreAgentRuns.Find(_ => true).ToListAsync());
    }

    [Fact]
    public async Task InterruptedResumeClaimRecoversWithoutDiscardingExistingSpeech()
    {
        await using var f = new Fixture(); await f.Init();
        var teaching = f.Ready(); teaching.Status = "failed"; teaching.Scenes.Add(new WritingTeachingScene { Id = "scene-1", SpeechRunId = "original-speech" });
        await f.Teachings.InsertOneAsync(teaching);
        await f.Db.DocumentEntries.UpdateOneAsync(e => e.Id == "entry", Builders<DocumentEntry>.Update.Set(e => e.ActiveWritingTeachingId, teaching.Id)
            .Set(e => e.WritingTeachingRunId, "interrupted-before-state-write").Set(e => e.WritingTeachingClaimedAt, DateTime.UtcNow.AddMinutes(-6)));
        Data(await f.Controller("GetWritingTeaching").GetWritingTeaching("entry"));
        Assert.Null((await f.Db.DocumentEntries.Find(e => e.Id == "entry").SingleAsync()).WritingTeachingRunId);
        Data(await f.Controller("ResumeWritingTeaching").ResumeWritingTeaching("entry", teaching.Id, new WritingTeachingResumeRequest { Revision = teaching.Revision }));
        var restored = await f.Teachings.Find(t => t.Id == teaching.Id).SingleAsync();
        Assert.Equal("queued", restored.Status); Assert.Equal("original-speech", restored.Scenes[0].SpeechRunId);
        Assert.Equal(1, await f.Db.DocumentStoreAgentRuns.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task SkippingSourceDuringReconciliationResumesDerivedWorkWithoutRewritingBody()
    {
        await using var f = new Fixture(); await f.Init();
        var state = f.Entry.Writing!; state.Stage = "generating"; state.ActiveRunId = "reconcile-old";
        state.Sections = WritingTeachingPolicy.Freeze(state.Published!).Sections;
        state.Sections[0].Paragraphs[0].Citations.Add("S1"); state.Sections[0].Paragraphs[0].Status = "src";
        state.Sources.Add(new WritingSource { Id = "S1", EntryId = "reference", Status = "read", Content = "资料正文" });
        await f.Db.DocumentEntries.ReplaceOneAsync(e => e.Id == "entry", f.Entry);
        await f.Db.DocumentStoreAgentRuns.InsertOneAsync(new DocumentStoreAgentRun { Id = state.ActiveRunId, Kind = WritingDeliveryPolicy.ReconcileRunKind,
            SourceEntryId = "entry", StoreId = "store", UserId = "owner", Status = DocumentStoreRunStatus.Queued });
        Data(await f.Controller("CommandWritingDocument").CommandWritingDocument("entry", new WritingCommandRequest { Revision = state.Revision, Action = "skip-source", SourceId = "S1" }));
        var restored = (await f.Db.DocumentEntries.Find(e => e.Id == "entry").SingleAsync()).Writing!;
        var next = await f.Db.DocumentStoreAgentRuns.Find(r => r.Id == restored.ActiveRunId).SingleAsync();
        Assert.Equal(WritingDeliveryPolicy.ReconcileRunKind, next.Kind);
        Assert.Equal("失败停止，不得重复提交", restored.Sections[0].Paragraphs[0].Text);
        Assert.Empty(restored.Sections[0].Paragraphs[0].Citations); Assert.False(restored.Sections[0].Paragraphs[0].Confirmed);
        Assert.Equal(1, restored.Published!.Version);
        restored.Stage = "failed";
        await f.Db.DocumentEntries.UpdateOneAsync(e => e.Id == "entry", Builders<DocumentEntry>.Update.Set(e => e.Writing, restored));
        Data(await f.Controller("GenerateWritingDraft").GenerateWritingDraft("entry", new WritingCommandRequest { Revision = restored.Revision }));
        var retryState = (await f.Db.DocumentEntries.Find(e => e.Id == "entry").SingleAsync()).Writing!;
        Assert.Equal(WritingDeliveryPolicy.ReconcileRunKind, (await f.Db.DocumentStoreAgentRuns.Find(r => r.Id == retryState.ActiveRunId).SingleAsync()).Kind);
        Assert.Equal("失败停止，不得重复提交", retryState.Sections[0].Paragraphs[0].Text);
    }

    [Fact]
    public async Task ExcessAuthorIntentOrRolesAreRejectedInsteadOfSilentlyDroppingInformation()
    {
        await using var f = new Fixture(); await f.Init();
        var controller = f.Controller("SaveWritingDocument");
        Assert.IsType<BadRequestObjectResult>(await controller.SaveWritingDocument("entry", new WritingSaveRequest { Revision = f.Entry.Writing!.Revision,
            IntentPoints = Enumerable.Range(1, 21).Select(i => "必达点" + i).ToList() }));
        Assert.IsType<BadRequestObjectResult>(await controller.SaveWritingDocument("entry", new WritingSaveRequest { Revision = f.Entry.Writing.Revision,
            Roles = Enumerable.Range(1, 21).Select(i => new WritingRole { Label = "角色" + i, Action = "必须核对", SectionId = "s1" }).ToList() }));
        Assert.Equal(f.Entry.Writing.Revision, (await f.Db.DocumentEntries.Find(e => e.Id == "entry").SingleAsync()).Writing!.Revision);
    }

    [Fact]
    public async Task ApprovalNamesExactSourceAndNewVersionNeverAdoptsOldCourse()
    {
        await using var f = new Fixture(); await f.Init();
        var teaching = f.Ready(); await f.Teachings.InsertOneAsync(teaching);
        await f.Db.Database.GetCollection<WritingPublicationRecord>("document_writing_publications").InsertOneAsync(new WritingPublicationRecord { EntryId = "entry", StoreId = "store", Publication = WritingTeachingPolicy.Freeze(teaching.Source) });
        f.Entry.Writing!.Published!.Version = 2; f.Entry.Writing.Published.Sections[0].Condition = "新版本条件";
        await f.Db.DocumentEntries.ReplaceOneAsync(e => e.Id == "entry", f.Entry);
        var controller = f.Controller("ApproveWritingTeaching");
        var approval = new WritingTeachingApproval { Revision = teaching.Revision, ArtifactFingerprint = teaching.ArtifactFingerprint, SourceVersion = 2, SourceFingerprint = teaching.SourceFingerprint };
        Assert.IsType<ConflictObjectResult>(await controller.ApproveWritingTeaching("entry", teaching.Id, approval));
        approval.SourceVersion = 1; Data(await controller.ApproveWritingTeaching("entry", teaching.Id, approval));
        Assert.Equal(JsonValueKind.Null, Data(await controller.ReadWritingPublication("entry", 2)).GetProperty("teaching").ValueKind);
        Assert.Equal(teaching.Id, Data(await controller.ReadWritingPublication("entry", 1, course: teaching.Id)).GetProperty("teaching").GetProperty("id").GetString());
    }

    [Fact]
    public async Task ReadersGetConfirmedContentWithoutAuthorInstructionsOrUnpublishedChanges()
    {
        await using var f = new Fixture(); await f.Init();
        var template = WritingDeliveryPolicy.ImportTemplate("org-private", "交接模版", "## 执行条件\n仅供作者的秘密提示-1979");
        var state = f.Entry.Writing!; state.TemplateSnapshot = template; state.Published!.TemplateSnapshot = WritingDeliveryPolicy.CopyTemplate(template);
        state.ManualInput = "未发布私有输入-1979"; state.Stage = "confirm"; state.Sections = WritingTeachingPolicy.Freeze(state.Published).Sections;
        state.Sections[0].Paragraphs[0].Text = "未发布修改-1979";
        await f.Db.DocumentEntries.ReplaceOneAsync(e => e.Id == "entry", f.Entry);
        await f.Db.Database.GetCollection<WritingTemplateDocument>("document_writing_templates").InsertOneAsync(new WritingTemplateDocument { StoreId = "store", Template = template, CreatedBy = "owner" });
        var reader = f.Controller("ReadWritingPublication", "reader");
        foreach (var response in new[] { await reader.GetEntry("entry"), await reader.ReadWritingPublication("entry"),
            await reader.ReadWritingPublication("entry", overview: true), await reader.ReadWritingCollection("store") }) {
            var json = JsonSerializer.Serialize(Data(response), new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            Assert.DoesNotContain("秘密提示", json); Assert.DoesNotContain("未发布修改", json); Assert.DoesNotContain("私有输入", json);
        }
        var stored = (await f.Db.DocumentEntries.Find(e => e.Id == "entry").SingleAsync()).Writing!;
        Assert.Contains("秘密提示", stored.Published!.TemplateSnapshot!.Headings[0].Hint);
        var author = Data(await f.Controller("GetWritingDocument").GetWritingDocument("entry")).GetProperty("state");
        Assert.Contains("私有输入", author.GetProperty("manualInput").GetString());
        Assert.Contains("秘密提示", author.GetProperty("templateSnapshot").GetProperty("headings")[0].GetProperty("hint").GetString());
    }

    [Fact]
    public async Task DraftMediaIsHiddenFromReadersAndApprovedMediaRechecksLibraryPermission()
    {
        await using var f = new Fixture(); await f.Init(); var teaching = f.Ready();
        await f.Teachings.InsertOneAsync(teaching);
        var reader = f.Controller("ReadWritingTeachingMedia", "reader");
        var denied = Assert.IsType<ObjectResult>(await reader.ReadWritingTeachingMedia("entry", teaching.Id)); Assert.Equal(403, denied.StatusCode);
        f.Assets.Verify(a => a.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        var bytes = f.Protection.CreateProtector("writing-teaching", "store", teaching.Id).Protect(new byte[] { 1, 2, 3 });
        f.Assets.Setup(a => a.TryDownloadBytesAsync("private-key", It.IsAny<CancellationToken>())).ReturnsAsync(bytes);
        await f.Teachings.UpdateOneAsync(t => t.Id == teaching.Id, Builders<WritingTeaching>.Update.Set(t => t.Status, "approved"));
        var media = Assert.IsType<FileContentResult>(await reader.ReadWritingTeachingMedia("entry", teaching.Id)); Assert.True(media.EnableRangeProcessing);
        await f.Db.DocumentStores.UpdateOneAsync(s => s.Id == "store", Builders<DocumentStore>.Update.Set(s => s.IsPublic, false));
        Assert.IsType<NotFoundObjectResult>(await reader.ReadWritingTeachingMedia("entry", teaching.Id));
    }
}
