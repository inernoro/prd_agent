using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 首页/系统配图的对外 URL —— 带上这张图自己的版本号。
///
/// 为什么必须带：对象 key 是按 slot 确定性算出来的（`icon/homepage/bookshelf/vol/boot.png`），
/// 同一个 slot 重新生成一张、扩展名又没变，写的就是**同一个 key**，URL 一个字符都不变。
/// 于是浏览器与 CDN 手里那份旧字节仍然命中缓存：管理员在配图中心看着「已生成」，
/// 页面上还是上一张，要等缓存自己过期，或者硬刷新。
///
/// 前端把 slot→url 的那张表作废掉解决不了这件事——它换不掉浏览器缓存里的字节，
/// 只有让 URL 本身变了才算数（`predicate-and-wiring-discipline` 形状 6：
/// 判据读的值不是真正生效的那个值。生效的是缓存键，而缓存键是 URL）。
///
/// 三个读端点（管理端 list、登录后 assets、匿名 landing）共用这一份，
/// 不许任一侧自己拼一遍：拼法不一致就等于各自缓存各自的版本。
/// </summary>
public static class HomepageAssetUrl
{
    /// <summary>
    /// 给 URL 挂上版本查询串。空 URL 原样返回（调用方本来就会过滤掉它）。
    /// 版本取这张图的更新时间（秒），对象存储忽略查询串，所以取回来的还是同一个对象。
    /// </summary>
    public static string Versioned(string? url, DateTime updatedAt)
    {
        if (string.IsNullOrWhiteSpace(url)) return url ?? string.Empty;
        var v = new DateTimeOffset(DateTime.SpecifyKind(updatedAt, DateTimeKind.Utc)).ToUnixTimeSeconds();
        if (v <= 0) return url;                       // 存量文档没有 UpdatedAt，不硬加一个假版本
        var sep = url.Contains('?') ? '&' : '?';
        return $"{url}{sep}v={v}";
    }

    /// <summary>实体直接取版本化 URL。</summary>
    public static string Versioned(HomepageAsset asset) => Versioned(asset.Url, asset.UpdatedAt);
}
