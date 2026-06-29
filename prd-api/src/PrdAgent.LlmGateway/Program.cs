using System.Text.Json;
using System.Text.Json.Serialization;
using MongoDB.Driver;
using Microsoft.Extensions.Configuration;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using PrdAgent.LlmGateway;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

var builder = WebApplication.CreateBuilder(args);

// ───────────────────────── DI 装配 ─────────────────────────
// 严格复刻 MAP（PrdAgent.Api/Program.cs）中承载 LlmGateway / ModelResolver 所需的注册，
// 让本服务通过进程内 DI 直接 HOST 既有实现，再用 HTTP 端点暴露出去。不重写任何网关逻辑。

// MongoDB（ModelResolver / LlmRequestLogWriter / PoolFailoverNotifier / AppSettingsService 依赖）
var mongoConn = builder.Configuration["MongoDB:ConnectionString"] ?? "mongodb://localhost:27017";
var mongoDb = builder.Configuration["MongoDB:DatabaseName"] ?? "prdagent";
builder.Services.AddSingleton(new MongoDbContext(mongoConn, mongoDb));

// IHttpClientFactory（LlmGateway 发 HTTP 用）
builder.Services.AddHttpClient();

// 内存缓存（AppSettingsService 依赖）
builder.Services.AddMemoryCache();

// LLM 请求上下文 + 旁路日志写入
builder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
builder.Services.AddSingleton<LlmRequestLogBackground>();
builder.Services.AddSingleton<ILlmRequestLogWriter, LlmRequestLogWriter>();

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
var gwApiKey = builder.Configuration["LlmGwServe:ApiKey"] ?? "dev-llmgw-serve-key";
var gitCommit = Environment.GetEnvironmentVariable("GIT_COMMIT") ?? string.Empty;

app.MapGatewayServingEndpoints(jsonOpts, gwApiKey, gitCommit);

app.Run();
