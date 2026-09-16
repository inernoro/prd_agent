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

        // 界面得真的用它下结论，而不是只把字段接过来放着；
        // 而且「跟没跟上」这个判断要用服务端算好的那个（syncState），不要拿时间戳和版本号
        // 在前端再判一次——那就是同一个判据的第二份实现，两份迟早对不上（形状 3）。
        var panel = Read("llmgw/web/src/components/ImageGenContractsSection.tsx");
        Assert.Contains("syncNote", panel);
        Assert.Contains("data.syncedPatterns", panel);
        Assert.Contains("syncState", panel);
        Assert.Contains("已生效", panel);
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
    /// <summary>
    /// 两个进程的同步状态必须分行记，汇总必须取最保守的那一端。
    ///
    /// 生图契约是**进程全局**的注册表，prd-api 与 llmgw-serving 各跑一份同步器。
    /// 合成一行的话，健康的那个会不断覆盖失败的那个：控制台报「刚同步过、N 条生效」，
    /// 而走失败那个进程的请求还在用旧契约——降级被另一半的成功盖住，没有任何地方会响。
    ///
    /// 所以状态键带宿主角色、汇总时间取最旧、生效清单取交集，并逐进程给出明细，
    /// 让界面能答「是哪个进程没跟上」。
    /// </summary>
    [Fact]
    public void 同步状态按进程分行且汇总取最保守那一端()
    {
        var worker = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");
        var console = Read("llmgw/console-api/Program.cs");
        var section = Read("llmgw/web/src/components/ImageGenContractsSection.tsx");

        // 状态键带宿主角色 + 租户两个维度，且角色是必填构造参数——新增第三个宿主时不传就编译不过。
        // 断言的是这个键的**构成**，不是某一次写法：租户那一段从字段换成参数（多租户宿主要逐个
        // 租户写行）时，键的形状一个字都没变，而按字面量断言的守卫会当场红——那种红说明
        // 守卫测的是实现长什么样，不是它做到了什么（形状 4a）。
        Assert.Matches(@"\$""\{_hostRole\}::\{\w+\}""", worker);
        Assert.Contains("string hostRole,", worker);
        Assert.DoesNotContain("$\"prd-api::", worker);

        // 两处注册各自表明身份
        Assert.Contains("hostRole: \"prd-api\"", Read("prd-api/src/PrdAgent.Api/Program.cs"));
        Assert.Contains("hostRole: \"llmgw-serving\"", Read("llmgw/serving/Program.cs"));

        // 控制台逐进程读，汇总取最旧 + 交集，不是读一行
        Assert.Contains("expectedSyncHosts", console);
        Assert.Contains("Intersect", console);

        // 「有这一行状态」不等于「它还在跑」：停掉的 Worker 上次回写的那行会一直躺在库里，
        // 只判存在的话，界面会永远拿它那次陈年的成功替现在作答。所以要判新鲜度。
        Assert.Contains("staleAfterSeconds", console);
        Assert.Contains("\"stale\"", console);

        // 也不等于「它装的是我刚存的那一版」：改一条契约的尺寸档位，模式名一个字都不变，
        // 只比模式名的话改前改后都判「已生效」。所以两边各算一个内容版本号来比。
        Assert.Contains("ContentVersion", console);
        Assert.Contains("ContentVersion", worker);
        Assert.Contains("\"behind\"", console);

        // 汇总只由「会装本租户契约的那些进程」背书。把只装平台级契约的多租户进程
        // 算进交集的话，交集恒为空，这一屏就永远显示「0 条已生效」——一句不会兑现的话。
        Assert.Contains("tenantCarryingHosts", console);
        Assert.Contains("carriersCurrent", console);

        // 界面点名没跟上的那个进程，并且三种「没跟上」分开说（下一步完全不同）
        Assert.Contains("syncHosts", section);
        Assert.Contains("还没回写过同步状态", section);
        Assert.Contains("秒没动", section);
        Assert.Contains("装的还不是当前这一版", section);
    }

    /// <summary>
    /// 多租户宿主不把带租户的契约装进进程全局表，而且跳过了必须说出口。
    ///
    /// 这张覆盖表按模型名索引、没有租户维度，而全链路二十来个调用点都是静态方法、
    /// 拿不到请求的租户。所以在一个按请求密钥判定租户的宿主（llmgw-serving）里，
    /// 任何带租户的契约一旦装进去，就会作用到**所有**租户的请求上——A 租户配的尺寸
    /// 改写 B 租户的出图，而 B 自己配的那份反而不生效，两边都没有提示
    /// （cross-project-isolation：一份全局状态被多方共享）。
    ///
    /// 第二半同样要钉住：跳过之后控制台会显示「生效 0 条」，不把跳过条数与原因报上去，
    /// 那句话就无从解释，人会去查一个没坏的东西（degradation-must-alarm）。
    /// </summary>
    [Fact]
    public void 多租户宿主不装带租户的契约且跳过必须报出来()
    {
        var worker = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");

        // 租户形态是必填构造参数：新增宿主时不表态就编译不过，
        // 而不是留个默认值再靠这条守卫抽查。
        Assert.Contains("ImageGenContractHostTenancy tenancy,", worker);

        // 过滤按租户形态分叉：单租户宿主才认自己那个租户的契约。
        Assert.Contains("ImageGenContractHostTenancy.SingleTenant", worker);
        Assert.Contains("tenantScopeFilter", worker);

        // 跳过的条数要数出来并回写状态，不能只是悄悄少装几条。
        Assert.Contains("SkippedTenantScopedCount", worker);
        Assert.Contains("HostTenancy", worker);

        // 两处注册都得表态，且 serving 必须是多租户那一档。
        // 断言的是「这个宿主声明了哪种租户形态」，不是某一种写法——
        // 它要是被改成 SingleTenant，serving 就会重新变成跨租户改写的通道。
        Assert.Contains("ImageGenContractHostTenancy.SingleTenant", Read("prd-api/src/PrdAgent.Api/Program.cs"));
        Assert.Contains("ImageGenContractHostTenancy.MultiTenant", Read("llmgw/serving/Program.cs"));
        Assert.DoesNotContain("ImageGenContractHostTenancy.SingleTenant", Read("llmgw/serving/Program.cs"));

        // 控制台把这两个字段读出来，界面把它说成人话。
        var console = Read("llmgw/console-api/Program.cs");
        Assert.Contains("SkippedTenantScopedCount", console);
        var section = Read("llmgw/web/src/components/ImageGenContractsSection.tsx");
        Assert.Contains("skippedTenantScopedCount", section);
        Assert.Contains("再等也不会变", section);
    }

    /// <summary>
    /// 范围模式必须真的有边界，空的范围契约不许保存。
    ///
    /// NormalizeSizeRange 只在最小/最大宽高、最大像素、整除这几个字段有值时才动尺寸。
    /// 一个都不填的「范围」契约保存成功、界面显示「已按范围约束」，实际什么都不约束：
    /// 尺寸原样发给上游，被拒时看不出是这里没配（形状 8：一份不成立的声明被当成已配好）。
    ///
    /// 拦在写入侧而不是只靠界面记得填：契约也可能从别的写入方进来。
    /// 界面那一侧同时要给出这几个输入框——只拦不给填，等于把这个选项变成一个死选项。
    /// </summary>
    [Fact]
    public void 范围模式必须至少填一项边界()
    {
        var console = Read("llmgw/console-api/Program.cs");
        Assert.Contains("范围模式至少要填一项边界", console);
        Assert.Contains("body.MinWidth is null && body.MaxWidth is null", console);
        Assert.Contains("body.MaxPixels is null && body.MustBeDivisibleBy is null", console);

        // 「填了」不等于「起作用」：0 与 1 这些值运行时会跳过（最小值、整除），
        // 而 0 作为最大值更糟——把请求夹成 0x0 发出去。所以判的是有效边界，不是有没有值。
        Assert.Contains("范围模式的宽高边界必须大于 0", console);
        Assert.Contains("边长整除必须大于 1", console);
        Assert.Contains("最小宽不能大于最大宽", console);

        // 几项单独合法、合起来无解的也要拦：整除向上取整超过最大值，
        // 或最小边长与像素上限打架（运行时先套最小值再按像素缩放，缩完反而违反最小值）。
        Assert.Contains("这套范围无解", console);
        // 同模式唯一升成库级约束：端点里的「先查有没有同模式」拦不住两个人同时建，
        // 两条都进库后同步器把两条都装进按模式索引的表，TryMatch 取先返回的那条，
        // 生图的尺寸与参数翻译于是每次刷新可能不一样。
        Assert.Contains("uniq_llmgw_imagegen_tenant_pattern", console);
        Assert.Contains("刚刚由别人建的", console);
        Assert.Contains("SmallestSide", console);

        // 配了整除就必须两个最小值都给：运行时对宽高各做一次向下取整，
        // 没被最小值托住的那个轴，比除数小的边长会被抹成 0，发出去是 1024x0。
        // 判据不能写成「两个都没配才拦」——那只拦住了两个轴同时出问题的那一种。
        Assert.Contains("body.MinWidth is null || body.MinHeight is null", console);
        Assert.Contains("必须同时给出最小宽和最小高", console);

        var section = Read("llmgw/web/src/components/ImageGenContractsSection.tsx");
        Assert.Contains("editing.draft.sizeConstraintType === 'range'", section);
        foreach (var field in new[] { "minWidth", "maxWidth", "minHeight", "maxHeight", "maxPixels", "mustBeDivisibleBy" })
        {
            Assert.Contains($"'{field}'", section);
        }
    }

    [Fact]
    public void 刷新器接上了线且失败时不清空()
    {
        // 两个进程都得注册。
        //
        // ImageGenModelAdapterRegistry 是进程全局的静态表，而 serving 自己处理
        // /v1/images/generations 并直接读它。只在 MAP 注册的话，控制台配的契约在 MAP 里生效、
        // 在网关里完全不生效，而控制台那一屏照样显示「已同步」（它读的是 MAP 写的状态行）——
        // 外部走网关的生图请求全程用代码内置那份，没有任何地方会报错。
        // 断言的是「两个进程都注册了这个 Worker」这件事，不是某一种注册写法——
        // 写法后来从泛型改成工厂（要传宿主角色），判据跟着退化成「某段代码字面存在」
        // 就会在下一次重构时再红一次（形状 4a：断言实现的字面存在而不是行为）。
        var program = Read("prd-api/src/PrdAgent.Api/Program.cs");
        Assert.Contains("ImageGenModelConfigSyncWorker(", program);
        Assert.Contains("AddHostedService", program);
        var serving = Read("llmgw/serving/Program.cs");
        Assert.Contains("ImageGenModelConfigSyncWorker(", serving);
        Assert.Contains("AddHostedService", serving);

        var worker = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");
        Assert.Contains("while (!stoppingToken.IsCancellationRequested)", worker);
        Assert.Contains("await Task.Delay(Interval, stoppingToken)", worker);

        // catch 块里只许记日志，不许 ReplaceOverrides——清空就是把配好的契约悄悄丢掉。
        var catchStart = worker.IndexOf("catch (Exception ex)", StringComparison.Ordinal);
        Assert.True(catchStart > 0);
        var catchBlock = worker[catchStart..worker.IndexOf("await Task.Delay(Interval", catchStart, StringComparison.Ordinal)];
        Assert.DoesNotContain("ReplaceOverrides", catchBlock);
    }

    /// <summary>
    /// 多租户宿主的同步状态必须逐个租户各写一行。
    ///
    /// 状态行的 _id 是 `{宿主}::{租户}`，控制台按登录租户去查。多租户宿主只写自己内部租户
    /// 那一行的话，每个外部租户查到的都是「没有记录」，界面据此说「同步从未发生、进程可能挂了」
    /// ——一个正常运转、只是刻意跳过了他那几条契约的进程被报成疑似宕机。而真原因就写在
    /// 那一行里，只是写到了他看不见的地方：降级响了铃，却没响给当事人听。
    ///
    /// 跳过条数也要按租户各算各的：一个合计数答不出「其中几条是我的」。
    /// </summary>
    [Fact]
    public void 多租户宿主逐个租户写同步状态且跳过条数按租户算()
    {
        var worker = Read("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");

        // 跳过的那些要按租户分组，而不是只数一个总数。
        Assert.Contains("skippedByTenant", worker);
        Assert.Contains("GroupBy(x => x.TenantId.Trim()", worker);

        // 写状态收敛成一个函数，宿主自己那一行与各租户那几行走同一条路——
        // 两处各拼一份文档，迟早出现「外部租户那行少了个字段」。
        Assert.Contains("BsonDocument BuildStatus(string tenantId, int skippedForTenant)", worker);
        Assert.Contains("async Task WriteStatusAsync(string tenantId, int skippedForTenant)", worker);

        // 逐租户那一段只在多租户宿主发生，且跳过条数取的是这个租户自己的数。
        var perTenantAt = worker.IndexOf("skippedByTenant.Keys", StringComparison.Ordinal);
        var multiTenantGateAt = worker.LastIndexOf(
            "if (_tenancy == ImageGenContractHostTenancy.MultiTenant)",
            perTenantAt,
            StringComparison.Ordinal);
        Assert.True(
            perTenantAt > 0 && multiTenantGateAt > 0,
            "逐租户写状态那一段必须挂在「这是多租户宿主」这个判断下面");
        Assert.Contains("skippedByTenant.GetValueOrDefault(tenantId, 0)", worker);

        // 已经有行的租户即使这一轮一条契约都不剩也要刷一次，否则它停在上一轮的数字上，
        // 变成一条越来越旧的假话。
        Assert.Contains("knownTenantIds", worker);
    }
}
