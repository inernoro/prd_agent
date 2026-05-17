using Shouldly;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Api.Services.Toolbox.Adapters;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Core.Interfaces;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class CdsAgentRuntimeCompatibilityTests
{
    private static readonly string[] NonCodeToolboxAdapters =
    {
        "PrdAgentAdapter.cs",
        "DefectAgentAdapter.cs",
        "LiteraryAgentAdapter.cs",
        "VisualAgentAdapter.cs",
    };

    [Theory]
    [MemberData(nameof(NonCodeAdapterSources))]
    public void NonCodeToolboxAdapters_ShouldNotDependOnCdsRuntimePool(string fileName, string source)
    {
        source.Contains("IInfraAgentRuntimeAdapter", StringComparison.OrdinalIgnoreCase).ShouldBeFalse(fileName);
        source.Contains("InfraAgentRuntimes", StringComparison.OrdinalIgnoreCase).ShouldBeFalse(fileName);
        source.Contains("IClaudeSidecarRouter", StringComparison.OrdinalIgnoreCase).ShouldBeFalse(fileName);
        source.Contains("ClaudeSidecar", StringComparison.OrdinalIgnoreCase).ShouldBeFalse(fileName);
    }

    [Fact]
    public void CdsAgentAdapter_ShouldBeTheOnlyToolboxAdapterThatDependsOnInfraRuntime()
    {
        var adapterSources = ReadToolboxAdapterSources()
            .Where(x => x.Source.Contains("IInfraAgentRuntimeAdapter", StringComparison.Ordinal))
            .Select(x => x.FileName)
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToArray();

        adapterSources.ShouldBe(new[] { "CdsAgentAdapter.cs" });
    }

    [Fact]
    public void NonCodeToolboxAdapters_ShouldNotInjectCdsRuntimeServices()
    {
        foreach (var adapterType in NonCodeToolboxAdapterTypes())
        {
            var dependencyTypes = ConstructorParameterTypes(adapterType);

            dependencyTypes.ShouldNotContain(typeof(IInfraAgentRuntimeAdapter), adapterType.Name);
            dependencyTypes.ShouldNotContain(typeof(IClaudeSidecarRouter), adapterType.Name);
            dependencyTypes.Any(type => type.FullName?.Contains("ClaudeSidecar", StringComparison.OrdinalIgnoreCase) == true)
                .ShouldBeFalse(adapterType.Name);
        }
    }

    [Fact]
    public void CdsAgentAdapter_ShouldOwnTheOnlyRuntimeAdapterConstructorDependency()
    {
        var owners = ToolboxAdapterTypes()
            .Where(type => ConstructorParameterTypes(type).Contains(typeof(IInfraAgentRuntimeAdapter)))
            .Select(type => type.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        owners.ShouldBe(new[] { nameof(CdsAgentAdapter) });
    }

    [Fact]
    public async Task NonCodeToolboxAdapters_ShouldExecuteMinimalBusinessPathWithoutCdsRuntimePool()
    {
        var gateway = new FakeLlmGateway();
        var cases = new (IAgentAdapter Adapter, string Action, string ExpectedArtifactName)[]
        {
            (new PrdAgentAdapter(gateway, NullLogger<PrdAgentAdapter>.Instance), "analyze_prd", "PRD分析报告.md"),
            (new DefectAgentAdapter(gateway, NullLogger<DefectAgentAdapter>.Instance), "extract_defect", "缺陷信息.md"),
            (new LiteraryAgentAdapter(gateway, NullLogger<LiteraryAgentAdapter>.Instance), "generate_outline", "写作大纲.md")
        };

        foreach (var (adapter, action, expectedArtifactName) in cases)
        {
            adapter.CanHandle(action).ShouldBeTrue($"{adapter.AgentKey}:{action}");
            var result = await adapter.ExecuteAsync(new AgentExecutionContext
            {
                RunId = "n6-smoke-run",
                TraceId = "n6-smoke-trace",
                StepId = $"{adapter.AgentKey}-step",
                UserId = "test-user",
                Action = action,
                UserMessage = "N6 smoke minimal input"
            });

            result.Success.ShouldBeTrue(adapter.AgentKey);
            result.Content.ShouldContain("fake gateway response");
            result.Artifacts.Single().Name.ShouldBe(expectedArtifactName);
        }

        var visual = new VisualAgentAdapter(gateway, NullLogger<VisualAgentAdapter>.Instance);
        visual.CanHandle("compose").ShouldBeTrue();
        var visualResult = await visual.ExecuteAsync(new AgentExecutionContext
        {
            RunId = "n6-smoke-run",
            TraceId = "n6-smoke-trace",
            StepId = "visual-agent-step",
            UserId = "test-user",
            Action = "compose",
            UserMessage = "N6 smoke visual compose"
        });
        visualResult.Success.ShouldBeTrue();
        visualResult.Content.ShouldContain("compose");
    }

    public static IEnumerable<object[]> NonCodeAdapterSources()
        => ReadToolboxAdapterSources()
            .Where(x => NonCodeToolboxAdapters.Contains(x.FileName, StringComparer.Ordinal))
            .Select(x => new object[] { x.FileName, x.Source });

    private static Type[] ToolboxAdapterTypes() =>
    [
        typeof(PrdAgentAdapter),
        typeof(DefectAgentAdapter),
        typeof(LiteraryAgentAdapter),
        typeof(VisualAgentAdapter),
        typeof(CdsAgentAdapter),
    ];

    private static Type[] NonCodeToolboxAdapterTypes() =>
        ToolboxAdapterTypes()
            .Where(type => type != typeof(CdsAgentAdapter))
            .ToArray();

    private static Type[] ConstructorParameterTypes(Type adapterType) =>
        adapterType.GetConstructors()
            .SelectMany(ctor => ctor.GetParameters())
            .Select(parameter => parameter.ParameterType)
            .Distinct()
            .ToArray();

    private static IEnumerable<(string FileName, string Source)> ReadToolboxAdapterSources()
    {
        var root = FindRepositoryRoot();
        var dir = Path.Combine(root, "prd-api", "src", "PrdAgent.Api", "Services", "Toolbox", "Adapters");
        return Directory.GetFiles(dir, "*.cs")
            .Select(path => (Path.GetFileName(path), File.ReadAllText(path)));
    }

    private static string FindRepositoryRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "prd-api", "src", "PrdAgent.Api")))
                return dir.FullName;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate repository root from test base directory.");
    }

    private sealed class FakeLlmGateway : ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default) =>
            Task.FromResult(GatewayResponse.Ok("fake gateway response", FakeResolution()));

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request,
            [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.Yield();
            yield return GatewayStreamChunk.Text("fake gateway response");
            yield return GatewayStreamChunk.Done("stop", null);
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request,
            GatewayModelResolution resolution,
            CancellationToken ct = default) =>
            Task.FromResult(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = """{"data":[{"url":"https://example.invalid/image.png"}]}""",
                Resolution = resolution
            });

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            CancellationToken ct = default) =>
            Task.FromResult(FakeResolution());

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default) =>
            Task.FromResult(new List<AvailableModelPool>());

        public ILLMClient CreateClient(
            string appCallerCode,
            string modelType,
            int maxTokens = 4096,
            double temperature = 0.2,
            bool includeThinking = false,
            string? expectedModel = null) =>
            throw new NotSupportedException("N6 compatibility tests do not create legacy LLM clients.");

        private static GatewayModelResolution FakeResolution() => new()
        {
            Success = true,
            ResolutionType = "test",
            ActualModel = "fake-model",
            ActualPlatformId = "fake-platform"
        };
    }
}
