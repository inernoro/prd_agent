using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Cache;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Markdown;
using PrdAgent.Infrastructure.Prompts;
using PrdAgent.Infrastructure.Repositories;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// 配置Serilog
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.File("logs/prdagent-.log", rollingInterval: RollingInterval.Day)
    .CreateLogger();

builder.Host.UseSerilog();

// 添加服务
builder.Services.AddControllers();
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
var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() 
    ?? new[] { "http://localhost:1420", "http://localhost:5173" };
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins(allowedOrigins)
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials();
    });
});

// 注册基础设施服务
builder.Services.AddSingleton<IMarkdownParser, MarkdownParser>();
builder.Services.AddSingleton<IPromptManager, PromptManager>();

// 注册 JWT 服务
var jwtExpirationHours = builder.Configuration.GetValue<int>("Jwt:ExpirationHours", 24);
builder.Services.AddSingleton<IJwtService>(sp => 
    new JwtService(jwtSecret, jwtIssuer, jwtAudience, jwtExpirationHours));

// 注册 LLM 客户端
var llmApiKey = builder.Configuration["LLM:ClaudeApiKey"] ?? "";
var llmModel = builder.Configuration["LLM:Model"] ?? "claude-3-5-sonnet-20241022";

builder.Services.AddHttpClient<ILLMClient, ClaudeClient>()
    .ConfigureHttpClient(client =>
    {
        client.BaseAddress = new Uri("https://api.anthropic.com/");
        client.DefaultRequestHeaders.Add("x-api-key", llmApiKey);
        client.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
    });

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
    return new ChatService(llmClient, sessionService, documentService, cache, promptManager, userService);
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
}

app.UseExceptionMiddleware();
app.UseRateLimiting();
app.UseSerilogRequestLogging();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();

// 健康检查端点
app.MapGet("/health", () => Results.Ok(new 
{ 
    status = "healthy", 
    version = "1.0.0",
    timestamp = DateTime.UtcNow 
}));

app.Run();
