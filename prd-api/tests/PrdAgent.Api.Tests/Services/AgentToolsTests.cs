using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
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
    public void InfraAgentToolPoliciesExposeCodeWriteOnlyForExplicitWritableProfile()
    {
        InfraAgentToolPolicies.ShouldExposeToolToRuntime("readonly-auto", "repo_read_file").ShouldBeTrue();
        InfraAgentToolPolicies.ShouldExposeToolToRuntime("readonly-auto", "repo_write_file").ShouldBeFalse();
        InfraAgentToolPolicies.ShouldExposeToolToRuntime("confirm-dangerous", "kb_apply").ShouldBeTrue();
        InfraAgentToolPolicies.ShouldExposeToolToRuntime("confirm-dangerous", "repo_write_file").ShouldBeFalse();
        InfraAgentToolPolicies.ShouldExposeToolToRuntime("code-writable-confirm", "repo_write_file").ShouldBeTrue();
        InfraAgentToolPolicies.ShouldExposeToolToRuntime("code-writable-confirm", "repo_run_command").ShouldBeTrue();
        InfraAgentToolPolicies.ShouldExposeToolToRuntime("code-writable-confirm", "repo_create_pull_request").ShouldBeTrue();
    }

    [Fact]
    public void InfraAgentToolPoliciesDenyCodeWriteInvocationWithoutWritableProfile()
    {
        InfraAgentToolPolicies.AllowsToolInvocation("readonly-auto", "repo_write_file").ShouldBeFalse();
        InfraAgentToolPolicies.AllowsToolInvocation("confirm-dangerous", "repo_run_command").ShouldBeFalse();
        InfraAgentToolPolicies.AllowsToolInvocation("code-writable-confirm", "repo_run_command").ShouldBeTrue();
        InfraAgentToolPolicies.AllowsToolInvocation("code-writable-confirm", "kb_apply").ShouldBeFalse();
        InfraAgentToolPolicies.AllowsToolInvocation("deny-all", "repo_read_file").ShouldBeFalse();
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

    [Fact]
    public async Task CdsBridgeToolsRequireSessionConnectionAndValidateActions()
    {
        var snapshot = await new CdsBridgeSnapshotTool().InvokeAsync(
            JsonDocument.Parse("""{"branchId":"prd-agent-main"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        snapshot.Success.ShouldBeFalse();
        snapshot.ErrorCode.ShouldBe("cds_connection_missing");

        var action = await new CdsBridgeActionTool().InvokeAsync(
            JsonDocument.Parse("""{"branchId":"prd-agent-main","action":"unknown","description":"测试非法动作"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        action.Success.ShouldBeFalse();
        action.ErrorCode.ShouldBe("bridge_action_not_allowed");

        var privateNavigate = await new CdsBridgeActionTool().InvokeAsync(
            JsonDocument.Parse("""{"branchId":"prd-agent-main","action":"navigate","description":"测试内网拦截","params":{"url":"http://127.0.0.1:5000"}}""").RootElement,
            new AgentToolInvocationContext
            {
                CdsBaseUrl = "https://cds.miduo.org",
                CdsLongToken = "test-token"
            },
            CancellationToken.None);
        privateNavigate.Success.ShouldBeFalse();
        privateNavigate.ErrorCode.ShouldBe("bridge_url_blocked");

        var relativeNavigate = await new CdsBridgeActionTool().InvokeAsync(
            JsonDocument.Parse("""{"branchId":"prd-agent-main","action":"spa-navigate","description":"测试相对路径","params":{"url":"/settings"}}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        relativeNavigate.Success.ShouldBeFalse();
        relativeNavigate.ErrorCode.ShouldBe("cds_connection_missing");
    }

    [Fact]
    public async Task RepoCreatePullRequestRequiresGitHubToken()
    {
        await new RepoRunCommandTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""{"command":"git init && git remote add origin https://github.com/inernoro/prd_agent.git && git config user.email test@example.com && git config user.name Tester","timeoutSeconds":10}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(_root, "audit.txt"), "change\n");

        var result = await new RepoCreatePullRequestTool(_workspace).InvokeAsync(
            JsonDocument.Parse("""
            {
              "branch": "cx/test-agent-pr",
              "title": "测试 PR",
              "commitMessage": "test: 测试远程 PR 工具"
            }
            """).RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);

        result.Success.ShouldBeFalse();
        result.ErrorCode.ShouldBe("github_token_missing");
    }

    [Fact]
    public void KnowledgeBaseReadonlyToolsExposeOnlyListSearchRead()
    {
        var tools = new IAgentTool[]
        {
            new KbListTool(null!),
            new KbSearchTool(null!),
            new KbReadTool(null!)
        };

        tools.Select(x => x.Descriptor.Name).ShouldBe(new[] { "kb_list", "kb_search", "kb_read" });
        foreach (var tool in tools)
        {
            tool.Descriptor.Description.ShouldContain("只读");
            using var schema = JsonDocument.Parse(tool.Descriptor.InputSchemaJson);
            schema.RootElement.GetProperty("type").GetString().ShouldBe("object");
        }
    }

    [Fact]
    public void KnowledgeBaseSnippetKeepsCitationSearchContext()
    {
        var entry = new PrdAgent.Core.Models.DocumentEntry
        {
            Title = "Agent Roadmap",
            Summary = "fallback",
            ContentIndex = "前置内容，商业级可观察性和 timeout 机制需要在 Agent 面板里稳定展示，后续还有知识库检索。"
        };

        var snippet = KnowledgeBaseReadonlyToolSupport.BuildSnippet(entry, "timeout");

        snippet.ShouldContain("timeout");
        snippet.Length.ShouldBeLessThanOrEqualTo(263);
    }

    [Fact]
    public void KnowledgeBaseDraftToolsExposeOnlyDraftWorkspaceActions()
    {
        var tools = new IAgentTool[]
        {
            new KbDraftCreateTool(null!),
            new KbDraftReadTool(null!),
            new KbDraftListTool(null!),
            new KbDraftDiscardTool(null!)
        };

        tools.Select(x => x.Descriptor.Name).ShouldBe(new[]
        {
            "kb_draft_create",
            "kb_draft_read",
            "kb_draft_list",
            "kb_draft_discard"
        });
        tools.Select(x => x.Descriptor.Name).ShouldNotContain("kb_apply");
        tools.Select(x => x.Descriptor.Name).ShouldNotContain("kb_diff");
        tools.Select(x => x.Descriptor.Name).ShouldNotContain("kb_reject");

        foreach (var tool in tools)
        {
            using var schema = JsonDocument.Parse(tool.Descriptor.InputSchemaJson);
            schema.RootElement.GetProperty("type").GetString().ShouldBe("object");
        }
    }

    [Fact]
    public void KnowledgeBaseDraftHashIsStableAndSensitiveToContent()
    {
        var hashA = KnowledgeBaseDraftToolSupport.ComputeContentHash("原始正文\n第二行");
        var hashB = KnowledgeBaseDraftToolSupport.ComputeContentHash("原始正文\n第二行");
        var hashC = KnowledgeBaseDraftToolSupport.ComputeContentHash("改写正文\n第二行");

        hashA.ShouldBe(hashB);
        hashA.ShouldNotBe(hashC);
        hashA.Length.ShouldBe(64);
    }

    [Fact]
    public void KnowledgeBaseDiffApplyRejectToolsExposeP2ThreeActions()
    {
        var tools = new IAgentTool[]
        {
            new KbDiffTool(null!),
            new KbApplyTool(null!),
            new KbRejectTool(null!)
        };

        tools.Select(x => x.Descriptor.Name).ShouldBe(new[]
        {
            "kb_diff",
            "kb_apply",
            "kb_reject"
        });
        new KbApplyTool(null!).Descriptor.Description.ShouldContain("MAP approval");
    }

    [Fact]
    public void KnowledgeBaseDiffSummarizesAddedAndRemovedLines()
    {
        var diff = KnowledgeBaseDraftToolSupport.BuildUnifiedDiff(
            "标题\n旧内容\n保留",
            "标题\n新内容\n保留\n新增",
            "before",
            "after",
            100);

        var statJson = JsonSerializer.Serialize(diff.diffStat);
        statJson.ShouldContain("\"added\":2");
        statJson.ShouldContain("\"removed\":1");
        diff.unifiedDiff.ShouldContain("--- before");
        diff.unifiedDiff.ShouldContain("+++ after");
        diff.unifiedDiff.ShouldContain("-旧内容");
        diff.unifiedDiff.ShouldContain("+新内容");
        diff.truncated.ShouldBeFalse();
    }

    [Fact]
    public async Task KnowledgeBaseApplyRequiresMapApprovalBeforeDatabaseAccess()
    {
        var result = await new KbApplyTool(null!).InvokeAsync(
            JsonDocument.Parse("""{"draftId":"draft-1"}""").RootElement,
            new AgentToolInvocationContext(),
            CancellationToken.None);

        result.Success.ShouldBeFalse();
        result.ErrorCode.ShouldBe("kb_apply_approval_required");
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
