using System;
using System.Linq;
using System.Security.Claims;
using PrdAgent.Api.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 幂等键的归一化判据。
///
/// 这条判据坏掉不会红：接口照常回 200、调用记录照常有一行、面板照常显示「幂等命中」——
/// 只是调用方那次写入**根本没做**。原来三个开放层控制器各抄了一份归一化逻辑，
/// 并且都把键截到 120 字；两个前 120 字相同的合法幂等键就此压成同一个，
/// 第二次写入被当成重试悄悄跳过（predicate-and-wiring-discipline.md 形状 1 + 形状 3）。
///
/// 所以这里同时钉两件事：行为上「长键不许坍缩」，结构上「三处必须走同一个判定源」。
/// </summary>
public class McpIdempotencyTests
{
    private static ClaimsPrincipal Key(string keyId) =>
        new(new ClaimsIdentity(new[] { new Claim("agentApiKeyId", keyId) }, "test"));

    [Fact]
    public void 前120字相同但后面不同的两个键_不许压成同一个()
    {
        var prefix = new string('a', 120);
        var one = McpIdempotency.ScopedByKey(Key("k1"), prefix + "-alpha");
        var two = McpIdempotency.ScopedByKey(Key("k1"), prefix + "-beta");

        one.ShouldNotBe(two, customMessage: "长键被截断了：第二次写入会被误判成幂等命中、悄悄不做");
        // 顺带钉住下游那一步：确定性 id 也必须跟着不同，否则撞主键同样是「悄悄跳过」
        DocumentStoreOpenApiControllerDeterministicId(one)
            .ShouldNotBe(DocumentStoreOpenApiControllerDeterministicId(two));
    }

    [Fact]
    public void 幂等指纹_定长32位十六进制且长键互不坍缩()
    {
        var prefix = new string('z', 5000);
        var one = McpIdempotency.Fingerprint("k", McpIdempotency.ScopedByKey(Key("k1"), prefix + "-alpha"));
        var two = McpIdempotency.Fingerprint("k", McpIdempotency.ScopedByKey(Key("k1"), prefix + "-beta"));

        one!.Length.ShouldBe(32, customMessage: "落库的键必须定长：clientRequestId 无界，原样进 Mongo 等于让调用方决定文档多大");
        System.Text.RegularExpressions.Regex.IsMatch(one, "^[0-9a-f]{32}$")
            .ShouldBeTrue(customMessage: "指纹必须是小写十六进制，与随机 id 同形");
        one.ShouldNotBe(two, customMessage: "长键在指纹这一步坍缩了：第二次写入会被误判成幂等命中、悄悄不做");
        McpIdempotency.Fingerprint("k", null).ShouldBeNull();
        // 前缀是判据的一部分：同一个键在不同用途下不许算出同一个 id
        McpIdempotency.Fingerprint("a", "same").ShouldNotBe(McpIdempotency.Fingerprint("b", "same"));
    }

    [Fact]
    public void 两把密钥用同一个幂等键_互不干扰()
    {
        McpIdempotency.ScopedByKey(Key("k1"), "same-request")
            .ShouldNotBe(McpIdempotency.ScopedByKey(Key("k2"), "same-request"));
    }

    [Fact]
    public void 没给或全空白的幂等键_返回null即不做幂等()
    {
        McpIdempotency.ScopedByKey(Key("k1"), null).ShouldBeNull();
        McpIdempotency.ScopedByKey(Key("k1"), "   ").ShouldBeNull();
        McpIdempotency.Normalize("  x  ").ShouldBe("x");
    }

    [Fact]
    public void 拿不到密钥id时_用稳定占位值而不是抛异常()
    {
        McpIdempotency.KeyIdOf(new ClaimsPrincipal(new ClaimsIdentity())).ShouldBe("unknown");
        McpIdempotency.KeyIdOf(null).ShouldBe("unknown");
    }

    /// <summary>
    /// 被守对象是**枚举**出来的，不是写死的清单。
    ///
    /// 上一版把三个控制器的路径写死在 [InlineData] 里，第四个（文学创作）因此从一开始
    /// 就不在视野里，同一处截断在那儿又活了一轮。枚举之后，新增开放层控制器自动进闸。
    /// </summary>
    public static TheoryData<string> 开放层控制器()
    {
        var data = new TheoryData<string>();
        foreach (var path in McpSourceGuard.EnumerateRelative(
                     "prd-api/src/PrdAgent.Api/Controllers/Api", "*OpenApiController.cs"))
            data.Add(path);
        return data;
    }

    [Theory]
    [MemberData(nameof(开放层控制器))]
    public void 开放层控制器_不许自己归一化幂等键(string path)
    {
        var source = McpSourceGuard.StripComments(McpSourceGuard.Read(path));

        source.ShouldNotContain("raw[..120]",
            customMessage: $"{path} 把幂等键截断了：长键坍缩会让第二次写入被误判成幂等命中、悄悄不做");
        source.ShouldNotContain("FindFirst(\"agentApiKeyId\")",
            customMessage: $"{path} 自己去取密钥 id 了，取法应当只有 McpIdempotency 一处");

        // 只有真的做幂等的控制器才要求它走共用判定源；不碰 clientRequestId 的（如管理面）豁免。
        if (source.Contains("ClientRequestId", StringComparison.Ordinal)
            || source.Contains("clientRequestId", StringComparison.Ordinal))
            source.ShouldContain("McpIdempotency.ScopedByKey",
                customMessage: $"{path} 自己拼幂等键而没走共用判定源，迟早各漂各的");

        // 归一化后的键里带着调用方给的**原文**，而原文是无界的。凡是让它继续往下走的路
        // （确定性 id、SourceRef、IdempotencyKey、条目 Metadata）都得先压成定长指纹。
        // 所以判据不是「有没有调 ScopedByKey」，而是「它的结果有没有当场被 Fingerprint 包住」——
        // 视觉创作那一路正是调了 ScopedByKey、却把结果直接塞进带唯一索引的 IdempotencyKey。
        foreach (var line in source.Split('\n'))
        {
            if (!line.Contains("McpIdempotency.ScopedByKey", StringComparison.Ordinal)) continue;
            line.ShouldContain("McpIdempotency.Fingerprint",
                customMessage: $"{path} 把 ScopedByKey 的结果（含调用方原文）直接往下传了，"
                    + "必须当场 McpIdempotency.Fingerprint 压成定长指纹再落库");
        }
    }

    /// <summary>复刻知识库那一步的确定性 id 算法，用来确认长键坍缩不会在下游被重新引入。</summary>
    private static string DocumentStoreOpenApiControllerDeterministicId(string? idempotencyKey)
        => PrdAgent.Api.Controllers.Api.DocumentStoreOpenApiController
            .DeterministicId("kb-entry", idempotencyKey)!;
}
