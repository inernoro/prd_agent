using System.Text.RegularExpressions;
using MongoDB.Bson;

namespace PrdAgent.Core.DataSync;

/// <summary>
/// 把源站送来的**绝对**资产地址改写成本站地址。
///
/// ## 为什么要有（DS1）
///
/// 附件搬的只有元数据，二进制留在对象存储里，而 `Attachment.Url` 存的是**源站此刻**的
/// 绝对地址：`https://源站公网域名/源站前缀/domain/type/xxx.png`。两站不共用同一个桶、
/// 或者公网域名/前缀不同时，同步过来的图片、录音、导出文件全部打不开——地址把
/// 「东西在哪」和「那台机器叫什么」焊死在了一起。
///
/// 不随部署变化的是 **key**（`domain/type/文件名`）。本类负责：从来源里认出这个 key，
/// 再交给本站的存储实现重新拼一次地址（前缀怎么拼是存储自己的事，这里不复制那份逻辑）。
///
/// ## 它不做什么（这一点必须说清楚）
///
/// 它只改地址，**不搬字节**。两站不共用同一个桶时，改完的地址指向的是一个本站还没有的
/// 对象——从「指回别人家」变成「指向自己家的空位」。这不是修好了，是把问题挪到了
/// 一个能被发现、也能被后续「按需转存」接上的位置。所以调用方必须把
/// <see cref="RebaseResult"/> 里的数字如实报出去，不许静默。
/// </summary>
public static class DataSyncAssetUrls
{
    /// <summary>
    /// 这个 key 是怎么拼成地址的——决定跨站搬运时前缀该怎么处理。
    /// </summary>
    public enum AssetKeyKind
    {
        /// <summary>
        /// 内容寻址：逻辑 key 是 `{domain}/{type}/{base32}.{ext}`，
        /// 而**物理 key 前面还带着各站自己配置的前缀**（`SaveAsync` 存的就是带前缀那份）。
        ///
        /// 所以跨站搬运必须剥掉源站前缀、由目标站套上自己的。直接把源站物理 key
        /// 交给目标站拼地址，会拼出 `{目标站根}/{源站前缀}/...` 这种谁家都不是的路径（DS31）。
        /// </summary>
        ContentAddressed,

        /// <summary>
        /// 完整物理路径：上传与拼地址两侧都原样使用这一个字符串，不涉及任何前缀
        /// （首页素材、桌面端素材就是这种，`RelativePath` 存的就是它）。
        /// 这类 key 跨站是**天然可搬运**的，套前缀反而会拼错。
        /// </summary>
        PhysicalPath,
    }

    /// <param name="Field">存地址的字段名。</param>
    /// <param name="KeyField">
    /// 同一份文档里存着 key 的那个字段；为空表示只能从地址本身反推。
    /// 有 key 字段就用它——那是**记下来的事实**，比从地址反推可靠。
    /// </param>
    /// <param name="KeyKind">这个 key 属于上面哪一类。</param>
    public sealed record AssetUrlField(string Field, string? KeyField, AssetKeyKind KeyKind);

    /// <summary>
    /// 哪些集合的哪些字段存着资产地址。
    ///
    /// 显式清单而不是「扫所有看起来像 URL 的字段」：后者会连业务里的外链
    /// （webhook 地址、用户填的参考链接）一起改写，那是把别人的数据改坏。
    ///
    /// **反方向也有守卫**：导出清单里凡是带 `*Url` 字段的集合，要么登记在这里、
    /// 要么登记在下面 <see cref="NotRebased"/> 里写明为什么不改，两边都没有就判红。
    /// 早先只有单向闸（「登记的字段必须真实存在」），于是新增的资产集合
    /// 静默漏掉、一个数都不报（DS33）。
    /// </summary>
    private static readonly IReadOnlyDictionary<string, AssetUrlField[]> UrlFields =
        new Dictionary<string, AssetUrlField[]>(StringComparer.Ordinal)
        {
            ["attachments"] = new[]
            {
                new AssetUrlField("Url", "StorageKey", AssetKeyKind.ContentAddressed),
                // ThumbnailUrl 与 Url 可能指向不同对象，所以不共用 StorageKey——
                // 拿它去顶缩略图会把两个对象混成一个。
                new AssetUrlField("ThumbnailUrl", null, AssetKeyKind.ContentAddressed),
            },
            // 下面几个集合此前整个不在清单里：地址原样落库、`Unrecognized` 还是 0，
            // 于是附件卡一个字都不说，搬完之后首页素材、生成图、桌面端资源仍然从源站加载（DS33）。
            //
            // 它们自己就存着 key（`RelativePath`），不必从地址反推——那比正则可靠得多，
            // 也正好绕开「内容寻址正则认不出 icon/desktop/... 这种层级」的问题。
            ["homepage_assets"] = new[]
            {
                new AssetUrlField("Url", "RelativePath", AssetKeyKind.PhysicalPath),
            },
            ["desktop_assets"] = new[]
            {
                new AssetUrlField("Url", "RelativePath", AssetKeyKind.PhysicalPath),
            },
            // 生成图没有 key 字段，只能从地址反推；它们本来就是内容寻址存的，正则认得出。
            ["image_assets"] = new[]
            {
                new AssetUrlField("Url", null, AssetKeyKind.ContentAddressed),
                new AssetUrlField("OriginalUrl", null, AssetKeyKind.ContentAddressed),
            },
        };

