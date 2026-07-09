// AI 大模型网关 —— 独立观测/登录后端（与 MAP 物理隔离）。
//
// 设计意图（见 doc/design.llm-gateway-physical-isolation.md）：
//   - 本服务与 prd-api 完全解耦，不引用任何 PrdAgent.* 项目，仅依赖 NuGet 包。
//   - MAP 继续负责 MAP 自己的业务日志；GW 控制台账号、登录审计等自有状态落独立数据库 llm_gateway。
//   - 当前控制台仍读取 MAP 的 llmrequestlogs/模型配置作为观测视图，但不把账号状态写进 MAP 库。
//   - 共享集合 llmrequestlogs 由 .NET 驱动以 PascalCase 字段名序列化；为规避历史文档里
//     数值/日期类型混存导致的反序列化异常，日志查询统一以 BsonDocument 读取并手动安全映射。

using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Mongo;

var builder = WebApplication.CreateBuilder(args);

// ── 配置读取（env 变量里的 __ 自动映射成 :）──
var config = builder.Configuration;

var mongoConn = config["MongoDB:ConnectionString"] ?? "mongodb://localhost:27017";
var mongoDb = config["MongoDB:DatabaseName"] ?? "prdagent";
var gatewayDbName = config["LlmGateway:DatabaseName"] ?? "llm_gateway";

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
var mongoClient = new MongoClient(mongoConn);
var mapDatabase = mongoClient.GetDatabase(mongoDb);
var gatewayDatabase = mongoClient.GetDatabase(gatewayDbName);
builder.Services.AddSingleton(mongoClient);
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
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")));
    // 配置写门：与 LogsRead 同门槛（已登录且非 mcp 首登态）。单管理员控制台，写与读同权；
    // 独立命名便于将来收紧（如引入只读/可写角色）。写入直接落共享 Mongo，MAP 立即可见（跨部件配置同一份）。
    options.AddPolicy("ConfigWrite", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")));
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
app.UseAuthorization();

// ── 启动时幂等播种管理员账户（内置 admin/admin 引导，env 仅 bootstrap/破玻璃）──
// 破玻璃（break-glass）：设 LLMGW_ADMIN_FORCE_RESET 为真值（1/true/yes/on，大小写不敏感）时，显式重置 admin
// 口令。用于「账号被认领但口令登不进」的死锁恢复。恢复后请把该 env 清掉。
// **仅认真值**（Bugbot Medium）：只判「非空」会把 =0 / =false 误当开启，每次启动强制回 admin/admin 反而擦掉 env 口令。
// 口令来源（2026-07-04 目标模式）：数据库是长期权威；LLMGW_ADMIN_PASSWORD 仅在首次创建或 force reset 时使用。
var forceResetRaw = (Environment.GetEnvironmentVariable("LLMGW_ADMIN_FORCE_RESET") ?? string.Empty).Trim();
var forceResetAdmin = new[] { "1", "true", "yes", "on" }.Contains(forceResetRaw, StringComparer.OrdinalIgnoreCase);
var adminBootstrapPwd = Environment.GetEnvironmentVariable("LLMGW_ADMIN_PASSWORD");
var operationAudits = gatewayDatabase.GetCollection<BsonDocument>("llmgw_operation_audits");
await SeedAdminAsync(gatewayDatabase, operationAudits, AdminUser, DefaultAdminPwd, forceResetAdmin, adminBootstrapPwd);

var logs = mapDatabase.GetCollection<BsonDocument>("llmrequestlogs");
// GW 自有账号和审计落独立库 llm_gateway，避免被 MAP 项目 env / shared DB 状态覆盖。
var users = gatewayDatabase.GetCollection<LlmGwUser>("llmgw_console_users");
var loginAudits = gatewayDatabase.GetCollection<LlmGwLoginAudit>("llmgw_login_audits");
// 网关配置面（只读/小范围写）：模型池 / 平台 / 模型 / 影子比对仍来自 MAP 库。MAP 继续负责自己的配置和日志。
var modelGroups = mapDatabase.GetCollection<BsonDocument>("model_groups");
var platforms = mapDatabase.GetCollection<BsonDocument>("llmplatforms");
var models = mapDatabase.GetCollection<BsonDocument>("llmmodels");
var shadows = gatewayDatabase.GetCollection<BsonDocument>("llmshadow_comparisons");

// ───────────────────────────── 健康检查（匿名）─────────────────────────────
app.MapGet("/gw/healthz", () => Results.Json(new
{
    status = "ok",
    commit = gitCommit,
    time = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
}, jsonOptions)).AllowAnonymous();

// ───────────────────────────── 登录（匿名）─────────────────────────────
// 登录失败返回 HTTP 200 + success:false，避免前端把 401 当作"会话过期"自动清 session。
app.MapPost("/gw/auth/login", async (HttpContext http, [FromBody] LoginRequestDto req) =>
{
    var username = (req.Username ?? "").Trim();
    var password = req.Password ?? "";
    if (username.Length == 0 || password.Length == 0)
    {
        await WriteLoginAuditAsync(loginAudits, http, username, null, false, "EMPTY_CREDENTIALS");
        return Json(ApiEnvelope<LoginResultDto>.Fail("INVALID_CREDENTIALS", "用户名或密码不能为空"), jsonOptions);
    }

    var user = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
    if (user is null || !user.IsActive || !PasswordHasher.Verify(password, user.PasswordHash))
    {
        await WriteLoginAuditAsync(loginAudits, http, username, user?.Id, false, user is null ? "USER_NOT_FOUND" : "INVALID_PASSWORD");
        return Json(ApiEnvelope<LoginResultDto>.Fail("INVALID_CREDENTIALS", "用户名或密码错误"), jsonOptions);
    }

    await users.UpdateOneAsync(u => u.Id == user.Id,
        Builders<LlmGwUser>.Update.Set(u => u.LastLoginAt, DateTime.UtcNow));
    await WriteLoginAuditAsync(loginAudits, http, username, user.Id, true, null);

    var (token, expiresAt) = gwJwt.Issue(user);
    var data = new LoginResultDto
    {
        Token = token,
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        MustChangePassword = user.MustChangePassword,
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
    var (token, expiresAt) = gwJwt.Issue(user);
    var data = new ChangePasswordResultDto
    {
        Token = token,
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
    };
    return Json(ApiEnvelope<ChangePasswordResultDto>.Ok(data), jsonOptions);
}).RequireAuthorization();

// ───────────────────────────── 日志列表（需鉴权）─────────────────────────────
app.MapGet("/gw/logs", async (
    int? page, int? pageSize, string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType);

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
app.MapGet("/gw/logs/meta", async () =>
{
    var since = DateTime.UtcNow.AddDays(-30);
    var recent = Builders<BsonDocument>.Filter.Gte("StartedAt", since);

    var modelsRaw = await logs.Distinct<string>("Model", recent).ToListAsync();
    var statusesRaw = await logs.Distinct<string>("Status", recent).ToListAsync();
    var providersRaw = await logs.Distinct<string>("Provider", recent).ToListAsync();
    var appCallersRaw = await logs.Distinct<string>("AppCallerCode", recent).ToListAsync();
    var transportsRaw = await logs.Distinct<string>("GatewayTransport", recent).ToListAsync();
    var requestTypesRaw = await logs.Distinct<string>("RequestType", recent).ToListAsync();

    return Json(ApiEnvelope<LogsMeta>.Ok(new LogsMeta
    {
        Models = NormalizeDistinct(modelsRaw, 200),
        Statuses = NormalizeDistinct(statusesRaw, 80),
        Providers = NormalizeDistinct(providersRaw, 200),
        AppCallers = NormalizeDistinct(appCallersRaw, 300),
        Transports = NormalizeDistinct(transportsRaw, 40),
        RequestTypes = NormalizeDistinct(requestTypesRaw, 80),
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 时间序列（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/timeseries", async (
    string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType) =>
{
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType);

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
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 窗口汇总（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/summary", async (
    string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType) =>
{
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType);
    var projection = Builders<BsonDocument>.Projection
        .Include("Status")
        .Include("DurationMs")
        .Include("InputTokens")
        .Include("OutputTokens")
        .Include("IsFallback")
        .Include("GatewayTransport");
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
        AverageDurationMs = durations.Count == 0 ? null : (long)Math.Round(durations.Average()),
        TransportDistribution = BuildBucket(docs, "GatewayTransport", fallbackKey: "unknown"),
        StatusDistribution = BuildBucket(docs, "Status", fallbackKey: "unknown"),
    };
    data.TotalTokens = data.InputTokens + data.OutputTokens;

    return Json(ApiEnvelope<LogsSummaryData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 会话聚合（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/sessions", async (
    string? from, string? to, int? page, int? pageSize,
    string? model, string? status, string? provider, string? appCallerCode, string? transport, string? requestType) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType);

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
app.MapGet("/gw/logs/{id}", async (string id) =>
{
    var filter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var doc = await logs.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
    {
        return Json(ApiEnvelope<LlmLogDetail>.Fail("NOT_FOUND", "日志不存在"), jsonOptions, statusCode: 404);
    }
    return Json(ApiEnvelope<LlmLogDetail>.Ok(MapDetail(doc)), jsonOptions);
}).RequireAuthorization("LogsRead");

// ─────────────── 网关配置面（只读，腿 B 第一刀）───────────────
// 让网关控制台不只有日志，还能看模型池 / 平台 / 模型 / 影子比对。密钥字段一律不返回（只回 hasKey）。

// 模型池列表
app.MapGet("/gw/pools", async (string? modelType) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var filter = string.IsNullOrWhiteSpace(modelType) ? fb.Empty : fb.Eq("ModelType", modelType);
    var docs = await modelGroups.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync();
    var data = new PoolsData { Items = docs.Select(MapPool).ToList(), Total = docs.Count };
    return Json(ApiEnvelope<PoolsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 平台列表（密钥字段绝不外泄，只回 hasKey）
app.MapGet("/gw/platforms", async () =>
{
    var docs = await platforms.Find(FilterDefinition<BsonDocument>.Empty)
        .Sort(Builders<BsonDocument>.Sort.Ascending("Name")).ToListAsync();
    var data = new PlatformsData { Items = docs.Select(MapPlatform).ToList(), Total = docs.Count };
    return Json(ApiEnvelope<PlatformsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 模型列表（密钥字段绝不外泄，只回 hasKey）
app.MapGet("/gw/models", async (string? platformId, bool? enabled) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var fs = new List<FilterDefinition<BsonDocument>>();
    if (!string.IsNullOrWhiteSpace(platformId)) fs.Add(fb.Eq("PlatformId", platformId));
    if (enabled is not null) fs.Add(fb.Eq("Enabled", enabled.Value));
    var filter = fs.Count > 0 ? fb.And(fs) : fb.Empty;
    var docs = await models.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync();
    var data = new ModelsData { Items = docs.Select(MapModel).ToList(), Total = docs.Count };
    return Json(ApiEnvelope<ModelsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 影子比对：汇总 + 最近 N 条
app.MapGet("/gw/shadow-comparisons", async (int? limit, string? appCallerCode, string? kind, string? releaseCommit, double? sinceHours) =>
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
    var filter = filters.Count == 0 ? fb.Empty : fb.And(filters);
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
// 让控制台不只能看还能配置。当前开放最安全的布尔开关：平台/模型启用态、模型池默认标记。
// 均为定点字段更新（不碰密钥、不删数据），写入共享 Mongo 后 MAP 侧模型调度立即生效（同一份配置）。
// 密钥轮换 / 新建平台等更重的写操作后续再开。

// 平台启用/停用
app.MapPut("/gw/platforms/{id}/enabled", async (HttpContext http, string id, ToggleEnabledRequest body) =>
{
    // 缺 enabled 字段（空 body / 漏传）一律拒绝，避免默认 false 误关平台。
    if (body?.Enabled is not bool enabled) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "缺少 enabled 字段（true/false）"), jsonOptions, 400);
    var filter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var doc = await platforms.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<PlatformItem>.Fail("NOT_FOUND", $"平台不存在：{id}"), jsonOptions, 404);
    var update = Builders<BsonDocument>.Update.Set("Enabled", enabled).Set("UpdatedAt", DateTime.UtcNow);
    await platforms.UpdateOneAsync(filter, update);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "platform.set_enabled",
        targetType: "llmplatform",
        targetId: id,
        targetName: doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: BuildChangeDocument(("enabled", doc.AsNullableBool("Enabled"), enabled)));
    var fresh = await platforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 模型启用/停用
app.MapPut("/gw/models/{id}/enabled", async (HttpContext http, string id, ToggleEnabledRequest body) =>
{
    // 缺 enabled 字段一律拒绝，避免默认 false 误关模型。
    if (body?.Enabled is not bool enabled) return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "缺少 enabled 字段（true/false）"), jsonOptions, 400);
    var filter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var doc = await models.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<ModelItem>.Fail("NOT_FOUND", $"模型不存在：{id}"), jsonOptions, 404);
    var update = Builders<BsonDocument>.Update.Set("Enabled", enabled).Set("UpdatedAt", DateTime.UtcNow);
    await models.UpdateOneAsync(filter, update);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.set_enabled",
        targetType: "llmmodel",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: BuildChangeDocument(("enabled", doc.AsNullableBool("Enabled"), enabled)));
    var fresh = await models.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<ModelItem>.Ok(MapModel(fresh)), jsonOptions);
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
    var filter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var doc = await modelGroups.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池不存在：{id}"), jsonOptions, 404);
    var modelType = doc.GetStringOrEmpty("ModelType");
    // 非事务安全次序：先置本池为默认、再清同类型其它池。第二步万一失败是「暂时两个默认」（MAP 仍能选到一个），
    // 远好于「先清后置」失败=零默认。
    await modelGroups.UpdateOneAsync(filter, Builders<BsonDocument>.Update.Set("IsDefaultForType", true).Set("UpdatedAt", DateTime.UtcNow));
    var fb = Builders<BsonDocument>.Filter;
    var others = fb.And(fb.Eq("ModelType", modelType), fb.Ne("_id", id));
    var clearOthers = await modelGroups.UpdateManyAsync(others, Builders<BsonDocument>.Update.Set("IsDefaultForType", false).Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.set_default",
        targetType: "model_group",
        targetId: id,
        targetName: doc.AsNullableString("Name") ?? doc.AsNullableString("Code"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "isDefaultForType", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableBool("IsDefaultForType")) }, { "to", true } } },
            { "modelType", modelType },
            { "clearedOtherDefaultCount", clearOthers.ModifiedCount },
        });
    var fresh = await modelGroups.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.Run();


// ─────────────────────────────── 辅助函数 ───────────────────────────────

// 幂等播种管理员。优先级（从高到低）：
//   1) forceReset（LLMGW_ADMIN_FORCE_RESET=1）：破玻璃，显式重置 admin 口令 + 强制改密。
//   2) 已有账号：数据库哈希是长期权威，只保活，不再被 LLMGW_ADMIN_PASSWORD 覆盖。
//   3) 空库首次 bootstrap：用 LLMGW_ADMIN_PASSWORD；未设则内置 admin/admin + 首登强制改密。
static async Task SeedAdminAsync(
    IMongoDatabase db,
    IMongoCollection<BsonDocument> operationAudits,
    string username,
    string defaultPwd,
    bool forceReset = false,
    string? envPassword = null)
{
    var users = db.GetCollection<LlmGwUser>("llmgw_console_users");

    // 单管理员模型：禁用历史遗留的其它用户名账号（防「改名后旧账号仍可登」）。真要多用户时再引入用户管理。
    var deactivateOthers = Builders<LlmGwUser>.Update.Set(u => u.IsActive, false);
    var deactivated = await users.UpdateManyAsync(u => u.Username != username && u.IsActive, deactivateOthers);
    if (deactivated.ModifiedCount > 0)
    {
        await WriteSystemOperationAuditAsync(
            operationAudits,
            action: "admin.deactivate_legacy_users",
            targetType: "llmgw_console_user",
            targetId: null,
            targetName: "non-admin active users",
            success: true,
            reason: null,
            changes: new BsonDocument { { "deactivatedCount", deactivated.ModifiedCount } });
    }

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
                });
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
                });
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
                changes: BuildChangeDocument(("isActive", false, true)));
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
            });
    }
    catch (MongoWriteException)
    {
        // 并发启动场景下可能撞唯一冲突/重复插入，忽略即可（幂等）。
    }
}

