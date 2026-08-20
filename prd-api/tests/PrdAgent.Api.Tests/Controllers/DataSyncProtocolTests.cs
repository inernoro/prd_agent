using System.Text.Json;
using MongoDB.Bson;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.DataSync;
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
    [InlineData("http://map.example.com")]                 // 非本机的 http
    [InlineData("")]
    [InlineData(null)]
    public void 非法源站地址被拒(string? raw)
    {
        DataSyncConsumerController.TryNormalizeOrigin(raw, out _).ShouldBeFalse();
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
