using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 任务台的几条不变量。
///
/// 这几条的共同点是：错了都不会报错。时区差一小时不会抛异常，只是标签写错一天；
/// 脱敏多留两个字不会红，只是把公开面板上的客户名漏出去；权限少登记一条也不会红，
/// 只是非管理员点进去看到 403。全都要等到有人真的用了才发现，所以必须钉在这里。
/// 2026-09-16 Codex review 抓出来后补的。
/// </summary>
public class ActiveTaskBoardInvariantTests
{
    [Fact]
    public void 今天是哪天只许有一个答案_不跟着容器时区走()
    {
        // 事故形状：标签这边用 ToLocalTime()（跟着容器时区），AI 导入那边写死东八区。
        // 在 UTC 容器上，北京时间 08:00-16:00 之间，导入时判为「今天」的那条会被标成「明天」。
        // 判据不能写成「和 ToLocalTime 一致」——那在东八区的机器上恒真，等于没测。
        // 这里取一个只有按东八区算才成立的时刻：UTC 周三 17:00 已经是团队日历的周四。
        var utc = new DateTime(2026, 9, 16, 17, 0, 0, DateTimeKind.Utc);
        Assert.Equal(new DateTime(2026, 9, 17), ActiveTaskConclusion.TeamDate(utc));
        Assert.Equal(TimeSpan.FromHours(8), ActiveTaskConclusion.TeamUtcOffset);

        // 同一个 UTC 时刻：团队日历的今天是 9/17，所以 9/17 的截止时间就是「今天」
        var due917 = new DateTime(2026, 9, 17, 10, 0, 0, DateTimeKind.Utc);
        Assert.Equal("今天", ActiveTaskConclusion.FormatDue(due917, utc));
        Assert.False(ActiveTaskConclusion.IsOverdue(due917, utc));

        // 而 9/16 那条在团队日历上已经是昨天了
        var due916 = new DateTime(2026, 9, 16, 10, 0, 0, DateTimeKind.Utc);
        Assert.Equal("昨天要的", ActiveTaskConclusion.FormatDue(due916, utc));
        Assert.True(ActiveTaskConclusion.IsOverdue(due916, utc));
    }

    [Fact]
    public void 脱敏之后不许剩下任何原文字符()
    {
        // 匿名面板一旦打开就是对着公网的，而任务标题开头最常见的正是客户名、项目代号、缺陷编号。
        // 「留个首字有形状」和「看不到标题正文」这两件事不能同时要 —— 留一个字就是漏一个字。
        var 敏感 = new[]
        {
            "米多科技的对账单对不上",
            "DEF-20931 登录失败",
            "A",
            "客户名",
        };

        foreach (var title in 敏感)
        {
            var masked = ActiveTaskShared.MaskTitle(title);
            Assert.NotEmpty(masked);              // 空串会让前端渲染成空行
            Assert.True(masked.All(c => c == '·'), $"「{title}」脱敏后仍带原文：{masked}");
        }

        // 空标题另说：给一句人话，不是一串点
        Assert.Equal("（无标题）", ActiveTaskShared.MaskTitle("   "));
    }

    [Fact]
    public void 任务台使用权必须发到内置角色_不然普通人装完就进不去()
    {
        // 形状 2：权限登记进了目录，却没接进任何一个内置角色。
        // 编译过、测试绿、目录里查得到 —— 只有非管理员真的点进去才会看到 403。
        // 判据锚在 agent_tester 上：它的注释写着「所有 Agent 使用权限」，少一条就是名不副实。
        foreach (var key in new[] { "operator", "viewer", "agent_tester" })
        {
            var role = Assert.Single(BuiltInSystemRoles.Definitions, r => r.Key == key);
            Assert.Contains(AdminPermissionCatalog.ActiveTasksUse, role.Permissions);
        }
    }

    [Fact]
    public void 勾掉一条备用任务不许把手上那件换掉()
    {
        // 备用行上也有完成圆圈。原来 Finish 无条件提队首，于是：A 在做、B/C 备用，
        // 用户勾掉 C —— C 完成了，队首 B 被顶上来，A 被退回队列且卡住状态被清空。
        // 用户只是想划掉一条备用，手上那件却被换走了。
        Assert.True(ActiveTaskShared.ShouldAdvanceQueue(ActiveTaskState.Active));
        Assert.False(ActiveTaskShared.ShouldAdvanceQueue(ActiveTaskState.Standby));
        Assert.False(ActiveTaskShared.ShouldAdvanceQueue(ActiveTaskState.Done));
        Assert.False(ActiveTaskShared.ShouldAdvanceQueue(ActiveTaskState.Dropped));

        // 接线：Finish 必须真的走这个判定，而不是又在本地写一个 == Active
        var src = Controller();
        Assert.Contains("ActiveTaskShared.ShouldAdvanceQueue(entry.State)", src, StringComparison.Ordinal);
    }

