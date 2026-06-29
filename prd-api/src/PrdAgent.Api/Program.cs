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
builder.Services.AddSingleton(new MongoDbContext(mongoConnectionString, mongoDatabaseName));
builder.Services.AddSingleton<IWatermarkFontAssetSource, MongoWatermarkFontAssetSource>();
builder.Services.AddSingleton<ISystemRoleCacheService, PrdAgent.Infrastructure.Services.SystemRoleCacheService>();
builder.Services.AddSingleton<IAdminPermissionService, PrdAgent.Infrastructure.Services.AdminPermissionService>();
builder.Services.AddSingleton<IAdminControllerScanner, PrdAgent.Infrastructure.Services.AdminControllerScanner>();
builder.Services.AddSingleton<ISafeOutboundUrlValidator, PrdAgent.Infrastructure.Services.SafeOutboundUrlValidator>();
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.ISafeOutboundHttpHandlerFactory,
    PrdAgent.Infrastructure.Services.SafeOutboundHttpHandlerFactory>();

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

// 双链 + 反向链接（详见 doc/design.knowledge-base.mention-network.md）
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.DocumentStore.MentionService>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.DocumentStore.DocumentVersionService>();

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

// 模型池查询服务（三级互斥解析：专属池 > 默认池 > 传统配置）
builder.Services.AddScoped<IModelPoolQueryService, ModelPoolQueryService>();

// 模型池故障通知与自动探活
builder.Services.AddScoped<PrdAgent.Infrastructure.ModelPool.IPoolFailoverNotifier, PrdAgent.Infrastructure.ModelPool.PoolFailoverNotifier>();
builder.Services.AddHostedService<PrdAgent.Infrastructure.ModelPool.ModelPoolHealthProbeService>();
builder.Services.AddHostedService<PrdAgent.Api.Services.PlatformKeyIntegrityWorker>();

// 模型调度执行器
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>();

// LLM Gateway 统一守门员（所有大模型调用必须通过此接口）。
// 特性开关：LlmGateway:Mode（环境变量 LlmGateway__Mode）。默认 inproc = 进程内 LlmGateway（行为不变）；
// http = 切到 HttpLlmGatewayClient，跨进程调用独立部署的 serving 服务（/gw/v1/*）。
// HttpLlmGatewayClient 同时实现 Infrastructure + Core 两个 ILlmGateway，下方 Core 桥接强转在两种模式下都成立。
// 影子比对落库（灰度翻 http 前积累一致性证据；shadow 模式下注入 ShadowLlmGateway）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ILlmShadowComparisonWriter,
    PrdAgent.Infrastructure.LlmGateway.LlmShadowComparisonWriter>();

var gatewayMode = builder.Configuration["LlmGateway:Mode"] ?? "inproc";
// 灰度翻 http 白名单（按 appCallerCode 逐个切；`,`/`;`/换行分隔）。命中的入口走 http 权威，其余按 Mode。
var httpAllowlist = (builder.Configuration["LlmGateway:HttpAppCallerAllowlist"] ?? string.Empty)
    .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    .Where(x => !string.IsNullOrWhiteSpace(x))
    .ToHashSet(StringComparer.OrdinalIgnoreCase);
var isShadow = string.Equals(gatewayMode, "shadow", StringComparison.OrdinalIgnoreCase);

