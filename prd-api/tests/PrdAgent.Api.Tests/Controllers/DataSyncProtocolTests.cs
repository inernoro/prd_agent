using System.Text.Json;
using MongoDB.Bson;
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

    /// <summary>
    /// 待补清单是给管理员照着补凭据用的，所以它不能包含「本站原值根本没被动过」的字段：
    /// 不覆盖模式下同 _id 的文档被跳过，本站那份凭据还好好的，报进去等于诱导他去改坏一个能用的配置。
    /// </summary>
    [Fact]
    public void 待补清单只记真的落地了的文档()
    {
        var run = new DataSyncRun();
        var written = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms", new[] { "ApiKeyEncrypted" }, new[] { written });
        run.PendingSecretFields["llmplatforms"].ShouldBe(new[] { "ApiKeyEncrypted" });
    }

    [Fact]
    public void 整页都被跳过时不产生待补项()
    {
        var run = new DataSyncRun();

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms", new[] { "ApiKeyEncrypted" }, Array.Empty<BsonDocument>());

        run.PendingSecretFields.ShouldNotContainKey("llmplatforms");
    }

    [Fact]
    public void 落地的文档里没有那个字段就不记它()
    {
        var run = new DataSyncRun();
        // 源站是按集合报脱敏字段的，这一页未必每条都带它。
        var written = new BsonDocument { ["_id"] = "a", ["Name"] = "x" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms", new[] { "ApiKeyEncrypted" }, new[] { written });

        run.PendingSecretFields.ShouldNotContainKey("llmplatforms");
    }

    [Fact]
    public void 待补清单不重复记同一个字段()
    {
        var run = new DataSyncRun();
        var written = new BsonDocument { ["_id"] = "a", ["ApiKeyEncrypted"] = "" };

        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms", new[] { "ApiKeyEncrypted" }, new[] { written });
        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms", new[] { "ApiKeyEncrypted" }, new[] { written });

        run.PendingSecretFields["llmplatforms"].Count.ShouldBe(1);
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
        source.ShouldContain("RecordPendingSecrets(run, collection.Name, page.ClearedFields,");
        // 传的必须是「决定要写的那些」，不是这一页拉回来的全部。
        source.ShouldContain("decision.ToInsert.Concat(decision.ToReplace)");
        source.ShouldNotContain("RecordPendingSecrets(run, collection.Name, page.ClearedFields, documents)");
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
        DataSyncRunWorker.RecordPendingSecrets(run, "llmplatforms", new[] { "ApiKeyEncrypted" }, survivors);

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
