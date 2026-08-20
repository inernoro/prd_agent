using System.Text.RegularExpressions;
using MongoDB.Bson;
using PrdAgent.Core.DataSync;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 跨实例同步白名单的守卫。
///
/// 这套判据要挡的是一种「不会报错的漏」：日后有人在 MongoDbContext 里加一个装凭据的
/// 集合，白名单不认识它，于是它既不会被导出（好），也不会有人发现它没被分类（坏）——
/// 直到某天有人顺手把它塞进某个分组。所以这里强制**全覆盖**：每个集合要么在分组里，
/// 要么在 Excluded 里写明理由，两边都没有就 CI 变红，逼着新集合的作者当场做一次判断。
/// </summary>
public class DataSyncScopeCoverageTests
{
    private readonly ITestOutputHelper _output;

    public DataSyncScopeCoverageTests(ITestOutputHelper output) => _output = output;

    private static IReadOnlyList<string> ReadRegisteredCollections()
    {
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Infrastructure", "Database", "MongoDbContext.cs");
        Assert.True(File.Exists(path), $"找不到 MongoDbContext.cs：{path}");
        var source = File.ReadAllText(path);
        var names = Regex.Matches(source, @"GetCollection<[^>]+>\(""([a-zA-Z0-9_]+)""\)")
            .Select(m => m.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        // 正则没匹配到东西时，下面每一条断言都会「通过」——空集合天然满足全覆盖。
        // 这是典型的假绿，所以先把「确实读到了东西」本身断言掉。
        Assert.True(names.Count > 200, $"只从 MongoDbContext 解析出 {names.Count} 个集合，正则多半失效了");
        return names;
    }

    [Fact]
    public void 每个已注册集合都必须被分类为可导出或明确排除()
    {
        var registered = ReadRegisteredCollections();
        var exportable = DataSyncScope.AllExportableCollections.ToHashSet(StringComparer.Ordinal);
        var excluded = DataSyncScope.Excluded.Keys.ToHashSet(StringComparer.Ordinal);

        var unclassified = registered.Where(n => !exportable.Contains(n) && !excluded.Contains(n)).ToList();
        Assert.True(unclassified.Count == 0,
            "下列集合还没有在 DataSyncScope 里分类，请放进某个分组，或加进 Excluded 并写明不导出的理由：\n  "
            + string.Join("\n  ", unclassified));

        var both = registered.Where(n => exportable.Contains(n) && excluded.Contains(n)).ToList();
        Assert.True(both.Count == 0, "下列集合同时出现在分组和排除表里，判据自相矛盾：\n  " + string.Join("\n  ", both));

        _output.WriteLine($"已注册 {registered.Count} 个集合：可导出 {exportable.Count}，明确排除 {excluded.Count}");
    }

    [Fact]
    public void 白名单里不许出现已经不存在的集合()
    {
        var registered = ReadRegisteredCollections().ToHashSet(StringComparer.Ordinal);
        var ghosts = DataSyncScope.AllExportableCollections
            .Concat(DataSyncScope.Excluded.Keys)
            .Where(n => !registered.Contains(n))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        // 幽灵条目本身不会造成泄漏，但会让「导出了 N 个集合」这句话对不上账，
        // 而对账正是同步前 dry-run 唯一能给操作者的保证。
        Assert.True(ghosts.Count == 0, "白名单引用了 MongoDbContext 里不存在的集合：\n  " + string.Join("\n  ", ghosts));
    }

    [Fact]
    public void 排除理由不许留空()
    {
        var blank = DataSyncScope.Excluded.Where(kv => string.IsNullOrWhiteSpace(kv.Value)).Select(kv => kv.Key).ToList();
        Assert.True(blank.Count == 0, "下列集合排除了却没写理由：" + string.Join(", ", blank));
    }

    [Fact]
    public void 装凭据的集合一律不在可导出清单里()
    {
        // 这几个是「搬过去就等于把访问权搬过去」的集合，逐个钉死。
        // 不用关键字模糊匹配：模糊匹配会随命名习惯漂移，而这里要的是不可协商的黑名单。
        string[] mustNeverExport =
        {
            "agent_api_keys", "console_sso_tickets", "external_authorizations", "workflow_secrets",
            "github_user_connections", "sessions", "openplatformapps", "invitecodes",
            "desktop_asset_keys", "peer_pairing_codes", "short_links",
        };
        var leaked = mustNeverExport.Where(n => DataSyncScope.AllExportableCollections.Contains(n)).ToList();
        Assert.True(leaked.Count == 0, "凭据类集合出现在可导出清单里：" + string.Join(", ", leaked));
    }

    [Fact]
    public void 带密钥字段的集合必须登记脱敏字段()
    {
        // 已知会带密钥的可导出集合 -> 至少要清空的字段。
        var required = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["users"] = new[] { "PasswordHash" },
            ["llmplatforms"] = new[] { "ApiKeyEncrypted" },
            ["llmmodels"] = new[] { "ApiKeyEncrypted" },
            ["channel_settings"] = new[] { "ImapPassword", "SmtpPassword" },
            ["appsettings"] = new[] { "ConsoleSsoClientSecret", "MiduoSsoAppSecret" },
        };
        foreach (var (collection, fields) in required)
        {
            Assert.True(DataSyncScope.TryResolve(collection, out var resolved), $"{collection} 不在可导出清单里，判据前提已变");
            foreach (var field in fields)
            {
                Assert.True(resolved.RedactFields.Contains(field, StringComparer.Ordinal),
                    $"{collection} 的 {field} 没有登记脱敏，导出会把密文原样带走");
            }
        }
    }

