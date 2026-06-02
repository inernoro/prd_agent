using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 产品管理智能体 — 产品-版本-需求-功能-客户全链路串联 + 通用表单/状态机引擎。
///
/// 定位：持续演进的产品研发管理（区别于 pm-agent 的临时性项目管理）。
/// 缺陷复用 defect-agent（本控制器只持追溯引用，不重建缺陷实体）；
/// 知识库复用 DocumentStore（KnowledgeStoreId 挂载，P1）。
/// appKey 硬编码 product-agent（应用身份隔离，见 .claude/rules/app-identity.md）。
/// </summary>
[ApiController]
[Route("api/product")]
[Authorize]
[AdminController("product-agent", AdminPermissionCatalog.ProductAgentUse)]
public class ProductAgentController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ProductAgentController> _logger;

    public ProductAgentController(MongoDbContext db, ILogger<ProductAgentController> logger)
    {
        _db = db;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>是否具备指定权限（super 全通过）。</summary>
    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
    }

    /// <summary>查可访问的产品（owner / member / 管理权限）。无权返回 null。</summary>
    private async Task<Product?> FindAccessibleProductAsync(string productId, string userId)
    {
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null) return null;
        if (HasPermission(AdminPermissionCatalog.ProductAgentManage)) return product;
        if (product.OwnerId == userId || product.MemberIds.Contains(userId)) return product;
        return null;
    }

    // ════════════════════════ 产品 Product ════════════════════════

    /// <summary>创建产品（自动生成产品编号）</summary>
    [HttpPost("products")]
    public async Task<IActionResult> CreateProduct([FromBody] UpsertProductRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "产品名称不能为空"));
        if (!string.IsNullOrWhiteSpace(request.Grade) && !ProductGrade.All.Contains(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的产品分级"));

        var userId = GetUserId();
        var owner = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();

        var product = new Product
        {
            ProductNo = await GenerateNoAsync("PRD", _db.Products, "ProductNo"),
            Name = request.Name.Trim(),
            Code = request.Code?.Trim(),
            Description = request.Description?.Trim(),
            Grade = string.IsNullOrWhiteSpace(request.Grade) ? ProductGrade.Normal : request.Grade,
            TemplateId = request.TemplateId,
            WorkflowDefId = request.WorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
            OwnerName = owner?.DisplayName,
            MemberIds = (request.MemberIds ?? new()).Append(userId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList(),
        };
        product.CurrentState = await ResolveInitialStateAsync(request.WorkflowDefId);

        await _db.Products.InsertOneAsync(product);
        _logger.LogInformation("[product-agent] Product created: {No} '{Name}' by {User}", product.ProductNo, product.Name, userId);
        return Ok(ApiResponse<object>.Ok(product));
    }

    /// <summary>产品列表（我负责的 / 我参与的 / 管理员看全部）</summary>
    [HttpGet("products")]
    public async Task<IActionResult> ListProducts([FromQuery] int page = 1, [FromQuery] int pageSize = 20, [FromQuery] string? grade = null, [FromQuery] string? keyword = null)
    {
        var userId = GetUserId();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var b = Builders<Product>.Filter;
        var conds = new List<FilterDefinition<Product>> { b.Eq(p => p.IsDeleted, false) };
        if (!HasPermission(AdminPermissionCatalog.ProductAgentManage))
            conds.Add(b.Or(b.Eq(p => p.OwnerId, userId), b.AnyEq(p => p.MemberIds, userId)));
        if (!string.IsNullOrWhiteSpace(grade) && ProductGrade.All.Contains(grade))
            conds.Add(b.Eq(p => p.Grade, grade));
        if (!string.IsNullOrWhiteSpace(keyword))
            conds.Add(b.Or(
                b.Regex(p => p.Name, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                b.Regex(p => p.ProductNo, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))));

        var filter = b.And(conds);
        var total = await _db.Products.CountDocumentsAsync(filter);
        var items = await _db.Products.Find(filter)
            .SortByDescending(p => p.UpdatedAt)
            .Skip((page - 1) * pageSize).Limit(pageSize).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>产品详情</summary>
    [HttpGet("products/{productId}")]
    public async Task<IActionResult> GetProduct(string productId)
    {
        var product = await FindAccessibleProductAsync(productId, GetUserId());
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        return Ok(ApiResponse<object>.Ok(product));
    }

    /// <summary>更新产品</summary>
    [HttpPut("products/{productId}")]
    public async Task<IActionResult> UpdateProduct(string productId, [FromBody] UpsertProductRequest request)
    {
        var userId = GetUserId();
        var product = await FindAccessibleProductAsync(productId, userId);
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (!string.IsNullOrWhiteSpace(request.Grade) && !ProductGrade.All.Contains(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的产品分级"));

        var update = Builders<Product>.Update.Set(p => p.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.Name)) update = update.Set(p => p.Name, request.Name.Trim());
        update = update.Set(p => p.Code, request.Code?.Trim());
        update = update.Set(p => p.Description, request.Description?.Trim());
        if (!string.IsNullOrWhiteSpace(request.Grade)) update = update.Set(p => p.Grade, request.Grade);
        if (request.TemplateId != null) update = update.Set(p => p.TemplateId, request.TemplateId);
        if (request.WorkflowDefId != null) update = update.Set(p => p.WorkflowDefId, request.WorkflowDefId);
        if (request.FormData != null) update = update.Set(p => p.FormData, request.FormData);
        if (request.MemberIds != null) update = update.Set(p => p.MemberIds, request.MemberIds);

        await _db.Products.UpdateOneAsync(p => p.Id == productId, update);
        var updated = await _db.Products.Find(p => p.Id == productId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除产品（软删除，需管理权限）</summary>
    [HttpDelete("products/{productId}")]
    public async Task<IActionResult> DeleteProduct(string productId)
    {
        var userId = GetUserId();
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        if (product.OwnerId != userId && !HasPermission(AdminPermissionCatalog.ProductAgentManage))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅产品负责人或管理员可删除"));

        await _db.Products.UpdateOneAsync(p => p.Id == productId,
            Builders<Product>.Update.Set(p => p.IsDeleted, true).Set(p => p.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 版本 Version ════════════════════════

    /// <summary>版本列表（按产品）</summary>
    [HttpGet("products/{productId}/versions")]
    public async Task<IActionResult> ListVersions(string productId)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var items = await _db.ProductVersions.Find(v => v.ProductId == productId && !v.IsDeleted)
            .SortByDescending(v => v.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建版本</summary>
    [HttpPost("products/{productId}/versions")]
    public async Task<IActionResult> CreateVersion(string productId, [FromBody] UpsertVersionRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.VersionName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "版本名不能为空"));
        if (!string.IsNullOrWhiteSpace(request.Lifecycle) && !ProductVersionLifecycle.All.Contains(request.Lifecycle))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的版本生命周期"));

        var version = new ProductVersion
        {
            ProductId = productId,
            VersionName = request.VersionName.Trim(),
            Description = request.Description?.Trim(),
            IsMajor = request.IsMajor,
            ParentVersionId = request.ParentVersionId,
            Lifecycle = string.IsNullOrWhiteSpace(request.Lifecycle) ? ProductVersionLifecycle.Planning : request.Lifecycle,
            PlannedReleaseAt = request.PlannedReleaseAt,
            RequirementIds = request.RequirementIds ?? new(),
            FeatureVersionIds = request.FeatureVersionIds ?? new(),
            TemplateId = request.TemplateId,
            WorkflowDefId = request.WorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
        };
        version.CurrentState = await ResolveInitialStateAsync(request.WorkflowDefId);

        await _db.ProductVersions.InsertOneAsync(version);
        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(version));
    }

    /// <summary>更新版本</summary>
    [HttpPut("versions/{versionId}")]
    public async Task<IActionResult> UpdateVersion(string versionId, [FromBody] UpsertVersionRequest request)
    {
        var version = await _db.ProductVersions.Find(v => v.Id == versionId && !v.IsDeleted).FirstOrDefaultAsync();
        if (version == null || await FindAccessibleProductAsync(version.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在或无权访问"));
        if (!string.IsNullOrWhiteSpace(request.Lifecycle) && !ProductVersionLifecycle.All.Contains(request.Lifecycle))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的版本生命周期"));

        var u = Builders<ProductVersion>.Update.Set(v => v.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.VersionName)) u = u.Set(v => v.VersionName, request.VersionName.Trim());
        u = u.Set(v => v.Description, request.Description?.Trim());
        u = u.Set(v => v.IsMajor, request.IsMajor);
        if (request.ParentVersionId != null) u = u.Set(v => v.ParentVersionId, request.ParentVersionId);
        if (!string.IsNullOrWhiteSpace(request.Lifecycle)) u = u.Set(v => v.Lifecycle, request.Lifecycle);
        if (request.PlannedReleaseAt.HasValue) u = u.Set(v => v.PlannedReleaseAt, request.PlannedReleaseAt);
        if (request.RequirementIds != null) u = u.Set(v => v.RequirementIds, request.RequirementIds);
        if (request.FeatureVersionIds != null) u = u.Set(v => v.FeatureVersionIds, request.FeatureVersionIds);
        if (request.FormData != null) u = u.Set(v => v.FormData, request.FormData);
        await _db.ProductVersions.UpdateOneAsync(v => v.Id == versionId, u);
        // 版本关联需求：维护需求侧反向引用
        if (request.RequirementIds != null)
            await SyncVersionToRequirementsAsync(version.ProductId, versionId, request.RequirementIds);
        var updated = await _db.ProductVersions.Find(v => v.Id == versionId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除版本（软删除）</summary>
    [HttpDelete("versions/{versionId}")]
    public async Task<IActionResult> DeleteVersion(string versionId)
    {
        var version = await _db.ProductVersions.Find(v => v.Id == versionId && !v.IsDeleted).FirstOrDefaultAsync();
        if (version == null || await FindAccessibleProductAsync(version.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在或无权访问"));
        await _db.ProductVersions.UpdateOneAsync(v => v.Id == versionId,
            Builders<ProductVersion>.Update.Set(v => v.IsDeleted, true).Set(v => v.UpdatedAt, DateTime.UtcNow));
        await RecalcProductCountsAsync(version.ProductId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 需求 Requirement ════════════════════════

    /// <summary>需求列表（按产品，可按版本 / 客户过滤）</summary>
    [HttpGet("products/{productId}/requirements")]
    public async Task<IActionResult> ListRequirements(string productId, [FromQuery] string? versionId = null, [FromQuery] string? customerId = null, [FromQuery] string? grade = null)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<Requirement>.Filter;
        var conds = new List<FilterDefinition<Requirement>> { b.Eq(r => r.ProductId, productId), b.Eq(r => r.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(versionId)) conds.Add(b.AnyEq(r => r.VersionIds, versionId));
        if (!string.IsNullOrWhiteSpace(customerId)) conds.Add(b.AnyEq(r => r.CustomerIds, customerId));
        if (!string.IsNullOrWhiteSpace(grade) && ProductItemGrade.All.Contains(grade)) conds.Add(b.Eq(r => r.Grade, grade));
        var items = await _db.Requirements.Find(b.And(conds)).SortByDescending(r => r.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建需求</summary>
    [HttpPost("products/{productId}/requirements")]
    public async Task<IActionResult> CreateRequirement(string productId, [FromBody] UpsertRequirementRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "需求标题不能为空"));
        if (!string.IsNullOrWhiteSpace(request.Grade) && !ProductItemGrade.All.Contains(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的需求分级"));

        var req = new Requirement
        {
            ProductId = productId,
            RequirementNo = await GenerateNoAsync("REQ", _db.Requirements, "RequirementNo"),
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            Grade = string.IsNullOrWhiteSpace(request.Grade) ? ProductItemGrade.P2 : request.Grade,
            ParentId = request.ParentId,
            CustomerIds = request.CustomerIds ?? new(),
            VersionIds = request.VersionIds ?? new(),
            TemplateId = request.TemplateId,
            WorkflowDefId = request.WorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
            AssigneeId = request.AssigneeId,
        };
        req.CurrentState = await ResolveInitialStateAsync(request.WorkflowDefId);

        await _db.Requirements.InsertOneAsync(req);
        // 维护版本侧反向引用（版本关联需求）
        if (req.VersionIds.Count > 0)
            await _db.ProductVersions.UpdateManyAsync(
                v => req.VersionIds.Contains(v.Id),
                Builders<ProductVersion>.Update.AddToSet(v => v.RequirementIds, req.Id));
        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(req));
    }

    /// <summary>更新需求</summary>
    [HttpPut("requirements/{requirementId}")]
    public async Task<IActionResult> UpdateRequirement(string requirementId, [FromBody] UpsertRequirementRequest request)
    {
        var req = await _db.Requirements.Find(r => r.Id == requirementId && !r.IsDeleted).FirstOrDefaultAsync();
        if (req == null || await FindAccessibleProductAsync(req.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "需求不存在或无权访问"));
        if (!string.IsNullOrWhiteSpace(request.Grade) && !ProductItemGrade.All.Contains(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的需求分级"));

        var u = Builders<Requirement>.Update.Set(r => r.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.Title)) u = u.Set(r => r.Title, request.Title.Trim());
        u = u.Set(r => r.Description, request.Description?.Trim());
        if (!string.IsNullOrWhiteSpace(request.Grade)) u = u.Set(r => r.Grade, request.Grade);
        if (request.ParentId != null) u = u.Set(r => r.ParentId, request.ParentId);
        if (request.CustomerIds != null) u = u.Set(r => r.CustomerIds, request.CustomerIds);
        if (request.VersionIds != null) u = u.Set(r => r.VersionIds, request.VersionIds);
        if (request.AssigneeId != null) u = u.Set(r => r.AssigneeId, request.AssigneeId);
        if (request.FormData != null) u = u.Set(r => r.FormData, request.FormData);
        await _db.Requirements.UpdateOneAsync(r => r.Id == requirementId, u);
        // 需求关联版本：维护版本侧反向引用
        if (request.VersionIds != null)
            await SyncRequirementToVersionsAsync(req.ProductId, requirementId, request.VersionIds);
        var updated = await _db.Requirements.Find(r => r.Id == requirementId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除需求（软删除）</summary>
    [HttpDelete("requirements/{requirementId}")]
    public async Task<IActionResult> DeleteRequirement(string requirementId)
    {
        var req = await _db.Requirements.Find(r => r.Id == requirementId && !r.IsDeleted).FirstOrDefaultAsync();
        if (req == null || await FindAccessibleProductAsync(req.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "需求不存在或无权访问"));
        await _db.Requirements.UpdateOneAsync(r => r.Id == requirementId,
            Builders<Requirement>.Update.Set(r => r.IsDeleted, true).Set(r => r.UpdatedAt, DateTime.UtcNow));
        await RecalcProductCountsAsync(req.ProductId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 功能 Feature ════════════════════════

    /// <summary>功能列表（按产品）</summary>
    [HttpGet("products/{productId}/features")]
    public async Task<IActionResult> ListFeatures(string productId, [FromQuery] string? grade = null)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<Feature>.Filter;
        var conds = new List<FilterDefinition<Feature>> { b.Eq(f => f.ProductId, productId), b.Eq(f => f.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(grade) && ProductItemGrade.All.Contains(grade)) conds.Add(b.Eq(f => f.Grade, grade));
        var items = await _db.Features.Find(b.And(conds)).SortByDescending(f => f.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建功能</summary>
    [HttpPost("products/{productId}/features")]
    public async Task<IActionResult> CreateFeature(string productId, [FromBody] UpsertFeatureRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "功能名称不能为空"));
        if (!string.IsNullOrWhiteSpace(request.Grade) && !ProductItemGrade.All.Contains(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的功能分级"));

        var feature = new Feature
        {
            ProductId = productId,
            FeatureNo = await GenerateNoAsync("FEA", _db.Features, "FeatureNo"),
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            Grade = string.IsNullOrWhiteSpace(request.Grade) ? ProductItemGrade.P2 : request.Grade,
            ParentId = request.ParentId,
            RequirementIds = request.RequirementIds ?? new(),
            TemplateId = request.TemplateId,
            WorkflowDefId = request.WorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
        };
        feature.CurrentState = await ResolveInitialStateAsync(request.WorkflowDefId);

        await _db.Features.InsertOneAsync(feature);
        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(feature));
    }

    /// <summary>更新功能</summary>
    [HttpPut("features/{featureId}")]
    public async Task<IActionResult> UpdateFeature(string featureId, [FromBody] UpsertFeatureRequest request)
    {
        var feature = await _db.Features.Find(f => f.Id == featureId && !f.IsDeleted).FirstOrDefaultAsync();
        if (feature == null || await FindAccessibleProductAsync(feature.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "功能不存在或无权访问"));
        if (!string.IsNullOrWhiteSpace(request.Grade) && !ProductItemGrade.All.Contains(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的功能分级"));

        var u = Builders<Feature>.Update.Set(f => f.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.Title)) u = u.Set(f => f.Title, request.Title.Trim());
        u = u.Set(f => f.Description, request.Description?.Trim());
        if (!string.IsNullOrWhiteSpace(request.Grade)) u = u.Set(f => f.Grade, request.Grade);
        if (request.ParentId != null) u = u.Set(f => f.ParentId, request.ParentId);
        if (request.RequirementIds != null) u = u.Set(f => f.RequirementIds, request.RequirementIds);
        if (request.FormData != null) u = u.Set(f => f.FormData, request.FormData);
        await _db.Features.UpdateOneAsync(f => f.Id == featureId, u);
        var updated = await _db.Features.Find(f => f.Id == featureId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除功能（软删除）</summary>
    [HttpDelete("features/{featureId}")]
    public async Task<IActionResult> DeleteFeature(string featureId)
    {
        var feature = await _db.Features.Find(f => f.Id == featureId && !f.IsDeleted).FirstOrDefaultAsync();
        if (feature == null || await FindAccessibleProductAsync(feature.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "功能不存在或无权访问"));
        await _db.Features.UpdateOneAsync(f => f.Id == featureId,
            Builders<Feature>.Update.Set(f => f.IsDeleted, true).Set(f => f.UpdatedAt, DateTime.UtcNow));
        await RecalcProductCountsAsync(feature.ProductId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ── 功能版本化 FeatureVersion ──

    /// <summary>功能版本列表（功能在各产品版本里的快照；按功能或按版本过滤）</summary>
    [HttpGet("products/{productId}/feature-versions")]
    public async Task<IActionResult> ListFeatureVersions(string productId, [FromQuery] string? featureId = null, [FromQuery] string? versionId = null)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<FeatureVersion>.Filter;
        var conds = new List<FilterDefinition<FeatureVersion>> { b.Eq(x => x.ProductId, productId), b.Eq(x => x.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(featureId)) conds.Add(b.Eq(x => x.FeatureId, featureId));
        if (!string.IsNullOrWhiteSpace(versionId)) conds.Add(b.Eq(x => x.VersionId, versionId));
        var items = await _db.FeatureVersions.Find(b.And(conds)).SortByDescending(x => x.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建功能版本（把某功能纳入某产品版本）</summary>
    [HttpPost("products/{productId}/feature-versions")]
    public async Task<IActionResult> CreateFeatureVersion(string productId, [FromBody] UpsertFeatureVersionRequest request)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.FeatureId) || string.IsNullOrWhiteSpace(request.VersionId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "必须指定功能与版本"));
        if (!string.IsNullOrWhiteSpace(request.ChangeType) && !FeatureChangeType.All.Contains(request.ChangeType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的变更类型"));

        var fv = new FeatureVersion
        {
            ProductId = productId,
            FeatureId = request.FeatureId,
            VersionId = request.VersionId,
            FeatureVersionLabel = request.FeatureVersionLabel?.Trim(),
            ChangeType = string.IsNullOrWhiteSpace(request.ChangeType) ? FeatureChangeType.Added : request.ChangeType,
            ChangeNote = request.ChangeNote?.Trim(),
        };
        await _db.FeatureVersions.InsertOneAsync(fv);
        await _db.ProductVersions.UpdateOneAsync(v => v.Id == request.VersionId,
            Builders<ProductVersion>.Update.AddToSet(v => v.FeatureVersionIds, fv.Id));
        return Ok(ApiResponse<object>.Ok(fv));
    }

    /// <summary>删除功能版本（软删除）</summary>
    [HttpDelete("feature-versions/{featureVersionId}")]
    public async Task<IActionResult> DeleteFeatureVersion(string featureVersionId)
    {
        var fv = await _db.FeatureVersions.Find(x => x.Id == featureVersionId && !x.IsDeleted).FirstOrDefaultAsync();
        if (fv == null || await FindAccessibleProductAsync(fv.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "功能版本不存在或无权访问"));
        await _db.FeatureVersions.UpdateOneAsync(x => x.Id == featureVersionId,
            Builders<FeatureVersion>.Update.Set(x => x.IsDeleted, true).Set(x => x.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 客户 Customer ════════════════════════

    /// <summary>客户列表（按产品）</summary>
    [HttpGet("products/{productId}/customers")]
    public async Task<IActionResult> ListCustomers(string productId, [FromQuery] string? keyword = null)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<Customer>.Filter;
        var conds = new List<FilterDefinition<Customer>> { b.Eq(c => c.ProductId, productId), b.Eq(c => c.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(keyword))
            conds.Add(b.Or(
                b.Regex(c => c.Name, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                b.Regex(c => c.Company, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))));
        var items = await _db.Customers.Find(b.And(conds)).SortByDescending(c => c.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建客户</summary>
    [HttpPost("products/{productId}/customers")]
    public async Task<IActionResult> CreateCustomer(string productId, [FromBody] UpsertCustomerRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "客户名称不能为空"));

        var customer = new Customer
        {
            ProductId = productId,
            Name = request.Name.Trim(),
            Code = request.Code?.Trim(),
            Company = request.Company?.Trim(),
            Contact = request.Contact?.Trim(),
            Description = request.Description?.Trim(),
            Tags = request.Tags ?? new(),
            TemplateId = request.TemplateId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
        };
        await _db.Customers.InsertOneAsync(customer);
        return Ok(ApiResponse<object>.Ok(customer));
    }

    /// <summary>更新客户</summary>
    [HttpPut("customers/{customerId}")]
    public async Task<IActionResult> UpdateCustomer(string customerId, [FromBody] UpsertCustomerRequest request)
    {
        var customer = await _db.Customers.Find(c => c.Id == customerId && !c.IsDeleted).FirstOrDefaultAsync();
        if (customer == null || await FindAccessibleProductAsync(customer.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "客户不存在或无权访问"));
        var u = Builders<Customer>.Update.Set(c => c.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.Name)) u = u.Set(c => c.Name, request.Name.Trim());
        u = u.Set(c => c.Code, request.Code?.Trim());
        u = u.Set(c => c.Company, request.Company?.Trim());
        u = u.Set(c => c.Contact, request.Contact?.Trim());
        u = u.Set(c => c.Description, request.Description?.Trim());
        if (request.Tags != null) u = u.Set(c => c.Tags, request.Tags);
        if (request.FormData != null) u = u.Set(c => c.FormData, request.FormData);
        await _db.Customers.UpdateOneAsync(c => c.Id == customerId, u);
        var updated = await _db.Customers.Find(c => c.Id == customerId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除客户（软删除）</summary>
    [HttpDelete("customers/{customerId}")]
    public async Task<IActionResult> DeleteCustomer(string customerId)
    {
        var customer = await _db.Customers.Find(c => c.Id == customerId && !c.IsDeleted).FirstOrDefaultAsync();
        if (customer == null || await FindAccessibleProductAsync(customer.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "客户不存在或无权访问"));
        await _db.Customers.UpdateOneAsync(c => c.Id == customerId,
            Builders<Customer>.Update.Set(c => c.IsDeleted, true).Set(c => c.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 通用表单模板引擎 ════════════════════════

    /// <summary>表单模板列表（按对象类型 / 产品过滤；全局模板 ProductId 为空）</summary>
    [HttpGet("form-templates")]
    public async Task<IActionResult> ListFormTemplates([FromQuery] string? entityType = null, [FromQuery] string? productId = null)
    {
        var b = Builders<ProductFormTemplate>.Filter;
        var conds = new List<FilterDefinition<ProductFormTemplate>> { b.Eq(t => t.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(entityType)) conds.Add(b.Eq(t => t.EntityType, entityType));
        if (!string.IsNullOrWhiteSpace(productId))
            conds.Add(b.Or(b.Eq(t => t.ProductId, productId), b.Eq(t => t.ProductId, (string?)null)));
        var items = await _db.ProductFormTemplates.Find(b.And(conds)).SortByDescending(t => t.UpdatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建 / 更新表单模板（需管理权限）。带 id 为更新。</summary>
    [HttpPost("form-templates")]
    public async Task<IActionResult> UpsertFormTemplate([FromBody] UpsertFormTemplateRequest request)
    {
        if (!HasPermission(AdminPermissionCatalog.ProductAgentManage))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "模板名称不能为空"));
        if (!ProductEntityType.All.Contains(request.EntityType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的对象类型"));
        foreach (var f in request.Fields ?? new())
            if (!ProductFormFieldType.All.Contains(f.Type))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"无效的字段类型: {f.Type}"));

        if (!string.IsNullOrWhiteSpace(request.Id))
        {
            var u = Builders<ProductFormTemplate>.Update
                .Set(t => t.Name, request.Name.Trim())
                .Set(t => t.Description, request.Description?.Trim())
                .Set(t => t.EntityType, request.EntityType)
                .Set(t => t.Fields, request.Fields ?? new())
                .Set(t => t.IsDefault, request.IsDefault)
                .Set(t => t.ProductId, request.ProductId)
                .Set(t => t.UpdatedAt, DateTime.UtcNow);
            await _db.ProductFormTemplates.UpdateOneAsync(t => t.Id == request.Id, u);
            var updated = await _db.ProductFormTemplates.Find(t => t.Id == request.Id).FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(updated));
        }

        var tpl = new ProductFormTemplate
        {
            Name = request.Name.Trim(),
            Description = request.Description?.Trim(),
            EntityType = request.EntityType,
            Fields = request.Fields ?? new(),
            IsDefault = request.IsDefault,
            ProductId = request.ProductId,
            CreatedBy = GetUserId(),
        };
        await _db.ProductFormTemplates.InsertOneAsync(tpl);
        return Ok(ApiResponse<object>.Ok(tpl));
    }

    /// <summary>删除表单模板（软删除，需管理权限）</summary>
    [HttpDelete("form-templates/{templateId}")]
    public async Task<IActionResult> DeleteFormTemplate(string templateId)
    {
        if (!HasPermission(AdminPermissionCatalog.ProductAgentManage))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        await _db.ProductFormTemplates.UpdateOneAsync(t => t.Id == templateId,
            Builders<ProductFormTemplate>.Update.Set(t => t.IsDeleted, true).Set(t => t.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 通用状态机 / 流程引擎 ════════════════════════

    /// <summary>流程定义列表（按对象类型 / 产品过滤）</summary>
    [HttpGet("workflow-definitions")]
    public async Task<IActionResult> ListWorkflowDefinitions([FromQuery] string? entityType = null, [FromQuery] string? productId = null)
    {
        var b = Builders<ProductWorkflowDefinition>.Filter;
        var conds = new List<FilterDefinition<ProductWorkflowDefinition>> { b.Eq(w => w.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(entityType)) conds.Add(b.Eq(w => w.EntityType, entityType));
        if (!string.IsNullOrWhiteSpace(productId))
            conds.Add(b.Or(b.Eq(w => w.ProductId, productId), b.Eq(w => w.ProductId, (string?)null)));
        var items = await _db.ProductWorkflowDefinitions.Find(b.And(conds)).SortByDescending(w => w.UpdatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建 / 更新流程定义（需管理权限）。带 id 为更新。</summary>
    [HttpPost("workflow-definitions")]
    public async Task<IActionResult> UpsertWorkflowDefinition([FromBody] UpsertWorkflowDefinitionRequest request)
    {
        if (!HasPermission(AdminPermissionCatalog.ProductAgentManage))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "流程名称不能为空"));
        if (!ProductEntityType.All.Contains(request.EntityType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的对象类型"));
        if (request.States == null || request.States.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少需要一个状态"));

        if (!string.IsNullOrWhiteSpace(request.Id))
        {
            var u = Builders<ProductWorkflowDefinition>.Update
                .Set(w => w.Name, request.Name.Trim())
                .Set(w => w.Description, request.Description?.Trim())
                .Set(w => w.EntityType, request.EntityType)
                .Set(w => w.States, request.States)
                .Set(w => w.Transitions, request.Transitions ?? new())
                .Set(w => w.IsDefault, request.IsDefault)
                .Set(w => w.ProductId, request.ProductId)
                .Set(w => w.UpdatedAt, DateTime.UtcNow);
            await _db.ProductWorkflowDefinitions.UpdateOneAsync(w => w.Id == request.Id, u);
            var updated = await _db.ProductWorkflowDefinitions.Find(w => w.Id == request.Id).FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(updated));
        }

        var def = new ProductWorkflowDefinition
        {
            Name = request.Name.Trim(),
            Description = request.Description?.Trim(),
            EntityType = request.EntityType,
            States = request.States,
            Transitions = request.Transitions ?? new(),
            IsDefault = request.IsDefault,
            ProductId = request.ProductId,
            CreatedBy = GetUserId(),
        };
        await _db.ProductWorkflowDefinitions.InsertOneAsync(def);
        return Ok(ApiResponse<object>.Ok(def));
    }

    /// <summary>删除流程定义（软删除，需管理权限）</summary>
    [HttpDelete("workflow-definitions/{definitionId}")]
    public async Task<IActionResult> DeleteWorkflowDefinition(string definitionId)
    {
        if (!HasPermission(AdminPermissionCatalog.ProductAgentManage))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        await _db.ProductWorkflowDefinitions.UpdateOneAsync(w => w.Id == definitionId,
            Builders<ProductWorkflowDefinition>.Update.Set(w => w.IsDeleted, true).Set(w => w.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 通用状态流转。查实例绑定的流程定义，校验 transitionKey 的 from→to 合法后改 CurrentState。
    /// 支持 entityType: product / version / requirement / feature。
    /// </summary>
    [HttpPost("transition")]
    public async Task<IActionResult> Transition([FromBody] TransitionRequest request)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(request.EntityType) || string.IsNullOrWhiteSpace(request.EntityId) || string.IsNullOrWhiteSpace(request.TransitionKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少必要参数"));

        // 读出当前状态 + 绑定的流程定义 id + 所属产品（用于鉴权）
        string? currentState; string? workflowDefId; string productId;
        switch (request.EntityType)
        {
            case ProductEntityType.Product:
                var p = await _db.Products.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (p == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                currentState = p.CurrentState; workflowDefId = p.WorkflowDefId; productId = p.Id;
                break;
            case ProductEntityType.Version:
                var v = await _db.ProductVersions.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (v == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                currentState = v.CurrentState; workflowDefId = v.WorkflowDefId; productId = v.ProductId;
                break;
            case ProductEntityType.Requirement:
                var r = await _db.Requirements.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (r == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                currentState = r.CurrentState; workflowDefId = r.WorkflowDefId; productId = r.ProductId;
                break;
            case ProductEntityType.Feature:
                var f = await _db.Features.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (f == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                currentState = f.CurrentState; workflowDefId = f.WorkflowDefId; productId = f.ProductId;
                break;
            default:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的对象类型"));
        }

        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "无权访问该对象"));
        if (string.IsNullOrWhiteSpace(workflowDefId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该对象未绑定流程定义"));

        var def = await _db.ProductWorkflowDefinitions.Find(w => w.Id == workflowDefId && !w.IsDeleted).FirstOrDefaultAsync();
        if (def == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "流程定义不存在"));

        var transition = def.Transitions.FirstOrDefault(t => t.Key == request.TransitionKey);
        if (transition == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未定义的流转动作"));
        // from 校验：transition.FromState 为空表示任意状态可触发
        if (!string.IsNullOrWhiteSpace(transition.FromState) && transition.FromState != currentState)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"当前状态({currentState ?? "未设置"})不允许该流转"));
        if (def.States.All(s => s.Key != transition.ToState))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "目标状态非法"));
        if (transition.RequireComment && string.IsNullOrWhiteSpace(request.Comment))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该流转需要填写备注"));

        // 落库新状态
        var now = DateTime.UtcNow;
        switch (request.EntityType)
        {
            case ProductEntityType.Product:
                await _db.Products.UpdateOneAsync(x => x.Id == request.EntityId,
                    Builders<Product>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.UpdatedAt, now));
                break;
            case ProductEntityType.Version:
                await _db.ProductVersions.UpdateOneAsync(x => x.Id == request.EntityId,
                    Builders<ProductVersion>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.UpdatedAt, now));
                break;
            case ProductEntityType.Requirement:
                await _db.Requirements.UpdateOneAsync(x => x.Id == request.EntityId,
                    Builders<Requirement>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.UpdatedAt, now));
                break;
            case ProductEntityType.Feature:
                await _db.Features.UpdateOneAsync(x => x.Id == request.EntityId,
                    Builders<Feature>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.UpdatedAt, now));
                break;
        }
        _logger.LogInformation("[product-agent] Transition {Type}/{Id} {From}->{To} by {User}",
            request.EntityType, request.EntityId, currentState, transition.ToState, userId);
        return Ok(ApiResponse<object>.Ok(new { entityId = request.EntityId, newState = transition.ToState }));
    }

    // ════════════════════════ 知识库挂载（复用 DocumentStore，P1）════════════════════════

    /// <summary>产品整体知识库（find-or-create 绑定的 DocumentStore；前端复用 document-store 渲染）</summary>
    [HttpGet("products/{productId}/knowledge/store")]
    public async Task<IActionResult> GetProductKnowledgeStore(string productId)
    {
        var product = await FindAccessibleProductAsync(productId, GetUserId());
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));

        DocumentStore? store = null;
        if (!string.IsNullOrEmpty(product.KnowledgeStoreId))
            store = await _db.DocumentStores.Find(s => s.Id == product.KnowledgeStoreId).FirstOrDefaultAsync();
        if (store == null)
        {
            store = new DocumentStore
            {
                Name = $"{product.Name} · 整体知识库",
                OwnerId = product.OwnerId,
                AppKey = "product-agent",
                ProductKnowledgeRef = $"product:{productId}",
            };
            await _db.DocumentStores.InsertOneAsync(store);
            await _db.Products.UpdateOneAsync(p => p.Id == productId,
                Builders<Product>.Update.Set(p => p.KnowledgeStoreId, store.Id).Set(p => p.UpdatedAt, DateTime.UtcNow));
        }
        return Ok(ApiResponse<object>.Ok(store));
    }

    /// <summary>版本知识库（含 MRD/SRS/PRD；find-or-create 绑定的 DocumentStore）</summary>
    [HttpGet("versions/{versionId}/knowledge/store")]
    public async Task<IActionResult> GetVersionKnowledgeStore(string versionId)
    {
        var version = await _db.ProductVersions.Find(v => v.Id == versionId && !v.IsDeleted).FirstOrDefaultAsync();
        if (version == null || await FindAccessibleProductAsync(version.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在或无权访问"));

        DocumentStore? store = null;
        if (!string.IsNullOrEmpty(version.KnowledgeStoreId))
            store = await _db.DocumentStores.Find(s => s.Id == version.KnowledgeStoreId).FirstOrDefaultAsync();
        if (store == null)
        {
            store = new DocumentStore
            {
                Name = $"{version.VersionName} · 版本知识库",
                OwnerId = version.OwnerId,
                AppKey = "product-agent",
                ProductKnowledgeRef = $"version:{versionId}",
            };
            await _db.DocumentStores.InsertOneAsync(store);
            await _db.ProductVersions.UpdateOneAsync(v => v.Id == versionId,
                Builders<ProductVersion>.Update.Set(v => v.KnowledgeStoreId, store.Id).Set(v => v.UpdatedAt, DateTime.UtcNow));
        }
        return Ok(ApiResponse<object>.Ok(store));
    }

    // ════════════════════════ 缺陷追溯（复用 defect-agent，P1）════════════════════════

    /// <summary>列出追溯到本产品（可按需求/版本/功能细分）的缺陷。</summary>
    [HttpGet("products/{productId}/defects")]
    public async Task<IActionResult> ListTracedDefects(string productId, [FromQuery] string? requirementId = null, [FromQuery] string? versionId = null, [FromQuery] string? featureId = null)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<DefectReport>.Filter;
        var conds = new List<FilterDefinition<DefectReport>> { b.Eq(d => d.TracedProductId, productId), b.Eq(d => d.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(requirementId)) conds.Add(b.Eq(d => d.TracedRequirementId, requirementId));
        if (!string.IsNullOrWhiteSpace(versionId)) conds.Add(b.Eq(d => d.TracedVersionId, versionId));
        if (!string.IsNullOrWhiteSpace(featureId)) conds.Add(b.Eq(d => d.TracedFeatureId, featureId));
        var items = await _db.DefectReports.Find(b.And(conds)).SortByDescending(d => d.CreatedAt).Limit(200).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>列出可被关联（追溯）的缺陷：当前用户可见、尚未追溯到任何产品。</summary>
    [HttpGet("products/{productId}/defects/linkable")]
    public async Task<IActionResult> ListLinkableDefects(string productId, [FromQuery] string? keyword = null)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<DefectReport>.Filter;
        var conds = new List<FilterDefinition<DefectReport>>
        {
            b.Eq(d => d.IsDeleted, false),
            b.Eq(d => d.TracedProductId, (string?)null),
        };
        if (!HasPermission(AdminPermissionCatalog.ProductAgentManage))
            conds.Add(b.Or(b.Eq(d => d.ReporterId, userId), b.Eq(d => d.AssigneeId, userId)));
        if (!string.IsNullOrWhiteSpace(keyword))
            conds.Add(b.Or(
                b.Regex(d => d.Title, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                b.Regex(d => d.DefectNo, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))));
        var items = await _db.DefectReports.Find(b.And(conds)).SortByDescending(d => d.CreatedAt).Limit(30).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>把一个缺陷追溯到产品/需求/版本/功能（写 defect 侧 Traced* 字段）。</summary>
    [HttpPost("trace-defect")]
    public async Task<IActionResult> TraceDefect([FromBody] TraceDefectRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.DefectId) || string.IsNullOrWhiteSpace(request.ProductId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少缺陷或产品 ID"));
        if (await FindAccessibleProductAsync(request.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var defect = await _db.DefectReports.Find(d => d.Id == request.DefectId && !d.IsDeleted).FirstOrDefaultAsync();
        if (defect == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "缺陷不存在"));

        var u = Builders<DefectReport>.Update
            .Set(d => d.TracedProductId, request.ProductId)
            .Set(d => d.TracedRequirementId, request.RequirementId)
            .Set(d => d.TracedVersionId, request.VersionId)
            .Set(d => d.TracedFeatureId, request.FeatureId);
        await _db.DefectReports.UpdateOneAsync(d => d.Id == request.DefectId, u);
        await RecalcDefectCountAsync(request.ProductId);
        return Ok(ApiResponse<object>.Ok(new { traced = true }));
    }

    /// <summary>解除缺陷的产品追溯。</summary>
    [HttpPost("untrace-defect")]
    public async Task<IActionResult> UntraceDefect([FromBody] UntraceDefectRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.DefectId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少缺陷 ID"));
        var defect = await _db.DefectReports.Find(d => d.Id == request.DefectId && !d.IsDeleted).FirstOrDefaultAsync();
        if (defect == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "缺陷不存在"));
        if (!string.IsNullOrEmpty(defect.TracedProductId) && await FindAccessibleProductAsync(defect.TracedProductId, GetUserId()) == null)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权解除该缺陷追溯"));
        var productId = defect.TracedProductId;
        await _db.DefectReports.UpdateOneAsync(d => d.Id == request.DefectId,
            Builders<DefectReport>.Update
                .Set(d => d.TracedProductId, (string?)null)
                .Set(d => d.TracedRequirementId, (string?)null)
                .Set(d => d.TracedVersionId, (string?)null)
                .Set(d => d.TracedFeatureId, (string?)null));
        if (!string.IsNullOrEmpty(productId)) await RecalcDefectCountAsync(productId);
        return Ok(ApiResponse<object>.Ok(new { untraced = true }));
    }

    // ════════════════════════ 私有工具 ════════════════════════

    /// <summary>按 {PREFIX}-{YEAR}-{NNNN} 生成业务编号。fieldName 为编号字段名（FieldDefinition 由 string 隐式转换）。</summary>
    private static async Task<string> GenerateNoAsync<T>(string prefix, IMongoCollection<T> coll, string fieldName)
    {
        var year = DateTime.UtcNow.Year;
        var full = $"{prefix}-{year}-";
        var filter = Builders<T>.Filter.Regex(fieldName, new MongoDB.Bson.BsonRegularExpression($"^{full}"));
        var count = await coll.CountDocumentsAsync(filter);
        return $"{full}{(count + 1):D4}";
    }

    /// <summary>根据流程定义解析初始状态 Key（未绑定流程时返回 null）。</summary>
    private async Task<string?> ResolveInitialStateAsync(string? workflowDefId)
    {
        if (string.IsNullOrWhiteSpace(workflowDefId)) return null;
        var def = await _db.ProductWorkflowDefinitions.Find(w => w.Id == workflowDefId && !w.IsDeleted).FirstOrDefaultAsync();
        return def?.GetInitialStateKey();
    }

    /// <summary>重算产品的反规范化计数（版本 / 需求 / 功能）。</summary>
    private async Task RecalcProductCountsAsync(string productId)
    {
        var versions = await _db.ProductVersions.CountDocumentsAsync(v => v.ProductId == productId && !v.IsDeleted);
        var requirements = await _db.Requirements.CountDocumentsAsync(r => r.ProductId == productId && !r.IsDeleted);
        var features = await _db.Features.CountDocumentsAsync(f => f.ProductId == productId && !f.IsDeleted);
        await _db.Products.UpdateOneAsync(p => p.Id == productId,
            Builders<Product>.Update
                .Set(p => p.VersionCount, (int)versions)
                .Set(p => p.RequirementCount, (int)requirements)
                .Set(p => p.FeatureCount, (int)features)
                .Set(p => p.UpdatedAt, DateTime.UtcNow));
    }

    /// <summary>重算产品的追溯缺陷计数（缺陷侧 TracedProductId 命中数）。</summary>
    private async Task RecalcDefectCountAsync(string productId)
    {
        var defects = await _db.DefectReports.CountDocumentsAsync(d => d.TracedProductId == productId && !d.IsDeleted);
        await _db.Products.UpdateOneAsync(p => p.Id == productId,
            Builders<Product>.Update.Set(p => p.DefectCount, (int)defects).Set(p => p.UpdatedAt, DateTime.UtcNow));
    }

    /// <summary>版本→需求 反向同步：把 versionId 从该产品所有需求的 VersionIds 移除，再加到选中的需求。</summary>
    private async Task SyncVersionToRequirementsAsync(string productId, string versionId, List<string> requirementIds)
    {
        await _db.Requirements.UpdateManyAsync(r => r.ProductId == productId,
            Builders<Requirement>.Update.Pull(r => r.VersionIds, versionId));
        if (requirementIds.Count > 0)
            await _db.Requirements.UpdateManyAsync(r => requirementIds.Contains(r.Id),
                Builders<Requirement>.Update.AddToSet(r => r.VersionIds, versionId));
    }

    /// <summary>需求→版本 反向同步：把 requirementId 从该产品所有版本的 RequirementIds 移除，再加到选中的版本。</summary>
    private async Task SyncRequirementToVersionsAsync(string productId, string requirementId, List<string> versionIds)
    {
        await _db.ProductVersions.UpdateManyAsync(v => v.ProductId == productId,
            Builders<ProductVersion>.Update.Pull(v => v.RequirementIds, requirementId));
        if (versionIds.Count > 0)
            await _db.ProductVersions.UpdateManyAsync(v => versionIds.Contains(v.Id),
                Builders<ProductVersion>.Update.AddToSet(v => v.RequirementIds, requirementId));
    }
}

// ════════════════════════ 请求 DTO ════════════════════════

public class UpsertProductRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Code { get; set; }
    public string? Description { get; set; }
    public string? Grade { get; set; }
    public string? TemplateId { get; set; }
    public string? WorkflowDefId { get; set; }
    public Dictionary<string, string>? FormData { get; set; }
    public List<string>? MemberIds { get; set; }
}

public class UpsertVersionRequest
{
    public string VersionName { get; set; } = string.Empty;
    public string? Description { get; set; }
    public bool IsMajor { get; set; }
    public string? ParentVersionId { get; set; }
    public string? Lifecycle { get; set; }
    public DateTime? PlannedReleaseAt { get; set; }
    public List<string>? RequirementIds { get; set; }
    public List<string>? FeatureVersionIds { get; set; }
    public string? TemplateId { get; set; }
    public string? WorkflowDefId { get; set; }
    public Dictionary<string, string>? FormData { get; set; }
}

public class UpsertRequirementRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Grade { get; set; }
    public string? ParentId { get; set; }
    public List<string>? CustomerIds { get; set; }
    public List<string>? VersionIds { get; set; }
    public string? AssigneeId { get; set; }
    public string? TemplateId { get; set; }
    public string? WorkflowDefId { get; set; }
    public Dictionary<string, string>? FormData { get; set; }
}

public class UpsertFeatureRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Grade { get; set; }
    public string? ParentId { get; set; }
    public List<string>? RequirementIds { get; set; }
    public string? TemplateId { get; set; }
    public string? WorkflowDefId { get; set; }
    public Dictionary<string, string>? FormData { get; set; }
}

public class UpsertFeatureVersionRequest
{
    public string FeatureId { get; set; } = string.Empty;
    public string VersionId { get; set; } = string.Empty;
    public string? FeatureVersionLabel { get; set; }
    public string? ChangeType { get; set; }
    public string? ChangeNote { get; set; }
}

public class UpsertCustomerRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Code { get; set; }
    public string? Company { get; set; }
    public string? Contact { get; set; }
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }
    public string? TemplateId { get; set; }
    public Dictionary<string, string>? FormData { get; set; }
}

public class UpsertFormTemplateRequest
{
    public string? Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string EntityType { get; set; } = ProductEntityType.Requirement;
    public List<ProductFormField>? Fields { get; set; }
    public bool IsDefault { get; set; }
    public string? ProductId { get; set; }
}

public class UpsertWorkflowDefinitionRequest
{
    public string? Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string EntityType { get; set; } = ProductEntityType.Requirement;
    public List<ProductWorkflowState> States { get; set; } = new();
    public List<ProductWorkflowTransition>? Transitions { get; set; }
    public bool IsDefault { get; set; }
    public string? ProductId { get; set; }
}

public class TransitionRequest
{
    public string EntityType { get; set; } = string.Empty;
    public string EntityId { get; set; } = string.Empty;
    public string TransitionKey { get; set; } = string.Empty;
    public string? Comment { get; set; }
}

public class TraceDefectRequest
{
    public string DefectId { get; set; } = string.Empty;
    public string ProductId { get; set; } = string.Empty;
    public string? RequirementId { get; set; }
    public string? VersionId { get; set; }
    public string? FeatureId { get; set; }
}

public class UntraceDefectRequest
{
    public string DefectId { get; set; } = string.Empty;
}
