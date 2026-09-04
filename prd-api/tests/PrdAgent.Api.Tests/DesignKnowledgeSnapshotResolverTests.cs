using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests;

public sealed class DesignKnowledgeSnapshotResolverTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResolveAsync_ReadsServerOwnedContentAndMetadata()
    {
        await using var fixture = await Fixture.CreateAsync();
        var store = new DocumentStore { Id = "store-1", OwnerId = "owner", Name = "服务端知识库" };
        var document = new ParsedPrd { Id = "document-1", Title = "正文原始标题", RawContent = "服务端权威正文" };
        var entry = new DocumentEntry
        {
            Id = "entry-1",
            StoreId = store.Id,
            DocumentId = document.Id,
            Title = "服务端条目标题",
            ContentIndex = document.RawContent,
            CreatedBy = "owner",
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);
        await fixture.Db.Documents.InsertOneAsync(document);
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);

        var snapshots = await fixture.Resolver.ResolveAsync(
            "owner",
            [new DesignKnowledgeReferenceIdentity(entry.Id, store.Id)],
            CancellationToken.None);

        var snapshot = Assert.Single(snapshots);
        Assert.Equal("服务端知识库", snapshot.StoreName);
        Assert.Equal("服务端条目标题", snapshot.Title);
        Assert.Equal("服务端权威正文", snapshot.Content);
        Assert.Equal(Hash("服务端权威正文"), snapshot.ContentHash);
    }

    [Theory]
    [InlineData("intruder", "store-1")]
    [InlineData("owner", "forged-store")]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResolveAsync_HidesUnauthorizedOrForgedEntryIdentity(string userId, string requestedStoreId)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.DocumentStores.InsertOneAsync(new DocumentStore
        {
            Id = "store-1",
            OwnerId = "owner",
            Name = "私有知识库",
        });
        await fixture.Db.Documents.InsertOneAsync(new ParsedPrd
        {
            Id = "document-1",
            RawContent = "不可泄露正文",
        });
        await fixture.Db.DocumentEntries.InsertOneAsync(new DocumentEntry
        {
            Id = "entry-1",
            StoreId = "store-1",
            DocumentId = "document-1",
            Title = "私有条目",
            CreatedBy = "owner",
        });

        var error = await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() =>
            fixture.Resolver.ResolveAsync(
                userId,
                [new DesignKnowledgeReferenceIdentity("entry-1", requestedStoreId)],
                CancellationToken.None));

        Assert.Equal(ErrorCodes.NOT_FOUND, error.Code);
        Assert.DoesNotContain("不可泄露正文", error.Message);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResolveAsync_AcceptsExactLimitAndRejectsOneCharacterMoreWithoutTruncating()
    {
        await using var fixture = await Fixture.CreateAsync();
        var contentAtLimit = new string('甲', DesignKnowledgeSnapshotResolver.MaxTotalContentCharacters);
        await fixture.Db.DocumentStores.InsertOneAsync(new DocumentStore
        {
            Id = "store-1",
            OwnerId = "owner",
            Name = "长文知识库",
        });
        await fixture.Db.Documents.InsertOneAsync(new ParsedPrd { Id = "document-1", RawContent = contentAtLimit });
        await fixture.Db.DocumentEntries.InsertOneAsync(new DocumentEntry
        {
            Id = "entry-1",
            StoreId = "store-1",
            DocumentId = "document-1",
            Title = "长文",
            ContentIndex = contentAtLimit[..2000],
            CreatedBy = "owner",
        });

        var accepted = await fixture.Resolver.ResolveAsync(
            "owner",
            [new DesignKnowledgeReferenceIdentity("entry-1", "store-1")],
            CancellationToken.None);
        Assert.Equal(DesignKnowledgeSnapshotResolver.MaxTotalContentCharacters, Assert.Single(accepted).Content.Length);

        await fixture.Db.Documents.UpdateOneAsync(
            document => document.Id == "document-1",
            Builders<ParsedPrd>.Update.Set(
                document => document.RawContent,
                contentAtLimit + "乙"));

        var error = await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() =>
            fixture.Resolver.ResolveAsync(
                "owner",
                [new DesignKnowledgeReferenceIdentity("entry-1", "store-1")],
                CancellationToken.None));

        Assert.Equal(ErrorCodes.INVALID_FORMAT, error.Code);
        Assert.Contains("60,000", error.Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResolveAsync_RejectsRehungLeafAfterSourceTeamAccessIsRevoked(bool useAttachment)
    {
        await using var fixture = await Fixture.CreateAsync(["team-1"]);
        var sourceStore = new DocumentStore
        {
            Id = "source-store",
            OwnerId = "source-owner",
            Name = "团队来源库",
            SharedTeamIds = ["team-1"],
        };
        var copiedStore = new DocumentStore
        {
            Id = "copied-store",
            OwnerId = "former-reader",
            Name = "重挂库",
        };
        await fixture.Db.DocumentStores.InsertManyAsync([sourceStore, copiedStore]);

        var sourceEntry = await InsertLeafAsync(
            fixture,
            "source-entry",
            sourceStore.Id,
            "source-owner",
            "受保护正文",
            useAttachment,
            serverBound: true);
        var rehungEntry = await InsertLeafAsync(
            fixture,
            "rehung-entry",
            copiedStore.Id,
            "former-reader",
            "受保护正文",
            useAttachment,
            serverBound: false,
            sourceEntry);

        var beforeRevocation = await fixture.Resolver.ResolveAsync(
            "former-reader",
            [new DesignKnowledgeReferenceIdentity(rehungEntry.Id, copiedStore.Id)],
            CancellationToken.None);
        Assert.Equal("受保护正文", Assert.Single(beforeRevocation).Content);

        await fixture.Db.DocumentStores.UpdateOneAsync(
            store => store.Id == sourceStore.Id,
            Builders<DocumentStore>.Update.Set(store => store.SharedTeamIds, new List<string>()));

        var error = await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() =>
            fixture.Resolver.ResolveAsync(
                "former-reader",
                [new DesignKnowledgeReferenceIdentity(rehungEntry.Id, copiedStore.Id)],
                CancellationToken.None));

        Assert.Equal(ErrorCodes.NOT_FOUND, error.Code);
        Assert.DoesNotContain("受保护正文", error.Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResolveAsync_RejectsForgedLeafWithoutServerBinding(bool useAttachment)
    {
        await using var fixture = await Fixture.CreateAsync();
        var store = new DocumentStore { Id = "attacker-store", OwnerId = "attacker", Name = "攻击者知识库" };
        await fixture.Db.DocumentStores.InsertOneAsync(store);
        var entry = await InsertLeafAsync(
            fixture,
            "forged-entry",
            store.Id,
            "attacker",
            "不应读取的正文",
            useAttachment,
            serverBound: false);

        var error = await Assert.ThrowsAsync<DesignKnowledgeSnapshotException>(() =>
            fixture.Resolver.ResolveAsync(
                "attacker",
                [new DesignKnowledgeReferenceIdentity(entry.Id, store.Id)],
                CancellationToken.None));

        Assert.Equal(ErrorCodes.NOT_FOUND, error.Code);
        Assert.DoesNotContain("不应读取的正文", error.Message);
    }

    [Theory]
    [InlineData("owner", false, false)]
    [InlineData("reader", true, false)]
    [InlineData("reader", false, true)]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResolveAsync_AllowsServerBoundLeafForOwnerTeamAndPublicReaders(
        string userId,
        bool teamShared,
        bool isPublic)
    {
        await using var fixture = await Fixture.CreateAsync(teamShared ? ["team-1"] : []);
        var store = new DocumentStore
        {
            Id = "source-store",
            OwnerId = "owner",
            Name = "合法来源库",
            SharedTeamIds = teamShared ? ["team-1"] : [],
            IsPublic = isPublic,
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);
        var entry = await InsertLeafAsync(
            fixture,
            "source-entry",
            store.Id,
            "owner",
            "合法正文",
            useAttachment: false,
            serverBound: true);

        var snapshots = await fixture.Resolver.ResolveAsync(
            userId,
            [new DesignKnowledgeReferenceIdentity(entry.Id, store.Id)],
            CancellationToken.None);

        Assert.Equal("合法正文", Assert.Single(snapshots).Content);
    }

    private static async Task<DocumentEntry> InsertLeafAsync(
        Fixture fixture,
        string entryId,
        string storeId,
        string creatorId,
        string content,
        bool useAttachment,
        bool serverBound,
        DocumentEntry? copyLeafFrom = null)
    {
        var entry = new DocumentEntry
        {
            Id = entryId,
            StoreId = storeId,
            Title = entryId,
            CreatedBy = creatorId,
            ContentIndex = serverBound ? content : null,
        };

        if (useAttachment)
        {
            entry.AttachmentId = copyLeafFrom?.AttachmentId ?? $"attachment-{entryId}";
            if (copyLeafFrom == null)
            {
                await fixture.Db.Attachments.InsertOneAsync(new Attachment
                {
                    AttachmentId = entry.AttachmentId,
                    UploaderId = serverBound ? creatorId : "victim",
                    FileName = "source.txt",
                    MimeType = "text/plain",
                    ExtractedText = content,
                });
            }
        }
        else
        {
            entry.DocumentId = copyLeafFrom?.DocumentId ?? $"document-{entryId}";
            if (copyLeafFrom == null)
            {
                await fixture.Db.Documents.InsertOneAsync(new ParsedPrd
                {
                    Id = entry.DocumentId,
                    RawContent = content,
                });
            }
        }

        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        return entry;
    }

    private static string Hash(string content) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;
        private readonly Mock<ITeamService> _teams;

        private Fixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
            _teams = new Mock<ITeamService>();
            _teams.Setup(service => service.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync([]);
            var permissions = new Mock<IAdminPermissionService>();
            permissions.Setup(service => service.GetEffectivePermissionsAsync(
                    It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync([]);
            Resolver = new DesignKnowledgeSnapshotResolver(Db, _teams.Object, permissions.Object);
        }

        internal MongoDbContext Db { get; }
        internal DesignKnowledgeSnapshotResolver Resolver { get; }

        internal static async Task<Fixture> CreateAsync(IReadOnlyList<string>? teamIds = null)
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var fixture = new Fixture(client, connectionString, $"design_knowledge_snapshot_test_{Guid.NewGuid():N}");
            fixture.SetTeamIds(teamIds ?? []);
            return fixture;
        }

        private void SetTeamIds(IReadOnlyList<string> teamIds)
        {
            _teams.Setup(service => service.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync(teamIds.ToList());
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