    [Fact]
    public void 撤销要放回原来那一档_同一个洞在撤销那条路上也通着()
    {
        // 只修 Finish 不够：勾掉一条备用（现在不会换走手上那件了），再点「撤销」——
        // 原来的 Reopen 一律 MakeActiveAsync，于是那条备用变成「正在做」，手上那件还是被换走。
        // 判据不看措辞，看两件事是否都在：结案时落了戳，撤销时照戳分叉。
        var finish = Controller();
        Assert.Contains("Set(x => x.FinishedFromActive, wasActive)", finish, StringComparison.Ordinal);
        Assert.Contains("if (entry.FinishedFromActive)", finish, StringComparison.Ordinal);

        // 落戳必须在结算之前取的那个值上 —— 结算会把 State 改成 done，之后再判就永远是 false
        var wasActiveAt = finish.IndexOf("var wasActive = ActiveTaskShared.ShouldAdvanceQueue", StringComparison.Ordinal);
        var settleAt = finish.IndexOf("SettleAndSetStateAsync(_db, entry, ActiveTaskState.Done", StringComparison.Ordinal);
        Assert.True(wasActiveAt > 0 && settleAt > wasActiveAt,
            "wasActive 必须在 SettleAndSetStateAsync 之前取，否则 entry.State 已经是 done 了");
    }

    [Fact]
    public void 卡住要卡够配置的时长才升到管理侧()
    {
        // 形状 2：BlockedEscalateMinutes（5-1440）登记进了设置页、也传进了看板聚合，
        // 却没有任何一处读它 —— 卡住一秒就顶到最上面并计进「几个人要你看一下」，
        // 那个旋钮转了等于没转。判据锚在两处：排序档与 needsYou 必须都认 Escalated。
        var shared = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskShared.cs"));

        Assert.Contains("settings.BlockedEscalateMinutes * 60", shared, StringComparison.Ordinal);
        Assert.Contains("p.Escalated || p.Status == \"empty\"", shared, StringComparison.Ordinal);
        Assert.Contains("p.Escalated ? 0 : 2", shared, StringComparison.Ordinal);
    }

    [Fact]
    public void 切换正在做的那条_降级要带CAS_但绝不许再加收尾清扫()
    {
        // 降级带 CAS：并发下别人可能已经把它降级了，不带条件再降一次会拿旧的 StartedAt
        // 重算一遍时长，把投入算多。
        //
        // 而「收尾扫一遍把除目标外的 active 全降级」是**试过并撤掉**的办法，不许再加：
        // 两次切换各自激活完目标之后才轮到清扫，A 的清扫降掉 B、B 的清扫再降掉 A，
        // 末态变成零条正在做 —— 用户点了开始却手上空空，两条都停止计时。
        // 两条 active 至少还有一条在显示、都在计时；零条是纯粹的损失。
        // （2026-09-16 我加过这一扫，合并前那轮 review 把它抓了出来。）
        var shared = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskShared.cs"));

        Assert.Contains("x.Id == old.Id && x.State == ActiveTaskState.Active", shared, StringComparison.Ordinal);
        Assert.DoesNotContain("UpdateManyAsync", shared, StringComparison.Ordinal);
    }

    [Fact]
    public void 卡住升级量的是这一轮_不是累计()
    {
        // 用累计（BlockedSecondsAt）的话，之前卡过 110 分钟、这次刚卡 10 分钟，
        // 在 120 分钟阈值下立刻就升级了 —— 而它这一次其实才卡了十分钟。
        var shared = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskShared.cs"));

        var escalated = shared[shared.IndexOf("Escalated =", StringComparison.Ordinal)..];
        escalated = escalated[..escalated.IndexOf(",\n", StringComparison.Ordinal)];
        Assert.Contains("BlockedSince", escalated, StringComparison.Ordinal);
        Assert.DoesNotContain("BlockedSecondsAt", escalated, StringComparison.Ordinal);
    }

