using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services.AgentRuntime;

/// <summary>
/// Lite 只读代码审查 runtime 适配器（优雅降级路径）。
///
/// 当默认 runtime profile 不是 Claude/Anthropic 兼容（门禁 R1 未闭合）、官方 SDK sidecar
/// 跑不起来时，会话不再硬卡报错，而是路由到本适配器：直接读取 CDS 已准备好的工作区代码，
/// 经现有 <see cref="ILlmGateway"/>（OpenRouter 等 openai-compatible 池，已有 key）做**只读**审查，
/// 流式产出结论。明确标注「Lite 预览、非商业级、只读、无危险工具、无审批」。
///
/// 与官方 SDK 路径的边界见 doc/design.cds.agent.official-sdk-adapter.md：
/// lite 是显式标注的 fallback，不冒充官方 SDK loop。
/// </summary>
public sealed class GatewayReviewRuntimeAdapter : IInfraAgentRuntimeAdapter
{
    public const string SourceName = "gateway-review-lite";

    // 文件读取边界：只读、有界，防止把整个仓库塞进 prompt。
    private const int MaxFiles = 40;
    private const int MaxBytesPerFile = 24 * 1024;
    private const int MaxTotalBytes = 180 * 1024;

    private static readonly HashSet<string> CodeExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
        ".kt", ".rb", ".php", ".swift", ".scala", ".md", ".json", ".yml", ".yaml", ".toml",
        ".css", ".scss", ".html", ".cshtml", ".razor", ".vue", ".svelte", ".sh", ".sql", ".txt",
        ".gradle", ".xml", ".proto", ".tf"
    };

    private static readonly HashSet<string> SkipDirectories = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "node_modules", "bin", "obj", "dist", "build", ".next", "out", "target",
        "vendor", ".venv", "venv", "__pycache__", ".idea", ".vs", "coverage", ".turbo", ".cache"
    };

    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<GatewayReviewRuntimeAdapter> _logger;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _runs = new();

    public GatewayReviewRuntimeAdapter(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<GatewayReviewRuntimeAdapter> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    public string RuntimeKey => "review-lite";

    public string AdapterKind => SourceName;

    // Gateway 永远可用（系统至少有一个 chat 池），lite 路径不依赖外部 sidecar 容量。
    public bool IsConfigured => true;

    public int InstanceCount => 1;

    public int HealthyCount => 1;

    public IReadOnlyList<string> Blockers => Array.Empty<string>();

    public IReadOnlyList<string> NextActions => Array.Empty<string>();

    public async IAsyncEnumerable<InfraAgentRuntimeEvent> RunStreamAsync(
        InfraAgentRuntimeRunRequest request,
        [EnumeratorCancellation] CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (!string.IsNullOrWhiteSpace(request.RunId))
        {
            _runs[request.RunId] = cts;
        }

        try
        {
            yield return new InfraAgentRuntimeEvent
            {
                Type = InfraAgentRuntimeEventType.RuntimeInit,
                Source = SourceName,
                Message = "Lite 只读审查模式：读取工作区代码经 LLM Gateway 产出审查结论（非商业级、无危险工具、无审批）。",
                RuntimeInstanceName = SourceName
            };

            var (digest, fileCount) = BuildWorkspaceDigest(request.WorkspaceRoot, out var workspaceNote);
            var hasWorkspace = fileCount > 0;
            yield return new InfraAgentRuntimeEvent
            {
                Type = InfraAgentRuntimeEventType.TextDelta,
                Source = SourceName,
                Text = hasWorkspace
                    ? $"[Lite 预览] 已读取工作区 {fileCount} 个文件{workspaceNote}，开始只读审查。\n\n"
                    : "[Lite 预览] 对话模式（未绑定仓库），直接回答。\n\n"
            };

            var userPrompt = request.Messages.LastOrDefault(m =>
                string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase))?.Content
                ?? request.Messages.LastOrDefault()?.Content
                ?? string.Empty;

            var messages = new List<LLMMessage>
            {
                new()
                {
                    Role = "user",
                    Content = BuildUserMessage(userPrompt, request.GitRepository, request.GitRef, digest, hasWorkspace)
                }
            };

            // 必须设置 LlmRequestContext，否则 LLM 访问控制层拿不到 UserId 会拒绝（见 .claude/rules/llm-gateway.md）。
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: string.IsNullOrWhiteSpace(request.RunId) ? Guid.NewGuid().ToString("N") : request.RunId,
                GroupId: null,
                SessionId: request.MapSessionId,
                UserId: request.UserId,
                ViewRole: null,
                DocumentChars: digest.Length,
                DocumentHash: null,
                SystemPromptRedacted: null,
                RequestType: "chat",
                AppCallerCode: AppCallerRegistry.InfraAgent.ReviewLite.Chat));

            var client = _gateway.CreateClient(
                AppCallerRegistry.InfraAgent.ReviewLite.Chat,
                ModelTypes.Chat,
                maxTokens: Math.Clamp(request.MaxTokens <= 0 ? 4096 : request.MaxTokens, 1024, 8192),
                temperature: 0.2);

            long totalOutput = 0;
            await foreach (var chunk in client.StreamGenerateAsync(BuildSystemPrompt(hasWorkspace), messages, cts.Token))
            {
                switch (chunk.Type)
                {
                    case "delta":
                        if (!string.IsNullOrEmpty(chunk.Content))
                        {
                            yield return new InfraAgentRuntimeEvent
                            {
                                Type = InfraAgentRuntimeEventType.TextDelta,
                                Source = SourceName,
                                Text = chunk.Content
                            };
                        }
                        break;
                    case "done":
                        totalOutput = chunk.OutputTokens ?? totalOutput;
                        yield return new InfraAgentRuntimeEvent
                        {
                            Type = InfraAgentRuntimeEventType.Usage,
                            Source = SourceName,
                            InputTokens = chunk.InputTokens,
                            OutputTokens = chunk.OutputTokens
                        };
                        break;
                    case "error":
                        yield return new InfraAgentRuntimeEvent
                        {
                            Type = InfraAgentRuntimeEventType.Error,
                            Source = SourceName,
                            ErrorCode = "lite_review_llm_error",
                            Message = chunk.ErrorMessage ?? "Lite 审查调用 LLM Gateway 失败"
                        };
                        yield break;
                }
            }

            yield return new InfraAgentRuntimeEvent
            {
                Type = InfraAgentRuntimeEventType.Done,
                Source = SourceName,
                OutputTokens = totalOutput > 0 ? totalOutput : null
            };
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(request.RunId))
            {
                _runs.TryRemove(request.RunId, out _);
            }
        }
    }

    public Task<InfraAgentRuntimeCancelResult> CancelAsync(string runId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(runId) && _runs.TryGetValue(runId, out var cts))
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* 已结束 */ }
            return Task.FromResult(new InfraAgentRuntimeCancelResult(true, "lite-review-cancelled", SourceName));
        }

        return Task.FromResult(new InfraAgentRuntimeCancelResult(false, "run-not-found", SourceName));
    }

    private static string BuildSystemPrompt(bool hasWorkspace) =>
        hasWorkspace
            ? "你是一名严谨的只读代码审查员，运行在 CDS Agent 的 Lite 预览模式下。\n" +
              "约束：\n" +
              "1. 只读分析，不修改任何文件、不执行任何命令；\n" +
              "2. 基于提供的工作区文件片段作答，证据不足时明确说明还需要看哪些文件；\n" +
              "3. 按风险输出：每条给出 文件路径、触发条件、影响、最小验证方式；\n" +
              "4. 用中文，结论先行、可执行。\n" +
              "说明：Lite 模式不是商业级官方 SDK 审查，结果用于快速预览。"
            : "你是 CDS Agent 的助手，运行在 Lite 预览模式下（未绑定代码仓库）。\n" +
              "约束：\n" +
              "1. 直接、简洁地用中文回答用户问题；\n" +
              "2. 当前没有可访问的工作区/代码，只能基于对话作答；若用户的问题需要读代码，请说明请切换到「Code 巡检」并指定仓库；\n" +
              "3. 不杜撰不存在的能力。\n" +
              "说明：Lite 是快速预览模式，不是商业级官方 SDK。";

    private static string BuildUserMessage(string userPrompt, string? repo, string? gitRef, string digest, bool hasWorkspace)
    {
        var prompt = string.IsNullOrWhiteSpace(userPrompt) ? "请简要说明你现在能做什么。" : userPrompt.Trim();
        if (!hasWorkspace)
        {
            // 对话模式：直接把用户问题发给模型，不附带空的代码片段段落。
            return prompt;
        }

        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(repo))
        {
            sb.Append("仓库：").Append(repo);
            if (!string.IsNullOrWhiteSpace(gitRef)) sb.Append(" @ ").Append(gitRef);
            sb.Append('\n');
        }
        sb.Append("审查请求：\n")
          .Append(prompt)
          .Append("\n\n=== 工作区代码片段（只读） ===\n")
          .Append(digest);
        return sb.ToString();
    }

    private (string Digest, int FileCount) BuildWorkspaceDigest(string? workspaceRoot, out string note)
    {
        note = string.Empty;
        if (string.IsNullOrWhiteSpace(workspaceRoot) || !Directory.Exists(workspaceRoot))
        {
            note = "（工作区不可用）";
            return (string.Empty, 0);
        }

        var sb = new StringBuilder();
        var fileCount = 0;
        var totalBytes = 0;

        IEnumerable<string> candidates;
        try
        {
            candidates = EnumerateFiles(workspaceRoot);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Lite review enumerate workspace failed root={Root}", workspaceRoot);
            note = "（工作区枚举失败）";
            return (string.Empty, 0);
        }

        foreach (var path in candidates)
        {
            if (fileCount >= MaxFiles || totalBytes >= MaxTotalBytes)
            {
                note = "（已达读取上限，部分文件未纳入）";
                break;
            }

            string content;
            try
            {
                var info = new FileInfo(path);
                if (info.Length == 0) continue;
                var take = (int)Math.Min(info.Length, MaxBytesPerFile);
                using var reader = new StreamReader(path);
                var buffer = new char[take];
                var read = reader.Read(buffer, 0, take);
                content = new string(buffer, 0, read);
            }
            catch
            {
                continue;
            }

            var rel = Path.GetRelativePath(workspaceRoot, path).Replace('\\', '/');
            sb.Append("----- ").Append(rel).Append(" -----\n").Append(content);
            if (!content.EndsWith('\n')) sb.Append('\n');
            sb.Append('\n');
            fileCount++;
            totalBytes += content.Length;
        }

        return (sb.ToString(), fileCount);
    }

    private static IEnumerable<string> EnumerateFiles(string root)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        var results = new List<string>();

        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            string[] subDirs;
            string[] files;
            try
            {
                subDirs = Directory.GetDirectories(dir);
                files = Directory.GetFiles(dir);
            }
            catch
            {
                continue;
            }

            foreach (var sub in subDirs)
            {
                var name = Path.GetFileName(sub);
                if (SkipDirectories.Contains(name)) continue;
                stack.Push(sub);
            }

            foreach (var file in files)
            {
                if (CodeExtensions.Contains(Path.GetExtension(file)))
                {
                    results.Add(file);
                }
            }
        }

        // 确定性顺序：浅层目录优先 + 字典序，便于复现与测试断言。
        results.Sort((a, b) =>
        {
            var da = a.Count(c => c == Path.DirectorySeparatorChar);
            var db = b.Count(c => c == Path.DirectorySeparatorChar);
            return da != db ? da.CompareTo(db) : string.CompareOrdinal(a, b);
        });
        return results;
    }
}
