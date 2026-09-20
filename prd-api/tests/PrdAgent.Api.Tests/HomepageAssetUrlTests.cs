using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 配图 URL 必须带自己的版本号。
///
/// 盯的是 `predicate-and-wiring-discipline` 形状 6（判据读的值不是真正生效的那个值）：
/// 对象 key 按 slot 确定性算出来，同一个 slot 重新生成、扩展名没变，写的就是同一个 key，
/// URL 一字不变。真正决定用户看到哪张图的是**浏览器与 CDN 的缓存键**，而缓存键是 URL——
/// 前端把 slot→url 那张表作废掉换不掉缓存里的字节。
///
/// 删掉三个读端点里的 `HomepageAssetUrl.Versioned(...)`，页面照常渲染、其它测试照常绿，
/// 只有管理员重新生成一张图之后盯着旧图发呆时才会发现。所以这里必须有守卫。
/// </summary>
public class HomepageAssetUrlTests
{
    private static readonly DateTime Updated = new(2026, 9, 16, 8, 30, 0, DateTimeKind.Utc);

    [Fact]
    public void 干净的URL挂上问号版本号()
    {
        var url = HomepageAssetUrl.Versioned("https://cdn.example.com/icon/homepage/bookshelf/vol/boot.png", Updated);
        url.ShouldBe("https://cdn.example.com/icon/homepage/bookshelf/vol/boot.png?v=1789547400");
    }

    [Fact]
    public void 本来就带查询串的URL用与号续接不是再来一个问号()
    {
        var url = HomepageAssetUrl.Versioned("https://cdn.example.com/a.png?sign=abc", Updated);
        url.ShouldBe("https://cdn.example.com/a.png?sign=abc&v=1789547400");
    }

    [Fact]
    public void 两次生成之间版本号必须不同否则缓存还是老的()
    {
        var first = HomepageAssetUrl.Versioned("https://cdn.example.com/a.png", Updated);
        var second = HomepageAssetUrl.Versioned("https://cdn.example.com/a.png", Updated.AddMinutes(7));
        second.ShouldNotBe(first);
    }

    [Fact]
    public void 存量文档没有更新时间时不硬造一个假版本()
    {
        HomepageAssetUrl.Versioned("https://cdn.example.com/a.png", default)
            .ShouldBe("https://cdn.example.com/a.png");
    }

    [Fact]
    public void 空URL原样返回不拼出一个只有查询串的地址()
    {
        HomepageAssetUrl.Versioned("", Updated).ShouldBe("");
        HomepageAssetUrl.Versioned(null, Updated).ShouldBe("");
    }

    [Fact]
    public void 实体重载取的是这张图自己的更新时间()
    {
        var asset = new HomepageAsset
        {
            Slot = "bookshelf.vol.boot",
            Url = "https://cdn.example.com/icon/homepage/bookshelf/vol/boot.png",
            UpdatedAt = Updated,
        };
        HomepageAssetUrl.Versioned(asset).ShouldBe(HomepageAssetUrl.Versioned(asset.Url, Updated));
    }
}
