using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

[Trait("Category", "Integration")]
public class DocumentStoreScaleIntegrationTests
{
    private static DocumentStoreController Controller(MongoDbContext db, string user, params string[] teams)
    {
        var team = new Mock<ITeamService>();
        team.Setup(t => t.GetMyTeamIdsAsync(user, It.IsAny<CancellationToken>())).ReturnsAsync(teams.ToList());
        var controller = new DocumentStoreController(db,
            assetStorage: null!, fileContentExtractor: null!, documentService: null!, runEventStore: null!,
            urlValidator: null!, httpClientFactory: null!, teams: team.Object, teamActivity: null!, mentions: null!,
            versions: new PrdAgent.Infrastructure.Services.DocumentStore.DocumentVersionService(db),
            adminPermissions: null!, shortLinks: null!, hostedSites: null!, gateway: null!, llmRequestContext: null!,
            config: null!, assetNormalizer: null!, liveTranscriptionRelay: null!, documentAssetCleanup: null!,
            entryContentWriter: null!, githubConnections: null!, logger: NullLogger<DocumentStoreController>.Instance);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
            User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", user) }, "test")) } };
        return controller;
    }

    private static JsonElement Data(IActionResult result)
        => JsonSerializer.SerializeToElement(((OkObjectResult)result).Value).GetProperty("Data");

