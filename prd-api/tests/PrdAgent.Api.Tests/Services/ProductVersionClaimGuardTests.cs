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

    [Fact]
    public async Task FailedReviewRetainsAllInputsAndRetryUsesSameInitiation()
    {
        await using var fixture = await Fixture.CreateAsync();
        var plannedAt = new DateTime(2026, 10, 21, 0, 0, 0, DateTimeKind.Utc);
        var input = new CreateInitiationRequest {
            LinkedProductId = "product", PlanName = "测试应用（方案）第二稿", PlanFileName = "第二稿.md",
            ProjectType = "custom", CustomerSource = "客户", DemandSource = "拜耳", Remark = "保留填写内容",
            VersionType = "medium", PlannedProjectAt = plannedAt, NeedUiDesign = false, IsAiPoc = true,
            ReviewMeetingRequired = true,
        };
        var created = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateInitiation("product", input));
        var item = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(created.Value).Data);
        var failedReview = Review("failed-review", "me", false);
        failedReview.FileName = "第二稿.md";
        await fixture.Db.ReviewSubmissions.InsertOneAsync(failedReview);
        Assert.IsType<OkObjectResult>(await fixture.Controller().SyncInitiationReview(item.Id,
            new SyncInitiationReviewRequest { SubmissionId = failedReview.Id }));
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DecideInitiation(item.Id,
            new InitiationDecisionRequest { ReviewMeetingRequired = true }));

        var failed = await fixture.Db.ProductInitiations.Find(x => x.Id == item.Id).SingleAsync();
        Assert.Equal("review_failed", failed.Status); Assert.Null(failed.TCode);
        Assert.Equal(input.PlanName, failed.PlanName); Assert.Equal("拜耳", failed.DemandSource);
        Assert.Equal("客户", failed.CustomerSource); Assert.Equal("custom", failed.ProjectType);
        Assert.Equal("medium", failed.VersionType); Assert.Equal(input.Remark, failed.Remark);
        Assert.Equal(plannedAt, failed.PlannedProjectAt); Assert.Equal(plannedAt, failed.ExpectedMeetingAt);
        Assert.True(failed.ReviewMeetingRequired); Assert.Equal(2, failed.MeetingDraftCount);
        Assert.False(failed.NeedUiDesign); Assert.True(failed.IsAiPoc);
        Assert.Equal("第二稿.md", Assert.Single(failed.ReviewAttempts).PlanFileName);

        input.Remark = "修改后继续";
        Assert.IsType<OkObjectResult>(await fixture.Controller().UpdateInitiation(item.Id, input));
        var passedReview = Review("passed-review", "me"); passedReview.FileName = "第二稿.md";
        await fixture.Db.ReviewSubmissions.InsertOneAsync(passedReview);
        Assert.IsType<OkObjectResult>(await fixture.Controller().SyncInitiationReview(item.Id,
            new SyncInitiationReviewRequest { SubmissionId = passedReview.Id }));
        // 无需再传另一份预计会议时间，直接复用已保存的计划立项日期。
        Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation(item.Id,
            new InitiationDecisionRequest { ReviewMeetingRequired = true, MeetingDraftCount = 2 }));
        var approved = await fixture.Db.ProductInitiations.Find(x => x.Id == item.Id).SingleAsync();
        Assert.False(string.IsNullOrWhiteSpace(approved.TCode));
        Assert.Equal(plannedAt, approved.ExpectedMeetingAt); Assert.Equal("修改后继续", approved.Remark);
        Assert.Equal(2, approved.ReviewAttempts.Count);
        Assert.Equal(1, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task OwnerChoiceIsSavedBeforeReviewAndStillRequiresApproval()
    {
        await using var fixture = await Fixture.CreateAsync();
        var created = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateInitiation("product", new CreateInitiationRequest {
            LinkedProductId = "product", PlanName = "测试应用（无需线下会议）", ReviewMeetingRequired = false,
            PrimaryOwnerId = "owner", PlannedProjectAt = DateTime.UtcNow,
        }));
        var item = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(created.Value).Data);
        Assert.Equal("owner", item.PrimaryOwnerId); Assert.Null(item.TCode);
        await fixture.Db.ReviewSubmissions.InsertOneAsync(Review("passed", "me"));
        await fixture.Controller().SyncInitiationReview(item.Id, new SyncInitiationReviewRequest { SubmissionId = "passed" });
        Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation(item.Id,
            new InitiationDecisionRequest { ReviewMeetingRequired = false, PrimaryOwnerId = "owner" }));
        var pending = await fixture.Db.ProductInitiations.Find(x => x.Id == item.Id).SingleAsync();
        Assert.Equal("owner_pending", pending.Status); Assert.Equal("owner", pending.PrimaryOwnerId); Assert.Null(pending.TCode);
    }

    private static ReviewSubmission Review(string id, string submitter, bool passed = true) => new() {
        Id = id, SubmitterId = submitter, Title = id, Status = ReviewStatuses.Done, IsPassed = passed,
    };

    [Fact]
    public async Task HistoricalVRawTMappingBlocksNewVDespiteDifferentPlanName()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", PlanName = "当前T方案", Status = "approved" });
        await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease {
            ProductId = "product", VCode = "V4.5.6", PlanName = "名称不同的历史方案", LegacyData = new() { ["内部版本号"] = "T1.2.3" },
        });
        var result = await fixture.Controller().CreateRelease("product", new CreateReleaseRequest {
            ManualTCode = "T1.2.3", PlanName = "当前T方案", HistoryConfirmationToken = "cannot-bypass-explicit-relation",
        });
        // 手工 T 已存在于当前 T 表时，本来就要求选对应立项；改用真实立项路径验证历史 V 对照。
        Assert.IsType<BadRequestObjectResult>(result);
        var initiation = await fixture.Db.ProductInitiations.Find(x => x.TCode == "T1.2.3").SingleAsync();
        result = await fixture.Controller().CreateRelease("product", new CreateReleaseRequest { InitiationId = initiation.Id, HistoryConfirmationToken = "cannot-bypass-explicit-relation" });
        var error = Assert.IsType<ApiResponse<object>>(Assert.IsType<BadRequestObjectResult>(result).Value).Error;
        Assert.Equal("DUPLICATE_RELEASE", error!.Code);
        Assert.Contains("V4.5.6", error.Message);
        Assert.Equal(1, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ExistingLegacyVBlocksProductManualTClaim()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration {
            Kind = VersionRegistrationKind.Formal, ApplicationName = "测试应用", TCode = "T1.2.3", Code = "V1.2.3",
        });
        var result = await fixture.Controller().CreateRelease("product", new CreateReleaseRequest {
            ManualTCode = "T1.2.3", PlanName = "重复方案",
        });
        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task LegacyHistoryReadsPersistedTCodeWithoutProductRawFields()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration {
            Kind = VersionRegistrationKind.Formal, ApplicationName = "测试应用", TCode = "T1.2.3",
            Code = "V8.9.0", PlanName = "不同的旧方案名称",
        });
        var result = await PrdAgent.Api.Services.ProductAgent.ProductVersionHistoryLinks.CheckAsync(
            fixture.Db, "product", "测试应用", "T1.2.3", "当前方案");
        Assert.True(result.Blocked);
        Assert.Contains("V8.9.0", result.Message);
    }

    [Fact]
    public async Task SelectedInitiationUsesItsActualApplicationForLegacyDuplicateCheck()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "linked", ProductId = "product", AppName = "方案归属应用", TCode = "T1.2.3", Status = "approved",
        });
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration {
            Kind = VersionRegistrationKind.Formal, ApplicationName = "方案归属应用", TCode = "T1.2.3", Code = "V1.2.3",
        });
        var result = await fixture.Controller().CreateRelease("product", new CreateReleaseRequest { InitiationId = "linked" });
        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
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
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(databaseName));
    }
}
