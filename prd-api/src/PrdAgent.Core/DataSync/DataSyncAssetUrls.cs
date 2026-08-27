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
    /// 哪些集合的哪些字段存着资产地址。
    ///
    /// 显式清单而不是「扫所有看起来像 URL 的字段」：后者会连业务里的外链
    /// （webhook 地址、用户填的参考链接）一起改写，那是把别人的数据改坏。
    /// 新增存资产地址的集合要往这里登记，有守卫盯着清单里的字段真实存在。
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string[]> UrlFields =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["attachments"] = new[] { "Url", "ThumbnailUrl" },
        };

    public static IReadOnlyDictionary<string, string[]> FieldMap => UrlFields;

    /// <summary>这个集合有没有需要改写的地址字段。</summary>
    public static bool HasUrlFields(string collectionName)
        => UrlFields.ContainsKey(collectionName ?? string.Empty);

    /// <summary>
    /// 内容寻址对象的 key 形状：`{domain}/{type}/{26 位 base32}.{ext}`。
    ///
    /// 判据卡得这么死是有意的：没有 StorageKey 的存量文档只能从 URL 反推 key，
    /// 而「路径的最后三段」这种宽判据会把网页托管（`web-hosting/sites/...`）、
    /// 头像（`icon/backups/head/...`）这些**层级不同**的地址也一起改坏。
    /// 认不出来就不动，并如实计数——改错一条地址比不改更难查。
    /// </summary>
    private static readonly Regex ContentAddressedTail = new(
        @"^[a-z0-9-]+/[a-z0-9-]+/[a-z2-7]{26}\.[a-z0-9]{1,10}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <param name="Rebased">已改写成本站地址的字段数。</param>
    /// <param name="Unrecognized">是绝对地址、但认不出 key，原样留着的字段数——**这些就是搬完还打不开的候选**。</param>
    /// <param name="AlreadyRelative">本来就是相对地址、天然跟着本站走的字段数。</param>
    public sealed record RebaseResult(int Rebased, int Unrecognized, int AlreadyRelative)
    {
        public static readonly RebaseResult Empty = new(0, 0, 0);

        public RebaseResult Add(RebaseResult other)
            => new(Rebased + other.Rebased, Unrecognized + other.Unrecognized, AlreadyRelative + other.AlreadyRelative);
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
    public static RebaseResult RebaseIncoming(
        IReadOnlyList<BsonDocument> documents,
        string collectionName,
        Func<string, string?>? buildLocalUrl)
    {
        ArgumentNullException.ThrowIfNull(documents);
        if (buildLocalUrl is null) return RebaseResult.Empty;
        if (!UrlFields.TryGetValue(collectionName ?? string.Empty, out var fields)) return RebaseResult.Empty;

        var rebased = 0;
        var unrecognized = 0;
        var relative = 0;
        foreach (var doc in documents)
        {
            var key = TryReadStorageKey(doc);
            foreach (var field in fields)
            {
                if (!doc.TryGetValue(field, out var value) || value.BsonType != BsonType.String) continue;
                var current = value.AsString;
                if (string.IsNullOrWhiteSpace(current)) continue;
                if (!IsAbsoluteHttp(current)) { relative++; continue; }

                // ThumbnailUrl 与 Url 可能指向不同对象，所以 StorageKey 只用于**主地址**；
                // 拿它去顶缩略图会把两个对象混成一个。
                var resolved = field == "Url" && key is not null
                    ? NormalizeKey(key)
                    : TryExtractContentAddressedKey(current);
                if (resolved is null) { unrecognized++; continue; }

                var next = buildLocalUrl(resolved);
                // 拼不出来（本站没配公网根地址之类）就原样留着，并算进「认不出」——
                // 写一个半截地址进去，比留着源站地址更难查。
                if (string.IsNullOrWhiteSpace(next)) { unrecognized++; continue; }

                doc[field] = next;
                rebased++;
            }
        }
        return new RebaseResult(rebased, unrecognized, relative);
    }

    private static string? TryReadStorageKey(BsonDocument doc)
    {
        if (!doc.TryGetValue("StorageKey", out var v) || v.BsonType != BsonType.String) return null;
        var key = v.AsString.Trim();
        return key.Length == 0 ? null : key;
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
    internal static string? TryExtractContentAddressedKey(string absoluteUrl)
    {
        if (!Uri.TryCreate((absoluteUrl ?? string.Empty).Trim(), UriKind.Absolute, out var uri)) return null;
        string[] segments;
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
        if (segments.Length < 3) return null;
        if (segments.Any(s => s is "." or ".." || s.Contains('\\'))) return null;

        var tail = string.Join('/', segments[^3..]).ToLowerInvariant();
        return ContentAddressedTail.IsMatch(tail) ? tail : null;
    }

    private static string NormalizeKey(string key)
        => key.Trim().Replace('\\', '/').TrimStart('/');
}
