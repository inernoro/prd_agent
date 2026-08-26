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

    public async Task<bool> EnsureAsync(string siteId, CancellationToken ct = default)
        => await RunAsync(siteId, ct);

    private async Task<bool> RunAsync(string siteId, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<MongoDbContext>();

        // 重新读一遍而不是用入队时那份：入队到执行之间 owner 可能刚好关了提问、
        // 或者自己填了几条题。拿旧快照判断就会把他刚写的覆盖掉。
        var site = await db.HostedSites.Find(s => s.Id == siteId).FirstOrDefaultAsync(ct);
        if (site == null || !NeedsGeneration(site)) return false;

        var version = site.ContentVersion == default ? site.CreatedAt : site.ContentVersion;

        var snapshots = sp.GetRequiredService<ISiteContentSnapshotService>();
        var snapshot = await snapshots.GetAsync(site, ct);
        if (!string.IsNullOrEmpty(snapshot.Unavailable) || string.IsNullOrWhiteSpace(snapshot.Text))
        {
            // 读不出正文（纯视频/纯图包装站等）也盖版本戳：不盖的话，每个打开这个页面的人
            // 都会再排一次生成，而结论永远是同一个「读不出来」。
            await StampAsync(db, siteId, version, questions: null, ct);
            _logger.LogInformation("[AskOpeners] 站点 {SiteId} 读不到正文，跳过生成：{Reason}",
                siteId, snapshot.Unavailable ?? "正文为空");
            return false;
        }

        var text = snapshot.Text.Length > PromptTextBudget ? snapshot.Text[..PromptTextBudget] : snapshot.Text;

        var gateway = sp.GetRequiredService<ILlmGateway>();
        var ctxAccessor = sp.GetRequiredService<ILLMRequestContextAccessor>();
        var requestId = Guid.NewGuid().ToString("N");

        // 网关取不到 UserId 会以 "User not found" 的形式炸在运行时（llm-gateway 规则）。
        // 这条调用没有请求上下文（是后台任务），身份记在站点 owner 账上——
        // 这批题是为他的站点生成的，账单归属也是对的。
        using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
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
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(GenerationTimeout);

        var userContent = $"网页标题：{site.Title}\n\n网页正文：\n{text}";
        await foreach (var chunk in client.StreamGenerateAsync(
            SystemPrompt,
            new List<LLMMessage> { new() { Role = "user", Content = userContent } },
            cts.Token))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                raw.Append(chunk.Content);
        }

        var questions = AskOpeningQuestions.ParseGenerated(raw.ToString());
        if (questions.Count == 0)
        {
            // 解析不出来同样盖戳：反复重试一个会返回废话的模型不会有别的结果，
            // 只会按访客数重复烧钱。正文换了（版本变了）自然会再试一次。
            await StampAsync(db, siteId, version, questions: null, ct);
            _logger.LogInformation("[AskOpeners] 站点 {SiteId} 模型没给出可用问题，这一栏保持为空", siteId);
            return false;
        }

        await StampAsync(db, siteId, version, questions, ct);
        _logger.LogInformation("[AskOpeners] 站点 {SiteId} 生成了 {Count} 条开场问题", siteId, questions.Count);
        return true;
    }

    /// <summary>
    /// 写回结果并盖上「这一版正文已经算过」的戳。
    ///
    /// 更新条件带上 AskQuestionsSource != manual：从入队到写回之间 owner 可能刚好保存了
    /// 自己的题库，那一瞬间的写入不能被这次后台生成盖掉（读-改-写的经典竞态，
    /// 判据必须落在 filter 上，而不是只在内存里判过一次就算数）。
    /// </summary>
    private static async Task StampAsync(
        MongoDbContext db, string siteId, DateTime version, List<string>? questions, CancellationToken ct)
    {
        var update = Builders<HostedSite>.Update
            .Set(s => s.AskQuestionsGeneratedFor, version)
            .Set(s => s.AskQuestionsSource, "auto");
        if (questions != null)
            update = update.Set(s => s.AskSuggestedQuestions, questions);

        await db.HostedSites.UpdateOneAsync(
            s => s.Id == siteId && s.AskQuestionsSource != "manual",
            update,
            cancellationToken: ct);
    }
}
