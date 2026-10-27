using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionSourceLifecycleTests
{
    [Theory]
    [InlineData("minor", "T1.2.4")]
    [InlineData("medium", "T1.3.0")]
    [InlineData("major", "T2.0.0")]
    public async Task OnlyChronologicallyLatestCanRegenerateCategoryFromItsApplication(string type, string expected)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "older", ProductId = "other", AppName = "其它应用", TCode = "T99.0.0", CreatedBy = "me", Status = "approved", IssuedAt = DateTime.UtcNow.AddMinutes(-2) },
            new ProductInitiation { Id = "latest", ProductId = "product", LinkedProductId = "product", AppName = "测试应用", PlanName = "方案", TCode = "T1.2.3", CreatedBy = "me", VersionType = type == "minor" ? "medium" : "minor", Status = "approved", ReviewMeetingRequired = false, IssuedAt = DateTime.UtcNow.AddMinutes(-1) },
        });
        var request = new CreateInitiationRequest { LinkedProductId = "product", PlanName = "方案", VersionType = type, ReviewMeetingRequired = false };
        var changed = Data<ProductInitiation>(Assert.IsType<OkObjectResult>(await fixture.Controller().UpdateInitiation("latest", request)));
        Assert.Equal(expected, changed.TCode);
        Assert.Equal(type, changed.VersionType);
        Assert.Equal("T99.0.0", (await fixture.Db.ProductInitiations.Find(x => x.Id == "older").SingleAsync()).TCode);
        Assert.True(changed.CanDelete);
        Assert.True(changed.CanChangeVersionType);
        Assert.IsType<OkObjectResult>(await fixture.Controller().DeleteInitiation("latest"));
    }

    [Fact]
    public async Task AdministratorCannotDeleteOrSeeDeleteEligibilityForSomeoneElsesLatestRecord()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "latest", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", CreatedBy = "other", Status = "approved" });
        var row = await fixture.Db.ProductInitiations.Find(x => x.Id == "latest").SingleAsync();
        await ProductInitiationDeletion.AnnotateAsync(fixture.Db, new[] { row }, "me");
        Assert.False(row.CanDelete);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await fixture.Controller(admin: true).DeleteInitiation("latest")).StatusCode);
        Assert.True(await fixture.Db.ProductInitiations.Find(x => x.Id == "latest").AnyAsync());
    }

    [Fact]
    public async Task LateRequestCannotReclaimRemovedTargetButUnknownPendingTargetStaysReserved()
    {
        await using var fixture = await Fixture.CreateAsync();
        await ProductVersionClaimGuard.MarkSourceRemovalAsync(fixture.Db, "initiation:gone");
        Assert.False(await ProductVersionClaimGuard.TryReserveSourceAsync(fixture.Db, "review:source", "initiation:gone"));
        Assert.True(await ProductVersionClaimGuard.TryReserveSourceAsync(fixture.Db, "review:source", "initiation:pending"));
        Assert.False(await ProductVersionClaimGuard.TryReserveSourceAsync(fixture.Db, "review:source", "initiation:other"));
    }
    [Fact]
    public async Task DeletedIssuedInitiationReleasesReviewAndReclaimsCodeFromRemainingRecords()
    {
        await using var fixture = await Fixture.CreateAsync();
        var first = await fixture.CreateIssuedAsync();
        Assert.IsType<OkObjectResult>(await fixture.Controller().DeleteInitiation(first.Id));
        Assert.Null(await fixture.ClaimAsync(ProductVersionClaimPolicy.ReviewKey("source")));
        var second = await fixture.CreateIssuedAsync();
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal(first.TCode, second.TCode);
        Assert.Null(await fixture.Db.ProductInitiations.Find(x => x.Id == first.Id).FirstOrDefaultAsync());
        Assert.Equal("initiation:" + second.Id, (await fixture.ClaimAsync("review:source"))!["targetId"].AsString);
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .CountDocumentsAsync(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^workflow-code:T:"))));
    }

    [Fact]
    public async Task PreexistingDeletedReviewClaimRecoversWithOneConcurrentWinner()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "deleted", ProductId = "product", AppName = "测试应用", TCode = "T8.3.2", IsDeleted = true,
            ReviewSubmissionId = "source", ReviewAttempts = new() { new() { SubmissionId = "source" } },
        });
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, "review:source", "initiation:deleted");
        var appHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("product"))).ToLowerInvariant();
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, $"workflow-code:T:{appHash}:T8.3.2", "initiation:deleted");
        var results = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => fixture.Controller().CreateInitiation("product", Fixture.Request())));
        var created = Data<ProductInitiation>(Assert.Single(results.OfType<OkObjectResult>()));
        Assert.Equal(1, await fixture.Db.ProductInitiations.CountDocumentsAsync(x => !x.IsDeleted));
        var issued = Data<ProductInitiation>(Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation(created.Id,
            new InitiationDecisionRequest { ReviewMeetingRequired = false })));
        Assert.Equal("T0.0.1", issued.TCode);
        Assert.Equal("initiation:" + created.Id, (await fixture.ClaimAsync("review:source"))!["targetId"].AsString);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActiveOrUncertainSourceCannotBeTakenOver(bool pending)
    {
        await using var fixture = await Fixture.CreateAsync();
        if (!pending) await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "active", ProductId = "product", ReviewSubmissionId = "source", Status = "draft",
        });
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, "review:source", "initiation:active");
        var rejected = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateInitiation("product", Fixture.Request()));
        Assert.Equal("REVIEW_ALREADY_REGISTERED", Assert.IsType<ApiResponse<object>>(rejected.Value).Error!.Code);
        Assert.Equal("initiation:active", (await fixture.ClaimAsync("review:source"))!["targetId"].AsString);
    }

    [Fact]
    public async Task InternalDebugClearReleasesReviewButProtectsTCodeReferencedByValidFormalRecord()
    {
        await using var fixture = await Fixture.CreateAsync();
        var first = await fixture.CreateIssuedAsync();
        await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease {
            Id = "formal", ProductId = "product", InitiationId = first.Id, TCode = first.TCode, VCode = "V3.2.1",
        });
        var preview = await ProductVersionDebugClear.PreviewAsync(fixture.Db, "internal");
        Assert.NotNull(await ProductVersionDebugClear.ClearAsync(fixture.Db, "internal", preview.Token, "me"));
        Assert.Null(await fixture.ClaimAsync("review:source"));
        Assert.False((await fixture.Db.ProductReleases.Find(x => x.Id == "formal").SingleAsync()).IsDeleted);
        var second = await fixture.CreateIssuedAsync();
        Assert.NotEqual(first.TCode, second.TCode);
        Assert.Equal(ProductEntityNumbering.NextWorkflowCode("T", "minor", new[] { first.TCode! }), second.TCode);
        Assert.Equal(1, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
        Assert.Equal(1, await fixture.Db.ReviewSubmissions.CountDocumentsAsync(x => x.Id == "source"));
    }

    [Fact]
    public async Task FormalDebugClearReleasesTSourceAndUsesRemainingValidVBase()
    {
        await using var fixture = await Fixture.CreateAsync();
        var initiation = await fixture.CreateIssuedAsync();
        var first = Data<ProductRelease>(Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", Fixture.ReleaseRequest(initiation.Id))));
        var key = ProductVersionClaimPolicy.ReleaseKey("测试应用", initiation.TCode!);
        Assert.NotNull(await fixture.ClaimAsync(key));
        var preview = await ProductVersionDebugClear.PreviewAsync(fixture.Db, "formal");
        Assert.NotNull(await ProductVersionDebugClear.ClearAsync(fixture.Db, "formal", preview.Token, "me"));
        Assert.Null(await fixture.ClaimAsync(key));
        Assert.NotNull(await fixture.ClaimAsync("review:source"));
        Assert.False((await ProductVersionHistoryLinks.CheckAsync(fixture.Db, "product", "测试应用", initiation.TCode!, initiation.PlanName)).Blocked);
        var second = Data<ProductRelease>(Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", Fixture.ReleaseRequest(initiation.Id))));
        Assert.Equal(first.VCode, second.VCode);
        Assert.Null(await fixture.Db.ProductReleases.Find(x => x.Id == first.Id).FirstOrDefaultAsync());
    }

    [Theory]
    [InlineData("internal")]
    [InlineData("formal")]
    public async Task EmptyDebugClearRemovesOnlyProvenDeletedBusinessClaims(string kind)
    {
        await using var fixture = await Fixture.CreateAsync();
        var internalKind = kind == "internal";
        var key = internalKind ? "review:source" : ProductVersionClaimPolicy.ReleaseKey("测试应用", "T1.0.0");
        var target = internalKind ? "initiation:old" : "release:old";
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, "source-removed:" + target, target);
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, key, target);
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, "workflow-code:T:T1.0.0", "initiation:old");
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, internalKind ? "review:pending" : "release:pending", internalKind ? "initiation:pending" : "release:pending");
        var preview = await ProductVersionDebugClear.PreviewAsync(fixture.Db, kind);
        var cleared = await ProductVersionDebugClear.ClearAsync(fixture.Db, kind, preview.Token, "me");
        Assert.NotNull(cleared);
        Assert.Equal(0, cleared.ClearedCount);
        Assert.Null(await fixture.ClaimAsync(key));
        if (internalKind) Assert.Null(await fixture.ClaimAsync("workflow-code:T:T1.0.0"));
        else Assert.NotNull(await fixture.ClaimAsync("workflow-code:T:T1.0.0"));
        Assert.NotNull(await fixture.ClaimAsync(internalKind ? "review:pending" : "release:pending"));
        Assert.Equal(0, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
    }

    private static T Data<T>(OkObjectResult result) => Assert.IsType<T>(Assert.IsType<ApiResponse<object>>(result.Value).Data);

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient client;
        private readonly string name;
        public MongoDbContext Db { get; }
        private Fixture(string connection, string database) { client = new(connection); name = database; Db = new(connection, database); }
        public static async Task<Fixture> CreateAsync()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
            var f = new Fixture(connection, "version_source_test_" + Guid.NewGuid().ToString("N"));
            await f.Db.ProductCategories.InsertManyAsync(ProductCategory.BuiltinSeeds);
            await f.Db.Products.InsertOneAsync(new Product { Id = "product", Name = "测试应用", Grade = "application", MemberIds = new() { "me" } });
            await f.Db.VersionRegistrySystems.InsertOneAsync(new VersionRegistrySystem { Id = "system", Name = "测试系统" });
            await f.Db.VersionRegistryApplications.InsertOneAsync(new VersionRegistryApplication { Id = "application", Name = "测试应用", SystemId = "system", SystemName = "测试系统" });
            await f.Db.Users.InsertOneAsync(new User { UserId = "me", DisplayName = "测试申请人" });
            await f.Db.Features.InsertOneAsync(new Feature { Id = "feature", ProductId = "product", Title = "测试功能" });
            await f.Db.ReviewSubmissions.InsertOneAsync(new ReviewSubmission { Id = "source", SubmitterId = "me", Status = ReviewStatuses.Done, IsPassed = true });
            return f;
        }
        public ProductAgentController Controller(bool admin = false)
        {
            var claims = new List<Claim> {
                new Claim("sub", "me"), new Claim("permissions", AdminPermissionCatalog.ProductAgentUse),
            };
            if (admin) claims.Add(new Claim("permissions", AdminPermissionCatalog.ProductAgentAdmin));
            var http = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test")) };
            return new ProductAgentController(Db, NullLogger<ProductAgentController>.Instance, null!, null!, null!, null!, null!, null!) {
                ControllerContext = new ControllerContext { HttpContext = http },
            };
        }
        public static CreateInitiationRequest Request() => new() { LinkedProductId = "product", PlanName = "测试应用（删除后重申领）", ReviewSubmissionId = "source", ReviewMeetingRequired = false };
        public static CreateReleaseRequest ReleaseRequest(string initiationId) => new() {
            InitiationId = initiationId, OwnerId = "me", TeamMemberIds = new() { "me" }, PlannedReleaseAt = DateTime.UtcNow.AddDays(1), PlannedTrainingMinutes = 30,
            FeatureManifest = new() { new() { FeatureId = "feature", ChangeType = FeatureChangeType.Added } },
        };
        public async Task<ProductInitiation> CreateIssuedAsync()
        {
            var created = Data<ProductInitiation>(Assert.IsType<OkObjectResult>(await Controller().CreateInitiation("product", Request())));
            return Data<ProductInitiation>(Assert.IsType<OkObjectResult>(await Controller().DecideInitiation(created.Id, new InitiationDecisionRequest { ReviewMeetingRequired = false })));
        }
        public Task<BsonDocument?> ClaimAsync(string key) => Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .Find(Builders<BsonDocument>.Filter.Eq("_id", key)).FirstOrDefaultAsync()!;
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(name));
    }
}
