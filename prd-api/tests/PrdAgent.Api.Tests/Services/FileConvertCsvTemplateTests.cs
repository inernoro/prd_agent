using System.Text;
using PrdAgent.Api.Services.FileConvertAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class FileConvertCsvTemplateTests
{
    private readonly TemplateParserService _parser = new();
    private readonly TemplateRendererService _renderer = new();

    [Fact]
    public async Task ParseCsvTemplate_ShouldExtractPlaceholders()
    {
        var template = Encoding.UTF8.GetBytes("name,age\n{{ name }},{{age}}");
        var result = await _parser.ParseAsync(template, "template.csv");

        Assert.Empty(result.Error);
        Assert.Equal(2, result.Placeholders.Count);
        Assert.Contains("name", result.Placeholders);
        Assert.Contains("age", result.Placeholders);
    }

    [Fact]
    public async Task RenderCsvTemplate_ShouldReplacePlaceholdersPerRow()
    {
        var template = Encoding.UTF8.GetBytes("name,age\n{{name}},{{age}}");
        var rows = new List<Dictionary<string, string>>
        {
            new() { ["name"] = "Alice", ["age"] = "30" },
            new() { ["name"] = "Bob", ["age"] = "25" },
        };
        var mappings = new List<FileConvertFieldMapping>
        {
            new() { SourceColumn = "name", TemplatePlaceholder = "name" },
            new() { SourceColumn = "age", TemplatePlaceholder = "age" },
        };

        var result = await _renderer.RenderAllAsync(template, "template.csv", rows, mappings);

        Assert.Empty(result.Error);
        Assert.NotNull(result.ZipBytes);
        Assert.True(result.ZipBytes!.Length > 0);
    }
}
