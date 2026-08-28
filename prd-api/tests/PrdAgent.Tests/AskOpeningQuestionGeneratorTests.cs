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
        Assert.Contains("AskQuestionsSource != \"manual\"", body);
    }

    [Fact]
    public void 一个字都没生成出来的失败必须退配额_两条失败出口都要走()
    {
        // 用户报的：界面显示「回答失败了」，右上角剩余次数照样减一。网关没配模型池那阵子
        // 每问一次白烧一次额度。判据是「有没有产出」而不是「有没有报错」——答到一半断掉的
        // token 已经花了，不该退。两条失败出口（网关 Error chunk / 外层 catch）都得走同一个判据。
        var ctrl = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));
        Assert.Equal(3, Regex.Matches(ctrl, @"RefundIfNothingProducedAsync\(\)").Count); // 1 处定义 + 2 处调用
        var idx = ctrl.IndexOf("async Task RefundIfNothingProducedAsync()", StringComparison.Ordinal);
        Assert.True(idx > 0);
        var body = ctrl.Substring(idx, Math.Min(320, ctrl.Length - idx));
        Assert.Contains("answer.Length > 0", body);
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
        Assert.Contains("s.ContentVersion == version", body);
        // 版本口径必须与 NeedsGeneration 那处一致（存量站点没有 ContentVersion，回退 CreatedAt）
        Assert.Contains("s.ContentVersion == default && s.CreatedAt == version", body);
    }

    [Fact]
    public void 生成器已注册进DI_否则每个消费方启动即炸()
    {
        var program = ReadSrc(Path.Combine("src", "PrdAgent.Api", "Program.cs"));
        Assert.Matches(@"AddSingleton<[^>]*IAskOpeningQuestionGenerator[^>]*>", program);
    }
}
