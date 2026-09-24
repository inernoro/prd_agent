using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.Integration)]
public sealed class DesignWorkspaceCurrentFilesTests
{
    [Theory]
    [InlineData(511, true)]
    [InlineData(512, true)]
    [InlineData(513, false)]
    public void CompleteInput_EnforcesActualCds512FileContractIncludingBriefKnowledgeAndOriginals(int count, bool accepted)
    {
        var run = new DesignArtifactRun { KnowledgeReferences = [new() { EntryId = "entry", Title = "Synthetic", Content = "body" }] };
        var originals = new[] { new DesignWorkspaceFile("knowledge/01-source/source.pdf", "AQ==", Hash([1]), 1, "application/pdf") };
        var current = Enumerable.Range(0, count - 3).Select(i =>
            new DesignWorkspaceFile($"current/file-{i}.css", "", Hash([]), 0, "text/css")).ToArray();
        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, null, current, originals);
        Assert.Equal(count, package.Files.Count); // brief + prose + original + current files
        if (accepted) Assert.NotEmpty(DesignArtifactWorkspaceContract.ValidateInputPackageSize(package, DesignArtifactWorkspaceBroker.MaxInputBytes));
        else Assert.Throws<InvalidOperationException>(() => DesignArtifactWorkspaceContract.ValidateInputPackageSize(package, DesignArtifactWorkspaceBroker.MaxInputBytes));
    }

    [Fact]
    public async Task Prepare_ReadsCompleteAuthorizedVersion_AndHashesEveryFileWithoutStoragePointers()
    {
        await using var f = await Fixture.CreateAsync();
        var prepared = await f.Broker().PrepareAsync(f.Run, f.Html, default);
        var bytes = f.Saved!;
        var package = JsonSerializer.Deserialize<DesignWorkspacePackage>(bytes, DesignArtifactWorkspaceContract.JsonOptions)!;
        Assert.Equal(Hash(bytes), prepared.InputSha256);
        var persisted = await f.Db.DesignArtifactRuns.Find(x => x.Id == f.Run.Id).SingleAsync();
        Assert.Equal(prepared.InputSha256, persisted.WorkspaceInputSha256);
        Assert.Equal(prepared.BaseRevision, persisted.WorkspaceBaseRevision);
        Assert.Equal(5, package.Files.Count);
        foreach (var source in f.Site.Files)
        {
            var file = Assert.Single(package.Files, x => x.Path == "current/" + source.Path);
            Assert.Equal(f.Objects[source.CosKey], Convert.FromBase64String(file.ContentBase64));
            Assert.Equal(Hash(f.Objects[source.CosKey]), file.Sha256);
        }
        var text = Encoding.UTF8.GetString(bytes);
        Assert.DoesNotContain("private/site/", text);
        Assert.DoesNotContain("untrusted.example", text);
        var task = JsonDocument.Parse(Convert.FromBase64String(package.Files[0].ContentBase64));
        Assert.Equal(4, task.RootElement.GetProperty("input").GetProperty("currentArtifact").GetProperty("files").GetArrayLength());
        var priorRevision = prepared.BaseRevision;
        await f.NewRunAsync();
        f.Objects[f.Site.Files[1].CosKey] = Encoding.UTF8.GetBytes("body{color:tan}"); // Same byte count, different CSS.
        var changed = await f.Broker().PrepareAsync(f.Run, f.Html, default);
        Assert.NotEqual(priorRevision, changed.BaseRevision);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("version")]
    [InlineData("key")]
    [InlineData("mime")]
    [InlineData("path")]
    [InlineData("published-revision")]
    [InlineData("size")]
    public async Task Prepare_RejectsConcurrentAuthorityOrFileManifestChanges_BeforePersistingInput(string change)
    {
        await using var f = await Fixture.CreateAsync();
        f.BeforeRead = async key =>
        {
            if (key != f.Site.Files[1].CosKey) return;
            f.BeforeRead = null;
            switch (change)
            {
                case "permission": f.Site.OwnerUserId = "not-owner"; break;
                case "version": f.Site.ContentVersion = f.Site.ContentVersion.AddSeconds(1); break;
                case "key": f.Site.Files[1].CosKey = "private/site/another-version/style.css"; break;
                case "mime": f.Site.Files[1].MimeType = "text/plain"; break;
                case "path": f.Site.Files[1].Path = "other.css"; break;
                case "published-revision": f.Site.PublishedRevisionId = "replaced-publication"; break;
                case "size": f.Site.Files[1].Size++; break;
            }
            await f.SaveSiteAsync();
        };
        await Assert.ThrowsAnyAsync<Exception>(() => f.Broker().PrepareAsync(f.Run, f.Html, default));
        await f.AssertNoPreparedInputAsync();
    }

    [Theory]
    [InlineData("../escape.css")]
    [InlineData("assets\\escape.css")]
    [InlineData("assets/%2e%2e.css")]
    [InlineData("INDEX.HTML")]
    [InlineData("assets")]
    public async Task Prepare_RejectsUnsafeOrCollidingPaths(string filePath)
    {
        await using var f = await Fixture.CreateAsync();
        f.Site.Files[1].Path = filePath;
        await f.SaveSiteAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Broker().PrepareAsync(f.Run, f.Html, default));
        await f.AssertNoPreparedInputAsync();
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("size")]
    [InlineData("too-large")]
    [InlineData("too-many")]
    [InlineData("stale-html")]
    [InlineData("frozen-hash")]
    [InlineData("missing-service")]
    [InlineData("serialized-size")]
    [InlineData("non-index-multifile")]
    public async Task Prepare_RejectsIncompleteOrUnboundInput(string fault)
    {
        await using var f = await Fixture.CreateAsync();
        switch (fault)
        {
            case "missing": f.Objects.Remove(f.Site.Files[1].CosKey); break;
            case "size": f.Site.Files[1].Size++; break;
            case "too-large": f.Site.Files[1].Size = DesignArtifactWorkspaceBroker.MaxInputBytes + 1; break;
            case "too-many": f.Site.Files.AddRange(Enumerable.Range(0, 1025).Select(i => new HostedSiteFile { Path = $"assets/{i}.css", CosKey = $"private/{i}", MimeType = "text/css" })); break;
            case "frozen-hash": f.Run.VersionBoundary!.BaseContentHash = new string('f', 64); break;
            case "serialized-size": f.Objects[f.Site.Files[1].CosKey] = new byte[800_000]; f.Site.Files[1].Size = 800_000; break;
            case "non-index-multifile": f.Site.EntryFile = "home.htm"; f.Site.Files[0].Path = "home.htm"; break;
        }
        await f.SaveSiteAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Broker(fault != "missing-service")
            .PrepareAsync(f.Run, fault == "stale-html" ? f.Html + " changed" : f.Html, default));
        await f.AssertNoPreparedInputAsync();
    }

    [Fact]
    public async Task Prepare_DeniesNonEditorBeforeReadingAnyObject()
    {
        await using var f = await Fixture.CreateAsync();
        f.Run.UserId = "not-owner";
        await Assert.ThrowsAsync<KeyNotFoundException>(() => f.Broker().PrepareAsync(f.Run, f.Html, default));
        Assert.Empty(f.Reads);
        await f.AssertNoPreparedInputAsync();
    }

    [Theory]
    [InlineData("index.html")]
    [InlineData("assets/style.css")]
    public async Task Prepare_DoesNotExposeStorageExceptions(string filePath)
    {
        await using var f = await Fixture.CreateAsync();
        f.BeforeRead = key => key == "private/site/" + filePath
            ? Task.FromException(new IOException("private/site/secret?signature=not-a-real-secret")) : Task.CompletedTask;
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => f.Broker().PrepareAsync(f.Run, f.Html, default));
        Assert.DoesNotContain("private/site", error.ToString());
        Assert.DoesNotContain("signature", error.ToString());
        await f.AssertNoPreparedInputAsync();
    }

    [Fact]
    public async Task Prepare_PreservesCancellationWithoutSaving()
    {
        await using var f = await Fixture.CreateAsync();
        f.BeforeRead = _ => Task.FromException(new OperationCanceledException());
        await Assert.ThrowsAsync<OperationCanceledException>(() => f.Broker().PrepareAsync(f.Run, f.Html, default));
        await f.AssertNoPreparedInputAsync();
    }

    [Fact]
    public async Task Prepare_PreservesLegacySingleHtmEntryAndTrustedWrapperNormalization()
    {
        await using var f = await Fixture.CreateAsync();
        f.Html += "<!--map-slide-nav-compat--><script>trusted wrapper</script>";
        f.Site.EntryFile = "home.htm";
        f.Site.Files = [new HostedSiteFile { Path = "home.htm", CosKey = "private/site/home.htm", Size = Encoding.UTF8.GetByteCount(f.Html), MimeType = "text/html" }];
        f.Objects[f.Site.Files[0].CosKey] = Encoding.UTF8.GetBytes(f.Html);
        await f.SaveSiteAsync();
        await f.Broker().PrepareAsync(f.Run, f.Html, default);
        var package = JsonSerializer.Deserialize<DesignWorkspacePackage>(f.Saved!, DesignArtifactWorkspaceContract.JsonOptions)!;
        var current = Assert.Single(package.Files, x => x.Path == "current/index.html");
        Assert.DoesNotContain("trusted wrapper", Encoding.UTF8.GetString(Convert.FromBase64String(current.ContentBase64)));
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _database = $"current_files_{Guid.NewGuid():N}";
        private readonly MongoClient _client;
        private readonly Mock<IAssetStorage> _storage = new(MockBehavior.Strict);
        internal MongoDbContext Db { get; }
        internal HostedSite Site { get; } = new() { Id = Guid.NewGuid().ToString("N"), OwnerUserId = "owner", EntryFile = "index.html", ContentVersion = DateTime.UtcNow };
        internal DesignArtifactRun Run { get; private set; } = null!;
        internal string Html = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"assets/style.css\"></head><body><img src=\"assets/p.png\"><script src=\"assets/app.js\"></script></body></html>";
        internal Dictionary<string, byte[]> Objects { get; } = new(StringComparer.Ordinal);
        internal List<string> Reads { get; } = [];
        internal byte[]? Saved;
        internal Func<string, Task>? BeforeRead;

        private Fixture(string connection)
        {
            _client = new MongoClient(connection);
            Db = new MongoDbContext(connection, _database);
            _storage.Setup(s => s.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns(async (string key, CancellationToken _) => { Reads.Add(key); if (BeforeRead != null) await BeforeRead(key); return Objects.GetValueOrDefault(key)?.ToArray(); });
            _storage.Setup(s => s.TryBuildContentAddressedKey(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
                .Returns((byte[] bytes, string _, string? _, string? _, string? _, string? _) => "private/input/" + Hash(bytes));
            _storage.Setup(s => s.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
                .ReturnsAsync((byte[] bytes, string mime, CancellationToken _, string? _, string? _, string? _, string? _) => { Saved = bytes.ToArray(); return new StoredAsset(Hash(bytes), "https://assets.example.test/input", bytes.Length, mime, "private/input/" + Hash(bytes)); });
        }

        internal static async Task<Fixture> CreateAsync()
        {
            // Never fall back to a developer or shared database.
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? throw new InvalidOperationException("MONGODB_TEST_CONNECTION must point to the isolated test database");
            var f = new Fixture(connection);
            var data = new[] { ("index.html", "text/html", Encoding.UTF8.GetBytes(f.Html)), ("assets/style.css", "text/css", Encoding.UTF8.GetBytes("body{color:red}")), ("assets/app.js", "application/javascript", Encoding.UTF8.GetBytes("window.ready=true;")), ("assets/p.png", "image/png", new byte[] { 137, 80, 78, 71 }) };
            foreach (var (filePath, mime, bytes) in data)
            {
                var key = "private/site/" + filePath;
                f.Objects[key] = bytes;
                f.Site.Files.Add(new HostedSiteFile { Path = filePath, CosKey = key, Size = bytes.Length, MimeType = mime, Url = "https://untrusted.example/never-fetch" });
            }
            await f.Db.HostedSites.InsertOneAsync(f.Site);
            await f.NewRunAsync();
            return f;
        }

        internal async Task NewRunAsync()
        {
            // Keep the run identity fixed when proving that CSS alone changes the input revision.
            if (Run != null) await Db.DesignArtifactRuns.DeleteOneAsync(x => x.Id == Run.Id);
            Run = new DesignArtifactRun { Id = "same-fixture-run", UserId = "owner", TargetSiteId = Site.Id, Operation = DesignArtifactOperations.Edit,
                Runtime = DesignArtifactRuntimes.OpenDesign, Status = RunStatuses.Running, LeaseOwnerId = "test-worker", LeaseExpiresAt = DateTime.UtcNow.AddMinutes(5),
                VersionBoundary = new DesignArtifactVersionBoundary { BaseContentHash = Hash(Encoding.UTF8.GetBytes(DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(Html))) } };
            await Db.DesignArtifactRuns.InsertOneAsync(Run);
            Saved = null;
        }
        internal Task SaveSiteAsync() => Db.HostedSites.ReplaceOneAsync(x => x.Id == Site.Id, Site);
        internal DesignArtifactWorkspaceBroker Broker(bool withSiteService = true)
        {
            var services = new ServiceCollection();
            if (withSiteService) services.AddSingleton<IHostedSiteService>(new HostedSiteService(Db, _storage.Object,
                Mock.Of<IShortLinkService>(), Mock.Of<ISharePasswordService>(), Mock.Of<ITeamService>(), Mock.Of<ITeamActivityService>(),
                Mock.Of<IUploadProgressService>(), Mock.Of<IAskOpeningQuestionGenerator>(), NullLogger<HostedSiteService>.Instance));
            return ActivatorUtilities.CreateInstance<DesignArtifactWorkspaceBroker>(services.BuildServiceProvider(), Db, _storage.Object,
                new EphemeralDataProtectionProvider(), new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["DesignArtifactRuntime:PublicBaseUrl"] = "https://map.example.test" }).Build());
        }
        internal async Task AssertNoPreparedInputAsync()
        {
            Assert.Null(Saved);
            Assert.Null((await Db.DesignArtifactRuns.Find(x => x.Id == Run.Id).SingleAsync()).WorkspaceInputAssetKey);
        }
        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_database);
    }
}
