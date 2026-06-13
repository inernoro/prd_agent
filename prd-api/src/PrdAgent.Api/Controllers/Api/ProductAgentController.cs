using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;

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
    private readonly IFileContentExtractor _fileExtractor;

    public ProductAgentController(MongoDbContext db, ILogger<ProductAgentController> logger, ILlmGateway gateway, ILLMRequestContextAccessor llmRequestContext, IFileContentExtractor fileExtractor)
    {
        _db = db;
        _logger = logger;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _fileExtractor = fileExtractor;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>是否具备指定权限（super 全通过）。</summary>
    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private async Task<ProductAgentSettings?> GetProductAgentSettingsAsync()
    {
        return await _db.ProductAgentSettings
            .Find(x => x.Id == ProductAgentSettings.SingletonId)
            .FirstOrDefaultAsync();
    }

    /// <summary>
    /// 产品管理应用管理员。首次启用时由原 ProductAgentAdmin 权限持有人接管，
    /// 一旦管理员名单落库，后续完全以名单为准。
    /// </summary>
    private async Task<bool> IsProductApplicationAdminAsync(string userId)
    {
        var settings = await GetProductAgentSettingsAsync();
        return settings == null
            ? HasPermission(AdminPermissionCatalog.ProductAgentAdmin)
            : settings.AdminIds.Contains(userId);
    }

    private async Task<ProductAgentSettings?> EnsureProductAgentSettingsAsync(string userId)
    {
        var settings = await GetProductAgentSettingsAsync();
        if (settings != null) return settings;
        if (!HasPermission(AdminPermissionCatalog.ProductAgentAdmin)) return null;

        settings = new ProductAgentSettings
        {
            AdminIds = new() { userId },
            UpdatedBy = userId,
        };
        try
        {
            await _db.ProductAgentSettings.InsertOneAsync(settings);
            return settings;
        }
        catch (MongoWriteException)
        {
            return await GetProductAgentSettingsAsync();
        }
    }

    private async Task<IActionResult?> RequireProductApplicationAdminAsync()
    {
        return await IsProductApplicationAdminAsync(GetUserId())
            ? null
            : StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅产品管理应用管理员可执行此操作"));
    }

    /// <summary>查可访问的产品（owner / member / 管理权限）。无权返回 null。</summary>
    private async Task<Product?> FindAccessibleProductAsync(string productId, string userId)
    {
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null) return null;
        if (await CanManageAsync(userId)) return product;
        if (product.OwnerId == userId || product.MemberIds.Contains(userId)) return product;
        return null;
    }

    // ════════════════════════ 应用管理员 ════════════════════════

    [HttpGet("settings/admins")]
    public async Task<IActionResult> ListApplicationAdmins()
    {
        var userId = GetUserId();
        var settings = await EnsureProductAgentSettingsAsync(userId);
        var adminIds = settings?.AdminIds ?? new List<string>();
        var users = adminIds.Count == 0
            ? new List<User>()
            : await _db.Users.Find(u => adminIds.Contains(u.UserId)).ToListAsync();
        var nameById = users.ToDictionary(u => u.UserId, u => u.DisplayName);
        var usernameById = users.ToDictionary(u => u.UserId, u => u.Username);
        var items = adminIds.Select(id => new
        {
            userId = id,
            displayName = nameById.GetValueOrDefault(id, id),
            username = usernameById.GetValueOrDefault(id, string.Empty),
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new
        {
            items,
            canManage = await IsProductApplicationAdminAsync(userId),
        }));
    }

    [HttpPost("settings/admins")]
    public async Task<IActionResult> AddApplicationAdmin([FromBody] ProductApplicationAdminRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (string.IsNullOrWhiteSpace(request.UserId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择管理员"));
        var exists = await _db.Users.Find(u => u.UserId == request.UserId).AnyAsync();
        if (!exists) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "用户不存在"));

        var userId = GetUserId();
        await EnsureProductAgentSettingsAsync(userId);
        await _db.ProductAgentSettings.UpdateOneAsync(
            x => x.Id == ProductAgentSettings.SingletonId,
            Builders<ProductAgentSettings>.Update
                .AddToSet(x => x.AdminIds, request.UserId.Trim())
                .Set(x => x.UpdatedAt, DateTime.UtcNow)
                .Set(x => x.UpdatedBy, userId));
        return await ListApplicationAdmins();
    }

    [HttpDelete("settings/admins/{adminUserId}")]
    public async Task<IActionResult> RemoveApplicationAdmin(string adminUserId)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        var settings = await EnsureProductAgentSettingsAsync(GetUserId());
        if (settings == null || !settings.AdminIds.Contains(adminUserId))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "管理员不存在"));
        if (settings.AdminIds.Count <= 1)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少保留一位产品管理应用管理员"));

        await _db.ProductAgentSettings.UpdateOneAsync(
            x => x.Id == ProductAgentSettings.SingletonId,
            Builders<ProductAgentSettings>.Update
                .Pull(x => x.AdminIds, adminUserId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow)
                .Set(x => x.UpdatedBy, GetUserId()));
        return Ok(ApiResponse<object>.Ok(new { removed = true }));
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

    /// <summary>批量导入产品（应用管理员）：名称去重，已存在同名产品跳过。</summary>
    [HttpPost("products/import")]
    public async Task<IActionResult> ImportProducts([FromBody] ImportProductsRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;

        var rows = (request.Rows ?? new()).Where(r => !string.IsNullOrWhiteSpace(r.Name)).ToList();
        if (rows.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有可导入的有效行（产品名称不能为空）"));
        if (rows.Count > 500)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "单次最多导入 500 条"));

        var userId = GetUserId();
        var owner = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var defaultGrade = await ResolveGradeIdAsync(request.DefaultGrade, ProductGrade.Normal);

        var existingNames = (await _db.Products.Find(p => !p.IsDeleted).Project(p => p.Name).ToListAsync())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var seenInBatch = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var created = 0;
        var skipped = 0;
        var skippedNames = new List<string>();

        foreach (var row in rows)
        {
            var name = row.Name!.Trim();
            if (!seenInBatch.Add(name))
            {
                skipped++;
                continue;
            }
            if (existingNames.Contains(name))
            {
                skipped++;
                if (skippedNames.Count < 30) skippedNames.Add(name);
                continue;
            }

            var grade = await ResolveGradeIdAsync(row.Grade, defaultGrade);
            var product = new Product
            {
                ProductNo = await GenerateNoAsync("PRD", _db.Products, "ProductNo"),
                Name = name,
                Code = row.Code?.Trim(),
                Description = row.Description?.Trim(),
                Grade = grade,
                OwnerId = userId,
                OwnerName = owner?.DisplayName,
                MemberIds = new List<string> { userId },
            };
            product.CurrentState = await ResolveInitialStateAsync(null);

            await _db.Products.InsertOneAsync(product);
            existingNames.Add(name);
            created++;
        }

        _logger.LogInformation("[product-agent] Products imported: created={Created}, skipped={Skipped} by {User}", created, skipped, userId);
        return Ok(ApiResponse<object>.Ok(new { created, skipped, skippedNames }));
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
        if (!await CanManageAsync(userId))
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
        if (product.OwnerId != userId && !await CanManageAsync(userId))
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
            canManageMembers = await CanManageProductMembersAsync(product, userId),
            canManageAdmins = await CanManageProductAdminsAsync(product, userId),
        }));
    }

    /// <summary>添加团队成员（批量）。需产品成员管理权限。</summary>
    [HttpPost("products/{productId}/members")]
    public async Task<IActionResult> AddProductMembers(string productId, [FromBody] AddProductMembersRequest request)
    {
        var userId = GetUserId();
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        if (!await CanManageProductMembersAsync(product, userId))
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
        var allowed = isAdminTarget
            ? await CanManageProductAdminsAsync(product, userId)
            : await CanManageProductMembersAsync(product, userId);
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
        if (!await CanManageProductAdminsAsync(product, userId))
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

    // Product committee workflow: initiation (T code) and release (V code).
    [HttpGet("products/{productId}/initiations")]
    public async Task<IActionResult> ListInitiations(string productId, [FromQuery] string scope = "mine")
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        FilterDefinition<ProductInitiation> filter = Builders<ProductInitiation>.Filter.Where(x => x.ProductId == productId && !x.IsDeleted);
        if (!string.Equals(scope, "all", StringComparison.OrdinalIgnoreCase))
            filter &= Builders<ProductInitiation>.Filter.Eq(x => x.CreatedBy, userId);
        var items = await _db.ProductInitiations.Find(filter)
            .SortByDescending(x => x.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpGet("initiations/{id}")]
    public async Task<IActionResult> GetInitiation(string id)
    {
        var item = await _db.ProductInitiations.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "立项记录不存在或无权访问"));
        return Ok(ApiResponse<object>.Ok(item));
    }

    [HttpPost("products/{productId}/initiations")]
    public async Task<IActionResult> CreateInitiation(string productId, [FromBody] CreateInitiationRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.PlanName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方案名称不能为空"));
        if (request.ProjectType == "custom" && string.IsNullOrWhiteSpace(request.CustomerSource))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "定制项目必须填写客户来源"));

        var item = new ProductInitiation
        {
            ProductId = productId,
            ProjectType = request.ProjectType == "custom" ? "custom" : "standard",
            SystemName = request.SystemName?.Trim(),
            AppName = request.AppName?.Trim(),
            CustomerSource = request.CustomerSource?.Trim(),
            PlanName = request.PlanName.Trim(),
            RequirementDescription = request.RequirementDescription?.Trim(),
            DepartmentName = request.DepartmentName?.Trim(),
            PlanUrl = request.PlanUrl?.Trim(),
            VersionType = NormalizeVersionType(request.VersionType),
            RequirementIds = request.RequirementIds?.Distinct().ToList() ?? new(),
            Status = "review_pending",
            CreatedBy = userId,
        };
        await _db.ProductInitiations.InsertOneAsync(item);
        return Ok(ApiResponse<object>.Ok(item));
    }

    [HttpPost("initiations/{id}/review")]
    public async Task<IActionResult> SyncInitiationReview(string id, [FromBody] SyncInitiationReviewRequest request)
    {
        var item = await _db.ProductInitiations.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "立项记录不存在或无权访问"));
        if (item.CreatedBy != GetUserId() && !await CanManageAsync(GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅申请人可更新该立项记录"));
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == request.SubmissionId).FirstOrDefaultAsync();
        if (submission == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "评审任务不存在"));

        ReviewResult? result = null;
        if (!string.IsNullOrWhiteSpace(submission.ResultId))
            result = await _db.ReviewResults.Find(x => x.Id == submission.ResultId).FirstOrDefaultAsync();
        var passed = result?.IsPassed ?? submission.IsPassed;
        var status = submission.Status == ReviewStatuses.Done
            ? (passed == true ? "decision_pending" : "review_failed")
            : "review_pending";
        await _db.ProductInitiations.UpdateOneAsync(x => x.Id == id,
            Builders<ProductInitiation>.Update
                .Set(x => x.ReviewSubmissionId, submission.Id)
                .Set(x => x.ReviewScore, result == null ? null : result.TotalScore)
                .Set(x => x.ReviewPassed, passed)
                .Set(x => x.Status, status)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
        var updated = await _db.ProductInitiations.Find(x => x.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    [HttpPost("initiations/{id}/decision")]
    public async Task<IActionResult> DecideInitiation(string id, [FromBody] InitiationDecisionRequest request)
    {
        var item = await _db.ProductInitiations.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "立项记录不存在或无权访问"));
        if (item.CreatedBy != GetUserId() && !await CanManageAsync(GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅申请人可提交该立项决策"));
        if (item.ReviewPassed != true)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "Agent 评审通过后才能提交立项决策"));

        if (request.ReviewMeetingRequired && !request.ExpectedMeetingAt.HasValue)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请填写预计评审会时间"));
        if (!request.ReviewMeetingRequired && string.IsNullOrWhiteSpace(request.PrimaryOwnerId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择产品主负责人"));

        var tCode = request.ReviewMeetingRequired ? await GenerateWorkflowCodeAsync(item.ProductId, "T", item.VersionType) : null;
        await _db.ProductInitiations.UpdateOneAsync(x => x.Id == id,
            Builders<ProductInitiation>.Update
                .Set(x => x.ReviewMeetingRequired, request.ReviewMeetingRequired)
                .Set(x => x.ExpectedMeetingAt, request.ExpectedMeetingAt)
                .Set(x => x.PrimaryOwnerId, request.PrimaryOwnerId)
                .Set(x => x.TCode, tCode)
                .Set(x => x.Status, request.ReviewMeetingRequired ? "approved" : "owner_pending")
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
        var updated = await _db.ProductInitiations.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (request.ReviewMeetingRequired)
            await AdvanceRequirementsToStateAsync(item.ProductId, item.RequirementIds, RequirementWorkflowCatalog.Approved, GetUserId(), "立项评审通过，自动流转到已立项");
        return Ok(ApiResponse<object>.Ok(updated));
    }

    [HttpPost("initiations/{id}/approve")]
    public async Task<IActionResult> ApproveInitiation(string id, [FromBody] ApproveInitiationRequest request)
    {
        var item = await _db.ProductInitiations.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "立项记录不存在或无权访问"));
        if (item.Status != "owner_pending")
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "当前记录不在负责人审批状态"));
        if (item.PrimaryOwnerId != GetUserId() && !await CanManageAsync(GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅产品主负责人可审批"));

        var tCode = await GenerateWorkflowCodeAsync(item.ProductId, "T", item.VersionType);
        await _db.ProductInitiations.UpdateOneAsync(x => x.Id == id,
            Builders<ProductInitiation>.Update
                .Set(x => x.TCode, tCode)
                .Set(x => x.Status, "approved")
                .Set(x => x.ApprovalComment, request.Comment?.Trim())
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
        var updated = await _db.ProductInitiations.Find(x => x.Id == id).FirstOrDefaultAsync();
        await AdvanceRequirementsToStateAsync(item.ProductId, item.RequirementIds, RequirementWorkflowCatalog.Approved, GetUserId(), "立项负责人审批通过，自动流转到已立项");
        return Ok(ApiResponse<object>.Ok(updated));
    }

    [HttpGet("products/{productId}/releases")]
    public async Task<IActionResult> ListReleases(
        string productId,
        [FromQuery] string scope = "mine",
        [FromQuery] string? ownerId = null)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        FilterDefinition<ProductRelease> filter = Builders<ProductRelease>.Filter.Where(x => x.ProductId == productId && !x.IsDeleted);
        if (!string.IsNullOrWhiteSpace(ownerId))
            filter &= Builders<ProductRelease>.Filter.Eq(x => x.OwnerId, ownerId);
        else if (!string.Equals(scope, "all", StringComparison.OrdinalIgnoreCase))
            filter &= Builders<ProductRelease>.Filter.Eq(x => x.OwnerId, userId);
        var items = await _db.ProductReleases.Find(filter)
            .SortByDescending(x => x.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpGet("products/{productId}/releases/inherit-manifest")]
    public async Task<IActionResult> GetInheritReleaseManifest(string productId)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var previous = await FindLatestReleaseWithManifestAsync(productId);
        if (previous == null)
            return Ok(ApiResponse<object>.Ok(new { previousReleaseId = (string?)null, items = Array.Empty<ReleaseFeatureItem>() }));
        var items = previous.FeatureManifest
            .Where(x => !string.Equals(x.ChangeType, FeatureChangeType.Deprecated, StringComparison.Ordinal))
            .Select(x => new ReleaseFeatureItem
            {
                FeatureId = x.FeatureId,
                ChangeType = FeatureChangeType.Unchanged,
                ChangeNote = null,
            })
            .ToList();
        return Ok(ApiResponse<object>.Ok(new { previousReleaseId = previous.Id, previousVCode = previous.VCode, items }));
    }

    [HttpGet("releases/{id}")]
    public async Task<IActionResult> GetRelease(string id)
    {
        var item = await _db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上线记录不存在或无权访问"));
        return Ok(ApiResponse<object>.Ok(item));
    }

    [HttpPut("releases/{id}/feature-manifest")]
    public async Task<IActionResult> UpdateReleaseFeatureManifest(string id, [FromBody] UpdateReleaseFeatureManifestRequest request)
    {
        var item = await _db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上线记录不存在或无权访问"));
        if (item.Status == "released")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已上线版本的功能清单不可修改"));
        var manifest = NormalizeReleaseFeatureManifest(request.FeatureManifest ?? new());
        if (manifest.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "功能清单不能为空"));
        var manifestError = await ValidateReleaseFeatureManifestAsync(item.ProductId, manifest);
        if (manifestError != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, manifestError));
        await _db.ProductReleases.UpdateOneAsync(x => x.Id == id,
            Builders<ProductRelease>.Update
                .Set(x => x.FeatureManifest, manifest)
                .Set(x => x.PreviousReleaseId, request.PreviousReleaseId ?? item.PreviousReleaseId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
        var updated = await _db.ProductReleases.Find(x => x.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    [HttpPost("products/{productId}/releases")]
    public async Task<IActionResult> CreateRelease(string productId, [FromBody] CreateReleaseRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        ProductInitiation? initiation = null;
        if (!request.IsTemporaryOptimization)
        {
            initiation = await _db.ProductInitiations.Find(x => x.Id == request.InitiationId && x.ProductId == productId && x.Status == "approved" && !x.IsDeleted).FirstOrDefaultAsync();
            if (initiation == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择已通过并取得 T 号的立项"));
            var existing = await _db.ProductReleases.Find(x => x.InitiationId == initiation.Id && !x.IsDeleted).FirstOrDefaultAsync();
            if (existing != null)
                return BadRequest(ApiResponse<object>.Fail("DUPLICATE_RELEASE", $"该立项已申领上线号 {existing.VCode}"));
        }
        if (request.TeamMemberIds == null || request.TeamMemberIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "项目组成员不能为空"));
        if (!request.PlannedReleaseAt.HasValue)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "上线时间不能为空"));
        if (string.IsNullOrWhiteSpace(request.OwnerId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "产品负责人（申领人）不能为空"));
        var ownerExists = await _db.Users.Find(x => x.UserId == request.OwnerId).AnyAsync();
        if (!ownerExists)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "所选产品负责人不存在"));

        var versionType = request.IsTemporaryOptimization ? "minor" : initiation!.VersionType;
        var vCode = initiation?.TCode?.Replace("T", "V", StringComparison.OrdinalIgnoreCase)
            ?? await GenerateWorkflowCodeAsync(productId, "V", versionType);
        var previousRelease = await FindLatestReleaseWithManifestAsync(productId);
        var manifest = await ResolveReleaseFeatureManifestAsync(productId, request.FeatureManifest, previousRelease);
        if (manifest.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "功能清单不能为空，请至少纳入一项功能"));
        var manifestError = await ValidateReleaseFeatureManifestAsync(productId, manifest);
        if (manifestError != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, manifestError));
        var item = new ProductRelease
        {
            ProductId = productId,
            InitiationId = initiation?.Id,
            TCode = initiation?.TCode,
            VCode = vCode,
            IsTemporaryOptimization = request.IsTemporaryOptimization,
            PlanName = request.IsTemporaryOptimization ? request.PlanName?.Trim() ?? "临时优化需求" : initiation!.PlanName,
            VersionType = versionType,
            SystemName = initiation?.SystemName,
            AppName = initiation?.AppName,
            ProjectType = initiation?.ProjectType ?? "standard",
            PlanUrl = initiation?.PlanUrl,
            DepartmentName = initiation?.DepartmentName,
            OwnerId = request.OwnerId,
            OpenBrandScope = string.IsNullOrWhiteSpace(request.OpenBrandScope) ? "上线全域开放" : request.OpenBrandScope.Trim(),
            RequirementIds = (initiation?.RequirementIds ?? new()).Concat(request.AdditionalRequirementIds ?? new()).Distinct().ToList(),
            TeamMemberIds = request.TeamMemberIds.Distinct().ToList(),
            PlannedReleaseAt = request.PlannedReleaseAt,
            PreviousReleaseId = request.PreviousReleaseId ?? previousRelease?.Id,
            FeatureManifest = manifest,
            Status = "announcement_pending",
            CreatedBy = userId,
        };
        await _db.ProductReleases.InsertOneAsync(item);
        return Ok(ApiResponse<object>.Ok(item));
    }

    [HttpPost("releases/{id}/complete")]
    public async Task<IActionResult> CompleteRelease(string id, [FromBody] CompleteReleaseRequest request)
    {
        var item = await _db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上线记录不存在或无权访问"));
        if (item.OwnerId != GetUserId() && !await CanManageAsync(GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅申请人可完成该上线记录"));
        if (string.IsNullOrWhiteSpace(request.AnnouncementUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "上线公告地址不能为空"));
        await _db.ProductReleases.UpdateOneAsync(x => x.Id == id,
            Builders<ProductRelease>.Update
                .Set(x => x.AnnouncementUrl, request.AnnouncementUrl.Trim())
                .Set(x => x.Status, "released")
                .Set(x => x.ReleasedAt, DateTime.UtcNow)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
        var updated = await _db.ProductReleases.Find(x => x.Id == id).FirstOrDefaultAsync();
        await AdvanceRequirementsToStateAsync(item.ProductId, item.RequirementIds, RequirementWorkflowCatalog.Released, GetUserId(), $"上线完成（{updated?.VCode}），自动流转到已上线");
        return Ok(ApiResponse<object>.Ok(updated));
    }

    [HttpPost("products/{productId}/version-workflow/import")]
    public async Task<IActionResult> ImportVersionWorkflow(string productId, [FromBody] ImportVersionWorkflowRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var errors = new List<object>();
        var created = 0;
        for (var index = 0; index < request.Rows.Count; index++)
        {
            var row = request.Rows[index];
            if (string.IsNullOrWhiteSpace(row.PlanName))
            {
                errors.Add(new { row = index + 2, message = "方案名称不能为空" });
                continue;
            }
            if (request.Kind == "release")
            {
                if (string.IsNullOrWhiteSpace(row.Code))
                {
                    errors.Add(new { row = index + 2, message = "上线历史数据必须有 V 号" });
                    continue;
                }
                await _db.ProductReleases.InsertOneAsync(new ProductRelease
                {
                    ProductId = productId, TCode = row.TCode, VCode = row.Code.Trim(), PlanName = row.PlanName.Trim(),
                    VersionType = NormalizeVersionType(row.VersionType), AnnouncementUrl = row.AnnouncementUrl,
                    SystemName = row.SystemName, AppName = row.AppName,
                    ProjectType = row.ProjectType == "custom" ? "custom" : "standard",
                    DepartmentName = row.DepartmentName, OwnerId = row.OwnerId,
                    OpenBrandScope = string.IsNullOrWhiteSpace(row.OpenBrandScope) ? "上线全域开放" : row.OpenBrandScope,
                    PlanUrl = row.PlanUrl, TeamMemberIds = row.TeamMemberIds ?? new(),
                    Status = string.IsNullOrWhiteSpace(row.AnnouncementUrl) ? "announcement_pending" : "released",
                    PlannedReleaseAt = row.Date, ReleasedAt = row.Date, CreatedBy = userId, SourceType = "import",
                    LegacyData = row.LegacyData ?? new(),
                });
            }
            else
            {
                await _db.ProductInitiations.InsertOneAsync(new ProductInitiation
                {
                    ProductId = productId, TCode = row.Code?.Trim(), PlanName = row.PlanName.Trim(),
                    VersionType = NormalizeVersionType(row.VersionType), PlanUrl = row.PlanUrl,
                    SystemName = row.SystemName, AppName = row.AppName,
                    ProjectType = row.ProjectType == "custom" ? "custom" : "standard", CustomerSource = row.CustomerSource,
                    RequirementDescription = row.RequirementDescription, DepartmentName = row.DepartmentName,
                    PrimaryOwnerId = row.OwnerId, FirstDraftMeetingAt = row.FirstDraftMeetingAt,
                    SecondDraftMeetingAt = row.SecondDraftMeetingAt, ThirdDraftMeetingAt = row.ThirdDraftMeetingAt,
                    ProjectAt = row.ProjectAt, PlannedProjectAt = row.PlannedProjectAt,
                    NeedUiDesign = row.NeedUiDesign, IsAiPoc = row.IsAiPoc,
                    DevelopmentStatus = string.IsNullOrWhiteSpace(row.DevelopmentStatus) ? "待开发" : row.DevelopmentStatus,
                    Remark = row.Remark,
                    Status = string.IsNullOrWhiteSpace(row.Code) ? "draft" : "approved", CreatedBy = userId,
                    SourceType = "import", LegacyData = row.LegacyData ?? new(),
                });
            }
            created++;
        }
        return Ok(ApiResponse<object>.Ok(new { created, errors }));
    }

    // ════════════════════════ 需求 Requirement ════════════════════════

    /// <summary>需求列表（按产品，可按版本 / 客户过滤）</summary>
    [HttpGet("products/{productId}/requirements")]
    public async Task<IActionResult> ListRequirements(
        string productId,
        [FromQuery] string? versionId = null,
        [FromQuery] string? customerId = null,
        [FromQuery] string? grade = null,
        [FromQuery] bool mine = false)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<Requirement>.Filter;
        var conds = new List<FilterDefinition<Requirement>> { b.Eq(r => r.ProductId, productId), b.Eq(r => r.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(versionId)) conds.Add(b.AnyEq(r => r.VersionIds, versionId));
        if (!string.IsNullOrWhiteSpace(customerId)) conds.Add(b.AnyEq(r => r.CustomerIds, customerId));
        if (!string.IsNullOrWhiteSpace(grade) && ProductItemGrade.All.Contains(grade)) conds.Add(b.Eq(r => r.Grade, grade));
        if (mine)
        {
            var userId = GetUserId();
            conds.Add(b.Or(b.Eq(r => r.AssigneeId, userId), b.Eq(r => r.OwnerId, userId)));
        }
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
            RequirementNo = await GenerateNextTapdStyleRequirementIdAsync(productId),
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
        var validation = await ValidateFeatureRequestAsync(productId, request, requireAll: true);
        if (validation != null) return validation;
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
            ModuleName = request.ModuleName!.Trim(),
            FeatureType = request.FeatureType!,
            MainRequirementId = request.MainRequirementId!,
            PlannedVersionId = request.PlannedVersionId!,
            OfficialReleaseId = request.OfficialReleaseId,
            KeyRules = request.KeyRules!.Trim(),
            AcceptanceCriteria = request.AcceptanceCriteria!.Trim(),
            Remark = request.Remark?.Trim(),
            Grade = string.IsNullOrWhiteSpace(request.Grade) ? ProductItemGrade.P2 : request.Grade,
            ParentId = request.ParentId,
            RequirementIds = MergeMainRequirement(request.MainRequirementId!, request.RequirementIds),
            TemplateId = request.TemplateId,
            WorkflowDefId = featWorkflowDefId,
            FormData = request.FormData ?? new(),
            OwnerId = request.OwnerId!,
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
        var validation = await ValidateFeatureRequestAsync(feature.ProductId, request, requireAll: true);
        if (validation != null) return validation;
        if (!string.IsNullOrWhiteSpace(request.Grade) && !ProductItemGrade.All.Contains(request.Grade))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的功能分级"));

        var u = Builders<Feature>.Update.Set(f => f.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.Title)) u = u.Set(f => f.Title, request.Title.Trim());
        u = u.Set(f => f.Description, request.Description?.Trim());
        u = u.Set(f => f.ModuleName, request.ModuleName!.Trim());
        u = u.Set(f => f.FeatureType, request.FeatureType!);
        u = u.Set(f => f.MainRequirementId, request.MainRequirementId!);
        u = u.Set(f => f.PlannedVersionId, request.PlannedVersionId!);
        u = u.Set(f => f.OfficialReleaseId, request.OfficialReleaseId);
        u = u.Set(f => f.KeyRules, request.KeyRules!.Trim());
        u = u.Set(f => f.AcceptanceCriteria, request.AcceptanceCriteria!.Trim());
        u = u.Set(f => f.Remark, request.Remark?.Trim());
        u = u.Set(f => f.OwnerId, request.OwnerId!);
        if (!string.IsNullOrWhiteSpace(request.Grade)) u = u.Set(f => f.Grade, request.Grade);
        if (request.ParentId != null) u = u.Set(f => f.ParentId, request.ParentId);
        u = u.Set(f => f.RequirementIds, MergeMainRequirement(request.MainRequirementId!, request.RequirementIds));
        if (request.AssigneeId != null) u = u.Set(f => f.AssigneeId, request.AssigneeId);
        if (request.FormData != null) u = u.Set(f => f.FormData, request.FormData);
        await _db.Features.UpdateOneAsync(f => f.Id == featureId, u);
        await RecordAssignChangeAsync(ProductEntityType.Feature, featureId, feature.ProductId, feature.AssigneeId, request.AssigneeId, feature.FeatureNo, feature.Title);
        var updated = await _db.Features.Find(f => f.Id == featureId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    private async Task<IActionResult?> ValidateFeatureRequestAsync(string productId, UpsertFeatureRequest request, bool requireAll)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "功能名称不能为空"));
        if (requireAll && string.IsNullOrWhiteSpace(request.Description))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "功能说明不能为空"));
        if (requireAll && string.IsNullOrWhiteSpace(request.ModuleName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "所属功能模块不能为空"));
        if (string.IsNullOrWhiteSpace(request.FeatureType) || !FeatureBusinessType.All.Contains(request.FeatureType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择有效的功能类型"));
        if (string.IsNullOrWhiteSpace(request.MainRequirementId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择主需求"));
        if (string.IsNullOrWhiteSpace(request.PlannedVersionId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择计划版本"));
        if (string.IsNullOrWhiteSpace(request.OwnerId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择负责人"));
        if (requireAll && string.IsNullOrWhiteSpace(request.KeyRules))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "关键规则不能为空"));
        if (requireAll && string.IsNullOrWhiteSpace(request.AcceptanceCriteria))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "验收标准不能为空"));

        if (!await _db.Requirements.Find(r => r.Id == request.MainRequirementId && r.ProductId == productId && !r.IsDeleted).AnyAsync())
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "主需求不属于当前产品或已删除"));
        if (!await _db.ProductVersions.Find(v => v.Id == request.PlannedVersionId && v.ProductId == productId && !v.IsDeleted).AnyAsync())
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "计划版本不属于当前产品或已删除"));
        if (!string.IsNullOrWhiteSpace(request.OfficialReleaseId)
            && !await _db.ProductReleases.Find(r => r.Id == request.OfficialReleaseId && r.ProductId == productId && !r.IsDeleted).AnyAsync())
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "正式上线版本不属于当前产品或已删除"));
        return null;
    }

    private static List<string> MergeMainRequirement(string mainRequirementId, List<string>? requirementIds)
    {
        var result = (requirementIds ?? new List<string>())
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct()
            .ToList();
        if (!result.Contains(mainRequirementId)) result.Insert(0, mainRequirementId);
        return result;
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
        if (customer.OwnerId != GetUserId() && !await CanManageAsync(GetUserId()))
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

    /// <summary>解析产品类型：支持 Id 或名称；未匹配时返回 fallback。</summary>
    private async Task<string> ResolveGradeIdAsync(string? gradeInput, string fallback)
    {
        await EnsureCategoriesSeededAsync();
        if (string.IsNullOrWhiteSpace(gradeInput)) return fallback;
        var trimmed = gradeInput.Trim();
        var byId = await _db.ProductCategories.Find(c => c.Id == trimmed && !c.IsDeleted).FirstOrDefaultAsync();
        if (byId != null) return byId.Id;
        var byName = await _db.ProductCategories.Find(c => c.Name == trimmed && !c.IsDeleted).FirstOrDefaultAsync();
        return byName?.Id ?? fallback;
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
        if (!await CanManageAsync(GetUserId()))
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
        if (!await CanManageAsync(GetUserId()))
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

    // ════════════════════════ 需求类型 RequirementType ════════════════════════

    private async Task EnsureRequirementTypesSeededAsync()
    {
        var existingIds = (await _db.RequirementTypes.Find(_ => true).Project(t => t.Id).ToListAsync())
            .ToHashSet();
        var missing = RequirementType.BuiltinSeeds.Where(s => !existingIds.Contains(s.Id)).ToList();
        if (missing.Count > 0)
            await _db.RequirementTypes.InsertManyAsync(missing);
    }

    /// <summary>需求类型列表（首次访问自动补齐内置 5 项）。</summary>
    [HttpGet("requirement-types")]
    public async Task<IActionResult> ListRequirementTypes()
    {
        await EnsureRequirementTypesSeededAsync();
        var items = await _db.RequirementTypes.Find(t => !t.IsDeleted)
            .SortBy(t => t.SortOrder).ThenBy(t => t.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建 / 更新需求类型（需管理权限）。带 id 为更新。</summary>
    [HttpPost("requirement-types")]
    public async Task<IActionResult> UpsertRequirementType([FromBody] UpsertRequirementTypeRequest request)
    {
        if (!await CanManageAsync(GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "类型名称不能为空"));
        await EnsureRequirementTypesSeededAsync();
        var name = request.Name.Trim();
        var definition = (request.Definition ?? "").Trim();

        if (!string.IsNullOrWhiteSpace(request.Id))
        {
            var existing = await _db.RequirementTypes.Find(t => t.Id == request.Id && !t.IsDeleted).FirstOrDefaultAsync();
            if (existing == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "需求类型不存在"));
            var nameConflict = await _db.RequirementTypes.Find(t => t.Name == name && t.Id != request.Id && !t.IsDeleted).AnyAsync();
            if (nameConflict)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已存在同名需求类型"));
            var oldName = existing.Name;
            var u = Builders<RequirementType>.Update
                .Set(t => t.Name, name)
                .Set(t => t.Definition, definition)
                .Set(t => t.SortOrder, request.SortOrder)
                .Set(t => t.UpdatedAt, DateTime.UtcNow);
            await _db.RequirementTypes.UpdateOneAsync(t => t.Id == request.Id, u);
            if (!string.Equals(oldName, name, StringComparison.Ordinal))
            {
                await _db.Requirements.UpdateManyAsync(
                    r => r.FormData != null && r.FormData.ContainsKey(RequirementType.FormDataKey) && r.FormData[RequirementType.FormDataKey] == oldName,
                    Builders<Requirement>.Update.Set($"FormData.{RequirementType.FormDataKey}", name));
            }
            var updated = await _db.RequirementTypes.Find(t => t.Id == request.Id).FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(updated));
        }

        var nameExists = await _db.RequirementTypes.Find(t => t.Name == name && !t.IsDeleted).AnyAsync();
        if (nameExists)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已存在同名需求类型"));
        var maxOrder = (await _db.RequirementTypes.Find(t => !t.IsDeleted).SortByDescending(t => t.SortOrder)
            .FirstOrDefaultAsync())?.SortOrder ?? -1;
        var item = new RequirementType
        {
            Name = name,
            Definition = definition,
            SortOrder = request.SortOrder > 0 ? request.SortOrder : maxOrder + 1,
            IsBuiltin = false,
        };
        await _db.RequirementTypes.InsertOneAsync(item);
        return Ok(ApiResponse<object>.Ok(item));
    }

    /// <summary>删除需求类型（软删除，需管理权限）。内置项 / 被需求占用时禁止删除。</summary>
    [HttpDelete("requirement-types/{typeId}")]
    public async Task<IActionResult> DeleteRequirementType(string typeId)
    {
        if (!await CanManageAsync(GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要产品管理-管理权限"));
        var item = await _db.RequirementTypes.Find(t => t.Id == typeId && !t.IsDeleted).FirstOrDefaultAsync();
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "需求类型不存在"));
        if (item.IsBuiltin)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "内置类型不可删除，可修改名称与定义"));
        var inUse = await _db.Requirements.CountDocumentsAsync(
            r => r.FormData != null && r.FormData.ContainsKey(RequirementType.FormDataKey) && r.FormData[RequirementType.FormDataKey] == item.Name);
        if (inUse > 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"该类型正被 {inUse} 条需求使用，无法删除"));
        await _db.RequirementTypes.UpdateOneAsync(t => t.Id == typeId,
            Builders<RequirementType>.Update.Set(t => t.IsDeleted, true).Set(t => t.UpdatedAt, DateTime.UtcNow));
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
        if (!await CanManageAsync(GetUserId()))
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
        if (!await CanManageAsync(GetUserId()))
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
        if (!await CanManageAsync(GetUserId()))
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
        if (!await CanManageAsync(GetUserId()))
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
        var reqDef = ProductWorkflowDefaults.Requirement();
        var existingReq = await _db.ProductWorkflowDefinitions
            .Find(w => w.Id == ProductWorkflowDefaults.RequirementDefId && !w.IsDeleted)
            .FirstOrDefaultAsync();
        if (existingReq == null)
        {
            reqDef.SeedRevision = ProductWorkflowDefaults.RequirementWorkflowRevision;
            reqDef.IsUserCustomized = false;
            await _db.ProductWorkflowDefinitions.InsertOneAsync(reqDef);
        }
        else if (!existingReq.IsUserCustomized
                 && existingReq.SeedRevision < ProductWorkflowDefaults.RequirementWorkflowRevision)
        {
            await _db.ProductWorkflowDefinitions.UpdateOneAsync(
                w => w.Id == reqDef.Id,
                Builders<ProductWorkflowDefinition>.Update
                    .Set(w => w.Name, reqDef.Name)
                    .Set(w => w.Description, reqDef.Description)
                    .Set(w => w.States, reqDef.States)
                    .Set(w => w.Transitions, reqDef.Transitions)
                    .Set(w => w.SeedRevision, ProductWorkflowDefaults.RequirementWorkflowRevision)
                    .Set(w => w.UpdatedAt, DateTime.UtcNow));
        }

        var featDef = ProductWorkflowDefaults.Feature();
        var existingFeat = await _db.ProductWorkflowDefinitions
            .Find(w => w.Id == ProductWorkflowDefaults.FeatureDefId && !w.IsDeleted)
            .FirstOrDefaultAsync();
        if (existingFeat == null)
        {
            featDef.SeedRevision = ProductWorkflowDefaults.FeatureWorkflowRevision;
            featDef.IsUserCustomized = false;
            await _db.ProductWorkflowDefinitions.InsertOneAsync(featDef);
        }
        else if (!existingFeat.IsUserCustomized
                 && existingFeat.SeedRevision < ProductWorkflowDefaults.FeatureWorkflowRevision)
        {
            await _db.ProductWorkflowDefinitions.UpdateOneAsync(
                w => w.Id == featDef.Id,
                Builders<ProductWorkflowDefinition>.Update
                    .Set(w => w.Name, featDef.Name)
                    .Set(w => w.Description, featDef.Description)
                    .Set(w => w.States, featDef.States)
                    .Set(w => w.Transitions, featDef.Transitions)
                    .Set(w => w.SeedRevision, ProductWorkflowDefaults.FeatureWorkflowRevision)
                    .Set(w => w.UpdatedAt, DateTime.UtcNow));
        }

        var defectDef = ProductWorkflowDefaults.Defect();
        var existingDefect = await _db.ProductWorkflowDefinitions
            .Find(w => w.Id == ProductWorkflowDefaults.DefectDefId && !w.IsDeleted)
            .FirstOrDefaultAsync();
        if (existingDefect == null)
        {
            defectDef.SeedRevision = ProductWorkflowDefaults.DefectWorkflowRevision;
            defectDef.IsUserCustomized = false;
            await _db.ProductWorkflowDefinitions.InsertOneAsync(defectDef);
        }
        else if (!existingDefect.IsUserCustomized
                 && existingDefect.SeedRevision < ProductWorkflowDefaults.DefectWorkflowRevision)
        {
            await _db.ProductWorkflowDefinitions.UpdateOneAsync(
                w => w.Id == defectDef.Id,
                Builders<ProductWorkflowDefinition>.Update
                    .Set(w => w.Name, defectDef.Name)
                    .Set(w => w.Description, defectDef.Description)
                    .Set(w => w.States, defectDef.States)
                    .Set(w => w.Transitions, defectDef.Transitions)
                    .Set(w => w.SeedRevision, ProductWorkflowDefaults.DefectWorkflowRevision)
                    .Set(w => w.UpdatedAt, DateTime.UtcNow));
        }

        var seedIds = new[] { ProductWorkflowDefaults.DefectDefId };
        var existingIds = (await _db.ProductWorkflowDefinitions
            .Find(Builders<ProductWorkflowDefinition>.Filter.In(w => w.Id, seedIds))
            .Project(w => w.Id).ToListAsync()).ToHashSet();
        var missingBuiltin = ProductWorkflowDefaults.All()
            .Where(w => w.Id is not (ProductWorkflowDefaults.RequirementDefId or ProductWorkflowDefaults.FeatureDefId)
                         && !existingIds.Contains(w.Id))
            .ToList();
        if (missingBuiltin.Count > 0)
            await _db.ProductWorkflowDefinitions.InsertManyAsync(missingBuiltin);

        await MigrateLegacyRequirementStatesAsync();
        await MigrateLegacyFeatureStatesAsync();
        await MigrateLegacyProductDefectStatesAsync();
    }

    /// <summary>将旧版 MAP 需求状态 Key 迁移为当前内置 Key（幂等）。</summary>
    private async Task MigrateLegacyRequirementStatesAsync()
    {
        foreach (var (legacy, modern) in RequirementWorkflowCatalog.LegacyStateMap)
        {
            if (legacy == modern) continue;
            await _db.Requirements.UpdateManyAsync(
                r => r.CurrentState == legacy && !r.IsDeleted,
                Builders<Requirement>.Update.Set(r => r.CurrentState, modern).Set(r => r.UpdatedAt, DateTime.UtcNow));
        }

        var distinctStates = await _db.Requirements.Find(r => !r.IsDeleted && r.CurrentState != null)
            .Project(r => r.CurrentState).ToListAsync();
        foreach (var state in distinctStates.Where(s => !string.IsNullOrWhiteSpace(s)).Distinct())
        {
            var normalized = RequirementWorkflowCatalog.NormalizeStateKey(state);
            if (normalized == state) continue;
            await _db.Requirements.UpdateManyAsync(
                r => r.CurrentState == state && !r.IsDeleted,
                Builders<Requirement>.Update.Set(r => r.CurrentState, normalized).Set(r => r.UpdatedAt, DateTime.UtcNow));
        }
    }

    /// <summary>将旧版功能流程状态 Key 迁移为与需求对齐的 Key（幂等）。</summary>
    private async Task MigrateLegacyFeatureStatesAsync()
    {
        foreach (var (legacy, modern) in FeatureWorkflowCatalog.LegacyStateMap)
        {
            if (legacy == modern) continue;
            await _db.Features.UpdateManyAsync(
                f => f.CurrentState == legacy && !f.IsDeleted,
                Builders<Feature>.Update.Set(f => f.CurrentState, modern).Set(f => f.UpdatedAt, DateTime.UtcNow));
        }

        var distinctStates = await _db.Features.Find(f => !f.IsDeleted && f.CurrentState != null)
            .Project(f => f.CurrentState).ToListAsync();
        foreach (var state in distinctStates.Where(s => !string.IsNullOrWhiteSpace(s)).Distinct())
        {
            var normalized = FeatureWorkflowCatalog.NormalizeStateKey(state);
            if (normalized == state) continue;
            await _db.Features.UpdateManyAsync(
                f => f.CurrentState == state && !f.IsDeleted,
                Builders<Feature>.Update.Set(f => f.CurrentState, normalized).Set(f => f.UpdatedAt, DateTime.UtcNow));
        }
    }

    /// <summary>将旧版产品缺陷状态 Key 迁移为与需求对齐的 Key（幂等；仅处理已绑定产品工作流的缺陷）。</summary>
    private async Task MigrateLegacyProductDefectStatesAsync()
    {
        foreach (var (legacy, modern) in DefectWorkflowCatalog.LegacyStateMap)
        {
            if (legacy == modern) continue;
            await _db.DefectReports.UpdateManyAsync(
                d => d.Status == legacy && d.WorkflowDefId != null && !d.IsDeleted,
                Builders<DefectReport>.Update.Set(d => d.Status, modern).Set(d => d.UpdatedAt, DateTime.UtcNow));
        }

        var distinctStates = await _db.DefectReports
            .Find(d => !d.IsDeleted && d.WorkflowDefId != null && d.Status != null)
            .Project(d => d.Status).ToListAsync();
        foreach (var state in distinctStates.Where(s => !string.IsNullOrWhiteSpace(s)).Distinct())
        {
            var normalized = DefectWorkflowCatalog.NormalizeStateKey(state);
            if (normalized == state) continue;
            await _db.DefectReports.UpdateManyAsync(
                d => d.Status == state && d.WorkflowDefId != null && !d.IsDeleted,
                Builders<DefectReport>.Update.Set(d => d.Status, normalized).Set(d => d.UpdatedAt, DateTime.UtcNow));
        }
    }

    private async Task<Dictionary<string, ProductWorkflowDefinition>> LoadWorkflowDefsByIdsAsync(IEnumerable<string?> ids)
    {
        var defIds = ids.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).Distinct().ToList();
        if (defIds.Count == 0) return new();
        var defs = await _db.ProductWorkflowDefinitions
            .Find(w => defIds.Contains(w.Id) && !w.IsDeleted)
            .ToListAsync();
        return defs.ToDictionary(d => d.Id, d => d);
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
        if (!await CanManageAsync(GetUserId()))
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
                .Set(w => w.IsUserCustomized, true)
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
        if (!await CanManageAsync(GetUserId()))
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
            case ProductEntityType.Defect:
                var d = await _db.DefectReports.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
                if (d == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
                if (string.IsNullOrWhiteSpace(d.TracedProductId))
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺陷未追溯到产品，无法流转"));
                currentState = d.Status; workflowDefId = d.WorkflowDefId; productId = d.TracedProductId!;
                break;
            default:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的对象类型"));
        }

        if (await FindAccessibleProductAsync(productId, userId) is not { } product)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "无权访问该对象"));

        var isGlobalAdmin = await CanManageAsync(userId);

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

        if (request.EntityType == ProductEntityType.Requirement)
            currentState = RequirementWorkflowCatalog.NormalizeStateKey(currentState, def);

        var transition = def.Transitions.FirstOrDefault(t => t.Key == request.TransitionKey);
        if (transition == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未定义的流转动作"));
        // from 校验：transition.FromState 为空表示任意状态可触发
        if (!string.IsNullOrWhiteSpace(transition.FromState) && transition.FromState != currentState)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"当前状态({currentState ?? "未设置"})不允许该流转"));
        if (def.States.All(s => s.Key != transition.ToState))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "目标状态非法"));

        string entityOwnerId = product.OwnerId;
        string? entityAssigneeId = null;
        string entityTitle = string.Empty;
        string entityGrade = string.Empty;
        Requirement? requirementEntity = null;
        DefectReport? defectEntity = null;

        if (request.EntityType == ProductEntityType.Requirement)
        {
            requirementEntity = await _db.Requirements.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
            if (requirementEntity == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
            entityOwnerId = requirementEntity.OwnerId;
            entityAssigneeId = requirementEntity.AssigneeId;
            entityTitle = requirementEntity.Title;
            entityGrade = requirementEntity.Grade;
        }
        else if (request.EntityType == ProductEntityType.Feature)
        {
            var featEntity = await _db.Features.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
            if (featEntity == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
            entityOwnerId = featEntity.OwnerId;
            entityAssigneeId = featEntity.AssigneeId;
            entityTitle = featEntity.Title;
            entityGrade = featEntity.Grade;
        }
        else if (request.EntityType == ProductEntityType.Defect)
        {
            defectEntity = await _db.DefectReports.Find(x => x.Id == request.EntityId && !x.IsDeleted).FirstOrDefaultAsync();
            if (defectEntity == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对象不存在"));
            entityOwnerId = defectEntity.ReporterId;
            entityAssigneeId = defectEntity.AssigneeId;
            entityTitle = defectEntity.Title ?? defectEntity.DefectNo;
            entityGrade = ProductItemGrade.All.Contains(defectEntity.Grade ?? "") ? defectEntity.Grade! : ProductItemGrade.P2;
        }

        if (request.EntityType is ProductEntityType.Requirement or ProductEntityType.Feature or ProductEntityType.Defect)
        {
            if (!ProductWorkflowTransitionGuard.CanExecuteTransition(userId, transition, product, isGlobalAdmin, entityOwnerId, entityAssigneeId))
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "当前用户无权执行该流转"));

            var assigneeForCheck = request.AssigneeId ?? entityAssigneeId;
            if (transition.AutoAssignToActor && string.IsNullOrWhiteSpace(assigneeForCheck))
                assigneeForCheck = userId;

            var mergedTitle = string.IsNullOrWhiteSpace(request.Title) ? entityTitle : request.Title.Trim();
            var mergedGrade = string.IsNullOrWhiteSpace(request.Grade) ? entityGrade : request.Grade.Trim();
            var mergedVersionIds = requirementEntity != null
                ? ((request.VersionIds?.Count > 0 ? request.VersionIds : requirementEntity.VersionIds) ?? new List<string>())
                : null;
            var fieldError = ProductWorkflowTransitionGuard.ValidateRequiredFields(
                transition, mergedTitle, mergedGrade, assigneeForCheck, request.Comment, transition.AutoAssignToActor, mergedVersionIds);
            if (fieldError != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, fieldError));

            if (request.EntityType == ProductEntityType.Requirement && requirementEntity != null)
            {
                var (inApprovedInitiation, inCompletedRelease) = await LoadRequirementLinkageAsync(productId, requirementEntity.Id);
                var initiationValid = false;
                if (!string.IsNullOrWhiteSpace(request.InitiationId))
                {
                    initiationValid = await ValidateInitiationForRequirementAsync(productId, requirementEntity.Id, request.InitiationId);
                    if (initiationValid)
                        await LinkRequirementToInitiationAsync(request.InitiationId, requirementEntity.Id);
                }
                var releaseValid = false;
                if (!string.IsNullOrWhiteSpace(request.ReleaseId))
                {
                    releaseValid = await ValidateReleaseForRequirementAsync(productId, requirementEntity.Id, request.ReleaseId);
                    if (releaseValid)
                        await LinkRequirementToReleaseAsync(request.ReleaseId, requirementEntity.Id);
                }

                if (RequirementWorkflowTransitionGates.IsStateGatedTarget(transition.ToState))
                {
                    var gateError = RequirementWorkflowTransitionGates.ValidateStateGate(
                        transition.ToState,
                        mergedVersionIds,
                        inApprovedInitiation || initiationValid,
                        request.InitiationId,
                        initiationValid,
                        inCompletedRelease || releaseValid,
                        request.ReleaseId,
                        releaseValid);
                    if (gateError != null)
                        return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, gateError));
                }
            }
        }
        else if (transition.RequireComment && string.IsNullOrWhiteSpace(request.Comment))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该流转需要填写备注"));
        }

        if (request.EntityType == ProductEntityType.Feature
            && transition.ToState == FeatureWorkflowCatalog.Delisted
            && currentState != RequirementWorkflowCatalog.Released)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅已上线状态的功能可下架"));
        }

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
                if (!string.IsNullOrWhiteSpace(request.Title)) ru = ru.Set(x => x.Title, request.Title.Trim());
                if (!string.IsNullOrWhiteSpace(request.Grade)) ru = ru.Set(x => x.Grade, request.Grade.Trim());
                if (request.VersionIds is { Count: > 0 })
                    ru = ru.Set(x => x.VersionIds, request.VersionIds.Distinct().ToList());
                await _db.Requirements.UpdateOneAsync(x => x.Id == request.EntityId, ru);
                if (request.VersionIds is { Count: > 0 })
                    await SyncRequirementToVersionsAsync(productId, request.EntityId, request.VersionIds.Distinct().ToList());
                break;
            }
            case ProductEntityType.Feature:
            {
                var fu = Builders<Feature>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.StateEnteredAt, now).Set(x => x.UpdatedAt, now);
                if (effectiveAssignee != null) fu = fu.Set(x => x.AssigneeId, effectiveAssignee);
                if (!string.IsNullOrWhiteSpace(request.Title)) fu = fu.Set(x => x.Title, request.Title.Trim());
                if (!string.IsNullOrWhiteSpace(request.Grade)) fu = fu.Set(x => x.Grade, request.Grade.Trim());
                await _db.Features.UpdateOneAsync(x => x.Id == request.EntityId, fu);
                break;
            }
            case ProductEntityType.UpgradeRequest:
                await _db.VersionUpgradeRequests.UpdateOneAsync(x => x.Id == request.EntityId,
                    Builders<VersionUpgradeRequest>.Update.Set(x => x.CurrentState, transition.ToState).Set(x => x.UpdatedAt, now));
                break;
            case ProductEntityType.Defect:
            {
                var du = Builders<DefectReport>.Update.Set(x => x.Status, transition.ToState).Set(x => x.UpdatedAt, now);
                if (effectiveAssignee != null)
                {
                    var assigneeName = (await _db.Users.Find(uu => uu.UserId == effectiveAssignee).FirstOrDefaultAsync())?.DisplayName;
                    du = du.Set(x => x.AssigneeId, effectiveAssignee).Set(x => x.AssigneeName, assigneeName);
                }
                if (!string.IsNullOrWhiteSpace(request.Title)) du = du.Set(x => x.Title, request.Title.Trim());
                if (!string.IsNullOrWhiteSpace(request.Grade)) du = du.Set(x => x.Grade, request.Grade.Trim());
                await _db.DefectReports.UpdateOneAsync(x => x.Id == request.EntityId, du);
                break;
            }
        }

        await HandleTransitionCrossLinkAsync(request.EntityType, request.EntityId, productId, userId, transition);

        _logger.LogInformation("[product-agent] Transition {Type}/{Id} {From}->{To} by {User}",
            request.EntityType, request.EntityId, currentState, transition.ToState, userId);

        // 记录时间线 + 通知（需求 / 功能 / 缺陷）
        if (request.EntityType is ProductEntityType.Requirement or ProductEntityType.Feature or ProductEntityType.Defect)
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
            var itemUrl = request.EntityType == ProductEntityType.Defect
                ? $"/product-agent/p/{productId}/defect/{request.EntityId}"
                : ItemUrl(productId, request.EntityType, request.EntityId);
            await NotifyItemAsync(new[] { notifyAssignee }, userId, $"状态变更 · {no}",
                $"{actorName ?? "有人"} 把「{title}」从 {fromLabel} 流转到 {toLabel}", itemUrl);
            if (effectiveAssignee != null)
            {
                var assigneeName = (await _db.Users.Find(uu => uu.UserId == effectiveAssignee).FirstOrDefaultAsync())?.DisplayName;
                await RecordActivityAsync(request.EntityType, request.EntityId, productId, ProductActivityType.Assign, userId, actorName, toValue: assigneeName ?? effectiveAssignee);
                if (effectiveAssignee != userId)
                    await NotifyItemAsync(new[] { (string?)effectiveAssignee }, userId, $"指派给你 · {no}", $"{actorName ?? "有人"} 把「{title}」指派给你处理", itemUrl);
            }
        }
        return Ok(ApiResponse<object>.Ok(new { entityId = request.EntityId, newState = transition.ToState }));
    }

    /// <summary>流转成功后按规则触发需求 ↔ 缺陷联动。</summary>
    private async Task HandleTransitionCrossLinkAsync(string entityType, string entityId, string productId, string userId, ProductWorkflowTransition transition)
    {
        var linksDefect = entityType == ProductEntityType.Requirement
            && (transition.ToState == RequirementWorkflowCatalog.ToDefect
                || transition.LinkEntityType == ProductEntityType.Defect);
        var linksRequirement = entityType == ProductEntityType.Defect
            && (transition.ToState == DefectWorkflowCatalog.ToRequirement
                || transition.LinkEntityType == ProductEntityType.Requirement);

        if (!linksDefect && !linksRequirement) return;

        if (linksDefect)
        {
            var req = await _db.Requirements.Find(r => r.Id == entityId && !r.IsDeleted).FirstOrDefaultAsync();
            if (req != null) await EnsureDefectFromRequirementAsync(req, productId, userId);
        }
        else if (linksRequirement)
        {
            var defect = await _db.DefectReports.Find(d => d.Id == entityId && !d.IsDeleted).FirstOrDefaultAsync();
            if (defect != null) await ConvertDefectToRequirementInternalAsync(defect, userId);
        }
    }

    /// <summary>需求标记为产品缺陷并确保存在关联缺陷（幂等）。</summary>
    private async Task<DefectReport> EnsureDefectFromRequirementAsync(Requirement req, string productId, string userId)
    {
        var fd = req.FormData ?? new Dictionary<string, string>();
        fd[ProductDefectLinkageCatalog.RequirementProductDefectFormKey] = ProductDefectLinkageCatalog.RequirementProductDefectValue;
        await _db.Requirements.UpdateOneAsync(r => r.Id == req.Id,
            Builders<Requirement>.Update.Set(r => r.FormData, fd).Set(r => r.UpdatedAt, DateTime.UtcNow));

        var existing = await _db.DefectReports
            .Find(d => d.TracedRequirementId == req.Id && d.TracedProductId == productId && !d.IsDeleted)
            .FirstOrDefaultAsync();
        if (existing != null) return existing;

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        string? assigneeName = null;
        if (!string.IsNullOrWhiteSpace(req.AssigneeId))
            assigneeName = (await _db.Users.Find(u => u.UserId == req.AssigneeId).FirstOrDefaultAsync())?.DisplayName;

        var defect = new DefectReport
        {
            DefectNo = await GenerateNextTapdStyleDefectIdAsync(productId),
            Title = req.Title,
            RawContent = req.Description ?? string.Empty,
            Grade = req.Grade,
            AssigneeId = req.AssigneeId,
            AssigneeName = assigneeName,
            ReporterId = userId,
            ReporterName = user?.DisplayName,
            TracedProductId = productId,
            TracedRequirementId = req.Id,
            ProductDefectClassification = ProductDefectLinkageCatalog.ProductDefect,
        };
        var (_, workflowDefId) = await ResolveDefaultsAsync(ProductEntityType.Defect, productId);
        defect.WorkflowDefId = workflowDefId;
        defect.Status = await ResolveInitialStateAsync(workflowDefId) ?? RequirementWorkflowCatalog.New;
        await _db.DefectReports.InsertOneAsync(defect);
        await RecalcDefectCountAsync(productId);
        var actorName = user?.DisplayName;
        await RecordActivityAsync(ProductEntityType.Defect, defect.Id, productId, ProductActivityType.Convert, userId, actorName,
            content: $"由需求 {req.RequirementNo} 联动生成");
        return defect;
    }

    /// <summary>缺陷转需求（幂等，与 POST convert-to-requirement 共用）。</summary>
    private async Task<Requirement> ConvertDefectToRequirementInternalAsync(DefectReport defect, string userId)
    {
        var existing = await _db.Requirements.Find(r => r.SourceDefectId == defect.Id && !r.IsDeleted).FirstOrDefaultAsync();
        if (existing != null) return existing;

        if (string.IsNullOrWhiteSpace(defect.TracedProductId))
            throw new InvalidOperationException("缺陷未追溯到产品，无法转需求");

        var productId = defect.TracedProductId!;
        var (_, workflowDefId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);
        var req = new Requirement
        {
            ProductId = productId,
            RequirementNo = await GenerateNextTapdStyleRequirementIdAsync(productId),
            Title = string.IsNullOrWhiteSpace(defect.Title) ? $"由缺陷 {defect.DefectNo} 转化" : defect.Title!.Trim(),
            Description = defect.RawContent,
            Grade = ProductItemGrade.All.Contains(defect.Grade ?? "") ? defect.Grade! : ProductItemGrade.P2,
            WorkflowDefId = workflowDefId,
            OwnerId = userId,
            SourceDefectId = defect.Id,
        };
        req.CurrentState = await ResolveInitialStateAsync(workflowDefId);
        await _db.Requirements.InsertOneAsync(req);

        await _db.DefectReports.UpdateOneAsync(d => d.Id == defect.Id,
            Builders<DefectReport>.Update
                .Set(d => d.TracedRequirementId, req.Id)
                .Set(d => d.ProductDefectClassification, ProductDefectLinkageCatalog.NonProductDefect)
                .Set(d => d.UpdatedAt, DateTime.UtcNow));
        var convActor = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        await RecordActivityAsync(ProductEntityType.Requirement, req.Id, productId, ProductActivityType.Convert, userId, convActor,
            content: $"由缺陷 {defect.DefectNo} 转化生成");
        await RecalcProductCountsAsync(productId);
        return req;
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
            nodes.Add(new { id = $"defect:{d.Id}", type = "defect", label = d.Title ?? d.DefectNo, sub = d.DefectNo, grade = d.Grade, severityTier = d.StructuredData.GetValueOrDefault(TapdDefectFieldCatalog.DefectSeverity), state = d.Status });
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

    /// <summary>
    /// 解析产品整体知识库（find-or-create），并懒迁移旧的「每版本一个独立库」：
    /// 旧版本库条目整体移入产品库（VersionIds = [versionId] 标记归属，保留文件夹树），版本库随后删除。
    /// 迁移幂等：迁完 version.KnowledgeStoreId 置空，再次调用 no-op。
    /// </summary>
    private async Task<DocumentStore> ResolveProductKnowledgeStoreAsync(Product product)
    {
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
                ProductKnowledgeRef = $"product:{product.Id}",
            };
            await _db.DocumentStores.InsertOneAsync(store);
            await _db.Products.UpdateOneAsync(p => p.Id == product.Id,
                Builders<Product>.Update.Set(p => p.KnowledgeStoreId, store.Id).Set(p => p.UpdatedAt, DateTime.UtcNow));
        }

        var staleVersions = await _db.ProductVersions
            .Find(v => v.ProductId == product.Id && !v.IsDeleted && v.KnowledgeStoreId != null && v.KnowledgeStoreId != "")
            .ToListAsync();
        if (staleVersions.Count > 0)
        {
            foreach (var v in staleVersions)
            {
                if (v.KnowledgeStoreId != store.Id)
                {
                    await _db.DocumentEntries.UpdateManyAsync(
                        e => e.StoreId == v.KnowledgeStoreId,
                        Builders<DocumentEntry>.Update
                            .Set(e => e.StoreId, store.Id)
                            .Set(e => e.VersionIds, new List<string> { v.Id })
                            .Set(e => e.UpdatedAt, DateTime.UtcNow));
                    await _db.DocumentStores.DeleteOneAsync(s => s.Id == v.KnowledgeStoreId);
                }
                await _db.ProductVersions.UpdateOneAsync(x => x.Id == v.Id,
                    Builders<ProductVersion>.Update.Set(x => x.KnowledgeStoreId, null));
            }
            var docCount = await _db.DocumentEntries.CountDocumentsAsync(e => e.StoreId == store.Id && !e.IsFolder);
            await _db.DocumentStores.UpdateOneAsync(s => s.Id == store.Id,
                Builders<DocumentStore>.Update.Set(s => s.DocumentCount, (int)docCount));
        }
        return store;
    }

    /// <summary>产品整体知识库（find-or-create 绑定的 DocumentStore；前端复用 document-store 渲染）</summary>
    [HttpGet("products/{productId}/knowledge/store")]
    public async Task<IActionResult> GetProductKnowledgeStore(string productId)
    {
        var product = await FindAccessibleProductAsync(productId, GetUserId());
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var store = await ResolveProductKnowledgeStoreAsync(product);
        return Ok(ApiResponse<object>.Ok(store));
    }

    /// <summary>
    /// （兼容端点）版本知识库已并入产品整体库：知识统一存产品库、条目用 VersionIds 关联版本。
    /// 本端点不再创建版本独立库，直接返回产品整体库（顺带完成懒迁移）。
    /// </summary>
    [HttpGet("versions/{versionId}/knowledge/store")]
    public async Task<IActionResult> GetVersionKnowledgeStore(string versionId)
    {
        var version = await _db.ProductVersions.Find(v => v.Id == versionId && !v.IsDeleted).FirstOrDefaultAsync();
        if (version == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在或无权访问"));
        var product = await FindAccessibleProductAsync(version.ProductId, GetUserId());
        if (product == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在或无权访问"));
        var store = await ResolveProductKnowledgeStoreAsync(product);
        return Ok(ApiResponse<object>.Ok(store));
    }

    // ════════════════════════ 缺陷追溯（复用 defect-agent，P1）════════════════════════

    /// <summary>列出追溯到本产品（可按需求/版本/功能细分）的缺陷。</summary>
    [HttpGet("products/{productId}/defects")]
    public async Task<IActionResult> ListTracedDefects(
        string productId,
        [FromQuery] string? requirementId = null,
        [FromQuery] string? versionId = null,
        [FromQuery] string? featureId = null,
        [FromQuery] bool mine = false)
    {
        if (await FindAccessibleProductAsync(productId, GetUserId()) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var b = Builders<DefectReport>.Filter;
        var conds = new List<FilterDefinition<DefectReport>> { b.Eq(d => d.TracedProductId, productId), b.Eq(d => d.IsDeleted, false) };
        if (!string.IsNullOrWhiteSpace(requirementId)) conds.Add(b.Eq(d => d.TracedRequirementId, requirementId));
        if (!string.IsNullOrWhiteSpace(versionId)) conds.Add(b.Eq(d => d.TracedVersionId, versionId));
        if (!string.IsNullOrWhiteSpace(featureId)) conds.Add(b.Eq(d => d.TracedFeatureId, featureId));
        if (mine)
        {
            var userId = GetUserId();
            conds.Add(b.Or(b.Eq(d => d.AssigneeId, userId), b.Eq(d => d.ReporterId, userId)));
        }
        var items = await _db.DefectReports.Find(b.And(conds)).SortByDescending(d => d.CreatedAt).Limit(200).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 工作台「我的待办」：只返回当前用户「现在需要处理」的项。
    /// 需求/功能：当前状态责任人=我（处理人优先，未指派时取负责人）且未到终态(IsFinal)；
    ///            流转给他人或到终态后自动从待办消失。
    /// 缺陷：同样按状态责任人——处理人=我且处于处理环节(评审/待处理/已提交/已分配/处理中)，
    ///      或上报人=我且处于起草/待验收。提交后流转到处理环节、或到终态，即从我的待办消失。
    /// </summary>
    [HttpGet("products/{productId}/my-todos")]
    public async Task<IActionResult> MyTodos(string productId)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));

        var reqs = await _db.Requirements.Find(r => r.ProductId == productId && !r.IsDeleted).SortByDescending(r => r.CreatedAt).ToListAsync();
        var feats = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted).SortByDescending(f => f.CreatedAt).ToListAsync();
        var defects = await _db.DefectReports.Find(d => d.TracedProductId == productId && !d.IsDeleted).SortByDescending(d => d.CreatedAt).ToListAsync();

        // 加载需求/功能实际绑定的流程定义，建终态键集合 + 状态标签表
        var defIds = reqs.Select(r => r.WorkflowDefId).Concat(feats.Select(f => f.WorkflowDefId))
            .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).Distinct().ToList();
        var defs = defIds.Count == 0 ? new List<ProductWorkflowDefinition>()
            : await _db.ProductWorkflowDefinitions.Find(w => defIds.Contains(w.Id) && !w.IsDeleted).ToListAsync();
        var defById = defs.ToDictionary(d => d.Id, d => d);

        bool IsFinal(string? defId, string? state)
            => !string.IsNullOrEmpty(state) && !string.IsNullOrEmpty(defId)
               && defById.TryGetValue(defId, out var def)
               && def.States.Any(s => s.Key == RequirementWorkflowCatalog.NormalizeStateKey(state, def) && s.IsFinal);
        string? StateLabel(string? defId, string? state, bool requirement = false)
        {
            if (string.IsNullOrEmpty(state)) return null;
            defById.TryGetValue(defId ?? "", out var def);
            if (requirement)
                return RequirementWorkflowCatalog.ResolveStateLabel(state, def);
            if (def != null)
                return def.States.FirstOrDefault(s => s.Key == state)?.Label ?? state;
            return state;
        }
        // 状态责任人：有处理人取处理人，否则取负责人
        bool MineByState(string? assigneeId, string ownerId)
            => (string.IsNullOrEmpty(assigneeId) ? ownerId : assigneeId) == userId;

        // 缺陷按"状态责任人"判定（与需求/功能口径一致）：只在轮到我的状态才算待办。
        // 处理环节(评审/待处理/已提交/已分配/处理中)的责任人是处理人；只有起草/待验收才轮到上报人。
        // 已解决/已拒绝/已关闭为终态，永不进待办。
        var assigneeActive = new HashSet<string>
        {
            DefectStatus.Reviewing, DefectStatus.Awaiting, DefectStatus.Submitted, DefectStatus.Assigned, DefectStatus.Processing,
            RequirementWorkflowCatalog.New, RequirementWorkflowCatalog.Planning, RequirementWorkflowCatalog.Approved,
            RequirementWorkflowCatalog.Developing, RequirementWorkflowCatalog.Scheduled,
        };
        var reporterActive = new HashSet<string> { DefectStatus.Draft, DefectStatus.Verifying };
        bool DefectMine(DefectReport d)
            => (d.AssigneeId == userId && assigneeActive.Contains(d.Status ?? ""))
               || (d.ReporterId == userId && reporterActive.Contains(d.Status ?? ""));

        var items = new List<object>();
        foreach (var r in reqs.Where(r => MineByState(r.AssigneeId, r.OwnerId) && !IsFinal(r.WorkflowDefId, r.CurrentState)))
        {
            defById.TryGetValue(r.WorkflowDefId ?? "", out var rDef);
            var stateKey = RequirementWorkflowCatalog.NormalizeStateKey(r.CurrentState, rDef);
            items.Add(new { kind = "requirement", id = r.Id, no = r.RequirementNo, title = r.Title, state = stateKey, stateLabel = StateLabel(r.WorkflowDefId, r.CurrentState, requirement: true) });
        }
        foreach (var f in feats.Where(f => MineByState(f.AssigneeId, f.OwnerId) && !IsFinal(f.WorkflowDefId, f.CurrentState)))
            items.Add(new { kind = "feature", id = f.Id, no = f.FeatureNo, title = f.Title, state = f.CurrentState, stateLabel = StateLabel(f.WorkflowDefId, f.CurrentState) });
        foreach (var d in defects.Where(DefectMine))
            items.Add(new { kind = "defect", id = d.Id, no = d.DefectNo, title = string.IsNullOrWhiteSpace(d.Title) ? d.DefectNo : d.Title!, state = (string?)d.Status, stateLabel = (string?)null });

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
        if (!await CanManageAsync(userId))
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
            DefectNo = await GenerateNextTapdStyleDefectIdAsync(productId),
            Title = request.Title.Trim(),
            RawContent = request.Description?.Trim() ?? string.Empty,
            Grade = ProductItemGrade.All.Contains(request.Grade ?? "") ? request.Grade : null,
            AssigneeId = string.IsNullOrWhiteSpace(request.AssigneeId) ? null : request.AssigneeId,
            AssigneeName = assigneeName,
            ReporterId = userId,
            ReporterName = user?.DisplayName,
            TracedProductId = productId,
            TracedRequirementId = request.RequirementId,
            TracedVersionId = request.VersionId,
            TracedFeatureId = request.FeatureId,
            ProductDefectClassification = ProductDefectLinkageCatalog.NormalizeClassification(request.ProductDefectClassification),
        };
        var (_, defectWfId) = await ResolveDefaultsAsync(ProductEntityType.Defect, productId);
        defect.WorkflowDefId = defectWfId;
        defect.Status = await ResolveInitialStateAsync(defectWfId) ?? RequirementWorkflowCatalog.New;
        await _db.DefectReports.InsertOneAsync(defect);
        await RecalcDefectCountAsync(productId);
        return Ok(ApiResponse<object>.Ok(defect));
    }

    /// <summary>在产品内编辑缺陷核心字段（标题/描述/严重程度/状态/处理人/关联功能/版本）。完整流转仍在缺陷管理智能体。</summary>
    [HttpPut("products/{productId}/defects/{defectId}")]
    public async Task<IActionResult> UpdateProductDefect(string productId, string defectId, [FromBody] UpdateProductDefectRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProductAsync(productId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在或无权访问"));
        var defect = await _db.DefectReports.Find(d => d.Id == defectId && d.TracedProductId == productId && !d.IsDeleted).FirstOrDefaultAsync();
        if (defect == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "缺陷不存在或未追溯到本产品"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺陷标题不能为空"));

        // 处理人：变更则回填显示名
        string? assigneeName = defect.AssigneeName;
        if (request.AssigneeId != defect.AssigneeId)
            assigneeName = string.IsNullOrWhiteSpace(request.AssigneeId)
                ? null
                : (await _db.Users.Find(u => u.UserId == request.AssigneeId).FirstOrDefaultAsync())?.DisplayName;

        var u = Builders<DefectReport>.Update
            .Set(d => d.Title, request.Title.Trim())
            .Set(d => d.RawContent, request.Description?.Trim() ?? string.Empty);
        if (!string.IsNullOrWhiteSpace(request.Grade) && ProductItemGrade.All.Contains(request.Grade))
            u = u.Set(d => d.Grade, request.Grade);
        u = u
            .Set(d => d.AssigneeId, string.IsNullOrWhiteSpace(request.AssigneeId) ? null : request.AssigneeId)
            .Set(d => d.AssigneeName, assigneeName)
            .Set(d => d.TracedFeatureId, string.IsNullOrWhiteSpace(request.FeatureId) ? null : request.FeatureId)
            .Set(d => d.TracedVersionId, string.IsNullOrWhiteSpace(request.VersionId) ? null : request.VersionId)
            .Set(d => d.UpdatedAt, DateTime.UtcNow);
        var statusVal = request.Status ?? string.Empty;
        if (DefectStatus.All.Contains(statusVal))
            u = u.Set(d => d.Status, statusVal);
        if (request.ProductDefectClassification != null)
            u = u.Set(d => d.ProductDefectClassification, ProductDefectLinkageCatalog.NormalizeClassification(request.ProductDefectClassification));

        if (request.StructuredData != null)
        {
            var merged = TapdDefectFieldCatalog.MergeStructuredData(defect.StructuredData, request.StructuredData);
            defect.StructuredData = merged;
            defect.ProductDefectClassification = ProductDefectLinkageCatalog.NormalizeClassification(
                merged.GetValueOrDefault(TapdDefectFieldCatalog.DefectDivision) ?? request.ProductDefectClassification);
            u = u.Set(d => d.StructuredData, merged)
                .Set(d => d.ProductDefectClassification, defect.ProductDefectClassification);
        }

        await _db.DefectReports.UpdateOneAsync(d => d.Id == defectId, u);
        var updated = await _db.DefectReports.Find(d => d.Id == defectId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
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

        var req = await ConvertDefectToRequirementInternalAsync(defect, userId);
        _logger.LogInformation("[product-agent] Defect {DefectNo} converted to requirement {ReqNo} by {User}", defect.DefectNo, req.RequirementNo, userId);
        return Ok(ApiResponse<object>.Ok(req));
    }

    /// <summary>缺陷严重度 → 需求分级映射。</summary>
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
            case ProductEntityType.Defect:
                var d = await _db.DefectReports.Find(x => x.Id == entityId && !x.IsDeleted).FirstOrDefaultAsync();
                return d == null || string.IsNullOrWhiteSpace(d.TracedProductId)
                    ? null
                    : (d.TracedProductId!, d.AssigneeId, d.ReporterId, d.Title ?? d.DefectNo, d.DefectNo);
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

    // ════════════════════════ 追溯关系分析（SSE 流式）════════════════════════

    private static string RawId(string id) { var i = id.IndexOf(':'); return i >= 0 ? id[(i + 1)..] : id; }
    private static string NodeTypeOf(string id) { var i = id.IndexOf(':'); return i >= 0 ? id[..i] : ""; }

    /// <summary>解析图谱节点 id（type:rawId）所属产品 id，用于访问校验。</summary>
    private async Task<string?> ResolveNodeProductIdAsync(string nodeId)
    {
        var type = NodeTypeOf(nodeId); var rid = RawId(nodeId);
        switch (type)
        {
            case "product": return rid;
            case "version": return (await _db.ProductVersions.Find(v => v.Id == rid).FirstOrDefaultAsync())?.ProductId;
            case "requirement": return (await _db.Requirements.Find(r => r.Id == rid).FirstOrDefaultAsync())?.ProductId;
            case "feature": return (await _db.Features.Find(f => f.Id == rid).FirstOrDefaultAsync())?.ProductId;
            case "defect": return (await _db.DefectReports.Find(d => d.Id == rid).FirstOrDefaultAsync())?.TracedProductId;
            default: return null;
        }
    }

    /// <summary>
    /// 追溯关系分析：前端传入一条关系链（节点 + 带关系类型的边），后端按 id 从 DB 补全描述/时间戳，
    /// 调 AI 流式输出整条链的前因后果、关键对象与关系、重要时间节点（SSE）。规则 #6 可视化。
    /// </summary>
    [HttpPost("graph/relation-analysis/stream")]
    public async Task RelationAnalysis([FromBody] RelationAnalysisRequest request)
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
        var chainNodes = request.Nodes ?? new();
        var chainEdges = request.Edges ?? new();
        if (chainNodes.Count == 0) { await Sse("error", new { message = "关系链为空" }); return; }

        var anchorProductId = await ResolveNodeProductIdAsync(request.AnchorId ?? "");
        if (string.IsNullOrEmpty(anchorProductId) || await FindAccessibleProductAsync(anchorProductId, userId) == null)
        { await Sse("error", new { message = "无权访问该关系链" }); return; }

        await Sse("phase", new { message = "正在汇总关系链…" });

        string Strip(string? s) => System.Text.RegularExpressions.Regex.Replace(s ?? "", "<[^>]+>", " ")
            .Replace("&nbsp;", " ").Replace("&amp;", "&").Replace("&lt;", "<").Replace("&gt;", ">").Trim();
        string Short(string? s, int n = 220) { var t = Strip(s); return t.Length > n ? t[..n] + "…" : t; }
        string D(DateTime? t) => t.HasValue ? t.Value.ToString("yyyy-MM-dd") : "—";

        var labelById = chainNodes.Where(n => !string.IsNullOrEmpty(n.Id)).ToDictionary(n => n.Id!, n => n.Label ?? n.Id!);
        List<string> idsOf(string type) => chainNodes.Where(n => NodeTypeOf(n.Id ?? "") == type).Select(n => RawId(n.Id ?? "")).Distinct().ToList();

        var reqIds = idsOf("requirement"); var feaIds = idsOf("feature"); var verIds = idsOf("version");
        var defIds = idsOf("defect"); var custIds = idsOf("customer"); var prodIds = idsOf("product");
        var reqs = reqIds.Count == 0 ? new List<Requirement>() : await _db.Requirements.Find(r => reqIds.Contains(r.Id)).ToListAsync();
        var feas = feaIds.Count == 0 ? new List<Feature>() : await _db.Features.Find(f => feaIds.Contains(f.Id)).ToListAsync();
        var vers = verIds.Count == 0 ? new List<ProductVersion>() : await _db.ProductVersions.Find(v => verIds.Contains(v.Id)).ToListAsync();
        var defs = defIds.Count == 0 ? new List<DefectReport>() : await _db.DefectReports.Find(d => defIds.Contains(d.Id)).ToListAsync();
        var custs = custIds.Count == 0 ? new List<Customer>() : await _db.Customers.Find(c => custIds.Contains(c.Id)).ToListAsync();
        var prods = prodIds.Count == 0 ? new List<Product>() : await _db.Products.Find(p => prodIds.Contains(p.Id)).ToListAsync();

        var objLines = new List<string>();
        var timeline = new List<(DateTime when, string label)>();
        foreach (var p in prods) objLines.Add($"产品 [{p.ProductNo}] {p.Name}（分级 {p.Grade}，状态 {p.CurrentState ?? "—"}）");
        foreach (var v in vers)
        {
            objLines.Add($"版本 {v.VersionName}（生命周期 {v.Lifecycle}/{v.CurrentState ?? "—"}；计划发布 {D(v.PlannedReleaseAt)}，已发布 {D(v.ReleasedAt)}）");
            if (v.ReleasedAt.HasValue) timeline.Add((v.ReleasedAt.Value, $"版本 {v.VersionName} 发布"));
        }
        foreach (var c in custs) objLines.Add($"客户 {c.Name}（{c.Company}）");
        foreach (var r in reqs)
        {
            objLines.Add($"需求 [{r.RequirementNo}] {r.Title}（分级 {r.Grade}，状态 {r.CurrentState ?? "—"}；创建 {D(r.CreatedAt)}）描述：{Short(r.Description)}");
            timeline.Add((r.CreatedAt, $"需求 {r.RequirementNo} 创建"));
        }
        foreach (var f in feas)
        {
            objLines.Add($"功能 [{f.FeatureNo}] {f.Title}（分级 {f.Grade}，状态 {f.CurrentState ?? "—"}；创建 {D(f.CreatedAt)}）描述：{Short(f.Description)}");
            timeline.Add((f.CreatedAt, $"功能 {f.FeatureNo} 创建"));
        }
        foreach (var d in defs)
        {
            objLines.Add($"缺陷 [{d.DefectNo}] {d.Title}（严重程度 {d.StructuredData.GetValueOrDefault(TapdDefectFieldCatalog.DefectSeverity, "未设置")}，处理优先级 {(d.Grade ?? "未设置").ToUpperInvariant()}，状态 {d.Status}；提交 {D(d.SubmittedAt ?? d.CreatedAt)}，解决 {D(d.ResolvedAt)}，关闭 {D(d.ClosedAt)}）描述：{Short(d.RawContent)}");
            timeline.Add((d.SubmittedAt ?? d.CreatedAt, $"缺陷 {d.DefectNo} 提交"));
            if (d.ResolvedAt.HasValue) timeline.Add((d.ResolvedAt.Value, $"缺陷 {d.DefectNo} 解决"));
        }

        var relLabel = new Dictionary<string, string>
        {
            ["contains"] = "包含", ["includes"] = "关联需求", ["implements"] = "实现",
            ["from-customer"] = "来自客户", ["traces"] = "追溯", ["feature-in-version"] = "纳入功能",
        };
        var relLines = chainEdges.Select(e =>
        {
            var sl = labelById.TryGetValue(e.Source ?? "", out var a) ? a : e.Source;
            var tl = labelById.TryGetValue(e.Target ?? "", out var b) ? b : e.Target;
            var rl = relLabel.TryGetValue(e.Type ?? "", out var r) ? r : (e.Type ?? "关联");
            return $"{sl} —[{rl}]→ {tl}";
        }).Distinct().ToList();

        var timelineLines = timeline.OrderBy(t => t.when).Select(t => $"{t.when:yyyy-MM-dd}：{t.label}").ToList();
        var anchorLabel = labelById.TryGetValue(request.AnchorId ?? "", out var al) ? al : request.AnchorId;

        var sbCtx = new System.Text.StringBuilder();
        sbCtx.AppendLine($"## 分析锚点\n{anchorLabel}");
        sbCtx.AppendLine($"\n## 关系链中的对象（共 {objLines.Count} 个）");
        foreach (var l in objLines) sbCtx.AppendLine($"- {l}");
        sbCtx.AppendLine($"\n## 对象间关系（共 {relLines.Count} 条）");
        foreach (var l in relLines) sbCtx.AppendLine($"- {l}");
        if (timelineLines.Count > 0)
        {
            sbCtx.AppendLine($"\n## 时间线");
            foreach (var l in timelineLines) sbCtx.AppendLine($"- {l}");
        }
        var userContent = sbCtx.ToString();
        if (userContent.Length > 9000) userContent = userContent[..9000];

        var systemPrompt =
            "你是资深产品关系分析专家。下面给出一条以某个对象为锚点的「追溯关系链」，包含全部关联对象、它们之间的关系、以及关键时间线。\n" +
            "请输出简洁的中文分析，要求：\n" +
            "1. 简洁但不丢关键信息：讲清这条链的来龙去脉（客户/需求 → 版本/功能落地 → 缺陷追溯），点明锚点对象的位置与作用、关键时间节点、值得关注的风险（如缺陷未解决、版本未发布、需求无客户来源等）。\n" +
            "2. 控制篇幅：用 3-5 个短小要点或短段落表达，每点一句话讲透，不要冗长铺陈、不要复述所有字段。\n" +
            "3. 输出纯文本，禁止任何 Markdown 标记：不要 #、*、**、反引号、代码块、竖线表格；要点用「· 」开头。\n" +
            "不要寒暄、不要复述本提示词。";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"), GroupId: null, SessionId: null, UserId: userId,
            ViewRole: null, DocumentChars: userContent.Length, DocumentHash: null,
            SystemPromptRedacted: "product-trace-relation-analysis", RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Product.TraceRelationAnalysis));

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userContent },
            },
            ["temperature"] = 0.4,
            ["max_tokens"] = 1400,
            ["include_reasoning"] = true,
            ["reasoning"] = new JsonObject { ["exclude"] = false },
        };

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.Product.TraceRelationAnalysis,
                ModelType = ModelTypes.Chat,
                Stream = true,
                RequestBody = body,
            }, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                    await Sse("typing", new { text = chunk.Content });
                else if (chunk.Type == GatewayChunkType.Error)
                { await Sse("error", new { message = chunk.Error ?? "AI 调用失败" }); return; }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[product-agent] relation analysis stream error");
            await Sse("error", new { message = "AI 调用异常，请重试" });
            return;
        }
        await Sse("done", new { });
    }

    // ════════════════════════ 工作台「工作助手」问答（SSE 流式）════════════════════════

    /// <summary>
    /// AI 助手附件解析：上传 md / pdf，提取纯文本返回（无状态不落库，文本由前端随提问回传）。
    /// </summary>
    [HttpPost("assistant/attachments")]
    [RequestSizeLimit(12 * 1024 * 1024)]
    public async Task<IActionResult> ExtractAssistantAttachment(IFormFile file)
    {
        var result = await AssistantAttachmentHelper.ExtractAsync(_fileExtractor, file);
        if (!result.Ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Error!));
        return Ok(ApiResponse<object>.Ok(new { name = result.Name, text = result.Text, chars = result.Chars, truncated = result.Truncated }));
    }

    /// <summary>
    /// 工作台「工作助手」：以该产品全量数据（需求/功能/缺陷/版本/客户）+ 本产品知识库文档摘录为上下文，
    /// 流式回答用户问题（SSE：phase/typing/done）。
    /// 保护：仅本产品成员可访问（FindAccessibleProductAsync），只取本产品数据，知识库只取该产品挂载
    /// DocumentStore 的文本索引/摘要并截断，不跨产品、不倾倒原文件、prompt 约束不得编造或外引。
    /// </summary>
    [HttpPost("products/{productId}/assistant/ask")]
    public async Task AssistantAsk(string productId, [FromBody] AssistantAskRequest request)
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
        var product = await FindAccessibleProductAsync(productId, userId);
        if (product == null) { await Sse("error", new { message = "产品不存在或无权访问" }); return; }
        var question = (request.Question ?? "").Trim();
        if (question.Length == 0) { await Sse("error", new { message = "请输入问题" }); return; }
        if (question.Length > 1000) question = question[..1000];

        await Sse("phase", new { message = "正在汇总该产品数据与知识库…" });

        string Strip(string? s) => System.Text.RegularExpressions.Regex.Replace(s ?? "", "<[^>]+>", " ")
            .Replace("&nbsp;", " ").Replace("&amp;", "&").Replace("&lt;", "<").Replace("&gt;", ">").Trim();
        string Short(string? s, int n = 200) { var t = Strip(s); return t.Length > n ? t[..n] + "…" : t; }
        string D(DateTime? t) => t.HasValue ? t.Value.ToString("yyyy-MM-dd") : "—";

        var versions = await _db.ProductVersions.Find(v => v.ProductId == productId && !v.IsDeleted).ToListAsync();
        var reqs = await _db.Requirements.Find(r => r.ProductId == productId && !r.IsDeleted).ToListAsync();
        var feats = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted).ToListAsync();
        var defects = await _db.DefectReports.Find(d => d.TracedProductId == productId && !d.IsDeleted).ToListAsync();
        var custIds = reqs.SelectMany(r => r.CustomerIds).Distinct().ToList();
        var custs = custIds.Count == 0 ? new List<Customer>() : await _db.Customers.Find(c => custIds.Contains(c.Id)).ToListAsync();

        // 解析相关人员名（处理人/负责人/上报人/团队）—— 让助手能回答「某人本月情况 / 分工 / 负载」
        var userIds = new HashSet<string>();
        void AddU(string? id) { if (!string.IsNullOrWhiteSpace(id)) userIds.Add(id!); }
        AddU(product.OwnerId);
        foreach (var id in product.MemberIds) AddU(id);
        foreach (var id in product.AdminIds) AddU(id);
        foreach (var r in reqs) { AddU(r.AssigneeId); AddU(r.OwnerId); }
        foreach (var f in feats) { AddU(f.AssigneeId); AddU(f.OwnerId); }
        foreach (var d in defects) { AddU(d.AssigneeId); AddU(d.ReporterId); }
        var usersList = userIds.Count == 0 ? new List<User>() : await _db.Users.Find(u => userIds.Contains(u.UserId)).ToListAsync();
        var nameById = usersList.ToDictionary(u => u.UserId, u => string.IsNullOrWhiteSpace(u.DisplayName) ? (string.IsNullOrWhiteSpace(u.Username) ? u.UserId : u.Username) : u.DisplayName);
        string N(string? id) => string.IsNullOrWhiteSpace(id) ? "未指派" : (nameById.TryGetValue(id!, out var nm) ? nm : id!);
        var reqTitleById = reqs.GroupBy(r => r.Id).ToDictionary(g => g.Key, g => $"[{g.First().RequirementNo}]{g.First().Title}");
        var verNameById = versions.GroupBy(v => v.Id).ToDictionary(g => g.Key, g => g.First().VersionName);

        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"# 产品：[{product.ProductNo}] {product.Name}（分级 {product.Grade}，状态 {product.CurrentState ?? "—"}）");
        sb.AppendLine($"今日：{DateTime.UtcNow:yyyy-MM-dd}（涉及本月时以当前自然月为准）");
        var teamNames = new List<string>();
        if (!string.IsNullOrWhiteSpace(product.OwnerId)) teamNames.Add($"{N(product.OwnerId)}(负责人)");
        foreach (var id in product.MemberIds.Distinct()) if (id != product.OwnerId) teamNames.Add(N(id));
        if (teamNames.Count > 0) sb.AppendLine($"团队成员：{string.Join("、", teamNames)}");
        if (versions.Count > 0)
        {
            sb.AppendLine($"\n## 版本（{versions.Count}）");
            foreach (var v in versions) sb.AppendLine($"- {v.VersionName}（{v.Lifecycle}/{v.CurrentState ?? "—"}；计划 {D(v.PlannedReleaseAt)}，已发布 {D(v.ReleasedAt)}）");
        }
        if (custs.Count > 0)
        {
            sb.AppendLine($"\n## 客户（{custs.Count}）");
            foreach (var c in custs) sb.AppendLine($"- {c.Name}（{c.Company}）");
        }
        if (reqs.Count > 0)
        {
            sb.AppendLine($"\n## 需求（{reqs.Count}）");
            foreach (var r in reqs) sb.AppendLine($"- [{r.RequirementNo}] {r.Title}（等级 {r.Grade.ToUpperInvariant()}，状态 {r.CurrentState ?? "—"}；处理人 {N(r.AssigneeId)}，负责人 {N(r.OwnerId)}；创建 {D(r.CreatedAt)}）{Short(r.Description)}");
        }
        if (feats.Count > 0)
        {
            sb.AppendLine($"\n## 功能（{feats.Count}）");
            foreach (var f in feats)
            {
                var implReqs = f.RequirementIds.Count == 0 ? "无" : string.Join("、", f.RequirementIds.Select(id => reqTitleById.TryGetValue(id, out var t) ? t : id));
                sb.AppendLine($"- [{f.FeatureNo}] {f.Title}（等级 {f.Grade.ToUpperInvariant()}，状态 {f.CurrentState ?? "—"}；处理人 {N(f.AssigneeId)}，负责人 {N(f.OwnerId)}；实现需求 {implReqs}；创建 {D(f.CreatedAt)}）{Short(f.Description)}");
            }
        }
        if (defects.Count > 0)
        {
            sb.AppendLine($"\n## 缺陷（{defects.Count}）");
            foreach (var d in defects)
            {
                var traced = !string.IsNullOrEmpty(d.TracedFeatureId) ? "功能"
                    : !string.IsNullOrEmpty(d.TracedRequirementId) ? "需求"
                    : !string.IsNullOrEmpty(d.TracedVersionId) ? ("版本" + (verNameById.TryGetValue(d.TracedVersionId!, out var vn) ? vn : ""))
                    : "产品";
                sb.AppendLine($"- [{d.DefectNo}] {d.Title}（严重程度 {d.StructuredData.GetValueOrDefault(TapdDefectFieldCatalog.DefectSeverity, "未设置")}，处理优先级 {(d.Grade ?? "未设置").ToUpperInvariant()}，状态 {d.Status}；处理人 {N(d.AssigneeId)}，上报人 {N(d.ReporterId)}；追溯到{traced}；提交 {D(d.SubmittedAt ?? d.CreatedAt)}，解决 {D(d.ResolvedAt)}）{Short(d.RawContent)}");
            }
        }
        // 知识库：仅本产品挂载的 DocumentStore 文本索引/摘要，截断保护，不取原文件
        if (!string.IsNullOrEmpty(product.KnowledgeStoreId))
        {
            var entries = await _db.DocumentEntries
                .Find(e => e.StoreId == product.KnowledgeStoreId && !e.IsFolder)
                .Limit(40).ToListAsync();
            if (entries.Count > 0)
            {
                sb.AppendLine($"\n## 知识库文档（{entries.Count}，仅摘录）");
                foreach (var e in entries)
                {
                    var body = !string.IsNullOrWhiteSpace(e.Summary) ? e.Summary : e.ContentIndex;
                    sb.AppendLine($"- 《{e.Title}》：{Short(body, 300)}");
                }
            }
        }

        var ctx = sb.ToString();
        if (ctx.Length > 14000) ctx = ctx[..14000] + "\n…（上下文过长已截断）";

        var systemPrompt =
            "你是「" + product.Name + "」这个产品的 AI 助手。你的知识库仅限下面提供的该产品数据（需求/功能/缺陷/版本/客户/团队人员）与知识库文档摘录。\n" +
            "要求：\n" +
            "1. 只依据所给数据回答，不得编造或引用其它产品/外部信息；数据中没有的，明确说明「现有数据未覆盖」。\n" +
            "2. 涉及本月/本周/某人等口径时，按给定的今日日期、各对象的创建/提交/发布日期、以及处理人/负责人/上报人字段推算。\n" +
            "3. 输出纯文本，禁止使用任何 Markdown 标记：不要 #、*、**、反引号、代码块、竖线表格。用自然段落和「· 」项目符号组织，必要时用「一、二、三」分节。\n" +
            "4. 分析要深入，不能只罗列：\n" +
            "   - 挖掘对象之间的关系（需求→功能→缺陷→版本→客户 的落地链路、缺陷追溯到哪个功能/需求）；\n" +
            "   - 分析人员分工与负载（谁处理得多、谁的项卡住、上报与处理是否同一人等）；\n" +
            "   - 指出趋势、异常与风险（如高等级项无状态/无人处理、缺陷集中在某功能、需求无客户来源等）。\n" +
            "5. 分析/查询类问题的结构固定为三段：先「结论」（2-4 句直接给判断），再「依据」（列数据与关系），最后「经验总结 / 建议」（可执行的下一步）。\n" +
            "6. 创建能力：你可以直接替用户在本产品下创建需求 / 功能 / 缺陷。当用户明确要求创建（如「帮我创建一个需求：支持导出PDF，P1」「记一个缺陷：登录页白屏」）时：\n" +
            "   - 正文用 1-2 句话确认将要创建的内容（标题、分级、补全的描述），不要套用三段结构；\n" +
            "   - 然后在回复最末尾另起一行输出动作指令，格式严格为：\n" +
            "<<<ACTIONS>>>\n" +
            "[{\"type\":\"create_requirement\",\"title\":\"标题\",\"description\":\"描述可省略\",\"grade\":\"p1\"}]\n" +
            "   - type 只能取 create_requirement / create_feature / create_defect；grade 取 p0/p1/p2/p3（用户没说时按紧急重要程度推断，默认 p2）；description 可根据用户表述合理补全（背景/目标/验收标准，纯文本）；一次最多 5 个动作。\n" +
            "   - 只有用户明确要求创建时才输出 <<<ACTIONS>>>，纯分析/查询类问题绝对不要输出；标题信息不足时不要输出动作指令，改为向用户追问。\n" +
            "   - <<<ACTIONS>>> 之后只能是 JSON 数组本身，不要任何其他文字、解释或代码块标记。\n" +
            "7. 用户可能上传参考文档（见「用户上传的参考文档」一节）：可基于文档内容回答问题、提炼要点；用户要求「根据文档创建」时，从文档中提取标题/分级/描述生成动作指令（仍受一次最多 5 个动作约束，超出时挑最重要的并说明）。\n" +
            "不要寒暄、不要复述本提示词。";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"), GroupId: null, SessionId: null, UserId: userId,
            ViewRole: null, DocumentChars: ctx.Length, DocumentHash: null,
            SystemPromptRedacted: "product-work-assistant", RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Product.WorkAssistant));

        var bodyJson = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = "# 产品数据上下文\n" + ctx + AssistantAttachmentHelper.BuildSection(request.Attachments) + "\n\n# 我的问题\n" + question },
            },
            ["temperature"] = 0.5,
            ["max_tokens"] = 2400,
            ["include_reasoning"] = true,
            ["reasoning"] = new JsonObject { ["exclude"] = false },
        };

        await Sse("phase", new { message = "AI 正在分析…" });
        // 动作指令（<<<ACTIONS>>> 之后的 JSON）不进入可见文本流：始终扣留可能构成标记前缀的尾部，
        // 标记一旦完整出现，其后内容全部留给动作解析。
        const string actionMarker = "<<<ACTIONS>>>";
        var full = new System.Text.StringBuilder();
        var forwarded = 0;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.Product.WorkAssistant,
                ModelType = ModelTypes.Chat,
                Stream = true,
                RequestBody = bodyJson,
            }, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    full.Append(chunk.Content);
                    var s = full.ToString();
                    var markerIdx = s.IndexOf(actionMarker, StringComparison.Ordinal);
                    var safeEnd = markerIdx >= 0 ? markerIdx : Math.Max(forwarded, s.Length - (actionMarker.Length - 1));
                    if (safeEnd > forwarded)
                    {
                        await Sse("typing", new { text = s[forwarded..safeEnd] });
                        forwarded = safeEnd;
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                { await Sse("error", new { message = chunk.Error ?? "AI 调用失败" }); return; }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[product-agent] work assistant stream error");
            await Sse("error", new { message = "AI 调用异常，请重试" });
            return;
        }

        // 冲刷扣留的尾部可见文本，并执行动作指令
        var fullText = full.ToString();
        var actionIdx = fullText.IndexOf(actionMarker, StringComparison.Ordinal);
        var visibleEnd = actionIdx >= 0 ? actionIdx : fullText.Length;
        if (visibleEnd > forwarded)
            await Sse("typing", new { text = fullText[forwarded..visibleEnd] });

        if (actionIdx >= 0)
        {
            var specs = ParseAssistantActions(fullText[(actionIdx + actionMarker.Length)..]);
            foreach (var spec in specs)
            {
                await Sse("phase", new { message = "正在创建对象…" });
                var result = await ExecuteAssistantActionAsync(productId, userId, spec);
                await Sse("action", result);
            }
        }
        await Sse("done", new { });
    }

    private sealed record AssistantActionSpec(string Type, string Title, string? Description, string? Grade);

    /// <summary>解析助手动作指令 JSON（容忍代码块围栏 / json 语言标），非法输入返回空列表，最多 5 条。</summary>
    private static List<AssistantActionSpec> ParseAssistantActions(string raw)
    {
        var result = new List<AssistantActionSpec>();
        var json = raw.Trim().Trim('`').Trim();
        if (json.StartsWith("json", StringComparison.OrdinalIgnoreCase)) json = json[4..].Trim();
        try
        {
            if (JsonNode.Parse(json) is not JsonArray arr) return result;
            foreach (var node in arr.Take(5))
            {
                if (node is not JsonObject o) continue;
                var type = o["type"]?.GetValue<string>() ?? "";
                var title = (o["title"]?.GetValue<string>() ?? "").Trim();
                if (type.Length == 0 || title.Length == 0) continue;
                result.Add(new AssistantActionSpec(
                    type,
                    title,
                    o["description"]?.GetValue<string>(),
                    o["grade"]?.GetValue<string>()));
            }
        }
        catch
        {
            // LLM 输出非法 JSON：忽略动作，正文已正常返回
        }
        return result;
    }

    /// <summary>
    /// 执行助手动作（创建需求/功能/缺陷）。创建逻辑与对应 REST 端点对齐：
    /// 编号生成、默认流程绑定、初始状态、产品计数重算。返回 SSE action 事件载荷。
    /// </summary>
    private async Task<object> ExecuteAssistantActionAsync(string productId, string userId, AssistantActionSpec spec)
    {
        var kind = spec.Type switch
        {
            "create_requirement" => "requirement",
            "create_feature" => "feature",
            "create_defect" => "defect",
            _ => "",
        };
        var title = spec.Title.Length > 200 ? spec.Title[..200] : spec.Title;
        if (kind.Length == 0)
            return new { kind = spec.Type, ok = false, id = (string?)null, no = "", title, error = "不支持的动作类型" };
        var description = string.IsNullOrWhiteSpace(spec.Description) ? null : spec.Description!.Trim();
        if (description is { Length: > 4000 }) description = description[..4000];
        var grade = ProductItemGrade.All.Contains(spec.Grade ?? "") ? spec.Grade! : ProductItemGrade.P2;

        try
        {
            switch (kind)
            {
                case "requirement":
                {
                    var (_, wfId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);
                    var req = new Requirement
                    {
                        ProductId = productId,
                        RequirementNo = await GenerateNextTapdStyleRequirementIdAsync(productId),
                        Title = title,
                        Description = description,
                        Grade = grade,
                        WorkflowDefId = wfId,
                        OwnerId = userId,
                        StateEnteredAt = DateTime.UtcNow,
                    };
                    req.CurrentState = await ResolveInitialStateAsync(wfId);
                    await _db.Requirements.InsertOneAsync(req);
                    await RecalcProductCountsAsync(productId);
                    return new { kind, ok = true, id = (string?)req.Id, no = req.RequirementNo, title = req.Title, error = (string?)null };
                }
                case "feature":
                {
                    var (_, wfId) = await ResolveDefaultsAsync(ProductEntityType.Feature, productId);
                    var feature = new Feature
                    {
                        ProductId = productId,
                        FeatureNo = await GenerateNoAsync("FEA", _db.Features, "FeatureNo"),
                        Title = title,
                        Description = description,
                        Grade = grade,
                        WorkflowDefId = wfId,
                        OwnerId = userId,
                        StateEnteredAt = DateTime.UtcNow,
                    };
                    feature.CurrentState = await ResolveInitialStateAsync(wfId);
                    await _db.Features.InsertOneAsync(feature);
                    await RecalcProductCountsAsync(productId);
                    return new { kind, ok = true, id = (string?)feature.Id, no = feature.FeatureNo, title = feature.Title, error = (string?)null };
                }
                default:
                {
                    var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
                    var (_, defectWfId) = await ResolveDefaultsAsync(ProductEntityType.Defect, productId);
                    var defect = new DefectReport
                    {
                        DefectNo = await GenerateNextTapdStyleDefectIdAsync(productId),
                        Title = title,
                        RawContent = description ?? string.Empty,
                        Grade = grade,
                        ReporterId = userId,
                        ReporterName = user?.DisplayName,
                        TracedProductId = productId,
                        WorkflowDefId = defectWfId,
                        Status = await ResolveInitialStateAsync(defectWfId) ?? RequirementWorkflowCatalog.New,
                    };
                    await _db.DefectReports.InsertOneAsync(defect);
                    await RecalcDefectCountAsync(productId);
                    return new { kind, ok = true, id = (string?)defect.Id, no = defect.DefectNo, title = defect.Title, error = (string?)null };
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[product-agent] assistant action failed: {Type} {Title}", spec.Type, title);
            return new { kind, ok = false, id = (string?)null, no = "", title, error = "创建失败，请重试" };
        }
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
        await EnsureRequirementTypesSeededAsync();
        var requirementTypes = await _db.RequirementTypes.Find(t => !t.IsDeleted)
            .SortBy(t => t.SortOrder).ThenBy(t => t.CreatedAt).ToListAsync();
        var requirementTypeNames = requirementTypes.Select(t => t.Name).Where(n => !string.IsNullOrWhiteSpace(n)).ToList();

        var fields = (template?.Fields ?? new List<ProductFormField>())
            .Where(f => f.Type != ProductFormFieldType.File).ToList();

        var existingRequirements = await _db.Requirements.Find(r => r.ProductId == productId && !r.IsDeleted)
            .SortByDescending(r => r.UpdatedAt).Limit(60).ToListAsync();
        var existingFeatures = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted)
            .SortByDescending(f => f.UpdatedAt).Limit(60).ToListAsync();
        var existingVersions = await _db.ProductVersions.Find(v => v.ProductId == productId && !v.IsDeleted)
            .SortByDescending(v => v.UpdatedAt).Limit(30).ToListAsync();
        var existingCustomers = await _db.Customers.Find(c => !c.IsDeleted)
            .SortByDescending(c => c.UpdatedAt).Limit(80).ToListAsync();

        var fieldSpec = string.Join("\n", fields.Select(f =>
        {
            var opts = (f.Options != null && f.Options.Count > 0) ? $"，可选值: {string.Join(" / ", f.Options.Select(o => o.Value))}" : "";
            return $"- {f.Key}（{f.Label}，类型 {f.Type}{(f.Required ? "，必填" : "")}{opts}）";
        }));

        var typeSpec = requirementTypes.Count > 0
            ? string.Join("\n", requirementTypes.Select(t =>
                $"- {t.Name}：{(string.IsNullOrWhiteSpace(t.Definition) ? "（无额外说明）" : t.Definition)}"))
            : "";

        var reqCatalog = existingRequirements.Count > 0
            ? string.Join("\n", existingRequirements.Select(r => $"- {r.Title}"))
            : "（暂无已有需求）";
        var featCatalog = existingFeatures.Count > 0
            ? string.Join("\n", existingFeatures.Select(f =>
                string.IsNullOrWhiteSpace(f.ModuleName) ? $"- {f.Title}" : $"- {f.Title}（模块：{f.ModuleName}）"))
            : "（暂无已有功能）";
        var custCatalog = existingCustomers.Count > 0
            ? string.Join("\n", existingCustomers.Select(c => $"- {c.Name}"))
            : "（暂无客户档案，若文本提到客户名仍填入 customerNames）";
        var verCatalog = existingVersions.Count > 0
            ? string.Join("\n", existingVersions.Select(v => $"- {v.VersionName}"))
            : "（暂无版本）";

        const string originSpec = "客户反馈 / 内部规划 / 运营活动 / 竞品调研 / 其他（无法判断则空字符串）";

        var systemPrompt =
            "你是产品需求结构化助手。用户会给一段需求原始文本（可能来自口头描述、会议纪要、客户反馈），请尽可能抽取全部可识别字段。\n" +
            "原则：能从文本推断的字段必须填写；无法推断的省略或留空，不要编造。\n" +
            "严格只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块），结构：\n" +
            "{\n" +
            "  \"title\": \"简洁标题\",\n" +
            "  \"description\": \"需求描述（背景/目标/验收标准，纯文本）\",\n" +
            "  \"grade\": \"p0|p1|p2|p3（按紧急重要程度，默认 p2）\",\n" +
            "  \"requirementOrigin\": \"需求来源，取值 " + originSpec + "\",\n" +
            "  \"customerNames\": [\"文本中明确提到的客户/品牌/公司名称\"],\n" +
            "  \"parentRequirementTitle\": \"若是子需求或补充项，填父需求标题（与下列已有需求匹配）\",\n" +
            "  \"relatedFeatureTitles\": [\"提到的功能名、模块名或要改的功能范围\"],\n" +
            "  \"versionName\": \"若提到计划版本/迭代/归属版本则填版本名\",\n" +
            "  \"formData\": { 模板自定义字段 key: 值 }\n" +
            "}\n" +
            "已有需求（parentRequirementTitle 从中匹配）：\n" + reqCatalog + "\n" +
            "已有功能（relatedFeatureTitles 从中匹配，也可填模块名）：\n" + featCatalog + "\n" +
            "已有客户（customerNames 优先从中匹配）：\n" + custCatalog + "\n" +
            "已有版本（versionName 从中匹配）：\n" + verCatalog + "\n" +
            (requirementTypeNames.Count > 0
                ? $"必须在 formData 中填写 key「{RequirementType.FormDataKey}」，值从以下类型名称中选一（按定义判断，无法判断时选「其他」）：\n{typeSpec}\n"
                : "") +
            (fields.Count > 0
                ? $"formData 还可包含以下模板字段 key（无法从文本判断的可省略）：\n{fieldSpec}\n"
                : requirementTypeNames.Count == 0 ? "没有自定义模板字段时 formData 返回空对象 {}。\n" : "") +
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
            ["max_tokens"] = 2000,
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

        var parsed = ResolveRequirementAiFill(
            sb.ToString(), fields, requirementTypeNames,
            existingRequirements, existingFeatures, existingVersions, existingCustomers);
        if (parsed == null) { await Sse("error", new { message = "AI 返回无法解析，请重试或精简文本" }); return; }
        await Sse("result", parsed);
        await Sse("done", new { });
    }

    private static readonly HashSet<string> RequirementOriginValues = new(StringComparer.Ordinal)
    {
        "客户反馈", "内部规划", "运营活动", "竞品调研", "其他",
    };

    /// <summary>从 LLM 原始输出抽取需求智能填充结果，并解析客户/父需求/功能/版本为 ID。</summary>
    private static object? ResolveRequirementAiFill(
        string raw,
        List<ProductFormField> fields,
        IReadOnlyList<string>? requirementTypeNames,
        List<Requirement> requirements,
        List<Feature> features,
        List<ProductVersion> versions,
        List<Customer> customers)
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
            List<string> GetStrList(string k)
            {
                if (!root.TryGetProperty(k, out var arr) || arr.ValueKind != System.Text.Json.JsonValueKind.Array) return new();
                return arr.EnumerateArray()
                    .Where(e => e.ValueKind == System.Text.Json.JsonValueKind.String)
                    .Select(e => (e.GetString() ?? "").Trim())
                    .Where(x => x.Length > 0)
                    .ToList();
            }

            var title = GetStr("title").Trim();
            var description = GetStr("description").Trim();
            var grade = GetStr("grade").Trim().ToLowerInvariant();
            if (grade != "p0" && grade != "p1" && grade != "p2" && grade != "p3") grade = "p2";

            var requirementOrigin = GetStr("requirementOrigin").Trim();
            if (!string.IsNullOrEmpty(requirementOrigin) && !RequirementOriginValues.Contains(requirementOrigin))
                requirementOrigin = "";

            var formData = new Dictionary<string, string>();
            var allowed = fields.Select(f => f.Key).ToHashSet(StringComparer.Ordinal);
            allowed.Add(RequirementType.FormDataKey);
            allowed.Add("需求来源");
            var typeNameSet = requirementTypeNames?.Where(n => !string.IsNullOrWhiteSpace(n)).ToHashSet(StringComparer.Ordinal) ?? new HashSet<string>(StringComparer.Ordinal);
            if (root.TryGetProperty("formData", out var fd) && fd.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                foreach (var p in fd.EnumerateObject())
                {
                    if (!allowed.Contains(p.Name)) continue;
                    var val = p.Value.ValueKind switch
                    {
                        System.Text.Json.JsonValueKind.String => p.Value.GetString() ?? "",
                        System.Text.Json.JsonValueKind.Number => p.Value.ToString(),
                        System.Text.Json.JsonValueKind.True => "true",
                        System.Text.Json.JsonValueKind.False => "false",
                        _ => "",
                    };
                    if (string.IsNullOrEmpty(val)) continue;
                    if (p.Name == RequirementType.FormDataKey && typeNameSet.Count > 0 && !typeNameSet.Contains(val))
                        val = typeNameSet.Contains("其他") ? "其他" : typeNameSet.First();
                    formData[p.Name] = val;
                }
            }

            if (!string.IsNullOrEmpty(requirementOrigin))
                formData["需求来源"] = requirementOrigin;
            else if (formData.TryGetValue("需求来源", out var originInForm) && !RequirementOriginValues.Contains(originInForm))
                formData.Remove("需求来源");

            var customerNames = GetStrList("customerNames");
            var customerIds = customerNames
                .Select(name => MatchCustomerId(customers, name))
                .Where(id => !string.IsNullOrEmpty(id))
                .Distinct()
                .ToList();

            var parentTitle = GetStr("parentRequirementTitle").Trim();
            var parentId = MatchRequirementId(requirements, parentTitle);

            var featureTitles = GetStrList("relatedFeatureTitles");
            var featureIds = featureTitles
                .Select(t => MatchFeatureId(features, t))
                .Where(id => !string.IsNullOrEmpty(id))
                .Distinct()
                .ToList();
            var featureField = fields.FirstOrDefault(f =>
                string.Equals(f.Label, "关联功能", StringComparison.Ordinal)
                || string.Equals(f.RelationEntityType, ProductEntityType.Feature, StringComparison.OrdinalIgnoreCase));
            if (featureField != null && featureIds.Count > 0)
                formData[featureField.Key] = string.Join(",", featureIds);

            var versionName = GetStr("versionName").Trim();
            var versionId = MatchVersionId(versions, versionName);
            var versionField = fields.FirstOrDefault(f =>
                string.Equals(f.Label, "归属版本", StringComparison.Ordinal)
                || string.Equals(f.RelationEntityType, ProductEntityType.Version, StringComparison.OrdinalIgnoreCase));
            if (versionField != null && !string.IsNullOrEmpty(versionId))
                formData[versionField.Key] = versionId;

            if (string.IsNullOrEmpty(title) && string.IsNullOrEmpty(description) && formData.Count == 0
                && customerIds.Count == 0 && string.IsNullOrEmpty(parentId)) return null;

            return new
            {
                title,
                description,
                grade,
                requirementOrigin,
                customerIds,
                parentId,
                formData,
            };
        }
        catch { return null; }
    }

    private static string? MatchCustomerId(List<Customer> customers, string name)
    {
        var q = name.Trim();
        if (q.Length == 0) return null;
        var exact = customers.FirstOrDefault(c => string.Equals(c.Name.Trim(), q, StringComparison.Ordinal));
        if (exact != null) return exact.Id;
        return customers.FirstOrDefault(c => c.Name.Contains(q, StringComparison.OrdinalIgnoreCase)
            || q.Contains(c.Name, StringComparison.OrdinalIgnoreCase))?.Id;
    }

    private static string? MatchRequirementId(List<Requirement> requirements, string title)
    {
        var q = title.Trim();
        if (q.Length == 0) return null;
        var exact = requirements.FirstOrDefault(r => string.Equals(r.Title.Trim(), q, StringComparison.Ordinal));
        if (exact != null) return exact.Id;
        return requirements.FirstOrDefault(r => r.Title.Contains(q, StringComparison.OrdinalIgnoreCase)
            || q.Contains(r.Title, StringComparison.OrdinalIgnoreCase))?.Id;
    }

    private static string? MatchFeatureId(List<Feature> features, string title)
    {
        var q = title.Trim();
        if (q.Length == 0) return null;
        var exact = features.FirstOrDefault(f => string.Equals(f.Title.Trim(), q, StringComparison.Ordinal));
        if (exact != null) return exact.Id;
        var byModule = features.FirstOrDefault(f => !string.IsNullOrWhiteSpace(f.ModuleName)
            && (f.ModuleName.Contains(q, StringComparison.OrdinalIgnoreCase) || q.Contains(f.ModuleName, StringComparison.OrdinalIgnoreCase)));
        if (byModule != null) return byModule.Id;
        return features.FirstOrDefault(f => f.Title.Contains(q, StringComparison.OrdinalIgnoreCase)
            || q.Contains(f.Title, StringComparison.OrdinalIgnoreCase))?.Id;
    }

    private static string? MatchVersionId(List<ProductVersion> versions, string name)
    {
        var q = name.Trim();
        if (q.Length == 0) return null;
        var exact = versions.FirstOrDefault(v => string.Equals(v.VersionName.Trim(), q, StringComparison.Ordinal));
        if (exact != null) return exact.Id;
        return versions.FirstOrDefault(v => v.VersionName.Contains(q, StringComparison.OrdinalIgnoreCase)
            || q.Contains(v.VersionName, StringComparison.OrdinalIgnoreCase))?.Id;
    }

    // ════════════════════════ 批量导入 ════════════════════════

    /// <summary>批量导入需求（来自 CSV 解析后的行）：每行 title 必填，自动绑定默认流程 + 初始状态。</summary>
    [HttpPost("products/{productId}/requirements/import")]
    public async Task<IActionResult> ImportRequirements(string productId, [FromBody] ImportRequirementsRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
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
        var updated = 0;
        foreach (var row in rows)
        {
            var sourceSystem = row.SourceSystem?.Trim().ToLowerInvariant();
            var externalId = row.ExternalId?.Trim();
            var sourceSnapshot = string.IsNullOrWhiteSpace(sourceSystem) || string.IsNullOrWhiteSpace(externalId)
                ? null
                : new RequirementSourceSnapshot
                {
                    Status = row.SourceStatus?.Trim() ?? string.Empty,
                    Priority = row.SourcePriority?.Trim() ?? string.Empty,
                    Fields = row.SourceFields ?? new(),
                    HandlerNames = row.HandlerNames ?? new(),
                    DeveloperNames = row.DeveloperNames ?? new(),
                    CreatorNames = row.CreatorNames ?? new(),
                    CcNames = row.CcNames ?? new(),
                    Comments = (row.Comments ?? new()).Select(comment => new RequirementSourceComment
                    {
                        Author = comment.Author?.Trim() ?? string.Empty,
                        Title = comment.Title?.Trim() ?? string.Empty,
                        Content = comment.Content?.Trim() ?? string.Empty,
                        CreatedAt = ParseImportDate(comment.CreatedAt),
                    }).ToList(),
                    AttachmentIds = row.AttachmentIds ?? new(),
                    SourceCreatedAt = ParseImportDate(row.SourceCreatedAt),
                    SourceModifiedAt = ParseImportDate(row.SourceModifiedAt),
                    SourceCompletedAt = ParseImportDate(row.SourceCompletedAt),
                    ImportedFileName = row.ImportedFileName?.Trim() ?? string.Empty,
                    ImportBatchId = row.ImportBatchId?.Trim() ?? string.Empty,
                    ImportedAt = now,
                };
            Requirement? existing = null;
            if (sourceSnapshot != null)
            {
                existing = await _db.Requirements.Find(r =>
                    r.ProductId == productId &&
                    !r.IsDeleted &&
                    r.SourceSystem == sourceSystem &&
                    r.ExternalId == externalId).FirstOrDefaultAsync()
                  ?? await _db.Requirements.Find(r =>
                    r.ProductId == productId &&
                    !r.IsDeleted &&
                    r.RequirementNo == externalId).FirstOrDefaultAsync();
            }
            var importedState = RequirementWorkflowCatalog.MapImportedStatusLabel(row.SourceStatus) ?? initialState;
            if (existing != null)
            {
                var update = Builders<Requirement>.Update
                    .Set(r => r.Title, row.Title!.Trim())
                    .Set(r => r.Description, row.Description?.Trim())
                    .Set(r => r.Grade, ProductItemGrade.All.Contains(row.Grade ?? "") ? row.Grade! : ProductItemGrade.P2)
                    .Set(r => r.SourceUrl, row.SourceUrl?.Trim())
                    .Set(r => r.SourceSnapshot, sourceSnapshot)
                    .Set(r => r.UpdatedAt, now);
                if (!string.IsNullOrWhiteSpace(row.SourceStatus))
                    update = update.Set(r => r.CurrentState, importedState).Set(r => r.StateEnteredAt, now);
                if (!string.IsNullOrWhiteSpace(externalId))
                    update = update.Set(r => r.RequirementNo, externalId);
                await _db.Requirements.UpdateOneAsync(r => r.Id == existing.Id, update);
                updated++;
                continue;
            }
            var req = new Requirement
            {
                ProductId = productId,
                RequirementNo = await ResolveImportRequirementNoAsync(productId, externalId),
                Title = row.Title!.Trim(),
                Description = row.Description?.Trim(),
                Grade = ProductItemGrade.All.Contains(row.Grade ?? "") ? row.Grade! : ProductItemGrade.P2,
                WorkflowDefId = wfId,
                CurrentState = importedState,
                StateEnteredAt = now,
                OwnerId = userId,
                SourceSystem = sourceSystem,
                ExternalId = externalId,
                SourceUrl = row.SourceUrl?.Trim(),
                SourceSnapshot = sourceSnapshot,
            };
            await _db.Requirements.InsertOneAsync(req);
            created++;
        }
        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(new { created, updated }));
    }

    [HttpPost("products/{productId}/features/import")]
    public async Task<IActionResult> ImportFeatures(string productId, [FromBody] ImportSimpleItemsRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).AnyAsync())
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        var rows = ValidateSimpleImportRows(request);
        if (rows.Result != null) return rows.Result;

        var userId = GetUserId();
        var (_, workflowId) = await ResolveDefaultsAsync(ProductEntityType.Feature, productId);
        var initialState = await ResolveInitialStateAsync(workflowId);
        var created = 0;
        var updated = 0;
        foreach (var row in rows.Rows!)
        {
            var sourceSystem = NormalizeImportSource(row.SourceSystem);
            var externalId = row.ExternalId?.Trim();
            var existing = string.IsNullOrWhiteSpace(externalId)
                ? null
                : await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted &&
                    f.SourceSystem == sourceSystem && f.ExternalId == externalId).FirstOrDefaultAsync();
            if (existing != null)
            {
                await _db.Features.UpdateOneAsync(f => f.Id == existing.Id,
                    Builders<Feature>.Update
                        .Set(f => f.Title, row.Title!.Trim())
                        .Set(f => f.Description, row.Description?.Trim())
                        .Set(f => f.Grade, NormalizeImportGrade(row.Grade))
                        .Set(f => f.UpdatedAt, DateTime.UtcNow));
                updated++;
                continue;
            }
            await _db.Features.InsertOneAsync(new Feature
            {
                ProductId = productId,
                FeatureNo = await GenerateNoAsync("FEA", _db.Features, "FeatureNo"),
                Title = row.Title!.Trim(),
                Description = row.Description?.Trim(),
                Grade = NormalizeImportGrade(row.Grade),
                CurrentState = string.IsNullOrWhiteSpace(row.Status) ? initialState : row.Status.Trim(),
                WorkflowDefId = workflowId,
                StateEnteredAt = DateTime.UtcNow,
                OwnerId = userId,
                SourceSystem = sourceSystem,
                ExternalId = externalId,
            });
            created++;
        }
        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(new { created, updated }));
    }

    /// <summary>按目录路径导入功能树（无限层级，路径分隔符 / 或 &gt;）。缺省上级节点自动补齐。</summary>
    [HttpPost("products/{productId}/features/import-tree")]
    public async Task<IActionResult> ImportFeatureTree(string productId, [FromBody] ImportFeatureTreeRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).AnyAsync())
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        if (request.Rows == null || request.Rows.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "导入数据不能为空"));
        var releaseId = request.OfficialReleaseId?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(releaseId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择归属的正式版本"));
        if (!await _db.ProductReleases.Find(r => r.Id == releaseId && r.ProductId == productId && !r.IsDeleted).AnyAsync())
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "正式版本不存在"));

        var userId = GetUserId();
        var (_, workflowId) = await ResolveDefaultsAsync(ProductEntityType.Feature, productId);
        var initialState = await ResolveInitialStateAsync(workflowId);
        const string treeSource = "tree-import";
        var treePrefix = $"tree:{releaseId}:";
        var pathToId = new Dictionary<string, string>(StringComparer.Ordinal);
        var existingTree = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted && f.SourceSystem == treeSource && f.OfficialReleaseId == releaseId).ToListAsync();
        foreach (var feat in existingTree)
        {
            if (!string.IsNullOrWhiteSpace(feat.ExternalId) && feat.ExternalId.StartsWith(treePrefix, StringComparison.Ordinal))
                pathToId[feat.ExternalId[treePrefix.Length..]] = feat.Id;
        }

        var ordered = request.Rows
            .Select(r =>
            {
                var path = NormalizeFeatureTreePath(r.Path);
                return new { Row = r, Path = path, Segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries) };
            })
            .Where(x => x.Segments.Length > 0)
            .OrderBy(x => x.Segments.Length)
            .ThenBy(x => x.Path, StringComparer.Ordinal)
            .ToList();

        var created = 0;
        var updated = 0;
        foreach (var item in ordered)
        {
            var row = item.Row;
            var segments = item.Segments;
            string? parentId = null;
            for (var depth = 0; depth < segments.Length; depth++)
            {
                var partialPath = string.Join('/', segments.Take(depth + 1));
                var isLeaf = depth == segments.Length - 1;
                if (pathToId.TryGetValue(partialPath, out var knownId))
                {
                    if (isLeaf)
                    {
                        var title = string.IsNullOrWhiteSpace(row.Title) ? segments[^1] : row.Title!.Trim();
                        await _db.Features.UpdateOneAsync(f => f.Id == knownId,
                            Builders<Feature>.Update
                                .Set(f => f.Title, title)
                                .Set(f => f.ParentId, parentId)
                                .Set(f => f.OfficialReleaseId, releaseId)
                                .Set(f => f.Description, row.Description?.Trim())
                                .Set(f => f.ModuleName, ResolveTreeModuleName(row.ModuleName, segments))
                                .Set(f => f.FeatureType, NormalizeImportFeatureType(row.FeatureType))
                                .Set(f => f.Grade, NormalizeImportGrade(row.Grade))
                                .Set(f => f.KeyRules, row.KeyRules?.Trim() ?? "")
                                .Set(f => f.AcceptanceCriteria, row.AcceptanceCriteria?.Trim() ?? "")
                                .Set(f => f.UpdatedAt, DateTime.UtcNow));
                        updated++;
                    }
                    else
                    {
                        await _db.Features.UpdateOneAsync(f => f.Id == knownId,
                            Builders<Feature>.Update
                                .Set(f => f.ParentId, parentId)
                                .Set(f => f.OfficialReleaseId, releaseId)
                                .Set(f => f.UpdatedAt, DateTime.UtcNow));
                    }
                    parentId = knownId;
                    continue;
                }

                var nodeTitle = isLeaf && !string.IsNullOrWhiteSpace(row.Title) ? row.Title!.Trim() : segments[depth];
                var lookupExternal = isLeaf && !string.IsNullOrWhiteSpace(row.ExternalId)
                    ? row.ExternalId.Trim()
                    : $"{treePrefix}{partialPath}";
                var matched = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted && f.SourceSystem == treeSource
                    && f.OfficialReleaseId == releaseId
                    && (f.ExternalId == lookupExternal || f.ExternalId == $"{treePrefix}{partialPath}")).FirstOrDefaultAsync();
                if (matched != null)
                {
                    pathToId[partialPath] = matched.Id;
                    if (isLeaf)
                    {
                        await _db.Features.UpdateOneAsync(f => f.Id == matched.Id,
                            Builders<Feature>.Update
                                .Set(f => f.Title, nodeTitle)
                                .Set(f => f.ParentId, parentId)
                                .Set(f => f.OfficialReleaseId, releaseId)
                                .Set(f => f.Description, row.Description?.Trim())
                                .Set(f => f.ModuleName, ResolveTreeModuleName(row.ModuleName, segments))
                                .Set(f => f.FeatureType, NormalizeImportFeatureType(row.FeatureType))
                                .Set(f => f.Grade, NormalizeImportGrade(row.Grade))
                                .Set(f => f.KeyRules, row.KeyRules?.Trim() ?? "")
                                .Set(f => f.AcceptanceCriteria, row.AcceptanceCriteria?.Trim() ?? "")
                                .Set(f => f.UpdatedAt, DateTime.UtcNow));
                        updated++;
                    }
                    else if (matched.ParentId != parentId)
                    {
                        await _db.Features.UpdateOneAsync(f => f.Id == matched.Id,
                            Builders<Feature>.Update
                                .Set(f => f.ParentId, parentId)
                                .Set(f => f.OfficialReleaseId, releaseId)
                                .Set(f => f.UpdatedAt, DateTime.UtcNow));
                    }
                    parentId = matched.Id;
                    continue;
                }

                var feature = new Feature
                {
                    ProductId = productId,
                    FeatureNo = await GenerateNoAsync("FEA", _db.Features, "FeatureNo"),
                    Title = nodeTitle,
                    Description = isLeaf ? row.Description?.Trim() : null,
                    ModuleName = ResolveTreeModuleName(row.ModuleName, segments),
                    FeatureType = isLeaf ? NormalizeImportFeatureType(row.FeatureType) : FeatureBusinessType.Basic,
                    Grade = isLeaf ? NormalizeImportGrade(row.Grade) : ProductItemGrade.P3,
                    KeyRules = isLeaf ? row.KeyRules?.Trim() ?? "" : "",
                    AcceptanceCriteria = isLeaf ? row.AcceptanceCriteria?.Trim() ?? "" : "",
                    ParentId = parentId,
                    OfficialReleaseId = releaseId,
                    WorkflowDefId = workflowId,
                    CurrentState = initialState,
                    StateEnteredAt = DateTime.UtcNow,
                    OwnerId = userId,
                    SourceSystem = treeSource,
                    ExternalId = lookupExternal,
                };
                await _db.Features.InsertOneAsync(feature);
                pathToId[partialPath] = feature.Id;
                parentId = feature.Id;
                created++;
            }
        }

        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(new { created, updated, officialReleaseId = releaseId }));
    }

    [HttpPost("products/{productId}/versions/import")]
    public async Task<IActionResult> ImportVersions(string productId, [FromBody] ImportSimpleItemsRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).AnyAsync())
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        var rows = ValidateSimpleImportRows(request);
        if (rows.Result != null) return rows.Result;

        var userId = GetUserId();
        var created = 0;
        var updated = 0;
        foreach (var row in rows.Rows!)
        {
            var sourceSystem = NormalizeImportSource(row.SourceSystem);
            var externalId = row.ExternalId?.Trim();
            var lifecycle = ProductVersionLifecycle.All.Contains(row.Status ?? "")
                ? row.Status!
                : ProductVersionLifecycle.Planning;
            var existing = string.IsNullOrWhiteSpace(externalId)
                ? null
                : await _db.ProductVersions.Find(v => v.ProductId == productId && !v.IsDeleted &&
                    v.SourceSystem == sourceSystem && v.ExternalId == externalId).FirstOrDefaultAsync();
            if (existing != null)
            {
                await _db.ProductVersions.UpdateOneAsync(v => v.Id == existing.Id,
                    Builders<ProductVersion>.Update
                        .Set(v => v.VersionName, row.Title!.Trim())
                        .Set(v => v.Description, row.Description?.Trim())
                        .Set(v => v.Lifecycle, lifecycle)
                        .Set(v => v.PlannedReleaseAt, ParseImportDate(row.PlannedAt))
                        .Set(v => v.ReleasedAt, ParseImportDate(row.CompletedAt))
                        .Set(v => v.UpdatedAt, DateTime.UtcNow));
                updated++;
                continue;
            }
            await _db.ProductVersions.InsertOneAsync(new ProductVersion
            {
                ProductId = productId,
                VersionName = row.Title!.Trim(),
                Description = row.Description?.Trim(),
                Lifecycle = lifecycle,
                IsMajor = string.Equals(row.Grade, "major", StringComparison.OrdinalIgnoreCase),
                PlannedReleaseAt = ParseImportDate(row.PlannedAt),
                ReleasedAt = ParseImportDate(row.CompletedAt),
                OwnerId = userId,
                SourceSystem = sourceSystem,
                ExternalId = externalId,
            });
            created++;
        }
        await RecalcProductCountsAsync(productId);
        return Ok(ApiResponse<object>.Ok(new { created, updated }));
    }

    [HttpPost("products/{productId}/defects/import")]
    public async Task<IActionResult> ImportDefects(string productId, [FromBody] ImportSimpleItemsRequest request)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).AnyAsync())
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "产品不存在"));
        var rows = ValidateSimpleImportRows(request);
        if (rows.Result != null) return rows.Result;

        var userId = GetUserId();
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var created = 0;
        var updated = 0;
        foreach (var row in rows.Rows!)
        {
            var sourceSystem = NormalizeImportSource(row.SourceSystem);
            var externalId = row.ExternalId?.Trim();
            var status = RequirementWorkflowCatalog.MapImportedStatusLabel(row.Status)
                ?? DefectWorkflowCatalog.NormalizeStateKey(row.Status)
                ?? (DefectStatus.All.Contains(row.Status ?? "") ? DefectWorkflowCatalog.LegacyStateMap.GetValueOrDefault(row.Status!, RequirementWorkflowCatalog.New) : RequirementWorkflowCatalog.New);
            var existing = string.IsNullOrWhiteSpace(externalId)
                ? null
                : await _db.DefectReports.Find(d => d.TracedProductId == productId && !d.IsDeleted &&
                    d.ProductSourceSystem == sourceSystem && d.ProductExternalId == externalId).FirstOrDefaultAsync()
                  ?? await _db.DefectReports.Find(d => d.TracedProductId == productId && !d.IsDeleted &&
                    d.DefectNo == externalId).FirstOrDefaultAsync();
            var rawTapdSeverity = row.TapdSeverityRaw?.Trim();
            string? severityLevel = null;
            if (!string.IsNullOrWhiteSpace(row.Severity) && DefectSeverityCatalog.AllLevels.Contains(row.Severity.Trim()))
                severityLevel = row.Severity.Trim();
            else if (!string.IsNullOrWhiteSpace(rawTapdSeverity))
                severityLevel = DefectSeverityCatalog.TryNormalizeTapdToLevel(rawTapdSeverity);
            var structuredPatch = DefectSeverityCatalog.BuildImportStructuredPatch(rawTapdSeverity, severityLevel);
            if (!string.IsNullOrWhiteSpace(externalId))
            {
                structuredPatch = TapdDefectFieldCatalog.MergeStructuredData(structuredPatch,
                    new Dictionary<string, string> { [TapdDefectFieldCatalog.DefectId] = externalId });
            }
            if (existing != null)
            {
                var u = Builders<DefectReport>.Update
                    .Set(d => d.Title, row.Title!.Trim())
                    .Set(d => d.RawContent, row.Description?.Trim() ?? string.Empty)
                    .Set(d => d.Status, status)
                    .Set(d => d.UpdatedAt, DateTime.UtcNow);
                if (structuredPatch.Count > 0)
                {
                    var mergedStructured = TapdDefectFieldCatalog.MergeStructuredData(existing.StructuredData, structuredPatch);
                    u = u.Set(d => d.StructuredData, mergedStructured);
                }
                if (!string.IsNullOrWhiteSpace(externalId))
                    u = u.Set(d => d.DefectNo, externalId).Set(d => d.ProductExternalId, externalId).Set(d => d.ProductSourceSystem, sourceSystem);
                await _db.DefectReports.UpdateOneAsync(d => d.Id == existing.Id, u);
                updated++;
                continue;
            }
            var (_, defectWfId) = await ResolveDefaultsAsync(ProductEntityType.Defect, productId);
            await _db.DefectReports.InsertOneAsync(new DefectReport
            {
                DefectNo = await ResolveImportDefectNoAsync(productId, externalId),
                Title = row.Title!.Trim(),
                RawContent = row.Description?.Trim() ?? string.Empty,
                Status = status,
                ReporterId = userId,
                ReporterName = user?.DisplayName,
                TracedProductId = productId,
                WorkflowDefId = defectWfId,
                ProductSourceSystem = sourceSystem,
                ProductExternalId = externalId,
                StructuredData = structuredPatch,
            });
            created++;
        }
        await RecalcDefectCountAsync(productId);
        return Ok(ApiResponse<object>.Ok(new { created, updated }));
    }

    private (List<ImportSimpleItemRow>? Rows, IActionResult? Result) ValidateSimpleImportRows(ImportSimpleItemsRequest request)
    {
        var rows = (request.Rows ?? new()).Where(r => !string.IsNullOrWhiteSpace(r.Title)).ToList();
        if (rows.Count == 0)
            return (null, BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有可导入的有效行（标题不能为空）")));
        if (rows.Count > 500)
            return (null, BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "单次最多导入 500 条")));
        return (rows, null);
    }

    private static string NormalizeImportSource(string? value)
        => string.IsNullOrWhiteSpace(value) ? "csv" : value.Trim().ToLowerInvariant();

    private static string NormalizeFeatureTreePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        var normalized = path.Trim()
            .Replace('\\', '/')
            .Replace(">", "/");
        var parts = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return string.Join('/', parts);
    }

    private static string ResolveTreeModuleName(string? moduleName, string[] segments)
        => string.IsNullOrWhiteSpace(moduleName) ? (segments.Length > 0 ? segments[0] : "") : moduleName.Trim();

    private static string NormalizeImportFeatureType(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return FeatureBusinessType.Basic;
        var v = value.Trim().ToLowerInvariant();
        return v switch
        {
            "core" or "核心" or "核心功能" => FeatureBusinessType.Core,
            "value_added" or "value-added" or "增值" or "增值功能" => FeatureBusinessType.ValueAdded,
            "basic" or "基础" or "基础功能" => FeatureBusinessType.Basic,
            _ => FeatureBusinessType.All.Contains(v) ? v : FeatureBusinessType.Basic,
        };
    }

    private static string NormalizeImportGrade(string? value)
        => ProductItemGrade.All.Contains(value ?? "") ? value! : ProductItemGrade.P2;

    private static DateTime? ParseImportDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!DateTime.TryParse(value, out var parsed)) return null;
        var unspecified = DateTime.SpecifyKind(parsed, DateTimeKind.Unspecified);
        return new DateTimeOffset(unspecified, TimeSpan.FromHours(8)).UtcDateTime;
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
        var feats = await _db.Features.Find(f => f.ProductId == productId && !f.IsDeleted).ToListAsync();
        var defects = await _db.DefectReports.Find(Builders<DefectReport>.Filter.And(
                Builders<DefectReport>.Filter.Eq(d => d.TracedProductId, productId),
                Builders<DefectReport>.Filter.Eq(d => d.IsDeleted, false)))
            .Limit(5000).ToListAsync();

        // 需求 / 功能流程定义（拿状态分类 + 终态标签）
        var (_, reqWfId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);
        var (_, featWfId) = await ResolveDefaultsAsync(ProductEntityType.Feature, productId);
        var defIds = new[] { reqWfId, featWfId }.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).Distinct().ToList();
        var defs = defIds.Count == 0 ? new List<ProductWorkflowDefinition>()
            : await _db.ProductWorkflowDefinitions.Find(w => defIds.Contains(w.Id) && !w.IsDeleted).ToListAsync();
        var reqDef = defs.FirstOrDefault(d => d.Id == reqWfId);
        var reqStates = reqDef?.States.ToDictionary(s => s.Key, s => s) ?? new();
        string CatOf(string? key)
        {
            var normalized = RequirementWorkflowCatalog.NormalizeStateKey(key, reqDef);
            return normalized != null && reqStates.TryGetValue(normalized, out var s)
                ? (s.Category ?? (s.IsFinal ? "done" : "todo"))
                : "todo";
        }

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

        // 规模/分布统计（原工作台数据展示区迁入报表，口径与 overview/stats 一致）
        var counts = new
        {
            versions = versions.Count,
            requirements = reqs.Count,
            features = feats.Count,
            defects = defects.Count,
        };
        var requirementsByGrade = ProductItemGrade.All.ToDictionary(g => g, g => reqs.Count(r => r.Grade == g));
        var defectsByStatus = defects.GroupBy(d => d.Status).ToDictionary(g => g.Key, g => g.Count());
        var versionsByLifecycle = ProductVersionLifecycle.All.ToDictionary(l => l, l => versions.Count(v => v.Lifecycle == l));

        return Ok(ApiResponse<object>.Ok(new { releaseProgress, overall, velocity, counts, requirementsByGrade, defectsByStatus, versionsByLifecycle }));
    }

    // ════════════════════════ 用户偏好（工作台快捷操作） ════════════════════════

    /// <summary>读取产品管理智能体用户偏好（用户级，跨产品共用）。</summary>
    [HttpGet("preferences")]
    public async Task<IActionResult> GetProductAgentPreferences()
    {
        var userId = GetUserId();
        var prefs = await _db.UserPreferences.Find(x => x.UserId == userId).FirstOrDefaultAsync();
        // quickActionIds 为 null 表示从未配置（前端走默认）；空数组表示用户主动清空。
        return Ok(ApiResponse<object>.Ok(new
        {
            quickActionIds = prefs?.ProductAgentPreferences?.QuickActionIds,
        }));
    }

    /// <summary>更新工作台「快捷操作」配置。id 对应前端 quickActionRegistry，后端只存有序字符串列表（上限 50）。</summary>
    [HttpPut("preferences/quick-actions")]
    public async Task<IActionResult> UpdateProductAgentQuickActions([FromBody] UpdateQuickActionsRequest request)
    {
        var userId = GetUserId();
        var ids = (request.QuickActionIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct()
            .Take(50)
            .ToList();

        var update = Builders<UserPreferences>.Update
            .Set(x => x.ProductAgentPreferences, new ProductAgentPreferences { QuickActionIds = ids })
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { quickActionIds = ids }));
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

    /// <summary>能否管理/查看全部产品：应用管理员或具备原产品管理权限。</summary>
    private async Task<bool> CanManageAsync(string userId)
        => await IsProductApplicationAdminAsync(userId)
            || HasPermission(AdminPermissionCatalog.ProductAgentManage);

    /// <summary>能否管理本产品成员（增删普通成员）：全局管理 | 产品负责人 | 产品管理员。</summary>
    private async Task<bool> CanManageProductMembersAsync(Product p, string uid)
        => await CanManageAsync(uid) || p.OwnerId == uid || p.AdminIds.Contains(uid);

    /// <summary>能否指派/撤销产品管理员：全局管理 | 产品负责人（产品管理员不可指派同级）。</summary>
    private async Task<bool> CanManageProductAdminsAsync(Product p, string uid)
        => await CanManageAsync(uid) || p.OwnerId == uid;

    /// <summary>可访问的产品 Id 集合；返回 null 表示"全部"（管理层/管理权限）。</summary>
    private async Task<HashSet<string>?> GetAccessibleProductIdsAsync(string userId)
    {
        if (await CanManageAsync(userId)) return null;
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
            isAdmin = await IsProductApplicationAdminAsync(userId),
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
        var defById = await LoadWorkflowDefsByIdsAsync(items.Select(r => r.WorkflowDefId));
        var rows = items
            .Where(r => string.IsNullOrWhiteSpace(grade) || r.Grade == grade)
            .Where(r => !mine || r.AssigneeId == userId)
            .Where(r => string.IsNullOrWhiteSpace(keyword) || (r.Title?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false) || r.RequirementNo.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(r => r.UpdatedAt)
            .Select(r =>
            {
                defById.TryGetValue(r.WorkflowDefId ?? "", out var def);
                var stateKey = RequirementWorkflowCatalog.NormalizeStateKey(r.CurrentState, def);
                return new
                {
                    r.Id,
                    r.ProductId,
                    productName = names.GetValueOrDefault(r.ProductId, ""),
                    r.RequirementNo,
                    r.Title,
                    r.Grade,
                    currentState = stateKey,
                    stateLabel = RequirementWorkflowCatalog.ResolveStateLabel(stateKey, def),
                    versionCount = r.VersionIds.Count,
                    customerCount = r.CustomerIds.Count,
                    r.AssigneeId,
                    assigneeName = r.AssigneeId == null ? null : userNames.GetValueOrDefault(r.AssigneeId, ""),
                    r.UpdatedAt,
                };
            })
            .Take(1000).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    /// <summary>跨产品版本列表（含所属产品名）。</summary>
    [HttpGet("overview/versions")]
    public async Task<IActionResult> OverviewVersions([FromQuery] string? lifecycle = null, [FromQuery] string? keyword = null)
    {
        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var items = await FindInScopeAsync<ProductVersion>(scope, v => v.ProductId, v => v.IsDeleted);
        var names = await ProductNamesAsync(items.Select(v => v.ProductId));
        var rows = items
            .Where(v => string.IsNullOrWhiteSpace(lifecycle) || v.Lifecycle == lifecycle)
            .Where(v => string.IsNullOrWhiteSpace(keyword) ||
                v.VersionName.Contains(keyword, StringComparison.OrdinalIgnoreCase) ||
                (v.ExternalId?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false))
            .OrderByDescending(v => v.UpdatedAt)
            .Select(v => new
            {
                v.Id,
                v.ProductId,
                productName = names.GetValueOrDefault(v.ProductId, ""),
                v.VersionName,
                v.Lifecycle,
                v.IsMajor,
                requirementCount = v.RequirementIds.Count,
                featureCount = v.FeatureVersionIds.Count,
                v.ExternalId,
                v.PlannedReleaseAt,
                v.ReleasedAt,
                v.UpdatedAt,
            })
            .Take(1000).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    /// <summary>跨产品正式版本（V 号）列表。</summary>
    [HttpGet("overview/releases")]
    public async Task<IActionResult> OverviewReleases([FromQuery] string? keyword = null)
    {
        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var items = await FindInScopeAsync<ProductRelease>(scope, r => r.ProductId, r => r.IsDeleted);
        var names = await ProductNamesAsync(items.Select(r => r.ProductId));
        var rows = items
            .Where(r => string.IsNullOrWhiteSpace(keyword) ||
                r.VCode.Contains(keyword, StringComparison.OrdinalIgnoreCase) ||
                (r.TCode?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false) ||
                r.PlanName.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(r => r.UpdatedAt)
            .Select(r => new
            {
                r.Id,
                r.ProductId,
                productName = names.GetValueOrDefault(r.ProductId, ""),
                r.VCode,
                r.TCode,
                r.PlanName,
                r.VersionType,
                r.Status,
                r.PlannedReleaseAt,
                requirementCount = r.RequirementIds.Count,
                r.InitiationId,
                r.UpdatedAt,
            })
            .Take(1000).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    /// <summary>跨产品内部版本立项（T 号）列表。</summary>
    [HttpGet("overview/initiations")]
    public async Task<IActionResult> OverviewInitiations([FromQuery] string? keyword = null)
    {
        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var items = await FindInScopeAsync<ProductInitiation>(scope, i => i.ProductId, i => i.IsDeleted);
        var names = await ProductNamesAsync(items.Select(i => i.ProductId));
        var rows = items
            .Where(i => string.IsNullOrWhiteSpace(keyword) ||
                (i.TCode?.Contains(keyword, StringComparison.OrdinalIgnoreCase) ?? false) ||
                i.PlanName.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(i => i.UpdatedAt)
            .Select(i => new
            {
                i.Id,
                i.ProductId,
                productName = names.GetValueOrDefault(i.ProductId, ""),
                i.TCode,
                i.PlanName,
                i.VersionType,
                i.Status,
                requirementCount = i.RequirementIds.Count,
                i.UpdatedAt,
            })
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
            .Select(d => new {
                d.Id,
                productId = d.TracedProductId,
                productName = names.GetValueOrDefault(d.TracedProductId ?? "", ""),
                d.DefectNo,
                d.Title,
                d.Status,
                grade = d.Grade,
                severityTier = d.StructuredData.GetValueOrDefault(TapdDefectFieldCatalog.DefectSeverity),
                structuredData = d.StructuredData,
                d.TracedRequirementId,
                d.TracedVersionId,
                d.UpdatedAt,
            })
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

    /// <summary>
    /// 管理层总览：跨产品聚合知识列表（分页 + 关键词/分类/标签/产品过滤）。
    /// 与单产品知识列表同构，只是数据范围跨全部可访问产品，并多带「所属产品」。
    /// </summary>
    [HttpGet("overview/knowledge/entries")]
    public async Task<IActionResult> OverviewKnowledgeEntries(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? keyword = null,
        [FromQuery] string? category = null,
        [FromQuery] string? tag = null,
        [FromQuery] string? productId = null)
    {
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var scope = await GetAccessibleProductIdsAsync(GetUserId());
        var pf = Builders<Product>.Filter.Eq(p => p.IsDeleted, false);
        if (scope != null) pf &= Builders<Product>.Filter.In(p => p.Id, scope);
        if (!string.IsNullOrWhiteSpace(productId)) pf &= Builders<Product>.Filter.Eq(p => p.Id, productId);
        var products = await _db.Products.Find(pf).Limit(2000).ToListAsync();
        var productByStoreId = products
            .Where(p => !string.IsNullOrEmpty(p.KnowledgeStoreId))
            .ToDictionary(p => p.KnowledgeStoreId!, p => p);
        if (productByStoreId.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { items = Array.Empty<object>(), total = 0L, page, pageSize }));

        var fb = Builders<DocumentEntry>.Filter;
        var filter = fb.In(e => e.StoreId, productByStoreId.Keys) & fb.Eq(e => e.IsFolder, false);
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = System.Text.RegularExpressions.Regex.Escape(keyword.Trim());
            filter &= fb.Or(
                fb.Regex(e => e.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                fb.Regex(e => e.Summary, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                fb.Regex(e => e.ContentIndex, new MongoDB.Bson.BsonRegularExpression(kw, "i")));
        }
        if (!string.IsNullOrWhiteSpace(category))
            filter &= category == "__none__"
                ? fb.Or(fb.Eq(e => e.Category, null), fb.Eq(e => e.Category, string.Empty), fb.Exists(e => e.Category, false))
                : fb.Eq(e => e.Category, category);
        if (!string.IsNullOrWhiteSpace(tag))
            filter &= fb.AnyEq(e => e.Tags, tag);

        var total = await _db.DocumentEntries.CountDocumentsAsync(filter);
        var entries = await _db.DocumentEntries.Find(filter)
            .SortByDescending(e => e.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        var items = entries.Select(e => new
        {
            entry = e,
            productId = productByStoreId.TryGetValue(e.StoreId, out var p) ? p.Id : null,
            productName = productByStoreId.TryGetValue(e.StoreId, out var p2) ? p2.Name : null,
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
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
            nodes.Add(new { id = $"defect:{d.Id}", type = "defect", label = d.Title ?? d.DefectNo, sub = d.DefectNo, grade = d.Grade, severityTier = d.StructuredData.GetValueOrDefault(TapdDefectFieldCatalog.DefectSeverity), state = d.Status, productId = d.TracedProductId });
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

    /// <summary>解析 TAPD 风格纯数字 ID（如 1007157）。</summary>
    private static bool TryParseTapdNumericId(string? value, out long id)
    {
        id = 0;
        if (string.IsNullOrWhiteSpace(value)) return false;
        return long.TryParse(value.Trim(), out id) && id > 0;
    }

    /// <summary>下一需求 ID：取本产品下 RequirementNo / ExternalId 最大纯数字 + 1（与 TAPD 规则一致）。</summary>
    private async Task<string> GenerateNextTapdStyleRequirementIdAsync(string productId)
    {
        var items = await _db.Requirements
            .Find(r => r.ProductId == productId && !r.IsDeleted)
            .Project(r => new { r.RequirementNo, r.ExternalId })
            .ToListAsync();
        long max = 0;
        foreach (var item in items)
        {
            if (TryParseTapdNumericId(item.RequirementNo, out var no) && no > max) max = no;
            if (TryParseTapdNumericId(item.ExternalId, out var ext) && ext > max) max = ext;
        }
        return (max + 1).ToString();
    }

    /// <summary>下一缺陷 ID：取本产品下 DefectNo / ProductExternalId 最大纯数字 + 1。</summary>
    private async Task<string> GenerateNextTapdStyleDefectIdAsync(string productId)
    {
        var items = await _db.DefectReports
            .Find(d => d.TracedProductId == productId && !d.IsDeleted)
            .Project(d => new { d.DefectNo, d.ProductExternalId })
            .ToListAsync();
        long max = 0;
        foreach (var item in items)
        {
            if (TryParseTapdNumericId(item.DefectNo, out var no) && no > max) max = no;
            if (TryParseTapdNumericId(item.ProductExternalId, out var ext) && ext > max) max = ext;
        }
        return (max + 1).ToString();
    }

    /// <summary>导入需求 ID：有 TAPD 外部 ID 时原样使用，否则在本产品现有最大 ID 基础上 +1。</summary>
    private async Task<string> ResolveImportRequirementNoAsync(string productId, string? externalId)
    {
        if (!string.IsNullOrWhiteSpace(externalId))
            return externalId.Trim();
        return await GenerateNextTapdStyleRequirementIdAsync(productId);
    }

    /// <summary>导入缺陷 ID：有 TAPD 外部 ID 时原样使用，否则在本产品现有最大 ID 基础上 +1。</summary>
    private async Task<string> ResolveImportDefectNoAsync(string productId, string? externalId)
    {
        if (!string.IsNullOrWhiteSpace(externalId))
            return externalId.Trim();
        return await GenerateNextTapdStyleDefectIdAsync(productId);
    }

    /// <summary>按 {PREFIX}-{YEAR}-{NNNN} 生成业务编号。fieldName 为编号字段名（FieldDefinition 由 string 隐式转换）。</summary>
    private static async Task<string> GenerateNoAsync<T>(string prefix, IMongoCollection<T> coll, string fieldName)
    {
        var year = DateTime.UtcNow.Year;
        var full = $"{prefix}-{year}-";
        var filter = Builders<T>.Filter.Regex(fieldName, new MongoDB.Bson.BsonRegularExpression($"^{full}"));
        var count = await coll.CountDocumentsAsync(filter);
        return $"{full}{(count + 1):D4}";
    }

    private static string NormalizeVersionType(string? value) =>
        value?.Trim().ToLowerInvariant() switch
        {
            "major" or "大版本" => "major",
            "medium" or "中版本" => "medium",
            _ => "minor",
        };

    private async Task<string> GenerateWorkflowCodeAsync(string productId, string prefix, string versionType)
    {
        var codes = prefix == "T"
            ? (await _db.ProductInitiations.Find(x => x.ProductId == productId && x.TCode != null && !x.IsDeleted).Project(x => x.TCode!).ToListAsync())
            : (await _db.ProductReleases.Find(x => x.ProductId == productId && x.VCode != "" && !x.IsDeleted).Project(x => x.VCode).ToListAsync());
        var max = new[] { 0, 0, 0 };
        foreach (var code in codes)
        {
            var parts = code.TrimStart('T', 't', 'V', 'v').Split('.');
            if (parts.Length != 3 || !int.TryParse(parts[0], out var a) || !int.TryParse(parts[1], out var b) || !int.TryParse(parts[2], out var c)) continue;
            if (a > max[0] || a == max[0] && b > max[1] || a == max[0] && b == max[1] && c > max[2])
                max = new[] { a, b, c };
        }
        switch (NormalizeVersionType(versionType))
        {
            case "major": max = new[] { max[0] + 1, 0, 0 }; break;
            case "medium": max = new[] { max[0], max[1] + 1, 0 }; break;
            default: max[2]++; break;
        }
        return $"{prefix}{max[0]}.{max[1]}.{max[2]}";
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
            case ProductEntityType.Defect:
                await _db.DefectReports.UpdateOneAsync(x => x.Id == entityId,
                    Builders<DefectReport>.Update.Set(x => x.WorkflowDefId, workflowDefId).Set(x => x.Status, currentState ?? RequirementWorkflowCatalog.New));
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

    private async Task<(bool InApprovedInitiation, bool InCompletedRelease)> LoadRequirementLinkageAsync(string productId, string requirementId)
    {
        var inApproved = await _db.ProductInitiations.Find(x =>
                x.ProductId == productId && !x.IsDeleted && x.Status == "approved"
                && !string.IsNullOrWhiteSpace(x.TCode) && x.RequirementIds.Contains(requirementId))
            .AnyAsync();
        var inReleased = await _db.ProductReleases.Find(x =>
                x.ProductId == productId && !x.IsDeleted && x.Status == "released"
                && x.RequirementIds.Contains(requirementId))
            .AnyAsync();
        return (inApproved, inReleased);
    }

    private async Task<bool> ValidateInitiationForRequirementAsync(string productId, string requirementId, string initiationId)
    {
        var item = await _db.ProductInitiations.Find(x => x.Id == initiationId && x.ProductId == productId && !x.IsDeleted).FirstOrDefaultAsync();
        return item != null && item.Status == "approved" && !string.IsNullOrWhiteSpace(item.TCode);
    }

    private Task LinkRequirementToInitiationAsync(string initiationId, string requirementId)
        => _db.ProductInitiations.UpdateOneAsync(x => x.Id == initiationId,
            Builders<ProductInitiation>.Update.AddToSet(x => x.RequirementIds, requirementId).Set(x => x.UpdatedAt, DateTime.UtcNow));

    private async Task<bool> ValidateReleaseForRequirementAsync(string productId, string requirementId, string releaseId)
    {
        var item = await _db.ProductReleases.Find(x => x.Id == releaseId && x.ProductId == productId && !x.IsDeleted).FirstOrDefaultAsync();
        return item != null && item.Status == "released";
    }

    private Task LinkRequirementToReleaseAsync(string releaseId, string requirementId)
        => _db.ProductReleases.UpdateOneAsync(x => x.Id == releaseId,
            Builders<ProductRelease>.Update.AddToSet(x => x.RequirementIds, requirementId).Set(x => x.UpdatedAt, DateTime.UtcNow));

    private async Task<ProductRelease?> FindLatestReleaseWithManifestAsync(string productId)
    {
        var candidates = await _db.ProductReleases.Find(x =>
                x.ProductId == productId && !x.IsDeleted && x.FeatureManifest.Count > 0)
            .SortByDescending(x => x.ReleasedAt)
            .ThenByDescending(x => x.CreatedAt)
            .Limit(5)
            .ToListAsync();
        return candidates.FirstOrDefault();
    }

    private async Task<List<ReleaseFeatureItem>> ResolveReleaseFeatureManifestAsync(
        string productId,
        List<ReleaseFeatureItem>? requested,
        ProductRelease? previousRelease)
    {
        if (requested is { Count: > 0 })
            return NormalizeReleaseFeatureManifest(requested);
        if (previousRelease == null)
            return new List<ReleaseFeatureItem>();
        return previousRelease.FeatureManifest
            .Where(x => !string.Equals(x.ChangeType, FeatureChangeType.Deprecated, StringComparison.Ordinal))
            .Select(x => new ReleaseFeatureItem
            {
                FeatureId = x.FeatureId,
                ChangeType = FeatureChangeType.Unchanged,
            })
            .ToList();
    }

    private static List<ReleaseFeatureItem> NormalizeReleaseFeatureManifest(IEnumerable<ReleaseFeatureItem> items)
        => items
            .Where(x => !string.IsNullOrWhiteSpace(x.FeatureId))
            .GroupBy(x => x.FeatureId)
            .Select(g => g.Last())
            .ToList();

    private async Task<string?> ValidateReleaseFeatureManifestAsync(string productId, List<ReleaseFeatureItem> manifest)
    {
        var featureIds = manifest.Select(x => x.FeatureId).Distinct().ToList();
        var existing = await _db.Features.Find(f => f.ProductId == productId && featureIds.Contains(f.Id) && !f.IsDeleted)
            .Project(f => f.Id).ToListAsync();
        var existingSet = existing.ToHashSet();
        foreach (var item in manifest)
        {
            if (!existingSet.Contains(item.FeatureId))
                return $"功能 {item.FeatureId} 不存在或已删除";
            if (!string.IsNullOrWhiteSpace(item.ChangeType) && !FeatureChangeType.All.Contains(item.ChangeType))
                return $"无效的功能变更类型：{item.ChangeType}";
        }
        return null;
    }

    private async Task AdvanceRequirementsToStateAsync(
        string productId,
        IEnumerable<string> requirementIds,
        string targetStateKey,
        string userId,
        string activityContent)
    {
        var ids = requirementIds.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToList();
        if (ids.Count == 0) return;

        var reqs = await _db.Requirements.Find(r => ids.Contains(r.Id) && r.ProductId == productId && !r.IsDeleted).ToListAsync();
        if (reqs.Count == 0) return;

        var defId = reqs.Select(r => r.WorkflowDefId).FirstOrDefault(id => !string.IsNullOrWhiteSpace(id));
        if (string.IsNullOrWhiteSpace(defId))
            (_, defId) = await ResolveDefaultsAsync(ProductEntityType.Requirement, productId);
        if (string.IsNullOrWhiteSpace(defId)) return;

        var def = await _db.ProductWorkflowDefinitions.Find(w => w.Id == defId && !w.IsDeleted).FirstOrDefaultAsync();
        if (def == null) return;

        var actorName = (await _db.Users.Find(uu => uu.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        string LabelOf(string? key) => def.States.FirstOrDefault(s => s.Key == key)?.Label ?? key ?? "未设置";
        var toLabel = LabelOf(targetStateKey);
        var now = DateTime.UtcNow;

        foreach (var req in reqs)
        {
            var fromKey = RequirementWorkflowCatalog.NormalizeStateKey(req.CurrentState, def);
            if (fromKey == targetStateKey) continue;
            var hasEdge = def.Transitions.Any(t =>
                t.ToState == targetStateKey && (string.IsNullOrWhiteSpace(t.FromState) || t.FromState == fromKey));
            if (!hasEdge) continue;

            await _db.Requirements.UpdateOneAsync(x => x.Id == req.Id,
                Builders<Requirement>.Update.Set(x => x.CurrentState, targetStateKey).Set(x => x.StateEnteredAt, now).Set(x => x.UpdatedAt, now));
            await RecordActivityAsync(ProductEntityType.Requirement, req.Id, productId, ProductActivityType.Transition, userId, actorName,
                content: activityContent, fromValue: LabelOf(fromKey), toValue: toLabel);
        }
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

public class UpsertRequirementTypeRequest
{
    public string? Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Definition { get; set; }
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

public class CreateInitiationRequest
{
    public string? SystemName { get; set; }
    public string? AppName { get; set; }
    public string ProjectType { get; set; } = "standard";
    public string? CustomerSource { get; set; }
    public string PlanName { get; set; } = string.Empty;
    public string? RequirementDescription { get; set; }
    public string? DepartmentName { get; set; }
    public string? PlanUrl { get; set; }
    public string VersionType { get; set; } = "minor";
    public List<string>? RequirementIds { get; set; }
}

public class SyncInitiationReviewRequest
{
    public string SubmissionId { get; set; } = string.Empty;
}

public class InitiationDecisionRequest
{
    public bool ReviewMeetingRequired { get; set; }
    public DateTime? ExpectedMeetingAt { get; set; }
    public string? PrimaryOwnerId { get; set; }
}

public class ApproveInitiationRequest
{
    public string? Comment { get; set; }
}

public class CreateReleaseRequest
{
    public string? InitiationId { get; set; }
    public bool IsTemporaryOptimization { get; set; }
    public string? PlanName { get; set; }
    public string? OwnerId { get; set; }
    public string? OpenBrandScope { get; set; }
    public List<string>? TeamMemberIds { get; set; }
    public List<string>? AdditionalRequirementIds { get; set; }
    public DateTime? PlannedReleaseAt { get; set; }
    public string? PreviousReleaseId { get; set; }
    public List<ReleaseFeatureItem>? FeatureManifest { get; set; }
}

public class UpdateReleaseFeatureManifestRequest
{
    public string? PreviousReleaseId { get; set; }
    public List<ReleaseFeatureItem>? FeatureManifest { get; set; }
}

public class CompleteReleaseRequest
{
    public string AnnouncementUrl { get; set; } = string.Empty;
}

public class ImportVersionWorkflowRequest
{
    public string Kind { get; set; } = "initiation";
    public List<ImportVersionWorkflowRow> Rows { get; set; } = new();
}

public class ImportVersionWorkflowRow
{
    public string? Code { get; set; }
    public string? TCode { get; set; }
    public string? PlanName { get; set; }
    public string? SystemName { get; set; }
    public string? AppName { get; set; }
    public string? VersionType { get; set; }
    public string? ProjectType { get; set; }
    public string? CustomerSource { get; set; }
    public string? RequirementDescription { get; set; }
    public string? DepartmentName { get; set; }
    public string? OwnerId { get; set; }
    public List<string>? TeamMemberIds { get; set; }
    public string? PlanUrl { get; set; }
    public DateTime? FirstDraftMeetingAt { get; set; }
    public DateTime? SecondDraftMeetingAt { get; set; }
    public DateTime? ThirdDraftMeetingAt { get; set; }
    public DateTime? ProjectAt { get; set; }
    public DateTime? PlannedProjectAt { get; set; }
    public bool? NeedUiDesign { get; set; }
    public bool? IsAiPoc { get; set; }
    public string? DevelopmentStatus { get; set; }
    public string? Remark { get; set; }
    public string? OpenBrandScope { get; set; }
    public string? AnnouncementUrl { get; set; }
    public DateTime? Date { get; set; }
    public Dictionary<string, string>? LegacyData { get; set; }
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
    public string? ModuleName { get; set; }
    public string? FeatureType { get; set; }
    public string? MainRequirementId { get; set; }
    public string? PlannedVersionId { get; set; }
    public string? OfficialReleaseId { get; set; }
    public string? KeyRules { get; set; }
    public string? AcceptanceCriteria { get; set; }
    public string? Remark { get; set; }
    public string? Grade { get; set; }
    public string? ParentId { get; set; }
    public List<string>? RequirementIds { get; set; }
    public string? OwnerId { get; set; }
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
    /// <summary>可选：流转时补填标题（RequiredFieldKeys 含 title 时）</summary>
    public string? Title { get; set; }
    /// <summary>可选：流转时补填分级（RequiredFieldKeys 含 grade 时）</summary>
    public string? Grade { get; set; }
    /// <summary>可选：流转到已排期时关联归属版本</summary>
    public List<string>? VersionIds { get; set; }
    /// <summary>可选：流转到已立项时关联已通过立项单</summary>
    public string? InitiationId { get; set; }
    /// <summary>可选：流转到已上线时关联已完成上线单</summary>
    public string? ReleaseId { get; set; }
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
    public string? SourceSystem { get; set; }
    public string? ExternalId { get; set; }
    public string? SourceUrl { get; set; }
    public string? SourceStatus { get; set; }
    public string? SourcePriority { get; set; }
    public Dictionary<string, string>? SourceFields { get; set; }
    public List<string>? HandlerNames { get; set; }
    public List<string>? DeveloperNames { get; set; }
    public List<string>? CreatorNames { get; set; }
    public List<string>? CcNames { get; set; }
    public List<ImportRequirementComment>? Comments { get; set; }
    public List<string>? AttachmentIds { get; set; }
    public string? SourceCreatedAt { get; set; }
    public string? SourceModifiedAt { get; set; }
    public string? SourceCompletedAt { get; set; }
    public string? ImportedFileName { get; set; }
    public string? ImportBatchId { get; set; }
}

public class ImportRequirementComment
{
    public string? Author { get; set; }
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? CreatedAt { get; set; }
}

public class ImportProductsRequest
{
    /// <summary>行内未指定产品类型时的默认值（支持类型 Id 或名称，如「应用」）。</summary>
    public string? DefaultGrade { get; set; }
    public List<ImportProductRow> Rows { get; set; } = new();
}

public class ImportProductRow
{
    public string? Name { get; set; }
    public string? Grade { get; set; }
    public string? Description { get; set; }
    public string? Code { get; set; }
}

public class ImportFeatureTreeRequest
{
    /// <summary>归属正式版本（ProductRelease.Id），导入的功能清单全部挂在此版本下</summary>
    public string OfficialReleaseId { get; set; } = string.Empty;
    public List<ImportFeatureTreeRow> Rows { get; set; } = new();
}

public class ImportFeatureTreeRow
{
    public string Path { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Grade { get; set; }
    public string? FeatureType { get; set; }
    public string? ModuleName { get; set; }
    public string? Description { get; set; }
    public string? ExternalId { get; set; }
    public string? KeyRules { get; set; }
    public string? AcceptanceCriteria { get; set; }
}

public class ImportSimpleItemsRequest
{
    public List<ImportSimpleItemRow> Rows { get; set; } = new();
}

public class ImportSimpleItemRow
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Grade { get; set; }
    /// <summary>TAPD 导出「严重程度」列原文（紧急/高/中/低/无关紧要）。</summary>
    public string? TapdSeverityRaw { get; set; }
    /// <summary>已映射的 V2.6 严重程度（致命/严重/一般/轻微）；可选。</summary>
    public string? Severity { get; set; }
    public string? Status { get; set; }
    public string? SourceSystem { get; set; }
    public string? ExternalId { get; set; }
    public string? PlannedAt { get; set; }
    public string? CompletedAt { get; set; }
}

public class ProductApplicationAdminRequest
{
    public string UserId { get; set; } = string.Empty;
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
    /// <summary>处理优先级 p0/p1/p2/p3，见 ProductItemGrade（与严重程度独立）</summary>
    public string? Grade { get; set; }
    public string? AssigneeId { get; set; }
    public string? RequirementId { get; set; }
    public string? VersionId { get; set; }
    public string? FeatureId { get; set; }
    /// <summary>缺陷 / 非产品缺陷，见 ProductDefectLinkageCatalog</summary>
    public string? ProductDefectClassification { get; set; }
}

public class UpdateProductDefectRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    /// <summary>处理优先级 p0/p1/p2/p3，见 ProductItemGrade（仅显式传入时更新）</summary>
    public string? Grade { get; set; }
    public string? Status { get; set; }
    public string? AssigneeId { get; set; }
    public string? FeatureId { get; set; }
    public string? VersionId { get; set; }
    /// <summary>缺陷 / 非产品缺陷，见 ProductDefectLinkageCatalog</summary>
    public string? ProductDefectClassification { get; set; }
    /// <summary>TAPD 对齐字段（中文 key），见 TapdDefectFieldCatalog</summary>
    public Dictionary<string, string>? StructuredData { get; set; }
}

public class UpdateQuickActionsRequest
{
    /// <summary>工作台「快捷操作」操作 id 有序列表（对应前端 quickActionRegistry）</summary>
    public List<string>? QuickActionIds { get; set; }
}

public class AssistantAskRequest
{
    /// <summary>用户问题（工作助手问答）</summary>
    public string? Question { get; set; }

    /// <summary>随提问携带的参考文档（前端先调 assistant/attachments 提取文本后回传，最多 3 个）</summary>
    public List<AssistantAttachmentInput>? Attachments { get; set; }
}

public class RelationAnalysisRequest
{
    public string? ProductId { get; set; }
    /// <summary>锚点节点 id（type:rawId），用于访问校验与定位</summary>
    public string? AnchorId { get; set; }
    public List<RelationChainNode> Nodes { get; set; } = new();
    public List<RelationChainEdge> Edges { get; set; } = new();
}

public class RelationChainNode
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public string? Label { get; set; }
    public string? Sub { get; set; }
}

public class RelationChainEdge
{
    public string? Source { get; set; }
    public string? Target { get; set; }
    public string? Type { get; set; }
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
