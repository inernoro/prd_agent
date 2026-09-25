using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 启动后跑一次关键索引巡检（只查不建，见 <see cref="MongoIndexAdvisory"/>）。
///
/// 放在后台跑而不是写在 Program 里 await：巡检要连 Mongo，连不上或慢的时候不能拖住
/// 应用就绪。结论写进日志，并留给 /health/ready 作为只读附加字段——不参与健康判定。
/// </summary>
public sealed class MongoIndexAdvisoryStartupCheck : BackgroundService
{
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(30);

    private readonly MongoDbContext _db;
    private readonly MongoIndexAdvisory _advisory;
    private readonly ILogger<MongoIndexAdvisoryStartupCheck> _logger;

    public MongoIndexAdvisoryStartupCheck(
        MongoDbContext db,
        MongoIndexAdvisory advisory,
        ILogger<MongoIndexAdvisoryStartupCheck> logger)
    {
        _db = db;
        _advisory = advisory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 让出启动线程：BackgroundService 在第一次 await 之前是同步执行的。
        await Task.Yield();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        timeout.CancelAfter(CheckTimeout);
        try
        {
            await _advisory.CheckAsync(_db.Database, _logger, timeout.Token);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // 进程正在停止，没有必要再报。
        }
        catch (Exception ex)
        {
            // 走到这里只可能是整轮超时或意料之外的错误；单个集合的失败已在巡检内部记下。
            _logger.LogWarning(
                "关键 MongoDB 索引巡检没有跑完，这些索引是否存在现在是未知的；API 启动不受影响，"
                + "请按 {GuidePath} 手动核对。技术细节：{ExceptionType}: {ExceptionMessage}",
                RequiredMongoIndexCatalog.GuidePath,
                ex.GetType().Name,
                ex.Message);
        }
    }
}
