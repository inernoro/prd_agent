using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LLM;

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

    /// <summary>
    /// 这个 prd-api 实例服务的租户。
    ///
    /// 为什么必须有它：<see cref="ImageGenModelAdapterRegistry"/> 是**进程全局**的一张表，
    /// 键只有模型名。不按租户过滤就拉全表的话，A 租户配的 `nano-banana*` 会盖掉 B 租户的同名配置，
    /// 而谁赢只取决于排序——一个租户改配置，另一个租户的生图尺寸就变了，没有任何提示
    /// （cross-project-isolation：一份全局状态被多方共享）。
    ///
    /// 口径与 ModelResolver 的 CurrentTenantId 兜底同源（`LlmGateway:InternalTenantId`）：
    /// 那边按请求取租户，这边是后台 Worker、没有请求上下文，能取的就是这个实例的归属。
    /// </summary>
    private readonly string _tenantId;

    /// <summary>
    /// 跑这个 Worker 的进程是谁（`prd-api` / `llmgw-serving`）。
    ///
    /// 必填，没有默认值：两个进程各自有一份进程全局的注册表，同步状态就必须分行记。
    /// 合成一行的后果是「健康的那个不断覆盖失败的那个」——一个进程同步不上（读不到库、
    /// 注册表还是旧的），另一个照常写，控制台读到的是那条新鲜记录，报「刚同步过、N 条生效」，
    /// 而走失败那个进程的请求仍在用旧契约。降级被另一半的成功盖住，没有任何地方会响
    /// （degradation-must-alarm：有降级的地方必须有铃，而这里的铃被按掉了）。
    ///
    /// 做成必填构造参数而不是可选项：新增第三个宿主时**不传就编译不过**，
    /// 比留个默认值再靠守卫抽查可靠。
    /// </summary>
    private readonly string _hostRole;

    public ImageGenModelConfigSyncWorker(
        ILogger<ImageGenModelConfigSyncWorker> logger,
        IConfiguration configuration,
        string hostRole,
        LlmGatewayDataContext? gateway = null)
    {
        _logger = logger;
        _gateway = gateway;
        _hostRole = string.IsNullOrWhiteSpace(hostRole)
            ? throw new ArgumentException("必须说清是哪个进程在跑这个同步器，否则两边的状态会互相覆盖", nameof(hostRole))
            : hostRole.Trim();
        _tenantId = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenantId
            ? tenantId
            : GatewayTenantDefaults.InternalTenantId;
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
        // 只认这个实例服务的租户 + 平台内置（TenantId 为空串，对所有租户生效）。
        // 拉全表会让别的租户的配置进这张进程全局表，见 _tenantId 的注释。
        var fb = Builders<GatewayImageModelConfig>.Filter;
        var docs = await collection
            .Find(fb.And(
                fb.Eq(x => x.Enabled, true),
                fb.Or(fb.Eq(x => x.TenantId, _tenantId), fb.Eq(x => x.TenantId, string.Empty))))
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

        // 把「我这一轮拉到了什么」写回库，让控制台能如实回答「我配的那条生效了没有」。
        //
        // 没有这一步，界面只能说「最长 60 秒生效」然后让人盯着屏幕猜——而猜错的代价是
        // 去查一个根本没坏的东西。同步状态回写之后，那一屏能说的是「服务端 09:41 同步过，
        // 认到 5 条」，这是一句可核对的话（expectation-management：别让用户白等一场）。
        // 一进程一租户一行。合并任一维度都会出现「后写的盖掉先写的」：
        // 合并租户 → 别的租户看到错的同步时间；合并进程 → 健康的那个盖掉失败的那个，
        // 而走失败那个进程的请求还在用旧契约（见 _hostRole 的注释）。
        var statusId = $"{_hostRole}::{_tenantId}";
        await _gateway!.Database.GetCollection<BsonDocument>("llmgw_imagegen_sync_status").ReplaceOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", statusId),
            new BsonDocument
            {
                { "_id", statusId },
                { "TenantId", _tenantId },
                { "HostRole", _hostRole },
                { "SyncedAt", DateTime.UtcNow },
                { "OverrideCount", ordered.Count },
                { "BuiltinCount", ImageGenModelConfigs.Configs.Count },
                // 生效的那几个模式，逐条列出来。只报数字的话，「我配了 3 条它说 3 条」
                // 仍然答不出「生效的是不是我刚改的那条」。
                { "Patterns", new BsonArray(ordered.Select(x => x.ModelIdPattern)) },
            },
            new ReplaceOptions { IsUpsert = true },
            ct);
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
