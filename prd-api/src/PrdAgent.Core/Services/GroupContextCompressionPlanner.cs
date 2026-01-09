using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 纯规划器：决定“哪些消息需要被压缩、哪些保留原文”
/// - 不做任何 I/O，不调用 LLM，便于单测
/// </summary>
public static class GroupContextCompressionPlanner
{
    public sealed record Plan(
        bool ShouldCompress,
        IReadOnlyList<Message> ToCompress,
        IReadOnlyList<Message> KeepRaw,
        int TotalCharsBefore);

    public static Plan CreatePlan(
        IReadOnlyList<Message> orderedMessages,
        int thresholdChars,
        int targetKeepMaxChars,
        int minKeepCount,
        Func<Message, bool>? exclude = null)
    {
        exclude ??= (_ => false);
        var msgs = orderedMessages.Where(m => m != null && !exclude(m)).ToList();

        var total = msgs.Sum(m => (m.Content ?? string.Empty).Length);
        if (total <= thresholdChars)
        {
            return new Plan(false, Array.Empty<Message>(), msgs, total);
        }

        // 从后往前保留，直到 keepChars <= targetKeepMaxChars 或达到 minKeepCount
        var keep = new List<Message>();
        var keepChars = 0;
        for (var i = msgs.Count - 1; i >= 0; i--)
        {
            var m = msgs[i];
            keep.Insert(0, m);
            keepChars += (m.Content ?? string.Empty).Length;
            if (keep.Count >= minKeepCount && keepChars >= targetKeepMaxChars)
            {
                // 已达到“至少保留 minKeepCount”且 keep 已足够大，停止继续扩大 keep
                break;
            }
        }

        // 确保至少保留 minKeepCount
        if (keep.Count < minKeepCount)
        {
            var need = Math.Min(minKeepCount, msgs.Count);
            keep = msgs.TakeLast(need).ToList();
        }

        var keepSet = new HashSet<string>(keep.Select(m => m.Id));
        var toCompress = msgs.Where(m => !keepSet.Contains(m.Id)).ToList();

        // 若没有可压缩内容（全部都在 keep），则仍返回 shouldCompress=true（调用方可选择“强制压缩 keep 的前半段”或退化截断）
        return new Plan(true, toCompress, keep, total);
    }
}

