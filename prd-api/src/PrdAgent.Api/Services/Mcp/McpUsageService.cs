using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.Mcp;

/// <summary>
/// 闸门结论。放行时带上占了多少坑，调用失败要按这个退还。
///
/// <see cref="ReservedDay"/> 是**占坑那一刻**的 UTC 日，退还时必须按它算计数器 id：
/// 一次调用在午夜前占坑、午夜后才失败的话，按「现在是哪天」退会把新一天的计数器减成负数
/// （旧那天的坑还占着），那把密钥当天就能超额。
/// </summary>
public sealed record McpQuotaVerdict(
    bool Allowed, string? Reason, string? ReservedKind = null, int ReservedAmount = 0, DateTime ReservedDay = default,
    bool SuppressLog = false)
{
    public static readonly McpQuotaVerdict Ok = new(true, null);
    public static McpQuotaVerdict Reserved(string kind, int amount, DateTime day) => new(true, null, kind, amount, day);
    public static McpQuotaVerdict Deny(string reason) => new(false, reason);

    /// <summary>拒绝，且这一条不必再落审计（同一分钟内已经落过一条同类拒绝）。</summary>
    public static McpQuotaVerdict DenyQuietly(string reason) => new(false, reason, SuppressLog: true);
}

/// <summary>
/// 接入台的用量闸门与调用记录。
///
/// 闸门管三件事，都是「智能体跑飞了会撞上、人正常用撞不上」的量级：
///   - 每日生图张数（默认 50）：生图直接烧模型额度，没有上限时一个循环就能把一天烧光
///   - 每日写入次数（默认 200）：建站、写文档这类会留下东西的动作
///   - 每分钟调用次数（默认 60）：挡住重试风暴
///
/// 三个上限都能按密钥单独调（AgentApiKey.Mcp* 字段），空值走默认。
///
/// 日额度是**先原子占坑、失败再退还**，不是「查历史再放行」：后者在并发下每个请求都读到
/// 同一个旧值，一把 50 张的密钥能同时放行上百个生图，闸门等于没有。占坑走 McpUsageCounter
/// 的 $inc + upsert，一次操作拿到新值，超了就把自己那份退回去。
///
/// 日界按 UTC 自然日切 —— 与记录里的 CreatedAt 同一把尺子；用户看到的「今日」也按这个口径，
/// 面板上要写明白，别让人以为是本地零点。
///
/// 速率窗口是**进程内**的：多实例部署时每个实例各算各的。这不是漏洞是取舍 ——
/// 日额度走 Mongo（跨实例准确），分钟级只为挡住失控循环，不值得为它引入分布式计数。
/// </summary>
public sealed class McpUsageService
{
    public const int DefaultDailyImageQuota = 50;
    public const int DefaultDailyWriteQuota = 200;
    public const int DefaultRateLimitPerMin = 60;

    public const string KindImage = "image";
    public const string KindWrite = "write";

    private readonly MongoDbContext _db;
    private readonly ILogger<McpUsageService> _logger;

    /// <summary>keyId → (当前分钟起点, 该分钟内已调用次数)</summary>
    private static readonly ConcurrentDictionary<string, (DateTime MinuteStart, int Count)> RateWindows = new();

    /// <summary>
    /// 「这把密钥这一分钟已经为超限落过审计了」的原子标记，键是 keyId|分钟。
    ///
    /// 单独一张表、用 TryAdd 判胜负，而不是塞进 RateWindows 的元组里靠更新委托设标志：
    /// ConcurrentDictionary 的更新委托在竞争下**可能被调用多次**、失败的那几次结果会被丢弃，
    /// 在里面写副作用（或捕获局部变量当结论）会让多个调用方同时认为自己是第一个 ——
    /// 于是「一分钟只落一条」退化成「每个并发都落一条」，等于没限。
    /// TryAdd 对同一个键全局只成功一次，这才是真正的原子胜出。
    ///
    /// 值存的是那一分钟的起点，供 <see cref="SweepRateStateIfDue"/> 判过期用 —— 键里虽然也有
    /// ticks，但从字符串里回解时间是「同一件事存两份」，改一处忘一处就漂了。
    /// </summary>
    private static readonly ConcurrentDictionary<string, DateTime> RateDenialLogged = new();

