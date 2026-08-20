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
        var index = 0;
        foreach (var json in extendedJsonDocuments ?? Enumerable.Empty<string>())
        {
            // 空串 / 全空白也是坏数据，不是「这里没有文档」。原来 continue 跳过它，
            // 于是这一页少一条、游标照样前进、整条 Run 报成功——和这条链路上
            // 其它几处形状校验同一条纪律：不许把协议故障翻译成正常收尾。
            if (string.IsNullOrWhiteSpace(json))
            {
                throw new InvalidOperationException(
                    $"源站返回的 documents[{index}] 是空字符串，不是一份文档");
            }
            parsed.Add(BsonDocument.Parse(json));
            index++;
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

    /// <summary>
    /// 批量插入部分失败后，从这一批里挑出**真的写进去了**的那些。
    ///
    /// `IsOrdered = false` 时失败可以落在任意位置，所以判据只能是驱动返回的失败下标，
    /// 不能是「砍掉末尾 N 条」——后者数量对、身份错。计数看不出差别，下游看得出来：
    /// 待补清单要拿这批文档逐条看字段在不在，认错了人就会漏报一个真需要补的凭据，
    /// 或者替一条根本没写进去的文档报一个假的。
    /// </summary>
    public static IReadOnlyList<BsonDocument> SurvivingInserts(
        IReadOnlyList<BsonDocument> attempted, IEnumerable<int> failedIndexes)
    {
        ArgumentNullException.ThrowIfNull(attempted);
        ArgumentNullException.ThrowIfNull(failedIndexes);
        var failed = failedIndexes.ToHashSet();
        if (failed.Count == 0) return attempted;
        return attempted.Where((_, i) => !failed.Contains(i)).ToList();
    }

    /// <summary>
    /// 覆盖写之前，把目标站原有的「本地执行历史」字段接回替换文档上。
    ///
    /// 覆盖是整份替换，不接回来这些字段就跟着源站那份走了——而它们记的是「本机跑过什么」，
    /// 换成别人的账会让本站要么跳过还没跑的迁移，要么重跑一个已经被手工回退的迁移。
    /// 源站出口已经把这类字段删掉，所以这里遇到的替换文档本来就没有它们；
    /// 万一源站是个还没升级的旧版本、字段照样送过来了，也以目标站这份为准（直接覆盖），
    /// 判据不依赖源站有没有做对。
    ///
    /// 目标站原本就没有这个字段时不写入：那是「本机什么都没跑过」，写个空值反而多一层歧义。
    /// </summary>
    public static void CarryTargetLocalFields(
        IReadOnlyList<BsonDocument> toReplace,
        IReadOnlyList<BsonDocument> existingDocuments,
        DataSyncCollection collection)
    {
        ArgumentNullException.ThrowIfNull(toReplace);
        ArgumentNullException.ThrowIfNull(existingDocuments);
        ArgumentNullException.ThrowIfNull(collection);
        if (collection.PreserveFields.Count == 0 || toReplace.Count == 0) return;

        var byId = new Dictionary<BsonValue, BsonDocument>();
        foreach (var existing in existingDocuments)
        {
            if (existing.TryGetValue("_id", out var id) && !id.IsBsonNull) byId[id] = existing;
        }

        foreach (var doc in toReplace)
        {
            if (!doc.TryGetValue("_id", out var id) || !byId.TryGetValue(id, out var local)) continue;
            foreach (var field in collection.PreserveFields)
            {
                if (local.TryGetValue(field, out var value)) doc[field] = value;
                else doc.Remove(field);
            }
        }
    }
}
