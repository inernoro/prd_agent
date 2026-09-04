using System;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 幂等回滚的不变量：补偿只写了一半时，账面必须跟着实际情况走。
///
/// 这类判据坏起来不会红 —— 接口照常返回、页面照常打开，只是数字对不上。
///
/// 说明这个文件为什么只剩一条：原先还有三条钉「建站先占坑再上传 / 租约窗口 / 撤回收尾按持有者过滤」。
/// 那套「确定性 id + 占坑 + 租约」的发布幂等已整套撤除（对象存储没有条件写入原语，跨两套存储凑
/// 原子发布连续三轮 review 都在长新洞），守卫随之失效 —— 留着就是钉住一个不存在的设计。
/// 取舍与收敛方案见 doc/debt.platform.md 边界 12。
/// </summary>
public class McpRollbackInvariantTests
{
    [Fact]
    public void 条目没删掉时_文档计数不许减()
    {
        // 清理失败时条目是被**刻意留下来**占住确定性 id 的，它还在列表里看得见。
        // 这时候减计数 = 库摘要永久少算一条，而且没人会来补。
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: true, entryDeleted: false)
            .ShouldBeFalse();
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: true, entryDeleted: true)
            .ShouldBeTrue();
        // 压根没计进去过的，删没删都不减
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: false, entryDeleted: true)
            .ShouldBeFalse();
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: false, entryDeleted: false)
            .ShouldBeFalse();
    }
}

/// <summary>
/// 幂等键推出来的确定性 id 必须带上它所属的库。
///
/// 这条坏掉的表现不是「幂等失效」，是**合法调用报 500**：确定性 id 就是主键，主键在整个集合里
/// 唯一、不分库。智能体拿同一个 clientRequestId 往两个库各写一篇（批处理里每库一次、请求 id
/// 按批取，很自然），第二篇的先查后判会因为库不同而查不到，接着插入撞主键，按库过滤又捞不回来，
/// 最后抛出去。而这条判据被改回去之后，全量测试照样绿。
/// </summary>
public class McpEntryIdempotencyScopeTests
{
    [Fact]
    public void 同一个幂等键在两个库里推出不同的_id()
    {
        var a = DocumentStoreOpenApiController.DeterministicId("kb-entry:store-a", "mcp:key1:req-1");
        var b = DocumentStoreOpenApiController.DeterministicId("kb-entry:store-b", "mcp:key1:req-1");

        a.ShouldNotBeNull();
        a.ShouldNotBe(b, "同一个 clientRequestId 写进两个库，必须是两条不同的条目");
    }

    [Fact]
    public void 同库同幂等键必须稳定推出同一个_id()
    {
        // 幂等的全部意义在这一条：重试落回同一个主键，撞上就是命中
        DocumentStoreOpenApiController.DeterministicId("kb-entry:store-a", "mcp:key1:req-1")
            .ShouldBe(DocumentStoreOpenApiController.DeterministicId("kb-entry:store-a", "mcp:key1:req-1"));
    }

    [Fact]
    public void 没给幂等键就不推确定性_id()
    {
        DocumentStoreOpenApiController.DeterministicId("kb-entry:store-a", null).ShouldBeNull();
    }

    [Fact]
    public void 条目早已被别人删掉时_不许再退一次计数()
    {
        // 正文还在落盘时，用户可以在界面上把这条删了，而那条路径（DocumentStoreController.DeleteEntry）
        // 自己已经扣过一次 DocumentCount。回滚这边如果一律按「是我删的」再扣一次，
        // 计数会被扣成负数 —— 而这类错不会红：接口照常 500、页面照常打开，只是数字对不上。
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(
            countedIn: true, DocumentStoreOpenApiController.RollbackOutcome.Removed)
            .ShouldBeTrue("这次真的是我删的，计数就该退回去");

        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(
            countedIn: true, DocumentStoreOpenApiController.RollbackOutcome.AlreadyGone)
            .ShouldBeFalse("条目早已不在，扣减已经由删除那条路径做过，再退一次就是负数");

        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(
            countedIn: true, DocumentStoreOpenApiController.RollbackOutcome.Retained)
            .ShouldBeFalse("条目被刻意留着占 id，它还在库里，更不该退计数");

        // 压根没记过数就谈不上退
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(
            countedIn: false, DocumentStoreOpenApiController.RollbackOutcome.Removed)
            .ShouldBeFalse();
    }

    [Fact]
    public void 版本令牌必须由调用方给_不能拿刚读出来的那个当条件()
    {
        // 原先传给写入服务的 expectedUpdatedAt 是**刚刚重新读出来的**那个 UpdatedAt，
        // 条件永远成立 —— 那道「乐观并发」只挡得住相邻两行代码之间的缝隙，挡不住真正会
        // 丢用户改动的那一种：智能体 T0 读到、用户 T1 改了、智能体 T2 覆盖。
        // 而 409 的文案写的是「在**你读到它**之后被别人改过」，那个「你」是调用方。
        var stored = new DateTime(2026, 9, 4, 10, 0, 0, 123, DateTimeKind.Utc);

        McpRevision.Check(null, stored)
            .ShouldBe(RevisionCheck.NotProvided);
        McpRevision.Check("   ", stored)
            .ShouldBe(RevisionCheck.NotProvided);

        // 读端点回的就是 "O" 格式，原样传回来必须算匹配
        McpRevision.Check(stored.ToString("O"), stored)
            .ShouldBe(RevisionCheck.Match);

        // 用户在中间改过一次 —— 这才是要挡住的那一种
        McpRevision.Check(
            stored.AddSeconds(-30).ToString("O"), stored)
            .ShouldBe(RevisionCheck.Mismatch);

        // 认不出来的是入参错误，不是冲突：回 400 让调用方改，而不是让它以为有人抢改
        McpRevision.Check("上周三", stored)
            .ShouldBe(RevisionCheck.Unparsable);
    }

    [Fact]
    public void 回给调用方的令牌_必须能被自己原样认回来()
    {
        // 读端点回什么格式、写端点认什么格式，是同一个判据的两半。
        // 分开写就会漂：一边 "O"、一边默认 ToString，用户原样传回来反而 409。
        var stored = new DateTime(2026, 9, 4, 10, 0, 0, 123, DateTimeKind.Utc);
        McpRevision.Check(McpRevision.Token(stored), stored).ShouldBe(RevisionCheck.Match);

        // 库里取出来的 Kind 有可能是 Unspecified（驱动配置不同），也不该因此判成冲突
        var unspecified = DateTime.SpecifyKind(stored, DateTimeKind.Unspecified);
        McpRevision.Check(McpRevision.Token(unspecified), unspecified).ShouldBe(RevisionCheck.Match);
    }
}
