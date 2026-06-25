using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services.FileConvertAgent;

/// <summary>
/// 批量文件转换后台执行器
/// 轮询 file_convert_tasks（status=queued），逐个处理，SSE 端点通过轮询 DB 获取进度
/// </summary>
public class FileConvertWorker : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly FileParserService _parser;
    private readonly TemplateRendererService _renderer;
    private readonly ILogger<FileConvertWorker> _logger;

    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    public FileConvertWorker(
        MongoDbContext db,
        IAssetStorage storage,
        FileParserService parser,
        TemplateRendererService renderer,
        ILogger<FileConvertWorker> logger)
    {
        _db = db;
        _storage = storage;
        _parser = parser;
        _renderer = renderer;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var task = await ClaimQueuedTaskAsync(stoppingToken);
                if (task != null)
                {
                    _logger.LogInformation("[FileConvert] 开始处理任务 {TaskId}", task.Id);
                    try
                    {
                        await ProcessTaskAsync(task);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "[FileConvert] 任务处理失败 {TaskId}", task.Id);
                        await MarkErrorAsync(task.Id, ex.Message);
                    }
                    continue;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[FileConvert] Worker 轮询异常");
            }

            try
            {
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task<FileConvertTask?> ClaimQueuedTaskAsync(CancellationToken ct)
    {
        var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Status, FileConvertTaskStatus.Queued);
        var update = Builders<FileConvertTask>.Update
            .Set(t => t.Status, FileConvertTaskStatus.Running)
            .Set(t => t.UpdatedAt, DateTime.UtcNow);
        var opts = new FindOneAndUpdateOptions<FileConvertTask> { ReturnDocument = ReturnDocument.After };
        return await _db.FileConvertTasks.FindOneAndUpdateAsync(filter, update, opts, cancellationToken: CancellationToken.None);
    }

    private async Task ProcessTaskAsync(FileConvertTask task)
    {
        try
        {
            await AppendLogAsync(task.Id, "正在下载源文件...");
            var sourceBytes = await _storage.TryDownloadBytesAsync(task.SourceFileKey, CancellationToken.None);
            if (sourceBytes == null) { await MarkErrorAsync(task.Id, "源文件下载失败，请重新上传"); return; }

            await AppendLogAsync(task.Id, "正在解析源文件...");
            var parseResult = await _parser.ParseAsync(sourceBytes, task.SourceFileName);
            if (!string.IsNullOrEmpty(parseResult.Error)) { await MarkErrorAsync(task.Id, parseResult.Error); return; }
            if (parseResult.Rows.Count == 0) { await MarkErrorAsync(task.Id, "源文件没有数据行"); return; }

            var totalRows = parseResult.Rows.Count;
            await UpdateTotalRowsAsync(task.Id, totalRows);
            await AppendLogAsync(task.Id, $"共 {totalRows} 行，开始生成...");

            byte[] resultBytes;
            string resultFileName;

            if (task.OutputMode == FileConvertOutputMode.Expression)
            {
                // 无模板模式：直接输出 CSV / TXT
                await AppendLogAsync(task.Id, "表达式模式：直接生成输出文件...");
                var (csvBytes, csvName) = BuildExpressionOutput(parseResult.Rows, task.OutputColumns, task.SourceFileName);
                resultBytes = csvBytes;
                resultFileName = csvName;
                await UpdateProgressAsync(task.Id, totalRows, $"已处理 {totalRows} 行");
            }
            else
            {
                // 模板模式：批量渲染 Word/Excel
                if (string.IsNullOrEmpty(task.TemplateFileKey))
                { await MarkErrorAsync(task.Id, "模板模式下模板文件不能为空"); return; }

                var templateBytes = await _storage.TryDownloadBytesAsync(task.TemplateFileKey, CancellationToken.None);
                if (templateBytes == null) { await MarkErrorAsync(task.Id, "模板文件下载失败，请重新上传"); return; }

                var progress = new Progress<int>(async processed =>
                {
                    try { await UpdateProgressAsync(task.Id, processed, $"已生成 {processed}/{totalRows} 个文件"); }
                    catch { /* ignore */ }
                });

                var renderResult = await _renderer.RenderAllAsync(
                    templateBytes, task.TemplateFileName ?? "template", parseResult.Rows, task.FieldMappings, progress);

                if (!string.IsNullOrEmpty(renderResult.Error)) { await MarkErrorAsync(task.Id, renderResult.Error); return; }
                resultBytes = renderResult.ZipBytes!;
                resultFileName = $"result_{task.Id}.zip";

                await DeleteTempFileAsync(task.TemplateFileKey, "模板文件");
            }

            await AppendLogAsync(task.Id, "正在上传结果...");
            var ext = Path.GetExtension(resultFileName).TrimStart('.').ToLowerInvariant();
            var mime = ext == "zip" ? "application/zip" : ext == "csv" ? "text/csv" : "text/plain";
            var resultKey = $"file-convert/output/{task.Id}/{resultFileName}";
            await _storage.UploadToKeyAsync(resultKey, resultBytes, mime, CancellationToken.None);

            var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Id, task.Id);
            var update = Builders<FileConvertTask>.Update
                .Set(t => t.Status, FileConvertTaskStatus.Done)
                .Set(t => t.ResultZipKey, resultKey)
                .Set(t => t.ProcessedRows, totalRows)
                .Set(t => t.UpdatedAt, DateTime.UtcNow)
                .Push(t => t.ProgressLogs, $"完成！{totalRows} 行已处理");

            await _db.FileConvertTasks.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
            _logger.LogInformation("[FileConvert] 任务完成 {TaskId}", task.Id);
        }
        finally
        {
            await DeleteTempFileAsync(task.SourceFileKey, "源文件");
        }
    }

    /// <summary>expression 模式：将所有行按列表达式输出为 CSV</summary>
    private static (byte[] Bytes, string FileName) BuildExpressionOutput(
        List<Dictionary<string, string>> rows,
        List<FileConvertOutputColumn> columns,
        string sourceFileName)
    {
        var sb = new System.Text.StringBuilder();
        // 表头
        if (columns.Any(c => !string.IsNullOrWhiteSpace(c.Header)))
            sb.AppendLine(string.Join(",", columns.Select(c => QuoteCsv(c.Header))));

        foreach (var row in rows)
        {
            var vals = columns.Select(c => QuoteCsv(EvaluateExpression(c.ValueExpression, row)));
            sb.AppendLine(string.Join(",", vals));
        }

        // UTF-8 with BOM，Excel 打开 CSV 不乱码
        var bytes = System.Text.Encoding.UTF8.GetPreamble()
            .Concat(System.Text.Encoding.UTF8.GetBytes(sb.ToString()))
            .ToArray();
        var baseName = Path.GetFileNameWithoutExtension(sourceFileName);
        return (bytes, $"{baseName}_output.csv");
    }

    private static string QuoteCsv(string v)
    {
        if (v.Contains(',') || v.Contains('"') || v.Contains('\n'))
            return "\"" + v.Replace("\"", "\"\"") + "\"";
        return v;
    }

    private static readonly System.Text.RegularExpressions.Regex ExprColRef =
        new(@"\{([^{}]+)\}", System.Text.RegularExpressions.RegexOptions.Compiled);

    private static string EvaluateExpression(string expr, Dictionary<string, string> row)
    {
        if (string.IsNullOrWhiteSpace(expr)) return string.Empty;
        return ExprColRef.Replace(expr, m =>
        {
            var parts = m.Groups[1].Value.Split('|');
            var col = parts[0].Trim();
            if (!row.TryGetValue(col, out var raw)) return m.Value;
            var cur = raw;
            for (var i = 1; i < parts.Length; i++) cur = ApplyPipeStatic(cur, parts[i].Trim());
            return cur;
        });
    }

    private static string ApplyPipeStatic(string v, string pipe)
    {
        if (pipe.Equals("url_last", StringComparison.OrdinalIgnoreCase))
            return v.TrimEnd('/').Split('/').Last().Trim();
        if (pipe.Equals("trim", StringComparison.OrdinalIgnoreCase)) return v.Trim();
        if (pipe.Equals("upper", StringComparison.OrdinalIgnoreCase)) return v.ToUpperInvariant();
        if (pipe.Equals("lower", StringComparison.OrdinalIgnoreCase)) return v.ToLowerInvariant();
        if (pipe.StartsWith("regex:", StringComparison.OrdinalIgnoreCase))
        {
            var pat = pipe["regex:".Length..].Trim();
            try { var mm = System.Text.RegularExpressions.Regex.Match(v, pat); if (mm.Success) return mm.Groups.Count > 1 ? mm.Groups[1].Value : mm.Value; } catch { }
        }
        if (pipe.StartsWith("split:", StringComparison.OrdinalIgnoreCase))
        {
            var args = pipe["split:".Length..].Split(',', 2);
            if (args.Length == 2 && int.TryParse(args[1].Trim(), out var idx) && idx >= 1)
            { var ps = v.Split(args[0].Trim()); return idx <= ps.Length ? ps[idx - 1].Trim() : v; }
        }
        if (pipe.StartsWith("replace:", StringComparison.OrdinalIgnoreCase))
        { var args = pipe["replace:".Length..].Split(',', 2); if (args.Length == 2) return v.Replace(args[0].Trim(), args[1].Trim()); }
        return v;
    }

    private async Task DeleteTempFileAsync(string? key, string label)
    {
        if (string.IsNullOrWhiteSpace(key)) return;
        // 只删临时文件（file-convert/tmp/...），规则附带的永久模板不删
        if (!key.StartsWith("file-convert/tmp/", StringComparison.OrdinalIgnoreCase)) return;
        try
        {
            await _storage.DeleteByKeyAsync(key, CancellationToken.None);
            _logger.LogDebug("[FileConvert] 已清理临时{Label} key={Key}", label, key);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[FileConvert] 清理临时{Label}失败 key={Key}", label, key);
        }
    }

    private async Task AppendLogAsync(string taskId, string message)
    {
        var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Id, taskId);
        var update = Builders<FileConvertTask>.Update
            .Set(t => t.UpdatedAt, DateTime.UtcNow)
            .Push(t => t.ProgressLogs, message);
        await _db.FileConvertTasks.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
    }

    private async Task UpdateTotalRowsAsync(string taskId, int total)
    {
        var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Id, taskId);
        var update = Builders<FileConvertTask>.Update
            .Set(t => t.TotalRows, total)
            .Set(t => t.UpdatedAt, DateTime.UtcNow);
        await _db.FileConvertTasks.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
    }

    private async Task UpdateProgressAsync(string taskId, int processed, string message)
    {
        var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Id, taskId);
        var update = Builders<FileConvertTask>.Update
            .Set(t => t.ProcessedRows, processed)
            .Set(t => t.UpdatedAt, DateTime.UtcNow)
            .Push(t => t.ProgressLogs, message);
        await _db.FileConvertTasks.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
    }

    private async Task MarkErrorAsync(string taskId, string errorMessage)
    {
        var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Id, taskId);
        var update = Builders<FileConvertTask>.Update
            .Set(t => t.Status, FileConvertTaskStatus.Error)
            .Set(t => t.ErrorMessage, errorMessage)
            .Set(t => t.UpdatedAt, DateTime.UtcNow)
            .Push(t => t.ProgressLogs, $"失败：{errorMessage}");
        await _db.FileConvertTasks.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
    }
}