    /// <summary>上一次清扫过期速率状态的时刻（进程内，UTC ticks）。</summary>
    private static long _lastRateSweepTicks = DateTime.UtcNow.Ticks;

    /// <summary>清扫间隔与保留窗口：只留最近两分钟，其余都是死数据。</summary>
    private static readonly TimeSpan RateSweepInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RateStateRetention = TimeSpan.FromMinutes(2);

    public McpUsageService(MongoDbContext db, ILogger<McpUsageService> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 某工具算不算「写入类动作」。默认按工具定义的 HTTP 方法推（非 GET 即写入），不另维护一张名单；
    /// 但工具可以用 <see cref="McpToolDef.WritesData"/> 显式改写 —— 动词不等于语义，
    /// 取用技能是 POST 却本质是读，按动词判会让只读客户端被写入额度挡住。
    /// </summary>
    public static bool IsWriteTool(McpToolDef tool) =>
        tool.WritesData ?? !string.Equals(tool.Method, "GET", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 这次调用会不会「做出/取到一件东西」（决定记录里给不给可点开的产物地址）。
    ///
    /// **与 <see cref="IsWriteTool"/> 是两件事，别合用一个值。** 后者管的是扣不扣写入额度，
    /// 可以被 WritesData 按语义压掉：取用技能是 POST 但本质是读，不该占额度 ——
    /// 可它确实把一个技能包取到了用户名下，还回了 zip 地址，那就是一件实实在在的产物。
    /// 两者合成一个值的话，fork 的记录会丢掉下载地址，用户点不开自己刚取的东西。
    /// 判据回到 HTTP 动词：非 GET 即「这次动了什么」。
    /// </summary>
    public static bool ProducesArtifacts(McpToolDef tool) =>
        !string.Equals(tool.Method, "GET", StringComparison.OrdinalIgnoreCase);

    public static bool IsImageTool(McpToolDef tool) =>
        string.Equals(tool.Name, "map_visual_generate_image", StringComparison.Ordinal);

    public static DateTime TodayStartUtc() => DateTime.UtcNow.Date;

    /// <summary>
    /// 只过分钟级速率窗口，不碰日额度。
    ///
    /// 必须能单独调，因为**被拒的调用也要计次**：工具名不存在、scope 不足、不在白名单，
    /// 这些路径都在「知道这是哪个工具」之前就返回了，够不着按工具分类的日额度，
    /// 但它们每一次都要查一遍登记表、写一行审计记录。速率闸如果排在工具解析之后，
    /// 一个拿着合法密钥的客户端刷不存在的工具名就能绕开它，把审计集合刷爆。
    /// </summary>
    public async Task<McpQuotaVerdict> CheckRateAsync(string keyId, CancellationToken ct)
    {
        var key = await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
        var ratePerMin = key?.McpRateLimitPerMin ?? DefaultRateLimitPerMin;

        var now = DateTime.UtcNow;
        var minute = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, DateTimeKind.Utc);
        // 更新委托保持无副作用：它在竞争下可能被调用多次，任何写在里面的结论都不可信。
        var window = RateWindows.AddOrUpdate(keyId,
            _ => (minute, 1),
            (_, cur) => cur.MinuteStart == minute ? (minute, cur.Count + 1) : (minute, 1));

        SweepRateStateIfDue(now);

        if (window.Count <= ratePerMin) return McpQuotaVerdict.Ok;

        var reason = $"调用太频繁：这把密钥每分钟最多 {ratePerMin} 次工具调用，请等一分钟再试。";
        // 一分钟内只为超限落一条审计。每一条都落的话，限流就保护不了它本来要保护的那张表：
        // 被挡住的洪水照样一条一条写进去。第一条留着，用户才看得到「被限流了」这件事。
        // 胜负由 TryAdd 定 —— 同一个键全局只成功一次，并发的其余调用方一律拿到 false。
        var firstDenial = RateDenialLogged.TryAdd($"{keyId}|{minute.Ticks}", minute);
        return firstDenial ? McpQuotaVerdict.Deny(reason) : McpQuotaVerdict.DenyQuietly(reason);
    }

    /// <summary>
    /// 清掉过期的速率窗口与拒绝标记。
    ///
    /// 两张表都以 keyId 为键，进程不重启就一直留着：密钥可以被撤销、被硬删，也可以被反复轮换，
    /// 而条目只增不减 —— 换句话说，内存占用跟「这个进程见过多少把密钥」成正比，没有上限。
    /// 密钥创建本身不设上限，所以正常轮换或者一个客户端反复建删就能把它撑起来。
    ///
    /// 只由抢到这一轮的那个调用方来扫（CompareExchange 定胜负），其余调用方原样往下走，
    /// 不为清扫付等待成本。删除用 KeyValuePair 重载：值变了说明这把密钥刚刚又被用过，那就别删，
    /// 否则会把它当前这一分钟的计数清零、白送一轮额度。
    /// </summary>
    private static void SweepRateStateIfDue(DateTime now)
    {
        var lastTicks = Interlocked.Read(ref _lastRateSweepTicks);
        if (now - new DateTime(lastTicks, DateTimeKind.Utc) < RateSweepInterval) return;
        if (Interlocked.CompareExchange(ref _lastRateSweepTicks, now.Ticks, lastTicks) != lastTicks) return;

        foreach (var kv in RateWindows)
            if (IsStaleRateState(kv.Value.MinuteStart, now))
                RateWindows.TryRemove(kv);
        foreach (var kv in RateDenialLogged)
            if (IsStaleRateState(kv.Value, now))
                RateDenialLogged.TryRemove(kv);
    }

    /// <summary>
    /// 这条速率状态是不是已经过期、该清掉。纯函数，两张表读同一个判据，也让守卫钉得住保留窗口 ——
    /// 窗口被谁改短到一分钟以内，正在计数的当前分钟就会被自己扫掉，等于速率闸周期性失效。
    /// </summary>
    internal static bool IsStaleRateState(DateTime entryMinute, DateTime now) =>
        entryMinute < now - RateStateRetention;

    /// <summary>
    /// 日额度的原子占坑。放行时若占了坑，调用失败要用 <see cref="ReleaseAsync"/> 退还。
    /// 返回不允许时，Reason 是直接给智能体看的中文说明（它会转述给用户）。
    ///
    /// 速率窗口已由 <see cref="CheckRateAsync"/> 在更早处过掉，这里不再重复计次 ——
    /// 一次调用只该占一格速率。
    ///
    /// 入参就是**记录里记的那两个值**（<c>McpCallLog.ImageCount</c> / <c>IsWrite</c>），不是工具定义 ——
    /// 早先这里收 McpToolDef?，动态工具没有定义只能传 null，于是走到「tool == null 直接放行」那一支：
    /// 一把日写入上限为 1 的密钥，用登记表里的 POST 接口可以无限写，而面板上的已用数一直是 0。
    /// 闸门与账本读同一个值，才不会出现「记了但没扣」。
    /// </summary>
    /// <param name="imageCount">这次要生几张图；&gt; 0 即按生图计额度。</param>
    /// <param name="isWrite">这次算不算写入类动作（非生图时才看它）。</param>
    public async Task<McpQuotaVerdict> CheckAsync(string keyId, int imageCount, bool isWrite, CancellationToken ct)
    {
        var key = await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);

        // 日额度：原子占坑
        if (imageCount > 0)
        {
            var quota = key?.McpDailyImageQuota ?? DefaultDailyImageQuota;
            var amount = imageCount;
            var day = TodayStartUtc();
            var (ok, used) = await TryReserveAsync(keyId, KindImage, amount, quota, day, ct);
            if (!ok)
                return McpQuotaVerdict.Deny(
                    $"今天的生图额度用完了（已用 {used}/{quota} 张，按 UTC 自然日计）。可以在密钥管理里把这把密钥的上限调高，或者明天再来。");
            return McpQuotaVerdict.Reserved(KindImage, amount, day);
        }

        if (isWrite)
        {
            var quota = key?.McpDailyWriteQuota ?? DefaultDailyWriteQuota;
            var day = TodayStartUtc();
            var (ok, used) = await TryReserveAsync(keyId, KindWrite, 1, quota, day, ct);
            if (!ok)
                return McpQuotaVerdict.Deny(
                    $"今天的写入额度用完了（已用 {used}/{quota} 次，按 UTC 自然日计）。可以在密钥管理里把这把密钥的上限调高。");
            return McpQuotaVerdict.Reserved(KindWrite, 1, day);
        }

        return McpQuotaVerdict.Ok;
    }

