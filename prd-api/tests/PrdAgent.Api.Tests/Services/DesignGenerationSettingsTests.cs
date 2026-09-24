using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 网页生成设置（2026-09-23 用户要求：默认值必须是 OpenDesign、提示词要交给用户、入口要容易改）。
/// 守的是四件事：默认值真的是 open-design；「恢复默认」真的回到内置稿；写坏的设置被拒而不是落默认值；
/// 一次运行冻结下来的风格与提示词真的进了任务书，且不影响没有这些字段的旧运行。
/// </summary>
public sealed class DesignGenerationSettingsTests
{
    private static readonly IDesignSystemCatalog Catalog = DesignSystemCatalog.LoadEmbedded();

    [Fact]
    public void 没有保存过设置时默认执行器是OpenDesign且八套风格有且只有一套默认()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);

        Assert.Equal(DesignArtifactRuntimes.OpenDesign, settings.DefaultRuntime);
        Assert.Equal(DesignReviewModes.Light, settings.ReviewMode);
        Assert.Equal(8, settings.Styles.Count);
        Assert.Single(settings.Styles, style => style.IsDefault);
        Assert.All(settings.Styles, style => Assert.Equal(3, style.Swatches.Count));
        Assert.True(settings.GeneratePromptIsDefault);
        Assert.Equal(DesignGenerationDefaults.GeneratePrompt, settings.GeneratePrompt);
    }

    [Fact]
    public void 改提示词后指纹变化_传空串恢复默认后指纹回到默认值()
    {
        var defaultFingerprint = DesignGenerationSettingsService.Freeze(
            DesignGenerationSettingsService.Effective(null, Catalog), null).PromptFingerprint;

        var edited = DesignGenerationSettingsService.Apply(new DesignGenerationSettings(), new DesignGenerationSettingsUpdate
        {
            Prompts = new DesignGenerationPromptsUpdate { Generate = "只用两种颜色" },
        }, Catalog);
        var editedSettings = DesignGenerationSettingsService.Effective(edited, Catalog);
        var editedFingerprint = DesignGenerationSettingsService.Freeze(editedSettings, null).PromptFingerprint;

        Assert.False(editedSettings.GeneratePromptIsDefault);
        Assert.NotEqual(defaultFingerprint, editedFingerprint);

        var restored = DesignGenerationSettingsService.Apply(edited, new DesignGenerationSettingsUpdate
        {
            Prompts = new DesignGenerationPromptsUpdate { Generate = "" },
        }, Catalog);
        Assert.Null(restored.GeneratePrompt);
        Assert.Equal(defaultFingerprint, DesignGenerationSettingsService.Freeze(
            DesignGenerationSettingsService.Effective(restored, Catalog), null).PromptFingerprint);
    }

    [Fact]
    public void 提交与内置稿逐字相同的提示词不算改过()
    {
        var saved = DesignGenerationSettingsService.Apply(new DesignGenerationSettings(), new DesignGenerationSettingsUpdate
        {
            Prompts = new DesignGenerationPromptsUpdate { Review = DesignGenerationDefaults.ReviewPrompt },
        }, Catalog);

        Assert.Null(saved.ReviewPrompt);
    }

    [Theory]
    [InlineData("codex")]
    [InlineData("")]
    public void 默认执行器只接受两种取值(string runtime)
    {
        Assert.Throws<DesignGenerationSettingsException>(() => DesignGenerationSettingsService.Apply(
            new DesignGenerationSettings(), new DesignGenerationSettingsUpdate { DefaultRuntime = runtime }, Catalog));
    }

    [Fact]
    public void 写坏的风格被拒收而不是落默认值()
    {
        var baseStyle = DesignGenerationDefaults.Styles[0];
        DesignStylePreset Clone(Action<DesignStylePreset> mutate)
        {
            var copy = new DesignStylePreset
            {
                Id = baseStyle.Id,
                Name = baseStyle.Name,
                Description = baseStyle.Description,
                DesignSystemId = baseStyle.DesignSystemId,
                Swatches = baseStyle.Swatches.ToList(),
                Enabled = true,
                IsDefault = true,
            };
            mutate(copy);
            return copy;
        }

        foreach (var broken in new[]
                 {
                     Clone(s => s.DesignSystemId = "../../etc"),
                     Clone(s => s.Id = "Bad Id"),
                     Clone(s => s.Enabled = false),
                 })
        {
            Assert.Throws<DesignGenerationSettingsException>(() => DesignGenerationSettingsService.Apply(
                new DesignGenerationSettings(),
                new DesignGenerationSettingsUpdate { Styles = new List<DesignStylePreset> { broken } }, Catalog));
        }
    }

    [Fact]
    public void 直接选目录里的设计系统_按快照冻结且与同名预设区分_未知编号说清原因()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);

        var frozen = DesignGenerationSettingsService.FreezeCatalogStyle(settings, Catalog, "Nike");
        Assert.Equal("nike", frozen.DesignSystemId);
        Assert.Equal(DesignGenerationSettingsService.CatalogStylePrefix + "nike", frozen.StyleId);
        Assert.False(string.IsNullOrWhiteSpace(frozen.StyleName));
        // 提示词与自查强度仍取当前设置：目录风格只换「长什么样」，不换「怎么设计」。
        Assert.Equal(settings.GeneratePrompt, frozen.GeneratePrompt);
        Assert.Equal(settings.ReviewMode, frozen.ReviewMode);

        // 与同名预设不是一回事：指纹不同，任务书里也分得开。
        var preset = DesignGenerationSettingsService.Freeze(settings, "editorial");
        var catalogEditorial = DesignGenerationSettingsService.FreezeCatalogStyle(settings, Catalog, "editorial");
        Assert.NotEqual(preset.StyleId, catalogEditorial.StyleId);
        Assert.NotEqual(preset.PromptFingerprint, catalogEditorial.PromptFingerprint);

        var unknown = Assert.Throws<DesignGenerationSettingsException>(
            () => DesignGenerationSettingsService.FreezeCatalogStyle(settings, Catalog, "no-such-system"));
        Assert.Contains("no-such-system", unknown.Message);
    }

    [Fact]
    public void 没选风格时取默认风格_选了停用或不存在的风格要说清原因()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);

        var frozen = DesignGenerationSettingsService.Freeze(settings, null);
        Assert.Equal("editorial", frozen.StyleId);
        Assert.Equal("editorial", frozen.DesignSystemId);
        Assert.Equal(12, frozen.PromptFingerprint.Length);

        Assert.Equal("kami", DesignGenerationSettingsService.Freeze(settings, "KAMI").DesignSystemId);
        var unknown = Assert.Throws<DesignGenerationSettingsException>(() => DesignGenerationSettingsService.Freeze(settings, "nope"));
        Assert.Contains("nope", unknown.Message);

        var disabledStyles = settings.Styles.Select(s => new DesignStylePreset
        {
            Id = s.Id, Name = s.Name, Description = s.Description, DesignSystemId = s.DesignSystemId,
            Swatches = s.Swatches, Enabled = s.Id != "kami", IsDefault = s.IsDefault,
        }).ToList();
        var withDisabled = settings with { Styles = disabledStyles };
        var disabled = Assert.Throws<DesignGenerationSettingsException>(() => DesignGenerationSettingsService.Freeze(withDisabled, "kami"));
        Assert.Contains("停用", disabled.Message);
    }

    [Fact]
    public void 设置接口把平台契约与三段提示词原文都交出去()
    {
        var view = JsonSerializer.SerializeToNode(
            DesignGenerationSettingsController.ToView(DesignGenerationSettingsService.Effective(null, Catalog), canEdit: false, Catalog))!;

        Assert.Equal("open-design", view["defaultRuntime"]!.GetValue<string>());
        Assert.Equal(DesignGenerationDefaults.PlatformContract, view["platformContract"]!.GetValue<string>());
        Assert.Equal(DesignGenerationDefaults.EditPrompt, view["prompts"]!["edit"]!["value"]!.GetValue<string>());
        Assert.True(view["prompts"]!["review"]!["isDefault"]!.GetValue<bool>());
        Assert.False(view["canEdit"]!.GetValue<bool>());
        Assert.Equal(12, view["promptFingerprint"]!.GetValue<string>().Length);
    }

    private static DesignArtifactRun BuildRun() => new()
    {
        Id = "run-direction-1",
        UserId = "user-1",
        Title = "网页标题",
        Operation = DesignArtifactOperations.Generate,
        SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
        Instruction = "做一张方案介绍页",
    };

    private static JsonNode Task(DesignWorkspacePackage package)
    {
        var taskFile = Assert.Single(package.Files, file => file.Path == "brief/task.json");
        return JsonNode.Parse(Convert.FromBase64String(taskFile.ContentBase64))!;
    }

    [Fact]
    public void 冻结的风格与提示词进入任务书_上传文档落在knowledge目录并计入事实来源_截图只进reference()
    {
        var run = BuildRun();
        run.DesignDirection = DesignGenerationSettingsService.Freeze(DesignGenerationSettingsService.Effective(null, Catalog), "kami");
        run.UploadedSources = new List<DesignUploadedSource>
        {
            new() { AttachmentId = "att-1", FileName = "方案 A.md", MimeType = "text/markdown", Content = "上线后错误率下降 40%", ContentHash = "h1" },
        };
        var screenshot = new DesignWorkspaceFile("reference/screenshot-01.png", Convert.ToBase64String(new byte[] { 1, 2, 3 }),
            "0000", 3, "image/png");

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, null, referenceFiles: new[] { screenshot });
        var task = Task(package);

        var direction = task["designDirection"]!;
        Assert.Equal("map-design-direction-v1", direction["schemaVersion"]!.GetValue<string>());
        Assert.Equal("kami", direction["designSystemId"]!.GetValue<string>());
        Assert.Equal(DesignGenerationDefaults.GeneratePrompt, direction["prompts"]!["generate"]!.GetValue<string>());
        Assert.Equal(run.DesignDirection.PromptFingerprint, direction["promptFingerprint"]!.GetValue<string>());

        var uploaded = Assert.Single(package.Files, file => file.Path.StartsWith("knowledge/upload-01-", StringComparison.Ordinal));
        Assert.Contains("错误率下降 40%", System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(uploaded.ContentBase64)));
        Assert.Equal(
            ["server-knowledge"],
            task["qualityContract"]!["factualSources"]!.AsArray().Select(value => value!.GetValue<string>()).ToArray());
        Assert.Contains(package.Files, file => file.Path == "reference/screenshot-01.png");
        Assert.False(task["input"]!["referenceImages"]!["factual"]!.GetValue<bool>());
    }

    [Fact]
    public void 没有新字段的旧运行任务书与版本指纹逐字节不变()
    {
        var legacy = BuildRun();
        legacy.KnowledgeReferences.Add(new DesignKnowledgeSnapshot { EntryId = "e1", Title = "t", Content = "c", ContentHash = "h" });
        var before = DesignArtifactWorkspaceContract.BuildInputPackage(legacy, null);

        Assert.Null(Task(before)["designDirection"]);
        Assert.Null(Task(before)["input"]!["uploadedSources"]);

        var withDirection = BuildRun();
        withDirection.KnowledgeReferences.Add(new DesignKnowledgeSnapshot { EntryId = "e1", Title = "t", Content = "c", ContentHash = "h" });
        withDirection.DesignDirection = DesignGenerationSettingsService.Freeze(DesignGenerationSettingsService.Effective(null, Catalog), null);
        var after = DesignArtifactWorkspaceContract.BuildInputPackage(withDirection, null);

        // 方向参与版本指纹：同样的知识换一套风格，不能被当成同一个输入。
        Assert.NotEqual(before.BaseRevision, after.BaseRevision);
        Assert.Equal(before.BaseRevision, DesignArtifactWorkspaceContract.BuildInputPackage(legacy, null).BaseRevision);
    }

    [Fact]
    public void 与CDS共用的带设计方向黄金夹具逐字一致()
    {
        var run = BuildRun();
        run.Id = "run-direction-golden";
        run.DesignDirection = DesignGenerationSettingsService.Freeze(DesignGenerationSettingsService.Effective(null, Catalog), "minimal");
        run.KnowledgeReferences.Add(new DesignKnowledgeSnapshot
        {
            EntryId = "entry-1", Title = "产品 资料", Content = "产品定位与核心卖点", ContentHash = "source-hash",
        });
        var actual = Task(DesignArtifactWorkspaceContract.BuildInputPackage(run, null));
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "Fixtures", "opendesign-task-v1-direction.json");
        var expected = JsonNode.Parse(File.ReadAllText(fixturePath));

        Assert.Equal(expected?.ToJsonString(), actual.ToJsonString());
    }

    [Fact]
    public void 预览事件在公开生成流上放行()
    {
        Assert.Contains("preview", DesignArtifactsController.PublicGenerationStreamEvents);
    }

    [Fact]
    public void SavingStyles_RejectsNewDesignSystemIdsOutsideTheSnapshot_ButKeepsLegacyOnes()
    {
        // Codex P2：新填的设计系统编号不在快照里也能保存，这套风格没有样张、生成时找不到。
        var ghost = new DesignStylePreset { Id = "ghost", Name = "幽灵", DesignSystemId = "no-such-system", Enabled = true, IsDefault = true };
        var ex = Assert.Throws<DesignGenerationSettingsException>(() => DesignGenerationSettingsService.Apply(
            new DesignGenerationSettings(), new DesignGenerationSettingsUpdate { Styles = new List<DesignStylePreset> { ghost } }, Catalog));
        Assert.Contains("no-such-system", ex.Message);

        // 库里原样沉淀的旧编号（快照更新后可能不在了）不拦：否则管理员连提示词都存不了。
        var stored = new DesignGenerationSettings { Styles = new List<DesignStylePreset> { ghost } };
        var saved = DesignGenerationSettingsService.Apply(stored, new DesignGenerationSettingsUpdate
        {
            Styles = new List<DesignStylePreset> { new() { Id = "ghost", Name = "改个名", DesignSystemId = "no-such-system", Enabled = true, IsDefault = true } },
        }, Catalog);
        Assert.Equal("改个名", saved.Styles![0].Name);
    }
}
