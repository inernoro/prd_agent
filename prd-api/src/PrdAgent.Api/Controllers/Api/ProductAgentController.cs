using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

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
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;

    public ProductAgentController(MongoDbContext db, ILogger<ProductAgentController> logger, ILlmGateway gateway, ILLMRequestContextAccessor llmRequestContext)
    {
        _db = db;
        _logger = logger;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
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
        if (CanManage()) return product;
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
        if (!await IsValidGradeAsync(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的产品类型"));

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
        if (!CanManage())
            conds.Add(b.Or(b.Eq(p => p.OwnerId, userId), b.AnyEq(p => p.MemberIds, userId)));
        if (!string.IsNullOrWhiteSpace(grade))
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
        if (!await IsValidGradeAsync(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的产品类型"));

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
        if (product.OwnerId != userId && !CanManage())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅产品负责人或管理员可删除"));

        await _db.Products.UpdateOneAsync(p => p.Id == productId,
            Builders<Product>.Update.Set(p => p.IsDeleted, true).Set(p => p.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ──────────────────────── 产品团队成员 ────────────────────────

    /// <summary>团队成员列表（含角色：负责人/产品管理员/成员）+ 当前用户的管理能力标志。</summary>
    [HttpGet("products/{productId}/members")]
    public async Task<IActionResult> ListProductMembers(string productId)
    {
        var userId = GetUserId();
        var product = await FindAccessibleProductAsync(productId, userId);
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));

        // 成员全集：负责人 + 成员列表，去重去空
        var allIds = new List<string> { product.OwnerId };
        allIds.AddRange(product.MemberIds);
        var ids = allIds.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();

        var users = await _db.Users.Find(u => ids.Contains(u.UserId)).ToListAsync();
        var nameById = users.ToDictionary(u => u.UserId, u => u.DisplayName);
        var adminSet = product.AdminIds.ToHashSet();

        var members = ids.Select(id => new
        {
            userId = id,
            displayName = nameById.GetValueOrDefault(id, id),
            role = id == product.OwnerId ? "owner" : (adminSet.Contains(id) ? "admin" : "member"),
        })
        .OrderBy(m => m.role == "owner" ? 0 : m.role == "admin" ? 1 : 2)
        .ThenBy(m => m.displayName)
        .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            members,
            canManageMembers = CanManageProductMembers(product, userId),
            canManageAdmins = CanManageProductAdmins(product, userId),
        }));
    }

    /// <summary>添加团队成员（批量）。需产品成员管理权限。</summary>
    [HttpPost("products/{productId}/members")]
    public async Task<IActionResult> AddProductMembers(string productId, [FromBody] AddProductMembersRequest request)
    {
        var userId = GetUserId();
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        if (!CanManageProductMembers(product, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权管理该产品成员"));

        var toAdd = (request.UserIds ?? new()).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        if (toAdd.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未指定要添加的用户"));

        await _db.Products.UpdateOneAsync(p => p.Id == productId,
            Builders<Product>.Update.AddToSetEach(p => p.MemberIds, toAdd).Set(p => p.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { added = toAdd.Count }));
    }

    /// <summary>移除团队成员（同步清除其产品管理员身份）。不可移除负责人；移除管理员需指派权限。</summary>
    [HttpDelete("products/{productId}/members/{memberUserId}")]
    public async Task<IActionResult> RemoveProductMember(string productId, string memberUserId)
    {
        var userId = GetUserId();
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        if (memberUserId == product.OwnerId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能移除产品负责人"));

        var isAdminTarget = product.AdminIds.Contains(memberUserId);
        var allowed = isAdminTarget ? CanManageProductAdmins(product, userId) : CanManageProductMembers(product, userId);
        if (!allowed)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权移除该成员"));

        await _db.Products.UpdateOneAsync(p => p.Id == productId,
            Builders<Product>.Update
                .Pull(p => p.MemberIds, memberUserId)
                .Pull(p => p.AdminIds, memberUserId)
                .Set(p => p.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { removed = true }));
    }

    /// <summary>设置成员角色（admin=指派产品管理员 / member=撤销）。需指派权限，不可改负责人。</summary>
    [HttpPut("products/{productId}/members/{memberUserId}/role")]
    public async Task<IActionResult> SetProductMemberRole(string productId, string memberUserId, [FromBody] SetProductMemberRoleRequest request)
    {
        var userId = GetUserId();
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        if (!CanManageProductAdmins(product, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅负责人或管理员可指派产品管理员"));
        if (memberUserId == product.OwnerId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "负责人角色不可更改"));

        var role = (request.Role ?? "").Trim().ToLowerInvariant();
        UpdateDefinition<Product> update;
        if (role == "admin")
            // 指派为产品管理员：并入 AdminIds，同时确保在 MemberIds（维持 AdminIds ⊆ MemberIds 不变量）
            update = Builders<Product>.Update.AddToSet(p => p.AdminIds, memberUserId).AddToSet(p => p.MemberIds, memberUserId);
        else if (role == "member")
            update = Builders<Product>.Update.Pull(p => p.AdminIds, memberUserId);
        else
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的角色（仅 admin / member）"));

        await _db.Products.UpdateOneAsync(p => p.Id == productId, update.Set(p => p.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { role }));
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

        // 自动绑定该产品下生效的默认版本表单/流程（产品覆盖 > 全局），让快速新建的版本也能走流转
        var (defTpl, defWf) = await ResolveDefaultsAsync(ProductEntityType.Version, productId);
        var templateId = string.IsNullOrEmpty(request.TemplateId) ? defTpl : request.TemplateId;
        var workflowDefId = string.IsNullOrEmpty(request.WorkflowDefId) ? defWf : request.WorkflowDefId;

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
            TemplateId = templateId,
            WorkflowDefId = workflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
        };
        version.CurrentState = await ResolveInitialStateAsync(workflowDefId);

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

        // 未显式指定流程时，绑定该对象类型的默认流程（让流转开箱即用）
        var reqWorkflowDefId = request.WorkflowDefId;
        if (string.IsNullOrWhiteSpace(reqWorkflowDefId))
            (_, reqWorkflowDefId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);

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
            WorkflowDefId = reqWorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
            AssigneeId = request.AssigneeId,
            StateEnteredAt = DateTime.UtcNow,
        };
        req.CurrentState = await ResolveInitialStateAsync(reqWorkflowDefId);

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
        await RecordAssignChangeAsync(ProductEntityType.Requirement, requirementId, req.ProductId, req.AssigneeId, request.AssigneeId, req.RequirementNo, req.Title);
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

        var featWorkflowDefId = request.WorkflowDefId;
        if (string.IsNullOrWhiteSpace(featWorkflowDefId))
            (_, featWorkflowDefId) = await ResolveDefaultsAsync(ProductEntityType.Feature, productId);

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
            WorkflowDefId = featWorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
            AssigneeId = request.AssigneeId,
            StateEnteredAt = DateTime.UtcNow,
        };
        feature.CurrentState = await ResolveInitialStateAsync(featWorkflowDefId);

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
        if (request.AssigneeId != null) u = u.Set(f => f.AssigneeId, request.AssigneeId);
        if (request.FormData != null) u = u.Set(f => f.FormData, request.FormData);
        await _db.Features.UpdateOneAsync(f => f.Id == featureId, u);
        await RecordAssignChangeAsync(ProductEntityType.Feature, featureId, feature.ProductId, feature.AssigneeId, request.AssigneeId, feature.FeatureNo, feature.Title);
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

    // ════════════════════════ 客户 Customer（全局，跨产品共享）════════════════════════

    /// <summary>客户列表（全局，不再按产品过滤；支持关键词搜索名称/公司）</summary>
    [HttpGet("customers")]
    public async Task<IActionResult> ListCustomers([FromQuery] string? keyword = null)
    {
        var b = Builders<Customer>.Filter;
        var conds = new List<FilterDefinition<Customer>> { b.Eq(c => c.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(keyword))
            conds.Add(b.Or(
                b.Regex(c => c.Name, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                b.Regex(c => c.Company, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))));
        var items = await _db.Customers.Find(b.And(conds)).SortByDescending(c => c.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建客户（全局，任意 product-agent 使用者可创建）</summary>
    [HttpPost("customers")]
    public async Task<IActionResult> CreateCustomer([FromBody] UpsertCustomerRequest request)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "客户名称不能为空"));

        var customer = new Customer
        {
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

    /// <summary>更新客户（全局，任意使用者可编辑）</summary>
    [HttpPut("customers/{customerId}")]
    public async Task<IActionResult> UpdateCustomer(string customerId, [FromBody] UpsertCustomerRequest request)
    {
        var customer = await _db.Customers.Find(c => c.Id == customerId && !c.IsDeleted).FirstOrDefaultAsync();
        if (customer == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "客户不存在"));
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

    /// <summary>删除客户（软删除，需创建者或管理权限）</summary>
    [HttpDelete("customers/{customerId}")]
    public async Task<IActionResult> DeleteCustomer(string customerId)
    {
        var customer = await _db.Customers.Find(c => c.Id == customerId && !c.IsDeleted).FirstOrDefaultAsync();
        if (customer == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "客户不存在"));
        if (customer.OwnerId != GetUserId() && !CanManage())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅客户创建者或管理员可删除"));
        await _db.Customers.UpdateOneAsync(c => c.Id == customerId,
            Builders<Customer>.Update.Set(c => c.IsDeleted, true).Set(c => c.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 产品类型 ProductCategory ════════════════════════

    /// <summary>确保内置 4 项产品类型已落库（find-or-create，仅补缺不覆盖）。</summary>
    private async Task EnsureCategoriesSeededAsync()
    {
        var existingIds = (await _db.ProductCategories.Find(_ => true).Project(c => c.Id).ToListAsync())
            .ToHashSet();
        var missing = ProductCategory.BuiltinSeeds.Where(s => !existingIds.Contains(s.Id)).ToList();
        if (missing.Count > 0)
            await _db.ProductCategories.InsertManyAsync(missing);
    }

    /// <summary>校验 grade 是否为有效的产品类型 Id（空值视为合法，落库时取默认）。</summary>
    private async Task<bool> IsValidGradeAsync(string? grade)
    {
        if (string.IsNullOrWhiteSpace(grade)) return true;
        await EnsureCategoriesSeededAsync();
        return await _db.ProductCategories.Find(c => c.Id == grade && !c.IsDeleted).AnyAsync();
    }

    /// <summary>产品类型列表（首次访问自动补齐内置 4 项）。</summary>
    [HttpGet("categories")]
    public async Task<IActionResult> ListCategories()
    {
        await EnsureCategoriesSeededAsync();
        var items = await _db.ProductCategories.Find(c => !c.IsDeleted)
            .SortBy(c => c.SortOrder).ThenBy(c => c.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建 / 更新产品类型（需管理权限）。带 id 为更新。</summary>
    [HttpPost("categories")]
    public async Task<IActionResult> UpsertCategory([FromBody] UpsertCategoryRequest request)
    {
        if (!CanManage())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "类型名称不能为空"));
        await EnsureCategoriesSeededAsync();
        var color = string.IsNullOrWhiteSpace(request.Color) ? "#9ca3af" : request.Color.Trim();

        if (!string.IsNullOrWhiteSpace(request.Id))
        {
            var existing = await _db.ProductCategories.Find(c => c.Id == request.Id && !c.IsDeleted).FirstOrDefaultAsync();
            if (existing == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品类型不存在"));
            var u = Builders<ProductCategory>.Update
                .Set(c => c.Name, request.Name.Trim())
                .Set(c => c.Color, color)
                .Set(c => c.SortOrder, request.SortOrder)
                .Set(c => c.UpdatedAt, DateTime.UtcNow);
            await _db.ProductCategories.UpdateOneAsync(c => c.Id == request.Id, u);
            var updated = await _db.ProductCategories.Find(c => c.Id == request.Id).FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(updated));
        }

        var maxOrder = (await _db.ProductCategories.Find(c => !c.IsDeleted).SortByDescending(c => c.SortOrder)
            .FirstOrDefaultAsync())?.SortOrder ?? -1;
        var cat = new ProductCategory
        {
            Name = request.Name.Trim(),
            Color = color,
            SortOrder = request.SortOrder > 0 ? request.SortOrder : maxOrder + 1,
            IsBuiltin = false,
        };
        await _db.ProductCategories.InsertOneAsync(cat);
        return Ok(ApiResponse<object>.Ok(cat));
    }

    /// <summary>删除产品类型（软删除，需管理权限）。内置项 / 被产品占用时禁止删除。</summary>
    [HttpDelete("categories/{categoryId}")]
    public async Task<IActionResult> DeleteCategory(string categoryId)
    {
        if (!CanManage())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        var cat = await _db.ProductCategories.Find(c => c.Id == categoryId && !c.IsDeleted).FirstOrDefaultAsync();
        if (cat == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品类型不存在"));
        if (cat.IsBuiltin)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "内置类型不可删除，可改名或改色"));
        var inUse = await _db.Products.CountDocumentsAsync(p => p.Grade == categoryId && !p.IsDeleted);
        if (inUse > 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"该类型正被 {inUse} 个产品使用，无法删除"));
        await _db.ProductCategories.UpdateOneAsync(c => c.Id == categoryId,
            Builders<ProductCategory>.Update.Set(c => c.IsDeleted, true).Set(c => c.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 详情描述模板 ProductDescTemplate ════════════════════════

    /// <summary>描述模板列表（按对象类型过滤）。</summary>
    [HttpGet("desc-templates")]
    public async Task<IActionResult> ListDescTemplates([FromQuery] string? entityType = null)
    {
        var b = Builders<ProductDescTemplate>.Filter;
        var conds = new List<FilterDefinition<ProductDescTemplate>> { b.Eq(t => t.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(entityType)) conds.Add(b.Eq(t => t.EntityType, entityType));
        var items = await _db.ProductDescTemplates.Find(b.And(conds))
            .SortBy(t => t.SortOrder).ThenBy(t => t.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建 / 更新描述模板（需管理权限）。带 id 为更新。</summary>
    [HttpPost("desc-templates")]
    public async Task<IActionResult> UpsertDescTemplate([FromBody] UpsertDescTemplateRequest request)
    {
        if (!CanManage())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "模板名称不能为空"));
        if (!ProductEntityType.All.Contains(request.EntityType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的对象类型"));

        if (!string.IsNullOrWhiteSpace(request.Id))
        {
            var u = Builders<ProductDescTemplate>.Update
                .Set(t => t.Name, request.Name.Trim())
                .Set(t => t.Content, request.Content ?? string.Empty)
                .Set(t => t.EntityType, request.EntityType)
                .Set(t => t.SortOrder, request.SortOrder)
                .Set(t => t.UpdatedAt, DateTime.UtcNow);
            await _db.ProductDescTemplates.UpdateOneAsync(t => t.Id == request.Id, u);
            var updated = await _db.ProductDescTemplates.Find(t => t.Id == request.Id).FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(updated));
        }

        var tpl = new ProductDescTemplate
        {
            EntityType = request.EntityType,
            Name = request.Name.Trim(),
            Content = request.Content ?? string.Empty,
            SortOrder = request.SortOrder,
            CreatedBy = GetUserId(),
        };
        await _db.ProductDescTemplates.InsertOneAsync(tpl);
        return Ok(ApiResponse<object>.Ok(tpl));
    }

    /// <summary>删除描述模板（软删除，需管理权限）。</summary>
    [HttpDelete("desc-templates/{templateId}")]
    public async Task<IActionResult> DeleteDescTemplate(string templateId)
    {
        if (!CanManage())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        await _db.ProductDescTemplates.UpdateOneAsync(t => t.Id == templateId,
            Builders<ProductDescTemplate>.Update.Set(t => t.IsDeleted, true).Set(t => t.UpdatedAt, DateTime.UtcNow));
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
        if (!CanManage())
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
        if (!CanManage())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        await _db.ProductFormTemplates.UpdateOneAsync(t => t.Id == templateId,
            Builders<ProductFormTemplate>.Update.Set(t => t.IsDeleted, true).Set(t => t.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ════════════════════════ 通用状态机 / 流程引擎 ════════════════════════

    /// <summary>流程定义列表（按对象类型 / 产品过滤）</summary>
    /// <summary>确保内置默认工作流（需求 / 功能）已落库（固定 Id，幂等补缺）。</summary>
    private async Task EnsureDefaultWorkflowsSeededAsync()
    {
        var existingIds = (await _db.ProductWorkflowDefinitions
            .Find(Builders<ProductWorkflowDefinition>.Filter.In(w => w.Id, new[] { ProductWorkflowDefaults.RequirementDefId, ProductWorkflowDefaults.FeatureDefId }))
            .Project(w => w.Id).ToListAsync()).ToHashSet();
        var missing = ProductWorkflowDefaults.All().Where(w => !existingIds.Contains(w.Id)).ToList();
        if (missing.Count > 0)
            await _db.ProductWorkflowDefinitions.InsertManyAsync(missing);
    }

    [HttpGet("workflow-definitions")]
    public async Task<IActionResult> ListWorkflowDefinitions([FromQuery] string? entityType = null, [FromQuery] string? productId = null)
    {
        await EnsureDefaultWorkflowsSeededAsync();
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
        if (!CanManage())
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
        if (!CanManage())
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
            case ProductEntityType.UpgradeRequest:
                var ur = await _db.VersionUpgradeRequests.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (ur == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                currentState = ur.CurrentState; workflowDefId = ur.WorkflowDefId; productId = ur.ProductId;
                break;
            default:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的对象类型"));
        }

        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "无权访问该对象"));

        // 历史对象未绑定流程时：惰性绑定默认流程 + 补初始状态（让存量数据也能流转）
        if (string.IsNullOrWhiteSpace(workflowDefId))
        {
            (_, workflowDefId) = await ResolveDefaultsAsync(request.EntityType, productId);
            if (string.IsNullOrWhiteSpace(workflowDefId))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该对象类型暂无可用流程定义"));
            var seedDef = await _db.ProductWorkflowDefinitions.Find(w => w.Id == workflowDefId && !w.IsDeleted).FirstOrDefaultAsync();
            if (string.IsNullOrWhiteSpace(currentState)) currentState = seedDef?.GetInitialStateKey();
            await BindWorkflowAsync(request.EntityType, request.EntityId, workflowDefId, currentState);
        }

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

        // 落库新状态。自动化：流转可显式转交，或 AutoAssignToActor 自动 claim 给操作人
        var now = DateTime.UtcNow;
        var effectiveAssignee = request.AssigneeId ?? (transition.AutoAssignToActor ? userId : null);
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
            {
                var ru = Builders<Requirement>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.StateEnteredAt, now).Set(x => x.UpdatedAt, now);
                if (effectiveAssignee != null) ru = ru.Set(x => x.AssigneeId, effectiveAssignee);
                await _db.Requirements.UpdateOneAsync(x => x.Id == request.EntityId, ru);
                break;
            }
            case ProductEntityType.Feature:
            {
                var fu = Builders<Feature>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.StateEnteredAt, now).Set(x => x.UpdatedAt, now);
                if (effectiveAssignee != null) fu = fu.Set(x => x.AssigneeId, effectiveAssignee);
                await _db.Features.UpdateOneAsync(x => x.Id == request.EntityId, fu);
                break;
            }
            case ProductEntityType.UpgradeRequest:
                await _db.VersionUpgradeRequests.UpdateOneAsync(x => x.Id == request.EntityId,
                    Builders<VersionUpgradeRequest>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.UpdatedAt, now));
                break;
        }
        _logger.LogInformation("[product-agent] Transition {Type}/{Id} {From}->{To} by {User}",
            request.EntityType, request.EntityId, currentState, transition.ToState, userId);

        // 记录时间线 + 通知（仅需求 / 功能）
        if (request.EntityType is ProductEntityType.Requirement or ProductEntityType.Feature)
        {
            var actorName = (await _db.Users.Find(uu => uu.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
            string LabelOf(string? key) => def.States.FirstOrDefault(s => s.Key == key)?.Label ?? key ?? "未设置";
            var fromLabel = LabelOf(currentState);
            var toLabel = LabelOf(transition.ToState);
            await RecordActivityAsync(request.EntityType, request.EntityId, productId, ProductActivityType.Transition, userId, actorName,
                content: string.IsNullOrWhiteSpace(request.Comment) ? null : request.Comment, fromValue: fromLabel, toValue: toLabel);

            var ctx = await ResolveItemContextAsync(request.EntityType, request.EntityId);
            var notifyAssignee = effectiveAssignee ?? ctx?.assigneeId;
            var no = ctx?.no ?? request.EntityId;
            var title = ctx?.title ?? "";
            await NotifyItemAsync(new[] { notifyAssignee }, userId, $"状态变更 · {no}",
                $"{actorName ?? "有人"} 把「{title}」从 {fromLabel} 流转到 {toLabel}", ItemUrl(productId, request.EntityType, request.EntityId));
            if (effectiveAssignee != null)
            {
                var assigneeName = (await _db.Users.Find(uu => uu.UserId == effectiveAssignee).FirstOrDefaultAsync())?.DisplayName;
                await RecordActivityAsync(request.EntityType, request.EntityId, productId, ProductActivityType.Assign, userId, actorName, toValue: assigneeName ?? effectiveAssignee);
                if (effectiveAssignee != userId)
                    await NotifyItemAsync(new[] { (string?)effectiveAssignee }, userId, $"指派给你 · {no}", $"{actorName ?? "有人"} 把「{title}」指派给你处理", ItemUrl(productId, request.EntityType, request.EntityId));
            }
        }
        return Ok(ApiResponse<object>.Ok(new { entityId = request.EntityId, newState = transition.ToState }));
    }

    // ════════════════════════ 知识图谱（P2）════════════════════════

    /// <summary>
    /// 产品关系知识图谱：返回 nodes + edges。
    /// 节点=产品/版本/需求/功能/客户/追溯缺陷；边=包含/关联/落需求/连客户/追溯。
    /// </summary>
    [HttpGet("products/{productId}/graph")]
    public async Task<IActionResult> GetGraph(string productId)
    {
        var product = await FindAccessibleProductAsync(productId, GetUserId());
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));

        var versions = await _db.ProductVersions.Find(v => v.ProductId == productId && !v.IsDeleted).ToListAsync();
        var requirements = await _db.Requirements.Find(r => r.ProductId == productId && !r.IsDeleted).ToListAsync();
        var features = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted).ToListAsync();
        // 客户已全局化：取本产品需求引用到的客户（不再按 ProductId）
        var graphCustIds = requirements.SelectMany(r => r.CustomerIds).Distinct().ToList();
        var customers = graphCustIds.Count == 0 ? new List<Customer>() : await _db.Customers.Find(c => graphCustIds.Contains(c.Id) && !c.IsDeleted).ToListAsync();
        var featureVersions = await _db.FeatureVersions.Find(fv => fv.ProductId == productId && !fv.IsDeleted).ToListAsync();
        var defects = await _db.DefectReports.Find(d => d.TracedProductId == productId && !d.IsDeleted).Limit(200).ToListAsync();

        var nodes = new List<object>();
        var edges = new List<object>();
        void AddEdge(string s, string t, string type) => edges.Add(new { id = $"{s}->{t}:{type}", source = s, target = t, type });

        nodes.Add(new { id = $"product:{product.Id}", type = "product", label = product.Name, sub = product.ProductNo, grade = product.Grade, state = product.CurrentState });
        foreach (var v in versions)
        {
            nodes.Add(new { id = $"version:{v.Id}", type = "version", label = v.VersionName, sub = v.Lifecycle, grade = (string?)null, state = v.CurrentState });
            AddEdge($"product:{product.Id}", $"version:{v.Id}", "contains");
        }
        foreach (var r in requirements)
        {
            nodes.Add(new { id = $"requirement:{r.Id}", type = "requirement", label = r.Title, sub = r.RequirementNo, grade = (string?)r.Grade, state = r.CurrentState });
            foreach (var vid in r.VersionIds) AddEdge($"version:{vid}", $"requirement:{r.Id}", "includes");
            foreach (var cid in r.CustomerIds) AddEdge($"requirement:{r.Id}", $"customer:{cid}", "from-customer");
        }
        foreach (var f in features)
        {
            nodes.Add(new { id = $"feature:{f.Id}", type = "feature", label = f.Title, sub = f.FeatureNo, grade = (string?)f.Grade, state = f.CurrentState });
            foreach (var rid in f.RequirementIds) AddEdge($"feature:{f.Id}", $"requirement:{rid}", "implements");
        }
        foreach (var c in customers)
            nodes.Add(new { id = $"customer:{c.Id}", type = "customer", label = c.Name, sub = c.Company, grade = (string?)null, state = (string?)null });
        foreach (var fv in featureVersions)
            AddEdge($"version:{fv.VersionId}", $"feature:{fv.FeatureId}", "feature-in-version");
        foreach (var d in defects)
        {
            nodes.Add(new { id = $"defect:{d.Id}", type = "defect", label = d.Title ?? d.DefectNo, sub = d.DefectNo, grade = (string?)d.Severity, state = d.Status });
            var any = false;
            if (!string.IsNullOrEmpty(d.TracedRequirementId)) { AddEdge($"defect:{d.Id}", $"requirement:{d.TracedRequirementId}", "traces"); any = true; }
            if (!string.IsNullOrEmpty(d.TracedFeatureId)) { AddEdge($"defect:{d.Id}", $"feature:{d.TracedFeatureId}", "traces"); any = true; }
            if (!string.IsNullOrEmpty(d.TracedVersionId)) { AddEdge($"defect:{d.Id}", $"version:{d.TracedVersionId}", "traces"); any = true; }
            if (!any) AddEdge($"defect:{d.Id}", $"product:{product.Id}", "traces");
        }

        return Ok(ApiResponse<object>.Ok(new { nodes, edges }));
    }

    // ════════════════════════ 大版本升级申请（P2）════════════════════════

    /// <summary>升级申请列表（按产品）</summary>
    [HttpGet("products/{productId}/upgrade-requests")]
    public async Task<IActionResult> ListUpgradeRequests(string productId)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var items = await _db.VersionUpgradeRequests.Find(u => u.ProductId == productId && !u.IsDeleted)
            .SortByDescending(u => u.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建升级申请</summary>
    [HttpPost("products/{productId}/upgrade-requests")]
    public async Task<IActionResult> CreateUpgradeRequest(string productId, [FromBody] UpsertUpgradeRequestRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "申请标题不能为空"));

        var req = new VersionUpgradeRequest
        {
            ProductId = productId,
            UpgradeNo = await GenerateNoAsync("UPG", _db.VersionUpgradeRequests, "UpgradeNo"),
            Title = request.Title.Trim(),
            Reason = request.Reason?.Trim(),
            FromVersionId = request.FromVersionId,
            TargetVersionId = request.TargetVersionId,
            TargetVersionName = request.TargetVersionName?.Trim(),
            RequirementIds = request.RequirementIds ?? new(),
            FeatureIds = request.FeatureIds ?? new(),
            KnowledgeEntryIds = request.KnowledgeEntryIds ?? new(),
            TemplateId = request.TemplateId,
            WorkflowDefId = request.WorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = userId,
        };
        req.CurrentState = await ResolveInitialStateAsync(request.WorkflowDefId);
        await _db.VersionUpgradeRequests.InsertOneAsync(req);
        return Ok(ApiResponse<object>.Ok(req));
    }

    /// <summary>更新升级申请</summary>
    [HttpPut("upgrade-requests/{upgradeId}")]
    public async Task<IActionResult> UpdateUpgradeRequest(string upgradeId, [FromBody] UpsertUpgradeRequestRequest request)
    {
        var req = await _db.VersionUpgradeRequests.Find(u => u.Id == upgradeId && !u.IsDeleted).FirstOrDefaultAsync();
        if (req == null || await FindAccessibleProductAsync(req.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "申请不存在或无权访问"));
        if (!string.IsNullOrWhiteSpace(request.Status) && !UpgradeRequestStatus.All.Contains(request.Status))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的申请状态"));

        var u = Builders<VersionUpgradeRequest>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.Title)) u = u.Set(x => x.Title, request.Title.Trim());
        u = u.Set(x => x.Reason, request.Reason?.Trim());
        if (request.FromVersionId != null) u = u.Set(x => x.FromVersionId, request.FromVersionId);
        if (request.TargetVersionId != null) u = u.Set(x => x.TargetVersionId, request.TargetVersionId);
        if (request.TargetVersionName != null) u = u.Set(x => x.TargetVersionName, request.TargetVersionName?.Trim());
        if (request.RequirementIds != null) u = u.Set(x => x.RequirementIds, request.RequirementIds);
        if (request.FeatureIds != null) u = u.Set(x => x.FeatureIds, request.FeatureIds);
        if (request.KnowledgeEntryIds != null) u = u.Set(x => x.KnowledgeEntryIds, request.KnowledgeEntryIds);
        if (!string.IsNullOrWhiteSpace(request.Status)) u = u.Set(x => x.Status, request.Status);
        if (request.FormData != null) u = u.Set(x => x.FormData, request.FormData);
        await _db.VersionUpgradeRequests.UpdateOneAsync(x => x.Id == upgradeId, u);
        var updated = await _db.VersionUpgradeRequests.Find(x => x.Id == upgradeId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除升级申请（软删除）</summary>
    [HttpDelete("upgrade-requests/{upgradeId}")]
    public async Task<IActionResult> DeleteUpgradeRequest(string upgradeId)
    {
        var req = await _db.VersionUpgradeRequests.Find(u => u.Id == upgradeId && !u.IsDeleted).FirstOrDefaultAsync();
        if (req == null || await FindAccessibleProductAsync(req.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "申请不存在或无权访问"));
        await _db.VersionUpgradeRequests.UpdateOneAsync(x => x.Id == upgradeId,
            Builders<VersionUpgradeRequest>.Update.Set(x => x.IsDeleted, true).Set(x => x.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
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
        if (!CanManage())
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

    /// <summary>在产品内新建缺陷（写入 defect_reports，自动追溯到本产品/需求/版本）。</summary>
    [HttpPost("products/{productId}/defects")]
    public async Task<IActionResult> CreateProductDefect(string productId, [FromBody] CreateProductDefectRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺陷标题不能为空"));

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        // 处理人（对齐新建需求）：有指派则回填显示名
        string? assigneeName = null;
        if (!string.IsNullOrWhiteSpace(request.AssigneeId))
            assigneeName = (await _db.Users.Find(u => u.UserId == request.AssigneeId).FirstOrDefaultAsync())?.DisplayName;
        var defect = new DefectReport
        {
            DefectNo = await GenerateNoAsync("DEF", _db.DefectReports, "DefectNo"),
            Title = request.Title.Trim(),
            RawContent = request.Description?.Trim() ?? string.Empty,
            Severity = request.Severity,
            Priority = DefectPriority.All.Contains(request.Priority ?? "") ? request.Priority : null,
            AssigneeId = string.IsNullOrWhiteSpace(request.AssigneeId) ? null : request.AssigneeId,
            AssigneeName = assigneeName,
            Status = DefectStatus.Submitted,
            ReporterId = userId,
            ReporterName = user?.DisplayName,
            TracedProductId = productId,
            TracedRequirementId = request.RequirementId,
            TracedVersionId = request.VersionId,
        };
        await _db.DefectReports.InsertOneAsync(defect);
        await RecalcDefectCountAsync(productId);
        return Ok(ApiResponse<object>.Ok(defect));
    }

    /// <summary>解除缺陷的产品追溯。</summary>
    [HttpPost("untrace-defect")]    public async Task<IActionResult> UntraceDefect([FromBody] UntraceDefectRequest request)
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

    /// <summary>缺陷转需求：把缺陷转成本产品的一条需求，记录来源缺陷并建立追溯（缺陷 → 新需求）。幂等。</summary>
    [HttpPost("defects/{defectId}/convert-to-requirement")]
    public async Task<IActionResult> ConvertDefectToRequirement(string defectId)
    {
        var userId = GetUserId();
        var defect = await _db.DefectReports.Find(d => d.Id == defectId && !d.IsDeleted).FirstOrDefaultAsync();
        if (defect == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "缺陷不存在"));
        if (string.IsNullOrWhiteSpace(defect.TracedProductId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺陷未追溯到产品，无法转需求"));
        var productId = defect.TracedProductId!;
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));

        // 幂等：已转过则直接返回既有需求
        var existing = await _db.Requirements.Find(r => r.SourceDefectId == defectId && !r.IsDeleted).FirstOrDefaultAsync();
        if (existing != null) return Ok(ApiResponse<object>.Ok(existing));

        var (_, workflowDefId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);
        var req = new Requirement
        {
            ProductId = productId,
            RequirementNo = await GenerateNoAsync("REQ", _db.Requirements, "RequirementNo"),
            Title = string.IsNullOrWhiteSpace(defect.Title) ? $"由缺陷 {defect.DefectNo} 转化" : defect.Title!.Trim(),
            Description = defect.RawContent,
            Grade = SeverityToGrade(defect.Severity),
            WorkflowDefId = workflowDefId,
            OwnerId = userId,
            SourceDefectId = defectId,
        };
        req.CurrentState = await ResolveInitialStateAsync(workflowDefId);
        await _db.Requirements.InsertOneAsync(req);

        // 建立追溯：缺陷指向新需求（新需求的「追溯缺陷」即可看到来源缺陷）
        await _db.DefectReports.UpdateOneAsync(d => d.Id == defectId,
            Builders<DefectReport>.Update.Set(d => d.TracedRequirementId, req.Id));
        var convActor = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        await RecordActivityAsync(ProductEntityType.Requirement, req.Id, productId, ProductActivityType.Convert, userId, convActor, content: $"由缺陷 {defect.DefectNo} 转化生成");
        await RecalcProductCountsAsync(productId);
        _logger.LogInformation("[product-agent] Defect {DefectNo} converted to requirement {ReqNo} by {User}", defect.DefectNo, req.RequirementNo, userId);
        return Ok(ApiResponse<object>.Ok(req));
    }

    /// <summary>缺陷严重度 → 需求分级映射。</summary>
    private static string SeverityToGrade(string? severity) => severity switch
    {
        DefectSeverity.Blocker or DefectSeverity.Critical => ProductItemGrade.P0,
        DefectSeverity.Major => ProductItemGrade.P1,
        DefectSeverity.Minor => ProductItemGrade.P2,
        DefectSeverity.Trivial or DefectSeverity.Suggestion => ProductItemGrade.P3,
        _ => ProductItemGrade.P2,
    };

    // ════════════════════════ 动态/讨论时间线 + 通知（P2）════════════════════════

    /// <summary>解析对象上下文（产品/处理人/负责人/标题/编号），仅支持需求 / 功能。</summary>
    private async Task<(string productId, string? assigneeId, string ownerId, string title, string no)?> ResolveItemContextAsync(string entityType, string entityId)
    {
        switch (entityType)
        {
            case ProductEntityType.Requirement:
                var r = await _db.Requirements.Find(x => x.Id == entityId && !x.IsDeleted).FirstOrDefaultAsync();
                return r == null ? null : (r.ProductId, r.AssigneeId, r.OwnerId, r.Title, r.RequirementNo);
            case ProductEntityType.Feature:
                var f = await _db.Features.Find(x => x.Id == entityId && !x.IsDeleted).FirstOrDefaultAsync();
                return f == null ? null : (f.ProductId, f.AssigneeId, f.OwnerId, f.Title, f.FeatureNo);
            default:
                return null;
        }
    }

    /// <summary>写一条时间线记录（评论或系统活动）。</summary>
    private async Task<ProductItemActivity> RecordActivityAsync(string entityType, string entityId, string productId, string type, string actorId, string? actorName,
        string? content = null, string? fromValue = null, string? toValue = null, List<string>? mentions = null)
    {
        var act = new ProductItemActivity
        {
            EntityType = entityType, EntityId = entityId, ProductId = productId, Type = type,
            ActorId = actorId, ActorName = actorName, Content = content, FromValue = fromValue, ToValue = toValue,
            Mentions = mentions ?? new(),
        };
        await _db.ProductItemActivities.InsertOneAsync(act);
        return act;
    }

    /// <summary>给一组 MAP 用户发通知（去重、排除操作人本人、跳过空值）。</summary>
    private async Task NotifyItemAsync(IEnumerable<string?> targetUserIds, string actorId, string title, string message, string actionUrl)
    {
        var targets = targetUserIds.Where(x => !string.IsNullOrWhiteSpace(x) && x != actorId).Select(x => x!).Distinct().ToList();
        if (targets.Count == 0) return;
        var notifications = targets.Select(uid => new AdminNotification
        {
            TargetUserId = uid,
            Title = title,
            Message = message,
            Level = "info",
            ActionLabel = "查看详情",
            ActionUrl = actionUrl,
            Source = "product-agent",
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        }).ToList();
        await _db.AdminNotifications.InsertManyAsync(notifications);
    }

    private static string ItemUrl(string productId, string entityType, string entityId) => $"/product-agent/p/{productId}/{entityType}/{entityId}";

    /// <summary>处理人变更时记录时间线 + 通知新处理人（无变化则跳过）。</summary>
    private async Task RecordAssignChangeAsync(string entityType, string entityId, string productId, string? oldAssignee, string? newAssignee, string no, string title)
    {
        if (newAssignee == null || newAssignee == oldAssignee) return;
        var userId = GetUserId();
        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var newName = string.IsNullOrWhiteSpace(newAssignee) ? "未指派" : ((await _db.Users.Find(u => u.UserId == newAssignee).FirstOrDefaultAsync())?.DisplayName ?? newAssignee);
        await RecordActivityAsync(entityType, entityId, productId, ProductActivityType.Assign, userId, actorName, toValue: newName);
        await NotifyItemAsync(new[] { (string?)newAssignee }, userId, $"指派给你 · {no}", $"{actorName ?? "有人"} 把「{title}」指派给你处理", ItemUrl(productId, entityType, entityId));
    }

    /// <summary>时间线列表（评论 + 系统活动，时间正序）。</summary>
    [HttpGet("items/{entityType}/{entityId}/activities")]
    public async Task<IActionResult> ListActivities(string entityType, string entityId)
    {
        var ctx = await ResolveItemContextAsync(entityType, entityId);
        if (ctx == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在或不支持时间线"));
        if (await FindAccessibleProductAsync(ctx.Value.productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "无权访问该对象"));
        var items = await _db.ProductItemActivities.Find(a => a.EntityType == entityType && a.EntityId == entityId)
            .SortBy(a => a.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>发表评论（富文本 + @提醒），写入时间线并通知提醒人 / 处理人 / 负责人。</summary>
    [HttpPost("items/{entityType}/{entityId}/comments")]
    public async Task<IActionResult> AddComment(string entityType, string entityId, [FromBody] ProductCommentRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "评论内容不能为空"));
        var ctx = await ResolveItemContextAsync(entityType, entityId);
        if (ctx == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在或不支持评论"));
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(ctx.Value.productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "无权访问该对象"));
        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var mentions = (request.Mentions ?? new()).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        var act = await RecordActivityAsync(entityType, entityId, ctx.Value.productId, ProductActivityType.Comment, userId, actorName, content: request.Content, mentions: mentions);

        var targets = new List<string?> { ctx.Value.assigneeId, ctx.Value.ownerId };
        targets.AddRange(mentions.Select(m => (string?)m));
        await NotifyItemAsync(targets, userId, $"新评论 · {ctx.Value.no}", $"{actorName ?? "有人"} 评论了「{ctx.Value.title}」", ItemUrl(ctx.Value.productId, entityType, entityId));
        return Ok(ApiResponse<object>.Ok(act));
    }

    /// <summary>AI 摘要：对需求/功能/缺陷的标题+描述生成 2-3 句中文概括（图谱抽屉用）。走 ILlmGateway。</summary>
    [HttpGet("items/{entityType}/{entityId}/summary")]
    public async Task<IActionResult> SummarizeItem(string entityType, string entityId, [FromQuery] bool force, CancellationToken ct)
    {
        string productId, title, raw, kindLabel;
        switch (entityType)
        {
            case ProductEntityType.Requirement:
            {
                var r = await _db.Requirements.Find(x => x.Id == entityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (r == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                productId = r.ProductId; title = r.Title; raw = r.Description ?? ""; kindLabel = "需求";
                break;
            }
            case ProductEntityType.Feature:
            {
                var f = await _db.Features.Find(x => x.Id == entityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (f == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                productId = f.ProductId; title = f.Title; raw = f.Description ?? ""; kindLabel = "功能";
                break;
            }
            case "defect":
            {
                var d = await _db.DefectReports.Find(x => x.Id == entityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (d == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                productId = d.TracedProductId ?? ""; title = d.Title ?? ""; raw = d.RawContent; kindLabel = "缺陷";
                break;
            }
            default:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持需求/功能/缺陷摘要"));
        }
        if (string.IsNullOrEmpty(productId) || await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "无权访问该对象"));

        // 缓存优先：同一对象只在首个打开者触发生成，其他人读缓存；force=true(重新摘要)才重算覆盖
        var cached = await _db.ProductItemSummaries.Find(s => s.EntityType == entityType && s.EntityId == entityId).FirstOrDefaultAsync();
        if (!force && cached != null && !string.IsNullOrWhiteSpace(cached.Summary))
            return Ok(ApiResponse<object>.Ok(new { summary = cached.Summary, generatedByName = cached.GeneratedByName, generatedAt = cached.GeneratedAt, cached = true }));

        var text = System.Text.RegularExpressions.Regex.Replace(raw ?? "", "<[^>]+>", " ")
            .Replace("&nbsp;", " ").Replace("&amp;", "&").Replace("&lt;", "<").Replace("&gt;", ">").Trim();
        if (text.Length == 0)
            return Ok(ApiResponse<object>.Ok(new { summary = (string?)null, message = "暂无描述内容可摘要" }));
        if (text.Length > 8000) text = text[..8000];

        var userId = GetUserId();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"), GroupId: null, SessionId: null, UserId: userId,
            ViewRole: null, DocumentChars: text.Length, DocumentHash: null,
            SystemPromptRedacted: "product-graph-summary", RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Product.GraphSummary));

        var systemPrompt = $"你是产品研发助手。下面是一条「{kindLabel}」的标题与描述，请用 2-3 句中文概括其核心（背景/痛点 + 期望或影响），输出纯文本，不要 markdown、不要前缀。";
        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = $"标题：{title}\n描述：{text}" },
            },
            ["temperature"] = 0.3,
            ["max_tokens"] = 400,
        };
        var resp = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Product.GraphSummary,
            ModelType = "chat",
            RequestBody = body,
        }, ct);
        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
            return Ok(ApiResponse<object>.Ok(new { summary = (string?)null, message = "摘要生成失败，请稍后重试" }));

        var summaryText = resp.Content!.Trim();
        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var now = DateTime.UtcNow;
        // 落库缓存（覆盖式：有则更新，无则插入；不用 upsert 以避免 string Id 与自动 ObjectId 冲突）
        if (cached != null)
            await _db.ProductItemSummaries.UpdateOneAsync(s => s.Id == cached.Id,
                Builders<ProductItemSummary>.Update.Set(s => s.Summary, summaryText).Set(s => s.GeneratedById, userId).Set(s => s.GeneratedByName, actorName).Set(s => s.GeneratedAt, now).Set(s => s.UpdatedAt, now));
        else
            await _db.ProductItemSummaries.InsertOneAsync(new ProductItemSummary { EntityType = entityType, EntityId = entityId, Summary = summaryText, GeneratedById = userId, GeneratedByName = actorName, GeneratedAt = now });

        return Ok(ApiResponse<object>.Ok(new { summary = summaryText, generatedByName = actorName, generatedAt = now, cached = false }));
    }

    // ════════════════════════ 需求 AI 智能填充（SSE 流式）════════════════════════

    /// <summary>
    /// 输入一段需求文本，LLM 按表单模板结构化输出，回填标题/描述/分级/自定义字段。
    /// SSE 流式：phase（阶段）+ typing（逐字）+ result（解析后字段）+ done。规则 #6 可视化。
    /// </summary>
    [HttpPost("products/{productId}/requirements/ai-fill/stream")]
    public async Task AiFillRequirement(string productId, [FromBody] AiFillRequirementRequest request)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        async Task Sse(string evt, object data)
        {
            var json = System.Text.Json.JsonSerializer.Serialize(data);
            await Response.WriteAsync($"event: {evt}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }

        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null) { await Sse("error", new { message = "产品不存在或无权访问" }); return; }
        var text = (request.Text ?? "").Trim();
        if (text.Length == 0) { await Sse("error", new { message = "请输入需求文本" }); return; }
        if (text.Length > 8000) text = text[..8000];

        var template = !string.IsNullOrEmpty(request.TemplateId)
            ? await _db.ProductFormTemplates.Find(t => t.Id == request.TemplateId && !t.IsDeleted).FirstOrDefaultAsync()
            : null;
        var fields = (template?.Fields ?? new List<ProductFormField>())
            .Where(f => f.Type != ProductFormFieldType.File).ToList();

        var fieldSpec = string.Join("\n", fields.Select(f =>
        {
            var opts = (f.Options != null && f.Options.Count > 0) ? $"，可选值: {string.Join(" / ", f.Options.Select(o => o.Value))}" : "";
            return $"- {f.Key}（{f.Label}，类型 {f.Type}{(f.Required ? "，必填" : "")}{opts}）";
        }));

        var systemPrompt =
            "你是产品需求结构化助手。用户会给一段需求原始文本，请抽取并整理为一条规范需求。\n" +
            "严格只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块），结构：\n" +
            "{\"title\": 简洁标题, \"description\": 需求描述(可含背景/目标/验收标准，纯文本), \"grade\": 分级(p0/p1/p2/p3，按紧急重要程度推断，默认 p2), \"formData\": {模板字段key: 值}}\n" +
            (fields.Count > 0
                ? $"formData 仅可包含以下字段的 key（无法从文本判断的可省略）：\n{fieldSpec}\n"
                : "没有自定义模板字段时 formData 返回空对象 {}。\n") +
            "select/radio 类字段的值必须取给定可选值之一。";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"), GroupId: null, SessionId: null, UserId: userId,
            ViewRole: null, DocumentChars: text.Length, DocumentHash: null,
            SystemPromptRedacted: "product-requirement-ai-fill", RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Product.RequirementAiFill));

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = $"需求原始文本：\n{text}" },
            },
            ["temperature"] = 0.2,
            ["max_tokens"] = 1200,
        };

        await Sse("phase", new { message = "AI 正在分析需求文本…" });

        var sb = new System.Text.StringBuilder();
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.Product.RequirementAiFill,
                ModelType = ModelTypes.Chat,
                Stream = true,
                RequestBody = body,
            }, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    sb.Append(chunk.Content);
                    await Sse("typing", new { text = chunk.Content });
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    await Sse("error", new { message = chunk.Error ?? "AI 调用失败" });
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[product-agent] requirement ai-fill stream error");
            await Sse("error", new { message = "AI 调用异常，请重试" });
            return;
        }

        var parsed = ExtractFillJson(sb.ToString(), fields);
        if (parsed == null) { await Sse("error", new { message = "AI 返回无法解析，请重试或精简文本" }); return; }
        await Sse("result", parsed);
        await Sse("done", new { });
    }

    /// <summary>从 LLM 原始输出里抽取并规范化填充 JSON（容错 markdown 代码块/前后缀文本）。</summary>
    private static object? ExtractFillJson(string raw, List<ProductFormField> fields)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var start = raw.IndexOf('{');
        var end = raw.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        var s = raw.Substring(start, end - start + 1);
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(s);
            var root = doc.RootElement;
            string GetStr(string k) => root.TryGetProperty(k, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String ? (v.GetString() ?? "") : "";
            var title = GetStr("title").Trim();
            var description = GetStr("description").Trim();
            var grade = GetStr("grade").Trim().ToLowerInvariant();
            if (grade != "p0" && grade != "p1" && grade != "p2" && grade != "p3") grade = "p2";
            var formData = new Dictionary<string, string>();
            var allowed = fields.Select(f => f.Key).ToHashSet();
            if (root.TryGetProperty("formData", out var fd) && fd.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                foreach (var p in fd.EnumerateObject())
                {
                    if (allowed.Count > 0 && !allowed.Contains(p.Name)) continue;
                    var val = p.Value.ValueKind switch
                    {
                        System.Text.Json.JsonValueKind.String => p.Value.GetString() ?? "",
                        System.Text.Json.JsonValueKind.Number => p.Value.ToString(),
                        System.Text.Json.JsonValueKind.True => "true",
                        System.Text.Json.JsonValueKind.False => "false",
                        _ => "",
                    };
                    if (!string.IsNullOrEmpty(val)) formData[p.Name] = val;
                }
            }
            if (string.IsNullOrEmpty(title) && string.IsNullOrEmpty(description) && formData.Count == 0) return null;
            return new { title, description, grade, formData };
        }
        catch { return null; }
    }

    // ════════════════════════ 批量导入 ════════════════════════

    /// <summary>批量导入需求（来自 CSV 解析后的行）：每行 title 必填，自动绑定默认流程 + 初始状态。</summary>
    [HttpPost("products/{productId}/requirements/import")]
    public async Task<IActionResult> ImportRequirements(string productId, [FromBody] ImportRequirementsRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var rows = (request.Rows ?? new()).Where(r => !string.IsNullOrWhiteSpace(r.Title)).ToList();
        if (rows.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有可导入的有效行（标题不能为空）"));
        if (rows.Count > 500)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "单次最多导入 500 条"));

        var (_, wfId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);
        var initialState = await ResolveInitialStateAsync(wfId);
        var now = DateTime.UtcNow;
        var created = 0;
        foreach (var row in rows)
        {
            var req = new Requirement
            {
                ProductId = productId,
                RequirementNo = await GenerateNoAsync("REQ", _db.Requirements, "RequirementNo"),
                Title = row.Title!.Trim(),
                Description = row.Description?.Trim(),
                Grade = ProductItemGrade.All.Contains(row.Grade ?? "") ? row.Grade! : ProductItemGrade.P2,
                WorkflowDefId = wfId,
                CurrentState = initialState,
                StateEnteredAt = now,
                OwnerId = userId,
            };
            await _db.Requirements.InsertOneAsync(req);
            created++;
        }
        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(new { created }));
    }

    // ════════════════════════ 报表 / 统计分析 ════════════════════════

    /// <summary>产品报表：版本进度（按需求状态分类）+ 迭代速度（每周完成吞吐）+ 总体进度。</summary>
    [HttpGet("products/{productId}/analytics")]
    public async Task<IActionResult> GetAnalytics(string productId)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));

        var reqs = await _db.Requirements.Find(r => r.ProductId == productId && !r.IsDeleted).ToListAsync();
        var versions = await _db.ProductVersions.Find(v => v.ProductId == productId && !v.IsDeleted).SortBy(v => v.CreatedAt).ToListAsync();

        // 需求 / 功能流程定义（拿状态分类 + 终态标签）
        var (_, reqWfId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);
        var (_, featWfId) = await ResolveDefaultsAsync(ProductEntityType.Feature, productId);
        var defIds = new[] { reqWfId, featWfId }.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).Distinct().ToList();
        var defs = defIds.Count == 0 ? new List<ProductWorkflowDefinition>()
            : await _db.ProductWorkflowDefinitions.Find(w => defIds.Contains(w.Id) && !w.IsDeleted).ToListAsync();
        var reqDef = defs.FirstOrDefault(d => d.Id == reqWfId);
        var reqStates = reqDef?.States.ToDictionary(s => s.Key, s => s) ?? new();
        string CatOf(string? key) => key != null && reqStates.TryGetValue(key, out var s) ? (s.Category ?? (s.IsFinal ? "done" : "todo")) : "todo";

        // 版本进度（按需求状态分类）
        var releaseProgress = versions.Select(v =>
        {
            var inV = reqs.Where(r => r.VersionIds.Contains(v.Id)).ToList();
            return new
            {
                versionId = v.Id, versionName = v.VersionName, total = inV.Count,
                done = inV.Count(r => CatOf(r.CurrentState) == "done"),
                doing = inV.Count(r => CatOf(r.CurrentState) == "doing"),
                todo = inV.Count(r => CatOf(r.CurrentState) is not ("done" or "doing")),
            };
        }).ToList();

        // 总体进度（全部需求）
        var overall = new
        {
            total = reqs.Count,
            done = reqs.Count(r => CatOf(r.CurrentState) == "done"),
            doing = reqs.Count(r => CatOf(r.CurrentState) == "doing"),
            todo = reqs.Count(r => CatOf(r.CurrentState) is not ("done" or "doing")),
        };

        // 迭代速度：近 8 周「进入终态」的吞吐（从时间线流转记录统计，按对象类型拆分）
        var finalLabels = defs.SelectMany(d => d.States.Where(s => s.IsFinal).Select(s => s.Label)).ToHashSet();
        DateTime WeekStart(DateTime d) { var dt = d.Date; var diff = ((int)dt.DayOfWeek + 6) % 7; return dt.AddDays(-diff); }
        var weeks = Enumerable.Range(0, 8).Select(i => WeekStart(DateTime.UtcNow).AddDays(-7 * (7 - i))).ToList();
        var since = weeks.First();
        var acts = await _db.ProductItemActivities.Find(a => a.ProductId == productId && a.Type == ProductActivityType.Transition && a.CreatedAt >= since).ToListAsync();
        var closures = acts.Where(a => a.ToValue != null && finalLabels.Contains(a.ToValue)).ToList();
        var velocity = weeks.Select(w =>
        {
            var wEnd = w.AddDays(7);
            var inWeek = closures.Where(a => a.CreatedAt >= w && a.CreatedAt < wEnd).ToList();
            return new
            {
                week = $"{w:MM-dd}",
                requirements = inWeek.Count(a => a.EntityType == ProductEntityType.Requirement),
                features = inWeek.Count(a => a.EntityType == ProductEntityType.Feature),
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { releaseProgress, overall, velocity }));
    }

    // ════════════════════════ 批量操作 ════════════════════════

    /// <summary>批量操作需求 / 功能：删除 / 指派处理人 / 改分级（仅作用于有权访问的产品下的对象）。</summary>
    [HttpPost("items/batch")]
    public async Task<IActionResult> BatchUpdate([FromBody] BatchRequest request)
    {
        if (request.Ids == null || request.Ids.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未选择对象"));
        if (request.EntityType is not (ProductEntityType.Requirement or ProductEntityType.Feature))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持批量操作需求 / 功能"));
        if (request.Op is not ("delete" or "assign" or "grade"))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的批量操作"));
        if (request.Op == "grade" && !ProductItemGrade.All.Contains(request.Grade ?? ""))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的分级"));

        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var now = DateTime.UtcNow;
        var affectedProducts = new HashSet<string>();
        var count = 0;

        if (request.EntityType == ProductEntityType.Requirement)
        {
            var items = (await _db.Requirements.Find(r => request.Ids.Contains(r.Id) && !r.IsDeleted).ToListAsync())
                .Where(r => scope == null || scope.Contains(r.ProductId)).ToList();
            foreach (var r in items)
            {
                var u = request.Op switch
                {
                    "delete" => Builders<Requirement>.Update.Set(x => x.IsDeleted, true).Set(x => x.UpdatedAt, now),
                    "assign" => Builders<Requirement>.Update.Set(x => x.AssigneeId, string.IsNullOrWhiteSpace(request.AssigneeId) ? null : request.AssigneeId).Set(x => x.UpdatedAt, now),
                    _ => Builders<Requirement>.Update.Set(x => x.Grade, request.Grade!).Set(x => x.UpdatedAt, now),
                };
                await _db.Requirements.UpdateOneAsync(x => x.Id == r.Id, u);
                affectedProducts.Add(r.ProductId);
                count++;
            }
        }
        else
        {
            var items = (await _db.Features.Find(f => request.Ids.Contains(f.Id) && !f.IsDeleted).ToListAsync())
                .Where(f => scope == null || scope.Contains(f.ProductId)).ToList();
            foreach (var f in items)
            {
                var u = request.Op switch
                {
                    "delete" => Builders<Feature>.Update.Set(x => x.IsDeleted, true).Set(x => x.UpdatedAt, now),
                    "assign" => Builders<Feature>.Update.Set(x => x.AssigneeId, string.IsNullOrWhiteSpace(request.AssigneeId) ? null : request.AssigneeId).Set(x => x.UpdatedAt, now),
                    _ => Builders<Feature>.Update.Set(x => x.Grade, request.Grade!).Set(x => x.UpdatedAt, now),
                };
                await _db.Features.UpdateOneAsync(x => x.Id == f.Id, u);
                affectedProducts.Add(f.ProductId);
                count++;
            }
        }
        foreach (var pid in affectedProducts) await RecalcProductCountsAsync(pid);
        return Ok(ApiResponse<object>.Ok(new { affected = count }));
    }

    // ════════════════════════ 全局搜索（跨对象） ════════════════════════

    /// <summary>跨对象全局搜索：产品 / 需求 / 功能 / 客户 / 缺陷，按关键词分组返回 top-N（受访问范围约束）。</summary>
    [HttpGet("search")]
    public async Task<IActionResult> GlobalSearch([FromQuery] string keyword, [FromQuery] int limit = 8)
    {
        var kw = (keyword ?? string.Empty).Trim();
        if (kw.Length == 0)
            return Ok(ApiResponse<object>.Ok(new { products = Array.Empty<object>(), requirements = Array.Empty<object>(), features = Array.Empty<object>(), customers = Array.Empty<object>(), defects = Array.Empty<object>() }));
        const StringComparison oic = StringComparison.OrdinalIgnoreCase;
        var scope = await GetAccessibleProductIdsAsync(GetUserId());

        var pf = Builders<Product>.Filter.And(
            Builders<Product>.Filter.Eq(p => p.IsDeleted, false),
            scope == null ? Builders<Product>.Filter.Empty : Builders<Product>.Filter.In(p => p.Id, scope));
        var products = (await _db.Products.Find(pf).Limit(2000).ToListAsync())
            .Where(p => p.Name.Contains(kw, oic) || p.ProductNo.Contains(kw, oic))
            .Take(limit).Select(p => new { p.Id, no = p.ProductNo, p.Name }).ToList();

        var reqs = (await FindInScopeAsync<Requirement>(scope, r => r.ProductId, r => r.IsDeleted))
            .Where(r => (r.Title?.Contains(kw, oic) ?? false) || r.RequirementNo.Contains(kw, oic))
            .Take(limit).Select(r => new { r.Id, r.ProductId, no = r.RequirementNo, title = r.Title }).ToList();

        var feats = (await FindInScopeAsync<Feature>(scope, f => f.ProductId, f => f.IsDeleted))
            .Where(f => (f.Title?.Contains(kw, oic) ?? false) || f.FeatureNo.Contains(kw, oic))
            .Take(limit).Select(f => new { f.Id, f.ProductId, no = f.FeatureNo, title = f.Title }).ToList();

        // 客户已全局化：搜全部客户（不按产品 scope 过滤）
        var custs = (await _db.Customers.Find(c => !c.IsDeleted).ToListAsync())
            .Where(c => c.Name.Contains(kw, oic) || (c.Company?.Contains(kw, oic) ?? false))
            .Take(limit).Select(c => new { c.Id, c.ProductId, c.Name }).ToList();

        var df = Builders<DefectReport>.Filter.And(
            Builders<DefectReport>.Filter.Eq(d => d.IsDeleted, false),
            Builders<DefectReport>.Filter.Ne(d => d.TracedProductId, (string?)null),
            scope == null ? Builders<DefectReport>.Filter.Empty : Builders<DefectReport>.Filter.In(d => d.TracedProductId, scope));
        var defects = (await _db.DefectReports.Find(df).Limit(3000).ToListAsync())
            .Where(d => (d.Title?.Contains(kw, oic) ?? false) || d.DefectNo.Contains(kw, oic))
            .Take(limit).Select(d => new { d.Id, productId = d.TracedProductId, no = d.DefectNo, title = d.Title }).ToList();

        return Ok(ApiResponse<object>.Ok(new { products, requirements = reqs, features = feats, customers = custs, defects }));
    }

    // ════════════════════════ RTM 需求可追溯矩阵 ════════════════════════

    /// <summary>需求可追溯矩阵：每条需求 → 归属版本 / 实现功能 / 关联客户 / 追溯缺陷 + 覆盖缺口统计。</summary>
    [HttpGet("products/{productId}/rtm")]
    public async Task<IActionResult> GetRtm(string productId)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));

        var reqs = await _db.Requirements.Find(r => r.ProductId == productId && !r.IsDeleted).SortByDescending(r => r.CreatedAt).ToListAsync();
        var feats = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted).ToListAsync();
        var versions = await _db.ProductVersions.Find(v => v.ProductId == productId && !v.IsDeleted).ToListAsync();
        // 客户已全局化：取本产品需求引用到的客户
        var rtmCustIds = reqs.SelectMany(r => r.CustomerIds).Distinct().ToList();
        var customers = rtmCustIds.Count == 0 ? new List<Customer>() : await _db.Customers.Find(c => rtmCustIds.Contains(c.Id) && !c.IsDeleted).ToListAsync();
        var defects = await _db.DefectReports.Find(d => d.TracedProductId == productId && !d.IsDeleted).ToListAsync();

        var versionName = versions.ToDictionary(v => v.Id, v => v.VersionName);
        var customerName = customers.ToDictionary(c => c.Id, c => c.Name);

        var rows = reqs.Select(r =>
        {
            var implFeatures = feats.Where(f => f.RequirementIds.Contains(r.Id)).Select(f => new { f.Id, f.FeatureNo, f.Title }).ToList();
            var reqDefects = defects.Where(d => d.TracedRequirementId == r.Id).Select(d => new { d.Id, d.DefectNo, d.Title, d.Status }).ToList();
            return new
            {
                r.Id, r.RequirementNo, r.Title, r.Grade, r.CurrentState,
                versions = r.VersionIds.Where(versionName.ContainsKey).Select(id => new { id, name = versionName[id] }).ToList(),
                customers = r.CustomerIds.Where(customerName.ContainsKey).Select(id => new { id, name = customerName[id] }).ToList(),
                features = implFeatures,
                defects = reqDefects,
            };
        }).ToList();

        var reqIdSet = reqs.Select(r => r.Id).ToHashSet();
        var orphanFeatures = feats
            .Where(f => f.RequirementIds.Count == 0 || !f.RequirementIds.Any(reqIdSet.Contains))
            .Select(f => new { f.Id, f.FeatureNo, f.Title }).ToList();

        var stats = new
        {
            total = reqs.Count,
            withoutFeature = rows.Count(x => x.features.Count == 0),
            withoutVersion = rows.Count(x => x.versions.Count == 0),
            orphanFeatures = orphanFeatures.Count,
        };
        return Ok(ApiResponse<object>.Ok(new { rows, orphanFeatures, stats }));
    }

    // ════════════════════════ 管理层总览（跨产品聚合，P1）════════════════════════

    /// <summary>当前用户是否管理层（看全部产品 + 全局设置）。</summary>
    private bool IsProductAdmin() => HasPermission(AdminPermissionCatalog.ProductAgentAdmin);

    /// <summary>能否管理/查看全部产品：管理员(ProductAgentAdmin)是管理(ProductAgentManage)的超集；Super 已含在 HasPermission 内。</summary>
    private bool CanManage() => IsProductAdmin() || HasPermission(AdminPermissionCatalog.ProductAgentManage);

    /// <summary>能否管理本产品成员（增删普通成员）：全局管理 | 产品负责人 | 产品管理员。</summary>
    private bool CanManageProductMembers(Product p, string uid)
        => CanManage() || p.OwnerId == uid || p.AdminIds.Contains(uid);

    /// <summary>能否指派/撤销产品管理员：全局管理 | 产品负责人（产品管理员不可指派同级）。</summary>
    private bool CanManageProductAdmins(Product p, string uid)
        => CanManage() || p.OwnerId == uid;

    /// <summary>可访问的产品 Id 集合；返回 null 表示"全部"（管理层/管理权限）。</summary>
    private async Task<HashSet<string>?> GetAccessibleProductIdsAsync(string userId)
    {
        if (CanManage()) return null;
        var b = Builders<Product>.Filter;
        var filter = b.And(b.Eq(p => p.IsDeleted, false),
            b.Or(b.Eq(p => p.OwnerId, userId), b.AnyEq(p => p.MemberIds, userId)));
        var ids = await _db.Products.Find(filter).Project(p => p.Id).ToListAsync();
        return ids.ToHashSet();
    }

    /// <summary>跨产品聚合仪表盘：KPI 计数 + 分级/状态/生命周期分布 + 最近活动。</summary>
    [HttpGet("overview/stats")]
    public async Task<IActionResult> OverviewStats()
    {
        var userId = GetUserId();
        var scope = await GetAccessibleProductIdsAsync(userId);

        var products = await _db.Products.Find(scope == null
            ? Builders<Product>.Filter.Eq(p => p.IsDeleted, false)
            : Builders<Product>.Filter.And(Builders<Product>.Filter.Eq(p => p.IsDeleted, false), Builders<Product>.Filter.In(p => p.Id, scope)))
            .Limit(5000).ToListAsync();
        var nameById = products.ToDictionary(p => p.Id, p => p.Name);

        var versions = await FindInScopeAsync<ProductVersion>(scope, v => v.ProductId, v => v.IsDeleted);
        var requirements = await FindInScopeAsync<Requirement>(scope, r => r.ProductId, r => r.IsDeleted);
        var features = await FindInScopeAsync<Feature>(scope, f => f.ProductId, f => f.IsDeleted);
        var customers = await _db.Customers.Find(c => !c.IsDeleted).ToListAsync(); // 客户已全局化
        var defects = await _db.DefectReports.Find(Builders<DefectReport>.Filter.And(
                Builders<DefectReport>.Filter.Eq(d => d.IsDeleted, false),
                Builders<DefectReport>.Filter.Ne(d => d.TracedProductId, (string?)null),
                scope == null ? Builders<DefectReport>.Filter.Empty : Builders<DefectReport>.Filter.In(d => d.TracedProductId, scope)))
            .Limit(5000).ToListAsync();

        var recent = requirements.Select(r => new { type = "requirement", id = r.Id, productId = r.ProductId, productName = nameById.GetValueOrDefault(r.ProductId, ""), title = r.Title, no = r.RequirementNo, at = r.UpdatedAt })
            .Concat(features.Select(f => new { type = "feature", id = f.Id, productId = f.ProductId, productName = nameById.GetValueOrDefault(f.ProductId, ""), title = f.Title, no = f.FeatureNo, at = f.UpdatedAt }))
            .Concat(versions.Select(v => new { type = "version", id = v.Id, productId = v.ProductId, productName = nameById.GetValueOrDefault(v.ProductId, ""), title = v.VersionName, no = v.VersionName, at = v.UpdatedAt }))
            .OrderByDescending(x => x.at).Take(15).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            isAdmin = IsProductAdmin(),
            counts = new
            {
                products = products.Count,
                versions = versions.Count,
                requirements = requirements.Count,
                features = features.Count,
                defects = defects.Count,
                customers = customers.Count,
            },
            requirementsByGrade = ProductItemGrade.All.ToDictionary(g => g, g => requirements.Count(r => r.Grade == g)),
            featuresByGrade = ProductItemGrade.All.ToDictionary(g => g, g => features.Count(f => f.Grade == g)),
            defectsByStatus = defects.GroupBy(d => d.Status).ToDictionary(g => g.Key, g => g.Count()),
            versionsByLifecycle = ProductVersionLifecycle.All.ToDictionary(l => l, l => versions.Count(v => v.Lifecycle == l)),
            recent,
        }));
    }

    /// <summary>跨产品需求列表（含所属产品名）。</summary>
    [HttpGet("overview/requirements")]
    public async Task<IActionResult> OverviewRequirements([FromQuery] string? grade = null, [FromQuery] string? keyword = null, [FromQuery] bool mine = false)
    {
        var userId = GetUserId();
        var scope = await GetAccessibleProductIdsAsync(userId);
        var items = await FindInScopeAsync<Requirement>(scope, r => r.ProductId, r => r.IsDeleted);
        var names = await ProductNamesAsync(items.Select(r => r.ProductId));
        var userNames = await UserNamesAsync(items.Select(r => r.AssigneeId));
        var rows = items
            .Where(r => string.IsNullOrWhiteSpace(grade) || r.Grade == grade)
            .Where(r => !mine || r.AssigneeId == userId)
            .Where(r => string.IsNullOrWhiteSpace(keyword) || (r.Title?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false) || r.RequirementNo.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(r => r.UpdatedAt)
            .Select(r => new { r.Id, r.ProductId, productName = names.GetValueOrDefault(r.ProductId, ""), r.RequirementNo, r.Title, r.Grade, r.CurrentState, versionCount = r.VersionIds.Count, customerCount = r.CustomerIds.Count, r.AssigneeId, assigneeName = r.AssigneeId == null ? null : userNames.GetValueOrDefault(r.AssigneeId, ""), r.UpdatedAt })
            .Take(1000).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    /// <summary>跨产品功能列表（含所属产品名）。</summary>
    [HttpGet("overview/features")]
    public async Task<IActionResult> OverviewFeatures([FromQuery] string? grade = null, [FromQuery] string? keyword = null, [FromQuery] bool mine = false)
    {
        var userId = GetUserId();
        var scope = await GetAccessibleProductIdsAsync(userId);
        var items = await FindInScopeAsync<Feature>(scope, f => f.ProductId, f => f.IsDeleted);
        var names = await ProductNamesAsync(items.Select(f => f.ProductId));
        var userNames = await UserNamesAsync(items.Select(f => f.AssigneeId));
        var rows = items
            .Where(f => string.IsNullOrWhiteSpace(grade) || f.Grade == grade)
            .Where(f => !mine || f.AssigneeId == userId)
            .Where(f => string.IsNullOrWhiteSpace(keyword) || (f.Title?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false) || f.FeatureNo.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(f => f.UpdatedAt)
            .Select(f => new { f.Id, f.ProductId, productName = names.GetValueOrDefault(f.ProductId, ""), f.FeatureNo, f.Title, f.Grade, f.CurrentState, requirementCount = f.RequirementIds.Count, f.AssigneeId, assigneeName = f.AssigneeId == null ? null : userNames.GetValueOrDefault(f.AssigneeId, ""), f.UpdatedAt })
            .Take(1000).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    /// <summary>跨产品缺陷列表（追溯到产品的缺陷，含所属产品名）。</summary>
    [HttpGet("overview/defects")]
    public async Task<IActionResult> OverviewDefects([FromQuery] string? status = null, [FromQuery] string? keyword = null)
    {
        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var filter = Builders<DefectReport>.Filter.And(
            Builders<DefectReport>.Filter.Eq(d => d.IsDeleted, false),
            Builders<DefectReport>.Filter.Ne(d => d.TracedProductId, (string?)null),
            scope == null ? Builders<DefectReport>.Filter.Empty : Builders<DefectReport>.Filter.In(d => d.TracedProductId, scope));
        var items = await _db.DefectReports.Find(filter).Limit(5000).ToListAsync();
        var names = await ProductNamesAsync(items.Select(d => d.TracedProductId!));
        var rows = items
            .Where(d => string.IsNullOrWhiteSpace(status) || d.Status == status)
            .Where(d => string.IsNullOrWhiteSpace(keyword) || (d.Title?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false) || d.DefectNo.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(d => d.UpdatedAt)
            .Select(d => new { d.Id, productId = d.TracedProductId, productName = names.GetValueOrDefault(d.TracedProductId ?? "", ""), d.DefectNo, d.Title, d.Status, d.Severity, d.Priority, d.TracedRequirementId, d.TracedVersionId, d.UpdatedAt })
            .Take(1000).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    /// <summary>跨产品知识库一览（所有产品/版本知识库）。</summary>
    [HttpGet("overview/knowledge")]
    public async Task<IActionResult> OverviewKnowledge()
    {
        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var products = await _db.Products.Find(scope == null
            ? Builders<Product>.Filter.Eq(p => p.IsDeleted, false)
            : Builders<Product>.Filter.And(Builders<Product>.Filter.Eq(p => p.IsDeleted, false), Builders<Product>.Filter.In(p => p.Id, scope)))
            .Limit(2000).ToListAsync();
        var storeIds = products.Where(p => !string.IsNullOrEmpty(p.KnowledgeStoreId)).Select(p => p.KnowledgeStoreId!).ToList();
        var stores = storeIds.Count == 0
            ? new List<DocumentStore>()
            : await _db.DocumentStores.Find(Builders<DocumentStore>.Filter.In(s => s.Id, storeIds)).ToListAsync();
        var storeById = stores.ToDictionary(s => s.Id, s => s);
        var rows = products.Where(p => !string.IsNullOrEmpty(p.KnowledgeStoreId) && storeById.ContainsKey(p.KnowledgeStoreId!))
            .Select(p => new { productId = p.Id, productName = p.Name, storeId = p.KnowledgeStoreId, name = storeById[p.KnowledgeStoreId!].Name, documentCount = storeById[p.KnowledgeStoreId!].DocumentCount, storeById[p.KnowledgeStoreId!].UpdatedAt })
            .ToList();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    /// <summary>跨产品总览图：全部产品/版本/需求/功能/缺陷/客户 + 全部关系（最全的公司级关系图）。</summary>
    [HttpGet("overview/graph")]
    public async Task<IActionResult> OverviewGraph()
    {
        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var products = await _db.Products.Find(scope == null
            ? Builders<Product>.Filter.Eq(p => p.IsDeleted, false)
            : Builders<Product>.Filter.And(Builders<Product>.Filter.Eq(p => p.IsDeleted, false), Builders<Product>.Filter.In(p => p.Id, scope)))
            .Limit(2000).ToListAsync();
        var versions = await FindInScopeAsync<ProductVersion>(scope, v => v.ProductId, v => v.IsDeleted);
        var requirements = await FindInScopeAsync<Requirement>(scope, r => r.ProductId, r => r.IsDeleted);
        var features = await FindInScopeAsync<Feature>(scope, f => f.ProductId, f => f.IsDeleted);
        var customers = await _db.Customers.Find(c => !c.IsDeleted).ToListAsync(); // 客户已全局化
        var featureVersions = await FindInScopeAsync<FeatureVersion>(scope, fv => fv.ProductId, fv => fv.IsDeleted);
        var defects = await _db.DefectReports.Find(Builders<DefectReport>.Filter.And(
                Builders<DefectReport>.Filter.Eq(d => d.IsDeleted, false),
                Builders<DefectReport>.Filter.Ne(d => d.TracedProductId, (string?)null),
                scope == null ? Builders<DefectReport>.Filter.Empty : Builders<DefectReport>.Filter.In(d => d.TracedProductId, scope)))
            .Limit(5000).ToListAsync();

        var nodes = new List<object>();
        var edges = new List<object>();
        void AddEdge(string s, string t, string type) => edges.Add(new { id = $"{s}->{t}:{type}", source = s, target = t, type });

        foreach (var p in products)
            nodes.Add(new { id = $"product:{p.Id}", type = "product", label = p.Name, sub = p.ProductNo, grade = (string?)p.Grade, state = p.CurrentState, productId = p.Id });
        foreach (var v in versions)
        {
            nodes.Add(new { id = $"version:{v.Id}", type = "version", label = v.VersionName, sub = v.Lifecycle, grade = (string?)null, state = v.CurrentState, productId = v.ProductId });
            AddEdge($"product:{v.ProductId}", $"version:{v.Id}", "contains");
        }
        foreach (var r in requirements)
        {
            nodes.Add(new { id = $"requirement:{r.Id}", type = "requirement", label = r.Title, sub = r.RequirementNo, grade = (string?)r.Grade, state = r.CurrentState, productId = r.ProductId });
            foreach (var vid in r.VersionIds) AddEdge($"version:{vid}", $"requirement:{r.Id}", "includes");
            foreach (var cid in r.CustomerIds) AddEdge($"requirement:{r.Id}", $"customer:{cid}", "from-customer");
        }
        foreach (var f in features)
        {
            nodes.Add(new { id = $"feature:{f.Id}", type = "feature", label = f.Title, sub = f.FeatureNo, grade = (string?)f.Grade, state = f.CurrentState, productId = f.ProductId });
            foreach (var rid in f.RequirementIds) AddEdge($"feature:{f.Id}", $"requirement:{rid}", "implements");
        }
        foreach (var c in customers)
            nodes.Add(new { id = $"customer:{c.Id}", type = "customer", label = c.Name, sub = c.Company, grade = (string?)null, state = (string?)null, productId = c.ProductId });
        foreach (var fv in featureVersions)
            AddEdge($"version:{fv.VersionId}", $"feature:{fv.FeatureId}", "feature-in-version");
        foreach (var d in defects)
        {
            nodes.Add(new { id = $"defect:{d.Id}", type = "defect", label = d.Title ?? d.DefectNo, sub = d.DefectNo, grade = (string?)d.Severity, state = d.Status, productId = d.TracedProductId });
            var any = false;
            if (!string.IsNullOrEmpty(d.TracedRequirementId)) { AddEdge($"defect:{d.Id}", $"requirement:{d.TracedRequirementId}", "traces"); any = true; }
            if (!string.IsNullOrEmpty(d.TracedFeatureId)) { AddEdge($"defect:{d.Id}", $"feature:{d.TracedFeatureId}", "traces"); any = true; }
            if (!string.IsNullOrEmpty(d.TracedVersionId)) { AddEdge($"defect:{d.Id}", $"version:{d.TracedVersionId}", "traces"); any = true; }
            if (!any && !string.IsNullOrEmpty(d.TracedProductId)) AddEdge($"defect:{d.Id}", $"product:{d.TracedProductId}", "traces");
        }

        return Ok(ApiResponse<object>.Ok(new { nodes, edges }));
    }

    /// <summary>解析某对象类型在某产品下生效的默认表单/流程 Id（产品覆盖 > 全局默认）。</summary>
    private async Task<(string? templateId, string? workflowDefId)> ResolveDefaultsAsync(string entityType, string? productId)
    {
        var templates = await _db.ProductFormTemplates.Find(Builders<ProductFormTemplate>.Filter.And(
            Builders<ProductFormTemplate>.Filter.Eq(t => t.EntityType, entityType),
            Builders<ProductFormTemplate>.Filter.Eq(t => t.IsDeleted, false),
            Builders<ProductFormTemplate>.Filter.Eq(t => t.IsDefault, true))).ToListAsync();
        var tpl = templates.FirstOrDefault(t => t.ProductId == productId) ?? templates.FirstOrDefault(t => t.ProductId == null);

        await EnsureDefaultWorkflowsSeededAsync();
        var workflows = await _db.ProductWorkflowDefinitions.Find(Builders<ProductWorkflowDefinition>.Filter.And(
            Builders<ProductWorkflowDefinition>.Filter.Eq(w => w.EntityType, entityType),
            Builders<ProductWorkflowDefinition>.Filter.Eq(w => w.IsDeleted, false),
            Builders<ProductWorkflowDefinition>.Filter.Eq(w => w.IsDefault, true))).ToListAsync();
        var wf = workflows.FirstOrDefault(w => w.ProductId == productId) ?? workflows.FirstOrDefault(w => w.ProductId == null);
        return (tpl?.Id, wf?.Id);
    }

    private async Task<List<T>> FindInScopeAsync<T>(HashSet<string>? scope, System.Linq.Expressions.Expression<Func<T, string>> productIdField, System.Linq.Expressions.Expression<Func<T, bool>> isDeletedField)
    {
        var b = Builders<T>.Filter;
        var baseFilter = b.Eq(isDeletedField, false); // 未删除
        var filter = scope == null ? baseFilter : b.And(baseFilter, b.In(productIdField, scope));
        return await ResolveCollection<T>().Find(filter).Limit(5000).ToListAsync();
    }

    private IMongoCollection<T> ResolveCollection<T>()
    {
        if (typeof(T) == typeof(ProductVersion)) return (IMongoCollection<T>)(object)_db.ProductVersions;
        if (typeof(T) == typeof(Requirement)) return (IMongoCollection<T>)(object)_db.Requirements;
        if (typeof(T) == typeof(Feature)) return (IMongoCollection<T>)(object)_db.Features;
        if (typeof(T) == typeof(FeatureVersion)) return (IMongoCollection<T>)(object)_db.FeatureVersions;
        if (typeof(T) == typeof(Customer)) return (IMongoCollection<T>)(object)_db.Customers;
        throw new InvalidOperationException($"未映射的集合类型: {typeof(T).Name}");
    }

    private async Task<Dictionary<string, string>> ProductNamesAsync(IEnumerable<string> productIds)
    {
        var ids = productIds.Where(x => !string.IsNullOrEmpty(x)).Distinct().ToList();
        if (ids.Count == 0) return new();
        var prods = await _db.Products.Find(Builders<Product>.Filter.In(p => p.Id, ids)).Project(p => new { p.Id, p.Name }).ToListAsync();
        var map = new Dictionary<string, string>();
        foreach (var p in prods) map[p.Id] = p.Name;
        return map;
    }

    /// <summary>批量解析用户显示名（UserId → DisplayName）。</summary>
    private async Task<Dictionary<string, string>> UserNamesAsync(IEnumerable<string?> userIds)
    {
        var ids = userIds.Where(x => !string.IsNullOrEmpty(x)).Select(x => x!).Distinct().ToList();
        if (ids.Count == 0) return new();
        var users = await _db.Users.Find(Builders<User>.Filter.In(u => u.UserId, ids)).Project(u => new { u.UserId, u.DisplayName }).ToListAsync();
        // 去重安全：UserId 理论唯一，但历史数据可能有重复，用覆盖而非 ToDictionary(避免重复键抛异常导致整个端点 500)
        var map = new Dictionary<string, string>();
        foreach (var u in users) if (!string.IsNullOrEmpty(u.UserId)) map[u.UserId] = u.DisplayName ?? "";
        return map;
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

    /// <summary>把流程定义 + 初始状态惰性绑定到实例（存量数据补绑）。</summary>
    private async Task BindWorkflowAsync(string entityType, string entityId, string? workflowDefId, string? currentState)
    {
        switch (entityType)
        {
            case ProductEntityType.Requirement:
                await _db.Requirements.UpdateOneAsync(x => x.Id == entityId,
                    Builders<Requirement>.Update.Set(x => x.WorkflowDefId, workflowDefId).Set(x => x.CurrentState, currentState).Set(x => x.StateEnteredAt, DateTime.UtcNow));
                break;
            case ProductEntityType.Feature:
                await _db.Features.UpdateOneAsync(x => x.Id == entityId,
                    Builders<Feature>.Update.Set(x => x.WorkflowDefId, workflowDefId).Set(x => x.CurrentState, currentState).Set(x => x.StateEnteredAt, DateTime.UtcNow));
                break;
            case ProductEntityType.Version:
                await _db.ProductVersions.UpdateOneAsync(x => x.Id == entityId,
                    Builders<ProductVersion>.Update.Set(x => x.WorkflowDefId, workflowDefId).Set(x => x.CurrentState, currentState));
                break;
            case ProductEntityType.Product:
                await _db.Products.UpdateOneAsync(x => x.Id == entityId,
                    Builders<Product>.Update.Set(x => x.WorkflowDefId, workflowDefId).Set(x => x.CurrentState, currentState));
                break;
            case ProductEntityType.UpgradeRequest:
                await _db.VersionUpgradeRequests.UpdateOneAsync(x => x.Id == entityId,
                    Builders<VersionUpgradeRequest>.Update.Set(x => x.WorkflowDefId, workflowDefId).Set(x => x.CurrentState, currentState));
                break;
        }
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

public class UpsertCategoryRequest
{
    public string? Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Color { get; set; }
    public int SortOrder { get; set; }
}

public class UpsertDescTemplateRequest
{
    public string? Id { get; set; }
    public string EntityType { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? Content { get; set; }
    public int SortOrder { get; set; }
}

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

public class AddProductMembersRequest
{
    public List<string>? UserIds { get; set; }
}

public class SetProductMemberRoleRequest
{
    public string? Role { get; set; }
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
    public string? AssigneeId { get; set; }
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

public class AiFillRequirementRequest
{
    /// <summary>用户输入的需求原始文本</summary>
    public string? Text { get; set; }
    /// <summary>生效的需求表单模板 ID（决定要填哪些自定义字段；可空）</summary>
    public string? TemplateId { get; set; }
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
    /// <summary>可选：流转时同时转交处理人（仅需求 / 功能）</summary>
    public string? AssigneeId { get; set; }
}

public class ProductCommentRequest
{
    public string Content { get; set; } = string.Empty;
    public List<string>? Mentions { get; set; }
}

public class ImportRequirementsRequest
{
    public List<ImportRequirementRow> Rows { get; set; } = new();
}

public class ImportRequirementRow
{
    public string? Title { get; set; }
    public string? Grade { get; set; }
    public string? Description { get; set; }
}

public class BatchRequest
{
    public string EntityType { get; set; } = string.Empty;
    public List<string> Ids { get; set; } = new();
    /// <summary>delete / assign / grade</summary>
    public string Op { get; set; } = string.Empty;
    public string? AssigneeId { get; set; }
    public string? Grade { get; set; }
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

public class CreateProductDefectRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Severity { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
    public string? RequirementId { get; set; }
    public string? VersionId { get; set; }
}

public class UpsertUpgradeRequestRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Reason { get; set; }
    public string? FromVersionId { get; set; }
    public string? TargetVersionId { get; set; }
    public string? TargetVersionName { get; set; }
    public List<string>? RequirementIds { get; set; }
    public List<string>? FeatureIds { get; set; }
    public List<string>? KnowledgeEntryIds { get; set; }
    public string? Status { get; set; }
    public string? TemplateId { get; set; }
    public string? WorkflowDefId { get; set; }
    public Dictionary<string, string>? FormData { get; set; }
}
