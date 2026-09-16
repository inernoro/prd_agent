using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Api.Services;

/// <summary>
/// 把控制台里配的生图模型契约（<c>llmgw_imagegen_model_configs</c>）刷进
/// <see cref="ImageGenModelAdapterRegistry"/> 的覆盖表。
///
/// 存在的理由：上游每出一个新生图模型，此前都要改 `ImageGenModelConfigs.cs` 那 777 行、
/// 重新编译、走一次发布。有了这个刷新器，新模型的尺寸档位与参数契约在控制台填一次就生效，
/// **最长 60 秒**，不用发布。
///
/// 为什么是轮询而不是推送：写方是 llmgw console-api，读方是 prd-api，两个进程；
/// 跨进程推送要引一套消息通道，而这份配置的改动频率是「上游出新模型时」——按天算。
/// 花一条消息通道去把 60 秒压到 1 秒，不划算。**代价要说出口**：控制台那一屏写明
/// 「保存后最长 60 秒生效」，而不是让人保存完盯着屏幕猜（expectation-management）。
///
/// 失败不阻断：拉不到就保留上一版快照并记一条日志。配置面故障不许扩大到数据面
/// （llm-gateway 规则 7）——生图请求照常按代码内置那 26 条跑。
/// </summary>
public sealed class ImageGenModelConfigSyncWorker : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(60);

    private readonly LlmGatewayDataContext? _gateway;
    private readonly ILogger<ImageGenModelConfigSyncWorker> _logger;

    public ImageGenModelConfigSyncWorker(
        ILogger<ImageGenModelConfigSyncWorker> logger,
        LlmGatewayDataContext? gateway = null)
    {
        _logger = logger;
        _gateway = gateway;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_gateway is null)
        {
            _logger.LogInformation(
                "[ImageGenConfigSync] 没有网关库连接，生图契约只用代码内置的 {Count} 条；" +
                "控制台里配的那份不会生效。",
                ImageGenModelConfigs.Configs.Count);
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RefreshAsync(stoppingToken);
                await PublishBuiltinCatalogOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // 拉不到就保留上一版快照。这里不清空——清空会让「控制台配过的契约」在一次
                // 网络抖动后悄悄消失，生图尺寸突然变回旧档位，而没有任何人收到消息。
                _logger.LogWarning(
                    ex,
                    "[ImageGenConfigSync] 这一轮没拉到生图契约，沿用上一版 {Count} 条覆盖；下一轮继续。",
                    ImageGenModelAdapterRegistry.OverrideCount);
            }

            try
            {
                await Task.Delay(Interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task RefreshAsync(CancellationToken ct)
    {
        var collection = _gateway!.Database.GetCollection<GatewayImageModelConfig>("llmgw_imagegen_model_configs");
        var docs = await collection
            .Find(Builders<GatewayImageModelConfig>.Filter.Eq(x => x.Enabled, true))
            .ToListAsync(ct);

        // 排序就是「哪条先匹配」的判据，必须在这里定死一次，而不是指望写入顺序：
        // 数据行没有「书写顺序」，而代码内置那张表靠的正是书写顺序。
        // MatchOrder 小的先来；同序时模式长的先来——长的更具体，
        // 这样忘了设 MatchOrder 的两行也不会随机胜出（形状 1：判据比它该管的范围窄）。
        var ordered = docs
            .Where(x => !string.IsNullOrWhiteSpace(x.ModelIdPattern))
            .OrderBy(x => x.MatchOrder)
            .ThenByDescending(x => x.ModelIdPattern.Trim().Length)
            .ThenBy(x => x.ModelIdPattern, StringComparer.Ordinal)
            .Select(ImageGenConfigTranslation.ToAdapterConfig)
            .ToList();

        var before = ImageGenModelAdapterRegistry.OverrideCount;
        ImageGenModelAdapterRegistry.ReplaceOverrides(ordered);

        if (before != ordered.Count)
        {
            _logger.LogInformation(
                "[ImageGenConfigSync] 生图契约覆盖表 {Before} 条 → {After} 条（代码内置 {Builtin} 条兜底）。",
                before, ordered.Count, ImageGenModelConfigs.Configs.Count);
        }
    }

    private bool _builtinPublished;

    /// <summary>
    /// 把代码内置的那份契约发布进 <c>llmgw_imagegen_builtin_catalog</c>，一个进程周期发一次。
    ///
    /// 为什么要发布：控制台（llmgw console-api）架构上不引用 PrdAgent.*，看不到那张表。
    /// 它需要回答两件事——「这个模型是不是已经有内置契约了」（否则人会重复配一份）、
    /// 「照着内置那条改一份」（比从零填二十个字段现实得多）。
    ///
    /// 为什么不让控制台手抄一份：本轮第一版就是手抄的，抄成了 26 条、内容还对不上真表的 19 条。
    /// 手抄的清单正是 `no-rootless-tree` 说的那种「看起来有根、根是个硬编码快照」——
    /// 代码改了它不会跟着改，而且不会有任何东西变红。发布出去就没有第二份可抄了。
    /// </summary>
    private async Task PublishBuiltinCatalogOnceAsync(CancellationToken ct)
    {
        if (_builtinPublished) return;

        var catalog = _gateway!.Database.GetCollection<BsonDocument>("llmgw_imagegen_builtin_catalog");
        var items = new BsonArray(ImageGenModelConfigs.Configs.Select(ImageGenConfigTranslation.BuiltinToBson));
        await catalog.ReplaceOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", "builtin"),
            new BsonDocument
            {
                { "_id", "builtin" },
                { "PublishedAt", DateTime.UtcNow },
                { "Count", ImageGenModelConfigs.Configs.Count },
                { "Items", items },
            },
            new ReplaceOptions { IsUpsert = true },
            ct);

        _builtinPublished = true;
        _logger.LogInformation(
            "[ImageGenConfigSync] 已发布代码内置生图契约 {Count} 条到 llmgw_imagegen_builtin_catalog，控制台据此显示与预填。",
            ImageGenModelConfigs.Configs.Count);
    }

}
