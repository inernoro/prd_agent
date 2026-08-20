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
        // 现在两边都调 ApplyGrant。这条守卫钉死这件事：源码里除了 ApplyGrant 自身，
        // 不许再出现第二处「按 includeCredentials 改写 RedactFields」的写法，
        // 且两个端点都必须真的调它。
        var providerPath = Path.Combine(LocateSrcRoot(), "PrdAgent.Api", "Controllers", "Api", "DataSyncProviderController.cs");
        var provider = File.ReadAllText(providerPath);

        var callSites = Regex.Matches(provider, @"DataSyncScope\.ApplyGrant\(").Count;
        Assert.True(callSites >= 2,
            $"源站只有 {callSites} 处调用 ApplyGrant，清单与导出必须各调一次——少一处就是又有人自己算了一遍");

        // 自己改写 RedactFields 的写法一律不许出现在 Controller 里。
        Assert.DoesNotContain("RedactFields =", provider, StringComparison.Ordinal);

        // 清单端点确实把 ApplyGrant 的结果报出去了，而不是算完丢掉（形状 2）。
        var manifest = Regex.Match(provider, @"HttpGet\(""manifest""\)(?<body>.*?)(?=\[Http)", RegexOptions.Singleline);
        Assert.True(manifest.Success, "找不到 manifest 端点了，这条守卫的前提已变");
        Assert.Contains("ApplyGrant", manifest.Groups["body"].Value, StringComparison.Ordinal);
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
