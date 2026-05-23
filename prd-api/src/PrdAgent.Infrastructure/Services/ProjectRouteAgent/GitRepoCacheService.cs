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
    /// </summary>
    public async Task<string> EnsureClonedAsync(string repoUrl, string branch, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(repoUrl))
            throw new GitRepoCacheException("仓库 URL 不能为空");
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

        try
        {
            if (Directory.Exists(Path.Combine(dir, ".git")))
            {
                var (fok, fout) = await RunGitAsync(new[] { "fetch", "--depth=1", "origin", branch }, dir, 120, ct);
                if (fok)
                {
                    var (rok, rout) = await RunGitAsync(new[] { "reset", "--hard", "FETCH_HEAD" }, dir, 30, ct);
                    if (rok)
                    {
                        TouchCacheStamp(dir);
                        return dir;
                    }
                    _logger.LogWarning("[GitRepoCache] reset failed, will reclone: {Out}", rout);
                }
                else
                {
                    _logger.LogWarning("[GitRepoCache] fetch failed, will reclone: {Out}", fout);
                }
            }

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
                repoUrl,
                dir,
            }, cwd: _cacheRoot, timeoutSeconds: 180, ct: ct);

            if (!cok)
            {
                throw new GitRepoCacheException($"git clone 失败：{Truncate(cout, 600)}");
            }
            TouchCacheStamp(dir);
            return dir;
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

    private static async Task<(bool ok, string output)> RunGitAsync(IReadOnlyList<string> args, string cwd, int timeoutSeconds, CancellationToken ct)
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
