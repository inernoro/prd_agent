using PrdAgent.Api.Services;
using System.Text;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class InformationDeliveryTemplateTests
{
    [Fact]
    public void CatalogHasAnIllustratedExampleForEverySection()
    {
        Assert.NotEmpty(InformationDeliveryTemplates.All);
        foreach (var template in InformationDeliveryTemplates.All)
        {
            Assert.Equal(template, InformationDeliveryTemplates.Find(template.Id, template.Version));
            Assert.NotEmpty(template.Sections);
            Assert.All(template.Sections, section =>
            {
                Assert.False(string.IsNullOrWhiteSpace(section.Title));
                Assert.False(string.IsNullOrWhiteSpace(section.Purpose));
                Assert.False(string.IsNullOrWhiteSpace(section.Example));
            });
        }
    }

    [Theory]
    [InlineData("user-example", "1")]
    [InlineData("team-tutorial", "old-version")]
    public void CatalogRejectsUnknownAndStaleTemplateVersions(string id, string version)
    {
        Assert.Null(InformationDeliveryTemplates.Find(id, version));
    }

    [Fact]
    public void InstructionsIncludeSkeletonAndAuthorFocusButExcludeIllustrativeFacts()
    {
        var template = InformationDeliveryTemplates.Find("team-tutorial", "1")!;
        var empty = template.BuildInstructions("  ");
        var focused = template.BuildInstructions("仅面向审核人");
        foreach (var section in template.Sections)
        {
            Assert.Contains(section.Title, empty);
            Assert.Contains(section.Purpose, empty);
            Assert.DoesNotContain(section.Example, focused);
        }

        Assert.DoesNotContain("仅面向审核人", empty);
        Assert.Contains("仅面向审核人", focused);
    }

    [Fact]
    public void VerifiedCourseRequiresTheStructuredArtifactAndNoUnresolvedQuestions()
    {
        Assert.Throws<InvalidOperationException>(() => InformationDeliveryTemplates.EnsureReadyCourse(new("", [])));
        Assert.Throws<InvalidOperationException>(() => InformationDeliveryTemplates.EnsureReadyCourse(Course("""
            {"chapters":[{"title":"越过阈值","narration":"按例外处理","steps":["通知审核"],"basis":["资料 A §2"]}],"openQuestions":["等于阈值怎么做？"]}
            """)));
        Assert.Throws<InvalidOperationException>(() => InformationDeliveryTemplates.EnsureReadyCourse(Course("""
            {"chapters":[{"title":"阈值","narration":"按例外处理","steps":["通知审核"],"basis":[]}],"openQuestions":[]}
            """)));
        InformationDeliveryTemplates.EnsureReadyCourse(Course("""
            {"chapters":[{"title":"等于阈值","narration":"必须请审核人确认","steps":["通知审核"],"basis":["作者裁定 1"],"practice":{"question":"谁来确认？","answer":"审核人"}}],"openQuestions":[]}
            """));
    }

    [Fact]
    public void SessionDraftCanWaitForTheAuthorAndCannotInventAnAppliedReceipt()
    {
        var waiting = Course("""
            {"chapters":[{"title":"处理边界","narration":"先核对原文","steps":["查看资料 A"],"basis":["资料 A §2"]}],
             "openQuestions":["等于阈值怎么做？"]}
            """);
        Assert.True(InformationDeliveryTemplates.ValidateSessionCourse(waiting, []));
        Assert.Throws<InvalidOperationException>(() => InformationDeliveryTemplates.ValidateSessionCourse(waiting, ["a"]));
        var duplicate = Course("""
            {"chapters":[{"title":"处理边界","narration":"按补答执行","steps":["逐包提交"],"basis":["作者裁定 1"],
              "practice":{"question":"谁来确认？","answer":"审核人"}}],"openQuestions":[],"appliedCorrections":["a","a"]}
            """);
        Assert.Throws<InvalidOperationException>(() => InformationDeliveryTemplates.ValidateSessionCourse(duplicate, ["a"]));
        var closed = Course("""
            {"chapters":[{"title":"处理边界","narration":"按补答执行","steps":["逐包提交"],"basis":["作者裁定 1"],
              "practice":{"question":"谁来确认？","answer":"审核人"}}],"openQuestions":[],"appliedCorrections":["a"]}
            """);
        Assert.False(InformationDeliveryTemplates.ValidateSessionCourse(closed, ["a"]));
    }

    private static ParsedDesignWorkspaceResult Course(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        return new("", [new(InformationDeliveryTemplates.CoursePath, Convert.ToBase64String(bytes), "", bytes.Length, "application/json")]);
    }
}
