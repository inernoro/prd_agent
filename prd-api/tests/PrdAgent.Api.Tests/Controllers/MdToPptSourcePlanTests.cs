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

    private static string CapacityFixture(int payloadBlocks = 136)
    {
        var blocks = new List<string>();
        for (var index = 1; index <= 58; index++)
        {
            blocks.Add($"## 条件组 {index}");
            blocks.Add($"条件组 {index} 的负责人、通知记录与限定语必须完整保留。");
        }
        for (var index = 59; index <= payloadBlocks; index++)
            blocks.Add($"独立事实 {index} 的适用对象与限制条件必须完整保留。");
        for (var index = 1; index <= 15; index++)
            blocks.Add("---");
        return string.Join("\n\n", blocks);
    }

    [Fact]
    public void UploadedAttachment_IsFrozenAsSource_WithoutTreatingInstructionAsSource()
    {
        const string attachment = "# 发布条件\n\n- 回滚前必须保留通知记录与负责人。\n- 5% 只是金丝雀示例，不是强制值。";
        var plan = MdToPptSourcePlan.Create(attachment, Array.Empty<DesignKnowledgeSnapshot>());
        Assert.Contains(plan.Blocks, block => block.Markdown.Contains("通知记录与负责人", StringComparison.Ordinal));
        Assert.Contains(plan.Blocks, block => block.Markdown.Contains("不是强制值", StringComparison.Ordinal));
        Assert.DoesNotContain(plan.Blocks, block => block.Markdown.Contains("请做20页", StringComparison.Ordinal));
        var catalog = plan.SerializeCatalog();
        Assert.Equal(plan.Fingerprint, MdToPptSourcePlan.RestoreCatalog(catalog).Fingerprint);
    }

    [Fact]
    public void AutoPageCapacity_UsesPayloadBlocksWithoutDroppingHeadingsOrSeparators()
    {
        var attachment = CapacityFixture();
        var plan = MdToPptSourcePlan.Create(attachment, Array.Empty<DesignKnowledgeSnapshot>());
        Assert.Equal(209, plan.Blocks.Count);
        Assert.Equal(58, plan.Blocks.Count(block => block.Markdown.StartsWith("## 条件组", StringComparison.Ordinal)));
        Assert.Equal(15, plan.Blocks.Count(block => block.Markdown.Trim() == "---"));
        Assert.Equal(136, plan.PayloadBlockCount);
        Assert.Equal(34, plan.RecommendedPageCount(attachment.Length));
        var bound = plan.Bind(Enumerable.Range(0, 34).Select(pageIndex => new MdToPptOutlinePageDto
        {
            Title = $"第 {pageIndex + 1} 页",
            SourceBlockIds = plan.Blocks.Where((_, blockIndex) => blockIndex % 34 == pageIndex)
                .Select(block => block.Id).ToList(),
        }).ToList(), 34);
        Assert.Equal(209, bound.SelectMany(page => page.Blocks).Select(block => block.Id).Distinct().Count());
        Assert.Equal(58, bound.SelectMany(page => page.Blocks).Count(block => block.Markdown.StartsWith("## 条件组", StringComparison.Ordinal)));
        Assert.Equal(15, bound.SelectMany(page => page.Blocks).Count(block => block.Markdown.Trim() == "---"));
        Assert.Equal(34, MdToPptController.ResolveTargetPages(
            new MdToPptOutlineRequest { Content = "完整可读，必要时增加附录", AttachmentText = attachment },
            plan));
        Assert.Equal(22, MdToPptController.ResolveTargetPages(
            new MdToPptOutlineRequest { Content = "严格生成 22 页演示稿", AttachmentText = attachment },
            plan));

        Assert.Equal(23, MdToPptController.ResolveTargetPages(
            new MdToPptOutlineRequest { Content = "严格生成 23 页演示稿", AttachmentText = attachment },
            plan));
        Assert.Equal(41, MdToPptController.ResolveTargetPages(
            new MdToPptOutlineRequest { Content = "严格生成 41 页演示稿", AttachmentText = attachment },
            plan));
    }

    [Fact]
    public void AutoPageSuggestion_DoesNotBecomeAPlatformPageLimit()
    {
        var attachment = CapacityFixture(payloadBlocks: 164);
        var plan = MdToPptSourcePlan.Create(attachment, Array.Empty<DesignKnowledgeSnapshot>());
        Assert.Equal(41, plan.RecommendedPageCount(attachment.Length));
        Assert.Equal(41, MdToPptController.ResolveTargetPages(
            new MdToPptOutlineRequest { Content = "完整可读，必要时增加附录", AttachmentText = attachment },
            plan));
    }

    [Fact]
    public void ThirtyFourPageOutlineAndSinglePagePatch_StayWithinTheValidatedContract()
    {
        var outline = new
        {
            totalPages = 34,
            outline = Enumerable.Range(1, 34).Select(index => new { title = $"第 {index} 页" }).ToArray(),
        };
        var normalized = MdToPptController.NormalizeOutlinePayload(JsonSerializer.Serialize(outline), 34);
        Assert.Equal(34, normalized["outline"]!.AsArray().Count);
        MdToPptController.EnsureOutlinePageCount(34, 34, 34);
        Assert.Equal(34, MdToPptController.ResolvePatchSlideIndex(null, "修改第 34 页标题"));
        Assert.Equal(41, MdToPptController.ResolvePatchSlideIndex(null, "修改第 41 页标题"));
    }

    [Fact]
    public void ManualEditOverlay_PreservesVisibleTextChange_AndRejectsUnknownHiddenOrScriptChanges()
    {
        var plan = MdToPptSourcePlan.Create("# 条件\n\n通知负责人。", Array.Empty<DesignKnowledgeSnapshot>());
        var pages = plan.Bind(new[]
        {
            new MdToPptOutlinePageDto { Title = "条件", SourceBlockIds = plan.Blocks.Select(block => block.Id).ToList() },
        }, 1);
        var frozen = plan.SerializeBound(pages);
        var parent = "<html><body><section class=\"slide\">" + string.Join("", pages[0].Blocks.Select(block =>
            $"<div data-mdppt-source=\"{block.Id}\">{block.Html}</div>")) + "</section><script>next()</script></body></html>";
        var proposal = parent.Replace("通知负责人。", "通知值班负责人。", StringComparison.Ordinal);
        var updated = MdToPptSourcePlan.ApplyManualEditOverlay(frozen, parent, proposal, out var overlayHash);
        Assert.Matches("^[a-f0-9]{64}$", overlayHash);
        var updatedBlock = Assert.Single(
            Assert.Single(MdToPptSourcePlan.RestoreBound(updated)).Blocks,
            block => block.Markdown.Contains("通知值班负责人。", StringComparison.Ordinal));
        Assert.Contains("通知值班负责人。", updatedBlock.Markdown, StringComparison.Ordinal);
        Assert.DoesNotContain("通知负责人。", updatedBlock.Markdown, StringComparison.Ordinal);

        var nonSourceEdit = parent.Replace("class=\"slide\"", "class=\"slide revised\"", StringComparison.Ordinal);
        var unchanged = MdToPptSourcePlan.ApplyManualEditOverlay(frozen, parent, nonSourceEdit, out var unchangedOverlayHash);
        Assert.Equal(
            Assert.Single(MdToPptSourcePlan.RestoreBound(frozen)).Blocks.Select(block => block.Markdown),
            Assert.Single(MdToPptSourcePlan.RestoreBound(unchanged)).Blocks.Select(block => block.Markdown));
        Assert.Matches("^[a-f0-9]{64}$", unchangedOverlayHash);

        var unknown = proposal.Replace("data-mdppt-source=\"", "data-mdppt-source=\"forged-", StringComparison.Ordinal);
        Assert.Equal("manual_edit_source_slot_invalid",
            Assert.Throws<MdToPptSourcePlanException>(() => MdToPptSourcePlan.ApplyManualEditOverlay(frozen, parent, unknown, out _)).Code);
        var hidden = proposal.Replace("<div data-mdppt-source", "<div hidden data-mdppt-source", StringComparison.Ordinal);
        Assert.Equal("manual_edit_source_hidden",
            Assert.Throws<MdToPptSourcePlanException>(() => MdToPptSourcePlan.ApplyManualEditOverlay(frozen, parent, hidden, out _)).Code);
        var script = proposal.Replace("next()", "steal()", StringComparison.Ordinal);
        Assert.Equal("manual_edit_script_changed",
            Assert.Throws<MdToPptSourcePlanException>(() => MdToPptSourcePlan.ApplyManualEditOverlay(frozen, parent, script, out _)).Code);
    }

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
    public void Bind_AllowsSourceFreePages_OnlyWhenBlocksAreFewerThanPages()
    {
        // Codex P1：一段话的稿子、默认 8 页，「每页至少一块、每块只出现一次」无解，每次 source_plan_missing。
        var plan = MdToPptSourcePlan.Create(Sources("只有一段话的稿子，说明本次改造的范围。"));
        var only = Assert.Single(plan.Blocks);
        var pages = new List<MdToPptOutlinePageDto>
        {
            new() { Title = "封面", SourceBlockIds = new() },
            new() { Title = "改造范围", SourceBlockIds = new() { only.Id } },
            new() { Title = "结尾", SourceBlockIds = new() },
        };
        var bound = plan.Bind(pages, 3);
        Assert.Empty(bound[0].Blocks);
        Assert.Single(bound[1].Blocks);
        Assert.NotEqual(bound[0].Hash, bound[2].Hash);

        // 名额恰好是页数减块数：三页全空就是漏了唯一的块。
        pages[1].SourceBlockIds = new();
        Assert.Equal("source_plan_missing", Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 3)).Code);

        // 块不少于页数时，空页照旧拒收。
        var enough = MdToPptSourcePlan.Create(Sources("# 第一\n\n第一事实。\n\n# 第二\n\n第二事实。"));
        var full = enough.Blocks.Select(x => new MdToPptOutlinePageDto { SourceBlockIds = new() { x.Id } }).ToList();
        full[0].SourceBlockIds = new();
        Assert.Equal("source_plan_missing", Assert.Throws<MdToPptSourcePlanException>(() => enough.Bind(full, full.Count)).Code);
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
        // 把第 0 页的块抄到第 3 页：这份输入同时犯了两条——块 0 跨页重复、块 3 没人认领。
        // 四页四块且不许重复时，「漏块」不可能单独出现，所以这一步测不出纯粹的 incomplete；
        // 先报重复是对的，它指着模型真正做错的那一下。纯 incomplete 的覆盖在
        // MdToPptSourcePlanCoverageRepairTests 里（那里页数少于块数，漏块可以单独成立）。
        pages[3].SourceBlockIds = pages[0].SourceBlockIds;
        var bothWrong = Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 4));
        Assert.Equal("source_plan_unknown_block", bothWrong.Code);
        Assert.Contains("只能出现在一页", bothWrong.Message);
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
    public void FirstAndOnlyRetry_SharesSamePlanWithoutDuplicatingSource()
    {
        var (_, page) = OnePage("| 日期 | 名额 |\n|---|---|\n| 周六 | 12 |\n| 周日 | 10 |\n| 周一 | 8 |\n");
        var req = new MdToPptConvertRequest { Content = "用户指令99不是事实", OutlinePages = new() { new() { Title = "活动安排", Design = "表格" } } };
        var user = MdToPptController.BuildAnchoredPageUserPrompt(req, 0, 1, page);
        var retry = MdToPptController.BuildAnchoredPageRetryUserPrompt(user,
            new(MdToPptController.UnsupportedVisibleClaimKind.SourceContentIncomplete));
        foreach (var prompt in new[] { user, retry })
        {
            Assert.Single(Regex.Matches(prompt, page.Hash));
            // 线上标识是短代号，不是 64 位内容寻址 Id——模型抄不全长 Id，
            // 会整轮漏块（source_plan_incomplete）。仍然只许出现一次，不许重复喂源。
            Assert.Single(Regex.Matches(prompt, Regex.Escape(page.Blocks[0].Alias)));
            Assert.DoesNotContain(page.Blocks[0].Id, prompt, StringComparison.Ordinal);
            Assert.DoesNotContain("用户指令99", prompt);
        }
        Assert.StartsWith(user, retry);
    }

    [Fact]
    public void ChildRunOwnsPlan_FinalSaveChecksFrozenIdentityWithoutInspectingOpenDesignDom()
    {
        var sources = Sources("# 介绍\n\n不提供线上报名。\n\n# 活动\n\n每场最多12人。");
        var catalog = MdToPptSourcePlan.Create(sources);
        var pages = catalog.Blocks.Select(x => new MdToPptOutlinePageDto { Title = "用户确认的展示标题", SourceBlockIds = new() { x.Id } }).ToList();
        var frozen = catalog.SerializeCatalog();
        var child = new MdToPptRun { KnowledgeReferences = sources, SourcePlanVersion = 1, SourcePlanPageCount = 4,
            SourcePlanJson = frozen,
            SourcePlanHash = MdToPptSourcePlan.Hash(frozen) };
        var plan = catalog.Bind(pages, pages.Count);
        pages[0].SourceBlockIds!.Clear(); // 模拟父工作稿后续改动，子 Run 不可被影响。
        var anchor = MdToPptAnchors.Resolve("tech-dark")!;
        var sections = plan.Select((p, i) => MdToPptController.NormalizeSlidePageIdentity(
            MdToPptSourcePlan.Fallback(p, i, 4, MdToPptAnchors.PickLayout(anchor, i, 4, null)), i, 4)).ToArray();
        var document = MdToPptController.NormalizePresentationDocument(anchor.Prefix + string.Join("\n", sections) + anchor.Suffix);
        document = Encoding.UTF8.GetString(HostedSiteService.RewritePublishedEntryHtml(Encoding.UTF8.GetBytes(document), "index.html"));
        Assert.True(MdToPptController.ValidateSourcePlanDocument(child, document));
        Assert.True(MdToPptController.ValidateSourcePlanDocument(child, document.Replace("不提供", "提供")));
        Assert.True(MdToPptController.ValidateSourcePlanDocument(child, anchor.Prefix + string.Join("\n", sections.Take(3)) + anchor.Suffix));
        child.SourcePlanHash = "0".PadLeft(64, '0');
        Assert.False(MdToPptController.ValidateSourcePlanDocument(child, document));
        Assert.Contains("用户确认的展示标题", document);
    }

    [Fact]
    public void OpenDesignWiring_FreezesSourceOutlineAndTargetPagesIntoWorkspaceContract()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "prd-api/src/PrdAgent.Api/Controllers/Api/MdToPptController.cs"))) directory = directory.Parent;
        Assert.NotNull(directory);
        var service = File.ReadAllText(Path.Combine(
            directory!.FullName,
            "prd-api/src/PrdAgent.Api/Services/MdToPpt/HtmlPptOpenDesignRunService.cs"));
        var broker = File.ReadAllText(Path.Combine(
            directory.FullName,
            "prd-api/src/PrdAgent.Api/Services/DesignArtifactWorkspaceBroker.cs"));
        var designArtifactsController = File.ReadAllText(Path.Combine(
            directory.FullName,
            "prd-api/src/PrdAgent.Api/Controllers/Api/DesignArtifactsController.cs"));

        Assert.Contains("PresentationInput = new DesignArtifactPresentationInput", service);
        Assert.Contains("SourceContent = input.SourceContent", service);
        Assert.Contains("SourceContentHash = sourceHash", service);
        Assert.Contains("OutlineJson = input.OutlineJson", service);
        Assert.Contains("OutlineHash = outlineHash", service);
        Assert.Contains("SourcePlanJson = input.SourcePlanJson", service);
        Assert.Contains("SourcePlanHash = input.SourcePlanHash", service);
        Assert.Contains("TargetPages = input.TargetPages", service);
        Assert.Contains("ParentPackageHash = input.ParentPackageHash", service);
        Assert.Contains("ManualEditHtml = manualEditHtml", service);
        Assert.Contains("ManualEditHtmlHash = manualEditHtmlHash", service);
        Assert.Contains("FileName = \"presentation-source.md\"", service);
        Assert.Contains("\"source/presentation.md\"", broker);
        Assert.Contains("\"brief/outline.json\"", broker);
        Assert.Contains("\"brief/source-plan.json\"", broker);
        Assert.Contains("requiredSlideIndexes = Enumerable.Range(1, run.PresentationInput.TargetPages)", broker);
        Assert.Contains("\"proposal/manual-edit.html\"", broker);
        Assert.Contains("PresentationInput = ClonePresentationInput(source.PresentationInput)", designArtifactsController);
        Assert.Contains("RepairCandidateHtml = source.RepairCandidateHtml", designArtifactsController);
        Assert.Contains("RepairCandidateHtmlHash = source.RepairCandidateHtmlHash", designArtifactsController);
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

