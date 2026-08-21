using MongoDB.Bson;
using MongoDB.Bson.IO;
using PrdAgent.Core.DataSync;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 落库决策与文档解析的回归。
///
/// 这两处的错误都不会抛异常，只会让数据悄悄变形：类型掉了、条数翻倍、本地改动被盖。
/// 所以每条断言都盯着一个具体的坏结果，而不是「函数返回了东西」。
/// </summary>
public class DataSyncApplyTests
{
    private static string Canonical(BsonDocument doc) =>
        doc.ToJson(new JsonWriterSettings { OutputMode = JsonOutputMode.CanonicalExtendedJson });

    /// <summary>「目标站已有这些 id」的便捷构造：归一后的 key -> 真实 _id。</summary>
    private static Dictionary<string, BsonValue> Existing(params BsonValue[] ids) =>
        ids.ToDictionary(DataSyncApply.NormalizeId, id => id, StringComparer.Ordinal);

    /// <summary>
    /// ObjectId 与它的 24 位十六进制字符串形态是同一个身份——这是**唯一**有意的等价。
    /// </summary>
    [Fact]
    public void 归一把ObjectId与其字符串形态视为同一条()
    {
        var oid = MongoDB.Bson.ObjectId.Parse("507f1f77bcf86cd799439011");
        Assert.Equal(
            DataSyncApply.NormalizeId(new BsonObjectId(oid)),
            DataSyncApply.NormalizeId(new BsonString("507f1f77bcf86cd799439011")));
    }

    /// <summary>
    /// 除那一对之外，不同 BSON 类型的 _id 必须归一成**不同**的键。
    ///
    /// 上一版直接 `ToString()`，`_id: 42`（数字）与 `_id: "42"`（字符串）撞成同一个键——
    /// 它们在 Mongo 里是两条不同的文档，而导出这条链路明确支持数字 id。撞在一起之后：
    /// 默认模式把源站那条数字记录当成「目标站已有」静默跳过；覆盖模式更糟，
    /// 拿数字那条的内容替换了字符串那条，数字那条从头到尾没被插入。
    /// </summary>
    [Theory]
    [InlineData(42)]          // Int32 42  vs  "42"
    [InlineData(0)]
    [InlineData(-1)]
    public void 归一不把数字id与同形字符串撞在一起(int numeric)
    {
        Assert.NotEqual(
            DataSyncApply.NormalizeId(new BsonInt32(numeric)),
            DataSyncApply.NormalizeId(new BsonString(numeric.ToString())));
    }

    /// <summary>布尔、Int64 与同形字符串同理。</summary>
    [Fact]
    public void 归一不把其它标量id与同形字符串撞在一起()
    {
        Assert.NotEqual(
            DataSyncApply.NormalizeId(BsonBoolean.True),
            DataSyncApply.NormalizeId(new BsonString("true")));
        Assert.NotEqual(
            DataSyncApply.NormalizeId(new BsonInt64(7L)),
            DataSyncApply.NormalizeId(new BsonString("7")));
        // Int32 7 与 Int64 7 在 Mongo 里是**同一条**（数值同段相等），
        // 但归一键带类型会把它们分开——这是已知边界，见下面那条注释测试。
    }

    /// <summary>
    /// 大写十六进制串**不**算 ObjectId 的字符串形态。
    ///
    /// Mongo 里 `"507F…"` 与 `"507f…"` 本来就是两条不同的文档，为了「顺手」小写归一
    /// 会造出一个新的误撞，正是这次要修的那种。所以要求逐字往返才认。
    /// </summary>
    [Fact]
    public void 归一不把大写十六进制串当成ObjectId()
    {
        var oid = MongoDB.Bson.ObjectId.Parse("507f1f77bcf86cd799439011");
        Assert.NotEqual(
            DataSyncApply.NormalizeId(new BsonObjectId(oid)),
            DataSyncApply.NormalizeId(new BsonString("507F1F77BCF86CD799439011")));
    }

    /// <summary>
    /// 端到端：目标站有一条字符串 `_id: "42"`，源站送来数字 `_id: 42`。
    /// 它们是两条不同的记录，数字那条必须走**插入**，不能被判成已存在。
    /// </summary>
    [Fact]
    public void 数字id不会被同形字符串记录挡成已存在()
    {
        var incoming = new[] { new BsonDocument { { "_id", new BsonInt32(42) }, { "V", "from-source" } } };

        var skipMode = DataSyncApply.Decide(incoming, Existing(new BsonString("42")), overwrite: false);
        Assert.Single(skipMode.ToInsert);
        Assert.Empty(skipMode.SkippedIds);

        // 覆盖模式同理：不能拿它去替换那条字符串记录。
        var overwriteMode = DataSyncApply.Decide(incoming, Existing(new BsonString("42")), overwrite: true);
        Assert.Single(overwriteMode.ToInsert);
        Assert.Empty(overwriteMode.ToReplace);
    }

