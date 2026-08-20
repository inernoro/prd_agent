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
    public void 可导出集合里长得像凭据的字段必须逐个交代()
    {
        // 手写「这几个集合要脱敏」只覆盖得到我当时想到的那几个。真实情况是
        // Codex review 一眼看出 document_stores.SyncToken 与 document_store_sync_links.RemoteToken
        // 是永久有效、能直接调对方 sync 端点的凭据，而它们被原样导出——判据太窄
        // （predicate-and-wiring-discipline 形状 1）。
        //
        // 所以这里改成机器逐个逼问：可导出集合对应的实体类里，凡是字段名长得像凭据的，
        // 要么已登记脱敏，要么写进下面的「看过了，不是凭据」名单并说明理由。新加一个
        // 带 Token / Secret / Password 的字段而没有交代，CI 直接红。
        var reviewedNonCredentials = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["appsettings.PasswordLoginDisabled"] = "布尔开关，不是口令",
            ["users.MustResetPassword"] = "布尔标记，正是同步后要让管理员看见的那个",
            ["documents.TokenEstimate"] = "token 计数，不是访问凭据",
            ["groups.PrdTokenEstimateSnapshot"] = "token 计数快照",
            ["pr_review_items.LastRefreshError"] = "错误文案，命中的是 refresh 这个词",
            ["pr_review_items.LastRefreshedAt"] = "时间戳，命中的是 refresh 这个词",
            ["workflows.IsSecret"] = "布尔开关，不是密钥本身",
            ["workflows.WebhookId"] = "标识而非凭据；对应的密钥在 workflow_secrets，那个集合整个不导出",
            ["user_shortcuts.TokenPrefix"] = "只是前缀，用于界面辨认；真正的散列 TokenHash 已登记脱敏",
        };

        var suspect = new Regex(
            "token|secret|password|passwd|apikey|credential|privatekey|accesskey|refresh|webhook",
            RegexOptions.IgnoreCase);
        // 这些后缀是「计数」不是「凭据」，先排掉，免得整张表被 token 计数字段淹没。
        var countingSuffix = new Regex("(TokenCount|Tokens|TokenUsage|TokenLimit|MaxTokens)$", RegexOptions.None);

        var collectionToType = ReadCollectionTypeMap();
        Assert.True(collectionToType.Count > 200, $"只解析出 {collectionToType.Count} 个集合到实体的映射，正则多半失效了");
        var propsByType = ReadModelProperties();
        Assert.True(propsByType.Count > 100, $"只解析出 {propsByType.Count} 个实体的属性，正则多半失效了");

        var unexplained = new List<string>();
        var coveredAny = false;
        foreach (var collection in DataSyncScope.AllExportableCollections.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!collectionToType.TryGetValue(collection, out var typeName)) continue;
            if (!propsByType.TryGetValue(typeName, out var properties)) continue;
            coveredAny = true;
            DataSyncScope.TryResolve(collection, out var resolved);
            foreach (var property in properties.OrderBy(x => x, StringComparer.Ordinal))
            {
                if (!suspect.IsMatch(property) || countingSuffix.IsMatch(property)) continue;
                if (resolved is not null && resolved.RedactFields.Contains(property, StringComparer.Ordinal)) continue;
                var key = $"{collection}.{property}";
                if (reviewedNonCredentials.ContainsKey(key)) continue;
                unexplained.Add(key);
            }
        }

        // 一个都没扫到时上面每条断言都天然成立——先把「确实扫到了东西」本身断言掉。
        Assert.True(coveredAny, "一个可导出集合的实体属性都没解析到，这条守卫在空跑");
        Assert.True(unexplained.Count == 0,
            "下列字段名长得像凭据，却既没登记脱敏、也没写进「看过了，不是凭据」名单：\n  "
            + string.Join("\n  ", unexplained)
            + "\n（是凭据 -> 加进 DataSyncScope 的 RedactFields；不是 -> 加进本用例的 reviewedNonCredentials 并写明理由）");
    }

    /// <summary>集合名 -> 实体类型名，解析自 MongoDbContext 的 GetCollection 调用。</summary>
    private static IReadOnlyDictionary<string, string> ReadCollectionTypeMap()
    {
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Infrastructure", "Database", "MongoDbContext.cs");
        var source = File.ReadAllText(path);
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match m in Regex.Matches(source, @"GetCollection<([A-Za-z0-9_.]+)>\(""([a-zA-Z0-9_]+)""\)"))
        {
            map[m.Groups[2].Value] = m.Groups[1].Value.Split('.').Last();
        }
        return map;
    }

    /// <summary>实体类型名 -> 公开属性名。</summary>
    private static IReadOnlyDictionary<string, HashSet<string>> ReadModelProperties()
    {
        var root = Path.Combine(LocateSrcRoot(), "PrdAgent.Core", "Models");
        var result = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var source = File.ReadAllText(file);
            foreach (Match decl in Regex.Matches(source, @"(?:class|record)\s+([A-Za-z0-9_]+)"))
            {
                // 类体的粗略切片：从声明处往后取，直到下一个类型声明为止。
                var start = decl.Index + decl.Length;
                var next = Regex.Match(source[start..], @"(?:class|record)\s+[A-Za-z0-9_]+");
                var body = next.Success ? source[start..(start + next.Index)] : source[start..];
                var bucket = result.TryGetValue(decl.Groups[1].Value, out var existing)
                    ? existing
                    : result[decl.Groups[1].Value] = new HashSet<string>(StringComparer.Ordinal);
                foreach (Match prop in Regex.Matches(body, @"public\s+[A-Za-z0-9_<>?\[\],\s]+?\s+([A-Za-z0-9_]+)\s*\{\s*get;"))
                {
                    bucket.Add(prop.Groups[1].Value);
                }
            }
        }
        return result;
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

    [Fact]
    public void 消费方每个端点都必须自己判管理员()
    {
        // 这个控制器只有类级 [Authorize]——也就是「登录了就行」。发起同步判了管理员，
        // 但 start 一开始没判：任何登录用户只要拿到一个 pending 的 runId，就能带
        // overwrite=true 把别人授权来的数据写进共享库。类级特性看着像已经保护了，
        // 实际上一个都没保护（predicate-and-wiring-discipline 形状 8：不成立的证据）。
        // 所以这里逐个方法钉死：public 的 action 里必须出现 IsAdminAsync。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        var source = File.ReadAllText(path);

        // 按 [Http...] 特性切段，每段一个 action。
        var chunks = Regex.Split(source, @"(?=\n\s*\[Http(?:Get|Post|Put|Delete)\()")
            .Where(c => Regex.IsMatch(c, @"^\s*\[Http(?:Get|Post|Put|Delete)\("))
            .ToList();
        Assert.True(chunks.Count >= 7, $"只切出 {chunks.Count} 个 action，正则多半失效了");

        var unguarded = chunks
            .Where(c => !c.Contains("IsAdminAsync", StringComparison.Ordinal))
            .Select(c => Regex.Match(c, @"public\s+(?:async\s+)?Task[^\s]*\s+(\w+)\(").Groups[1].Value)
            .Where(name => name.Length > 0)
            .ToList();

        Assert.True(unguarded.Count == 0,
            "DataSyncConsumerController 下列端点没有判管理员，登录用户即可调用：" + string.Join(", ", unguarded));
    }

    [Fact]
    public void 源站带Authorize的端点都必须判真人管理员()
    {
        // 源站控制器混着两类端点：[AllowAnonymous] 的机器对机器（换票 / 清单 / 导出，
        // 靠一次性码和导出令牌自己鉴权），和 [Authorize] 的人机端点。后者只写 [Authorize]
        // 等于「登录即可」——scope-catalog 就这么把全站集合名与逐集合条数摊给了任何登录用户。
        // 这里钉死：带 [Authorize] 的 action 必须调 ResolveAdminIdentityAsync。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncProviderController.cs");
        var source = File.ReadAllText(path);

        var chunks = Regex.Split(source, @"(?=\n\s*\[Http(?:Get|Post|Put|Delete)\()")
            .Where(c => Regex.IsMatch(c, @"^\s*\[Http(?:Get|Post|Put|Delete)\("))
            .ToList();
        Assert.True(chunks.Count >= 5, $"只切出 {chunks.Count} 个 action，正则多半失效了");

        var authorized = chunks.Where(c => c.Contains("[Authorize]", StringComparison.Ordinal)).ToList();
        Assert.True(authorized.Count >= 2, "源站一个 [Authorize] 端点都没解析出来，判据前提已变");

        var unguarded = authorized
            .Where(c => !c.Contains("ResolveAdminIdentityAsync", StringComparison.Ordinal))
            .Select(c => Regex.Match(c, @"public\s+(?:async\s+)?(?:Task[^\s]*|IActionResult)\s+(\w+)\(").Groups[1].Value)
            .Where(name => name.Length > 0)
            .ToList();

        Assert.True(unguarded.Count == 0,
            "DataSyncProviderController 下列 [Authorize] 端点没有判真人管理员：" + string.Join(", ", unguarded));
    }

    [Fact]
    public void 同步端点的路由前缀不能被任何管理后台前缀吃掉()
    {
        // AdminPermissionMiddleware 用的是**裸前缀匹配**（path.StartsWith(prefix)，没有分段边界）。
        // 于是 `api/data-sync/...` 会命中 `[AdminController("data")]` 的 `api/data`，
        // 连 [AllowAnonymous] 的换票、导出端点都被判成「管理后台未登录访问」返回 401——
        // 这一条在真实部署上发生过，本地单测看不出来，只有打真站才会暴露。
        // 所以这里钉死：同步用的前缀不许是任何被标记前缀的延长。
        var marked = ReadAdminControllerPrefixes();
        Assert.True(marked.Count > 50, $"只解析出 {marked.Count} 个 AdminController 前缀，正则多半失效了");

        const string ours = "api/instance-sync";
        var swallowedBy = marked.Where(p => ours.StartsWith(p, StringComparison.Ordinal) && ours != p).ToList();
        Assert.True(swallowedBy.Count == 0,
            $"{ours} 会被这些管理后台前缀吃掉，匿名端点将返回 401：{string.Join(", ", swallowedBy)}");
    }

    private static IReadOnlyList<string> ReadAdminControllerPrefixes()
    {
        var prefixes = new List<string>();
        foreach (var file in Directory.EnumerateFiles(LocateSrcRoot(), "*.cs", SearchOption.AllDirectories))
        {
            var source = File.ReadAllText(file);
            if (!source.Contains("[AdminController(", StringComparison.Ordinal)) continue;
            var route = Regex.Match(source, @"\[Route\(""(api/[^""]+)""\)\]");
            if (route.Success) prefixes.Add(route.Groups[1].Value);
        }
        return prefixes;
    }
}
