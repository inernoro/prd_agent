using System.Collections.Concurrent;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 开场问题自动生成。
///
/// 单例 + 自建 scope：调用点全在请求路径上（开启提问、重新上传、访客打开分享页），
/// 谁都不该为了几句开场问题多等一次模型调用。同一个站点同时只跑一个，靠 in-flight
/// 集合去重；跑不成功不写任何东西——**宁可这一栏整块不出现，也不摆五句「关于本页
/// 你想了解什么」这种放到任何页面都成立的空话**（no-rootless-tree）。
/// </summary>
public class AskOpeningQuestionGenerator : IAskOpeningQuestionGenerator
{
    /// <summary>喂给模型的正文上限。开场问题只需要读懂这页在讲什么，不需要全文。</summary>
    private const int PromptTextBudget = 6000;

    /// <summary>一次生成的超时。超了就当这次没成——下次有人打开页面还会再排一次。</summary>
    private static readonly TimeSpan GenerationTimeout = TimeSpan.FromSeconds(45);

    private const string SystemPrompt =
        """
        你是网页托管平台的助手。用户上传了一个网页，访客打开它之后可以对着这一页提问。
        你的任务：读一遍这页的正文，写出访客最可能问的 5 个问题。

        要求：
        1. 每一句都必须能**只依据这页正文回答**。正文里没写的（作者是谁、什么时候上线、行业怎么样）一律不要问。
        2. 问具体的东西：具体结论、具体数字、具体某一节为什么这么定。不要「这篇讲了什么」这种放到任何页面都成立的空话。
        3. 用访客的口气，每句不超过 25 个字，问号结尾。
        4. 五句之间不要互相重复，覆盖这页不同的部分。
        5. 如果正文没有实质内容（只有导航、版权、乱码、空白），返回空数组 []。

        只返回一个 JSON 字符串数组，不要有任何别的文字，不要加代码围栏。
        例：["这次改版的结论是什么？","哪几项还没修完？","搜索入口为什么算未通过？","34 项走查通过了多少？","导航收敛后剩下的去哪了？"]
        """;

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<AskOpeningQuestionGenerator> _logger;

    /// <summary>正在跑的站点。同一个站点被并发打开多次时只跑一次，不然是按访客数烧钱。</summary>
    private readonly ConcurrentDictionary<string, byte> _inFlight = new();

    /// <summary>
    /// 模型这一侧失败（调不通 / 一个字都没回）之后的冷静期。
    ///
    /// 这类失败**不盖版本戳**——盖了就等于把「网关这会儿没配好模型池」当成了这一版正文的
    /// 永久结论，池子配好之后它也不会再试。可不盖戳又意味着每个访客打开页面都会重排一次，
    /// 于是用一个进程内冷静期兜住：自动路径十分钟内不重试，owner 手点「重新生成」不受它约束。
    /// </summary>
    private static readonly TimeSpan FailureCooldown = TimeSpan.FromMinutes(10);
    private readonly ConcurrentDictionary<string, DateTime> _cooldownUntil = new();

