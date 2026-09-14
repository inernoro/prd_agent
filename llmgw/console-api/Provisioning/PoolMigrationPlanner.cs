using MongoDB.Bson;

namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 把一个模型池翻成一个模型（公开名 + 若干条上游线路）的纯判断。
///
/// 抽出来单放是为了**能被单测直接断言**：搬迁只跑一次，跑错了拿回来的是脏数据，
/// 而写在端点闭包里的判断只能靠跑整条链路才验得到。
/// </summary>
public static class PoolMigrationPlanner
{
    /// <summary>一次搬迁最多处理多少个池。超了让用户分批，不做无上限的长事务。</summary>
    public const int MaxBatch = 200;

    /// <summary>
    /// 池的对外名 -> 公开模型名。
    ///
    /// 取 <c>Code</c> 而不是 <c>Name</c>：调用方一直按 Code 请求，换成 Name 等于改对外契约。
    /// Code 为空的池（历史数据里有）没有对外身份，搬过去也没人能调，返回空让调用方跳过。
    /// </summary>
    public static string ToPublicId(BsonDocument pool)
    {
        var code = (pool.GetValue("Code", BsonNull.Value) is { IsString: true } c ? c.AsString : string.Empty).Trim();
        if (code.Length is < 2 or > 160) return string.Empty;
        // 与逻辑模型 PublicId 的校验一致：首字符必须是字母或数字
        return System.Text.RegularExpressions.Regex.IsMatch(code, "^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$") ? code : string.Empty;
    }

    /// <summary>
    /// 池的调度策略 -> 逻辑模型的路由策略。
    ///
    /// 池有六种（FailFast / Race / Sequential / RoundRobin / WeightedRandom / LeastLatency），
    /// 逻辑模型只有两种。这不是信息丢失——真正跑在请求链路上的只有「按优先级挑一个、挂了换下一个」
    /// 与「按权重分流」两件事，另外四种是那套生产上根本没人调的调度空壳里的枚举。
    /// 只有 WeightedRandom(4) 映射到 weighted，其余一律 priority。
    /// </summary>
    public static string ToRoutingStrategy(BsonDocument pool)
        => (pool.GetValue("StrategyType", BsonNull.Value) is { IsInt32: true } s ? s.AsInt32 : 0) == 4
            ? "weighted"
            : "priority";

    /// <summary>
    /// 这个池是不是它那个用途的兜底。搬过去就是模型上的「没点名时用它」。
    /// </summary>
    public static bool IsDefaultForType(BsonDocument pool)
        => pool.GetValue("IsDefaultForType", BsonNull.Value) is { IsBoolean: true } v && v.AsBoolean;

    /// <summary>
    /// 池成员 -> 一条线路的优先级。
    ///
    /// 池成员的 Priority 从 1 起、越小越优先；Offering 的 Priority 语义相同，原样搬。
    /// 缺失按 100（与新建 Offering 的默认一致），不按 0——0 会让这条线路无声地抢到队首。
    /// </summary>
    public static int MemberPriority(BsonDocument member)
        => member.GetValue("Priority", BsonNull.Value) is { IsInt32: true } p && p.AsInt32 > 0 ? p.AsInt32 : 100;

    /// <summary>
    /// 搬迁是否要跳过这个池。
    ///
    /// 跳过的两种：没有对外名（没人能调）、没有成员（搬过去是个空模型，只会让白名单里
    /// 多一条永远解析不出来的记录）。两种都要如实报出来，不能静默吞掉。
    /// </summary>
    public static string? SkipReason(BsonDocument pool)
    {
        if (ToPublicId(pool).Length == 0) return "池没有合法的对外标识（Code），搬过去也没有调用方能请求到它";
        var models = pool.GetValue("Models", BsonNull.Value);
        var count = models.IsBsonArray ? models.AsBsonArray.Count(x => x.IsBsonDocument) : 0;
        return count == 0 ? "池里一个成员都没有，搬过去只会多一条永远解析不出来的模型" : null;
    }
}
