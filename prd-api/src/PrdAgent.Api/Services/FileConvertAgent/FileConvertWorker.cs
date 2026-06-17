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
        byte[]? sourceBytes = null;
        byte[]? templateBytes = null;

        try
        {
            await AppendLogAsync(task.Id, "正在下载源文件...");
            sourceBytes = await _storage.TryDownloadBytesAsync(task.SourceFileKey, CancellationToken.None);
            if (sourceBytes == null)
            {
                await MarkErrorAsync(task.Id, "源文件下载失败，请重新上传");
                return;
            }

            templateBytes = await _storage.TryDownloadBytesAsync(task.TemplateFileKey, CancellationToken.None);
            if (templateBytes == null)
            {
                await MarkErrorAsync(task.Id, "模板文件下载失败，请重新上传");
                return;
            }

            await AppendLogAsync(task.Id, "正在解析源文件...");
            var parseResult = await _parser.ParseAsync(sourceBytes, task.SourceFileName);
            if (!string.IsNullOrEmpty(parseResult.Error))
            {
                await MarkErrorAsync(task.Id, parseResult.Error);
                return;
            }

            if (parseResult.Rows.Count == 0)
            {
                await MarkErrorAsync(task.Id, "源文件没有数据行（表头之外无内容）");
                return;
            }

            var totalRows = parseResult.Rows.Count;
            await UpdateTotalRowsAsync(task.Id, totalRows);
            await AppendLogAsync(task.Id, $"共 {totalRows} 行数据，开始批量生成...");

            var progress = new Progress<int>(async processed =>
            {
                try { await UpdateProgressAsync(task.Id, processed, $"已生成 {processed}/{totalRows} 个文件"); }
                catch (Exception ex) { _logger.LogWarning(ex, "[FileConvert] 更新进度失败"); }
            });

            var renderResult = await _renderer.RenderAllAsync(
                templateBytes, task.TemplateFileName, parseResult.Rows, task.FieldMappings, progress);

            if (!string.IsNullOrEmpty(renderResult.Error))
            {
                await MarkErrorAsync(task.Id, renderResult.Error);
                return;
            }

            await AppendLogAsync(task.Id, "正在上传 ZIP 包...");
            var zipKey = $"file-convert/output/{task.Id}/result.zip";
            await _storage.UploadToKeyAsync(zipKey, renderResult.ZipBytes!, "application/zip", CancellationToken.None);

            var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Id, task.Id);
            var update = Builders<FileConvertTask>.Update
                .Set(t => t.Status, FileConvertTaskStatus.Done)
                .Set(t => t.ResultZipKey, zipKey)
                .Set(t => t.ProcessedRows, totalRows)
                .Set(t => t.UpdatedAt, DateTime.UtcNow)
                .Push(t => t.ProgressLogs, $"完成！共生成 {totalRows} 个文件");

            await _db.FileConvertTasks.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
            _logger.LogInformation("[FileConvert] 任务完成 {TaskId}，共 {Total} 个文件", task.Id, totalRows);
        }
        finally
        {
            // 无论成功或失败，均删除源文件和模板临时文件，避免资源占用
            await DeleteTempFileAsync(task.SourceFileKey, "源文件");
            await DeleteTempFileAsync(task.TemplateFileKey, "模板文件");
        }
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
