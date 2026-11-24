using MongoDB.Bson;
using PrdAgent.LlmGw.LogicalModels;

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
    /// 用途 -> 这个用途最起码的那条能力。
    ///
    /// 只在池成员一条能力快照都没有时兜底。名字与 GatewayCapabilityContract 的词汇表同源，
    /// 写错一个词的后果是模型建出来了但能力门不放行——搬迁看着成功，调用方却调不到。
    /// </summary>
    private static string? BaselineCapability(string modelType) => modelType.Trim().ToLowerInvariant() switch
    {
        "generation" => "image_generation",
        "video-gen" or "video_gen" => "video_generation",
        "chat" => "chat",
        "intent" => "intent",
        "vision" => "vision",
        "code" => "code",
        "embedding" => "embedding",
        "rerank" => "rerank",
        "asr" => "asr",
        "tts" => "tts",
        _ => null,
    };

    /// <summary>
    /// 池成员的能力快照并集；一条都没有时退到这个用途的基线能力。
    ///
    /// 不能像最初那样传 null 进能力归一——那个函数只会把已有的 image_generation 展开成
    /// 场景能力集，传 null 得到的是空集合。空能力的模型建出来之后能力门一律不放行，
    /// 于是搬迁报成功、调用方却调不到它，请求默默回落到池。
    /// 这个洞是影子比对在真实环境上抓出来的，不是想出来的。
    /// </summary>
    public static IEnumerable<BsonDocument> Members(BsonDocument pool)
        => pool.GetValue("Models", BsonNull.Value) is { IsBsonArray: true } arr
            ? arr.AsBsonArray.Where(x => x.IsBsonDocument).Select(x => x.AsBsonDocument)
            : Enumerable.Empty<BsonDocument>();

    /// <summary>
    /// 单个池成员自己声明的那一份能力快照（原值，未归一）。
    ///
    /// 抽出来是因为「并起来是什么」与「每个成员各自是什么」是两个问题：并集决定模型的能力集，
    /// 而成员之间是否同质要逐个看。上一版只有并集，于是混着的池看不出来（第 65 轮 review）。
    /// </summary>
    public static List<string> MemberCapabilities(BsonDocument member)
    {
        var found = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (member.GetValue("Capabilities", BsonNull.Value) is not { IsBsonArray: true } caps) return found;
        foreach (var cap in caps.AsBsonArray.Where(x => x.IsBsonDocument).Select(x => x.AsBsonDocument))
        {
            // Value=false 是「明确不具备」，不是「没说」——不能当成具备
            if (cap.GetValue("Value", BsonNull.Value) is { IsBoolean: true } v && !v.AsBoolean) continue;
            var type = cap.GetValue("Type", BsonNull.Value) is { IsString: true } t ? t.AsString.Trim().ToLowerInvariant() : string.Empty;
            if (type.Length > 0 && seen.Add(type)) found.Add(type);
        }
        return found;
    }

    public static List<string> CollectCapabilities(BsonDocument pool)
    {
        var found = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var member in Members(pool))
        {
            foreach (var type in MemberCapabilities(member))
            {
                if (seen.Add(type)) found.Add(type);
            }
        }

        if (found.Count > 0) return found;
        var baseline = BaselineCapability(pool.GetValue("ModelType", BsonNull.Value) is { IsString: true } mt ? mt.AsString : string.Empty);
        return baseline is null ? new List<string>() : new List<string> { baseline };
    }

    /// <summary>
    /// 「近期」的界限。超过这个时长的失败不再作数。
    ///
    /// 24 小时不是拍的：熔断冷却是 120 秒，冷却期满后下一条真实请求就会去半开试探。
    /// 一条线路要在不可用上停留超过一天，只可能是这段时间根本没有流量走它——
    /// 那个「不可用」说的是上一次有人用它时的事，不是现在的事。
    /// </summary>
    public static readonly TimeSpan RecentFailureWindow = TimeSpan.FromHours(24);

    /// <summary>
    /// 这个池成员的健康状态要不要跟着搬过去，以及搬成哪一档。返回搬过去应写入的状态
    /// （0 健康 / 1 降级 / 2 熔断）。
    ///
    /// 两头都不对：
    ///   全搬 —— 18 天前失败过一次的线路，搬过去新路径一上来就少一条候选，而那个判断早就过期了。
    ///   全不搬 —— 新路径会去用一个池正在主动避开的上游，而它可能此刻真的是坏的。
    /// 两种都在这个仓库的真实数据上见过：default-generation 的 chatgpt-image-latest 优先级最高、
    /// 18 天前被单次 401 隔离，池一直跳过它；搬过去重置成健康之后，新路立刻选了它，
    /// 于是新旧两路解析不一致——这是影子比对抓出来的，不是想出来的。
    ///
    /// 判据取中间：失败发生在窗口内就照搬（它说的是现在），窗口外重置成健康（它说的是过去）。
    ///
    /// **降级那一档同样要搬**。上一版只认熔断，于是一个刚刚在失败、被池排在健康成员后面的
    /// 高优先级成员，搬过去是「健康 + 零失败」——挑选判据把健康排在降级之前
    /// （GatewayRouteSelection 的健康档），切换的那一刻它立刻重新拿到主流量。
    /// 判据比它该管的范围窄：只覆盖了「熔断」这一种输入，换成「降级」就给出相反答案。
    ///
    /// 返回值是状态而不是布尔：调用方要写的本来就是状态，返回布尔逼着每个调用方自己再
    /// 拼一次 `? 2 : 0`，第二种档位一加进来就得逐个改，而漏掉的那个不会报错。
    /// </summary>
    public static int CarryHealthStatus(BsonDocument member, DateTime nowUtc)
    {
        var status = member.GetValue("HealthStatus", BsonNull.Value) is { IsInt32: true } h ? h.AsInt32 : 0;
        if (status is not (1 or 2)) return 0;
        // 判不出「这个状态是什么时候的」就按过期处理，与熔断那一档同口径。
        if (member.GetValue("LastFailedAt", BsonNull.Value) is not { IsValidDateTime: true } failedAt) return 0;
        return nowUtc - failedAt.ToUniversalTime() <= RecentFailureWindow ? status : 0;
    }

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
        if (count == 0) return "池里一个成员都没有，搬过去只会多一条永远解析不出来的模型";
        return OperationOnlyConflictReason(pool);
    }

    /// <summary>
    /// 池里混着「动作能力成员」与「不具备那条动作能力的成员」时，搬迁必须拒绝，并说清怎么办。
    ///
    /// 为什么非拒不可：搬迁把成员能力**并**成模型的能力集，而动作能力（目前只有分层）一旦出现在
    /// 模型上就独占这个模型的服务对象——<see cref="LogicalModelCapabilityPolicy.SupportsAppCallerScenario"/>
    /// 第二句直接短路成「只认分层那个专用调用方」。于是一个「普通生图 + 分层」的混合池搬过去，
    /// 模型有可用线路、搬迁报成功，而原本能用这个池的每一个普通调用方全部被拒——
    /// 「存得进去、跑不起来」，而且没有任何地方会说为什么。
    ///
    /// 为什么不是「把动作能力丢掉」：那会让分层成员变成普通生图路由的候选（它需要一张输入图、
    /// 不吃提示词，选中即每次必败），同时悄悄弄丢分层这件事本身——静默降级换静默降级。
    /// 为什么不是「自动拆成两个模型」：拆出来的第二个模型叫什么、谁是它的默认、认领怎么分，
    /// 都不是搬迁能替人决定的。所以这里只拒绝并点名，拆由人做。
    /// </summary>
    public static string? OperationOnlyConflictReason(BsonDocument pool)
    {
        var members = Members(pool).ToList();
        if (members.Count == 0) return null;

        var perMember = members.Select(MemberCapabilities).ToList();
        if (!perMember.Any(caps => LogicalModelCapabilityPolicy.IsOperationOnly(null, caps))) return null;

        var without = perMember.Count(caps => !LogicalModelCapabilityPolicy.IsOperationOnly(null, caps));
        if (without == 0) return null;

        return $"池里混着动作能力成员与普通成员（不具备 {LogicalModelCapabilityPolicy.ImageLayering} 的成员有 {without} 个）："
             + "搬过去这些能力会并成同一个模型的能力集，而动作能力一旦落在模型上就只认它自己那个专用调用方，"
             + "原本用这个池的普通调用方会全部被拒。请先把动作能力成员拆到单独的池里，再重跑搬迁。";
    }
}
