using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 数据管理（配置导入导出 / 数据概览 / 一键清理）
/// </summary>
[ApiController]
[Route("api/v1/admin/data")]
[Authorize(Roles = "ADMIN")]
public class AdminDataController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminDataController> _logger;
    private readonly IConfiguration _config;
    private readonly ICacheManager _cache;

    private static readonly TimeSpan PurgeIdempotencyExpiry = TimeSpan.FromMinutes(15);

    public AdminDataController(
        MongoDbContext db,
        ILogger<AdminDataController> logger,
        IConfiguration config,
        ICacheManager cache)
    {
        _db = db;
        _logger = logger;
        _config = config;
        _cache = cache;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    /// <summary>
    /// 导出平台/模型配置（包含明文 apiKey，仅管理员）
    /// </summary>
    [HttpGet("config/export")]
    public async Task<IActionResult> ExportConfig()
    {
        var platforms = await _db.LLMPlatforms.Find(_ => true)
            .SortByDescending(p => p.CreatedAt)
            .ToListAsync();

        var models = await _db.LLMModels.Find(_ => true)
            .SortBy(m => m.Priority)
            .ThenByDescending(m => m.CreatedAt)
            .ToListAsync();

        var enabledModelsByPlatform = models
            .Where(m => m.Enabled && !string.IsNullOrWhiteSpace(m.PlatformId) && !string.IsNullOrWhiteSpace(m.ModelName))
            .GroupBy(m => m.PlatformId!)
            .ToDictionary(
                g => g.Key,
                g => g.Select(x => x.ModelName.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(x => x).ToList());

        var exportPlatforms = platforms.Select(p =>
        {
            var providerId = string.IsNullOrWhiteSpace(p.ProviderId) ? p.PlatformType : p.ProviderId;
            enabledModelsByPlatform.TryGetValue(p.Id, out var enabled);
            enabled ??= new List<string>();

            return new ExportedPlatformV1
            {
                Name = p.Name,
                PlatformType = p.PlatformType,
                ProviderId = string.IsNullOrWhiteSpace(providerId) ? null : providerId,
                ApiUrl = p.ApiUrl,
                ApiKey = DecryptApiKey(p.ApiKeyEncrypted),
                EnabledModels = enabled
            };
        }).ToList();

        static PurposeRef? ToPurposeRef(LLMModel? m, IReadOnlyDictionary<string, string> platformNameMap)
        {
            if (m == null) return null;
            var pid = m.PlatformId ?? string.Empty;
            if (!platformNameMap.TryGetValue(pid, out var pname) || string.IsNullOrWhiteSpace(pname)) return null;
            if (string.IsNullOrWhiteSpace(m.ModelName)) return null;
            return new PurposeRef { PlatformName = pname, ModelName = m.ModelName };
        }

        var platformNameMap = platforms.ToDictionary(x => x.Id, x => x.Name);
        var main = models.FirstOrDefault(m => m.IsMain);
        var intent = models.FirstOrDefault(m => m.IsIntent);
        var vision = models.FirstOrDefault(m => m.IsVision);
        var imageGen = models.FirstOrDefault(m => m.IsImageGen);

        var purposes = new ExportedPurposesV1
        {
            Main = ToPurposeRef(main, platformNameMap),
            Intent = ToPurposeRef(intent, platformNameMap),
            Vision = ToPurposeRef(vision, platformNameMap),
            ImageGen = ToPurposeRef(imageGen, platformNameMap),
        };

        // 尽量精简：若全为空则不输出 purposes
        var shouldIncludePurposes = purposes.Main != null || purposes.Intent != null || purposes.Vision != null || purposes.ImageGen != null;

        var payload = new ExportedConfigV1
        {
            Version = 1,
            Platforms = exportPlatforms,
            Purposes = shouldIncludePurposes ? purposes : null
        };

        return Ok(ApiResponse<ExportedConfigV1>.Ok(payload));
    }

    /// <summary>
    /// 导入平台/模型配置（包含明文 apiKey，仅管理员）
    /// </summary>
    [HttpPost("config/import")]
    public async Task<IActionResult> ImportConfig([FromBody] DataConfigImportRequest request)
    {
        if (request?.Data == null || request.Data.Platforms == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "导入数据为空"));

        if (request.Data.Version != 1)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的配置版本"));

        var now = DateTime.UtcNow;

        // 1) Upsert platforms（按 Name 唯一）
        var importedPlatforms = request.Data.Platforms
            .Where(p => p != null && !string.IsNullOrWhiteSpace(p.Name))
            .Select(p => new ExportedPlatformV1
            {
                Name = p.Name.Trim(),
                PlatformType = (p.PlatformType ?? "openai").Trim(),
                ProviderId = string.IsNullOrWhiteSpace(p.ProviderId) ? null : p.ProviderId.Trim(),
                ApiUrl = (p.ApiUrl ?? string.Empty).Trim(),
                ApiKey = p.ApiKey ?? string.Empty,
                EnabledModels = (p.EnabledModels ?? new List<string>())
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .Select(x => x.Trim())
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList()
            })
            .ToList();

        if (importedPlatforms.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未找到有效平台条目"));

        // 先查现有平台，构建 name->platform
        var existingPlatforms = await _db.LLMPlatforms.Find(_ => true).ToListAsync();
        var existingByName = existingPlatforms
            .Where(x => !string.IsNullOrWhiteSpace(x.Name))
            .ToDictionary(x => x.Name.Trim(), x => x, StringComparer.OrdinalIgnoreCase);

        var platformUpserted = 0;
        var platformInserted = 0;
        var platformUpdated = 0;

        // 更新/插入后，构建 name->id
        var nameToPlatformId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var p in importedPlatforms)
        {
            if (existingByName.TryGetValue(p.Name, out var cur))
            {
                // Update（不记录密钥）
                var update = Builders<LLMPlatform>.Update
                    .Set(x => x.PlatformType, p.PlatformType)
                    .Set(x => x.ProviderId, string.IsNullOrWhiteSpace(p.ProviderId) ? null : p.ProviderId)
                    .Set(x => x.ApiUrl, p.ApiUrl)
                    .Set(x => x.Enabled, true)
                    .Set(x => x.UpdatedAt, now);

                if (!string.IsNullOrWhiteSpace(p.ApiKey))
                {
                    update = update.Set(x => x.ApiKeyEncrypted, EncryptApiKey(p.ApiKey));
                }

                await _db.LLMPlatforms.UpdateOneAsync(x => x.Id == cur.Id, update);
                platformUpserted++;
                platformUpdated++;
                nameToPlatformId[p.Name] = cur.Id;
            }
            else
            {
                var created = new LLMPlatform
                {
                    Name = p.Name,
                    PlatformType = p.PlatformType,
                    ProviderId = string.IsNullOrWhiteSpace(p.ProviderId) ? null : p.ProviderId,
                    ApiUrl = p.ApiUrl,
                    ApiKeyEncrypted = EncryptApiKey(p.ApiKey ?? string.Empty),
                    Enabled = true,
                    MaxConcurrency = 5,
                    Remark = null,
                    CreatedAt = now,
                    UpdatedAt = now
                };

                await _db.LLMPlatforms.InsertOneAsync(created);
                platformUpserted++;
                platformInserted++;
                nameToPlatformId[p.Name] = created.Id;
            }
        }

        // 2) Upsert models（按 platformId + modelName）
        var maxPriority = await _db.LLMModels.Find(_ => true)
            .SortByDescending(m => m.Priority)
            .Limit(1)
            .Project(m => m.Priority)
            .FirstOrDefaultAsync();
        var nextPriority = maxPriority + 1;

        var modelUpserted = 0;
        var modelInserted = 0;
        var modelUpdated = 0;

        foreach (var p in importedPlatforms)
        {
            if (!nameToPlatformId.TryGetValue(p.Name, out var platformId)) continue;
            foreach (var modelName in p.EnabledModels ?? new List<string>())
            {
                var mn = (modelName ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(mn)) continue;

                var existing = await _db.LLMModels
                    .Find(m => m.PlatformId == platformId && m.ModelName == mn)
                    .FirstOrDefaultAsync();

                if (existing != null)
                {
                    var update = Builders<LLMModel>.Update
                        .Set(m => m.Enabled, true)
                        .Set(m => m.UpdatedAt, now);
                    await _db.LLMModels.UpdateOneAsync(m => m.Id == existing.Id, update);
                    modelUpserted++;
                    modelUpdated++;
                }
                else
                {
                    var created = new LLMModel
                    {
                        Name = mn,
                        ModelName = mn,
                        PlatformId = platformId,
                        Group = null,
                        Priority = nextPriority++,
                        Enabled = true,
                        EnablePromptCache = true,
                        CreatedAt = now,
                        UpdatedAt = now
                    };
                    await _db.LLMModels.InsertOneAsync(created);
                    modelUpserted++;
                    modelInserted++;
                }
            }
        }

        // 3) Apply purposes（可选）
        var opt = request.Options ?? new DataConfigImportOptions();
        var purposes = request.Data.Purposes;

        async Task ApplyPurposeAsync(string purpose, PurposeRef? pref, Func<LLMModel, bool> flagSelector, Action<UpdateDefinitionBuilder<LLMModel>, string> _)
        {
            if (pref == null) return;
            var pname = (pref.PlatformName ?? string.Empty).Trim();
            var mname = (pref.ModelName ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(pname) || string.IsNullOrWhiteSpace(mname)) return;
            if (!nameToPlatformId.TryGetValue(pname, out var pid))
            {
                // 目的平台不存在：跳过
                return;
            }

            var model = await _db.LLMModels.Find(m => m.PlatformId == pid && m.ModelName == mname).FirstOrDefaultAsync();
            if (model == null) return;

            // 先清空再设置（与 AdminModelsController 一致的全局唯一语义）
            if (purpose == "main")
            {
                await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsMain, false));
                await _db.LLMModels.UpdateOneAsync(m => m.Id == model.Id,
                    Builders<LLMModel>.Update.Set(m => m.IsMain, true).Set(m => m.UpdatedAt, now));
            }
            else if (purpose == "intent")
            {
                await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsIntent, false));
                await _db.LLMModels.UpdateOneAsync(m => m.Id == model.Id,
                    Builders<LLMModel>.Update.Set(m => m.IsIntent, true).Set(m => m.UpdatedAt, now));
            }
            else if (purpose == "vision")
            {
                await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsVision, false));
                await _db.LLMModels.UpdateOneAsync(m => m.Id == model.Id,
                    Builders<LLMModel>.Update.Set(m => m.IsVision, true).Set(m => m.UpdatedAt, now));
            }
            else if (purpose == "imageGen")
            {
                await _db.LLMModels.UpdateManyAsync(_ => true, Builders<LLMModel>.Update.Set(m => m.IsImageGen, false));
                await _db.LLMModels.UpdateOneAsync(m => m.Id == model.Id,
                    Builders<LLMModel>.Update.Set(m => m.IsImageGen, true).Set(m => m.UpdatedAt, now));
            }
        }

        if (purposes != null)
        {
            if (opt.ApplyMain) await ApplyPurposeAsync("main", purposes.Main, _ => false, (_, __) => { });
            if (opt.ApplyIntent) await ApplyPurposeAsync("intent", purposes.Intent, _ => false, (_, __) => { });
            if (opt.ApplyVision) await ApplyPurposeAsync("vision", purposes.Vision, _ => false, (_, __) => { });
            if (opt.ApplyImageGen) await ApplyPurposeAsync("imageGen", purposes.ImageGen, _ => false, (_, __) => { });
        }

        var resp = new DataConfigImportResponse
        {
            PlatformUpserted = platformUpserted,
            PlatformInserted = platformInserted,
            PlatformUpdated = platformUpdated,
            ModelUpserted = modelUpserted,
            ModelInserted = modelInserted,
            ModelUpdated = modelUpdated,
        };

        _logger.LogInformation("Admin import config done. platforms(upserted={PlatformUpserted}, inserted={PlatformInserted}, updated={PlatformUpdated}) models(upserted={ModelUpserted}, inserted={ModelInserted}, updated={ModelUpdated})",
            resp.PlatformUpserted, resp.PlatformInserted, resp.PlatformUpdated, resp.ModelUpserted, resp.ModelInserted, resp.ModelUpdated);

        return Ok(ApiResponse<DataConfigImportResponse>.Ok(resp));
    }

    /// <summary>
    /// 数据概览（集合数据量）
    /// </summary>
    [HttpGet("summary")]
    public async Task<IActionResult> GetSummary()
    {
        var payload = new DataSummaryResponse
        {
            LlmRequestLogs = await _db.LlmRequestLogs.CountDocumentsAsync(_ => true),
            Messages = await _db.Messages.CountDocumentsAsync(_ => true),
            Documents = await _db.Documents.CountDocumentsAsync(_ => true),
            Attachments = await _db.Attachments.CountDocumentsAsync(_ => true),
            ContentGaps = await _db.ContentGaps.CountDocumentsAsync(_ => true),
            PrdComments = await _db.PrdComments.CountDocumentsAsync(_ => true),
            ImageMasterSessions = await _db.ImageMasterSessions.CountDocumentsAsync(_ => true),
            ImageMasterMessages = await _db.ImageMasterMessages.CountDocumentsAsync(_ => true),
        };

        return Ok(ApiResponse<DataSummaryResponse>.Ok(payload));
    }

    /// <summary>
    /// 一键清理指定领域的数据（支持 Idempotency-Key）
    /// </summary>
    [HttpPost("purge")]
    public async Task<IActionResult> Purge([FromBody] DataPurgeRequest request)
    {
        var domains = request?.Domains ?? new List<string>();
        if (domains.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "domains 不能为空"));

        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:data:purge:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<DataPurgeResponse>(cacheKey);
            if (cached != null)
            {
                return Ok(ApiResponse<DataPurgeResponse>.Ok(cached));
            }
        }

        static string Norm(string s)
            => (s ?? string.Empty).Trim().ToLowerInvariant().Replace("_", "").Replace("-", "");

        var requested = new HashSet<string>(domains.Where(x => !string.IsNullOrWhiteSpace(x)).Select(Norm));

        var payload = new DataPurgeResponse();
        var matchedAny = false;

        // llm logs
        if (requested.Contains("llmlogs") || requested.Contains("llmrequestlogs") || requested.Contains("logs"))
        {
            matchedAny = true;
            var res = await _db.LlmRequestLogs.DeleteManyAsync(_ => true);
            payload.LlmRequestLogs = res.DeletedCount;
        }

        // sessions/messages
        if (requested.Contains("sessionsmessages") || requested.Contains("sessions") || requested.Contains("messages"))
        {
            matchedAny = true;
            var msg = await _db.Messages.DeleteManyAsync(_ => true);
            var ims = await _db.ImageMasterSessions.DeleteManyAsync(_ => true);
            var imm = await _db.ImageMasterMessages.DeleteManyAsync(_ => true);

            payload.Messages = msg.DeletedCount;
            payload.ImageMasterSessions = ims.DeletedCount;
            payload.ImageMasterMessages = imm.DeletedCount;

            // 清掉会话/聊天缓存（避免 UI 看到“幽灵数据”）
            await _cache.RemoveByPatternAsync($"{CacheKeys.Session}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.ChatHistory}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.GroupChatHistory}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.UserSession}*");
        }

        // documents / kb-like
        if (requested.Contains("documents") || requested.Contains("docs") || requested.Contains("knowledgebase") || requested.Contains("kb"))
        {
            matchedAny = true;
            var docs = await _db.Documents.DeleteManyAsync(_ => true);
            var atts = await _db.Attachments.DeleteManyAsync(_ => true);
            var gaps = await _db.ContentGaps.DeleteManyAsync(_ => true);
            var comments = await _db.PrdComments.DeleteManyAsync(_ => true);

            payload.Documents = docs.DeletedCount;
            payload.Attachments = atts.DeletedCount;
            payload.ContentGaps = gaps.DeletedCount;
            payload.PrdComments = comments.DeletedCount;

            await _cache.RemoveByPatternAsync($"{CacheKeys.Document}*");
        }

        // 校验：至少匹配到一个 domain，否则视为格式错误（即使数据本来为空，也应返回成功）
        if (!matchedAny)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "domains 不支持（可选：llmLogs, sessionsMessages, documents）"));
        }

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:data:purge:{adminId}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, PurgeIdempotencyExpiry);
        }

        _logger.LogWarning("Admin purge executed. llmRequestLogs={LlmRequestLogs}, messages={Messages}, documents={Documents}",
            payload.LlmRequestLogs, payload.Messages, payload.Documents);

        return Ok(ApiResponse<DataPurgeResponse>.Ok(payload));
    }

    private string EncryptApiKey(string apiKey)
    {
        if (string.IsNullOrEmpty(apiKey)) return string.Empty;
        var key = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        var keyBytes = Encoding.UTF8.GetBytes(key[..32]);

        using var aes = Aes.Create();
        aes.Key = keyBytes;
        aes.GenerateIV();

        using var encryptor = aes.CreateEncryptor();
        var plainBytes = Encoding.UTF8.GetBytes(apiKey);
        var encryptedBytes = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);

        return Convert.ToBase64String(aes.IV) + ":" + Convert.ToBase64String(encryptedBytes);
    }

    private string DecryptApiKey(string encryptedKey)
    {
        try
        {
            if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;
            var parts = encryptedKey.Split(':');
            if (parts.Length != 2) return "";

            var key = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
            var keyBytes = Encoding.UTF8.GetBytes(key[..32]);
            var iv = Convert.FromBase64String(parts[0]);
            var encryptedBytes = Convert.FromBase64String(parts[1]);

            using var aes = Aes.Create();
            aes.Key = keyBytes;
            aes.IV = iv;

            using var decryptor = aes.CreateDecryptor();
            var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);

            return Encoding.UTF8.GetString(decryptedBytes);
        }
        catch
        {
            return "";
        }
    }
}

