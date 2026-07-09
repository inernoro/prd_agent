using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AgentRuntime;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// Lite 只读审查适配器测试：断言它读取工作区文件、经 LLM Gateway 流式产出，
/// 并正确设置 LlmRequestContext（UserId + AppCallerCode）。
/// </summary>
public class GatewayReviewRuntimeAdapterTests
{
    [Fact]
    public async Task RunStream_ReadsWorkspace_AndStreamsReviewThroughGateway()
    {
        var workspace = Directory.CreateTempSubdirectory("lite-review-test-").FullName;
        try
        {
            // 工作区放一个带标记的代码文件 + 一个应被跳过的 node_modules 文件。
            await File.WriteAllTextAsync(Path.Combine(workspace, "Program.cs"),
                "public class Marker { /* MARKER_TOKEN_42 */ }");
            var skipped = Directory.CreateDirectory(Path.Combine(workspace, "node_modules"));
            await File.WriteAllTextAsync(Path.Combine(skipped.FullName, "lib.js"), "SHOULD_NOT_BE_READ");

            var client = new FakeLlmClient(new[]
            {
                new LLMStreamChunk { Type = "delta", Content = "审查结论：" },
                new LLMStreamChunk { Type = "delta", Content = "REVIEW_RESULT_OK" },
                new LLMStreamChunk { Type = "done", InputTokens = 100, OutputTokens = 20 }
            });
            var gateway = new FakeLlmGateway(client);
            var accessor = new FakeContextAccessor();

            var adapter = new GatewayReviewRuntimeAdapter(
                gateway, accessor, NullLogger<GatewayReviewRuntimeAdapter>.Instance);

            var request = new InfraAgentRuntimeRunRequest
            {
                RunId = "run-1",
                UserId = "user-42",
                MapSessionId = "session-7",
                WorkspaceRoot = workspace,
                GitRepository = "owner/repo",
                GitRef = "main",
                Messages = new List<InfraAgentRuntimeMessage>
                {
                    new() { Role = "user", Content = "审查稳定性风险" }
                }
            };

            var events = new List<InfraAgentRuntimeEvent>();
            await foreach (var ev in adapter.RunStreamAsync(request, CancellationToken.None))
            {
                events.Add(ev);
            }

            // 第一个事件是 RuntimeInit，明确标注 Lite。
            Assert.Equal(InfraAgentRuntimeEventType.RuntimeInit, events[0].Type);

            // 流出真实文本，包含 LLM 返回的标记。
            var combined = string.Concat(events
                .Where(e => e.Type == InfraAgentRuntimeEventType.TextDelta)
                .Select(e => e.Text));
            Assert.Contains("REVIEW_RESULT_OK", combined);

            // 收尾有 Done。
            Assert.Contains(events, e => e.Type == InfraAgentRuntimeEventType.Done);

            // 工作区文件内容进了发给 LLM 的消息，且 node_modules 被跳过。
            var sentToLlm = client.LastMessages.Single().Content;
            Assert.Contains("MARKER_TOKEN_42", sentToLlm);
            Assert.Contains("Program.cs", sentToLlm);
            Assert.DoesNotContain("SHOULD_NOT_BE_READ", sentToLlm);

            // LlmRequestContext 正确设置（否则访问控制层会拒绝）。
            Assert.NotNull(accessor.LastContext);
            Assert.Equal("user-42", accessor.LastContext!.UserId);
            Assert.Equal(AppCallerRegistry.InfraAgent.ReviewLite.Chat, accessor.LastContext.AppCallerCode);
            Assert.Equal(AppCallerRegistry.InfraAgent.ReviewLite.Chat, gateway.LastAppCallerCode);
            Assert.Equal(ModelTypes.Chat, gateway.LastModelType);
        }
        finally
        {
            try { Directory.Delete(workspace, recursive: true); } catch { /* ignore */ }
        }
    }

    [Fact]
    public async Task RunStream_GatewayError_EmitsErrorEvent()
    {
        var workspace = Directory.CreateTempSubdirectory("lite-review-err-").FullName;
        try
        {
            await File.WriteAllTextAsync(Path.Combine(workspace, "a.cs"), "class A {}");
            var client = new FakeLlmClient(new[]
            {
                new LLMStreamChunk { Type = "error", ErrorMessage = "upstream 503" }
            });
            var adapter = new GatewayReviewRuntimeAdapter(
                new FakeLlmGateway(client), new FakeContextAccessor(),
                NullLogger<GatewayReviewRuntimeAdapter>.Instance);

            var events = new List<InfraAgentRuntimeEvent>();
            await foreach (var ev in adapter.RunStreamAsync(
                new InfraAgentRuntimeRunRequest { RunId = "r", UserId = "u", WorkspaceRoot = workspace },
                CancellationToken.None))
            {
                events.Add(ev);
            }

            var error = Assert.Single(events, e => e.Type == InfraAgentRuntimeEventType.Error);
            Assert.Equal("lite_review_llm_error", error.ErrorCode);
            Assert.DoesNotContain(events, e => e.Type == InfraAgentRuntimeEventType.Done);
        }
        finally
        {
            try { Directory.Delete(workspace, recursive: true); } catch { /* ignore */ }
        }
    }

    private sealed class FakeLlmGateway : ILlmGateway
    {
        private readonly FakeLlmClient _client;
        public string? LastAppCallerCode { get; private set; }
        public string? LastModelType { get; private set; }

        public FakeLlmGateway(FakeLlmClient client) => _client = client;

        public ILLMClient CreateClient(
            string appCallerCode,
            string modelType,
            int maxTokens = 4096,
            double temperature = 0.2,
            bool includeThinking = false,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null)
        {
            LastAppCallerCode = appCallerCode;
            LastModelType = modelType;
            return _client;
        }
    }

    private sealed class FakeLlmClient : ILLMClient
    {
        private readonly IReadOnlyList<LLMStreamChunk> _chunks;
        public List<LLMMessage> LastMessages { get; private set; } = new();

        public FakeLlmClient(IReadOnlyList<LLMStreamChunk> chunks) => _chunks = chunks;

        public string Provider => "fake";

        public IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
            string systemPrompt,
            List<LLMMessage> messages,
            CancellationToken cancellationToken = default)
            => StreamGenerateAsync(systemPrompt, messages, false, cancellationToken);

        public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
            string systemPrompt,
            List<LLMMessage> messages,
            bool enablePromptCache,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            LastMessages = messages;
            foreach (var chunk in _chunks)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return chunk;
                await Task.Yield();
            }
        }
    }

    private sealed class FakeContextAccessor : ILLMRequestContextAccessor
    {
        public LlmRequestContext? Current { get; private set; }
        public LlmRequestContext? LastContext { get; private set; }

        public IDisposable BeginScope(LlmRequestContext context)
        {
            LastContext = context;
            Current = context;
            return new Scope(this);
        }

        private sealed class Scope : IDisposable
        {
            private readonly FakeContextAccessor _owner;
            public Scope(FakeContextAccessor owner) => _owner = owner;
            public void Dispose() => _owner.Current = null;
        }
    }
}
