using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Controllers.Api.OfficialSkills;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class OfficialSkillCatalogTests
{
    [Fact]
    public void VisualAcceptanceSkill_IsBundledWithVersionAndRequiredFiles()
    {
        var entry = OfficialSkillCatalog.Find("create-visual-test-to-kb");

        Assert.NotNull(entry);
        Assert.Equal("create-visual-test-to-kb", entry.Key);
        Assert.Equal("1.0.0", entry.Version);

        var paths = entry.Files.Select(f => f.Path).ToHashSet(StringComparer.Ordinal);
        Assert.Contains("SKILL.md", paths);
        Assert.Contains("acceptance.config.json", paths);
        Assert.Contains("reference/standard-v2.md", paths);
        Assert.Contains("scripts/harness.mjs", paths);
        Assert.Contains("scripts/archive_report.py", paths);
        Assert.Contains("scripts/verify-open.mjs", paths);
        Assert.Contains("templates/zz-report.md", paths);
        Assert.Contains("templates/report-template.md", paths);
        Assert.DoesNotContain(paths, p => p.StartsWith("scripts/sv-", StringComparison.Ordinal));

        var skillMd = entry.Files.Single(f => f.Path == "SKILL.md").Content;
        Assert.Contains("name: create-visual-test-to-kb", skillMd);
        Assert.Contains("version: 1.0.0", skillMd);
    }

    [Fact]
    public void AcceptancePrerequisiteSkills_AreBundledInOfficialCatalog()
    {
        var design = OfficialSkillCatalog.Find("acceptance-test-design");
        var orchestrator = OfficialSkillCatalog.Find("acceptance-scenario-orchestrator");

        Assert.NotNull(design);
        Assert.Contains(design.Files, f => f.Path == "references/proof-strength.md");
        Assert.Contains(design.Files, f => f.Path == "references/fusion-testing.md");
        Assert.Contains(design.Files, f => f.Path == "references/output-contract.md");

        Assert.NotNull(orchestrator);
        Assert.Contains(orchestrator.Files, f => f.Path == "references/evidence-contract.md");
        Assert.Contains(orchestrator.Files, f => f.Path == "references/scenario-matrix.md");
    }

    [Fact]
    public void VisualAcceptanceOfficialFork_ReturnsDownloadUrlAndVersion()
    {
        var request = BuildRequest("https://map.example.test");
        var config = new ConfigurationBuilder().Build();

        var response = OfficialMarketplaceSkillInjector.BuildForkResponseById(
            "official-create-visual-test-to-kb",
            request,
            config,
            currentUserId: "user-1");

        Assert.NotNull(response);
        Assert.Equal(
            "https://map.example.test/api/official-skills/create-visual-test-to-kb/download",
            Read<string>(response!, "downloadUrl"));
        Assert.Equal("create-visual-test-to-kb.zip", Read<string>(response!, "fileName"));

        var item = ReadObject(response!, "item");
        Assert.Equal("official-create-visual-test-to-kb", Read<string>(item, "Id"));
        Assert.Equal("1.0.0", Read<string>(item, "version"));
    }

    private static HttpRequest BuildRequest(string origin)
    {
        var uri = new Uri(origin);
        var ctx = new DefaultHttpContext();
        ctx.Request.Scheme = uri.Scheme;
        ctx.Request.Host = uri.IsDefaultPort
            ? new HostString(uri.Host)
            : new HostString(uri.Host, uri.Port);
        return ctx.Request;
    }

    private static T Read<T>(object source, string property)
    {
        var value = ReadObject(source, property);
        return Assert.IsType<T>(value);
    }

    private static object ReadObject(object source, string property)
    {
        var value = source.GetType().GetProperty(property)?.GetValue(source);
        Assert.NotNull(value);
        return value;
    }
}
