using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
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
builder.Services.AddHostedService<LlmRequestLogWatchdog>();

// 应用设置服务（带缓存）
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IAppSettingsService, PrdAgent.Infrastructure.Services.AppSettingsService>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IPromptService, PrdAgent.Infrastructure.Services.PromptService>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.ISystemPromptService, PrdAgent.Infrastructure.Services.SystemPromptService>();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.ISkillService, PrdAgent.Infrastructure.Services.SkillService>();

// 模型用途选择（主模型/意图模型/图片识别/图片生成）
builder.Services.AddScoped<IModelDomainService, ModelDomainService>();

// 模型池查询服务（三级互斥解析：专属池 > 默认池 > 传统配置）
builder.Services.AddScoped<IModelPoolQueryService, ModelPoolQueryService>();

// 模型调度执行器（支持单元测试 Mock）
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>();

// LLM Gateway 统一守门员（所有大模型调用必须通过此接口）
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, PrdAgent.Infrastructure.LlmGateway.LlmGateway>();

// 注册 Core 层的 ILlmGateway 接口（同一实例）
builder.Services.AddScoped<PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway>(sp =>
    (PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway)sp.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>());

// OpenAI 兼容 Images API（用于"生图模型"）
builder.Services.AddScoped<OpenAIImageClient>();
builder.Services.AddSingleton<WatermarkFontRegistry>();
builder.Services.AddSingleton<WatermarkRenderer>();

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

// 权限字符串迁移服务（启动时自动迁移旧格式 admin.xxx → 新格式 appKey.action）
builder.Services.AddHostedService<PrdAgent.Api.Services.PermissionMigrationService>();

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
builder.Services.AddHostedService<PrdAgent.Api.Services.ReportAgent.GitSyncWorker>();
builder.Services.AddHostedService<PrdAgent.Api.Services.ReportAgent.ReportAutoGenerateWorker>();
// Report Agent Phase 3: 管理增强服务
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.ReportNotificationService>();
builder.Services.AddScoped<PrdAgent.Api.Services.ReportAgent.TeamSummaryService>();

// ImageMaster 资产存储：默认本地文件（可替换为对象存储实现）
builder.Services.AddSingleton<IAssetStorage>(sp =>
{
    var cfg = sp.GetRequiredService<IConfiguration>();
    var log = sp.GetRequiredService<ILoggerFactory>().CreateLogger("AssetStorage");
    // 强约束：统一只使用一套“扁平环境变量”（不使用双下划线）：
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

    // 强约束：任何情况下不允许使用本地文件存储（避免容器可写层过小导致宕机/数据丢失）
    // - 若未配置 COS，则直接启动失败并给出清晰错误
    if (!string.Equals(provider, "tencentCos", StringComparison.OrdinalIgnoreCase))
    {
        throw new InvalidOperationException(
            $"本实例已强制禁用本地文件存储，但 ASSETS_PROVIDER={providerRaw}（仅允许 tencentCos）。");
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
        var enableSafeDelete = string.Equals((cfg["TencentCos:EnableSafeDelete"] ?? string.Empty).Trim(), "true", StringComparison.OrdinalIgnoreCase);
        var allowRaw = (cfg["TencentCos:SafeDeleteAllowPrefixes"] ?? string.Empty).Trim();
        var allow = allowRaw
            .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => x.Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToArray();
        var logger = sp.GetRequiredService<ILogger<TencentCosStorage>>();
        log.LogInformation(
            "AssetStorage selected: provider={ProviderRaw}->{Provider} tencentCos.bucket={Bucket} region={Region} prefix={Prefix} publicBaseUrl={PublicBaseUrl}",
            providerRaw,
            provider,
            (bucket ?? string.Empty).Trim(),
            (region ?? string.Empty).Trim(),
            (prefix ?? string.Empty).Trim(),
            (publicBaseUrl ?? string.Empty).Trim());
        // 经过上面的 IsNullOrWhiteSpace 校验，bucket/region/secretId/secretKey 在运行时必定非空；
        // 这里用 null-forgiving 消除 nullable 分析告警（避免 build warning 噪音）。
        return new TencentCosStorage(bucket!, region!, secretId!, secretKey!, publicBaseUrl, prefix, tempDir, enableSafeDelete, allow, logger);
    }

    // 理论上不会走到这里；保留以满足编译器对“所有路径均有返回”的要求
    throw new InvalidOperationException($"AssetStorage provider 选择异常：providerRaw={providerRaw} provider={provider}");
});

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
    // 这里必须在启动阶段 fail-fast，避免 AddJwtBearer 的 options 懒加载导致线上“首个请求才爆炸”。
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
                    // 说明：Mac/Windows 上某些情况下前端会以 http://[::1]:port 作为 Origin，若未放行会导致预检 OPTIONS 403“看似随机”波动
                    return uri.Host is "localhost" or "127.0.0.1" or "::1";
                })
                .AllowAnyHeader()
                .AllowAnyMethod();
            return;
        }

        // 生产环境：严格按配置允许来源
        policy.WithOrigins(allowedOrigins)
            .AllowAnyHeader()
            .AllowAnyMethod();
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
    var promptService = sp.GetRequiredService<IPromptService>();
    var systemPromptService = sp.GetRequiredService<PrdAgent.Core.Interfaces.ISystemPromptService>();
    var userService = sp.GetRequiredService<IUserService>();
    var messageRepo = sp.GetRequiredService<IMessageRepository>();
    var groupSeq = sp.GetRequiredService<IGroupMessageSeqService>();
    var groupHub = sp.GetRequiredService<IGroupMessageStreamHub>();
    var llmCtx = sp.GetRequiredService<ILLMRequestContextAccessor>();
    var idGenerator = sp.GetRequiredService<IIdGenerator>();
    return new ChatService(gateway, sessionService, documentService, cache, promptManager, promptService, systemPromptService, userService, messageRepo, groupSeq, groupHub, llmCtx, idGenerator);
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

// 注册 Webhook 通知服务
builder.Services.AddHttpClient("WebhookClient");
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

// 始终启用“单行 Request finished 摘要日志”（不包含 body，且默认跳过 OPTIONS），用于确认请求是否到达和返回结果
app.UseRequestResponseLogging();

app.UseExceptionMiddleware();
app.UseRateLimiting();
app.UseCors();
app.UseAuthentication();
// 认证通过后做 3 天滑动续期（now+72h，按端独立）
app.UseMiddleware<AuthSlidingExpirationMiddleware>();
// 统一记录“最后操作时间”（仅写请求 + 成功响应）
app.UseMiddleware<PrdAgent.Api.Middleware.UserLastActiveMiddleware>();
app.UseAuthorization();
// 管理后台权限（菜单/页面/接口统一绑定 permission key）
app.UseMiddleware<PrdAgent.Api.Middleware.AdminPermissionMiddleware>();
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