if (string.Equals(gatewayMode, "http", StringComparison.OrdinalIgnoreCase))
{
    builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, PrdAgent.Infrastructure.LlmGateway.HttpLlmGatewayClient>();
}
else if (isShadow || httpAllowlist.Count > 0)
{
    // 统一路由器：白名单命中 → http 权威（灰度翻）；否则 inproc 权威。
    // shadow 模式下，对非白名单请求后台比对落 llmshadow_comparisons（默认只比解析=免费；
    // LlmGateway:ShadowFullSamplePercent>0 时对采样 send 做完整内容比对）。inproc+仅白名单时不比对（writer=null）。
    var shadowSamplePercent = int.TryParse(builder.Configuration["LlmGateway:ShadowFullSamplePercent"], out var sp0) ? sp0 : 0;
    builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>(sp =>
        new PrdAgent.Infrastructure.LlmGateway.ShadowLlmGateway(
            inproc: new PrdAgent.Infrastructure.LlmGateway.LlmGateway(
                sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.IModelResolver>(),
                sp.GetRequiredService<IHttpClientFactory>(),
                sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.LlmGateway.LlmGateway>>(),
                sp.GetService<PrdAgent.Core.Interfaces.ILlmRequestLogWriter>(),
                sp.GetService<PrdAgent.Core.Interfaces.ILLMRequestContextAccessor>(),
                sp.GetService<PrdAgent.Infrastructure.ModelPool.IPoolFailoverNotifier>()),
            http: new PrdAgent.Infrastructure.LlmGateway.HttpLlmGatewayClient(
                sp.GetRequiredService<IHttpClientFactory>(),
                sp.GetRequiredService<IConfiguration>(),
                sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.LlmGateway.HttpLlmGatewayClient>>()),
            logger: sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.LlmGateway.ShadowLlmGateway>>(),
            writer: isShadow ? sp.GetService<PrdAgent.Core.Interfaces.ILlmShadowComparisonWriter>() : null,
            fullSamplePercent: shadowSamplePercent,
            ctx: sp.GetService<PrdAgent.Core.Interfaces.ILLMRequestContextAccessor>(),
            httpAllowlist: httpAllowlist));
}
else
{
    builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, PrdAgent.Infrastructure.LlmGateway.LlmGateway>();
}

// 注册 Core 层的 ILlmGateway 接口（同一实例）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway>(sp =>
    (PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway)sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>());

// OpenAI 兼容 Images API（用于"生图模型"）
builder.Services.AddScoped<OpenAIImageClient>();
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ImageGen.IImageGenGateway,
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
builder.Services.AddScoped<PrdAgent.Core.Interfaces.IHostedSiteService, PrdAgent.Infrastructure.Services.HostedSiteService>();
// 团队（跨应用协作单位：网页托管 + 知识库共用）+ 团队活动日志
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ITeamService, PrdAgent.Infrastructure.Services.TeamService>();
builder.Services.AddScoped<PrdAgent.Core.Interfaces.ITeamActivityService, PrdAgent.Infrastructure.Services.TeamActivityService>();
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

// 对话 Run 后台任务执行器（断线不影响服务端闭环）
builder.Services.AddHostedService<PrdAgent.Api.Services.ChatRunWorker>();

// 工作流后台执行器（DAG 拓扑排序 → 逐节点推进）
builder.Services.AddHostedService<PrdAgent.Api.Services.WorkflowRunWorker>();
builder.Services.AddScoped<PrdAgent.Api.Services.WorkflowAiFillService>();
// 工作流结构校验 + 自动接线 + 缺项扫描（纯函数，无状态）
builder.Services.AddSingleton<PrdAgent.Core.Services.WorkflowValidationService>();

// 工作流调度轮询：每 30 秒扫一次到期的 once / cron 调度，自动入队
builder.Services.AddHostedService<PrdAgent.Api.Services.WorkflowScheduleWorker>();

// 一次性回填存量 PDF 包装站的 WrappedAssetType marker（PR #612）
builder.Services.AddHostedService<PrdAgent.Api.Services.HostedSiteBackfillService>();

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
builder.Services.AddSingleton<PrdAgent.Api.Services.DoubaoStreamAsrService>();

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

