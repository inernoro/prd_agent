using MongoDB.Bson;
using PrdAgent.Core.DataSync;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 资产地址改写（DS1）。
///
/// 附件搬的只有元数据，二进制留在对象存储里，而地址存的是**源站**的绝对地址。
/// 两站不共用同一个桶（或公网前缀不同）时，同步过来的图片、录音、导出文件全部指回源站。
///
/// 这里的每条断言都盯着一个具体的坏结果：改错了别人的地址、该改的没改、
/// 或者「改了几条」和「还有几条没救」被混成一个数字（缺口被藏起来）。
/// </summary>
public class DataSyncAssetUrlsTests
{
    private const string SourceUrl = "https://source.example.com/srcprefix/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png";

    /// <summary>本站存储的拼法：前缀 local + 公网域名。</summary>
    private static string LocalBuild(string key) => $"https://cdn.local.test/local/{key}";

    private static BsonDocument Attachment(string url, string? storageKey = null, string? thumb = null)
    {
        var doc = new BsonDocument { { "_id", "a1" }, { "Url", url } };
        if (storageKey != null) doc["StorageKey"] = storageKey;
        if (thumb != null) doc["ThumbnailUrl"] = thumb;
        return doc;
    }

    [Fact]
    public void 带_StorageKey_的走精确改写()
    {
        var docs = new List<BsonDocument> { Attachment(SourceUrl, storageKey: "prd-agent/img/abcdefghijklmnopqrstuvwxyz.png") };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);

        Assert.Equal(1, result.Rebased);
        Assert.Equal(0, result.Unrecognized);
        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
            docs[0]["Url"].AsString);
    }

    [Fact]
    public void 没有_StorageKey_时从地址反推内容寻址_key()
    {
        // 存量附件（本次改动之前建的）没有 StorageKey，只能从 URL 认 key。
        var docs = new List<BsonDocument> { Attachment(SourceUrl) };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);

        Assert.Equal(1, result.Rebased);
        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
            docs[0]["Url"].AsString);
    }

    [Fact]
    public void 源站前缀有几段都不影响结果()
    {
        // 源站前缀是 0 段、1 段还是 3 段，我们都不知道；判据只认最后三段的形状。
        foreach (var prefix in new[] { "", "p/", "a/b/c/" })
        {
            var docs = new List<BsonDocument>
            {
                Attachment($"https://source.example.com/{prefix}prd-agent/img/abcdefghijklmnopqrstuvwxyz.png"),
            };
            var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);
            Assert.Equal(1, result.Rebased);
            Assert.Equal(
                "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
                docs[0]["Url"].AsString);
        }
    }

    [Fact]
    public void 认不出形状的地址原样留着并计数()
    {
        // 网页托管（层级更深）、头像（层级不同）、以及用户自己填的外链。
        // 宽判据（「取最后三段」）会把这些一起改坏——改错一条地址比不改更难查。
        var docs = new List<BsonDocument>
        {
            Attachment("https://source.example.com/p/web-hosting/sites/s1/index.html"),
            Attachment("https://source.example.com/p/icon/backups/head/u-0123456789ab-0123456789abcdef01234567.png"),
            Attachment("https://some-vendor.example.net/a/b/c.png"),
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);

        Assert.Equal(0, result.Rebased);
        Assert.Equal(3, result.Unrecognized);
        Assert.StartsWith("https://source.example.com/", docs[0]["Url"].AsString);
    }

    [Fact]
    public void 相对地址天然跟着本站走_不动也不算缺口()
    {
        // 本地存储产出的是 `/local-assets/...`，换台机器照样对。
        var docs = new List<BsonDocument> { Attachment("/local-assets/prd-agent/img/x.png") };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);

        Assert.Equal(0, result.Rebased);
        Assert.Equal(0, result.Unrecognized);
        Assert.Equal(1, result.AlreadyRelative);
        Assert.Equal("/local-assets/prd-agent/img/x.png", docs[0]["Url"].AsString);
    }

    [Fact]
    public void 缩略图不许借用主地址的_StorageKey()
    {
        // ThumbnailUrl 与 Url 可能是两个不同的对象。拿 StorageKey 去顶缩略图，
        // 会让两条记录指向同一个文件——数据被悄悄改错，而且看起来一切正常。
        var docs = new List<BsonDocument>
        {
            Attachment(
                SourceUrl,
                storageKey: "prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
                thumb: "https://source.example.com/p/prd-agent/img/zyxwvutsrqponmlkjihgfedcba.png"),
        };
        DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);

        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
            docs[0]["Url"].AsString);
        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/zyxwvutsrqponmlkjihgfedcba.png",
            docs[0]["ThumbnailUrl"].AsString);
    }

    [Fact]
    public void 只改登记过的集合_不碰业务外链()
    {
        // 「扫所有看起来像 URL 的字段」会把 webhook 地址、用户填的参考链接一起改写。
        var docs = new List<BsonDocument>
        {
            new() { { "_id", "w1" }, { "Url", SourceUrl }, { "WebhookUrl", "https://hooks.example.com/x" } },
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "review_webhook_configs", LocalBuild);

        Assert.Equal(0, result.Rebased);
        Assert.Equal(SourceUrl, docs[0]["Url"].AsString);
        Assert.False(DataSyncAssetUrls.HasUrlFields("review_webhook_configs"));
        Assert.True(DataSyncAssetUrls.HasUrlFields("attachments"));
    }

    [Fact]
    public void 拼不出本站地址时不写半截地址_并算进缺口()
    {
        // 本站没配公网根地址之类。写一个半截地址进去，比留着源站地址更难查。
        var docs = new List<BsonDocument> { Attachment(SourceUrl) };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", _ => null);

        Assert.Equal(0, result.Rebased);
        Assert.Equal(1, result.Unrecognized);
        Assert.Equal(SourceUrl, docs[0]["Url"].AsString);
    }

    [Fact]
    public void 没有改写器就整个不动()
    {
        var docs = new List<BsonDocument> { Attachment(SourceUrl) };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", null);

        Assert.Equal(0, result.Rebased);
        Assert.Equal(SourceUrl, docs[0]["Url"].AsString);
    }

    [Fact]
    public void 登记的字段必须在_Attachment_模型上真实存在()
    {
        // 登记一个拼错的字段名，改写会永远命中不到，而计数是 0——
        // 「没有需要改的」和「字段名写错了」长得一模一样（形状 2）。
        var properties = typeof(PrdAgent.Core.Models.Attachment)
            .GetProperties()
            .Select(p => p.Name)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var field in DataSyncAssetUrls.FieldMap["attachments"])
        {
            Assert.True(properties.Contains(field), $"attachments 登记的地址字段 {field} 在 Attachment 模型上不存在");
        }
    }
}
