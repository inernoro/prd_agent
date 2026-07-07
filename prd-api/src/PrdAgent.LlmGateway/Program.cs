using System.Text.Json;
using System.Text.Json.Serialization;
using MongoDB.Driver;
using Microsoft.Extensions.Configuration;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using PrdAgent.LlmGatewayHost;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Security;

var builder = WebApplication.CreateBuilder(args);

// ───────────────────────── DI 装配 ─────────────────────────
// 严格复刻 MAP（PrdAgent.Api/Program.cs）中承载 LlmGateway / ModelResolver 所需的注册，
// 让本服务通过进程内 DI 直接 HOST 既有实现，再用 HTTP 端点暴露出去。不重写任何网关逻辑。

// MongoDB：主库用于模型配置/模型池解析；GW 自有库用于 serving 请求日志与 shadow 证据。
var mongoConn = builder.Configuration["MongoDB:ConnectionString"] ?? "mongodb://localhost:27017";
var mongoDb = builder.Configuration["MongoDB:DatabaseName"] ?? "prdagent";
var gatewayDb = builder.Configuration["LlmGateway:DatabaseName"] ?? "llm_gateway";
builder.Services.AddSingleton(new MongoDbContext(mongoConn, mongoDb));
builder.Services.AddSingleton(new LlmGatewayDataContext(mongoConn, gatewayDb));

// IHttpClientFactory（LlmGateway 发 HTTP 用）
builder.Services.AddHttpClient();

// 内存缓存（AppSettingsService 依赖）
builder.Services.AddMemoryCache();

// LLM 请求上下文 + 旁路日志写入
builder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
builder.Services.AddSingleton(sp =>
    new LlmRequestLogBackground(
        sp.GetRequiredService<LlmGatewayDataContext>().Context,
        sp.GetRequiredService<ILogger<LlmRequestLogBackground>>()));
builder.Services.AddSingleton<ILlmRequestLogWriter>(sp =>
    new LlmRequestLogWriter(
        sp.GetRequiredService<LlmGatewayDataContext>().Context,
        sp.GetRequiredService<ILogger<LlmRequestLogWriter>>(),
        sp.GetRequiredService<LlmRequestLogBackground>(),
        sp.GetRequiredService<PrdAgent.Core.Interfaces.IAppSettingsService>(),
        sp.GetRequiredService<IAssetStorage>()));
builder.Services.AddSingleton<ILlmShadowComparisonWriter>(sp =>
    new LlmShadowComparisonWriter(
        sp.GetRequiredService<LlmGatewayDataContext>().Context,
        sp.GetRequiredService<ILogger<LlmShadowComparisonWriter>>()));

// 应用设置服务（LlmRequestLogWriter 依赖 IAppSettingsService）
builder.Services.AddSingleton<PrdAgent.Core.Interfaces.IAppSettingsService, PrdAgent.Infrastructure.Services.AppSettingsService>();