    [Theory]
    [InlineData(200)]
    [InlineData(1000)]
    [InlineData(5000)]
    public async Task Cursor_AllEntriesReachable_WithTiesInsertDelete_AndPermissionRecheck(int count)
    {
        var db = new MongoDbContext("mongodb://127.0.0.1:27017", "kb_scale_test_" + Guid.NewGuid().ToString("N"));
        try
        {
            await db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "mine", OwnerId = "owner", SharedTeamIds = new() { "team" } });
            var time = DateTime.UtcNow.AddDays(-1);
            await db.DocumentEntries.InsertManyAsync(Enumerable.Range(0, count).Select(i => new DocumentEntry {
                Id = $"e{i:D6}", StoreId = "mine", CreatedAt = time, ContentIndex = "不应下载的索引" }));
            var owner = Controller(db, "owner");
            var seen = new HashSet<string>();
            string? cursor = null;
            var rounds = 0;
            do
            {
                var data = Data(await owner.ListEntries("mine", pageSize: 200, all: true, navigation: true, cursor: cursor));
                foreach (var item in data.GetProperty("items").EnumerateArray())
                {
                    seen.Add(item.GetProperty("Id").GetString()!).ShouldBeTrue();
                    item.GetProperty("ContentIndex").ValueKind.ShouldBe(JsonValueKind.Null);
                }
                cursor = data.GetProperty("nextCursor").GetString();
                if (++rounds == 1)
                {
                    // 新建条目不移动当前遍历边界；删除已读条目不会像 offset 一样跳过后续条目。
                    await db.DocumentEntries.InsertOneAsync(new DocumentEntry { Id = "a-new", StoreId = "mine" });
                    await db.DocumentEntries.DeleteOneAsync(e => e.Id == "e000000");
                    (await Controller(db, "stranger").ListEntries("mine", all: true, navigation: true, cursor: cursor)).ShouldBeOfType<NotFoundObjectResult>();
                    (await Controller(db, "collaborator", "team").ListEntries("mine", all: true, navigation: true, cursor: cursor)).ShouldBeOfType<OkObjectResult>();
                }
            } while (cursor != null);
            seen.Count.ShouldBe(count);
            seen.Contains("a-new").ShouldBeFalse();
            await db.DocumentStores.UpdateOneAsync(s => s.Id == "mine", Builders<DocumentStore>.Update.Set(s => s.SharedTeamIds, new List<string>()));
            (await Controller(db, "collaborator", "team").ListEntries("mine", all: true, navigation: true)).ShouldBeOfType<NotFoundObjectResult>();
        }
        finally { await db.Database.Client.DropDatabaseAsync(db.Database.DatabaseNamespace.DatabaseName); }
    }

    [Fact]
    public async Task FullTextSearch_UsesReadableCanonicalContent_AndAttachmentFallback_WithoutWrites()
    {
        var db = new MongoDbContext("mongodb://127.0.0.1:27017", "kb_scale_test_" + Guid.NewGuid().ToString("N"));
        try
        {
            await db.DocumentStores.InsertManyAsync(new[] { new DocumentStore { Id = "public", OwnerId = "owner", IsPublic = true }, new DocumentStore { Id = "private", OwnerId = "other" } });
            await db.Documents.InsertManyAsync(new[] { new ParsedPrd { Id = "body", RawContent = new string('文', 5000) + " tail [draft] foo(" }, new ParsedPrd { Id = "hidden", RawContent = "secret" } });
            await db.Attachments.InsertOneAsync(new Attachment { AttachmentId = "att", ExtractedText = "fallback marker" });
            await db.DocumentEntries.InsertManyAsync(new[] {
                new DocumentEntry { Id = "a", StoreId = "public", DocumentId = "body", AttachmentId = "att", ContentIndex = "stale marker" },
                new DocumentEntry { Id = "b", StoreId = "public", AttachmentId = "att" },
                new DocumentEntry { Id = "c", StoreId = "private", DocumentId = "hidden" } });
            var reader = Controller(db, "reader");
            Data(await reader.ListEntries("public", keyword: "[draft] foo(", searchContent: true, navigation: true)).GetProperty("total").GetInt64().ShouldBe(1);
            var fallback = Data(await reader.ListEntries("public", keyword: "fallback marker", searchContent: true, navigation: true));
            fallback.GetProperty("total").GetInt64().ShouldBe(1);
            fallback.GetProperty("items")[0].GetProperty("Id").GetString().ShouldBe("b");
            Data(await reader.ListEntries("public", keyword: "stale marker", searchContent: true, navigation: true)).GetProperty("total").GetInt64().ShouldBe(0);
            Data(await reader.ListEntries("public", keyword: "secret", searchContent: true, navigation: true)).GetProperty("total").GetInt64().ShouldBe(0);
            (await reader.ListEntries("private", keyword: "secret", searchContent: true, navigation: true)).ShouldBeOfType<NotFoundObjectResult>();
            (await db.DocumentEntries.Find(e => e.Id == "a").FirstAsync()).ContentIndex.ShouldBe("stale marker");
        }
        finally { await db.Database.Client.DropDatabaseAsync(db.Database.DatabaseNamespace.DatabaseName); }
    }
    [Theory]
    [InlineData(200)]
    [InlineData(1000)]
    [InlineData(5000)]
    public async Task AnonymousAndSharePages_AreComplete_AndNeverExpandSingleEntryScope(int count)
    {
        var db = new MongoDbContext("mongodb://127.0.0.1:27017", "kb_scale_test_" + Guid.NewGuid().ToString("N"));
        try
        {
            await db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "public", OwnerId = "owner", IsPublic = true });
            await db.DocumentEntries.InsertManyAsync(Enumerable.Range(0, count).Select(i => new DocumentEntry {
                Id = $"e{i:D6}", StoreId = "public", Title = "样本", CreatedAt = DateTime.UtcNow.AddDays(-1) }));
            await db.DocumentStoreShareLinks.InsertManyAsync(new[] {
                new DocumentStoreShareLink { Id = "whole", Token = "whole", StoreId = "public" },
                new DocumentStoreShareLink { Id = "one", Token = "one", StoreId = "public", EntryId = "e000000" },
                new DocumentStoreShareLink { Token = "expired", StoreId = "public", ExpiresAt = DateTime.UtcNow.AddDays(-1) } });
            var reader = Controller(db, "anonymous");
            foreach (var shared in new[] { false, true })
            {
                var ids = new HashSet<string>();
                string? cursor = null;
                do
                {
                    var page = Data(shared ? await reader.ListShareEntries("whole", cursor: cursor) :
                        await reader.ListPublicStoreEntries("public", cursor: cursor));
                    foreach (var item in page.GetProperty("items").EnumerateArray())
                        ids.Add(item.GetProperty("Id").GetString()!).ShouldBeTrue();
                    cursor = page.GetProperty("nextCursor").GetString();
                } while (cursor != null);
                ids.Count.ShouldBe(count);
            }
            var single = Data(await reader.ListShareEntries("one", keyword: "样本", searchContent: true));
            single.GetProperty("total").GetInt64().ShouldBe(1);
            single.GetProperty("items")[0].GetProperty("Id").GetString().ShouldBe("e000000");
            (await reader.GetShareEntryContent("one", "e000001")).ShouldBeOfType<NotFoundObjectResult>();
            (await reader.GetShareEntryContent("expired", "e000000")).ShouldBeOfType<NotFoundObjectResult>();
            var first = Data(await reader.ListShareEntries("whole", pageSize: 50));
            await db.DocumentStoreShareLinks.UpdateOneAsync(l => l.Id == "whole", Builders<DocumentStoreShareLink>.Update.Set(l => l.IsRevoked, true));
            (await reader.ListShareEntries("whole", cursor: first.GetProperty("nextCursor").GetString())).ShouldBeOfType<NotFoundObjectResult>();
            (await reader.ListShareEntries("expired")).ShouldBeOfType<NotFoundObjectResult>();
            var publicFirst = Data(await reader.ListPublicStoreEntries("public", pageSize: 50));
            await db.DocumentStores.UpdateOneAsync(s => s.Id == "public", Builders<DocumentStore>.Update.Set(s => s.IsPublic, false));
            (await reader.ListPublicStoreEntries("public", cursor: publicFirst.GetProperty("nextCursor").GetString())).ShouldBeOfType<NotFoundObjectResult>();
            (await reader.GetPublicEntryContent("e000000")).ShouldBeOfType<NotFoundObjectResult>();
        }
        finally { await db.Database.Client.DropDatabaseAsync(db.Database.DatabaseNamespace.DatabaseName); }
    }

    [Theory]
    [InlineData(200)]
    [InlineData(1000)]
    [InlineData(5000)]
    public async Task Size_UsesExactUtf8Bytes_AndCountsSharedBodyOnlyOnce(int count)
    {
        var db = new MongoDbContext("mongodb://127.0.0.1:27017", "kb_scale_test_" + Guid.NewGuid().ToString("N"));
        try
        {
            await db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "mine", OwnerId = "owner" });
            var content = new string('文', 1000) + "café";
            await db.Documents.InsertManyAsync(Enumerable.Range(0, count).Select(i => new ParsedPrd { Id = $"d{i}", RawContent = content }));
            await db.DocumentEntries.InsertManyAsync(Enumerable.Range(0, count).Select(i => new DocumentEntry { Id = $"e{i}", StoreId = "mine", DocumentId = $"d{i}" }));
            await db.DocumentEntries.InsertManyAsync(new[] {
                new DocumentEntry { StoreId = "mine", DocumentId = "d0", AttachmentId = "image" },
                new DocumentEntry { StoreId = "mine", SourceType = DocumentSourceType.GithubDirectory } });
            await db.Attachments.InsertOneAsync(new Attachment { AttachmentId = "image", Size = 123, MimeType = "image/png" });
            var data = Data(await Controller(db, "owner").GetStoreSize("mine"));
            data.GetProperty("documentBytes").GetInt64().ShouldBe((long)System.Text.Encoding.UTF8.GetByteCount(content) * count);
            data.GetProperty("attachmentBytes").GetInt64().ShouldBe(123);
            data.GetProperty("imageBytes").GetInt64().ShouldBe(123);
            data.GetProperty("imageCount").GetInt32().ShouldBe(1);
            data.GetProperty("entryCount").GetInt32().ShouldBe(count + 1);
            data.GetProperty("folderCount").GetInt32().ShouldBe(1);
            (await Controller(db, "stranger").GetStoreSize("mine")).ShouldBeOfType<NotFoundObjectResult>();
        }
        finally { await db.Database.Client.DropDatabaseAsync(db.Database.DatabaseNamespace.DatabaseName); }
    }

}