    [Fact]
    public void 扩展JSON往返不丢类型()
    {
        var original = new BsonDocument
        {
            { "_id", "d1" },
            { "CreatedAt", new BsonDateTime(new DateTime(2026, 8, 20, 3, 4, 5, DateTimeKind.Utc)) },
            { "Size", new BsonInt64(9_007_199_254_740_993L) },
            { "Score", 1.5 },
            { "Enabled", true },
        };

        var parsed = DataSyncApply.ParseDocuments(new[] { Canonical(original) }).Single();

        // 普通 JSON 会把日期变成字符串、把大整数变成 double 丢精度，这两条正是要挡的。
        Assert.Equal(BsonType.DateTime, parsed["CreatedAt"].BsonType);
        Assert.Equal(new DateTime(2026, 8, 20, 3, 4, 5, DateTimeKind.Utc), parsed["CreatedAt"].ToUniversalTime());
        Assert.Equal(BsonType.Int64, parsed["Size"].BsonType);
        Assert.Equal(9_007_199_254_740_993L, parsed["Size"].AsInt64);
        Assert.True(parsed["Enabled"].AsBoolean);
    }

    [Fact]
    public void 空集合不产生文档而空串是坏数据()
    {
        // 「一条都没有」和「有一条但它是空的」是两件事。
        //
        // 这条用例原来叫「空串与空集合不产生文档」，把两者一起断言成空——等于用测试
        // 把「静默丢掉坏数据」钉死成正确行为。后果不是少一条：调用方拿到的页看着正常，
        // 游标照常前进，整条同步报成功而那一条从没落地
        //（predicate-and-wiring-discipline 形状 4a：测试反向锁死 bug）。
        Assert.Empty(DataSyncApply.ParseDocuments(Array.Empty<string>()));
        Assert.Empty(DataSyncApply.ParseDocuments(null!));

        Assert.Throws<InvalidOperationException>(() => DataSyncApply.ParseDocuments(new[] { "" }));
        Assert.Throws<InvalidOperationException>(() => DataSyncApply.ParseDocuments(new[] { "   " }));
        // 混在正常文档中间的空串同样要炸，不能因为「大部分是好的」就放过。
        Assert.Throws<InvalidOperationException>(
            () => DataSyncApply.ParseDocuments(new[] { "{\"_id\": \"a\"}", " " }));
    }

    [Fact]
    public void 默认跳过本地已存在的同Id文档()
    {
        var incoming = new List<BsonDocument>
        {
            new() { { "_id", "a" }, { "Title", "源站版本" } },
            new() { { "_id", "b" }, { "Title", "新的" } },
        };
        var existing = Existing("a");

        var decision = DataSyncApply.Decide(incoming, existing, overwrite: false);

        Assert.Equal(new[] { "b" }, decision.ToInsert.Select(d => d["_id"].AsString));
        Assert.Empty(decision.ToReplace);
        Assert.Equal(new BsonValue[] { "a" }, decision.SkippedIds);
    }

    [Fact]
    public void 覆盖模式下已存在的走替换而不是再插一条()
    {
        var incoming = new List<BsonDocument> { new() { { "_id", "a" }, { "Title", "源站版本" } } };
        var decision = DataSyncApply.Decide(incoming, Existing("a"), overwrite: true);

        Assert.Empty(decision.ToInsert);
        Assert.Single(decision.ToReplace);
        Assert.Empty(decision.SkippedIds);
        // 若这里退化成 Insert，本地会出现两条同 _id —— 实际会撞唯一索引，
        // 于是整批 InsertMany 报错，一次覆盖同步变成一次失败同步。
    }

    [Fact]
    public void 没有Id的文档一律丢弃()
    {
        var incoming = new List<BsonDocument>
        {
            new() { { "Title", "没有 _id" } },
            new() { { "_id", BsonNull.Value }, { "Title", "_id 是 null" } },
            new() { { "_id", "ok" } },
        };
        var decision = DataSyncApply.Decide(incoming, Existing(), overwrite: false);

        // 收下它们会得到本地新生成的 id，下次同步再收一遍——每同步一次翻一倍。
        Assert.Equal(new[] { "ok" }, decision.ToInsert.Select(d => d["_id"].AsString));
    }

    [Fact]
    public void 同一批里的重复Id不会互相遮蔽()
    {
        // 源站按 _id 升序分页，正常不会同页出现重复；但真出现时两条都该被当成新增交给
        // Mongo，由唯一索引兜底，而不是在这里静默吞掉一条。
        var incoming = new List<BsonDocument>
        {
            new() { { "_id", "dup" }, { "V", 1 } },
            new() { { "_id", "dup" }, { "V", 2 } },
        };
        var decision = DataSyncApply.Decide(incoming, Existing(), overwrite: false);
        Assert.Equal(2, decision.ToInsert.Count);
    }