// 资产存储（LlmRequestLogWriter 依赖 IAssetStorage）——从 MAP/Program.cs 逐字搬运的工厂。
// 读取 ASSETS_PROVIDER / TENCENT_COS_* / R2_* / 本地兜底。
builder.Services.AddSingleton<IAssetStorage>(sp =>
{
    var cfg = sp.GetRequiredService<IConfiguration>();
    var log = sp.GetRequiredService<ILoggerFactory>().CreateLogger("AssetStorage");
    // 强约束：统一只使用一套"扁平环境变量"（不使用双下划线）：
    // - ASSETS_PROVIDER=tencentCos / cloudflareR2 / local
    // - TENCENT_COS_BUCKET / TENCENT_COS_REGION / TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_PUBLIC_BASE_URL / TENCENT_COS_PREFIX
    // - R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE_URL / R2_PREFIX / R2_ENDPOINT
    // - ASSETS_LOCAL_DIR（local 模式存储根目录，默认 {ContentRoot}/data/assets）
    var providerRaw = (cfg["ASSETS_PROVIDER"] ?? string.Empty).Trim();
    var providerExplicit = !string.IsNullOrWhiteSpace(providerRaw);

    static (string bucket, string region, string secretId, string secretKey, string? publicBaseUrl, string? prefix) ReadTencentCosEnv(IConfiguration cfg)
    {
        var bucket = (cfg["TENCENT_COS_BUCKET"] ?? string.Empty).Trim();
        var region = (cfg["TENCENT_COS_REGION"] ?? string.Empty).Trim();
        var sid = (cfg["TENCENT_COS_SECRET_ID"] ?? string.Empty).Trim();
        var sk = (cfg["TENCENT_COS_SECRET_KEY"] ?? string.Empty).Trim();
        var publicBaseUrl = (cfg["TENCENT_COS_PUBLIC_BASE_URL"] ?? string.Empty).Trim();
        var prefix = (cfg["TENCENT_COS_PREFIX"] ?? string.Empty).Trim();
        return (bucket, region, sid, sk, string.IsNullOrWhiteSpace(publicBaseUrl) ? null : publicBaseUrl, string.IsNullOrWhiteSpace(prefix) ? null : prefix);
    }

    var provider = providerExplicit ? providerRaw : "auto";

    static bool HasCosCreds(IConfiguration c)
        => !string.IsNullOrWhiteSpace(c["TENCENT_COS_BUCKET"])
        && !string.IsNullOrWhiteSpace(c["TENCENT_COS_REGION"])
        && !string.IsNullOrWhiteSpace(c["TENCENT_COS_SECRET_ID"])
        && !string.IsNullOrWhiteSpace(c["TENCENT_COS_SECRET_KEY"]);

    static bool HasR2Creds(IConfiguration c)
        => !string.IsNullOrWhiteSpace(c["R2_ACCOUNT_ID"])
        && !string.IsNullOrWhiteSpace(c["R2_ACCESS_KEY_ID"])
        && !string.IsNullOrWhiteSpace(c["R2_SECRET_ACCESS_KEY"])
        && !string.IsNullOrWhiteSpace(c["R2_BUCKET"]);

    static bool HasAnyCloudVar(IConfiguration c)
        => new[]
        {
            "TENCENT_COS_BUCKET", "TENCENT_COS_REGION", "TENCENT_COS_SECRET_ID", "TENCENT_COS_SECRET_KEY",
            "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
        }.Any(k => !string.IsNullOrWhiteSpace(c[k]));

    IAssetStorage BuildLocal(string reason)
    {
        var dir = (cfg["ASSETS_LOCAL_DIR"] ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(dir))
        {
            var contentRoot = sp.GetService<IWebHostEnvironment>()?.ContentRootPath
                ?? AppContext.BaseDirectory;
            dir = Path.Combine(contentRoot, "data", "assets");
        }
        log.LogWarning(
            "AssetStorage selected: provider=local dir={Dir} ({Reason})。本地存储仅适合开发/预览或占位；" +
            "生产请设 ASSETS_PROVIDER=tencentCos|cloudflareR2 + 对应凭据。",
            dir, reason);
        return WrapWithRegistry(new LocalAssetStorage(dir), "local");
    }

    if (string.Equals(provider, "auto", StringComparison.OrdinalIgnoreCase))
    {
        if (HasCosCreds(cfg)) provider = "tencentCos";
        else if (HasR2Creds(cfg)) provider = "cloudflareR2";
        else if (HasAnyCloudVar(cfg))
        {
            throw new InvalidOperationException(
                "检测到部分云存储凭据但不完整：请补全 TENCENT_COS_*（BUCKET/REGION/SECRET_ID/SECRET_KEY）" +
                "或 R2_*（ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET）整套；" +
                "若确实要用本地存储，请显式设置 ASSETS_PROVIDER=local。" +
                "已拒绝在凭据不完整时静默回退本地，以免资产写入容器本地盘、重部署后丢失。");
        }
        else return BuildLocal("ASSETS_PROVIDER 未设置且无任何云凭据");
    }

    if (string.Equals(provider, "local", StringComparison.OrdinalIgnoreCase))
    {
        return BuildLocal("ASSETS_PROVIDER=local（显式）");
    }

    static (bool enableSafeDelete, string[] allow) ReadSafeDeleteConfig(IConfiguration c)
    {
        var enable = string.Equals((c["SafeDelete:Enable"] ?? c["TencentCos:EnableSafeDelete"] ?? string.Empty).Trim(), "true", StringComparison.OrdinalIgnoreCase);
        var raw = (c["SafeDelete:AllowPrefixes"] ?? c["TencentCos:SafeDeleteAllowPrefixes"] ?? string.Empty).Trim();
        var a = raw
            .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => x.Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToArray();
        return (enable, a);
    }

    if (string.Equals(provider, "tencentCos", StringComparison.OrdinalIgnoreCase))
    {
        var (bucket, region, secretId, secretKey, publicBaseUrl, prefix) = ReadTencentCosEnv(cfg);
        if (string.IsNullOrWhiteSpace(bucket) ||
            string.IsNullOrWhiteSpace(region) ||
            string.IsNullOrWhiteSpace(secretId) ||
            string.IsNullOrWhiteSpace(secretKey))
        {
            throw new InvalidOperationException(
                "已强制使用 Tencent COS，但缺少必需环境变量。请设置：TENCENT_COS_BUCKET / TENCENT_COS_REGION / TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY。");
        }
        var tempDir = (string?)null; // 纯内存流模式：不依赖本地 tempDir
        var (enableSafeDelete, allow) = ReadSafeDeleteConfig(cfg);
        var logger = sp.GetRequiredService<ILogger<TencentCosStorage>>();
        log.LogInformation(
            "AssetStorage selected: provider={ProviderRaw}->{Provider} tencentCos.bucket={Bucket} region={Region} prefix={Prefix} publicBaseUrl={PublicBaseUrl}",
            providerRaw,
            provider,
            (bucket ?? string.Empty).Trim(),
            (region ?? string.Empty).Trim(),
            (prefix ?? string.Empty).Trim(),
            (publicBaseUrl ?? string.Empty).Trim());
        var cosStorage = new TencentCosStorage(bucket!, region!, secretId!, secretKey!, publicBaseUrl, prefix, tempDir, enableSafeDelete, allow, logger);
        return WrapWithRegistry(cosStorage, "tencentCos");
    }

    if (string.Equals(provider, "cloudflareR2", StringComparison.OrdinalIgnoreCase))
    {
        var accountId = (cfg["R2_ACCOUNT_ID"] ?? string.Empty).Trim();
        var accessKeyId = (cfg["R2_ACCESS_KEY_ID"] ?? string.Empty).Trim();
        var secretAccessKey = (cfg["R2_SECRET_ACCESS_KEY"] ?? string.Empty).Trim();
        var r2Bucket = (cfg["R2_BUCKET"] ?? string.Empty).Trim();
        var r2PublicBaseUrl = (cfg["R2_PUBLIC_BASE_URL"] ?? string.Empty).Trim();
        var r2Prefix = (cfg["R2_PREFIX"] ?? string.Empty).Trim();
        var r2Endpoint = (cfg["R2_ENDPOINT"] ?? string.Empty).Trim();

        if (string.IsNullOrWhiteSpace(accountId) ||
            string.IsNullOrWhiteSpace(accessKeyId) ||
            string.IsNullOrWhiteSpace(secretAccessKey) ||
            string.IsNullOrWhiteSpace(r2Bucket))
        {
            throw new InvalidOperationException(
                "已选择 Cloudflare R2，但缺少必需环境变量。请设置：R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET。");
        }
        var (enableSafeDelete, allow) = ReadSafeDeleteConfig(cfg);
        var r2Logger = sp.GetRequiredService<ILogger<CloudflareR2Storage>>();
        log.LogInformation(
            "AssetStorage selected: provider={ProviderRaw}->{Provider} r2.bucket={Bucket} endpoint={Endpoint} prefix={Prefix} publicBaseUrl={PublicBaseUrl}",
            providerRaw, provider, r2Bucket,
            string.IsNullOrWhiteSpace(r2Endpoint) ? $"https://{accountId}.r2.cloudflarestorage.com" : r2Endpoint,
            string.IsNullOrWhiteSpace(r2Prefix) ? "(none)" : r2Prefix,
            string.IsNullOrWhiteSpace(r2PublicBaseUrl) ? "(r2.dev fallback)" : r2PublicBaseUrl);
        var r2Storage = new CloudflareR2Storage(
            accountId, accessKeyId, secretAccessKey, r2Bucket,
            string.IsNullOrWhiteSpace(r2PublicBaseUrl) ? null : r2PublicBaseUrl,
            string.IsNullOrWhiteSpace(r2Prefix) ? null : r2Prefix,
            string.IsNullOrWhiteSpace(r2Endpoint) ? null : r2Endpoint,
            enableSafeDelete, allow, r2Logger);
        return WrapWithRegistry(r2Storage, "cloudflareR2");
    }

    throw new InvalidOperationException(
        $"ASSETS_PROVIDER={providerRaw} 不支持。可选值：tencentCos / cloudflareR2 / local");

    // ─── 装饰器：用 RegistryAssetStorage 包裹真实实现，自动登记每次存储操作 ───
    IAssetStorage WrapWithRegistry(IAssetStorage inner, string providerName)
    {
        var db = sp.GetRequiredService<MongoDbContext>();
        var regLogger = sp.GetRequiredService<ILogger<RegistryAssetStorage>>();
        log.LogInformation("AssetStorage wrapped with RegistryAssetStorage (provider={Provider})", providerName);
        return new RegistryAssetStorage(inner, db, providerName, regLogger);
    }
});

