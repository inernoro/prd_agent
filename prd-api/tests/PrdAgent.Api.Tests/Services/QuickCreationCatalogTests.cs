using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
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
            var direction = QuickCreationCatalog.FreezeWebDirection(template);
            Assert.Contains(template.PromptRef, direction.GeneratePrompt);
            Assert.False(string.IsNullOrWhiteSpace(direction.DesignSystemId));
            var workspaceFile = QuickCreationCatalog.FreezeWorkspaceGuide(new QuickCreationInput
            {
                TemplateId = template.Id, StyleSha256 = template.GuideSha256,
            });
            Assert.Equal(bytes, Convert.FromBase64String(workspaceFile.ContentBase64));
        }
    }
}
