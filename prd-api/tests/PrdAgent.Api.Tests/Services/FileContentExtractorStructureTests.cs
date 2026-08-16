using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class FileContentExtractorStructureTests
{
    private const string DocxMime =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    [Fact]
    public void StructurallyValid_RejectsBytesThatOnlyClaimToBeDocx()
    {
        FileContentExtractor.IsStructurallyValid("not-a-docx"u8.ToArray(), DocxMime)
            .ShouldBeFalse();
    }

    [Fact]
    public void StructurallyValid_AcceptsAValidDocxWithoutText()
    {
        using var stream = new MemoryStream();
        using (var document = WordprocessingDocument.Create(
                   stream,
                   DocumentFormat.OpenXml.WordprocessingDocumentType.Document,
                   true))
        {
            var mainPart = document.AddMainDocumentPart();
            mainPart.Document = new Document(new Body());
            mainPart.Document.Save();
        }

        FileContentExtractor.IsStructurallyValid(stream.ToArray(), DocxMime)
            .ShouldBeTrue();
    }

    [Fact]
    public void StructurallyValid_DoesNotApplyContainerRulesToPlainText()
    {
        FileContentExtractor.IsStructurallyValid("正文"u8.ToArray(), "text/plain")
            .ShouldBeTrue();
    }
}
