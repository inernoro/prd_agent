using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoCreatePullRequestTool : IAgentTool
{
    private static readonly Regex SafeBranchRegex = new("^[A-Za-z0-9._/-]+$", RegexOptions.Compiled);
    private readonly AgentWorkspace _workspace;

    public RepoCreatePullRequestTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_create_pull_request",
        Description = "Commit current repository changes, push a branch, and create a GitHub pull request. This tool uses server-side GitHub credentials and must only run after the user approves the write operation.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "branch": { "type": "string", "description": "Branch to create or update, for example cx/cds-agent-audit." },
            "title": { "type": "string", "description": "Pull request title." },
            "body": { "type": "string", "description": "Pull request body." },
            "base": { "type": "string", "description": "Base branch. Default main." },
            "commitMessage": { "type": "string", "description": "Commit message. Must be concise and in Chinese for this repository." },
            "draft": { "type": "boolean", "description": "Create as draft PR. Default true." }
          },
          "required": ["branch", "title", "commitMessage"]
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        try
        {
            var branch = ReadString(input, "branch");
            var title = ReadString(input, "title");
            var body = ReadString(input, "body") ?? "";
            var baseBranch = ReadString(input, "base") ?? "main";
            var commitMessage = ReadString(input, "commitMessage");
            var draft = !input.TryGetProperty("draft", out var draftElement) || draftElement.ValueKind != JsonValueKind.False;

            if (string.IsNullOrWhiteSpace(branch)) return AgentToolInvokeResult.Fail("branch_required", "branch is required");
            if (string.IsNullOrWhiteSpace(title)) return AgentToolInvokeResult.Fail("title_required", "title is required");
            if (string.IsNullOrWhiteSpace(commitMessage)) return AgentToolInvokeResult.Fail("commit_message_required", "commitMessage is required");
            if (!IsSafeBranch(branch) || string.Equals(branch, baseBranch, StringComparison.OrdinalIgnoreCase))
            {
                return AgentToolInvokeResult.Fail("branch_invalid", "branch is invalid or points at the base branch");
            }

            var token = ResolveGitHubToken();
            if (string.IsNullOrWhiteSpace(token))
            {
                return AgentToolInvokeResult.Fail("github_token_missing", "GITHUB_PAT, GH_TOKEN or GITHUB_TOKEN is not configured in the runtime");
            }

            var remote = await RunGitAsync("remote", ["get-url", "origin"], token, ct);
            if (remote.ExitCode != 0) return AgentToolInvokeResult.Fail("git_remote_failed", remote.Stderr);
            var repo = ParseGitHubRepo(remote.Stdout.Trim());
            if (repo == null) return AgentToolInvokeResult.Fail("github_remote_invalid", $"cannot parse GitHub remote: {remote.Stdout.Trim()}");

            await EnsureGitIdentityAsync(token, ct);
            var checkout = await RunGitAsync("checkout", ["-B", branch], token, ct);
            if (checkout.ExitCode != 0) return AgentToolInvokeResult.Fail("git_checkout_failed", checkout.Stderr);

            var status = await RunGitAsync("status", ["--porcelain"], token, ct);
            if (status.ExitCode != 0) return AgentToolInvokeResult.Fail("git_status_failed", status.Stderr);
            if (string.IsNullOrWhiteSpace(status.Stdout))
            {
                return AgentToolInvokeResult.Fail("no_changes", "workspace has no changes to commit");
            }

            var add = await RunGitAsync("add", ["-A"], token, ct);
            if (add.ExitCode != 0) return AgentToolInvokeResult.Fail("git_add_failed", add.Stderr);

            var commit = await RunGitAsync("commit", ["-m", commitMessage], token, ct);
            if (commit.ExitCode != 0) return AgentToolInvokeResult.Fail("git_commit_failed", commit.Stderr);

            var pushUrl = $"https://x-access-token:{token}@github.com/{repo.Value.Owner}/{repo.Value.Name}.git";
            var push = await RunGitAsync("push", [pushUrl, $"HEAD:{branch}", "--force-with-lease"], token, ct);
            if (push.ExitCode != 0) return AgentToolInvokeResult.Fail("git_push_failed", push.Stderr);

            var pr = await CreatePullRequestAsync(repo.Value.Owner, repo.Value.Name, token, branch, baseBranch, title, body, draft, ct);
            return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
            {
                repository = $"{repo.Value.Owner}/{repo.Value.Name}",
                branch,
                baseBranch,
                title,
                draft,
                pr.url,
                pr.number,
                commit = ShortCommit(commit.Stdout)
            }));
        }
        catch (Exception ex)
        {
            return AgentToolInvokeResult.Fail("repo_create_pull_request_failed", ex.Message);
        }
    }

    private async Task EnsureGitIdentityAsync(string token, CancellationToken ct)
    {
        var email = await RunGitAsync("config", ["user.email"], token, ct);
        if (email.ExitCode != 0 || string.IsNullOrWhiteSpace(email.Stdout))
        {
            await RunGitAsync("config", ["user.email", "cds-agent@miduo.local"], token, ct);
        }

        var name = await RunGitAsync("config", ["user.name"], token, ct);
        if (name.ExitCode != 0 || string.IsNullOrWhiteSpace(name.Stdout))
        {
            await RunGitAsync("config", ["user.name", "CDS Agent"], token, ct);
        }
    }

    private async Task<(int ExitCode, string Stdout, string Stderr)> RunGitAsync(
        string command,
        IReadOnlyList<string> args,
        string token,
        CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "git",
            WorkingDirectory = _workspace.Root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        psi.ArgumentList.Add(command);
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = psi };
        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct);
        var stdout = Mask(await stdoutTask, token);
        var stderr = Mask(await stderrTask, token);
        return (process.ExitCode, stdout, stderr);
    }

    private static async Task<(string url, int number)> CreatePullRequestAsync(
        string owner,
        string repo,
        string token,
        string head,
        string baseBranch,
        string title,
        string body,
        bool draft,
        CancellationToken ct)
    {
        using var http = new HttpClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, $"https://api.github.com/repos/{owner}/{repo}/pulls");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        req.Headers.UserAgent.Add(new ProductInfoHeaderValue("prd-agent-cds-agent", "1.0"));
        req.Content = new StringContent(JsonSerializer.Serialize(new
        {
            title,
            head,
            @base = baseBranch,
            body,
            draft
        }), Encoding.UTF8, "application/json");

        using var resp = await http.SendAsync(req, ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"GitHub create PR HTTP {(int)resp.StatusCode}: {text[..Math.Min(text.Length, 500)]}");
        }

        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        return (
            root.TryGetProperty("html_url", out var url) ? url.GetString() ?? "" : "",
            root.TryGetProperty("number", out var number) && number.TryGetInt32(out var n) ? n : 0);
    }

    private static string? ReadString(JsonElement input, string name)
    {
        return input.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim()
            : null;
    }

    private static bool IsSafeBranch(string branch)
    {
        return SafeBranchRegex.IsMatch(branch)
            && !branch.Contains("..", StringComparison.Ordinal)
            && !branch.StartsWith("-", StringComparison.Ordinal)
            && !branch.EndsWith("/", StringComparison.Ordinal)
            && !branch.Contains("//", StringComparison.Ordinal);
    }

    private static string? ResolveGitHubToken()
    {
        return Environment.GetEnvironmentVariable("GITHUB_PAT")
            ?? Environment.GetEnvironmentVariable("GH_TOKEN")
            ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");
    }

    private static (string Owner, string Name)? ParseGitHubRepo(string remote)
    {
        var value = remote.Trim();
        if (value.StartsWith("git@github.com:", StringComparison.OrdinalIgnoreCase))
        {
            value = value["git@github.com:".Length..];
        }
        else if (value.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase))
        {
            value = value["https://github.com/".Length..];
        }
        else if (value.StartsWith("http://github.com/", StringComparison.OrdinalIgnoreCase))
        {
            value = value["http://github.com/".Length..];
        }
        else
        {
            return null;
        }

        if (value.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
        {
            value = value[..^4];
        }

        var parts = value.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 2 ? (parts[0], parts[1]) : null;
    }

    private static string Mask(string value, string token)
    {
        return string.IsNullOrWhiteSpace(token) ? value : value.Replace(token, "***", StringComparison.Ordinal);
    }

    private static string ShortCommit(string stdout)
    {
        var match = Regex.Match(stdout, @"\[[^\s]+\s+(?<sha>[0-9a-f]{7,40})\]");
        return match.Success ? match.Groups["sha"].Value : "";
    }
}
