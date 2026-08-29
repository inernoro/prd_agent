using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 开场问题自动生成的两处判据：解析模型输出、判断该不该生成。
///
/// 两个都是纯函数，也都是这功能里最容易悄悄退化的地方——
/// 解析退化的表现是「题库突然空了」，判据退化的表现是「owner 改的几句被冲掉」
/// 或「每个访客都触发一次模型调用」，三种都不会有任何测试自己变红。
/// </summary>
public class AskOpeningQuestionGeneratorTests
{
    // ── ParseGenerated ──

    [Fact]
    public void 裸数组_原样解析()
    {
        var got = AskOpeningQuestions.ParseGenerated("[\"结论是什么？\",\"哪几项没修完？\"]");
        Assert.Equal(new[] { "结论是什么？", "哪几项没修完？" }, got);
    }

    [Fact]
    public void 带代码围栏和前后寒暄_照样解析()
    {
        const string raw = "好的，我读完了这一页。\n```json\n[\"结论是什么？\", \"搜索为什么没通过？\"]\n```\n希望有帮助。";
        var got = AskOpeningQuestions.ParseGenerated(raw);
        Assert.Equal(new[] { "结论是什么？", "搜索为什么没通过？" }, got);
    }

    [Fact]
    public void 模型把每条包成对象_也认()
    {
        var got = AskOpeningQuestions.ParseGenerated("[{\"question\":\"结论是什么？\"},{\"text\":\"还差什么？\"}]");
        Assert.Equal(new[] { "结论是什么？", "还差什么？" }, got);
    }

    [Fact]
    public void 认不出来就返回空_不许硬凑()
    {
        // 宁可这一栏整块不出现，也不摆几句放到任何页面都成立的空话（no-rootless-tree）
        Assert.Empty(AskOpeningQuestions.ParseGenerated("这一页没有实质内容。"));
        Assert.Empty(AskOpeningQuestions.ParseGenerated("[\"没闭合的数组"));
        Assert.Empty(AskOpeningQuestions.ParseGenerated(""));
        Assert.Empty(AskOpeningQuestions.ParseGenerated(null));
    }

    [Fact]
    public void 对象包裹的数组要捞出来_不算认不出来()
    {
        // 解析器有意只认最外层的 [...]，围栏、前言、对象包裹一刀切掉——模型把清单裹进
        // {"questions": [...]} 是最常见的输出形状之一，那是一份**真实的**清单，扔掉它
        // 才是丢信息。这条与上面那条不矛盾：上面守的是「认不出来时不许硬凑」，
        // 这条守的是「认得出来时不许装作认不出来」。
        var got = AskOpeningQuestions.ParseGenerated("{\"questions\":[\"这是对象包着的\"]}");
        Assert.Equal(new[] { "这是对象包着的" }, got);
    }