    [Fact]
    public void 脱敏在出口清空字段并报告清空了哪些()
    {
        Assert.True(DataSyncScope.TryResolve("llmplatforms", out var platform));
        var doc = new BsonDocument
        {
            { "_id", "p1" },
            { "Name", "OpenAI" },
            { "ApiKeyEncrypted", "ciphertext-should-never-leave" },
        };

        var cleared = DataSyncRedactor.Redact(doc, platform);

        Assert.Equal(new[] { "ApiKeyEncrypted" }, cleared);
        Assert.Equal("", doc["ApiKeyEncrypted"].AsString);
        // 字段保留而不是删除：目标站要靠「有这个字段但是空的」列出待补清单。
        Assert.True(doc.Contains("ApiKeyEncrypted"));
        Assert.Equal("OpenAI", doc["Name"].AsString);
    }

    [Fact]
    public void 本来就空的字段不算被清空()
    {
        Assert.True(DataSyncScope.TryResolve("llmmodels", out var model));
        var doc = new BsonDocument { { "_id", "m1" }, { "ApiKeyEncrypted", "" } };
        Assert.Empty(DataSyncRedactor.Redact(doc, model));
        // 否则待补清单会把「源站压根没配过」的字段也列成待补，操作者照着填一遍空气。
    }

    [Fact]
    public void 没有登记脱敏字段的集合原样通过()
    {
        Assert.True(DataSyncScope.TryResolve("defect_reports", out var defects));
        var doc = new BsonDocument { { "_id", "d1" }, { "Title", "登录页崩溃" } };
        Assert.Empty(DataSyncRedactor.Redact(doc, defects));
        Assert.Equal("登录页崩溃", doc["Title"].AsString);
    }

    [Fact]
    public void 分组展开只认识已登记的分组key()
    {
        var expanded = DataSyncScope.Expand(new[] { "llm-config", "不存在的分组" });
        Assert.NotEmpty(expanded);
        Assert.Contains(expanded, c => c.Name == "llmplatforms");
        // 不认识的 key 被忽略，且忽略只会缩小范围——展开结果全部来自已登记分组。
        Assert.All(expanded, c => Assert.True(DataSyncScope.GroupOf(c.Name) == "llm-config"));
    }

    [Fact]
    public void 空勾选展开为空而不是全量()
    {
        // 「没勾任何分组」必须等于「什么都不导」。若退化成全量，一次误操作就是全库外流。
        Assert.Empty(DataSyncScope.Expand(Array.Empty<string>()));
        Assert.Empty(DataSyncScope.Expand(null));
    }

    [Fact]
    public void 未登记的集合名解析失败()
    {
        Assert.False(DataSyncScope.TryResolve("llmplatform", out _)); // 少个 s 的拼写错误
        Assert.False(DataSyncScope.TryResolve("", out _));
        Assert.False(DataSyncScope.TryResolve(null, out _));
    }

    private static string LocateSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln"))) return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
