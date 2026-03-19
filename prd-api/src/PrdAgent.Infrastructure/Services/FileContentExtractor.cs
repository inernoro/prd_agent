using System.Text;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;
using DocumentFormat.OpenXml.Wordprocessing;
using Microsoft.Extensions.Logging;
using UglyToad.PdfPig;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 文件内容提取器接口 - 从多种格式（PDF/Word/Excel/PPT）中提取纯文本
/// </summary>
public interface IFileContentExtractor
{
    /// <summary>
    /// 从文件字节中提取纯文本内容
    /// </summary>
    /// <param name="bytes">文件字节数组</param>
    /// <param name="mimeType">MIME 类型</param>
    /// <param name="fileName">文件名（用于扩展名回退判断）</param>
    /// <returns>提取的纯文本，如果格式不支持则返回 null</returns>
    string? Extract(byte[] bytes, string mimeType, string? fileName = null);

    /// <summary>
    /// 判断是否支持该 MIME 类型
    /// </summary>
    bool IsSupported(string mimeType);
}

/// <summary>
/// 文件内容提取器实现
/// 支持 PDF、Word (.docx)、Excel (.xlsx)、PowerPoint (.pptx) 格式
/// </summary>
public class FileContentExtractor : IFileContentExtractor
{
    private readonly ILogger<FileContentExtractor> _logger;

    /// <summary>最大提取文本长度（避免过长内容占满上下文窗口）</summary>
    private const int MaxExtractedLength = 50_000;

    private static readonly HashSet<string> SupportedMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        // PDF
        "application/pdf",
        // Word
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
        // Excel
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        // PowerPoint
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.ms-powerpoint",
        // 纯文本（直接读取）
        "text/plain",
        "text/markdown",
        "text/csv",
        "text/html",
        "text/xml",
        "application/json",
        "application/xml",
    };

    public FileContentExtractor(ILogger<FileContentExtractor> logger)
    {
        _logger = logger;
    }

    public bool IsSupported(string mimeType) => SupportedMimeTypes.Contains(mimeType);

    public string? Extract(byte[] bytes, string mimeType, string? fileName = null)
    {
        try
        {
            var text = mimeType.ToLowerInvariant() switch
            {
                "application/pdf" => ExtractPdf(bytes),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => ExtractDocx(bytes),
                "application/msword" => ExtractDocx(bytes), // 旧版 .doc 尝试用 OpenXml 解析
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => ExtractXlsx(bytes),
                "application/vnd.ms-excel" => ExtractXlsx(bytes),
                "application/vnd.openxmlformats-officedocument.presentationml.presentation" => ExtractPptx(bytes),
                "application/vnd.ms-powerpoint" => ExtractPptx(bytes),
                "text/plain" or "text/markdown" or "text/csv" or "text/html" or "text/xml"
                    or "application/json" or "application/xml" => ExtractText(bytes),
                _ => null
            };

            if (text != null && text.Length > MaxExtractedLength)
            {
                text = text[..MaxExtractedLength] + "\n\n[... 内容已截断，共 " + text.Length + " 字符 ...]";
            }

            return text;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "文件内容提取失败: MimeType={MimeType}, FileName={FileName}", mimeType, fileName);
            return null;
        }
    }

    private static string ExtractText(byte[] bytes)
    {
        return Encoding.UTF8.GetString(bytes);
    }

    private static string ExtractPdf(byte[] bytes)
    {
        using var document = PdfDocument.Open(bytes);
        var sb = new StringBuilder();

        foreach (var page in document.GetPages())
        {
            var text = page.Text;
            if (!string.IsNullOrWhiteSpace(text))
            {
                sb.AppendLine(text);
                sb.AppendLine();
            }
        }

        return sb.ToString().Trim();
    }

    private static string ExtractDocx(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        using var doc = WordprocessingDocument.Open(stream, false);

        var body = doc.MainDocumentPart?.Document?.Body;
        if (body == null) return string.Empty;

        var sb = new StringBuilder();
        foreach (var para in body.Elements<Paragraph>())
        {
            var text = para.InnerText;
            if (!string.IsNullOrWhiteSpace(text))
            {
                sb.AppendLine(text);
            }
        }

        return sb.ToString().Trim();
    }

    private static string ExtractXlsx(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        using var doc = SpreadsheetDocument.Open(stream, false);

        var workbookPart = doc.WorkbookPart;
        if (workbookPart == null) return string.Empty;

        // 获取共享字符串表
        var sharedStrings = workbookPart.SharedStringTablePart?.SharedStringTable
            ?.Elements<SharedStringItem>()
            .Select(s => s.InnerText)
            .ToArray() ?? Array.Empty<string>();

        var sb = new StringBuilder();
        var sheets = workbookPart.Workbook.Sheets?.Elements<Sheet>() ?? Enumerable.Empty<Sheet>();

        foreach (var sheet in sheets)
        {
            var sheetName = sheet.Name?.Value;
            if (!string.IsNullOrWhiteSpace(sheetName))
            {
                sb.AppendLine($"## {sheetName}");
                sb.AppendLine();
            }

            if (sheet.Id?.Value == null) continue;
            var worksheetPart = (WorksheetPart)workbookPart.GetPartById(sheet.Id.Value);
            var rows = worksheetPart.Worksheet.Descendants<Row>();

            foreach (var row in rows)
            {
                var cells = row.Elements<Cell>().ToList();
                var values = new List<string>();

                foreach (var cell in cells)
                {
                    var value = GetCellValue(cell, sharedStrings);
                    values.Add(value);
                }

                if (values.Any(v => !string.IsNullOrWhiteSpace(v)))
                {
                    sb.AppendLine(string.Join("\t", values));
                }
            }

            sb.AppendLine();
        }

        return sb.ToString().Trim();
    }

    private static string GetCellValue(Cell cell, string[] sharedStrings)
    {
        var value = cell.CellValue?.InnerText ?? string.Empty;

        if (cell.DataType?.Value == CellValues.SharedString)
        {
            if (int.TryParse(value, out var index) && index >= 0 && index < sharedStrings.Length)
            {
                return sharedStrings[index];
            }
        }

        return value;
    }

    private static string ExtractPptx(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        using var doc = PresentationDocument.Open(stream, false);

        var presentationPart = doc.PresentationPart;
        if (presentationPart == null) return string.Empty;

        var sb = new StringBuilder();
        var slideIds = presentationPart.Presentation.SlideIdList
            ?.Elements<DocumentFormat.OpenXml.Presentation.SlideId>() ?? Enumerable.Empty<DocumentFormat.OpenXml.Presentation.SlideId>();

        var slideIndex = 0;
        foreach (var slideId in slideIds)
        {
            slideIndex++;
            if (slideId.RelationshipId?.Value == null) continue;

            var slidePart = (SlidePart)presentationPart.GetPartById(slideId.RelationshipId.Value);
            var slideText = slidePart.Slide.InnerText;

            if (!string.IsNullOrWhiteSpace(slideText))
            {
                sb.AppendLine($"--- 第 {slideIndex} 页 ---");
                sb.AppendLine(slideText);
                sb.AppendLine();
            }
        }

        return sb.ToString().Trim();
    }
}