/// <summary>
/// 知识驱动大纲的输出契约守卫。
///
/// 背景（2026-09-14 真实故障）：两条大纲提示词的 JSON/JSONL 格式示例都写在 system 段，
/// 而「每页必须输出 sourceBlockIds」只追加在 user 段末尾的冻结来源目录里。模型照抄 system
/// 段的示例，产出的大纲页一律没有 sourceBlockIds，于是每一次知识驱动 PPT 生成都在
/// <see cref="MdToPptSourcePlan.Bind"/> 里抛 source_plan_missing —— 编译过、测试全绿、
/// 通读提示词也挑不出毛病，只有真跑一次才显形（判据与接线纪律 形状 2：链路只建一半）。
///
/// 提示词是方法体里拼出来的局部串，拿不到实例，只能扫源码确认这条线接上了。
/// 断言的是「两处 system 段都追加了同一个契约常量」这件接线事实，不是某段措辞的字面存在。
/// </summary>
public class MdToPptOutlineSourcePlanContractTests
{
    private static string ControllerSource()
    {
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 10 && dir != null; i++)
        {
            var candidate = Path.Combine(dir, "src", "PrdAgent.Api", "Controllers", "Api", "MdToPptController.cs");
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            dir = Path.GetDirectoryName(dir);
        }
        throw new FileNotFoundException("找不到 MdToPptController.cs，守卫无法取证——不要把这当成通过");
    }

    [Fact]
    public void OutlinePrompt_ProvidesFrozenMaterialWithoutPlatformSlotIdentifiers()
    {
        // Bind 缺这个字段就抛 source_plan_missing，契约文案必须点名同一个字段。
        var plan = MdToPptSourcePlan.Create(new List<DesignKnowledgeSnapshot>
        {
            new() { StoreId = "s", EntryId = "e", Content = "# 标题\n\n正文一句话。\n", ContentHash = MdToPptSourcePlan.Hash("# 标题\n\n正文一句话。\n") },
        });
        var prompt = plan.OutlinePrompt();
        Assert.Contains("服务端冻结来源材料", prompt, StringComparison.Ordinal);
        Assert.Contains("markdown", prompt, StringComparison.Ordinal);
        Assert.DoesNotContain("sourceBlockIds", prompt, StringComparison.Ordinal);
        Assert.DoesNotContain(plan.Blocks[0].Id, prompt, StringComparison.Ordinal);
        Assert.DoesNotContain(plan.Blocks[0].Alias, prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void BothOutlineEndpoints_DoNotInjectASourceSlotOutputContract()
    {
        var source = ControllerSource();
        Assert.DoesNotContain("SourcePlanOutlineContract", source, StringComparison.Ordinal);
        Assert.DoesNotContain("sourcePlan.RepairCoverage", source, StringComparison.Ordinal);
        Assert.DoesNotContain("WriteBackSourceBlockIds(payload", source, StringComparison.Ordinal);
    }
}

/// <summary>
/// 来源覆盖补齐。模型每几轮就会漏掉一两个来源块，整份大纲被 Bind 判死，
/// 用户拿到一个自己修不了的 422。补齐是确定性的：漏掉的块按原文顺序跟到
/// 前一个已认领块所在页，不新增也不改写任何事实。
/// </summary>
public class MdToPptSourcePlanCoverageRepairTests
{
    private const string Doc = "# 标题\n\n## 一节\n\n一节正文。\n\n## 二节\n\n二节正文。\n";

    private static MdToPptSourcePlan Plan() => MdToPptSourcePlan.Create(new List<DesignKnowledgeSnapshot>
    {
        new() { StoreId = "s", EntryId = "e", Content = Doc, ContentHash = MdToPptSourcePlan.Hash(Doc) },
    });

    [Fact]
    public void MissingBlocks_AttachToThePrecedingPage_AndBindThenPasses()
    {
        var plan = Plan();
        Assert.Equal(5, plan.Blocks.Count);

        // 模型只认领了第 1、3 个块，漏了 2、4、5（真实失败形态）。
        var pages = new List<MdToPptOutlinePageDto>
        {
            new() { Title = "封面", SourceBlockIds = new List<string> { plan.Blocks[0].Alias } },
            new() { Title = "正文", SourceBlockIds = new List<string> { plan.Blocks[2].Alias } },
        };
        var incomplete = Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 2));
        Assert.Equal("source_plan_incomplete", incomplete.Code);

        plan.RepairCoverage(pages);
        var bound = plan.Bind(pages, 2);

        // 补齐后每个块都落在某一页，且顺序与原文一致：块2 跟块1（封面），块4、5 跟块3（正文）。
        Assert.Equal(new[] { plan.Blocks[0].Id, plan.Blocks[1].Id }, bound[0].Blocks.Select(x => x.Id));
        Assert.Equal(new[] { plan.Blocks[2].Id, plan.Blocks[3].Id, plan.Blocks[4].Id }, bound[1].Blocks.Select(x => x.Id));
    }

    /// <summary>
    /// 补回去的块要插在它在原文里该在的位置，不能一律追加到页尾。
    /// 追加会让「认领了 b1、b3 而漏了 b2」变成 b1,b3,b2，Bind 原样保留这个顺序，
    /// 于是正文渲染到了下一节标题后面——与 RepairCoverage 自己承诺的「按原文顺序」相反
    /// （Codex P2，2026-09-16）。
    /// </summary>
    [Fact]
    public void RepairedBlockLandsInDocumentOrder_NotAppendedAfterALaterClaimedBlock()
    {
        var plan = Plan();
        // 一页认领了块1 与块3，漏掉中间的块2；块4、块5 在另一页。
        var pages = new List<MdToPptOutlinePageDto>
        {
            new() { Title = "一", SourceBlockIds = new List<string> { plan.Blocks[0].Alias, plan.Blocks[2].Alias } },
            new() { Title = "二", SourceBlockIds = new List<string> { plan.Blocks[3].Alias, plan.Blocks[4].Alias } },
        };

        plan.RepairCoverage(pages);
        var bound = plan.Bind(pages, 2);

        Assert.Equal(
            new[] { plan.Blocks[0].Id, plan.Blocks[1].Id, plan.Blocks[2].Id },
            bound[0].Blocks.Select(x => x.Id));
        Assert.Equal(new[] { plan.Blocks[3].Id, plan.Blocks[4].Id }, bound[1].Blocks.Select(x => x.Id));
    }

    /// <summary>
    /// 漏掉的块排在全部认领块之前时，要插到页首而不是页尾：
    /// 页上第一个认领的是块3，追加会得到 b3,b1,b2。
    /// </summary>
    [Fact]
    public void BlocksBeforeEveryClaimedBlockGoToTheFrontOfThePage()
    {
        var plan = Plan();
        var pages = new List<MdToPptOutlinePageDto>
        {
            new() { Title = "一", SourceBlockIds = new List<string> { plan.Blocks[2].Alias } },
            new() { Title = "二", SourceBlockIds = new List<string> { plan.Blocks[3].Alias, plan.Blocks[4].Alias } },
        };

        plan.RepairCoverage(pages);
        var bound = plan.Bind(pages, 2);

        Assert.Equal(
            new[] { plan.Blocks[0].Id, plan.Blocks[1].Id, plan.Blocks[2].Id },
            bound[0].Blocks.Select(x => x.Id));
        Assert.Equal(new[] { plan.Blocks[3].Id, plan.Blocks[4].Id }, bound[1].Blocks.Select(x => x.Id));
    }

    [Fact]
    public void AlreadyComplete_RepairChangesNothing()
    {
        var plan = Plan();
        var pages = new List<MdToPptOutlinePageDto>
        {
            new() { Title = "一", SourceBlockIds = plan.Blocks.Select(x => x.Alias).ToList() },
        };
        var before = pages[0].SourceBlockIds!.ToList();
        plan.RepairCoverage(pages);
        Assert.Equal(before, pages[0].SourceBlockIds);
    }

    [Fact]
    public void ModelEmittedNothing_StaysAHardFailure_NotSilentlyAutoFilled()
    {
        // 一个块都没认领时不猜：那是模型整体没照格式走，补齐会把「彻底失败」伪装成「成功」。
        var plan = Plan();
        var pages = new List<MdToPptOutlinePageDto> { new() { Title = "一" } };
        plan.RepairCoverage(pages);
        Assert.Null(pages[0].SourceBlockIds);
        Assert.Equal("source_plan_missing", Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 1)).Code);
    }
}

