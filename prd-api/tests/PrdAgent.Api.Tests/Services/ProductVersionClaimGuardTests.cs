using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionClaimGuardTests
{
    [Theory]
    [InlineData(false, "me", "me", true)]
    [InlineData(false, "me", "other", false)]
    [InlineData(true, "me", "other", true)]
    public void ReviewScopeRequiresExplicitClaimTest(bool enabled, string applicant, string submitter, bool expected)
        => Assert.Equal(expected, ProductVersionClaimPolicy.CanUseReview(applicant, submitter, enabled));

    [Fact]
    public void TestPermissionDoesNotGrantOrdinaryRolesOrReuseGeneralReviewPermission()
    {
        Assert.Contains(AdminPermissionCatalog.All, p => p.Key == AdminPermissionCatalog.ProductAgentVersionClaimTest);
        foreach (var role in BuiltInSystemRoles.Definitions.Where(r => r.Key != "admin"))
            Assert.DoesNotContain(AdminPermissionCatalog.ProductAgentVersionClaimTest, role.Permissions);
        Assert.NotEqual(AdminPermissionCatalog.ReviewAgentViewAll, AdminPermissionCatalog.ProductAgentVersionClaimTest);
    }

    [Fact]
    public void ManualAndSelectedTUseOneNormalizedApplicationKey()
    {
        Assert.Equal(ProductVersionClaimPolicy.ReleaseKey("应用 A", "T1.2.3"), ProductVersionClaimPolicy.ReleaseKey(" 应用 A ", " t1.2.3 "));
        Assert.NotEqual(ProductVersionClaimPolicy.ReleaseKey("应用 A", "T1.2.3"), ProductVersionClaimPolicy.ReleaseKey("应用 B", "T1.2.3"));
        Assert.NotEqual(ProductVersionClaimPolicy.ReviewKey("id"), ProductVersionClaimPolicy.ReviewKey("ID"));
    }

    [Theory]
    [InlineData("review:source")]
    [InlineData("release:application-t")]
    public async Task RealMongoConcurrentClaimsHaveOneWinnerAndNoExpiryReuse(string key)
    {
        await using var fixture = await Fixture.CreateAsync();
        var targets = Enumerable.Range(0, 24).Select(i => "target:" + i).ToArray();
        var results = await Task.WhenAll(targets.Select(id => ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, key, id)));
        Assert.Equal(1, results.Count(x => x));
        var winner = targets[Array.FindIndex(results, x => x)];
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, key, winner));
        // 即使业务写入尚未完成、连接中断或进程重启，也不能靠过期重占而生成第二个号。
        Assert.False(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, key, "after-restart"));
        Assert.Equal(1, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName).CountDocumentsAsync(_ => true));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualListAndCreateEnforceApplicantScope(bool claimTest)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ReviewSubmissions.InsertManyAsync(new[] {
            Review("mine", "me"), Review("other", "someone"), Review("failed", "someone", false),
        });
        var list = await fixture.Controller(claimTest).ListProductVersionReviewSources();
        var payload = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(list).Value).Data);
        var ids = payload.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("Id").GetString()).ToArray();
        Assert.Contains("mine", ids);
        Assert.Equal(claimTest, ids.Contains("other"));
        Assert.DoesNotContain("failed", ids);
        var request = Request("other");
        var created = await fixture.Controller(claimTest).CreateInitiation("product", request);
        if (claimTest) Assert.IsType<OkObjectResult>(created);
        else Assert.IsType<BadRequestObjectResult>(created);
        Assert.Equal(claimTest ? 1 : 0, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ActualConcurrentInitiationsCannotReuseOneReview()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ReviewSubmissions.InsertOneAsync(Review("source", "me"));
        var results = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => fixture.Controller().CreateInitiation("product", Request("source"))));
        Assert.Single(results.OfType<OkObjectResult>());
        Assert.Equal(1, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        var list = await fixture.Controller().ListProductVersionReviewSources();
        var payload = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(list).Value).Data);
        Assert.Empty(payload.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task LegacyAndDeletedSourcesStayOccupiedAndSameInitiationCanResync()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "old", IsDeleted = true, ReviewSubmissionId = "product-source",
            ReviewAttempts = new() { new() { SubmissionId = "attempt-source" } },
        });
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { ReviewSubmissionId = "legacy-source" });
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, ProductVersionClaimPolicy.ReviewKey("pending"), "initiation:same"));
        foreach (var id in new[] { "product-source", "attempt-source", "legacy-source", "pending" })
            Assert.True(await ProductVersionClaimGuard.IsReviewUsedAsync(fixture.Db, id));
        Assert.False(await ProductVersionClaimGuard.IsReviewUsedAsync(fixture.Db, "pending", "same"));
        var used = await ProductVersionClaimGuard.UsedReviewIdsAsync(fixture.Db);
        Assert.Equal(4, used.Count);
    }

    [Fact]
    public async Task ConcurrentDecisionCannotReturnTwoTCodes()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "initiation", ProductId = "product", CreatedBy = "me", ReviewPassed = true, Status = "decision_pending",
        });
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => fixture.Controller().DecideInitiation("initiation",
            new InitiationDecisionRequest { ReviewMeetingRequired = true, ExpectedMeetingAt = DateTime.UtcNow.AddDays(1) })));
        Assert.Single(results.OfType<OkObjectResult>());
        var stored = await fixture.Db.ProductInitiations.Find(x => x.Id == "initiation").SingleAsync();
        Assert.False(string.IsNullOrWhiteSpace(stored.TCode));
        Assert.Equal("approved", stored.Status);
    }

    private static ReviewSubmission Review(string id, string submitter, bool passed = true) => new() {
        Id = id, SubmitterId = submitter, Title = id, Status = ReviewStatuses.Done, IsPassed = passed,
    };

    [Fact]
    public async Task ConcurrentLegacyVAndProductManualTShareOneClaim()
    {
        await using var fixture = await Fixture.CreateAsync();
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => fixture.LegacyController().CreateFormalVersionRegistration(
            new CreateFormalVersionRegistrationRequest {
                SourceMode = VersionRegistrationSourceType.ManualT, ApplicationId = "application",
                TCode = "T1.2.3", ProjectType = "standard", VersionType = "minor", PlannedTrainingMinutes = 0,
            }, CancellationToken.None)));
        Assert.Single(results.OfType<OkObjectResult>());
        Assert.Equal(1, await fixture.Db.VersionRegistrations.CountDocumentsAsync(x => x.Kind == VersionRegistrationKind.Formal));
        var fromProduct = await fixture.Controller().CreateRelease("product", new CreateReleaseRequest { ManualTCode = "T1.2.3", PlanName = "重复方案" });
        Assert.IsType<BadRequestObjectResult>(fromProduct);
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task LegacyVCannotBypassDeletedProductClaim()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease { ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", VCode = "V1.2.3", IsDeleted = true });
        var result = await fixture.LegacyController().CreateFormalVersionRegistration(new CreateFormalVersionRegistrationRequest {
            SourceMode = VersionRegistrationSourceType.ManualT, ApplicationId = "application",
            TCode = "T1.2.3", ProjectType = "standard", VersionType = "minor", PlannedTrainingMinutes = 0,
        }, CancellationToken.None);
        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(0, await fixture.Db.VersionRegistrations.CountDocumentsAsync(_ => true));
    }
    private static CreateInitiationRequest Request(string review) => new() {
        LinkedProductId = "product", PlanName = "申领测试方案", ReviewSubmissionId = review,
    };

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient client;
        private readonly string databaseName;
        public MongoDbContext Db { get; }
        private Fixture(string connection, string name)
        {
            client = new MongoClient(connection); databaseName = name; Db = new MongoDbContext(connection, name);
        }
        public static async Task<Fixture> CreateAsync()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
            var fixture = new Fixture(connection, "version_claim_test_" + Guid.NewGuid().ToString("N"));
            await fixture.Db.ProductCategories.InsertManyAsync(ProductCategory.BuiltinSeeds);
            await fixture.Db.Products.InsertOneAsync(new Product { Id = "product", Name = "测试应用", Grade = "application", MemberIds = new() { "me" } });
            await fixture.Db.ProductCategories.InsertOneAsync(new ProductCategory { Id = "application", Name = "应用" });
            await fixture.Db.VersionRegistrySystems.InsertOneAsync(new VersionRegistrySystem { Id = "system", Name = "测试系统" });
            await fixture.Db.VersionRegistryApplications.InsertOneAsync(new VersionRegistryApplication { Id = "application", Name = "测试应用", SystemId = "system", SystemName = "测试系统" });
            return fixture;
        }
        public ProductAgentController Controller(bool test = false)
        {
            var claims = new List<Claim> { new("sub", "me"), new("permissions", AdminPermissionCatalog.ProductAgentUse) };
            if (test) claims.Add(new("permissions", AdminPermissionCatalog.ProductAgentVersionClaimTest));
            var http = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test")) };
            return new ProductAgentController(Db, NullLogger<ProductAgentController>.Instance, null!, null!, null!, null!, null!, null!) {
                ControllerContext = new ControllerContext { HttpContext = http },
            };
        }
        public ReviewAgentController LegacyController() => new(Db, null!, NullLogger<ReviewAgentController>.Instance, null!, null!) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "me"), new Claim("permissions", AdminPermissionCatalog.ReviewAgentUse) }, "test")),
            } },
        };
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(databaseName));
    }
}
