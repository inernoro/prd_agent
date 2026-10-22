using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionImportUpsertTests
{
    [Theory]
    [InlineData("initiation", "T1.2.3")]
    [InlineData("release", "V1.2.3")]
    public async Task RepeatUploadUpdatesSameIdentityAndDifferentApplicationsCanShareCode(string kind, string code)
    {
        await using var f = await Fixture.Create();
        var row = Row("应用甲", code, "初次方案");
        var first = await f.Import(kind, row);
        Assert.Equal(1, first.GetProperty("created").GetInt32());
        var id = kind == "initiation" ? (await f.Db.ProductInitiations.Find(_ => true).SingleAsync()).Id : (await f.Db.ProductReleases.Find(_ => true).SingleAsync()).Id;
        row.PlanName = "覆盖后的方案"; row.Remark = "覆盖备注";
        var repeat = await f.Import(kind, row);
        Assert.Equal(0, repeat.GetProperty("created").GetInt32());
        Assert.Equal(1, repeat.GetProperty("updated").GetInt32());
        await f.Import(kind, Row("应用乙", code, "其它应用同号"));
        if (kind == "initiation") {
            var all = await f.Db.ProductInitiations.Find(_ => true).ToListAsync();
            Assert.Equal(2, all.Count); Assert.Equal("覆盖后的方案", all.Single(x => x.Id == id).PlanName);
            Assert.Equal("覆盖备注", all.Single(x => x.Id == id).Remark);
        } else {
            var all = await f.Db.ProductReleases.Find(_ => true).ToListAsync();
            Assert.Equal(2, all.Count); Assert.Equal("覆盖后的方案", all.Single(x => x.Id == id).PlanName);
        }
        Assert.Equal(0, await f.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
        var preview = await ProductVersionDebugClear.PreviewAsync(f.Db, kind == "initiation" ? "internal" : "formal");
        var clear = await ProductVersionDebugClear.ClearAsync(f.Db, preview.Kind, preview.Token, "admin");
        Assert.Equal(2, clear!.ClearedCount); Assert.Null(clear.BackupId);
        Assert.Equal(1, (await f.Import(kind, row)).GetProperty("created").GetInt32());
        Assert.Equal(0, await f.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
    }

    [Theory]
    [InlineData("initiation", "T1.2.3")]
    [InlineData("release", "V1.2.3")]
    public async Task ConcurrentImportsOnlyCreateOneRow(string kind, string code)
    {
        await using var f = await Fixture.Create();
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(i => f.Import(kind, Row("应用甲", code, "并发" + i))));
        Assert.Equal(1, results.Sum(x => x.GetProperty("created").GetInt32()));
        Assert.Equal(7, results.Sum(x => x.GetProperty("updated").GetInt32()));
        Assert.All(results, x => Assert.Empty(x.GetProperty("errors").EnumerateArray()));
        Assert.Equal(1, kind == "initiation" ? await f.Db.ProductInitiations.CountDocumentsAsync(_ => true) : await f.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ExistingIssuedIdentityApplicantCategoryAndReviewSurviveOverwriteAndMissingKeysDoNotCreateDrafts()
    {
        await using var f = await Fixture.Create();
        await f.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "original", ProductId = "a", TCode = "T1.2.3", VersionType = "major", CreatedBy = "someone", ReviewSubmissionId = "review", ReviewPassed = true, Status = "approved", RequirementIds = new() { "req" } });
        await f.Import("initiation", Row("应用甲", "t1.2.3", "更新"));
        var saved = await f.Db.ProductInitiations.Find(_ => true).SingleAsync();
        Assert.Equal("original", saved.Id); Assert.Equal("someone", saved.CreatedBy);
        Assert.Equal("major", saved.VersionType); Assert.Equal("review", saved.ReviewSubmissionId);
        Assert.True(saved.ReviewPassed); Assert.Equal(new[] { "req" }, saved.RequirementIds);
        var skipped = await f.Import("initiation", Row("应用甲", "", "无号"), Row("未知应用", "T1.2.4", "未知"));
        Assert.Equal(2, skipped.GetProperty("skipped").GetInt32());
        Assert.Equal(1, await f.Db.ProductInitiations.CountDocumentsAsync(_ => true));
    }

    private static ImportVersionWorkflowRow Row(string app, string code, string name) => new() { AppName = app, Code = code, PlanName = name, VersionType = "minor" };
    private sealed class Fixture : IAsyncDisposable
    {
        public MongoDbContext Db { get; }
        private Fixture(MongoDbContext db) { Db = db; }
        public static async Task<Fixture> Create() {
            var f = new Fixture(new MongoDbContext(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018", "version_upsert_" + Guid.NewGuid().ToString("N")));
            await f.Db.Users.InsertOneAsync(new User { UserId = "admin", Role = UserRole.ADMIN });
            await f.Db.ProductCategories.InsertManyAsync(ProductCategory.BuiltinSeeds);
            await f.Db.Products.InsertManyAsync(new[] { new Product { Id = "a", Name = "应用甲", Grade = "application" }, new Product { Id = "b", Name = "应用乙", Grade = "application" } });
            return f;
        }
        public async Task<JsonElement> Import(string kind, params ImportVersionWorkflowRow[] rows) {
            var controller = new ProductAgentController(Db, NullLogger<ProductAgentController>.Instance, null!, null!, null!, null!, null!, null!) { ControllerContext = new() { HttpContext = new DefaultHttpContext { User = new(new ClaimsIdentity(new[] { new Claim("sub", "admin"), new Claim("permissions", AdminPermissionCatalog.ProductAgentUse), new Claim("permissions", AdminPermissionCatalog.ProductAgentAdmin) }, "test")) } } };
            var result = Assert.IsType<OkObjectResult>(await controller.OverviewImportVersionWorkflow(new() { Kind = kind, Rows = rows.ToList() }));
            return JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(result.Value).Data);
        }
        public async ValueTask DisposeAsync() => await Db.Database.Client.DropDatabaseAsync(Db.Database.DatabaseNamespace.DatabaseName);
    }
}