// 知识库 Agent 后台执行器（字幕生成 + 文档再加工，复用 DoubaoStreamAsrService 和 ILlmGateway）
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
builder.Services.AddScoped<PrdAgent.Api.Services.DocumentStoreAssetNormalizer>();
builder.Services.AddScoped<PrdAgent.Api.Services.ShortVideoMaterialProcessor>();
builder.Services.AddHostedService<PrdAgent.Api.Services.DocumentStoreAgentWorker>();
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
    var providerExplicit = !string.IsNullOrWhiteSpace(providerRaw);

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

    var provider = providerExplicit ? providerRaw : "auto";

    static bool HasCosCreds(IConfiguration c)
        => !string.IsNullOrWhiteSpace(c["TENCENT_COS_BUCKET"])
        && !string.IsNullOrWhiteSpace(c["TENCENT_COS_REGION"])
        && !string.IsNullOrWhiteSpace(c["TENCENT_COS_SECRET_ID"])
        && !string.IsNullOrWhiteSpace(c["TENCENT_COS_SECRET_KEY"]);

    static bool HasR2Creds(IConfiguration c)
        => !string.IsNullOrWhiteSpace(c["R2_ACCOUNT_ID"])
        && !string.IsNullOrWhiteSpace(c["R2_ACCESS_KEY_ID"])
        && !string.IsNullOrWhiteSpace(c["R2_SECRET_ACCESS_KEY"])
        && !string.IsNullOrWhiteSpace(c["R2_BUCKET"]);

    // 是否存在「任何」云存储凭据片段（用于区分"完全没配"vs"配了一半"）。
    static bool HasAnyCloudVar(IConfiguration c)
        => new[]
        {
            "TENCENT_COS_BUCKET", "TENCENT_COS_REGION", "TENCENT_COS_SECRET_ID", "TENCENT_COS_SECRET_KEY",
            "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
        }.Any(k => !string.IsNullOrWhiteSpace(c[k]));

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

    // auto：未显式指定 Provider 时按凭据自动挑选。
    //   - 完整 COS / R2 凭据 → 用对应云存储；
    //   - 完全没有任何云凭据 → 回退本地占位（文档化的 no-cloud 场景）；
    //   - 配了一半（部分云变量存在但不完整）→ 视为配置错误 fail-fast，
    //     不静默回退本地，避免资产被写进容器本地盘、重部署即丢（Codex P2）。
    if (string.Equals(provider, "auto", StringComparison.OrdinalIgnoreCase))
    {
        if (HasCosCreds(cfg)) provider = "tencentCos";
        else if (HasR2Creds(cfg)) provider = "cloudflareR2";
        else if (HasAnyCloudVar(cfg))
        {
            throw new InvalidOperationException(
                "检测到部分云存储凭据但不完整：请补全 TENCENT_COS_*（BUCKET/REGION/SECRET_ID/SECRET_KEY）" +
                "或 R2_*（ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET）整套；" +
                "若确实要用本地存储，请显式设置 ASSETS_PROVIDER=local。" +
                "已拒绝在凭据不完整时静默回退本地，以免资产写入容器本地盘、重部署后丢失。");
        }
        else return BuildLocal("ASSETS_PROVIDER 未设置且无任何云凭据");
    }

    if (string.Equals(provider, "local", StringComparison.OrdinalIgnoreCase))
    {
        return BuildLocal("ASSETS_PROVIDER=local（显式）");
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

// 文件内容提取器（PDF/Word/Excel/PPT）
builder.Services.AddSingleton<IFileContentExtractor, FileContentExtractor>();

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
                        context.Fail("Invalid auth session claims");
                        return;
                    }

                    var authSessionService = context.HttpContext.RequestServices.GetRequiredService<IAuthSessionService>();
                    var currentTv = await authSessionService.GetTokenVersionAsync(sub, clientType);
                    if (currentTv != tv)
                    {
                        logger.LogWarning("[401] Token版本不匹配(已被撤销) - Path: {Path}, Method: {Method}, IP: {IP}, UserId: {UserId}, ClientType: {ClientType}, TokenVersion: {Tv}, CurrentVersion: {CurrentTv}",
                            requestPath, requestMethod, clientIp, sub, clientType, tv, currentTv);
                        context.Fail("Token revoked");
                    }
                }
                catch (Exception ex)
                {
                    // 安全兜底：依赖服务异常时不直接放行
                    logger.LogWarning(ex, "[401] Token验证异常 - Path: {Path}, Method: {Method}, IP: {IP}",
                        requestPath, requestMethod, clientIp);
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
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                context.Response.ContentType = "application/json; charset=utf-8";
                var payload = ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权");
                await context.Response.WriteAsync(JsonSerializer.Serialize(payload, jsonOptions));
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
        options => { });

