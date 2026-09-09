using System.Text.Json;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class MdToPptTableCapabilityTests
{
    public static TheoryData<string, string> Themes => new()
    {
        { "tech-dark", "cyber-terminal" }, { "cobalt-grid", "cobalt-grid" },
        { "warm-zine", "retro-zine" }, { "atelier-zero", "coral" },
        { "swiss-minimal", "monochrome" }, { "forest-organic", "grove" },
        { "sunset-bold", "bold-poster" }, { "editorial-ink", "soft-editorial" },
        { "kami-paper", "vellum" }, { "aurora-gradient", "dark-graph" },
        { "royal-velvet", "vellum" }, { "ocean-glass", "soft-editorial" },
    };

    [Theory]
    [MemberData(nameof(Themes))]
    public void OfficialTheme_ExplicitTableHasActualSemanticStructureAndPreservesTheme(string theme, string name)
    {
        var anchor = MdToPptAnchors.Resolve(theme)!;
        Assert.Equal(name, anchor.Name);
        if (name == "soft-editorial") Assert.DoesNotContain("data-mdppt-semantic-table", anchor.Prefix);
        else
        {
            Assert.Contains("data-mdppt-semantic-table", anchor.Prefix);
            Assert.Contains("var(--hc-bg, var(--gd-bg, var(--c-bg, var(--cream, transparent))))", anchor.Prefix);
            Assert.Contains("var(--c-fg, inherit)", anchor.Prefix);
        }
        var table = MdToPptAnchors.PickLayout(anchor, 3, 4, "版式结构：表格；日期、时间、主题、总名额和剩余名额表格，突出表格数据");
        Assert.Equal("s-table", table.Layout);
        Assert.Contains("<table", table.Html);
        Assert.Contains("<thead", table.Html);
        Assert.Contains("<tbody", table.Html);
        Assert.Contains("scope=\"col\"", table.Html);
        Assert.Equal(table, MdToPptAnchors.PickLayout(anchor, 1, 4, "table"));
        Assert.Equal(anchor.Cover, MdToPptAnchors.PickLayout(anchor, 0, 4, "表格"));
        Assert.Equal(anchor.Closing, MdToPptAnchors.PickLayout(anchor, 3, 4, null));
        Assert.Equal(anchor.Closing, MdToPptAnchors.PickLayout(anchor, 3, 4, "未指定版式"));

        using var meta = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
            "Resources", "mdppt", "anchors", name, "meta.json")));
        var original = meta.RootElement.GetProperty("layouts").EnumerateArray().ToArray();
        Assert.Equal(original[0].GetProperty("file").GetString(), anchor.Cover.File);
        Assert.Equal(original[^1].GetProperty("file").GetString(), anchor.Closing.File);
        var rotation = original.Skip(1).Take(original.Length - 2)
            .Where(l => l.GetProperty("layout").GetString() != "s-table").ToArray();
        for (var i = 1; i <= rotation.Length * 2; i++)
            Assert.Equal(rotation[(i - 1) % rotation.Length].GetProperty("file").GetString(),
                MdToPptAnchors.PickLayout(anchor, i, 100, null).File);
    }

    [Fact]
    public void DefaultTheme_TableSystemPromptReceivesTableInsteadOfClosingAndUsesExistingTableContract()
    {
        var anchor = MdToPptAnchors.Resolve(null)!;
        Assert.Equal("cyber-terminal", anchor.Name);
        var table = MdToPptAnchors.PickLayout(anchor, 3, 4, "表格数据");
        var prompt = MdToPptController.BuildAnchoredPageSystemPrompt(anchor, table, 3, 4);
        Assert.Contains("<table", prompt);
        Assert.DoesNotContain("// thanks", prompt);
        Assert.Contains("thead", prompt);
        Assert.Contains("tbody", prompt);
        Assert.Contains("本页以完整语义表格", prompt);
        Assert.Contains("data-mdppt-semantic-table", anchor.Prefix);
        var wire = MdToPptController.BuildGatewayPageRequest(
            new PrdAgent.Core.Models.InfraAgentRuntimeProfile(), prompt, "合成表格任务", "test.table::chat");
        var transmittedSystem = wire.RequestBody!["messages"]![0]!["content"]!.GetValue<string>();
        Assert.Equal(prompt, transmittedSystem);
        Assert.Contains(table.Html, transmittedSystem);
        var assembled = anchor.Prefix + MdToPptController.AddActiveToFirstSlide(table.Html) + anchor.Suffix;
        Assert.Contains("slide mdppt-semantic-table active is-active", assembled);
    }

    [Fact]
    public void MissingSemanticCapability_IsExplicitRatherThanAClosingOrDivImitation()
    {
        var cover = new MdToPptAnchors.AnchorSlide("cover", "cover", "slide", "", "<section>cover</section>");
        var fakeTable = new MdToPptAnchors.AnchorSlide("fake", "s-table", "slide", "", "<section><div>grid</div></section>");
        var close = cover with { File = "closing", Layout = "closing" };
        var missing = new MdToPptAnchors.Anchor("external", "", "", new[] { cover, fakeTable, close });
        Assert.Throws<NotSupportedException>(() => MdToPptAnchors.PickLayout(missing, 2, 3, "table"));
        Assert.Equal(close, MdToPptAnchors.PickLayout(missing, 2, 3, null));
    }
}
