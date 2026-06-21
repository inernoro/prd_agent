using System.IO.Compression;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Controllers.Api.OfficialSkills;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class OfficialSkillCatalogTests
{
    [Fact]
    public void AiDefectResolveOfficialTemplate_StatesDailyAutomationContract()
    {
        Assert.Equal("1.7.0", OfficialSkillTemplates.AiDefectResolveVersion);
        Assert.Contains("本技能的主目标是自动化闭环", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("日常执行缺少 domain 或 K 时停止", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("scope.type == daily-next", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("defect_resolution_traces", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("defect-agent-workflow.v1", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("agent/workflow/start-next", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("agent/workflow/complete", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("agent/workflow/block", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("发布中心只读取 commit id 关联结果并展示", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("不允许按日期批量贴缺陷标志", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("scripts/defect-automation-probe.mjs", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("hasNext=false", OfficialSkillTemplates.AiDefectResolveSkillMd);
    }

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
        Assert.Contains(design.Files, f => f.Path == "scripts/daily_scope.py");
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

    [Fact]
    public void VisualAcceptanceOfficialDownload_IncludesPrerequisiteSkills()
    {
        var controller = BuildOfficialSkillsController();

        var result = controller.Download("create-visual-test-to-kb");
        var file = Assert.IsType<FileContentResult>(result);

        using var ms = new MemoryStream(file.FileContents);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);
        var names = zip.Entries.Select(e => e.FullName).ToHashSet(StringComparer.Ordinal);

        Assert.Contains("create-visual-test-to-kb/SKILL.md", names);
        Assert.Contains("acceptance-test-design/SKILL.md", names);
        Assert.Contains("acceptance-test-design/scripts/daily_scope.py", names);
        Assert.Contains("acceptance-scenario-orchestrator/SKILL.md", names);
        Assert.Contains("acceptance-test-design/references/proof-strength.md", names);
        Assert.Contains("acceptance-scenario-orchestrator/references/evidence-contract.md", names);
        Assert.DoesNotContain(names, n => n.Contains("/scripts/sv-", StringComparison.Ordinal));
    }

    [Fact]
    public void VisualAcceptanceOfficialDownload_ContainsDailyAutomationGuards()
    {
        var controller = BuildOfficialSkillsController();

        var result = controller.Download("create-visual-test-to-kb");
        var file = Assert.IsType<FileContentResult>(result);

        using var ms = new MemoryStream(file.FileContents);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);

        var verifyOpen = ReadZipText(zip, "create-visual-test-to-kb/scripts/verify-open.mjs");
        Assert.Contains("VERIFY_OPEN_MAX_ATTEMPTS || '3'", verifyOpen);
        Assert.Contains("VERIFY_OPEN_SETTLE_TIMEOUT_MS", verifyOpen);

        var archiveReport = ReadZipText(zip, "create-visual-test-to-kb/scripts/archive_report.py");
        Assert.Contains("改动规模与深度预算", archiveReport);
        Assert.Contains("标记法则与验收标准", archiveReport);
        Assert.Contains("未发布状态", archiveReport);
    }

    [Fact]
    public void ScenarioOrchestratorOfficialDownload_IncludesTestDesignDependency()
    {
        var controller = BuildOfficialSkillsController();

        var result = controller.Download("acceptance-scenario-orchestrator");
        var file = Assert.IsType<FileContentResult>(result);

        using var ms = new MemoryStream(file.FileContents);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);
        var names = zip.Entries.Select(e => e.FullName).ToHashSet(StringComparer.Ordinal);

        Assert.Contains("acceptance-scenario-orchestrator/SKILL.md", names);
        Assert.Contains("acceptance-scenario-orchestrator/references/evidence-contract.md", names);
        Assert.Contains("acceptance-test-design/SKILL.md", names);
        Assert.Contains("acceptance-test-design/references/proof-strength.md", names);
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

    private static OfficialSkillsController BuildOfficialSkillsController()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("map.example.test");
        return new OfficialSkillsController(
            new ConfigurationBuilder().Build(),
            NullLogger<OfficialSkillsController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = context },
        };
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

    private static string ReadZipText(ZipArchive zip, string name)
    {
        var entry = zip.GetEntry(name);
        Assert.NotNull(entry);
        using var reader = new StreamReader(entry!.Open());
        return reader.ReadToEnd();
    }
}
