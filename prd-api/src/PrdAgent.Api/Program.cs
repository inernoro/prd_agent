using System.IdentityModel.Tokens.Jwt;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Cryptography;
using MongoDB.Driver;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
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
using Serilog;
using Serilog.Events;

var builder = WebApplication.CreateBuilder(args);

// MongoDB BSON 映射注册：
// - 线上遇到过旧数据/旧镜像导致 _id 反序列化失败（Element '_id' does not match...）
// - 这里显式注册一次，避免依赖 MongoDbContext 构造顺序
BsonClassMapRegistration.Register();

// 配置Serilog - Pretty格式输出
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    // 压低框架噪音（你关心的是业务请求是否到达与返回摘要）
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .MinimumLevel.Override("System", LogEventLevel.Warning)
    // 关闭 Controller 的信息日志（你只想看请求 finished，不想看控制器内部 LogInformation）
    .MinimumLevel.Override("PrdAgent.Api.Controllers", LogEventLevel.Warning)
    // 说明：不启用 Microsoft.AspNetCore.Hosting.Diagnostics（它会打 Request starting/finished 两次且包含 OPTIONS）。
    // 我们用自定义中间件只打一条“Request finished ...”风格日志，更清爽、可控。
    .Enrich.FromLogContext()
    .WriteTo.Console(
        outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {SourceContext}{NewLine}{Message:lj}{NewLine}{Exception}",
        theme: Serilog.Sinks.SystemConsole.Themes.AnsiConsoleTheme.Code)
    .WriteTo.File(
        "logs/prdagent-.log", 
        rollingInterval: RollingInterval.Day,
        outputTemplate: "[{Timestamp:yyyy-MM-dd HH:mm:ss.fff} {Level:u3}] {SourceContext}{NewLine}{Message:lj}{NewLine}{Exception}")
    .CreateLogger();

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

// LLM 请求上下文与日志（旁路写入，便于后台调试）
builder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
builder.Services.AddSingleton<LlmRequestLogBackground>();
builder.Services.AddSingleton<ILlmRequestLogWriter, LlmRequestLogWriter>();
builder.Services.AddHostedService<LlmRequestLogWatchdog>();

// 应用设置服务（带缓存）
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IAppSettingsService, PrdAgent.Infrastructure.Services.AppSettingsService>();

// 模型用途选择（主模型/意图模型/图片识别/图片生成）
builder.Services.AddScoped<IModelDomainService, ModelDomainService>();

// OpenAI 兼容 Images API（用于“生图模型”）
builder.Services.AddScoped<OpenAIImageClient>();

// ImageMaster 资产存储：默认本地文件（可替换为对象存储实现）
builder.Services.AddSingleton<IAssetStorage>(_ =>
{
    // 可通过配置覆盖 Assets:LocalDir；默认放到 app/data/assets
    var baseDir = builder.Configuration["Assets:LocalDir"]
                 ?? Path.Combine(AppContext.BaseDirectory, "data", "assets");
    return new LocalAssetStorage(baseDir);
});

// 配置Redis
var redisConnectionString = builder.Configuration["Redis:ConnectionString"] ?? "localhost:6379";
var sessionTimeout = builder.Configuration.GetValue<int>("Session:TimeoutMinutes", 30);
builder.Services.AddSingleton<ICacheManager>(new RedisCacheManager(redisConnectionString, sessionTimeout));

// 配置JWT认证
var jwtSecret = builder.Configuration["Jwt:Secret"] 
    ?? throw new InvalidOperationException("JWT Secret not configured");
var jwtIssuer = builder.Configuration["Jwt:Issuer"] ?? "prdagent";
var jwtAudience = builder.Configuration["Jwt:Audience"] ?? "prdagent";

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtIssuer,
            ValidAudience = jwtAudience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret))
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
                try
                {
                    var sub = context.Principal?.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
                    var clientType = context.Principal?.FindFirst("clientType")?.Value;
                    var tvStr = context.Principal?.FindFirst("tv")?.Value;

                    if (string.IsNullOrWhiteSpace(sub) ||
                        string.IsNullOrWhiteSpace(clientType) ||
                        string.IsNullOrWhiteSpace(tvStr) ||
                        !int.TryParse(tvStr, out var tv) ||
                        tv < 1)
                    {
                        context.Fail("Invalid auth session claims");
                        return;
                    }

                    var authSessionService = context.HttpContext.RequestServices.GetRequiredService<IAuthSessionService>();
                    var currentTv = await authSessionService.GetTokenVersionAsync(sub, clientType);
                    if (currentTv != tv)
                    {
                        context.Fail("Token revoked");
                    }
                }
                catch
                {
                    // 安全兜底：依赖服务异常时不直接放行
                    context.Fail("Token validation failed");
                }
            },
            OnChallenge = async context =>
            {
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
    });

