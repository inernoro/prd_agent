using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class DocumentEntryPublicationFlagTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData("legacy", false)]
    [InlineData("draft", false)]
    [InlineData("published", true)]
    [InlineData("next-draft", true)]
    [InlineData("forged-metadata", false)]
    [InlineData("stage-only", false)]
    public void JsonExposesOnlyPublicationPresenceAndNeverTheWritingDraft(string kind, bool expected)
        => AssertSafeJson(JsonSerializer.SerializeToElement(Entry(kind), Json), expected);

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task MongoRoundTripAndBothListResponsesExposeOnlyTheComputedFlag()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("Explicit isolated MONGODB_TEST_CONNECTION required");
        var databaseName = "map_v6_r4_entry_flag_tests_" + Guid.NewGuid().ToString("N");
        var db = new MongoDbContext(connection, databaseName);
        var expected = new Dictionary<string, bool> { ["legacy"] = false, ["draft"] = false,
            ["published"] = true, ["next-draft"] = true, ["forged-metadata"] = false, ["stage-only"] = false };
        try
        {
            await db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "owner", IsPublic = true });
            await db.DocumentEntries.InsertManyAsync(expected.Keys.Select(Entry));
            await db.DocumentEntries.UpdateOneAsync(e => e.Id == "legacy", Builders<DocumentEntry>.Update.Unset(e => e.Writing));
            var stored = await db.DocumentEntries.Find(e => e.StoreId == "store").ToListAsync();
            foreach (var entry in stored)
            {
                AssertSafeJson(JsonSerializer.SerializeToElement(entry, Json), expected[entry.Id]);
                var bson = entry.ToBsonDocument();
                Assert.DoesNotContain(bson.Names, name => name.Equals("hasWritingPublication", StringComparison.OrdinalIgnoreCase));
                if (entry.Writing != null) Assert.Equal("private-manual-" + entry.Id, entry.Writing.ManualInput);
            }
            var controller = Controller(db, "owner");
            var ownedData = Data(await controller.ListEntries("store", all: true));
            Assert.True(ownedData.TryGetProperty("canWrite", out var ownerCanWrite), "常规列表必须返回真实的作用域写能力");
            Assert.True(ownerCanWrite.GetBoolean());
            var listed = ownedData.GetProperty("items");
            Assert.Equal(expected.Count, listed.GetArrayLength());
            foreach (var entry in listed.EnumerateArray()) AssertSafeJson(entry, expected[entry.GetProperty("id").GetString()!]);

            var readerData = Data(await Controller(db, "reader").ListEntries("store", all: true));
            Assert.False(readerData.GetProperty("canWrite").GetBoolean());
            var nextDraft = readerData.GetProperty("items").EnumerateArray().Single(entry => entry.GetProperty("id").GetString() == "next-draft");
            AssertSafeJson(nextDraft, true);

            // 匿名公开列表继续隐藏未发布写作草稿，同时保留普通旧条目和已发布下一版草稿。
            var anonymous = Controller(db, null);
            var publicData = Data(await anonymous.ListPublicStoreEntries("store"));
            Assert.False(publicData.TryGetProperty("canWrite", out _));
            var publicRows = publicData.GetProperty("items");
            Assert.Equal(4, publicRows.GetArrayLength());
            Assert.DoesNotContain(publicRows.EnumerateArray(), entry => entry.GetProperty("id").GetString() is "draft" or "stage-only");
            foreach (var entry in publicRows.EnumerateArray()) AssertSafeJson(entry, expected[entry.GetProperty("id").GetString()!]);
            await db.DocumentStores.UpdateOneAsync(s => s.Id == "store", Builders<DocumentStore>.Update.Set(s => s.IsPublic, false));
            Assert.IsType<NotFoundObjectResult>(await anonymous.ListPublicStoreEntries("store"));
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(databaseName); }
    }

    [Theory]
    [Trait("Category", TestCategories.Integration)]
    [InlineData("list")]
    [InlineData("detail")]
    [InlineData("content")]
    public async Task ReadOnlyPublicStoreReadersCannotDiscoverUnpublishedWriting(string endpoint)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("Explicit isolated MONGODB_TEST_CONNECTION required");
        var databaseName = "map_v6_r4_draft_visibility_" + Guid.NewGuid().ToString("N");
        var db = new MongoDbContext(connection, databaseName);
        try
        {
            await db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "owner", IsPublic = true });
            var entries = new[] { Entry("legacy"), Entry("published"), Entry("next-draft"), Entry("draft"), Entry("stage-only") };
            foreach (var entry in entries.Where(e => e.Id is "legacy" or "published" or "next-draft"))
            {
                entry.DocumentId = entry.Id + "-doc";
                await db.Documents.InsertOneAsync(new ParsedPrd { Id = entry.DocumentId, Title = entry.Title, RawContent = "visible-body-" + entry.Id });
            }
            await db.DocumentEntries.InsertManyAsync(entries);
            var documents = new Mock<IDocumentService>(MockBehavior.Strict);
            documents.Setup(d => d.GetByIdAsync(It.IsAny<string>())).Returns(async (string id) => (ParsedPrd?)await db.Documents.Find(d => d.Id == id).FirstOrDefaultAsync());
            var reader = Controller(db, "reader", documents.Object);
            if (endpoint == "list")
            {
                var first = Data(await reader.ListEntries("store", page: 1, pageSize: 2, all: true));
                var second = Data(await reader.ListEntries("store", page: 2, pageSize: 2, all: true));
                Assert.Equal(3, first.GetProperty("total").GetInt32());
                Assert.Equal(3, second.GetProperty("total").GetInt32());
                Assert.Equal(2, first.GetProperty("items").GetArrayLength());
                Assert.Equal(1, second.GetProperty("items").GetArrayLength());
                var ids = first.GetProperty("items").EnumerateArray().Concat(second.GetProperty("items").EnumerateArray())
                    .Select(e => e.GetProperty("id").GetString()).OrderBy(id => id).ToArray();
                Assert.Equal(new[] { "legacy", "next-draft", "published" }, ids);
                Assert.False(first.GetProperty("canWrite").GetBoolean());
                var search = Data(await reader.ListEntries("store", keyword: "stage-only", all: true, searchContent: true));
                Assert.Equal(0, search.GetProperty("total").GetInt32());
                Assert.Empty(search.GetProperty("items").EnumerateArray());
            }
            else if (endpoint == "detail")
                Assert.IsType<NotFoundObjectResult>(await reader.GetEntry("draft"));
            else
                Assert.IsType<NotFoundObjectResult>(await reader.GetEntryContent("draft"));

            // 普通公开原文、已发布内容与编辑下一版时的旧发布正文仍可读取。
            foreach (var id in new[] { "legacy", "published", "next-draft" })
            {
                AssertSafeJson(Data(await reader.GetEntry(id)), id != "legacy");
                var content = Data(await reader.GetEntryContent(id));
                Assert.Equal("visible-body-" + id, content.GetProperty("content").GetString());
                Assert.DoesNotContain("private-manual-", content.GetRawText(), StringComparison.Ordinal);
            }
            var owner = Controller(db, "owner", documents.Object);
            Assert.Equal(5, Data(await owner.ListEntries("store", all: true)).GetProperty("total").GetInt32());
            Assert.IsType<OkObjectResult>(await owner.GetEntry("draft"));
            Assert.IsType<OkObjectResult>(await owner.GetEntryContent("draft"));
            Assert.IsType<NotFoundObjectResult>(await Controller(db, null).GetPublicEntryContent("draft"));
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(databaseName); }
    }

    private static DocumentEntry Entry(string kind)
    {
        var writing = kind is "legacy" or "forged-metadata" ? null : new WritingDocumentState {
            Stage = kind is "published" or "stage-only" ? "published" : "confirm",
            ManualInput = "private-manual-" + kind,
            Published = kind is "published" or "next-draft" ? new WritingPublication { Title = "已审核内容" } : null,
        };
        return new DocumentEntry { Id = kind, StoreId = "store", Title = kind, Writing = writing,
            Metadata = kind == "forged-metadata" ? new() { ["writing_stage"] = "published" } : new() };
    }

    private static void AssertSafeJson(JsonElement entry, bool expected)
    {
        Assert.True(entry.TryGetProperty("hasWritingPublication", out var flag), "列表必须提供安全的发布存在标志");
        Assert.Equal(expected, flag.GetBoolean());
        Assert.False(entry.TryGetProperty("writing", out _));
        Assert.False(entry.TryGetProperty("Writing", out _));
        Assert.DoesNotContain("manualInput", entry.GetRawText(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("private-manual-", entry.GetRawText(), StringComparison.Ordinal);
    }

    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value, Json).GetProperty("data");

    private static DocumentStoreController Controller(MongoDbContext db, string? user, IDocumentService? documents = null)
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
        return new DocumentStoreController(db, null!, null!, documents!, null!, null!, null!, teams.Object,
            null!, null!, null!, null!, null!, null!, null!, null!, new ConfigurationBuilder().Build(),
            null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                User = user == null ? new ClaimsPrincipal(new ClaimsIdentity())
                    : new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", user) }, "test"))
            } }
        };
    }
}
