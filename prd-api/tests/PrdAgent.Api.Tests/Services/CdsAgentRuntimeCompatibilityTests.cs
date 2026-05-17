using Shouldly;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Api.Services.Toolbox.Adapters;
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
}