/// <summary>
/// 版式必须配得上内容。
///
/// 背景（2026-09-14 用户看完产物："巨丑无比"）：PickLayout 只按页序轮换
/// （pool[(index-1) % pool.Count]），不问这一页的内容撑不撑得起那个版式。
/// 于是一页只有「验收标准」四个字 + 一句话，却轮到了大数字＋柱状图版式；
/// 模型无数可填，只好把标题重复灌进每一个槽，90px 的标题撑爆容器、
/// 柱状图全是装饰性假数据——编译过、测试绿、提示词也挑不出毛病，
/// 只有把那一页投到屏幕上才看得见。
/// </summary>
public class MdToPptAnchorLayoutFitnessTests
{
    private static MdToPptAnchors.AnchorSlide Slide(string layout) => new("f.html", layout, "slide", "", "<div></div>");

    [Fact]
    public void DataLayout_NeedsRealNumbers()
    {
        var noNumbers = MdToPptAnchors.PageShape.FromText(
            new[] { "用户只需选知识、说两句话，最后拿到一个已保存、能再次打开的完整网页。" }, null);
        Assert.False(MdToPptAnchors.Fits(Slide("s-data"), noNumbers));

        var withNumbers = MdToPptAnchors.PageShape.FromText(
            new[] { "开信率 82%", "季度环比增长 14%", "样本 1200 人" }, null);
        Assert.True(MdToPptAnchors.Fits(Slide("s-data"), withNumbers));
    }

