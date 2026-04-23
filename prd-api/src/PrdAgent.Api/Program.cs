using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Cryptography;
using MongoDB.Driver;
using Microsoft.AspNetCore.Authentication.JwtBearer;
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
builder.Services.AddControllers()
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
builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.Changelog.IChangelogReader, PrdAgent.Infrastructure.Services.Changelog.ChangelogReader>();
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

// 模型调度执行器
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>();

// LLM Gateway 统一守门员（所有大模型调用必须通过此接口）
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, PrdAgent.Infrastructure.LlmGateway.LlmGateway>();

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

// 涌现探索器
builder.Services.AddSingleton<PrdAgent.Api.Services.SystemCapabilityScanner>();
builder.Services.AddScoped<PrdAgent.Api.Services.EmergenceService>();

// 技能引导 Agent
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.SkillAgentService>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.ISkillAgentSessionStore, PrdAgent.Infrastructure.Services.SkillAgentSessionStore>();

// 文档订阅同步引擎
builder.Services.AddHttpClient("DocumentSync");
builder.Services.AddHostedService<PrdAgent.Api.Services.DocumentSyncWorker>();

// 视频生成后台执行器（文章→脚本→Remotion渲染→字幕→打包）
builder.Services.AddHostedService<PrdAgent.Api.Services.VideoGenRunWorker>();

// 视频转文档后台执行器（视频→音频提取→STT转写→多模态LLM分析→Markdown文档）
builder.Services.AddHostedService<PrdAgent.Api.Services.VideoToDocRunWorker>();

// 竞技场 Run 后台执行器（多模型并行 + afterSeq 断线重连）
builder.Services.AddHostedService<PrdAgent.Api.Services.ArenaRunWorker>();

// 转录 Agent 后台执行器（ASR 转写 + 模板转文案）
builder.Services.AddHostedService<PrdAgent.Api.Services.TranscriptRunWorker>();
builder.Services.AddSingleton<PrdAgent.Api.Services.DoubaoStreamAsrService>();

// 知识库 Agent 后台执行器（字幕生成 + 文档再加工，复用 DoubaoStreamAsrService 和 ILlmGateway）
builder.Services.AddHttpClient("DocStoreAgent");
builder.Services.AddScoped<PrdAgent.Api.Services.SubtitleGenerationProcessor>();
builder.Services.AddScoped<PrdAgent.Api.Services.ContentReprocessProcessor>();
builder.Services.AddHostedService<PrdAgent.Api.Services.DocumentStoreAgentWorker>();

// 权限字符串迁移服务（启动时自动迁移旧格式 admin.xxx → 新格式 appKey.action）
builder.Services.AddHostedService<PrdAgent.Api.Services.PermissionMigrationService>();
// 应用调用者同步：已移除自动启动同步，改为管理后台手动点击「初始化应用」触发
// builder.Services.AddHostedService<PrdAgent.Api.Services.AppCallerRegistrySyncService>();

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

// Report Agent Phase 2: 自动采集服务
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.MapActivityCollector>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.ReportGenerationService>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.DailyLogPolishService>();
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

// Defect Agent: 催办 Worker + Webhook 通知服务
builder.Services.AddHostedService<PrdAgent.Api.Services.DefectAgent.DefectEscalationWorker>();
builder.Services.AddScoped<PrdAgent.Infrastructure.Services.DefectWebhookService>();

// Review Agent: Webhook 通知服务
builder.Services.AddScoped<PrdAgent.Api.Services.ReviewAgent.ReviewWebhookService>();

// ImageMaster 资产存储：默认本地文件（可替换为对象存储实现）
builder.Services.AddSingleton<IAssetStorage>(sp =>
{
    var cfg = sp.GetRequiredService<IConfiguration>();
    var log = sp.GetRequiredService<ILoggerFactory>().CreateLogger("AssetStorage");
    // 强约束：统一只使用一套"扁平环境变量"（不使用双下划线）：
    // - ASSETS_PROVIDER=tencentCos
    // - TENCENT_COS_BUCKET / TENCENT_COS_REGION / TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_PUBLIC_BASE_URL / TENCENT_COS_PREFIX
    var providerRaw = (cfg["ASSETS_PROVIDER"] ?? "tencentCos").Trim();

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

    var provider = string.IsNullOrWhiteSpace(providerRaw) ? "tencentCos" : providerRaw;

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
        $"ASSETS_PROVIDER={providerRaw} 不支持。可选值：tencentCos / cloudflareR2");

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
    var jwtSecret = config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
    var logWriter = sp.GetRequiredService<ILlmRequestLogWriter>();
    var ctxAccessor = sp.GetRequiredService<ILLMRequestContextAccessor>();
    var claudeLogger = sp.GetRequiredService<ILogger<ClaudeClient>>();
    
    // 1. 优先：从数据库获取主模型 (IsMain=true)
    var mainModel = db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefault();
    var mainEnablePromptCache = mainModel != null ? (mainModel.EnablePromptCache ?? true) : false;
    if (mainModel != null)
    {
        var (apiUrl, apiKey) = ResolveApiConfigForModel(mainModel, db, jwtSecret);
        
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
        var apiKey = ApiKeyCrypto.Decrypt(activeConfig.ApiKeyEncrypted, jwtSecret);
        
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
static (string? apiUrl, string? apiKey) ResolveApiConfigForModel(LLMModel model, MongoDbContext db, string jwtSecret)
{
    string? apiUrl = model.ApiUrl;
    string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(model.ApiKeyEncrypted, jwtSecret);

    // 如果模型没有配置，从平台继承
    if (model.PlatformId != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
    {
        var platform = db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefault();
        if (platform != null)
        {
            apiUrl ??= platform.ApiUrl;
            if (string.IsNullOrEmpty(apiKey))
            {
                apiKey = ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
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

// 注册 Webhook 通知服务
builder.Services.AddHttpClient("WebhookClient");
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

// 使 Program 类可被测试项目访问（用于 WebApplicationFactory<Program>）
public partial class Program { }
