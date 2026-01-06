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
                Id = p.Id,
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
            Version = 2,
            Platforms = exportPlatforms,
            Purposes = shouldIncludePurposes ? purposes : null
        };

        return Ok(ApiResponse<ExportedConfigV1>.Ok(payload));
    }

    /// <summary>
    /// 导入平台/模型配置（包含明文 apiKey，仅管理员）
    /// </summary>
    [HttpPost("config/import/preview")]
    public async Task<IActionResult> PreviewImportConfig([FromBody] DataConfigImportRequest request)
    {
        if (request?.Data == null || request.Data.Platforms == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "导入数据为空"));

        if (request.Data.Version != 1 && request.Data.Version != 2)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的配置版本（仅支持 version=1/2）"));

        var importedPlatforms = request.Data.Platforms
            .Where(p => p != null && !string.IsNullOrWhiteSpace(p.Name))
            .Select(p => new ExportedPlatformV1
            {
                Id = string.IsNullOrWhiteSpace(p.Id) ? null : p.Id.Trim(),
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

        if (request.Data.Version == 2 && importedPlatforms.Any(p => string.IsNullOrWhiteSpace(p.Id)))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "version=2 需要 platforms[].id"));

        var existingPlatforms = await _db.LLMPlatforms.Find(_ => true).ToListAsync();
        var dupNames = existingPlatforms
            .Where(x => !string.IsNullOrWhiteSpace(x.Name))
            .GroupBy(x => x.Name.Trim(), StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (dupNames.Count > 0)
        {
            var sample = string.Join(", ", dupNames.Take(10));
            var msg = dupNames.Count <= 10 ? $"数据库存在重复平台名：{sample}" : $"数据库存在重复平台名（示例：{sample} ...，共 {dupNames.Count} 个）";
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, msg));
        }

        var existingByName = existingPlatforms
            .Where(x => !string.IsNullOrWhiteSpace(x.Name))
            .ToDictionary(x => x.Name.Trim(), x => x, StringComparer.OrdinalIgnoreCase);

        static string NormUrl(string s)
            => (s ?? string.Empty).Trim().TrimEnd('/').ToLowerInvariant();

        var opt = request.Options ?? new DataConfigImportOptions();
        var forceOverwrite = opt.ForceOverwriteSameName;
        var deleteNotImported = opt.DeleteNotImported;

        var notes = new List<string>();
        var willInsert = new List<ImportPlatformInsertItem>();
        var willUpdate = new List<ImportPlatformUpdateItem>();
        var urlConflicts = new List<ImportPlatformUrlConflictItem>();

        foreach (var p in importedPlatforms)
        {
            if (existingByName.TryGetValue(p.Name, out var cur))
            {
                if (!forceOverwrite)
                {
                    continue;
                }

                var curUrl = cur.ApiUrl ?? string.Empty;
                var importedUrl = p.ApiUrl ?? string.Empty;
                var urlChanged = !string.Equals(NormUrl(curUrl), NormUrl(importedUrl), StringComparison.OrdinalIgnoreCase);

                willUpdate.Add(new ImportPlatformUpdateItem
                {
                    Id = cur.Id,
                    Name = p.Name,
                    CurrentApiUrl = curUrl,
                    ImportedApiUrl = importedUrl,
                    ApiUrlChanged = urlChanged
                });
                if (urlChanged)
                {
                    urlConflicts.Add(new ImportPlatformUrlConflictItem
                    {
                        Id = cur.Id,
                        Name = p.Name,
                        CurrentApiUrl = curUrl,
                        ImportedApiUrl = importedUrl
                    });
                }
            }
            else
            {
                willInsert.Add(new ImportPlatformInsertItem
                {
                    Id = string.IsNullOrWhiteSpace(p.Id) ? null : p.Id,
                    Name = p.Name,
                    ApiUrl = p.ApiUrl ?? string.Empty
                });
            }
        }

        var willDelete = new List<ImportPlatformDeleteItem>();
        if (deleteNotImported)
        {
            var importedNames = new HashSet<string>(importedPlatforms.Select(x => x.Name.Trim()), StringComparer.OrdinalIgnoreCase);
            foreach (var p in existingPlatforms.Where(x => !string.IsNullOrWhiteSpace(x.Name)))
            {
                if (!importedNames.Contains(p.Name.Trim()))
                {
                    willDelete.Add(new ImportPlatformDeleteItem
                    {
                        Id = p.Id,
                        Name = p.Name.Trim(),
                        ApiUrl = p.ApiUrl ?? string.Empty
                    });
                }
            }
        }

        var importedModelCount = importedPlatforms.Sum(p => p.EnabledModels?.Count ?? 0);
        var payload = new DataConfigImportPreviewResponse
        {
            Version = request.Data.Version,
            ImportedPlatformCount = importedPlatforms.Count,
            ImportedEnabledModelCount = importedModelCount,
            ExistingPlatformCount = existingPlatforms.Count,
            ForceOverwriteSameName = forceOverwrite,
            DeleteNotImported = deleteNotImported,
            WillInsertPlatforms = willInsert,
            WillUpdatePlatforms = willUpdate,
            UrlConflicts = urlConflicts,
            WillDeletePlatforms = willDelete,
            Notes = notes,
            RequiresConfirmation = urlConflicts.Count > 0 || willDelete.Count > 0
        };

        return Ok(ApiResponse<DataConfigImportPreviewResponse>.Ok(payload));
    }

    [HttpPost("config/import")]
    public async Task<IActionResult> ImportConfig([FromBody] DataConfigImportRequest request)
    {
        if (request?.Data == null || request.Data.Platforms == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "导入数据为空"));

        if (request.Data.Version != 1 && request.Data.Version != 2)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的配置版本（仅支持 version=1/2）"));

        var now = DateTime.UtcNow;
        var opt = request.Options ?? new DataConfigImportOptions();
        var forceOverwrite = opt.ForceOverwriteSameName;
        var deleteNotImported = opt.DeleteNotImported;

        // 1) Upsert platforms（按 Name 唯一）
        var importedPlatforms = request.Data.Platforms
            .Where(p => p != null && !string.IsNullOrWhiteSpace(p.Name))
            .Select(p => new ExportedPlatformV1
            {
                Id = string.IsNullOrWhiteSpace(p.Id) ? null : p.Id.Trim(),
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

        // v2 需要平台 id（用于跨环境保持平台 id 一致）
        if (request.Data.Version == 2 && importedPlatforms.Any(p => string.IsNullOrWhiteSpace(p.Id)))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "version=2 需要 platforms[].id"));

        // 防御：导入数据里同名平台重复会导致覆盖结果不可预测，直接阻断
        var dupImportedNames = importedPlatforms
            .GroupBy(x => x.Name.Trim(), StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (dupImportedNames.Count > 0)
        {
            var sample = string.Join(", ", dupImportedNames.Take(10));
            var msg = dupImportedNames.Count <= 10 ? $"导入数据存在重复平台名：{sample}" : $"导入数据存在重复平台名（示例：{sample} ...，共 {dupImportedNames.Count} 个）";
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, msg));
        }

        // 先查现有平台，构建 name->platform
        var existingPlatforms = await _db.LLMPlatforms.Find(_ => true).ToListAsync();

        // 防御：DB 内存在重复平台名会导致 ToDictionary 抛异常；这里直接阻断导入并提示
        var dupNames = existingPlatforms
            .Where(x => !string.IsNullOrWhiteSpace(x.Name))
            .GroupBy(x => x.Name.Trim(), StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (dupNames.Count > 0)
        {
            var sample = string.Join(", ", dupNames.Take(10));
            var msg = dupNames.Count <= 10 ? $"数据库存在重复平台名：{sample}" : $"数据库存在重复平台名（示例：{sample} ...，共 {dupNames.Count} 个）";
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, msg));
        }

        var existingByName = existingPlatforms
            .Where(x => !string.IsNullOrWhiteSpace(x.Name))
            .ToDictionary(x => x.Name.Trim(), x => x, StringComparer.OrdinalIgnoreCase);

        static string NormUrl(string s)
            => (s ?? string.Empty).Trim().TrimEnd('/').ToLowerInvariant();

        // 危险操作确认门槛：
        // - 同名平台将被覆盖且 URL 不同
        // - 勾选“删除本次未导入”
        var urlConflictCount = 0;
        if (forceOverwrite)
        {
            foreach (var p in importedPlatforms)
            {
                if (!existingByName.TryGetValue(p.Name, out var cur)) continue;
                if (!string.Equals(NormUrl(cur.ApiUrl ?? string.Empty), NormUrl(p.ApiUrl ?? string.Empty), StringComparison.OrdinalIgnoreCase))
                {
                    urlConflictCount++;
                }
            }
        }

        var importedNameSet = new HashSet<string>(importedPlatforms.Select(x => x.Name.Trim()), StringComparer.OrdinalIgnoreCase);
        var deleteTargets = deleteNotImported
            ? existingPlatforms.Where(x => !string.IsNullOrWhiteSpace(x.Name) && !importedNameSet.Contains(x.Name.Trim())).ToList()
            : new List<LLMPlatform>();

        if ((urlConflictCount > 0 || deleteTargets.Count > 0) && !request.Confirmed)
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT,
                $"导入包含危险操作，需二次确认：urlConflicts={urlConflictCount} deleteNotImportedTargets={deleteTargets.Count}（请先 preview 并确认）"));
        }

        // v2：预检新建平台 id 冲突（避免循环中途才发现而产生部分写入）
        if (request.Data.Version == 2)
        {
            var newPlatforms = importedPlatforms.Where(p => !existingByName.ContainsKey(p.Name)).ToList();
            var newIds = newPlatforms
                .Select(p => (p.Id ?? string.Empty).Trim())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToList();
            var dupIds = newIds
                .GroupBy(x => x, StringComparer.OrdinalIgnoreCase)
                .Where(g => g.Count() > 1)
                .Select(g => g.Key)
                .ToList();
            if (dupIds.Count > 0)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"导入数据存在重复平台 id：{string.Join(", ", dupIds.Take(10))}"));
            }

            if (newIds.Count > 0)
            {
                var filter = Builders<LLMPlatform>.Filter.In(x => x.Id, newIds);
                var conflicts = await _db.LLMPlatforms.Find(filter).ToListAsync();
                if (conflicts.Count > 0)
                {
                    var sample = string.Join(", ", conflicts.Take(5).Select(x => $"{x.Name}({x.Id})"));
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"导入平台 id 冲突：{sample}"));
                }
            }
        }

        var platformUpserted = 0;
        var platformInserted = 0;
        var platformUpdated = 0;

        // 更新/插入后，构建 name->id
        var nameToPlatformId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var p in importedPlatforms)
        {
            if (existingByName.TryGetValue(p.Name, out var cur))
            {
                nameToPlatformId[p.Name] = cur.Id;
                if (forceOverwrite)
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
                }
            }
            else
            {
                var created = new LLMPlatform
                {
                    // 仅 version=2 才允许使用导入 id（用于跨环境一致）；v1 一律生成新 id
                    Id = request.Data.Version == 2 && !string.IsNullOrWhiteSpace(p.Id) ? p.Id : Guid.NewGuid().ToString(),
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

        // 2) Upsert models（按 platformId + modelId；存储字段名仍为 ModelName）
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
            // 若未勾选“强制覆盖同名平台”，则该平台的 enabledModels 也不导入（只导入新增平台的模型）
            if (!forceOverwrite && existingByName.ContainsKey(p.Name)) continue;
            foreach (var modelId in p.EnabledModels ?? new List<string>())
            {
                var mid = (modelId ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(mid)) continue;

                var existing = await _db.LLMModels
                    .Find(m => m.PlatformId == platformId && m.ModelName == mid)
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
                        Name = mid,
                        ModelName = mid,
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

        // 4) Delete platforms not imported (optional) + cascade delete models
        if (deleteNotImported && deleteTargets.Count > 0)
        {
            var ids = deleteTargets.Select(x => x.Id).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
            if (ids.Count > 0)
            {
                // 先删模型，避免孤儿
                await _db.LLMModels.DeleteManyAsync(m => ids.Contains(m.PlatformId!));
                await _db.LLMPlatforms.DeleteManyAsync(p => ids.Contains(p.Id));

                // 清理平台可用模型缓存（新旧 key 都清一下）
                foreach (var id in ids)
                {
                    await _cache.RemoveAsync($"platform:models:v2:{id}");
                    await _cache.RemoveAsync($"platform:models:{id}");
                }
            }
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
            Users = await _db.Users.CountDocumentsAsync(_ => true),
            LlmPlatforms = await _db.LLMPlatforms.CountDocumentsAsync(_ => true),
            LlmModelsTotal = await _db.LLMModels.CountDocumentsAsync(_ => true),
            LlmModelsEnabled = await _db.LLMModels.CountDocumentsAsync(x => x.Enabled),
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
    /// 预览：清理用户数据（默认仅清理非 ADMIN 用户；不包含密码哈希）
    /// </summary>
    [HttpGet("users/preview")]
    public async Task<IActionResult> PreviewUsersPurge([FromQuery] int? limit)
    {
        var take = limit ?? 20;
        if (take <= 0) take = 20;
        if (take > 100) take = 100;

        var total = await _db.Users.CountDocumentsAsync(_ => true);
        var adminCount = await _db.Users.CountDocumentsAsync(x => x.Role == UserRole.ADMIN);
        var willDeleteCount = await _db.Users.CountDocumentsAsync(x => x.Role != UserRole.ADMIN);

        var sampleWillDelete = await _db.Users
            .Find(x => x.Role != UserRole.ADMIN)
            .SortByDescending(x => x.CreatedAt)
            .Limit(take)
            .Project(x => new AdminUserPreviewItem
            {
                UserId = x.UserId,
                Username = x.Username,
                DisplayName = x.DisplayName,
                Role = x.Role,
                UserType = x.UserType,
                Status = x.Status,
                CreatedAt = x.CreatedAt,
                LastLoginAt = x.LastLoginAt
            })
            .ToListAsync();

        var sampleAdmins = await _db.Users
            .Find(x => x.Role == UserRole.ADMIN)
            .SortByDescending(x => x.CreatedAt)
            .Limit(10)
            .Project(x => new AdminUserPreviewItem
            {
                UserId = x.UserId,
                Username = x.Username,
                DisplayName = x.DisplayName,
                Role = x.Role,
                UserType = x.UserType,
                Status = x.Status,
                CreatedAt = x.CreatedAt,
                LastLoginAt = x.LastLoginAt
            })
            .ToListAsync();

        var payload = new AdminUsersPurgePreviewResponse
        {
            TotalUsers = total,
            AdminUsers = adminCount,
            WillDeleteUsers = willDeleteCount,
            WillKeepUsers = total - willDeleteCount,
            SampleWillDeleteUsers = sampleWillDelete,
            SampleWillKeepAdmins = sampleAdmins,
            Notes = new List<string>
            {
                "仅删除 Role != ADMIN 的用户账号；管理员账号会保留。",
                "预览不包含密码哈希等敏感字段。",
                "删除用户不会自动级联删除群组/消息等业务数据（如需要彻底清库，请使用“开发期：一键删除（保留核心）”）。"
            }
        };

        return Ok(ApiResponse<AdminUsersPurgePreviewResponse>.Ok(payload));
    }

    /// <summary>
    /// 清理：删除非 ADMIN 用户（支持 Idempotency-Key；需 confirmed=true）
    /// </summary>
    [HttpPost("users/purge")]
    public async Task<IActionResult> PurgeUsers([FromBody] AdminUsersPurgeRequest request)
    {
        if (request == null || !request.Confirmed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "confirmed 必须为 true"));

        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:data:purge-users:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<AdminUsersPurgeResponse>(cacheKey);
            if (cached != null)
            {
                return Ok(ApiResponse<AdminUsersPurgeResponse>.Ok(cached));
            }
        }

        // 仅删除非 ADMIN 用户
        var toDeleteUserIds = await _db.Users
            .Find(x => x.Role != UserRole.ADMIN)
            .Project(x => x.UserId)
            .ToListAsync();

        var usersDeleted = 0L;
        var groupMembersDeleted = 0L;

        if (toDeleteUserIds.Count > 0)
        {
            usersDeleted = (await _db.Users.DeleteManyAsync(x => x.Role != UserRole.ADMIN)).DeletedCount;
            groupMembersDeleted = (await _db.GroupMembers.DeleteManyAsync(x => toDeleteUserIds.Contains(x.UserId))).DeletedCount;

            // 尽量清掉用户相关缓存（避免 UI 看到“幽灵数据”）
            await _cache.RemoveByPatternAsync($"{CacheKeys.UserSession}*");
        }

        var payload = new AdminUsersPurgeResponse
        {
            UsersDeleted = usersDeleted,
            GroupMembersDeleted = groupMembersDeleted,
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:data:purge-users:{adminId}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, PurgeIdempotencyExpiry);
        }

        _logger.LogWarning("Admin purge users executed. usersDeleted={UsersDeleted}, groupMembersDeleted={GroupMembersDeleted}",
            payload.UsersDeleted, payload.GroupMembersDeleted);

        return Ok(ApiResponse<AdminUsersPurgeResponse>.Ok(payload));
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
            await _db.Database.DropCollectionAsync("llmrequestlogs");
            payload.LlmRequestLogs = 0; // drop 操作无法返回删除数量
        }

        // sessions/messages
        if (requested.Contains("sessionsmessages") || requested.Contains("sessions") || requested.Contains("messages"))
        {
            matchedAny = true;
            await _db.Database.DropCollectionAsync("messages");
            await _db.Database.DropCollectionAsync("image_master_sessions");
            await _db.Database.DropCollectionAsync("image_master_messages");

            payload.Messages = 0;
            payload.ImageMasterSessions = 0;
            payload.ImageMasterMessages = 0;

            // 清掉会话/聊天缓存（避免 UI 看到"幽灵数据"）
            await _cache.RemoveByPatternAsync($"{CacheKeys.Session}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.ChatHistory}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.GroupChatHistory}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.UserSession}*");
        }

        // documents / kb-like
        if (requested.Contains("documents") || requested.Contains("docs") || requested.Contains("knowledgebase") || requested.Contains("kb"))
        {
            matchedAny = true;
            await _db.Database.DropCollectionAsync("documents");
            await _db.Database.DropCollectionAsync("attachments");
            await _db.Database.DropCollectionAsync("contentgaps");
            await _db.Database.DropCollectionAsync("prdcomments");

            payload.Documents = 0;
            payload.Attachments = 0;
            payload.ContentGaps = 0;
            payload.PrdComments = 0;

            await _cache.RemoveByPatternAsync($"{CacheKeys.Document}*");
        }

        // dev reset：保留 users + llmplatforms + 启用 llmmodels，其余全清（开发期维护）
        if (requested.Contains("devreset") || requested.Contains("devresetkeepmodels") || requested.Contains("resetkeepmodels"))
        {
            matchedAny = true;

            // 1) 删除未启用模型（仅保留 enabled=true）
            var delDisabledModels = await _db.LLMModels.DeleteManyAsync(x => !x.Enabled);
            payload.DisabledModelsDeleted = delDisabledModels.DeletedCount;

            // 2) 清掉"配置/提示词/日志/会话/业务数据/图片/实验"等全部非核心集合（使用 drop 而非 remove）
            await _db.Database.DropCollectionAsync("groups");
            await _db.Database.DropCollectionAsync("groupmembers");
            await _db.Database.DropCollectionAsync("group_message_counters");
            await _db.Database.DropCollectionAsync("messages");
            await _db.Database.DropCollectionAsync("documents");
            await _db.Database.DropCollectionAsync("attachments");
            await _db.Database.DropCollectionAsync("contentgaps");
            await _db.Database.DropCollectionAsync("prdcomments");
            await _db.Database.DropCollectionAsync("invitecodes");
            await _db.Database.DropCollectionAsync("llmconfigs");
            await _db.Database.DropCollectionAsync("appsettings");
            await _db.Database.DropCollectionAsync("promptstages");
            await _db.Database.DropCollectionAsync("systemprompts");
            await _db.Database.DropCollectionAsync("llmrequestlogs");
            await _db.Database.DropCollectionAsync("apirequestlogs");

            await _db.Database.DropCollectionAsync("model_lab_experiments");
            await _db.Database.DropCollectionAsync("model_lab_runs");
            await _db.Database.DropCollectionAsync("model_lab_run_items");
            await _db.Database.DropCollectionAsync("model_lab_model_sets");
            await _db.Database.DropCollectionAsync("model_lab_groups");

            await _db.Database.DropCollectionAsync("image_master_sessions");
            await _db.Database.DropCollectionAsync("image_master_messages");
            await _db.Database.DropCollectionAsync("image_assets");
            await _db.Database.DropCollectionAsync("image_master_canvases");
            await _db.Database.DropCollectionAsync("image_master_workspaces");

            await _db.Database.DropCollectionAsync("image_gen_size_caps");
            await _db.Database.DropCollectionAsync("image_gen_runs");
            await _db.Database.DropCollectionAsync("image_gen_run_items");
            await _db.Database.DropCollectionAsync("image_gen_run_events");

            await _db.Database.DropCollectionAsync("upload_artifacts");
            await _db.Database.DropCollectionAsync("admin_prompt_overrides");
            await _db.Database.DropCollectionAsync("admin_idempotency");

            payload.OtherDeleted = 0; // drop 操作无法返回删除数量

            // 3) cache 清理：尽量清空相关前缀（避免 UI 看到幽灵数据）
            await _cache.RemoveByPatternAsync($"{CacheKeys.Session}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.ChatHistory}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.GroupChatHistory}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.UserSession}*");
            await _cache.RemoveByPatternAsync($"{CacheKeys.Document}*");
            await _cache.RemoveByPatternAsync("platform:models:*");
            await _cache.RemoveByPatternAsync("platform:models:v2:*");
        }

        // 校验：至少匹配到一个 domain，否则视为格式错误（即使数据本来为空，也应返回成功）
        if (!matchedAny)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "domains 不支持（可选：llmLogs, sessionsMessages, documents, devReset）"));
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
    public string? Id { get; set; }
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

    /// <summary>
    /// 是否覆盖同名平台（按 name 匹配）。默认 true。
    /// </summary>
    public bool ForceOverwriteSameName { get; set; } = true;

    /// <summary>
    /// 是否删除“本次未导入”的平台（按 name），并级联删除该平台下已配置模型。默认 false。
    /// </summary>
    public bool DeleteNotImported { get; set; } = false;
}