    [Fact]
    public void 去重_去空_截断_限量_全都走同一套Normalize()
    {
        var raw = "[\"重复的\",\"重复的\",\"  \",\"" + new string('长', 80) + "\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"]";
        var got = AskOpeningQuestions.ParseGenerated(raw);
        Assert.Equal(AskOpeningQuestions.GeneratedCount, got.Count);
        Assert.Equal("重复的", got[0]);
        Assert.All(got, q => Assert.True(q.Length <= AskOpeningQuestions.MaxLength));
        Assert.Equal(got.Count, new HashSet<string>(got).Count);
    }

    [Fact]
    public void 一次最多生成几条_必须夹在展示上限与题库上限之间()
    {
        // 只生成 MaxDisplay 条 → 分享链接无从挑子集；一次塞满 MaxLibrary → owner 加不进自己的题
        Assert.True(AskOpeningQuestions.GeneratedCount > AskOpeningQuestions.MaxDisplay);
        Assert.True(AskOpeningQuestions.GeneratedCount < AskOpeningQuestions.MaxLibrary);
    }

    // ── NeedsGeneration ──

    private static HostedSite SiteWithAsk(Action<HostedSite>? tweak = null)
    {
        var site = new HostedSite
        {
            Id = "site-1",
            OwnerUserId = "u1",
            AskEnabled = true,
            ContentVersion = new DateTime(2026, 8, 26, 0, 0, 0, DateTimeKind.Utc),
        };
        tweak?.Invoke(site);
        return site;
    }

    [Fact]
    public void 提问没开就不生成_默认关闭时给每个上传都跑一遍模型是纯浪费()
    {
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(SiteWithAsk(s => s.AskEnabled = false)));
        Assert.True(AskOpeningQuestionGenerator.NeedsGeneration(SiteWithAsk()));
    }

    [Fact]
    public void owner_动过手就永不覆盖()
    {
        var site = SiteWithAsk(s => s.AskQuestionsSource = "manual");
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(site));
    }

    [Fact]
    public void 存量站点手写的题也算动过手_没有_source_字段时不许当成系统生成的()
    {
        // AskQuestionsSource 是本功能才引入的字段。在它之前建的站点里根本没有这个字段，
        // 反序列化出来是 null，而那时候题库里的每一条都只可能是 owner 自己填的。
        // 按「不是 manual 就当 auto」判，他打开一次设置面板、或者访客打开一次分享页，
        // 精心写的几句就被静默冲掉了——本功能声明的不变量正是「手写过的永不被覆盖」。
        var legacy = SiteWithAsk(s =>
        {
            s.AskQuestionsSource = null;
            s.AskSuggestedQuestions = new List<string> { "这份方案的取舍是什么？" };
        });
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(legacy));

        // 空串（有些写路径会落成空串而不是缺字段）同样按存量手写处理
        var legacyBlankSource = SiteWithAsk(s =>
        {
            s.AskQuestionsSource = "";
            s.AskSuggestedQuestions = new List<string> { "这份方案的取舍是什么？" };
        });
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(legacyBlankSource));
    }

    [Fact]
    public void 读出来的来源标签必须与要不要生成同一个答案()
    {
        // 写那一侧判成 manual（不覆盖，对的）、读那一侧兜底成 auto，面板就会把 owner 手写的题
        // 标成「系统读正文生成」，还配一句「你改过之后就不再被自动覆盖」的解释——等于主动
        // 劝他点重新生成把自己那份冲掉。保护写入却在读出时劝人自毁，比两边都不保护更糟。
        var cases = new[]
        {
            SiteWithAsk(s => { s.AskQuestionsSource = null; s.AskSuggestedQuestions = new List<string> { "存量手写" }; }),
            SiteWithAsk(s => { s.AskQuestionsSource = ""; s.AskSuggestedQuestions = new List<string> { "存量手写" }; }),
            SiteWithAsk(s => s.AskQuestionsSource = "manual"),
            SiteWithAsk(s => { s.AskQuestionsSource = null; s.AskSuggestedQuestions = new List<string>(); }),
            SiteWithAsk(s => { s.AskQuestionsSource = "auto"; s.AskSuggestedQuestions = new List<string> { "系统写的" }; }),
        };

        foreach (var site in cases)
        {
            var manualBySource = AskOpeningQuestions.ResolveSource(site) == AskOpeningQuestions.SourceManual;
            // 判成手写 = 不生成；判成系统生成 = 该不该生成由版本戳决定，这里的站点都还没盖过戳
            Assert.Equal(!manualBySource, AskOpeningQuestionGenerator.NeedsGeneration(site));
        }
    }

    [Fact]
    public void 存量站点没有题就没有东西要保护_照常生成()
    {
        // 上一条的边界：不能因为「没有 source」就一律不生成，那样新上传的站点永远拿不到题。
        var emptyLegacy = SiteWithAsk(s =>
        {
            s.AskQuestionsSource = null;
            s.AskSuggestedQuestions = new List<string>();
        });
        Assert.True(AskOpeningQuestionGenerator.NeedsGeneration(emptyLegacy));
    }

    [Fact]
    public void 系统生成过的题不受存量判据影响_正文换了还要重算()
    {
        // 自动生成写题时一定同时写 source=auto，所以它不会被上面那条存量判据挡住。
        var generated = SiteWithAsk(s =>
        {
            s.AskQuestionsSource = "auto";
            s.AskSuggestedQuestions = new List<string> { "系统写的一条" };
            s.AskQuestionsGeneratedFor = s.ContentVersion.AddDays(-1);
        });
        Assert.True(AskOpeningQuestionGenerator.NeedsGeneration(generated));
    }

    [Fact]
    public void 这一版正文算过就不重算_一次上传一次调用()
    {
        var site = SiteWithAsk();
        site.AskQuestionsGeneratedFor = site.ContentVersion;
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(site));

        // 重新上传换了 ContentVersion → 旧那批题是对着旧内容写的，要重算
        site.ContentVersion = site.ContentVersion.AddDays(1);
        Assert.True(AskOpeningQuestionGenerator.NeedsGeneration(site));
    }

    [Fact]
    public void 读不出正文时盖的戳同样算数_否则每个访客都触发一次重试()
    {
        // 生成器在「读不到正文」与「模型没给出可用问题」两条路径上都只盖戳、不写题库。
        // 判据必须认这个戳，不然一个永远读不出正文的站点会被每个访客各排一次生成。
        var site = SiteWithAsk();
        site.AskQuestionsGeneratedFor = site.ContentVersion;
        site.AskSuggestedQuestions = new List<string>();
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(site));
    }

    [Fact]
    public void 存量站点没有ContentVersion时回退到CreatedAt_而不是每次都判成要重算()
    {
        var site = SiteWithAsk(s =>
        {
            s.ContentVersion = default;
            s.CreatedAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        });
        Assert.True(AskOpeningQuestionGenerator.NeedsGeneration(site));

        site.AskQuestionsGeneratedFor = site.CreatedAt;
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(site));
    }
}

