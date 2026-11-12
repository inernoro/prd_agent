using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using MongoDB.Driver;
using System.Text.Json;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class KnowledgeRetrievalTests
{
    private const string Model = "test-embedding";
    private static readonly float[] Query = { 1, 0 };

    [Fact]
    public void PrivateSourcesNeverEnterResultsEvenWithPerfectSimilarity()
    {
        var owned = Doc("owned", "owner", false, "可见依据");
        var secret = Doc("secret", "someone-else", false, "绝密依据");
        var hits = Rank(new[] { Row(owned), Row(secret) }, new[] { owned, secret });
        Assert.Equal("owned", Assert.Single(hits).Entry.Id);
    }

    [Fact]
    public void PublicSourceIsReadableButRevocationTakesEffectOnNextRanking()
    {
        var source = Doc("shared", "someone-else", true, "公开依据");
        var row = Row(source);
        Assert.Single(Rank(new[] { row }, new[] { source }));
        source.Store.IsPublic = false;
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void DeletedEntryAndDeletedStoreCannotBeReturnedFromRetainedVectors()
    {
        var source = Doc("deleted", "owner", false, "已删除正文");
        Assert.Empty(Rank(new[] { Row(source) }, Array.Empty<KnowledgeRetrievalDocument>()));
    }

    [Fact]
    public void UpdatingBodyImmediatelyExcludesStaleChunkWithoutReindex()
    {
        var original = Doc("edited", "owner", false, "报销上限是五百元。");
        var row = Row(original);
        var updated = original with { Content = "报销上限现为三百元。" };
        Assert.Empty(Rank(new[] { row }, new[] { updated }));
        Assert.Single(Rank(new[] { Row(updated) }, new[] { updated }));
    }

    [Fact]
    public void TamperedTextCannotPassCurrentContentHashCheck()
    {
        var source = Doc("entry", "owner", false, "真实原文");
        var row = Row(source);
        row.Text = "伪造原文";
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Theory]
    [InlineData("other-model", 2)]
    [InlineData(Model, 3)]
    public void SameDimensionOtherModelAndWrongDimensionAreExcluded(string model, int dimension)
    {
        var source = Doc("entry", "owner", false, "真实原文");
        var row = Row(source);
        row.Model = model;
        row.Dimension = dimension;
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void PreviewAndProductionCannotReadEachOthersVectors()
    {
        var source = Doc("entry", "owner", false, "真实原文");
        var row = Row(source);
        row.DeploymentSlug = "another-preview";
        Assert.Empty(Rank(new[] { row }, new[] { source }));
        Assert.Single(KnowledgeRetrievalService.RankCurrent(new[] { row }, new[] { source },
            "owner", Model, Query, 5, "another-preview"));
    }

    [Fact]
    public void TopFiveContainsFiveDistinctDocumentsInsteadOfFiveChunksFromOne()
    {
        var docs = Enumerable.Range(0, 7).Select(i => Doc($"entry-{i}", "owner", false, $"依据{i}")).ToArray();
        var repeated = Enumerable.Repeat(Row(docs[0]), 8).Concat(docs.Skip(1).Select(doc => Row(doc)));
        var hits = Rank(repeated, docs);
        Assert.Equal(5, hits.Count);
        Assert.Equal(5, hits.Select(x => x.Entry.Id).Distinct().Count());
    }

    [Fact]
    public void NoRelevantVectorReturnsNoEvidenceAndDoesNotPromoteLowScore()
    {
        var source = Doc("entry", "owner", false, "无关内容");
        var row = Row(source);
        row.Vector = EmbeddingVector.Encode(new float[] { 0, 1 });
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void CorruptBytesAndFolderEntriesAreExcluded()
    {
        var source = Doc("entry", "owner", false, "真实正文");
        var row = Row(source);
        row.Vector = new byte[1];
        Assert.Empty(Rank(new[] { row }, new[] { source }));
        row = Row(source);
        source.Entry.IsFolder = true;
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void WrongStoreAssociationCannotExposeEvenOwnedEntry()
    {
        var source = Doc("entry", "owner", false, "真实正文");
        var row = Row(source);
        row.StoreId = "other-store";
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task LocalMongoIndexSearchUpdateDeleteAndPermissionPipeline()
    {
        // Explicit local-only fixture. CI excludes Integration; invoke this test by name with
        // a disposable MongoDB listening on this loopback port. No production connection input.
        const string connection = "mongodb://127.0.0.1:27029/?serverSelectionTimeoutMS=3000";
        var databaseName = "codex_kb_retrieval_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        var db = new MongoDbContext(connection, databaseName);
        var context = new LLMRequestContextAccessor();
        using var outer = context.BeginScope(new LlmRequestContext("integration", null, null, "owner", null,
            null, null, null, TenantId: "verified-tenant"));
        var embedding = new PipelineEmbedding(context);
        var service = new KnowledgeRetrievalService(db, embedding, context);
        try
        {
            var owned = Doc("own-entry", "owner", false, "报销额度五百元");
            var secret = Doc("secret-entry", "other-user", false, "他人的保密预算");
            foreach (var source in new[] { owned, secret })
            {
                source.Entry.DocumentId = "body-" + source.Entry.Id;
                await db.DocumentStores.InsertOneAsync(source.Store);
                await db.DocumentEntries.InsertOneAsync(source.Entry);
                await db.Documents.InsertOneAsync(new ParsedPrd { Id = source.Entry.DocumentId, RawContent = source.Content });
            }
            Assert.True((await service.IndexEntryAsync(owned.Entry.Id, "owner", default)).Success);
            var calls = embedding.EmbedCalls;
            Assert.True((await service.IndexEntryAsync(owned.Entry.Id, "owner", default)).Success);
            Assert.Equal(calls, embedding.EmbedCalls); // Unchanged body reuses persisted vectors.
            Assert.False((await service.IndexEntryAsync(secret.Entry.Id, "owner", default)).Success);
            Assert.Equal(calls, embedding.EmbedCalls); // Rejected before external calls.
            Assert.True((await service.IndexEntryAsync(secret.Entry.Id, "other-user", default)).Success);
            var found = await service.SearchAsync("报销额度", null, "owner", 5, default);
            Assert.True(found.Success);
            using (var json = JsonDocument.Parse(found.Content!))
            {
                Assert.Equal(1, json.RootElement.GetProperty("total").GetInt32());
                Assert.Equal(owned.Entry.Id, json.RootElement.GetProperty("contextEntryIds")[0].GetString());
                Assert.DoesNotContain(secret.Content, found.Content!);
            }
            await db.Documents.UpdateOneAsync(doc => doc.Id == owned.Entry.DocumentId,
                Builders<ParsedPrd>.Update.Set(doc => doc.RawContent, "报销额度三百元"));
            var stale = await service.SearchAsync("报销额度", owned.Store.Id, "owner", 5, default);
            Assert.True(stale.Success);
            using (var json = JsonDocument.Parse(stale.Content!))
            {
                Assert.Equal(0, json.RootElement.GetProperty("total").GetInt32());
                Assert.Equal(1, json.RootElement.GetProperty("staleChunks").GetInt32());
            }
            Assert.True((await service.IndexEntryAsync(owned.Entry.Id, "owner", default)).Success);
            var refreshed = await service.SearchAsync("报销额度", owned.Store.Id, "owner", 5, default);
            Assert.Contains("三百元", JsonDocument.Parse(refreshed.Content!).RootElement
                .GetProperty("items")[0].GetProperty("snippet").GetString());
            await db.DocumentEntries.DeleteOneAsync(entry => entry.Id == owned.Entry.Id);
            var deleted = await service.SearchAsync("报销额度", owned.Store.Id, "owner", 5, default);
            using var deletedJson = JsonDocument.Parse(deleted.Content!);
            Assert.Equal(0, deletedJson.RootElement.GetProperty("total").GetInt32());
            Assert.Empty(deletedJson.RootElement.GetProperty("contextEntryIds").EnumerateArray());
            Assert.All(embedding.Tenants, tenant => Assert.Equal("verified-tenant", tenant));
        }
        finally
        {
            await client.DropDatabaseAsync(databaseName);
        }
    }

    private sealed class PipelineEmbedding(ILLMRequestContextAccessor context) : IEmbeddingService
    {
        public int EmbedCalls { get; private set; }
        public List<string?> Tenants { get; } = new();
        public Task<string?> ResolveActiveModelAsync(string appCallerCode, CancellationToken ct = default)
        {
            Tenants.Add(context.Current?.TenantId);
            return Task.FromResult<string?>(Model);
        }
        public Task<EmbeddingBatch> EmbedAsync(IReadOnlyList<string> texts, string appCallerCode,
            string userId, CancellationToken ct = default)
        {
            Assert.Equal(userId, context.Current?.UserId);
            Assert.False(ct.CanBeCanceled);
            Tenants.Add(context.Current?.TenantId);
            EmbedCalls++;
            return Task.FromResult(new EmbeddingBatch
            {
                Success = true, Model = Model, Dimension = 2,
                Vectors = texts.Select(_ => new float[] { 1, 0 }).ToList()
            });
        }
    }

    private static IReadOnlyList<KnowledgeRetrievalHit> Rank(IEnumerable<DocumentEmbedding> rows,
        IEnumerable<KnowledgeRetrievalDocument> docs)
        => KnowledgeRetrievalService.RankCurrent(rows, docs, "owner", Model, Query, 5, null);

    private static KnowledgeRetrievalDocument Doc(string id, string owner, bool isPublic, string content)
    {
        var store = new DocumentStore { Id = "store-" + id, OwnerId = owner, IsPublic = isPublic };
        var entry = new DocumentEntry { Id = id, StoreId = store.Id, Title = id };
        return new KnowledgeRetrievalDocument(store, entry, content);
    }

    private static DocumentEmbedding Row(KnowledgeRetrievalDocument doc) => new()
    {
        StoreId = doc.Store.Id, EntryId = doc.Entry.Id, Text = doc.Content,
        ContentHash = DocumentChunker.ComputeHash(doc.Content, Model), Model = Model, Dimension = 2,
        Vector = EmbeddingVector.Encode(Query)
    };
}
