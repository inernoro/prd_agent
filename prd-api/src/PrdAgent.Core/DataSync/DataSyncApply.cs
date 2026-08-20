using MongoDB.Bson;

namespace PrdAgent.Core.DataSync;

/// <summary>一批文档在本地的落库决策。</summary>
public sealed record DataSyncApplyDecision(
    IReadOnlyList<BsonDocument> ToInsert,
    IReadOnlyList<BsonDocument> ToReplace,
    IReadOnlyList<BsonValue> SkippedIds);

public static class DataSyncApply
{
    /// <summary>
    /// 解析源站发来的一批扩展 JSON 文档。
    ///
    /// 必须走 <c>BsonDocument.Parse</c> 而不是普通 JSON 反序列化：源站用的是
    /// CanonicalExtendedJson，日期是 <c>{"$date":...}</c>、长整型是 <c>{"$numberLong":...}</c>。
    /// 用普通 JSON 解析会把它们变成嵌套对象存进本地库，字段类型全错，而且**不会报错**
    /// ——查询的时候才发现日期筛选全都筛不到。
    /// </summary>
    public static List<BsonDocument> ParseDocuments(IEnumerable<string> extendedJsonDocuments)
    {
        var parsed = new List<BsonDocument>();
        foreach (var json in extendedJsonDocuments ?? Enumerable.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(json)) continue;
            parsed.Add(BsonDocument.Parse(json));
        }
        return parsed;
    }

    /// <summary>
    /// 按「本地已有哪些 _id」把一批文档分成新增 / 覆盖 / 跳过。
    ///
    /// 默认（overwrite=false）跳过本地已存在的：恢复空库是主场景，这样最安全——
    /// 一次误操作最多是「什么都没变」，不会是「本地改了半天的数据被源站盖掉」。
    /// </summary>
    public static DataSyncApplyDecision Decide(
        IReadOnlyList<BsonDocument> incoming,
        ISet<BsonValue> existingIds,
        bool overwrite)
    {
        ArgumentNullException.ThrowIfNull(incoming);
        ArgumentNullException.ThrowIfNull(existingIds);

        var insert = new List<BsonDocument>();
        var replace = new List<BsonDocument>();
        var skipped = new List<BsonValue>();
        foreach (var doc in incoming)
        {
            // 没有 _id 的文档一律不收：插进去会拿到本地新生成的 id，下一次同步又会
            // 再插一遍，变成每同步一次翻一倍。宁可漏一条，不要制造重复。
            if (!doc.TryGetValue("_id", out var id) || id.IsBsonNull) continue;

            if (!existingIds.Contains(id)) insert.Add(doc);
            else if (overwrite) replace.Add(doc);
            else skipped.Add(id);
        }
        return new DataSyncApplyDecision(insert, replace, skipped);
    }

    /// <summary>
    /// 找出这批文档里「本该有值、现在是空」的敏感字段，用于生成待补清单。
    ///
    /// 判据是「字段在白名单的 RedactFields 里，且当前值为空」——源站脱敏时保留了字段名
    /// 正是为了让这一步能认出来。反过来说，如果哪天改成删字段，这份清单会静默变空，
    /// 所以 DataSyncScopeCoverageTests 里钉了「脱敏是清空不是删除」。
    /// </summary>
    public static IReadOnlyList<string> DetectPendingSecretFields(
        IReadOnlyList<BsonDocument> documents,
        DataSyncCollection collection)
    {
        if (collection.RedactFields.Count == 0) return Array.Empty<string>();
        var pending = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var doc in documents)
        {
            foreach (var field in collection.RedactFields)
            {
                if (!doc.TryGetValue(field, out var value)) continue;
                if (value.IsBsonNull || (value.IsString && value.AsString.Length == 0)) pending.Add(field);
            }
        }
        return pending.ToList();
    }
}
