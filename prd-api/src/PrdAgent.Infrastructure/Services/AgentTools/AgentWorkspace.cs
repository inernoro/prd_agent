using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.Services.AgentTools;

public sealed class AgentWorkspace
{
    private static readonly SemaphoreSlim GitRepairLock = new(1, 1);
    private static readonly string[] SecretKeyHints =
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "API_KEY",
        "ACCESS_KEY",
        "PRIVATE_KEY"
    ];

    public AgentWorkspace(string root, string? githubRepository = null, string? gitRef = null)
    {
        Root = Path.GetFullPath(root);
        GitHubRepository = string.IsNullOrWhiteSpace(githubRepository) ? null : githubRepository.Trim();
        GitRef = string.IsNullOrWhiteSpace(gitRef) ? "main" : gitRef.Trim();
    }

    public string Root { get; }
    public string? GitHubRepository { get; }
    public string GitRef { get; }

    public static AgentWorkspace Resolve(IConfiguration configuration)
    {
        var configured = Environment.GetEnvironmentVariable("AGENT_WORKSPACE_ROOT")
            ?? configuration["AgentWorkspace:Root"]
            ?? "/repo";
        if (!Directory.Exists(configured))
        {
            configured = Directory.GetCurrentDirectory();
        }
        var repo = Environment.GetEnvironmentVariable("AGENT_WORKSPACE_GITHUB_REPOSITORY")
            ?? configuration["AgentWorkspace:GitHubRepository"]
            ?? Environment.GetEnvironmentVariable("GITHUB_REPOSITORY")
            ?? "inernoro/prd_agent";
        var gitRef = Environment.GetEnvironmentVariable("AGENT_WORKSPACE_GIT_REF")
            ?? configuration["AgentWorkspace:GitRef"]
            ?? Environment.GetEnvironmentVariable("VITE_GIT_BRANCH")
            ?? "main";
        return new AgentWorkspace(configured, repo, gitRef);
    }

    public string ResolvePath(string? relativePath, bool allowDirectory = false)
    {
        var clean = (relativePath ?? string.Empty).Trim();
        clean = clean.Replace('\\', Path.DirectorySeparatorChar);
        if (string.IsNullOrWhiteSpace(clean) || clean == ".")
        {
            return Root;
        }

        var fullPath = Path.IsPathRooted(clean)
            ? Path.GetFullPath(clean)
            : Path.GetFullPath(Path.Combine(Root, clean));
        if (!IsInsideRoot(fullPath))
        {
            throw new InvalidOperationException($"path outside workspace: {relativePath}");
        }
        if (!allowDirectory && Directory.Exists(fullPath))
        {
            throw new InvalidOperationException($"path is a directory: {relativePath}");
        }
        return fullPath;
    }

    public string NormalizeRelative(string fullPath)
    {
        var relative = Path.GetRelativePath(Root, fullPath);
        return relative == "." ? "." : relative.Replace(Path.DirectorySeparatorChar, '/');
    }

    public bool IsInsideRoot(string fullPath)
    {
        var normalizedRoot = Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var normalizedPath = Path.GetFullPath(fullPath);
        return normalizedPath.StartsWith(normalizedRoot, StringComparison.Ordinal)
            || string.Equals(normalizedPath.TrimEnd(Path.DirectorySeparatorChar), Root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.Ordinal);
    }

    public async Task<CommandResult> RunCommandAsync(
        string command,
        string? cwd,
        int timeoutSeconds,
        CancellationToken ct)
    {
        var trimmed = (command ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return new CommandResult(2, string.Empty, "command is required");
        }

        var denied = FindDeniedCommand(trimmed);
        if (denied != null)
        {
            return new CommandResult(126, string.Empty, $"command denied by workspace policy: {denied}");
        }

        var workingDirectory = ResolvePath(cwd, allowDirectory: true);
        if (!Directory.Exists(workingDirectory))
        {
            return new CommandResult(2, string.Empty, $"cwd not found: {cwd}");
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeoutSeconds, 1, 180)));

        var psi = new ProcessStartInfo
        {
            FileName = "/bin/sh",
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add(trimmed);
        psi.Environment["AGENT_WORKSPACE_ROOT"] = Root;

        foreach (var hint in SecretKeyHints)
        {
            foreach (var key in psi.Environment.Keys.Cast<string>().Where(k => k.Contains(hint, StringComparison.OrdinalIgnoreCase)).ToList())
            {
                psi.Environment.Remove(key);
            }
        }

        using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null) stdout.AppendLine(e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null) stderr.AppendLine(e.Data);
        };

        try
        {
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync(timeoutCts.Token);
            return new CommandResult(process.ExitCode, Truncate(stdout.ToString()), Truncate(stderr.ToString()));
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            return new CommandResult(124, Truncate(stdout.ToString()), "command timed out");
        }
        catch (Exception ex)
        {
            return new CommandResult(1, Truncate(stdout.ToString()), ex.Message);
        }
    }

    public async Task<CommandResult?> EnsureGitRepositoryAsync(CancellationToken ct)
    {
        if (await IsGitUsableAsync(ct))
        {
            return null;
        }

        await GitRepairLock.WaitAsync(ct);
        try
        {
            if (await IsGitUsableAsync(ct))
            {
                return null;
            }

            if (string.IsNullOrWhiteSpace(GitHubRepository))
            {
                return new CommandResult(
                    128,
                    string.Empty,
                    "workspace git metadata is unavailable and AgentWorkspace:GitHubRepository is not configured");
            }

            var repo = GitHubRepository.Trim().Trim('/');
            if (!IsSafeGitHubRepository(repo))
            {
                return new CommandResult(128, string.Empty, $"invalid GitHub repository: {repo}");
            }

            var gitFile = Path.Combine(Root, ".git");
            if (File.Exists(gitFile))
            {
                File.Delete(gitFile);
            }

            var init = await RunProcessAsync("git", ["init"], Root, 30, null, ct);
            if (init.ExitCode != 0) return init;

            await RunProcessAsync("git", ["remote", "remove", "origin"], Root, 10, null, ct);
            var remoteUrl = $"https://github.com/{repo}.git";
            var remote = await RunProcessAsync("git", ["remote", "add", "origin", remoteUrl], Root, 10, null, ct);
            if (remote.ExitCode != 0) return remote;

            var token = ResolveGitHubToken();
            var fetchUrl = string.IsNullOrWhiteSpace(token)
                ? remoteUrl
                : $"https://x-access-token:{token}@github.com/{repo}.git";
            var fetch = await RunProcessAsync("git", ["fetch", "--depth=1", fetchUrl, GitRef], Root, 120, token, ct);
            if (fetch.ExitCode != 0) return fetch;

            var branchName = IsSafeGitRef(GitRef) ? GitRef : "main";
            var updateRef = await RunProcessAsync("git", ["update-ref", $"refs/heads/{branchName}", "FETCH_HEAD"], Root, 30, token, ct);
            if (updateRef.ExitCode != 0) return updateRef;

            var symbolicRef = await RunProcessAsync("git", ["symbolic-ref", "HEAD", $"refs/heads/{branchName}"], Root, 30, token, ct);
            if (symbolicRef.ExitCode != 0) return symbolicRef;

            var reset = await RunProcessAsync("git", ["reset", "--mixed", "HEAD"], Root, 60, token, ct);
            if (reset.ExitCode != 0) return reset;

            return null;
        }
        catch (Exception ex)
        {
            return new CommandResult(128, string.Empty, ex.Message);
        }
        finally
        {
            GitRepairLock.Release();
        }
    }

    private async Task<bool> IsGitUsableAsync(CancellationToken ct)
    {
        var result = await RunProcessAsync("git", ["rev-parse", "--is-inside-work-tree"], Root, 10, null, ct);
        return result.ExitCode == 0 && result.Stdout.Contains("true", StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<CommandResult> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> args,
        string workingDirectory,
        int timeoutSeconds,
        string? secret,
        CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeoutSeconds, 1, 180)));

        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null) stdout.AppendLine(e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null) stderr.AppendLine(e.Data);
        };

        try
        {
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync(timeoutCts.Token);
            return new CommandResult(
                process.ExitCode,
                Mask(Truncate(stdout.ToString()), secret),
                Mask(Truncate(stderr.ToString()), secret));
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            return new CommandResult(124, Mask(Truncate(stdout.ToString()), secret), "command timed out");
        }
        catch (Exception ex)
        {
            return new CommandResult(1, Mask(Truncate(stdout.ToString()), secret), ex.Message);
        }
    }

    private static string? ResolveGitHubToken()
    {
        return Environment.GetEnvironmentVariable("GITHUB_PAT")
            ?? Environment.GetEnvironmentVariable("GH_TOKEN")
            ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");
    }

    private static bool IsSafeGitHubRepository(string repo)
    {
        var parts = repo.Split('/');
        return parts.Length == 2
            && parts.All(p => p.Length > 0 && p.All(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.'));
    }

    private static bool IsSafeGitRef(string value)
    {
        return value.Length > 0
            && !value.StartsWith("-", StringComparison.Ordinal)
            && !value.Contains("..", StringComparison.Ordinal)
            && value.All(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or '/' or '.');
    }

    private static string Mask(string text, string? secret)
    {
        return string.IsNullOrWhiteSpace(secret)
            ? text
            : text.Replace(secret, "***", StringComparison.Ordinal);
    }

    private static string? FindDeniedCommand(string command)
    {
        var denied = new[]
        {
            "rm -rf /",
            "sudo ",
            "mkfs",
            "dd if=",
            "chmod -R 777",
            ":(){",
            "shutdown",
            "reboot"
        };
        return denied.FirstOrDefault(x => command.Contains(x, StringComparison.OrdinalIgnoreCase));
    }

    private static string Truncate(string value)
    {
        const int limit = 20000;
        if (value.Length <= limit) return value;
        return value[..limit] + "\n[truncated]";
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // best effort
        }
    }
}

public sealed record CommandResult(int ExitCode, string Stdout, string Stderr);
