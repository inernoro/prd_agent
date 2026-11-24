using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 开场问题生成的跨进程认领与冷却表守卫（Codex 第三十轮）。
///
/// 两条都只在「同一站点同一版被两个进程同时排上生成」时才现形，而那需要两个真实
/// 部署 + 共用 Mongo，单测造不出来；判据因此钉在结构上——认领必须存在、必须排在
/// 花钱的动作之前、盖戳必须要求这一版还没被盖过。
/// </summary>
public class AskOpenerClaimTests
{
    private static string Source() => File.ReadAllText(Path.Combine(
        LocateSrcRoot(), "PrdAgent.Infrastructure", "Services", "AskOpeningQuestionGenerator.cs"));

    /// <summary>
    /// 认领必须排在取快照与调模型**之前**。
    ///
    /// 进程内的 _inFlight 只挡得住同一个进程：两个 CDS 分支部署、或同一部署的两个副本
    /// 共用一个 Mongo，两边都能过那道门，于是同一版正文被调两次模型——owner 付两次钱。
    /// 认领晚于花钱的动作就没有意义，所以这里钉的是顺序，不只是「有没有」。
    /// </summary>
    [Fact]
    public void 认领必须排在调模型之前()
    {
        var src = Source();
        var run = src[src.IndexOf("private async Task<AskOpenerOutcome> RunAsync", StringComparison.Ordinal)..];

        var claim = run.IndexOf("TryClaimAsync(", StringComparison.Ordinal);
        var snapshot = run.IndexOf("snapshots.GetAsync(", StringComparison.Ordinal);

        Assert.True(claim > 0, "RunAsync 里没有跨进程认领，两个进程会各调一次模型");
        Assert.True(snapshot > 0, "找不到取快照那一步，测试该跟着改");
        Assert.True(claim < snapshot, "认领排在了花钱的动作之后，等于没拦住重复计费");
    }

    /// <summary>认领是 CAS：要么没人持有，要么租约已过期，才轮得到自己。</summary>
    [Fact]
    public void 认领是原子CAS且带租约()
    {
        var src = Source();
        var head = MemberBody(src, "TryClaimAsync");

        // 判据不钉写法：LINQ 的 `== null` 与 filter builder 的 `Eq(..., null)` 是同一件事，
        // 钉住其中一种就会在换写法时假红（守卫依赖被测代码的偶然形状，今天已第四次）。
        Assert.Matches(
            new Regex(@"AskOpenerClaimedAt\s*==\s*null|Eq\([^;]*AskOpenerClaimedAt[^;]*null"),
            head);
        Assert.Contains("staleBefore", head);
        // 抢不到时必须让路，而不是继续往下跑
        Assert.Contains("MatchedCount > 0", head);
    }

    /// <summary>盖戳要求这一版还没被盖过——否则后到的那笔会覆盖先到的结果。</summary>
    [Fact]
    public void 盖戳不许覆盖已经盖过的同一版()
    {
        var src = Source();
        var stamp = src[src.IndexOf("private static async Task<bool> StampAsync", StringComparison.Ordinal)..];

        Assert.Matches(
            new Regex(@"AskQuestionsGeneratedFor\s*!=\s*version|Ne\([^)]*AskQuestionsGeneratedFor\s*,\s*version"),
            stamp);
    }

    /// <summary>
    /// 冷却表必须清过期项。
    ///
    /// 原先只在「后来生成成功」时删条目：模型长时间不可用时每个站点都进表，而之后
    /// 再没被访问、或已被删除的站点条目就永远留着——这是个单例服务，于是随时间单调增长。
    /// </summary>
    [Fact]
    public void 冷却表读的时候清过期项()
    {
        var src = Source();
        var head = MemberBody(src, "InCooldown");

        Assert.Contains("TryRemove", head);
        // 不只是删自己那条，还要扫掉别人留下的过期条目
        Assert.Matches(new Regex(@"foreach[\s\S]{0,200}TryRemove"), head);
    }