static async Task WriteLoginAuditAsync(
    IMongoCollection<LlmGwLoginAudit> audits,
    HttpContext http,
    string username,
    string? userId,
    bool success,
    string? reason)
{
    try
    {
        await audits.InsertOneAsync(new LlmGwLoginAudit
        {
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

        var doc = new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") },
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
    BsonDocument? changes = null)
{
    try
    {
        var doc = new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") },
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
    string? requestType)
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

static LlmLogListItem MapListItem(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    RequestId = d.GetStringOrEmpty("RequestId"),
    Provider = d.GetStringOrEmpty("Provider"),
    Model = d.GetStringOrEmpty("Model"),
    PlatformId = d.AsNullableString("PlatformId"),
    PlatformName = d.AsNullableString("PlatformName"),
    GroupId = d.AsNullableString("GroupId"),
    SessionId = d.AsNullableString("SessionId"),
    UserId = d.AsNullableString("UserId"),
    Username = null,
    DisplayName = null,
    RequestType = d.AsNullableString("RequestType"),
    AppCallerCode = d.AsNullableString("AppCallerCode"),
    AppCallerCodeDisplayName = d.AsNullableString("AppCallerCodeDisplayName"),
    Status = d.GetStringOrEmpty("Status"),
    StartedAt = d.AsNullableUtcDateTime("StartedAt").ToIso(),
    FirstByteAt = d.AsNullableUtcDateTime("FirstByteAt").ToIso(),
    EndedAt = d.AsNullableUtcDateTime("EndedAt").ToIso(),
    DurationMs = d.AsNullableLong("DurationMs"),
    StatusCode = d.AsNullableInt("StatusCode"),
    InputTokens = d.AsNullableInt("InputTokens"),
    OutputTokens = d.AsNullableInt("OutputTokens"),
    Error = d.AsNullableString("Error"),
    IsFallback = d.AsNullableBool("IsFallback"),
    ExpectedModel = d.AsNullableString("ExpectedModel"),
    Protocol = d.AsNullableString("Protocol"),
    ResolutionReason = d.AsNullableString("ResolutionReason"),
    Transport = d.AsNullableString("GatewayTransport"),
    ToolCallCount = d.AsNullableInt("ToolCallCount"),
    FinishReason = d.AsNullableString("FinishReason"),
    IsStreaming = d.AsNullableBool("IsStreaming"),
};

static LlmLogDetail MapDetail(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    RequestId = d.GetStringOrEmpty("RequestId"),
    GroupId = d.AsNullableString("GroupId"),
    SessionId = d.AsNullableString("SessionId"),
    UserId = d.AsNullableString("UserId"),
    RequestType = d.AsNullableString("RequestType"),
    AppCallerCode = d.AsNullableString("AppCallerCode"),
    AppCallerCodeDisplayName = d.AsNullableString("AppCallerCodeDisplayName"),
    Provider = d.GetStringOrEmpty("Provider"),
    Model = d.GetStringOrEmpty("Model"),
    RequestBodyRedacted = d.AsNullableString("RequestBodyRedacted"),
    SystemPromptText = d.AsNullableString("SystemPromptText"),
    QuestionText = d.AsNullableString("QuestionText"),
    AnswerText = d.AsNullableString("AnswerText"),
    ThinkingText = d.AsNullableString("ThinkingText"),
    ResponseToolCalls = d.AsNullableString("ResponseToolCalls"),
    ToolCallCount = d.AsNullableInt("ToolCallCount"),
    InputTokens = d.AsNullableInt("InputTokens"),
    OutputTokens = d.AsNullableInt("OutputTokens"),
    StartedAt = d.AsNullableUtcDateTime("StartedAt").ToIso(),
    FirstByteAt = d.AsNullableUtcDateTime("FirstByteAt").ToIso(),
    EndedAt = d.AsNullableUtcDateTime("EndedAt").ToIso(),
    DurationMs = d.AsNullableLong("DurationMs"),
    Status = d.GetStringOrEmpty("Status"),
    StatusCode = d.AsNullableInt("StatusCode"),
    IsFallback = d.AsNullableBool("IsFallback"),
    FallbackReason = d.AsNullableString("FallbackReason"),
    ExpectedModel = d.AsNullableString("ExpectedModel"),
    Protocol = d.AsNullableString("Protocol"),
    ResolutionReason = d.AsNullableString("ResolutionReason"),
    Transport = d.AsNullableString("GatewayTransport"),
    FinishReason = d.AsNullableString("FinishReason"),
    IsStreaming = d.AsNullableBool("IsStreaming"),
    Error = d.AsNullableString("Error"),
};

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

static PoolItem MapPool(BsonDocument d)
{
    var modelsArr = d.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var items = new List<PoolModelItem>();
    foreach (var m in modelsArr)
    {
        if (!m.IsBsonDocument) continue;
        var md = m.AsBsonDocument;
        var hs = md.AsNullableInt("HealthStatus") ?? 0;
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
            InputPricePerMillion = md.AsNullableDecimal("InputPricePerMillion"),
            OutputPricePerMillion = md.AsNullableDecimal("OutputPricePerMillion"),
            PricePerCall = md.AsNullableDecimal("PricePerCall"),
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
        CallCount = d.AsNullableLong("CallCount") ?? 0,
        SuccessCount = d.AsNullableLong("SuccessCount") ?? 0,
        FailCount = d.AsNullableLong("FailCount") ?? 0,
        TotalDuration = d.AsNullableLong("TotalDuration") ?? 0,
        Capabilities = caps,
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
    };
}

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
