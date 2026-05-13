using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.Services.AgentTools;

public sealed class AgentWorkspace
{
    private static readonly string[] SecretKeyHints =
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "API_KEY",
        "ACCESS_KEY",
        "PRIVATE_KEY"
    ];

    public AgentWorkspace(string root)
    {
        Root = Path.GetFullPath(root);
    }

    public string Root { get; }

    public static AgentWorkspace Resolve(IConfiguration configuration)
    {
        var configured = Environment.GetEnvironmentVariable("AGENT_WORKSPACE_ROOT")
            ?? configuration["AgentWorkspace:Root"]
            ?? "/repo";
        if (!Directory.Exists(configured))
        {
            configured = Directory.GetCurrentDirectory();
        }
        return new AgentWorkspace(configured);
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