public class DataConfigImportRequest
{
    public ExportedConfigV1 Data { get; set; } = new();
    public DataConfigImportOptions? Options { get; set; }

    /// <summary>
    /// 对“危险操作”（URL 冲突/删除未导入）的二次确认标记。
    /// </summary>
    public bool Confirmed { get; set; } = false;
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

public class DataConfigImportPreviewResponse
{
    public int Version { get; set; }
    public int ImportedPlatformCount { get; set; }
    public int ImportedEnabledModelCount { get; set; }
    public int ExistingPlatformCount { get; set; }

    public bool ForceOverwriteSameName { get; set; }
    public bool DeleteNotImported { get; set; }

    public List<ImportPlatformInsertItem> WillInsertPlatforms { get; set; } = new();
    public List<ImportPlatformUpdateItem> WillUpdatePlatforms { get; set; } = new();
    public List<ImportPlatformUrlConflictItem> UrlConflicts { get; set; } = new();
    public List<ImportPlatformDeleteItem> WillDeletePlatforms { get; set; } = new();

    public List<string> Notes { get; set; } = new();
    public bool RequiresConfirmation { get; set; }
}

public class ImportPlatformInsertItem
{
    public string? Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string ApiUrl { get; set; } = string.Empty;
}

public class ImportPlatformUpdateItem
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string CurrentApiUrl { get; set; } = string.Empty;
    public string ImportedApiUrl { get; set; } = string.Empty;
    public bool ApiUrlChanged { get; set; }
}