    [Fact]
    public void AI给的截止日必须带时区偏移_而且只有一份判定源()
    {
        // 不带偏移的 2026-09-19T18:00:00 会被当成 18:00 UTC，TeamDate 再加八小时，
        // 于是模型给 9/19 的那条最后显示成 9/20。18:00 是团队日历上的下班时间，
        // 偏移就得是团队日历的偏移。
        var import = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTasksImportController.cs"));
        Assert.Contains("ActiveTaskConclusion.TeamUtcOffset", import, StringComparison.Ordinal);
        Assert.Contains("yyyy-MM-ddTHH:mm:sszzz", import, StringComparison.Ordinal);

        // 建议那边曾经抄了一份一模一样的 NormalizeDue，两份必然各自漂移（形状 3）
        var suggest = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskSuggestionsController.cs"));
        Assert.DoesNotContain("string? NormalizeDue(", suggest, StringComparison.Ordinal);
        Assert.Contains("ActiveTasksImportController.NormalizeDue(", suggest, StringComparison.Ordinal);
    }

    [Fact]
    public void 放下的那条撤销时也要放回原来那一档()
    {
        // 放下和结案一样会腾出「正在做」，所以它也得落戳。只给 Finish 落戳的话，
        // 放下一条正在做的活再撤销，它会被还原成备用，手上那件反而留着 ——
        // 「撤销等于什么都没发生过」这句承诺在放下那条路上不成立。
        // 按路由属性精确切出方法体，不按关键字找。
        // 第一版写的是 IndexOf("ActiveTaskState.Dropped")，结果命中的是 Reopen 里那句
        // `entry.State != ActiveTaskState.Dropped`，窗口整个落在别的方法上 ——
        // 取了第一个匹配而不是该取的那个，正是 predicate-and-wiring-discipline 形状 6。
        var drop = Endpoint("[HttpPost(\"{id}/drop\")]");
        Assert.Contains("ShouldAdvanceQueue(entry.State)", drop, StringComparison.Ordinal);
        Assert.Contains("Set(x => x.FinishedFromActive, wasActive)", drop, StringComparison.Ordinal);

        // 顺带把结案那边也用同一种切法钉一次，免得两条判据用两种口径
        var finish = Endpoint("[HttpPost(\"{id}/finish\")]");
        Assert.Contains("Set(x => x.FinishedFromActive, wasActive)", finish, StringComparison.Ordinal);
    }

    /// <summary>
    /// 按路由属性切出某个端点的方法体（到下一个 [Http… 为止）。
    /// 关键字定位会命中别的方法里同名的字符串，判据必须锚在唯一的东西上。
    /// </summary>
    [Fact]
    public void 匿名看板默认必须是关的()
    {
        // 这一屏对着的是不需要登录的任何人，端出去的是同事真名与此刻在做什么。
        // 默认开过一版：部署那一刻起，只要有人知道地址就能看到全公司谁在忙谁卡住，
        // 而当时前端连关掉它的入口都还没接上。安全默认只能是关，由管理员显式打开。
        Assert.False(new ActiveTaskBoardSettings().AnonymousEnabled);

        // 顺带钉住另外三项的默认值：它们现在有界面可改了，改不动的那一版不能再回来
        var d = new ActiveTaskBoardSettings();
        Assert.Equal(AnonymousVisibility.Masked, d.AnonymousMode);
        Assert.Equal(120, d.BlockedEscalateMinutes);
        Assert.Equal(8, d.HeavyStackThreshold);
    }

    [Fact]
    public void 要你看一下的那几个人_与这一屏标红的那几个人必须是同一批()
    {
        // 事故形状：needsYou 只数了「卡够时长的」和「没活的」，堆超阈值的只进排序不进计数。
        // 于是结论句写着「N 个人都在推进，没有要你管的」，底下明晃晃标着两个堆红了的人 ——
        // 结论和它总结的那些行自相矛盾（conclusion-before-numbers）。
        var shared = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskShared.cs"));

        // 判定只许有一处定义：排序与计数各写一份 x.StandbyCount >= threshold，
        // 就是下一次「改了一边忘了另一边」的温床（判据分裂）。
        // 一处 = Overloaded 自己那行。两处就说明排序或计数又各写了一份
        var 定义处 = shared.Split("StandbyCount >= ").Length - 1;
        Assert.Equal(1, 定义处);

        var at = shared.IndexOf("var needsYou = ", StringComparison.Ordinal);
        Assert.True(at > 0, "找不到 needsYou 的计算");
        var line = shared[at..shared.IndexOf(';', at)];
        Assert.Contains("Escalated", line);
        Assert.Contains("\"empty\"", line);
        Assert.Contains("Overloaded", line);
    }

