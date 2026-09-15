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

    /// <summary>实际出稿的模型与平台（`ai-model-visibility`：用户会因为换了模型感知到差异，得让他看得见）</summary>
    public string? Model { get; set; }

    public string? Platform { get; set; }

    /// <summary>谁触发的这次生成。不是权属——稿子是公共的，这只是留个来源</summary>
    public string? GeneratedByUserId { get; set; }

    public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;

    /// <summary>这一稿引用了哪几条规则（`.claude/rules/` 的文件名）。前端据此渲染「延伸阅读」</summary>
    public List<string> CitedRules { get; set; } = new();
}
