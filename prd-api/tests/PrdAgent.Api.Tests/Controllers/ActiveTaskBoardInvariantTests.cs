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
        // 匿名面板默认就是开的，而任务标题开头最常见的正是客户名、项目代号、缺陷编号。
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
    public void 切换正在做的那条必须收敛回一条()
    {
        // 两次切换同时发生时，各自读到的「当前在做」是同一条，于是可能各自激活自己的
        // 目标，留下两条 active —— FirstOrDefault 只看得见一条，另一条藏着继续计时。
        // 两道兜底缺一不可：降级带 CAS（否则重复降级会拿旧 StartedAt 把投入算多），
        // 末尾清扫（否则末态真的会留下两条）。
        var shared = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskShared.cs"));

        Assert.Contains("x.Id == old.Id && x.State == ActiveTaskState.Active", shared, StringComparison.Ordinal);
        Assert.Contains("UpdateManyAsync", shared, StringComparison.Ordinal);

        // 清扫必须排在激活之后，排在前面等于没扫
        var activate = shared.IndexOf("Set(x => x.State, ActiveTaskState.Active)", StringComparison.Ordinal);
        var sweep = shared.IndexOf("UpdateManyAsync", StringComparison.Ordinal);
        Assert.True(activate > 0 && sweep > activate, "收尾清扫必须排在激活目标之后");
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
