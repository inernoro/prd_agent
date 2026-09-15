using System.Reflection;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Services;

/// <summary>
/// 精读稿的提示词与上下文 —— 藏书阁「有东西可读」这件事的全部原料在这里。
///
/// ## 上下文从哪来
///
/// 内嵌的 `Resources/bookshelf-context.json`，由 prd-admin 那侧的守卫测试从
/// `catalog.ts` 与 `.claude/rules/` 生成（改了源头不重新生成，那条守卫会红）。
///
/// 为什么不让前端把上下文随请求发过来：稿子是**公共内容**，所有人读同一篇。
/// 上下文可篡改就等于任何登录用户都能往公共内容里注入任意 prompt。
///
/// ## 这份稿子和书摘的区别
///
/// 书摘网上到处都是，没有理由放在这里。这份稿子唯一不可替代的部分是第三段——
/// 「这本书讲的事，我们自己在哪条规则上栽过」，原料是本仓库 60 条规则里那 40 条
/// 带真实事故的。所以硬约束里最重的一条是：那一段只准用给定材料，不许编。
/// 编出来的假事故比没有这一段糟得多——读者会照着去仓库里翻，翻不到，整篇就都不可信了。
/// </summary>
public static class BookshelfDigestPrompt
{
    /// <summary>
    /// 提示词版本。改了下面任何一段文案都要跟着升——存量稿子是用旧版写的，
    /// 没有这个字段就只能靠人记得「哪些该重生成」，而人不会记得。
    /// </summary>
    public const string Version = "v1";

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly Lazy<ContextFile> Context = new(Load, LazyThreadSafetyMode.ExecutionAndPublication);

    public sealed class ContextFile
    {
        public List<VolumeCtx> Volumes { get; set; } = new();
        public List<RuleCtx> Rules { get; set; } = new();
    }

    public sealed class VolumeCtx
    {
        public string Id { get; set; } = string.Empty;
        public int Index { get; set; }
        public string Name { get; set; } = string.Empty;
        public string Subtitle { get; set; } = string.Empty;
        public string PainQuote { get; set; } = string.Empty;
        public string Cure { get; set; } = string.Empty;
        public List<BookCtx> Books { get; set; } = new();
    }

    public sealed class BookCtx
    {
        public string Id { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string? Original { get; set; }
        public string Author { get; set; } = string.Empty;
        public string Track { get; set; } = string.Empty;
        public int Level { get; set; }
        public string Why { get; set; } = string.Empty;
        public string Takeaway { get; set; } = string.Empty;
        public List<string> RelatedRules { get; set; } = new();
    }

    public sealed class RuleCtx
    {
        public string Name { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string OneLine { get; set; } = string.Empty;
        public string WhenHit { get; set; } = string.Empty;
        public string History { get; set; } = string.Empty;
    }

    /// <summary>一次生成需要的全部材料</summary>
    public sealed class Material
    {
        public BookCtx Book { get; set; } = new();
        public VolumeCtx Volume { get; set; } = new();
        public List<RuleCtx> Rules { get; set; } = new();
    }

    private static ContextFile Load()
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            // 按后缀找，不拼命名空间 —— 根命名空间改一次，拼出来的名字就静默失效了
            var resName = asm.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("bookshelf-context.json", StringComparison.OrdinalIgnoreCase));
            if (resName == null) return new ContextFile();

