using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 知识库 ASR 一键配置
/// —————————————————————————————————————————————
/// 目的：让"上传录音 → 转文字"零摩擦跑起来。
/// 管理员只需提供 OpenRouter API Key（或自有 OpenAI 兼容平台 Key），
/// 端点自动建好：
///   1) LLMPlatform（OpenRouter，PlatformType=openai）
///   2) LLMModel（默认 google/gemini-2.5-flash，多模态接受 input_audio）
///   3) ModelGroup（Code=document-store-asr-openrouter，ModelType=asr）
///   4) LLMAppCaller(document-store.subtitle::asr).ModelRequirements[asr].ModelGroupIds 加上池 ID
/// 之后用户上传 m4a/mp3 → SubtitleGenerationProcessor 自动走多模态 chat 路径调 OpenRouter 转写。
/// —————————————————————————————————————————————
/// 注意：
///   - 仅写入 MongoDB，不调上游验证 Key 有效性（避免误把可用 Key 误判为无效）。
///   - 重复调用幂等：同名平台/模型/池更新而非新建。
/// </summary>
[ApiController]
[Route("api/document-store/asr-setup")]
[Authorize]
[AdminController("document-store", AdminPermissionCatalog.ModelsRead,
    WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class AsrQuickSetupController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IConfiguration _config;
    private readonly IIdGenerator _idGenerator;
    private readonly ILogger<AsrQuickSetupController> _logger;

    public AsrQuickSetupController(
        MongoDbContext db,
        IConfiguration config,
        IIdGenerator idGenerator,
        ILogger<AsrQuickSetupController> logger)
    {
        _db = db;
        _config = config;
        _idGenerator = idGenerator;
        _logger = logger;
    }

    /// <summary>
    /// 一键配置 OpenRouter 多模态 ASR。
    /// </summary>
    [HttpPost("openrouter")]
    public async Task<IActionResult> SetupOpenRouter(
        [FromBody] OpenRouterAsrSetupRequest request, CancellationToken ct = default)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.ApiKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请提供 OpenRouter API Key"));

        // 默认走 Gemini 2.5 Flash —— OpenRouter 上原生支持 input_audio 的多模态模型里
        // 综合了"中文识别质量 + 单价 + 速度"。用户可显式指定其它模型，例如：
        //   - openai/gpt-4o-audio-preview
        //   - openai/gpt-4o-mini-audio-preview
        //   - google/gemini-2.0-flash-001
        var modelName = string.IsNullOrWhiteSpace(request.ModelName)
            ? "google/gemini-2.5-flash"
            : request.ModelName.Trim();
        var displayName = string.IsNullOrWhiteSpace(request.DisplayName)
            ? $"OpenRouter · {modelName.Split('/').LastOrDefault() ?? modelName}"
            : request.DisplayName.Trim();
        var apiUrl = string.IsNullOrWhiteSpace(request.ApiUrl)
            ? "https://openrouter.ai/api/v1"
            : request.ApiUrl.Trim().TrimEnd('/');

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        var encrypted = ApiKeyCrypto.Encrypt(request.ApiKey.Trim(), jwtSecret);

        // 1) Upsert Platform（按 ApiUrl + Name 维度复用）
        var platform = await _db.LLMPlatforms
            .Find(p => p.Name == "OpenRouter (ASR)" || p.ApiUrl == apiUrl)
            .FirstOrDefaultAsync(ct);

        if (platform == null)
        {
            platform = new LLMPlatform
            {
                Id = await _idGenerator.GenerateIdAsync("platform"),
                Name = "OpenRouter (ASR)",
                PlatformType = "openai",
                ProviderId = "openrouter",
                ApiUrl = apiUrl,
                ApiKeyEncrypted = encrypted,
                Enabled = true,
                MaxConcurrency = 5,
                Remark = "知识库录音转写默认平台（多模态 chat 做 ASR）",
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            await _db.LLMPlatforms.InsertOneAsync(platform, cancellationToken: ct);
            _logger.LogInformation("[asr-setup] Created platform {PlatformId}", platform.Id);
        }
        else
        {
            await _db.LLMPlatforms.UpdateOneAsync(
                p => p.Id == platform.Id,
                Builders<LLMPlatform>.Update
                    .Set(p => p.ApiKeyEncrypted, encrypted)
                    .Set(p => p.ApiUrl, apiUrl)
                    .Set(p => p.Enabled, true)
                    .Set(p => p.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            _logger.LogInformation("[asr-setup] Updated existing platform {PlatformId}", platform.Id);
        }

        // 2) Upsert Model
        var llmModel = await _db.LLMModels
            .Find(m => m.PlatformId == platform.Id && m.ModelName == modelName)
            .FirstOrDefaultAsync(ct);

        if (llmModel == null)
        {
            llmModel = new LLMModel
            {
                Id = await _idGenerator.GenerateIdAsync("model"),
                Name = displayName,
                ModelName = modelName,
                PlatformId = platform.Id,
                Group = "ASR",
                Enabled = true,
                Priority = 50,
                Timeout = 600_000, // 10 min for long audio
                MaxRetries = 1,
                MaxConcurrency = 3,
                EnablePromptCache = false,
                Remark = "多模态 chat 做音频转写（input_audio content block）",
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            await _db.LLMModels.InsertOneAsync(llmModel, cancellationToken: ct);
            _logger.LogInformation("[asr-setup] Created model {ModelId} ({ModelName})", llmModel.Id, modelName);
        }
        else
        {
            await _db.LLMModels.UpdateOneAsync(
                m => m.Id == llmModel.Id,
                Builders<LLMModel>.Update
                    .Set(m => m.Name, displayName)
                    .Set(m => m.Enabled, true)
                    .Set(m => m.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }

        // 3) Upsert ModelGroup
        const string groupCode = "document-store-asr-openrouter";
        var group = await _db.ModelGroups
            .Find(g => g.Code == groupCode)
            .FirstOrDefaultAsync(ct);

        if (group == null)
        {
            group = new ModelGroup
            {
                Id = Guid.NewGuid().ToString("N"),
                Name = "知识库 ASR · OpenRouter 多模态",
                Code = groupCode,
                Priority = 50,
                ModelType = ModelTypes.Asr,
                IsDefaultForType = false,
                StrategyType = 0,
                Description = "通过 OpenRouter 多模态 chat（input_audio）做音频转写",
                Models = new List<ModelGroupItem>
                {
                    new()
                    {
                        ModelId = llmModel.Id,
                        PlatformId = platform.Id,
                        Priority = 1,
                        HealthStatus = ModelHealthStatus.Healthy,
                    },
                },
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            await _db.ModelGroups.InsertOneAsync(group, cancellationToken: ct);
            _logger.LogInformation("[asr-setup] Created model group {GroupId}", group.Id);
        }
        else
        {
            // 确保新模型挂在池里
            var hasModel = group.Models.Any(m => m.ModelId == llmModel.Id);
            if (!hasModel)
            {
                group.Models.Add(new ModelGroupItem
                {
                    ModelId = llmModel.Id,
                    PlatformId = platform.Id,
                    Priority = group.Models.Count + 1,
                    HealthStatus = ModelHealthStatus.Healthy,
                });
            }
            await _db.ModelGroups.UpdateOneAsync(
                g => g.Id == group.Id,
                Builders<ModelGroup>.Update
                    .Set(g => g.Models, group.Models)
                    .Set(g => g.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }

        // 4) Bind ModelGroup → LLMAppCaller(document-store.subtitle::asr)
        const string appCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio;
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == appCode)
            .FirstOrDefaultAsync(ct);

        if (appCaller == null)
        {
            appCaller = new LLMAppCaller
            {
                Id = Guid.NewGuid().ToString("N"),
                AppCode = appCode,
                DisplayName = "知识库字幕生成-音频",
                Description = "将音视频文件直译成带时间戳的字幕 Markdown",
                IsAutoRegistered = true,
                IsSystemDefault = true,
                ModelRequirements = new List<AppModelRequirement>
                {
                    new()
                    {
                        ModelType = ModelTypes.Asr,
                        Purpose = "音频转写",
                        ModelGroupIds = new List<string> { group.Id },
                        IsRequired = true,
                    },
                },
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            await _db.LLMAppCallers.InsertOneAsync(appCaller, cancellationToken: ct);
        }
        else
        {
            var asrReq = appCaller.ModelRequirements.FirstOrDefault(r => r.ModelType == ModelTypes.Asr);
            if (asrReq == null)
            {
                appCaller.ModelRequirements.Add(new AppModelRequirement
                {
                    ModelType = ModelTypes.Asr,
                    Purpose = "音频转写",
                    ModelGroupIds = new List<string> { group.Id },
                    IsRequired = true,
                });
            }
            else if (!asrReq.ModelGroupIds.Contains(group.Id))
            {
                asrReq.ModelGroupIds.Add(group.Id);
            }
            await _db.LLMAppCallers.UpdateOneAsync(
                a => a.Id == appCaller.Id,
                Builders<LLMAppCaller>.Update
                    .Set(a => a.ModelRequirements, appCaller.ModelRequirements)
                    .Set(a => a.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            ok = true,
            platformId = platform.Id,
            modelId = llmModel.Id,
            modelName = llmModel.ModelName,
            groupId = group.Id,
            appCode,
            message = $"已配置 OpenRouter ASR：{displayName}。回到知识库上传音频即可触发转写。",
        }));
    }

    /// <summary>
    /// 检查当前 ASR 配置状态（前端用来决定是否显示"快速配置"按钮）。
    /// </summary>
    [HttpGet("status")]
    public async Task<IActionResult> GetStatus(CancellationToken ct = default)
    {
        const string appCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio;
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == appCode)
            .FirstOrDefaultAsync(ct);

        var groupIds = appCaller?.ModelRequirements
            .FirstOrDefault(r => r.ModelType == ModelTypes.Asr)
            ?.ModelGroupIds ?? new List<string>();

        // 同时考虑默认池兜底
        var hasDefault = await _db.ModelGroups
            .Find(g => g.ModelType == ModelTypes.Asr && g.IsDefaultForType)
            .AnyAsync(ct);

        var bound = groupIds.Count > 0 || hasDefault;

        // 检测是否已经有 OpenRouter ASR 平台（用于决定按钮文案 setup vs reconfigure）
        var hasOpenRouter = await _db.LLMPlatforms
            .Find(p => p.Name == "OpenRouter (ASR)")
            .AnyAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            configured = bound,
            hasOpenRouter,
            boundGroupIds = groupIds,
        }));
    }
}

public class OpenRouterAsrSetupRequest
{
    /// <summary>OpenRouter 或任何 OpenAI 兼容平台的 API Key（必填）</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>模型 ID（默认 google/gemini-2.5-flash）</summary>
    public string? ModelName { get; set; }

    /// <summary>API 基础地址（默认 https://openrouter.ai/api/v1）</summary>
    public string? ApiUrl { get; set; }

    /// <summary>展示名（默认基于 ModelName 自动生成）</summary>
    public string? DisplayName { get; set; }
}
