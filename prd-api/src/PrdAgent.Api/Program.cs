using System.IdentityModel.Tokens.Jwt;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Cryptography;
using MongoDB.Driver;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.Api.Services;
using PrdAgent.Api.Json;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Diagnostics;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Cache;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Markdown;
using Serilog.Sinks.SystemConsole.Themes;
using PrdAgent.Infrastructure.Prompts;
using PrdAgent.Infrastructure.Repositories;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.Helpers;
using PrdAgent.Infrastructure.Security;
using Serilog;
using Serilog.Events;
using Microsoft.Extensions.Configuration;

var builder = WebApplication.CreateBuilder(args);

// MongoDB BSON 映射注册：
// - 线上遇到过旧数据/旧镜像导致 _id 反序列化失败（Element '_id' does not match...）
// - 这里显式注册一次，避免依赖 MongoDbContext 构造顺序
BsonClassMapRegistration.Register();

// 配置Serilog - Pretty格式输出
var serilogCfg = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    // 压低框架噪音（你关心的是业务请求是否到达与返回摘要）
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .MinimumLevel.Override("System", LogEventLevel.Warning)
    // 关闭 Controller 的信息日志（你只想看请求 finished，不想看控制器内部 LogInformation）
    .MinimumLevel.Override("PrdAgent.Api.Controllers", LogEventLevel.Warning)
    // 说明：不启用 Microsoft.AspNetCore.Hosting.Diagnostics（它会打 Request starting/finished 两次且包含 OPTIONS）。
    // 我们用自定义中间件只打一条"Request finished ..."风格日志，更清爽、可控。
    // 过滤掉 "AuthenticationScheme: XXX was not authenticated" 噪音日志
    .Filter.ByExcluding(e => e.MessageTemplate.Text.Contains("was not authenticated"))
    .Enrich.FromLogContext()
    .WriteTo.File(
        "logs/prdagent-.log",
        rollingInterval: RollingInterval.Day,
        // 历史模板（无用户前缀）：
        // "[{Timestamp:yyyy-MM-dd HH:mm:ss.fff} {Level:u3}] {SourceContext}{NewLine}{Message:lj}{NewLine}{Exception}"
        outputTemplate: "[{Timestamp:yyyy-MM-dd HH:mm:ss.fff} {Level:u3}] {User}{SourceContext}{NewLine}{Message:lj}{NewLine}{Exception}");

// 避免控制台重复输出：如果配置里已经有 Serilog:WriteTo=Console，就不再在代码里额外加 Console sink
var hasConsoleSinkInConfig = builder.Configuration
    .GetSection("Serilog:WriteTo")
    .GetChildren()
    .Any(x => string.Equals((x["Name"] ?? "").Trim(), "Console", StringComparison.OrdinalIgnoreCase));

if (!hasConsoleSinkInConfig)
{
    serilogCfg.WriteTo.Console(
        // 历史模板（无用户前缀）： "[{Timestamp:HH:mm:ss}] {Message:lj}{NewLine}{Exception}"
        outputTemplate: "[{Timestamp:HH:mm:ss}] {User}{Message:lj}{NewLine}{Exception}",
        theme: Serilog.Sinks.SystemConsole.Themes.AnsiConsoleTheme.Code);
}

Log.Logger = serilogCfg.CreateLogger();

builder.Host.UseSerilog();

// 配置 JSON 序列化选项 (AOT 兼容)
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

// 添加服务
builder.Services.AddScoped<PrdAgent.Api.Filters.PmAuditActionFilter>();
builder.Services.AddControllers(options =>
    {
        // 团队动态：全局白名单审计（白名单外的动作一次字典查找即逃逸）
        options.Filters.Add<PrdAgent.Api.Filters.ActivityLogActionFilter>();
        // 模型管理退场：api/mds 下的写操作一律 410，配置改由 LLM Gateway 控制台承担。
        // 挂在 ActivityLog 之后：被挡下的请求本来就没发生写入，不该留一条动态。
        options.Filters.Add<PrdAgent.Api.Filters.MdsWriteRetiredFilter>();
        // 接入台配额：sk-ak 直连内置工具接口（绕开 /api/mcp）时套同一套闸门，
        // 否则「每日 50 张」只拦得住走网关的那条路。
        options.Filters.Add<PrdAgent.Api.Filters.AgentApiKeyUsageFilter>();
    })
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
        options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
        options.JsonSerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
    });

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new() { Title = "PRD Agent API", Version = "v1" });
    c.AddSecurityDefinition("Bearer", new()
    {
        Description = "JWT Authorization header using the Bearer scheme",
        Name = "Authorization",
        In = Microsoft.OpenApi.Models.ParameterLocation.Header,
        Type = Microsoft.OpenApi.Models.SecuritySchemeType.ApiKey,
        Scheme = "Bearer"
    });
    c.AddSecurityRequirement(new()
    {
        {
            new()
            {
                Reference = new() { Type = Microsoft.OpenApi.Models.ReferenceType.SecurityScheme, Id = "Bearer" }
            },
            Array.Empty<string>()
        }
    });
});

// 配置MongoDB
var mongoConnectionString = builder.Configuration["MongoDB:ConnectionString"] 
    ?? "mongodb://localhost:27017";
var mongoDatabaseName = builder.Configuration["MongoDB:DatabaseName"] ?? "prdagent";
var llmGatewayDatabaseName = builder.Configuration["LlmGateway:DatabaseName"] ?? "llm_gateway";
builder.Services.AddSingleton(new MongoDbContext(mongoConnectionString, mongoDatabaseName));
builder.Services.AddSingleton(new LlmGatewayDataContext(mongoConnectionString, llmGatewayDatabaseName));
builder.Services.AddSingleton<IWatermarkFontAssetSource, MongoWatermarkFontAssetSource>();
builder.Services.AddSingleton<ISystemRoleCacheService, PrdAgent.Infrastructure.Services.SystemRoleCacheService>();
builder.Services.AddSingleton<IAdminPermissionService, PrdAgent.Infrastructure.Services.AdminPermissionService>();
builder.Services.AddSingleton<IAdminControllerScanner, PrdAgent.Infrastructure.Services.AdminControllerScanner>();
builder.Services.AddSingleton<ISafeOutboundUrlValidator, PrdAgent.Infrastructure.Services.SafeOutboundUrlValidator>();
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory,
    PrdAgent.Infrastructure.Services.SafeOutboundHttpHandlerFactory>();
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.ISafeOutboundWebSocketConnector,
    PrdAgent.Infrastructure.Services.SafeOutboundWebSocketConnector>();
builder.Services.AddSingleton<PrdAgent.Api.Services.AdminPushDispatchSignal>();
builder.Services.AddScoped<PrdAgent.Api.Services.AdminPushNotificationService>();
builder.Services.AddScoped<PrdAgent.Api.Services.AdminNotificationEventService>();
// 首页槽位认领时把外部图片复制进我们自己的存储（供应商的临时/签名地址不能原样挂上首页）
builder.Services.AddScoped<PrdAgent.Api.Services.HomepageAssetCopier>();
builder.Services.AddHostedService<PrdAgent.Api.Services.AdminPushNotificationWorker>();
builder.Services.AddHostedService<PrdAgent.Api.Services.LlmGatewayIncidentWatchdog>();
// 生图模型契约的覆盖表刷新器：让「上游出了新生图模型」不再等于「改代码 + 发一次版」。
builder.Services.AddHostedService(sp => new PrdAgent.Infrastructure.LLM.ImageGenModelConfigSyncWorker(
    sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<PrdAgent.Infrastructure.LLM.ImageGenModelConfigSyncWorker>>(),
    sp.GetRequiredService<IConfiguration>(),
    hostRole: "prd-api",
    // MAP 这一侧只服务自己那个租户（LlmGateway:InternalTenantId），
    // 所以它配的契约可以安全地装进进程全局表。
    tenancy: PrdAgent.Infrastructure.LLM.ImageGenContractHostTenancy.SingleTenant,
    sp.GetService<PrdAgent.Infrastructure.Database.LlmGatewayDataContext>()));

// 系统级跨节点互传（Peer Sync）—— 详见 doc/design.platform.peer-sync.md
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IPeerNodeService,
    PrdAgent.Infrastructure.Services.PeerNodeService>();
builder.Services.AddScoped<PrdAgent.Core.Sync.ISyncableResource,
    PrdAgent.Infrastructure.Sync.Resources.DocumentStoreSyncResource>();
builder.Services.AddScoped<PrdAgent.Core.Sync.ISyncableResource,
    PrdAgent.Infrastructure.Sync.Resources.DefectSyncResource>();
builder.Services.AddScoped<PrdAgent.Core.Sync.ISyncResourceRegistry,
    PrdAgent.Infrastructure.Sync.SyncResourceRegistry>();
// 跨节点互传 per-item 核心（Controller 手动 transfer + 自动同步 worker 共用同一条路径，SSOT）。
builder.Services.AddScoped<PrdAgent.Api.Services.PeerSync.IPeerSyncTransferService,
    PrdAgent.Api.Services.PeerSync.PeerSyncTransferService>();
// 知识库后台自动同步 worker（双向同步从「点一次跑一次」变「定期保持一致」；防风暴见 PeerSyncScheduleWorker）。
builder.Services.AddHostedService<PrdAgent.Api.Services.PeerSync.PeerSyncScheduleWorker>();
// CDS 验收报告每小时自动同步（此前只有手动入口，于是镜像库长期是陈的）。
// 只在权威部署上跑：同项目所有分支预览共用一个库，多份同时写会互相打架。
builder.Services.AddHostedService<PrdAgent.Api.Services.CdsReportImportWorker>();

// 跨 MAP 实例数据同步（动态授权，一次授权跑一次；详见 doc/design.platform.cross-instance-data-sync.md）。
// Vault 必须是单例：导出令牌只活在内存里，换成 Scoped 就等于每个请求一个空保险箱。
builder.Services.AddSingleton<PrdAgent.Api.Services.DataSync.DataSyncTokenVault>();
builder.Services.AddHostedService<PrdAgent.Api.Services.DataSync.DataSyncRunWorker>();

// 双链 + 反向链接（详见 doc/design.knowledge-base.mention-network.md）
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.DocumentStore.MentionService>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.DocumentStore.DocumentVersionService>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.DocumentStore.IDocumentVersionSnapshotWriter>(sp =>
    sp.GetRequiredService<PrdAgent.Infrastructure.Services.DocumentStore.DocumentVersionService>());

// LLM 请求上下文与日志（旁路写入，便于后台调试）
builder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
builder.Services.AddSingleton<LlmRequestLogBackground>();
builder.Services.AddSingleton<ILlmRequestLogWriter, LlmRequestLogWriter>();
// BackgroundService 未捕获异常时不要拖垮整个 Host。单个 Worker 崩溃已有
// ILogger 记录，继续运行其它服务；默认 StopHost 会让 HttpClient 超时这类
// 瞬时故障变成全站宕机（已在 DocumentSyncWorker 上踩过一次）。
builder.Services.Configure<HostOptions>(options =>
{
    options.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore;
});

builder.Services.AddHostedService<LlmRequestLogWatchdog>();
builder.Services.AddHostedService<PrdAgent.Api.Middleware.ApiRequestLogWatchdog>();
builder.Services.AddHostedService<PrdAgent.Api.Middleware.AiScoreWatchdog>();
builder.Services.AddHostedService<PrdAgent.Api.Middleware.TranscriptRunWatchdog>();

// 应用设置服务（带缓存）
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IAppSettingsService, PrdAgent.Infrastructure.Services.AppSettingsService>();
// 更新中心：从仓库 changelogs/ 与 CHANGELOG.md 解析代码级周报
// 终身存储（changelog_snapshots）+ SSE 推送中枢：加载只读存量、后台固定周期刷新、有更新主动推送
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.Changelog.IChangelogSnapshotStore, PrdAgent.Infrastructure.Services.Changelog.ChangelogSnapshotStore>();
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.Changelog.IChangelogPushHub, PrdAgent.Infrastructure.Services.Changelog.ChangelogPushHub>();
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.Changelog.IChangelogReader, PrdAgent.Infrastructure.Services.Changelog.ChangelogReader>();
// 后台刷新 Worker：启动只读存量预热 + 固定周期（默认 4h）force 刷新，内容变化落库 + 推送
builder.Services.AddHostedService<PrdAgent.Infrastructure.Services.Changelog.ChangelogRefreshWorker>();
// 周报海报 AI 向导:读取数据源 + 调 LLM 生成结构化页面
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.Poster.IPosterAutopilotService, PrdAgent.Infrastructure.Services.Poster.PosterAutopilotService>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.ISystemPromptService, PrdAgent.Infrastructure.Services.SystemPromptService>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.ISkillService, PrdAgent.Infrastructure.Services.SkillService>();

// 模型用途选择（主模型/意图模型/图片识别/图片生成）
builder.Services.AddScoped<IModelDomainService, ModelDomainService>();

// 业务模型目录适配器：必须跟随下方活动 ILlmGateway 的 inproc/http/shadow 路由。
builder.Services.AddScoped<IModelPoolQueryService, ModelPoolQueryService>();

// 模型池故障通知与自动探活
builder.Services.AddScoped<PrdAgent.Infrastructure.ModelPool.IPoolFailoverNotifier, PrdAgent.Infrastructure.ModelPool.PoolFailoverNotifier>();
builder.Services.AddHostedService<PrdAgent.Infrastructure.ModelPool.ModelPoolHealthProbeService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.PlatformKeyIntegrityWorker>();

// 模型调度执行器
builder.Services.AddScoped<PrdAgent.Core.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.ModelCatalogContractProbe>();
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.GatewayProviderConcurrencyCoordinator>();

// LLM Gateway 统一守门员（所有大模型调用必须通过此接口）。
// 特性开关：LlmGateway:Mode（环境变量 LlmGateway__Mode）。生产必须显式配置；
// 非生产缺省 inproc，便于本地开发。生产回滚必须由 rollback 脚本显式设置 inproc，禁止漏配静默回退。
// http = 切到 HttpLlmGatewayClient，跨进程调用独立部署的 serving 服务（/gw/v1/*）。
// HttpLlmGatewayClient 同时实现 Infrastructure + Core 两个 ILlmGateway，下方 Core 桥接强转在两种模式下都成立。
// 影子比对落库（灰度翻 http 前积累一致性证据；shadow 模式下注入 ShadowLlmGateway）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ILlmShadowComparisonWriter>(sp =>
    new PrdAgent.Infrastructure.LlmGateway.LlmShadowComparisonWriter(
        sp.GetRequiredService<LlmGatewayDataContext>().Context,
        sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.LlmGateway.LlmShadowComparisonWriter>>()));

var configuredGatewayMode = builder.Configuration["LlmGateway:Mode"]?.Trim();
var gatewayMode = PrdAgent.Core.LlmGateway.LlmGatewayModePolicy.Resolve(
    configuredGatewayMode,
    builder.Environment.IsProduction());
// 灰度翻 http 白名单（按 appCallerCode 逐个切；`,`/`;`/换行分隔）。命中的入口走 http 权威，其余按 Mode。
var httpAllowlist = (builder.Configuration["LlmGateway:HttpAppCallerAllowlist"] ?? string.Empty)
    .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    .Where(x => !string.IsNullOrWhiteSpace(x))
    .ToHashSet(StringComparer.OrdinalIgnoreCase);
// 视频模型与 Provider 已迁到独立 LLMGW 配置域；继续走旧 MDS inproc 解析会在空池时
// 提交前失败，也会绕过控制台中已配置的 video-gen 默认池。
httpAllowlist.Add(AppCallerRegistry.VideoAgent.VideoGen.Generate);
httpAllowlist.Add(AppCallerRegistry.VisualAgent.VideoGen.Generate);
// HTML PPT 是 MAP 内置的模型型能力，不依赖 Agent 文件工具；其模型选择、成本和 runId
// 必须统一进入独立 LLMGW。这里像视频调用方一样设为代码级不变量，避免部署器
// 对 compose 环境的覆盖或遗漏让请求静默退回 MAP 进程内直连。
httpAllowlist.Add(AppCallerRegistry.MdToPptAgent.Generation.Outline);
httpAllowlist.Add(AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate);
// 网页生成与微调同样必须进入独立 LLMGW；不能因部署白名单遗漏而写回 MAP 旧日志域，
// 否则产物已经发布，按 Run 关联的网关证据却为空。
httpAllowlist.Add(AppCallerRegistry.Admin.WebHosting.GenerateHtml);
httpAllowlist.Add(AppCallerRegistry.Admin.WebHosting.EditHtml);
var shadowFullSampleAllowlist = (builder.Configuration["LlmGateway:ShadowFullSampleAppCallerAllowlist"] ?? string.Empty)
    .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    .Where(x => !string.IsNullOrWhiteSpace(x))
    .ToHashSet(StringComparer.OrdinalIgnoreCase);
