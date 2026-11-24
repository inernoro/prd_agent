using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 发布前私有资料确认（2026-09-24，轨道 D0）。
///
/// 服务端强制是这道闸唯一可信的一层：前端弹窗可以被绕过，这里不能。
/// 四条主判据：含私有引用未确认 → 拒；确认集合对不上 → 拒；确认一致 → 放行并落记录；
/// 没有私有引用 → 行为不变（不要求确认、不写记录）。
/// </summary>
public sealed class HostedSitePrivateSourceGateTests
{
    private const string Owner = "owner-user";
    private static readonly DateTime Version = new(2026, 9, 24, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task ShareWithPrivateSource_WithoutConfirmation_ShouldRefuseAndNotRecord()
    {
        var store = ScenarioWithPrivateBaseline();
        var gate = new HostedSitePrivateSourceGate(store);

        var decision = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, null, CancellationToken.None);

        Assert.False(decision.Allowed);
        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, decision.Verdict);
        Assert.Equal(ErrorCodes.HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_REQUIRED, decision.ErrorCode);
        var item = Assert.Single(decision.Report.Items);
        Assert.Equal("entry-private", item.EntryId);
        Assert.Equal("季度经营数据", item.Title);
        Assert.Equal("财务内部库", item.StoreName);
        Assert.Equal(HostedSitePrivateSourceScopes.OwnerOnly, item.Scope);
        // 第一句先说后果，并点名资料，前端即便拿不到明细也知道要确认哪几份。
        Assert.StartsWith("本页引用了 1 份私有资料（《季度经营数据》）", decision.Message);
        Assert.Empty(store.Appended);
    }

    [Fact]
    public async Task ShareWithPrivateSource_WithStaleConfirmation_ShouldRefuseAsStale()
    {
        var store = ScenarioWithPrivateBaseline();
        var gate = new HostedSitePrivateSourceGate(store);
        // 作者当时确认的是另一组来源（例如确认之后又发布了一版引用了新资料的草稿）。
        var staleFingerprint = HostedSitePrivateSourceRules.ComputeFingerprint(["entry-other"]);

        var decision = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, staleFingerprint, CancellationToken.None);

        Assert.False(decision.Allowed);
        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationStale, decision.Verdict);
        Assert.Equal(ErrorCodes.HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_STALE, decision.ErrorCode);
        Assert.Empty(store.Appended);
    }

    [Fact]
    public async Task ShareWithPrivateSource_WithMatchingConfirmation_ShouldAllowAndRecordWhoWhenWhat()
    {
        var store = ScenarioWithPrivateBaseline();
        var confirmedAt = new DateTime(2026, 9, 24, 9, 30, 0, DateTimeKind.Utc);
        var gate = new HostedSitePrivateSourceGate(store, () => confirmedAt);
        var preflight = await gate.InspectSitesAsync([store.Site], CancellationToken.None);

        var decision = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, preflight.Fingerprint, CancellationToken.None);

        Assert.True(decision.Allowed);
        var (revisionId, record) = Assert.Single(store.Appended);
        Assert.Equal("baseline-1", revisionId);
        Assert.Equal(Owner, record.UserId);
        Assert.Equal(confirmedAt, record.ConfirmedAt);
        Assert.Equal(HostedSitePrivateSourceActions.ShareCreate, record.Action);
        Assert.Equal(preflight.Fingerprint, record.Fingerprint);
        var source = Assert.Single(record.Sources);
        Assert.Equal("entry-private", source.EntryId);
        Assert.Equal("季度经营数据", source.Title);
        Assert.Equal("store-private", source.StoreId);
        Assert.Equal("财务内部库", source.StoreName);
        Assert.Equal(HostedSitePrivateSourceScopes.OwnerOnly, source.Scope);
    }

    [Fact]
    public async Task ShareWithOnlyPublicSources_ShouldBehaveAsBefore()
    {
        var store = new FakeStore();
        store.AddStore("store-public", "公开手册", isPublic: true);
        store.AddEntry("entry-public", "store-public", "产品手册");
        store.AddRevision(Baseline("baseline-1", ["entry-public"]));
        var gate = new HostedSitePrivateSourceGate(store);

        var decision = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, null, CancellationToken.None);

        Assert.True(decision.Allowed);
        Assert.False(decision.Report.HasPrivateSources);
        Assert.Null(decision.Report.Fingerprint);
        Assert.Empty(store.Appended);
    }

    [Fact]
    public async Task SiteWithoutRevisionLedger_ShouldPassAsKnownBoundary()
    {
        // 旧站点 / 从未在工作台打开过的上传站点：查不到来源，按现状放行（已知边界，记在 debt）。
        var store = new FakeStore();
        var gate = new HostedSitePrivateSourceGate(store);

        var decision = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.SitePublic, Owner, null, CancellationToken.None);

        Assert.True(decision.Allowed);
        Assert.Empty(store.Appended);
    }

    [Fact]
    public async Task EditDraftWithoutNewSources_ShouldStillCarryPrivateSourcesFromItsLineage()
    {
        // 「帮我修改」没再选资料，但草稿内容仍然来自首次生成时的私有资料——只看草稿自己的引用会漏。
        var store = ScenarioWithPrivateBaseline();
        var draft = new HostedSiteRevision
        {
            Id = "draft-1",
            SiteId = store.Site.Id,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.AiEdit,
            ParentRevisionId = "baseline-1",
        };
        store.AddRevision(draft);
        store.ExternallyShared = true;
        var gate = new HostedSitePrivateSourceGate(store);

        var refused = await gate.EnforceForRevisionPublishAsync(store.Site, draft, Owner, null, CancellationToken.None);
        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, refused.Verdict);
        Assert.Equal("entry-private", Assert.Single(refused.Report.Items).EntryId);

        var allowed = await gate.EnforceForRevisionPublishAsync(
            store.Site, draft, Owner, refused.Report.Fingerprint, CancellationToken.None);
        Assert.True(allowed.Allowed);
        var (revisionId, record) = Assert.Single(store.Appended);
        // 发布草稿的确认记在被发布的那一版上。
        Assert.Equal("draft-1", revisionId);
        Assert.Equal(HostedSitePrivateSourceActions.RevisionPublish, record.Action);
    }

    [Fact]
    public async Task PublishDraft_WhenSiteNotSharedYet_ShouldNotAskForConfirmation()
    {
        // 没有任何对外链接时发布只影响作者自己；真正分享时再由分享那道闸确认。
        var store = ScenarioWithPrivateBaseline();
        var draft = new HostedSiteRevision
        {
            Id = "draft-1",
            SiteId = store.Site.Id,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.AiEdit,
            ParentRevisionId = "baseline-1",
            KnowledgeEntryIds = ["entry-private"],
        };
        store.AddRevision(draft);
        var gate = new HostedSitePrivateSourceGate(store);

        var decision = await gate.EnforceForRevisionPublishAsync(store.Site, draft, Owner, null, CancellationToken.None);

        Assert.True(decision.Allowed);
        Assert.Empty(store.Appended);
    }

    [Fact]
    public async Task PublishDraft_WhenSiteIsPublicOnProfile_ShouldRequireConfirmation()
    {
        var store = ScenarioWithPrivateBaseline();
        store.Site.Visibility = "public";
        var draft = new HostedSiteRevision
        {
            Id = "draft-1",
            SiteId = store.Site.Id,
            Status = HostedSiteRevisionStatuses.Draft,
            ParentRevisionId = "baseline-1",
        };
        store.AddRevision(draft);
        var gate = new HostedSitePrivateSourceGate(store);

        var decision = await gate.EnforceForRevisionPublishAsync(store.Site, draft, Owner, null, CancellationToken.None);

        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, decision.Verdict);
    }

    [Fact]
    public async Task RollbackRevision_ShouldFollowTheRestoredContentLineage()
    {
        var store = ScenarioWithPrivateBaseline();
        store.AddStore("store-team", "团队库", isPublic: false, sharedTeamIds: ["team-1"]);
        store.AddEntry("entry-team", "store-team", "团队周报");
        store.AddRevision(new HostedSiteRevision
        {
            Id = "edit-1",
            SiteId = store.Site.Id,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.AiEdit,
            ParentRevisionId = "baseline-1",
            KnowledgeEntryIds = ["entry-team"],
        });
        // 回退版：内容来自 edit-1，ParentRevisionId 指向回退前的当前版（这里故意指到一条不相干的版本）。
        var rollback = new HostedSiteRevision
        {
            Id = "rollback-1",
            SiteId = store.Site.Id,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Rollback,
            ParentRevisionId = "unrelated",
            RollbackTargetRevisionId = "edit-1",
            PublishedContentVersion = Version.AddMinutes(10),
        };
        store.AddRevision(rollback);
        store.Site.ContentVersion = Version.AddMinutes(10);
        var gate = new HostedSitePrivateSourceGate(store);

        var report = await gate.InspectSitesAsync([store.Site], CancellationToken.None);

        Assert.Equal(["entry-team", "entry-private"], report.Items.Select(item => item.EntryId).ToArray());
        Assert.Equal(HostedSitePrivateSourceScopes.Team, report.Items[0].Scope);
        Assert.Equal("rollback-1", report.AnchorRevisionIds[store.Site.Id]);
    }

    [Fact]
    public async Task DeletedSource_ShouldCountAsPrivateBecauseItCannotBeProvenPublic()
    {
        var store = new FakeStore();
        store.AddRevision(Baseline("baseline-1", ["entry-gone"]));
        var gate = new HostedSitePrivateSourceGate(store);

        var report = await gate.InspectSitesAsync([store.Site], CancellationToken.None);

        var item = Assert.Single(report.Items);
        Assert.Equal(HostedSitePrivateSourceScopes.Unavailable, item.Scope);
        Assert.Equal("已删除的资料", item.Title);
    }

    [Fact]
    public void Fingerprint_ShouldDependOnlyOnTheSetOfPrivateEntries()
    {
        var a = HostedSitePrivateSourceRules.ComputeFingerprint(["b", "a", "a"]);
        var b = HostedSitePrivateSourceRules.ComputeFingerprint(["a", "b"]);
        var c = HostedSitePrivateSourceRules.ComputeFingerprint(["a", "b", "c"]);

        Assert.Equal(a, b);
        Assert.NotEqual(a, c);
        Assert.Null(HostedSitePrivateSourceRules.ComputeFingerprint([]));
    }

    [Fact]
    public async Task PublishRevisionEndpoint_WhenGateRefuses_ShouldReturnConflictWithoutPublishing()
    {
        var site = new HostedSite { Id = "site-a", OwnerUserId = Owner, ContentVersion = Version };
        var draft = new HostedSiteRevision { Id = "draft-1", SiteId = "site-a", Status = HostedSiteRevisionStatuses.Draft };
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(service => service.GetAsync("site-a", "draft-1", Owner, CancellationToken.None))
            .ReturnsAsync(draft);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetByIdAsync("site-a", Owner, CancellationToken.None)).ReturnsAsync(site);
        var report = new HostedSitePrivateSourceReport(
            [new HostedSitePrivateSourceItem("site-a", "entry-private", "季度经营数据", "store-private", "财务内部库",
                HostedSitePrivateSourceScopes.OwnerOnly)],
            HostedSitePrivateSourceRules.ComputeFingerprint(["entry-private"]),
            new Dictionary<string, string> { ["site-a"] = "draft-1" });
        var gate = new Mock<IHostedSitePrivateSourceGate>(MockBehavior.Strict);
        gate.Setup(g => g.EnforceForRevisionPublishAsync(site, draft, Owner, null, CancellationToken.None))
            .ReturnsAsync(new HostedSitePrivateSourceDecision(HostedSitePrivateSourceVerdict.ConfirmationRequired, report));
        var controller = BuildEditsController(sites.Object, revisions.Object, gate.Object);

        var result = await controller.PublishRevision("site-a", "draft-1");

        var conflict = Assert.IsType<ConflictObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(conflict.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(
            ErrorCodes.HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_REQUIRED,
            payload.GetProperty("error").GetProperty("code").GetString());
        // Strict mock：PublishAsync 没有 Setup，一旦被调用就会抛——拒绝时绝不能真的发布。
        revisions.Verify(service => service.PublishAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public void Wiring_GateMustBeRegisteredAndAcceptedByBothPublishingControllers()
    {
        // 两个 Controller 以可选依赖接收这道闸；Program.cs 漏注册时生产就等于没有闸，而且不会有任何东西变红。
        var program = File.ReadAllText(LocateRepositoryFile(Path.Combine(
            "prd-api", "src", "PrdAgent.Api", "Program.cs")));
        Assert.Contains("PrdAgent.Api.Services.IHostedSitePrivateSourceGate,", program);
        Assert.Contains("PrdAgent.Api.Services.IHostedSitePrivateSourceStore,", program);

        foreach (var controller in new[] { typeof(WebPagesController), typeof(HostedSiteEditsController) })
        {
            var accepts = controller.GetConstructors()
                .Any(ctor => ctor.GetParameters().Any(p => p.ParameterType == typeof(IHostedSitePrivateSourceGate)));
            Assert.True(accepts, $"{controller.Name} 的构造函数没有接收 IHostedSitePrivateSourceGate");
        }
    }

    [Fact]
    public async Task CollectionShare_WhenPrivateSourceOnlyOnSite51OrLater_ShouldStillRefuse()
    {
        // 大合集绕过（Codex P1）：分享服务会把 siteIds 里的每一个站点都发布出去，闸不许只看前 50 个。
        var store = new FakeStore();
        store.AddStore("store-private", "财务内部库", isPublic: false);
        store.AddEntry("entry-private", "store-private", "季度经营数据");
        var siteIds = Enumerable.Range(1, 60).Select(i => $"site-{i:D2}").ToList();
        foreach (var id in siteIds)
            store.AddRevision(Baseline($"baseline-{id}", id == "site-56" ? ["entry-private"] : [], id));
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetByIdAsync(It.IsAny<string>(), Owner, CancellationToken.None))
            .ReturnsAsync((string id, string _, CancellationToken _) => new HostedSite
            {
                Id = id,
                OwnerUserId = Owner,
                ContentVersion = Version,
                Visibility = "private",
            });
        sites.Setup(service => service.CanCreateShareAsync(It.IsAny<IReadOnlyCollection<string>>(), Owner, CancellationToken.None))
            .ReturnsAsync(true);
        var controller = BuildWebPagesController(sites.Object, new HostedSitePrivateSourceGate(store));

        var refused = await controller.CreateShare(new CreateWebPageShareRequest
        {
            ShareType = "collection",
            SiteIds = siteIds,
            Visibility = "logged-in",
        });

        var conflict = Assert.IsType<ConflictObjectResult>(refused);
        var payload = JsonSerializer.SerializeToElement(conflict.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(
            ErrorCodes.HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_REQUIRED,
            payload.GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("季度经营数据", payload.GetProperty("error").GetProperty("message").GetString());
        // Strict mock：CreateShareAsync 没有 Setup，被调用就会抛——拒绝时绝不能生成链接。
        sites.Verify(service => service.CreateShareAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<int>(), It.IsAny<CancellationToken>(),
            It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<List<string>?>()), Times.Never);

        // 预检也必须覆盖全部站点：它给的指纹要和强制那道闸按全部站点算出来的一致，否则作者确认了也过不去。
        var inspected = await controller.InspectPrivateSourcesByBody(new InspectPrivateSourcesRequest { SiteIds = siteIds });
        var ok = Assert.IsType<OkObjectResult>(inspected);
        var report = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            .GetProperty("data");
        Assert.True(report.GetProperty("requiresConfirmation").GetBoolean());
        Assert.Equal("entry-private", Assert.Single(report.GetProperty("items").EnumerateArray().ToList())
            .GetProperty("entryId").GetString());
        Assert.Equal(HostedSitePrivateSourceRules.ComputeFingerprint(["entry-private"]), report.GetProperty("fingerprint").GetString());
    }

    [Fact]
    public async Task Share_WhenSomeTargetSiteIsNoLongerAccessible_ShouldFailClosed()
    {
        // 部分目标站点读不到（被删 / 权限收回）时不许按部分结果放行（Codex P1）：
        // 放宽链接的下游只认创建者，不会再拒这些站点，它们引用的私有资料就从来没被确认过。
        var store = new FakeStore();
        store.AddRevision(Baseline("baseline-site-01", [], "site-01"));
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetByIdAsync("site-01", Owner, CancellationToken.None))
            .ReturnsAsync(new HostedSite { Id = "site-01", OwnerUserId = Owner, ContentVersion = Version, Visibility = "private" });
        sites.Setup(service => service.GetByIdAsync("site-02", Owner, CancellationToken.None))
            .ReturnsAsync((HostedSite?)null);
        sites.Setup(service => service.CanCreateShareAsync(It.IsAny<IReadOnlyCollection<string>>(), Owner, CancellationToken.None))
            .ReturnsAsync(true);
        var controller = BuildWebPagesController(sites.Object, new HostedSitePrivateSourceGate(store));

        var refused = await controller.CreateShare(new CreateWebPageShareRequest
        {
            ShareType = "collection",
            SiteIds = ["site-01", "site-02"],
            Visibility = "public",
        });

        var forbidden = Assert.IsType<ObjectResult>(refused);
        Assert.Equal(StatusCodes.Status403Forbidden, forbidden.StatusCode);
        var body = JsonSerializer.Serialize(forbidden.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Contains(ErrorCodes.PERMISSION_DENIED, body);
        Assert.DoesNotContain("site-02", body);
        // Strict mock：CreateShareAsync 没有 Setup，被调用就会抛。
    }

    [Fact]
    public async Task ShareOrPublic_WhenActiveRevisionIsStuckInPublishing_ShouldStillInspectIt()
    {
        // 发布恢复态绕过（Codex P1）：站点指针与内容已切到 edit-1，只是最后一步写版本账本失败，
        // edit-1 停在 publishing、PublishedContentVersion 为空。线上跑的就是它的内容，必须纳入核查。
        var store = ScenarioWithPrivateBaseline();
        store.AddStore("store-team", "团队库", isPublic: false, sharedTeamIds: ["team-1"]);
        store.AddEntry("entry-team", "store-team", "团队周报");
        store.AddRevision(new HostedSiteRevision
        {
            Id = "edit-1",
            SiteId = store.Site.Id,
            Status = HostedSiteRevisionStatuses.Publishing,
            Source = HostedSiteRevisionSources.AiEdit,
            ParentRevisionId = "baseline-1",
            KnowledgeEntryIds = ["entry-team"],
            BasedOnContentVersion = Version,
            PublishedContentVersion = null,
        });
        store.Site.PublishedRevisionId = "edit-1";
        store.Site.ContentVersion = Version.AddMinutes(5);
        var gate = new HostedSitePrivateSourceGate(store);

        foreach (var action in new[] { HostedSitePrivateSourceActions.ShareCreate, HostedSitePrivateSourceActions.SitePublic })
        {
            var decision = await gate.EnforceForSitesAsync([store.Site], action, Owner, null, CancellationToken.None);

            Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, decision.Verdict);
            Assert.Equal(["entry-team", "entry-private"], decision.Report.Items.Select(item => item.EntryId).ToArray());
            Assert.Equal("edit-1", decision.Report.AnchorRevisionIds[store.Site.Id]);
        }
        Assert.Empty(store.Appended);
    }

    [Fact]
    public async Task ShareOrPublic_WhenActivePointerHasNoRevision_ShouldAskInsteadOfPassingAsUnsourced()
    {
        // 站点有活动指针却找不到那条版本：无法证明它没引用私有资料，按「无法确认」列给作者，不静默放行。
        var store = ScenarioWithPrivateBaseline();
        store.Site.Title = "经营看板";
        store.Site.PublishedRevisionId = "edit-gone";
        store.Site.ContentVersion = Version.AddMinutes(5);
        var gate = new HostedSitePrivateSourceGate(store);

        var refused = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.SitePublic, Owner, null, CancellationToken.None);

        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, refused.Verdict);
        var item = Assert.Single(refused.Report.Items);
        Assert.Equal(HostedSitePrivateSourceScopes.Unavailable, item.Scope);
        Assert.StartsWith(HostedSitePrivateSourceGate.UnresolvedRevisionEntryPrefix, item.EntryId);
        Assert.Contains("经营看板", item.Title);

        var allowed = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.SitePublic, Owner, refused.Report.Fingerprint, CancellationToken.None);
        Assert.True(allowed.Allowed);
    }

    [Fact]
    public async Task ShareOrPublish_WhenPrivateSourceOnlyOnSeventiethAncestor_ShouldAskInsteadOfTruncatingSilently()
    {
        // 血缘截断绕过（Codex P1）：改了 70 次的页面，私有资料只在第 70 代祖先（基线）上。
        // 回溯只走 MaxLineageDepth 步，读不到头时不许把截断后的集合当完整结果放行。
        var store = ScenarioWithPrivateBaseline();
        store.Site.Title = "经营看板";
        var previous = "baseline-1";
        for (var generation = 1; generation <= 70; generation++)
        {
            var id = $"edit-{generation:D2}";
            store.AddRevision(new HostedSiteRevision
            {
                Id = id,
                SiteId = store.Site.Id,
                Status = HostedSiteRevisionStatuses.Published,
                Source = HostedSiteRevisionSources.AiEdit,
                ParentRevisionId = previous,
                KnowledgeEntryIds = [],
            });
            previous = id;
        }
        store.Site.PublishedRevisionId = "edit-70";
        var gate = new HostedSitePrivateSourceGate(store);
        // 从 edit-70 往上读满 64 代，最后读到的是 edit-07，edit-06 及更早都没读到。
        var expectedEntryId = $"{HostedSitePrivateSourceGate.TruncatedLineageEntryPrefix}site-a:edit-07";

        var refused = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, null, CancellationToken.None);

        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, refused.Verdict);
        var item = Assert.Single(refused.Report.Items);
        Assert.Equal(expectedEntryId, item.EntryId);
        Assert.Equal(HostedSitePrivateSourceScopes.Unavailable, item.Scope);
        Assert.Contains("经营看板", item.Title);
        Assert.Contains("更早版本的来源无法确认", item.Title);
        Assert.Empty(store.Appended);

        // 确认之后照常放行，确认记录落在当前线上版本上，内容就是这一条「无法确认」。
        var allowed = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, refused.Report.Fingerprint, CancellationToken.None);
        Assert.True(allowed.Allowed);
        var (anchor, record) = Assert.Single(store.Appended);
        Assert.Equal("edit-70", anchor);
        Assert.Equal(expectedEntryId, Assert.Single(record.Sources).EntryId);

        // 发布草稿走的是同一条血缘：站点已对外可见时，基于 edit-70 的草稿同样要确认。
        store.ExternallyShared = true;
        var draft = new HostedSiteRevision
        {
            Id = "draft-71",
            SiteId = store.Site.Id,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.AiEdit,
            ParentRevisionId = "edit-70",
            KnowledgeEntryIds = [],
        };
        var publish = await gate.EnforceForRevisionPublishAsync(store.Site, draft, Owner, null, CancellationToken.None);
        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, publish.Verdict);
        Assert.StartsWith(HostedSitePrivateSourceGate.TruncatedLineageEntryPrefix, Assert.Single(publish.Report.Items).EntryId);
    }

    [Fact]
    public async Task Share_WhenLineageLoopsBackOnItself_ShouldAskInsteadOfTreatingItAsComplete()
    {
        // 血缘成环（数据损坏）：环以外的祖先读不到，同样按「更早版本的来源无法确认」列出。
        var store = new FakeStore();
        store.AddRevision(new HostedSiteRevision
        {
            Id = "edit-a", SiteId = "site-a", Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.AiEdit, ParentRevisionId = "edit-b", KnowledgeEntryIds = [],
        });
        store.AddRevision(new HostedSiteRevision
        {
            Id = "edit-b", SiteId = "site-a", Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.AiEdit, ParentRevisionId = "edit-a", KnowledgeEntryIds = [],
        });
        store.Site.PublishedRevisionId = "edit-a";
        var gate = new HostedSitePrivateSourceGate(store);

        var decision = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, null, CancellationToken.None);

        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, decision.Verdict);
        Assert.Equal(
            $"{HostedSitePrivateSourceGate.TruncatedLineageEntryPrefix}site-a:edit-b",
            Assert.Single(decision.Report.Items).EntryId);
    }

    [Fact]
    public async Task Share_WhenRecordedParentRevisionIsMissing_ShouldAskInsteadOfTreatingItAsComplete()
    {
        // 版本记着上一代、上一代却读不到（数据损坏）：私有资料可能正好在那一代，同样按「无法确认」列出。
        var store = new FakeStore();
        store.AddRevision(new HostedSiteRevision
        {
            Id = "edit-a", SiteId = "site-a", Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.AiEdit, ParentRevisionId = "gone", KnowledgeEntryIds = [],
        });
        store.Site.PublishedRevisionId = "edit-a";
        var gate = new HostedSitePrivateSourceGate(store);

        var decision = await gate.EnforceForSitesAsync(
            [store.Site], HostedSitePrivateSourceActions.ShareCreate, Owner, null, CancellationToken.None);

        Assert.Equal(HostedSitePrivateSourceVerdict.ConfirmationRequired, decision.Verdict);
        Assert.Equal(
            $"{HostedSitePrivateSourceGate.TruncatedLineageEntryPrefix}site-a:edit-a",
            Assert.Single(decision.Report.Items).EntryId);
    }

    [Fact]
    public async Task PrivateSourceInspect_ForTeamViewer_ShouldRefuseWithoutLeakingSourceNames()
    {
        // 站点分享给团队后 GetByIdAsync 对 viewer 也放行（Codex P1）：核查接口不能把私有文档名、知识库名给 viewer。
        var store = ScenarioWithPrivateBaseline();
        var sites = TeamViewerSites(store.Site);
        var controller = BuildWebPagesController(sites.Object, new HostedSitePrivateSourceGate(store), Viewer);

        foreach (var result in new[]
                 {
                     await controller.InspectPrivateSources(["site-a"]),
                     await controller.InspectPrivateSourcesByBody(new InspectPrivateSourcesRequest { SiteIds = ["site-a"] }),
                 })
        {
            var refused = Assert.IsType<ObjectResult>(result);
            Assert.Equal(StatusCodes.Status403Forbidden, refused.StatusCode);
            var body = JsonSerializer.Serialize(refused.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            Assert.Contains(ErrorCodes.PERMISSION_DENIED, body);
            Assert.DoesNotContain("季度经营数据", body);
            Assert.DoesNotContain("财务内部库", body);
            Assert.DoesNotContain("psc1:", body);
        }
    }

    [Fact]
    public async Task ShareOrPublicByTeamViewer_EvenWithCorrectFingerprint_ShouldRefuseAndNotRecordConfirmation()
    {
        // viewer 拿到了正确的指纹（例如从作者那里看来的）：权限门必须先于确认记录，拒绝且不写记录。
        var store = ScenarioWithPrivateBaseline();
        var fingerprint = (await new HostedSitePrivateSourceGate(store).InspectSitesAsync([store.Site], CancellationToken.None))
            .Fingerprint;
        Assert.NotNull(fingerprint);
        var sites = TeamViewerSites(store.Site);
        var controller = BuildWebPagesController(sites.Object, new HostedSitePrivateSourceGate(store), Viewer);

        var share = await controller.CreateShare(new CreateWebPageShareRequest
        {
            SiteId = "site-a",
            Visibility = "public",
            ConfirmedPrivateSourceFingerprint = fingerprint,
        });
        var shareRefused = Assert.IsType<BadRequestObjectResult>(share);
        var sharePayload = JsonSerializer.SerializeToElement(
            shareRefused.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(ErrorCodes.PERMISSION_DENIED, sharePayload.GetProperty("error").GetProperty("code").GetString());

        var visibility = await controller.SetVisibility("site-a", new SetVisibilityRequest
        {
            Visibility = "public",
            ConfirmedPrivateSourceFingerprint = fingerprint,
        });
        Assert.IsType<NotFoundObjectResult>(visibility);

        Assert.Empty(store.Appended);
        // Strict mock：CreateShareAsync / SetVisibilityAsync 都没有 Setup，被调用就会抛。
        sites.Verify(service => service.SetVisibilityAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── 夹具 ──

    private const string Viewer = "team-viewer";

    /// <summary>站点分享到了团队、当前用户是 viewer：看得见（GetByIdAsync 放行），但不能分享、不能改可见性。</summary>
    private static Mock<IHostedSiteService> TeamViewerSites(HostedSite site)
    {
        site.SharedTeamIds = ["team-1"];
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetByIdAsync(site.Id, Viewer, CancellationToken.None)).ReturnsAsync(site);
        sites.Setup(service => service.CanCreateShareAsync(It.IsAny<IReadOnlyCollection<string>>(), Viewer, CancellationToken.None))
            .ReturnsAsync(false);
        sites.Setup(service => service.CanSetVisibility(site, Viewer)).Returns(false);
        return sites;
    }

    private static FakeStore ScenarioWithPrivateBaseline()
    {
        var store = new FakeStore();
        store.AddStore("store-private", "财务内部库", isPublic: false);
        store.AddEntry("entry-private", "store-private", "季度经营数据");
        store.AddRevision(Baseline("baseline-1", ["entry-private"]));
        return store;
    }

    private static HostedSiteRevision Baseline(string id, List<string> knowledge, string siteId = "site-a") => new()
    {
        Id = id,
        SiteId = siteId,
        Status = HostedSiteRevisionStatuses.Published,
        Source = HostedSiteRevisionSources.Baseline,
        KnowledgeEntryIds = knowledge,
        PublishedContentVersion = Version,
    };

    private static HostedSiteEditsController BuildEditsController(
        IHostedSiteService sites,
        IHostedSiteRevisionService revisions,
        IHostedSitePrivateSourceGate gate)
    {
        var db = new MongoDbContext("mongodb://127.0.0.1:27017", $"private_source_gate_unit_{Guid.NewGuid():N}");
        var controller = new HostedSiteEditsController(
            sites,
            revisions,
            Mock.Of<IRunEventStore>(),
            Mock.Of<IRunQueue>(),
            db,
            NullLogger<HostedSiteEditsController>.Instance,
            Mock.Of<IDesignArtifactProviderCatalog>(),
            Mock.Of<IDesignKnowledgeSnapshotResolver>(),
            Mock.Of<IWebPageDesignArtifactLifecycleAdapter>(),
            new DesignArtifactCancellationCoordinator(db, Mock.Of<IDesignArtifactLifecycleService>()),
            new ConfigurationBuilder().Build(),
            generationSettings: null,
            privateSources: gate);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", Owner) }, "test")),
            },
        };
        return controller;
    }

    private static WebPagesController BuildWebPagesController(
        IHostedSiteService sites,
        IHostedSitePrivateSourceGate gate,
        string userId = Owner)
    {
        var controller = new WebPagesController(
            sites,
            Mock.Of<IHostedSiteOptimizationService>(),
            Mock.Of<IUploadProgressService>(),
            new MongoDbContext("mongodb://127.0.0.1:27017", $"private_source_gate_unit_{Guid.NewGuid():N}"),
            Mock.Of<ITeamService>(),
            Mock.Of<IHttpClientFactory>(),
            gate);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", userId) }, "test")),
            },
        };
        return controller;
    }

    private static string LocateRepositoryFile(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"从 {AppContext.BaseDirectory} 向上找不到 {relativePath}");
    }

    private sealed class FakeStore : IHostedSitePrivateSourceStore
    {
        private readonly Dictionary<string, HostedSiteRevision> _revisions = new(StringComparer.Ordinal);
        private readonly Dictionary<string, DocumentEntry> _entries = new(StringComparer.Ordinal);
        private readonly Dictionary<string, DocumentStore> _stores = new(StringComparer.Ordinal);

        public HostedSite Site { get; } = new()
        {
            Id = "site-a",
            OwnerUserId = Owner,
            ContentVersion = Version,
            Visibility = "private",
        };

        public bool ExternallyShared { get; set; }

        public List<(string RevisionId, HostedSitePrivateSourceConfirmation Record)> Appended { get; } = new();

        public void AddRevision(HostedSiteRevision revision) => _revisions[revision.Id] = revision;

        public void AddEntry(string id, string storeId, string title) =>
            _entries[id] = new DocumentEntry { Id = id, StoreId = storeId, Title = title };

        public void AddStore(string id, string name, bool isPublic, List<string>? sharedTeamIds = null) =>
            _stores[id] = new DocumentStore { Id = id, Name = name, IsPublic = isPublic, SharedTeamIds = sharedTeamIds ?? new() };

        public Task<HostedSiteRevision?> FindCurrentRevisionAsync(string siteId, DateTime contentVersion, CancellationToken ct) =>
            Task.FromResult(_revisions.Values.FirstOrDefault(revision =>
                revision.SiteId == siteId
                && revision.Status == HostedSiteRevisionStatuses.Published
                && revision.PublishedContentVersion == contentVersion));

        public Task<HostedSiteRevision?> FindRevisionAsync(string siteId, string revisionId, CancellationToken ct) =>
            Task.FromResult(_revisions.TryGetValue(revisionId, out var revision) && revision.SiteId == siteId
                ? revision
                : null);

        public Task<IReadOnlyList<DocumentEntry>> FindEntriesAsync(IReadOnlyCollection<string> entryIds, CancellationToken ct) =>
            Task.FromResult<IReadOnlyList<DocumentEntry>>(
                entryIds.Where(_entries.ContainsKey).Select(id => _entries[id]).ToList());

        public Task<IReadOnlyList<DocumentStore>> FindStoresAsync(IReadOnlyCollection<string> storeIds, CancellationToken ct) =>
            Task.FromResult<IReadOnlyList<DocumentStore>>(
                storeIds.Where(_stores.ContainsKey).Select(id => _stores[id]).ToList());

        public Task<bool> HasExternalShareLinkAsync(string siteId, DateTime now, CancellationToken ct) =>
            Task.FromResult(ExternallyShared);

        public Task AppendConfirmationAsync(string revisionId, HostedSitePrivateSourceConfirmation confirmation, CancellationToken ct)
        {
            Appended.Add((revisionId, confirmation));
            return Task.CompletedTask;
        }
    }
}