builder.Services.AddAuthorization(options =>
{
    // 配置默认策略，支持多种认证方案
    options.DefaultPolicy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder(
        JwtBearerDefaults.AuthenticationScheme,
        "ApiKey",
        PrdAgent.Api.Authentication.AiAccessKeyAuthenticationHandler.SchemeName)
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
var jwtAccessTokenMinutes = builder.Configuration.GetValue<int>("Jwt:AccessTokenMinutes", 60);
builder.Services.AddSingleton<IJwtService>(sp => 
    new JwtService(jwtSecret, jwtIssuer, jwtAudience, jwtAccessTokenMinutes));

// 注册 AuthSessionService（refresh session + tokenVersion）
builder.Services.AddSingleton<IAuthSessionService>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    var config = sp.GetRequiredService<IConfiguration>();
    var secret = config["Jwt:Secret"] ?? "default-secret";
    return new AuthSessionService(cache, secret);
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

builder.Services.AddHttpClient<ILLMClient, ClaudeClient>()
    .ConfigureHttpClient(client =>
    {
        client.BaseAddress = new Uri("https://api.anthropic.com/");
        if (!string.IsNullOrWhiteSpace(llmApiKey))
        {
            client.DefaultRequestHeaders.Add("x-api-key", llmApiKey);
        }
        client.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
    })
    .AddHttpMessageHandler<HttpLoggingHandler>();

// 注册 LLM 客户端 - 优先从数据库读取主模型，其次从LLMConfig，最后从环境变量
builder.Services.AddScoped<ILLMClient>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var config = sp.GetRequiredService<IConfiguration>();
    var logWriter = sp.GetRequiredService<ILlmRequestLogWriter>();
    var ctxAccessor = sp.GetRequiredService<ILLMRequestContextAccessor>();
    var claudeLogger = sp.GetRequiredService<ILogger<ClaudeClient>>();
    
    // 1. 优先：从数据库获取主模型 (IsMain=true)
    var mainModel = db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefault();
    var mainEnablePromptCache = mainModel != null ? (mainModel.EnablePromptCache ?? true) : false;
    if (mainModel != null)
    {
        var (apiUrl, apiKey) = ResolveApiConfigForModel(mainModel, db, config);
        
        if (!string.IsNullOrWhiteSpace(apiUrl) && !string.IsNullOrWhiteSpace(apiKey))
        {
            var httpClient = httpClientFactory.CreateClient("LoggedHttpClient");
            
            // 判断平台类型并获取平台信息
            string? platformType = null;
            string? platformId = mainModel.PlatformId;
            string? platformName = null;
            if (mainModel.PlatformId != null)
            {
                var platform = db.LLMPlatforms.Find(p => p.Id == mainModel.PlatformId).FirstOrDefault();
                platformType = platform?.PlatformType?.ToLower();
                platformName = platform?.Name;
            }
            
            // 根据平台类型或API URL判断使用哪个客户端
            // 业务规则：不再使用"全局开关"，而是以"主模型 enablePromptCache"作为总开关
            var enablePromptCache = mainEnablePromptCache;
            
            if (platformType == "anthropic" || apiUrl.Contains("anthropic.com"))
            {
                httpClient.BaseAddress = new Uri(apiUrl.TrimEnd('/'));
                return new ClaudeClient(httpClient, apiKey, mainModel.ModelName, 4096, 0.7, enablePromptCache, claudeLogger, logWriter, ctxAccessor, platformId, platformName);
            }
            else
            {
                // 默认使用 OpenAI 格式（兼容 openai、google、qwen、zhipu、baidu、other 等）
                httpClient.BaseAddress = new Uri(apiUrl.TrimEnd('/'));
                return new OpenAIClient(httpClient, apiKey, mainModel.ModelName, 4096, 0.7, enablePromptCache, logWriter, ctxAccessor, null, platformId, platformName);
            }
        }
    }
    
    // 2. 其次：从数据库获取活动的 LLMConfig
    var activeConfig = db.LLMConfigs.Find(c => c.IsActive).FirstOrDefault();
    if (activeConfig != null)
    {
        var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(activeConfig.ApiKeyEncrypted, config);
        
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            var httpClient = httpClientFactory.CreateClient("LoggedHttpClient");
            
            if (activeConfig.Provider == "Claude")
            {
                httpClient.BaseAddress = new Uri(activeConfig.ApiEndpoint ?? "https://api.anthropic.com/");
                var enablePromptCache = mainEnablePromptCache && activeConfig.EnablePromptCache;
                return new ClaudeClient(httpClient, apiKey, activeConfig.Model, activeConfig.MaxTokens, activeConfig.Temperature, enablePromptCache, claudeLogger, logWriter, ctxAccessor);
            }
            else if (activeConfig.Provider == "OpenAI")
            {
                httpClient.BaseAddress = new Uri(activeConfig.ApiEndpoint ?? "https://api.openai.com/");
                var enablePromptCache = mainEnablePromptCache && activeConfig.EnablePromptCache;
                return new OpenAIClient(httpClient, apiKey, activeConfig.Model, activeConfig.MaxTokens, activeConfig.Temperature, enablePromptCache, logWriter, ctxAccessor);
            }
        }
    }
    
    // 3. 最后：回退到环境变量配置
    if (string.IsNullOrWhiteSpace(llmApiKey))
    {
        Log.Warning("No main model or active LLM config found in database and LLM:ClaudeApiKey is not configured. Please set a main model in admin panel or set LLM__ClaudeApiKey environment variable");
        var httpClient = httpClientFactory.CreateClient("LoggedHttpClient");
        httpClient.BaseAddress = new Uri("https://api.anthropic.com/");
        return new ClaudeClient(httpClient, "", llmModel, 4096, 0.7, enablePromptCache: false, claudeLogger, logWriter, ctxAccessor);
    }
    
    var fallbackHttpClient = httpClientFactory.CreateClient("LoggedHttpClient");
    fallbackHttpClient.BaseAddress = new Uri("https://api.anthropic.com/");
    return new ClaudeClient(fallbackHttpClient, llmApiKey, llmModel, 4096, 0.7, enablePromptCache: mainEnablePromptCache, claudeLogger, logWriter, ctxAccessor);
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
    var initializer = new DatabaseInitializer(db, idGenerator);
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

// 始终启用"单行 Request finished 摘要日志"（不包含 body，且默认跳过 OPTIONS），用于确认请求是否到达和返回结果
app.UseRequestResponseLogging();

app.UseExceptionMiddleware();
app.UseRateLimiting();
app.UseCors();
app.UseAuthentication();
// 认证通过后做 3 天滑动续期（now+72h，按端独立）
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

static IResult VersionInfo(IHostEnvironment env)
{
    var informationalVersion = Assembly.GetExecutingAssembly()
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
        ?? "unknown";
    var commit = FirstEnv("GIT_COMMIT", "COMMIT_SHA", "GITHUB_SHA", "SOURCE_VERSION", "CDS_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA");
    var buildTime = FirstEnv("BUILD_TIME", "BUILD_TIME_UTC", "CDS_BUILD_TIME", "VERCEL_GIT_COMMIT_DATE");

    return Results.Ok(new
    {
        app = "prd-agent",
        service = "prd-api",
        version = informationalVersion,
        commit,
        shortCommit = ShortCommit(commit),
        buildTimeUtc = buildTime,
        environment = env.EnvironmentName,
        serverTimeUtc = DateTime.UtcNow,
    });
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

// 使 Program 类可被测试项目访问（用于 WebApplicationFactory<Program>）
public partial class Program { }
