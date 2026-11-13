using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

[Trait("Category", TestCategories.Integration)]
public sealed class WritingPublicationOverviewTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData("owner", true)]
    [InlineData("reader", false)]
    public async Task OverviewIsSmallAndKeepsPublishedHeadWithoutReadingSourceBodies(string user, bool canEdit)
    {
        await using var fixture = await Fixture.Create();
        var controller = fixture.Controller(user);
        var data = Data(await Read(controller, overview: true));
        Assert.True(data.TryGetProperty("bodyPending", out var pending), "概览必须明确正文尚未返回");
        Assert.True(pending.GetBoolean());
        var publication = data.GetProperty("publication");
        Assert.Equal("Published version 2", publication.GetProperty("title").GetString());
        Assert.Equal(2, publication.GetProperty("version").GetInt32());
        Assert.Equal("Summary 2", publication.GetProperty("summary").GetString());
        Assert.Equal("Scope 2", publication.GetProperty("scopeIn").GetString());
        Assert.Equal("Next action 2", publication.GetProperty("roles")[0].GetProperty("action").GetString());
        Assert.Equal("Published section 2", publication.GetProperty("sections")[0].GetProperty("title").GetString());
        Assert.Empty(publication.GetProperty("sections")[0].GetProperty("paragraphs").EnumerateArray());
        Assert.Equal("", publication.GetProperty("sources")[0].GetProperty("content").GetString());
        Assert.Equal("Source version 2", publication.GetProperty("sources")[0].GetProperty("title").GetString());
        foreach (var key in new[] { "conclusions", "sections", "sources", "roles", "openQuestions", "chapters", "captions" })
            Assert.Equal(JsonValueKind.Array, publication.GetProperty(key).ValueKind);
        foreach (var key in new[] { "openQuestions", "chapters", "captions" }) Assert.Empty(publication.GetProperty(key).EnumerateArray());
        Assert.Equal("video-2", publication.GetProperty("videoEntryId").GetString());
        Assert.Equal("mobile-video-2", publication.GetProperty("mobileVideoEntryId").GetString());
        Assert.True(Encoding.UTF8.GetByteCount(data.GetRawText()) < 5000);
        Assert.DoesNotContain("PRIVATE-DRAFT", data.GetRawText(), StringComparison.Ordinal);
        Assert.Empty(data.GetProperty("affectedSources").EnumerateArray());
        Assert.Equal(canEdit, data.GetProperty("canEdit").GetBoolean());
        Assert.Equal(2, data.GetProperty("entries").GetArrayLength());
        fixture.Documents.Verify(d => d.GetByIdAsync(It.IsAny<string>()), Times.Never);

        var full = Data(await Read(controller, overview: false, version: publication.GetProperty("version").GetInt32()));
        Assert.False(full.TryGetProperty("bodyPending", out _));
        Assert.Contains("Published body 2", full.GetProperty("publication").GetProperty("sections")[0].GetProperty("paragraphs")[0].GetProperty("text").GetString());
        Assert.Contains("Published source 2", full.GetProperty("publication").GetProperty("sources")[0].GetProperty("content").GetString());
        Assert.Equal("Published caption 2", full.GetProperty("publication").GetProperty("captions")[0].GetProperty("text").GetString());
        Assert.Equal("S1", full.GetProperty("affectedSources")[0].GetString());
        fixture.Documents.Verify(d => d.GetByIdAsync("source-doc"), Times.Once);
    }

    [Fact]
    public async Task HistoricalOverviewAndBodyRemainOnTheSameVersionAfterAnotherPublication()
    {
        await using var fixture = await Fixture.Create();
        await fixture.Db.Database.GetCollection<WritingPublicationRecord>("document_writing_publications")
            .InsertOneAsync(new WritingPublicationRecord { Id = "writing:v1", EntryId = "writing", StoreId = "store", Publication = Publication(1) });
        var controller = fixture.Controller("reader");
        var head = Data(await Read(controller, overview: true, version: 1));
        Assert.Equal("Published version 1", head.GetProperty("publication").GetProperty("title").GetString());
        Assert.Empty(head.GetProperty("publication").GetProperty("sections")[0].GetProperty("paragraphs").EnumerateArray());
        await fixture.Db.DocumentEntries.UpdateOneAsync(e => e.Id == "writing", Builders<DocumentEntry>.Update.Set(e => e.Writing!.Published, Publication(3)));
        var body = Data(await Read(controller, overview: false, version: head.GetProperty("publication").GetProperty("version").GetInt32()));
        Assert.Equal("Published version 1", body.GetProperty("publication").GetProperty("title").GetString());
        Assert.Contains("Published body 1", body.GetProperty("publication").GetProperty("sections")[0].GetProperty("paragraphs")[0].GetProperty("text").GetString());
        Assert.IsType<NotFoundObjectResult>(await Read(controller, overview: true, version: 4));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OverviewDoesNotGrantPrivateStoreOrUnpublishedDraftAccess(bool overview)
    {
        await using var fixture = await Fixture.Create();
        await fixture.Db.DocumentStores.UpdateOneAsync(s => s.Id == "store", Builders<DocumentStore>.Update.Set(s => s.IsPublic, false));
        Assert.IsType<NotFoundObjectResult>(await Read(fixture.Controller("reader"), overview));
        await fixture.Db.DocumentEntries.UpdateOneAsync(e => e.Id == "writing", Builders<DocumentEntry>.Update.Set(e => e.Writing!.Published, null));
        Assert.IsType<NotFoundObjectResult>(await Read(fixture.Controller("owner"), overview));
        fixture.Documents.Verify(d => d.GetByIdAsync(It.IsAny<string>()), Times.Never);
    }

    // Like MVC query binding, an unknown overview query is ignored by the old action.
    // This permits a meaningful old-body assertion failure before the optional parameter exists.
    private static async Task<IActionResult> Read(DocumentStoreController controller, bool overview, int? version = null)
    {
        var method = typeof(DocumentStoreController).GetMethod(nameof(DocumentStoreController.ReadWritingPublication))!;
        var args = method.GetParameters().Select(parameter => parameter.Name switch {
            "entryId" => (object)"writing", "version" => version, "overview" => overview,
            _ => throw new InvalidOperationException("Unexpected query contract") }).ToArray();
        return await (Task<IActionResult>)method.Invoke(controller, args)!;
    }

    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value, Json).GetProperty("data");

    private static WritingPublication Publication(int version)
    {
        var source = string.Concat(Enumerable.Repeat("Published source " + version + ". ", 600));
        return new WritingPublication { Version = version, Title = "Published version " + version, Summary = "Summary " + version,
            TemplateId = "prd", TemplateVersion = "1.0", AuthorName = "Author", ReviewerId = "reviewer", ReviewerName = "Reviewer", PublishedAt = DateTime.UtcNow,
            Conclusions = new() { "Conclusion " + version }, ScopeIn = "Scope " + version, ScopeOut = "Excluded " + version,
            Roles = new() { new() { Label = "Reader", Action = "Next action " + version, Condition = "Published condition", SectionId = "section" } },
            Sections = new() { new() { Id = "section", Title = "Published section " + version, Paragraphs = new() {
                new() { Id = "paragraph", Text = string.Concat(Enumerable.Repeat("Published body " + version + ". ", 600)) } } } },
            Sources = new() { new() { Id = "S1", EntryId = "source", Title = "Source version " + version, Content = source,
                Hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source))).ToLowerInvariant(), Status = "read" } },
            OpenQuestions = new() { new() { Title = "Published question " + version, Status = "open" } },
            Chapters = new() { new() { Id = "chapter", Title = "Published chapter " + version, Steps = new() { new() { Text = "Published step " + version } } } },
            Captions = new() { new() { Text = "Published caption " + version, At = 1 } },
            VideoEntryId = "video-" + version, MobileVideoEntryId = "mobile-video-" + version };
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _connection;
        private readonly string _databaseName = "map_v6_writing_overview_" + Guid.NewGuid().ToString("N");
        internal MongoDbContext Db { get; }
        internal Mock<IDocumentService> Documents { get; } = new(MockBehavior.Strict);
        private Fixture(string connection)
        {
            _connection = connection; Db = new MongoDbContext(connection, _databaseName);
            Documents.Setup(d => d.GetByIdAsync("source-doc")).ReturnsAsync(new ParsedPrd { Id = "source-doc", RawContent = "Current source has changed" });
        }
        internal static async Task<Fixture> Create()
        {
            var f = new Fixture(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? throw new InvalidOperationException("Explicit isolated MONGODB_TEST_CONNECTION required"));
            await f.Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "owner", IsPublic = true });
            await f.Db.DocumentEntries.InsertManyAsync(new[] {
                new DocumentEntry { Id = "writing", StoreId = "store", Title = "Published version 2", Writing = new WritingDocumentState {
                    ManualInput = "PRIVATE-DRAFT-INPUT", Title = "PRIVATE-DRAFT-TITLE", Summary = "PRIVATE-DRAFT-SUMMARY",
                    Sections = new() { new() { Paragraphs = new() { new() { Text = "PRIVATE-DRAFT-BODY" } } } }, Published = Publication(2) } },
                new DocumentEntry { Id = "source", StoreId = "store", DocumentId = "source-doc" },
                new DocumentEntry { Id = "peer", StoreId = "store", Writing = new WritingDocumentState { Published = Publication(1) } }
            });
            return f;
        }
        internal DocumentStoreController Controller(string user)
        {
            var teams = new Mock<ITeamService>();
            teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            return new DocumentStoreController(Db, null!, null!, Documents.Object, null!, null!, null!, teams.Object,
                null!, null!, null!, null!, null!, null!, null!, null!, new ConfigurationBuilder().Build(),
                null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", user) }, "test")) } } };
        }
        public async ValueTask DisposeAsync() => await new MongoClient(_connection).DropDatabaseAsync(_databaseName);
    }
}
