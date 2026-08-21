using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.DataSync;
using PrdAgent.Core.DataSync;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 跨实例同步的协议判据。
///
/// 这里每一条挡的都是一种「授权本身被绕过」的走法，不是功能是否好用的问题：
/// 回跳地址放宽一点就是把数据送到别人手上，PKCE 松一点就是授权码被截获即可用。
/// </summary>
public class DataSyncProtocolTests
{
    private static readonly IReadOnlyList<string> Allowed =
        DataSyncProviderController.ParseOrigins("https://map.example.com, *.preview.example.com");

    [Theory]
    [InlineData("https://map.example.com/data-sync/callback")]
    [InlineData("https://map.example.com/data-sync/callback/")]
    [InlineData("https://feature-x.preview.example.com/data-sync/callback")]
    public void 白名单内的合法回跳地址通过(string uri)
    {
        DataSyncProviderController.TryValidateRedirect(uri, Allowed, out var callback).ShouldBeTrue();
        callback.ShouldEndWith("/data-sync/callback");
    }

    [Theory]
    // 域名不在白名单：最直接的钓鱼形态
    [InlineData("https://evil.example.com/data-sync/callback")]
    // 通配只认子域，裸后缀不算（否则 preview.example.com.evil.com 之类会溜过去）
    [InlineData("https://preview.example.com/data-sync/callback")]
    [InlineData("https://evilpreview.example.com/data-sync/callback")]
    // 路径必须精确：白名单域名下若有开放重定向页，换个路径就能把码转走
    [InlineData("https://map.example.com/redirect?to=evil")]
    [InlineData("https://map.example.com/data-sync/callback/extra")]
    [InlineData("https://map.example.com/")]
    // 带 query / fragment 的地址会让拼接出来的 #code=... 落到意料之外的位置
    [InlineData("https://map.example.com/data-sync/callback?next=x")]
    [InlineData("https://map.example.com/data-sync/callback#x")]
    // 非 https（非本机）：授权码会明文过网络
    [InlineData("http://map.example.com/data-sync/callback")]
    [InlineData("ftp://map.example.com/data-sync/callback")]
    [InlineData("javascript:alert(1)")]
    [InlineData("")]
    [InlineData(null)]
    public void 不合法的回跳地址一律拒绝(string? uri)
    {
        DataSyncProviderController.TryValidateRedirect(uri, Allowed, out _).ShouldBeFalse();
    }

    [Theory]
    // 当场准入放宽的**只有**「这个 origin 在不在名单里」。下面这些属于回跳地址的形状，
    // 管理员在同意页上勾多少次都不该放行——尤其是路径，白名单域名下有个开放重定向页
    // 就足以把授权码转走，而那正是「勾一下就信任」最容易被利用的地方。
    [InlineData("https://map.example.com/redirect?to=evil")]
    [InlineData("https://map.example.com/data-sync/callback/extra")]
    [InlineData("https://map.example.com/data-sync/callback?next=x")]
    [InlineData("https://map.example.com/data-sync/callback#x")]
    [InlineData("http://map.example.com/data-sync/callback")]
    [InlineData("javascript:alert(1)")]
    [InlineData("")]
    [InlineData(null)]
    public void 回跳地址的形状不可当场放宽(string? uri)
    {
        DataSyncProviderController.TryValidateRedirectShape(uri, out _, out _).ShouldBeFalse();
    }

    [Fact]
    public void 形状合法但不在名单里时只差名单这一项()
    {
        // 这一条钉住「当场准入」的作用边界：形状过了、只是名单里没有，
        // 所以管理员勾一下就能放行；反过来形状不过，勾了也没用（上一条）。
        const string uri = "https://newsite.example.com/data-sync/callback";
        DataSyncProviderController.TryValidateRedirectShape(uri, out var callback, out var origin).ShouldBeTrue();
        origin.ShouldBe("https://newsite.example.com");
        callback.ShouldBe("https://newsite.example.com/data-sync/callback");
        DataSyncProviderController.IsOriginAllowed(origin, Allowed).ShouldBeFalse();
        // 加进名单之后同一个地址就通过——「当场准入」在服务端就是这一步。
        DataSyncProviderController.IsOriginAllowed(
            origin,
            DataSyncProviderController.ParseOrigins("https://newsite.example.com")).ShouldBeTrue();
    }

    [Fact]
    public void 分页解析要带回源站算好的已清空字段()
    {
        // 待补清单必须来自源站的判定，不能由目标站看「哪个字段是空的」自己推。
        // 源站分得清「我清空了」和「它本来就是空的」，目标站分不清——自己推会把
        // 源站从来没配过的密钥也列成待补，让管理员照着一份包含空气的清单去编值。
        const string json = """
        {
          "success": true,
          "data": {
            "collection": "llmplatforms",
            "nextCursor": null,
            "clearedFields": ["ApiKeyEncrypted"],
            "documents": ["{\"_id\": \"p1\"}"]
          }
        }
        """;
        var page = DataSyncRunWorker.ReadPage(json);
        page.ClearedFields.ShouldBe(new[] { "ApiKeyEncrypted" });
        page.Documents.Count.ShouldBe(1);
    }

    [Fact]
    public void 源站没报已清空字段时待补清单为空()
    {
        const string json = """
        {"success": true, "data": {"collection": "defect_reports", "documents": ["{\"_id\": \"d1\"}"]}}
        """;
        DataSyncRunWorker.ReadPage(json).ClearedFields.ShouldBeEmpty();
    }

    [Fact]
    public void 待补字段清单形状不对必须失败()
    {
        // 这一格 fail open 的后果不是少一行提示：文档照样入库、Run 照样成功，
        // 而管理员不知道哪些凭据要补，相关集成静默不可用。
        const string notArray = """
        {"success": true, "data": {"collection": "llmplatforms", "documents": [], "clearedFields": "ApiKeyEncrypted"}}
        """;
        Should.Throw<InvalidOperationException>(() => DataSyncRunWorker.ReadPage(notArray));

        const string badElement = """
        {"success": true, "data": {"collection": "llmplatforms", "documents": [], "clearedFields": [123]}}
        """;
        Should.Throw<InvalidOperationException>(() => DataSyncRunWorker.ReadPage(badElement));

        // 合法：字符串数组、空数组、null、键不存在（上面已有一条覆盖「键不存在」）。
        const string ok = """
        {"success": true, "data": {"collection": "llmplatforms", "documents": [], "clearedFields": ["ApiKeyEncrypted"]}}
        """;
        DataSyncRunWorker.ReadPage(ok).ClearedFields.ShouldBe(new[] { "ApiKeyEncrypted" });

        const string nullFields = """
        {"success": true, "data": {"collection": "llmplatforms", "documents": [], "clearedFields": null}}
        """;
        DataSyncRunWorker.ReadPage(nullFields).ClearedFields.ShouldBeEmpty();
    }

    [Fact]
    public void 游标类型不对必须失败而不是当成拉完了()
    {
        // nextCursor 被当成 null 的后果不是少一页：调用方据此判定这个集合拉完了，
        // 后面所有页一条不落地，而整条 Run 报成功。
        const string numberCursor = """
        {"success": true, "data": {"collection": "defect_reports", "documents": [], "nextCursor": 12345}}
        """;
        Should.Throw<InvalidOperationException>(() => DataSyncRunWorker.ReadPage(numberCursor));

        const string objectCursor = """
        {"success": true, "data": {"collection": "defect_reports", "documents": [], "nextCursor": {"id": "x"}}}
        """;
        Should.Throw<InvalidOperationException>(() => DataSyncRunWorker.ReadPage(objectCursor));

        // 合法的两种：字符串、以及 null / 压根没有这个键——后者才是「拉完了」。
        const string stringCursor = """
        {"success": true, "data": {"collection": "defect_reports", "documents": [], "nextCursor": "abc"}}
        """;
        DataSyncRunWorker.ReadPage(stringCursor).NextCursor.ShouldBe("abc");

        const string nullCursor = """
        {"success": true, "data": {"collection": "defect_reports", "documents": [], "nextCursor": null}}
        """;
        DataSyncRunWorker.ReadPage(nullCursor).NextCursor.ShouldBeNull();

        const string absentCursor = """
        {"success": true, "data": {"collection": "defect_reports", "documents": []}}
        """;
        DataSyncRunWorker.ReadPage(absentCursor).NextCursor.ShouldBeNull();
    }

    [Fact]
    public void 令牌过期的Run必须留下线索好让worker落终态()
    {
        // Worker 只认领 HeldRunIds 里的 Run，而过期条目在那里会被顺手清掉。
        // 于是「Start 成功了、下一次轮询前令牌刚好过期」这条 Run 既进不了认领列表、
        // 也走不到 ExecuteRunAsync 里那条「没令牌就判失败」的路，永远停在 running。
        // 所以过期时必须留一份 id，供 worker 把它落终态。
        var vault = new DataSyncTokenVault();
        vault.PutExportToken("run-expired", new string('t', 40), DateTime.UtcNow.AddSeconds(-1));
        vault.PutExportToken("run-alive", new string('t', 40), DateTime.UtcNow.AddHours(1));

        vault.HeldRunIds.ShouldBe(new[] { "run-alive" });

        var expired = vault.DrainExpiredRunIds();
        expired.ShouldBe(new[] { "run-expired" });

        // 取过即清，不该被反复判死。
        vault.DrainExpiredRunIds().ShouldBeEmpty();
    }

