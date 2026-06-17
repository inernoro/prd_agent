using System.Globalization;
using System.Text;
using ClosedXML.Excel;
using CsvHelper;
using CsvHelper.Configuration;

namespace PrdAgent.Api.Services.FileConvertAgent;

/// <summary>
/// 解析源文件（CSV / Excel / JSON），提取列名和数据行
/// </summary>
public class FileParserService
{
    public record ParseResult(List<string> Columns, List<Dictionary<string, string>> Rows, string Error = "");

    public async Task<ParseResult> ParseAsync(byte[] bytes, string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".csv" => await ParseCsvAsync(bytes),
            ".xlsx" or ".xls" => ParseExcel(bytes),
            ".json" => ParseJson(bytes),
            _ => new ParseResult([], [], $"不支持的源文件格式：{ext}，仅支持 .csv / .xlsx / .json")
        };
    }

    private static async Task<ParseResult> ParseCsvAsync(byte[] bytes)
    {
        try
        {
            var text = Encoding.UTF8.GetString(bytes);
            using var reader = new StringReader(text);
            var config = new CsvConfiguration(CultureInfo.InvariantCulture)
            {
                MissingFieldFound = null,
                BadDataFound = null,
            };
            using var csv = new CsvReader(reader, config);

            var columns = new List<string>();
            var rows = new List<Dictionary<string, string>>();

            await csv.ReadAsync();
            csv.ReadHeader();
            if (csv.HeaderRecord != null)
                columns.AddRange(csv.HeaderRecord);

            while (await csv.ReadAsync())
            {
                var row = new Dictionary<string, string>();
                foreach (var col in columns)
                    row[col] = csv.GetField(col) ?? string.Empty;
                rows.Add(row);
            }

            return new ParseResult(columns, rows);
        }
        catch (Exception ex)
        {
            return new ParseResult([], [], $"CSV 解析失败：{ex.Message}");
        }
    }

    private static ParseResult ParseExcel(byte[] bytes)
    {
        try
        {
            using var ms = new MemoryStream(bytes);
            using var wb = new XLWorkbook(ms);
            var ws = wb.Worksheets.First();

            var columns = new List<string>();
            var rows = new List<Dictionary<string, string>>();

            var lastCol = ws.LastColumnUsed()?.ColumnNumber() ?? 0;
            var lastRow = ws.LastRowUsed()?.RowNumber() ?? 0;

            if (lastRow < 1 || lastCol < 1)
                return new ParseResult([], [], "Excel 文件为空");

            // 第一行作为表头
            for (var c = 1; c <= lastCol; c++)
            {
                var header = ws.Cell(1, c).GetString().Trim();
                columns.Add(string.IsNullOrWhiteSpace(header) ? $"列{c}" : header);
            }

            for (var r = 2; r <= lastRow; r++)
            {
                var row = new Dictionary<string, string>();
                for (var c = 1; c <= lastCol; c++)
                    row[columns[c - 1]] = ws.Cell(r, c).GetString();
                rows.Add(row);
            }

            return new ParseResult(columns, rows);
        }
        catch (Exception ex)
        {
            return new ParseResult([], [], $"Excel 解析失败：{ex.Message}");
        }
    }

    private static ParseResult ParseJson(byte[] bytes)
    {
        try
        {
            var text = Encoding.UTF8.GetString(bytes);
            var elements = System.Text.Json.JsonSerializer.Deserialize<List<Dictionary<string, System.Text.Json.JsonElement>>>(text);
            if (elements == null || elements.Count == 0)
                return new ParseResult([], [], "JSON 文件为空或格式不是数组对象");

            var columns = elements[0].Keys.ToList();
            var rows = elements.Select(e =>
                columns.ToDictionary(c => c, c => e.TryGetValue(c, out var v) ? v.ToString() : string.Empty)
            ).ToList();

            return new ParseResult(columns, rows);
        }
        catch (Exception ex)
        {
            return new ParseResult([], [], $"JSON 解析失败：{ex.Message}（期望格式：[{{\"列名\":\"值\",...}}]）");
        }
    }
}
