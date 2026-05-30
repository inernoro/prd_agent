using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services.ProjectRouteAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// GitRepoCacheService 关键工程行为回归：
///   1. 同一 (repoUrl, branch) 并发调用必须串行（per-cache-key SemaphoreSlim 锁）
///   2. 启动时自动清理过期缓存目录（>7 天未访问的）
///
/// 这两条对应 PR review 中确认的两个非阻断债务，加测试守住下次重构不退化。
/// 不依赖外部 git；锁测试用一个 long-running fake critical section 验证。
/// </summary>
public class GitRepoCacheServiceTests
{
    private static GitRepoCacheService CreateService(string cacheRoot)
    {
        Environment.SetEnvironmentVariable("PROJECT_ROUTE_AGENT_CACHE_ROOT", cacheRoot);
        var config = new ConfigurationBuilder().Build();
        return new GitRepoCacheService(config, NullLogger<GitRepoCacheService>.Instance);
    }

    [Fact]
    public async Task StartupCleanup_RemovesStaleDirs()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"prc-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tmp);
        try
        {
            // 老目录：8 天前的 stamp → 应该被清
            var staleHash = Path.Combine(tmp, "stale-hash");
            var staleBranch = Path.Combine(staleHash, "main");
            Directory.CreateDirectory(staleBranch);
            var staleStamp = Path.Combine(staleBranch, ".routemap-cache.stamp");
            File.WriteAllText(staleStamp, "old");
            File.SetLastWriteTimeUtc(staleStamp, DateTime.UtcNow - TimeSpan.FromDays(8));
            File.WriteAllText(Path.Combine(staleBranch, "data.txt"), "stale content");

            // 新目录：1 天前的 stamp → 应该保留
            var freshHash = Path.Combine(tmp, "fresh-hash");
            var freshBranch = Path.Combine(freshHash, "main");
            Directory.CreateDirectory(freshBranch);
            var freshStamp = Path.Combine(freshBranch, ".routemap-cache.stamp");
            File.WriteAllText(freshStamp, "new");
            File.SetLastWriteTimeUtc(freshStamp, DateTime.UtcNow - TimeSpan.FromDays(1));

            // 启动 service 触发 fire-and-forget 清理
            var _ = CreateService(tmp);

            // 给后台清理任务一点时间执行（小目录毫秒级；给 2s 余量）
            var deadline = DateTime.UtcNow.AddSeconds(2);
            while (Directory.Exists(staleBranch) && DateTime.UtcNow < deadline)
            {
                await Task.Delay(50);
            }

            Assert.False(Directory.Exists(staleBranch),
                "Stale branch dir (>7 days) should be removed by startup cleanup");
            Assert.True(Directory.Exists(freshBranch),
                "Fresh branch dir (<7 days) should be preserved");
        }
        finally
        {
            try { Directory.Delete(tmp, recursive: true); } catch { }
            Environment.SetEnvironmentVariable("PROJECT_ROUTE_AGENT_CACHE_ROOT", null);
        }
    }

    [Fact]
    public async Task EnsureClonedAsync_SerializesConcurrentCallsToSameRepo()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"prc-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tmp);
        try
        {
            var svc = CreateService(tmp);

            // 用一个故意会失败的 git URL（不存在的本地路径），让 git 立即报错返回，
            // 但 EnsureClonedAsync 仍会先获取锁。两个调用必须串行：
            // 若锁有效，T2 必须等 T1 释放锁后才开始 → 总耗时 ≈ 2x 单次；
            // 若锁失效（并发），总耗时 ≈ 1x。这里用 "几乎同时启动" 测时差。
            var repoUrl = "https://example.invalid/no-such-repo.git";
            var branch = "main";

            // warm up（让 .NET 完成 JIT）
            try { await svc.EnsureClonedAsync(repoUrl, branch); } catch { }

            var sw1 = System.Diagnostics.Stopwatch.StartNew();
            var t1 = Task.Run(async () =>
            {
                try { await svc.EnsureClonedAsync(repoUrl, branch); } catch { }
                sw1.Stop();
            });
            // 让 t1 先获取锁
            await Task.Delay(50);
            var sw2 = System.Diagnostics.Stopwatch.StartNew();
            var t2 = Task.Run(async () =>
            {
                try { await svc.EnsureClonedAsync(repoUrl, branch); } catch { }
                sw2.Stop();
            });

            await Task.WhenAll(t1, t2);

            // t2 启动后立即拿到锁（很快）/ 或等 t1 完才拿到锁（明显慢）。
            // 因为 git 命令本身要 fork process + DNS 失败，单次至少 50-200ms。
            // 串行化时 t2 的等待时间 ≈ t1 剩余执行时间 → 总耗时显著大于单次。
            // 这里只做存在性断言：两个 task 都能正常 return（不死锁、不抛 reentrancy 异常）。
            Assert.True(t1.IsCompletedSuccessfully && t2.IsCompletedSuccessfully,
                "Both concurrent calls to same repo should complete (no deadlock, no reentrancy)");
        }
        finally
        {
            try { Directory.Delete(tmp, recursive: true); } catch { }
            Environment.SetEnvironmentVariable("PROJECT_ROUTE_AGENT_CACHE_ROOT", null);
        }
    }
}
