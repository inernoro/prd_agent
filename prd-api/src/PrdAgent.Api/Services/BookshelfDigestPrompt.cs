using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Models;

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
    ///
    /// 注意它只管 system prompt 那一半。材料那一半（这本书挂了哪几条规则、规则正文改没改）
    /// 由 <see cref="ComputeMaterialFingerprint"/> 管，两者合起来才是完整的 staleness 判据。
    /// </summary>
    public const string Version = "v2";

    /// <summary>
    /// 这一份材料的内容指纹。
    ///
    /// 为什么直接对 <see cref="BuildUserPrompt"/> 的输出算，而不是挑几个字段拼起来算：
    /// user prompt 就是真正喂给模型的全部材料，一个字不多一个字不少。手工列字段的写法
    /// 会在「将来给 user prompt 加一节材料」时静默漏掉——判据读的值和真正生效的值分了家，
    /// 那正是 predicate-and-wiring-discipline 形状 6 说的那种错：判据确实读到了一个真实
    /// 存在的值，只是那不是系统实际用的那个。
    ///
    /// 取 16 字节（32 个 hex）：这不是防篡改用的，只需要「材料变了它几乎必然跟着变」。
    /// </summary>
    public static string ComputeMaterialFingerprint(Material material)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(BuildUserPrompt(material)));
        return Convert.ToHexString(bytes.AsSpan(0, 16)).ToLowerInvariant();
    }

    /// <summary>
    /// 这一篇还新鲜吗：提示词版本与材料指纹都得对得上。
    ///
    /// 唯一判定源。取稿（GET）与生成（SSE 的复用分支）必须都走这里——两边各写一遍
    /// 就是 predicate-and-wiring-discipline 形状 3：同一个判断分裂成两份，改一处忘一处，
    /// 于是接口说「这篇旧了」而生成那边照旧复用，或者反过来。
    ///
    /// `material` 为 null（书单里已经没有这本书了）时一律判不新鲜：材料都取不到，
    /// 没有任何依据说它还对得上。
    /// </summary>
    public static bool IsFresh(BookDigest? digest, Material? material)
    {
        if (digest == null || string.IsNullOrWhiteSpace(digest.Content)) return false;
        if (!string.Equals(digest.PromptVersion, Version, StringComparison.Ordinal)) return false;
        if (material == null) return false;
        return string.Equals(
            digest.MaterialFingerprint,
            ComputeMaterialFingerprint(material),
            StringComparison.Ordinal);
    }

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

        用户消息里有两类材料，用途是分开的，不要混用：

        - 「这本书」「它被编在哪一卷」「编者为什么把它放进这一卷」「编者写的一句话收获」——这是关于**这本书**的材料，供第一、二段使用。
        - 「我们的规则」——这是这个团队自己的规则与事故，**只供第三段使用**。第一、二段不许引用它、不许把它当成这本书的论点。

        写成三段，各用一个 Markdown 二级标题：

        ## 这本书在说什么

        把全书收敛成 3 到 5 条核心论点，每条一个三级标题（###）加一段展开。

        论点必须来自**这本书本身**：这本书讨论的是什么问题、作者主张怎么做、书里举了什么例子。
        编者的推荐语只是提示这本书为什么被选进来，不是这本书的论点——不要把它当成书的内容复述一遍。
        展开里要有书中的具体做法、术语或例子，不要停在抽象概括上。

        ## 怎么用在我们身上

        3 到 5 条下周就能做的具体动作。每条必须是动作（「接需求先答三问：问题是谁的、真正困扰是什么、不解决会怎样」），不是感受（「要重视需求分析」）。

        这一段不许是第一段的换句话说。第一段讲书里说了什么，这一段讲**我们改哪个环节、在什么时候做、做出来是什么样**。想不出具体动作的宁可少写一条。

        ## 我们在哪儿栽过

        把这本书的主张对上团队自己的规则和事故。材料在用户消息的「我们的规则」里，逐条说清三件事：那条规则要求什么、我们当时是怎么栽的、这本书会怎么看这件事。

        硬约束：

        - 第三段只能用给定的规则材料。材料里没有的事故，一个字都不许编——读者会照着去仓库里翻，翻不到，整篇稿子就都不可信了。
        - 材料不足以支撑第三段时，就直说「这本书还没有对上我们自己的事故记录」然后收尾，不要用泛泛的行业案例凑数。
        - 全文中文。不要使用 emoji。不要写「总之」「综上所述」「在当今时代」这类套话。
        - 不要写「强调了……的重要性」「体现了……的价值」这类空转句式。要么说清具体是什么，要么删掉这句。
        - 不要复述目录，不要逐章小结。
        - 全文 1500 到 2500 字。少于 1500 字说明论点展开得不够，回去把每条论点的例子和做法补上。
        """;

    public static string BuildUserPrompt(Material m)
    {
        var sb = new StringBuilder();
        sb.AppendLine("以下 1-4 节是关于这本书的材料，供第一、二段使用；最后的「我们的规则」只供第三段使用。");
        sb.AppendLine();
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
        sb.AppendLine("# 编者为什么把它放进这一卷（这是编者的推荐理由，不是这本书的论点）");
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
        sb.AppendLine("以下是这个团队自己写下的规则与真实事故。**只有第三段用得上这里的内容**——第一、二段不许引用它，更不许把它当成这本书的论点。");
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