    /// <summary>
    /// 认领必须把 NeedsGeneration 的不变量一并重查。
    ///
    /// 只查「这一版没盖过戳 + 租约」是不够的：owner 在 RunAsync 开头那次读之后、CAS
    /// 之前，可能刚关掉提问、或自己写了几条题、或重传了正文。那时认领照样成功、模型
    /// 照样被调——StampAsync 最后确实拒绝落库，但钱已经花了。
    /// 「拦住写入」和「拦住花钱」是两件事，认领这一步管的是后者。
    /// </summary>
    [Fact]
    public void 认领要重查提问开关与手写标记与正文版本()
    {
        var src = Source();
        var head = MemberBody(src, "TryClaimAsync");

        Assert.Matches(
            new Regex(@"AskQuestionsSource\s*!=\s*AskOpeningQuestions\.SourceManual|Ne\([^)]*AskQuestionsSource\s*,\s*AskOpeningQuestions\.SourceManual"),
            head);
        Assert.Matches(
            new Regex(@"AskEnabled\s*!=\s*false|Ne\([^)]*AskEnabled\s*,\s*false"),
            head);
        // 正文版本这条现在走共用判据（认领与盖戳同一份），钉的是「有没有过这道判据」。
        // 它本身对不对由真打 Mongo 的 AskOpenerLegacyContentVersionTests 证明——
        // 那才是能证伪「缺字段的老站点认不出来」的证据，源码扫描证不了。
        Assert.Contains("ContentVersionIs(version)", head);
    }

    /// <summary>
    /// 取某个方法的完整方法体（到下一个成员为止）。
    ///
    /// 不用「从起点截固定字数」那种写法：过滤器一加条件方法就变长，断言会因为
    /// 窗口不够而红——那是判据自己坏了，不是被测代码坏了，最费排查时间。
    /// </summary>
    /// <summary>
    /// 取某个成员的方法体。
    ///
    /// 定位只认**方法名**，不许把返回类型写进判据：这一轮把 TryClaimAsync 的返回类型
    /// 从 Task&lt;bool&gt; 改成 Task&lt;DateTime?&gt;（认领要把自己盖的时刻交回去），
    /// 写死签名的旧判据当场定位不到、方法体取成空串，三条断言一起假红——
    /// 看着像修复坏了，其实是守卫依赖了被测代码的偶然形状。今天第三次同类了
    /// （前两次：只找 public 边界漏了 private、截固定 1200 字符）。
    /// </summary>
    private static string MemberBody(string src, string methodName)
    {
        // 锚定**定义**那一行：private/内部修饰符 + 任意返回类型 + 方法名 + 左括号。
        // 只按方法名找会命中调用处（RunAsync 里那句），方法体就取错了；
        // 把返回类型写进判据又会在改签名时假红。两个坑今天都踩过，所以用正则只钉
        // 「这是一处定义」这件事本身。
        var m = Regex.Match(src, @"\n\s+(private|internal|public)[^\n(]*\b" + Regex.Escape(methodName) + @"\s*\(");
        Assert.True(m.Success, $"找不到 {methodName} 的定义，测试该跟着改");

        var start = m.Index + 1;
        var rest = src[(start + m.Length)..];
        var ends = new[] { "\n    public ", "\n    private ", "\n    internal ", "\n    protected " }
            .Select(x => rest.IndexOf(x, StringComparison.Ordinal))
            .Where(i => i > 0)
            .DefaultIfEmpty(rest.Length)
            .Min();
        return src[start..(start + m.Length + ends)];
    }

    /// <summary>
    /// 释放认领必须**认主**：条件里带上自己盖的那个时刻。
    ///
    /// 原先是无条件清空 AskOpenerClaimedAt，注释还说「只清自己那一笔的语义由租约兜底」。
    /// 租约兜不住这条路径：A 卡过五分钟、B 接手重新认领之后，A 的 finally 迟到执行，
    /// 一把清掉 B 刚盖的认领；C 于是能在 B 还跑着的时候再调一次模型——重复计费又回来了。
    /// </summary>
    [Fact]
    public void 释放认领只清自己盖的那一笔()
    {
        var src = Source();
        var release = src[src.IndexOf("private static async Task ReleaseClaimAsync", StringComparison.Ordinal)..];
        var ends = new[] { "\n    public ", "\n    private ", "\n    internal " }
            .Select(m => release.IndexOf(m, 10, StringComparison.Ordinal))
            .Where(i => i > 0)
            .DefaultIfEmpty(release.Length)
            .Min();
        var body = release[..ends];

        Assert.Contains("myClaim", body);
        Assert.Contains("s.AskOpenerClaimedAt == myClaim", body);
    }

    /// <summary>认领要把自己盖的时刻交回给调用方，否则释放无从认主。</summary>
    [Fact]
    public void 认领返回自己盖的时刻()
    {
        var src = Source();
        Assert.Contains("private static async Task<DateTime?> TryClaimAsync", src);
        Assert.Contains("? now : null", src);
    }

    private static string LocateSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln"))) return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
