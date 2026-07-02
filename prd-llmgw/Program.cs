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

// 网关控制台登录账号：固定内置 admin/admin 引导，口令改在 UI 里改（首登强制改密），**不依赖任何 env**。
// 用户 2026-07-02 明确要求「简单清晰，内置初始 admin/admin，登录进去再改；不要 fail-closed 的复杂环境变量
// 编排」。而且实测 CDS 的 _global env 不保证注入 llmgw 容器：靠 LLMGW_ADMIN_PASSWORD 设口令时，一旦注入
// 的是陈旧/不可控的值，seed 会把 admin 对齐到未知口令 → 控制台永久锁死、既登不进也无法用 env/DB 恢复。
// 故彻底移除 env 口令路径：seed 只认「内置 admin/admin 引导 + 首登强制改密 + UI 改密后保留」，
// 保证控制台永远能从 admin/admin 进入（「重置」= 重新部署即可），完全免疫 env 注入问题。
const string AdminUser = "admin";
const string DefaultAdminPwd = "admin";

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
builder.Services.AddAuthorization(options =>
{
    // 首登强制改密门：拒绝 mcp=1 的 token 访问日志端点（该 token 只能调 change-password）。
    // 服务端强制（而非仅前端守卫），确保缺省 admin/admin 在改密前无法真正读取观测数据。
    options.AddPolicy("LogsRead", policy =>
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

// ── 启动时幂等播种管理员账户（内置 admin/admin 引导，env 无关）──
await SeedAdminAsync(database, AdminUser, DefaultAdminPwd);

var logs = database.GetCollection<BsonDocument>("llmrequestlogs");
var users = database.GetCollection<LlmGwUser>("llmgw_users");
// 网关配置面（只读）：模型池 / 平台 / 模型 / 影子比对。与 MAP 共享同库，控制台只读展示。
var modelGroups = database.GetCollection<BsonDocument>("model_groups");
var platforms = database.GetCollection<BsonDocument>("llmplatforms");
var models = database.GetCollection<BsonDocument>("llmmodels");
var shadows = database.GetCollection<BsonDocument>("llmshadow_comparisons");

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
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("INVALID_CREDENTIALS", "旧口令错误"), jsonOptions);
    }

    var update = Builders<LlmGwUser>.Update
        .Set(u => u.PasswordHash, PasswordHasher.Hash(newPwd))
        .Set(u => u.MustChangePassword, false)
        // 标记为真人认领：默认模式下重启不再自愈回 admin/admin，保住用户新口令。
        .Set(u => u.PasswordChangedByUser, true);
    await users.UpdateOneAsync(u => u.Id == user.Id, update);

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
}).RequireAuthorization("LogsRead");

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
}).RequireAuthorization("LogsRead");

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
}).RequireAuthorization("LogsRead");

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
app.MapGet("/gw/shadow-comparisons", async (int? limit, string? appCallerCode) =>
{
    var n = Math.Clamp(limit ?? 50, 1, 500);
    var fb = Builders<BsonDocument>.Filter;
    var filter = string.IsNullOrWhiteSpace(appCallerCode) ? fb.Empty : fb.Eq("AppCallerCode", appCallerCode);
    var total = await shadows.CountDocumentsAsync(filter);
    var allMatch = await shadows.CountDocumentsAsync(fb.And(filter, fb.Eq("AllMatch", true)));
    var critical = await shadows.CountDocumentsAsync(fb.And(filter, fb.Eq("HasCritical", true)));
    var httpFail = await shadows.CountDocumentsAsync(fb.And(filter, fb.Eq("HttpOk", false)));
    var recent = await shadows.Find(filter).Sort(Builders<BsonDocument>.Sort.Descending("ComparedAt")).Limit(n).ToListAsync();
    var data = new ShadowData
    {
        Summary = new ShadowSummary { Total = total, AllMatch = allMatch, Critical = critical, HttpFail = httpFail },
        Recent = recent.Select(MapShadow).ToList(),
    };
    return Json(ApiEnvelope<ShadowData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

app.Run();


// ─────────────────────────────── 辅助函数 ───────────────────────────────

// 幂等播种管理员：内置 admin/admin 引导 + 首登强制改密 + UI 改密后保留。完全不依赖 env（免疫 CDS 注入问题）。
// 语义：未被真人认领的 admin（含历史遗留、口令未知的旧文档）每次启动**确定性自愈回 admin/admin**，
// 保证控制台永远能从 admin/admin 进入（「重置」= 重新部署）；用户在 UI 改过口令后（PasswordChangedByUser=true）
// 则保留其口令、跨重启不回退。
static async Task SeedAdminAsync(IMongoDatabase db, string username, string defaultPwd)
{
    var users = db.GetCollection<LlmGwUser>("llmgw_users");

    // 单管理员模型：禁用历史遗留的其它用户名账号（防「改名后旧账号仍可登」）。真要多用户时再引入用户管理。
    var deactivateOthers = Builders<LlmGwUser>.Update.Set(u => u.IsActive, false);
    await users.UpdateManyAsync(u => u.Username != username && u.IsActive, deactivateOthers);

    var existing = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
    if (existing is not null)
    {
        if (existing.PasswordChangedByUser)
        {
            // 已被真人认领（在 UI 改过口令）→ 库里存的是用户口令，**绝不回退**，只确保启用。
            if (!existing.IsActive)
            {
                await users.UpdateOneAsync(u => u.Username == username,
                    Builders<LlmGwUser>.Update.Set(u => u.IsActive, true));
            }
            return;
        }

        // 从未被认领（含**历史遗留 admin**：口令未知、PasswordChangedByUser 缺省=false）→ 确定性自愈回
        // admin/admin + 强制改密。幂等：仅当已漂移（口令非 admin / 未挂强制改密标记 / 被禁用）时才写库。
        var needsReset = !PasswordHasher.Verify(defaultPwd, existing.PasswordHash)
            || !existing.MustChangePassword
            || !existing.IsActive;
        if (needsReset)
        {
            await users.UpdateOneAsync(u => u.Username == username,
                Builders<LlmGwUser>.Update
                    .Set(u => u.PasswordHash, PasswordHasher.Hash(defaultPwd))
                    .Set(u => u.IsActive, true)
                    .Set(u => u.MustChangePassword, true)
                    .Set(u => u.PasswordChangedByUser, false));
        }
        return;
    }

    var user = new LlmGwUser
    {
        Username = username,
        PasswordHash = PasswordHasher.Hash(defaultPwd),
        DisplayName = username,
        IsActive = true,
        MustChangePassword = true,       // 首登强制改密，消除「公网 admin/admin 永久裸奔」
        PasswordChangedByUser = false,
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