var isShadow = string.Equals(gatewayMode, "shadow", StringComparison.OrdinalIgnoreCase);
// 逻辑模型属于独立 Gateway 配置域。默认即使 MAP 仍处于 inproc 迁移期，也装配统一路由器，
// 让显式逻辑模型请求由 ShadowLlmGateway 强制转交 llmgw-serve；普通旧模型仍保持 inproc。
// 紧急回滚可显式设置 false，但不得用旧模型池静默解释逻辑模型同名 key。
var logicalModelsRequireHttp = builder.Configuration.GetValue<bool?>("LlmGateway:LogicalModelsRequireHttp") ?? true;

// 显式逻辑模型不跟随 MAP 的全局 inproc/shadow 迁移开关：它始终使用独立 serving HTTP 边界。
// 注册同一个 Scoped 实例，保证一次请求的预解析与发送共享同一传输实现。
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.HttpLlmGatewayClient>();
builder.Services.AddScoped<PrdAgent.Api.Services.IVisualModelPolicyService, PrdAgent.Api.Services.VisualModelPolicyService>();
builder.Services.AddScoped<PrdAgent.Core.LlmGateway.ILogicalModelGateway>(sp =>
    sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.HttpLlmGatewayClient>());

if (string.Equals(gatewayMode, "http", StringComparison.OrdinalIgnoreCase))
{
    builder.Services.AddScoped<PrdAgent.Core.LlmGateway.ILlmGateway>(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.HttpLlmGatewayClient>());
}
else if (isShadow || httpAllowlist.Count > 0 || logicalModelsRequireHttp)
{
    // 统一路由器：白名单命中 → http 权威（灰度翻）；否则 inproc 权威。
    // shadow 模式下，对非白名单请求后台比对落 llmshadow_comparisons（默认只比解析=免费；
    // LlmGateway:ShadowFullSamplePercent>0 时对采样 send 做完整内容比对）。inproc+仅白名单时不比对（writer=null）。
    var shadowSamplePercent = int.TryParse(builder.Configuration["LlmGateway:ShadowFullSamplePercent"], out var sp0) ? sp0 : 0;
    builder.Services.AddScoped<PrdAgent.Core.LlmGateway.ILlmGateway>(sp =>
        new PrdAgent.Infrastructure.LlmGateway.ShadowLlmGateway(
            inproc: new PrdAgent.Infrastructure.LlmGateway.LlmGateway(
                sp.GetRequiredService<PrdAgent.Core.LlmGateway.IModelResolver>(),
                sp.GetRequiredService<IHttpClientFactory>(),
                sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.LlmGateway.LlmGateway>>(),
                sp.GetService<PrdAgent.Core.Interfaces.ILlmRequestLogWriter>(),
                sp.GetService<PrdAgent.Core.Interfaces.ILLMRequestContextAccessor>(),
                sp.GetService<PrdAgent.Infrastructure.ModelPool.IPoolFailoverNotifier>(),
                concurrencyCoordinator: sp.GetService<PrdAgent.Infrastructure.LlmGateway.GatewayProviderConcurrencyCoordinator>(),
                configuration: sp.GetRequiredService<IConfiguration>()),
            http: sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.HttpLlmGatewayClient>(),
            logger: sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.LlmGateway.ShadowLlmGateway>>(),
            writer: isShadow ? sp.GetService<PrdAgent.Core.Interfaces.ILlmShadowComparisonWriter>() : null,
            fullSamplePercent: shadowSamplePercent,
            ctx: sp.GetService<PrdAgent.Core.Interfaces.ILLMRequestContextAccessor>(),
            httpAllowlist: httpAllowlist,
            fullSampleAllowlist: shadowFullSampleAllowlist,
            releaseCommit: FirstEnv("GIT_COMMIT", "COMMIT_SHA", "GITHUB_SHA", "SOURCE_VERSION", "CDS_COMMIT_SHA"),
            configuration: sp.GetRequiredService<IConfiguration>()));
}
else
{
    builder.Services.AddScoped<PrdAgent.Core.LlmGateway.ILlmGateway, PrdAgent.Infrastructure.LlmGateway.LlmGateway>();
}

// 把同一个实例也暴露成 Core 层那个窄接口。宽接口已继承窄接口，这里是隐式向上转型；
// 此前写的是强制类型转换，接口一旦漂移只会在运行时炸，现在由编译期兜住。
builder.Services.AddScoped<PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway>(sp =>
    sp.GetRequiredService<PrdAgent.Core.LlmGateway.ILlmGateway>());

// OpenAI 兼容 Images API（用于"生图模型"）
builder.Services.AddScoped<OpenAIImageClient>();
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ImageGen.IImageGenerationClient>(sp =>
    sp.GetRequiredService<OpenAIImageClient>());
builder.Services.AddScoped<PrdAgent.Core.LlmGateway.ImageGen.IImageGenGateway,
    PrdAgent.Infrastructure.LlmGateway.ImageGen.ImageGenGateway>();
builder.Services.AddSingleton<WatermarkFontRegistry>();
builder.Services.AddSingleton<WatermarkRenderer>();

// 视频生成领域服务（供 Controller + 工作流胶囊复用）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IVideoGenService, PrdAgent.Infrastructure.Services.VideoGenService>();

// OpenRouter 视频生成客户端（Seedance / Wan / Veo / Sora 统一入口，异步 submit + poll）
// 走 ILlmGateway.SendRawWithResolutionAsync，API Key 由平台管理提供，不依赖环境变量
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IOpenRouterVideoClient, PrdAgent.Infrastructure.Services.OpenRouterVideoClient>();

// Account Data Transfer 数据分享
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.WorkspaceCloneService>();
// 资产披露 Provider（IAssetProvider 被动注册 — 新模块只需实现接口并在此注册）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAssetProvider, PrdAgent.Infrastructure.Services.Assets.ImageAssetProvider>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAssetProvider, PrdAgent.Infrastructure.Services.Assets.AttachmentAssetProvider>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAssetProvider, PrdAgent.Infrastructure.Services.Assets.PrdDocumentAssetProvider>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAssetProvider, PrdAgent.Infrastructure.Services.Assets.VideoAssetProvider>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAssetProvider, PrdAgent.Infrastructure.Services.Assets.WebPageAssetProvider>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.HostedSiteService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IHostedSiteService>(sp =>
    sp.GetRequiredService<PrdAgent.Infrastructure.Services.HostedSiteService>());
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IHostedSiteRevisionService, PrdAgent.Infrastructure.Services.HostedSiteRevisionService>();
builder.Services.AddSingleton<PrdAgent.Api.Services.HostedSitePreviewAccessService>();
// 预览 iframe 的可嵌入来源与 CORS 信任来源同源同表（见 HostedSitePreviewEmbedOptions 注释）。
builder.Services.AddSingleton(
    PrdAgent.Api.Controllers.Api.HostedSitePreviewEmbedOptions.FromConfiguration(builder.Configuration));
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IHostedSiteOptimizationService, PrdAgent.Infrastructure.Services.HostedSiteOptimizationService>();
// 文本向量化：走网关的 embedding 通路（换供应商 = 加一行平台配置，不动代码）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IEmbeddingService, PrdAgent.Infrastructure.Services.EmbeddingService>();

// 网页托管「向我提问」：站点正文快照（喂给模型的上下文）+ 配额闸（保护 owner 的 token 预算）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ISiteContentSnapshotService, PrdAgent.Infrastructure.Services.SiteContentSnapshotService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAskQuotaService, PrdAgent.Infrastructure.Services.AskQuotaService>();
// 单例：它要在请求结束后继续跑（调用方全在请求路径上，谁都不该为几句开场问题多等一次模型调用），
// 所以自己持 IServiceScopeFactory 开 scope，而不是蹭调用方那个即将被释放的 scope。
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IAskOpeningQuestionGenerator, PrdAgent.Infrastructure.Services.AskOpeningQuestionGenerator>();
// 上传解包进度：Singleton —— 节流用的 _lastWrite 字典必须跨请求存活，
// Scoped 的话每次请求一个新实例，节流形同虚设（每个文件都写一次 Redis）
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IUploadProgressService, PrdAgent.Infrastructure.Services.UploadProgressService>();
// 团队（跨应用协作单位：网页托管 + 知识库共用）+ 团队活动日志
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ITeamService, PrdAgent.Infrastructure.Services.TeamService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ITeamActivityService, PrdAgent.Infrastructure.Services.TeamActivityService>();
builder.Services.AddScoped<PrdAgent.Api.Services.IActivityActionRecorder, PrdAgent.Api.Services.ActivityActionRecorder>();
// 网页访客痕迹审计 + 自定义分类自动生成
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ISiteViewEventService, PrdAgent.Infrastructure.Services.SiteViewEventService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IWebFolderService, PrdAgent.Infrastructure.Services.WebFolderService>();
// 统一短链路由（所有分享系统共用 /s/{seq}）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IShortLinkService, PrdAgent.Infrastructure.Services.ShortLinkService>();
// 分享链接密码安全统一服务（PBKDF2 + FixedTimeEquals + 失败锁），网页/周报/知识库/工作流共用
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.ISharePasswordService, PrdAgent.Infrastructure.Services.SharePasswordService>();

// Visual Agent 多图组合服务（图片描述提取 + 多图意图解析）
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.VisualAgent.IImageDescriptionService, PrdAgent.Infrastructure.Services.VisualAgent.ImageDescriptionService>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.VisualAgent.IMultiImageComposeService, PrdAgent.Infrastructure.Services.VisualAgent.MultiImageComposeService>();

// 多图领域服务（解析 @imgN 引用 + 意图分析）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IMultiImageDomainService, PrdAgent.Infrastructure.Services.MultiImageDomainService>();

// AI 百宝箱服务
builder.Services.AddScoped<PrdAgent.Api.Services.Toolbox.IIntentClassifier, PrdAgent.Api.Services.Toolbox.IntentClassifier>();
builder.Services.AddScoped<PrdAgent.Api.Services.Toolbox.IAgentAdapter, PrdAgent.Api.Services.Toolbox.Adapters.PrdAgentAdapter>();
builder.Services.AddScoped<PrdAgent.Api.Services.Toolbox.IAgentAdapter, PrdAgent.Api.Services.Toolbox.Adapters.VisualAgentAdapter>();
builder.Services.AddScoped<PrdAgent.Api.Services.Toolbox.IAgentAdapter, PrdAgent.Api.Services.Toolbox.Adapters.LiteraryAgentAdapter>();
builder.Services.AddScoped<PrdAgent.Api.Services.Toolbox.IAgentAdapter, PrdAgent.Api.Services.Toolbox.Adapters.DefectAgentAdapter>();
builder.Services.AddScoped<PrdAgent.Api.Services.Toolbox.IAgentAdapter, PrdAgent.Api.Services.Toolbox.Adapters.CdsAgentAdapter>();
builder.Services.AddScoped<PrdAgent.Api.Services.Toolbox.IToolboxOrchestrator, PrdAgent.Api.Services.Toolbox.SimpleOrchestrator>();
builder.Services.AddSingleton<PrdAgent.Api.Services.Toolbox.IToolboxEventStore>(sp =>
{
    var redis = sp.GetRequiredService<StackExchange.Redis.ConnectionMultiplexer>();
    var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger<PrdAgent.Api.Services.Toolbox.RedisToolboxEventStore>();
    return new PrdAgent.Api.Services.Toolbox.RedisToolboxEventStore(redis, logger);
});

// 百宝箱后台任务执行器
builder.Services.AddHostedService<PrdAgent.Api.Services.Toolbox.ToolboxRunWorker>();

// 生图后台任务执行器（可断线继续）
builder.Services.AddHostedService<ImageGenRunWorker>();
builder.Services.AddSingleton<PrdAgent.Api.Services.ProfileAvatarGenerationCleanupService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<PrdAgent.Api.Services.ProfileAvatarGenerationCleanupService>());
builder.Services.AddSingleton<PrdAgent.Api.Services.DocumentAssetCleanupService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<PrdAgent.Api.Services.DocumentAssetCleanupService>());

// 对话 Run 后台任务执行器（断线不影响服务端闭环）
builder.Services.AddHostedService<PrdAgent.Api.Services.ChatRunWorker>();
builder.Services.AddScoped<PrdAgent.Api.Services.MapGatewayDesignArtifactExecutor>();
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignArtifactExecutor>(sp =>
    sp.GetRequiredService<PrdAgent.Api.Services.MapGatewayDesignArtifactExecutor>());
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignArtifactWorkspaceBroker,
    PrdAgent.Api.Services.DesignArtifactWorkspaceBroker>();
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignKnowledgeSnapshotResolver,
    PrdAgent.Api.Services.DesignKnowledgeSnapshotResolver>();
// 风格目录（OpenDesign 设计系统快照，内嵌资源）：启动时加载一次；缺失或写坏直接让启动失败并说明原因，
// 不退化成空目录——空目录与「真的没有风格」分不开，风格卡片与样张会静默消失。
builder.Services.AddSingleton<PrdAgent.Api.Services.IDesignSystemCatalog>(
    PrdAgent.Api.Services.DesignSystemCatalog.LoadEmbedded());
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignGenerationSettingsService,
    PrdAgent.Api.Services.DesignGenerationSettingsService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IDesignArtifactLifecycleService,
    PrdAgent.Infrastructure.Services.DesignArtifactLifecycleService>();
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignArtifactCancellationCoordinator,
    PrdAgent.Api.Services.DesignArtifactCancellationCoordinator>();
builder.Services.AddScoped<PrdAgent.Api.Services.IWebPageDesignArtifactLifecycleAdapter,
    PrdAgent.Api.Services.WebPageDesignArtifactLifecycleAdapter>();
builder.Services.AddScoped<PrdAgent.Api.Services.MdToPpt.IHtmlPptDesignArtifactAdapter,
    PrdAgent.Api.Services.MdToPpt.HtmlPptDesignArtifactAdapter>();
builder.Services.AddHostedService<PrdAgent.Api.Services.MdToPpt.HtmlPptDesignArtifactRecoveryWorker>();
builder.Services.AddScoped<PrdAgent.Api.Services.MdToPpt.IHtmlPptPublishCoordinator,
    PrdAgent.Api.Services.MdToPpt.HtmlPptPublishCoordinator>();
builder.Services.AddHostedService<PrdAgent.Api.Services.MdToPpt.HtmlPptPublishRecoveryWorker>();
builder.Services.AddHttpClient("DesignArtifactRuntimeProxy", client =>
{
    client.Timeout = Timeout.InfiniteTimeSpan;
});
builder.Services.AddScoped<PrdAgent.Api.Services.OpenDesignRemoteArtifactExecutor>();
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignArtifactExecutor>(sp =>
    sp.GetRequiredService<PrdAgent.Api.Services.OpenDesignRemoteArtifactExecutor>());
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignArtifactProviderProbe>(sp =>
    sp.GetRequiredService<PrdAgent.Api.Services.OpenDesignRemoteArtifactExecutor>());
builder.Services.AddSingleton<PrdAgent.Api.Services.IDesignArtifactProviderDefinitionSource, PrdAgent.Api.Services.BuiltInDesignArtifactProviderDefinitionSource>();
builder.Services.AddScoped<PrdAgent.Api.Services.IDesignArtifactProviderCatalog, PrdAgent.Api.Services.DesignArtifactProviderCatalog>();
builder.Services.AddHostedService<PrdAgent.Api.Services.HostedSiteEditRunWorker>();