// 模型池故障通知与自动探活（ModelResolver 解析结果发往健康管理）
builder.Services.AddScoped<PrdAgent.Infrastructure.ModelPool.IPoolFailoverNotifier, PrdAgent.Infrastructure.ModelPool.PoolFailoverNotifier>();

// 模型调度执行器
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>();

// LLM Gateway 统一守门员（HOST 既有实现）
builder.Services.AddScoped<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, PrdAgent.Infrastructure.LlmGateway.LlmGateway>();

// serving 侧平台密钥自检（消盲区：serving 到底能不能解密真实平台密文）。
// 此前密钥完整性 Worker 只在 MAP(api) 侧注册，serving 缺钥时静默用 stub 兜底、无任何自检。
// 本 Worker 只读、仅告警、不重加密（重加密留 api 侧），启动 20s 后 + 每 6h 扫一次，
// 把「serving 能不能解密」从盲区变成容器日志里一眼可见的 [ServingKeyIntegrity] 行。
builder.Services.AddHostedService<ServingKeyIntegrityCheck>();

// JSON：PascalCase（PropertyNamingPolicy = null），与既有 DTO 属性名一一对应，
// MAP 侧 HttpLlmGatewayClient 用相同口径序列化/反序列化。
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = null;
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

var app = builder.Build();

