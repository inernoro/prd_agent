using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 熔断与半开恢复的守卫。
///
/// 背景（2026-09-11 审查）：这套东西原先有三个洞，共同点是编译过、测试绿、通读也挑不出来——
///
/// 1. 逻辑模型的 Offering 被标为不可用之后**永远不会自己回来**。所有候选查询都无条件
///    `Ne(HealthStatus, Unavailable)`，摘掉之后它再也拿不到一次成功来翻身；模型池成员有
///    冷却 + 半开租约 + 手工恢复三件套，Offering 一件都没有。于是「一个模型挂多条上游」
///    这个卖点在故障时反而更脆：线路越多熄灭得越多，且都要人去改一次密钥才复活。
/// 2. 失败计数用 $inc 原子累加，健康状态却是拿一次独立 Find 的旧快照 +1 算出来再 Set。
///    并发失败时各请求读到的是同一个自增前的值，谁最后落笔谁说了算——计数冲到几十而状态
///    被写回健康，断路器迟迟不跳，全部流量继续打向已经死掉的上游。
/// 3. 隔离路径（401/403 单次即摘）不清 HalfOpenLeaseUntil / ManualRecoveryAt，而普通失败
///    路径是清的。被人工恢复过一次的永久故障成员，于是每轮租约到期就重新抢占一次真实用户
///    请求的首发名额，且没有终止条件。
///
/// 前两条判据本身是纯函数，可以直接断行为；第三条与「接线在不在」属于删掉不会红的那类，
/// 用源码守卫钉住。
/// </summary>
public class GatewayCircuitBreakerGuardTests
{
    private static readonly string Resolver =
        ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");

    private static readonly string Console =
        ReadRepoFile("llmgw/console-api/Program.cs");

    [Theory]
    [InlineData(0, ModelHealthStatus.Healthy)]
    [InlineData(2, ModelHealthStatus.Healthy)]
    [InlineData(3, ModelHealthStatus.Degraded)]
    [InlineData(4, ModelHealthStatus.Degraded)]
    [InlineData(5, ModelHealthStatus.Unavailable)]
    [InlineData(50, ModelHealthStatus.Unavailable)]
    public void 按连续失败次数判定健康状态(int failures, ModelHealthStatus expected)
        => Assert.Equal(expected, GatewayCircuitBreakerPolicy.ClassifyByFailures(failures));

    [Fact]
    public void 失败路径只许把状态往坏处写()
    {
        // 并发下后到的旧快照算出的是更好的状态，必须不生效——否则计数已经过阈值、
        // 状态却被写回健康，断路器永远不跳。
        Assert.False(GatewayCircuitBreakerPolicy.IsEscalation(
            ModelHealthStatus.Unavailable, ModelHealthStatus.Healthy));
        Assert.False(GatewayCircuitBreakerPolicy.IsEscalation(
            ModelHealthStatus.Degraded, ModelHealthStatus.Healthy));
        Assert.False(GatewayCircuitBreakerPolicy.IsEscalation(
            ModelHealthStatus.Degraded, ModelHealthStatus.Degraded));

        Assert.True(GatewayCircuitBreakerPolicy.IsEscalation(
            ModelHealthStatus.Healthy, ModelHealthStatus.Degraded));
        Assert.True(GatewayCircuitBreakerPolicy.IsEscalation(
            ModelHealthStatus.Degraded, ModelHealthStatus.Unavailable));
    }

    [Fact]
    public void 冷却与租约有下限上限且默认值稳定()
    {
        Assert.Equal(120, GatewayCircuitBreakerPolicy.ResolveHalfOpenAfterSeconds(null));
        Assert.Equal(30, GatewayCircuitBreakerPolicy.ResolveHalfOpenLeaseSeconds(null));
        // 夹紧是为了挡住「填 0 秒冷却」这类把半开退化成无限重试的配置
        Assert.Equal(10, GatewayCircuitBreakerPolicy.ResolveHalfOpenAfterSeconds(0));
        Assert.Equal(3600, GatewayCircuitBreakerPolicy.ResolveHalfOpenAfterSeconds(99999));
        Assert.Equal(5, GatewayCircuitBreakerPolicy.ResolveHalfOpenLeaseSeconds(1));
        Assert.Equal(300, GatewayCircuitBreakerPolicy.ResolveHalfOpenLeaseSeconds(99999));
    }

    [Fact]
    public void 阈值只有一份且两条路径都读它()
    {
        // 阈值曾经是两份硬编码字面量（Offering 一份、池成员一份），恰好相同但没有任何东西
        // 保证它们一起改。判据分裂之后各自漂移，是本仓库反复出现的形状。
        Assert.DoesNotContain("failures >= 5 ? ModelHealthStatus.Unavailable", Resolver);
        Assert.DoesNotContain("newFailures >= 5 ? ModelHealthStatus.Unavailable", Resolver);
        Assert.Contains("GatewayCircuitBreakerPolicy.ClassifyByFailures", Resolver);
    }

