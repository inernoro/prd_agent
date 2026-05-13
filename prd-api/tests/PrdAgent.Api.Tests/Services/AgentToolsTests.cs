using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.AgentTools;
using PrdAgent.Infrastructure.Services.AgentTools.Tools;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class AgentToolsTests : IDisposable
{
    private readonly string _root;
    private readonly AgentWorkspace _workspace;

    public AgentToolsTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "prd-agent-tool-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
        _workspace = new AgentWorkspace(_root);
    }

    [Fact]
    public async Task RepoReadAndSearchUseWorkspaceRoot()
    {
        Directory.CreateDirectory(Path.Combine(_root, "doc"));
        await File.WriteAllTextAsync(Path.Combine(_root, "doc", "sample.md"), "hello agent\nsecond line\n");

        var read = await new RepoReadFileTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"path":"doc/sample.md"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        read.Success.ShouldBeTrue();
        read.Content.ShouldNotBeNull();
        read.Content.ShouldContain("hello agent");

        var search = await new RepoSearchTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"query":"hello","path":"doc","maxLines":5}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        search.Success.ShouldBeTrue();
        search.Content.ShouldNotBeNull();
        search.Content.ShouldContain("doc/sample.md:1:hello agent");
    }

    [Fact]
    public async Task RepoWriteAndCommandCanCreateAuditableChange()
    {
        var write = await new RepoWriteFileTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"path":"notes/result.txt","content":"created by agent\n"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        write.Success.ShouldBeTrue();
        File.Exists(Path.Combine(_root, "notes", "result.txt")).ShouldBeTrue();

        var command = await new RepoRunCommandTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"command":"wc -l notes/result.txt","timeoutSeconds":10}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        command.Success.ShouldBeTrue();
        command.Content.ShouldNotBeNull();
        command.Content.ShouldContain("notes/result.txt");
    }

    [Fact]
    public async Task RepoGitStatusAndDiffExposeReadonlyAuditContext()
    {
        await new RepoRunCommandTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"command":"git init && git config user.email test@example.com && git config user.name Tester","timeoutSeconds":10}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(_root, "tracked.txt"), "before\n");
        await new RepoRunCommandTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"command":"git add tracked.txt && git commit -m initial","timeoutSeconds":10}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(_root, "tracked.txt"), "before\nafter\n");

        var status = await new RepoGitStatusTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        status.Success.ShouldBeTrue();
        status.Content.ShouldNotBeNull();
        status.Content.ShouldContain("tracked.txt");

        var diff = await new RepoGitDiffTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"path":"tracked.txt","maxBytes":20000}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        diff.Success.ShouldBeTrue();
        diff.Content.ShouldNotBeNull();
        using var doc = JsonDocument.Parse(diff.Content);
        var diffText = doc.RootElement.GetProperty("diff").GetString();
        diffText.ShouldNotBeNull();
        diffText.ShouldContain("+after");
    }

    [Fact]
    public async Task WorkspaceRejectsPathEscapeAndDeniedCommands()
    {
        var read = await new RepoReadFileTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"path":"../outside.txt"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        read.Success.ShouldBeFalse();
        read.ErrorCode.ShouldBe("repo_read_file_failed");

        var command = await new RepoRunCommandTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"command":"sudo whoami"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        command.Success.ShouldBeFalse();
        command.Message.ShouldNotBeNull();
        command.Message.ShouldContain("command denied");

        var diff = await new RepoGitDiffTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"path":"../outside.txt"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        diff.Success.ShouldBeFalse();
        diff.ErrorCode.ShouldBe("repo_git_diff_failed");
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
