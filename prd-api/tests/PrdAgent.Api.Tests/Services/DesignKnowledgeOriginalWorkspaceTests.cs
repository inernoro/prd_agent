using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;
using Xunit.Abstractions;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Infrastructure.Services.DocumentStore;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.Integration)]
public sealed class DesignKnowledgeOriginalWorkspaceTests
{
    private readonly ITestOutputHelper _output;
    public DesignKnowledgeOriginalWorkspaceTests(ITestOutputHelper output) => _output = output;

    [Fact]
    public async Task OrdinaryUpload_FrozenKnowledge_PrepareContainsOriginalBytesAndNoStorageKey()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        _output.WriteLine("synthetic-original kind=txt sha256={0} bytes={1}", Hash(f.UploadBytes), f.UploadBytes.Length);
        Assert.False(string.IsNullOrWhiteSpace(f.Attachment.StorageKey));
        var refs = await f.ReferencesAsync();
        var snapshot = await f.Resolver.ResolveWorkspaceForRunAsync("owner", refs, default);
        var run = await f.NewRunAsync(snapshot.KnowledgeReferences, snapshot.Originals);
        await f.Broker().PrepareAsync(run, null, default);
        var package = await f.PackageAsync(run);
        Assert.Equal(3, package.Files.Count);
        var original = Assert.Single(package.Files, x => x.Path.EndsWith("/source.txt", StringComparison.Ordinal));
        Assert.Equal(f.UploadBytes, Convert.FromBase64String(original.ContentBase64));
        Assert.Equal(Hash(f.UploadBytes), original.Sha256);
        var publicSnapshot = JsonSerializer.Serialize(run.KnowledgeReferences, DesignArtifactWorkspaceContract.JsonOptions);
        Assert.DoesNotContain(f.Attachment.StorageKey!, publicSnapshot);
        var task = Encoding.UTF8.GetString(Convert.FromBase64String(package.Files[0].ContentBase64));
        Assert.DoesNotContain(f.Attachment.StorageKey!, task);
        Assert.Contains(original.Sha256, task);
        Assert.DoesNotContain(f.Attachment.StorageKey!, JsonSerializer.Serialize(run));
    }

    [Fact]
    public async Task OrdinaryDocxUpload_RoundTripsRawBinaryAndBsonWithoutBreakingOldRunReader()
    {
        await using var f = await Fixture.CreateAsync();
        f.UploadBytes = Docx();
        Assert.Contains(f.UploadBytes, b => b > 127);
        await f.UploadAsync(fileName: "source.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        _output.WriteLine("synthetic-original kind=docx sha256={0} bytes={1}", Hash(f.UploadBytes), f.UploadBytes.Length);
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("owner", await f.ReferencesAsync(), default);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        run = await f.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(f.Attachment.StorageKey, run.KnowledgeOriginals!.References[0].File!.StorageKey);
        var document = run.ToBsonDocument();
        var old = BsonSerializer.Deserialize<LegacyRunShape>(document);
        Assert.Equal(run.KnowledgeReferences[0].ContentHash, old.KnowledgeReferences[0].ContentHash);
        // This proves adding fields to the old nested type would fail; the Run
        // level is the actual deployed extension boundary, not a new annotation.
        document["KnowledgeReferences"].AsBsonArray[0].AsBsonDocument["OriginalFileSnapshotVersion"] = 1;
        Assert.Throws<FormatException>(() => BsonSerializer.Deserialize<LegacyRunShape>(document));
        await f.Broker().PrepareAsync(run, null, default);
        var original = Assert.Single((await f.PackageAsync(run)).Files, x => x.Path.EndsWith("/source.docx", StringComparison.Ordinal));
        Assert.Equal(f.UploadBytes, Convert.FromBase64String(original.ContentBase64));
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("missing")]
    [InlineData("key")]
    [InlineData("mime")]
    [InlineData("name")]
    [InlineData("size")]
    [InlineData("binding")]
    [InlineData("permission")]
    public async Task Prepare_RejectsChangedOriginalOrPermissionBeforeInputIsPersisted(string change)
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("owner", await f.ReferencesAsync(), default);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        switch (change)
        {
            case "bytes":
                var changed = f.UploadBytes.ToArray(); changed[0] ^= 1;
                f.Storage.Setup(x => x.TryDownloadBytesAsync(f.Attachment.StorageKey!, It.IsAny<CancellationToken>())).ReturnsAsync(changed); break;
            case "missing": f.Storage.Setup(x => x.TryDownloadBytesAsync(f.Attachment.StorageKey!, It.IsAny<CancellationToken>())).ReturnsAsync((byte[]?)null); break;
            case "key": f.Attachment.StorageKey = "prd-agent/doc/replaced.txt"; break;
            case "mime": f.Attachment.MimeType = "application/octet-stream"; break;
            case "name": f.Attachment.FileName = "different.txt"; break;
            case "size": f.Attachment.Size++; break;
            case "binding":
                await f.Db.DocumentEntries.UpdateOneAsync(x => x.Id == f.Entry.Id, Builders<DocumentEntry>.Update.Set(x => x.AttachmentId, null)); break;
            case "permission":
                await f.Db.DocumentStores.UpdateOneAsync(x => x.Id == f.Store.Id, Builders<DocumentStore>.Update.Set(x => x.OwnerId, "other")); break;
        }
        if (change is "key" or "mime" or "name" or "size")
            await f.Db.Attachments.ReplaceOneAsync(x => x.AttachmentId == f.Attachment.AttachmentId, f.Attachment);
        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Broker().PrepareAsync(run, null, default));
        await f.AssertUnpreparedAsync(run);
    }

    [Fact]
    public async Task Prepare_RejectsPermissionRevokedDuringOriginalRead()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("owner", await f.ReferencesAsync(), default);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        f.BeforeRead = async _ => await f.Db.DocumentStores.UpdateOneAsync(x => x.Id == f.Store.Id, Builders<DocumentStore>.Update.Set(x => x.OwnerId, "other"));
        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Broker().PrepareAsync(run, null, default));
        await f.AssertUnpreparedAsync(run);
    }

    [Fact]
    public async Task LegacyRun_DoesNotBackfillOriginals_AndTextResolutionNeedsNoBinaryStorage()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        await f.Db.Attachments.UpdateOneAsync(x => x.AttachmentId == f.Attachment.AttachmentId,
            Builders<Attachment>.Update.Set(x => x.StorageKey, null).Set(x => x.Url, "https://untrusted.example/private-source"));
        var refs = await f.ReferencesAsync();
        var legacy = await f.Resolver.ResolveForRunAsync("owner", refs, default);
        Assert.Empty(f.Reads);
        var run = await f.NewRunAsync(legacy);
        await f.Broker().PrepareAsync(run, null, default);
        Assert.Equal(2, (await f.PackageAsync(run)).Files.Count);
        Assert.Null(run.KnowledgeOriginals);
        Assert.Empty(f.Reads);
        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Resolver.ResolveWorkspaceForRunAsync("owner", refs, default));
        Assert.Empty(f.Reads); // A URL is not a trusted object key.
    }

    [Fact]
    public async Task DocumentOnly_IsExplicitlyFrozenWithoutOriginal_ThenAttachmentInsertionIsRejected()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        await f.Db.DocumentEntries.UpdateOneAsync(x => x.Id == f.Entry.Id, Builders<DocumentEntry>.Update.Set(x => x.AttachmentId, null));
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("owner", await f.ReferencesAsync(), default);
        Assert.Null(Assert.Single(frozen.Originals.References).File);
        Assert.Empty(f.Reads);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        await f.Broker().PrepareAsync(run, null, default);
        Assert.Equal(2, (await f.PackageAsync(run)).Files.Count);
        run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        await f.Db.DocumentEntries.UpdateOneAsync(x => x.Id == f.Entry.Id, Builders<DocumentEntry>.Update.Set(x => x.AttachmentId, f.Attachment.AttachmentId));
        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Broker().PrepareAsync(run, null, default));
        await f.AssertUnpreparedAsync(run);
    }

    [Fact]
    public async Task OversizedBinary_DoesNotRestrictTextOnlyCallers_ButCannotCreateWorkspaceSnapshot()
    {
        await using var f = await Fixture.CreateAsync();
        f.UploadBytes = Docx(checked((int)DesignArtifactWorkspaceBroker.MaxInputBytes + 4096));
        Assert.True(f.UploadBytes.Length > DesignArtifactWorkspaceBroker.MaxInputBytes);
        await f.UploadAsync(fileName: "source.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        var refs = await f.ReferencesAsync();
        Assert.Single(await f.Resolver.ResolveForRunAsync("owner", refs, default));
        Assert.Empty(f.Reads);
        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Resolver.ResolveWorkspaceForRunAsync("owner", refs, default));
        Assert.Empty(f.Reads);
    }

    [Fact]
    public async Task ReadablePublicKnowledge_CanFreezeOriginal_ButCannotGrantUploadPermission()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        await f.Db.DocumentStores.UpdateOneAsync(x => x.Id == f.Store.Id, Builders<DocumentStore>.Update.Set(x => x.IsPublic, true));
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("reader", await f.ReferencesAsync(), default);
        Assert.NotNull(frozen.Originals.References[0].File);
        Assert.IsType<NotFoundObjectResult>(await f.UploadResultAsync("reader"));
    }

    [Fact]
    public async Task OriginalContentHash_ParticipatesInBaseRevisionEvenWhenTextIsUnchanged()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        var refs = await f.ReferencesAsync();
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("owner", refs, default);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        var files = await f.Resolver.ReadWorkspaceOriginalsAsync("owner", frozen.KnowledgeReferences, frozen.Originals, default);
        var first = DesignArtifactWorkspaceContract.BuildInputPackage(run, null, originalFiles: files).BaseRevision;
        var changed = f.UploadBytes.ToArray(); changed[0] ^= 1;
        f.Storage.Setup(x => x.TryDownloadBytesAsync(f.Attachment.StorageKey!, It.IsAny<CancellationToken>())).ReturnsAsync(changed);
        var next = await f.Resolver.ResolveWorkspaceForRunAsync("owner", refs, default);
        Assert.Equal(frozen.KnowledgeReferences[0].ContentHash, next.KnowledgeReferences[0].ContentHash);
        files = await f.Resolver.ReadWorkspaceOriginalsAsync("owner", next.KnowledgeReferences, next.Originals, default);
        Assert.NotEqual(first, DesignArtifactWorkspaceContract.BuildInputPackage(run, null, originalFiles: files).BaseRevision);
    }

    [Fact]
    public async Task WorkspaceOriginals_MissingReaderFailsClosed_WithoutPreparingInput()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("owner", await f.ReferencesAsync(), default);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Broker(includeResolver: false).PrepareAsync(run, null, default));
        await f.AssertUnpreparedAsync(run);
    }

    private static byte[] Docx(int binaryBytes = 0)
    {
        using var stream = new MemoryStream();
        using (var document = WordprocessingDocument.Create(stream, DocumentFormat.OpenXml.WordprocessingDocumentType.Document))
        {
            var main = document.AddMainDocumentPart();
            main.Document = new Document(new Body(new Paragraph(new DocumentFormat.OpenXml.Wordprocessing.Run(new Text("Synthetic document with original binary bytes.")))));
            if (binaryBytes > 0)
            {
                var image = main.AddImagePart(ImagePartType.Png);
                using var content = new MemoryStream(RandomNumberGenerator.GetBytes(binaryBytes));
                image.FeedData(content); // Unreferenced binary part does not enlarge extracted prose.
            }
            main.Document.Save();
        }
        return stream.ToArray();
    }

    [Theory]
    [InlineData(false, DesignArtifactRuntimes.OpenDesign, false)]
    [InlineData(true, DesignArtifactRuntimes.OpenDesign, false)]
    [InlineData(false, DesignArtifactRuntimes.MapGateway, false)]
    [InlineData(true, DesignArtifactRuntimes.MapGateway, false)]
    [InlineData(false, DesignArtifactRuntimes.OpenDesign, true)]
    [InlineData(true, DesignArtifactRuntimes.OpenDesign, true)]
    [InlineData(false, DesignArtifactRuntimes.MapGateway, true)]
    [InlineData(true, DesignArtifactRuntimes.MapGateway, true)]
    public async Task CreationEntryPoints_FreezeOnlyWorkspaceRuntime_BeforeQueueing_AndRejectMissingKey(bool edit, string runtime, bool missingKey)
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        if (missingKey) await f.Db.Attachments.UpdateOneAsync(x => x.AttachmentId == f.Attachment.AttachmentId, Builders<Attachment>.Update.Set(x => x.StorageKey, null));
        var refs = await f.ReferencesAsync();
        var provider = new Mock<IDesignArtifactProviderCatalog>(MockBehavior.Strict);
        provider.Setup(x => x.FindAsync("owner", runtime, CancellationToken.None)).ReturnsAsync(new DesignArtifactProviderCapability(
            runtime, runtime, runtime == DesignArtifactRuntimes.OpenDesign ? DesignArtifactAdapterKinds.RemoteAgent : DesignArtifactAdapterKinds.InProcess,
            runtime == DesignArtifactRuntimes.OpenDesign ? DesignArtifactExecutionOwners.CdsRemoteAgent : DesignArtifactExecutionOwners.Map,
            runtime == DesignArtifactRuntimes.OpenDesign ? DesignArtifactIsolationModes.SessionContainer : DesignArtifactIsolationModes.Process,
            [DesignArtifactTypes.WebPage], [DesignArtifactOperations.Edit, DesignArtifactOperations.Generate], [DesignArtifactSourceSurfaces.WebHosting],
            Configured: true, Healthy: true, Enabled: true, Reason: null, ConnectionId: "test-connection"));
        var queue = new Mock<IRunQueue>(MockBehavior.Strict);
        queue.Setup(x => x.EnqueueAsync(RunKinds.DesignArtifact, It.IsAny<string>(), CancellationToken.None))
            .Returns(async (string kind, string id, CancellationToken ct) =>
            {
                var persisted = await f.Db.DesignArtifactRuns.Find(x => x.Id == id).SingleAsync(ct);
                Assert.Equal(runtime == DesignArtifactRuntimes.OpenDesign, persisted.KnowledgeOriginals != null);
                if (persisted.KnowledgeOriginals != null)
                    Assert.Equal(f.Attachment.StorageKey, Assert.Single(persisted.KnowledgeOriginals.References).File!.StorageKey);
            });
        var context = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "owner")], "test")) } };
        IActionResult result;
        if (edit)
        {
            const string html = "<!doctype html><html><body>safe</body></html>";
            var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
            sites.Setup(x => x.GetEditableEntryHtmlAsync("site", "owner", CancellationToken.None)).ReturnsAsync(new HostedSiteEditableEntry(
                new HostedSite { Id = "site", OwnerUserId = "owner", EntryFile = "index.html", Files = [new() { Path = "index.html", CosKey = "site/index.html", MimeType = "text/html", Size = Encoding.UTF8.GetByteCount(html) }] }, html, DateTime.UtcNow));
            var controller = new HostedSiteEditsController(sites.Object, Mock.Of<IHostedSiteRevisionService>(), Mock.Of<IRunEventStore>(), queue.Object,
                f.Db, NullLogger<HostedSiteEditsController>.Instance, provider.Object, f.Resolver, null!, null!, new ConfigurationBuilder().Build()) { ControllerContext = context };
            result = await controller.CreateRun("site", new CreateHostedSiteEditRunRequest { Runtime = runtime, Instruction = "Use the synthetic source", KnowledgeReferences = [new() { EntryId = f.Entry.Id, StoreId = f.Store.Id, ContentHash = refs[0].ExpectedContentHash }] });
        }
        else
        {
            var controller = new DesignArtifactsController(f.Db, Mock.Of<IRunEventStore>(), queue.Object, provider.Object, f.Resolver, null!, null!, new ConfigurationBuilder().Build()) { ControllerContext = context };
            result = await controller.CreateRun(new CreateDesignArtifactRunRequest { ArtifactType = DesignArtifactTypes.WebPage, Runtime = runtime, Instruction = "Use the synthetic source", KnowledgeReferences = [new() { EntryId = f.Entry.Id, StoreId = f.Store.Id, ContentHash = refs[0].ExpectedContentHash }] });
        }
        if (missingKey && runtime == DesignArtifactRuntimes.OpenDesign)
        {
            var rejected = Assert.IsType<BadRequestObjectResult>(result);
            Assert.Contains("可信存储引用", JsonSerializer.Serialize(rejected.Value, new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
            Assert.Equal(0, await f.Db.DesignArtifactRuns.CountDocumentsAsync(_ => true));
            queue.Verify(x => x.EnqueueAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        }
        else
        {
            var accepted = Assert.IsType<AcceptedResult>(result);
            Assert.DoesNotContain(f.Attachment.StorageKey!, JsonSerializer.Serialize(accepted.Value));
            var persisted = await f.Db.DesignArtifactRuns.Find(_ => true).SingleAsync();
            Assert.Equal(runtime == DesignArtifactRuntimes.OpenDesign, persisted.KnowledgeOriginals != null);
            queue.Verify(x => x.EnqueueAsync(RunKinds.DesignArtifact, persisted.Id, CancellationToken.None), Times.Once);
        }
        if (runtime == DesignArtifactRuntimes.MapGateway) Assert.Empty(f.Reads);
    }

    [Fact]
    public async Task StorageFailureIsSafeAndCancellationIsNotRewritten_BeforePreparePersistence()
    {
        await using var f = await Fixture.CreateAsync();
        await f.UploadAsync();
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("owner", await f.ReferencesAsync(), default);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        f.Storage.Setup(x => x.TryDownloadBytesAsync(f.Attachment.StorageKey!, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("private-storage-diagnostic " + f.Attachment.StorageKey));
        var failure = await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Broker().PrepareAsync(run, null, default));
        Assert.DoesNotContain("private-storage-diagnostic", failure.Message);
        Assert.DoesNotContain(f.Attachment.StorageKey!, failure.Message);
        await f.AssertUnpreparedAsync(run);
        f.Storage.Setup(x => x.TryDownloadBytesAsync(f.Attachment.StorageKey!, It.IsAny<CancellationToken>())).ThrowsAsync(new OperationCanceledException());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => f.Broker().PrepareAsync(run, null, default));
        await f.AssertUnpreparedAsync(run);
    }

    [BsonIgnoreExtraElements]
    private sealed class LegacyRunShape
    {
        public List<LegacyKnowledgeShape> KnowledgeReferences { get; set; } = [];
    }
    private sealed class LegacyKnowledgeShape
    {
        public string EntryId { get; set; } = "";
        public string? StoreId { get; set; }
        public string? StoreName { get; set; }
        public string Title { get; set; } = "";
        public string Content { get; set; } = "";
        public string ContentHash { get; set; } = "";
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    [Fact]
    public async Task OriginalAuthorization_CopiedKnownTextMustNotRestoreRevokedBinaryAccess()
    {
        await using var f = await Fixture.CreateAsync();
        f.UploadBytes = Docx(1024);
        await f.UploadAsync(fileName: "source.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        var knownText = f.Attachment.ExtractedText!;
        var readerStore = new DocumentStore { OwnerId = "reader", Name = "Reader workspace" };
        await f.Db.DocumentStores.InsertOneAsync(readerStore);
        await f.Db.DocumentStores.UpdateOneAsync(x => x.Id == f.Store.Id, Builders<DocumentStore>.Update.Set(x => x.IsPublic, true));
        var controller = f.DocumentController("reader");
        Assert.IsType<OkObjectResult>(await controller.AddEntry(readerStore.Id, new AddDocumentEntryRequest
        { Title = "Known text remount", AttachmentId = f.Attachment.AttachmentId }));
        var copy = await f.Db.DocumentEntries.Find(x => x.StoreId == readerStore.Id).SingleAsync();
        Assert.IsType<OkObjectResult>(await controller.UpdateEntryContent(copy.Id, new UpdateEntryContentRequest { Content = knownText }));
        copy = await f.Db.DocumentEntries.Find(x => x.Id == copy.Id).SingleAsync();
        Assert.Equal(f.Attachment.AttachmentId, copy.AttachmentId);
        Assert.Equal(knownText.Trim(), copy.ContentIndex);
        var visible = Assert.Single(await f.Resolver.ResolveAsync("reader", [new(copy.Id, readerStore.Id)], default));
        IReadOnlyList<DesignKnowledgeReferenceIdentity> refs = [new(copy.Id, readerStore.Id, visible.ContentHash)];
        var frozen = await f.Resolver.ResolveWorkspaceForRunAsync("reader", refs, default);
        Assert.NotNull(Assert.Single(frozen.Originals.References).File); // Still-public original may authorize the binary.
        await f.Db.DocumentStores.UpdateOneAsync(x => x.Id == f.Store.Id, Builders<DocumentStore>.Update.Set(x => x.IsPublic, false));
        Assert.Single(await f.Resolver.ResolveForRunAsync("reader", refs, default)); // Existing copied text remains readable.
        f.Reads.Clear();
        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Resolver.ResolveWorkspaceForRunAsync("reader", refs, default));
        Assert.Empty(f.Reads);
        var run = await f.NewRunAsync(frozen.KnowledgeReferences, frozen.Originals);
        run.UserId = "reader";
        await f.Db.DesignArtifactRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() => f.Broker().PrepareAsync(run, null, default));
        Assert.Empty(f.Reads);
        await f.AssertUnpreparedAsync(run);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _database = "knowledge_original_" + Guid.NewGuid().ToString("N");
        private readonly string _root = Path.Combine(Path.GetTempPath(), "knowledge-original-" + Guid.NewGuid().ToString("N"));
        private readonly MongoClient _client;
        internal MongoDbContext Db { get; }
        internal LocalAssetStorage Local { get; }
        internal Mock<IAssetStorage> Storage { get; } = new(MockBehavior.Strict);
        internal DesignKnowledgeSnapshotResolver Resolver { get; }
        internal Mock<ITeamService> Teams { get; } = new();
        internal Mock<IAdminPermissionService> Permissions { get; } = new();
        internal DocumentStore Store { get; } = new() { Id = Guid.NewGuid().ToString("N"), OwnerId = "owner", Name = "Synthetic files" };
        internal DocumentEntry Entry = null!;
        internal Attachment Attachment = null!;
        internal byte[] UploadBytes = Encoding.UTF8.GetBytes("Synthetic original document content.");
        internal List<string> Reads { get; } = [];
        internal Func<string, Task>? BeforeRead;

        private Fixture(string connection)
        {
            _client = new MongoClient(connection);
            Db = new MongoDbContext(connection, _database);
            Local = new LocalAssetStorage(_root);
            Storage.Setup(s => s.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
                .Returns((byte[] bytes, string mime, CancellationToken ct, string? domain, string? type, string? name, string? ext) => Local.SaveAsync(bytes, mime, ct, domain, type, name, ext));
            Storage.Setup(s => s.TryBuildContentAddressedKey(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
                .Returns((byte[] bytes, string mime, string? domain, string? type, string? name, string? ext) => Local.TryBuildContentAddressedKey(bytes, mime, domain, type, name, ext));
            Storage.Setup(s => s.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns(async (string key, CancellationToken ct) => { Reads.Add(key); if (BeforeRead != null) await BeforeRead(key); return await Local.TryDownloadBytesAsync(key, ct); });
            Teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            Permissions.Setup(p => p.GetEffectivePermissionsAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            Resolver = ActivatorUtilities.CreateInstance<DesignKnowledgeSnapshotResolver>(new ServiceCollection()
                .AddSingleton(Storage.Object).BuildServiceProvider(), Db, Teams.Object, Permissions.Object);
        }

        internal static async Task<Fixture> CreateAsync()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? throw new InvalidOperationException("Explicit isolated MONGODB_TEST_CONNECTION required");
            var f = new Fixture(connection);
            await f.Db.DocumentStores.InsertOneAsync(f.Store);
            return f;
        }

        internal async Task UploadAsync(string user = "owner", string fileName = "source.txt", string mime = "text/plain")
        {
            Assert.IsType<OkObjectResult>(await UploadResultAsync(user, fileName, mime));
            Entry = await Db.DocumentEntries.Find(e => e.StoreId == Store.Id).SingleAsync();
            Attachment = await Db.Attachments.Find(a => a.AttachmentId == Entry.AttachmentId).SingleAsync();
        }

        internal DocumentStoreController DocumentController(string user)
        {
            var documents = new Mock<IDocumentService>();
            documents.Setup(d => d.ParseAsync(It.IsAny<string>())).ReturnsAsync((string content) => new ParsedPrd { Id = Guid.NewGuid().ToString("N"), RawContent = content });
            documents.Setup(d => d.SaveAsync(It.IsAny<ParsedPrd>())).Returns(async (ParsedPrd document) => { await Db.Documents.InsertOneAsync(document); return document; });
            var mentions = new MentionService(Db);
            var versions = new DocumentVersionService(Db);
            return new DocumentStoreController(Db, Storage.Object,
                new FileContentExtractor(NullLogger<FileContentExtractor>.Instance), documents.Object,
                Mock.Of<IRunEventStore>(), null!, null!, Teams.Object, Mock.Of<ITeamActivityService>(), mentions, versions,
                Permissions.Object, null!, null!, null!, null!, new ConfigurationBuilder().Build(),
                new DocumentStoreAssetNormalizer(Storage.Object, NullLogger<DocumentStoreAssetNormalizer>.Instance), null!,
                new DocumentAssetCleanupService(Db, Storage.Object, NullLogger<DocumentAssetCleanupService>.Instance),
                new EntryContentWriteService(Db, documents.Object, mentions, versions, NullLogger<EntryContentWriteService>.Instance), NullLogger<DocumentStoreController>.Instance)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext
                { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", user)], "test")) } },
            };
        }

        internal async Task<IActionResult> UploadResultAsync(string user, string fileName = "source.txt", string mime = "text/plain")
        {
            using var stream = new MemoryStream(UploadBytes);
            var file = new FormFile(stream, 0, UploadBytes.Length, "file", fileName)
            { Headers = new HeaderDictionary(), ContentType = mime };
            return await DocumentController(user).UploadFile(Store.Id, file);
        }

        internal async Task<IReadOnlyList<DesignKnowledgeReferenceIdentity>> ReferencesAsync()
        {
            var source = Assert.Single(await Resolver.ResolveAsync("owner", [new(Entry.Id, Store.Id)], default));
            return [new(Entry.Id, Store.Id, source.ContentHash)];
        }
        internal async Task<DesignArtifactRun> NewRunAsync(IReadOnlyList<DesignKnowledgeSnapshot> snapshots, DesignKnowledgeOriginalSnapshot? originals = null)
        {
            var run = new DesignArtifactRun { UserId = "owner", Runtime = DesignArtifactRuntimes.OpenDesign,
                Operation = DesignArtifactOperations.Generate, Status = RunStatuses.Running, LeaseOwnerId = "worker", LeaseExpiresAt = DateTime.UtcNow.AddMinutes(5),
                KnowledgeReferences = snapshots.ToList(), KnowledgeOriginals = originals };
            await Db.DesignArtifactRuns.InsertOneAsync(run);
            return run;
        }
        internal DesignArtifactWorkspaceBroker Broker(bool includeResolver = true) => ActivatorUtilities.CreateInstance<DesignArtifactWorkspaceBroker>(
            (includeResolver ? new ServiceCollection().AddSingleton<IDesignKnowledgeSnapshotResolver>(Resolver) : new ServiceCollection()).BuildServiceProvider(),
            Db, Storage.Object, new EphemeralDataProtectionProvider(),
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["DesignArtifactRuntime:PublicBaseUrl"] = "https://map.example.test" }).Build());
        internal async Task<DesignWorkspacePackage> PackageAsync(DesignArtifactRun run) => JsonSerializer.Deserialize<DesignWorkspacePackage>(
            (await Local.TryDownloadBytesAsync(run.WorkspaceInputAssetKey!, default))!, DesignArtifactWorkspaceContract.JsonOptions)!;
        internal async Task AssertUnpreparedAsync(DesignArtifactRun run)
        {
            var persisted = await Db.DesignArtifactRuns.Find(x => x.Id == run.Id).SingleAsync();
            Assert.Null(persisted.WorkspaceInputAssetKey);
            Assert.Null(persisted.WorkspaceInputSha256);
        }
        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_database);
            Directory.Delete(_root, recursive: true);
        }
    }
}