    [Fact]
    public void IndexLayout_NeedsSeveralItems()
    {
        var one = MdToPptAnchors.PageShape.FromText(new[] { "只有一条" }, null);
        Assert.False(MdToPptAnchors.Fits(Slide("s-index"), one));
        var three = MdToPptAnchors.PageShape.FromText(new[] { "一", "二", "三" }, null);
        Assert.True(MdToPptAnchors.Fits(Slide("s-index"), three));
    }

    [Fact]
    public void ManifestoLayout_NeedsOneShortLine()
    {
        var wall = MdToPptAnchors.PageShape.FromText(
            new[] { "统一入口负责权限、模型选择与版本；隔离运行时负责会话与工作区；设计编排器负责拆解任务与把关版式。" }, null);
        Assert.False(MdToPptAnchors.Fits(Slide("s-manifesto"), wall));
        var oneLiner = MdToPptAnchors.PageShape.FromText(new[] { "替换成本低，才用得久。" }, null);
        Assert.True(MdToPptAnchors.Fits(Slide("s-manifesto"), oneLiner));
    }

    [Fact]
    public void HeadingsAreNotItems()
    {
        // 「## 三个角色」是下面那段的名字，不是一条内容。算进条数就会把
        // 「一段话」误判成「好几条」，清单版式又会发给撑不起它的页。
        var content = "统一入口负责权限、模型选择与版本；隔离运行时负责会话与工作区；设计编排器负责拆解任务与把关版式。";
        var doc = "## 三个角色\n\n" + content + "\n";
        var plan = MdToPptSourcePlan.Create(new List<DesignKnowledgeSnapshot>
        {
            new() { StoreId = "s", EntryId = "e", Content = doc, ContentHash = MdToPptSourcePlan.Hash(doc) },
        });
        var page = plan.Bind(new[]
        {
            new MdToPptOutlinePageDto { Title = "三个角色", SourceBlockIds = plan.Blocks.Select(x => x.Alias).ToList() },
        }, 1)[0];

        var shape = MdToPptController.ShapeOf(new MdToPptOutlinePageDto { Title = "三个角色" }, page);
        Assert.Equal(1, shape.ItemCount);
        Assert.False(MdToPptAnchors.Fits(Slide("s-index"), shape));
    }