// 工作流后台执行器（DAG 拓扑排序 → 逐节点推进）
builder.Services.AddHostedService<PrdAgent.Api.Services.WorkflowRunWorker>();
builder.Services.AddScoped<PrdAgent.Api.Services.WorkflowAiFillService>();
// 工作流结构校验 + 自动接线 + 缺项扫描（纯函数，无状态）
builder.Services.AddSingleton<PrdAgent.Core.Services.WorkflowValidationService>();

// 工作流调度轮询：每 30 秒扫一次到期的 once / cron 调度，自动入队
builder.Services.AddHostedService<PrdAgent.Api.Services.WorkflowScheduleWorker>();

// 一次性回填存量 PDF 包装站的 WrappedAssetType marker（PR #612）
builder.Services.AddHostedService<PrdAgent.Api.Services.HostedSiteBackfillService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.HostedSiteDeletionCleanupService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.HostedSiteOptimizationCleanupService>();

// 一次性清理：删除已移除催办 Worker 留下的存量提醒通知（pm-reminder / defect-escalation），让噪音立即归零
builder.Services.AddHostedService<PrdAgent.Api.Services.EscalationNotificationCleanupService>();

// 涌现探索器
builder.Services.AddSingleton<PrdAgent.Api.Services.SystemCapabilityScanner>();
builder.Services.AddScoped<PrdAgent.Api.Services.EmergenceService>();
builder.Services.AddScoped<PrdAgent.Api.Services.PmAgentService>();
builder.Services.AddScoped<PrdAgent.Api.Services.MarketingConsultService>();

// 演讲智能体（长文本 → 思维导图演讲）
builder.Services.AddScoped<PrdAgent.Api.Services.SpeechAgentService>();

// 技能引导 Agent
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.SkillAgentService>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.ISkillAgentSessionStore, PrdAgent.Infrastructure.Services.SkillAgentSessionStore>();

// 文档订阅同步引擎。用户可控 URL 禁止自动重定向，避免首跳校验后跳入内网。
builder.Services.AddHttpClient("DocumentSync")
    .ConfigurePrimaryHttpMessageHandler(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory>().CreateHandler());

// 系统级跨节点互传 HttpClient（PR #742 review fix）。
// 对端 baseUrl 是管理员配置 + ISafeOutboundUrlValidator 把过的，但默认 HttpClientHandler 会自动跟随
// 重定向 —— 恶意对端响应 3xx 跳内网即可绕过首跳校验。挂 SafeOutbound handler 禁自动跟随。
builder.Services.AddHttpClient("PeerSync")
    .ConfigurePrimaryHttpMessageHandler(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory>().CreateHandler());
builder.Services.AddHostedService<PrdAgent.Api.Services.DocumentSyncWorker>();

// 视频生成后台执行器（纯 OpenRouter 直出，2026-04-27 砍掉 Remotion 拆分镜路径）
builder.Services.AddHostedService<PrdAgent.Api.Services.VideoGenRunWorker>();

// 视频转文档后台执行器（视频→音频提取→STT转写→多模态LLM分析→Markdown文档）
builder.Services.AddHostedService<PrdAgent.Api.Services.VideoToDocRunWorker>();

// 竞技场 Run 后台执行器（多模型并行 + afterSeq 断线重连）
builder.Services.AddHostedService<PrdAgent.Api.Services.ArenaRunWorker>();

// 转录 Agent 后台执行器（ASR 转写 + 模板转文案）
builder.Services.AddHostedService<PrdAgent.Api.Services.TranscriptRunWorker>();

// 首页「AI 大事早知道」资讯雷达：代理拉取 ai-news-radar 公共静态 JSON（5min 内存缓存 + 6h stale 保底）
// 摘要抓取会请求 feed 内的任意文章 URL（外部不可信），必须走 SafeOutbound 处理器：
// 禁用自动重定向 + 逐 IP 校验，挡住「文章 URL 重定向到 localhost / 169.254.169.254 等内网」的 SSRF。
builder.Services.AddHttpClient("AiNews", c =>
{
    c.Timeout = TimeSpan.FromSeconds(8);
    c.DefaultRequestHeaders.UserAgent.ParseAdd("PrdAgent-AiNewsRadar/1.0");
})
    .ConfigurePrimaryHttpMessageHandler(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory>().CreateHandler());
// Scoped：AiNewsService 依赖 Scoped 的 ILlmGateway（一句话解读），故不能是 Singleton；
// 内存缓存走注入的单例 IMemoryCache，资讯流缓存不受 scoped 影响。
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAiNewsService, PrdAgent.Infrastructure.Services.AiNewsService>();
// 后台每 4 分钟预热「AI 大事」缓存，让用户访问路径永不同步等外网（卡顿排查 2026-06-03）。
builder.Services.AddHostedService<PrdAgent.Infrastructure.Services.AiNewsCacheWarmer>();

// 模型排行榜：每天把 arena.ai 的公开榜单同步进本地库，页面只读库不打外站。
// 超时给到 30 秒：榜单页是服务端渲染的大页面（agent 榜约 1.8MB、text 榜约 5.4MB），
// 按 AiNews 那 8 秒配会稳定超时。出站仍走 SafeOutboundHttpHandler，不绕开 SSRF 防护。
builder.Services.AddHttpClient(PrdAgent.Api.Services.ModelLeaderboard.ModelLeaderboardSyncWorker.HttpClientName, c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
    c.DefaultRequestHeaders.UserAgent.ParseAdd("PrdAgent-ModelLeaderboard/1.0");
})
    .ConfigurePrimaryHttpMessageHandler(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory>().CreateHandler());
// 同步逻辑的唯一实现，周期 Worker 与管理员手动端点共用，避免两份各自漂移。
builder.Services.AddScoped<PrdAgent.Api.Services.ModelLeaderboard.ModelLeaderboardSyncService>();
// 只在权威部署上跑：快照是共享库里的全局单行状态，多个分支预览同时写会互相覆盖。
builder.Services.AddHostedService<PrdAgent.Api.Services.ModelLeaderboard.ModelLeaderboardSyncWorker>();

// 知识库 Agent 后台执行器（字幕生成 + 文档再加工，ASR/vision 统一走 ILlmGateway）
builder.Services.AddHttpClient("DocStoreAgent");
// MCP 连接器网关：回环转发当前 sk-ak Bearer 到自身真实接口（McpGatewayController）。
// 该 client 只用于回环调用自身，故放行证书校验，兼容仅配置 https 监听时对 127.0.0.1 的 TLS 主机名不匹配。
builder.Services.AddHttpClient("McpLoopback", c =>
{
    // 放宽到 10 分钟：动态工具可能回环到长任务 Agent 动作（周报 / LLM 生成）。
    // 配合 SendAsync 用 CancellationToken.None（客户端断开不取消），由下游服务端自身限制控制完成；
    // 仍保留一个有界上限，避免连接无限悬挂。
    c.Timeout = TimeSpan.FromSeconds(600);
}).ConfigurePrimaryHttpMessageHandler(() => new System.Net.Http.SocketsHttpHandler
{
    // 不跟随重定向：回环只该打到自身后端，若目标返回跨主机重定向，跟过去会把转发的
    // sk-ak / X-AI-Access-Key 凭据带到外部主机（凭据外泄）。让重定向以非 2xx 原样返回。
    AllowAutoRedirect = false,
    // 禁用系统代理：回环只调 127.0.0.1，避免配了 HTTP_PROXY 且未豁免 loopback 的部署
    // 把携带 sk-ak / X-AI-Access-Key 的回环请求发到代理（失败或泄露密钥）。
    UseProxy = false,
    SslOptions = new System.Net.Security.SslClientAuthenticationOptions
    {
        RemoteCertificateValidationCallback = (_, _, _, _) => true,
    },
});
builder.Services.AddScoped<PrdAgent.Api.Services.SubtitleGenerationProcessor>();
builder.Services.AddScoped<PrdAgent.Api.Services.ContentReprocessProcessor>();
builder.Services.AddScoped<PrdAgent.Api.Services.ContentReprocessApplyService>();
builder.Services.AddScoped<PrdAgent.Api.Services.AutoLinkProcessor>();
builder.Services.AddScoped<PrdAgent.Api.Services.EntryContentWriteService>();
// 接入台（MCP）：用量闸门 + 调用记录
builder.Services.AddScoped<PrdAgent.Api.Services.Mcp.McpUsageService>();
builder.Services.AddScoped<PrdAgent.Api.Services.Mcp.ILiteraryMcpModelSelectionService,
    PrdAgent.Api.Services.Mcp.LiteraryMcpModelSelectionService>();
// 网关回环续跳的自证令牌：每进程一份，随进程生灭，不落库
builder.Services.AddSingleton<PrdAgent.Api.Services.Mcp.McpLoopbackSignal>();
builder.Services.AddScoped<PrdAgent.Api.Services.TutorialLinkGraphService>();
builder.Services.AddScoped<PrdAgent.Api.Services.DocumentStoreAssetNormalizer>();
builder.Services.AddScoped<PrdAgent.Api.Services.DocumentStoreLiveTranscriptionRelay>();
builder.Services.AddScoped<PrdAgent.Api.Services.ShortVideoMaterialProcessor>();
builder.Services.AddHostedService<PrdAgent.Api.Services.DocumentStoreAgentWorker>();
builder.Services.AddHostedService<PrdAgent.Api.Services.DocumentRecordingArchiveWorker>();
builder.Services.AddHostedService<PrdAgent.Api.Services.ShortVideoMaterialWorker>();
// 启动时把内置「再加工·智能体」种入 DB（reprocess_agents 集合）
builder.Services.AddHostedService<PrdAgent.Api.Services.ReprocessAgentSeeder>();

// 权限字符串迁移服务（启动时自动迁移旧格式 admin.xxx → 新格式 appKey.action）
builder.Services.AddHostedService<PrdAgent.Api.Services.PermissionMigrationService>();
// 应用调用者同步：启动时增量注册代码中的 AppCaller（含 pa-agent.chat::chat），并自动回填 chat 模型组
// 管理后台「初始化应用」仍可全量对齐；二者互补，新 Agent 无需人工点初始化
builder.Services.AddHostedService<PrdAgent.Api.Services.AppCallerRegistrySyncService>();

// 邮件通道服务
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IEmailIntentDetector, PrdAgent.Infrastructure.Services.Email.EmailIntentDetector>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IEmailHandler, PrdAgent.Infrastructure.Services.Email.ClassifyEmailHandler>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IEmailHandler, PrdAgent.Infrastructure.Services.Email.TodoEmailHandler>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IEmailChannelService, PrdAgent.Infrastructure.Services.EmailChannelService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.EmailChannelWorker>();

// 教程邮件服务
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.ITutorialEmailService, PrdAgent.Infrastructure.Services.TutorialEmailService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.TutorialEmailWorker>();

// 应用注册中心服务
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAppRegistryService, PrdAgent.Infrastructure.Services.AppRegistryService>();
builder.Services.AddHttpClient("SafeOutbound")
    .ConfigurePrimaryHttpMessageHandler(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory>().CreateHandler());

// Report Agent Phase 2: 自动采集服务
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.MapActivityCollector>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.ReportGenerationService>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.DailyLogPolishService>();
builder.Services.AddScoped<PrdAgent.Api.Services.DefectAgent.DefectPolishService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.ReportAgent.GitSyncWorker>();
builder.Services.AddHostedService<PrdAgent.Api.Services.ReportAgent.ReportAutoGenerateWorker>();
// Report Agent Phase 3: 管理增强服务
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.ReportWebhookService>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.ReportNotificationService>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.TeamSummaryService>();
// Report Agent v2.0: 工作流管道 + 个人数据源
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IWorkflowExecutionService, PrdAgent.Api.Services.ReportAgent.WorkflowExecutionService>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.ArtifactStatsParser>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.PersonalSourceService>();

// Defect Agent: Webhook 通知服务
builder.Services.AddScoped<PrdAgent.Api.Services.TapdBugAgentService>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.DefectWebhookService>();

// Review Agent: Webhook 通知服务
builder.Services.AddScoped<PrdAgent.Api.Services.ReviewAgent.ReviewWebhookService>();

// Project Route Agent: 浅克隆缓存服务（任意第三方仓库 git clone --depth=1）
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.ProjectRouteAgent.GitRepoCacheService>();
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.ChannelTraceAgent.ChannelTraceCodeScanService>();

