using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 同一个站点同时只许跑一次开场问题生成——两条入口共用同一把锁。
///
/// 后台那条（QueueEnsure）本来就抢 _inFlight，同步那条（EnsureAsync，owner 点「重新生成」）
/// 原先直接调 RunAsync 绕过去了。于是连点两次、或重新生成撞上一次后台生成时，两次执行都会
/// 完整烧一次模型调用，owner 被计两次费，最后谁写完算谁的。这类「门只装了一半」删掉之后
/// 全量测试照样全绿，所以必须有这一条。
/// </summary>
public class AskOpenerInFlightTests
{
    [Fact]
    public async Task 已经有一次在跑时_同步入口返回_Busy_且不再开第二次()
    {
        using var scopeEntered = new ManualResetEventSlim(false);
        using var releaseScope = new ManualResetEventSlim(false);
        var factory = new BlockingScopeFactory(scopeEntered, releaseScope);
        var generator = new AskOpeningQuestionGenerator(factory, NullLogger<AskOpeningQuestionGenerator>.Instance);

        // 第一次：卡在建 scope 那一步，模拟「一次生成正在跑」
        var first = Task.Run(() => generator.EnsureAsync("site-inflight"));
        Assert.True(scopeEntered.Wait(TimeSpan.FromSeconds(10)), "第一次调用没能进到建 scope 这一步");

        // 第二次：必须当场判 Busy，而不是又建一个 scope 去跑第二次模型调用
        var second = await generator.EnsureAsync("site-inflight");
        Assert.Equal(AskOpenerOutcome.Busy, second);
        Assert.Equal(1, factory.CreateScopeCalls);

        releaseScope.Set();
        try { await first; } catch { /* 放行后第一次会因为拿不到真实依赖而炸，与本条无关 */ }

        // 跑完要把位子让出来：不还锁的话这个站点从此再也生成不了，比重复生成更糟
        Assert.NotEqual(AskOpenerOutcome.Busy, await SafeEnsureAsync(generator, "site-inflight"));
    }

    [Fact]
    public async Task 不同站点之间互不阻塞()
    {
        using var scopeEntered = new ManualResetEventSlim(false);
        using var releaseScope = new ManualResetEventSlim(false);
        var factory = new BlockingScopeFactory(scopeEntered, releaseScope);
        var generator = new AskOpeningQuestionGenerator(factory, NullLogger<AskOpeningQuestionGenerator>.Instance);

        var first = Task.Run(() => generator.EnsureAsync("site-a"));
        Assert.True(scopeEntered.Wait(TimeSpan.FromSeconds(10)));

        // 锁是按站点分的：另一个站点不该被这一次拖住
        Assert.NotEqual(AskOpenerOutcome.Busy, await SafeEnsureAsync(generator, "site-b"));

        releaseScope.Set();
        try { await first; } catch { }
    }

    /// <summary>
    /// 只关心「有没有被判 Busy」，不关心拿不到真实依赖之后炸成什么样。
    /// 抛异常说明它已经越过了 Busy 那道门，正是本条要断言的。
    /// </summary>
    private static async Task<AskOpenerOutcome> SafeEnsureAsync(
        AskOpeningQuestionGenerator generator, string siteId)
    {
        try
        {
            return await generator.EnsureAsync(siteId);
        }
        catch
        {
            return AskOpenerOutcome.ModelUnavailable;
        }
    }

    private sealed class BlockingScopeFactory : IServiceScopeFactory
    {
        private readonly ManualResetEventSlim _entered;
        private readonly ManualResetEventSlim _release;
        private int _calls;

        internal BlockingScopeFactory(ManualResetEventSlim entered, ManualResetEventSlim release)
        {
            _entered = entered;
            _release = release;
        }

        internal int CreateScopeCalls => Volatile.Read(ref _calls);

        public IServiceScope CreateScope()
        {
            // 第一次进来就卡住，后续的直接放行——这样「第二次有没有进来」才能被数出来。
            if (Interlocked.Increment(ref _calls) == 1)
            {
                _entered.Set();
                _release.Wait(TimeSpan.FromSeconds(30));
            }
            return new EmptyScope();
        }

        private sealed class EmptyScope : IServiceScope
        {
            public IServiceProvider ServiceProvider { get; } =
                new ServiceCollection().BuildServiceProvider();

            public void Dispose() { }
        }
    }
}
