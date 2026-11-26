using System.Text;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class QuickCreationCatalogTests
{
    [Fact]
    public void FixedV6Catalog_PreservesEveryOriginalGuideAndOnlyAllowsRegisteredIds()
    {
        var catalog = QuickCreationCatalog.Get();
        Assert.Equal(15, catalog.Categories.Count);
        Assert.Equal(99, catalog.Items.Count);
        Assert.NotNull(QuickCreationCatalog.Find("sketchnote"));
        Assert.Null(QuickCreationCatalog.Find("../sketchnote"));
        var categories = catalog.Categories.Select(item => item.Id).ToHashSet();
        foreach (var template in catalog.Items)
        {
            Assert.Contains(template.CategoryId, categories);
            var bytes = QuickCreationCatalog.ReadGuide(template);
            Assert.Equal(template.GuideSha256, QuickCreationCatalog.Hash(bytes));
            Assert.Equal($"styles/{template.Id}/STYLE.md", template.PromptRef);
            var guide = Encoding.UTF8.GetString(bytes);
            Assert.Equal(guide, QuickCreationCatalog.FreezeWebDirection(template, guide).GeneratePrompt);
        }
    }
}