// ImageMaster 资产存储：默认本地文件（可替换为对象存储实现）
builder.Services.AddSingleton<IAssetStorage>(sp =>
{
    var cfg = sp.GetRequiredService<IConfiguration>();
    var log = sp.GetRequiredService<ILoggerFactory>().CreateLogger("AssetStorage");
    // 强约束：统一只使用一套"扁平环境变量"（不使用双下划线）：
    // - ASSETS_PROVIDER=tencentCos / cloudflareR2 / local
    // - TENCENT_COS_BUCKET / TENCENT_COS_REGION / TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_PUBLIC_BASE_URL / TENCENT_COS_PREFIX
    // - R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE_URL / R2_PREFIX / R2_ENDPOINT
    // - ASSETS_LOCAL_DIR（local 模式存储根目录，默认 {ContentRoot}/data/assets）
    //
    // 2026-06-22：ASSETS_PROVIDER 不再硬默认 tencentCos。未显式指定时走 "auto"：
    //   有 COS 凭据→COS；否则有 R2 凭据→R2；都没有→local（占位/兜底，让无云凭据的
    //   实例如 CDS 预览也能正常存图，而不是构造 IAssetStorage 直接抛异常导致传图失败）。
    // 显式设了 tencentCos/cloudflareR2 但缺凭据→仍按原样抛错（尊重显式选择）。
    var providerRaw = (cfg["ASSETS_PROVIDER"] ?? string.Empty).Trim();

    static (string bucket, string region, string secretId, string secretKey, string? publicBaseUrl, string? prefix) ReadTencentCosEnv(IConfiguration cfg)
    {
        var bucket = (cfg["TENCENT_COS_BUCKET"] ?? string.Empty).Trim();
        var region = (cfg["TENCENT_COS_REGION"] ?? string.Empty).Trim();
        var sid = (cfg["TENCENT_COS_SECRET_ID"] ?? string.Empty).Trim();
        var sk = (cfg["TENCENT_COS_SECRET_KEY"] ?? string.Empty).Trim();
        var publicBaseUrl = (cfg["TENCENT_COS_PUBLIC_BASE_URL"] ?? string.Empty).Trim();
        var prefix = (cfg["TENCENT_COS_PREFIX"] ?? string.Empty).Trim();
        return (bucket, region, sid, sk, string.IsNullOrWhiteSpace(publicBaseUrl) ? null : publicBaseUrl, string.IsNullOrWhiteSpace(prefix) ? null : prefix);
    }

    var provider = AssetStorageProviderResolver.ResolveProviderName(cfg);

    // 本地文件存储（占位/兜底）：无云凭据时也能存图，避免 IAssetStorage 构造抛异常。
    IAssetStorage BuildLocal(string reason)
    {
        var dir = (cfg["ASSETS_LOCAL_DIR"] ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(dir))
        {
            var contentRoot = sp.GetService<IWebHostEnvironment>()?.ContentRootPath
                ?? AppContext.BaseDirectory;
            dir = Path.Combine(contentRoot, "data", "assets");
        }
        log.LogWarning(
            "AssetStorage selected: provider=local dir={Dir} ({Reason})。本地存储仅适合开发/预览或占位；" +
            "生产请设 ASSETS_PROVIDER=tencentCos|cloudflareR2 + 对应凭据。",
            dir, reason);
        return WrapWithRegistry(new LocalAssetStorage(dir), "local");
    }

    if (string.Equals(provider, "local", StringComparison.OrdinalIgnoreCase))
    {
        var reason = string.Equals(providerRaw, "local", StringComparison.OrdinalIgnoreCase)
            ? "ASSETS_PROVIDER=local（显式）"
            : "ASSETS_PROVIDER 未设置或为 auto，且无任何云凭据";
        return BuildLocal(reason);
    }

    // 读取通用安全删除配置（两种 Provider 共享同一套策略逻辑）
    static (bool enableSafeDelete, string[] allow) ReadSafeDeleteConfig(IConfiguration c)
    {
        var enable = string.Equals((c["SafeDelete:Enable"] ?? c["TencentCos:EnableSafeDelete"] ?? string.Empty).Trim(), "true", StringComparison.OrdinalIgnoreCase);
        var raw = (c["SafeDelete:AllowPrefixes"] ?? c["TencentCos:SafeDeleteAllowPrefixes"] ?? string.Empty).Trim();
        var a = raw
            .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => x.Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToArray();
        return (enable, a);
    }

    if (string.Equals(provider, "tencentCos", StringComparison.OrdinalIgnoreCase))
    {
        var (bucket, region, secretId, secretKey, publicBaseUrl, prefix) = ReadTencentCosEnv(cfg);
        if (string.IsNullOrWhiteSpace(bucket) ||
            string.IsNullOrWhiteSpace(region) ||
            string.IsNullOrWhiteSpace(secretId) ||
            string.IsNullOrWhiteSpace(secretKey))
        {
            throw new InvalidOperationException(
                "已强制使用 Tencent COS，但缺少必需环境变量。请设置：TENCENT_COS_BUCKET / TENCENT_COS_REGION / TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY。");
        }
        var tempDir = (string?)null; // 纯内存流模式：不依赖本地 tempDir
        var (enableSafeDelete, allow) = ReadSafeDeleteConfig(cfg);
        var logger = sp.GetRequiredService<ILogger<TencentCosStorage>>();
        log.LogInformation(
            "AssetStorage selected: provider={ProviderRaw}->{Provider} tencentCos.bucket={Bucket} region={Region} prefix={Prefix} publicBaseUrl={PublicBaseUrl}",
            providerRaw,
            provider,
            (bucket ?? string.Empty).Trim(),
            (region ?? string.Empty).Trim(),
            (prefix ?? string.Empty).Trim(),
            (publicBaseUrl ?? string.Empty).Trim());
        var cosStorage = new TencentCosStorage(bucket!, region!, secretId!, secretKey!, publicBaseUrl, prefix, tempDir, enableSafeDelete, allow, logger);
        return WrapWithRegistry(cosStorage, "tencentCos");
    }

    if (string.Equals(provider, "cloudflareR2", StringComparison.OrdinalIgnoreCase))
    {
        var accountId = (cfg["R2_ACCOUNT_ID"] ?? string.Empty).Trim();
        var accessKeyId = (cfg["R2_ACCESS_KEY_ID"] ?? string.Empty).Trim();
        var secretAccessKey = (cfg["R2_SECRET_ACCESS_KEY"] ?? string.Empty).Trim();
        var r2Bucket = (cfg["R2_BUCKET"] ?? string.Empty).Trim();
        var r2PublicBaseUrl = (cfg["R2_PUBLIC_BASE_URL"] ?? string.Empty).Trim();
        var r2Prefix = (cfg["R2_PREFIX"] ?? string.Empty).Trim();
        var r2Endpoint = (cfg["R2_ENDPOINT"] ?? string.Empty).Trim();

        if (string.IsNullOrWhiteSpace(accountId) ||
            string.IsNullOrWhiteSpace(accessKeyId) ||
            string.IsNullOrWhiteSpace(secretAccessKey) ||
            string.IsNullOrWhiteSpace(r2Bucket))
        {
            throw new InvalidOperationException(
                "已选择 Cloudflare R2，但缺少必需环境变量。请设置：R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET。");
        }
        var (enableSafeDelete, allow) = ReadSafeDeleteConfig(cfg);
        var r2Logger = sp.GetRequiredService<ILogger<CloudflareR2Storage>>();
        log.LogInformation(
            "AssetStorage selected: provider={ProviderRaw}->{Provider} r2.bucket={Bucket} endpoint={Endpoint} prefix={Prefix} publicBaseUrl={PublicBaseUrl}",
            providerRaw, provider, r2Bucket,
            string.IsNullOrWhiteSpace(r2Endpoint) ? $"https://{accountId}.r2.cloudflarestorage.com" : r2Endpoint,
            string.IsNullOrWhiteSpace(r2Prefix) ? "(none)" : r2Prefix,
            string.IsNullOrWhiteSpace(r2PublicBaseUrl) ? "(r2.dev fallback)" : r2PublicBaseUrl);
        var r2Storage = new CloudflareR2Storage(
            accountId, accessKeyId, secretAccessKey, r2Bucket,
            string.IsNullOrWhiteSpace(r2PublicBaseUrl) ? null : r2PublicBaseUrl,
            string.IsNullOrWhiteSpace(r2Prefix) ? null : r2Prefix,
            string.IsNullOrWhiteSpace(r2Endpoint) ? null : r2Endpoint,
            enableSafeDelete, allow, r2Logger);
        return WrapWithRegistry(r2Storage, "cloudflareR2");
    }

    throw new InvalidOperationException(
        $"ASSETS_PROVIDER={providerRaw} 不支持。可选值：tencentCos / cloudflareR2 / local");

    // ─── 装饰器：用 RegistryAssetStorage 包裹真实实现，自动登记每次存储操作 ───
    IAssetStorage WrapWithRegistry(IAssetStorage inner, string providerName)
    {
        var db = sp.GetRequiredService<MongoDbContext>();
        var regLogger = sp.GetRequiredService<ILogger<RegistryAssetStorage>>();
        log.LogInformation("AssetStorage wrapped with RegistryAssetStorage (provider={Provider})", providerName);
        return new RegistryAssetStorage(inner, db, providerName, regLogger);
    }
});
builder.Services.AddSingleton<IAssetStorageRuntimeInfo>(sp =>
    sp.GetRequiredService<IAssetStorage>() as IAssetStorageRuntimeInfo
    ?? throw new InvalidOperationException("IAssetStorage 实现未暴露运行时提供商信息"));
builder.Services.AddSingleton<AssetStorageReadinessProbe>();
builder.Services.AddSingleton<ApplicationReadinessProbe>();
builder.Services.AddHttpClient("AssetStorageReadiness", client =>
{
    client.Timeout = TimeSpan.FromSeconds(20);
    client.DefaultRequestHeaders.CacheControl =
        new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
});
builder.Services.AddHttpClient("AssetStorageStream", client =>
{
    client.Timeout = TimeSpan.FromMinutes(30);
}).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
{
    AllowAutoRedirect = false,
});

// 文件内容提取器（PDF/Word/Excel/PPT）
builder.Services.AddSingleton<IFileContentExtractor, FileContentExtractor>();
builder.Services.AddSingleton<IRequirementExcelParser, RequirementExcelParser>();

// 海鲜市场「技能包」zip 元数据解析
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.MarketplaceSkills.SkillZipMetadataExtractor>();

// 配置Redis
var redisConnectionString = builder.Configuration["Redis:ConnectionString"] ?? "localhost:6379";
var sessionTimeout = builder.Configuration.GetValue<int>("Session:TimeoutMinutes", 30);
builder.Services.AddSingleton<ICacheManager>(new RedisCacheManager(redisConnectionString, sessionTimeout));

// 注册 Redis ConnectionMultiplexer（用于 ID 生成器等服务）
builder.Services.AddSingleton<StackExchange.Redis.ConnectionMultiplexer>(sp =>
    StackExchange.Redis.ConnectionMultiplexer.Connect(redisConnectionString));

// 注册 ID 生成器
var useReadableIds = builder.Environment.IsDevelopment() || 
                     builder.Environment.IsEnvironment("Testing");
builder.Services.AddSingleton<IIdGenerator>(sp =>
{
    var redis = sp.GetRequiredService<StackExchange.Redis.ConnectionMultiplexer>();
    return new IdGenerator(redis, useReadableIds);
});

// Run 事件存储（断线续传/观测）：生产用 Redis（高频写，避免 Mongo 写放大）
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IRunEventStore>(sp =>
    new PrdAgent.Infrastructure.Services.RedisRunEventStore(redisConnectionString, defaultTtl: TimeSpan.FromHours(24)));
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IRunQueue>(sp =>
    new PrdAgent.Infrastructure.Services.RedisRunQueue(redisConnectionString));

// 注册分布式限流服务（基于 Redis）
builder.Services.AddSingleton<IRateLimitService>(sp =>
{
    var redis = sp.GetRequiredService<StackExchange.Redis.ConnectionMultiplexer>();
    var logger = sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.Services.RedisRateLimitService>>();
    return new PrdAgent.Infrastructure.Services.RedisRateLimitService(redis, logger);
});

// OpenApi 对外网关韧性服务（Phase 2：按 Key 限流桶 + 配额拦截 + 降级/配额预警 + 用量统计）
builder.Services.AddSingleton<IOpenApiUsageService>(sp =>
{
    var redis = sp.GetRequiredService<StackExchange.Redis.ConnectionMultiplexer>();
    var db = sp.GetRequiredService<MongoDbContext>();
    var logger = sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.Services.OpenApiUsageService>>();
    return new PrdAgent.Infrastructure.Services.OpenApiUsageService(redis, db, logger);
});

// 配置JWT认证
var jwtSecret = builder.Configuration["Jwt:Secret"];
if (string.IsNullOrWhiteSpace(jwtSecret))
{
    // 注意：.NET 环境变量绑定规则为 Jwt__Secret（双下划线）
    // 这里必须在启动阶段 fail-fast，避免 AddJwtBearer 的 options 懒加载导致线上"首个请求才爆炸"。
    throw new InvalidOperationException("JWT Secret 未配置或为空。请设置配置项 Jwt:Secret（环境变量：Jwt__Secret）。");
}

var jwtSecretBytes = Encoding.UTF8.GetBytes(jwtSecret.Trim());
// HMAC-SHA256 推荐至少 256-bit（32 bytes）密钥；同时也避免 0 长度触发 IDX10703
if (jwtSecretBytes.Length < 32)
{
    throw new InvalidOperationException($"JWT Secret 过短（当前 {jwtSecretBytes.Length} bytes），至少需要 32 bytes。请更新配置项 Jwt:Secret（环境变量：Jwt__Secret）。");
}

var apiKeyCryptoSecret = builder.Configuration["ApiKeyCrypto:Secret"];
if (string.IsNullOrWhiteSpace(apiKeyCryptoSecret))
{
    Log.Warning("ApiKeyCrypto:Secret 未配置；平台 API key 密文将临时兼容使用 Jwt:Secret。正式环境请配置 ApiKeyCrypto__Secret。");
}
else if (Encoding.UTF8.GetBytes(apiKeyCryptoSecret.Trim()).Length < 32)
{
    throw new InvalidOperationException($"ApiKeyCrypto Secret 过短（当前 {Encoding.UTF8.GetBytes(apiKeyCryptoSecret.Trim()).Length} bytes），至少需要 32 bytes。请更新配置项 ApiKeyCrypto:Secret（环境变量：ApiKeyCrypto__Secret）。");
}

var jwtSigningKey = new SymmetricSecurityKey(jwtSecretBytes);
var jwtIssuer = builder.Configuration["Jwt:Issuer"] ?? "prdagent";
var jwtAudience = builder.Configuration["Jwt:Audience"] ?? "prdagent";

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // 关闭默认的 Inbound Claim 映射（否则标准 claim 如 sub 可能被映射为 nameidentifier，导致业务取不到 sub）
        options.MapInboundClaims = false;

        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtIssuer,
            ValidAudience = jwtAudience,
            // 预先构造并校验过的 signing key（启动阶段 fail-fast）
            IssuerSigningKey = jwtSigningKey,
            // 我们的 JwtService 写入的角色 claim 为 "role"（非 ClaimTypes.Role）
            // 且 MapInboundClaims=false，因此需要显式指定 RoleClaimType，否则 [Authorize(Roles="ADMIN")] 会全部 403
            RoleClaimType = "role"
        };

        // 统一未授权/无权限响应格式，避免默认 401/403 返回空 body（桌面端会报 "Empty response from server"）
        var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                // 跳过 OPTIONS 预检请求的认证（CORS 预检请求不需要认证）
                if (HttpMethods.IsOptions(context.Request.Method))
                {
                    context.NoResult();
                    return Task.CompletedTask;
                }
                var liveAsrToken = PrdAgent.Api.Services.LiveAsrWebSocketAuth.ExtractToken(
                    context.Request.Path,
                    context.Request.Headers.SecWebSocketProtocol);
                if (!string.IsNullOrWhiteSpace(liveAsrToken))
                    context.Token = liveAsrToken;
                return Task.CompletedTask;
            },
            OnTokenValidated = async context =>
            {
                var logger = context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("JwtAuth");
                var requestPath = context.HttpContext.Request.Path.Value;
                var requestMethod = context.HttpContext.Request.Method;
                var clientIp = context.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";

                try
                {
                    var principal = context.Principal;
                    var sub = principal?.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
                              ?? principal?.FindFirst("sub")?.Value
                              ?? principal?.FindFirst(ClaimTypes.NameIdentifier)?.Value
                              ?? principal?.FindFirst("nameid")?.Value;
                    var clientType = context.Principal?.FindFirst("clientType")?.Value;
                    var tvStr = context.Principal?.FindFirst("tv")?.Value;

                    if (string.IsNullOrWhiteSpace(sub) ||
                        string.IsNullOrWhiteSpace(clientType) ||
                        string.IsNullOrWhiteSpace(tvStr) ||
                        !int.TryParse(tvStr, out var tv) ||
                        tv < 1)
                    {
                        logger.LogWarning("[401] Token claims无效 - Path: {Path}, Method: {Method}, IP: {IP}, sub: {Sub}, clientType: {ClientType}, tv: {Tv}",
                            requestPath, requestMethod, clientIp, sub ?? "null", clientType ?? "null", tvStr ?? "null");
                        PrdAgent.Api.Authentication.AuthorizationFailureContract.Set(
                            context.HttpContext,
                            PrdAgent.Api.Authentication.AuthorizationFailureContract.SessionInvalid);
                        context.Fail("Invalid auth session claims");
                        return;
                    }

                    var authSessionService = context.HttpContext.RequestServices.GetRequiredService<IAuthSessionService>();
                    var currentTv = await authSessionService.GetTokenVersionAsync(sub, clientType);
                    if (currentTv != tv)
                    {
                        logger.LogWarning("[401] Token版本不匹配(已被撤销) - Path: {Path}, Method: {Method}, IP: {IP}, UserId: {UserId}, ClientType: {ClientType}, TokenVersion: {Tv}, CurrentVersion: {CurrentTv}",
                            requestPath, requestMethod, clientIp, sub, clientType, tv, currentTv);
                        PrdAgent.Api.Authentication.AuthorizationFailureContract.Set(
                            context.HttpContext,
                            PrdAgent.Api.Authentication.AuthorizationFailureContract.SessionRevoked);
                        context.Fail("Token revoked");
                    }
                }
                catch (Exception ex)
                {
                    // 安全兜底：依赖服务异常时不直接放行
                    logger.LogWarning(ex, "[401] Token验证异常 - Path: {Path}, Method: {Method}, IP: {IP}",
                        requestPath, requestMethod, clientIp);
                    PrdAgent.Api.Authentication.AuthorizationFailureContract.Set(
                        context.HttpContext,
                        PrdAgent.Api.Authentication.AuthorizationFailureContract.SessionValidationUnavailable);
                    context.Fail("Token validation failed");
                }
            },
            OnChallenge = async context =>
            {
                var logger = context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("JwtAuth");
                var requestPath = context.HttpContext.Request.Path.Value;
                var requestMethod = context.HttpContext.Request.Method;
                var clientIp = context.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                var authHeader = context.HttpContext.Request.Headers.Authorization.FirstOrDefault();
                var hasToken = !string.IsNullOrWhiteSpace(authHeader);
                var errorDesc = context.AuthenticateFailure?.Message ?? context.ErrorDescription ?? "No token provided";

                logger.LogWarning("[401] JWT Challenge - Path: {Path}, Method: {Method}, IP: {IP}, HasToken: {HasToken}, Reason: {Reason}",
                    requestPath, requestMethod, clientIp, hasToken, errorDesc);

                // 跳过默认 challenge 响应（会覆盖 body）
                context.HandleResponse();
                await PrdAgent.Api.Authentication.AuthorizationFailureContract.WriteChallengeAsync(
                    context.HttpContext,
                    jsonOptions);
            },
            OnForbidden = async context =>
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                context.Response.ContentType = "application/json; charset=utf-8";
                var payload = ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限");
                await context.Response.WriteAsync(JsonSerializer.Serialize(payload, jsonOptions));
            }
        };
    })
    .AddScheme<PrdAgent.Api.Authentication.ApiKeyAuthenticationOptions, PrdAgent.Api.Authentication.ApiKeyAuthenticationHandler>(
        "ApiKey",
        options => { })
    .AddScheme<PrdAgent.Api.Authentication.AiAccessKeyAuthenticationOptions, PrdAgent.Api.Authentication.AiAccessKeyAuthenticationHandler>(
        PrdAgent.Api.Authentication.AiAccessKeyAuthenticationHandler.SchemeName,
        options => { })
    .AddScheme<PrdAgent.Api.Authentication.StableSmokeAuthenticationOptions, PrdAgent.Api.Authentication.StableSmokeAuthenticationHandler>(
        PrdAgent.Api.Authentication.StableSmokeAuthenticationHandler.SchemeName,
        options => { });

