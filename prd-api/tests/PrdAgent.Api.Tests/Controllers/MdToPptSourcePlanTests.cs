using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using System.Text;
using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class MdToPptSourcePlanTests
{
    private static List<DesignKnowledgeSnapshot> Sources(string content) => new()
    {
        new DesignKnowledgeSnapshot { StoreId = "store", EntryId = "entry", Content = content, ContentHash = MdToPptSourcePlan.Hash(content) },
    };

    private static (MdToPptSourcePlan Catalog, MdToPptSourcePlan.PagePlan Page) OnePage(string content)
    {
        var catalog = MdToPptSourcePlan.Create(Sources(content));
        return (catalog, catalog.Bind(new[] { new MdToPptOutlinePageDto { SourceBlockIds = catalog.Blocks.Select(x => x.Id).ToList() } }, 1)[0]);
    }

    private static string Slots(MdToPptSourcePlan.PagePlan page) => string.Join("", page.Blocks.Select(x => $"<div data-mdppt-source=\"{x.Id}\">\n  </div>"));

    [Fact]
    public void FrozenCatalog_HasStableVersionedIdentityAndNoOverlappingListOrTableRows()
    {
        const string source = "# 服务\n\n- 安静阅读：免费，不提供线上报名。\n- 图书交换：每次最多带3本。\n- 邻里共读：每场最多12人。\n\n| 日期 | 名额 |\n|---|---|\n| 周六 | 12 |\n| 周日 | 10 |\n";
        var first = MdToPptSourcePlan.Create(Sources(source));
        Assert.Equal(3, first.Blocks.Count);
        Assert.Equal(first.Fingerprint, MdToPptSourcePlan.Create(Sources(source)).Fingerprint);
        Assert.NotEqual(first.Fingerprint, MdToPptSourcePlan.Create(Sources(source.Replace("12", "13"))).Fingerprint);
        Assert.Equal(new[] { "安静阅读", "图书交换", "邻里共读" }, first.Blocks[1].Labels);
        Assert.Contains("<thead>", first.Blocks[2].Html);
        Assert.Contains("<tbody>", first.Blocks[2].Html);
        Assert.Equal(3, Regex.Matches(first.Blocks[2].Html, "<tr>").Count);
        Assert.DoesNotContain(first.Blocks[2].Id, first.Blocks[1].Html);
    }

    [Fact]
    public void FrozenCatalog_PreservesTaskStateAndOrderedStart()
    {
        var plan = MdToPptSourcePlan.Create(Sources("- [x] 已完成\n- [ ] 尚未完成\n\n3. 第三步\n4. 第四步\n"));
        Assert.Contains("checked", plan.Blocks[0].Html);
        Assert.Single(Regex.Matches(plan.Blocks[0].Html, "checked="));
        Assert.Contains("start=\"3\"", plan.Blocks[1].Html);
    }

    [Fact]
    public void PipeTableWithImmediateNote_RendersSemanticRowsWithoutChangingFrozenText()
    {
        const string content = "| 日期 | 时间 | 主题 | 总名额 | 剩余名额 |\n|---|---|---|---|---|\n| 2026-09-12 | 10:00—11:00 | 城市里的树 | 12 | 5 |\n| 2026-09-13 | 14:00—15:00 | 给未来的一封信 | 12 | 0 |\n| 2026-09-19 | 10:00—11:00 | 旧物的新故事 | 12 | 8 |\n剩余0个名额表示已满，不可写成未开放或无限名额。\n活动日期均为虚构排期，不构成真实活动邀请。";
        var catalog = MdToPptSourcePlan.Create(Sources(content));
        var block = Assert.Single(catalog.Blocks);
        Assert.Equal(content, block.Markdown);
        Assert.Contains("<thead>", block.Html);
        Assert.Contains("<tbody>", block.Html);
        Assert.Equal(4, Regex.Matches(block.Html, "<tr>").Count);
        Assert.Equal(15, Regex.Matches(block.Html, "<td>").Count);
        Assert.Contains("<td>0</td>", block.Html);
        Assert.Contains("剩余0个名额表示已满，不可写成未开放或无限名额。", block.Html);
        Assert.Contains("活动日期均为虚构排期，不构成真实活动邀请。", block.Html);
        Assert.DoesNotContain("<table>", Assert.Single(MdToPptSourcePlan.Create(Sources("```text\n" + content + "\n```")).Blocks).Html);
        Assert.DoesNotContain("<table>", Assert.Single(MdToPptSourcePlan.Create(Sources("| 普通分隔文字 |\n不是表格尾注。")).Blocks).Html);
    }

    [Fact]
    public void Coverage_RejectsUnknownMissingDuplicateAndPageCount_InsteadOfChangingFourPages()
    {
        var plan = MdToPptSourcePlan.Create(Sources("# 第一\n\n第一事实。\n\n# 第二\n\n第二事实。"));
        var pages = plan.Blocks.Select(x => new MdToPptOutlinePageDto { SourceBlockIds = new() { x.Id } }).ToList();
        Assert.Equal(4, plan.Bind(pages, 4).Count);
        Assert.Equal("source_plan_page_count", Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages.Take(3).ToList(), 4)).Code);
        pages[3].SourceBlockIds = new() { "forged" };
        Assert.Equal("source_plan_unknown_block", Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 4)).Code);
        pages[3].SourceBlockIds = pages[0].SourceBlockIds;
        Assert.Equal("source_plan_incomplete", Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 4)).Code);
        pages[3].SourceBlockIds = new() { plan.Blocks[3].Id, plan.Blocks[3].Id };
        Assert.Equal("source_plan_unknown_block", Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 4)).Code);
        Assert.Throws<MdToPptSourcePlanException>(() => MdToPptSourcePlan.Create(Sources("  \n")));
    }

    [Fact]
    public void ModelJsonNullPage_ReturnsReadableMissingSourceRatherThanNullReference()
    {
        var catalog = MdToPptSourcePlan.Create(Sources("完整事实。"));
        var pages = JsonSerializer.Deserialize<List<MdToPptOutlinePageDto>>("[null]")!;
        var error = Assert.Throws<MdToPptSourcePlanException>(() => catalog.Bind(pages, 1));
        Assert.Equal("source_plan_missing", error.Code);
        Assert.Contains("重新生成", error.Message);
    }

    [Theory]
    [InlineData("opacity:0.5;font-size:0.9em", true)]
    [InlineData("opacity:.8", true)]
    [InlineData("opacity:0", false)]
    [InlineData("font-size:0px", false)]
    [InlineData("display:none", false)]
    public void SourceSlot_WhitespaceIsFormattingAndFractionalStylesAreVisible(string style, bool accepted)
    {
        var (_, page) = OnePage("不提供线上报名。");
        Assert.Equal(accepted, MdToPptSourcePlan.Materialize($"<div class=\"slide\"><div style=\"{style}\">{Slots(page)}</div></div>", page, out var html, out _));
        if (accepted) Assert.True(MdToPptSourcePlan.HasCompleteMaterializedContent(html, page));
    }

    [Theory]
    [InlineData("提供线上报名")]
    [InlineData("最多99人")]
    [InlineData("客户最多12人")]
    [InlineData("每场最多24人")]
    public void ModelPeripheral_CannotReverseNegationInventNumberOrMoveEntity(string claim)
    {
        var (_, page) = OnePage("- 邻里共读：每场最多12人。\n- 报名方式：不提供线上报名。\n");
        var html = MdToPptController.MaterializeSourcePage($"<div class=\"slide\"><h2>{claim}</h2>{Slots(page)}</div>", page, 0, 1, out var validation);
        Assert.Empty(html);
        Assert.True(validation.Rejected);
    }

    [Fact]
    public void RealListLabels_CanRepeatWithoutChangingOrDeletingFrozenFacts()
    {
        var (_, page) = OnePage("- 安静阅读：免费。\n- 图书交换：每次最多带3本。\n- 邻里共读：每场最多12人，不提供线上报名。\n");
        var html = MdToPptController.MaterializeSourcePage("<div class=\"slide\"><h2>安静阅读</h2><h3>图书交换</h3><h3>邻里共读</h3><span>邻里共读</span>" + Slots(page) + "</div>", page, 0, 1, out var validation);
        Assert.False(validation.Rejected);
        Assert.True(MdToPptSourcePlan.HasCompleteMaterializedContent(html, page));
        Assert.Contains("每场最多12人，不提供线上报名。", html);
    }

    [Fact]
    public void FrozenPlainLines_RecognizeOnlyFullFieldLabels_AndConfirmedTitleRemainsEditable()
    {
        var catalog = MdToPptSourcePlan.Create(Sources("安静阅读：免费。\n图书交换：每次最多带3本。\n邻里共读：每场最多12人，不提供线上报名。\n周二至周五：14:00—19:00。"));
        var page = catalog.Bind(new[] { new MdToPptOutlinePageDto { Title = "用户确认的新标题", SourceBlockIds = catalog.Blocks.Select(x => x.Id).ToList() } }, 1)[0];
        Assert.Contains("安静阅读", page.Blocks[0].Labels);
        Assert.Contains("图书交换", page.Blocks[0].Labels);
        Assert.Contains("邻里共读", page.Blocks[0].Labels);
        Assert.DoesNotContain("14", page.Blocks[0].Labels);
        var html = MdToPptController.MaterializeSourcePage("<div class=\"slide\"><h1>用户确认的新标题</h1><h2>安静阅读</h2>" + Slots(page) + "</div>", page, 0, 1, out var verdict);
        Assert.False(verdict.Rejected);
        Assert.Contains("用户确认的新标题", html);
        Assert.True(MdToPptSourcePlan.HasCompleteMaterializedContent(html, page));
        Assert.False(MdToPptSourcePlan.HasCompleteMaterializedContent("<div>用户确认的新标题</div>", page));
    }

    [Fact]
    public void MarkersOrAttributesAloneCannotClaimCoverage_AndMaterializedNegationIsImmutable()
    {
        var (_, page) = OnePage("不提供线上报名。");
        Assert.False(MdToPptSourcePlan.Materialize("<div class=\"slide\" data-fact=\"不提供线上报名。\"></div>", page, out _, out _));
        Assert.False(MdToPptSourcePlan.Materialize("<div class=\"slide\"><!--" + Slots(page) + "--></div>", page, out _, out _));
        Assert.False(MdToPptSourcePlan.Materialize("<div class=\"slide\" hidden=\"hidden\">" + Slots(page) + "</div>", page, out _, out _));
        var html = MdToPptSourcePlan.Fallback(page, 0, 1);
        Assert.True(MdToPptSourcePlan.HasCompleteMaterializedContent(html, page));
        Assert.False(MdToPptSourcePlan.HasCompleteMaterializedContent(html.Replace("不提供", "提供"), page));
    }

    [Fact]
    public void FirstAndOnlyRetry_ActualGatewayUserSharesSamePlan_WithoutSourceDuplicateOrTokenCap()
    {
        var (_, page) = OnePage("| 日期 | 名额 |\n|---|---|\n| 周六 | 12 |\n| 周日 | 10 |\n| 周一 | 8 |\n");
        var req = new MdToPptConvertRequest { Content = "用户指令99不是事实", OutlinePages = new() { new() { Title = "活动安排", Design = "表格" } } };
        var user = MdToPptController.BuildAnchoredPageUserPrompt(req, 0, 1, page);
        var retry = MdToPptController.BuildAnchoredPageRetryUserPrompt(user,
            new(MdToPptController.UnsupportedVisibleClaimKind.SourceContentIncomplete));
        foreach (var prompt in new[] { user, retry })
        {
            var wire = MdToPptController.BuildGatewayPageRequest(new InfraAgentRuntimeProfile { Model = "model-a" }, "system", prompt,
                "md-to-ppt-agent.generation::chat", "request", "user", "page", "run");
            var sent = wire.RequestBody!["messages"]![1]!["content"]!.GetValue<string>();
            Assert.Single(Regex.Matches(sent, page.Hash));
            Assert.Single(Regex.Matches(sent, Regex.Escape(page.Blocks[0].Id)));
            Assert.DoesNotContain("用户指令99", sent);
            Assert.False(wire.RequestBody.ContainsKey("max_tokens"));
            Assert.Equal("run", wire.Context!.RunId);
            Assert.Equal("model-a", wire.ExpectedModel);
        }
        Assert.StartsWith(user, retry);
    }

    [Fact]
    public void ChildRunOwnsPlan_FinalNormalizedFourPagesCannotSilentlyDropOrMoveSource()
    {
        var sources = Sources("# 介绍\n\n不提供线上报名。\n\n# 活动\n\n每场最多12人。");
        var catalog = MdToPptSourcePlan.Create(sources);
        var pages = catalog.Blocks.Select(x => new MdToPptOutlinePageDto { Title = "用户确认的展示标题", SourceBlockIds = new() { x.Id } }).ToList();
        var child = new MdToPptRun { KnowledgeReferences = sources, SourcePlanVersion = 1, SourcePlanPageCount = 4,
            SourcePlanJson = MdToPptController.BuildCanonicalOutlineJson(pages, "摘要"),
            SourcePlanHash = MdToPptController.ComputeSourcePlanHash(sources, pages, 4) };
        var plan = MdToPptController.RestoreSourcePlan(child);
        pages[0].SourceBlockIds!.Clear(); // 模拟父工作稿后续改动，子 Run 不可被影响。
        var anchor = MdToPptAnchors.Resolve("tech-dark")!;
        var sections = plan.Select((p, i) => MdToPptController.NormalizeSlidePageIdentity(
            MdToPptSourcePlan.Fallback(p, i, 4, MdToPptAnchors.PickLayout(anchor, i, 4, null)), i, 4)).ToArray();
        var document = MdToPptController.NormalizePresentationDocument(anchor.Prefix + string.Join("\n", sections) + anchor.Suffix);
        document = Encoding.UTF8.GetString(HostedSiteService.RewritePublishedEntryHtml(Encoding.UTF8.GetBytes(document), "index.html"));
        Assert.True(MdToPptController.ValidateSourcePlanDocument(child, document));
        Assert.False(MdToPptController.ValidateSourcePlanDocument(child, document.Replace("不提供", "提供")));
        Assert.False(MdToPptController.ValidateSourcePlanDocument(child, anchor.Prefix + string.Join("\n", sections.Take(3)) + anchor.Suffix));
        Assert.False(MdToPptController.ValidateSourcePlanDocument(child, anchor.Prefix + string.Join("\n", sections.Reverse()) + anchor.Suffix));
        Assert.Contains("用户确认的展示标题", document);
    }

    [Fact]
    public void PersistenceWiring_ChecksPreparedBytesBeforeDoneAndUsesChildOwnedPlan()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "prd-api/src/PrdAgent.Api/Controllers/Api/MdToPptController.cs"))) directory = directory.Parent;
        Assert.NotNull(directory);
        var source = File.ReadAllText(Path.Combine(directory!.FullName, "prd-api/src/PrdAgent.Api/Controllers/Api/MdToPptController.cs"));
        var begin = source.IndexOf("private async Task<bool> PersistRunDoneAsync", StringComparison.Ordinal);
        var prepare = source.IndexOf("html = PreparePublishedHtml(NormalizePresentationDocument(html))", begin, StringComparison.Ordinal);
        var gate = source.IndexOf("ValidateSourcePlanDocument(run, html)", begin, StringComparison.Ordinal);
        var done = source.IndexOf("run.Status = \"done\"", begin, StringComparison.Ordinal);
        Assert.True(prepare > begin && gate > prepare && done > gate);
        Assert.Contains("sourcePlanJson: sourcePlanJson", source);
        Assert.Contains("sourcePages = RestoreSourcePlan(run)", source);
        Assert.Equal(2, Regex.Matches(source, "section = MaterializeSourcePage\\(section, sourcePages\\[i\\]").Count);
    }

    [Theory]
    [InlineData("tech-dark")]
    [InlineData("editorial-ink")]
    [InlineData("warm-zine")]
    [InlineData("atelier-zero")]
    public void SourceFallback_PreservesAllFactsAndActualThemeRootWithoutShortTitleOrThreeBulletLimit(string theme)
    {
        var (_, page) = OnePage("这是超过十六字的完整条件且必须逐字保留不能删减。\n\n第一项。\n\n第二项。\n\n第三项。\n\n第四项。\n\n| 日期 | 名额 |\n|---|---|\n| 周六 | 12 |\n");
        var layout = MdToPptAnchors.PickLayout(MdToPptAnchors.Resolve(theme)!, 1, 4, "表格");
        var html = MdToPptSourcePlan.Fallback(page, 1, 4, layout);
        Assert.True(MdToPptSourcePlan.HasCompleteMaterializedContent(html, page));
        Assert.Contains("第四项。", html);
        Assert.Contains("<thead>", html);
        Assert.Contains("<tbody>", html);
        Assert.StartsWith(Regex.Match(layout.Html, "<(div|section|article)\\b[^>]*>").Value, html);
    }
    [Fact]
    public void ConfirmedOutlineHash_BindsSourceIdsToPage_NotJustVisibleOutline()
    {
        static List<MdToPptOutlinePageDto> Parse(string id) => JsonSerializer.Deserialize<List<MdToPptOutlinePageDto>>(
            "[{\"title\":\"开放安排\",\"bullets\":[\"不提供线上报名\"],\"sourceBlockIds\":[\"" + id + "\"]}]",
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        Assert.NotEqual(MdToPptController.ComputeOutlineHash(Parse("source-a"), "服务"),
            MdToPptController.ComputeOutlineHash(Parse("source-b"), "服务"));
    }

    [Fact]
    public void HistoricalOutline_CanonicalShapeRemainsUnchanged()
    {
        var json = MdToPptController.BuildCanonicalOutlineJson(new[]
        {
            new MdToPptOutlinePageDto { Title = "服务", Bullets = new() { "完整原句" } },
        }, "摘要");
        using var doc = JsonDocument.Parse(json);
        Assert.False(doc.RootElement.GetProperty("outline")[0].TryGetProperty("sourceBlockIds", out _));
    }
}