            using var stream = asm.GetManifestResourceStream(resName);
            if (stream == null) return new ContextFile();
            using var reader = new StreamReader(stream);
            return JsonSerializer.Deserialize<ContextFile>(reader.ReadToEnd(), JsonOptions) ?? new ContextFile();
        }
        catch
        {
            // 读不到就当没有这本书，调用方会回 404。配图那条链路是同样的取舍：
            // 缺内容不该把整个藏书阁拖垮。
            return new ContextFile();
        }
    }

    /// <summary>按书 id 取材料；书不在书单里返回 null</summary>
    public static Material? Find(string bookId)
    {
        var ctx = Context.Value;
        foreach (var v in ctx.Volumes)
        {
            var b = v.Books.FirstOrDefault(x => string.Equals(x.Id, bookId, StringComparison.Ordinal));
            if (b == null) continue;
            return new Material
            {
                Book = b,
                Volume = v,
                Rules = ctx.Rules.Where(r => b.RelatedRules.Contains(r.Name)).ToList(),
            };
        }
        return null;
    }

    public static string BuildSystemPrompt() =>
        """
        你在为一个开发团队写一本书的「精读稿」。读者是这个团队的工程师和产品经理，他们大概率不会去读原书——这篇稿子就是他们能拿到的全部。

        写成三段，各用一个 Markdown 二级标题：

        ## 这本书在说什么

        把全书收敛成 3 到 5 条核心论点。每条先用一句话把主张说死，再用一段话展开。展开里要有书中的具体做法或例子，不要停在抽象概括上。

        ## 怎么用在我们身上

        3 到 5 条下周就能做的具体动作。每条必须是动作（「接需求先答三问：问题是谁的、真正困扰是什么、不解决会怎样」），不是感受（「要重视需求分析」）。想不出具体动作的宁可少写一条。

        ## 我们在哪儿栽过

        把这本书的主张对上团队自己的规则和事故。材料在用户消息的「我们的规则」里，逐条说清三件事：那条规则要求什么、我们当时是怎么栽的、这本书会怎么看这件事。

        硬约束：

        - 第三段只能用给定的规则材料。材料里没有的事故，一个字都不许编——读者会照着去仓库里翻，翻不到，整篇稿子就都不可信了。
        - 材料不足以支撑第三段时，就直说「这本书还没有对上我们自己的事故记录」然后收尾，不要用泛泛的行业案例凑数。
        - 全文中文。不要使用 emoji。不要写「总之」「综上所述」「在当今时代」这类套话。
        - 不要复述目录，不要逐章小结。
        - 全文 1500 到 2500 字。
        """;

    public static string BuildUserPrompt(Material m)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# 这本书");
        sb.AppendLine($"书名：《{m.Book.Title}》");
        if (!string.IsNullOrWhiteSpace(m.Book.Original)) sb.AppendLine($"原名：{m.Book.Original}");
        sb.AppendLine($"作者：{m.Book.Author}");
        sb.AppendLine($"门槛：{m.Book.Level switch { 1 => "入门", 2 => "进阶", _ => "硬骨头" }}");
        sb.AppendLine();
        sb.AppendLine("# 它被编在哪一卷");
        sb.AppendLine($"卷{m.Volume.Index}「{m.Volume.Name}」——{m.Volume.Subtitle}");
        sb.AppendLine($"这一卷要治的处境：{m.Volume.PainQuote}");
        sb.AppendLine($"这一卷的药方：{m.Volume.Cure}");
        sb.AppendLine();
        sb.AppendLine("# 编者为什么把它放进这一卷");
        sb.AppendLine(m.Book.Why);
        sb.AppendLine();
        sb.AppendLine("# 编者写的一句话收获");
        sb.AppendLine(m.Book.Takeaway);
        sb.AppendLine();

        if (m.Rules.Count == 0)
        {
            sb.AppendLine("# 我们的规则");
            sb.AppendLine("（这本书还没有关联任何团队规则。第三段请直接写「这本书还没有对上我们自己的事故记录」，不要编。）");
            return sb.ToString();
        }

        sb.AppendLine("# 我们的规则");
        sb.AppendLine("以下是这个团队自己写下的规则与真实事故。第三段只能用这里的内容。");
        foreach (var r in m.Rules)
        {
            sb.AppendLine();
            sb.AppendLine($"## {r.Title}（.claude/rules/{r.Name}.md）");
            sb.AppendLine($"这条规则要求：{r.OneLine}");
            sb.AppendLine($"什么时候撞上：{r.WhenHit}");
            if (!string.IsNullOrWhiteSpace(r.History))
            {
                sb.AppendLine("我们当时栽的那次：");
                sb.AppendLine(r.History);
            }
            else
            {
                sb.AppendLine("（这条规则是纯原则式的，没有记录具体事故——不要替它编一个。）");
            }
        }
        return sb.ToString();
    }
}
