using System;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
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
    /// 每一处要动那条条目的地方，都得先核「它是不是我插的那一条」。
    ///
    /// 确定性 id 是会被重用的：原来那条被删掉之后，同键重试可以用同一个 id 插一条新的。
    /// 于是「这个 id 存不存在」「它的时间戳变没变」都答不了真正的问题 —— 重试插的新条目
    /// 在这两件事上跟我的旧条目长得一模一样。只按 id + 时间戳去摘标记，摘掉的是**新那次**
    /// 的标记，而这一次还照样回成功；去删，删掉的是**别人的**条目。
    ///
    /// 前面几轮的补丁（带版本条件、回读判空、毫秒精度）都是在逼近这件事，代次才是它本身。
    /// </summary>
    [Fact]
    public void 动那条条目之前先核代次()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));

        // 插入时盖代次
        src.ShouldContain("var generation = Guid.NewGuid().ToString(\"N\");",
            customMessage: "没有代次，后面所有「是不是我那条」的判断都无从谈起");
        src.ShouldContain("[EntryGenerationKey] = generation",
            customMessage: "代次没写进条目，核对时读不到");

        // 三处回读之后都要核代次：收尾摘标记、正文被别人改过、撤回
        var checks = 0;
        for (var i = src.IndexOf("IsMyGeneration(", StringComparison.Ordinal); i >= 0;
             i = src.IndexOf("IsMyGeneration(", i + 1, StringComparison.Ordinal)) checks++;
        checks.ShouldBeGreaterThanOrEqualTo(5,
            "判据定义 1 处 + 回读核对至少 4 处（收尾、被改过、撤回入口、撤回晚检出）");

        // 删除那一下最狠，代次必须进过滤器本身 —— 只在上面判一次挡不住那一瞬的重用
        src.ShouldContain("Builders<DocumentEntry>.Filter.Eq(EntryGenerationField, generation)",
            customMessage: "删除没把代次写进过滤器：判完到删掉之间被重用，删的就是别人的条目");

        // 正文那条**原子写**同理，而且它最要紧：时间戳只回答「有没有被动过」，
        // 同一毫秒内被删掉再重建的两条在 Id + UpdatedAt 上一模一样，
        // 正文会落进别人那一代里，还接着参与它的收尾。
        var write = McpSourceGuard.Slice(src, "_entryContentWriter.WriteAsync(", ");");
        write.ShouldContain("extraGuard",
            customMessage: "建条目那次正文写入没带代次条件，只有它前后的回读带了 —— 链路只建了一半");
    }

    /// <summary>
    /// 复用分享链时，「有效期算不算变了」问的是：这是同一次请求的重试，还是又一次新请求。
    ///
    /// 两种错法都被 review 抓到过：拿绝对时刻直接判等 —— 重试也差几毫秒，于是**永远**说
    /// 「变了」，幂等命中这个信号（网关据它退额度）彻底作废；反过来只比「要的天数」——
    /// 六天前建的 7 天链接遇上今天的「我要 7 天」，天数一样却被判成没变，调用方以为拿到
    /// 七天、实际那条明天就过期。
    ///
    /// 没有请求键的时候，能分开这两件事的只有时间距离。真正的解法见 doc/debt.platform.md 边界 7。
    /// </summary>
    [Fact]
    public void 分享链复用_秒级重试不算变_隔天再来才算()
    {
        var now = new DateTime(2026, 9, 4, 12, 0, 0, DateTimeKind.Utc);

        // 秒级重试：同一次请求又算了一遍，差几秒 —— 不算变，这才有幂等命中可言
        HostedSiteService.ExpiryMeaningfullyChanged(now.AddDays(7), now.AddDays(7).AddSeconds(3))
            .ShouldBeFalse("重试也差几毫秒到几秒，把它算成改动，幂等命中就永远不会发生");

        // 六天前建的 7 天链接，今天再要 7 天：它明天就过期，必须刷
        HostedSiteService.ExpiryMeaningfullyChanged(now.AddDays(1), now.AddDays(7))
            .ShouldBeTrue("剩一天的链接遇上「我要七天」，天数一样也得刷，否则调用方拿到的寿命不是它要的");

        // 换了个天数：真的变了
        HostedSiteService.ExpiryMeaningfullyChanged(now.AddDays(7), now.AddDays(30)).ShouldBeTrue();

        // 永久 ⇄ 有期限：两个方向都算变
        HostedSiteService.ExpiryMeaningfullyChanged(null, now.AddDays(7)).ShouldBeTrue();
        HostedSiteService.ExpiryMeaningfullyChanged(now.AddDays(7), null).ShouldBeTrue();
        HostedSiteService.ExpiryMeaningfullyChanged(null, null).ShouldBeFalse("都是永久，没变");
    }

    /// <summary>判据只此一处：复用那条路不许自己再写一遍时刻比较。</summary>
    [Fact]
    public void 分享链复用只走那一个判据()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs"));
        src.ShouldContain("ExpiryMeaningfullyChanged(reuse.ExpiresAt, newExpiresAt)",
            customMessage: "复用没走那个判定源");
        src.ShouldNotContain("if (reuse.ExpiresAt != newExpiresAt)",
            customMessage: "又回到直接判等了：重试会被当成真实改动，幂等命中永远不发生");
        src.ShouldNotContain("if (oldExpiresAtForAudit != newExpiresAt || ups.Count > 0)",
            customMessage: "审计条件还挂在绝对时刻上，那个数组会被无限撑大");
    }

    /// <summary>
    /// 占位的时间戳必须是**毫秒精度**，否则整套撤回的条件永远不成立。
    ///
    /// BSON 的日期只有毫秒，而 DateTime.UtcNow 是 100 纳秒刻度。拿后者当乐观并发的条件，
    /// 写进去再读出来就已经不等于手里那个值 —— 于是一条谁也没碰过的占位**每次**都被判成
    /// 「被人改过」：不删、只摘标记，留下一条空的确定性 id 条目，同键重试再也收不了尾；
    /// 正文为空时还会被判成「写成了」，把一次失败报成成功。
    ///
    /// 这类坑不会偶发、只会常态发生，但代码通读一百遍也看不出来 —— 两个 DateTime 比大小，
    /// 哪儿都不像有问题。
    /// </summary>
    [Fact]
    public void 占位的时间戳必须是毫秒精度()
    {
        for (var i = 0; i < 50; i++)
        {
            var stamp = DocumentStoreOpenApiController.BsonNow();
            (stamp.Ticks % TimeSpan.TicksPerMillisecond).ShouldBe(0,
                "带着亚毫秒的时间戳当乐观并发条件，条件永远不成立");
            stamp.Kind.ShouldBe(DateTimeKind.Utc);
        }
    }

    /// <summary>
    /// 而且占位那三个时间戳必须从这儿取 —— 直接写 DateTime.UtcNow 就把上面那个坑请回来了。
    /// </summary>
    [Fact]
    public void 占位不许直接用_UtcNow_当时间戳()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        var init = McpSourceGuard.Slice(src, "var entry = new DocumentEntry", "if (deterministicId != null)");
        foreach (var field in new[] { "CreatedAt", "UpdatedAt", "LastChangedAt" })
        {
            var line = init.Split('\n').FirstOrDefault(l => l.TrimStart().StartsWith(field + " =", StringComparison.Ordinal));
            line.ShouldNotBeNull($"占位不再设置 {field}？撤回的判据就是拿它比的");
            line!.ShouldNotContain("DateTime.UtcNow",
                customMessage: $"{field} 直接用了 UtcNow：亚毫秒位写进 Mongo 会丢，条件永远不成立");
        }
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
        // 锚在**定义**上，判的是「它知不知道这三件事」，不是参数表怎么拼写 ——
        // 上一版把整串签名（连右括号）写进断言，于是给撤回补一个参数（那是更强的判据）
        // 反而把这条守卫弄红了。断言实现的字面，就是这个下场（形状 4a）。
        var signature = McpSourceGuard.Slice(src,
            "private async Task<RollbackOutcome> CleanupRolledBackEntryAsync(", "{");
        foreach (var knows in new[] { "placeholderUpdatedAt", "requestedContent", "generation" })
            signature.ShouldContain(knows,
                customMessage: $"撤回不知道 {knows}，就无从判断该不该删、算不算写成了、这条是不是我插的");

        // 删除那一下的条件：既要「还是我插进去时那个样子」，也要「这条确实是我插的」。
        // 少任何一个，回读与删除之间那一瞬被重用时删掉的就是别人的条目。
        var delete = McpSourceGuard.Slice(src, "DeleteOneAsync(", "CancellationToken.None);");
        delete.ShouldContain("placeholderUpdatedAt",
            customMessage: "删除没带版本条件：判据和写入必须是同一条原子操作");
        delete.ShouldContain("EntryGenerationField",
            customMessage: "删除没带代次条件：确定性 id 被重用时删掉的会是别人的条目");
        src.ShouldNotContain("DeleteOneAsync(e => e.Id == entryId, ",
            customMessage: "又回到无条件删了 —— 正文提交成功的那一瞬会被删掉");

        // 条目已经不是我那条了就得**立刻收手**：这个确定性 id 已经空出来，同键重试可能已经插了
        // 一条新的，再按 id 清一遍派生，清掉的是新那次的版本与双链，而那次还会照常报成功。
        var cleanup = McpSourceGuard.Slice(src,
            "private async Task<RollbackOutcome> CleanupRolledBackEntryAsync(",
            "DocumentEntryVersions.DeleteManyAsync");
        cleanup.ShouldContain("return RollbackOutcome.AlreadyGone;",
            customMessage: "清派生之前没有「不是我那条就收手」的早返回，会按一个已经可重用的 id 去清");
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
