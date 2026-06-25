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

    // 匹配 {列名} 或 {列名 | 操作1 | 操作2}
    private static readonly System.Text.RegularExpressions.Regex ColRefRegex =
        new(@"\{([^{}]+)\}", System.Text.RegularExpressions.RegexOptions.Compiled);

    private static Dictionary<string, string> BuildValues(
        Dictionary<string, string> rowData,
        List<FileConvertFieldMapping> mappings)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in mappings)
        {
            var expr = string.IsNullOrWhiteSpace(m.ValueExpression)
                ? (string.IsNullOrWhiteSpace(m.SourceColumn) ? null : $"{{{m.SourceColumn}}}")
                : m.ValueExpression;

            if (expr == null) continue;

            // 将表达式中的 {列名 | 操作...} 全部求值替换
            var value = ColRefRegex.Replace(expr, match =>
            {
                var inner = match.Groups[1].Value;
                var parts = inner.Split('|');
                var col = parts[0].Trim();
                if (!rowData.TryGetValue(col, out var raw)) return match.Value;

                // 管道转换链
                var current = raw;
                for (var i = 1; i < parts.Length; i++)
                    current = ApplyPipe(current, parts[i].Trim());
                return current;
            });

            result[m.TemplatePlaceholder] = value;
        }
        return result;
    }

    /// <summary>
    /// 对单个值应用管道操作。
    /// 支持：
    ///   url_last          — URL 末段（最后一个 / 后的内容）
    ///   trim              — 去首尾空格
    ///   upper / lower     — 大/小写
    ///   regex: pattern    — 正则提取第1捕获组
    ///   split: sep, N     — 按 sep 切割取第 N 段（从1起）
    ///   replace: old, new — 字符串替换
    /// </summary>
    private static string ApplyPipe(string value, string pipe)
    {
        if (string.IsNullOrWhiteSpace(pipe)) return value;

        if (pipe.Equals("url_last", StringComparison.OrdinalIgnoreCase))
            return value.TrimEnd('/').Split('/').Last().Trim();

        if (pipe.Equals("trim", StringComparison.OrdinalIgnoreCase))
            return value.Trim();

        if (pipe.Equals("upper", StringComparison.OrdinalIgnoreCase))
            return value.ToUpperInvariant();

        if (pipe.Equals("lower", StringComparison.OrdinalIgnoreCase))
            return value.ToLowerInvariant();

        if (pipe.StartsWith("regex:", StringComparison.OrdinalIgnoreCase))
        {
            var pattern = pipe["regex:".Length..].Trim();
            try
            {
                var m = System.Text.RegularExpressions.Regex.Match(value, pattern);
                if (m.Success)
                    return m.Groups.Count > 1 ? m.Groups[1].Value : m.Value;
            }
            catch { /* 正则格式错误时返回原值 */ }
            return value;
        }

        if (pipe.StartsWith("split:", StringComparison.OrdinalIgnoreCase))
        {
            // split: /, 2  →  按 "/" 切割，取第2段（从1起）
            var args = pipe["split:".Length..].Split(',', 2);
            if (args.Length == 2)
            {
                var sep = args[0].Trim();
                if (int.TryParse(args[1].Trim(), out var idx) && idx >= 1)
                {
                    var parts = value.Split(sep);
                    return idx <= parts.Length ? parts[idx - 1].Trim() : value;
                }
            }
            return value;
        }

        if (pipe.StartsWith("replace:", StringComparison.OrdinalIgnoreCase))
        {
            // replace: old, new
            var args = pipe["replace:".Length..].Split(',', 2);
            if (args.Length == 2)
                return value.Replace(args[0].Trim(), args[1].Trim());
        }

        return value;
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