    public AskOpeningQuestionGenerator(IServiceScopeFactory scopes, ILogger<AskOpeningQuestionGenerator> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    /// <summary>
    /// 这个站点现在需不需要生成。
    ///
    /// 抽成公开静态纯函数是因为它是本功能唯一的判据，而调用点有三处：入队前的快速筛（省掉
    /// 绝大多数无谓的 Task）、真正执行前的复查（入队到执行之间 owner 可能刚好改了配置）、
    /// 以及单测。三处各写一遍就是 predicate-and-wiring-discipline 形状 3。
    /// </summary>
    public static bool NeedsGeneration(HostedSite site)
    {
        // 提问没开就不生成：AskEnabled 默认 false，为所有上传都跑一遍模型是纯浪费。
        // 代价是 owner 开启提问的那一刻才开始算，几秒后才到位——这几秒他正在配置面板里。
        if (!site.AskEnabled) return false;
        // owner 动过手就永不覆盖：他改的几句被静默冲掉是最难查的一类缺陷
        if (string.Equals(site.AskQuestionsSource, "manual", StringComparison.OrdinalIgnoreCase)) return false;
        // 这一版正文已经算过（哪怕算出来是空）就不重算。一次上传一次调用，正文没变不重跑。
        var version = site.ContentVersion == default ? site.CreatedAt : site.ContentVersion;
        return site.AskQuestionsGeneratedFor != version;
    }

    public void QueueEnsure(HostedSite site)
    {
        if (!NeedsGeneration(site)) return;
        if (_cooldownUntil.TryGetValue(site.Id, out var until) && DateTime.UtcNow < until) return;
        if (!_inFlight.TryAdd(site.Id, 0)) return;

        // 刻意不 await：调用方全在请求路径上。异常在里面就地吞掉并记日志——
        // 题库是增值功能，它失败不该让「开启提问」或「打开分享页」跟着失败。
        _ = Task.Run(async () =>
        {
            try
            {
                await RunAsync(site.Id, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[AskOpeners] 站点 {SiteId} 开场问题生成失败", site.Id);
            }
            finally
            {
                _inFlight.TryRemove(site.Id, out _);
            }
        });
    }

    /// <summary>
    /// owner 明确点「重新生成」走这条：同步等结果，不像 <see cref="QueueEnsure"/> 那样甩到后台。
    ///
    /// 但它必须和后台那条抢**同一把** <c>_inFlight</c> 锁。不抢的话有两种真实撞法：
    /// 连点两次重新生成、或者重新生成正好撞上一次后台生成——两次执行都会读到刚被清掉的
    /// 版本戳、各自完整烧一次模型调用，owner 被计两次费，最后谁写完算谁的。类注释里
    /// 「同一站点同时只跑一次」的不变量，只有 QueueEnsure 守着就是形状 2：门只装了一半。
    ///
    /// 抢不到就如实返回 <see cref="AskOpenerOutcome.Busy"/>，不排队等：让 owner 知道
    /// 「已经在跑了」比让他对着转圈等一次别人的调用更清楚（expectation-management）。
    /// </summary>
    public async Task<AskOpenerOutcome> EnsureAsync(string siteId, CancellationToken ct = default)
    {
        if (!_inFlight.TryAdd(siteId, 0)) return AskOpenerOutcome.Busy;
        try
        {
            return await RunAsync(siteId, ct);
        }
        finally
        {
            _inFlight.TryRemove(siteId, out _);
        }
    }

    private async Task<AskOpenerOutcome> RunAsync(string siteId, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<MongoDbContext>();

        // 重新读一遍而不是用入队时那份：入队到执行之间 owner 可能刚好关了提问、
        // 或者自己填了几条题。拿旧快照判断就会把他刚写的覆盖掉。
        var site = await db.HostedSites.Find(s => s.Id == siteId).FirstOrDefaultAsync(ct);
        if (site == null || !NeedsGeneration(site)) return AskOpenerOutcome.Skipped;

        var version = site.ContentVersion == default ? site.CreatedAt : site.ContentVersion;

        var snapshots = sp.GetRequiredService<ISiteContentSnapshotService>();
        var snapshot = await snapshots.GetAsync(site, ct);
        if (!string.IsNullOrEmpty(snapshot.Unavailable) || string.IsNullOrWhiteSpace(snapshot.Text))
        {
            // 「这页确实没有正文」和「这次没读回来」是两件事，盖不盖版本戳完全相反。
            //
            // 快照服务已经把这个区别算出来了：对象存储抖一下时它置 TransientFailure=true
            // 并且**拒绝缓存**这份空快照（SiteContentSnapshotService 里那段注释写得很清楚）。
            // 这里如果对所有 Unavailable 一律盖戳，就把它那半边保护当场抵消掉——存储恢复之后
            // 没有任何人会再排一次生成，这个站点要等到正文变了或者 owner 手动点重新生成
            // 才有开场问题。判据太窄的典型：把「暂时」和「永久」压成同一个分支。
            if (snapshot.TransientFailure)
            {
                _logger.LogWarning("[AskOpeners] 站点 {SiteId} 这次没读回正文（暂时性），不盖版本戳，留给下次重试：{Reason}",
                    siteId, snapshot.Unavailable);
                return AskOpenerOutcome.ModelUnavailable;
            }

            // 确定读不出正文（纯视频/纯图包装站等）才盖版本戳：不盖的话，每个打开这个页面的
            // 人都会再排一次生成，而结论永远是同一个「读不出来」。
            var stampedEmpty = await StampAsync(db, siteId, version, questions: null, ct);
            _logger.LogInformation("[AskOpeners] 站点 {SiteId} 读不到正文，跳过生成：{Reason}",
                siteId, snapshot.Unavailable ?? "正文为空");
            return stampedEmpty ? AskOpenerOutcome.NoContent : AskOpenerOutcome.Superseded;
        }

        var text = snapshot.Text.Length > PromptTextBudget ? snapshot.Text[..PromptTextBudget] : snapshot.Text;

        var gateway = sp.GetRequiredService<ILlmGateway>();
        var ctxAccessor = sp.GetRequiredService<ILLMRequestContextAccessor>();
        var requestId = Guid.NewGuid().ToString("N");

        // 网关取不到 UserId 会以 "User not found" 的形式炸在运行时（llm-gateway 规则）。
        // 这条调用没有请求上下文（是后台任务），身份记在站点 owner 账上——
        // 这批题是为他的站点生成的，账单归属也是对的。
        // 变量名不能叫 _：本方法后面有 `_cooldownUntil.TryRemove(siteId, out _)`，
        // 而 `_` 一旦被 using 变量占用，那个 out 就不再是弃元、直接编译错（CS1657）。
        using var llmScope = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: site.OwnerUserId,
            ViewRole: null,
            DocumentChars: text.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"[WEB_HOSTING_ASK_OPENERS:site={siteId}]",
            RequestType: "intent",
            AppCallerCode: AppCallerRegistry.Admin.WebHosting.AskOpeners));

        var client = gateway.CreateClient(
            AppCallerRegistry.Admin.WebHosting.AskOpeners,
            ModelTypes.Intent,
            maxTokens: 512,
            // 开场问题要贴着正文走，不是创作：温度压低，减少发散
            temperature: 0.3);

        var raw = new StringBuilder();
        var callFailed = false;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(GenerationTimeout);

        var userContent = $"网页标题：{site.Title}\n\n网页正文：\n{text}";
        try
        {
            await foreach (var chunk in client.StreamGenerateAsync(
                SystemPrompt,
                new List<LLMMessage> { new() { Role = "user", Content = userContent } },
                cts.Token))
            {
                // 网关把失败报成 error chunk 而不是抛异常（GatewayLLMClient / HttpLlmClient
                // 都是这么发的）。只读 delta 的话，「先吐了几个字再断」会被当成正常回答：
                // callFailed 仍是 false、raw 非空，于是残句被拿去解析，解析不出就盖戳——
                // 正是下面那段注释说的「把一次网关故障固化成这一版正文的永久结论」。
                if (chunk.Type == "error")
                {
                    callFailed = true;
                    _logger.LogWarning("[AskOpeners] 站点 {SiteId} 流中途报错：{Error}", siteId, chunk.ErrorMessage);
                    break;
                }
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                    raw.Append(chunk.Content);
            }
        }
        catch (Exception ex)
        {
            callFailed = true;
            _logger.LogWarning(ex, "[AskOpeners] 站点 {SiteId} 调模型失败", siteId);
        }

        // 「一个字都没回」与「回了但没法用」是两件事，处理方式必须不同。
        // 前者是模型这一侧的问题（没配模型池、网关不通、超时）——**不盖戳**，
        // 否则等于把一次网关故障固化成这一版正文的永久结论，池子配好之后也不会再试。
        // 真栽过：验收当天这套部署 model_groups 是空的，一次自动生成就把版本戳盖死了。
        if (callFailed || raw.Length == 0)
        {
            _cooldownUntil[siteId] = DateTime.UtcNow + FailureCooldown;
            _logger.LogWarning("[AskOpeners] 站点 {SiteId} 模型没有任何输出，不盖版本戳，{Minutes} 分钟后自动重试",
                siteId, FailureCooldown.TotalMinutes);
            return AskOpenerOutcome.ModelUnavailable;
        }

        var questions = AskOpeningQuestions.ParseGenerated(raw.ToString());
        if (questions.Count == 0)
        {
            // 模型确实答了、只是答的没法用 —— 这个是盖戳的：同一份正文再问同一个模型
            // 不会有别的结果，只会按访客数重复烧钱。正文换了（版本变了）自然会再试一次，
            // owner 也随时可以点「重新生成」破掉这个戳。
            var stampedUnusable = await StampAsync(db, siteId, version, questions: null, ct);
            _logger.LogInformation("[AskOpeners] 站点 {SiteId} 模型没给出可用问题，这一栏保持为空", siteId);
            return stampedUnusable ? AskOpenerOutcome.ModelUnusable : AskOpenerOutcome.Superseded;
        }

        _cooldownUntil.TryRemove(siteId, out _);

        if (!await StampAsync(db, siteId, version, questions, ct))
        {
            // 这几秒里站点被重传、或者别人把题库改成手写了。整笔没写是对的（这批题按旧口径算），
            // 但不能报 Generated——那会让端点回 generated=true、抽屉把手上这批标成系统生成的。
            _logger.LogInformation("[AskOpeners] 站点 {SiteId} 生成期间被顶掉，这一批 {Count} 条题未落库",
                siteId, questions.Count);
            return AskOpenerOutcome.Superseded;
        }

        _logger.LogInformation("[AskOpeners] 站点 {SiteId} 生成了 {Count} 条开场问题", siteId, questions.Count);
        return AskOpenerOutcome.Generated;
    }