builder.Services.AddAuthorization(options =>
{
    // 配置默认策略，支持多种认证方案
    options.DefaultPolicy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder(
        JwtBearerDefaults.AuthenticationScheme,
        "ApiKey",
        PrdAgent.Api.Authentication.AiAccessKeyAuthenticationHandler.SchemeName,
        PrdAgent.Api.Authentication.StableSmokeAuthenticationHandler.SchemeName)
        .RequireAuthenticatedUser()
        .Build();
});

// 配置CORS
var allowedOriginsSection = builder.Configuration.GetSection("Cors:AllowedOrigins");
string[] allowedOrigins;
if (allowedOriginsSection.Exists())
{
    var origins = new List<string>();
    foreach (var child in allowedOriginsSection.GetChildren())
    {
        if (!string.IsNullOrEmpty(child.Value))
            origins.Add(child.Value);
    }
    allowedOrigins = origins.Count > 0 ? origins.ToArray() : new[]
    {
        "http://localhost:1420",
        "http://localhost:8000",
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:1420",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
    };
}
else
{
    allowedOrigins = new[]
    {
        "http://localhost:1420",
        "http://localhost:8000",
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:1420",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
    };
}

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        // 开发环境：放行 localhost/127.0.0.1 任意端口，避免 Vite 端口变化导致 CORS 丢失
        if (builder.Environment.IsDevelopment())
        {
            policy
                .SetIsOriginAllowed(origin =>
                {
                    if (string.IsNullOrWhiteSpace(origin) || origin == "null") return false;
                    if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
                    // 兼容 IPv4/IPv6 回环：localhost、127.0.0.1、[::1]
                    // 说明：Mac/Windows 上某些情况下前端会以 http://[::1]:port 作为 Origin，若未放行会导致预检 OPTIONS 403 "看似随机" 波动
                    return uri.Host is "localhost" or "127.0.0.1" or "::1";
                })
                .AllowAnyHeader()
                .AllowAnyMethod()
                .WithExposedHeaders("X-Perm-Fingerprint");
            return;
        }

        // 生产环境：严格按配置允许来源
        policy.WithOrigins(allowedOrigins)
            .AllowAnyHeader()
            .AllowAnyMethod()
            .WithExposedHeaders("X-Perm-Fingerprint");
    });
});

// 注册基础设施服务
builder.Services.AddSingleton<IMarkdownParser, MarkdownParser>();
builder.Services.AddSingleton<IPromptManager, PromptManager>();

// 注册 JWT 服务
// Access Token 默认 7 天（10080 分钟），与会话滑动窗口同长：用户要的就是「7 天有效」。
// 踢下线由每次请求校验 tokenVersion 保证（见 OnTokenValidated），因此拉长 access token
// 不削弱撤销能力，却能消灭「离开一会儿回来就 401」的体感。
// 归一化一次再用：0 / 负值若原样传给 JwtService，会签出「已经过期」的 token，
// 而 Controller 那边按默认值回报 expiresIn，登录立刻 401。口径 SSOT 见 AuthTokenLifetimes。
// 同时受会话滑动窗口约束：token 比窗口活得久的话，「N 天不用就掉登录」没有执行点
// （JWT 校验不查会话是否还在），详见 EffectiveAccessTokenMinutes 注释。
var jwtSessionSlidingDays = builder.Configuration.GetValue<int>(
    "Auth:SessionSlidingDays", AuthTokenLifetimes.DefaultSessionSlidingDays);
var jwtAccessTokenMinutes = AuthTokenLifetimes.EffectiveAccessTokenMinutes(
    builder.Configuration.GetValue<int>("Jwt:AccessTokenMinutes", AuthTokenLifetimes.DefaultAccessTokenMinutes),
    jwtSessionSlidingDays);
builder.Services.AddSingleton<IJwtService>(sp => 
    new JwtService(jwtSecret, jwtIssuer, jwtAudience, jwtAccessTokenMinutes));

// 注册 AuthSessionService（refresh session + tokenVersion）
// 会话滑动窗口默认 7 天：每次已鉴权请求都会 Touch 续满（AuthSlidingExpirationMiddleware），
// 即「只要在用就不会掉登录」，连续 7 天没访问才需要重新登录。
builder.Services.AddSingleton<IAuthSessionService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    var config = sp.GetRequiredService<IConfiguration>();
    var secret = config["Jwt:Secret"] ?? "default-secret";
    var slidingDays = config.GetValue<int>("Auth:SessionSlidingDays", AuthTokenLifetimes.DefaultSessionSlidingDays);
    // 把 access token 时长也传进去：tokenVersion（撤销台账）必须活得比它要撤销的 token 久，
    // 否则会话窗口被配得比 token 短时，已撤销的旧版本 token 会在剩余寿命里重新被放行。
    return new AuthSessionService(cache, secret, slidingDays, jwtAccessTokenMinutes);
});

// 注册 HTTP 日志处理程序
builder.Services.AddTransient<HttpLoggingHandler>();

// 注册通用 HTTP 客户端（带日志）- 用于所有第三方 API 请求
builder.Services.AddHttpClient("LoggedHttpClient")
    .AddHttpMessageHandler<HttpLoggingHandler>();

// 注册 LLM 客户端
// 优先从环境变量读取，其次从配置读取
var llmApiKey = Environment.GetEnvironmentVariable("LLM__ClaudeApiKey") 
    ?? builder.Configuration["LLM:ClaudeApiKey"] 
    ?? "";
var llmModel = Environment.GetEnvironmentVariable("LLM__Model")
    ?? builder.Configuration["LLM:Model"] 
    ?? "claude-3-5-sonnet-20241022";

if (string.IsNullOrWhiteSpace(llmApiKey))
{
    Log.Warning("LLM:ClaudeApiKey is not configured. Please set LLM__ClaudeApiKey environment variable or LLM:ClaudeApiKey in appsettings.json");
}

// 注册 LLM 客户端 - 优先从数据库读取主模型，其次从LLMConfig，最后从环境变量
builder.Services.AddScoped<ILLMClient>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    var config = sp.GetRequiredService<IConfiguration>();
    var gateway = sp.GetRequiredService<PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway>();

    // 1. 优先：从数据库获取主模型 (IsMain=true)
    var mainModel = db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefault();
    if (mainModel != null)
    {
        var (apiUrl, apiKey) = ResolveApiConfigForModel(mainModel, db, config);
        if (!string.IsNullOrWhiteSpace(apiUrl) && !string.IsNullOrWhiteSpace(apiKey))
        {
            return gateway.CreateClient(
                AppCallerRegistry.Admin.Lab.Chat,
                ModelTypes.Chat,
                maxTokens: 4096,
                temperature: 0.7,
                expectedModel: mainModel.ModelName,
                pinnedPlatformId: mainModel.PlatformId,
                pinnedModelId: mainModel.ModelName);
        }
    }
    
    // 2. 其次：从数据库获取活动的 LLMConfig
    var activeConfig = db.LLMConfigs.Find(c => c.IsActive).FirstOrDefault();
    if (activeConfig != null)
    {
        var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(activeConfig.ApiKeyEncrypted, config);
        
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            return gateway.CreateClient(
                AppCallerRegistry.Admin.Lab.Chat,
                ModelTypes.Chat,
                maxTokens: activeConfig.MaxTokens,
                temperature: activeConfig.Temperature,
                expectedModel: activeConfig.Model);
        }
    }
    
    // 3. 最后：回退到环境变量配置
    if (string.IsNullOrWhiteSpace(llmApiKey))
    {
        Log.Warning("No main model or active LLM config found in database and LLM:ClaudeApiKey is not configured. Please set a main model in admin panel or set LLM__ClaudeApiKey environment variable");
    }

    return gateway.CreateClient(
        AppCallerRegistry.Admin.Lab.Chat,
        ModelTypes.Chat,
        maxTokens: 4096,
        temperature: 0.7,
        expectedModel: llmModel);
});

// 辅助方法：解析模型的 API 配置（与 AdminModelsController 中的逻辑一致）
static (string? apiUrl, string? apiKey) ResolveApiConfigForModel(LLMModel model, MongoDbContext db, IConfiguration config)
{
    string? apiUrl = model.ApiUrl;
    string? apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(model.ApiKeyEncrypted, config);

    // 如果模型没有配置，从平台继承
    if (model.PlatformId != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
    {
        var platform = db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefault();
        if (platform != null)
        {
            apiUrl ??= platform.ApiUrl;
            if (string.IsNullOrEmpty(apiKey))
            {
                apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(platform.ApiKeyEncrypted, config);
            }
        }
    }

    return (apiUrl, apiKey);
}

// 注册仓储
builder.Services.AddScoped<IUserRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new UserRepository(db.Users);
});

builder.Services.AddScoped<IInviteCodeRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new InviteCodeRepository(db.InviteCodes);
});

builder.Services.AddScoped<IGroupRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new GroupRepository(db.Groups);
});

builder.Services.AddScoped<IPrdDocumentRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new PrdDocumentRepository(db.Documents);
});

builder.Services.AddScoped<IGroupMemberRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new GroupMemberRepository(db.GroupMembers);
});

builder.Services.AddScoped<IContentGapRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new ContentGapRepository(db.ContentGaps);
});

builder.Services.AddScoped<IMessageRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new MessageRepository(db.Messages);
});

builder.Services.AddScoped<IGroupMessageSeqService>(sp =>
{
    // 生产：使用 Redis INCRBY 2 原子分配一问一答的 (odd, even) seq，保证并发下奇偶严格对应
    var cfg = sp.GetRequiredService<IConfiguration>();
    var redis = cfg["Redis:ConnectionString"] ?? "localhost:6379";
    // 兼容历史数据：用 Mongo 查询该群最大 groupSeq，对齐 Redis key，避免重复 seq 触发唯一索引冲突
    var db = sp.GetRequiredService<MongoDbContext>();
    return new RedisGroupMessageSeqService(redis, db.Messages);
});

builder.Services.AddSingleton<IGroupMessageStreamHub, GroupMessageStreamHub>();

builder.Services.AddScoped<IPrdCommentRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new PrdCommentRepository(db.PrdComments);
});

builder.Services.AddScoped<IModelLabRepository>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new ModelLabRepository(db.ModelLabExperiments, db.ModelLabRuns, db.ModelLabRunItems, db.ModelLabModelSets, db.ModelLabGroups);
});

// 注册登录尝试服务
builder.Services.AddSingleton<ILoginAttemptService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    return new LoginAttemptService(cache, maxAttempts: 5, lockoutMinutes: 15, attemptWindowMinutes: 30);
});

// 注册核心服务
builder.Services.AddScoped<IUserService>(sp =>
{
    var userRepo = sp.GetRequiredService<IUserRepository>();
    var inviteCodeRepo = sp.GetRequiredService<IInviteCodeRepository>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new UserService(userRepo, inviteCodeRepo, idGenerator);
});

builder.Services.AddScoped<IDocumentService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    var parser = sp.GetRequiredService<IMarkdownParser>();
    var docRepo = sp.GetRequiredService<IPrdDocumentRepository>();
    return new DocumentService(cache, parser, docRepo);
});

builder.Services.AddScoped<ISessionService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    var db = sp.GetRequiredService<MongoDbContext>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new PrdAgent.Infrastructure.Services.MongoSessionService(db, idGenerator, cache);
});

builder.Services.AddScoped<IGroupService>(sp =>
{
    var groupRepo = sp.GetRequiredService<IGroupRepository>();
    var memberRepo = sp.GetRequiredService<IGroupMemberRepository>();
    var docRepo = sp.GetRequiredService<IPrdDocumentRepository>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new GroupService(groupRepo, memberRepo, docRepo, idGenerator);
});

builder.Services.AddScoped<IGroupBotService>(sp =>
{
    var userRepo = sp.GetRequiredService<IUserRepository>();
    var groupRepo = sp.GetRequiredService<IGroupRepository>();
    var memberRepo = sp.GetRequiredService<IGroupMemberRepository>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new GroupBotService(userRepo, groupRepo, memberRepo, idGenerator);
});

builder.Services.AddScoped<IGroupNameSuggestionService>(sp =>
{
    var groupService = sp.GetRequiredService<IGroupService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var modelDomainService = sp.GetRequiredService<IModelDomainService>();
    var logger = sp.GetRequiredService<ILogger<GroupNameSuggestionService>>();
    return new GroupNameSuggestionService(groupService, documentService, modelDomainService, logger);
});

builder.Services.AddScoped<IGapDetectionService>(sp =>
{
    var gapRepo = sp.GetRequiredService<IContentGapRepository>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new GapDetectionService(gapRepo, idGenerator);
});

builder.Services.AddScoped<IChatService>(sp =>
{
    var gateway = sp.GetRequiredService<PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var cache = sp.GetRequiredService<ICacheManager>();
    var promptManager = sp.GetRequiredService<IPromptManager>();
    var skillService = sp.GetRequiredService<PrdAgent.Core.Interfaces.ISkillService>();
    var systemPromptService = sp.GetRequiredService<PrdAgent.Core.Interfaces.ISystemPromptService>();
    var userService = sp.GetRequiredService<IUserService>();
    var messageRepo = sp.GetRequiredService<IMessageRepository>();
    var groupSeq = sp.GetRequiredService<IGroupMessageSeqService>();
    var groupHub = sp.GetRequiredService<IGroupMessageStreamHub>();
    var llmCtx = sp.GetRequiredService<ILLMRequestContextAccessor>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new ChatService(gateway, sessionService, documentService, cache, promptManager, skillService, systemPromptService, userService, messageRepo, groupSeq, groupHub, llmCtx, idGenerator);
});

builder.Services.AddScoped<IPreviewAskService>(sp =>
{
    var gateway = sp.GetRequiredService<PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var promptManager = sp.GetRequiredService<IPromptManager>();
    var llmCtx = sp.GetRequiredService<ILLMRequestContextAccessor>();
    var settingsService = sp.GetRequiredService<IAppSettingsService>();
    var systemPromptService = sp.GetRequiredService<PrdAgent.Core.Interfaces.ISystemPromptService>();
    return new PreviewAskService(gateway, sessionService, documentService, promptManager, llmCtx, settingsService, systemPromptService);
});

// 引导讲解体系已删除（去阶段化）

// 注册在线状态服务
builder.Services.AddScoped<IOnlineStatusService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    var userService = sp.GetRequiredService<IUserService>();
    return new OnlineStatusService(cache, userService);
});

// 注册Token用量服务
builder.Services.AddScoped<ITokenUsageService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    return new TokenUsageService(cache);
});

// 注册开放平台服务
builder.Services.AddScoped<IOpenPlatformService>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new PrdAgent.Infrastructure.Services.OpenPlatformServiceImpl(db, idGenerator);
});

// 注册 Agent 开放接口 API Key 服务（海鲜市场开放接口 / Agent 开放入口 M2M 鉴权）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAgentApiKeyService,
    PrdAgent.Infrastructure.Services.AgentApiKeyService>();

