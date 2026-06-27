// AI 大模型网关 —— 独立观测/登录后端（与 MAP 物理隔离）。
//
// 设计意图（见 doc/design.llm-gateway-physical-isolation.md）：
//   - 本服务与 prd-api 完全解耦，不引用任何 PrdAgent.* 项目，仅依赖 NuGet 包。
//   - 与 MAP 共享同一个 MongoDB（读取共享集合 llmrequestlogs），但拥有独立的 JWT 账户体系
//     （独立密钥 LlmGwJwt:Secret），满足 cross-project-isolation 规则——绝不复用 MAP 的 Jwt 密钥。
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

var jwtSecret = config["LlmGwJwt:Secret"] ?? "llmgw-dev-secret-change-me-please-0001";
var jwtIssuer = config["LlmGwJwt:Issuer"] ?? "prdagent-llmgw";
if (Encoding.UTF8.GetByteCount(jwtSecret) < 32)
{
    // HS256 要求密钥足够长；过短则回落到带提示的开发占位密钥，避免启动即崩。
    jwtSecret = "llmgw-dev-secret-change-me-please-0001";
}

var seedAdminUser = Environment.GetEnvironmentVariable("LLMGW_ADMIN_USER") ?? "admin";
var seedAdminPwd = Environment.GetEnvironmentVariable("LLMGW_ADMIN_PASSWORD") ?? "llmgw-admin-2026";

var gitCommit = Environment.GetEnvironmentVariable("GIT_COMMIT") ?? "";

// ── Mongo 客户端（单例）──
var mongoClient = new MongoClient(mongoConn);
var database = mongoClient.GetDatabase(mongoDb);
builder.Services.AddSingleton(mongoClient);
builder.Services.AddSingleton(database);

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
builder.Services.AddAuthorization();

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

// ── 启动时幂等播种管理员账户 ──
await SeedAdminAsync(database, seedAdminUser, seedAdminPwd);

var logs = database.GetCollection<BsonDocument>("llmrequestlogs");
var users = database.GetCollection<LlmGwUser>("llmgw_users");

// ───────────────────────────── 健康检查（匿名）─────────────────────────────
app.MapGet("/gw/healthz", () => Results.Json(new
{
    status = "ok",
    commit = gitCommit,
    time = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
}, jsonOptions)).AllowAnonymous();

// ───────────────────────────── 登录（匿名）─────────────────────────────
// 登录失败返回 HTTP 200 + success:false，避免前端把 401 当作"会话过期"自动清 session。
app.MapPost("/gw/auth/login", async ([FromBody] LoginRequestDto req) =>
{
    var username = (req.Username ?? "").Trim();
    var password = req.Password ?? "";
    if (username.Length == 0 || password.Length == 0)
    {
        return Json(ApiEnvelope<LoginResultDto>.Fail("INVALID_CREDENTIALS", "用户名或密码不能为空"), jsonOptions);
    }

    var user = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
    if (user is null || !user.IsActive || !PasswordHasher.Verify(password, user.PasswordHash))
    {
        return Json(ApiEnvelope<LoginResultDto>.Fail("INVALID_CREDENTIALS", "用户名或密码错误"), jsonOptions);
    }

    var (token, expiresAt) = gwJwt.Issue(user);
    var data = new LoginResultDto
    {
        Token = token,
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
    };
    return Json(ApiEnvelope<LoginResultDto>.Ok(data), jsonOptions);
}).AllowAnonymous();

// ───────────────────────────── 日志列表（需鉴权）─────────────────────────────
app.MapGet("/gw/logs", async (
    int? page, int? pageSize, string? from, string? to, string? model, string? status) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = BuildFilter(fromUtc, toUtc, model, status);

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
}).RequireAuthorization();

// ───────────────────────────── 元信息（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/meta", async () =>
{
    var since = DateTime.UtcNow.AddDays(-30);
    var recent = Builders<BsonDocument>.Filter.Gte("StartedAt", since);

    var modelsRaw = await logs.Distinct<string>("Model", recent).ToListAsync();
    var statusesRaw = await logs.Distinct<string>("Status", recent).ToListAsync();

    var models = modelsRaw
        .Where(m => !string.IsNullOrWhiteSpace(m))
        .Distinct()
        .OrderBy(m => m, StringComparer.OrdinalIgnoreCase)
        .Take(200)
        .ToList();
    var statuses = statusesRaw
        .Where(s => !string.IsNullOrWhiteSpace(s))
        .Distinct()
        .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
        .ToList();

    return Json(ApiEnvelope<LogsMeta>.Ok(new LogsMeta { Models = models, Statuses = statuses }), jsonOptions);
}).RequireAuthorization();

// ───────────────────────────── 时间序列（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/timeseries", async (string? from, string? to, string? model, string? status) =>
{
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = BuildFilter(fromUtc, toUtc, model, status);

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
}).RequireAuthorization();

// ───────────────────────────── 会话聚合（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/sessions", async (string? from, string? to, int? page, int? pageSize) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = BuildFilter(fromUtc, toUtc, null, null);

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
}).RequireAuthorization();

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
}).RequireAuthorization();

app.Run();


// ─────────────────────────────── 辅助函数 ───────────────────────────────

// 幂等播种管理员：用户名不存在才插入。
static async Task SeedAdminAsync(IMongoDatabase db, string username, string password)
{
    var users = db.GetCollection<LlmGwUser>("llmgw_users");
    var existing = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
    if (existing is not null) return;

    var user = new LlmGwUser
    {
        Username = username,
        PasswordHash = PasswordHasher.Hash(password),
        DisplayName = username,
        IsActive = true,
        Scopes = new[] { "logs:read" },
        CreatedAt = DateTime.UtcNow,
    };
    try
    {
        await users.InsertOneAsync(user);
    }
    catch (MongoWriteException)
    {
        // 并发启动场景下可能撞唯一冲突/重复插入，忽略即可（幂等）。
    }
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

// 构建 StartedAt 时间窗 + 可选 model/status 过滤器。
static FilterDefinition<BsonDocument> BuildFilter(DateTime fromUtc, DateTime toUtc, string? model, string? status)
{
    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>
    {
        fb.Gte("StartedAt", fromUtc),
        fb.Lt("StartedAt", toUtc),
    };
    if (!string.IsNullOrWhiteSpace(model)) filters.Add(fb.Eq("Model", model));
    if (!string.IsNullOrWhiteSpace(status)) filters.Add(fb.Eq("Status", status));
    return fb.And(filters);
}

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

// 统一 JSON 输出（带信封 + 指定状态码）。
static IResult Json<T>(T value, JsonSerializerOptions options, int statusCode = 200)
    => Results.Json(value, options, statusCode: statusCode);
