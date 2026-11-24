using System.Text;
using PrdAgent.Api.Authentication;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Authentication;

/// <summary>
/// 签名载荷的**跨语言格式契约**（2026-09-09）。
///
/// 为什么单独一条：这个格式有两份实现——C# 的
/// <see cref="StableSmokeAuthenticationHandler.BuildCanonicalRequest"/>（验证方，SSOT）
/// 与 Node 的 cds/src/services/map-notifier.ts（签名方，CDS 给 MAP 发监控告警用）。
/// 两份实现各自漂移正是 predicate-and-wiring-discipline 形状 3 的经典形状。
///
/// 已有的 StableSmokeSignature_ShouldVerifyCanonicalBodyAndRejectMutation 只验证
/// 「自己签、自己验能过」——格式两边一起改，它照样绿，锁不住跨语言契约。
/// 所以这里用**固定向量**逐字节钉死：两侧测试共用同一组输入与同一个期望串，
/// 任一侧改了格式，另一侧的用例必须同步改，而不是等线上出现静默的 401。
///
/// 对应的 Node 侧用例：cds/tests/services/map-notifier.test.ts
/// 「格式与 MAP 的 BuildCanonicalRequest 逐字节一致」。
/// </summary>
public sealed class CanonicalRequestCrossLanguageContractTests
{
    // 两侧共用的固定向量。改这里就必须同步改 map-notifier.test.ts，反之亦然。
    private const string VectorPath = "/api/dashboard/notifications/events";
    private const long VectorTimestamp = 1757404800;
    private const string VectorNonce = "nonce-1";
    private const string VectorUsername = "cds-uptime-bot";
    private const string VectorBody = "{\"a\":1}";
    private const string VectorBodySha256Hex =
        "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";

    [Fact]
    public void 签名载荷必须逐字节等于跨语言约定的固定向量()
    {
        var canonical = StableSmokeAuthenticationHandler.BuildCanonicalRequest(
            "post",              // 方法要被规范成大写
            VectorPath,
            VectorTimestamp,
            VectorNonce,
            VectorUsername,
            VectorBody);

        var expected = string.Join('\n',
            "POST",
            VectorPath,
            VectorTimestamp.ToString(),
            VectorNonce,
            VectorUsername,
            VectorBodySha256Hex);

        canonical.ShouldBe(
            expected,
            customMessage: "签名载荷格式变了。它有 Node 侧第二实现（cds/src/services/map-notifier.ts），"
                + "不同步改就会让 CDS 的监控告警在 MAP 侧变成静默的 invalid_signature");
    }

    [Fact]
    public void 载荷各段以换行分隔且正文取小写十六进制哈希()
    {
        var canonical = StableSmokeAuthenticationHandler.BuildCanonicalRequest(
            "POST", VectorPath, VectorTimestamp, VectorNonce, VectorUsername, VectorBody);

        var parts = canonical.Split('\n');
        parts.Length.ShouldBe(6, customMessage: "六段：方法/路径/时间戳/nonce/用户名/正文哈希");
        parts[5].ShouldBe(VectorBodySha256Hex);
        // 大写十六进制或 Base64 都会让 Node 侧对不上——Convert.ToHexString 默认是大写，
        // 少了 ToLowerInvariant 这一步就是一次静默的跨语言断链。
        parts[5].ShouldBe(parts[5].ToLowerInvariant());
    }

    [Fact]
    public void 空正文也参与哈希而不是留空段()
    {
        var canonical = StableSmokeAuthenticationHandler.BuildCanonicalRequest(
            "POST", VectorPath, VectorTimestamp, VectorNonce, VectorUsername, string.Empty);

        var parts = canonical.Split('\n');
        parts[5].ShouldNotBeEmpty(customMessage: "空正文要哈希成 e3b0c442...，不是留一个空段");
        parts[5].Length.ShouldBe(64);
    }
}
