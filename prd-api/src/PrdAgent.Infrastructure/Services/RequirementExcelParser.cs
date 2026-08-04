using System.Globalization;
using System.Text;
using ExcelDataReader;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services;

/// <summary>需求表解析结果</summary>
public class ParsedRequirementTable
{
    public string SheetName { get; set; } = string.Empty;
    public List<string> Headers { get; set; } = new();
    public List<List<string>> Rows { get; set; } = new();
    /// <summary>截断前的数据总行数</summary>
    public int TotalRowCount { get; set; }
    public bool Truncated { get; set; }
}

/// <summary>
/// 需求评估 Excel 解析器接口 — 支持 .xls（BIFF 二进制）与 .xlsx（OpenXml）。
/// 现有 FileContentExtractor 走 OpenXml，无法解析真 .xls，故独立实现，不影响其他消费方。
/// </summary>
public interface IRequirementExcelParser
{
    /// <summary>解析失败抛 InvalidDataException（消息可直接展示给用户）</summary>
    ParsedRequirementTable Parse(byte[] bytes, string fileName);
}

public class RequirementExcelParser : IRequirementExcelParser
{
    /// <summary>单次评估的需求行数上限（超出截断并提示）</summary>
    public const int MaxRows = 300;

    /// <summary>识别的最大列数（超出忽略）</summary>
    public const int MaxColumns = 50;

    private readonly ILogger<RequirementExcelParser> _logger;

    static RequirementExcelParser()
    {
        // ExcelDataReader 解析 .xls 依赖 CodePages 编码（GB2312 等），进程内注册一次
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public RequirementExcelParser(ILogger<RequirementExcelParser> logger)
    {
        _logger = logger;
    }

    public ParsedRequirementTable Parse(byte[] bytes, string fileName)
    {
        if (bytes.Length == 0)
            throw new InvalidDataException("文件内容为空");

        using var stream = new MemoryStream(bytes);
        IExcelDataReader reader;
        try
        {
            reader = ExcelReaderFactory.CreateReader(stream);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "需求表解析失败: {FileName}", fileName);
            throw new InvalidDataException("无法识别的 Excel 文件，请确认上传的是有效的 .xls 或 .xlsx 文件");
        }

        using (reader)
        {
            // 取第一个有数据的工作表
            do
            {
                var table = TryReadSheet(reader);
                if (table != null) return table;
            } while (reader.NextResult());
        }

        throw new InvalidDataException("Excel 中没有找到包含表头和数据的工作表");
    }

    private static ParsedRequirementTable? TryReadSheet(IExcelDataReader reader)
    {
        List<string>? headers = null;
        var rows = new List<List<string>>();
        int totalDataRows = 0;

        while (reader.Read())
        {
            var cells = ReadRowCells(reader);
            if (cells.All(string.IsNullOrWhiteSpace)) continue;

            if (headers == null)
            {
                // 第一个非空行且至少 2 个非空单元格 → 表头
                if (cells.Count(c => !string.IsNullOrWhiteSpace(c)) < 2) continue;
                headers = NormalizeHeaders(cells);
                continue;
            }

            totalDataRows++;
            if (rows.Count >= MaxRows) continue; // 只计数不再收集

            // 对齐表头列数
            var row = new List<string>(headers.Count);
            for (int i = 0; i < headers.Count; i++)
                row.Add(i < cells.Count ? cells[i] : string.Empty);
            rows.Add(row);
        }

        if (headers == null || rows.Count == 0) return null;

        return new ParsedRequirementTable
        {
            SheetName = reader.Name ?? string.Empty,
            Headers = headers,
            Rows = rows,
            TotalRowCount = totalDataRows,
            Truncated = totalDataRows > rows.Count,
        };
    }

    private static List<string> ReadRowCells(IExcelDataReader reader)
    {
        var count = Math.Min(reader.FieldCount, MaxColumns);
        var cells = new List<string>(count);
        for (int i = 0; i < count; i++)
            cells.Add(FormatCell(reader.GetValue(i)));
        // 去掉行尾连续空列
        while (cells.Count > 0 && string.IsNullOrWhiteSpace(cells[^1]))
            cells.RemoveAt(cells.Count - 1);
        return cells;
    }

    private static string FormatCell(object? value) => value switch
    {
        null => string.Empty,
        DateTime dt => dt.TimeOfDay == TimeSpan.Zero
            ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : dt.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture),
        double d => d == Math.Floor(d) && Math.Abs(d) < 1e15
            ? ((long)d).ToString(CultureInfo.InvariantCulture)
            : d.ToString(CultureInfo.InvariantCulture),
        bool b => b ? "是" : "否",
        _ => value.ToString()?.Trim() ?? string.Empty,
    };

    private static List<string> NormalizeHeaders(List<string> cells)
    {
        var headers = new List<string>(cells.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < cells.Count; i++)
        {
            var h = cells[i].Trim();
            if (string.IsNullOrEmpty(h)) h = $"列{i + 1}";

            // 表头会作为 Mongo 文档字典 key 存储，'.' 与 '$' 不允许出现
            h = h.Replace('.', '_').Replace('$', '_');

            // 重复表头加序号后缀，避免字典 key 冲突互相覆盖
            var unique = h;
            var n = 2;
            while (!seen.Add(unique)) unique = $"{h}_{n++}";
            headers.Add(unique);
        }
        return headers;
    }
}