    [Fact]
    public void 正常收尾的Run不会被当成过期()
    {
        // Forget 是「进终态了，把票丢掉」，不是过期。它不该在过期名单里留下东西，
        // 否则 worker 会对一条已经成功的 Run 再判一次失败。
        var vault = new DataSyncTokenVault();
        vault.PutExportToken("run-done", new string('t', 40), DateTime.UtcNow.AddHours(1));
        vault.Forget("run-done");

        vault.HeldRunIds.ShouldBeEmpty();
        vault.DrainExpiredRunIds().ShouldBeEmpty();
    }

    [Fact]
    public void 白名单为空时任何地址都不通过()
    {
        // 「没配过白名单」必须等于「功能关不通」，不能等于「允许所有」。
        DataSyncProviderController.TryValidateRedirect(
            "https://map.example.com/data-sync/callback",
            DataSyncProviderController.ParseOrigins(""),
            out _).ShouldBeFalse();
    }

    [Fact]
    public void 把某台机器移出名单后它那张票立刻不再可用()
    {
        // 撤销入口写着「移除」，就必须当场生效。原来的票据校验只看全局开关——
        // 移除的若不是最后一条，开关仍是开着的，那台机器手上没过期的票照样能读数据，
        // 最长两小时（Codex 第八轮）。现在每次校验都拿**当前**名单重对一遍票上的回跳地址。
        const string grantRedirect = "https://gone.example.com/data-sync/callback";

        // 还在名单里：通过。
        DataSyncProviderController.TryValidateRedirect(
            grantRedirect,
            DataSyncProviderController.ParseOrigins("https://gone.example.com,https://stay.example.com"),
            out _).ShouldBeTrue();

        // 被移出去了，但名单没空、开关还开着：这张票必须失效。
        DataSyncProviderController.TryValidateRedirect(
            grantRedirect,
            DataSyncProviderController.ParseOrigins("https://stay.example.com"),
            out _).ShouldBeFalse();
    }

    [Fact]
    public void 本机回环允许http仅为本地联调()
    {
        DataSyncProviderController.TryValidateRedirect(
            "http://127.0.0.1:8000/data-sync/callback",
            DataSyncProviderController.ParseOrigins("http://127.0.0.1:8000"),
            out var callback).ShouldBeTrue();
        callback.ShouldBe("http://127.0.0.1:8000/data-sync/callback");
    }

    [Fact]
    public void PKCE挑战值等于verifier的SHA256_Base64Url()
    {
        // RFC 7636 的 S256 测试向量，防止哪天有人把 Base64Url 换成普通 Base64。
        DataSyncProviderController.Sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
            .ShouldBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    [Fact]
    public void 游标能承载非字符串的Id()
    {
        // _id 不一定是字符串：ObjectId、整型都可能出现。游标丢了类型，翻页就会
        // 从头再来或者直接跳过一段，而这两种都不会报错。
        var oid = new BsonObjectId(ObjectId.GenerateNewId());
        var cursor = DataSyncProviderController.SerializeCursor(oid);
        DataSyncProviderController.TryParseCursor(cursor, out var parsed).ShouldBeTrue();
        parsed.BsonType.ShouldBe(BsonType.ObjectId);
        parsed.ShouldBe(oid);

        var num = new BsonInt64(42);
        DataSyncProviderController.TryParseCursor(
            DataSyncProviderController.SerializeCursor(num), out var parsedNum).ShouldBeTrue();
        parsedNum.BsonType.ShouldBe(BsonType.Int64);
    }

    [Fact]
    public void 坏游标解析失败而不是悄悄从头开始()
    {
        DataSyncProviderController.TryParseCursor("not-json", out _).ShouldBeFalse();
        DataSyncProviderController.TryParseCursor("{\"other\":1}", out _).ShouldBeFalse();
    }

    [Theory]
    [InlineData("https://map.example.com", "https://map.example.com")]
    [InlineData("https://map.example.com/", "https://map.example.com")]
    [InlineData("  https://map.example.com  ", "https://map.example.com")]
    public void 源站地址归一化为站点根(string raw, string expected)
    {
        DataSyncConsumerController.TryNormalizeOrigin(raw, out var origin).ShouldBeTrue();
        origin.ShouldBe(expected);
    }

    [Theory]
    [InlineData("https://map.example.com/api/data-sync")] // 带路径：调用方在猜端点位置
    [InlineData("map.example.com")]                        // 缺协议
    [InlineData("http://map.example.com")]                 // http
    [InlineData("http://localhost:5001")]                  // 回环：出站被 SafeOutbound 挡，放过去只会连不上
    [InlineData("http://127.0.0.1:5001")]
    [InlineData("https://localhost:5001")]                 // https 也一样，挡的是地址不是协议
    [InlineData("")]
    [InlineData(null)]
    public void 非法源站地址被拒(string? raw)
    {
        DataSyncConsumerController.TryNormalizeOrigin(raw, out _).ShouldBeFalse();
    }

    /// <summary>
    /// 源站地址（出站，服务器自己去连）和回跳地址（浏览器去开）是两条不同的通道，
    /// 回环的可达性判据本来就不同：前者必然被 SafeOutbound 挡下，后者在本地联调时完全正常。
    /// 这条用例把「两处判据不一致是有意的」钉住，免得后来人看着像漂移顺手改齐。
    /// </summary>
    [Fact]
    public void 回环在出站源站地址上禁止但在浏览器回跳地址上允许()
    {
        DataSyncConsumerController.TryNormalizeOrigin("http://127.0.0.1:8000", out _).ShouldBeFalse();
        DataSyncProviderController.TryValidateRedirect(
            "http://127.0.0.1:8000/data-sync/callback",
            DataSyncProviderController.ParseOrigins("http://127.0.0.1:8000"),
            out _).ShouldBeTrue();
    }

    private static string ReadRepoText(params string[] segments)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var parts = new List<string> { dir!.FullName };
        parts.AddRange(segments);
        var path = Path.Combine(parts.ToArray());
        Assert.True(File.Exists(path), $"守卫要扫的文件不在预期位置：{path}");
        return File.ReadAllText(path);
    }

    /// <summary>「这一页里带着该字段的文档 id」——接回之前算出来的那份。</summary>
    private static Dictionary<string, HashSet<string>> Owners(string field, params string[] ids) =>
        new(StringComparer.Ordinal) { [field] = ids.ToHashSet(StringComparer.Ordinal) };

