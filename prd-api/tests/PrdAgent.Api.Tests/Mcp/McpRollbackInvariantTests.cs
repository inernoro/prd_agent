using PrdAgent.Api.Controllers.Api;
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
}
