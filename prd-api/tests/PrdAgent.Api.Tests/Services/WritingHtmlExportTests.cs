using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WritingHtmlExportTests
{
    [Fact]
    public void MixedSourceAndAuthorParagraphsKeepTheirSeparateOrigins()
    {
        const string original = "少于200份可单包；恰好200份尚未规定。";
        const string supplement = "恰好200份也分包，每包严格少于200份。<保留作者原文>";
        var publication = new WritingPublication { Sections = new() { new WritingSection {
            Id = "s4", Title = "数量边界与异常", Paragraphs = new() {
                new WritingParagraph { Id = "p6", Status = "src", Text = original, Confirmed = true,
                    Citations = new() { "S1" }, Quotes = new() { ["S1"] = original } },
                new WritingParagraph { Id = "p7", Status = "auth", Text = supplement, Confirmed = true }
            }
        } } };
        var before = WritingDeliveryPolicy.Hash(publication);
        var html = WritingHtmlExport.Render(publication);
        Assert.Contains("<div class=\"meta\">作者补充</div><p id=\"p7037\">恰好200份也分包，每包严格少于200份。&lt;保留作者原文&gt;</p>", html);
        Assert.DoesNotContain("作者补充</div><p id=\"p7036\">", html);
        Assert.Contains("<p id=\"p7036\">" + original + "</p><details><summary><a href=\"#source5331\">S1</a> · 引用原文</summary><blockquote>" + original + "</blockquote></details>", html);
        Assert.Equal(1, html.Split("作者补充</div>").Length - 1);
        Assert.DoesNotContain("<保留作者原文>", html);
        Assert.Contains("default-src 'none'", html);
        Assert.Equal(before, WritingDeliveryPolicy.Hash(publication));
    }

    [Fact]
    public void ExportKeepsBoundariesRolesExceptionsAndSourceWithoutExecutingInput()
    {
        var publication = new WritingPublication {
            Version = 3, Title = "<script>unsafe()</script>", ScopeIn = "仅测试租户", ScopeOut = "正式租户禁止执行",
            IntentPoints = new() { "失败立即停止" },
            Roles = new() { new WritingRole { Label = "审核人", Action = "逐批确认", Condition = "先备份", SectionId = "s1" } },
            Sections = new() { new WritingSection { Id = "s1", Title = "执行", Condition = "每批少于100条", Paragraphs = new() {
                new WritingParagraph { Id = "p1", Text = "失败后不得重复提交", Citations = new() { "S1" }, Quotes = new() { ["S1"] = "失败后不得重复提交" } }
            } } },
            Sources = new() { new WritingSource { Id = "S1", Title = "原始规范", Status = "read", Content = "失败后不得重复提交" } }
        };
        var html = WritingHtmlExport.Render(publication);
        foreach (var text in new[] { "仅测试租户", "正式租户禁止执行", "每批少于100条", "审核人", "逐批确认", "先备份", "失败立即停止", "失败后不得重复提交", "原始规范", "发布版 v3" }) Assert.Contains(text, html);
        Assert.DoesNotContain("<script>", html);
        Assert.Contains("&lt;script&gt;", html);
        Assert.Contains("default-src 'none'", html);
        Assert.Contains("href=\"#source5331\"", html);
    }
}
