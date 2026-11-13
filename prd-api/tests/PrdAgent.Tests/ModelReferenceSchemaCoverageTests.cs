using PrdAgent.Core.Models;
using PrdAgent.LlmGw.ModelReferences;
using Xunit;

namespace PrdAgent.Tests;

public sealed class ModelReferenceSchemaCoverageTests
{
    [Fact]
    public void EveryPersistedSelectionFieldRequiresExplicitClassification()
    {
        var fields = typeof(ArenaSlot).Assembly.GetTypes().Where(x => x.Namespace?.StartsWith("PrdAgent.Core.Models", StringComparison.Ordinal) == true)
            .SelectMany(t => t.GetProperties().Where(p => p.CanWrite && !p.GetMethod!.IsStatic
                && (p.PropertyType == typeof(string) || p.PropertyType == typeof(List<string>))
                && (ModelReferenceRegistry.IsSelectionName(p.Name) || t == typeof(GatewayLogicalModel) && new[] { "PublicId", "Aliases", "MigratedFromPoolIds" }.Contains(p.Name))).Select(p => t.FullName + "." + p.Name)).OrderBy(x => x).ToArray();
        var missing = fields.Except(ModelReferenceFieldClassifications.Fields.Keys, StringComparer.Ordinal).ToArray();
        Assert.True(missing.Length == 0, "新增模型选择字段必须分类并登记handler，不能默默遗漏：\n" + string.Join("\n", missing));
        Assert.Empty(ModelReferenceFieldClassifications.Fields.Keys.Except(fields, StringComparer.Ordinal));
        foreach (var entry in ModelReferenceFieldClassifications.Fields.Values.Where(x => x.StartsWith("handler:", StringComparison.Ordinal)))
            Assert.Contains(ModelReferenceRegistry.Collections, x => x.Key == entry["handler:".Length..]);
    }

    [Fact]
    public void RuntimeOptionsAndDesignModelConfigurationRequireFiniteClassification()
    {
        var types = new[] { typeof(PrdAgent.Infrastructure.Services.ChatAgent.ChatAgentOptions), typeof(PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarOptions) };
        var fields = types.SelectMany(t => t.GetProperties().Where(p => p.CanWrite && p.PropertyType == typeof(string) && ModelReferenceRegistry.IsSelectionName(p.Name)).Select(p => t.Name + "." + p.Name));
        Assert.Equal(new[] { "ChatAgentOptions.Model", "ClaudeSidecarOptions.DefaultModel" }, fields.OrderBy(x => x).ToArray());
        var root = FindRoot();
        var source = File.ReadAllText(Path.Combine(root, "prd-api/src/PrdAgent.Api/Services/DesignArtifactExecutor.cs"));
        var keys = System.Text.RegularExpressions.Regex.Matches(source, "section\\[\"([^\"]+)\"\\]")
            .Select(m => m.Groups[1].Value).Where(ModelReferenceRegistry.IsSelectionName).Distinct().OrderBy(x => x).ToArray();
        Assert.Equal(new[] { "PinnedModelId", "PinnedPlatformId" }, keys);
        var modelKeys = System.Text.RegularExpressions.Regex.Matches(source, "configuration\\[\"DesignArtifactRuntime:([^\"]+)\"\\]")
            .Select(m => m.Groups[1].Value).Where(ModelReferenceRegistry.IsSelectionName).Distinct().OrderBy(x => x).ToArray();
        Assert.Equal(new[] { "Model", "ModelPoolId" }, modelKeys);
    }
    private static string FindRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "llmgw/console-api"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("repository root not found");
    }
}
