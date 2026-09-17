using MongoDB.Driver;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// appCaller 身份的比较规则——控制台这一侧的镜像。
///
/// 权威定义在 <c>PrdAgent.Infrastructure.LlmGateway.GatewayAppCallerIdentity</c>，
/// 它的类注释写得很清楚：这份比较要在**被动注册、治理读、路由读、去重、唯一索引**
/// 之间逐处相同。console-api 按既定架构不引用 PrdAgent.*，所以只能留一份镜像，
/// 由 PrdAgent.Tests 里的行为对照测试逐项比对（那个项目是全仓唯一同时引用两侧的地方）。
///
/// 为什么值得单开一个类：这份规则此前在 Program.cs 里以字面量形式散着写了两处，
/// 而认领列表那一处压根没用它——去重按字节、对手查询按字节、运行时认领查询也按字节，
/// 于是「登记成 Foo、请求带 foo」这条路上授权照过、认领落空，请求悄悄换了一个模型
/// （第 76 轮 review）。判据散成几份就一定会漏掉其中一份，所以收敛到这里。
/// </summary>
public static class AppCallerIdentityPolicy
{
    /// <summary>
    /// 与权威侧逐字相同：locale "en" + 二级强度（忽略大小写，保留音调差异）。
    /// </summary>
    public static Collation Collation { get; } = new("en", strength: CollationStrength.Secondary);

    /// <summary>
    /// 内存里比 appCaller 码时用它。与 <see cref="Collation"/> 在 ASCII 上等价——
    /// appCallerCode 按注册表规范只允许小写字母、数字与连字符（见 app-caller-registry 规则），
    /// 所以两者不会在真实取值上给出不同答案；分成两个是因为一个作用在 Mongo 查询上、
    /// 一个作用在 LINQ 上，没有第三种写法。
    /// </summary>
    public static StringComparer Comparer => StringComparer.OrdinalIgnoreCase;

    /// <summary>与权威侧的 NormalizePart 相同：只去首尾空白，不改大小写。</summary>
    public static string NormalizePart(string value) => value.Trim();

    /// <summary>
    /// 一份认领列表的规范形态：去空白、丢空串、按身份规则去重。
    ///
    /// 去重用身份规则而不是字节：同一份列表里同时写 Foo 与 foo 时，按字节去重会留下两条，
    /// 而它们在运行时是同一个调用方——库里一个身份占两个数组位，唯一索引与位移账本
    /// 都要为此各写一遍特例。在入口收敛掉最省事。
    /// </summary>
    public static List<string> NormalizeClaims(IEnumerable<string>? values)
        => (values ?? [])
            .Select(NormalizePart)
            .Where(x => x.Length > 0)
            .Distinct(Comparer)
            .ToList();
}