    [Fact]
    public void 待补清单只列出源站清空过的字段()
    {
        Assert.True(DataSyncScope.TryResolve("llmplatforms", out var platform));
        var documents = new List<BsonDocument>
        {
            new() { { "_id", "p1" }, { "Name", "OpenAI" }, { "ApiKeyEncrypted", "" } },
            new() { { "_id", "p2" }, { "Name", "本地模型" } },   // 压根没这个字段
        };

        var pending = DataSyncApply.DetectPendingSecretFields(documents, platform);

        Assert.Equal(new[] { "ApiKeyEncrypted" }, pending);
    }

    [Fact]
    public void 没有敏感字段的集合待补清单为空()
    {
        Assert.True(DataSyncScope.TryResolve("defect_reports", out var defects));
        var documents = new List<BsonDocument> { new() { { "_id", "d1" }, { "Title", "" } } };
        // Title 是空的，但它不在 RedactFields 里，不该被当成「等着补密钥」。
        Assert.Empty(DataSyncApply.DetectPendingSecretFields(documents, defects));
    }

    [Fact]
    public void 脱敏与待补清单首尾相接()
    {
        // 出口清空 -> 入口识别，两端必须对得上。任何一端改成「删字段」这条就会红。
        Assert.True(DataSyncScope.TryResolve("channel_settings", out var channel));
        var doc = new BsonDocument
        {
            { "_id", "c1" }, { "ImapPassword", "pw" }, { "SmtpPassword", "pw2" }, { "Host", "imap.example.com" },
        };

        var cleared = DataSyncRedactor.Redact(doc, channel);
        var pending = DataSyncApply.DetectPendingSecretFields(new List<BsonDocument> { doc }, channel);

        Assert.Equal(cleared.OrderBy(x => x, StringComparer.Ordinal), pending);
        Assert.Equal("imap.example.com", doc["Host"].AsString);
    }

    /// <summary>
    /// 同一个逻辑 id 在库里有两种物理形态：历史数据 ObjectId、新数据 24 位十六进制字符串
    /// （StringOrObjectIdSerializer 让应用层看到的都是同一个字符串）。按 BsonValue 原样比
    /// 会把它们当两条不同记录——源站送字符串、目标库存 ObjectId 时判成「本地没有」，
    /// 插进去就是同一条记录的第二份；覆盖模式也替不掉原来那条。
    /// </summary>
    [Fact]
    public void 目标库里的ObjectId与源站送来的同值字符串是同一条()
    {
        var hex = "507f1f77bcf86cd799439011";
        var incoming = new List<BsonDocument> { new() { { "_id", hex }, { "Title", "源站版本" } } };
        var existing = Existing(MongoDB.Bson.ObjectId.Parse(hex));

        var skip = DataSyncApply.Decide(incoming, existing, overwrite: false);
        Assert.Empty(skip.ToInsert);       // 不许再插一条
        Assert.Single(skip.SkippedIds);

        var overwrite = DataSyncApply.Decide(
            new List<BsonDocument> { new() { { "_id", hex }, { "Title", "源站版本" } } },
            existing, overwrite: true);
        Assert.Single(overwrite.ToReplace);
        // 覆盖写必须带**目标库里那个真实的 _id**，否则 replace 定位不到、
        // 而且 Mongo 也不允许在 replace 里改 _id。
        Assert.Equal(BsonType.ObjectId, overwrite.ToReplace[0]["_id"].BsonType);
        Assert.Equal(hex, overwrite.ToReplace[0]["_id"].AsObjectId.ToString());
    }

    /// <summary>
    /// 只有撞 `_id` 才算「这条已经有了，跳过」。撞业务唯一索引意味着目标站已有同一个
    /// 业务实体、但 _id 与源站不同——跳过它之后，后面引用它的记录照样带着源站 id 导进去，
    /// 留下指向不存在对象的引用，而整条同步还报成功。
    ///
    /// 认不出来的一律当作不可跳过：错误文案哪天变了，后果应该是响亮地失败，
    /// 不是悄悄恢复成损坏数据。
    /// </summary>
    [Theory]
    [InlineData("E11000 duplicate key error collection: prdagent.users index: _id_ dup key: { _id: \"a\" }", true)]
    [InlineData("E11000 duplicate key error collection: prdagent.defect_projects index: Key_1 dup key: { Key: \"P1\" }", false)]
    [InlineData("E11000 duplicate key error collection: prdagent.users index: Username_1 dup key: { Username: \"bob\" }", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void 只有撞Id才算可跳过的重复(string? message, bool expected)
    {
        Assert.Equal(expected, DataSyncApply.IsSkippableIdDuplicate(message));
    }
}
