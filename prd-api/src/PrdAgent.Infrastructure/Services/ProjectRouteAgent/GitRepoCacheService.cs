using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services.ProjectRouteAgent;

/// <summary>
/// 项目路由智能体的轻量级 git 仓库浅克隆 + routemap 目录读取助手。
/// 设计要点：
/// - 把任意 git 仓库以 --depth=1 浅克隆到 /tmp/project-route-agent-cache/{sha1(url)}/{branch}
/// - 二次访问优先 git fetch + reset；fetch 失败回退到删目录重新 clone
/// - 缓存命中条件：目录存在 + 6 小时内拉取过
/// - 只读取约定的 routemap 子目录，限制单文件 256KB / 单仓库 2MB，防爆内存
/// </summary>
public sealed class GitRepoCacheService
{
    private static readonly TimeSpan FreshnessWindow = TimeSpan.FromHours(6);
    /// <summary>启动时清理：超过 7 天未访问的缓存目录直接删，防止 /tmp 无限累积。</summary>
    private static readonly TimeSpan StaleEvictionAge = TimeSpan.FromDays(7);
    private const int MaxFileBytes = 256 * 1024;
    private const int MaxTotalBytes = 2 * 1024 * 1024;
    private const int MaxFileCount = 300;

    private readonly ILogger<GitRepoCacheService> _logger;
    private readonly string _cacheRoot;

    /// <summary>
    /// 同一仓库的串行化锁，按缓存目录路径 key。
    /// 解决：Singleton + 多并发请求时，两个用户同时引用同一个 repoUrl 会同时
    /// 进入 TryRecursiveDelete + clone 流程，互相破坏对方的目录。
    /// 注：这是进程内锁，多副本部署时仍可能并发（属于部署架构问题，不在此修）。
    /// </summary>
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _repoLocks = new();

    public GitRepoCacheService(IConfiguration configuration, ILogger<GitRepoCacheService> logger)
    {
        _logger = logger;
        _cacheRoot = Environment.GetEnvironmentVariable("PROJECT_ROUTE_AGENT_CACHE_ROOT")
            ?? configuration["ProjectRouteAgent:CacheRoot"]
            ?? Path.Combine(Path.GetTempPath(), "project-route-agent-cache");
        Directory.CreateDirectory(_cacheRoot);

        // fire-and-forget 启动清理：扫描并删除超过 StaleEvictionAge 未访问的目录。
        // 异步执行，不阻塞应用启动；失败仅记录日志。
        _ = Task.Run(CleanupStaleAsync);
    }

    private SemaphoreSlim GetRepoLock(string cacheDir)
        => _repoLocks.GetOrAdd(cacheDir, _ => new SemaphoreSlim(1, 1));

    /// <summary>
    /// 获取指定缓存目录的串行化锁；返回的 IDisposable 在 Dispose 时自动释放。
    /// 调用方写 `using var _ = await AcquireRepoLockAsync(dir, ct);` 即可。
    /// </summary>
    private async Task<IDisposable> AcquireRepoLockAsync(string cacheDir, CancellationToken ct)
    {
        var sem = GetRepoLock(cacheDir);
        await sem.WaitAsync(ct);
        return new RepoLockHandle(sem);
    }

    private sealed class RepoLockHandle : IDisposable
    {
        private SemaphoreSlim? _sem;
        public RepoLockHandle(SemaphoreSlim sem) { _sem = sem; }
        public void Dispose()
        {
            var s = System.Threading.Interlocked.Exchange(ref _sem, null);
            try { s?.Release(); } catch { /* 已 dispose 或异常时静默 */ }
        }
    }

