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
    private const int MaxFileBytes = 256 * 1024;
    private const int MaxTotalBytes = 2 * 1024 * 1024;
    private const int MaxFileCount = 300;

    private readonly ILogger<GitRepoCacheService> _logger;
    private readonly string _cacheRoot;

    public GitRepoCacheService(IConfiguration configuration, ILogger<GitRepoCacheService> logger)
    {
        _logger = logger;
        _cacheRoot = Environment.GetEnvironmentVariable("PROJECT_ROUTE_AGENT_CACHE_ROOT")
            ?? configuration["ProjectRouteAgent:CacheRoot"]
            ?? Path.Combine(Path.GetTempPath(), "project-route-agent-cache");
        Directory.CreateDirectory(_cacheRoot);
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
        var fresh = Directory.Exists(Path.Combine(dir, ".git"))
                    && IsFresh(dir);

        if (fresh)
        {
            _logger.LogDebug("[GitRepoCache] reuse fresh cache for {Repo}@{Branch}: {Dir}", repoUrl, branch, dir);
            return dir;
        }

        // 注入 OAuth token 到 URL（仅 https）。token 不出现在日志 / 缓存路径里。
        var cloneUrl = InjectTokenIntoUrl(repoUrl, accessToken);
        var hasToken = !ReferenceEquals(cloneUrl, repoUrl);

        var errorTrail = new List<string>();

        try
        {
            // 策略 B：已有 .git 但过期 → 优先用 fetch + reset。
            // 若有 token，覆盖 origin URL 一次（旧 URL 可能不带 token / 用了旧 token）。
            if (Directory.Exists(Path.Combine(dir, ".git")))
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
    /// 列出 routemap 目录下的所有文件（相对路径 + 截断后的内容片段）。
    /// 不存在时返回空清单 + 在 missing 标记里写出原因。
    /// </summary>
    public RoutemapSnapshot ReadRoutemap(string repoRoot, string routemapRelative)
    {
        var snapshot = new RoutemapSnapshot();
        var rel = string.IsNullOrWhiteSpace(routemapRelative) ? "routemap" : routemapRelative.Trim().TrimStart('/').Replace('\\', '/');
        var target = Path.GetFullPath(Path.Combine(repoRoot, rel));
        if (!IsInside(repoRoot, target))
        {
            snapshot.Missing = $"routemap 路径 {rel} 不在仓库内";
            return snapshot;
        }
        if (!Directory.Exists(target))
        {
            snapshot.Missing = $"仓库内未找到 {rel} 目录";
            return snapshot;
        }

        snapshot.AbsolutePath = target;
        snapshot.RelativePath = rel.Replace('\\', '/');

        var total = 0;
        foreach (var path in Directory.EnumerateFiles(target, "*", SearchOption.AllDirectories)
                                       .OrderBy(p => p, StringComparer.Ordinal))
        {
            if (snapshot.Entries.Count >= MaxFileCount) break;
            if (total >= MaxTotalBytes) break;

            var relativePath = Path.GetRelativePath(target, path).Replace(Path.DirectorySeparatorChar, '/');
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

        return snapshot;
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