// 端点用的 JSON 选项（与上面口径一致；SSE 端点手动序列化时用）
var jsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = null,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};

// 密钥门 + 全部 /gw/v1/* 端点由可复用扩展装配（SSOT：集成自测 host 复用同一份映射，
// 见 GatewayHttpEndpoints.cs / doc/design.llm-gateway-physical-isolation.md）。
const string DevServeKey = "dev-llmgw-serve-key"; // 仓库已知 dev 默认值，生产禁用
var gwApiKey = builder.Configuration["LlmGwServe:ApiKey"];
if (builder.Environment.IsProduction() && (string.IsNullOrWhiteSpace(gwApiKey) || gwApiKey == DevServeKey))
{
    // fail closed：生产缺 key 或仍用仓库默认 key → 拒绝启动，避免 serving 接受可预测的 X-Gateway-Key
    // （与 HttpLlmGatewayClient 空 key 即 fail-closed 一致，Cursor Bugbot）。部署须注入强随机 M2M key
    // （CDS 预览经 ${LLMGW_SERVE_API_KEY} 提供非 dev 默认的内网值，故不挡预览启动）。
    throw new InvalidOperationException(
        "LlmGwServe:ApiKey 未配置或仍为仓库默认值；生产环境必须由部署注入强随机 M2M key。");
}
gwApiKey ??= DevServeKey; // 非生产保留便利回落
var gitCommit = Environment.GetEnvironmentVariable("GIT_COMMIT") ?? string.Empty;

app.MapGatewayServingEndpoints(jsonOpts, gwApiKey, gitCommit);