// MAP 端基础设施连接（剪贴板配对密钥与 CDS 等部署平台建立信任）
// 详见 spec.cds.map-pairing-protocol.md
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IInfraAgentRuntimeJobQueue,
    PrdAgent.Infrastructure.Services.InfraAgentSessions.InMemoryInfraAgentRuntimeJobQueue>();
builder.Services.AddHostedService<PrdAgent.Api.Services.InfraAgentRuntimeWorker>();
builder.Services.AddHostedService<PrdAgent.Api.Services.InfraAgentSessionCleanupWorker>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IInfraConnectionService,
    PrdAgent.Infrastructure.Services.InfraConnections.InfraConnectionService>();
// CDS 验收报告导入：复用「系统互联」CDS 全局连接，把 CDS 报告增量同步进知识库（一次鉴权，无握手）。
builder.Services.AddScoped<PrdAgent.Api.Services.CdsReportImportService>();
builder.Services.AddHttpClient(
    PrdAgent.Infrastructure.Services.InfraConnections.InfraConnectionService.HttpClientName);
builder.Services.AddHttpClient<PrdAgent.Core.Interfaces.IInfraAgentSessionService,
    PrdAgent.Infrastructure.Services.InfraAgentSessions.InfraAgentSessionService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IInfraAgentHookProfileService,
    PrdAgent.Infrastructure.Services.InfraAgentSessions.InfraAgentHookProfileService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IInfraAgentRuntimeProfileService,
    PrdAgent.Infrastructure.Services.InfraAgentSessions.InfraAgentRuntimeProfileService>();

// 通用对话智能体（见 doc/design.platform.chat-agent.md）。
// 适配层 + 进程内轮次队列 + 后台 worker；对话循环在 agent 运行时的官方 SDK 里，此处没有循环。
builder.Services.Configure<PrdAgent.Infrastructure.Services.ChatAgent.ChatAgentOptions>(
    builder.Configuration.GetSection(
        PrdAgent.Infrastructure.Services.ChatAgent.ChatAgentOptions.SectionName));
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IChatAgentTurnQueue,
    PrdAgent.Infrastructure.Services.ChatAgent.InMemoryChatAgentTurnQueue>();
// 一次性转派的 runId → 发起人台账。必须是 Singleton：工具回调是另一条 HTTP 请求进来的，
// Scoped 的话回调那一侧永远拿到一个空台账，工具会全部因「没有用户身份」而拒绝执行。
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IChatAgentOneOffRunRegistry,
    PrdAgent.Infrastructure.Services.ChatAgent.ChatAgentOneOffRunRegistry>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IChatAgentService,
    PrdAgent.Infrastructure.Services.ChatAgent.ChatAgentService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.ChatAgentTurnWorker>();

// 注册 Claude Agent SDK Sidecar 路由（CLI Agent claude-sdk 执行器使用）
// 详见 doc/design.cds.agent.sdk-executor.md。多实例配置支持本地 / docker-compose / 远程 sandbox 三种部署。
//
// 零配置自启：如果 ClaudeSdkExecutor:AutoConfigureFromEnv=true（默认）且环境变量
// ANTHROPIC_API_KEY 或 CLAUDE_SIDECAR_BASE_URL/CLAUDE_SIDECAR_TOKEN 非空，
// PostConfigure 会自动注入一个 sidecar 实例并打开 Enabled。provider key 可由
// MAP runtime profile 按请求下发，不要求 prd-api 环境一定持有 ANTHROPIC_API_KEY。
builder.Services.Configure<PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarOptions>(
    builder.Configuration.GetSection(
        PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarOptions.SectionName));
builder.Services.PostConfigure<PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarOptions>(opts =>
{
    PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarEnvAutoConfigurator.Apply(opts);
});
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.ClaudeSidecar.InstanceStateRegistry>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IDynamicSidecarRegistry,
    PrdAgent.Infrastructure.Services.ClaudeSidecar.DynamicSidecarRegistry>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IClaudeSidecarRouter,
    PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarRouter>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IInfraAgentRuntimeAdapter,
    PrdAgent.Infrastructure.Services.AgentRuntime.SidecarRuntimeAdapter>();
// Lite 只读审查降级适配器：R1 未闭合 / 官方 sidecar 不可用时的兜底路径（走现有 LLM Gateway）。
// 注册为 Scoped：依赖 Scoped 的 ILlmGateway，避免单例捕获作用域服务（captive dependency）。
// 跨作用域的硬 Stop 不在本轮范围（Lite 只读短任务），运行内取消由 linked CTS 处理。
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.AgentRuntime.GatewayReviewRuntimeAdapter>();
builder.Services.AddHttpClient(
    PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarRouter.HttpClientName);
builder.Services.AddHttpClient(
    PrdAgent.Infrastructure.Services.ClaudeSidecar.DynamicSidecarRegistry.HttpClientName);
builder.Services.AddHostedService<
    PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarHealthChecker>();
builder.Services.AddHostedService<
    PrdAgent.Infrastructure.Services.ClaudeSidecar.CdsSidecarSyncService>();

// 把已登记 ToolName 的专业智能体各包成一把工具，交给通用对话智能体自己转派
// （用户不必先挑智能体）。名单来自 AgentCapabilityRegistry.Delegatable，这里不另抄一份——
// 契约里新增一个可转派智能体，工具自动就位，不会出现「登记了但没人接线」。
// 必须在 AgentToolRegistry 之前注册：它构造时会把这些 IAgentTool 一并收进去。
foreach (var delegatable in PrdAgent.Core.Models.AgentUniverse.AgentCapabilityRegistry.Delegatable)
{
    var capability = delegatable;
    builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.AgentTools.IAgentTool>(sp =>
        new PrdAgent.Api.Services.Toolbox.AgentDelegateTool(
            capability,
            sp.GetRequiredService<IServiceScopeFactory>(),
            sp.GetRequiredService<ILogger<PrdAgent.Api.Services.Toolbox.AgentDelegateTool>>()));
}

// 进程级未处理异常 / 真实请求计数（自检端点的观测值来源，规则 degradation-must-alarm）。
builder.Services.AddSingleton<PrdAgent.Api.Middleware.ApiFaultTracker>();

// Agent Tools 注册表 + 反向调用入口（sidecar 收到 tool_use 后回调主服务）
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IAgentToolRegistry,
    PrdAgent.Infrastructure.Services.AgentTools.AgentToolRegistry>();

// 注册外部授权中心（TAPD / 语雀 / GitHub 凭证聚合，见 doc/design.platform.external-authorization.md）
// Data Protection：凭证字段加密（独立于 Jwt:Secret，避免单点密钥泄露）。
// 系统级外部授权必须跨容器重建长期有效，因此 key ring 存入 MongoDB，而不是临时文件系统。
builder.Services.AddDataProtection()
    .SetApplicationName("PrdAgent");
builder.Services.AddOptions<KeyManagementOptions>().Configure<MongoDbContext>((options, db) =>
{
    options.XmlRepository = new MongoDataProtectionXmlRepository(db);
});
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IExternalAuthorizationService,
    PrdAgent.Infrastructure.Services.Authorization.ExternalAuthorizationService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAuthTypeHandler,
    PrdAgent.Infrastructure.Services.Authorization.TapdAuthHandler>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAuthTypeHandler,
    PrdAgent.Infrastructure.Services.Authorization.YuqueAuthHandler>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IAuthTypeHandler,
    PrdAgent.Infrastructure.Services.Authorization.GitHubAuthHandler>();

// 注册 Webhook 通知服务。Webhook URL 由用户配置，禁用自动重定向防止绕过首跳 SSRF 校验。
builder.Services.AddHttpClient("WebhookClient")
    .ConfigurePrimaryHttpMessageHandler(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory>().CreateHandler());
builder.Services.AddHttpClient("webhook")
    .ConfigurePrimaryHttpMessageHandler(sp =>
        sp.GetRequiredService<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory>().CreateHandler());
builder.Services.AddHttpClient("TapdBugAgent", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
})
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
    {
        AllowAutoRedirect = false
    });
builder.Services.AddHttpClient("GitHubApi", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.Add("User-Agent", "PrdAgent-PrReview");
    client.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json");
    client.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
});
// GitHub 基础设施层（供 pr-review / 未来的日报/检测等多应用复用）
// 独立于业务层的通用 GitHub REST 封装：per-user OAuth Device Flow + PR 操作客户端
builder.Services.AddScoped<PrdAgent.Infrastructure.GitHub.IGitHubOAuthService,
    PrdAgent.Infrastructure.GitHub.GitHubOAuthService>();
builder.Services.AddScoped<PrdAgent.Infrastructure.GitHub.IGitHubClient,
    PrdAgent.Infrastructure.GitHub.GitHubPrClient>();
// per-user GitHub 连接的唯一判定源（连接状态 / token 解密 / 仓库·分支·目录读取）。
// 知识库 GitHub 同步、共用连接中心 /api/github/* 都走它，避免各应用再抄一份 Device Flow。
builder.Services.AddScoped<PrdAgent.Infrastructure.GitHub.GitHubUserConnectionService>();

// PR Review V2（pr-review）业务层服务 —— 消费上面的 GitHub 基础设施
builder.Services.AddScoped<PrdAgent.Api.Services.PrReview.PrAlignmentService>();
builder.Services.AddScoped<PrdAgent.Api.Services.PrReview.PrSummaryService>();
// 注册自动化引擎（需要在 WebhookNotificationService 之前注册）
builder.Services.AddScoped<IActionExecutor, PrdAgent.Infrastructure.Services.Automation.WebhookActionExecutor>();
builder.Services.AddScoped<IActionExecutor, PrdAgent.Infrastructure.Services.Automation.AdminNotificationActionExecutor>();
builder.Services.AddScoped<IAutomationHub, PrdAgent.Infrastructure.Services.Automation.AutomationHub>();

builder.Services.AddScoped<IWebhookNotificationService>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    var openPlatformService = sp.GetRequiredService<IOpenPlatformService>();
    var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var automationHub = sp.GetRequiredService<IAutomationHub>();
    var logger = sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.Services.WebhookNotificationService>>();
    return new PrdAgent.Infrastructure.Services.WebhookNotificationService(db, openPlatformService, httpClientFactory, automationHub, logger);
});

// 桌面更新加速服务
builder.Services.AddHttpClient("GitHubUpdate", client =>
{
    client.Timeout = TimeSpan.FromSeconds(120);
    client.DefaultRequestHeaders.Add("User-Agent", "PrdAgent-UpdateAccelerator");
});
builder.Services.AddSingleton<PrdAgent.Api.Services.DesktopUpdateAccelerator>();

// 注册缺口通知服务
builder.Services.AddScoped<IGapNotificationService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    var groupService = sp.GetRequiredService<IGroupService>();
    return new GapNotificationService(cache, groupService);
});

var app = builder.Build();

// 初始化数据库（创建管理员账号和初始邀请码）
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
    var idGenerator = scope.ServiceProvider.GetRequiredService<IIdGenerator>();
    var initializer = new DatabaseInitializer(
        db,
        idGenerator,
        builder.Configuration);
    await initializer.InitializeAsync();
}

// 初始化系统角色缓存（内置角色从代码加载，自定义角色从数据库加载）
{
    var roleCache = app.Services.GetRequiredService<ISystemRoleCacheService>();
    await roleCache.InitializeAsync();
}

// 配置中间件
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// local 只属于本地开发环境。IAssetStorage 返回的 /local-assets URL 必须由应用
// 自己真实提供，否则“内部读取成功”会掩盖浏览器访问 404。CDS 固定走 R2、正式
// 环境固定走 Tencent COS，均不会启用此文件系统映射。
var assetStorageRuntime = app.Services.GetRequiredService<IAssetStorageRuntimeInfo>();
if (string.Equals(
        AssetStorageReadinessProbe.CanonicalProvider(assetStorageRuntime.ProviderName),
        "local",
        StringComparison.Ordinal))
{
    var localAssetDir = (builder.Configuration["ASSETS_LOCAL_DIR"] ?? string.Empty).Trim();
    if (string.IsNullOrWhiteSpace(localAssetDir))
        localAssetDir = Path.Combine(app.Environment.ContentRootPath, "data", "assets");
    Directory.CreateDirectory(localAssetDir);
    app.UseStaticFiles(LocalAssetStaticFilePolicy.CreateOptions(localAssetDir));
}

// 始终启用"单行 Request finished 摘要日志"（不包含 body，且默认跳过 OPTIONS），用于确认请求是否到达和返回结果
// 观测：把穿透整个管道的异常与真实请求数变成机器读得到的数（规则 degradation-must-alarm）。
// 必须在最外层——被内层组件处理掉的异常不会走到这里，而 2026-09-09 那次事故的异常
// 正是一路穿透到 Kestrel 才被记录的。只记不吞。
app.UseMiddleware<PrdAgent.Api.Middleware.ApiFaultTrackingMiddleware>();
app.UseRequestResponseLogging();

app.UseExceptionMiddleware();
app.UseCors();
app.Use(async (context, next) =>
{
    var provided = context.Request.Headers["X-Llmgw-Shadow-Sample-Key"].ToString().Trim();
    if (string.IsNullOrWhiteSpace(provided))
    {
        await next();
        return;
    }

    var expected = (builder.Configuration["LlmGwServe:ApiKey"] ?? string.Empty).Trim();
    if (!FixedTimeEqualsNonEmpty(expected, provided))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }

    var accessor = context.RequestServices.GetRequiredService<ILLMRequestContextAccessor>();
    using var _ = accessor.BeginScope(new LlmRequestContext(
        RequestId: context.TraceIdentifier,
        GroupId: null,
        SessionId: null,
        UserId: null,
        ViewRole: null,
        DocumentChars: null,
        DocumentHash: null,
        SystemPromptRedacted: null,
        ForceFullShadowSample: true));
    await next();
});
app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(20),
});
app.UseAuthentication();
// 限流必须位于认证之后，否则所有已登录用户都会退化为共享代理 IP 桶，
// SSE 长连接还会长期占用同一并发计数，导致同出口用户互相触发 RATE_LIMITED。
app.UseRateLimiting();
// 认证通过后做滑动续期（默认 7 天，Auth:SessionSlidingDays 可调，按端独立）
app.UseMiddleware<AuthSlidingExpirationMiddleware>();
// 统一记录"最后操作时间"（仅写请求 + 成功响应）
app.UseMiddleware<PrdAgent.Api.Middleware.UserLastActiveMiddleware>();
app.UseAuthorization();
// 管理后台权限（菜单/页面/接口统一绑定 permission key）
app.UseMiddleware<PrdAgent.Api.Middleware.AdminPermissionMiddleware>();
// 权限指纹：每个响应注入 X-Perm-Fingerprint，前端据此判断是否需要刷新权限缓存
app.UseMiddleware<PrdAgent.Api.Middleware.PermissionFingerprintMiddleware>();
app.MapControllers();

// 健康检查端点
app.MapGet("/health", HealthCheck);
// 就绪分工（本分支）：/health/ready 回「应用整体就绪」，对象存储单独挂 /health/assets/ready，
// 免得存储抖一下就把整个应用判成未就绪。主干新增的深度自检按原样保留。
app.MapGet("/health/ready", ApplicationReadiness);
app.MapGet("/api/health/ready", ApplicationReadiness);
app.MapGet("/health/assets/ready", AssetStorageReadiness);
// 深度自检（2026-09-11，监控自发现协议 doc/spec.platform.monitor-discovery.md）。
//
// 与 /health 的分工：那个回「进程还活着」，这个**真把关键链路走一遍**，逐项给定量结论，
// 并在每条 check 上自报「该怎么监控我」——CDS 插上这个地址就能把监控项建起来。
//
// 免鉴权：CDS 探针刻意不携带任何密钥（探测令牌绝不发给外部地址）。所以这里
// 只回计数、耗时与口径，不回任何业务内容、地址或异常文本。
// 始终回 200：回 503 会让 CDS 先撞上状态码规则，错误退化成「HTTP 503 不在期望范围」，
// 而不是「observedValue=3，期望 eq 0」——后者才排得动障。
app.MapGet("/api/healthz/deep", DeepHealth).AllowAnonymous();
app.MapGet("/api/v", VersionInfo);
app.MapGet("/api/version", VersionInfo);