    /// <summary>
    /// 待补清单是给管理员照着补凭据用的，所以它不能包含「本站原值根本没被动过」的字段：
    /// 不覆盖模式下同 _id 的文档被跳过，本站那份凭据还好好的，报进去等于诱导他去改坏一个能用的配置。
    /// </summary>
    [Fact]
    public void 待补清单只记真的落地了的文档()
    {
        var run = new DataSyncRun();
        var written = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), new[] { written });
        run.PendingSecretFields["llmplatforms"].ShouldBe(new[] { "ApiKeyEncrypted" });
    }

    [Fact]
    public void 整页都被跳过时不产生待补项()
    {
        var run = new DataSyncRun();

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), Array.Empty<BsonDocument>());

        run.PendingSecretFields.ShouldNotContainKey("llmplatforms");
    }

    [Fact]
    public void 落地的文档里没有那个字段就不记它()
    {
        var run = new DataSyncRun();
        // 源站是按集合报脱敏字段的，这一页未必每条都带它。
        var written = new BsonDocument { ["_id"] = "a", ["Name"] = "x" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted"), new[] { written });

        run.PendingSecretFields.ShouldNotContainKey("llmplatforms");
    }

    [Fact]
    public void 待补清单不重复记同一个字段()
    {
        var run = new DataSyncRun();
        var written = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), new[] { written });
        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), new[] { written });

        run.PendingSecretFields["llmplatforms"].Count.ShouldBe(1);
    }

    /// <summary>
    /// 覆盖写时，目标站原本就有一份能用的凭据 —— 接回之后它还在，不该报「待补」。
    /// 报了的话，管理员照着去补，反而会把一个本来能用的配置改坏。
    /// </summary>
    [Fact]
    public void 覆盖写保住了目标站凭据就不报待补()
    {
        var run = new DataSyncRun();
        var replaced = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "target-key" };
        var localBefore = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "target-key" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), new[] { replaced });

        run.PendingSecretFields.ShouldNotContainKey("llmplatforms");
    }

    /// <summary>
    /// 反过来才是真的要补：目标站原本就没有这个字段，接回时把它整个删掉，
    /// 于是「文档里字段在不在」这个判据一声不吭 —— 而这恰恰是唯一需要提醒的那一种。
    /// </summary>
    [Fact]
    public void 目标站原本就没有凭据时必须报待补()
    {
        var run = new DataSyncRun();
        var replaced = new BsonDocument { ["_id"] = "a" };          // 接回把字段删掉了
        var localBefore = new BsonDocument { ["_id"] = "a" };        // 目标站原本也没有

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), new[] { replaced });

        run.PendingSecretFields["llmplatforms"].ShouldBe(new[] { "ApiKeyEncrypted" });
    }

    /// <summary>目标站那份是空串，等同于没有。</summary>
    [Fact]
    public void 目标站凭据为空串也算要补()
    {
        var run = new DataSyncRun();
        var replaced = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "" };
        var localBefore = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), new[] { replaced });

        run.PendingSecretFields["llmplatforms"].ShouldBe(new[] { "ApiKeyEncrypted" });
    }

    /// <summary>
    /// 允许名单只收光秃秃的站点根。带路径 / 查询 / 片段 / 用户名的写法存进去之后，
    /// 界面显示「已信任」，而换票时比的是回调地址的 origin——两边永远对不上，
    /// 于是每一次换票都被拒绝，管理员看着名单里明明有它。错误契约本来就写着
    /// 「站点根地址」，校验没照着这句话做（形状 1：判据比它承诺的范围窄）。
    /// </summary>
    [Fact]
    public void 允许名单只收站点根()
    {
        var body = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        var update = body[body.IndexOf("public async Task<IActionResult> UpdateProviderSettings", StringComparison.Ordinal)..];
        update = update[..update.IndexOf("\n    /// <summary>", StringComparison.Ordinal)];

        update.ShouldContain("uri.AbsolutePath");
        update.ShouldContain("uri.Query");
        update.ShouldContain("uri.Fragment");
        update.ShouldContain("uri.UserInfo");
    }

    /// <summary>
    /// 通配条目不许带端口。
    ///
    /// 匹配时比的是 uri.Host（不含端口），拿它去对「.example.com:8443」这样的后缀
    /// 永远对不上——名单里明明有它，每一次授权却都被拒。这是形状 1 的又一格：
    /// 校验放行的写法比匹配能表达的范围宽。
    /// </summary>
    [Fact]
    public void 通配来源不许带端口()
    {
        var body = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        var update = body[body.IndexOf("public async Task<IActionResult> UpdateProviderSettings", StringComparison.Ordinal)..];
        update = update[..update.IndexOf("\n    /// <summary>", StringComparison.Ordinal)];
        update.ShouldContain("子域通配不能带端口");

        // 反向确认匹配确实只看 Host——两边的口径必须是一致的那一个。
        var matcher = body[body.IndexOf("internal static bool IsOriginAllowed", StringComparison.Ordinal)..];
        matcher = matcher[..matcher.IndexOf("\n    }", StringComparison.Ordinal)];
        matcher.ShouldContain("uri.Host");
    }

    /// <summary>带端口的通配一旦存进去就永远匹配不上，所以判据必须在存之前拦住。</summary>
    [Theory]
    [InlineData("*.example.com:8443", false)]
    [InlineData("*.example.com", true)]
    public void 通配匹配只认主机名(string pattern, bool shouldMatch)
    {
        var allowed = DataSyncProviderController.IsOriginAllowed(
            "https://a.example.com:8443", new[] { pattern });
        allowed.ShouldBe(shouldMatch);
    }

    /// <summary>
    /// 租约丢了就不许再往目标库写。
    ///
    /// 心跳和终态带 StillRunning 只保护 Run 这一行自己的字段；真正改业务集合的
    /// Insert/Replace 一直没看过租约。本进程卡够 15 分钟被别的部署收尸后醒来，
    /// 照样继续改目标站的数据——界面上这条已经 failed，人可能已经重跑了一次，
    /// 于是两个写手同时改同一批集合。
    /// </summary>
    [Fact]
    public void 丢了执行权就停止写目标库()
    {
        var worker = ReadWorkerSource();

        // 心跳要能回答「还归我吗」，且用 MatchedCount——同一毫秒设同一个值时
        // ModifiedCount 是 0，那不代表租约没了（形状 6）。
        worker.ShouldContain("Task<bool> HeartbeatAsync");
        worker.ShouldContain("result.MatchedCount > 0");

        // 每批写**之前**先确认租约——断言位置，不只断言存在。
        // 页内那次心跳隔 30 秒才跳一回，一整页够短就可能一次都没检查过就写完了；
        // 只断言「这一段里出现过 RunLeaseLostException」两种实现都能过，等于没测。
        var writeBlock = worker[worker.IndexOf("if (!run.DryRun)", StringComparison.Ordinal)..];
        writeBlock = writeBlock[..writeBlock.IndexOf("progress.Inserted", StringComparison.Ordinal)];
        var firstCheck = writeBlock.IndexOf("throw new RunLeaseLostException", StringComparison.Ordinal);
        var firstInsert = writeBlock.IndexOf("InsertManyAsync", StringComparison.Ordinal);
        var firstReplace = writeBlock.IndexOf("ReplaceOneAsync", StringComparison.Ordinal);
        firstCheck.ShouldBeGreaterThan(-1);
        firstCheck.ShouldBeLessThan(firstInsert);
        firstCheck.ShouldBeLessThan(firstReplace);

        // 丢租约不去覆盖收尸方写好的结局。
        worker.ShouldContain("catch (RunLeaseLostException");
    }

    /// <summary>
    /// 比对令牌要同时盖住开关。只比名单的话，「另一个人把开关关了」对本次提交是隐形的，
    /// 而本次提交带着的是打开页面那一刻的旧开关值——一次纯粹的「移走一台机器」
    /// 会把整个对外导出重新打开。
    /// </summary>
    [Fact]
    public void 比对令牌必须盖住对外开关()
    {
        var body = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        body.ShouldContain("ExpectedEnabled");

        var update = body[body.IndexOf("public async Task<IActionResult> UpdateProviderSettings", StringComparison.Ordinal)..];
        update = update[..update.IndexOf("\n    /// <summary>", StringComparison.Ordinal)];
        update.ShouldContain("request.ExpectedEnabled is bool expectedEnabled");
        update.ShouldContain("x.DataSyncProviderEnabled, expectedEnabled");

        // 比对必须拿**库里原样那份**，不能拿生效值。管理员撤掉最后一条来源之后，
        // 生效值是 false 而库里存的还是 true——用生效值去比，每次保存都回「过期了」，
        // 刷新出来还是 false，再试还是过期。这正是第 25 轮修过一次的死锁（形状 5），
        // 第 27 轮给开关加比对时又照原样造了一遍。
        update.ShouldContain("currentConfig.StoredEnabled");
        update.ShouldNotContain("expectedEnabled == currentConfig.Enabled");

        // 而 GET 与 PUT 都得把这份原始值交出去，否则前端手上没有可送的东西
        // ——尤其 PUT：前端把响应合进本地状态，只回生效值的话下一次保存就带着旧值（形状 2）。
        body.ShouldContain("storedEnabled = config.StoredEnabled");
        body.ShouldContain("storedEnabled = request.Enabled");

        // 前端必须真的送上来，否则这道门形同虚设（形状 2：建了一半）。
        var page = ReadRepoText("prd-admin", "src", "pages", "data-sync", "DataSyncPage.tsx");
        page.ShouldContain("expectedEnabled: base.storedEnabled");
    }

    /// <summary>
    /// 存进去的名单必须先过读取时那一遍规范化。
    ///
    /// `*.EXAMPLE.com` 原样存库、读回来被转小写，比对令牌就永远比不上库里那份原文——
    /// 这张卡从第一次保存之后再也存不动。和第 29 轮那个开关死锁同族：
    /// 拿规范化后的值去比未规范化的原始字段。
    /// </summary>
    [Fact]
    public void 通配来源存库前先规范化()
    {
        // 判据本身：同一个字符串，规范化两次要等于规范化一次（幂等），
        // 且大小写不同的通配落到同一个值上。
        var once = DataSyncProviderController.ParseOrigins("*.EXAMPLE.com");
        var twice = DataSyncProviderController.ParseOrigins(string.Join(",", once));
        once.ShouldBe(new[] { "*.example.com" });
        twice.ShouldBe(once);

        // 接线：写入路径必须真的用它，而不是在那儿另写一遍小写（形状 3）。
        var body = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        var update = body[body.IndexOf("public async Task<IActionResult> UpdateProviderSettings", StringComparison.Ordinal)..];
        update = update[..update.IndexOf("\n    /// <summary>", StringComparison.Ordinal)];
        update.ShouldContain("var canonical = ParseOrigins(candidate)");
        update.ShouldNotContain("origins.Add(candidate)");
    }

    /// <summary>
    /// 排队等前一条的 Run 也要打心跳。串行执行下第一条跑满 15 分钟，第二条一次心跳
    /// 都没打过，别的部署据此把它判成无人认领并落成 failed——尽管本进程正握着它有效的
    /// 导出令牌。本进程自己的 mine 挡得住自己，挡不住兄弟部署。
    /// </summary>
    [Fact]
    public void 排队等待的同步不会被判成无人认领()
    {
        var worker = ReadWorkerSource();
        worker.ShouldContain("_queuedRunIds");
        worker.ShouldContain("BeatQueuedRunsAsync");

        // 关键是**执行期间**就在打，不是等前一条跑完再补——跑 30 分钟的话补也来不及了。
        // 所以它必须挂在心跳里，而心跳在页内循环和每批写之前都会走到。
        var heartbeat = worker[worker.IndexOf("private async Task<bool> HeartbeatAsync", StringComparison.Ordinal)..];
        heartbeat = heartbeat[..heartbeat.IndexOf("\n    }", StringComparison.Ordinal)];
        heartbeat.ShouldContain("BeatQueuedRunsAsync");
    }

    /// <summary>
    /// 分页要能跨 BSON 类型段往前走。
    ///
    /// Mongo 的比较**运算符**只在同一类型段内比较，而排序是跨类型的全序。本仓库有历史
    /// 数据是 ObjectId、新数据是字符串（StringOrObjectIdSerializer），一个集合里混着放。
    /// 只用 $gt 的话，游标停在某个字符串上之后再也匹配不到后面的 ObjectId——下一页空了，
    /// worker 判这个集合拉完、**报成功，而 ObjectId 那批一条都没同步过去**。
    /// </summary>
    [Fact]
    public void 游标要能跨过BSON类型段()
    {
        var rendered = DataSyncProviderController
            .BuildAfterCursorFilter(BsonValue.Create("abc"))
            .Render(
                BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(),
                BsonSerializer.SerializerRegistry);
        var json = rendered.ToJson();

        // 同段内推进仍在。
        json.ShouldContain("$gt");
        // 而且要能跳到排在字符串之后的类型上去（objectId 是本仓库真实存在的那一种）。
        json.ShouldContain("$type");
        json.ShouldContain("objectId");
        // 排在字符串**之前**的类型不该被算成「在后面」。
        json.ShouldNotContain("minKey");
    }

    /// <summary>
    /// 数值那几种属于**同一个排序段**：Mongo 里 double / int / long / decimal 互相
    /// 按数值大小比，不按类型分先后。
    ///
    /// 上一版我把它们拆成四段，造出一个比原 bug 更糟的循环：200 条 Int64 的 0..199
    /// 和 200 条 Int32 的 200..399，游标停在 Int32 的 399 时「类型排在 int 之后」
    /// 这一支会把所有 long 捞回来（又是 0..199），下一页游标变回 Int64 的 199、
    /// 同段 $gt 再给出 200..399——两页来回翻到令牌过期，期间重复写入、进度虚高。
    ///
    /// 所以这条断言的是：数值游标的 $type 分支里，**不许出现任何别的数值类型**。
    /// </summary>
    [Theory]
    [InlineData("int")]
    [InlineData("long")]
    [InlineData("double")]
    public void 数值游标不许把同段的其它数值类型算成在后面(string kind)
    {
        BsonValue cursor = kind switch
        {
            "int" => BsonValue.Create(399),
            "long" => BsonValue.Create(399L),
            _ => BsonValue.Create(399.0),
        };

        var json = DataSyncProviderController
            .BuildAfterCursorFilter(cursor)
            .Render(
                BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(),
                BsonSerializer.SerializerRegistry)
            .ToJson();

        foreach (var numeric in new[] { "\"int\"", "\"long\"", "\"double\"", "\"decimal\"" })
        {
            json.ShouldNotContain(numeric);
        }
        // 但排在数值段之后的类型仍然要能跨过去。
        json.ShouldContain("string");
        json.ShouldContain("objectId");
    }

    /// <summary>游标已经是最后一种类型时，退回同段内推进，别造一个空的 $type 数组。</summary>
    [Fact]
    public void 游标是最末类型时不产生空类型集()
    {
        var rendered = DataSyncProviderController
            .BuildAfterCursorFilter(BsonMaxKey.Value)
            .Render(
                BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(),
                BsonSerializer.SerializerRegistry);
        rendered.ToJson().ShouldNotContain("$type");
    }

    /// <summary>
    /// 队列心跳不能只挂在 HeartbeatAsync 上——它的调用点全在 `if (!run.DryRun)` 里，
    /// 于是第一条要是试跑且跑过 15 分钟，排在后面那几条一次都没被刷到，
    /// 照样被别的部署当无人认领收走。每页收尾处必须无条件打一次。
    /// </summary>
    [Fact]
    public void 试跑期间排队的同步也要保活()
    {
        var worker = ReadWorkerSource();
        var tail = worker[worker.IndexOf("progress.Done = string.IsNullOrEmpty(page.NextCursor);", StringComparison.Ordinal)..];
        tail = tail[..tail.IndexOf("if (progress.Done) return;", StringComparison.Ordinal)];
        tail.ShouldContain("BeatQueuedRunsAsync");

        // 这一段必须在 !run.DryRun 之外——在里面就等于只保真跑那条路径。
        var dryRunBranch = worker[worker.IndexOf("if (!run.DryRun)", StringComparison.Ordinal)..];
        dryRunBranch = dryRunBranch[..dryRunBranch.IndexOf("progress.PlannedInsert", StringComparison.Ordinal)];
        dryRunBranch.ShouldNotContain("await BeatQueuedRunsAsync(db, ct);\n            ");
    }

    /// <summary>
    /// 查已有文档时，同一个逻辑 id 的两种物理形态都要带上。
    ///
    /// 只拿源站送来的字符串去 $in，目标库里那条 ObjectId 记录匹配不上——判成
    /// 「本地没有」就插了同一条记录的第二份，覆盖模式也替不掉原来那条。
    /// 这和第 31/32 轮的分页是同一族（混合 _id），只是我上两轮只改了分页那一处，
    /// 没把「_id 还在哪些地方被当成可直接比较的值」列一遍。
    /// </summary>
    [Fact]
    public void 查已有文档要带上两种id形态()
    {
        var worker = ReadWorkerSource();
        var lookup = worker[worker.IndexOf("var ids = new List<BsonValue>();", StringComparison.Ordinal)..];
        lookup = lookup[..lookup.IndexOf("var existing = await target", StringComparison.Ordinal)];
        lookup.ShouldContain("ObjectId.TryParse");

        // 归一比较 + 用目标库真实 _id 覆盖写，两件都要接上。
        worker.ShouldContain("DataSyncApply.NormalizeId(doc[\"_id\"])");
        worker.ShouldContain("existingIdsByKey");
    }

    /// <summary>
    /// 成功路径交还令牌必须用 CancellationToken.None。用 ct 的话：宿主关停时 ct 已取消，
    /// 这一句立刻失败并把取消咽掉，下一行又把本地唯一那份令牌忘了——界面显示「成功」，
    /// 而源站那张票在剩下的两小时里仍然能导数据。失败与丢租约两条路径本来就用的 None。
    /// </summary>
    [Fact]
    public void 成功收尾交还令牌不跟着请求一起取消()
    {
        var worker = ReadWorkerSource();
        worker.ShouldNotContain("await ReturnExportTokenAsync(run, token, ct);");
        // 三条终态路径都用 None。
        var occurrences = worker.Split("ReturnExportTokenAsync(run, token, CancellationToken.None)").Length - 1;
        occurrences.ShouldBeGreaterThanOrEqualTo(3);
    }

    /// <summary>
    /// 覆盖写时 Decide 会把文档的 _id 改写成目标库里那个真实形态（字符串 -> ObjectId），
    /// 所以待补清单的归属必须按**归一后**的 id 记，否则改写之后就对不上——
    /// 一个真被清空的凭据不会出现在清单里。
    /// </summary>
    [Fact]
    public void 待补归属跟着id归一走()
    {
        var hex = "507f1f77bcf86cd799439011";
        var run = new DataSyncRun();
        // 源站送的是字符串，落库时被改写成 ObjectId。
        var written = new BsonDocument
        {
            ["_id"] = MongoDB.Bson.ObjectId.Parse(hex),
            ["ApiKeyEncrypted"] = BsonNull.Value,
        };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmconfigs", Owners("ApiKeyEncrypted", hex), new[] { written });

        run.PendingSecretFields["llmconfigs"].ShouldBe(new[] { "ApiKeyEncrypted" });
    }

    /// <summary>
    /// 两个方向都要展开。上一轮只写了「字符串 -> ObjectId」，反过来那半
    /// （源站是 ObjectId、目标库存成字符串）照样匹配不上，后果一模一样：
    /// 重复插入 / 覆盖替不掉。修一个方向等于没修。
    /// </summary>
    [Fact]
    public void 两种id形态要对称展开()
    {
        var worker = ReadWorkerSource();
        var lookup = worker[worker.IndexOf("var ids = new List<BsonValue>();", StringComparison.Ordinal)..];
        lookup = lookup[..lookup.IndexOf("var existing = await target", StringComparison.Ordinal)];

        lookup.ShouldContain("ObjectId.TryParse");                 // 字符串 -> ObjectId
        lookup.ShouldContain("id.AsObjectId.ToString()");          // ObjectId -> 字符串
    }

    /// <summary>
    /// 票过期时 pending 也要收敛到终态。callback 建出 Run 之后管理员一直没点开始，
    /// 票就这么过期了——过期标记被 drain 掉，而收敛只认 running 的话，库里那行永远停在
    /// pending：再打开它，Plan 每次都报「令牌已失效」，页面卡在加载态；进程重启也一样。
    /// </summary>
    [Fact]
    public void 票过期时pending也要落终态()
    {
        var worker = ReadWorkerSource();
        var block = worker[worker.IndexOf("if (expired.Count > 0)", StringComparison.Ordinal)..];
        block = block[..block.IndexOf("if (held.Count == 0) return;", StringComparison.Ordinal)];

        block.ShouldContain("\"running\", \"pending\"");
        block.ShouldNotContain("Filter.Eq(x => x.Status, \"running\")");
    }

    /// <summary>
    /// 「同意了却没回来换票」那一类的清理谓词是「ExportTokenExpiresAt 等值 null +
    /// ExpiresAt 范围」，两条散列打头的索引都支撑不了它，于是每个部署的每一轮清理
    /// 都要扫遍所有留存的未换票授权。
    /// </summary>
    [Fact]
    public void 未换票授权的清理要有索引()
    {
        var script = ReadRepoText("scripts", "mongodb-indexes.js");
        var begin = script.IndexOf("// collection: data_sync_grants", StringComparison.Ordinal);
        var end = script.IndexOf("// end collection: data_sync_grants", StringComparison.Ordinal);
        var section = script[begin..end];
        section.ShouldContain("\"ExportTokenExpiresAt\": 1, \"ExpiresAt\": 1");
    }

    /// <summary>
    /// 源站管理员在同意页上勾了「连登录凭据一起搬」时，users.PasswordHash 不在这次的
    /// 脱敏范围里，源站送来的是真散列。这时候拿目标站的旧散列盖回去，等于把授权页刚刚
    /// 承诺过的事悄悄取消——那批用户的原密码登不进去，而界面上说的是能登。
    /// </summary>
    [Fact]
    public void 带凭据同步时不许把源站散列盖回目标站旧值()
    {
        var collection = new DataSyncCollection("users", new[] { "PasswordHash" });
        var incoming = new BsonDocument { ["_id"] = "u1", ["PasswordHash"] = "from-source" };
        var localExisting = new BsonDocument { ["_id"] = "u1", ["PasswordHash"] = "target-old" };

        // 这一页源站没有清空 PasswordHash（凭据搬运已获批准）。
        DataSyncApply.CarryTargetLocalFields(
            new[] { incoming }, new[] { localExisting }, collection);

        incoming["PasswordHash"].AsString.ShouldBe("from-source");
    }

    /// <summary>
    /// 反过来：没批准搬凭据时源站确实清空了，这时必须接回目标站原值，
    /// 否则覆盖写会把目标站本来能用的散列顶成空，那批用户谁都登不进去。
    /// </summary>
    [Fact]
    public void 未批准搬凭据时必须接回目标站原散列()
    {
        var collection = new DataSyncCollection("users", new[] { "PasswordHash" });
        var incoming = new BsonDocument { ["_id"] = "u1", ["PasswordHash"] = BsonNull.Value };
        var localExisting = new BsonDocument { ["_id"] = "u1", ["PasswordHash"] = "target-old" };

        DataSyncApply.CarryTargetLocalFields(
            new[] { incoming }, new[] { localExisting }, collection);

        incoming["PasswordHash"].AsString.ShouldBe("target-old");
    }

    /// <summary>
    /// 源站那份本来就是空的时候，脱敏器没有东西可清、也就不会把它记进 clearedFields。
    /// 判据要是挂在「源站报没报清空」上，这一格就漏了：目标站一份能用的凭据被这个空值
    /// 顶掉，而且因为没进 clearedFields，待补清单连提醒都不会给。所以判据看的是
    /// **送来的值本身**，不是源站的自报。
    /// </summary>
    [Fact]
    public void 源站本来就没配的凭据也不许顶掉目标站那份()
    {
        var collection = new DataSyncCollection("llmconfigs", new[] { "ApiKeyEncrypted" });
        // 源站这条记录的密钥本来就是空的，脱敏器没清过它，clearedFields 里没有它。
        var incoming = new BsonDocument { ["_id"] = "c1", ["ApiKeyEncrypted"] = BsonNull.Value };
        var localExisting = new BsonDocument { ["_id"] = "c1", ["ApiKeyEncrypted"] = "target-working-key" };

        DataSyncApply.CarryTargetLocalFields(new[] { incoming }, new[] { localExisting }, collection);

        incoming["ApiKeyEncrypted"].AsString.ShouldBe("target-working-key");
    }

    /// <summary>空串和 null 一样算「送来的是空的」。</summary>
    [Fact]
    public void 送来空串同样不许顶掉目标站凭据()
    {
        var collection = new DataSyncCollection("llmconfigs", new[] { "ApiKeyEncrypted" });
        var incoming = new BsonDocument { ["_id"] = "c1", ["ApiKeyEncrypted"] = "" };
        var localExisting = new BsonDocument { ["_id"] = "c1", ["ApiKeyEncrypted"] = "target-working-key" };

        DataSyncApply.CarryTargetLocalFields(new[] { incoming }, new[] { localExisting }, collection);

        incoming["ApiKeyEncrypted"].AsString.ShouldBe("target-working-key");
    }

    /// <summary>
    /// 成功终态也要带「它还是 running」。心跳和进度都挡住了，唯独这一处漏了，
    /// 而它是危害最大的那个方向：本进程暂停够久被别的部署收了尸，醒来后这一句会把
    /// 已经落好的 failed 改写成 succeeded——一次半截的同步在界面上显示成「成功」。
    /// </summary>
    [Fact]
    public void 成功终态不许覆盖别人写好的结局()
    {
        var worker = ReadWorkerSource();
        var block = worker[worker.IndexOf("\"succeeded\"", StringComparison.Ordinal)..];
        var head = worker[..worker.IndexOf("\"succeeded\"", StringComparison.Ordinal)];
        // 这句 UpdateOneAsync 的过滤器必须是 StillRunning，不是裸 Id。
        head.Substring(head.LastIndexOf("UpdateOneAsync", StringComparison.Ordinal))
            .ShouldContain("StillRunning(run)");
        // 而且要处理「一条都没匹配上」。
        block.ShouldContain("ModifiedCount == 0");
    }

    /// <summary>
    /// 同意了却再也没回来换票的授权，ExportTokenExpiresAt 一直是 null，
    /// 跟任何时间比较都不成立——只按导出令牌收，这一整类永远留在表里。
    /// </summary>
    [Fact]
    public void 没换过票的授权也要被清掉()
    {
        var worker = ReadWorkerSource();
        var sweep = worker[worker.IndexOf("SweepRetiredGrantsAsync(MongoDbContext", StringComparison.Ordinal)..];
        sweep = sweep[..sweep.IndexOf("\n    }", StringComparison.Ordinal)];
        sweep.ShouldContain("ExpiresAt");
        sweep.ShouldContain("Filter.Or");
    }

    /// <summary>
    /// 作废不能走鉴权那条路。管理员在同步收尾的当口关了开关或把对方移出名单时，
    /// ResolveExportGrantAsync 会先被那两道门挡掉、查不到票，于是回「已失效」而
    /// ExportRevokedAt 从没写上；开关两小时内一开，那张本该一次性的票又能用了。
    /// </summary>
    [Fact]
    public void 作废不受当前对外策略影响()
    {
        var body = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        var revoke = body[body.IndexOf("public async Task<IActionResult> Revoke(", StringComparison.Ordinal)..];
        revoke = revoke[..revoke.IndexOf("\n    /// <summary>", StringComparison.Ordinal)];

        // 断言的是「有没有调它」，不是「有没有提到它」——正文注释里正好写了这个名字。
        revoke.ShouldNotContain("await ResolveExportGrantAsync(");
        revoke.ShouldContain("ReadExportToken()");
        revoke.ShouldContain("ExportTokenHash");
    }

    /// <summary>
    /// 不带凭据同步时，源站给每个导出用户打「必须重设密码」——那是对**散列被清空**
    /// 这件事的说明。可覆盖写这一侧已经把目标站原有的可用散列接回来了，标志却还留着
    /// 源站那份 true，于是一批密码明明还能用的人下次登录被推进首登重设流程。
    /// 两个字段是同一件事的两面，必须同进同出。
    /// </summary>
    [Fact]
    public void 接回目标站散列时必须连重设标志一起接回()
    {
        var collection = new DataSyncCollection("users", new[] { "PasswordHash" });
        var incoming = new BsonDocument
        {
            ["_id"] = "u1",
            ["PasswordHash"] = BsonNull.Value,
            ["MustResetPassword"] = true,
        };
        var localExisting = new BsonDocument
        {
            ["_id"] = "u1",
            ["PasswordHash"] = "target-working",
            ["MustResetPassword"] = false,
        };

        DataSyncApply.CarryTargetLocalFields(new[] { incoming }, new[] { localExisting }, collection);

        incoming["PasswordHash"].AsString.ShouldBe("target-working");
        incoming["MustResetPassword"].AsBoolean.ShouldBeFalse();
    }

    /// <summary>
    /// 反过来：散列没被接回（源站带凭据搬过来了），重设标志也不该被目标站的旧值改写。
    /// </summary>
    [Fact]
    public void 源站散列落地时重设标志跟着源站()
    {
        var collection = new DataSyncCollection("users", new[] { "PasswordHash" });
        var incoming = new BsonDocument
        {
            ["_id"] = "u1",
            ["PasswordHash"] = "from-source",
            ["MustResetPassword"] = false,
        };
        var localExisting = new BsonDocument
        {
            ["_id"] = "u1",
            ["PasswordHash"] = "target-old",
            ["MustResetPassword"] = true,
        };

        DataSyncApply.CarryTargetLocalFields(new[] { incoming }, new[] { localExisting }, collection);

        incoming["PasswordHash"].AsString.ShouldBe("from-source");
        incoming["MustResetPassword"].AsBoolean.ShouldBeFalse();
    }

    /// <summary>
    /// 投影必须把陪嫁字段也查回来。少投影一个，接回时会把目标站那份当成「不存在」
    /// 而删掉——形状 3 的老问题换个位置再来一次。
    /// </summary>
    [Fact]
    public void 陪嫁字段也在投影超集里()
    {
        var collection = new DataSyncCollection("users", new[] { "PasswordHash" });
        collection.FieldsCarriedFromTarget.ShouldContain("MustResetPassword");
    }

    /// <summary>
    /// 整份覆盖写必须带条件更新。串行化只挡住本页两次连点，挡不住两个管理员同时改：
    /// 后到的那次会把先移走的机器放回来，而票据鉴权每次都读这份活名单。
    /// </summary>
    [Fact]
    public void 名单整份覆盖写必须做条件更新()
    {
        var body = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        var update = body[body.IndexOf("public async Task<IActionResult> UpdateProviderSettings", StringComparison.Ordinal)..];
        update = update[..update.IndexOf("\n    /// <summary>", StringComparison.Ordinal)];

        update.ShouldContain("ExpectedOrigins");
        update.ShouldContain("MatchedCount == 0");
        update.ShouldContain("DATA_SYNC_SETTINGS_STALE");
        // 全新部署根本没有 global 这一行：只认「匹配到才写」的话，条件更新匹配不到
        // 任何东西，每次保存都回「过期了」，刷新出来还是同一份兜底值，再试还是过期
        // ——这张卡永远建不出它的第一份设置。所以「我看到的就是那份兜底值」时允许
        // upsert，并把 upsert 撞唯一索引（有人抢先建了）也归到 stale。
        update.ShouldContain("expectedMatchesFallback");
        update.ShouldContain("IsUpsert = request.ExpectedOrigins is null || expectedMatchesFallback");
        update.ShouldContain("ServerErrorCategory.DuplicateKey");
    }

    /// <summary>
    /// 待补清单问的是「脱敏**有没有真的拿走**什么」，那正是 clearedFields 的定义。
    /// 源站从来没配过的空字段不算被拿走——报进清单等于告诉管理员「有个密钥被同步
    /// 清掉了，去补」，而根本没有那回事。
    /// （接回那条路径判据不同：它问「送来的值是不是空的」，不能依赖源站上报。）
    /// </summary>
    [Fact]
    public void 待补清单只认源站真的清空过的字段()
    {
        var worker = ReadWorkerSource();
        var owners = worker[worker.IndexOf("var sourceFieldOwners", StringComparison.Ordinal)..];
        owners = owners[..owners.IndexOf("DataSyncApply.CarryTargetLocalFields", StringComparison.Ordinal)];
        owners.ShouldContain("cleared.Contains");
    }

    /// <summary>
    /// 目标站策略不看源站脸色：PreserveFields 里的字段无论源站报没报清空、
    /// 甚至源站硬送一个值，都以目标站那份为准。口令登录开关是 fail-open，
    /// 顶掉即「放开」，这类事不能取决于源站说了什么。
    /// </summary>
    [Fact]
    public void 目标站策略开关不受源站声明影响()
    {
        var collection = new DataSyncCollection("appsettings", new[] { "PasswordLoginDisabled" })
        {
            PreserveFields = new[] { "PasswordLoginDisabled" },
        };
        var incoming = new BsonDocument { ["_id"] = "global", ["PasswordLoginDisabled"] = false };
        var localExisting = new BsonDocument { ["_id"] = "global", ["PasswordLoginDisabled"] = true };

        // 源站声称「我没清空这个字段」，并且硬送了 false。
        DataSyncApply.CarryTargetLocalFields(
            new[] { incoming }, new[] { localExisting }, collection);

        incoming["PasswordLoginDisabled"].AsBoolean.ShouldBeTrue();
    }

    /// <summary>
    /// 接线守卫（形状 2）：上面四条只证明 RecordPendingSecrets 本身对。
    /// 真正会复发的改法是在 worker 里把它挪回写库之前、或者又传回整页文档——
    /// 那两种改法删掉之后上面四条仍然全绿。
    /// </summary>
    [Fact]
    public void 待补清单在写库判定之后才记录()
    {
        var source = ReadWorkerSource();
        source.ShouldContain("RecordPendingSecrets(run, collection.Name, sourceFieldOwners,");
        // 传的必须是「决定要写的那些」，不是这一页拉回来的全部。
        source.ShouldContain("decision.ToInsert.Concat(decision.ToReplace)");
        source.ShouldNotContain("RecordPendingSecrets(run, collection.Name, page.ClearedFields, documents)");
        // 判据不许挂在源站自报的 clearedFields 上：源站那份本来就是空的时候它不上报，
        // 于是最需要提醒的那一格反而没有提醒。
        source.ShouldNotContain("RecordPendingSecrets(run, collection.Name, page.ClearedFields");
        // 「这一页哪些文档带着该字段」必须在接回**之前**算——接回会改写甚至删掉它们。
        var ownersAt = source.IndexOf("var sourceFieldOwners", StringComparison.Ordinal);
        var carryAt = source.IndexOf("DataSyncApply.CarryTargetLocalFields", StringComparison.Ordinal);
        ownersAt.ShouldBeGreaterThan(0);
        carryAt.ShouldBeGreaterThan(ownersAt);
    }

    /// <summary>
    /// 接线守卫（形状 2）：没有这条，把 SweepOrphanedRunsAsync 的调用删掉之后全量测试仍然全绿，
    /// 而线上的表现是「进程被硬杀过的那条同步永远停在进行中」——一条没人会去看的静默退化。
    /// </summary>
    [Fact]
    public void 无人认领的running会被周期收尸()
    {
        var source = ReadWorkerSource();
        source.ShouldContain("await SweepOrphanedRunsAsync(db, ct);");
        // 判据必须是「没心跳」而不是别的：活着的 Run 每页都刷 UpdatedAt，
        // 用它才不会误杀共享库上兄弟部署正在跑的那条。
        source.ShouldContain("Builders<DataSyncRun>.Filter.Lt(x => x.UpdatedAt, deadline)");
        // 收尸要跳过本进程正握着的，那些有更准的失败原因可给。
        source.ShouldContain("if (mine.Contains(run.Id)) continue;");
    }

    private static string ReadApiSource(params string[] segments)
    {
        var parts = new List<string> { "src", "PrdAgent.Api" };
        parts.AddRange(segments);
        var path = Path.Combine(new[] { FindApiRoot() }.Concat(parts).ToArray());
        File.Exists(path).ShouldBeTrue($"守卫要扫的源码不在预期位置：{path}");
        return File.ReadAllText(path);
    }

    private static string FindApiRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src", "PrdAgent.Api")))
        {
            dir = dir.Parent;
        }
        dir.ShouldNotBeNull("找不到 prd-api 根目录，守卫无法读取源码");
        return dir!.FullName;
    }

    private static string ReadWorkerSource()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src", "PrdAgent.Api")))
        {
            dir = dir.Parent;
        }
        dir.ShouldNotBeNull("找不到 prd-api 根目录，守卫无法读取源码");
        var path = Path.Combine(dir!.FullName, "src", "PrdAgent.Api", "Services", "DataSync", "DataSyncRunWorker.cs");
        File.Exists(path).ShouldBeTrue($"守卫要扫的源码不在预期位置：{path}");
        return File.ReadAllText(path);
    }

    /// <summary>
    /// 一次性迁移标记记的是「这台机器跑过哪些迁移」，不是配置。覆盖同步是整份替换，
    /// 照搬源站那份会让目标站要么跳过它还没跑的迁移（权限缺失），要么重跑一个管理员
    /// 已经手工回退过的迁移（被撤销的权限自己长回来）。清空同样不行——空的等于
    /// 「什么都没跑过」，下次启动全部重来。所以出口删字段、写入时接回目标站原有那份。
    /// </summary>
    [Fact]
    public void 迁移执行历史属于目标站本地不随同步搬运()
    {
        var appsettings = DataSyncScope.Expand(new[] { "llm-config" })
            .Single(c => c.Name == "appsettings");

        appsettings.PreserveFields.ShouldContain("CompletedOneTimeMigrations");
        // 不能改用脱敏（清空）来处理：清成空的就是「什么都没跑过」，破坏力和照搬一样。
        appsettings.RedactFields.ShouldNotContain("CompletedOneTimeMigrations");
    }

    [Fact]
    public void 出口把本地执行历史整个删掉而不是清空()
    {
        var collection = new DataSyncCollection("appsettings", System.Array.Empty<string>())
        {
            PreserveFields = new[] { "CompletedOneTimeMigrations" },
        };
        var doc = new BsonDocument
        {
            ["_id"] = "global",
            ["CompletedOneTimeMigrations"] = new BsonArray { "perm-2026-01" },
        };

        DataSyncRedactor.StripTargetLocal(doc, collection).ShouldBe(new[] { "CompletedOneTimeMigrations" });
        // 留一个空值会被目标站认成「待补的凭据」，那是另一种错。
        doc.Contains("CompletedOneTimeMigrations").ShouldBeFalse();
    }

    [Fact]
    public void 覆盖写之前把目标站自己的执行历史接回来()
    {
        var collection = new DataSyncCollection("appsettings", System.Array.Empty<string>())
        {
            PreserveFields = new[] { "CompletedOneTimeMigrations" },
        };
        // 源站送来的（出口已删该字段），以及本站库里现有的那份。
        var incoming = new BsonDocument { ["_id"] = "global", ["SomeConfig"] = "from-source" };
        var localExisting = new BsonDocument
        {
            ["_id"] = "global",
            ["CompletedOneTimeMigrations"] = new BsonArray { "perm-target-only" },
        };

        DataSyncApply.CarryTargetLocalFields(new[] { incoming }, new[] { localExisting }, collection);

        incoming["CompletedOneTimeMigrations"].AsBsonArray
            .Select(x => x.AsString).ShouldBe(new[] { "perm-target-only" });
        incoming["SomeConfig"].AsString.ShouldBe("from-source");
    }

    [Fact]
    public void 源站硬要送执行历史也以目标站那份为准()
    {
        // 判据不能依赖源站有没有做对：旧版本源站可能还在送这个字段。
        var collection = new DataSyncCollection("appsettings", System.Array.Empty<string>())
        {
            PreserveFields = new[] { "CompletedOneTimeMigrations" },
        };
        var incoming = new BsonDocument
        {
            ["_id"] = "global",
            ["CompletedOneTimeMigrations"] = new BsonArray { "perm-from-source" },
        };
        var localExisting = new BsonDocument
        {
            ["_id"] = "global",
            ["CompletedOneTimeMigrations"] = new BsonArray { "perm-target-only" },
        };

        DataSyncApply.CarryTargetLocalFields(new[] { incoming }, new[] { localExisting }, collection);

        incoming["CompletedOneTimeMigrations"].AsBsonArray
            .Select(x => x.AsString).ShouldBe(new[] { "perm-target-only" });
    }

    [Fact]
    public void 目标站原本没有执行历史时不写入空值()
    {
        var collection = new DataSyncCollection("appsettings", System.Array.Empty<string>())
        {
            PreserveFields = new[] { "CompletedOneTimeMigrations" },
        };
        var incoming = new BsonDocument
        {
            ["_id"] = "global",
            ["CompletedOneTimeMigrations"] = new BsonArray { "perm-from-source" },
        };
        var localExisting = new BsonDocument { ["_id"] = "global" };

        DataSyncApply.CarryTargetLocalFields(new[] { incoming }, new[] { localExisting }, collection);

        // 「本机什么都没跑过」是字段不存在，不是一个空数组。
        incoming.Contains("CompletedOneTimeMigrations").ShouldBeFalse();
    }

    /// <summary>
    /// 接线守卫（形状 2）：把出口那行 StripTargetLocal 或写入前那行 CarryTargetLocalFields
    /// 删掉之后，上面几条仍然全绿——它们测的是函数，不是「有没有人调它」。
    /// </summary>
    [Fact]
    public void 本地执行历史的两头都接上了()
    {
        ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs")
            .ShouldContain("DataSyncRedactor.StripTargetLocal(doc, effective)");

        var worker = ReadWorkerSource();
        worker.ShouldContain("DataSyncApply.CarryTargetLocalFields(decision.ToReplace, existing, collection)");
        // 接回来的前提是真的把那几个字段查回来了；只投影 _id 的话接回来的永远是空。
        worker.ShouldContain("BuildExistingProjection(collection)");
        worker.ShouldNotContain("Builders<BsonDocument>.Projection.Include(\"_id\"))\n                    .ToListAsync");
    }

    /// <summary>
    /// 部分插入失败后要按**失败下标**剔除，不是砍末尾 N 条。数量一样、身份不一样，
    /// 而待补清单要拿这批文档逐条看字段在不在——认错人就会漏报真需要补的凭据，
    /// 或者替一条根本没写进去的文档报一个假的。
    /// </summary>
    [Fact]
    public void 部分插入失败按下标剔除而不是砍末尾()
    {
        var attempted = new[]
        {
            new BsonDocument { ["_id"] = "a" },
            new BsonDocument { ["_id"] = "b" },
            new BsonDocument { ["_id"] = "c" },
        };

        // 失败的是中间那条。砍末尾会留下 a、b（错），按下标剔除留下 a、c（对）。
        var survivors = DataSyncApply.SurvivingInserts(attempted, new[] { 1 });

        survivors.Select(d => d["_id"].AsString).ShouldBe(new[] { "a", "c" });
    }

    [Fact]
    public void 没有失败下标时原样返回()
    {
        var attempted = new[] { new BsonDocument { ["_id"] = "a" } };
        DataSyncApply.SurvivingInserts(attempted, System.Array.Empty<int>())
            .Select(d => d["_id"].AsString).ShouldBe(new[] { "a" });
    }

    [Fact]
    public void 认错写入文档会让待补清单报错人()
    {
        // 把上一条的抽象判据接到它真正的下游，说明为什么值得单独修这一处：
        // 只有**第一条**带凭据字段，而失败的恰好是它。按下标剔除后剩下的是 b，
        // 待补清单为空（对）；砍末尾会留下 a，于是替一条根本没写进去的文档
        // 报一个「去补 ApiKeyEncrypted」的假警告。
        // 失败下标放在 0 是有意的：放末尾的话两种实现给出同样的结果，这条就白写了。
        var attempted = new[]
        {
            new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "" },
            new BsonDocument { ["_id"] = "b" },
        };
        var survivors = DataSyncApply.SurvivingInserts(attempted, new[] { 0 });

        var run = new DataSyncRun();
        // 带凭据字段的是 a，而 a 恰好插入失败了；b 从来没带过它。
        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms",
            Owners("ApiKeyEncrypted", "a"), survivors);

        run.PendingSecretFields.ShouldNotContainKey("llmplatforms");
    }

    [Fact]
    public void 剔除判据接在worker的批量插入失败路径上()
    {
        // 接线守卫（形状 2）：上面三条测的是判据本身，测不到「worker 有没有用它」。
        var worker = ReadWorkerSource();
        worker.ShouldContain("DataSyncApply\n                                    .SurvivingInserts(decision.ToInsert, ex.WriteErrors.Select(e => e.Index))");
        // 砍末尾那种写法不许回来。
        worker.ShouldNotContain("decision.ToInsert.Count - conflicts).ToList()");
    }

    /// <summary>
    /// 「什么时候要管理员额外勾一次确认」这条判据在前后端各有一份，两边必须说同一句话。
    /// 界面那份由 `trustGate.test.ts` 对四种组合逐个断言；这里钉住服务端这一份不漂。
    /// 曾经界面只看 originAllowed，于是「来源已在名单里、但对外同步开关关着」那一种
    /// 确认框不显示、按钮却可点，点一次 409 一次，没有任何界面动作能救回来。
    /// </summary>
    [Fact]
    public void 当场准入的服务端判据是两个条件的或()
    {
        var source = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        source.ShouldContain("if (!enabled || !originAllowed)");
        source.ShouldContain("if (!request.TrustThisOrigin)");
    }

    /// <summary>
    /// 名单在库里是逗号拼起来的单值，「加一条」实际是整份覆盖写。两个管理员同时批准
    /// 两台不同的机器时，后写的那份基于旧名单算，先写进去的那台被抹掉——而它此刻已经
    /// 拿到票，下一次重对名单时突然 401。没有 $addToSet 可用，所以走乐观重试。
    /// </summary>
    [Fact]
    public void 加入允许名单要走乐观重试而不是直接覆盖()
    {
        var source = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        var body = source[source.IndexOf("private async Task TrustOriginAsync", StringComparison.Ordinal)..];
        body = body[..body.IndexOf("\n    private ", StringComparison.Ordinal)];

        body.ShouldContain("for (var attempt = 0");
        // 条件必须是「名单还是我刚读到的那一份」，用原始值而不是解析后的列表。
        body.ShouldContain("Builders<AppSettings>.Filter.Eq(x => x.DataSyncAllowedConsumerOrigins, raw)");
        // 重试用尽要抛，不能静默返回——名单没加上而票照发，等于发一张下一秒就被拒的票。
        body.ShouldContain("throw new InvalidOperationException");
    }

    /// <summary>
    /// 「对外同步实际上开没开」只能有一份判据。曾经鉴权链路按「开关 且 名单非空」算，
    /// 而设置接口的 PUT 把请求里那个原始开关直接回给前端——管理员撤掉最后一条来源后，
    /// 界面上开关还亮着，握手与换票却一律被拒。
    /// </summary>
    [Theory]
    [InlineData(true, 1, true)]
    [InlineData(true, 0, false)]   // 名单空掉：开关还立着也不算开
    [InlineData(false, 1, false)]
    [InlineData(false, 0, false)]
    public void 名单为空时对外同步一律算关闭(bool flag, int originCount, bool expected)
    {
        var origins = Enumerable.Range(0, originCount).Select(i => $"https://a{i}.example.com").ToList();
        DataSyncProviderController.IsEffectivelyEnabled(flag, origins).ShouldBe(expected);
    }

    [Fact]
    public void 设置接口回的是生效状态而不是请求里的原始开关()
    {
        // 接线守卫（形状 2）：上面那条只测判据本身，测不到「PUT 有没有用它」。
        var source = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        source.ShouldContain("enabled = IsEffectivelyEnabled(request.Enabled, origins)");
        source.ShouldNotContain("Ok(new { enabled = request.Enabled, origins })");
        // 读取链路也必须走同一个函数，不许再抄一份 `enabled && origins.Count > 0`。
        source.ShouldContain("new ProviderConfig(IsEffectivelyEnabled(enabled, origins), origins, enabled)");
        // 第三个参数是**原始**开关：生效值给显示与鉴权，原始值给并发比对。
        // 两者混用就是第 29 轮那个死锁的来源。
    }

    /// <summary>
    /// 库里还没有这个字段时，生效名单来自环境变量兜底。此时若从空列表起算，
    /// 第一次「当场准入」写下去的就只有新批准的这一台，而之后所有读取都优先库里的值——
    /// 环境变量里配的那些来源就此静默消失，它们手上还没过期的票下一次重对名单时全部失效。
    /// </summary>
    [Fact]
    public void 首次写名单要从生效值起算而不是从零()
    {
        var source = ReadApiSource("Controllers", "Api", "DataSyncProviderController.cs");
        var body = source[source.IndexOf("private async Task TrustOriginAsync", StringComparison.Ordinal)..];
        body = body[..body.IndexOf("\n    private ", StringComparison.Ordinal)];

        body.ShouldContain("raw is null ? config.AllowedOrigins : ParseOrigins(raw)");
        // 无条件 ParseOrigins(raw) 就是那个 bug：缺字段时得到空列表。
        body.ShouldNotContain("var origins = ParseOrigins(raw).ToList();");
    }

    /// <summary>
    /// 握手失败的异常原文里可能带内网地址、证书主体名、代理主机，
    /// 而它对操作者也给不出可执行的下一步。原文进日志，界面给固定文案 + 诊断号。
    /// </summary>
    [Fact]
    public void 握手失败不把异常原文回给前端()
    {
        var source = ReadApiSource("Controllers", "Api", "DataSyncConsumerController.cs");
        var body = source[source.IndexOf("private async Task<SourceProbe> ProbeSourceAsync", StringComparison.Ordinal)..];
        body = body[..body.IndexOf("\n    private ", StringComparison.Ordinal)];

        body.ShouldNotContain("{ex.Message}");
        body.ShouldContain("_logger.LogWarning(ex,");
        body.ShouldContain("诊断号");
    }

    [Fact]
    public void 导出分页能读出文档与续页游标()
    {
        var page = DataSyncRunWorker.ReadPage(
            """{"success":true,"data":{"collection":"defect_reports","nextCursor":"{\"v\":\"z\"}","documents":["{\"_id\":\"a\"}","{\"_id\":\"b\"}"]}}""");
        page.Documents.Count.ShouldBe(2);
        page.NextCursor.ShouldBe("{\"v\":\"z\"}");
    }

    [Fact]
    public void 末页没有续页游标即视为拉完()
    {
        var page = DataSyncRunWorker.ReadPage("""{"data":{"collection":"x","documents":[]}}""");
        page.Documents.ShouldBeEmpty();
        page.NextCursor.ShouldBeNull();
    }

    [Fact]
    public void 缺少data段直接抛而不是当成拉完()
    {
        // 静默当成「拉完了」是最坏的失败方式：Run 会显示成功，数据一条没进来。
        Should.Throw<InvalidOperationException>(() => DataSyncRunWorker.ReadPage("""{"error":"boom"}"""));
    }

    [Fact]
    public void 保险箱里的verifier只能取一次()
    {
        var vault = new DataSyncTokenVault();
        vault.StashVerifier("state-1", "verifier-1", DateTime.UtcNow.AddMinutes(5));
        vault.TakeVerifier("state-1").ShouldBe("verifier-1");
        vault.TakeVerifier("state-1").ShouldBeNull();
    }

    [Fact]
    public void 过期的令牌取不出来且不再被认领()
    {
        var vault = new DataSyncTokenVault();
        vault.PutExportToken("run-1", "tok", DateTime.UtcNow.AddSeconds(-1));
        vault.GetExportToken("run-1").ShouldBeNull();
        vault.HeldRunIds.ShouldBeEmpty();
    }

    [Fact]
    public void 只有本进程握着令牌的Run才会被认领()
    {
        var vault = new DataSyncTokenVault();
        vault.PutExportToken("mine", "tok", DateTime.UtcNow.AddMinutes(10));
        vault.HeldRunIds.ShouldBe(new[] { "mine" });
        // 共享库里别的部署建的 Run 不在这个集合里，于是不会被本进程抢走执行。
        vault.Forget("mine");
        vault.HeldRunIds.ShouldBeEmpty();
    }

    [Fact]
    public void SSE推送的字段名与GET一致且是camelCase()
    {
        // 这个对象走两条路出去：ApiResponse 经 MVC 的 camelCase 配置，SSE 自己调
        // JsonSerializer（默认 PascalCase）。用属性简写的话两条路键名不一样，
        // 前端在同步跑起来的那一刻突然读不到值——而且不报错，只是数字不再更新。
        var run = new DataSyncRun
        {
            Id = "run-1",
            Status = "running",
            SourceLabel = "生产 MAP",
            SourceOrigin = "https://map.example.com",
            Groups = new List<string> { "defect" },
            Collections = new List<string> { "defect_reports" },
            DryRun = true,
            Progress = new Dictionary<string, DataSyncCollectionProgress>
            {
                ["defect_reports"] = new() { SourceTotal = 10, Fetched = 4, Inserted = 3, Skipped = 1, Updated = 0, Done = false },
            },
            PendingSecretFields = new Dictionary<string, List<string>> { ["llmplatforms"] = new() { "ApiKeyEncrypted" } },
        };

        using var doc = JsonDocument.Parse(DataSyncConsumerController.SerializeRunForStream(run));
        var keys = doc.RootElement.EnumerateObject().Select(p => p.Name).ToHashSet();

        // 前端 DataSyncPage 的 RunView 逐字读这些键。
        foreach (var expected in new[]
                 {
                     "runId", "status", "sourceLabel", "sourceOrigin", "groups", "collections",
                     "dryRun", "overwriteExisting", "error", "pendingSecretFields", "progress",
                 })
        {
            keys.ShouldContain(expected);
        }
        keys.ShouldNotContain("Status");

        var row = doc.RootElement.GetProperty("progress").EnumerateArray().Single();
        foreach (var expected in new[] { "collection", "sourceTotal", "fetched", "inserted", "skipped", "updated", "done" })
        {
            row.TryGetProperty(expected, out _).ShouldBeTrue($"progress 行缺少 {expected}");
        }
        row.GetProperty("sourceTotal").GetInt64().ShouldBe(10);
    }
}