    /// <summary>
    /// 确保仓库已克隆到本地缓存，返回 checkout 后的本地工作目录。
    /// 失败时抛 <see cref="GitRepoCacheException"/>。
    ///
    /// 鲁棒性策略（按顺序尝试）：
    ///   A. 缓存目录新鲜（6h 内） → 直接复用
    ///   B. 已有 .git 但过期 → fetch + reset 兜底（最快）
    ///   C. 重新 clone（带 1 次重试，应对网络抖动）
    ///   D. clone 失败但仓库残留 → 仍能用残留目录读 routemap（best-effort 降级）
    ///
    /// <paramref name="accessToken"/>：可选 GitHub OAuth access token。
    ///   - 传入时，URL 注入 `https://x-access-token:{token}@github.com/...` 形式，私有 / 组织仓库也能拉
    ///   - 传入时也建议加 `Authorization: token` header（git clone 透过 -c http.extraHeader 实现），
    ///     但 GitHub 的 x-access-token 内联 URL 方式已经足够覆盖绝大多数 case，简化路径
    ///   - **缓存 key 与 token 解耦**：换 token 不会让缓存失效（同一仓库同分支同一份 routemap 内容）
    /// </summary>
    public async Task<string> EnsureClonedAsync(
        string repoUrl,
        string branch,
        string? accessToken = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(repoUrl))
            throw new GitRepoCacheException("仓库 URL 不能为空");
        repoUrl = NormalizeRepoUrl(repoUrl);
        if (!IsSafeGitUrl(repoUrl))
            throw new GitRepoCacheException($"非法的仓库 URL：{repoUrl}");
        if (string.IsNullOrWhiteSpace(branch)) branch = "main";
        if (!IsSafeGitRef(branch))
            throw new GitRepoCacheException($"非法的分支名：{branch}");

        var dir = ResolveCacheDir(repoUrl, branch);

        // 串行化同一仓库的并发请求：两个用户同时引用同一个 repoUrl 时，
        // 后到者必须等先到者完成 clone/fetch，避免互相删对方的 .git 目录。
        // 锁粒度=cacheDir，不同仓库可并行。锁会随 using 自动释放，包括异常路径。
        using var __repoLock = await AcquireRepoLockAsync(dir, ct);

        // 注入 OAuth token 到 URL（仅 https）。token 不出现在日志 / 缓存路径里。
        var cloneUrl = InjectTokenIntoUrl(repoUrl, accessToken);
        var hasToken = !ReferenceEquals(cloneUrl, repoUrl);

        var fresh = Directory.Exists(Path.Combine(dir, ".git"))
                    && IsFresh(dir);

        if (fresh)
        {
            // 安全关键：缓存目录是按 (repoUrl, branch) 哈希的全局共享缓存，
            // 不按用户 ID 隔离。如果用户 A 用 OAuth 拉过私有仓库，6h 新鲜窗口内
            // 用户 B 只要在 site spec 里引用同一 URL，**复用缓存就等于绕过 B 的访问授权**。
            //
            // 修复：复用前用 *当前请求的凭据* 做一次轻量 ls-remote 探测；
            //   - 探测通过 → 当前用户对该 repo 至少有 read 权 → 复用缓存安全
            //   - 探测失败 → 用户没权（或仓库不存在）→ 不复用，下降到正常 clone 路径
            //     （让该用户用自己的凭据重新拉，失败也会得到属于他自己的错误信息）
            //
            // ls-remote 不下载对象，只查询 refs，毫秒级开销。
            var authorized = await ProbeAccessAsync(cloneUrl, branch, accessToken, ct);
            if (authorized)
            {
                _logger.LogDebug("[GitRepoCache] reuse fresh cache for {Repo}@{Branch}: {Dir}", repoUrl, branch, dir);
                return dir;
            }
            _logger.LogInformation(
                "[GitRepoCache] cache exists but caller credentials cannot access {Repo}@{Branch}, will re-clone with caller credentials",
                repoUrl, branch);
            // 不直接 return；继续走下方 fetch / clone 路径，按当前用户凭据拉
        }

        var errorTrail = new List<string>();

