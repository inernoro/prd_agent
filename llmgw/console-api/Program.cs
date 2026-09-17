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
using PrdAgent.LlmGw.AppCallers;
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
// 有就用，没有就为空。正式环境必须显式注入 LLMGW_MAP_HOME_URL；CDS 预览继续消费
// 平台下发的 CDS_PREVIEW_URL。前端不得根据某个部署域名猜正式入口。
var mapHomeUrl = (
    Environment.GetEnvironmentVariable("LLMGW_MAP_HOME_URL")
    ?? Environment.GetEnvironmentVariable("CDS_PREVIEW_URL"))?.Trim();

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
// 会话默认 30 天且用后自动续期（响应头 X-Gw-Token 换发），只要在用就不会掉登录。
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
var stableSmokeFederationEnabled = config.GetValue<bool>("StableSmokeFederation:Enabled", false);
var stableSmokeAllowedUsers = StableSmokeFederation.ReadAllowedUsernames(
    config["StableSmokeFederation:AllowedUsernames"]);
var stableSmokeRole = StableSmokeFederation.NormalizeRole(config["StableSmokeFederation:Role"]);
var stableSmokeLifetime = TimeSpan.FromMinutes(StableSmokeFederation.NormalizeSessionMinutes(
    config.GetValue<int>("StableSmokeFederation:SessionMinutes", StableSmokeFederation.DefaultSessionMinutes)));
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
// 删线路前要问一句「还有没有在途任务等着它」，那批任务在 MAP 库里（见 OfferingReferencePolicy）。
var videoGenRuns = mapDatabase.GetCollection<BsonDocument>(OfferingReferencePolicy.VideoRunCollectionName);
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
// 能力契约迁移：把存量逻辑模型的 Capabilities 归一到规范值并盖上契约版本。
// 幂等——第二次启动 Rewritten=0。未知能力不丢弃，逐个点名进日志，
// 由发布门禁（/gw/capability-audit）阻断，不允许静默带病上线。
var capabilityMigration = await LogicalModelCapabilityPolicy.MigrateAsync(
    gwLogicalModels,
    CancellationToken.None);
Console.WriteLine(
    "[capability-contract] migrate scanned={0} rewritten={1} residualAliases={2} unversioned={3} unknownObjects={4}",
    capabilityMigration.Scanned,
    capabilityMigration.Rewritten,
    capabilityMigration.ResidualLegacyAliases,
    capabilityMigration.StillUnversioned,
    capabilityMigration.UnknownFindings.Count);
foreach (var finding in capabilityMigration.UnknownFindings)
{
    Console.WriteLine(
        "[capability-contract] UNKNOWN capability on logicalModel publicId={0} modelType={1} tokens={2}",
        finding.PublicId,
        finding.ModelType,
        string.Join(",", finding.UnknownCapabilities));
}
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
/*
  「同租户同用途最多一个默认」升成库级不变量。

  端点里的「先清旧默认、再置新的」在单个请求内是对的，但两个管理员同时改时，
  两边都能清完各自看到的旧默认、再各自置上自己那个——两次写都成功，库里于是有两个默认，
  而不点名的请求解析到哪个全看排序，两个人的界面都显示「已生效」。
  应用层补不了这个洞：Mongo 没有跨文档的原子性可用，任何「查一下有没有别人」都在竞态窗口里。

  部分唯一索引把它变成 DB 层的事：第二个写直接撞 E11000，端点如实回 409。
  存量里已经有两个默认时建不出来——那不是崩溃的理由，如实报出来让人去清理，
  在那之前端点仍按老样子工作（degradation-must-alarm：降级要响铃，不许静默）。
*/
await IndexAdvisory.ReportIfMissingAsync(
    gwLogicalModels,
    "uniq_llmgw_logical_default_per_type",
    "两个管理员同时把不同模型设成同一个用途的默认时，两次写都会成功，库里于是有两个默认，"
    + "而不点名的请求解析到哪个全看排序，两个人的界面都显示「已生效」");

/*
  认领也是同一类不变量：同用途下一个调用方最多被一个模型认领，而端点里的
  「先摘别人、再置自己」同样挡不住两个管理员同时改。

  认领存在数组里，所以走**多键**唯一索引：数组的每个元素各生成一个键
  (TenantId, ModelType, 某个调用方 code)，跨文档唯一——正好是要的那条不变量。

  部分过滤器判的是「数组里至少有一个字符串元素」：空数组在多键索引里会被记成
  undefined，那样所有「一个都没认领」的模型会互相撞车，索引根本建不起来。
*/
await IndexAdvisory.ReportIfMissingAsync(
    gwLogicalModels,
    "uniq_llmgw_logical_claim_per_type",
    "两个管理员同时把同一个调用方认领到不同模型时，两次写都会成功，那个调用方于是被两条模型"
    + "同时认领着，解析到哪个全看排序");

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

var gwMigrations = gatewayDatabase.GetCollection<BsonDocument>("llmgw_migrations");

/*
  一次性存量放行的执行体。判据（「此刻缺标记」）之所以能用，全靠外面这层
  「这个 id 跑过没有」的持久标记把它限定在**某一个时刻**；单独看它太窄，
  会把日后绕过控制台写库塞进来的模型也一起放行。所以两者必须成对出现，
  也因此收敛成这一个函数——多一份拷贝就多一处会漏掉迁移标记的写法。
*/
async Task<DateTime?> ClaimOneShotMigrationAsync(string migrationId)
{
    var claimedAt = DateTime.UtcNow;
    try
    {
        // 抢占式认领：_id 唯一索引保证多副本同时启动时只有一个能插进去。
        // 认领后崩溃的情况用 ClaimedAt 兜底——超过 10 分钟没写完成时间，允许下一个进程接手。
        await gwMigrations.InsertOneAsync(new BsonDocument
        {
            { "_id", migrationId },
            { "ClaimedAt", claimedAt },
        });
        return claimedAt;
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        var takeover = await gwMigrations.FindOneAndUpdateAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", migrationId),
                Builders<BsonDocument>.Filter.Exists("CompletedAt", false),
                Builders<BsonDocument>.Filter.Lt("ClaimedAt", claimedAt.AddMinutes(-10))),
            Builders<BsonDocument>.Update.Set("ClaimedAt", claimedAt));
        return takeover is null ? null : claimedAt;
    }
}

async Task CompleteOneShotMigrationAsync(string migrationId, long stampedCount)
{
    await gwMigrations.UpdateOneAsync(
        Builders<BsonDocument>.Filter.Eq("_id", migrationId),
        Builders<BsonDocument>.Update
            .Set("CompletedAt", DateTime.UtcNow)
            .Set("StampedCount", stampedCount));
}

/*
  `affected` 为 null = 无差别补标记，**只有名录门上线那一次（v1）配这么做**：
  那之前根本没有「放行标记」这回事，库里每一条都该被视为「门上线前已入库」。

  之后每一次**口径收紧**都必须给出自己的 affected：判据是
  「旧口径判成名录内、新口径判成名录外」。用「此刻缺标记」当判据太宽——
  v1 跑完之后绕过控制台直接写库塞进来的模型同样缺标记，下一个窗口会顺手把它们一起放行，
  而那正是这道门要拦的那一种。等于每加一条迁移就把门重新开一次，
  与当初把迁移改成一次性所要解决的问题一模一样，只是换了个触发方式。
*/
async Task<long> RunCatalogGrandfatherAsync(
    string migrationId,
    string stampedBy,
    Func<string?, bool>? affected = null)
{
    var claimedAt = await ClaimOneShotMigrationAsync(migrationId);
    if (claimedAt is null) return -1;

    var unstamped = Builders<BsonDocument>.Filter.Exists("AllowedOutsideCatalog", false);
    var stamp = Builders<BsonDocument>.Update
        .Set("AllowedOutsideCatalog", true)
        .Set("AllowedOutsideCatalogBy", stampedBy)
        .Set("AllowedOutsideCatalogAt", claimedAt.Value);

    if (affected is null)
    {
        var all = await gwModels.UpdateManyAsync(unstamped, stamp);
        await CompleteOneShotMigrationAsync(migrationId, all.ModifiedCount);
        return all.ModifiedCount;
    }

    // 逐条判「这次收紧是否真的影响到它」。只取 _id 与模型名，判中的再一次性盖戳。
    var candidates = await gwModels
        .Find(unstamped)
        .Project(Builders<BsonDocument>.Projection.Include("ModelName"))
        .ToListAsync();
    var targets = candidates
        .Where(doc => affected(doc.AsNullableString("ModelName")))
        .Select(doc => doc["_id"])
        .ToList();
    if (targets.Count == 0)
    {
        await CompleteOneShotMigrationAsync(migrationId, 0);
        return 0;
    }

    var scoped = await gwModels.UpdateManyAsync(
        Builders<BsonDocument>.Filter.And(unstamped, Builders<BsonDocument>.Filter.In("_id", targets)),
        stamp);
    await CompleteOneShotMigrationAsync(migrationId, scoped.ModifiedCount);
    return scoped.ModifiedCount;
}

/*
  存量放行之一（一次性，幂等）：名录门上线。

  名录门是后加的：在它存在之前导入的模型没有「放行标记」这回事，而数据面那道门
  只认标记不认来历。不补这一手，升级的那一刻所有名录外的存量模型会集体开始被拒——
  用「变更前就有的状态」去卡变更本身，正是 predicate-and-wiring-discipline 形状 5。

  所以这里把**已经在库里**的模型一律补成「已放行」，并把放行人记成迁移而不是某个管理员：
  它们确实没被任何人审过，这一点必须如实写在审计字段里，不许伪装成有人点过头。
  从此往后，新导入的名录外模型只能由管理员在导入时显式放行（Program 的导入路径盖戳）。

  **只许跑一次，靠库里的迁移标记记住，不能靠「没有这个字段」当判据。**
  那个判据太窄：它认的是「此刻缺标记」，而要表达的是「名录门上线前就已入库」。
  两者在第一次启动时恰好重合，之后就分道扬镳——绕过控制台直接写库塞进来的模型
  （正是这道门要拦的那一种）同样缺标记，下一次重启就会被这段代码自动放行，
  门相当于每重启一次自己开一道缝。所以标记记在库里，跑过就永不再跑。
*/
var grandfatherCount = await RunCatalogGrandfatherAsync(
    "model-catalog-grandfather-v1",
    "存量迁移（名录门上线前已入库，未经人工审阅）");
if (grandfatherCount >= 0)
{
    app.Logger.LogInformation(
        "[ModelCatalog] 名录门上线迁移已执行（一次性）：为 {Count} 条存量模型补上放行标记（未经人工审阅，来历见审计字段）",
        grandfatherCount);
}

/*
  存量放行之二（一次性，幂等）：归一化口径收紧。

  名录归一化此前把斜杠前的**任意**前缀都当厂商剥掉，于是 `private-provider/gpt-4o`
  会被认成登记过的 `gpt-4o` 并继承它的能力登记。收紧成「只剥名录自己登记过的厂商段」
  之后，一批**在旧口径下判成名录内、因而导入时没有盖过放行标记**的存量模型，
  会在新口径下变成名录外——而上一条迁移早就跑完了，它们没有任何补戳的时机，
  enforce 档下会当场开始被拒。那同样是形状 5：拿口径变更之前的状态去卡这次变更。

  所以口径收紧要自带**它自己的**一次性窗口：同一套认领机制、另一个迁移 id，
  跑完即关。放行人如实写成「口径收紧前已入库」，不冒充有人审过。
*/
var strictPrefixCount = await RunCatalogGrandfatherAsync(
    "model-catalog-grandfather-v2-strict-vendor-prefix",
    "存量迁移（名录归一化口径收紧前已入库，未经人工审阅）",
    // 只补「旧口径（任意前缀都剥）判成名录内、新口径判成名录外」的那些。
    id => LegacyCatalogRules.NeedsAllowanceAfterTightening(
        id, LegacyCatalogRules.WasInCatalogBeforeStrictVendorPrefix));
if (strictPrefixCount >= 0)
{
    app.Logger.LogInformation(
        "[ModelCatalog] 归一化口径收紧迁移已执行（一次性）：为 {Count} 条存量模型补上放行标记（未经人工审阅，来历见审计字段）",
        strictPrefixCount);
}

/*
  存量放行之四（一次性，幂等）：标点口径收紧。

  归一化此前把 `.` 与 `_` 一律改写成 `-`，等于**凭标点合成别名**：从没登记过的
  `gpt-4-1` / `gpt_4.1` 会落到登记过的 `gpt-4.1` 上，继承它的用途与能力，
  并且因为「判成名录内」而不需要任何放行标记。收紧成「标点原样、真实存在的另一种写法
  逐条登记为别名」之后，一批**在旧口径下判成名录内、因而导入时没有盖过放行标记**的
  存量模型会变成名录外——前几条迁移早已跑完，它们没有补戳的时机。

  与 v2 同形，所以处置也同形：口径收紧自带**它自己的**一次性窗口，跑完即关。
  放行人如实写成「口径收紧前已入库」，不冒充有人审过。
*/
var strictPunctuationCount = await RunCatalogGrandfatherAsync(
    "model-catalog-grandfather-v3-strict-punctuation",
    "存量迁移（名录标点口径收紧前已入库，未经人工审阅）",
    // 只补「旧口径（标点合并）判成名录内、新口径判成名录外」的那些。
    id => LegacyCatalogRules.NeedsAllowanceAfterTightening(
        id, LegacyCatalogRules.WasInCatalogBeforeStrictPunctuation));
if (strictPunctuationCount >= 0)
{
    app.Logger.LogInformation(
        "[ModelCatalog] 标点口径收紧迁移已执行（一次性）：为 {Count} 条存量模型补上放行标记（未经人工审阅，来历见审计字段）",
        strictPunctuationCount);
}

/*
  存量放行之五（一次性，幂等）：后缀口径收紧。

  归一化此前把日期快照后缀（`-20240806` / `-2024-08-06`）与 `-latest` 一律剥掉，
  等于**凭后缀合成别名**：从没登记过的 `gpt-4o-20990101` 会落到登记过的 `gpt-4o` 上，
  继承它的用途与能力，并且因为「判成名录内」而不需要任何放行标记。收紧成「标识按原样比、
  真实存在的日期与 latest 写法逐条登记为别名」之后，一批在旧口径下判成名录内、
  因而导入时没有盖过放行标记的存量模型会变成名录外——前几条迁移早已跑完。

  与 v2/v3 同形（同一种病，只是换了个后缀），所以处置也同形：自带一次性窗口，跑完即关。
*/
var strictSuffixCount = await RunCatalogGrandfatherAsync(
    "model-catalog-grandfather-v4-strict-suffix",
    "存量迁移（名录后缀口径收紧前已入库，未经人工审阅）",
    // 只补「旧口径（剥日期与 -latest）判成名录内、新口径判成名录外」的那些。
    id => LegacyCatalogRules.NeedsAllowanceAfterTightening(
        id, LegacyCatalogRules.WasInCatalogBeforeStrictSuffix));
if (strictSuffixCount >= 0)
{
    app.Logger.LogInformation(
        "[ModelCatalog] 后缀口径收紧迁移已执行（一次性）：为 {Count} 条存量模型补上放行标记（未经人工审阅，来历见审计字段）",
        strictSuffixCount);
}

/*
  存量放行之三（一次性，幂等）：兑换所的 per-model 放行标记。

  数据面此前对兑换所来的模型认的是**容器**——「这个 PlatformId 是一条兑换所记录吗」，
  是就整条放行。容器判据太宽：往兑换所里加一个从没被人看过的别名照样过，
  那正是名录门要拦的形态，只是换了个集合。现在改成认**条目**上的放行标记，
  与手工新增模型同一套依据；写入路径（BuildExchangeModels）逐条盖戳。

  存量兑换所是在盖戳之前建的，条目上没有这个字段——不补这一手，判据一收紧
  它们就集体开始被拒（又是形状 5：拿变更前的状态去卡这次变更）。所以同样给一个
  一次性窗口：只补**当时确实由管理员在控制台列出过**的那些别名，放行人如实写成迁移。

  **与数据面成对，改一边必须改另一边**：这里只扫有 `Models` 数组的文档。旧形态兑换所
  （别名在 `ModelAlias` / `ModelAliases` 里、没有 `Models` 数组）在这里扫不到，也无处盖戳——
  它们由数据面按「逐条放行落地前的既有声明」放行（见 ModelResolver 的兑换所判定）。
  日后若把数据面改成「旧形态也必须带标记」，这条迁移得先能把旧形态落成 `Models`，
  否则那一改就是让存量兑换所在 enforce 档下集体断线。
*/
const string ExchangeStampMigrationId = "exchange-model-allowance-v1";
var exchangeStampClaimedAt = await ClaimOneShotMigrationAsync(ExchangeStampMigrationId);
if (exchangeStampClaimedAt is not null)
{
    var stampedAliases = 0L;
    using var exchangeCursor = await gwModelExchanges
        .Find(Builders<BsonDocument>.Filter.Exists("Models"))
        .ToCursorAsync();
    while (await exchangeCursor.MoveNextAsync())
    {
        foreach (var exchange in exchangeCursor.Current)
        {
            if (!exchange.TryGetValue("Models", out var rawModels) || rawModels is not BsonArray declaredModels) continue;
            // 只挑「该盖而还没盖」的那些别名，名录内的不盖（它本来就在白名单里，与写入路径同一口径）。
            var pending = declaredModels.OfType<BsonDocument>()
                .Where(declared => !declared.Contains("AllowedOutsideCatalog"))
                .Select(declared => declared.GetValue("ModelId", string.Empty))
                .Where(alias => alias.IsString && alias.AsString.Length > 0 && !ModelCatalog.Contains(alias.AsString))
                .Distinct()
                .ToList();
            if (pending.Count == 0) continue;

            // **只补缺的那几个字段，不整片写回 Models。**
            // 整片写回的谓词只有 _id：滚动升级期间旧副本在「读出来」和「写回去」之间
            // 编辑了这个兑换所，这一写就会把他的改动连同新别名一起抹掉、换回读到的那份旧数组——
            // 迁移顺手做了一次静默回滚。按元素定位就没有这个窗口：没被点名的元素一个字节都不动。
            var arrayFilter = new BsonDocument
            {
                { "el.ModelId", new BsonDocument("$in", new BsonArray(pending)) },
                { "el.AllowedOutsideCatalog", new BsonDocument("$exists", false) },
            };
            var stampResult = await gwModelExchanges.UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", exchange.GetValue("_id", string.Empty)),
                Builders<BsonDocument>.Update
                    .Set("Models.$[el].AllowedOutsideCatalog", true)
                    .Set("Models.$[el].AllowedOutsideCatalogBy", "存量迁移（兑换所逐条放行标记落地前已声明，未经人工审阅）")
                    .Set("Models.$[el].AllowedOutsideCatalogAt", exchangeStampClaimedAt.Value),
                new UpdateOptions
                {
                    ArrayFilters = new[] { new BsonDocumentArrayFilterDefinition<BsonDocument>(arrayFilter) },
                });
            if (stampResult.ModifiedCount > 0) stampedAliases += pending.Count;
        }
    }
    await CompleteOneShotMigrationAsync(ExchangeStampMigrationId, stampedAliases);
    app.Logger.LogInformation(
        "[ModelCatalog] 兑换所逐条放行迁移已执行（一次性）：为 {Count} 条已声明的名录外别名补上放行标记（未经人工审阅，来历见审计字段）",
        stampedAliases);
}

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

        // 这里**不许**自增 SecurityVersion。
        //
        // SecurityVersion 是撤销计数器：每个已鉴权请求都会拿 token 里的版本与库里比对，
        // 对不上就整条会话作废。登录不是撤销事件——一次 SSO 把它 +1，等于把这个人
        // 在**其它所有地方**的登录全部踢掉：另一个标签页、手机上那个、昨天开着的那个，
        // 全部当场变成「租户会话无效，请重新登录」。
        //
        // 真实症状（2026-08-28 用户）：「为什么登录总是失效，我都不知道 sso 多少次了」。
        // 根因就是这一行——验收脚本每跑一轮就 SSO 一次，每次都把用户手上的会话打掉。
        // 需要撤销时走改密、禁用、成员变更那几条路径，它们各自有自己的自增，语义正确。
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
                .Set(x => x.UpdatedAt, now),
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
        // 成员版本同样是撤销计数器（token 里带 membership_version，每个请求都比对），
        // 所以**没有实质变化时一律不许 +1**。先走「角色与状态都已就位」这条路：只刷一下
        // UpdatedAt，版本不动，这个人手上别处的会话继续有效。
        //
        // 这是 SecurityVersion 那处的同一个坑的第二个入口：上一版两处都在每次 SSO 时自增，
        // 只修掉一处，用户看到的仍然是「每次打开你给的链接都要重新 SSO」。
        // 真的变了（首次进来、角色或状态被改过）才落到下面那条路，那时旧会话本就该失效。
        LlmGwMembership? membership = await memberships.FindOneAndUpdateAsync(
            Builders<LlmGwMembership>.Filter.And(
                membershipFilter,
                Builders<LlmGwMembership>.Filter.Eq(x => x.Role, LlmGwTenantRoles.Admin),
                Builders<LlmGwMembership>.Filter.Eq(x => x.Status, "active")),
            Builders<LlmGwMembership>.Update.Set(x => x.UpdatedAt, now),
            new FindOneAndUpdateOptions<LlmGwMembership, LlmGwMembership> { ReturnDocument = ReturnDocument.After });
        // 上面那条快路只在「角色与状态都已就位」时命中。走到这里说明**这个请求看到的**
        // 还没就位——但并发下另一个请求可能正在或已经把它改好。此时两个请求各自 +1，
        // 先返回的那把 token 带着旧版本号，`TenantAccess.ResolveAsync` 立刻判它失效：
        // 正是这次改动要消除的那种「刚登进去就被登出」。
        //
        // 所以把「还没就位」写进谓词，让库来裁决谁是真正做出改变的那一个；
        // 落败的一方拿到 null，回去走不自增的快路读胜者。
        var membershipNotYetActive = Builders<LlmGwMembership>.Filter.Not(
            Builders<LlmGwMembership>.Filter.And(
                Builders<LlmGwMembership>.Filter.Eq(x => x.Role, LlmGwTenantRoles.Admin),
                Builders<LlmGwMembership>.Filter.Eq(x => x.Status, "active")));
        var membershipActive = Builders<LlmGwMembership>.Filter.And(
            membershipFilter,
            Builders<LlmGwMembership>.Filter.Eq(x => x.Role, LlmGwTenantRoles.Admin),
            Builders<LlmGwMembership>.Filter.Eq(x => x.Status, "active"));
        if (membership is null)
        {
            // 一、文档已存在但还没就位：条件更新，只有一个请求能命中。不带 upsert——
            // 谓词里有取反子句，upsert 在不命中时会去插入，那条路要单独走（第二步）。
            membership = await memberships.FindOneAndUpdateAsync(
                Builders<LlmGwMembership>.Filter.And(membershipFilter, membershipNotYetActive),
                membershipUpdate,
                new FindOneAndUpdateOptions<LlmGwMembership, LlmGwMembership> { ReturnDocument = ReturnDocument.After });
        }
        if (membership is null)
        {
            // 二、文档压根不存在：**只插入，不 upsert**。
            //
            // upsert 在这里是错的：第一步之后、这一步之前，另一个请求可能已经把文档建好了，
            // 而 upsert 的谓词是等值的 tenant+user——它会匹配上那条新文档并执行更新，
            // 连同 `Inc(Version, 1)` 一起。没有 DuplicateKey，也就走不到第三步，
            // 于是胜者的版本被落败方 +1，胜者手里那把 token 当场失效——正是这次要消除的症状。
            // 插入的语义是「只有我建成才算我做的改变」，撞唯一索引就认输。
            try
            {
                var created = new LlmGwMembership
                {
                    Id = Guid.NewGuid().ToString("N"),
                    TenantId = tenant.Id,
                    UserId = gwUser.Id,
                    Role = LlmGwTenantRoles.Admin,
                    Status = "active",
                    Version = 1,
                    CreatedAt = now,
                    UpdatedAt = now,
                };
                await memberships.InsertOneAsync(created);
                membership = created;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                membership = null; // 另一个请求刚建好，落到第三步去读它，不再自增。
            }
        }
        // 三、并发落败：胜者已经就位，按不自增的方式读回来。
        membership ??= await memberships.FindOneAndUpdateAsync(
            membershipActive,
            Builders<LlmGwMembership>.Update.Set(x => x.UpdatedAt, now),
            new FindOneAndUpdateOptions<LlmGwMembership, LlmGwMembership> { ReturnDocument = ReturnDocument.After });
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

        // MAP 联邦会话默认与普通会话同为一个月（LlmGwJwt:MapSsoLifetimeMinutes 可收紧）。
        // 再次从 MAP 点进来**不吊销**旧会话：登录不是撤销事件，两个撤销计数器
        //（用户 SecurityVersion、成员 Version）在这条路径上都不自增。撤销走改密、
        // 禁用、成员变更那几条，它们各自有自己的自增，语义正确。
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

// 稳定冒烟一次性登录：MAP 先用 RSA 签名确认机器身份，再把 60 秒单次票据写进共享网关库。
// 网关只自动补齐“缺失”的专用账号和成员关系；人工停用、角色漂移一律熔断，不擅自恢复权限。
app.MapPost("/gw/auth/stable-smoke-sso", async (HttpContext http, [FromBody] MapSsoRequestDto req) =>
{
    if (!stableSmokeFederationEnabled)
    {
        return Json(
            ApiEnvelope<LoginResultDto>.Fail(
                "STABLE_SMOKE_FEDERATION_DISABLED",
                "模型网关巡检登录未启用，请由管理员开启后重试"),
            jsonOptions,
            503);
    }

    var code = (req.Code ?? string.Empty).Trim();
    if (code.Length is < 32 or > 256)
    {
        await WriteLoginAuditAsync(
            loginAudits, http, internalTenantId, "stable-smoke-sso", null, false,
            "STABLE_SMOKE_INVALID_CODE");
        return Json(
            ApiEnvelope<LoginResultDto>.Fail(
                "STABLE_SMOKE_SSO_INVALID",
                "巡检登录凭据无效或已过期，请重新签发后重试"),
            jsonOptions,
            401);
    }

    var ticket = await StableSmokeSsoTicketStore.TryClaimAsync(
        mapSsoTickets,
        code,
        DateTime.UtcNow,
        CancellationToken.None);
    if (ticket is null)
    {
        await WriteLoginAuditAsync(
            loginAudits, http, internalTenantId, "stable-smoke-sso", null, false,
            "STABLE_SMOKE_REPLAY_OR_EXPIRED");
        return Json(
            ApiEnvelope<LoginResultDto>.Fail(
                "STABLE_SMOKE_SSO_INVALID",
                "巡检登录凭据无效、已过期或已使用，请重新签发后重试"),
            jsonOptions,
            401);
    }

    var mapUserId = ticket.GetStringOrEmpty("MapUserId").Trim();
    var mapUsername = ticket.GetStringOrEmpty("MapUsername").Trim();
    var mapDisplayName = ticket.GetStringOrEmpty("MapDisplayName").Trim();
    if (!stableSmokeAllowedUsers.Contains(mapUsername))
    {
        await mapSsoTickets.UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", ticket["_id"]),
            Builders<BsonDocument>.Update
                .Set("State", "failed")
                .Set("FailureReason", "username_not_allowed"),
            cancellationToken: CancellationToken.None);
        await WriteLoginAuditAsync(
            loginAudits, http, internalTenantId, mapUsername, null, false,
            "STABLE_SMOKE_USERNAME_NOT_ALLOWED");
        return Json(
            ApiEnvelope<LoginResultDto>.Fail(
                "STABLE_SMOKE_USERNAME_NOT_ALLOWED",
                "当前巡检身份不在模型网关允许名单中，请由管理员校准后重试"),
            jsonOptions,
            403);
    }

    try
    {
        var provisioned = await StableSmokeFederation.ProvisionAsync(
            mapUserId,
            mapUsername,
            mapDisplayName,
            internalTenantId,
            stableSmokeRole,
            users,
            tenants,
            memberships,
            CancellationToken.None);
        if (!provisioned.Success)
        {
            await mapSsoTickets.UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", ticket["_id"]),
                Builders<BsonDocument>.Update
                    .Set("State", "failed")
                    .Set("FailureReason", provisioned.Code),
                cancellationToken: CancellationToken.None);
            await WriteLoginAuditAsync(
                loginAudits, http, internalTenantId, mapUsername, provisioned.User?.Id, false,
                provisioned.Code);
            return Json(
                ApiEnvelope<LoginResultDto>.Fail(provisioned.Code, provisioned.Message),
                jsonOptions,
                provisioned.StatusCode);
        }

        var user = provisioned.User!;
        var tenant = provisioned.Tenant!;
        var membership = provisioned.Membership!;
        await mapSsoTickets.UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", ticket["_id"]),
                Builders<BsonDocument>.Filter.Eq("State", "claimed")),
            Builders<BsonDocument>.Update
                .Set("State", "consumed")
                .Set("GatewayUserId", user.Id)
                .Set("CompletedAt", DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        await WriteLoginAuditAsync(
            loginAudits, http, tenant.Id, mapUsername, user.Id, true, null);

        // 显式短会话，不带 federatedSession 免旧口令特权，也不会进入滑动续期。
        var (token, expiresAt) = gwJwt.Issue(user, tenant, membership, stableSmokeLifetime);
        return Json(ApiEnvelope<LoginResultDto>.Ok(new LoginResultDto
        {
            Token = token,
            Username = mapUsername,
            DisplayName = user.DisplayName,
            ExpiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
            IdentityProvider = StableSmokeFederation.IdentityProvider,
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
            Builders<BsonDocument>.Update
                .Set("State", "failed")
                .Set("FailureReason", "provisioning_failed"),
            cancellationToken: CancellationToken.None);
        throw;
    }
}).AllowAnonymous();

// 401 见微知著：同一身份连续失败与多身份同因失败分开聚合。
// 成功登录会关闭此前失败，返回值只含不可逆指纹，不暴露账号名或凭据。
app.MapGet("/gw/auth/failure-health", async (int? windowMinutes, int? threshold) =>
{
    var minutes = Math.Clamp(windowMinutes ?? 10, 5, 120);
    var effectiveThreshold = Math.Clamp(threshold ?? AuthFailureHealthPolicy.DefaultThreshold, 2, 20);
    var since = DateTime.UtcNow.AddMinutes(-minutes);
    var samples = await loginAudits.Find(item => item.CreatedAt >= since)
        .SortBy(item => item.CreatedAt)
        .ToListAsync(CancellationToken.None);
    var incidents = AuthFailureHealthPolicy.Evaluate(samples, effectiveThreshold);
    var recoveries = AuthFailureHealthPolicy.FindRecoveries(samples);
    return Json(ApiEnvelope<object>.Ok(new
    {
        status = incidents.Count > 0 ? "warning" : recoveries.Count > 0 ? "recovered" : "healthy",
        windowMinutes = minutes,
        threshold = effectiveThreshold,
        incidents,
        recoveries,
        recovery = new
        {
            browserSession = "single-refresh-single-retry",
            machineIdentity = "one-time-ticket-auto-provision",
            circuitBreaker = "manual-disable-role-drift-repeated-failure",
        },
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

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
        .Include("CachedInputPricePerMillion")
        .Include("CacheReadInputTokens")
        .Include("EstimatedCacheReadCost")
        .Include("CostStatus")
        .Include("CostUnpricedReason")
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
    // 「这次调用算没算出钱」由写入时的 CostStatus 直接回答，不再在这里按价格字段反推一遍。
    // 反推是判据分裂的温床：写入侧改了口径、统计侧还按老规矩算，两边各自正确、合起来对不上。
    // 存量日志没有这个字段，才回退到旧的反推口径。
    var classified = docs
        .Select(d => new
        {
            Amount = d.AsNullableDecimal("EstimatedCost"),
            Currency = NormalizePriceCurrency(d.AsNullableString("EstimatedCostCurrency")),
            Usd = d.AsNullableDecimal("EstimatedCostUsd"),
            Status = ResolveLogCostStatus(d),
            Reason = d.AsNullableString("CostUnpricedReason"),
            Model = d.AsNullableString("Model"),
            Provider = d.AsNullableString("Provider"),
            CacheReadTokens = d.AsNullableInt("CacheReadInputTokens") ?? 0,
            CacheReadCost = d.AsNullableDecimal("EstimatedCacheReadCost"),
            InputPrice = d.AsNullableDecimal("InputPricePerMillion"),
        })
        .ToList();

    var pricedDocs = classified
        .Where(x => x.Status == GatewayCostStatusNames.Priced && x.Amount is not null && x.Currency is not null)
        .ToList();

    // 缓存省了多少：同样这批 token 如果按输入全价算要花多少，减去实际按缓存价算出来的。
    // 两者都拿不到就不出这个数，不猜。
    var cacheSavings = classified
        .Where(x => x.Status == GatewayCostStatusNames.Priced && x.CacheReadTokens > 0
                    && x.CacheReadCost is not null && x.InputPrice is not null)
        .Sum(x => Math.Max(0m, x.CacheReadTokens * x.InputPrice!.Value / 1_000_000m - x.CacheReadCost!.Value));

    var topUnpriced = classified
        .Where(x => x.Status is GatewayCostStatusNames.Unpriced or GatewayCostStatusNames.StaleCurrency)
        .GroupBy(x => (Model: x.Model ?? "unknown", x.Provider, x.Status))
        .Select(g => new UnpricedModelBucket
        {
            Model = g.Key.Model,
            Provider = g.Key.Provider,
            Status = g.Key.Status,
            Requests = g.LongCount(),
            Reason = g.Select(x => x.Reason).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)),
        })
        .OrderByDescending(x => x.Requests)
        .ThenBy(x => x.Model, StringComparer.Ordinal)
        .Take(10)
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
        CacheSavingsUsd = cacheSavings > 0 ? Math.Round(cacheSavings, 6, MidpointRounding.AwayFromZero) : null,
        UnpricedRequests = classified.LongCount(x => x.Status == GatewayCostStatusNames.Unpriced),
        StaleCurrencyRequests = classified.LongCount(x => x.Status == GatewayCostStatusNames.StaleCurrency),
        NoUsageRequests = classified.LongCount(x => x.Status == GatewayCostStatusNames.NoUsage),
        TopUnpricedModels = topUnpriced,
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
        .Include("CachedInputPricePerMillion")
        .Include("CacheReadInputTokens")
        .Include("EstimatedCacheReadCost")
        .Include("CostStatus")
        .Include("CostUnpricedReason")
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
    // 与上面那段同源：算没算出钱一律读 CostStatus，存量日志才回退反推。
    var pricedDocs = docs
        .Select(d => new
        {
            Amount = d.AsNullableDecimal("EstimatedCost"),
            Currency = NormalizePriceCurrency(d.AsNullableString("EstimatedCostCurrency")),
            Status = ResolveLogCostStatus(d),
        })
        .Where(x => x.Status == GatewayCostStatusNames.Priced && x.Amount is not null && x.Currency is not null)
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


// ── 池成员可解析性：建索引 + 归一 ───────────────────────────────────────────────
//
// 「这个成员还指得到一个上游 + 模型吗」这件事，池列表要用、每个返回池的变更端点也要用。
// 只做在列表上就会分裂：改完成员拿回来的那份响应还是库里的原始健康值，
// 卡片当场翻绿、刷新又变回去——正是归一本身要防的自相矛盾，换条路径复现（形状 3）。
// 所以收成一个出口，谁要吐 PoolItem 谁就过这道。

async Task<PoolResolutionIndex> BuildPoolResolutionIndexAsync(HttpContext http)
{
    var fb = Builders<BsonDocument>.Filter;
    var platformIds = (await gwPlatforms.Find(TenantAccess.Filter(http))
            .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Enabled"))
            .ToListAsync())
        .Where(d => d.AsNullableBool("Enabled") ?? true)
        .Select(d => d.GetStringOrEmpty("_id"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .ToHashSet(StringComparer.Ordinal);
    var modelDocs = await gwModels.Find(TenantAccess.Filter(http, fb.Ne("Enabled", false)))
        .Project(Builders<BsonDocument>.Projection.Include("_id").Include("ModelName").Include("Name").Include("PlatformId"))
        .ToListAsync();
    var exchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http, fb.Ne("Enabled", false)))
        .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Name").Include("ModelAlias").Include("ModelAliases").Include("Models"))
        .ToListAsync();

    // GW 与 MAP 两侧取并集：内部租户的池列表里两种权威来源混在一起，
    // 只查一侧会把另一侧的活成员误判成死的。MAP 集合本就是内部租户专属，外部租户不查。
    if (TenantAccess.GetRequired(http).TenantId == internalTenantId)
    {
        foreach (var d in await platforms.Find(FilterDefinition<BsonDocument>.Empty)
                     .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Enabled")).ToListAsync())
        {
            if ((d.AsNullableBool("Enabled") ?? true) && !string.IsNullOrWhiteSpace(d.GetStringOrEmpty("_id")))
                platformIds.Add(d.GetStringOrEmpty("_id"));
        }
        modelDocs.AddRange(await models.Find(fb.Ne("Enabled", false))
            .Project(Builders<BsonDocument>.Projection.Include("_id").Include("ModelName").Include("Name").Include("PlatformId"))
            .ToListAsync());
        exchangeDocs.AddRange(await modelExchanges.Find(fb.Ne("Enabled", false))
            .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Name").Include("ModelAlias").Include("ModelAliases").Include("Models"))
            .ToListAsync());
    }
    // 第二套：只看存在、不看启用。用来把「被停用」和「压根没了」分开——
    // 少了它，一个仅仅被停用的上游会被标成「已不存在」并给出摘除入口，
    // 而后端的悬空判定查的是存在性，那个按钮点下去必然 APPEND_ONLY_POOL。
    var existingPlatformIds = (await gwPlatforms.Find(TenantAccess.Filter(http))
            .Project(Builders<BsonDocument>.Projection.Include("_id"))
            .ToListAsync())
        .Select(d => d.GetStringOrEmpty("_id"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .ToHashSet(StringComparer.Ordinal);
    var existingModels = await gwModels.Find(TenantAccess.Filter(http))
        .Project(Builders<BsonDocument>.Projection.Include("_id").Include("ModelName").Include("Name").Include("PlatformId"))
        .ToListAsync();
    var existingExchanges = await gwModelExchanges.Find(TenantAccess.Filter(http))
        .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Name").Include("ModelAlias").Include("ModelAliases").Include("Models"))
        .ToListAsync();
    if (TenantAccess.GetRequired(http).TenantId == internalTenantId)
    {
        foreach (var d in await platforms.Find(FilterDefinition<BsonDocument>.Empty)
                     .Project(Builders<BsonDocument>.Projection.Include("_id")).ToListAsync())
        {
            if (!string.IsNullOrWhiteSpace(d.GetStringOrEmpty("_id")))
                existingPlatformIds.Add(d.GetStringOrEmpty("_id"));
        }
        existingModels.AddRange(await models.Find(FilterDefinition<BsonDocument>.Empty)
            .Project(Builders<BsonDocument>.Projection.Include("_id").Include("ModelName").Include("Name").Include("PlatformId"))
            .ToListAsync());
        existingExchanges.AddRange(await modelExchanges.Find(FilterDefinition<BsonDocument>.Empty)
            .Project(Builders<BsonDocument>.Projection.Include("_id").Include("Name").Include("ModelAlias").Include("ModelAliases").Include("Models"))
            .ToListAsync());
    }

    return new PoolResolutionIndex(
        platformIds, modelDocs, exchangeDocs,
        existingPlatformIds, existingModels, existingExchanges);
}

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

    var resolutionIndex = await BuildPoolResolutionIndexAsync(http);

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

        ApplyPoolMemberResolution(item, resolutionIndex);
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

// 能力契约审计：发布门禁与运维据此判断「存量配置是否已经全部归一到规范能力」。
// 只读，不改数据；返回残留历史别名数、未打契约版本数，以及带未知能力的对象点名清单。
// 判据与运行时同源（镜像表由 GatewayCapabilityContractMirrorGuardTests 守住），
// 所以这里绿灯就等于运行时不会再因为能力名不兼容把候选过滤成 0。
app.MapGet("/gw/logical-models/capability-audit", async (HttpContext http) =>
{
    var docs = await gwLogicalModels
        .Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty))
        .ToListAsync();
    var findings = new List<CapabilityMigrationFinding>();
    var residualAliases = 0;
    var unversioned = 0;

    foreach (var doc in docs)
    {
        var id = doc.GetStringOrEmpty("_id");
        var publicId = doc.GetStringOrEmpty("PublicId");
        var modelType = doc.GetStringOrEmpty("ModelType");
        var caps = doc.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray
            ? cv.AsBsonArray.Where(x => x.IsString).Select(x => x.AsString).ToList()
            : new List<string>();
        var version = doc.TryGetValue(LogicalModelCapabilityPolicy.SchemaVersionField, out var sv) && sv.IsInt32
            ? sv.AsInt32
            : 0;

        if (caps.Any(c => LogicalModelCapabilityPolicy.LegacyAliases.ContainsKey(
                (c ?? string.Empty).Trim().ToLowerInvariant())))
        {
            residualAliases++;
        }
        if (version != LogicalModelCapabilityPolicy.SchemaVersion) unversioned++;

        var unknown = LogicalModelCapabilityPolicy.Unknown(modelType, caps);
        if (unknown.Count > 0)
            findings.Add(new CapabilityMigrationFinding(id, publicId.Length > 0 ? publicId : id, modelType, unknown));
    }

    var report = new CapabilityAuditData
    {
        SchemaVersion = LogicalModelCapabilityPolicy.SchemaVersion,
        Scanned = docs.Count,
        ResidualLegacyAliases = residualAliases,
        StillUnversioned = unversioned,
        UnknownObjects = findings
            .Select(x => new CapabilityAuditFinding
            {
                PublicId = x.PublicId,
                ModelType = x.ModelType,
                UnknownCapabilities = x.UnknownCapabilities.ToList(),
            })
            .ToList(),
    };
    report.Clean = report.ResidualLegacyAliases == 0
                   && report.StillUnversioned == 0
                   && report.UnknownObjects.Count == 0;
    return Json(ApiEnvelope<CapabilityAuditData>.Ok(report), jsonOptions);
}).RequireAuthorization("LogsRead");

// 逻辑模型目录：调用方只看到 PublicId；Offerings 展示实际 Provider/Endpoint 供运维维护。
// ───────────────── 模型名录补登：让系统「认识」上游新出的模型，不用改代码 ─────────────────
//
// 名录回答的是「这个模型是什么」：算哪几种用途、能不能吃图、出品方是谁、有哪些等价写法。
// 它此前只有写死在 ModelCatalog.cs 里的二十来条。实测线上两个上游共 573 个模型，
// 落在名录里的只有 27 个——其余 95% 走关键词猜测，其中一百多个连一条用途都猜不出来，
// 导进来就是「哑」模型：模型池选型时不参与任何用途匹配。
//
// 于是「上游出了个新模型」在此之前等于「改那个文件、重编、发一次版」。补登让它变成
// 在导入那一屏填一次。合并规则只有一条，且只在 ModelCatalog.Find 里实现：
// **同一个标识，补登的赢；补登里没有的，回落到代码内置那张表。**
//
// 与生图契约那份的区别：那份跨进程（console-api 写、prd-api 读）只能轮询、最长 60 秒生效；
// 这份只有 console-api 自己读，所以端点每次现查现传，**改完立刻生效**。
var gwCatalogEntries = gatewayDatabase.GetCollection<BsonDocument>("llmgw_model_catalog_entries");

/*
  补登的键空间也升成库级不变量。

  端点里的「先查一遍有没有人占了这个键、再写」在单个请求里是对的，两个管理员同时补登同一个
  标识时却都能查空、都写成功——库里于是有两条补登抢同一个键，而运行时按哪条算全看排序，
  两个人的界面都显示「已保存」。应用层补不了这个洞：任何「查一下有没有别人」都在竞态窗口里。

  规范标识与等价写法共用一个键空间，所以走**多键**唯一索引：Keys 数组的每个元素各生成一个
  (TenantId, 某个键)，跨文档唯一——正好是要的那条不变量。部分过滤器判「数组里至少有一个
  字符串元素」，否则空数组在多键索引里记成 undefined，所有空补登会互相撞车。

  存量文档没有 Keys 字段，先按 CanonicalId + Aliases 补齐再建索引；补不齐或建不出来都如实
  报出来，端点仍按老样子工作（degradation-must-alarm：降级要响铃，不许静默）。
*/
try
{
    var legacyEntries = await gwCatalogEntries
        .Find(Builders<BsonDocument>.Filter.Exists("Keys", false))
        .ToListAsync();
    foreach (var legacy in legacyEntries)
    {
        var legacyKeys = new[] { legacy.GetStringOrEmpty("CanonicalId") }
            .Concat(GetStringArray(legacy, "Aliases"))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim().ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        await gwCatalogEntries.UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", legacy.GetStringOrEmpty("_id")),
            Builders<BsonDocument>.Update.Set("Keys", new BsonArray(legacyKeys)));
    }

}
catch (MongoException ex)
{
    Console.WriteLine(
        "[llmgw] 给存量补登补 Keys 字段时失败（" + ex.Message + "）："
        + "缺 Keys 的那几条补登不受唯一索引保护，两条补登可以抢同一个标识。"
        + "先确认控制台连得上网关库，再重启一次补齐");
}

await IndexAdvisory.ReportIfMissingAsync(
    gwCatalogEntries,
    "uniq_llmgw_catalog_entry_key",
    "两个管理员同时给同一个标识（或它的等价写法）补登时，两条都会存进去，"
    + "上游清单那一屏取到哪条全看排序，而两个人的界面都显示「已保存」");

// 读补登表并建成索引。上游清单那一屏每次都现查，所以补完刷新页面就能看见。
async Task<ModelCatalog.CatalogOverrides> LoadCatalogOverridesAsync(HttpContext http)
{
    var docs = await gwCatalogEntries
        .Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("Enabled", true)))
        .ToListAsync();
    return ModelCatalog.CatalogOverrides.From(docs.Select(ToCatalogModel).Where(x => x is not null)!);
}

static CatalogModel? ToCatalogModel(BsonDocument d)
{
    var canonical = d.GetStringOrEmpty("CanonicalId");
    if (canonical.Length == 0) return null;
    return new CatalogModel(
        canonical,
        d.GetStringOrEmpty("DisplayName"),
        d.GetStringOrEmpty("Vendor"),
        GetStringArray(d, "Capabilities"),
        d.AsNullableBool("AcceptsImageInput") ?? false,
        d.AsNullableBool("RequiresImageInput") ?? false,
        GetStringArray(d, "Aliases"));
}

app.MapGet("/gw/catalog-entries", async (HttpContext http) =>
{
    var docs = await gwCatalogEntries.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty))
        .ToListAsync();
    var items = docs
        .OrderBy(d => d.GetStringOrEmpty("CanonicalId"), StringComparer.Ordinal)
        .Select(MapCatalogEntry)
        .ToList();
    return Json(ApiEnvelope<CatalogEntriesData>.Ok(new CatalogEntriesData
    {
        Items = items,
        Total = items.Count,
        // 内置那张表的条数与内容：让人知道「补登 0 条不等于系统什么都不认识」，
        // 也让「照这条补一份」有个模板可抄。它直接来自代码，不是另抄的一份。
        BuiltinCount = ModelCatalog.All.Count,
        Builtin = ModelCatalog.All.Select(x => new CatalogEntryItem
        {
            CanonicalId = x.CanonicalId,
            DisplayName = x.DisplayName,
            Vendor = x.Vendor,
            Capabilities = [.. x.Capabilities],
            AcceptsImageInput = x.AcceptsImageInput,
            RequiresImageInput = x.RequiresImageInput,
            Aliases = [.. x.Aliases ?? []],
        }).ToList(),
        // 控制台只让填这些用途名；与运行时的能力词表同源（守卫钉住）。
        KnownCapabilities = [.. LogicalModelCapabilityPolicy.CanonicalCapabilities.OrderBy(x => x, StringComparer.Ordinal)],
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

app.MapPost("/gw/catalog-entries", async (HttpContext http, [FromBody] UpsertCatalogEntryRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<CatalogEntryItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var error = ValidateCatalogEntry(body);
    if (error is not null) return Json(ApiEnvelope<CatalogEntryItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var canonical = body.CanonicalId!.Trim().ToLowerInvariant();
    var conflict = await FindCatalogKeyConflictAsync(gwCatalogEntries, http, body, excludeId: null);
    if (conflict is not null)
        return Json(ApiEnvelope<CatalogEntryItem>.Fail("ENTRY_EXISTS", conflict), jsonOptions, 409);

    var doc = BuildCatalogEntryDocument(body, tenantId, existing: null);
    try
    {
        await gwCatalogEntries.InsertOneAsync(doc);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        // 上面查过一遍没人占，写的时候还是撞上了：说明在这几毫秒里另一个管理员补登了同一个键。
        // 索引挡住了，端点就得如实说是冲突，而不是把它变成 500。
        return Json(ApiEnvelope<CatalogEntryItem>.Fail(
            "ENTRY_EXISTS",
            "这个标识刚刚被另一条补登占用了——规范标识与等价写法共用同一个键空间。刷新一下看看那条，别再加一条"),
            jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http,
        action: "catalog_entry.create", targetType: "llmgw_model_catalog_entry",
        targetId: doc.GetStringOrEmpty("_id"), targetName: canonical, success: true, reason: null,
        changes: new BsonDocument { { "canonicalId", canonical }, { "capabilities", new BsonArray(body.Capabilities ?? []) } });
    return Json(ApiEnvelope<CatalogEntryItem>.Ok(MapCatalogEntry(doc)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/catalog-entries/{id}", async (HttpContext http, string id, [FromBody] UpsertCatalogEntryRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<CatalogEntryItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var error = ValidateCatalogEntry(body);
    if (error is not null) return Json(ApiEnvelope<CatalogEntryItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var filter = Builders<BsonDocument>.Filter.And(
        TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty),
        Builders<BsonDocument>.Filter.Eq("_id", id));
    var existing = await gwCatalogEntries.Find(filter).FirstOrDefaultAsync();
    if (existing is null) return Json(ApiEnvelope<CatalogEntryItem>.Fail("NOT_FOUND", "这条补登不存在"), jsonOptions, 404);

    // 与新建同一份判据：改名或加别名同样可能撞上别人的键空间。
    var conflict = await FindCatalogKeyConflictAsync(gwCatalogEntries, http, body, excludeId: id);
    if (conflict is not null)
        return Json(ApiEnvelope<CatalogEntryItem>.Fail("ENTRY_EXISTS", conflict), jsonOptions, 409);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var doc = BuildCatalogEntryDocument(body, tenantId, existing);
    try
    {
        await gwCatalogEntries.ReplaceOneAsync(filter, doc);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<CatalogEntryItem>.Fail(
            "ENTRY_EXISTS",
            "这个标识刚刚被另一条补登占用了——规范标识与等价写法共用同一个键空间。刷新一下看看那条，改那一条"),
            jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http,
        action: "catalog_entry.update", targetType: "llmgw_model_catalog_entry",
        targetId: id, targetName: doc.GetStringOrEmpty("CanonicalId"), success: true, reason: null,
        changes: new BsonDocument { { "canonicalId", doc.GetStringOrEmpty("CanonicalId") } });
    return Json(ApiEnvelope<CatalogEntryItem>.Ok(MapCatalogEntry(doc)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapDelete("/gw/catalog-entries/{id}", async (HttpContext http, string id) =>
{
    var filter = Builders<BsonDocument>.Filter.And(
        TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty),
        Builders<BsonDocument>.Filter.Eq("_id", id));
    var existing = await gwCatalogEntries.Find(filter).FirstOrDefaultAsync();
    if (existing is null) return Json(ApiEnvelope<object>.Fail("NOT_FOUND", "这条补登不存在"), jsonOptions, 404);
    await gwCatalogEntries.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(operationAudits, http,
        action: "catalog_entry.delete", targetType: "llmgw_model_catalog_entry",
        targetId: id, targetName: existing.GetStringOrEmpty("CanonicalId"), success: true, reason: null,
        changes: new BsonDocument { { "canonicalId", existing.GetStringOrEmpty("CanonicalId") } });
    return Json(ApiEnvelope<object>.Ok(new { deleted = true }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

/// <summary>
/// 「指定调用方」必须落在授权名单里——名单非空时。
///
/// 这两个字段刻意分工：授权名单回答「能不能点名我」，指定调用方回答「不点名时是不是我」。
/// 但后者是前者的子集：解析时先过 SupportsAppCallerScenario（看授权名单），过不了就直接
/// 返回 null，**而且不再回落到用途默认**——于是那个调用方的不点名请求整条失败。
///
/// 写入侧不拦的话，界面会说「不点名的请求现在会用这个模型」，运行时却一次都落不到，
/// 而且是静默的（形状 8：写入侧接受了一份在运行条件下根本不成立的配置，
/// 还让它看起来像生效了）。
///
/// 名单为空 = 对所有调用方开放，此时任何认领都成立，不需要校验。
/// </summary>
static string? ValidateClaimsWithinAllowlist(
    IReadOnlyCollection<string> allowedAppCallerCodes,
    IReadOnlyCollection<string> claims)
{
    if (allowedAppCallerCodes.Count == 0 || claims.Count == 0) return null;
    var allowed = allowedAppCallerCodes.ToHashSet(StringComparer.OrdinalIgnoreCase);
    var outside = claims.Where(x => !allowed.Contains(x)).ToList();
    return outside.Count == 0
        ? null
        : $"调用方 {string.Join("、", outside)} 不在这个模型的授权名单里，不能把它设成「指定调用方」——"
          + "解析时会先被授权名单拒掉，那些请求一次都落不到这里。"
          + "要么把它加进授权名单，要么把授权名单清空（清空 = 对所有调用方开放）。";
}

/// <summary>
/// 生图契约的模式冲突检查：同一租户下同一个模式只许有一条。
///
/// 两条同模式的行进了库，同步 worker 会把它们装进同一张按模式索引的表，
/// 谁赢取决于剩下那些排序键——而它们可能完全一样，于是取决于 Mongo 返回顺序。
/// 生图尺寸和参数翻译因此会在两套配置之间无规律地跳。
///
/// create 与 update 共用这一份：只在 create 那边查等于留了一扇后门，
/// 把 A 的模式改成 B 占着的那个照样进得去（predicate-and-wiring-discipline 形状 3）。
/// </summary>
static async Task<string?> FindImageGenPatternConflictAsync(
    IMongoCollection<BsonDocument> configs,
    HttpContext http,
    string pattern,
    string? excludeId)
{
    var filter = Builders<BsonDocument>.Filter.And(
        TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty),
        Builders<BsonDocument>.Filter.Eq("ModelIdPattern", pattern));
    if (!string.IsNullOrEmpty(excludeId))
        filter &= Builders<BsonDocument>.Filter.Ne("_id", excludeId);
    var dup = await configs.Find(filter).FirstOrDefaultAsync();
    return dup is null
        ? null
        : $"已经有一条 {pattern} 的契约，去改它而不是再加一条";
}

/// <summary>
/// 补登的标识冲突检查：规范标识与等价写法是**同一个键空间**。
///
/// 查重只看 CanonicalId 是不够的：别名同样是查找键（<see cref="ModelCatalog.CatalogOverrides"/>
/// 用它们建索引），两条补登各自的别名撞上时，索引按 Mongo 返回顺序覆盖——
/// 同一个模型今天认出 A 的用途、明天认出 B 的，而且不报任何错。
/// 更新端点原本一条都不查，等于留了一扇后门。
/// </summary>
static async Task<string?> FindCatalogKeyConflictAsync(
    IMongoCollection<BsonDocument> entries,
    HttpContext http,
    UpsertCatalogEntryRequest body,
    string? excludeId)
{
    var keys = new HashSet<string>(CatalogEntryKeys(body), StringComparer.OrdinalIgnoreCase);

    var docs = await entries.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty)).ToListAsync();
    foreach (var doc in docs)
    {
        var docId = doc.GetStringOrEmpty("_id");
        if (!string.IsNullOrEmpty(excludeId) && string.Equals(docId, excludeId, StringComparison.Ordinal)) continue;
        var taken = new List<string> { doc.GetStringOrEmpty("CanonicalId") };
        taken.AddRange(GetStringArray(doc, "Aliases"));
        foreach (var key in taken)
        {
            if (key.Length > 0 && keys.Contains(key))
                return $"标识「{key}」已经被补登 {doc.GetStringOrEmpty("CanonicalId")} 占用了——" +
                       "规范标识与等价写法共用同一个键空间，同一个键只能属于一条补登。去改那一条，别再加一条";
        }
    }

    // 自己这条里面也不许重（canonicalId 与自己的某个别名同名，索引会自己盖自己）
    var own = new List<string> { body.CanonicalId!.Trim().ToLowerInvariant() };
    own.AddRange((body.Aliases ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim().ToLowerInvariant()));
    if (own.Count != own.Distinct(StringComparer.OrdinalIgnoreCase).Count())
        return "规范标识与等价写法里有重复的项，去掉重复的再保存";

    return null;
}

/// <summary>
/// 补登的写入校验。
///
/// 最要紧的一条是用途名：填了一个运行时不认的词，这条补登看着生效了、模型照样选不中，
/// 而且不会有任何东西报错——「填了没用」是这套东西最难查的坏法。所以当场拒。
/// </summary>
static string? ValidateCatalogEntry(UpsertCatalogEntryRequest body)
{
    var canonical = (body.CanonicalId ?? string.Empty).Trim();
    if (canonical.Length == 0) return "模型标识不能为空";
    if (canonical.Length > 200) return "模型标识过长";
    if (canonical.Contains('*')) return "名录是白名单，不支持通配符——每个模型逐条登记，别名写进「等价写法」";

    var caps = (body.Capabilities ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
    if (caps.Count == 0) return "至少要填一种用途，否则这条补登不解决任何问题（模型仍然不参与用途匹配）";
    var unknown = caps.Where(c => !LogicalModelCapabilityPolicy.CanonicalCapabilities.Contains(c.Trim().ToLowerInvariant())).ToList();
    if (unknown.Count > 0)
        return $"这些用途运行时不认：{string.Join("、", unknown)}。可用的是：{string.Join(" / ", LogicalModelCapabilityPolicy.CanonicalCapabilities.OrderBy(x => x, StringComparer.Ordinal))}";

    if (body.RequiresImageInput == true && body.AcceptsImageInput != true)
        return "勾了「必须给图才能调」就得同时勾「能接收图片输入」——不然这条登记自相矛盾";

    foreach (var alias in body.Aliases ?? [])
    {
        if (string.IsNullOrWhiteSpace(alias)) continue;
        if (alias.Contains('*')) return $"等价写法不支持通配符：{alias}";
    }
    return null;
}

/// <summary>
/// 一条补登占用的全部键：规范标识 + 每个等价写法，统一小写去重。
///
/// 读检查与落库必须用同一份口径，否则「查的时候按 A 算、存的时候按 B 算」，
/// 索引盖住的键和端点判过的键不是一批（形状 3：同一个判据分裂成两份各自漂移）。
/// </summary>
static List<string> CatalogEntryKeys(UpsertCatalogEntryRequest body)
    => new[] { body.CanonicalId ?? string.Empty }
        .Concat(body.Aliases ?? [])
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x.Trim().ToLowerInvariant())
        .Distinct(StringComparer.Ordinal)
        .ToList();

static BsonDocument BuildCatalogEntryDocument(UpsertCatalogEntryRequest body, string tenantId, BsonDocument? existing)
    => new()
    {
        { "_id", existing?.GetStringOrEmpty("_id") ?? Guid.NewGuid().ToString("N") },
        { "TenantId", tenantId },
        { "CanonicalId", body.CanonicalId!.Trim().ToLowerInvariant() },
        { "DisplayName", (body.DisplayName ?? body.CanonicalId!).Trim() },
        { "Vendor", (body.Vendor ?? string.Empty).Trim().ToLowerInvariant() },
        { "Capabilities", new BsonArray((body.Capabilities ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim().ToLowerInvariant()).Distinct()) },
        { "AcceptsImageInput", body.AcceptsImageInput ?? false },
        { "RequiresImageInput", body.RequiresImageInput ?? false },
        { "Aliases", new BsonArray((body.Aliases ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim().ToLowerInvariant()).Distinct()) },
        // 规范标识与等价写法共用一个键空间，这里把它们合成一个数组落库，好让唯一索引能一次盖住两者。
        // 不落这一份，索引就只能盖住 CanonicalId，别名撞车照样能两条一起写进去。
        { "Keys", new BsonArray(CatalogEntryKeys(body)) },
        { "Notes", (BsonValue?)body.Notes ?? BsonNull.Value },
        { "Enabled", body.Enabled ?? true },
        { "CreatedAt", existing?.AsNullableUtcDateTime("CreatedAt") ?? DateTime.UtcNow },
        { "UpdatedAt", DateTime.UtcNow },
    };

static CatalogEntryItem MapCatalogEntry(BsonDocument d) => new()
{
    Id = d.GetStringOrEmpty("_id"),
    CanonicalId = d.GetStringOrEmpty("CanonicalId"),
    DisplayName = d.GetStringOrEmpty("DisplayName"),
    Vendor = d.GetStringOrEmpty("Vendor"),
    Capabilities = GetStringArray(d, "Capabilities"),
    AcceptsImageInput = d.AsNullableBool("AcceptsImageInput") ?? false,
    RequiresImageInput = d.AsNullableBool("RequiresImageInput") ?? false,
    Aliases = GetStringArray(d, "Aliases"),
    Notes = d.AsNullableString("Notes"),
    Enabled = d.AsNullableBool("Enabled") ?? true,
    UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
};

// ───────────────────── 生图模型契约：配在这里，不用改代码不用发版 ─────────────────────
//
// 此前这份契约（尺寸档位、参数格式、重命名映射、能不能图生图）写死在
// prd-api 的 ImageGenModelConfigs.cs 里，26 条、777 行。上游每出一个新生图模型，
// 就要改那个文件、重新编译、走一次发布——「上游动一下、我们发一次版」。
//
// 现在它是数据。合并规则只有一条，且只在 ImageGenModelAdapterRegistry.TryMatch 里实现：
// **同一个匹配模式，这里配的赢；这里没有的，回落到代码内置那 26 条。**
// 所以这套东西是纯增量的：库里一行都没有时，生图行为与 2026-09-16 之前逐字节相同。
//
// 生效不是即时的：prd-api 每 60 秒刷一次覆盖表，所以保存后最长 60 秒生效。
// 这个代价要写在界面上，不能让人保存完盯着屏幕猜（expectation-management）。
var gwImageModelConfigs = gatewayDatabase.GetCollection<BsonDocument>("llmgw_imagegen_model_configs");

/*
  生图契约的模式也是同一类不变量：同租户下一个匹配模式最多一条契约。

  端点里的「先查有没有同模式」拦不住两个管理员同时建：两边都查完、都没看到对方，
  然后各插一条。同步器会把两条都装进那张按模式索引的表，TryMatch 取先返回的那一条——
  生图的尺寸与参数翻译于是每次刷新可能不一样，而两个人的界面都显示保存成功。
*/
await IndexAdvisory.ReportIfMissingAsync(
    gwImageModelConfigs,
    "uniq_llmgw_imagegen_tenant_pattern",
    "两个管理员同时给同一个匹配模式建契约时，两条都会存进去，同步器把两条都装进那张按模式索引的表，"
    + "TryMatch 取先返回的那一条——生图的尺寸与参数翻译于是每次刷新可能不一样");


app.MapGet("/gw/imagegen-configs", async (HttpContext http) =>
{
    var docs = await gwImageModelConfigs.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty))
        .ToListAsync();
    var items = docs
        .OrderBy(d => d.AsNullableInt("MatchOrder") ?? 100)
        .ThenByDescending(d => d.GetStringOrEmpty("ModelIdPattern").Length)
        .Select(MapImageGenConfig)
        .ToList();
    // 代码内置那份由 prd-api 启动时发布进来（llmgw_imagegen_builtin_catalog）。
    // 控制台不另抄一份：抄的那份改了代码不会跟着改，而且不会有任何东西变红。
    var builtinDoc = await gatewayDatabase.GetCollection<BsonDocument>("llmgw_imagegen_builtin_catalog")
        .Find(Builders<BsonDocument>.Filter.Eq("_id", "builtin")).FirstOrDefaultAsync();
    var builtin = builtinDoc?.TryGetValue("Items", out var rawItems) == true && rawItems is BsonArray arr
        ? arr.OfType<BsonDocument>().Select(MapImageGenConfig).ToList()
        : [];

    // prd-api 上一轮同步拉到了什么。没有这一段，界面只能说「最长 60 秒生效」然后让人
    // 盯着屏幕猜；有了它，那一屏能说出一句可核对的话：服务端几点同步的、认到哪几条。
    // 按租户取：同步状态一租户一行（prd-api 侧以 `prd-api::{tenantId}` 为键）。
    // 取全局那一行的话，共用网关库的另一个租户的同步时间会显示成你的，
    // 于是「我配的那条生效了没有」这句可核对的话变成了一句假话。
    var syncTenantId = TenantAccess.GetRequired(http).TenantId;
    // 逐个消费进程读，不是读一行。
    //
    // 生图契约是**进程全局**的注册表，prd-api 与 llmgw-serving 各跑一份同步器。
    // 读单行（或取最新那行）等于让健康的那个进程替失败的那个作答：一个同步不上、
    // 另一个照常写，界面报「刚同步过、N 条生效」，而走失败那个进程的请求还在用旧契约——
    // 降级被另一半的成功盖住，没有任何地方会响（degradation-must-alarm）。
    //
    // 汇总口径因此取**最保守**的那一端：时间取最旧（有一个没同步过就为空），
    // 模式取交集（只有每个进程都认到的才算真生效）。逐进程明细另外给，
    // 界面要能答「是哪个进程没跟上」。
    const string prdApiHostRole = "prd-api";
    const string servingHostRole = "llmgw-serving";
    const int refreshSeconds = 60;
    // 多久没回写就算「没跟上」。取刷新周期的 5 倍：一次网络抖动不该报警，
    // 而一个停掉的 Worker 五分钟内必须现形。
    const int staleAfterSeconds = refreshSeconds * 5;
    /*
      prd-api 那个同步器注册成**单租户**：它只为内部租户写状态行。

      于是对其它租户来说 `prd-api::{tenantId}` 这一行永远不存在——把它算进期望值，
      那一屏就永远显示 prd-api「从没回写过」，汇总也永远到不了 current：一个好好的进程
      被报成停了，而人照着这句话去查根本查不到东西（no-rootless-tree：不编一个不存在的根）。

      所以按「这个进程服不服务这个租户」筛，而不是写死两个。筛掉的那一个不是悄悄消失：
      它照样列在逐进程明细里，状态是显式的 not-applicable，界面据此既不报警也不当它就绪。
    */
    bool SyncHostAppliesToTenant(string role)
        => !string.Equals(role, prdApiHostRole, StringComparison.Ordinal)
           || string.Equals(syncTenantId, internalTenantId, StringComparison.Ordinal);

    var expectedSyncHosts = new[] { prdApiHostRole, servingHostRole };
    var syncDocs = await gatewayDatabase.GetCollection<BsonDocument>("llmgw_imagegen_sync_status")
        .Find(Builders<BsonDocument>.Filter.In("_id", expectedSyncHosts.Select(role => $"{role}::{syncTenantId}")))
        .ToListAsync();
    var syncByHost = syncDocs.ToDictionary(
        x => x.AsNullableString("HostRole") ?? x.GetStringOrEmpty("_id"),
        x => x,
        StringComparer.Ordinal);

    List<string> PatternsOf(BsonDocument doc)
        => doc.TryGetValue("Patterns", out var raw) && raw is BsonArray arr
            ? [.. arr.Select(x => x.IsString ? x.AsString : string.Empty).Where(x => x.Length > 0)]
            : [];

    // 各个进程**应该**装到哪一版。
    //
    // 只比模式名答不出「我刚改的那条生效了没有」：改尺寸档位时模式名一个字都不变。
    // 所以两边各自从同一批行算一个「条数 : 最后修改时间」的版本号来比——
    // 这个值要和 ImageGenModelConfigSyncWorker 里算的那个逐字对齐（同一个定义，两处求值）。
    var versionSource = await gwImageModelConfigs
        .Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("Enabled", true),
            Builders<BsonDocument>.Filter.In("TenantId", new[] { syncTenantId, string.Empty })))
        .ToListAsync();
    string VersionOf(IEnumerable<BsonDocument> rows)
    {
        var usable = rows.Where(x => !string.IsNullOrWhiteSpace(x.GetStringOrEmpty("ModelIdPattern"))).ToList();
        if (usable.Count == 0) return "0:0";
        var newest = usable.Max(x => x.AsNullableUtcDateTime("UpdatedAt") ?? DateTime.MinValue);
        return $"{usable.Count}:{newest.Ticks}";
    }
    // 单租户进程装「本租户 + 平台级」，多租户进程只装平台级——期望值因此不是同一个。
    var expectedForSingleTenant = VersionOf(versionSource);
    var expectedForMultiTenant = VersionOf(versionSource.Where(x => x.GetStringOrEmpty("TenantId").Length == 0));

    var now = DateTime.UtcNow;
    var syncHosts = expectedSyncHosts.Select(role =>
    {
        syncByHost.TryGetValue(role, out var doc);
        var tenancy = doc?.AsNullableString("HostTenancy");
        var syncedAt = doc?.AsNullableUtcDateTime("SyncedAt");
        // 五态，按「它管不管这个租户 → 还活着吗 → 装的是不是这一版」的顺序判。
        // 合成一个 bool 会让「停了半天的进程」和「刚好慢一拍的进程」显示成同一句话。
        var state =
            !SyncHostAppliesToTenant(role) ? "not-applicable"
            : doc is null || syncedAt is null ? "never"
            : (now - syncedAt.Value).TotalSeconds > staleAfterSeconds ? "stale"
            // 认不出它是哪种进程（旧构建写的状态行还没有这个字段）→ 不替它担保，
            // 按「没装到这一版」报，等它下一轮写出新字段自然转正（no-rootless-tree：不编）。
            : tenancy is null ? "behind"
            : doc.AsNullableString("ContentVersion")
                != (string.Equals(tenancy, "MultiTenant", StringComparison.Ordinal)
                    ? expectedForMultiTenant
                    : expectedForSingleTenant) ? "behind"
            : "current";
        return new ImageGenSyncHost
        {
            HostRole = role,
            SyncedAt = syncedAt.ToIso(),
            OverrideCount = doc is null ? 0 : (int)(doc.AsNullableInt("OverrideCount") ?? 0),
            HostTenancy = tenancy,
            SkippedTenantScopedCount = doc is null ? 0 : (int)(doc.AsNullableInt("SkippedTenantScopedCount") ?? 0),
            SyncState = state,
        };
    }).ToList();

    // 汇总只看「会装本租户契约的那些进程」（单租户进程）。
    //
    // 多租户进程一条带租户的契约都不装，把它算进交集的话交集恒为空，
    // 这一屏就永远显示「0 条已生效」——一句永远不会兑现的话，比不说更糟。
    // 它自己的状态照样逐进程列出来，跳过的原因另有一句专门的说明。
    // 同理，不服务这个租户的进程也不进汇总：它不装本租户的契约，让它替这句话背书就是胡说。
    var tenantCarryingHosts = syncHosts
        .Where(x => !string.Equals(x.SyncState, "not-applicable", StringComparison.Ordinal))
        .Where(x => !string.Equals(x.HostTenancy, "MultiTenant", StringComparison.Ordinal))
        .ToList();
    var carriersCurrent = tenantCarryingHosts.Count > 0
        && tenantCarryingHosts.All(x => string.Equals(x.SyncState, "current", StringComparison.Ordinal));
    // 取最旧那一个的时间：汇总这句话只能由跟得最慢的那个进程来背书。
    // 比的是时间不是字符串——ISO 文本的字典序在格式有出入时会给出错的先后。
    var aggregateSyncedAt = carriersCurrent
        ? tenantCarryingHosts
            .Select(x => syncByHost[x.HostRole].AsNullableUtcDateTime("SyncedAt"))
            .Min()
            .ToIso()
        : null;
    var aggregatePatterns = carriersCurrent
        ? tenantCarryingHosts
            .Select(x => PatternsOf(syncByHost[x.HostRole]))
            .Aggregate((a, b) => [.. a.Intersect(b, StringComparer.Ordinal)])
        : [];

    return Json(ApiEnvelope<ImageGenConfigsData>.Ok(new ImageGenConfigsData
    {
        Items = items,
        Total = items.Count,
        BuiltinCount = builtin.Count,
        Builtin = builtin,
        BuiltinPublishedAt = builtinDoc?.AsNullableUtcDateTime("PublishedAt").ToIso(),
        RefreshSeconds = refreshSeconds,
        StaleAfterSeconds = staleAfterSeconds,
        SyncedAt = aggregateSyncedAt,
        SyncedPatterns = aggregatePatterns,
        SyncHosts = syncHosts,
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

app.MapPost("/gw/imagegen-configs", async (HttpContext http, [FromBody] UpsertImageGenConfigRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<ImageGenConfigItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var error = ValidateImageGenConfig(body);
    if (error is not null) return Json(ApiEnvelope<ImageGenConfigItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var pattern = body.ModelIdPattern!.Trim().ToLowerInvariant();

    var dupMessage = await FindImageGenPatternConflictAsync(gwImageModelConfigs, http, pattern, excludeId: null);
    if (dupMessage is not null)
        return Json(ApiEnvelope<ImageGenConfigItem>.Fail("PATTERN_EXISTS", dupMessage), jsonOptions, 409);

    var doc = BuildImageGenConfigDocument(body, tenantId, http, existing: null);
    try
    {
        await gwImageModelConfigs.InsertOneAsync(doc);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        // 上面那次查重与这次插入之间，别人插了同一个模式。库级唯一索引兜住了，
        // 这里把它翻成与查重同一个回答——不要报成「保存失败」，那会让人反复重试。
        return Json(ApiEnvelope<ImageGenConfigItem>.Fail("PATTERN_EXISTS",
            $"已经有一条 {pattern} 的契约（刚刚由别人建的），去改它而不是再加一条"), jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http,
        action: "imagegen_config.create", targetType: "llmgw_imagegen_model_config",
        targetId: doc.GetStringOrEmpty("_id"), targetName: pattern, success: true, reason: null,
        changes: new BsonDocument { { "modelIdPattern", pattern } });
    return Json(ApiEnvelope<ImageGenConfigItem>.Ok(MapImageGenConfig(doc)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapPut("/gw/imagegen-configs/{id}", async (HttpContext http, string id, [FromBody] UpsertImageGenConfigRequest? body) =>
{
    if (body is null) return Json(ApiEnvelope<ImageGenConfigItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);
    var error = ValidateImageGenConfig(body);
    if (error is not null) return Json(ApiEnvelope<ImageGenConfigItem>.Fail("INVALID_INPUT", error), jsonOptions, 400);

    var pattern = body.ModelIdPattern!.Trim().ToLowerInvariant();
    var filter = Builders<BsonDocument>.Filter.And(
        TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty),
        Builders<BsonDocument>.Filter.Eq("_id", id));
    var existing = await gwImageModelConfigs.Find(filter).FirstOrDefaultAsync();
    if (existing is null) return Json(ApiEnvelope<ImageGenConfigItem>.Fail("NOT_FOUND", "这条契约不存在"), jsonOptions, 404);

    // 更新端点原本一条都不查，等于留了一扇后门：把 A 的模式改成 B 已经占着的那个，
    // 库里就出现两条同模式的行，同步 worker 装进同一张按模式索引的表，
    // 谁赢取决于 Mongo 返回顺序——生图尺寸和参数翻译因此每次部署可能不一样。
    var conflict = await FindImageGenPatternConflictAsync(gwImageModelConfigs, http, pattern, excludeId: id);
    if (conflict is not null)
        return Json(ApiEnvelope<ImageGenConfigItem>.Fail("PATTERN_EXISTS", conflict), jsonOptions, 409);

    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var doc = BuildImageGenConfigDocument(body, tenantId, http, existing);
    try
    {
        await gwImageModelConfigs.ReplaceOneAsync(filter, doc);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<ImageGenConfigItem>.Fail("PATTERN_EXISTS",
            $"已经有一条 {pattern} 的契约（刚刚由别人建的），去改它而不是把这条改成同一个模式"), jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http,
        action: "imagegen_config.update", targetType: "llmgw_imagegen_model_config",
        targetId: id, targetName: doc.GetStringOrEmpty("ModelIdPattern"), success: true, reason: null,
        changes: new BsonDocument { { "modelIdPattern", doc.GetStringOrEmpty("ModelIdPattern") } });
    return Json(ApiEnvelope<ImageGenConfigItem>.Ok(MapImageGenConfig(doc)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

app.MapDelete("/gw/imagegen-configs/{id}", async (HttpContext http, string id) =>
{
    var filter = Builders<BsonDocument>.Filter.And(
        TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Empty),
        Builders<BsonDocument>.Filter.Eq("_id", id));
    var existing = await gwImageModelConfigs.Find(filter).FirstOrDefaultAsync();
    if (existing is null) return Json(ApiEnvelope<object>.Fail("NOT_FOUND", "这条契约不存在"), jsonOptions, 404);
    await gwImageModelConfigs.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(operationAudits, http,
        action: "imagegen_config.delete", targetType: "llmgw_imagegen_model_config",
        targetId: id, targetName: existing.GetStringOrEmpty("ModelIdPattern"), success: true, reason: null,
        changes: new BsonDocument { { "modelIdPattern", existing.GetStringOrEmpty("ModelIdPattern") } });
    return Json(ApiEnvelope<object>.Ok(new { deleted = true }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

/// <summary>
/// 契约的写入校验。这几条都是「填错了不会当场报错、只会在某次生图时悄悄给出错尺寸」的那种，
/// 所以拦在写入侧——运行时再发现就晚了。
/// </summary>
static string? ValidateImageGenConfig(UpsertImageGenConfigRequest body)
{
    var pattern = (body.ModelIdPattern ?? string.Empty).Trim();
    if (pattern.Length == 0) return "模型匹配模式不能为空";
    if (pattern.Length > 200) return "模型匹配模式过长";
    /*
      通配符：要么一个都没有，要么**只有结尾那一个**。

      上一版只看最后一个字符，于是 `nano**` 与 `nano*banana*` 都存得进去。前者运行时按
      TrimEnd('*') 归一之后等价于 `nano*`，却是唯一索引眼里的另一条模式——两条契约匹配同一批
      模型，谁生效看排序，而界面上它们看着是两条不同的规则（悄悄遮住别人）。后者中间那个星号
      被当成普通字符，这条契约通常一个模型都匹配不上，保存成功、永远不生效
      （第 59 轮 review；形状 1：判据只覆盖了最直观的那一种输入）。
    */
    var starCount = pattern.Count(ch => ch == '*');
    if (starCount > 1 || (starCount == 1 && !pattern.EndsWith('*')))
        return "通配符只能有一个、且只能放在结尾，如 nano-banana*";

    var format = (body.SizeParamFormat ?? "WxH").Trim();
    if (!ImageGenConfigVocabulary.SizeParamFormats.Contains(format))
        return $"尺寸参数格式只支持：{string.Join(" / ", ImageGenConfigVocabulary.SizeParamFormats)}";

    var constraint = (body.SizeConstraintType ?? "whitelist").Trim();
    if (!ImageGenConfigVocabulary.SizeConstraintTypes.Contains(constraint))
        return $"尺寸约束类型只支持：{string.Join(" / ", ImageGenConfigVocabulary.SizeConstraintTypes)}";

    // 「没有选尺寸这件事」与「配了尺寸档位」不能同时成立：编几个假尺寸出来，
    // 选择器会展示这个模型根本不接受的选项。
    var hasSizes = body.SizesByResolution?.Any(kv => kv.Value?.Count > 0) == true;
    if (body.SizesNotApplicable == true && hasSizes)
        return "既然勾了「这个模型没有选尺寸这件事」，就不能再配尺寸档位";

    // 比例模式的比例是从尺寸档位里推出来的，所以它同样必须有尺寸档位。
    //
    // 一行都不填时 NormalizeSizeAspectRatio 既选不出比例、也选不出尺寸，兜底回 1024x1024
    // 与 1:1——请求 1536x1024 会被静默改写成一个**比例都不对**的方图。这是白名单与范围
    // 那两条的第三个同族成员，前两轮各补了一个，这一个没扫到（形状 6：修完要横扫同类）。
    if (string.Equals(constraint, "aspect_ratio", StringComparison.OrdinalIgnoreCase)
        && body.SizesNotApplicable != true
        && !hasSizes)
    {
        return "比例模式的可选比例是从尺寸档位里推出来的，至少要配一个尺寸档位；"
            + "这个模型如果没有选尺寸这件事，就勾上「这个模型没有选尺寸这件事」";
    }

    // 白名单模式必须至少有一个尺寸，否则这条契约等于「把 1024x1024 钉死」。
    //
    // 白名单是表单默认档，尺寸一个都不填照样能存。存进去之后它**压过**代码内置那条契约，
    // 而 NormalizeSizeWhitelist 没有候选，兜底直接吐 1024x1024——匹配到的上游未必支持它。
    // 界面显示「已配好白名单」，实际是把所有请求都改写成了同一个写死的尺寸，
    // 而且不报错（形状 8：一份不成立的声明被当成了「已经配好」的证明）。
    // 这条与下面范围模式那条是同一族，上一轮只补了范围那一半。
    if (string.Equals(constraint, "whitelist", StringComparison.OrdinalIgnoreCase)
        && body.SizesNotApplicable != true
        && !hasSizes)
    {
        return "白名单模式至少要配一个尺寸档位；这个模型如果没有选尺寸这件事，就勾上「这个模型没有选尺寸这件事」，"
            + "或者改用范围 / 比例约束";
    }

    // 范围模式必须至少有一项边界，否则这条契约保存成功却什么都不约束。
    //
    // NormalizeSizeRange 只在这几个字段有值时才动尺寸；一个都不填就等于原样把用户要的
    // 尺寸发给上游——界面显示「已按范围约束」，实际没有任何约束，被上游拒时看不出是
    // 这里没配（形状 8：一份不成立的声明被当成了「已经配好」的证明）。
    // 拦在写入侧，不指望界面记得填：契约也可能从别的写入方进来。
    if (string.Equals((body.SizeConstraintType ?? string.Empty).Trim(), "range", StringComparison.OrdinalIgnoreCase)
        && body.SizesNotApplicable != true)
    {
        // 「填了」不等于「起作用」。
        //
        // minWidth=0 与 Math.Max 之后完全等价于没填；mustBeDivisibleBy 要大于 1 运行时才理它
        // （0 和 1 都被跳过）；而 maxWidth=0 更糟——它不是没约束，是把请求夹成 0x0 发出去。
        // 只判「有没有值」的话，这三种写法都能存进来，而那条「至少填一项」的承诺变成空话
        // （形状 8：一份不成立的声明被当成已经配好的证明）。所以判的是**有效**边界。
        if (body.MinWidth is <= 0 || body.MaxWidth is <= 0 || body.MinHeight is <= 0 || body.MaxHeight is <= 0)
            return "范围模式的宽高边界必须大于 0：填 0 等于没填（最小值），或者把请求夹成 0x0（最大值）";
        if (body.MaxPixels is <= 0)
            return "范围模式的最大像素总量必须大于 0";
        if (body.MustBeDivisibleBy is { } divisor && divisor <= 1)
            return "边长整除必须大于 1：填 0 或 1 时运行时会直接跳过这一项，等于没配";
        if (body.MinWidth is { } minW && body.MaxWidth is { } maxW && minW > maxW)
            return "范围模式的最小宽不能大于最大宽";
        if (body.MinHeight is { } minH && body.MaxHeight is { } maxH && minH > maxH)
            return "范围模式的最小高不能大于最大高";

        /*
          几项单独看都合法，合起来可能一个尺寸都不成立。

          两种真实形态：
            · 整除与最大值打架——最小宽 1000、整除 512，向上取整到 1024 就超了最大宽 1020；
            · 最小边长与像素总量打架——1024x1024 起步却限 262144 像素，运行时先套最小值
              再按像素缩放，缩出来的 512x512 反过来违反了刚刚套上的最小值。
          都属于「保存时说没问题、运行时给出一个不满足自己契约的尺寸」，而没有任何地方会报错。

          判据是构造一个最小可行尺寸：各边取「不小于最小值的最小合法值」（带整除就向上取整到
          整除的倍数），它超出最大值或像素上限，就说明这套约束无解。
        */
        var effectiveDivisor = body.MustBeDivisibleBy ?? 1;
        static long SmallestSide(int? min, int divisorValue)
        {
            var floor = min is { } m && m > 0 ? m : divisorValue;
            if (divisorValue <= 1) return floor;
            return ((floor + divisorValue - 1) / divisorValue) * (long)divisorValue;
        }
        // 只配整除、不配最小值：运行时 (side / divisor) * divisor 是**向下取整**，
        // 比除数小的边长会被抹成 0——除数 512 撞上 1024x256 的请求，发出去的是 1024x0。
        // 没有最小值把它托住，所以这种组合不许保存。
        // 两个轴都要有最小值托底，只给一个不够：
        // 运行时对宽高各做一次向下取整，没被托住的那一个轴照样会被抹成 0——
        // 最小宽 512、整除 512、不配最小高，遇到 1024x256 发出去的是 1024x0。
        // 上一版写成「两个都没配才拦」，等于只拦住了两个轴同时出问题的那一种（形状 1）。
        if (body.MustBeDivisibleBy is not null
            && (body.MinWidth is null || body.MinHeight is null))
        {
            return "配了「边长必须整除」就必须同时给出最小宽和最小高：运行时对宽高各做一次向下取整，"
                + "没有最小值托底的那一个轴，比整除值小的边长会被抹成 0"
                + "（例如整除 512、不配最小高，遇到 256 的高发出去就是 0）。"
                + "补齐两个最小值，或改用白名单尺寸";
        }

        var smallestWidth = SmallestSide(body.MinWidth, effectiveDivisor);
        var smallestHeight = SmallestSide(body.MinHeight, effectiveDivisor);
        if (body.MaxWidth is { } widthCap && smallestWidth > widthCap)
            return $"这套范围无解：宽最小只能取到 {smallestWidth}（受最小宽与整除约束），已经超过最大宽 {widthCap}";
        if (body.MaxHeight is { } heightCap && smallestHeight > heightCap)
            return $"这套范围无解：高最小只能取到 {smallestHeight}（受最小高与整除约束），已经超过最大高 {heightCap}";
        if (body.MaxPixels is { } pixelCap && smallestWidth * smallestHeight > pixelCap)
        {
            return $"这套范围无解：最小可行尺寸是 {smallestWidth}x{smallestHeight}，"
                + $"共 {smallestWidth * smallestHeight} 像素，已经超过最大像素总量 {pixelCap}。"
                + "运行时会先套最小值再按像素缩放，缩完反而违反最小值，而没有任何地方会报错";
        }
        if (body.MinWidth is null && body.MaxWidth is null
            && body.MinHeight is null && body.MaxHeight is null
            && body.MaxPixels is null && body.MustBeDivisibleBy is null)
        {
            return "范围模式至少要填一项边界（最小/最大宽高、最大像素总量、边长整除），"
                + "否则这条契约什么都不约束，尺寸会原样发给上游";
        }
    }

    foreach (var (bucket, list) in body.SizesByResolution ?? [])
    {
        if (!ImageGenConfigVocabulary.ResolutionBuckets.Contains(bucket))
            return $"分辨率档位只支持：{string.Join(" / ", ImageGenConfigVocabulary.ResolutionBuckets)}（收到 {bucket}）";
        foreach (var size in list ?? [])
        {
            if (!ImageGenConfigVocabulary.SizePattern.IsMatch(size ?? string.Empty))
                return $"尺寸要写成「宽x高」，如 1024x1024（收到 {size}）";
        }
    }

    /*
      参数改名的键只许**不分大小写**地各出现一次。

      运行时那张表是 OrdinalIgnoreCase 的（ImageGenConfigTranslation.ToAdapterConfig），
      同时写进 model 与 MODEL 的话，字典构造当场抛重复键——而同步器的兜底是「这一轮没拉到
      就沿用上一版」，于是这一条契约与**其余每一条正确的契约**从此都不再生效，每 60 秒重演一次，
      界面上只看得到一个不再前进的同步时间（第 66 轮 review）。

      这里当场拒掉：控制面比运行时严一档，写不进去就不会有那一轮。
    */
    var renameKeySeen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var (from, _) in body.ParamRenames ?? [])
    {
        var key = (from ?? string.Empty).Trim();
        if (key.Length == 0) continue;
        if (renameKeySeen.TryGetValue(key, out var earlier) && !string.Equals(earlier, key, StringComparison.Ordinal))
        {
            return $"参数改名的键「{earlier}」与「{key}」只有大小写之差，运行时把它们当同一个键，"
                + "两条一起存会让这张表整体装不进去（连带其它契约一起失效）。请只保留其中一条";
        }
        renameKeySeen[key] = key;
    }
    return null;
}

static BsonDocument BuildImageGenConfigDocument(
    UpsertImageGenConfigRequest body, string tenantId, HttpContext http, BsonDocument? existing)
{
    var sizes = new BsonDocument();
    foreach (var (bucket, list) in body.SizesByResolution ?? [])
        sizes[bucket] = new BsonArray((list ?? []).Select(x => x.Trim()));

    var renames = new BsonDocument();
    foreach (var (from, to) in body.ParamRenames ?? [])
    {
        if (string.IsNullOrWhiteSpace(from) || string.IsNullOrWhiteSpace(to)) continue;
        renames[from.Trim()] = to.Trim();
    }

    var doc = new BsonDocument
    {
        { "_id", existing?.GetStringOrEmpty("_id") ?? Guid.NewGuid().ToString("N") },
        { "TenantId", tenantId },
        { "ModelIdPattern", body.ModelIdPattern!.Trim().ToLowerInvariant() },
        { "MatchOrder", body.MatchOrder ?? 100 },
        { "Enabled", body.Enabled ?? true },
        { "DisplayName", body.DisplayName ?? string.Empty },
        { "Provider", body.Provider ?? string.Empty },
        { "PlatformType", (BsonValue?)body.PlatformType ?? BsonNull.Value },
        { "OfficialDocUrl", (BsonValue?)body.OfficialDocUrl ?? BsonNull.Value },
        { "SizeConstraintType", (body.SizeConstraintType ?? "whitelist").Trim() },
        { "SizeConstraintDescription", body.SizeConstraintDescription ?? string.Empty },
        { "SizesByResolution", sizes },
        { "SizesNotApplicable", body.SizesNotApplicable ?? false },
        { "SizeParamFormat", (body.SizeParamFormat ?? "WxH").Trim() },
        { "InjectSizePrompt", body.InjectSizePrompt ?? false },
        { "MustBeDivisibleBy", (BsonValue?)body.MustBeDivisibleBy ?? BsonNull.Value },
        { "MaxWidth", (BsonValue?)body.MaxWidth ?? BsonNull.Value },
        { "MaxHeight", (BsonValue?)body.MaxHeight ?? BsonNull.Value },
        { "MinWidth", (BsonValue?)body.MinWidth ?? BsonNull.Value },
        { "MinHeight", (BsonValue?)body.MinHeight ?? BsonNull.Value },
        { "MaxPixels", (BsonValue?)body.MaxPixels ?? BsonNull.Value },
        { "ParamRenames", renames },
        { "RequiresResolutionParam", body.RequiresResolutionParam ?? false },
        { "SupportsImageToImage", body.SupportsImageToImage ?? false },
        { "SupportsInpainting", body.SupportsInpainting ?? false },
        { "SupportsResponseFormat", body.SupportsResponseFormat ?? true },
        { "Notes", new BsonArray((body.Notes ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim())) },
        { "CreatedAt", existing?.AsNullableUtcDateTime("CreatedAt") ?? DateTime.UtcNow },
        { "UpdatedAt", DateTime.UtcNow },
        // 「谁最后改的」问的是人，不是租户。写租户 id 的话，同一个租户里所有管理员产出的
        // 归属一模一样，这个字段等于没有——而它存在的唯一理由就是回答这个问题。
        { "UpdatedBy", TenantAccess.GetRequired(http).UserId },
    };
    return doc;
}

static ImageGenConfigItem MapImageGenConfig(BsonDocument d)
{
    var sizes = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
    if (d.TryGetValue("SizesByResolution", out var raw) && raw is BsonDocument bucketDoc)
    {
        foreach (var element in bucketDoc)
        {
            sizes[element.Name] = element.Value is BsonArray arr
                ? [.. arr.Select(x => x.IsString ? x.AsString : string.Empty).Where(x => x.Length > 0)]
                : [];
        }
    }
    var renames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    if (d.TryGetValue("ParamRenames", out var rawRenames) && rawRenames is BsonDocument renameDoc)
    {
        foreach (var element in renameDoc)
            renames[element.Name] = element.Value.IsString ? element.Value.AsString : string.Empty;
    }
    return new ImageGenConfigItem
    {
        Id = d.GetStringOrEmpty("_id"),
        ModelIdPattern = d.GetStringOrEmpty("ModelIdPattern"),
        MatchOrder = d.AsNullableInt("MatchOrder") ?? 100,
        Enabled = d.AsNullableBool("Enabled") ?? true,
        DisplayName = d.GetStringOrEmpty("DisplayName"),
        Provider = d.GetStringOrEmpty("Provider"),
        PlatformType = d.AsNullableString("PlatformType"),
        OfficialDocUrl = d.AsNullableString("OfficialDocUrl"),
        SizeConstraintType = d.GetStringOrEmpty("SizeConstraintType"),
        SizeConstraintDescription = d.GetStringOrEmpty("SizeConstraintDescription"),
        SizesByResolution = sizes,
        SizesNotApplicable = d.AsNullableBool("SizesNotApplicable") ?? false,
        SizeParamFormat = d.GetStringOrEmpty("SizeParamFormat"),
        InjectSizePrompt = d.AsNullableBool("InjectSizePrompt") ?? false,
        MustBeDivisibleBy = d.AsNullableInt("MustBeDivisibleBy"),
        MaxWidth = d.AsNullableInt("MaxWidth"),
        MaxHeight = d.AsNullableInt("MaxHeight"),
        MinWidth = d.AsNullableInt("MinWidth"),
        MinHeight = d.AsNullableInt("MinHeight"),
        MaxPixels = d.AsNullableLong("MaxPixels"),
        ParamRenames = renames,
        RequiresResolutionParam = d.AsNullableBool("RequiresResolutionParam") ?? false,
        SupportsImageToImage = d.AsNullableBool("SupportsImageToImage") ?? false,
        SupportsInpainting = d.AsNullableBool("SupportsInpainting") ?? false,
        SupportsResponseFormat = d.AsNullableBool("SupportsResponseFormat") ?? true,
        Notes = d.TryGetValue("Notes", out var notes) && notes is BsonArray noteArr
            ? [.. noteArr.Select(x => x.IsString ? x.AsString : string.Empty).Where(x => x.Length > 0)]
            : [],
        UpdatedAt = d.AsNullableUtcDateTime("UpdatedAt").ToIso(),
    };
}

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

// 逻辑模型的近 N 天用量：按天卷起来，给列表里那条趋势线用。
//
// 为什么单开一个端点而不是复用 /gw/logs/summary：那个回的是整段窗口的标量汇总，
// 画不出「每天多少」；而列表要在一屏里给十来个模型各一条曲线，逐个模型打一次汇总
// 是 N+1。这里一次聚合把全部逻辑模型的日桶取回来。
//
// 花费只累加 CostStatus=priced 的那部分，缺价的单独计数——把算不出钱的当零成本加进去，
// 会让这条曲线看起来很省钱，而那正是缺价治理要避免的假象。
app.MapGet("/gw/logical-models/usage", async (HttpContext http, int? days) =>
{
    var window = Math.Clamp(days ?? 30, 1, 90);
    var toUtc = DateTime.UtcNow;
    var fromUtc = toUtc.Date.AddDays(-(window - 1));

    var fb = Builders<BsonDocument>.Filter;
    var filter = TenantAccess.FilterTeamScope(http, fb.And(
        fb.Gte("StartedAt", fromUtc),
        fb.Lte("StartedAt", toUtc),
        fb.Ne("LogicalModelPublicId", BsonNull.Value),
        fb.Exists("LogicalModelPublicId")));

    var group = new BsonDocument("$group", new BsonDocument
    {
        { "_id", new BsonDocument
            {
                { "publicId", "$LogicalModelPublicId" },
                { "day", new BsonDocument("$dateToString", new BsonDocument
                    {
                        { "format", "%Y-%m-%d" },
                        { "date", "$StartedAt" },
                    }) },
            }
        },
        { "calls", new BsonDocument("$sum", 1) },
        { "tokens", new BsonDocument("$sum", new BsonDocument("$add", new BsonArray
            {
                new BsonDocument("$ifNull", new BsonArray { "$InputTokens", 0 }),
                new BsonDocument("$ifNull", new BsonArray { "$OutputTokens", 0 }),
            })) },
        { "usd", LogCostAggregation.UsdSum() },
        // 「算不出钱的那些」= unpriced + stale_currency，两种都要数。
        //
        // stale_currency 的定义就是「有数字但币种过期或缺失，一律不计入成本」——
        // 它和 unpriced 一样不进 USD 合计、不进预算。只数字面的 unpriced 会让这一屏
        // 报「0 笔未计价」，而实际有一批存量 CNY / 缺币种的流量正被静悄悄排除在外，
        // 于是成本看起来偏低、而缺价治理这件事看起来已经做完了（形状 1：判据比它该管的范围窄）。
        // 判据取值与 GatewayCostStatusNames 那张表同源，见 2861 行那处过滤——那里两种都算。
        { "unpriced", LogCostAggregation.UnpricedCount() },
    });

    var pipeline = new EmptyPipelineDefinition<BsonDocument>()
        .Match(filter)
        .AppendStage<BsonDocument, BsonDocument, BsonDocument>(group);
    var rows = await logs.Aggregate(pipeline).ToListAsync();

    var dayKeys = Enumerable.Range(0, window)
        .Select(offset => fromUtc.AddDays(offset).ToString("yyyy-MM-dd"))
        .ToList();
    var dayIndex = dayKeys
        .Select((key, index) => (key, index))
        .ToDictionary(x => x.key, x => x.index, StringComparer.Ordinal);

    var byModel = new Dictionary<string, LogicalModelUsageItem>(StringComparer.Ordinal);
    foreach (var row in rows)
    {
        if (!row.TryGetValue("_id", out var idValue) || !idValue.IsBsonDocument) continue;
        var id = idValue.AsBsonDocument;
        var publicId = id.GetStringOrEmpty("publicId");
        if (publicId.Length == 0) continue;

        if (!byModel.TryGetValue(publicId, out var item))
        {
            item = new LogicalModelUsageItem
            {
                PublicId = publicId,
                Days = dayKeys,
                DailyCalls = new long[window],
            };
            byModel[publicId] = item;
        }

        var calls = row.AsNullableLong("calls") ?? 0;
        item.TotalCalls += calls;
        item.TotalTokens += row.AsNullableLong("tokens") ?? 0;
        item.TotalCostUsd += row.AsNullableDecimal("usd") ?? 0m;
        item.UnpricedCalls += row.AsNullableLong("unpriced") ?? 0;
        if (dayIndex.TryGetValue(id.GetStringOrEmpty("day"), out var slot))
            item.DailyCalls[slot] += calls;
    }

    return Json(ApiEnvelope<LogicalModelUsageData>.Ok(new LogicalModelUsageData
    {
        Days = window,
        From = fromUtc,
        To = toUtc,
        Items = byModel.Values.OrderByDescending(x => x.TotalCalls).ToList(),
    }), jsonOptions);
}).RequireAuthorization("LogsRead");

/*
  把存量模型池搬成模型：池的 Code 成公开名、成员成线路、IsDefaultForType 成默认标记。

  三条刻意的设计：

  1. **默认试运行**。不带 apply=true 时只算不写，把「会建哪些、会跳过哪些、为什么跳」
     整份计划回给人看。搬迁只跑一次，跑错了拿回来的是脏数据，不该由一次手滑决定。
  2. **只读旧表，写新表**。llmgw_model_pools 一个字节都不动，回退就是把新建的删掉。
  3. **可重复跑**。同名公开模型已存在就只补线路，同一条线路（同 targetId）已存在就跳过。
     搬到一半失败、或者新增了池要补搬，直接再跑一次即可，不会重复建。
*/
// 参数名在方法里叫 scopeModelType 是为了避开循环里的同名局部变量；
// 对外的 query key 仍然是 modelType——错误信息里让人加的就是它，两者必须一致。
app.MapPost("/gw/pools/migrate-to-models", async (
    HttpContext http,
    bool? apply,
    [FromQuery(Name = "modelType")] string? scopeModelType) =>
{
    var dryRun = apply != true;
    // 超过上限时的那句「请先按 modelType 分批」得真的做得到。
    //
    // 上一版只有 apply 一个参数，池多于上限的租户于是永远收到 TOO_MANY——
    // 而池路由已经删了，那个租户**再也没有办法**把存量搬过来。
    // 一句做不到的下一步比没有下一步更糟：它让人以为路是通的。
    var modelTypeFilter = (scopeModelType ?? string.Empty).Trim();
    var tenantId = TenantAccess.GetRequired(http).TenantId;
    var fb = Builders<BsonDocument>.Filter;
    var result = new PoolMigrationResult { DryRun = dryRun };

    /*
      池的来源有两个域，搬迁必须都扫。

      只读的 GET /gw/pools 对内部租户是把 MAP 的 model_groups 与网关自己的 llmgw_model_pools
      并起来的——因为运行时（池退场之前）两边都认。搬迁只读网关那一张表的话，MAP 原生的池
      一个都不会被搬；而池分支已经从解析路上删掉，那些池所承载的路由**直接消失**，
      搬迁报告却显示「全部搬完」（形状 1：判据比它该管的范围窄，这里窄在少看了一个数据域）。

      合并口径与只读端点逐字一致：同 _id 时网关表赢。
    */
    var poolScopeFilter = modelTypeFilter.Length > 0
        ? fb.Eq("ModelType", modelTypeFilter)
        : fb.Empty;
    var gatewayPools = await gwModelPools.Find(TenantAccess.Filter(http, poolScopeFilter)).ToListAsync();
    var gatewayPoolIds = gatewayPools
        .Select(d => d.GetStringOrEmpty("_id"))
        .Where(x => x.Length > 0)
        .ToHashSet(StringComparer.Ordinal);
    var mapPools = tenantId == internalTenantId
        ? (await modelGroups.Find(poolScopeFilter).ToListAsync())
            .Where(d => !gatewayPoolIds.Contains(d.GetStringOrEmpty("_id")))
            .ToList()
        : new List<BsonDocument>();
    var mapPoolIds = mapPools.Select(d => d.GetStringOrEmpty("_id")).ToHashSet(StringComparer.Ordinal);
    var pools = gatewayPools.Concat(mapPools).ToList();

    /*
      调用方对池的专属绑定写在**调用方那一侧**（ModelPoolId / DefaultModelPoolId），
      而新解析器只看模型这一侧的认领（DefaultForAppCallerCodes）。

      不转的话，一个绑了专属池的调用方在池退场后，不点名的请求会落到用途默认上——
      换了一个模型、而且没有任何提示。这正是这次搬迁要防的那种静默改变。
    */
    var poolBoundCallers = await gwAppCallers
        .Find(TenantAccess.Filter(http, fb.Empty))
        .Project(Builders<BsonDocument>.Projection
            .Include("AppCallerCode")
            .Include("RequestType")
            .Include("ModelPoolId")
            .Include("DefaultModelPoolId")
            .Include("AllowedModelPoolIds"))
        .ToListAsync();

    /*
      授权边界也要搬，而且它和「默认绑定」不是一回事。

      旧世界里 AllowedModelPoolIds 非空 = 这个调用方**只能用这几个池**，是一道硬边界。
      新世界的对应物在模型那一侧（AllowedAppCallerCodes：谁能用这个模型）。
      搬迁此前只写了空名单——空 = 对所有调用方开放，于是一个原本被限制在池 A 的调用方，
      搬完就能点名调用从池 B 搬过来的模型。边界不是变松了，是没了。

      翻译方向相反（一个挂在调用方、一个挂在模型），所以只能按当前这批调用方算一次：
      允许用池 P 的 = 没设限制的所有人 + 显式把 P 写进自己名单的人。
      这会把名单**冻结在此刻**——以后新增的调用方不在里面、需要人工加。代价要说出口，
      不能让人以为它会自动跟着变（no-rootless-tree：不假装有一个会自己更新的根）。

      没有任何调用方设过限制时不写名单：那才是今天的真实行为，凭空造一份名单
      等于用「更严」替换「没限制」，同样是改行为。
    */
    /*
      而且这份翻译必须**按用途分开算**。

      一个调用方在不同用途下是不同的记录，各有各的池限制。全租户一锅算的话，
      它那条「对话没设限制」的记录会让它进到一个**生图**池搬过来的模型的授权名单里，
      而它那条生图记录其实把自己限制在别的池上——边界不是搬过去了，是被搬宽了
      （形状 1：判据比它该管的范围窄，「同一个调用方有多条用途记录」这种输入让它给出相反答案）。
      所以按用途索引，翻译某个池时只看与这个池同用途的那些记录。
    */
    string CallerRequestType(BsonDocument caller)
        => caller.AsNullableString("RequestType")?.Trim() is { Length: > 0 } rt ? rt : string.Empty;

    var restrictedCallersByType = poolBoundCallers
        .Where(d => GetStringArray(d, "AllowedModelPoolIds").Count > 0)
        .GroupBy(CallerRequestType, StringComparer.Ordinal)
        .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
    var unrestrictedCallerCodesByType = poolBoundCallers
        .Where(d => GetStringArray(d, "AllowedModelPoolIds").Count == 0)
        .GroupBy(CallerRequestType, StringComparer.Ordinal)
        .ToDictionary(
            g => g.Key,
            g => g.Select(d => d.GetStringOrEmpty("AppCallerCode")).Where(x => x.Length > 0).ToList(),
            StringComparer.Ordinal);
    // 本轮已经规划出去的认领：同一个调用方在同一个用途下只能被一个模型认领，
    // dry-run 要和 apply 说同一件事（与上面标识、默认那两张本轮索引同一个道理）。
    var plannedClaims = new Dictionary<string, string>(StringComparer.Ordinal);
    // 兑换所成员要照搬成 TargetKind=exchange 的线路，先把启用的兑换所取出来一次，
    // 不在每个成员上重查（一个池几十个成员，逐个打库没必要）。
    var enabledExchangesForMigration = await gwModelExchanges
        .Find(TenantAccess.Filter(http, fb.Eq("Enabled", true)))
        .ToListAsync();
    // 判「这条线路现在承接得了流量吗」要用到物理模型挂的那个 Provider，同样先取一次。
    var platformsForMigration = (await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync())
        .Where(x => x.GetStringOrEmpty("_id").Length > 0)
        .ToDictionary(x => x.GetStringOrEmpty("_id"), x => x, StringComparer.Ordinal);
    if (pools.Count > PoolMigrationPlanner.MaxBatch)
    {
        var availableTypes = pools
            .Select(x => x.AsNullableString("ModelType") ?? string.Empty)
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        return Json(ApiEnvelope<PoolMigrationResult>.Fail("TOO_MANY",
            $"这一批有 {pools.Count} 个池，一次最多搬 {PoolMigrationPlanner.MaxBatch} 个。"
            + $"加 ?modelType=<用途> 分批搬，当前这批涉及的用途有：{string.Join("、", availableTypes)}"
            + (modelTypeFilter.Length > 0
                ? $"（你已经筛了 {modelTypeFilter}，这个用途本身就超了上限——先在模型池页把不再需要的池停用或删掉）"
                : string.Empty)), jsonOptions, 400);
    }
    result.PoolsScanned = pools.Count;

    /*
      dry-run 必须把「本次已经规划过的行」也算进来，否则预览与实际不符。

      两个池共用同一个规范化 Code 是旧模型允许的。dry-run 只查已持久化的对外模型，
      而它自己从不插入，于是第二个池照样被报成「新建一个模型」；apply 那一趟里第一个已经
      插进去了，第二个走的是复用、线路去重、甚至跨用途拒绝——预览说的和真写的是两回事。
      而 dry-run 的全部价值就是让人在写之前看清会发生什么（形状 5 的近亲：
      判据取的是「变更前」的状态，而这次变更自己会改变它）。

      所以在循环里维护一份「本轮已规划」的索引，查已存在时先问它。
    */
    var plannedByNormalizedPublicId = new Dictionary<string, BsonDocument>(StringComparer.Ordinal);
    var plannedDefaultByModelType = new Dictionary<string, string>(StringComparer.Ordinal);
    // 已规划的线路：{logicalId}::{targetKind}::{targetId}。dry-run 不插库，
    // 不记的话同一条线路会被两个池各报一次「新建」，而 apply 时第二次会被去重。
    var plannedOfferingKeys = new HashSet<string>(StringComparer.Ordinal);

    foreach (var pool in pools)
    {
        var poolId = pool.GetStringOrEmpty("_id");
        var poolName = pool.AsNullableString("Name") ?? poolId;
        var skip = PoolMigrationPlanner.SkipReason(pool);
        if (skip is not null)
        {
            result.Skipped.Add(new PoolMigrationSkip { PoolId = poolId, PoolName = poolName, Reason = skip });
            continue;
        }

        var publicId = PoolMigrationPlanner.ToPublicId(pool);
        var normalized = publicId.ToLowerInvariant();
        var modelType = pool.AsNullableString("ModelType") ?? "chat";
        /*
          「建成了几条线路」与「其中几条现在承接得了流量」是两回事。

          池成员可能指着一个已停用的物理模型、或者它挂的 Provider 不在了/被停用了。那种成员照样
          搬成线路（拓扑要留着，模型页上会标出它为什么不可用），但它一条流量都接不了。
          零线路那道闸若数的是前者，一个「每条线路的上游都不可用」的模型就躲过了它，
          带着用途默认与认领留在库里，而运行时把每一条都拒掉（第 55 轮 review）。
          所以闸门数的是后者，判据与新建线路那道闸同一份（OfferingTargetEligibility）。
        */
        var usableRouteCount = 0;
        var entry = new PoolMigrationEntry
        {
            PoolId = poolId,
            PoolName = poolName,
            PublicId = publicId,
            ModelType = modelType,
            RoutingStrategy = PoolMigrationPlanner.ToRoutingStrategy(pool),
            IsDefaultForType = PoolMigrationPlanner.IsDefaultForType(pool),
            FromMapDomain = mapPoolIds.Contains(poolId),
        };

        // 这个池的授权名单：只看与它**同用途**的那些调用方记录，
        // 而且只有当那一档里确实有人设过池级限制时才写，否则保持「对所有人开放」。
        var restrictedSameType = restrictedCallersByType.GetValueOrDefault(modelType) ?? [];
        var unrestrictedSameType = unrestrictedCallerCodesByType.GetValueOrDefault(modelType) ?? [];
        var poolAllowlist = restrictedSameType.Count == 0
            ? new List<string>()
            : unrestrictedSameType
                .Concat(restrictedSameType
                    .Where(d => GetStringArray(d, "AllowedModelPoolIds").Contains(poolId, StringComparer.Ordinal))
                    .Select(d => d.GetStringOrEmpty("AppCallerCode")))
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToList();

        // 这个池被哪些调用方绑成了专属/默认。两个字段都要认：
        // ModelPoolId 是专属绑定，DefaultModelPoolId 是「不点名时用它」，
        // 对新解析器而言它们是同一件事——不点名的请求该落到这个模型上。
        var boundCallerCodes = poolBoundCallers
            .Where(d => string.Equals(d.AsNullableString("ModelPoolId"), poolId, StringComparison.Ordinal)
                || string.Equals(d.AsNullableString("DefaultModelPoolId"), poolId, StringComparison.Ordinal))
            .Select(d => d.GetStringOrEmpty("AppCallerCode"))
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var existing = await gwLogicalModels.Find(fb.And(
            fb.Eq("TenantId", tenantId), fb.Eq("PublicIdNormalized", normalized))).FirstOrDefaultAsync();
        // 本轮已经规划过同一个标识时，按「它已经在了」处理——dry-run 才能和 apply 说同一件事。
        if (existing is null && plannedByNormalizedPublicId.TryGetValue(normalized, out var plannedExisting))
            existing = plannedExisting;

        // 复用同名模型之前必须核对用途：标识撞上不等于是同一个东西。
        //
        // 只按 PublicIdNormalized 找的话，一个叫 default-chat 的 generation 模型会被当成
        // 这个 chat 池的搬迁目标，池的物理线路就挂到了那个不相干的模型上；而运行时按
        // ModelType 查目录，原用途的请求根本解析不到它——搬迁报「已关联」，实际两头落空。
        if (existing is not null
            && !string.Equals(existing.GetStringOrEmpty("ModelType"), modelType, StringComparison.Ordinal))
        {
            result.Skipped.Add(new PoolMigrationSkip
            {
                PoolId = poolId,
                PoolName = poolName,
                Reason = $"标识「{publicId}」已经被一个 {existing.GetStringOrEmpty("ModelType")} 用途的模型占着，"
                    + $"而这个池是 {modelType}——标识撞上不代表是同一个东西，这个池整个没搬。"
                    + "先把池改名或把那个模型改名，再重跑搬迁",
            });
            continue;
        }

        /*
          「一个人都不许用」不能被翻译成「谁都能用」。

          poolAllowlist 的空集有两种来源，而落库之后长得一模一样：
            · 这一档里没人设过池级限制 → 本来就对所有人开放（restrictedSameType 为空）；
            · 设过限制，但没有任何调用方获准用这个池 → **一个人都不许用**。
          后者算出来也是空集，而 AllowedAppCallerCodes 为空在运行时的含义是「对所有调用方开放」。
          照直写下去，一个谁都调不到的池会在搬迁之后变成整个租户都能调——一次静默的授权放大。

          所以这一档不搬：报出来，等人给它一份显式名单再重跑。搬迁是幂等的，重跑不会重复建。
          （复用已有模型那条路不受影响：那条路本来就不动已有名单。）
        */
        /*
          这道门不分新建与复用。

          上一版只在 existing is null 时判，于是撞上「同标识的对外模型已经存在」就整个绕过去：
          搬迁保留那个模型原有的授权名单，却把这个「谁都没被授权」的池的成员当线路挂上去——
          一批原本谁都够不到的上游，一下子对所有获准使用那个模型的调用方开放
          （那个模型名单为空时就是全租户）。比新建那条路更糟，因为它连一行新记录都不留。
        */
        if (restrictedSameType.Count > 0 && poolAllowlist.Count == 0)
        {
            result.Skipped.Add(new PoolMigrationSkip
            {
                PoolId = poolId,
                PoolName = poolName,
                Reason = $"这个池在 {modelType} 这一档里一个调用方都没被授权使用（同用途的调用方都设了池级限制，"
                    + "而它们的名单里都没有这个池）。这种「谁都不许用」落到对外模型上会变成「谁都能用」——"
                    + "空的授权名单在运行时就是对所有调用方开放。所以这个池没有搬。"
                    + "确认它该授权给谁：去 appCaller 页把这个池加进某个调用方的名单，再重跑一次搬迁",
            });
            continue;
        }

        var logicalId = existing?.GetStringOrEmpty("_id") ?? $"gw-logical-{Guid.NewGuid():N}";
        entry.CreatedNewModel = existing is null;

        /*
          这个模型搬完之后实际生效的授权名单。新建走池翻译过来的那份，复用走它自己那份——
          复用时搬迁**刻意不动**已有名单（可能是人工调过的），所以那份就是最终值。

          认领要按这份名单过一遍，否则会写出一个自相矛盾的模型：名单里没有这个调用方，
          认领里却有它。运行时第一层按认领挑中它，第二步 SupportsAppCallerScenario 按名单
          把它拒掉，而且**不会**回头去试用途默认——这个调用方原本还能走池，搬完直接断流。
          报成功的搬迁把流量搬没了，比不转更糟。
        */
        var effectiveAllowlist = existing is null
            ? poolAllowlist
            : existing.AsStringList("AllowedAppCallerCodes") ?? [];

        /*
          认领唯一性：同一个用途下，一个调用方最多被一个模型认领。

          这条不变量在创建/更新端点有互斥，搬迁是直接写库，所以在这里把同一条规则再走一遍
          （判据分裂成两份各自漂移，正是这项工程要消灭的形状）。被别人占着的不硬抢，
          如实报出来——抢了的话，那个调用方的流量会从别人那里被夺过来，比不转更糟。
        */
        var claimsToTransfer = new List<string>();
        foreach (var code in boundCallerCodes)
        {
            var plannedKey = $"{modelType}::{code}";
            string? holder = null;
            if (plannedClaims.TryGetValue(plannedKey, out var plannedHolderId)
                && !string.Equals(plannedHolderId, logicalId, StringComparison.Ordinal))
            {
                holder = plannedHolderId;
            }
            else
            {
                var rival = await gwLogicalModels.Find(fb.And(
                    fb.Eq("TenantId", tenantId),
                    fb.Eq("ModelType", modelType),
                    fb.AnyEq("DefaultForAppCallerCodes", code),
                    fb.Ne("_id", logicalId))).FirstOrDefaultAsync();
                if (rival is not null) holder = rival.AsNullableString("PublicId") ?? rival.GetStringOrEmpty("_id");
            }

            if (holder is not null)
            {
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId,
                    PoolName = poolName,
                    Reason = $"调用方「{code}」绑着这个池，但同用途下它已经被模型「{holder}」认领了，"
                        + "认领没有转过来。池退场后这个调用方不点名的请求会落到那个模型上——"
                        + "确认哪一个才是它该用的，然后在模型白名单页手动改认领",
                });
                continue;
            }

            if (effectiveAllowlist.Count > 0 && !effectiveAllowlist.Contains(code, StringComparer.Ordinal))
            {
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId,
                    PoolName = poolName,
                    Reason = $"调用方「{code}」绑着这个池，但它映射到的对外模型「{publicId}」的授权名单里没有它，"
                        + "认领没有转过来。转了的话不点名的请求会挑中这个模型、再被授权名单拒掉，"
                        + "而且不会回落到用途默认——那是断流。"
                        + "确认这道边界该是什么样：要么在白名单页把这个调用方加进授权名单，要么给它另指一个模型",
                });
                continue;
            }

            claimsToTransfer.Add(code);
            plannedClaims[plannedKey] = logicalId;
        }
        entry.ClaimedAppCallerCodes = claimsToTransfer;

        /*
          同用途最多一个默认——这条不变量在 PUT 端点有互斥，搬迁是直接 Insert，绕过了它。
          判据分裂成两份各自漂移，正是这一整项工程要消灭的形状，所以这里把同一条规则再走一遍。

          存量里一个用途标了两个默认（直接写库、历史数据）是有可能的。第二个降级成普通模型
          并如实报出来，不能静默塞进去——两个默认之后，请求解析到哪个全看排序运气。
        */
        if (entry.IsDefaultForType)
        {
            var defaultTaken = await gwLogicalModels.Find(fb.And(
                fb.Eq("TenantId", tenantId),
                fb.Eq("ModelType", modelType),
                fb.Eq("IsDefaultForType", true),
                fb.Ne("_id", logicalId))).FirstOrDefaultAsync();
            // 本轮已经有别的池把这个用途的默认占了，也算占了——否则 dry-run 会说两个池都能当默认，
            // 而 apply 那一趟第二个必然被降级。
            string? plannedHolder = null;
            if (defaultTaken is null
                && plannedDefaultByModelType.TryGetValue(modelType, out var plannedDefaultId)
                && !string.Equals(plannedDefaultId, logicalId, StringComparison.Ordinal))
            {
                plannedHolder = plannedByNormalizedPublicId.Values
                    .FirstOrDefault(x => string.Equals(x.GetStringOrEmpty("_id"), plannedDefaultId, StringComparison.Ordinal))
                    ?.AsNullableString("PublicId") ?? plannedDefaultId;
            }
            if (defaultTaken is not null || plannedHolder is not null)
            {
                var holder = plannedHolder
                    ?? defaultTaken!.AsNullableString("PublicId")
                    ?? defaultTaken!.GetStringOrEmpty("_id");
                entry.IsDefaultForType = false;
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId,
                    PoolName = poolName,
                    Reason = $"{modelType} 用途的默认已经是「{holder}」，这个池的兜底标记没搬（同用途只能有一个默认）；"
                        + "线路照常搬，确认要换兜底就去模型页把默认改到它身上",
                });
            }
        }

        var now = DateTime.UtcNow;
        // 并发撞上同一个公开名时，这一趟不算「建了一个模型」——它挂到了别人刚建的那条上。
        var linkedByRace = false;
        if (existing is null)
        {
            if (!dryRun)
            {
                // 「同用途唯一默认」现在是库级约束（部分唯一索引）。上面那道预检拦得住
                // 本轮与已持久化的冲突，拦不住另一个人在这一瞬也设了默认——那时插入会撞
                // E11000。一次并发不该让整趟搬迁 500：降级成非默认再插一次，并如实报出来。
                var document = new BsonDocument
                {
                    { "_id", logicalId }, { "TenantId", tenantId },
                    { "PublicId", publicId }, { "PublicIdNormalized", normalized },
                    { "Name", poolName }, { "ModelType", modelType },
                    // 能力必须从池成员的快照里取。传 null 进去得到的是空集合，而空能力的模型
                    // 能力门一律不放行——搬迁报成功、调用方却调不到它，请求默默回落到池。
                    { "Capabilities", new BsonArray(LogicalModelCapabilityPolicy
                        .NormalizeDetailed(modelType, PoolMigrationPlanner.CollectCapabilities(pool)).Persisted) },
                    // 写入即打契约版本，与 create / update 两条路一致。
                    // 漏掉它的话，capability-audit 会把每一条刚搬过来的模型都算成「未版本化」，
                    // 一次成功的搬迁当场把发布闸判成不干净，而且要等控制台重启跑迁移才消。
                    { LogicalModelCapabilityPolicy.SchemaVersionField, LogicalModelCapabilityPolicy.SchemaVersion },
                    // 授权边界：租户里有人设过池级限制时把它翻译过来，没人设过就留空
                    //（留空 = 对所有调用方开放，与「谁都没被限制」的今天一致）。
                    // 见上面 restrictedCallers 那段：翻译会把名单冻结在此刻，代价已写在报告里。
                    { "AllowedAppCallerCodes", new BsonArray(poolAllowlist) },
                    // 但「谁不点名时落到这里」必须转过来。那是池的专属绑定
                    //（调用方那一侧的 ModelPoolId / DefaultModelPoolId），
                    // 而新解析器只看模型这一侧的认领——不转的话，那些调用方在池退场后
                    // 会静默改用用途默认，换了一个模型。
                    { "DefaultForAppCallerCodes", new BsonArray(claimsToTransfer) },
                    { "RoutingStrategy", entry.RoutingStrategy },
                    { "Enabled", true },
                    { "IsDefaultForType", entry.IsDefaultForType },
                    // 记住来源：`model_policy=pool` 契约还活着，那些请求带的是池文档 ID
                    // 而不是这里的 PublicId。不记的话它们在池退场后一律解析不到。
                    { "MigratedFromPoolIds", new BsonArray(new[] { poolId }) },
                    { "DisplayOrder", pool.AsNullableInt("Priority") ?? 100 },
                    { "Description", $"由模型池「{poolName}」搬迁而来" },
                    { "CreatedAt", now }, { "UpdatedAt", now },
                };
                try
                {
                    await gwLogicalModels.InsertOneAsync(document);
                }
                catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                {
                    /*
                      两条唯一索引都可能在这里撞上，处置不一样，所以必须先看是哪一条：
                        · 默认那条 → 去掉默认标记重插，这个池搬成普通模型；
                        · 认领那条 → 去掉被抢走的那几个认领重插。
                      上一版把所有 duplicate key 都当成默认冲突，于是认领撞车时带着**同一份认领数组**
                      重插，必然再抛一次——一次可报告的并发冲突变成 500，而前面几个池可能已经搬完了。
                    */
                    var message = ex.WriteError?.Message ?? ex.Message;
                    if (message.Contains("uniq_llmgw_logical_model_tenant_public_id", StringComparison.Ordinal))
                    {
                        /*
                          公开名撞车：另一个搬迁请求在这一瞬把同一个池搬完了。

                          这一档**不能重插**——重插带着同一个公开名，必然再抛一次，
                          而这一趟前面几个池可能已经搬好了，一次可报告的并发变成 500 加半批产物。
                          正确的做法是认下对方那一条：把 logicalId 换成它的，后面的线路照常挂上去，
                          等价于走「已存在同名模型」那条路。上一版把这种撞车当成默认冲突处理，
                          只清了默认标记就重插，于是必炸（形状 1：判据只认了两种索引，
                          第三种落进 else 得到一个与它无关的处置）。
                        */
                        var winner = await gwLogicalModels
                            .Find(fb.And(fb.Eq("TenantId", tenantId), fb.Eq("PublicIdNormalized", normalized)))
                            .FirstOrDefaultAsync();
                        if (winner is null) throw;

                        // 认下对方之前要复核用途：正常那条「已存在同名模型」的路会查，
                        // 这条恢复路不查的话，会把一个生图池的线路挂到一个对话模型下面——
                        // 原来那个用途一条路都没搬到，而赢家收了一批它根本用不了的上游。
                        var winnerType = winner.AsNullableString("ModelType") ?? string.Empty;
                        if (!string.Equals(winnerType, modelType, StringComparison.Ordinal))
                        {
                            result.Skipped.Add(new PoolMigrationSkip
                            {
                                PoolId = poolId,
                                PoolName = poolName,
                                Reason = $"另一个搬迁请求在同一瞬间用「{publicId}」建了一个 {winnerType} 模型，"
                                    + $"而这个池是 {modelType}——同名不同用途不能合成一条，这个池没搬。"
                                    + "给它换一个对外标识再搬",
                            });
                            continue;
                        }

                        logicalId = winner.GetStringOrEmpty("_id");
                        linkedByRace = true;
                        entry.CreatedNewModel = false;
                        entry.IsDefaultForType = winner.AsNullableBool("IsDefaultForType") ?? false;
                        entry.ClaimedAppCallerCodes = GetStringArray(winner, "DefaultForAppCallerCodes");
                        // 把这个池的 id 也记进去。不记的话，还带着 model_policy=pool 的存量客户端
                        // 拿这个池的文档 ID 来点名时查不到任何模型，一律 MODEL_NOT_FOUND——
                        // 正常那条「已存在同名模型」的路是会记的，这条恢复路漏了就是同一个洞。
                        await gwModelOfferings.Database
                            .GetCollection<BsonDocument>("llmgw_logical_models")
                            .UpdateOneAsync(
                                fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", logicalId)),
                                Builders<BsonDocument>.Update
                                    .AddToSet("MigratedFromPoolIds", poolId)
                                    .Set("UpdatedAt", DateTime.UtcNow));
                        result.Skipped.Add(new PoolMigrationSkip
                        {
                            PoolId = poolId,
                            PoolName = poolName,
                            Reason = $"另一个搬迁请求在同一瞬间已经把「{publicId}」建好了，这个池的线路直接挂到那一条上，"
                                + "没有重复建模型。确认那条模型的默认与认领是不是你要的",
                        });
                    }
                    else if (message.Contains("uniq_llmgw_logical_claim_per_type", StringComparison.Ordinal))
                    {
                        /*
                          认领撞车：这个池绑着的调用方里，**有的**在这一瞬被别的模型认领走了。

                          撞车的通常只是其中一个，而索引不会告诉你是哪一个（多键唯一索引只说撞了）。
                          上一版因此把整份认领清空重插——于是没被抢的那几个调用方也一起失去了接得住
                          它们的模型，池退场后它们会静默改用用途默认，换了一个模型没人知道。
                          一次影响一个调用方的并发，被放大成影响这个池的全部调用方（第 53 轮 review）。

                          所以回去读一遍现在谁认领着这几个 code，只去掉真被占走的那几个，其余照带。
                          读回来之后仍可能再撞（又有人在这几毫秒里认领了），那时才退回清空——
                          那是最后一道兜底，不是第一反应。两种情况报出来的话不一样：说清哪几个没带上。
                        */
                        var takenCodes = new HashSet<string>(StringComparer.Ordinal);
                        try
                        {
                            var holders = await gwLogicalModels
                                .Find(fb.And(
                                    fb.Eq("TenantId", tenantId),
                                    fb.Eq("ModelType", modelType),
                                    fb.AnyIn("DefaultForAppCallerCodes", claimsToTransfer)))
                                .ToListAsync();
                            foreach (var holder in holders)
                            {
                                foreach (var code in GetStringArray(holder, "DefaultForAppCallerCodes"))
                                {
                                    if (claimsToTransfer.Contains(code, StringComparer.Ordinal))
                                        takenCodes.Add(code);
                                }
                            }
                        }
                        catch (MongoException)
                        {
                            // 读不回来就当全被占了：宁可少带认领（去白名单页补得回来），
                            // 也不要带着一份猜出来的认领再撞一次，把并发冲突变成 500。
                            takenCodes.UnionWith(claimsToTransfer);
                        }

                        var keptClaims = claimsToTransfer
                            .Where(code => !takenCodes.Contains(code))
                            .ToList();
                        document["DefaultForAppCallerCodes"] = new BsonArray(keptClaims);
                        try
                        {
                            await gwLogicalModels.InsertOneAsync(document);
                        }
                        catch (MongoWriteException retry)
                            when (retry.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                        {
                            keptClaims = [];
                            document["DefaultForAppCallerCodes"] = new BsonArray();
                            await gwLogicalModels.InsertOneAsync(document);
                        }

                        entry.ClaimedAppCallerCodes = keptClaims;
                        var lostClaims = claimsToTransfer
                            .Where(code => !keptClaims.Contains(code, StringComparer.Ordinal))
                            .ToList();
                        result.Skipped.Add(new PoolMigrationSkip
                        {
                            PoolId = poolId,
                            PoolName = poolName,
                            Reason = "搬迁进行期间，绑着这个池的调用方里有"
                                + $"{lostClaims.Count} 个被别的模型认领了（{string.Join("、", lostClaims.Take(5))}"
                                + (lostClaims.Count > 5 ? " 等" : string.Empty)
                                + $"），这个池搬过来时没有带上它们；其余 {keptClaims.Count} 个照常带过来了。"
                                + "确认那几个调用方该归谁，再去白名单页改",
                        });
                    }
                    else
                    {
                        document["IsDefaultForType"] = false;
                        await gwLogicalModels.InsertOneAsync(document);
                        entry.IsDefaultForType = false;
                        result.Skipped.Add(new PoolMigrationSkip
                        {
                            PoolId = poolId,
                            PoolName = poolName,
                            Reason = $"这个池是 {modelType} 的默认，但搬迁进行期间这个用途的默认被别人占了，"
                                + "所以它搬成了普通模型。确认哪一个才该当默认，再去白名单页改",
                        });
                    }
                }
            }
            if (linkedByRace) result.LinkedToExisting++;
            else result.ModelsCreated++;
        }
        else
        {
            /*
              已有同名模型时顺手修一件事：能力为空。

              空能力从来不是一个合法状态——能力门一律不放行，这个模型的存在只会让调用方
              以为它能用。搬迁第一版就产出过一批这样的模型（传 null 进能力归一得到空集合），
              光靠「重跑不会重复建」修不回来，只能在这里补。

              只补空的，不动已经有能力的：那些可能是人工调过的，搬迁没有资格覆盖。
            */
            var existingCaps = existing.GetValue("Capabilities", BsonNull.Value);
            var isEmpty = !existingCaps.IsBsonArray || existingCaps.AsBsonArray.Count == 0;
            if (isEmpty)
            {
                var repaired = LogicalModelCapabilityPolicy
                    .NormalizeDetailed(modelType, PoolMigrationPlanner.CollectCapabilities(pool)).Persisted;
                if (repaired.Count > 0)
                {
                    if (!dryRun)
                    {
                        await gwLogicalModels.UpdateOneAsync(
                            fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", logicalId)),
                            Builders<BsonDocument>.Update
                                .Set("Capabilities", new BsonArray(repaired))
                                // 补了能力就得同时补版本，否则这条修复自己又留下一个未版本化文档。
                                .Set(LogicalModelCapabilityPolicy.SchemaVersionField, LogicalModelCapabilityPolicy.SchemaVersion)
                                .Set("UpdatedAt", DateTime.UtcNow));
                    }
                    entry.RepairedCapabilities = true;
                }
            }
            // 复用已有模型时也要把这个池 id 并进来源里：它同样会收到带池 ID 的请求。
            // AddToSet 而不是 Set——一个模型可能被多个同 Code 的池先后搬过来。
            //
            // 兜底标记也要搬。一个**默认**池映射到已存在的对外模型时，这里不设 IsDefaultForType
            // 的话，池退场后不点名的请求就不会落到它——那条流量原本是池在接的，搬完反而接不住了
            // （要么整个失败，要么落到另一个用途默认上，换了模型）。
            //
            // entry.IsDefaultForType 走到这里时已经过了上面那道同用途唯一性检查：
            // 被别人占着就已经降级成 false 并如实报进 Skipped，所以这里直接用它是安全的。
            var reuseUpdate = Builders<BsonDocument>.Update
                .AddToSet("MigratedFromPoolIds", poolId)
                .Set("UpdatedAt", DateTime.UtcNow);
            if (entry.IsDefaultForType)
                reuseUpdate = reuseUpdate.Set("IsDefaultForType", true);
            // 认领同样要搬。AddToSetEach 而不是 Set——这个模型可能已经认领了别的调用方，
            // 覆盖过去会把它们悄悄摘掉。
            if (claimsToTransfer.Count > 0)
                reuseUpdate = reuseUpdate.AddToSetEach("DefaultForAppCallerCodes", claimsToTransfer);
            /*
              复用已有模型时**不动**它的授权名单：那个模型可能是别人建的、名单也可能是人工调过的，
              搬迁没有资格替它收紧或放宽。但只要两边不一致就必须报出来——
              上一版只报了「已有名单为空」这一种，那只是不一致里最显眼的一个特例（形状 1）。

              两边都非空且不相等时，两个方向的偏差同时存在，而且都不会有任何提示：
                · 已有名单里、池名单外的调用方 → 能够到这个池搬过来的线路（越权）；
                · 池名单里、已有名单外的调用方 → 够不到它本来有权用的上游（失权）。
              所以判的是「相等与否」，不是「空与否」。
            */
            var existingAllowlist = existing?.AsStringList("AllowedAppCallerCodes") ?? [];
            var allowlistMatches = poolAllowlist.Count == existingAllowlist.Count
                && poolAllowlist.All(x => existingAllowlist.Contains(x, StringComparer.Ordinal));
            if (poolAllowlist.Count > 0 && !allowlistMatches)
            {
                var extra = existingAllowlist.Where(x => !poolAllowlist.Contains(x, StringComparer.Ordinal)).ToList();
                var missing = poolAllowlist.Where(x => !existingAllowlist.Contains(x, StringComparer.Ordinal)).ToList();
                var detail = existingAllowlist.Count == 0
                    ? "它当前对所有调用方开放"
                    : $"两边名单不一致：{(extra.Count > 0 ? $"多出 {string.Join("、", extra)}（这些调用方将能用到本池的线路）" : string.Empty)}"
                      + $"{(extra.Count > 0 && missing.Count > 0 ? "；" : string.Empty)}"
                      + $"{(missing.Count > 0 ? $"缺少 {string.Join("、", missing)}（这些调用方将用不到它们本来有权用的上游）" : string.Empty)}";
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId,
                    PoolName = poolName,
                    Reason = $"这个池有池级授权限制，但它映射到的对外模型「{publicId}」已经存在，{detail}。"
                        + "搬迁没有改它的授权名单（那可能是人工调过的），线路照常挂上去了。"
                        + "确认这道边界该是什么样，再去白名单页手动设",
                });
            }
            if (!dryRun)
            {
                await gwLogicalModels.UpdateOneAsync(
                    fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", logicalId)),
                    reuseUpdate);
            }
            result.LinkedToExisting++;
        }

        // 记进本轮索引：下一个池若撞上同一个标识或同一个用途默认，dry-run 要和 apply 说同一件事。
        plannedByNormalizedPublicId[normalized] = new BsonDocument
        {
            { "_id", logicalId },
            { "PublicId", publicId },
            { "PublicIdNormalized", normalized },
            { "ModelType", modelType },
            { "IsDefaultForType", entry.IsDefaultForType },
            // 名单也要记进本轮索引：下一个池若撞上同一个标识，认领该不该转得按同一份名单判，
            // 否则 dry-run 与 apply 在「第二个池」上会说两件事。
            { "AllowedAppCallerCodes", new BsonArray(effectiveAllowlist) },
        };
        if (entry.IsDefaultForType)
            plannedDefaultByModelType[modelType] = logicalId;

        var members = pool.GetValue("Models", BsonNull.Value) is { IsBsonArray: true } arr
            ? arr.AsBsonArray.Where(x => x.IsBsonDocument).Select(x => x.AsBsonDocument).ToList()
            : new List<BsonDocument>();
        foreach (var member in members)
        {
            var memberModelId = member.AsNullableString("ModelId") ?? string.Empty;
            var memberPlatformId = member.AsNullableString("PlatformId") ?? string.Empty;
            if (memberModelId.Length == 0) continue;

            // 池成员记的是「模型名 + 平台 id」，Offering 指的是物理模型文档的 _id，要换算一次。
            // 换不出来说明这个成员指向的模型已经不在库里了，跳过并报出来——搬一条指向空气的
            // 线路，只会让这个模型在真调用时才炸。
            // 成员的 ModelId 可能对应物理文档的三种字段之一：早期入库的模型没有 ModelName，
            // 供给侧当时是从 Name 或 _id 取的标识写进池成员的。只查 ModelName 会把那些
            // 完全合法的成员报成「找不到」，搬过去的模型于是少线路——池退役之后就再也没有
            // 别的路能接住它们了（形状 1：判据比它该管的范围窄）。
            // 先看它是不是兑换所成员。两种合法写法：PlatformId 直接写兑换所 _id，
            // 或写成 __exchange__ 由中继按模型名匹配（判据与 IsResolvablePoolMemberKey 同源）。
            //
            // 漏掉这一支的后果不是少一条线路，是**整个池搬成零线路**：一个纯 Exchange 的池
            // 里每个成员都被报成「模型库里找不到」，搬过去的对外模型一条线路都没有，
            // 而池路由此时已经删了——那些流量再也没有别的路可走。
            // 上一轮把「成员按三种标识匹配」补上时只扫了物理模型这一族，兑换所这一族没跟着扫。
            BsonDocument? memberExchange = null;
            if (memberPlatformId.Length > 0)
            {
                memberExchange = string.Equals(memberPlatformId, "__exchange__", StringComparison.Ordinal)
                    ? enabledExchangesForMigration.FirstOrDefault(x => GatewayExchangeSupportsModel(x, memberModelId))
                    : enabledExchangesForMigration.FirstOrDefault(x =>
                        string.Equals(x.GetStringOrEmpty("_id"), memberPlatformId, StringComparison.Ordinal)
                        && GatewayExchangeSupportsModel(x, memberModelId));
            }

            if (memberExchange is not null)
            {
                var exchangeId = memberExchange.GetStringOrEmpty("_id");
                /*
                  去重键必须带上**打给兑换所的那个模型标识**，不能只到兑换所为止。

                  一个兑换所底下挂着多个别名，池里也常常同时放着好几个（claude-3-opus 与
                  claude-3-sonnet 都走同一个中继）。线路真正调的是哪一个由 UpstreamModelId
                  决定，所以它们是**不同的**线路；键只到兑换所的话，第一个成员占住键，
                  后面每一个别名都被静默 continue 掉——不报错、不进 Skipped，
                  而池路由已经删了，那些别名搬完就此消失（形状 1：判据比它该管的范围窄，
                  「同一个兑换所的不同别名」这种输入让它给出了相反答案）。
                */
                var exchangeRouteKey = $"{logicalId}::exchange::{exchangeId}::{memberModelId}";
                var existingExchangeRoute = await gwModelOfferings.Find(fb.And(
                    fb.Eq("TenantId", tenantId), fb.Eq("LogicalModelId", logicalId),
                    fb.Eq("TargetKind", "exchange"), fb.Eq("TargetId", exchangeId),
                    // 与两个写入端点同一份判据：库里那条没写 UpstreamModelId 的线路，
                    // 运行时回落到的正是兑换所主别名——它与本成员同名时就是同一条上游，
                    // 逐字比会漏掉它、再建一条，同一个上游拿两份权重。
                    OfferingIdentityPolicy.SameUpstreamFilter("exchange", memberExchange, memberModelId)))
                    .FirstOrDefaultAsync();
                if (plannedOfferingKeys.Contains(exchangeRouteKey) || existingExchangeRoute is not null)
                {
                    /*
                      这条线路上一趟已经建过了，不重复建——但它照样要算进「有几条能接流量」。

                      不算的话，上一趟因为上游坏了被停用的模型，这一趟即使上游修好了也数出零，
                      于是那个「把它放回来」的分支永远不触发，上一轮许下的恢复路径还是走不通
                      （第 57 轮 review：修复本身依赖一个数不全的计数器）。
                    */
                    if (existingExchangeRoute is not null
                        && MigrationExistingRouteCountsAsUsable(
                            existingExchangeRoute,
                            OfferingTargetEligibility.Evaluate(
                                "exchange", memberExchange, null, memberModelId)))
                    {
                        usableRouteCount++;
                    }

                    continue;
                }

                plannedOfferingKeys.Add(exchangeRouteKey);

                var lostExchangePrices = DescribeLostMemberPrices(member, null);
                if (lostExchangePrices.Count > 0)
                {
                    result.Skipped.Add(new PoolMigrationSkip
                    {
                        PoolId = poolId, PoolName = poolName,
                        Reason = $"成员「{memberModelId}」（兑换所）在池里配了自己的价格（{string.Join("、", lostExchangePrices)}），"
                            + "而线路没有价格字段、兑换所也没有物理模型可回落——搬过来之后这条线路会被判成未计价，"
                            + "不进用量汇总也不参与限额。线路本身照常建好了，价格要另行安排",
                    });
                }

                if (DescribeLostMemberMaxTokens(member, null) is { Length: > 0 } lostExchangeCap)
                {
                    result.Skipped.Add(new PoolMigrationSkip
                    {
                        PoolId = poolId, PoolName = poolName,
                        Reason = $"成员「{memberModelId}」（兑换所）：{lostExchangeCap}。线路没有输出上限这个字段，"
                            + "搬过来之后这条限制不再生效。线路本身照常建好了，上限要另行安排",
                    });
                }

                var carriedExchangeHealth = PoolMigrationPlanner.CarryHealthStatus(member, now);
                if (carriedExchangeHealth != 0) entry.CarriedUnhealthyRoutes++;
                if (!dryRun)
                {
                    await gwModelOfferings.InsertOneAsync(new BsonDocument
                    {
                        { "_id", $"gw-offering-{Guid.NewGuid():N}" }, { "TenantId", tenantId },
                        { "LogicalModelId", logicalId }, { "TargetKind", "exchange" }, { "TargetId", exchangeId },
                        { "UpstreamModelId", memberModelId },
                        { "Protocol", member.AsNullableString("Protocol") is { Length: > 0 } ep ? ep : BsonNull.Value },
                        { "EndpointPath", BsonNull.Value },
                        { "Priority", PoolMigrationPlanner.MemberPriority(member) },
                        { "Weight", member.AsNullableInt("Weight") ?? 100 },
                        { "Enabled", true },
                        { "HealthStatus", carriedExchangeHealth },
                        { "ConsecutiveFailures", carriedExchangeHealth != 0 ? member.AsNullableInt("ConsecutiveFailures") ?? 1 : 0 },
                        { "ConsecutiveSuccesses", 0 },
                        { "LastFailedAt", carriedExchangeHealth != 0 && member.GetValue("LastFailedAt", BsonNull.Value) is { IsValidDateTime: true } elf
                            ? elf : BsonNull.Value },
                        { "MaxConcurrency", member.AsNullableInt("MaxConcurrency") is { } emc && emc > 0 ? emc : BsonNull.Value },
                        { "RateLimitPerMinute", BsonNull.Value },
                        { "Notes", BsonNull.Value },
                        { "CreatedAt", now }, { "UpdatedAt", now },
                    });
                }
                entry.RouteCount++;
                result.RoutesCreated++;
                /*
                  上游够格还不够：池成员近期的不可用是**照搬**过来的（CarryHealthStatus），
                  而运行时把熔断态的线路整条跳过。只判上游的话，一个「成员全在熔断里」的池
                  搬过来仍然数出有可用线路，模型带着默认与认领留在库里，池退场之后每一个请求
                  都当场失败（第 57 轮 review：判据比它该管的范围窄）。
                */
                if (MigrationRouteCountsAsUsable(
                        carriedExchangeHealth,
                        enabled: true,
                        OfferingTargetEligibility.Evaluate("exchange", memberExchange, null, memberModelId)))
                {
                    usableRouteCount++;
                }

                continue;
            }

            var physical = await gwModels.Find(fb.And(
                fb.Eq("TenantId", tenantId),
                fb.Or(
                    fb.Eq("ModelName", memberModelId),
                    fb.Eq("Name", memberModelId),
                    fb.Eq("_id", memberModelId)),
                memberPlatformId.Length > 0 ? fb.Eq("PlatformId", memberPlatformId) : fb.Empty)).FirstOrDefaultAsync();
            if (physical is null)
            {
                /*
                  查不到不代表这个成员不存在——它可能还在 MAP 域（`models` 集合）里。

                  线路只能指向网关自己的模型文档：解析器查的是 llmgw_models，
                  拿一个 MAP 文档的 _id 建线路，运行时一条都解析不到（建了等于没建）。
                  所以这里不自动把它搬进网关——那要连密钥一起复制，是个该由人点头的动作。
                  能做也必须做的是**说清楚**：这个成员在哪、为什么没搬、下一步点哪儿。
                  报成「模型库里找不到」是假话，而且那句话没有下一步。
                */
                var mapNative = tenantId == internalTenantId
                    ? await models.Find(Builders<BsonDocument>.Filter.And(
                        Builders<BsonDocument>.Filter.Or(
                            Builders<BsonDocument>.Filter.Eq("ModelName", memberModelId),
                            Builders<BsonDocument>.Filter.Eq("Name", memberModelId),
                            Builders<BsonDocument>.Filter.Eq("_id", memberModelId)),
                        memberPlatformId.Length > 0
                            ? Builders<BsonDocument>.Filter.Eq("PlatformId", memberPlatformId)
                            : Builders<BsonDocument>.Filter.Empty)).FirstOrDefaultAsync()
                    : null;
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId, PoolName = poolName,
                    Reason = mapNative is not null
                        ? $"成员「{memberModelId}」还在 MAP 域，没有认领进网关——线路只能指向网关自己的模型，"
                          + "所以这条没搬。先在「模型」页把它认领进网关，再重跑一次搬迁（已搬的不会重复建）"
                        : $"成员「{memberModelId}」在模型库里找不到对应记录，这条线路没搬",
                });
                continue;
            }

            var physicalId = physical.GetStringOrEmpty("_id");
            // 上游调用名取物理文档登记的 ModelName，不沿用池成员记的那个标识。
            // 放宽匹配之后两者可能不是一回事（成员记的是 Name 或 _id），
            // 照抄过去就是拿一个上游不认识的名字去调它。
            var upstreamModelId = physical.AsNullableString("ModelName") is { Length: > 0 } registered
                ? registered
                : memberModelId;
            var modelRouteKey = $"{logicalId}::model::{physicalId}";
            var existingModelRoute = await gwModelOfferings.Find(fb.And(
                fb.Eq("TenantId", tenantId), fb.Eq("LogicalModelId", logicalId),
                fb.Eq("TargetKind", "model"), fb.Eq("TargetId", physicalId))).FirstOrDefaultAsync();
            if (plannedOfferingKeys.Contains(modelRouteKey) || existingModelRoute is not null)
            {
                // 同上：已经存在的那条也要算进「有几条能接流量」，否则重跑搬迁数出来永远是零。
                if (existingModelRoute is not null)
                {
                    platformsForMigration.TryGetValue(
                        physical.AsNullableString("PlatformId") ?? string.Empty, out var existingPlatform);
                    if (MigrationExistingRouteCountsAsUsable(
                            existingModelRoute,
                            OfferingTargetEligibility.Evaluate(
                                "model", physical, existingPlatform, existingModelRoute.AsNullableString("UpstreamModelId"))))
                    {
                        usableRouteCount++;
                    }
                }

                continue;
            }

            plannedOfferingKeys.Add(modelRouteKey);

            var lostPrices = DescribeLostMemberPrices(member, physical);
            if (lostPrices.Count > 0)
            {
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId, PoolName = poolName,
                    Reason = $"成员「{memberModelId}」在池里配了自己的价格（{string.Join("、", lostPrices)}），"
                        + $"与模型「{upstreamModelId}」文档上的价格不一致。搬过来之后计价只看模型文档，"
                        + "这几项会按模型文档的值算（没配就判成未计价）。线路本身照常建好了，"
                        + "要保持原价就去模型页把这几个值填到那个模型上",
                });
            }

            if (DescribeLostMemberMaxTokens(member, physical) is { Length: > 0 } lostCap)
            {
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId, PoolName = poolName,
                    Reason = $"成员「{memberModelId}」：{lostCap}。线路没有输出上限这个字段，走线路解析时取的是"
                        + "物理模型上的那个，搬过来之后成员原本的上限不再生效。线路本身照常建好了，"
                        + "要么把这个值配到物理模型上，要么接受它改用模型的上限",
                });
            }

            var carriedHealth = PoolMigrationPlanner.CarryHealthStatus(member, now);
            if (carriedHealth != 0) entry.CarriedUnhealthyRoutes++;
            if (!dryRun)
            {
                await gwModelOfferings.InsertOneAsync(new BsonDocument
                {
                    { "_id", $"gw-offering-{Guid.NewGuid():N}" }, { "TenantId", tenantId },
                    { "LogicalModelId", logicalId }, { "TargetKind", "model" }, { "TargetId", physicalId },
                    { "UpstreamModelId", upstreamModelId },
                    { "Protocol", member.AsNullableString("Protocol") is { Length: > 0 } mp ? mp : BsonNull.Value },
                    { "EndpointPath", BsonNull.Value },
                    { "Priority", PoolMigrationPlanner.MemberPriority(member) },
                    { "Weight", member.AsNullableInt("Weight") ?? 100 },
                    { "Enabled", true },
                    // 近期的不可用照搬，陈年旧账重置成健康。两头都不对：全搬会让新路径带着
                    // 一个早就过期的判断少一条候选；全不搬会让新路径去用一个池正在主动避开的
                    // 上游。判据见 PoolMigrationPlanner.CarryHealthStatus（降级那一档同样照搬）。
                    { "HealthStatus", carriedHealth },
                    { "ConsecutiveFailures", carriedHealth != 0 ? member.AsNullableInt("ConsecutiveFailures") ?? 1 : 0 },
                    { "ConsecutiveSuccesses", 0 },
                    { "LastFailedAt", carriedHealth != 0 && member.GetValue("LastFailedAt", BsonNull.Value) is { IsValidDateTime: true } lf
                        ? lf : BsonNull.Value },
                    { "MaxConcurrency", member.AsNullableInt("MaxConcurrency") is { } mc && mc > 0 ? mc : BsonNull.Value },
                    { "RateLimitPerMinute", BsonNull.Value },
                    { "Notes", BsonNull.Value },
                    { "CreatedAt", now }, { "UpdatedAt", now },
                });
            }
            entry.RouteCount++;
            result.RoutesCreated++;
            platformsForMigration.TryGetValue(
                physical.AsNullableString("PlatformId") ?? string.Empty, out var memberPlatform);
            // 同上：照搬过来的熔断态会让运行时把这条线路整条跳过，它不算「能接流量」。
            if (MigrationRouteCountsAsUsable(
                    carriedHealth,
                    enabled: true,
                    OfferingTargetEligibility.Evaluate("model", physical, memberPlatform, upstreamModelId)))
            {
                usableRouteCount++;
            }
        }

        /*
          一条线路都没建成的池，不许把「接流量」这个身份带过来。

          成员全被跳过是有可能的：只存在于 MAP 模型集合里、指向一个已经不在的物理模型、
          或者别的过不了关的原因。而模型文档是在这之前插入的，那一刻还不知道最终会有几条线路，
          于是一个 Enabled、带着认领、可能还带着用途默认、却**一条线路都没有**的模型留在库里。
          解析器挑不点名的请求时会选中它，然后回 OfferingUnresolvable——搬迁之前还走得通的那些
          调用方，搬完立刻断掉；如果它还成了用途默认，断的是整个用途（第 54 轮 review）。
          这是本 PR 一直在修的那个形状的又一例：存得进去、跑不起来。

          所以在这里回头看一眼真实结果：零线路就把身份摘掉并停用。留着这条模型不删，是因为
          它记着 MigratedFromPoolIds——`model_policy=pool` 的存量客户端拿池 ID 点名时还要靠它
          查得到；删掉等于把那条路也断了。停用的模型不会被解析器选中，也不会接不点名的请求。
        */
        // 只管**这一趟新建的**那种模型。复用既有同名模型时那条模型本来就有自己的线路与身份，
        // 这一趟没给它加上线路不等于它没有线路——照着停用它会把一条好好在跑的模型打掉。
        // 撞车认领到别人那条的情形（linkedByRace）同理，更不能动。
        if (!dryRun && usableRouteCount == 0 && entry.CreatedNewModel && !linkedByRace
            && logicalId is { Length: > 0 })
        {
            var hadDefault = entry.IsDefaultForType;
            var hadRoles = hadDefault || entry.ClaimedAppCallerCodes.Count > 0;
            await gwLogicalModels.UpdateOneAsync(
                fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", logicalId)),
                Builders<BsonDocument>.Update
                    .Set("Enabled", false)
                    .Set("IsDefaultForType", false)
                    .Set("DefaultForAppCallerCodes", new BsonArray())
                    // 盖一个「这是搬迁停的」的戳，下一趟搬迁据此把它放回来（见下面那个分支）。
                    // 没有这个戳的话，重跑搬迁分不清「搬迁停的」与「管理员刻意停的」，
                    // 只能二选一：要么永远不放回来（我们上一版许下的修复路径其实走不通），
                    // 要么一律放回来（把管理员刚关掉的模型又打开）。
                    .Set("DisabledByMigrationAt", DateTime.UtcNow)
                    .Set("UpdatedAt", DateTime.UtcNow));
            var lostRoles = entry.ClaimedAppCallerCodes;
            entry.IsDefaultForType = false;
            entry.ClaimedAppCallerCodes = [];
            result.Skipped.Add(new PoolMigrationSkip
            {
                PoolId = poolId,
                PoolName = poolName,
                Reason = $"这个池的成员一条都没能建成线路，所以搬过来的模型「{publicId}」是停用的，"
                    + (hadRoles
                        ? $"而且没有带上它原本要接的流量（{(hadDefault ? "这个用途的默认；" : string.Empty)}"
                          + $"{lostRoles.Count} 个调用方的认领）——带过来的话，那些请求会落到一个没有上游的模型上，"
                          + "当场失败。"
                        : string.Empty)
                    + "先去上游页确认这些成员指向的物理模型还在不在、启没启用，再重跑一次搬迁——"
                    + "上游修好之后这一趟会把它自动启用回来",
            });
        }
        /*
          上一趟因为零可用线路被搬迁停掉的模型，这一趟有能用的线路了就放回来。

          不放回来的话，上面那句「修好上游再重跑一次搬迁」是一句走不通的话：重跑时这条模型
          已经存在，不走新建那一支，而复用那一支只会补默认与认领，从不碰 Enabled——
          于是它永久停在停用状态，除非有人手动去点一次。许下一个自己不兑现的修复路径，
          比不许更糟（第 56 轮 review；expectation-management：说到要做到）。

          只放回**带着搬迁那个戳**的：管理员刻意停掉的模型没有这个戳，重跑搬迁不会把它打开。
          戳在有人手动改过启用状态时就清掉（见 logical-models/{id}/enabled 端点），
          所以「先被搬迁停掉、后被管理员手动开过又关掉」的那条也不会被这里误开。
        */
        else if (!dryRun && usableRouteCount > 0 && logicalId is { Length: > 0 })
        {
            var revived = await gwLogicalModels.UpdateOneAsync(
                fb.And(
                    fb.Eq("TenantId", tenantId),
                    fb.Eq("_id", logicalId),
                    fb.Eq("Enabled", false),
                    fb.Exists("DisabledByMigrationAt")),
                Builders<BsonDocument>.Update
                    .Set("Enabled", true)
                    .Unset("DisabledByMigrationAt")
                    .Set("UpdatedAt", DateTime.UtcNow));
            if (revived.ModifiedCount > 0)
            {
                result.Skipped.Add(new PoolMigrationSkip
                {
                    PoolId = poolId,
                    PoolName = poolName,
                    Reason = $"模型「{publicId}」上一次搬迁时因为一条可用线路都没有被停用了，"
                        + "这一次它有能用的线路了，已经自动启用回来。"
                        + "它的默认与认领没有一起恢复——那是当时刻意摘掉的，去白名单页确认该给谁",
                });
            }
        }

        result.Entries.Add(entry);
    }

    if (!dryRun)
    {
        await WriteOperationAuditAsync(operationAudits, http,
            action: "pool.migrate-to-models", targetType: "llmgw_model_pool", targetId: "(batch)",
            targetName: null, success: true, reason: null,
            changes: new BsonDocument
            {
                { "poolsScanned", result.PoolsScanned },
                { "modelsCreated", result.ModelsCreated },
                { "routesCreated", result.RoutesCreated },
                { "linkedToExisting", result.LinkedToExisting },
                { "skipped", result.Skipped.Count },
            });
    }

    return Json(ApiEnvelope<PoolMigrationResult>.Ok(result), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 调用全貌：点名这个模型之后会发生什么，用**当前真实状态**回答。
//
// 为什么值得单开一个端点：列表能告诉人「有几条线路」，告诉不了人「现在发一个请求会落到谁」。
// 而后者才是人要的那份心安——尤其在「只给 appCallerCode、不点名模型」这条路上，
// 调用方连自己会用到哪个模型都不知道，这一屏就是唯一能说清的地方。
//
// 推演判据用 CallTracePlanner，它与运行时 GatewayRouteSelection 由行为对照测试逐条钉死。
// 按权重分配时不指名道姓（运行时 seed 由 requestId 派生，说「会落到 A」就是编的），只给比例。
app.MapGet("/gw/logical-models/{id}/call-trace", async (HttpContext http, string id, int? days) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var logical = await gwLogicalModels.Find(TenantAccess.Filter(http, fb.Eq("_id", id))).FirstOrDefaultAsync();
    if (logical is null) return Json(ApiEnvelope<CallTraceData>.Fail("NOT_FOUND", "对外模型不存在"), jsonOptions, 404);

    var offeringDocs = await gwModelOfferings.Find(TenantAccess.Filter(http, fb.Eq("LogicalModelId", id))).ToListAsync();
    var modelDocs = await gwModels.Find(TenantAccess.Filter(http)).ToListAsync();
    var exchangeDocs = await gwModelExchanges.Find(TenantAccess.Filter(http)).ToListAsync();
    var platformDocs = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    var item = MapLogicalModel(logical, offeringDocs, modelDocs, exchangeDocs, platformDocs);

    // TargetUsable 必须带上，否则这里算出的结论会和 MapLogicalModel 已经算好的
    // SkipReason 打架——同一屏给两个互相矛盾的答案，比不给还糟。
    var candidates = item.Offerings
        .Select(x => new CallTracePlanner.RouteCandidate(
            x.Id, x.Priority, x.Weight, x.HealthStatus, x.Enabled, x.TargetUsable))
        .ToList();
    var weighted = CallTracePlanner.IsWeighted(item.RoutingStrategy);
    var nameById = item.Offerings.ToDictionary(
        x => x.Id,
        x => x.ProviderName is { Length: > 0 } p ? $"{p} 的 {x.UpstreamModelId ?? x.TargetName}" : x.TargetName,
        StringComparer.Ordinal);
    var conclusionCore = CallTracePlanner.Conclusion(candidates, weighted,
        routeId => nameById.TryGetValue(routeId, out var label) ? label : routeId);

    // 不点名那条路：本用途现在的默认是谁。不是自己就把对方点出来——
    // 「我不是默认」这句话没有下一步，「现在的默认是 X」才有。
    // 三个条件与运行时 TryResolveDefaultLogicalModelAsync **逐条对齐**，一条都不能少：
    //   Enabled==true —— 停用的默认会被运行时跳过并回落到池，这里漏掉就会把一个
    //                     根本不生效的模型报成「现在的默认」；
    //   DisplayOrder/PublicId 排序 —— 存量数据里万一有两个默认（直接写库 / 并发写入），
    //                     不排序就是看 Mongo 心情，面板与实际会指向不同的模型。
    // 这是一次 Mongo 查询不是纯函数，没法进 CallTracePlanner 的行为对照，
    // 所以由 GatewayDataDomainGuardTests 钉住这两个条件还在。
    var defaultDoc = await gwLogicalModels.Find(TenantAccess.Filter(http, fb.And(
            fb.Eq("Enabled", true),
            fb.Eq("ModelType", item.ModelType),
            fb.Eq("IsDefaultForType", true))))
        .Sort(Builders<BsonDocument>.Sort.Ascending("DisplayOrder").Ascending("PublicId"))
        .FirstOrDefaultAsync();
    var defaultPublicId = defaultDoc?.GetStringOrEmpty("PublicId");

    // 「会落到它」要三件事同时成立：是本用途的默认、自己启用着、而且真有一条线路能接。
    // 少最后一条就会出现这种谎：面板说不点名会落到它，实际所有线路都被摘了，
    // 运行时当场解析失败——人照着面板去查，查的是一条根本没走的路。
    var hasEligibleRoute = candidates.Any(x => CallTracePlanner.SkipReason(x) is null);

    // 不点名时落到谁，是**两层**：先看有没有模型认领了这个调用方，没有才回落到用途默认。
    // 面板必须把两层都算进去，否则又会出现「面板说不落到它、运行时落到它」那种假话。
    var sameTypeDocs = await gwLogicalModels
        .Find(TenantAccess.Filter(http, fb.And(fb.Eq("Enabled", true), fb.Eq("ModelType", item.ModelType))))
        .Project(Builders<BsonDocument>.Projection
            .Include("PublicId").Include("DefaultForAppCallerCodes").Include("IsDefaultForType"))
        .ToListAsync();
    // 这个调用方被哪个模型认领了（同用途下最多一个，写入侧保证）。
    var claimedBy = new Dictionary<string, string>(StringComparer.Ordinal);
    foreach (var doc in sameTypeDocs)
    {
        var owner = doc.GetStringOrEmpty("PublicId");
        foreach (var code in GetStringArray(doc, "DefaultForAppCallerCodes"))
            if (!string.IsNullOrWhiteSpace(code)) claimedBy.TryAdd(code, owner);
    }
    var myClaims = item.DefaultForAppCallerCodes;

    // 模型这一侧：它有没有资格接住不点名的请求——要么是用途默认，要么认领了人。
    var servesUnnamed = (item.IsDefaultForType || myClaims.Count > 0) && item.Enabled && hasEligibleRoute;

    // 这句话的主语：逐个调用方算一遍。
    //
    // 上面那三个条件全是**模型这一侧**的。运行时还有**调用方这一侧**的一道门
    // （ModelResolver 里那句 `!StrictPoolContract || 目录例外`）：调用方一旦配了专属池，
    // 对外模型这一档整个被跳过，不点名的请求落在它自己的池上，跟这个模型没关系。
    // 2026-09-15 之前面板只判前一半，于是那句「不点名会落到它」没有主语——
    // 对配了专属池的调用方就是一句假话，而冒烟只跑了一个调用方，没抓到（形状 1）。
    var callerDocs = await gwAppCallers
        .Find(TenantAccess.Filter(http, fb.Eq("RequestType", item.ModelType)))
        .Project(Builders<BsonDocument>.Projection
            .Include("AppCallerCode").Include("Status"))
        .ToListAsync();
    var unnamedCallers = callerDocs
        .Select(d => new
        {
            Code = d.GetStringOrEmpty("AppCallerCode"),
            Status = d.AsNullableString("Status"),
        })
        .Where(x => x.Code.Length > 0)
        // 同一个 appCallerCode 在同一用途下可能有多条记录（历史写入），去重后按代码排序，
        // 免得同一屏每次刷新顺序都不一样。
        .GroupBy(x => x.Code, StringComparer.Ordinal)
        .Select(g => g.First())
        .OrderBy(x => x.Code, StringComparer.Ordinal)
        .Select(x =>
        {
            var reach = CallTracePlanner.Reach(new CallTracePlanner.CallerBinding(
                x.Code, CallTracePlanner.AllowsTraffic(x.Status)));
            // 这个调用方走到目录之后，落到的是不是**这个**模型：
            //   认领了它 → 是（只要这个模型启用着且有能接的线路）
            //   被别人认领 → 不是，且说得出是谁
            //   没人认领 → 看这个模型是不是用途默认
            var mine = myClaims.Contains(x.Code, StringComparer.Ordinal);
            var claimedElsewhere = !mine && claimedBy.TryGetValue(x.Code, out var owner);
            // 运行时在选中模型之后还要过一道「这个模型服不服务这个调用方」（授权名单 + 场景能力）。
            // 面板不判的话，它会指着一条运行时必拒的路说「会落到这里」——排障的人照着它去查，
            // 查的是一条根本走不到的路。判据走控制台这一侧的镜像，与权威侧逐条比对钉住。
            var serves = LogicalModelCapabilityPolicy.SupportsAppCallerScenario(
                item.Capabilities, item.AllowedAppCallerCodes, x.Code);
            var usable = item.Enabled && hasEligibleRoute && serves;
            var landsHere = reach == CallTracePlanner.CallerReach.UsesModelCatalog
                && usable
                && (mine || (!claimedElsewhere && item.IsDefaultForType));
            var verdict = reach != CallTracePlanner.CallerReach.UsesModelCatalog
                ? CallTracePlanner.UnnamedVerdict(reach, servesUnnamed)
                : mine
                    ? (usable
                        ? "这个模型点名认领了它，不点名会落到这里"
                        : serves
                            ? "这个模型认领了它，但自己停用或没有能接的线路——请求会解析失败"
                            : "这个模型认领了它，但它的授权名单或能力不覆盖这个调用方——请求会被拒")
                    : claimedElsewhere
                        ? $"它被 {claimedBy[x.Code]} 认领了，不点名走那边"
                        : !serves && item.IsDefaultForType
                            ? "它是这个用途的默认，但这个模型的授权名单或能力不覆盖这个调用方——请求会被拒"
                            : CallTracePlanner.UnnamedVerdict(reach, servesUnnamed);
            return new CallTraceUnnamedCaller
            {
                AppCallerCode = x.Code,
                Reach = reach.ToString(),
                ReachesThisModel = landsHere,
                Verdict = verdict,
            };
        })
        .ToList();
    var reachingCount = unnamedCallers.Count(x => x.ReachesThisModel);

    // 结论那一句同样需要主语，而且**点名与不点名都需要**。
    //
    // 2026-09-16 之前这里还数着「配了专属池」的调用方，说它们「点名与不点名都走不到这里」。
    // 模型池退场后那句话变成了假的：运行时不再看 AllowedModelPoolIds，点名照样落到这里。
    // 实证——`document-store.transcribe-summary::chat` 名下还留着那个历史字段，面板说它
    // 走不到 default-chat，真打一次点名却落到了 default-chat 的队首。
    // 现在走不到这张目录的只剩一种人：状态未放行的。
    var outsiderCount = unnamedCallers.Count(x => !string.Equals(
        x.Reach, nameof(CallTracePlanner.CallerReach.UsesModelCatalog), StringComparison.Ordinal));
    var conclusion = outsiderCount == 0
        ? conclusionCore
        : $"{conclusionCore}这句话对放行中的 {unnamedCallers.Count - outsiderCount} 个调用方成立；"
          + $"另外 {outsiderCount} 个当前未放行，请求根本发不出去。";

    var unnamedSummary = servesUnnamed
        ? unnamedCallers.Count == 0
            ? $"它是 {item.ModelType} 这个用途的默认，但这个用途下还没有登记任何调用方——现在没有人会不点名地落到它。"
            : reachingCount == unnamedCallers.Count
                ? $"这个用途下 {unnamedCallers.Count} 个调用方不点名时都会落到它。"
                : reachingCount == 0
                    ? $"它够格接不点名的请求，但这个用途下 {unnamedCallers.Count} 个调用方没有一个会落到它（{DescribeMissReasons(unnamedCallers)}）。"
                    : $"这个用途下 {unnamedCallers.Count} 个调用方里，{reachingCount} 个不点名时会落到它；其余 {unnamedCallers.Count - reachingCount} 个走的是别的路（{DescribeMissReasons(unnamedCallers)}）。"
        // 这三句此前都写着「回落到模型池」。模型池路由已经退场，ResolveCoreAsync 里没有那条分支了：
        // 解析不到就是结构化失败（AppCallerPoolUnbound / no-logical-model），不会再落到任何池。
        // 让面板指着一条走不到的路，运维会照它去排查一条不存在的链路——比不说更糟。
        : item.IsDefaultForType && !item.Enabled
            ? $"它被标成了 {item.ModelType} 的默认，但自己是停用的——运行时会跳过它，这个用途的不点名请求会解析失败。先启用它，或改设别的模型为默认。"
            : item.IsDefaultForType && !hasEligibleRoute
                ? $"它是 {item.ModelType} 的默认，但一条能接的线路都没有——不点名的请求会当场解析失败。先把上面那些线路修好。"
                : defaultPublicId is { Length: > 0 }
                    ? $"不点名时不会落到它；{item.ModelType} 这个用途现在的默认是 {defaultPublicId}。"
                    : $"不点名时不会落到它，而且 {item.ModelType} 这个用途现在没有启用的默认——这类请求会当场解析失败。给这个用途设一个默认模型，或让某个模型认领那些调用方。";

    var openToAll = item.AllowedAppCallerCodes.Count == 0;
    var gateSummary = !item.Enabled
        ? "这个模型是停用的，点名它会被当场拒绝。"
        : openToAll
            ? "没有配授权名单，所有调用方都能点名它。"
            : $"只有名单里这 {item.AllowedAppCallerCodes.Count} 个调用方能点名它，别人点名会被拒。";

    var share = weighted
        ? CallTracePlanner.WeightShare(candidates).ToDictionary(x => x.Id, x => x.Percent, StringComparer.Ordinal)
        : new Dictionary<string, double>(StringComparer.Ordinal);
    var modelById = modelDocs.Where(x => x.GetStringOrEmpty("_id").Length > 0)
        .ToDictionary(x => x.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var offeringById = offeringDocs.Where(x => x.GetStringOrEmpty("_id").Length > 0)
        .ToDictionary(x => x.GetStringOrEmpty("_id"), StringComparer.Ordinal);
    var extras = item.Offerings.Select(route => new CallTraceRouteExtra
    {
        OfferingId = route.Id,
        WeightPercent = share.TryGetValue(route.Id, out var percent) ? percent : null,
        PriceSummary = DescribeRoutePrice(route, modelById),
        LastFailedAt = offeringById.TryGetValue(route.Id, out var doc)
            ? doc.AsNullableUtcDateTime("LastFailedAt").ToIso()
            : null,
    }).ToList();

    var window = Math.Clamp(days ?? 30, 1, 90);
    var ledger = await BuildCallTraceLedgerAsync(logs, http, item.PublicId, window);

    // 判定流程图：与架构文档第 3 节那张静态图同构，但每条岔路带上这个模型此刻的状态。
    //
    // 三档状态（走 / 可能走 / 走不到）是刻意的：同一个模型对不同调用方、点名与不点名
    // 走的根本不是同一条路，硬画成一条确定路径就是在编。前端只负责按状态上色，
    // 一句判断都不做——画出来的图最容易被人当真，它错了比列表错了更糟。
    string StateOf(bool certain, bool possible) => certain ? "taken" : possible ? "possible" : "blocked";
    var usesCatalogCount = unnamedCallers.Count(x => x.Reach == nameof(CallTracePlanner.CallerReach.UsesModelCatalog));
    var rejectedCount = unnamedCallers.Count(x => x.Reach == nameof(CallTracePlanner.CallerReach.TrafficRejected));
    var eligibleCount = candidates.Count(x => CallTracePlanner.SkipReason(x) is null);
    var queue = CallTracePlanner.Queue(candidates, weighted, 0);
    var headLabel = queue.Count > 0 && nameById.TryGetValue(queue[0].Id, out var headName) ? headName : null;
    var protocols = item.Offerings
        .Where(x => CallTracePlanner.SkipReason(new CallTracePlanner.RouteCandidate(
            x.Id, x.Priority, x.Weight, x.HealthStatus, x.Enabled, x.TargetUsable)) is null)
        .Select(x => string.IsNullOrWhiteSpace(x.Protocol) ? "跟着目标模型走" : x.Protocol!)
        .Distinct(StringComparer.Ordinal)
        .OrderBy(x => x, StringComparer.Ordinal)
        .ToList();

    var flow = new List<CallTraceFlowNode>
    {
        new()
        {
            Id = "caller-reach",
            Question = "这个调用方放行吗",
            Branches =
            [
                new() { Label = "放行", Outcome = "认这张目录，继续往下走", State = StateOf(false, usesCatalogCount > 0),
                        Note = unnamedCallers.Count == 0 ? "这个用途还没登记调用方" : $"{usesCatalogCount} 个调用方" },
                new() { Label = "状态未放行", Outcome = "拒绝：请求发不出去",
                        State = StateOf(false, rejectedCount > 0), Note = rejectedCount > 0 ? $"{rejectedCount} 个调用方" : null },
            ],
        },
        new()
        {
            Id = "named",
            Question = "点名了吗",
            Branches =
            [
                new() { Label = $"点名 {item.PublicId}", Outcome = "走目录闸", State = "possible" },
                new()
                {
                    Label = "没点名",
                    Outcome = servesUnnamed
                        ? "它是这个用途的默认，落到它"
                        : defaultPublicId is { Length: > 0 }
                            ? $"落到这个用途现在的默认 {defaultPublicId}"
                            : "这个用途没有启用的默认，请求当场解析失败",
                    State = StateOf(false, servesUnnamed),
                    Note = servesUnnamed && reachingCount > 0 ? $"{reachingCount} 个调用方会这样落到它" : null,
                },
            ],
        },
        new()
        {
            Id = "gate",
            Question = "过目录闸：在不在表里 · 授权了吗 · 启用了吗",
            Branches =
            [
                new() { Label = "通过", Outcome = "按能力筛出候选线路", State = StateOf(item.Enabled, item.Enabled), Note = gateSummary },
                new() { Label = "不满足", Outcome = "当场拒绝，并说清是哪一条不满足", State = StateOf(!item.Enabled, true) },
            ],
        },
        new()
        {
            Id = "eligible",
            Question = "还有线路参与吗（停用 / 熔断的先剔掉）",
            Branches =
            [
                new() { Label = $"有 {eligibleCount} 条", Outcome = "排队：健康优先 → 顺位 → 标识",
                        State = StateOf(hasEligibleRoute, hasEligibleRoute), Note = $"共 {candidates.Count} 条线路" },
                new() { Label = "一条都没有", Outcome = "拒绝：全被停用或摘掉",
                        State = StateOf(!hasEligibleRoute, !hasEligibleRoute) },
            ],
        },
        new()
        {
            Id = "pick",
            Question = weighted ? "按权重分配" : "按顺位挑一条",
            Branches = weighted
                ?
                [
                    new() { Label = "分到各条线路", Outcome = "落点由请求本身派生，只给比例不指名",
                            State = StateOf(hasEligibleRoute, hasEligibleRoute), Note = $"{eligibleCount} 条参与分配" },
                ]
                :
                [
                    new() { Label = "队首", Outcome = headLabel is { Length: > 0 } ? $"落到 {headLabel}" : "没有队首",
                            State = StateOf(headLabel is { Length: > 0 }, hasEligibleRoute) },
                    new() { Label = "队首失败", Outcome = eligibleCount > 1 ? $"往下换，还有 {eligibleCount - 1} 条后备" : "没有后备，这次调用失败",
                            State = "possible" },
                ],
        },
        new()
        {
            Id = "adapter",
            Question = "",
            Branches =
            [
                new() { Label = "翻译成这家上游的方言", Outcome = "全链路唯一按上游分叉的地方，分叉键是协议不是模型名",
                        State = StateOf(protocols.Count > 0, true),
                        Note = protocols.Count > 0 ? string.Join(" · ", protocols) : "没有参与的线路，谈不上协议" },
            ],
        },
        new()
        {
            Id = "ledger",
            Question = "",
            Branches =
            [
                new() { Label = "记账", Outcome = "点名的名字 · 实际线路 · 上游 · token · 耗时 · 成本",
                        State = "taken", Note = $"近 {window} 天 {ledger.Calls} 次" },
            ],
        },
    };

    return Json(ApiEnvelope<CallTraceData>.Ok(new CallTraceData
    {
        PublicId = item.PublicId,
        Name = item.Name,
        ModelType = item.ModelType,
        Enabled = item.Enabled,
        IsDefaultForType = item.IsDefaultForType,
        RoutingStrategy = item.RoutingStrategy,
        Conclusion = conclusion,
        Gate = new CallTraceGate
        {
            Enabled = item.Enabled,
            OpenToAllCallers = openToAll,
            AllowedAppCallerCodes = item.AllowedAppCallerCodes,
            Summary = gateSummary,
        },
        Unnamed = new CallTraceUnnamed
        {
            ServesUnnamed = servesUnnamed,
            CurrentDefaultPublicId = defaultPublicId is { Length: > 0 } ? defaultPublicId : null,
            CurrentDefaultName = defaultDoc?.AsNullableString("Name"),
            Summary = unnamedSummary,
            Callers = unnamedCallers,
            CallerCount = unnamedCallers.Count,
            ReachingCallerCount = reachingCount,
        },
        Routes = item.Offerings,
        RouteExtras = extras,
        Ledger = ledger,
        Flow = flow,
    }), jsonOptions);
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

    // 认领唯一性：同一用途下一个调用方最多被一个模型认领。
    //
    // 更新端点会顶替旧的认领者并把「摘掉了谁」如实回报，创建端点原本一条都不查——
    // 于是两个模型同时认领同一个调用方，运行时按 DisplayOrder / PublicId 排序取第一个，
    // 刚建的这个可能根本不控制流量，而界面显示它认领成功了（形状 3：同一个不变量，
    // 两条写入路径给出两个结果）。
    //
    // 这里选拒绝而不是顶替：更新是显式编辑那个模型的认领列表，顶替是用户的意图；
    // 创建只是新增一个模型，没有「把别人的抢过来」这层意思，悄悄抢走是最大的惊讶。
    var declaredClaims = (body?.DefaultForAppCallerCodes ?? new())
        .Select(x => x.Trim()).Where(x => x.Length > 0)
        .Distinct(StringComparer.Ordinal).ToList();
    var createdAllowlist = (body?.AllowedAppCallerCodes ?? new())
        .Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
    if (ValidateClaimsWithinAllowlist(createdAllowlist, declaredClaims) is { } claimOutsideAllowlist)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("CLAIM_OUTSIDE_ALLOWLIST", claimOutsideAllowlist), jsonOptions, 400);
    if (declaredClaims.Count > 0)
    {
        var rival = await gwLogicalModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("ModelType", modelType),
            Builders<BsonDocument>.Filter.AnyIn("DefaultForAppCallerCodes", declaredClaims)))).FirstOrDefaultAsync();
        if (rival is not null)
        {
            var taken = rival.AsStringList("DefaultForAppCallerCodes")
                .Where(x => declaredClaims.Contains(x, StringComparer.Ordinal)).ToList();
            var rivalName = rival.AsNullableString("PublicId") ?? rival.GetStringOrEmpty("_id");
            return Json(ApiEnvelope<LogicalModelItem>.Fail(
                "CLAIM_TAKEN",
                $"调用方 {string.Join("、", taken)} 已经被模型 {rivalName} 认领了——同一个用途下一个调用方只能被一个模型认领。" +
                "先建这个模型（不填指定调用方），再去编辑它的指定调用方，那条路会如实告诉你摘掉了谁"),
                jsonOptions, 409);
        }
    }

    var now = DateTime.UtcNow;
    var id = $"gw-logical-{Guid.NewGuid():N}";
    var capabilityNormalization = LogicalModelCapabilityPolicy.NormalizeDetailed(modelType, body?.Capabilities);
    var capabilities = capabilityNormalization.Persisted;
    var appCallers = (body?.AllowedAppCallerCodes ?? new()).Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    var document = new BsonDocument
    {
        { "_id", id }, { "TenantId", tenantId }, { "PublicId", publicId }, { "PublicIdNormalized", normalized },
        { "Name", name }, { "ModelType", modelType }, { "Capabilities", new BsonArray(capabilities) },
        // 写入即打契约版本：没有版本的文档一律被迁移当成存量重算，避免新写入的数据也要靠迁移兜底。
        { LogicalModelCapabilityPolicy.SchemaVersionField, LogicalModelCapabilityPolicy.SchemaVersion },
        { "AllowedAppCallerCodes", new BsonArray(appCallers) },
        { "DefaultForAppCallerCodes", new BsonArray(declaredClaims) },
        { "RoutingStrategy", strategy },
        { "Enabled", true }, { "DisplayOrder", Math.Clamp(body?.DisplayOrder ?? 100, 0, 10000) },
        { "Description", string.IsNullOrWhiteSpace(body?.Description) ? BsonNull.Value : body.Description.Trim() },
        { "CreatedAt", now }, { "UpdatedAt", now },
    };
    /*
      并发创建撞上唯一索引要翻成 409，不能漏成 500。

      两个人同时建同用途、同认领（或同标识）的模型时，两边的「有没有人占着」查询都能在
      对方插入之前通过——真正拦住的是唯一索引。不接这个异常的话，输的那一方拿到 500：
      同一件事，不撞车时给的是说得出下一步的 409（先建、再去编辑认领），撞车时给的却是
      一句「服务器错误」。判据一样，回复不一样，这是外因没说清（external-cause-first）。
    */
    try
    {
        await gwLogicalModels.InsertOneAsync(document);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        var claimRace = ex.Message.Contains("uniq_llmgw_logical_claim_per_type", StringComparison.Ordinal);
        return Json(ApiEnvelope<LogicalModelItem>.Fail(
            claimRace ? "CLAIM_TAKEN" : "PUBLIC_ID_TAKEN",
            claimRace
                ? "这几个调用方里有一个刚刚被另一个模型认领了（同一个用途下一个调用方只能被一个模型认领）。"
                  + "先建这个模型（不填指定调用方），再去编辑它的指定调用方，那条路会如实告诉你摘掉了谁"
                : "这个公开模型名刚刚被另一个人用掉了。换一个标识再试。"), jsonOptions, 409);
    }
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

    /*
      还在接流量的模型不许直接删。

      池退场之后，不点名的请求全靠这两样接住：这个用途的默认模型，以及点名认领了某几个
      调用方的模型。删掉前者，那个用途一个默认都不剩，所有不点名的请求当场解析失败；
      删掉后者更隐蔽——被认领的调用方不会报错，它们会**悄悄改走用途默认**，换了个模型
      还没人知道（2026-09-15 盘线上数据就见过这个形状：document-store 那条用的是自己池里的
      gpt-4.1-mini，而 chat 的全局默认是 gpt-3.5-turbo，两者的产出不是一回事）。

      而确认框只说了「会一起删掉 N 条线路」，一个字都没提这件事。所以拦在这里：
      先把默认或认领转给另一条模型，再回来删。转移的入口就在同一个模型的编辑里
      （PUT 支持把 IsDefaultForType 置 false、把认领改到别人名下），不是死路。
    */
    var blockingRoles = new List<string>();
    if (doc.AsNullableBool("IsDefaultForType") == true)
        blockingRoles.Add($"它是「{doc.AsNullableString("ModelType") ?? "这个用途"}」的默认模型");
    var activeClaims = GetStringArray(doc, "DefaultForAppCallerCodes");
    if (activeClaims.Count > 0)
        blockingRoles.Add($"它认领着 {activeClaims.Count} 个调用方（{string.Join("、", activeClaims.Take(5))}"
            + (activeClaims.Count > 5 ? " 等" : string.Empty) + "）");
    if (blockingRoles.Count > 0)
    {
        return Json(ApiEnvelope<LogicalModelDeleteResult>.Fail(
            "MODEL_STILL_CATCHES_TRAFFIC",
            $"这条模型还在接不点名的请求：{string.Join("；", blockingRoles)}。"
            + "直接删会让那些请求当场失败，或者悄悄换成另一个模型。"
            + "先在模型编辑里把默认与认领转给别的模型，再回来删"),
            jsonOptions, 409);
    }

    /*
      还有在途任务等着取结果的线路，也不许删。

      线路是逻辑模型的从属子项，删模型会把它名下的线路一起删掉；而视频任务提交成功后
      会把当时那条线路的 id 写进任务文档，轮询与下载都靠它精确回到同一个上游。删掉之后
      那个任务在下一次轮询时找不到线路，一个已经被上游受理、甚至已经计费的任务就这么坏了，
      而操作者只是删了一条「看起来没人用」的模型——没有任何地方会提示这件事。

      所以先把它名下的线路列出来，去问在途任务有没有引用。判据在 OfferingReferencePolicy，
      两种引用形态（direct 写在任务根、storyboard 逐镜写）都要查，漏一种等于没查。

      两条已知边界，都是有意接受的：
      其一，这是一次读，挡不住「读完到删之间刚好又提交了一个任务」的竞态——真正不漏的做法是
      线路软删除（留墓碑到引用的任务跑完），那要改动每一处列线路的查询，属于另一件事，已记入
      doc/debt.platform.llm-gateway.md。这道闸把绝大多数误删挡在门外，不声称它是原子的。
      其二，任务库是同项目所有分支预览共用的（cross-project-isolation 通道 4），兄弟分支的
      在途任务同样会拦住这次删除。方向是对的那一边：宁可多拦一次让人去看看。
    */
    // 整份读回来，不只是 id：下面那道在途闸要 id，而级联删除失败时的补偿要把子文档原样放回去。
    // 一个对外模型底下的线路是个位数，多读这一次不值得为省它而留两份查询。
    var childOfferings = await gwModelOfferings
        .Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("LogicalModelId", id)))
        .ToListAsync();
    var childOfferingIds = childOfferings
        .Select(x => x.GetStringOrEmpty("_id"))
        .Where(x => x.Length > 0)
        .ToList();
    var inFlightFilter = OfferingReferencePolicy.BuildInFlightVideoRunFilter(childOfferingIds);
    if (inFlightFilter is not null)
    {
        var inFlightCount = await videoGenRuns.CountDocumentsAsync(inFlightFilter);
        if (inFlightCount > 0)
        {
            return Json(ApiEnvelope<LogicalModelDeleteResult>.Fail(
                "MODEL_HAS_INFLIGHT_JOBS",
                $"它名下的线路还有 {inFlightCount} 个没跑完的视频任务在用。"
                + "现在删，那些任务下一次去取结果时会找不到上游而失败（有的已经计费了）。"
                + "等它们跑完或取消之后再删"),
                jsonOptions, 409);
        }
    }

    /*
      上面那一读只是为了给人一句能看懂的拒绝理由，它挡不住竞态：读完到删之间，
      另一个管理员完全可能刚把这条模型设成用途默认、或者把一个调用方的认领转给它。
      所以真正的闸在删除语句的谓词上——**删的时候**再判一次「它没在接不点名的请求」，
      没删到就说明状态在这几毫秒里变了，如实回冲突。

      顺序也要对：先条件删模型，删成了才删它名下的线路。反过来做的话，一次被拒绝的删除
      已经把线路删光了——拒绝还带着破坏，比不拒绝更糟。
    */
    var deleteFilter = Builders<BsonDocument>.Filter.And(
        filter,
        Builders<BsonDocument>.Filter.Ne("IsDefaultForType", true),
        Builders<BsonDocument>.Filter.Or(
            Builders<BsonDocument>.Filter.Exists("DefaultForAppCallerCodes", false),
            Builders<BsonDocument>.Filter.Size("DefaultForAppCallerCodes", 0)));
    var deleted = await gwLogicalModels.DeleteOneAsync(deleteFilter);
    if (deleted.DeletedCount == 0)
    {
        return Json(ApiEnvelope<LogicalModelDeleteResult>.Fail(
            "MODEL_STILL_CATCHES_TRAFFIC",
            "这条模型在刚才这一瞬被设成了默认、或者被某个调用方认领了，所以没有删。"
            + "刷新一下看看它现在接着什么，先把默认与认领转给别的模型，再回来删"),
            jsonOptions, 409);
    }

    /*
      删到一半失败了，要把库放回删之前的样子——父和子都放。

      这两条删除不是一个事务（跨文档，而且这里也不该假设部署一定是副本集）。中间那一下超时
      或主从切换，结果是：对外模型没了，它名下的线路要么全在、要么删了一部分。两种都不会有人
      发现——线路只在自己的对外模型底下列出，剩下的那些一屏都不出现，直到有人去数集合大小。

      所以补偿要两步都做，而且顺序是先父后子（父在，子才有归属）。子按 _id 逐条 upsert：
      删掉的那些回来，没删掉的原样不动，这个动作重复执行结果一样——因为超时这一类失败**本身
      就是结果未知的**，不能靠「猜它删没删」来决定补偿做什么。上一版只放回了父，然后告诉
      操作者「库里没有留下半截状态」，而在删了一部分的那种失败里这句话是假的：模型回来了，
      它的线路少了几条，路由从此变了样却没人知道（第 53 轮 review 指出）。

      补偿自己也可能失败（同一次库故障）。那时如实说清哪一半没回来，并把模型标识给出来
      让人能去查——不许吞掉，也不许含混成一句「操作失败」（no-rootless-tree、
      external-cause-first：给读的人一个他能处置的结论）。

      还有一条补偿也管不着的缝：删父与删子之间有人新建了一条线路（创建端点校验父存在，
      那一刻父还在）。它删完之后才落库，于是成为孤儿。彻底堵死要靠墓碑，已记入
      doc/debt.platform.llm-gateway.md 的 2026-09-17-offering-delete-has-no-tombstone。
    */
    var offeringFilter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("LogicalModelId", id));
    var offeringCount = childOfferings.Count;
    try
    {
        await gwModelOfferings.DeleteManyAsync(offeringFilter);
    }
    catch (MongoException cascadeFailure)
    {
        var parentRestored = false;
        var childrenRestored = 0;
        var restoreErrors = new List<string>();
        try
        {
            await gwLogicalModels.InsertOneAsync(doc);
            parentRestored = true;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            /*
              撞键不等于「原来那一条还在」。

              公开名上也有唯一索引，所以另一个管理员在这几毫秒里用同一个公开名新建了一条模型时，
              撞的是**那一条**、_id 完全不同。把它当成「原模型已恢复」，接着按原 _id 把线路放回去，
              结果是一批挂在一个不存在的父下面的孤儿，藏在那条替身模型后面，而回复还说「全都放回去了」
              （第 55 轮 review）。所以回去按 _id 查一眼，不拿撞键本身当证据
              （形状 8：不成立的证据当成了证明）。
            */
            try
            {
                parentRestored = await gwLogicalModels
                    .Find(Builders<BsonDocument>.Filter.Eq("_id", id))
                    .AnyAsync();
                if (!parentRestored)
                {
                    restoreErrors.Add(
                        "模型没能放回去：它原来的公开名在这期间被另一条新建的模型占用了"
                        + $"（{ex.WriteError?.Message ?? ex.Message}）");
                }
            }
            catch (MongoException probeFailure)
            {
                restoreErrors.Add($"模型放回去没有，查不出来：{probeFailure.Message}");
            }
        }
        catch (MongoException ex)
        {
            restoreErrors.Add($"模型本身没能放回去：{ex.Message}");
        }

        /*
          父没放回去就**不放子**。

          放回去的话，造出来的正好是上面那道撞键复核要防的东西：一批挂在一个不存在的父下面的
          孤儿，而且它们不会出现在任何一屏上（第 57 轮 review）。父不在时把子留在删除状态，
          库里少了东西是看得见的；放一批看不见的孤儿进去，没人会发现。
          两种都不好，但前者可查、后者不可查。
        */
        if (parentRestored)
        {
            foreach (var child in childOfferings)
            {
                try
                {
                    await gwModelOfferings.ReplaceOneAsync(
                        Builders<BsonDocument>.Filter.Eq("_id", child.GetStringOrEmpty("_id")),
                        child,
                        new ReplaceOptions { IsUpsert = true });
                    childrenRestored++;
                }
                catch (MongoException ex)
                {
                    restoreErrors.Add($"线路 {child.GetStringOrEmpty("_id")} 没能放回去：{ex.Message}");
                }
            }
        }
        else if (childOfferings.Count > 0)
        {
            restoreErrors.Add(
                $"它名下那 {childOfferings.Count} 条线路没有放回去——模型本身都不在了，"
                + "放回去只会造出一批谁也看不见的孤儿");
        }

        var fullyRestored = parentRestored && childrenRestored == childOfferings.Count;
        await WriteOperationAuditAsync(
            operationAudits, http,
            action: "logical-model.delete", targetType: "llmgw_logical_model", targetId: id,
            targetName: doc.AsNullableString("Name"), success: false,
            reason: (fullyRestored ? "cascade-failed-restored: " : "cascade-failed-partial-restore: ")
                + cascadeFailure.Message,
            changes: new BsonDocument
            {
                { "publicId", ToBsonAuditValue(doc.AsNullableString("PublicId")) },
                { "parentRestored", parentRestored },
                { "offeringsRestored", childrenRestored },
                { "offeringsBefore", childOfferings.Count },
            });

        if (fullyRestored)
        {
            return Json(ApiEnvelope<LogicalModelDeleteResult>.Fail(
                "MODEL_DELETE_ROLLED_BACK",
                $"删它名下的线路时失败了（{cascadeFailure.Message}）。已经把这条模型和它的 "
                + $"{childOfferings.Count} 条线路都放回去，库回到了删之前的样子。"
                + "刷新一下会看到它还在，稍后重试删除"),
                jsonOptions, 503);
        }

        return Json(ApiEnvelope<LogicalModelDeleteResult>.Fail(
            "MODEL_DELETE_LEFT_ORPHANS",
            $"删它名下的线路时失败了（{cascadeFailure.Message}），而且没能把库放回删之前的样子："
            + string.Join("；", restoreErrors)
            + $"。现在的状态是：模型{(parentRestored ? "在" : "不在")}，"
            + $"它原有的 {childOfferings.Count} 条线路放回了 {childrenRestored} 条。"
            + $"模型标识是 {id}，请 DBA 按它核对 llmgw_logical_models 与 llmgw_model_offerings"),
            jsonOptions, 500);
    }

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
        updates.Add(Builders<BsonDocument>.Update.Set(
            LogicalModelCapabilityPolicy.SchemaVersionField,
            LogicalModelCapabilityPolicy.SchemaVersion));
    }
    if (body.AllowedAppCallerCodes is not null)
    {
        var appCallers = body.AllowedAppCallerCodes.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        // 校验要按「改完之后的值」判，不是按这次提交的那一个字段判。
        //
        // 两个字段可以分开改：这次只收窄授权名单、认领沿用库里的旧值时，组合照样可能不成立。
        // 只看本次请求里的字段就会放过它——而放过的后果是那个调用方的不点名请求整条静默失败。
        var claimsAfterUpdate = body.DefaultForAppCallerCodes is not null
            ? body.DefaultForAppCallerCodes.Select(x => x.Trim()).Where(x => x.Length > 0).ToList()
            : (await gwLogicalModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)))
                .Project(Builders<BsonDocument>.Projection.Include("DefaultForAppCallerCodes"))
                .FirstOrDefaultAsync())?.AsStringList("DefaultForAppCallerCodes") ?? [];
        if (ValidateClaimsWithinAllowlist(appCallers, claimsAfterUpdate) is { } allowlistConflict)
            return Json(ApiEnvelope<LogicalModelItem>.Fail("CLAIM_OUTSIDE_ALLOWLIST", allowlistConflict), jsonOptions, 400);

        updates.Add(Builders<BsonDocument>.Update.Set("AllowedAppCallerCodes", new BsonArray(appCallers)));
    }
    if (body.DisplayOrder is not null)
        updates.Add(Builders<BsonDocument>.Update.Set("DisplayOrder", Math.Clamp(body.DisplayOrder.Value, 0, 10000)));
    if (body.Description is not null)
        updates.Add(string.IsNullOrWhiteSpace(body.Description)
            ? Builders<BsonDocument>.Update.Unset("Description")
            : Builders<BsonDocument>.Update.Set("Description", body.Description.Trim()));
    // 「这个用途没点名时用它」——同租户同用途最多一个默认。
    //
    // 顺序是判据：**先把同用途的旧默认清掉，再置新的**。反过来会出现一瞬间两个默认，
    // 恰好落在那一瞬的请求解析到哪个全看运气。清掉谁要回给用户，不能让兜底模型悄悄换人。
    /*
      纯判断全部走在**任何一次位移之前**。

      位移（把别人的用途默认清掉、把别人手上的认领摘掉）是会改变线上路由的写操作，
      而位移之后的每一个 early return 都必须自己记得补偿——漏一个，那个用途就此没有默认，
      所有不点名的请求当场开始失败，而操作者只看到一句 400。本轮被报回来的正是这种漏：
      「认领超出授权名单」那条 400 排在清掉旧默认之后。

      与其给每个 early return 补一次补偿（下一个新增的分支又会漏），不如让位移之前
      一个 return 都不剩：能纯判的在这里判完，后面只剩真写库失败那一档，那一档已经有 catch。
    */
    var currentModel = await gwLogicalModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)))
        .FirstOrDefaultAsync();
    if (currentModel is null)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("NOT_FOUND", "逻辑模型不存在"), jsonOptions, 404);

    var normalizedClaims = body.DefaultForAppCallerCodes?
        .Select(x => x.Trim()).Where(x => x.Length > 0)
        .Distinct(StringComparer.Ordinal).ToList();
    if (normalizedClaims is not null)
    {
        // 按**改完之后**的授权名单判：这次只改认领、名单沿用库里旧值时也要成立。
        var allowlistAfterUpdate = body.AllowedAppCallerCodes is not null
            ? body.AllowedAppCallerCodes.Select(x => x.Trim()).Where(x => x.Length > 0).ToList()
            : currentModel.AsStringList("AllowedAppCallerCodes");
        if (ValidateClaimsWithinAllowlist(allowlistAfterUpdate, normalizedClaims) is { } claimConflict)
            return Json(ApiEnvelope<LogicalModelItem>.Fail("CLAIM_OUTSIDE_ALLOWLIST", claimConflict), jsonOptions, 400);
    }

    /*
      「一个字段都没给」也要在位移之前判掉。

      这两个位移块只要 body 里给了对应字段就一定会往 updates 里加一条，所以位移之后
      updates 不可能是空的——但那是一条靠推演成立的性质，下一个人加个分支就不成立了。
      与其把它留在后面当一条「碰巧到不了」的 return，不如在这里显式判完：
      位移之前一个 return 都不剩，这条不变量就不依赖任何推演。
    */
    if (updates.Count == 0 && body.IsDefaultForType is null && body.DefaultForAppCallerCodes is null)
        return Json(ApiEnvelope<LogicalModelItem>.Fail("INVALID_INPUT", "没有可更新字段"), jsonOptions, 400);

    var displacedDefaults = new List<string>();
    // 被清掉默认标记的那些模型 id。与认领那本账一样，最终写入没成功就要还回去。
    var defaultRollbacks = new List<string>();
    if (body.IsDefaultForType == true)
    {
        var modelType = currentModel.GetStringOrEmpty("ModelType");
        var sameTypeDefaults = await gwLogicalModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("ModelType", modelType),
            Builders<BsonDocument>.Filter.Eq("IsDefaultForType", true),
            Builders<BsonDocument>.Filter.Ne("_id", id)))).ToListAsync();
        foreach (var other in sameTypeDefaults)
        {
            displacedDefaults.Add(other.AsNullableString("PublicId") ?? other.GetStringOrEmpty("_id"));
            // 记进回滚账本：最终写入失败时要还回去。不还的话这个用途会**一个默认都不剩**，
            // 所有不点名的请求当场解析失败——而操作者看到的只是一句「没找到」或「保存失败」，
            // 完全不会想到自己刚刚把这个用途的兜底拆了。
            defaultRollbacks.Add(other.GetStringOrEmpty("_id"));
            await gwLogicalModels.UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", other.GetStringOrEmpty("_id")),
                Builders<BsonDocument>.Update.Set("IsDefaultForType", false).Set("UpdatedAt", DateTime.UtcNow));
        }
    }
    if (body.IsDefaultForType is not null)
        updates.Add(Builders<BsonDocument>.Update.Set("IsDefaultForType", body.IsDefaultForType.Value));

    // 「对这些调用方而言我是默认」——同用途下一个调用方最多被一个模型认领。
    //
    // 不变量的维护顺序与上面那段一样：**先把别人手上的同名调用方摘掉，再置新的**。
    // 反过来会出现一瞬间两个模型都认领同一个调用方，那一瞬的请求落到谁全看运气。
    // 摘掉了谁要如实回给用户——这同样是会改变线上行为的动作，不能悄悄换人。
    var displacedClaims = new List<string>();
    // 摘认领的回滚账本：(对手 id, 摘之前的值, 摘之后写进去的值)。
    // 最终写入失败时按「值还是我写的那个」条件还原——期间被别人改过就不动它，
    // 盲目覆盖会把别人的改动一起抹掉。
    var claimRollbacks = new List<(string RivalId, List<string> Before, List<string> AfterWrite)>();
    if (normalizedClaims is not null)
    {
        // 名单与认领的相容性上面已经判过（位移之前），这里只做位移。
        var claims = normalizedClaims;
        var claimType = currentModel.GetStringOrEmpty("ModelType");

        if (claims.Count > 0)
        {
            var rivals = await gwLogicalModels.Find(TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("ModelType", claimType),
                Builders<BsonDocument>.Filter.AnyIn("DefaultForAppCallerCodes", claims),
                Builders<BsonDocument>.Filter.Ne("_id", id)))).ToListAsync();
            foreach (var other in rivals)
            {
                var before = other.AsStringList("DefaultForAppCallerCodes");
                var kept = before.Where(x => !claims.Contains(x, StringComparer.Ordinal)).ToList();
                var taken = before.Where(x => claims.Contains(x, StringComparer.Ordinal));
                var rivalId = other.AsNullableString("PublicId") ?? other.GetStringOrEmpty("_id");
                foreach (var code in taken) displacedClaims.Add($"{code} 原本由 {rivalId} 认领");
                // 摘之前把原值记下来：下面那次最终写入可能因为并发冲突失败，
                // 那时这些摘除必须还回去，否则一次**被拒绝的保存**照样改了线上路由——
                // 那几个调用方从「由对手模型接住」掉成「走用途默认」，而操作者看到的是失败。
                claimRollbacks.Add((other.GetStringOrEmpty("_id"), before, kept));
                await gwLogicalModels.UpdateOneAsync(
                    Builders<BsonDocument>.Filter.Eq("_id", other.GetStringOrEmpty("_id")),
                    Builders<BsonDocument>.Update
                        .Set("DefaultForAppCallerCodes", new BsonArray(kept))
                        .Set("UpdatedAt", DateTime.UtcNow));
            }
        }
        updates.Add(Builders<BsonDocument>.Update.Set("DefaultForAppCallerCodes", new BsonArray(claims)));
    }

    updates.Add(Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));

    /*
      位移的补偿收在这一个函数里，**所有**失败路径都走它，不是只有并发冲突那一条。

      这段代码的形状是「先把别人的默认/认领摘掉，再置自己」。摘和置是两次写，
      中间任何原因导致置失败——并发撞唯一索引、目标模型刚被别人删掉（404）、
      连接抖动（异常）——摘掉的那些就留在了库里。后果按摘的是什么分两种：
        · 摘的是认领 → 那几个调用方从「由对手模型接住」掉成「走用途默认」；
        · 摘的是默认 → 这个用途**一个默认都不剩**，所有不点名的请求当场解析失败。
      两种都是「一次失败的保存改了线上路由」，而操作者只看到一句失败。

      默认要不要还，取决于失败原因：撞唯一索引说明已经有赢家占着，还回去会再撞一次；
      其余失败没有赢家，必须还。认领两种情况都要还。
    */
    var compensationWarnings = new List<string>();

    /*
      还原动作本身也会撞唯一索引，而且**这正是它最常被调用的那一刻**。

      两个管理员同时把同一个调用方的认领从 A 移到各自的模型上：输的那一方走进撞车分支，
      而它要还回去的那份认领，此刻已经归赢家了。还原的 UpdateOne 于是撞上认领唯一索引，
      异常从补偿函数里抛出去、越过外面那个 catch，本该是一句说得清的 409 变成一句
      「服务器错误」（第 67 轮 review；与 external-cause-first 同一个病：把内因当结论交出去）。

      撞键在这里不是故障，是结论：那个位子已经有人了，不该还、也还不回去。按「没能还原」
      记一条告警走原路返回即可——告警文案说的本来就是「它们在这期间被别人改过」。
    */
    async Task<bool> TryRestoreAsync(FilterDefinition<BsonDocument> filter, UpdateDefinition<BsonDocument> update)
    {
        try
        {
            var restored = await gwLogicalModels.UpdateOneAsync(filter, update);
            return restored.ModifiedCount > 0;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return false;
        }
        catch (MongoCommandException ex) when (ex.Code == 11000)
        {
            return false;
        }
    }

    async Task CompensateAsync(bool restoreDefaults)
    {
        foreach (var rollback in claimRollbacks)
        {
            // 条件更新：值还是我刚写进去的那个才还。期间被第三方改过就不动它——
            // 盲目覆盖会把别人的改动一起抹掉，那是用一个错换另一个错。
            var restored = await TryRestoreAsync(
                Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("_id", rollback.RivalId),
                    Builders<BsonDocument>.Filter.Eq("DefaultForAppCallerCodes", new BsonArray(rollback.AfterWrite))),
                Builders<BsonDocument>.Update
                    .Set("DefaultForAppCallerCodes", new BsonArray(rollback.Before))
                    .Set("UpdatedAt", DateTime.UtcNow));
            if (!restored) compensationWarnings.Add($"{rollback.RivalId}（调用方认领）");
        }
        if (!restoreDefaults) return;
        foreach (var rivalId in defaultRollbacks)
        {
            var restored = await TryRestoreAsync(
                Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("_id", rivalId),
                    Builders<BsonDocument>.Filter.Eq("IsDefaultForType", false)),
                Builders<BsonDocument>.Update
                    .Set("IsDefaultForType", true)
                    .Set("UpdatedAt", DateTime.UtcNow));
            if (!restored) compensationWarnings.Add($"{rivalId}（用途默认）");
        }
    }

    string WithCompensationNote(string message)
        => compensationWarnings.Count == 0
            ? message
            : message + $" 另外：这次没保存成功，但有 {compensationWarnings.Count} 处位移没能还原"
                + $"（{string.Join("、", compensationWarnings)}），它们在这期间被别人改过。去这几个模型上核对一下。";

    BsonDocument? updated;
    try
    {
        updated = await gwLogicalModels.FindOneAndUpdateAsync(
            TenantAccess.Filter(http, Builders<BsonDocument>.Filter.Eq("_id", id)),
            Builders<BsonDocument>.Update.Combine(updates),
            new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After });
    }
    catch (MongoCommandException ex) when (ex.Code == 11000)
    {
        /*
          撞上唯一索引：另一个人在这一瞬抢先了。但**先要分清撞的是哪一条**，
          因为「摘掉的用途默认要不要还回去」在两种撞车下答案相反：

            · 撞的是用途默认那条索引 → 有人赢了那个位子，还回去会再撞一次，不还；
            · 撞的是调用方认领那条索引 → 用途默认这一档**根本没有赢家**，
              而这次请求已经把原来的默认摘掉了。不还的话，这个用途就此没有默认，
              所有不点名的请求当场开始失败——一次被拒绝的保存，顺手弄坏了一整个用途。

          上一版是先补偿再判 claimRace，等于对两种撞车用同一个答案（形状 1：
          判据比它该管的范围窄，两种输入被压成一种）。
        */
        var claimRace = ex.Message.Contains("uniq_llmgw_logical_claim_per_type", StringComparison.Ordinal);
        await CompensateAsync(restoreDefaults: claimRace);
        var conflictMessage = claimRace
            ? "这几个调用方里有一个刚刚被另一个模型认领了。刷新看一眼它现在归谁，确认之后再改。"
            : "这个用途刚刚被另一个人设了默认模型。刷新看一眼当前默认是谁，确认之后再改。";
        return Json(ApiEnvelope<LogicalModelItem>.Fail(
            claimRace ? "CLAIM_CONFLICT" : "DEFAULT_CONFLICT", WithCompensationNote(conflictMessage)), jsonOptions, 409);
    }
    catch
    {
        // 别的失败（连接抖动、写入被拒）同样不能把摘掉的东西留在库里。
        // 补偿完把原异常抛出去，不吞——吞掉等于把一次真实故障变成一句无从排查的沉默。
        await CompensateAsync(restoreDefaults: true);
        throw;
    }
    if (updated is null)
    {
        // 目标在这中间被别人删了。这时「摘掉的默认」必须还回去：没有赢家，
        // 不还的话这个用途就此没有默认，而返回的只是一句「模型不存在」。
        await CompensateAsync(restoreDefaults: true);
        return Json(ApiEnvelope<LogicalModelItem>.Fail("NOT_FOUND", WithCompensationNote("逻辑模型不存在")), jsonOptions, 404);
    }
    await WriteOperationAuditAsync(operationAudits, http, "logical-model.update", "llmgw_logical_model", id, updated.GetStringOrEmpty("Name"), true, null,
        new BsonDocument
        {
            { "fieldCount", updates.Count - 1 },
            // 换兜底模型是会改变线上行为的动作：日后排查「什么时候开始默认走它了」要查得到人
            { "isDefaultForType", body.IsDefaultForType.HasValue ? body.IsDefaultForType.Value : BsonNull.Value },
            { "displacedDefaults", new BsonArray(displacedDefaults) },
            { "displacedClaims", new BsonArray(displacedClaims) },
        });
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
    if (body?.MaxConcurrency is < 1 or > 10000)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_MAX_CONCURRENCY", "最大并发必须为 1 到 10000"), jsonOptions, 400);
    if (body?.RateLimitPerMinute is < 1 or > 1000000)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_RATE_LIMIT", "每分钟速率必须为 1 到 1000000"), jsonOptions, 400);
    if (!IsSafeOfferingEndpointPath(body?.EndpointPath))
        return Json(ApiEnvelope<ModelOfferingItem>.Fail("INVALID_ENDPOINT_PATH", "Endpoint path 必须是相对路径，且不能包含控制字符或反斜杠"), jsonOptions, 400);
    var targetPlatform = targetKind == "model" && !string.IsNullOrWhiteSpace(target?.AsNullableString("PlatformId"))
        ? await gwPlatforms.Find(TenantAccess.Filter(http, fb.Eq("_id", target!.AsNullableString("PlatformId")))).FirstOrDefaultAsync()
        : null;
    /*
      上游目标够不够格承接流量，判据在 OfferingTargetEligibility：目标在不在、启不启用、
      物理模型挂的 Provider 在不在启不启用、兑换所那条别名声明没声明。四条都对着运行时解析，
      不判的话会出现「存得进去、跑不起来」——接口回 201、界面上多出一条线路，而它一条流量
      都承接不了。**启用**一条早先停用的线路走的是另一个端点，它判的是同一件事，所以这几条
      判据收在一处，两个入口共用（第 51 轮 review：启用那一侧原先只判了 ASR 契约）。
    */
    var createTargetRejection = OfferingTargetEligibility.Evaluate(
        targetKind, target, targetPlatform, body?.UpstreamModelId);
    if (createTargetRejection is { } createRejection)
    {
        return Json(
            ApiEnvelope<ModelOfferingItem>.Fail(createRejection.Code, createRejection.Message),
            jsonOptions,
            createRejection.Code == "TARGET_NOT_FOUND" ? 404 : 409);
    }
    // 上面那道闸判的第一条就是「目标不在」，走到这里 eligibleTarget 必有值；给编译器一个凭据，
    // 而不是在这里再写一遍 null 判断（同一个判断第二份就是下一次漂移的起点）。
    var eligibleTarget = target!;
    var createAsrContractError = AsrOfferingContractPolicy.Validate(
        logical.GetStringOrEmpty("ModelType"),
        targetKind,
        AsrOfferingContractPolicy.ResolvePhysicalModel(
            body?.UpstreamModelId,
            eligibleTarget.AsNullableString("ModelName"),
            eligibleTarget.AsNullableString("ModelId")),
        body?.EndpointPath,
        body?.Protocol ?? eligibleTarget.AsNullableString("Protocol"),
        targetPlatform?.AsNullableString("PlatformType"));
    if (createAsrContractError is not null)
        return Json(ApiEnvelope<ModelOfferingItem>.Fail(
            AsrOfferingContractPolicy.ErrorCode,
            createAsrContractError), jsonOptions, 409);
    /*
      判重的身份必须与唯一索引 uniq_llmgw_offering_tenant_logical_target_v3 逐字相同。

      那个索引里带着 UpstreamModelId——因为一个兑换所底下挂着多个别名时，同一个对外模型
      完全可能同时指向其中好几个，那是合法拓扑。这里少一个字段就比索引更严：
      同样的拓扑走搬迁建得出来、走这个端点却回 DUPLICATE_OFFERING（判据分裂）。

      **但只按原值比又比索引松**：没写 UpstreamModelId 的线路运行时会回落到目标的名字，
      于是「不写」与「写上同名」是同一个上游、两个身份。判重按运行时打出去的那个名字比
      （OfferingIdentityPolicy），控制面因此比索引严一档——控制面可以比运行时严，
      绝不能比它松（第 66 轮 review）。
    */
    var createUpstreamModelId = string.IsNullOrWhiteSpace(body?.UpstreamModelId)
        ? BsonNull.Value
        : (BsonValue)body.UpstreamModelId.Trim();
    var duplicate = fb.And(
        fb.Eq("TenantId", tenantId),
        fb.Eq("LogicalModelId", id),
        fb.Eq("TargetKind", targetKind),
        fb.Eq("TargetId", targetId),
        OfferingIdentityPolicy.SameUpstreamFilter(targetKind, eligibleTarget, body?.UpstreamModelId),
        fb.Not(fb.Exists("SupersededByOfferingId")));
    if (await gwModelOfferings.Find(duplicate).AnyAsync())
        return Json(ApiEnvelope<ModelOfferingItem>.Fail(
            "DUPLICATE_OFFERING",
            "这条上游（含指定的上游模型）已经绑定到此逻辑模型"), jsonOptions, 409);

    var now = DateTime.UtcNow;
    var offeringId = $"gw-offering-{Guid.NewGuid():N}";
    var document = new BsonDocument
    {
        { "_id", offeringId }, { "TenantId", tenantId }, { "LogicalModelId", id },
        { "TargetKind", targetKind }, { "TargetId", targetId },
        { "UpstreamModelId", createUpstreamModelId },
        { "Protocol", string.IsNullOrWhiteSpace(body?.Protocol) ? BsonNull.Value : body.Protocol.Trim().ToLowerInvariant() },
        { "EndpointPath", string.IsNullOrWhiteSpace(body?.EndpointPath) ? BsonNull.Value : body.EndpointPath.Trim() },
        { "Priority", Math.Clamp(body?.Priority ?? 100, 0, 10000) }, { "Weight", Math.Clamp(body?.Weight ?? 100, 1, 10000) },
        { "Enabled", true }, { "HealthStatus", 0 }, { "ConsecutiveFailures", 0 }, { "ConsecutiveSuccesses", 0 },
        { "MaxConcurrency", body?.MaxConcurrency is > 0 ? body.MaxConcurrency.Value : BsonNull.Value },
        { "RateLimitPerMinute", body?.RateLimitPerMinute is > 0 ? body.RateLimitPerMinute.Value : BsonNull.Value },
        { "Notes", string.IsNullOrWhiteSpace(body?.Notes) ? BsonNull.Value : body.Notes.Trim() },
        { "CreatedAt", now }, { "UpdatedAt", now },
    };
    /*
      并发创建撞上线路身份唯一索引要翻成 409，不能漏成 500。

      上面那句判重挡不住竞态：两个人同时给同一个对外模型挂同一条上游（含同一个上游模型）时，
      两边的判重查询都能在对方插入之前通过，真正拦住的是唯一索引
      uniq_llmgw_offering_tenant_logical_target_v3。不接这个异常的话，输的那一方拿到 500——
      同一件事，不撞车时给的是说得出下一步的 409，撞车时给的却是一句「服务器错误」
      （external-cause-first：内因当结论交出去，读的人无法处置）。

      这条路径不只在并发下走得到：身份索引从 v2 升到 v3 要 DBA 手动做（no-auto-index，
      见 LlmGatewayDatabaseInitializer 的警告），在那之前旧索引比新的更严——同一个兑换所下的
      第二条别名会在这里撞键，而它其实是合法拓扑。所以这里的提示要把这种情况一并说出来。
    */
    try
    {
        await gwModelOfferings.InsertOneAsync(document);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<ModelOfferingItem>.Fail(
            "DUPLICATE_OFFERING",
            "这条上游（含指定的上游模型）刚刚已经被绑定到此逻辑模型了。"
            + "刷新一下看看现在挂着哪几条；如果列表里并没有同样的一条，"
            + "那就是线路身份唯一索引还停在旧版（它不认上游模型，所以同一个兑换所下的第二条别名会撞），"
            + "让 DBA 按 doc/guide.platform.mongodb-indexes.md 升到 v3 之后再试"),
            jsonOptions, 409);
    }
    await WriteOperationAuditAsync(operationAudits, http, "model-offering.create", "llmgw_model_offering", offeringId, targetId, true, null,
        new BsonDocument { { "logicalModelId", id }, { "targetKind", targetKind }, { "targetId", targetId } });
    var platformsForMap = await gwPlatforms.Find(TenantAccess.Filter(http)).ToListAsync();
    var item = MapLogicalModel(
        logical,
        new List<BsonDocument> { document },
        targetKind == "model" ? new List<BsonDocument> { eligibleTarget } : new List<BsonDocument>(),
        targetKind == "exchange" ? new List<BsonDocument> { eligibleTarget } : new List<BsonDocument>(),
        platformsForMap).Offerings.Single();
    return Json(ApiEnvelope<ModelOfferingItem>.Ok(item), jsonOptions, 201);
}).RequireAuthorization("ConfigWrite");

// 手动恢复一条上游线路：与模型池成员的 recover 同一语义——不直接放回健康，只授予进入
// 半开的资格，由下一条真实业务请求负责验证，不额外发付费探测。
// 没有这个入口之前，被隔离的 Offering 只能靠「去改一次平台密钥」这种副作用来复活。
app.MapPost("/gw/logical-models/{logicalId}/offerings/{offeringId}/recover", async (HttpContext http, string logicalId, string offeringId) =>
{
    var filter = TenantAccess.Filter(http, Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("_id", offeringId),
        Builders<BsonDocument>.Filter.Eq("LogicalModelId", logicalId)));
    var existing = await gwModelOfferings.Find(filter).FirstOrDefaultAsync();
    if (existing is null)
        return Json(ApiEnvelope<object>.Fail("NOT_FOUND", "Offering 不存在"), jsonOptions, 404);

    var previousHealthStatus = existing.AsNullableInt("HealthStatus") ?? 0;
    var now = DateTime.UtcNow;
    await gwModelOfferings.UpdateOneAsync(
        filter,
        Builders<BsonDocument>.Update
            .Set("HealthStatus", 2)
            .Set("ConsecutiveSuccesses", 0)
            .Set("ManualRecoveryAt", now)
            .Unset("HalfOpenLeaseUntil")
            .Set("UpdatedAt", now));

    await WriteOperationAuditAsync(
        operationAudits, http,
        action: "model-offering.recover",
        targetType: "llmgw_model_offering",
        targetId: offeringId,
        targetName: existing.AsNullableString("UpstreamModelId") ?? existing.AsNullableString("TargetId"),
        success: true,
        reason: "manual-half-open",
        changes: new BsonDocument
        {
            { "logicalModelId", logicalId },
            { "fromHealthStatus", previousHealthStatus },
            { "toHealthStatus", 2 },
        });

    return Json(ApiEnvelope<object>.Ok(new { offeringId, halfOpenPending = true }), jsonOptions);
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
    // 改到上游别名时与创建同一道门：判据同一份，两个入口不许一严一松。
    if (targetKind == "exchange" && target is not null && body.UpstreamModelId is not null)
    {
        var updatedAlias = ExchangeAliasPolicy.EffectiveAlias(target, body.UpstreamModelId);
        if (!ExchangeAliasPolicy.Declares(target, updatedAlias))
        {
            return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                "EXCHANGE_ALIAS_NOT_DECLARED",
                updatedAlias.Length == 0
                    ? "这个兑换所没有主别名，所以必须指定「上游模型」；清空它的话运行时会把这条线路整条跳过。"
                    : $"兑换所里没有启用着的别名「{updatedAlias}」（不存在，或被单独停用了）。"
                      + "去兑换所页确认这条别名的拼写与开关，再回来保存。"), jsonOptions, 409);
        }
    }
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

        /*
          先确认「换成这个上游之后，它的身份不会和另一条在跑的线路撞车」，再动任何一次写。

          线路身份（唯一索引 v3）= 租户 + 对外模型 + 目标类型 + 目标 + 实际上游模型。
          两条在跑的线路本来各用各的 UpstreamModelId，把其中一条改成另一条的值，
          晋升那一步 Unset SupersededByOfferingId 时才会撞上索引——而那时原线路已经被退休、
          替身还挂着 staging 标记，异常从 UpdateOneAsync 抛出去，直接越过下面那段回滚：
          原线路停用、替身悬空，用户拿到一句 500。
          所以判在最前面：这条是纯查询，位移之前判完，后面才不需要为它准备一条回滚路径。
        */
        var replacementUpstreamModelId = replacement.GetValue("UpstreamModelId", BsonNull.Value);
        var identityRival = await gwModelOfferings.Find(TenantAccess.Filter(http, fb.And(
            fb.Eq("LogicalModelId", logicalId),
            fb.Eq("TargetKind", targetKind),
            fb.Eq("TargetId", targetId),
            // 与创建那一侧同一份判据：按运行时实际打出去的名字比，不按原值逐字比。
            OfferingIdentityPolicy.SameUpstreamFilter(
                targetKind, target, replacementUpstreamModelId.IsString ? replacementUpstreamModelId.AsString : null),
            fb.Ne("_id", offeringId),
            fb.Not(fb.Exists("SupersededByOfferingId"))))).FirstOrDefaultAsync();
        if (identityRival is not null)
        {
            return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                "DUPLICATE_OFFERING",
                "这个对外模型下已经有另一条线路指向同一个上游（含指定的上游模型），"
                + "改成这个值会和它撞车。先把那一条删掉或改掉，再回来改这一条。"), jsonOptions, 409);
        }

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

        // 晋升失败的回滚只写一次：把原线路复活、把悬空的替身删掉。
        // 上一版只在 ModifiedCount != 1 这一条路上回滚，而撞唯一索引时异常从 UpdateOneAsync
        // 抛出去，压根到不了那里——原线路停用、替身悬空，两样都留在库里。
        async Task RollbackPromotionAsync()
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
        }

        UpdateResult promoted;
        try
        {
            promoted = await gwModelOfferings.UpdateOneAsync(
                TenantAccess.Filter(http, fb.And(
                    fb.Eq("_id", replacementId),
                    fb.Eq("SupersededByOfferingId", stagingMarker))),
                Builders<BsonDocument>.Update
                    .Unset("SupersededByOfferingId")
                    .Set("Enabled", replacementEnabled)
                    .Set("UpdatedAt", DateTime.UtcNow));
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 上面那道纯查询之后、这一步之前，有人新建了一条同身份的线路。回滚，如实说撞了谁。
            await RollbackPromotionAsync();
            return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                "DUPLICATE_OFFERING",
                "就在这几毫秒里，这个对外模型下多了一条指向同一个上游（含指定的上游模型）的线路，"
                + "改动没有生效，原线路已经恢复。刷新看一眼现在有哪些线路，再决定怎么改。"), jsonOptions, 409);
        }
        catch (MongoException ex)
        {
            /*
              撞键之外的失败（超时、主从切换、连接断开）同样要回滚。

              上一版只接了撞键那一种，于是一次超时会带着原线路停用、替身悬空一起留在库里——
              这个对外模型从此一条可用线路都没有，而操作者拿到的是一句 500。
              「只有想得到的那种失败才回滚」正是判据太窄（形状 1）：真实失败里最常见的那种
              恰好不在名单上。

              超时这一类失败的结果是**未知的**（服务端可能已经写成功）。回滚不去猜：它是条件更新
              ——原线路仍带着指向这个替身的标记才复活——所以晋升真的成功了也照样回到改之前的样子，
              成功与否两种情形殊途同归。
            */
            try
            {
                await RollbackPromotionAsync();
            }
            catch (MongoException rollbackFailure)
            {
                return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                    "OFFERING_PROMOTION_LEFT_PARTIAL",
                    $"新路由没能接管流量（{ex.Message}），回滚也失败了（{rollbackFailure.Message}）。"
                    + $"这个对外模型现在可能一条可用线路都没有：原线路 {offeringId} 停用着、"
                    + $"替身 {replacementId} 悬空着。刷新看一眼，手动把原线路启用回来"),
                    jsonOptions, 500);
            }

            return Json(ApiEnvelope<ModelOfferingItem>.Fail(
                "OFFERING_PROMOTION_FAILED",
                $"新路由没能接管流量（{ex.Message}），原线路已经恢复，改动没有生效。稍后重试"),
                jsonOptions, 503);
        }
        if (promoted.ModifiedCount != 1)
        {
            await RollbackPromotionAsync();
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
        Builders<BsonDocument>.Update
            .Set("Enabled", enabled)
            // 人手动碰过启用状态，就把「这是搬迁停的」那个戳清掉：从这一刻起这条模型的开关
            // 归人管，重跑搬迁不该再替他改（见搬迁端点里那个复活分支）。
            .Unset("DisabledByMigrationAt")
            .Set("UpdatedAt", DateTime.UtcNow),
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
        /*
          重新打开一条停用的线路，和新建一条线路要过同一道资格闸（判据见 OfferingTargetEligibility）。
          原先这里只判 ASR 契约，于是指着已删模型、已停 Provider、已关别名的那条线路可以被重新
          打开——接口回 200、界面上它是启用的，而运行时会把它整条丢掉。
        */
        var enableRejection = OfferingTargetEligibility.Evaluate(
            targetKind, target, platform, existing.AsNullableString("UpstreamModelId"));
        if (enableRejection is { } rejection)
        {
            return Json(
                ApiEnvelope<ModelOfferingItem>.Fail(rejection.Code, rejection.Message),
                jsonOptions,
                rejection.Code == "TARGET_NOT_FOUND" ? 404 : 409);
        }
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
            now,
            access.Username);
        await gwModelExchanges.InsertOneAsync(exchangeDocument, cancellationToken: http.RequestAborted);
    }
    else
    {
        await gwModelExchanges.UpdateOneAsync(
            exchangeFilter,
            Builders<BsonDocument>.Update
                .Set("Name", exchangeDraft.Name)
                .Set("NameNormalized", exchangeDraft.NameNormalized)
                .Set("Models", GatewayConfigurationProvisioning.BuildExchangeModels(exchangeDraft.Models, access.Username, now))
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
    var activeAppCallers = appCallerDocs
        .Where(d => string.Equals(d.AsNullableString("Status") ?? "discovered", "active", StringComparison.OrdinalIgnoreCase))
        .ToList();

    /*
      「这个 active 调用方有没有人接得住」——判据是**对外模型**，不是池绑定。

      池路由退场之后，配对的调用方根本没有池绑定，而 AllReferencedModelPoolsExist 对
      「一条池引用都没有」返回 false：于是一份完全正确的配置会被这份报告判成
      activeMissingGatewayPool > 0、status=blocked，而 scripts/llmgw-release-gate.py 读的
      正是这两个字段——这一刀砍完池，发布反而被自己的报告挡住了。反向也一样坏：
      一个还留着健康池字段、却没有任何对外模型接得住的调用方会被判成就绪。

      所以这里与发布闸那份用同一个 FindUnnamedCatcherAsync（它又与运行时
      TryResolveDefaultLogicalModelAsync 逐层对齐）。两处各写一套正是形状 3。

      DTO 的字段名保持不变：scripts/llmgw-release-gate.py 与 llmgw-rollout-ledger.py
      按名读它们，改名等于同一轮里再断一条线。含义已随判据改写，注释与文案同步说明。
    */
    var reportTenantId = TenantAccess.GetRequired(http).TenantId;
    var activeWithCatcher = 0;
    var activeWithoutCatcherDocs = new List<BsonDocument>();
    foreach (var caller in activeAppCallers)
    {
        var catcher = await FindUnnamedCatcherAsync(
            gwLogicalModels,
            gwModelOfferings,
            gwModels,
            gwPlatforms,
            gwModelExchanges,
            gwMigrations,
            reportTenantId,
            caller.AsNullableString("RequestType"),
            caller.AsNullableString("AppCallerCode"));
        if (catcher is null) activeWithoutCatcherDocs.Add(caller);
        else activeWithCatcher++;
    }
    var activeWithGatewayPool = activeWithCatcher;
    // 「接得住」这份判据里已经要求那条对外模型真有一条启用且解析得出来的线路，
    // 所以「绑定了但成员不可用」这一档在新判据下不再是一个独立状态，恒为 0。
    var activeWithUsableGatewayPool = activeWithCatcher;
    var activeMissingGatewayPool = activeWithoutCatcherDocs.Count;
    var activeBoundPoolWithoutUsableMember = 0;
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
    // 缺口也换成同一个判据：报「没绑池」会把人指向一个已经 302 走了的页面，
    // 而真正要做的是给这个调用方找一个接得住的对外模型。
    gaps.AddRange(activeWithoutCatcherDocs
        .Take(30)
        .Select(d => new ConfigAuthorityGapItem
        {
            ObjectType = "appCaller",
            Id = d.GetStringOrEmpty("_id"),
            Name = d.AsNullableString("AppCallerCode") ?? d.GetStringOrEmpty("_id"),
            Status = "active-appcaller-without-catcher",
            Detail = "active appCaller 没有对外模型接得住（没人认领它，这个用途的默认也接不住）："
                + "去「模型」页把某个模型的「指定调用方」加上它，或给这个用途设一个默认模型。",
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
    var gwPoolIds = IdSet(gwPoolDocs);
    var activeAppCallers = appCallerDocs
        .Where(d => string.Equals(d.AsNullableString("Status") ?? "discovered", "active", StringComparison.OrdinalIgnoreCase))
        .ToList();
    var activeAppCallerCodes = activeAppCallers
        .Select(d => d.AsNullableString("AppCallerCode"))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x!)
        .ToHashSet(StringComparer.Ordinal);
    // 「有没有人接得住这个 active 调用方」——判据换成对外模型，不再看池绑定。
    //
    // 池退场之后，正确配置的调用方（走 DefaultForAppCallerCodes / IsDefaultForType）根本没有
    // 池绑定，而带着残留绑定的那几个指向的池文档已经被删——旧判据把它们判成 blocked，
    // 并让人去 /pools 修，可那个页面现在 302 到对外模型页、写端点全删了：
    // 一个配对的调用方能卡住发布，而且没有任何可执行的修复动作（形状 5 的近亲：
    // 判据守的是一个已经不存在的状态，于是它只会误伤，不会拦住任何真问题）。
    //
    // 复用 FindUnnamedCatcherAsync：那份判据与运行时 TryResolveDefaultLogicalModelAsync
    // 逐层对齐（先看谁认领、再看用途默认，两层都要求启用且真有一条启用的线路），
    // 不在这里另写一套（形状 3）。
    var activeAppCallersWithoutCatcher = 0;
    foreach (var caller in activeAppCallers)
    {
        var catcher = await FindUnnamedCatcherAsync(
            gwLogicalModels,
            gwModelOfferings,
            gwModels,
            gwPlatforms,
            gwModelExchanges,
            gwMigrations,
            TenantAccess.GetRequired(http).TenantId,
            caller.AsNullableString("RequestType"),
            caller.AsNullableString("AppCallerCode"));
        if (catcher is null) activeAppCallersWithoutCatcher++;
    }
    var activeMissingGatewayPool = activeAppCallersWithoutCatcher;
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
    // 「线路可用性」这一条已经被上面那个判据吸收了：FindUnnamedCatcherAsync 认一个模型的前提
    // 就是它至少有一条启用的线路。再单独判一次池成员可用性，守的是一个已经不存在的对象，
    // 而且两条判据会各自漂移（形状 3）。这里恒 0，对应的 gate 下面改成如实说明它已退场。
    var activeBoundPoolWithoutUsableMember = 0;
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
        "active appCaller 有对外模型接得住",
        activeMissingGatewayPool == 0 && discoveredAppCallers == 0 ? "pass" : "blocked",
        activeMissingGatewayPool > 0 || discoveredAppCallers > 0,
        activeMissingGatewayPool == 0 && discoveredAppCallers == 0
            ? "每个 active appCaller 都有对外模型接得住，且无 discovered 调用方等待治理。"
            : $"{activeMissingGatewayPool} 个 active 调用方没有对外模型接得住（没人认领它，这个用途的默认也接不住），"
              + $"{discoveredAppCallers} 个 discovered 调用方尚未治理。",
        $"/gw/config-authority/report activeWithoutCatcher={activeMissingGatewayPool}; discoveredAppCallers={discoveredAppCallers}",
        activeMissingGatewayPool == 0 && discoveredAppCallers == 0
            ? "可进入 MAP fallback 退场复核。"
            : "去「模型」页把某个模型的「指定调用方」加上它，或给这个用途设一个默认模型；discovered 调用方在 /app-callers 治理。",
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

    // 这一条已随模型池退场：它守的「绑定的池有没有可用成员」现在没有对象了，
    // 而它真正关心的事——「接得住这个调用方的那个模型有没有一条能用的线路」——
    // 已经被上面那条判据吸收（FindUnnamedCatcherAsync 认一个模型的前提就是它有启用的线路）。
    // 保留这个 id 是为了不破坏消费这份报告的存量脚本，但它不再 blocking，也不再指向已删的页面。
    AddGate(
        "gateway_pool_member_readiness",
        "GW 池成员可用性（已随模型池退场）",
        "pass",
        false,
        "模型池路由已退场，这条判据不再有对象；线路可用性已并入「active appCaller 有对外模型接得住」那一条。",
        "/logical-models 线路可用性已并入 active_appcaller_pool_binding",
        "无需处理。要看某个模型的线路健康，去「模型」页打开它的调用全貌。",
        new Dictionary<string, string>
        {
            // 只留仍然成立的那几个计数；池相关的字段跟着判据一起退场，
            // 留着会让读报告的人以为这条还在按池判。
            ["retired"] = "model-pool-routing",
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
                ? "当前运行态已禁止 active appCaller 使用 MAP 配置兜底，且每个 active 调用方都有接得住的对外模型。"
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
            // 前置条件早就改判「有没有对外模型接得住」（FindUnnamedCatcherAsync），
            // 而这句处置还停在池的世界里——池路由与它的写入界面都已退场，照着做满足不了这道闸
            // （第 64 轮 review：又一句走不通的下一步）。
            : "先完成 MAP-only 配置认领，再给这几个 active 调用方找到接得住的对外模型："
              + "要么在白名单页把某条模型的「认领」加上这个调用方，要么给这个用途设一个可用的默认模型"
              + "（那条模型得启用、且至少有一条现在能接流量的线路）。都齐了再在 full-http 发布进程中"
              + "启用 DisableMapConfigFallbackForActiveAppCallers。",
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

// ── 服务网关设置（系统级）：网关自己要用模型时，用哪个池 / 哪个模型，凭据由它自己管 ──
//
// 为什么要有这一层：控制台的内部功能（当前是 Quickstart 的「一句话推导调用用途码」）也要调模型。
// 第一版把它接在三个环境变量上（地址 + 手签的 service key + appCaller），结果是：
// 手签的那把 key 一旦被轮换、撤销，或容器里的 env 与网关库里的 key 目录对不上，
// serving 就在鉴权门上回 401 —— 一个「网关自己调自己却说你没权限」的荒谬状态，
// 而用户除了看见一句裸 401 什么也做不了。用户原话：「系统就是服务网关，还有 401 问题?」
//
// 所以改成：**系统级配置存在库里，凭据由网关自己签发和自愈**。
// 用户在「服务网关设置」里只做一件事——选这套系统功能用哪个模型池或哪个模型；
// 地址、appCaller、密钥一律不出现在表单里（minimal-user-input：系统自己知道的值不许摆成输入框）。
// 密钥失效时自动重签一把，不再需要任何人去改 env。
var systemSettings = gatewayDatabase.GetCollection<BsonDocument>("llmgw_system_settings");
// 系统功能自己的调用用途码。前缀 llmgw-console 表示「控制台自身」，与用户业务的 appCaller 分开计费与观测。
const string SystemIntentDraftAppCaller = "llmgw-console.intent-draft::chat";
// 网关自己签给自己的那把 key 的名字。命名即用途，运维在密钥页一眼能认出「这把不是人签的」。
const string SystemServiceKeyName = "llmgw-system-internal";
const string SystemServiceKeyClientCode = "llmgw-console";
// 与 serving 的 X-Gateway-Source 判据对齐：key 上写什么，请求头就带什么，否则 403 scope-mismatch。
const string SystemServiceKeySource = "llmgw-console";
// 系统内部消耗单独归一个团队。用户 2026-08-28 的原话：「系统内部的，按照系统内部的团队，
// 消耗，权限……并且计费方式是单独计费，系统团队的」。
// 借用「租户里第一个 active 团队」是不行的：那把系统自己的用量记进了某个业务团队的预算，
// 而且这个团队随建库顺序变化——同一套系统功能在不同部署会记到不同人头上。
const string SystemTeamName = "系统内部";
var systemModelSources = new HashSet<string>(StringComparer.Ordinal) { "auto", "pool", "model" };

// serving 的内网地址。这不是「用户该填的东西」——同一个部署里它是确定的，
// 所以只从配置读，设置页只展示不让填；读不到就在设置页明说「没探到」，不猜。
string ResolveServingBaseUrl()
{
    var candidates = new[]
    {
        Environment.GetEnvironmentVariable("LLMGW_INTENT_DRAFT_BASE_URL"),
        Environment.GetEnvironmentVariable("LLMGW_SERVING_BASE_URL"),
        Environment.GetEnvironmentVariable("LLMGW_SERVING_PROXY_TARGET"),
        builder.Configuration["LlmGwServe:BaseUrl"],
    };
    foreach (var candidate in candidates)
    {
        var value = (candidate ?? string.Empty).Trim().TrimEnd('/');
        if (value.Length > 0) return value;
    }
    return string.Empty;
}

async Task<BsonDocument> LoadSystemSettingsAsync(string tenantId)
{
    var doc = await systemSettings.Find(Builders<BsonDocument>.Filter.Eq("_id", tenantId)).FirstOrDefaultAsync();
    return doc ?? new BsonDocument
    {
        { "_id", tenantId },
        { "TenantId", tenantId },
        { "ModelSource", "auto" },
    };
}

/// <summary>
/// 找到（没有就建）本租户的「系统内部」团队。系统自己的 appCaller 与 key 一律挂在它名下，
/// 于是系统消耗与任何业务团队的预算、权限、账单彻底分开——这是「单独计费」的落点。
///
/// id 用 {tenantId}_system 这种确定值而不是随机 Guid：多容器并发时各自算出同一个 id，
/// 而 (TenantId, NormalizedName) 上还有唯一索引兜底，两层都撞不出第二个系统团队。
/// </summary>
async Task<string> EnsureSystemTeamAsync(string tenantId)
{
    var systemTeamId = $"{tenantId}_system";
    var normalized = SystemTeamName.ToUpperInvariant();
    var now = DateTime.UtcNow;

    var existing = await teams.Find(x => x.Id == systemTeamId && x.TenantId == tenantId).FirstOrDefaultAsync();
    if (existing is not null)
    {
        // 团队被停用会让 serving 在生命周期门上回 GATEWAY_KEY_TEAM_INACTIVE。
        // 系统团队不是业务团队，没有「停用它」的合法语义，撞见就掰回来。
        if (!string.Equals(existing.Status, "active", StringComparison.Ordinal))
        {
            await teams.UpdateOneAsync(
                x => x.Id == systemTeamId,
                Builders<LlmGwTeam>.Update.Set(x => x.Status, "active").Set(x => x.UpdatedAt, now));
        }
        return systemTeamId;
    }

    try
    {
        await teams.InsertOneAsync(new LlmGwTeam
        {
            Id = systemTeamId,
            TenantId = tenantId,
            Name = SystemTeamName,
            NormalizedName = normalized,
            Status = "active",
            CreatedAt = now,
            UpdatedAt = now,
        });
        return systemTeamId;
    }
    catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
    {
        // 撞唯一索引有两种可能，处置完全不同，不能一律认名字：
        //
        // a) 另一个容器刚把**同一个 id** 建好 —— 并发，按幂等处理，直接用它。
        // b) 早就有人手建了一个**同名的业务团队** —— 认名字就等于把系统的消耗、预算和账单
        //    挂到别人的团队上；那个团队要是停用状态，系统签出来的每一把 key 还会在
        //    生命周期门上被判死。系统身份不去占用户的团队，另起一个带后缀的名字，
        //    id 仍然是确定值，账单照旧单独记。
        var byName = await teams
            .Find(x => x.TenantId == tenantId && x.NormalizedName == normalized)
            .FirstOrDefaultAsync();
        if (byName is not null && string.Equals(byName.Id, systemTeamId, StringComparison.Ordinal))
            return systemTeamId;

        for (var suffix = 2; suffix <= 20; suffix++)
        {
            var fallbackName = $"{SystemTeamName}（网关自建 {suffix}）";
            try
            {
                await teams.InsertOneAsync(new LlmGwTeam
                {
                    Id = systemTeamId,
                    TenantId = tenantId,
                    Name = fallbackName,
                    NormalizedName = fallbackName.ToUpperInvariant(),
                    Status = "active",
                    CreatedAt = now,
                    UpdatedAt = now,
                });
                return systemTeamId;
            }
            catch (MongoWriteException retry) when (retry.WriteError.Category == ServerErrorCategory.DuplicateKey)
            {
                // 这个后缀也被占了（或者并发把同 id 建出来了）：同 id 就是并发，直接用。
                var byId = await teams.Find(x => x.Id == systemTeamId && x.TenantId == tenantId).FirstOrDefaultAsync();
                if (byId is not null) return systemTeamId;
            }
        }

        // 二十个后缀全被占：返回空串而不是抛异常，让两个调用方各自给出说得出原因的失败——
        // 抛上去只会变成一个裸 500，而这一整套设计的前提就是「不许把裸状态码丢给用户」。
        app.Logger.LogWarning(
            "[SystemTeam] 租户 {TenantId} 下「{Name}」及其备用名均被业务团队占用，系统团队无法建立",
            tenantId, SystemTeamName);
        return string.Empty;
    }
}

/// <summary>
/// 退役该租户下多余的系统级密钥：留下设置指向的那把（winner），其余**够老的**一律停用。
///
/// 两个条件缺一不可。不碰胜者，否则设置会指着一把已停用的密钥；不碰刚签出来的（5 分钟内），
/// 否则两个并发请求会各自把对方那把停掉，最后两把都不可用——回读与停用之间没有原子性，
/// 靠「够老」这一条把并发对手排除在射程外，就不必再引入锁。
///
/// 判定只此一处，签发路径与复用路径都调它：抄成两份，下次就只会改一边。
/// </summary>
async Task RetireStaleSystemKeysAsync(string tenantId, string winnerKeyId)
{
    var retireBefore = DateTime.UtcNow.AddMinutes(-5);
    await serviceKeys.UpdateManyAsync(
        Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            // 归属认标记，不认名字：名字是显示用的，接入密钥页不拦着谁把自己的 key 也叫
            // 这个名。只按名字扫，用户那把同名 key 会被每一次系统调用连坐撤销——
            // 这道自愈本来是修自己的凭据，不该动别人的。SystemManaged 从签发那天起就盖，
            // 没有缺标记的存量系统 key，所以按它筛不留缺口。
            Builders<BsonDocument>.Filter.Eq("SystemManaged", true),
            Builders<BsonDocument>.Filter.Eq("Name", SystemServiceKeyName),
            Builders<BsonDocument>.Filter.Ne("_id", winnerKeyId),
            Builders<BsonDocument>.Filter.Lt("CreatedAt", retireBefore),
            Builders<BsonDocument>.Filter.Eq("Enabled", true)),
        Builders<BsonDocument>.Update.Set("Enabled", false).Set("RotationState", "revoked").Set("UpdatedAt", DateTime.UtcNow));
}

/*
  「这条 appCaller 此刻接不接流量」——与 serving 的 GatewayAppCallerPolicy.AllowsTraffic 同一套枚举。
  console-api 按既定架构不引用 PrdAgent.*，所以这里有一份镜像；守卫钉住两侧枚举一致，
  并钉住这个判定**全文件只此一处**：同一个判断在这个仓库里已经被抄散过两次，
  每多一份就多一条会漏判的路径，而漏判的后果都是「页面签出一把一调用即被拒的钥匙」。
*/
static bool AppCallerAcceptsTraffic(string? status)
    => (status ?? "discovered").Trim().ToLowerInvariant() is "discovered" or "configured" or "active";

/// <summary>
/// 系统级网关访问凭据的自愈入口：确保系统团队在、appCaller 已登记、有一把当下真的能过门的 key。
/// 任何一步失败都返回**说得出原因**的错误，绝不把裸 HTTP 状态码丢给用户。
///
/// 归属团队不接受调用方传入：系统内部的消耗按系统团队记，跟当前是谁点的按钮无关。
/// </summary>
// 选中的池，下一次系统调用真的解析得到吗。
//
// 判据与运行时 TryResolveLogicalModelAsync 那一支逐条同源：本租户 + 启用 + 用途对得上
// + MigratedFromPoolIds 里有这个池 ID。保存端点与取用路径共用这一份——两边各判各的话，
// 存得进去、跑不起来，而页面两处都说正常。
async Task<bool> SystemPoolResolvableAsync(string tenantId, string poolId)
    => await gwLogicalModels.Find(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("Enabled", true),
        Builders<BsonDocument>.Filter.Eq("ModelType", "chat"),
        Builders<BsonDocument>.Filter.AnyEq("MigratedFromPoolIds", poolId))).AnyAsync();

async Task<(bool Ok, string BaseUrl, string Key, string AppCaller, string? PoolId, string Model, string Error)>
    EnsureSystemGatewayAccessAsync(string tenantId, string actorUsername)
{
    var baseUrl = ResolveServingBaseUrl();
    if (baseUrl.Length == 0)
        return (false, "", "", SystemIntentDraftAppCaller, null, "auto", "没有探到 serving 的内网地址（LLMGW_INTENT_DRAFT_BASE_URL / LLMGW_SERVING_BASE_URL 均为空），系统级模型调用无法发出。");

    var settings = await LoadSystemSettingsAsync(tenantId);
    var modelSource = settings.AsNullableString("ModelSource") ?? "auto";
    var poolId = string.Equals(modelSource, "pool", StringComparison.Ordinal) ? settings.AsNullableString("ModelGroupId") : null;
    var model = string.Equals(modelSource, "model", StringComparison.Ordinal)
        ? settings.AsNullableString("ModelName") ?? "auto"
        : "auto";
    if (string.Equals(modelSource, "pool", StringComparison.Ordinal) && string.IsNullOrWhiteSpace(poolId))
        return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model, "系统级模型来源选了「模型池」，但没有选中任何池。去「服务网关设置」选一个对话池。");
    if (string.Equals(modelSource, "model", StringComparison.Ordinal) && string.IsNullOrWhiteSpace(settings.AsNullableString("ModelName")))
        return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model, "系统级模型来源选了「指定模型」，但没有选中任何模型。去「服务网关设置」选一个。");

    /*
      保存时校验过还不够：那只证明**保存的那一刻**这个池/模型是可用的对话类。
      此后它可能被停用、被改成别的类型、被删掉——而这里照旧把陈旧的名字发出去，
      运行时解析不到它就静默落回默认池，「测试连接」还会报成功。
      页面写着 A、实际跑的是 B，正是仓库 llm-gateway 规则点名禁止的静默落默认。
      所以取用时按运行时同一套口径再判一次，不成立就给说得出下一步的失败。
    */
    if (poolId is { Length: > 0 })
    {
        var poolStillUsable = await gwModelPools.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            Builders<BsonDocument>.Filter.Eq("_id", poolId),
            Builders<BsonDocument>.Filter.Eq("ModelType", "chat"))).AnyAsync();
        if (!poolStillUsable)
            return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model,
                "系统级模型池已经不可用了（被删除，或已不是对话类）。去「服务网关设置」重新选一个对话池——"
                + "在那之前系统功能不会去跑默认池冒充你的选择。");
        /*
          「池文档还在」只证明它还在池表里，不证明**解析得到它**。

          池路由已经退场：这条请求带的 model_policy=pool + 池文档 ID 会被顶进 expectedModel，
          而解析器认池 ID 的唯一一条路是「某个对外模型的 MigratedFromPoolIds 里有它」。
          没搬过的池在那条路上查不到，又因为 expectedModel 非空而跳过两层默认，
          直接 MODEL_NOT_FOUND（或对内部租户静默落到不相干的 legacy 兜底）——
          设置页写着这个池、就绪也显示正常，而 Quickstart 每一次都失败。
        */
        if (!await SystemPoolResolvableAsync(tenantId, poolId))
            return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model,
                "系统级选中的这个模型池还没有搬成对外模型，解析不到它（池路由已经退场，"
                + "认池 ID 的唯一一条路是它已经搬迁过）。"
                + "去「服务网关设置」改选「指定模型」——那一栏列的就是能解析到的对外模型，选完即刻生效。"
                + "在那之前系统功能不会拿别的模型冒充你的选择。"
                + "（这个池要继续用的话得先搬成对外模型，而控制台目前没有这个入口，"
                + "只有接口 POST /gw/pools/migrate-to-models，已记台账。）");
    }
    if (string.Equals(modelSource, "model", StringComparison.Ordinal))
    {
        var modelStillUsable = await gwLogicalModels.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            Builders<BsonDocument>.Filter.Eq("ModelType", "chat"),
            Builders<BsonDocument>.Filter.Ne("Enabled", false),
            Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Eq("PublicId", model),
                Builders<BsonDocument>.Filter.Eq("PublicIdNormalized", model.ToLowerInvariant())))).AnyAsync();
        if (!modelStillUsable)
            return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model,
                $"系统级模型「{model}」现在解析不到了（已停用、已改成别的类型，或已删除）。去「服务网关设置」重新选一个——"
                + "在那之前系统功能不会去跑默认池冒充你的选择。");
    }

    // 归属团队恒为系统团队。这里不再读设置里的 TeamId、也不再看调用者属于哪个团队——
    // 系统消耗只记在系统团队，才谈得上「单独计费」。
    var effectiveTeamId = await EnsureSystemTeamAsync(tenantId);
    if (effectiveTeamId.Length == 0)
        return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model,
            $"建不出系统团队：本租户下「{SystemTeamName}」这个名字已被业务团队占用，备用名也都被占。去「团队与成员」把那个同名团队改个名字，系统消耗才能单独记账。");

    // 1. appCaller 自动登记（幂等）：没有它 serving 会以「未注册用途」拒绝。
    var callerFilter = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("AppCallerCode", SystemIntentDraftAppCaller),
        Builders<BsonDocument>.Filter.Eq("RequestType", "chat"));
    var existingCaller = await gwAppCallers.Find(callerFilter).FirstOrDefaultAsync();
    if (existingCaller is not null)
    {
        // 归属认标记，不认码：这个码没有被任何地方保留，租户可以自助登记同名的一条。
        // 只按码搬，等于「谁先占了这个码，谁的 appCaller 就被我搬进系统团队」——
        // 那条业务 appCaller 名下的团队级密钥随后会在 serving 的归属比对上被判 403，
        // 而触发它的只是有人打开了这一页。别人的数据不该被这道自愈动到。
        // 存量兼容：标记是这一版才加的，此前系统自建的那条没有它。用它当时就写死的
        // SourceSystem 认亲（业务登记走的是 "external"，不会撞上），认到就顺手补上标记，
        // 之后再判就只看标记了。缺了这一档，已经用过这个功能的部署会被自己的旧文档挡在门外。
        var callerIsOurs = existingCaller.AsNullableBool("SystemManaged") == true
            || (!existingCaller.Contains("SystemManaged")
                && string.Equals(existingCaller.GetStringOrEmpty("SourceSystem"), SystemServiceKeySource, StringComparison.Ordinal));
        if (!callerIsOurs)
        {
            return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model,
                $"调用用途码「{SystemIntentDraftAppCaller}」已被本租户的业务调用方占用。"
                + "系统功能不会接管它——去「调用用途」把那条改成别的码，或联系管理员协调，之后再回来。");
        }

        /*
          归属对了还不够，还得问一句「它现在接不接流量」。

          这条虽然是系统自建的，但它照常出现在「调用用途」页里，管理员可以像对任何一条那样
          把它停用或归档（那个批量端点不区分是不是系统的）。停用之后这里若照旧发凭据，
          serving 会对每一次「测试连接」与「一句话推导」回 APP_CALLER_DISABLED，
          而这个码不在 IsSystemCredentialFixableCode 里——重签修不好它，自愈会一直空转，
          用户看到的只是一个反复失败、原因看不懂的功能。

          不替他改回去：那是他在「调用用途」页上做出的显式动作，系统悄悄撤销它就成了
          「我点的和实际发生的不是一件事」。改成当场停下并说清是哪一种状态、去哪一页恢复。
        */
        var systemCallerStatus = (existingCaller.AsNullableString("Status") ?? "discovered").Trim().ToLowerInvariant();
        if (!AppCallerAcceptsTraffic(systemCallerStatus))
        {
            return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model,
                $"系统内部调用用途「{SystemIntentDraftAppCaller}」当前处于「{systemCallerStatus}」状态，不接受流量。"
                + "去「调用用途」把它改回启用（configured / active），控制台自己的模型调用才能恢复——"
                + "在那之前重签密钥也没用，被拒的是这条用途而不是密钥。");
        }

        // 存量迁移：上一版把系统 appCaller 挂在了租户第一个业务团队上。留着不动有两个后果——
        // 消耗继续记在别人头上；而且 serving 会拿 key.TeamId 与 appCaller.TeamId 比对，
        // 对不上直接 403 GATEWAY_KEY_TEAM_MISMATCH。所以搬到系统团队，幂等。
        //
        // 搬的范围按 **AppCallerCode + SystemManaged** 而不是「code + requestType」：
        // serving 那条比对查的是同租户下这个码的**全部**文档，只要有一条团队不一致就整个拒绝；
        // 按更窄的条件搬会留下漏网文档把链路卡死，按更宽的条件搬会搬走别人的（上面那道门挡的就是它）。
        await gwAppCallers.UpdateManyAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
                Builders<BsonDocument>.Filter.Eq("AppCallerCode", SystemIntentDraftAppCaller),
                Builders<BsonDocument>.Filter.Eq("SourceSystem", SystemServiceKeySource),
                Builders<BsonDocument>.Filter.Ne("TeamId", effectiveTeamId)),
            Builders<BsonDocument>.Update.Set("TeamId", effectiveTeamId).Set("UpdatedAt", DateTime.UtcNow));

        // 认过亲就把标记补上：下一次判定不必再走存量兼容那一档。
        await gwAppCallers.UpdateManyAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
                Builders<BsonDocument>.Filter.Eq("AppCallerCode", SystemIntentDraftAppCaller),
                Builders<BsonDocument>.Filter.Eq("SourceSystem", SystemServiceKeySource),
                Builders<BsonDocument>.Filter.Exists("SystemManaged", false)),
            Builders<BsonDocument>.Update.Set("SystemManaged", true).Set("UpdatedAt", DateTime.UtcNow));
    }
    else
    {
        var callerNow = DateTime.UtcNow;
        try
        {
            await gwAppCallers.InsertOneAsync(new BsonDocument
            {
                { "_id", Guid.NewGuid().ToString("N") },
                { "TenantId", tenantId },
                { "TeamId", effectiveTeamId },
                { "AppCallerCode", SystemIntentDraftAppCaller },
                { "RequestType", "chat" },
                // 归属标记：日后判「这条是不是系统自建的」只认它，不认码（码可被业务占用）。
                { "SystemManaged", true },
                { "SourceSystem", SystemServiceKeySource },
                { "IngressProtocol", "openai-compatible" },
                { "ObservedIngressProtocols", new BsonArray() },
                { "Title", "网关控制台 · 一句话推导调用用途码" },
                { "Status", "configured" },
                { "ModelPolicy", "auto" },
                { "ParameterPolicy", "default-drop" },
                { "ObservedModelPoolIds", new BsonArray() },
                { "ObservedModelPolicies", new BsonArray() },
                { "ObservedParameterPolicies", new BsonArray() },
                { "TotalSeen", 0L },
                { "FirstSeenAt", callerNow },
                { "LastSeenAt", callerNow },
                { "CreatedAt", callerNow },
                { "UpdatedAt", callerNow },
            });
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            // 撞唯一索引说明并发里有人先建好了——但**不能假定那个人是我们**。
            // 用户在这一刻自助登记同一个码，赢的就是一条业务文档；把它当成自己的往下走，
            // 后面签出来的系统密钥会在 serving 的归属比对上一路 403，而凭据自愈修不好
            // 「这条码不归我」这件事。所以回读胜者，按同一套归属判据复判一次。
            var winner = await gwAppCallers.Find(callerFilter).FirstOrDefaultAsync();
            var winnerIsOurs = winner is not null
                && (winner.AsNullableBool("SystemManaged") == true
                    || (!winner.Contains("SystemManaged")
                        && string.Equals(winner.GetStringOrEmpty("SourceSystem"), SystemServiceKeySource, StringComparison.Ordinal)));
            if (!winnerIsOurs)
            {
                return (false, baseUrl, "", SystemIntentDraftAppCaller, null, model,
                    $"调用用途码「{SystemIntentDraftAppCaller}」刚被本租户的业务调用方登记走了。"
                    + "系统功能不会接管它——去「调用用途」把那条改成别的码，或联系管理员协调，之后再回来。");
            }
        }
    }

    /*
      把设置里选中的池**绑到**系统 appCaller 上。

      只发 X-Gateway-Model-Policy: pool 是不够的——那让池 id 进了 ExpectedModel，
      但解析器的候选池只来自这条 appCaller 的绑定（没绑就用租户默认池）：
      选中的池根本不在候选集里，把 ExpectedModel 拿去匹配也匹配不到，
      于是真跑的仍是默认池，而设置页上写着「只在这个池里调度」。
      页面说 A、实际跑 B，正是 llm-gateway 规则点名禁止的静默落默认。

      绑的是我们自己的 SystemManaged appCaller，而这一页正是它的配置界面，
      所以这不是越界改别人的治理状态——上一轮我以此为由只做了发头那一半，是判断错了。
      用 ModelPoolId 而不是 AllowedModelPoolIds：前者给出「候选池只有这一个」，
      恰好就是用户选的语义，且不会打开严格池契约（那会顺手掐掉「钉一个逻辑模型」那一档）。
      非 pool 档位要把绑定摘掉，否则改回「交给网关挑」之后还钉在上次那个池上。
    */
    var systemCallerScope = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("AppCallerCode", SystemIntentDraftAppCaller),
        Builders<BsonDocument>.Filter.Eq("SystemManaged", true));
    await gwAppCallers.UpdateManyAsync(
        systemCallerScope,
        poolId is { Length: > 0 }
            ? Builders<BsonDocument>.Update
                .Set("ModelPoolId", poolId)
                .Set("ModelPolicy", "pool")
                .Set("UpdatedAt", DateTime.UtcNow)
            : Builders<BsonDocument>.Update
                .Unset("ModelPoolId")
                .Set("ModelPolicy", "auto")
                .Set("UpdatedAt", DateTime.UtcNow));

    // 2. 密钥自愈：库里那把还在且启用就复用；对不上就重签一把。
    //    「对不上」包含三种：从没签过、被人撤销了、密文用当前密钥解不开（轮换过 ApiKeyCrypto:Secret）。
    var keyId = settings.AsNullableString("ServiceKeyId");
    if (!string.IsNullOrWhiteSpace(keyId))
    {
        var stored = await serviceKeys.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", keyId),
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId))).FirstOrDefaultAsync();
        if (SystemKeyIsUsableNow(
                stored,
                settings.AsNullableString("ServiceKeyEncrypted"),
                effectiveTeamId,
                SystemServiceKeySource,
                SystemIntentDraftAppCaller,
                builder.Configuration)
            && await SystemKeyHasDirectoryRowAsync(serviceKeyDirectory, tenantId, keyId))
        {
            // 存量归一：早期自签的 key 写过一个列表不认的 IssuanceState，那批 key 在接入密钥页
            // 是隐形的。这里顺手把它掰回 issued——幂等，且不必等下一次重签才让运维看见它。
            if (stored.AsNullableString("IssuanceState") is not (null or "issued"))
            {
                await serviceKeys.UpdateOneAsync(
                    Builders<BsonDocument>.Filter.Eq("_id", keyId),
                    Builders<BsonDocument>.Update.Set("IssuanceState", "issued").Set("UpdatedAt", DateTime.UtcNow));
            }
            // 变量名刻意不叫 decrypted：PlatformGovernance 守卫把「解密后取明文」那个表达式钉成
            // 全文件只许出现一次，用来证明**平台上游密钥**的明文只有喂给 Fingerprint 这一个去处
            //（守卫按源码文本计数，连注释里写一次都会把它撞红）。
            // 这里解出来的是网关自己的凭据，去向是出站的 X-Gateway-Key 头、不进任何响应，
            // 与那条守卫要防的事无关——换个名字，让守卫继续对它该管的那处保持有效。
            var systemKey = GwApiKeyCrypto.Decrypt(settings.AsNullableString("ServiceKeyEncrypted"), builder.Configuration);
            if (systemKey.Success && systemKey.PlainText.Length > 0)
            {
                // 复用路径也要扫一遍陈旧 key。并发签发时落败的那把被 5 分钟窗口有意放过，
                // 而此后每一次调用都从这里返回、再也走不到签发末尾的退役——不在这里扫，
                // 那把就一直留着，「只多留 5 分钟」也就成了一句不兑现的话。
                await RetireStaleSystemKeysAsync(tenantId, keyId);
                return (true, baseUrl, systemKey.PlainText, SystemIntentDraftAppCaller, poolId, model, string.Empty);
            }
        }
    }

    string plainKey;
    string newKeyId;
    // 提到 try 外：并发落败时要用它们把设置改回指向自己这把（见函数末尾的胜者判定）。
    string keyPrefix;
    string encrypted;
    // 已经写出去了什么：签发不是一次写入，是三步（密钥文档 → 目录 → 设置）。
    // 中途失败时必须把前面写成功的收回去，否则会留下一把**启用着、却没人用得上**的 key：
    // 目录写失败 = 鉴权查不到它；设置写失败 = 明文已经丢了、没人再知道它是什么。
    // 两种都会在接入密钥页上越积越多，而每次重试又添一把。
    string? insertedKeyId = null;
    var directoryInserted = false;
    try
    {
        var secretBytes = RandomNumberGenerator.GetBytes(32);
        plainKey = "gwk_" + Convert.ToBase64String(secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        keyPrefix = plainKey[..Math.Min(plainKey.Length, 12)];
        var keyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plainKey))).ToLowerInvariant();
        newKeyId = Guid.NewGuid().ToString("N");
        var keyNow = DateTime.UtcNow;
        encrypted = GwApiKeyCrypto.Encrypt(plainKey, builder.Configuration);
        await serviceKeys.InsertOneAsync(new BsonDocument
        {
            { "_id", newKeyId },
            { "TenantId", tenantId },
            { "TeamId", effectiveTeamId },
            { "Name", SystemServiceKeyName },
            { "KeyPrefix", keyPrefix },
            { "KeyHash", keyHash },
            // CreatedByUserId 必须留空：serving 的生命周期门在这个字段非空时会去查
            // 「这个人的成员资格还活着吗」，活不了就 GATEWAY_KEY_OWNER_INACTIVE。
            // 这把 key 属于系统、不属于任何人——挂到某个人名下就等于把「这个人还在不在职」
            // 变成系统功能能不能用的前提，正是本次要消除的那类脆弱依赖。
            // 触发者只记进 TriggeredByUsername 供审计追溯，不参与鉴权。
            { "CreatedByUserId", BsonNull.Value },
            { "CreatedByUsername", "system" },
            { "TriggeredByUsername", actorUsername.Length > 0 ? actorUsername : "system" },
            { "Enabled", true },
            { "SourceSystem", SystemServiceKeySource },
            { "ClientCode", SystemServiceKeyClientCode },
            { "Environment", "production" },
            { "Purpose", "external-platform" },
            { "AppCallerCodes", new BsonArray(new[] { SystemIntentDraftAppCaller }) },
            { "IngressProtocols", new BsonArray(new[] { "openai-compatible" }) },
            { "Scopes", new BsonArray(new[] { "invoke", "stream:invoke", "route:read" }) },
            { "AllowedCidrs", new BsonArray() },
            { "RateLimitPerMinute", 120 },
            { "RotatesKeyId", BsonNull.Value },
            { "PredecessorRotationState", BsonNull.Value },
            { "RotatedByKeyId", BsonNull.Value },
            { "RotationState", "active" },
            // 必须是 "issued"：接入密钥页的列表只取 IssuanceState 缺失或等于 issued 的文档，
            // 写别的值（比如 "delivered"）这把 key 就在页面上彻底看不见——
            // 而「看得到系统替你配了什么」正是这一整套设计的前提。
            { "IssuanceState", "issued" },
            { "SystemManaged", true },
            { "ExpiresAt", BsonNull.Value },
            { "CreatedAt", keyNow },
            { "UpdatedAt", keyNow },
        });
        insertedKeyId = newKeyId;
        await serviceKeyDirectory.InsertOneAsync(new BsonDocument
        {
            { "_id", newKeyId },
            { "KeyHash", keyHash },
            { "TenantId", tenantId },
            { "ServiceKeyId", newKeyId },
            { "CreatedAt", keyNow },
        });
        directoryInserted = true;
        await systemSettings.UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", tenantId),
            Builders<BsonDocument>.Update
                .SetOnInsert("TenantId", tenantId)
                // 不再往设置里写 TeamId：归属团队由 EnsureSystemTeamAsync 现算，
                // 留一份可能过期的拷贝在库里，下一个人就会分不清哪份才作数。
                .Set("ServiceKeyId", newKeyId)
                .Set("ServiceKeyEncrypted", encrypted)
                .Set("ServiceKeyPrefix", keyPrefix)
                .Set("ServiceKeyIssuedAt", keyNow)
                .Set("UpdatedAt", keyNow),
            new UpdateOptions { IsUpsert = true });
    }
    catch (Exception ex)
    {
        // 回滚已经写出去的那几步。清理本身再失败也不能盖住原始错误——用户要看的是
        // 「为什么签不出来」，不是「清理时又出了什么事」，所以这里只吞不报。
        if (insertedKeyId is not null)
        {
            try
            {
                if (directoryInserted)
                    await serviceKeyDirectory.DeleteOneAsync(Builders<BsonDocument>.Filter.Eq("_id", insertedKeyId));
                await serviceKeys.DeleteOneAsync(Builders<BsonDocument>.Filter.Eq("_id", insertedKeyId));
            }
            catch (Exception cleanupError)
            {
                app.Logger.LogWarning(
                    cleanupError,
                    "[SystemKey] 签发失败后的回滚没做干净，可能留下一把无法使用的密钥：{KeyId}",
                    insertedKeyId);
            }
        }
        return (false, baseUrl, "", SystemIntentDraftAppCaller, poolId, model,
            $"系统级密钥自动签发失败（{ex.GetType().Name}）。多数情况是 ApiKeyCrypto:Secret 没注入到 llmgw 容器，密文无法写入。");
    }

    // 旧的系统级 key 一律停用：只留一把在用，避免密钥页越积越多、也避免撤销时认错对象。
    //
    // 两条约束合起来才挡得住并发，缺一条都不够：
    //
    // 1) 留哪一把认的是**设置里此刻指着的那把**，不是「我刚签的这把」。
    // 2) 只停用**够老的**（5 分钟前就存在的）key。
    //
    // 只做第 1 条仍然会翻车：A 回读到 A、B 回读到 B，接着 B 把 A 停了、A 把 B 停了，
    // 最后两把都停用、设置还指着其中一把——回读与停用之间没有原子性，这正是上一版漏掉的。
    // 加上第 2 条之后就不需要锁了：设置指向的那把永远是刚签出来的（秒级新），
    // 而并发对手的 key 同样新，谁也够不着谁；真正的陈旧 key 会在下一次签发时被扫掉。
    // 代价是并发落败的那把会多留 5 分钟（页面上多一行、且它不被任何人引用），
    // 比「两把都停用、系统对自己回 401」这种状态好得多。
    var settledSettings = await LoadSystemSettingsAsync(tenantId);
    var winnerKeyId = settledSettings.AsNullableString("ServiceKeyId") ?? newKeyId;
    var effectiveKey = plainKey;
    if (!string.Equals(winnerKeyId, newKeyId, StringComparison.Ordinal))
    {
        // 输了这一轮：设置指向对方那把。密文就在设置里，解出来直接用对方的，
        // 别把一把马上要被停用的 key 交出去——那样调用方还得先失败一次才自愈。
        var winnerKey = GwApiKeyCrypto.Decrypt(settledSettings.AsNullableString("ServiceKeyEncrypted"), builder.Configuration);
        if (winnerKey.Success && winnerKey.PlainText.Length > 0)
        {
            effectiveKey = winnerKey.PlainText;
        }
        else
        {
            // 对方的密文解不开（多半是 ApiKeyCrypto:Secret 轮换过），那就把设置改回指向自己这把，
            // 保住「设置指向的那把一定是启用的」这条不变量，别留下两把都不可用的状态。
            winnerKeyId = newKeyId;
            await systemSettings.UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", tenantId),
                Builders<BsonDocument>.Update
                    .Set("ServiceKeyId", newKeyId)
                    .Set("ServiceKeyEncrypted", encrypted)
                    .Set("ServiceKeyPrefix", keyPrefix)
                    .Set("UpdatedAt", DateTime.UtcNow));
        }
    }
    await RetireStaleSystemKeysAsync(tenantId, winnerKeyId);

    return (true, baseUrl, effectiveKey, SystemIntentDraftAppCaller, poolId, model, string.Empty);
}

/// <summary>
/// 把存量系统密钥作废：清掉 settings 里的引用并停用那把 key，下一次 Ensure 会重签。
///
/// 只在「重签能修好」的失败码上调用（见 IsSystemCredentialFixableCode）——
/// 租户停用、池没绑这类原因重签一万次也修不好，那样就成了自己修不好自己的循环。
/// </summary>
async Task InvalidateSystemCredentialAsync(string tenantId, string failedKey)
{
    var settings = await LoadSystemSettingsAsync(tenantId);
    // 只作废**刚才真的失败的那一把**。并发下两个请求可能都拿着 A 去调，第一个失败后已经
    // 重签成 B，第二个再进来时设置里已经是 B——不比对就会把好端端的 B 撤掉，
    // 第一个请求的重试反而拿到一把刚被撤销的 key，凭据自愈变成互相拆台。
    var current = GwApiKeyCrypto.Decrypt(settings.AsNullableString("ServiceKeyEncrypted"), builder.Configuration);
    if (!current.Success || !string.Equals(current.PlainText, failedKey, StringComparison.Ordinal))
        return;

    var staleKeyId = settings.AsNullableString("ServiceKeyId");
    var staleEncrypted = settings.AsNullableString("ServiceKeyEncrypted");
    if (!string.IsNullOrWhiteSpace(staleKeyId))
    {
        await serviceKeys.UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", staleKeyId),
                Builders<BsonDocument>.Filter.Eq("TenantId", tenantId)),
            Builders<BsonDocument>.Update.Set("Enabled", false).Set("RotationState", "revoked").Set("UpdatedAt", DateTime.UtcNow));
    }
    // 清设置这一步同样要认那把密文：上面比对完到这一句之间，别的请求可能已经重签并写进了 B。
    // 只按租户 id 清，就会把 B 一起抹掉——比对白做了，凭据自愈又变回互相拆台。
    // 写进谓词让库自己判：密文还是刚才那把才清，被人换过就一条也不动。
    await systemSettings.UpdateOneAsync(
        Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", tenantId),
            Builders<BsonDocument>.Filter.Eq("ServiceKeyEncrypted", staleEncrypted)),
        Builders<BsonDocument>.Update
            .Unset("ServiceKeyId")
            .Unset("ServiceKeyEncrypted")
            .Unset("ServiceKeyPrefix")
            .Set("UpdatedAt", DateTime.UtcNow));
}

// ── 调用用途码草案：把用户那句「我想做什么」交给网关自己的模型推成 {应用}.{用途}::{类型} ──
//
// 为什么走网关自己：控制台和 serving 在同一个部署里，这条路等于让网关吃自己的狗粮，
// 模型池、预算、日志全部落在既有链路上，不另起一套模型调用。
//
// 用哪个模型由「服务网关设置」决定，凭据由 EnsureSystemGatewayAccessAsync 自愈——
// 这一段不再读任何密钥类环境变量。serving 一时不通时返回**说得出原因**的错误，
// 前端退回本地关键词表并明说这是降级判定（no-rootless-tree：不假装模型给过意见）。
// 推导是短任务，40s 足够；超时就降级，不把控制台请求挂住。
// 40 秒是这条推导链路对用户的承诺（前端超过它就退回本地关键词表）。HttpClient.Timeout
// 只管到响应头为止——用 ResponseHeadersRead 流式读时，body 卡住它就不再兜底了，
// 所以读流那一段要用同一个数字另外拉一条 deadline，见 IntentDraftDeadline。
const int IntentDraftTimeoutSeconds = 40;
var intentDraftHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(IntentDraftTimeoutSeconds) };
const int IntentDraftMaxChars = 500;
// 产物是四个短字段的 JSON，256 token 绰绰有余；上限本身就是成本闸，不是性能调优。
const int IntentDraftMaxCompletionTokens = 256;
// 累积体积的第二道闸：上游若无视 max_tokens（不是所有协议都认），也不能让 raw 无限涨。
const int IntentDraftMaxRawChars = 4000;
// 上游失败文案的长度上限：内容保留（要可诊断），但不让它无限长地进 SSE。
const int IntentDraftMaxErrorChars = 200;
const string IntentDraftSystemPrompt = """
你是 LLM 网关的接入助手。用户用一句话说明他要接什么、要做什么，你把它压成调用用途码的两段。

app：谁在调用（哪个应用、设备或服务）。
feature：要做什么（哪种能力或业务场景）。

app 和 feature 两段都必须是小写英文 kebab-case：只允许 a-z、0-9 和短横线，必须字母开头，
各不超过 32 个字符。**这两段里出现任何中文字符都是错的**，即使用户那句话是中文——
你要做的是把中文语义翻成英文，不是照抄。也不要用拼音，不要把整句话塞进去。
requestType 只能是 chat 或 vision：涉及看图、识图、图片理解、截图、OCR 时用 vision，其余一律 chat。
reason 用中文写，这是唯一允许出现中文的字段。

只输出一个 JSON 对象，不要解释，不要代码块：
{"app":"...","feature":"...","requestType":"chat","reason":"一句中文，说明你从这句话的哪些词判出这两段"}

示例一，输入「接入小米音响，对接大模型网关指令集」，输出：
{"app":"xiaomi-speaker","feature":"command-parse","requestType":"chat","reason":"「小米音响」是调用方，「指令集」说明要把语音指令解析成结构化命令"}

示例二，输入「我们的运营后台要自动读发票图片上的金额」，输出：
{"app":"internal-tool","feature":"invoice-ocr","requestType":"vision","reason":"「运营后台」是调用方，「读发票图片」属于图片取字，所以判 vision"}

如果这句话确实说不清楚（既看不出谁在调用，也看不出要做什么），把 app 和 feature 留空，
并在 reason 里用一句中文说清还缺什么。不要编造。
""";

// ── 服务网关设置读端点：当前系统级模型、可选项、凭据状态、谁在用它 ──
//
// 只让用户做一个决定（用哪个池 / 哪个模型），其余全部由系统自己端出来：
// serving 地址、appCaller、密钥前缀都是「展示」不是「输入」（minimal-user-input）。
app.MapGet("/gw/system-settings", async (HttpContext http) =>
{
    var tenant = TenantAccess.GetRequired(http);
    var settings = await LoadSystemSettingsAsync(tenant.TenantId);
    var baseUrl = ResolveServingBaseUrl();

    var chatPools = await gwModelPools
        .Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
            Builders<BsonDocument>.Filter.Eq("ModelType", "chat")))
        .ToListAsync();
    // 逻辑模型库是跨租户共用一个集合的，所以这里必须和上面的池查询一样带上 TenantId：
    // 少这一条谓词，任何管理员打开这一页就会看到别的租户的模型名，还能选中它。
    var chatModelFilter = Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
        Builders<BsonDocument>.Filter.Eq("ModelType", "chat"),
        Builders<BsonDocument>.Filter.Ne("Enabled", false));
    /*
      关键字：第 201 条之后的模型必须有办法选到。

      只截前 200 条而不给筛选，等于「排在 200 名之后的模型在这一页根本不存在」——
      页面不会报错，下拉里就是没有它，用户只能以为系统不支持。截断是为了不把整库
      端到前端，那就得同时给一条够得着剩下那些的路，并如实说还剩多少条没列出来。
    */
    var modelQuery = (http.Request.Query["q"].ToString() ?? string.Empty).Trim();
    if (modelQuery.Length > 100) modelQuery = modelQuery[..100];
    var chatModelQueryFilter = modelQuery.Length == 0
        ? chatModelFilter
        : Builders<BsonDocument>.Filter.And(
            chatModelFilter,
            Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Regex("PublicIdNormalized", new BsonRegularExpression(System.Text.RegularExpressions.Regex.Escape(modelQuery.ToLowerInvariant()), "i")),
                Builders<BsonDocument>.Filter.Regex("Name", new BsonRegularExpression(System.Text.RegularExpressions.Regex.Escape(modelQuery), "i"))));
    const int ChatModelPageSize = 200;
    // 排序固定：不排序的 200 条是「随便哪 200 条」，同一个租户两次打开可能给出不同的清单。
    var chatModels = await gwLogicalModels
        .Find(chatModelQueryFilter)
        .Sort(Builders<BsonDocument>.Sort.Ascending("PublicIdNormalized").Ascending("_id"))
        .Limit(ChatModelPageSize)
        .ToListAsync();
    // 命中总数用来如实说「还有多少条没列出来」。只有真截断了才去数，平时不多跑一次 count。
    var chatModelTotal = chatModels.Count < ChatModelPageSize
        ? chatModels.Count
        : (int)Math.Min(int.MaxValue, await gwLogicalModels.CountDocumentsAsync(chatModelQueryFilter));
    // 已保存的那个必须在清单里，哪怕它排在 200 条之外：否则下拉里没有对应选项，
    // 页面看起来像「没选模型」，而系统调用仍在用那个看不见的模型。
    var savedModelName = settings.AsNullableString("ModelName");
    if (!string.IsNullOrWhiteSpace(savedModelName)
        && !chatModels.Any(d => string.Equals(d.GetStringOrEmpty("PublicId"), savedModelName, StringComparison.Ordinal)))
    {
        var savedModel = await gwLogicalModels
            .Find(Builders<BsonDocument>.Filter.And(
                chatModelFilter,
                Builders<BsonDocument>.Filter.Or(
                    Builders<BsonDocument>.Filter.Eq("PublicId", savedModelName),
                    Builders<BsonDocument>.Filter.Eq("PublicIdNormalized", savedModelName.ToLowerInvariant()))))
            .FirstOrDefaultAsync();
        if (savedModel is not null) chatModels.Insert(0, savedModel);
    }

    var keyId = settings.AsNullableString("ServiceKeyId");
    var keyDoc = string.IsNullOrWhiteSpace(keyId)
        ? null
        : await serviceKeys.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", keyId),
            Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId))).FirstOrDefaultAsync();
    // 归属团队不是「设置里选的」，是系统团队，读这一页时顺手把它建好——
    // 于是用户在页面上看到的名字，就是下一次真实调用会记账的那个团队。
    var systemTeamId = await EnsureSystemTeamAsync(tenant.TenantId);
    if (systemTeamId.Length == 0)
        return Json(ApiEnvelope<object>.Fail(
            "SYSTEM_TEAM_NAME_TAKEN",
            $"「{SystemTeamName}」这个名字已被业务团队占用，备用名也都被占，系统团队建不出来。去「团队与成员」把那个同名团队改个名字再回来。"), jsonOptions, 409);
    var teamDoc = await teams.Find(x => x.Id == systemTeamId && x.TenantId == tenant.TenantId).FirstOrDefaultAsync();
    // 与 EnsureSystemGatewayAccessAsync 同一个判据 + 同一条目录行检查：
    // 页面上的「就绪」必须与「下一次调用会不会重签」说的是同一件事。
    var systemKeyUsableNow = keyDoc is not null
        && SystemKeyIsUsableNow(
            keyDoc,
            settings.AsNullableString("ServiceKeyEncrypted"),
            systemTeamId,
            SystemServiceKeySource,
            SystemIntentDraftAppCaller,
            builder.Configuration)
        && await SystemKeyHasDirectoryRowAsync(serviceKeyDirectory, tenant.TenantId, keyId!);

    return Json(ApiEnvelope<object>.Ok(new
    {
        modelSource = settings.AsNullableString("ModelSource") ?? "auto",
        modelGroupId = settings.AsNullableString("ModelGroupId"),
        modelName = settings.AsNullableString("ModelName"),
        teamId = teamDoc?.Id ?? systemTeamId,
        teamName = teamDoc?.Name ?? SystemTeamName,
        // 这个团队是系统自己的，不由用户挑：消耗、权限、账单都单独记在它名下。
        teamIsSystemOwned = true,
        servingBaseUrl = baseUrl,
        servingReachable = baseUrl.Length > 0,
        appCallerCode = SystemIntentDraftAppCaller,
        // 密钥只回前缀指纹，永不回明文——它是系统自己在用的凭据，不下发给浏览器。
        // 「就绪」必须与调用路径同一个判据：只看 Enabled 的话，加密密钥轮换过、目录行丢了、
        // 或 key 已经不合闸之后这里照样写「就绪」，而下一次真调用当场重签或直接失败。
        credentialState = keyDoc is null
            ? "will-issue"
            : systemKeyUsableNow ? "ready" : "will-reissue",
        credentialPrefix = keyDoc?.AsNullableString("KeyPrefix") ?? settings.AsNullableString("ServiceKeyPrefix"),
        credentialIssuedAt = settings.AsNullableString("ServiceKeyIssuedAt"),
        pools = chatPools.Select(x => new
        {
            id = x.GetStringOrEmpty("_id"),
            name = x.AsNullableString("Name") ?? x.GetStringOrEmpty("_id"),
            isDefault = x.AsNullableBool("IsDefaultForType") == true,
        }).ToList(),
        // publicId 才是调用时真正要提交的标识：解析器只认 PublicId / PublicIdNormalized，
        // Name 只是给人看的显示名。两者可以不同，所以必须分成两个字段回，
        // 否则页面把显示名当模型名存下去，解析时匹配不上、悄悄落到别的默认模型。
        models = chatModels.Select(x => new
        {
            id = x.GetStringOrEmpty("_id"),
            publicId = x.AsNullableString("PublicId") ?? x.GetStringOrEmpty("_id"),
            name = x.AsNullableString("Name") ?? x.AsNullableString("PublicId") ?? x.GetStringOrEmpty("_id"),
        }).ToList(),
        // 这次筛选命中多少条、回了多少条。前端据此如实说「还有 N 条没列出，输关键字筛」，
        // 而不是让用户以为剩下那些模型不存在。
        modelQuery,
        modelTotal = chatModelTotal,
        modelPageSize = ChatModelPageSize,
        // 「谁在用它」：让用户知道改这一项会影响什么，而不是改完不知道动了谁。
        consumers = new[]
        {
            new { feature = "Quickstart · 一句话推导调用用途码", appCallerCode = SystemIntentDraftAppCaller },
        },
    }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 保存系统级模型选择。只接三个字段，其余一律系统自己决定。
app.MapPut("/gw/system-settings", async (HttpContext http, [FromBody] UpdateSystemSettingsRequest? body) =>
{
    var tenant = TenantAccess.GetRequired(http);
    var modelSource = (body?.ModelSource ?? "auto").Trim().ToLowerInvariant();
    if (!systemModelSources.Contains(modelSource))
        return Json(ApiEnvelope<object>.Fail("INVALID_MODEL_SOURCE", "modelSource 只支持 auto、pool、model"), jsonOptions, 400);

    var modelGroupId = (body?.ModelGroupId ?? string.Empty).Trim();
    var modelName = (body?.ModelName ?? string.Empty).Trim();
    if (modelSource == "pool")
    {
        if (modelGroupId.Length == 0)
            return Json(ApiEnvelope<object>.Fail("MODEL_POOL_REQUIRED", "选择「模型池」时必须指定一个池"), jsonOptions, 400);
        var poolExists = await gwModelPools.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", modelGroupId),
            Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
            // 读端点只列 chat 池，写端点也要判一次：钉一个别的类型的池，系统调用同样解析不到，
            // 一样会静默落回默认池。
            Builders<BsonDocument>.Filter.Eq("ModelType", "chat"))) == 1;
        if (!poolExists)
            return Json(ApiEnvelope<object>.Fail(
                "MODEL_POOL_NOT_FOUND",
                "指定的模型池在当前租户下不可用（不存在或不是对话类）。回到「服务网关设置」重选一个。"), jsonOptions, 404);
        // 池在不在只是第一层。池路由退场之后，认池 ID 的唯一一条路是它已经搬成了对外模型
        // （MigratedFromPoolIds）；没搬过的池存得进去、页面显示正常，而每一次系统调用都
        // MODEL_NOT_FOUND。判据与取用时、与运行时同一处，不许这里松那里紧。
        if (!await SystemPoolResolvableAsync(tenant.TenantId, modelGroupId))
            return Json(ApiEnvelope<object>.Fail(
                "MODEL_POOL_NOT_MIGRATED",
                "这个模型池还没有搬成对外模型，选了也解析不到（池路由已经退场）。"
                + "改选「指定模型」——那一栏列的就是能解析到的对外模型。"
                + "（这个池要继续用的话得先搬成对外模型，而控制台目前没有这个入口，"
                + "只有接口 POST /gw/pools/migrate-to-models，已记台账。）"), jsonOptions, 409);
    }
    if (modelSource == "model")
    {
        if (modelName.Length == 0)
            return Json(ApiEnvelope<object>.Fail("MODEL_NAME_REQUIRED", "选择「指定模型」时必须选一个模型"), jsonOptions, 400);
        // 和池一样按租户校验，并且认的是 PublicId：读端点只列本租户的模型，
        // 写端点也必须自己判一次，否则直接构造请求就能把别的租户的模型钉进来；
        // 认 PublicId 也保证存下去的值就是解析器会去匹配的那个值。
        // 谓词必须与**读端点和运行时**同口径（本租户 + chat + 未停用）。少这两条时，
        // 页面加载之后被停用、或类型被改走的模型仍能存进去；下一次系统调用解析不到它，
        // 就静默落回默认池——设置页说着 A，实际跑的是 B，而测试连接还会报成功。
        var modelExists = await gwLogicalModels.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenant.TenantId),
            Builders<BsonDocument>.Filter.Eq("ModelType", "chat"),
            Builders<BsonDocument>.Filter.Ne("Enabled", false),
            Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Eq("PublicId", modelName),
                Builders<BsonDocument>.Filter.Eq("PublicIdNormalized", modelName.ToLowerInvariant())))) > 0;
        if (!modelExists)
            return Json(ApiEnvelope<object>.Fail(
                "MODEL_NOT_FOUND",
                "指定的逻辑模型在当前租户下不可用（不存在、已停用，或已不是对话类）。回到「服务网关设置」重选一个。"), jsonOptions, 404);
    }

    // 归属团队不接受写入：系统消耗恒记在系统团队（EnsureSystemTeamAsync）。
    // 留一个能改归属的字段，等于留一条把系统账单混进业务团队的路。
    var now = DateTime.UtcNow;
    var update = Builders<BsonDocument>.Update
        .SetOnInsert("TenantId", tenant.TenantId)
        .Set("ModelSource", modelSource)
        .Set("ModelGroupId", modelSource == "pool" ? (BsonValue)modelGroupId : BsonNull.Value)
        .Set("ModelName", modelSource == "model" ? (BsonValue)modelName : BsonNull.Value)
        .Set("UpdatedAt", now)
        .Set("UpdatedByUsername", tenant.Username);
    await systemSettings.UpdateOneAsync(
        Builders<BsonDocument>.Filter.Eq("_id", tenant.TenantId),
        update,
        new UpdateOptions { IsUpsert = true });

    await WriteOperationAuditAsync(
        operationAudits, http, "system_settings.update", "llmgw_system_settings", tenant.TenantId, "服务网关设置", true, null,
        new BsonDocument { { "modelSource", modelSource }, { "modelGroupId", modelGroupId }, { "modelName", modelName } });

    return Json(ApiEnvelope<object>.Ok(new { modelSource, modelGroupId, modelName }), jsonOptions);
}).RequireAuthorization("ConfigWrite");

// 当场自测：确保凭据 + 真发一次极短对话，把成败、耗时、模型和失败原因端回来。
// minimal-user-input 的连带义务——用户少填的每一项，系统都欠他一个「我配了什么、对不对」。
app.MapPost("/gw/system-settings/test", async (HttpContext http) =>
{
    var tenant = TenantAccess.GetRequired(http);
    var startedAt = DateTime.UtcNow;

    // 「测试连接」必须是**一键修好**，不是「一键告诉你再点一次」：
    // 第一次被网关以凭据类原因拒绝时，就地作废那把 key、重签一把、立刻重试。
    // 最多两轮——第二轮还败就是重签修不好的原因，如实报出来。
    async Task<IResult> RunAsync(bool allowReissue)
    {
    var access = await EnsureSystemGatewayAccessAsync(tenant.TenantId, tenant.Username);
    if (!access.Ok)
    {
        return Json(ApiEnvelope<object>.Ok(new
        {
            ok = false,
            stage = "credential",
            elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
            message = access.Error,
        }), jsonOptions);
    }

    try
    {
        using var probe = new HttpRequestMessage(HttpMethod.Post, $"{access.BaseUrl}/v1/chat/completions")
        {
            Content = new StringContent(JsonSerializer.Serialize(new
            {
                model = access.Model,
                stream = false,
                messages = new object[] { new { role = "user", content = "只回复 OK 两个字符" } },
            }, jsonOptions), Encoding.UTF8, "application/json"),
        };
        probe.Headers.TryAddWithoutValidation("X-Gateway-Key", access.Key);
        probe.Headers.TryAddWithoutValidation("X-Gateway-App-Caller", access.AppCaller);
        probe.Headers.TryAddWithoutValidation("X-Gateway-Source", SystemServiceKeySource);
        // 钉池必须同时声明策略：serving 按 body 里的 model 推策略，而这两条请求的 model 恒是
        // 「auto」——非空，于是被推成 pinned；而 ModelPoolId 只在策略是 pool 时才会顶替
        // ExpectedModel 进入解析。少这一行，选中的池只会进日志上下文，真正跑的仍是
        // appCaller 绑定或默认池——设置页说着这个池，实际跑的是另一个（选 A 给 B）。
        if (!string.IsNullOrWhiteSpace(access.PoolId))
        {
            probe.Headers.TryAddWithoutValidation("X-Gateway-Model-Pool-Id", access.PoolId);
            probe.Headers.TryAddWithoutValidation("X-Gateway-Model-Policy", "pool");
        }

        using var response = await intentDraftHttp.SendAsync(probe, http.RequestAborted);
        var elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
        if (!response.IsSuccessStatusCode)
        {
            var (detail, failureCode) = await ReadGatewayFailureDetailAsync(response, http.RequestAborted);
            if (allowReissue && IsSystemCredentialFixableCode(failureCode))
            {
                await InvalidateSystemCredentialAsync(tenant.TenantId, access.Key);
                return await RunAsync(false);
            }
            return Json(ApiEnvelope<object>.Ok(new { ok = false, stage = "invoke", elapsedMs, message = detail }), jsonOptions);
        }
        var payload = await response.Content.ReadAsStringAsync(http.RequestAborted);
        var servedModel = string.Empty;
        try
        {
            using var doc = JsonDocument.Parse(payload);
            if (doc.RootElement.TryGetProperty("model", out var modelEl) && modelEl.ValueKind == JsonValueKind.String)
                servedModel = modelEl.GetString() ?? string.Empty;
        }
        catch (JsonException) { /* 成功但返回体不是标准 JSON，不影响结论 */ }
        return Json(ApiEnvelope<object>.Ok(new
        {
            ok = true,
            stage = "done",
            elapsedMs,
            servedModel,
            message = $"通了：{elapsedMs} ms 内拿到回复{(servedModel.Length > 0 ? $"，实际执行的是 {servedModel}" : string.Empty)}。",
        }), jsonOptions);
    }
    catch (Exception ex)
    {
        return Json(ApiEnvelope<object>.Ok(new
        {
            ok = false,
            stage = "invoke",
            elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
            message = $"连不上网关服务（{ex.GetType().Name}）。确认 llmgw-serve 容器在运行，且 {access.BaseUrl} 在容器网络内可达。",
        }), jsonOptions);
    }
    }

    return await RunAsync(true);
}).RequireAuthorization("ConfigWrite");

// 用户那句话 → 调用用途码草案。SSE 边推边吐，等待期屏幕一直在变（规则 #6）。
// 只读不写：这里不落任何库，草案由用户确认后才走 POST /gw/app-callers 正式登记。
app.MapPost("/gw/app-callers/draft", async (HttpContext http, [FromBody] DraftAppCallerRequest body) =>
{
    var intent = (body?.Intent ?? string.Empty).Trim();
    http.Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
    http.Response.Headers["Cache-Control"] = "no-cache";
    http.Response.Headers["X-Accel-Buffering"] = "no";

    async Task SendAsync(object frame)
    {
        await http.Response.WriteAsync($"data: {JsonSerializer.Serialize(frame, jsonOptions)}\n\n", http.RequestAborted);
        await http.Response.Body.FlushAsync(http.RequestAborted);
    }

    if (intent.Length == 0 || intent.Length > IntentDraftMaxChars)
    {
        await SendAsync(new { type = "error", code = "INTENT_INVALID", message = $"请写一句话说明要做什么（不超过 {IntentDraftMaxChars} 字）。" });
        return;
    }
    // 凭据与模型选择都来自系统级设置；缺什么就说缺什么，不把裸状态码丢给用户。
    var tenantAccess = TenantAccess.GetRequired(http);
    var access = await EnsureSystemGatewayAccessAsync(tenantAccess.TenantId, tenantAccess.Username);
    if (!access.Ok)
    {
        await SendAsync(new { type = "error", code = "INTENT_DRAFT_UNAVAILABLE", message = $"{access.Error}已退回本地关键词判定。" });
        return;
    }

    await SendAsync(new { type = "stage", stage = "connecting", text = "正在把这句话交给网关自己的模型" });
    var raw = new StringBuilder();
    var usedModel = string.Empty;
    // 这条流「收完了」有两种成立方式：收到 [DONE]，或我方主动到顶收工（下面的体积闸）。
    // 两个都没有就是 EOF 提前到了——serving 的取消路径正是这样：既不发失败帧也不发 [DONE]，
    // 直接把响应关掉。不区分的话，模型在断流前恰好吐出一段可解析 JSON 时，
    // 这个端点会把一次被取消/截断的**计费**调用当成成功的推导结果交出去。
    var streamCompleted = false;
    // 整条推导（含流式读）共用一个 deadline。只挂 http.RequestAborted 的话，serving 把响应头
    // 发回来之后再卡住，HttpClient.Timeout 已经不管事、ReadLineAsync 又只在浏览器断开时才醒，
    // 于是这一屏会无限停在「模型正在推导」——承诺的 40 秒兜底静默失效。
    using var draftDeadline = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);
    draftDeadline.CancelAfter(TimeSpan.FromSeconds(IntentDraftTimeoutSeconds));
    var draftCt = draftDeadline.Token;
    try
    {
        // 两轮：第一轮撞上凭据类拒绝就地重签、原样再来一次，第二轮才允许把失败告诉用户。
        // 用户要的是「系统内部永远不会出现 401」——不能让他先看见一次降级判定再说。
        for (var attempt = 1; ; attempt++)
        {
            using var upstream = new HttpRequestMessage(HttpMethod.Post, $"{access.BaseUrl}/v1/chat/completions")
            {
                Content = new StringContent(JsonSerializer.Serialize(new
                {
                    model = access.Model,
                    stream = true,
                    // 期望产物只是四个字段的 JSON，给一个紧的上限：这条链路花的是平台的钱
                    // （系统 appCaller 没有预算闸、密钥每分钟允许 120 次），模型若没有自带
                    // 小上限，一次注入式的长 intent 就能让它一直生成到 40 秒 deadline。
                    max_tokens = IntentDraftMaxCompletionTokens,
                    // 不发 temperature：池里选到的模型可能只接受默认值，实测发 0 会被上游 400
                    // 回「temperature does not support 0 with this model」。推导要的确定性靠
                    // 提示词里的「只输出 JSON」约束，不靠采样参数。
                    messages = new object[]
                    {
                        new { role = "system", content = IntentDraftSystemPrompt },
                        new { role = "user", content = intent },
                    },
                }, jsonOptions), Encoding.UTF8, "application/json"),
            };
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Key", access.Key);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-App-Caller", access.AppCaller);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Source", SystemServiceKeySource);
            // 钉池必须同时声明策略：serving 按 body 里的 model 推策略，而这两条请求的 model 恒是
            // 「auto」——非空，于是被推成 pinned；而 ModelPoolId 只在策略是 pool 时才会顶替
            // ExpectedModel 进入解析。少这一行，选中的池只会进日志上下文，真正跑的仍是
            // appCaller 绑定或默认池——设置页说着这个池，实际跑的是另一个（选 A 给 B）。
            if (!string.IsNullOrWhiteSpace(access.PoolId))
            {
                upstream.Headers.TryAddWithoutValidation("X-Gateway-Model-Pool-Id", access.PoolId);
                upstream.Headers.TryAddWithoutValidation("X-Gateway-Model-Policy", "pool");
            }

            using var response = await intentDraftHttp.SendAsync(upstream, HttpCompletionOption.ResponseHeadersRead, draftCt);
            if (!response.IsSuccessStatusCode)
            {
                // 裸状态码对用户毫无意义（他会问「系统就是网关，还 401?」），所以翻译成能行动的一句话。
                var (detail, failureCode) = await ReadGatewayFailureDetailAsync(response, draftCt);
                // 凭据类失败当场作废那把 key，并在同一次请求里重签、重试，用户那侧看不见这次失败。
                if (IsSystemCredentialFixableCode(failureCode))
                {
                    await InvalidateSystemCredentialAsync(tenantAccess.TenantId, access.Key);
                    if (attempt == 1)
                    {
                        var reissued = await EnsureSystemGatewayAccessAsync(tenantAccess.TenantId, tenantAccess.Username);
                        if (reissued.Ok)
                        {
                            access = reissued;
                            await SendAsync(new { type = "stage", stage = "connecting", text = "系统凭据已自动重签，正在重试" });
                            continue;
                        }
                    }
                }
                await SendAsync(new { type = "error", code = "INTENT_DRAFT_UNAVAILABLE", message = $"{detail}已退回本地关键词判定。" });
                return;
            }
            await SendAsync(new { type = "stage", stage = "thinking", text = "模型正在推导两段码" });
            using var body2 = await response.Content.ReadAsStreamAsync(draftCt);
            using var reader = new StreamReader(body2, Encoding.UTF8);
            // 不用 EndOfStream 当循环条件：它会先做一次**同步**读去探有没有下一个字节，
            // 而那次读收不到 deadline 令牌。serving 把响应头发回来之后停住不再吐 body 时，
            // 请求就卡在那次同步读里，40 秒的承诺又一次静默失效——判据要挂在可取消的读上，
            // 读回 null 才是 EOF。
            while (!draftCt.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(draftCt);
                if (line is null) break;
                if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
                var payload = line[5..].Trim();
                if (payload == "[DONE]") { streamCompleted = true; continue; }
                if (payload.Length == 0) continue;
                try
                {
                    using var doc = JsonDocument.Parse(payload);
                    var root = doc.RootElement;
                    if (root.TryGetProperty("model", out var modelEl) && modelEl.ValueKind == JsonValueKind.String && usedModel.Length == 0)
                        usedModel = modelEl.GetString() ?? string.Empty;
                    // 上游在响应头之后才失败时，HTTP 已经是 200，失败只能夹在流里回来
                    // （finishReason=error + 顶层 error）。不认它的话，模型若在失败前已吐出
                    // 一段可解析的 JSON，这个端点会对一次**失败且计费**的调用回 ok:true。
                    if (TryReadIntentDraftStreamError(root, out var streamFailure))
                    {
                        await SendAsync(new { type = "error", code = "INTENT_DRAFT_UNAVAILABLE", message = $"{streamFailure}已退回本地关键词判定。" });
                        return;
                    }
                    if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0) continue;
                    var delta = choices[0];
                    if (!delta.TryGetProperty("delta", out var deltaEl)) continue;
                    if (!deltaEl.TryGetProperty("content", out var contentEl) || contentEl.ValueKind != JsonValueKind.String) continue;
                    var text = contentEl.GetString() ?? string.Empty;
                    if (text.Length == 0) continue;
                    if (raw.Length + text.Length > IntentDraftMaxRawChars)
                    {
                        // 到顶就收工：已经拿到的片段照常去解析（多半够了），不再继续收。
                        // 这是我方主动停的，不是流断了，所以按「收完了」计——否则下面的完成判定
                        // 会把一次正常到顶的推导误判成截断。
                        raw.Append(text.AsSpan(0, Math.Max(0, IntentDraftMaxRawChars - raw.Length)));
                        streamCompleted = true;
                        break;
                    }
                    raw.Append(text);
                    await SendAsync(new { type = "delta", text });
                }
                catch (JsonException) { /* 上游偶发非 JSON 心跳帧，跳过 */ }
            }
            break;
        }
    }
    catch (OperationCanceledException)
    {
        // 浏览器自己走了就静默收工；是我们的 deadline 到点，就得说清楚——
        // 用户那侧正看着「模型正在推导」，不给这一句他会一直等下去。
        if (http.RequestAborted.IsCancellationRequested) return;
        await SendAsync(new
        {
            type = "error",
            code = "INTENT_DRAFT_UNAVAILABLE",
            message = $"推导超过 {IntentDraftTimeoutSeconds} 秒没有返回，已退回本地关键词判定。",
        });
        return;
    }
    catch (Exception ex)
    {
        await SendAsync(new { type = "error", code = "INTENT_DRAFT_UNAVAILABLE", message = $"推导模型调用失败（{ex.GetType().Name}），已退回本地关键词判定。" });
        return;
    }

    // 没有完成标记就不许把这段文本当成模型的结论：它可能只是被取消/截断的前半截，
    // 而前半截恰好可解析时（`{"app":"x","feature":"y",...` 少了尾巴仍可能被容错解析器接受）
    // 用户会拿到一个看起来正常、其实来自一次失败调用的推导结果。
    if (!streamCompleted)
    {
        await SendAsync(new
        {
            type = "error",
            code = "INTENT_DRAFT_UNAVAILABLE",
            message = "推导的返回在中途断了（没有收到结束标记），已退回本地关键词判定。",
        });
        return;
    }

    var parsed = ParseIntentDraft(raw.ToString());
    if (parsed is null)
    {
        await SendAsync(new { type = "error", code = "INTENT_DRAFT_UNPARSABLE", message = "模型没有给出可用的两段码，已退回本地关键词判定。" });
        return;
    }
    var draftCode = $"{parsed.Value.App}.{parsed.Value.Feature}::{parsed.Value.RequestType}";
    var valid = parsed.Value.App.Length > 0
                && parsed.Value.Feature.Length > 0
                && IsValidSelfServiceAppCaller(draftCode, parsed.Value.RequestType);
    await SendAsync(new
    {
        type = "result",
        ok = valid,
        app = parsed.Value.App,
        feature = parsed.Value.Feature,
        requestType = parsed.Value.RequestType,
        reason = parsed.Value.Reason,
        appCallerCode = valid ? draftCode : string.Empty,
        model = usedModel,
    });
}).RequireAuthorization("AppCallerWrite");

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
    if (!GatewayAppCallerCodePolicy.IsValidSelfService(appCallerCode, requestType))
    {
        return Json(ApiEnvelope<GatewayAppCallerItem>.Fail(
            "INVALID_APP_CALLER",
            "appCallerCode 必须使用小写 {app-key}.{feature}::{requestType} 格式，且后缀与受支持的 requestType 一致"), jsonOptions, 400);
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

    /*
      「查到一条同码记录，能不能原样交给调用方」——两条路径共用这一个判定：
      先查到的那条，以及插入撞唯一索引之后回读的胜者。

      为什么必须共用：这两条路径此前各写各的，先查到那条判了归属与状态，
      撞索引那条只判了归属。于是并发下的胜者是一条停用记录时，它会被当成
      「登记成功」原样返回，页面接着为它签一把 key，而 serving 当场回
      APP_CALLER_DISABLED——同一个洞在同一个端点里开了两次，只因为判定抄了两份。
      判定只此一份，两条路径都从这里过（守卫钉住这两件事）。
    */
    IResult? RejectUnusableExistingAppCaller(BsonDocument candidate)
    {
        if (!string.Equals(candidate.AsNullableString("TeamId"), teamId, StringComparison.Ordinal))
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail(
                "APP_CALLER_IDENTITY_CONFLICT", "该 appCaller 已归属当前租户中的其他团队"), jsonOptions, 409);

        /*
          已存在但**不接流量**（停用 / 归档）时不许原样返回。

          调用方拿到这条身份的下一步就是用它签一把 key，而 serving 会当场回
          APP_CALLER_DISABLED——页面等于把一把注定用不了的钥匙交到用户手上。
          判定必须落在这里：这是全库唯一一次**精确**身份查询（AppCallerCode + RequestType，
          租户内、无分页），页面那边只能按 search 模糊搜一页，用途多过一页时根本搜不到它。
        */
        var candidateStatus = (candidate.AsNullableString("Status") ?? "discovered").Trim().ToLowerInvariant();
        if (!AppCallerAcceptsTraffic(candidateStatus))
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail(
                "APP_CALLER_DISABLED",
                $"调用用途「{appCallerCode}」已存在，但处于「{candidateStatus}」状态，不接受流量。"
                + "先去「调用用途」把它恢复，或换一个用途名——用它签出来的密钥一调用就会被拒。"), jsonOptions, 409);

        return null;
    }

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
        /*
          已存在但**不接流量**（停用 / 归档）时不许原样返回。

          调用方拿到这条身份的下一步就是用它签一把 key，而 serving 会当场回
          APP_CALLER_DISABLED——页面等于把一把注定用不了的钥匙交到用户手上。
          判定必须落在这里：这是全库唯一一次**精确**身份查询（AppCallerCode + RequestType，
          租户内、无分页），页面那边只能按 search 模糊搜一页，用途多过一页时根本搜不到它。
          与 serving 的 GatewayAppCallerPolicy 同一套枚举，列表写在这里是因为
          console-api 按既定架构不引用 PrdAgent.*（守卫钉住两侧一致）。
        */
        var rejection = RejectUnusableExistingAppCaller(existing);
        if (rejection is not null) return rejection;
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
        if (winner is null)
            return Json(ApiEnvelope<GatewayAppCallerItem>.Fail("APP_CALLER_IDENTITY_CONFLICT", "该 appCaller 已被并发创建，请刷新后重试"), jsonOptions, 409);
        // 胜者走与「先查到那条」完全相同的一道门：归属对不上、或它此刻不接流量，都不能算登记成功。
        var winnerRejection = RejectUnusableExistingAppCaller(winner);
        if (winnerRejection is not null) return winnerRejection;
        return Json(ApiEnvelope<GatewayAppCallerItem>.Ok(MapGatewayAppCaller(winner)), jsonOptions);
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
        gwLogicalModels,
        gwModelOfferings,
        gwMigrations,
        TenantAccess.GetRequired(http).TenantId,
        effectiveStatus,
        effectiveModelPoolId,
        effectiveModelPolicy,
        doc.GetStringOrEmpty("RequestType"),
        effectiveAllowedModelPoolIds,
        effectiveDefaultModelPoolId,
        doc.AsNullableString("AppCallerCode"));
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
        gwLogicalModels,
        gwModelOfferings,
        gwMigrations,
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

    var existingDocs = await gwModels.Find(TenantAccess.Filter(http, fb.Eq("PlatformId", id))).ToListAsync();
    var existing = existingDocs
        .Select(m => m.AsNullableString("ModelName") ?? string.Empty)
        .Where(x => x.Length > 0)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    /*
      「已导入」不等于「已登记」。

      能力认不出来的模型会被导入成物理模型、但不登白名单（认不出用途就不猜，见
      GatewayWhitelistPublishing.TryResolveModelType）。此时服务端给的下一步是
      「去模型页补能力，再重新导入一次」——可这一屏把「已导入」的行整个禁选了，
      那句话于是没法照做，用户只能手工去建对外模型和线路。
      自己给出的下一步必须走得通，所以这里把两件事分开报。

      判据是「有没有线路指向这个物理模型」，不是「有没有同名的对外模型」：
      同名可能是别人建的，而真正决定它能不能被调到的是那条线路。
    */
    var existingIdByName = existingDocs
        .Where(m => (m.AsNullableString("ModelName") ?? string.Empty).Length > 0)
        .GroupBy(m => m.AsNullableString("ModelName")!, StringComparer.OrdinalIgnoreCase)
        .ToDictionary(g => g.Key, g => g.First().GetStringOrEmpty("_id"), StringComparer.OrdinalIgnoreCase);
    var publishedTargetIds = existingIdByName.Count == 0
        ? new HashSet<string>(StringComparer.Ordinal)
        : (await gwModelOfferings.Find(TenantAccess.Filter(http, fb.And(
                fb.Eq("TargetKind", "model"),
                fb.In("TargetId", existingIdByName.Values.Where(x => x.Length > 0)))))
            .Project(Builders<BsonDocument>.Projection.Include("TargetId"))
            .ToListAsync())
            .Select(x => x.GetStringOrEmpty("TargetId"))
            .Where(x => x.Length > 0)
            .ToHashSet(StringComparer.Ordinal);
    var publishedNames = existingIdByName
        .Where(kv => publishedTargetIds.Contains(kv.Value))
        .Select(kv => kv.Key)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    // 8MB 的字节上限管不住**条目数**：几十万个 {"id":"x"} 这样的小对象照样塞得进那个预算，
    // 而下面这个循环会把每一条都物化成对象、再排序、再序列化，前端还要不做虚拟化地全渲染一遍——
    // 一次「查看模型」就能吃掉可观的共享内存并把用户浏览器冻住。限量必须按条目再来一道。
    //
    // 截断不静默：真发生时如实告诉用户「上游给了 N 个，只展示前 M 个」，
    // 而不是让他以为这就是全部（no silent caps）。
    var truncatedFrom = dataArray.Count > MaxDiscoveredModels ? dataArray.Count : (int?)null;

    // 补登的那批现查现用：补完刷新这一屏就能看见「已登记」，不用等任何缓存。
    var catalogOverrides = await LoadCatalogOverridesAsync(http);
    var items = new List<UpstreamModelItem>();
    foreach (var node in dataArray.Take(MaxDiscoveredModels))
    {
        if (node is not System.Text.Json.Nodes.JsonObject obj) continue;
        var modelId = (obj["id"] as System.Text.Json.Nodes.JsonValue)?.ToString();
        if (string.IsNullOrWhiteSpace(modelId)) continue;
        var pricing = ProviderPresets.ReadPricing(obj);
        // 用途优先查内置名录，查不到才退回上游声明 / 关键词猜测，并把来源如实带给前端：
        // 「猜出来的用途」曾经和「查出来的用途」长得一模一样，用户没有任何办法分辨该不该信。
        var declared = (obj["capabilities"] as System.Text.Json.Nodes.JsonArray)?
            .Select(n => (n as System.Text.Json.Nodes.JsonValue)?.ToString() ?? string.Empty)
            .Where(x => x.Length > 0).ToList();
        var resolved = ModelCatalog.ResolveCapabilities(modelId, declared, catalogOverrides);
        var catalogEntry = ModelCatalog.Find(modelId, catalogOverrides);
        items.Add(new UpstreamModelItem
        {
            ModelId = modelId,
            DisplayName = (obj["name"] as System.Text.Json.Nodes.JsonValue)?.ToString(),
            InferredCapabilities = resolved.Capabilities.ToList(),
            CapabilitySource = resolved.Source,
            InCatalog = catalogEntry is not null,
            CatalogDisplayName = catalogEntry?.DisplayName,
            CatalogVendor = catalogEntry?.Vendor,
            AcceptsImageInput = catalogEntry?.AcceptsImageInput ?? false,
            RequiresImageInput = catalogEntry?.RequiresImageInput ?? false,
            InputPricePerMillion = pricing?.InputPricePerMillion,
            OutputPricePerMillion = pricing?.OutputPricePerMillion,
            PricePerCall = pricing?.PricePerCall,
            PriceCurrency = pricing?.Currency,
            PriceSource = pricing is null ? null : "upstream",
            AlreadyImported = existing.Contains(modelId),
            AlreadyPublished = publishedNames.Contains(modelId),
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
    /*
      名录门的判据必须和上游清单那一屏**同源**。

      不同源的后果是这轮 Codex 抓到的那一条：管理员在清单里就地补登了一个模型，
      刷新后那一行显示「名录内」，于是他不会去勾「放行名录外」，前端提交
      allowOutsideCatalog:false——而这里若只查内置的 38 条，它立刻被拒，
      用户看到的是「刚登记好的模型导不进来」，而且没有任何东西变红
      （predicate-and-wiring-discipline 形状 3：同一个判断分裂成两份各自漂移）。
    */
    var importCatalogOverrides = await LoadCatalogOverridesAsync(http);
    // 取整份文档而不只是名字：下面「已存在就跳过」那一支要看它的能力是不是空的。
    var existingDocs = await gwModels.Find(TenantAccess.Filter(http, fb.Eq("PlatformId", id))).ToListAsync();
    var existingByName = new Dictionary<string, BsonDocument>(StringComparer.OrdinalIgnoreCase);
    foreach (var doc in existingDocs)
    {
        var name = doc.AsNullableString("ModelName") ?? string.Empty;
        if (name.Length > 0) existingByName.TryAdd(name, doc);
    }

    // 用途怎么算出来：名录 > 上游声明 > 猜，用户勾过的最优先。新建与「补空」两条路共用，
    // 各写一份的话补出来的能力与新建出来的会是两套（形状 3）。
    List<string> DeriveCapabilityCodes(ImportUpstreamModelEntry entry, string modelId)
        => (entry.Capabilities ?? ModelCatalog.ResolveCapabilities(modelId, null, importCatalogOverrides).Capabilities.ToList())
            // 注意校验的是**存储层能力名**（image_generation / video_generation ...），
            // 不是用途名（generation / video-gen ...）——InferCapabilities 产出的就是前者。
            // 用错词汇表会把生图与视频模型的用途整批静默丢掉。
            .Where(c => GatewayConfigurationProvisioning.IsSupportedCapabilityCode(c))
            .Select(c => c.Trim().ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .ToList();

    /*
      价格与币种在**动第一次库之前**全批校验完。

      原来这道校验写在插入循环里：前面几条已经插进去了，轮到一条价格非法的才返回 400。
      于是三件事同时成立——用户被告知「导入失败」、库里已经多了几条模型、而且那个 400
      跳过了后面的默认池同步与 `platform.models.import` 审计，那几条既没进池（池路由选不到，
      业务侧调不通）也没留下任何「谁在什么时候导入了它们」的记录。
      入参不合法就一条都不该写；要写就整批可解释。
    */
    foreach (var entry in entries)
    {
        if (GatewayConfigurationProvisioning.IsValidPrice(entry.InputPricePerMillion)
            && GatewayConfigurationProvisioning.IsValidPrice(entry.OutputPricePerMillion)
            && GatewayConfigurationProvisioning.IsValidPrice(entry.PricePerCall)
            && GatewayConfigurationProvisioning.IsSupportedCurrency(entry.PriceCurrency))
        {
            continue;
        }

        return Json(ApiEnvelope<ImportUpstreamModelsResult>.Fail(
            "INVALID_INPUT",
            $"模型「{entry.ModelId!.Trim()}」的价格或币种不合法（价格不能为负，币种只支持 CNY / USD）；"
            + "这一批一条都没有导入，改好后整批重提即可。"), jsonOptions, 400);
    }

    var result = new ImportUpstreamModelsResult { Requested = entries.Count };
    var now = DateTime.UtcNow;
    foreach (var entry in entries)
    {
        var modelId = entry.ModelId!.Trim();
        if (existingByName.TryGetValue(modelId, out var existingModel))
        {
            result.Skipped++;
            result.SkippedModelIds.Add(modelId);

            /*
              能力为空的存量模型，在这里把名录算出来的用途补上。

              「补登名录之后重新导入」是这条路上唯一写明的恢复动作（白名单那条提示就是
              这么告诉用户的）。可这一支原来只记一笔 Skipped 就走，物理文档的空能力原样留着；
              下面发布白名单时重新读的就是那份空能力，于是照样拒登——用户照着提示做了一遍，
              什么都没变，而且没有任何地方告诉他为什么（形状 2：恢复路只建了一半）。

              只补空的，不动已经有能力的：那些可能是人在模型页勾过的，导入没有资格覆盖。
            */
            var storedCaps = existingModel.GetValue("Capabilities", BsonNull.Value);
            var hasStoredCaps = storedCaps.IsBsonArray && storedCaps.AsBsonArray.Count > 0;
            if (!hasStoredCaps)
            {
                var repairedCaps = DeriveCapabilityCodes(entry, modelId);
                if (repairedCaps.Count > 0)
                {
                    await gwModels.UpdateOneAsync(
                        TenantAccess.Filter(http, fb.Eq("_id", existingModel.GetStringOrEmpty("_id"))),
                        Builders<BsonDocument>.Update
                            .Set("Capabilities", new BsonArray(repairedCaps.Select(c => new BsonDocument
                            {
                                { "Type", c },
                                { "Source", "inferred" },
                                { "Value", true },
                            })))
                            .Set("UpdatedAt", now));
                }
            }
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

        // 白名单：名录外的模型必须由管理员显式放行才准入库。
        // 拦在这里而不是拦在请求时，是因为请求只会打到池成员——进不了库就进不了池，
        // 「不允许请求白名单之外的模型」这件事由此成立，且用户在导入那一刻就知道，
        // 而不是等某次真实调用炸了才发现。
        var catalogEntry = ModelCatalog.Find(modelId, importCatalogOverrides);
        if (catalogEntry is null && !entry.AllowOutsideCatalog)
        {
            result.Skipped++;
            result.BlockedOutsideCatalog.Add(modelId);
            continue;
        }

        // 与发现端点同源：名录 > 上游声明 > 猜。用户在界面上勾过的用途仍然最优先。
        // 补登也必须喂进来——否则补登登记的用途白登记了，模型导进来用途还是猜的。
        // 判据与上面「补空」那一支共用同一个函数。
        var caps = DeriveCapabilityCodes(entry, modelId);

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
        /*
          白名单第二道门要用的持久标记。
          审计记了「谁放行了哪几个」，但审计是给人查的、不在请求路径上；
          数据面拦截需要在**模型文档本身**看得出「这条是被人放行过的」，
          否则运行时分不清「管理员显式放行的名录外模型」与「有人直接写库塞进来的」——
          两者在库里长得一模一样，那道门就只能一刀切，要么放过所有、要么拦死所有。
        */
        //
        // 判据是「在不在**内置**名录里」，不是「在不在名录里」——这一处刻意不带补登：
        // 数据面那道门（ModelResolver.JudgeAsync）只认内置名录 + 这枚戳，它读不到
        // 补登表（那是 console-api 自己的）。靠补登才算数的模型不盖戳的话，导进来了、
        // 也进了池，第一次真实请求才被拦下——库里看得见、池里也在、就是调不通。
        if (!ModelCatalog.Contains(modelId))
        {
            doc["AllowedOutsideCatalog"] = true;
            doc["AllowedOutsideCatalogBy"] = TenantAccess.GetRequired(http).Username;
            doc["AllowedOutsideCatalogAt"] = now;
            // 依据要分得清：补登是「已经登记过这个模型是什么」，勾放行是「明知没登记也要用」。
            // 排障时「这个模型当初怎么进来的」得答得上来。
            doc["AllowedOutsideCatalogReason"] = catalogEntry is not null ? "catalog-entry" : "admin-override";
        }

        if (entry.InputPricePerMillion is not null) doc["InputPricePerMillion"] = entry.InputPricePerMillion.Value;
        if (entry.OutputPricePerMillion is not null) doc["OutputPricePerMillion"] = entry.OutputPricePerMillion.Value;
        if (entry.PricePerCall is not null) doc["PricePerCall"] = entry.PricePerCall.Value;
        if (!string.IsNullOrWhiteSpace(entry.PriceCurrency)) doc["PriceCurrency"] = entry.PriceCurrency;
        // 价格带进来就必须同时带上「从哪来、什么时候的」。上游清单给的价是 upstream，
        // 观测时间就是这次导入的时刻——没有这两样，三十天后没人说得清这个数还能不能信。
        if (PricingPolicy.HasAnyPrice(entry.InputPricePerMillion, entry.OutputPricePerMillion, entry.PricePerCall))
        {
            doc["PriceSource"] = PricingPolicy.SourceUpstream;
            doc["PriceObservedAt"] = now;
        }

        try
        {
            await gwModels.InsertOneAsync(doc);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 并发导入撞上唯一索引：对方已经建好了，按「已存在」计，不算失败
            result.Skipped++;
            result.SkippedModelIds.Add(modelId);
            existingByName.TryAdd(modelId, doc);
            continue;
        }
        existingByName.TryAdd(modelId, doc);
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
            // 池不在解析与计费链路上了，这里只剩回滚备份的意义——别把它说成「这批模型选不中」，
            // 那句话会让人以为线上出了问题（第 61 轮 review：文案指向一个不存在的页面，
            // 而且把一件不影响线上的事说成了影响线上）。
            result.Message = "模型已导入，线上调用不受影响；只是旧模型池那份回滚备份没写进去。"
                + "池不在解析与计费链路上，稍后重试导入即可补上。";
        }
    }

    /*
      登上白名单：建公开模型名 + 挂一条上游线路。

      不做这一步的后果是「批量登记只做了一半」——模型躺在 llmgw_models 里，调用方按公开
      模型名请求却找不到它，用户得再去白名单页把同一个模型手工建两遍（建逻辑模型、挂 Offering）。
      「模型」与「白名单」分成两页的代价就体现在这里，所以默认就替他做掉。

      同名已存在时**不新建公开名，只多挂一条线路**：这正是「一个模型允许多个来源」的自然入口，
      从另一个 Provider 再导一次 gpt-4o，得到的是 gpt-4o 的第二条线路，而不是第二个 gpt-4o。
    */
    /*
      发布范围是「这次请求点名的模型现在都在库里」，不是「这次新建了几个」。

      写成 Created > 0 的后果，我自己的失败文案就踩过一次（见上面那段池同步的注释），
      这里又踩了第二次：白名单发布抛异常时响应告诉用户「稍后重试导入」——可重试时
      那些模型全部命中 Skipped、Created 归零，这个块整个被跳过，缺失的对外模型与线路
      永远补不回来。又是一句用户照做也没用的话。

      对已存在的模型重跑一遍是安全的：下面按 PublicIdNormalized 查已有对外模型，
      线路也逐条判重，整段本来就是幂等的。
    */
    var publishTargets = result.CreatedModelIds
        .Concat(result.SkippedModelIds)
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToList();
    // 认不出用途、因此没登上白名单的那几个。必须点名报出来：
    // 这条路正是「管理员放行名录外模型」的出口，而名录外模型的能力往往是空的。
    // 不说的话，用户看到「导入成功 N 个」，那几个却既不在白名单里、也没人告诉他为什么。
    var unknownTypeSkips = new List<string>();
    if ((body?.PublishToWhitelist ?? true) && publishTargets.Count > 0)
    {
        try
        {
            // 按规范化名查，不按提交的拼写查。
            //
            // 上面判「已存在」用的是大小写不敏感的集合，所以换个大小写重试时，那些模型会被
            // 判成 Skipped 并把**提交的拼写**放进 publishTargets；而库里存的是首次导入的拼写，
            // 精确匹配一条都查不到——那条写给用户的「稍后重试导入」于是第三次变成一句照做也没用的话。
            // 身份与唯一索引本来就用 ModelNameNormalized（见上面建索引那段），这里对齐它。
            var publishTargetKeys = publishTargets.Select(x => x.ToLowerInvariant()).Distinct(StringComparer.Ordinal).ToList();
            // 两条都查：ModelNameNormalized 是后加的字段，存量文档不一定有它
            // （那个唯一索引也是 partial 的，只覆盖有该字段的文档）。只查规范化名会漏掉存量。
            var createdDocs = await gwModels.Find(TenantAccess.Filter(http, fb.And(
                fb.Eq("PlatformId", id),
                fb.Or(
                    fb.In("ModelNameNormalized", publishTargetKeys),
                    fb.In("ModelName", publishTargets))))).ToListAsync();

            foreach (var model in createdDocs)
            {
                // 发布规则（公开名怎么算、用途怎么判、跨用途怎么拒、线路排在第几）
                // 全在这一个函数里。单模型新增走的是同一个函数，两个入口不会各自漂移。
                var published = await PublishGatewayModelToWhitelistAsync(
                    gwLogicalModels, gwModelOfferings, model, tenantId, now);
                if (published is not { } outcome) continue;
                if (outcome.BlockedMessage is { Length: > 0 } blocked)
                {
                    // 两种没登上要分开说，下一步不一样：
                    // 撞用途 → 改名或去白名单页决定这条线路挂给谁；
                    // 认不出用途 → 去模型管理给它标能力再登记。
                    if (string.Equals(outcome.BlockedKind, "cross-type", StringComparison.Ordinal))
                        result.CrossTypePublicIdConflicts.Add(blocked);
                    else
                        unknownTypeSkips.Add(blocked);
                    continue;
                }
                if (outcome.CreatedLogical) result.WhitelistedPublicIds.Add(outcome.PublicId);
                else if (outcome.LinkedToExisting) result.LinkedToExistingCount++;
            }
        }
        catch (Exception ex)
        {
            // 模型本身已入库，只是没登上名单——如实说，不报全绿。
            result.WhitelistMessage = $"模型已导入，但登记白名单失败（{ex.GetType().Name}）："
                + "这批模型暂时不在白名单里，调用方按公开模型名请求会找不到它们。"
                + "可以在「模型白名单」页手动添加，或稍后重新导入（已存在的模型会被跳过，只补名单）。";
        }
    }

    if (unknownTypeSkips.Count > 0 && result.WhitelistMessage is null)
    {
        result.WhitelistMessage = $"有 {unknownTypeSkips.Count} 个模型没能登上白名单，因为认不出它们是哪种用途："
            + $"{string.Join("、", unknownTypeSkips.Take(5))}"
            + (unknownTypeSkips.Count > 5 ? " 等" : string.Empty)
            + "。模型本身已经导入，只是不在白名单里，调用方按公开模型名请求会找不到它们。"
            + "认不出用途就兜底当对话模型的话，它们会被列进对话默认面、被普通对话调用方选中并按对话契约调走，"
            + "而这些上游可能是生图或视频。去「模型」页给它们勾上能力，再重新导入一次即可补上名单。";
    }

    // 被白名单拦下的要给可执行的下一步，不能只报一个数字。
    // 池同步失败那条更严重，已经占了 Message 就不覆盖它——两件事都发生时先说没进池那件。
    if (result.BlockedOutsideCatalog.Count > 0 && result.Message is null)
    {
        result.Message = $"有 {result.BlockedOutsideCatalog.Count} 个模型不在内置名录里，已拦下未导入："
            + $"{string.Join("、", result.BlockedOutsideCatalog.Take(5))}"
            + (result.BlockedOutsideCatalog.Count > 5 ? " 等" : string.Empty)
            + "。名录外的模型没人说得清它能吃什么、吐什么，入池后会被调度到、一请求就报错；"
            + "确实要用就在勾选时打开「放行名录外模型」，这个动作会记进审计。";
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
            // 名录外放行是「有人拍板」的动作，必须落到审计上：日后排查「这个怪模型谁放进来的」
            // 要查得到人，否则白名单就退化成一个谁都能绕的提示。
            { "blockedOutsideCatalog", result.BlockedOutsideCatalog.Count },
            { "allowedOutsideCatalog", new BsonArray(entries
                .Where(e => e.AllowOutsideCatalog && !string.IsNullOrWhiteSpace(e.ModelId)
                    && !ModelCatalog.Contains(e.ModelId))
                .Select(e => e.ModelId!.Trim())
                .Where(m => result.CreatedModelIds.Contains(m, StringComparer.OrdinalIgnoreCase))) },
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
    /*
      手工新增这条路径同样要盖放行戳，否则它就是名录门的一个盲区：
      管理员一个字一个字敲进来的名录外模型，会被同步进托管默认池，然后在第一次真实请求时
      被数据面拦下——库里看得见、池里也在、就是调不通，而管理员没做错任何事。
      批量导入那边拦是因为「上游给了一整页、用户是在勾选」，这边是管理员亲手指名的，
      指名本身就是显式放行；如实记成他放行的，而不是留空让运行时去猜。
    */
    if (!ModelCatalog.Contains(draft.ModelName))
    {
        document["AllowedOutsideCatalog"] = true;
        document["AllowedOutsideCatalogBy"] = TenantAccess.GetRequired(http).Username;
        document["AllowedOutsideCatalogAt"] = now;
    }
    try
    {
        await gwModels.InsertOneAsync(document);
    }
    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
    {
        return Json(ApiEnvelope<CreateModelResult>.Fail("DUPLICATE_MODEL", "当前 Provider 已存在相同上游模型"), jsonOptions, 409);
    }

    /*
      旧模型池同步失败，不许把模型一起赔进去。

      池路由已经退场：线上解析走的是对外模型 + 线路，这几个池只剩回滚备份的用途。
      而上一版在这里失败时会把刚插入的模型删掉、回 500——一次写「回滚备份」失败，
      挡住了一条本来完全能跑的模型的创建（第 61 轮 review）。轻重反了：
      备份写不进去是可以稍后补的，模型建不出来是当场就挡住人的。

      改成尽力而为：失败就记下来，照常往下走建白名单与线路，并把这件事如实写进响应，
      不谎报全绿（与下面「登白名单失败也不回滚」同一口径）。
    */
    (int TypesCreated, int PoolsCreated, int ModelsAppended) ensured = default;
    string? poolSyncMessage = null;
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
    catch (Exception poolSyncFailure)
    {
        poolSyncMessage = $"模型已保存，线上调用不受影响；只是旧模型池那份回滚备份没写进去（{poolSyncFailure.Message}）。"
            + "池不在计费与解析链路上，这条可以稍后再补";
    }

    /*
      登上白名单：建公开模型名 + 挂一条上游线路。批量导入一直这么做，这条手工新增的路
      此前只同步进托管默认池就收工——而池路由已经删了，调用方按公开模型名请求找的是
      对外模型 + 线路。结果是「保存成功」之后模型在库里、在池里，就是调不通，
      要管理员再去白名单页把同一个模型手工建两遍（形状 2：链路只建了一半，而且不会红）。

      失败不回滚已插入的模型：模型本身是有效配置，删掉反而更糟。如实降级——
      照常返回创建结果，但把「没登上名单、去哪补」写进响应，不谎报全绿。
    */
    string? publicId = null;
    string? whitelistMessage = null;
    var linkedToExistingLogical = false;
    try
    {
        var published = await PublishGatewayModelToWhitelistAsync(
            gwLogicalModels, gwModelOfferings, document, tenantId, now);
        if (published is { } outcome)
        {
            publicId = outcome.PublicId;
            linkedToExistingLogical = outcome.LinkedToExisting;
            if (outcome.BlockedMessage is { Length: > 0 } blocked)
            {
                publicId = null;
                whitelistMessage = string.Equals(outcome.BlockedKind, "cross-type", StringComparison.Ordinal)
                    ? $"模型已保存，但没能登上白名单：{blocked}。"
                      + "把一条别的用途的线路挂到同名对外模型底下，运行时会按那条模型的用途发请求、契约整个错位，"
                      + "所以这里拒绝挂靠。改个模型名，或去「模型白名单」页手动决定这条线路挂给谁。"
                    : $"模型已保存，但没能登上白名单：{blocked}。"
                      + "认不出用途就兜底当对话模型的话，它会被列进对话默认面、被普通对话调用方选中并按对话契约调走，"
                      + "而这个上游可能是生图或视频。去「模型」页给它勾上能力，再登记白名单。";
            }
        }
        else
        {
            whitelistMessage = "模型已保存，但算不出可用的公开模型名，没能登上白名单；"
                + "调用方按公开模型名请求会找不到它，可在「模型白名单」页手动添加。";
        }
    }
    catch (Exception ex)
    {
        whitelistMessage = $"模型已保存，但登记白名单失败（{ex.GetType().Name}）："
            + "调用方按公开模型名请求会找不到它，可在「模型白名单」页手动添加。";
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
            { "poolSyncDegraded", poolSyncMessage is { Length: > 0 } },
            // 登没登上白名单要能查得到：调不通时第一个要排除的就是「它有没有公开名」。
            { "publicId", publicId is { Length: > 0 } ? publicId : BsonNull.Value },
        });
    return Json(ApiEnvelope<CreateModelResult>.Ok(new CreateModelResult
    {
        Item = MapModel(document),
        PoolTypesCreated = ensured.TypesCreated,
        PoolsCreated = ensured.PoolsCreated,
        ModelsAppended = ensured.ModelsAppended,
        PublicId = publicId,
        LinkedToExistingPublicId = linkedToExistingLogical,
        // 两件事都可能降级，都要如实说。谁也不掩盖谁：登白名单失败是「调不通」，
        // 池备份失败是「回滚那天会少一份」，严重度不同，读的人要分得开。
        WhitelistMessage = whitelistMessage is { Length: > 0 } && poolSyncMessage is { Length: > 0 }
            ? $"{whitelistMessage}\n另外：{poolSyncMessage}"
            : whitelistMessage ?? poolSyncMessage,
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
// 这条模型被哪些模型池引用，各自是继承档案价还是用了自己的覆盖价。
//
// 改价之前必须先看清会影响谁：真正参与计费的是池成员里的那份价格，只改模型档案而不同步，
// 线上会继续按旧价跑，而两处单独看都没错——这是最难被发现的一种漂移。
app.MapGet("/gw/models/{id}/pool-usage", async (HttpContext http, string id) =>
{
    var fb = Builders<BsonDocument>.Filter;
    var modelDoc = await gwModels.Find(TenantAccess.Filter(http, fb.Eq("_id", id))).FirstOrDefaultAsync()
        ?? await models.Find(fb.Eq("_id", id)).FirstOrDefaultAsync();
    if (modelDoc is null)
        return Json(ApiEnvelope<ModelPoolUsageData>.Fail("NOT_FOUND", $"模型不存在：{id}"), jsonOptions, 404);

    var modelName = modelDoc.GetStringOrEmpty("ModelName");
    var platformId = modelDoc.AsNullableString("PlatformId");
    var pools = await gwModelPools.Find(TenantAccess.Filter(http, fb.Empty)).ToListAsync();
    var data = new ModelPoolUsageData();

    foreach (var pool in pools)
    {
        if (!pool.TryGetValue("Models", out var membersValue) || !membersValue.IsBsonArray) continue;
        foreach (var memberValue in membersValue.AsBsonArray)
        {
            if (!memberValue.IsBsonDocument) continue;
            var member = memberValue.AsBsonDocument;
            if (!IsSamePoolMember(member, id, modelName, platformId)) continue;

            var inherits = PoolMemberPriceMatchesModel(member, modelDoc);
            data.Pools.Add(new ModelPoolUsageItem
            {
                PoolId = pool.GetStringOrEmpty("_id"),
                PoolName = pool.AsNullableString("Name") ?? pool.GetStringOrEmpty("_id"),
                ModelType = pool.AsNullableString("ModelType"),
                Inherits = inherits,
                InputPricePerMillion = member.AsNullableDecimal("InputPricePerMillion"),
                OutputPricePerMillion = member.AsNullableDecimal("OutputPricePerMillion"),
                CachedInputPricePerMillion = member.AsNullableDecimal("CachedInputPricePerMillion"),
                CacheWritePricePerMillion = member.AsNullableDecimal("CacheWritePricePerMillion"),
                PricePerCall = member.AsNullableDecimal("PricePerCall"),
                PriceCurrency = PricingPolicy.NormalizeCurrency(member.AsNullableString("PriceCurrency")),
                PriceSource = PricingPolicy.NormalizeSource(member.AsNullableString("PriceSource")),
                PriceObservedAt = member.AsNullableUtcDateTime("PriceObservedAt").ToIso(),
                PriceUpdatedBy = member.AsNullableString("PriceUpdatedBy"),
                Managed = IsManagedAppendOnlyPool(pool),
            });
            break;
        }
    }

    data.InheritingCount = data.Pools.Count(x => x.Inherits);
    data.OverridingCount = data.Pools.Count(x => !x.Inherits);
    return Json(ApiEnvelope<ModelPoolUsageData>.Ok(data), jsonOptions);
}).RequireAuthorization("LogsRead");

// 改一条已有模型。此前这个端点根本不存在：模型建完就只能删了重建，而重建会丢掉池成员绑定，
// 于是没人敢动，价格就那么一直空着或一直旧着。
//
// 价格改动会连带做三件事：把来源记成「人工录入」、把观测时间刷成此刻、按 syncPoolIds 同步到池成员。
// 不在 syncPoolIds 里的池保留它自己的覆盖价，并在 pool-usage 里显示为「覆盖」。
app.MapPut("/gw/models/{id}", async (HttpContext http, string id, [FromBody] UpdateModelRequest? body) =>
{
    if (body is null)
        return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "请求体不能为空"), jsonOptions, 400);

    foreach (var (price, label) in new (decimal?, string)[]
             {
                 (body.InputPricePerMillion, "输入单价"),
                 (body.OutputPricePerMillion, "输出单价"),
                 (body.CachedInputPricePerMillion, "缓存读单价"),
                 (body.CacheWritePricePerMillion, "缓存写单价"),
                 (body.PricePerCall, "每次调用费用"),
             })
    {
        if (!PricingPolicy.IsValidPrice(price))
            return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", $"{label}不能为负数"), jsonOptions, 400);
    }

    var clearPricing = body.ClearPricing == true;
    var requestedCurrency = PricingPolicy.NormalizeCurrency(body.PriceCurrency);
    var hasPriceInput = body.InputPricePerMillion is not null
        || body.OutputPricePerMillion is not null
        || body.CachedInputPricePerMillion is not null
        || body.CacheWritePricePerMillion is not null
        || body.PricePerCall is not null;

    if (!clearPricing && hasPriceInput && requestedCurrency is null)
        return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "填了价格就必须声明币种，计价口径是 USD"), jsonOptions, 400);

    var fb = Builders<BsonDocument>.Filter;
    var sourceFilter = fb.Eq("_id", id);
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
    if (doc is null)
        return Json(ApiEnvelope<ModelItem>.Fail("NOT_FOUND", $"模型不存在：{id}"), jsonOptions, 404);

    var now = DateTime.UtcNow;
    var actor = http.User.FindFirst(System.Security.Claims.ClaimTypes.Name)?.Value
        ?? http.User.Identity?.Name
        ?? "unknown";
    var update = Builders<BsonDocument>.Update.Set("UpdatedAt", now);
    var changes = new BsonDocument();

    if (!string.IsNullOrWhiteSpace(body.Name) && body.Name.Trim() != doc.AsNullableString("Name"))
    {
        update = update.Set("Name", body.Name.Trim());
        changes.Add("name", new BsonDocument
        {
            { "from", ToBsonAuditValue(doc.AsNullableString("Name")) },
            { "to", body.Name.Trim() },
        });
    }

    if (body.Protocol is not null)
    {
        var protocol = body.Protocol.Trim();
        if (protocol.Length == 0)
        {
            update = update.Unset("Protocol");
            changes.Add("protocol", new BsonDocument
            {
                { "from", ToBsonAuditValue(doc.AsNullableString("Protocol")) },
                { "to", BsonNull.Value },
            });
        }
        else if (protocol != doc.AsNullableString("Protocol"))
        {
            update = update.Set("Protocol", protocol);
            changes.Add("protocol", new BsonDocument
            {
                { "from", ToBsonAuditValue(doc.AsNullableString("Protocol")) },
                { "to", protocol },
            });
        }
    }

    if (body.ClearMaxTokens == true)
    {
        // 显式清空：改回「不限制」。没有这一支的话，界面上那句「留空表示不限制」
        // 兑现不了——清空发出去是个被省略的字段，服务端分不清它和「这次没动」。
        update = update.Unset("MaxTokens");
        changes.Add("maxTokens", new BsonDocument
        {
            { "from", ToBsonAuditValue(doc.AsNullableInt("MaxTokens")) },
            { "to", BsonNull.Value },
        });
    }
    else if (body.MaxTokens is int maxTokens)
    {
        if (maxTokens <= 0)
            return Json(ApiEnvelope<ModelItem>.Fail("INVALID_INPUT", "最大输出 token 必须大于 0"), jsonOptions, 400);
        update = update.Set("MaxTokens", maxTokens);
        changes.Add("maxTokens", new BsonDocument
        {
            { "from", ToBsonAuditValue(doc.AsNullableInt("MaxTokens")) },
            { "to", maxTokens },
        });
    }

    if (body.Remark is not null)
    {
        var remark = body.Remark.Trim();
        update = remark.Length == 0 ? update.Unset("Remark") : update.Set("Remark", remark);
        changes.Add("remark", new BsonDocument
        {
            { "from", ToBsonAuditValue(doc.AsNullableString("Remark")) },
            { "to", remark.Length == 0 ? BsonNull.Value : remark },
        });
    }

    var pricingTouched = clearPricing || hasPriceInput;
    if (clearPricing)
    {
        update = update
            .Unset("InputPricePerMillion").Unset("OutputPricePerMillion")
            .Unset("CachedInputPricePerMillion").Unset("CacheWritePricePerMillion")
            .Unset("PricePerCall").Unset("PriceCurrency")
            .Unset("PriceSource").Unset("PriceObservedAt").Unset("PriceUpdatedBy");
        changes.Add("pricing", new BsonDocument { { "cleared", true } });
    }
    else if (hasPriceInput)
    {
        update = SetOrUnsetDecimal(update, "InputPricePerMillion", body.InputPricePerMillion);
        update = SetOrUnsetDecimal(update, "OutputPricePerMillion", body.OutputPricePerMillion);
        update = SetOrUnsetDecimal(update, "CachedInputPricePerMillion", body.CachedInputPricePerMillion);
        update = SetOrUnsetDecimal(update, "CacheWritePricePerMillion", body.CacheWritePricePerMillion);
        update = SetOrUnsetDecimal(update, "PricePerCall", body.PricePerCall);
        update = update
            // 走到这里 requestedCurrency 必然非空：上面已经拒绝过「填了价格却没声明币种」。
            .Set("PriceCurrency", requestedCurrency!)
            // 人改过的价格，来源就是人工——不许沿用上一次的 upstream，否则来源会撒谎。
            .Set("PriceSource", PricingPolicy.SourceAdmin)
            .Set("PriceObservedAt", now)
            .Set("PriceUpdatedBy", actor);
        changes.Add("pricing", new BsonDocument
        {
            { "inputFrom", ToBsonAuditValue(doc.AsNullableDecimal("InputPricePerMillion")) },
            { "inputTo", ToBsonAuditValue(body.InputPricePerMillion) },
            { "outputFrom", ToBsonAuditValue(doc.AsNullableDecimal("OutputPricePerMillion")) },
            { "outputTo", ToBsonAuditValue(body.OutputPricePerMillion) },
            { "cachedInputTo", ToBsonAuditValue(body.CachedInputPricePerMillion) },
            { "cacheWriteTo", ToBsonAuditValue(body.CacheWritePricePerMillion) },
            { "perCallTo", ToBsonAuditValue(body.PricePerCall) },
            { "currencyFrom", ToBsonAuditValue(doc.AsNullableString("PriceCurrency")) },
            { "currencyTo", requestedCurrency },
        });
    }

    await targetModels.UpdateOneAsync(filter, update);
    var fresh = await targetModels.Find(filter).FirstOrDefaultAsync() ?? doc;

    var syncedPools = new List<string>();
    var skippedPools = new List<string>();
    if (pricingTouched && body.SyncPoolIds is { Count: > 0 })
    {
        (syncedPools, skippedPools) = await SyncPoolMemberPricingAsync(
            gwModelPools, http, fresh, id, body.SyncPoolIds, actor, now);
    }

    if (syncedPools.Count > 0 || skippedPools.Count > 0)
    {
        changes.Add("poolSync", new BsonDocument
        {
            { "synced", new BsonArray(syncedPools) },
            { "skipped", new BsonArray(skippedPools) },
        });
    }

    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.update",
        targetType: targetAuthority == "llm_gateway" ? "llmgw_model" : "llmmodel",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: changes);

    return Json(ApiEnvelope<ModelItem>.Ok(MapModel(fresh)), jsonOptions);
}).RequireAuthorization("ConfigWrite");

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
    var sourceFilter = Builders<BsonDocument>.Filter.Eq("_id", id);
    var filter = TenantAccess.Filter(http, sourceFilter);
    var doc = await gwModels.Find(filter).FirstOrDefaultAsync();
    // MAP 遗留模型清理：理由同 pools 的 MAP 分支——平台删除的阻挡清单会数 MAP 的 llmmodels，
    // 不给一条能扫掉它们的路，上游就永远删不动（MAP 侧写接口已退场）。
    var isMapLegacy = false;
    if (doc is null)
    {
        if (TenantAccess.GetRequired(http).TenantId == internalTenantId)
            doc = await models.Find(sourceFilter).FirstOrDefaultAsync();
        if (doc is null)
            return Json(ApiEnvelope<ModelDeleteBlockers>.Fail("NOT_GW_AUTHORITY", "只能删除已认领到 GW 的模型；MAP 来源模型请先认领"), jsonOptions, 409);
        isMapLegacy = true;
    }

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

    // 先把成员从平台托管默认池里摘掉，再删模型：顺序反了会留下一条解析不到任何东西的派生成员。
    var prunedManagedPools = await PruneManagedPoolMembersAsync(http, gwModelPools, doc);
    if (isMapLegacy) await models.DeleteOneAsync(sourceFilter);
    else await gwModels.DeleteOneAsync(filter);
    await WriteOperationAuditAsync(
        operationAudits,
        http,
        action: "model.delete",
        targetType: isMapLegacy ? "map_llm_model" : "llmgw_model",
        targetId: id,
        targetName: doc.AsNullableString("ModelName") ?? doc.AsNullableString("Name"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "modelName", ToBsonAuditValue(doc.AsNullableString("ModelName")) },
            { "platformId", ToBsonAuditValue(doc.AsNullableString("PlatformId")) },
            { "authority", isMapLegacy ? "map" : "llm_gateway" },
            // 顺带从哪些托管默认池里摘了成员，要留痕——否则事后看不出池成员数为什么少了
            { "prunedManagedPools", new BsonArray(prunedManagedPools) },
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
    // 认领是把一条**早就在跑**的 MAP 模型收编过来，它不该因为换了归属就突然被名录门拦下。
    // 与手工新增同理：认领这个动作本身就是显式放行，如实记成认领人放的。
    if (!ModelCatalog.Contains(claimed.AsNullableString("ModelName")))
    {
        claimed["AllowedOutsideCatalog"] = true;
        claimed["AllowedOutsideCatalogBy"] = $"{TenantAccess.GetRequired(http).Username}（认领 MAP 模型）";
        claimed["AllowedOutsideCatalogAt"] = now;
    }

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
    // 精确到模型的能力维护：控制台此前只能按平台整片刷能力，想给单个模型补一条能力
    // （例如把某个模型标成 intent 可用）就只能连同平台上几百个模型一起改。
    // 归一化与「传了但全无效」的判据在 GatewayConfigurationProvisioning 里，可被直接测。
    if (!GatewayConfigurationProvisioning.TryNormalizeBulkModelIds(
            body.ModelIds, out var modelIds, out var modelIdsError))
        return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", modelIdsError), jsonOptions, 400);
    if (platformId.Length == 0 && modelIds.Count == 0 && body.AllGwOwned != true)
    {
        return Json(ApiEnvelope<BulkUpdateModelCapabilitiesResult>.Fail("INVALID_INPUT", "批量能力维护必须选择平台或指定 modelIds，或显式设置 allGwOwned=true"), jsonOptions, 400);
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
    if (modelIds.Count > 0)
    {
        filters.Add(fb.Or(
            fb.In("_id", modelIds),
            fb.In("ModelName", modelIds),
            fb.In("Name", modelIds)));
        filterParts.Add($"modelIds={modelIds.Count}");
    }
    if (platformId.Length == 0 && modelIds.Count == 0)
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
        targetId: platformId.Length > 0 ? platformId : (modelIds.Count > 0 ? string.Join(",", modelIds.Take(10)) : "all"),
        targetName: platformId.Length > 0 ? platformId : (modelIds.Count > 0 ? $"{modelIds.Count} 个指定模型" : "all gw models"),
        success: true,
        reason: null,
        changes: new BsonDocument
        {
            { "platformId", platformId },
            { "modelIds", new BsonArray(modelIds.Take(50)) },
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
    var document = GatewayConfigurationProvisioning.BuildExchangeDocument(
        draft, tenantId, id, encryptedApiKey, now, TenantAccess.GetRequired(http).Username);
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
        .Set("Models", GatewayConfigurationProvisioning.BuildExchangeModels(
            draft.Models, TenantAccess.GetRequired(http).Username, DateTime.UtcNow))
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
    EstimatedCacheReadCost = d.AsNullableDecimal("EstimatedCacheReadCost"),
    EstimatedCacheWriteCost = d.AsNullableDecimal("EstimatedCacheWriteCost"),
    CachedInputPricePerMillion = d.AsNullableDecimal("CachedInputPricePerMillion"),
    CacheWritePricePerMillion = d.AsNullableDecimal("CacheWritePricePerMillion"),
    PriceSource = PricingPolicy.NormalizeSource(d.AsNullableString("PriceSource")),
    PriceObservedAt = d.AsNullableUtcDateTime("PriceObservedAt").ToIso(),
    // 算没算出钱与算不出的原因，跟金额一起给出来。只给一个空金额，用户没法知道
    // 是这次没花钱、还是这条模型压根没配价——后者才是他要去处理的事。
    CostStatus = ResolveLogCostStatus(d),
    CostUnpricedReason = d.AsNullableString("CostUnpricedReason"),
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

/// <summary>
/// 这条池成员指的是不是这条模型。池成员存的 ModelId 是**模型名**不是文档 id（见 BuildPoolMemberFromModel
/// 的调用点），而不同入口写进去的可能是 ModelName、Name 或 _id 三者之一，所以三个都认。
/// 只认一个，换条路建出来的成员就会被漏掉，改价时静默不同步。
/// </summary>
static bool IsSamePoolMember(BsonDocument member, string modelDocId, string? modelName, string? platformId)
{
    var memberModelId = member.AsNullableString("ModelId");
    if (string.IsNullOrWhiteSpace(memberModelId)) return false;

    var matchesModel = string.Equals(memberModelId, modelDocId, StringComparison.OrdinalIgnoreCase)
        || (!string.IsNullOrWhiteSpace(modelName)
            && string.Equals(memberModelId, modelName, StringComparison.OrdinalIgnoreCase));
    if (!matchesModel) return false;

    var memberPlatformId = member.AsNullableString("PlatformId");
    // 成员或模型任一没有平台信息时不拿平台当否决条件——存量数据缺字段是常态，
    // 拿缺失当「不匹配」会让这些成员永远同步不到新价格。
    if (string.IsNullOrWhiteSpace(memberPlatformId) || string.IsNullOrWhiteSpace(platformId)) return true;
    return string.Equals(memberPlatformId, platformId, StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// 池成员的价格是不是跟模型档案完全一致（即「继承」）。任何一档不同就是覆盖，
/// 界面上要如实标出来，而不是假装两边同源。
/// </summary>
static bool PoolMemberPriceMatchesModel(BsonDocument member, BsonDocument modelDoc)
{
    foreach (var field in new[]
             {
                 "InputPricePerMillion", "OutputPricePerMillion",
                 "CachedInputPricePerMillion", "CacheWritePricePerMillion", "PricePerCall",
             })
    {
        if (member.AsNullableDecimal(field) != modelDoc.AsNullableDecimal(field)) return false;
    }

    return string.Equals(
        PricingPolicy.NormalizeCurrency(member.AsNullableString("PriceCurrency")),
        PricingPolicy.NormalizeCurrency(modelDoc.AsNullableString("PriceCurrency")),
        StringComparison.Ordinal);
}

/// <summary>价格字段：有值就写，没值就删——留着上一次的旧数字比没有数字更糟。</summary>
static UpdateDefinition<BsonDocument> SetOrUnsetDecimal(
    UpdateDefinition<BsonDocument> update, string field, decimal? value)
    => value is decimal actual ? update.Set(field, new BsonDecimal128(actual)) : update.Unset(field);

/// <summary>
/// 把模型档案上的价格同步进指定的几个模型池成员。
///
/// 这一步是「价格只有一处真相」的落点：调度读的是池成员里的价格，档案改了不同步，
/// 线上就会继续按旧价计费。托管的只追加池不接受从这里改价，如实跳过并报出来。
/// </summary>
static async Task<(List<string> Synced, List<string> Skipped)> SyncPoolMemberPricingAsync(
    IMongoCollection<BsonDocument> pools,
    HttpContext http,
    BsonDocument modelDoc,
    string modelDocId,
    IEnumerable<string> poolIds,
    string actor,
    DateTime now)
{
    var synced = new List<string>();
    var skipped = new List<string>();
    var wanted = poolIds
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x.Trim())
        .Distinct(StringComparer.Ordinal)
        .ToList();
    if (wanted.Count == 0) return (synced, skipped);

    var modelName = modelDoc.AsNullableString("ModelName") ?? modelDoc.AsNullableString("Name");
    var platformId = modelDoc.AsNullableString("PlatformId");
    var fb = Builders<BsonDocument>.Filter;
    var tenantId = TenantAccess.GetRequired(http).TenantId;

    foreach (var poolId in wanted)
    {
        var pool = await pools.Find(TenantAccess.Filter(http, fb.Eq("_id", poolId))).FirstOrDefaultAsync();
        if (pool is null) { skipped.Add(poolId); continue; }
        if (IsManagedAppendOnlyPool(pool)) { skipped.Add(poolId); continue; }
        if (!pool.TryGetValue("Models", out var membersValue) || !membersValue.IsBsonArray)
        {
            skipped.Add(poolId);
            continue;
        }

        var membersArray = membersValue.AsBsonArray;
        var changed = false;
        foreach (var memberValue in membersArray)
        {
            if (!memberValue.IsBsonDocument) continue;
            var member = memberValue.AsBsonDocument;
            if (!IsSamePoolMember(member, modelDocId, modelName, platformId)) continue;

            ApplyModelPricingToMember(member, modelDoc, actor, now);
            changed = true;
            break;
        }

        if (!changed) { skipped.Add(poolId); continue; }

        await pools.UpdateOneAsync(
            fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", poolId)),
            Builders<BsonDocument>.Update
                .Set("Models", membersArray)
                .Set("UpdatedAt", now)
                .Inc("Version", 1));
        synced.Add(poolId);
    }

    return (synced, skipped);
}

/// <summary>把模型档案的五档价格连同来源、观测时间、操作者一起盖到池成员上。</summary>
static void ApplyModelPricingToMember(BsonDocument member, BsonDocument modelDoc, string actor, DateTime now)
{
    foreach (var field in new[]
             {
                 "InputPricePerMillion", "OutputPricePerMillion",
                 "CachedInputPricePerMillion", "CacheWritePricePerMillion", "PricePerCall",
             })
    {
        if (modelDoc.AsNullableDecimal(field) is decimal value) member[field] = new BsonDecimal128(value);
        else member.Remove(field);
    }

    if (PricingPolicy.NormalizeCurrency(modelDoc.AsNullableString("PriceCurrency")) is string currency)
        member["PriceCurrency"] = currency;
    else member.Remove("PriceCurrency");

    if (PricingPolicy.NormalizeSource(modelDoc.AsNullableString("PriceSource")) is string source)
        member["PriceSource"] = source;
    else member.Remove("PriceSource");

    if (modelDoc.AsNullableUtcDateTime("PriceObservedAt") is DateTime observedAt) member["PriceObservedAt"] = observedAt;
    else member.Remove("PriceObservedAt");

    member["PriceUpdatedBy"] = actor;
    member["PriceSyncedAt"] = now;
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
    if (modelDoc.AsNullableDecimal("CachedInputPricePerMillion") is decimal cachedInputPrice) member["CachedInputPricePerMillion"] = new BsonDecimal128(cachedInputPrice);
    else member.Remove("CachedInputPricePerMillion");
    if (modelDoc.AsNullableDecimal("CacheWritePricePerMillion") is decimal cacheWritePrice) member["CacheWritePricePerMillion"] = new BsonDecimal128(cacheWritePrice);
    else member.Remove("CacheWritePricePerMillion");
    if (modelDoc.AsNullableDecimal("PricePerCall") is decimal pricePerCall) member["PricePerCall"] = new BsonDecimal128(pricePerCall);
    else member.Remove("PricePerCall");
    if (NormalizePriceCurrency(modelDoc.AsNullableString("PriceCurrency")) is string priceCurrency) member["PriceCurrency"] = priceCurrency;
    else member.Remove("PriceCurrency");
    // 来源与观测时间跟着价格一起走。只复制数字不复制来源，池里那份就成了「说不出从哪来」的价格。
    if (PricingPolicy.NormalizeSource(modelDoc.AsNullableString("PriceSource")) is string priceSource) member["PriceSource"] = priceSource;
    else member.Remove("PriceSource");
    if (modelDoc.AsNullableUtcDateTime("PriceObservedAt") is DateTime priceObservedAt) member["PriceObservedAt"] = priceObservedAt;
    else member.Remove("PriceObservedAt");
    if (modelDoc.AsNullableString("PriceUpdatedBy") is string priceUpdatedBy) member["PriceUpdatedBy"] = priceUpdatedBy;
    else member.Remove("PriceUpdatedBy");

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

/// <summary>
/// 把一个即将被删的模型，从所有「平台托管默认池」的成员里摘掉，返回被摘的池名。
///
/// 这类池的成员是按用途自动收进来的派生结果，所以删源模型时同步收敛属于维护而非编排改动；
/// 非托管池不碰——那些是人手编排的，成员该不该走由 CollectModelDeleteBlockersAsync 拦下来问人。
/// </summary>
static async Task<List<string>> PruneManagedPoolMembersAsync(
    HttpContext http,
    IMongoCollection<BsonDocument> gwPools,
    BsonDocument modelDoc)
{
    var fb = Builders<BsonDocument>.Filter;
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
    if (aliases.Length == 0 || string.IsNullOrWhiteSpace(platformId)) return new List<string>();

    var memberFilter = fb.ElemMatch<BsonDocument>(
        "Models",
        fb.And(fb.In("ModelId", aliases), fb.Eq("PlatformId", platformId)));
    var pools = await gwPools.Find(TenantAccess.Filter(http, memberFilter)).ToListAsync();

    var pruned = new List<string>();
    foreach (var pool in pools.Where(IsManagedAppendOnlyPool))
    {
        // 定点摘除，不整数组覆写。
        //
        // 原来是「读出来、在内存里过滤、再 Set 回整个 Models」，两个问题：
        // 一是并发的成员改动会被这次覆写吞掉（读到写之间别人加的成员直接没了）；
        // 二是不递增 Version，于是在这次 prune 之前加载过该池的客户端，之后仍能拿着
        // 旧版本号通过 PoolVersionGuard，把刚摘掉的成员原样写回来。
        // 改成 $pull + Inc("Version")：摘除本身是幂等的定点操作，不需要版本守卫；
        // 递增版本则让所有陈旧句柄的后续写入被既有守卫挡下，与其它成员改动端点同一套口径。
        // 过滤里必须带上 memberFilter：$pull 匹配不到东西时是空操作，
        // 但 Set/Inc 是无条件的，只用 _id 过滤会让「什么都没摘到」也算 ModifiedCount>0——
        // 于是并发的第二个请求把自己记成「摘过了」写进审计，还白白 bump 一次版本，
        // 把别人手里还有效的版本句柄作废掉。带上 memberFilter 后，
        // 成员已经被别人摘走时这次更新压根不匹配，版本、时间戳、审计一起不动。
        var pullResult = await gwPools.UpdateOneAsync(
            TenantAccess.Filter(http, fb.And(fb.Eq("_id", pool.GetStringOrEmpty("_id")), memberFilter)),
            Builders<BsonDocument>.Update
                .PullFilter("Models", fb.And(
                    fb.In("ModelId", aliases),
                    fb.Eq("PlatformId", platformId)))
                .Set("UpdatedAt", DateTime.UtcNow)
                .Inc("Version", 1));
        if (pullResult.ModifiedCount > 0)
            pruned.Add(pool.AsNullableString("Name") ?? pool.GetStringOrEmpty("_id"));
    }
    return pruned;
}

/// <summary>
/// 这条池成员是不是「死成员」——它按 (ModelId, PlatformId) 已经指不到任何东西了。
///
/// **这是「能不能摘除」的唯一判据。** 池列表把它算成 <c>PoolItem.Models[].Removable</c> 下发，
/// 成员删除端点用同一个函数放行；前端不再自己拼条件去猜后端会不会答应。
///
/// 为什么必须唯一：此前前端拿派生的「不可用」标记去重建这个判据，连续三轮 review 抓出三处
/// 分歧——上游只是被停用、成员挂在中继上、成员在上游被删之前就已经不健康——每一处都表现为
/// 「控制台长出一个按钮，点下去必然 409」。补洞补不完，因为那本就是两份判据在各自漂移（形状 3）。
///
/// 判定刻意从严，只要有任何一条「还指得到 / 判不准」的迹象就当活成员保护住
///（宁可拒绝，不可误删）：键为空、走中继解析（中继成员的 platformId 是 <c>__exchange__</c>
/// 或某条中继的 id，压根不是平台 id）、平台还在且模型还在 —— 一律不算死。
///
/// 只看「在不在」，不看「启不启用」：停用是可逆的临时状态，启用即恢复，不该被当成 debris 摘掉。
/// 也不看健康状态：一个在上游被删之前就已经失败到不可用的成员，照样是死成员。
/// </summary>
static bool IsDeadPoolMember(string modelId, string platformId, PoolResolutionIndex index)
{
    if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(platformId)) return false;

    // 中继成员不走平台表解析，拿平台表判它必然「查不到」，会把活的中继成员误判成死成员
    if (string.Equals(platformId, "__exchange__", StringComparison.Ordinal)) return false;
    if (index.ExistingExchanges.Any(e => string.Equals(e.GetStringOrEmpty("_id"), platformId, StringComparison.Ordinal)))
        return false;

    // 上游还在 -> 再看这个模型还在不在；上游都没了 -> 直接是死成员
    if (index.ExistingPlatformIds.Contains(platformId))
    {
        return !index.ExistingModels.Any(model => PoolMemberMatchesModelDoc(model, platformId, modelId));
    }
    return true;
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
    if (string.IsNullOrWhiteSpace(modelType) || string.IsNullOrWhiteSpace(poolId))
        return false;

    // MAP 遗留池（model_groups）压根没有 TenantId 字段，它「是不是默认」只由自身的
    // IsDefaultForType 决定——这正是下面 `type is null` 那条兜底想覆盖的情况。
    // 原来把 TenantId 为空也一并早退成 false，等于在读到那个标记之前就把兜底短路掉了：
    // 于是任何 MAP 遗留默认池对删除阻挡清单都报「不是当前默认」，只要它碰巧没有
    // appCaller 绑定就能被直接删掉，而 ModelResolver 仍在拿它当该模型类型的兜底，
    // 删完那一类调用就没有后备了（形状 1：判据比它该管的范围窄）。
    if (string.IsNullOrWhiteSpace(tenantId))
        return pool.AsNullableBool("IsDefaultForType") == true;

    var type = await poolTypes.Find(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("Code", modelType))).FirstOrDefaultAsync();
    return type is null
        ? pool.AsNullableBool("IsDefaultForType") == true
        : string.Equals(type.AsNullableString("DefaultPoolId"), poolId, StringComparison.Ordinal);
}

/// <summary>
/// 把一个上游模型登上白名单：没有同名公开模型就建一个，再给它挂一条指向这个上游的线路。
///
/// 为什么必须有这一步：池路由已经删了，调用方按**公开模型名**请求，找的是对外模型 + 线路。
/// 只把模型写进 llmgw_models、再同步进托管默认池，得到的是一个库里看得见、界面报成功、
/// 却怎么也调不通的模型——链路只建了一半，而且不会有任何东西变红
/// （predicate-and-wiring-discipline 形状 2）。
///
/// 为什么抽成一个函数：批量导入与单模型新增是同一件事的两个入口。各写一份的话，
/// 下一次改发布规则（用途判定、跨用途冲突、线路优先级）只会改到其中一份，
/// 而另一份继续按旧规矩发布，谁赢取决于用户从哪个入口进来（形状 3：判据分裂各自漂移）。
///
/// 同名已存在时**不新建公开名，只多挂一条线路**：这正是「一个模型允许多个来源」的自然入口。
/// 同名但用途不同则拒绝挂靠并把冲突交回调用方说明——把一条生图线路挂到 chat 模型底下，
/// 运行时会按那条模型的用途发请求，请求契约整个错位。
/// </summary>
/// <returns>
/// 模型名或公开名算不出来时回 null（这条跳过）；否则给出公开名、是不是新建的、
/// 是不是挂到了已有的公开名，以及没登上时的原因。原因分两种，调用方要分开说：
/// <c>cross-type</c> 公开名撞上了别的用途，<c>unknown-type</c> 认不出它是哪种用途。
/// </returns>
/// <summary>
/// 池成员身上自带的价格覆盖，与目标模型文档上的价格比一比，列出**会丢掉**的那几项。
///
/// 为什么会丢：池路由按池成员计价，而线路（Offering）没有价格字段——搬过来之后
/// 计价只看物理模型文档。成员上配过、模型文档上没有或不一样的，搬完就变了：
/// 要么按另一个价收，要么整条判成未计价而掉出用量与预算。
/// 兑换所成员更彻底——它根本没有物理模型文档可回落，成员价一丢就是未计价。
///
/// 给线路加一层价格覆盖是另一套语义（新增字段 + 解析优先级），不在这一刀里做；
/// 这里要做的是**不让它悄悄发生**：逐条列出来，说清值是多少、该填到哪儿去。
/// </summary>
/// <summary>
/// 成员自己配的输出上限（MaxTokens）会不会在搬迁里丢掉，丢了就返回一句人话。
///
/// 线路（Offering）没有这个字段：走线路解析时输出上限取的是**物理模型**上的那个。
/// 所以成员上配过一个不一样的值时，搬过去之后那条限制就不存在了——请求可能超过成员
/// 原本的上限，或者继承一个完全不同的全局上限，而这件事不会有任何地方报错。
/// 给线路加价格/上限覆盖层是新语义（§5.5 的 B 类），这里先如实报出来，与价格丢失同一口径。
/// </summary>
/// <summary>
/// 搬迁时这条线路算不算「现在能接流量」。
///
/// 三个条件缺一不可，逐条对着运行时那一侧：线路自己启用着、健康档不是熔断
/// （GatewayRouteSelection 把熔断态整条跳过）、上游够格（目标在且启用、Provider 可用、
/// 兑换所别名声明过）。少判任何一条，「一条能接流量的线路都没有」这道闸就会漏放，
/// 而漏放的后果是模型带着用途默认与认领留在库里，池退场后每个请求当场失败。
/// </summary>
static bool MigrationRouteCountsAsUsable(
    int healthStatus,
    bool enabled,
    OfferingTargetEligibility.Rejection? targetRejection)
    => enabled
        && healthStatus != CallTracePlanner.HealthUnavailable
        && targetRejection is null;

/// <summary>库里已经有的那条线路，读它自己的启用与健康档再判。
/// （顶层局部函数不能重载，所以换个名字，不是两套判据——它就是上面那个。）</summary>
static bool MigrationExistingRouteCountsAsUsable(
    BsonDocument offering,
    OfferingTargetEligibility.Rejection? targetRejection)
    => MigrationRouteCountsAsUsable(
        offering.AsNullableInt("HealthStatus") ?? 0,
        // 与运行时同口径：缺 Enabled 字段的线路运行时一条都查不到，这里也不算它能接流量。
        offering.AsNullableBool("Enabled") == true,
        targetRejection);

static string? DescribeLostMemberMaxTokens(BsonDocument member, BsonDocument? physical)
{
    var memberValue = member.GetValue("MaxTokens", BsonNull.Value);
    if (memberValue.IsBsonNull) return null;
    var physicalValue = physical?.GetValue("MaxTokens", BsonNull.Value) ?? BsonNull.Value;
    // 目标模型上已经是同一个值就不算丢——搬完行为不变，报出来只是噪音。
    if (!physicalValue.IsBsonNull && physicalValue.Equals(memberValue)) return null;
    return physicalValue.IsBsonNull
        ? $"成员自己配了输出上限 {memberValue}，而目标模型没有配"
        : $"成员自己配了输出上限 {memberValue}，而目标模型配的是 {physicalValue}";
}

static List<string> DescribeLostMemberPrices(BsonDocument member, BsonDocument? physical)
{
    var fields = new (string Field, string Label)[]
    {
        ("InputPricePerMillion", "输入单价"),
        ("OutputPricePerMillion", "输出单价"),
        ("CachedInputPricePerMillion", "缓存读单价"),
        ("CacheWritePricePerMillion", "缓存写单价"),
        ("PricePerCall", "每次调用固定费"),
    };
    var lost = new List<string>();
    foreach (var (field, label) in fields)
    {
        var memberValue = member.GetValue(field, BsonNull.Value);
        if (memberValue.IsBsonNull) continue;
        var physicalValue = physical?.GetValue(field, BsonNull.Value) ?? BsonNull.Value;
        // 目标模型上已经是同一个值就不算丢——那种情况搬完计价结果不变，报出来只是噪音。
        if (!physicalValue.IsBsonNull && physicalValue.Equals(memberValue)) continue;
        lost.Add($"{label} {memberValue}");
    }
    return lost;
}

static async Task<(string PublicId, bool CreatedLogical, bool LinkedToExisting, string? BlockedKind, string? BlockedMessage)?>
    PublishGatewayModelToWhitelistAsync(
        IMongoCollection<BsonDocument> logicalModels,
        IMongoCollection<BsonDocument> offerings,
        BsonDocument model,
        string tenantId,
        DateTime now)
{
    var modelName = model.GetStringOrEmpty("ModelName");
    if (modelName.Length == 0) return null;

    var publicId = GatewayWhitelistPublishing.ToPublicId(modelName);
    if (publicId.Length == 0) return null;
    var normalizedPublicId = publicId.ToLowerInvariant();

    var logical = await logicalModels.Find(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("PublicIdNormalized", normalizedPublicId))).FirstOrDefaultAsync();

    var capabilityCodes = (model.TryGetValue("Capabilities", out var capsValue) && capsValue.IsBsonArray
            ? capsValue.AsBsonArray.Where(x => x.IsBsonDocument).Select(x => x.AsBsonDocument.GetStringOrEmpty("Type"))
            : Enumerable.Empty<string>())
        .Where(x => x.Length > 0)
        .ToList();
    var modelType = GatewayWhitelistPublishing.TryResolveModelType(capabilityCodes);
    if (modelType is null)
    {
        // 一个模态都认不出来就不登白名单。兜底成 chat 的话，这个上游会被列进对话默认面、
        // 被普通对话调用方选中、按对话契约调走——而它可能是生图或视频。
        // 物理模型已经入库，不动它；这里把「为什么没登上、下一步做什么」交回调用方说出口。
        return (publicId, false, false, "unknown-type",
            $"{publicId}（认不出它是哪种用途：这个模型没有可识别的能力声明）");
    }

    string logicalId;
    var createdLogical = false;
    var linkedToExisting = false;
    if (logical is null)
    {
        logicalId = $"gw-logical-{Guid.NewGuid():N}";
        await logicalModels.InsertOneAsync(new BsonDocument
        {
            { "_id", logicalId }, { "TenantId", tenantId },
            { "PublicId", publicId }, { "PublicIdNormalized", normalizedPublicId },
            { "Name", publicId }, { "ModelType", modelType },
            { "Capabilities", new BsonArray(LogicalModelCapabilityPolicy.NormalizeDetailed(modelType, capabilityCodes).Persisted) },
            // 能力口径的版本戳。漏了它，capability-audit 会把这条算成「未迁移」——
            // 而迁移只在控制台启动时跑一次，于是启动后第一次成功发布就把发布门禁弄红，
            // 得重启控制台才恢复。
            { LogicalModelCapabilityPolicy.SchemaVersionField, LogicalModelCapabilityPolicy.SchemaVersion },
            // 授权范围刻意留空 = 当前租户全部 appCaller 可用。
            // 这一步不替用户决定「谁能用」：收紧是治理动作，要有人明确拍板。
            { "AllowedAppCallerCodes", new BsonArray() },
            { "RoutingStrategy", "priority" }, { "Enabled", true }, { "DisplayOrder", 100 },
            { "CreatedAt", now }, { "UpdatedAt", now },
        });
        createdLogical = true;
    }
    else
    {
        var existingType = logical.GetStringOrEmpty("ModelType");
        if (!string.Equals(existingType, modelType, StringComparison.OrdinalIgnoreCase))
        {
            return (publicId, false, false, "cross-type",
                $"{publicId}（已存在的是「{existingType}」用途，这次是「{modelType}」用途）");
        }
        logicalId = logical.GetStringOrEmpty("_id");
        linkedToExisting = true;
    }

    var modelId = model.GetStringOrEmpty("_id");
    var duplicate = await offerings.Find(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("LogicalModelId", logicalId),
        Builders<BsonDocument>.Filter.Eq("TargetKind", "model"),
        Builders<BsonDocument>.Filter.Eq("TargetId", modelId))).AnyAsync();
    if (duplicate) return (publicId, createdLogical, linkedToExisting, null, null);

    // 后来的线路排在已有线路之后：先登记的那条继续扛流量，新增不该悄悄改变谁是主路。
    var existingRoutes = (int)await offerings.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("LogicalModelId", logicalId)));

    await offerings.InsertOneAsync(new BsonDocument
    {
        { "_id", $"gw-offering-{Guid.NewGuid():N}" }, { "TenantId", tenantId },
        { "LogicalModelId", logicalId }, { "TargetKind", "model" }, { "TargetId", modelId },
        { "UpstreamModelId", modelName },
        { "Protocol", model.AsNullableString("Protocol") is { Length: > 0 } p ? p : BsonNull.Value },
        { "EndpointPath", BsonNull.Value },
        { "Priority", 100 + existingRoutes * 10 }, { "Weight", 100 },
        { "Enabled", true }, { "HealthStatus", 0 },
        { "ConsecutiveFailures", 0 }, { "ConsecutiveSuccesses", 0 },
        { "MaxConcurrency", BsonNull.Value }, { "RateLimitPerMinute", BsonNull.Value },
        { "Notes", BsonNull.Value },
        { "CreatedAt", now }, { "UpdatedAt", now },
    });

    return (publicId, createdLogical, linkedToExisting, null, null);
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

    // 平台托管默认池不算阻挡：它的成员是**按用途自动收进来的派生结果**，不是谁手写的编排。
    // 派生出来的引用不该反过来否决它的来源——否则退役一条上游时会死锁：
    // 要删模型得先摘成员，而托管池又不许手工摘成员（APPEND_ONLY_POOL），两头堵死。
    // 删除路径会同步把成员从这类池里摘掉（见 PruneManagedPoolMembersAsync），
    // 注册表下次仍会按现存模型重新收敛，所以这里放行不会留下悬空引用。
    poolDocs = poolDocs.Where(p => !IsManagedAppendOnlyPool(p)).ToList();

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
    var now = DateTime.UtcNow;
    var priceObservedAt = d.AsNullableUtcDateTime("PriceObservedAt");
    var inputPrice = d.AsNullableDecimal("InputPricePerMillion");
    var outputPrice = d.AsNullableDecimal("OutputPricePerMillion");
    var pricePerCall = d.AsNullableDecimal("PricePerCall");
    var priceCurrency = PricingPolicy.NormalizeCurrency(d.AsNullableString("PriceCurrency"));
    var hasAnyPrice = PricingPolicy.HasAnyPrice(inputPrice, outputPrice, pricePerCall);
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
        InputPricePerMillion = inputPrice,
        OutputPricePerMillion = outputPrice,
        CachedInputPricePerMillion = d.AsNullableDecimal("CachedInputPricePerMillion"),
        CacheWritePricePerMillion = d.AsNullableDecimal("CacheWritePricePerMillion"),
        PricePerCall = pricePerCall,
        PriceCurrency = priceCurrency,
        PriceSource = PricingPolicy.NormalizeSource(d.AsNullableString("PriceSource")),
        PriceObservedAt = priceObservedAt.ToIso(),
        PriceUpdatedBy = d.AsNullableString("PriceUpdatedBy"),
        // 没配价的模型不叫「陈旧」，叫「没配」——两件事分开报，否则缺价会被淹在陈旧里。
        PriceStale = hasAnyPrice && PricingPolicy.IsStale(priceObservedAt, now),
        PriceAgeDays = PricingPolicy.AgeInDays(priceObservedAt, now),
        PriceBillable = PricingPolicy.IsBillable(inputPrice, outputPrice, pricePerCall, priceCurrency),
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

/// <summary>
/// 线路单价一句话。价格挂在**物理模型**上而不是对外模型上——同一个名字走不同上游本来就不同价，
/// 强行统一就是在账上撒谎。登记不全时返回 null，由面板如实说「单价未登记」，绝不补零。
/// </summary>
static string? DescribeRoutePrice(ModelOfferingItem route, IReadOnlyDictionary<string, BsonDocument> modelById)
{
    if (!string.Equals(route.TargetKind, "model", StringComparison.OrdinalIgnoreCase)) return null;
    if (!modelById.TryGetValue(route.TargetId, out var model)) return null;
    // 缺币种不当 USD。
    //
    // 这里原先写着 `?? "USD"`——存量模型只有数字没有币种时，面板照样给它贴上 USD。
    // 而记账那一侧对同一份数据判的是 stale_currency（不计入任何成本），存量归一又把
    // 缺币种当 CNY：同一个数字在三个地方有三种读法，面板给的还是最不该错的那一种，
    // 因为运维会照着它算账。
    //
    // 这是上一轮修 /v1/models 时该一起扫掉的同类（形状 6 的自查第三条：修完要横扫同类，
    // 同一个取值口径在别处还有没有）。当时只改了那一处，于是同一个病在这里原样留着。
    var currency = model.AsNullableString("PriceCurrency")?.Trim();
    var hasCurrency = !string.IsNullOrEmpty(currency);
    string Money(decimal value) => hasCurrency ? $"{currency} {value}" : $"{value}（币种未登记）";

    var perCall = model.AsNullableDecimal("PricePerCall");
    if (perCall is not null) return $"{Money(perCall.Value)} / 次";
    var input = model.AsNullableDecimal("InputPricePerMillion");
    var output = model.AsNullableDecimal("OutputPricePerMillion");
    if (input is null && output is null) return null;
    var inputText = input is null ? "未登记" : Money(input.Value);
    var outputText = output is null ? "未登记" : Money(output.Value);
    return $"入 {inputText} / 出 {outputText} 每百万 token";
}

/// <summary>
/// 这个对外模型近 N 天的账。只累加算出了钱的那部分，算不出的单独计数——
/// 把它们当零成本加进去会让这一屏看起来很省钱，而那正是缺价治理要避免的假象。
/// </summary>
static async Task<CallTraceLedger> BuildCallTraceLedgerAsync(
    IMongoCollection<BsonDocument> logs,
    HttpContext http,
    string publicId,
    int windowDays)
{
    var ledger = new CallTraceLedger { WindowDays = windowDays };
    if (string.IsNullOrWhiteSpace(publicId)) return ledger;

    var fb = Builders<BsonDocument>.Filter;
    var toUtc = DateTime.UtcNow;
    var fromUtc = toUtc.Date.AddDays(-(windowDays - 1));
    var filter = TenantAccess.FilterTeamScope(http, fb.And(
        fb.Gte("StartedAt", fromUtc),
        fb.Lte("StartedAt", toUtc),
        fb.Eq("LogicalModelPublicId", publicId)));

    var group = new BsonDocument("$group", new BsonDocument
    {
        { "_id", BsonNull.Value },
        { "calls", new BsonDocument("$sum", 1) },
        { "usd", LogCostAggregation.UsdSum() },
        // 「算不出钱的那些」= unpriced + stale_currency，两种都要数。
        //
        // stale_currency 的定义就是「有数字但币种过期或缺失，一律不计入成本」——
        // 它和 unpriced 一样不进 USD 合计、不进预算。只数字面的 unpriced 会让这一屏
        // 报「0 笔未计价」，而实际有一批存量 CNY / 缺币种的流量正被静悄悄排除在外，
        // 于是成本看起来偏低、而缺价治理这件事看起来已经做完了（形状 1：判据比它该管的范围窄）。
        // 判据取值与 GatewayCostStatusNames 那张表同源，见 2861 行那处过滤——那里两种都算。
        { "unpriced", LogCostAggregation.UnpricedCount() },
        { "lastAt", new BsonDocument("$max", "$StartedAt") },
    });
    var pipeline = new EmptyPipelineDefinition<BsonDocument>()
        .Match(filter)
        .AppendStage<BsonDocument, BsonDocument, BsonDocument>(group);
    var row = await logs.Aggregate(pipeline).FirstOrDefaultAsync();
    if (row is null) return ledger;

    ledger.Calls = row.AsNullableLong("calls") ?? 0;
    ledger.CostUsd = row.AsNullableDecimal("usd") ?? 0m;
    ledger.UnpricedCalls = row.AsNullableLong("unpriced") ?? 0;
    ledger.LastCallAt = row.AsNullableUtcDateTime("lastAt").ToIso();
    return ledger;
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

    // 排队名次与跳过原因由服务端算好下发。判据只有一份（CallTracePlanner，与运行时
    // GatewayRouteSelection 逐条对照），前端不再自己判——它此前那份
    // 「enabled && healthStatus === 0」会把「降级但仍在承接」的线路显示成「没有主」，
    // 而运行时照样在用它。
    var strategy = logical.AsNullableString("RoutingStrategy") ?? "priority";

    // 目标是否可用 = 那个物理模型（或兑换所）启用着，且它所属的上游也启用着。
    // 运行时在按 Offering 查目标时用 requireEnabled 过滤掉不可用的；这里必须算出同一个答案，
    // 否则面板会把一条指向已停用模型的线路报成「会落到它」——2026-09-14 就这么错过一次，
    // 线上 default-chat 的队首 chat-latest 物理模型是停用的，而面板照样指着它。
    bool TargetUsable(ModelOfferingItem offering)
    {
        if (string.Equals(offering.TargetKind, "exchange", StringComparison.OrdinalIgnoreCase))
        {
            /*
              兑换所启用着还不够，要判到**别名**那一层。

              运行时按 GatewayCatalogGate.ExchangeDeclares 判：这个兑换所声明过这条别名、
              而且那一条是启用着的。只判「兑换所整体启用着」的话，一条指向已被摘掉或单独停用的
              别名的线路会拿到一个正的排队名次，Quickstart 与调用全貌都说「会落到它」，
              而真调用当场就被拒（第 62 轮 review）。判据用镜像类，不在这儿现写一份近似。
            */
            return exchangeById.TryGetValue(offering.TargetId, out var exchange)
                && exchange.AsNullableBool("Enabled") == true
                && ExchangeAliasPolicy.Declares(
                    exchange,
                    ExchangeAliasPolicy.EffectiveAlias(exchange, offering.UpstreamModelId));
        }
        // 判的是 `== true` 而不是「不等于 false」：缺字段的文档运行时那条查询一条都匹配不上，
        // 控制面认它就会报出一个运行时用不了的队首（第 58 轮定的口径，这里同样适用）。
        if (!modelById.TryGetValue(offering.TargetId, out var target)) return false;
        if (target.AsNullableBool("Enabled") != true) return false;
        var platformId = target.AsNullableString("PlatformId");
        if (string.IsNullOrWhiteSpace(platformId)) return false;
        return platformById.TryGetValue(platformId, out var platform)
            && platform.AsNullableBool("Enabled") == true;
    }

    var candidates = offerings
        .Select(x => new CallTracePlanner.RouteCandidate(
            x.Id, x.Priority, x.Weight, x.HealthStatus, x.Enabled, TargetUsable(x)))
        .ToList();
    // seed 固定 0：面板是给人看的静态推演，不能每刷新一次换一个答案。
    // 运行时那边的 seed 由 requestId 派生，所以按权重分配时面板不指名道姓，只给比例。
    var queue = CallTracePlanner.Queue(candidates, CallTracePlanner.IsWeighted(strategy), 0);
    var positionById = queue
        .Select((x, index) => (x.Id, Position: index + 1))
        .ToDictionary(x => x.Id, x => x.Position, StringComparer.Ordinal);
    var candidateById = candidates.ToDictionary(x => x.Id, StringComparer.Ordinal);
    foreach (var offering in offerings)
    {
        var candidate = candidateById[offering.Id];
        offering.TargetUsable = candidate.TargetUsable;
        offering.SkipReason = CallTracePlanner.SkipReason(candidate);
        offering.QueuePosition = positionById.TryGetValue(offering.Id, out var position) ? position : 0;
    }

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
        // 存量文档没有这个字段，缺失一律按「不是默认」——不能猜，猜错就是悄悄换掉兜底模型
        IsDefaultForType = logical.AsNullableBool("IsDefaultForType") ?? false,
        DefaultForAppCallerCodes = logical.AsStringList("DefaultForAppCallerCodes"),
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

/// <summary>
/// 把 serving 回的失败翻译成用户能行动的一句话。
///
/// 为什么需要它：控制台调的是**自己这套网关**，此时冒出一个裸「401」对用户毫无意义——
/// 用户会问「系统就是服务网关，还有 401 问题?」。所以这里按 serving 的结构化错误码分类，
/// 每一类都给出「哪里坏了 + 去哪修」；认不出来的才退回带状态码的通用句（不编造原因）。
/// </summary>
static async Task<(string Detail, string Code)> ReadGatewayFailureDetailAsync(HttpResponseMessage response, CancellationToken ct)
{
    var status = (int)response.StatusCode;
    var code = string.Empty;
    try
    {
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!string.IsNullOrWhiteSpace(text))
        {
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object
                && err.TryGetProperty("code", out var codeEl) && codeEl.ValueKind == JsonValueKind.String)
            {
                code = codeEl.GetString() ?? string.Empty;
            }
        }
    }
    catch (JsonException) { /* serving 偶发非 JSON 错误体，走通用句 */ }
    catch (OperationCanceledException) { /* 调用方已取消，走通用句 */ }

    var detail = code switch
    {
        "GATEWAY_KEY_REQUIRED" or "GATEWAY_KEY_INVALID" =>
            "网关拒绝了系统自己的密钥（已失效或被撤销）。下次请求会自动重签一把；连续出现请在「服务网关设置」点一次「测试连接」看详情。",
        "GATEWAY_KEY_SCOPE_DENIED" =>
            "系统密钥的授权范围与本次调用对不上（来源、用途码或协议不一致）。去「服务网关设置」点「测试连接」重建这把密钥。",
        "GATEWAY_KEY_PURPOSE_DENIED" =>
            "系统密钥的用途不允许发业务请求。去「服务网关设置」点「测试连接」重建这把密钥。",
        "GATEWAY_KEY_OWNER_INACTIVE" or "GATEWAY_KEY_OWNER_ROLE_DENIED" =>
            "系统密钥被判成了「某个人名下的密钥」，而那个人的成员资格不满足。这把 key 应当属于系统本身——去「服务网关设置」点「测试连接」重建一把。",
        "GATEWAY_KEY_TENANT_INACTIVE" =>
            "当前租户不是 active 状态，网关拒绝一切调用。先去「团队与成员」确认租户状态。",
        "APPCALLER_POOL_UNBOUND" or "GATEWAY_CONFIG_UNAVAILABLE" =>
            "系统级用途码还没绑上可用的模型池。去「服务网关设置」选一个对话池或指定一个模型。",
        "MODEL_NOT_IN_CATALOG" =>
            "选中的模型不在内置名录里，也没有被管理员放行。去 Provider 页重新导入这个模型（名录外的要勾「放行」），或从池里换一个名录内的模型。",
        "LLM_ERROR" =>
            $"上游模型执行失败（网关已收到请求，是模型那一侧回的 {status}）。换一个池或模型再试。",
        _ when status == 404 => "没找到 serving 的对话端点，检查网关服务是否在运行。",
        _ when status >= 500 => $"网关服务内部错误（{status}）。",
        _ => $"网关返回 {status}{(code.Length > 0 ? $"（{code}）" : string.Empty)}。",
    };
    return (detail, code);
}

/// <summary>
/// 这个失败码，重签一把系统密钥能不能修好？
///
/// 只列「凭据本身有问题」的码。租户停用、池没绑、上游报错都**不在**列内——
/// 那些重签一万次也修不好，重试只会白烧一次调用（predicate-and-wiring-discipline
/// 形状 5：别造一个自己修不好自己的循环）。
/// </summary>
/// <summary>
/// 这一帧是不是 serving 在响应头已发出后回的失败帧？
///
/// 那种失败没有别的表达方式：HTTP 状态已经写出去了，只能夹在流里回一帧
/// <c>choices[0].finishReason = "error"</c> 外加一个顶层 <c>error</c>，随后 [DONE]。
/// 只挑 delta.content 的读法看不见它——模型若在失败前已经吐出一段可解析的 JSON，
/// 调用方会对一次失败且计费的调用回 ok:true。前端那条真实调用已按同一形状认了它。
/// </summary>
static bool TryReadIntentDraftStreamError(JsonElement root, out string message)
{
    message = string.Empty;
    var hasErrorObject = root.TryGetProperty("error", out var errorEl) && errorEl.ValueKind is JsonValueKind.Object;
    var finishedWithError = false;
    if (root.TryGetProperty("choices", out var choices)
        && choices.ValueKind == JsonValueKind.Array
        && choices.GetArrayLength() > 0)
    {
        var first = choices[0];
        // 两种命名都认：序列化口径换一次就漏，这类判据不该挂在某一种拼写上。
        if ((first.TryGetProperty("finishReason", out var finish) || first.TryGetProperty("finish_reason", out finish))
            && finish.ValueKind == JsonValueKind.String)
        {
            finishedWithError = string.Equals(finish.GetString(), "error", StringComparison.OrdinalIgnoreCase);
        }
    }
    if (!hasErrorObject && !finishedWithError) return false;

    message = "上游模型调用失败。";
    if (hasErrorObject
        && errorEl.TryGetProperty("message", out var msgEl)
        && msgEl.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(msgEl.GetString()))
    {
        message = msgEl.GetString()!.Trim();
        // 上限：这句会进 SSE 与浏览器里的推导痕迹，不能让上游想塞多长塞多长。
        // 内容本身保留——受众是本租户的网关管理员，而这一页的既有失败文案
        // （ReadGatewayFailureDetailAsync）也是这样把上游原因端给他的；
        // 换成一句不带信息的套话，反而违反「失败要给得出下一步」。
        if (message.Length > IntentDraftMaxErrorChars)
            message = message[..IntentDraftMaxErrorChars].TrimEnd() + "…";
        if (!message.EndsWith('.') && !message.EndsWith('。') && !message.EndsWith('…')) message += "。";
    }
    return true;
}

static bool IsSystemCredentialFixableCode(string code) => code is
    "GATEWAY_KEY_REQUIRED"
    or "GATEWAY_KEY_INVALID"
    or "GATEWAY_KEY_SCOPE_DENIED"
    or "GATEWAY_KEY_PURPOSE_DENIED"
    or "GATEWAY_KEY_OWNER_INACTIVE"
    or "GATEWAY_KEY_OWNER_ROLE_DENIED"
    // 这两个是「key 与 appCaller 归属团队对不上 / 团队被停用」。重签修得好，因为重签走
    // EnsureSystemTeamAsync：它会把系统团队重新激活，并让 key 与 appCaller 落到同一个团队。
    or "GATEWAY_KEY_TEAM_MISMATCH"
    or "GATEWAY_KEY_TEAM_INACTIVE";

/// <summary>
/// 这把存量系统 key，按 serving 现在的门禁还过得去吗？
///
/// 为什么要提前判而不是等它被拒：用户要的是「系统内部永远不会出现 401」。
/// 只在被拒之后才自愈，意味着每次门禁口径变化都要先让用户吃一次失败——
/// 所以复用前先对着门禁的判据把这把 key 过一遍，对不上就地重签，用户那一侧看不见失败。
///
/// 这里列的每一条都对应 serving 侧一个真实的拒绝分支（`GatewayRuntimeGovernance`）：
/// 停用/过期 → GATEWAY_KEY_INVALID；来源、用途码、协议、scope 任一不匹配 →
/// GATEWAY_KEY_SCOPE_DENIED；挂在某个人名下 → 那个人一离职就 GATEWAY_KEY_OWNER_INACTIVE；
/// 团队与 appCaller 不一致 → GATEWAY_KEY_TEAM_MISMATCH。
/// 判据故意写宽（有疑问就重签）：重签的代价是一次写库，判错的代价是用户看见 401。
/// </summary>
/// <summary>
/// 「库里那把系统凭据此刻还能直接用吗」——调用路径与设置页必须问这同一个函数。
///
/// 分成两处写的坏法是静默的：设置页只看 Enabled，于是 ApiKeyCrypto:Secret 轮换过、
/// 目录行丢了、或者 key 的团队/来源/scope 已经不合闸之后，页面照样写「就绪」，
/// 而下一次真调用要么当场重签、要么直接失败。用户盯着「就绪」二字排查一个不存在的状态。
///
/// 判据故意写宽（有疑问就当不可用）：重签的代价是一次写库，判错的代价是用户看见 401。
/// </summary>
/// <summary>
/// 鉴权目录里还有没有这把 key 的行。没有这一行，serving 查不到它，
/// 出站那一次会直接 401——而 key 文档本身看着一切正常（Enabled、没过期、合闸）。
/// 与上面那个判据成对使用：它管「这把 key 本身还成立吗」，这条管「serving 找得到它吗」。
/// </summary>
static async Task<bool> SystemKeyHasDirectoryRowAsync(
    IMongoCollection<BsonDocument> directory, string tenantId, string keyId)
{
    var found = await directory.Find(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("_id", keyId),
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId))).AnyAsync();
    return found;
}

static bool SystemKeyIsUsableNow(
    BsonDocument? storedKey,
    string? encryptedKeyMaterial,
    string expectedTeamId,
    string expectedSource,
    string expectedAppCaller,
    IConfiguration configuration)
{
    if (storedKey is null) return false;
    if (storedKey.AsNullableBool("Enabled") != true) return false;
    if (!SystemKeyStillPassesTheGate(storedKey, expectedTeamId, expectedSource, expectedAppCaller)) return false;
    // 密文解不开（轮换过加密密钥）等同于没有这把 key：出站那一头拿不到明文。
    var material = GwApiKeyCrypto.Decrypt(encryptedKeyMaterial, configuration);
    return material.Success && material.PlainText.Length > 0;
}

static bool SystemKeyStillPassesTheGate(BsonDocument key, string expectedTeamId, string expectedSource, string expectedAppCaller)
{
    static bool Has(BsonDocument doc, string field, string expected) =>
        doc.TryGetValue(field, out var raw)
        && raw.IsBsonArray
        && raw.AsBsonArray.Any(x => x.IsString && string.Equals(x.AsString, expected, StringComparison.Ordinal));

    if (key.AsNullableString("RotationState") is "revoked") return false;
    if (key.TryGetValue("ExpiresAt", out var expiresAt) && expiresAt.IsValidDateTime && expiresAt.ToUniversalTime() <= DateTime.UtcNow)
        return false;
    // CreatedByUserId 非空 = serving 会去查「这个人的成员资格还活着吗」。
    // 系统凭据不该有主人，早期版本写过 "system" 字符串，那批必须重签。
    if (!string.IsNullOrWhiteSpace(key.AsNullableString("CreatedByUserId"))) return false;
    if (!string.Equals(key.AsNullableString("TeamId"), expectedTeamId, StringComparison.Ordinal)) return false;
    // 来源与用途码由调用方传进来，不在这里再写一份字面量——签发时用的是哪个常量，
    // 校验时就必须是同一个常量，否则改了签发忘了改校验，这条判据会安静地失效。
    if (!string.Equals(key.AsNullableString("SourceSystem"), expectedSource, StringComparison.Ordinal)) return false;
    if (!Has(key, "AppCallerCodes", expectedAppCaller)) return false;
    if (!Has(key, "IngressProtocols", "openai-compatible")) return false;
    if (!Has(key, "Scopes", "invoke")) return false;
    return true;
}

/// <summary>
/// 从模型输出里取出两段码。模型被要求只输出 JSON，但仍可能裹 ```json 或带前后缀，
/// 所以按第一个 `{` 到最后一个 `}` 截取再解析——比让模型「再输出一次」便宜且稳定。
/// 解析不出来就返回 null，由调用方明说「模型没给出可用结果」，不猜、不兜底。
/// </summary>
static (string App, string Feature, string RequestType, string Reason)? ParseIntentDraft(string raw)
{
    if (string.IsNullOrWhiteSpace(raw)) return null;
    var start = raw.IndexOf('{');
    var end = raw.LastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try
    {
        using var doc = JsonDocument.Parse(raw[start..(end + 1)]);
        var root = doc.RootElement;
        string Read(string name) => root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
            ? (el.GetString() ?? string.Empty).Trim()
            : string.Empty;
        var requestType = Read("requestType").ToLowerInvariant();
        return (
            Read("app").ToLowerInvariant(),
            Read("feature").ToLowerInvariant(),
            requestType is "chat" or "vision" ? requestType : "chat",
            Read("reason"));
    }
    catch (JsonException)
    {
        return null;
    }
}

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
    IMongoCollection<BsonDocument> gwLogicalModels,
    IMongoCollection<BsonDocument> gwModelOfferings,
    IMongoCollection<BsonDocument> gwMigrations,
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
            gwLogicalModels,
            gwModelOfferings,
            gwMigrations,
            tenantId,
            effectiveStatus,
            effectiveModelPoolId,
            effectiveModelPolicy,
            doc.GetStringOrEmpty("RequestType"),
            allowedModelPoolIds: GetStringArray(doc, "AllowedModelPoolIds"),
            defaultModelPoolId: doc.AsNullableString("DefaultModelPoolId"),
            appCallerCode: doc.AsNullableString("AppCallerCode"));
        if (error is not null)
        {
            var code = doc.AsNullableString("AppCallerCode") ?? doc.GetStringOrEmpty("_id");
            return $"{code}: {error}";
        }
    }
    return null;
}

/// <summary>
/// 「其余那些为什么没落到它」——按真实构成如实说，不写死成某几种。
///
/// 上一版这句话写死了「配了专属池或未放行」。断流之后原因变成了「被别的模型认领了」，
/// 那句总结就开始说不准——逐调用方那一栏是对的，总结却在撒一个小谎。
/// 判据要么来自数据，要么就别下结论（形状 1：判据比它该管的范围窄）。
///
/// 2026-09-16 模型池退场，「配了专属池」这一档跟着消失：运行时不再看 AllowedModelPoolIds，
/// 只要放行就认这张目录。剩下三种真实原因——被别的模型认领、未放行、这个用途的默认不是它。
/// </summary>
static string DescribeMissReasons(IReadOnlyList<CallTraceUnnamedCaller> callers)
{
    var parts = new List<string>();
    var rejected = callers.Count(x => string.Equals(x.Reach, nameof(CallTracePlanner.CallerReach.TrafficRejected), StringComparison.Ordinal));
    var claimed = callers.Count(x => !x.ReachesThisModel && x.Verdict.Contains("认领了", StringComparison.Ordinal));
    var other = callers.Count(x => !x.ReachesThisModel) - rejected - claimed;
    if (claimed > 0) parts.Add($"{claimed} 个被别的模型认领");
    if (rejected > 0) parts.Add($"{rejected} 个未放行");
    if (other > 0) parts.Add($"{other} 个这个用途的默认不是它");
    return parts.Count == 0 ? "没有别人" : string.Join("、", parts);
}

/// <summary>
/// 不点名的请求，这个用途下有没有对外模型接得住这个调用方；接得住就回它的 PublicId。
///
/// 判据与运行时 <c>TryResolveDefaultLogicalModelAsync</c> **两层逐条对齐**：
///   1. 有没有模型认领了这个调用方（DefaultForAppCallerCodes）
///   2. 没有，才看这个用途标了默认的那个
///
/// 「有一条线路」这件事同样要按运行时的口径判，不能只看 Offering 的 Enabled 开关。
/// 运行时还会拒掉：健康档是 Unavailable 的、目标模型或它的平台已停用或压根不在了的、
/// 以及这个对外模型的授权名单不含该调用方的。只看 Enabled 的后果是**闸门放行、请求全灭**——
/// 发布门禁说「都有人接」，而每一条真实请求回 MODEL_NOT_FOUND，
/// 那比没有闸门更糟：它让人以为这件事已经验过了（形状 8：拿一份不成立的证据当成证明）。
///
/// 为什么这个判据必须在写入侧也有一份：把调用方改成 active 却没人接得住，它不会当场报错，
/// 而是等到第一个真实请求才静默失败。守卫钉住两边的顺序一致。
/// </summary>
static async Task<string?> FindUnnamedCatcherAsync(
    IMongoCollection<BsonDocument> gwLogicalModels,
    IMongoCollection<BsonDocument> gwModelOfferings,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> gwPlatforms,
    IMongoCollection<BsonDocument> gwModelExchanges,
    IMongoCollection<BsonDocument> gwMigrations,
    string tenantId,
    string? requestType,
    string? appCallerCode)
{
    if (string.IsNullOrWhiteSpace(requestType)) return null;
    var fb = Builders<BsonDocument>.Filter;
    var tenantFilter = fb.Eq("TenantId", tenantId);
    var basics = fb.And(tenantFilter, fb.Eq("Enabled", true), fb.Eq("ModelType", requestType));

    // 目标可用性要查三张表，但一次调用里只查一遍——候选模型通常不止一个，
    // 逐个去打库会把一次发布门禁变成几十次往返。
    HashSet<string>? enabledPlatformIds = null;
    Dictionary<string, BsonDocument>? enabledModelById = null;
    Dictionary<string, BsonDocument>? enabledExchangeById = null;

    /*
      名录门这道闸也要判。

      运行时在解析出口上还有一道 ApplyCatalogGateAsync：名录外、又没盖放行标记的模型
      一律回 MODEL_NOT_IN_CATALOG。这道闸不判的话，一条「模型启用、平台启用」但过不了
      名录门的线路会被算成可用——发布闸放行，而经这条线路的每一次请求都失败。

      「要不要拦」的权威判据是两半：配置没降到 observe，且控制台那几条补标记迁移都跑完了。
      控制台读不到数据面进程的配置（那是另一个容器的 IConfiguration），所以这里只能判后一半。
      差别只在「有人用 observe 降过档」这一种紧急情况下出现，而那时这道闸会比运行时严
      （报「没人接得住」）——宁可这样，也不能反过来放行一条必失败的线路。
    */
    bool? catalogGateEnforces = null;
    async Task<bool> CatalogGateEnforcesAsync()
        => catalogGateEnforces ??= await CatalogGatePolicy.EnforcesAsync(gwMigrations);

    async Task EnsureTargetsLoadedAsync()
    {
        /*
          启用判据要与运行时**逐字**相同：`Enabled == true`，不是「不等于 false」。

          两者只在一种输入上分道扬镳：文档里压根没有 Enabled 这个字段（存量数据、直接写库）。
          `Ne("Enabled", false)` 认它，而运行时那条 `Eq(x => x.Enabled, true)` 在服务端匹配，
          缺字段的文档一条都匹配不上。于是这道闸说「这个调用方有人接得住」，而每一个请求都解析
          不到——控制面替数据面打了包票，包票是假的（第 58 轮 review；形状 1：判据比它该管的
          范围窄，「缺字段」这一种输入让两边给出相反答案）。
          这里跟紧的一侧是运行时：控制面可以比运行时严，绝不能比它松。
        */
        if (enabledPlatformIds is not null) return;
        enabledPlatformIds = (await gwPlatforms.Find(fb.And(tenantFilter, fb.Eq("Enabled", true)))
                .Project(Builders<BsonDocument>.Projection.Include("_id"))
                .ToListAsync())
            .Select(x => x.GetStringOrEmpty("_id"))
            .Where(x => x.Length > 0)
            .ToHashSet(StringComparer.Ordinal);
        // 取整份模型文档：名录门要判它的模型名与放行标记，不只是平台 id。
        enabledModelById = (await gwModels.Find(fb.And(tenantFilter, fb.Eq("Enabled", true)))
                .Project(Builders<BsonDocument>.Projection
                    .Include("_id").Include("PlatformId").Include("ModelName")
                    .Include("ModelNameNormalized").Include("AllowedOutsideCatalog"))
                .ToListAsync())
            .Where(x => x.GetStringOrEmpty("_id").Length > 0)
            .GroupBy(x => x.GetStringOrEmpty("_id"), StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.First(), StringComparer.Ordinal);
        // 取整份兑换所文档而不只是 id：下面要判到**别名**那一层，
        // 只判「兑换所启用着」会把一条别名已被摘掉或单独停用的线路算成可用。
        enabledExchangeById = (await gwModelExchanges.Find(fb.And(tenantFilter, fb.Eq("Enabled", true)))
                .Project(Builders<BsonDocument>.Projection
                    .Include("_id").Include("ModelAlias").Include("ModelAliases").Include("Models"))
                .ToListAsync())
            .Where(x => x.GetStringOrEmpty("_id").Length > 0)
            .GroupBy(x => x.GetStringOrEmpty("_id"), StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.First(), StringComparer.Ordinal);
    }

    async Task<bool> HasRuntimeUsableRouteAsync(string logicalId)
    {
        var offerings = await gwModelOfferings.Find(fb.And(
            tenantFilter,
            fb.Eq("LogicalModelId", logicalId),
            fb.Eq("Enabled", true),
            // 健康档 2 = Unavailable。运行时会跳过它，闸门也必须跳过——
            // 全部线路都是 Unavailable 的模型接不住任何请求。
            fb.Ne("HealthStatus", 2))).ToListAsync();
        if (offerings.Count == 0) return false;

        await EnsureTargetsLoadedAsync();
        foreach (var offering in offerings)
        {
            var targetId = offering.GetStringOrEmpty("TargetId");
            if (targetId.Length == 0) continue;
            if (string.Equals(offering.AsNullableString("TargetKind"), "exchange", StringComparison.OrdinalIgnoreCase))
            {
                /*
                  判到**别名**那一层，不是只判兑换所文档启用。

                  线路打给上游的是哪一个别名由 UpstreamModelId 决定（没写就回落到主别名）。
                  管理员把一条别名从兑换所里摘掉、或单独停掉之后，兑换所照样启用着，
                  而运行时按 ExchangeDeclares 把这条线路整条跳过。只判 id 的话，
                  这道闸会说「有能用的线路」，而那个调用方一条路都走不通——闸门替一条
                  不存在的路作了保。判据与写入侧、与运行时同一份（ExchangeAliasPolicy）。
                */
                if (!enabledExchangeById!.TryGetValue(targetId, out var exchange)) continue;
                var exchangeAlias = ExchangeAliasPolicy.EffectiveAlias(
                    exchange, offering.AsNullableString("UpstreamModelId"));
                if (CatalogGatePolicy.ExchangeRoutePasses(
                        exchange,
                        offering.AsNullableString("UpstreamModelId"),
                        await CatalogGateEnforcesAsync()))
                {
                    return true;
                }
                continue;
            }
            // 目标模型在不在、启用没有，以及它挂的平台启用没有——运行时这三样缺一条都解析不出来。
            if (!enabledModelById!.TryGetValue(targetId, out var targetModel)) continue;
            var targetPlatformId = targetModel.GetStringOrEmpty("PlatformId");
            if (targetPlatformId.Length == 0 || !enabledPlatformIds!.Contains(targetPlatformId)) continue;
            // 名录门判的是这条线路**实际打出去的那个名字**（UpstreamModelId 覆盖之后），
            // 不是目标文档自己的名字——与对外清单、就绪探针、运行时同一个取值口径。
            var effectiveUpstream = offering.AsNullableString("UpstreamModelId") is { Length: > 0 } overridden
                ? overridden.Trim()
                : targetModel.GetStringOrEmpty("ModelName");
            var gateEnforces = await CatalogGateEnforcesAsync();
            // 名录内零额外开销；只有名录外的才多一次带索引的读，与运行时同一个顺序。
            var sameName = !gateEnforces || ModelCatalog.Contains(effectiveUpstream)
                ? []
                : await gwModels.Find(fb.And(
                    tenantFilter,
                    fb.Eq("PlatformId", targetPlatformId),
                    fb.Or(
                        fb.Eq("ModelName", effectiveUpstream),
                        fb.Eq("ModelNameNormalized", effectiveUpstream.ToLowerInvariant())))).ToListAsync();
            if (CatalogGatePolicy.PhysicalRoutePasses(effectiveUpstream, sameName, gateEnforces))
            {
                return true;
            }
        }
        return false;
    }

    /*
      这个模型接不接得住这个调用方——**授权名单与场景能力是同一道门**。

      运行时走的是 ResolveFromLogicalModelAsync 里那句 SupportsAppCallerScenario：
      它先看授权名单，再看这个调用方要的场景能力（text2img / img2img / vision_generation …）
      模型具不具备。这道闸原来只判了前一半，于是一个只会文生图的模型会被判成
      「接得住图生图调用方」，发布闸放行，而运行时对那个调用方的每一次请求都回能力不匹配。

      判据走控制台这一侧的镜像（LogicalModelCapabilityPolicy，与权威实现有逐条对照守卫），
      不在这里再写一份近似。
    */
    // 空 code 也原样交给它判，不在外面加一道自己的门：运行时就是这么判的
    // （名单非空 → 拒；名单为空且没有场景要求 → 放行）。在这里额外拦一手就比运行时窄了。
    static bool AllowsCaller(BsonDocument logical, string? code)
        => LogicalModelCapabilityPolicy.SupportsAppCallerScenario(
            GetStringArray(logical, "Capabilities"),
            GetStringArray(logical, "AllowedAppCallerCodes"),
            code ?? string.Empty);

    /*
      挑选与「这一条能不能用」的顺序不能颠倒，这道闸和运行时、和 serving 就绪探针同序。

      运行时是：先按认领选出**那一条**，再去解析它；解析不出来就如实失败，
      **不会**回头去试用途默认（TryResolveDefaultLogicalModelAsync 里第二层写的是
      `logical ??=`——只在第一层一条都没查到时才走，而不是在第一层那条不可用时才走）。

      上一版这里是「一边挑一边筛」：认领了这个调用方、但授权不通或线路全挂的模型被跳过，
      循环接着去试用途默认，于是一个「认领坏了 + 默认健康」的调用方在这道闸上判绿——
      而它真实的不点名请求每一次都失败。闸门替另一条根本不会走的路作了保。
    */
    async Task<BsonDocument?> FirstAsync(FilterDefinition<BsonDocument> filter)
        => await gwLogicalModels.Find(filter)
            .Sort(Builders<BsonDocument>.Sort.Ascending("DisplayOrder").Ascending("PublicId"))
            .FirstOrDefaultAsync();

    async Task<string?> NameIfUsableAsync(BsonDocument doc)
    {
        if (!AllowsCaller(doc, appCallerCode)) return null;
        if (!await HasRuntimeUsableRouteAsync(doc.GetStringOrEmpty("_id"))) return null;
        return doc.AsNullableString("PublicId") ?? doc.GetStringOrEmpty("_id");
    }

    // 第一层：谁认领了它。认领是排他的——挑中之后成败就看它自己，不再往下找。
    if (!string.IsNullOrWhiteSpace(appCallerCode))
    {
        var claimed = await FirstAsync(
            fb.And(basics, fb.AnyEq("DefaultForAppCallerCodes", appCallerCode)));
        if (claimed is not null) return await NameIfUsableAsync(claimed);
    }

    // 第二层：这个用途的默认。只有「一条认领都没有」时才走到这里。
    var typeDefault = await FirstAsync(fb.And(basics, fb.Eq("IsDefaultForType", true)));
    return typeDefault is null ? null : await NameIfUsableAsync(typeDefault);
}

static async Task<string?> ValidateActiveGatewayAppCallerConfigAsync(
    IMongoCollection<BsonDocument> gwModelPools,
    IMongoCollection<BsonDocument> gwPlatforms,
    IMongoCollection<BsonDocument> gwModels,
    IMongoCollection<BsonDocument> gwModelExchanges,
    IMongoCollection<BsonDocument> gwLogicalModels,
    IMongoCollection<BsonDocument> gwModelOfferings,
    IMongoCollection<BsonDocument> gwMigrations,
    string tenantId,
    string? status,
    string? modelPoolId,
    string? modelPolicy,
    string? requestType,
    IReadOnlyList<string>? allowedModelPoolIds = null,
    string? defaultModelPoolId = null,
    string? appCallerCode = null)
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

    /*
      「谁接得住不点名的请求」**无条件**要判，不看调用方身上还留着什么池字段。

      原来的写法是：有残留池绑定就整个跳过这道判断，转而去校验那个池。而运行时早就不读
      ModelPoolId / AllowedModelPoolIds / DefaultModelPoolId 了，于是这个分支两头都错——
      一个健康的旧池能替一个「其实没有对外模型接得住」的调用方背书（假绿）；
      一个已被删掉的旧池又会拦住与它无关的治理改动（误伤），而它指的那个 /pools 页面
      现在 302 到对外模型页、写端点全删了，那条错误信息给不出任何可执行的下一步。

      判据换成真正在跑的那一条：不点名的请求得有人接得住（认领 → 用途默认，两层都要求
      启用、授权放行、且真有一条运行时可用的线路）。
    */
    var catcher = await FindUnnamedCatcherAsync(
        gwLogicalModels, gwModelOfferings, gwModels, gwPlatforms, gwModelExchanges, gwMigrations,
        tenantId, requestType, appCallerCode);
    if (catcher is null)
    {
        return $"active appCaller 在 {requestType} 这个用途下没有对外模型接得住它："
            + "要么在模型页给某个对外模型「指定调用方」认领它，要么给这个用途设一个默认模型"
            + "（它得启用、授权放行、并且至少有一条健康的线路指向启用的上游）。";
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
        return null;
    }

    /*
      还带着池绑定的调用方，点名发的是**池 ID**（model_policy=pool 那套契约还在外面活着）。
      池路由已经删了，那条请求现在靠「对外模型记住了自己是从哪个池搬来的」接住
      （MigratedFromPoolIds）。所以这里要校验的不再是那个池文档本身，而是它的后继——
      去查已经不参与解析的旧池，只能得出一个与真实行为无关的结论。
    */
    var successor = await gwLogicalModels.Find(Builders<BsonDocument>.Filter.And(
        Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
        Builders<BsonDocument>.Filter.Eq("Enabled", true),
        Builders<BsonDocument>.Filter.AnyEq("MigratedFromPoolIds", effectivePoolId))).FirstOrDefaultAsync();
    if (successor is null)
    {
        return $"active appCaller 还绑着模型池 {effectivePoolId}，但没有任何对外模型记着它是从这个池搬来的："
            + "池路由已经退场，按池 ID 点名的请求会解析不到。先跑一次 POST /gw/pools/migrate-to-models "
            + "把这个池搬成对外模型，或把这个调用方改成不点名（由认领或用途默认接住）。";
    }

    var successorType = successor.AsNullableString("ModelType");
    if (!string.IsNullOrWhiteSpace(successorType)
        && !string.IsNullOrWhiteSpace(requestType)
        && !string.Equals(successorType, requestType, StringComparison.OrdinalIgnoreCase))
    {
        return $"active appCaller 绑定的池搬迁成的对外模型是 {successorType} 用途，与调用类型 {requestType} 不一致。";
    }

    return null;
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
    return IsResolvablePoolMemberKey(
        member.GetStringOrEmpty("ModelId"),
        member.GetStringOrEmpty("PlatformId"),
        enabledPlatformIds,
        enabledModels,
        enabledExchanges);
}

/// <summary>
/// 把「指不到任何上游 / 模型」的成员在**展示层**归一成不可用，并写明原因。
///
/// 只看存库的 HealthStatus 会把这种成员算成健康——它从没失败过，因为它从来没被
/// 调用成功过一次。于是一个一次请求都发不出去的池在控制台上显示「健康」，
/// 正好骗过要靠它做判断的人（形状 8）。
///
/// 归一必须发生在任何计数之前：池级徽章、成员顺位的圆点、可用/不可用三个数字读的是
/// 同一个字段，只改其中一处就会出现「池标已中断、第 1 顺位却是绿点」的自相矛盾。
/// 只作用于本次响应，不回写库——库里的健康状态仍由真实调用结果决定。
/// </summary>
static PoolItem ApplyPoolMemberResolution(PoolItem item, PoolResolutionIndex index)
{
    foreach (var model in item.Models)
    {
        // Removable 对**每个**成员都算：它只看「指向的东西还在不在」，与健康状态无关。
        // 原来它跟着 HealthStatus==2 一起早退，于是「上游被删之前就已经失败到不可用」的成员
        // 永远拿不到标记、控制台不给按钮，而后端其实允许删它。
        model.Removable = IsDeadPoolMember(model.ModelId, model.PlatformId, index);

        if (IsResolvablePoolMemberKey(model.ModelId, model.PlatformId, index.PlatformIds, index.Models, index.Exchanges))
            continue;
        // 归因是给人看的文案，不参与「能不能摘除」的判断——它算错了只影响措辞，不影响按钮
        model.UnavailableReason = ClassifyUnavailableReason(model, index);
        if (model.HealthStatus == 2) continue;
        model.HealthStatus = 2;
        model.HealthStatusLabel = HealthLabel(2);
    }
    return item;
}

/// <summary>
/// 这个成员为什么不可用。四种，两两成对：
/// <c>upstream-missing</c> / <c>model-missing</c> 是死成员，不可逆，该给摘除入口；
/// <c>upstream-disabled</c> / <c>model-disabled</c> 只是被停用，启用即恢复，**不该**给摘除入口。
///
/// 必须分开的原因：可解析索引按「存在且启用」算，而后端的悬空判定只查存在性。
/// 不分开的话，一个仅仅被停用的上游会被标成「已不存在」并在控制台长出一个摘除按钮，
/// 点下去后端必然回 APPEND_ONLY_POOL —— 一个可预见会失败的操作，
/// 外加一句撒谎的归因（「已不存在」其实只是停用）。
/// </summary>
static string ClassifyUnavailableReason(PoolModelItem model, PoolResolutionIndex index)
{
    // 中继成员的 PlatformId 不是平台 id，对它而言「上游」就是那条中继本身，
    // 「模型」是中继里那条 Models 映射。两者各有独立的 Enabled，必须分开看：
    // 合成一个结论就会叫运维去启用一个本来就启用着的中继（形状 1：判据比它该管的范围窄）。
    var exchangeDoc = index.ExistingExchanges
        .FirstOrDefault(e => string.Equals(e.GetStringOrEmpty("_id"), model.PlatformId, StringComparison.Ordinal));
    var isAnyExchangeMember = string.Equals(model.PlatformId, "__exchange__", StringComparison.Ordinal);

    if (isAnyExchangeMember)
    {
        // __exchange__ 没点名上游，只能问「有没有哪条中继认这个模型」。
        // 启用着的中继里能找到这条映射，却仍解析不到 → 只可能是映射本身被停用。
        if (index.Exchanges.Any(e => GatewayExchangeSupportsModel(e, model.ModelId, ignoreEntryDisabled: true)))
            return "model-disabled";
        return index.ExistingExchanges.Any(e => GatewayExchangeSupportsModel(e, model.ModelId, ignoreEntryDisabled: true))
            ? "upstream-disabled"
            : "upstream-missing";
    }

    if (exchangeDoc is not null)
    {
        // 存在性必须忽略嵌套 Enabled：映射被停用不等于上游没了。
        // 走 IsResolvablePoolMemberKey 会连带套上「能不能用」的过滤，
        // 于是一条只是被停用的映射被说成「上游已不存在」，给的下一步就错了。
        if (!GatewayExchangeSupportsModel(exchangeDoc, model.ModelId, ignoreEntryDisabled: true))
            return "model-missing";
        // 中继在、映射也在，却解析不到：中继整条停用 → upstream-disabled；
        // 中继启用着 → 只剩「这条映射被停用」这一种可能。
        return index.Exchanges.Any(e => string.Equals(e.GetStringOrEmpty("_id"), model.PlatformId, StringComparison.Ordinal))
            ? "model-disabled"
            : "upstream-disabled";
    }

    var existsAtAll = IsResolvablePoolMemberKey(
        model.ModelId, model.PlatformId,
        index.ExistingPlatformIds, index.ExistingModels, index.ExistingExchanges);

    if (existsAtAll)
        return index.PlatformIds.Contains(model.PlatformId) ? "model-disabled" : "upstream-disabled";
    return index.ExistingPlatformIds.Contains(model.PlatformId) ? "model-missing" : "upstream-missing";
}

/// <summary>
/// (modelId, platformId) 这对键还指得到一个能用的成员吗——不看健康状态，只看指得到指不到。
///
/// 抽出来是为了让「默认池成员校验」与「池健康统计」共用同一个口径：
/// 两处各写一份判定，就会出现一边说这成员是死的、一边把它算成 healthy（形状 3 + 形状 8）。
/// </summary>
static bool IsResolvablePoolMemberKey(
    string modelId,
    string platformId,
    HashSet<string> enabledPlatformIds,
    List<BsonDocument> enabledModels,
    List<BsonDocument> enabledExchanges)
{
    if (modelId.Length == 0 || platformId.Length == 0) return false;
    if (string.Equals(platformId, "__exchange__", StringComparison.Ordinal))
    {
        return enabledExchanges.Any(exchange => GatewayExchangeSupportsModel(exchange, modelId));
    }
    var exchangeById = enabledExchanges.FirstOrDefault(exchange => string.Equals(exchange.GetStringOrEmpty("_id"), platformId, StringComparison.Ordinal));
    if (exchangeById is not null) return GatewayExchangeSupportsModel(exchangeById, modelId);
    if (!enabledPlatformIds.Contains(platformId)) return false;
    return enabledModels.Any(model => PoolMemberMatchesModelDoc(model, platformId, modelId));
}

/// <summary>
/// 一条模型文档是不是池成员 (modelId, platformId) 指的那个。
///
/// modelId 不是单一口径：历史数据里它可能是模型文档 _id，也可能是 ModelName 或 Name，三个都要认。
/// 抽成一处是因为「指不指得到」这件事有两个调用方（可解析判定、死成员判定），
/// 各写一份必然漂移，然后一边说这成员死了、一边说它还活着（形状 3）。
/// </summary>
static bool PoolMemberMatchesModelDoc(BsonDocument model, string platformId, string modelId)
    => string.Equals(model.AsNullableString("PlatformId"), platformId, StringComparison.Ordinal)
    && (string.Equals(model.GetStringOrEmpty("_id"), modelId, StringComparison.Ordinal)
        || string.Equals(model.AsNullableString("ModelName"), modelId, StringComparison.Ordinal)
        || string.Equals(model.AsNullableString("Name"), modelId, StringComparison.Ordinal));

/// <summary>
/// 这条中继承不承接这个模型。
///
/// <paramref name="ignoreEntryDisabled"/> 分开两个问题：**能不能用**（默认，嵌套 Models 里
/// <c>Enabled:false</c> 的那条不算数）与**存不存在**（判「上游没了」还是「只是被停用」时用，
/// 此时必须忽略嵌套 Enabled）。混用会让一条只是被停用的映射被说成「上游已不存在」。
/// </summary>
static bool GatewayExchangeSupportsModel(BsonDocument exchange, string modelId, bool ignoreEntryDisabled = false)
{
    if (string.Equals(exchange.AsNullableString("ModelAlias"), modelId, StringComparison.Ordinal)) return true;
    if (exchange.AsStringList("ModelAliases").Contains(modelId, StringComparer.Ordinal)) return true;
    if (!exchange.TryGetValue("Models", out var modelsValue) || !modelsValue.IsBsonArray) return false;
    return modelsValue.AsBsonArray
        .Where(x => x.IsBsonDocument)
        .Select(x => x.AsBsonDocument)
        .Any(m => (ignoreEntryDisabled || (m.AsNullableBool("Enabled") ?? true))
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

/// <summary>
/// 这条日志算没算出钱。新日志直接读 CostStatus；2026-09 之前的存量日志没有这个字段，
/// 才按「有 token 就得有对应单价」反推一遍，口径与当时的写入侧一致。
/// </summary>
static string ResolveLogCostStatus(BsonDocument d)
{
    var status = d.AsNullableString("CostStatus")?.Trim().ToLowerInvariant();
    if (status is GatewayCostStatusNames.Priced
        or GatewayCostStatusNames.Unpriced
        or GatewayCostStatusNames.StaleCurrency
        or GatewayCostStatusNames.NoUsage)
    {
        return status;
    }

    var inputTokens = d.AsNullableInt("InputTokens") ?? 0;
    var outputTokens = d.AsNullableInt("OutputTokens") ?? 0;
    if (inputTokens <= 0 && outputTokens <= 0 && d.AsNullableDecimal("EstimatedCost") is null)
    {
        return GatewayCostStatusNames.NoUsage;
    }

    var complete = (inputTokens <= 0 || d.AsNullableDecimal("InputPricePerMillion") is not null)
        && (outputTokens <= 0 || d.AsNullableDecimal("OutputPricePerMillion") is not null);
    if (!complete || d.AsNullableDecimal("EstimatedCost") is null)
    {
        return GatewayCostStatusNames.Unpriced;
    }

    /*
      非美金的存量行一律算「口径待迁移」，不算已计价。

      NormalizePriceCurrency 认 CNY 与 USD 两种（它的用途是校验入参），拿它当
      「算没算出美金」的判据就会把一条 CNY 的存量行标成 priced——而计价器把一切非美金
      判成 stale_currency、聚合那一侧又因为 EstimatedCostUsd 为空把同一行算进 unpriced。
      同一行三处三个说法，摘要于是虚报覆盖率（形状 3：判据分裂各自漂移）。
      这套账只认美金，判据也只认美金。
    */
    return string.Equals(
        NormalizePriceCurrency(d.AsNullableString("EstimatedCostCurrency")),
        GatewayCostStatusNames.BillingCurrency,
        StringComparison.Ordinal)
        ? GatewayCostStatusNames.Priced
        : GatewayCostStatusNames.StaleCurrency;
}

/// <summary>
/// 网关写进日志的成本状态取值。console-api 是独立工程、引用不到网关那份常量，
/// 只能在这里复述一份；两边漂移会让统计口径和写入口径对不上，所以由
/// <c>GatewayCostStatusMirrorGuardTests</c> 从源码上钉住。
/// </summary>
static class GatewayCostStatusNames
{
    /// <summary>这套账只认这一种币种，与 GatewayCostCalculator.BillingCurrency 同值（镜像守卫钉住）。</summary>
    public const string BillingCurrency = "USD";

    public const string Priced = "priced";
    public const string Unpriced = "unpriced";
    public const string StaleCurrency = "stale_currency";
    public const string NoUsage = "no_usage";
}

/// <summary>
/// 聚合侧的「这条调用算没算出钱」。它是 <see cref="ResolveLogCostStatus"/> 在 Mongo 表达式里的镜像。
///
/// 为什么非要镜像不可：2026-09 之前的存量日志没有 CostStatus 字段，而聚合里写
/// `$eq CostStatus priced` 时 Mongo 对缺字段判 false——那批**算出过钱**的日志于是一律记 0，
/// 模型卡与账本在上线当天就把历史花费报少了一截。`/gw/logs/summary` 那条路早就用
/// ResolveLogCostStatus 回填了，两条路各判各的（形状 3：同一个判据分裂成两份然后各自漂移）。
///
/// 两个表达式都从这里取，调用点不许自己拼。
/// </summary>
static class LogCostAggregation
{
    /// <summary>显式判定为「算不出钱」的那几种状态：它们一律不进美金合计。</summary>
    private static BsonArray NotPricedStatuses => new()
    {
        GatewayCostStatusNames.Unpriced,
        GatewayCostStatusNames.StaleCurrency,
        GatewayCostStatusNames.NoUsage,
    };

    /// <summary>这一档是不是存量日志（四种已知状态之外，含缺字段）。</summary>
    private static BsonDocument IsLegacy => new("$not", new BsonArray
    {
        new BsonDocument("$in", new BsonArray
        {
            "$CostStatus",
            new BsonArray
            {
                GatewayCostStatusNames.Priced,
                GatewayCostStatusNames.Unpriced,
                GatewayCostStatusNames.StaleCurrency,
                GatewayCostStatusNames.NoUsage,
            },
        }),
    });

    /// <summary>
    /// 累加进美金合计的那一部分。显式非计价的排除，其余按写入时算出的 EstimatedCostUsd 累加——
    /// 那个字段本来就只在判定为已计价时才会有值（见 GatewayCostCalculator），存量日志同理。
    /// </summary>
    public static BsonDocument UsdSum() => new("$sum", new BsonDocument("$cond", new BsonArray
    {
        new BsonDocument("$in", new BsonArray { "$CostStatus", NotPricedStatuses }),
        0,
        new BsonDocument("$ifNull", new BsonArray { "$EstimatedCostUsd", 0 }),
    }));

    /// <summary>
    /// 「算不出钱的那些」= unpriced + stale_currency，两种都要数。
    ///
    /// stale_currency 的定义就是「有数字但币种过期或缺失，一律不计入成本」——它和 unpriced
    /// 一样不进 USD 合计、不进预算。只数字面的 unpriced 会让这一屏报「0 笔未计价」，
    /// 而实际有一批存量 CNY / 缺币种的流量正被静悄悄排除在外。
    /// 存量日志按 ResolveLogCostStatus 的同一条口径回退：有用量、却没算出钱的，算未计价。
    /// </summary>
    public static BsonDocument UnpricedCount() => new("$sum", new BsonDocument("$cond", new BsonArray
    {
        new BsonDocument("$in", new BsonArray
        {
            "$CostStatus",
            new BsonArray { GatewayCostStatusNames.Unpriced, GatewayCostStatusNames.StaleCurrency },
        }),
        1,
        new BsonDocument("$cond", new BsonArray
        {
            new BsonDocument("$and", new BsonArray
            {
                IsLegacy,
                new BsonDocument("$gt", new BsonArray
                {
                    new BsonDocument("$add", new BsonArray
                    {
                        new BsonDocument("$ifNull", new BsonArray { "$InputTokens", 0 }),
                        new BsonDocument("$ifNull", new BsonArray { "$OutputTokens", 0 }),
                    }),
                    0,
                }),
                new BsonDocument("$eq", new BsonArray
                {
                    new BsonDocument("$ifNull", new BsonArray { "$EstimatedCostUsd", BsonNull.Value }),
                    BsonNull.Value,
                }),
            }),
            1,
            0,
        }),
    }));
}