/// <summary>
/// 接线守卫：生成器建好了、判据也对，但没人调它 —— 那就是建了一半
/// （predicate-and-wiring-discipline 形状 2：删掉不会红，只会静默退化成「题库永远是空的」）。
///
/// 按源码守是因为这几处调用全是 fire-and-forget，去掉任何一处都没有行为测试会变红。
/// </summary>
public class AskOpeningQuestionWiringTests
{
    private static string ReadSrc(string relative)
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !Directory.Exists(Path.Combine(dir, "src", "PrdAgent.Api")))
            dir = Directory.GetParent(dir)?.FullName;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!, relative));
    }

    [Fact]
    public void 开启提问与重新上传都要排一次生成()
    {
        var svc = ReadSrc(Path.Combine("src", "PrdAgent.Infrastructure", "Services", "HostedSiteService.cs"));
        // 三处：开启提问、重新上传换了正文、分享页兜底（存量站点走不到前两处）
        Assert.Equal(3, Regex.Matches(svc, @"_askOpeners\.QueueEnsure\(").Count);
        Assert.Contains("SetAskConfigAsync", svc);
    }

    [Fact]
    public void owner_打开设置面板时也兜一次_并且有重新生成的入口()
    {
        var ctrl = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));
        Assert.Contains("_askOpeners.QueueEnsure(site)", ctrl);
        Assert.Contains("ask/questions/regenerate", ctrl);
        Assert.Contains("_askOpeners.EnsureAsync(", ctrl);
        // 来源必须透出去：自动填的值不能是黑箱（minimal-user-input 第 3 条）
        Assert.Contains("questionsSource", ctrl);
    }

    [Fact]
    public void 四种失败各有各的下一步_不许在接口上压成一句失败了()
    {
        // NoContent 重试没用、ModelUnavailable 值得过会儿再点、ModelUnusable 该自己加一条、
        // Skipped 压根不需要生成。压成一个 bool 就只能给用户一句放之四海而皆准的「失败了」。
        var ctrl = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));
        foreach (var name in new[] { "NoContent", "ModelUnusable", "ModelUnavailable", "Generated" })
            Assert.Contains($"AskOpenerOutcome.{name}", ctrl);
    }

    [Fact]
    public void 模型调不通不许盖版本戳_否则网关一次故障就固化成永久结论()
    {
        // 真栽过：验收当天这套部署 model_groups 是空的，第一次自动生成就把版本戳盖死了，
        // 池子配好之后它再也不会自己重试。判据是「模型有没有给出任何输出」。
        var gen = ReadSrc(Path.Combine("src", "PrdAgent.Infrastructure", "Services", "AskOpeningQuestionGenerator.cs"));
        // 取窗停在这一档自己的出口：整段方法体会读进下一档（「答了但没法用」），
        // 而那一档本来就该盖戳——守卫会对着正确实现常红。
        var branch = SourceSlice.Between(gen, "if (callFailed || raw.Length == 0)", "return AskOpenerOutcome.ModelUnavailable;");
        Assert.DoesNotContain("StampAsync", branch);
        Assert.Contains("_cooldownUntil", branch);
    }

    [Fact]
    public void 流中途报错要算调用失败_不能把残句当正常回答()
    {
        // 网关把失败报成 error chunk 而不是抛异常。只读 delta 的话「先吐几个字再断」
        // 会被当成正常回答：callFailed 仍是 false、raw 非空，残句拿去解析，解析不出就盖戳。
        var gen = ReadSrc(Path.Combine("src", "PrdAgent.Infrastructure", "Services", "AskOpeningQuestionGenerator.cs"));
        // error 必须在 delta 之前就被判掉
        var beforeDelta = SourceSlice.Between(gen, "await foreach (var chunk in client.StreamGenerateAsync(", "chunk.Type == \"delta\"");
        // error 必须在 delta 之前就被判掉，且要真的翻 callFailed——只记日志不算
        Assert.Contains("chunk.Type == \"error\"", beforeDelta);
        Assert.Contains("callFailed = true", beforeDelta);
    }

    [Fact]
    public void 这一版得不出题就要清空题库_不许留着上一版内容写的题()
    {
        // 站点重传成不相干的内容后，版本戳指向新正文，而分享页还在展示按旧正文写的问题——
        // 那是在拿旧内容的口径描述新页面。owner 手写的那份不受影响（过滤器有 manual 判据）。
        var gen = ReadSrc(Path.Combine("src", "PrdAgent.Infrastructure", "Services", "AskOpeningQuestionGenerator.cs"));
        var body = SourceSlice.Member(gen, "private static async Task<bool> StampAsync(");
        Assert.Contains("questions ?? new List<string>()", body);
        // 不许退回「为 null 就不写这个字段」的老写法
        Assert.DoesNotContain("if (questions != null)", body);
        // 判据写成「不管用 LINQ 还是 filter builder，manual 这条都得在过滤器里」：
        // 上一版钉的是 `AskQuestionsSource != "manual"` 这串字面量，过滤器一改成
        // Builders 写法就假红——守卫钉住了被测代码的偶然形状，不是它的不变量。
        Assert.Matches(
            new Regex("AskQuestionsSource\\s*!=\\s*\"manual\"|Ne\\([^)]*AskQuestionsSource\\s*,\\s*\"manual\""),
            body);
    }

    [Fact]
    public void 一个字都没生成出来的失败必须退配额_三条失败出口都要走()
    {
        // 用户报的：界面显示「回答失败了」，右上角剩余次数照样减一。网关没配模型池那阵子
        // 每问一次白烧一次额度。判据是「有没有产出」而不是「有没有报错」——答到一半断掉的
        // token 已经花了，不该退。
        //
        // 三条失败出口都得走同一个判据：网关 Error chunk、外层 catch、以及「流正常收尾但
        // 一个字都没吐」。第三条是后加的——它长得最不像失败（上游没报错、流也正常结束），
        // 正因如此最容易在加新出口时被漏掉，所以这里钉的是**出口总数**而不只是「有调用」。
        var ctrl = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));
        Assert.Equal(4, Regex.Matches(ctrl, @"RefundIfNothingProducedAsync\(\)").Count); // 1 处定义 + 3 处调用
        var idx = ctrl.IndexOf("async Task RefundIfNothingProducedAsync()", StringComparison.Ordinal);
        Assert.True(idx > 0);
        var body = ctrl.Substring(idx, Math.Min(420, ctrl.Length - idx));
        // 三个条件（没产出 / 扣成过 / 还没退过）的唯一判定源是 AskAccessPolicy.ShouldRefundQuota，
        // 它在 AskQuotaRefundGateTests 里逐条验过。这里钉的是「这条线还接在那个判定源上」——
        // 谁要是在这里就地又写一遍条件，那些行为用例就会变成空转（改坏了也不红）。
        // 原先这里断言的是字面量 `answer.Length > 0`，判据一抽走它就红，钉的是写法不是不变量。
        Assert.Contains("AskAccessPolicy.ShouldRefundQuota(", body);
        Assert.Contains("RefundAsync", body);
    }

    [Fact]
    public void 提问配置的写路径必须过角色门_可见不等于可写()
    {
        // GetByIdAsync 答的是「看不看得见」，对任一共享团队成员（含 viewer）都放行。
        // 而排队生成 / 重新生成都是写库 + 一次算在 owner 头上的模型调用。拿可见性当写权限，
        // viewer 打开设置面板就能替 owner 烧钱并覆盖他手写的题库。
        var ctrl = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));
        var svc = ReadSrc(Path.Combine("src", "PrdAgent.Infrastructure", "Services", "HostedSiteService.cs"));

        // 判据只有一份：SetAskConfigAsync 与两条新路径共用 CanMaintainAskAsync
        Assert.Contains("public async Task<bool> CanMaintainAskAsync(string siteId, string userId", svc);
        Assert.Contains("if (!await CanMaintainAskAsync(site, userId, ct)) return null;", svc);
        Assert.Equal(2, Regex.Matches(ctrl, @"CanMaintainAskAsync\(siteId, this\.GetRequiredUserId\(\)\)").Count);

        // 排队那处必须是「有权才排」，不是排完再说
        Assert.Contains("if (await _siteService.CanMaintainAskAsync(siteId, this.GetRequiredUserId()))\n            _askOpeners.QueueEnsure(site);", ctrl.Replace("\r\n", "\n"));
        // 重新生成那处必须在任何写库之前就挡下
        var regenAt = ctrl.IndexOf("public async Task<IActionResult> RegenerateAskQuestions", StringComparison.Ordinal);
        Assert.True(regenAt > 0);
        var gateAt = ctrl.IndexOf("CanMaintainAskAsync", regenAt, StringComparison.Ordinal);
        var writeAt = ctrl.IndexOf("UpdateOneAsync", regenAt, StringComparison.Ordinal);
        Assert.True(gateAt > 0 && gateAt < writeAt, "角色门必须排在清 manual 标记那笔写之前");
    }

    [Fact]
    public void 盖戳要求正文版本没变过_跑一半被重传就整笔不写()
    {
        // 生成要跑几秒，这期间站点可能被重传。按旧正文算出来的题盖到新版本上，
        // 等于用旧内容的口径描述新页面，还会把版本戳推到新版、堵住下一次自动生成。
        var gen = ReadSrc(Path.Combine("src", "PrdAgent.Infrastructure", "Services", "AskOpeningQuestionGenerator.cs"));
        var body = SourceSlice.Member(gen, "private static async Task<bool> StampAsync(");
        // 正文版本判据已收敛成认领与盖戳共用的那一份；这里钉「盖戳有没有过这道判据」，
        // 判据本身对不对由真打 Mongo 的 AskOpenerLegacyContentVersionTests 证明。
        Assert.Contains("ContentVersionIs(version)", body);
        // 版本口径必须与 NeedsGeneration 那处一致：存量站点没有 ContentVersion，回退 CreatedAt。
        // 而「没有这个字段」在 Mongo 里有两种形状——存了零值、与字段压根不存在；只认前者
        // 会让所有老站点认领必然落空且不报错，所以 $exists:false 那一支也必须在。
        var versionPredicate = SourceSlice.Member(
            gen, "internal static FilterDefinition<HostedSite> ContentVersionIs(");
        Assert.Contains("s.CreatedAt, version", versionPredicate);
        Assert.Contains("Exists(s => s.ContentVersion, false)", versionPredicate);
    }

    [Fact]
    public void 生成器已注册进DI_否则每个消费方启动即炸()
    {
        var program = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Program.cs"));
        Assert.Matches(@"AddSingleton<[^>]*IAskOpeningQuestionGenerator[^>]*>", program);
    }

    [Fact]
    public void 回给面板的来源标签不许再自己兜底成_auto()
    {
        // 判据只有 AskOpeningQuestions.ResolveSource 一处。谁在读端点里写 `?? "auto"`，
        // 谁就把存量站点 owner 手写的题标成了系统生成——而那正是上一轮刚保护住的数据。
        var ctrl = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));

        Assert.DoesNotContain("AskQuestionsSource ?? \"auto\"", ctrl);
        Assert.Contains("AskOpeningQuestions.ResolveSource(site)", ctrl);
        Assert.Contains("AskOpeningQuestions.ResolveSource(latest)", ctrl);
    }

    [Fact]
    public void 流正常结束但一个字没有_必须走退款与报错_不许报成功()
    {
        // 上游允许「正常收尾但空响应」这种形状（LlmGateway.StreamAsync 对空响应只记
        // 一条 warning 就放行）。落到端点如果照旧报 done，访客看到的是一个空气泡被标成
        // 「答完了」，而额度已经扣掉且不会退——扣了钱、没给东西、还告诉他成功了。
        var ctrl = ReadSrc(Path.Combine(
            "src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));

        Assert.Contains("answer.Length == 0", ctrl);
        Assert.Contains("ASK_EMPTY_ANSWER", ctrl);

        // 这一支必须排在写 done 之前，否则先报成功再判空等于没判
        var emptyAt = ctrl.IndexOf("answer.Length == 0", StringComparison.Ordinal);
        var doneAt = ctrl.IndexOf("WriteSseAsync(\"done\"", StringComparison.Ordinal);
        Assert.True(emptyAt > -1 && doneAt > emptyAt,
            "空答案判定必须排在 done 之前");

        // 且这一支要退款：只报错不退款，等于用户为一个空答案付了钱
        var branch = ctrl.Substring(emptyAt, Math.Max(0, doneAt - emptyAt));
        Assert.Contains("RefundIfNothingProducedAsync", branch);
    }

    [Fact]
    public void 重新生成没写成时_必须把手写标记还回去()
    {
        // 「重新生成」的前提是先清掉 manual 标记与版本戳，否则 NeedsGeneration 直接返回。
        // 但这一发可能一个字都不写（模型不通 / 已有一次在跑 / 算完发现被顶掉）。
        // 不还原的话，owner 手写的题还躺在库里、却没了保护：网关一恢复，下一次读配置或
        // 访客打开分享页就把它静默覆盖——而他收到的回复明明是「这次没成功」。
        var ctrl = ReadSrc(Path.Combine(
            "src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));

        // 清除之前必须先记下原样
        var priorAt = ctrl.IndexOf("var priorSource = site.AskQuestionsSource;", StringComparison.Ordinal);
        Assert.True(priorAt > -1, "没有先记下原来的 source，还原就无从谈起");
        // 清除那一笔要在「记原样」**之后**。这里必须从 priorAt 往后找：还原已抽成
        // RestorePriorAskSourceAsync，它排在文件更靠前的位置、里面同样有这个 Unset，
        // 用 IndexOf 取全文首次出现会命中那个辅助方法，把顺序判成反的。
        var clearAt = ctrl.IndexOf("Unset(s => s.AskQuestionsGeneratedFor)", priorAt, StringComparison.Ordinal);
        Assert.True(clearAt > priorAt, "记原样必须排在清除之前");

        // 只有真的落库的那三种结局不还原，其余都要还
        Assert.Contains("AskOpenerOutcome.Generated", ctrl);
        Assert.Contains("priorStamp.HasValue", ctrl);

        // 还原要带条件，别把并发那一发刚写好的结果盖掉。
        //
        // 条件本身**不在这里断**：它已经由 AskRegenerateRestoreTests 打真库逐种并发状态验过，
        // 那是行为，比在源码里找字符串可靠得多。这里只钉这条线还接在唯一那个判据上——
        // 谁要是在这里就地又写一遍过滤条件，那些行为用例就会变成空转（改坏了也不红）。
        Assert.Contains("UpdateOneAsync(RestoreAskSourceFilter(siteId), restore)", ctrl);
        var condCount = System.Text.RegularExpressions.Regex
            .Matches(ctrl, @"AskQuestionsGeneratedFor == null").Count;
        Assert.True(condCount == 1,
            $"还原条件只许有 RestoreAskSourceFilter 这一处定义，实际出现 {condCount} 次——"
            + "抄第二份就会各自漂移，打真库的那几条用例也会变成空转");
    }
}