// 启动时输出"实际监听端口/前端默认端口提示"
app.Lifetime.ApplicationStarted.Register(() =>
{
    Log.Information("API listening on: {Urls}", app.Urls);
    Log.Information("Admin Web 默认: http://localhost:8000 （可通过 prd-admin: PORT=xxxx pnpm dev 修改）");
    Log.Information("Desktop Dev 默认: http://localhost:1420");

    // Root 破窗账户状态
    var rootUsername = (builder.Configuration["ROOT_ACCESS_USERNAME"] ?? string.Empty).Trim();
    var rootPassword = (builder.Configuration["ROOT_ACCESS_PASSWORD"] ?? string.Empty).Trim();
    var rootEnabled = !string.IsNullOrWhiteSpace(rootUsername) && !string.IsNullOrWhiteSpace(rootPassword);
    if (rootEnabled)
    {
        Log.Warning("Root 破窗账户已启用，用户名: {RootUsername}", rootUsername);
    }
    else
    {
        Log.Information("Root 破窗账户未配置（如需启用，请设置 ROOT_ACCESS_USERNAME 和 ROOT_ACCESS_PASSWORD）");
    }
});

app.Run();

// 健康检查处理函数
static IResult HealthCheck()
{
    var response = new HealthCheckResponse
    {
        Status = "healthy",
        Version = "1.0.0",
        Timestamp = DateTime.UtcNow
    };
    return Results.Ok(response);
}

/// <summary>
/// 深度自检：真跑一次 Mongo 往返，加上进程级的异常与流量计数，每条都自报怎么监控。
/// </summary>
static async Task<IResult> DeepHealth(
    PrdAgent.Api.Middleware.ApiFaultTracker faults,
    PrdAgent.Infrastructure.Database.MongoDbContext db,
    PrdAgent.Infrastructure.Database.LlmGatewayDataContext gatewayDb,
    PrdAgent.Api.Services.IVisualModelPolicyService visualModels,
    PrdAgent.Core.LlmGateway.IModelResolver modelResolver,
    PrdAgent.Infrastructure.Services.ModelCatalogContractProbe modelCatalogContract,
    IHostEnvironment hostEnvironment,
    CancellationToken cancellationToken)
{
    var now = DateTime.UtcNow;
    var faultCount = faults.CountWithinWindow();
    var requests = faults.RequestsWithinWindow();
    var deploymentIdentity = ReadBuildIdentity();
    // 开发机直接 dotnet run 时可能没有部署目标；生产环境必须同时取得两端并严格对账。
    // 预览和正式容器都以 Production 启动，因此缺证据同样会被挡住。
    var deploymentIdentityFailures = deploymentIdentity.Match switch
    {
        BuildIdentity.MatchState.Match => 0,
        BuildIdentity.MatchState.Mismatch => 1,
        _ => hostEnvironment.IsProduction() ? 1 : 0,
    };
    var deploymentIdentityOutput = deploymentIdentity.Match switch
    {
        BuildIdentity.MatchState.Match =>
            $"运行二进制与部署目标一致（{ShortCommit(deploymentIdentity.ActualCommit)}）",
        BuildIdentity.MatchState.Mismatch =>
            BuildIdentity.DescribeMismatch(
                deploymentIdentity.Match,
                deploymentIdentity.ActualCommit,
                deploymentIdentity.DeclaredCommit)
            ?? "运行二进制与部署目标不一致",
        _ => "无法取得运行二进制或部署目标的 commit，不能证明当前运行版本正确",
    };

    // Mongo 往返：这是「后端还能不能干活」最便宜的那条真链路。
    // 探不通时把耗时记成 -1 而不是 0——0 会被判据读成「快得惊人」，是个假绿。
    long mongoMs;
    string mongoOutput;
    try
    {
        var started = System.Diagnostics.Stopwatch.StartNew();
        await db.Database.RunCommandAsync<MongoDB.Bson.BsonDocument>(
            new MongoDB.Bson.BsonDocument("ping", 1), cancellationToken: cancellationToken);
        mongoMs = started.ElapsedMilliseconds;
        mongoOutput = $"Mongo 往返 {mongoMs} 毫秒";
    }
    catch (Exception ex)
    {
        mongoMs = -1;
        mongoOutput = $"Mongo 探不通：{ex.GetType().Name}";
    }

    // 榜单快照的陈旧度。这是「同步链路还活着吗」唯一不靠人去点就能读到的信号：
    // 抓取失败时 SyncService 刻意保留旧快照（宁可旧也不写空），读端点照样 200，
    // 页面上只有一个需要人打开才看得见的 stale 标签——降级把一次持续失败翻译成了一次
    // 表面成功（degradation-must-alarm.md）。所以这里对**症状**（数据多旧）而不是
    // 原因（哪次抓取失败）暴露一条机读判据。
    //
    // 两条命门（都是 Codex 在 PR #1538 指出的，两条都会让这个 check 变成一盏永远不亮的灯）：
    //
    // 1. **哨兵值必须判失败**。第一版在「一条快照都没有」时把值设成 -1，注释还写着
    //    「判据会判失败」——而判据是 `lte 48`，-1 当然小于 48，于是同步从来没跑起来过的
    //    部署会永远绿。哨兵值要选在判据的**失败侧**，不能凭直觉挑一个「看起来异常」的数。
    //    这里统一用 UnhealthySentinel（远大于阈值），任何取不到数的分支都走它。
    //
    // 2. **要看覆盖，不只看最旧的那条**。每个榜的失败是各自 catch 的，成功的照写。
    //    于是「十一个榜里只有一个同步成功」会让这条查询拿到一份很新的快照而判绿，
    //    另外十个维度在页面上永远空着却无人告警。所以先比对目录里声明的榜是否都在库里，
    //    缺了就直接判失败——覆盖不全比数据旧更严重。
    const double leaderboardUnhealthySentinel = 9999;
    double leaderboardStaleHours;
    string leaderboardOutput;
    try
    {
        // 只看「本部署该看的那些」：分支预览与权威部署各写各的文档
        // （PrdAgent.Api.Services.ModelLeaderboard.ModelLeaderboardScope），
        // 自检要判的是**页面上实际显示的那份**陈不陈旧，不是库里所有部署的文档。
        var snapshots = await db.ModelLeaderboardSnapshots
            .Find(PrdAgent.Api.Services.ModelLeaderboard.ModelLeaderboardScope.VisibleFilter())
            .Project(x => new { x.Board, x.FetchedAt, x.DeploymentSlug })
            .ToListAsync(cancellationToken);

        var storedBoards = snapshots
            .Select(x => x.Board)
            .Where(b => !string.IsNullOrWhiteSpace(b))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var missingBoards = PrdAgent.Api.Services.ModelLeaderboard.ModelLeaderboardCatalog.Keys
            .Where(k => !storedBoards.Contains(k))
            .ToArray();

        if (snapshots.Count == 0)
        {
            leaderboardStaleHours = leaderboardUnhealthySentinel;
            leaderboardOutput = "一个榜单快照都没有——周期同步从来没成功跑完过，"
                + "整个模型排行榜页面是空的；去看容器日志里 ModelLeaderboardSync 的告警";
        }
        else if (missingBoards.Length > 0)
        {
            leaderboardStaleHours = leaderboardUnhealthySentinel;
            leaderboardOutput = $"缺 {missingBoards.Length} 个榜的快照（{string.Join("、", missingBoards)}）——"
                + "这些维度在页面上是空的；去看容器日志里这几个榜的同步告警";
        }
        else
        {
            // 每个榜取**它自己最新的那份**，再在这些里面挑最旧的。
            //
            // 不能直接对全量文档取最旧（Codex 在 PR #1538 指出）：首次写的并发窗口
            // （已在本 PR 修掉，但可能已经在库里留下残留）会让同一个榜有两条文档，
            // 而同步只更新其中一条、从不删另一条。覆盖判断用的是集合、不受影响，
            // 但陈旧度会一直盯着那条永远不再更新的孤儿，48 小时后这条 check 就永久告警，
            // 而实际上每个榜都在正常同步——一条永远响的铃和一条永远不响的铃同样没用。
            // 挑「哪一份是这个榜当前生效的」用与三个读取点同一个函数，不再各写一遍排序。
            // 一条都挑不出来时 First() 会抛，被外层 catch 接住落到失败侧哨兵——
            // 这正是想要的：读不出「页面在显示哪一份」就不能判绿。
            var oldest = snapshots
                .GroupBy(x => x.Board, StringComparer.OrdinalIgnoreCase)
                .Select(g => PrdAgent.Api.Services.ModelLeaderboard.ModelLeaderboardScope.PickVisible(
                    g.ToList(), x => x.DeploymentSlug, x => x.FetchedAt))
                .Where(x => x is not null)
                .OrderBy(x => x!.FetchedAt)
                .First()!;
            leaderboardStaleHours = Math.Round((now - oldest.FetchedAt).TotalHours, 1);
            leaderboardOutput = leaderboardStaleHours <= 48
                ? $"{storedBoards.Count} 个榜都有快照，最旧的一份是 {leaderboardStaleHours} 小时前的（{oldest.Board}）"
                : $"最旧的榜单快照已经 {leaderboardStaleHours} 小时没更新（{oldest.Board}）——"
                  + "同步大概率连着失败了，去看容器日志里 ModelLeaderboardSync 的告警";
        }
    }
    catch (Exception ex)
    {
        // 读不到就是读不到，不能判绿（同上：哨兵必须在失败侧）
        leaderboardStaleHours = leaderboardUnhealthySentinel;
        leaderboardOutput = $"读榜单快照失败：{ex.GetType().Name}";
    }

    // 生图路由预检：这里不调生图上游、不花生图费用，但会用与真实同步生图相同的
    // 场景身份和逻辑模型进入调度器。它专门抓“目录里能选，点生成却被白名单拒绝”：
    // 普通 /health 会绿、Mongo 会绿、模型目录也会绿，只有按真实 appCaller 解析才能提前看出契约断了。
    var visualImageRouteFailures = 1;
    string visualImageRouteOutput;
    try
    {
        var policy = await visualModels.ReadAsync(cancellationToken);
        var openModels = policy.Models
            .Select(x => x.ModelId?.Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var defaultModel = policy.DefaultModelId?.Trim() ?? string.Empty;
        if (openModels.Count == 0 || string.IsNullOrWhiteSpace(defaultModel))
        {
            visualImageRouteOutput = "视觉创作没有配置开放模型或默认生图模型";
        }
        else
        {
            var failures = new List<string>();
            var coveredModels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var checkedRoutes = 0;
            foreach (var appCaller in PrdAgent.Api.Services.VisualModelPolicyService.AppCallers)
            {
                var catalog = await visualModels.DiscoverAsync(appCaller, cancellationToken);
                foreach (var model in catalog
                    .Select(x => x.Model.Code)
                    .Where(openModels.Contains)
                    .Distinct(StringComparer.OrdinalIgnoreCase))
                {
                    coveredModels.Add(model);
                    checkedRoutes++;
                    var resolution = await modelResolver.ResolveAsync(
                        appCaller,
                        PrdAgent.Core.Models.ModelTypes.ImageGen,
                        model,
                        ct: cancellationToken);
                    if (!resolution.Success)
                    {
                        failures.Add($"{model}:{resolution.FailureCode ?? "UNCLASSIFIED"}");
                    }
                }
            }

            foreach (var missing in openModels.Except(coveredModels, StringComparer.OrdinalIgnoreCase))
            {
                failures.Add($"{missing}:NOT_IN_SCENARIO_CATALOG");
            }

            var textCatalog = await visualModels.DiscoverAsync(
                PrdAgent.Api.Controllers.Api.ImageGenController.ResolveGenerateAppCallerCode(
                    isLayering: false,
                    imageCount: 0,
                    hasLegacyReference: false),
                cancellationToken);
            if (!textCatalog.Any(x => string.Equals(x.Model.Code, defaultModel, StringComparison.OrdinalIgnoreCase)))
            {
                failures.Add($"{defaultModel}:DEFAULT_NOT_TEXT2IMG");
            }

            visualImageRouteFailures = failures.Count;
            visualImageRouteOutput = failures.Count == 0
                ? $"{openModels.Count} 个开放模型的 {checkedRoutes} 条生图场景路由均可解析"
                : $"生图场景路由有 {failures.Count} 处失配：{string.Join("、", failures.Take(5))}";
        }
    }
    catch (Exception ex)
    {
        visualImageRouteOutput = $"默认生图路由预检失败：{ex.GetType().Name}";
    }

    // 业务选择器与执行链路必须使用同一个稳定模型身份。只看“目录非空”会漏掉最危险的
    // 情况：页面展示旧模型池成员名，但运行时只接受 LLM Gateway PublicId。该探针对所有
    // 仍消费 IModelPoolQueryService 的核心入口执行同一份目录 -> 默认 -> 指定模型闭环。
    var modelCatalogResult = await modelCatalogContract.CheckAsync(cancellationToken);

    // 生图真实调用结果：路由预检只能证明「现在能解析」，不能证明上一笔真实请求有没有
    // 被上游或网关拒绝。过去只盯未处理异常，而模型不开放、能力不匹配、上游 4xx/5xx
    // 都会被业务层转成结构化失败，进程没有抛异常，监控因此永远绿。
    //
    // 这里读取网关已经脱敏的请求日志，只看最近 6 小时内 MAP 三个生图场景的最终状态。
    // 判据用「最新连续失败数」而不是窗口失败总数：故障后成功一次即表示链路已经恢复，
    // CDS 会留下故障/恢复事件；旧失败不会让红灯再挂 6 小时。
    var visualImageRecentRequests = 0;
    var visualImageConsecutiveFailures = -1;
    const long visualImageLatencyBudgetMs = 180_000;
    long visualImageLatestSuccessDurationMs = 0;
    string visualImageOutcomeOutput;
    string visualImageLatencyOutput;
    try
    {
        var imageCallers = PrdAgent.Api.Services.VisualModelPolicyService.AppCallers;
        var since = now.AddMinutes(-faults.WindowMinutes);
        var filter = MongoDB.Driver.Builders<PrdAgent.Core.Models.LlmRequestLog>.Filter.And(
            MongoDB.Driver.Builders<PrdAgent.Core.Models.LlmRequestLog>.Filter.Gte(x => x.StartedAt, since),
            MongoDB.Driver.Builders<PrdAgent.Core.Models.LlmRequestLog>.Filter.In(x => x.AppCallerCode, imageCallers),
            MongoDB.Driver.Builders<PrdAgent.Core.Models.LlmRequestLog>.Filter.Ne(x => x.Status, "running"));
        var outcomes = await gatewayDb.LlmRequestLogs
            .Find(filter)
            .SortByDescending(x => x.StartedAt)
            .Limit(20)
            .Project(x => new { x.Status, x.DurationMs })
            .ToListAsync(cancellationToken);
        visualImageRecentRequests = outcomes.Count;
        visualImageConsecutiveFailures = outcomes.TakeWhile(x => x.Status != "succeeded").Count();
        var latestSuccess = outcomes.FirstOrDefault(x => x.Status == "succeeded");
        visualImageLatestSuccessDurationMs = Math.Max(0, latestSuccess?.DurationMs ?? 0);
        visualImageOutcomeOutput = outcomes.Count == 0
            ? $"最近 {faults.WindowMinutes} 分钟没有生图真实调用，无法用真实结果证明链路可用"
            : visualImageConsecutiveFailures == 0
                ? $"最近一笔生图真实调用成功；窗口内采样 {outcomes.Count} 笔"
                : $"最近连续 {visualImageConsecutiveFailures} 笔生图真实调用失败；详情见网关调用日志";
        visualImageLatencyOutput = latestSuccess == null
            ? $"最近 {faults.WindowMinutes} 分钟没有成功的生图调用，无法评估响应耗时"
            : visualImageLatestSuccessDurationMs <= visualImageLatencyBudgetMs
                ? $"最近一笔成功生图耗时 {visualImageLatestSuccessDurationMs}ms，处于 180000ms 体验预算内"
                : $"最近一笔成功生图耗时 {visualImageLatestSuccessDurationMs}ms，超过 180000ms 体验预算；详情见网关调用日志";
    }
    catch (Exception ex)
    {
        visualImageOutcomeOutput = $"读取生图真实调用结果失败：{ex.GetType().Name}";
        visualImageLatencyOutput = $"读取生图响应耗时失败：{ex.GetType().Name}";
    }

    var payload = new Dictionary<string, object?>
    {
        ["status"] = faultCount == 0 && mongoMs >= 0 && deploymentIdentityFailures == 0
            && visualImageRouteFailures == 0
            && modelCatalogResult.FailureCount == 0
            && visualImageConsecutiveFailures == 0 ? "pass" : "fail",
        ["version"] = "1",
        ["serviceId"] = "prd-api",
        ["description"] = "MAP 后端深度自检",
        ["time"] = now.ToString("o"),
        // check 用 Dictionary 而不是匿名对象：自描述段的键是 `cds:monitor`，带冒号，
        // 匿名类型的属性名写不出来。
        ["checks"] = new Dictionary<string, object[]>
        {
            ["api:unhandled-exceptions"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "api.unhandled-exceptions",
                    ["componentType"] = "system",
                    ["observedValue"] = faultCount,
                    ["observedUnit"] = "count",
                    ["status"] = faultCount == 0 ? "pass" : "fail",
                    ["time"] = now.ToString("o"),
                    ["output"] = faultCount == 0
                        ? $"最近 {faults.WindowMinutes} 分钟无未处理异常"
                        : $"最近 {faults.WindowMinutes} 分钟出现 {faultCount} 次未处理异常，累计 {faults.TotalSinceStart} 次；详情见容器日志",
                    ["cds:monitor"] = new
                    {
                        name = "MAP 后端近期未处理异常数",
                        field = "observedValue",
                        op = "eq",
                        value = 0,
                        intervalSeconds = 21600,
                        failuresToAlarm = 1,
                        severity = "P0",
                        observeMode = "passive",
                        sampleComponentId = "api.requests",
                        // 自称生产：跑在分支预览上时 CDS 会按地址判成分支预览并压过这句自称，
                        // 所以写 production 不会让临时分支混进负责人的第一屏。
                        environment = "production",
                        // 对外只出业务名与红绿，不出地址、判据、日志——所以这条可以公开。
                        publicVisible = true,
                        publicName = "MAP 后端",
                    },
                },
            },
            ["model-leaderboard:staleness"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "model-leaderboard.staleness",
                    ["componentType"] = "datastore",
                    ["observedValue"] = leaderboardStaleHours,
                    ["observedUnit"] = "h",
                    // 与下面 cds:monitor 的 op/value 同一个判据，两处不许各写一遍：
                    // 拿不到数的分支已经把值置成远大于阈值的哨兵，这里不必再判一次「是不是 -1」
                    ["status"] = leaderboardStaleHours <= 48 ? "pass" : "warn",
                    ["time"] = now.ToString("o"),
                    ["output"] = leaderboardOutput,
                    ["cds:monitor"] = new
                    {
                        name = "模型榜快照陈旧度",
                        field = "observedValue",
                        // 同步是每天一轮，容忍连着两轮失败（48 小时）再响——与页面上 stale
                        // 标签同一个阈值，两处不许各定一个
                        op = "lte",
                        value = 48,
                        intervalSeconds = 21600,
                        failuresToAlarm = 1,
                        severity = "P2",
                        // 不设 observeMode：这条是**主动读一次状态**，走默认的 active。
                        //
                        // 第一版照抄了上面那条未处理异常的 passive + sampleComponentId，但那两条的
                        // 形状根本不同：那条判的是「窗口内出了几次异常」，要配一个**另一条 check**
                        // 给出的请求量才有意义，所以 sampleComponentId 指向 api.requests。
                        // 这条我却让它指向自己，于是 CDS 会把「快照多旧」同时当成判据值和样本量——
                        // 刚同步完那一刻值是 0，面板上会显示「0 次真实调用」而拒绝判绿；平时显示
                        // 12.4，又像是 12 次请求（Codex 在 PR #1538 指出）。
                    },
                },
            },
            ["api:requests"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "api.requests",
                    ["componentType"] = "system",
                    ["observedValue"] = requests,
                    ["observedUnit"] = "count",
                    ["status"] = requests > 0 ? "pass" : "warn",
                    ["time"] = now.ToString("o"),
                    ["output"] = requests > 0
                        ? $"最近 {faults.WindowMinutes} 分钟有 {requests} 次真实调用"
                        : $"最近 {faults.WindowMinutes} 分钟没有任何真实调用——上面那条零异常不作数",
                    ["cds:monitor"] = new
                    {
                        name = "MAP 后端近期真实调用数",
                        field = "observedValue",
                        op = "gt",
                        value = 0,
                        intervalSeconds = 21600,
                        failuresToAlarm = 2,
                        severity = "P2",
                        environment = "production",
                        // 「有没有人在用」是内部判据，对外说它没有意义，不公开。
                        publicVisible = false,
                    },
                },
            },
            ["deployment:version-match"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "deployment.version-match",
                    ["componentType"] = "system",
                    ["observedValue"] = deploymentIdentityFailures,
                    ["observedUnit"] = "count",
                    ["status"] = deploymentIdentity.Match == BuildIdentity.MatchState.Unknown
                        && deploymentIdentityFailures == 0
                            ? "warn"
                            : deploymentIdentityFailures == 0 ? "pass" : "fail",
                    ["time"] = now.ToString("o"),
                    ["output"] = deploymentIdentityOutput,
                    ["actualCommit"] = ShortCommit(deploymentIdentity.ActualCommit),
                    ["expectedCommit"] = ShortCommit(deploymentIdentity.DeclaredCommit),
                    ["cds:monitor"] = new
                    {
                        name = "MAP 运行版本与发布目标一致性",
                        field = "observedValue",
                        op = "eq",
                        value = 0,
                        intervalSeconds = 300,
                        failuresToAlarm = 1,
                        severity = "P0",
                        environment = "production",
                        publicVisible = true,
                        publicName = "MAP 发布版本",
                    },
                },
            },
            ["visual-image:default-route"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "visual-image.default-route",
                    ["componentType"] = "service",
                    ["observedValue"] = visualImageRouteFailures,
                    ["observedUnit"] = "count",
                    ["status"] = visualImageRouteFailures == 0 ? "pass" : "fail",
                    ["time"] = now.ToString("o"),
                    ["output"] = visualImageRouteOutput,
                    ["cds:monitor"] = new
                    {
                        name = "MAP 生图模型场景路由",
                        field = "observedValue",
                        op = "eq",
                        value = 0,
                        intervalSeconds = 300,
                        failuresToAlarm = 1,
                        severity = "P0",
                        environment = "production",
                        publicVisible = true,
                        publicName = "MAP 生图模型",
                    },
                },
            },
            ["model-catalog:selector-runtime-contract"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "model-catalog.selector-runtime-contract",
                    ["componentType"] = "service",
                    ["observedValue"] = modelCatalogResult.FailureCount,
                    ["observedUnit"] = "count",
                    ["targetCount"] = modelCatalogResult.TargetCount,
                    ["catalogEntryCount"] = modelCatalogResult.CatalogEntryCount,
                    ["status"] = modelCatalogResult.FailureCount == 0 ? "pass" : "fail",
                    ["time"] = now.ToString("o"),
                    ["output"] = modelCatalogResult.Output,
                    ["cds:monitor"] = new
                    {
                        name = "MAP 业务模型目录与运行时可用性一致性",
                        field = "observedValue",
                        op = "eq",
                        value = 0,
                        intervalSeconds = 21600,
                        environment = "production",
                        publicVisible = true,
                        publicName = "MAP 业务模型目录",
                    },
                },
            },
            ["visual-image:recent-outcomes"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "visual-image.recent-outcomes",
                    ["componentType"] = "service",
                    ["observedValue"] = visualImageConsecutiveFailures,
                    ["observedUnit"] = "count",
                    ["status"] = visualImageConsecutiveFailures == 0
                        ? (visualImageRecentRequests > 0 ? "pass" : "warn")
                        : "fail",
                    ["time"] = now.ToString("o"),
                    ["output"] = visualImageOutcomeOutput,
                    ["cds:monitor"] = new
                    {
                        name = "MAP 生图近期真实调用结果",
                        field = "observedValue",
                        op = "eq",
                        value = 0,
                        intervalSeconds = 300,
                        failuresToAlarm = 1,
                        severity = "P0",
                        observeMode = "passive",
                        sampleComponentId = "visual-image.requests",
                        environment = "production",
                        publicVisible = true,
                        publicName = "MAP 生图真实调用",
                    },
                },
            },
            ["visual-image:requests"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "visual-image.requests",
                    ["componentType"] = "service",
                    ["observedValue"] = visualImageRecentRequests,
                    ["observedUnit"] = "count",
                    ["status"] = visualImageRecentRequests > 0 ? "pass" : "warn",
                    ["time"] = now.ToString("o"),
                    ["output"] = visualImageRecentRequests > 0
                        ? $"最近 {faults.WindowMinutes} 分钟采样到 {visualImageRecentRequests} 笔生图真实调用"
                        : $"最近 {faults.WindowMinutes} 分钟没有生图真实调用",
                    ["cds:monitor"] = new
                    {
                        name = "MAP 生图近期真实调用数",
                        field = "observedValue",
                        op = "gt",
                        value = 0,
                        intervalSeconds = 21600,
                        failuresToAlarm = 2,
                        severity = "P2",
                        environment = "production",
                        publicVisible = false,
                    },
                },
            },
            ["visual-image:latency"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "visual-image.latency",
                    ["componentType"] = "service",
                    ["observedValue"] = visualImageLatestSuccessDurationMs,
                    ["observedUnit"] = "ms",
                    ["status"] = visualImageLatestSuccessDurationMs == 0
                        ? "warn"
                        : visualImageLatestSuccessDurationMs <= visualImageLatencyBudgetMs ? "pass" : "warn",
                    ["time"] = now.ToString("o"),
                    ["output"] = visualImageLatencyOutput,
                    ["cds:monitor"] = new
                    {
                        name = "MAP 生图最近成功响应耗时",
                        field = "observedValue",
                        op = "lte",
                        value = visualImageLatencyBudgetMs,
                        intervalSeconds = 300,
                        failuresToAlarm = 1,
                        severity = "P1",
                        observeMode = "passive",
                        sampleComponentId = "visual-image.requests",
                        environment = "production",
                        publicVisible = true,
                        publicName = "MAP 生图响应耗时",
                    },
                },
            },
            ["db:roundtrip"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["componentId"] = "db.roundtrip",
                    ["componentType"] = "datastore",
                    ["observedValue"] = mongoMs,
                    ["observedUnit"] = "ms",
                    ["status"] = mongoMs >= 0 && mongoMs < 2000 ? "pass" : "fail",
                    ["time"] = now.ToString("o"),
                    ["output"] = mongoOutput,
                    // 这条按 5 分钟一次：它是会变的量（往返耗时），高频才看得出趋势；
                    // 上面两条是计数器，6 小时一次足够。节奏由每条 check 自己说，
                    // 不是整个端点一个频率——这正是把声明放在服务这一侧的好处。
                    ["cds:monitor"] = new
                    {
                        name = "MAP 数据库往返耗时",
                        field = "observedValue",
                        op = "lt",
                        value = 2000,
                        intervalSeconds = 300,
                        failuresToAlarm = 2,
                        severity = "P1",
                        environment = "production",
                        publicVisible = true,
                        publicName = "MAP 数据库",
                    },
                },
            },
        },
    };

    return Results.Content(
        System.Text.Json.JsonSerializer.Serialize(payload),
        "application/health+json");
}

