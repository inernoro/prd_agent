using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using DocumentFormat.OpenXml.Packaging;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.FileConvertAgent;

/// <summary>
/// 将源文件数据行按字段映射填入模板，输出 ZIP 包字节
/// </summary>
public class TemplateRendererService
{
    private static readonly Regex PlaceholderRegex = new(@"\{\{\s*([^{}]+?)\s*\}\}", RegexOptions.Compiled);

    public record RenderResult(byte[]? ZipBytes, string Error = "");

    /// <summary>
    /// 批量渲染：每行数据生成一个目标文件，打包成 ZIP
    /// </summary>
    public async Task<RenderResult> RenderAllAsync(
        byte[] templateBytes,
        string templateFileName,
        List<Dictionary<string, string>> rows,
        List<FileConvertFieldMapping> mappings,
        IProgress<int>? progress = null)
    {
        var ext = Path.GetExtension(templateFileName).ToLowerInvariant();
        if (ext is not (".docx" or ".xlsx" or ".csv"))
            return new RenderResult(null, $"不支持的模板格式：{ext}，仅支持 .docx / .xlsx / .csv");

        try
        {
            using var zipMs = new MemoryStream();
            using (var archive = new ZipArchive(zipMs, ZipArchiveMode.Create, leaveOpen: true))
            {
                for (var i = 0; i < rows.Count; i++)
                {
                    var values = BuildValues(rows[i], mappings);
                    var outputBytes = ext switch
                    {
                        ".docx" => RenderDocx(templateBytes, values),
                        ".xlsx" => RenderXlsx(templateBytes, values),
                        ".csv" => RenderCsv(templateBytes, values),
                        _ => throw new InvalidOperationException($"未处理的模板格式：{ext}")
                    };

                    var entryName = $"{Path.GetFileNameWithoutExtension(templateFileName)}_{i + 1:D4}{ext}";
                    var entry = archive.CreateEntry(entryName, CompressionLevel.Fastest);
                    await using var entryStream = entry.Open();
                    await entryStream.WriteAsync(outputBytes);

                    progress?.Report(i + 1);
                }
            }

            zipMs.Position = 0;
            return new RenderResult(zipMs.ToArray());
        }
        catch (Exception ex)
        {
            return new RenderResult(null, $"批量生成失败：{ex.Message}");
        }
    }

    private static readonly System.Text.RegularExpressions.Regex ColRefRegex =
        new(@"\{([^{}]+)\}", System.Text.RegularExpressions.RegexOptions.Compiled);

    private static Dictionary<string, string> BuildValues(
        Dictionary<string, string> rowData,
        List<FileConvertFieldMapping> mappings)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in mappings)
        {
            // 兼容旧版：ValueExpression 为空时退化为直接列映射
            var expr = string.IsNullOrWhiteSpace(m.ValueExpression)
                ? (string.IsNullOrWhiteSpace(m.SourceColumn) ? null : $"{{{m.SourceColumn}}}")
                : m.ValueExpression;

            if (expr == null) continue;

            // 求值：将 {列名} 替换为对应行的列值，找不到则保留原文
            var value = ColRefRegex.Replace(expr, match =>
            {
                var col = match.Groups[1].Value.Trim();
                return rowData.TryGetValue(col, out var v) ? v : match.Value;
            });

            result[m.TemplatePlaceholder] = value;
        }
        return result;
    }

    private static byte[] RenderDocx(byte[] templateBytes, Dictionary<string, string> values)
    {
        var output = new byte[templateBytes.Length];
        Array.Copy(templateBytes, output, templateBytes.Length);

        using var ms = new MemoryStream(output);
        using var doc = WordprocessingDocument.Open(ms, isEditable: true);

        var body = doc.MainDocumentPart?.Document?.Body;
        if (body == null) return output;

        // 替换段落中的占位符（文本可能被拆散在多个 Run 中，先合并再替换）
        foreach (var para in body.Descendants<DocumentFormat.OpenXml.Wordprocessing.Paragraph>())
        {
            var runs = para.Descendants<DocumentFormat.OpenXml.Wordprocessing.Run>().ToList();
            if (runs.Count == 0) continue;

            // 收集所有 Text 节点拼成完整字符串
            var combined = string.Concat(runs.SelectMany(r =>
                r.Elements<DocumentFormat.OpenXml.Wordprocessing.Text>().Select(t => t.Text)));

            if (!PlaceholderRegex.IsMatch(combined)) continue;

            var replaced = PlaceholderRegex.Replace(combined, m =>
            {
                var key = m.Groups[1].Value.Trim();
                return values.TryGetValue(key, out var v) ? v : m.Value;
            });

            // 把替换结果写回第一个 Run，清空其余 Run
            var first = runs[0];
            var firstText = first.GetFirstChild<DocumentFormat.OpenXml.Wordprocessing.Text>();
            if (firstText != null)
            {
                firstText.Text = replaced;
                firstText.Space = DocumentFormat.OpenXml.SpaceProcessingModeValues.Preserve;
            }
            for (var i = 1; i < runs.Count; i++)
                runs[i].Remove();
        }

        doc.MainDocumentPart!.Document.Save();
        ms.Position = 0;
        return ms.ToArray();
    }

    private static byte[] RenderCsv(byte[] templateBytes, Dictionary<string, string> values)
    {
        var text = Encoding.UTF8.GetString(templateBytes);
        var replaced = PlaceholderRegex.Replace(text, m =>
        {
            var key = m.Groups[1].Value.Trim();
            return values.TryGetValue(key, out var v) ? v : m.Value;
        });
        return Encoding.UTF8.GetBytes(replaced);
    }

    private static byte[] RenderXlsx(byte[] templateBytes, Dictionary<string, string> values)
    {
        var output = new byte[templateBytes.Length];
        Array.Copy(templateBytes, output, templateBytes.Length);

        using var ms = new MemoryStream(output);
        using var wb = new XLWorkbook(ms);

        foreach (var ws in wb.Worksheets)
        {
            foreach (var cell in ws.CellsUsed().ToList())
            {
                var val = cell.GetString();
                if (!PlaceholderRegex.IsMatch(val)) continue;

                var replaced = PlaceholderRegex.Replace(val, m =>
                {
                    var key = m.Groups[1].Value.Trim();
                    return values.TryGetValue(key, out var v) ? v : m.Value;
                });
                cell.SetValue(replaced);
            }
        }

        using var outMs = new MemoryStream();
        wb.SaveAs(outMs);
        return outMs.ToArray();
    }
}