builder.Services.AddAuthorization();

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
        var apiKey = DecryptApiKey(activeConfig.ApiKeyEncrypted, jwtSecret);
        
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
    string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : DecryptApiKey(model.ApiKeyEncrypted, jwtSecret);

    // 如果模型没有配置，从平台继承
    if (model.PlatformId != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
    {
        var platform = db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefault();
        if (platform != null)
        {
            apiUrl ??= platform.ApiUrl;
            if (string.IsNullOrEmpty(apiKey))
            {
                apiKey = DecryptApiKey(platform.ApiKeyEncrypted, jwtSecret);
            }
        }
    }

    return (apiUrl, apiKey);
}

// 辅助方法：解密 API Key（与 AdminLLMConfigController 中的逻辑一致）
static string DecryptApiKey(string encryptedKey, string secretKey)
{
    if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;
    
    try
    {
        var parts = encryptedKey.Split(':');
        if (parts.Length != 2) return string.Empty;

        var keyBytes = Encoding.UTF8.GetBytes(secretKey.Length >= 32 ? secretKey[..32] : secretKey.PadRight(32));
        var iv = Convert.FromBase64String(parts[0]);
        var encryptedBytes = Convert.FromBase64String(parts[1]);

        using var aes = Aes.Create();
        aes.Key = keyBytes;
        aes.IV = iv;

        using var decryptor = aes.CreateDecryptor();
        var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
        
        return Encoding.UTF8.GetString(decryptedBytes);
    }
    catch
    {
        return string.Empty;
    }
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
    return new UserService(userRepo, inviteCodeRepo);
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
    return new SessionService(cache, sessionTimeout);
});

builder.Services.AddScoped<IGroupService>(sp =>
{
    var groupRepo = sp.GetRequiredService<IGroupRepository>();
    var memberRepo = sp.GetRequiredService<IGroupMemberRepository>();
    var docRepo = sp.GetRequiredService<IPrdDocumentRepository>();
    return new GroupService(groupRepo, memberRepo, docRepo);
});

builder.Services.AddScoped<IGapDetectionService>(sp =>
{
    var gapRepo = sp.GetRequiredService<IContentGapRepository>();
    return new GapDetectionService(gapRepo);
});

builder.Services.AddScoped<IChatService>(sp =>
{
    var llmClient = sp.GetRequiredService<ILLMClient>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var cache = sp.GetRequiredService<ICacheManager>();
    var promptManager = sp.GetRequiredService<IPromptManager>();
    var userService = sp.GetRequiredService<IUserService>();
    var messageRepo = sp.GetRequiredService<IMessageRepository>();
    var llmCtx = sp.GetRequiredService<ILLMRequestContextAccessor>();
    return new ChatService(llmClient, sessionService, documentService, cache, promptManager, userService, messageRepo, llmCtx);
});

builder.Services.AddScoped<IGuideService>(sp =>
{
    var llmClient = sp.GetRequiredService<ILLMClient>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var promptManager = sp.GetRequiredService<IPromptManager>();
    var llmCtx = sp.GetRequiredService<ILLMRequestContextAccessor>();
    return new GuideService(llmClient, sessionService, documentService, promptManager, llmCtx);
});

builder.Services.AddScoped<IPreviewAskService>(sp =>
{
    var llmClient = sp.GetRequiredService<ILLMClient>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var promptManager = sp.GetRequiredService<IPromptManager>();
    var llmCtx = sp.GetRequiredService<ILLMRequestContextAccessor>();
    var settingsService = sp.GetRequiredService<IAppSettingsService>();
    return new PreviewAskService(llmClient, sessionService, documentService, promptManager, llmCtx, settingsService);
});

// 注册引导进度仓储
builder.Services.AddScoped<IGuideProgressRepository>(sp =>
{
    var cache = sp.GetRequiredService<ICacheManager>();
    return new GuideProgressRepository(cache);
});

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
    var initializer = new DatabaseInitializer(db);
    await initializer.InitializeAsync();
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
app.UseAuthorization();
app.MapControllers();

// 健康检查端点
app.MapGet("/health", HealthCheck);

// 启动时输出“实际监听端口/前端默认端口提示”
app.Lifetime.ApplicationStarted.Register(() =>
{
    Log.Information("API listening on: {Urls}", app.Urls);
    Log.Information("Admin Web 默认: http://localhost:8000 （可通过 prd-admin: PORT=xxxx pnpm dev 修改）");
    Log.Information("Desktop Dev 默认: http://localhost:1420");
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