        try
        {
            // 策略 B：已有 .git 但过期 → 优先用 fetch + reset。
            // 若有 token，**临时**覆盖 origin URL（旧 URL 可能不带 token / 用了旧 token），
            // 用完后无论 fetch 成败都用 try/finally 把 origin 还原回不带 token 的 repoUrl —— 否则
            // OAuth token 会持久化在 `.git/config` 里，后续任何复用者都能读到。
            if (Directory.Exists(Path.Combine(dir, ".git")))
            {
                try
                {
                    if (hasToken)
                    {
                        await RunGitAsync(new[] { "remote", "set-url", "origin", cloneUrl }, dir, 10, ct);
                    }
                    var (fok, fout) = await RunGitAsync(new[] { "fetch", "--depth=1", "origin", branch }, dir, 120, ct);
                    if (fok)
                    {
                        var (rok, rout) = await RunGitAsync(new[] { "reset", "--hard", "FETCH_HEAD" }, dir, 30, ct);
                        if (rok)
                        {
                            TouchCacheStamp(dir);
                            return dir;
                        }
                        errorTrail.Add($"reset 失败：{Truncate(rout, 300)}");
                        _logger.LogWarning("[GitRepoCache] reset failed, will reclone: {Out}", rout);
                    }
                    else
                    {
                        errorTrail.Add($"fetch 失败：{Truncate(fout, 300)}");
                        _logger.LogWarning("[GitRepoCache] fetch failed, will reclone: {Out}", fout);
                    }
                }
                finally
                {
                    // 关键安全步骤：把 origin 还原成不带 token 的版本。
                    // 无论上面 fetch / reset 成功失败、抛异常都必须执行。
                    // 失败路径下我们随后会 TryRecursiveDelete 整个 dir，但 finally 是更可靠的兜底。
                    if (hasToken)
                    {
                        try
                        {
                            await RunGitAsync(new[] { "remote", "set-url", "origin", repoUrl }, dir, 10, CancellationToken.None);
                        }
                        catch
                        {
                            // 已尽力，落到 reclone 路径时会被整个删除
                        }
                    }
                }
            }

            // 策略 C：clone，带 1 次重试
            string? lastCloneError = null;
            for (var attempt = 1; attempt <= 2; attempt++)
            {
                if (Directory.Exists(dir))
                {
                    TryRecursiveDelete(dir);
                }
                Directory.CreateDirectory(dir);

                var (cok, cout) = await RunGitAsync(new[]
                {
                    "clone",
                    "--depth=1",
                    "--single-branch",
                    "--branch", branch,
                    cloneUrl,
                    dir,
                }, cwd: _cacheRoot, timeoutSeconds: 180, ct: ct, secretToMask: accessToken);

                if (cok)
                {
                    // 把 origin URL 改回不带 token 的形式 —— 后续 fetch 都从 set-url 那条路径走
                    if (hasToken)
                    {
                        await RunGitAsync(new[] { "remote", "set-url", "origin", repoUrl }, dir, 10, ct);
                    }
                    TouchCacheStamp(dir);
                    return dir;
                }

                lastCloneError = Truncate(cout, 600);
                errorTrail.Add($"clone 尝试 {attempt}/2 失败：{lastCloneError}");
                _logger.LogWarning("[GitRepoCache] clone attempt {Attempt}/2 failed for {Repo}@{Branch}: {Err}",
                    attempt, repoUrl, branch, lastCloneError);

                // 关键 fallback：分支不存在错误立刻退出重试循环，下面用 default branch 救场
                if (IsBranchNotFoundError(cout))
                {
                    errorTrail.Add("检测到「Remote branch not found」—— 跳过重试，尝试 fallback 到仓库默认分支");
                    break;
                }

                if (attempt == 1)
                {
                    // 短暂等待网络抖动恢复
                    try { await Task.Delay(TimeSpan.FromSeconds(2), ct); }
                    catch (OperationCanceledException) { break; }
                }
            }

            // 策略 D：分支不存在 → 用仓库 default branch 救场
            // 走 `git clone --depth=1`（不带 --branch / --single-branch），git 会用 remote HEAD 指向的分支
            if (lastCloneError != null && IsBranchNotFoundError(lastCloneError))
            {
                if (Directory.Exists(dir)) TryRecursiveDelete(dir);
                Directory.CreateDirectory(dir);

                var (dok, dout) = await RunGitAsync(new[]
                {
                    "clone",
                    "--depth=1",
                    cloneUrl,
                    dir,
                }, cwd: _cacheRoot, timeoutSeconds: 180, ct: ct, secretToMask: accessToken);

                if (dok)
                {
                    if (hasToken)
                    {
                        await RunGitAsync(new[] { "remote", "set-url", "origin", repoUrl }, dir, 10, ct);
                    }
                    var (sok, sout) = await RunGitAsync(new[] { "symbolic-ref", "--short", "HEAD" }, dir, 10, ct);
                    var actualBranch = sok ? sout.Trim() : "(default)";
                    _logger.LogInformation(
                        "[GitRepoCache] {Repo}: 请求分支 '{Requested}' 不存在，已 fallback 到默认分支 '{Actual}'",
                        repoUrl, branch, actualBranch);
                    TouchCacheStamp(dir);
                    return dir;
                }

                errorTrail.Add($"fallback default branch clone 也失败：{Truncate(dout, 400)}");
            }

            // 全部失败 → 抛带完整 trail 的异常
            throw new GitRepoCacheException(
                $"克隆 {repoUrl}@{branch} 失败：\n - " + string.Join("\n - ", errorTrail));
        }
        catch (GitRepoCacheException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new GitRepoCacheException($"克隆 {repoUrl}@{branch} 失败：{ex.Message}", ex);
        }
    }

    /// <summary>
    /// 轻量探测当前凭据对指定 repo + branch 是否有访问权（git ls-remote --heads）。
    /// 仅查询 refs，不下载对象，毫秒级开销。
    /// 用于缓存复用前的授权校验，防止跨用户缓存绕权。
    ///
    /// 返回 true ⇔ exit code 0 且输出里能看到目标分支的 ref（或 branch 为空时只要 exit 0）。
    /// 注：若同样的 URL 用 ls-remote 失败但用 clone 成功（罕见），我们宁可保守拒绝复用——
    ///   会进入下方 fetch/clone 路径，用同样凭据再试一次，失败信息也属于当前用户。
    /// </summary>
    private async Task<bool> ProbeAccessAsync(
        string cloneUrl,
        string branch,
        string? secretToMask,
        CancellationToken ct)
    {
        try
        {
            // ls-remote 是 stateless，对工作目录无要求；用 cacheRoot 作 cwd
            var args = new List<string> { "ls-remote", "--heads", "--exit-code", cloneUrl };
            if (!string.IsNullOrWhiteSpace(branch))
            {
                args.Add(branch);
            }
            var (ok, output) = await RunGitAsync(args, _cacheRoot, timeoutSeconds: 15, ct, secretToMask: secretToMask);
            if (ok) return true;

            // exit-code != 0 时不是真"没权"的也可能是分支不存在；分支不存在仍属于"用户能读到该仓库 refs 列表"
            // 但 --exit-code 模式下 refs 不存在也会非 0。再退一步：不带 branch 单纯查仓库可达性
            if (!string.IsNullOrEmpty(output) && IsBranchNotFoundError(output))
            {
                // 分支不存在但仓库本身可读
                var (ok2, _) = await RunGitAsync(
                    new[] { "ls-remote", "--heads", cloneUrl },
                    _cacheRoot, 15, ct, secretToMask);
                return ok2;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 判断 git clone 的错误信息是不是「请求的分支在远端不存在」。
    /// git 实际报错信息：
    ///   "Remote branch main not found in upstream origin"
    ///   "fatal: Remote branch xxx not found in upstream origin"
    ///   "warning: Could not find remote branch main to clone."
    /// 注：仅 GitHub / GitLab 多见这套文案；其他 git 服务文案略有差异但关键词覆盖。
    /// </summary>
    private static bool IsBranchNotFoundError(string output)
    {
        if (string.IsNullOrEmpty(output)) return false;
        return output.Contains("Remote branch", StringComparison.OrdinalIgnoreCase)
               && (output.Contains("not found", StringComparison.OrdinalIgnoreCase)
                   || output.Contains("Could not find", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// 把 GitHub OAuth access token 注入 https URL（同 PR 审查智能体的鉴权方式）：
    ///   https://github.com/x/y.git → https://x-access-token:{token}@github.com/x/y.git
    /// 仅 https/http 注入；其他协议（git@/ssh）原样返回。
    /// 如果 URL 里已经有用户名:密码段，也原样返回（不覆盖用户显式给的凭据）。
    /// </summary>
    private static string InjectTokenIntoUrl(string url, string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return url;
        if (string.IsNullOrWhiteSpace(url)) return url;
        var prefix = url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            ? "https://"
            : url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ? "http://" : null;
        if (prefix == null) return url;
        var rest = url[prefix.Length..];
        if (rest.Contains('@')) return url; // 已有内联凭据，不覆盖
        return $"{prefix}x-access-token:{token}@{rest}";
    }

    /// <summary>
    /// URL 归一化：自动补 .git 后缀（GitHub / GitLab 都支持，避免「页面 URL 当 git URL」典型错误）。
    /// </summary>
    private static string NormalizeRepoUrl(string url)
    {
        var trimmed = url.Trim().TrimEnd('/');
        if (trimmed.Length == 0) return trimmed;
        if (trimmed.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) return trimmed;
        // 只对 https / http / ssh 协议补 .git；git@ 形式通常已经有
        if (trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("ssh://", StringComparison.OrdinalIgnoreCase))
        {
            return trimmed + ".git";
        }
        return trimmed;
    }

    /// <summary>
    /// 列出 routemap 目录下的所有文件（路径相对**仓库根**、含内容片段）。
    ///
    /// 查找策略（按顺序）：
    ///   1. 指定路径优先：&lt;repo&gt;/{routemapRelative} 直接命中就先用它
    ///   2. 递归搜索：BFS 在仓库内找所有同名（routemap basename）的目录，最大深度 6
    ///      （应对 monorepo：apps/billing/routemap、services/x/routemap、prd-api/routemap 等）
    ///   3. 跳过噪声目录：.git / node_modules / bin / obj / dist / target / .next / .nuxt /
    ///      build / out / __pycache__ / vendor
    ///   4. 多个候选都收，合并到同一份 Snapshot（每个文件 Path 是相对仓库根的完整路径，能区分来源）
    ///
    /// 不存在时返回空清单 + 在 missing 标记里写出原因。
    /// </summary>
    public RoutemapSnapshot ReadRoutemap(string repoRoot, string routemapRelative)
    {
        var snapshot = new RoutemapSnapshot();
        var rel = string.IsNullOrWhiteSpace(routemapRelative)
            ? "routemap"
            : routemapRelative.Trim().TrimStart('/').Replace('\\', '/');

        // 提取要查找的目录 basename：'routemap' / 'docs/routemap' → 'routemap'
        var simpleName = rel.Contains('/') ? rel.Split('/').Last() : rel;
        if (string.IsNullOrWhiteSpace(simpleName)) simpleName = "routemap";

        var hitLocations = new List<string>();

        // 1. 优先：指定路径直接命中
        var specifiedAbs = Path.GetFullPath(Path.Combine(repoRoot, rel));
        if (IsInside(repoRoot, specifiedAbs) && Directory.Exists(specifiedAbs))
        {
            hitLocations.Add(specifiedAbs);
        }

        // 2. 递归找所有同名子目录
        var subHits = FindDirsByName(repoRoot, simpleName, maxDepth: 6);
        foreach (var d in subHits)
        {
            if (!hitLocations.Any(x => string.Equals(x, d, StringComparison.OrdinalIgnoreCase)))
                hitLocations.Add(d);
        }

        if (hitLocations.Count == 0)
        {
            snapshot.Missing = $"仓库内未找到 {simpleName} 目录（已递归搜索子目录，最大深度 6）";
            return snapshot;
        }

        // 暴露给上层
        snapshot.AbsolutePath = hitLocations[0];
        snapshot.RelativePath = Path.GetRelativePath(repoRoot, hitLocations[0])
            .Replace(Path.DirectorySeparatorChar, '/');
        snapshot.FoundLocations = hitLocations
            .Select(d => Path.GetRelativePath(repoRoot, d).Replace(Path.DirectorySeparatorChar, '/'))
            .ToList();

        var total = 0;
        foreach (var location in hitLocations)
        {
            if (snapshot.Entries.Count >= MaxFileCount) break;
            if (total >= MaxTotalBytes) break;

            foreach (var path in Directory.EnumerateFiles(location, "*", SearchOption.AllDirectories)
                                           .OrderBy(p => p, StringComparer.Ordinal))
            {
                if (snapshot.Entries.Count >= MaxFileCount) break;
                if (total >= MaxTotalBytes) break;

                // 文件路径用相对**仓库根**的完整路径（含 routemap 目录前缀），
                // 这样 monorepo 多个 routemap 也能区分来源。
                var relativePath = Path.GetRelativePath(repoRoot, path)
                    .Replace(Path.DirectorySeparatorChar, '/');
                try
                {
                    var info = new FileInfo(path);
                    var read = (int)Math.Min(info.Length, MaxFileBytes);
                    string? content = null;
                    if (read > 0 && LooksLikeText(path))
                    {
                        var buf = new byte[read];
                        using var fs = File.OpenRead(path);
                        var got = fs.Read(buf, 0, read);
                        content = Encoding.UTF8.GetString(buf, 0, got);
                    }
                    total += read;
                    snapshot.Entries.Add(new RoutemapEntry
                    {
                        Path = relativePath,
                        SizeBytes = info.Length,
                        ContentPreview = content,
                    });
                }
                catch (Exception ex)
                {
                    snapshot.Entries.Add(new RoutemapEntry
                    {
                        Path = relativePath,
                        SizeBytes = 0,
                        ContentPreview = $"[读取失败：{ex.Message}]",
                    });
                }
            }
        }

        return snapshot;
    }

    /// <summary>
    /// BFS 找仓库内所有同名目录（按 basename 匹配，大小写不敏感），最多 maxDepth 层。
    /// 跳过 .git / node_modules / bin / obj / dist / target / .next / .nuxt / build / out /
    /// __pycache__ / vendor 等噪声目录（避免在 build artifacts 里找到假阳性）。
    /// </summary>
    private static List<string> FindDirsByName(string repoRoot, string targetName, int maxDepth)
    {
        var results = new List<string>();
        var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".git", "node_modules", "bin", "obj", "dist", "target", ".next", ".nuxt",
            "build", "out", "__pycache__", "vendor", ".venv", "venv", "publish",
            ".idea", ".vs", ".vscode",
        };

        // BFS 队列：(dir, depth)
        var queue = new Queue<(string Dir, int Depth)>();
        queue.Enqueue((repoRoot, 0));

        while (queue.Count > 0)
        {
            var (cur, depth) = queue.Dequeue();
            if (depth > maxDepth) continue;

            string[] children;
            try { children = Directory.GetDirectories(cur); }
            catch { continue; }

            foreach (var child in children)
            {
                var name = Path.GetFileName(child);
                if (skip.Contains(name)) continue;

                if (string.Equals(name, targetName, StringComparison.OrdinalIgnoreCase))
                {
                    // 已经在指定路径策略里加过的根 routemap，不重复
                    results.Add(child);
                    // 命中后不再下钻（不在 routemap 内部继续找 routemap）
                    continue;
                }
                if (depth < maxDepth) queue.Enqueue((child, depth + 1));
            }
        }

        return results;
    }

    private string ResolveCacheDir(string repoUrl, string branch)
    {
        var hash = Hash(repoUrl);
        var safeBranch = SanitizeForPath(branch);
        return Path.Combine(_cacheRoot, hash, safeBranch);
    }

    private static void TouchCacheStamp(string dir)
    {
        try
        {
            var stamp = Path.Combine(dir, ".routemap-cache.stamp");
            File.WriteAllText(stamp, DateTime.UtcNow.ToString("o"));
        }
        catch
        {
            // best effort
        }
    }

    /// <summary>
    /// 启动时异步清理超过 StaleEvictionAge（默认 7 天）未访问的缓存目录。
    /// 实现要点：
    ///   - fire-and-forget，不阻塞应用启动
    ///   - 用 `.routemap-cache.stamp` 文件的最后写入时间作为"最后访问"基准；
    ///     stamp 不存在时退化用目录最后写入时间
    ///   - 容错：单个目录失败不影响其他目录；整体失败仅记录日志
    ///   - 顺带清理已变空的 hash 父目录，保持磁盘整洁
    /// </summary>
    private async Task CleanupStaleAsync()
    {
        await Task.Yield();
        try
        {
            if (!Directory.Exists(_cacheRoot)) return;
            var threshold = DateTime.UtcNow - StaleEvictionAge;
            var removed = 0;
            long bytesFreed = 0;

            foreach (var hashDir in Directory.EnumerateDirectories(_cacheRoot))
            {
                try
                {
                    foreach (var branchDir in Directory.EnumerateDirectories(hashDir))
                    {
                        DateTime lastTouched;
                        var stamp = Path.Combine(branchDir, ".routemap-cache.stamp");
                        try
                        {
                            lastTouched = File.Exists(stamp)
                                ? File.GetLastWriteTimeUtc(stamp)
                                : Directory.GetLastWriteTimeUtc(branchDir);
                        }
                        catch
                        {
                            continue;
                        }
                        if (lastTouched > threshold) continue;

                        var size = TryComputeDirectorySize(branchDir);
                        try
                        {
                            Directory.Delete(branchDir, recursive: true);
                            removed++;
                            bytesFreed += size;
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[GitRepoCache] cleanup failed for {Dir}", branchDir);
                        }
                    }
                    // hashDir 下没分支了就一起清掉
                    if (!Directory.EnumerateFileSystemEntries(hashDir).Any())
                    {
                        try { Directory.Delete(hashDir); } catch { /* best effort */ }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "[GitRepoCache] cleanup iter failed for {Dir}", hashDir);
                }
            }

            if (removed > 0)
            {
                _logger.LogInformation(
                    "[GitRepoCache] startup cleanup removed {Count} stale dirs ({MB:F1} MB freed)",
                    removed, bytesFreed / 1024.0 / 1024.0);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[GitRepoCache] startup cleanup aborted");
        }
    }

    private static long TryComputeDirectorySize(string dir)
    {
        try
        {
            var total = 0L;
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(f).Length; } catch { /* skip */ }
            }
            return total;
        }
        catch { return 0; }
    }

    private static bool IsFresh(string dir)
    {
        var stamp = Path.Combine(dir, ".routemap-cache.stamp");
        if (!File.Exists(stamp)) return false;
        try
        {
            var when = File.GetLastWriteTimeUtc(stamp);
            return DateTime.UtcNow - when < FreshnessWindow;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<(bool ok, string output)> RunGitAsync(
        IReadOnlyList<string> args,
        string cwd,
        int timeoutSeconds,
        CancellationToken ct,
        string? secretToMask = null)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeoutSeconds, 1, 600)));

        var psi = new ProcessStartInfo
        {
            FileName = "git",
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
        psi.Environment["GIT_ASKPASS"] = "echo";

        using var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        p.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

        try
        {
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            await p.WaitForExitAsync(timeoutCts.Token);
            var combined = stderr.Length > 0 ? stderr.ToString() : stdout.ToString();
            if (!string.IsNullOrEmpty(secretToMask))
                combined = combined.Replace(secretToMask, "***", StringComparison.Ordinal);
            return (p.ExitCode == 0, combined);
        }
        catch (OperationCanceledException)
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { }
            return (false, "git 命令超时");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private static string Hash(string url)
    {
        using var sha = SHA1.Create();
        var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(url.Trim()));
        return Convert.ToHexString(bytes)[..16].ToLowerInvariant();
    }

    private static string SanitizeForPath(string value)
    {
        var sb = new StringBuilder();
        foreach (var ch in value)
        {
            sb.Append(char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.' ? ch : '_');
        }
        return sb.Length == 0 ? "main" : sb.ToString();
    }

    private static bool IsInside(string root, string candidate)
    {
        var r = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var c = Path.GetFullPath(candidate);
        return c.StartsWith(r, StringComparison.Ordinal)
               || string.Equals(c.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.Ordinal);
    }

    private static void TryRecursiveDelete(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
            // best effort
        }
    }

    private static bool IsSafeGitUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        var trimmed = url.Trim();
        if (trimmed.Contains(' ')) return false;
        if (trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return true;
        if (trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) return true;
        if (trimmed.StartsWith("git@", StringComparison.OrdinalIgnoreCase)) return true;
        if (trimmed.StartsWith("ssh://", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static bool IsSafeGitRef(string value)
    {
        return value.Length > 0
            && !value.StartsWith("-", StringComparison.Ordinal)
            && !value.Contains("..", StringComparison.Ordinal)
            && value.All(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or '/' or '.');
    }

    private static bool LooksLikeText(string path)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        return ext is ".md" or ".txt" or ".json" or ".yml" or ".yaml" or ".csv" or ".xml"
                   or ".cs" or ".ts" or ".tsx" or ".js" or ".jsx" or ".go" or ".rs" or ".py" or ".rb" or ".php" or ".java" or ".kt"
                   or ".html" or ".htm" or ".css" or ".scss" or ".sass" or ".less" or ".vue" or ".svelte"
                   or ".sh" or ".bat" or ".ps1" or ".toml" or ".ini" or ".cfg" or ".env"
                   or "";
    }

    private static string Truncate(string value, int limit)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return value.Length <= limit ? value : value[..limit] + "...[truncated]";
    }
}

public sealed class RoutemapSnapshot
{
    public string? AbsolutePath { get; set; }
    public string? RelativePath { get; set; }
    public string? Missing { get; set; }

    /// <summary>
    /// 找到的所有 routemap 目录（相对仓库根，按发现顺序）。
    /// monorepo 一仓多个 routemap 时这里会有多条。
    /// </summary>
    public List<string> FoundLocations { get; set; } = new();

    /// <summary>
    /// routemap 文件清单。<see cref="RoutemapEntry.Path"/> 是相对**仓库根**的完整路径，
    /// 例如 "apps/billing/routemap/projects.json"，能跨多个 routemap 目录区分来源。
    /// </summary>
    public List<RoutemapEntry> Entries { get; set; } = new();
}

public sealed class RoutemapEntry
{
    public string Path { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string? ContentPreview { get; set; }
}

public class GitRepoCacheException : Exception
{
    public GitRepoCacheException(string message) : base(message) { }
    public GitRepoCacheException(string message, Exception inner) : base(message, inner) { }
}