    [Fact]
    public void 已经结案的不许被激活成正在做()
    {
        // Codex 2026-09-16 抓到的：A 在做、B 备用，两条几乎同时被勾掉 —— A 的结案挑中 B
        // 当下一件，而 B 自己的结案先落地把它写成了 done，激活那一步再无条件设回 active，
        // 于是一条带着结案时间和结案说明的任务又回到「正在做」并继续计时。
        // 页面上两次快速点击就够了，不需要真的并发压测。
        var shared = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskShared.cs"));

        var at = shared.IndexOf("Set(x => x.State, ActiveTaskState.Active)", StringComparison.Ordinal);
        Assert.True(at > 0, "找不到激活那一步");
        // 往前找它的过滤条件：必须限定「还没结案」，不能只有 Id
        var filter = shared[Math.Max(0, at - 400)..at];
        Assert.Contains("x.State == ActiveTaskState.Standby", filter, StringComparison.Ordinal);

        // 配套：撤销结案必须先把状态放回 standby，否则上面那个条件会让撤销失效。
        // 这两处是一对，改一个忘另一个就会悄悄废掉撤销按钮。
        var reopen = Endpoint("[HttpPost(\"{id}/reopen\")]");
        var setStandby = reopen.IndexOf("Set(x => x.State, ActiveTaskState.Standby)", StringComparison.Ordinal);
        // 找的是**调用**，不是这三个字：上面那段注释里也写了 MakeActiveAsync，
        // 按词去找会命中注释，判据读到的就不是它以为的那个位置
        var makeActive = reopen.IndexOf("await ActiveTaskShared.MakeActiveAsync(", StringComparison.Ordinal);
        Assert.True(setStandby > 0, "撤销没有把状态放回 standby");
        Assert.True(makeActive > setStandby, "撤销必须先放回 standby 再激活，否则激活那一步不认它");
    }

    [Fact]
    public void 结案那段写序列不许被客户端断开切一半()
    {
        // 结算 → 盖「从哪一档结案的」戳 → 队首顶上来，这三步是一个整体。
        // 跟着请求的 ct 走会这样断：结算已落库（State 变 done），用户这时关掉页面，
        // 后两步被取消 —— FinishedFromActive 永远是 false（撤销把它还原成备用而不是
        // 正在做），队列也没人顶上来。而重试进不来：开头那句 State == Done 直接回
        // alreadyDone。server-authority：客户端断开不取消服务器已经开始的写入。
        var body = Endpoint("[HttpPost(\"{id}/finish\")]");

        var settle = body.IndexOf("SettleAndSetStateAsync", StringComparison.Ordinal);
        Assert.True(settle > 0, "找不到结算调用");
        // 从结算那一步往后，不许再出现跟请求走的 ct
        var tail = body[settle..];
        Assert.DoesNotContain(", ct)", tail, StringComparison.Ordinal);
        Assert.DoesNotContain("cancellationToken: ct", tail, StringComparison.Ordinal);
        Assert.Contains("CancellationToken.None", tail, StringComparison.Ordinal);
    }

    [Fact]
    public void 真删要带条件_不能只按标识删()
    {
        // 上面那几行 precheck 是**读到的那一刻**的判断，挡不住并发：同一行上「开始」和
        // 「删除」挨着点，开始那一步先把它改成 active，只按 Id 删就会把一条已经开始计时的
        // 任务永久删掉 —— 而这个端点自己的规矩是「投入过时间的只能放下、历史要留痕」。
        var body = Endpoint("[HttpDelete(\"{id}\")]");

        var at = body.IndexOf("DeleteOneAsync", StringComparison.Ordinal);
        Assert.True(at > 0, "找不到删除调用");
        var call = body[at..];
        foreach (var 条件 in new[] { "x.UserId == userId", "ActiveTaskState.Standby", "x.AccumulatedSeconds == 0" })
            Assert.Contains(条件, call, StringComparison.Ordinal);
        // 零匹配要如实回绝，不能当成删成功了
        Assert.Contains("DeletedCount == 0", call, StringComparison.Ordinal);
    }

    private static string Endpoint(string routeAttribute)
    {
        var src = Controller();
        var start = src.IndexOf(routeAttribute, StringComparison.Ordinal);
        Assert.True(start > 0, $"控制器里找不到端点 {routeAttribute}");
        var next = src.IndexOf("    [Http", start + routeAttribute.Length, StringComparison.Ordinal);
        return next > start ? src[start..next] : src[start..];
    }

    private static string Controller() => File.ReadAllText(Path.Combine(
        RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTasksController.cs"));

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "doc"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return AppContext.BaseDirectory;
    }
}
