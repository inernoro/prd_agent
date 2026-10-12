using System.Text.Json.Nodes;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class DesignArtifactBriefFactoryTests
{
    [Fact]
    public void Generate_FreezesVersionedBriefAndBrandPackage_IntoWorkspaceTask()
    {
        var run = BaseRun(DesignArtifactOperations.Generate);
        run.Instruction = "面向采购负责人做产品介绍页，引导预约咨询";
        run.Title = "企业采购方案";
        run.KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "knowledge-1",
                Title = "采购方案",
                ContentHash = "source-hash-1",
                Content = "# 方案总览\n\n## 核心能力\n\n必需事实：标准方案包含 3 个交付阶段。\n固定声明：所有数据以正式合同为准。",
            },
        ];

        DesignArtifactBriefFactory.Freeze(run, null);

        Assert.Equal("map-design-brief-v1", run.DesignBrief!.SchemaVersion);
        Assert.Equal("采购负责人做产品介绍页", run.DesignBrief.Audience);
        Assert.Equal(["方案总览", "核心能力"], run.DesignBrief.RequiredSections);
        Assert.Equal(100, run.DesignBrief.FactualCoverageRequirements.RequiredCoveragePercent);
        Assert.False(run.DesignBrief.FactualCoverageRequirements.UnsupportedFactsAllowed);
        Assert.Equal(
            ["标准方案包含 3 个交付阶段。", "所有数据以正式合同为准。"],
            run.DesignBrief.FactualCoverageRequirements.RequiredFacts);
        Assert.Equal("minimal", run.BrandPackage!.DesignSystemId);
        Assert.Equal(["所有数据以正式合同为准。"], run.BrandPackage.FixedStatements);
        Assert.Equal(12, run.DesignBrief.Fingerprint.Length);
        Assert.Equal(12, run.BrandPackage.Fingerprint.Length);

        var task = Task(DesignArtifactWorkspaceContract.BuildInputPackage(run, null));
        Assert.Equal(run.DesignBrief.Fingerprint, task["designBrief"]!["fingerprint"]!.GetValue<string>());
        Assert.Equal(run.BrandPackage.Fingerprint, task["brandPackage"]!["fingerprint"]!.GetValue<string>());
        Assert.Equal("minimal", task["brandPackage"]!["designSystemId"]!.GetValue<string>());
    }

    [Fact]
    public void Edit_MapsExistingPagePersonalStyleAndLogo_WithoutCopyingDesignSystem()
    {
        var run = BaseRun(DesignArtifactOperations.Edit);
        run.DesignDirection!.BrandSource = "personal-style";
        run.DesignDirection.BrandColors = ["#102030", "#f7f2e8", "#d06030"];
        run.DesignDirection.BrandFonts = ["Source Han Serif SC", "Inter"];
        run.DesignDirection.BrandExamples = ["hosted-site:source-site"];
        run.ReferenceImages =
        [
            new DesignReferenceImage { AttachmentId = "logo-attachment", FileName = "brand-logo.png", MimeType = "image/png", Size = 128 },
        ];
        run.KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "brand-guide",
                Title = "品牌规范",
                ContentHash = "brand-source-hash",
                Content = "固定声明：让可靠协作成为日常。\n禁止风格：高饱和霓虹渐变。",
            },
        ];

        DesignArtifactBriefFactory.Freeze(run, "<html><body><h1>现有首页</h1><h2>客户价值</h2><h3>补充说明</h3></body></html>");

        Assert.Equal("personal-style", run.BrandPackage!.Source);
        Assert.Equal("reference/screenshot-01.png", run.BrandPackage.Logo);
        Assert.Equal(["#102030", "#f7f2e8", "#d06030"], run.BrandPackage.ApprovedColors);
        Assert.Equal(["Source Han Serif SC", "Inter"], run.BrandPackage.Fonts);
        Assert.Equal(["让可靠协作成为日常。"], run.BrandPackage.FixedStatements);
        Assert.Equal(["高饱和霓虹渐变。"], run.BrandPackage.ForbiddenStyles);
        Assert.Equal(["现有首页", "客户价值"], run.DesignBrief!.RequiredSections);
        Assert.Equal(["补充说明"], run.DesignBrief.OptionalSections);

        var reference = new DesignWorkspaceFile(
            "reference/screenshot-01.png", Convert.ToBase64String([1, 2, 3]), "hash", 3, "image/png");
        var task = Task(DesignArtifactWorkspaceContract.BuildInputPackage(
            run,
            "<html><body><h1>现有首页</h1></body></html>",
            referenceFiles: [reference]));
        Assert.Equal("reference/screenshot-01.png", task["brandPackage"]!["logo"]!.GetValue<string>());
        Assert.Equal("#d06030", task["brandPackage"]!["tokenContext"]!["--accent"]!.GetValue<string>());
        Assert.Null(task["brandPackage"]!["designSystem"]);
    }

    [Fact]
    public void LegacyRunWithoutFrozenContext_RemainsReadableAndSerializesWithoutNewBlocks()
    {
        var run = new DesignArtifactRun
        {
            Id = "legacy-run",
            UserId = "user-1",
            Operation = DesignArtifactOperations.Generate,
            Instruction = "旧任务",
        };

        var task = Task(DesignArtifactWorkspaceContract.BuildInputPackage(run, null));

        Assert.Null(run.DesignBrief);
        Assert.Null(run.BrandPackage);
        Assert.Null(task["designBrief"]);
        Assert.Null(task["brandPackage"]);
    }

    private static DesignArtifactRun BaseRun(string operation) => new()
    {
        Id = $"{operation}-brief-run",
        UserId = "user-1",
        Operation = operation,
        SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
        Instruction = "制作产品介绍页",
        Title = "产品介绍",
        DesignDirection = new DesignArtifactDesignDirection
        {
            StyleId = "minimal",
            StyleName = "极简",
            StyleDescription = "黑白灰为主，信息层级清楚",
            DesignSystemId = "minimal",
            ReviewMode = DesignReviewModes.Light,
            GeneratePrompt = "生成",
            EditPrompt = "修改",
            ReviewPrompt = "检查",
            BrandSource = "design-style-preset",
            BrandColors = ["#111111", "#ffffff", "#2f6fed"],
            BrandFonts = ["Inter", "system-ui"],
            PromptFingerprint = "123456789abc",
        },
    };

    private static JsonNode Task(DesignWorkspacePackage package)
    {
        var file = Assert.Single(package.Files, item => item.Path == "brief/task.json");
        return JsonNode.Parse(Convert.FromBase64String(file.ContentBase64))!;
    }
}