    [Fact]
    public void PickLayout_SkipsLayoutsTheContentCannotFill()
    {
        var anchor = new MdToPptAnchors.Anchor("t", "", "", new[]
        {
            Slide("s-cover"), Slide("s-manifesto"), Slide("s-index"), Slide("s-chapter"),
            Slide("s-data"), Slide("s-colophon"),
        });
        var thin = MdToPptAnchors.PageShape.FromText(new[] { "用户只需选知识、说两句话，最后拿到一个能再次打开的完整网页。" }, null);

        // 轮换本来会在第 4 页撞上 s-data；内容没有数字，必须被跳过。
        for (var i = 1; i <= 4; i++)
        {
            var picked = MdToPptAnchors.PickLayout(anchor, i, 6, designIntent: null, shape: thin);
            Assert.NotEqual("s-data", picked.Layout);
            Assert.NotEqual("s-index", picked.Layout);
        }

        // 意图说「数据」也不能凌驾于内容：这页依然没有数字。
        Assert.NotEqual("s-data", MdToPptAnchors.PickLayout(anchor, 2, 6, "数据看板", thin).Layout);
        // 有数字时才轮得到它。
        var numeric = MdToPptAnchors.PageShape.FromText(new[] { "开信率 82%", "样本 1200 人" }, null);
        Assert.Equal("s-data", MdToPptAnchors.PickLayout(anchor, 2, 6, "数据看板", numeric).Layout);
    }

