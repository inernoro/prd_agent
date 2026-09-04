using System.Globalization;

namespace PrdAgent.Api.Mcp;

/// <summary>调用方给的版本令牌与库里那份的关系。</summary>
public enum RevisionCheck
{
    /// <summary>没给 —— 不做检查（工具描述里写明了「不传就没有这层保护」）。</summary>
    NotProvided,
    Match,
    Mismatch,
    /// <summary>给了但认不出来 —— 是入参错，回 400，不是冲突。</summary>
    Unparsable,
}

/// <summary>
/// 「覆盖既有正文」这类写入的版本令牌判据 —— 唯一判定源。
///
/// 为什么必须由**调用方**给：知识库那一路原先传的是刚刚重新读出来的那个 `UpdatedAt`，
/// 条件永远成立 —— 那道「乐观并发」只挡得住相邻两行代码之间的缝隙，挡不住真正会丢
/// 用户改动的时序：智能体 T0 读到、用户 T1 在界面上改了、智能体 T2 拿旧稿覆盖。
/// 而 409 的文案写的是「在**你读到它**之后被别人改过」，那个「你」是调用方。
///
/// 为什么收敛到这里：修完知识库那一路之后，文学创作的 `mode=replace` 是同一族里的
/// 下一个，下一轮 Review 才被指出来。判据留在某个控制器里，就注定要被抄第二份。
/// </summary>
public static class McpRevision
{
    public static RevisionCheck Check(string? expected, DateTime actual)
    {
        if (string.IsNullOrWhiteSpace(expected)) return RevisionCheck.NotProvided;
        // 只用 RoundtripKind。它与 AdjustToUniversal 是互斥组合，凑在一起 TryParse 会直接抛
        // ArgumentException —— 不是返回 false，是把这条判据整个炸掉。
        if (!DateTime.TryParse(expected, CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out var parsed))
            return RevisionCheck.Unparsable;
        // 没带时区信息的按 UTC 认：库里存的就是 UTC，按本机时区解释会凭空差几个小时，
        // 于是一个正确的令牌被判成冲突 —— 比不校验更糟，它把本来能写的写不进去了。
        // 毫秒级比对：Mongo 存的是毫秒精度，往返一次 ISO-8601 不该因为 tick 尾数判成冲突。
        return Math.Abs((AsUtc(parsed) - AsUtc(actual)).TotalMilliseconds) < 1
            ? RevisionCheck.Match
            : RevisionCheck.Mismatch;
    }

    /// <summary>回给调用方的版本令牌统一用这个格式，它自带时区、能原样传回来。</summary>
    public static string Token(DateTime value) => AsUtc(value).ToString("O");

    private static DateTime AsUtc(DateTime value)
        => value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();
}
