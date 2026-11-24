using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 一本书的精读稿 —— 藏书阁里真正「可读」的那部分内容。
///
/// 在它之前，藏书阁只有一张书单：书名、作者、一句 takeaway，然后一个输入框让用户
/// 自己写心得。用户点两下发现没东西读是必然的——里面本来就只有索引，没有内容。
/// 用户原话：「点进去就是让用户输入，什么意思？用户提供内容？」
///
/// 所以这一份是**系统产出**的：按需生成（第一个点进这本书的人触发），之后所有人读同一篇。
/// 稿子不是书摘——网上到处都是的东西没有理由放在这里——而是「这本书讲的事，
/// 我们自己在哪条规则上栽过」，原料来自本仓库的 `.claude/rules/`。
/// </summary>
[BsonIgnoreExtraElements]
public class BookDigest
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>书 id，对应前端 catalog.ts 里的 BookEntry.id（不透明字符串，后端不校验它是否还存在）</summary>
    public string BookId { get; set; } = string.Empty;

    /// <summary>稿子正文（Markdown）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>
    /// 生成时用的提示词版本。
    ///
    /// 改了 prompt 之后，存量稿子仍是旧版写法。有这个字段才能回答「哪些该重生成」——
    /// 没有它就只能靠人记，而人不会记得。
    /// </summary>
    public string PromptVersion { get; set; } = string.Empty;

    /// <summary>
    /// 生成时那份材料的内容指纹（`BookshelfDigestPrompt.ComputeMaterialFingerprint`）。
    ///
    /// 光有 PromptVersion 不够：第三段「我们在哪儿栽过」整段来自这本书挂的 relatedRules，
    /// 给它改挂一条规则、或者规则正文本身改了，提示词一个字没动、版本号照旧，
    /// 于是库里那篇用旧材料写的稿子会一直被当成新鲜的端给读者——第三段和当前挂的规则对不上，
    /// 还没有任何东西提示它过期。
    ///
    /// 空字符串表示这篇是加这个字段之前写的，一律当过期处理（下次点开重生成一篇）。
    /// </summary>
    public string MaterialFingerprint { get; set; } = string.Empty;

    /// <summary>实际出稿的模型与平台（`ai-model-visibility`：用户会因为换了模型感知到差异，得让他看得见）</summary>
    public string? Model { get; set; }

    public string? Platform { get; set; }

    /// <summary>谁触发的这次生成。不是权属——稿子是公共的，这只是留个来源</summary>
    public string? GeneratedByUserId { get; set; }

    public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;

    /// <summary>这一稿引用了哪几条规则（`.claude/rules/` 的文件名）。前端据此渲染「延伸阅读」</summary>
    public List<string> CitedRules { get; set; } = new();

    /// <summary>
    /// 写下这一篇的部署。权威部署（生产 / 本地）为 null，CDS 分支预览为 "{projectId}::{branch}"。
    ///
    /// 不带作用域的后果不是「兄弟分支能看见」那么温和（`cross-project-isolation` 通道 4）：
    /// 同一个 CDS 项目下所有分支共用一个 Mongo，而这个集合一本书只有一行。
    /// 两条分支的提示词版本或规则材料一旦不同，各自的新鲜度判据都会判对方那篇过期，
    /// 于是**互相覆盖、反复重烧**——钱一直在花，谁也验不准自己这条分支的产出
    /// （通道 8 的「修了像没修」就是这个形状）。
    ///
    /// 取 CurrentDurable（分支级、不含 revision）：稿子怕的是跨分支互覆，
    /// 不怕滚动发布抢单；带 revision 会让每次推送都丢掉自己刚生成的那篇。
    /// 存量文档没有这个字段，读作 null，即当成权威部署写的——不需要迁移。
    /// </summary>
    public string? DeploymentSlug { get; set; }
}
