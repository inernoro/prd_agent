using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 债务接进任务台的纯函数判据。
///
/// 为什么这几条值得单独守：它们错了都**不会报错**。
/// ParseKey 放宽一点，撞车的标识就会被同步接受，然后两条债务在库里互相覆盖；
/// 收紧一点，仓库推上来的整批条目被静默跳过，界面上只是「什么都没有」。
/// 两种坏法都没有异常、没有红灯，只有人某天发现债务区不对劲。
/// </summary>
public class ActiveTaskDebtsTests
{
    [Theory]
    [InlineData("platform.active-tasks#15", "platform.active-tasks", 15)]
    [InlineData("cds#1", "cds", 1)]
    [InlineData("cds.build-gate#6", "cds.build-gate", 6)]
    [InlineData("doc.readability#8", "doc.readability", 8)]
    [InlineData("md-to-ppt#3", "md-to-ppt", 3)]
    [InlineData("visual-agent.layering#29", "visual-agent.layering", 29)]
    public void ParseKey_认得真实台账里的模块名(string key, string module, int num)
    {
        var parsed = ActiveTaskDebtsController.ParseKey(key);
        Assert.NotNull(parsed);
        Assert.Equal(module, parsed!.Value.Module);
        Assert.Equal(num, parsed.Value.Num);
    }

    [Theory]
    [InlineData(null)]              // 没给
    [InlineData("")]                // 空
    [InlineData("   ")]             // 只有空白
    [InlineData("platform.active-tasks")] // 缺编号 —— 整份台账不是一条债务
    [InlineData("#15")]             // 缺模块 —— 不知道是哪份台账的第 15 条
    [InlineData("platform#0")]      // 编号从 1 起，0 不是条目
    [InlineData("platform#-1")]
    [InlineData("platform#abc")]
    [InlineData("Platform#1")]      // 大写：台账文件名都是小写，放行大写等于放行两个标识指同一条
    [InlineData("platform active#1")]
    [InlineData("platform#1#2")]
    [InlineData("platform#99999")]  // 五位编号：没有哪份台账有上万条，多半是把别的数字塞进来了
    [InlineData("doc/debt.cds.md#1")] // 路径不是模块名
    public void ParseKey_挡住不合法的标识(string? key)
    {
        Assert.Null(ActiveTaskDebtsController.ParseKey(key));
    }

    [Fact]
    public void BuildHeadline_先给判断再给数字()
    {
        // 空态不说「0 条」——「0」逼读者自己想这是好事还是没同步
        Assert.Contains("没有欠着的账", ActiveTaskDebtsController.BuildHeadline(0, 0, 0));

        // 有我的也有没人管的：两个数都给，但拼成一句判断
        var both = ActiveTaskDebtsController.BuildHeadline(10, 3, 5);
        Assert.Contains("3", both);
        Assert.Contains("5", both);

        // 只有我的
        Assert.Contains("其余都有人管了", ActiveTaskDebtsController.BuildHeadline(4, 4, 0));

        // 全都没人管
        Assert.Contains("都还没人管", ActiveTaskDebtsController.BuildHeadline(7, 0, 7));

        // 别人认领完了
        Assert.Contains("有人认领了", ActiveTaskDebtsController.BuildHeadline(6, 0, 2));
    }

    [Fact]
    public void Clip_空白当没有_而不是当空串()
    {
        // 空串和 null 在界面上是两回事：null 不渲染，空串会渲染成一行空白
        Assert.Null(ActiveTaskDebtsController.Clip(null, 10));
        Assert.Null(ActiveTaskDebtsController.Clip("   ", 10));
        Assert.Equal("abc", ActiveTaskDebtsController.Clip("  abc  ", 10));
        Assert.Equal("abcde", ActiveTaskDebtsController.Clip("abcdefghij", 5));
    }

    [Fact]
    public void 状态只有四档_不做工作流()
    {
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Open));
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Claimed));
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Converted));
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Closed));
        Assert.False(ActiveTaskDebtState.IsValid("in_progress"));
        Assert.False(ActiveTaskDebtState.IsValid(null));
        Assert.False(ActiveTaskDebtState.IsValid(""));
    }

    [Fact]
    public void 同步工具走读档_读债务这件事不该只有管理档看得见()
    {
        var sync = Assert.Single(McpBuiltinTools.All.Where(t => t.Name == "map_debt_sync"));
        var list = Assert.Single(McpBuiltinTools.All.Where(t => t.Name == "map_debt_list"));

        Assert.Equal(McpCapabilityCatalog.ScopeTasksUse, sync.RequiredScope);
        Assert.Equal(McpCapabilityCatalog.ScopeTasksUse, list.RequiredScope);

        // 读的那个必须是 GET：POST 会被算进写入额度，读债务不该扣额度
        Assert.Equal("GET", list.Method);
        Assert.Equal("POST", sync.Method);

        // 路径得跟开放接口对得上，否则工具描述再好也打不到人
        Assert.Equal("/api/open/tasks/debts", list.PathTemplate);
        Assert.Equal("/api/open/tasks/debts/sync", sync.PathTemplate);
    }
}