public class ImportPlatformUrlConflictItem
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string CurrentApiUrl { get; set; } = string.Empty;
    public string ImportedApiUrl { get; set; } = string.Empty;
}

public class ImportPlatformDeleteItem
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? ApiUrl { get; set; }
}

public class DataSummaryResponse
{
    // 核心保留数据（开发期“保留核心清库”会保留这些）
    public long Users { get; set; }
    public long LlmPlatforms { get; set; }
    public long LlmModelsTotal { get; set; }
    public long LlmModelsEnabled { get; set; }

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

    // devReset：额外统计
    public long DisabledModelsDeleted { get; set; }
    public long OtherDeleted { get; set; }

    public bool AllZero()
    {
        return LlmRequestLogs == 0
               && Messages == 0
               && Documents == 0
               && Attachments == 0
               && ContentGaps == 0
               && PrdComments == 0
               && ImageMasterSessions == 0
               && ImageMasterMessages == 0
               && DisabledModelsDeleted == 0
               && OtherDeleted == 0;
    }
}

public class AdminUsersPurgeRequest
{
    /// <summary>
    /// 强制二次确认：必须为 true 才会执行删除
    /// </summary>
    public bool Confirmed { get; set; }
}

public class AdminUsersPurgePreviewResponse
{
    public long TotalUsers { get; set; }
    public long AdminUsers { get; set; }
    public long WillDeleteUsers { get; set; }
    public long WillKeepUsers { get; set; }

    public List<AdminUserPreviewItem> SampleWillDeleteUsers { get; set; } = new();
    public List<AdminUserPreviewItem> SampleWillKeepAdmins { get; set; } = new();

    public List<string> Notes { get; set; } = new();
}

public class AdminUsersPurgeResponse
{
    public long UsersDeleted { get; set; }
    public long GroupMembersDeleted { get; set; }
}

public class AdminUserPreviewItem
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public UserType UserType { get; set; }
    public UserStatus Status { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
}


