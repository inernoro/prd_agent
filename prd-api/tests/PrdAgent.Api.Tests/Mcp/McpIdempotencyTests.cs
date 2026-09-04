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

    [Theory]
    [InlineData("prd-api/src/PrdAgent.Api/Controllers/Api/VisualOpenApiController.cs")]
    [InlineData("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs")]
    [InlineData("prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesOpenApiController.cs")]
    public void 三个开放层控制器_不许再自己归一化幂等键(string path)
    {
        var source = McpSourceGuard.StripComments(McpSourceGuard.Read(path));

        source.ShouldContain("McpIdempotency.ScopedByKey",
            customMessage: $"{path} 没走共用判定源，归一化又抄了一份，迟早各漂各的");
        source.ShouldNotContain("raw[..120]",
            customMessage: $"{path} 又把幂等键截断了：长键坍缩会让第二次写入被误判成幂等命中");
        source.ShouldNotContain("FindFirst(\"agentApiKeyId\")",
            customMessage: $"{path} 又自己去取密钥 id 了，取法应当只有 McpIdempotency 一处");
    }

    /// <summary>复刻知识库那一步的确定性 id 算法，用来确认长键坍缩不会在下游被重新引入。</summary>
    private static string DocumentStoreOpenApiControllerDeterministicId(string? idempotencyKey)
        => PrdAgent.Api.Controllers.Api.DocumentStoreOpenApiController
            .DeterministicId("kb-entry", idempotencyKey)!;
}