    [Fact]
    public void Fallback_IsNotAnUnstyledDump()
    {
        var doc = "# 知识驱动内容生成体系\n";
        var plan = MdToPptSourcePlan.Create(new List<DesignKnowledgeSnapshot>
        {
            new() { StoreId = "s", EntryId = "e", Content = doc, ContentHash = MdToPptSourcePlan.Hash(doc) },
        });
        var page = plan.Bind(new[]
        {
            // 用真实内容标题：「封面」那类版面角色名有另一条规则专门管（见
            // MdToPptStructuralLabelTests），这里测的是排版。
            new MdToPptOutlinePageDto { Title = "三个角色", SourceBlockIds = plan.Blocks.Select(x => x.Alias).ToList() },
        }, 1)[0];
        var html = MdToPptSourcePlan.Fallback(page, 0, 6);

        // 兜底页照样会被投出去给人看：标题必须是展示字号，内容必须居中限宽，
        // 不能再是「padding 5% + 全局 20px」那种左上角堆成一坨的裸排。
        Assert.Contains("clamp(40px,5.4vw,92px)", html, StringComparison.Ordinal);
        Assert.Contains("justify-content:center", html, StringComparison.Ordinal);
        Assert.Contains("max-width:76ch", html, StringComparison.Ordinal);
        Assert.DoesNotContain("font-size:20px", html, StringComparison.Ordinal);
        Assert.Contains("三个角色", html, StringComparison.Ordinal);
    }
}

/// <summary>
/// 知识驱动时，判断一页内容多不多只能看服务端冻结的来源块，不能看大纲要点——
/// 要点是排版计划，一个字都不落到幻灯片上。把要点算进来，就会拿「三条要点」
/// 去判一页「其实只有一个小标题」的内容撑得起编号清单版式，结果清单里只有一条，
/// 同一句话被眉标／条目标题／条目正文重复三遍。
/// </summary>
public class MdToPptShapeIgnoresOutlineBulletsTests
{
    [Fact]
    public void KnowledgeDriven_BulletsDoNotCountAsPageContent()
    {
        const string doc = "## 为什么强调可替换\n";
        var plan = MdToPptSourcePlan.Create(new List<DesignKnowledgeSnapshot>
        {
            new() { StoreId = "s", EntryId = "e", Content = doc, ContentHash = MdToPptSourcePlan.Hash(doc) },
        });
        var page = plan.Bind(new[]
        {
            new MdToPptOutlinePageDto { Title = "系统优势", SourceBlockIds = plan.Blocks.Select(x => x.Alias).ToList() },
        }, 1)[0];

        // 大纲给了三条要点，但这一页真正会渲染的只有一个小标题。
        var outline = new MdToPptOutlinePageDto
        {
            Title = "系统优势",
            Bullets = new List<string> { "设计器可随时更换", "业务入口不变", "低替换成本" },
        };

        var knowledgeDriven = MdToPptController.ShapeOf(outline, page);
        Assert.Equal(0, knowledgeDriven.ItemCount);
        Assert.False(MdToPptAnchors.Fits(new MdToPptAnchors.AnchorSlide("f", "s-index", "slide", "", "<div></div>"), knowledgeDriven));

        // 非知识驱动（没有冻结来源）时，要点就是这一页的内容，照常算。
        var bulletsOnly = MdToPptController.ShapeOf(outline, null);
        Assert.Equal(3, bulletsOnly.ItemCount);
        Assert.True(MdToPptAnchors.Fits(new MdToPptAnchors.AnchorSlide("f", "s-index", "slide", "", "<div></div>"), bulletsOnly));
    }
}