    /// <summary>原子占坑：$inc + upsert 一次拿到新值；超限就把自己那份退回去。</summary>
    private async Task<(bool Ok, int Used)> TryReserveAsync(
        string keyId, string kind, int amount, int quota, DateTime day, CancellationToken ct)
    {
        var id = BuildCounterId(keyId, day, kind);
        var update = Builders<McpUsageCounter>.Update
            .Inc(x => x.Count, amount)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .SetOnInsert(x => x.KeyId, keyId)
            .SetOnInsert(x => x.Kind, kind)
            .SetOnInsert(x => x.DayUtc, day);

        var after = await _db.McpUsageCounters.FindOneAndUpdateAsync<McpUsageCounter>(
            x => x.Id == id,
            update,
            new FindOneAndUpdateOptions<McpUsageCounter, McpUsageCounter>
            {
                IsUpsert = true,
                ReturnDocument = ReturnDocument.After,
            },
            ct);

        var used = after?.Count ?? amount;
        if (used <= quota) return (true, used);

        // 超了：退还自己占的这份，返回「占坑前已用多少」给文案用
        await ReleaseAsync(keyId, kind, amount, day, ct);
        return (false, Math.Max(used - amount, 0));
    }

    /// <summary>
    /// 退还占坑（调用没真的发生时）。退到负数没有意义，这里只做减法，读的时候按下限 0 取。
    ///
    /// <paramref name="reservedDay"/> 必须是**占坑那一刻**的 UTC 日，不能现算：
    /// 午夜前占坑、午夜后失败时，现算会去减新一天的计数器（减成负数），而旧那天的坑没退 ——
    /// 一边白扣了昨天的额度，一边把今天的闸门放松了。
    /// </summary>
    public async Task ReleaseAsync(string keyId, string kind, int amount, DateTime reservedDay, CancellationToken ct)
    {
        if (amount <= 0 || string.IsNullOrEmpty(kind)) return;
        try
        {
            var day = reservedDay == default ? TodayStartUtc() : reservedDay.Date;
            var id = BuildCounterId(keyId, day, kind);
            // 同 LogAsync：退还是服务端自己的收尾动作，不跟客户端的取消令牌走，
            // 否则客户端一断开就退不回去，用户白扣一天额度。
            await _db.McpUsageCounters.UpdateOneAsync(
                x => x.Id == id,
                Builders<McpUsageCounter>.Update.Inc(x => x.Count, -amount).Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            // 退不回去只会让今天的额度偏紧，绝不能因此把已经跑完的调用报成失败
            _logger.LogWarning(ex, "[mcp] 退还配额失败 key={KeyId} kind={Kind} amount={Amount}", keyId, kind, amount);
        }
    }

    /// <summary>今日已用（面板展示口径与闸门同源，读的是同一份计数器）。</summary>
    public async Task<(int Images, int Writes)> GetTodayUsageAsync(string keyId, CancellationToken ct)
    {
        var map = await GetTodayUsageAsync(new[] { keyId }, ct);
        return map.TryGetValue(keyId, out var u) ? u : (0, 0);
    }

    /// <summary>
    /// 一次把多把密钥的今日已用查回来。
    ///
    /// 面板要为每把密钥显示已用数，逐把查就是一把密钥一次往返 —— 密钥数量没有上限
    /// （撤销的还要留着算历史），键多了首屏就得等上几百次往返。计数器 id 是确定性的，
    /// 一条 In 查询取回来在内存里分组即可。
    /// </summary>
    public async Task<Dictionary<string, (int Images, int Writes)>> GetTodayUsageAsync(
        IReadOnlyCollection<string> keyIds, CancellationToken ct)
    {
        var result = new Dictionary<string, (int Images, int Writes)>(StringComparer.Ordinal);
        if (keyIds.Count == 0) return result;

        var day = TodayStartUtc();
        var idToKey = new Dictionary<string, (string KeyId, string Kind)>(StringComparer.Ordinal);
        foreach (var keyId in keyIds)
        {
            foreach (var kind in new[] { KindImage, KindWrite })
                idToKey[BuildCounterId(keyId, day, kind)] = (keyId, kind);
            result[keyId] = (0, 0);
        }

        var docs = await _db.McpUsageCounters
            .Find(Builders<McpUsageCounter>.Filter.In(x => x.Id, idToKey.Keys))
            .ToListAsync(ct);
        foreach (var d in docs)
        {
            if (!idToKey.TryGetValue(d.Id, out var owner)) continue;
            var cur = result[owner.KeyId];
            var v = Math.Max(d.Count, 0);
            result[owner.KeyId] = owner.Kind == KindImage ? (v, cur.Writes) : (cur.Images, v);
        }
        return result;
    }

    /// <summary>
    /// 计数器 id 必须带**部署作用域**。
    ///
    /// 同一个 CDS 项目下所有分支预览与生产共用一个 Mongo 库，连 AgentApiKey 那几行都是同一份
    /// （cross-project-isolation 通道 4/8）。id 只由「密钥 + 日期 + 类别」组成的话，
    /// 在预览上跑几张图，扣的是那把密钥在**所有部署**上的当日额度 —— 生产那边可能一整天再也
    /// 生不出图，而且面板的调用数（已按部署过滤）和已用数（没过滤）对不上。
    ///
    /// 取 CurrentDurable 不取 Current：Current 带 commit revision，是给「入队 fencing」用的
    /// （防止滚动发布时旧 worker 抢新任务）；额度是按天的预算，不该因为重新部署一次就清零。
    /// 生产/本地作用域为 null，id 保持原样（与存量兼容）。
    /// </summary>
    internal static string BuildCounterId(string keyId, DateTime dayUtc, string kind)
        => BuildCounterId(keyId, dayUtc, kind, DeploymentScope.CurrentDurable);

    /// <summary>纯函数版：作用域由调用方给。守卫测试打这一个，不去改进程 env（那会跨用例串味）。</summary>
    internal static string BuildCounterId(string keyId, DateTime dayUtc, string kind, string? deploymentScope)
    {
        var baseId = $"{keyId}:{dayUtc:yyyyMMdd}:{kind}";
        return deploymentScope is null ? baseId : $"{deploymentScope}::{baseId}";
    }

    /// <summary>
    /// 写一条调用记录。记录失败绝不影响工具调用本身 —— 记账坏了不能把业务打挂。
    ///
    /// 落库**不跟客户端的取消令牌走**：MCP 客户端超时断开时下游动作照跑（LoopbackAsync 用的是
    /// CancellationToken.None），这时候拿一个已取消的令牌去写记录，副作用发生了、账没记上，
    /// 审计面板和配额都看不到它。服务端自己的动作用服务端自己的令牌（server-authority）。
    /// </summary>
    public async Task LogAsync(McpCallLog log, CancellationToken ct = default)
    {
        try
        {
            // 稳定分支作用域，不带 commit revision：Current 每次重新部署都变，
            // 而查询是精确等值匹配 —— 用它的话，同一条分支每部署一次，之前的调用记录就
            // 从面板上整批消失、今日计数归零，尽管审计行还在库里躺着。
            // 隔离要的是「别的分支/生产的记录不要混进来」，不是「上一次部署的记录也不算数」。
            log.DeploymentSlug = DeploymentScope.CurrentDurable;
            await _db.McpCallLogs.InsertOneAsync(log, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[mcp] 写调用记录失败 tool={Tool} key={KeyId}", log.ToolName, log.KeyId);
        }
    }

    /// <summary>入参摘要：够用户看懂它当时要干什么，又不至于把整篇正文存进记录。</summary>
    public static string? SummarizeArguments(JsonObject? args)
    {
        if (args == null || args.Count == 0) return null;
        var parts = new List<string>();
        foreach (var kv in args)
        {
            var v = kv.Value?.ToJsonString() ?? "null";
            if (v.Length > 120) v = v[..120] + "…";
            parts.Add($"{kv.Key}={v}");
            if (parts.Count >= 6) break;
        }
        var text = string.Join(" · ", parts);
        return text.Length > 600 ? text[..600] + "…" : text;
    }
}