    /// <summary>
    /// 写回结果并盖上「这一版正文已经算过」的戳。
    ///
    /// 更新条件带上 AskQuestionsSource != manual：从入队到写回之间 owner 可能刚好保存了
    /// 自己的题库，那一瞬间的写入不能被这次后台生成盖掉（读-改-写的经典竞态，
    /// 判据必须落在 filter 上，而不是只在内存里判过一次就算数）。
    /// </summary>
    /// <summary>
    /// 落库并盖版本戳。返回**这一笔到底写没写进去**。
    ///
    /// 过滤器有可能一条都不匹配（下面注释说的那两种情况），那时整笔不写是对的，但调用方
    /// 必须知道——不然它会接着返回 Generated，端点回 generated=true，抽屉把手上这批题
    /// 标成「系统读正文生成」，而库里一个字都没变。判据挡住了坏写入，结论却在撒谎。
    /// </summary>
    private static async Task<bool> StampAsync(
        MongoDbContext db, string siteId, DateTime version, List<string>? questions, CancellationToken ct)
    {
        // questions 为 null 表示「这一版正文得不出题」（读不出正文 / 模型答的没法用）。
        // 那也得把题库清空，不能原样留着：站点重传成不相干的内容之后，版本戳指向新正文，
        // 而分享出去的页面还在展示按旧正文写的问题——那是在拿旧内容的口径描述新页面。
        var update = Builders<HostedSite>.Update
            .Set(s => s.AskQuestionsGeneratedFor, version)
            .Set(s => s.AskQuestionsSource, "auto")
            .Set(s => s.AskSuggestedQuestions, questions ?? new List<string>());

        // 过滤器还要求「正文版本没变过」。生成要跑几秒，这期间站点可能被重传：
        // 那时 ContentVersion 已经翻到新的一版，而这一发算出来的题是按旧正文写的，
        // 盖上去等于用旧内容的口径描述新页面，还会把版本戳推到新版、堵住下一次自动生成。
        // 版本对不上就整笔不写——NeedsGeneration 随即判「这一版没算过」，下一次
        // QueueEnsure（重传、改配置、访客打开分享）会重新按新正文生成。
        var result = await db.HostedSites.UpdateOneAsync(
            s => s.Id == siteId
                 && s.AskQuestionsSource != "manual"
                 && (s.ContentVersion == version || (s.ContentVersion == default && s.CreatedAt == version)),
            update,
            cancellationToken: ct);
        return result.MatchedCount > 0;
    }
}
