using System;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
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

    /// <summary>
    /// 撤回没清干净时，不许对调用方说「已经撤回」，也不许让它拿同一个键重试。
    ///
    /// Retained 的含义是：派生记录没清掉，条目被**刻意留着**占住那个确定性 id ——
    /// 它还带着「正文未落盘」的标记躺在库里，同键重试会一直撞 409。这时候说
    /// 「已经撤回，请用同一个 clientRequestId 重试」，两句都是不算数的话。
    /// </summary>
    [Fact]
    public void 撤回干净时_照常给出可复用同一个键的说法()
    {
        // 不用 [Theory] 传枚举：这个枚举是 internal，公开测试方法的参数不能比它更可见。
        var clean = new[]
        {
            DocumentStoreOpenApiController.RollbackOutcome.Removed,
            DocumentStoreOpenApiController.RollbackOutcome.AlreadyGone,
        };
        foreach (var outcome in clean)
        {
            var msg = DocumentStoreOpenApiController.RollbackMessage(
                "这篇文档没有建成", "请用同一个 clientRequestId 重试。", outcome);
            msg.ShouldContain("已经撤回", customMessage: outcome.ToString());
            msg.ShouldContain("同一个 clientRequestId", customMessage: outcome.ToString());
        }
    }

    [Fact]
    public void 撤回没清干净时_不许说已经撤回_也不许让它用同一个键重试()
    {
        var msg = DocumentStoreOpenApiController.RollbackMessage(
            "这篇文档没有建成", "请用同一个 clientRequestId 重试。",
            DocumentStoreOpenApiController.RollbackOutcome.Retained);
        msg.ShouldNotContain("已经撤回");
        msg.ShouldNotContain("请用同一个 clientRequestId 重试");
        msg.ShouldContain("换一个键", customMessage: "残留没清干净时必须让调用方换键，否则它会一直撞 409");
        // 情形本身照说 —— 换了键也得知道刚才发生了什么。
        msg.ShouldContain("这篇文档没有建成");
    }

    /// <summary>
    /// 三条撤回路径必须都走同一处说法。
    ///
    /// 这条守卫的存在理由就是它这次抓的东西：上一版只有「没走完」那条看了 outcome，
    /// 另外两条（条目被删、库被删）一律说「已经撤回」，清理失败时就是句不算数的话。
    /// 逐个调用点枚举，而不是数总数 —— 新加第四条撤回路径时它自动进闸。
    /// </summary>
    [Fact]
    public void 每一处撤回都必须按清理结果说话()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        const string call = "CleanupRolledBackEntryAsync(entry.Id";
        var sites = 0;
        for (var i = src.IndexOf(call, StringComparison.Ordinal); i >= 0; i = src.IndexOf(call, i + 1, StringComparison.Ordinal))
        {
            sites++;
            // 撤回之后那段（到本 catch 块结束前）必须用上清理结果，而不是照着一句写死的话回。
            var tail = src[i..Math.Min(src.Length, i + 900)];
            tail.ShouldContain("RollbackMessage(",
                customMessage: $"第 {sites} 处撤回没按清理结果说话：清理失败时它仍会说「已经撤回」，而条目还带着未落盘标记留在库里");
        }
        sites.ShouldBe(3, "撤回路径数量变了 —— 新增的那条也要按清理结果说话，确认后再改这个数");
    }

    /// <summary>
    /// 正文已经提交的条目，撤回一个字都不许删。
    ///
    /// 写正文那一步是「先提交正文，再重锚评论、重算双链、拍版本快照」。派生那几步抛出来时，
    /// 正文其实已经落库了 —— 而上一版一律走撤回，于是把一篇**已经可见、用户可能还编辑过**的
    /// 文档连同版本与双链一起删掉。撤回是为了不留半成品，不是为了删用户的东西。
    ///
    /// 行为面能测的是说法与计数；「删不删」依赖 Mongo，由下面那条源码守卫盯判据的形状。
    /// </summary>
    [Fact]
    public void 正文已经提交时_既不删也不许说没建成()
    {
        var msg = DocumentStoreOpenApiController.RollbackMessage(
            "这篇文档没有建成", "请用同一个 clientRequestId 重试。",
            DocumentStoreOpenApiController.RollbackOutcome.KeptCommitted);
        msg.ShouldNotContain("没有建成", customMessage: "正文在库里，说没建成就是假的");
        msg.ShouldNotContain("已经撤回");
        msg.ShouldContain("已经写进去", customMessage: "得让调用方知道这篇在他的知识库里，别再建一遍");
        msg.ShouldNotContain("请用同一个 clientRequestId 重试");

        // 条目还在库里看得见，计数就不能退 —— 退了库摘要会少算一条，而且永远补不回来。
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(
            countedIn: true, DocumentStoreOpenApiController.RollbackOutcome.KeptCommitted).ShouldBeFalse();
    }

    /// <summary>
    /// 撤回必须拿「插进去时那一刻的样子」当条件，而且判据与删除是同一条原子操作。
    ///
    /// 回读一次判、再无条件删，中间那段窗口里正文正好提交成功的话，删的就是刚落库的正文
    /// （形状 1：判据比它该管的范围窄）。所以删除本身也得带同一个条件。
    /// </summary>
    [Fact]
    public void 撤回的条件是插进去时那一刻的样子()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        src.ShouldContain("DateTime placeholderUpdatedAt, string requestedContent)",
            customMessage: "撤回得知道「原封不动」长什么样、以及这次要写的是什么，否则无从判断该不该删、算不算写成了");
        src.ShouldContain("e.Id == entryId && e.UpdatedAt == placeholderUpdatedAt",
            customMessage: "删除必须带条件：回读与删除之间还有窗口，判据和写入要是同一条原子操作");
        src.ShouldNotContain("DeleteOneAsync(e => e.Id == entryId, ",
            customMessage: "又回到无条件删了 —— 正文提交成功的那一瞬会被删掉");

        // 条目已经不在了就得**立刻收手**：这个确定性 id 已经空出来，同键重试可能已经插了一条新的，
        // 再按 id 清一遍派生，清掉的是新那次的版本与双链，而那次还会照常报成功。
        var cleanup = McpSourceGuard.Slice(src,
            "DateTime placeholderUpdatedAt, string requestedContent)",
            "DocumentEntryVersions.DeleteManyAsync");
        cleanup.ShouldContain("if (current == null) return RollbackOutcome.AlreadyGone;",
            customMessage: "回读为 null 时还往下走，会按一个已经可重用的 id 去清派生");
    }

    /// <summary>
    /// 「条目被动过」不等于「我的正文写进去了」。
    ///
    /// 用户在界面上改一次那条可见的占位，UpdatedAt 照样变。把那种情况当成「我写成了」并回 200，
    /// 就是把调用方要写的内容悄悄丢掉，然后回一句成功——而摘掉标记之后，同键重试还会拿到
    /// 「已去重、成功」，于是那份内容从头到尾没被应用过，也没有任何人会发现。
    /// </summary>
    [Fact]
    public void 别人改的和我写成的_不能给同一种说法()
    {
        var mine = DocumentStoreOpenApiController.RollbackMessage(
            "这篇文档没有建成", "请用同一个 clientRequestId 重试。",
            DocumentStoreOpenApiController.RollbackOutcome.KeptCommitted);
        var theirs = DocumentStoreOpenApiController.RollbackMessage(
            "这篇文档没有建成", "请用同一个 clientRequestId 重试。",
            DocumentStoreOpenApiController.RollbackOutcome.ChangedByOthers);

        theirs.ShouldNotBe(mine, "两种结局的后果相反，不能给同一句话");
        theirs.ShouldNotContain("已经写进去", customMessage: "我的正文根本没写进去，不许这么说");
        theirs.ShouldNotContain("已经撤回", customMessage: "对方的内容还在，什么都没撤");
        theirs.ShouldContain("被别人改过");
        // 这条键已经不能再用了：标记被摘掉之后，同键重试会被当成去重成功
        theirs.ShouldContain("不要再用");

        // 条目还在库里看得见，计数一样不能退
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(
            countedIn: true, DocumentStoreOpenApiController.RollbackOutcome.ChangedByOthers).ShouldBeFalse();
    }

    /// <summary>
    /// 「装的是不是我要写的那份正文」这个问题，撤回与去重必须问同一遍。
    ///
    /// 去重原来只看标记在不在 —— 而标记被摘掉只说明上一次收尾过了，不说明这条装的是这次
    /// 要写的正文。两处各判各的，就会出现「撤回那边如实说没写进去，去重这边照样报成功」。
    /// </summary>
    [Fact]
    public void 撤回与去重问的是同一个问题()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        var calls = 0;
        for (var i = src.IndexOf("HoldsRequestedContentAsync(", StringComparison.Ordinal); i >= 0;
             i = src.IndexOf("HoldsRequestedContentAsync(", i + 1, StringComparison.Ordinal)) calls++;
        calls.ShouldBeGreaterThanOrEqualTo(4,
            "判据定义 1 处 + 撤回 2 处 + 去重 1 处；少了就是有一条路自己判自己的");

        var dedup = McpSourceGuard.Slice(src, "DedupOrInProgressAsync(DocumentEntry existed", "return Ok(");
        dedup.ShouldContain("HoldsRequestedContentAsync(",
            customMessage: "去重只看标记在不在，会把「内容从没被应用过」报成成功");
    }

    /// <summary>
    /// 正文其实写进去了，就不能报失败。
    ///
    /// 网关按 HTTP 状态码判这次调用成没成：报 500 它会退掉占的额度、把这笔记成错误 ——
    /// 于是文档明明躺在用户的知识库里，账面上却是「没发生过、也没花钱」。
    /// 这不是显示问题：额度账与调用记录都跟着错，而事后没有任何线索指向这次。
    /// </summary>
    [Fact]
    public void 正文已提交时_不许按失败回给调用方()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        // 兜底那段里，KeptCommitted 必须在 500 之前被单独接住。
        var tail = McpSourceGuard.Slice(src, "if (ShouldRestoreDocumentCount(countedIn, outcome))", "public class UpdateEntryContentRequest");
        var kept = tail.IndexOf("RollbackOutcome.KeptCommitted", StringComparison.Ordinal);
        var fail = tail.IndexOf("StatusCode(500", StringComparison.Ordinal);
        kept.ShouldBeGreaterThanOrEqualTo(0, "兜底那段没有单独接住「正文已提交」");
        fail.ShouldBeGreaterThan(kept, "「正文已提交」得排在 500 之前，否则它照样被当成失败回出去");
        tail[kept..fail].ShouldContain("Ok(", customMessage: "接住了却还是没按成功回");
    }

    /// <summary>
    /// 每一处「摘掉正文未落盘标记」都必须带上刚读到的版本。
    ///
    /// 这个 id 是幂等键推出来的**确定性** id：回读之后、更新之前，它完全可能被删掉、又被同键
    /// 重试插进一条新的占位。只按 id 摘的话，摘掉的是**新那次**的标记 —— 于是再一次重试拿到
    /// 「已去重、成功」，而那条的正文还没写、甚至最终会失败。
    ///
    /// 逐个出口枚举，不数总数：这个标记有四处出口（收尾成功、收尾撞上用户编辑、正文被别人改过、
    /// 撤回时发现正文已提交），新增第五处时它自动进闸 —— 上一轮就是只修了其中一处，
    /// 另外两处原样留着，靠 review 才捞出来。
    /// </summary>
    [Fact]
    public void 摘标记的每一处出口都要带版本条件()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        const string unset = "Update.Unset(EntryContentPendingField)";
        var exits = 0;
        for (var i = src.IndexOf(unset, StringComparison.Ordinal); i >= 0;
             i = src.IndexOf(unset, i + 1, StringComparison.Ordinal))
        {
            exits++;
            // 过滤器写在这一句之前，取够长的一段（跨得过 Combine 那种多行写法）。
            var filter = src[Math.Max(0, i - 260)..i];
            filter.ShouldContain("UpdatedAt",
                customMessage: $"第 {exits} 处摘标记只认 id：确定性 id 被同键重试重用时，摘掉的是新那次的标记");
        }
        exits.ShouldBe(4, "摘标记的出口数量变了 —— 新增那处也要带版本条件，确认后再改这个数");
    }

    /// <summary>
    /// 生图「跑完了没有」必须先认终态，不能只数计数器。
    ///
    /// 用户中途取消时，还没开始的那几张既不算 done 也不算 failed —— 计数器永远凑不齐，
    /// 于是这个标志永远是 false。跟着它轮询的智能体会一直问下去，直到被限流挡住，
    /// 而这次生图其实早就结束了：判据看不见「取消」这种结束方式（形状 1：判据比它该管的范围窄）。
    /// </summary>
    [Fact]
    public void 生图跑完了没有_先认终态()
    {
        // 取消：还没开始的那两张谁也没记上，只数计数器就会永远说「没跑完」
        VisualOpenApiController.IsRunFinished(ImageGenRunStatus.Cancelled, done: 1, failed: 0, total: 3)
            .ShouldBeTrue("取消了就是结束了，别让调用方一直轮询到被限流");
        VisualOpenApiController.IsRunFinished(ImageGenRunStatus.Failed, done: 0, failed: 0, total: 4).ShouldBeTrue();
        VisualOpenApiController.IsRunFinished(ImageGenRunStatus.Completed, done: 4, failed: 0, total: 4).ShouldBeTrue();

        // 还在跑就是没跑完
        VisualOpenApiController.IsRunFinished(ImageGenRunStatus.Running, done: 1, failed: 0, total: 4).ShouldBeFalse();
        VisualOpenApiController.IsRunFinished(ImageGenRunStatus.Queued, done: 0, failed: 0, total: 4).ShouldBeFalse();

        // 计数器凑齐也算：worker 落终态与写计数之间有一小段，别让调用方在那儿多问一轮
        VisualOpenApiController.IsRunFinished(ImageGenRunStatus.Running, done: 3, failed: 1, total: 4).ShouldBeTrue();
    }

    /// <summary>
    /// 文学写正文：写没写进去一律要判，且「没了」与「被改了」要给不同的说法。
    ///
    /// 上一版把这个判断挂在一个标志位上（只有带条件写入时才看 MatchedCount）。
    /// 于是 replace 且没给版本令牌那条路 —— 过滤器只有 id —— 匹配不到时直接回 200，
    /// 而库里什么都没发生：工作区在读它与写它之间被删了，调用方却被告知「写好了」。
    ///
    /// 这条只能盯源码：要真跑出来得让 Mongo 与驱动在同一微秒里赛跑。所以它盯的是
    /// **判据的形状**（结果无条件要判、两种结局分开说），不是某一句实现的字面。
    /// </summary>
    [Fact]
    public void 文学写正文_写没写进去一律要判()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/LiteraryOpenApiController.cs"));
        src.ShouldContain("if (result.MatchedCount == 0)",
            customMessage: "写入结果必须无条件判一次");
        src.ShouldNotContain("&& result.MatchedCount == 0",
            customMessage: "判据又被挂到标志位后面了：不带条件那次写不进去时会静默回 200");

        var decide = McpSourceGuard.Slice(src, "if (result.MatchedCount == 0)", "return Ok(");
        decide.ShouldContain("WORKSPACE_NOT_FOUND",
            customMessage: "工作区被删掉时要说「没了」，让调用方重读也没用");
        decide.ShouldContain("WORKSPACE_CONTENT_CHANGED",
            customMessage: "被改过时要说「重读再写」，这条和「没了」不是一回事");
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
