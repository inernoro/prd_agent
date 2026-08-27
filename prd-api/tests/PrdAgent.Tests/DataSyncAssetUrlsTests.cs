using MongoDB.Bson;
using PrdAgent.Core.DataSync;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 资产地址改写（DS1 / DS30 / DS31 / DS33 / DS34）。
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

    /// <summary>
    /// 本站存储的两种拼法，对应两类 key：
    /// 内容寻址收到的是**逻辑** key，前缀由本站自己套（这里是 `local`）；
    /// 完整物理路径两侧原样使用，套前缀反而拼错。
    /// </summary>
    private static string? LocalBuild(string key, DataSyncAssetUrls.AssetKeyKind kind)
        => kind == DataSyncAssetUrls.AssetKeyKind.ContentAddressed
            ? $"https://cdn.local.test/local/{key}"
            : $"https://cdn.local.test/{key}";

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
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;

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
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;

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
            var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;
            Assert.Equal(1, result.Rebased);
            Assert.Equal(
                "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
                docs[0]["Url"].AsString);
        }
    }

    /// <summary>
    /// 两站前缀不同时，源站那一段必须被剥掉（DS31）。
    ///
    /// `StorageKey` 存的是源站的**物理** key，前面带着源站自己配的前缀
    /// （`SaveAsync` 存进去的就是带前缀那份）。把它原样交给目标站拼地址，
    /// 会拼出 `{目标站根}/{目标站前缀}/{源站前缀}/...`——谁家都不是，
    /// 而且因为「改写成功」还会被计进已改写，缺口反倒被数字盖住了。
    /// </summary>
    [Theory]
    [InlineData("srcprefix/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png")]
    [InlineData("a/b/c/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png")]
    [InlineData("/srcprefix/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png")]
    [InlineData("prd-agent/img/abcdefghijklmnopqrstuvwxyz.png")]
    public void 源站前缀必须剥掉_由目标站套自己的(string sourcePhysicalKey)
    {
        var docs = new List<BsonDocument> { Attachment(SourceUrl, storageKey: sourcePhysicalKey) };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;

        Assert.Equal(1, result.Rebased);
        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
            docs[0]["Url"].AsString);
        Assert.DoesNotContain("srcprefix", docs[0]["Url"].AsString, StringComparison.Ordinal);
    }

    /// <summary>
    /// 改写器拿到的必须是**逻辑** key，前缀交给本站存储去套。
    ///
    /// 这条钉的是接口而不是结果：改写方自己拼一次前缀也能得出同样的字符串，
    /// 但那就是第二份拼法，与存储实现必然漂移（形状 3）。
    /// </summary>
    [Fact]
    public void 内容寻址交给改写器的是逻辑_key_不带任何前缀()
    {
        var seen = new List<(string Key, DataSyncAssetUrls.AssetKeyKind Kind)>();
        var docs = new List<BsonDocument> { Attachment(SourceUrl, storageKey: "srcprefix/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png") };

        DataSyncAssetUrls.RebaseIncoming(docs, "attachments", (key, kind) =>
        {
            seen.Add((key, kind));
            return LocalBuild(key, kind);
        });

        var one = Assert.Single(seen);
        Assert.Equal("prd-agent/img/abcdefghijklmnopqrstuvwxyz.png", one.Key);
        Assert.Equal(DataSyncAssetUrls.AssetKeyKind.ContentAddressed, one.Kind);
    }

    /// <summary>
    /// 完整物理路径那一类**不许**被剥前缀（DS31 的另一半）。
    ///
    /// 首页素材、桌面端素材的 `RelativePath` 上传与拼地址两侧原样使用，压根不涉及前缀。
    /// 拿内容寻址那套「取末三段」去处理它，`icon/desktop/dark/bg.mp4` 会被截成
    /// `desktop/dark/bg.mp4`——一个本站不存在的路径。
    /// </summary>
    [Theory]
    [InlineData("homepage_assets", "icon/desktop/dark/bg.mp4")]
    [InlineData("desktop_assets", "icon/desktop/light/hero.png")]
    public void 完整物理路径原样搬运_不套前缀也不截断(string collection, string relativePath)
    {
        var seen = new List<(string Key, DataSyncAssetUrls.AssetKeyKind Kind)>();
        var docs = new List<BsonDocument>
        {
            new()
            {
                { "_id", "h1" },
                { "Url", $"https://source.example.com/srcprefix/{relativePath}" },
                { "RelativePath", relativePath },
            },
        };

        var result = DataSyncAssetUrls.RebaseIncoming(docs, collection, (key, kind) =>
        {
            seen.Add((key, kind));
            return LocalBuild(key, kind);
        }).Total;

        Assert.Equal(1, result.Rebased);
        var one = Assert.Single(seen);
        Assert.Equal(relativePath, one.Key);
        Assert.Equal(DataSyncAssetUrls.AssetKeyKind.PhysicalPath, one.Kind);
        Assert.Equal($"https://cdn.local.test/{relativePath}", docs[0]["Url"].AsString);
    }

    /// <summary>
    /// 完整物理路径那一类没有 key 字段就认不出来——**不猜**。
    ///
    /// 这类地址的层级各不相同（`icon/desktop/dark/bg.mp4` 四段、别的三段），
    /// 拿正则去猜必然改坏一批。认不出就如实算进缺口。
    /// </summary>
    [Fact]
    public void 完整物理路径缺_key_字段时算缺口而不是硬猜()
    {
        var docs = new List<BsonDocument>
        {
            new() { { "_id", "h1" }, { "Url", "https://source.example.com/srcprefix/icon/desktop/dark/bg.mp4" } },
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "homepage_assets", LocalBuild).Total;

        Assert.Equal(0, result.Rebased);
        Assert.Equal(1, result.Unrecognized);
        Assert.StartsWith("https://source.example.com/", docs[0]["Url"].AsString);
    }

    /// <summary>生成图没有 key 字段，但它本来就是内容寻址存的，正则认得出（DS33）。</summary>
    [Fact]
    public void 生成图两个地址字段都要改写()
    {
        var docs = new List<BsonDocument>
        {
            new()
            {
                { "_id", "i1" },
                { "Url", SourceUrl },
                { "OriginalUrl", "https://source.example.com/srcprefix/prd-agent/img/zyxwvutsrqponmlkjihgfedcba.png" },
            },
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "image_assets", LocalBuild).Total;

        Assert.Equal(2, result.Rebased);
        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
            docs[0]["Url"].AsString);
        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/zyxwvutsrqponmlkjihgfedcba.png",
            docs[0]["OriginalUrl"].AsString);
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
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;

        Assert.Equal(0, result.Rebased);
        Assert.Equal(3, result.Unrecognized);
        Assert.StartsWith("https://source.example.com/", docs[0]["Url"].AsString);
    }

    /// <summary>
    /// 相对地址**且没有可用 key** 时不改写，但必须数出来（DS30）。
    ///
    /// 「已经是相对路径 = 天然可移植」只在两站共享同一份磁盘时成立，而跨实例同步的
    /// 前提恰恰是两台不同机器。源站用本地磁盘存附件时，每一个地址都指向本站不存在的
    /// 文件；早先这一档既不改写也不计数，于是三个数全是 0、附件卡整个不出现，
    /// 一句提示都没有。
    /// </summary>
    [Fact]
    public void 相对地址且认不出_key_时不改写但必须单独数出来()
    {
        // 没有 StorageKey，地址又是相对的：文件名不是内容寻址的形状，反推不出 key。
        var docs = new List<BsonDocument> { Attachment("/local-assets/prd-agent/img/x.png") };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;

        Assert.Equal(0, result.Rebased);
        Assert.Equal(0, result.Unrecognized);
        Assert.Equal(1, result.AlreadyRelative);
        // 不改写是因为确实无从改起：key 不在地址里，文件也没搬。能做的是别再静默。
        Assert.Equal("/local-assets/prd-agent/img/x.png", docs[0]["Url"].AsString);
    }

    /// <summary>
    /// 相对地址**带着可用 key** 时必须照常改写（Codex review P1）。
    ///
    /// 源站用本地磁盘存附件，地址是 `/local-assets/...`，但 `StorageKey` 照样存着——
    /// 那是改得了的。上一版把「不是绝对地址」当成提前退出条件放在读 key 之前，
    /// 于是这些明明能改的地址被判成「改不了」，界面还照着说「这种地址改不了也用不了」；
    /// 操作者按提示把文件复制过来、或两站都换成对象存储再同步，地址照样指着源站。
    ///
    /// 真正改不了的是「没有可用的 key」，不是「地址是相对的」——判据窄了一档（形状 1）。
    /// </summary>
    [Fact]
    public void 相对地址带着_StorageKey_时照样改写()
    {
        var docs = new List<BsonDocument>
        {
            Attachment("/local-assets/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
                storageKey: "prd-agent/img/abcdefghijklmnopqrstuvwxyz.png"),
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;

        Assert.Equal(1, result.Rebased);
        Assert.Equal(0, result.AlreadyRelative);
        Assert.Equal(
            "https://cdn.local.test/local/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
            docs[0]["Url"].AsString);
    }

    /// <summary>首页 / 桌面端素材同理：地址是相对的，`RelativePath` 却完全够用。</summary>
    [Theory]
    [InlineData("homepage_assets")]
    [InlineData("desktop_assets")]
    public void 相对地址带着_RelativePath_时照样改写(string collection)
    {
        var docs = new List<BsonDocument>
        {
            new()
            {
                { "_id", "h1" },
                { "Url", "/local-assets/icon/desktop/dark/bg.mp4" },
                { "RelativePath", "icon/desktop/dark/bg.mp4" },
            },
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, collection, LocalBuild).Total;

        Assert.Equal(1, result.Rebased);
        Assert.Equal(0, result.AlreadyRelative);
        Assert.Equal("https://cdn.local.test/icon/desktop/dark/bg.mp4", docs[0]["Url"].AsString);
    }

    /// <summary>
    /// 有 key 但拼不出本站地址：算进缺口，不算进「相对」。
    ///
    /// 这一档已经不是「无从改起」了——key 是有的，是本站没配好。混进相对那一档，
    /// 界面会让人去复制文件，而真正该做的是把本站的公网根地址配上。
    /// </summary>
    [Fact]
    public void 相对地址有_key_却拼不出本站地址时算缺口()
    {
        var docs = new List<BsonDocument>
        {
            Attachment("/local-assets/prd-agent/img/abcdefghijklmnopqrstuvwxyz.png",
                storageKey: "prd-agent/img/abcdefghijklmnopqrstuvwxyz.png"),
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", (_, _) => null).Total;

        Assert.Equal(0, result.Rebased);
        Assert.Equal(1, result.Unrecognized);
        Assert.Equal(0, result.AlreadyRelative);
    }

    /// <summary>相对地址那一档不许被并进「已改写」或「认不出」——三个数各说各的事。</summary>
    [Fact]
    public void 三档计数互不混淆()
    {
        var docs = new List<BsonDocument>
        {
            Attachment(SourceUrl),                                        // 改得了
            Attachment("https://some-vendor.example.net/a/b/c.png"),      // 认不出
            Attachment("/local-assets/prd-agent/img/x.png"),              // 相对
        };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;

        Assert.Equal(1, result.Rebased);
        Assert.Equal(1, result.Unrecognized);
        Assert.Equal(1, result.AlreadyRelative);
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
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "review_webhook_configs", LocalBuild).Total;

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
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", (_, _) => null).Total;

        Assert.Equal(0, result.Rebased);
        Assert.Equal(1, result.Unrecognized);
        Assert.Equal(SourceUrl, docs[0]["Url"].AsString);
    }

    [Fact]
    public void 没有改写器就整个不动()
    {
        var docs = new List<BsonDocument> { Attachment(SourceUrl) };
        var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", null);

        Assert.Equal(0, result.Total.Rebased);
        Assert.Empty(result.ByDocument);
        Assert.Equal(SourceUrl, docs[0]["Url"].AsString);
    }

    /// <summary>
    /// 逐文档结果必须与传入下标一一对齐（DS34 的前提）。
    ///
    /// 落库时可能有几条撞唯一索引被剔除，而计数在那之前就累加过了。调用方要拿
    /// 被剔掉的**下标**回冲，对不齐就等于冲错人——那比不冲还糟。
    /// </summary>
    [Fact]
    public void 逐文档结果与传入下标一一对齐()
    {
        var docs = new List<BsonDocument>
        {
            Attachment(SourceUrl),                                        // 0: 改得了
            Attachment("https://some-vendor.example.net/a/b/c.png"),      // 1: 认不出
            Attachment("/local-assets/prd-agent/img/x.png"),              // 2: 相对
            Attachment("https://source.example.com/no-url-field.png"),    // 3: 认不出
        };
        var batch = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);

        Assert.Equal(docs.Count, batch.ByDocument.Count);
        Assert.Equal(new DataSyncAssetUrls.RebaseResult(1, 0, 0), batch.ByDocument[0]);
        Assert.Equal(new DataSyncAssetUrls.RebaseResult(0, 1, 0), batch.ByDocument[1]);
        Assert.Equal(new DataSyncAssetUrls.RebaseResult(0, 0, 1), batch.ByDocument[2]);
        Assert.Equal(new DataSyncAssetUrls.RebaseResult(0, 1, 0), batch.ByDocument[3]);

        // 合计就是逐条之和，不是另算一遍（判据分裂的经典入口）。
        var summed = batch.ByDocument.Aggregate(
            DataSyncAssetUrls.RebaseResult.Empty, (acc, one) => acc.Add(one));
        Assert.Equal(batch.Total, summed);
    }

    /// <summary>
    /// 被剔掉的那几条要能从合计里减回去（DS34）。
    ///
    /// 落库前就把「打算改」记成了「改了」，而插入撞唯一索引会被整条剔除。
    /// 不回冲的话，界面报的「已改写 N 条」里混着从没写进库的那几条。
    /// </summary>
    [Fact]
    public void 没落库的那几条要能从合计里减回去()
    {
        var docs = new List<BsonDocument>
        {
            Attachment(SourceUrl),
            Attachment("https://source.example.com/srcprefix/prd-agent/img/zyxwvutsrqponmlkjihgfedcba.png"),
            Attachment("https://some-vendor.example.net/a/b/c.png"),
        };
        var batch = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild);
        Assert.Equal(new DataSyncAssetUrls.RebaseResult(2, 1, 0), batch.Total);

        // 第 1 条撞了唯一索引，被整条剔除。
        var actual = batch.Total.Subtract(batch.ByDocument[1]);
        Assert.Equal(new DataSyncAssetUrls.RebaseResult(1, 1, 0), actual);
    }

    /// <summary>
    /// 真的跑一次本地存储，拿**它产出的那个 key** 来验形状判据（Codex review P1）。
    ///
    /// 上一版的判据只认 26 位 base32（R2 / COS 的写法），而本地磁盘存的是完整
    /// sha256 十六进制、64 位。于是源站用本地磁盘时，`StorageKey` 明明是可用的，
    /// 却过不了形状检查——DS30 要修的正是这个场景，判据反倒把它挡在门外。
    ///
    /// 这条**不扫源码、不写死形状**：直接 `SaveAsync` 一次拿真 key 来跑。
    /// 哪天本地存储改了命名，这条就红——那正是它该红的时候（形状 6：
    /// 判据要读真正生效的值，不是读我以为的那个）。
    /// </summary>
    [Fact]
    public async Task 本地存储产出的_key_必须过得了形状判据()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ds-local-" + Guid.NewGuid().ToString("N"));
        try
        {
            var storage = new PrdAgent.Infrastructure.Services.AssetStorage.LocalAssetStorage(dir);
            var stored = await storage.SaveAsync(
                new byte[] { 1, 2, 3, 4 }, "image/png", CancellationToken.None,
                domain: "prd-agent", type: "img", extensionHint: "png");

            Assert.False(string.IsNullOrWhiteSpace(stored.Key), "本地存储没回填 key，这条守卫的前提已变");

            // 一、它自己就该被认出来。
            var logical = DataSyncAssetUrls.TryExtractContentAddressedKey(stored.Key!, alreadyKey: true);
            Assert.Equal(stored.Key!.ToLowerInvariant(), logical);

            // 二、端到端：地址是相对的、key 是本地存储那一套，照样改得了。
            var docs = new List<BsonDocument>
            {
                Attachment(stored.Url, storageKey: stored.Key),
            };
            var result = DataSyncAssetUrls.RebaseIncoming(docs, "attachments", LocalBuild).Total;
            Assert.Equal(1, result.Rebased);
            Assert.Equal(0, result.AlreadyRelative);
            Assert.Equal($"https://cdn.local.test/local/{stored.Key}", docs[0]["Url"].AsString);
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void 登记的字段必须在对应模型上真实存在()
    {
        // 登记一个拼错的字段名，改写会永远命中不到，而计数是 0——
        // 「没有需要改的」和「字段名写错了」长得一模一样（形状 2）。
        //
        // key 字段一并查：它拼错的后果更隐蔽——地址字段还在，只是永远退回
        // 「从地址反推」，DS31 想修的那件事（剥源站前缀）静默失效。
        var modelByCollection = new Dictionary<string, Type>(StringComparer.Ordinal)
        {
            ["attachments"] = typeof(PrdAgent.Core.Models.Attachment),
            ["homepage_assets"] = typeof(PrdAgent.Core.Models.HomepageAsset),
            ["desktop_assets"] = typeof(PrdAgent.Core.Models.DesktopAsset),
            // desktop_asset_skins 不在这里：它只存皮肤的名字与开关，模型上**一个地址字段都没有**
            // （文件本身挂在 desktop_assets 的 Skin 维度下）。第一版按「创作与素材那一组里的
            // 资产集合」凭印象把它一起登记了，是这条守卫当场查出来的——登记一个不存在的字段，
            // 改写永远命中不到而计数是 0，和「没有需要改的」长得一模一样。
            ["image_assets"] = typeof(PrdAgent.Core.Models.ImageAsset),
        };

        // 登记表长出新集合而这里没跟上时要红，否则新集合的字段名从来没被查过。
        Assert.Equal(
            DataSyncAssetUrls.FieldMap.Keys.OrderBy(x => x, StringComparer.Ordinal),
            modelByCollection.Keys.OrderBy(x => x, StringComparer.Ordinal));

        foreach (var (collection, model) in modelByCollection)
        {
            var properties = model.GetProperties().Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
            foreach (var spec in DataSyncAssetUrls.FieldMap[collection])
            {
                Assert.True(properties.Contains(spec.Field),
                    $"{collection} 登记的地址字段 {spec.Field} 在 {model.Name} 上不存在");
                if (spec.KeyField is null) continue;
                Assert.True(properties.Contains(spec.KeyField),
                    $"{collection} 登记的 key 字段 {spec.KeyField} 在 {model.Name} 上不存在");
            }
        }
    }
}
