using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
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

public class ProductVersionClaimGuardTests
{
    [Fact]
    public async Task ExactImpNoticeReturnsCamelCaseSourceAndApplicationFromAuthorizedInitiation()
    {
        await using var fixture = await Fixture.CreateAsync();
        // The directory fixture deliberately cannot be matched by its name; the real T/source is authoritative.
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "imp-plan", ProductId = "product", LinkedProductId = "product", PlanName = "米多总平台（IMP配套方案）",
            TCode = "T3.14.1", Status = "approved", DemandSource = "内部",
            PlanUrl = "https://miduo1031.yuque.com/rsaesz/oqbs8t/aeoyfh53233d5ssu",
        });
        const string notice = "【版本上线】\n项目类别：非定制\n版本类别：小版本\n需求来源：内部\n产品方案名称：米多星球T3.14.1(IMP配套方案)AI文档1-3稿\n方案地址：https://miduo1031.yuque.com/rsaesz/oqbs8t/aeoyfh53233d5ssu\n项目组成员：林坤、石玲\n计划上线时间：2026.10.26";
        foreach (var unused in new[] { 1, 2 })
        {
            var response = Assert.IsType<OkObjectResult>(await fixture.Controller().ParseProductVersionMessage(
                new ParseProductVersionMessageRequest { Kind = "formal", Text = notice }));
            var data = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(response.Value).Data,
                new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("result");
            Assert.Equal("T3.14.1", data.GetProperty("tCode").GetString());
            Assert.Equal("imp-plan", data.GetProperty("matchedInitiationId").GetString());
            Assert.Equal("product", data.GetProperty("matchedApplicationId").GetString());
            Assert.Equal("T3.14.1", Assert.Single(data.GetProperty("initiationCandidates").EnumerateArray()).GetProperty("tCode").GetString());
            Assert.Equal("standard", data.GetProperty("projectType").GetString());
            Assert.Equal("minor", data.GetProperty("versionType").GetString());
            Assert.Equal("内部", data.GetProperty("demandSource").GetString());
            Assert.Contains("aeoyfh53233d5ssu", data.GetProperty("planUrl").GetString()!);
            Assert.StartsWith("2026-10-26", data.GetProperty("plannedReleaseAt").GetString());
            Assert.Equal(new[] { "林坤", "石玲" }, data.GetProperty("projectMemberNames").EnumerateArray().Select(x => x.GetString()));
            Assert.Equal(8, data.GetProperty("matchedFields").GetArrayLength());
        }
        Assert.Equal(1, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task RepeatedNoticesResolveCanonicalApplicationAndLatestSourceWithoutIssuingNumbers()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Products.UpdateOneAsync(x => x.Id == "product", Builders<Product>.Update.Set(x => x.Name, "米多总平台"));
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "first-plan", ProductId = "product", LinkedProductId = "product", PlanName = "米多总平台（客户活动配置优化）", TCode = "T1.2.3", Status = "approved" },
            new ProductInitiation { Id = "next-plan", ProductId = "product", LinkedProductId = "product", PlanName = "米多总平台（渠道返利结单校验）", TCode = "T1.2.4", Status = "approved" },
        });
        async Task<VersionRegistrationMessageParseResult> Parse(string name)
        {
            var response = Assert.IsType<OkObjectResult>(await fixture.Controller().ParseProductVersionMessage(
                new ParseProductVersionMessageRequest { Kind = "formal", Text = $"【版本上线】\n产品方案名称：{name}\n项目组成员：张三、李四" }));
            var data = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(response.Value).Data);
            return data.GetProperty("result").Deserialize<VersionRegistrationMessageParseResult>()!;
        }
        foreach (var unused in new[] { 1, 2 })
        {
            var result = await Parse("米多星球R=TXXXX（客户活动配置优化）-AI文档");
            Assert.Equal("product", result.MatchedApplicationId);
            Assert.Equal("first-plan", result.MatchedInitiationId);
            Assert.Equal("T1.2.3", Assert.Single(result.InitiationCandidates).TCode);
        }
        var latest = await Parse("米多星球（渠道返利结单校验）-AI文档");
        Assert.Equal("product", latest.MatchedApplicationId);
        Assert.Equal("next-plan", latest.MatchedInitiationId);
        Assert.Equal("T1.2.4", Assert.Single(latest.InitiationCandidates).TCode);
        Assert.Equal(2, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task FormalNumberFromExistingTCompletesWithoutAnnouncementAndProgramCanWriteLinkLater()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.Features.DeleteManyAsync(_ => true);
        var request = NumberingReleaseRequest();
        request.FeatureManifest = null;
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.RequirementIds, new List<string> { "inherited-requirement" }));
        var created = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", request));
        var item = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(created.Value).Data);
        Assert.False(string.IsNullOrWhiteSpace(item.VCode));
        Assert.Empty(item.FeatureManifest);
        Assert.Equal("released", item.Status);
        Assert.NotNull(item.ReleasedAt);
        Assert.True(string.IsNullOrWhiteSpace(item.AnnouncementUrl));
        Assert.Equal("me", item.CreatedBy);
        Assert.Equal("me", item.OwnerId);
        Assert.Contains("inherited-requirement", item.RequirementIds);
        var duplicate = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        Assert.Equal("DUPLICATE_RELEASE", Assert.IsType<ApiResponse<object>>(duplicate.Value).Error!.Code);
        Assert.IsType<OkObjectResult>(await fixture.Controller().CompleteRelease(item.Id, new CompleteReleaseRequest()));
        var completed = Assert.IsType<OkObjectResult>(await fixture.Controller().CompleteRelease(item.Id,
            new CompleteReleaseRequest { AnnouncementUrl = "https://example.test/announcement" }));
        var saved = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(completed.Value).Data);
        Assert.Equal("released", saved.Status);
        Assert.Equal(item.VCode, saved.VCode);
        Assert.Equal("https://example.test/announcement", saved.AnnouncementUrl);
        Assert.Equal(item.ReleasedAt!.Value, saved.ReleasedAt!.Value, TimeSpan.FromMilliseconds(1));
        Assert.Empty(saved.FeatureManifest);
    }

    [Fact]
    public async Task FormalClaimCopiesStoredTTitleAndNeverChangesOriginalTRecord()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.ProductAgentSettings.InsertOneAsync(new ProductAgentSettings { ClaimWebhook = new() { Enabled = true } });
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.PlanName, "历史T原始名称（保持不变）")
                .Set(x => x.PlanUrl, "https://example.test/stored-t-plan").Set(x => x.DemandSource, "原T需求来源")
                .Set(x => x.DepartmentName, "原T部门").Set(x => x.RequirementDescription, "原T描述").Set(x => x.Remark, "原T备注"));
        var before = (await fixture.Db.ProductInitiations.Find(x => x.Id == "numbering-source").SingleAsync()).ToBsonDocument();
        var request = NumberingReleaseRequest();
        request.PlanName = "粘贴中完全不同的名称，不能改T或替代系统T名称";
        request.PlanUrl = "https://example.test/wrong-pasted";
        request.DemandSource = "错误来源"; request.DepartmentName = "错误部门";
        request.RequirementDescription = "错误描述"; request.Remark = "不能替换T资料";
        var response = Assert.IsType<OkObjectResult>(await fixture.Controller(notify: true).CreateRelease("product", request));
        var release = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(response.Value).Data);
        Assert.Equal("历史T原始名称（保持不变）", release.PlanName);
        Assert.Equal("https://example.test/stored-t-plan", release.PlanUrl);
        Assert.Equal("原T需求来源", release.DemandSource);
        Assert.Equal("原T部门", release.DepartmentName);
        Assert.Equal("原T描述", release.RequirementDescription);
        Assert.Equal("原T备注", release.Remark);
        Assert.Equal("pending", release.ClaimNotification!.Status);
        Assert.Equal(release.OwnerId, release.ClaimNotification.OwnerId);
        var after = (await fixture.Db.ProductInitiations.Find(x => x.Id == "numbering-source").SingleAsync()).ToBsonDocument();
        Assert.Equal(before, after);
        Assert.Equal(1, await fixture.Db.ProductReleases.CountDocumentsAsync(x => x.InitiationId == "numbering-source"));
    }

    [Fact]
    public async Task NewTNameUsesActualIssuedCodeAndLeavesPreviouslyIssuedTUntouched()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "old-t", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", Status = "approved", PlanName = "旧T名称原样保留" });
        var created = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateInitiation("product", new CreateInitiationRequest {
            LinkedProductId = "product", PlanName = "测试应用T待定（IMP配套方案）AI文档1-3稿",
        }));
        var item = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(created.Value).Data);
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == item.Id,
            Builders<ProductInitiation>.Update.Set(x => x.ReviewPassed, true).Set(x => x.Status, "decision_pending"));
        var response = Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation(item.Id, new InitiationDecisionRequest()));
        var issued = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(response.Value).Data);
        Assert.Equal($"测试应用{issued.TCode}（IMP配套方案）", issued.PlanName);
        Assert.Equal(issued.PlanName, (await fixture.Db.ProductInitiations.Find(x => x.Id == issued.Id).SingleAsync()).PlanName);
        Assert.Equal("旧T名称原样保留", (await fixture.Db.ProductInitiations.Find(x => x.Id == "old-t").SingleAsync()).PlanName);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("manual")]
    [InlineData("both")]
    [InlineData("draft")]
    [InlineData("deleted")]
    [InlineData("no-code")]
    [InlineData("invalid-code")]
    [InlineData("foreign")]
    public async Task FormalReleaseRequiresExistingApprovedTAndRejectsInvalidSourcesWithoutWrites(string scenario)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "source", ProductId = scenario == "foreign" ? "other" : "product", PlanName = "既有T方案",
            Status = scenario == "draft" ? "draft" : "approved", IsDeleted = scenario == "deleted",
            TCode = scenario == "no-code" ? null : scenario == "invalid-code" ? "TXXXX" : "T1.2.3",
        });
        var request = new CreateReleaseRequest {
            InitiationId = scenario is "missing" or "manual" ? null : "source",
            ManualTCode = scenario is "manual" or "both" ? "T1.2.3" : null,
            PlanName = "不能代替T来源的新方案",
        };
        var created = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        Assert.Equal(ErrorCodes.INVALID_FORMAT, Assert.IsType<ApiResponse<object>>(created.Value).Error!.Code);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CheckReleaseHistory("product", request.InitiationId, request.ManualTCode, request.PlanName));
        Assert.Equal(1, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName).CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task CustomVCompletesOnIssuanceWithoutAnnouncementAndExistingCustomPendingCanComplete()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.ProjectType, "custom").Set(x => x.RequirementIds, new List<string> { "custom-req" }));
        await fixture.Db.ProductWorkflowDefinitions.InsertOneAsync(new ProductWorkflowDefinition {
            Id = "custom-flow", States = new() {
                new() { Key = RequirementWorkflowCatalog.Developing, Label = "开发中" },
                new() { Key = RequirementWorkflowCatalog.Released, Label = "已上线" },
            },
            Transitions = new() { new() { FromState = RequirementWorkflowCatalog.Developing, ToState = RequirementWorkflowCatalog.Released } },
        });
        await fixture.Db.Requirements.InsertOneAsync(new Requirement {
            Id = "custom-req", ProductId = "product", WorkflowDefId = "custom-flow", CurrentState = RequirementWorkflowCatalog.Developing,
        });
        var request = NumberingReleaseRequest();
        request.FeatureManifest = null;
        request.ProjectType = "standard"; // The existing T record determines the project category.
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", request));
        var issued = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data);
        Assert.Equal("custom", issued.ProjectType);
        Assert.Equal("released", issued.Status);
        Assert.NotNull(issued.ReleasedAt);
        Assert.True(string.IsNullOrWhiteSpace(issued.AnnouncementUrl));
        Assert.False(string.IsNullOrWhiteSpace(issued.VCode));
        Assert.Equal(RequirementWorkflowCatalog.Released, (await fixture.Db.Requirements.Find(x => x.Id == "custom-req").SingleAsync()).CurrentState);
        await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease {
            Id = "old-custom-pending", ProductId = "product", ProjectType = "custom", Status = "announcement_pending", OwnerId = "me", VCode = "V1.2.3",
        });
        var completed = Assert.IsType<OkObjectResult>(await fixture.Controller().CompleteRelease("old-custom-pending", new CompleteReleaseRequest()));
        var saved = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(completed.Value).Data);
        Assert.Equal("released", saved.Status);
        Assert.True(string.IsNullOrWhiteSpace(saved.AnnouncementUrl));
    }

    [Fact]
    public async Task TemporaryOptimizationAndExplicitManifestStillUseExistingValidation()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        var request = NumberingReleaseRequest();
        request.IsTemporaryOptimization = true;
        request.InitiationId = null;
        request.FeatureManifest = null;
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        request.IsTemporaryOptimization = false;
        request.InitiationId = "numbering-source";
        request.FeatureManifest = new() { new() { FeatureId = "missing", ChangeType = FeatureChangeType.Added } };
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(x => x.CreatedBy == "me"));
    }

    [Theory]
    [InlineData(null, "me", "真实申请人")]
    [InlineData("owner", "owner", "其他负责人")]
    public async Task BusinessOwnerDefaultsToApplicantAndCanBeSelectedWithoutApproval(string? selected, string expectedId, string expectedName)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Users.InsertManyAsync(new[] {
            new User { UserId = "me", DisplayName = "真实申请人" },
            new User { UserId = "owner", DisplayName = "其他负责人" },
        });
        var request = new CreateInitiationRequest { LinkedProductId = "product", PlanName = "代申请方案", OwnerId = selected, OwnerName = "不能信任的姓名" };
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateInitiation("product", request));
        var item = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(result.Value).Data);
        Assert.Equal(expectedId, item.OwnerId);
        Assert.Equal(expectedName, item.OwnerName);
        Assert.Equal("me", item.CreatedBy);
        Assert.Null(item.PrimaryOwnerId);
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == item.Id,
            Builders<ProductInitiation>.Update.Set(x => x.ReviewPassed, true).Set(x => x.Status, "decision_pending"));
        var issued = Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation(item.Id, new InitiationDecisionRequest()));
        var saved = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(issued.Value).Data);
        Assert.NotNull(saved.TCode);
        Assert.Equal("approved", saved.Status);
        Assert.Equal(expectedId, saved.OwnerId);
        Assert.Equal(expectedName, saved.OwnerName);
        Assert.Equal("me", saved.CreatedBy);
        Assert.Null(saved.PrimaryOwnerId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task IssuedBusinessOwnerCanChangeWithoutChangingNumberCreatorOrApprovalHistory(bool selectOwner)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Users.InsertOneAsync(new User { UserId = "owner", DisplayName = "其他负责人" });
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "owner-issued", ProductId = "product", LinkedProductId = "product", PlanName = "历史方案", TCode = "T6.19.5",
            VersionType = "minor", Status = "approved", ReviewPassed = true, CreatedBy = "me", SourceType = "import",
            OwnerName = "历史负责人", PrimaryOwnerId = "old-approver", ApprovalComment = "保留审批历史", ReviewMeetingRequired = false,
        });
        var request = new CreateInitiationRequest { LinkedProductId = "product", PlanName = "历史方案", VersionType = "minor",
            ReviewMeetingRequired = false, PrimaryOwnerId = "old-approver", OwnerId = selectOwner ? "owner" : null, OwnerName = "不应覆盖姓名" };
        Assert.IsType<OkObjectResult>(await fixture.Controller().UpdateInitiation("owner-issued", request));
        var saved = await fixture.Db.ProductInitiations.Find(x => x.Id == "owner-issued").SingleAsync();
        Assert.Equal(selectOwner ? "owner" : null, saved.OwnerId);
        Assert.Equal(selectOwner ? "其他负责人" : "历史负责人", saved.OwnerName);
        Assert.Equal("me", saved.CreatedBy);
        Assert.Equal("old-approver", saved.PrimaryOwnerId);
        Assert.Equal("保留审批历史", saved.ApprovalComment);
        Assert.Equal("T6.19.5", saved.TCode);
        Assert.Equal("approved", saved.Status);
        Assert.True(saved.ReviewPassed);
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName).CountDocumentsAsync(_ => true));
        var list = await PrdAgent.Api.Services.ProductAgent.ProductVersionListReader.ReadInitiationsAsync(fixture.Db, null, "me", false);
        Assert.Equal(saved.OwnerId, Assert.Single(list.Items).Record.OwnerId);
    }

    [Theory]
    [InlineData("")]
    [InlineData("missing")]
    public async Task InvalidBusinessOwnerIsRejectedBeforeCreatingOrUpdating(string owner)
    {
        await using var fixture = await Fixture.CreateAsync();
        var request = new CreateInitiationRequest { LinkedProductId = "product", PlanName = "方案", OwnerId = owner };
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateInitiation("product", request));
        Assert.Equal(0, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "draft", ProductId = "product", CreatedBy = "me", OwnerName = "原负责人" });
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().UpdateInitiation("draft", request));
        Assert.Equal("原负责人", (await fixture.Db.ProductInitiations.Find(x => x.Id == "draft").SingleAsync()).OwnerName);
    }

    [Fact]
    public async Task BusinessOwnerDoesNotReplaceCreatorEditPermission()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "others", ProductId = "product", CreatedBy = "someone", OwnerId = "me", OwnerName = "业务负责人",
        });
        Assert.Equal(403, Assert.IsType<ObjectResult>(await fixture.Controller().UpdateInitiation("others",
            new CreateInitiationRequest { LinkedProductId = "product", PlanName = "不能借负责人身份修改" })).StatusCode);
    }

    [Theory]
    [InlineData("minor", "T6.19.6", "V6.19.6")]
    [InlineData("medium", "T6.20.0", "V6.20.0")]
    [InlineData("major", "T7.0.0", "V7.0.0")]
    public async Task WorkflowNumberingActualTAndVRequestsUseApplicationBaseline(string type, string expectedT, string expectedV)
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture, type);
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.TCode, null).Set(x => x.Status, "decision_pending"));
        var issuedT = Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(
            await fixture.Controller().DecideInitiation("numbering-source", new InitiationDecisionRequest())).Value);
        Assert.Equal(expectedT, Assert.IsType<ProductInitiation>(issuedT.Data).TCode);
        var issuedV = Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(
            await fixture.Controller().CreateRelease("product", NumberingReleaseRequest())).Value);
        var release = Assert.IsType<ProductRelease>(issuedV.Data);
        Assert.Equal(expectedV, release.VCode);
        Assert.Equal(type, release.VersionType);
        Assert.Equal("released", release.Status);
    }

    [Fact]
    public async Task WorkflowNumberingFormalDeletedHistoryDoesNotAdvanceTheRemainingBase()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, WorkflowClaimKey("product", "V", "V6.19.5"), "release:numbering-v-base");
        await fixture.Db.ProductReleases.UpdateOneAsync(x => x.Id == "numbering-v-base",
            Builders<ProductRelease>.Update.Set(x => x.IsDeleted, true));
        await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "remaining-v", ProductId = "product", VCode = "V6.19.4" });
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest()));
        Assert.Equal("V6.19.5", Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data).VCode);
    }

    [Fact]
    public async Task WorkflowNumberingUsesBusinessRecordsInsteadOfOldNumericReservations()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database,
            WorkflowClaimKey("product", "V", "V6.19.6"), "release:interrupted"));
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest()));
        Assert.Equal("V6.19.6", Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data).VCode);
    }

    [Fact]
    public async Task WorkflowNumberingLegacyBaseMatchesApplicationAndTClaimsDoNotAffectV()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration {
            Kind = VersionRegistrationKind.Formal, ApplicationName = " 测试应用 ", Code = "V6.19.9",
        });
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, "workflow-code:T:T99.0.0", "initiation:other"));
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest()));
        Assert.Equal("V6.19.10", Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data).VCode);
    }

    [Fact]
    public async Task WorkflowNumberingInvalidFormalRequestDoesNotAllocateANumber()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        var request = NumberingReleaseRequest();
        request.PlannedTrainingMinutes = -1;
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .CountDocumentsAsync(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^workflow-code:V:"))));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(30)]
    [InlineData(-1)]
    public async Task MiduoAdminReleaseDoesNotRequireOrStoreTrainingMinutes(int? minutes)
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.AppName, "米多总后台"));
        var sourceResponse = Assert.IsType<OkObjectResult>(await fixture.Controller().GetInitiation("numbering-source"));
        var source = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(sourceResponse.Value).Data);
        Assert.False(source.ReleaseTrainingRequired);
        Assert.Null((await fixture.Db.ProductInitiations.Find(x => x.Id == source.Id).SingleAsync()).ReleaseTrainingRequired);
        var request = NumberingReleaseRequest();
        request.PlannedTrainingMinutes = minutes;
        var response = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", request));
        var record = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(response.Value).Data);
        Assert.Null(record.PlannedTrainingMinutes);
        Assert.Equal("released", record.Status);
        Assert.StartsWith("V", record.VCode);
    }

    [Fact]
    public async Task OtherApplicationsStillRequireTrainingMinutes()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        var request = NumberingReleaseRequest(); request.PlannedTrainingMinutes = null;
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(x => x.InitiationId == request.InitiationId));
    }

    [Fact]
    public async Task WorkflowNumberingConcurrentDifferentTSourcesGetDistinctFormalNumbers()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        const int count = 12;
        await fixture.Db.ProductInitiations.InsertManyAsync(Enumerable.Range(0, count).Select(i => new ProductInitiation {
            Id = "concurrent-numbering-" + i, ProductId = "product", AppName = "测试应用", PlanName = "独立方案" + i,
            TCode = "T1.0." + i, VersionType = "minor", Status = "approved", ReviewPassed = true, CreatedBy = "me",
        }));
        var results = await Task.WhenAll(Enumerable.Range(0, count).Select(i =>
            fixture.Controller().CreateRelease("product", NumberingReleaseRequest("concurrent-numbering-" + i))));
        var codes = results.Select(result => Assert.IsType<ProductRelease>(
            Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value).Data).VCode).ToArray();
        Assert.Equal(count, codes.Distinct().Count());
        Assert.Equal(Enumerable.Range(6, count).Select(i => "V6.19." + i).OrderBy(x => x), codes.OrderBy(x => x));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .CountDocumentsAsync(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^workflow-code:V:"))));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionApplicationLease.CollectionName).CountDocumentsAsync(_ => true));
    }

    private static async Task SeedWorkflowNumberingAsync(Fixture fixture, string type = "minor")
    {
        await fixture.Db.Users.InsertOneAsync(new User { UserId = "me", DisplayName = "申领人" });
        await fixture.Db.Features.InsertOneAsync(new Feature { Id = "feature", ProductId = "product", Title = "测试功能" });
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "numbering-t-base", ProductId = "product", TCode = "T6.19.5", Status = "approved" },
            new ProductInitiation { Id = "numbering-other-t", ProductId = "other-product", AppName = "其他应用", TCode = "T99.0.0", Status = "approved" },
            new ProductInitiation { Id = "numbering-source", ProductId = "product", AppName = "测试应用", PlanName = "编号测试方案",
                VersionType = type, TCode = "T1.2.3", Status = "approved", ReviewPassed = true, CreatedBy = "me" },
        });
        await fixture.Db.ProductReleases.InsertManyAsync(new[] {
            new ProductRelease { Id = "numbering-v-base", ProductId = "product", VCode = "V6.19.5", Status = "released" },
            new ProductRelease { Id = "numbering-other-v", ProductId = "other-product", AppName = "其他应用", VCode = "V99.0.0", Status = "released" },
        });
        await fixture.Db.VersionRegistrations.InsertManyAsync(new[] {
            new VersionRegistration { Kind = VersionRegistrationKind.Internal, ApplicationName = "其他应用", Code = "T199.0.0" },
            new VersionRegistration { Kind = VersionRegistrationKind.Formal, ApplicationName = "其他应用", Code = "V199.0.0" },
        });
    }

    private static string WorkflowClaimKey(string productId, string prefix, string code) => "workflow-code:" + prefix + ":"
        + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(productId))).ToLowerInvariant() + ":" + code;

    [Fact]
    public async Task WorkflowNumberingLinkedApplicationHistoryIsUsedForBothTypes()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-t-base",
            Builders<ProductInitiation>.Update.Set(x => x.ProductId, "container").Set(x => x.LinkedProductId, "product"));
        await fixture.Db.ProductReleases.UpdateOneAsync(x => x.Id == "numbering-v-base",
            Builders<ProductRelease>.Update.Set(x => x.ProductId, "container").Set(x => x.InitiationId, "numbering-t-base"));
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.TCode, null).Set(x => x.Status, "decision_pending"));
        var t = Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation("numbering-source", new InitiationDecisionRequest()));
        Assert.Equal("T6.19.6", Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(t.Value).Data).TCode);
        var v = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest()));
        Assert.Equal("V6.19.6", Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(v.Value).Data).VCode);
    }

    [Fact]
    public async Task WorkflowNumberingDoesNotRestoreAnOldUnwrittenNumber()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database,
            "workflow-code:T:T9.0.0", "initiation:numbering-source"));
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.TCode, null).Set(x => x.Status, "decision_pending"));
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation("numbering-source", new InitiationDecisionRequest()));
        Assert.Equal("T6.19.6", Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(result.Value).Data).TCode);
        Assert.Equal(1, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .CountDocumentsAsync(Builders<BsonDocument>.Filter.Eq("targetId", "initiation:numbering-source")));
    }

    [Theory]
    [InlineData("T")]
    [InlineData("V")]
    public async Task WorkflowNumberingOldClaimsCannotAdvanceAnyApplication(string prefix)
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        var target = prefix == "T" ? "initiation:numbering-t-base" : "release:numbering-v-base";
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database,
            "workflow-code:" + prefix + ":" + prefix + "6.19.8", target));
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database,
            "workflow-code:" + prefix + ":" + prefix + "999.0.0", prefix == "T" ? "initiation:numbering-other-t" : "release:numbering-other-v"));
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database,
            WorkflowClaimKey("other-product", prefix, prefix + "9999.0.0"), "interrupted-other"));
        if (prefix == "T")
        {
            await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
                Builders<ProductInitiation>.Update.Set(x => x.TCode, null).Set(x => x.Status, "decision_pending"));
            var result = Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation("numbering-source", new InitiationDecisionRequest()));
            Assert.Equal("T6.19.6", Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(result.Value).Data).TCode);
        }
        else
        {
            var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest()));
            Assert.Equal("V6.19.6", Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data).VCode);
        }
    }

    [Fact]
    public async Task WorkflowNumberingLegacyTMatchesApplicationWithNumericOrdering()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.VersionRegistrations.InsertManyAsync(new[] {
            new VersionRegistration { Kind = VersionRegistrationKind.Internal, ApplicationName = "测试应用", Code = "T6.19.9" },
            new VersionRegistration { Kind = VersionRegistrationKind.Internal, ApplicationName = "测试应用", Code = "T6.19.10" },
        });
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-source",
            Builders<ProductInitiation>.Update.Set(x => x.TCode, null).Set(x => x.Status, "decision_pending"));
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation("numbering-source", new InitiationDecisionRequest()));
        Assert.Equal("T6.19.11", Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(result.Value).Data).TCode);
    }

    [Fact]
    public async Task WorkflowNumberingDistinctApplicationsCanIndependentlyIssueSameNumber()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        await fixture.Db.Products.InsertOneAsync(new Product { Id = "other-product", Name = "其他应用", Grade = "application", MemberIds = new() { "me" } });
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "numbering-other-t",
            Builders<ProductInitiation>.Update.Set(x => x.TCode, "T6.19.5"));
        await fixture.Db.ProductReleases.UpdateOneAsync(x => x.Id == "numbering-other-v",
            Builders<ProductRelease>.Update.Set(x => x.VCode, "V6.19.5"));
        await fixture.Db.VersionRegistrations.DeleteManyAsync(_ => true);
        await fixture.Db.Features.InsertOneAsync(new Feature { Id = "other-feature", ProductId = "other-product", Title = "其他功能" });
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "other-source", ProductId = "other-product", AppName = "其他应用", TCode = "T1.2.3", Status = "approved", VersionType = "minor", CreatedBy = "me",
        });
        var otherRequest = NumberingReleaseRequest("other-source");
        otherRequest.FeatureManifest[0].FeatureId = "other-feature";
        var results = await Task.WhenAll(fixture.Controller().CreateRelease("product", NumberingReleaseRequest()),
            fixture.Controller().CreateRelease("other-product", otherRequest));
        Assert.All(results, result => Assert.Equal("V6.19.6", Assert.IsType<ProductRelease>(
            Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value).Data).VCode));
    }

    private static CreateReleaseRequest NumberingReleaseRequest(string source = "numbering-source") => new() {
        InitiationId = source, OwnerId = "me", TeamMemberIds = new() { "me" }, VersionType = "major",
        PlannedReleaseAt = DateTime.UtcNow.AddDays(1), PlannedTrainingMinutes = 30,
        FeatureManifest = new() { new() { FeatureId = "feature", ChangeType = FeatureChangeType.Added } },
    };

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
            Review("mine-failed", "me", false),
            new ReviewSubmission { Id = "pending", SubmitterId = "me", Status = ReviewStatuses.Running },
        });
        var list = await fixture.Controller(claimTest).ListProductVersionReviewSources();
        var payload = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(list).Value).Data);
        var ids = payload.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("Id").GetString()).ToArray();
        Assert.Contains("mine", ids);
        Assert.Equal(claimTest, ids.Contains("other"));
        Assert.Equal(claimTest, ids.Contains("failed"));
        Assert.Contains("mine-failed", ids);
        Assert.Contains("pending", ids);
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
        Assert.Single(payload.GetProperty("items").EnumerateArray());
        var rejected = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateInitiation("product", Request("source")));
        Assert.Equal("REVIEW_ALREADY_REGISTERED", Assert.IsType<ApiResponse<object>>(rejected.Value).Error!.Code);
        Assert.Equal(1, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
    }

    [Theory]
    [InlineData(ReviewStatuses.Done, false, "REVIEW_NOT_PASSED")]
    [InlineData(ReviewStatuses.Running, null, "REVIEW_NOT_READY")]
    [InlineData(ReviewStatuses.Queued, null, "REVIEW_NOT_READY")]
    [InlineData(ReviewStatuses.Error, null, "REVIEW_NOT_READY")]
    public async Task IneligibleSourcesRemainVisibleButConfirmationWritesNothing(string status, bool? passed, string code)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ReviewSubmissions.InsertOneAsync(new ReviewSubmission { Id = "source", SubmitterId = "me", Status = status, IsPassed = passed });
        var result = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateInitiation("product", Request("source")));
        Assert.Equal(code, Assert.IsType<ApiResponse<object>>(result.Value).Error!.Code);
        Assert.Equal(0, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName).CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ListDoesNotTruncateAtNinetyThreeOrHideClaimedSources()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ReviewSubmissions.InsertManyAsync(Enumerable.Range(0, 125).Select(i => Review("source" + i, "me", i % 2 == 0)));
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { ReviewSubmissionId = "source0" });
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().ListProductVersionReviewSources());
        var payload = JsonSerializer.SerializeToElement(Assert.IsType<ApiResponse<object>>(result.Value).Data);
        Assert.Equal(125, payload.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task IssuedRecordCanEditMetadataWithoutChangingCodeOrReview()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "issued", ProductId = "product", LinkedProductId = "product", CreatedBy = "me",
            TCode = "T1.2.3", Status = "approved", VersionType = "minor", ReviewPassed = true,
            ReviewSubmissionId = "original", ReviewMeetingRequired = true, MeetingDraftCount = 2,
        });
        var request = new CreateInitiationRequest { LinkedProductId = "product", PlanName = "修改后方案", VersionType = "minor", ReviewMeetingRequired = true, Remark = "补充资料" };
        Assert.IsType<OkObjectResult>(await fixture.Controller().UpdateInitiation("issued", request));
        var record = await fixture.Db.ProductInitiations.Find(x => x.Id == "issued").SingleAsync();
        Assert.Equal("修改后方案", record.PlanName);
        Assert.Equal("补充资料", record.Remark);
        Assert.Equal("T1.2.3", record.TCode);
        Assert.Equal("approved", record.Status);
        Assert.Equal("original", record.ReviewSubmissionId);
        Assert.True(record.ReviewPassed);
        Assert.Equal(2, record.MeetingDraftCount);
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "later-issued", ProductId = "product", TCode = "T1.2.4", IssuedAt = DateTime.UtcNow.AddMinutes(1) });
        request.VersionType = "major";
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().UpdateInitiation("issued", request));
    }

    [Fact]
    public async Task DeletedSourcesAreReleasedWhileLegacyAndPendingSourcesStayOccupied()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "old", IsDeleted = true, ReviewSubmissionId = "product-source",
            ReviewAttempts = new() { new() { SubmissionId = "attempt-source" } },
        });
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { ReviewSubmissionId = "legacy-source" });
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, ProductVersionClaimPolicy.ReviewKey("pending"), "initiation:same"));
        foreach (var id in new[] { "legacy-source", "pending" })
            Assert.True(await ProductVersionClaimGuard.IsReviewUsedAsync(fixture.Db, id));
        foreach (var id in new[] { "product-source", "attempt-source" })
            Assert.False(await ProductVersionClaimGuard.IsReviewUsedAsync(fixture.Db, id));
        Assert.False(await ProductVersionClaimGuard.IsReviewUsedAsync(fixture.Db, "pending", "same"));
        var used = await ProductVersionClaimGuard.UsedReviewIdsAsync(fixture.Db);
        Assert.Equal(2, used.Count);
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
    public async Task NoMeetingIssuesTImmediatelyAfterReviewWithoutChoosingAnApprover()
    {
        await using var fixture = await Fixture.CreateAsync();
        var created = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateInitiation("product", new CreateInitiationRequest {
            LinkedProductId = "product", PlanName = "测试应用（无需线下会议）", ReviewMeetingRequired = false,
            PlannedProjectAt = DateTime.UtcNow,
        }));
        var item = Assert.IsType<ProductInitiation>(Assert.IsType<ApiResponse<object>>(created.Value).Data);
        Assert.Null(item.PrimaryOwnerId); Assert.Null(item.TCode);
        await fixture.Db.ReviewSubmissions.InsertOneAsync(Review("passed", "me"));
        await fixture.Controller().SyncInitiationReview(item.Id, new SyncInitiationReviewRequest { SubmissionId = "passed" });
        Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation(item.Id,
            new InitiationDecisionRequest { ReviewMeetingRequired = false }));
        var pending = await fixture.Db.ProductInitiations.Find(x => x.Id == item.Id).SingleAsync();
        Assert.Equal("approved", pending.Status); Assert.Null(pending.PrimaryOwnerId); Assert.NotNull(pending.TCode);
    }

    [Fact]
    public async Task BackfillOnlyIssuesPassedPendingRecordsAndPreservesOriginalData()
    {
        await using var fixture = await Fixture.CreateAsync();
        var pending = new ProductInitiation {
            Id = "pending-owner", ProductId = "product", Status = "owner_pending", ReviewPassed = true,
            ReviewSubmissionId = "passed-review", PrimaryOwnerId = "owner", CreatedBy = "me", PlanName = "保留方案",
            PlannedProjectAt = DateTime.UtcNow.Date, Remark = "保留备注", ApprovalComment = "保留历史内容",
            RequirementIds = new() { "req" }, ProjectMemberNames = new() { "原成员" },
            ReviewAttempts = new() { new() { SubmissionId = "passed-review", ReviewPassed = true } },
        };
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            pending,
            new ProductInitiation { Id = "failed", Status = "owner_pending", ReviewPassed = false },
            new ProductInitiation { Id = "unfinished", Status = "owner_pending" },
            new ProductInitiation { Id = "deleted", Status = "owner_pending", ReviewPassed = true, IsDeleted = true },
            new ProductInitiation { Id = "issued", ProductId = "product", Status = "owner_pending", ReviewPassed = true, TCode = "T8.0.1" },
            new ProductInitiation { Id = "decision", Status = "decision_pending", ReviewPassed = true },
            new ProductInitiation { Id = "review", Status = "review_pending", ReviewPassed = true },
        });
        await fixture.Db.Requirements.InsertOneAsync(new Requirement {
            Id = "req", ProductId = "product", CurrentState = RequirementWorkflowCatalog.Planning,
        });
        Assert.Equal(1, await ProductInitiationIssuance.BackfillAsync(fixture.Db, pending.Id));
        Assert.Equal(0, await ProductInitiationIssuance.BackfillAsync(fixture.Db, pending.Id));
        var saved = await fixture.Db.ProductInitiations.Find(x => x.Id == pending.Id).SingleAsync();
        Assert.Equal("approved", saved.Status); Assert.Equal("T8.0.2", saved.TCode);
        Assert.Equal(pending.PlanName, saved.PlanName); Assert.Equal(pending.Remark, saved.Remark);
        Assert.Equal(pending.PrimaryOwnerId, saved.PrimaryOwnerId); Assert.Equal(pending.ApprovalComment, saved.ApprovalComment);
        Assert.Equal(pending.PlannedProjectAt, saved.PlannedProjectAt); Assert.Equal(pending.CreatedAt, saved.CreatedAt, TimeSpan.FromMilliseconds(1));
        Assert.Equal(pending.ProjectMemberNames, saved.ProjectMemberNames); Assert.Single(saved.ReviewAttempts);
        Assert.False(saved.RequirementSyncPending);
        var all = await fixture.Db.ProductInitiations.Find(_ => true).ToListAsync();
        Assert.All(all.Where(x => x.Id != pending.Id && x.Id != "issued"), x => Assert.Null(x.TCode));
        Assert.Equal("T8.0.1", all.Single(x => x.Id == "issued").TCode);
        Assert.Equal(RequirementWorkflowCatalog.Approved, (await fixture.Db.Requirements.Find(x => x.Id == "req").SingleAsync()).CurrentState);
        Assert.Equal(1, await fixture.Db.ProductItemActivities.CountDocumentsAsync(x => x.EntityId == "req"));
    }

    [Fact]
    public async Task ConcurrentBackfillsAndNewDecisionsDoNotDuplicateOrOverwriteNumbers()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertManyAsync(Enumerable.Range(0, 12).Select(i => new ProductInitiation {
            Id = "pending-" + i, ProductId = "product", CreatedBy = "me", ReviewPassed = true,
            Status = i == 0 ? "owner_pending" : "decision_pending",
        }));
        var tasks = Enumerable.Range(1, 11)
            .Select(i => fixture.Controller().DecideInitiation("pending-" + i, new InitiationDecisionRequest())).Cast<Task>().ToList();
        tasks.Add(ProductInitiationIssuance.BackfillAsync(fixture.Db, "pending-0"));
        tasks.Add(ProductInitiationIssuance.BackfillAsync(fixture.Db, "pending-0"));
        await Task.WhenAll(tasks);
        var first = await fixture.Db.ProductInitiations.Find(_ => true).ToListAsync();
        Assert.All(first, x => { Assert.Equal("approved", x.Status); Assert.False(string.IsNullOrWhiteSpace(x.TCode)); });
        Assert.Equal(12, first.Select(x => x.TCode).Distinct().Count());
        Assert.Equal(0, await ProductInitiationIssuance.BackfillAsync(fixture.Db, "pending-0"));
        foreach (var item in first)
            Assert.Equal(item.TCode, (await fixture.Db.ProductInitiations.Find(x => x.Id == item.Id).SingleAsync()).TCode);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(null)]
    public async Task FailedOrUnfinishedReviewCannotBypassAutomaticIssuance(bool? passed)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "not-passed", ProductId = "product", CreatedBy = "me", Status = "decision_pending", ReviewPassed = passed,
        });
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DecideInitiation("not-passed", new InitiationDecisionRequest()));
        Assert.Null(await ProductInitiationIssuance.IssueAsync(fixture.Db, "not-passed", "decision_pending"));
        Assert.Null((await fixture.Db.ProductInitiations.Find(x => x.Id == "not-passed").SingleAsync()).TCode);
    }

    [Fact]
    public async Task WorkerBackfillsWithoutOpeningOrSubmittingTheRecord()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "startup-pending", ProductId = "product", Status = "owner_pending", ReviewPassed = true, CreatedBy = "me",
            CreatedAt = new DateTime(2026, 10, 21, 5, 0, 0, DateTimeKind.Utc),
        });
        using var services = new ServiceCollection().AddSingleton(fixture.Db).BuildServiceProvider();
        using var worker = new PrdAgent.Api.Services.ProductAgent.ProductInitiationAutoIssueWorker(services, new ConfigurationBuilder().Build(),
            NullLogger<PrdAgent.Api.Services.ProductAgent.ProductInitiationAutoIssueWorker>.Instance);
        await worker.StartAsync(CancellationToken.None);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (!await fixture.Db.ProductInitiations.Find(x => x.Id == "startup-pending" && x.Status == "approved").AnyAsync(timeout.Token))
                await Task.Delay(20, timeout.Token);
            Assert.NotNull((await fixture.Db.ProductInitiations.Find(x => x.Id == "startup-pending").SingleAsync()).TCode);
        }
        finally { await worker.StopAsync(CancellationToken.None); }
    }

    [Theory]
    [InlineData("preview", null)]
    [InlineData("preview", "true")]
    [InlineData(null, "false")]
    public async Task PreviewAndStandbyNeverRunLegacyBackfill(string? project, string? sharedFlag)
    {
        // 故意不注册数据库：非权威部署必须在取库前返回，不能扫描或补发共库记录。
        using var services = new ServiceCollection().BuildServiceProvider();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
            ["CDS_PROJECT_ID"] = project,
            [PrdAgent.Infrastructure.Security.DeploymentAuthority.ManageGlobalNotificationKey] = sharedFlag,
        }).Build();
        using var worker = new PrdAgent.Api.Services.ProductAgent.ProductInitiationAutoIssueWorker(services, configuration,
            NullLogger<PrdAgent.Api.Services.ProductAgent.ProductInitiationAutoIssueWorker>.Instance);
        await worker.StartAsync(CancellationToken.None);
        Assert.True(worker.ExecuteTask!.IsCompletedSuccessfully);
        await worker.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task DuplicateRequestsIssueOnceFromBusinessRecordsAndReleaseTheirApplicationQueue()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "pending", ProductId = "product", CreatedBy = "me", Status = "decision_pending", ReviewPassed = true,
        });
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database,
            "workflow-code:T:T2.3.4", "initiation:pending"));
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
            ProductInitiationIssuance.IssueAsync(fixture.Db, "pending", "decision_pending")));
        Assert.Single(results.Where(x => x != null));
        Assert.Equal("T0.0.1", (await fixture.Db.ProductInitiations.Find(x => x.Id == "pending").SingleAsync()).TCode);
        Assert.Equal(1, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionApplicationLease.CollectionName).CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task AutomaticDecisionStillRequiresTheApplicantOrAdministrator()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "not-mine", ProductId = "product", CreatedBy = "other", Status = "decision_pending", ReviewPassed = true,
        });
        Assert.Equal(403, Assert.IsType<ObjectResult>(await fixture.Controller().DecideInitiation("not-mine", new InitiationDecisionRequest())).StatusCode);
        Assert.Null((await fixture.Db.ProductInitiations.Find(x => x.Id == "not-mine").SingleAsync()).TCode);
    }

    [Fact]
    public async Task IssuedRecordWithInterruptedRequirementSyncIsRecoveredWithoutReissuing()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "issued", ProductId = "product", CreatedBy = "me", Status = "approved", TCode = "T7.8.9",
            RequirementSyncPending = true, RequirementIds = new() { "req" },
        });
        await fixture.Db.Requirements.InsertOneAsync(new Requirement { Id = "req", ProductId = "product", CurrentState = RequirementWorkflowCatalog.Planning });
        Assert.Equal(0, await ProductInitiationIssuance.BackfillAsync(fixture.Db, null));
        Assert.Equal(0, await ProductInitiationIssuance.BackfillAsync(fixture.Db, null));
        var saved = await fixture.Db.ProductInitiations.Find(x => x.Id == "issued").SingleAsync();
        Assert.Equal("T7.8.9", saved.TCode); Assert.False(saved.RequirementSyncPending);
        Assert.Equal(1, await fixture.Db.ProductItemActivities.CountDocumentsAsync(x => x.EntityId == "req"));
    }

    private static ProductInitiation LegacyPending(string id) => new() {
        Id = id, ProductId = "product", CreatedBy = "me", Status = "owner_pending", ReviewPassed = true,
        CreatedAt = new DateTime(2026, 10, 21, 5, 0, 0, DateTimeKind.Utc),
    };

    [Fact]
    public async Task OneTimeLegacyTargetNeverAdoptsAnotherRecordAfterIssuanceOrRestart()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(LegacyPending("authorized"));
        var targets = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => ProductInitiationIssuance.ResolveLegacyTargetAsync(fixture.Db)));
        Assert.All(targets, id => Assert.Equal("authorized", id));
        Assert.Equal(1, await ProductInitiationIssuance.BackfillAsync(fixture.Db, targets[0]));
        await fixture.Db.ProductInitiations.InsertOneAsync(LegacyPending("not-authorized"));
        var afterRestart = await ProductInitiationIssuance.ResolveLegacyTargetAsync(fixture.Db);
        Assert.Equal("authorized", afterRestart);
        Assert.Equal(0, await ProductInitiationIssuance.BackfillAsync(fixture.Db, afterRestart));
        Assert.Null((await fixture.Db.ProductInitiations.Find(x => x.Id == "not-authorized").SingleAsync()).TCode);
    }

    [Fact]
    public async Task MultipleLegacyPendingRecordsFailClosedEvenWhenOnlyOnePassesReview()
    {
        await using var fixture = await Fixture.CreateAsync();
        var failed = LegacyPending("not-passed"); failed.ReviewPassed = false;
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] { LegacyPending("one"), failed });
        var target = await ProductInitiationIssuance.ResolveLegacyTargetAsync(fixture.Db);
        Assert.Null(target);
        Assert.Equal(0, await ProductInitiationIssuance.BackfillAsync(fixture.Db, target));
        await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "not-passed", Builders<ProductInitiation>.Update.Set(x => x.IsDeleted, true));
        Assert.Null(await ProductInitiationIssuance.ResolveLegacyTargetAsync(fixture.Db));
        Assert.Null((await fixture.Db.ProductInitiations.Find(x => x.Id == "one").SingleAsync()).TCode);
    }

    [Fact]
    public async Task EmptyLegacySnapshotDoesNotAdoptLaterOrBackdatedRecords()
    {
        await using var fixture = await Fixture.CreateAsync();
        Assert.Null(await ProductInitiationIssuance.ResolveLegacyTargetAsync(fixture.Db));
        await fixture.Db.ProductInitiations.InsertOneAsync(LegacyPending("later"));
        var target = await ProductInitiationIssuance.ResolveLegacyTargetAsync(fixture.Db);
        Assert.Null(target);
        Assert.Equal(0, await ProductInitiationIssuance.BackfillAsync(fixture.Db, target));
        Assert.Null((await fixture.Db.ProductInitiations.Find(x => x.Id == "later").SingleAsync()).TCode);
    }

    [Fact]
    public async Task LegacySelectionCannotChooseAnApplicationCreatedAfterAuthorizationCutoff()
    {
        await using var fixture = await Fixture.CreateAsync();
        var later = LegacyPending("future"); later.CreatedAt = new DateTime(2026, 10, 22, 0, 0, 0, DateTimeKind.Utc);
        await fixture.Db.ProductInitiations.InsertOneAsync(later);
        Assert.Null(await ProductInitiationIssuance.ResolveLegacyTargetAsync(fixture.Db));
    }

    private static ReviewSubmission Review(string id, string submitter, bool passed = true) => new() {
        Id = id, SubmitterId = submitter, Title = id, Status = ReviewStatuses.Done, IsPassed = passed,
    };

    [Fact]
    public async Task FormalVersionIsIssuedWithoutApprovalAndStillRequiresAnAnnouncement()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Users.InsertOneAsync(new User { UserId = "me", DisplayName = "申领人" });
        await fixture.Db.Features.InsertOneAsync(new Feature { Id = "feature", ProductId = "product", Title = "测试功能" });
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "source", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", Status = "approved", PlanName = "测试方案",
        });
        var request = new CreateReleaseRequest {
            InitiationId = "source", OwnerId = "me", TeamMemberIds = new() { "me" },
            PlannedReleaseAt = DateTime.UtcNow.AddDays(1), PlannedTrainingMinutes = 30,
            FeatureManifest = new() { new() { FeatureId = "feature", ChangeType = FeatureChangeType.Added } },
        };
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", request));
        var issued = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data);
        Assert.StartsWith("V", issued.VCode); Assert.Equal("released", issued.Status);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        Assert.IsType<OkObjectResult>(await fixture.Controller().CompleteRelease(issued.Id, new CompleteReleaseRequest()));
        Assert.Equal(1, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

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
    [Fact]
    public async Task OnlyLatestTGloballyCanBePhysicallyDeleted()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "older", ProductId = "product", AppName = "测试应用", TCode = "T1.2.9", CreatedBy = "me", Status = "approved", IssuedAt = DateTime.UtcNow.AddMinutes(-3) },
            new ProductInitiation { Id = "latest", ProductId = "product", AppName = "测试应用", TCode = "T1.2.10", CreatedBy = "me", Status = "approved", IssuedAt = DateTime.UtcNow.AddMinutes(-2) },
            new ProductInitiation { Id = "foreign", ProductId = "other", AppName = "其他应用", TCode = "T9.9.9", CreatedBy = "other", Status = "approved", IssuedAt = DateTime.UtcNow.AddMinutes(-1) },
        });
        var rejected = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DeleteInitiation("older"));
        Assert.Equal("INITIATION_NOT_LATEST", Assert.IsType<ApiResponse<object>>(rejected.Value).Error!.Code);
        var sameApplicationLatest = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DeleteInitiation("latest"));
        Assert.Equal("INITIATION_NOT_LATEST", Assert.IsType<ApiResponse<object>>(sameApplicationLatest.Value).Error!.Code);
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "global-latest", ProductId = "product", AppName = "测试应用", TCode = "T10.0.0", CreatedBy = "me", Status = "approved",
        });
        Assert.IsType<OkObjectResult>(await fixture.Controller().DeleteInitiation("global-latest"));
        Assert.Null(await fixture.Db.ProductInitiations.Find(x => x.Id == "global-latest").FirstOrDefaultAsync());
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest("global-latest")));
        Assert.Equal(0, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ScopedListAndDetailNeverPromoteAnOlderApplicationRecord()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "visible", ProductId = "product", AppName = "测试应用", TCode = "T1.2.9", CreatedBy = "me", Status = "approved" },
            new ProductInitiation { Id = "hidden-latest", ProductId = "inaccessible", AppName = "其它应用", TCode = "T1.2.10", CreatedBy = "other", Status = "approved" },
        });
        var list = await PrdAgent.Api.Services.ProductAgent.ProductVersionListReader.ReadInitiationsAsync(
            fixture.Db, new HashSet<string> { "product" }, "me", false);
        var row = Assert.Single(list.Items);
        Assert.Equal("visible", row.Record.Id);
        Assert.False(row.Record.CanDelete);
        var detail = Assert.IsType<OkObjectResult>(await fixture.Controller().GetInitiation("visible"));
        var detailItem = Assert.IsType<ApiResponse<object>>(detail.Value).Data as ProductInitiation;
        Assert.NotNull(detailItem);
        Assert.False(detailItem.CanDelete);
        var singleProduct = Assert.IsType<OkObjectResult>(await fixture.Controller().ListInitiations("product"));
        Assert.Contains("\"canDelete\":false", JsonSerializer.Serialize(singleProduct.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }

    [Fact]
    public async Task OnlyGlobalLatestHasReadOnlyEligibilityIgnoringDraftsDeletedAndEditTimes()
    {
        await using var fixture = await Fixture.CreateAsync();
        var items = new[] {
            new ProductInitiation { Id = "older", ProductId = "product", AppName = "测试应用", TCode = "T9.2.9", CreatedBy = "me", Status = "approved", IssuedAt = DateTime.UtcNow.AddMinutes(-1), UpdatedAt = DateTime.UtcNow.AddDays(1) },
            new ProductInitiation { Id = "latest", ProductId = "product", AppName = "测试应用", TCode = "T1.2.10", CreatedBy = "me", Status = "approved" },
            new ProductInitiation { Id = "draft", ProductId = "product", Status = "draft" },
            new ProductInitiation { Id = "deleted", ProductId = "other", TCode = "T9.0.0", Status = "approved", IsDeleted = true },
        };
        await fixture.Db.ProductInitiations.InsertManyAsync(items);
        await PrdAgent.Api.Services.ProductAgent.ProductInitiationDeletion.AnnotateAsync(fixture.Db, items.Where(x => !x.IsDeleted).ToList());
        Assert.Equal(new[] { "latest" }, items.Where(x => x.CanDelete).Select(x => x.Id));
        Assert.False(items[1].ToBsonDocument().Contains("CanDelete"));
        Assert.False(items[1].ToBsonDocument().Contains("canDelete"));
        Assert.IsType<OkObjectResult>(await fixture.Controller().DeleteInitiation("latest"));
    }

    [Theory]
    [InlineData("T9.0.0")]
    [InlineData("T1.2.3")]
    public async Task GlobalLegacyHigherOrSameNumberBlocksDeletion(string legacyCode)
    {
        await using var fixture = await Fixture.CreateAsync();
        var item = new ProductInitiation { Id = "item", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", CreatedBy = "me", Status = "approved" };
        await fixture.Db.ProductInitiations.InsertOneAsync(item);
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration {
            Kind = VersionRegistrationKind.Internal, ApplicationName = "其它应用", Code = legacyCode, CreatedBy = "other", CreatedAt = DateTime.UtcNow.AddMinutes(1),
        });
        await PrdAgent.Api.Services.ProductAgent.ProductInitiationDeletion.AnnotateAsync(fixture.Db, new[] { item });
        Assert.False(item.CanDelete);
        var rejected = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DeleteInitiation("item"));
        Assert.Equal("INITIATION_NOT_LATEST", Assert.IsType<ApiResponse<object>>(rejected.Value).Error!.Code);
    }

    [Fact]
    public async Task DeleteRechecksGlobalLatestAfterPageWasLoaded()
    {
        await using var fixture = await Fixture.CreateAsync();
        var item = new ProductInitiation { Id = "item", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", CreatedBy = "me", Status = "approved" };
        await fixture.Db.ProductInitiations.InsertOneAsync(item);
        await PrdAgent.Api.Services.ProductAgent.ProductInitiationDeletion.AnnotateAsync(fixture.Db, new[] { item });
        Assert.True(item.CanDelete);
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "newer", ProductId = "other", AppName = "其它应用", TCode = "T1.2.4", Status = "approved", IssuedAt = DateTime.UtcNow.AddMinutes(1),
        });
        var rejected = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DeleteInitiation("item"));
        Assert.Equal("INITIATION_NOT_LATEST", Assert.IsType<ApiResponse<object>>(rejected.Value).Error!.Code);
        Assert.False((await fixture.Db.ProductInitiations.Find(x => x.Id == "item").SingleAsync()).IsDeleted);
    }

    [Theory]
    [InlineData("release")]
    [InlineData("legacy")]
    [InlineData("claim")]
    [InlineData("requirement")]
    [InlineData("feature")]
    public async Task LatestTWithDownstreamOrPendingClaimCannotBeDeleted(string kind)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "latest", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", CreatedBy = "me", Status = "approved",
        });
        if (kind == "release") await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease { ProductId = "product", InitiationId = "latest", VCode = "V1.2.3" });
        if (kind == "legacy") await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { ApplicationName = "测试应用", Kind = VersionRegistrationKind.Formal, TCode = "T1.2.3", Code = "V1.2.3" });
        if (kind == "claim") await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, ProductVersionClaimPolicy.ReleaseKey("测试应用", "T1.2.3"), "release:pending");
        if (kind == "requirement") await fixture.Db.Requirements.InsertOneAsync(new Requirement { VersionIds = new() { "latest" } });
        if (kind == "feature") await fixture.Db.Features.InsertOneAsync(new Feature { PlannedVersionId = "latest" });
        var latest = await fixture.Db.ProductInitiations.Find(x => x.Id == "latest").SingleAsync();
        await PrdAgent.Api.Services.ProductAgent.ProductInitiationDeletion.AnnotateAsync(fixture.Db, new[] { latest });
        Assert.False(latest.CanDelete);
        var rejected = Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DeleteInitiation("latest"));
        Assert.Equal("INITIATION_HAS_DOWNSTREAM", Assert.IsType<ApiResponse<object>>(rejected.Value).Error!.Code);
        Assert.False((await fixture.Db.ProductInitiations.Find(x => x.Id == "latest").SingleAsync()).IsDeleted);
    }

    [Fact]
    public async Task DeleteAndFormalClaimCannotBothWinAndNonOwnerCannotDelete()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Users.InsertOneAsync(new User { UserId = "me", DisplayName = "申请人" });
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "latest", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", CreatedBy = "me", Status = "approved" },
            new ProductInitiation { Id = "other-owner", ProductId = "product", AppName = "测试应用", TCode = "T1.2.2", CreatedBy = "other", Status = "approved", IssuedAt = DateTime.UtcNow.AddMinutes(-1) },
        });
        Assert.Equal(403, Assert.IsType<ObjectResult>(await fixture.Controller().DeleteInitiation("other-owner")).StatusCode);
        var deletion = fixture.Controller().DeleteInitiation("latest");
        var request = NumberingReleaseRequest("latest"); request.FeatureManifest = new();
        var claim = fixture.Controller().CreateRelease("product", request);
        await Task.WhenAll(deletion, claim);
        Assert.NotEqual(deletion.Result is OkObjectResult, claim.Result is OkObjectResult);
        Assert.Equal(deletion.Result is OkObjectResult, !await fixture.Db.ProductInitiations.Find(x => x.Id == "latest").AnyAsync());
    }

    [Fact]
    public async Task IssuingTIgnoresConfirmedDeletedNumbersAndUsesTheRemainingBase()
    {
        await using var fixture = await Fixture.CreateAsync();
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, WorkflowClaimKey("product", "T", "T9.2.3"), "initiation:deleted-highest");
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "deleted-highest", ProductId = "product", TCode = "T9.2.3", IsDeleted = true },
            new ProductInitiation { Id = "remaining", ProductId = "product", TCode = "T9.2.2", Status = "approved" },
            new ProductInitiation { Id = "new", ProductId = "product", CreatedBy = "me", ReviewPassed = true, Status = "decision_pending" },
        });
        Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation("new", new InitiationDecisionRequest {
            ReviewMeetingRequired = true, ExpectedMeetingAt = DateTime.UtcNow.AddDays(1),
        }));
        Assert.Equal("T9.2.3", (await fixture.Db.ProductInitiations.Find(x => x.Id == "new").SingleAsync()).TCode);
    }

    [Theory]
    [InlineData("internal")]
    [InlineData("formal")]
    public async Task DebugClearBacksUpAndArchivesOnlyItsVersionType(string kind)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "t", ProductId = "product", TCode = "T1.2.3", Status = "approved" },
            new ProductInitiation { Id = "draft", ProductId = "other-product", Status = "draft" },
        });
        await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease {
            Id = "v", ProductId = "product", InitiationId = "t", VCode = "V1.2.3", TCode = "T1.2.3",
        });
        await fixture.Db.Requirements.InsertOneAsync(new Requirement { Id = "req", VersionIds = new() { "t", "v" } });
        await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { Kind = kind, Code = "T9.0.0" });
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, "workflow-code:T:T1.2.3", "initiation:t");
        var preview = await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.PreviewAsync(fixture.Db, kind);
        Assert.Equal(kind == "internal" ? 2 : 1, preview.RecordCount);
        Assert.Equal(0, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
        var result = await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.ClearAsync(fixture.Db, kind, preview.Token, "me");
        Assert.NotNull(result);
        Assert.Equal(preview.RecordCount, result.ClearedCount);
        Assert.Equal(0, result.SkippedCount);
        var backup = await fixture.Db.ProductVersionWorkflowSnapshots.Find(x => x.Id == result.BackupId).SingleAsync();
        Assert.Equal("me", backup.CreatedBy);
        Assert.Equal("debug_clear_" + kind, backup.SourceType);
        Assert.Equal(kind == "internal" ? 2 : 0, backup.Initiations.Count);
        Assert.Equal(kind == "formal" ? 1 : 0, backup.Releases.Count);
        Assert.All(backup.Initiations, x => Assert.False(x.IsDeleted));
        Assert.All(backup.Releases, x => Assert.False(x.IsDeleted));
        Assert.Equal(kind == "internal" ? 0 : 2, await fixture.Db.ProductInitiations.CountDocumentsAsync(x => !x.IsDeleted));
        Assert.Equal(kind == "formal" ? 0 : 1, await fixture.Db.ProductReleases.CountDocumentsAsync(x => !x.IsDeleted));
        Assert.Equal(kind == "internal" ? 0 : 2, await fixture.Db.ProductInitiations.CountDocumentsAsync(_ => true));
        Assert.Equal(kind == "formal" ? 0 : 1, await fixture.Db.ProductReleases.CountDocumentsAsync(_ => true));
        Assert.Equal(new[] { "t", "v" }, (await fixture.Db.Requirements.Find(x => x.Id == "req").SingleAsync()).VersionIds);
        Assert.Equal(1, await fixture.Db.Products.CountDocumentsAsync(_ => true));
        Assert.Equal(1, await fixture.Db.VersionRegistrations.CountDocumentsAsync(_ => true));
        Assert.Equal(kind == "internal" ? 0 : 1, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName).CountDocumentsAsync(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^workflow-code:"))));
        Assert.Null(await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.ClearAsync(fixture.Db, kind, preview.Token, "me"));
        Assert.Equal(1, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task DebugClearRejectsNonAdminAndWrongKindOrConfirmation()
    {
        await using var fixture = await Fixture.CreateAsync();
        var request = new ProductVersionDebugClearRequest { Kind = "internal", ConfirmPhrase = "清空T记录", Token = "any" };
        Assert.Equal(403, Assert.IsType<ObjectResult>(await fixture.Controller().PreviewVersionDebugClear("internal")).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await fixture.Controller().ClearVersionDebugRecords(request)).StatusCode);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller(admin: true).PreviewVersionDebugClear("all"));
        request.ConfirmPhrase = "清空V记录";
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller(admin: true).ClearVersionDebugRecords(request));
        request.Kind = "all";
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller(admin: true).ClearVersionDebugRecords(request));
        Assert.Equal(0, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DebugClearRejectsChangedOrNewRecordsAfterPreview(bool newRecord)
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "t", TCode = "T1.2.3" });
        var preview = await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.PreviewAsync(fixture.Db, "internal");
        if (newRecord) await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "new" });
        else await fixture.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "t",
            Builders<ProductInitiation>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow.AddMinutes(1)));
        var response = Assert.IsType<ConflictObjectResult>(await fixture.Controller(admin: true).ClearVersionDebugRecords(
            new ProductVersionDebugClearRequest { Kind = "internal", ConfirmPhrase = "清空T记录", Token = preview.Token }));
        Assert.Equal("VERSION_CLEAR_STALE", Assert.IsType<ApiResponse<object>>(response.Value).Error!.Code);
        Assert.Equal(newRecord ? 2 : 1, await fixture.Db.ProductInitiations.CountDocumentsAsync(x => !x.IsDeleted));
        Assert.Equal(0, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task DebugClearBackupFailureDoesNotClearAnything()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "t", TCode = "T1.2.3" });
        await fixture.Db.Database.CreateCollectionAsync("product_version_workflow_snapshots", new CreateCollectionOptions<ProductVersionWorkflowSnapshot> {
            Validator = Builders<ProductVersionWorkflowSnapshot>.Filter.Ne(x => x.SourceType, "debug_clear_internal"),
        });
        var preview = await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.PreviewAsync(fixture.Db, "internal");
        var response = Assert.IsType<ObjectResult>(await fixture.Controller(admin: true).ClearVersionDebugRecords(
            new ProductVersionDebugClearRequest { Kind = "internal", ConfirmPhrase = "清空T记录", Token = preview.Token }));
        Assert.Equal(503, response.StatusCode);
        Assert.False((await fixture.Db.ProductInitiations.Find(x => x.Id == "t").SingleAsync()).IsDeleted);
        Assert.Equal(0, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task DebugClearTokensAreTypeBoundAndEmptyClearDoesNotWriteBackup()
    {
        await using var fixture = await Fixture.CreateAsync();
        var t = await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.PreviewAsync(fixture.Db, "internal");
        Assert.Null(await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.ClearAsync(fixture.Db, "formal", t.Token, "me"));
        var result = await PrdAgent.Api.Services.ProductAgent.ProductVersionDebugClear.ClearAsync(fixture.Db, "internal", t.Token, "me");
        Assert.NotNull(result);
        Assert.Equal(0, result.ClearedCount);
        Assert.Null(result.BackupId);
        Assert.Equal(0, await fixture.Db.ProductVersionWorkflowSnapshots.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task LatestFormalDeletionPreservesTAndReclaimsTheCodeFromTheRemainingBase()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Users.InsertOneAsync(new User { UserId = "me", DisplayName = "申请人" });
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "deletable-t", ProductId = "product", AppName = "测试应用", TCode = "T1.2.3", Status = "approved", PlanName = "最终方案", CreatedBy = "me" });
        var before = await fixture.Db.Database.GetCollection<BsonDocument>("product_initiations").Find(new BsonDocument("_id", "deletable-t")).SingleAsync();
        var request = NumberingReleaseRequest("deletable-t"); request.FeatureManifest = new();
        var issued = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", request)).Value).Data);
        var detail = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(await fixture.Controller().GetRelease(issued.Id)).Value).Data);
        Assert.True(detail.CanDelete);
        Assert.False((await fixture.Db.Database.GetCollection<BsonDocument>("product_releases").Find(new BsonDocument("_id", issued.Id)).SingleAsync()).Contains("CanDelete"));
        Assert.IsType<OkObjectResult>(await fixture.Controller().DeleteRelease(issued.Id));
        Assert.False(await fixture.Db.ProductReleases.Find(x => x.Id == issued.Id).AnyAsync());
        var after = await fixture.Db.Database.GetCollection<BsonDocument>("product_initiations").Find(new BsonDocument("_id", "deletable-t")).SingleAsync();
        Assert.Equal(before.ToJson(), after.ToJson());
        var repeated = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", request)).Value).Data);
        Assert.Equal(issued.VCode, repeated.VCode);
        Assert.Equal("deletable-t", repeated.InitiationId);
        var claimFilter = Builders<BsonDocument>.Filter;
        var numberClaims = fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName);
        Assert.False(await numberClaims.Find(claimFilter.Eq("targetId", "release:" + issued.Id)
            & claimFilter.Regex("_id", new BsonRegularExpression("^workflow-code:V:"))).AnyAsync());
        Assert.False(await numberClaims.Find(claimFilter.Eq("targetId", "release:" + repeated.Id)
            & claimFilter.Regex("_id", new BsonRegularExpression("^workflow-code:V:"))).AnyAsync());
    }

    [Theory]
    [InlineData("T", false)]
    [InlineData("T", true)]
    [InlineData("V", false)]
    [InlineData("V", true)]
    public async Task HistoricalConfirmedDeletionReleasesOnlyItsOwnNumberClaims(string prefix, bool physical)
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        var target = (prefix == "T" ? "initiation:" : "release:") + "removed";
        if (physical) await ProductVersionClaimGuard.MarkSourceRemovalAsync(fixture.Db, target);
        else if (prefix == "T") await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "removed", ProductId = "product", IsDeleted = true });
        else await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "removed", ProductId = "product", IsDeleted = true });
        Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, WorkflowClaimKey("product", prefix, prefix + "6.19.9"), target));
        if (prefix == "T") Assert.True(await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database,
            WorkflowClaimKey("product", prefix, "T9.0.0"), target + ":revision:T6.19.9:major"));
        var nextTarget = (prefix == "T" ? "initiation:" : "release:") + "new-owner";
        await using var lease = await ProductVersionApplicationLease.AcquireAsync(fixture.Db, new[] { "product" });
        var code = await ProductVersionClaimGuard.NextWorkflowCodeAsync(fixture.Db, prefix, "minor", nextTarget, "product", lease);
        Assert.Equal(prefix + "6.19.6", code);
        // 新发号写入业务表；迟到的旧记录清理不能移除新记录，也不产生新的数字占号。
        if (prefix == "T") await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation { Id = "new-owner", ProductId = "product", TCode = code, Status = "approved" });
        else await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "new-owner", ProductId = "product", VCode = code });
        await ProductVersionClaimGuard.ReleaseDeletedSourceClaimsAsync(fixture.Db, target);
        Assert.False(await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .Find(new BsonDocument("_id", WorkflowClaimKey("product", prefix, code))).AnyAsync());
        Assert.Equal(prefix + "6.19.7", await ProductVersionClaimGuard.NextWorkflowCodeAsync(fixture.Db, prefix, "minor", nextTarget + "-second", "product", lease));
    }

    [Theory]
    [InlineData("T")]
    [InlineData("V")]
    public async Task ConcurrentClaimsAfterDeletionStillAllocateUniqueCodes(string prefix)
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        var targetPrefix = prefix == "T" ? "initiation:" : "release:";
        await ProductVersionClaimGuard.MarkSourceRemovalAsync(fixture.Db, targetPrefix + "removed");
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, WorkflowClaimKey("product", prefix, prefix + "99.0.0"), targetPrefix + "removed");
        var sources = Enumerable.Range(0, 8).Select(i => new ProductInitiation {
            Id = "parallel-" + i, ProductId = "product", AppName = "测试应用", PlanName = "排队方案" + i,
            Status = prefix == "T" ? "decision_pending" : "approved", ReviewPassed = true,
            TCode = prefix == "T" ? null : "T1.2." + (30 + i), CreatedBy = "me",
        }).ToList();
        await fixture.Db.ProductInitiations.InsertManyAsync(sources);
        async Task<string> Claim(ProductInitiation source)
        {
            if (prefix == "T")
            {
                var saved = await ProductInitiationIssuance.IssueAsync(fixture.Db, source.Id, "decision_pending");
                Assert.NotNull(saved); return saved!.TCode!;
            }
            var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest(source.Id)));
            return Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data).VCode;
        }
        var codes = await Task.WhenAll(sources.Select(Claim));
        Assert.Equal(8, codes.Distinct().Count());
        Assert.Contains(prefix + "6.19.6", codes);
        Assert.DoesNotContain(codes, code => code.StartsWith(prefix + "99.", StringComparison.Ordinal));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionApplicationLease.CollectionName).CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ApplicationQueueSerializesOneApplicationWithoutBlockingAnotherAndReleasesAfterUse()
    {
        await using var fixture = await Fixture.CreateAsync();
        await using var first = await ProductVersionApplicationLease.AcquireAsync(fixture.Db, new[] { "product" });
        var waiting = ProductVersionApplicationLease.AcquireAsync(fixture.Db, new[] { "product" });
        await Task.Delay(120);
        Assert.False(waiting.IsCompleted);
        await using var other = await ProductVersionApplicationLease.AcquireAsync(fixture.Db, new[] { "other-product" }, TimeSpan.FromSeconds(1));
        await other.EnsureHeldAsync();
        await first.DisposeAsync();
        await using var second = await waiting.WaitAsync(TimeSpan.FromSeconds(3));
        await second.EnsureHeldAsync();
        await second.DisposeAsync(); await other.DisposeAsync();
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionApplicationLease.CollectionName).CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ExpiredApplicationQueueHolderCannotWriteOrReleaseTheNewHolder()
    {
        await using var fixture = await Fixture.CreateAsync();
        await using var old = await ProductVersionApplicationLease.AcquireAsync(fixture.Db, new[] { "product" });
        var collection = fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionApplicationLease.CollectionName);
        await collection.UpdateOneAsync(Builders<BsonDocument>.Filter.Empty,
            Builders<BsonDocument>.Update.Set("expiresAt", DateTime.UtcNow.AddSeconds(-1)));
        await using var current = await ProductVersionApplicationLease.AcquireAsync(fixture.Db, new[] { "product" });
        await Assert.ThrowsAsync<InvalidOperationException>(() => old.EnsureHeldAsync());
        await old.DisposeAsync();
        await current.EnsureHeldAsync();
        Assert.Equal(1, await collection.CountDocumentsAsync(_ => true));
        await current.DisposeAsync();
        Assert.Equal(0, await collection.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task RejectedClaimReleasesApplicationQueueAndDoesNotAdvanceTheNextNumber()
    {
        await using var fixture = await Fixture.CreateAsync();
        await SeedWorkflowNumberingAsync(fixture);
        var request = NumberingReleaseRequest(); request.PlannedTrainingMinutes = -1;
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", request));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionApplicationLease.CollectionName).CountDocumentsAsync(_ => true));
        var result = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest()));
        Assert.Equal("V6.19.6", Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(result.Value).Data).VCode);
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .CountDocumentsAsync(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^workflow-code:"))));
        Assert.Equal(0, await fixture.Db.Database.GetCollection<BsonDocument>(ProductVersionApplicationLease.CollectionName).CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task ReissuedTAfterDeletionCanStillClaimVFromTheNewRecord()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Users.InsertOneAsync(new User { UserId = "me", DisplayName = "申请人" });
        await fixture.Db.ProductInitiations.InsertManyAsync(new[] {
            new ProductInitiation { Id = "remaining", ProductId = "product", AppName = "测试应用", TCode = "T3.2.4", Status = "approved", CreatedBy = "me", IssuedAt = DateTime.UtcNow.AddMinutes(-1) },
            new ProductInitiation { Id = "removed", ProductId = "product", AppName = "测试应用", TCode = "T3.2.5", Status = "approved", CreatedBy = "me" },
        });
        await ProductVersionClaimGuard.TryReserveAsync(fixture.Db.Database, WorkflowClaimKey("product", "T", "T3.2.5"), "initiation:removed");
        Assert.IsType<OkObjectResult>(await fixture.Controller().DeleteInitiation("removed"));
        await fixture.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "replacement", ProductId = "product", AppName = "测试应用", PlanName = "替换方案", Status = "decision_pending", ReviewPassed = true, CreatedBy = "me",
        });
        Assert.IsType<OkObjectResult>(await fixture.Controller().DecideInitiation("replacement", new InitiationDecisionRequest {
            ReviewMeetingRequired = true, ExpectedMeetingAt = DateTime.UtcNow.AddDays(1),
        }));
        Assert.Equal("T3.2.5", (await fixture.Db.ProductInitiations.Find(x => x.Id == "replacement").SingleAsync()).TCode);
        var request = NumberingReleaseRequest("replacement"); request.FeatureManifest = new();
        var issued = Assert.IsType<ProductRelease>(Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(await fixture.Controller().CreateRelease("product", request)).Value).Data);
        Assert.Equal("replacement", issued.InitiationId);
        Assert.Equal("T3.2.5", issued.TCode);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().CreateRelease("product", NumberingReleaseRequest("removed")));
    }

    [Fact]
    public async Task FormalDeleteEligibilityIsGlobalAndRejectsStalePageAndForeignOwner()
    {
        await using var fixture = await Fixture.CreateAsync();
        var now = DateTime.UtcNow;
        await fixture.Db.Products.InsertOneAsync(new Product { Id = "other-app", Name = "另一应用", MemberIds = new() { "me" } });
        await fixture.Db.ProductReleases.InsertManyAsync(new[] {
            new ProductRelease { Id = "v-old", ProductId = "other-app", VCode = "V99.0.0", CreatedBy = "me", CreatedAt = now.AddMinutes(-2), UpdatedAt = now.AddDays(2) },
            new ProductRelease { Id = "v-new", ProductId = "product", VCode = "V1.0.0", CreatedBy = "me", CreatedAt = now },
            new ProductRelease { Id = "draft", ProductId = "other-app", CreatedBy = "me", CreatedAt = now.AddMinutes(2) },
            new ProductRelease { Id = "deleted", ProductId = "other-app", VCode = "V999.0.0", CreatedBy = "me", CreatedAt = now.AddMinutes(3), IsDeleted = true },
        });
        var all = await fixture.Db.ProductReleases.Find(x => !x.IsDeleted).ToListAsync();
        await ProductReleaseDeletion.AnnotateAsync(fixture.Db, all, "me");
        Assert.Equal("v-new", Assert.Single(all.Where(x => x.CanDelete)).Id);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DeleteRelease("v-old"));
        var scoped = await ProductVersionListReader.ReadReleasesAsync(fixture.Db, new HashSet<string> { "other-app" }, "me", false);
        Assert.DoesNotContain(scoped.Items, x => x.Record.CanDelete);
        await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "newer-foreign-owner", ProductId = "other-app", VCode = "V2.0.0", CreatedBy = "other", CreatedAt = now.AddMinutes(1) });
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().DeleteRelease("v-new"));
        Assert.Equal(403, Assert.IsType<ObjectResult>(await fixture.Controller(admin: true).DeleteRelease("newer-foreign-owner")).StatusCode);
        Assert.True(await fixture.Db.ProductReleases.Find(x => x.Id == "v-new").AnyAsync());
    }

    [Theory]
    [InlineData("legacy")]
    [InlineData("release")]
    [InlineData("feature")]
    [InlineData("requirement")]
    [InlineData("sending")]
    public async Task FormalDeletionCannotRemoveLegacyPredecessorDownstreamOrSendingNotice(string kind)
    {
        await using var fixture = await Fixture.CreateAsync();
        var item = new ProductRelease { Id = "v", ProductId = "product", VCode = "V1.2.3", CreatedBy = "me" };
        if (kind == "sending") item.ClaimNotification = new ProductClaimNotification { Status = "sending" };
        await fixture.Db.ProductReleases.InsertOneAsync(item);
        if (kind == "legacy") await fixture.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { Kind = VersionRegistrationKind.Formal, Code = "V4.5.6", CreatedAt = item.CreatedAt.AddMinutes(1) });
        if (kind == "release") await fixture.Db.ProductReleases.InsertOneAsync(new ProductRelease { ProductId = "product", PreviousReleaseId = "v" });
        if (kind == "feature") await fixture.Db.Features.InsertOneAsync(new Feature { OfficialReleaseId = "v" });
        if (kind == "requirement") await fixture.Db.Requirements.InsertOneAsync(new Requirement { VersionIds = new() { "v" } });
        await ProductReleaseDeletion.AnnotateAsync(fixture.Db, new[] { item }, "me");
        Assert.False(item.CanDelete);
        Assert.IsNotType<OkObjectResult>(await fixture.Controller().DeleteRelease("v"));
        Assert.True(await fixture.Db.ProductReleases.Find(x => x.Id == "v").AnyAsync());
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
        public ProductAgentController Controller(bool test = false, bool admin = false, bool notify = false)
        {
            var claims = new List<Claim> { new("sub", "me"), new("permissions", AdminPermissionCatalog.ProductAgentUse) };
            if (test) claims.Add(new("permissions", AdminPermissionCatalog.ProductAgentVersionClaimTest));
            if (admin) claims.Add(new("permissions", AdminPermissionCatalog.ProductAgentAdmin));
            var http = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test")) };
            if (notify) http.RequestServices = new ServiceCollection().AddSingleton<IConfiguration>(new ConfigurationBuilder().Build()).BuildServiceProvider();
            return new ProductAgentController(Db, NullLogger<ProductAgentController>.Instance, null!, null!, null!, null!, null!, null!) {
                ControllerContext = new ControllerContext { HttpContext = http },
            };
        }
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(databaseName));
    }
}
