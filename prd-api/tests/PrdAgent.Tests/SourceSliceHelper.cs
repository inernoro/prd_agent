using System;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 源码扫描类守卫的取窗工具。
///
/// 为什么要有它：这一批守卫里我连续四次栽在同一个地方——手写一个固定长度的窗口
/// （`src[idx..(idx + 700)]` 之类），然后它要么读进了下一个方法（守卫对着正确实现常红）、
/// 要么切到文件尾之外（直接抛异常）、要么因为有人加了几行注释就把要断言的那句挤出窗口。
/// 固定长度本来就不是「这个方法的范围」，只是一个碰巧当时够用的数字。
///
/// 改成按大括号配对取真实的方法体之后，这一类错误在结构上就不存在了。
/// 新写源码守卫一律用这里的方法，别再自己 `idx + N`。
/// </summary>
internal static class SourceSlice
{
    /// <summary>
    /// 从 <paramref name="signature"/> 出现处取到它的方法体结束（大括号配对），含签名本身。
    /// 找不到签名或括号不配对时直接让用例失败并说清是哪一个——静默返回空串会让守卫空跑。
    /// </summary>
    public static string Member(string source, string signature)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"源码里找不到这个签名，判据可能已失效：{signature}");

        var open = source.IndexOf('{', start);
        Assert.True(open > start, $"签名之后找不到方法体起始括号：{signature}");

        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0) return source[start..(i + 1)];
            }
        }

        Assert.Fail($"方法体大括号不配对，取不到完整范围：{signature}");
        return string.Empty;
    }

    /// <summary>
    /// 沿网页托管的公开包装追到实际实现；先验证每个包装原样透传全部参数，不能只跳过包装。
    /// </summary>
    public static string HostedSiteImplementation(string source, string member)
    {
        var compact = System.Text.RegularExpressions.Regex.Replace(member, @"\s+", " ").Trim();
        if (compact.StartsWith("public async Task<HostedSite> CreateFromZipAsync( string userId, byte[]", StringComparison.Ordinal))
        {
            Assert.Contains("new MemoryStream(zipBytes, writable: false)", compact);
            Assert.Contains("return await CreateFromZipAsync(userId, stream, title, description, folder, tags, wrappedAssetType, ct, uploadId, sourceRef);", compact);
            Assert.Single(System.Text.RegularExpressions.Regex.Matches(compact, @"\breturn\b"));
            return Member(source, "public async Task<HostedSite> CreateFromZipAsync(\n        string userId, Stream zipStream,");
        }
        if (System.Text.RegularExpressions.Regex.IsMatch(compact, @"^public (?:async )?Task<HostedSite> ReuploadAsync\("))
        {
            var buffered = compact.Contains("byte[] fileBytes", StringComparison.Ordinal);
            if (buffered) Assert.Contains("new MemoryStream(fileBytes, writable: false)", compact);
            var expectedReturn = buffered
                ? "return await ReuploadCoreAsync(siteId, userId, stream, fileBytes, fileName, wrappedAssetType, ct, uploadId, reuploadRef);"
                : "return ReuploadCoreAsync(siteId, userId, zipStream, null, fileName, wrappedAssetType, ct, uploadId, reuploadRef);";
            Assert.Contains(expectedReturn, compact);
            Assert.Single(System.Text.RegularExpressions.Regex.Matches(compact, @"\breturn\b"));
            return Member(source, "private async Task<HostedSite> ReuploadCoreAsync(");
        }
        return member;
    }

    /// <summary>
    /// 取「某个签名之后、直到某个结束标记为止」的一段。用于只想守住方法里某一个分支的场合
    /// （例如「模型没有任何输出」那一档到它自己的 return 为止），比整段方法体更贴。
    /// </summary>
    public static string Between(string source, string from, string to)
    {
        var start = source.IndexOf(from, StringComparison.Ordinal);
        Assert.True(start >= 0, $"源码里找不到起点：{from}");
        var end = source.IndexOf(to, start, StringComparison.Ordinal);
        Assert.True(end > start, $"从起点往后找不到终点：{from} → {to}");
        return source[start..end];
    }
}