/// <summary>
/// 「封面」「结语」是版面角色的名字，不是内容标题。大纲提示词的格式示例就写着
/// {"title":"封面"}，模型照抄，于是第一页最大的那行字是「封面」两个字，
/// 真正的标题缩在下面——第一眼就废了，卡片缩略图用的也是这一页。
/// </summary>
public class MdToPptStructuralLabelTests
{
    [Theory]
    [InlineData("封面")]
    [InlineData("结语")]
    [InlineData("Cover")]
    [InlineData("谢谢观看")]
    [InlineData("致谢：")]
    public void StructuralLabels_AreNotContentTitles(string title) =>
        Assert.True(MdToPptSourcePlan.IsStructuralLabel(title));

    [Theory]
    [InlineData("三个角色")]
    [InlineData("为什么强调可替换")]
    [InlineData("知识驱动内容生成体系")]
    public void RealTitles_AreKept(string title) =>
        Assert.False(MdToPptSourcePlan.IsStructuralLabel(title));

    [Fact]
    public void CoverFallback_DoesNotPrintTheWordCoverAsHeadline()
    {
        const string doc = "# 知识驱动内容生成体系\n";
        var plan = MdToPptSourcePlan.Create(new List<DesignKnowledgeSnapshot>
        {
            new() { StoreId = "s", EntryId = "e", Content = doc, ContentHash = MdToPptSourcePlan.Hash(doc) },
        });
        var page = plan.Bind(new[]
        {
            new MdToPptOutlinePageDto { Title = "封面", SourceBlockIds = plan.Blocks.Select(x => x.Alias).ToList() },
        }, 1)[0];
        var html = MdToPptSourcePlan.Fallback(page, 0, 6);

        Assert.DoesNotContain("封面", html, StringComparison.Ordinal);
        // 真正的标题还在：封面那一页的首个来源块就是文档大标题。
        Assert.Contains("知识驱动内容生成体系", html, StringComparison.Ordinal);

        // 内容标题照常印。
        var real = plan.Bind(new[]
        {
            new MdToPptOutlinePageDto { Title = "三个角色", SourceBlockIds = plan.Blocks.Select(x => x.Alias).ToList() },
        }, 1)[0];
        Assert.Contains("三个角色", MdToPptSourcePlan.Fallback(real, 1, 6), StringComparison.Ordinal);
    }
}

/// <summary>
/// 收尾页也要过内容这一关。原来 PickLayout 对最后一页无条件返回 Closing，
/// 而 colophon 是四栏版权页：内容只有一句话时，模型拿展示标题把另外三栏
/// 挨个填满——实测一页上「结语」出现了六次。
/// </summary>
public class MdToPptClosingLayoutFitnessTests
{
    private static MdToPptAnchors.AnchorSlide Slide(string layout) => new("f.html", layout, "slide", "", "<div></div>");

    private static MdToPptAnchors.Anchor Anchor() => new("t", "", "", new[]
    {
        Slide("s-cover"), Slide("s-chapter"), Slide("s-manifesto"), Slide("s-colophon"),
    });

    [Fact]
    public void ThinClosingPage_DoesNotGetTheMultiColumnColophon()
    {
        var oneSentence = MdToPptAnchors.PageShape.FromText(
            new[] { "用户只需选知识、说两句话，最后拿到一个已保存、能再次打开的完整网页。" }, null);
        Assert.False(MdToPptAnchors.Fits(Slide("s-colophon"), oneSentence));
        Assert.NotEqual("s-colophon", MdToPptAnchors.PickLayout(Anchor(), 5, 6, null, oneSentence).Layout);
    }

    [Fact]
    public void RichClosingPage_StillGetsIt()
    {
        var many = MdToPptAnchors.PageShape.FromText(
            new[] { "编辑：林", "设计：伊藤", "校对：安雅", "出版：2026 秋" }, null);
        Assert.True(MdToPptAnchors.Fits(Slide("s-colophon"), many));
        Assert.Equal("s-colophon", MdToPptAnchors.PickLayout(Anchor(), 5, 6, null, many).Layout);
    }

    [Fact]
    public void WithoutShape_BehaviourIsUnchanged()
    {
        // 非知识驱动、拿不到内容形状时不改变既有行为：收尾页还是收尾页。
        Assert.Equal("s-colophon", MdToPptAnchors.PickLayout(Anchor(), 5, 6, null).Layout);
    }
}

