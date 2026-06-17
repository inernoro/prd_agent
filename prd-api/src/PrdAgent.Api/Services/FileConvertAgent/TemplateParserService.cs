using System.Text.RegularExpressions;
using ClosedXML.Excel;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace PrdAgent.Api.Services.FileConvertAgent;

/// <summary>
/// 解析模板文件，提取占位符列表（{{ 字段名 }}）
/// </summary>
public class TemplateParserService
{
    private static readonly Regex PlaceholderRegex = new(@"\{\{\s*([^{}]+?)\s*\}\}", RegexOptions.Compiled);

    public record ParseResult(List<string> Placeholders, string Error = "");

    public Task<ParseResult> ParseAsync(byte[] bytes, string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".docx" => Task.FromResult(ParseDocx(bytes)),
            ".xlsx" => Task.FromResult(ParseXlsx(bytes)),
            _ => Task.FromResult(new ParseResult([], $"不支持的模板格式：{ext}，仅支持 .docx / .xlsx"))
        };
    }

    private static ParseResult ParseDocx(byte[] bytes)
    {
        try
        {
            using var ms = new MemoryStream(bytes);
            using var doc = WordprocessingDocument.Open(ms, false);
            var body = doc.MainDocumentPart?.Document?.Body;
            if (body == null)
                return new ParseResult([], "Word 文档内容为空");

            var text = body.InnerText;
            var placeholders = PlaceholderRegex.Matches(text)
                .Select(m => m.Groups[1].Value.Trim())
                .Distinct()
                .ToList();

            return new ParseResult(placeholders);
        }
        catch (Exception ex)
        {
            return new ParseResult([], $"Word 模板解析失败：{ex.Message}");
        }
    }

    private static ParseResult ParseXlsx(byte[] bytes)
    {
        try
        {
            using var ms = new MemoryStream(bytes);
            using var wb = new XLWorkbook(ms);

            var placeholders = new HashSet<string>();
            foreach (var ws in wb.Worksheets)
            {
                foreach (var cell in ws.CellsUsed())
                {
                    var val = cell.GetString();
                    foreach (Match m in PlaceholderRegex.Matches(val))
                        placeholders.Add(m.Groups[1].Value.Trim());
                }
            }

            return new ParseResult(placeholders.ToList());
        }
        catch (Exception ex)
        {
            return new ParseResult([], $"Excel 模板解析失败：{ex.Message}");
        }
    }
}
