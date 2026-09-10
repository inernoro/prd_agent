using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 公共藏书阁的个人进度：已读书目 + 每卷结业考成绩。
///
/// 书目与考题本身是策展的静态内容（前端 lib/bookshelf/catalog.ts 是 SSOT），
/// 这里只存「谁读了什么、考了多少分」。一个用户一行，UserId 唯一。
///
/// BsonIgnoreExtraElements：卷 / 书的 id 是内容侧定义的字符串，日后增删卷或
/// 改 id 时，旧文档里会残留已不存在的 key。不加本特性会让存量文档反序列化
/// 抛 FormatException，把整个进度接口打成 500。
/// </summary>
[BsonIgnoreExtraElements]
public class BookshelfProgress
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>归属用户（User.UserId），一人一行</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>已读书目 id 列表（对应 catalog.ts 的 BookEntry.id）</summary>
    public List<string> ReadBookIds { get; set; } = new();

    /// <summary>每卷的最好成绩，key = 卷 id（对应 catalog.ts 的 Volume.id）</summary>
    public Dictionary<string, BookshelfExamResult> ExamResults { get; set; } = new();

    /// <summary>创建时间（UTC）</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>最后一次变更时间（UTC），团队看板按它排「最近活跃」</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>一次结业考的成绩。只保留每卷最好的一次。</summary>
[BsonIgnoreExtraElements]
public class BookshelfExamResult
{
    /// <summary>答对题数</summary>
    public int Correct { get; set; }

    /// <summary>总题数</summary>
    public int Total { get; set; }

    /// <summary>是否及格（判据在前端 exams.ts，写库时一并存下结论）</summary>
    public bool Passed { get; set; }

    /// <summary>交卷时间（UTC）</summary>
    public DateTime TakenAt { get; set; } = DateTime.UtcNow;
}
