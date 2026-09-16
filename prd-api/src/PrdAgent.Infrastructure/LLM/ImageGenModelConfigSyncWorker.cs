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
/// <summary>
/// 跑这个同步器的宿主「服务几个租户」。
///
/// 这不是可有可无的元信息，它决定了一条带租户的契约能不能进
/// <see cref="ImageGenModelAdapterRegistry"/>：那张表是**进程全局**的，键只有模型名，
/// 没有租户维度，而全链路 20 来个调用点都是静态方法、拿不到请求的租户。
/// 所以在一个会服务多个租户的宿主里，任何带租户的契约一旦装进去，就会作用到
/// **所有**租户的请求上——A 租户配的 `nano-banana*` 改写 B 租户的出图尺寸，
/// 而 B 自己配的那份反而不生效，两边都没有任何提示
/// （cross-project-isolation：一份全局状态被多方共享）。
/// </summary>
public enum ImageGenContractHostTenancy
{
    /// <summary>
    /// 宿主只服务一个固定租户（prd-api）。该租户的契约可以安全地装进进程全局表。
    /// </summary>
    SingleTenant,

    /// <summary>
    /// 宿主按请求携带的服务密钥判定租户，可能同时服务多个租户（llmgw-serving）。
    /// 只装平台级契约（TenantId 为空串），带租户的一律跳过并留痕。
    /// </summary>
    MultiTenant,
}

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

    /// <summary>
    /// 这个宿主服务几个租户。见 <see cref="ImageGenContractHostTenancy"/>。
    ///
    /// 同样做成必填构造参数：新增第四个宿主时**不表态就编译不过**。
    /// 给个默认值再靠守卫抽查，等于默许下一个宿主悄悄把别人的契约装进全局表
    /// （external-cause-first 第四节：调用点一律必须表态）。
    /// </summary>
    private readonly ImageGenContractHostTenancy _tenancy;

    public ImageGenModelConfigSyncWorker(
        ILogger<ImageGenModelConfigSyncWorker> logger,
        IConfiguration configuration,
        string hostRole,
        ImageGenContractHostTenancy tenancy,
        LlmGatewayDataContext? gateway = null)
    {
        _logger = logger;
        _gateway = gateway;
        _tenancy = tenancy;
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
        // 平台级契约（TenantId 为空串）对所有租户生效，哪个宿主都能装。
        // 带租户的那些只有单租户宿主能装——多租户宿主装进去就会作用到别的租户，
        // 见 ImageGenContractHostTenancy 的注释。
        var fb = Builders<GatewayImageModelConfig>.Filter;
        var tenantScopeFilter = _tenancy == ImageGenContractHostTenancy.SingleTenant
            ? fb.Or(fb.Eq(x => x.TenantId, _tenantId), fb.Eq(x => x.TenantId, string.Empty))
            : fb.Eq(x => x.TenantId, string.Empty);
        var docs = await collection
            .Find(fb.And(fb.Eq(x => x.Enabled, true), tenantScopeFilter))
            .ToListAsync(ct);

        // 多租户宿主跳过了多少条带租户的契约。这个数字必须一路报到控制台那一屏：
        // 不报的话，人在控制台配了 3 条、这边一条都没装，界面只会显示「生效 0 条」，
        // 而「为什么是 0」无处可查——降级被沉默吞掉（degradation-must-alarm）。
        var skippedTenantScoped = 0;
        var skippedByTenant = new Dictionary<string, int>(StringComparer.Ordinal);
        if (_tenancy == ImageGenContractHostTenancy.MultiTenant)
        {
            var skippedDocs = await collection
                .Find(fb.And(fb.Eq(x => x.Enabled, true), fb.Ne(x => x.TenantId, string.Empty)))
                .ToListAsync(ct);
            skippedTenantScoped = skippedDocs.Count;
            // 逐个租户记一份：跳过的条数是**那个租户**要看的数字，合成一个总数它看不懂
            // （「跳过了 7 条」里有几条是我的？）。写回时一租户一行，见下面那段。
            foreach (var group in skippedDocs.GroupBy(x => x.TenantId.Trim(), StringComparer.Ordinal))
            {
                if (group.Key.Length == 0) continue;
                skippedByTenant[group.Key] = group.Count();
            }
        }

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

        if (skippedTenantScoped > 0)
        {
            _logger.LogWarning(
                "[ImageGenConfigSync] {Host} 按请求密钥判定租户、可能同时服务多个租户，" +
                "因此跳过了 {Skipped} 条带租户的生图契约：这张表是进程全局的、没有租户维度，" +
                "装进去会让一个租户配的尺寸与参数改写另一个租户的请求。" +
                "这些契约在这个进程里不生效，走网关的生图请求用代码内置那 {Builtin} 条。",
                _hostRole, skippedTenantScoped, ImageGenModelConfigs.Configs.Count);
        }

        // 把「我这一轮拉到了什么」写回库，让控制台能如实回答「我配的那条生效了没有」。
        //
        // 没有这一步，界面只能说「最长 60 秒生效」然后让人盯着屏幕猜——而猜错的代价是
        // 去查一个根本没坏的东西。同步状态回写之后，那一屏能说的是「服务端 09:41 同步过，
        // 认到 5 条」，这是一句可核对的话（expectation-management：别让用户白等一场）。
        // 一进程一租户一行。合并任一维度都会出现「后写的盖掉先写的」：
        // 合并租户 → 别的租户看到错的同步时间；合并进程 → 健康的那个盖掉失败的那个，
        // 而走失败那个进程的请求还在用旧契约（见 _hostRole 的注释）。
        // 这一轮装进去的**内容**是哪一版。
        //
        // 只报模式名回答不了「我刚改的那条生效了没有」：改一条契约的尺寸档位，模式名一个字都不变，
        // 于是控制台拿模式名比对，改之前改之后都判「已生效」——它其实只证明了「这个模式有人认」，
        // 没证明「认的是我刚存的那一版」（形状 1：判据比它该管的范围窄）。
        // 条数 + 最新一次修改时间就够：控制台手上有同一批行，能算出同一个值来比。
        var contentVersion = ordered.Count == 0
            ? "0:0"
            : $"{ordered.Count}:{docs.Where(x => !string.IsNullOrWhiteSpace(x.ModelIdPattern)).Max(x => x.UpdatedAt).Ticks}";

        var statusCollection = _gateway!.Database.GetCollection<BsonDocument>("llmgw_imagegen_sync_status");

        BsonDocument BuildStatus(string tenantId, int skippedForTenant) => new()
        {
            { "_id", $"{_hostRole}::{tenantId}" },
            { "TenantId", tenantId },
            { "HostRole", _hostRole },
            { "SyncedAt", DateTime.UtcNow },
            { "OverrideCount", ordered.Count },
            { "BuiltinCount", ImageGenModelConfigs.Configs.Count },
            // 这个宿主服务几个租户，以及因此跳过了几条。控制台据此回答
            // 「我配的那条为什么在网关那一侧没生效」。
            { "HostTenancy", _tenancy.ToString() },
            { "SkippedTenantScopedCount", skippedForTenant },
            { "ContentVersion", contentVersion },
            // 生效的那几个模式，逐条列出来。只报数字的话，「我配了 3 条它说 3 条」
            // 仍然答不出「生效的是不是我刚改的那条」。
            { "Patterns", new BsonArray(ordered.Select(x => x.ModelIdPattern)) },
        };

        async Task WriteStatusAsync(string tenantId, int skippedForTenant)
        {
            var doc = BuildStatus(tenantId, skippedForTenant);
            await statusCollection.ReplaceOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", doc["_id"]),
                doc,
                new ReplaceOptions { IsUpsert = true },
                ct);
        }

        // 宿主自己那一行（单租户宿主就只有这一行）。
        await WriteStatusAsync(_tenantId, skippedTenantScoped);

        /*
          多租户宿主还要**逐个租户**各写一行。

          不写的话，这套「告诉人为什么没生效」的东西恰好漏掉了唯一需要它的那批人：
          状态行的 _id 是 `{宿主}::{租户}`，而控制台按登录租户去查。多租户宿主只写自己
          内部租户那一行，于是每个外部租户查到的是「没有记录」，界面据此说「同步从未发生、
          这个进程可能挂了」——一个正常运转、只是刻意跳过了他那几条契约的进程，
          被报成疑似宕机。真原因（跳过了你的 N 条，因为这张表是进程全局的）就写在那一行里，
          只是写到了他看不见的地方（degradation-must-alarm：降级要响铃，而且要响给当事人听）。

          跳过条数按租户各算各的：合成一个总数，外部租户读到「跳过 7 条」也答不出
          「其中几条是我的」。

          已经有行的租户即使这一轮一条契约都不剩也要刷一次，否则它停在上一轮的数字上
          不动，变成一条越来越旧的假话。
        */
        if (_tenancy == ImageGenContractHostTenancy.MultiTenant)
        {
            var knownTenantIds = (await statusCollection
                    .Find(Builders<BsonDocument>.Filter.Eq("HostRole", _hostRole))
                    .Project(Builders<BsonDocument>.Projection.Include("TenantId"))
                    .ToListAsync(ct))
                .Select(x => x.GetValue("TenantId", BsonNull.Value) is { IsString: true } v ? v.AsString : string.Empty)
                .Where(x => x.Length > 0);

            foreach (var tenantId in skippedByTenant.Keys
                         .Concat(knownTenantIds)
                         .Distinct(StringComparer.Ordinal)
                         .Where(x => !string.Equals(x, _tenantId, StringComparison.Ordinal))
                         .ToList())
            {
                await WriteStatusAsync(tenantId, skippedByTenant.GetValueOrDefault(tenantId, 0));
            }
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
