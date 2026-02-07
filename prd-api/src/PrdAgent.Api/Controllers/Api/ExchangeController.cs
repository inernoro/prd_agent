using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Transformers;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 模型中继 (Exchange) 控制器
/// </summary>
[ApiController]
[Route("api/mds/exchanges")]
[Authorize]
[AdminController("mds", AdminPermissionCatalog.ModelsRead, WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class ExchangeController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ExchangeController> _logger;
    private readonly IConfiguration _config;
    private readonly ExchangeTransformerRegistry _transformerRegistry = new();

    public ExchangeController(MongoDbContext db, ILogger<ExchangeController> logger, IConfiguration config)
    {
        _db = db;
        _logger = logger;
        _config = config;
    }

    /// <summary>
    /// 获取所有 Exchange 配置
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetExchanges(CancellationToken ct)
    {
        var list = await _db.ModelExchanges
            .Find(FilterDefinition<ModelExchange>.Empty)
            .SortByDescending(e => e.CreatedAt)
            .ToListAsync(ct);

        var result = list.Select(e => new
        {
            e.Id,
            e.Name,
            e.ModelAlias,
            e.TargetUrl,
            apiKeyMasked = ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(e.TargetApiKeyEncrypted, GetJwtSecret())),
            e.TargetAuthScheme,
            e.TransformerType,
            e.TransformerConfig,
            e.Enabled,
            e.Description,
            e.CreatedAt,
            e.UpdatedAt,
            // 虚拟平台 ID，前端在模型池中使用
            platformId = ModelResolverConstants.ExchangePlatformId,
            platformName = ModelResolverConstants.ExchangePlatformName
        });

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 获取单个 Exchange 配置
    /// </summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetExchange(string id, CancellationToken ct)
    {
        var exchange = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (exchange == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        return Ok(ApiResponse<object>.Ok(new
        {
            exchange.Id,
            exchange.Name,
            exchange.ModelAlias,
            exchange.TargetUrl,
            apiKeyMasked = ApiKeyCrypto.Mask(ApiKeyCrypto.Decrypt(exchange.TargetApiKeyEncrypted, GetJwtSecret())),
            exchange.TargetAuthScheme,
            exchange.TransformerType,
            exchange.TransformerConfig,
            exchange.Enabled,
            exchange.Description,
            exchange.CreatedAt,
            exchange.UpdatedAt
        }));
    }

    /// <summary>
    /// 创建 Exchange 配置
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateExchange([FromBody] CreateExchangeRequest request, CancellationToken ct)
    {
        // 校验 ModelAlias 唯一性
        var existing = await _db.ModelExchanges
            .Find(e => e.ModelAlias == request.ModelAlias.Trim())
            .FirstOrDefaultAsync(ct);
        if (existing != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"ModelAlias '{request.ModelAlias}' 已存在"));

        // 校验 TransformerType 是否已注册
        if (!string.IsNullOrWhiteSpace(request.TransformerType) &&
            _transformerRegistry.Get(request.TransformerType) == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"未知的转换器类型: {request.TransformerType}"));
        }

        var exchange = new ModelExchange
        {
            Name = request.Name.Trim(),
            ModelAlias = request.ModelAlias.Trim(),
            TargetUrl = request.TargetUrl.Trim(),
            TargetApiKeyEncrypted = ApiKeyCrypto.Encrypt(request.TargetApiKey ?? string.Empty, GetJwtSecret()),
            TargetAuthScheme = string.IsNullOrWhiteSpace(request.TargetAuthScheme) ? "Bearer" : request.TargetAuthScheme.Trim(),
            TransformerType = string.IsNullOrWhiteSpace(request.TransformerType) ? "passthrough" : request.TransformerType.Trim(),
            TransformerConfig = request.TransformerConfig,
            Enabled = request.Enabled,
            Description = request.Description?.Trim()
        };

        await _db.ModelExchanges.InsertOneAsync(exchange, cancellationToken: ct);

        _logger.LogInformation("[Exchange] 创建 Exchange: {Id} / {Name} / {ModelAlias}", exchange.Id, exchange.Name, exchange.ModelAlias);

        return Ok(ApiResponse<object>.Ok(new { exchange.Id }));
    }

    /// <summary>
    /// 更新 Exchange 配置
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateExchange(string id, [FromBody] UpdateExchangeRequest request, CancellationToken ct)
    {
        var existing = await _db.ModelExchanges.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (existing == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        // 检查 ModelAlias 唯一性（排除自身）
        if (!string.IsNullOrWhiteSpace(request.ModelAlias))
        {
            var conflict = await _db.ModelExchanges
                .Find(e => e.ModelAlias == request.ModelAlias.Trim() && e.Id != id)
                .FirstOrDefaultAsync(ct);
            if (conflict != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"ModelAlias '{request.ModelAlias}' 已被其他 Exchange 使用"));
        }

        // 校验 TransformerType
        if (!string.IsNullOrWhiteSpace(request.TransformerType) &&
            _transformerRegistry.Get(request.TransformerType) == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"未知的转换器类型: {request.TransformerType}"));
        }

        var update = Builders<ModelExchange>.Update
            .Set(e => e.Name, request.Name?.Trim() ?? existing.Name)
            .Set(e => e.ModelAlias, request.ModelAlias?.Trim() ?? existing.ModelAlias)
            .Set(e => e.TargetUrl, request.TargetUrl?.Trim() ?? existing.TargetUrl)
            .Set(e => e.TargetAuthScheme, request.TargetAuthScheme?.Trim() ?? existing.TargetAuthScheme)
            .Set(e => e.TransformerType, request.TransformerType?.Trim() ?? existing.TransformerType)
            .Set(e => e.TransformerConfig, request.TransformerConfig ?? existing.TransformerConfig)
            .Set(e => e.Enabled, request.Enabled ?? existing.Enabled)
            .Set(e => e.Description, request.Description?.Trim())
            .Set(e => e.UpdatedAt, DateTime.UtcNow);

        // 仅在提供了新 ApiKey 时更新
        if (!string.IsNullOrEmpty(request.TargetApiKey))
        {
            update = update.Set(e => e.TargetApiKeyEncrypted, ApiKeyCrypto.Encrypt(request.TargetApiKey, GetJwtSecret()));
        }

        await _db.ModelExchanges.UpdateOneAsync(e => e.Id == id, update, cancellationToken: ct);

        _logger.LogInformation("[Exchange] 更新 Exchange: {Id} / {Name}", id, request.Name);

        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 删除 Exchange 配置
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteExchange(string id, CancellationToken ct)
    {
        var result = await _db.ModelExchanges.DeleteOneAsync(e => e.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Exchange 不存在"));

        _logger.LogInformation("[Exchange] 删除 Exchange: {Id}", id);

        return Ok(ApiResponse<object>.Ok(new { id }));
    }

    /// <summary>
    /// 获取所有已注册的转换器类型（供前端下拉选择）
    /// </summary>
    [HttpGet("transformer-types")]
    public IActionResult GetTransformerTypes()
    {
        var types = _transformerRegistry.GetRegisteredTypes()
            .Select(t => new { value = t, label = t })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = types }));
    }

    /// <summary>
    /// 获取 Exchange 列表（精简版，供模型池添加模型时选择）
    /// </summary>
    [HttpGet("for-pool")]
    public async Task<IActionResult> GetExchangesForPool(CancellationToken ct)
    {
        var filter = Builders<ModelExchange>.Filter.Eq(e => e.Enabled, true);
        var list = await _db.ModelExchanges
            .Find(filter)
            .SortBy(e => e.Name)
            .ToListAsync(ct);

        var result = list.Select(e => new
        {
            modelId = e.ModelAlias,
            platformId = ModelResolverConstants.ExchangePlatformId,
            platformName = ModelResolverConstants.ExchangePlatformName,
            displayName = $"[Exchange] {e.Name} ({e.ModelAlias})",
            e.TransformerType
        });

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    private string GetJwtSecret() => _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
}

// ========== Request DTOs ==========

public class CreateExchangeRequest
{
    public string Name { get; set; } = string.Empty;
    public string ModelAlias { get; set; } = string.Empty;
    public string TargetUrl { get; set; } = string.Empty;
    public string? TargetApiKey { get; set; }
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public Dictionary<string, object>? TransformerConfig { get; set; }
    public bool Enabled { get; set; } = true;
    public string? Description { get; set; }
}

public class UpdateExchangeRequest
{
    public string? Name { get; set; }
    public string? ModelAlias { get; set; }
    public string? TargetUrl { get; set; }
    public string? TargetApiKey { get; set; }
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public Dictionary<string, object>? TransformerConfig { get; set; }
    public bool? Enabled { get; set; }
    public string? Description { get; set; }
}
