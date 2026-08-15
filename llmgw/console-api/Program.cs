// AI 大模型网关 —— 独立观测/登录后端（与 MAP 物理隔离）。
//
// 设计意图（见 doc/design.platform.llm-gateway.physical-isolation.md）：
//   - 本服务与 prd-api 完全解耦，不引用任何 PrdAgent.* 项目，仅依赖 NuGet 包。
//   - MAP 继续负责 MAP 自己的业务日志；GW 控制台账号、登录审计等自有状态落独立数据库 llm_gateway。
//   - 控制台读取 GW 自有 llmrequestlogs / shadow / 审计作为权威观测；MAP 业务日志只作为跨系统关联来源。
//   - 共享集合 llmrequestlogs 由 .NET 驱动以 PascalCase 字段名序列化；为规避历史文档里
//     数值/日期类型混存导致的反序列化异常，日志查询统一以 BsonDocument 读取并手动安全映射。

using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Net;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Costs;
using PrdAgent.LlmGw.Governance;
using PrdAgent.LlmGw.ModelPools;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.Organization;
using PrdAgent.LlmGw.Provisioning;
using PrdAgent.LlmGw.LogicalModels;
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
const string TenantAggregateAppCallerCode = "$tenant";
const string TenantAggregateRequestType = "$aggregate";

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
// - 默认模式下，长期权威是 llm_gateway.llmgw_console_users 里的 PBKDF2 哈希，UI 改密后重启不被 env 覆盖。
// - LLMGW_ADMIN_ENV_AUTHORITY=1 时，LLMGW_ADMIN_PASSWORD 是长期权威；启动只在检测到漂移时修复，
//   密码和状态一致时不写库、不递增 SecurityVersion，避免每次重启让已有会话失效。
// - LLMGW_ADMIN_FORCE_RESET 保留为兼容的一次性破玻璃开关，同样采用幂等修复。
// - 未设 bootstrap 口令时，内置 admin/admin 引导 + 首登强制改密，避免新环境锁死。
const string AdminUser = "admin";
const string DefaultAdminPwd = "admin";

var gitCommit = Environment.GetEnvironmentVariable("GIT_COMMIT") ?? "";

// 本分支主入口（= MAP 所在地址），由平台在部署时注入（cds/src/services/preview-entrypoints.ts）。
// 控制台的「返回 MAP」「教程」深链此前靠 location.hostname 剥子域后缀反推，那是 CDS 之外的
// 又一份域名实现（根 CLAUDE.md 规则 #11 禁止），子域一改名就整片失效。改由服务端如实下发：
// 有就用，没有（正式环境 / 非 CDS 托管）就为空，前端退回原来的推算兜底。
var mapHomeUrl = Environment.GetEnvironmentVariable("CDS_PREVIEW_URL")?.Trim();

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
// 会话默认 7 天且用后自动续期（响应头 X-Gw-Token 换发），只要在用就不会掉登录。
// 撤销不依赖 token 过期：每个已鉴权请求都会重新校验 SecurityVersion / 成员版本 / 租户状态。
var jwtLifetimeDays = config.GetValue<int>("LlmGwJwt:LifetimeDays", GwJwt.DefaultLifetimeDays);
var jwtRenewAfterHours = config.GetValue<int>("LlmGwJwt:RenewAfterHours", GwJwt.DefaultRenewAfterHours);
var gwJwt = new GwJwt(jwtSecret, jwtIssuer, jwtLifetimeDays, jwtRenewAfterHours);
// MAP 一键登录（联邦会话）时长：默认与普通会话一致；需要收紧回旧的 15 分钟时配置该值即可。
var mapSsoLifetimeMinutes = config.GetValue<int>("LlmGwJwt:MapSsoLifetimeMinutes", 0);
var mapSsoLifetime = mapSsoLifetimeMinutes > 0
    ? TimeSpan.FromMinutes(mapSsoLifetimeMinutes)
    : gwJwt.Lifetime;
// 显式配置了收紧，就意味着「这条联邦会话必须在某个固定时刻死掉」。
// 续签时必须按**剩余**时效签，不能重新给满：否则 15 分钟的 SSO 会话
// 设一次口令、或切一次租户，就换成多天的 token，而 fed_session 带着的
// 免旧口令特权会一起延长——反复调用甚至能无限续命（Codex PR #1364 P1）。
// 没配置（默认与普通会话同为 7 天）时保持原样，续签照常给满，
// 不动「用过就自动延长」的既有体验。
// 只有**真的收紧了**才算硬截止。配成 >= 常规时长时 Issue 会把它 cap 回 _lifetime，
// 于是 TryRenew 的「originalLifetime < _lifetime 才跳过」判据认不出它，中间件照常滑动续期，
// fed_session 跟着无限延长——那样这个 flag 就是个假承诺（Codex PR #1364 P2）。
// 判据跟着实际效果走，而不是跟着「配了没配」走。
var mapSsoLifetimeIsHardDeadline = mapSsoLifetimeMinutes > 0 && mapSsoLifetime < gwJwt.Lifetime;
builder.Services.AddSingleton(gwJwt);

// 联邦会话续签的**绝对**到期时刻：原样沿用当前 token 的 exp，一秒都不往后挪。
//
// 上一版返回的是「剩余时长」，栽在 Issue 的 5 分钟下限上：只剩 2 分钟会被抬成 5 分钟，
// 每 2 分钟续一次就能无限续命。所以这里必须给绝对时刻，由 Issue 走 absoluteExpiresAt
// 分支绕开那个下限（Codex PR #1364 P1 第二轮）。
//
// 取不到 exp、或 exp 已经过去，都返回 null，调用方据此**拒绝续签**而不是给满——
// 读不出截止时刻、或截止时刻已到时，唯一安全的动作都是不发新 token。
//
// 「已经过去」这一支不是假想输入：JwtBearer 配了 1 分钟 ClockSkew（见下方鉴权配置），
// token 过期后一分钟内仍然能通过鉴权。此时 exp 在过去，若直接拿去签发，
// JwtSecurityToken 会因为 expires <= notBefore 抛异常（Codex PR #1364 P2）。
// 上一版我只 clamp 了「太远的未来」，没管「已经过去」——又是只覆盖了一个方向。
static DateTime? FederatedHardDeadline(HttpContext http, bool hardDeadline)
{
    if (!hardDeadline) return null;
    var raw = http.User.FindFirst("exp")?.Value;
    if (!long.TryParse(raw, out var unix)) return null;
    var deadline = DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime;
    return deadline > DateTime.UtcNow ? deadline : null;
}

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
    options.AddPolicy("AppCallerWrite", policy =>
        policy.RequireAuthenticatedUser()
            .RequireAssertion(ctx => !ctx.User.HasClaim(c => c.Type == "mcp" && c.Value == "1")
                && TenantAccess.HasPermission(ctx.User, LlmGwPermissions.AppCallerWrite)));
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
    p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()
        // 滑动续期换发的新 token 走响应头下发，跨源前端必须能读到这两个头。
        .WithExposedHeaders(GwSessionHeaders.Token, GwSessionHeaders.TokenExpiresAt)));

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

// ── 启动时幂等播种管理员账户（内置 admin/admin 引导，可选 env 长期托管）──
// 破玻璃（break-glass）：设 LLMGW_ADMIN_FORCE_RESET 为真值（1/true/yes/on，大小写不敏感）时，显式校准 admin
// 口令。用于「账号被认领但口令登不进」的死锁恢复。恢复后请把该 env 清掉。
// **仅认真值**（Bugbot Medium）：只判「非空」会把 =0 / =false 误当开启，每次启动强制回 admin/admin 反而擦掉 env 口令。
// 永久在线模式：LLMGW_ADMIN_ENV_AUTHORITY=1 时，env 是 admin 口令权威。该模式要求显式配置非默认强口令。
var forceResetRaw = (Environment.GetEnvironmentVariable("LLMGW_ADMIN_FORCE_RESET") ?? string.Empty).Trim();
var forceResetAdmin = new[] { "1", "true", "yes", "on" }.Contains(forceResetRaw, StringComparer.OrdinalIgnoreCase);
var envAuthorityRaw = (Environment.GetEnvironmentVariable("LLMGW_ADMIN_ENV_AUTHORITY") ?? string.Empty).Trim();
var envAuthorityAdmin = new[] { "1", "true", "yes", "on" }.Contains(envAuthorityRaw, StringComparer.OrdinalIgnoreCase);
var adminBootstrapPwd = Environment.GetEnvironmentVariable("LLMGW_ADMIN_PASSWORD")?.Trim();
if (envAuthorityAdmin && (!GwPasswordPolicy.MeetsMinimumLength(adminBootstrapPwd) || adminBootstrapPwd == DefaultAdminPwd))
{
    throw new InvalidOperationException(
        $"LLMGW_ADMIN_ENV_AUTHORITY 已启用，但 LLMGW_ADMIN_PASSWORD 未达到至少 {GwPasswordPolicy.MinimumLength} 位的口令规则或仍为默认弱口令。" +
        "请先配置独立强口令；服务拒绝以不可用的破窗账户启动。");
}
var operationAudits = gatewayDatabase.GetCollection<BsonDocument>("llmgw_operation_audits");
await SeedAdminAsync(
    gatewayDatabase,
    operationAudits,
    AdminUser,
    DefaultAdminPwd,
    internalTenantId,
    forceResetAdmin,
    envAuthorityAdmin,
    adminBootstrapPwd);

// GW 请求日志由 llmgw-serve 写入独立 llm_gateway 库；控制台和 runtime gates 必须读取同一权威来源。
var logs = gatewayDatabase.GetCollection<BsonDocument>("llmrequestlogs");
// GW 自有账号和审计落独立库 llm_gateway，避免被 MAP 项目 env / shared DB 状态覆盖。
var users = gatewayDatabase.GetCollection<LlmGwUser>("llmgw_console_users");
var tenants = gatewayDatabase.GetCollection<LlmGwTenant>("llmgw_tenants");
var teams = gatewayDatabase.GetCollection<LlmGwTeam>("llmgw_teams");
var memberships = gatewayDatabase.GetCollection<LlmGwMembership>("llmgw_memberships");
var recoveryOperations = gatewayDatabase.GetCollection<GatewayRecoveryOperation>("llmgw_recovery_operations");
var loginAudits = gatewayDatabase.GetCollection<LlmGwLoginAudit>("llmgw_login_audits");
var mapSsoTickets = gatewayDatabase.GetCollection<BsonDocument>("llmgw_map_sso_tickets");
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
var gwModelPoolTypes = gatewayDatabase.GetCollection<BsonDocument>("llmgw_model_pool_types");
var gwPlatforms = gatewayDatabase.GetCollection<BsonDocument>("llmgw_platforms");
var gwModels = gatewayDatabase.GetCollection<BsonDocument>("llmgw_models");
var gwLogicalModels = gatewayDatabase.GetCollection<BsonDocument>("llmgw_logical_models");
var gwModelOfferings = gatewayDatabase.GetCollection<BsonDocument>("llmgw_model_offerings");
var gwModelExchanges = gatewayDatabase.GetCollection<BsonDocument>("llmgw_model_exchanges");
var serviceKeys = gatewayDatabase.GetCollection<BsonDocument>("llmgw_service_keys");
var serviceKeyDirectory = gatewayDatabase.GetCollection<BsonDocument>("llmgw_service_key_directory");
var serviceKeyRateWindows = gatewayDatabase.GetCollection<BsonDocument>("llmgw_service_key_rate_windows");
var tenantRateWindows = gatewayDatabase.GetCollection<BsonDocument>("llmgw_tenant_rate_windows");
var budgetMonths = gatewayDatabase.GetCollection<BsonDocument>("llmgw_budget_months");
var costReconciliations = gatewayDatabase.GetCollection<BsonDocument>("llmgw_cost_reconciliations");
var costImportScopeLocks = gatewayDatabase.GetCollection<BsonDocument>("llmgw_cost_import_scope_locks");
var legacyKeyCutovers = gatewayDatabase.GetCollection<BsonDocument>("llmgw_legacy_key_cutovers");
var legacyKeyUsage = gatewayDatabase.GetCollection<BsonDocument>("llmgw_legacy_key_usage");
await LogicalModelCapabilityPolicy.BackfillLegacyGenerationModelsAsync(
    gwLogicalModels,
    CancellationToken.None);
await BackfillInternalTenantAsync(gatewayDatabase, internalTenantId, CancellationToken.None);
await EnsureInternalTenantAsync(
    users,
    tenants,
    teams,
    memberships,
    AdminUser,
    internalTenantId,
    CancellationToken.None);
await recoveryOperations.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<GatewayRecoveryOperation>(
        Builders<GatewayRecoveryOperation>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.LeaseExpiresAt),
        new CreateIndexOptions { Name = "idx_llmgw_recovery_status_lease" }),
    new CreateIndexModel<GatewayRecoveryOperation>(
        Builders<GatewayRecoveryOperation>.IndexKeys.Ascending(x => x.TenantId).Descending(x => x.CreatedAt),
        new CreateIndexOptions { Name = "idx_llmgw_recovery_tenant_created" }),
});
await GatewayRecoveryOperations.RepairExpiredAsync(gatewayDatabase);
await TenantOwnerAuthority.BackfillAsync(tenants, memberships);
await users.Indexes.CreateOneAsync(new CreateIndexModel<LlmGwUser>(
    Builders<LlmGwUser>.IndexKeys.Ascending(x => x.Username),
    new CreateIndexOptions { Name = "uniq_llmgw_console_user_username", Unique = true }));
await users.Indexes.CreateOneAsync(new CreateIndexModel<LlmGwUser>(
    Builders<LlmGwUser>.IndexKeys.Ascending(x => x.IdentityProvider).Ascending(x => x.ExternalSubjectId),
    new CreateIndexOptions<LlmGwUser>
    {
        Name = "uniq_llmgw_console_user_external_subject",
        Unique = true,
        PartialFilterExpression = Builders<LlmGwUser>.Filter.And(
            Builders<LlmGwUser>.Filter.Type(x => x.IdentityProvider, BsonType.String),
            Builders<LlmGwUser>.Filter.Type(x => x.ExternalSubjectId, BsonType.String)),
    }));
await mapSsoTickets.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("CodeHash"),
        new CreateIndexOptions { Name = "uniq_llmgw_map_sso_code_hash", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
        new CreateIndexOptions { Name = "ttl_llmgw_map_sso_expires", ExpireAfter = TimeSpan.Zero }),
});
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
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("TeamId").Ascending("ClientCode").Ascending("Environment").Ascending("Purpose"),
        // 存量库已有不含 Purpose 的同名索引；用途扩维必须用新名字做纯加法迁移。
        new CreateIndexOptions { Name = "idx_llmgw_service_key_tenant_workload_purpose" }),
});
await logs.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys
        .Ascending("TenantId")
        .Ascending("TeamId")
        .Ascending("ServiceKeyId")
        .Ascending("ClientCode")
        .Ascending("Environment")
        .Descending("StartedAt"),
    new CreateIndexOptions { Name = "idx_llmgw_logs_tenant_workload_started" }));
await logs.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys
        .Ascending("TenantId")
        .Ascending("Provider")
        .Ascending("ProviderRequestId"),
    new CreateIndexOptions { Name = "idx_llmgw_logs_tenant_provider_request" }));
await logs.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys
        .Ascending("TenantId")
        .Ascending("ProviderTaskId"),
    new CreateIndexOptions { Name = "idx_llmgw_logs_tenant_provider_task" }));
await serviceKeyRateWindows.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("ServiceKeyId").Ascending("WindowStart"),
        new CreateIndexOptions { Name = "uniq_llmgw_service_key_rate_tenant_window", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
        new CreateIndexOptions { Name = "ttl_llmgw_service_key_rate_windows", ExpireAfter = TimeSpan.Zero }),
});
await tenantRateWindows.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("WindowStart"),
        new CreateIndexOptions { Name = "uniq_llmgw_tenant_rate_window", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
        new CreateIndexOptions { Name = "ttl_llmgw_tenant_rate_windows", ExpireAfter = TimeSpan.Zero }),
});
await costReconciliations.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Provider").Ascending("ExternalRecordId"),
        new CreateIndexOptions { Name = "uniq_llmgw_cost_tenant_provider_external", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Provider").Ascending("ProviderRequestId"),
        new CreateIndexOptions<BsonDocument>
        {
            Name = "uniq_llmgw_cost_tenant_provider_request",
            Unique = true,
            PartialFilterExpression = Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("Granularity", "request"),
                Builders<BsonDocument>.Filter.Type("ProviderRequestId", BsonType.String)),
        }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("TeamId").Ascending("ServiceKeyId").Descending("BilledAt"),
        new CreateIndexOptions { Name = "idx_llmgw_cost_tenant_key_billed" }),
});
await costImportScopeLocks.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Provider").Ascending("TeamId"),
        new CreateIndexOptions { Name = "uniq_llmgw_cost_import_lock_tenant_provider_team", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
        new CreateIndexOptions { Name = "ttl_llmgw_cost_import_scope_locks", ExpireAfter = TimeSpan.Zero }),
});
await legacyKeyCutovers.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys.Ascending("TenantId"),
    new CreateIndexOptions { Name = "uniq_llmgw_legacy_cutover_tenant", Unique = true }));
await legacyKeyUsage.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys
            .Ascending("TenantId")
            .Ascending("SourceSystem")
            .Ascending("AppCallerCode")
            .Ascending("IngressProtocol"),
        new CreateIndexOptions { Name = "uniq_llmgw_legacy_usage_tenant_identity", Unique = true }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Descending("LastSeenAt"),
        new CreateIndexOptions { Name = "idx_llmgw_legacy_usage_tenant_seen" }),
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
await gwAppCallers.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys
        .Ascending("TenantId")
        .Ascending("AppCallerCode")
        .Ascending("RequestType"),
    new CreateIndexOptions<BsonDocument>
    {
        Name = "uniq_llmgw_app_callers_tenant_code_request_type",
        Unique = true,
        Collation = new Collation("en", strength: CollationStrength.Secondary),
    }));
await gwModelPools.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Code"),
    new CreateIndexOptions<BsonDocument>
    {
        Name = "uniq_llmgw_managed_pool_tenant_code",
        Unique = true,
        PartialFilterExpression = Builders<BsonDocument>.Filter.Eq("ManagedByRegistry", true),
    }));
await gwModelPoolTypes.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
    Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Code"),
    new CreateIndexOptions { Name = "uniq_llmgw_pool_type_tenant_code", Unique = true }));
await gwPlatforms.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("NameNormalized"),
        new CreateIndexOptions<BsonDocument>
        {
            Name = "uniq_llmgw_platform_tenant_name_normalized",
            Unique = true,
            PartialFilterExpression = Builders<BsonDocument>.Filter.Type("NameNormalized", BsonType.String),
        }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Descending("UpdatedAt"),
        new CreateIndexOptions { Name = "idx_llmgw_platform_tenant_updated" }),
});
await gwModels.Indexes.CreateManyAsync(new[]
{
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("PlatformId").Ascending("ModelNameNormalized"),
        new CreateIndexOptions<BsonDocument>
        {
            Name = "uniq_llmgw_model_tenant_platform_name_normalized",
            Unique = true,
            PartialFilterExpression = Builders<BsonDocument>.Filter.Type("ModelNameNormalized", BsonType.String),
        }),
    new CreateIndexModel<BsonDocument>(
        Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("PlatformId").Descending("UpdatedAt"),
        new CreateIndexOptions { Name = "idx_llmgw_model_tenant_platform_updated" }),
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
        users,
        memberships,
        tenants,
        teams,
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

    // 滑动续期：会话仍然有效且已用满续期间隔时，换发一枚重新计时的 token 通过响应头下发。
    // 放在租户校验之后，保证「已被禁用/踢出」的会话不会被续期。
    var renewed = gwJwt.TryRenew(http.User);
    if (renewed is not null)
    {
        http.Response.Headers[GwSessionHeaders.Token] = renewed.Value.Token;
        http.Response.Headers[GwSessionHeaders.TokenExpiresAt] =
            renewed.Value.ExpiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
    }

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
    // 空/缺省表示「平台没告诉我 MAP 在哪」，前端据此退回本地推算，而不是拿空串去拼地址。
    mapHomeUrl = string.IsNullOrWhiteSpace(mapHomeUrl) ? null : mapHomeUrl,
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
        .Where(x => activeTenantById.TryGetValue(x.TenantId, out var candidateTenant)
                    && LlmGwTenantRoles.All.Contains(x.Role)
                    && TenantOwnerAuthority.IsEffectiveOwner(candidateTenant, x))
        .OrderByDescending(x => x.TenantId == user.DefaultTenantId)
        .ThenBy(x => x.CreatedAt)
        .FirstOrDefault();
    var tenant = membership is null ? null : activeTenantById.GetValueOrDefault(membership.TenantId);
    if (tenant is null || membership is null || !LlmGwTenantRoles.All.Contains(membership.Role))
    {
        await WriteLoginAuditAsync(loginAudits, http, user.DefaultTenantId ?? internalTenantId, username, user.Id, false, "TENANT_MEMBERSHIP_MISSING");
        return Json(ApiEnvelope<LoginResultDto>.Fail("TENANT_ACCESS_DENIED", "账号没有可用的租户成员关系"), jsonOptions, 403);
    }

    await users.UpdateOneAsync(
        Builders<LlmGwUser>.Filter.And(
            Builders<LlmGwUser>.Filter.Eq(u => u.Id, user.Id),
            Builders<LlmGwUser>.Filter.Exists(nameof(LlmGwUser.SecurityVersion), false)),
        Builders<LlmGwUser>.Update.Set(u => u.SecurityVersion, 1));
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
        IdentityProvider = user.IdentityProvider,
        MustChangePassword = user.MustChangePassword,
        Tenant = ToTenantSession(tenant, membership),
    };
    return Json(ApiEnvelope<LoginResultDto>.Ok(data), jsonOptions);
}).AllowAnonymous();

// MAP 管理员一次性登录：授权码只存哈希、60 秒过期、先原子 claim 再签发短会话。
// URL 使用 fragment 传码，因此静态服务器和 Referer 都不会收到明文 code。
app.MapPost("/gw/auth/map-sso", async (HttpContext http, [FromBody] MapSsoRequestDto req) =>
{
    var code = (req.Code ?? string.Empty).Trim();
    if (code.Length is < 32 or > 256)
    {
        await WriteLoginAuditAsync(loginAudits, http, internalTenantId, "map-sso", null, false, "MAP_SSO_INVALID_CODE");
        return Json(ApiEnvelope<LoginResultDto>.Fail("MAP_SSO_INVALID", "一键登录凭据无效或已过期"), jsonOptions, 401);
    }

    var now = DateTime.UtcNow;
    var ticket = await MapSsoTicketStore.TryClaimAsync(mapSsoTickets, code, now);
    if (ticket is null)
    {
        await WriteLoginAuditAsync(loginAudits, http, internalTenantId, "map-sso", null, false, "MAP_SSO_REPLAY_OR_EXPIRED");
        return Json(ApiEnvelope<LoginResultDto>.Fail("MAP_SSO_INVALID", "一键登录凭据无效、已过期或已使用"), jsonOptions, 401);
    }

    var mapUserId = ticket.GetStringOrEmpty("MapUserId").Trim();
    var mapUsername = ticket.GetStringOrEmpty("MapUsername").Trim();
    var mapDisplayName = ticket.GetStringOrEmpty("MapDisplayName").Trim();
    if (mapUserId.Length == 0 || mapUsername.Length == 0)
    {
        await mapSsoTickets.UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", ticket["_id"]),
            Builders<BsonDocument>.Update.Set("State", "failed").Set("FailureReason", "identity_missing"));
        await WriteLoginAuditAsync(loginAudits, http, internalTenantId, "map-sso", null, false, "MAP_SSO_IDENTITY_MISSING");
        return Json(ApiEnvelope<LoginResultDto>.Fail("MAP_SSO_INVALID", "一键登录身份不完整"), jsonOptions, 401);
    }

    try
    {
        var tenant = await tenants.Find(x => x.Id == internalTenantId && x.Status == "active").FirstOrDefaultAsync();
        if (tenant is null)
        {
            await mapSsoTickets.UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", ticket["_id"]),
                Builders<BsonDocument>.Update.Set("State", "failed").Set("FailureReason", "internal_tenant_missing"));
            await WriteLoginAuditAsync(loginAudits, http, internalTenantId, mapUsername, null, false, "MAP_SSO_TENANT_MISSING");
            return Json(ApiEnvelope<LoginResultDto>.Fail("MAP_SSO_UNAVAILABLE", "模型网关内部租户尚未就绪"), jsonOptions, 503);
        }

        var externalSubjectId = $"map:{mapUserId}";
        var gwUser = await users.Find(x => x.IdentityProvider == "map" && x.ExternalSubjectId == externalSubjectId).FirstOrDefaultAsync();

        // 登录名默认跟 MAP 一致：一键登录进来的人不该被迫记住第二个名字。
        // 取不到（不合法字符集、或已被别人占用）才退回自动名，并在账号页如实说明为什么。
        var preferredUsername = LocalPasswordPolicy.TryNormalizeUsername(mapUsername, out var normalizedMapUsername, out _)
            ? normalizedMapUsername
            : null;
        var preferredTaken = preferredUsername is not null
            && await users.Find(x => x.Username == preferredUsername
                                     && (x.IdentityProvider != "map" || x.ExternalSubjectId != externalSubjectId)).AnyAsync();
        var fallbackUsername = $"map-{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(mapUserId))).ToLowerInvariant()[..16]}";

        if (gwUser is null)
        {
            var createdUser = new LlmGwUser
            {
                Id = Guid.NewGuid().ToString("N"),
                Username = preferredUsername is not null && !preferredTaken ? preferredUsername : fallbackUsername,
                DisplayName = mapDisplayName.Length > 0 ? mapDisplayName : mapUsername,
                IdentityProvider = "map",
                ExternalSubjectId = externalSubjectId,
                ExternalUsername = mapUsername,
                PasswordHash = PasswordHasher.Hash(Convert.ToBase64String(RandomNumberGenerator.GetBytes(48))),
                IsActive = true,
                MustChangePassword = false,
                PasswordChangedByUser = false,
                SecurityVersion = 1,
                TenantIds = new List<string> { tenant.Id },
                DefaultTenantId = tenant.Id,
                CreatedAt = now,
                UpdatedAt = now,
                LastLoginAt = now,
            };
            try
            {
                await users.InsertOneAsync(createdUser);
                gwUser = createdUser;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                gwUser = await users.Find(x => x.IdentityProvider == "map" && x.ExternalSubjectId == externalSubjectId).FirstOrDefaultAsync();
                if (gwUser is null) throw;
            }
        }
        else if (preferredUsername is not null
                 && !preferredTaken
                 && gwUser.Username.StartsWith(LocalPasswordPolicy.ReservedUsernamePrefix, StringComparison.Ordinal))
        {
            // 存量自愈：早先建的号还叫自动名，而 MAP 用户名此刻可用，就地改过来。
            // 判据用保留前缀而不是别的标记——那个命名空间真人拿不到，落在里面必然是自动生成的。
            // 改名不影响身份关联：绑定走 ExternalSubjectId，从来不依赖用户名。
            try
            {
                var renamed = await users.FindOneAndUpdateAsync(
                    Builders<LlmGwUser>.Filter.And(
                        Builders<LlmGwUser>.Filter.Eq(x => x.Id, gwUser.Id),
                        Builders<LlmGwUser>.Filter.Eq(x => x.Username, gwUser.Username)),
                    Builders<LlmGwUser>.Update.Set(x => x.Username, preferredUsername),
                    new FindOneAndUpdateOptions<LlmGwUser, LlmGwUser> { ReturnDocument = ReturnDocument.After });
                if (renamed is not null) gwUser = renamed;
            }
            catch (Exception ex) when (IsDuplicateKey(ex))
            {
                // 查到可用与真正写入之间被人抢先。保持自动名，账号页会提示改名。
            }
        }

        gwUser = await users.FindOneAndUpdateAsync(
            Builders<LlmGwUser>.Filter.Eq(x => x.Id, gwUser.Id),
            Builders<LlmGwUser>.Update
                .Set(x => x.DisplayName, mapDisplayName.Length > 0 ? mapDisplayName : mapUsername)
                // MAP 那边改了名要跟着刷新，否则账号页给的建议值是过期的。
                .Set(x => x.ExternalUsername, mapUsername)
                .Set(x => x.IsActive, true)
                .Set(x => x.MustChangePassword, false)
                .Set(x => x.DefaultTenantId, tenant.Id)
                .AddToSet(x => x.TenantIds, tenant.Id)
                .Set(x => x.LastLoginAt, now)
                .Set(x => x.UpdatedAt, now)
                .Inc(x => x.SecurityVersion, 1),
            new FindOneAndUpdateOptions<LlmGwUser, LlmGwUser> { ReturnDocument = ReturnDocument.After });
        if (gwUser is null) throw new InvalidOperationException("MAP_SSO_USER_UPDATE_CONFLICT");

        var membershipFilter = Builders<LlmGwMembership>.Filter.And(
            Builders<LlmGwMembership>.Filter.Eq(x => x.TenantId, tenant.Id),
            Builders<LlmGwMembership>.Filter.Eq(x => x.UserId, gwUser.Id));
        var membershipUpdate = Builders<LlmGwMembership>.Update
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.TenantId, tenant.Id)
            .SetOnInsert(x => x.UserId, gwUser.Id)
            .SetOnInsert(x => x.CreatedAt, now)
            .Set(x => x.Role, LlmGwTenantRoles.Admin)
            .Set(x => x.Status, "active")
            .Set(x => x.UpdatedAt, now)
            .Inc(x => x.Version, 1);
        LlmGwMembership? membership;
        try
        {
            membership = await memberships.FindOneAndUpdateAsync(
                membershipFilter,
                membershipUpdate,
                new FindOneAndUpdateOptions<LlmGwMembership, LlmGwMembership>
                {
                    IsUpsert = true,
                    ReturnDocument = ReturnDocument.After,
                });
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            membership = await memberships.FindOneAndUpdateAsync(
                membershipFilter,
                membershipUpdate,
                new FindOneAndUpdateOptions<LlmGwMembership, LlmGwMembership> { ReturnDocument = ReturnDocument.After });
        }
        if (membership is null) throw new InvalidOperationException("MAP_SSO_MEMBERSHIP_UPDATE_CONFLICT");

        await mapSsoTickets.UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", ticket["_id"]),
                Builders<BsonDocument>.Filter.Eq("State", "claimed")),
            Builders<BsonDocument>.Update
                .Set("State", "consumed")
                .Set("GatewayUserId", gwUser.Id)
                .Set("CompletedAt", DateTime.UtcNow));
        await WriteLoginAuditAsync(loginAudits, http, tenant.Id, mapUsername, gwUser.Id, true, null);

        // MAP 联邦会话默认与普通会话同为 7 天（LlmGwJwt:MapSsoLifetimeMinutes 可收紧）；
        // 再次从 MAP 点击仍会原子吊销该用户旧 Gateway 会话。
        var (token, expiresAt) = gwJwt.Issue(gwUser, tenant, membership, mapSsoLifetime, federatedSession: true);
        return Json(ApiEnvelope<LoginResultDto>.Ok(new LoginResultDto
        {
            Token = token,
            Username = mapUsername,
            DisplayName = gwUser.DisplayName,
            ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
            IdentityProvider = "map",
            MustChangePassword = false,
            Tenant = ToTenantSession(tenant, membership),
        }), jsonOptions);
    }
    catch
    {
        await mapSsoTickets.UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", ticket["_id"]),
                Builders<BsonDocument>.Filter.Eq("State", "claimed")),
            Builders<BsonDocument>.Update.Set("State", "failed").Set("FailureReason", "provisioning_failed"));
        throw;
    }
}).AllowAnonymous();

// ───────────────────────────── 改密（需鉴权，mcp token 也可）─────────────────────────────
// 首登强制改密：校验旧口令 → 写新哈希 → 清 MustChangePassword → 重新签发不带 mcp 的 token。
// 用普通 RequireAuthorization（不走 LogsRead 策略），使 mcp=1 的 token 能在此改密后解锁日志。
//
// 同一条路径也承担「联邦账号首次认领本地口令」：MAP 一键登录建的号，用户名与口令都是自动生成的，
// 没人知道旧口令。是否豁免旧口令由 LocalPasswordPolicy 单点判定，写口令仍然只有这一处实现。
app.MapPost("/gw/auth/change-password", async (HttpContext http, [FromBody] ChangePasswordRequestDto req) =>
{
    var oldPwd = req.OldPassword ?? "";
    var newPwd = req.NewPassword ?? "";
    var requestedUsername = (req.Username ?? "").Trim();
    if (newPwd.Length == 0)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("INVALID_INPUT", "新口令不能为空"), jsonOptions);
    }
    if (!LocalPasswordPolicy.MeetsMinimumLength(newPwd))
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("WEAK_PASSWORD", $"新口令至少 {LocalPasswordPolicy.MinPasswordLength} 位"), jsonOptions);
    }

    // 硬截止的联邦会话：**在任何写入之前**就把「到期时间不可读 / 已经过期」挡掉。
    // 放到最后再签发是不行的：那时口令、用户名、SecurityVersion 都已经落库，
    // 签发失败只能回 500，而用户的会话恰恰被这次改密作废了——改成功了却拿到 500，
    // 还得重新登录（Codex PR #1364 P2）。
    if (http.User.FindFirst(GwJwt.FederatedSessionClaim)?.Value == "1"
        && mapSsoLifetimeIsHardDeadline
        && FederatedHardDeadline(http, true) is null)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail(
            "SESSION_EXPIRED", "会话已到期或到期时间不可读，请重新登录后再试"), jsonOptions, 401);
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
    if (envAuthorityAdmin && string.Equals(user.Username, AdminUser, StringComparison.Ordinal))
    {
        await WriteOperationAuditAsync(
            operationAudits,
            http,
            action: "auth.change_password",
            targetType: "llmgw_console_user",
            targetId: user.Id,
            targetName: user.Username,
            success: false,
            reason: "PASSWORD_MANAGED_BY_DEPLOYMENT");
        return Json(
            ApiEnvelope<ChangePasswordResultDto>.Fail(
                "PASSWORD_MANAGED_BY_DEPLOYMENT",
                "该管理员口令由部署配置统一管理，当前页面不能修改。请联系系统管理员更新后重新登录。"),
            jsonOptions,
            statusCode: 409);
    }

    // 会话来源参与判定：从 MAP 一键登录进来的人此刻就能再走一遍 SSO，
    // 要求旧口令拦不住任何人，只会把忘记口令的本人锁死。
    var fromFederatedSession = http.User.FindFirst(GwJwt.FederatedSessionClaim)?.Value == "1";
    var requiresOldPassword = LocalPasswordPolicy.RequiresOldPassword(
        user.IdentityProvider, user.PasswordChangedByUser, fromFederatedSession);
    if (requiresOldPassword && oldPwd.Length == 0)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("INVALID_INPUT", "旧口令不能为空"), jsonOptions);
    }
    if (requiresOldPassword && newPwd == oldPwd)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("SAME_PASSWORD", "新口令不能与旧口令相同"), jsonOptions);
    }

    var newUsername = user.Username;
    if (requestedUsername.Length > 0)
    {
        if (!LocalPasswordPolicy.TryNormalizeUsername(requestedUsername, out var normalizedUsername, out var usernameError))
        {
            return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("INVALID_USERNAME", usernameError!), jsonOptions);
        }
        if (!string.Equals(normalizedUsername, user.Username, StringComparison.Ordinal)
            && await users.Find(u => u.Username == normalizedUsername).AnyAsync())
        {
            return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("USERNAME_TAKEN", "该登录名已被占用"), jsonOptions);
        }
        newUsername = normalizedUsername;
    }

    if (requiresOldPassword && !PasswordHasher.Verify(oldPwd, user.PasswordHash))
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
    var wasPasswordChangedByUser = user.PasswordChangedByUser;
    var update = Builders<LlmGwUser>.Update
        .Set(u => u.PasswordHash, PasswordHasher.Hash(newPwd))
        .Set(u => u.Username, newUsername)
        .Set(u => u.MustChangePassword, false)
        // 标记为真人认领：默认模式下重启不再自愈回 admin/admin，保住用户新口令。
        // 联邦账号一旦认领，下次改密就回到常规的旧口令校验。
        .Set(u => u.PasswordChangedByUser, true)
        .Inc(u => u.SecurityVersion, 1)
        .Set(u => u.UpdatedAt, DateTime.UtcNow);
    LlmGwUser? changedUser;
    try
    {
        changedUser = await users.FindOneAndUpdateAsync(
            Builders<LlmGwUser>.Filter.And(
                Builders<LlmGwUser>.Filter.Eq(u => u.Id, user.Id),
                Builders<LlmGwUser>.Filter.Eq(u => u.IsActive, true),
                Builders<LlmGwUser>.Filter.Eq(u => u.SecurityVersion, user.SecurityVersion),
                Builders<LlmGwUser>.Filter.Eq(u => u.PasswordHash, user.PasswordHash)),
            update,
            new FindOneAndUpdateOptions<LlmGwUser, LlmGwUser> { ReturnDocument = ReturnDocument.After });
    }
    catch (Exception ex) when (IsDuplicateKey(ex))
    {
        // 上面的占用查询与这次写入之间有窗口，唯一索引才是权威。
        // 两种异常都要接：findAndModify 走 MongoCommandException，普通写入走 MongoWriteException。
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("USERNAME_TAKEN", "该登录名已被占用"), jsonOptions);
    }
    if (changedUser is null)
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("PASSWORD_CHANGE_CONFLICT", "账号口令已被其他操作更新，请重新登录"), jsonOptions, 409);
    var auditChanges = new BsonDocument
    {
        { "mustChangePassword", new BsonDocument { { "from", wasMustChangePassword }, { "to", false } } },
        { "passwordChangedByUser", new BsonDocument { { "from", wasPasswordChangedByUser }, { "to", true } } },
        // 免旧口令的首次认领要在审计里留痕，否则事后分不清「验过旧口令」和「凭会话认领」。
        { "oldPasswordVerified", requiresOldPassword },
    };
    if (!string.Equals(newUsername, user.Username, StringComparison.Ordinal))
        auditChanges.Add("username", new BsonDocument { { "from", user.Username }, { "to", newUsername } });
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "auth.change_password",
        targetType: "llmgw_console_user",
        targetId: user.Id,
        targetName: user.Username,
        success: true,
        reason: null,
        changes: auditChanges);

    // 重新签发 token（此时 MustChangePassword 已清，Issue 不再带 mcp claim）。
    var tenantAccess = TenantAccess.GetRequired(http);
    var membership = await memberships.Find(x => x.Id == tenantAccess.MembershipId && x.TenantId == tenantAccess.TenantId && x.UserId == changedUser.Id && x.Status == "active").FirstOrDefaultAsync();
    var tenant = membership is null ? null : await tenants.Find(x => x.Id == tenantAccess.TenantId && x.Status == "active").FirstOrDefaultAsync();
    if (tenant is null || membership is null)
        return Json(ApiEnvelope<ChangePasswordResultDto>.Fail("TENANT_ACCESS_DENIED", "租户成员关系已失效"), jsonOptions, 403);
    // 联邦会话续签不得把到期时间往后推，理由见 FederatedHardDeadline。
    // 前面已经在**任何写入之前**挡过一次；但从那次检查到这里要经过定位账号、
    // PBKDF2、写库、写审计，硬截止完全可能正好落在这段时间里（TOCTOU）。
    // 此时口令**已经改成功了**，绝不能回一个「失败」——用户会拿着旧口令反复重试，
    // 而旧口令已经不好使了。如实说：改成功了，会话到期了，请重新登录（Codex PR #1364 P2）。
    var needsHardDeadline = fromFederatedSession && mapSsoLifetimeIsHardDeadline;
    var reissueDeadline = FederatedHardDeadline(http, needsHardDeadline);
    if (needsHardDeadline && reissueDeadline is null)
    {
        return Json(ApiEnvelope<ChangePasswordResultDto>.Ok(new ChangePasswordResultDto
        {
            Token = string.Empty,
            Username = changedUser.Username,
            DisplayName = string.IsNullOrEmpty(changedUser.DisplayName) ? changedUser.Username : changedUser.DisplayName,
            IdentityProvider = changedUser.IdentityProvider,
            Tenant = ToTenantSession(tenant, membership),
            RequiresRelogin = true,
        }), jsonOptions);
    }
    var (token, expiresAt) = gwJwt.Issue(
        changedUser, tenant, membership, federatedSession: fromFederatedSession, absoluteExpiresAt: reissueDeadline);
    var data = new ChangePasswordResultDto
    {
        Token = token,
        Username = changedUser.Username,
        DisplayName = string.IsNullOrEmpty(changedUser.DisplayName) ? changedUser.Username : changedUser.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        IdentityProvider = changedUser.IdentityProvider,
        Tenant = ToTenantSession(tenant, membership),
    };
    return Json(ApiEnvelope<ChangePasswordResultDto>.Ok(data), jsonOptions);
}).RequireAuthorization();

// 「账号与安全」页的数据源：告诉用户自己的登录名是什么、有没有可用的本地口令。
// 一键登录进来的人此前无处得知这两件事，于是「网关有口令但登不进去」。
// 与改密同为普通 RequireAuthorization：任何角色都必须能管自己的凭据。
app.MapGet("/gw/auth/account", async (HttpContext http) =>
{
    var userId = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
        ?? http.User.FindFirst("sub")?.Value;
    if (string.IsNullOrEmpty(userId))
        return Json(ApiEnvelope<AccountProfileDto>.Fail("UNAUTHORIZED", "无效的登录态"), jsonOptions, statusCode: 401);

    var user = await users.Find(u => u.Id == userId).FirstOrDefaultAsync();
    if (user is null || !user.IsActive)
        return Json(ApiEnvelope<AccountProfileDto>.Fail("UNAUTHORIZED", "账号不存在或已停用"), jsonOptions, statusCode: 401);

    var access = TenantAccess.GetRequired(http);
    var requiresOld = LocalPasswordPolicy.RequiresOldPassword(
        user.IdentityProvider,
        user.PasswordChangedByUser,
        http.User.FindFirst(GwJwt.FederatedSessionClaim)?.Value == "1");

    // 建议登录名 = 外部身份那边的登录名。只在它与当前用户名不同时才有意义；
    // 被别人占用时也要返回，好让页面说清「为什么你不能用自己那个名字」。
    string? suggestedUsername = null;
    var suggestedTaken = false;
    if (LocalPasswordPolicy.TryNormalizeUsername(user.ExternalUsername, out var normalizedExternal, out _)
        && !string.Equals(normalizedExternal, user.Username, StringComparison.Ordinal))
    {
        suggestedUsername = normalizedExternal;
        suggestedTaken = await users.Find(x => x.Username == normalizedExternal && x.Id != user.Id).AnyAsync();
    }

    return Json(ApiEnvelope<AccountProfileDto>.Ok(new AccountProfileDto
    {
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        IdentityProvider = user.IdentityProvider,
        HasLocalPassword = LocalPasswordPolicy.HasUsablePassword(user.IdentityProvider, user.PasswordChangedByUser),
        RequiresOldPassword = requiresOld,
        UsernameIsGenerated = user.Username.StartsWith(LocalPasswordPolicy.ReservedUsernamePrefix, StringComparison.Ordinal),
        SuggestedUsername = suggestedUsername,
        SuggestedUsernameTaken = suggestedTaken,
        MinPasswordLength = LocalPasswordPolicy.MinPasswordLength,
        Tenant = new TenantSessionDto
        {
            Id = access.TenantId,
            Name = access.TenantName,
            IsInternal = access.IsInternalTenant,
            Role = access.Role,
            TeamIds = access.TeamIds.ToList(),
        },
    }), jsonOptions);
}).RequireAuthorization();

app.MapGet("/gw/auth/context", (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    return Json(ApiEnvelope<TenantSessionDto>.Ok(new TenantSessionDto
    {
        Id = access.TenantId,
        Name = access.TenantName,
        IsInternal = access.IsInternalTenant,
        Role = access.Role,
        TeamIds = access.TeamIds.ToList(),
    }), jsonOptions);
}).RequireAuthorization("UsageRead");

app.MapGet("/gw/auth/tenants", async (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    var user = await users.Find(x => x.Id == access.UserId && x.IsActive).FirstOrDefaultAsync();
    var authorizedTenantIds = user?.TenantIds.Distinct(StringComparer.Ordinal).ToList() ?? new List<string>();
    var membershipFilter = Builders<LlmGwMembership>.Filter.And(
        Builders<LlmGwMembership>.Filter.In(x => x.TenantId, authorizedTenantIds),
        Builders<LlmGwMembership>.Filter.Eq(x => x.UserId, access.UserId),
        Builders<LlmGwMembership>.Filter.Eq(x => x.Status, "active"));
    var tenantMemberships = authorizedTenantIds.Count == 0
        ? new List<LlmGwMembership>()
        : await memberships.Find(membershipFilter).ToListAsync();
    var tenantIds = tenantMemberships.Select(x => x.TenantId).Distinct(StringComparer.Ordinal).ToList();
    var availableTenants = await tenants.Find(x => tenantIds.Contains(x.Id) && x.Status == "active").SortBy(x => x.Name).ToListAsync();
    var membershipByTenant = tenantMemberships
        .GroupBy(x => x.TenantId, StringComparer.Ordinal)
        .ToDictionary(x => x.Key, x => x.First(), StringComparer.Ordinal);
    return Json(ApiEnvelope<object>.Ok(availableTenants
        .Where(tenant => TenantOwnerAuthority.IsEffectiveOwner(tenant, membershipByTenant[tenant.Id]))
        .Select(tenant => new
    {
        tenant.Id,
        tenant.Name,
        tenant.Slug,
        role = membershipByTenant[tenant.Id].Role,
        current = tenant.Id == access.TenantId,
    })), jsonOptions);
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
    if (user is null || membership is null || tenant is null || !LlmGwTenantRoles.All.Contains(membership.Role)
        || !TenantOwnerAuthority.IsEffectiveOwner(tenant, membership))
        return Json(ApiEnvelope<LoginResultDto>.Fail("TENANT_ACCESS_DENIED", "无权切换到该租户"), jsonOptions, 403);

    // 同上：先挡住到期/不可读，再写默认租户。否则写完才发现签不出 token，
    // 用户的默认租户已经被改掉，却只拿到一个错误。
    var switchFromFederatedSession = http.User.FindFirst(GwJwt.FederatedSessionClaim)?.Value == "1";
    var switchDeadline = FederatedHardDeadline(http, switchFromFederatedSession && mapSsoLifetimeIsHardDeadline);
    if (switchFromFederatedSession && mapSsoLifetimeIsHardDeadline && switchDeadline is null)
        return Json(ApiEnvelope<LoginResultDto>.Fail(
            "SESSION_EXPIRED", "会话已到期或到期时间不可读，请重新登录后再试"), jsonOptions, 401);

    await users.UpdateOneAsync(x => x.Id == user.Id, Builders<LlmGwUser>.Update.Set(x => x.DefaultTenantId, tenant.Id).Set(x => x.UpdatedAt, DateTime.UtcNow));
    // 换租户是**续期**，会话血统不变：fed_session 必须原样带过去。
    // 丢掉它的后果正好打在本次新增的功能上——一键登录进来、还没设过口令的人切一次租户，
    // /gw/auth/account 就会改口说「要先填当前口令」，而那个口令是建号时随机生成的、
    // 没人知道，于是「忘了口令可以靠 SSO 自救」这条路当场断掉，直到重新走一次 MAP 登录。
    // 改密那条路（上面 Issue(..., federatedSession: fromFederatedSession)）早就是这么做的，
    // 这里漏了同一个判断（Codex PR #1363 P2）。
    // 写库到这里之间同样有 TOCTOU 窗口，重新读一次；这里改的只是「默认租户」这种偏好，
    // 不是凭据，所以回 401 让用户重登即可，不需要像改密那样特殊措辞。
    switchDeadline = FederatedHardDeadline(http, switchFromFederatedSession && mapSsoLifetimeIsHardDeadline);
    if (switchFromFederatedSession && mapSsoLifetimeIsHardDeadline && switchDeadline is null)
        return Json(ApiEnvelope<LoginResultDto>.Fail(
            "SESSION_EXPIRED", "会话已到期，请重新登录后再试"), jsonOptions, 401);
    var (token, expiresAt) = gwJwt.Issue(
        user, tenant, membership, federatedSession: switchFromFederatedSession, absoluteExpiresAt: switchDeadline);
    return Json(ApiEnvelope<LoginResultDto>.Ok(new LoginResultDto
    {
        Token = token,
        Username = user.Username,
        DisplayName = string.IsNullOrEmpty(user.DisplayName) ? user.Username : user.DisplayName,
        ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        IdentityProvider = user.IdentityProvider,
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

    var normalizedSlug = slug.ToUpperInvariant();
    var existingTenant = await tenants.Find(x => x.NormalizedSlug == normalizedSlug).FirstOrDefaultAsync();
    if (existingTenant is not null)
    {
        var replay = await FindTenantCreationReplayAsync(teams, memberships, existingTenant, access.UserId);
        if (replay is not null)
        {
            await EnsureGatewayModelPoolTypesAsync(
                gwModelPoolTypes, gwModelPools, gwModels, gwPlatforms, models, platforms, replay.Value.Tenant.Id, internalTenantId, appendModels: false);
            await recoveryOperations.UpdateManyAsync(
                x => x.Kind == GatewayRecoveryKinds.TenantCreate && x.TenantId == replay.Value.Tenant.Id && x.Status == "pending",
                Builders<GatewayRecoveryOperation>.Update
                    .Set(x => x.Status, "completed")
                    .Set(x => x.Detail, "idempotent-replay-completed")
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            return Json(ApiEnvelope<object>.Ok(new { replay.Value.Tenant.Id, replay.Value.Tenant.Name, replay.Value.Tenant.Slug, replay.Value.DefaultTeamId, idempotentReplay = true }), jsonOptions);
        }
        return Json(ApiEnvelope<object>.Fail("TENANT_CONFLICT", "租户 slug 已存在"), jsonOptions, 409);
    }

    var now = DateTime.UtcNow;
    var tenant = new LlmGwTenant
    {
        Name = name,
        NormalizedName = name.ToUpperInvariant(),
        Slug = slug,
        NormalizedSlug = normalizedSlug,
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
    tenant.OwnerAuthorityInitialized = true;
    tenant.ActiveOwnerMembershipIds = new List<string> { membership.Id };
    tenant.OwnerFenceGeneration = 1;
    var recoveryOperation = GatewayRecoveryOperations.New(
        GatewayRecoveryKinds.TenantCreate,
        tenant.Id,
        access.UserId,
        team.Id,
        membership.Id);
    await recoveryOperations.InsertOneAsync(recoveryOperation, cancellationToken: CancellationToken.None);
    await using var recoveryHeartbeat = await GatewayRecoveryOperations.StartHeartbeatAsync(recoveryOperations, recoveryOperation.Id);
    try
    {
        await tenants.InsertOneAsync(tenant);
        await teams.InsertOneAsync(team);
        await memberships.InsertOneAsync(membership);
        await users.UpdateOneAsync(x => x.Id == access.UserId,
            Builders<LlmGwUser>.Update.AddToSet(x => x.TenantIds, tenant.Id).Set(x => x.UpdatedAt, now));
    }
    catch (Exception ex)
    {
        await ProvisioningCompensation.RollbackTenantCreationAsync(users, tenants, teams, memberships, access.UserId, tenant.Id, team.Id, membership.Id);
        await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "tenant-create-write-failed");
        if (ex is MongoWriteException { WriteError.Category: ServerErrorCategory.DuplicateKey })
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                var winner = await tenants.Find(x => x.NormalizedSlug == normalizedSlug && x.Status == "active").FirstOrDefaultAsync();
                if (winner is not null)
                {
                    var replay = await FindTenantCreationReplayAsync(teams, memberships, winner, access.UserId);
                    if (replay is not null)
                    {
                        await EnsureGatewayModelPoolTypesAsync(
                            gwModelPoolTypes, gwModelPools, gwModels, gwPlatforms, models, platforms, replay.Value.Tenant.Id, internalTenantId, appendModels: false);
                        await recoveryOperations.UpdateManyAsync(
                            x => x.Kind == GatewayRecoveryKinds.TenantCreate && x.TenantId == replay.Value.Tenant.Id && x.Status == "pending",
                            Builders<GatewayRecoveryOperation>.Update
                                .Set(x => x.Status, "completed")
                                .Set(x => x.Detail, "concurrent-replay-completed")
                                .Set(x => x.UpdatedAt, DateTime.UtcNow),
                            cancellationToken: CancellationToken.None);
                        return Json(ApiEnvelope<object>.Ok(new { replay.Value.Tenant.Id, replay.Value.Tenant.Name, replay.Value.Tenant.Slug, replay.Value.DefaultTeamId, idempotentReplay = true }), jsonOptions);
                    }
                }
                await Task.Delay(25);
            }
            return Json(ApiEnvelope<object>.Fail("TENANT_CONFLICT", "租户 slug 已存在"), jsonOptions, 409);
        }
        throw;
    }
    try
    {
        await EnsureGatewayModelPoolTypesAsync(
            gwModelPoolTypes, gwModelPools, gwModels, gwPlatforms, models, platforms, tenant.Id, internalTenantId, appendModels: false);
    }
    catch
    {
        await gwModelPoolTypes.DeleteManyAsync(Builders<BsonDocument>.Filter.Eq("TenantId", tenant.Id));
        await gwModelPools.DeleteManyAsync(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenant.Id),
            Builders<BsonDocument>.Filter.Eq("ManagedByRegistry", true)));
        await ProvisioningCompensation.RollbackTenantCreationAsync(users, tenants, teams, memberships, access.UserId, tenant.Id, team.Id, membership.Id);
        await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "tenant-default-pool-failed");
        throw;
    }
    await WriteOperationAuditAsync(operationAudits, http, "tenant.create", "llmgw_tenant", tenant.Id, tenant.Name, true, null,
        new BsonDocument { { "slug", tenant.Slug } });
    await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "completed");
    return Json(ApiEnvelope<object>.Ok(new { tenant.Id, tenant.Name, tenant.Slug, defaultTeamId = team.Id }), jsonOptions, 201);
}).RequireAuthorization("TenantOwner");

// 删除租户。这是控制台里破坏力最大的一个动作——租户是所有网关配置的根，
// 所以这里刻意做成「只删空租户」：任何一类数据还在就拒绝，并把还剩什么原样报回去。
// 不做级联删除是有意的：级联一旦写错，错误是不可逆的，而「先自己清干净再删」是可逆的。
//
// 三条额外归属校验：
//   1) 只能删当前会话所在的租户（access 是按租户签发的，跨租户删除等于越权）
//   2) 内置租户不能删——它承载平台默认模型池的来源
//   3) 除自己以外还有别的成员就不能删——那是别人的工作区，不是你的
app.MapDelete("/gw/tenants/{id}", async (HttpContext http, string id) =>
{
    var access = TenantAccess.GetRequired(http);
    if (!string.Equals(id, access.TenantId, StringComparison.Ordinal))
        return Json(ApiEnvelope<TenantDeleteBlockers>.Fail("TENANT_SCOPE_MISMATCH", "只能删除当前登录的租户，请先切换过去再删"), jsonOptions, 403);
    if (string.Equals(id, internalTenantId, StringComparison.Ordinal))
        return Json(ApiEnvelope<TenantDeleteBlockers>.Fail("INTERNAL_TENANT", "内置租户不能删除，它承载平台默认模型池的来源"), jsonOptions, 409);

    var tenant = await tenants.Find(x => x.Id == id).FirstOrDefaultAsync();
    if (tenant is null)
        return Json(ApiEnvelope<TenantDeleteBlockers>.Fail("TENANT_NOT_FOUND", "租户不存在"), jsonOptions, 404);

    var tenantFilter = Builders<BsonDocument>.Filter.Eq("TenantId", id);
    // 开租户时平台会按池类型注册表自动铺一批默认池（ManagedByRegistry + IsDefaultForType），
    // 而「当前默认池不许删」——两条规则叠在一起，Pools == 0 永远不成立，这个端点的成功分支
    // 从落地那天起就走不到。空的托管默认池是系统自己铺的脚手架，不算「租户里还有内容」：
    // 它跟着租户一起删。装了成员的仍然算内容，必须先把成员摘干净。
    var tenantPools = await gwModelPools.Find(tenantFilter).ToListAsync();
    var residentPools = tenantPools
        .Where(d => !(d.AsNullableBool("ManagedByRegistry") == true && PoolMemberCount(d) == 0))
        .ToList();
    var blockers = new TenantDeleteBlockers
    {
        OtherMembers = (int)await memberships.CountDocumentsAsync(x => x.TenantId == id && x.UserId != access.UserId),
        Platforms = (int)await gwPlatforms.CountDocumentsAsync(tenantFilter),
        Models = (int)await gwModels.CountDocumentsAsync(tenantFilter),
        Pools = residentPools.Count,
        Exchanges = (int)await gwModelExchanges.CountDocumentsAsync(tenantFilter),
        LogicalModels = (int)await gwLogicalModels.CountDocumentsAsync(tenantFilter),
        ServiceKeys = (int)await serviceKeys.CountDocumentsAsync(tenantFilter),
        AppCallers = (int)await gwAppCallers.CountDocumentsAsync(tenantFilter),
    };
    if (blockers.TotalCount > 0)
    {
        var parts = new List<string>();
        if (blockers.OtherMembers > 0) parts.Add($"还有 {blockers.OtherMembers} 位其他成员");
        if (blockers.Platforms > 0) parts.Add($"上游 {blockers.Platforms} 条");
        if (blockers.Models > 0) parts.Add($"模型 {blockers.Models} 个");
        if (blockers.Pools > 0) parts.Add($"模型池 {blockers.Pools} 个");
        if (blockers.Exchanges > 0) parts.Add($"交换所 {blockers.Exchanges} 个");
        if (blockers.LogicalModels > 0) parts.Add($"逻辑模型 {blockers.LogicalModels} 个");
        if (blockers.ServiceKeys > 0) parts.Add($"接入密钥 {blockers.ServiceKeys} 把");
        if (blockers.AppCallers > 0) parts.Add($"appCaller {blockers.AppCallers} 个");
        return Json(
            ApiEnvelope<TenantDeleteBlockers>.Fail("TENANT_NOT_EMPTY", $"租户里还有内容，请先清空再删：{string.Join("、", parts)}", blockers),
            jsonOptions, 409);
    }

    // 到这里租户已经是空的：只剩自己的成员关系、没人引用的团队，以及系统自动铺的空默认池。
    // 后两者都是开租户时自动建的脚手架，跟着租户一起收走；池删了，指着它的类型文档也必须删，
    // 否则留下一条指向已删池的 DefaultPoolId（正是本 PR 一直在消灭的那种悬空引用）。
    var poolsRemoved = (await gwModelPools.DeleteManyAsync(tenantFilter)).DeletedCount;
    var poolTypesRemoved = (await gwModelPoolTypes.DeleteManyAsync(tenantFilter)).DeletedCount;
    var teamsRemoved = (await teams.DeleteManyAsync(x => x.TenantId == id)).DeletedCount;

    // 顺序同合并那条纪律：**会毁掉「还能重试」这个能力的那一步，必须放到最后**。
    // 这里毁掉重试能力的不是删租户，而是删成员关系——本端点要 TenantOwner 才进得来，
    // 而 TenantAccess.ResolveAsync 查不到 active 成员关系就返回 null。
    // 所以先删成员、后删租户的话，一旦卡在中间：租户还在、最后一个 owner 的成员关系没了，
    // 谁都再也进不来这个租户，连重试删除都不行，只能上数据库手工救。
    // 反过来先删租户：ResolveAsync 查不到 active 租户同样返回 null（不抛异常），
    // 剩下的成员关系与 users.TenantIds 只是指向一个已不存在租户的惰性残留，
    // 清理失败也不会挡住任何人——失败形态从「锁死」变成「留几行无害垃圾」。
    await tenants.DeleteOneAsync(x => x.Id == id);
    await memberships.DeleteManyAsync(x => x.TenantId == id);
    await users.UpdateManyAsync(
        Builders<LlmGwUser>.Filter.AnyEq(x => x.TenantIds, id),
        Builders<LlmGwUser>.Update.Pull(x => x.TenantIds, id).Set(x => x.UpdatedAt, DateTime.UtcNow));
    await WriteOperationAuditAsync(operationAudits, http, "tenant.delete", "llmgw_tenant", id, tenant.Name, true, null,
        new BsonDocument
        {
            { "slug", ToBsonAuditValue(tenant.Slug) },
            { "teamsRemoved", teamsRemoved },
            { "managedPoolsRemoved", poolsRemoved },
            { "poolTypesRemoved", poolTypesRemoved },
        });
    return Json(ApiEnvelope<TenantDeleteBlockers>.Ok(new TenantDeleteBlockers()), jsonOptions);
}).RequireAuthorization("TenantOwner");

app.MapGet("/gw/organization", async (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    var tenant = await tenants.Find(x => x.Id == access.TenantId).FirstOrDefaultAsync();
    var canReadEntireOrganization = access.Role is LlmGwTenantRoles.Owner or LlmGwTenantRoles.Admin;
    var teamFilter = Builders<LlmGwTeam>.Filter.Eq(x => x.TenantId, access.TenantId);
    var membershipFilter = Builders<LlmGwMembership>.Filter.Eq(x => x.TenantId, access.TenantId);
    if (!canReadEntireOrganization)
    {
        teamFilter &= Builders<LlmGwTeam>.Filter.In(x => x.Id, access.TeamIds);
        membershipFilter &= Builders<LlmGwMembership>.Filter.AnyIn(x => x.TeamIds, access.TeamIds);
    }
    var tenantTeams = await teams.Find(teamFilter)
        .SortBy(x => x.Name).ToListAsync();
    var tenantMemberships = await memberships.Find(membershipFilter)
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
            teamIds = canReadEntireOrganization
                ? x.TeamIds
                : x.TeamIds.Where(teamId => access.TeamIds.Contains(teamId, StringComparer.Ordinal)).ToList(),
            x.Status,
            x.Version,
            x.CreatedAt,
            x.UpdatedAt,
        }),
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

app.MapGet("/gw/tenant-governance", async (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    var tenant = await tenants.Find(x => x.Id == access.TenantId).FirstOrDefaultAsync();
    if (tenant is null)
        return Json(ApiEnvelope<TenantGovernanceData>.Fail("TENANT_NOT_FOUND", "当前租户不存在"), jsonOptions, 404);

    var now = DateTime.UtcNow;
    var monthStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
    var minuteStart = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, DateTimeKind.Utc);
    var budget = await budgetMonths.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId),
            Builders<BsonDocument>.Filter.Eq("AppCallerCode", TenantAggregateAppCallerCode),
            Builders<BsonDocument>.Filter.Eq("RequestType", TenantAggregateRequestType),
            Builders<BsonDocument>.Filter.Eq("MonthStart", monthStart)))
        .FirstOrDefaultAsync();
    var rateWindow = await tenantRateWindows.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId),
            Builders<BsonDocument>.Filter.Eq("WindowStart", minuteStart)))
        .FirstOrDefaultAsync();
    var reservedUsd = budget?.AsNullableDecimal("ReservedUsd") ?? 0;
    var spentUsd = budget?.AsNullableDecimal("SpentUsd") ?? 0;
    var usedUsd = reservedUsd + spentUsd;
    return Json(ApiEnvelope<TenantGovernanceData>.Ok(new TenantGovernanceData
    {
        TenantId = tenant.Id,
        MonthlyBudgetUsd = tenant.MonthlyBudgetUsd,
        BudgetReservationUsd = tenant.BudgetReservationUsd,
        RateLimitPerMinute = tenant.RateLimitPerMinute,
        MonthStart = monthStart,
        ReservedUsd = reservedUsd,
        SpentUsd = spentUsd,
        RemainingBudgetUsd = tenant.MonthlyBudgetUsd is > 0 ? Math.Max(0, tenant.MonthlyBudgetUsd.Value - usedUsd) : null,
        CurrentMinuteCount = rateWindow?.AsNullableLong("Count") ?? 0,
        CurrentMinuteStart = minuteStart,
    }), jsonOptions);
}).RequireAuthorization("UsageRead");

app.MapPut("/gw/tenant-governance", async (HttpContext http, [FromBody] UpdateTenantGovernanceRequest? body) =>
{
    if (body is null)
        return Json(ApiEnvelope<TenantGovernanceData>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    if (body.MonthlyBudgetUsd is < 0 || body.BudgetReservationUsd is < 0 || body.RateLimitPerMinute is < 0)
        return Json(ApiEnvelope<TenantGovernanceData>.Fail("INVALID_INPUT", "预算与速率不能小于 0"), jsonOptions, 400);
    if (body.RateLimitPerMinute is > 1_000_000)
        return Json(ApiEnvelope<TenantGovernanceData>.Fail("INVALID_INPUT", "租户每分钟总速率不能超过 1000000"), jsonOptions, 400);

    var monthlyBudget = NormalizePositiveBudget(body.MonthlyBudgetUsd ?? 0);
    var reservation = NormalizePositiveBudget(body.BudgetReservationUsd ?? 0);
    var budgetError = ValidateBudgetConfiguration(monthlyBudget, reservation);
    if (budgetError is not null)
        return Json(ApiEnvelope<TenantGovernanceData>.Fail("INVALID_INPUT", budgetError), jsonOptions, 400);

    var access = TenantAccess.GetRequired(http);
    var tenant = await tenants.Find(x => x.Id == access.TenantId).FirstOrDefaultAsync();
    if (tenant is null)
        return Json(ApiEnvelope<TenantGovernanceData>.Fail("TENANT_NOT_FOUND", "当前租户不存在"), jsonOptions, 404);

    var updates = new List<UpdateDefinition<LlmGwTenant>>();
    if (monthlyBudget is > 0)
    {
        updates.Add(Builders<LlmGwTenant>.Update.Set(x => x.MonthlyBudgetUsd, monthlyBudget));
        updates.Add(Builders<LlmGwTenant>.Update.Set(x => x.BudgetReservationUsd, reservation));
    }
    else
    {
        updates.Add(Builders<LlmGwTenant>.Update.Unset(x => x.MonthlyBudgetUsd));
        updates.Add(Builders<LlmGwTenant>.Update.Unset(x => x.BudgetReservationUsd));
    }
    if (body.RateLimitPerMinute is > 0)
        updates.Add(Builders<LlmGwTenant>.Update.Set(x => x.RateLimitPerMinute, body.RateLimitPerMinute));
    else
        updates.Add(Builders<LlmGwTenant>.Update.Unset(x => x.RateLimitPerMinute));
    updates.Add(Builders<LlmGwTenant>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow));
    await tenants.UpdateOneAsync(
        x => x.Id == access.TenantId,
        Builders<LlmGwTenant>.Update.Combine(updates),
        cancellationToken: CancellationToken.None);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        "tenant.governance.update",
        "llmgw_tenant",
        tenant.Id,
        tenant.Name,
        true,
        null,
        new BsonDocument
        {
            { "monthlyBudgetUsd", ToBsonAuditValue(monthlyBudget) },
            { "budgetReservationUsd", ToBsonAuditValue(reservation) },
            { "rateLimitPerMinute", ToBsonAuditValue(body.RateLimitPerMinute is > 0 ? body.RateLimitPerMinute : null) },
        });

    var fresh = await tenants.Find(x => x.Id == access.TenantId).FirstAsync();
    return Json(ApiEnvelope<TenantGovernanceData>.Ok(new TenantGovernanceData
    {
        TenantId = fresh.Id,
        MonthlyBudgetUsd = fresh.MonthlyBudgetUsd,
        BudgetReservationUsd = fresh.BudgetReservationUsd,
        RateLimitPerMinute = fresh.RateLimitPerMinute,
        MonthStart = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc),
        CurrentMinuteStart = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, DateTime.UtcNow.Day, DateTime.UtcNow.Hour, DateTime.UtcNow.Minute, 0, DateTimeKind.Utc),
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

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
    string? nextStatus = null;
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
        nextStatus = status;
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
    long invalidatedMemberships = 0;
    long revokedServiceKeys = 0;
    long disabledAppCallers = 0;
    if (nextStatus == "disabled")
    {
        invalidatedMemberships = (await memberships.UpdateManyAsync(
            x => x.TenantId == access.TenantId && x.TeamIds.Contains(id),
            Builders<LlmGwMembership>.Update
                .Inc(x => x.Version, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow))).ModifiedCount;
        revokedServiceKeys = (await serviceKeys.UpdateManyAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TeamId", id),
                Builders<BsonDocument>.Filter.Eq("Enabled", true))),
            Builders<BsonDocument>.Update
                .Set("Enabled", false)
                .Set("UpdatedAt", DateTime.UtcNow))).ModifiedCount;
        disabledAppCallers = (await gwAppCallers.UpdateManyAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TeamId", id),
                Builders<BsonDocument>.Filter.Ne("Status", "disabled"))),
            Builders<BsonDocument>.Update
                .Set("Status", "disabled")
                .Set("UpdatedAt", DateTime.UtcNow))).ModifiedCount;
    }
    await WriteOperationAuditAsync(operationAudits, http, "team.update", "llmgw_team", id, team.Name, true, null,
        new BsonDocument
        {
            { "status", nextStatus is null ? BsonNull.Value : nextStatus },
            { "invalidatedMemberships", invalidatedMemberships },
            { "revokedServiceKeys", revokedServiceKeys },
            { "disabledAppCallers", disabledAppCallers },
        });
    return Json(ApiEnvelope<object>.Ok(new
    {
        id,
        updated = true,
        invalidatedMemberships,
        revokedServiceKeys,
        disabledAppCallers,
    }), jsonOptions);
}).RequireAuthorization("OrganizationWrite");

// 删除团队。团队是成员、接入密钥、appCaller 的共同作用范围：删掉一个还在被引用的团队，
// 引用方并不会报错，只会被权限判定当成「没有范围」静默处理——比报错难查得多。
// 所以三类引用先查清再删，且把「谁还在引用」原样报回去，运维才知道下一步解哪个。
app.MapDelete("/gw/teams/{id}", async (HttpContext http, string id) =>
{
    var access = TenantAccess.GetRequired(http);
    var team = await teams.Find(x => x.Id == id && x.TenantId == access.TenantId).FirstOrDefaultAsync();
    if (team is null)
        return Json(ApiEnvelope<TeamDeleteBlockers>.Fail("TEAM_NOT_FOUND", "团队不存在"), jsonOptions, 404);

    var memberUserIds = (await memberships
            .Find(x => x.TenantId == access.TenantId && x.TeamIds.Contains(id))
            .ToListAsync())
        .Select(x => x.UserId)
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.Ordinal)
        .ToList();
    // 报 userId 等于没报——运维看着一串 hex 不知道该去找谁解绑。
    // 换成账号名（拿不到的才退回 id），阻挡清单才真的是「下一步做什么」。
    var memberNames = new List<string>(memberUserIds);
    if (memberUserIds.Count > 0)
    {
        var nameById = (await users.Find(Builders<LlmGwUser>.Filter.In(x => x.Id, memberUserIds)).ToListAsync())
            .ToDictionary(x => x.Id, x => x.Username, StringComparer.Ordinal);
        memberNames = memberUserIds
            .Select(x => nameById.TryGetValue(x, out var name) && !string.IsNullOrWhiteSpace(name) ? name : x)
            .ToList();
    }
    var blockers = new TeamDeleteBlockers
    {
        Members = memberNames,
        ServiceKeys = (int)await serviceKeys.CountDocumentsAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("TeamId", id))),
        AppCallers = (int)await gwAppCallers.CountDocumentsAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("TeamId", id))),
    };
    if (blockers.TotalCount > 0)
    {
        var parts = new List<string>();
        if (blockers.Members.Count > 0)
            parts.Add($"还有 {blockers.Members.Count} 位成员在这个团队里（{string.Join("、", blockers.Members.Take(5))}{(blockers.Members.Count > 5 ? " 等" : "")}）");
        if (blockers.ServiceKeys > 0) parts.Add($"还有 {blockers.ServiceKeys} 把接入密钥挂在它名下");
        if (blockers.AppCallers > 0) parts.Add($"还有 {blockers.AppCallers} 个 appCaller 归属它");
        return Json(ApiEnvelope<TeamDeleteBlockers>.Fail("TEAM_IN_USE", string.Join("；", parts), blockers), jsonOptions, 409);
    }

    await teams.DeleteOneAsync(x => x.Id == id && x.TenantId == access.TenantId);
    await WriteOperationAuditAsync(operationAudits, http, "team.delete", "llmgw_team", id, team.Name, true, null,
        new BsonDocument
        {
            { "name", ToBsonAuditValue(team.Name) },
            { "status", ToBsonAuditValue(team.Status) },
        });
    return Json(ApiEnvelope<TeamDeleteBlockers>.Ok(new TeamDeleteBlockers()), jsonOptions);
}).RequireAuthorization("OrganizationWrite");

app.MapPost("/gw/members", async (HttpContext http, [FromBody] CreateMemberRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var currentTenant = await tenants.Find(x => x.Id == access.TenantId).FirstOrDefaultAsync();
    if (currentTenant is null)
        return Json(ApiEnvelope<object>.Fail("TENANT_NOT_FOUND", "当前租户不存在"), jsonOptions, 404);
    if (!MembershipPolicy.TryCanonicalizeUsername(currentTenant.Slug, body.Username ?? string.Empty, out var username))
        return Json(ApiEnvelope<object>.Fail("INVALID_MEMBER", "账号短名需为 3-48 位小写字母、数字、点、下划线或连字符"), jsonOptions, 400);
    var role = (body.Role ?? LlmGwTenantRoles.Viewer).Trim().ToLowerInvariant();
    var teamIds = (body.TeamIds ?? []).Distinct(StringComparer.Ordinal).ToList();
    if (!LlmGwTenantRoles.All.Contains(role))
        return Json(ApiEnvelope<object>.Fail("INVALID_MEMBER", "角色无效"), jsonOptions, 400);
    if (role == LlmGwTenantRoles.Developer && teamIds.Count == 0)
        return Json(ApiEnvelope<object>.Fail("DEVELOPER_TEAM_REQUIRED", "Developer 至少需要一个团队"), jsonOptions, 400);
    if (role == LlmGwTenantRoles.Owner && access.Role != LlmGwTenantRoles.Owner)
        return Json(ApiEnvelope<object>.Fail("OWNER_REQUIRED", "只有 owner 可以授予 owner 角色"), jsonOptions, 403);
    if (teamIds.Count > 0 && await teams.CountDocumentsAsync(x => x.TenantId == access.TenantId && teamIds.Contains(x.Id) && x.Status == "active") != teamIds.Count)
        return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "包含不属于当前租户的团队"), jsonOptions, 400);

    var memberUser = await users.Find(x => x.Username == username).FirstOrDefaultAsync();
    if (memberUser is not null)
    {
        var existingMembership = await memberships.Find(x => x.TenantId == access.TenantId && x.UserId == memberUser.Id).FirstOrDefaultAsync();
        if (existingMembership is not null)
        {
            if (MembershipMatches(existingMembership, role, teamIds))
            {
                var completedCreateAudit = await operationAudits.Find(Builders<BsonDocument>.Filter.And(
                        Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId),
                        Builders<BsonDocument>.Filter.Eq("Action", "membership.create"),
                        Builders<BsonDocument>.Filter.Eq("TargetId", existingMembership.Id)))
                    .Sort(Builders<BsonDocument>.Sort.Descending("CreatedAt"))
                    .FirstOrDefaultAsync();
                if (MembershipPolicy.AllowsIdempotentReplay(
                        completedCreateAudit?.AsNullableString("State"),
                        completedCreateAudit?.AsNullableBool("Success") == true))
                    return Json(ApiEnvelope<object>.Ok(new { existingMembership.Id, existingMembership.UserId, memberUser.Username, existingMembership.Role, existingMembership.TeamIds, idempotentReplay = true }), jsonOptions);
                return Json(ApiEnvelope<object>.Fail(
                    "MEMBERSHIP_PROVISIONING_INCOMPLETE",
                    "成员关系已写入但审计尚未完成，请稍后重试或联系管理员检查 pending 审计"), jsonOptions, 409);
            }
            return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_CONFLICT", "用户已是当前租户成员，现有角色或团队范围与本次请求不同"), jsonOptions, 409);
        }
        return Json(ApiEnvelope<object>.Fail("USERNAME_UNAVAILABLE", "该用户名不可用于创建新成员，请换一个租户专用用户名"), jsonOptions, 409);
    }

    var initialPassword = body.InitialPassword ?? string.Empty;
    if (!GwPasswordPolicy.MeetsMinimumLength(initialPassword))
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
    var membership = new LlmGwMembership
    {
        TenantId = access.TenantId,
        UserId = memberUser.Id,
        Role = role,
        TeamIds = teamIds,
    };
    var recoveryOperation = GatewayRecoveryOperations.New(
        GatewayRecoveryKinds.MemberCreate,
        access.TenantId,
        memberUser.Id,
        membershipId: membership.Id);
    await recoveryOperations.InsertOneAsync(recoveryOperation, cancellationToken: CancellationToken.None);
    await using var recoveryHeartbeat = await GatewayRecoveryOperations.StartHeartbeatAsync(recoveryOperations, recoveryOperation.Id);
    try
    {
        await users.InsertOneAsync(memberUser);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "username-conflict");
        return Json(ApiEnvelope<object>.Fail("USERNAME_UNAVAILABLE", "该账号已被占用，请换一个账号短名"), jsonOptions, 409);
    }
    string requiredAuditId;
    try
    {
        requiredAuditId = await BeginRequiredOperationAuditAsync(
            operationAudits,
            http,
            "membership.create",
            "llmgw_membership",
            membership.Id,
            memberUser.Username,
            new BsonDocument
            {
                { "role", membership.Role },
                { "userId", membership.UserId },
                { "teamIds", new BsonArray(membership.TeamIds) },
            });
    }
    catch
    {
        await users.DeleteOneAsync(x => x.Id == memberUser.Id && x.Username == memberUser.Username);
        await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "membership-audit-begin-failed");
        throw;
    }

    try
    {
        await memberships.InsertOneAsync(membership);
        await users.UpdateOneAsync(x => x.Id == memberUser.Id,
            Builders<LlmGwUser>.Update.AddToSet(x => x.TenantIds, access.TenantId).Set(x => x.UpdatedAt, DateTime.UtcNow));
        if (membership.Role == LlmGwTenantRoles.Owner)
            await TenantOwnerAuthority.AddAsync(tenants, access.TenantId, membership.Id);
    }
    catch
    {
        if (membership.Role == LlmGwTenantRoles.Owner)
            await TenantOwnerAuthority.DiscardProvisionedOwnerAsync(tenants, access.TenantId, membership.Id);
        await ProvisioningCompensation.RollbackMemberCreationAsync(
            users,
            memberships,
            access.TenantId,
            memberUser.Id,
            membership.Id,
            createdUser: true,
            hadTenantDirectoryEntry: false);
        await TryCompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "membership_write_failed");
        await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "membership-write-failed");
        throw;
    }
    await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: true, reason: null);
    await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "completed");
    return Json(ApiEnvelope<object>.Ok(new { membership.Id, membership.UserId, memberUser.Username, membership.Role, membership.TeamIds }), jsonOptions, 201);
}).RequireAuthorization("OrganizationWrite");

app.MapPut("/gw/members/{id}", async (HttpContext http, string id, [FromBody] UpdateMemberRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var membership = await memberships.Find(x => x.Id == id && x.TenantId == access.TenantId).FirstOrDefaultAsync();
    if (membership is null) return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_NOT_FOUND", "成员关系不存在"), jsonOptions, 404);
    if (body.ExpectedVersion != membership.Version)
        return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_VERSION_CONFLICT", "成员关系已被其他操作更新，请刷新后重试"), jsonOptions, 409);
    if (membership.UserId == access.UserId)
        return Json(ApiEnvelope<object>.Fail("SELF_MEMBERSHIP_CHANGE_FORBIDDEN", "不能在当前会话中修改自己的成员关系，请由另一位管理员操作"), jsonOptions, 409);
    var role = body.Role?.Trim().ToLowerInvariant();
    var status = body.Status?.Trim().ToLowerInvariant();
    if (role is not null && !LlmGwTenantRoles.All.Contains(role)) return Json(ApiEnvelope<object>.Fail("INVALID_ROLE", "角色无效"), jsonOptions, 400);
    if (status is not null && status is not ("active" or "disabled")) return Json(ApiEnvelope<object>.Fail("INVALID_STATUS", "status 仅支持 active/disabled"), jsonOptions, 400);
    if ((membership.Role == LlmGwTenantRoles.Owner || role == LlmGwTenantRoles.Owner)
        && access.Role != LlmGwTenantRoles.Owner)
        return Json(ApiEnvelope<object>.Fail("OWNER_REQUIRED", "只有 owner 可以修改 owner 成员关系"), jsonOptions, 403);
    var requestedTeamIds = body.TeamIds?.Distinct(StringComparer.Ordinal).ToList();
    var nextTeamIds = requestedTeamIds ?? membership.TeamIds;
    if (requestedTeamIds is not null
        && requestedTeamIds.Count > 0
        && await teams.CountDocumentsAsync(x => x.TenantId == access.TenantId && requestedTeamIds.Contains(x.Id) && x.Status == "active") != requestedTeamIds.Count)
        return Json(ApiEnvelope<object>.Fail("INVALID_TEAM", "包含不属于当前租户或已停用的团队"), jsonOptions, 400);
    var activeNextTeamIds = nextTeamIds.Count == 0
        ? new HashSet<string>(StringComparer.Ordinal)
        : (await teams.Find(x => x.TenantId == access.TenantId && nextTeamIds.Contains(x.Id) && x.Status == "active")
            .Project(x => x.Id)
            .ToListAsync()).ToHashSet(StringComparer.Ordinal);
    if (!MembershipPolicy.HasUsableDeveloperScope(role ?? membership.Role, nextTeamIds, activeNextTeamIds))
        return Json(ApiEnvelope<object>.Fail("DEVELOPER_TEAM_REQUIRED", "Developer 至少需要一个有效团队"), jsonOptions, 400);
    var removesOwner = MembershipPolicy.RemovesActiveOwner(membership.Role, membership.Status, role, status);
    var addsOwner = !(membership.Role == LlmGwTenantRoles.Owner && membership.Status == "active")
                    && (role ?? membership.Role) == LlmGwTenantRoles.Owner
                    && (status ?? membership.Status) == "active";
    var ownerBoundaryMutation = removesOwner || addsOwner;
    var previousRole = membership.Role;
    var previousStatus = membership.Status;
    var previousTeamIds = membership.TeamIds.ToList();
    if (requestedTeamIds is not null) membership.TeamIds = requestedTeamIds;
    if (role is not null) membership.Role = role;
    if (status is not null) membership.Status = status;
    var previousVersion = body.ExpectedVersion;
    membership.Version++;
    membership.UpdatedAt = DateTime.UtcNow;
    var requiredAuditId = await BeginRequiredOperationAuditAsync(
        operationAudits,
        http,
        "membership.update",
        "llmgw_membership",
        membership.Id,
        membership.UserId,
        new BsonDocument
        {
            { "beforeRole", previousRole },
            { "role", membership.Role },
            { "beforeStatus", previousStatus },
            { "status", membership.Status },
            { "beforeTeamIds", new BsonArray(previousTeamIds) },
            { "teamIds", new BsonArray(membership.TeamIds) },
            { "beforeVersion", previousVersion },
            { "version", membership.Version },
        });
    GatewayRecoveryOperation? recoveryOperation = null;
    IAsyncDisposable? recoveryHeartbeat = null;
    if (ownerBoundaryMutation)
    {
        recoveryOperation = GatewayRecoveryOperations.New(
            GatewayRecoveryKinds.OwnerMutation,
            access.TenantId,
            membership.UserId,
            membershipId: membership.Id);
        recoveryOperation.ExpectedMembershipVersion = previousVersion;
        recoveryOperation.TargetRole = membership.Role;
        recoveryOperation.TargetStatus = membership.Status;
        recoveryOperation.TargetTeamIds = membership.TeamIds.ToList();
        await recoveryOperations.InsertOneAsync(recoveryOperation, cancellationToken: CancellationToken.None);
        recoveryHeartbeat = await GatewayRecoveryOperations.StartHeartbeatAsync(recoveryOperations, recoveryOperation.Id);
    }
    await using var recoveryHeartbeatScope = recoveryHeartbeat;

    OwnerRemovalDecision? ownerRemoval = null;
    if (removesOwner)
    {
        ownerRemoval = await TenantOwnerAuthority.TryRemoveAsync(tenants, access.TenantId, membership.Id);
        if (ownerRemoval.Result == OwnerRemovalResult.LastOwner)
        {
            await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "last_owner");
            if (recoveryOperation is not null)
                await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "last-owner");
            return Json(ApiEnvelope<object>.Fail("LAST_OWNER", "不能移除租户最后一个 owner"), jsonOptions, 409);
        }
    }
    ReplaceOneResult replaced;
    try
    {
        replaced = await memberships.ReplaceOneAsync(
            x => x.Id == id && x.TenantId == access.TenantId && x.Version == previousVersion,
            membership);
    }
    catch
    {
        await TryCompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "membership_write_failed");
        if (recoveryOperation is not null && ownerRemoval?.Result != OwnerRemovalResult.Removed)
            await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "membership-write-failed");
        throw;
    }
    if (replaced.ModifiedCount != 1)
    {
        await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "version_conflict");
        if (recoveryOperation is not null && ownerRemoval?.Result != OwnerRemovalResult.Removed)
            await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "rolled-back", "version-conflict");
        return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_VERSION_CONFLICT", "成员关系已被其他操作更新，请刷新后重试"), jsonOptions, 409);
    }
    long? ownerFenceGeneration = ownerRemoval?.Generation;
    if (addsOwner)
        ownerFenceGeneration = await TenantOwnerAuthority.AddAsync(tenants, access.TenantId, membership.Id);
    await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: true, reason: null);
    if (recoveryOperation is not null)
        await GatewayRecoveryOperations.CompleteAsync(recoveryOperations, recoveryOperation.Id, "completed", $"owner-fence-generation:{ownerFenceGeneration}");
    return Json(ApiEnvelope<object>.Ok(new { membership.Id, membership.Role, membership.Status, membership.TeamIds, membership.Version, ownerFenceGeneration }), jsonOptions);
}).RequireAuthorization("OrganizationWrite");

// 删除成员关系。三条归属校验缺一不可，且顺序要紧：
//   1) 不能删自己——删完这个会话立刻失权，连补救都做不了
//   2) 只有 owner 能删 owner
//   3) 不能删掉最后一个活跃 owner——租户会永久失去唯一能授权的人
// 第 3 条走 TenantOwnerAuthority.TryRemoveAsync：它是原子的「摘牌 + 拒绝最后一个」，
// 比先读再判安全。摘牌成功但随后版本冲突删不掉时必须把牌补回去，否则 owner 名单少一位。
app.MapDelete("/gw/members/{id}", async (HttpContext http, string id) =>
{
    var access = TenantAccess.GetRequired(http);
    var membership = await memberships.Find(x => x.Id == id && x.TenantId == access.TenantId).FirstOrDefaultAsync();
    if (membership is null)
        return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_NOT_FOUND", "成员关系不存在"), jsonOptions, 404);
    if (membership.UserId == access.UserId)
        return Json(ApiEnvelope<object>.Fail("SELF_MEMBERSHIP_CHANGE_FORBIDDEN", "不能删除自己的成员关系，请由另一位管理员操作"), jsonOptions, 409);
    if (membership.Role == LlmGwTenantRoles.Owner && access.Role != LlmGwTenantRoles.Owner)
        return Json(ApiEnvelope<object>.Fail("OWNER_REQUIRED", "只有 owner 可以删除 owner 成员关系"), jsonOptions, 403);

    var previousVersion = membership.Version;
    var requiredAuditId = await BeginRequiredOperationAuditAsync(
        operationAudits,
        http,
        "membership.delete",
        "llmgw_membership",
        membership.Id,
        membership.UserId,
        new BsonDocument
        {
            { "beforeRole", membership.Role },
            { "beforeStatus", membership.Status },
            { "beforeTeamIds", new BsonArray(membership.TeamIds) },
            { "beforeVersion", previousVersion },
        });

    var removesOwner = membership.Role == LlmGwTenantRoles.Owner && membership.Status == "active";
    OwnerRemovalDecision? ownerRemoval = null;
    if (removesOwner)
    {
        ownerRemoval = await TenantOwnerAuthority.TryRemoveAsync(tenants, access.TenantId, membership.Id);
        if (ownerRemoval.Result == OwnerRemovalResult.LastOwner)
        {
            await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "last_owner");
            return Json(ApiEnvelope<object>.Fail("LAST_OWNER", "不能移除租户最后一个 owner"), jsonOptions, 409);
        }
    }

    DeleteResult deleted;
    try
    {
        deleted = await memberships.DeleteOneAsync(
            x => x.Id == id && x.TenantId == access.TenantId && x.Version == previousVersion);
    }
    catch
    {
        if (ownerRemoval?.Result == OwnerRemovalResult.Removed)
            await TenantOwnerAuthority.RestoreAsync(tenants, access.TenantId, membership.Id);
        await TryCompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "membership_write_failed");
        throw;
    }
    if (deleted.DeletedCount != 1)
    {
        if (ownerRemoval?.Result == OwnerRemovalResult.Removed)
            await TenantOwnerAuthority.RestoreAsync(tenants, access.TenantId, membership.Id);
        await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "version_conflict");
        return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_VERSION_CONFLICT", "成员关系已被其他操作更新，请刷新后重试"), jsonOptions, 409);
    }

    // 用户可能还属于别的租户，所以只摘掉本租户的归属，不动账号本身。
    await users.UpdateOneAsync(
        x => x.Id == membership.UserId,
        Builders<LlmGwUser>.Update
            .Pull(x => x.TenantIds, access.TenantId)
            .Set(x => x.UpdatedAt, DateTime.UtcNow));
    await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: true, reason: null);
    return Json(ApiEnvelope<object>.Ok(new { id, membership.UserId, removed = true }), jsonOptions);
}).RequireAuthorization("OrganizationWrite");

app.MapPost("/gw/members/{id}/invalidate-sessions", async (HttpContext http, string id) =>
{
    var access = TenantAccess.GetRequired(http);
    var current = await memberships.Find(x => x.Id == id && x.TenantId == access.TenantId).FirstOrDefaultAsync();
    if (current is null)
        return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_NOT_FOUND", "成员关系不存在"), jsonOptions, 404);
    if (current.Role == LlmGwTenantRoles.Owner && access.Role != LlmGwTenantRoles.Owner)
        return Json(ApiEnvelope<object>.Fail("OWNER_REQUIRED", "只有 owner 可以强制 owner 重新登录"), jsonOptions, 403);
    if (current.UserId == access.UserId)
        return Json(ApiEnvelope<object>.Fail("SELF_SESSION_INVALIDATION_FORBIDDEN", "不能强制当前会话重新登录，请使用退出登录"), jsonOptions, 409);

    var requiredAuditId = await BeginRequiredOperationAuditAsync(
        operationAudits,
        http,
        "membership.invalidate_sessions",
        "llmgw_membership",
        current.Id,
        current.UserId,
        new BsonDocument
        {
            { "beforeVersion", current.Version },
            { "version", current.Version + 1 },
        });
    LlmGwMembership? updated;
    try
    {
        updated = await memberships.FindOneAndUpdateAsync(
            Builders<LlmGwMembership>.Filter.And(
                Builders<LlmGwMembership>.Filter.Eq(x => x.Id, id),
                Builders<LlmGwMembership>.Filter.Eq(x => x.TenantId, access.TenantId),
                Builders<LlmGwMembership>.Filter.Eq(x => x.Version, current.Version)),
            Builders<LlmGwMembership>.Update
                .Inc(x => x.Version, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<LlmGwMembership, LlmGwMembership> { ReturnDocument = ReturnDocument.After });
    }
    catch
    {
        await TryCompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "membership_write_failed");
        throw;
    }
    if (updated is null)
    {
        await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: false, reason: "version_conflict");
        return Json(ApiEnvelope<object>.Fail("MEMBERSHIP_VERSION_CONFLICT", "成员关系已被其他操作更新，请重试"), jsonOptions, 409);
    }
    await CompleteRequiredOperationAuditAsync(operationAudits, access.TenantId, requiredAuditId, success: true, reason: null);
    return Json(ApiEnvelope<object>.Ok(new { updated.Id, updated.UserId, updated.Version, invalidated = true }), jsonOptions);
}).RequireAuthorization("OrganizationWrite");

// ───────────────────────────── 日志列表（需鉴权）─────────────────────────────
app.MapGet("/gw/logs", async (
    HttpContext http,
    int? page, int? pageSize, string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType,
    string? sourceSystem, string? ingressProtocol, string? modelPolicy, string? releaseCommit,
    string? runId, string? requestId, string? sessionId, string? modelPoolId,
    string? serviceKeyId, string? clientCode, string? environment,
    string? operation, string? view, string? platformId) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = TenantAccess.FilterTeamScope(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId, modelPoolId, serviceKeyId, clientCode, environment, operation, view, platformId));

    var total = await logs.CountDocumentsAsync(filter);
    // 排序必须带唯一 tiebreaker。只按 StartedAt 排时，并列的文档在两次查询之间不保证同序
    // （StartedAt 是毫秒精度，忙时并列很常见），跨页边界就会重复一批、漏掉一批。
    // 前端改成瀑布累加后这不再只是「某页重复一行」：重复行把 rows.length 顶高，
    // `rows.length < total` 提前变假，用户看到「已全部加载」而记录其实还缺。
    var docs = await logs.Find(filter)
        .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt").Ascending("_id"))
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
    var recent = TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.Gte("StartedAt", since));

    var modelsRaw = await logs.Distinct<string>("Model", recent).ToListAsync();
    var statusesRaw = await logs.Distinct<string>("Status", recent).ToListAsync();
    var providersRaw = await logs.Distinct<string>("Provider", recent).ToListAsync();
    var appCallersRaw = await logs.Distinct<string>("AppCallerCode", recent).ToListAsync();
    var transportsRaw = await logs.Distinct<string>("GatewayTransport", recent).ToListAsync();
    var requestTypesRaw = await logs.Distinct<string>("RequestType", recent).ToListAsync();
    var sourceSystemsRaw = await logs.Distinct<string>("SourceSystem", recent).ToListAsync();
    var ingressProtocolsRaw = await logs.Distinct<string>("IngressProtocol", recent).ToListAsync();
    var modelPoliciesRaw = await logs.Distinct<string>("ModelPolicy", recent).ToListAsync();
    var serviceKeyIdsRaw = await logs.Distinct<string>("ServiceKeyId", recent).ToListAsync();
    var clientCodesRaw = await logs.Distinct<string>("ClientCode", recent).ToListAsync();
    var environmentsRaw = await logs.Distinct<string>("Environment", recent).ToListAsync();

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
        ServiceKeyIds = NormalizeDistinct(serviceKeyIdsRaw, 300),
        ClientCodes = NormalizeDistinct(clientCodesRaw, 300),
        Environments = NormalizeDistinct(environmentsRaw, 20),
        Operations = ["invoke", "submit", "status", "download", "cancel", "probe"],
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

// ───────────────────────────── 时间序列（需鉴权）─────────────────────────────
app.MapGet("/gw/logs/timeseries", async (
    HttpContext http,
    string? from, string? to, string? model, string? status,
    string? provider, string? appCallerCode, string? transport, string? requestType,
    string? sourceSystem, string? ingressProtocol, string? modelPolicy, string? releaseCommit,
    string? runId, string? requestId, string? sessionId, string? modelPoolId,
    string? serviceKeyId, string? clientCode, string? environment,
    string? operation, string? view, string? platformId) =>
{
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = TenantAccess.FilterTeamScope(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId, modelPoolId, serviceKeyId, clientCode, environment, operation, view, platformId));

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
    string? runId, string? requestId, string? sessionId, string? modelPoolId,
    string? serviceKeyId, string? clientCode, string? environment,
    string? operation, string? view, string? platformId) =>
{
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    var filter = TenantAccess.FilterTeamScope(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId, modelPoolId, serviceKeyId, clientCode, environment, operation, view, platformId));
    var physicalFilter = TenantAccess.FilterTeamScope(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId, modelPoolId, serviceKeyId, clientCode, environment, operation: null, view: "physical", platformId: platformId));
    var projection = Builders<BsonDocument>.Projection
        .Include("Status")
        .Include("DurationMs")
        .Include("InputTokens")
        .Include("OutputTokens")
        .Include("InputPricePerMillion")
        .Include("OutputPricePerMillion")
        .Include("EstimatedCost")
        .Include("EstimatedCostCurrency")
        .Include("EstimatedCostUsd")
        .Include("IsFallback")
        .Include("GatewayTransport")
        .Include("SourceSystem")
        .Include("IngressProtocol")
        .Include("ModelPolicy")
        .Include("Operation")
        .Include("RequestType")
        .Include("HttpMethod")
        .Include("Path")
        .Include("IsHealthProbe")
        .Include("Model")
        .Include("Provider")
        .Include("ProviderAttempts");
    var docs = await logs.Find(filter).Project(projection).ToListAsync();
    var physicalDocs = await logs.Find(physicalFilter).Project(projection).ToListAsync();
    var physicalAttempts = physicalDocs
        .SelectMany(MapProviderAttempts)
        .Where(IsUpstreamProviderAttempt)
        .ToList();
    var internalStatusQueries = physicalAttempts.LongCount(IsProviderPollAttempt);

    var durations = docs.Select(d => d.AsNullableLong("DurationMs")).Where(d => d is > 0).Select(d => d!.Value).ToList();
    var pricedDocs = docs
        .Select(d => new
        {
            Amount = d.AsNullableDecimal("EstimatedCost"),
            Currency = NormalizePriceCurrency(d.AsNullableString("EstimatedCostCurrency")),
            Usd = d.AsNullableDecimal("EstimatedCostUsd"),
            Complete = (d.AsNullableInt("InputTokens") is not > 0 || d.AsNullableDecimal("InputPricePerMillion") is not null)
                && (d.AsNullableInt("OutputTokens") is not > 0 || d.AsNullableDecimal("OutputPricePerMillion") is not null),
        })
        .Where(x => x.Amount is not null && x.Currency is not null && x.Complete)
        .ToList();
    var estimatedCosts = pricedDocs
        .GroupBy(x => x.Currency!, StringComparer.Ordinal)
        .OrderBy(x => x.Key, StringComparer.Ordinal)
        .Select(x => new EstimatedCostBucket
        {
            Currency = x.Key,
            Amount = x.Sum(item => item.Amount!.Value),
            Requests = x.LongCount(),
        })
        .ToList();
    var usdDocs = pricedDocs.Where(x => x.Currency == "USD" && x.Usd is not null).ToList();
    var data = new LogsSummaryData
    {
        Total = docs.Count,
        UpstreamCalls = physicalAttempts.Count,
        ControlCalls = physicalDocs.LongCount(d => !IsBusinessOperation(ResolveLogOperation(d))) + internalStatusQueries,
        StatusQueries = physicalDocs.LongCount(d => ResolveLogOperation(d) == "status") + internalStatusQueries,
        Succeeded = docs.LongCount(d => d.GetStringOrEmpty("Status") == "succeeded"),
        Failed = docs.LongCount(d => d.GetStringOrEmpty("Status") == "failed"),
        Running = docs.LongCount(d => d.GetStringOrEmpty("Status") == "running"),
        Cancelled = docs.LongCount(d => d.GetStringOrEmpty("Status") == "cancelled"),
        Fallbacks = docs.LongCount(d => d.AsNullableBool("IsFallback") == true),
        InputTokens = docs.Sum(d => (long)(d.AsNullableInt("InputTokens") ?? 0)),
        OutputTokens = docs.Sum(d => (long)(d.AsNullableInt("OutputTokens") ?? 0)),
        EstimatedCostUsd = usdDocs.Count == 0 ? null : usdDocs.Sum(x => x.Usd!.Value),
        PricedRequests = pricedDocs.Count,
        UnknownCostRequests = docs.Count - pricedDocs.Count,
        PriceCoveragePercent = docs.Count == 0 ? 0m : Math.Round(pricedDocs.Count * 100m / docs.Count, 1, MidpointRounding.AwayFromZero),
        EstimatedCosts = estimatedCosts,
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

// ───────────────────────────── 租户全局首页（需鉴权）─────────────────────────────
// tenant 只来自服务端解析后的 TenantAccessContext；端点不接受 tenantId 参数。
app.MapGet("/gw/overview", async (HttpContext http, string? from, string? to) =>
{
    if (!string.IsNullOrWhiteSpace(from) && TryParseUtc(from) is null
        || !string.IsNullOrWhiteSpace(to) && TryParseUtc(to) is null)
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_RANGE", "from/to 必须是有效的 UTC 日期时间"), jsonOptions, 400);
    }
    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    if (toUtc <= fromUtc || toUtc - fromUtc > TimeSpan.FromDays(90))
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_RANGE", "时间范围必须大于 0 且不超过 90 天"), jsonOptions, 400);
    }

    var fb = Builders<BsonDocument>.Filter;
    var overviewFilter = TenantAccess.FilterTeamScope(http, fb.And(
        fb.Gte("StartedAt", fromUtc),
        fb.Lt("StartedAt", toUtc),
        BuildBusinessOperationFilter()));
    var projection = Builders<BsonDocument>.Projection
        .Include("Status")
        .Include("DurationMs")
        .Include("InputTokens")
        .Include("OutputTokens")
        .Include("InputPricePerMillion")
        .Include("OutputPricePerMillion")
        .Include("EstimatedCost")
        .Include("EstimatedCostCurrency")
        .Include("EstimatedCostUsd")
        .Include("StartedAt")
        .Include("UserId")
        .Include("AppCallerCode")
        .Include("AppCallerCodeDisplayName")
        .Include("AppCallerTitle")
        .Include("Model");
    var docs = await logs.Find(overviewFilter).Project(projection).ToListAsync();

    var now = DateTime.UtcNow;
    var keyProjection = Builders<BsonDocument>.Projection
        .Include("Enabled")
        .Include("ExpiresAt")
        .Include("LastUsedAt");
    var keyDocs = await serviceKeys.Find(TenantAccess.FilterTeamScope(http, fb.Empty)).Project(keyProjection).ToListAsync();

    var canReadRecentRequests = TenantAccess.HasPermission(http.User, LlmGwPermissions.LogsRead);
    var recentRequests = new List<LlmLogListItem>();
    if (canReadRecentRequests)
    {
        var recentDocs = await logs.Find(overviewFilter)
            .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt"))
            .Limit(5)
            .ToListAsync();
        recentRequests = recentDocs.Select(MapListItem).ToList();
    }

    var durations = docs
        .Select(d => d.AsNullableLong("DurationMs"))
        .Where(d => d is >= 0)
        .Select(d => d!.Value)
        .OrderBy(d => d)
        .ToList();
    var pricedDocs = docs
        .Select(d => new
        {
            Amount = d.AsNullableDecimal("EstimatedCost"),
            Currency = NormalizePriceCurrency(d.AsNullableString("EstimatedCostCurrency")),
            Complete = (d.AsNullableInt("InputTokens") is not > 0 || d.AsNullableDecimal("InputPricePerMillion") is not null)
                && (d.AsNullableInt("OutputTokens") is not > 0 || d.AsNullableDecimal("OutputPricePerMillion") is not null),
        })
        .Where(x => x.Amount is not null && x.Currency is not null && x.Complete)
        .ToList();
    var estimatedCosts = pricedDocs
        .GroupBy(x => x.Currency!, StringComparer.Ordinal)
        .OrderBy(x => x.Key, StringComparer.Ordinal)
        .Select(x => new EstimatedCostBucket
        {
            Currency = x.Key,
            Amount = x.Sum(item => item.Amount!.Value),
            Requests = x.LongCount(),
        })
        .ToList();

    var rangeMinutes = Math.Max(1d, (toUtc - fromUtc).TotalMinutes);
    var rateWindowMinutes = Math.Max(1, (int)Math.Min(15d, Math.Ceiling(rangeMinutes)));
    var rateFrom = toUtc.AddMinutes(-rateWindowMinutes);
    var rateRequests = docs.LongCount(d => d.AsNullableUtcDateTime("StartedAt") is DateTime started && started >= rateFrom);
    var succeeded = docs.LongCount(d => d.GetStringOrEmpty("Status") == "succeeded");
    var lastUsedAt = keyDocs
        .Select(d => d.AsNullableUtcDateTime("LastUsedAt"))
        .Where(x => x is not null)
        .OrderByDescending(x => x)
        .FirstOrDefault();
    var activeUserIds = docs
        .Select(d => d.AsNullableString("UserId"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x!.Trim())
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Count();

    var inputTokens = docs.Sum(d => (long)(d.AsNullableInt("InputTokens") ?? 0));
    var outputTokens = docs.Sum(d => (long)(d.AsNullableInt("OutputTokens") ?? 0));
    var data = new TenantOverviewData
    {
        From = ((DateTime?)fromUtc).ToIso() ?? string.Empty,
        To = ((DateTime?)toUtc).ToIso() ?? string.Empty,
        GeneratedAt = ((DateTime?)now).ToIso() ?? string.Empty,
        TotalRequests = docs.Count,
        SuccessRatePercent = docs.Count == 0
            ? null
            : Math.Round(succeeded * 100m / docs.Count, 1, MidpointRounding.AwayFromZero),
        P95DurationMs = Percentile95(durations),
        RequestRatePerMinute = Math.Round(rateRequests / (decimal)rateWindowMinutes, 2, MidpointRounding.AwayFromZero),
        RateWindowMinutes = rateWindowMinutes,
        InputTokens = inputTokens,
        OutputTokens = outputTokens,
        TotalTokens = inputTokens + outputTokens,
        ActiveUsers = activeUserIds,
        PricedRequests = pricedDocs.Count,
        UnknownCostRequests = docs.Count - pricedDocs.Count,
        PriceCoveragePercent = docs.Count == 0
            ? 0m
            : Math.Round(pricedDocs.Count * 100m / docs.Count, 1, MidpointRounding.AwayFromZero),
        EstimatedCosts = estimatedCosts,
        TopUsers = BuildOverviewRank(
            docs,
            d => d.AsNullableString("UserId"),
            d => d.AsNullableString("UserId"),
            limit: 5),
        TopAppCallers = BuildOverviewRank(
            docs,
            d => d.AsNullableString("AppCallerCode"),
            d => d.AsNullableString("AppCallerTitle")
                ?? d.AsNullableString("AppCallerCodeDisplayName")
                ?? d.AsNullableString("AppCallerCode"),
            limit: 5),
        TopModels = BuildOverviewRank(
            docs,
            d => d.AsNullableString("Model"),
            d => d.AsNullableString("Model"),
            limit: 5),
        ServiceKeys = new ServiceKeyOverview
        {
            Total = keyDocs.Count,
            Active = keyDocs.LongCount(d =>
                d.AsNullableBool("Enabled") == true
                && (d.AsNullableUtcDateTime("ExpiresAt") is not DateTime expiresAt || expiresAt > now)),
            Disabled = keyDocs.LongCount(d => d.AsNullableBool("Enabled") != true),
            Expired = keyDocs.LongCount(d => d.AsNullableUtcDateTime("ExpiresAt") is DateTime expiresAt && expiresAt <= now),
            ExpiringSoon = keyDocs.LongCount(d =>
                d.AsNullableBool("Enabled") == true
                && d.AsNullableUtcDateTime("ExpiresAt") is DateTime expiresAt
                && expiresAt > now
                && expiresAt <= now.AddDays(7)),
            NeverUsed = keyDocs.LongCount(d => d.AsNullableUtcDateTime("LastUsedAt") is null),
            LastUsedAt = lastUsedAt.ToIso(),
        },
        CanReadRecentRequests = canReadRecentRequests,
        RecentRequests = recentRequests,
    };

    return Json(ApiEnvelope<TenantOverviewData>.Ok(data), jsonOptions);
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
    logFilter = TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
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
    var appCallerDocs = await gwAppCallers.Find(TenantAccess.FilterTeamScope(
        http,
        Builders<BsonDocument>.Filter.Empty)).ToListAsync();

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
    string? runId, string? requestId, string? sessionId, string? modelPoolId,
    string? serviceKeyId, string? clientCode, string? environment, string? platformId) =>
{
    var p = page is > 0 ? page.Value : 1;
    var ps = pageSize is > 0 and <= 500 ? pageSize.Value : 50;

    var (fromUtc, toUtc) = ResolveRange(from, to, defaultDays: 7);
    // platformId 必须跟着传：前端会话页与请求页共用同一份筛选参数，
    // 这里不收的话，用户从平台行「查看日志」深链进来切到会话页，
    // 界面上平台筛选还亮着，列出来的却是所有平台的会话——筛选条件在说谎。
    var filter = TenantAccess.FilterTeamScope(http, BuildFilter(fromUtc, toUtc, model, status, provider, appCallerCode, transport, requestType, sourceSystem, ingressProtocol, modelPolicy, releaseCommit, runId, requestId, sessionId, modelPoolId, serviceKeyId, clientCode, environment, view: "logical", platformId: platformId));

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
    var filter = TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await logs.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
    {
        return Json(ApiEnvelope<LlmLogDetail>.Fail("NOT_FOUND", "日志不存在"), jsonOptions, statusCode: 404);
    }
    var detail = MapDetail(doc);
    var logicalRequestId = detail.LogicalRequestId;
    var relatedFilters = new List<FilterDefinition<BsonDocument>>
    {
        Builders<BsonDocument>.Filter.Eq("_id", id),
    };
    if (!string.IsNullOrWhiteSpace(logicalRequestId))
    {
        relatedFilters.Add(Builders<BsonDocument>.Filter.Eq("LogicalRequestId", logicalRequestId));
    }
    if (!string.IsNullOrWhiteSpace(detail.ProviderTaskId))
    {
        relatedFilters.Add(Builders<BsonDocument>.Filter.Eq("ProviderTaskId", detail.ProviderTaskId));
    }
    if (relatedFilters.Count > 0)
    {
        var relatedFilter = TenantAccess.FilterTeamScope(
            http,
            Builders<BsonDocument>.Filter.Or(relatedFilters));
        var relatedProjection = Builders<BsonDocument>.Projection
            .Include("Operation")
            .Include("RequestType")
            .Include("HttpMethod")
            .Include("Path")
            .Include("ProviderTaskId")
            .Include("Model")
            .Include("Provider")
            .Include("ProviderReportedCost")
            .Include("ProviderCostCurrency")
            .Include("IsHealthProbe")
            .Include("ProviderAttempts");
        var related = await logs.Find(relatedFilter)
            .Project(relatedProjection)
            .ToListAsync();
        // 存量日志没有 ProviderTaskId 时才走路径回退，避免把不可索引正则放进常规 OR 查询。
        if (!string.IsNullOrWhiteSpace(detail.ProviderTaskId) && related.Count == 1)
        {
            var escapedProviderTaskId = System.Text.RegularExpressions.Regex.Escape(detail.ProviderTaskId);
            var legacyPathFilter = TenantAccess.FilterTeamScope(
                http,
                Builders<BsonDocument>.Filter.Regex(
                    "Path",
                    new BsonRegularExpression($"(^|/){escapedProviderTaskId}(/|$)")));
            var legacyRelated = await logs.Find(legacyPathFilter)
                .Project(relatedProjection)
                .ToListAsync();
            related = related
                .Concat(legacyRelated)
                .GroupBy(item => item.GetStringOrEmpty("_id"), StringComparer.Ordinal)
                .Select(group => group.First())
                .ToList();
        }
        var relatedAttempts = related
            .SelectMany(MapProviderAttempts)
            .Where(IsUpstreamProviderAttempt)
            .ToList();
        detail.UpstreamCallCount = relatedAttempts.Count;
        detail.StatusQueryCount = related.LongCount(item => ResolveLogOperation(item) == "status")
            + relatedAttempts.LongCount(IsProviderPollAttempt);
        detail.ProviderTaskId ??= related
            .Select(item => item.AsNullableString("ProviderTaskId") ?? InferProviderTaskId(item))
            .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
        var reportedCost = related
            .Select(item => new
            {
                Amount = item.AsNullableDecimal("ProviderReportedCost"),
                Currency = item.AsNullableString("ProviderCostCurrency"),
            })
            .FirstOrDefault(value => value.Amount is not null);
        if (detail.ProviderReportedCost is null && reportedCost is not null)
        {
            detail.ProviderReportedCost = reportedCost.Amount;
            detail.ProviderCostCurrency = reportedCost.Currency;
        }
    }
    return Json(ApiEnvelope<LlmLogDetail>.Ok(detail), jsonOptions);
}).RequireAuthorization("RequestBodyRead");

// ─────────────── 网关配置面（只读，腿 B 第一刀）───────────────
// 让网关控制台不只有日志，还能看模型池 / 平台 / 模型 / 影子比对。密钥字段一律不返回（只回 hasKey）。

// 模型池列表
app.MapGet("/gw/pool-types", async (HttpContext http) =>
{
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var data = await BuildPoolTypesDataAsync(gwModelPoolTypes, gwModelPools, gwPlatforms, gwModels, gwModelExchanges, tenantId);
    return Json(ApiEnvelope<PoolTypesData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 程序池类型初始化遵循“有则增加，无则不变”：只补缺失类型、缺失默认池和兼容的新成员。
app.MapPost("/gw/pool-types/ensure", async (HttpContext http) =>
{
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var ensured = await EnsureGatewayModelPoolTypesAsync(
        gwModelPoolTypes, gwModelPools, gwModels, gwPlatforms, models, platforms, tenantId, internalTenantId, appendModels: true);
    var data = await BuildPoolTypesDataAsync(gwModelPoolTypes, gwModelPools, gwPlatforms, gwModels, gwModelExchanges, tenantId);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool_type.ensure_defaults",
        targetType: "llmgw_model_pool_type",
        targetId: "all",
        targetName: "program pool types",
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "typesCreated", ensured.TypesCreated },
            { "poolsCreated", ensured.PoolsCreated },
            { "modelsAppended", ensured.ModelsAppended },
            { "appendOnly", true },
        });
    return Json(ApiEnvelope<EnsurePoolTypesResult>.Ok(new EnsurePoolTypesResult
    {
        TypesCreated = ensured.TypesCreated,
        PoolsCreated = ensured.PoolsCreated,
        ModelsAppended = ensured.ModelsAppended,
        Types = data,
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapGet("/gw/pools", async (HttpContext http, string? modelType, int? sinceHours) =>
{
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var fb = Builders<BsonDocument>.Filter;
    var filter = string.IsNullOrWhiteSpace(modelType) ? fb.Empty : fb.Eq("ModelType", modelType);
    var mapDocs = TenantAccess.GetRequired(http).TenantId == internalTenantId
        ? await modelGroups.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync()
        : new List<BsonDocument>();
    var gwDocs = await gwModelPools.Find(TenantAccess.Filter(http, filter)).Sort(Builders<BsonDocument>.Sort.Ascending("Priority")).ToListAsync();
    var gwIds = gwDocs.Select(d => d.GetStringOrEmpty("_id")).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet(StringComparer.Ordinal);
    var docs = gwDocs.Concat(mapDocs.Where(d => !gwIds.Contains(d.GetStringOrEmpty("_id")))).ToList();
    var hours = sinceHours is > 0 and <= 24 * 90 ? sinceHours.Value : 24 * 7;
    var since = DateTime.UtcNow.AddHours(-hours);
    var appCallerDocs = await gwAppCallers.Find(TenantAccess.FilterTeamScope(http, fb.Empty))
        .Project(Builders<BsonDocument>.Projection
            .Include("_id")
            .Include("AppCallerCode")
            .Include("Title")
            .Include("Status")
            .Include("ModelPoolId")
            .Include("AllowedModelPoolIds")
            .Include("DefaultModelPoolId"))
        .ToListAsync();
    var logFilter = Builders<BsonDocument>.Filter.Gte("StartedAt", since);
    var logStatsDocs = await logs.Aggregate()
        .Match(TenantAccess.FilterTeamScope(http, logFilter))
        .Group(new BsonDocument
        {
            { "_id", "$ModelPoolId" },
            { "Requests", new BsonDocument("$sum", 1) },
            { "Succeeded", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                {
                    new BsonDocument("$eq", new BsonArray { "$Status", "succeeded" }), 1, 0,
                })) },
            { "Failed", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                {
                    new BsonDocument("$eq", new BsonArray { "$Status", "failed" }), 1, 0,
                })) },
            { "AverageDurationMs", new BsonDocument("$avg", "$DurationMs") },
            { "LastRequestAt", new BsonDocument("$max", "$StartedAt") },
        })
        .ToListAsync();
    var logStatsByPool = logStatsDocs
        .Where(d => !string.IsNullOrWhiteSpace(d.GetStringOrEmpty("_id")))
        .ToDictionary(d => d.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var defaultPointers = (await gwModelPoolTypes.Find(Builders<BsonDocument>.Filter.Eq("TenantId", tenantId)).ToListAsync())
        .Where(d => !string.IsNullOrWhiteSpace(d.GetStringOrEmpty("DefaultPoolId")))
        .ToDictionary(d => d.GetStringOrEmpty("Code"), d => d.GetStringOrEmpty("DefaultPoolId"), StringComparer.OrdinalIgnoreCase);
    var items = docs.Select(MapPool).ToList();
    foreach (var item in items)
    {
        if (string.Equals(item.Authority, "llm_gateway", StringComparison.OrdinalIgnoreCase)
            && defaultPointers.TryGetValue(item.ModelType, out var defaultPoolId))
        {
            item.IsDefaultForType = string.Equals(item.Id, defaultPoolId, StringComparison.Ordinal);
        }
        var bound = appCallerDocs
            .Where(d => string.Equals(d.AsNullableString("ModelPoolId"), item.Id, StringComparison.Ordinal)
                || string.Equals(d.AsNullableString("DefaultModelPoolId"), item.Id, StringComparison.Ordinal)
                || GetStringArray(d, "AllowedModelPoolIds").Contains(item.Id, StringComparer.Ordinal))
            .OrderByDescending(d => string.Equals(d.AsNullableString("Status"), "active", StringComparison.OrdinalIgnoreCase))
            .ThenBy(d => d.AsNullableString("Title") ?? d.GetStringOrEmpty("AppCallerCode"), StringComparer.OrdinalIgnoreCase)
            .ToList();
        item.BoundAppCallerCount = bound.Count;
        item.BoundAppCallers = bound.Take(5).Select(d => new PoolAppCallerItem
        {
            Id = d.GetStringOrEmpty("_id"),
            AppCallerCode = d.GetStringOrEmpty("AppCallerCode"),
            Title = d.AsNullableString("Title"),
            Status = d.AsNullableString("Status") ?? "discovered",
        }).ToList();

        item.TrafficWindowHours = hours;
        logStatsByPool.TryGetValue(item.Id, out var stats);
        item.RecentRequests = stats?.AsNullableLong("Requests") ?? 0;
        item.RecentSucceeded = stats?.AsNullableLong("Succeeded") ?? 0;
        item.RecentFailed = stats?.AsNullableLong("Failed") ?? 0;
        item.RecentSuccessRatePercent = item.RecentRequests == 0
            ? null
            : Math.Round(item.RecentSucceeded * 100m / item.RecentRequests, 1, MidpointRounding.AwayFromZero);
        item.AverageDurationMs = stats?.AsNullableLong("AverageDurationMs");
        var recentTen = await logs.Find(TenantAccess.FilterTeamScope(http, fb.And(
                fb.Eq("ModelPoolId", item.Id),
                fb.Gte("StartedAt", since),
                fb.In("Status", new[] { "succeeded", "failed" }))))
            .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt"))
            .Project(Builders<BsonDocument>.Projection.Include("Status"))
            .Limit(10)
            .ToListAsync();
        item.RecentTenRequests = recentTen.Count;
        item.RecentTenSuccessRatePercent = recentTen.Count == 0
            ? null
            : Math.Round(recentTen.Count(log => string.Equals(log.AsNullableString("Status"), "succeeded", StringComparison.Ordinal)) * 100m / recentTen.Count, 1, MidpointRounding.AwayFromZero);
        item.LastRequestAt = stats?.AsNullableUtcDateTime("LastRequestAt").ToIso();

        item.HealthyMembers = item.Models.Count(model => model.HealthStatus == 0);
        item.DegradedMembers = item.Models.Count(model => model.HealthStatus == 1);
        item.UnavailableMembers = item.Models.Count(model => model.HealthStatus == 2);
        item.Health = item.Models.Count == 0
            ? "empty"
            : item.HealthyMembers == 0
                ? "unavailable"
                : item.DegradedMembers > 0 || item.UnavailableMembers > 0
                    ? "degraded"
                    : "healthy";
    }
    var data = new PoolsData { Items = items, Total = docs.Count };
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
    // 指纹只给配置权限的人：列表本身 LogsRead 就能看，但「认出是哪一把 key」要再高一档
    var revealFingerprint = TenantAccess.HasPermission(http.User, LlmGwPermissions.ConfigWrite);
    var data = new PlatformsData
    {
        Items = docs.Select(d => MapPlatform(d, config, revealFingerprint)).ToList(),
        Total = docs.Count,
    };
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

// 逻辑模型目录：调用方只看到 PublicId；Offerings 展示实际 Provider/Endpoint 供运维维护。
app.MapGet("/gw/logical-models", async (HttpContext http, string? modelType, bool? enabled) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var filters = new List<FilterDefinition<BsonDocument>>();
    if (!string.IsNullOrWhiteSpace(modelType)) filters.Add(fb.Eq("ModelType", modelType.Trim()));
    if (enabled is not null) filters.Add(fb.Eq("Enabled", enabled.Value));
    var filter = filters.Count == 0 ? fb.Empty : fb.And(filters);
    var logicalDocs = await gwLogicalModels.Find(TenantAccess.Filter(http, filter))
        .Sort(Builders<BsonDocument>.Sort.Ascending("DisplayOrder").Ascending("Name"))
        .ToListAsync();
    var logicalIds = logicalDocs.Select(x => x.GetStringOrEmpty("_id")).Where(x => x.Length > 0).ToList();
    var offeringDocs = logicalIds.Count == 0
        ? new List<BsonDocument>()
        : await gwModelOfferings.Find(TenantAccess.Filter(http, fb.In("LogicalModelId", logicalIds)))
            .Sort(Builders<BsonDocument>.Sort.Ascending("Priority"))
            .ToListAsync();
    var modelDocs = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
    var exchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync();
    var platformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    var data = new LogicalModelsData
    {
        Items = logicalDocs.Select(x => MapLogicalModel(x, offeringDocs, modelDocs, exchangeDocs, platformDocs)).ToList(),
        Total = logicalDocs.Count,
    };
    return Json(ApiEnvelope<LogicalModelsData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

app.MapPost("/gw/logical-models", async (HttpContext http, [FromBody] CreateLogicalModelRequest? body) =>
{
    var publicId = body?.PublicId?.Trim() ?? string.Empty;
    var name = body?.Name?.Trim() ?? string.Empty;
    var modelType = body?.ModelType?.Trim().ToLowerInvariant() ?? string.Empty;
    if (publicId.Length is < 2 or > 160 || !System.Text.RegularExpressions.Regex.IsMatch(publicId, "^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$"))
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_PUBLIC_ID", "模型标识只允许字母、数字、点、下划线、冒号、斜杠和连字符"), jsonOptions, 400);
    if (name.Length is < 2 or > 120)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_NAME", "模型名称长度必须为 2 到 120"), jsonOptions, 400);
    if (modelType.Length is < 2 or > 40 || !System.Text.RegularExpressions.Regex.IsMatch(modelType, "^[a-z0-9-]+$"))
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_MODEL_TYPE", "模型类型格式不正确"), jsonOptions, 400);
    var strategy = (body?.RoutingStrategy ?? "priority").Trim().ToLowerInvariant();
    if (strategy is not ("priority" or "weighted"))
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_STRATEGY", "路由策略仅支持 priority 或 weighted"), jsonOptions, 400);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var normalized = publicId.ToLowerInvariant();
    if (await gwLogicalModels.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            Builders<BsonDocument>.Filter.Eq("PublicIdNormalized", normalized))).AnyAsync())
        return Json(ApiEnvelope<LogicalModelItem>.Fail("DUPLICATE_LOGICAL_MODEL", "当前租户已存在相同模型标识"), jsonOptions, 409);

    var now = DateTime.UtcNow;
    var id = $"gw-logical-{Guid.NewGuid():N}";
    var capabilities = LogicalModelCapabilityPolicy.Normalize(modelType, body?.Capabilities);
    var appCallers = (body?.AllowedAppCallerCodes ?? new()).Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    var document = new BsonDocument
    {
        { "_id", id }, { "TenantId", tenantId }, { "PublicId", publicId }, { "PublicIdNormalized", normalized },
        { "Name", name }, { "ModelType", modelType }, { "Capabilities", new BsonArray(capabilities) },
        { "AllowedAppCallerCodes", new BsonArray(appCallers) }, { "RoutingStrategy", strategy },
        { "Enabled", true }, { "DisplayOrder", Math.Clamp(body?.DisplayOrder ?? 100, 0, 10000) },
        { "Description", string.IsNullOrWhiteSpace(body?.Description) ? BsonNull.Value : body.Description.Trim() },
        { "CreatedAt", now }, { "UpdatedAt", now },
    };
    await gwLogicalModels.InsertOneAsync(document);
    await WriteOperationAuditAsync(operationAudits, http, "logical-model.create", "llmgw_logical_model", id, name, true, null,
        new BsonDocument { { "publicId", publicId }, { "modelType", modelType }, { "routingStrategy", strategy } });
    return Json(ApiEnvelope<LogicalModelItem>.Ok(MapLogicalModel(
        document,
        Array.Empty<BsonDocument>(),
        Array.Empty<BsonDocument>(),
        Array.Empty<BsonDocument>(),
        Array.Empty<BsonDocument>())), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

// 删除逻辑模型。它名下的 offering 是从属子项——离开逻辑模型没有独立意义，
// 留着就是一堆指向不存在父项的孤儿，所以跟着一起删，并把条数如实回报。
app.MapDelete("/gw/logical-models/{id}", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwLogicalModels.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<LogicalModelDeleteResult>.Fail("NOT_FOUND", $"逻辑模型不存在：{id}"), jsonOptions, 404);

    var offeringFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("LogicalModelId", id));
    var offeringCount = (int)await gwModelOfferings.CountDocumentsAsync(offeringFilter);
    await gwModelOfferings.DeleteManyAsync(offeringFilter);
    await gwLogicalModels.DeleteOneAsync(filter);

    await WriteOperationAuditAsync(
        operationAudits, http,
        action: "logical-model.delete", targetType: "llmgw_logical_model", targetId: id,
        targetName: doc.AsNullableString("Name"), success: true, reason: null,
        changes: new BsonDocument
        {
            { "name", ToBsonAuditValue(doc.AsNullableString("Name")) },
            { "publicId", ToBsonAuditValue(doc.AsNullableString("PublicId")) },
            { "modelType", ToBsonAuditValue(doc.AsNullableString("ModelType")) },
            { "offeringsDeleted", offeringCount },
        });
    return Json(ApiEnvelope<LogicalModelDeleteResult>.Ok(new LogicalModelDeleteResult { OfferingsDeleted = offeringCount }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/logical-models/{id}", async (HttpContext http, string id, [FromBody] UpdateLogicalModelRequest? body) =>
{
    if (body is null)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_INPUT", "缺少更新内容"), jsonOptions, 400);
    var updates = new List<UpdateDefinition<BsonDocument>>();
    if (body.Name is not null)
    {
        var name = body.Name.Trim();
        if (name.Length is < 2 or > 120)
            return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_NAME", "模型名称长度必须为 2 到 120"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("Name", name));
    }
    if (body.RoutingStrategy is not null)
    {
        var strategy = body.RoutingStrategy.Trim().ToLowerInvariant();
        if (strategy is not ("priority" or "weighted"))
            return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_STRATEGY", "路由策略仅支持 priority 或 weighted"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("RoutingStrategy", strategy));
    }
    if (body.Capabilities is not null)
    {
        var existing = await gwLogicalModels.Find(
                TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)))
            .Project(Builders<BsonDocument>.Projection.Include("ModelType"))
            .FirstOrDefaultAsync();
        var existingModelType = existing?.GetStringOrEmpty("ModelType") ?? string.Empty;
        var capabilities = LogicalModelCapabilityPolicy.Normalize(existingModelType, body.Capabilities);
        updates.Add(Builders<BsonDocument>.Update.Set("Capabilities", new BsonArray(capabilities)));
    }
    if (body.AllowedAppCallerCodes is not null)
    {
        var appCallers = body.AllowedAppCallerCodes.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        updates.Add(Builders<BsonDocument>.Update.Set("AllowedAppCallerCodes", new BsonArray(appCallers)));
    }
    if (body.DisplayOrder is not null)
        updates.Add(Builders<BsonDocument>.Update.Set("DisplayOrder", Math.Clamp(body.DisplayOrder.Value, 0, 10000)));
    if (body.Description is not null)
        updates.Add(string.IsNullOrWhiteSpace(body.Description)
            ? Builders<BsonDocument>.Update.Unset("Description")
            : Builders<BsonDocument>.Update.Set("Description", body.Description.Trim()));
    if (updates.Count == 0)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_INPUT", "没有可更新字段"), jsonOptions, 400);
    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
    var updated = await gwLogicalModels.FindOneAndUpdateAsync(
        TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)),
        Builders<BsonDocument>.Update.Combine(updates),
        new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After });
    if (updated is null)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("NOT_FOUND", "逻辑模型不存在"), jsonOptions, 404);
    await WriteOperationAuditAsync(operationAudits, http, "logical-model.update", "llmgw_logical_model", id, updated.GetStringOrEmpty("Name"), true, null,
        new BsonDocument { { "fieldCount", updates.Count - 1 } });
    var offerings = await gwModelOfferings.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("LogicalModelId", id))).ToListAsync();
    var modelDocs = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
    var exchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync();
    var platformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    return Json(ApiEnvelope<LogicalModelItem>.Ok(MapLogicalModel(updated, offerings, modelDocs, exchangeDocs, platformDocs)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPost("/gw/logical-models/{id}/offerings", async (HttpContext http, string id, [FromBody] CreateModelOfferingRequest? body) =>
{
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var fb = Builders<BsonDocument>.Filter;
    var logical = await gwLogicalModels.Find(TenantAccess.Filter(http, fb.Eq("_id", id))).FirstOrDefaultAsync();
    if (logical is null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("LOGICAL_MODEL_NOT_FOUND", "逻辑模型不存在"), jsonOptions, 404);
    var targetKind = (body?.TargetKind ?? "model").Trim().ToLowerInvariant();
    var targetId = body?.TargetId?.Trim() ?? string.Empty;
    if (targetKind is not ("model" or "exchange") || targetId.Length == 0)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_TARGET", "必须选择 model 或 exchange 上游"), jsonOptions, 400);
    var target = targetKind == "model"
        ? await gwModels.Find(TenantAccess.Filter(http, fb.Eq("_id", targetId))).FirstOrDefaultAsync()
        : await gwModelExchanges.Find(TenantAccess.Filter(http, fb.Eq("_id", targetId))).FirstOrDefaultAsync();
    if (target is null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("TARGET_NOT_FOUND", "上游目标不存在或不属于当前租户"), jsonOptions, 404);
    if (target.AsNullableBool("Enabled") == false)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("TARGET_DISABLED", "上游目标已停用"), jsonOptions, 409);
    if (body?.MaxConcurrency is < 1 or > 10000)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_MAX_CONCURRENCY", "最大并发必须为 1 到 10000"), jsonOptions, 400);
    if (body?.RateLimitPerMinute is < 1 or > 1000000)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_RATE_LIMIT", "每分钟速率必须为 1 到 1000000"), jsonOptions, 400);
    if (!IsSafeOfferingEndpointPath(body?.EndpointPath))
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_ENDPOINT_PATH", "Endpoint path 必须是相对路径，且不能包含控制字符或反斜杠"), jsonOptions, 400);
    var targetPlatform = targetKind == "model" && !string.IsNullOrWhiteSpace(target.AsNullableString("PlatformId"))
        ? await gwPlatforms.Find(TenantAccess.Filter(http, fb.Eq("_id", target.AsNullableString("PlatformId")))).FirstOrDefaultAsync()
        : null;
    var createAsrContractError = AsrOfferingContractPolicy.Validate(
        logical.GetStringOrEmpty("ModelType"),
        targetKind,
        AsrOfferingContractPolicy.ResolvePhysicalModel(
            body?.UpstreamModelId,
            target.AsNullableString("ModelName"),
            target.AsNullableString("ModelId")),
        body?.EndpointPath,
        body?.Protocol ?? target.AsNullableString("Protocol"),
        targetPlatform?.AsNullableString("PlatformType"));
    if (createAsrContractError is not null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail(
            AsrOfferingContractPolicy.ErrorCode,
            createAsrContractError), jsonOptions, 409);
    var duplicate = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Eq("LogicalModelId", id),
        fb.Eq("TargetKind", targetKind),
        fb.Eq("TargetId", targetId),
        fb.Not(fb.Exists("SupersededByOfferingId")));
    if (await gwModelOfferings.Find(duplicate).AnyAsync())
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("DUPLICATE_OFFERING", "该上游已绑定到此逻辑模型"), jsonOptions, 409);

    var now = DateTime.UtcNow;
    var offeringId = $"gw-offering-{Guid.NewGuid():N}";
    var document = new BsonDocument
    {
        { "_id", offeringId }, { "TenantId", tenantId }, { "LogicalModelId", id },
        { "TargetKind", targetKind }, { "TargetId", targetId },
        { "UpstreamModelId", string.IsNullOrWhiteSpace(body?.UpstreamModelId) ? BsonNull.Value : body.UpstreamModelId.Trim() },
        { "Protocol", string.IsNullOrWhiteSpace(body?.Protocol) ? BsonNull.Value : body.Protocol.Trim().ToLowerInvariant() },
        { "EndpointPath", string.IsNullOrWhiteSpace(body?.EndpointPath) ? BsonNull.Value : body.EndpointPath.Trim() },
        { "Priority", Math.Clamp(body?.Priority ?? 100, 0, 10000) }, { "Weight", Math.Clamp(body?.Weight ?? 100, 1, 10000) },
        { "Enabled", true }, { "HealthStatus", 0 }, { "ConsecutiveFailures", 0 }, { "ConsecutiveSuccesses", 0 },
        { "MaxConcurrency", body?.MaxConcurrency is > 0 ? body.MaxConcurrency.Value : BsonNull.Value },
        { "RateLimitPerMinute", body?.RateLimitPerMinute is > 0 ? body.RateLimitPerMinute.Value : BsonNull.Value },
        { "Notes", string.IsNullOrWhiteSpace(body?.Notes) ? BsonNull.Value : body.Notes.Trim() },
        { "CreatedAt", now }, { "UpdatedAt", now },
    };
    await gwModelOfferings.InsertOneAsync(document);
    await WriteOperationAuditAsync(operationAudits, http, "model-offering.create", "llmgw_model_offering", offeringId, targetId, true, null,
        new BsonDocument { { "logicalModelId", id }, { "targetKind", targetKind }, { "targetId", targetId } });
    var platformsForMap = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    var item = MapLogicalModel(
        logical,
        new List<BsonDocument> { document },
        targetKind == "model" ? new List<BsonDocument> { target } : new List<BsonDocument>(),
        targetKind == "exchange" ? new List<BsonDocument> { target } : new List<BsonDocument>(),
        platformsForMap).Offerings.Single();
    return Json(ApiEnvelope<ModelOfferingItem>.Ok(item), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/logical-models/{logicalId}/offerings/{offeringId}", async (HttpContext http, string logicalId, string offeringId, [FromBody] UpdateModelOfferingRequest? body) =>
{
    var fb = Builders<BsonDocument>.Filter;
    if (body is null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_INPUT", "缺少更新内容"), jsonOptions, 400);
    if (body.MaxConcurrency is < 0 or > 10000)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_MAX_CONCURRENCY", "最大并发必须为空、0 或 1 到 10000"), jsonOptions, 400);
    if (body.RateLimitPerMinute is < 0 or > 1000000)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_RATE_LIMIT", "每分钟速率必须为空、0 或 1 到 1000000"), jsonOptions, 400);
    if (!IsSafeOfferingEndpointPath(body.EndpointPath))
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_ENDPOINT_PATH", "Endpoint path 必须是相对路径，且不能包含控制字符或反斜杠"), jsonOptions, 400);
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("_id", offeringId), Builders<BsonDocument>.Filter.Eq("LogicalModelId", logicalId)));
    var existing = await gwModelOfferings.Find(filter).FirstOrDefaultAsync();
    if (existing is null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("NOT_FOUND", "Offering 不存在"), jsonOptions, 404);
    if (existing.Contains("SupersededByOfferingId"))
        return Json(ApiEnvelope<ModelOfferingItem>.Fail(
            "OFFERING_SUPERSEDED",
            "该 Offering 已有新版本，请刷新后编辑当前版本"), jsonOptions, 409);
    var logicalForContract = await gwLogicalModels.Find(TenantAccess.Filter(
        http,
        Builders<BsonDocument>.Filter.Eq("_id", logicalId))).FirstOrDefaultAsync();
    if (logicalForContract is null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("LOGICAL_MODEL_NOT_FOUND", "逻辑模型不存在"), jsonOptions, 404);
    var targetKind = existing.GetStringOrEmpty("TargetKind");
    var targetId = existing.GetStringOrEmpty("TargetId");
    var target = targetKind == "model"
        ? await gwModels.Find(TenantAccess.Filter(http, fb.Eq("_id", targetId))).FirstOrDefaultAsync()
        : await gwModelExchanges.Find(TenantAccess.Filter(http, fb.Eq("_id", targetId))).FirstOrDefaultAsync();
    var effectiveUpstreamModel = AsrOfferingContractPolicy.ResolvePhysicalModel(
        body.UpstreamModelId is null ? existing.AsNullableString("UpstreamModelId") : body.UpstreamModelId,
        target?.AsNullableString("ModelName"),
        target?.AsNullableString("ModelId"));
    var effectiveEndpointPath = body.EndpointPath is null
        ? existing.AsNullableString("EndpointPath")
        : body.EndpointPath;
    var effectiveProtocol = body.Protocol is null
        ? existing.AsNullableString("Protocol") ?? target?.AsNullableString("Protocol")
        : string.IsNullOrWhiteSpace(body.Protocol)
            ? target?.AsNullableString("Protocol")
            : body.Protocol.Trim();
    var targetPlatform = targetKind == "model" && !string.IsNullOrWhiteSpace(target?.AsNullableString("PlatformId"))
        ? await gwPlatforms.Find(TenantAccess.Filter(http, fb.Eq("_id", target!.AsNullableString("PlatformId")))).FirstOrDefaultAsync()
        : null;
    var updateAsrContractError = AsrOfferingContractPolicy.Validate(
        logicalForContract.GetStringOrEmpty("ModelType"),
        targetKind,
        effectiveUpstreamModel,
        effectiveEndpointPath,
        effectiveProtocol,
        targetPlatform?.AsNullableString("PlatformType"));
    if (updateAsrContractError is not null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail(
            AsrOfferingContractPolicy.ErrorCode,
            updateAsrContractError), jsonOptions, 409);
    var updates = new List<UpdateDefinition<BsonDocument>>();
    if (body.UpstreamModelId is not null) updates.Add(SetOrUnset("UpstreamModelId", body.UpstreamModelId));
    if (body.Protocol is not null) updates.Add(SetOrUnset("Protocol", body.Protocol.ToLowerInvariant()));
    if (body.EndpointPath is not null) updates.Add(SetOrUnset("EndpointPath", body.EndpointPath));
    if (body.Priority is not null) updates.Add(Builders<BsonDocument>.Update.Set("Priority", Math.Clamp(body.Priority.Value, 0, 10000)));
    if (body.Weight is not null) updates.Add(Builders<BsonDocument>.Update.Set("Weight", Math.Clamp(body.Weight.Value, 1, 10000)));
    if (body.MaxConcurrency is not null) updates.Add(body.MaxConcurrency > 0 ? Builders<BsonDocument>.Update.Set("MaxConcurrency", body.MaxConcurrency.Value) : Builders<BsonDocument>.Update.Unset("MaxConcurrency"));
    if (body.RateLimitPerMinute is not null) updates.Add(body.RateLimitPerMinute > 0 ? Builders<BsonDocument>.Update.Set("RateLimitPerMinute", body.RateLimitPerMinute.Value) : Builders<BsonDocument>.Update.Unset("RateLimitPerMinute"));
    if (body.Notes is not null) updates.Add(SetOrUnset("Notes", body.Notes));
    if (updates.Count == 0)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_INPUT", "没有可更新字段"), jsonOptions, 400);
    var changedFieldCount = updates.Count;
    var routingConfigurationChanged = OfferingRoutingChangePolicy.HasChanged(
        existing.AsNullableString("UpstreamModelId"),
        existing.AsNullableString("Protocol"),
        existing.AsNullableString("EndpointPath"),
        body.UpstreamModelId,
        body.Protocol,
        body.EndpointPath);
    if (routingConfigurationChanged)
    {
        // Offering ID 是已受理异步任务的持久化路由身份，协议、Endpoint 与上游模型不得原地改写。
        // 生成一个新 Offering 给后续任务使用；旧 Offering 退出新任务调度，但仍保留原路由，
        // 使已经付费提交的视频任务在 worker 重启后仍能按旧 ID 轮询和下载。
        var now = DateTime.UtcNow;
        var replacementId = $"gw-offering-{Guid.NewGuid():N}";
        var replacement = existing.DeepClone().AsBsonDocument;
        replacement["_id"] = replacementId;
        ApplyModelOfferingUpdate(replacement, body);
        replacement["Enabled"] = false;
        replacement["HealthStatus"] = 0;
        replacement["ConsecutiveFailures"] = 0;
        replacement["ConsecutiveSuccesses"] = 0;
        replacement["SupersedesOfferingId"] = offeringId;
        var stagingMarker = $"pending:{replacementId}";
        replacement["SupersededByOfferingId"] = stagingMarker;
        replacement["CreatedAt"] = now;
        replacement["UpdatedAt"] = now;
        replacement.Remove("SupersededAt");

        await gwModelOfferings.InsertOneAsync(replacement);
        var retirementFilter = fb.And(filter, fb.Not(fb.Exists("SupersededByOfferingId")));
        var retired = await gwModelOfferings.FindOneAndUpdateAsync(
            retirementFilter,
            Builders<BsonDocument>.Update
                .Set("Enabled", false)
                .Set("SupersededByOfferingId", replacementId)
                .Set("SupersededAt", now)
                .Set("UpdatedAt", now),
            new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After });
        if (retired is null)
        {
            await gwModelOfferings.DeleteOneAsync(
                TenantAccess.Filter(http, fb.Eq("_id", replacementId)));
            return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                "OFFERING_EDIT_CONFLICT",
                "该 Offering 已被其他管理员更新，请刷新后重试"), jsonOptions, 409);
        }

        var replacementEnabled = existing.AsNullableBool("Enabled") ?? true;
        var promoted = await gwModelOfferings.UpdateOneAsync(
            TenantAccess.Filter(http, fb.And(
                fb.Eq("_id", replacementId),
                fb.Eq("SupersededByOfferingId", stagingMarker))),
            Builders<BsonDocument>.Update
                .Unset("SupersededByOfferingId")
                .Set("Enabled", replacementEnabled)
                .Set("UpdatedAt", DateTime.UtcNow));
        if (promoted.ModifiedCount != 1)
        {
            await gwModelOfferings.UpdateOneAsync(
                TenantAccess.Filter(http, fb.And(
                    fb.Eq("_id", offeringId),
                    fb.Eq("SupersededByOfferingId", replacementId))),
                Builders<BsonDocument>.Update
                    .Set("Enabled", replacementEnabled)
                    .Unset("SupersededByOfferingId")
                    .Unset("SupersededAt")
                    .Set("UpdatedAt", DateTime.UtcNow));
            await gwModelOfferings.DeleteOneAsync(
                TenantAccess.Filter(http, fb.Eq("_id", replacementId)));
            return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                "OFFERING_PROMOTION_FAILED",
                "新路由未能接管流量，原 Offering 已恢复，请重试"), jsonOptions, 503);
        }
        replacement.Remove("SupersededByOfferingId");
        replacement["Enabled"] = replacementEnabled;

        await WriteOperationAuditAsync(
            operationAudits,
            http,
            "model-offering.route-replaced",
            "llmgw_model_offering",
            replacementId,
            replacement.GetStringOrEmpty("TargetId"),
            true,
            null,
            new BsonDocument
            {
                { "logicalModelId", logicalId },
                { "supersededOfferingId", offeringId },
                { "fieldCount", changedFieldCount },
                { "healthReset", true },
            });
        var logicalForReplacement = await gwLogicalModels.Find(
            TenantAccess.Filter(http, fb.Eq("_id", logicalId))).FirstOrDefaultAsync();
        var replacementModels = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
        var replacementExchanges = await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync();
        var replacementPlatforms = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
        return Json(ApiEnvelope<ModelOfferingItem>.Ok(MapLogicalModel(
            logicalForReplacement!,
            new List<BsonDocument> { replacement },
            replacementModels,
            replacementExchanges,
            replacementPlatforms).Offerings.Single()), jsonOptions);
    }
    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
    var updated = await gwModelOfferings.FindOneAndUpdateAsync(filter, Builders<BsonDocument>.Update.Combine(updates),
        new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After });
    if (updated is null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("NOT_FOUND", "Offering 不存在"), jsonOptions, 404);
    await WriteOperationAuditAsync(operationAudits, http, "model-offering.update", "llmgw_model_offering", offeringId, updated.GetStringOrEmpty("TargetId"), true, null,
        new BsonDocument { { "logicalModelId", logicalId }, { "fieldCount", changedFieldCount }, { "healthReset", routingConfigurationChanged } });
    var logical = await gwLogicalModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", logicalId))).FirstOrDefaultAsync();
    var modelDocs = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
    var exchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync();
    var platformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    return Json(ApiEnvelope<ModelOfferingItem>.Ok(MapLogicalModel(logical!, new List<BsonDocument> { updated }, modelDocs, exchangeDocs, platformDocs).Offerings.Single()), jsonOptions);

    UpdateDefinition<BsonDocument> SetOrUnset(string field, string? value)
        => string.IsNullOrWhiteSpace(value) ? Builders<BsonDocument>.Update.Unset(field) : Builders<BsonDocument>.Update.Set(field, value.Trim());
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/logical-models/{id}/enabled", async (HttpContext http, string id, [FromBody] ToggleEnabledRequest? body) =>
{
    if (body?.Enabled is not bool enabled)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_INPUT", "缺少 enabled 字段"), jsonOptions, 400);
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var existing = await gwLogicalModels.Find(filter).FirstOrDefaultAsync();
    if (existing is null) return Json(ApiEnvelope<LogicalModelItem>.Fail("NOT_FOUND", "逻辑模型不存在"), jsonOptions, 404);
    if (enabled && string.Equals(existing.GetStringOrEmpty("ModelType"), "asr", StringComparison.OrdinalIgnoreCase))
    {
        var enabledOfferings = await gwModelOfferings.Find(TenantAccess.Filter(http,
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("LogicalModelId", id),
                Builders<BsonDocument>.Filter.Eq("Enabled", true),
                Builders<BsonDocument>.Filter.Not(Builders<BsonDocument>.Filter.Exists("SupersededByOfferingId")))))
            .ToListAsync();
        var modelDocs = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
        var platformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
        foreach (var offering in enabledOfferings)
        {
            var target = modelDocs.FirstOrDefault(model => model.GetStringOrEmpty("_id") == offering.GetStringOrEmpty("TargetId"));
            var platform = target is null
                ? null
                : platformDocs.FirstOrDefault(item => item.GetStringOrEmpty("_id") == target.AsNullableString("PlatformId"));
            var contractError = ValidateAsrOfferingContract(existing, offering, target, platform);
            if (contractError is not null)
                return Json(ApiEnvelope<LogicalModelItem>.Fail(
                    AsrOfferingContractPolicy.ErrorCode,
                    contractError), jsonOptions, 409);
        }
    }
    var updated = await gwLogicalModels.FindOneAndUpdateAsync(filter,
        Builders<BsonDocument>.Update.Set("Enabled", enabled).Set("UpdatedAt", DateTime.UtcNow),
        new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After });
    return Json(ApiEnvelope<LogicalModelItem>.Ok(MapLogicalModel(
        updated,
        Array.Empty<BsonDocument>(),
        Array.Empty<BsonDocument>(),
        Array.Empty<BsonDocument>(),
        Array.Empty<BsonDocument>())), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/logical-models/{logicalId}/offerings/{offeringId}/enabled", async (HttpContext http, string logicalId, string offeringId, [FromBody] ToggleEnabledRequest? body) =>
{
    if (body?.Enabled is not bool enabled)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_INPUT", "缺少 enabled 字段"), jsonOptions, 400);
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("_id", offeringId), Builders<BsonDocument>.Filter.Eq("LogicalModelId", logicalId)));
    var existing = await gwModelOfferings.Find(filter).FirstOrDefaultAsync();
    if (existing is null) return Json(ApiEnvelope<ModelOfferingItem>.Fail("NOT_FOUND", "Offering 不存在"), jsonOptions, 404);
    var logical = await gwLogicalModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", logicalId))).FirstOrDefaultAsync();
    if (logical is null) return Json(ApiEnvelope<ModelOfferingItem>.Fail("LOGICAL_MODEL_NOT_FOUND", "逻辑模型不存在"), jsonOptions, 404);
    if (enabled)
    {
        var targetKind = existing.GetStringOrEmpty("TargetKind");
        var targetId = existing.GetStringOrEmpty("TargetId");
        var target = targetKind == "model"
            ? await gwModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", targetId))).FirstOrDefaultAsync()
            : await gwModelExchanges.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", targetId))).FirstOrDefaultAsync();
        var platform = targetKind == "model" && !string.IsNullOrWhiteSpace(target?.AsNullableString("PlatformId"))
            ? await gwPlatforms.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", target!.AsNullableString("PlatformId")))).FirstOrDefaultAsync()
            : null;
        var contractError = ValidateAsrOfferingContract(logical, existing, target, platform);
        if (contractError is not null)
            return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                AsrOfferingContractPolicy.ErrorCode,
                contractError), jsonOptions, 409);
    }
    var updated = await gwModelOfferings.FindOneAndUpdateAsync(filter,
        Builders<BsonDocument>.Update.Set("Enabled", enabled).Set("UpdatedAt", DateTime.UtcNow),
        new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After });
    var modelDocs = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
    var exchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync();
    var platformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    var item = MapLogicalModel(logical!, new List<BsonDocument> { updated }, modelDocs, exchangeDocs, platformDocs).Offerings.Single();
    return Json(ApiEnvelope<ModelOfferingItem>.Ok(item), jsonOptions);
}).RequireAuthorization("ConfigWrite");

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

app.MapGet("/gw/exchanges/meta", () =>
{
    var data = new ExchangeMetaData
    {
        TransformerTypes = GatewayConfigurationProvisioning.GetExchangeTransformerOptions().ToList(),
        AuthSchemes = GatewayConfigurationProvisioning.GetExchangeAuthSchemeOptions().ToList(),
        ModelTypes = GatewayConfigurationProvisioning.GetExchangeModelTypeOptions().ToList(),
    };
    return Json(ApiEnvelope<ExchangeMetaData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 图片分层能力：管理员只提交一次 fal.ai Key，LLMGW 幂等完成 Exchange 与通用逻辑能力发布。
app.MapGet("/gw/capabilities/image-layering", async (HttpContext http) =>
{
    var status = await BuildImageLayeringCapabilityStatusAsync(
        gwModelExchanges,
        gwLogicalModels,
        gwModelOfferings,
        logs,
        TenantAccess.GetRequired(http).TenantId,
        http.RequestAborted);
    return Json(ApiEnvelope<ImageLayeringCapabilityStatus>.Ok(status), jsonOptions);
}).RequireAuthorization("LogsRead");

app.MapPost("/gw/capabilities/image-layering/install", async (
    HttpContext http,
    [FromBody] InstallImageLayeringCapabilityRequest? body) =>
{
    var apiKey = body?.ApiKey?.Trim() ?? string.Empty;
    if (apiKey.Length == 0)
        return Json(ApiEnvelope<ImageLayeringCapabilityStatus>.Fail("INVALID_INPUT", "fal.ai API Key 不能为空"), jsonOptions, 400);
    if (apiKey.Length > 20000)
        return Json(ApiEnvelope<ImageLayeringCapabilityStatus>.Fail("INVALID_INPUT", "fal.ai API Key 长度超出限制"), jsonOptions, 400);

    var access = TenantAccess.GetRequired(http);
    var tenantId = access.TenantId;
    string encryptedApiKey;
    try
    {
        encryptedApiKey = GwApiKeyCrypto.Encrypt(apiKey, config);
    }
    catch (InvalidOperationException ex)
    {
        return Json(ApiEnvelope<ImageLayeringCapabilityStatus>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
    }

    var fb = Builders<BsonDocument>.Filter;
    var now = DateTime.UtcNow;
    var exchangeFilter = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Or(
            fb.Eq("TransformerType", FalImageLayeringProvisioning.TransformerType),
            fb.Eq("NameNormalized", FalImageLayeringProvisioning.ExchangeNameNormalized)));
    var existingExchange = await gwModelExchanges.Find(exchangeFilter).FirstOrDefaultAsync(http.RequestAborted);
    var exchangeId = existingExchange?.GetStringOrEmpty("_id") is { Length: > 0 } existingExchangeId
        ? existingExchangeId
        : $"gw-exchange-{Guid.NewGuid():N}";
    var exchangeDraft = FalImageLayeringProvisioning.CreateExchangeDraft(apiKey);
    if (existingExchange is null)
    {
        var exchangeDocument = GatewayConfigurationProvisioning.BuildExchangeDocument(
            exchangeDraft,
            tenantId,
            exchangeId,
            encryptedApiKey,
            now);
        await gwModelExchanges.InsertOneAsync(exchangeDocument, cancellationToken: http.RequestAborted);
    }
    else
    {
        await gwModelExchanges.UpdateOneAsync(
            exchangeFilter,
            Builders<BsonDocument>.Update
                .Set("Name", exchangeDraft.Name)
                .Set("NameNormalized", exchangeDraft.NameNormalized)
                .Set("Models", GatewayConfigurationProvisioning.BuildExchangeModels(exchangeDraft.Models))
                .Set("TargetUrl", exchangeDraft.TargetUrl)
                .Set("TargetApiKeyEncrypted", encryptedApiKey)
                .Set("TargetAuthScheme", exchangeDraft.TargetAuthScheme)
                .Set("TransformerType", exchangeDraft.TransformerType)
                .Set("Enabled", true)
                .Set("Description", exchangeDraft.Description)
                .Set("Authority", "llm_gateway")
                .Set("SourceCollection", "llmgw_model_exchanges")
                .Set("UpdatedAt", now)
                .Inc("Version", 1),
            cancellationToken: http.RequestAborted);
    }

    var logicalModelFilter = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Eq("PublicIdNormalized", FalImageLayeringProvisioning.CapabilityId));
    var existingLogicalModel = await gwLogicalModels.Find(logicalModelFilter).FirstOrDefaultAsync(http.RequestAborted);
    var logicalModelId = existingLogicalModel?.GetStringOrEmpty("_id") is { Length: > 0 } existingLogicalModelId
        ? existingLogicalModelId
        : $"gw-logical-{Guid.NewGuid():N}";
    if (existingLogicalModel is null)
    {
        await gwLogicalModels.InsertOneAsync(
            FalImageLayeringProvisioning.BuildLogicalModelDocument(tenantId, logicalModelId, now),
            cancellationToken: http.RequestAborted);
    }
    else
    {
        await gwLogicalModels.UpdateOneAsync(
            logicalModelFilter,
            Builders<BsonDocument>.Update
                .Set("PublicId", FalImageLayeringProvisioning.CapabilityId)
                .Set("PublicIdNormalized", FalImageLayeringProvisioning.CapabilityId)
                .Set("Name", FalImageLayeringProvisioning.LogicalModelName)
                .Set("ModelType", FalImageLayeringProvisioning.RequestType)
                .Set("Capabilities", new BsonArray { "image_generation", "image_layering" })
                .Set("AllowedAppCallerCodes", new BsonArray())
                .Set("RoutingStrategy", "priority")
                .Set("Enabled", true)
                .Set("DisplayOrder", 20)
                .Set("Description", "通用图片分层能力。调用方只依赖公开标识 image-layering，不感知 fal.ai、Endpoint 或凭据。")
                .Set("UpdatedAt", now),
            cancellationToken: http.RequestAborted);
    }

    var offeringFilter = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Eq("LogicalModelId", logicalModelId),
        fb.Eq("TargetKind", "exchange"));
    var existingOffering = await gwModelOfferings.Find(offeringFilter).FirstOrDefaultAsync(http.RequestAborted);
    var offeringId = existingOffering?.GetStringOrEmpty("_id") is { Length: > 0 } existingOfferingId
        ? existingOfferingId
        : $"gw-offering-{Guid.NewGuid():N}";
    if (existingOffering is null)
    {
        await gwModelOfferings.InsertOneAsync(
            FalImageLayeringProvisioning.BuildOfferingDocument(
                tenantId,
                offeringId,
                logicalModelId,
                exchangeId,
                now),
            cancellationToken: http.RequestAborted);
    }
    else
    {
        await gwModelOfferings.UpdateOneAsync(
            offeringFilter,
            Builders<BsonDocument>.Update
                .Set("TargetId", exchangeId)
                .Set("UpstreamModelId", FalImageLayeringProvisioning.ModelId)
                .Set("Protocol", FalImageLayeringProvisioning.TransformerType)
                .Set("Priority", 10)
                .Set("Weight", 100)
                .Set("Enabled", true)
                .Set("Notes", "fal.ai Qwen Image Layered 原生供给")
                .Set("UpdatedAt", now),
            cancellationToken: http.RequestAborted);
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "capability.image_layering.install",
        targetType: "llmgw_capability",
        targetId: FalImageLayeringProvisioning.CapabilityId,
        targetName: "图片分层能力",
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "exchangeId", exchangeId },
            { "logicalModelId", logicalModelId },
            { "offeringId", offeringId },
            { "modelId", FalImageLayeringProvisioning.ModelId },
            { "hasKey", true },
            { "idempotentRepair", existingExchange is not null || existingLogicalModel is not null || existingOffering is not null },
        });

    var status = await BuildImageLayeringCapabilityStatusAsync(
        gwModelExchanges,
        gwLogicalModels,
        gwModelOfferings,
        logs,
        tenantId,
        http.RequestAborted);
    return Json(ApiEnvelope<ImageLayeringCapabilityStatus>.Ok(status), jsonOptions);
}).RequireAuthorization("ConfigWrite");

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
        AllReferencedModelPoolsExist(d, gwPoolIds));
    var activeWithUsableGatewayPool = activeAppCallers.Count(d =>
        AllReferencedModelPoolsExist(d, gwPoolIds)
        && IsAppCallerUsable(d, usableGwPoolIds));
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
        .Where(d => !AllReferencedModelPoolsExist(d, gwPoolIds))
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
        .Where(d => AllReferencedModelPoolsExist(d, gwPoolIds)
            && !IsAppCallerUsable(d, usableGwPoolIds))
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
            .Include("AllowedModelPoolIds")
            .Include("DefaultModelPoolId")
            .Include("AllowCrossPoolFallback")
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
        !AllReferencedModelPoolsExist(d, gwPoolIds));
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
        .SelectMany(GetReferencedModelPoolIds)
        .Where(gwPoolIds.Contains)
        .ToHashSet(StringComparer.Ordinal);
    var activeBoundPools = gwPoolDocs.Where(d => activeBoundPoolIds.Contains(d.GetStringOrEmpty("_id"))).ToList();
    var usablePoolIds = activeBoundPools
        .Where(pool => HasUsablePoolMember(pool, enabledGwPlatformIds, enabledGwModels, enabledGwExchanges))
        .Select(pool => pool.GetStringOrEmpty("_id"))
        .ToHashSet(StringComparer.Ordinal);
    var activeBoundPoolWithoutUsableMember = activeAppCallers.Count(d =>
        AllReferencedModelPoolsExist(d, gwPoolIds)
        && !IsAppCallerUsable(d, usablePoolIds));
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
        "doc/plan.platform.llm-gateway.full-cutover.md stability window",
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

    if (overwrite)
    {
        var sourcePlatforms = await platforms.Find(FilterDefinition<BsonDocument>.Empty).ToListAsync();
        var sourceModels = await models.Find(FilterDefinition<BsonDocument>.Empty).ToListAsync();
        var contractError = await ValidateAsrBulkMutationAsync(
            http,
            sourcePlatforms,
            sourceModels,
            gwPlatforms,
            gwModels,
            gwModelOfferings,
            gwLogicalModels);
        if (contractError is not null)
            return Json(ApiEnvelope<BulkClaimConfigAuthorityResult>.Fail(
                AsrOfferingContractPolicy.ErrorCode,
                contractError), jsonOptions, 409);
    }

    async Task<(int claimed, int skipped)> ClaimCollectionAsync(
        IMongoCollection<BsonDocument> sourceCollection,
        IMongoCollection<BsonDocument> targetCollection,
        string sourceName,
        bool isPool = false)
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
            if (isPool && existing is not null
                && (IsManagedAppendOnlyPool(existing) || await IsCurrentDefaultPoolAsync(gwModelPoolTypes, existing)))
            {
                skipped++;
                continue;
            }
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
            if (isPool) cloned["Version"] = (existing?.AsNullableLong("Version") ?? 0) + 1;
            if (isPool && existing is not null)
            {
                var replaceResult = await targetCollection.ReplaceOneAsync(
                    Builders<BsonDocument>.Filter.And(
                        filter,
                        PoolVersionGuard(Builders<BsonDocument>.Filter, existing),
                        PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, now)),
                    cloned);
                if (replaceResult.ModifiedCount != 1)
                {
                    skipped++;
                    continue;
                }
            }
            else
            {
                await targetCollection.ReplaceOneAsync(filter, cloned, new ReplaceOptions { IsUpsert = true });
            }
            claimed++;
        }
        return (claimed, skipped);
    }

    var poolsResult = await ClaimCollectionAsync(modelGroups, gwModelPools, "model_groups", isPool: true);
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
    await EnsureGatewayModelPoolTypesAsync(
        gwModelPoolTypes, gwModelPools, gwModels, gwPlatforms, models, platforms, internalTenantId, internalTenantId, appendModels: false);
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
    var poolById = gwPoolDocs.ToDictionary(d => d.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var poolTypeDocs = await gwModelPoolTypes.Find(Builders<BsonDocument>.Filter.Eq("TenantId", internalTenantId)).ToListAsync();
    var defaultPoolByType = new Dictionary<string, (string Id, string Name)>(StringComparer.OrdinalIgnoreCase);
    foreach (var type in poolTypeDocs)
    {
        var typeCode = type.GetStringOrEmpty("Code").Trim();
        var poolId = type.GetStringOrEmpty("DefaultPoolId");
        if (typeCode.Length == 0
            || poolId.Length == 0
            || !usableGwPoolIds.Contains(poolId)
            || !poolById.TryGetValue(poolId, out var pool)
            || !string.Equals(pool.GetStringOrEmpty("ModelType"), typeCode, StringComparison.OrdinalIgnoreCase))
            continue;
        defaultPoolByType[typeCode] = (
            poolId,
            pool.AsNullableString("Name") ?? pool.AsNullableString("Code") ?? poolId);
    }

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
        var currentAllowedPoolIds = GetStringArray(appCaller, "AllowedModelPoolIds");
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

            var hasStrictPoolContract = currentAllowedPoolIds.Count > 0
                && string.Equals(appCaller.AsNullableString("DefaultModelPoolId"), currentPoolId, StringComparison.Ordinal);
            if (IsSupportedAppCallerModelPolicy(currentModelPolicy) && hasStrictPoolContract)
            {
                result.Skipped++;
                continue;
            }

            var normalizationUpdates = Builders<BsonDocument>.Update
                .Set("ModelPolicy", IsSupportedAppCallerModelPolicy(currentModelPolicy)
                    ? currentModelPolicy!.Trim().ToLowerInvariant()
                    : "pool")
                .Set("UpdatedAt", now);
            if (!hasStrictPoolContract)
            {
                normalizationUpdates = normalizationUpdates
                    .Set("AllowedModelPoolIds", new BsonArray { currentPoolId })
                    .Set("DefaultModelPoolId", currentPoolId)
                    .Set("AllowCrossPoolFallback", false);
            }
            var policyUpdateResult = await gwAppCallers.UpdateOneAsync(
                TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", appCallerId)),
                normalizationUpdates);
            if (policyUpdateResult.ModifiedCount > 0)
            {
                result.Bound++;
                result.Items.Add(new ConfigAuthorityGapItem
                {
                    ObjectType = "appCaller",
                    Id = appCallerId,
                    Name = appCallerCode,
                    Status = "normalized-to-supported-model-policy",
                    Detail = $"已保留现有 GW 模型池 {currentPoolId}，补齐严格单池契约并默认禁止跨池回退。",
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
            Builders<BsonDocument>.Update.Set("AllowedModelPoolIds", new BsonArray { defaultPool.Id }),
            Builders<BsonDocument>.Update.Set("DefaultModelPoolId", defaultPool.Id),
            Builders<BsonDocument>.Update.Set("AllowCrossPoolFallback", false),
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
    string? modelPoolId,
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
    if (!string.IsNullOrWhiteSpace(modelPoolId))
    {
        var requestedPoolId = modelPoolId.Trim();
        filters.Add(fb.Or(
            fb.Eq("ModelPoolId", requestedPoolId),
            fb.Eq("DefaultModelPoolId", requestedPoolId),
            fb.AnyEq("AllowedModelPoolIds", requestedPoolId)));
    }
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
    var filter = TenantAccess.FilterTeamScope(http, filters.Count > 0 ? fb.And(filters) : fb.Empty);
    var total = await gwAppCallers.CountDocumentsAsync(filter);
    var docs = await gwAppCallers.Find(filter)
        .Sort(Builders<BsonDocument>.Sort.Descending("LastSeenAt").Ascending("AppCallerCode"))
        .Skip((p - 1) * ps)
        .Limit(ps)
        .ToListAsync();

    var recent = TenantAccess.FilterTeamScope(http, fb.Empty);
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

// 外部接入自助创建 appCaller。租户和团队边界只取服务端会话，调用方不能在请求中声明 TenantId。
// 同一 TenantId + AppCallerCode + RequestType 已存在时只允许同团队幂等复用，禁止跨团队抢占身份。
app.MapPost("/gw/app-callers", async (HttpContext http, [FromBody] CreateGatewayAppCallerRequest body) =>
{
    if (body is null)
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);

    var access = TenantAccess.GetRequired(http);
    var appCallerCode = (body.AppCallerCode ?? string.Empty).Trim();
    var requestType = (body.RequestType ?? string.Empty).Trim().ToLowerInvariant();
    var title = (body.Title ?? string.Empty).Trim();
    var ingressProtocol = NormalizeIngressProtocol(body.IngressProtocol ?? string.Empty);
    if (!IsValidSelfServiceAppCaller(appCallerCode, requestType))
    {
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail(
            "INVALID_APP_CALLER",
            "appCallerCode 必须使用小写 {app-key}.{feature}::chat 或 ::vision 格式，且后缀与 requestType 一致"), jsonOptions, 400);
    }
    if (title.Length > 160)
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "title 最多 160 字符"), jsonOptions, 400);
    if (ingressProtocol is not ("gw-native" or "openai-compatible" or "claude-compatible" or "gemini-compatible"))
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INGRESS_PROTOCOL", "不支持的入口协议"), jsonOptions, 400);

    var teamId = string.IsNullOrWhiteSpace(body.TeamId) ? null : body.TeamId.Trim();
    if (teamId is null && access.TeamIds.Count == 1)
        teamId = access.TeamIds[0];
    if (teamId is null)
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("TEAM_SCOPE_REQUIRED", "请选择当前租户中的团队"), jsonOptions, 400);

    var teamExists = await teams.CountDocumentsAsync(x => x.Id == teamId && x.TenantId == access.TenantId && x.Status == "active") == 1;
    if (!teamExists || access.Role == LlmGwTenantRoles.Developer && !access.TeamIds.Contains(teamId, StringComparer.Ordinal))
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("TEAM_SCOPE_DENIED", "不能为该团队创建 appCaller"), jsonOptions, 403);

    var identity = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("AppCallerCode", appCallerCode),
        Builders<BsonDocument>.Filter.Eq("RequestType", requestType));
    var tenantIdentity = TenantAccess.Filter(http, identity);
    var identityOptions = new FindOptions { Collation = new Collation("en", strength: CollationStrength.Secondary) };
    var existing = await gwAppCallers.Find(tenantIdentity, identityOptions).FirstOrDefaultAsync();
    if (existing is not null)
    {
        if (!string.Equals(existing.AsNullableString("TeamId"), teamId, StringComparison.Ordinal))
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("APP_CALLER_IDENTITY_CONFLICT", "该 appCaller 已归属当前租户中的其他团队"), jsonOptions, 409);
        return Json(ApiEnvelope<GatewayAppCallerItem>.Ok(MapGatewayAppCaller(existing)), jsonOptions);
    }

    var now = DateTime.UtcNow;
    var id = Guid.NewGuid().ToString("N");
    var document = new BsonDocument
    {
        { "_id", id },
        { "TenantId", access.TenantId },
        { "TeamId", teamId },
        { "AppCallerCode", appCallerCode },
        { "RequestType", requestType },
        { "SourceSystem", "external" },
        { "IngressProtocol", ingressProtocol },
        { "ObservedIngressProtocols", new BsonArray() },
        { "Title", title.Length == 0 ? appCallerCode : title },
        { "Status", "configured" },
        { "ModelPolicy", "auto" },
        { "ParameterPolicy", "default-drop" },
        { "ObservedModelPoolIds", new BsonArray() },
        { "ObservedModelPolicies", new BsonArray() },
        { "ObservedParameterPolicies", new BsonArray() },
        { "TotalSeen", 0L },
        { "FirstSeenAt", now },
        { "LastSeenAt", now },
        { "CreatedAt", now },
        { "UpdatedAt", now },
    };
    try
    {
        await gwAppCallers.InsertOneAsync(document);
    }
    catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
    {
        var winner = await gwAppCallers.Find(tenantIdentity, identityOptions).FirstOrDefaultAsync();
        if (winner is not null && string.Equals(winner.AsNullableString("TeamId"), teamId, StringComparison.Ordinal))
            return Json(ApiEnvelope<GatewayAppCallerItem>.Ok(MapGatewayAppCaller(winner)), jsonOptions);
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("APP_CALLER_IDENTITY_CONFLICT", "该 appCaller 已被并发创建，请刷新后重试"), jsonOptions, 409);
    }

    try
    {
        await WriteOperationAuditAsync(
            operationAudits,
            http,
            action: "app_caller.create",
            targetType: "llmgw_app_caller",
            targetId: id,
            targetName: appCallerCode,
            success: true,
            reason: null,
            changes: new BsonDocument
            {
                { "teamId", teamId },
                { "requestType", requestType },
                { "ingressProtocol", ingressProtocol },
            },
            throwOnFailure: true);
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning(ex, "创建 appCaller 后写入审计失败，执行补偿删除。TenantId={TenantId}, AppCallerId={AppCallerId}", access.TenantId, id);
        await gwAppCallers.DeleteOneAsync(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)));
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail(
            "APP_CALLER_AUDIT_FAILED",
            "appCaller 审计写入失败，本次创建已撤销，请稍后重试"), jsonOptions, 503);
    }
    return Json(ApiEnvelope<GatewayAppCallerItem>.Ok(MapGatewayAppCaller(document)), jsonOptions, 201);
}).RequireAuthorization("AppCallerWrite");

// GW appCaller 配置：状态、模型池绑定与参数策略落 GW 自有库；active 状态必须绑定可用的 GW 权威池。
// 删除 appCaller 登记。没有结构性引用（日志里的 AppCallerCode 是历史，不该拦删除），
// 但删掉之后这个 code 再来调用会被当成未注册而拒绝——这是预期行为，不是副作用，
// 所以只留审计而不加阻挡，把「删了会怎样」写进确认文案由调用方承担。
app.MapDelete("/gw/app-callers/{id}", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwAppCallers.Find(filter).FirstOrDefaultAsync();
    if (doc is null) return Json(ApiEnvelope<AppCallerDeleteResult>.Fail("NOT_FOUND", $"appCaller 不存在：{id}"), jsonOptions, 404);

    // 提示词策略是这个 appCaller 的从属子项：它只能从 /gw/app-callers/{id}/prompt-policy 建、
    // 没有独立入口，运行时却按 (TenantId, AppCallerCode, RequestType) 选中它——完全不看注册文档。
    // 所以只删注册行的话，策略照样在生效；而 appCaller 是被下一次真实调用被动重建的，
    // 重建之后老提示词就这么回来了，和确认弹窗说的「删掉不会回来」正好相反。跟着一起删。
    var access = TenantAccess.GetRequired(http);
    var appCallerCode = doc.GetStringOrEmpty("AppCallerCode").Trim().ToLowerInvariant();
    var requestType = doc.GetStringOrEmpty("RequestType").Trim().ToLowerInvariant();
    var policiesDeleted = 0L;
    if (appCallerCode.Length > 0)
    {
        var policyFilter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId),
            Builders<BsonDocument>.Filter.Eq("AppCallerCode", appCallerCode),
            Builders<BsonDocument>.Filter.Eq("RequestType", requestType));
        policiesDeleted = (await promptPolicies.DeleteManyAsync(policyFilter)).DeletedCount;
    }

    await gwAppCallers.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(
        operationAudits, http,
        action: "app_caller.delete", targetType: "llmgw_app_caller", targetId: id,
        targetName: doc.AsNullableString("Code") ?? doc.AsNullableString("AppCallerCode"), success: true, reason: null,
        changes: new BsonDocument
        {
            { "code", ToBsonAuditValue(doc.AsNullableString("Code") ?? doc.AsNullableString("AppCallerCode")) },
            { "title", ToBsonAuditValue(doc.AsNullableString("Title")) },
            { "modelPoolId", ToBsonAuditValue(doc.AsNullableString("ModelPoolId")) },
            // 连带删了几版提示词策略要留痕：删的是治理配置，事后要能核对删掉了什么
            { "promptPolicyVersionsDeleted", policiesDeleted },
        });
    return Json(
        ApiEnvelope<AppCallerDeleteResult>.Ok(new AppCallerDeleteResult { PromptPolicyVersionsDeleted = (int)policiesDeleted }),
        jsonOptions);
}).RequireAuthorization("AppCallerWrite");

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
    var effectiveAllowedModelPoolIds = GetStringArray(doc, "AllowedModelPoolIds");
    var effectiveDefaultModelPoolId = doc.AsNullableString("DefaultModelPoolId");
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
            var pool = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
            if (pool is null)
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", $"模型池不存在或尚未认领到 LLMGW：{modelPoolId}"), jsonOptions, 400);
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

    if (body.AllowedModelPoolIds is not null)
    {
        var allowedModelPoolIds = body.AllowedModelPoolIds
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (allowedModelPoolIds.Count > 20)
        {
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "单个 appCaller 最多允许 20 个模型池"), jsonOptions, 400);
        }

        foreach (var allowedPoolId in allowedModelPoolIds)
        {
            var poolFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", allowedPoolId));
            var pool = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
            if (pool is null)
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", $"模型池不存在或尚未认领到 LLMGW：{allowedPoolId}"), jsonOptions, 400);
            }
            var poolType = pool.GetStringOrEmpty("ModelType");
            var requestType = doc.GetStringOrEmpty("RequestType");
            if (!string.IsNullOrWhiteSpace(poolType)
                && !string.IsNullOrWhiteSpace(requestType)
                && !string.Equals(poolType, requestType, StringComparison.OrdinalIgnoreCase))
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", $"模型池类型 {poolType} 与调用类型 {requestType} 不一致"), jsonOptions, 400);
            }
        }

        updates.Add(Builders<BsonDocument>.Update.Set("AllowedModelPoolIds", new BsonArray(allowedModelPoolIds)));
        AddChange("allowedModelPoolIds", effectiveAllowedModelPoolIds, allowedModelPoolIds);
        effectiveAllowedModelPoolIds = allowedModelPoolIds;
    }

    if (body.DefaultModelPoolId is not null)
    {
        var defaultModelPoolId = body.DefaultModelPoolId.Trim();
        if (defaultModelPoolId.Length == 0)
        {
            updates.Add(Builders<BsonDocument>.Update.Unset("DefaultModelPoolId"));
            if (effectiveAllowedModelPoolIds.Count == 0)
            {
                updates.Add(Builders<BsonDocument>.Update.Unset("ModelPoolId"));
                AddChange("modelPoolId", effectiveModelPoolId, null);
                effectiveModelPoolId = null;
            }
            AddChange("defaultModelPoolId", effectiveDefaultModelPoolId, null);
            effectiveDefaultModelPoolId = null;
        }
        else
        {
            if (!effectiveAllowedModelPoolIds.Contains(defaultModelPoolId, StringComparer.Ordinal))
            {
                return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "默认模型池必须属于允许模型池集合"), jsonOptions, 400);
            }
            updates.Add(Builders<BsonDocument>.Update.Set("DefaultModelPoolId", defaultModelPoolId));
            updates.Add(Builders<BsonDocument>.Update.Set("ModelPoolId", defaultModelPoolId));
            AddChange("defaultModelPoolId", effectiveDefaultModelPoolId, defaultModelPoolId);
            AddChange("modelPoolId", effectiveModelPoolId, defaultModelPoolId);
            effectiveDefaultModelPoolId = defaultModelPoolId;
            effectiveModelPoolId = defaultModelPoolId;
        }
    }

    if (body.AllowCrossPoolFallback is not null)
    {
        updates.Add(Builders<BsonDocument>.Update.Set("AllowCrossPoolFallback", body.AllowCrossPoolFallback.Value));
        AddChange("allowCrossPoolFallback", doc.AsNullableBool("AllowCrossPoolFallback") ?? false, body.AllowCrossPoolFallback.Value);
    }

    if (effectiveAllowedModelPoolIds.Count > 0
        && (string.IsNullOrWhiteSpace(effectiveDefaultModelPoolId)
            || !effectiveAllowedModelPoolIds.Contains(effectiveDefaultModelPoolId, StringComparer.Ordinal)))
    {
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("INVALID_INPUT", "配置允许模型池集合时必须指定集合内的默认模型池"), jsonOptions, 400);
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
        doc.GetStringOrEmpty("RequestType"),
        effectiveAllowedModelPoolIds,
        effectiveDefaultModelPoolId);
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
    AddExactFilter("ModelPoolId", body.ModelPoolId);
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
    await serviceKeys.UpdateManyAsync(
        TenantAccess.FilterTeamScope(http, ownScope
            & Builders<BsonDocument>.Filter.Eq("IssuanceState", "delivering")
            & Builders<BsonDocument>.Filter.Lte("UpdatedAt", DateTime.UtcNow.AddSeconds(-30))),
        Builders<BsonDocument>.Update
            .Set("IssuanceState", "issued")
            .Set("UpdatedAt", DateTime.UtcNow));
    var issuanceScope = Builders<BsonDocument>.Filter.Or(
        Builders<BsonDocument>.Filter.Exists("IssuanceState", false),
        Builders<BsonDocument>.Filter.Eq("IssuanceState", "issued"));
    var docs = await serviceKeys.Find(TenantAccess.FilterTeamScope(http, ownScope & issuanceScope))
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
        ClientCode = d.AsNullableString("ClientCode") ?? d.AsNullableString("SourceSystem") ?? "历史未标注",
        Environment = d.AsNullableString("Environment") ?? "unknown",
        Purpose = d.AsNullableString("Purpose") ?? (string.Equals(d.AsNullableString("SourceSystem"), "map", StringComparison.OrdinalIgnoreCase) ? "runtime" : "external-platform"),
        AppCallerCodes = d.AsStringList("AppCallerCodes"),
        IngressProtocols = d.AsStringList("IngressProtocols"),
        Scopes = d.AsStringList("Scopes"),
        AllowedCidrs = d.AsStringList("AllowedCidrs"),
        RateLimitPerMinute = d.AsNullableInt("RateLimitPerMinute"),
        ExpiresAt = d.AsNullableUtcDateTime("ExpiresAt").ToIso(),
        LastUsedAt = d.AsNullableUtcDateTime("LastUsedAt").ToIso(),
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        RotatesKeyId = d.AsNullableString("RotatesKeyId"),
        RotatedByKeyId = d.AsNullableString("RotatedByKeyId"),
        RotationState = d.AsNullableString("RotationState") ?? (d.AsNullableBool("Enabled") == false ? "revoked" : "active"),
    }).ToList();
    return Json(ApiEnvelope<List<ServiceKeyItem>>.Ok(items), jsonOptions);
}).RequireAuthorization("ServiceKeyWrite");

app.MapPost("/gw/service-keys", async (HttpContext http, ServiceKeyCreateRequest body) =>
{
    var tenant = TenantAccess.GetRequired(http);
    var name = (body.Name ?? string.Empty).Trim();
    var sourceSystem = (body.SourceSystem ?? "external").Trim();
    var clientCode = (body.ClientCode ?? string.Empty).Trim().ToLowerInvariant();
    var environment = (body.Environment ?? string.Empty).Trim().ToLowerInvariant();
    var purpose = (body.Purpose ?? (string.Equals(sourceSystem, "map", StringComparison.OrdinalIgnoreCase) ? "runtime" : "external-platform")).Trim().ToLowerInvariant();
    var appCallerCodes = NormalizeDistinct(body.AppCallerCodes ?? [], 200);
    var protocols = NormalizeDistinct(body.IngressProtocols ?? [], 20);
    var scopes = NormalizeDistinct(body.Scopes ?? [], 20);
    var allowedCidrs = NormalizeDistinct(body.AllowedCidrs ?? [], 50);
    if (name.Length == 0 || sourceSystem.Length == 0 || clientCode.Length == 0 || environment.Length == 0
        || appCallerCodes.Count == 0 || protocols.Count == 0 || scopes.Count == 0)
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_SERVICE_KEY_SCOPE", "name、sourceSystem、clientCode、environment、appCallerCodes、ingressProtocols、scopes 均为必填"), jsonOptions, 400);
    }
    if (!System.Text.RegularExpressions.Regex.IsMatch(clientCode, "^[a-z][a-z0-9._-]{1,79}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant))
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_CLIENT_CODE", "clientCode 必须以小写字母开头，只能包含小写字母、数字、点、下划线和短横线，长度 2 至 80"), jsonOptions, 400);
    }
    var allowedEnvironments = new HashSet<string>(StringComparer.Ordinal)
    {
        "development", "test", "staging", "production",
    };
    if (!allowedEnvironments.Contains(environment))
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_KEY_ENVIRONMENT", "environment 仅支持 development、test、staging、production"), jsonOptions, 400);
    }
    var allowedPurposes = new HashSet<string>(StringComparer.Ordinal)
    {
        "runtime", "release-gate", "canary", "external-platform",
    };
    if (!allowedPurposes.Contains(purpose))
    {
        return Json(ApiEnvelope<object>.Fail("INVALID_KEY_PURPOSE", "purpose 仅支持 runtime、release-gate、canary、external-platform"), jsonOptions, 400);
    }
    if (sourceSystem == "*")
    {
        return Json(ApiEnvelope<object>.Fail(
            "INVALID_KEY_SOURCE",
            "sourceSystem 必须是明确来源，不能使用通配符"), jsonOptions, 400);
    }
    var isMapSource = string.Equals(sourceSystem, "map", StringComparison.OrdinalIgnoreCase);
    if (!tenant.IsInternalTenant && (isMapSource || purpose != "external-platform"))
    {
        return Json(ApiEnvelope<object>.Fail(
            "INTERNAL_KEY_PURPOSE_FORBIDDEN",
            "外部租户只能创建 external-platform key；MAP runtime、release-gate 与 canary 仅属于 internal tenant"), jsonOptions, 403);
    }
    if (isMapSource && purpose == "external-platform"
        || !isMapSource && purpose != "external-platform")
    {
        return Json(ApiEnvelope<object>.Fail("KEY_PURPOSE_SOURCE_MISMATCH", "MAP key 使用 runtime、release-gate 或 canary；外部平台 key 使用 external-platform"), jsonOptions, 400);
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

    var usesWildcard = sourceSystem == "*"
        || appCallerCodes.Contains("*", StringComparer.Ordinal)
        || protocols.Contains("*", StringComparer.Ordinal)
        || scopes.Contains("*", StringComparer.Ordinal);
    if (tenant.Role == LlmGwTenantRoles.Developer && usesWildcard)
    {
        return Json(ApiEnvelope<object>.Fail(
            "WILDCARD_SCOPE_DENIED",
            "Developer 只能创建绑定具体来源、appCaller、协议和 scope 的 service key"), jsonOptions, 403);
    }
    if (usesWildcard
        && tenant.Role is LlmGwTenantRoles.Owner or LlmGwTenantRoles.Admin
        && !body.ConfirmWildcardRisk)
    {
        return Json(ApiEnvelope<object>.Fail(
            "WILDCARD_CONFIRMATION_REQUIRED",
            "通配密钥可访问更大范围，必须显式确认高风险后才能创建"), jsonOptions, 409);
    }
    if (tenant.Role == LlmGwTenantRoles.Developer && teamId is null)
    {
        return Json(ApiEnvelope<object>.Fail(
            "TEAM_SCOPE_REQUIRED",
            "Developer 创建 service key 时必须绑定所属团队"), jsonOptions, 403);
    }
    if (teamId is not null && appCallerCodes.Contains("*", StringComparer.Ordinal))
    {
        return Json(ApiEnvelope<object>.Fail(
            "TEAM_WILDCARD_DENIED",
            "团队 service key 不能使用通配 appCaller"), jsonOptions, 400);
    }
    if (teamId is not null)
    {
        var callerCandidates = await gwAppCallers.Find(TenantAccess.Filter(http))
            .Project(Builders<BsonDocument>.Projection.Include("AppCallerCode").Include("TeamId"))
            .ToListAsync();
        foreach (var appCallerCode in appCallerCodes)
        {
            var matches = callerCandidates
                .Where(x => string.Equals(
                    x.AsNullableString("AppCallerCode")?.Trim(),
                    appCallerCode.Trim(),
                    StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (matches.Count > 0
                && matches.Any(x => !string.Equals(x.AsNullableString("TeamId"), teamId, StringComparison.Ordinal)))
            {
                return Json(ApiEnvelope<object>.Fail(
                    "APP_CALLER_TEAM_MISMATCH",
                    $"appCaller {appCallerCode} 不属于所选团队"), jsonOptions, 403);
            }
        }
    }

    BsonDocument? rotatedKey = null;
    string? predecessorRotationState = null;
    if (!string.IsNullOrWhiteSpace(body.RotatesKeyId))
    {
        var rotationFilter = Builders<BsonDocument>.Filter.Eq("_id", body.RotatesKeyId.Trim());
        if (tenant.Role == LlmGwTenantRoles.Developer)
            rotationFilter &= Builders<BsonDocument>.Filter.Eq("CreatedByUserId", tenant.UserId);
        rotatedKey = await serviceKeys.Find(TenantAccess.FilterTeamScope(http, rotationFilter)).FirstOrDefaultAsync();
        if (rotatedKey is null)
            return Json(ApiEnvelope<object>.Fail("ROTATION_SOURCE_NOT_FOUND", "待轮换密钥不存在或不在当前管理范围"), jsonOptions, 404);
        if (rotatedKey.AsNullableBool("Enabled") != true)
            return Json(ApiEnvelope<object>.Fail("ROTATION_SOURCE_REVOKED", "已撤销密钥不能发起轮换"), jsonOptions, 409);
        if (!string.IsNullOrWhiteSpace(rotatedKey.AsNullableString("RotatedByKeyId")))
            return Json(ApiEnvelope<object>.Fail("ROTATION_ALREADY_ACTIVE", "该密钥已有未完成轮换"), jsonOptions, 409);
        predecessorRotationState = rotatedKey.AsNullableString("RotationState");
        if (!string.IsNullOrWhiteSpace(predecessorRotationState)
            && !string.Equals(predecessorRotationState, "active", StringComparison.Ordinal)
            && !string.Equals(predecessorRotationState, "completed", StringComparison.Ordinal))
        {
            return Json(ApiEnvelope<object>.Fail(
                "ROTATION_SOURCE_STAGE_INVALID",
                "上一轮密钥轮换尚未完成，不能再次发起轮换"), jsonOptions, 409);
        }
        if (string.IsNullOrWhiteSpace(predecessorRotationState))
        {
            predecessorRotationState = !string.IsNullOrWhiteSpace(rotatedKey.AsNullableString("RotatesKeyId"))
                ? "completed"
                : "active";
        }
        var rotatedClientCode = rotatedKey.AsNullableString("ClientCode");
        var legacySourceClientCode = rotatedKey.AsNullableString("SourceSystem");
        var expectedClientCode = !string.IsNullOrWhiteSpace(rotatedClientCode)
            ? rotatedClientCode
            : !string.IsNullOrWhiteSpace(legacySourceClientCode)
              && System.Text.RegularExpressions.Regex.IsMatch(legacySourceClientCode, "^[a-z][a-z0-9._-]{1,79}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant)
                ? legacySourceClientCode
                : null;
        var rotatedEnvironment = rotatedKey.AsNullableString("Environment");
        var rotatedPurpose = rotatedKey.AsNullableString("Purpose")
            ?? (string.Equals(rotatedKey.AsNullableString("SourceSystem"), "map", StringComparison.OrdinalIgnoreCase) ? "runtime" : "external-platform");
        // 历史 key 可能没有 ClientCode，且 SourceSystem 允许使用 "*"。当旧来源不能作为合法
        // clientCode 时，轮换承担一次性身份升级；否则仍要求沿用可验证的历史身份。
        if ((expectedClientCode is not null && !string.Equals(expectedClientCode, clientCode, StringComparison.OrdinalIgnoreCase))
            || (rotatedEnvironment is not null && !string.Equals(rotatedEnvironment, environment, StringComparison.OrdinalIgnoreCase))
            || !string.Equals(rotatedPurpose, purpose, StringComparison.OrdinalIgnoreCase))
        {
            return Json(ApiEnvelope<object>.Fail("ROTATION_IDENTITY_MISMATCH", "轮换不能修改 clientCode、environment 或 purpose"), jsonOptions, 409);
        }
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
        { "Enabled", false },
        { "SourceSystem", sourceSystem },
        { "ClientCode", clientCode },
        { "Environment", environment },
        { "Purpose", purpose },
        { "AppCallerCodes", new BsonArray(appCallerCodes) },
        { "IngressProtocols", new BsonArray(protocols) },
        { "Scopes", new BsonArray(scopes) },
        { "AllowedCidrs", new BsonArray(allowedCidrs) },
        { "RateLimitPerMinute", body.RateLimitPerMinute is null ? BsonNull.Value : body.RateLimitPerMinute.Value },
        { "RotatesKeyId", rotatedKey is null ? BsonNull.Value : rotatedKey.GetStringOrEmpty("_id") },
        { "PredecessorRotationState", predecessorRotationState is null ? BsonNull.Value : predecessorRotationState },
        { "RotatedByKeyId", BsonNull.Value },
        { "RotationState", rotatedKey is null ? "issuance-pending" : "rotation-initializing" },
        { "IssuanceState", "creating" },
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
    BsonDocument? stableSuccessor = null;
    if (rotatedKey is not null)
    {
        var sourceId = rotatedKey.GetStringOrEmpty("_id");
        var rotationUpdate = await serviceKeys.UpdateOneAsync(
            TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", sourceId),
                Builders<BsonDocument>.Filter.Eq("Enabled", true),
                Builders<BsonDocument>.Filter.Or(
                    Builders<BsonDocument>.Filter.Exists("RotatedByKeyId", false),
                    Builders<BsonDocument>.Filter.Eq("RotatedByKeyId", BsonNull.Value)),
                Builders<BsonDocument>.Filter.Or(
                    Builders<BsonDocument>.Filter.Exists("RotationState", false),
                    Builders<BsonDocument>.Filter.Eq("RotationState", BsonNull.Value),
                    Builders<BsonDocument>.Filter.Eq("RotationState", "active"),
                    Builders<BsonDocument>.Filter.Eq("RotationState", "completed")))),
            Builders<BsonDocument>.Update
                .Set("RotatedByKeyId", id)
                .Set("RotationState", "awaiting-client-cutover")
                .Set("ClientCode", clientCode)
                .Set("Environment", environment)
                .Set("UpdatedAt", now));
        if (rotationUpdate.ModifiedCount != 1)
        {
            await serviceKeyDirectory.DeleteOneAsync(Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
                Builders<BsonDocument>.Filter.Eq("ServiceKeyId", id)));
            await serviceKeys.DeleteOneAsync(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)));
            return Json(ApiEnvelope<object>.Fail("ROTATION_CONFLICT", "轮换状态已变化，请刷新后重试"), jsonOptions, 409);
        }
        stableSuccessor = await serviceKeys.Find(TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", id),
                Builders<BsonDocument>.Filter.Eq("RotatesKeyId", sourceId),
                Builders<BsonDocument>.Filter.Eq("Enabled", false),
                Builders<BsonDocument>.Filter.Eq("IssuanceState", "creating"),
                Builders<BsonDocument>.Filter.Eq("RotationState", "rotation-initializing"))))
            .FirstOrDefaultAsync();
        if (stableSuccessor is null)
        {
            await serviceKeys.UpdateOneAsync(
                TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("_id", sourceId),
                    Builders<BsonDocument>.Filter.Eq("Enabled", true),
                    Builders<BsonDocument>.Filter.Eq("RotatedByKeyId", id),
                    Builders<BsonDocument>.Filter.Eq("RotationState", "awaiting-client-cutover"))),
                Builders<BsonDocument>.Update
                    .Set("RotatedByKeyId", BsonNull.Value)
                    .Set("RotationState", predecessorRotationState ?? "active")
                    .Set("UpdatedAt", DateTime.UtcNow));
            await serviceKeyDirectory.DeleteOneAsync(Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
                Builders<BsonDocument>.Filter.Eq("ServiceKeyId", id)));
            await serviceKeys.UpdateOneAsync(
                TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)),
                Builders<BsonDocument>.Update
                    .Set("Enabled", false)
                    .Set("RotationState", "revoked")
                    .Set("UpdatedAt", DateTime.UtcNow));
            return Json(ApiEnvelope<object>.Fail("ROTATION_CONFLICT", "轮换新密钥已被并发撤销，请刷新后重试"), jsonOptions, 409);
        }
    }
    var pendingRotationState = rotatedKey is null ? "issuance-pending" : "rotation-initializing";
    var publishedRotationState = rotatedKey is null ? "active" : "new-key-created";
    var issuanceLogger = http.RequestServices.GetService<ILoggerFactory>()?.CreateLogger("ServiceKeyIssuance");
    async Task RollbackIssuanceAsync()
    {
        if (rotatedKey is not null)
        {
            await serviceKeys.UpdateOneAsync(
                TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("_id", rotatedKey.GetStringOrEmpty("_id")),
                    Builders<BsonDocument>.Filter.Eq("Enabled", true),
                    Builders<BsonDocument>.Filter.Eq("RotatedByKeyId", id),
                    Builders<BsonDocument>.Filter.Eq("RotationState", "awaiting-client-cutover"))),
                Builders<BsonDocument>.Update
                    .Set("RotatedByKeyId", BsonNull.Value)
                    .Set("RotationState", predecessorRotationState ?? "active")
                    .Set("UpdatedAt", DateTime.UtcNow));
        }
        await serviceKeyDirectory.DeleteOneAsync(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
            Builders<BsonDocument>.Filter.Eq("ServiceKeyId", id)));
        await serviceKeys.UpdateOneAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)),
            Builders<BsonDocument>.Update
                .Set("Enabled", false)
                .Set("IssuanceState", "failed")
                .Set("RotationState", "revoked")
                .Set("UpdatedAt", DateTime.UtcNow));
    }
    var deliveryReady = await serviceKeys.UpdateOneAsync(
        Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", id),
            Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
            Builders<BsonDocument>.Filter.Eq("Enabled", false),
            Builders<BsonDocument>.Filter.Eq("IssuanceState", "creating"),
            Builders<BsonDocument>.Filter.Eq("RotationState", pendingRotationState)),
        Builders<BsonDocument>.Update
            .Set("Enabled", true)
            .Set("IssuanceState", "delivering")
            .Set("RotationState", publishedRotationState)
            .Set("UpdatedAt", DateTime.UtcNow));
    if (deliveryReady.ModifiedCount != 1)
    {
        await RollbackIssuanceAsync();
        return Json(ApiEnvelope<object>.Fail(
            "SERVICE_KEY_ISSUANCE_CONFLICT",
            "密钥签发状态已变化，请刷新后重试"), jsonOptions, 409);
    }
    try
    {
        await WriteOperationAuditAsync(
            operationAudits,
            http,
            usesWildcard ? "service_key.create_wildcard" : "service_key.create",
            "llmgw_service_key",
            id,
            name,
            true,
            null,
            new BsonDocument
            {
                { "sourceSystem", sourceSystem },
                { "clientCode", clientCode },
                { "environment", environment },
                { "purpose", purpose },
                { "appCallerCount", appCallerCodes.Count },
                { "protocolCount", protocols.Count },
                { "scopeCount", scopes.Count },
                { "teamId", teamId is null ? BsonNull.Value : teamId },
                { "allowedCidrCount", allowedCidrs.Count },
                { "rateLimitPerMinute", body.RateLimitPerMinute is null ? BsonNull.Value : body.RateLimitPerMinute.Value },
                { "rotatesKeyId", rotatedKey is null ? BsonNull.Value : rotatedKey.GetStringOrEmpty("_id") },
                { "usesWildcard", usesWildcard },
            },
            throwOnFailure: true);
    }
    catch (Exception ex)
    {
        issuanceLogger?.LogError(
            ex,
            "service key 创建审计失败，回滚签发。TenantId={TenantId} ServiceKeyId={ServiceKeyId}",
            tenant.TenantId,
            id);
        await RollbackIssuanceAsync();
        return Json(ApiEnvelope<object>.Fail(
            "SERVICE_KEY_AUDIT_FAILED",
            "密钥创建审计失败，本次签发已回滚"), jsonOptions, 503);
    }
    http.Response.OnCompleted(async () =>
    {
        Exception? lastError = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                var published = await serviceKeys.UpdateOneAsync(
                    Builders<BsonDocument>.Filter.And(
                        Builders<BsonDocument>.Filter.Eq("_id", id),
                        Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
                        Builders<BsonDocument>.Filter.Eq("Enabled", true),
                        Builders<BsonDocument>.Filter.Eq("IssuanceState", "delivering"),
                        Builders<BsonDocument>.Filter.Eq("RotationState", publishedRotationState)),
                    Builders<BsonDocument>.Update
                        .Set("IssuanceState", "issued")
                        .Set("UpdatedAt", DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
                if (published.ModifiedCount == 1)
                    return;
                var current = await serviceKeys.Find(Builders<BsonDocument>.Filter.And(
                        Builders<BsonDocument>.Filter.Eq("_id", id),
                        Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId)))
                    .Project(Builders<BsonDocument>.Projection.Include("IssuanceState"))
                    .FirstOrDefaultAsync(CancellationToken.None);
                if (string.Equals(current?.AsNullableString("IssuanceState"), "issued", StringComparison.Ordinal))
                    return;
            }
            catch (Exception ex)
            {
                lastError = ex;
            }
            if (attempt < 3)
                await Task.Delay(attempt * 100, CancellationToken.None);
        }
        issuanceLogger?.LogError(
            lastError,
            "service key 响应完成后三次尝试仍未收口签发状态，将由租户列表自愈。TenantId={TenantId} ServiceKeyId={ServiceKeyId}",
            tenant.TenantId,
            id);
    });
    return Json(ApiEnvelope<object>.Ok(new
    {
        id,
        name,
        keyPrefix,
        key = plainKey,
        warning = "该 key 只显示一次；数据库未保存明文",
        sourceSystem,
        clientCode,
        environment,
        purpose,
        appCallerCodes,
        ingressProtocols = protocols,
        scopes,
        teamId,
        allowedCidrs,
        rateLimitPerMinute = body.RateLimitPerMinute,
        rotatesKeyId = rotatedKey?.GetStringOrEmpty("_id"),
        expiresAt,
        rotationState = publishedRotationState,
    }), jsonOptions, 201);
}).RequireAuthorization("ServiceKeyWrite");

app.MapPost("/gw/service-keys/{id}/rotation/client-cutover", async (HttpContext http, string id) =>
{
    var access = TenantAccess.GetRequired(http);
    var scopeFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    if (access.Role == LlmGwTenantRoles.Developer)
        scopeFilter &= Builders<BsonDocument>.Filter.Eq("CreatedByUserId", access.UserId);
    var keyFilter = TenantAccess.FilterTeamScope(http, scopeFilter);
    var existing = await serviceKeys.Find(keyFilter).FirstOrDefaultAsync();
    if (existing is null)
        return Json(ApiEnvelope<object>.Fail("SERVICE_KEY_NOT_FOUND", "service key 不存在"), jsonOptions, 404);
    var successorId = existing.AsNullableString("RotatedByKeyId");
    if (!string.Equals(existing.AsNullableString("RotationState"), "awaiting-client-cutover", StringComparison.Ordinal)
        || string.IsNullOrWhiteSpace(successorId))
    {
        return Json(ApiEnvelope<object>.Fail("ROTATION_STAGE_INVALID", "当前密钥不处于等待客户端切换阶段"), jsonOptions, 409);
    }
    var successorIdentityFilter = TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("_id", successorId),
        Builders<BsonDocument>.Filter.Eq("RotatesKeyId", id),
        Builders<BsonDocument>.Filter.Eq("Enabled", true),
        Builders<BsonDocument>.Filter.Eq("IssuanceState", "issued")));
    var successor = await serviceKeys.Find(successorIdentityFilter).FirstOrDefaultAsync();
    if (successor is null)
        return Json(ApiEnvelope<object>.Fail("ROTATION_SUCCESSOR_INVALID", "轮换新密钥不存在或已撤销"), jsonOptions, 409);

    var now = DateTime.UtcNow;
    var successorState = successor.AsNullableString("RotationState");
    if (string.Equals(successorState, "new-key-created", StringComparison.Ordinal))
    {
        var successorCutover = await serviceKeys.UpdateOneAsync(
            successorIdentityFilter & Builders<BsonDocument>.Filter.Eq("RotationState", "new-key-created"),
            Builders<BsonDocument>.Update
                .Set("RotationState", "client-switched")
                .Set("UpdatedAt", now));
        if (successorCutover.ModifiedCount != 1)
        {
            return Json(ApiEnvelope<object>.Fail(
                "ROTATION_CONFLICT",
                "轮换状态已变化，请刷新后重试"), jsonOptions, 409);
        }
    }
    else if (!string.Equals(successorState, "client-switched", StringComparison.Ordinal))
    {
        return Json(ApiEnvelope<object>.Fail(
            "ROTATION_SUCCESSOR_STAGE_INVALID",
            "轮换新密钥状态无效，请刷新后重试"), jsonOptions, 409);
    }

    var sourceCutover = await serviceKeys.UpdateOneAsync(
        keyFilter
        & Builders<BsonDocument>.Filter.Eq("Enabled", true)
        & Builders<BsonDocument>.Filter.Eq("RotatedByKeyId", successorId)
        & Builders<BsonDocument>.Filter.Eq("RotationState", "awaiting-client-cutover"),
        Builders<BsonDocument>.Update
        .Set("RotationState", "client-switched")
        .Set("UpdatedAt", now));
    if (sourceCutover.ModifiedCount != 1)
    {
        var currentSource = await serviceKeys.Find(keyFilter).FirstOrDefaultAsync();
        if (currentSource is null
            || !string.Equals(currentSource.AsNullableString("RotatedByKeyId"), successorId, StringComparison.Ordinal)
            || !string.Equals(currentSource.AsNullableString("RotationState"), "client-switched", StringComparison.Ordinal))
        {
            return Json(ApiEnvelope<object>.Fail(
                "ROTATION_CONFLICT",
                "轮换状态已变化，请刷新后重试"), jsonOptions, 409);
        }
    }
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        "service_key.rotation_client_cutover",
        "llmgw_service_key",
        id,
        existing.AsNullableString("Name"),
        true,
        null,
        new BsonDocument { { "successorKeyId", successorId } });
    return Json(ApiEnvelope<object>.Ok(new { id, successorKeyId = successorId, rotationState = "client-switched" }), jsonOptions);
}).RequireAuthorization("ServiceKeyWrite");

app.MapDelete("/gw/service-keys/{id}", async (HttpContext http, string id) =>
{
    var access = TenantAccess.GetRequired(http);
    var scopeFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    if (access.Role == LlmGwTenantRoles.Developer)
        scopeFilter &= Builders<BsonDocument>.Filter.Eq("CreatedByUserId", access.UserId);
    var keyFilter = TenantAccess.FilterTeamScope(http, scopeFilter);
    var existing = await serviceKeys.Find(keyFilter).FirstOrDefaultAsync();
    if (existing is null)
        return Json(ApiEnvelope<object>.Fail("SERVICE_KEY_NOT_FOUND", "service key 不存在"), jsonOptions, 404);
    var issuanceState = existing.AsNullableString("IssuanceState");
    if (!string.IsNullOrWhiteSpace(issuanceState)
        && !string.Equals(issuanceState, "issued", StringComparison.Ordinal))
    {
        return Json(ApiEnvelope<object>.Fail(
            "SERVICE_KEY_ISSUANCE_PENDING",
            "密钥仍在签发中，不能撤销"), jsonOptions, 409);
    }
    var successorId = existing.AsNullableString("RotatedByKeyId");
    var predecessorId = existing.AsNullableString("RotatesKeyId");
    var rotationState = existing.AsNullableString("RotationState") ?? "active";
    if (!string.IsNullOrWhiteSpace(successorId)
        && !string.Equals(rotationState, "client-switched", StringComparison.Ordinal))
    {
        return Json(ApiEnvelope<object>.Fail("ROTATION_CLIENT_SWITCH_REQUIRED", "请先确认客户端已切换到新密钥，再撤销旧密钥"), jsonOptions, 409);
    }
    if (string.IsNullOrWhiteSpace(successorId)
        && !string.IsNullOrWhiteSpace(predecessorId)
        && string.Equals(rotationState, "client-switched", StringComparison.Ordinal))
    {
        return Json(ApiEnvelope<object>.Fail("ROTATION_OLD_KEY_REVOKE_REQUIRED", "客户端已切换后必须撤销旧密钥完成轮换，不能撤销新密钥"), jsonOptions, 409);
    }

    var now = DateTime.UtcNow;
    if (string.IsNullOrWhiteSpace(successorId)
        && !string.IsNullOrWhiteSpace(predecessorId)
        && string.Equals(rotationState, "new-key-created", StringComparison.Ordinal))
    {
        var abortClaim = await serviceKeys.UpdateOneAsync(
            keyFilter
            & Builders<BsonDocument>.Filter.Eq("Enabled", true)
            & Builders<BsonDocument>.Filter.Eq("IssuanceState", "issued")
            & Builders<BsonDocument>.Filter.Eq("RotatesKeyId", predecessorId)
            & Builders<BsonDocument>.Filter.Eq("RotationState", "new-key-created"),
            Builders<BsonDocument>.Update
                .Set("RotationState", "abort-in-progress")
                .Set("UpdatedAt", now));
        if (abortClaim.ModifiedCount != 1)
        {
            return Json(ApiEnvelope<object>.Fail(
                "ROTATION_CONFLICT",
                "轮换状态已变化，请刷新后重试"), jsonOptions, 409);
        }

        var restoreState = existing.AsNullableString("PredecessorRotationState");
        if (!string.Equals(restoreState, "active", StringComparison.Ordinal)
            && !string.Equals(restoreState, "completed", StringComparison.Ordinal))
        {
            var predecessor = await serviceKeys.Find(TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("_id", predecessorId),
                    Builders<BsonDocument>.Filter.Eq("RotatedByKeyId", id),
                    Builders<BsonDocument>.Filter.Eq("Enabled", true))))
                .FirstOrDefaultAsync();
            restoreState = !string.IsNullOrWhiteSpace(predecessor?.AsNullableString("RotatesKeyId"))
                ? "completed"
                : "active";
        }
        var predecessorRestore = await serviceKeys.UpdateOneAsync(
            TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", predecessorId),
                Builders<BsonDocument>.Filter.Eq("RotatedByKeyId", id),
                Builders<BsonDocument>.Filter.Eq("Enabled", true),
                Builders<BsonDocument>.Filter.Eq("RotationState", "awaiting-client-cutover"))),
            Builders<BsonDocument>.Update
                .Set("RotatedByKeyId", BsonNull.Value)
                .Set("RotationState", restoreState)
                .Set("UpdatedAt", now));
        if (predecessorRestore.ModifiedCount != 1)
        {
            await serviceKeys.UpdateOneAsync(
                keyFilter & Builders<BsonDocument>.Filter.Eq("RotationState", "abort-in-progress"),
                Builders<BsonDocument>.Update
                    .Set("RotationState", "new-key-created")
                    .Set("UpdatedAt", DateTime.UtcNow));
            return Json(ApiEnvelope<object>.Fail(
                "ROTATION_CONFLICT",
                "轮换状态已变化，请刷新后重试"), jsonOptions, 409);
        }

        var successorRevoke = await serviceKeys.UpdateOneAsync(
            keyFilter
            & Builders<BsonDocument>.Filter.Eq("Enabled", true)
            & Builders<BsonDocument>.Filter.Eq("RotationState", "abort-in-progress"),
            Builders<BsonDocument>.Update
                .Set("Enabled", false)
                .Set("RotationState", "revoked")
                .Set("UpdatedAt", DateTime.UtcNow));
        if (successorRevoke.ModifiedCount != 1)
            throw new InvalidOperationException("轮换中止已取得仲裁权，但新密钥撤销失败");
        await serviceKeyDirectory.DeleteOneAsync(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId),
            Builders<BsonDocument>.Filter.Eq("ServiceKeyId", id)));
        await WriteOperationAuditAsync(
            operationAudits,
            http,
            "service_key.rotation_abort",
            "llmgw_service_key",
            id,
            existing.AsNullableString("Name"),
            true,
            null,
            new BsonDocument
            {
                { "predecessorKeyId", predecessorId },
                { "predecessorRotationState", restoreState },
            });
        return Json(ApiEnvelope<object>.Ok(new
        {
            id,
            revoked = true,
            rotationState = "revoked",
            predecessorKeyId = predecessorId,
        }), jsonOptions);
    }

    await serviceKeys.UpdateOneAsync(
        keyFilter,
        Builders<BsonDocument>.Update
            .Set("Enabled", false)
            .Set("RotationState", !string.IsNullOrWhiteSpace(successorId) ? "old-key-revoked" : "revoked")
            .Set("UpdatedAt", now));
    if (!string.IsNullOrWhiteSpace(successorId))
    {
        await serviceKeys.UpdateOneAsync(
            TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", successorId),
                Builders<BsonDocument>.Filter.Eq("RotatesKeyId", id),
                Builders<BsonDocument>.Filter.Eq("Enabled", true))),
            Builders<BsonDocument>.Update.Set("RotationState", "completed").Set("UpdatedAt", now));
    }
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        "service_key.revoke",
        "llmgw_service_key",
        id,
        existing.AsNullableString("Name"),
        true,
        null);
    return Json(ApiEnvelope<object>.Ok(new
    {
        id,
        revoked = true,
        rotationState = !string.IsNullOrWhiteSpace(successorId) ? "old-key-revoked" : "revoked",
        successorKeyId = successorId,
    }), jsonOptions);
}).RequireAuthorization("ServiceKeyWrite");

// 供应商账单导入：只接受会话解析出的当前租户，不允许请求体自报 TenantId。
app.MapPost("/gw/cost-reconciliations/import", async (HttpContext http, CostReconciliationImportRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    var provider = (body.Provider ?? string.Empty).Trim().ToLowerInvariant();
    var externalRecordId = (body.ExternalRecordId ?? string.Empty).Trim();
    var providerRequestId = string.IsNullOrWhiteSpace(body.ProviderRequestId) ? null : body.ProviderRequestId.Trim();
    var serviceKeyId = string.IsNullOrWhiteSpace(body.ServiceKeyId) ? null : body.ServiceKeyId.Trim();
    var actualCurrency = CostReconciliationPolicy.NormalizeCurrency(body.ProviderCostCurrency);
    var providerReportedCost = body.ProviderReportedCost;
    if (provider.Length is < 2 or > 100
        || externalRecordId.Length is < 2 or > 160
        || providerReportedCost is null
        || providerReportedCost < 0
        || actualCurrency is null)
    {
        return Json(ApiEnvelope<object>.Fail(
            "INVALID_PROVIDER_COST",
            "provider、externalRecordId、非负 providerReportedCost 与三字母币种均为必填"), jsonOptions, 400);
    }
    if (body.ProviderToEstimatedFxRate is not null
        && (body.ProviderToEstimatedFxRate <= 0 || string.IsNullOrWhiteSpace(body.FxSnapshotId)))
    {
        return Json(ApiEnvelope<object>.Fail(
            "INVALID_FX_SNAPSHOT",
            "提供汇率时必须同时提供正数 providerToEstimatedFxRate 与 fxSnapshotId"), jsonOptions, 400);
    }

    var granularity = providerRequestId is null ? "window" : "request";
    BsonDocument? matchedLog = null;
    List<BsonDocument> windowLogs = [];
    string? reconciliationTeamId = null;
    DateTime? windowFrom = null;
    DateTime? windowTo = null;
    CostImportScopeLease? costImportLease = null;
    try
    {
    if (granularity == "request")
    {
        var requestMatches = await logs.Find(TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("ProviderRequestId", providerRequestId),
                Builders<BsonDocument>.Filter.Regex("Provider", new BsonRegularExpression(
                    $"^{System.Text.RegularExpressions.Regex.Escape(provider)}$", "i")))))
            .Limit(2)
            .ToListAsync();
        if (requestMatches.Count == 0)
            return Json(ApiEnvelope<object>.Fail("PROVIDER_REQUEST_NOT_FOUND", "当前租户没有匹配的 provider request id"), jsonOptions, 404);
        if (requestMatches.Count > 1)
            return Json(ApiEnvelope<object>.Fail("PROVIDER_REQUEST_AMBIGUOUS", "provider request id 在当前租户命中多条日志，不能自动对账"), jsonOptions, 409);
        matchedLog = requestMatches[0];
        serviceKeyId = matchedLog.AsNullableString("ServiceKeyId");
        reconciliationTeamId = matchedLog.AsNullableString("TeamId");
        costImportLease = await CostImportScopeLock.TryAcquireAsync(
            costImportScopeLocks,
            access.TenantId,
            provider,
            reconciliationTeamId,
            http.RequestAborted);
        if (costImportLease is null)
            return Json(ApiEnvelope<object>.Fail(
                "COST_IMPORT_SCOPE_BUSY",
                "当前租户、供应商和团队正在导入费用，请稍后重试"), jsonOptions, 409);
        if (matchedLog.AsNullableUtcDateTime("StartedAt") is { } matchedStartedAt)
        {
            BsonValue requestTeamValue = reconciliationTeamId is null ? BsonNull.Value : new BsonString(reconciliationTeamId);
            var coveringWindowFilters = new List<FilterDefinition<BsonDocument>>
            {
                Builders<BsonDocument>.Filter.Eq("Granularity", "window"),
                Builders<BsonDocument>.Filter.Eq("Provider", provider),
                Builders<BsonDocument>.Filter.Eq("TeamId", requestTeamValue),
                Builders<BsonDocument>.Filter.Lte("WindowFrom", matchedStartedAt),
                Builders<BsonDocument>.Filter.Gt("WindowTo", matchedStartedAt),
            };
            if (serviceKeyId is not null)
            {
                coveringWindowFilters.Add(Builders<BsonDocument>.Filter.Or(
                    Builders<BsonDocument>.Filter.Eq("ServiceKeyId", BsonNull.Value),
                    Builders<BsonDocument>.Filter.Eq("ServiceKeyId", serviceKeyId)));
            }
            else
            {
                coveringWindowFilters.Add(Builders<BsonDocument>.Filter.Eq("ServiceKeyId", BsonNull.Value));
            }
            if (await costReconciliations.CountDocumentsAsync(
                    TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(coveringWindowFilters)),
                    new CountOptions { Limit = 1 }) > 0)
            {
                return Json(ApiEnvelope<object>.Fail(
                    "PROVIDER_REQUEST_COVERED_BY_WINDOW",
                    "该 provider request id 已包含在供应商汇总账单窗口中，不能重复导入逐请求费用"), jsonOptions, 409);
            }
        }
    }
    else
    {
        windowFrom = body.WindowFrom?.ToUniversalTime();
        windowTo = body.WindowTo?.ToUniversalTime();
        if (windowFrom is null || windowTo is null || windowFrom >= windowTo || windowTo - windowFrom > TimeSpan.FromDays(31))
            return Json(ApiEnvelope<object>.Fail("INVALID_BILLING_WINDOW", "window 粒度必须提供不超过 31 天的有效 windowFrom/windowTo"), jsonOptions, 400);
        BsonDocument? matchedServiceKey = null;
        if (serviceKeyId is not null)
        {
            matchedServiceKey = await serviceKeys.Find(TenantAccess.FilterTeamScope(
                    http,
                    Builders<BsonDocument>.Filter.Eq("_id", serviceKeyId)))
                .FirstOrDefaultAsync();
            if (matchedServiceKey is null)
                return Json(ApiEnvelope<object>.Fail("SERVICE_KEY_NOT_FOUND", "当前租户没有匹配的 service key"), jsonOptions, 404);
            reconciliationTeamId = matchedServiceKey.AsNullableString("TeamId");
        }
        var windowFilter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Gte("StartedAt", windowFrom.Value),
            Builders<BsonDocument>.Filter.Lt("StartedAt", windowTo.Value),
            Builders<BsonDocument>.Filter.Regex("Provider", new BsonRegularExpression(
                $"^{System.Text.RegularExpressions.Regex.Escape(provider)}$", "i")));
        if (serviceKeyId is not null) windowFilter &= Builders<BsonDocument>.Filter.Eq("ServiceKeyId", serviceKeyId);
        var windowCount = await logs.CountDocumentsAsync(TenantAccess.FilterTeamScope(http, windowFilter));
        if (windowCount == 0)
            return Json(ApiEnvelope<object>.Fail("BILLING_WINDOW_EMPTY", "当前租户时间窗没有匹配请求"), jsonOptions, 404);
        if (windowCount > 100000)
            return Json(ApiEnvelope<object>.Fail("BILLING_WINDOW_TOO_LARGE", "单次时间窗最多对账 100000 条请求"), jsonOptions, 413);
        windowLogs = await logs.Find(TenantAccess.FilterTeamScope(http, windowFilter))
            .Project(Builders<BsonDocument>.Projection
                .Include("EstimatedCost")
                .Include("EstimatedCostCurrency")
                .Include("Model")
                .Include("ServiceKeyId")
                .Include("TeamId")
                .Include("ProviderRequestId")
                .Include("ReconciliationStatus"))
            .ToListAsync();
        if (windowLogs.Any(x => !string.IsNullOrWhiteSpace(x.AsNullableString("ReconciliationStatus"))))
            return Json(ApiEnvelope<object>.Fail(
                "BILLING_WINDOW_CONTAINS_RECONCILED_REQUEST",
                "账单窗口包含已逐请求对账的请求，请缩小窗口或改用原逐请求账单记录"), jsonOptions, 409);
        var windowProviderRequestIds = windowLogs
            .Select(x => x.AsNullableString("ProviderRequestId"))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        foreach (var requestIdChunk in windowProviderRequestIds.Chunk(1000))
        {
            var reconciledRequestFilter = Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("Granularity", "request"),
                Builders<BsonDocument>.Filter.Eq("Provider", provider),
                Builders<BsonDocument>.Filter.In("ProviderRequestId", requestIdChunk));
            if (await costReconciliations.CountDocumentsAsync(
                    TenantAccess.FilterTeamScope(http, reconciledRequestFilter),
                    new CountOptions { Limit = 1 }) > 0)
            {
                return Json(ApiEnvelope<object>.Fail(
                    "BILLING_WINDOW_CONTAINS_RECONCILED_REQUEST",
                    "账单窗口包含已逐请求对账的请求，请缩小窗口或改用原逐请求账单记录"), jsonOptions, 409);
            }
        }
        var windowTeamIds = windowLogs
            .Select(x => x.AsNullableString("TeamId"))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var containsUnscopedLog = windowLogs.Any(x => string.IsNullOrWhiteSpace(x.AsNullableString("TeamId")));
        if (windowTeamIds.Count > 1 || serviceKeyId is null && containsUnscopedLog && windowTeamIds.Count > 0)
            return Json(ApiEnvelope<object>.Fail(
                "BILLING_WINDOW_TEAM_AMBIGUOUS",
                "时间窗跨越多个团队，请按 service key 或团队拆分账单记录"), jsonOptions, 409);
        if (reconciliationTeamId is null) reconciliationTeamId = windowTeamIds.SingleOrDefault();
        costImportLease = await CostImportScopeLock.TryAcquireAsync(
            costImportScopeLocks,
            access.TenantId,
            provider,
            reconciliationTeamId,
            http.RequestAborted);
        if (costImportLease is null)
            return Json(ApiEnvelope<object>.Fail(
                "COST_IMPORT_SCOPE_BUSY",
                "当前租户、供应商和团队正在导入费用，请稍后重试"), jsonOptions, 409);
        BsonValue reconciliationTeamValue = reconciliationTeamId is null ? BsonNull.Value : new BsonString(reconciliationTeamId);
        BsonValue reconciliationKeyValue = serviceKeyId is null ? BsonNull.Value : new BsonString(serviceKeyId);
        var overlapFilters = new List<FilterDefinition<BsonDocument>>
        {
            Builders<BsonDocument>.Filter.Eq("Granularity", "window"),
            Builders<BsonDocument>.Filter.Eq("Provider", provider),
            Builders<BsonDocument>.Filter.Eq("TeamId", reconciliationTeamValue),
            Builders<BsonDocument>.Filter.Ne("ExternalRecordId", externalRecordId),
            Builders<BsonDocument>.Filter.Lt("WindowFrom", windowTo.Value),
            Builders<BsonDocument>.Filter.Gt("WindowTo", windowFrom.Value),
        };
        if (serviceKeyId is not null)
        {
            overlapFilters.Add(Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Eq("ServiceKeyId", BsonNull.Value),
                Builders<BsonDocument>.Filter.Eq("ServiceKeyId", reconciliationKeyValue)));
        }
        var overlapFilter = Builders<BsonDocument>.Filter.And(overlapFilters);
        if (await costReconciliations.CountDocumentsAsync(TenantAccess.FilterTeamScope(http, overlapFilter), new CountOptions { Limit = 1 }) > 0)
            return Json(ApiEnvelope<object>.Fail(
                "BILLING_WINDOW_OVERLAP",
                "该供应商与 service key 已存在重叠账单窗口，请使用原 externalRecordId 重试或拆分为不重叠窗口"), jsonOptions, 409);
    }

    decimal? estimatedCost;
    string? estimatedCurrency;
    string? preStatus = null;
    if (matchedLog is not null)
    {
        estimatedCost = matchedLog.AsNullableDecimal("EstimatedCost");
        estimatedCurrency = CostReconciliationPolicy.NormalizeCurrency(matchedLog.AsNullableString("EstimatedCostCurrency"));
    }
    else
    {
        var currencies = windowLogs
            .Select(x => CostReconciliationPolicy.NormalizeCurrency(x.AsNullableString("EstimatedCostCurrency")))
            .Where(x => x is not null)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var complete = windowLogs.All(x => x.AsNullableDecimal("EstimatedCost") is not null
                                           && CostReconciliationPolicy.NormalizeCurrency(x.AsNullableString("EstimatedCostCurrency")) is not null);
        if (!complete)
        {
            estimatedCost = null;
            estimatedCurrency = null;
            preStatus = "estimated-incomplete";
        }
        else if (currencies.Count != 1)
        {
            estimatedCost = null;
            estimatedCurrency = null;
            preStatus = "estimated-mixed-currency";
        }
        else
        {
            estimatedCost = windowLogs.Sum(x => x.AsNullableDecimal("EstimatedCost")!.Value);
            estimatedCurrency = currencies[0];
        }
    }

    var decision = CostReconciliationPolicy.Evaluate(
        estimatedCost,
        estimatedCurrency,
        providerReportedCost.Value,
        actualCurrency,
        body.FxSnapshotId,
        body.ProviderToEstimatedFxRate);
    var reconciliationStatus = preStatus ?? decision.Status;
    var createdAt = DateTime.UtcNow;
    var suppliedBilledAt = body.BilledAt?.ToUniversalTime();
    var billedAt = suppliedBilledAt ?? createdAt;
    var importCanonical = JsonSerializer.Serialize(new
    {
        provider = provider.ToLowerInvariant(),
        externalRecordId,
        providerRequestId,
        serviceKeyId,
        windowFrom,
        windowTo,
        providerReportedCost = providerReportedCost.Value,
        providerCostCurrency = actualCurrency,
        billedAt = suppliedBilledAt,
        fxSnapshotId = body.FxSnapshotId?.Trim(),
        body.ProviderToEstimatedFxRate,
    });
    var importHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(importCanonical))).ToLowerInvariant();
    var id = Guid.NewGuid().ToString("N");
    var reconciliationModel = matchedLog?.AsNullableString("Model")
        ?? (windowLogs.Select(x => x.AsNullableString("Model")).Distinct(StringComparer.Ordinal).Count() == 1
            ? windowLogs.FirstOrDefault()?.AsNullableString("Model")
            : null);
    var record = new BsonDocument
    {
        { "_id", id },
        { "TenantId", access.TenantId },
        { "TeamId", reconciliationTeamId is null ? BsonNull.Value : reconciliationTeamId },
        { "Provider", provider },
        { "ExternalRecordId", externalRecordId },
        { "Granularity", granularity },
        { "RequestId", matchedLog?.AsNullableString("RequestId") is { } requestId ? requestId : BsonNull.Value },
        { "ProviderRequestId", providerRequestId is null ? BsonNull.Value : providerRequestId },
        { "ServiceKeyId", serviceKeyId is null ? BsonNull.Value : serviceKeyId },
        { "Model", reconciliationModel is null ? BsonNull.Value : reconciliationModel },
        { "EstimatedCost", estimatedCost is null ? BsonNull.Value : new BsonDecimal128(estimatedCost.Value) },
        { "EstimatedCostCurrency", estimatedCurrency is null ? BsonNull.Value : estimatedCurrency },
        { "ProviderReportedCost", new BsonDecimal128(providerReportedCost.Value) },
        { "ProviderCostCurrency", actualCurrency },
        { "ProviderCostInEstimatedCurrency", decision.ProviderCostInEstimatedCurrency is null ? BsonNull.Value : new BsonDecimal128(decision.ProviderCostInEstimatedCurrency.Value) },
        { "FxSnapshotId", string.IsNullOrWhiteSpace(body.FxSnapshotId) ? BsonNull.Value : body.FxSnapshotId.Trim() },
        { "ProviderToEstimatedFxRate", body.ProviderToEstimatedFxRate is null ? BsonNull.Value : new BsonDecimal128(body.ProviderToEstimatedFxRate.Value) },
        { "ReconciliationStatus", reconciliationStatus },
        { "ReconciliationDelta", decision.Delta is null ? BsonNull.Value : new BsonDecimal128(decision.Delta.Value) },
        { "DeltaCurrency", decision.DeltaCurrency is null ? BsonNull.Value : decision.DeltaCurrency },
        { "WindowFrom", windowFrom is null ? BsonNull.Value : new BsonDateTime(windowFrom.Value) },
        { "WindowTo", windowTo is null ? BsonNull.Value : new BsonDateTime(windowTo.Value) },
        { "BilledAt", billedAt },
        { "ImportHash", importHash },
        { "CreatedByUserId", access.UserId },
        { "CreatedAt", createdAt },
    };

    async Task ApplyMatchedRequestLogAsync()
    {
        if (matchedLog is null) return;
        await logs.UpdateOneAsync(
            TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.Eq("_id", matchedLog.GetStringOrEmpty("_id"))),
            new BsonDocument("$set", new BsonDocument
            {
                { "ProviderReportedCost", new BsonDecimal128(providerReportedCost.Value) },
                { "ProviderCostCurrency", actualCurrency },
                { "FxSnapshotId", string.IsNullOrWhiteSpace(body.FxSnapshotId) ? BsonNull.Value : body.FxSnapshotId.Trim() },
                { "ReconciliationStatus", reconciliationStatus },
                { "ReconciliationDelta", decision.Delta is null ? BsonNull.Value : new BsonDecimal128(decision.Delta.Value) },
            }));
    }

    if (costImportLease is null
        || !await CostImportScopeLock.TryRenewAsync(
            costImportScopeLocks,
            costImportLease,
            http.RequestAborted))
    {
        return Json(ApiEnvelope<object>.Fail(
            "COST_IMPORT_SCOPE_LOST",
            "费用导入租约已失效，未写入账单，请重试"), jsonOptions, 409);
    }

    try
    {
        await costReconciliations.InsertOneAsync(record);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        var existing = await costReconciliations.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("Provider", provider),
                Builders<BsonDocument>.Filter.Eq("ExternalRecordId", externalRecordId))))
            .FirstOrDefaultAsync();
        if (existing is not null && existing.AsNullableString("ImportHash") != importHash)
            return Json(ApiEnvelope<object>.Fail("COST_IMPORT_CONFLICT", "同一供应商账单记录已用不同内容导入"), jsonOptions, 409);
        if (existing is not null)
        {
            // 首次导入可能已写入对账记录、但在请求日志投影前进程退出。
            // 同内容重试必须补写日志，不能把幂等成功变成永久不一致。
            await ApplyMatchedRequestLogAsync();
            return Json(ApiEnvelope<CostReconciliationItem>.Ok(MapCostReconciliation(existing)), jsonOptions);
        }
        if (providerRequestId is not null)
        {
            var requestExisting = await costReconciliations.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("Provider", provider),
                    Builders<BsonDocument>.Filter.Eq("ProviderRequestId", providerRequestId),
                    Builders<BsonDocument>.Filter.Eq("Granularity", "request"))))
                .FirstOrDefaultAsync();
            if (requestExisting is not null)
                return Json(ApiEnvelope<object>.Fail("PROVIDER_REQUEST_ALREADY_RECONCILED", "该 provider request id 已关联另一条供应商账单记录"), jsonOptions, 409);
        }
        throw;
    }

    await ApplyMatchedRequestLogAsync();
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        "cost.reconciliation.import",
        "llmgw_cost_reconciliation",
        id,
        externalRecordId,
        true,
        null,
        new BsonDocument
        {
            { "provider", provider },
            { "granularity", granularity },
            { "status", reconciliationStatus },
            { "currency", actualCurrency },
        });
    return Json(ApiEnvelope<CostReconciliationItem>.Ok(MapCostReconciliation(record)), jsonOptions, 201);
    }
    finally
    {
        if (costImportLease is not null)
        {
            try
            {
                await CostImportScopeLock.ReleaseAsync(
                    costImportScopeLocks,
                    costImportLease,
                    CancellationToken.None);
            }
            catch (MongoException)
            {
                // 账单已写入时不能让锁释放故障把成功响应改为 500；短租约会由 TTL 回收。
            }
        }
    }
}).RequireAuthorization("ConfigWrite");

app.MapGet("/gw/cost-reconciliations", async (HttpContext http, string? from, string? to) =>
{
    var range = ResolveRange(from, to, 30);
    var recordFilter = TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Gte("BilledAt", range.From),
        Builders<BsonDocument>.Filter.Lt("BilledAt", range.To)));
    var docs = await costReconciliations.Find(recordFilter)
        .Sort(Builders<BsonDocument>.Sort.Descending("BilledAt"))
        .Limit(500)
        .ToListAsync();
    var actualAggregate = await costReconciliations.Aggregate()
        .Match(recordFilter & Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Ne("ProviderReportedCost", BsonNull.Value),
            Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Type("ProviderReportedCost", BsonType.Decimal128),
                Builders<BsonDocument>.Filter.Type("ProviderReportedCost", BsonType.Double),
                Builders<BsonDocument>.Filter.Type("ProviderReportedCost", BsonType.Int32),
                Builders<BsonDocument>.Filter.Type("ProviderReportedCost", BsonType.Int64)),
            Builders<BsonDocument>.Filter.Type("ProviderCostCurrency", BsonType.String)))
        .Group(new BsonDocument
        {
            { "_id", "$ProviderCostCurrency" },
            { "Amount", new BsonDocument("$sum", "$ProviderReportedCost") },
            { "Requests", new BsonDocument("$sum", 1) },
        })
        .Sort(new BsonDocument("_id", 1))
        .ToListAsync();
    var actualCosts = actualAggregate
        .Where(x => x.AsNullableDecimal("Amount") is not null)
        .Select(x => new EstimatedCostBucket
        {
            Currency = x.GetStringOrEmpty("_id"),
            Amount = x.AsNullableDecimal("Amount")!.Value,
            Requests = x.AsNullableLong("Requests") ?? 0,
        }).ToList();
    var statusAggregate = await costReconciliations.Aggregate()
        .Match(recordFilter)
        .Group(new BsonDocument
        {
            { "_id", new BsonDocument("$ifNull", new BsonArray { "$ReconciliationStatus", "unknown" }) },
            { "Count", new BsonDocument("$sum", 1) },
        })
        .Sort(new BsonDocument("Count", -1))
        .ToListAsync();
    var logFilter = TenantAccess.FilterTeamScope(http, Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Gte("StartedAt", range.From),
        Builders<BsonDocument>.Filter.Lt("StartedAt", range.To),
        Builders<BsonDocument>.Filter.Or(
            Builders<BsonDocument>.Filter.Exists("ReconciliationStatus", false),
            Builders<BsonDocument>.Filter.Eq("ReconciliationStatus", BsonNull.Value))));
    var totalRecords = await costReconciliations.CountDocumentsAsync(recordFilter);
    var result = new CostReconciliationSummary
    {
        TotalRecords = totalRecords,
        RequestRecords = await costReconciliations.CountDocumentsAsync(recordFilter & Builders<BsonDocument>.Filter.Eq("Granularity", "request")),
        WindowRecords = await costReconciliations.CountDocumentsAsync(recordFilter & Builders<BsonDocument>.Filter.Eq("Granularity", "window")),
        ActualUnavailableRequests = await logs.CountDocumentsAsync(logFilter),
        ProviderActualCosts = actualCosts,
        StatusDistribution = statusAggregate.Select(x => new LogsBucketItem
        {
            Key = string.IsNullOrWhiteSpace(x.GetStringOrEmpty("_id")) ? "unknown" : x.GetStringOrEmpty("_id"),
            Count = x.AsNullableLong("Count") ?? 0,
        }).ToList(),
        Items = docs.Select(MapCostReconciliation).ToList(),
    };
    return Json(ApiEnvelope<CostReconciliationSummary>.Ok(result), jsonOptions);
}).RequireAuthorization("UsageRead");

app.MapGet("/gw/legacy-key-cutover", async (HttpContext http) =>
{
    var access = TenantAccess.GetRequired(http);
    if (!string.Equals(access.TenantId, internalTenantId, StringComparison.Ordinal))
        return Json(ApiEnvelope<object>.Ok(new { applicable = false, status = "not-applicable", usage = Array.Empty<object>() }), jsonOptions);
    var policy = await legacyKeyCutovers.Find(TenantAccess.Filter(http)).FirstOrDefaultAsync();
    var usage = await legacyKeyUsage.Find(TenantAccess.Filter(http))
        .Sort(Builders<BsonDocument>.Sort.Descending("LastSeenAt"))
        .Limit(500)
        .ToListAsync();
    var successorIds = policy?.AsStringList("SuccessorServiceKeyIds") ?? [];
    var requiredIngressProtocols = policy?.AsStringList("RequiredIngressProtocols") ?? [];
    var requiredScopes = policy?.AsStringList("RequiredScopes") ?? [];
    if (requiredScopes.Count == 0)
        requiredScopes = LegacySuccessorScopePolicy.RequiredRuntimeScopes.ToList();
    var successorCounts = ReadSuccessorObservationCounts(policy);
    var requiredObservations = policy?.AsNullableLong("RequiredSuccessorObservations") ?? 1;
    var minimumObserved = successorIds.Count == 0
        ? 0
        : successorIds.Min(id => successorCounts.GetValueOrDefault(id));
    return Json(ApiEnvelope<object>.Ok(new
    {
        applicable = true,
        status = policy?.AsNullableString("Status") ?? "observing",
        deadlineAt = policy?.AsNullableUtcDateTime("DeadlineAt").ToIso(),
        allowedAppCallerCodes = policy?.AsStringList("AllowedAppCallerCodes") ?? [],
        successorServiceKeyIds = successorIds,
        requiredIngressProtocols,
        requiredScopes,
        requiredSuccessorObservations = requiredObservations,
        successorObservedCount = minimumObserved,
        successorObservationCounts = successorCounts,
        lastSuccessorUsedAt = policy?.AsNullableUtcDateTime("LastSuccessorUsedAt").ToIso(),
        readyToRevoke = policy is not null
                        && successorIds.Count > 0
                        && successorIds.All(id => successorCounts.GetValueOrDefault(id) >= requiredObservations),
        usage = usage.Select(x => new
        {
            sourceSystem = x.AsNullableString("SourceSystem"),
            appCallerCode = x.AsNullableString("AppCallerCode"),
            ingressProtocol = x.AsNullableString("IngressProtocol"),
            totalCount = x.AsNullableLong("TotalCount") ?? 0,
            allowedCount = x.AsNullableLong("AllowedCount") ?? 0,
            rejectedCount = x.AsNullableLong("RejectedCount") ?? 0,
            firstSeenAt = x.AsNullableUtcDateTime("FirstSeenAt").ToIso(),
            lastSeenAt = x.AsNullableUtcDateTime("LastSeenAt").ToIso(),
            lastDecision = x.AsNullableString("LastDecision"),
        }),
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/legacy-key-cutover", async (HttpContext http, LegacyKeyCutoverUpdateRequest body) =>
{
    var access = TenantAccess.GetRequired(http);
    if (!string.Equals(access.TenantId, internalTenantId, StringComparison.Ordinal))
        return Json(ApiEnvelope<object>.Fail("LEGACY_KEY_NOT_APPLICABLE", "legacy shared key 只属于内部租户"), jsonOptions, 404);
    var status = (body.Status ?? "observing").Trim().ToLowerInvariant();
    if (status is not ("observing" or "ready" or "revoked"))
        return Json(ApiEnvelope<object>.Fail("INVALID_LEGACY_CUTOVER_STATUS", "status 仅支持 observing、ready、revoked"), jsonOptions, 400);
    var allowedCallers = NormalizeDistinct(body.AllowedAppCallerCodes ?? [], 500);
    var successorIds = NormalizeDistinct(body.SuccessorServiceKeyIds ?? [], 100);
    var requiredIngressProtocols = TargetIngressProtocols().Select(protocol => protocol.Key).ToList();
    var requiredScopes = LegacySuccessorScopePolicy.RequiredRuntimeScopes.ToList();
    var required = Math.Clamp(body.RequiredSuccessorObservations, 1, 1000000);
    if (body.DeadlineAt is null)
        return Json(ApiEnvelope<object>.Fail("LEGACY_DEADLINE_REQUIRED", "必须设置 legacy key 截止时间"), jsonOptions, 400);
    if (successorIds.Count > 0)
    {
        if (allowedCallers.Count == 0)
            return Json(ApiEnvelope<object>.Fail("LEGACY_CALLER_INVENTORY_REQUIRED", "配置后继 key 前必须列出 legacy key 的允许调用方"), jsonOptions, 409);
        var successorDocs = await serviceKeys.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.In("_id", successorIds),
                Builders<BsonDocument>.Filter.Eq("Enabled", true),
                Builders<BsonDocument>.Filter.Regex("Environment", new BsonRegularExpression("^production$", "i")),
                Builders<BsonDocument>.Filter.Regex("Purpose", new BsonRegularExpression("^runtime$", "i")),
                Builders<BsonDocument>.Filter.Regex("SourceSystem", new BsonRegularExpression("^map$", "i")))))
            .ToListAsync();
        if (successorDocs.Count != successorIds.Count)
            return Json(ApiEnvelope<object>.Fail("LEGACY_SUCCESSOR_INVALID", "所有后继 key 必须是当前内部租户启用的 production MAP runtime scoped key"), jsonOptions, 409);
        foreach (var successor in successorDocs)
        {
            var missingCallers = LegacySuccessorScopePolicy.FindMissing(successor.AsStringList("AppCallerCodes"), allowedCallers);
            var missingProtocols = LegacySuccessorScopePolicy.FindMissing(successor.AsStringList("IngressProtocols"), requiredIngressProtocols);
            var missingScopes = LegacySuccessorScopePolicy.FindMissing(successor.AsStringList("Scopes"), requiredScopes);
            if (missingCallers.Count > 0 || missingProtocols.Count > 0 || missingScopes.Count > 0)
            {
                return Json(ApiEnvelope<object>.Fail(
                    "LEGACY_SUCCESSOR_SCOPE_INCOMPLETE",
                    $"后继 key {successor.GetStringOrEmpty("_id")} 未覆盖 legacy 调用方、四协议或运行时 scope"), jsonOptions, 409);
            }
        }
    }
    var current = await legacyKeyCutovers.Find(TenantAccess.Filter(http)).FirstOrDefaultAsync();
    if (string.Equals(current?.AsNullableString("Status"), "revoked", StringComparison.OrdinalIgnoreCase)
        && status != "revoked")
        return Json(ApiEnvelope<object>.Fail("LEGACY_REVOCATION_FINAL", "legacy shared key 已永久撤销，不能恢复为可用状态"), jsonOptions, 409);
    var currentSuccessorIds = current?.AsStringList("SuccessorServiceKeyIds") ?? [];
    var successorSetUnchanged = currentSuccessorIds.Count == successorIds.Count
                                && currentSuccessorIds.ToHashSet(StringComparer.Ordinal).SetEquals(successorIds);
    var currentCounts = ReadSuccessorObservationCounts(current);
    var retainedCounts = successorIds.ToDictionary(
        id => id,
        id => successorSetUnchanged ? currentCounts.GetValueOrDefault(id) : 0L,
        StringComparer.Ordinal);
    var minimumObserved = successorIds.Count == 0 ? 0 : successorIds.Min(id => retainedCounts[id]);
    if (status == "revoked" && (successorIds.Count == 0 || minimumObserved < required))
        return Json(ApiEnvelope<object>.Fail("LEGACY_DUAL_KEY_OBSERVATION_REQUIRED", "后继 scoped key 观测次数达标后才能撤销 legacy key"), jsonOptions, 409);
    var now = DateTime.UtcNow;
    var id = current?.GetStringOrEmpty("_id") is { Length: > 0 } currentId ? currentId : Guid.NewGuid().ToString("N");
    var policyFilter = TenantAccess.Filter(http);
    if (status == "revoked")
    {
        foreach (var successorId in successorIds)
            policyFilter &= Builders<BsonDocument>.Filter.Gte($"SuccessorObservationCounts.{successorId}", required);
    }
    var policyUpdate = Builders<BsonDocument>.Update
        .SetOnInsert("_id", id)
        .SetOnInsert("TenantId", access.TenantId)
        .Set("Status", status)
        .Set("DeadlineAt", body.DeadlineAt.Value.ToUniversalTime())
        .Set("AllowedAppCallerCodes", new BsonArray(allowedCallers))
        .Set("SuccessorServiceKeyIds", new BsonArray(successorIds))
        .Set("RequiredIngressProtocols", new BsonArray(requiredIngressProtocols))
        .Set("RequiredScopes", new BsonArray(requiredScopes))
        .Set("RequiredSuccessorObservations", required)
        .Set("UpdatedAt", now);
    if (!successorSetUnchanged)
    {
        policyUpdate = policyUpdate
            .Set("SuccessorObservationCounts", new BsonDocument(retainedCounts.Select(x => new BsonElement(x.Key, x.Value))))
            .Set("SuccessorObservedCount", 0)
            .Set("LastSuccessorUsedAt", BsonNull.Value);
    }
    UpdateResult updateResult;
    try
    {
        updateResult = await legacyKeyCutovers.UpdateOneAsync(
            policyFilter,
            policyUpdate,
            new UpdateOptions { IsUpsert = current is null });
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<object>.Fail("LEGACY_CUTOVER_CONFLICT", "退场策略已被并发创建，请刷新后重试"), jsonOptions, 409);
    }
    if (updateResult.MatchedCount == 0 && current is not null)
        return Json(ApiEnvelope<object>.Fail("LEGACY_DUAL_KEY_OBSERVATION_REQUIRED", "后继 scoped key 观测状态已变化，请刷新后重试"), jsonOptions, 409);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        status == "revoked" ? "legacy_key.revoke" : "legacy_key.cutover_update",
        "llmgw_legacy_key_cutover",
        id,
        "legacy-map-shared",
        true,
        null,
        new BsonDocument
        {
            { "status", status },
            { "deadlineAt", body.DeadlineAt.Value.ToUniversalTime() },
            { "allowedAppCallerCount", allowedCallers.Count },
            { "successorKeyCount", successorIds.Count },
            { "requiredSuccessorObservations", required },
        });
    return Json(ApiEnvelope<object>.Ok(new { id, status, deadlineAt = body.DeadlineAt.Value.ToUniversalTime(), observed = minimumObserved, required }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

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
    var filter = TenantAccess.FilterTeamScope(http, filters.Count == 0 ? fb.Empty : fb.And(filters));
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

// ─────────────── 网关配置面（可写）───────────────
// 外部租户只写 llm_gateway 自有集合；TenantId 永远来自服务端会话，不接受请求体自报。
// 内部租户继续保留 MAP 来源对象的认领兼容路径，不重做既有迁移和运行时发布流程。

// 创建 Provider：上游通讯密钥是必填项，只加密落库，不进入响应或审计。
app.MapPost("/gw/platforms", async (HttpContext http, [FromBody] CreatePlatformRequest? body) =>
{
    if (!GatewayConfigurationProvisioning.TryNormalizePlatform(body, out var draft, out var error) || draft is null)
        return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var fb = Builders<BsonDocument>.Filter;
    var duplicateFilter = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Or(
            fb.Eq("NameNormalized", draft.NameNormalized),
            fb.Regex("Name", new BsonRegularExpression($"^{System.Text.RegularExpressions.Regex.Escape(draft.Name)}$", "i"))));
    if (await gwPlatforms.Find(duplicateFilter).AnyAsync())
        return Json(ApiEnvelope<PlatformItem>.Fail("DUPLICATE_PLATFORM", "当前租户已存在同名 Provider"), jsonOptions, 409);

    string encryptedApiKey;
    try
    {
        encryptedApiKey = GwApiKeyCrypto.Encrypt(draft.ApiKey, config);
    }
    catch (InvalidOperationException ex)
    {
        return Json(ApiEnvelope<PlatformItem>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
    }

    var id = $"gw-platform-{Guid.NewGuid():N}";
    var now = DateTime.UtcNow;
    var document = GatewayConfigurationProvisioning.BuildPlatformDocument(draft, tenantId, id, encryptedApiKey, now);
    try
    {
        await gwPlatforms.InsertOneAsync(document);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<PlatformItem>.Fail("DUPLICATE_PLATFORM", "当前租户已存在同名 Provider"), jsonOptions, 409);
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "platform.create",
        targetType: "llmgw_platform",
        targetId: id,
        targetName: draft.Name,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "platformType", draft.PlatformType },
            { "apiUrl", draft.ApiUrl },
            { "maxConcurrency", draft.MaxConcurrency },
            { "hasKey", true },
        });
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(document, config, revealFingerprint: true)), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

// ---------------------------------------------------------------------------
// 上游预设 + 连通性自测 + 模型发现导入
//
// 见 .claude/rules/minimal-user-input.md：Provider 的地址/协议/并发是系统本来就知道的，
// 不该让用户去搜供应商文档；密钥填完之后，模型清单与价格是上游查得到的，不该让用户照抄。
// 同一条规则还规定了连带义务——最小输入必须配当场自测、结果可见、失败给下一步，
// 否则就退化成「蒙着眼睛少填几个字」。下面三个端点就是这三件事。
// ---------------------------------------------------------------------------

// 探测上游用的 HttpClient：超时压到 15s，避免一个不通的地址把控制台请求挂住。
// 探针专用 HttpClient。三道门，缺一道都能被绕过：
//
// 1. **关掉自动重定向**：校验只对最初那个地址成立，跟随 302 等于把已校验目标换成
//    一个没校验过的地址。重定向会如实变成一个 3xx 回给用户，比静默跟过去更透明。
// 2. **在 ConnectCallback 里校验真正要连的那个 IP**。只在发请求前查一次 DNS 是不够的：
//    HttpClient 连接时会**再解析一次**，控制着 rebinding 域名的租户可以让第一次返回公网
//    地址、第二次返回 127.0.0.1 或 169.254.169.254，前面那道校验就白做了
//    （predicate-and-wiring-discipline 形状 6：判据读到的不是真正生效的那个值）。
//    放在这里就没有窗口——被校验的地址和被连接的地址是同一个。
// 3. 是否强制这道门由请求自己带（内部租户的本地上游预设本来就要指向内网，见下）。
var blockPrivateProbeTargets = new HttpRequestOptionsKey<bool>("BlockPrivateProbeTargets");
var upstreamProbeHttp = new HttpClient(new SocketsHttpHandler
{
    AllowAutoRedirect = false,
    ConnectCallback = async (context, ct) =>
    {
        var enforce = context.InitialRequestMessage.Options.TryGetValue(blockPrivateProbeTargets, out var flag) && flag;
        var host = context.DnsEndPoint.Host;
        var addresses = IPAddress.TryParse(host, out var literal)
            ? new[] { literal }
            : await Dns.GetHostAddressesAsync(host, ct);

        if (enforce)
        {
            addresses = addresses.Where(GatewayConfigurationProvisioning.IsSafeExternalExchangeAddress).ToArray();
            if (addresses.Length == 0)
                throw new HttpRequestException("目标解析到了内网、回环或云元数据地址，已拒绝连接");
        }
        if (addresses.Length == 0)
            throw new HttpRequestException("目标域名解析不到任何地址");

        var socket = new System.Net.Sockets.Socket(System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, ct);
            return new System.Net.Sockets.NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    },
})
{
    Timeout = TimeSpan.FromSeconds(15),
};

/// <summary>
/// 外部租户的 Provider 探测目标必须先过内网地址校验，口径与外部 Exchange 完全一致
/// （复用 ValidateExternalExchangeTargetAsync）。
///
/// 不加的话，外部租户的 owner 只要把 Provider 地址填成 127.0.0.1 / 10.x / 169.254.169.254，
/// 就能借「测试连接」和「查看模型」两个端点，拿控制台容器当跳板扫内网和云元数据。
/// 这两个端点是本次新增的，等于新开了一个出口，必须补上同一道门。
///
/// 内部租户不受此限：本地上游预设（Ollama / vLLM）本来就要指向内网，
/// 这条豁免与 Exchange 侧的既有策略同源，不是本次新开的口子。
async Task<string?> ValidateProviderProbeTargetAsync(HttpContext http, string apiUrl, CancellationToken ct)
{
    if (TenantAccess.GetRequired(http).TenantId == internalTenantId) return null;
    return await ValidateExternalExchangeTargetAsync(apiUrl, "openai", ct);
}

// 一次导入的模型数上限。聚合型上游（OpenRouter）能列出几百个模型，全勾下来会把
// 模型列表冲垮，也让后面的模型池选型无从下手；分批导入是刻意的摩擦。
const int MaxImportBatch = 200;

// 上游响应体读取上限。模型清单再大也就几百 KB，8 MB 是宽松到不会误伤的天花板。
const int MaxUpstreamBodyBytes = 8 * 1024 * 1024;

// 一次发现最多展示多少个模型。聚合型上游（OpenRouter）目前四百多个，2000 是宽松到
// 不会误伤真实上游、又能挡住「几十万个小对象」那种病态响应的天花板。
const int MaxDiscoveredModels = 2000;

app.MapGet("/gw/provider-presets", (HttpContext http) =>
{
    var items = ProviderPresets.All.Select(p => new ProviderPresetItem
    {
        Key = p.Key,
        Name = p.Name,
        PlatformType = p.PlatformType,
        ApiUrl = p.ApiUrl,
        ProviderId = p.ProviderId,
        MaxConcurrency = p.MaxConcurrency,
        KeyConsoleUrl = p.KeyConsoleUrl,
        KeyPrefixHint = p.KeyPrefixHint,
        SupportsModelDiscovery = p.SupportsModelDiscovery,
        SupportsUpstreamPricing = p.SupportsUpstreamPricing,
        Summary = p.Summary,
        SearchTerms = p.SearchTerms.ToList(),
        KeylessPlaceholder = p.KeylessPlaceholder,
    }).ToList();
    return Json(ApiEnvelope<ProviderPresetsData>.Ok(new ProviderPresetsData { Items = items }), jsonOptions);
}).RequireAuthorization("LogsRead");

// 连通性自测：拿已保存的密钥去打一次上游的模型列表，回报成败 + 耗时 + 可执行的下一步。
// 只读，不改任何配置；探测地址一并回给用户核对（他填错 baseUrl 时这一行就是答案）。
app.MapPost("/gw/platforms/{id}/test", async (HttpContext http, string id) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var doc = await gwPlatforms.Find(TenantAccess.Filter(http, fb.Eq("_id", id))).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<PlatformTestResult>.Fail("NOT_FOUND", "Provider 不存在或不属于当前租户"), jsonOptions, 404);

    var apiUrl = doc.AsNullableString("ApiUrl") ?? string.Empty;
    var platformType = doc.GetStringOrEmpty("PlatformType");
    var probeUrl = ProviderPresets.ResolveModelsUrl(apiUrl);

    if (string.IsNullOrWhiteSpace(apiUrl))
        return Json(ApiEnvelope<PlatformTestResult>.Ok(new PlatformTestResult
        {
            Reachable = false, ProbedUrl = probeUrl, ElapsedMs = 0, FailureKind = "NO_API_URL",
            Message = "这个 Provider 没有配 API 地址", NextStep = "在高级选项里补上 API 地址后再测",
        }), jsonOptions);

    var probeTargetError = await ValidateProviderProbeTargetAsync(http, apiUrl, http.RequestAborted);
    if (probeTargetError is not null)
        return Json(ApiEnvelope<PlatformTestResult>.Ok(new PlatformTestResult
        {
            Reachable = false, ProbedUrl = probeUrl, ElapsedMs = 0, FailureKind = "UNSAFE_TARGET_URL",
            Message = probeTargetError, NextStep = "把 API 地址改成公网可达的上游域名",
        }), jsonOptions);

    var keyResult = GwApiKeyCrypto.Decrypt(doc.AsNullableString("ApiKeyEncrypted"), config);
    // 库里存了密文却解不出来（密钥轮换过、或密文损坏）——这时候**绝不能**当成「没配密钥」继续裸奔。
    // 裸奔请求打到一个不要求鉴权的 /models 上会拿到合法的 data 数组，于是报「密钥被接受」绿灯，
    // 而业务真去调用时根本取不出这把钥匙。这个仓库为这件事付过代价：轮换 CDS_JWT_SECRET
    // 打哑了全部平台密钥，静默 401 两小时无人察觉（cross-project-isolation 通道 2）。
    // 「测试连接」存在的全部意义就是别让这种事再静默发生，所以这里必须先失败。
    var hasStoredKey = !string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted"));
    if (hasStoredKey && !keyResult.Success)
        return Json(ApiEnvelope<PlatformTestResult>.Ok(new PlatformTestResult
        {
            Reachable = false, ProbedUrl = probeUrl, ElapsedMs = 0, FailureKind = "KEY_UNREADABLE",
            Message = "这个 Provider 存着密钥，但当前服务解不开它（多半是加密密钥换过，或密文损坏）",
            NextStep = "用「更新密钥」重新填一次原始密钥；若是刚轮换过加密密钥，存量密文都需要重填",
        }), jsonOptions);

    var sw = System.Diagnostics.Stopwatch.StartNew();
    try
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, probeUrl);
        if (keyResult.Success && keyResult.PlainText.Length > 0)
        {
            // Claude 原生协议用 x-api-key，OpenAI 兼容用 Bearer。判错的话会拿到 401，
            // 那正是我们要如实报出来的信息，不做静默双发。
            if (string.Equals(platformType, "claude", StringComparison.OrdinalIgnoreCase))
            {
                req.Headers.TryAddWithoutValidation("x-api-key", keyResult.PlainText);
                req.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
            }
            else
            {
                req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {keyResult.PlainText}");
            }
        }

        // 外部租户强制内网校验；内部租户豁免（本地上游预设本来就要指向内网）
        req.Options.Set(blockPrivateProbeTargets, TenantAccess.GetRequired(http).TenantId != internalTenantId);

        // 整条探测（含读 body）共用一个 15 秒预算。
        // HttpClient.Timeout 在 ResponseHeadersRead 下只覆盖到响应头到达为止：
        // 上游先回头、再把 body 挂住慢慢流，下面这个读就没人管了，
        // 「保存后自动测一次」会挂死并占住一个控制台请求。
        using var probeCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var resp = await upstreamProbeHttp.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, probeCts.Token);
        sw.Stop();
        var status = (int)resp.StatusCode;
        int? modelCount = null;
        if (resp.IsSuccessStatusCode)
        {
            try
            {
                var body = await ReadUpstreamBodyAsync(resp, MaxUpstreamBodyBytes, probeCts.Token);
                var probeRoot = System.Text.Json.Nodes.JsonNode.Parse(body) as System.Text.Json.Nodes.JsonObject;
                var arr = probeRoot?["data"] as System.Text.Json.Nodes.JsonArray;
                modelCount = arr?.Count;
            }
            // 不是 JSON、或体积超限中止 —— 都留 modelCount = null，交给下面的形状判据判成不可达。
            // 超限本身就说明这个地址回的不是模型清单，报「形状不对」比报 500 更贴近真相。
            catch (System.Text.Json.JsonException) { }
            catch (InvalidOperationException) { }
        }

        // 200 不等于「这个地址能用」。
        //
        // 地址填错、前面挡着一层登录代理、或者对方是个 SPA 把所有路径都 fallback 到 index.html——
        // 这些情况统统回 200，只是 body 是 HTML 或别的 JSON。第一版只要 IsSuccessStatusCode
        // 就报「密钥被接受」并亮绿灯，而紧接着的「查看模型」必然拿不到东西：
        // 用户拿到一个绿灯 + 一个不工作的 Provider，正是这条测试要防的那种假象。
        // 探针打的就是 /models，那就要求它长得像 /models 该有的样子（有 data 数组）。
        //
        // Claude 原生协议没有模型列表接口，探针本来就不指望拿到 data，豁免。
        var expectsModelList = !string.Equals(platformType, "claude", StringComparison.OrdinalIgnoreCase);
        var shapeMismatch = resp.IsSuccessStatusCode && expectsModelList && modelCount is null;

        var (kind, message, nextStep) = shapeMismatch
            ? ((string?)"BAD_PAYLOAD_SHAPE",
               $"上游回了 HTTP {status}，但返回内容不是模型列表（没有 data 数组）",
               (string?)"多半是 API 地址指错了地方（比如指到了网站首页或登录页）。在高级选项里核对地址，或改用内置预设")
            : status switch
        {
            // 探针打的是 /models，它证明的只有「这个地址连得上、而且能读出模型列表」。
            // 不少 OpenAI 兼容上游的 /models 是公开的、或者干脆忽略 Authorization 头，
            // 换句话说：拿一把错密钥照样能拿到 200 + data 数组，真正推理时才 401。
            // 所以这里只能说读到了什么，不能替上游宣布「密钥被接受」——
            // 那是一句探针根本没验证过的话（no-rootless-tree：不声明验不了的能力）。
            >= 200 and < 300 => ((string?)null,
                modelCount is null ? "上游可达，模型列表能读到" : $"上游可达，读到 {modelCount} 个模型",
                (string?)"读得到模型列表不等于密钥一定有效——有些上游的列表接口不校验密钥。要确认密钥能用，导入模型后发一次真实调用"),
            401 or 403 => ("UNAUTHORIZED", $"上游拒绝了这个密钥（HTTP {status}）",
                "去 Provider 控制台确认密钥有效、没过期、有调用权限，然后用「更新密钥」重填"),
            404 => ("NOT_FOUND", $"地址不对，上游说没有这个接口（HTTP {status}）",
                "多半是 API 地址填错了。在高级选项里核对地址，或改用内置预设"),
            429 => ("RATE_LIMITED", "上游限流（HTTP 429）",
                "密钥本身是通的，稍后再测；如果持续限流，检查上游账号的速率配额"),
            >= 500 => ("UPSTREAM_ERROR", $"上游服务异常（HTTP {status}）", "上游的问题，过一会儿再测"),
            _ => ("UNEXPECTED_STATUS", $"上游返回了意料之外的状态（HTTP {status}）", "把这个状态码提供给上游支持，或核对地址"),
        };

        return Json(ApiEnvelope<PlatformTestResult>.Ok(new PlatformTestResult
        {
            // 形状不对就不算可达——绿灯必须代表「这个 Provider 真能用」
            Reachable = resp.IsSuccessStatusCode && !shapeMismatch, HttpStatus = status, ElapsedMs = sw.ElapsedMilliseconds,
            ProbedUrl = probeUrl, ModelCount = modelCount, FailureKind = kind, Message = message, NextStep = nextStep,
        }), jsonOptions);
    }
    catch (TaskCanceledException)
    {
        sw.Stop();
        return Json(ApiEnvelope<PlatformTestResult>.Ok(new PlatformTestResult
        {
            Reachable = false, ElapsedMs = sw.ElapsedMilliseconds, ProbedUrl = probeUrl, FailureKind = "TIMEOUT",
            Message = "15 秒内没有响应", NextStep = "检查地址是否可从网关容器访问；本地部署的上游要用容器能解析的主机名",
        }), jsonOptions);
    }
    catch (HttpRequestException ex)
    {
        sw.Stop();
        return Json(ApiEnvelope<PlatformTestResult>.Ok(new PlatformTestResult
        {
            Reachable = false, ElapsedMs = sw.ElapsedMilliseconds, ProbedUrl = probeUrl, FailureKind = "NETWORK",
            Message = $"连不上：{ex.Message}", NextStep = "确认域名可解析、端口可达、出网策略放行了这个域名",
        }), jsonOptions);
    }
}).RequireAuthorization("ConfigWrite");

// 拉上游模型清单：用户不该照着供应商文档往输入框里抄模型名。
// 用途按标识推断（拿不准就留空），价格只认上游自己给的（不内置价目表，见 ProviderPresets.ReadPricing）。
app.MapGet("/gw/platforms/{id}/upstream-models", async (HttpContext http, string id) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var doc = await gwPlatforms.Find(TenantAccess.Filter(http, fb.Eq("_id", id))).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("NOT_FOUND", "Provider 不存在或不属于当前租户"), jsonOptions, 404);

    var apiUrl = doc.AsNullableString("ApiUrl") ?? string.Empty;
    var probeUrl = ProviderPresets.ResolveModelsUrl(apiUrl);
    if (string.IsNullOrWhiteSpace(apiUrl))
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("NO_API_URL", "这个 Provider 没有配 API 地址"), jsonOptions, 400);
    if (string.Equals(doc.GetStringOrEmpty("PlatformType"), "claude", StringComparison.OrdinalIgnoreCase))
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("DISCOVERY_UNSUPPORTED",
            "Claude 原生协议没有模型列表接口，请手动添加模型"), jsonOptions, 400);

    // 与「测试连接」同一道门：这条也会拿着用户填的地址向外发请求，不补上就等于留了个后门
    var discoveryTargetError = await ValidateProviderProbeTargetAsync(http, apiUrl, http.RequestAborted);
    if (discoveryTargetError is not null)
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("UNSAFE_TARGET_URL", discoveryTargetError), jsonOptions, 400);

    var keyResult = GwApiKeyCrypto.Decrypt(doc.AsNullableString("ApiKeyEncrypted"), config);
    // 与「测试连接」同一道门：解不开密钥就别裸奔发请求，拉回来的清单会让人误以为这条上游是通的
    if (!string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted")) && !keyResult.Success)
        return Json(ApiEnvelope<UpstreamModelsData>.Fail(
            "KEY_UNREADABLE",
            "这个 Provider 存着密钥，但当前服务解不开它，请先用「更新密钥」重新填一次"), jsonOptions, 409);

    string body;
    try
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, probeUrl);
        if (keyResult.Success && keyResult.PlainText.Length > 0)
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {keyResult.PlainText}");
        // 与「测试连接」同款：外部租户强制内网校验，整条请求（含读 body）共用一个 15 秒预算
        req.Options.Set(blockPrivateProbeTargets, TenantAccess.GetRequired(http).TenantId != internalTenantId);
        using var discoveryCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var resp = await upstreamProbeHttp.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, discoveryCts.Token);
        if (!resp.IsSuccessStatusCode)
            return Json(ApiEnvelope<UpstreamModelsData>.Fail("UPSTREAM_" + (int)resp.StatusCode,
                $"上游返回 HTTP {(int)resp.StatusCode}，先点「测试连接」看具体原因"), jsonOptions, 502);
        body = await ReadUpstreamBodyAsync(resp, MaxUpstreamBodyBytes, discoveryCts.Token);
    }
    catch (TaskCanceledException)
    {
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("TIMEOUT", "拉取模型清单超时（15 秒）"), jsonOptions, 504);
    }
    catch (HttpRequestException ex)
    {
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("NETWORK", $"连不上上游：{ex.Message}"), jsonOptions, 502);
    }
    catch (InvalidOperationException ex)
    {
        // 响应体超限：如实告诉用户地址多半指错了，而不是让它冒充一个 500
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("UPSTREAM_TOO_LARGE", ex.Message), jsonOptions, 502);
    }

    System.Text.Json.Nodes.JsonArray? dataArray;
    try
    {
        // 先转 JsonObject 再索引：根节点是数组或标量时（上游直接回一个 [] 、或回个字符串），
        // node["data"] 抛的是 InvalidOperationException 而不是 JsonException，会穿过下面这个 catch
        // 变成 500。转型失败得到 null，正好落进后面的「没有 data 数组」分支，报 UPSTREAM_SHAPE。
        var root = System.Text.Json.Nodes.JsonNode.Parse(body) as System.Text.Json.Nodes.JsonObject;
        dataArray = root?["data"] as System.Text.Json.Nodes.JsonArray;
    }
    catch (System.Text.Json.JsonException)
    {
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("UPSTREAM_SHAPE", "上游返回的不是合法 JSON"), jsonOptions, 502);
    }
    if (dataArray is null)
        return Json(ApiEnvelope<UpstreamModelsData>.Fail("UPSTREAM_SHAPE",
            "上游返回里没有 data 数组，这个地址可能不是 OpenAI 兼容的模型列表接口"), jsonOptions, 502);

    var existing = (await gwModels.Find(TenantAccess.Filter(http, fb.Eq("PlatformId", id))).ToListAsync())
        .Select(m => m.AsNullableString("ModelName") ?? string.Empty)
        .Where(x => x.Length > 0)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    // 8MB 的字节上限管不住**条目数**：几十万个 {"id":"x"} 这样的小对象照样塞得进那个预算，
    // 而下面这个循环会把每一条都物化成对象、再排序、再序列化，前端还要不做虚拟化地全渲染一遍——
    // 一次「查看模型」就能吃掉可观的共享内存并把用户浏览器冻住。限量必须按条目再来一道。
    //
    // 截断不静默：真发生时如实告诉用户「上游给了 N 个，只展示前 M 个」，
    // 而不是让他以为这就是全部（no silent caps）。
    var truncatedFrom = dataArray.Count > MaxDiscoveredModels ? dataArray.Count : (int?)null;

    var items = new List<UpstreamModelItem>();
    foreach (var node in dataArray.Take(MaxDiscoveredModels))
    {
        if (node is not System.Text.Json.Nodes.JsonObject obj) continue;
        var modelId = (obj["id"] as System.Text.Json.Nodes.JsonValue)?.ToString();
        if (string.IsNullOrWhiteSpace(modelId)) continue;
        var pricing = ProviderPresets.ReadPricing(obj);
        items.Add(new UpstreamModelItem
        {
            ModelId = modelId,
            DisplayName = (obj["name"] as System.Text.Json.Nodes.JsonValue)?.ToString(),
            InferredCapabilities = ProviderPresets.InferCapabilities(modelId).ToList(),
            InputPricePerMillion = pricing?.InputPricePerMillion,
            OutputPricePerMillion = pricing?.OutputPricePerMillion,
            PricePerCall = pricing?.PricePerCall,
            PriceCurrency = pricing?.Currency,
            PriceSource = pricing is null ? null : "upstream",
            AlreadyImported = existing.Contains(modelId),
        });
    }

    var data = new UpstreamModelsData
    {
        ProbedUrl = probeUrl,
        Total = items.Count,
        AlreadyImportedCount = items.Count(x => x.AlreadyImported),
        PricingProvided = items.Any(x => x.PriceSource is not null),
        TruncatedFromTotal = truncatedFrom,
        FetchedAt = DateTime.UtcNow,
        Items = items.OrderBy(x => x.ModelId, StringComparer.OrdinalIgnoreCase).ToList(),
    };
    return Json(ApiEnvelope<UpstreamModelsData>.Ok(data), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 批量导入选中的上游模型。已存在的同名模型跳过而不是覆盖——导入是补齐动作，
// 不该悄悄改掉用户手工调过的用途或价格。
app.MapPost("/gw/platforms/{id}/models/import", async (HttpContext http, string id, [FromBody] ImportUpstreamModelsRequest? body) =>
{
    var entries = body?.Models?.Where(m => !string.IsNullOrWhiteSpace(m.ModelId)).ToList() ?? new List<ImportUpstreamModelEntry>();
    if (entries.Count == 0)
        return Json(ApiEnvelope<ImportUpstreamModelsResult>.Fail("INVALID_INPUT", "没有选中任何模型"), jsonOptions, 400);
    if (entries.Count > MaxImportBatch)
        return Json(ApiEnvelope<ImportUpstreamModelsResult>.Fail("TOO_MANY",
            $"一次最多导入 {MaxImportBatch} 个模型，请分批"), jsonOptions, 400);

    var fb = Builders<BsonDocument>.Filter;
    var platform = await gwPlatforms.Find(TenantAccess.Filter(http, fb.Eq("_id", id))).FirstOrDefaultAsync();
    if (platform is null)
        return Json(ApiEnvelope<ImportUpstreamModelsResult>.Fail("NOT_FOUND", "Provider 不存在或不属于当前租户"), jsonOptions, 404);

    // 与单模型端点（POST /gw/models）保持一致：停用的 Provider 不许加模型。
    // 不拦的话会走进一个静默坑：模型文档建出来了，但 EnsureGatewayModelPoolTypesAsync
    // 会把「Provider 已停用」的模型排除在池同步之外**且不抛异常**，于是 PoolSyncFailed 仍是 false、
    // 请求报成功，而这批模型对池路由根本不可见；重新启用 Provider 也不会补跑同步。
    if (platform.AsNullableBool("Enabled") == false)
        return Json(ApiEnvelope<ImportUpstreamModelsResult>.Fail(
            "PLATFORM_DISABLED", "Provider 已停用，请先启用后再导入模型"), jsonOptions, 409);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var existing = (await gwModels.Find(TenantAccess.Filter(http, fb.Eq("PlatformId", id))).ToListAsync())
        .Select(m => m.AsNullableString("ModelName") ?? string.Empty)
        .Where(x => x.Length > 0)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    var result = new ImportUpstreamModelsResult { Requested = entries.Count };
    var now = DateTime.UtcNow;
    foreach (var entry in entries)
    {
        var modelId = entry.ModelId!.Trim();
        if (existing.Contains(modelId))
        {
            result.Skipped++;
            result.SkippedModelIds.Add(modelId);
            continue;
        }

        // 这条端点不走 TryNormalizeModel（那是给单模型表单用的），但**校验口径必须同源**，
        // 否则直连调用或旧版前端能把任意用途名、负价格、超长标识塞进来：
        // 用途会被池同步当成合法类型参与路由，负价格会进成本核算。
        // 判定函数收在 GatewayConfigurationProvisioning，两条入库路径共用一份，防漂移。
        if (modelId.Length > GatewayConfigurationProvisioning.MaxModelNameLength)
        {
            result.Skipped++;
            result.SkippedModelIds.Add(modelId);
            continue;
        }

        var caps = (entry.Capabilities ?? ProviderPresets.InferCapabilities(modelId).ToList())
            // 注意校验的是**存储层能力名**（image_generation / video_generation ...），
            // 不是用途名（generation / video-gen ...）——InferCapabilities 产出的就是前者。
            // 用错词汇表会把生图与视频模型的用途整批静默丢掉。
            .Where(c => GatewayConfigurationProvisioning.IsSupportedCapabilityCode(c))
            .Select(c => c.Trim().ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .ToList();

        if (!GatewayConfigurationProvisioning.IsValidPrice(entry.InputPricePerMillion)
            || !GatewayConfigurationProvisioning.IsValidPrice(entry.OutputPricePerMillion)
            || !GatewayConfigurationProvisioning.IsValidPrice(entry.PricePerCall)
            || !GatewayConfigurationProvisioning.IsSupportedCurrency(entry.PriceCurrency))
        {
            return Json(ApiEnvelope<ImportUpstreamModelsResult>.Fail(
                "INVALID_INPUT", $"模型「{modelId}」的价格或币种不合法（价格不能为负，币种只支持 CNY / USD）"), jsonOptions, 400);
        }

        var doc = new BsonDocument
        {
            { "_id", $"gw-model-{Guid.NewGuid():N}" },
            { "TenantId", tenantId },
            { "PlatformId", id },
            { "ModelName", modelId },
            // 唯一索引 uniq_llmgw_model_tenant_platform_name_normalized 带
            // PartialFilterExpression：只覆盖 ModelNameNormalized 是字符串的文档。
            // 不写这个字段 = 这批模型不参与唯一约束，两个并发导入各自算出同一份 existing 快照后
            // 双双插入，同名模型就重复了。口径与 TryNormalizeModel 一致（ToLowerInvariant）。
            { "ModelNameNormalized", modelId.ToLowerInvariant() },
            { "Name", modelId },
            { "Enabled", true },
            { "Priority", 100 },
            { "Authority", "llm_gateway" },
            { "SourceCollection", "llmgw_models" },
            { "CreatedAt", now },
            { "UpdatedAt", now },
            { "Capabilities", new BsonArray(caps.Select(c => new BsonDocument
                {
                    { "Type", c },
                    // source=inferred 让界面能区分「系统推断的」和「用户勾的」，
                    // 对应 minimal-user-input.md 的第 3 条：自动填的值必须可见可改。
                    { "Source", "inferred" },
                    { "Value", true },
                })) },
        };
        if (entry.InputPricePerMillion is not null) doc["InputPricePerMillion"] = entry.InputPricePerMillion.Value;
        if (entry.OutputPricePerMillion is not null) doc["OutputPricePerMillion"] = entry.OutputPricePerMillion.Value;
        if (entry.PricePerCall is not null) doc["PricePerCall"] = entry.PricePerCall.Value;
        if (!string.IsNullOrWhiteSpace(entry.PriceCurrency)) doc["PriceCurrency"] = entry.PriceCurrency;

        try
        {
            await gwModels.InsertOneAsync(doc);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 并发导入撞上唯一索引：对方已经建好了，按「已存在」计，不算失败
            result.Skipped++;
            result.SkippedModelIds.Add(modelId);
            existing.Add(modelId);
            continue;
        }
        existing.Add(modelId);
        result.Created++;
        result.CreatedModelIds.Add(modelId);
    }

    // 导入完必须把新模型同步进托管默认池——单模型端点（POST /gw/models）一直这么做。
    // 漏掉的话，批量导入的模型只是躺在 llmgw_models 里，不进任何池，正常池路由压根选不到它们：
    // 用户点完「导入 N 个」看到成功提示，业务侧却依旧调不通（predicate-and-wiring-discipline 形状 2）。
    //
    // 与单模型端点的差别：那边同步失败会把刚插入的那一条删掉再报错；这里是批量，
    // 已插入的模型本身是有效配置（用户可以手动加进池），全删掉反而更糟。
    // 所以如实降级——照常返回创建结果，但把「池没同步上、去哪补」写进响应，不谎报全绿。
    // 条件是「这次请求点名的模型现在都在库里」，不是「这次新建了几个」。
    // 写成 Created > 0 的后果我自己的失败文案就踩了：同步失败时我们刻意保留已插入的模型，
    // 并告诉用户「稍后重试导入」——可重试时那些模型全部命中 Skipped、Created 归零，
    // 这个块直接被跳过，池成员永远补不回来。又是一句用户照做也没用的话。
    if (result.Created > 0 || result.Skipped > 0)
    {
        try
        {
            await EnsureGatewayModelPoolTypesAsync(
                gwModelPoolTypes, gwModelPools, gwModels, gwPlatforms,
                models, platforms, tenantId, internalTenantId, appendModels: true);
        }
        catch
        {
            result.PoolSyncFailed = true;
            result.Message = "模型已导入，但默认模型池同步失败，这批模型暂时不会被池路由选中；可在「模型池」页面手动补齐或稍后重试导入。";
        }
    }

    await WriteOperationAuditAsync(
        operationAudits, http,
        action: "platform.models.import",
        targetType: "llmgw_platform",
        targetId: id,
        targetName: platform.GetStringOrEmpty("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "requested", result.Requested },
            { "created", result.Created },
            { "skipped", result.Skipped },
        });

    return Json(ApiEnvelope<ImportUpstreamModelsResult>.Ok(result), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

// 创建模型：Provider 必须属于当前租户；缺少模型 key 时继承 Provider key。
// 创建成功后只调用现有默认池注册表做 append-only 补齐：匹配则追加，不匹配则保持不变。
app.MapPost("/gw/models", async (HttpContext http, [FromBody] CreateModelRequest? body) =>
{
    if (!GatewayConfigurationProvisioning.TryNormalizeModel(body, out var draft, out var error) || draft is null)
        return Json(ApiEnvelope<CreateModelResult>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var fb = Builders<BsonDocument>.Filter;
    var platformFilter = TenantAccess.Filter(http, fb.Eq("_id", draft.PlatformId));
    var platform = await gwPlatforms.Find(platformFilter).FirstOrDefaultAsync();
    if (platform is null)
        return Json(ApiEnvelope<CreateModelResult>.Fail("PLATFORM_NOT_FOUND", "Provider 不存在或不属于当前租户"), jsonOptions, 404);
    if (platform.AsNullableBool("Enabled") == false)
        return Json(ApiEnvelope<CreateModelResult>.Fail("PLATFORM_DISABLED", "Provider 已停用，请先启用后再添加模型"), jsonOptions, 409);

    var duplicateFilter = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Eq("PlatformId", draft.PlatformId),
        fb.Or(
            fb.Eq("ModelNameNormalized", draft.ModelNameNormalized),
            fb.Regex("ModelName", new BsonRegularExpression($"^{System.Text.RegularExpressions.Regex.Escape(draft.ModelName)}$", "i"))));
    if (await gwModels.Find(duplicateFilter).AnyAsync())
        return Json(ApiEnvelope<CreateModelResult>.Fail("DUPLICATE_MODEL", "当前 Provider 已存在相同上游模型"), jsonOptions, 409);

    string? encryptedApiKey = null;
    if (!string.IsNullOrWhiteSpace(draft.ApiKey))
    {
        try
        {
            encryptedApiKey = GwApiKeyCrypto.Encrypt(draft.ApiKey, config);
        }
        catch (InvalidOperationException ex)
        {
            return Json(ApiEnvelope<CreateModelResult>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
        }
    }

    var id = $"gw-model-{Guid.NewGuid():N}";
    var now = DateTime.UtcNow;
    var document = GatewayConfigurationProvisioning.BuildModelDocument(draft, tenantId, id, encryptedApiKey, now);
    try
    {
        await gwModels.InsertOneAsync(document);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<CreateModelResult>.Fail("DUPLICATE_MODEL", "当前 Provider 已存在相同上游模型"), jsonOptions, 409);
    }

    (int TypesCreated, int PoolsCreated, int ModelsAppended) ensured;
    try
    {
        ensured = await EnsureGatewayModelPoolTypesAsync(
            gwModelPoolTypes,
            gwModelPools,
            gwModels,
            gwPlatforms,
            models,
            platforms,
            tenantId,
            internalTenantId,
            appendModels: true);
    }
    catch
    {
        await gwModels.DeleteOneAsync(fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", id)));
        return Json(ApiEnvelope<CreateModelResult>.Fail("MODEL_POOL_SYNC_FAILED", "默认模型池同步失败，模型未保存，请稍后重试"), jsonOptions, 500);
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.create",
        targetType: "llmgw_model",
        targetId: id,
        targetName: draft.Name,
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "platformId", draft.PlatformId },
            { "modelName", draft.ModelName },
            { "protocol", ToBsonAuditValue(draft.Protocol) },
            { "capabilities", new BsonArray(draft.Capabilities) },
            { "imageSizeControlMode", draft.ImageSizeControlMode },
            { "imageSizeFieldFormat", ToBsonAuditValue(draft.ImageSizeFieldFormat) },
            { "priceCurrency", ToBsonAuditValue(draft.PriceCurrency) },
            { "hasDedicatedKey", encryptedApiKey is not null },
            { "modelsAppended", ensured.ModelsAppended },
        });
    return Json(ApiEnvelope<CreateModelResult>.Ok(new CreateModelResult
    {
        Item = MapModel(document),
        PoolTypesCreated = ensured.TypesCreated,
        PoolsCreated = ensured.PoolsCreated,
        ModelsAppended = ensured.ModelsAppended,
    }), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

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
    if (enabled && targetAuthority == "llm_gateway")
    {
        var proposed = new BsonDocument(doc) { ["Enabled"] = true };
        var contractError = await ValidateAsrPlatformMutationAsync(
            http, proposed, gwModels, gwModelOfferings, gwLogicalModels);
        if (contractError is not null)
            return Json(ApiEnvelope<PlatformItem>.Fail(
                AsrOfferingContractPolicy.ErrorCode,
                contractError), jsonOptions, 409);
    }
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
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh, config, revealFingerprint: true)), jsonOptions);
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
    if (enabled && targetAuthority == "llm_gateway")
    {
        var proposed = new BsonDocument(doc) { ["Enabled"] = true };
        var contractError = await ValidateAsrModelMutationAsync(
            http, proposed, gwPlatforms, gwModelOfferings, gwLogicalModels);
        if (contractError is not null)
            return Json(ApiEnvelope<ModelItem>.Fail(
                AsrOfferingContractPolicy.ErrorCode,
                contractError), jsonOptions, 409);
    }
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

// 上游生图模型尺寸能力：能力跟随实际模型，逻辑模型和业务端不得按模型名猜测。
app.MapPut("/gw/models/{id}/image-size-control", async (
    HttpContext http,
    string id,
    [FromBody] UpdateModelImageSizeControlRequest? body) =>
{
    if (body is null)
        return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "缺少图片尺寸控制配置"), jsonOptions, 400);
    if (!GatewayConfigurationProvisioning.TryNormalizeImageSizeControl(
            body.Mode, body.FieldFormat, out var mode, out var fieldFormat, out var error))
        return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModels.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<ModelItem>.Fail("NOT_GW_AUTHORITY", "请先将模型导入平台，再维护上游尺寸能力"), jsonOptions, 409);

    var currentCaps = doc.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray
        ? cv.AsBsonArray.Where(x => x.IsBsonDocument).Select(x => new BsonDocument(x.AsBsonDocument)).ToList()
        : new List<BsonDocument>();
    var isImageGeneration = doc.AsNullableBool("IsImageGen") == true
                            || GatewayConfigurationProvisioning.HasEnabledCapability(
                                currentCaps,
                                "image_generation",
                                "text_to_image",
                                "image");
    if (mode != "inherit" && !isImageGeneration)
        return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "只有图片生成模型可以配置图片尺寸控制能力"), jsonOptions, 400);

    var before = MapImageSizeControl(currentCaps);
    var nextCaps = currentCaps
        .Where(x => !GatewayConfigurationProvisioning.IsImageSizeControlCapability(x.AsNullableString("Type")))
        .ToList();
    nextCaps.AddRange(GatewayConfigurationProvisioning.BuildImageSizeCapabilityDocuments(mode, fieldFormat));
    await gwModels.UpdateOneAsync(filter, Builders<BsonDocument>.Update
        .Set("Capabilities", new BsonArray(nextCaps))
        .Set("UpdatedAt", DateTime.UtcNow));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.update_image_size_control",
        targetType: "llmgw_model",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "mode", new BsonDocument { { "from", before.Mode }, { "to", mode } } },
            { "fieldFormat", new BsonDocument { { "from", ToBsonAuditValue(before.FieldFormat) }, { "to", ToBsonAuditValue(fieldFormat) } } },
            { "authority", "llm_gateway" },
        });
    var fresh = await gwModels.Find(filter).FirstOrDefaultAsync();
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

    var platformContractError = await ValidateAsrPlatformMutationAsync(
        http, claimed, gwModels, gwModelOfferings, gwLogicalModels);
    if (platformContractError is not null)
        return Json(ApiEnvelope<PlatformItem>.Fail(
            AsrOfferingContractPolicy.ErrorCode,
            platformContractError), jsonOptions, 409);

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
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh, config, revealFingerprint: true)), jsonOptions);
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
    var resetOfferingCount = await ResetOfferingsAfterCredentialChangeAsync(
        http, "platform", [id], gwModels, gwModelOfferings);
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
            { "offeringsReset", resetOfferingCount },
        });
    var fresh = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh, config, revealFingerprint: true)), jsonOptions);
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
    var resetOfferingCount = await ResetOfferingsAfterCredentialChangeAsync(
        http, "platform", [id], gwModels, gwModelOfferings);
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
            { "offeringsReset", resetOfferingCount },
        });
    var fresh = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(fresh, config, revealFingerprint: true)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 编辑上游：名称 / 类型 / 地址 / 并发 / 备注。密钥不在这里改——它走独立的轮换端点，
// 混在一起会让「改个备注」也要求重填密钥，或者让密钥被一次误提交清空。
app.MapPut("/gw/platforms/{id}", async (HttpContext http, string id, [FromBody] UpdatePlatformRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<PlatformItem>.Fail("NOT_GW_AUTHORITY", "只能编辑已认领到 GW 的平台；MAP 来源平台请先认领"), jsonOptions, 409);

    var updates = new List<UpdateDefinition<BsonDocument>>();
    var changes = new BsonDocument();

    if (body.Name is not null)
    {
        var name = body.Name.Trim();
        if (name.Length == 0) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "平台名称不能为空"), jsonOptions, 400);
        if (name.Length > 120) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "平台名称长度超出限制"), jsonOptions, 400);
        // 唯一索引建在 (TenantId, NameNormalized) 上，重名判定也读它。只改 Name 会让两者分家：
        // 列表显示新名字，重名判定与索引仍按旧名走，下次改名/新建才炸，报的还是索引冲突而不是「重名」。
        // 归一口径必须与创建路径一致（GatewayConfigurationProvisioning：Trim + ToLowerInvariant）。
        var normalized = name.ToLowerInvariant();
        var tenantIdForName = TenantAccess.GetRequired(http).TenantId;
        var nfb = Builders<BsonDocument>.Filter;
        var duplicateName = nfb.And(
            nfb.Eq("TenantId", tenantIdForName),
            nfb.Ne("_id", id),
            nfb.Or(
                nfb.Eq("NameNormalized", normalized),
                nfb.Regex("Name", new BsonRegularExpression($"^{System.Text.RegularExpressions.Regex.Escape(name)}$", "i"))));
        if (await gwPlatforms.Find(duplicateName).AnyAsync())
            return Json(ApiEnvelope<PlatformItem>.Fail("DUPLICATE_PLATFORM", "当前租户已存在同名 Provider"), jsonOptions, 409);
        updates.Add(Builders<BsonDocument>.Update.Set("Name", name));
        updates.Add(Builders<BsonDocument>.Update.Set("NameNormalized", normalized));
        changes.Add("name", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableString("Name")) }, { "to", name } });
    }
    if (body.PlatformType is not null)
    {
        var type = body.PlatformType.Trim().ToLowerInvariant();
        if (type is not ("openai" or "claude"))
            return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "接口类型只支持 openai 或 claude"), jsonOptions, 400);

        // 改类型等于改这条上游名下「继承协议」那批模型的报文协议——与合并端点挡的是同一件事：
        // 模型的 Protocol 允许为空表示继承所属上游（运行时
        // `string.IsNullOrWhiteSpace(Protocol) ? PlatformType : Protocol`），
        // 所以把 openai 改成 claude，这批本来能用的模型之后全按错协议发出去。
        // 判据只挡真正会被牵连的那部分：类型确实变了、且确实有模型在继承。
        // 空上游、或名下模型都显式写了 Protocol 的，改类型无人受影响，照常放行。
        var currentType = (doc.AsNullableString("PlatformType") ?? string.Empty).Trim().ToLowerInvariant();
        if (!string.Equals(currentType, type, StringComparison.Ordinal))
        {
            var pfb = Builders<BsonDocument>.Filter;
            var noProtocol = pfb.Or(
                pfb.Exists("Protocol", false),
                pfb.Eq("Protocol", BsonNull.Value),
                pfb.Eq("Protocol", ""));
            var inheritingFilter = TenantAccess.Filter(http, pfb.And(pfb.Eq("PlatformId", id), noProtocol));

            // 判据取的模型集合必须与**路由能解析到的**那一套一致，否则守卫看不见的那部分照样被换协议。
            // 认领自 MAP 的平台，名下模型可能还只存在于 MAP 的 models 集合里：池成员端点
            // （`gwModels.Find(...) ?? (内部租户 ? models.Find(...) : null)`）会回退过去，
            // ModelResolver 再把这条 MAP 模型和 GW 平台凑成一对——Protocol 为空一样继承本平台的类型。
            // 只数 gwModels 就是形状 1（判据比它该管的范围窄）：换个存放位置就漏。
            // _id 同时存在于两边时以 GW 为准（认领是把同一个 _id 复制过来），所以 MAP 侧要排掉被遮住的。
            var gwInheriting = await gwModels.Find(inheritingFilter).ToListAsync();
            var mapInheriting = new List<BsonDocument>();
            if (TenantAccess.GetRequired(http).TenantId == internalTenantId)
            {
                var gwIdsUnderPlatform = (await gwModels
                        .Find(TenantAccess.Filter(http, pfb.Eq("PlatformId", id)))
                        .Project(Builders<BsonDocument>.Projection.Include("_id"))
                        .ToListAsync())
                    .Select(m => m.GetStringOrEmpty("_id"))
                    .ToHashSet(StringComparer.Ordinal);
                mapInheriting = (await models.Find(pfb.And(pfb.Eq("PlatformId", id), noProtocol)).ToListAsync())
                    .Where(m => !gwIdsUnderPlatform.Contains(m.GetStringOrEmpty("_id")))
                    .ToList();
            }

            // 报的条数必须是真实条数：先合出全量，名字另取前几个用于提示。
            // 拿「截断后的列表长度」当条数会把 50 个说成 5 个，用户照着改完还是被挡。
            var inheritingCount = gwInheriting.Count + mapInheriting.Count;
            if (inheritingCount > 0)
            {
                var names = gwInheriting.Concat(mapInheriting)
                    .Take(5)
                    .Select(m => m.AsNullableString("ModelName") ?? m.AsNullableString("Name") ?? m.GetStringOrEmpty("_id"))
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .ToList();
                return Json(
                    ApiEnvelope<PlatformItem>.Fail(
                        "PLATFORM_TYPE_LOCKED",
                        $"这条上游下有 {inheritingCount} 个模型没写协议、跟着上游走，改类型会把它们的报文协议一起换掉"
                        + $"（{string.Join("、", names)}{(inheritingCount > names.Count ? " 等" : "")}）。"
                        + "先给这些模型显式写上协议，再改上游类型。"),
                    jsonOptions,
                    409);
            }
        }

        // 类型没变时照旧原样写回（等值写入无副作用），免得「打开表单没改类型直接保存」
        // 从原来的成功变成「没有需要修改的字段」——这条判据只该挡危险的类型迁移，不该改别的行为。
        updates.Add(Builders<BsonDocument>.Update.Set("PlatformType", type));
        changes.Add("platformType", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableString("PlatformType")) }, { "to", type } });
    }
    if (body.ApiUrl is not null)
    {
        var url = body.ApiUrl.Trim();
        // 地址写错 = 这条上游整条哑掉，且报错发生在运行时。所以这里当场挡住明显不成立的写法。
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)
            || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps))
            return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "API 地址必须是 http/https 绝对地址"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("ApiUrl", url));
        changes.Add("apiUrl", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableString("ApiUrl")) }, { "to", url } });
    }
    if (body.MaxConcurrency is int concurrency)
    {
        if (concurrency is < 0 or > 10000)
            return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "并发必须在 0 到 10000 之间"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("MaxConcurrency", concurrency));
        changes.Add("maxConcurrency", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableInt("MaxConcurrency")) }, { "to", concurrency } });
    }
    if (body.Remark is not null)
    {
        var remark = body.Remark.Trim();
        if (remark.Length > 500) return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "备注长度超出限制"), jsonOptions, 400);
        updates.Add(Builders<BsonDocument>.Update.Set("Remark", remark));
        changes.Add("remark", new BsonDocument { { "from", ToBsonAuditValue(doc.AsNullableString("Remark")) }, { "to", remark } });
    }

    if (updates.Count == 0)
        return Json(ApiEnvelope<PlatformItem>.Fail("INVALID_INPUT", "没有需要修改的字段"), jsonOptions, 400);

    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
    try
    {
        await gwPlatforms.UpdateOneAsync(filter, Builders<BsonDocument>.Update.Combine(updates));
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        // 上面的重名预检和这次写入之间有窗口：两个请求同时把不同上游改成同一个名字时，
        // 双方都能过预检，最后由 (TenantId, NameNormalized) 唯一索引挡下一个。
        // 不接住就成 500，而这条链路对外承诺的是 409 DUPLICATE_PLATFORM——
        // 索引才是重名的最终判据，预检只是提前告知，两者必须报同一件事。
        return Json(ApiEnvelope<PlatformItem>.Fail("DUPLICATE_PLATFORM", "当前租户已存在同名 Provider"), jsonOptions, 409);
    }
    changes.Add("authority", "llm_gateway");
    await WriteOperationAuditAsync(
        operationAudits, http,
        action: "platform.update", targetType: "llmgw_platform", targetId: id,
        targetName: doc.AsNullableString("Name"), success: true, reason: null, changes: changes);
    var updated = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    return Json(ApiEnvelope<PlatformItem>.Ok(MapPlatform(updated, config, revealFingerprint: true)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 删除上游平台：只删 GW 权威的，且必须先确认没人引用。
//
// 为什么一定要挡引用：池成员是按 (modelId, platformId) 定位的，平台删了成员还在，
// 池子看起来正常、实际解析不到上游——这类静默损坏最难查（本仓库刚为同类问题排查过一整轮）。
// 所以宁可拒绝并列清单，让运维先把引用摘干净，也不做级联删除。
app.MapDelete("/gw/platforms/{id}", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwPlatforms.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<PlatformDeleteBlockers>.Fail("NOT_GW_AUTHORITY", "只能删除已认领到 GW 的平台；MAP 来源平台请先认领"), jsonOptions, 409);

    var blockers = await CollectPlatformDeleteBlockersAsync(http, id, gwModels, models, gwModelPools, modelGroups, internalTenantId);
    if (blockers.TotalCount > 0)
    {
        var parts = new List<string>();
        if (blockers.Models.Count > 0) parts.Add($"模型 {blockers.Models.Count} 个（{string.Join("、", blockers.Models.Take(5))}{(blockers.Models.Count > 5 ? " 等" : "")}）");
        if (blockers.Pools.Count > 0) parts.Add($"模型池 {blockers.Pools.Count} 个（{string.Join("、", blockers.Pools.Take(5))}{(blockers.Pools.Count > 5 ? " 等" : "")}）");
        return Json(
            ApiEnvelope<PlatformDeleteBlockers>.Fail(
                "PLATFORM_IN_USE",
                $"还有 {string.Join("；", parts)} 在用这条上游，先把它们改绑或删掉再删平台",
                blockers),
            jsonOptions,
            409);
    }

    await gwPlatforms.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "platform.delete",
        targetType: "llmgw_platform",
        targetId: id,
        targetName: doc.AsNullableString("Name"),
        success: true,
        reason: null,
        // 删掉之后文档就没了，快照留在审计里，方便事后核对删的是不是这一条
        changes: new BsonDocument
        {
            { "name", ToBsonAuditValue(doc.AsNullableString("Name")) },
            { "apiUrl", ToBsonAuditValue(doc.AsNullableString("ApiUrl")) },
            { "platformType", ToBsonAuditValue(doc.AsNullableString("PlatformType")) },
            { "hadKey", !string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted")) },
            { "authority", "llm_gateway" },
        });
    return Json(ApiEnvelope<PlatformDeleteBlockers>.Ok(new PlatformDeleteBlockers()), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 删除模型：同样先查引用。模型能建不能删，是「垃圾越攒越多」在平台下一层的同一个洞——
// 而且平台删除要求先清模型引用，没有这个端点，那条路径根本走不通。
app.MapDelete("/gw/models/{id}", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModels.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<ModelDeleteBlockers>.Fail("NOT_GW_AUTHORITY", "只能删除已认领到 GW 的模型；MAP 来源模型请先认领"), jsonOptions, 409);

    var blockers = await CollectModelDeleteBlockersAsync(
        http, doc, gwModelPools, modelGroups, gwModelOfferings, gwLogicalModels, internalTenantId);
    if (blockers.TotalCount > 0)
    {
        var parts = new List<string>();
        if (blockers.Pools.Count > 0)
            parts.Add($"模型池 {blockers.Pools.Count} 个（{string.Join("、", blockers.Pools.Take(5))}{(blockers.Pools.Count > 5 ? " 等" : "")}）把它当成员");
        if (blockers.LogicalModels.Count > 0)
            parts.Add($"逻辑模型 {blockers.LogicalModels.Count} 个（{string.Join("、", blockers.LogicalModels.Take(5))}{(blockers.LogicalModels.Count > 5 ? " 等" : "")}）把它当 offering 上游");
        return Json(
            ApiEnvelope<ModelDeleteBlockers>.Fail(
                "MODEL_IN_USE",
                $"还有 {string.Join("；", parts)}，先把这些引用摘掉再删",
                blockers),
            jsonOptions,
            409);
    }

    await gwModels.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.delete",
        targetType: "llmgw_model",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "modelName", ToBsonAuditValue(doc.AsNullableString("ModelName")) },
            { "platformId", ToBsonAuditValue(doc.AsNullableString("PlatformId")) },
            { "authority", "llm_gateway" },
        });
    return Json(ApiEnvelope<ModelDeleteBlockers>.Ok(new ModelDeleteBlockers()), jsonOptions);
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

    var modelContractError = await ValidateAsrModelMutationAsync(
        http, claimed, gwPlatforms, gwModelOfferings, gwLogicalModels);
    if (modelContractError is not null)
        return Json(ApiEnvelope<ModelItem>.Fail(
            AsrOfferingContractPolicy.ErrorCode,
            modelContractError), jsonOptions, 409);

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
    var resetOfferingCount = await ResetOfferingsAfterCredentialChangeAsync(
        http, "model", [id], gwModels, gwModelOfferings);
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
            { "offeringsReset", resetOfferingCount },
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
    var resetOfferingCount = await ResetOfferingsAfterCredentialChangeAsync(
        http, "model", [id], gwModels, gwModelOfferings);
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
            { "offeringsReset", resetOfferingCount },
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
        if (!GatewayConfigurationProvisioning.TryNormalizeBulkCapabilityType(
                capability.Type, out var type, out var capabilityTypeError))
            return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", capabilityTypeError), jsonOptions, 400);
        var source = string.IsNullOrWhiteSpace(capability.Source) ? "user" : capability.Source.Trim();
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

// 创建 Exchange：外部租户直接写 llm_gateway 自有集合，不再要求先去 MAP 建同名对象。
// tenantId 永远来自服务端会话；通讯密钥只加密落库，不进入响应或审计。
app.MapPost("/gw/exchanges", async (HttpContext http, [FromBody] CreateExchangeRequest? body) =>
{
    if (!GatewayConfigurationProvisioning.TryNormalizeExchange(body, out var draft, out var error) || draft is null)
        return Json(ApiEnvelope<ExchangeItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    if (tenantId != internalTenantId)
    {
        var targetError = await ValidateExternalExchangeTargetAsync(draft.TargetUrl, draft.TransformerType, http.RequestAborted);
        if (targetError is not null)
            return Json(ApiEnvelope<ExchangeItem>.Fail("UNSAFE_TARGET_URL", targetError), jsonOptions, 400);
    }
    var fb = Builders<BsonDocument>.Filter;
    var duplicateFilter = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Or(
            fb.Eq("NameNormalized", draft.NameNormalized),
            fb.Regex("Name", new BsonRegularExpression($"^{System.Text.RegularExpressions.Regex.Escape(draft.Name)}$", "i"))));
    if (await gwModelExchanges.Find(duplicateFilter).AnyAsync())
        return Json(ApiEnvelope<ExchangeItem>.Fail("DUPLICATE_EXCHANGE", "当前租户已存在同名 Exchange"), jsonOptions, 409);

    string encryptedApiKey;
    try
    {
        encryptedApiKey = GwApiKeyCrypto.Encrypt(draft.ApiKey!, config);
    }
    catch (InvalidOperationException ex)
    {
        return Json(ApiEnvelope<ExchangeItem>.Fail("API_KEY_CRYPTO_NOT_READY", ex.Message), jsonOptions, 500);
    }

    var id = $"gw-exchange-{Guid.NewGuid():N}";
    var now = DateTime.UtcNow;
    var document = GatewayConfigurationProvisioning.BuildExchangeDocument(draft, tenantId, id, encryptedApiKey, now);
    string requiredAuditId;
    try
    {
        requiredAuditId = await BeginRequiredOperationAuditAsync(
            operationAudits,
            http,
            action: "exchange.create",
            targetType: "llmgw_model_exchange",
            targetId: id,
            targetName: draft.Name,
            changes: new BsonDocument
            {
                { "modelCount", draft.Models.Count },
                { "modelIds", new BsonArray(draft.Models.Select(item => item.ModelId)) },
                { "targetAuthScheme", draft.TargetAuthScheme },
                { "transformerType", draft.TransformerType },
                { "enabled", draft.Enabled },
                { "hasKey", true },
                { "authority", "llm_gateway" },
            });
    }
    catch
    {
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_AUDIT_FAILED", "无法先建立 Exchange 审计意图，本次未写入配置"), jsonOptions, 503);
    }

    try
    {
        await gwModelExchanges.InsertOneAsync(document);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        await TryCompleteRequiredOperationAuditAsync(operationAudits, tenantId, requiredAuditId, success: false, reason: "duplicate_exchange");
        return Json(ApiEnvelope<ExchangeItem>.Fail("DUPLICATE_EXCHANGE", "当前租户已存在同名 Exchange"), jsonOptions, 409);
    }
    catch
    {
        await TryCompleteRequiredOperationAuditAsync(operationAudits, tenantId, requiredAuditId, success: false, reason: "exchange_write_failed");
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_WRITE_FAILED", "Exchange 写入失败，审计意图已保留"), jsonOptions, 503);
    }

    try
    {
        await CompleteRequiredOperationAuditAsync(operationAudits, tenantId, requiredAuditId, success: true, reason: null);
    }
    catch
    {
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_AUDIT_PENDING", "Exchange 已写入，审计意图仍待收口；请刷新列表并检查审计"), jsonOptions, 503);
    }

    var fresh = await gwModelExchanges.Find(fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", id))).FirstOrDefaultAsync();
    if (fresh is null)
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_READBACK_FAILED", "Exchange 已创建，但服务端读回失败，请刷新列表确认"), jsonOptions, 503);
    return Json(ApiEnvelope<ExchangeItem>.Ok(MapExchange(fresh)), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

// Exchange 映射编辑：完整替换可见映射字段，并用 version 防止旧页面覆盖并发修改。
// 删除交换所。池成员指向它有两种写法（platformId 直接写交换所 id，或写 __exchange__
// 再靠 modelId 匹配别名），两种都要查——只查一种会漏判成「没人用」，把在服务的上游删掉。
app.MapDelete("/gw/exchanges/{id}", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModelExchanges.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<ExchangeDeleteBlockers>.Fail("NOT_GW_AUTHORITY", "只能删除已认领到 GW 的交换所"), jsonOptions, 409);

    var pools = await gwModelPools.Find(TenantAccess.Filter(http)).ToListAsync();
    // 内部租户的池视图里还有一批没被影子化的 MAP 池（/gw/pools 就是这么端出来的），
    // 而运行时解析 __exchange__ 成员时 ModelResolver 优先认 GW 自有交换所——
    // 只扫 GW 池的话，这类 MAP 池会在交换所被删后静默解析不到上游。
    // 删模型 / 删平台早就把 MAP 池一起算进占用清单了，这里对齐同一口径。
    if (TenantAccess.GetRequired(http).TenantId == internalTenantId)
    {
        // 粗筛与下面的判据同口径：能拦住删除的成员，PlatformId 必然是这两个值之一。
        var mapCandidates = Builders<BsonDocument>.Filter.ElemMatch<BsonDocument>(
            "Models",
            Builders<BsonDocument>.Filter.In("PlatformId", new[] { id, "__exchange__" }));
        pools.AddRange(await modelGroups.Find(mapCandidates).ToListAsync());
    }
    var blocking = pools
        .Where(pool => (pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray())
            .Where(x => x.IsBsonDocument)
            .Select(x => x.AsBsonDocument)
            .Any(member =>
            {
                var platformId = member.GetStringOrEmpty("PlatformId");
                if (string.Equals(platformId, id, StringComparison.Ordinal)) return true;
                return string.Equals(platformId, "__exchange__", StringComparison.Ordinal)
                       && GatewayExchangeSupportsModel(doc, member.GetStringOrEmpty("ModelId"));
            }))
        .Select(pool => pool.AsNullableString("Name") ?? pool.GetStringOrEmpty("_id"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.Ordinal)
        .ToList();
    // 池成员之外还有第二类引用：逻辑模型的 offering 直接按 _id 指着交换所（TargetKind=exchange）。
    // 图层能力就是这么装的——只查池会把它整条漏掉，删完 offering 变成指向空气。
    var holders = await CollectOfferingHolderNamesAsync(http, gwModelOfferings, gwLogicalModels, "exchange", id);
    if (blocking.Count > 0 || holders.Count > 0)
    {
        var blockers = new ExchangeDeleteBlockers { Pools = blocking, LogicalModels = holders };
        var parts = new List<string>();
        if (blocking.Count > 0)
            parts.Add($"模型池 {blocking.Count} 个（{string.Join("、", blocking.Take(5))}{(blocking.Count > 5 ? " 等" : "")}）把它当成员");
        if (holders.Count > 0)
            parts.Add($"逻辑模型 {holders.Count} 个（{string.Join("、", holders.Take(5))}{(holders.Count > 5 ? " 等" : "")}）把它当 offering 上游");
        return Json(
            ApiEnvelope<ExchangeDeleteBlockers>.Fail(
                "EXCHANGE_IN_USE",
                $"还有 {string.Join("；", parts)}，先把这些引用摘掉再删",
                blockers),
            jsonOptions, 409);
    }

    await gwModelExchanges.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(
        operationAudits, http,
        action: "exchange.delete", targetType: "llmgw_model_exchange", targetId: id,
        targetName: doc.AsNullableString("Name"), success: true, reason: null,
        changes: new BsonDocument
        {
            { "name", ToBsonAuditValue(doc.AsNullableString("Name")) },
            { "hadKey", !string.IsNullOrEmpty(doc.AsNullableString("ApiKeyEncrypted")) },
        });
    return Json(ApiEnvelope<ExchangeDeleteBlockers>.Ok(new ExchangeDeleteBlockers()), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/exchanges/{id}", async (HttpContext http, string id, [FromBody] UpdateExchangeRequest? body) =>
{
    if (!GatewayConfigurationProvisioning.TryNormalizeExchange(body, out var draft, out var error) || draft is null)
        return Json(ApiEnvelope<ExchangeItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var fb = Builders<BsonDocument>.Filter;
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    if (tenantId != internalTenantId)
    {
        var targetError = await ValidateExternalExchangeTargetAsync(draft.TargetUrl, draft.TransformerType, http.RequestAborted);
        if (targetError is not null)
            return Json(ApiEnvelope<ExchangeItem>.Fail("UNSAFE_TARGET_URL", targetError), jsonOptions, 400);
    }
    var tenantFilter = TenantAccess.Filter(http, fb.Eq("_id", id));
    var document = await gwModelExchanges.Find(tenantFilter).FirstOrDefaultAsync();
    if (document is null)
        return Json(ApiEnvelope<ExchangeItem>.Fail("NOT_FOUND", "Exchange 不存在或不属于当前租户"), jsonOptions, 404);

    var currentVersion = document.AsNullableLong("Version") ?? 0;
    if (draft.Version != currentVersion)
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_CONCURRENTLY_MODIFIED", "Exchange 已被其他操作修改，请刷新后重试"), jsonOptions, 409);

    var duplicateFilter = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Ne("_id", id),
        fb.Or(
            fb.Eq("NameNormalized", draft.NameNormalized),
            fb.Regex("Name", new BsonRegularExpression($"^{System.Text.RegularExpressions.Regex.Escape(draft.Name)}$", "i"))));
    if (await gwModelExchanges.Find(duplicateFilter).AnyAsync())
        return Json(ApiEnvelope<ExchangeItem>.Fail("DUPLICATE_EXCHANGE", "当前租户已存在同名 Exchange"), jsonOptions, 409);

    var versionFilter = document.Contains("Version")
        ? fb.Eq("Version", currentVersion)
        : fb.Exists("Version", false);
    var nextVersion = currentVersion + 1;
    var update = Builders<BsonDocument>.Update
        .Set("Name", draft.Name)
        .Set("NameNormalized", draft.NameNormalized)
        .Set("Models", GatewayConfigurationProvisioning.BuildExchangeModels(draft.Models))
        .Set("TargetUrl", draft.TargetUrl)
        .Set("TargetAuthScheme", draft.TargetAuthScheme)
        .Set("TransformerType", draft.TransformerType)
        .Set("Enabled", draft.Enabled)
        .Set("Description", ToBsonAuditValue(draft.Description))
        .Set("UpdatedAt", DateTime.UtcNow)
        .Set("Version", nextVersion);
    string requiredAuditId;
    try
    {
        requiredAuditId = await BeginRequiredOperationAuditAsync(
            operationAudits,
            http,
            action: "exchange.update",
            targetType: "llmgw_model_exchange",
            targetId: id,
            targetName: draft.Name,
            changes: new BsonDocument
            {
                { "name", new BsonDocument { { "from", ToBsonAuditValue(document.AsNullableString("Name")) }, { "to", draft.Name } } },
                { "modelCount", new BsonDocument { { "from", MapExchange(document).Models.Count }, { "to", draft.Models.Count } } },
                { "modelIds", new BsonDocument { { "from", new BsonArray(MapExchange(document).Models.Select(item => item.ModelId)) }, { "to", new BsonArray(draft.Models.Select(item => item.ModelId)) } } },
                { "targetUrlChanged", !string.Equals(document.AsNullableString("TargetUrl"), draft.TargetUrl, StringComparison.Ordinal) },
                { "targetAuthScheme", new BsonDocument { { "from", ToBsonAuditValue(document.AsNullableString("TargetAuthScheme")) }, { "to", draft.TargetAuthScheme } } },
                { "transformerType", new BsonDocument { { "from", ToBsonAuditValue(document.AsNullableString("TransformerType")) }, { "to", draft.TransformerType } } },
                { "enabled", new BsonDocument { { "from", ToBsonAuditValue(document.AsNullableBool("Enabled")) }, { "to", draft.Enabled } } },
                { "authority", "llm_gateway" },
            });
    }
    catch
    {
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_AUDIT_FAILED", "无法先建立 Exchange 审计意图，本次未修改配置"), jsonOptions, 503);
    }

    UpdateResult updateResult;
    try
    {
        updateResult = await gwModelExchanges.UpdateOneAsync(fb.And(tenantFilter, versionFilter), update);
    }
    catch
    {
        await TryCompleteRequiredOperationAuditAsync(operationAudits, tenantId, requiredAuditId, success: false, reason: "exchange_write_failed");
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_WRITE_FAILED", "Exchange 修改失败，审计意图已保留"), jsonOptions, 503);
    }
    if (updateResult.ModifiedCount != 1)
    {
        await TryCompleteRequiredOperationAuditAsync(operationAudits, tenantId, requiredAuditId, success: false, reason: "version_conflict");
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_CONCURRENTLY_MODIFIED", "Exchange 已被其他操作修改，请刷新后重试"), jsonOptions, 409);
    }

    try
    {
        await CompleteRequiredOperationAuditAsync(operationAudits, tenantId, requiredAuditId, success: true, reason: null);
    }
    catch
    {
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_AUDIT_PENDING", "Exchange 已修改，审计意图仍待收口；请刷新列表并检查审计"), jsonOptions, 503);
    }

    var fresh = await gwModelExchanges.Find(tenantFilter).FirstOrDefaultAsync();
    if (fresh is null)
        return Json(ApiEnvelope<ExchangeItem>.Fail("EXCHANGE_READBACK_FAILED", "Exchange 已更新，但服务端读回失败，请刷新列表确认"), jsonOptions, 503);
    return Json(ApiEnvelope<ExchangeItem>.Ok(MapExchange(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// Exchange 认领：兼容内部租户迁移；外部租户使用上方自助创建 API。
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
    var resetOfferingCount = await ResetOfferingsAfterCredentialChangeAsync(
        http, "exchange", [id], gwModels, gwModelOfferings);
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
            { "offeringsReset", resetOfferingCount },
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
    var resetOfferingCount = await ResetOfferingsAfterCredentialChangeAsync(
        http, "exchange", [id], gwModels, gwModelOfferings);
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
            { "offeringsReset", resetOfferingCount },
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
    var matchedTargets = await targetCollection.Find(targetFilter)
        .Project(Builders<BsonDocument>.Projection.Include("_id"))
        .ToListAsync();
    var matchedTargetIds = matchedTargets.Select(item => item.GetStringOrEmpty("_id")).ToList();
    var matchedCount = matchedTargetIds.Count;
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
    var resetOfferingCount = await ResetOfferingsAfterCredentialChangeAsync(
        http, objectType, matchedTargetIds, gwModels, gwModelOfferings);
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
            { "offeringsReset", resetOfferingCount },
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
    if (body.IsDefaultForType == true)
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "DEFAULT_POINTER_REQUIRED",
            "请先创建特殊模型池并添加可用成员，再使用“设为默认”；默认池只能通过原子默认指针切换。"), jsonOptions, 409);
    }

    var now = DateTime.UtcNow;
    var doc = new BsonDocument
    {
        ["_id"] = Guid.NewGuid().ToString("N"),
        ["TenantId"] = TenantAccess.GetRequired(http).TenantId,
        ["Name"] = name,
        ["Code"] = code,
        ["Priority"] = body.Priority ?? 50,
        ["ModelType"] = modelType,
        ["IsDefaultForType"] = false,
        ["StrategyType"] = body.StrategyType ?? 0,
        ["Models"] = new BsonArray(),
        ["SourceCollection"] = "llmgw_model_pools",
        ["Authority"] = "llm_gateway",
        ["ClaimedAt"] = now,
        ["CreatedAt"] = now,
        ["UpdatedAt"] = now,
        ["Version"] = 1L,
    };
    if (description.Length > 0) doc["Description"] = description;

    await gwModelPools.InsertOneAsync(doc);

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
            { "isDefaultForType", false },
        });

    return Json(ApiEnvelope<PoolItem>.Ok(MapPool(doc)), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

// 模型池属性编辑：只允许写 GW 权威池。MAP 来源池必须先认领，避免把目标权威又写回旧集合。
// 删除模型池。两类阻挡语义不同，所以分开报：
//   - 它是某个类型的当前默认池 → 删了那个类型就没有默认可用，必须先改指别的池
//   - 还有 appCaller 绑着它    → 那些调用方会失去路由目标
app.MapDelete("/gw/pools/{id}", async (HttpContext http, string id) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var doc = await gwModelPools.Find(filter).FirstOrDefaultAsync();
    if (doc is null)
        return Json(ApiEnvelope<PoolDeleteBlockers>.Fail("NOT_GW_AUTHORITY", "只能删除已认领到 GW 的模型池；MAP 来源请先认领"), jsonOptions, 409);

    var blockers = new PoolDeleteBlockers
    {
        IsCurrentDefault = await IsCurrentDefaultPoolAsync(gwModelPoolTypes, doc),
        AppCallers = (await gwAppCallers
                .Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Or(
                    Builders<BsonDocument>.Filter.Eq("ModelPoolId", id),
                    Builders<BsonDocument>.Filter.Eq("DefaultModelPoolId", id),
                    Builders<BsonDocument>.Filter.AnyEq("AllowedModelPoolIds", id))))
                .ToListAsync())
            .Select(d => d.AsNullableString("Code") ?? d.GetStringOrEmpty("_id"))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList(),
    };
    if (blockers.TotalCount > 0)
    {
        var parts = new List<string>();
        if (blockers.IsCurrentDefault) parts.Add($"它还是 {doc.AsNullableString("ModelType")} 类型的当前默认池，先把默认改指别的池");
        if (blockers.AppCallers.Count > 0)
            parts.Add($"还有 {blockers.AppCallers.Count} 个 appCaller 绑着它（{string.Join("、", blockers.AppCallers.Take(5))}{(blockers.AppCallers.Count > 5 ? " 等" : "")}）");
        return Json(ApiEnvelope<PoolDeleteBlockers>.Fail("POOL_IN_USE", string.Join("；", parts), blockers), jsonOptions, 409);
    }

    await gwModelPools.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(
        operationAudits, http,
        action: "pool.delete", targetType: "llmgw_model_pool", targetId: id,
        targetName: doc.AsNullableString("Name"), success: true, reason: null,
        changes: new BsonDocument
        {
            { "name", ToBsonAuditValue(doc.AsNullableString("Name")) },
            { "modelType", ToBsonAuditValue(doc.AsNullableString("ModelType")) },
            { "memberCount", doc.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray.Count : 0 },
            { "authority", "llm_gateway" },
        });
    return Json(ApiEnvelope<PoolDeleteBlockers>.Ok(new PoolDeleteBlockers()), jsonOptions);
}).RequireAuthorization("ConfigWrite");

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
            return Json(ApiEnvelope<PoolItem>.Fail("MAP_POOL_NOT_CLAIMED", "请先将模型池导入为平台配置，再编辑模型池属性"), jsonOptions, 409);
        }
        return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池不存在：{id}"), jsonOptions, 404);
    }
    if (body.IsDefaultForType is not null)
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "DEFAULT_POINTER_REQUIRED",
            "isDefaultForType 不能通过通用编辑修改；请使用“设为默认”进行原子切换。"), jsonOptions, 409);
    }
    if (body.ModelType is not null && await IsCurrentDefaultPoolAsync(gwModelPoolTypes, doc))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "DEFAULT_POOL_TYPE_IMMUTABLE",
            "当前默认池不能修改 modelType；请先将同类型的另一个可用池设为默认。"), jsonOptions, 409);
    }
    var managedAppendOnly = IsManagedAppendOnlyPool(doc);
    if (managedAppendOnly && (body.Code is not null || body.ModelType is not null))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "MANAGED_POOL_IMMUTABLE",
            "平台托管默认池的 code 和 modelType 不可修改；可编辑名称、说明和调度策略。"), jsonOptions, 409);
    }

    var updates = new List<UpdateDefinition<BsonDocument>>();
    var changes = new BsonDocument();
    void AddChange(string field, object? from, object? to) =>
        changes[field] = new BsonDocument { { "from", ToBsonAuditValue(from) }, { "to", ToBsonAuditValue(to) } };

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
    if (updates.Count == 0)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "没有可更新字段"), jsonOptions, 400);
    }

    var now = DateTime.UtcNow;
    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", now));

    var updateResult = await gwModelPools.UpdateOneAsync(
        Builders<BsonDocument>.Filter.And(
            filter,
            PoolVersionGuard(Builders<BsonDocument>.Filter, doc),
            PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, now)),
        Builders<BsonDocument>.Update.Combine(updates.Append(Builders<BsonDocument>.Update.Inc("Version", 1))));
    if (updateResult.ModifiedCount != 1)
        return Json(ApiEnvelope<PoolItem>.Fail("POOL_CONCURRENTLY_MODIFIED", "模型池正在变更，请重试属性编辑。"), jsonOptions, 409);

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
        if (exists is not null && IsManagedAppendOnlyPool(exists))
        {
            skipped++;
            continue;
        }
        if (exists is not null && await IsCurrentDefaultPoolAsync(gwModelPoolTypes, exists))
        {
            skipped++;
            continue;
        }
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
        claimedDoc["Version"] = (exists?.AsNullableLong("Version") ?? 0) + 1;
        if (exists is null)
        {
            await gwModelPools.ReplaceOneAsync(filter, claimedDoc, new ReplaceOptions { IsUpsert = true });
        }
        else
        {
            var replaceResult = await gwModelPools.ReplaceOneAsync(
                Builders<BsonDocument>.Filter.And(
                    filter,
                    PoolVersionGuard(Builders<BsonDocument>.Filter, exists),
                    PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, now)),
                claimedDoc);
            if (replaceResult.ModifiedCount != 1)
            {
                skipped++;
                continue;
            }
        }
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
        if (IsManagedAppendOnlyPool(poolDoc)) continue;
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
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", TenantAccess.GetRequired(http).TenantId),
                Builders<BsonDocument>.Filter.Eq("_id", poolDoc.GetStringOrEmpty("_id"))),
            Builders<BsonDocument>.Update
                .Set("Models", modelsArray)
                .Set("UpdatedAt", now)
                .Inc("Version", 1));
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
    if (pool is null) return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("NOT_GW_AUTHORITY", "请先将模型池导入为平台配置，再批量导入成员"), jsonOptions, 409);
    var managedAppendOnly = IsManagedAppendOnlyPool(pool);
    if (managedAppendOnly && body.OverwriteExisting == true)
    {
        return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail(
            "APPEND_ONLY_POOL",
            "平台托管默认池只允许追加兼容且未存在的模型，不允许覆盖已有成员。"), jsonOptions, 409);
    }

    var capabilityFilter = (body.CapabilityFilter ?? "compatible").Trim().ToLowerInvariant();
    if (managedAppendOnly) capabilityFilter = "compatible";
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
    if (managedAppendOnly || body.EnabledOnly != false) sourceFilters.Add(modelFb.Ne("Enabled", false));
    var sourceFilter = sourceFilters.Count == 0 ? modelFb.Empty : modelFb.And(sourceFilters);
    var tenantSourceFilter = TenantAccess.Filter(http, sourceFilter);
    var gwModelDocs = await gwModels.Find(tenantSourceFilter).ToListAsync();
    var mapModelDocs = TenantAccess.GetRequired(http).TenantId == internalTenantId
        ? await models.Find(sourceFilter).ToListAsync()
        : new List<BsonDocument>();
    var enabledPlatformIds = new HashSet<string>(StringComparer.Ordinal);
    if (managedAppendOnly)
    {
        enabledPlatformIds.UnionWith((await gwPlatforms.Find(TenantAccess.Filter(http, modelFb.Ne("Enabled", false)))
                .Project(Builders<BsonDocument>.Projection.Include("_id"))
                .ToListAsync())
            .Select(platform => platform.GetStringOrEmpty("_id"))
            .Where(id => id.Length > 0));
        if (TenantAccess.GetRequired(http).TenantId == internalTenantId)
        {
            enabledPlatformIds.UnionWith((await platforms.Find(modelFb.Ne("Enabled", false))
                    .Project(Builders<BsonDocument>.Projection.Include("_id"))
                    .ToListAsync())
                .Select(platform => platform.GetStringOrEmpty("_id"))
                .Where(id => id.Length > 0));
        }
    }

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
        .Where(modelDoc => managedAppendOnly
            ? enabledPlatformIds.Contains(modelDoc.GetStringOrEmpty("PlatformId"))
              && GatewayModelPoolTypeRegistry.IsCompatible(modelDoc, poolModelType)
            : DoesModelMatchBulkImportFilter(modelDoc, poolModelType, capabilityFilter))
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
    var appendedMembers = new List<BsonDocument>();
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
        if (existing is null)
        {
            imported++;
            appendedMembers.Add(member);
        }
        else updated++;
    }

    var nextMembers = managedAppendOnly
        ? members.Concat(appendedMembers).ToList()
        : existingByKey.Values
            .OrderBy(m => m.AsNullableInt("Priority") ?? 100000)
            .ThenBy(m => m.GetStringOrEmpty("PlatformId"), StringComparer.Ordinal)
            .ThenBy(m => m.GetStringOrEmpty("ModelId"), StringComparer.Ordinal)
            .ToList();

    if (imported > 0 || updated > 0)
    {
        if (managedAppendOnly)
        {
            imported = 0;
            foreach (var appended in appendedMembers)
            {
                var appendFilter = new BsonDocument
                {
                    { "TenantId", TenantAccess.GetRequired(http).TenantId },
                    { "_id", id },
                    { "ManagedByRegistry", true },
                    { "AppendOnly", true },
                    { "DefaultSwitchPendingUntil", new BsonDocument("$not", new BsonDocument("$gt", DateTime.UtcNow)) },
                    { "Models", new BsonDocument("$not", new BsonDocument("$elemMatch", new BsonDocument
                        {
                            { "ModelId", appended.GetStringOrEmpty("ModelId") },
                            { "PlatformId", appended.GetStringOrEmpty("PlatformId") },
                        })) },
                };
                var appendResult = await gwModelPools.UpdateOneAsync(
                    appendFilter,
                    Builders<BsonDocument>.Update.Push("Models", appended).Set("UpdatedAt", DateTime.UtcNow).Inc("Version", 1));
                if (appendResult.ModifiedCount == 1) imported++;
                else skippedExisting++;
            }
        }
        else
        {
            var validationError = await ValidateDefaultGatewayPoolMembersAsync(
                gwModelPoolTypes,
                gwPlatforms,
                gwModels,
                gwModelExchanges,
                pool,
                new BsonArray(nextMembers));
            if (validationError is not null)
            {
                return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("INVALID_INPUT", validationError), jsonOptions, 400);
            }

            var writeResult = await gwModelPools.UpdateOneAsync(
                Builders<BsonDocument>.Filter.And(
                    poolFilter,
                    PoolVersionGuard(Builders<BsonDocument>.Filter, pool),
                    PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, DateTime.UtcNow)), Builders<BsonDocument>.Update
                .Set("Models", new BsonArray(nextMembers))
                .Set("UpdatedAt", DateTime.UtcNow)
                .Inc("Version", 1));
            if (writeResult.ModifiedCount != 1)
                return Json(ApiEnvelope<BulkImportPoolModelsResult>.Fail("POOL_CONCURRENTLY_MODIFIED", "模型池正在变更，请重试批量导入。"), jsonOptions, 409);
        }
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
    if (pool is null) return Json(ApiEnvelope<PoolItem>.Fail("NOT_GW_AUTHORITY", "请先将模型池导入为平台配置，再管理池成员"), jsonOptions, 409);
    var managedAppendOnly = IsManagedAppendOnlyPool(pool);
    if (body is null) return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    if (GatewayConfigurationProvisioning.ContainsImageSizeControlCapability(
            body.Capabilities?.Select(capability => capability?.Type) ?? []))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "INVALID_INPUT",
            "图片尺寸能力只能在模型高级配置中维护，不能写入模型池成员"), jsonOptions, 400);
    }

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
    BsonDocument? exchangeDoc = null;
    if (modelDoc is null && platformId.Length > 0)
    {
        exchangeDoc = await gwModelExchanges.Find(TenantAccess.Filter(http, modelFb.And(
            modelFb.Eq("_id", platformId),
            modelFb.Ne("Enabled", false)))).FirstOrDefaultAsync();
        var exchangeModels = exchangeDoc is not null
                             && exchangeDoc.TryGetValue("Models", out var exchangeModelsValue)
                             && exchangeModelsValue.IsBsonArray
            ? exchangeModelsValue.AsBsonArray.Where(item => item.IsBsonDocument).Select(item => item.AsBsonDocument)
            : Enumerable.Empty<BsonDocument>();
        var exchangeModel = exchangeModels.FirstOrDefault(item =>
            string.Equals(item.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal)
            && item.AsNullableBool("Enabled") != false);
        if (exchangeModel is not null)
            modelDoc = GatewayConfigurationProvisioning.BuildExchangePoolModelDocument(platformId, exchangeModel);
    }
    if (modelDoc is null)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", $"模型或 Exchange 映射不存在、已停用或平台不匹配：{modelId}"), jsonOptions, 400);
    }
    if (managedAppendOnly && modelDoc.AsNullableBool("Enabled") == false)
        return Json(ApiEnvelope<PoolItem>.Fail("MODEL_DISABLED", "停用模型不能加入平台托管默认池。"), jsonOptions, 409);
    if (managedAppendOnly)
        modelId = modelDoc.AsNullableString("ModelName") ?? modelDoc.AsNullableString("Name") ?? modelDoc.GetStringOrEmpty("_id");

    var resolvedPlatformId = platformId.Length > 0 ? platformId : modelDoc.GetStringOrEmpty("PlatformId");
    if (resolvedPlatformId.Length == 0)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", $"模型缺少 PlatformId：{modelId}"), jsonOptions, 400);
    }

    if (exchangeDoc is null)
    {
        var platformFilter = Builders<BsonDocument>.Filter.Eq("_id", resolvedPlatformId);
        var platformDoc = await gwPlatforms.Find(TenantAccess.Filter(http, platformFilter)).FirstOrDefaultAsync()
                          ?? (TenantAccess.GetRequired(http).TenantId == internalTenantId
                              ? await platforms.Find(platformFilter).FirstOrDefaultAsync()
                              : null);
        if (platformDoc is null)
        {
            return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", $"平台不存在：{resolvedPlatformId}"), jsonOptions, 400);
        }
        if (managedAppendOnly && platformDoc.AsNullableBool("Enabled") == false)
            return Json(ApiEnvelope<PoolItem>.Fail("PLATFORM_DISABLED", "停用平台的模型不能加入平台托管默认池。"), jsonOptions, 409);
    }

    var modelsArr = pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var members = modelsArr.Where(x => x.IsBsonDocument).Select(x => new BsonDocument(x.AsBsonDocument)).ToList();
    var existing = members.FirstOrDefault(m =>
        string.Equals(m.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal) &&
        string.Equals(m.GetStringOrEmpty("PlatformId"), resolvedPlatformId, StringComparison.Ordinal));
    var wasExisting = existing is not null;
    if (managedAppendOnly && wasExisting)
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "APPEND_ONLY_POOL",
            "平台托管默认池中的已有成员不可覆盖或重排；如需特殊配置，请创建专用模型池。"), jsonOptions, 409);
    }
    if (managedAppendOnly && !GatewayModelPoolTypeRegistry.IsCompatible(modelDoc, pool.GetStringOrEmpty("ModelType")))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "INCOMPATIBLE_MODEL_TYPE",
            $"模型与程序池类型 {pool.GetStringOrEmpty("ModelType")} 不兼容。"), jsonOptions, 409);
    }
    var member = existing is not null ? new BsonDocument(existing) : new BsonDocument();
    // 运维显式重新声明这条成员，就是在说「按这份配置重新算」，健康位必须跟着归零。
    //
    // 此前只有全新成员才给 0，existing 会把陈旧的 HealthStatus 原样带过来。
    // 后果不是「保留了历史」，而是死锁：默认池的成员全部掉成 Unavailable 之后，
    // 「必须留一个可用成员」那条守卫会把删除、覆盖、重新声明**全部**挡下——
    // 唯一能救回池子的动作被池子当前的坏状态挡在门外，重试多少次都是同一个结果。
    // 健康位本就该由真实调用重新算出来，这里归零不丢任何真信息。
    member["HealthStatus"] = 0;
    member["ConsecutiveFailures"] = 0;
    member["ConsecutiveSuccesses"] = 0;
    member["ModelId"] = modelId;
    member["PlatformId"] = resolvedPlatformId;
    member["Priority"] = managedAppendOnly
        ? members.Select(m => m.AsNullableInt("Priority") ?? 0).DefaultIfEmpty(0).Max() + 10
        : body.Priority ?? (existing?.AsNullableInt("Priority") ?? members.Count + 1);

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

    if (managedAppendOnly)
    {
        member = BuildPoolMemberFromModel(
            modelDoc,
            modelId,
            resolvedPlatformId,
            members.Select(m => m.AsNullableInt("Priority") ?? 0).DefaultIfEmpty(0).Max() + 10,
            existing: null);
    }

    members = managedAppendOnly
        ? members.Append(member).ToList()
        : members
            .Where(m => !(string.Equals(m.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal) &&
                          string.Equals(m.GetStringOrEmpty("PlatformId"), resolvedPlatformId, StringComparison.Ordinal)))
            .Append(member)
            .OrderBy(m => m.AsNullableInt("Priority") ?? 100000)
            .ThenBy(m => m.GetStringOrEmpty("PlatformId"), StringComparer.Ordinal)
            .ThenBy(m => m.GetStringOrEmpty("ModelId"), StringComparer.Ordinal)
            .ToList();

    if (managedAppendOnly)
    {
        var appendFilter = new BsonDocument
        {
            { "TenantId", TenantAccess.GetRequired(http).TenantId },
            { "_id", id },
            { "ManagedByRegistry", true },
            { "AppendOnly", true },
            { "DefaultSwitchPendingUntil", new BsonDocument("$not", new BsonDocument("$gt", DateTime.UtcNow)) },
            { "Models", new BsonDocument("$not", new BsonDocument("$elemMatch", new BsonDocument
                {
                    { "ModelId", modelId },
                    { "PlatformId", resolvedPlatformId },
                })) },
        };
        var appendResult = await gwModelPools.UpdateOneAsync(
            appendFilter,
            Builders<BsonDocument>.Update.Push("Models", member).Set("UpdatedAt", DateTime.UtcNow).Inc("Version", 1));
        if (appendResult.ModifiedCount != 1)
            return Json(ApiEnvelope<PoolItem>.Fail("APPEND_ONLY_POOL", "该模型已存在，未覆盖已有成员。"), jsonOptions, 409);
    }
    else
    {
        var nextModels = new BsonArray(members);
        var validationError = await ValidateDefaultGatewayPoolMembersAsync(
            gwModelPoolTypes,
            gwPlatforms,
            gwModels,
            gwModelExchanges,
            pool,
            nextModels);
        if (validationError is not null)
        {
            return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", validationError), jsonOptions, 400);
        }

        var writeResult = await gwModelPools.UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                poolFilter,
                PoolVersionGuard(Builders<BsonDocument>.Filter, pool),
                PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, DateTime.UtcNow)), Builders<BsonDocument>.Update
            .Set("Models", nextModels)
            .Set("UpdatedAt", DateTime.UtcNow)
            .Inc("Version", 1));
        if (writeResult.ModifiedCount != 1)
            return Json(ApiEnvelope<PoolItem>.Fail("POOL_CONCURRENTLY_MODIFIED", "模型池正在变更，请重试成员更新。"), jsonOptions, 409);
    }
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

// 手动恢复保持成员不可用，只授予进入原子半开的资格；下一条真实业务请求负责验证，不发送额外付费探测。
app.MapPost("/gw/pools/{id}/models/recover", async (HttpContext http, string id, [FromBody] RecoverPoolModelRequest? body) =>
{
    var modelId = body?.ModelId?.Trim() ?? string.Empty;
    var platformId = body?.PlatformId?.Trim() ?? string.Empty;
    if (modelId.Length == 0 || platformId.Length == 0)
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", "modelId 和 platformId 不能为空"), jsonOptions, 400);

    var poolFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id));
    var pool = await gwModelPools.Find(poolFilter).FirstOrDefaultAsync();
    if (pool is null)
        return Json(ApiEnvelope<PoolItem>.Fail("NOT_GW_AUTHORITY", "请先将模型池导入为平台配置，再恢复池成员"), jsonOptions, 409);

    var modelsArr = pool.TryGetValue("Models", out var mv) && mv.IsBsonArray ? mv.AsBsonArray : new BsonArray();
    var members = modelsArr.Where(value => value.IsBsonDocument).Select(value => new BsonDocument(value.AsBsonDocument)).ToList();
    var member = members.FirstOrDefault(value =>
        string.Equals(value.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal)
        && string.Equals(value.GetStringOrEmpty("PlatformId"), platformId, StringComparison.Ordinal));
    if (member is null)
        return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池成员不存在：{modelId}"), jsonOptions, 404);

    var previousHealthStatus = member.AsNullableInt("HealthStatus") ?? 0;
    member["HealthStatus"] = 2;
    member["ConsecutiveSuccesses"] = 0;
    member["ManualRecoveryAt"] = DateTime.UtcNow;
    var writeResult = await gwModelPools.UpdateOneAsync(
        Builders<BsonDocument>.Filter.And(
            poolFilter,
            PoolVersionGuard(Builders<BsonDocument>.Filter, pool),
            PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, DateTime.UtcNow)),
        Builders<BsonDocument>.Update
            .Set("Models", new BsonArray(members))
            .Set("UpdatedAt", DateTime.UtcNow)
            .Inc("Version", 1));
    if (writeResult.ModifiedCount != 1)
        return Json(ApiEnvelope<PoolItem>.Fail("POOL_CONCURRENTLY_MODIFIED", "模型池正在变更，请重试恢复"), jsonOptions, 409);

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.model.recover",
        targetType: "llmgw_model_pool",
        targetId: id,
        targetName: pool.AsNullableString("Name") ?? pool.AsNullableString("Code"),
        success: true,
        reason: "manual-half-open",
        changes: new BsonDocument
        {
            { "modelId", modelId },
            { "platformId", platformId },
            { "fromHealthStatus", previousHealthStatus },
            { "toHealthStatus", 2 },
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
    if (pool is null) return Json(ApiEnvelope<PoolItem>.Fail("NOT_GW_AUTHORITY", "请先将模型池导入为平台配置，再管理池成员"), jsonOptions, 409);
    if (IsManagedAppendOnlyPool(pool))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "APPEND_ONLY_POOL",
            "平台托管默认池不允许删除成员；如需特殊化，请创建专用模型池。"), jsonOptions, 409);
    }

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
        gwModelPoolTypes,
        gwPlatforms,
        gwModels,
        gwModelExchanges,
        pool,
        nextModels);
    if (validationError is not null)
    {
        return Json(ApiEnvelope<PoolItem>.Fail("INVALID_INPUT", validationError), jsonOptions, 400);
    }

    var deleteResult = await gwModelPools.UpdateOneAsync(
        Builders<BsonDocument>.Filter.And(
            poolFilter,
            PoolVersionGuard(Builders<BsonDocument>.Filter, pool),
            PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, DateTime.UtcNow)), Builders<BsonDocument>.Update
        .Set("Models", nextModels)
        .Set("UpdatedAt", DateTime.UtcNow)
        .Inc("Version", 1));
    if (deleteResult.ModifiedCount != 1)
        return Json(ApiEnvelope<PoolItem>.Fail("POOL_CONCURRENTLY_MODIFIED", "模型池正在变更，请重试删除。"), jsonOptions, 409);
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

// 模型池默认标记：单文档原子更新类型注册表中的 DefaultPoolId。
// IsDefaultForType 只保留为历史兼容镜像，控制台与运行时均以 DefaultPoolId 为权威。
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
    if (doc is null)
    {
        var mapDoc = TenantAccess.GetRequired(http).TenantId == internalTenantId
            ? await modelGroups.Find(sourceFilter).FirstOrDefaultAsync()
            : null;
        if (mapDoc is not null)
            return Json(ApiEnvelope<PoolItem>.Fail("MAP_POOL_NOT_CLAIMED", "请先将模型池导入为平台配置，再设为默认"), jsonOptions, 409);
        return Json(ApiEnvelope<PoolItem>.Fail("NOT_FOUND", $"模型池不存在：{id}"), jsonOptions, 404);
    }
    var modelType = doc.GetStringOrEmpty("ModelType");
    if (!await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, doc))
    {
        return Json(ApiEnvelope<PoolItem>.Fail(
            "INVALID_INPUT",
            "默认模型池必须至少包含一个可用成员；请先添加可用模型。"),
            jsonOptions,
            400);
    }
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    await EnsureGatewayModelPoolTypesAsync(
        gwModelPoolTypes, gwModelPools, gwModels, gwPlatforms, models, platforms, tenantId, internalTenantId, appendModels: false);
    var fb = Builders<BsonDocument>.Filter;
    var now = DateTime.UtcNow;
    var reserveResult = await gwModelPools.UpdateOneAsync(
        fb.And(filter, PoolVersionGuard(fb, doc), PoolNotSwitchingGuard(fb, now)),
        Builders<BsonDocument>.Update
            .Set("DefaultSwitchPendingUntil", now.AddSeconds(30))
            .Set("UpdatedAt", now)
            .Inc("Version", 1));
    if (reserveResult.ModifiedCount != 1)
        return Json(ApiEnvelope<PoolItem>.Fail("POOL_CONCURRENTLY_MODIFIED", "模型池正在变更，请重试设为默认。"), jsonOptions, 409);
    var typeFilter = fb.And(fb.Eq("TenantId", tenantId), fb.Eq("Code", modelType));
    var beforeType = await gwModelPoolTypes.Find(typeFilter).FirstOrDefaultAsync();
    var updatedType = await gwModelPoolTypes.FindOneAndUpdateAsync(
        typeFilter,
        Builders<BsonDocument>.Update
            .Set("DefaultPoolId", id)
            .Set("UpdatedAt", now)
            .Inc("Version", 1),
        new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After });
    if (updatedType is null)
    {
        await gwModelPools.UpdateOneAsync(filter, Builders<BsonDocument>.Update.Unset("DefaultSwitchPendingUntil").Inc("Version", 1));
        return Json(ApiEnvelope<PoolItem>.Fail("POOL_TYPE_NOT_REGISTERED", $"程序池类型未注册：{modelType}"), jsonOptions, 409);
    }

    // 兼容镜像依据原子指针重建；即使并发交错，权威读取也只认类型文档中的单一指针。
    await gwModelPools.UpdateManyAsync(
        fb.And(fb.Eq("TenantId", tenantId), fb.Eq("ModelType", modelType)),
        Builders<BsonDocument>.Update.Set("IsDefaultForType", false).Set("UpdatedAt", now));
    var authoritativePoolId = updatedType.GetStringOrEmpty("DefaultPoolId");
    await gwModelPools.UpdateOneAsync(
        fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", authoritativePoolId)),
        Builders<BsonDocument>.Update
            .Set("IsDefaultForType", true)
            .Set("UpdatedAt", now)
            .Unset("DefaultSwitchPendingUntil")
            .Inc("Version", 1));
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "pool.set_default",
        targetType: "llmgw_model_pool",
        targetId: id,
        targetName: doc.AsNullableString("Name") ?? doc.AsNullableString("Code"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "defaultPoolId", new BsonDocument { { "from", beforeType?.AsNullableString("DefaultPoolId") ?? string.Empty }, { "to", id } } },
            { "modelType", modelType },
            { "authority", "llm_gateway" },
            { "typeVersion", updatedType.AsNullableLong("Version") ?? 0 },
        });
    var fresh = await gwModelPools.Find(filter).FirstOrDefaultAsync();
    var item = MapPool(fresh);
    item.IsDefaultForType = string.Equals(authoritativePoolId, id, StringComparison.Ordinal);
    return Json(ApiEnvelope<PoolItem>.Ok(item), jsonOptions);
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
    if (before is not null && IsManagedAppendOnlyPool(before))
        return Json(ApiEnvelope<PoolItem>.Fail("APPEND_ONLY_POOL", "平台托管默认池不能被历史 MAP 池覆盖。"), jsonOptions, 409);
    if (before is not null && await IsCurrentDefaultPoolAsync(gwModelPoolTypes, before))
        return Json(ApiEnvelope<PoolItem>.Fail("DEFAULT_POOL_CLAIM_BLOCKED", "当前默认池不能被历史 MAP 池覆盖；请先切换默认池。"), jsonOptions, 409);
    var claimed = new BsonDocument(source);
    claimed["TenantId"] = internalTenantId;
    claimed["SourceCollection"] = "model_groups";
    claimed["Authority"] = "llm_gateway";
    claimed["ClaimedAt"] = now;
    claimed["UpdatedAt"] = now;
    claimed["Version"] = (before?.AsNullableLong("Version") ?? 0) + 1;

    if (before is null)
    {
        await gwModelPools.ReplaceOneAsync(filter, claimed, new ReplaceOptions { IsUpsert = true });
    }
    else
    {
        var replaceResult = await gwModelPools.ReplaceOneAsync(
            Builders<BsonDocument>.Filter.And(
                filter,
                PoolVersionGuard(Builders<BsonDocument>.Filter, before),
                PoolNotSwitchingGuard(Builders<BsonDocument>.Filter, now)),
            claimed);
        if (replaceResult.ModifiedCount != 1)
            return Json(ApiEnvelope<PoolItem>.Fail("POOL_CONCURRENTLY_MODIFIED", "模型池正在变更，请重试认领。"), jsonOptions, 409);
    }
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

// ───────────────────── 快捷提 bug（Ctrl+B 全局面板，2026-07-27）─────────────────────
//
// 投递两条路（绝不假装成功）：
//   1. 配置了 MAP 缺陷系统凭据 → 服务端带凭据转发到 MAP `POST /api/defect-agent/defects`
//      再调 submit；凭据只在服务端读取，前端永远拿不到。
//   2. 未配置或转发失败 → 落到网关自己的 llmgw_bug_reports 集合，
//      响应 delivery=local + degradeReason，前端如实告知「未同步到缺陷系统」。
var bugReports = gatewayDatabase.GetCollection<BsonDocument>("llmgw_bug_reports");
var bugReportMapBaseUrl = (Environment.GetEnvironmentVariable("LLMGW_BUG_REPORT_MAP_BASE_URL") ?? string.Empty).Trim().TrimEnd('/');
var bugReportMapToken = (Environment.GetEnvironmentVariable("LLMGW_BUG_REPORT_MAP_TOKEN") ?? string.Empty).Trim();
var bugReportMapAssignee = (Environment.GetEnvironmentVariable("LLMGW_BUG_REPORT_MAP_ASSIGNEE") ?? string.Empty).Trim();
var bugReportForwardConfigured = bugReportMapBaseUrl.Length > 0 && bugReportMapToken.Length > 0;
var bugReportHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
var bugReportSeverities = new[] { "critical", "major", "minor", "trivial" };
const long BugReportMaxAttachmentBytes = 5L * 1024 * 1024;
// 总量闸按 **base64 字符长度** 计，因为真正写进 MongoDB 单文档的就是 base64 字符串。
// 按解码后字节算 12MB 时，base64 恰好是 16MiB，正好顶穿 MongoDB 16MB 单文档硬上限，
// 写库会直接抛异常，缺陷与截图全丢。这里留出文档其余字段与 BSON 开销的余量。
const long BugReportMaxTotalBase64Chars = 12L * 1024 * 1024;
/** 本地台账每租户保留条数上限（附件 base64 直接进文档，必须有回收）。 */
const int BugReportRetainPerTenant = 100;
const int BugReportMaxAttachmentCount = 4;
// 转发缺陷系统（create + submit）的总预算，与前端「超过 10 秒转本地留存」文案一致：
// 两段各给 10s 会让用户实际等到 20s。
var bugReportForwardBudget = TimeSpan.FromSeconds(10);
// 文本字段上限。没有它，一次不带附件的提交就能把多兆字节的 Description/Content
// 原样写进每一份 MongoDB 文档；每租户 100 条的保留策略只管条数不管字节，
// 反复提交仍能吃掉约 1GB/租户，并让转发与写库都变慢（Codex PR #1273 P1）。
// 数值与 CDS 侧 bug-reports.ts 逐一对齐——同一个面板的两个后端不该有两套上限。
const int BugReportMaxTitleChars = 200;
const int BugReportMaxDescriptionChars = 20_000;
const int BugReportMaxContentChars = 40_000;
const int BugReportMaxEnvKeyChars = 40;
// source 同样来自客户端且原样落库，不设限就等于前面几个上限白加（Codex PR #1273 P1）。
// 与 CDS 侧 `asString(body.source, 'cds').slice(0, 40)` 同口径。
const int BugReportMaxSourceChars = 40;
// 环境字典的**条目数**上限：只截键和值不够，几万个不同的键照样能拼出多兆字节的
// 无附件文档，把「每租户 100 条」的存储上限架空（Codex PR #1273 P1）。
const int BugReportMaxEnvEntries = 40;
const int BugReportMaxAttachmentNameChars = 120;
// 截断而不是拒收：用户辛苦写的复现步骤不该被整条丢掉，但必须留下明确标记。
static string ClampBugReportText(string value, int max)
    => value.Length <= max ? value : $"{value[..max]}\n…（原文共 {value.Length} 字，超过 {max} 字上限，已截断）";
// 附件元数据（文件名 / MIME）同样来自客户端，直接截断即可，不必留标记。
static string ClampBugReportSource(string value)
{
    var v = value.Length == 0 ? "llmgw" : value;
    return v.Length > 40 ? v[..40] : v;
}
static string ClampBugReportName(string value, string fallback)
{
    var v = value.Length == 0 ? fallback : value;
    return v.Length > 120 ? v[..120] : v;
}

app.MapPost("/gw/bug-reports", async (HttpContext http, [FromBody] BugReportSubmitRequest? body) =>
{
    var access = TenantAccess.GetRequired(http);
    var description = (body?.Description ?? string.Empty).Trim();
    if (description.Length == 0)
        return Json(ApiEnvelope<BugReportSubmitResult>.Fail("BUG_REPORT_EMPTY", "请填写问题描述"), jsonOptions, 400);
    description = ClampBugReportText(description, BugReportMaxDescriptionChars);

    var severity = (body?.Severity ?? string.Empty).Trim().ToLowerInvariant();
    if (!bugReportSeverities.Contains(severity, StringComparer.Ordinal))
        return Json(ApiEnvelope<BugReportSubmitResult>.Fail("BUG_REPORT_SEVERITY_INVALID", "严重程度取值非法"), jsonOptions, 400);

    var rawAttachments = body?.Attachments ?? new List<BugReportAttachmentDto>();
    if (rawAttachments.Count > BugReportMaxAttachmentCount)
        return Json(ApiEnvelope<BugReportSubmitResult>.Fail("BUG_REPORT_ATTACHMENT_TOO_MANY", $"附件最多 {BugReportMaxAttachmentCount} 个"), jsonOptions, 400);

    var attachmentDocs = new BsonArray();
    long totalBase64Chars = 0;
    foreach (var item in rawAttachments)
    {
        var data = item.DataBase64 ?? string.Empty;
        if (data.Length == 0) continue;
        var estimated = (long)Math.Ceiling(data.Length * 3d / 4d);
        if (estimated > BugReportMaxAttachmentBytes)
            return Json(ApiEnvelope<BugReportSubmitResult>.Fail("BUG_REPORT_ATTACHMENT_TOO_LARGE", "单个附件超过 5 MB"), jsonOptions, 400);
        totalBase64Chars += data.Length;
        if (totalBase64Chars > BugReportMaxTotalBase64Chars)
            return Json(ApiEnvelope<BugReportSubmitResult>.Fail("BUG_REPORT_ATTACHMENT_TOO_LARGE", "附件总量超出存储上限，请压缩截图后重试"), jsonOptions, 400);
        attachmentDocs.Add(new BsonDocument
        {
            { "Name", ClampBugReportName((item.Name ?? "attachment").Trim(), "attachment") },
            { "MimeType", ClampBugReportName((item.MimeType ?? "application/octet-stream").Trim(), "application/octet-stream") },
            { "Size", item.Size > 0 ? item.Size : estimated },
            { "DataBase64", data },
        });
    }

    var firstLine = description.Split('\n').FirstOrDefault()?.Trim() ?? string.Empty;
    var title = (body?.Title ?? string.Empty).Trim();
    if (title.Length == 0) title = firstLine.Length > 100 ? firstLine[..100] : firstLine;
    if (title.Length == 0) title = "未命名缺陷";
    if (title.Length > BugReportMaxTitleChars) title = title[..BugReportMaxTitleChars];
    var content = (body?.Content ?? string.Empty).Trim();
    if (content.Length == 0) content = description;
    content = ClampBugReportText(content, BugReportMaxContentChars);

    var environmentDoc = new BsonDocument();
    foreach (var pair in body?.Environment ?? new Dictionary<string, string>())
    {
        if (environmentDoc.ElementCount >= BugReportMaxEnvEntries) break;
        if (string.IsNullOrWhiteSpace(pair.Value)) continue;
        // key 也要截：环境字典的键来自客户端，不设限同样能把文档撑大。
        var envKey = pair.Key.Length > BugReportMaxEnvKeyChars ? pair.Key[..BugReportMaxEnvKeyChars] : pair.Key;
        environmentDoc[envKey] = pair.Value.Length > 500 ? pair.Value[..500] : pair.Value;
    }

    var delivery = "local";
    string? reference = null;
    string? degradeReason = bugReportForwardConfigured
        ? null
        : "未配置缺陷系统转发（LLMGW_BUG_REPORT_MAP_BASE_URL / LLMGW_BUG_REPORT_MAP_TOKEN）";

    if (bugReportForwardConfigured)
    {
        // 转发与落库都**不得**绑在 http.RequestAborted 上（见 .claude/rules/server-authority.md）：
        // 用户按 ESC 关面板或切页就会断连接，最坏时序是 MAP 里已建了缺陷、网关这边没有
        // 任何记录，既查不到也无法复投。这里改用与请求生命周期解耦的独立超时预算。
        using var forwardCts = new CancellationTokenSource(bugReportForwardBudget);
        var forwardToken = forwardCts.Token;
        try
        {
            var createBody = new Dictionary<string, object?>
            {
                ["title"] = title,
                ["content"] = content,
                ["severity"] = severity,
            };
            if (bugReportMapAssignee.Length > 0) createBody["assigneeUserId"] = bugReportMapAssignee;

            using var createRequest = new HttpRequestMessage(HttpMethod.Post, $"{bugReportMapBaseUrl}/api/defect-agent/defects")
            {
                Content = new StringContent(JsonSerializer.Serialize(createBody, jsonOptions), Encoding.UTF8, "application/json"),
            };
            createRequest.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bugReportMapToken}");
            using var createResponse = await bugReportHttp.SendAsync(createRequest, forwardToken);
            var createText = await createResponse.Content.ReadAsStringAsync(forwardToken);
            if (!createResponse.IsSuccessStatusCode)
            {
                degradeReason = $"缺陷系统返回 HTTP {(int)createResponse.StatusCode}";
            }
            else
            {
                using var parsed = JsonDocument.Parse(createText);
                JsonElement? defectElement = null;
                if (parsed.RootElement.TryGetProperty("data", out var dataEl)
                    && dataEl.TryGetProperty("defect", out var defectEl))
                {
                    defectElement = defectEl;
                }
                var defectId = defectElement.HasValue && defectElement.Value.TryGetProperty("id", out var idEl)
                    ? idEl.GetString()
                    : null;
                if (string.IsNullOrWhiteSpace(defectId))
                {
                    degradeReason = "缺陷系统未返回缺陷 ID";
                }
                else
                {
                    delivery = "forwarded";
                    reference = defectElement!.Value.TryGetProperty("defectNo", out var noEl)
                        ? noEl.GetString() ?? defectId
                        : defectId;

                    // 附件必须在 submit 之前上传：正文里只有文件名，没有图。少了这一步，
                    // 缺陷系统收到的是「说有截图但没有截图」的单子，而 UI 照样报「已提交」——
                    // 典型的谎报成功。CDS 侧已修（forwardToMap 的 attachments 循环），
                    // 网关这边一直漏着（Codex PR #1273 P2）。上传失败不推翻「已进单」的
                    // 事实，但必须如实回传部分失败，让用户知道图没跟过去。
                    var attachmentFailures = 0;
                    for (var i = 0; i < attachmentDocs.Count; i++)
                    {
                        var doc = attachmentDocs[i].AsBsonDocument;
                        try
                        {
                            var bytes = Convert.FromBase64String(doc.GetValue("DataBase64", "").AsString);
                            // 不加 using：form 的所有权交给 uploadRequest，随它一起释放。
                            var form = new MultipartFormDataContent();
                            var fileContent = new ByteArrayContent(bytes);
                            var mime = doc.GetValue("MimeType", "application/octet-stream").AsString;
                            if (mime.Length == 0) mime = "application/octet-stream";
                            fileContent.Headers.ContentType = new MediaTypeHeaderValue(mime);
                            var fileName = doc.GetValue("Name", "").AsString;
                            if (fileName.Length == 0) fileName = $"screenshot-{i + 1}";
                            form.Add(fileContent, "file", fileName);
                            form.Add(new StringContent("由网关控制台快捷提缺陷自动上传"), "description");
                            using var uploadRequest = new HttpRequestMessage(
                                HttpMethod.Post,
                                $"{bugReportMapBaseUrl}/api/defect-agent/defects/{defectId}/attachments")
                            {
                                Content = form,
                            };
                            uploadRequest.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bugReportMapToken}");
                            using var uploadResponse = await bugReportHttp.SendAsync(uploadRequest, forwardToken);
                            if (!uploadResponse.IsSuccessStatusCode) attachmentFailures++;
                        }
                        catch (Exception uploadError)
                        {
                            app.Logger.LogWarning(uploadError, "[bug-report] 附件上传失败");
                            attachmentFailures++;
                        }
                    }
                    if (attachmentFailures > 0)
                    {
                        degradeReason = $"缺陷已提交，但 {attachmentFailures} 个截图未能上传到缺陷系统（正文里只有文件名）";
                    }

                    try
                    {
                        using var submitRequest = new HttpRequestMessage(
                            HttpMethod.Post,
                            $"{bugReportMapBaseUrl}/api/defect-agent/defects/{defectId}/submit")
                        {
                            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
                        };
                        submitRequest.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bugReportMapToken}");
                        using var submitResponse = await bugReportHttp.SendAsync(submitRequest, forwardToken);
                        if (!submitResponse.IsSuccessStatusCode)
                        {
                            app.Logger.LogWarning("[bug-report] 缺陷已创建但 submit 返回 {Status}", (int)submitResponse.StatusCode);
                            // 必须回传给前端：只记日志的话 UI 会无条件说「已提交」，
                            // 而单子其实还躺在草稿态没人处理（Codex PR #1273 P2，
                            // CDS 侧已修，这里补齐同款）。
                            var submitIssue = $"缺陷已创建但提交流转失败（缺陷系统返回 HTTP {(int)submitResponse.StatusCode}），可能仍是草稿态";
                            // 附件也失败时两条都要说，后写的不能把前一条盖掉。
                            degradeReason = string.IsNullOrEmpty(degradeReason) ? submitIssue : $"{degradeReason}；{submitIssue}";
                        }
                    }
                    catch (Exception submitError)
                    {
                        // 缺陷已经落在 MAP 里，提交环节失败只影响状态流转，不改变投递结论，
                        // 但同样要如实告知用户「可能仍是草稿态」。
                        app.Logger.LogWarning(submitError, "[bug-report] 缺陷已创建但 submit 失败");
                        var submitIssue = $"缺陷已创建但提交流转失败（{submitError.Message}），可能仍是草稿态";
                        // 与上面的非 2xx 分支同口径：附件也失败时两条都要说，
                        // 否则用户只被告知「可能是草稿」，完全不知道截图还丢了（Codex PR #1273 P2）。
                        degradeReason = string.IsNullOrEmpty(degradeReason) ? submitIssue : $"{degradeReason}；{submitIssue}";
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 只可能是本地 10s 总预算到期（forwardToken 与请求生命周期无关）。
            degradeReason = "缺陷系统 10 秒内无响应，已转为本地留存";
        }
        catch (Exception forwardError)
        {
            degradeReason = $"缺陷系统调用失败：{forwardError.Message}";
        }
    }

    var bugReportDoc = new BsonDocument
    {
        { "_id", Guid.NewGuid().ToString("N") },
        { "TenantId", access.TenantId },
        { "Source", ClampBugReportSource((body?.Source ?? "llmgw").Trim()) },
        { "Reporter", access.Username },
        { "ReporterUserId", access.UserId },
        { "Title", title },
        { "Description", description },
        { "Content", content },
        { "Severity", severity },
        { "Environment", environmentDoc },
        { "Attachments", attachmentDocs },
        { "Delivery", delivery },
        { "Reference", string.IsNullOrEmpty(reference) ? (BsonValue)BsonNull.Value : new BsonString(reference) },
        { "DegradeReason", string.IsNullOrEmpty(degradeReason) ? (BsonValue)BsonNull.Value : new BsonString(degradeReason) },
        { "CreatedAt", DateTime.UtcNow },
    };
    // 落库同样与请求生命周期解耦（server-authority）；且必须兜住异常：
    // 写库失败时若没有转发成功，这条缺陷就彻底丢了，必须给出可读原因让用户重试，
    // 而不是抛一个裸 500。
    try
    {
        await bugReports.InsertOneAsync(bugReportDoc, cancellationToken: CancellationToken.None);
        // 保留策略：附件是 base64 直接进文档，单条最多约 12MB。没有上限的话，
        // 一个拿到凭据的客户端（或不断重试的前端）反复提交就能把网关库撑爆，
        // 且转发成功的记录也一样在长（Codex PR #1273 P1）。
        // 按租户保留最近 N 条，超出的整条删除——本地台账是兜底证据，不是归档。
        try
        {
            var tenantFilter = Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId);
            var keepIds = await bugReports
                .Find(tenantFilter)
                .Sort(Builders<BsonDocument>.Sort.Descending("CreatedAt"))
                .Limit(BugReportRetainPerTenant)
                .Project(Builders<BsonDocument>.Projection.Include("_id"))
                .ToListAsync(CancellationToken.None);
            if (keepIds.Count >= BugReportRetainPerTenant)
            {
                var keep = keepIds.Select(d => d["_id"]).ToList();
                await bugReports.DeleteManyAsync(
                    Builders<BsonDocument>.Filter.And(
                        tenantFilter,
                        Builders<BsonDocument>.Filter.Nin("_id", keep)),
                    CancellationToken.None);
            }
        }
        catch (Exception pruneError)
        {
            // 回收失败不能影响「缺陷已收下」这件事本身。
            app.Logger.LogWarning(pruneError, "[bug-report] 本地台账回收失败 tenant={Tenant}", access.TenantId);
        }
    }
    catch (Exception storeError)
    {
        app.Logger.LogError(storeError, "[bug-report] 缺陷记录写入失败 delivery={Delivery}", delivery);
        if (delivery != "forwarded")
        {
            return Json(
                ApiEnvelope<BugReportSubmitResult>.Fail(
                    "BUG_REPORT_STORE_FAILED",
                    "缺陷未能保存（可能是附件总量超出存储上限），请压缩截图后重试"),
                jsonOptions,
                500);
        }
        // 已经转发到 MAP 的情况下，本地记录只是台账，缺失不改变「缺陷已进入系统」的事实。
        // 但**不能覆盖**前面已经攒下的降级说明（截图没传上去 / 可能仍是草稿态）：
        // 直接赋值会把那两条抹掉，用户只看到「台账写入失败」，完全不知道图也丢了
        // （Codex PR #1273 P2，与两个 submit 分支同一个病根）。
        const string ledgerIssue = "缺陷已提交到缺陷系统，但网关本地台账写入失败";
        degradeReason = string.IsNullOrEmpty(degradeReason) ? ledgerIssue : $"{degradeReason}；{ledgerIssue}";
    }

    return Json(ApiEnvelope<BugReportSubmitResult>.Ok(new BugReportSubmitResult
    {
        Id = bugReportDoc.GetStringOrEmpty("_id"),
        Delivery = delivery,
        Reference = reference,
        DegradeReason = degradeReason,
    }), jsonOptions, 201);
}).RequireAuthorization();

app.MapGet("/gw/bug-reports", async (HttpContext http, int? limit) =>
{
    var access = TenantAccess.GetRequired(http);
    var take = Math.Clamp(limit ?? 50, 1, 200);
    var docs = await bugReports
        .Find(Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId))
        .Sort(Builders<BsonDocument>.Sort.Descending("CreatedAt"))
        .Limit(take)
        .ToListAsync(http.RequestAborted);
    return Json(ApiEnvelope<BugReportListData>.Ok(new BugReportListData
    {
        ForwardConfigured = bugReportForwardConfigured,
        Items = docs.Select(doc => new BugReportItem
        {
            Id = doc.GetStringOrEmpty("_id"),
            Title = doc.GetStringOrEmpty("Title"),
            Severity = doc.GetStringOrEmpty("Severity"),
            Delivery = doc.GetStringOrEmpty("Delivery"),
            Reference = doc.AsNullableString("Reference"),
            DegradeReason = doc.AsNullableString("DegradeReason"),
            Reporter = doc.AsNullableString("Reporter"),
            AttachmentCount = doc.TryGetValue("Attachments", out var attachments) && attachments.IsBsonArray
                ? attachments.AsBsonArray.Count
                : 0,
            CreatedAt = doc.AsNullableUtcDateTime("CreatedAt").ToIso(),
        }).ToList(),
    }), jsonOptions);
}).RequireAuthorization();

_ = RunGatewayRecoveryLoopAsync(gatewayDatabase, app.Logger, app.Lifetime.ApplicationStopping);
app.Run();

static async Task<(LlmGwTenant Tenant, string DefaultTeamId)?> FindTenantCreationReplayAsync(
    IMongoCollection<LlmGwTeam> teams,
    IMongoCollection<LlmGwMembership> memberships,
    LlmGwTenant tenant,
    string userId)
{
    if (tenant.Status != "active") return null;
    var membership = await memberships.Find(x => x.TenantId == tenant.Id
            && x.UserId == userId
            && x.Role == LlmGwTenantRoles.Owner
            && x.Status == "active")
        .FirstOrDefaultAsync();
    if (membership is null) return null;
    var defaultTeam = await teams.Find(x => x.TenantId == tenant.Id
            && membership.TeamIds.Contains(x.Id)
            && x.Status == "active")
        .SortBy(x => x.CreatedAt)
        .FirstOrDefaultAsync();
    return defaultTeam is null ? null : (tenant, defaultTeam.Id);
}

static bool MembershipMatches(
    LlmGwMembership membership,
    string role,
    IReadOnlyCollection<string> teamIds)
    => membership.Status == "active"
       && string.Equals(membership.Role, role, StringComparison.OrdinalIgnoreCase)
       && membership.TeamIds.ToHashSet(StringComparer.Ordinal).SetEquals(teamIds);

// ─────────────────────────────── 辅助函数 ───────────────────────────────

static TenantSessionDto ToTenantSession(LlmGwTenant tenant, LlmGwMembership membership) => new()
{
    Id = tenant.Id,
    Name = tenant.Name,
    IsInternal = tenant.IsInternal,
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
        "llmgw_model_pool_types",
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
        "llmgw_cost_reconciliations",
        "llmgw_cost_import_scope_locks",
        "llmgw_legacy_key_cutovers",
        "llmgw_legacy_key_usage",
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
//   1) envAuthority（LLMGW_ADMIN_ENV_AUTHORITY=1）：env 是长期权威，只在口令或账号状态漂移时修复。
//   2) forceReset（LLMGW_ADMIN_FORCE_RESET=1）：一次性破玻璃，同样只在漂移时修复。
//   3) 已有账号：数据库哈希是长期权威，只保活，不再被 LLMGW_ADMIN_PASSWORD 覆盖。
//   4) 空库首次 bootstrap：用 LLMGW_ADMIN_PASSWORD；未设则内置 admin/admin + 首登强制改密。
static async Task SeedAdminAsync(
    IMongoDatabase db,
    IMongoCollection<BsonDocument> operationAudits,
    string username,
    string defaultPwd,
    string tenantId,
    bool forceReset = false,
    bool envAuthority = false,
    string? envPassword = null)
{
    var users = db.GetCollection<LlmGwUser>("llmgw_console_users");

    // 多租户账号由 membership 控制，不得在 bootstrap 时禁用其它租户用户。

    // 环境变量长期托管或一次性破玻璃：只修复漂移。PBKDF2 每次 Hash 都有新盐，禁止在口令已经
    // 匹配时重复写 Hash，否则每次启动都会制造无意义变更并使所有现有会话失效。
    if (envAuthority || forceReset)
    {
        var resetPassword = string.IsNullOrWhiteSpace(envPassword) ? defaultPwd : envPassword.Trim();
        var resetMustChange = resetPassword == defaultPwd;
        var existingForce = await users.Find(u => u.Username == username).FirstOrDefaultAsync();
        if (existingForce is not null)
        {
            var passwordDrifted = !PasswordHasher.Verify(resetPassword, existingForce.PasswordHash);
            var activeDrifted = !existingForce.IsActive;
            var mustChangeDrifted = existingForce.MustChangePassword != resetMustChange;
            var ownershipDrifted = existingForce.PasswordChangedByUser;

            if (!passwordDrifted && !activeDrifted && !mustChangeDrifted && !ownershipDrifted)
                return;

            var updates = new List<UpdateDefinition<LlmGwUser>>();
            if (passwordDrifted)
                updates.Add(Builders<LlmGwUser>.Update.Set(u => u.PasswordHash, PasswordHasher.Hash(resetPassword)));
            if (activeDrifted)
                updates.Add(Builders<LlmGwUser>.Update.Set(u => u.IsActive, true));
            if (mustChangeDrifted)
                updates.Add(Builders<LlmGwUser>.Update.Set(u => u.MustChangePassword, resetMustChange));
            if (ownershipDrifted)
                updates.Add(Builders<LlmGwUser>.Update.Set(u => u.PasswordChangedByUser, false));

            var securityStateChanged = passwordDrifted || activeDrifted || mustChangeDrifted;
            if (securityStateChanged)
                updates.Add(Builders<LlmGwUser>.Update.Inc(u => u.SecurityVersion, 1));
            updates.Add(Builders<LlmGwUser>.Update.Set(u => u.UpdatedAt, DateTime.UtcNow));

            await users.UpdateOneAsync(
                u => u.Username == username,
                Builders<LlmGwUser>.Update.Combine(updates));
            await WriteSystemOperationAuditAsync(
                operationAudits,
                action: envAuthority ? "admin.env_authority_reconcile" : "admin.force_reset",
                targetType: "llmgw_console_user",
                targetId: existingForce.Id,
                targetName: username,
                success: true,
                reason: null,
                changes: new BsonDocument
                {
                    { "mode", envAuthority ? "env_authority" : "force_reset" },
                    { "passwordSource", string.IsNullOrWhiteSpace(envPassword) ? "default" : "env" },
                    { "passwordDrifted", passwordDrifted },
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
                Username = username, PasswordHash = PasswordHasher.Hash(resetPassword), DisplayName = username,
                IsActive = true, MustChangePassword = resetMustChange, PasswordChangedByUser = false,
                Scopes = new[] { "logs:read" }, CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            await users.InsertOneAsync(resetUser);
            await WriteSystemOperationAuditAsync(
                operationAudits,
                action: envAuthority ? "admin.env_authority_bootstrap" : "admin.force_reset_bootstrap",
                targetType: "llmgw_console_user",
                targetId: resetUser.Id,
                targetName: username,
                success: true,
                reason: null,
                changes: new BsonDocument
                {
                    { "mode", envAuthority ? "env_authority" : "force_reset" },
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
                    .Inc(u => u.SecurityVersion, 1)
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

/// <summary>
/// 有上限地读上游响应体。
///
/// 15 秒超时只管**时长**不管**字节数**：一个 ConfigWrite 租户把 Provider 指向自己控制的
/// 公网服务器，回一个飞快的超大响应，就能把共享的控制台进程内存吃干——限时拦不住限量。
/// 所以边流边数，超过上限直接掐断并如实报错，而不是先 ReadAsStringAsync 把整棵 JSON 树读进内存。
/// </summary>
static async Task<string> ReadUpstreamBodyAsync(HttpResponseMessage resp, int maxBytes, CancellationToken ct)
{
    await using var stream = await resp.Content.ReadAsStreamAsync(ct);
    var buffer = new byte[8192];
    using var ms = new MemoryStream();
    int read;
    while ((read = await stream.ReadAsync(buffer, ct)) > 0)
    {
        if (ms.Length + read > maxBytes)
            throw new InvalidOperationException($"上游响应体超过 {maxBytes / 1024 / 1024} MB 上限，已中止读取");
        ms.Write(buffer, 0, read);
    }
    return System.Text.Encoding.UTF8.GetString(ms.ToArray());
}

static async Task<string?> ValidateExternalExchangeTargetAsync(string targetUrl, string transformerType, CancellationToken ct)
{
    var transportError = GatewayConfigurationProvisioning.ValidateExternalExchangeTransport(targetUrl, transformerType);
    if (transportError is not null)
        return transportError;

    if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out var uri)
        || uri.Scheme is not ("http" or "https" or "wss"))
    {
        return "外部租户 Exchange 只允许 HTTP、HTTPS 或 WSS 上游；WebSocket 必须使用 WSS 加密连接";
    }
    if (!string.IsNullOrWhiteSpace(uri.UserInfo))
        return "外部租户 Exchange URL 不允许携带 userinfo";

    var host = uri.Host.Trim().TrimEnd('.');
    if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        return "外部租户 Exchange 不能连接 localhost、内网或云元数据地址";

    IPAddress[] addresses;
    try
    {
        addresses = IPAddress.TryParse(host, out var literal)
            ? [literal]
            : await Dns.GetHostAddressesAsync(host, ct);
    }
    catch (Exception ex) when (ex is System.Net.Sockets.SocketException or OperationCanceledException)
    {
        return "目标地址当前无法完成安全 DNS 校验，请检查域名后重试";
    }

    if (addresses.Length == 0 || addresses.Any(address => !GatewayConfigurationProvisioning.IsSafeExternalExchangeAddress(address)))
        return "外部租户 Exchange 不能连接 localhost、内网、链路本地或云元数据地址";
    return null;
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
    BsonDocument? changes = null,
    bool throwOnFailure = false)
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
        if (throwOnFailure)
            throw;
    }
}

static async Task<string> BeginRequiredOperationAuditAsync(
    IMongoCollection<BsonDocument> audits,
    HttpContext http,
    string action,
    string targetType,
    string? targetId,
    string? targetName,
    BsonDocument changes)
{
    var access = TenantAccess.GetRequired(http);
    var auditId = Guid.NewGuid().ToString("N");
    var actorUserId = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
        ?? http.User.FindFirst("sub")?.Value;
    var actorUsername = http.User.FindFirst(System.Security.Claims.ClaimTypes.Name)?.Value
        ?? http.User.Identity?.Name;
    await audits.InsertOneAsync(new BsonDocument
    {
        { "_id", auditId },
        { "TenantId", access.TenantId },
        { "TeamId", ToBsonAuditValue(access.TeamIds.Count == 1 ? access.TeamIds[0] : null) },
        { "Action", action },
        { "TargetType", targetType },
        { "TargetId", ToBsonAuditValue(targetId) },
        { "TargetName", ToBsonAuditValue(targetName) },
        { "ActorUserId", ToBsonAuditValue(actorUserId) },
        { "ActorUsername", ToBsonAuditValue(actorUsername) },
        { "Success", false },
        { "State", "pending" },
        { "Reason", "pending" },
        { "Changes", changes },
        { "RemoteIp", ToBsonAuditValue(GetClientIp(http)) },
        { "UserAgent", ToBsonAuditValue(http.Request.Headers.UserAgent.ToString()) },
        { "CreatedAt", DateTime.UtcNow },
    });
    return auditId;
}

static async Task CompleteRequiredOperationAuditAsync(
    IMongoCollection<BsonDocument> audits,
    string tenantId,
    string auditId,
    bool success,
    string? reason)
{
    var result = await audits.UpdateOneAsync(
        Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", auditId),
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            Builders<BsonDocument>.Filter.Eq("State", "pending")),
        Builders<BsonDocument>.Update
            .Set("Success", success)
            .Set("State", success ? "completed" : "failed")
            .Set("Reason", ToBsonAuditValue(reason))
            .Set("CompletedAt", DateTime.UtcNow));
    if (result.ModifiedCount != 1)
        throw new InvalidOperationException($"Required operation audit {auditId} could not be completed.");
}

static async Task TryCompleteRequiredOperationAuditAsync(
    IMongoCollection<BsonDocument> audits,
    string tenantId,
    string auditId,
    bool success,
    string? reason)
{
    try
    {
        await CompleteRequiredOperationAuditAsync(audits, tenantId, auditId, success, reason);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[LlmGw] required operation audit completion failed: {ex.Message}");
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
    string? sessionId,
    string? modelPoolId,
    string? serviceKeyId,
    string? clientCode,
    string? environment,
    string? operation = null,
    string? view = null,
    string? platformId = null)
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
    // 按上游平台过滤：provider 是厂商类型、会重名（本仓库两条上游同名同 URL 只有 key 不同），
    // 想看「这条上游到底有没有在被调、报什么错」只能按 PlatformId 精确过滤。
    if (!string.IsNullOrWhiteSpace(platformId)) filters.Add(fb.Eq("PlatformId", platformId.Trim()));
    if (!string.IsNullOrWhiteSpace(appCallerCode)) filters.Add(fb.Eq("AppCallerCode", appCallerCode));
    if (!string.IsNullOrWhiteSpace(transport)) filters.Add(fb.Eq("GatewayTransport", transport));
    if (!string.IsNullOrWhiteSpace(requestType)) filters.Add(fb.Eq("RequestType", requestType));
    if (!string.IsNullOrWhiteSpace(sourceSystem)) filters.Add(fb.Eq("SourceSystem", sourceSystem));
    if (!string.IsNullOrWhiteSpace(ingressProtocol)) filters.Add(fb.Eq("IngressProtocol", ingressProtocol));
    if (!string.IsNullOrWhiteSpace(modelPolicy)) filters.Add(fb.Eq("ModelPolicy", modelPolicy));
    if (!string.IsNullOrWhiteSpace(runId)) filters.Add(fb.Eq("RunId", runId.Trim()));
    if (!string.IsNullOrWhiteSpace(requestId)) filters.Add(fb.Eq("RequestId", requestId.Trim()));
    if (!string.IsNullOrWhiteSpace(sessionId)) filters.Add(fb.Eq("SessionId", sessionId.Trim()));
    if (!string.IsNullOrWhiteSpace(modelPoolId)) filters.Add(fb.Eq("ModelPoolId", modelPoolId.Trim()));
    if (!string.IsNullOrWhiteSpace(serviceKeyId)) filters.Add(fb.Eq("ServiceKeyId", serviceKeyId.Trim()));
    if (!string.IsNullOrWhiteSpace(clientCode)) filters.Add(fb.Eq("ClientCode", clientCode.Trim()));
    if (!string.IsNullOrWhiteSpace(environment)) filters.Add(fb.Eq("Environment", environment.Trim()));
    if (!string.IsNullOrWhiteSpace(operation))
    {
        filters.Add(BuildOperationFilter(operation));
    }
    else if (string.Equals(view, "logical", StringComparison.OrdinalIgnoreCase))
    {
        filters.Add(BuildBusinessOperationFilter());
    }
    var normalizedReleaseCommit = NormalizeCommitFilter(releaseCommit);
    if (normalizedReleaseCommit is not null) filters.Add(fb.Eq("ReleaseCommit", normalizedReleaseCommit));
    return fb.And(filters);
}

static FilterDefinition<BsonDocument> BuildBusinessOperationFilter()
{
    var fb = Builders<BsonDocument>.Filter;
    var legacyBusiness = fb.And(
        BuildLegacyOperationFilter(),
        fb.Ne("IsHealthProbe", true),
        fb.Or(
            fb.Ne("RequestType", "video-gen"),
            fb.Nin("HttpMethod", new[] { "GET", "DELETE" })));
    return fb.Or(
        fb.In("Operation", new[] { "invoke", "submit" }),
        legacyBusiness);
}

static FilterDefinition<BsonDocument> BuildOperationFilter(string operation)
{
    var fb = Builders<BsonDocument>.Filter;
    var normalized = operation.Trim().ToLowerInvariant();
    var legacy = BuildLegacyOperationFilter();
    return normalized switch
    {
        "submit" => fb.Or(
            fb.Eq("Operation", "submit"),
            fb.And(legacy, fb.Eq("RequestType", "video-gen"), fb.Eq("HttpMethod", "POST"), fb.Ne("IsHealthProbe", true))),
        "status" => fb.Or(
            fb.Eq("Operation", "status"),
            fb.And(
                legacy,
                fb.Eq("RequestType", "video-gen"),
                fb.Eq("HttpMethod", "GET"),
                fb.Not(fb.Regex("Path", new BsonRegularExpression("/content", "i"))),
                fb.Ne("IsHealthProbe", true))),
        "download" => fb.Or(
            fb.Eq("Operation", "download"),
            fb.And(
                legacy,
                fb.Eq("RequestType", "video-gen"),
                fb.Eq("HttpMethod", "GET"),
                fb.Regex("Path", new BsonRegularExpression("/content", "i")),
                fb.Ne("IsHealthProbe", true))),
        "cancel" => fb.Or(
            fb.Eq("Operation", "cancel"),
            fb.And(legacy, fb.Eq("RequestType", "video-gen"), fb.Eq("HttpMethod", "DELETE"), fb.Ne("IsHealthProbe", true))),
        "probe" => fb.Or(
            fb.Eq("Operation", "probe"),
            fb.And(legacy, fb.Eq("IsHealthProbe", true))),
        "invoke" => fb.Or(
            fb.Eq("Operation", "invoke"),
            fb.And(
                legacy,
                fb.Ne("IsHealthProbe", true),
                fb.Or(
                    fb.Ne("RequestType", "video-gen"),
                    fb.Nin("HttpMethod", new[] { "GET", "DELETE", "POST" })))),
        _ => fb.Eq("Operation", normalized),
    };
}

static FilterDefinition<BsonDocument> BuildLegacyOperationFilter()
{
    var fb = Builders<BsonDocument>.Filter;
    return fb.Or(
        fb.Exists("Operation", false),
        fb.Eq("Operation", BsonNull.Value));
}

static string ResolveLogOperation(BsonDocument doc)
{
    var stored = doc.AsNullableString("Operation")?.Trim().ToLowerInvariant();
    if (stored is "invoke" or "submit" or "status" or "download" or "cancel" or "probe")
        return stored;
    if (doc.AsNullableBool("IsHealthProbe") == true) return "probe";
    if (!string.Equals(doc.AsNullableString("RequestType"), "video-gen", StringComparison.OrdinalIgnoreCase))
        return "invoke";

    var method = doc.AsNullableString("HttpMethod")?.Trim().ToUpperInvariant();
    if (method == "DELETE") return "cancel";
    if (method == "GET")
        return doc.AsNullableString("Path")?.Contains("/content", StringComparison.OrdinalIgnoreCase) == true
            ? "download"
            : "status";
    return method == "POST" ? "submit" : "invoke";
}

static bool IsBusinessOperation(string operation)
    => operation is "invoke" or "submit";

static bool IsUpstreamProviderAttempt(ProviderAttemptDto attempt)
    => (string.Equals(attempt.Stage, "send", StringComparison.OrdinalIgnoreCase)
        || IsProviderPollAttempt(attempt))
       && attempt.ReachedProvider != false;

static bool IsProviderPollAttempt(ProviderAttemptDto attempt)
    => string.Equals(attempt.Stage, "poll", StringComparison.OrdinalIgnoreCase);

static string? InferProviderTaskId(BsonDocument doc)
{
    if (!string.Equals(doc.AsNullableString("RequestType"), "video-gen", StringComparison.OrdinalIgnoreCase))
        return null;
    var operation = ResolveLogOperation(doc);
    if (operation == "submit")
    {
        var responseBody = doc.AsNullableString("AnswerText");
        if (string.IsNullOrWhiteSpace(responseBody)) return null;
        try
        {
            using var parsed = JsonDocument.Parse(responseBody);
            if (parsed.RootElement.ValueKind != JsonValueKind.Object) return null;
            foreach (var field in new[] { "id", "generation_id", "task_id" })
            {
                if (parsed.RootElement.TryGetProperty(field, out var value)
                    && value.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(value.GetString()))
                {
                    return value.GetString();
                }
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
    }
    if (operation is not ("status" or "download" or "cancel")) return null;
    var path = doc.AsNullableString("Path");
    if (string.IsNullOrWhiteSpace(path)) return null;
    var segments = path.Split('?', 2)[0]
        .Split('/', StringSplitOptions.RemoveEmptyEntries);
    if (segments.Length == 0) return null;
    var index = operation == "download" && segments[^1].Equals("content", StringComparison.OrdinalIgnoreCase)
        ? segments.Length - 2
        : segments.Length - 1;
    return index >= 0 ? Uri.UnescapeDataString(segments[index]) : null;
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

static Dictionary<string, long> ReadSuccessorObservationCounts(BsonDocument? document)
{
    if (document is null
        || !document.TryGetValue("SuccessorObservationCounts", out var value)
        || !value.IsBsonDocument)
    {
        return new Dictionary<string, long>(StringComparer.Ordinal);
    }

    return value.AsBsonDocument.Elements
        .Where(element => element.Value.IsInt32 || element.Value.IsInt64)
        .ToDictionary(
            element => element.Name,
            element => element.Value.ToInt64(),
            StringComparer.Ordinal);
}

static CostReconciliationItem MapCostReconciliation(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    TeamId = d.AsNullableString("TeamId"),
    Provider = d.GetStringOrEmpty("Provider"),
    ExternalRecordId = d.GetStringOrEmpty("ExternalRecordId"),
    Granularity = d.GetStringOrEmpty("Granularity"),
    RequestId = d.AsNullableString("RequestId"),
    ProviderRequestId = d.AsNullableString("ProviderRequestId"),
    ServiceKeyId = d.AsNullableString("ServiceKeyId"),
    Model = d.AsNullableString("Model"),
    EstimatedCost = d.AsNullableDecimal("EstimatedCost"),
    EstimatedCostCurrency = d.AsNullableString("EstimatedCostCurrency"),
    ProviderReportedCost = d.AsNullableDecimal("ProviderReportedCost"),
    ProviderCostCurrency = d.GetStringOrEmpty("ProviderCostCurrency"),
    FxSnapshotId = d.AsNullableString("FxSnapshotId"),
    ProviderToEstimatedFxRate = d.AsNullableDecimal("ProviderToEstimatedFxRate"),
    ReconciliationDelta = d.AsNullableDecimal("ReconciliationDelta"),
    DeltaCurrency = d.AsNullableString("DeltaCurrency"),
    ReconciliationStatus = d.GetStringOrEmpty("ReconciliationStatus"),
    WindowFrom = d.AsNullableUtcDateTime("WindowFrom").ToIso(),
    WindowTo = d.AsNullableUtcDateTime("WindowTo").ToIso(),
    BilledAt = d.AsNullableUtcDateTime("BilledAt").ToIso(),
    CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
};

static long? Percentile95(IReadOnlyList<long> sortedValues)
{
    if (sortedValues.Count == 0) return null;
    var index = Math.Clamp((int)Math.Ceiling(sortedValues.Count * 0.95d) - 1, 0, sortedValues.Count - 1);
    return sortedValues[index];
}

static List<OverviewRankItem> BuildOverviewRank(
    IEnumerable<BsonDocument> docs,
    Func<BsonDocument, string?> keySelector,
    Func<BsonDocument, string?> labelSelector,
    int limit) =>
    docs.Select(d => new
        {
            Key = keySelector(d)?.Trim(),
            Label = labelSelector(d)?.Trim(),
        })
        .Where(x => !string.IsNullOrWhiteSpace(x.Key))
        .GroupBy(x => x.Key!, StringComparer.OrdinalIgnoreCase)
        .Select(g => new OverviewRankItem
        {
            Key = g.Key,
            Label = g.Select(x => x.Label).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)) ?? g.Key,
            Count = g.LongCount(),
        })
        .OrderByDescending(x => x.Count)
        .ThenBy(x => x.Label, StringComparer.OrdinalIgnoreCase)
        .Take(limit)
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
    LogicalModelId = d.AsNullableString("LogicalModelId"),
    LogicalModelPublicId = d.AsNullableString("LogicalModelPublicId"),
    OfferingId = d.AsNullableString("OfferingId"),
    OfferingTargetKind = d.AsNullableString("OfferingTargetKind"),
    PlatformId = d.AsNullableString("PlatformId"),
    PlatformName = d.AsNullableString("PlatformName"),
    GroupId = d.AsNullableString("GroupId"),
    SessionId = d.AsNullableString("SessionId"),
    RunId = d.AsNullableString("RunId"),
    LogicalRequestId = d.AsNullableString("LogicalRequestId"),
    ProviderTaskId = d.AsNullableString("ProviderTaskId") ?? InferProviderTaskId(d),
    UserId = d.AsNullableString("UserId"),
    TeamId = d.AsNullableString("TeamId"),
    ServiceKeyId = d.AsNullableString("ServiceKeyId"),
    ClientCode = d.AsNullableString("ClientCode"),
    Environment = d.AsNullableString("Environment"),
    ServiceKeyPrefix = d.AsNullableString("ServiceKeyPrefix"),
    Username = null,
    DisplayName = null,
    RequestType = d.AsNullableString("RequestType"),
    Operation = ResolveLogOperation(d),
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
    TokenUsageSource = d.AsNullableString("TokenUsageSource"),
    ImageSuccessCount = d.AsNullableInt("ImageSuccessCount"),
    EstimatedCost = d.AsNullableDecimal("EstimatedCost"),
    EstimatedCostCurrency = d.AsNullableString("EstimatedCostCurrency"),
    EstimatedCostUsd = d.AsNullableDecimal("EstimatedCostUsd"),
    PriceSnapshotHash = d.AsNullableString("PriceSnapshotHash"),
    ProviderRequestId = d.AsNullableString("ProviderRequestId"),
    ProviderReportedCost = d.AsNullableDecimal("ProviderReportedCost"),
    ProviderCostCurrency = d.AsNullableString("ProviderCostCurrency"),
    FxSnapshotId = d.AsNullableString("FxSnapshotId"),
    ReconciliationStatus = d.AsNullableString("ReconciliationStatus"),
    ReconciliationDelta = d.AsNullableDecimal("ReconciliationDelta"),
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
    LogicalRequestId = d.AsNullableString("LogicalRequestId"),
    ProviderTaskId = d.AsNullableString("ProviderTaskId") ?? InferProviderTaskId(d),
    UserId = d.AsNullableString("UserId"),
    TeamId = d.AsNullableString("TeamId"),
    ServiceKeyId = d.AsNullableString("ServiceKeyId"),
    ClientCode = d.AsNullableString("ClientCode"),
    Environment = d.AsNullableString("Environment"),
    ServiceKeyPrefix = d.AsNullableString("ServiceKeyPrefix"),
    RequestType = d.AsNullableString("RequestType"),
    Operation = ResolveLogOperation(d),
    AppCallerCode = d.AsNullableString("AppCallerCode"),
    AppCallerCodeDisplayName = d.AsNullableString("AppCallerCodeDisplayName"),
    AppCallerTitle = d.AsNullableString("AppCallerTitle"),
    SourceSystem = d.AsNullableString("SourceSystem"),
    IngressProtocol = d.AsNullableString("IngressProtocol"),
    Provider = d.GetStringOrEmpty("Provider"),
    Model = d.GetStringOrEmpty("Model"),
    LogicalModelId = d.AsNullableString("LogicalModelId"),
    LogicalModelPublicId = d.AsNullableString("LogicalModelPublicId"),
    OfferingId = d.AsNullableString("OfferingId"),
    OfferingTargetKind = d.AsNullableString("OfferingTargetKind"),
    RequestBodyRedacted = d.AsNullableString("RequestBodyRedacted"),
    SystemPromptText = d.AsNullableString("SystemPromptText"),
    PromptPolicyId = d.AsNullableString("PromptPolicyId"),
    PromptPolicyVersion = d.AsNullableInt("PromptPolicyVersion"),
    PromptPolicyHash = d.AsNullableString("PromptPolicyHash"),
    QuestionText = d.AsNullableString("QuestionText"),
    AnswerText = d.AsNullableString("AnswerText"),
    ThinkingText = d.AsNullableString("ThinkingText"),
    ResponseToolCalls = d.AsNullableString("ResponseToolCalls"),
    ToolCallCount = d.AsNullableInt("ToolCallCount"),
    InputTokens = d.AsNullableInt("InputTokens"),
    OutputTokens = d.AsNullableInt("OutputTokens"),
    ImageSuccessCount = d.AsNullableInt("ImageSuccessCount"),
    OutputImages = MapLogImages(d, "OutputImages"),
    OutputImageCaptureStatus = d.AsNullableString("OutputImageCaptureStatus"),
    OutputImageCaptureError = d.AsNullableString("OutputImageCaptureError"),
    OutputImageCapturedAt = d.AsNullableUtcDateTime("OutputImageCapturedAt").ToIso(),
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
    PriceSnapshotHash = d.AsNullableString("PriceSnapshotHash"),
    ProviderRequestId = d.AsNullableString("ProviderRequestId"),
    ProviderReportedCost = d.AsNullableDecimal("ProviderReportedCost"),
    ProviderCostCurrency = d.AsNullableString("ProviderCostCurrency"),
    FxSnapshotId = d.AsNullableString("FxSnapshotId"),
    ReconciliationStatus = d.AsNullableString("ReconciliationStatus"),
    ReconciliationDelta = d.AsNullableDecimal("ReconciliationDelta"),
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

static List<LogImageDto> MapLogImages(BsonDocument d, string field)
{
    if (!d.TryGetValue(field, out var value) || !value.IsBsonArray) return [];
    return value.AsBsonArray
        .Where(item => item.IsBsonDocument)
        .Select(item => item.AsBsonDocument)
        .Select(image => new LogImageDto
        {
            Url = image.GetStringOrEmpty("Url"),
            OriginalUrl = image.AsNullableString("OriginalUrl"),
            Label = image.AsNullableString("Label"),
            Sha256 = image.AsNullableString("Sha256"),
            MimeType = image.AsNullableString("MimeType"),
            SizeBytes = image.AsNullableLong("SizeBytes"),
        })
        .Where(image => !string.IsNullOrWhiteSpace(image.Url))
        .ToList();
}

static RouterTraceDto BuildRouterTrace(BsonDocument d)
{
    var logicalModelId = d.AsNullableString("LogicalModelId");
    var logicalModelPublicId = d.AsNullableString("LogicalModelPublicId");
    var offeringId = d.AsNullableString("OfferingId");
    var offeringTargetKind = d.AsNullableString("OfferingTargetKind");
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
    Add("model", "logical model", !string.IsNullOrWhiteSpace(logicalModelPublicId) && !string.IsNullOrWhiteSpace(logicalModelId)
        ? $"{logicalModelPublicId} ({logicalModelId})" : logicalModelPublicId ?? logicalModelId);
    Add("model", "offering", !string.IsNullOrWhiteSpace(offeringTargetKind) && !string.IsNullOrWhiteSpace(offeringId)
        ? $"{offeringTargetKind} ({offeringId})" : offeringId);
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
        LogicalModelId = logicalModelId,
        LogicalModelPublicId = logicalModelPublicId,
        OfferingId = offeringId,
        OfferingTargetKind = offeringTargetKind,
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
                ReachedProvider = doc.AsNullableBool("ReachedProvider"),
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
            ReachedProvider = true,
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
    var member = existing is not null ? new BsonDocument(existing) : new BsonDocument();
    // 运维显式重新声明这条成员，就是在说「按这份配置重新算」，健康位必须跟着归零。
    //
    // 此前只有全新成员才给 0，existing 会把陈旧的 HealthStatus 原样带过来。
    // 后果不是「保留了历史」，而是死锁：默认池的成员全部掉成 Unavailable 之后，
    // 「必须留一个可用成员」那条守卫会把删除、覆盖、重新声明**全部**挡下——
    // 唯一能救回池子的动作被池子当前的坏状态挡在门外，重试多少次都是同一个结果。
    // 健康位本就该由真实调用重新算出来，这里归零不丢任何真信息。
    member["HealthStatus"] = 0;
    member["ConsecutiveFailures"] = 0;
    member["ConsecutiveSuccesses"] = 0;
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

static bool IsManagedAppendOnlyPool(BsonDocument pool)
    => pool.AsNullableBool("ManagedByRegistry") == true
       && pool.AsNullableBool("AppendOnly") == true
       && string.Equals(pool.AsNullableString("PoolRole"), "default", StringComparison.OrdinalIgnoreCase);


/// <summary>池里挂了几个成员。字段缺失或形状不对一律当 0，不抛。</summary>
static int PoolMemberCount(BsonDocument pool)
    => pool.TryGetValue("Models", out var members) && members.IsBsonArray ? members.AsBsonArray.Count : 0;

static FilterDefinition<BsonDocument> PoolVersionGuard(FilterDefinitionBuilder<BsonDocument> fb, BsonDocument pool)
{
    var version = pool.AsNullableLong("Version") ?? 0;
    return pool.Contains("Version") ? fb.Eq("Version", version) : fb.Exists("Version", false);
}

static FilterDefinition<BsonDocument> PoolNotSwitchingGuard(FilterDefinitionBuilder<BsonDocument> fb, DateTime now)
    => fb.Or(fb.Exists("DefaultSwitchPendingUntil", false), fb.Lte("DefaultSwitchPendingUntil", now));

static async Task<bool> IsCurrentDefaultPoolAsync(
    IMongoCollection<BsonDocument> poolTypes,
    BsonDocument pool)
{
    var tenantId = pool.AsNullableString("TenantId");
    var modelType = pool.AsNullableString("ModelType");
    var poolId = pool.AsNullableString("_id");
    if (string.IsNullOrWhiteSpace(tenantId) || string.IsNullOrWhiteSpace(modelType) || string.IsNullOrWhiteSpace(poolId))
        return false;
    var type = await poolTypes.Find(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("Code", modelType))).FirstOrDefaultAsync();
    return type is null
        ? pool.AsNullableBool("IsDefaultForType") == true
        : string.Equals(type.AsNullableString("DefaultPoolId"), poolId, StringComparison.Ordinal);
}

static async Task<(int TypesCreated, int PoolsCreated, int ModelsAppended)> EnsureGatewayModelPoolTypesAsync(
    IMongoCollection<BsonDocument> poolTypes,
    IMongoCollection<BsonDocument> pools,
    IMongoCollection<BsonDocument> gatewayModels,
    IMongoCollection<BsonDocument> gatewayPlatforms,
    IMongoCollection<BsonDocument> mapModels,
    IMongoCollection<BsonDocument> mapPlatforms,
    string tenantId,
    string internalTenantId,
    bool appendModels)
{
    var fb = Builders<BsonDocument>.Filter;
    var now = DateTime.UtcNow;
    var typeDocs = await poolTypes.Find(fb.Eq("TenantId", tenantId)).ToListAsync();
    var poolDocs = await pools.Find(fb.Eq("TenantId", tenantId)).ToListAsync();
    var typesCreated = 0;
    var poolsCreated = 0;
    var modelsAppended = 0;
    var candidates = new List<BsonDocument>();
    if (appendModels)
    {
        var enabledPlatformIds = (await gatewayPlatforms.Find(fb.And(fb.Eq("TenantId", tenantId), fb.Ne("Enabled", false)))
                .Project(Builders<BsonDocument>.Projection.Include("_id"))
                .ToListAsync())
            .Select(platform => platform.GetStringOrEmpty("_id"))
            .Where(id => id.Length > 0)
            .ToHashSet(StringComparer.Ordinal);
        candidates.AddRange((await gatewayModels.Find(fb.And(fb.Eq("TenantId", tenantId), fb.Ne("Enabled", false))).ToListAsync())
            .Where(model => enabledPlatformIds.Contains(model.GetStringOrEmpty("PlatformId"))));
        if (string.Equals(tenantId, internalTenantId, StringComparison.Ordinal))
        {
            var enabledMapPlatformIds = (await mapPlatforms.Find(fb.Ne("Enabled", false))
                    .Project(Builders<BsonDocument>.Projection.Include("_id"))
                    .ToListAsync())
                .Select(platform => platform.GetStringOrEmpty("_id"))
                .Where(id => id.Length > 0)
                .ToHashSet(StringComparer.Ordinal);
            candidates.AddRange((await mapModels.Find(fb.Ne("Enabled", false)).ToListAsync())
                .Where(model => enabledPlatformIds.Contains(model.GetStringOrEmpty("PlatformId"))
                                || enabledMapPlatformIds.Contains(model.GetStringOrEmpty("PlatformId"))));
        }
    }

    foreach (var definition in GatewayModelPoolTypeRegistry.All.OrderBy(item => item.SortOrder))
    {
        var type = typeDocs.FirstOrDefault(d => string.Equals(d.GetStringOrEmpty("Code"), definition.Code, StringComparison.OrdinalIgnoreCase));
        var defaultPoolId = type?.AsNullableString("DefaultPoolId")?.Trim() ?? string.Empty;
        var defaultPool = defaultPoolId.Length > 0
            ? poolDocs.FirstOrDefault(d => string.Equals(d.GetStringOrEmpty("_id"), defaultPoolId, StringComparison.Ordinal)
                                           && string.Equals(d.GetStringOrEmpty("ModelType"), definition.Code, StringComparison.OrdinalIgnoreCase))
            : null;
        defaultPool ??= poolDocs
            .Where(d => string.Equals(d.GetStringOrEmpty("ModelType"), definition.Code, StringComparison.OrdinalIgnoreCase)
                        && d.AsNullableBool("IsDefaultForType") == true)
            .OrderBy(d => d.AsNullableInt("Priority") ?? 50)
            .FirstOrDefault();

        if (defaultPool is null)
        {
            defaultPoolId = $"pool-default:{tenantId}:{definition.Code}";
            var managedPool = new BsonDocument
            {
                ["_id"] = defaultPoolId,
                ["TenantId"] = tenantId,
                ["Name"] = definition.DefaultPoolName,
                ["Code"] = definition.DefaultPoolCode,
                ["Description"] = definition.Purpose,
                ["Priority"] = 50,
                ["ModelType"] = definition.Code,
                ["IsDefaultForType"] = true,
                ["StrategyType"] = 0,
                ["Models"] = new BsonArray(),
                ["SourceCollection"] = "llmgw_model_pools",
                ["Authority"] = "llm_gateway",
                ["ManagedByRegistry"] = true,
                ["AppendOnly"] = true,
                ["PoolRole"] = "default",
                ["CreatedAt"] = now,
                ["UpdatedAt"] = now,
                ["Version"] = 1L,
            };
            try
            {
                var result = await pools.UpdateOneAsync(
                    fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", defaultPoolId)),
                    new BsonDocument("$setOnInsert", managedPool),
                    new UpdateOptions { IsUpsert = true });
                if (result.UpsertedId is not null) poolsCreated++;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 并发初始化已由另一请求创建同一确定性池，重读并继续。
            }
            defaultPool = await pools.Find(fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", defaultPoolId))).FirstAsync();
            if (!poolDocs.Any(d => string.Equals(d.GetStringOrEmpty("_id"), defaultPoolId, StringComparison.Ordinal)))
                poolDocs.Add(defaultPool);
        }
        else
        {
            defaultPoolId = defaultPool.GetStringOrEmpty("_id");
        }

        var typeId = $"pool-type:{tenantId}:{definition.Code}";
        var typeFilter = fb.And(fb.Eq("TenantId", tenantId), fb.Eq("Code", definition.Code));
        try
        {
            var typeResult = await poolTypes.UpdateOneAsync(
                typeFilter,
                Builders<BsonDocument>.Update
                    .SetOnInsert("_id", typeId)
                    .SetOnInsert("TenantId", tenantId)
                    .SetOnInsert("Code", definition.Code)
                    .SetOnInsert("Name", definition.Name)
                    .SetOnInsert("Purpose", definition.Purpose)
                    .SetOnInsert("SortOrder", definition.SortOrder)
                    .SetOnInsert("DefaultPoolId", defaultPoolId)
                    .SetOnInsert("Version", 1L)
                    .SetOnInsert("CreatedAt", now)
                    .SetOnInsert("UpdatedAt", now),
                new UpdateOptions { IsUpsert = true });
            if (typeResult.UpsertedId is not null) typesCreated++;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 并发初始化已由另一请求创建同一确定性类型，继续处理剩余类型。
        }
        if (type is not null && !string.Equals(type.AsNullableString("DefaultPoolId"), defaultPoolId, StringComparison.Ordinal))
        {
            var oldPointer = type.AsNullableString("DefaultPoolId");
            var oldVersion = type.AsNullableLong("Version") ?? 0;
            var pointerFilter = oldPointer is null
                ? fb.Exists("DefaultPoolId", false)
                : fb.Eq("DefaultPoolId", oldPointer);
            var versionFilter = type.Contains("Version") ? fb.Eq("Version", oldVersion) : fb.Exists("Version", false);
            await poolTypes.UpdateOneAsync(fb.And(typeFilter, pointerFilter, versionFilter), Builders<BsonDocument>.Update
                .Set("DefaultPoolId", defaultPoolId)
                .Set("UpdatedAt", now)
                .Inc("Version", 1));
        }

        if (!appendModels || !IsManagedAppendOnlyPool(defaultPool)) continue;
        var maxPriority = defaultPool.TryGetValue("Models", out var membersValue) && membersValue.IsBsonArray
            ? membersValue.AsBsonArray.Where(v => v.IsBsonDocument).Select(v => v.AsBsonDocument.AsNullableInt("Priority") ?? 0).DefaultIfEmpty(0).Max()
            : 0;
        foreach (var model in candidates.Where(candidate => GatewayModelPoolTypeRegistry.IsCompatible(candidate, definition.Code)))
        {
            var modelId = model.AsNullableString("ModelName") ?? model.AsNullableString("Name") ?? model.GetStringOrEmpty("_id");
            var platformId = model.GetStringOrEmpty("PlatformId");
            if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(platformId)) continue;
            maxPriority += 10;
            var member = BuildPoolMemberFromModel(model, modelId, platformId, maxPriority, existing: null);
            var appendFilter = new BsonDocument
            {
                { "TenantId", tenantId },
                { "_id", defaultPoolId },
                { "ManagedByRegistry", true },
                { "AppendOnly", true },
                { "Models", new BsonDocument("$not", new BsonDocument("$elemMatch", new BsonDocument
                    {
                        { "ModelId", modelId },
                        { "PlatformId", platformId },
                    })) },
            };
            var appendResult = await pools.UpdateOneAsync(
                appendFilter,
                Builders<BsonDocument>.Update.Push("Models", member).Set("UpdatedAt", now));
            if (appendResult.ModifiedCount == 1) modelsAppended++;
        }
    }
    return (typesCreated, poolsCreated, modelsAppended);
}

static async Task<PoolTypesData> BuildPoolTypesDataAsync(
    IMongoCollection<BsonDocument> poolTypes,
    IMongoCollection<BsonDocument> pools,
    IMongoCollection<BsonDocument> platforms,
    IMongoCollection<BsonDocument> models,
    IMongoCollection<BsonDocument> exchanges,
    string tenantId)
{
    var fb = Builders<BsonDocument>.Filter;
    var types = await poolTypes.Find(fb.Eq("TenantId", tenantId)).ToListAsync();
    var typeByCode = types.ToDictionary(d => d.GetStringOrEmpty("Code"), StringComparer.OrdinalIgnoreCase);
    var poolIds = types.Select(d => d.GetStringOrEmpty("DefaultPoolId")).Where(id => id.Length > 0).Distinct(StringComparer.Ordinal).ToList();
    var poolDocs = poolIds.Count == 0
        ? new List<BsonDocument>()
        : await pools.Find(fb.And(fb.Eq("TenantId", tenantId), fb.In("_id", poolIds))).ToListAsync();
    var poolById = poolDocs.ToDictionary(d => d.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var items = new List<PoolTypeItem>();
    foreach (var definition in GatewayModelPoolTypeRegistry.All.OrderBy(item => item.SortOrder))
    {
        typeByCode.TryGetValue(definition.Code, out var type);
        var defaultPoolId = type?.GetStringOrEmpty("DefaultPoolId") ?? string.Empty;
        poolById.TryGetValue(defaultPoolId, out var pool);
        var modelCount = pool is not null && pool.TryGetValue("Models", out var value) && value.IsBsonArray ? value.AsBsonArray.Count : 0;
        var ready = pool is not null && await HasUsableGatewayPoolMemberAsync(platforms, models, exchanges, pool);
        items.Add(new PoolTypeItem
        {
            Code = definition.Code,
            Name = definition.Name,
            Purpose = definition.Purpose,
            SortOrder = definition.SortOrder,
            DefaultPoolId = defaultPoolId,
            ModelCount = modelCount,
            Ready = ready,
            Version = type?.AsNullableLong("Version") ?? 0,
        });
    }
    return new PoolTypesData
    {
        Items = items,
        Total = items.Count,
        Ready = items.Count(item => item.Ready),
        Waiting = items.Count(item => !item.Ready),
    };
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
        ManagedByRegistry = d.AsNullableBool("ManagedByRegistry") == true,
        AppendOnly = d.AsNullableBool("AppendOnly") == true,
        PoolRole = d.AsNullableString("PoolRole"),
    };
}

// 硬约束：绝不读 ApiKeyEncrypted 到 DTO，只用它算 hasKey。
/// <summary>
/// 谁还在引用这个模型。池成员按 (modelId, platformId) 定位，而 modelId 允许写模型 id、
/// ModelName 或 Name 三种形态（见 upsert 的查找条件），所以三种都要比对，
/// 只比一种会漏判成「没人用」，把正在服务的模型删掉。
/// </summary>
static async Task<ModelDeleteBlockers> CollectModelDeleteBlockersAsync(
    HttpContext http,
    BsonDocument modelDoc,
    IMongoCollection<BsonDocument> gwPools,
    IMongoCollection<BsonDocument> mapPools,
    IMongoCollection<BsonDocument> gwOfferings,
    IMongoCollection<BsonDocument> gwLogicalModels,
    string internalTenantId)
{
    var fb = Builders<BsonDocument>.Filter;
    var isInternal = TenantAccess.GetRequired(http).TenantId == internalTenantId;
    var platformId = modelDoc.GetStringOrEmpty("PlatformId");
    var aliases = new[]
        {
            modelDoc.GetStringOrEmpty("_id"),
            modelDoc.AsNullableString("ModelName") ?? string.Empty,
            modelDoc.AsNullableString("Name") ?? string.Empty,
        }
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.Ordinal)
        .ToArray();

    var memberFilter = fb.ElemMatch<BsonDocument>(
        "Models",
        fb.And(fb.In("ModelId", aliases), fb.Eq("PlatformId", platformId)));
    var poolDocs = await gwPools.Find(TenantAccess.Filter(http, memberFilter)).ToListAsync();
    if (isInternal) poolDocs.AddRange(await mapPools.Find(memberFilter).ToListAsync());

    return new ModelDeleteBlockers
    {
        Pools = poolDocs
            .Select(d => d.AsNullableString("Name") ?? d.GetStringOrEmpty("_id"))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList(),
        LogicalModels = await CollectOfferingHolderNamesAsync(
            http, gwOfferings, gwLogicalModels, "model", modelDoc.GetStringOrEmpty("_id")),
    };
}


/// <summary>
/// 谁把这个上游（模型或交换所）挂成了 offering。offering 只按 _id 单键定位目标，
/// 目标删了它不会报错，只会在路由时静默解析不到——所以删除前必须先问这一句。
/// 返回的是逻辑模型的人话名字：运维要去解绑的是那几个逻辑模型，不是 offering 的 hex id。
/// </summary>
static async Task<List<string>> CollectOfferingHolderNamesAsync(
    HttpContext http,
    IMongoCollection<BsonDocument> gwOfferings,
    IMongoCollection<BsonDocument> gwLogicalModels,
    string targetKind,
    string targetId)
{
    if (string.IsNullOrWhiteSpace(targetId)) return new List<string>();
    var fb = Builders<BsonDocument>.Filter;
    // TargetKind 缺省视作 model：早期文档没写这个字段，漏判就等于漏掉一整批存量引用
    var kindFilter = string.Equals(targetKind, "model", StringComparison.Ordinal)
        ? fb.Or(fb.Eq("TargetKind", "model"), fb.Exists("TargetKind", false), fb.Eq("TargetKind", BsonNull.Value))
        : fb.Eq("TargetKind", targetKind);
    var offeringDocs = await gwOfferings
        .Find(TenantAccess.Filter(http, fb.And(kindFilter, fb.Eq("TargetId", targetId))))
        .ToListAsync();
    if (offeringDocs.Count == 0) return new List<string>();

    var logicalIds = offeringDocs
        .Select(d => d.GetStringOrEmpty("LogicalModelId"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.Ordinal)
        .ToList();
    var nameById = (await gwLogicalModels.Find(TenantAccess.Filter(http, fb.In("_id", logicalIds))).ToListAsync())
        .ToDictionary(d => d.GetStringOrEmpty("_id"), d => d.AsNullableString("Name") ?? d.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    return logicalIds
        .Select(x => nameById.TryGetValue(x, out var name) && !string.IsNullOrWhiteSpace(name) ? name : x)
        .Distinct(StringComparer.Ordinal)
        .ToList();
}

/// <summary>
/// 谁还在引用这条上游。两类来源都要查：模型的 PlatformId，以及模型池成员里的 PlatformId
/// （池成员是 (modelId, platformId) 复合定位，只查模型会漏掉「模型已删、池成员还挂着」的残留）。
/// GW 与 MAP 两套集合都扫，内部租户才看得到 MAP 那一侧。
/// </summary>
static async Task<PlatformDeleteBlockers> CollectPlatformDeleteBlockersAsync(
    HttpContext http,
    string platformId,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> mapModels,
    IMongoCollection<BsonDocument> gwPools,
    IMongoCollection<BsonDocument> mapPools,
    string internalTenantId)
{
    var fb = Builders<BsonDocument>.Filter;
    var isInternal = TenantAccess.GetRequired(http).TenantId == internalTenantId;
    var result = new PlatformDeleteBlockers();

    var modelDocs = await gwModels.Find(TenantAccess.Filter(http, fb.Eq("PlatformId", platformId))).ToListAsync();
    if (isInternal)
        modelDocs.AddRange(await mapModels.Find(fb.Eq("PlatformId", platformId)).ToListAsync());
    result.Models = modelDocs
        .Select(d => d.AsNullableString("Name") ?? d.AsNullableString("ModelName") ?? d.GetStringOrEmpty("_id"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.Ordinal)
        .ToList();

    var poolFilter = fb.ElemMatch<BsonDocument>("Models", fb.Eq("PlatformId", platformId));
    var poolDocs = await gwPools.Find(TenantAccess.Filter(http, poolFilter)).ToListAsync();
    if (isInternal)
        poolDocs.AddRange(await mapPools.Find(poolFilter).ToListAsync());
    result.Pools = poolDocs
        .Select(d => d.AsNullableString("Name") ?? d.GetStringOrEmpty("_id"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.Ordinal)
        .ToList();

    return result;
}

/// <param name="keyConfig">
/// 传入才会计算密钥可读性与指纹；不传保持老行为（只回 hasKey）。
/// </param>
/// <param name="revealFingerprint">
/// 是否下发指纹。调用方必须具备 ConfigWrite——列表端点本身只要 LogsRead，
/// 而「能认出是哪一把密钥」比「能看日志」敏感一档，不能跟着列表权限一起放出去。
/// </param>
static PlatformItem MapPlatform(BsonDocument d, IConfiguration? keyConfig = null, bool revealFingerprint = false)
{
    var encrypted = d.AsNullableString("ApiKeyEncrypted");
    var hasKey = !string.IsNullOrEmpty(encrypted);
    var keyStatus = "missing";
    string? fingerprint = null;
    if (hasKey && keyConfig is not null)
    {
        var decrypted = GwApiKeyCrypto.Decrypt(encrypted, keyConfig);
        keyStatus = decrypted.Success ? "ok" : "unreadable";
        if (decrypted.Success && revealFingerprint)
            fingerprint = GwApiKeyCrypto.Fingerprint(decrypted.PlainText);
    }
    else if (hasKey)
    {
        keyStatus = "ok";
    }

    return new PlatformItem
    {
        Id = d.GetStringOrEmpty("_id"),
        Name = d.GetStringOrEmpty("Name"),
        PlatformType = d.GetStringOrEmpty("PlatformType"),
        ProviderId = d.AsNullableString("ProviderId"),
        ApiUrl = d.AsNullableString("ApiUrl"),
        Enabled = d.AsNullableBool("Enabled") ?? true,
        MaxConcurrency = d.AsNullableInt("MaxConcurrency") ?? 0,
        Remark = d.AsNullableString("Remark"),
        HasKey = hasKey,
        KeyStatus = keyStatus,
        KeyFingerprint = fingerprint,
        SourceCollection = d.AsNullableString("SourceCollection") ?? "llmplatforms",
        Authority = d.AsNullableString("Authority") ?? "map",
        ClaimedAt = d.AsNullableUtcDateTime("ClaimedAt").ToIso(),
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
    };
}

static ModelItem MapModel(BsonDocument d)
{
    var capsArr = d.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray ? cv.AsBsonArray : new BsonArray();
    var caps = capsArr.Where(c => c.IsBsonDocument).Select(c => c.AsBsonDocument).Select(c => new ModelCapabilityItem
    {
        Type = c.GetStringOrEmpty("Type"),
        Source = c.GetStringOrEmpty("Source"),
        Value = c.AsNullableBool("Value") ?? false,
    }).ToList();
    var imageSizeControl = MapImageSizeControl(capsArr.Where(x => x.IsBsonDocument).Select(x => x.AsBsonDocument));
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
        ImageSizeControlMode = imageSizeControl.Mode,
        ImageSizeFieldFormat = imageSizeControl.FieldFormat,
        InputPricePerMillion = d.AsNullableDecimal("InputPricePerMillion"),
        OutputPricePerMillion = d.AsNullableDecimal("OutputPricePerMillion"),
        PricePerCall = d.AsNullableDecimal("PricePerCall"),
        PriceCurrency = d.AsNullableString("PriceCurrency"),
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
    };
}

static (string Mode, string? FieldFormat) MapImageSizeControl(IEnumerable<BsonDocument> capabilities)
    => GatewayConfigurationProvisioning.MapImageSizeControl(capabilities);

static string? ValidateAsrOfferingContract(
    BsonDocument logical,
    BsonDocument offering,
    BsonDocument? target,
    BsonDocument? platform)
{
    var targetKind = offering.GetStringOrEmpty("TargetKind");
    return AsrOfferingContractPolicy.Validate(
        logical.GetStringOrEmpty("ModelType"),
        targetKind,
        AsrOfferingContractPolicy.ResolvePhysicalModel(
            offering.AsNullableString("UpstreamModelId"),
            target?.AsNullableString("ModelName"),
            target?.AsNullableString("ModelId")),
        offering.AsNullableString("EndpointPath"),
        offering.AsNullableString("Protocol") ?? target?.AsNullableString("Protocol"),
        platform?.AsNullableString("PlatformType"));
}

static async Task<string?> ValidateAsrModelMutationAsync(
    HttpContext http,
    BsonDocument proposedModel,
    IMongoCollection<BsonDocument> platforms,
    IMongoCollection<BsonDocument> offerings,
    IMongoCollection<BsonDocument> logicalModels)
{
    var modelId = proposedModel.GetStringOrEmpty("_id");
    if (modelId.Length == 0) return null;
    var fb = Builders<BsonDocument>.Filter;
    var referencedOfferings = await offerings.Find(TenantAccess.Filter(http, fb.And(
        fb.Eq("TargetKind", "model"),
        fb.Eq("TargetId", modelId),
        fb.Eq("Enabled", true),
        fb.Not(fb.Exists("SupersededByOfferingId"))))).ToListAsync();
    if (referencedOfferings.Count == 0) return null;

    var logicalIds = referencedOfferings.Select(item => item.GetStringOrEmpty("LogicalModelId")).Distinct().ToList();
    var logicals = await logicalModels.Find(TenantAccess.Filter(http, fb.In("_id", logicalIds))).ToListAsync();
    var platformId = proposedModel.AsNullableString("PlatformId");
    var platform = string.IsNullOrWhiteSpace(platformId)
        ? null
        : await platforms.Find(TenantAccess.Filter(http, fb.Eq("_id", platformId))).FirstOrDefaultAsync();
    foreach (var offering in referencedOfferings)
    {
        var logical = logicals.FirstOrDefault(item => item.GetStringOrEmpty("_id") == offering.GetStringOrEmpty("LogicalModelId"));
        if (logical is null) continue;
        var error = ValidateAsrOfferingContract(logical, offering, proposedModel, platform);
        if (error is not null)
            return $"认领模型会破坏已启用 ASR Offering {offering.GetStringOrEmpty("_id")}：{error}";
    }
    return null;
}

static async Task<string?> ValidateAsrPlatformMutationAsync(
    HttpContext http,
    BsonDocument proposedPlatform,
    IMongoCollection<BsonDocument> models,
    IMongoCollection<BsonDocument> offerings,
    IMongoCollection<BsonDocument> logicalModels)
{
    var platformId = proposedPlatform.GetStringOrEmpty("_id");
    if (platformId.Length == 0) return null;
    var fb = Builders<BsonDocument>.Filter;
    var affectedModels = await models.Find(TenantAccess.Filter(http, fb.Eq("PlatformId", platformId))).ToListAsync();
    if (affectedModels.Count == 0) return null;
    var modelIds = affectedModels.Select(item => item.GetStringOrEmpty("_id")).Where(id => id.Length > 0).ToList();
    var referencedOfferings = await offerings.Find(TenantAccess.Filter(http, fb.And(
        fb.Eq("TargetKind", "model"),
        fb.In("TargetId", modelIds),
        fb.Eq("Enabled", true),
        fb.Not(fb.Exists("SupersededByOfferingId"))))).ToListAsync();
    if (referencedOfferings.Count == 0) return null;

    var logicalIds = referencedOfferings.Select(item => item.GetStringOrEmpty("LogicalModelId")).Distinct().ToList();
    var logicals = await logicalModels.Find(TenantAccess.Filter(http, fb.In("_id", logicalIds))).ToListAsync();
    foreach (var offering in referencedOfferings)
    {
        var logical = logicals.FirstOrDefault(item => item.GetStringOrEmpty("_id") == offering.GetStringOrEmpty("LogicalModelId"));
        var model = affectedModels.FirstOrDefault(item => item.GetStringOrEmpty("_id") == offering.GetStringOrEmpty("TargetId"));
        if (logical is null || model is null) continue;
        var error = ValidateAsrOfferingContract(logical, offering, model, proposedPlatform);
        if (error is not null)
            return $"认领平台会破坏已启用 ASR Offering {offering.GetStringOrEmpty("_id")}：{error}";
    }
    return null;
}

static async Task<string?> ValidateAsrBulkMutationAsync(
    HttpContext http,
    IReadOnlyCollection<BsonDocument> proposedPlatforms,
    IReadOnlyCollection<BsonDocument> proposedModels,
    IMongoCollection<BsonDocument> platforms,
    IMongoCollection<BsonDocument> models,
    IMongoCollection<BsonDocument> offerings,
    IMongoCollection<BsonDocument> logicalModels)
{
    var currentPlatforms = await platforms.Find(TenantAccess.Filter(http)).ToListAsync();
    var currentModels = await models.Find(TenantAccess.Filter(http)).ToListAsync();
    var platformSnapshot = currentPlatforms
        .Concat(proposedPlatforms)
        .Where(item => item.GetStringOrEmpty("_id").Length > 0)
        .GroupBy(item => item.GetStringOrEmpty("_id"), StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);
    var modelSnapshot = currentModels
        .Concat(proposedModels)
        .Where(item => item.GetStringOrEmpty("_id").Length > 0)
        .GroupBy(item => item.GetStringOrEmpty("_id"), StringComparer.Ordinal)
        .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);

    var fb = Builders<BsonDocument>.Filter;
    var enabledOfferings = await offerings.Find(TenantAccess.Filter(http, fb.And(
        fb.Eq("TargetKind", "model"),
        fb.Eq("Enabled", true),
        fb.Not(fb.Exists("SupersededByOfferingId"))))).ToListAsync();
    var logicalIds = enabledOfferings.Select(item => item.GetStringOrEmpty("LogicalModelId")).Distinct().ToList();
    var logicals = await logicalModels.Find(TenantAccess.Filter(http, fb.In("_id", logicalIds))).ToListAsync();
    foreach (var offering in enabledOfferings)
    {
        var logical = logicals.FirstOrDefault(item => item.GetStringOrEmpty("_id") == offering.GetStringOrEmpty("LogicalModelId"));
        modelSnapshot.TryGetValue(offering.GetStringOrEmpty("TargetId"), out var model);
        var platformId = model?.AsNullableString("PlatformId");
        var platform = !string.IsNullOrWhiteSpace(platformId) && platformSnapshot.TryGetValue(platformId, out var matched)
            ? matched
            : null;
        if (logical is null || model is null) continue;
        var error = ValidateAsrOfferingContract(logical, offering, model, platform);
        if (error is not null)
            return $"批量认领会破坏已启用 ASR Offering {offering.GetStringOrEmpty("_id")}：{error}";
    }
    return null;
}

static bool IsSafeOfferingEndpointPath(string? value)
{
    if (string.IsNullOrWhiteSpace(value)) return true;
    var path = value.Trim();
    return path.Length <= 500
           && !path.StartsWith("//", StringComparison.Ordinal)
           && !path.Contains("http://", StringComparison.OrdinalIgnoreCase)
           && !path.Contains("https://", StringComparison.OrdinalIgnoreCase)
           && !path.Contains('\\')
           && !path.Any(char.IsControl);
}

static void ApplyModelOfferingUpdate(BsonDocument document, UpdateModelOfferingRequest body)
{
    SetOrRemove("UpstreamModelId", body.UpstreamModelId);
    SetOrRemove("Protocol", body.Protocol?.ToLowerInvariant());
    SetOrRemove("EndpointPath", body.EndpointPath);
    if (body.Priority is not null) document["Priority"] = Math.Clamp(body.Priority.Value, 0, 10000);
    if (body.Weight is not null) document["Weight"] = Math.Clamp(body.Weight.Value, 1, 10000);
    if (body.MaxConcurrency is not null)
    {
        if (body.MaxConcurrency > 0) document["MaxConcurrency"] = body.MaxConcurrency.Value;
        else document.Remove("MaxConcurrency");
    }
    if (body.RateLimitPerMinute is not null)
    {
        if (body.RateLimitPerMinute > 0) document["RateLimitPerMinute"] = body.RateLimitPerMinute.Value;
        else document.Remove("RateLimitPerMinute");
    }
    SetOrRemove("Notes", body.Notes);

    void SetOrRemove(string field, string? value)
    {
        if (value is null) return;
        if (string.IsNullOrWhiteSpace(value)) document.Remove(field);
        else document[field] = value.Trim();
    }
}

static LogicalModelItem MapLogicalModel(
    BsonDocument logical,
    IReadOnlyCollection<BsonDocument> offeringDocs,
    IReadOnlyCollection<BsonDocument> modelDocs,
    IReadOnlyCollection<BsonDocument> exchangeDocs,
    IReadOnlyCollection<BsonDocument> platformDocs)
{
    var logicalId = logical.GetStringOrEmpty("_id");
    var modelById = modelDocs.Where(x => !string.IsNullOrWhiteSpace(x.GetStringOrEmpty("_id")))
        .ToDictionary(x => x.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var exchangeById = exchangeDocs.Where(x => !string.IsNullOrWhiteSpace(x.GetStringOrEmpty("_id")))
        .ToDictionary(x => x.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var platformById = platformDocs.Where(x => !string.IsNullOrWhiteSpace(x.GetStringOrEmpty("_id")))
        .ToDictionary(x => x.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var offerings = offeringDocs
        .Where(x => string.Equals(x.GetStringOrEmpty("LogicalModelId"), logicalId, StringComparison.Ordinal))
        .Where(x => !x.Contains("SupersededByOfferingId"))
        .OrderBy(x => x.AsNullableInt("Priority") ?? 100)
        .Select(x =>
        {
            var targetKind = x.AsNullableString("TargetKind") ?? "model";
            var targetId = x.GetStringOrEmpty("TargetId");
            BsonDocument? target = null;
            string? providerName = null;
            if (string.Equals(targetKind, "exchange", StringComparison.OrdinalIgnoreCase))
            {
                exchangeById.TryGetValue(targetId, out target);
            }
            else if (modelById.TryGetValue(targetId, out target))
            {
                var platformId = target.AsNullableString("PlatformId");
                if (!string.IsNullOrWhiteSpace(platformId) && platformById.TryGetValue(platformId, out var platform))
                    providerName = platform.AsNullableString("Name");
            }
            return new ModelOfferingItem
            {
                Id = x.GetStringOrEmpty("_id"),
                LogicalModelId = logicalId,
                TargetKind = targetKind,
                TargetId = targetId,
                TargetName = target?.AsNullableString("Name") ?? target?.AsNullableString("ModelName") ?? targetId,
                ProviderName = providerName,
                UpstreamModelId = x.AsNullableString("UpstreamModelId"),
                Protocol = x.AsNullableString("Protocol"),
                EndpointPath = x.AsNullableString("EndpointPath"),
                Priority = x.AsNullableInt("Priority") ?? 100,
                Weight = x.AsNullableInt("Weight") ?? 100,
                Enabled = x.AsNullableBool("Enabled") ?? true,
                HealthStatus = x.AsNullableInt("HealthStatus") ?? 0,
                ConsecutiveFailures = x.AsNullableInt("ConsecutiveFailures") ?? 0,
                ConsecutiveSuccesses = x.AsNullableInt("ConsecutiveSuccesses") ?? 0,
                MaxConcurrency = x.AsNullableInt("MaxConcurrency"),
                RateLimitPerMinute = x.AsNullableInt("RateLimitPerMinute"),
                Notes = x.AsNullableString("Notes"),
            };
        }).ToList();
    return new LogicalModelItem
    {
        Id = logicalId,
        PublicId = logical.GetStringOrEmpty("PublicId"),
        Name = logical.GetStringOrEmpty("Name"),
        ModelType = logical.GetStringOrEmpty("ModelType"),
        Capabilities = logical.AsStringList("Capabilities"),
        AllowedAppCallerCodes = logical.AsStringList("AllowedAppCallerCodes"),
        RoutingStrategy = logical.AsNullableString("RoutingStrategy") ?? "priority",
        Enabled = logical.AsNullableBool("Enabled") ?? true,
        DisplayOrder = logical.AsNullableInt("DisplayOrder") ?? 100,
        Description = logical.AsNullableString("Description"),
        CreatedAt = logical.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = logical.AsNullableUtcDateTime("UpdatedAt").ToIso(),
        Offerings = offerings,
    };
}

static async Task<ImageLayeringCapabilityStatus> BuildImageLayeringCapabilityStatusAsync(
    IMongoCollection<BsonDocument> exchanges,
    IMongoCollection<BsonDocument> logicalModels,
    IMongoCollection<BsonDocument> offerings,
    IMongoCollection<BsonDocument> requestLogs,
    string tenantId,
    CancellationToken ct)
{
    var fb = Builders<BsonDocument>.Filter;
    var exchange = await exchanges.Find(fb.And(
            fb.Eq("TenantId", tenantId),
            fb.Eq("TransformerType", FalImageLayeringProvisioning.TransformerType),
            fb.Eq("Models.ModelId", FalImageLayeringProvisioning.ModelId)))
        .FirstOrDefaultAsync(ct);
    var logicalModel = await logicalModels.Find(fb.And(
            fb.Eq("TenantId", tenantId),
            fb.Eq("PublicIdNormalized", FalImageLayeringProvisioning.CapabilityId)))
        .FirstOrDefaultAsync(ct);

    var hasKey = ImageLayeringCapabilityRules.HasKey(exchange);
    var exchangeId = exchange?.GetStringOrEmpty("_id");
    var logicalModelId = logicalModel?.GetStringOrEmpty("_id");
    var offering = string.IsNullOrWhiteSpace(logicalModelId)
        ? null
        : await offerings.Find(fb.And(
                fb.Eq("TenantId", tenantId),
                fb.Eq("LogicalModelId", logicalModelId),
                fb.Eq("TargetKind", "exchange"),
                fb.Eq("TargetId", exchangeId),
                fb.Eq("UpstreamModelId", FalImageLayeringProvisioning.ModelId),
                fb.Ne("Enabled", false)))
            .FirstOrDefaultAsync(ct);
    var offeringId = offering?.GetStringOrEmpty("_id");
    // 注意：上面查 exchange / logicalModel 时刻意不带 Enabled 过滤——禁用的配置仍要被查出来，
    // 这样 state 落到 incomplete（而不是 not-installed）、ExchangeId 也照常返回，前端能跳过去重新启用。
    // 「能不能真跑」的判断收在 IsInstalled 里，与 ModelResolver 的解析条件对齐。
    var installed = ImageLayeringCapabilityRules.IsInstalled(
        exchange, logicalModel, offering, FalImageLayeringProvisioning.ModelId);

    BsonDocument? verifiedLog = null;
    if (installed)
    {
        var successFilter = fb.And(
            fb.Eq("TenantId", tenantId),
            fb.Eq("LogicalModelPublicId", FalImageLayeringProvisioning.CapabilityId),
            fb.Gte("StatusCode", 200),
            fb.Lt("StatusCode", 300),
            fb.Eq(ImageLayeringCapabilityRules.UpstreamModelLogField, FalImageLayeringProvisioning.ModelId),
            fb.Gt("ImageSuccessCount", 0));
        verifiedLog = await requestLogs.Find(successFilter)
            .Sort(Builders<BsonDocument>.Sort.Descending("EndedAt").Descending("CreatedAt"))
            .FirstOrDefaultAsync(ct);
    }
    var verifiedAt = verifiedLog?.AsNullableUtcDateTime("EndedAt")
                     ?? verifiedLog?.AsNullableUtcDateTime("CreatedAt");
    var verified = verifiedLog is not null;
    var anyPieceExists = exchange is not null || logicalModel is not null || offering is not null;

    return new ImageLayeringCapabilityStatus
    {
        State = verified ? "verified" : installed ? "installed" : anyPieceExists ? "incomplete" : "not-installed",
        Installed = installed,
        Verified = verified,
        HasKey = hasKey,
        ExchangeId = string.IsNullOrWhiteSpace(exchangeId) ? null : exchangeId,
        LogicalModelId = string.IsNullOrWhiteSpace(logicalModelId) ? null : logicalModelId,
        OfferingId = string.IsNullOrWhiteSpace(offeringId) ? null : offeringId,
        LastVerifiedAt = verifiedAt.HasValue ? verifiedAt.Value.ToUniversalTime().ToString("O") : null,
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
        Version = d.AsNullableLong("Version") ?? 0,
        CreatedAt = d.AsNullableUtcDateTime("CreatedAt").ToIso(),
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
    };
}

static GatewayAppCallerItem MapGatewayAppCaller(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    TeamId = d.AsNullableString("TeamId"),
    AppCallerCode = d.GetStringOrEmpty("AppCallerCode"),
    RequestType = d.GetStringOrEmpty("RequestType"),
    SourceSystem = d.GetStringOrEmpty("SourceSystem"),
    IngressProtocol = d.GetStringOrEmpty("IngressProtocol"),
    ObservedIngressProtocols = GetObservedIngressProtocols(d),
    Title = d.AsNullableString("Title"),
    Status = d.AsNullableString("Status") ?? "discovered",
    ModelPoolId = d.AsNullableString("ModelPoolId"),
    AllowedModelPoolIds = GetStringArray(d, "AllowedModelPoolIds"),
    DefaultModelPoolId = d.AsNullableString("DefaultModelPoolId"),
    AllowCrossPoolFallback = d.AsNullableBool("AllowCrossPoolFallback") ?? false,
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

static bool IsValidSelfServiceAppCaller(string appCallerCode, string requestType)
{
    if (appCallerCode.Length is 0 or > 200 || requestType is not ("chat" or "vision")) return false;
    var separator = appCallerCode.IndexOf("::", StringComparison.Ordinal);
    if (separator <= 0 || separator != appCallerCode.LastIndexOf("::", StringComparison.Ordinal)) return false;
    var declaredType = appCallerCode[(separator + 2)..];
    if (!string.Equals(declaredType, requestType, StringComparison.Ordinal)) return false;
    var segments = appCallerCode[..separator].Split('.', StringSplitOptions.None);
    return segments.Length >= 2 && segments.All(IsKebabCaseAppCallerSegment) && IsKebabCaseAppCallerSegment(declaredType);
}

static bool IsKebabCaseAppCallerSegment(string value)
    => value.Length > 0
       && value[0] is >= 'a' and <= 'z'
       && value.All(ch => ch is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');

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
    string? requestType,
    IReadOnlyList<string>? allowedModelPoolIds = null,
    string? defaultModelPoolId = null)
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

    var strictPoolIds = (allowedModelPoolIds ?? [])
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Select(value => value.Trim())
        .Distinct(StringComparer.Ordinal)
        .ToList();
    var effectivePoolId = strictPoolIds.Count > 0 ? defaultModelPoolId?.Trim() : modelPoolId?.Trim();
    if (strictPoolIds.Count > 0
        && (string.IsNullOrWhiteSpace(effectivePoolId) || !strictPoolIds.Contains(effectivePoolId, StringComparer.Ordinal)))
    {
        return "active appCaller 的默认模型池必须属于允许模型池集合。";
    }
    if (string.IsNullOrWhiteSpace(effectivePoolId))
    {
        return "active appCaller 必须绑定 llm_gateway.llmgw_model_pools 中的 GW 权威模型池。";
    }

    var pool = await gwModelPools
        .Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            Builders<BsonDocument>.Filter.Eq("_id", effectivePoolId)))
        .FirstOrDefaultAsync();
    if (pool is null)
    {
        return $"active appCaller 绑定的模型池 {effectivePoolId} 不是 GW 权威模型池；请先在 /pools 认领或创建。";
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
        return $"active appCaller 默认使用的 GW 模型池 {effectivePoolId} 没有可解析、非 unavailable 的成员；请先在 /pools 补齐 enabled 模型或 Exchange。";
    }

    return null;
}

static async Task<string?> ValidateDefaultGatewayPoolMembersAsync(
    IMongoCollection<BsonDocument> gwModelPoolTypes,
    IMongoCollection<BsonDocument> gwPlatforms,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> gwModelExchanges,
    BsonDocument pool,
    BsonArray nextModels)
{
    if (!await IsCurrentDefaultPoolAsync(gwModelPoolTypes, pool))
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

    // 池子在改动之前就已经零可用成员时，这条守卫拦不住任何损害——损害早就发生了，
    // 它只会把「唯一能修好它的那次改动」一起挡在门外，形成谁也解不开的死锁
    // （判据取的是变更前的状态，却用来 gate 那个会改变该状态的变更）。
    // 所以只在「本次改动确实把一个原本可用的默认池弄成不可用」时才拒绝。
    if (!await HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, pool))
    {
        return null;
    }

    return "默认模型池必须保留至少一个可用成员；请先添加可用模型，再删除或覆盖现有成员。";
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

static List<string> GetReferencedModelPoolIds(BsonDocument d)
{
    var ids = new List<string>();
    void Add(string? value)
    {
        if (!string.IsNullOrWhiteSpace(value) && !ids.Contains(value, StringComparer.Ordinal))
            ids.Add(value);
    }

    Add(d.AsNullableString("ModelPoolId"));
    Add(d.AsNullableString("DefaultModelPoolId"));
    foreach (var id in GetStringArray(d, "AllowedModelPoolIds")) Add(id);
    return ids;
}

static bool AllReferencedModelPoolsExist(BsonDocument d, HashSet<string> gatewayPoolIds)
{
    var references = GetReferencedModelPoolIds(d);
    return references.Count > 0 && references.All(gatewayPoolIds.Contains);
}

static bool IsAppCallerUsable(BsonDocument d, HashSet<string> usablePoolIds)
{
    var references = GetReferencedModelPoolIds(d);
    if (references.Count == 0) return false;

    var defaultPoolId = d.AsNullableString("DefaultModelPoolId")
        ?? d.AsNullableString("ModelPoolId");
    if (string.IsNullOrWhiteSpace(defaultPoolId))
        return references.Any(usablePoolIds.Contains);

    // 默认关闭跨池回退：默认池不可用时，即使次选池健康，也不能把
    // “可发布/可用”报告成 true，因为真实请求仍只会命中默认池。
    if (usablePoolIds.Contains(defaultPoolId)) return true;
    var allowCrossPoolFallback = d.AsNullableBool("AllowCrossPoolFallback") ?? false;
    return allowCrossPoolFallback
        && references.Any(poolId => !string.Equals(poolId, defaultPoolId, StringComparison.Ordinal)
                                    && usablePoolIds.Contains(poolId));
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
    { "policyHash", doc["PolicyHash"] },
};

// 统一 JSON 输出（带信封 + 指定状态码）。
// 唯一索引冲突的统一判定：findAndModify 走 MongoCommandException，普通写入走 MongoWriteException，
// 两条路径的错误码都是 11000。分散着各判一次迟早漏一条，所以只在这里判。
static bool IsDuplicateKey(Exception ex) => ex switch
{
    MongoCommandException command => command.Code == 11000,
    MongoWriteException write => write.WriteError?.Category == ServerErrorCategory.DuplicateKey,
    _ => false,
};

static IResult Json<T>(T value, JsonSerializerOptions options, int statusCode = 200)
    => Results.Json(value, options, statusCode: statusCode);

static string? NormalizeCommitFilter(string? value)
{
    var trimmed = (value ?? string.Empty).Trim();
    if (trimmed.StartsWith("sha-", StringComparison.OrdinalIgnoreCase))
        trimmed = trimmed[4..];
    return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed.ToLowerInvariant();
}

static async Task<long> ResetOfferingsAfterCredentialChangeAsync(
    HttpContext http,
    string objectType,
    IEnumerable<string> changedIds,
    IMongoCollection<BsonDocument> gatewayModels,
    IMongoCollection<BsonDocument> offerings)
{
    var ids = changedIds
        .Where(id => !string.IsNullOrWhiteSpace(id))
        .Distinct(StringComparer.Ordinal)
        .ToList();
    if (ids.Count == 0) return 0;

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var targetKind = objectType;
    var targetIds = ids;
    if (string.Equals(objectType, "platform", StringComparison.Ordinal))
    {
        targetKind = "model";
        var modelDocs = await gatewayModels.Find(Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
                Builders<BsonDocument>.Filter.In("PlatformId", ids)))
            .Project(Builders<BsonDocument>.Projection.Include("_id"))
            .ToListAsync();
        targetIds = modelDocs.Select(item => item.GetStringOrEmpty("_id")).ToList();
    }
    if (targetIds.Count == 0) return 0;

    var filter = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("TargetKind", targetKind),
        Builders<BsonDocument>.Filter.In("TargetId", targetIds));
    var update = Builders<BsonDocument>.Update
        .Set("HealthStatus", 0)
        .Set("ConsecutiveFailures", 0)
        .Set("ConsecutiveSuccesses", 0)
        .Set("UpdatedAt", DateTime.UtcNow);
    var result = await offerings.UpdateManyAsync(filter, update);
    return result.ModifiedCount;
}

static async Task RunGatewayRecoveryLoopAsync(
    IMongoDatabase database,
    ILogger logger,
    CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
    try
    {
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                var repaired = await GatewayRecoveryOperations.RepairExpiredAsync(database);
                if (repaired > 0)
                    logger.LogWarning("LLMGW recovery repaired {Count} expired operations", repaired);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "LLMGW recovery tick failed; the next tick will retry");
            }
        }
    }
    catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
    {
    }
}
