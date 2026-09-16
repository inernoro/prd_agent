using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 生图模型契约「配在控制台、不用发版」这条链路的守卫。
///
/// 这条链路的每一环都是**断了也不会红**的那种：
///   - 刷新器漏抄一个字段 → 控制台那一栏填了没用，生图照常跑
///   - 有人绕过 TryMatch 直接遍历内置表 → 覆盖表对那条路径失效，别处却生效（判据分裂）
///   - 控制台词表与运行时常量对不上 → 填得进去、运行时不认
/// 所以逐条钉住（predicate-and-wiring-discipline 形状 2 与形状 3）。
/// </summary>
public class ImageGenConfigOverrideGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static string Read(string relative) => File.ReadAllText(Path.Combine(RepoRoot(), relative));

    /// <summary>
    /// 库里配的那条真的会赢过代码内置的那条。
    ///
    /// 这是整套东西的核心承诺：「上游出了新模型，控制台填一次就生效」。它要是不成立，
    /// 前面所有的实体、端点、界面都是摆设。用的是一个代码内置表里**确实存在**的模式，
    /// 所以这条断言同时证明了「覆盖真的发生了」而不是「恰好没人管这个模式」。
    /// </summary>
    [Fact]
    public void 库里配的契约赢过代码内置的那条()
    {
        var builtin = ImageGenModelAdapterRegistry.TryMatch("gpt-image-1");
        Assert.NotNull(builtin);

        try
        {
            ImageGenModelAdapterRegistry.ReplaceOverrides(
            [
                ImageGenConfigTranslation.ToAdapterConfig(new GatewayImageModelConfig
                {
                    ModelIdPattern = "gpt-image-1",
                    DisplayName = "被控制台覆盖了",
                    MaxWidth = 4242,
                }),
            ]);

            var overridden = ImageGenModelAdapterRegistry.TryMatch("gpt-image-1");
            Assert.NotNull(overridden);
            Assert.Equal("被控制台覆盖了", overridden!.DisplayName);
            Assert.Equal(4242, overridden.MaxWidth);
        }
        finally
        {
            ImageGenModelAdapterRegistry.ReplaceOverrides([]);
        }
    }

    /// <summary>
    /// 覆盖表为空时，行为与这套机制上线之前逐字节相同。
    ///
    /// 「纯增量」不是一句安慰话，是可以断言的：库里一行都没有 = 回到代码内置那张表。
    /// 这条同时保证了回退路径——把数据行删光就回到原状，不需要发版。
    /// </summary>
    [Fact]
    public void 覆盖表为空时回到代码内置那张表()
    {
        ImageGenModelAdapterRegistry.ReplaceOverrides([]);
        Assert.Equal(0, ImageGenModelAdapterRegistry.OverrideCount);

        foreach (var expected in ImageGenModelConfigs.Configs)
        {
            var probe = expected.ModelIdPattern.TrimEnd('*');
            if (probe.Length == 0) continue;
            var matched = ImageGenModelAdapterRegistry.TryMatch(probe);
            Assert.NotNull(matched);
        }
    }

    /// <summary>
    /// 判定入口只许有一个。
    ///
    /// 谁绕过 <c>TryMatch</c> 直接遍历 <c>ImageGenModelConfigs.Configs</c>，谁那条路径就看不见
    /// 控制台配的覆盖——同一个问题有了两个答案，而两个答案只在某些模型上才不一样，
    /// 于是「改了没生效」会变成一个查很久的玄学问题（形状 3）。
    /// </summary>
    [Fact]
    public void 没有人绕过唯一的判定入口()
    {
        var offenders = new List<string>();
        foreach (var file in Directory.EnumerateFiles(
                     Path.Combine(RepoRoot(), "prd-api/src"), "*.cs", SearchOption.AllDirectories))
        {
            var name = Path.GetFileName(file);
            // 定义它的那个文件、读它的注册表、以及把它发布出去的刷新器，本来就该碰它。
            if (name is "ImageGenModelConfigs.cs" or "ImageGenModelAdapterRegistry.cs"
                or "ImageGenModelConfigSyncWorker.cs" or "ImageGenConfigTranslation.cs") continue;
            // 只看代码，不看注释——注释里提这个名字是在解释它，不是在绕过它。
            // 第一版没剥注释，第一个被自己抓住的就是实体上那句解释性的文档注释（形状 1：判据管宽了）。
            if (StripComments(File.ReadAllText(file)).Contains("ImageGenModelConfigs.Configs", StringComparison.Ordinal))
                offenders.Add(Path.GetRelativePath(RepoRoot(), file));
        }

        Assert.True(
            offenders.Count == 0,
            $"这些文件绕过 ImageGenModelAdapterRegistry.TryMatch 直接读了内置表，控制台配的覆盖对它们无效：{string.Join("、", offenders)}");
    }

    /// <summary>剥掉行注释与块注释，只留代码。</summary>
    private static string StripComments(string source)
        => Regex.Replace(
            Regex.Replace(source, @"/\*.*?\*/", string.Empty, RegexOptions.Singleline),
            @"//[^\r\n]*", string.Empty);

    /// <summary>
    /// 刷新器把实体的每个字段都接上了。
    ///
    /// 漏接一个字段不会让任何东西变红：控制台上照样能填、能保存、能显示，只是运行时不认——
    /// 「填了没用」是这套东西最难查的一种坏法，因为它看起来完全正常。
    /// 所以这里反射比对两边的属性名，逐个要求有对应。
    /// </summary>
    [Fact]
    public void 实体的每个契约字段都真的接进了运行时配置()
    {
        // 这几个是实体自己的账务字段，运行时配置里本来就没有对应项。
        var bookkeeping = new HashSet<string>(StringComparer.Ordinal)
        {
            nameof(GatewayImageModelConfig.Id),
            nameof(GatewayImageModelConfig.TenantId),
            nameof(GatewayImageModelConfig.Enabled),
            nameof(GatewayImageModelConfig.MatchOrder),
            nameof(GatewayImageModelConfig.CreatedAt),
            nameof(GatewayImageModelConfig.UpdatedAt),
            nameof(GatewayImageModelConfig.UpdatedBy),
        };

        var runtimeProps = typeof(ImageGenModelAdapterConfig)
            .GetProperties()
            .Select(p => p.Name)
            .ToHashSet(StringComparer.Ordinal);

        var missing = typeof(GatewayImageModelConfig)
            .GetProperties()
            .Select(p => p.Name)
            .Where(n => !bookkeeping.Contains(n) && !runtimeProps.Contains(n))
            .ToList();

        Assert.True(
            missing.Count == 0,
            $"实体上这些字段在运行时配置里没有对应项，填了不会生效：{string.Join("、", missing)}");

        // 光有同名属性还不够——翻译函数得真的读它。漏了赋值同样不会变红。
        var file = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenConfigTranslation.cs");
        var translation = file[file.IndexOf("ToAdapterConfig", StringComparison.Ordinal)..];
        foreach (var name in typeof(GatewayImageModelConfig).GetProperties().Select(p => p.Name))
        {
            if (bookkeeping.Contains(name) && name != nameof(GatewayImageModelConfig.UpdatedAt)) continue;
            Assert.Contains($"doc.{name}", translation, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// 控制台只让填的那几个值，与运行时真正认的那几个一致。
    ///
    /// 对不上的后果是：界面上填得进去、保存也成功，运行时却当成未知值走了默认分支——
    /// 用户会觉得「我明明配了 aspect_ratio」。两边各写一份词表迟早漂移，
    /// 所以这里逐项比对（形状 3）。
    /// </summary>
    [Fact]
    public void 控制台词表与运行时常量逐项一致()
    {
        var dtos = Read("llmgw/console-api/Models/Dtos.cs");
        var vocabulary = dtos[dtos.IndexOf("class ImageGenConfigVocabulary", StringComparison.Ordinal)..];
        var declared = Regex.Matches(vocabulary[..vocabulary.IndexOf("SizePattern", StringComparison.Ordinal)], "\"([^\"]+)\"")
            .Select(m => m.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);

        foreach (var format in new[]
                 {
                     SizeParamFormats.WxH, SizeParamFormats.WidthHeight,
                     SizeParamFormats.AspectRatio, SizeParamFormats.None,
                 })
        {
            Assert.Contains(format, declared);
        }

        foreach (var constraint in new[]
                 {
                     SizeConstraintTypes.Whitelist, SizeConstraintTypes.Range,
                     SizeConstraintTypes.AspectRatio, SizeConstraintTypes.Adaptive,
                 })
        {
            Assert.Contains(constraint, declared);
        }
    }

    /// <summary>
    /// 「我配的那条生效了没有」这个问题答得上来。
    ///
    /// 没有同步状态回写，界面只能说一句「最长 60 秒生效」然后让人盯着屏幕猜，
    /// 而猜错的代价是去查一个根本没坏的东西。所以刷新器每轮要回写「几点同步的、
    /// 认到了哪几个模式」，控制台读它，界面逐条对着自己刚填的模式打勾。
    ///
    /// 只回写数字是不够的：「我配了 3 条它说 3 条」仍然答不出「生效的是不是我刚改的那条」，
    /// 所以模式清单也要回写（形状 1：判据比它该管的范围窄）。
    /// </summary>
    [Fact]
    public void 同步状态回写让界面答得出生效了没有()
    {
        var worker = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");
        Assert.Contains("llmgw_imagegen_sync_status", worker);
        Assert.Contains("\"SyncedAt\"", worker);
        Assert.Contains("ordered.Select(x => x.ModelIdPattern)", worker);

        var console = Read("llmgw/console-api/Program.cs");
        Assert.Contains("llmgw_imagegen_sync_status", console);
        Assert.Contains("SyncedPatterns", console);

        // 界面得真的用它下结论，而不是只把字段接过来放着。
        var panel = Read("llmgw/web/src/components/ImageGenContractsSection.tsx");
        Assert.Contains("syncNote", panel);
        Assert.Contains("data.syncedPatterns", panel);
        Assert.Contains("还没被认到", panel);
    }

    /// <summary>
    /// 内置清单是发布出来的，不是手抄的。
    ///
    /// 本轮第一版就是手抄的：抄成 26 条、内容还对不上真表的 19 条，而且不会有任何东西变红——
    /// `no-rootless-tree` 说的那种「看起来有根、根是个硬编码快照」。这条钉住它不许回来。
    /// </summary>
    [Fact]
    public void 内置契约清单由运行时发布而不是手抄()
    {
        var dtos = Read("llmgw/console-api/Models/Dtos.cs");
        Assert.DoesNotContain("ImageGenBuiltinPatternCatalog", dtos);

        var console = Read("llmgw/console-api/Program.cs");
        Assert.Contains("llmgw_imagegen_builtin_catalog", console);

        var worker = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");
        Assert.Contains("llmgw_imagegen_builtin_catalog", worker);
        Assert.Contains("ImageGenModelConfigs.Configs.Select(ImageGenConfigTranslation.BuiltinToBson)", worker);
    }

    /// <summary>
    /// 刷新器的接线：注册了、会周期跑、失败不清空。
    ///
    /// 这三件事各自断掉的样子都是「静悄悄的」：没注册就永远只有代码内置那份；
    /// 只跑一次就等于「改完要重启」；失败清空则会让配好的契约在一次网络抖动后消失，
    /// 生图尺寸突然变回旧档位而没人收到消息。
    /// </summary>
    [Fact]
    public void 刷新器接上了线且失败时不清空()
    {
        // 两个进程都得注册。
        //
        // ImageGenModelAdapterRegistry 是进程全局的静态表，而 serving 自己处理
        // /v1/images/generations 并直接读它。只在 MAP 注册的话，控制台配的契约在 MAP 里生效、
        // 在网关里完全不生效，而控制台那一屏照样显示「已同步」（它读的是 MAP 写的状态行）——
        // 外部走网关的生图请求全程用代码内置那份，没有任何地方会报错。
        var program = Read("prd-api/src/PrdAgent.Api/Program.cs");
        Assert.Contains("AddHostedService<PrdAgent.Infrastructure.LLM.ImageGenModelConfigSyncWorker>", program);
        var serving = Read("llmgw/serving/Program.cs");
        Assert.Contains("AddHostedService<PrdAgent.Infrastructure.LLM.ImageGenModelConfigSyncWorker>", serving);

        var worker = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");
        Assert.Contains("while (!stoppingToken.IsCancellationRequested)", worker);
        Assert.Contains("await Task.Delay(Interval, stoppingToken)", worker);

        // catch 块里只许记日志，不许 ReplaceOverrides——清空就是把配好的契约悄悄丢掉。
        var catchStart = worker.IndexOf("catch (Exception ex)", StringComparison.Ordinal);
        Assert.True(catchStart > 0);
        var catchBlock = worker[catchStart..worker.IndexOf("await Task.Delay(Interval", catchStart, StringComparison.Ordinal)];
        Assert.DoesNotContain("ReplaceOverrides", catchBlock);
    }
}