    /// <summary>
    /// 导出清单里带地址字段、但**故意不改写**的集合，连同理由。
    ///
    /// 不是「忘了登记」的兜底口袋——每加一条都要写清为什么改它是错的。
    /// 存在它是为了让反向守卫能分辨「漏了」和「想清楚了不改」：
    /// 没有这一栏的话，守卫只能在「全都要改」和「全都不管」之间二选一。
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NotRebased =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["asset_registry"] = "存储操作流水（谁在什么时候存了什么），不是活的资产指针。"
                + "它的 Url 是当时那一刻的事实记录，改写它等于篡改历史。",

            // 下面这些地址指向的是**别人家**：改写它们就是把用户填的、或者协议约定的
            // 外部地址改坏，比不改严重得多。
            ["appsettings"] = "MiduoSsoBaseUrl 是上游 SSO 的地址；这一族字段已经整组留在目标站，不跟着源站走。",
            ["llmplatforms"] = "ApiUrl 是上游模型供应商的地址。",
            ["llmmodels"] = "同上，上游模型供应商的地址。",
            ["defect_webhook_configs"] = "WebhookUrl 是外部回调端点，改写等于把通知发去别处。",
            ["report_webhook_configs"] = "同上，外部回调端点。",
            ["review_webhook_configs"] = "同上，外部回调端点。",
            ["defect_resolution_traces"] = "指向 GitHub 提交/PR、CDS 预览、知识库的外部链接，都不在本站对象存储里。",
            ["document_entries"] = "SourceUrl 是这篇内容的抓取来源，属于外部事实。",
            ["document_store_sync_links"] = "RemoteBaseUrl 是对端实例的地址，改写会把同步指向自己。",
            ["pr_review_items"] = "HtmlUrl 是 GitHub 上那个 PR 的页面地址。",
            ["report_data_sources"] = "RepoUrl 是 git 仓库地址。",
            ["requirements"] = "SourceUrl 是需求的外部来源。",
            ["product_initiations"] = "PlanUrl 是人手填的外部文档链接。",
            ["product_releases"] = "AnnouncementUrl / PlanUrl 同上，人手填的外部文档链接。",
            ["shortcut_templates"] = "ICloudUrl 是 iCloud 的分享链接。",
            ["marketing_consult_reports"] = "HostedSiteUrl 指向网页托管出来的**站点页面**，不是对象存储里的文件。",
            ["pm_briefings"] = "同上，指向网页托管的站点页面。",
            ["workspaces"] = "LatestPreviewUrl 是预览页面地址，不是对象存储里的文件。",
        };

    /// <summary>
    /// 存着本站资产地址、但改写方式**还没定**的集合（DS36）。
    ///
    /// 它们不是「不用改」——多半真该改，只是所用的 key 形态本轮还没有对应的处理：
    /// 这几个集合用 sha 换地址（`TryBuildUrlBySha`），那是第三类 key，登记进
    /// <see cref="UrlFields"/> 需要先把它的跨站语义想清楚，属于新的语义类别。
    ///
    /// 这一栏是**只许缩小**的过渡名单，不是兜底口袋：守卫钉住它的条目数只减不增，
    /// 新增的资产集合没法悄悄躺进来。每清掉一条就往 <see cref="UrlFields"/> 挪一条。
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> PendingSurvey =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["watermark_font_assets"] = "字体文件在本站存储里，但地址按 Sha256 换（第三类 key）。",
            ["watermark_configs"] = "PreviewUrl 同上，按 FontKey / sha 换地址。",
            ["literary_agent_configs"] = "ReferenceImageUrl 按 ReferenceImageSha256 换地址。",
            ["reference_image_configs"] = "ImageUrl 按 ImageSha256 换地址。",
            ["marketplace_skills"] = "CoverImageUrl / ZipUrl 有配套的 CoverImageKey / ZipKey，key 形态待核对。",
            ["submissions"] = "CoverUrl 来自 ImageAssetId 指向的那张生成图，要跟着 image_assets 一起想。",
            ["tutorial_email_assets"] = "FileUrl 是本站存储里的文件，但没有配套 key 字段。",
            ["tutorial_email_templates"] = "ThumbnailUrl 同上。",
            ["ccas_equipment_assets"] = "Url / OriginalUrl 是本站存储里的图，没有配套 key 字段。",
            ["pm_knowledge_files"] = "Url 是本站存储里的文件，没有配套 key 字段。",
            ["user_collections"] = "Url 可能是本站资产、也可能是用户收藏的外链，要先分清。",
            ["daily_tips"] = "CoverImageUrl 是本站资产，ActionUrl 是外链——同一个集合两种语义，要拆开登记。",
            ["hosted_sites"] = "CoverImageUrl / PdfAssetUrl 是本站资产，SiteUrl 是站点页面地址，同上要拆开。",
            ["document_stores"] = "CoverImageUrl 是本站资产，另两个是对端实例地址，同上要拆开。",
        };

    public static IReadOnlyDictionary<string, AssetUrlField[]> FieldMap => UrlFields;

    /// <summary>故意不改写的集合与理由，给守卫和排障用。</summary>
    public static IReadOnlyDictionary<string, string> NotRebasedReasons => NotRebased;

    /// <summary>改写方式还没定、只许缩小的过渡名单（DS36）。</summary>
    public static IReadOnlyDictionary<string, string> PendingSurveyReasons => PendingSurvey;

    /// <summary>这个集合有没有需要改写的地址字段。</summary>
    public static bool HasUrlFields(string collectionName)
        => UrlFields.ContainsKey(collectionName ?? string.Empty);

    /// <summary>
    /// 内容寻址对象的 key 形状：`{domain}/{type}/{内容指纹}.{ext}`。
    ///
    /// 判据卡得这么死是有意的：没有 StorageKey 的存量文档只能从 URL 反推 key，
    /// 而「路径的最后三段」这种宽判据会把网页托管（`web-hosting/sites/...`）、
    /// 头像（`icon/backups/head/...`）这些**层级不同**的地址也一起改坏。
    /// 认不出来就不动，并如实计数——改错一条地址比不改更难查。
    ///
    /// ## 指纹有两种写法，两种都得认（Codex review P1）
    ///
    /// 本仓库的三个存储实现都按内容寻址命名，但编码不同：
    ///
    /// | 实现 | 文件名 | 出处 |
    /// |---|---|---|
    /// | R2 / COS | sha256 前 16 字节的 base32，26 位 | `Sha256HexToBase32Lower128` |
    /// | 本地磁盘 | 完整 sha256 十六进制，64 位 | `LocalAssetStorage.Sha256Hex` |
    ///
    /// 上一版只写了 26 位那一种，于是**源站用本地磁盘时，`StorageKey` 明明存着一个
    /// 完全可用的 key，却过不了这道形状检查**——地址照样改不了。这正是 DS30 要修的
    /// 那个场景，判据却把它挡在门外（形状 1：判据比它该管的范围窄）。
    ///
    /// 这里不是「多认一种同义词」那种越描越宽的口子：两种写法各自对应一个真实存在的
    /// 存储实现，是封闭的两项，不是开放的模式。下面那条守卫会真的跑一次
    /// `LocalAssetStorage.SaveAsync` 拿它产出的 key 来验，实现改了命名就会红。
    /// </summary>
    private static readonly Regex ContentAddressedTail = new(
        @"^[a-z0-9-]+/[a-z0-9-]+/(?:[a-z2-7]{26}|[0-9a-f]{64})\.[a-z0-9]{1,10}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <param name="Rebased">已改写成本站地址的字段数。</param>
    /// <param name="Unrecognized">是绝对地址、但认不出 key，原样留着的字段数——**这些就是搬完还打不开的候选**。</param>
    /// <param name="AlreadyRelative">
    /// 是相对地址、而且**找不到可用的 key**，因此改不了的字段数。
    ///
    /// **这一档不是「没事」，是「多半有事」**（DS30）。判据早先把「已经是相对路径」读成
    /// 「天然可移植」直接放行，既不改写也不计数——可这两件事只在两站共享同一份磁盘时才等价，
    /// 而跨实例同步的前提恰恰是两台不同的机器。源站用本地磁盘存附件时，地址就是
    /// `/local-assets/...`，搬过来每一个都指向本站不存在的文件，而且**一句提示都没有**。
    ///
    /// 「找不到可用的 key」这个限定词是后补的，且很要紧：本地磁盘存的附件同样带着
    /// `StorageKey` / `RelativePath`，那些是**改得了的**，只是上一版在读它们之前就按
    /// 「地址不是绝对的」提前退出了。真正落进这一档的，是既没登记 key 字段、
    /// 又没法从地址反推的那些——地址改不了，文件也没搬，能做的只有别再静默。
    /// </param>
    public sealed record RebaseResult(int Rebased, int Unrecognized, int AlreadyRelative)
    {
        public static readonly RebaseResult Empty = new(0, 0, 0);

        public RebaseResult Add(RebaseResult other)
            => new(Rebased + other.Rebased, Unrecognized + other.Unrecognized, AlreadyRelative + other.AlreadyRelative);

        public RebaseResult Subtract(RebaseResult other)
            => new(Rebased - other.Rebased, Unrecognized - other.Unrecognized, AlreadyRelative - other.AlreadyRelative);
    }

    /// <param name="Total">这一批的合计。</param>
    /// <param name="ByDocument">与传入 documents **下标对齐**的逐文档结果。</param>
    /// <remarks>
    /// 逐文档那份是给「落库时才发现写不进去」用的（DS34）：插入可能撞唯一索引被剔除，
    /// 而计数在那之前就累加过了。调用方拿被剔掉的下标回冲，报出去的数才等于真正落库的。
    /// </remarks>
    public sealed record RebaseBatch(RebaseResult Total, IReadOnlyList<RebaseResult> ByDocument)
    {
        public static readonly RebaseBatch Empty = new(RebaseResult.Empty, Array.Empty<RebaseResult>());
    }

    /// <summary>
    /// 就地改写一批文档里的资产地址。
    /// </summary>
    /// <param name="documents">这一页的文档，会被就地修改。</param>
    /// <param name="collectionName">集合名，决定改哪些字段。</param>
    /// <param name="buildLocalUrl">
    /// 把 key 拼成本站地址。传本站存储实现的那一个，别在这里另写一份前缀拼接——
    /// 两份拼法必然漂移，而漂移的结果是一批打不开的地址。
    /// </param>
    public static RebaseBatch RebaseIncoming(
        IReadOnlyList<BsonDocument> documents,
        string collectionName,
        Func<string, AssetKeyKind, string?>? buildLocalUrl)
    {
        ArgumentNullException.ThrowIfNull(documents);
        if (buildLocalUrl is null) return RebaseBatch.Empty;
        if (!UrlFields.TryGetValue(collectionName ?? string.Empty, out var fields)) return RebaseBatch.Empty;

        var total = RebaseResult.Empty;
        var perDoc = new RebaseResult[documents.Count];
        for (var i = 0; i < documents.Count; i++)
        {
            var doc = documents[i];
            var one = RebaseResult.Empty;
            foreach (var spec in fields)
            {
                if (!doc.TryGetValue(spec.Field, out var value) || value.BsonType != BsonType.String) continue;
                var current = value.AsString;
                if (string.IsNullOrWhiteSpace(current)) continue;

                // **先认 key，再看地址长什么样**——顺序反过来就是一个洞。
                //
                // 上一版把「不是绝对地址」当成提前退出的条件放在最前面，于是源站用本地磁盘
                // 存附件时（地址形如 `/local-assets/...`），文档里那个**完全可用**的
                // `StorageKey` / `RelativePath` 根本没机会被读到：明明改得了的地址被判成
                // 「改不了」，界面还照着说「这种地址改不了也用不了」。操作者按提示把文件
                // 复制过来、或者两站都换成对象存储再同步，地址照样指着源站那台机器。
                //
                // 判据比它该管的范围窄了一档（形状 1）：真正改不了的是「**没有可用的 key**」，
                // 不是「地址是相对的」。这两件事只在没登记 key 字段的集合上才重合。
                var resolved = ResolveKey(doc, spec, current);
                if (resolved is null)
                {
                    // 认不出 key 的两种后果不同，分开数：
                    // 绝对地址 = 指着源站，源站下线就打不开；
                    // 相对地址 = 指着本站磁盘上一个不存在的文件，此刻就打不开（DS30）。
                    one = one.Add(IsAbsoluteHttp(current)
                        ? new RebaseResult(0, 1, 0)
                        : new RebaseResult(0, 0, 1));
                    continue;
                }

                var next = buildLocalUrl(resolved, spec.KeyKind);
                // 拼不出来（本站没配公网根地址之类）就原样留着，并算进「认不出」——
                // 写一个半截地址进去，比留着源站地址更难查。
                if (string.IsNullOrWhiteSpace(next)) { one = one.Add(new RebaseResult(0, 1, 0)); continue; }

                doc[spec.Field] = next;
                one = one.Add(new RebaseResult(1, 0, 0));
            }
            perDoc[i] = one;
            total = total.Add(one);
        }
        return new RebaseBatch(total, perDoc);
    }

    /// <summary>
    /// 认出这个字段该用哪个 key。有 key 字段就用它（记下来的事实），没有才从地址反推。
    /// </summary>
    /// <remarks>
    /// 内容寻址那一类还要**再剥一层**：文档里存的 key 是源站的**物理** key，前面带着源站前缀
    /// （`SaveAsync` 存的就是带前缀那份）。直接交给目标站拼地址会拼出
    /// `{目标站根}/{源站前缀}/...`——谁家都不是（DS31）。
    /// 所以统一抽取内容寻址尾部得到**逻辑** key，前缀由目标站自己套。
    /// 抽不出尾部就是认不出：源站前缀有几段我们并不知道，**不猜**。
    /// </remarks>
    private static string? ResolveKey(BsonDocument doc, AssetUrlField spec, string currentUrl)
    {
        var fromField = spec.KeyField is null ? null : TryReadStringField(doc, spec.KeyField);
        if (spec.KeyKind == AssetKeyKind.PhysicalPath)
        {
            // 完整物理路径：两侧原样使用，不涉及前缀。没有 key 字段就没法反推——
            // 这类地址的层级各不相同（`icon/desktop/dark/bg.mp4`），拿正则去猜必然改坏。
            return fromField is null ? null : NormalizeKey(fromField);
        }

        return fromField is not null
            ? TryExtractContentAddressedKey(fromField, alreadyKey: true)
            : TryExtractContentAddressedKey(currentUrl);
    }

    private static string? TryReadStringField(BsonDocument doc, string field)
    {
        if (!doc.TryGetValue(field, out var v) || v.BsonType != BsonType.String) return null;
        var s = v.AsString.Trim();
        return s.Length == 0 ? null : s;
    }

    private static bool IsAbsoluteHttp(string value)
        => Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
           && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    /// <summary>
    /// 从一个绝对地址里认出内容寻址 key。认不出返回 null——**不猜**。
    ///
    /// 源站前缀有几段我们并不知道，所以从右往左取三段试：只有整体长成
    /// `{domain}/{type}/{base32}.{ext}` 才算认出来。
    /// </summary>
    /// <param name="alreadyKey">
    /// 传进来的已经是一个 key（不是 URL）。**物理 key 前面可能带着源站前缀**，
    /// 所以同样走「取末三段」把它剥成逻辑 key——这正是 DS31 要的那一步。
    /// </param>
    internal static string? TryExtractContentAddressedKey(string absoluteUrl, bool alreadyKey = false)
    {
        string[] segments;
        if (alreadyKey)
        {
            segments = NormalizeKey(absoluteUrl ?? string.Empty)
                .Split('/', StringSplitOptions.RemoveEmptyEntries);
        }
        else
        {
            if (!Uri.TryCreate((absoluteUrl ?? string.Empty).Trim(), UriKind.Absolute, out var uri)) return null;
            try
            {
                segments = uri.AbsolutePath
                    .Split('/', StringSplitOptions.RemoveEmptyEntries)
                    .Select(Uri.UnescapeDataString)
                    .ToArray();
            }
            catch
            {
                return null;
            }
        }
        if (segments.Length < 3) return null;
        if (segments.Any(s => s is "." or ".." || s.Contains('\\'))) return null;

        var tail = string.Join('/', segments[^3..]).ToLowerInvariant();
        return ContentAddressedTail.IsMatch(tail) ? tail : null;
    }

    private static string NormalizeKey(string key)
        => key.Trim().Replace('\\', '/').TrimStart('/');
}
