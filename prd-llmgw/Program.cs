// AI 大模型网关 —— 独立观测/登录后端（与 MAP 物理隔离）。
//
// 设计意图（见 doc/design.llm-gateway-physical-isolation.md）：
//   - 本服务与 prd-api 完全解耦，不引用任何 PrdAgent.* 项目，仅依赖 NuGet 包。
//   - MAP 继续负责 MAP 自己的业务日志；GW 控制台账号、登录审计等自有状态落独立数据库 llm_gateway。
//   - 控制台读取 GW 自有 llmrequestlogs / shadow / 审计作为权威观测；MAP 业务日志只作为跨系统关联来源。
//   - 共享集合 llmrequestlogs 由 .NET 驱动以 PascalCase 字段名序列化；为规避历史文档里
//     数值/日期类型混存导致的反序列化异常，日志查询统一以 BsonDocument 读取并手动安全映射。

using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.Security;

var builder = WebApplication.CreateBuilder(args);

// ── 配置读取（env 变量里的 __ 自动映射成 :）──
var config = builder.Configuration;

var mongoConn = config["MongoDB:ConnectionString"] ?? "mongodb://localhost:27017";
var mongoDb = config["MongoDB:DatabaseName"] ?? "prdagent";
var gatewayMongoConn = config["LlmGateway:MongoConnectionString"]
    ?? config["LLMGW_MONGO_CONNECTION_STRING"];
if (string.IsNullOrWhiteSpace(gatewayMongoConn)) gatewayMongoConn = mongoConn;
var gatewayDbName = config["LlmGateway:DatabaseName"] ?? "llm_gateway";
var internalTenantId = config["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } configuredInternalTenantId
    ? configuredInternalTenantId
    : "tenant_map_internal";

const string DevJwtSecret = "llmgw-dev-secret-change-me-please-0001";

// 安全门（修复「仓库已知 dev 密钥可伪造 token 读 /gw/*」）：
//   /gw/* 暴露在外，bearer 鉴权只校验签名/issuer/有效期。若生产回落到仓库已知的 dev 密钥，
//   攻击者无需 admin 密码即可自签 token 读 /gw/logs。故生产环境**强制**显式配置真密钥，缺失即拒启动。
//   非生产（Development/CI 自测）保留 dev 占位密钥，避免本地起不来。
var isProduction = builder.Environment.IsProduction();

var configuredJwtSecret = config["LlmGwJwt:Secret"];
var jwtSecret = configuredJwtSecret ?? DevJwtSecret;
var jwtTooShort = Encoding.UTF8.GetByteCount(jwtSecret) < 32; // HS256 要求密钥足够长
if (isProduction && (string.IsNullOrWhiteSpace(configuredJwtSecret) || configuredJwtSecret == DevJwtSecret || jwtTooShort))
{
    throw new InvalidOperationException(
        "生产环境必须显式配置 LLMGW_JWT_SECRET（≥32 字节、非仓库 dev 占位值）。" +
        "缺失会回落到仓库已知 dev 密钥，使任何人可自签 token 读取 /gw/* —— 拒绝启动。");
}
if (jwtTooShort)
{
    // 仅非生产：过短回落到带提示的开发占位密钥，避免本地启动即崩。
    jwtSecret = DevJwtSecret;
}
var jwtIssuer = config["LlmGwJwt:Issuer"] ?? "prdagent-llmgw";

// 网关控制台登录账号：
// - 长期权威是 llm_gateway.llmgw_console_users 里的 PBKDF2 哈希，UI 改密后重启不再被 env 覆盖。
// - LLMGW_ADMIN_PASSWORD 仅用于“首次 bootstrap 创建账号”或 LLMGW_ADMIN_FORCE_RESET 破玻璃时的重置口令。
// - 未设 bootstrap 口令时，内置 admin/admin 引导 + 首登强制改密，避免新环境锁死。
const string AdminUser = "admin";
const string DefaultAdminPwd = "admin";

var gitCommit = Environment.GetEnvironmentVariable("GIT_COMMIT") ?? "";

// ── Mongo 客户端（单例）──
var mapMongoClient = new MongoClient(mongoConn);
var gatewayMongoClient = string.Equals(gatewayMongoConn, mongoConn, StringComparison.Ordinal)
    ? mapMongoClient
    : new MongoClient(gatewayMongoConn);
var mapDatabase = mapMongoClient.GetDatabase(mongoDb);
var gatewayDatabase = gatewayMongoClient.GetDatabase(gatewayDbName);
builder.Services.AddSingleton(mapMongoClient);
builder.Services.AddSingleton(mapDatabase);

// ── JWT 签发器（独立密钥）──
var gwJwt = new GwJwt(jwtSecret, jwtIssuer);
builder.Services.AddSingleton(gwJwt);

// ── 鉴权 ──
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = jwtIssuer,
            ValidateAudience = false,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = gwJwt.SigningKey,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(1),
        };
    });
builder.Services.AddAuthorization(options =>
{
    // 首登强制改密门：拒绝 mcp=1 的 token 访问日志端点（该 token 只能调 change-password）。
    // 服务端强制（而非仅前端守卫），确保缺省 admin/admin 在改密前无法真正读取观测数据。
    options.AddPolicy("LogsRead", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.LogsRead)));
    options.AddPolicy("RequestBodyRead", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.RequestBodyRead)));
    options.AddPolicy("UsageRead", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.UsageRead)));
    options.AddPolicy("AuditRead", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.AuditRead)));
    options.AddPolicy("ConfigWrite", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.ConfigWrite)));
    options.AddPolicy("ServiceKeyWrite", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.ServiceKeyWrite)));
    options.AddPolicy("OrganizationWrite", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.OrganizationWrite)));
    options.AddPolicy("TenantOwner", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.TenantOwner)));
});

// ── CORS：内部观测工具，放开来源/头/方法（前端经 nginx 跨源访问）──
const string CorsPolicy = "llmgw-cors";
builder.Services.AddCors(o => o.AddPolicy(CorsPolicy, p =>
    p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

// ── JSON：camelCase 输出，与前端约定一致 ──
var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
};
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
});

var app = builder.Build();

// CORS 必须在 Auth 之前应用。
app.UseCors(CorsPolicy);
app.UseAuthentication();

// ── 启动时幂等播种管理员账户（内置 admin/admin 引导，env 仅 bootstrap/破玻璃）──
// 破玻璃（break-glass）：设 LLMGW_ADMIN_FORCE_RESET 为真值（1/true/yes/on，大小写不敏感）时，显式重置 admin
// 口令。用于「账号被认领但口令登不进」的死锁恢复。恢复后请把该 env 清掉。
// **仅认真值**（Bugbot Medium）：只判「非空」会把 =0 / =false 误当开启，每次启动强制回 admin/admin 反而擦掉 env 口令。
// 口令来源（2026-07-04 目标模式）：数据库是长期权威；LLMGW_ADMIN_PASSWORD 仅在首次创建或 force reset 时使用。
var forceResetRaw = (Environment.GetEnvironmentVariable("LLMGW_ADMIN_FORCE_RESET") ?? string.Empty).Trim();
var forceResetAdmin = new[] { "1", "true", "yes", "on" }.Contains(forceResetRaw, StringComparer.OrdinalIgnoreCase);
var adminBootstrapPwd = Environment.GetEnvironmentVariable("LLMGW_ADMIN_PASSWORD");
var operationAudits = gatewayDatabase.GetCollection<BsonDocument>("llmgw_operation_audits");
await SeedAdminAsync(gatewayDatabase, operationAudits, AdminUser, DefaultAdminPwd, internalTenantId, forceResetAdmin, adminBootstrapPwd);

// GW 请求日志由 llmgw-serve 写入独立 llm_gateway 库；控制台和 runtime gates 必须读取同一权威来源。
var logs = gatewayDatabase.GetCollection<BsonDocument>("llmrequestlogs");
// GW 自有账号和审计落独立库 llm_gateway，避免被 MAP 项目 env / shared DB 状态覆盖。
var users = gatewayDatabase.GetCollection<LlmGwUser>("llmgw_console_users");
var tenants = gatewayDatabase.GetCollection<LlmGwTenant>("llmgw_tenants");
var teams = gatewayDatabase.GetCollection<LlmGwTeam>("llmgw_teams");
var memberships = gatewayDatabase.GetCollection<LlmGwMembership>("llmgw_memberships");
var loginAudits = gatewayDatabase.GetCollection<LlmGwLoginAudit>("llmgw_login_audits");
var lifecycleRuns = gatewayDatabase.GetCollection<BsonDocument>("llmgw_lifecycle_runs");
// 网关配置面：GW 自有集合优先，MAP 集合作为未迁移时期的兼容来源。
var modelGroups = mapDatabase.GetCollection<BsonDocument>("model_groups");
var platforms = mapDatabase.GetCollection<BsonDocument>("llmplatforms");
var models = mapDatabase.GetCollection<BsonDocument>("llmmodels");
var modelExchanges = mapDatabase.GetCollection<BsonDocument>("model_exchanges");
var shadows = gatewayDatabase.GetCollection<BsonDocument>("llmshadow_comparisons");
var gwAppCallers = gatewayDatabase.GetCollection<BsonDocument>("llmgw_app_callers");
var promptPolicies = gatewayDatabase.GetCollection<BsonDocument>("llmgw_prompt_policies");
var gwModelPools = gatewayDatabase.GetCollection<BsonDocument>("llmgw_model_pools");
var gwPlatforms = gatewayDatabase.GetCollection<BsonDocument>("llmgw_platforms");
var gwModels = gatewayDatabase.GetCollection<BsonDocument>("llmgw_models");
var gwModelExchanges = gatewayDatabase.GetCollection<BsonDocument>("llmgw_model_exchanges");
var serviceKeys = gatewayDatabase.GetCollection<BsonDocument>("llmgw_service_keys");
var serviceKeyDirectory = gatewayDatabase.GetCollection<BsonDocument>("llmgw_service_key_directory");
var serviceKeyRateWindows = gatewayDatabase.GetCollection<BsonDocument>("llmgw_service_key_rate_windows");
await BackfillInternalTenantAsync(gatewayDatabase, internalTenantId, CancellationToken.None);
await EnsureInternalTenantAsync(
    users,
    tenants,
    teams,
    memberships,
    AdminUser,
    internalTenantId,
    CancellationToken.None);
await users.Indexes.CreateOneAsync(new CreateIndexModel<LlmGwUser>(
    Builders<LlmGwUser>.IndexKeys.Ascending(x => x.Username),
    new CreateIndexOptions { Name = "uniq_llmgw_console_user_username", Unique = true }));
await serviceKeyDirectory.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys.Ascending("KeyHash"),
    new CreateIndexOptions { Name = "uniq_llmgw_service_key_directory_hash", Unique = true }));
await serviceKeys.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("KeyHash"),
        new CreateIndexOptions { Name = "uniq_llmgw_service_key_tenant_hash", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Descending("CreatedAt"),
        new CreateIndexOptions { Name = "idx_llmgw_service_key_tenant_created" }),
});
await serviceKeyRateWindows.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("ServiceKeyId").Ascending("WindowStart"),
        new CreateIndexOptions { Name = "uniq_llmgw_service_key_rate_tenant_window", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
        new CreateIndexOptions { Name = "ttl_llmgw_service_key_rate_windows", ExpireAfter = TimeSpan.Zero }),
});
await promptPolicies.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("AppCallerCode").Ascending("RequestType").Ascending("Version"),
        new CreateIndexOptions { Name = "uniq_llmgw_prompt_policy_tenant_caller_type_version", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("TeamId").Ascending("UpdatedAt"),
        new CreateIndexOptions { Name = "idx_llmgw_prompt_policy_tenant_team_updated" }),
});

app.Use(async (http, next) =>
{
    if (http.User.Identity?.IsAuthenticated != true
        || http.GetEndpoint()?.Metadata.GetMetadata<IAllowAnonymous>() is not null)
    {
        await next();
        return;
    }

    var tenantAccess = await TenantAccess.ResolveAsync(
        http,
        memberships,
        tenants,
        CancellationToken.None);
    if (tenantAccess is null)
    {
        http.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await http.Response.WriteAsJsonAsync(new
        {
            success = false,
            error = new { code = "TENANT_SESSION_INVALID", message = "租户会话无效或成员权限已变更，请重新登录" },
        });
        return;
    }

    http.Items[TenantAccess.ItemKey] = tenantAccess;
    await next();
});
app.UseAuthorization();
var managedParameterCapabilities = new (string Name, string Label, string Category)[]
{
    ("temperature", "Temperature", "sampling"),
    ("top_p", "Top P", "sampling"),
    ("seed", "Seed", "sampling"),
    ("stop", "Stop sequences", "sampling"),
    ("frequency_penalty", "Frequency penalty", "sampling"),
    ("presence_penalty", "Presence penalty", "sampling"),
    ("response_format", "Response format", "structured-output"),
    ("json_schema", "JSON schema", "structured-output"),
    ("tools", "Tools", "tools"),
    ("tool_choice", "Tool choice", "tools"),
    ("parallel_tool_calls", "Parallel tool calls", "tools"),
    ("logprobs", "Logprobs", "logprobs"),
    ("top_logprobs", "Top logprobs", "logprobs"),
    ("reasoning_effort", "Reasoning effort", "reasoning"),
    ("thinking", "Thinking", "reasoning"),
    ("max_completion_tokens", "Max completion tokens", "generation"),
    ("max_tokens", "Max tokens", "generation"),
    ("modalities", "Modalities", "multimodal"),
    ("audio", "Audio output", "multimodal"),
    ("prediction", "Prediction", "generation"),
    ("stream_options", "Stream options", "streaming"),
    ("service_tier", "Service tier", "routing"),
    ("store", "Store", "metadata"),
    ("user", "User", "metadata"),
    ("n", "Choice count", "generation"),
};
var providerParameterCapabilityTemplates = new (string Key, string Label, string Provider, string Description, string[] Capabilities)[]
{
    ("openai-chat-standard", "OpenAI chat 标准", "openai", "OpenAI-compatible chat 常用采样、工具、结构化输出和日志概率参数。", new[]
    {
        "temperature", "top_p", "seed", "stop", "frequency_penalty", "presence_penalty", "tools", "tool_choice",
        "parallel_tool_calls", "response_format", "logprobs", "top_logprobs", "stream_options", "user",
    }),
    ("openai-reasoning", "OpenAI reasoning", "openai", "OpenAI-compatible reasoning 模型常见推理与 token 参数。", new[]
    {
        "reasoning_effort", "max_completion_tokens", "response_format", "tools", "tool_choice", "parallel_tool_calls",
    }),
    ("claude-messages", "Claude Messages", "claude", "Anthropic Messages 风格常用工具、thinking、停止序列和 token 参数。", new[]
    {
        "max_tokens", "stop", "tools", "tool_choice", "thinking",
    }),
    ("gemini-generate-content", "Gemini generateContent", "gemini", "Gemini generateContent 常用生成、工具和结构化输出参数。", new[]
    {
        "temperature", "top_p", "stop", "tools", "tool_choice", "response_format", "json_schema", "thinking",
    }),
    ("openrouter-multimodal", "OpenRouter multimodal", "openrouter", "OpenRouter/OpenAI-compatible 多模态与音频输出常用参数。", new[]
    {
        "modalities", "audio", "prediction", "tools", "tool_choice", "parallel_tool_calls", "response_format",
    }),
};

// ───────────────────────────── 健康检查（匿名）─────────────────────────────
app.MapGet("/gw/healthz", () => Results.Json(new
{
    status = "ok",
    commit = gitCommit,
    time = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
}, jsonOptions)).AllowAnonymous();

app.MapGet("/gw/lifecycle/status", async (HttpContext http) =>
{
    var latest = await lifecycleRuns.Find(TenantAccess.Filter(http))
        .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt"))
        .FirstOrDefaultAsync();
    var expected = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["llmrequestlogs"] = ["ttl_llmgw_logs_started"],
        ["llmshadow_comparisons"] = ["ttl_llmgw_shadow_compared"],
        ["llmgw_operation_audits"] = ["ttl_llmgw_operation_audits"],
        ["llmgw_login_audits"] = ["ttl_llmgw_login_audits"],
        ["llmgw_lifecycle_runs"] = ["ttl_llmgw_lifecycle_runs"],
    };
    var indexes = new List<Dictionary<string, object>>();
    foreach (var (collectionName, names) in expected)
    {
        var actualDocs = await (await gatewayDatabase.GetCollection<BsonDocument>(collectionName)
            .Indexes.ListAsync()).ToListAsync();
        var actual = actualDocs.Select(x => x.GetStringOrEmpty("name")).ToHashSet(StringComparer.Ordinal);
        indexes.AddRange(names.Select(name => new Dictionary<string, object>
        {
            ["collection"] = collectionName,
            ["name"] = name,
            ["ready"] = actual.Contains(name),
        }));
    }

    object? latestRun = latest is null ? null : new
    {
        id = latest.GetStringOrEmpty("_id"),
        mode = latest.GetStringOrEmpty("Mode"),
        status = latest.GetStringOrEmpty("Status"),
        startedAt = latest.AsNullableUtcDateTime("StartedAt").ToIso(),
        dryRunCompletedAt = latest.AsNullableUtcDateTime("DryRunCompletedAt").ToIso(),
        completedAt = latest.AsNullableUtcDateTime("CompletedAt").ToIso(),
        expiredRequestLogs = latest.AsNullableLong("ExpiredRequestLogs") ?? 0,
        sensitiveLogs = latest.AsNullableLong("SensitiveLogs") ?? 0,
        expiredShadowComparisons = latest.AsNullableLong("ExpiredShadowComparisons") ?? 0,
        expiredOperationAudits = latest.AsNullableLong("ExpiredOperationAudits") ?? 0,
        expiredLoginAudits = latest.AsNullableLong("ExpiredLoginAudits") ?? 0,
        expiredMultipartObjects = latest.AsNullableLong("ExpiredMultipartObjects") ?? 0,
        redactedSensitiveLogs = latest.AsNullableLong("RedactedSensitiveLogs") ?? 0,
        deletedMultipartObjects = latest.AsNullableLong("DeletedMultipartObjects") ?? 0,
        retentionIndexesReady = latest.AsNullableBool("RetentionIndexesReady") ?? false,
    };
    return Json(ApiEnvelope<object>.Ok(new
    {
        latestRun,
        indexes,
        allIndexesReady = indexes.All(x => x.TryGetValue("ready", out var value) && value is true),
    }), jsonOptions);
}).RequireAuthorization("AuditRead");

// ───────────────────────────── 登录（匿名）─────────────────────────────
// 登录失败返回 HTTP 200 + success:false，避免前端把 401 当作"会话过期"自动清 session。
app.MapPost("/gw/auth/login", async (HttpContext http, [FromBody] LoginRequestDto req) =>
{
    var username = (req.Username ?? "").Trim();
    var password = req.Password ?? "";
    if (username.Length == 0 || password.Length == 0)
    {
        await WriteLoginAuditAsync(loginAudits, http, internalTenantId, username, null, false, "EMPTY_CREDENTIALS");
        return Json(ApiEnvelope<LoginResultDto>.Fail("INVALID_CREDENTIALS", "用户名或密码不能为空"), jsonOptions);
    }

    var user = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
    if (user is null || !user.IsActive || !PasswordHasher.Verify(password, user.PasswordHash))
    {
        await WriteLoginAuditAsync(loginAudits, http, user?.DefaultTenantId ?? internalTenantId, username, user?.Id, false, user is null ? "USER_NOT_FOUND" : "INVALID_PASSWORD");
        return Json(ApiEnvelope<LoginResultDto>.Fail("INVALID_CREDENTIALS", "用户名或密码错误"), jsonOptions);
    }

    var activeMemberships = await memberships.Find(x => x.UserId == user.Id && x.Status == "active").ToListAsync();
    var activeTenantIds = activeMemberships.Select(x => x.TenantId).Distinct(StringComparer.Ordinal).ToList();
    var activeTenants = activeTenantIds.Count == 0
        ? new List<LlmGwTenant>()
        : await tenants.Find(x => activeTenantIds.Contains(x.Id) && x.Status == "active").ToListAsync();
    var activeTenantById = activeTenants.ToDictionary(x => x.Id, StringComparer.Ordinal);
    var membership = activeMemberships
        .Where(x => activeTenantById.ContainsKey(x.TenantId) && LlmGwTenantRoles.All.Contains(x.Role))
        .OrderByDescending(x => x.TenantId == user.DefaultTenantId)
        .ThenBy(x => x.CreatedAt)
        .FirstOrDefault();
    var tenant = membership is null ? null : activeTenantById.GetValueOrDefault(membership.TenantId);
    if (tenant is null || membership is null || !LlmGwTenantRoles.All.Contains(membership.Role))
    {
        await WriteLoginAuditAsync(loginAudits, http, user.DefaultTenantId ?? internalTenantId, username, user.Id, false, "TENANT_MEMBERSHIP_MISSING");
        return Json(ApiEnvelope<LoginResultDto>.Fail("TENANT_ACCESS_DENIED", "账号没有可用的租户成员关系"), jsonOptions, 403);
    }

    await users.UpdateOneAsync(u => u.Id == user.Id,
        Builders<LlmGwUser>.Update.Set(u => u.LastLoginAt, DateTime.UtcNow));
    await WriteLoginAuditAsync(loginAudits, http, tenant.Id, username, user.Id, true, null);

    var (token, expiresAt) = gwJwt.Issue(user, tenant, membership);
    var data = new LoginResultDto
    {
        Token = token,
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        MustChangePassword = user.MustChangePassword,
        Tenant = ToTenantSession(tenant, membership),
    };
    return Json(ApiEnvelope<LoginResultDto>.Ok(data), jsonOptions);
}).AllowAnonymous();

// ───────────────────────────── 改密（需鉴权，mcp token 也可）─────────────────────────────
// 首登强制改密：校验旧口令 → 写新哈希 → 清 MustChangePassword → 重新签发不带 mcp 的 token。
// 用普通 RequireAuthorization（不走 LogsRead 策略），使 mcp=1 的 token 能在此改密后解锁日志。
app.MapPost("/gw/auth/change-password", async (HttpContext http, [FromBody] ChangePasswordRequestDto req) =>
{
    var oldPwd = req.OldPassword ?? "";
    var newPwd = req.NewPassword ?? "";
    if (oldPwd.Length == 0 || newPwd.Length == 0)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("INVALID_INPUT", "旧口令与新口令不能为空"), jsonOptions);
    }
    if (newPwd.Length < 6)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("WEAK_PASSWORD", "新口令至少 6 位"), jsonOptions);
    }
    if (newPwd == oldPwd)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("SAME_PASSWORD", "新口令不能与旧口令相同"), jsonOptions);
    }

    // 从 token 的 sub（用户 Id）定位账号，避免依赖可变的用户名。
    var userId = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
        ?? http.User.FindFirst("sub")?.Value;
    if (string.IsNullOrEmpty(userId))
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("UNAUTHORIZED", "无效的登录态"), jsonOptions, statusCode: 401);
    }

    var user = await users.Find(u => u.Id == userId).FirstOrDefaultAsync();
    if (user is null || !user.IsActive)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("UNAUTHORIZED", "账号不存在或已停用"), jsonOptions, statusCode: 401);
    }
    if (!PasswordHasher.Verify(oldPwd, user.PasswordHash))
    {
        await WriteOperationAuditAsync(
            operationAudits,
            http,
            action: "auth.change_password",
            targetType: "llmgw_console_user",
            targetId: user.Id,
            targetName: user.Username,
            success: false,
            reason: "INVALID_OLD_PASSWORD");
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("INVALID_CREDENTIALS", "旧口令错误"), jsonOptions);
    }

    var wasMustChangePassword = user.MustChangePassword;
    var update = Builders<LlmGwUser>.Update
        .Set(u => u.PasswordHash, PasswordHasher.Hash(newPwd))
        .Set(u => u.MustChangePassword, false)
        // 标记为真人认领：默认模式下重启不再自愈回 admin/admin，保住用户新口令。
        .Set(u => u.PasswordChangedByUser, true)
        .Set(u => u.UpdatedAt, DateTime.UtcNow);
    await users.UpdateOneAsync(u => u.Id == user.Id, update);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "auth.change_password",
        targetType: "llmgw_console_user",
        targetId: user.Id,
        targetName: user.Username,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "mustChangePassword", new BsonDocument { { "from", wasMustChangePassword }, { "to", false } } },
            { "passwordChangedByUser", new BsonDocument { { "from", user.PasswordChangedByUser }, { "to", true } } },
        });

    // 重新签发 token（此时 MustChangePassword 已清，Issue 不再带 mcp claim）。
    user.MustChangePassword = false;
    var tenantAccess = TenantAccess.GetRequired(http);
    var membership = await memberships.Find(x => x.Id == tenantAccess.MembershipId && x.TenantId == tenantAccess.TenantId && x.UserId == user.Id && x.Status == "active").FirstOrDefaultAsync();
    var tenant = membership is null ? null : await tenants.Find(x => x.Id == tenantAccess.TenantId && x.Status == "active").FirstOrDefaultAsync();
    if (tenant is null || membership is null)
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("TENANT_ACCESS_DENIED", "租户成员关系已失效"), jsonOptions, 403);
    var (token, expiresAt) = gwJwt.Issue(user, tenant, membership);
    var data = new ChangePasswordResultDto
    {
        Token = token,
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        Tenant = ToTenantSession(tenant, membership),
    };
    return Json(ApiEnvelope<ChangePasswordResultDto>.Ok(data), jsonOptions);
}).RequireAuthorization();

app.MapGet("/gw/auth/context", (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    return Json(ApiEnvelope<TenantSessionDto>.Ok(new TenantSessionDto
    {
        Id = access.TenantId,
        Name = access.TenantName,
        Role = access.Role,
        TeamIds = access.TeamIds.ToList(),
    }), jsonOptions);
}).RequireAuthorization("UsageRead");

app.MapPost("/gw/auth/switch-tenant", async (HttpContext http, [FromBody] SwitchTenantRequestDto body) =>
{
    var requestedTenantId = (body.TenantId ?? string.Empty).Trim();
    var userId = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
        ?? http.User.FindFirst("sub")?.Value;
    if (requestedTenantId.Length == 0 || string.IsNullOrWhiteSpace(userId))
        return Json(ApiEnvelope<LoginResultDto>.Fail("INVALID_TENANT", "tenantId 不能为空"), jsonOptions, 400);

    var user = await users.Find(x => x.Id == userId && x.IsActive).FirstOrDefaultAsync();
    var membership = user is null ? null : await memberships.Find(x => x.TenantId == requestedTenantId && x.UserId == user.Id && x.Status == "active").FirstOrDefaultAsync();
    var tenant = membership is null ? null : await tenants.Find(x => x.Id == requestedTenantId && x.Status == "active").FirstOrDefaultAsync();
    if (user is null || membership is null || tenant is null || !LlmGwTenantRoles.All.Contains(membership.Role))
        return Json(ApiEnvelope<LoginResultDto>.Fail("TENANT_ACCESS_DENIED", "无权切换到该租户"), jsonOptions, 403);

    await users.UpdateOneAsync(x => x.Id == user.Id, Builders<LlmGwUser>.Update.Set(x => x.DefaultTenantId, tenant.Id).Set(x => x.UpdatedAt, DateTime.UtcNow));
    var (token, expiresAt) = gwJwt.Issue(user, tenant, membership);
    return Json(ApiEnvelope<LoginResultDto>.Ok(new LoginResultDto
    {
        Token = token,
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        MustChangePassword = false,
        Tenant = ToTenantSession(tenant, membership),
    }), jsonOptions);
}).RequireAuthorization("UsageRead");

app.MapPost("/gw/tenants", async (HttpContext http, [FromBody] CreateTenantRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var name = (body.Name ?? string.Empty).Trim();
    var slug = (body.Slug ?? string.Empty).Trim().ToLowerInvariant();
    if (name.Length is < 2 or > 120 || slug.Length is < 2 or > 64
        || slug.Any(c => !(char.IsAsciiLetterOrDigit(c) || c == '-')))
        return Json(ApiEnvelope<object>.Fail("INVALID_TENANT", "名称需为 2-120 字符，slug 仅支持 2-64 位小写字母、数字和连字符"), jsonOptions, 400);

    var now = DateTime.UtcNow;
    var tenant = new LlmGwTenant
    {
        Name = name,
        NormalizedName = name.ToUpperInvariant(),
        Slug = slug,
        NormalizedSlug = slug.ToUpperInvariant(),
        CreatedAt = now,
        UpdatedAt = now,
    };
    var team = new LlmGwTeam
    {
        TenantId = tenant.Id,
        Name = "Default",
        NormalizedName = "DEFAULT",
        CreatedAt = now,
        UpdatedAt = now,
    };
    var membership = new LlmGwMembership
    {
        TenantId = tenant.Id,
        UserId = access.UserId,
        Role = LlmGwTenantRoles.Owner,
        TeamIds = new List<string> { team.Id },
        CreatedAt = now,
        UpdatedAt = now,
    };
    try
    {
        await tenants.InsertOneAsync(tenant);
        await teams.InsertOneAsync(team);
        await memberships.InsertOneAsync(membership);
        await users.UpdateOneAsync(x => x.Id == access.UserId,
            Builders<LlmGwUser>.Update.AddToSet(x => x.TenantIds, tenant.Id).Set(x => x.UpdatedAt, now));
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        await tenants.DeleteOneAsync(x => x.Id == tenant.Id);
        await teams.DeleteOneAsync(x => x.Id == team.Id && x.TenantId == tenant.Id);
        await memberships.DeleteOneAsync(x => x.Id == membership.Id && x.TenantId == tenant.Id);
        return Json(ApiEnvelope<object>.Fail("TENANT_CONFLICT", "租户 slug 已存在"), jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http, "tenant.create", "llmgw_tenant", tenant.Id, tenant.Name, true, null,
        new BsonDocument { { "slug", tenant.Slug } });
    return Json(ApiEnvelope<object>.Ok(new { tenant.Id, tenant.Name, tenant.Slug, defaultTeamId = team.Id }), jsonOptions, 201);
}).RequireAuthorization("TenantOwner");

app.MapGet("/gw/organization", async (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    var tenant = await tenants.Find(x => x.Id == access.TenantId).FirstOrDefaultAsync();
    var tenantTeams = await teams.Find(x => x.TenantId == access.TenantId)
        .SortBy(x => x.Name).ToListAsync();
    var tenantMemberships = await memberships.Find(x => x.TenantId == access.TenantId)
        .SortBy(x => x.CreatedAt).ToListAsync();
    var userIds = tenantMemberships.Select(x => x.UserId).Distinct(StringComparer.Ordinal).ToList();
    var tenantUsers = await users.Find(Builders<LlmGwUser>.Filter.In(x => x.Id, userIds)).ToListAsync();
    var userById = tenantUsers.ToDictionary(x => x.Id, StringComparer.Ordinal);
    return Json(ApiEnvelope<object>.Ok(new
    {
        tenant = tenant is null ? null : new { tenant.Id, tenant.Name, tenant.Slug, tenant.Status, tenant.IsInternal },
        teams = tenantTeams.Select(x => new { x.Id, x.Name, x.Status, x.CreatedAt, x.UpdatedAt }),
        members = tenantMemberships.Select(x => new
        {
            x.Id,
            x.UserId,
            username = userById.GetValueOrDefault(x.UserId)?.Username,
            displayName = userById.GetValueOrDefault(x.UserId)?.DisplayName,
            x.Role,
            x.TeamIds,
            x.Status,
            x.Version,
            x.CreatedAt,
            x.UpdatedAt,
        }),
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

app.MapPost("/gw/teams", async (HttpContext http, [FromBody] CreateTeamRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var name = (body.Name ?? string.Empty).Trim();
    if (name.Length is < 2 or > 120)
        return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "团队名称需为 2-120 字符"), jsonOptions, 400);
    var team = new LlmGwTeam
    {
        TenantId = access.TenantId,
        Name = name,
        NormalizedName = name.ToUpperInvariant(),
    };
    try
    {
        await teams.InsertOneAsync(team);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<object>.Fail("TEAM_CONFLICT", "当前租户已存在同名团队"), jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http, "team.create", "llmgw_team", team.Id, team.Name, true, null);
    return Json(ApiEnvelope<object>.Ok(new { team.Id, team.Name, team.Status }), jsonOptions, 201);
}).RequireAuthorization("OrganizationWrite");

app.MapPut("/gw/teams/{id}", async (HttpContext http, string id, [FromBody] UpdateTeamRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var team = await teams.Find(x => x.Id == id && x.TenantId == access.TenantId).FirstOrDefaultAsync();
    if (team is null) return Json(ApiEnvelope<object>.Fail("TEAM_NOT_FOUND", "团队不存在"), jsonOptions, 404);
    var updates = new List<UpdateDefinition<LlmGwTeam>>();
    if (body.Name is not null)
    {
        var name = body.Name.Trim();
        if (name.Length is < 2 or > 120) return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "团队名称需为 2-120 字符"), jsonOptions, 400);
        updates.Add(Builders<LlmGwTeam>.Update.Set(x => x.Name, name).Set(x => x.NormalizedName, name.ToUpperInvariant()));
    }
    if (body.Status is not null)
    {
        var status = body.Status.Trim().ToLowerInvariant();
        if (status is not ("active" or "disabled")) return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "status 仅支持 active/disabled"), jsonOptions, 400);
        updates.Add(Builders<LlmGwTeam>.Update.Set(x => x.Status, status));
    }
    if (updates.Count == 0) return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "没有可更新字段"), jsonOptions, 400);
    updates.Add(Builders<LlmGwTeam>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow));
    try
    {
        await teams.UpdateOneAsync(x => x.Id == id && x.TenantId == access.TenantId, Builders<LlmGwTeam>.Update.Combine(updates));
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<object>.Fail("TEAM_CONFLICT", "当前租户已存在同名团队"), jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http, "team.update", "llmgw_team", id, team.Name, true, null);
    return Json(ApiEnvelope<object>.Ok(new { id, updated = true }), jsonOptions);
}).RequireAuthorization("OrganizationWrite");

app.MapPost("/gw/members", async (HttpContext http, [FromBody] CreateMemberRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var username = (body.Username ?? string.Empty).Trim();
    var role = (body.Role ?? LlmGwTenantRoles.Viewer).Trim().ToLowerInvariant();
    var teamIds = (body.TeamIds ?? []).Distinct(StringComparer.Ordinal).ToList();
    if (username.Length is < 3 or > 80 || !LlmGwTenantRoles.All.Contains(role))
        return Json(ApiEnvelope<object>.Fail("INVALID_MEMBER", "用户名或角色无效"), jsonOptions, 400);
    if (role == LlmGwTenantRoles.Owner && access.Role != LlmGwTenantRoles.Owner)
        return Json(ApiEnvelope<object>.Fail("OWNER_REQUIRED", "只有 owner 可以授予 owner 角色"), jsonOptions, 403);
    if (teamIds.Count > 0 && await teams.CountDocumentsAsync(x => x.TenantId == access.TenantId && teamIds.Contains(x.Id) && x.Status == "active") != teamIds.Count)
        return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "包含不属于当前租户的团队"), jsonOptions, 400);

    var memberUser = await users.Find(x => x.Username == username).FirstOrDefaultAsync();
    if (memberUser is null)
    {
        var initialPassword = body.InitialPassword ?? string.Empty;
        if (initialPassword.Length < 12)
            return Json(ApiEnvelope<object>.Fail("INVALID_PASSWORD", "新用户初始密码至少 12 位"), jsonOptions, 400);
        memberUser = new LlmGwUser
        {
            Username = username,
            DisplayName = string.IsNullOrWhiteSpace(body.DisplayName) ? username : body.DisplayName.Trim(),
            PasswordHash = PasswordHasher.Hash(initialPassword),
            MustChangePassword = true,
            TenantIds = new List<string> { access.TenantId },
            DefaultTenantId = access.TenantId,
        };
        await users.InsertOneAsync(memberUser);
    }
    if (await memberships.CountDocumentsAsync(x => x.TenantId == access.TenantId && x.UserId == memberUser.Id) > 0)
        return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_CONFLICT", "用户已是当前租户成员"), jsonOptions, 409);

    var membership = new LlmGwMembership
    {
        TenantId = access.TenantId,
        UserId = memberUser.Id,
        Role = role,
        TeamIds = teamIds,
    };
    await memberships.InsertOneAsync(membership);
    await users.UpdateOneAsync(x => x.Id == memberUser.Id,
        Builders<LlmGwUser>.Update.AddToSet(x => x.TenantIds, access.TenantId).Set(x => x.UpdatedAt, DateTime.UtcNow));
    await WriteOperationAuditAsync(operationAudits, http, "membership.create", "llmgw_membership", membership.Id, memberUser.Username, true, null,
        new BsonDocument { { "role", membership.Role }, { "userId", membership.UserId } });
    return Json(ApiEnvelope<object>.Ok(new { membership.Id, membership.UserId, memberUser.Username, membership.Role, membership.TeamIds }), jsonOptions, 201);
}).RequireAuthorization("OrganizationWrite");

app.MapPut("/gw/members/{id}", async (HttpContext http, string id, [FromBody] UpdateMemberRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var membership = await memberships.Find(x => x.Id == id && x.TenantId == access.TenantId).FirstOrDefaultAsync();
    if (membership is null) return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_NOT_FOUND", "成员关系不存在"), jsonOptions, 404);
    var role = body.Role?.Trim().ToLowerInvariant();
    var status = body.Status?.Trim().ToLowerInvariant();
    if (role is not null && !LlmGwTenantRoles.All.Contains(role)) return Json(ApiEnvelope<object>.Fail("INVALID_ROLE", "角色无效"), jsonOptions, 400);
    if (status is not null && status is not ("active" or "disabled")) return Json(ApiEnvelope<object>.Fail("INVALID_STATUS", "status 仅支持 active/disabled"), jsonOptions, 400);
    if ((membership.Role == LlmGwTenantRoles.Owner || role == LlmGwTenantRoles.Owner)
        && access.Role != LlmGwTenantRoles.Owner)
        return Json(ApiEnvelope<object>.Fail("OWNER_REQUIRED", "只有 owner 可以修改 owner 成员关系"), jsonOptions, 403);
    var removesOwner = membership.Role == LlmGwTenantRoles.Owner
        && (role is not null && role != LlmGwTenantRoles.Owner || status == "disabled");
    if (removesOwner && await memberships.CountDocumentsAsync(x => x.TenantId == access.TenantId && x.Role == LlmGwTenantRoles.Owner && x.Status == "active") <= 1)
        return Json(ApiEnvelope<object>.Fail("LAST_OWNER", "不能移除租户最后一个 owner"), jsonOptions, 409);
    if (body.TeamIds is not null)
    {
        var teamIds = body.TeamIds.Distinct(StringComparer.Ordinal).ToList();
        if (teamIds.Count > 0 && await teams.CountDocumentsAsync(x => x.TenantId == access.TenantId && teamIds.Contains(x.Id) && x.Status == "active") != teamIds.Count)
            return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "包含不属于当前租户的团队"), jsonOptions, 400);
        membership.TeamIds = teamIds;
    }
    if (role is not null) membership.Role = role;
    if (status is not null) membership.Status = status;
    membership.Version++;
    membership.UpdatedAt = DateTime.UtcNow;
    await memberships.ReplaceOneAsync(x => x.Id == id && x.TenantId == access.TenantId, membership);
    await WriteOperationAuditAsync(operationAudits, http, "membership.update", "llmgw_membership", membership.Id, membership.UserId, true, null,
        new BsonDocument { { "role", membership.Role }, { "status", membership.Status }, { "version", membership.Version } });
    return Json(ApiEnvelope<object>.Ok(new { membership.Id, membership.Role, membership.Status, membership.TeamIds, membership.Version }), jsonOptions);
}).RequireAuthorization("OrganizationWrite");

// ───────────────────────────── 日志列表（需鉴权）─────────────────────────────
app.MapGet("/gw/logs", async (
    HttpContext http,
    int? page, int? pageSize, string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType,
    string? sourceSystem, string? ingressProtocol, string? modelPolicy, string? releaseCommit,
    string? runId, string? requestId, string? sessionId) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = TenantAccess.Filter(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId));

    var total = await logs.CountDocumentsAsync(filter);
    var docs = await logs.Find(filter)
        .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt"))
        .Skip((p - 1) * ps)
        .Limit(ps)
        .ToListAsync();

    var data = new LogsListData
    {
        Items = docs.Select(MapListItem).ToList(),
        Total = total,
        Page = p,
        PageSize = ps,
    };
    return Json(ApiEnvelope<LogsListData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 元信息（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/meta", async (HttpContext http) =>
{
    var since = DateTime.UtcNow.AddDays(-30);
    var recent = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Gte("StartedAt", since));

    var modelsRaw = await logs.Distinct<string>("Model", recent).ToListAsync();
    var statusesRaw = await logs.Distinct<string>("Status", recent).ToListAsync();
    var providersRaw = await logs.Distinct<string>("Provider", recent).ToListAsync();
    var appCallersRaw = await logs.Distinct<string>("AppCallerCode", recent).ToListAsync();
    var transportsRaw = await logs.Distinct<string>("GatewayTransport", recent).ToListAsync();
    var requestTypesRaw = await logs.Distinct<string>("RequestType", recent).ToListAsync();
    var sourceSystemsRaw = await logs.Distinct<string>("SourceSystem", recent).ToListAsync();
    var ingressProtocolsRaw = await logs.Distinct<string>("IngressProtocol", recent).ToListAsync();
    var modelPoliciesRaw = await logs.Distinct<string>("ModelPolicy", recent).ToListAsync();

    return Json(ApiEnvelope<LogsMeta>.Ok(new LogsMeta
    {
        Models = NormalizeDistinct(modelsRaw, 200),
        Statuses = NormalizeDistinct(statusesRaw, 80),
        Providers = NormalizeDistinct(providersRaw, 200),
        AppCallers = NormalizeDistinct(appCallersRaw, 300),
        Transports = NormalizeDistinct(transportsRaw, 40),
        RequestTypes = NormalizeDistinct(requestTypesRaw, 80),
        SourceSystems = NormalizeDistinct(sourceSystemsRaw, 80),
        IngressProtocols = NormalizeDistinct(ingressProtocolsRaw, 80),
        ModelPolicies = NormalizeDistinct(modelPoliciesRaw, 40),
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 时间序列（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/timeseries", async (
    HttpContext http,
    string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType,
    string? sourceSystem, string? ingressProtocol, string? modelPolicy, string? releaseCommit,
    string? runId, string? requestId, string? sessionId) =>
{
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = TenantAccess.Filter(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId));

    // 仅取 StartedAt 字段做内存分组（按 UTC 日期）。
    var projection = Builders<BsonDocument>.Projection.Include("StartedAt");
    var docs = await logs.Find(filter).Project(projection).ToListAsync();

    var buckets = new Dictionary<string, int>();
    foreach (var d in docs)
    {
        var started = d.AsNullableUtcDateTime("StartedAt");
        if (started is null) continue;
        var key = started.Value.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        buckets[key] = buckets.TryGetValue(key, out var c) ? c + 1 : 1;
    }

    var items = buckets
        .OrderBy(kv => kv.Key, StringComparer.Ordinal)
        .Select(kv => new TimeseriesPoint { Date = kv.Key, Count = kv.Value })
        .ToList();

    return Json(ApiEnvelope<TimeseriesData>.Ok(new TimeseriesData { Items = items }), jsonOptions);
}).RequireAuthorization("UsageRead");

// ───────────────────────────── 窗口汇总（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/summary", async (
    HttpContext http,
    string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType,
    string? sourceSystem, string? ingressProtocol, string? modelPolicy, string? releaseCommit,
    string? runId, string? requestId, string? sessionId) =>
{
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = TenantAccess.Filter(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId));
    var projection = Builders<BsonDocument>.Projection
        .Include("Status")
        .Include("DurationMs")
        .Include("InputTokens")
        .Include("OutputTokens")
        .Include("EstimatedCostUsd")
        .Include("IsFallback")
        .Include("GatewayTransport")
        .Include("SourceSystem")
        .Include("IngressProtocol")
        .Include("ModelPolicy");
    var docs = await logs.Find(filter).Project(projection).ToListAsync();

    var durations = docs.Select(d => d.AsNullableLong("DurationMs")).Where(d => d is > 0).Select(d => d!.Value).ToList();
    var data = new LogsSummaryData
    {
        Total = docs.Count,
        Succeeded = docs.LongCount(d => d.GetStringOrEmpty("Status") == "succeeded"),
        Failed = docs.LongCount(d => d.GetStringOrEmpty("Status") == "failed"),
        Running = docs.LongCount(d => d.GetStringOrEmpty("Status") == "running"),
        Cancelled = docs.LongCount(d => d.GetStringOrEmpty("Status") == "cancelled"),
        Fallbacks = docs.LongCount(d => d.AsNullableBool("IsFallback") == true),
        InputTokens = docs.Sum(d => (long)(d.AsNullableInt("InputTokens") ?? 0)),
        OutputTokens = docs.Sum(d => (long)(d.AsNullableInt("OutputTokens") ?? 0)),
        EstimatedCostUsd = docs.Sum(d => d.AsNullableDecimal("EstimatedCostUsd") ?? 0m),
        AverageDurationMs = durations.Count == 0 ? null : (long)Math.Round(durations.Average()),
        TransportDistribution = BuildBucket(docs, "GatewayTransport", fallbackKey: "unknown"),
        StatusDistribution = BuildBucket(docs, "Status", fallbackKey: "unknown"),
        SourceSystemDistribution = BuildBucket(docs, "SourceSystem", fallbackKey: "unknown"),
        IngressProtocolDistribution = BuildBucket(docs, "IngressProtocol", fallbackKey: "unknown"),
        ModelPolicyDistribution = BuildBucket(docs, "ModelPolicy", fallbackKey: "unknown"),
    };
    data.TotalTokens = data.InputTokens + data.OutputTokens;

    return Json(ApiEnvelope<LogsSummaryData>.Ok(data), jsonOptions);
}).RequireAuthorization("UsageRead");

// ───────────────────────────── 协议入口运行覆盖（需鉴权）─────────────────────────────
app.MapGet("/gw/protocol-coverage", async (HttpContext http, string? releaseCommit, int? sinceHours) =>
{
    var hours = sinceHours is > 0 and <= 24 * 30 ? sinceHours.Value : 24;
    var runtimeCommit = NormalizeCommitFilter(releaseCommit);
    var since = DateTime.UtcNow.AddHours(-hours);
    var logFilter = runtimeCommit is null
        ? Builders<BsonDocument>.Filter.Gte("StartedAt", since)
        : Builders<BsonDocument>.Filter.Eq("ReleaseCommit", runtimeCommit);
    logFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
        logFilter,
        Builders<BsonDocument>.Filter.Ne("IsHealthProbe", true)));

    var logProjection = Builders<BsonDocument>.Projection
        .Include("IngressProtocol")
        .Include("AppCallerCode")
        .Include("RequestType")
        .Include("GatewayTransport")
        .Include("Status")
        .Include("StartedAt")
        .Include("DroppedParameters");
    var logDocs = await logs.Find(logFilter).Project(logProjection).ToListAsync();
    var appCallerDocs = await gwAppCallers.Find(TenantAccess.Filter(http)).ToListAsync();

    var items = TargetIngressProtocols().Select(protocol =>
    {
        var registryDocs = appCallerDocs
            .Where(d => GetObservedIngressProtocols(d).Contains(protocol.Key, StringComparer.Ordinal))
            .ToList();
        var activeDocs = registryDocs
            .Where(d => IsRuntimeGovernedAppCallerStatus(d.AsNullableString("Status")))
            .ToList();
        var activeCodes = activeDocs
            .Select(d => d.AsNullableString("AppCallerCode"))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .ToHashSet(StringComparer.Ordinal);
        var protocolLogs = logDocs
            .Where(d => string.Equals(NormalizeIngressProtocol(d.AsNullableString("IngressProtocol")), protocol.Key, StringComparison.Ordinal))
            .ToList();
        var loggedCodes = protocolLogs
            .Select(d => d.AsNullableString("AppCallerCode"))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .ToHashSet(StringComparer.Ordinal);
        var coveredActive = activeCodes.Count(loggedCodes.Contains);
        var missingActive = activeCodes
            .Where(code => !loggedCodes.Contains(code))
            .OrderBy(code => code, StringComparer.Ordinal)
            .ToList();
        var registryLastSeen = registryDocs
            .Select(d => d.AsNullableUtcDateTime("LastSeenAt"))
            .Where(x => x is not null)
            .Select(x => x!.Value);
        var logLastSeen = protocolLogs
            .Select(d => d.AsNullableUtcDateTime("StartedAt"))
            .Where(x => x is not null)
            .Select(x => x!.Value);
        var lastSeen = registryLastSeen.Concat(logLastSeen).DefaultIfEmpty().Max();
        var status = registryDocs.Count == 0 && protocolLogs.Count == 0
            ? "no-evidence"
            : activeCodes.Count > 0 && missingActive.Count == 0 && protocolLogs.Count > 0
                ? "covered"
                : protocolLogs.Count > 0
                    ? "runtime-seen"
                    : "registry-only";

        return new ProtocolCoverageItem
        {
            IngressProtocol = protocol.Key,
            Label = protocol.Label,
            Status = status,
            RegisteredAppCallers = registryDocs.Count,
            ActiveAppCallers = activeCodes.Count,
            CoveredActiveAppCallers = coveredActive,
            MissingActiveAppCallers = missingActive.Count,
            LogRequests = protocolLogs.Count,
            HttpRequests = protocolLogs.LongCount(d => string.Equals(d.AsNullableString("GatewayTransport"), "http", StringComparison.OrdinalIgnoreCase)),
            FailedRequests = protocolLogs.LongCount(d => string.Equals(d.AsNullableString("Status"), "failed", StringComparison.OrdinalIgnoreCase)),
            DroppedParameterRequests = protocolLogs.LongCount(HasDroppedParameters),
            RequestTypes = NormalizeDistinct(protocolLogs.Select(d => d.AsNullableString("RequestType")), 20),
            MissingActiveAppCallerCodes = missingActive.Take(20).ToList(),
            LastSeenAt = lastSeen == default ? null : lastSeen.ToString("O"),
            LogsLink = $"/logs?ingressProtocol={Uri.EscapeDataString(protocol.Key)}{(runtimeCommit is null ? string.Empty : $"&releaseCommit={Uri.EscapeDataString(runtimeCommit)}")}",
            AppCallersLink = $"/app-callers?ingressProtocol={Uri.EscapeDataString(protocol.Key)}",
        };
    }).ToList();

    return Json(ApiEnvelope<ProtocolCoverageData>.Ok(new ProtocolCoverageData
    {
        ReleaseCommit = runtimeCommit,
        SinceHours = hours,
        GeneratedAt = DateTime.UtcNow.ToString("O"),
        TotalLogRequests = logDocs.Count,
        TotalRegisteredAppCallers = items.Sum(x => x.RegisteredAppCallers),
        TotalActiveAppCallers = items.Sum(x => x.ActiveAppCallers),
        CoveredProtocols = items.Count(x => x.LogRequests > 0),
        MissingRuntimeProtocols = items.Count(x => x.LogRequests == 0),
        Items = items,
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 会话聚合（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/sessions", async (
    HttpContext http,
    string? from, string? to, int? page, int? pageSize,
    string? model, string? status, string? provider, string? appCallerCode, string? transport, string? requestType,
    string? sourceSystem, string? ingressProtocol, string? modelPolicy, string? releaseCommit,
    string? runId, string? requestId, string? sessionId) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = TenantAccess.Filter(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId));

    var docs = await logs.Find(filter)
        .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt"))
        .ToListAsync();

    // 按 SessionId 聚合（跳过空 sessionId）。
    var groups = new Dictionary<string, List<BsonDocument>>();
    foreach (var d in docs)
    {
        var sid = d.AsNullableString("SessionId");
        if (string.IsNullOrEmpty(sid)) continue;
        if (!groups.TryGetValue(sid, out var list))
        {
            list = new List<BsonDocument>();
            groups[sid] = list;
        }
        list.Add(d);
    }

    var allItems = groups.Select(g => BuildSessionItem(g.Key, g.Value))
        .OrderByDescending(s => s.End, StringComparer.Ordinal)
        .ToList();

    var total = allItems.Count;
    var pageItems = allItems.Skip((p - 1) * ps).Take(ps).ToList();

    var data = new SessionsData
    {
        Items = pageItems,
        Total = total,
        Page = p,
        PageSize = ps,
    };
    return Json(ApiEnvelope<SessionsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 日志详情（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/{id}", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await logs.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
    {
        return Json(ApiEnvelope<LlmLogDetail>.Fail("NOT_FOUND", "日志不存在"), jsonOptions, statusCode: 404);
    }
    return Json(ApiEnvelope<LlmLogDetail>.Ok(MapDetail(doc)), jsonOptions);
}).RequireAuthorization("RequestBodyRead");

// ─────────────── 网关配置面（只读，腿 B 第一刀）───────────────
// 让网关控制台不只有日志，还能看模型池 / 平台 / 模型 / 影子比对。密钥字段一律不返回（只回 hasKey）。

// 模型池列表
app.MapGet("/gw/pools", async (HttpContext http, string? modelType) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var filter = string.IsNullOrWhiteSpace(modelType) ? fb.Empty : fb.Eq("ModelType", modelType);
    var mapDocs = TenantAccess.GetRequired(http).TenantId == internalTenantId
        ? await modelGroups.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync()
        : new List<BsonDocument>();
    var gwDocs = await gwModelPools.Find(TenantAccess.Filter(http, filter)).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync();
    var gwIds = gwDocs.Select(d => d.GetStringOrEmpty("_id")).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet(StringComparer.Ordinal);
    var docs = gwDocs.Concat(mapDocs.Where(d => !gwIds.Contains(d.GetStringOrEmpty("_id")))).ToList();
    var data = new PoolsData { Items = docs.Select(MapPool).ToList(), Total = docs.Count };
    return Json(ApiEnvelope<PoolsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 平台列表（密钥字段绝不外泄，只回 hasKey）
app.MapGet("/gw/platforms", async (HttpContext http) =>
{
    var mapDocs = TenantAccess.GetRequired(http).TenantId == internalTenantId
        ? await platforms.Find(FilterDefinition<BsonDocument>.Empty).Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync()
        : new List<BsonDocument>();
    var gwDocs = await gwPlatforms.Find(TenantAccess.Filter(http))
        .Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync();
    var gwIds = gwDocs.Select(d => d.GetStringOrEmpty("_id")).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet(StringComparer.Ordinal);
    var docs = gwDocs.Concat(mapDocs.Where(d => !gwIds.Contains(d.GetStringOrEmpty("_id")))).ToList();
    var data = new PlatformsData { Items = docs.Select(MapPlatform).ToList(), Total = docs.Count };
    return Json(ApiEnvelope<PlatformsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 模型列表（密钥字段绝不外泄，只回 hasKey）
app.MapGet("/gw/models", async (HttpContext http, string? platformId, bool? enabled) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var fs = new List<FilterDefinition<BsonDocument>>();
    if (!string.IsNullOrWhiteSpace(platformId)) fs.Add(fb.Eq("PlatformId", platformId));
    if (enabled is not null) fs.Add(fb.Eq("Enabled", enabled.Value));
    var filter = fs.Count > 0 ? fb.And(fs) : fb.Empty;
    var mapDocs = TenantAccess.GetRequired(http).TenantId == internalTenantId
        ? await models.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync()
        : new List<BsonDocument>();
    var gwDocs = await gwModels.Find(TenantAccess.Filter(http, filter)).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync();
    var gwIds = gwDocs.Select(d => d.GetStringOrEmpty("_id")).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet(StringComparer.Ordinal);
    var docs = gwDocs.Concat(mapDocs.Where(d => !gwIds.Contains(d.GetStringOrEmpty("_id")))).ToList();
    var data = new ModelsData { Items = docs.Select(MapModel).ToList(), Total = docs.Count };
    return Json(ApiEnvelope<ModelsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 字段级参数能力元数据：控制台以此维护 parameter:<name>，运行时 strict gate 以同一批参数收紧。
app.MapGet("/gw/parameter-capabilities/meta", () =>
{
    var data = new ParameterCapabilitiesMetaData
    {
        Items = managedParameterCapabilities
            .Select(x => new ParameterCapabilityMetaItem
            {
                Name = x.Name,
                Label = x.Label,
                Category = x.Category,
                CapabilityType = $"parameter:{x.Name}",
            })
            .ToList(),
        Templates = providerParameterCapabilityTemplates
            .Select(x => new ParameterCapabilityTemplateItem
            {
                Key = x.Key,
                Label = x.Label,
                Provider = x.Provider,
                Description = x.Description,
                Capabilities = x.Capabilities.Select(p => $"parameter:{p}").ToList(),
            })
            .ToList(),
    };
    return Json(ApiEnvelope<ParameterCapabilitiesMetaData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// Exchange 列表（密钥字段绝不外泄，只回 hasKey）
app.MapGet("/gw/exchanges", async (HttpContext http, bool? enabled) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var filter = enabled is null ? fb.Empty : fb.Eq("Enabled", enabled.Value);
    var mapDocs = TenantAccess.GetRequired(http).TenantId == internalTenantId
        ? await modelExchanges.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync()
        : new List<BsonDocument>();
    var gwDocs = await gwModelExchanges.Find(TenantAccess.Filter(http, filter)).Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync();
    var gwIds = gwDocs.Select(d => d.GetStringOrEmpty("_id")).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet(StringComparer.Ordinal);
    var docs = gwDocs.Concat(mapDocs.Where(d => !gwIds.Contains(d.GetStringOrEmpty("_id")))).ToList();
    var data = new ExchangesData { Items = docs.Select(MapExchange).ToList(), Total = docs.Count };
    return Json(ApiEnvelope<ExchangesData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// GW-owned key 健康自检：只解密验证，不返回明文/密文/脱敏 key，不打上游，避免产生成本。
app.MapGet("/gw/key-health", async (HttpContext http) =>
{
    var items = new List<KeyHealthItem>();
    var gwPlatformDocs = await gwPlatforms.Find(TenantAccess.Filter(http))
        .Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync();
    var gwModelDocs = await gwModels.Find(TenantAccess.Filter(http))
        .Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync();
    var gwExchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http))
        .Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync();

    items.AddRange(gwPlatformDocs.Select(d => MapKeyHealth(d, "platform", "ApiKeyEncrypted", config)));
    items.AddRange(gwModelDocs.Select(d => MapKeyHealth(d, "model", "ApiKeyEncrypted", config)));
    items.AddRange(gwExchangeDocs.Select(d => MapKeyHealth(d, "exchange", "TargetApiKeyEncrypted", config)));

    var unreadable = items.Count(x => x.Status == "unreadable");
    var legacyReadable = items.Count(x => x.UsedLegacySecret);
    var primaryConfigured = GwApiKeyCrypto.HasDedicatedPrimarySecret(config);
    var summary = new KeyHealthSummary
    {
        PrimaryConfigured = primaryConfigured,
        LegacySecretCount = GwApiKeyCrypto.GetLegacySecrets(config).Count,
        Total = items.Count,
        Ok = items.Count(x => x.Status == "ok"),
        Missing = items.Count(x => x.Status == "missing"),
        Unreadable = unreadable,
        LegacyReadable = legacyReadable,
        StubUnreadable = items.Count(x => x.Status == "stub-unreadable"),
        Status = !primaryConfigured ? "config-missing" : unreadable > 0 ? "unreadable" : legacyReadable > 0 ? "legacy" : "ok",
    };
    return Json(ApiEnvelope<KeyHealthData>.Ok(new KeyHealthData { Summary = summary, Items = items }), jsonOptions);
}).RequireAuthorization("LogsRead");

// 配置权威迁移报告：只读量化 MAP fallback 退场前的差距，不修改任何配置。
app.MapGet("/gw/config-authority/report", async (HttpContext http) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<ConfigAuthorityReportData>.Fail("INTERNAL_GOVERNANCE_ONLY", "该报告仅供内部租户使用"), jsonOptions, 403);
    var mapPoolDocs = await modelGroups.Find(FilterDefinition<BsonDocument>.Empty).ToListAsync();
    var gwPoolDocs = await gwModelPools.Find(TenantAccess.Filter(http)).ToListAsync();
    var mapPlatformDocs = await platforms.Find(FilterDefinition<BsonDocument>.Empty).ToListAsync();
    var gwPlatformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    var mapModelDocs = await models.Find(FilterDefinition<BsonDocument>.Empty).ToListAsync();
    var gwModelDocs = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
    var mapExchangeDocs = await modelExchanges.Find(FilterDefinition<BsonDocument>.Empty).ToListAsync();
    var gwExchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync();
    var appCallerDocs = await gwAppCallers.Find(TenantAccess.Filter(http)).ToListAsync();

    static HashSet<string> IdSet(IEnumerable<BsonDocument> docs) =>
        docs.Select(d => d.GetStringOrEmpty("_id")).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet(StringComparer.Ordinal);
    static int MapOnlyCount(IEnumerable<BsonDocument> mapDocs, HashSet<string> gwIds) =>
        mapDocs.Count(d => !gwIds.Contains(d.GetStringOrEmpty("_id")));

    var gwPoolIds = IdSet(gwPoolDocs);
    var gwPlatformIds = IdSet(gwPlatformDocs);
    var gwModelIds = IdSet(gwModelDocs);
    var gwExchangeIds = IdSet(gwExchangeDocs);
    var usableGwPoolIds = new HashSet<string>(StringComparer.Ordinal);
    foreach (var pool in gwPoolDocs)
    {
        var poolId = pool.GetStringOrEmpty("_id");
        if (poolId.Length > 0 && await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, pool))
        {
            usableGwPoolIds.Add(poolId);
        }
    }

    var activeAppCallers = appCallerDocs
        .Where(d => string.Equals(d.AsNullableString("Status") ?? "discovered", "active", StringComparison.OrdinalIgnoreCase))
        .ToList();
    var activeWithGatewayPool = activeAppCallers.Count(d =>
    {
        var poolId = d.AsNullableString("ModelPoolId");
        return !string.IsNullOrWhiteSpace(poolId) && gwPoolIds.Contains(poolId);
    });
    var activeWithUsableGatewayPool = activeAppCallers.Count(d =>
    {
        var poolId = d.AsNullableString("ModelPoolId");
        return !string.IsNullOrWhiteSpace(poolId) && usableGwPoolIds.Contains(poolId);
    });
    var activeMissingGatewayPool = activeAppCallers.Count - activeWithGatewayPool;
    var activeBoundPoolWithoutUsableMember = activeWithGatewayPool - activeWithUsableGatewayPool;
    var discovered = appCallerDocs.Count(d => string.Equals(d.AsNullableString("Status") ?? "discovered", "discovered", StringComparison.OrdinalIgnoreCase));
    var configured = appCallerDocs.Count(d => string.Equals(d.AsNullableString("Status") ?? string.Empty, "configured", StringComparison.OrdinalIgnoreCase));
    var disabled = appCallerDocs.Count(d => string.Equals(d.AsNullableString("Status") ?? string.Empty, "disabled", StringComparison.OrdinalIgnoreCase));

    var mapOnlyPools = MapOnlyCount(mapPoolDocs, gwPoolIds);
    var mapOnlyPlatforms = MapOnlyCount(mapPlatformDocs, gwPlatformIds);
    var mapOnlyModels = MapOnlyCount(mapModelDocs, gwModelIds);
    var mapOnlyExchanges = MapOnlyCount(mapExchangeDocs, gwExchangeIds);
    var mapFallbackObjectsRemaining = mapOnlyPools + mapOnlyPlatforms + mapOnlyModels + mapOnlyExchanges;
    var activeAppCallerMapFallbackReady = activeMissingGatewayPool == 0
        && discovered == 0
        && activeBoundPoolWithoutUsableMember == 0;
    var blockers = mapOnlyPools
        + mapOnlyPlatforms
        + mapOnlyModels
        + mapOnlyExchanges
        + activeMissingGatewayPool
        + activeBoundPoolWithoutUsableMember
        + discovered;
    var totalSurface = mapPoolDocs.Count + mapPlatformDocs.Count + mapModelDocs.Count + mapExchangeDocs.Count + Math.Max(1, appCallerDocs.Count);
    var readinessPercent = totalSurface == 0 ? 100 : Math.Clamp((int)Math.Round(((double)(totalSurface - blockers) / totalSurface) * 100), 0, 100);
    var status = activeMissingGatewayPool > 0 || activeBoundPoolWithoutUsableMember > 0
        ? "blocked"
        : blockers > 0 ? "partial" : "ready";

    var gaps = new List<ConfigAuthorityGapItem>();
    void AddMapOnlyGaps(IEnumerable<BsonDocument> docs, HashSet<string> gwIds, string objectType, Func<BsonDocument, string> nameSelector)
    {
        foreach (var d in docs.Where(x => !gwIds.Contains(x.GetStringOrEmpty("_id"))).Take(30))
        {
            gaps.Add(new ConfigAuthorityGapItem
            {
                ObjectType = objectType,
                Id = d.GetStringOrEmpty("_id"),
                Name = nameSelector(d),
                Status = "map-only",
                Detail = "MAP 中存在，但 llm_gateway 尚未接管；resolver 仍可能需要 MAP fallback。",
            });
        }
    }
    AddMapOnlyGaps(mapPoolDocs, gwPoolIds, "pool", d => d.AsNullableString("Name") ?? d.AsNullableString("Code") ?? d.GetStringOrEmpty("_id"));
    AddMapOnlyGaps(mapPlatformDocs, gwPlatformIds, "platform", d => d.AsNullableString("Name") ?? d.GetStringOrEmpty("_id"));
    AddMapOnlyGaps(mapModelDocs, gwModelIds, "model", d => d.AsNullableString("ModelName") ?? d.AsNullableString("Name") ?? d.GetStringOrEmpty("_id"));
    AddMapOnlyGaps(mapExchangeDocs, gwExchangeIds, "exchange", d => d.AsNullableString("Name") ?? d.GetStringOrEmpty("_id"));
    gaps.AddRange(activeAppCallers
        .Where(d =>
        {
            var poolId = d.AsNullableString("ModelPoolId");
            return string.IsNullOrWhiteSpace(poolId) || !gwPoolIds.Contains(poolId);
        })
        .Take(30)
        .Select(d => new ConfigAuthorityGapItem
        {
            ObjectType = "appCaller",
            Id = d.GetStringOrEmpty("_id"),
            Name = d.AsNullableString("AppCallerCode") ?? d.GetStringOrEmpty("_id"),
            Status = "active-missing-gw-pool",
            Detail = "active appCaller 未绑定有效 GW 模型池；删除 MAP fallback 前必须修复。",
        }));
    gaps.AddRange(activeAppCallers
        .Where(d =>
        {
            var poolId = d.AsNullableString("ModelPoolId");
            return !string.IsNullOrWhiteSpace(poolId) && gwPoolIds.Contains(poolId) && !usableGwPoolIds.Contains(poolId);
        })
        .Take(30)
        .Select(d => new ConfigAuthorityGapItem
        {
            ObjectType = "appCaller",
            Id = d.GetStringOrEmpty("_id"),
            Name = d.AsNullableString("AppCallerCode") ?? d.GetStringOrEmpty("_id"),
            Status = "gw-pool-without-usable-member",
            Detail = "active appCaller 已绑定 GW 模型池，但该池没有可解析、非 unavailable 的成员；MAP fallback 退场前必须修复。",
        }));

    var summary = new ConfigAuthoritySummary
    {
        MapPools = mapPoolDocs.Count,
        GatewayPools = gwPoolDocs.Count,
        MapOnlyPools = mapOnlyPools,
        MapPlatforms = mapPlatformDocs.Count,
        GatewayPlatforms = gwPlatformDocs.Count,
        MapOnlyPlatforms = mapOnlyPlatforms,
        MapModels = mapModelDocs.Count,
        GatewayModels = gwModelDocs.Count,
        MapOnlyModels = mapOnlyModels,
        MapExchanges = mapExchangeDocs.Count,
        GatewayExchanges = gwExchangeDocs.Count,
        MapOnlyExchanges = mapOnlyExchanges,
        AppCallersTotal = appCallerDocs.Count,
        ActiveAppCallers = activeAppCallers.Count,
        ActiveWithGatewayPool = activeWithGatewayPool,
        ActiveWithUsableGatewayPool = activeWithUsableGatewayPool,
        ActiveMissingGatewayPool = activeMissingGatewayPool,
        ActiveBoundPoolWithoutUsableMember = activeBoundPoolWithoutUsableMember,
        DiscoveredAppCallers = discovered,
        ConfiguredAppCallers = configured,
        DisabledAppCallers = disabled,
        MapFallbackObjectsRemaining = mapFallbackObjectsRemaining,
        ActiveAppCallerMapFallbackReady = activeAppCallerMapFallbackReady,
        ActiveAppCallerMapFallbackPolicy = "set LlmGateway:DisableMapConfigFallbackForActiveAppCallers=true after active appCallers bind valid GW pools",
        ReadinessPercent = readinessPercent,
        Status = status,
    };

    return Json(ApiEnvelope<ConfigAuthorityReportData>.Ok(new ConfigAuthorityReportData
    {
        Summary = summary,
        Gaps = gaps,
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

// 运行态发布 gate：聚合只读证据，直接回答“现在是否可以切 full-http”。
// 这里不写配置、不读外部 provider，只把控制台已有证据压成可复核状态。
app.MapGet("/gw/runtime-gates", async (HttpContext http) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<RuntimeGatesData>.Fail("INTERNAL_GOVERNANCE_ONLY", "运行 gate 仅供内部租户使用"), jsonOptions, 403);
    var mapPoolDocs = await modelGroups.Find(FilterDefinition<BsonDocument>.Empty).Project(Builders<BsonDocument>.Projection.Include("_id")).ToListAsync();
    var gwPoolDocs = await gwModelPools.Find(TenantAccess.Filter(http)).Project(
        Builders<BsonDocument>.Projection.Include("_id").Include("Name").Include("Code").Include("Models")).ToListAsync();
    var mapPlatformDocs = await platforms.Find(FilterDefinition<BsonDocument>.Empty).Project(Builders<BsonDocument>.Projection.Include("_id")).ToListAsync();
    var gwPlatformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).Project(
        Builders<BsonDocument>.Projection.Include("_id").Include("Enabled")).ToListAsync();
    var mapModelDocs = await models.Find(FilterDefinition<BsonDocument>.Empty).Project(Builders<BsonDocument>.Projection.Include("_id")).ToListAsync();
    var gwModelDocs = await gwModels.Find(TenantAccess.Filter(http)).Project(
        Builders<BsonDocument>.Projection.Include("_id").Include("ModelName").Include("Name").Include("PlatformId").Include("Enabled")).ToListAsync();
    var mapExchangeDocs = await modelExchanges.Find(FilterDefinition<BsonDocument>.Empty).Project(Builders<BsonDocument>.Projection.Include("_id")).ToListAsync();
    var gwExchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http)).Project(
        Builders<BsonDocument>.Projection.Include("_id").Include("Name").Include("Enabled").Include("ModelAlias").Include("ModelAliases").Include("Models")).ToListAsync();
    var appCallerDocs = await gwAppCallers.Find(TenantAccess.Filter(http)).Project(
        Builders<BsonDocument>.Projection
            .Include("_id")
            .Include("AppCallerCode")
            .Include("Status")
            .Include("ModelPoolId")
            .Include("ModelPolicy")
            .Include("ParameterPolicy")
            .Include("IngressProtocol")
            .Include("ObservedIngressProtocols")
            .Include("LastObservedModelPoolId")
            .Include("LastObservedModelPolicy")
            .Include("LastObservedParameterPolicy")
            .Include("ObservedModelPoolIds")
            .Include("ObservedModelPolicies")
            .Include("ObservedParameterPolicies")).ToListAsync();

    static HashSet<string> IdSet(IEnumerable<BsonDocument> docs) =>
        docs.Select(d => d.GetStringOrEmpty("_id")).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet(StringComparer.Ordinal);
    static int MapOnlyCount(IEnumerable<BsonDocument> mapDocs, HashSet<string> gwIds) =>
        mapDocs.Count(d => !gwIds.Contains(d.GetStringOrEmpty("_id")));
    static bool IsGovernedAppCaller(BsonDocument d)
    {
        var status = d.AsNullableString("Status") ?? "discovered";
        return string.Equals(status, "active", StringComparison.OrdinalIgnoreCase)
               || string.Equals(status, "configured", StringComparison.OrdinalIgnoreCase);
    }
    static bool HasObservedFieldDrift(BsonDocument d, string configuredField, string observedField, string observedValuesField)
    {
        var configured = d.AsNullableString(configuredField) ?? string.Empty;
        if (d.TryGetValue(observedValuesField, out var values) && values.IsBsonArray)
        {
            var observedValues = values.AsBsonArray
                .Where(x => x.IsString && !string.IsNullOrWhiteSpace(x.AsString))
                .Select(x => x.AsString)
                .ToHashSet(StringComparer.Ordinal);
            if (observedValues.Count > 0) return !observedValues.Contains(configured);
        }
        var observed = d.AsNullableString(observedField);
        if (string.IsNullOrWhiteSpace(observed)) return false;
        return !string.Equals(configured, observed, StringComparison.Ordinal);
    }
    static bool HasUsablePoolMember(BsonDocument pool, HashSet<string> enabledPlatformIds, List<BsonDocument> enabledModels, List<BsonDocument> enabledExchanges)
    {
        var modelsArr = pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
        return modelsArr
            .Where(x => x.IsBsonDocument)
            .Select(x => x.AsBsonDocument)
            .Any(member => IsResolvablePoolMember(member, enabledPlatformIds, enabledModels, enabledExchanges));
    }
    static bool IsResolvablePoolMember(BsonDocument member, HashSet<string> enabledPlatformIds, List<BsonDocument> enabledModels, List<BsonDocument> enabledExchanges)
    {
        if ((member.AsNullableInt("HealthStatus") ?? 0) == 2) return false;
        var modelId = member.GetStringOrEmpty("ModelId");
        var platformId = member.GetStringOrEmpty("PlatformId");
        if (modelId.Length == 0 || platformId.Length == 0) return false;
        if (string.Equals(platformId, "__exchange__", StringComparison.Ordinal))
        {
            return enabledExchanges.Any(exchange => ExchangeSupportsModel(exchange, modelId));
        }
        var exchangeById = enabledExchanges.FirstOrDefault(exchange => string.Equals(exchange.GetStringOrEmpty("_id"), platformId, StringComparison.Ordinal));
        if (exchangeById is not null) return ExchangeSupportsModel(exchangeById, modelId);
        if (!enabledPlatformIds.Contains(platformId)) return false;
        return enabledModels.Any(model =>
            string.Equals(model.AsNullableString("PlatformId"), platformId, StringComparison.Ordinal)
            && (string.Equals(model.GetStringOrEmpty("_id"), modelId, StringComparison.Ordinal)
                || string.Equals(model.AsNullableString("ModelName"), modelId, StringComparison.Ordinal)
                || string.Equals(model.AsNullableString("Name"), modelId, StringComparison.Ordinal)));
    }
    static bool ExchangeSupportsModel(BsonDocument exchange, string modelId)
    {
        if (string.Equals(exchange.AsNullableString("ModelAlias"), modelId, StringComparison.Ordinal)) return true;
        if (exchange.AsStringList("ModelAliases").Contains(modelId, StringComparer.Ordinal)) return true;
        var modelsArr = exchange.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
        return modelsArr
            .Where(x => x.IsBsonDocument)
            .Select(x => x.AsBsonDocument)
            .Any(m => (m.AsNullableBool("Enabled") ?? true)
                      && (string.Equals(m.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal)
                          || string.Equals(m.AsNullableString("DisplayName"), modelId, StringComparison.Ordinal)));
    }

    var gwPoolIds = IdSet(gwPoolDocs);
    var activeAppCallers = appCallerDocs
        .Where(d => string.Equals(d.AsNullableString("Status") ?? "discovered", "active", StringComparison.OrdinalIgnoreCase))
        .ToList();
    var activeAppCallerCodes = activeAppCallers
        .Select(d => d.AsNullableString("AppCallerCode"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x!)
        .ToHashSet(StringComparer.Ordinal);
    var activeMissingGatewayPool = activeAppCallers.Count(d =>
    {
        var poolId = d.AsNullableString("ModelPoolId");
        return string.IsNullOrWhiteSpace(poolId) || !gwPoolIds.Contains(poolId);
    });
    var discoveredAppCallers = appCallerDocs.Count(d =>
        string.Equals(d.AsNullableString("Status") ?? "discovered", "discovered", StringComparison.OrdinalIgnoreCase));
    var governedAppCallers = appCallerDocs.Where(IsGovernedAppCaller).ToList();
    var appCallerRouteDrift = governedAppCallers.Count(d =>
        HasObservedFieldDrift(d, "ModelPolicy", "LastObservedModelPolicy", "ObservedModelPolicies")
        || HasObservedFieldDrift(d, "ModelPoolId", "LastObservedModelPoolId", "ObservedModelPoolIds"));
    var appCallerParameterDrift = governedAppCallers.Count(d =>
        HasObservedFieldDrift(d, "ParameterPolicy", "LastObservedParameterPolicy", "ObservedParameterPolicies"));
    var enabledGwPlatformIds = gwPlatformDocs
        .Where(d => d.AsNullableBool("Enabled") ?? true)
        .Select(d => d.GetStringOrEmpty("_id"))
        .Where(x => x.Length > 0)
        .ToHashSet(StringComparer.Ordinal);
    var enabledGwModels = gwModelDocs.Where(d => d.AsNullableBool("Enabled") ?? true).ToList();
    var enabledGwExchanges = gwExchangeDocs.Where(d => d.AsNullableBool("Enabled") ?? true).ToList();
    var activeBoundPoolIds = activeAppCallers
        .Select(d => d.AsNullableString("ModelPoolId"))
        .Where(x => !string.IsNullOrWhiteSpace(x) && gwPoolIds.Contains(x!))
        .Select(x => x!)
        .ToHashSet(StringComparer.Ordinal);
    var activeBoundPools = gwPoolDocs.Where(d => activeBoundPoolIds.Contains(d.GetStringOrEmpty("_id"))).ToList();
    var activeBoundPoolWithoutUsableMember = activeBoundPools.Count(pool => !HasUsablePoolMember(pool, enabledGwPlatformIds, enabledGwModels, enabledGwExchanges));
    var mapFallbackObjectsRemaining =
        MapOnlyCount(mapPoolDocs, gwPoolIds)
        + MapOnlyCount(mapPlatformDocs, IdSet(gwPlatformDocs))
        + MapOnlyCount(mapModelDocs, IdSet(gwModelDocs))
        + MapOnlyCount(mapExchangeDocs, IdSet(gwExchangeDocs));
    var targetProtocols = TargetIngressProtocols();
    var targetProtocolKeys = targetProtocols.Select(x => x.Key).ToHashSet(StringComparer.Ordinal);
    var registryObservedProtocols = appCallerDocs
        .SelectMany(GetObservedIngressProtocols)
        .Where(targetProtocolKeys.Contains)
        .ToHashSet(StringComparer.Ordinal);
    var missingRegistryProtocols = targetProtocols
        .Where(p => !registryObservedProtocols.Contains(p.Key))
        .Select(p => p.Key)
        .ToList();

    var runtimeCommit = NormalizeCommitFilter(gitCommit);
    var shadowFilter = runtimeCommit is null
        ? TenantAccess.Filter(http)
        : TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("ReleaseCommit", runtimeCommit));
    var shadowTotal = runtimeCommit is null ? 0 : await shadows.CountDocumentsAsync(shadowFilter);
    var shadowCritical = runtimeCommit is null ? 0 : await shadows.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(shadowFilter, Builders<BsonDocument>.Filter.Eq("HasCritical", true)));
    var shadowHttpFail = runtimeCommit is null ? 0 : await shadows.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(shadowFilter, Builders<BsonDocument>.Filter.Eq("HttpOk", false)));
    var retainedShadowCandidates = new List<BsonDocument>();
    if (runtimeCommit is not null && shadowTotal == 0)
    {
        retainedShadowCandidates = await shadows.Aggregate()
            .Match(Builders<BsonDocument>.Filter.And(
                TenantAccess.Filter(http),
                Builders<BsonDocument>.Filter.Ne("ReleaseCommit", runtimeCommit),
                Builders<BsonDocument>.Filter.Exists("ReleaseCommit", true),
                Builders<BsonDocument>.Filter.Ne("ReleaseCommit", BsonNull.Value),
                Builders<BsonDocument>.Filter.Ne("ReleaseCommit", string.Empty)))
            .Group(new BsonDocument
            {
                { "_id", "$ReleaseCommit" },
                { "Total", new BsonDocument("$sum", 1) },
                { "Critical", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$HasCritical", true }),
                        1,
                        0,
                    })) },
                { "HttpFail", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$HttpOk", false }),
                        1,
                        0,
                    })) },
                { "LastComparedAt", new BsonDocument("$max", "$ComparedAt") },
            })
            .Match(Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Gt("Total", 0),
                Builders<BsonDocument>.Filter.Eq("Critical", 0),
                Builders<BsonDocument>.Filter.Eq("HttpFail", 0)))
            .Sort(new BsonDocument("LastComparedAt", -1))
            .ToListAsync();
    }
    var logReleaseFilter = runtimeCommit is null
        ? TenantAccess.Filter(http)
        : TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("ReleaseCommit", runtimeCommit),
            Builders<BsonDocument>.Filter.Ne("IsHealthProbe", true)));
    var releaseLogTotal = runtimeCommit is null ? 0 : await logs.CountDocumentsAsync(logReleaseFilter);
    var httpTransportLogs = runtimeCommit is null
        ? 0
        : await logs.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(
            logReleaseFilter,
            Builders<BsonDocument>.Filter.Eq("GatewayTransport", "http")));
    var nonHttpTransportLogs = runtimeCommit is null
        ? 0
        : await logs.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(
            logReleaseFilter,
            Builders<BsonDocument>.Filter.Ne("GatewayTransport", "http")));
    var droppedParameterLogs = runtimeCommit is null
        ? 0
        : await logs.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(
            logReleaseFilter,
            Builders<BsonDocument>.Filter.Exists("DroppedParameters.0", true)));
    var releaseLogAppCallers = runtimeCommit is null
        ? new List<string>()
        : await logs.Distinct<string>("AppCallerCode", logReleaseFilter).ToListAsync();
    var releaseProtocolLogDocs = runtimeCommit is null
        ? new List<BsonDocument>()
        : await logs.Find(logReleaseFilter)
            .Project(Builders<BsonDocument>.Projection
                .Include("IngressProtocol")
                .Include("GatewayTransport")
                .Include("Status")
                .Include("DroppedParameters"))
            .ToListAsync();
    var coveredIngressProtocols = releaseProtocolLogDocs
        .Select(d => NormalizeIngressProtocol(d.AsNullableString("IngressProtocol")))
        .Where(targetProtocolKeys.Contains)
        .ToHashSet(StringComparer.Ordinal);
    var missingIngressProtocols = targetProtocols
        .Where(p => !coveredIngressProtocols.Contains(p.Key))
        .Select(p => p.Key)
        .ToList();
    var protocolFailedLogs = releaseProtocolLogDocs.LongCount(d =>
        targetProtocolKeys.Contains(NormalizeIngressProtocol(d.AsNullableString("IngressProtocol")))
        && string.Equals(d.AsNullableString("Status"), "failed", StringComparison.OrdinalIgnoreCase));
    var protocolDroppedParameterLogs = releaseProtocolLogDocs.LongCount(d =>
        targetProtocolKeys.Contains(NormalizeIngressProtocol(d.AsNullableString("IngressProtocol")))
        && HasDroppedParameters(d));
    var releaseShadowAppCallers = runtimeCommit is null
        ? new List<string>()
        : await shadows.Distinct<string>("AppCallerCode", shadowFilter).ToListAsync();
    var coveredAppCallerCodes = releaseLogAppCallers
        .Concat(releaseShadowAppCallers)
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .ToHashSet(StringComparer.Ordinal);
    var missingRuntimeCoverageAppCallers = activeAppCallerCodes
        .Where(code => !coveredAppCallerCodes.Contains(code))
        .OrderBy(code => code, StringComparer.Ordinal)
        .ToList();
    var keyHealthItems = new List<KeyHealthItem>();
    keyHealthItems.AddRange((await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync()).Select(d => MapKeyHealth(d, "platform", "ApiKeyEncrypted", config)));
    keyHealthItems.AddRange((await gwModels.Find(TenantAccess.Filter(http)).ToListAsync()).Select(d => MapKeyHealth(d, "model", "ApiKeyEncrypted", config)));
    keyHealthItems.AddRange((await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync()).Select(d => MapKeyHealth(d, "exchange", "TargetApiKeyEncrypted", config)));
    var keyPrimaryConfigured = GwApiKeyCrypto.HasDedicatedPrimarySecret(config);
    var keyUnreadable = keyHealthItems.Count(x => x.Status == "unreadable");
    var keyLegacyReadable = keyHealthItems.Count(x => x.UsedLegacySecret);
    var keyStubUnreadable = keyHealthItems.Count(x => x.Status == "stub-unreadable");
    var keyMissingBlocking = keyHealthItems.Count(x => x.Enabled && x.Status == "missing" && (x.ObjectType == "platform" || x.ObjectType == "exchange"));
    var keyGateReady = keyPrimaryConfigured && keyUnreadable == 0 && keyLegacyReadable == 0 && keyStubUnreadable == 0 && keyMissingBlocking == 0;
    var disableMapFallbackForActiveAppCallers = IsTruthy(config["LlmGateway:DisableMapConfigFallbackForRegisteredAppCallers"])
        || IsTruthy(Environment.GetEnvironmentVariable("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_REGISTERED_APP_CALLERS"))
        // 兼容现有生产变量和历史 rollout ledger 字段。
        || IsTruthy(config["LlmGateway:DisableMapConfigFallbackForActiveAppCallers"])
        || IsTruthy(Environment.GetEnvironmentVariable("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS"));
    var ledgerPath = config["LlmGateway:RolloutLedgerPath"]
        ?? Environment.GetEnvironmentVariable("LLMGW_ROLLOUT_LEDGER")
        ?? ".llmgw-release-evidence/rollout-ledger.jsonl";
    var configAuthorityLedgerEvidence = ReadLatestConfigAuthorityRolloutLedgerEvidence(ledgerPath, gitCommit);
    var httpFullLedgerEvidence = ReadLatestHttpFullRolloutLedgerEvidence(ledgerPath, gitCommit);
    var successfulHttpFullCommits = ReadSuccessfulHttpFullRolloutCommits(ledgerPath);
    var retainedShadowEvidence = successfulHttpFullCommits
        .Select(commit => retainedShadowCandidates.FirstOrDefault(candidate =>
            string.Equals(candidate.AsNullableString("_id"), commit, StringComparison.OrdinalIgnoreCase)))
        .FirstOrDefault(candidate => candidate is not null);
    var retainedShadowCommit = retainedShadowEvidence?.AsNullableString("_id") ?? string.Empty;
    var retainedShadowTotal = retainedShadowEvidence?.AsNullableLong("Total") ?? 0;
    var retainedShadowMatchesPreviousFullHttp = retainedShadowCommit.Length > 0
        && successfulHttpFullCommits.Contains(retainedShadowCommit, StringComparer.OrdinalIgnoreCase);
    var canRetainPreviousShadowEvidence = shadowTotal == 0
        && retainedShadowMatchesPreviousFullHttp
        && configAuthorityLedgerEvidence.Ready
        && releaseLogTotal > 0
        && httpTransportLogs == releaseLogTotal
        && droppedParameterLogs == 0
        && missingIngressProtocols.Count == 0
        && protocolFailedLogs == 0
        && missingRuntimeCoverageAppCallers.Count == 0;
    var activeAppCallerMapFallbackCutoverPrerequisitesReady =
        mapFallbackObjectsRemaining == 0
        && activeMissingGatewayPool == 0
        && discoveredAppCallers == 0
        && activeBoundPoolWithoutUsableMember == 0;
    var activeAppCallerMapFallbackExitReady =
        activeAppCallerMapFallbackCutoverPrerequisitesReady
        && (!httpFullLedgerEvidence.Ready || disableMapFallbackForActiveAppCallers);

    var items = new List<RuntimeGateItem>();
    static RuntimeGateLink Link(string label, string to) => new() { Label = label, To = to };
    static string Query(string key, string? value)
        => string.IsNullOrWhiteSpace(value) ? string.Empty : $"?{key}={Uri.EscapeDataString(value.Trim())}";
    static List<RuntimeGateLink> RuntimeGateLinks(string id, Dictionary<string, string> facts, string? releaseCommit)
    {
        var commit = facts.TryGetValue("releaseCommit", out var factCommit) && !string.IsNullOrWhiteSpace(factCommit)
            ? factCommit
            : releaseCommit;
        var releaseQuery = Query("releaseCommit", commit);
        var missingCode = facts.TryGetValue("missingAppCallerCodes", out var missingCodes)
            ? missingCodes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault()
            : null;
        return id switch
        {
            "config_authority_objects" => new()
            {
                Link("模型池", "/pools"),
                Link("平台", "/platforms"),
                Link("模型", "/models"),
                Link("Exchange", "/exchanges"),
            },
            "config_authority_rollout_ledger" => new()
            {
                Link("审计", "/audits?targetType=llmgw_config_authority"),
                Link("概览", "/"),
            },
            "active_appcaller_pool_binding" => new()
            {
                Link("active 调用方", "/app-callers?status=active"),
                Link("discovered 调用方", "/app-callers?status=discovered"),
                Link("模型池", "/pools"),
            },
            "appcaller_policy_drift" => new() { Link("漂移调用方", "/app-callers?drift=any") },
            "appcaller_ingress_registry_coverage" => new()
            {
                Link("协议覆盖", "/?protocolCoverage=1"),
                Link("调用方", "/app-callers"),
            },
            "gateway_pool_member_readiness" => new() { Link("检查模型池", "/pools") },
            "active_appcaller_map_fallback_exit" => new()
            {
                Link("active 调用方", "/app-callers?status=active"),
                Link("模型池", "/pools"),
                Link("平台密钥", "/platforms"),
            },
            "gateway_key_integrity" => new()
            {
                Link("平台密钥", "/platforms"),
                Link("模型密钥", "/models"),
                Link("Exchange 密钥", "/exchanges"),
            },
            "current_commit_http_transport" => new() { Link("当前 commit 日志", $"/logs{releaseQuery}") },
            "dropped_parameter_runtime_evidence" => new() { Link("参数证据日志", $"/logs{releaseQuery}") },
            "appcaller_runtime_coverage" => new()
            {
                Link("active 调用方", string.IsNullOrWhiteSpace(missingCode)
                    ? "/app-callers?status=active"
                    : $"/app-callers?status=active&search={Uri.EscapeDataString(missingCode)}"),
                Link("当前 commit 日志", $"/logs{releaseQuery}"),
                Link("当前 commit shadow", $"/shadow{releaseQuery}"),
            },
            "protocol_runtime_coverage" => new()
            {
                Link("协议覆盖", $"/?protocolCoverage=1{(string.IsNullOrWhiteSpace(commit) ? string.Empty : $"&releaseCommit={Uri.EscapeDataString(commit)}")}"),
                Link("协议日志", $"/logs{releaseQuery}"),
                Link("调用方", "/app-callers"),
            },
            "shadow_runtime_evidence" => new()
            {
                Link("shadow 样本", $"/shadow{releaseQuery}{(releaseQuery.Length > 0 ? "&" : "?")}{ShadowQuickQuery(facts)}"),
            },
            "full_http_rollout_ledger" => new()
            {
                Link("当前 commit 日志", $"/logs{releaseQuery}"),
                Link("当前 commit shadow", $"/shadow{releaseQuery}"),
            },
            _ => new(),
        };
    }
    static string ShadowQuickQuery(Dictionary<string, string> facts)
    {
        var critical = facts.TryGetValue("critical", out var c) && int.TryParse(c, out var criticalCount) ? criticalCount : 0;
        var httpFail = facts.TryGetValue("httpFail", out var h) && int.TryParse(h, out var httpFailCount) ? httpFailCount : 0;
        if (critical > 0) return "quick=critical";
        if (httpFail > 0) return "quick=httpFail";
        return "quick=all";
    }
    void AddGate(string id, string label, string status, bool blocking, string detail, string evidence, string nextAction, Dictionary<string, string>? facts = null)
    {
        var gateFacts = facts ?? new Dictionary<string, string>();
        items.Add(new RuntimeGateItem
        {
            Id = id,
            Label = label,
            Status = status,
            Blocking = blocking,
            Detail = detail,
            Evidence = evidence,
            NextAction = nextAction,
            Facts = gateFacts,
            Links = RuntimeGateLinks(id, gateFacts, runtimeCommit),
        });
    }

    AddGate(
        "config_authority_objects",
        "MAP-only 配置退场",
        mapFallbackObjectsRemaining == 0 ? "pass" : "blocked",
        mapFallbackObjectsRemaining > 0,
        mapFallbackObjectsRemaining == 0
            ? "MAP 池、平台、模型、Exchange 均已被 llm_gateway 接管。"
            : $"仍有 {mapFallbackObjectsRemaining} 个 MAP-only 配置对象，resolver 仍可能需要 MAP fallback。",
        $"/gw/config-authority/report mapFallbackObjectsRemaining={mapFallbackObjectsRemaining}",
        mapFallbackObjectsRemaining == 0 ? "保持只读观察。" : "先运行 config-authority 备份与认领，再复查报告。",
        new Dictionary<string, string>
        {
            ["mapFallbackObjectsRemaining"] = mapFallbackObjectsRemaining.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["mapOnlyPools"] = MapOnlyCount(mapPoolDocs, gwPoolIds).ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["mapOnlyPlatforms"] = MapOnlyCount(mapPlatformDocs, IdSet(gwPlatformDocs)).ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["mapOnlyModels"] = MapOnlyCount(mapModelDocs, IdSet(gwModelDocs)).ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["mapOnlyExchanges"] = MapOnlyCount(mapExchangeDocs, IdSet(gwExchangeDocs)).ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    AddGate(
        "config_authority_rollout_ledger",
        "配置权威执行台账",
        configAuthorityLedgerEvidence.Ready ? "pass" : "waiting",
        !configAuthorityLedgerEvidence.Ready,
        configAuthorityLedgerEvidence.Detail,
        configAuthorityLedgerEvidence.Evidence,
        configAuthorityLedgerEvidence.Ready ? "保留备份和执行证据。" : "通过 llmgw-prod-stage 的 config-authority 阶段生成同 commit 的备份和执行台账。",
        configAuthorityLedgerEvidence.Facts);

    AddGate(
        "active_appcaller_pool_binding",
        "active appCaller GW 池绑定",
        activeMissingGatewayPool == 0 && discoveredAppCallers == 0 ? "pass" : "blocked",
        activeMissingGatewayPool > 0 || discoveredAppCallers > 0,
        activeMissingGatewayPool == 0 && discoveredAppCallers == 0
            ? "active appCaller 均已绑定有效 GW 模型池，且无 discovered 调用方等待治理。"
            : $"{activeMissingGatewayPool} 个 active 未绑定有效 GW 池，{discoveredAppCallers} 个 discovered 调用方尚未治理。",
        $"/gw/config-authority/report activeMissingGatewayPool={activeMissingGatewayPool}; discoveredAppCallers={discoveredAppCallers}",
        activeMissingGatewayPool == 0 && discoveredAppCallers == 0 ? "可进入 MAP fallback 退场复核。" : "在 /app-callers 治理调用方状态与模型池绑定。",
        new Dictionary<string, string>
        {
            ["activeAppCallers"] = activeAppCallers.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["activeMissingGatewayPool"] = activeMissingGatewayPool.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["discoveredAppCallers"] = discoveredAppCallers.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    AddGate(
        "appcaller_policy_drift",
        "appCaller 策略漂移",
        appCallerRouteDrift == 0 && appCallerParameterDrift == 0 ? "pass" : "blocked",
        appCallerRouteDrift > 0 || appCallerParameterDrift > 0,
        appCallerRouteDrift == 0 && appCallerParameterDrift == 0
            ? $"active/configured 调用方无路由或参数策略漂移，样本数 {governedAppCallers.Count}。"
            : $"{appCallerRouteDrift} 个 active/configured 调用方存在路由漂移，{appCallerParameterDrift} 个存在参数漂移。",
        $"/gw/app-callers?drift=any governed={governedAppCallers.Count}; routeDrift={appCallerRouteDrift}; parameterDrift={appCallerParameterDrift}",
        appCallerRouteDrift == 0 && appCallerParameterDrift == 0 ? "保持治理状态。" : "在 /app-callers 用漂移筛选确认配置值与最近请求意图，再批量治理或逐项修正。",
        new Dictionary<string, string>
        {
            ["governedAppCallers"] = governedAppCallers.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["routeDrift"] = appCallerRouteDrift.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["parameterDrift"] = appCallerParameterDrift.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    AddGate(
        "appcaller_ingress_registry_coverage",
        "appCaller 入口协议注册覆盖",
        missingRegistryProtocols.Count == 0 ? "pass" : "waiting",
        missingRegistryProtocols.Count > 0,
        missingRegistryProtocols.Count == 0
            ? $"appCaller 注册表已累计观察到四类目标入口协议，注册项 {appCallerDocs.Count}。"
            : $"appCaller 注册表尚缺 {missingRegistryProtocols.Count}/{targetProtocols.Count} 类入口协议观察记录：{string.Join(", ", missingRegistryProtocols)}。",
        $"/gw/protocol-coverage registryCovered={registryObservedProtocols.Count}; missing={missingRegistryProtocols.Count}; appCallers={appCallerDocs.Count}",
        missingRegistryProtocols.Count == 0
            ? "保留注册表累计协议覆盖证据。"
            : "触发缺失协议入口的真实或 canary 请求，让 serving 被动注册 ObservedIngressProtocols；只改文档或静态配置不能替代该证据。",
        new Dictionary<string, string>
        {
            ["registeredAppCallers"] = appCallerDocs.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["coveredProtocols"] = registryObservedProtocols.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["missingProtocols"] = missingRegistryProtocols.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["missingIngressProtocols"] = string.Join(",", missingRegistryProtocols),
        });

    AddGate(
        "gateway_pool_member_readiness",
        "GW 池成员可用性",
        activeBoundPoolWithoutUsableMember == 0 ? "pass" : "blocked",
        activeBoundPoolWithoutUsableMember > 0,
        activeBoundPoolWithoutUsableMember == 0
            ? $"active appCaller 绑定的 {activeBoundPools.Count} 个 GW 池均有可解析成员。"
            : $"{activeBoundPoolWithoutUsableMember} 个 active appCaller 绑定的 GW 池没有可解析、非 unavailable 成员。",
        $"/gw/pools activeBoundPools={activeBoundPools.Count}; withoutUsableMember={activeBoundPoolWithoutUsableMember}; enabledPlatforms={enabledGwPlatformIds.Count}; enabledModels={enabledGwModels.Count}; enabledExchanges={enabledGwExchanges.Count}",
        activeBoundPoolWithoutUsableMember == 0 ? "保持池成员健康。" : "在 /pools 为相关 GW 池补充 enabled 模型或 Exchange，并确认 HealthStatus 不是 Unavailable。",
        new Dictionary<string, string>
        {
            ["activeBoundPools"] = activeBoundPools.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["withoutUsableMember"] = activeBoundPoolWithoutUsableMember.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["enabledPlatforms"] = enabledGwPlatformIds.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["enabledModels"] = enabledGwModels.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["enabledExchanges"] = enabledGwExchanges.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    AddGate(
        "active_appcaller_map_fallback_exit",
        "active appCaller MAP fallback 退场开关",
        activeAppCallerMapFallbackExitReady ? "pass" : activeAppCallerMapFallbackCutoverPrerequisitesReady ? "waiting" : "blocked",
        !activeAppCallerMapFallbackExitReady && !activeAppCallerMapFallbackCutoverPrerequisitesReady,
        activeAppCallerMapFallbackExitReady
            ? httpFullLedgerEvidence.Ready
                ? "当前运行态已禁止 active appCaller 使用 MAP 配置兜底，且 active 调用方绑定的 GW 池可用。"
                : "active appCaller MAP fallback 退场前置条件已满足；http-full 阶段会开启运行态 fail-closed 开关。"
            : activeAppCallerMapFallbackCutoverPrerequisitesReady
            ? "active appCaller MAP fallback 退场前置条件已满足；等待 http-full 阶段开启运行态 fail-closed 开关。"
            : $"DisableMapConfigFallbackForActiveAppCallers={disableMapFallbackForActiveAppCallers}，mapFallbackObjectsRemaining={mapFallbackObjectsRemaining}，activeMissingGatewayPool={activeMissingGatewayPool}，discoveredAppCallers={discoveredAppCallers}，withoutUsableMember={activeBoundPoolWithoutUsableMember}。",
        $"runtime config LlmGateway:DisableMapConfigFallbackForActiveAppCallers={disableMapFallbackForActiveAppCallers}; LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS={Environment.GetEnvironmentVariable("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS") ?? "empty"}",
        activeAppCallerMapFallbackExitReady
            ? httpFullLedgerEvidence.Ready
                ? "保留运行态配置和 runtime gate 证据。"
                : "进入 http-full 阶段时由发布脚本开启 DisableMapConfigFallbackForActiveAppCallers。"
            : activeAppCallerMapFallbackCutoverPrerequisitesReady
            ? "进入 http-full 阶段时由发布脚本开启 DisableMapConfigFallbackForActiveAppCallers。"
            : "先完成 MAP-only 配置认领、active appCaller 绑池和池成员健康复核，再在 full-http 发布进程中启用 DisableMapConfigFallbackForActiveAppCallers。",
        new Dictionary<string, string>
        {
            ["disableMapConfigFallbackForActiveAppCallers"] = disableMapFallbackForActiveAppCallers ? "true" : "false",
            ["mapFallbackObjectsRemaining"] = mapFallbackObjectsRemaining.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["activeMissingGatewayPool"] = activeMissingGatewayPool.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["discoveredAppCallers"] = discoveredAppCallers.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["withoutUsableMember"] = activeBoundPoolWithoutUsableMember.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["httpFullLedgerReady"] = httpFullLedgerEvidence.Ready ? "true" : "false",
        });

    AddGate(
        "gateway_key_integrity",
        "GW 密钥完整性",
        keyGateReady ? "pass" : "blocked",
        !keyGateReady,
        keyGateReady
            ? $"GW 主密钥已配置，{keyHealthItems.Count} 个 GW-owned key 元数据可支撑运行。"
            : $"primaryConfigured={keyPrimaryConfigured}，unreadable={keyUnreadable}，legacy={keyLegacyReadable}，stubUnreadable={keyStubUnreadable}，enabled platform/exchange missing={keyMissingBlocking}。",
        $"/gw/key-health total={keyHealthItems.Count}; primaryConfigured={keyPrimaryConfigured}; unreadable={keyUnreadable}; legacy={keyLegacyReadable}; stubUnreadable={keyStubUnreadable}; blockingMissing={keyMissingBlocking}",
        keyGateReady ? "保留密钥健康证据。" : "先配置专用 GW 主密钥并修复不可解、legacy 或缺失的平台/Exchange key。",
        new Dictionary<string, string>
        {
            ["primaryConfigured"] = keyPrimaryConfigured ? "true" : "false",
            ["total"] = keyHealthItems.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["unreadable"] = keyUnreadable.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["legacyReadable"] = keyLegacyReadable.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["stubUnreadable"] = keyStubUnreadable.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["blockingMissing"] = keyMissingBlocking.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    var currentCommitHttpTransportReady = httpTransportLogs > 0
        && (!httpFullLedgerEvidence.Ready || nonHttpTransportLogs == 0);

    AddGate(
        "current_commit_http_transport",
        "当前 commit HTTP transport",
        runtimeCommit is null || releaseLogTotal == 0 ? "waiting" : currentCommitHttpTransportReady ? "pass" : "blocked",
        runtimeCommit is null || releaseLogTotal == 0 || !currentCommitHttpTransportReady,
        runtimeCommit is null
            ? "当前进程缺少 GIT_COMMIT，不能证明 transport 属于本次发布版本。"
            : releaseLogTotal == 0
            ? "尚未看到当前 commit 的 LLM 请求日志，不能证明请求已走 llmgw-serve HTTP。"
            : currentCommitHttpTransportReady && nonHttpTransportLogs == 0
            ? $"当前 commit 的 LLM 请求日志 {releaseLogTotal} 条，transport 均为 http。"
            : currentCommitHttpTransportReady
            ? $"当前 commit 已有 http transport 证据 {httpTransportLogs} 条；另有 {nonHttpTransportLogs} 条 pre-http shadow/seed 日志不阻断进入 http-full。"
            : $"当前 commit 的 LLM 请求日志 {releaseLogTotal} 条，其中 http={httpTransportLogs}，非 http 或缺失={nonHttpTransportLogs}。",
        $"/gw/logs?releaseCommit={runtimeCommit ?? "empty"} total={releaseLogTotal}; transport=http={httpTransportLogs}; nonHttpTransportLogs={nonHttpTransportLogs}",
        runtimeCommit is null || releaseLogTotal == 0
            ? "先用当前 commit 跑真实 send/stream/raw appCaller 样本，确保日志写入 ReleaseCommit 和 GatewayTransport；resolve-only route matrix 不计入该 gate。"
            : currentCommitHttpTransportReady
            ? "保留同 commit transport=http 证据。"
            : "打开 /logs 按 releaseCommit 过滤非 http transport；先移除 direct/inproc 路径或修复日志写入，再进入 full-http。",
        new Dictionary<string, string>
        {
            ["releaseCommit"] = runtimeCommit ?? "",
            ["releaseLogTotal"] = releaseLogTotal.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["httpTransportLogs"] = httpTransportLogs.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["nonHttpTransportLogs"] = nonHttpTransportLogs.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["httpFullLedgerReady"] = httpFullLedgerEvidence.Ready ? "true" : "false",
        });

    AddGate(
        "dropped_parameter_runtime_evidence",
        "当前 commit 参数丢弃证据",
        runtimeCommit is null || releaseLogTotal == 0 ? "waiting" : droppedParameterLogs == 0 ? "pass" : "blocked",
        runtimeCommit is null || releaseLogTotal == 0 || droppedParameterLogs > 0,
        runtimeCommit is null
            ? "当前进程缺少 GIT_COMMIT，不能证明日志属于本次发布版本。"
            : releaseLogTotal == 0
            ? "尚未看到当前 commit 的 LLM 请求日志，不能判断协议适配是否丢弃参数。"
            : droppedParameterLogs == 0
            ? $"当前 commit 的 LLM 请求日志 {releaseLogTotal} 条，未发现 DroppedParameters。"
            : $"当前 commit 的 LLM 请求日志 {releaseLogTotal} 条，其中 {droppedParameterLogs} 条存在 DroppedParameters。",
        $"/gw/logs?releaseCommit={runtimeCommit ?? "empty"} total={releaseLogTotal}; droppedParameterLogs={droppedParameterLogs}",
        runtimeCommit is null || releaseLogTotal == 0
            ? "先用当前 commit 跑真实 send/stream/raw appCaller 样本；route matrix 只证明路由策略，不产生 LLM 请求日志。"
            : droppedParameterLogs == 0
            ? "保留当前 commit 日志证据。"
            : "打开 /logs 按 releaseCommit 过滤，确认被丢弃参数是否应进入严格模式或补 provider adapter 支持。",
        new Dictionary<string, string>
        {
            ["releaseCommit"] = runtimeCommit ?? "",
            ["releaseLogTotal"] = releaseLogTotal.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["droppedParameterLogs"] = droppedParameterLogs.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    AddGate(
        "protocol_runtime_coverage",
        "四类入口协议当前 commit 覆盖",
        runtimeCommit is null || releaseLogTotal == 0 || missingIngressProtocols.Count > 0 ? "waiting" : "pass",
        runtimeCommit is null || releaseLogTotal == 0 || missingIngressProtocols.Count > 0,
        runtimeCommit is null
            ? "当前进程缺少 GIT_COMMIT，不能证明协议入口样本属于本次发布版本。"
            : releaseLogTotal == 0
            ? "尚未看到当前 commit 的 LLM 请求日志，不能证明四类入口协议的运行覆盖。"
            : missingIngressProtocols.Count == 0
            ? $"当前 commit 已覆盖 GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 四类入口协议，协议日志 {releaseProtocolLogDocs.Count} 条。"
            : $"当前 commit 尚缺 {missingIngressProtocols.Count}/{targetProtocols.Count} 类入口协议运行日志：{string.Join(", ", missingIngressProtocols)}。",
        $"/gw/protocol-coverage?releaseCommit={runtimeCommit ?? "empty"}; covered={coveredIngressProtocols.Count}; missing={missingIngressProtocols.Count}; failed={protocolFailedLogs}; dropped={protocolDroppedParameterLogs}",
        runtimeCommit is null || releaseLogTotal == 0
            ? "先设置 GIT_COMMIT，并用当前 commit 触发 GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 的真实或 canary 样本。"
            : missingIngressProtocols.Count == 0
            ? "保留四类入口协议当前 commit 运行证据。"
            : "补触发缺失协议的真实兼容入口样本；静态路由审计不能替代运行日志证据。",
        new Dictionary<string, string>
        {
            ["releaseCommit"] = runtimeCommit ?? "",
            ["coveredProtocols"] = coveredIngressProtocols.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["missingProtocols"] = missingIngressProtocols.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["missingIngressProtocols"] = string.Join(",", missingIngressProtocols),
            ["protocolLogTotal"] = releaseProtocolLogDocs.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["failedProtocolLogs"] = protocolFailedLogs.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["droppedParameterProtocolLogs"] = protocolDroppedParameterLogs.ToString(System.Globalization.CultureInfo.InvariantCulture),
        });

    AddGate(
        "appcaller_runtime_coverage",
        "active appCaller 当前 commit 覆盖",
        runtimeCommit is null || activeAppCallerCodes.Count == 0 || missingRuntimeCoverageAppCallers.Count > 0 ? "waiting" : "pass",
        runtimeCommit is null || activeAppCallerCodes.Count == 0 || missingRuntimeCoverageAppCallers.Count > 0,
        runtimeCommit is null
            ? "当前进程缺少 GIT_COMMIT，不能证明 appCaller 样本属于本次发布版本。"
            : activeAppCallerCodes.Count == 0
            ? "没有 active appCaller，无法证明生产调用方已进入 GW 治理面。"
            : missingRuntimeCoverageAppCallers.Count == 0
            ? $"当前 commit 已覆盖全部 {activeAppCallerCodes.Count} 个 active appCaller。"
            : $"{missingRuntimeCoverageAppCallers.Count}/{activeAppCallerCodes.Count} 个 active appCaller 当前 commit 尚无日志或 shadow 样本：{string.Join(", ", missingRuntimeCoverageAppCallers.Take(12))}{(missingRuntimeCoverageAppCallers.Count > 12 ? " ..." : string.Empty)}",
        $"/gw/logs?releaseCommit={runtimeCommit ?? "empty"}; /gw/shadow-comparisons releaseCommit={runtimeCommit ?? "empty"}; active={activeAppCallerCodes.Count}; covered={coveredAppCallerCodes.Count}; missing={missingRuntimeCoverageAppCallers.Count}",
        runtimeCommit is null || activeAppCallerCodes.Count == 0
            ? "先设置 GIT_COMMIT，并治理至少一批 active appCaller。"
            : missingRuntimeCoverageAppCallers.Count == 0
            ? "保留同 commit 覆盖证据。"
            : "逐个触发缺失 appCaller 的真实 send/stream/raw 业务样本，或产生对应 shadow comparison；resolve-only route matrix 不计入该覆盖 gate。",
        new Dictionary<string, string>
        {
            ["releaseCommit"] = runtimeCommit ?? "",
            ["activeAppCallers"] = activeAppCallerCodes.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["coveredAppCallers"] = coveredAppCallerCodes.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["missingAppCallers"] = missingRuntimeCoverageAppCallers.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["missingAppCallerCodes"] = string.Join(",", missingRuntimeCoverageAppCallers),
        });

    AddGate(
        "shadow_runtime_evidence",
        "shadow/http 运行证据",
        shadowTotal > 0
            ? shadowCritical == 0 && shadowHttpFail == 0 ? "pass" : "blocked"
            : canRetainPreviousShadowEvidence ? "retained" : "waiting",
        shadowTotal > 0
            ? shadowCritical > 0 || shadowHttpFail > 0
            : !canRetainPreviousShadowEvidence,
        runtimeCommit is null
            ? "当前进程缺少 GIT_COMMIT，不能证明 shadow 样本属于本次发布版本。"
            : shadowTotal > 0
            ? $"当前 commit 的 shadow 样本 {shadowTotal} 条，critical={shadowCritical}，httpFail={shadowHttpFail}。"
            : canRetainPreviousShadowEvidence
            ? $"当前 commit 已完成 HTTP-only transport、四协议、active appCaller 和配置权威证据；保留最近 full-http 提交 {retainedShadowCommit} 的 {retainedShadowTotal} 条零 critical/零 httpFail shadow 迁移证据。"
            : "尚未看到当前 commit 的 shadow comparison，且不满足 full-http 维护发布的历史证据保留条件。",
        $"/gw/shadow-comparisons releaseCommit={runtimeCommit ?? "empty"}; total={shadowTotal}; critical={shadowCritical}; httpFail={shadowHttpFail}; retainedCommit={retainedShadowCommit}; retainedTotal={retainedShadowTotal}; retainedEligible={canRetainPreviousShadowEvidence}",
        shadowTotal > 0
            ? shadowCritical == 0 && shadowHttpFail == 0 ? "保留同 commit 证据并进入灰度 gate。" : "先归因当前 commit 的 critical/httpFail，再补测试。"
            : canRetainPreviousShadowEvidence
            ? "保留历史迁移证据；当前提交继续依赖 HTTP-only transport、四协议和 active appCaller 运行证据。"
            : "首次切流必须跑当前 commit 的真实 appCaller shadow 样本；维护发布则先补齐当前 commit 的 HTTP-only transport、四协议、active appCaller 和配置权威证据。",
        new Dictionary<string, string>
        {
            ["releaseCommit"] = runtimeCommit ?? "",
            ["total"] = shadowTotal.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["critical"] = shadowCritical.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["httpFail"] = shadowHttpFail.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["retainedCommit"] = retainedShadowCommit,
            ["retainedTotal"] = retainedShadowTotal.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["retainedEligible"] = canRetainPreviousShadowEvidence ? "true" : "false",
        });

    var ledgerEvidence = httpFullLedgerEvidence;
    var ledgerReady = ledgerEvidence.Ready;

    AddGate(
        "full_http_rollout_ledger",
        "full-http 发布台账",
        ledgerReady ? "pass" : "waiting",
        !ledgerReady,
        ledgerEvidence.Detail,
        ledgerEvidence.Evidence,
        ledgerReady ? "保留台账证据并进入生产复核。" : "走 fast.sh/exec_dep.sh 对应生产流程前，先让 llmgw-prod-stage 写入同 commit 的 http-full 成功记录。",
        ledgerEvidence.Facts);

    AddGate(
        "legacy_cleanup_after_stability",
        "legacy/inproc 清理窗口",
        "retained",
        false,
        "inproc/legacy 代码保留到 full-http 稳定窗口后再删；这不是当前切换阻塞项。",
        "doc/plan.llm-gateway.full-cutover.md stability window",
        "full-http 稳定至少 7 天后再开启删除计划。");

    var passed = items.Count(x => x.Status == "pass");
    var blocked = items.Count(x => x.Status == "blocked");
    var waiting = items.Count(x => x.Status == "waiting");
    var retained = items.Count(x => x.Status == "retained");
    var readyForHttpFull = items.Where(x => x.Blocking).All(x => x.Status == "pass");
    var status = blocked > 0 ? "blocked" : readyForHttpFull ? "ready" : "waiting";

    return Json(ApiEnvelope<RuntimeGatesData>.Ok(new RuntimeGatesData
    {
        Status = status,
        ReleaseCommit = runtimeCommit,
        ReadyForHttpFull = readyForHttpFull,
        Passed = passed,
        Blocked = blocked,
        Waiting = waiting,
        Retained = retained,
        GeneratedAt = DateTime.UtcNow.ToString("O"),
        Items = items,
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

// 统一批量认领 MAP 配置：复制到 llm_gateway，自有对象默认不覆盖。
app.MapPost("/gw/config-authority/bulk-claim", async (HttpContext http, [FromBody] BulkClaimConfigAuthorityRequest? body) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<BulkClaimConfigAuthorityResult>.Fail("INTERNAL_GOVERNANCE_ONLY", "配置权威迁移仅供内部租户使用"), jsonOptions, 403);
    var overwrite = body?.Overwrite == true;
    var now = DateTime.UtcNow;

    async Task<(int claimed, int skipped)> ClaimCollectionAsync(
        IMongoCollection<BsonDocument> sourceCollection,
        IMongoCollection<BsonDocument> targetCollection,
        string sourceName)
    {
        var sourceDocs = await sourceCollection.Find(FilterDefinition<BsonDocument>.Empty).ToListAsync();
        var claimed = 0;
        var skipped = 0;
        foreach (var source in sourceDocs)
        {
            var id = source.GetStringOrEmpty("_id");
            if (id.Length == 0)
            {
                skipped++;
                continue;
            }
            var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
            var existing = await targetCollection.Find(filter).FirstOrDefaultAsync();
            if (existing is not null && !overwrite)
            {
                skipped++;
                continue;
            }

            var cloned = new BsonDocument(source);
            cloned["TenantId"] = internalTenantId;
            cloned["SourceCollection"] = sourceName;
            cloned["Authority"] = "llm_gateway";
            cloned["ClaimedAt"] = existing?.AsNullableUtcDateTime("ClaimedAt") ?? now;
            cloned["UpdatedAt"] = now;
            await targetCollection.ReplaceOneAsync(filter, cloned, new ReplaceOptions { IsUpsert = true });
            claimed++;
        }
        return (claimed, skipped);
    }

    var poolsResult = await ClaimCollectionAsync(modelGroups, gwModelPools, "model_groups");
    var platformsResult = await ClaimCollectionAsync(platforms, gwPlatforms, "llmplatforms");
    var modelsResult = await ClaimCollectionAsync(models, gwModels, "llmmodels");
    var exchangesResult = await ClaimCollectionAsync(modelExchanges, gwModelExchanges, "model_exchanges");
    var result = new BulkClaimConfigAuthorityResult
    {
        ClaimedPools = poolsResult.claimed,
        SkippedPools = poolsResult.skipped,
        ClaimedPlatforms = platformsResult.claimed,
        SkippedPlatforms = platformsResult.skipped,
        ClaimedModels = modelsResult.claimed,
        SkippedModels = modelsResult.skipped,
        ClaimedExchanges = exchangesResult.claimed,
        SkippedExchanges = exchangesResult.skipped,
    };
    result.ClaimedTotal = result.ClaimedPools + result.ClaimedPlatforms + result.ClaimedModels + result.ClaimedExchanges;
    result.SkippedTotal = result.SkippedPools + result.SkippedPlatforms + result.SkippedModels + result.SkippedExchanges;

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "config_authority.bulk_claim_to_gateway",
        targetType: "llmgw_config_authority",
        targetId: "all",
        targetName: "config authority",
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "overwrite", overwrite },
            { "claimedTotal", result.ClaimedTotal },
            { "skippedTotal", result.SkippedTotal },
            { "authority", "llm_gateway" },
        });

    return Json(ApiEnvelope<BulkClaimConfigAuthorityResult>.Ok(result), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// active appCaller 不能依赖 MAP fallback。这里仅绑定到同 requestType 的 GW 默认池；缺默认池时报告缺口，不做跨类型硬绑。
app.MapPost("/gw/config-authority/bind-active-app-callers", async (HttpContext http) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<BindActiveAppCallerPoolsResult>.Fail("INTERNAL_GOVERNANCE_ONLY", "配置权威迁移仅供内部租户使用"), jsonOptions, 403);
    var now = DateTime.UtcNow;
    var gwPoolDocs = await gwModelPools.Find(TenantAccess.Filter(http)).ToListAsync();
    var gwPoolIds = gwPoolDocs
        .Select(d => d.GetStringOrEmpty("_id"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .ToHashSet(StringComparer.Ordinal);
    var usableGwPoolIds = new HashSet<string>(StringComparer.Ordinal);
    foreach (var pool in gwPoolDocs)
    {
        var poolId = pool.GetStringOrEmpty("_id");
        if (poolId.Length > 0 && await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, pool))
        {
            usableGwPoolIds.Add(poolId);
        }
    }
    var defaultPoolByType = gwPoolDocs
        .Where(d => d.AsNullableBool("IsDefaultForType") == true)
        .Select(d => new
        {
            Id = d.GetStringOrEmpty("_id"),
            Type = d.GetStringOrEmpty("ModelType").Trim(),
            Name = d.AsNullableString("Name") ?? d.AsNullableString("Code") ?? d.GetStringOrEmpty("_id"),
        })
        .Where(x => x.Id.Length > 0 && x.Type.Length > 0 && usableGwPoolIds.Contains(x.Id))
        .GroupBy(x => x.Type, StringComparer.OrdinalIgnoreCase)
        .ToDictionary(g => g.Key, g => g.OrderBy(x => x.Name, StringComparer.Ordinal).First(), StringComparer.OrdinalIgnoreCase);

    var activeAppCallers = await gwAppCallers
        .Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("Status", "active")))
        .ToListAsync();
    var result = new BindActiveAppCallerPoolsResult();
    static bool IsSupportedAppCallerModelPolicy(string? policy)
    {
        var normalized = (policy ?? string.Empty).Trim().ToLowerInvariant();
        return normalized is "auto" or "pool" or "pinned";
    }

    foreach (var appCaller in activeAppCallers)
    {
        var appCallerId = appCaller.GetStringOrEmpty("_id");
        var appCallerCode = appCaller.AsNullableString("AppCallerCode") ?? appCallerId;
        var currentPoolId = appCaller.AsNullableString("ModelPoolId");
        var currentModelPolicy = appCaller.AsNullableString("ModelPolicy");
        if (!string.IsNullOrWhiteSpace(currentPoolId) && gwPoolIds.Contains(currentPoolId))
        {
            if (!usableGwPoolIds.Contains(currentPoolId))
            {
                result.Skipped++;
                result.Items.Add(new ConfigAuthorityGapItem
                {
                    ObjectType = "appCaller",
                    Id = appCallerId,
                    Name = appCallerCode,
                    Status = "gw-pool-without-usable-member",
                    Detail = $"active appCaller 当前绑定的 GW 模型池 {currentPoolId} 没有可解析成员；请先在 /pools 补齐 enabled 模型或 Exchange。",
                });
                continue;
            }

            if (IsSupportedAppCallerModelPolicy(currentModelPolicy))
            {
                result.Skipped++;
                continue;
            }

            var policyUpdateResult = await gwAppCallers.UpdateOneAsync(
                TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", appCallerId)),
                Builders<BsonDocument>.Update
                    .Set("ModelPolicy", "pool")
                    .Set("UpdatedAt", now));
            if (policyUpdateResult.ModifiedCount > 0)
            {
                result.Bound++;
                result.Items.Add(new ConfigAuthorityGapItem
                {
                    ObjectType = "appCaller",
                    Id = appCallerId,
                    Name = appCallerCode,
                    Status = "normalized-to-supported-model-policy",
                    Detail = $"已保留现有 GW 模型池 {currentPoolId}，并将缺失或非法路由策略补齐为 pool。",
                });
            }
            else
            {
                result.Skipped++;
            }
            continue;
        }

        var requestType = appCaller.GetStringOrEmpty("RequestType").Trim();
        if (requestType.Length == 0 || !defaultPoolByType.TryGetValue(requestType, out var defaultPool))
        {
            result.Skipped++;
            result.MissingDefaultPool++;
            result.Items.Add(new ConfigAuthorityGapItem
            {
                ObjectType = "appCaller",
                Id = appCallerId,
                Name = appCallerCode,
                Status = "missing-default-gw-pool",
                Detail = requestType.Length == 0
                    ? "active appCaller 缺少 requestType，无法自动选择 GW 默认池。"
                    : $"未找到 requestType={requestType} 的 GW 默认池；请先在模型池页创建或标记默认池。",
            });
            continue;
        }

        var targetModelPolicy = IsSupportedAppCallerModelPolicy(currentModelPolicy)
            ? currentModelPolicy!.Trim().ToLowerInvariant()
            : "pool";
        var updates = new List<UpdateDefinition<BsonDocument>>
        {
            Builders<BsonDocument>.Update.Set("ModelPoolId", defaultPool.Id),
            Builders<BsonDocument>.Update.Set("ModelPolicy", targetModelPolicy),
            Builders<BsonDocument>.Update.Set("UpdatedAt", now),
        };

        var updateResult = await gwAppCallers.UpdateOneAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", appCallerId)),
            Builders<BsonDocument>.Update.Combine(updates));
        if (updateResult.ModifiedCount > 0)
        {
            result.Bound++;
            result.Items.Add(new ConfigAuthorityGapItem
            {
                ObjectType = "appCaller",
                Id = appCallerId,
                Name = appCallerCode,
                Status = "bound-to-gw-default-pool",
                Detail = $"已绑定 requestType={requestType} 的 GW 默认池 {defaultPool.Name}，路由策略保留或补齐为 {targetModelPolicy}。",
            });
        }
        else
        {
            result.Skipped++;
        }
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "config_authority.bind_active_app_callers",
        targetType: "llmgw_app_callers",
        targetId: "active",
        targetName: "active appCallers",
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "bound", result.Bound },
            { "skipped", result.Skipped },
            { "missingDefaultPool", result.MissingDefaultPool },
            { "authority", "llm_gateway" },
        });

    return Json(ApiEnvelope<BindActiveAppCallerPoolsResult>.Ok(result), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// GW 自有 appCaller 注册表：由 llmgw-serve 入口层被动发现，控制台先只读展示。
app.MapGet("/gw/app-callers", async (
    HttpContext http,
    string? status,
    string? sourceSystem,
    string? ingressProtocol,
    string? requestType,
    string? drift,
    string? search,
    int? page,
    int? pageSize) =>
{
    var p = Math.Max(1, page ?? 1);
    var ps = Math.Clamp(pageSize ?? 50, 1, 200);
    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>();
    if (!string.IsNullOrWhiteSpace(status)) filters.Add(fb.Eq("Status", status.Trim()));
    if (!string.IsNullOrWhiteSpace(sourceSystem)) filters.Add(fb.Eq("SourceSystem", sourceSystem.Trim()));
    if (!string.IsNullOrWhiteSpace(ingressProtocol))
    {
        var protocolRaw = ingressProtocol.Trim();
        var protocolNormalized = NormalizeIngressProtocol(protocolRaw);
        filters.Add(fb.Or(
            fb.Eq("IngressProtocol", protocolRaw),
            fb.Eq("IngressProtocol", protocolNormalized),
            fb.AnyEq("ObservedIngressProtocols", protocolRaw),
            fb.AnyEq("ObservedIngressProtocols", protocolNormalized)));
    }
    if (!string.IsNullOrWhiteSpace(requestType)) filters.Add(fb.Eq("RequestType", requestType.Trim()));
    var driftFilter = BuildAppCallerDriftFilter(drift);
    if (driftFilter is not null) filters.Add(driftFilter);
    if (!string.IsNullOrWhiteSpace(search))
    {
        var pattern = new BsonRegularExpression(search.Trim(), "i");
        filters.Add(fb.Or(
            fb.Regex("AppCallerCode", pattern),
            fb.Regex("Title", pattern),
            fb.Regex("LastObservedRequestId", pattern),
            fb.Regex("LastObservedSessionId", pattern),
            fb.Regex("LastObservedRunId", pattern)));
    }
    var filter = TenantAccess.Filter(http, filters.Count > 0 ? fb.And(filters) : fb.Empty);
    var total = await gwAppCallers.CountDocumentsAsync(filter);
    var docs = await gwAppCallers.Find(filter)
        .Sort(Builders<BsonDocument>.Sort.Descending("LastSeenAt").Ascending("AppCallerCode"))
        .Skip((p - 1) * ps)
        .Limit(ps)
        .ToListAsync();

    var recent = TenantAccess.Filter(http);
    var statuses = NormalizeDistinct(await gwAppCallers.Distinct<string>("Status", recent).ToListAsync(), 80);
    var sourceSystems = NormalizeDistinct(await gwAppCallers.Distinct<string>("SourceSystem", recent).ToListAsync(), 80);
    var protocolDocs = await gwAppCallers.Find(recent)
        .Project(Builders<BsonDocument>.Projection.Include("IngressProtocol").Include("ObservedIngressProtocols"))
        .ToListAsync();
    var ingressProtocols = NormalizeDistinct(protocolDocs.SelectMany(GetObservedIngressProtocols), 80);
    var requestTypes = NormalizeDistinct(await gwAppCallers.Distinct<string>("RequestType", recent).ToListAsync(), 80);
    var data = new GatewayAppCallersData
    {
        Items = docs.Select(MapGatewayAppCaller).ToList(),
        Total = total,
        Page = p,
        PageSize = ps,
        Statuses = statuses,
        SourceSystems = sourceSystems,
        IngressProtocols = ingressProtocols,
        RequestTypes = requestTypes,
    };
    return Json(ApiEnvelope<GatewayAppCallersData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// GW appCaller 配置：状态、模型池绑定与参数策略落 GW 自有库；active 状态必须绑定可用的 GW 权威池。
app.MapPut("/gw/app-callers/{id}", async (HttpContext http, string id, [FromBody] UpdateGatewayAppCallerRequest body) =>
{
    if (body is null) return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);

    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwAppCallers.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("NOT_FOUND", $"appCaller 不存在：{id}"), jsonOptions, 404);

    var effectiveMonthlyBudget = body.MonthlyBudgetUsd is null
        ? doc.AsNullableDecimal("MonthlyBudgetUsd")
        : NormalizePositiveBudget(body.MonthlyBudgetUsd.Value);
    var effectiveBudgetReservation = body.BudgetReservationUsd is null
        ? body.MonthlyBudgetUsd == 0 ? null : doc.AsNullableDecimal("BudgetReservationUsd")
        : NormalizePositiveBudget(body.BudgetReservationUsd.Value);
    var budgetConfigurationError = ValidateBudgetConfiguration(effectiveMonthlyBudget, effectiveBudgetReservation);
    if (body.MonthlyBudgetUsd is < 0 || body.BudgetReservationUsd is < 0)
        budgetConfigurationError = "预算金额不能小于 0";
    if (budgetConfigurationError is not null)
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", budgetConfigurationError), jsonOptions, 400);

    var updates = new List<UpdateDefinition<BsonDocument>>();
    var changes = new BsonDocument();
    var effectiveStatus = doc.AsNullableString("Status") ?? "discovered";
    var effectiveModelPoolId = doc.AsNullableString("ModelPoolId");
    var effectiveModelPolicy = doc.AsNullableString("ModelPolicy");
    void AddChange(string field, object? from, object? to) =>
        changes[field] = new BsonDocument { { "from", ToBsonAuditValue(from) }, { "to", ToBsonAuditValue(to) } };

    var statusExplicit = body.Status is not null;
    if (body.Status is not null)
    {
        var normalizedStatus = body.Status.Trim().ToLowerInvariant();
        if (!new[] { "discovered", "configured", "active", "disabled", "archived" }.Contains(normalizedStatus))
        {
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "status 仅支持 discovered/configured/active/disabled/archived"), jsonOptions, 400);
        }
        updates.Add(Builders<BsonDocument>.Update.Set("Status", normalizedStatus));
        AddChange("status", doc.AsNullableString("Status") ?? "discovered", normalizedStatus);
        effectiveStatus = normalizedStatus;
    }

    if (body.ModelPoolId is not null)
    {
        var modelPoolId = body.ModelPoolId.Trim();
        if (modelPoolId.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("ModelPoolId"));
            AddChange("modelPoolId", doc.AsNullableString("ModelPoolId"), null);
            effectiveModelPoolId = null;
        }
        else
        {
            var poolFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", modelPoolId));
            var pool = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync()
                       ?? (TenantAccess.GetRequired(http).TenantId == internalTenantId
                           ? await modelGroups.Find(Builders<BsonDocument>.Filter.Eq("_id", modelPoolId)).FirstOrDefaultAsync()
                           : null);
            if (pool is null)
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", $"模型池不存在：{modelPoolId}"), jsonOptions, 400);
            }
            var poolType = pool.GetStringOrEmpty("ModelType");
            var requestType = doc.GetStringOrEmpty("RequestType");
            if (!string.IsNullOrWhiteSpace(poolType) && !string.IsNullOrWhiteSpace(requestType) && !string.Equals(poolType, requestType, StringComparison.OrdinalIgnoreCase))
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", $"模型池类型 {poolType} 与调用类型 {requestType} 不一致"), jsonOptions, 400);
            }
            updates.Add(Builders<BsonDocument>.Update.Set("ModelPoolId", modelPoolId));
            AddChange("modelPoolId", doc.AsNullableString("ModelPoolId"), modelPoolId);
            effectiveModelPoolId = modelPoolId;

            var currentStatus = doc.AsNullableString("Status") ?? "discovered";
            if (!statusExplicit && string.Equals(currentStatus, "discovered", StringComparison.OrdinalIgnoreCase))
            {
                updates.Add(Builders<BsonDocument>.Update.Set("Status", "configured"));
                AddChange("status", currentStatus, "configured");
                effectiveStatus = "configured";
            }
        }
    }

    if (body.ModelPolicy is not null)
    {
        var modelPolicy = body.ModelPolicy.Trim().ToLowerInvariant();
        if (modelPolicy.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("ModelPolicy"));
            AddChange("modelPolicy", doc.AsNullableString("ModelPolicy"), null);
            effectiveModelPolicy = null;
        }
        else
        {
            if (!new[] { "auto", "pool", "pinned" }.Contains(modelPolicy))
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "modelPolicy 仅支持 auto/pool/pinned"), jsonOptions, 400);
            }
            updates.Add(Builders<BsonDocument>.Update.Set("ModelPolicy", modelPolicy));
            AddChange("modelPolicy", doc.AsNullableString("ModelPolicy"), modelPolicy);
            effectiveModelPolicy = modelPolicy;
        }
    }

    if (body.ParameterPolicy is not null)
    {
        var parameterPolicy = NormalizeParameterPolicy(body.ParameterPolicy);
        if (parameterPolicy.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("ParameterPolicy"));
            AddChange("parameterPolicy", doc.AsNullableString("ParameterPolicy"), null);
        }
        else
        {
            if (!new[] { "default-drop", "strict-require" }.Contains(parameterPolicy))
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "parameterPolicy 仅支持 default-drop/strict-require"), jsonOptions, 400);
            }
            updates.Add(Builders<BsonDocument>.Update.Set("ParameterPolicy", parameterPolicy));
            AddChange("parameterPolicy", doc.AsNullableString("ParameterPolicy"), parameterPolicy);
        }
    }

    if (body.Owner is not null)
    {
        var owner = body.Owner.Trim();
        if (owner.Length > 120)
        {
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "owner 最多 120 字符"), jsonOptions, 400);
        }
        if (owner.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("Owner"));
            AddChange("owner", doc.AsNullableString("Owner"), null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("Owner", owner));
            AddChange("owner", doc.AsNullableString("Owner"), owner);
        }
    }

    if (body.MonthlyBudgetUsd is not null)
    {
        if (body.MonthlyBudgetUsd.Value < 0)
        {
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "monthlyBudgetUsd 不能小于 0"), jsonOptions, 400);
        }
        if (body.MonthlyBudgetUsd.Value == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("MonthlyBudgetUsd"));
            AddChange("monthlyBudgetUsd", doc.AsNullableDecimal("MonthlyBudgetUsd"), null);
            if (body.BudgetReservationUsd is null)
            {
                updates.Add(Builders<BsonDocument>.Update.Unset("BudgetReservationUsd"));
                AddChange("budgetReservationUsd", doc.AsNullableDecimal("BudgetReservationUsd"), null);
            }
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("MonthlyBudgetUsd", new BsonDecimal128(body.MonthlyBudgetUsd.Value)));
            AddChange("monthlyBudgetUsd", doc.AsNullableDecimal("MonthlyBudgetUsd"), body.MonthlyBudgetUsd.Value);
        }
    }

    if (body.BudgetReservationUsd is not null)
    {
        if (body.BudgetReservationUsd.Value < 0)
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "budgetReservationUsd 不能小于 0"), jsonOptions, 400);
        if (body.BudgetReservationUsd.Value == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("BudgetReservationUsd"));
            AddChange("budgetReservationUsd", doc.AsNullableDecimal("BudgetReservationUsd"), null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("BudgetReservationUsd", new BsonDecimal128(body.BudgetReservationUsd.Value)));
            AddChange("budgetReservationUsd", doc.AsNullableDecimal("BudgetReservationUsd"), body.BudgetReservationUsd.Value);
        }
    }

    if (body.RateLimitPerMinute is not null)
    {
        if (body.RateLimitPerMinute.Value < 0)
        {
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "rateLimitPerMinute 不能小于 0"), jsonOptions, 400);
        }
        if (body.RateLimitPerMinute.Value == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("RateLimitPerMinute"));
            AddChange("rateLimitPerMinute", doc.AsNullableInt("RateLimitPerMinute"), null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("RateLimitPerMinute", body.RateLimitPerMinute.Value));
            AddChange("rateLimitPerMinute", doc.AsNullableInt("RateLimitPerMinute"), body.RateLimitPerMinute.Value);
        }
    }

    if (body.Notes is not null)
    {
        var notes = body.Notes.Trim();
        if (notes.Length > 1000)
        {
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "notes 最多 1000 字符"), jsonOptions, 400);
        }
        if (notes.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("Notes"));
            AddChange("notes", doc.AsNullableString("Notes"), null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("Notes", notes));
            AddChange("notes", doc.AsNullableString("Notes"), notes);
        }
    }

    var activeConfigError = await ValidateActiveGatewayAppCallerConfigAsync(
        gwModelPools,
        gwPlatforms,
        gwModels,
        gwModelExchanges,
        TenantAccess.GetRequired(http).TenantId,
        effectiveStatus,
        effectiveModelPoolId,
        effectiveModelPolicy,
        doc.GetStringOrEmpty("RequestType"));
    if (activeConfigError is not null)
    {
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", activeConfigError), jsonOptions, 400);
    }

    if (updates.Count == 0)
    {
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "没有可更新字段"), jsonOptions, 400);
    }

    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
    await gwAppCallers.UpdateOneAsync(filter, Builders<BsonDocument>.Update.Combine(updates));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "app_caller.update",
        targetType: "llmgw_app_caller",
        targetId: id,
        targetName: doc.AsNullableString("AppCallerCode"),
        success: true,
        reason: null,
        changes: changes);
    var fresh = await gwAppCallers.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<GatewayAppCallerItem>.Ok(MapGatewayAppCaller(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapGet("/gw/app-callers/{id}/prompt-policy", async (HttpContext http, string id) =>
{
    var caller = await gwAppCallers.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id))).FirstOrDefaultAsync();
    if (caller is null) return Json(ApiEnvelope<PromptPolicyData>.Fail("NOT_FOUND", "appCaller 不存在"), jsonOptions, 404);
    var requestType = caller.GetStringOrEmpty("RequestType").Trim().ToLowerInvariant();
    if (requestType is not ("chat" or "vision"))
        return Json(ApiEnvelope<PromptPolicyData>.Fail("PROMPT_POLICY_UNSUPPORTED_REQUEST_TYPE", "提示词策略首版只支持 chat/vision"), jsonOptions, 400);
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var appCallerCode = caller.GetStringOrEmpty("AppCallerCode").Trim().ToLowerInvariant();
    var filter = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("AppCallerCode", appCallerCode),
        Builders<BsonDocument>.Filter.Eq("RequestType", requestType));
    var versions = await promptPolicies.Find(filter).Sort(Builders<BsonDocument>.Sort.Descending("Version")).Limit(50).ToListAsync();
    return Json(ApiEnvelope<PromptPolicyData>.Ok(new PromptPolicyData
    {
        AppCallerId = id,
        AppCallerCode = appCallerCode,
        RequestType = requestType,
        Current = versions.Count == 0 ? null : MapPromptPolicy(versions[0]),
        Versions = versions.Select(MapPromptPolicy).ToList(),
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPost("/gw/app-callers/{id}/prompt-policy/preview", async (HttpContext http, string id, [FromBody] PreviewPromptPolicyRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<PromptPolicyPreview>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    if ((body.SampleSystemPrompt?.Length ?? 0) > 20000) return Json(ApiEnvelope<PromptPolicyPreview>.Fail("INVALID_INPUT", "示例 system prompt 最多 20000 字符"), jsonOptions, 400);
    var caller = await gwAppCallers.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id))).FirstOrDefaultAsync();
    if (caller is null) return Json(ApiEnvelope<PromptPolicyPreview>.Fail("NOT_FOUND", "appCaller 不存在"), jsonOptions, 404);
    var validation = ValidatePromptPolicyDraft(body, caller, TenantAccess.GetRequired(http));
    if (validation.Error is not null) return Json(ApiEnvelope<PromptPolicyPreview>.Fail("INVALID_INPUT", validation.Error), jsonOptions, 400);
    var prefix = RenderPromptPolicy(validation.Prefix, validation.AllowedVariables, validation.Variables);
    var suffix = RenderPromptPolicy(validation.Suffix, validation.AllowedVariables, validation.Variables);
    var merged = string.Join("\n\n", new[] { prefix, body.SampleSystemPrompt?.Trim() ?? "", suffix }.Where(x => x.Length > 0));
    return Json(ApiEnvelope<PromptPolicyPreview>.Ok(new PromptPolicyPreview
    {
        MergedSystemPrompt = merged,
        PolicyChars = prefix.Length + suffix.Length,
        MergedChars = merged.Length,
        PolicyHash = ComputePromptPolicyHash(validation.Prefix, validation.Suffix, body.Enabled, validation.AllowedVariables, body.MaxChars),
        AppliedVariables = validation.AllowedVariables,
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/app-callers/{id}/prompt-policy", async (HttpContext http, string id, [FromBody] SavePromptPolicyRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var caller = await gwAppCallers.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id))).FirstOrDefaultAsync();
    if (caller is null) return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("NOT_FOUND", "appCaller 不存在"), jsonOptions, 404);
    var access = TenantAccess.GetRequired(http);
    var validation = ValidatePromptPolicyDraft(body, caller, access);
    if (validation.Error is not null) return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("INVALID_INPUT", validation.Error), jsonOptions, 400);
    var appCallerCode = caller.GetStringOrEmpty("AppCallerCode").Trim().ToLowerInvariant();
    var requestType = caller.GetStringOrEmpty("RequestType").Trim().ToLowerInvariant();
    var scopeFilter = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId),
        Builders<BsonDocument>.Filter.Eq("AppCallerCode", appCallerCode),
        Builders<BsonDocument>.Filter.Eq("RequestType", requestType));
    var current = await promptPolicies.Find(scopeFilter).Sort(Builders<BsonDocument>.Sort.Descending("Version")).FirstOrDefaultAsync();
    var currentVersion = current?.AsNullableInt("Version") ?? 0;
    if (body.ExpectedVersion != currentVersion)
        return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("PROMPT_POLICY_VERSION_CONFLICT", $"当前版本为 {currentVersion}"), jsonOptions, 409);
    var now = DateTime.UtcNow;
    var policyHash = ComputePromptPolicyHash(validation.Prefix, validation.Suffix, body.Enabled, validation.AllowedVariables, body.MaxChars);
    var doc = new BsonDocument
    {
        { "_id", Guid.NewGuid().ToString("N") },
        { "TenantId", access.TenantId },
        { "TeamId", caller.TryGetValue("TeamId", out var teamId) ? teamId : BsonNull.Value },
        { "AppCallerCode", appCallerCode },
        { "RequestType", requestType },
        { "SystemPromptPrefix", validation.Prefix },
        { "SystemPromptSuffix", validation.Suffix },
        { "Enabled", body.Enabled },
        { "Version", currentVersion + 1 },
        { "AllowedVariables", new BsonArray(validation.AllowedVariables) },
        { "MaxChars", body.MaxChars },
        { "PolicyHash", policyHash },
        { "PolicyChars", validation.Prefix.Length + validation.Suffix.Length },
        { "CreatedBy", access.UserId },
        { "UpdatedBy", access.UserId },
        { "CreatedAt", now },
        { "UpdatedAt", now },
    };
    try { await promptPolicies.InsertOneAsync(doc); }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("PROMPT_POLICY_VERSION_CONFLICT", "策略已被其他管理员更新，请刷新后重试"), jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http, "prompt_policy.update", "llmgw_prompt_policy", doc["_id"].AsString, appCallerCode, true, null,
        PromptPolicyAuditChanges(doc));
    return Json(ApiEnvelope<PromptPolicyVersionItem>.Ok(MapPromptPolicy(doc)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPost("/gw/app-callers/{id}/prompt-policy/rollback", async (HttpContext http, string id, [FromBody] RollbackPromptPolicyRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    if (body.TargetVersion < 1) return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("INVALID_INPUT", "targetVersion 必须大于 0"), jsonOptions, 400);
    var caller = await gwAppCallers.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id))).FirstOrDefaultAsync();
    if (caller is null) return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("NOT_FOUND", "appCaller 不存在"), jsonOptions, 404);
    var access = TenantAccess.GetRequired(http);
    var appCallerCode = caller.GetStringOrEmpty("AppCallerCode").Trim().ToLowerInvariant();
    var requestType = caller.GetStringOrEmpty("RequestType").Trim().ToLowerInvariant();
    var scopeFilter = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId),
        Builders<BsonDocument>.Filter.Eq("AppCallerCode", appCallerCode),
        Builders<BsonDocument>.Filter.Eq("RequestType", requestType));
    var current = await promptPolicies.Find(scopeFilter).Sort(Builders<BsonDocument>.Sort.Descending("Version")).FirstOrDefaultAsync();
    var currentVersion = current?.AsNullableInt("Version") ?? 0;
    if (body.ExpectedVersion != currentVersion)
        return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("PROMPT_POLICY_VERSION_CONFLICT", $"当前版本为 {currentVersion}"), jsonOptions, 409);
    var target = await promptPolicies.Find(Builders<BsonDocument>.Filter.And(scopeFilter, Builders<BsonDocument>.Filter.Eq("Version", body.TargetVersion))).FirstOrDefaultAsync();
    if (target is null) return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("NOT_FOUND", "目标版本不存在"), jsonOptions, 404);
    var restored = target.DeepClone().AsBsonDocument;
    restored["_id"] = Guid.NewGuid().ToString("N");
    restored["Version"] = currentVersion + 1;
    restored["CreatedBy"] = access.UserId;
    restored["UpdatedBy"] = access.UserId;
    restored["CreatedAt"] = DateTime.UtcNow;
    restored["UpdatedAt"] = DateTime.UtcNow;
    try { await promptPolicies.InsertOneAsync(restored); }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<PromptPolicyVersionItem>.Fail("PROMPT_POLICY_VERSION_CONFLICT", "策略已被其他管理员更新，请刷新后重试"), jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http, "prompt_policy.rollback", "llmgw_prompt_policy", restored["_id"].AsString, appCallerCode, true, null,
        new BsonDocument { { "fromVersion", currentVersion }, { "targetVersion", body.TargetVersion }, { "newVersion", currentVersion + 1 }, { "policyHash", restored["PolicyHash"] } });
    return Json(ApiEnvelope<PromptPolicyVersionItem>.Ok(MapPromptPolicy(restored)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// GW appCaller 批量治理：按当前筛选批量设置 registry 自身治理字段，不批量改模型池绑定，避免跨 requestType 误绑。
app.MapPost("/gw/app-callers/bulk-governance", async (HttpContext http, [FromBody] BulkUpdateGatewayAppCallersRequest body) =>
{
    if (body is null) return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);

    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>();
    var filterSummary = new List<string>();
    void AddExactFilter(string field, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        var normalized = value.Trim();
        filters.Add(fb.Eq(field, normalized));
        filterSummary.Add($"{field}={normalized}");
    }

    AddExactFilter("Status", body.FilterStatus);
    AddExactFilter("SourceSystem", body.SourceSystem);
    AddExactFilter("IngressProtocol", body.IngressProtocol);
    AddExactFilter("RequestType", body.RequestType);
    var driftFilter = BuildAppCallerDriftFilter(body.Drift);
    if (driftFilter is not null)
    {
        filters.Add(driftFilter);
        filterSummary.Add($"drift={body.Drift!.Trim()}");
    }
    if (!string.IsNullOrWhiteSpace(body.Search))
    {
        var search = body.Search.Trim();
        var pattern = new BsonRegularExpression(search, "i");
        filters.Add(fb.Or(
            fb.Regex("AppCallerCode", pattern),
            fb.Regex("Title", pattern)));
        filterSummary.Add($"search={search}");
    }
    if (filters.Count == 0)
    {
        return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "批量治理必须至少提供一个筛选条件"), jsonOptions, 400);
    }

    var updates = new List<UpdateDefinition<BsonDocument>>();
    var setSummary = new BsonDocument();
    string? targetStatus = null;
    var targetModelPolicyTouched = false;
    string? targetModelPolicy = null;
    void AddSetSummary(string field, object? to) => setSummary[field] = ToBsonAuditValue(to);

    if (body.TargetStatus is not null)
    {
        var normalizedStatus = body.TargetStatus.Trim().ToLowerInvariant();
        if (!new[] { "discovered", "configured", "active", "disabled", "archived" }.Contains(normalizedStatus))
        {
            return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "targetStatus 仅支持 discovered/configured/active/disabled/archived"), jsonOptions, 400);
        }
        updates.Add(Builders<BsonDocument>.Update.Set("Status", normalizedStatus));
        AddSetSummary("status", normalizedStatus);
        targetStatus = normalizedStatus;
    }

    if (body.ModelPolicy is not null)
    {
        targetModelPolicyTouched = true;
        var modelPolicy = body.ModelPolicy.Trim().ToLowerInvariant();
        if (modelPolicy.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("ModelPolicy"));
            AddSetSummary("modelPolicy", null);
            targetModelPolicy = null;
        }
        else
        {
            if (!new[] { "auto", "pool", "pinned" }.Contains(modelPolicy))
            {
                return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "modelPolicy 仅支持 auto/pool/pinned"), jsonOptions, 400);
            }
            updates.Add(Builders<BsonDocument>.Update.Set("ModelPolicy", modelPolicy));
            AddSetSummary("modelPolicy", modelPolicy);
            targetModelPolicy = modelPolicy;
        }
    }

    if (body.ParameterPolicy is not null)
    {
        var parameterPolicy = NormalizeParameterPolicy(body.ParameterPolicy);
        if (parameterPolicy.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("ParameterPolicy"));
            AddSetSummary("parameterPolicy", null);
        }
        else
        {
            if (!new[] { "default-drop", "strict-require" }.Contains(parameterPolicy))
            {
                return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "parameterPolicy 仅支持 default-drop/strict-require"), jsonOptions, 400);
            }
            updates.Add(Builders<BsonDocument>.Update.Set("ParameterPolicy", parameterPolicy));
            AddSetSummary("parameterPolicy", parameterPolicy);
        }
    }

    if (body.Owner is not null)
    {
        var owner = body.Owner.Trim();
        if (owner.Length > 120)
        {
            return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "owner 最多 120 字符"), jsonOptions, 400);
        }
        if (owner.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("Owner"));
            AddSetSummary("owner", null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("Owner", owner));
            AddSetSummary("owner", owner);
        }
    }

    if (body.MonthlyBudgetUsd is not null)
    {
        if (body.MonthlyBudgetUsd.Value < 0)
        {
            return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "monthlyBudgetUsd 不能小于 0"), jsonOptions, 400);
        }
        if (body.MonthlyBudgetUsd.Value == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("MonthlyBudgetUsd"));
            AddSetSummary("monthlyBudgetUsd", null);
            if (body.BudgetReservationUsd is null)
            {
                updates.Add(Builders<BsonDocument>.Update.Unset("BudgetReservationUsd"));
                AddSetSummary("budgetReservationUsd", null);
            }
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("MonthlyBudgetUsd", new BsonDecimal128(body.MonthlyBudgetUsd.Value)));
            AddSetSummary("monthlyBudgetUsd", body.MonthlyBudgetUsd.Value);
        }
    }

    if (body.BudgetReservationUsd is not null)
    {
        if (body.BudgetReservationUsd.Value < 0)
            return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "budgetReservationUsd 不能小于 0"), jsonOptions, 400);
        if (body.BudgetReservationUsd.Value == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("BudgetReservationUsd"));
            AddSetSummary("budgetReservationUsd", null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("BudgetReservationUsd", new BsonDecimal128(body.BudgetReservationUsd.Value)));
            AddSetSummary("budgetReservationUsd", body.BudgetReservationUsd.Value);
        }
    }

    if (body.RateLimitPerMinute is not null)
    {
        if (body.RateLimitPerMinute.Value < 0)
        {
            return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "rateLimitPerMinute 不能小于 0"), jsonOptions, 400);
        }
        if (body.RateLimitPerMinute.Value == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("RateLimitPerMinute"));
            AddSetSummary("rateLimitPerMinute", null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("RateLimitPerMinute", body.RateLimitPerMinute.Value));
            AddSetSummary("rateLimitPerMinute", body.RateLimitPerMinute.Value);
        }
    }

    if (updates.Count == 0)
    {
        return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "没有可更新字段"), jsonOptions, 400);
    }

    var filter = TenantAccess.Filter(http, fb.And(filters));
    if (body.MonthlyBudgetUsd is not null || body.BudgetReservationUsd is not null)
    {
        if (body.MonthlyBudgetUsd is < 0 || body.BudgetReservationUsd is < 0)
            return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", "预算金额不能小于 0"), jsonOptions, 400);

        var budgetDocuments = await gwAppCallers.Find(filter)
            .Project(Builders<BsonDocument>.Projection
                .Include("AppCallerCode")
                .Include("RequestType")
                .Include("MonthlyBudgetUsd")
                .Include("BudgetReservationUsd"))
            .ToListAsync();
        foreach (var budgetDocument in budgetDocuments)
        {
            var monthlyBudget = body.MonthlyBudgetUsd is null
                ? budgetDocument.AsNullableDecimal("MonthlyBudgetUsd")
                : NormalizePositiveBudget(body.MonthlyBudgetUsd.Value);
            var reservation = body.BudgetReservationUsd is null
                ? body.MonthlyBudgetUsd == 0 ? null : budgetDocument.AsNullableDecimal("BudgetReservationUsd")
                : NormalizePositiveBudget(body.BudgetReservationUsd.Value);
            var error = ValidateBudgetConfiguration(monthlyBudget, reservation);
            if (error is null) continue;
            var identity = $"{budgetDocument.GetStringOrEmpty("AppCallerCode")}::{budgetDocument.GetStringOrEmpty("RequestType")}";
            return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", $"{identity}: {error}"), jsonOptions, 400);
        }
    }
    var bulkActiveConfigError = await ValidateBulkActiveGatewayAppCallerConfigAsync(
        gwAppCallers,
        gwModelPools,
        gwPlatforms,
        gwModels,
        gwModelExchanges,
        TenantAccess.GetRequired(http).TenantId,
        filter,
        targetStatus,
        targetModelPolicyTouched,
        targetModelPolicy);
    if (bulkActiveConfigError is not null)
    {
        return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Fail("INVALID_INPUT", bulkActiveConfigError), jsonOptions, 400);
    }

    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
    var result = await gwAppCallers.UpdateManyAsync(filter, Builders<BsonDocument>.Update.Combine(updates));
    var filterText = string.Join(", ", filterSummary);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "app_caller.bulk_governance",
        targetType: "llmgw_app_caller",
        targetId: "bulk",
        targetName: filterText,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "filter", filterText },
            { "matchedCount", result.MatchedCount },
            { "modifiedCount", result.ModifiedCount },
            { "set", setSummary }
        });

    return Json(ApiEnvelope<BulkUpdateGatewayAppCallersResult>.Ok(new BulkUpdateGatewayAppCallersResult
    {
        MatchedCount = result.MatchedCount,
        ModifiedCount = result.ModifiedCount,
        FilterSummary = filterText,
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// GW 操作审计：控制台配置动作统一写 llm_gateway.llmgw_operation_audits，此处提供只读筛选面。
app.MapGet("/gw/audits", async (
    HttpContext http,
    string? action,
    string? targetType,
    string? actor,
    bool? success,
    string? search,
    double? sinceHours,
    int? page,
    int? pageSize) =>
{
    var p = Math.Max(1, page ?? 1);
    var ps = Math.Clamp(pageSize ?? 50, 1, 200);
    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>();
    if (!string.IsNullOrWhiteSpace(action)) filters.Add(fb.Eq("Action", action.Trim()));
    if (!string.IsNullOrWhiteSpace(targetType)) filters.Add(fb.Eq("TargetType", targetType.Trim()));
    if (!string.IsNullOrWhiteSpace(actor)) filters.Add(fb.Eq("ActorUsername", actor.Trim()));
    if (success is not null) filters.Add(fb.Eq("Success", success.Value));
    if (sinceHours is > 0)
    {
        filters.Add(fb.Gte("CreatedAt", DateTime.UtcNow.AddHours(-sinceHours.Value)));
    }
    if (!string.IsNullOrWhiteSpace(search))
    {
        var pattern = new BsonRegularExpression(search.Trim(), "i");
        filters.Add(fb.Or(
            fb.Regex("TargetId", pattern),
            fb.Regex("TargetName", pattern),
            fb.Regex("Reason", pattern),
            fb.Regex("Action", pattern),
            fb.Regex("TargetType", pattern),
            fb.Regex("ActorUsername", pattern)));
    }

    var filter = TenantAccess.Filter(http, filters.Count > 0 ? fb.And(filters) : fb.Empty);
    var total = await operationAudits.CountDocumentsAsync(filter);
    var docs = await operationAudits.Find(filter)
        .Sort(Builders<BsonDocument>.Sort.Descending("CreatedAt"))
        .Skip((p - 1) * ps)
        .Limit(ps)
        .ToListAsync();

    var metaDocs = await operationAudits.Find(TenantAccess.Filter(http))
        .Project(Builders<BsonDocument>.Projection
            .Include("Action")
            .Include("TargetType")
            .Include("ActorUsername"))
        .Limit(5000)
        .ToListAsync();

    var data = new OperationAuditsData
    {
        Items = docs.Select(MapOperationAudit).ToList(),
        Total = total,
        Page = p,
        PageSize = ps,
        Actions = NormalizeDistinct(metaDocs.Select(d => d.AsNullableString("Action")).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList(), 200),
        TargetTypes = NormalizeDistinct(metaDocs.Select(d => d.AsNullableString("TargetType")).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList(), 200),
        Actors = NormalizeDistinct(metaDocs.Select(d => d.AsNullableString("ActorUsername")).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList(), 200),
    };
    return Json(ApiEnvelope<OperationAuditsData>.Ok(data), jsonOptions);
}).RequireAuthorization("AuditRead");

// M2M scoped key：明文只在创建响应返回一次，数据库只保存 SHA-256。
app.MapGet("/gw/service-keys", async (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    var ownScope = access.Role == LlmGwTenantRoles.Developer
        ? Builders<BsonDocument>.Filter.Eq("CreatedByUserId", access.UserId)
        : Builders<BsonDocument>.Filter.Empty;
    var docs = await serviceKeys.Find(TenantAccess.Filter(http, ownScope))
        .Sort(Builders<BsonDocument>.Sort.Descending("CreatedAt"))
        .Limit(500)
        .ToListAsync();
    var items = docs.Select(d => new ServiceKeyItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Name = d.GetStringOrEmpty("Name"),
        KeyPrefix = d.AsNullableString("KeyPrefix") ?? "gwk_",
        Enabled = d.AsNullableBool("Enabled") ?? false,
        TeamId = d.AsNullableString("TeamId"),
        CreatedByUsername = d.AsNullableString("CreatedByUsername"),
        SourceSystem = d.AsNullableString("SourceSystem") ?? "external",
        AppCallerCodes = d.AsStringList("AppCallerCodes"),
        IngressProtocols = d.AsStringList("IngressProtocols"),
        Scopes = d.AsStringList("Scopes"),
        AllowedCidrs = d.AsStringList("AllowedCidrs"),
        RateLimitPerMinute = d.AsNullableInt("RateLimitPerMinute"),
        ExpiresAt = d.AsNullableUtcDateTime("ExpiresAt").ToIso(),
        LastUsedAt = d.AsNullableUtcDateTime("LastUsedAt").ToIso(),
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
    }).ToList();
    return Json(ApiEnvelope<List<ServiceKeyItem>>.Ok(items), jsonOptions);
}).RequireAuthorization("ServiceKeyWrite");

app.MapPost("/gw/service-keys", async (HttpContext http, ServiceKeyCreateRequest body) =>
{
    var tenant = TenantAccess.GetRequired(http);
    var name = (body.Name ?? string.Empty).Trim();
    var sourceSystem = (body.SourceSystem ?? "external").Trim();
    var appCallerCodes = NormalizeDistinct(body.AppCallerCodes ?? [], 200);
    var protocols = NormalizeDistinct(body.IngressProtocols ?? [], 20);
    var scopes = NormalizeDistinct(body.Scopes ?? [], 20);
    var allowedCidrs = NormalizeDistinct(body.AllowedCidrs ?? [], 50);
    if (name.Length == 0 || sourceSystem.Length == 0 || appCallerCodes.Count == 0 || protocols.Count == 0 || scopes.Count == 0)
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_SERVICE_KEY_SCOPE", "name、sourceSystem、appCallerCodes、ingressProtocols、scopes 均为必填"), jsonOptions, 400);
    }
    var allowedProtocols = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "*", "gw-native", "openai-compatible", "claude-compatible", "gemini-compatible",
    };
    var allowedScopes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "*", "invoke", "stream:invoke", "raw:invoke", "profile:test", "route:read", "readiness:read", "request:cancel", "request:read",
    };
    if (protocols.Any(x => !allowedProtocols.Contains(x)) || scopes.Any(x => !allowedScopes.Contains(x)))
    {
        return Json(ApiEnvelope<object>.Fail(
            "INVALID_SERVICE_KEY_SCOPE",
            "ingressProtocols 或 scopes 包含未支持值"), jsonOptions, 400);
    }
    if (allowedCidrs.Any(x => !IPNetwork.TryParse(x, out _)))
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_SOURCE_CIDR", "allowedCidrs 包含无效 CIDR"), jsonOptions, 400);
    }
    if (body.RateLimitPerMinute is < 1 or > 100000)
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_RATE_LIMIT", "rateLimitPerMinute 仅支持 1 至 100000"), jsonOptions, 400);
    }
    if (body.ExpiresAt is not null && body.ExpiresAt.Value.ToUniversalTime() <= DateTime.UtcNow)
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_EXPIRY", "expiresAt 必须晚于当前时间"), jsonOptions, 400);
    }

    var teamId = string.IsNullOrWhiteSpace(body.TeamId) ? null : body.TeamId.Trim();
    if (teamId is not null)
    {
        var teamExists = await teams.CountDocumentsAsync(x => x.Id == teamId && x.TenantId == tenant.TenantId && x.Status == "active") == 1;
        if (!teamExists || tenant.Role == LlmGwTenantRoles.Developer && !tenant.TeamIds.Contains(teamId, StringComparer.Ordinal))
        {
            return Json(ApiEnvelope<object>.Fail("TEAM_SCOPE_DENIED", "不能为该团队创建 service key"), jsonOptions, 403);
        }
    }
    else if (tenant.TeamIds.Count == 1)
    {
        teamId = tenant.TeamIds[0];
    }

    BsonDocument? rotatedKey = null;
    if (!string.IsNullOrWhiteSpace(body.RotatesKeyId))
    {
        var rotationFilter = Builders<BsonDocument>.Filter.Eq("_id", body.RotatesKeyId.Trim());
        if (tenant.Role == LlmGwTenantRoles.Developer)
            rotationFilter &= Builders<BsonDocument>.Filter.Eq("CreatedByUserId", tenant.UserId);
        rotatedKey = await serviceKeys.Find(TenantAccess.Filter(http, rotationFilter)).FirstOrDefaultAsync();
        if (rotatedKey is null)
            return Json(ApiEnvelope<object>.Fail("ROTATION_SOURCE_NOT_FOUND", "待轮换密钥不存在或不在当前管理范围"), jsonOptions, 404);
    }

    var secretBytes = RandomNumberGenerator.GetBytes(32);
    var plainKey = "gwk_" + Convert.ToBase64String(secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    var keyPrefix = plainKey[..Math.Min(plainKey.Length, 12)];
    var keyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plainKey))).ToLowerInvariant();
    var id = Guid.NewGuid().ToString("N");
    var now = DateTime.UtcNow;
    var expiresAt = body.ExpiresAt?.ToUniversalTime();
    await serviceKeys.InsertOneAsync(new BsonDocument
    {
        { "_id", id },
        { "TenantId", tenant.TenantId },
        { "TeamId", teamId is null ? BsonNull.Value : teamId },
        { "Name", name },
        { "KeyPrefix", keyPrefix },
        { "KeyHash", keyHash },
        { "CreatedByUserId", tenant.UserId },
        { "CreatedByUsername", tenant.Username },
        { "Enabled", true },
        { "SourceSystem", sourceSystem },
        { "AppCallerCodes", new BsonArray(appCallerCodes) },
        { "IngressProtocols", new BsonArray(protocols) },
        { "Scopes", new BsonArray(scopes) },
        { "AllowedCidrs", new BsonArray(allowedCidrs) },
        { "RateLimitPerMinute", body.RateLimitPerMinute is null ? BsonNull.Value : body.RateLimitPerMinute.Value },
        { "RotatesKeyId", rotatedKey is null ? BsonNull.Value : rotatedKey.GetStringOrEmpty("_id") },
        { "ExpiresAt", expiresAt is null ? BsonNull.Value : new BsonDateTime(expiresAt.Value) },
        { "CreatedAt", now },
        { "UpdatedAt", now },
    });
    try
    {
        await serviceKeyDirectory.InsertOneAsync(new BsonDocument
        {
            { "_id", id },
            { "KeyHash", keyHash },
            { "TenantId", tenant.TenantId },
            { "ServiceKeyId", id },
            { "CreatedAt", now },
        });
    }
    catch
    {
        await serviceKeys.DeleteOneAsync(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)));
        throw;
    }
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        "service_key.create",
        "llmgw_service_key",
        id,
        name,
        true,
        null,
        new BsonDocument
        {
            { "sourceSystem", sourceSystem },
            { "appCallerCount", appCallerCodes.Count },
            { "protocolCount", protocols.Count },
            { "scopeCount", scopes.Count },
            { "teamId", teamId is null ? BsonNull.Value : teamId },
            { "allowedCidrCount", allowedCidrs.Count },
            { "rateLimitPerMinute", body.RateLimitPerMinute is null ? BsonNull.Value : body.RateLimitPerMinute.Value },
            { "rotatesKeyId", rotatedKey is null ? BsonNull.Value : rotatedKey.GetStringOrEmpty("_id") },
        });
    return Json(ApiEnvelope<object>.Ok(new
    {
        id,
        name,
        keyPrefix,
        key = plainKey,
        warning = "该 key 只显示一次；数据库未保存明文",
        sourceSystem,
        appCallerCodes,
        ingressProtocols = protocols,
        scopes,
        teamId,
        allowedCidrs,
        rateLimitPerMinute = body.RateLimitPerMinute,
        rotatesKeyId = rotatedKey?.GetStringOrEmpty("_id"),
        expiresAt,
    }), jsonOptions, 201);
}).RequireAuthorization("ServiceKeyWrite");

app.MapDelete("/gw/service-keys/{id}", async (HttpContext http, string id) =>
{
    var access = TenantAccess.GetRequired(http);
    var scopeFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    if (access.Role == LlmGwTenantRoles.Developer)
        scopeFilter &= Builders<BsonDocument>.Filter.Eq("CreatedByUserId", access.UserId);
    var keyFilter = TenantAccess.Filter(http, scopeFilter);
    var existing = await serviceKeys.Find(keyFilter).FirstOrDefaultAsync();
    if (existing is null)
        return Json(ApiEnvelope<object>.Fail("SERVICE_KEY_NOT_FOUND", "service key 不存在"), jsonOptions, 404);
    await serviceKeys.UpdateOneAsync(
        keyFilter,
        Builders<BsonDocument>.Update.Set("Enabled", false).Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        "service_key.revoke",
        "llmgw_service_key",
        id,
        existing.AsNullableString("Name"),
        true,
        null);
    return Json(ApiEnvelope<object>.Ok(new { id, revoked = true }), jsonOptions);
}).RequireAuthorization("ServiceKeyWrite");

// 影子比对：汇总 + 最近 N 条
app.MapGet("/gw/shadow-comparisons", async (HttpContext http, int? limit, string? appCallerCode, string? kind, string? releaseCommit, double? sinceHours) =>
{
    var n = Math.Clamp(limit ?? 50, 1, 500);
    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>();
    if (!string.IsNullOrWhiteSpace(appCallerCode)) filters.Add(fb.Eq("AppCallerCode", appCallerCode.Trim()));
    if (!string.IsNullOrWhiteSpace(kind)) filters.Add(fb.Eq("Kind", kind.Trim()));
    var normalizedReleaseCommit = NormalizeCommitFilter(releaseCommit);
    if (normalizedReleaseCommit is not null) filters.Add(fb.Eq("ReleaseCommit", normalizedReleaseCommit));
    var since = sinceHours is > 0 ? DateTime.UtcNow.AddHours(-sinceHours.Value) : (DateTime?)null;
    if (since is not null) filters.Add(fb.Gte("ComparedAt", since.Value));
    var filter = TenantAccess.Filter(http, filters.Count == 0 ? fb.Empty : fb.And(filters));
    var total = await shadows.CountDocumentsAsync(filter);
    var allMatch = await shadows.CountDocumentsAsync(fb.And(filter, fb.Eq("AllMatch", true)));
    var critical = await shadows.CountDocumentsAsync(fb.And(filter, fb.Eq("HasCritical", true)));
    var httpFail = await shadows.CountDocumentsAsync(fb.And(filter, fb.Eq("HttpOk", false)));
    var firstDoc = total > 0
        ? await shadows.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("ComparedAt")).Limit(1).FirstOrDefaultAsync()
        : null;
    var lastDoc = total > 0
        ? await shadows.Find(filter).Sort(Builders<BsonDocument>.Sort.Descending("ComparedAt")).Limit(1).FirstOrDefaultAsync()
        : null;
    var first = firstDoc?.AsNullableUtcDateTime("ComparedAt");
    var last = lastDoc?.AsNullableUtcDateTime("ComparedAt");
    var coverageHours = first is not null && last is not null
        ? Math.Max(0, (last.Value - first.Value).TotalHours)
        : 0;
    var recent = await shadows.Find(filter).Sort(Builders<BsonDocument>.Sort.Descending("ComparedAt")).Limit(n).ToListAsync();
    var data = new ShadowData
    {
        Summary = new ShadowSummary
        {
            Total = total,
            AllMatch = allMatch,
            Critical = critical,
            HttpFail = httpFail,
            SinceHours = sinceHours,
            Since = since?.ToString("O"),
            ReleaseCommit = normalizedReleaseCommit,
            FirstComparedAt = first.ToIso(),
            LastComparedAt = last.ToIso(),
            CoverageHours = coverageHours,
        },
        Recent = recent.Select(MapShadow).ToList(),
    };
    return Json(ApiEnvelope<ShadowData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// ─────────────── 网关配置面（可写，腿 B 第二刀）───────────────
// 让控制台不只能看还能配置。当前开放最安全的写操作：启用态、默认标记、认领到 GW 自有集合。
// 均为定点字段更新（不碰密钥、不删数据）：已认领对象写 llm_gateway；未认领对象仍写 MAP 兼容集合。
// 密钥轮换 / 新建平台 / 编辑 transformer 等更重的写操作后续再开。

// 平台启用/停用
app.MapPut("/gw/platforms/{id}/enabled", async (HttpContext http, string id, ToggleEnabledRequest body) =>
{
    // 缺 enabled 字段（空 body / 漏传）一律拒绝，避免默认 false 误关平台。
    if (body?.Enabled is not bool enabled) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "缺少 enabled 字段（true/false）"), jsonOptions, 400);
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var doc = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    var targetPlatforms = gwPlatforms;
    var targetAuthority = "llm_gateway";
    if (doc is null)
    {
        if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
            return Json(ApiEnvelope<PlatformItem>.Fail("NOT_FOUND", $"平台不存在：{id}"), jsonOptions, 404);
        doc = await platforms.Find(sourceFilter).FirstOrDefaultAsync();
        targetPlatforms = platforms;
        targetAuthority = "map";
        filter = sourceFilter;
    }
    if (doc is null) return Json(ApiEnvelope<PlatformItem>.Fail("NOT_FOUND", $"平台不存在：{id}"), jsonOptions, 404);
    var update = Builders<BsonDocument>.Update.Set("Enabled", enabled).Set("UpdatedAt", DateTime.UtcNow);
    await targetPlatforms.UpdateOneAsync(filter, update);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "platform.set_enabled",
        targetType: targetAuthority == "llm_gateway" ? "llmgw_platform" : "llmplatform",
        targetId: id,
        targetName: doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "enabled", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableBool("Enabled")) }, { "to", enabled } } },
            { "authority", targetAuthority },
        });
    var fresh = await targetPlatforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型启用/停用
app.MapPut("/gw/models/{id}/enabled", async (HttpContext http, string id, ToggleEnabledRequest body) =>
{
    // 缺 enabled 字段一律拒绝，避免默认 false 误关模型。
    if (body?.Enabled is not bool enabled) return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "缺少 enabled 字段（true/false）"), jsonOptions, 400);
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var doc = await gwModels.Find(filter).FirstOrDefaultAsync();
    var targetModels = gwModels;
    var targetAuthority = "llm_gateway";
    if (doc is null)
    {
        if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
            return Json(ApiEnvelope<ModelItem>.Fail("NOT_FOUND", $"模型不存在：{id}"), jsonOptions, 404);
        doc = await models.Find(sourceFilter).FirstOrDefaultAsync();
        targetModels = models;
        targetAuthority = "map";
        filter = sourceFilter;
    }
    if (doc is null) return Json(ApiEnvelope<ModelItem>.Fail("NOT_FOUND", $"模型不存在：{id}"), jsonOptions, 404);
    var update = Builders<BsonDocument>.Update.Set("Enabled", enabled).Set("UpdatedAt", DateTime.UtcNow);
    await targetModels.UpdateOneAsync(filter, update);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.set_enabled",
        targetType: targetAuthority == "llm_gateway" ? "llmgw_model" : "llmmodel",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "enabled", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableBool("Enabled")) }, { "to", enabled } } },
            { "authority", targetAuthority },
        });
    var fresh = await targetModels.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ModelItem>.Ok(MapModel(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 平台认领：把 MAP 平台复制到 GW 自有 llm_gateway.llmgw_platforms。
app.MapPut("/gw/platforms/{id}/claim", async (HttpContext http, string id) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<PlatformItem>.Fail("INTERNAL_GOVERNANCE_ONLY", "仅内部租户可认领 MAP 平台"), jsonOptions, 403);
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var source = await platforms.Find(sourceFilter).FirstOrDefaultAsync();
    if (source is null) return Json(ApiEnvelope<PlatformItem>.Fail("NOT_FOUND", $"平台不存在：{id}"), jsonOptions, 404);

    var now = DateTime.UtcNow;
    var before = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    var claimed = new BsonDocument(source);
    claimed["TenantId"] = internalTenantId;
    claimed["SourceCollection"] = "llmplatforms";
    claimed["Authority"] = "llm_gateway";
    claimed["ClaimedAt"] = now;
    claimed["UpdatedAt"] = now;

    await gwPlatforms.ReplaceOneAsync(filter, claimed, new ReplaceOptions { IsUpsert = true });
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "platform.claim_to_gateway",
        targetType: "llmgw_platform",
        targetId: id,
        targetName: source.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "sourceCollection", "llmplatforms" },
            { "authority", "llm_gateway" },
            { "wasExistingGatewayPlatform", before is not null },
        });

    var fresh = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 平台密钥轮换：只允许写入已认领到 GW 的平台，不直接修改 MAP 来源平台。
app.MapPut("/gw/platforms/{id}/api-key", async (HttpContext http, string id, [FromBody] RotateApiKeyRequest body) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<PlatformItem>.Fail("NOT_GW_AUTHORITY", "请先将平台认领到 GW，再在 GW 中轮换密钥"), jsonOptions, 409);
    if (string.IsNullOrWhiteSpace(body?.ApiKey)) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "apiKey 不能为空"), jsonOptions, 400);
    if (body.ApiKey.Length > 20000) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "apiKey 长度超出限制"), jsonOptions, 400);

    string encrypted;
    try
    {
        encrypted = GwApiKeyCrypto.Encrypt(body.ApiKey, config);
    }
    catch (InvalidOperationException ex)
    {
        return Json(ApiEnvelope<PlatformItem>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
    }

    var hadKey = !string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted"));
    await gwPlatforms.UpdateOneAsync(filter, Builders<BsonDocument>.Update
        .Set("ApiKeyEncrypted", encrypted)
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "platform.rotate_api_key",
        targetType: "llmgw_platform",
        targetId: id,
        targetName: doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "hasKey", new BsonDocument { { "from", hadKey }, { "to", true } } },
            { "authority", "llm_gateway" },
        });
    var fresh = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 平台密钥删除：只允许清理 GW 权威平台的密钥，MAP 来源平台必须先认领。
app.MapDelete("/gw/platforms/{id}/api-key", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<PlatformItem>.Fail("NOT_GW_AUTHORITY", "请先将平台认领到 GW，再在 GW 中删除密钥"), jsonOptions, 409);

    var hadKey = !string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted"));
    await gwPlatforms.UpdateOneAsync(filter, Builders<BsonDocument>.Update
        .Unset("ApiKeyEncrypted")
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "platform.delete_api_key",
        targetType: "llmgw_platform",
        targetId: id,
        targetName: doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "hasKey", new BsonDocument { { "from", hadKey }, { "to", false } } },
            { "authority", "llm_gateway" },
        });
    var fresh = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型认领：把 MAP 模型复制到 GW 自有 llm_gateway.llmgw_models。
app.MapPut("/gw/models/{id}/claim", async (HttpContext http, string id) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<ModelItem>.Fail("INTERNAL_GOVERNANCE_ONLY", "仅内部租户可认领 MAP 模型"), jsonOptions, 403);
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var source = await models.Find(sourceFilter).FirstOrDefaultAsync();
    if (source is null) return Json(ApiEnvelope<ModelItem>.Fail("NOT_FOUND", $"模型不存在：{id}"), jsonOptions, 404);

    var now = DateTime.UtcNow;
    var before = await gwModels.Find(filter).FirstOrDefaultAsync();
    var claimed = new BsonDocument(source);
    claimed["TenantId"] = internalTenantId;
    claimed["SourceCollection"] = "llmmodels";
    claimed["Authority"] = "llm_gateway";
    claimed["ClaimedAt"] = now;
    claimed["UpdatedAt"] = now;

    await gwModels.ReplaceOneAsync(filter, claimed, new ReplaceOptions { IsUpsert = true });
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.claim_to_gateway",
        targetType: "llmgw_model",
        targetId: id,
        targetName: source.AsNullableString("ModelName") ?? source.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "sourceCollection", "llmmodels" },
            { "authority", "llm_gateway" },
            { "wasExistingGatewayModel", before is not null },
            { "platformId", source.AsNullableString("PlatformId") ?? string.Empty },
        });

    var fresh = await gwModels.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ModelItem>.Ok(MapModel(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型密钥轮换：只允许写入已认领到 GW 的模型；模型未配置 key 时仍可继承平台 key。
app.MapPut("/gw/models/{id}/api-key", async (HttpContext http, string id, [FromBody] RotateApiKeyRequest body) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModels.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<ModelItem>.Fail("NOT_GW_AUTHORITY", "请先将模型认领到 GW，再在 GW 中轮换密钥"), jsonOptions, 409);
    if (string.IsNullOrWhiteSpace(body?.ApiKey)) return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "apiKey 不能为空"), jsonOptions, 400);
    if (body.ApiKey.Length > 20000) return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "apiKey 长度超出限制"), jsonOptions, 400);

    string encrypted;
    try
    {
        encrypted = GwApiKeyCrypto.Encrypt(body.ApiKey, config);
    }
    catch (InvalidOperationException ex)
    {
        return Json(ApiEnvelope<ModelItem>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
    }

    var hadKey = !string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted"));
    await gwModels.UpdateOneAsync(filter, Builders<BsonDocument>.Update
        .Set("ApiKeyEncrypted", encrypted)
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.rotate_api_key",
        targetType: "llmgw_model",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "hasKey", new BsonDocument { { "from", hadKey }, { "to", true } } },
            { "authority", "llm_gateway" },
        });
    var fresh = await gwModels.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ModelItem>.Ok(MapModel(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型密钥删除：只允许清理 GW 权威模型的模型级密钥；删除后可继续继承平台 key。
app.MapDelete("/gw/models/{id}/api-key", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModels.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<ModelItem>.Fail("NOT_GW_AUTHORITY", "请先将模型认领到 GW，再在 GW 中删除密钥"), jsonOptions, 409);

    var hadKey = !string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted"));
    await gwModels.UpdateOneAsync(filter, Builders<BsonDocument>.Update
        .Unset("ApiKeyEncrypted")
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.delete_api_key",
        targetType: "llmgw_model",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "hasKey", new BsonDocument { { "from", hadKey }, { "to", false } } },
            { "authority", "llm_gateway" },
        });
    var fresh = await gwModels.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ModelItem>.Ok(MapModel(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型能力矩阵批量维护：只写 GW-owned 模型副本，用于 provider/platform 级能力校准。
app.MapPost("/gw/models/capabilities/bulk-update", async (HttpContext http, [FromBody] BulkUpdateModelCapabilitiesRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var platformId = (body.PlatformId ?? string.Empty).Trim();
    if (platformId.Length == 0 && body.AllGwOwned != true)
    {
        return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "批量能力维护必须选择平台，或显式设置 allGwOwned=true"), jsonOptions, 400);
    }

    var capabilityPatches = new List<BsonDocument>();
    foreach (var capability in body.Capabilities ?? new List<ModelCapabilityItem>())
    {
        if (capability is null) continue;
        var type = capability.Type.Trim();
        var source = string.IsNullOrWhiteSpace(capability.Source) ? "user" : capability.Source.Trim();
        if (type.Length == 0) return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "capability.type 不能为空"), jsonOptions, 400);
        if (type.Length > 120) return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "capability.type 长度超出限制"), jsonOptions, 400);
        if (source.Length > 40) return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "capability.source 长度超出限制"), jsonOptions, 400);
        capabilityPatches.Add(new BsonDocument
        {
            ["Type"] = type,
            ["Source"] = source,
            ["Value"] = capability.Value,
            ["UpdatedAt"] = DateTime.UtcNow,
        });
    }
    capabilityPatches = capabilityPatches
        .GroupBy(c => c.GetStringOrEmpty("Type"), StringComparer.OrdinalIgnoreCase)
        .Select(g => g.Last())
        .OrderBy(c => c.GetStringOrEmpty("Type"), StringComparer.OrdinalIgnoreCase)
        .ToList();
    if (capabilityPatches.Count == 0) return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "capabilities 不能为空"), jsonOptions, 400);
    if (capabilityPatches.Count > 100) return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "capabilities 最多 100 项"), jsonOptions, 400);

    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>();
    var filterParts = new List<string>();
    if (platformId.Length > 0)
    {
        filters.Add(fb.Eq("PlatformId", platformId));
        filterParts.Add($"platformId={platformId}");
    }
    else
    {
        filterParts.Add("allGwOwned=true");
    }
    if (body.EnabledOnly == true)
    {
        filters.Add(fb.Eq("Enabled", true));
        filterParts.Add("enabledOnly=true");
    }
    if (body.OnlyMissing == true) filterParts.Add("onlyMissing=true");
    var targetFilter = TenantAccess.Filter(http, filters.Count == 0 ? fb.Empty : fb.And(filters));
    var docs = await gwModels.Find(targetFilter).ToListAsync();
    var modified = 0;
    var skipped = 0;

    foreach (var doc in docs)
    {
        var capsArr = doc.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray ? cv.AsBsonArray : new BsonArray();
        var existingCaps = capsArr.Where(c => c.IsBsonDocument).Select(c => new BsonDocument(c.AsBsonDocument)).ToList();
        var byType = existingCaps
            .Where(c => !string.IsNullOrWhiteSpace(c.AsNullableString("Type")))
            .ToDictionary(c => c.AsNullableString("Type")!, c => c, StringComparer.OrdinalIgnoreCase);
        var changed = false;
        foreach (var patch in capabilityPatches)
        {
            var type = patch.GetStringOrEmpty("Type");
            if (body.OnlyMissing == true && byType.ContainsKey(type)) continue;
            byType[type] = new BsonDocument(patch);
            changed = true;
        }
        if (!changed)
        {
            skipped++;
            continue;
        }

        var nextCaps = byType
            .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv => kv.Value)
            .ToList();
        await gwModels.UpdateOneAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", doc.GetStringOrEmpty("_id"))),
            Builders<BsonDocument>.Update
                .Set("Capabilities", new BsonArray(nextCaps))
                .Set("UpdatedAt", DateTime.UtcNow));
        modified++;
    }

    var result = new BulkUpdateModelCapabilitiesResult
    {
        MatchedCount = docs.Count,
        ModifiedCount = modified,
        SkippedCount = skipped,
        CapabilityCount = capabilityPatches.Count,
        FilterSummary = string.Join(", ", filterParts),
    };
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.capabilities.bulk_update",
        targetType: "llmgw_model",
        targetId: platformId.Length == 0 ? "all" : platformId,
        targetName: platformId.Length == 0 ? "all gw models" : platformId,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "platformId", platformId },
            { "enabledOnly", body.EnabledOnly == true },
            { "onlyMissing", body.OnlyMissing == true },
            { "capabilityCount", capabilityPatches.Count },
            { "matchedCount", docs.Count },
            { "modifiedCount", modified },
            { "authority", "llm_gateway" },
        });

    return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Ok(result), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// Exchange 认领：先只提供 API，不暴露密钥明文；resolver 会优先读 GW 自有 exchange。
app.MapPut("/gw/exchanges/{id}/claim", async (HttpContext http, string id) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<ExchangeItem>.Fail("INTERNAL_GOVERNANCE_ONLY", "仅内部租户可认领 MAP Exchange"), jsonOptions, 403);
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var source = await modelExchanges.Find(sourceFilter).FirstOrDefaultAsync();
    if (source is null) return Json(ApiEnvelope<ExchangeItem>.Fail("NOT_FOUND", $"Exchange 不存在：{id}"), jsonOptions, 404);

    var now = DateTime.UtcNow;
    var before = await gwModelExchanges.Find(filter).FirstOrDefaultAsync();
    var claimed = new BsonDocument(source);
    claimed["TenantId"] = internalTenantId;
    claimed["SourceCollection"] = "model_exchanges";
    claimed["Authority"] = "llm_gateway";
    claimed["ClaimedAt"] = now;
    claimed["UpdatedAt"] = now;

    await gwModelExchanges.ReplaceOneAsync(filter, claimed, new ReplaceOptions { IsUpsert = true });
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "exchange.claim_to_gateway",
        targetType: "llmgw_model_exchange",
        targetId: id,
        targetName: source.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "sourceCollection", "model_exchanges" },
            { "authority", "llm_gateway" },
            { "wasExistingGatewayExchange", before is not null },
        });

    var fresh = await gwModelExchanges.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ExchangeItem>.Ok(MapExchange(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// Exchange 密钥轮换：只允许写入已认领到 GW 的 Exchange。
app.MapPut("/gw/exchanges/{id}/api-key", async (HttpContext http, string id, [FromBody] RotateApiKeyRequest body) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModelExchanges.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<ExchangeItem>.Fail("NOT_GW_AUTHORITY", "请先将 Exchange 认领到 GW，再在 GW 中轮换密钥"), jsonOptions, 409);
    if (string.IsNullOrWhiteSpace(body?.ApiKey)) return Json(ApiEnvelope<ExchangeItem>.Fail("INVALID_INPUT", "apiKey 不能为空"), jsonOptions, 400);
    if (body.ApiKey.Length > 20000) return Json(ApiEnvelope<ExchangeItem>.Fail("INVALID_INPUT", "apiKey 长度超出限制"), jsonOptions, 400);

    string encrypted;
    try
    {
        encrypted = GwApiKeyCrypto.Encrypt(body.ApiKey, config);
    }
    catch (InvalidOperationException ex)
    {
        return Json(ApiEnvelope<ExchangeItem>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
    }

    var hadKey = !string.IsNullOrEmpty(doc.AsNullableString("TargetApiKeyEncrypted"));
    await gwModelExchanges.UpdateOneAsync(filter, Builders<BsonDocument>.Update
        .Set("TargetApiKeyEncrypted", encrypted)
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "exchange.rotate_api_key",
        targetType: "llmgw_model_exchange",
        targetId: id,
        targetName: doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "hasKey", new BsonDocument { { "from", hadKey }, { "to", true } } },
            { "authority", "llm_gateway" },
        });
    var fresh = await gwModelExchanges.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ExchangeItem>.Ok(MapExchange(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// Exchange 密钥删除：只允许清理 GW 权威 Exchange 的目标密钥。
app.MapDelete("/gw/exchanges/{id}/api-key", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModelExchanges.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<ExchangeItem>.Fail("NOT_GW_AUTHORITY", "请先将 Exchange 认领到 GW，再在 GW 中删除密钥"), jsonOptions, 409);

    var hadKey = !string.IsNullOrEmpty(doc.AsNullableString("TargetApiKeyEncrypted"));
    await gwModelExchanges.UpdateOneAsync(filter, Builders<BsonDocument>.Update
        .Unset("TargetApiKeyEncrypted")
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "exchange.delete_api_key",
        targetType: "llmgw_model_exchange",
        targetId: id,
        targetName: doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "hasKey", new BsonDocument { { "from", hadKey }, { "to", false } } },
            { "authority", "llm_gateway" },
        });
    var fresh = await gwModelExchanges.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ExchangeItem>.Ok(MapExchange(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 批量密钥轮换：只写 llm_gateway 自有平台/模型/Exchange 集合。调用方必须显式给 ids 或 allGwOwned=true。
app.MapPost("/gw/api-keys/bulk-rotate", async (HttpContext http, [FromBody] BulkRotateApiKeysRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var objectType = (body.ObjectType ?? string.Empty).Trim().ToLowerInvariant();
    if (objectType is not ("platform" or "model" or "exchange"))
    {
        return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("INVALID_INPUT", "objectType 仅支持 platform/model/exchange"), jsonOptions, 400);
    }
    if (string.IsNullOrWhiteSpace(body.ApiKey)) return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("INVALID_INPUT", "apiKey 不能为空"), jsonOptions, 400);
    if (body.ApiKey.Length > 20000) return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("INVALID_INPUT", "apiKey 长度超出限制"), jsonOptions, 400);

    var ids = (body.Ids ?? new List<string>())
        .Select(x => (x ?? string.Empty).Trim())
        .Where(x => x.Length > 0)
        .Distinct(StringComparer.Ordinal)
        .Take(501)
        .ToList();
    if (ids.Count > 500) return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("INVALID_INPUT", "ids 最多 500 个"), jsonOptions, 400);
    if (ids.Count == 0 && body.AllGwOwned != true)
    {
        return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("INVALID_INPUT", "批量轮换必须提供 ids，或显式设置 allGwOwned=true"), jsonOptions, 400);
    }

    string encrypted;
    try
    {
        encrypted = GwApiKeyCrypto.Encrypt(body.ApiKey, config);
    }
    catch (InvalidOperationException ex)
    {
        return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
    }

    IMongoCollection<BsonDocument> targetCollection;
    string encryptedField;
    string targetType;
    string auditAction;
    switch (objectType)
    {
        case "platform":
            targetCollection = gwPlatforms;
            encryptedField = "ApiKeyEncrypted";
            targetType = "llmgw_platform";
            auditAction = "platform.bulk_rotate_api_key";
            break;
        case "model":
            targetCollection = gwModels;
            encryptedField = "ApiKeyEncrypted";
            targetType = "llmgw_model";
            auditAction = "model.bulk_rotate_api_key";
            break;
        default:
            targetCollection = gwModelExchanges;
            encryptedField = "TargetApiKeyEncrypted";
            targetType = "llmgw_model_exchange";
            auditAction = "exchange.bulk_rotate_api_key";
            break;
    }

    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>();
    var filterParts = new List<string> { $"objectType={objectType}" };
    if (ids.Count > 0)
    {
        filters.Add(fb.In("_id", ids));
        filterParts.Add($"ids={ids.Count}");
    }
    else
    {
        filterParts.Add("allGwOwned=true");
    }
    if (body.EnabledOnly == true)
    {
        filters.Add(fb.Eq("Enabled", true));
        filterParts.Add("enabledOnly=true");
    }
    if (body.OnlyMissing == true)
    {
        filters.Add(fb.Or(fb.Exists(encryptedField, false), fb.Eq(encryptedField, BsonNull.Value), fb.Eq(encryptedField, "")));
        filterParts.Add("onlyMissing=true");
    }
    var platformId = (body.PlatformId ?? string.Empty).Trim();
    if (objectType == "model" && platformId.Length > 0)
    {
        filters.Add(fb.Eq("PlatformId", platformId));
        filterParts.Add($"platformId={platformId}");
    }
    else if (objectType != "model" && platformId.Length > 0)
    {
        return Json(ApiEnvelope<BulkRotateApiKeysResult>.Fail("INVALID_INPUT", "platformId 仅支持 model 批量轮换"), jsonOptions, 400);
    }

    var targetFilter = TenantAccess.Filter(http, filters.Count == 0 ? fb.Empty : fb.And(filters));
    var matchedCount = await targetCollection.CountDocumentsAsync(targetFilter);
    var skippedCount = ids.Count > 0 ? Math.Max(0, ids.Count - matchedCount) : 0;
    if (matchedCount == 0)
    {
        var emptyResult = new BulkRotateApiKeysResult
        {
            ObjectType = objectType,
            MatchedCount = 0,
            ModifiedCount = 0,
            SkippedCount = skippedCount,
            FilterSummary = string.Join(", ", filterParts),
        };
        return Json(ApiEnvelope<BulkRotateApiKeysResult>.Ok(emptyResult), jsonOptions);
    }

    var updateResult = await targetCollection.UpdateManyAsync(targetFilter, Builders<BsonDocument>.Update
        .Set(encryptedField, encrypted)
        .Set("UpdatedAt", DateTime.UtcNow));
    var result = new BulkRotateApiKeysResult
    {
        ObjectType = objectType,
        MatchedCount = matchedCount,
        ModifiedCount = updateResult.ModifiedCount,
        SkippedCount = skippedCount,
        FilterSummary = string.Join(", ", filterParts),
    };

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: auditAction,
        targetType: targetType,
        targetId: ids.Count > 0 ? "ids" : "all",
        targetName: objectType,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "objectType", objectType },
            { "filterSummary", result.FilterSummary },
            { "matchedCount", matchedCount },
            { "modifiedCount", updateResult.ModifiedCount },
            { "skippedCount", skippedCount },
            { "hasKey", new BsonDocument { { "to", true } } },
            { "authority", "llm_gateway" },
        });

    return Json(ApiEnvelope<BulkRotateApiKeysResult>.Ok(result), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型池新建：直接创建 GW 权威池，不再要求先去 MAP 创建再认领。
app.MapPost("/gw/pools", async (HttpContext http, [FromBody] CreatePoolRequest body) =>
{
    if (body is null) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var name = (body.Name ?? string.Empty).Trim();
    var code = (body.Code ?? string.Empty).Trim();
    var modelType = (body.ModelType ?? string.Empty).Trim().ToLowerInvariant();
    var description = (body.Description ?? string.Empty).Trim();
    if (name.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "name 不能为空"), jsonOptions, 400);
    if (name.Length > 120) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "name 最多 120 字符"), jsonOptions, 400);
    if (modelType.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelType 不能为空"), jsonOptions, 400);
    if (modelType.Length > 80) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelType 最多 80 字符"), jsonOptions, 400);
    if (code.Length == 0) code = name;
    if (code.Length > 120) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "code 最多 120 字符"), jsonOptions, 400);
    if (description.Length > 1000) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "description 最多 1000 字符"), jsonOptions, 400);
    if (body.Priority is < 1 or > 100000) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "priority 必须在 1 到 100000 之间"), jsonOptions, 400);
    if (body.StrategyType is < 0 or > 5) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "strategyType 仅支持 0 到 5"), jsonOptions, 400);

    var now = DateTime.UtcNow;
    var doc = new BsonDocument
    {
        ["_id"] = Guid.NewGuid().ToString("N"),
        ["TenantId"] = TenantAccess.GetRequired(http).TenantId,
        ["Name"] = name,
        ["Code"] = code,
        ["Priority"] = body.Priority ?? 50,
        ["ModelType"] = modelType,
        ["IsDefaultForType"] = body.IsDefaultForType ?? false,
        ["StrategyType"] = body.StrategyType ?? 0,
        ["Models"] = new BsonArray(),
        ["SourceCollection"] = "llmgw_model_pools",
        ["Authority"] = "llm_gateway",
        ["ClaimedAt"] = now,
        ["CreatedAt"] = now,
        ["UpdatedAt"] = now,
    };
    if (description.Length > 0) doc["Description"] = description;

    if (body.IsDefaultForType == true
        && !await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, doc))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "INVALID_INPUT",
            "默认 GW 模型池必须至少包含一个可解析、非 unavailable 的成员；请先创建为非默认池并添加 enabled 模型或 Exchange。"),
            jsonOptions,
            400);
    }

    await gwModelPools.InsertOneAsync(doc);
    if (body.IsDefaultForType == true)
    {
        var fb = Builders<BsonDocument>.Filter;
        await gwModelPools.UpdateManyAsync(
            TenantAccess.Filter(http, fb.And(fb.Eq("ModelType", modelType), fb.Ne("_id", doc.GetStringOrEmpty("_id")))),
            Builders<BsonDocument>.Update.Set("IsDefaultForType", false).Set("UpdatedAt", now));
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.create_gateway",
        targetType: "llmgw_model_pool",
        targetId: doc.GetStringOrEmpty("_id"),
        targetName: name,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "modelType", modelType },
            { "authority", "llm_gateway" },
            { "isDefaultForType", body.IsDefaultForType ?? false },
        });

    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(doc)), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

// 模型池属性编辑：只允许写 GW 权威池。MAP 来源池必须先认领，避免把目标权威又写回旧集合。
app.MapPut("/gw/pools/{id}", async (HttpContext http, string id, [FromBody] UpdatePoolRequest body) =>
{
    if (body is null) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);

    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var doc = await gwModelPools.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
    {
        var mapDoc = TenantAccess.GetRequired(http).TenantId == internalTenantId
            ? await modelGroups.Find(sourceFilter).FirstOrDefaultAsync()
            : null;
        if (mapDoc is not null)
        {
            return Json(ApiEnvelope<PoolItem>.Fail("MAP_POOL_NOT_CLAIMED", "请先将模型池认领到 GW，再编辑模型池属性"), jsonOptions, 409);
        }
        return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池不存在：{id}"), jsonOptions, 404);
    }

    var updates = new List<UpdateDefinition<BsonDocument>>();
    var changes = new BsonDocument();
    void AddChange(string field, object? from, object? to) =>
        changes[field] = new BsonDocument { { "from", ToBsonAuditValue(from) }, { "to", ToBsonAuditValue(to) } };

    var nextModelType = doc.GetStringOrEmpty("ModelType");
    if (body.Name is not null)
    {
        var name = body.Name.Trim();
        if (name.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "name 不能为空"), jsonOptions, 400);
        if (name.Length > 120) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "name 最多 120 字符"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("Name", name));
        AddChange("name", doc.AsNullableString("Name"), name);
    }
    if (body.Code is not null)
    {
        var code = body.Code.Trim();
        if (code.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "code 不能为空"), jsonOptions, 400);
        if (code.Length > 120) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "code 最多 120 字符"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("Code", code));
        AddChange("code", doc.AsNullableString("Code"), code);
    }
    if (body.ModelType is not null)
    {
        var modelType = body.ModelType.Trim().ToLowerInvariant();
        if (modelType.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelType 不能为空"), jsonOptions, 400);
        if (modelType.Length > 80) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelType 最多 80 字符"), jsonOptions, 400);
        nextModelType = modelType;
        updates.Add(Builders<BsonDocument>.Update.Set("ModelType", modelType));
        AddChange("modelType", doc.AsNullableString("ModelType"), modelType);
    }
    if (body.Priority is not null)
    {
        if (body.Priority is < 1 or > 100000) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "priority 必须在 1 到 100000 之间"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("Priority", body.Priority.Value));
        AddChange("priority", doc.AsNullableInt("Priority"), body.Priority.Value);
    }
    if (body.StrategyType is not null)
    {
        if (body.StrategyType is < 0 or > 5) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "strategyType 仅支持 0 到 5"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("StrategyType", body.StrategyType.Value));
        AddChange("strategyType", doc.AsNullableInt("StrategyType"), body.StrategyType.Value);
    }
    if (body.Description is not null)
    {
        var description = body.Description.Trim();
        if (description.Length > 1000) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "description 最多 1000 字符"), jsonOptions, 400);
        if (description.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("Description"));
            AddChange("description", doc.AsNullableString("Description"), null);
        }
        else
        {
            updates.Add(Builders<BsonDocument>.Update.Set("Description", description));
            AddChange("description", doc.AsNullableString("Description"), description);
        }
    }
    if (body.IsDefaultForType is not null)
    {
        updates.Add(Builders<BsonDocument>.Update.Set("IsDefaultForType", body.IsDefaultForType.Value));
        AddChange("isDefaultForType", doc.AsNullableBool("IsDefaultForType") ?? false, body.IsDefaultForType.Value);
    }

    if (updates.Count == 0)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "没有可更新字段"), jsonOptions, 400);
    }

    var now = DateTime.UtcNow;
    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", now));

    var shouldBeDefault = body.IsDefaultForType ?? (doc.AsNullableBool("IsDefaultForType") ?? false);
    if (shouldBeDefault
        && !await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, doc))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "INVALID_INPUT",
            "默认 GW 模型池必须至少包含一个可解析、非 unavailable 的成员；请先添加 enabled 模型或 Exchange。"),
            jsonOptions,
            400);
    }

    await gwModelPools.UpdateOneAsync(filter, Builders<BsonDocument>.Update.Combine(updates));

    if (shouldBeDefault)
    {
        var fb = Builders<BsonDocument>.Filter;
        await gwModelPools.UpdateManyAsync(
            TenantAccess.Filter(http, fb.And(fb.Eq("ModelType", nextModelType), fb.Ne("_id", id))),
            Builders<BsonDocument>.Update.Set("IsDefaultForType", false).Set("UpdatedAt", now));
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.update_gateway",
        targetType: "llmgw_model_pool",
        targetId: id,
        targetName: body.Name?.Trim() ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: changes);

    var fresh = await gwModelPools.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 批量认领 MAP 模型池：把 MAP model_groups 复制到 llm_gateway，自有池默认不覆盖。
app.MapPost("/gw/pools/bulk-claim", async (HttpContext http, [FromBody] BulkClaimPoolsRequest? body) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<BulkClaimPoolsResult>.Fail("INTERNAL_GOVERNANCE_ONLY", "仅内部租户可认领 MAP 模型池"), jsonOptions, 403);
    var modelType = (body?.ModelType ?? string.Empty).Trim();
    var overwrite = body?.Overwrite == true;
    var fb = Builders<BsonDocument>.Filter;
    var mapFilter = modelType.Length == 0 ? fb.Empty : fb.Eq("ModelType", modelType);
    var mapDocs = await modelGroups.Find(mapFilter).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync();
    var now = DateTime.UtcNow;
    var claimed = 0;
    var skipped = 0;
    var changedItems = new List<PoolItem>();

    foreach (var source in mapDocs)
    {
        var id = source.GetStringOrEmpty("_id");
        if (id.Length == 0)
        {
            skipped++;
            continue;
        }
        var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
        var exists = await gwModelPools.Find(filter).FirstOrDefaultAsync();
        if (exists is not null && !overwrite)
        {
            skipped++;
            continue;
        }

        var claimedDoc = new BsonDocument(source);
        claimedDoc["TenantId"] = internalTenantId;
        claimedDoc["SourceCollection"] = "model_groups";
        claimedDoc["Authority"] = "llm_gateway";
        claimedDoc["ClaimedAt"] = exists?.AsNullableUtcDateTime("ClaimedAt") ?? now;
        claimedDoc["UpdatedAt"] = now;
        await gwModelPools.ReplaceOneAsync(filter, claimedDoc, new ReplaceOptions { IsUpsert = true });
        claimed++;
        changedItems.Add(MapPool(claimedDoc));
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.bulk_claim_to_gateway",
        targetType: "llmgw_model_pool",
        targetId: modelType.Length == 0 ? "all" : modelType,
        targetName: modelType.Length == 0 ? "all model pools" : modelType,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "modelType", modelType },
            { "overwrite", overwrite },
            { "claimed", claimed },
            { "skipped", skipped },
            { "authority", "llm_gateway" },
        });

    return Json(ApiEnvelope<BulkClaimPoolsResult>.Ok(new BulkClaimPoolsResult
    {
        Claimed = claimed,
        Skipped = skipped,
        Items = changedItems,
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 历史价格币种批量校准：只写 GW 权威池，默认仅补已有价格但 PriceCurrency 为空的成员。
app.MapPost("/gw/pools/price-currency/bulk-calibrate", async (HttpContext http, [FromBody] BulkCalibratePoolPriceCurrencyRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<BulkCalibratePoolPriceCurrencyResult>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var targetCurrency = NormalizePriceCurrency(body.TargetCurrency);
    if (targetCurrency is null)
    {
        return Json(ApiEnvelope<BulkCalibratePoolPriceCurrencyResult>.Fail("INVALID_INPUT", "targetCurrency 仅支持 CNY 或 USD"), jsonOptions, 400);
    }

    var modelType = (body.ModelType ?? string.Empty).Trim().ToLowerInvariant();
    var onlyMissing = body.OnlyMissing != false;
    var includeMembersWithoutPrice = body.IncludeMembersWithoutPrice == true;
    var fb = Builders<BsonDocument>.Filter;
    var poolFilter = TenantAccess.Filter(http, modelType.Length == 0 ? fb.Empty : fb.Eq("ModelType", modelType));
    var poolDocs = await gwModelPools.Find(poolFilter).ToListAsync();
    var touchedPools = 0;
    var matchedMembers = 0;
    var updatedMembers = 0;
    var now = DateTime.UtcNow;

    foreach (var poolDoc in poolDocs)
    {
        if (!poolDoc.TryGetValue("Models", out var modelsValue) || !modelsValue.IsBsonArray)
        {
            continue;
        }

        var modelsArray = modelsValue.AsBsonArray;
        var poolChanged = false;
        foreach (var memberValue in modelsArray)
        {
            if (!memberValue.IsBsonDocument) continue;
            var member = memberValue.AsBsonDocument;
            var existingCurrency = member.AsNullableString("PriceCurrency");
            if (onlyMissing && !string.IsNullOrWhiteSpace(existingCurrency)) continue;

            var hasPrice = member.AsNullableDecimal("InputPricePerMillion") is not null
                || member.AsNullableDecimal("OutputPricePerMillion") is not null
                || member.AsNullableDecimal("PricePerCall") is not null;
            if (!includeMembersWithoutPrice && !hasPrice) continue;

            matchedMembers++;
            if (string.Equals(existingCurrency, targetCurrency, StringComparison.OrdinalIgnoreCase)) continue;
            member["PriceCurrency"] = targetCurrency;
            updatedMembers++;
            poolChanged = true;
        }

        if (!poolChanged) continue;
        touchedPools++;
        await gwModelPools.UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", poolDoc.GetStringOrEmpty("_id")),
            Builders<BsonDocument>.Update
                .Set("Models", modelsArray)
                .Set("UpdatedAt", now));
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.bulk_calibrate_price_currency",
        targetType: "llmgw_model_pool",
        targetId: modelType.Length == 0 ? "all" : modelType,
        targetName: modelType.Length == 0 ? "all model pools" : modelType,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "modelType", modelType },
            { "targetCurrency", targetCurrency },
            { "onlyMissing", onlyMissing },
            { "includeMembersWithoutPrice", includeMembersWithoutPrice },
            { "scannedPools", poolDocs.Count },
            { "touchedPools", touchedPools },
            { "matchedMembers", matchedMembers },
            { "updatedMembers", updatedMembers },
        });

    return Json(ApiEnvelope<BulkCalibratePoolPriceCurrencyResult>.Ok(new BulkCalibratePoolPriceCurrencyResult
    {
        ScannedPools = poolDocs.Count,
        TouchedPools = touchedPools,
        MatchedMembers = matchedMembers,
        UpdatedMembers = updatedMembers,
        TargetCurrency = targetCurrency,
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型池成员批量导入：从 GW 模型优先、MAP 模型兜底读取候选，只写 GW 权威池。
app.MapPost("/gw/pools/{id}/models/bulk-import", async (HttpContext http, string id, [FromBody] BulkImportPoolModelsRequest? body) =>
{
    body ??= new BulkImportPoolModelsRequest();
    var poolFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var pool = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
    if (pool is null) return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("NOT_GW_AUTHORITY", "请先将模型池认领到 GW，再在 GW 中批量导入成员"), jsonOptions, 409);

    var capabilityFilter = (body.CapabilityFilter ?? "compatible").Trim().ToLowerInvariant();
    var allowedFilters = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "compatible", "all", "vision", "image", "function_calling", "parallel_tool_calls",
        "parameter_capabilities", "thinking", "structured_output", "logprobs", "prompt_cache",
    };
    if (!allowedFilters.Contains(capabilityFilter))
    {
        return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("INVALID_INPUT", "capabilityFilter 不支持"), jsonOptions, 400);
    }

    var maxCount = body.MaxCount ?? 200;
    if (maxCount is < 1 or > 500) return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("INVALID_INPUT", "maxCount 必须在 1 到 500 之间"), jsonOptions, 400);
    var priorityStep = body.PriorityStep ?? 10;
    if (priorityStep is < 1 or > 1000) return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("INVALID_INPUT", "priorityStep 必须在 1 到 1000 之间"), jsonOptions, 400);
    if (body.StartPriority is < 1 or > 100000) return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("INVALID_INPUT", "startPriority 必须在 1 到 100000 之间"), jsonOptions, 400);

    var platformId = (body.PlatformId ?? string.Empty).Trim();
    var modelFb = Builders<BsonDocument>.Filter;
    var sourceFilters = new List<FilterDefinition<BsonDocument>>();
    if (platformId.Length > 0) sourceFilters.Add(modelFb.Eq("PlatformId", platformId));
    if (body.EnabledOnly != false) sourceFilters.Add(modelFb.Eq("Enabled", true));
    var sourceFilter = sourceFilters.Count == 0 ? modelFb.Empty : modelFb.And(sourceFilters);
    var tenantSourceFilter = TenantAccess.Filter(http, sourceFilter);
    var gwModelDocs = await gwModels.Find(tenantSourceFilter).ToListAsync();
    var mapModelDocs = TenantAccess.GetRequired(http).TenantId == internalTenantId
        ? await models.Find(sourceFilter).ToListAsync()
        : new List<BsonDocument>();

    var byKey = new Dictionary<string, BsonDocument>(StringComparer.Ordinal);
    foreach (var modelDoc in gwModelDocs.Concat(mapModelDocs))
    {
        var modelId = modelDoc.AsNullableString("ModelName") ?? modelDoc.AsNullableString("Name") ?? modelDoc.GetStringOrEmpty("_id");
        var resolvedPlatformId = modelDoc.GetStringOrEmpty("PlatformId");
        if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(resolvedPlatformId)) continue;
        var key = $"{resolvedPlatformId}\n{modelId}";
        if (!byKey.ContainsKey(key)) byKey[key] = modelDoc;
    }

    var poolModelType = pool.GetStringOrEmpty("ModelType");
    var matchedDocs = byKey.Values
        .Where(modelDoc => DoesModelMatchBulkImportFilter(modelDoc, poolModelType, capabilityFilter))
        .OrderBy(modelDoc => modelDoc.AsNullableInt("Priority") ?? 100000)
        .ThenBy(modelDoc => modelDoc.GetStringOrEmpty("PlatformId"), StringComparer.Ordinal)
        .ThenBy(modelDoc => modelDoc.AsNullableString("ModelName") ?? modelDoc.AsNullableString("Name") ?? modelDoc.GetStringOrEmpty("_id"), StringComparer.Ordinal)
        .Take(maxCount)
        .ToList();

    var modelsArr = pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var members = modelsArr.Where(x => x.IsBsonDocument).Select(x => new BsonDocument(x.AsBsonDocument)).ToList();
    var existingByKey = members
        .Where(m => !string.IsNullOrWhiteSpace(m.GetStringOrEmpty("ModelId")) && !string.IsNullOrWhiteSpace(m.GetStringOrEmpty("PlatformId")))
        .ToDictionary(m => $"{m.GetStringOrEmpty("PlatformId")}\n{m.GetStringOrEmpty("ModelId")}", m => m, StringComparer.Ordinal);
    var nextPriority = body.StartPriority ?? ((members.Select(m => m.AsNullableInt("Priority") ?? 0).DefaultIfEmpty(0).Max()) + priorityStep);
    var imported = 0;
    var updated = 0;
    var skippedExisting = 0;
    var skippedInvalid = byKey.Count - gwModelDocs.Concat(mapModelDocs).Count(modelDoc =>
    {
        var modelId = modelDoc.AsNullableString("ModelName") ?? modelDoc.AsNullableString("Name") ?? modelDoc.GetStringOrEmpty("_id");
        return !string.IsNullOrWhiteSpace(modelId) && !string.IsNullOrWhiteSpace(modelDoc.GetStringOrEmpty("PlatformId"));
    });

    foreach (var modelDoc in matchedDocs)
    {
        var modelId = modelDoc.AsNullableString("ModelName") ?? modelDoc.AsNullableString("Name") ?? modelDoc.GetStringOrEmpty("_id");
        var resolvedPlatformId = modelDoc.GetStringOrEmpty("PlatformId");
        if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(resolvedPlatformId))
        {
            skippedInvalid++;
            continue;
        }

        var key = $"{resolvedPlatformId}\n{modelId}";
        existingByKey.TryGetValue(key, out var existing);
        if (existing is not null && body.OverwriteExisting != true)
        {
            skippedExisting++;
            continue;
        }

        var priority = existing?.AsNullableInt("Priority") ?? nextPriority;
        if (existing is null) nextPriority += priorityStep;
        var member = BuildPoolMemberFromModel(modelDoc, modelId, resolvedPlatformId, priority, existing);
        existingByKey[key] = member;
        if (existing is null) imported++;
        else updated++;
    }

    var nextMembers = existingByKey.Values
        .OrderBy(m => m.AsNullableInt("Priority") ?? 100000)
        .ThenBy(m => m.GetStringOrEmpty("PlatformId"), StringComparer.Ordinal)
        .ThenBy(m => m.GetStringOrEmpty("ModelId"), StringComparer.Ordinal)
        .ToList();

    if (imported > 0 || updated > 0)
    {
        var validationError = await ValidateDefaultGatewayPoolMembersAsync(
            gwPlatforms,
            gwModels,
            gwModelExchanges,
            pool,
            new BsonArray(nextMembers));
        if (validationError is not null)
        {
            return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("INVALID_INPUT", validationError), jsonOptions, 400);
        }

        await gwModelPools.UpdateOneAsync(poolFilter, Builders<BsonDocument>.Update
            .Set("Models", new BsonArray(nextMembers))
            .Set("UpdatedAt", DateTime.UtcNow));
    }

    var fresh = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
    var result = new BulkImportPoolModelsResult
    {
        ScannedModels = byKey.Count,
        MatchedModels = matchedDocs.Count,
        Imported = imported,
        Updated = updated,
        SkippedExisting = skippedExisting,
        SkippedInvalid = Math.Max(0, skippedInvalid),
        CapabilityFilter = capabilityFilter,
        Pool = MapPool(fresh),
    };

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.models.bulk_import",
        targetType: "llmgw_model_pool",
        targetId: id,
        targetName: pool.AsNullableString("Name") ?? pool.AsNullableString("Code"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "platformId", platformId },
            { "enabledOnly", body.EnabledOnly != false },
            { "capabilityFilter", capabilityFilter },
            { "overwriteExisting", body.OverwriteExisting == true },
            { "maxCount", maxCount },
            { "imported", imported },
            { "updated", updated },
            { "skippedExisting", skippedExisting },
            { "authority", "llm_gateway" },
        });

    return Json(ApiEnvelope<BulkImportPoolModelsResult>.Ok(result), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型池成员 upsert：只允许写已认领到 GW 的池，避免继续把模型池权威写回 MAP。
app.MapPut("/gw/pools/{id}/models", async (HttpContext http, string id, [FromBody] UpsertPoolModelRequest body) =>
{
    var poolFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var pool = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
    if (pool is null) return Json(ApiEnvelope<PoolItem>.Fail("NOT_GW_AUTHORITY", "请先将模型池认领到 GW，再在 GW 中管理池成员"), jsonOptions, 409);
    if (body is null) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);

    var modelId = (body.ModelId ?? string.Empty).Trim();
    var platformId = (body.PlatformId ?? string.Empty).Trim();
    if (modelId.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelId 不能为空"), jsonOptions, 400);
    if (modelId.Length > 300) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelId 长度超出限制"), jsonOptions, 400);
    if (platformId.Length > 200) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "platformId 长度超出限制"), jsonOptions, 400);
    if (body.Priority is < 1 or > 100000) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "priority 必须在 1 到 100000 之间"), jsonOptions, 400);
    if (body.MaxTokens is < 1 or > 1000000) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "maxTokens 必须在 1 到 1000000 之间"), jsonOptions, 400);
    if (body.InputPricePerMillion is < 0 || body.OutputPricePerMillion is < 0 || body.PricePerCall is < 0)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "价格字段不能为负数"), jsonOptions, 400);
    }
    var priceCurrency = NormalizePriceCurrency(body.PriceCurrency);
    if (priceCurrency is null && !string.IsNullOrWhiteSpace(body.PriceCurrency))
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "priceCurrency 仅支持 CNY 或 USD"), jsonOptions, 400);
    }

    var modelFb = Builders<BsonDocument>.Filter;
    var modelFilters = new List<FilterDefinition<BsonDocument>>
    {
        modelFb.Or(
            modelFb.Eq("_id", modelId),
            modelFb.Eq("ModelName", modelId),
            modelFb.Eq("Name", modelId))
    };
    if (platformId.Length > 0) modelFilters.Add(modelFb.Eq("PlatformId", platformId));
    var modelFilter = modelFilters.Count == 1 ? modelFilters[0] : modelFb.And(modelFilters);
    var modelDoc = await gwModels.Find(TenantAccess.Filter(http, modelFilter)).FirstOrDefaultAsync()
                   ?? (TenantAccess.GetRequired(http).TenantId == internalTenantId
                       ? await models.Find(modelFilter).FirstOrDefaultAsync()
                       : null);
    if (modelDoc is null)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", $"模型不存在或平台不匹配：{modelId}"), jsonOptions, 400);
    }

    var resolvedPlatformId = platformId.Length > 0 ? platformId : modelDoc.GetStringOrEmpty("PlatformId");
    if (resolvedPlatformId.Length == 0)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", $"模型缺少 PlatformId：{modelId}"), jsonOptions, 400);
    }

    var platformFilter = Builders<BsonDocument>.Filter.Eq("_id", resolvedPlatformId);
    var platformDoc = await gwPlatforms.Find(TenantAccess.Filter(http, platformFilter)).FirstOrDefaultAsync()
                      ?? (TenantAccess.GetRequired(http).TenantId == internalTenantId
                          ? await platforms.Find(platformFilter).FirstOrDefaultAsync()
                          : null);
    if (platformDoc is null)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", $"平台不存在：{resolvedPlatformId}"), jsonOptions, 400);
    }

    var modelsArr = pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var members = modelsArr.Where(x => x.IsBsonDocument).Select(x => new BsonDocument(x.AsBsonDocument)).ToList();
    var existing = members.FirstOrDefault(m =>
        string.Equals(m.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal) &&
        string.Equals(m.GetStringOrEmpty("PlatformId"), resolvedPlatformId, StringComparison.Ordinal));
    var wasExisting = existing is not null;
    var member = existing is not null ? new BsonDocument(existing) : new BsonDocument
    {
        ["HealthStatus"] = 0,
        ["ConsecutiveFailures"] = 0,
        ["ConsecutiveSuccesses"] = 0,
    };
    member["ModelId"] = modelId;
    member["PlatformId"] = resolvedPlatformId;
    member["Priority"] = body.Priority ?? (existing?.AsNullableInt("Priority") ?? members.Count + 1);

    var protocol = body.Protocol?.Trim();
    if (string.IsNullOrWhiteSpace(protocol)) member.Remove("Protocol");
    else
    {
        if (protocol.Length > 80) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "protocol 长度超出限制"), jsonOptions, 400);
        member["Protocol"] = protocol;
    }

    if (body.EnablePromptCache is bool enablePromptCache) member["EnablePromptCache"] = enablePromptCache;
    else member.Remove("EnablePromptCache");
    if (body.MaxTokens is int maxTokens) member["MaxTokens"] = maxTokens;
    else member.Remove("MaxTokens");
    if (body.InputPricePerMillion is decimal inputPrice) member["InputPricePerMillion"] = new BsonDecimal128(inputPrice);
    else member.Remove("InputPricePerMillion");
    if (body.OutputPricePerMillion is decimal outputPrice) member["OutputPricePerMillion"] = new BsonDecimal128(outputPrice);
    else member.Remove("OutputPricePerMillion");
    if (body.PricePerCall is decimal pricePerCall) member["PricePerCall"] = new BsonDecimal128(pricePerCall);
    else member.Remove("PricePerCall");
    if (priceCurrency is not null) member["PriceCurrency"] = priceCurrency;
    else member.Remove("PriceCurrency");
    member["IsMain"] = modelDoc.AsNullableBool("IsMain") ?? false;
    member["IsIntent"] = modelDoc.AsNullableBool("IsIntent") ?? false;
    member["IsVision"] = modelDoc.AsNullableBool("IsVision") ?? false;
    member["IsImageGen"] = modelDoc.AsNullableBool("IsImageGen") ?? false;
    var capabilityDocs = modelDoc.TryGetValue("Capabilities", out var capsValue) && capsValue.IsBsonArray
        ? capsValue.AsBsonArray.Where(x => x.IsBsonDocument).Select(x => new BsonDocument(x.AsBsonDocument)).ToList()
        : new List<BsonDocument>();
    if (body.Capabilities is { Count: > 0 })
    {
        var byType = capabilityDocs
            .Where(c => !string.IsNullOrWhiteSpace(c.AsNullableString("Type")))
            .ToDictionary(c => c.AsNullableString("Type")!, c => new BsonDocument(c), StringComparer.OrdinalIgnoreCase);
        foreach (var capability in body.Capabilities)
        {
            if (capability is null) continue;
            var type = capability.Type.Trim();
            var source = string.IsNullOrWhiteSpace(capability.Source) ? "user" : capability.Source.Trim();
            if (type.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "capability.type 不能为空"), jsonOptions, 400);
            if (type.Length > 120) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "capability.type 长度超出限制"), jsonOptions, 400);
            if (source.Length > 40) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "capability.source 长度超出限制"), jsonOptions, 400);
            byType[type] = new BsonDocument
            {
                ["Type"] = type,
                ["Source"] = source,
                ["Value"] = capability.Value,
                ["UpdatedAt"] = DateTime.UtcNow,
            };
        }
        capabilityDocs = byType
            .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv => kv.Value)
            .ToList();
    }
    if (capabilityDocs.Count > 0) member["Capabilities"] = new BsonArray(capabilityDocs);
    else member.Remove("Capabilities");

    members = members
        .Where(m => !(string.Equals(m.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal) &&
                      string.Equals(m.GetStringOrEmpty("PlatformId"), resolvedPlatformId, StringComparison.Ordinal)))
        .Append(member)
        .OrderBy(m => m.AsNullableInt("Priority") ?? 100000)
        .ThenBy(m => m.GetStringOrEmpty("PlatformId"), StringComparer.Ordinal)
        .ThenBy(m => m.GetStringOrEmpty("ModelId"), StringComparer.Ordinal)
        .ToList();

    var nextModels = new BsonArray(members);
    var validationError = await ValidateDefaultGatewayPoolMembersAsync(
        gwPlatforms,
        gwModels,
        gwModelExchanges,
        pool,
        nextModels);
    if (validationError is not null)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", validationError), jsonOptions, 400);
    }

    await gwModelPools.UpdateOneAsync(poolFilter, Builders<BsonDocument>.Update
        .Set("Models", nextModels)
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: wasExisting ? "pool.model.update" : "pool.model.add",
        targetType: "llmgw_model_pool",
        targetId: id,
        targetName: pool.AsNullableString("Name") ?? pool.AsNullableString("Code"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "modelId", modelId },
            { "platformId", resolvedPlatformId },
            { "priority", member.AsNullableInt("Priority") ?? 0 },
            { "wasExisting", wasExisting },
            { "authority", "llm_gateway" },
        });

    var fresh = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型池成员删除：只允许从 GW 权威池删除；MAP 来源池必须先认领。
app.MapDelete("/gw/pools/{id}/models", async (HttpContext http, string id, string modelId, string? platformId) =>
{
    var normalizedModelId = (modelId ?? string.Empty).Trim();
    var normalizedPlatformId = (platformId ?? string.Empty).Trim();
    if (normalizedModelId.Length == 0) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelId 不能为空"), jsonOptions, 400);

    var poolFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var pool = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
    if (pool is null) return Json(ApiEnvelope<PoolItem>.Fail("NOT_GW_AUTHORITY", "请先将模型池认领到 GW，再在 GW 中管理池成员"), jsonOptions, 409);

    var modelsArr = pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var members = modelsArr.Where(x => x.IsBsonDocument).Select(x => new BsonDocument(x.AsBsonDocument)).ToList();
    var removed = members.Where(m =>
        string.Equals(m.GetStringOrEmpty("ModelId"), normalizedModelId, StringComparison.Ordinal) &&
        (normalizedPlatformId.Length == 0 || string.Equals(m.GetStringOrEmpty("PlatformId"), normalizedPlatformId, StringComparison.Ordinal))).ToList();
    if (removed.Count == 0)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池成员不存在：{normalizedModelId}"), jsonOptions, 404);
    }

    members = members.Except(removed).ToList();
    var nextModels = new BsonArray(members);
    var validationError = await ValidateDefaultGatewayPoolMembersAsync(
        gwPlatforms,
        gwModels,
        gwModelExchanges,
        pool,
        nextModels);
    if (validationError is not null)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", validationError), jsonOptions, 400);
    }

    await gwModelPools.UpdateOneAsync(poolFilter, Builders<BsonDocument>.Update
        .Set("Models", nextModels)
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.model.remove",
        targetType: "llmgw_model_pool",
        targetId: id,
        targetName: pool.AsNullableString("Name") ?? pool.AsNullableString("Code"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "modelId", normalizedModelId },
            { "platformId", normalizedPlatformId },
            { "removedCount", removed.Count },
            { "authority", "llm_gateway" },
        });

    var fresh = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型池默认标记：同一 ModelType 下将该池设为默认（互斥）。
// 非事务环境下的安全次序（Mongo 单实例无跨文档事务）：**先置本池为默认，再清同类型其它池**。
// 万一第二步失败，失败态是「同类型暂时两个默认」（MAP 调度仍能选到一个）——远好于「先清后置、第二步失败=零默认」（调度失去默认池）。
app.MapPut("/gw/pools/{id}/default", async (HttpContext http, string id, ToggleDefaultRequest body) =>
{
    // 缺 isDefault 字段一律拒绝。
    if (body?.IsDefault is not bool isDefault) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "缺少 isDefault 字段（true/false）"), jsonOptions, 400);
    // 本端点只支持「把某池设为默认」（isDefault=true）。不支持直接取消默认——否则一次调用就能把某 ModelType
    // 的唯一默认池清空，导致 MAP 调度该类型零默认（Bugbot Medium）。要切换默认：把另一个池设为默认即可，
    // 同类型互斥会自动取消原默认，全程始终有且仅有一个默认。
    if (!isDefault) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "不支持直接取消默认；如需切换，请把另一个同类型池设为默认（原默认会自动取消）"), jsonOptions, 400);
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var doc = await gwModelPools.Find(filter).FirstOrDefaultAsync();
    var targetPools = gwModelPools;
    var targetAuthority = "llm_gateway";
    if (doc is null)
    {
        if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
            return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池不存在：{id}"), jsonOptions, 404);
        doc = await modelGroups.Find(sourceFilter).FirstOrDefaultAsync();
        targetPools = modelGroups;
        targetAuthority = "map";
        filter = sourceFilter;
    }
    if (doc is null) return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池不存在：{id}"), jsonOptions, 404);
    var modelType = doc.GetStringOrEmpty("ModelType");
    if (targetAuthority == "llm_gateway"
        && !await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, doc))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "INVALID_INPUT",
            "默认 GW 模型池必须至少包含一个可解析、非 unavailable 的成员；请先添加 enabled 模型或 Exchange。"),
            jsonOptions,
            400);
    }
    // 非事务安全次序：先置本池为默认、再清同类型其它池。第二步万一失败是「暂时两个默认」（MAP 仍能选到一个），
    // 远好于「先清后置」失败=零默认。
    await targetPools.UpdateOneAsync(filter, Builders<BsonDocument>.Update.Set("IsDefaultForType", true).Set("UpdatedAt", DateTime.UtcNow));
    var fb = Builders<BsonDocument>.Filter;
    var others = fb.And(fb.Eq("ModelType", modelType), fb.Ne("_id", id));
    var scopedOthers = targetAuthority == "llm_gateway" ? TenantAccess.Filter(http, others) : others;
    var clearOthers = await targetPools.UpdateManyAsync(scopedOthers, Builders<BsonDocument>.Update.Set("IsDefaultForType", false).Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.set_default",
        targetType: targetAuthority == "llm_gateway" ? "llmgw_model_pool" : "model_group",
        targetId: id,
        targetName: doc.AsNullableString("Name") ?? doc.AsNullableString("Code"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "isDefaultForType", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableBool("IsDefaultForType")) }, { "to", true } } },
            { "modelType", modelType },
            { "authority", targetAuthority },
            { "clearedOtherDefaultCount", clearOthers.ModifiedCount },
        });
    var fresh = await targetPools.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型池认领：把 MAP 现有 model_groups 池复制到 GW 自有 llm_gateway.llmgw_model_pools。
// 这是模型池权威迁移的兼容切片：先双写/覆盖 GW 副本，resolver 命中 active appCaller 时优先读 GW 副本；
// 不删除 MAP 原池，回滚只需删除 GW 副本或把 appCaller 状态改回 configured/discovered。
app.MapPut("/gw/pools/{id}/claim", async (HttpContext http, string id) =>
{
    if (TenantAccess.GetRequired(http).TenantId != internalTenantId)
        return Json(ApiEnvelope<PoolItem>.Fail("INTERNAL_GOVERNANCE_ONLY", "仅内部租户可认领 MAP 模型池"), jsonOptions, 403);
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var source = await modelGroups.Find(sourceFilter).FirstOrDefaultAsync();
    if (source is null) return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池不存在：{id}"), jsonOptions, 404);

    var now = DateTime.UtcNow;
    var before = await gwModelPools.Find(filter).FirstOrDefaultAsync();
    var claimed = new BsonDocument(source);
    claimed["TenantId"] = internalTenantId;
    claimed["SourceCollection"] = "model_groups";
    claimed["Authority"] = "llm_gateway";
    claimed["ClaimedAt"] = now;
    claimed["UpdatedAt"] = now;

    await gwModelPools.ReplaceOneAsync(filter, claimed, new ReplaceOptions { IsUpsert = true });
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.claim_to_gateway",
        targetType: "llmgw_model_pool",
        targetId: id,
        targetName: source.AsNullableString("Name") ?? source.AsNullableString("Code"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "sourceCollection", "model_groups" },
            { "authority", "llm_gateway" },
            { "wasExistingGatewayPool", before is not null },
            { "modelType", source.AsNullableString("ModelType") ?? string.Empty },
        });

    var fresh = await gwModelPools.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.Run();


// ─────────────────────────────── 辅助函数 ───────────────────────────────

static TenantSessionDto ToTenantSession(LlmGwTenant tenant, LlmGwMembership membership) => new()
{
    Id = tenant.Id,
    Name = tenant.Name,
    Role = membership.Role,
    TeamIds = membership.TeamIds,
};

static async Task BackfillInternalTenantAsync(
    IMongoDatabase database,
    string tenantId,
    CancellationToken ct)
{
    var collections = new[]
    {
        "llmgw_app_callers",
        "llmgw_model_pools",
        "llmgw_platforms",
        "llmgw_models",
        "llmgw_model_exchanges",
        "llmgw_service_keys",
        "llmgw_service_key_rate_windows",
        "llmgw_prompt_policies",
        "llmrequestlogs",
        "llmshadow_comparisons",
        "llmgw_operation_audits",
        "llmgw_login_audits",
        "llmgw_lifecycle_runs",
        "llmgw_app_caller_rate_windows",
        "llmgw_budget_months",
        "llmgw_budget_reservations",
        "llmgw_request_executions",
        "llmgw_multipart_objects",
        "llmgw_provider_concurrency_slots",
        "llmgw_runtime_settings",
        "llmgw_asset_registry",
    };
    var missingTenant = Builders<BsonDocument>.Filter.Or(
        Builders<BsonDocument>.Filter.Exists("TenantId", false),
        Builders<BsonDocument>.Filter.Eq("TenantId", ""),
        Builders<BsonDocument>.Filter.Eq("TenantId", BsonNull.Value));

    foreach (var collectionName in collections)
    {
        await database.GetCollection<BsonDocument>(collectionName).UpdateManyAsync(
            missingTenant,
            Builders<BsonDocument>.Update.Set("TenantId", tenantId),
            cancellationToken: ct);
    }
}

static async Task EnsureInternalTenantAsync(
    IMongoCollection<LlmGwUser> users,
    IMongoCollection<LlmGwTenant> tenants,
    IMongoCollection<LlmGwTeam> teams,
    IMongoCollection<LlmGwMembership> memberships,
    string adminUsername,
    string tenantId,
    CancellationToken ct)
{
    var now = DateTime.UtcNow;
    var tenant = await tenants.Find(x => x.Id == tenantId).FirstOrDefaultAsync(ct);
    if (tenant is null)
    {
        tenant = new LlmGwTenant
        {
            Id = tenantId,
            Name = "MAP Internal",
            NormalizedName = "MAP INTERNAL",
            Slug = "map-internal",
            NormalizedSlug = "MAP-INTERNAL",
            Status = "active",
            IsInternal = true,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await tenants.InsertOneAsync(tenant, cancellationToken: ct);
    }

    var defaultTeamId = $"{tenantId}_default";
    if (!await teams.Find(x => x.Id == defaultTeamId && x.TenantId == tenantId).AnyAsync(ct))
    {
        await teams.InsertOneAsync(new LlmGwTeam
        {
            Id = defaultTeamId,
            TenantId = tenantId,
            Name = "Default",
            NormalizedName = "DEFAULT",
            Status = "active",
            CreatedAt = now,
            UpdatedAt = now,
        }, cancellationToken: ct);
    }

    var admin = await users.Find(x => x.Username == adminUsername).FirstOrDefaultAsync(ct)
        ?? throw new InvalidOperationException("LLM Gateway bootstrap admin 不存在，无法建立 internal tenant owner membership");
    var membership = await memberships.Find(x => x.TenantId == tenantId && x.UserId == admin.Id).FirstOrDefaultAsync(ct);
    if (membership is null)
    {
        await memberships.InsertOneAsync(new LlmGwMembership
        {
            TenantId = tenantId,
            UserId = admin.Id,
            Role = LlmGwTenantRoles.Owner,
            TeamIds = new List<string> { defaultTeamId },
            Status = "active",
            Version = 1,
            CreatedAt = now,
            UpdatedAt = now,
        }, cancellationToken: ct);
    }

    var userUpdate = Builders<LlmGwUser>.Update
        .AddToSet(x => x.TenantIds, tenantId)
        .Set(x => x.UpdatedAt, now);
    if (string.IsNullOrWhiteSpace(admin.DefaultTenantId))
        userUpdate = userUpdate.Set(x => x.DefaultTenantId, tenantId);
    await users.UpdateOneAsync(x => x.Id == admin.Id, userUpdate, cancellationToken: ct);

    await tenants.Indexes.CreateOneAsync(new CreateIndexModel<LlmGwTenant>(
        Builders<LlmGwTenant>.IndexKeys.Ascending(x => x.NormalizedSlug),
        new CreateIndexOptions { Name = "uniq_llmgw_tenant_slug", Unique = true }), cancellationToken: ct);
    await teams.Indexes.CreateOneAsync(new CreateIndexModel<LlmGwTeam>(
        Builders<LlmGwTeam>.IndexKeys.Ascending(x => x.TenantId).Ascending(x => x.NormalizedName),
        new CreateIndexOptions { Name = "uniq_llmgw_team_tenant_name", Unique = true }), cancellationToken: ct);
    await memberships.Indexes.CreateManyAsync(new[]
    {
        new CreateIndexModel<LlmGwMembership>(
            Builders<LlmGwMembership>.IndexKeys.Ascending(x => x.TenantId).Ascending(x => x.UserId),
            new CreateIndexOptions { Name = "uniq_llmgw_membership_tenant_user", Unique = true }),
        new CreateIndexModel<LlmGwMembership>(
            Builders<LlmGwMembership>.IndexKeys.Ascending(x => x.TenantId).Ascending(x => x.Status).Ascending(x => x.Role),
            new CreateIndexOptions { Name = "idx_llmgw_membership_tenant_status_role" }),
    }, cancellationToken: ct);
}

// 幂等播种管理员。优先级（从高到低）：
//   1) forceReset（LLMGW_ADMIN_FORCE_RESET=1）：破玻璃，显式重置 admin 口令 + 强制改密。
//   2) 已有账号：数据库哈希是长期权威，只保活，不再被 LLMGW_ADMIN_PASSWORD 覆盖。
//   3) 空库首次 bootstrap：用 LLMGW_ADMIN_PASSWORD；未设则内置 admin/admin + 首登强制改密。
static async Task SeedAdminAsync(
    IMongoDatabase db,
    IMongoCollection<BsonDocument> operationAudits,
    string username,
    string defaultPwd,
    string tenantId,
    bool forceReset = false,
    string? envPassword = null)
{
    var users = db.GetCollection<LlmGwUser>("llmgw_console_users");

    // 多租户账号由 membership 控制，不得在 bootstrap 时禁用其它租户用户。

    // 破玻璃优先级最高：显式打开时才改库中口令，用于账号被认领但口令丢失的死锁恢复。
    if (forceReset)
    {
        var resetPassword = string.IsNullOrWhiteSpace(envPassword) ? defaultPwd : envPassword.Trim();
        var resetHash = PasswordHasher.Hash(resetPassword);
        var resetMustChange = resetPassword == defaultPwd;
        var existingForce = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
        if (existingForce is not null)
        {
            await users.UpdateOneAsync(u => u.Username == username,
                Builders<LlmGwUser>.Update
                    .Set(u => u.PasswordHash, resetHash)
                    .Set(u => u.IsActive, true)
                    .Set(u => u.MustChangePassword, resetMustChange)
                    .Set(u => u.PasswordChangedByUser, false)
                    .Set(u => u.UpdatedAt, DateTime.UtcNow));
            await WriteSystemOperationAuditAsync(
                operationAudits,
                action: "admin.force_reset",
                targetType: "llmgw_console_user",
                targetId: existingForce.Id,
                targetName: username,
                success: true,
                reason: null,
                changes: new BsonDocument
                {
                    { "passwordSource", string.IsNullOrWhiteSpace(envPassword) ? "default" : "env" },
                    { "mustChangePassword", new BsonDocument { { "from", existingForce.MustChangePassword }, { "to", resetMustChange } } },
                    { "passwordChangedByUser", new BsonDocument { { "from", existingForce.PasswordChangedByUser }, { "to", false } } },
                    { "wasActive", existingForce.IsActive },
                },
                tenantId: tenantId);
        }
        else
        {
            var resetUser = new LlmGwUser
            {
                Username = username, PasswordHash = resetHash, DisplayName = username,
                IsActive = true, MustChangePassword = resetMustChange, PasswordChangedByUser = false,
                Scopes = new[] { "logs:read" }, CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            await users.InsertOneAsync(resetUser);
            await WriteSystemOperationAuditAsync(
                operationAudits,
                action: "admin.force_reset_bootstrap",
                targetType: "llmgw_console_user",
                targetId: resetUser.Id,
                targetName: username,
                success: true,
                reason: null,
                changes: new BsonDocument
                {
                    { "passwordSource", string.IsNullOrWhiteSpace(envPassword) ? "default" : "env" },
                    { "mustChangePassword", resetMustChange },
                },
                tenantId: tenantId);
        }
        return;
    }

    // 已有账号：数据库是长期权威。env 口令即便存在，也不能在每次启动覆盖已认领口令。
    var existing = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
    if (existing is not null)
    {
        if (!existing.IsActive)
        {
            await users.UpdateOneAsync(u => u.Username == username,
                Builders<LlmGwUser>.Update
                    .Set(u => u.IsActive, true)
                    .Set(u => u.UpdatedAt, DateTime.UtcNow));
            await WriteSystemOperationAuditAsync(
                operationAudits,
                action: "admin.reactivate",
                targetType: "llmgw_console_user",
                targetId: existing.Id,
                targetName: username,
                success: true,
                reason: null,
                changes: BuildChangeDocument(("isActive", false, true)),
                tenantId: tenantId);
        }
        return;
    }

    var bootstrapPassword = string.IsNullOrWhiteSpace(envPassword) ? defaultPwd : envPassword.Trim();
    var mustChange = bootstrapPassword == defaultPwd;
    var user = new LlmGwUser
    {
        Username = username,
        PasswordHash = PasswordHasher.Hash(bootstrapPassword),
        DisplayName = username,
        IsActive = true,
        MustChangePassword = mustChange,
        PasswordChangedByUser = false,
        Scopes = new[] { "logs:read" },
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
    };
    try
    {
        await users.InsertOneAsync(user);
        await WriteSystemOperationAuditAsync(
            operationAudits,
            action: "admin.bootstrap",
            targetType: "llmgw_console_user",
            targetId: user.Id,
            targetName: username,
            success: true,
            reason: null,
            changes: new BsonDocument
            {
                { "passwordSource", string.IsNullOrWhiteSpace(envPassword) ? "default" : "env" },
                { "mustChangePassword", mustChange },
            },
            tenantId: tenantId);
    }
    catch (MongoWriteException)
    {
        // 并发启动场景下可能撞唯一冲突/重复插入，忽略即可（幂等）。
    }
}

static async Task WriteLoginAuditAsync(
    IMongoCollection<LlmGwLoginAudit> audits,
    HttpContext http,
    string tenantId,
    string username,
    string? userId,
    bool success,
    string? reason)
{
    try
    {
        await audits.InsertOneAsync(new LlmGwLoginAudit
        {
            TenantId = tenantId,
            Username = username,
            UserId = userId,
            Success = success,
            Reason = reason,
            RemoteIp = GetClientIp(http),
            UserAgent = http.Request.Headers.UserAgent.ToString(),
            CreatedAt = DateTime.UtcNow,
        });
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[LlmGw] login audit write failed: {ex.Message}");
    }
}

static async Task WriteOperationAuditAsync(
    IMongoCollection<BsonDocument> audits,
    HttpContext http,
    string action,
    string targetType,
    string? targetId,
    string? targetName,
    bool success,
    string? reason,
    BsonDocument? changes = null)
{
    try
    {
        var actorUserId = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
            ?? http.User.FindFirst("sub")?.Value;
        var actorUsername = http.User.FindFirst(System.Security.Claims.ClaimTypes.Name)?.Value
            ?? http.User.Identity?.Name;
        var tenantAccess = http.Items.TryGetValue(TenantAccess.ItemKey, out var accessValue)
            ? accessValue as TenantAccessContext
            : null;

        var doc = new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") },
            { "TenantId", tenantAccess?.TenantId ?? http.User.FindFirst(TenantAccess.TenantClaim)?.Value ?? "tenant_map_internal" },
            { "TeamId", ToBsonAuditValue(tenantAccess?.TeamIds.Count == 1 ? tenantAccess.TeamIds[0] : null) },
            { "Action", action },
            { "TargetType", targetType },
            { "TargetId", ToBsonAuditValue(targetId) },
            { "TargetName", ToBsonAuditValue(targetName) },
            { "ActorUserId", ToBsonAuditValue(actorUserId) },
            { "ActorUsername", ToBsonAuditValue(actorUsername) },
            { "Success", success },
            { "Reason", ToBsonAuditValue(reason) },
            { "Changes", changes ?? new BsonDocument() },
            { "RemoteIp", ToBsonAuditValue(GetClientIp(http)) },
            { "UserAgent", ToBsonAuditValue(http.Request.Headers.UserAgent.ToString()) },
            { "CreatedAt", DateTime.UtcNow },
        };
        await audits.InsertOneAsync(doc);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[LlmGw] operation audit write failed: {ex.Message}");
    }
}

static async Task WriteSystemOperationAuditAsync(
    IMongoCollection<BsonDocument> audits,
    string action,
    string targetType,
    string? targetId,
    string? targetName,
    bool success,
    string? reason,
    BsonDocument? changes = null,
    string tenantId = "tenant_map_internal")
{
    try
    {
        var doc = new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") },
            { "TenantId", tenantId },
            { "TeamId", BsonNull.Value },
            { "Action", action },
            { "TargetType", targetType },
            { "TargetId", ToBsonAuditValue(targetId) },
            { "TargetName", ToBsonAuditValue(targetName) },
            { "ActorUserId", BsonNull.Value },
            { "ActorUsername", "system" },
            { "Success", success },
            { "Reason", ToBsonAuditValue(reason) },
            { "Changes", changes ?? new BsonDocument() },
            { "RemoteIp", BsonNull.Value },
            { "UserAgent", "startup" },
            { "CreatedAt", DateTime.UtcNow },
        };
        await audits.InsertOneAsync(doc);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[LlmGw] system operation audit write failed: {ex.Message}");
    }
}

static BsonDocument BuildChangeDocument(params (string Field, object? From, object? To)[] changes)
{
    var doc = new BsonDocument();
    foreach (var (field, from, to) in changes)
    {
        doc[field] = new BsonDocument
        {
            { "from", ToBsonAuditValue(from) },
            { "to", ToBsonAuditValue(to) },
        };
    }
    return doc;
}

static BsonValue ToBsonAuditValue(object? value)
{
    if (value is null) return BsonNull.Value;
    return BsonValue.Create(value);
}

static string NormalizeParameterPolicy(string value)
{
    var normalized = value.Trim().ToLowerInvariant();
    return normalized switch
    {
        "drop-unsupported" => "default-drop",
        "strict" => "strict-require",
        _ => normalized,
    };
}

static string? GetClientIp(HttpContext http)
{
    var forwardedFor = http.Request.Headers["X-Forwarded-For"].FirstOrDefault();
    if (!string.IsNullOrWhiteSpace(forwardedFor))
    {
        return forwardedFor.Split(',')[0].Trim();
    }
    return http.Connection.RemoteIpAddress?.ToString();
}

// 解析时间窗：from/to 缺省时默认最近 N 天。返回 [fromUtc, toUtc)。
static (DateTime From, DateTime To) ResolveRange(string? from, string? to, int defaultDays)
{
    DateTime? f = TryParseUtc(from);
    DateTime? t = TryParseUtc(to);
    var now = DateTime.UtcNow;
    var toUtc = t ?? now;
    var fromUtc = f ?? toUtc.AddDays(-defaultDays);
    return (fromUtc, toUtc);
}

static DateTime? TryParseUtc(string? s)
{
    if (string.IsNullOrWhiteSpace(s)) return null;
    if (DateTime.TryParse(
            s,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal,
            out var parsed))
    {
        return DateTime.SpecifyKind(parsed, DateTimeKind.Utc);
    }
    return null;
}

// 构建 StartedAt 时间窗 + OpenRouter Activity 风格筛选器。
static FilterDefinition<BsonDocument> BuildFilter(
    DateTime fromUtc,
    DateTime toUtc,
    string? model,
    string? status,
    string? provider,
    string? appCallerCode,
    string? transport,
    string? requestType,
    string? sourceSystem,
    string? ingressProtocol,
    string? modelPolicy,
    string? releaseCommit,
    string? runId,
    string? requestId,
    string? sessionId)
{
    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>
    {
        fb.Gte("StartedAt", fromUtc),
        fb.Lt("StartedAt", toUtc),
    };
    if (!string.IsNullOrWhiteSpace(model)) filters.Add(fb.Eq("Model", model));
    if (!string.IsNullOrWhiteSpace(status)) filters.Add(fb.Eq("Status", status));
    if (!string.IsNullOrWhiteSpace(provider)) filters.Add(fb.Eq("Provider", provider));
    if (!string.IsNullOrWhiteSpace(appCallerCode)) filters.Add(fb.Eq("AppCallerCode", appCallerCode));
    if (!string.IsNullOrWhiteSpace(transport)) filters.Add(fb.Eq("GatewayTransport", transport));
    if (!string.IsNullOrWhiteSpace(requestType)) filters.Add(fb.Eq("RequestType", requestType));
    if (!string.IsNullOrWhiteSpace(sourceSystem)) filters.Add(fb.Eq("SourceSystem", sourceSystem));
    if (!string.IsNullOrWhiteSpace(ingressProtocol)) filters.Add(fb.Eq("IngressProtocol", ingressProtocol));
    if (!string.IsNullOrWhiteSpace(modelPolicy)) filters.Add(fb.Eq("ModelPolicy", modelPolicy));
    if (!string.IsNullOrWhiteSpace(runId)) filters.Add(fb.Eq("RunId", runId.Trim()));
    if (!string.IsNullOrWhiteSpace(requestId)) filters.Add(fb.Eq("RequestId", requestId.Trim()));
    if (!string.IsNullOrWhiteSpace(sessionId)) filters.Add(fb.Eq("SessionId", sessionId.Trim()));
    var normalizedReleaseCommit = NormalizeCommitFilter(releaseCommit);
    if (normalizedReleaseCommit is not null) filters.Add(fb.Eq("ReleaseCommit", normalizedReleaseCommit));
    return fb.And(filters);
}

static List<string> NormalizeDistinct(IEnumerable<string?> values, int limit) =>
    values
        .Where(v => !string.IsNullOrWhiteSpace(v))
        .Select(v => v!.Trim())
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .OrderBy(v => v, StringComparer.OrdinalIgnoreCase)
        .Take(limit)
        .ToList();

static List<LogsBucketItem> BuildBucket(IEnumerable<BsonDocument> docs, string field, string fallbackKey) =>
    docs.Select(d => d.AsNullableString(field))
        .Select(v => string.IsNullOrWhiteSpace(v) ? fallbackKey : v!.Trim())
        .GroupBy(v => v, StringComparer.OrdinalIgnoreCase)
        .Select(g => new LogsBucketItem { Key = g.Key, Count = g.LongCount() })
        .OrderByDescending(x => x.Count)
        .ThenBy(x => x.Key, StringComparer.OrdinalIgnoreCase)
        .ToList();

static IReadOnlyList<(string Key, string Label)> TargetIngressProtocols() => new[]
{
    ("gw-native", "GW Native"),
    ("openai-compatible", "OpenAI-compatible"),
    ("claude-compatible", "Claude-compatible"),
    ("gemini-compatible", "Gemini-compatible"),
};

static string NormalizeIngressProtocol(string? value)
{
    if (string.IsNullOrWhiteSpace(value)) return "unknown";
    var normalized = value.Trim().ToLowerInvariant().Replace('_', '-');
    return normalized switch
    {
        "native" or "gw" or "gateway-native" => "gw-native",
        "openai" or "openai-compatible" or "openai-chat" => "openai-compatible",
        "claude" or "anthropic" or "anthropic-compatible" => "claude-compatible",
        "gemini" or "google" or "google-compatible" => "gemini-compatible",
        _ => normalized,
    };
}

static List<string> GetObservedIngressProtocols(BsonDocument doc)
{
    var values = new List<string>();
    if (doc.TryGetValue("ObservedIngressProtocols", out var observed) && observed.IsBsonArray)
    {
        values.AddRange(observed.AsBsonArray
            .Where(x => x.IsString)
            .Select(x => NormalizeIngressProtocol(x.AsString)));
    }

    var legacy = NormalizeIngressProtocol(doc.AsNullableString("IngressProtocol"));
    if (legacy != "unknown") values.Add(legacy);
    return values
        .Where(x => !string.IsNullOrWhiteSpace(x) && x != "unknown")
        .Distinct(StringComparer.Ordinal)
        .OrderBy(x => x, StringComparer.Ordinal)
        .ToList();
}

static bool IsRuntimeGovernedAppCallerStatus(string? value)
{
    var normalized = string.IsNullOrWhiteSpace(value) ? "discovered" : value.Trim().ToLowerInvariant();
    return normalized is "active" or "configured";
}

static bool HasDroppedParameters(BsonDocument doc)
{
    if (!doc.TryGetValue("DroppedParameters", out var value) || value.IsBsonNull) return false;
    if (value.IsBsonArray) return value.AsBsonArray.Count > 0;
    if (value.IsString) return !string.IsNullOrWhiteSpace(value.AsString);
    return false;
}

static LlmLogListItem MapListItem(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    RequestId = d.GetStringOrEmpty("RequestId"),
    ReleaseCommit = d.AsNullableString("ReleaseCommit"),
    Provider = d.GetStringOrEmpty("Provider"),
    Model = d.GetStringOrEmpty("Model"),
    PlatformId = d.AsNullableString("PlatformId"),
    PlatformName = d.AsNullableString("PlatformName"),
    GroupId = d.AsNullableString("GroupId"),
    SessionId = d.AsNullableString("SessionId"),
    RunId = d.AsNullableString("RunId"),
    UserId = d.AsNullableString("UserId"),
    Username = null,
    DisplayName = null,
    RequestType = d.AsNullableString("RequestType"),
    AppCallerCode = d.AsNullableString("AppCallerCode"),
    AppCallerCodeDisplayName = d.AsNullableString("AppCallerCodeDisplayName"),
    AppCallerTitle = d.AsNullableString("AppCallerTitle"),
    SourceSystem = d.AsNullableString("SourceSystem"),
    IngressProtocol = d.AsNullableString("IngressProtocol"),
    Status = d.GetStringOrEmpty("Status"),
    StartedAt = d.AsNullableUtcDateTime("StartedAt").ToIso(),
    FirstByteAt = d.AsNullableUtcDateTime("FirstByteAt").ToIso(),
    EndedAt = d.AsNullableUtcDateTime("EndedAt").ToIso(),
    DurationMs = d.AsNullableLong("DurationMs"),
    StatusCode = d.AsNullableInt("StatusCode"),
    InputTokens = d.AsNullableInt("InputTokens"),
    OutputTokens = d.AsNullableInt("OutputTokens"),
    EstimatedCost = d.AsNullableDecimal("EstimatedCost"),
    EstimatedCostCurrency = d.AsNullableString("EstimatedCostCurrency"),
    EstimatedCostUsd = d.AsNullableDecimal("EstimatedCostUsd"),
    Error = d.AsNullableString("Error"),
    IsFallback = d.AsNullableBool("IsFallback"),
    ExpectedModel = d.AsNullableString("ExpectedModel"),
    Protocol = d.AsNullableString("Protocol"),
    ResolutionReason = d.AsNullableString("ResolutionReason"),
    Transport = d.AsNullableString("GatewayTransport"),
    ModelPolicy = d.AsNullableString("ModelPolicy"),
    ModelPoolId = d.AsNullableString("ModelPoolId"),
    ToolCallCount = d.AsNullableInt("ToolCallCount"),
    FinishReason = d.AsNullableString("FinishReason"),
    IsStreaming = d.AsNullableBool("IsStreaming"),
};

static LlmLogDetail MapDetail(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    RequestId = d.GetStringOrEmpty("RequestId"),
    ReleaseCommit = d.AsNullableString("ReleaseCommit"),
    GroupId = d.AsNullableString("GroupId"),
    SessionId = d.AsNullableString("SessionId"),
    RunId = d.AsNullableString("RunId"),
    UserId = d.AsNullableString("UserId"),
    RequestType = d.AsNullableString("RequestType"),
    AppCallerCode = d.AsNullableString("AppCallerCode"),
    AppCallerCodeDisplayName = d.AsNullableString("AppCallerCodeDisplayName"),
    AppCallerTitle = d.AsNullableString("AppCallerTitle"),
    SourceSystem = d.AsNullableString("SourceSystem"),
    IngressProtocol = d.AsNullableString("IngressProtocol"),
    Provider = d.GetStringOrEmpty("Provider"),
    Model = d.GetStringOrEmpty("Model"),
    RequestBodyRedacted = d.AsNullableString("RequestBodyRedacted"),
    SystemPromptText = d.AsNullableString("SystemPromptText"),
    PromptPolicyId = d.AsNullableString("PromptPolicyId"),
    PromptPolicyVersion = d.AsNullableInt("PromptPolicyVersion"),
    PromptPolicyHash = d.AsNullableString("PromptPolicyHash"),
    PromptPolicyChars = d.AsNullableInt("PromptPolicyChars"),
    QuestionText = d.AsNullableString("QuestionText"),
    AnswerText = d.AsNullableString("AnswerText"),
    ThinkingText = d.AsNullableString("ThinkingText"),
    ResponseToolCalls = d.AsNullableString("ResponseToolCalls"),
    ToolCallCount = d.AsNullableInt("ToolCallCount"),
    InputTokens = d.AsNullableInt("InputTokens"),
    OutputTokens = d.AsNullableInt("OutputTokens"),
    InputPricePerMillion = d.AsNullableDecimal("InputPricePerMillion"),
    OutputPricePerMillion = d.AsNullableDecimal("OutputPricePerMillion"),
    PricePerCall = d.AsNullableDecimal("PricePerCall"),
    PriceCurrency = d.AsNullableString("PriceCurrency"),
    EstimatedInputCost = d.AsNullableDecimal("EstimatedInputCost"),
    EstimatedOutputCost = d.AsNullableDecimal("EstimatedOutputCost"),
    EstimatedCallCost = d.AsNullableDecimal("EstimatedCallCost"),
    EstimatedCost = d.AsNullableDecimal("EstimatedCost"),
    EstimatedCostCurrency = d.AsNullableString("EstimatedCostCurrency"),
    EstimatedCostUsd = d.AsNullableDecimal("EstimatedCostUsd"),
    StartedAt = d.AsNullableUtcDateTime("StartedAt").ToIso(),
    FirstByteAt = d.AsNullableUtcDateTime("FirstByteAt").ToIso(),
    EndedAt = d.AsNullableUtcDateTime("EndedAt").ToIso(),
    DurationMs = d.AsNullableLong("DurationMs"),
    Status = d.GetStringOrEmpty("Status"),
    StatusCode = d.AsNullableInt("StatusCode"),
    IsFallback = d.AsNullableBool("IsFallback"),
    FallbackReason = d.AsNullableString("FallbackReason"),
    PlatformId = d.AsNullableString("PlatformId"),
    PlatformName = d.AsNullableString("PlatformName"),
    ModelResolutionType = d.AsNullableString("ModelResolutionType"),
    ModelGroupId = d.AsNullableString("ModelGroupId"),
    ModelGroupName = d.AsNullableString("ModelGroupName"),
    ExpectedModel = d.AsNullableString("ExpectedModel"),
    Protocol = d.AsNullableString("Protocol"),
    ResolutionReason = d.AsNullableString("ResolutionReason"),
    Transport = d.AsNullableString("GatewayTransport"),
    ModelPolicy = d.AsNullableString("ModelPolicy"),
    ModelPoolId = d.AsNullableString("ModelPoolId"),
    ParameterPolicy = d.AsNullableString("ParameterPolicy"),
    DroppedParameters = d.AsStringList("DroppedParameters"),
    ProviderAttempts = MapProviderAttempts(d),
    RouterTrace = BuildRouterTrace(d),
    FinishReason = d.AsNullableString("FinishReason"),
    IsStreaming = d.AsNullableBool("IsStreaming"),
    Error = d.AsNullableString("Error"),
};

static RouterTraceDto BuildRouterTrace(BsonDocument d)
{
    var mode = NormalizeResolutionMode(d.AsNullableString("ModelResolutionType"), d.AsNullableString("ResolutionReason"));
    var requestedModel = d.AsNullableString("ExpectedModel");
    var actualModel = d.AsNullableString("Model");
    var groupId = d.AsNullableString("ModelGroupId") ?? d.AsNullableString("GroupId");
    var groupName = d.AsNullableString("ModelGroupName");
    var platformId = d.AsNullableString("PlatformId");
    var platformName = d.AsNullableString("PlatformName");
    var provider = d.AsNullableString("Provider");
    var protocol = d.AsNullableString("Protocol");
    var transport = d.AsNullableString("GatewayTransport");
    var sourceSystem = d.AsNullableString("SourceSystem");
    var ingressProtocol = d.AsNullableString("IngressProtocol");
    var runId = d.AsNullableString("RunId");
    var modelPolicy = d.AsNullableString("ModelPolicy");
    var modelPoolId = d.AsNullableString("ModelPoolId");
    var parameterPolicy = d.AsNullableString("ParameterPolicy");
    var droppedParameters = d.AsStringList("DroppedParameters");
    var isFallback = d.AsNullableBool("IsFallback") == true;
    var fallbackReason = d.AsNullableString("FallbackReason");
    var resolutionReason = d.AsNullableString("ResolutionReason");

    var steps = new List<RouterTraceStepDto>();
    void Add(string stage, string label, string? value, string status = "info")
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        steps.Add(new RouterTraceStepDto
        {
            Order = steps.Count + 1,
            Stage = stage,
            Label = label,
            Value = value,
            Status = status,
        });
    }

    Add("ingress", "source", sourceSystem);
    Add("ingress", "protocol", ingressProtocol);
    Add("ingress", "run", runId);
    Add("ingress", "appCaller", d.AsNullableString("AppCallerCode") ?? d.AsNullableString("AppCallerCodeDisplayName") ?? d.AsNullableString("AppCallerTitle"));
    Add("ingress", "request type", d.AsNullableString("RequestType"));
    Add("policy", "model policy", modelPolicy ?? mode);
    Add("policy", "requested model", requestedModel);
    Add("pool", "requested pool", modelPoolId);
    Add("pool", "model pool", !string.IsNullOrWhiteSpace(groupName) && !string.IsNullOrWhiteSpace(groupId) ? $"{groupName} ({groupId})" : groupName ?? groupId);
    Add("provider", "provider", provider);
    Add("provider", "platform", !string.IsNullOrWhiteSpace(platformName) && !string.IsNullOrWhiteSpace(platformId) ? $"{platformName} ({platformId})" : platformName ?? platformId);
    Add("provider", "actual model", actualModel);
    Add("provider", "protocol", protocol);
    Add("transport", "transport", transport);
    Add("policy", "resolution reason", resolutionReason);
    if (isFallback) Add("fallback", "fallback", fallbackReason ?? "fallback=true", "warning");
    Add("parameters", "parameter policy", parameterPolicy);
    if (droppedParameters.Count > 0) Add("parameters", "dropped parameters", string.Join(", ", droppedParameters), "warning");

    var attempts = MapProviderAttempts(d);
    return new RouterTraceDto
    {
        Mode = mode,
        RequestedModel = requestedModel,
        ActualModel = actualModel,
        ModelGroupId = groupId,
        ModelGroupName = groupName,
        Provider = provider,
        PlatformId = platformId,
        PlatformName = platformName,
        Protocol = protocol,
        Transport = transport,
        SourceSystem = sourceSystem,
        IngressProtocol = ingressProtocol,
        RunId = runId,
        ModelPolicy = modelPolicy,
        ModelPoolId = modelPoolId,
        IsFallback = isFallback,
        FallbackReason = fallbackReason,
        ResolutionReason = resolutionReason,
        ParameterPolicy = parameterPolicy,
        DroppedParameters = droppedParameters,
        Steps = steps,
    };
}

static List<ProviderAttemptDto> MapProviderAttempts(BsonDocument d)
{
    if (!d.TryGetValue("ProviderAttempts", out var value) || !value.IsBsonArray)
        return BuildFallbackProviderAttempts(d);

    var attempts = value.AsBsonArray
        .Where(x => x.IsBsonDocument)
        .Select(x =>
        {
            var doc = x.AsBsonDocument;
            return new ProviderAttemptDto
            {
                Order = doc.AsNullableInt("Order") ?? 0,
                Stage = doc.AsNullableString("Stage") ?? "send",
                Provider = doc.AsNullableString("Provider"),
                PlatformId = doc.AsNullableString("PlatformId"),
                PlatformName = doc.AsNullableString("PlatformName"),
                Model = doc.AsNullableString("Model"),
                ModelGroupId = doc.AsNullableString("ModelGroupId"),
                ModelGroupName = doc.AsNullableString("ModelGroupName"),
                Protocol = doc.AsNullableString("Protocol"),
                Transport = doc.AsNullableString("Transport"),
                Status = doc.AsNullableString("Status") ?? "selected",
                Reason = doc.AsNullableString("Reason"),
                StatusCode = doc.AsNullableInt("StatusCode"),
                DurationMs = doc.AsNullableLong("DurationMs"),
                Error = doc.AsNullableString("Error"),
                EndedAt = doc.AsNullableUtcDateTime("EndedAt").ToIso(),
            };
        })
        .Where(x => !string.IsNullOrWhiteSpace(x.Model) || !string.IsNullOrWhiteSpace(x.Provider))
        .OrderBy(x => x.Order <= 0 ? int.MaxValue : x.Order)
        .ToList();

    for (var i = 0; i < attempts.Count; i++)
    {
        if (attempts[i].Order <= 0) attempts[i].Order = i + 1;
    }
    return attempts.Count > 0 ? attempts : BuildFallbackProviderAttempts(d);
}

static List<ProviderAttemptDto> BuildFallbackProviderAttempts(BsonDocument d)
{
    var model = d.AsNullableString("Model");
    var provider = d.AsNullableString("Provider");
    if (string.IsNullOrWhiteSpace(model) && string.IsNullOrWhiteSpace(provider))
        return new List<ProviderAttemptDto>();

    return new List<ProviderAttemptDto>
    {
        new()
        {
            Order = 1,
            Stage = "send",
            Provider = provider,
            PlatformId = d.AsNullableString("PlatformId"),
            PlatformName = d.AsNullableString("PlatformName"),
            Model = model,
            ModelGroupId = d.AsNullableString("ModelGroupId") ?? d.AsNullableString("GroupId"),
            ModelGroupName = d.AsNullableString("ModelGroupName"),
            Protocol = d.AsNullableString("Protocol"),
            Transport = d.AsNullableString("GatewayTransport"),
            Status = d.AsNullableString("Status") == "failed" ? "failed" : "sent",
            Reason = d.AsNullableString("FallbackReason") ?? d.AsNullableString("ResolutionReason"),
            StatusCode = d.AsNullableInt("StatusCode"),
            DurationMs = d.AsNullableLong("DurationMs"),
            Error = d.AsNullableString("Error"),
            EndedAt = d.AsNullableUtcDateTime("EndedAt").ToIso(),
        }
    };
}

static string? NormalizeResolutionMode(string? raw, string? reason)
{
    var value = raw?.Trim();
    if (string.IsNullOrWhiteSpace(value))
    {
        if (!string.IsNullOrWhiteSpace(reason) && reason.Contains("pinned", StringComparison.OrdinalIgnoreCase))
            return "pinned";
        return null;
    }

    if (int.TryParse(value, out var numeric))
    {
        return numeric switch
        {
            0 => "direct",
            1 => "default-pool",
            2 => "dedicated-pool",
            3 => "legacy",
            _ => value,
        };
    }

    return value switch
    {
        "DirectModel" => "direct",
        "DefaultPool" => "default-pool",
        "DedicatedPool" => "dedicated-pool",
        "GatewayRegistryPool" => "gateway-registry-pool",
        "PinnedModel" => "pinned",
        "Legacy" => "legacy",
        "LegacyConfig" => "legacy-config",
        _ => value,
    };
}

// 把一个会话内的多条日志聚合成 SessionItem。primaryModel = 出现次数最多的 Model。
static SessionItem BuildSessionItem(string sessionId, List<BsonDocument> docs)
{
    var models = docs
        .Select(x => x.GetStringOrEmpty("Model"))
        .Where(m => !string.IsNullOrEmpty(m))
        .ToList();

    var modelCounts = models
        .GroupBy(m => m)
        .Select(g => new { Model = g.Key, Count = g.Count() })
        .OrderByDescending(g => g.Count)
        .ToList();

    var primaryModel = modelCounts.FirstOrDefault()?.Model;
    var supporting = modelCounts.Skip(1).Select(g => g.Model).Distinct().ToList();

    // primaryProvider：取 primaryModel 对应的第一条 provider；否则首条非空 provider。
    string? primaryProvider = null;
    if (primaryModel is not null)
    {
        primaryProvider = docs
            .Where(x => x.GetStringOrEmpty("Model") == primaryModel)
            .Select(x => x.AsNullableString("Provider"))
            .FirstOrDefault(p => !string.IsNullOrEmpty(p));
    }
    primaryProvider ??= docs.Select(x => x.AsNullableString("Provider")).FirstOrDefault(p => !string.IsNullOrEmpty(p));

    var appCaller = docs
        .Select(x => x.AsNullableString("AppCallerCode"))
        .FirstOrDefault(a => !string.IsNullOrEmpty(a));

    var starts = docs.Select(x => x.AsNullableUtcDateTime("StartedAt")).Where(t => t is not null).Select(t => t!.Value).ToList();
    DateTime? start = starts.Count > 0 ? starts.Min() : null;

    var ends = docs
        .Select(x => x.AsNullableUtcDateTime("EndedAt") ?? x.AsNullableUtcDateTime("StartedAt"))
        .Where(t => t is not null).Select(t => t!.Value).ToList();
    DateTime? end = ends.Count > 0 ? ends.Max() : null;

    return new SessionItem
    {
        SessionId = sessionId,
        RequestCount = docs.Count,
        Start = start.ToIso(),
        End = end.ToIso(),
        AppCallerCode = appCaller,
        PrimaryModel = primaryModel,
        PrimaryProvider = primaryProvider,
        SupportingModels = supporting,
    };
}

// ─────────────── 配置面只读映射（BsonDocument 安全读取，密钥永不进 DTO）───────────────

static string HealthLabel(int s) => s switch { 0 => "Healthy", 1 => "Degraded", 2 => "Unavailable", _ => "Unknown" };

static string? NormalizePriceCurrency(string? currency)
{
    var normalized = currency?.Trim().ToUpperInvariant();
    return normalized is "CNY" or "USD" ? normalized : null;
}

static BsonDocument BuildPoolMemberFromModel(BsonDocument modelDoc, string modelId, string platformId, int priority, BsonDocument? existing)
{
    var member = existing is not null ? new BsonDocument(existing) : new BsonDocument
    {
        ["HealthStatus"] = 0,
        ["ConsecutiveFailures"] = 0,
        ["ConsecutiveSuccesses"] = 0,
    };
    member["ModelId"] = modelId;
    member["PlatformId"] = platformId;
    member["Priority"] = priority;

    var protocol = modelDoc.AsNullableString("Protocol");
    if (string.IsNullOrWhiteSpace(protocol)) member.Remove("Protocol");
    else member["Protocol"] = protocol.Trim();

    if (modelDoc.AsNullableBool("EnablePromptCache") is bool enablePromptCache) member["EnablePromptCache"] = enablePromptCache;
    else member.Remove("EnablePromptCache");
    if (modelDoc.AsNullableInt("MaxTokens") is int maxTokens) member["MaxTokens"] = maxTokens;
    else member.Remove("MaxTokens");
    if (modelDoc.AsNullableDecimal("InputPricePerMillion") is decimal inputPrice) member["InputPricePerMillion"] = new BsonDecimal128(inputPrice);
    else member.Remove("InputPricePerMillion");
    if (modelDoc.AsNullableDecimal("OutputPricePerMillion") is decimal outputPrice) member["OutputPricePerMillion"] = new BsonDecimal128(outputPrice);
    else member.Remove("OutputPricePerMillion");
    if (modelDoc.AsNullableDecimal("PricePerCall") is decimal pricePerCall) member["PricePerCall"] = new BsonDecimal128(pricePerCall);
    else member.Remove("PricePerCall");
    if (NormalizePriceCurrency(modelDoc.AsNullableString("PriceCurrency")) is string priceCurrency) member["PriceCurrency"] = priceCurrency;
    else member.Remove("PriceCurrency");

    member["IsMain"] = modelDoc.AsNullableBool("IsMain") ?? false;
    member["IsIntent"] = modelDoc.AsNullableBool("IsIntent") ?? false;
    member["IsVision"] = modelDoc.AsNullableBool("IsVision") ?? false;
    member["IsImageGen"] = modelDoc.AsNullableBool("IsImageGen") ?? false;
    var capabilityDocs = modelDoc.TryGetValue("Capabilities", out var capsValue) && capsValue.IsBsonArray
        ? capsValue.AsBsonArray.Where(x => x.IsBsonDocument).Select(x => new BsonDocument(x.AsBsonDocument)).ToList()
        : new List<BsonDocument>();
    if (capabilityDocs.Count > 0) member["Capabilities"] = new BsonArray(capabilityDocs);
    else member.Remove("Capabilities");
    return member;
}

static bool DoesModelMatchBulkImportFilter(BsonDocument modelDoc, string poolModelType, string capabilityFilter)
{
    if (capabilityFilter == "all") return true;
    if (capabilityFilter == "compatible") return IsModelCompatibleWithPool(modelDoc, poolModelType);
    if (capabilityFilter == "vision") return modelDoc.AsNullableBool("IsVision") == true || ModelHasCapability(modelDoc, "vision", "image_input", "multimodal");
    if (capabilityFilter == "image") return modelDoc.AsNullableBool("IsImageGen") == true || ModelHasCapability(modelDoc, "image_generation", "text_to_image", "image");
    if (capabilityFilter == "function_calling") return ModelHasCapability(modelDoc, "function_calling", "tool_calling", "tools");
    if (capabilityFilter == "parallel_tool_calls") return ModelHasCapability(modelDoc, "parallel_tool_calls", "parallel_tools", "parallel_function_calling");
    if (capabilityFilter == "parameter_capabilities") return ModelHasParameterCapability(modelDoc);
    if (capabilityFilter == "thinking") return ModelHasCapability(modelDoc, "thinking", "reasoning");
    if (capabilityFilter == "structured_output") return ModelHasCapability(modelDoc, "structured_output", "json_schema", "json_mode", "response_format");
    if (capabilityFilter == "logprobs") return ModelHasCapability(modelDoc, "logprobs", "top_logprobs", "token_logprobs");
    if (capabilityFilter == "prompt_cache") return modelDoc.AsNullableBool("EnablePromptCache") == true || ModelHasCapability(modelDoc, "prompt_cache", "prompt_caching");
    return false;
}

static bool IsModelCompatibleWithPool(BsonDocument modelDoc, string poolModelType)
{
    var type = (poolModelType ?? string.Empty).ToLowerInvariant();
    if (type.Contains("vision")) return modelDoc.AsNullableBool("IsVision") == true || ModelHasCapability(modelDoc, "vision", "image_input", "multimodal");
    if (type.Contains("image") || type.Contains("generation")) return modelDoc.AsNullableBool("IsImageGen") == true || ModelHasCapability(modelDoc, "image_generation", "text_to_image", "image");
    if (type.Contains("intent")) return modelDoc.AsNullableBool("IsIntent") == true || modelDoc.AsNullableBool("IsMain") == true;
    if (type.Contains("chat") || type.Contains("code")) return modelDoc.AsNullableBool("IsMain") == true || modelDoc.AsNullableBool("IsIntent") == true || modelDoc.AsNullableBool("IsImageGen") != true;
    if (type.Contains("asr") || type.Contains("speech")) return ModelHasCapability(modelDoc, "asr", "speech_to_text", "audio");
    if (type.Contains("video")) return ModelHasCapability(modelDoc, "video_generation", "video");
    return true;
}

static bool ModelHasCapability(BsonDocument modelDoc, params string[] types)
{
    var wanted = types.Select(x => x.ToLowerInvariant()).ToHashSet(StringComparer.OrdinalIgnoreCase);
    var capsArr = modelDoc.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray ? cv.AsBsonArray : new BsonArray();
    return capsArr
        .Where(x => x.IsBsonDocument)
        .Select(x => x.AsBsonDocument)
        .Any(c => c.AsNullableBool("Value") == true && wanted.Contains(c.GetStringOrEmpty("Type")));
}

static bool ModelHasParameterCapability(BsonDocument modelDoc)
{
    var capsArr = modelDoc.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray ? cv.AsBsonArray : new BsonArray();
    return capsArr
        .Where(x => x.IsBsonDocument)
        .Select(x => x.AsBsonDocument.GetStringOrEmpty("Type"))
        .Any(type => type.StartsWith("parameter:", StringComparison.OrdinalIgnoreCase));
}

static PoolItem MapPool(BsonDocument d)
{
    var modelsArr = d.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var items = new List<PoolModelItem>();
    foreach (var m in modelsArr)
    {
        if (!m.IsBsonDocument) continue;
        var md = m.AsBsonDocument;
        var hs = md.AsNullableInt("HealthStatus") ?? 0;
        var capsArr = md.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray ? cv.AsBsonArray : new BsonArray();
        var caps = capsArr.Where(c => c.IsBsonDocument).Select(c => c.AsBsonDocument).Select(c => new ModelCapabilityItem
        {
            Type = c.GetStringOrEmpty("Type"),
            Source = c.GetStringOrEmpty("Source"),
            Value = c.AsNullableBool("Value") ?? false,
        }).ToList();
        items.Add(new PoolModelItem
        {
            ModelId = md.GetStringOrEmpty("ModelId"),
            PlatformId = md.GetStringOrEmpty("PlatformId"),
            Priority = md.AsNullableInt("Priority") ?? 0,
            Protocol = md.AsNullableString("Protocol"),
            HealthStatus = hs,
            HealthStatusLabel = HealthLabel(hs),
            LastFailedAt = md.AsNullableUtcDateTime("LastFailedAt").ToIso(),
            LastSuccessAt = md.AsNullableUtcDateTime("LastSuccessAt").ToIso(),
            ConsecutiveFailures = md.AsNullableInt("ConsecutiveFailures") ?? 0,
            ConsecutiveSuccesses = md.AsNullableInt("ConsecutiveSuccesses") ?? 0,
            EnablePromptCache = md.AsNullableBool("EnablePromptCache"),
            MaxTokens = md.AsNullableInt("MaxTokens"),
            IsMain = md.AsNullableBool("IsMain") ?? false,
            IsIntent = md.AsNullableBool("IsIntent") ?? false,
            IsVision = md.AsNullableBool("IsVision") ?? false,
            IsImageGen = md.AsNullableBool("IsImageGen") ?? false,
            Capabilities = caps,
            InputPricePerMillion = md.AsNullableDecimal("InputPricePerMillion"),
            OutputPricePerMillion = md.AsNullableDecimal("OutputPricePerMillion"),
            PricePerCall = md.AsNullableDecimal("PricePerCall"),
            PriceCurrency = md.AsNullableString("PriceCurrency"),
        });
    }
    return new PoolItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Name = d.GetStringOrEmpty("Name"),
        Code = d.GetStringOrEmpty("Code"),
        Priority = d.AsNullableInt("Priority") ?? 50,
        ModelType = d.GetStringOrEmpty("ModelType"),
        IsDefaultForType = d.AsNullableBool("IsDefaultForType") ?? false,
        StrategyType = d.AsNullableInt("StrategyType") ?? 0,
        Description = d.AsNullableString("Description"),
        SourceCollection = d.AsNullableString("SourceCollection") ?? "model_groups",
        Authority = d.AsNullableString("Authority") ?? "map",
        ClaimedAt = d.AsNullableUtcDateTime("ClaimedAt").ToIso(),
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
        Models = items,
    };
}

// 硬约束：绝不读 ApiKeyEncrypted 到 DTO，只用它算 hasKey。
static PlatformItem MapPlatform(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    Name = d.GetStringOrEmpty("Name"),
    PlatformType = d.GetStringOrEmpty("PlatformType"),
    ProviderId = d.AsNullableString("ProviderId"),
    ApiUrl = d.AsNullableString("ApiUrl"),
    Enabled = d.AsNullableBool("Enabled") ?? true,
    MaxConcurrency = d.AsNullableInt("MaxConcurrency") ?? 0,
    Remark = d.AsNullableString("Remark"),
    HasKey = !string.IsNullOrEmpty(d.AsNullableString("ApiKeyEncrypted")),
    SourceCollection = d.AsNullableString("SourceCollection") ?? "llmplatforms",
    Authority = d.AsNullableString("Authority") ?? "map",
    ClaimedAt = d.AsNullableUtcDateTime("ClaimedAt").ToIso(),
    CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
    UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
};

static ModelItem MapModel(BsonDocument d)
{
    var capsArr = d.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray ? cv.AsBsonArray : new BsonArray();
    var caps = capsArr.Where(c => c.IsBsonDocument).Select(c => c.AsBsonDocument).Select(c => new ModelCapabilityItem
    {
        Type = c.GetStringOrEmpty("Type"),
        Source = c.GetStringOrEmpty("Source"),
        Value = c.AsNullableBool("Value") ?? false,
    }).ToList();
    return new ModelItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Name = d.GetStringOrEmpty("Name"),
        ModelName = d.GetStringOrEmpty("ModelName"),
        ApiUrl = d.AsNullableString("ApiUrl"),
        Protocol = d.AsNullableString("Protocol"),
        PlatformId = d.AsNullableString("PlatformId"),
        Group = d.AsNullableString("Group"),
        Timeout = d.AsNullableInt("Timeout") ?? 0,
        MaxRetries = d.AsNullableInt("MaxRetries") ?? 0,
        MaxConcurrency = d.AsNullableInt("MaxConcurrency") ?? 0,
        MaxTokens = d.AsNullableInt("MaxTokens"),
        Enabled = d.AsNullableBool("Enabled") ?? true,
        Priority = d.AsNullableInt("Priority") ?? 100,
        IsMain = d.AsNullableBool("IsMain") ?? false,
        IsIntent = d.AsNullableBool("IsIntent") ?? false,
        IsVision = d.AsNullableBool("IsVision") ?? false,
        IsImageGen = d.AsNullableBool("IsImageGen") ?? false,
        EnablePromptCache = d.AsNullableBool("EnablePromptCache"),
        Remark = d.AsNullableString("Remark"),
        HasKey = !string.IsNullOrEmpty(d.AsNullableString("ApiKeyEncrypted")),
        SourceCollection = d.AsNullableString("SourceCollection") ?? "llmmodels",
        Authority = d.AsNullableString("Authority") ?? "map",
        ClaimedAt = d.AsNullableUtcDateTime("ClaimedAt").ToIso(),
        CallCount = d.AsNullableLong("CallCount") ?? 0,
        SuccessCount = d.AsNullableLong("SuccessCount") ?? 0,
        FailCount = d.AsNullableLong("FailCount") ?? 0,
        TotalDuration = d.AsNullableLong("TotalDuration") ?? 0,
        Capabilities = caps,
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
    };
}

static ExchangeItem MapExchange(BsonDocument d)
{
    var modelsArr = d.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var exchangeModels = new List<ExchangeModelItem>();
    foreach (var m in modelsArr)
    {
        if (!m.IsBsonDocument) continue;
        var md = m.AsBsonDocument;
        exchangeModels.Add(new ExchangeModelItem
        {
            ModelId = md.GetStringOrEmpty("ModelId"),
            DisplayName = md.AsNullableString("DisplayName"),
            ModelType = md.AsNullableString("ModelType") ?? "chat",
            Description = md.AsNullableString("Description"),
            Enabled = md.AsNullableBool("Enabled") ?? true,
        });
    }

    return new ExchangeItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Name = d.GetStringOrEmpty("Name"),
        ModelAlias = d.AsNullableString("ModelAlias") ?? string.Empty,
        ModelAliases = d.AsStringList("ModelAliases"),
        Models = exchangeModels,
        TargetUrl = d.GetStringOrEmpty("TargetUrl"),
        TargetAuthScheme = d.AsNullableString("TargetAuthScheme") ?? "Bearer",
        TransformerType = d.AsNullableString("TransformerType") ?? "passthrough",
        Enabled = d.AsNullableBool("Enabled") ?? true,
        Description = d.AsNullableString("Description"),
        HasKey = !string.IsNullOrEmpty(d.AsNullableString("TargetApiKeyEncrypted")),
        SourceCollection = d.AsNullableString("SourceCollection") ?? "model_exchanges",
        Authority = d.AsNullableString("Authority") ?? "map",
        ClaimedAt = d.AsNullableUtcDateTime("ClaimedAt").ToIso(),
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
    };
}

static GatewayAppCallerItem MapGatewayAppCaller(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    AppCallerCode = d.GetStringOrEmpty("AppCallerCode"),
    RequestType = d.GetStringOrEmpty("RequestType"),
    SourceSystem = d.GetStringOrEmpty("SourceSystem"),
    IngressProtocol = d.GetStringOrEmpty("IngressProtocol"),
    ObservedIngressProtocols = GetObservedIngressProtocols(d),
    Title = d.AsNullableString("Title"),
    Status = d.AsNullableString("Status") ?? "discovered",
    ModelPoolId = d.AsNullableString("ModelPoolId"),
    ModelPolicy = d.AsNullableString("ModelPolicy"),
    ParameterPolicy = d.AsNullableString("ParameterPolicy"),
    LastObservedModelPoolId = d.AsNullableString("LastObservedModelPoolId"),
    LastObservedModelPolicy = d.AsNullableString("LastObservedModelPolicy"),
    LastObservedParameterPolicy = d.AsNullableString("LastObservedParameterPolicy"),
    ObservedModelPoolIds = GetStringArray(d, "ObservedModelPoolIds"),
    ObservedModelPolicies = GetStringArray(d, "ObservedModelPolicies"),
    ObservedParameterPolicies = GetStringArray(d, "ObservedParameterPolicies"),
    LastObservedRequestId = d.AsNullableString("LastObservedRequestId"),
    LastObservedSessionId = d.AsNullableString("LastObservedSessionId"),
    LastObservedRunId = d.AsNullableString("LastObservedRunId"),
    Owner = d.AsNullableString("Owner"),
    MonthlyBudgetUsd = d.AsNullableDecimal("MonthlyBudgetUsd"),
    BudgetReservationUsd = d.AsNullableDecimal("BudgetReservationUsd"),
    RateLimitPerMinute = d.AsNullableInt("RateLimitPerMinute"),
    Notes = d.AsNullableString("Notes"),
    TotalSeen = d.AsNullableLong("TotalSeen") ?? 0,
    FirstSeenAt = d.AsNullableUtcDateTime("FirstSeenAt").ToIso(),
    LastSeenAt = d.AsNullableUtcDateTime("LastSeenAt").ToIso(),
    CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
    UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
};

static FilterDefinition<BsonDocument>? BuildAppCallerDriftFilter(string? drift)
{
    var normalized = drift?.Trim().ToLowerInvariant();
    if (string.IsNullOrWhiteSpace(normalized)) return null;

    var routePolicy = BuildFieldDriftExpr("ModelPolicy", "LastObservedModelPolicy", "ObservedModelPolicies");
    var routePool = BuildFieldDriftExpr("ModelPoolId", "LastObservedModelPoolId", "ObservedModelPoolIds");
    var parameter = BuildFieldDriftExpr("ParameterPolicy", "LastObservedParameterPolicy", "ObservedParameterPolicies");

    return normalized switch
    {
        "route" => new BsonDocument("$expr", new BsonDocument("$or", new BsonArray { routePolicy, routePool })),
        "parameter" => new BsonDocument("$expr", parameter),
        "any" => new BsonDocument("$expr", new BsonDocument("$or", new BsonArray { routePolicy, routePool, parameter })),
        _ => null,
    };
}

static async Task<string?> ValidateBulkActiveGatewayAppCallerConfigAsync(
    IMongoCollection<BsonDocument> appCallers,
    IMongoCollection<BsonDocument> gwModelPools,
    IMongoCollection<BsonDocument> gwPlatforms,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> gwModelExchanges,
    string tenantId,
    FilterDefinition<BsonDocument> filter,
    string? targetStatus,
    bool targetModelPolicyTouched,
    string? targetModelPolicy)
{
    var projection = Builders<BsonDocument>.Projection
        .Include("_id")
        .Include("AppCallerCode")
        .Include("RequestType")
        .Include("Status")
        .Include("ModelPoolId")
        .Include("ModelPolicy");
    var docs = await appCallers.Find(filter).Project(projection).ToListAsync();
    foreach (var doc in docs)
    {
        var effectiveStatus = targetStatus ?? doc.AsNullableString("Status") ?? "discovered";
        var effectiveModelPoolId = doc.AsNullableString("ModelPoolId");
        var effectiveModelPolicy = targetModelPolicyTouched ? targetModelPolicy : doc.AsNullableString("ModelPolicy");
        var error = await ValidateActiveGatewayAppCallerConfigAsync(
            gwModelPools,
            gwPlatforms,
            gwModels,
            gwModelExchanges,
            tenantId,
            effectiveStatus,
            effectiveModelPoolId,
            effectiveModelPolicy,
            doc.GetStringOrEmpty("RequestType"));
        if (error is not null)
        {
            var code = doc.AsNullableString("AppCallerCode") ?? doc.GetStringOrEmpty("_id");
            return $"{code}: {error}";
        }
    }
    return null;
}

static async Task<string?> ValidateActiveGatewayAppCallerConfigAsync(
    IMongoCollection<BsonDocument> gwModelPools,
    IMongoCollection<BsonDocument> gwPlatforms,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> gwModelExchanges,
    string tenantId,
    string? status,
    string? modelPoolId,
    string? modelPolicy,
    string? requestType)
{
    if (!string.Equals(status, "active", StringComparison.OrdinalIgnoreCase))
    {
        return null;
    }

    var normalizedModelPolicy = (modelPolicy ?? string.Empty).Trim().ToLowerInvariant();
    if (normalizedModelPolicy is not ("auto" or "pool" or "pinned"))
    {
        return "active appCaller 必须使用 modelPolicy=auto/pool/pinned；auto 使用调用方默认池，pool 使用指定池，pinned 保留精确模型意图。";
    }

    if (string.IsNullOrWhiteSpace(modelPoolId))
    {
        return "active appCaller 必须绑定 llm_gateway.llmgw_model_pools 中的 GW 权威模型池。";
    }

    var pool = await gwModelPools
        .Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            Builders<BsonDocument>.Filter.Eq("_id", modelPoolId.Trim())))
        .FirstOrDefaultAsync();
    if (pool is null)
    {
        return $"active appCaller 绑定的模型池 {modelPoolId.Trim()} 不是 GW 权威模型池；请先在 /pools 认领或创建。";
    }

    var poolType = pool.AsNullableString("ModelType");
    if (!string.IsNullOrWhiteSpace(poolType)
        && !string.IsNullOrWhiteSpace(requestType)
        && !string.Equals(poolType, requestType, StringComparison.OrdinalIgnoreCase))
    {
        return $"active appCaller 绑定的 GW 模型池类型 {poolType} 与调用类型 {requestType} 不一致。";
    }

    if (!await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, pool))
    {
        return $"active appCaller 绑定的 GW 模型池 {modelPoolId.Trim()} 没有可解析、非 unavailable 的成员；请先在 /pools 补齐 enabled 模型或 Exchange。";
    }

    return null;
}

static async Task<string?> ValidateDefaultGatewayPoolMembersAsync(
    IMongoCollection<BsonDocument> gwPlatforms,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> gwModelExchanges,
    BsonDocument pool,
    BsonArray nextModels)
{
    if (pool.AsNullableBool("IsDefaultForType") != true)
    {
        return null;
    }

    var nextPool = new BsonDocument(pool)
    {
        ["Models"] = nextModels,
    };
    if (await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, nextPool))
    {
        return null;
    }

    return "默认 GW 模型池必须保留至少一个可解析、非 unavailable 的成员；请先添加 enabled 模型或 Exchange，再删除或覆盖现有成员。";
}

static async Task<bool> HasUsableGatewayPoolMemberAsync(
    IMongoCollection<BsonDocument> gwPlatforms,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> gwModelExchanges,
    BsonDocument pool)
{
    var tenantId = pool.AsNullableString("TenantId");
    if (string.IsNullOrWhiteSpace(tenantId)) return false;
    var tenantFilter = Builders<BsonDocument>.Filter.Eq("TenantId", tenantId);
    var enabledPlatformIds = (await gwPlatforms.Find(tenantFilter)
            .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Enabled"))
            .ToListAsync())
        .Where(d => d.AsNullableBool("Enabled") ?? true)
        .Select(d => d.GetStringOrEmpty("_id"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .ToHashSet(StringComparer.Ordinal);
    var enabledModels = await gwModels.Find(Builders<BsonDocument>.Filter.And(tenantFilter, Builders<BsonDocument>.Filter.Ne("Enabled", false)))
        .Project(Builders<BsonDocument>.Projection.Include("_id").Include("ModelName").Include("Name").Include("PlatformId").Include("Enabled"))
        .ToListAsync();
    var enabledExchanges = await gwModelExchanges.Find(Builders<BsonDocument>.Filter.And(tenantFilter, Builders<BsonDocument>.Filter.Ne("Enabled", false)))
        .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Name").Include("Enabled").Include("ModelAlias").Include("ModelAliases").Include("Models"))
        .ToListAsync();

    var members = pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    return members
        .Where(x => x.IsBsonDocument)
        .Select(x => x.AsBsonDocument)
        .Any(member => IsResolvableGatewayPoolMember(member, enabledPlatformIds, enabledModels, enabledExchanges));
}

static bool IsResolvableGatewayPoolMember(
    BsonDocument member,
    HashSet<string> enabledPlatformIds,
    List<BsonDocument> enabledModels,
    List<BsonDocument> enabledExchanges)
{
    if ((member.AsNullableInt("HealthStatus") ?? 0) == 2) return false;
    var modelId = member.GetStringOrEmpty("ModelId");
    var platformId = member.GetStringOrEmpty("PlatformId");
    if (modelId.Length == 0 || platformId.Length == 0) return false;
    if (string.Equals(platformId, "__exchange__", StringComparison.Ordinal))
    {
        return enabledExchanges.Any(exchange => GatewayExchangeSupportsModel(exchange, modelId));
    }
    var exchangeById = enabledExchanges.FirstOrDefault(exchange => string.Equals(exchange.GetStringOrEmpty("_id"), platformId, StringComparison.Ordinal));
    if (exchangeById is not null) return GatewayExchangeSupportsModel(exchangeById, modelId);
    if (!enabledPlatformIds.Contains(platformId)) return false;
    return enabledModels.Any(model =>
        string.Equals(model.AsNullableString("PlatformId"), platformId, StringComparison.Ordinal)
        && (string.Equals(model.GetStringOrEmpty("_id"), modelId, StringComparison.Ordinal)
            || string.Equals(model.AsNullableString("ModelName"), modelId, StringComparison.Ordinal)
            || string.Equals(model.AsNullableString("Name"), modelId, StringComparison.Ordinal)));
}

static bool GatewayExchangeSupportsModel(BsonDocument exchange, string modelId)
{
    if (string.Equals(exchange.AsNullableString("ModelAlias"), modelId, StringComparison.Ordinal)) return true;
    if (exchange.AsStringList("ModelAliases").Contains(modelId, StringComparer.Ordinal)) return true;
    if (!exchange.TryGetValue("Models", out var modelsValue) || !modelsValue.IsBsonArray) return false;
    return modelsValue.AsBsonArray
        .Where(x => x.IsBsonDocument)
        .Select(x => x.AsBsonDocument)
        .Any(m => (m.AsNullableBool("Enabled") ?? true)
                  && (string.Equals(m.AsNullableString("ModelId"), modelId, StringComparison.Ordinal)
                      || string.Equals(m.AsNullableString("DisplayName"), modelId, StringComparison.Ordinal)));
}

static BsonDocument BuildFieldDriftExpr(string configuredField, string observedField, string observedValuesField)
{
    var observed = new BsonDocument("$ifNull", new BsonArray { $"${observedField}", "" });
    var configured = new BsonDocument("$ifNull", new BsonArray { $"${configuredField}", "" });
    var observedValues = new BsonDocument("$ifNull", new BsonArray { $"${observedValuesField}", new BsonArray() });
    return new BsonDocument("$cond", new BsonArray
    {
        new BsonDocument("$gt", new BsonArray { new BsonDocument("$size", observedValues), 0 }),
        new BsonDocument("$not", new BsonArray { new BsonDocument("$in", new BsonArray { configured, observedValues }) }),
        new BsonDocument("$and", new BsonArray
        {
            new BsonDocument("$ne", new BsonArray { observed, "" }),
            new BsonDocument("$ne", new BsonArray { configured, observed }),
        }),
    });
}

static List<string> GetStringArray(BsonDocument d, string field)
{
    if (!d.TryGetValue(field, out var value) || !value.IsBsonArray) return new List<string>();
    return value.AsBsonArray
        .Where(x => x.IsString && !string.IsNullOrWhiteSpace(x.AsString))
        .Select(x => x.AsString)
        .Distinct(StringComparer.Ordinal)
        .ToList();
}

static OperationAuditItem MapOperationAudit(BsonDocument d)
{
    var changesJson = d.TryGetValue("Changes", out var changes) && !changes.IsBsonNull
        ? changes.ToString()
        : "{}";
    changesJson = string.IsNullOrWhiteSpace(changesJson) ? "{}" : changesJson;
    return new OperationAuditItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Action = d.GetStringOrEmpty("Action"),
        TargetType = d.GetStringOrEmpty("TargetType"),
        TargetId = d.AsNullableString("TargetId"),
        TargetName = d.AsNullableString("TargetName"),
        ActorUserId = d.AsNullableString("ActorUserId"),
        ActorUsername = d.AsNullableString("ActorUsername"),
        Success = d.AsNullableBool("Success") ?? false,
        Reason = d.AsNullableString("Reason"),
        ChangesJson = changesJson,
        RemoteIp = d.AsNullableString("RemoteIp"),
        UserAgent = d.AsNullableString("UserAgent"),
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
    };
}

static KeyHealthItem MapKeyHealth(BsonDocument d, string objectType, string encryptedField, IConfiguration configuration)
{
    var encrypted = d.AsNullableString(encryptedField);
    var result = GwApiKeyCrypto.Decrypt(encrypted, configuration);
    var name = d.AsNullableString("Name") ?? d.AsNullableString("ModelName") ?? d.GetStringOrEmpty("_id");
    var status = result.Success
        ? result.UsedLegacySecret ? "legacy" : "ok"
        : string.IsNullOrWhiteSpace(encrypted) ? "missing"
        : IsDevStubName(name) ? "stub-unreadable" : "unreadable";
    return new KeyHealthItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Name = name,
        ObjectType = objectType,
        Authority = d.AsNullableString("Authority") ?? "llm_gateway",
        Enabled = d.AsNullableBool("Enabled") ?? true,
        HasKey = !string.IsNullOrWhiteSpace(encrypted),
        Status = status,
        UsedLegacySecret = result.Success && result.UsedLegacySecret,
    };
}

static bool IsDevStubName(string? name)
    => !string.IsNullOrWhiteSpace(name)
       && (name.Contains("开发桩")
           || System.Text.RegularExpressions.Regex.IsMatch(name, @"(^|[^a-z])stub([^a-z]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase));

static ShadowSnapshotItem MapSnapshot(BsonDocument s) => new()
{
    Success = s.AsNullableBool("Success") ?? false,
    ActualModel = s.AsNullableString("ActualModel"),
    Protocol = s.AsNullableString("Protocol"),
    PlatformType = s.AsNullableString("PlatformType"),
    ResolutionType = s.AsNullableString("ResolutionType"),
    ModelGroupId = s.AsNullableString("ModelGroupId"),
    IsFallback = s.AsNullableBool("IsFallback") ?? false,
};

static ShadowItem MapShadow(BsonDocument d)
{
    var inp = d.TryGetValue("Inproc", out var iv) && iv.IsBsonDocument ? iv.AsBsonDocument : new BsonDocument();
    var htp = d.TryGetValue("Http", out var hv) && hv.IsBsonDocument ? hv.AsBsonDocument : new BsonDocument();
    var misArr = d.TryGetValue("Mismatches", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    return new ShadowItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Kind = d.GetStringOrEmpty("Kind"),
        RequestId = d.AsNullableString("RequestId"),
        ReleaseCommit = d.AsNullableString("ReleaseCommit"),
        AppCallerCode = d.GetStringOrEmpty("AppCallerCode"),
        ModelType = d.GetStringOrEmpty("ModelType"),
        ComparedAt = d.AsNullableUtcDateTime("ComparedAt").ToIso(),
        ShadowDurationMs = d.AsNullableLong("ShadowDurationMs") ?? 0,
        HttpOk = d.AsNullableBool("HttpOk") ?? false,
        HttpError = d.AsNullableString("HttpError"),
        AllMatch = d.AsNullableBool("AllMatch") ?? false,
        HasCritical = d.AsNullableBool("HasCritical") ?? false,
        Inproc = MapSnapshot(inp),
        Http = MapSnapshot(htp),
        Mismatches = misArr.Where(m => m.IsBsonDocument).Select(m => m.AsBsonDocument).Select(m => new ShadowMismatchItem
        {
            Field = m.GetStringOrEmpty("Field"),
            Inproc = m.AsNullableString("Inproc"),
            Http = m.AsNullableString("Http"),
            Severity = m.GetStringOrEmpty("Severity"),
        }).ToList(),
        TextMatches = d.AsNullableBool("TextMatches"),
    };
}

static (bool Ready, string Detail, string Evidence, Dictionary<string, string> Facts) ReadLatestHttpFullRolloutLedgerEvidence(string path, string currentCommit)
{
    var normalizedPath = string.IsNullOrWhiteSpace(path) ? ".llmgw-release-evidence/rollout-ledger.jsonl" : path.Trim();
    var expectedCommit = NormalizeCommitFilter(currentCommit);
    var facts = new Dictionary<string, string>
    {
        ["rolloutLedger"] = normalizedPath,
        ["stage"] = "http-full",
        ["currentCommit"] = expectedCommit ?? string.Empty,
    };
    if (!File.Exists(normalizedPath))
    {
        return (
            false,
            $"未找到 rollout ledger：{normalizedPath}。",
            $"rolloutLedger={normalizedPath}; currentCommit={expectedCommit ?? "empty"}",
            facts);
    }

    var latestRecordedAt = string.Empty;
    var latestCommit = string.Empty;
    var latestReleaseGateRequired = false;
    var latestDisableMapFallback = false;
    var latestHasEvidenceJson = false;
    var latestHasReleaseGateJson = false;
    var latestProtocolCanaryRequired = false;
    var latestHasProtocolCanaryJson = false;
    var parseErrors = 0;

    foreach (var line in File.ReadLines(normalizedPath))
    {
        var raw = line.Trim();
        if (raw.Length == 0) continue;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            var stage = ReadJsonString(root, "stage");
            var status = ReadJsonString(root, "status");
            if (!string.Equals(stage, "http-full", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(status, "success", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            latestRecordedAt = ReadJsonString(root, "recordedAt");
            latestCommit = NormalizeCommitFilter(ReadJsonString(root, "commit")) ?? string.Empty;
            latestReleaseGateRequired = ReadJsonBool(root, "releaseGateRequired");
            latestDisableMapFallback = ReadJsonBool(root, "disableMapConfigFallbackForActiveAppCallers");
            latestHasEvidenceJson = !string.IsNullOrWhiteSpace(ReadJsonString(root, "evidenceJson"));
            latestHasReleaseGateJson = !string.IsNullOrWhiteSpace(ReadJsonString(root, "releaseGateJson"));
            latestProtocolCanaryRequired = ReadJsonBool(root, "protocolCanaryRequired");
            latestHasProtocolCanaryJson = !string.IsNullOrWhiteSpace(ReadJsonString(root, "protocolCanaryJson"));
        }
        catch (JsonException)
        {
            parseErrors++;
        }
    }

    if (latestCommit.Length == 0)
    {
        facts["parseErrors"] = parseErrors.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return (
            false,
            parseErrors > 0
                ? $"rollout ledger 可读但没有有效 http-full success 记录，且有 {parseErrors} 行 JSON 解析失败。"
                : "rollout ledger 可读但没有 http-full success 记录。",
            $"rolloutLedger={normalizedPath}; currentCommit={expectedCommit ?? "empty"}; parseErrors={parseErrors}",
            facts);
    }

    var sameCommit = expectedCommit is not null && string.Equals(latestCommit, expectedCommit, StringComparison.OrdinalIgnoreCase);
    var ready = sameCommit
                && latestReleaseGateRequired
                && latestDisableMapFallback
                && latestHasEvidenceJson
                && latestHasReleaseGateJson
                && latestProtocolCanaryRequired
                && latestHasProtocolCanaryJson;
    var missing = new List<string>();
    if (!sameCommit) missing.Add("same-commit");
    if (!latestReleaseGateRequired) missing.Add("releaseGateRequired");
    if (!latestDisableMapFallback) missing.Add("disableMapConfigFallbackForActiveAppCallers");
    if (!latestHasEvidenceJson) missing.Add("evidenceJson");
    if (!latestHasReleaseGateJson) missing.Add("releaseGateJson");
    if (!latestProtocolCanaryRequired) missing.Add("protocolCanaryRequired");
    if (!latestHasProtocolCanaryJson) missing.Add("protocolCanaryJson");
    var detail = ready
        ? $"找到同 commit 的 http-full success 台账：{latestCommit}，recordedAt={latestRecordedAt}。"
        : $"找到 http-full success 台账，但仍缺 {string.Join(", ", missing)}；latestCommit={latestCommit}，currentCommit={expectedCommit ?? "empty"}。";
    var evidence = $"rolloutLedger={normalizedPath}; stage=http-full; status=success; commit={latestCommit}; releaseGateRequired={latestReleaseGateRequired}; disableMapFallback={latestDisableMapFallback}; protocolCanaryRequired={latestProtocolCanaryRequired}; protocolCanaryJson={latestHasProtocolCanaryJson}";
    facts["latestCommit"] = latestCommit;
    facts["recordedAt"] = latestRecordedAt;
    facts["sameCommit"] = sameCommit ? "true" : "false";
    facts["releaseGateRequired"] = latestReleaseGateRequired ? "true" : "false";
    facts["disableMapConfigFallbackForActiveAppCallers"] = latestDisableMapFallback ? "true" : "false";
    facts["evidenceJson"] = latestHasEvidenceJson ? "true" : "false";
    facts["releaseGateJson"] = latestHasReleaseGateJson ? "true" : "false";
    facts["protocolCanaryRequired"] = latestProtocolCanaryRequired ? "true" : "false";
    facts["protocolCanaryJson"] = latestHasProtocolCanaryJson ? "true" : "false";
    facts["missing"] = string.Join(",", missing);
    return (ready, detail, evidence, facts);
}

static List<string> ReadSuccessfulHttpFullRolloutCommits(string path)
{
    var normalizedPath = string.IsNullOrWhiteSpace(path) ? ".llmgw-release-evidence/rollout-ledger.jsonl" : path.Trim();
    if (!File.Exists(normalizedPath)) return new List<string>();

    var commits = new List<string>();
    foreach (var line in File.ReadLines(normalizedPath))
    {
        var raw = line.Trim();
        if (raw.Length == 0) continue;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (!string.Equals(ReadJsonString(root, "stage"), "http-full", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(ReadJsonString(root, "status"), "success", StringComparison.OrdinalIgnoreCase)
                || !ReadJsonBool(root, "releaseGateRequired")
                || !ReadJsonBool(root, "disableMapConfigFallbackForActiveAppCallers")
                || string.IsNullOrWhiteSpace(ReadJsonString(root, "evidenceJson"))
                || string.IsNullOrWhiteSpace(ReadJsonString(root, "releaseGateJson"))
                || !ReadJsonBool(root, "protocolCanaryRequired")
                || string.IsNullOrWhiteSpace(ReadJsonString(root, "protocolCanaryJson")))
            {
                continue;
            }

            var commit = NormalizeCommitFilter(ReadJsonString(root, "commit"));
            if (commit is null) continue;
            commits.RemoveAll(existing => string.Equals(existing, commit, StringComparison.OrdinalIgnoreCase));
            commits.Add(commit);
        }
        catch (JsonException)
        {
            // A malformed historical line cannot become release evidence.
        }
    }

    commits.Reverse();
    return commits;
}

static (bool Ready, string Detail, string Evidence, Dictionary<string, string> Facts) ReadLatestConfigAuthorityRolloutLedgerEvidence(string path, string currentCommit)
{
    var normalizedPath = string.IsNullOrWhiteSpace(path) ? ".llmgw-release-evidence/rollout-ledger.jsonl" : path.Trim();
    var expectedCommit = NormalizeCommitFilter(currentCommit);
    var facts = new Dictionary<string, string>
    {
        ["rolloutLedger"] = normalizedPath,
        ["stage"] = "config-authority",
        ["currentCommit"] = expectedCommit ?? string.Empty,
    };
    if (!File.Exists(normalizedPath))
    {
        return (
            false,
            $"未找到 rollout ledger：{normalizedPath}。",
            $"rolloutLedger={normalizedPath}; stage=config-authority; currentCommit={expectedCommit ?? "empty"}",
            facts);
    }

    var latestRecordedAt = string.Empty;
    var latestCommit = string.Empty;
    var latestConfigAuthorityJson = false;
    var latestExternalBackupJson = false;
    var parseErrors = 0;

    foreach (var line in File.ReadLines(normalizedPath))
    {
        var raw = line.Trim();
        if (raw.Length == 0) continue;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            var stage = ReadJsonString(root, "stage");
            var status = ReadJsonString(root, "status");
            if (!string.Equals(stage, "config-authority", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(status, "success", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            latestRecordedAt = ReadJsonString(root, "recordedAt");
            latestCommit = NormalizeCommitFilter(ReadJsonString(root, "commit")) ?? string.Empty;
            latestConfigAuthorityJson = !string.IsNullOrWhiteSpace(ReadJsonString(root, "configAuthorityJson"));
            latestExternalBackupJson = !string.IsNullOrWhiteSpace(ReadJsonString(root, "externalBackupJson"));
        }
        catch (JsonException)
        {
            parseErrors++;
        }
    }

    if (latestCommit.Length == 0)
    {
        facts["parseErrors"] = parseErrors.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return (
            false,
            parseErrors > 0
                ? $"rollout ledger 可读但没有有效 config-authority success 记录，且有 {parseErrors} 行 JSON 解析失败。"
                : "rollout ledger 可读但没有 config-authority success 记录。",
            $"rolloutLedger={normalizedPath}; stage=config-authority; currentCommit={expectedCommit ?? "empty"}; parseErrors={parseErrors}",
            facts);
    }

    var sameCommit = expectedCommit is not null && string.Equals(latestCommit, expectedCommit, StringComparison.OrdinalIgnoreCase);
    var ready = sameCommit && latestConfigAuthorityJson && latestExternalBackupJson;
    var missing = new List<string>();
    if (!sameCommit) missing.Add("same-commit");
    if (!latestConfigAuthorityJson) missing.Add("configAuthorityJson");
    if (!latestExternalBackupJson) missing.Add("externalBackupJson");
    var detail = ready
        ? $"找到同 commit 的 config-authority success 台账：{latestCommit}，recordedAt={latestRecordedAt}。"
        : $"找到 config-authority success 台账，但仍缺 {string.Join(", ", missing)}；latestCommit={latestCommit}，currentCommit={expectedCommit ?? "empty"}。";
    var evidence = $"rolloutLedger={normalizedPath}; stage=config-authority; status=success; commit={latestCommit}; configAuthorityJson={latestConfigAuthorityJson}; externalBackupJson={latestExternalBackupJson}";
    facts["latestCommit"] = latestCommit;
    facts["recordedAt"] = latestRecordedAt;
    facts["sameCommit"] = sameCommit ? "true" : "false";
    facts["configAuthorityJson"] = latestConfigAuthorityJson ? "true" : "false";
    facts["externalBackupJson"] = latestExternalBackupJson ? "true" : "false";
    facts["missing"] = string.Join(",", missing);
    return (ready, detail, evidence, facts);
}

static string ReadJsonString(JsonElement root, string name)
{
    if (!root.TryGetProperty(name, out var value)) return string.Empty;
    return value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.ToString();
}

static bool ReadJsonBool(JsonElement root, string name)
{
    if (!root.TryGetProperty(name, out var value)) return false;
    return value.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.String => bool.TryParse(value.GetString(), out var parsed) && parsed,
        _ => false,
    };
}

static bool IsTruthy(string? value)
{
    var raw = (value ?? string.Empty).Trim();
    return string.Equals(raw, "1", StringComparison.OrdinalIgnoreCase)
           || string.Equals(raw, "true", StringComparison.OrdinalIgnoreCase)
           || string.Equals(raw, "yes", StringComparison.OrdinalIgnoreCase)
           || string.Equals(raw, "y", StringComparison.OrdinalIgnoreCase)
           || string.Equals(raw, "on", StringComparison.OrdinalIgnoreCase);
}

static decimal? NormalizePositiveBudget(decimal value) => value > 0 ? value : null;

static string? ValidateBudgetConfiguration(decimal? monthlyBudgetUsd, decimal? budgetReservationUsd)
{
    if (monthlyBudgetUsd is null or <= 0)
        return budgetReservationUsd is > 0 ? "配置单次预算预占前必须先配置月预算" : null;
    if (budgetReservationUsd is null or <= 0)
        return "配置月预算时必须同时配置大于 0 的单次预算预占";
    if (budgetReservationUsd > monthlyBudgetUsd)
        return "单次预算预占不能超过月预算";
    return null;
}

static (string Prefix, string Suffix, List<string> AllowedVariables, Dictionary<string, string> Variables, string? Error)
    ValidatePromptPolicyDraft(SavePromptPolicyRequest body, BsonDocument caller, TenantAccessContext access)
{
    var requestType = caller.GetStringOrEmpty("RequestType").Trim().ToLowerInvariant();
    if (requestType is not ("chat" or "vision"))
        return ("", "", [], new(), "提示词策略首版只支持 chat/vision");
    if (body.MaxChars is < 1 or > 20000)
        return ("", "", [], new(), "maxChars 仅支持 1..20000");
    var prefix = (body.SystemPromptPrefix ?? "").Trim();
    var suffix = (body.SystemPromptSuffix ?? "").Trim();
    if (prefix.Length + suffix.Length > body.MaxChars)
        return (prefix, suffix, [], new(), "前缀和后缀字符数超过 maxChars");
    var supported = new HashSet<string>(new[] { "tenantId", "teamId", "appCallerCode", "requestType", "sourceSystem" }, StringComparer.Ordinal);
    var allowed = (body.AllowedVariables ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct(StringComparer.Ordinal).ToList();
    var unsupported = allowed.FirstOrDefault(x => !supported.Contains(x));
    if (unsupported is not null)
        return (prefix, suffix, allowed, new(), $"不支持变量：{unsupported}");
    var referenced = System.Text.RegularExpressions.Regex.Matches(prefix + "\n" + suffix, "\\{\\{([A-Za-z][A-Za-z0-9]*)\\}\\}")
        .Select(x => x.Groups[1].Value).Distinct(StringComparer.Ordinal).ToList();
    var denied = referenced.FirstOrDefault(x => !allowed.Contains(x, StringComparer.Ordinal));
    if (denied is not null)
        return (prefix, suffix, allowed, new(), $"变量未加入 allowedVariables：{denied}");
    var variables = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["tenantId"] = access.TenantId,
        ["teamId"] = caller.AsNullableString("TeamId") ?? "",
        ["appCallerCode"] = caller.GetStringOrEmpty("AppCallerCode"),
        ["requestType"] = requestType,
        ["sourceSystem"] = caller.AsNullableString("SourceSystem") ?? "",
    };
    return (prefix, suffix, allowed, variables, null);
}

static string RenderPromptPolicy(string template, IReadOnlyCollection<string> allowed, IReadOnlyDictionary<string, string> variables)
    => System.Text.RegularExpressions.Regex.Replace(template, "\\{\\{([A-Za-z][A-Za-z0-9]*)\\}\\}", match =>
        allowed.Contains(match.Groups[1].Value, StringComparer.Ordinal)
        && variables.TryGetValue(match.Groups[1].Value, out var value) ? value : match.Value);

static string ComputePromptPolicyHash(string prefix, string suffix, bool enabled, IEnumerable<string> allowedVariables, int maxChars)
{
    var canonical = string.Join("\n", new[]
    {
        prefix, suffix, enabled ? "true" : "false", string.Join(",", allowedVariables.OrderBy(x => x, StringComparer.Ordinal)), maxChars.ToString(System.Globalization.CultureInfo.InvariantCulture),
    });
    return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
}

static PromptPolicyVersionItem MapPromptPolicy(BsonDocument doc) => new()
{
    Id = doc.GetStringOrEmpty("_id"),
    TeamId = doc.AsNullableString("TeamId"),
    AppCallerCode = doc.GetStringOrEmpty("AppCallerCode"),
    RequestType = doc.GetStringOrEmpty("RequestType"),
    SystemPromptPrefix = doc.AsNullableString("SystemPromptPrefix") ?? "",
    SystemPromptSuffix = doc.AsNullableString("SystemPromptSuffix") ?? "",
    Enabled = doc.AsNullableBool("Enabled") == true,
    Version = doc.AsNullableInt("Version") ?? 0,
    AllowedVariables = doc.AsStringList("AllowedVariables"),
    MaxChars = doc.AsNullableInt("MaxChars") ?? 8000,
    PolicyHash = doc.AsNullableString("PolicyHash") ?? "",
    PolicyChars = doc.AsNullableInt("PolicyChars") ?? 0,
    CreatedBy = doc.AsNullableString("CreatedBy"),
    UpdatedBy = doc.AsNullableString("UpdatedBy"),
    UpdatedAt = doc.AsNullableUtcDateTime("UpdatedAt").ToIso(),
};

static BsonDocument PromptPolicyAuditChanges(BsonDocument doc) => new()
{
    { "version", doc["Version"] },
    { "enabled", doc["Enabled"] },
    { "policyHash", doc["PolicyHash"] },
    { "policyChars", doc["PolicyChars"] },
    { "maxChars", doc["MaxChars"] },
};

// 统一 JSON 输出（带信封 + 指定状态码）。
static IResult Json<T>(T value, JsonSerializerOptions options, int statusCode = 200)
    => Results.Json(value, options, statusCode: statusCode);

static string? NormalizeCommitFilter(string? value)
{
    var trimmed = (value ?? string.Empty).Trim();
    if (trimmed.StartsWith("sha-", StringComparison.OrdinalIgnoreCase))
        trimmed = trimmed[4..];
    return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed.ToLowerInvariant();
}