public class ExportedConfigV1
{
    public int Version { get; set; } = 1;
    public List<ExportedPlatformV1> Platforms { get; set; } = new();
    public ExportedPurposesV1? Purposes { get; set; }
}

public class ExportedPlatformV1
{
    public string Name { get; set; } = string.Empty;
    public string PlatformType { get; set; } = "openai";
    public string? ProviderId { get; set; }
    public string ApiUrl { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public List<string> EnabledModels { get; set; } = new();
}

public class ExportedPurposesV1
{
    public PurposeRef? Main { get; set; }
    public PurposeRef? Intent { get; set; }
    public PurposeRef? Vision { get; set; }
    public PurposeRef? ImageGen { get; set; }
}

public class PurposeRef
{
    public string PlatformName { get; set; } = string.Empty;
    public string ModelName { get; set; } = string.Empty;
}

public class DataConfigImportOptions
{
    public bool ApplyMain { get; set; } = true;
    public bool ApplyIntent { get; set; } = true;
    public bool ApplyVision { get; set; } = true;
    public bool ApplyImageGen { get; set; } = true;
}

public class DataConfigImportRequest
{
    public ExportedConfigV1 Data { get; set; } = new();
    public DataConfigImportOptions? Options { get; set; }
}

public class DataConfigImportResponse
{
    public int PlatformUpserted { get; set; }
    public int PlatformInserted { get; set; }
    public int PlatformUpdated { get; set; }

    public int ModelUpserted { get; set; }
    public int ModelInserted { get; set; }
    public int ModelUpdated { get; set; }
}

public class DataSummaryResponse
{
    public long LlmRequestLogs { get; set; }
    public long Messages { get; set; }
    public long Documents { get; set; }
    public long Attachments { get; set; }
    public long ContentGaps { get; set; }
    public long PrdComments { get; set; }
    public long ImageMasterSessions { get; set; }
    public long ImageMasterMessages { get; set; }
}

public class DataPurgeRequest
{
    public List<string> Domains { get; set; } = new();
}

public class DataPurgeResponse
{
    public long LlmRequestLogs { get; set; }
    public long Messages { get; set; }
    public long Documents { get; set; }

    public long Attachments { get; set; }
    public long ContentGaps { get; set; }
    public long PrdComments { get; set; }

    public long ImageMasterSessions { get; set; }
    public long ImageMasterMessages { get; set; }

    public bool AllZero()
    {
        return LlmRequestLogs == 0
               && Messages == 0
               && Documents == 0
               && Attachments == 0
               && ContentGaps == 0
               && PrdComments == 0
               && ImageMasterSessions == 0
               && ImageMasterMessages == 0;
    }
}