/// <summary>
/// 来源块的归属契约：每个块恰好属于一页，而且补齐的结果必须让前端也拿到。
///
/// 两条都属于「不报错、只是悄悄不对」的形状：跨页重复时 Bind 照样通过，两页各自把
/// 同一份权威原文渲染一遍；补齐只改落库那一份时流程照常走完，直到用户点确认才吃一个
/// 对不上的 422。
/// </summary>
public class MdToPptSourceBindingOwnershipTests
{
    private const string Doc = "# 标题\n\n## 一节\n\n一节正文。\n\n## 二节\n\n二节正文。\n";

    private static MdToPptSourcePlan Plan() => MdToPptSourcePlan.Create(new List<DesignKnowledgeSnapshot>
    {
        new() { StoreId = "s", EntryId = "e", Content = Doc, ContentHash = MdToPptSourcePlan.Hash(Doc) },
    });

    private static List<MdToPptOutlinePageDto> Pages(MdToPptSourcePlan plan, params string[][] perPage) =>
        perPage.Select(ids => new MdToPptOutlinePageDto
        {
            Title = "页",
            SourceBlockIds = ids.ToList(),
        }).ToList();

    [Fact]
    public void SameBlockOnTwoPages_IsRejected()
    {
        var plan = Plan();
        var all = plan.Blocks.Select(x => x.Alias).ToArray();

        // 每个块都被覆盖过（数量校验满足），但块 0 同时出现在两页。
        var pages = Pages(plan,
            all.Take(3).ToArray(),
            all.Skip(3).Concat(new[] { all[0] }).ToArray());

        var error = Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 2));
        Assert.Equal("source_plan_unknown_block", error.Code);
        Assert.Contains("只能出现在一页", error.Message);
    }

    [Fact]
    public void SameBlockWrittenAsAliasOnOnePageAndIdOnAnother_IsAlsoRejected()
    {
        var plan = Plan();
        var all = plan.Blocks.Select(x => x.Alias).ToArray();

        // 换个写法不改变它是同一个块：判据按内容寻址 Id 算，不看字面。
        var pages = Pages(plan,
            all.Take(3).ToArray(),
            all.Skip(3).Concat(new[] { plan.Blocks[0].Id }).ToArray());

        Assert.Throws<MdToPptSourcePlanException>(() => plan.Bind(pages, 2));
    }

    [Fact]
    public void EachBlockOnExactlyOnePage_StillPasses()
    {
        var plan = Plan();
        var all = plan.Blocks.Select(x => x.Alias).ToArray();

        var bound = plan.Bind(Pages(plan, all.Take(3).ToArray(), all.Skip(3).ToArray()), 2);

        Assert.Equal(3, bound[0].Blocks.Count);
        Assert.Equal(plan.Blocks.Count - 3, bound[1].Blocks.Count);
    }

    [Fact]
    public void OutlinePromptLeavesPageGroupingToOpenDesignWithoutExposingIds()
    {
        var plan = Plan();
        var prompt = plan.OutlinePrompt();
        Assert.Contains("自行规划页数与结构", prompt, StringComparison.Ordinal);
        Assert.DoesNotContain("每个ID只能出现在一页", prompt, StringComparison.Ordinal);
        Assert.All(plan.Blocks, block => Assert.DoesNotContain(block.Id, prompt, StringComparison.Ordinal));
    }

    [Fact]
    public void RepairedPages_AreTheOnesReportedAsChanged()
    {
        var plan = Plan();
        var before = Pages(plan,
            new[] { plan.Blocks[0].Alias },
            new[] { plan.Blocks[2].Alias });
        var after = Pages(plan,
            new[] { plan.Blocks[0].Alias },
            new[] { plan.Blocks[2].Alias });
        plan.RepairCoverage(after);

        // 两页都被补齐动过（块1 跟到第一页，块3、4 跟到第二页），两页都要重发。
        Assert.Equal(new[] { 0, 1 }, MdToPptController.ChangedSourceBindingPages(before, after));
    }

    [Fact]
    public void UntouchedPages_AreNotReportedAsChanged()
    {
        var plan = Plan();
        var all = plan.Blocks.Select(x => x.Alias).ToArray();
        var before = Pages(plan, all.Take(3).ToArray(), all.Skip(3).ToArray());
        var after = Pages(plan, all.Take(3).ToArray(), all.Skip(3).ToArray());
        plan.RepairCoverage(after);

        // 模型本来就写全了，补齐不该动任何一页——重发没变的页只会让前端白闪一下。
        Assert.Empty(MdToPptController.ChangedSourceBindingPages(before, after));
    }

    [Fact]
    public void OutlineStream_DoesNotPostRepairSourceAssignmentsBeforeDone()
    {
        var source = File.ReadAllText(LocateController());
        Assert.DoesNotContain("foreach (var index in repairedPages)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ChangedSourceBindingPages(beforeRepair", source, StringComparison.Ordinal);
        Assert.Contains("WriteEventAsync(\"done\", new { pages = emittedPages", source, StringComparison.Ordinal);
    }

    private static string LocateController()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "prd-api", "src")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var path = Path.Combine(
            directory!.FullName, "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "MdToPptController.cs");
        Assert.True(File.Exists(path), $"找不到 {path}");
        return path;
    }

    [Fact]
    public void ReorderWithinAPage_CountsAsChanged()
    {
        var plan = Plan();
        var all = plan.Blocks.Select(x => x.Alias).ToArray();
        var before = Pages(plan, new[] { all[0], all[1] });
        var after = Pages(plan, new[] { all[1], all[0] });

        // 顺序就是正文的渲染顺序，换了序前端手里那份就不再等于库里那份。
        Assert.Equal(new[] { 0 }, MdToPptController.ChangedSourceBindingPages(before, after));
    }
}
