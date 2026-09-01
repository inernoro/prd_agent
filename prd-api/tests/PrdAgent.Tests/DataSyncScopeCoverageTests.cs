using System.Text.RegularExpressions;
using MongoDB.Bson;
using PrdAgent.Core.DataSync;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
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
            ["users.MustResetPassword"] = "布尔标记，正是同步后要让管理员看见的那个",
            ["documents.TokenEstimate"] = "token 计数，不是访问凭据",
            ["groups.PrdTokenEstimateSnapshot"] = "token 计数快照",
            ["pr_review_items.LastRefreshError"] = "错误文案，命中的是 refresh 这个词",
            ["pr_review_items.LastRefreshedAt"] = "时间戳，命中的是 refresh 这个词",
            ["document_store_sync_links.LastLocalSignature"] = "内容指纹，用于判断两侧变没变，拿着它换不到任何权限",
            ["document_store_sync_links.LastRemoteSignature"] = "同上，内容指纹",
            ["document_stores.PeerSyncLastContentSignature"] = "同上，内容指纹",
        };

        // 关键词表本身也是判据的一部分，一样会太窄：第一版只有 token/secret/password 这一族，
        // 于是 groups.InviteCode / teams.InviteCode 溜了过去——邀请码就是一张「拿着它就能
        // 加入这个私有群/团队」的通行证，只是名字里没有 token 这个词（Codex 二次指出）。
        var suspect = new Regex(
            "token|secret|password|passwd|apikey|credential|privatekey|accesskey|refresh|webhook"
            + "|invitecode|invitation|joincode|sharecode|pairingcode|otp|signature|salt|nonce"
            + "|licensekey|activationcode",
            RegexOptions.IgnoreCase);
        // 这些后缀是「计数」不是「凭据」，先排掉，免得整张表被 token 计数字段淹没。
        var countingSuffix = new Regex("(TokenCount|Tokens|TokenUsage|TokenLimit|MaxTokens)$", RegexOptions.None);

        var collectionToType = ReadCollectionTypeMap();
        Assert.True(collectionToType.Count > 200, $"只解析出 {collectionToType.Count} 个集合到实体的映射，正则多半失效了");
        var propsByType = ReadModelProperties();
        Assert.True(propsByType.Count > 100, $"只解析出 {propsByType.Count} 个实体的属性，正则多半失效了");

        var unexplained = new List<string>();
        var used = new HashSet<string>(StringComparer.Ordinal);
        var coveredAny = false;
        var nestedCovered = false;
        foreach (var collection in DataSyncScope.AllExportableCollections.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!collectionToType.TryGetValue(collection, out var typeName)) continue;
            if (!propsByType.TryGetValue(typeName, out var properties)) continue;
            coveredAny = true;
            DataSyncScope.TryResolve(collection, out var resolved);

            void Check(string key, string leafName)
            {
                if (!suspect.IsMatch(leafName) || countingSuffix.IsMatch(leafName)) return;
                // 脱敏只认顶层字段名，所以只有不带 '.' 的 key 才可能被 RedactFields 覆盖。
                var top = key[(collection.Length + 1)..];
                if (!top.Contains('.', StringComparison.Ordinal)
                    && resolved is not null
                    && resolved.RedactFields.Contains(top, StringComparer.Ordinal)) return;
                if (reviewedNonCredentials.ContainsKey(key)) { used.Add(key); return; }
                unexplained.Add(key);
            }

            foreach (var property in properties.Keys.OrderBy(x => x, StringComparer.Ordinal))
            {
                Check($"{collection}.{property}", property);

                // 再往下一层。凭据不总在顶层：workflow 的密钥藏在 Variables[].DefaultValue，
                // 顶层扫描一无所获，于是 workflows 带着密钥被原样导出（Codex 三次指出同一形状）。
                // 深度只走一层——够覆盖本仓库现有的嵌套形态，再深就该换成模型上的显式标注了。
                var nestedType = StripToModelTypeName(properties[property]);
                if (nestedType is null || !propsByType.TryGetValue(nestedType, out var nestedProps)) continue;
                if (string.Equals(nestedType, typeName, StringComparison.Ordinal)) continue; // 自引用，别绕圈
                nestedCovered = true;
                foreach (var nested in nestedProps.Keys.OrderBy(x => x, StringComparer.Ordinal))
                {
                    Check($"{collection}.{property}.{nested}", nested);
                }
            }
        }

        // 一个都没扫到时上面每条断言都天然成立——先把「确实扫到了东西」本身断言掉。
        Assert.True(coveredAny, "一个可导出集合的实体属性都没解析到，这条守卫在空跑");
        Assert.True(nestedCovered, "一层嵌套都没走到，嵌套扫描在空跑（多半是类型名解析失效）");
        Assert.True(unexplained.Count == 0,
            "下列字段名长得像凭据，却既没登记脱敏、也没写进「看过了，不是凭据」名单：\n  "
            + string.Join("\n  ", unexplained)
            + "\n（是凭据 -> 加进 DataSyncScope 的 RedactFields，嵌套字段脱敏器覆盖不到、只能整个集合排除；"
            + "不是 -> 加进本用例的 reviewedNonCredentials 并写明理由）");

        // 豁免名单会随集合被移出白名单而变成死条目，留着会让人以为某个字段「看过了」，
        // 实际它早就不在扫描范围里。死条目一律清掉。
        var stale = reviewedNonCredentials.Keys.Where(k => !used.Contains(k)).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.True(stale.Count == 0,
            "reviewedNonCredentials 里下列条目已经扫不到了（集合被移出白名单，或字段被改名），请删除：\n  "
            + string.Join("\n  ", stale));
    }

    /// <summary>
    /// 反方向的闸：导出清单里带地址字段的集合，一个都不许没交代（DS33）。
    ///
    /// 原来只有单向闸——「登记的字段必须真实存在」。它挡得住「登记了一个拼错的名字」，
    /// 挡不住「压根没登记」：新增一个存资产地址的集合，`RebaseIncoming` 对它直接返回
    /// 空，地址原样落库，而三个计数全是 0——**连附件卡都不出现**，一个字都不说
    /// （predicate-and-wiring-discipline 形状 2：反方向那半没接）。
    ///
    /// 三个去处，必须占且只占一个：改写（UrlFields）／想清楚了不改（NotRebased）／
    /// 该改但方式没定（PendingSurvey，只许缩小）。
    /// </summary>
    [Fact]
    public void 导出的带地址集合必须三选一有交代()
    {
        var collectionToType = ReadCollectionTypeMap();
        var propsByType = ReadModelProperties();

        var withUrlFields = new List<string>();
        foreach (var collection in DataSyncScope.AllExportableCollections.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!collectionToType.TryGetValue(collection, out var typeName)) continue;
            if (!propsByType.TryGetValue(typeName, out var properties)) continue;
            if (properties.Keys.Any(p => p.EndsWith("Url", StringComparison.Ordinal)
                                      || p.EndsWith("Urls", StringComparison.Ordinal)))
            {
                withUrlFields.Add(collection);
            }
        }

        // 一个都没扫到时下面每条断言都天然成立——先把「确实扫到了东西」本身断言掉。
        Assert.True(withUrlFields.Count > 20,
            $"只扫到 {withUrlFields.Count} 个带地址字段的可导出集合，解析多半失效了");

        var rebased = DataSyncAssetUrls.FieldMap.Keys.ToHashSet(StringComparer.Ordinal);
        var declined = DataSyncAssetUrls.NotRebasedReasons.Keys.ToHashSet(StringComparer.Ordinal);
        var pending = DataSyncAssetUrls.PendingSurveyReasons.Keys.ToHashSet(StringComparer.Ordinal);

        var unclassified = withUrlFields
            .Where(c => !rebased.Contains(c) && !declined.Contains(c) && !pending.Contains(c))
            .ToList();
        Assert.True(unclassified.Count == 0,
            "下列集合会被导出、模型上带着地址字段，却既没登记改写、也没写明为什么不改：\n  "
            + string.Join("\n  ", unclassified)
            + "\n（该改 -> 登记进 DataSyncAssetUrls.UrlFields；指向别人家 -> 加进 NotRebased 并写明理由；"
            + "该改但 key 形态还没想清楚 -> 加进 PendingSurvey，那一栏只许缩小）");

        foreach (var c in withUrlFields)
        {
            var hits = new[] { rebased.Contains(c), declined.Contains(c), pending.Contains(c) }.Count(x => x);
            Assert.True(hits <= 1, $"{c} 同时出现在多个去处，判据自相矛盾");
        }

        // 三份名单都不许留死条目：集合被移出导出清单之后，留着的那条会让人以为
        // 「这个看过了」，实际它早就不在扫描范围里。
        var surface = withUrlFields.ToHashSet(StringComparer.Ordinal);
        var stale = rebased.Concat(declined).Concat(pending)
            .Where(c => !surface.Contains(c))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        Assert.True(stale.Count == 0,
            "下列条目已经扫不到了（集合不再导出，或模型上的地址字段被改名），请删除：\n  "
            + string.Join("\n  ", stale));
    }

    /// <summary>
    /// 「还没想清楚」那一栏是棘轮：只许缩小。
    ///
    /// 没有这条，PendingSurvey 就退化成兜底口袋——新增的资产集合往里一塞，
    /// 反向闸照样绿，而 DS33 要挡的正是这种静默。
    /// </summary>
    [Fact]
    public void 待定名单只许缩小()
    {
        // 2026-08-27 落地时 14 条；同日 +1 —— image_assets 从「要改写」撤回到这里
        // （同一集合混着本站生成图与外部图床直链，没有可信的行内证据分辨）。
        // 往上调基线必须像这样写明是哪一条、为什么；只减不增是常态。
        const int Baseline = 15;
        Assert.True(DataSyncAssetUrls.PendingSurveyReasons.Count <= Baseline,
            $"PendingSurvey 涨到了 {DataSyncAssetUrls.PendingSurveyReasons.Count} 条（基线 {Baseline}）："
            + "新增的资产集合要么当场登记改写，要么写明为什么不改，不许挂进待定栏。"
            + "清空了条目请把基线一起调小。");

        var blank = DataSyncAssetUrls.PendingSurveyReasons
            .Concat(DataSyncAssetUrls.NotRebasedReasons)
            .Where(kv => string.IsNullOrWhiteSpace(kv.Value))
            .Select(kv => kv.Key)
            .ToList();
        Assert.True(blank.Count == 0, "下列集合交代了却没写理由：" + string.Join("、", blank));
    }

    [Fact]
    public void 登记的脱敏字段必须在实体顶层真实存在()
    {
        // 上一条守卫只会追问「像凭据的字段有没有被交代」，交代的方式之一是登记脱敏——
        // 但它从不检查登记的那个名字**是否真的存在**。于是 automation_rules 登记了
        // WebhookUrl / WebhookSecret，看着已经处理过，实际那两个字段在 Actions[] 里，
        // 顶层根本没有，脱敏是一次空转（predicate-and-wiring-discipline 形状 8：
        // 拿一份不成立的声明当成证据）。这条把「登记了」和「登记到了实处」分开。
        var collectionToType = ReadCollectionTypeMap();
        var propsByType = ReadModelProperties();

        var phantom = new List<string>();
        var checkedAny = false;
        foreach (var collection in DataSyncScope.AllExportableCollections.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!DataSyncScope.TryResolve(collection, out var resolved) || resolved is null) continue;
            if (resolved.RedactFields.Count == 0) continue;
            if (!collectionToType.TryGetValue(collection, out var typeName)) continue;
            if (!propsByType.TryGetValue(typeName, out var properties)) continue;
            checkedAny = true;
            foreach (var field in resolved.RedactFields)
            {
                if (!properties.ContainsKey(field)) phantom.Add($"{collection}.{field}（实体 {typeName}）");
            }
        }

        Assert.True(checkedAny, "一个带脱敏字段的集合都没解析到，这条守卫在空跑");
        Assert.True(phantom.Count == 0,
            "下列脱敏字段在对应实体的顶层不存在，脱敏是空转：\n  "
            + string.Join("\n  ", phantom)
            + "\n（字段改名了 -> 改这里的登记；字段本来就在嵌套结构里 -> 脱敏器覆盖不到，整个集合排除）");
    }

    /// <summary>
    /// 从声明类型里剥出可能的模型类型名：`List&lt;WorkflowVariable&gt;` -> WorkflowVariable，
    /// `WorkflowSettings?` -> WorkflowSettings。剥不出（是 string/int/Dictionary 之类）就返回 null。
    /// </summary>
    private static string? StripToModelTypeName(string declaredType)
    {
        var t = declaredType.Trim().TrimEnd('?');
        var generic = Regex.Match(t, @"^(?:List|IList|IReadOnlyList|ICollection|IEnumerable|HashSet)<(.+)>$");
        if (generic.Success) t = generic.Groups[1].Value.Trim().TrimEnd('?');
        // Dictionary 的值类型也可能是模型，但键值两段要分开取，这里只取值那一段。
        var dict = Regex.Match(t, @"^(?:Dictionary|IDictionary)<[^,]+,\s*(.+)>$");
        if (dict.Success) t = dict.Groups[1].Value.Trim().TrimEnd('?');
        if (t.Contains('<', StringComparison.Ordinal)) return null;
        t = t.Split('.').Last();
        return Regex.IsMatch(t, @"^[A-Z][A-Za-z0-9_]*$") ? t : null;
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

    /// <summary>实体类型名 -> （公开属性名 -> 声明类型）。声明类型用来往下走一层嵌套。</summary>
    private static IReadOnlyDictionary<string, Dictionary<string, string>> ReadModelProperties()
    {
        var root = Path.Combine(LocateSrcRoot(), "PrdAgent.Core", "Models");
        var result = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
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
                    : result[decl.Groups[1].Value] = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (Match prop in Regex.Matches(body, @"public\s+([A-Za-z0-9_<>?\[\],\s]+?)\s+([A-Za-z0-9_]+)\s*\{\s*get;"))
                {
                    bucket[prop.Groups[2].Value] = prop.Groups[1].Value.Trim();
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
    public void 非字符串字段清成null而不是空串()
    {
        // appsettings 里既有字符串密钥，也有 bool? 的开关（本站的对外同步开关、信任名单）。
        // 一律写空串会把 bool? 变成字符串，目标站反序列化当场炸——脱敏不该顺手改坏文档结构。
        Assert.True(DataSyncScope.TryResolve("appsettings", out var settings));
        var doc = new BsonDocument
        {
            { "_id", "global" },
            { "DataSyncProviderEnabled", true },
            { "DataSyncAllowedConsumerOrigins", "https://a.example.com" },
        };

        var cleared = DataSyncRedactor.Redact(doc, settings);

        Assert.Contains("DataSyncProviderEnabled", cleared);
        Assert.True(doc["DataSyncProviderEnabled"].IsBsonNull);
        Assert.Equal("", doc["DataSyncAllowedConsumerOrigins"].AsString);
    }

    /// <summary>
    /// 救场开关在共享库上照做，但必须把影响面说出来。
    ///
    /// CDS 同项目所有分支共用一个 Mongo，所以这个开关改的是全库唯一那一份管理员。
    /// 上一版据此直接跳过分支预览——而救场开关恰恰只在 CDS 上才用得着，跳过等于
    /// 把唯一的钥匙锁在门里（2026-08-21 用户明确：CDS 上没有生产，全是测试环境）。
    /// 现在改为照做 + 打印影响面，这条守卫钉住「不许再退回静默跳过」。
    /// </summary>
    [Fact]
    public void 救场开关在分支预览上照做但要说清影响面()
    {
        var source = ReadInfrastructureSource("Database", "DatabaseInitializer.cs");
        var body = source[source.IndexOf("private async Task MaybeForceResetAdminAsync", StringComparison.Ordinal)..];
        body = body[..body.IndexOf("\n    private ", StringComparison.Ordinal)];

        var gateAt = body.IndexOf("IsCdsBranchPreview", StringComparison.Ordinal);
        Assert.True(gateAt >= 0, "分支预览的判定整个没了——影响面提示也就没了");

        // 判定分支里只许打印，不许 return：一 return 就退回「钥匙锁在门里」。
        var branch = body[gateAt..];
        var branchEnd = branch.IndexOf("\n        }", StringComparison.Ordinal);
        Assert.True(branchEnd > 0, "找不到分支预览判定的花括号了，这条守卫的前提已变");
        Assert.DoesNotContain("return;", branch[..branchEnd]);

        // 说清影响面：共库的其它部署会跟着变。
        Assert.Contains("共享库", branch[..branchEnd], StringComparison.Ordinal);

        // 一次性仍由 marker 保证，且必须排在改用户之前。
        var markerReadAt = body.IndexOf("DeploymentMarkers.Find", StringComparison.Ordinal);
        var userWriteAt = body.IndexOf("_db.Users.UpdateOneAsync", StringComparison.Ordinal);
        Assert.True(markerReadAt > 0 && userWriteAt > markerReadAt,
            "一次性标记必须在改用户之前读，否则每次重启都会把口令改回去");
    }

    /// <summary>
    /// 「关掉」的写法不许漏。
    ///
    /// 上一版枚举了三种 false 的大小写却漏了 `OFF` / `No`，于是运维写
    /// `MAP_ADMIN_FORCE_RESET=OFF` 想关掉它，反而被当成一个**新的一次性令牌**：
    /// 下一次权威部署启动会据此把选中的管理员重新启用、口令换成配置里的初始凭据。
    /// 判据比它承诺的范围窄（形状 1），而这一档翻转的后果是生产管理员口令被改。
    /// </summary>
    [Theory]
    [InlineData("0")]
    [InlineData("false")]
    [InlineData("False")]
    [InlineData("FALSE")]
    [InlineData("no")]
    [InlineData("No")]
    [InlineData("NO")]
    [InlineData("off")]
    [InlineData("Off")]
    [InlineData("OFF")]
    [InlineData("  OFF  ")]
    [InlineData("")]
    [InlineData(null)]
    public void 救场开关的关值不分大小写(string? raw)
    {
        Assert.True(DatabaseInitializer.IsForceResetDisabled(raw), $"「{raw}」应当被认成关掉");
    }

    /// <summary>真正的一次性令牌不能被误判成关。</summary>
    [Theory]
    [InlineData("1")]
    [InlineData("true")]
    [InlineData("TRUE")]
    [InlineData("2026-08-21-救场")]
    [InlineData("offline")]     // 前缀撞上 off，但它不是关
    [InlineData("no-really")]   // 前缀撞上 no，同上
    public void 救场开关的令牌值不会被误判成关(string raw)
    {
        Assert.False(DatabaseInitializer.IsForceResetDisabled(raw), $"「{raw}」是令牌，不是关");
    }

    private static string ReadInfrastructureSource(params string[] segments)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src", "PrdAgent.Infrastructure")))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var parts = new List<string> { dir!.FullName, "src", "PrdAgent.Infrastructure" };
        parts.AddRange(segments);
        var path = Path.Combine(parts.ToArray());
        Assert.True(File.Exists(path), $"守卫要扫的源码不在预期位置：{path}");
        return File.ReadAllText(path);
    }

    /// <summary>
    /// 覆盖写是整份替换，所以每一个脱敏字段都必须从目标站原文档接回来。
    ///
    /// 脱敏说的是「源站的值不能出门」，不是「目标站的值该被抹掉」。少接回来一个：
    /// 凭据类会把目标站本来能用的密钥清空；策略类更糟——清空即回到默认，而默认往往是
    /// 放开的（PasswordLoginDisabled 清空 = 口令登录重新打开，同一批还带着口令散列）。
    /// </summary>
    [Fact]
    public void 脱敏字段必须逐个从目标站接回来()
    {
        foreach (var collection in DataSyncScope.Groups.SelectMany(g => g.Collections))
        {
            foreach (var redacted in collection.RedactFields)
            {
                Assert.True(
                    collection.FieldsCarriedFromTarget.Contains(redacted, StringComparer.Ordinal),
                    $"{collection.Name}.{redacted} 被脱敏却没有从目标站接回来："
                    + "覆盖写会把目标站自己的值顶成空。");
            }
        }
    }

    /// <summary>
    /// 口令登录开关是这条规则最贵的那一格，单独钉住：它是 fail-open，
    /// 清空的后果是目标站特意关掉的口令登录被一次同步悄悄打开。
    /// </summary>
    [Fact]
    public void 口令登录开关不许被同步顶成默认值()
    {
        var appsettings = DataSyncScope.Groups.SelectMany(g => g.Collections)
            .Single(c => c.Name == "appsettings");
        Assert.Contains("PasswordLoginDisabled", appsettings.RedactFields);
        Assert.Contains("PasswordLoginDisabled", appsettings.FieldsCarriedFromTarget);
    }

    /// <summary>
    /// 接回字段与投影必须取同一个来源。投影少投一个字段，接回时会把目标站那份
    /// 当成「不存在」而删掉——判据分裂成两处的经典后果（形状 3）。
    /// </summary>
    [Fact]
    public void 接回字段与投影取同一个来源()
    {
        var worker = ReadApiServiceSource("DataSync", "DataSyncRunWorker.cs");
        // 从**定义**切，不是从第一次出现（那是调用点）——形状 6：取错了那个值。
        var body = worker[worker.IndexOf(
            "private static ProjectionDefinition<BsonDocument> BuildExistingProjection",
            StringComparison.Ordinal)..];
        body = body[..body.IndexOf("\n    }", StringComparison.Ordinal)];
        Assert.Contains("FieldsCarriedFromTarget", body);
        Assert.DoesNotContain("collection.PreserveFields", body);
    }

    /// <summary>
    /// 票据查询必须有索引，且过期票要能被清掉。两条匿名协议请求都按散列查这张表，
    /// 而它们发生在鉴权之前——没索引等于谁都能让源站做全表扫描。
    /// </summary>
    [Fact]
    public void 授权票的散列查询必须登记索引()
    {
        var script = ReadRepoFile("scripts", "mongodb-indexes.js");

        // 断言必须**限定在这两个集合自己的段落里**。整份脚本里别的集合也有
        // "CreatedAt": -1 这类索引，不限定的话我的断言会被别人的索引满足——
        // 判据读到了一个真实存在的值，只是不是我要的那个（形状 6）。
        static string Section(string script, string collection)
        {
            var begin = script.IndexOf($"// collection: {collection}", StringComparison.Ordinal);
            var end = script.IndexOf($"// end collection: {collection}", StringComparison.Ordinal);
            Assert.True(begin >= 0 && end > begin,
                $"{collection} 的索引段落不在脚本里（段落标记也别改名，守卫按它定位）");
            return script[begin..end];
        }

        var grants = Section(script, "data_sync_grants");
        Assert.Contains("db.data_sync_grants.createIndex", grants);
        Assert.Contains("\"CodeHash\": 1", grants);
        Assert.Contains("\"ExportTokenHash\": 1", grants);

        var runs = Section(script, "data_sync_runs");
        // 收尸扫描每个部署每分钟跑一次，表只增不删，且分支预览与生产共用同一个库。
        Assert.Contains("db.data_sync_runs.createIndex", runs);
        Assert.Contains("\"Status\": 1, \"UpdatedAt\": 1", runs);
        // 同步历史页无过滤、按 CreatedAt 倒序取 20 条——没索引就是每次打开都全表扫 + 内存排序。
        Assert.Contains("\"CreatedAt\": -1", runs);

        var worker = ReadApiServiceSource("DataSync", "DataSyncRunWorker.cs");
        Assert.Contains("SweepRetiredGrantsAsync", worker);
        // 只定义不调用就是建了一半（形状 2）。
        Assert.True(
            worker.Split("SweepRetiredGrantsAsync").Length - 1 >= 2,
            "SweepRetiredGrantsAsync 定义了却没有人调用");
    }

    /// <summary>
    /// 慢库上一页就能跑过收尸判据的 15 分钟，所以整段写入期间必须一直有心跳；
    /// 同时本进程对 Run 的写入要带「它还是 running」，否则被收尸之后
    /// 原 worker 会把已经落好的 failed 顶回 succeeded。
    ///
    /// 判据从「替换循环里有 HeartbeatAsync」改成了「整段写入被独立心跳包住」：
    /// 循环内补跳的节奏依赖循环转到下一圈，而一次 InsertManyAsync 或单条
    /// ReplaceOneAsync 卡住时它一次也跳不出来——那正是最需要心跳的时刻。
    /// 保护的不变量没变，换的是能真正覆盖它的机制。
    /// </summary>
    [Fact]
    public void 活着的同步不许被判成没心跳()
    {
        var worker = ReadApiServiceSource("DataSync", "DataSyncRunWorker.cs");
        var writes = worker[worker.IndexOf("await WriteWithHeartbeatAsync(db, run, async () =>", StringComparison.Ordinal)..];
        writes = writes[..writes.IndexOf("progress.Inserted", StringComparison.Ordinal)];
        // 插入与逐条替换都必须落在这个心跳作用域里面。
        Assert.Contains("InsertManyAsync", writes);
        Assert.Contains("foreach (var doc in decision.ToReplace)", writes);
        // 心跳任务按墙钟自己转，不等写入返回。
        var scope = worker[worker.IndexOf("private async Task WriteWithHeartbeatAsync", StringComparison.Ordinal)..];
        scope = scope[..scope.IndexOf("private async Task<bool> HeartbeatAsync", StringComparison.Ordinal)];
        Assert.Contains("await Task.Delay(HeartbeatInterval, finished.Token)", scope);
        Assert.Contains("HeartbeatAsync(db, run, ct)", scope);

        Assert.Contains("private static FilterDefinition<DataSyncRun> StillRunning", worker);
        var save = worker[worker.IndexOf("private static async Task SaveProgressAsync", StringComparison.Ordinal)..];
        save = save[..save.IndexOf("\n    }", StringComparison.Ordinal)];
        Assert.Contains("StillRunning(run)", save);
    }

    /// <summary>
    /// 落进 Run.Error 的文案会原样显示给管理员。自己抛的协议错逐字保留（它写给人看），
    /// 驱动 / TLS / JSON 异常不落原文——里面有服务器地址、库名、索引名。
    /// </summary>
    [Fact]
    public void 未预期异常不把原文落进同步记录()
    {
        var worker = ReadApiServiceSource("DataSync", "DataSyncRunWorker.cs");
        Assert.DoesNotContain("FailAsync(db, run, ex.Message", worker);
        Assert.Contains("DescribeFailure(ex, run.Id)", worker);
        Assert.Contains("诊断号", worker);
    }

    private static string ReadApiServiceSource(params string[] segments)
    {
        var parts = new List<string> { "src", "PrdAgent.Api", "Services" };
        parts.AddRange(segments);
        return ReadRepoFile(new[] { "prd-api" }.Concat(parts).ToArray());
    }

    private static string ReadRepoFile(params string[] segments)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var parts = new List<string> { dir!.FullName };
        parts.AddRange(segments);
        var path = Path.Combine(parts.ToArray());
        Assert.True(File.Exists(path), $"守卫要扫的文件不在预期位置：{path}");
        return File.ReadAllText(path);
    }

    /// <summary>
    /// SSO 配置必须整组留在目标站。
    ///
    /// 只留密钥和回调、让开关与客户端标识跟着源站走，会拼出一份两边都不成立的配置：
    /// 目标站留着自己的 secret 和白名单却收到源站的 clientId，本来能用的登录当场坏掉；
    /// 反过来源站开着的开关会把这份半拼半凑的配置直接点亮。
    ///
    /// 判据按前缀扫，不是手抄一份清单——日后 AppSettings 新增一个 SSO 字段而忘了登记，
    /// 这条会红（形状 1：判据要覆盖它该管的整个范围，不是我当时想到的那几个）。
    /// </summary>
    [Fact]
    public void SSO配置必须整组留在目标站()
    {
        var appsettings = DataSyncScope.Groups.SelectMany(g => g.Collections)
            .Single(c => c.Name == "appsettings");
        var carried = appsettings.FieldsCarriedFromTarget;

        var ssoFields = typeof(AppSettings).GetProperties()
            .Select(p => p.Name)
            .Where(n => n.Contains("Sso", StringComparison.Ordinal))
            .ToList();

        Assert.NotEmpty(ssoFields);
        var missing = ssoFields.Where(f => !carried.Contains(f, StringComparer.Ordinal)).ToList();
        Assert.True(missing.Count == 0,
            "这些 SSO 字段会被源站的值顶掉，拼出一份两边都不成立的配置："
            + string.Join("、", missing));
    }

    /// <summary>
    /// 「谁有权访问某个东西」的记录不许导出。
    ///
    /// 这类表存的不是内容，是**运行时授权态**：一行 `拥有者 + 资源 id`，而消费它的接口
    /// 只要匹配到一行就放行。跟 users 一起搬过去之后，接同一个上游的目标站拿着这些
    /// 资源 id 就能读到源站的东西——白名单本来就是为了挡住这一类。
    ///
    /// 判据按实体类名后缀扫（`*Ownership`），不是手抄一份集合名清单：手抄的那份只覆盖
    /// 我当时想到的，日后再加一张同类表照样漏。这条只认名字这一种信号，认不出所有
    /// 授权态表——「这张表是不是授权凭据」仍然要逐个人判，但至少同名的那类跑不掉。
    /// </summary>
    [Fact]
    public void 授权归属类的表不许导出()
    {
        var exportable = DataSyncScope.Groups
            .SelectMany(g => g.Collections)
            .Select(c => c.Name)
            .ToHashSet(StringComparer.Ordinal);

        // 复用既有的「集合名 -> 实体类型名」解析（同一个来源，避免判据分裂）。
        var typeMap = ReadCollectionTypeMap();
        var offenders = typeMap
            .Where(kv => kv.Value.EndsWith("Ownership", StringComparison.Ordinal))
            .Where(kv => exportable.Contains(kv.Key))
            .Select(kv => $"{kv.Key}（{kv.Value}）")
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();

        Assert.True(offenders.Count == 0,
            "这些表存的是「谁有权访问什么」，导出等于连访问权一起复制，必须放进 Excluded："
            + string.Join("、", offenders));
    }

    [Fact]
    public void 本站身份与信任名单必须留在本站()
    {
        // MapInstanceId 是本实例的稳定标识（配对协议用它认「你是哪台」）；
        // 对外同步开关与允许名单是「本站信任谁」。这些跟着数据搬过去，
        // 会让两台机器自报同一个身份，并且把源站的信任关系强加给目标站。
        //
        // PasswordLoginDisabled 是同一类里最凶的一个：它是「本站怎么登录」的安全开关，
        // 而与它配套的 SSO 密钥、回跳地址恰恰在上面被清空了。源站关了口令登录、目标站
        // 又没有可用的 SSO，同步完就是**除了 ROOT 破窗账户谁也进不去**——一个以
        // 「同步完直接能用」为目标的功能，把目标站锁死了。
        Assert.True(DataSyncScope.TryResolve("appsettings", out var settings));
        foreach (var field in new[]
        {
            "DataSyncProviderEnabled", "DataSyncAllowedConsumerOrigins", "PasswordLoginDisabled",
        })
        {
            Assert.True(settings.RedactFields.Contains(field, StringComparer.Ordinal),
                $"appsettings.{field} 是本站自有的，不能跟着同步过去");
        }

        // MapInstanceId 属于同一族，但处置方式必须是**保留**而不是清空。
        // 清空看起来也拦住了源站的值，代价却是把目标站自己的 ID 一起抹掉：
        // 下次启动重新生成一个新的，而已经配好对的邻居仍按旧 ID 找本站，配对当场断。
        Assert.Contains("MapInstanceId", settings.PreserveFields);
        Assert.DoesNotContain("MapInstanceId", settings.RedactFields);

        // 「登录还进不进得来」这件事必须自洽：只要 SSO 的必要字段被清空，
        // 关闭口令登录的开关就不能跟着过去，否则两条路同时断。
        var ssoCleared = new[] { "MiduoSsoAppSecret", "MiduoSsoRedirectUri" }
            .All(f => settings.RedactFields.Contains(f, StringComparer.Ordinal));
        if (ssoCleared)
        {
            Assert.Contains("PasswordLoginDisabled", settings.RedactFields);
        }
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

    [Fact]
    public void 试跑转正必须至多一次_且不重新问源站要范围()
    {
        // 「一次授权 = 一条 Run」原来把试跑也算成一次消耗，于是真搬要人再点一次同意——
        // 两次真实迁移都卡死在这里。放开之后，三条边界一条都不能松，
        // 否则它就退化成「一次批准可以反复用」，和长期凭据没区别。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        var source = File.ReadAllText(path);

        var promote = Regex.Match(
            source,
            @"HttpPost\(""runs/\{id\}/promote""\)(?<body>.*?)(?=
    \[HttpGet)",
            RegexOptions.Singleline);
        Assert.True(promote.Success, "找不到转正端点了，这条守卫的前提已变");
        var body = promote.Groups["body"].Value;
        var flat = Regex.Replace(body, @"\s+", " ");

        // 1) 至多一次：唯一性必须由数据库的条件更新保证，不能只在内存里判一下
        //    （两个标签页同时点会各自读到「还没转正」）。
        Assert.Contains("Filter.Eq(x => x.PromotedToRunId, null)", flat, StringComparison.Ordinal);
        Assert.Contains(".Set(x => x.PromotedToRunId, child.Id)", flat, StringComparison.Ordinal);
        Assert.Contains("claimed.ModifiedCount == 0", flat, StringComparison.Ordinal);

        // 2) 范围照抄，**这一步根本不联系源站**。判据取「端点里没有任何出站调用」
        //    而不是「没出现 manifest 这个词」——后者会被 PlannedManifest 这个
        //    正是我们要照抄的字段命中，是一条自相矛盾的断言（第一版就这么红的）。
        Assert.DoesNotContain("_httpClientFactory", body, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/instance-sync/export", body, StringComparison.Ordinal);
        foreach (var copied in new[] { "PlannedCollections =", "PlannedManifest =", "Collections =" })
        {
            Assert.Contains(copied, flat, StringComparison.Ordinal);
        }

        // 3) 只有跑完并且成功的试跑才配转正。少了这一条，一次失败的、甚至正在跑的
        //    试跑也能转正，跑的就是一份没被确认过的清单。
        Assert.Contains("!run.DryRun || run.Status != \"succeeded\"", flat, StringComparison.Ordinal);

        // 4) 票据不续命：过期就要求重新授权，不许在这里重签。
        Assert.Contains("_vault.GetExportToken(run.Id)", flat, StringComparison.Ordinal);
        Assert.Contains("ExportTokenExpiresAt = run.ExportTokenExpiresAt", flat, StringComparison.Ordinal);

        // 5) 转正请求里不许有 DryRun 开关——给了它，调用方就能把唯一那次转正
        //    又变成一次试跑，白白吃掉机会。
        var promoteRequest = Regex.Match(
            source, @"class DataSyncPromoteRequest\s*\{(?<body>[^}]*)\}", RegexOptions.Singleline);
        Assert.True(promoteRequest.Success, "找不到转正请求类型了");
        Assert.DoesNotContain("DryRun", promoteRequest.Groups["body"].Value, StringComparison.Ordinal);
    }

    [Fact]
    public void 试跑成功不许交还票据_真跑和失败必须交还()
    {
        // 票留着，「确认无误，开始真的搬」才点得动。这一条删掉之后转正端点会一直报
        // 「授权已过期」，而那句话听起来像环境问题，没人会想到是这里把票还回去了。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Services", "DataSync", "DataSyncRunWorker.cs");
        var worker = File.ReadAllText(path);
        var flat = Regex.Replace(worker, @"\s+", " ");

        Assert.Contains("if (run.DryRun && finished.ModifiedCount > 0)", flat, StringComparison.Ordinal);
        // 失败那条路径照旧立刻交还——试跑没成功就没有可确认的清单，票不该留着。
        Assert.Contains("_vault.Forget(run.Id);", worker, StringComparison.Ordinal);
        Assert.Contains("ReturnExportTokenAsync", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void 资产地址改写必须接在入库之前()
    {
        // 这是一条**接线**守卫，不是行为守卫：把 RebaseIncoming 整个删掉，
        // DataSyncAssetUrlsTests 全绿、编译也过——坏掉的只是「没人调它」，
        // 而后果要等一次真迁移之后才看得见（图片全指回源站）。
        //
        // 顺序同样要钉：先入库再回头批量改的话，中间那一段时间界面上全是死链，
        // 崩在中间还没人知道改到哪了。
        var workerPath = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Services", "DataSync", "DataSyncRunWorker.cs");
        var worker = File.ReadAllText(workerPath);

        var rebaseAt = worker.IndexOf("DataSyncAssetUrls.RebaseIncoming(", StringComparison.Ordinal);
        Assert.True(rebaseAt >= 0, "同步执行端没有任何一处调用资产地址改写，DS1 的修复没接上线");

        // 锚在**真正写库的那两句**上，不是锚在 Decide 上。
        //
        // 上一版写的是 `rebaseAt < decideAt`。Decide 只是把这一页在内存里分成
        // 「插 / 替 / 跳过」三堆，一个字节都没落库——拿它当「入库」的替身，等于用一个
        // 不是那件事的东西去证明那件事（形状 6）。代价很实在：改写为了满足这条守卫
        // 必须排在分堆之前，于是**整页**文档都被改写并计数，其中被判成跳过的那些
        // 改完就丢，界面却把它们算进「已改写 N 条」（Codex review P2）。
        var insertAt = worker.IndexOf("InsertManyAsync(", StringComparison.Ordinal);
        var replaceAt = worker.IndexOf("ReplaceOneAsync(", StringComparison.Ordinal);
        Assert.True(insertAt >= 0, "找不到插入写库那一句了，这条守卫的前提已变");
        Assert.True(replaceAt >= 0, "找不到覆盖写库那一句了，这条守卫的前提已变");
        Assert.True(rebaseAt < insertAt && rebaseAt < replaceAt,
            "资产地址改写排在了写库之后：中间那段时间界面上的图全是指回源站的死链");

        // 而且只改**这一批真会写进去的**。不覆盖模式下目标站已有的那些会被判成跳过、
        // 一个字节都不入库，把它们一起数进「已改写」就是把没做的事记成做过的。
        var decideAt = worker.IndexOf("DataSyncApply.Decide(", StringComparison.Ordinal);
        Assert.True(decideAt >= 0, "找不到落库决策了，这条守卫的前提已变");
        Assert.True(decideAt < rebaseAt, "改写排在了分堆之前：那样整页都会被改写并计数");
        var rebaseCallEnd = worker.IndexOf(')', rebaseAt);
        Assert.True(rebaseCallEnd > rebaseAt, "读不出改写那一句的参数，守卫已失效");
        var rebaseArgs = worker[rebaseAt..rebaseCallEnd];
        Assert.DoesNotContain("RebaseIncoming(documents", rebaseArgs, StringComparison.Ordinal);
        Assert.Contains("decision.ToInsert", worker, StringComparison.Ordinal);
        Assert.Contains("decision.ToReplace", worker, StringComparison.Ordinal);

        // 三个数字都要落进进度，界面才说得出「改了几条 / 还有几条没救 / 还有几条本来就是
        // 相对路径」。少送第三个就是 DS30 那种彻底静默：本地磁盘存附件的源站，
        // 前两个数恒为 0，附件卡整个不出现。
        Assert.Contains("progress.AssetUrlsRebased +=", worker, StringComparison.Ordinal);
        Assert.Contains("progress.AssetUrlsUnresolved +=", worker, StringComparison.Ordinal);
        Assert.Contains("progress.AssetUrlsRelative +=", worker, StringComparison.Ordinal);

        // 并且真的送到前端。只算不送等于没算。
        var controllerPath = Path.Combine(
            LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        var controller = File.ReadAllText(controllerPath);
        Assert.Contains("assetUrlsRebased = kv.Value.AssetUrlsRebased", controller, StringComparison.Ordinal);
        Assert.Contains("assetUrlsUnresolved = kv.Value.AssetUrlsUnresolved", controller, StringComparison.Ordinal);
        Assert.Contains("assetUrlsRelative = kv.Value.AssetUrlsRelative", controller, StringComparison.Ordinal);
    }

    /// <summary>
    /// 撞唯一索引被剔掉的那几条，改写计数要按**同一批下标**回冲（DS34）。
    ///
    /// 改写发生在内存里、写库之前；插入撞索引会被整条剔除，而计数在那之前就加过了。
    /// 不回冲的话，「已改写 N 条」里混着从没落库的几条。
    ///
    /// 这条同时钉住回冲成立的**前提**：`willWrite` 必须先插入后替换拼起来，
    /// 插入侧的下标才等于 `rebase.ByDocument` 的下标。顺序一反，回冲就冲到别人头上——
    /// 那比不回冲更糟，而且照样全绿。
    /// </summary>
    [Fact]
    public void 没落库的那几条要从改写计数里回冲()
    {
        var worker = ReadApiServiceSource("DataSync", "DataSyncRunWorker.cs");

        var insertAt = worker.IndexOf("willWrite.AddRange(decision.ToInsert);", StringComparison.Ordinal);
        var replaceAt = worker.IndexOf("willWrite.AddRange(decision.ToReplace);", StringComparison.Ordinal);
        Assert.True(insertAt >= 0 && replaceAt > insertAt,
            "willWrite 不再是「先插入、后替换」拼的，按插入下标回冲会冲到替换那一批身上");

        // 逐文档结果要真的被用上：只算不冲，等于 DataSyncAssetUrls 那半白做了（形状 2）。
        Assert.Contains("rebase.ByDocument[idx]", worker, StringComparison.Ordinal);
        foreach (var counter in new[] { "AssetUrlsRebased -=", "AssetUrlsUnresolved -=", "AssetUrlsRelative -=" })
        {
            Assert.Contains($"progress.{counter}", worker, StringComparison.Ordinal);
        }

        // 回冲用的下标必须和剔除用的是同一份。各取各的就是判据分裂（形状 3）：
        // 两处迟早对不上，而对不上的表现只是一个数字偏了几条，没人会发现。
        var branch = worker[worker.IndexOf("var failedIndexes =", StringComparison.Ordinal)..];
        branch = branch[..branch.IndexOf("SurvivingInserts", StringComparison.Ordinal)];
        Assert.Contains("foreach (var idx in failedIndexes)", branch, StringComparison.Ordinal);
    }

    [Fact]
    public void 存储实现必须回填对象_key()
    {
        // StoredAsset.Key 是可空带默认值的——「忘了传」编译不会报错，
        // 而后果是附件没有 key、只能靠猜 URL（形状 2）。
        var root = Path.Combine(LocateSrcRoot(), "PrdAgent.Infrastructure", "Services", "AssetStorage");
        foreach (var file in new[] { "CloudflareR2Storage.cs", "TencentCosStorage.cs", "LocalAssetStorage.cs" })
        {
            var source = File.ReadAllText(Path.Combine(root, file));
            var save = Regex.Match(
                source,
                @"public async Task<StoredAsset> SaveAsync\((?<body>.*?)
    \}",
                RegexOptions.Singleline);
            Assert.True(save.Success, $"{file} 里找不到 SaveAsync 了，这条守卫的前提已变");
            Assert.Matches(
                new Regex(@"return new StoredAsset\([^)]*,\s*key\)"),
                save.Groups["body"].Value);
        }
    }

    [Fact]
    public void 附件落库时必须存下对象_key()
    {
        // 只存绝对 Url 的话，换桶 / 换公网域名 / 搬机器之后地址全部指回原处（DS1），
        // 而且没有任何东西能把它算回来。每一处建 Attachment 的地方都要带上 key。
        //
        // ## 这条守卫自己漏过一次（2026-08-27，Codex review 抓到）
        //
        // 上一版有两个口子叠在一起，让 peer-sync 那处漏了整整一轮而一声不吭：
        //
        // 1. 作用域比它要守的规则窄 —— 只扫 PrdAgent.Api，而另一个程序集里也有一处建附件。
        //    「只改被守文件、不碰守卫本身」的改动一路全绿（形状 7）。
        // 2. 判据只认显式类型的对象初始化式，认不出目标类型 new 的写法。
        //    换个等价写法就绕过去了（形状 1）。
        //
        // 现在扫整个 src 树，两种写法都认，并且先剥掉注释再扫。
        var srcRoot = LocateSrcRoot();
        var offenders = new List<string>();
        var found = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            var source = StripLineComments(File.ReadAllText(file));
            foreach (var body in EnumerateAttachmentInitializers(source))
            {
                // 只管那些从 StoredAsset 拿地址的：别处（如外部视频直链）本来就没有 key。
                if (!body.Contains("Url = stored.Url", StringComparison.Ordinal)) continue;
                var name = Path.GetFileName(file);
                found[name] = found.GetValueOrDefault(name) + 1;
                if (!body.Contains("StorageKey", StringComparison.Ordinal))
                {
                    offenders.Add(name);
                }
            }
        }

        // 站点清单必须**逐一对上**，不是「够多就行」。
        //
        // 上一版用的是 `扫到的处数 >= 6`。那个阈值挡不住「悄悄少一处」：把某个工厂方法
        // 从表达式体改成块体（`return new() { ... };` —— 一样合法的写法），判据就认不出它了，
        // 同时把那处的 StorageKey 去掉，处数从 9 掉到 8，仍然 >= 6，于是这个真实回归一路绿。
        //
        // 所以判据不再问「够不够多」，改问「是不是正好这几处」：少一处、多一处都红。
        // 少了 = 要么真被删了、要么判据认不出它的新写法，两种都必须有人看一眼；
        // 多了 = 新增了建附件的地方，必须显式登记进来（顺带被这条守卫盯上）。
        //
        // 这是第三次在同一条判据上被 review 挑出「换个等价写法就绕过去」。
        // 前两次的应对都是给正则加一种写法，第三次不再那么做——按 AGENTS.md §5.5，
        // 同一个文本判据反复被要求加格式时，正解是换成有限枚举，而不是加第四个正则。
        var expected = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["AttachmentsController.cs"] = 1,
            ["DocumentRecordingArchiveWorker.cs"] = 1,
            ["DocumentStoreController.cs"] = 2,
            ["DocumentStoreSyncResource.cs"] = 1,
            ["ReportAgentController.cs"] = 3,
            ["ReviewAgentController.cs"] = 1,
        };
        Assert.True(
            found.Count == expected.Count && found.All(kv => expected.GetValueOrDefault(kv.Key) == kv.Value),
            "从 StoredAsset 建附件的站点清单和登记的对不上。\n"
            + $"登记：{Render(expected)}\n实际：{Render(found)}\n"
            + "少了就去看那处是被删了还是判据认不出它的新写法；多了就把新站点登记进来。");
        Assert.True(offenders.Count == 0, $"这些地方建附件时没有存下对象 key：{string.Join("、", offenders.Distinct())}");

        static string Render(Dictionary<string, int> d)
            => string.Join("、", d.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => $"{kv.Key}×{kv.Value}"));
    }

    /// <summary>
    /// 扫之前先把行注释剥掉 —— 判据要读<b>真正生效的代码</b>，不是读讲代码的话。
    /// </summary>
    /// <remarks>
    /// 这不是洁癖：给 peer-sync 那处补 key 时，我在代码注释里举了这条判据认的写法当例子，
    /// 判据把注释当代码扫，捕获的初始化块截在注释里那对花括号上，
    /// 于是<b>一处已经改好的代码被报成违规</b>。一条会被自己要防的东西骗到的判据，
    /// 说明它读的不是生效的那个值。字符串字面量里的双斜杠极少出现在这类初始化块附近，
    /// 为保持判据简单不做处理。
    /// </remarks>
    private static string StripLineComments(string source)
        => Regex.Replace(source, @"//[^\n]*", string.Empty);

    /// <summary>
    /// 建 Attachment 的两种写法都要认：显式类型的对象初始化式，
    /// 以及返回类型为 Attachment 的成员上写的目标类型 new。
    /// 只认前者的话，把工厂方法改成表达式体就能绕过判据。
    /// </summary>
    private static IEnumerable<string> EnumerateAttachmentInitializers(string source)
    {
        foreach (Match m in Regex.Matches(source, @"new\s+Attachment\s*\{(?<body>[^}]*)\}", RegexOptions.Singleline))
            yield return m.Groups["body"].Value;

        foreach (Match m in Regex.Matches(
                     source,
                     @"\bAttachment\s+\w+\s*\([^)]*\)\s*=>\s*new(?:\s+Attachment)?\s*\(?\s*\)?\s*\{(?<body>[^}]*)\}",
                     RegexOptions.Singleline))
            yield return m.Groups["body"].Value;
    }

    /// <summary>
    /// 给同目录的其它守卫用。原来是 private，第二个守卫要用就得复制一份找根目录的逻辑，
    /// 而那是最典型的「判据分裂后各自漂移」。
    /// </summary>
    internal static string LocateSrcRootForTests() => LocateSrcRoot();

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
    public void 源站清单报的事实必须落到Run上并被执行端用起来()
    {
        // 总条数与源站脱敏契约是**只有源站知道**的两件事，清单里送过来、对照表上显示过，
        // 渲染完就丢掉的话下游只能瞎猜。两处都属于「建了一半」——删掉接线不会红：
        //   sourceTotal 字段文档写着「manifest 阶段拿到」，却没有任何一处赋值；
        //   脱敏处理全部按目标站白名单算，只被源站列为敏感的字段就此隐身。
        // 所以这条守卫盯的是接线本身（形状 2），行为对不对由 DataSyncApplyTests 管。
        var planPath = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        var plan = File.ReadAllText(planPath);

        // 固化必须和执行清单在**同一次**条件更新里，否则两者会各自漂移。
        var update = Regex.Match(
            plan,
            @"Builders<DataSyncRun>\.Update\s*\n\s*\.Set\(x => x\.PlannedCollections,(?<body>.*?)cancellationToken: ct\);",
            RegexOptions.Singleline);
        Assert.True(update.Success, "找不到 Plan 落执行清单的那次更新了，这条守卫的前提已变");
        Assert.Contains(".Set(x => x.PlannedManifest,", update.Groups["body"].Value, StringComparison.Ordinal);
        Assert.Contains("SourceTotal = x.Total", plan, StringComparison.Ordinal);
        Assert.Contains("RedactFields = x.RedactFields", plan, StringComparison.Ordinal);

        var workerPath = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Services", "DataSync", "DataSyncRunWorker.cs");
        var worker = File.ReadAllText(workerPath);

        // 执行端真的读了这两样。
        Assert.Contains("progress.SourceTotal = plannedFacts.SourceTotal;", worker, StringComparison.Ordinal);
        // 并集必须在**进 PullCollectionAsync 之前**就换掉，下游三处（投影 / 待补归属 /
        // 接回）才会共用同一份；在里面挑着用就是判据分裂的写法。
        Assert.Contains(
            "PullCollectionAsync(db, run, DataSyncApply.MergeSourceRedactions(collection, run.PlannedManifest)",
            Regex.Replace(worker, @"\s+", " "),
            StringComparison.Ordinal);
    }

    [Fact]
    public void 只有没走到源站那一档才作废在换票之后()
    {
        // 判据是接线而不是行为：把 ForgetVerifier 挪到发请求之前、或者干脆删掉，
        // 编译过、上面那两条 vault 用例也照样绿——坏的是「在哪一步调它」。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        var source = File.ReadAllText(path);

        var callback = Regex.Match(
            source,
            @"HttpPost\(""runs/callback""\)(?<body>.*?)(?=\n    /// <summary>)",
            RegexOptions.Singleline);
        Assert.True(callback.Success, "找不到 runs/callback 了，这条守卫的前提已变");
        var body = callback.Groups["body"].Value;

        // 读用 Peek，不用 Take——一次性由下面那句在确定结果之后落实。
        Assert.Contains("_vault.PeekVerifier(request.State!)", body, StringComparison.Ordinal);
        Assert.DoesNotContain("TakeVerifier", body, StringComparison.Ordinal);

        // 作废必须排在拿到响应**之后**。
        var forgetAt = body.IndexOf("_vault.ForgetVerifier(", StringComparison.Ordinal);
        var responseAt = body.IndexOf("ReadAsStringAsync", StringComparison.Ordinal);
        Assert.True(forgetAt > -1, "换票之后没有任何一处作废 verifier，一次性就没了");
        Assert.True(forgetAt > responseAt, "ForgetVerifier 排在拿到响应之前，等于又回到「开始换票就消耗」");

        // 连不上源站要给一个可被前端识别成「能重试」的专用错误码。
        Assert.Contains("DATA_SYNC_SOURCE_UNREACHABLE", body, StringComparison.Ordinal);
    }

    [Fact]
    public void 回跳地址不许直接用请求的scheme()
    {
        // 真实部署 TLS 终结在反向代理，进程收到明文 http，而本项目没有 UseForwardedHeaders。
        // 直接用 Request.Scheme 就会算出 http://<公网域名>，源站的形状校验只认 https，
        // 授权跳转第一步就被拒——本地全绿、一上真站必炸，是最贵的一类判据错误。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        var source = File.ReadAllText(path);

        var body = source[source.IndexOf("private string SelfOrigin()", StringComparison.Ordinal)..];
        body = body[..body.IndexOf("\n    private ", StringComparison.Ordinal)];

        // 显式配置最优先。
        Assert.Contains("DataSync:SelfOrigin", body, StringComparison.Ordinal);
        // 必须认代理写的转发头，否则 https 永远拼不出来。
        Assert.Contains("X-Forwarded-Proto", body, StringComparison.Ordinal);
        Assert.Contains("X-Forwarded-Host", body, StringComparison.Ordinal);

        // 转发头必须排在裸 Request.Scheme 之前，否则等于没接。
        var forwardedAt = body.IndexOf("X-Forwarded-Host", StringComparison.Ordinal);
        var rawAt = body.IndexOf("Request.Scheme", StringComparison.Ordinal);
        Assert.True(forwardedAt >= 0 && rawAt > forwardedAt,
            "裸 Request.Scheme 排在了转发头之前，反代后面永远算成 http");

        // 刻意不收浏览器传的 X-Client-Base-Url：两次请求只要有一次没带，
        // prepare 与 callback 算出的回跳地址就会不一致，换票以 redirect 不匹配失败。
        Assert.DoesNotContain("X-Client-Base-Url", body, StringComparison.Ordinal);
    }

    [Fact]
    public void 换票这一步不许挂在浏览器连接上()
    {
        // 换票是双方各自改状态的一步：源站收到请求就把授权码原子标成已消费并签出一张
        // 两小时的导出令牌，而本站的 verifier 已经被 TakeVerifier 一次性取走。所以只要
        // 请求发出去了这段就必须跑完——挂在 RequestAborted 上的话，管理员在等待期间
        // 关掉标签页，本站既没存下也没作废那张令牌，它在源站眼里照样有效两小时，
        // 而没有任何人再持有它、也无从交还（server-authority 第 1 条）。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        var source = File.ReadAllText(path);

        var callback = Regex.Match(
            source,
            @"HttpPost\(""runs/callback""\)(?<body>.*?)(?=\n    /// <summary>)",
            RegexOptions.Singleline);
        Assert.True(callback.Success, "找不到 runs/callback 了，这条守卫的前提已变");
        var body = callback.Groups["body"].Value;

        // 换票发出去之后的每一步——读响应体、建 Run——都不许再看 ct。
        var afterExchange = body[body.IndexOf("PostAsJsonAsync", StringComparison.Ordinal)..];
        Assert.DoesNotContain(", ct)", afterExchange, StringComparison.Ordinal);
        Assert.DoesNotContain("cancellationToken: ct", afterExchange, StringComparison.Ordinal);
        Assert.Contains("}, CancellationToken.None);", afterExchange, StringComparison.Ordinal);

        // 换到票却没建成 Run 时必须当场交还，否则那张票没人认领也没人作废。
        Assert.Contains("RevokeAtSourceAsync(origin, token.ExportToken)", afterExchange, StringComparison.Ordinal);
        Assert.Contains("private async Task RevokeAtSourceAsync(", source, StringComparison.Ordinal);
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
    public void 脱敏字段不许落在唯一索引上()
    {
        // 脱敏把一个字段清成**同一个**空串。那个字段若带唯一索引，源站有几条就只有
        // 第一条插得进去，其余撞重复键——而重复键在 worker 里是按「跳过」处理的，
        // 于是整条同步照样报成功，数据静默少一批（user_shortcuts.TokenHash 就是这么中的）。
        //
        // 这不是某一个字段的问题，是「清空」这个手段与唯一约束天然冲突。所以钉的是这条
        // 通则：任何登记了脱敏的字段，都不许出现在唯一索引的键里。撞上了只有两条路——
        // 整个集合不导出，或者那个字段本来就不该脱敏。
        var uniqueIndexes = ReadUniqueIndexFields();
        Assert.True(uniqueIndexes.Count > 10,
            $"只解析出 {uniqueIndexes.Count} 个带唯一索引的集合，正则多半失效了");

        var conflicts = new List<string>();
        foreach (var collection in DataSyncScope.AllExportableCollections.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!DataSyncScope.TryResolve(collection, out var resolved) || resolved is null) continue;
            if (!uniqueIndexes.TryGetValue(collection, out var uniqueFields)) continue;
            foreach (var field in resolved.RedactFields)
            {
                if (uniqueFields.Contains(field)) conflicts.Add($"{collection}.{field}");
            }
        }

        Assert.True(conflicts.Count == 0,
            "下列字段既登记了脱敏、又落在唯一索引上——清空后多条会撞重复键，被当成「跳过」而同步仍报成功：\n  "
            + string.Join("\n  ", conflicts)
            + "\n（把整个集合移出白名单，或确认该字段不需要脱敏）");
    }

    /// <summary>集合名 -> 该集合唯一索引覆盖到的字段名，解析自 MongoDbContext 的索引定义。</summary>
    private static IReadOnlyDictionary<string, HashSet<string>> ReadUniqueIndexFields()
    {
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Infrastructure", "Database", "MongoDbContext.cs");
        var source = File.ReadAllText(path);

        // 集合属性名 -> mongo 集合名
        var propToCollection = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match m in Regex.Matches(source,
            @"IMongoCollection<[\w.]+>\s+(\w+)\s*=>\s*_database\.GetCollection<[\w.]+>\(""([a-zA-Z0-9_]+)""\)"))
        {
            propToCollection[m.Groups[1].Value] = m.Groups[2].Value;
        }

        var result = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (Match m in Regex.Matches(source,
            @"(\w+)\.Indexes\.CreateOne\(new CreateIndexModel<\w+>\((?<body>.*?)\)\);",
            RegexOptions.Singleline))
        {
            var body = m.Groups["body"].Value;
            if (!body.Contains("Unique = true", StringComparison.Ordinal)) continue;
            if (!propToCollection.TryGetValue(m.Groups[1].Value, out var collection)) continue;
            var bucket = result.TryGetValue(collection, out var existing)
                ? existing
                : result[collection] = new HashSet<string>(StringComparer.Ordinal);
            foreach (Match key in Regex.Matches(body, @"\.(?:Ascending|Descending)\(x => x\.(\w+)\)"))
            {
                bucket.Add(key.Groups[1].Value);
            }
        }
        return result;
    }

    [Fact]
    public void 授权范围必须冻结在签发那一刻()
    {
        // 票只记分组 key 的话，它的实际范围会跟着白名单一起变：源站在票的两小时
        // 有效期内上线一个新集合并归进某个已批准的分组，这张老票立刻就能读到
        // 批准人从没见过、也从没同意过的数据。授权是对「那一屏上列出的那些集合」
        // 的授权，所以签发时就要把展开结果冻进 grant，之后一律按它判。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncProviderController.cs");
        var source = File.ReadAllText(path);

        // 签发时冻结。
        Assert.Contains("{ \"Collections\", new BsonArray(DataSyncScope.Expand(approvedGroups)", source, StringComparison.Ordinal);

        // 清单与导出都按冻结清单判，不再各自重新展开分组。
        var reads = Regex.Matches(source, @"ReadFrozenCollections\(grant\)").Count;
        Assert.True(reads >= 3,
            $"只有 {reads} 处按冻结清单判（换票 / 清单 / 导出各需一处）——少一处那条路就还在跟着白名单变宽");

        // 导出的授权判据不许退回「分组现在展开成什么」。
        var export = Regex.Match(source, @"HttpGet\(""export""\)(?<body>.*?)(?=\n    /// <summary>|\Z)", RegexOptions.Singleline);
        Assert.True(export.Success, "找不到 export 端点了，这条守卫的前提已变");
        Assert.DoesNotContain("DataSyncScope.GroupOf(resolved.Name)", export.Groups["body"].Value, StringComparison.Ordinal);
    }

    [Fact]
    public void 脱敏契约也必须冻结在签发那一刻()
    {
        // 冻集合名只冻了契约的一半。同意页上每个集合旁边还列着「这些字段不会离开本站」，
        // 那份清单同样是批准人看着点下同意的。清单端点和导出端点如果在票的有效期内
        // 拿**当前**白名单重算脱敏字段，源站中途上线一个把某字段移出 RedactFields 的
        // 版本，这张老票立刻就能导出同意页明说会留在本地的字段。
        //
        // 这条守卫扫源码而不是断言行为：判定函数是私有的，而真正会退化的不是它算得对
        // 不对，是「有没有人调它」（predicate-and-wiring-discipline 形状 2）。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncProviderController.cs");
        var source = File.ReadAllText(path);

        // 签发时把生效后的脱敏字段逐集合冻进票里。
        Assert.Contains("{ \"Redactions\", new BsonDocument(DataSyncScope.Expand(approvedGroups)", source, StringComparison.Ordinal);
        Assert.Contains("DataSyncScope.ApplyGrant(c, request.IncludeCredentials).RedactFields", source, StringComparison.Ordinal);

        // 清单与导出都按冻结契约判。
        var reads = Regex.Matches(source, @"ReadFrozenScope\(grant, ").Count;
        Assert.True(reads >= 2,
            $"只有 {reads} 处按冻结的脱敏契约判（清单 / 导出各需一处）——少一处那条路就还在跟着白名单变");

        // 除了「签发时冻结」和「存量票的兜底重算」这两处，控制器里不许再有第三处
        // 现算脱敏字段：多一处就是判据分裂，迟早各自漂移（形状 3）。
        var recomputes = Regex.Matches(source, @"DataSyncScope\.ApplyGrant\(").Count;
        Assert.True(recomputes == 2,
            $"控制器里有 {recomputes} 处 DataSyncScope.ApplyGrant——只允许签发冻结与存量兜底这两处");
    }

    [Fact]
    public void 票据校验必须拿当前允许名单重对一遍()
    {
        // 「移出名单」要当场生效，靠的是 ResolveExportGrantAsync 每次都用**当前**名单
        // 重新校验票上的回跳地址。这条接线删掉之后：编译过、全量测试绿、
        // TryValidateRedirect 自己的用例也照样绿——因为它们测的是那个函数对不对，
        // 不是「有没有人调它」（predicate-and-wiring-discipline 形状 2）。
        // 所以只能扫源码钉这一处调用。
        var path = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncProviderController.cs");
        var source = File.ReadAllText(path);

        var resolver = Regex.Match(
            source,
            @"ResolveExportGrantAsync\(CancellationToken ct\)\s*\{(?<body>.*?)\n    \}",
            RegexOptions.Singleline);
        Assert.True(resolver.Success, "找不到 ResolveExportGrantAsync 了，这条守卫的前提已变");

        var body = resolver.Groups["body"].Value;
        Assert.Contains("TryValidateRedirect(", body, StringComparison.Ordinal);
        Assert.Contains("config.AllowedOrigins", body, StringComparison.Ordinal);
        // 只看全局开关是不够的那一半：开关判断也得还在。
        Assert.Contains("config.Enabled", body, StringComparison.Ordinal);
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

    [Fact]
    public void 搬口令散列这条路只许对users开一个口子()
    {
        // 「同步完直接能用」靠的是把 users.PasswordHash 一起搬过去。这是整条链路上
        // 唯一一处**主动少脱敏**的分支，边界要钉死三件事：只对 users 生效、只放行
        // PasswordHash、不勾时一切照旧。
        //
        // 原来这条是扫源码扫出来的——判据读的是「Controller 里那段 if 长什么样」，
        // 而不是「算出来的结果对不对」。判定抽成 DataSyncScope.ApplyGrant 之后
        // 直接断言返回值，扫源码那套连同它的脆弱一起扔掉。
        Assert.True(DataSyncScope.TryResolve("users", out var users));
        Assert.Contains(DataSyncScope.CredentialCarryField, users.RedactFields);

        var carried = DataSyncScope.ApplyGrant(users, includeCredentials: true);
        Assert.DoesNotContain(DataSyncScope.CredentialCarryField, carried.RedactFields);
        // users 上其它登记过的脱敏字段一个都不许被顺带放行。
        foreach (var field in users.RedactFields.Where(f => f != DataSyncScope.CredentialCarryField))
        {
            Assert.Contains(field, carried.RedactFields);
        }

        var strict = DataSyncScope.ApplyGrant(users, includeCredentials: false);
        Assert.Equal(users.RedactFields, strict.RedactFields);

        // 别的集合无论勾不勾，脱敏清单都不许变。
        foreach (var name in DataSyncScope.AllExportableCollections.Where(n => n != DataSyncScope.CredentialCarryCollection))
        {
            Assert.True(DataSyncScope.TryResolve(name, out var other));
            Assert.Equal(other.RedactFields, DataSyncScope.ApplyGrant(other, includeCredentials: true).RedactFields);
        }

        // 上面那圈其实证明不了「只对 users 生效」——今天没有第二个集合登记 PasswordHash，
        // 所以就算把集合名判断整个删掉，那圈也照样全绿（我把它删掉试过，确实没红）。
        // 真正钉死这条的是一个合成输入：换个集合名、同样带 PasswordHash，必须原样返回。
        var impostor = new DataSyncCollection("not_users", new[] { DataSyncScope.CredentialCarryField, "OtherSecret" });
        Assert.Equal(impostor.RedactFields, DataSyncScope.ApplyGrant(impostor, includeCredentials: true).RedactFields);
    }

    [Fact]
    public void 对照表报的脱敏字段必须与导出实际清的是同一份()
    {
        // 源站有两个出口会说「哪些字段会被清空」：清单端点（目标站的对照表照着渲染）
        // 与导出端点（真正动手清）。它们各算一次的下场是——导出按批准条件放行了
        // PasswordHash，清单还在说它已被清空，目标站管理员对着一份与事实相反的
        // 对照表点了确认（形状 3：判据分裂后各自漂移）。
        //
        // 现在两边都调 ReadFrozenScope（票上冻着的那份，取不到才落回 ApplyGrant）。
        // 这条守卫钉死这件事：源码里只允许有**一处**「改写 RedactFields」的写法，
        // 而且必须在那个共用判定函数里；两个端点都必须真的调它。
        var providerPath = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncProviderController.cs");
        var provider = File.ReadAllText(providerPath);

        var callSites = Regex.Matches(provider, @"ReadFrozenScope\(grant, ").Count;
        Assert.True(callSites >= 2,
            $"源站只有 {callSites} 处调用 ReadFrozenScope，清单与导出必须各调一次——少一处就是又有人自己算了一遍");

        // 改写 RedactFields 只许出现在共用判定函数里，别处一处都不许有。
        var helper = Regex.Match(
            provider,
            @"private static DataSyncCollection ReadFrozenScope\((?<body>.*?)\n    \}",
            RegexOptions.Singleline);
        Assert.True(helper.Success, "找不到 ReadFrozenScope 了，这条守卫的前提已变");
        var rewrites = Regex.Matches(provider, @"RedactFields = ").Count;
        Assert.True(rewrites == 1,
            $"控制器里有 {rewrites} 处改写 RedactFields——只允许 ReadFrozenScope 那一处");
        Assert.Contains("RedactFields = ", helper.Groups["body"].Value, StringComparison.Ordinal);

        // 清单端点确实把判定结果报出去了，而不是算完丢掉（形状 2）。
        var manifest = Regex.Match(provider, @"HttpGet\(""manifest""\)(?<body>.*?)(?=\[Http)", RegexOptions.Singleline);
        Assert.True(manifest.Success, "找不到 manifest 端点了，这条守卫的前提已变");
        Assert.Contains("ReadFrozenScope(grant, ", manifest.Groups["body"].Value, StringComparison.Ordinal);
        Assert.Contains("effectiveScope.RedactFields", manifest.Groups["body"].Value, StringComparison.Ordinal);
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