    [Fact]
    public void 失败写入必须先原子自增再据真值升级()
    {
        var failure = MethodSource("public async Task RecordFailureAsync");

        // 不许退回「先 Find 一次拿旧快照，+1 算状态，再 Set」
        Assert.DoesNotContain("var current = await offerings.Find(filter).FirstOrDefaultAsync(ct);", failure);
        Assert.DoesNotContain("current.ConsecutiveFailures + 1", failure);
        Assert.DoesNotContain("model.ConsecutiveFailures + 1", failure);

        // 两条路径都必须拿自增后的真值
        Assert.Contains("ReturnDocument = ReturnDocument.After", failure);
        Assert.Equal(2, CountOccurrences(failure, "ReturnDocument = ReturnDocument.After"));
        Assert.Contains("GatewayCircuitBreakerPolicy.IsEscalation", failure);
    }

    [Fact]
    public void 隔离路径必须清掉半开痕迹()
    {
        var quarantine = MethodSource("public async Task RecordUnavailableAsync");

        // Offering 侧
        Assert.Contains(".Unset(x => x.HalfOpenLeaseUntil)", quarantine);
        Assert.Contains(".Unset(x => x.ManualRecoveryAt)", quarantine);
        // 池成员侧
        Assert.Contains(".Unset(\"Models.$.HalfOpenLeaseUntil\")", quarantine);
        Assert.Contains(".Unset(\"Models.$.ManualRecoveryAt\")", quarantine);
    }

    [Fact]
    public void Offering半开认领已接上线且是原子写()
    {
        // 接线：算出来没人用等于没做（本仓库最常见的形状）
        Assert.Contains("TryClaimHalfOpenOfferingAsync", Resolver);
        Assert.True(
            CountOccurrences(Resolver, "TryClaimHalfOpenOfferingAsync") >= 2,
            "TryClaimHalfOpenOfferingAsync 只有定义没有调用方：半开恢复建了一半");

        var claim = MethodSource("private async Task<GatewayModelOffering?> TryClaimHalfOpenOfferingAsync");
        // 必须是条件写 + 取回结果判空，不是先读后写
        Assert.Contains("FindOneAndUpdateAsync", claim);
        Assert.Contains("fb.Eq(x => x.HealthStatus, ModelHealthStatus.Unavailable)", claim);
        // 租约自带过期，探针实例宕机不会把 Offering 永久锁死
        Assert.Contains("fb.Lte(x => x.HalfOpenLeaseUntil, now)", claim);
        Assert.Contains(".Set(x => x.HalfOpenLeaseUntil,", claim);
        // 冷却窗与手工恢复两条资格线都要在
        Assert.Contains("fb.Lte(x => x.LastFailedAt, cutoff)", claim);
        Assert.Contains("fb.Lte(x => x.ManualRecoveryAt, now)", claim);
    }

    [Fact]
    public void Offering成功后清租约否则下一轮还会被当成待试探()
    {
        var success = MethodSource("public async Task RecordSuccessAsync");
        var offeringBranch = success[..success.IndexOf("resolution.ModelGroupId", StringComparison.Ordinal)];
        Assert.Contains(".Unset(x => x.HalfOpenLeaseUntil)", offeringBranch);
        Assert.Contains(".Unset(x => x.ManualRecoveryAt)", offeringBranch);
    }

    [Fact]
    public void 控制台有手工恢复Offering的入口()
    {
        // 在这之前，被隔离的 Offering 只能靠「去改一次平台密钥」这种副作用复活。
        var start = Console.IndexOf(
            "app.MapPost(\"/gw/logical-models/{logicalId}/offerings/{offeringId}/recover\"",
            StringComparison.Ordinal);
        Assert.True(start >= 0, "缺少 Offering 手工恢复端点，被隔离的上游线路没有人工复活入口");
        var end = Console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start);
        var handler = Console[start..end];

        // 恢复的语义是「给半开资格」，不是「直接放回健康」——后者会让并发流量立刻冲刚回血的上游
        Assert.Contains("\"HealthStatus\", 2", handler);
        Assert.Contains("\"ManualRecoveryAt\"", handler);
        Assert.Contains(".Unset(\"HalfOpenLeaseUntil\")", handler);
        Assert.Contains("model-offering.recover", handler);
    }

    private static string MethodSource(string signature)
    {
        var start = Resolver.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到方法：{signature}");
        var depth = 0;
        var seenOpen = false;
        for (var i = start; i < Resolver.Length; i++)
        {
            if (Resolver[i] == '{') { depth++; seenOpen = true; }
            else if (Resolver[i] == '}')
            {
                depth--;
                if (seenOpen && depth == 0) return Resolver[start..(i + 1)];
            }
        }
        Assert.Fail($"方法 {signature} 的花括号没有配平，守卫的取值口径需要更新");
        return string.Empty;
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }
        return count;
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }
}
