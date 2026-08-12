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
        Assert.Equal("1.9.1", OfficialSkillTemplates.AiDefectResolveVersion);
        Assert.Contains("本技能的主目标是自动化闭环", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("自主三档边界", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("五层自治回路", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("日常执行缺少 domain 或 K 时停止", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("scope.type == daily-next", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("defect_resolution_traces", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("defect-agent-workflow.v1", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("agent/workflow/start-next", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("agent/workflow/complete", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("agent/workflow/block", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("更新中心只读取 commit id 关联结果并展示", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("不允许按日期批量贴缺陷标志", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("scripts/defect-automation-probe.mjs", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("hasNext=false", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("正式缺陷系统只负责读取待验收 trace", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("测试或预览环境跑视觉验收", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("functionalVerdict", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("evidenceStatus", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("功能验收通过；闭环证据不完整", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("自动化取证能力不足不得描述成代码仍未修复", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("reportVerdict=conditional", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("不得把 `invalid` 传给 `create-visual-test-to-kb`", OfficialSkillTemplates.AiDefectResolveSkillMd);
        Assert.Contains("`conditional` 必须提供 `message`", OfficialSkillTemplates.AiDefectResolveSkillMd);
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
        Assert.Contains("scripts/publish_acceptance_rules_to_cds.py", paths);
        Assert.Contains("scripts/verify-open.mjs", paths);
        Assert.Contains("templates/zz-report.md", paths);
        Assert.Contains("templates/report-template.md", paths);
        Assert.Contains("references/rules/manifest.json", paths);
        Assert.Contains("references/rules/rule.acceptance.map-enterprise.md", paths);
        Assert.Contains("references/rules/rule.acceptance.ssot.md", paths);
        Assert.Contains("references/rules/guide.acceptance.report-evidence.md", paths);
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
        Assert.Contains(design.Files, f => f.Path == "references/rules/manifest.json");
        Assert.Contains(design.Files, f => f.Path == "references/rules/baseline.md");

        Assert.NotNull(orchestrator);
        Assert.Contains(orchestrator.Files, f => f.Path == "references/evidence-contract.md");
        Assert.Contains(orchestrator.Files, f => f.Path == "references/scenario-matrix.md");
        Assert.Contains(orchestrator.Files, f => f.Path == "references/rules/manifest.json");
        Assert.Contains(orchestrator.Files, f => f.Path == "references/rules/rule.acceptance.ssot.md");
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
        Assert.Contains("acceptance-test-design/references/rules/manifest.json", names);
        Assert.Contains("acceptance-test-design/references/rules/baseline.md", names);
        Assert.Contains("acceptance-scenario-orchestrator/references/evidence-contract.md", names);
        Assert.Contains("acceptance-scenario-orchestrator/references/rules/manifest.json", names);
        Assert.Contains("create-visual-test-to-kb/references/rules/manifest.json", names);
        Assert.Contains("create-visual-test-to-kb/references/rules/guide.acceptance.report-evidence.md", names);
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
        Assert.Contains("ok: reports.length > 0 && broken.length === 0 && clickErrors.length === 0", verifyOpen);

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
        Assert.Contains("acceptance-test-design/references/rules/manifest.json", names);
        Assert.Contains("acceptance-scenario-orchestrator/references/rules/manifest.json", names);
    }

    // ======================================================================
    // 角色套装（bundle）—— 外部用户「一条 curl 装齐一个角色」的入口
    // ======================================================================

    [Fact]
    public void PmStarterBundle_IsRegisteredWithEntrySkillAndRole()
    {
        var bundle = OfficialSkillCatalog.FindBundle("pm-starter");

        Assert.NotNull(bundle);
        Assert.Contains("pm", bundle!.Roles);
        // sdd-init 是把零件串成工作方法的入口技能，套装里缺了它等于只发了一堆散装命令
        Assert.Contains("sdd-init", bundle.Includes);
        Assert.Contains("skill-validation", bundle.Includes);
        Assert.Contains("product-document-generator", bundle.Includes);
        Assert.Equal("产品经理", OfficialSkillCatalog.RoleLabels["pm"]);
    }

    [Fact]
    public void BundleKeys_DoNotCollideWithSkillKeys()
    {
        // 两者共用 official-{key} 下载命名空间，撞了会让下载路由指错东西
        foreach (var bundle in OfficialSkillCatalog.AllBundles)
            Assert.Null(OfficialSkillCatalog.Find(bundle.Key));
    }

    [Fact]
    public void EveryBundledSkill_ExistsInCatalog()
    {
        foreach (var bundle in OfficialSkillCatalog.AllBundles)
        {
            OfficialSkillCatalog.ExpandWithRequires(bundle.Includes, out var missing);
            Assert.Empty(missing);
        }
    }

    [Fact]
    public void PmStarterBundleDownload_PacksEverySkillPlusInstallGuide()
    {
        var controller = BuildOfficialSkillsController();

        var result = controller.Download("pm-starter");
        var file = Assert.IsType<FileContentResult>(result);
        Assert.Equal("pm-starter.zip", file.FileDownloadName);

        using var ms = new MemoryStream(file.FileContents);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);
        var names = zip.Entries.Select(e => e.FullName).ToHashSet(StringComparer.Ordinal);

        var bundle = OfficialSkillCatalog.FindBundle("pm-starter")!;
        foreach (var key in bundle.Includes)
            Assert.Contains($"{key}/SKILL.md", names);

        // 顶层两份说明：用户解压后看到的第一份文档 + 机器可读清单
        Assert.Contains("INSTALL.md", names);
        Assert.Contains("bundle.manifest.json", names);

        var install = ReadZipText(zip, "INSTALL.md");
        // 装项目级不装用户主目录：技能跟着项目版本库走，团队 clone 下来都有
        Assert.DoesNotContain("~/.claude/skills", install);
        // 三个宿主都要遍历（目录名由 $h/skills 拼出，所以断言宿主名 + 兜底目录）
        Assert.Contains("for h in .claude .cursor .agents", install);
        Assert.Contains(".agents/skills", install);
        // 装到全部存在的宿主，不是只装第一个命中的
        Assert.Contains("for d in $SKILLS_DIRS", install);
        Assert.Contains("/sdd-init", install);
    }

    [Fact]
    public void BundleFork_ReturnsBundleDownloadUrl()
    {
        var request = BuildRequest("https://map.example.test");
        var config = new ConfigurationBuilder().Build();

        var response = OfficialMarketplaceSkillInjector.BuildForkResponseById(
            "official-pm-starter",
            request,
            config,
            currentUserId: "user-1");

        Assert.NotNull(response);
        Assert.Equal(
            "https://map.example.test/api/official-skills/pm-starter/download",
            Read<string>(response!, "downloadUrl"));
        Assert.Equal("pm-starter.zip", Read<string>(response!, "fileName"));

        var item = ReadObject(response!, "item");
        Assert.Equal("official-pm-starter", Read<string>(item, "Id"));
        Assert.Equal("bundle", Read<string>(item, "kind"));
    }

    [Fact]
    public void MarketplaceList_PutsBundlesAheadOfIndividualSkills()
    {
        var request = BuildRequest("https://map.example.test");
        var config = new ConfigurationBuilder().Build();

        var dtos = OfficialMarketplaceSkillInjector.BuildAllDtos(
            request, config, currentUserId: "user-1",
            keyword: null, tag: null, includeCatalogWhenUnfiltered: true);

        var kinds = dtos.Select(d => d.GetType().GetProperty("kind")?.GetValue(d) as string).ToList();
        var firstBundle = kinds.IndexOf("bundle");
        var lastSkill = kinds.LastIndexOf("skill");

        Assert.True(firstBundle >= 0, "官方套装未注入市场列表");
        Assert.True(lastSkill >= 0, "官方技能未注入市场列表");
        // 套装排在散装技能之前：让用户先看到「一条命令装齐」，而不是从二十张卡里自己挑
        Assert.True(firstBundle < lastSkill, "套装应排在散装技能之前");
    }

    [Fact]
    public void PmStarterSkills_CarryPmRoleForMarketplaceFiltering()
    {
        var bundle = OfficialSkillCatalog.FindBundle("pm-starter")!;
        foreach (var key in bundle.Includes)
        {
            var entry = OfficialSkillCatalog.Find(key);
            Assert.NotNull(entry);
            // 套装成员必须带 pm 角色，否则市场按「产品经理」筛选时套装点开是空的
            Assert.Contains("pm", entry!.Roles);
        }
    }

    // ======================================================================
    // findmapskills 单一事实源（2026-07-28 合并，原先后端内嵌第二份）
    // ======================================================================

    [Fact]
    public void FindMapSkills_IsServedFromCatalogNotAnEmbeddedCopy()
    {
        var entry = OfficialSkillCatalog.Find(OfficialSkillTemplates.FindMapSkillsKey);

        Assert.NotNull(entry);
        Assert.Contains(entry!.Files, f => f.Path == "SKILL.md");
        Assert.Contains(entry.Files, f => f.Path == "README.md");
        // 版本号来自技能文件的 frontmatter，后端不再单独维护一份常量
        Assert.Equal(entry.Version, OfficialSkillTemplates.FindMapSkillsVersion);
    }

    [Fact]
    public void FindMapSkillsDownload_InjectsThisInstanceAsDefaultBaseUrl()
    {
        var controller = BuildOfficialSkillsController();

        var result = controller.Download(OfficialSkillTemplates.FindMapSkillsKey);
        var file = Assert.IsType<FileContentResult>(result);

        using var ms = new MemoryStream(file.FileContents);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);
        var skillMd = ReadZipText(zip, $"{OfficialSkillTemplates.FindMapSkillsKey}/SKILL.md");

        // 用户拿到即用：base URL 已预置成本实例地址，同时保留 env 覆盖能力
        Assert.Contains("${PRD_AGENT_BASE:=https://map.example.test}", skillMd);
        Assert.DoesNotContain("缺 base URL", skillMd);
    }

    [Fact]
    public void FindMapSkillsSkill_InstallsIntoProjectLevelDirectory()
    {
        var entry = OfficialSkillCatalog.Find(OfficialSkillTemplates.FindMapSkillsKey)!;
        var skillMd = entry.Files.Single(f => f.Path == "SKILL.md").Content;

        // 装到用户主目录的话技能不跟项目走，团队 clone 下来少一半
        Assert.DoesNotContain("-d ~/.claude/skills", skillMd);
        // 三个宿主都要遍历（目录名由 $h/skills 拼出，所以断言宿主名 + 兜底目录）
        Assert.Contains("for h in .claude .cursor .agents", skillMd);
        Assert.Contains(".agents/skills", skillMd);
        // 装到全部存在的宿主，不是只装第一个命中的：同时装了多个 Agent 的仓库里，
        // 只装第一个会让当前 Agent 一个技能都看不见
        Assert.Contains("for d in $SKILLS_DIRS", skillMd);
    }

    [Fact]
    public void OfficialDtos_CanExceedASmallCallerLimit_SoTrimmingIsRequired()
    {
        // 这条钉住「为什么必须裁官方条目」：按 tag 过滤时官方命中数可以远大于
        // 调用方给的 limit=1。只把 DB 查询减到 0 不够——官方 DTO 会被整批插进去，
        // 返回条数超过调用方要求，同时把 AI 的响应体积撑大。
        var request = BuildRequest("https://map.example.test");
        var config = new ConfigurationBuilder().Build();

        // 取一个真实存在、被多个官方技能共用的 tag
        var sharedTag = OfficialSkillCatalog.All
            .SelectMany(e => e.Tags ?? new List<string>())
            .GroupBy(x => x)
            .Where(g => g.Count() > 1)
            .OrderByDescending(g => g.Count())
            .Select(g => g.Key)
            .FirstOrDefault();
        Assert.NotNull(sharedTag);

        var official = OfficialMarketplaceSkillInjector.BuildAllDtos(
            request, config, currentUserId: "user-1", keyword: null, tag: sharedTag,
            includeCatalogWhenUnfiltered: false);

        Assert.True(official.Count > 1,
            $"tag `{sharedTag}` 应命中多于 1 条官方条目（实际 {official.Count}），否则本用例失去意义");
    }

    [Fact]
    public void FindMapSkillsDto_CarriesRolesFromCatalog()
    {
        // 这条 DTO 是特判构造的（不走通用 catalog→DTO 路径），历史上把 roles 写死成空表。
        // 结果是用户一点「产品经理 / 开发 / 测试」任一角色筛选，findmapskills 就整条消失，
        // 而它在 skill-bundles.json 里三个角色都挂着。
        var catalogRoles = OfficialSkillCatalog.Find(OfficialSkillTemplates.FindMapSkillsKey)!.Roles;
        Assert.NotEmpty(catalogRoles);

        var request = BuildRequest("https://map.example.test");
        var config = new ConfigurationBuilder().Build();
        var dto = OfficialMarketplaceSkillInjector.BuildDtoById(
            OfficialMarketplaceSkillInjector.OfficialFindMapSkillsId, request, config, currentUserId: "user-1");
        var roles = Read<List<string>>(dto!, "roles");

        Assert.Equal(catalogRoles.OrderBy(r => r), roles.OrderBy(r => r));
    }

    [Fact]
    public void DiscoverableTags_IncludesBundleOnlyTags()
    {
        // 套装专属 tag（如「套装」）必须出现在标签发现里：站内和开放接口两个 /tags
        // 端点都消费这一份。此前开放接口只汇总数据库 tag，导致「查不到但能按它筛」。
        var tags = OfficialSkillCatalog.DiscoverableTags().ToHashSet();

        var bundleTags = OfficialSkillCatalog.AllBundles.SelectMany(b => b.Tags ?? new List<string>()).ToList();
        Assert.NotEmpty(bundleTags);
        foreach (var tag in bundleTags)
            Assert.Contains(tag, tags);

        // 散装技能的 tag 也要在
        var skillTags = OfficialSkillCatalog.All.SelectMany(e => e.Tags ?? new List<string>()).ToList();
        Assert.NotEmpty(skillTags);
        foreach (var tag in skillTags)
            Assert.Contains(tag, tags);
    }

    [Fact]
    public void MarketplaceList_DoesNotShowFindMapSkillsTwice()
    {
        var request = BuildRequest("https://map.example.test");
        var config = new ConfigurationBuilder().Build();

        var dtos = OfficialMarketplaceSkillInjector.BuildAllDtos(
            request, config, currentUserId: "user-1",
            keyword: null, tag: null, includeCatalogWhenUnfiltered: true);

        // findmapskills 既有专属特判 DTO，又进了 catalog —— 不去重就会出现两条同名条目
        var ids = dtos.Select(d => d.GetType().GetProperty("Id")?.GetValue(d) as string).ToList();
        Assert.Single(ids, id => id == OfficialMarketplaceSkillInjector.OfficialFindMapSkillsId);
        Assert.Equal(ids.Count, ids.Distinct().Count());
    }

    [Fact]
    public void BundleInstallCommand_UsesProjectLevelDetection()
    {
        var controller = BuildOfficialSkillsController();

        var result = controller.ListBundles(role: null);
        var ok = Assert.IsType<OkObjectResult>(result);
        var payload = ReadObject(ok.Value!, "Data");
        var items = (System.Collections.IEnumerable)ReadObject(payload, "items");
        var first = items.Cast<object>().First();
        var command = Read<string>(first, "installCommand");

        Assert.Contains(".agents/skills", command);
        Assert.DoesNotContain("~/.claude/skills", command);
        // 遍历安装：早期「取第一个命中的宿主」写法回潮即红
        Assert.Contains("for d in $SKILLS_DIRS", command);
    }

    // ======================================================================
    // 读技能免凭据（2026-07-28 用户决策：技能是公开内容，只有上传才要验证）
    // ======================================================================

    [Theory]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsOpenApiController), "List")]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsOpenApiController), "GetById")]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsOpenApiController), "Tags")]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsOpenApiController), "Fork")]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsController), "List")]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsController), "Tags")]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsController), "Fork")]
    [InlineData(typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsController), "ZipContent")]
    public void SkillReadEndpoints_AreAnonymous(Type controller, string action)
    {
        var method = controller.GetMethod(action);
        Assert.NotNull(method);
        // 把浏览和下载挡在凭据后面 = 要求客户先注册才能拿技能，与「CDS 作为中介」的定位冲突
        Assert.NotEmpty(method!.GetCustomAttributes(typeof(Microsoft.AspNetCore.Authorization.AllowAnonymousAttribute), false));
    }

    [Theory]
    [InlineData("Upload")]
    [InlineData("Favorite")]
    [InlineData("Unfavorite")]
    public void SkillWriteEndpoints_StillRequireCredentials(string action)
    {
        var method = typeof(PrdAgent.Api.Controllers.Api.MarketplaceSkillsOpenApiController).GetMethod(action);
        Assert.NotNull(method);
        // 写入与「绑定到人」的操作必须留着凭据要求
        Assert.Empty(method!.GetCustomAttributes(typeof(Microsoft.AspNetCore.Authorization.AllowAnonymousAttribute), false));
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