static async Task<IResult> AssetStorageReadiness(
    AssetStorageReadinessProbe probe,
    HttpContext context,
    CancellationToken cancellationToken,
    bool force = false)
{
    if (force && !AssetStorageReadinessProbe.CanForceProbe(
            context.Connection.RemoteIpAddress))
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }
    var result = await probe.CheckAsync(
        force: force,
        cancellationToken: cancellationToken);
    var statusCode = string.Equals(result.Status, "healthy", StringComparison.Ordinal)
        ? StatusCodes.Status200OK
        : StatusCodes.Status503ServiceUnavailable;
    return TypedResults.Json(
        result,
        AppJsonContext.Default.AssetStorageReadinessResponse,
        statusCode: statusCode);
}

static async Task<IResult> ApplicationReadiness(
    ApplicationReadinessProbe probe,
    HttpContext context,
    CancellationToken cancellationToken,
    bool force = false)
{
    if (force && !AssetStorageReadinessProbe.CanForceProbe(
            context.Connection.RemoteIpAddress))
    {
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    }

    var result = await probe.CheckAsync(
        force: force,
        cancellationToken: cancellationToken);
    var statusCode = string.Equals(result.Status, "healthy", StringComparison.Ordinal)
        ? StatusCodes.Status200OK
        : StatusCodes.Status503ServiceUnavailable;
    return TypedResults.Json(
        result,
        AppJsonContext.Default.ApplicationReadinessResponse,
        statusCode: statusCode);
}

static IResult VersionInfo(IHostEnvironment env)
{
    var identity = ReadBuildIdentity();
    var buildTime = FirstEnv("BUILD_TIME", "BUILD_TIME_UTC", "CDS_BUILD_TIME", "VERCEL_GIT_COMMIT_DATE");

    // commit 字段保持向后兼容，但优先给实际值 —— 一个值没法自证，对账结论看 commitMatch
    var effective = identity.ActualCommit ?? identity.DeclaredCommit;

    return Results.Ok(new
    {
        app = "prd-agent",
        service = "prd-api",
        version = identity.InformationalVersion,
        commit = effective,
        shortCommit = ShortCommit(effective),
        actualCommit = identity.ActualCommit,
        expectedCommit = identity.DeclaredCommit,
        commitMatch = BuildIdentity.ToWireValue(identity.Match),
        commitWarning = BuildIdentity.DescribeMismatch(
            identity.Match,
            identity.ActualCommit,
            identity.DeclaredCommit),
        buildTimeUtc = buildTime,
        environment = env.EnvironmentName,
        serverTimeUtc = DateTime.UtcNow,
    });
}

static (string InformationalVersion, string? ActualCommit, string? DeclaredCommit, BuildIdentity.MatchState Match)
    ReadBuildIdentity()
{
    var informationalVersion = Assembly.GetExecutingAssembly()
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
        ?? "unknown";

    // 实际值由编译写进程序集，期待值由部署平台注入；两者必须独立取得才能对账。
    var actualCommit = BuildIdentity.ParseBakedCommit(informationalVersion);
    var declaredCommit = FirstEnv(
        "GIT_COMMIT",
        "COMMIT_SHA",
        "GITHUB_SHA",
        "SOURCE_VERSION",
        "CDS_COMMIT_SHA",
        "VERCEL_GIT_COMMIT_SHA");
    return (
        informationalVersion,
        actualCommit,
        declaredCommit,
        BuildIdentity.Compare(actualCommit, declaredCommit));
}

static string? FirstEnv(params string[] names)
{
    foreach (var name in names)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
    }
    return null;
}

static string? ShortCommit(string? commit)
{
    if (string.IsNullOrWhiteSpace(commit)) return null;
    return commit.Length <= 8 ? commit : commit[..8];
}

static bool FixedTimeEqualsNonEmpty(string expected, string provided)
{
    if (string.IsNullOrWhiteSpace(expected) || string.IsNullOrWhiteSpace(provided))
    {
        return false;
    }

    var expectedBytes = Encoding.UTF8.GetBytes(expected);
    var providedBytes = Encoding.UTF8.GetBytes(provided);
    return expectedBytes.Length == providedBytes.Length
           && CryptographicOperations.FixedTimeEquals(expectedBytes, providedBytes);
}

// 使 Program 类可被测试项目访问（用于 WebApplicationFactory<Program>）
public partial class Program { }