app.Run();


// ─────────────────────── serving 侧平台密钥完整性自检 ───────────────────────
// 对齐 design.llm-gateway-physical-isolation §3.4「PlatformKeyIntegrityWorker 须在网关侧也跑」。
// 与 api 侧 PlatformKeyIntegrityWorker 的区别：只读、仅告警、不做旧密文重加密（避免两进程双写）。
sealed class ServingKeyIntegrityCheck : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IConfiguration _cfg;
    private readonly ILogger<ServingKeyIntegrityCheck> _log;

    public ServingKeyIntegrityCheck(MongoDbContext db, IConfiguration cfg, ILogger<ServingKeyIntegrityCheck> log)
    {
        _db = db;
        _cfg = cfg;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(20), ct); }
        catch (OperationCanceledException) { return; }

        while (!ct.IsCancellationRequested)
        {
            try { await CheckAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { _log.LogWarning(ex, "[ServingKeyIntegrity] check loop error"); }

            try { await Task.Delay(TimeSpan.FromHours(6), ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    // 有意的 dev-stub 平台（如"Stub 开发桩"）的密文本就是占位、天然解不出，属预期噪音，不当作真故障告警。
    // 仅按"开发桩"或独立词 "stub" 判定（词边界，非任意子串），避免真实平台名恰含 stub 子串被误判静默（Bugbot Low）。
    private static bool IsStub(string? name)
        => !string.IsNullOrWhiteSpace(name)
        && (name!.Contains("开发桩")
            || System.Text.RegularExpressions.Regex.IsMatch(name, @"(^|[^a-z])stub([^a-z]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase));

    private async Task CheckAsync(CancellationToken ct)
    {
        var real = new List<string>();     // 真实平台/模型/中继解不出 —— 需告警
        var stubs = new List<string>();    // dev-stub 解不出 —— 预期，不告警

        void Classify(string label, string? name)
        {
            if (IsStub(name)) stubs.Add(label);
            else real.Add(label);
        }

        var platforms = await _db.LLMPlatforms.Find(p => p.Enabled).ToListAsync(ct);
        var withKey = platforms.Where(p => !string.IsNullOrWhiteSpace(p.ApiKeyEncrypted)).ToList();
        foreach (var p in withKey)
            if (!ApiKeyCryptoKeyRing.Decrypt(p.ApiKeyEncrypted, _cfg).Success) Classify(p.Name, p.Name);

        var models = await _db.LLMModels.Find(m => m.Enabled).ToListAsync(ct);
        foreach (var m in models.Where(m => !string.IsNullOrWhiteSpace(m.ApiKeyEncrypted)))
            if (!ApiKeyCryptoKeyRing.Decrypt(m.ApiKeyEncrypted, _cfg).Success) Classify($"模型:{m.Name}", m.Name);

        var exchanges = await _db.ModelExchanges.Find(e => e.Enabled).ToListAsync(ct);
        foreach (var e in exchanges.Where(e => !string.IsNullOrWhiteSpace(e.TargetApiKeyEncrypted)))
            if (!ApiKeyCryptoKeyRing.Decrypt(e.TargetApiKeyEncrypted, _cfg).Success) Classify($"中继:{e.Name}", e.Name);

        if (real.Count == 0)
        {
            _log.LogInformation(
                "[ServingKeyIntegrity] OK：serving 用当前 ApiKeyCrypto 钥匙环可解密全部真实平台密文（{Total} 个启用平台，跳过 {Stubs} 个 dev-stub），Mode=http 时模型池可正常烧额度。",
                withKey.Count, stubs.Count);
            return;
        }

        _log.LogError(
            "[ServingKeyIntegrity] serving 侧 {Count} 个真实平台/模型/中继 API key 无法解密：{Names}。" +
            "说明 llmgw-serve 容器的 ApiKeyCrypto:Secret / LegacySecrets 与存量密文不匹配" +
            "（cds-compose 未把与 api 一致的密钥锚点注入 llmgw-serve）。经 serving 引擎(Mode=http)的模型池调用会以空凭据打上游 401。仅告警不阻断启动。",
            real.Count, string.Join("、", real));
    }
}
