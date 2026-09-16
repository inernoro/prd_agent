namespace PrdAgent.Api.Services.ModelLeaderboard;

/// <summary>
/// 榜单表格的形状。arena.ai 的分榜不是一个模子出来的，解析与展示都得分开。
/// </summary>
public static class BoardKind
{
    /// <summary>Agent 榜：六个百分比指标 + 会话数 + 单任务成本。目前独一份。</summary>
    public const string Agent = "agent";

    /// <summary>
    /// 对战分数榜：Elo 分数 ± 区间 + 票数（部分榜还有单价与上下文）。
    /// 其余十个榜全是这个形状。
    /// </summary>
    public const string Score = "score";
}

/// <summary>
/// 一个分榜的目录项。
/// </summary>
/// <param name="Key">arena.ai 的分榜路径，同时是我们的库内标识</param>
/// <param name="Label">中文名。<b>由后端维护</b>——前端不许另存一份映射表
/// （见 .claude/rules/frontend-architecture.md「单一数据源原则」）</param>
/// <param name="Group">分组中文名，页面按它把切换器分段</param>
/// <param name="Kind">预期的表格形状，见 <see cref="BoardKind"/></param>
/// <param name="Hint">一句话说明这个榜在比什么，给切换器当副标题</param>
public record LeaderboardBoardInfo(string Key, string Label, string Group, string Kind, string Hint);

/// <summary>
/// 分榜目录：有哪些榜、叫什么、归哪一组、是什么形状。
///
/// ## 这份清单是实测出来的，不是照着站内导航抄的
///
/// 第一版只有 agent 一个榜，理由写的是「其余榜是客户端懒加载，服务端渲染不出数据」——
/// 那个结论是错的。当时试的是 <c>/leaderboard/image</c>、<c>/leaderboard/video</c> 这类
/// **猜出来的路径**，它们在 arena.ai 上根本不存在，返回的是 404 兜底页；那个兜底页里恰好
/// 有一句「Loading leaderboard」，于是被读成了「骨架还没加载完」。
/// 真实路径（从 agent 页的站内链接里抠出来的）全都是服务端渲染，一次 HTTP 请求就有全量数据。
///
/// 这正是 .claude/rules/predicate-and-wiring-discipline.md 形状 8：把一份不成立的证据
/// （不存在页面上的一句文案）当成了结论的证明。**加榜或删榜前，先真抓一次数一数行数。**
///
/// ## Kind 只是「预期」，最终以页面表头为准
///
/// 解析器按表头自行判断形状（见 <see cref="ArenaLeaderboardFetcher.Parse"/>），
/// 与这里声明的不符时同步会失败并保留旧快照——对方把某个榜改了结构时，
/// 我们宁可数据变旧也不要静默写进一批错位的值。
/// </summary>
public static class ModelLeaderboardCatalog
{
    /// <summary>页面与挂件的默认榜。</summary>
    public const string DefaultBoard = "agent";

    public static readonly IReadOnlyList<LeaderboardBoardInfo> Boards =
    [
        new("agent",          "编程智能体", "编程与智能体", BoardKind.Agent, "真实编程会话里的净改进、任务完成与工具可靠性"),
        new("code",           "代码能力",   "编程与智能体", BoardKind.Score, "写代码的人类盲测对战分"),

        new("text",           "文本对话",   "对话与理解",   BoardKind.Score, "综合对话能力的人类盲测对战分"),
        new("vision",         "图像理解",   "对话与理解",   BoardKind.Score, "看图回答问题的对战分"),
        new("search",         "联网搜索",   "对话与理解",   BoardKind.Score, "带联网检索的问答对战分"),
        new("document",       "文档理解",   "对话与理解",   BoardKind.Score, "长文档阅读与提取的对战分"),

        new("text-to-image",  "文生图",     "图像生成",     BoardKind.Score, "按文字描述出图的对战分"),
        new("image-edit",     "图像编辑",   "图像生成",     BoardKind.Score, "按指令改图的对战分"),

        new("text-to-video",  "文生视频",   "视频生成",     BoardKind.Score, "按文字描述生成视频的对战分"),
        new("image-to-video", "图生视频",   "视频生成",     BoardKind.Score, "让一张静图动起来的对战分"),
        new("video-edit",     "视频编辑",   "视频生成",     BoardKind.Score, "按指令改视频的对战分"),
    ];

    /// <summary>要同步的分榜标识，顺序即目录顺序。</summary>
    public static string[] Keys => Boards.Select(b => b.Key).ToArray();

    public static LeaderboardBoardInfo? Find(string key)
        => Boards.FirstOrDefault(b => string.Equals(b.Key, key, StringComparison.OrdinalIgnoreCase));

    public static bool Contains(string key) => Find(key) is not null;
}
