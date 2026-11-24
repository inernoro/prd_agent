using System;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 站点删除围栏：借用/发布登记不碰 ContentVersion 与 UpdatedAt，所以那两条拦不住
/// 「读站点之后、删除之前新开始的一次发布」。读取时那道租约判断必须与删除同一次原子操作里成立。
/// </summary>
/// <remarks>
/// 本类刻意**不带** Category=Integration：真实并发行为由集成用例证明，但 CI 的默认过滤
/// （Category!=Integration）不跑集成用例，只有集成守卫等于守卫没接上线。这里断言围栏渲染出的
/// 查询结构，把「租约条件在不在围栏里」变成 CI 每次都会跑的判据。
/// </remarks>
public sealed class HostedSiteDeletionFenceTests
{
    private static BsonDocument Render()
    {
        var filter = HostedSiteService.BuildHostedSiteDeletionFence(
            "site-1",
            "owner-1",
            new DateTime(2026, 9, 16, 0, 0, 0, DateTimeKind.Utc),
            new DateTime(2026, 9, 16, 1, 0, 0, DateTimeKind.Utc),
            new DateTime(2026, 9, 16, 2, 0, 0, DateTimeKind.Utc));
        return filter.Render(new RenderArgs<HostedSite>(
            BsonSerializer.SerializerRegistry.GetSerializer<HostedSite>(),
            BsonSerializer.SerializerRegistry));
    }

    [Fact]
    public void Fence_ShouldStillPinIdentityAndContentSnapshot()
    {
        var doc = Render();
        doc.Contains("_id").ShouldBeTrue();
        doc.Contains("OwnerUserId").ShouldBeTrue();
        doc.Contains("ContentVersion").ShouldBeTrue();
        doc.Contains("UpdatedAt").ShouldBeTrue();
    }

    [Fact]
    public void Fence_ShouldRefuseToDeleteWhileAPublishLeaseIsHeld()
    {
        var json = Render().ToJson();

        // 租约与发布中的键必须一起出现在围栏里——这两个字段正是登记会写、而
        // ContentVersion/UpdatedAt 不会动的那两个。少任何一个，交错窗口就重新打开。
        json.ShouldContain("AssetPublishLeaseExpiresAt", customMessage: "围栏必须把发布租约算进去，否则读取与登记一交错，删除会拿着过期的键清单成功执行");
        json.ShouldContain("AssetPublishInProgressKeys", customMessage: "围栏必须与读取时那道判断逐字一致：租约未过期且有发布中的键才算进行中");
        json.ShouldContain("$or", customMessage: "两个条件是「或」不是「与」：释放登记只清空键数组、不回拨租约时间戳");
    }

    [Fact]
    public void Fence_ShouldNotSweepBorrowedKeys()
    {
        // 借用场景里被登记的键恰恰是源站自己的当前文件。租约的语义是让删除**等**，
        // 不是让删除**跳过或扫掉**这些键——围栏里不该出现任何键清单比对。
        var json = Render().ToJson();
        json.ShouldNotContain("PendingAssetCleanupKeys", customMessage: "围栏不该拿待清理键做比对，那会把借用登记的源站文件卷进删除判定");
        json.ShouldNotContain("Files", customMessage: "围栏不该比对文件清单");
    }
}
