using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Cache;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Prompts;
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
builder.Services.AddSingleton(new RedisCacheManager(redisConnectionString, sessionTimeout));

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

// 注册 Prompt Manager
builder.Services.AddSingleton<PromptManager>();

// 注册 JWT 服务
var jwtExpirationHours = builder.Configuration.GetValue<int>("Jwt:ExpirationHours", 24);
builder.Services.AddSingleton<IJwtService>(sp => 
    new JwtService(jwtSecret, jwtIssuer, jwtAudience, jwtExpirationHours));

// 注册 LLM 客户端
builder.Services.AddHttpClient<ILLMClient, ClaudeClient>((sp, client) =>
{
    var apiKey = builder.Configuration["LLM:ClaudeApiKey"] ?? "";
    var model = builder.Configuration["LLM:Model"] ?? "claude-3-5-sonnet-20241022";
    return new ClaudeClient(client, apiKey, model);
});

// 注册核心服务
builder.Services.AddScoped<IUserService>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new UserService(db.Users, db.InviteCodes);
});

builder.Services.AddScoped<IDocumentService>(sp =>
{
    var cache = sp.GetRequiredService<RedisCacheManager>();
    return new DocumentService(cache);
});

builder.Services.AddScoped<ISessionService>(sp =>
{
    var cache = sp.GetRequiredService<RedisCacheManager>();
    return new SessionService(cache, sessionTimeout);
});

builder.Services.AddScoped<IGroupService>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new GroupService(db.Groups, db.GroupMembers);
});

builder.Services.AddScoped<IGapDetectionService>(sp =>
{
    var db = sp.GetRequiredService<MongoDbContext>();
    return new GapDetectionService(db.ContentGaps);
});

builder.Services.AddScoped<IChatService>(sp =>
{
    var llmClient = sp.GetRequiredService<ILLMClient>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var cache = sp.GetRequiredService<RedisCacheManager>();
    var promptManager = sp.GetRequiredService<PromptManager>();
    var userService = sp.GetRequiredService<IUserService>();
    return new ChatService(llmClient, sessionService, documentService, cache, promptManager, userService);
});

builder.Services.AddScoped<IGuideService>(sp =>
{
    var llmClient = sp.GetRequiredService<ILLMClient>();
    var sessionService = sp.GetRequiredService<ISessionService>();
    var documentService = sp.GetRequiredService<IDocumentService>();
    var promptManager = sp.GetRequiredService<PromptManager>();
    return new GuideService(llmClient, sessionService, documentService, promptManager);
});

var app = builder.Build();

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

