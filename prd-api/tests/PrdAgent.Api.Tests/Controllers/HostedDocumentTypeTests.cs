using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class HostedDocumentTypeTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public void RequestJsonKeepsDocumentTypeSeparateFromSourceTemplate()
    {
        var request = Request("调研报告");
        var json = JsonSerializer.SerializeToElement(request, Json);
        Assert.Equal("prd", json.GetProperty("writingTemplateId").GetString());
        Assert.True(json.TryGetProperty("documentType", out var type), "入参不能静默丢失作者选择的文档类型");
        Assert.Equal("调研报告", type.GetString());
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishedTypeSurvivesPersistenceReadAndCollectionProjectionWithoutChangingTemplate()
    {
        await using var fixture = Fixture.Create();
        var controller = fixture.Controller;
        var created = Data(await controller.CreateFromContent(Request(" 调研报告 ")));
        var id = created.GetProperty("id").GetString()!;
        var persisted = await fixture.Db.HostedSites.Find(s => s.Id == id).SingleAsync();
        var stored = JsonSerializer.SerializeToElement(persisted, Json);
        Assert.True(stored.TryGetProperty("documentType", out var type), "真实持久化结果必须保留独立文档类型");
        Assert.Equal("调研报告", type.GetString());
        Assert.Equal("prd", stored.GetProperty("writingTemplateId").GetString());
        Assert.Equal("调研报告", Data(await controller.Get(id)).GetProperty("documentType").GetString());
        Assert.Equal("owner", persisted.OwnerUserId);
        Assert.Empty(persisted.SharedTeamIds);

        var candidate = Data(await controller.CollectionCandidates()).GetProperty("items").EnumerateArray().Single();
        Assert.Equal("prd", candidate.GetProperty("templateId").GetString());
        Assert.Equal("调研报告", candidate.GetProperty("type").GetString());
        var collection = Data(await controller.CreateDocumentCollection(new WebPagesController.CollectionSaveRequest {
            Name = "独立类型验收", MainSiteId = id, SiteIds = new() { id }
        }));
        var collectionId = collection.GetProperty("collection").GetProperty("id").GetString()!;
        Assert.Equal("调研报告", collection.GetProperty("items")[0].GetProperty("type").GetString());
        Assert.Equal("prd", collection.GetProperty("items")[0].GetProperty("templateId").GetString());
        var saved = await fixture.Db.Database.GetCollection<HostedDocumentCollection>("hosted_document_collections")
            .Find(c => c.Id == collectionId).SingleAsync();
        Assert.Equal("调研报告", saved.MemberMetadata[id].Type);
        // 成员不可用时仍沿已保存的类型快照展示，不重新猜来源模版的类型。
        await fixture.Db.HostedSites.DeleteOneAsync(s => s.Id == id);
        var unavailable = Data(await controller.GetDocumentCollection(collectionId)).GetProperty("items")[0];
        Assert.True(unavailable.GetProperty("unavailable").GetBoolean());
        Assert.Equal("调研报告", unavailable.GetProperty("type").GetString());
    }

    [Theory]
    [Trait("Category", TestCategories.Integration)]
    [InlineData("prd", "需求说明")]
    [InlineData(null, "文档")]
    public async Task LegacySitesWithoutIndependentTypeKeepTheirTemplateFallback(string? template, string expected)
    {
        await using var fixture = Fixture.Create();
        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite {
            Id = "legacy", OwnerUserId = "owner", Title = "旧文档", WritingTemplateId = template,
        });
        var candidate = Data(await fixture.Controller.CollectionCandidates()).GetProperty("items")[0];
        Assert.Equal(expected, candidate.GetProperty("type").GetString());
        Assert.Equal(template, candidate.GetProperty("templateId").GetString());
    }

    [Theory]
    [Trait("Category", TestCategories.Integration)]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public async Task OptionalTypeKeepsTemplateFallbackOnNewDocuments(string? type)
    {
        await using var fixture = Fixture.Create();
        var created = Data(await fixture.Controller.CreateFromContent(Request(type)));
        Assert.Equal(JsonValueKind.Null, created.GetProperty("documentType").ValueKind);
        Assert.Equal("prd", created.GetProperty("writingTemplateId").GetString());
        var candidate = Data(await fixture.Controller.CollectionCandidates()).GetProperty("items")[0];
        Assert.Equal("需求说明", candidate.GetProperty("type").GetString());
        Assert.Equal("prd", candidate.GetProperty("templateId").GetString());
    }

    [Theory]
    [InlineData("并不存在的文档类型")]
    [InlineData("prd")]
    public async Task UnknownDocumentTypeIsRejectedBeforeCreatingAnyHostedSite(string type)
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var controller = new WebPagesController(sites.Object, null!, null!, null!, null!, null!);
        Assert.IsType<BadRequestObjectResult>(await controller.CreateFromContent(Request(type)));
        sites.Verify(s => s.CreateFromContentAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<List<string>?>(),
            It.IsAny<string?>(), It.IsAny<CancellationToken>(), It.IsAny<int?>()), Times.Never);
    }

    private static CreateFromContentRequest Request(string? documentType) => JsonSerializer.Deserialize<CreateFromContentRequest>(
        new JsonObject { ["htmlContent"] = "<article><h1>测试文档</h1><h2>适用范围</h2><p>仅限本轮测试。</p></article>",
            ["writingTemplateId"] = "prd", ["documentType"] = documentType, ["title"] = "类型保真测试" }, Json)!;

    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value, Json).GetProperty("data");

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _connection;
        private readonly string _databaseName = "map_v6_r3b_type_tests_" + Guid.NewGuid().ToString("N");
        private readonly string _root = Path.Combine(Path.GetTempPath(), "map-v6-r3b-" + Guid.NewGuid().ToString("N"));
        private readonly ServiceProvider _services = new ServiceCollection().AddSingleton<IConfiguration>(new ConfigurationBuilder().Build()).BuildServiceProvider();
        internal MongoDbContext Db { get; }
        internal WebPagesController Controller { get; }

        private Fixture(string connection)
        {
            _connection = connection;
            Db = new MongoDbContext(connection, _databaseName);
            var storage = new LocalAssetStorage(_root);
            var teams = new Mock<ITeamService>(MockBehavior.Strict);
            teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            teams.Setup(t => t.GetMyWebHostingTeamRolesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new Dictionary<string, string>());
            var service = new HostedSiteService(Db, storage, null!, null!, teams.Object, null!, null!, null!, NullLogger<HostedSiteService>.Instance);
            Controller = new WebPagesController(service, null!, null!, Db, teams.Object, null!, assetStorage: storage) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                    RequestServices = _services,
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner"), new Claim("name", "测试作者") }, "test"))
                } }
            };
            Controller.Request.Host = new HostString("localhost");
        }

        internal static Fixture Create() => new(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("Explicit isolated MONGODB_TEST_CONNECTION required"));

        public async ValueTask DisposeAsync()
        {
            try { await new MongoClient(_connection).DropDatabaseAsync(_databaseName); }
            finally { _services.Dispose(); if (Directory.Exists(_root)) Directory.Delete(_root, true); }
        }
    }
}
