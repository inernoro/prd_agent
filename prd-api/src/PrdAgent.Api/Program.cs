using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
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
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// 配置Serilog - Pretty格式输出
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
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
                    return uri.Host is "localhost" or "127.0.0.1";
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
var jwtExpirationHours = builder.Configuration.GetValue<int>("Jwt:ExpirationHours", 24);
builder.Services.AddSingleton<IJwtService>(sp => 
    new JwtService(jwtSecret, jwtIssuer, jwtAudience, jwtExpirationHours));

// 注册 HTTP 日志处理程序
builder.Services.AddTransient<HttpLoggingHandler>();

// 注册通用 HTTP 客户端（带日志）- 用于所有第三方 API 请求
builder.Services.AddHttpClient("LoggedHttpClient")
    .AddHttpMessageHandler<HttpLoggingHandler>();

// 注册 LLM 客户端
var llmApiKey = builder.Configuration["LLM:ClaudeApiKey"] ?? "";
var llmModel = builder.Configuration["LLM:Model"] ?? "claude-3-5-sonnet-20241022";

builder.Services.AddHttpClient<ILLMClient, ClaudeClient>()
    .ConfigureHttpClient(client =>
    {
        client.BaseAddress = new Uri("https://api.anthropic.com/");
        client.DefaultRequestHeaders.Add("x-api-key", llmApiKey);
        client.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
    })
    .AddHttpMessageHandler<HttpLoggingHandler>();

builder.Services.AddScoped<ILLMClient>(sp =>
{
    var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var httpClient = httpClientFactory.CreateClient(nameof(ClaudeClient));
    return new ClaudeClient(httpClient, llmApiKey, llmModel);
});

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
    return new DocumentService(cache, parser);
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
    return new GroupService(groupRepo, memberRepo);
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
    return new ChatService(llmClient, sessionService, documentService, cache, promptManager, userService, messageRepo);
});

builder.Services.AddScoped<IGuideService>(sp =>
{
    var llmClient = sp.GetRequiredService<ILLMClient>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var promptManager = sp.GetRequiredService<IPromptManager>();
    return new GuideService(llmClient, sessionService, documentService, promptManager);
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
    
    // 开发环境下启用请求响应日志（Pretty格式）
    app.UseRequestResponseLogging();
}

app.UseExceptionMiddleware();
app.UseRateLimiting();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();

// 健康检查端点
app.MapGet("/health", HealthCheck);

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
