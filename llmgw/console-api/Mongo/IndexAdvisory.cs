using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.Mongo;

/// <summary>
/// 启动时**查**索引在不在，不建。缺了就如实报出来，附上该跑什么、以及在那之前什么会退化。
///
/// 为什么不建：`no-auto-index` 禁的是启动路径上建索引这件事本身。在一个已经有数据的集合上
/// 建索引可能阻塞写入、拖慢就绪；副本集滚动重启时每个实例各建各的；而建失败若没被那个窄窄的
/// catch 接住，整个控制台起不来。这三种后果都发生在没人盯着的启动路径上。
///
/// 为什么不能只是删掉：这几条唯一索引是**库级不变量**，端点里的「先查有没有别人」在并发下
/// 挡不住（Mongo 没有跨文档原子性可用）。索引不在的那段时间，那些并发窗口是真的敞开着的——
/// 所以报的是 Warning，而且必须说清退化成什么样，不许只说「索引缺失」
/// （external-cause-first：给读的人一个他能处置的结论；degradation-must-alarm：降级要响铃）。
/// </summary>
public static class IndexAdvisory
{
    /// <summary>
    /// 这条索引在不在。不在就往控制台日志写一条 Warning。
    /// 查询本身失败（连不上、没权限）也当成「报不出结论」如实说，不抛——
    /// 一次索引巡检不该让控制台起不来，那正是本类要避免的那种后果。
    /// </summary>
    public static async Task ReportIfMissingAsync<TDocument>(
        IMongoCollection<TDocument> collection,
        string indexName,
        string degradesTo)
    {
        bool present;
        try
        {
            var indexes = await (await collection.Indexes.ListAsync()).ToListAsync();
            present = indexes.Any(index =>
                index.GetValue("name", BsonNull.Value) is { IsString: true } name
                && string.Equals(name.AsString, indexName, StringComparison.Ordinal));
        }
        catch (MongoException ex)
        {
            Console.WriteLine(
                $"[llmgw] 查不了索引 {indexName} 在不在（{ex.Message}）。"
                + $"所以下面这件事现在是未知的：{degradesTo}。"
                + "先确认控制台连得上网关库，再按 doc/guide.platform.mongodb-indexes.md 核对这条索引");
            return;
        }

        if (present) return;
        Console.WriteLine(
            $"[llmgw] 索引 {indexName} 不存在，于是：{degradesTo}。"
            + "启动不建索引（no-auto-index），请 DBA 按 doc/guide.platform.mongodb-indexes.md 里"
            + $" {indexName} 那一条建好；建不出来通常说明存量里已经有冲突的两条，那一条里也写了怎么清");
    }
}
