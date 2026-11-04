using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/product-permissions")]
[Authorize]
[AdminController(AppKey, AdminPermissionCatalog.Access)]
public sealed class ProductPermissionsController : ControllerBase
{
    private const string AppKey = "product-agent";
    private readonly MongoDbContext _db;
    private readonly IAdminPermissionService _permissions;
    public ProductPermissionsController(MongoDbContext db, IAdminPermissionService permissions) { _db = db; _permissions = permissions; }
    private bool IsRoot => User.FindFirst("isRoot")?.Value == "1";
    private async Task<bool> IsMapAdmin(CancellationToken ct)
    {
        if (User.FindFirst("authType")?.Value == "agent-apikey") return false;
        if (IsRoot) return true;
        var user = await _db.Users.Find(x => x.UserId == this.GetRequiredUserId()).FirstOrDefaultAsync(ct);
        return user != null && ProductPermissionRules.IsMapAdministrator(user);
    }
    private async Task<ProductPermissionConfiguration?> Read(CancellationToken ct) => await _db.ProductPermissionConfigurations
        .Find(x => x.Id == ProductPermissionRules.ConfigurationId).FirstOrDefaultAsync(ct);

    [HttpGet("me")]
    public async Task<IActionResult> Me(CancellationToken ct)
    {
        var configuration = await Read(ct);
        var permissions = await _permissions.GetEffectivePermissionsAsync(this.GetRequiredUserId(), IsRoot, ct);
        return Ok(ApiResponse<object>.Ok(new { enabled = configuration != null, revision = configuration?.Revision ?? "none", isMapAdmin = await IsMapAdmin(ct), permissions }));
    }

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        if (!await IsMapAdmin(ct)) return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有MAP管理员可以查看和导入产品权限表。"));
        var configuration = await Read(ct);
        var directory = await _db.Users.Find(_ => true).Limit(5001).ToListAsync(ct);
        if (directory.Count > 5000) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "人员目录超过单次导入上限，请联系管理员处理。"));
        var rows = new List<object>();
        var applicationSettings = await _db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync(ct);
        foreach (var user in directory)
        {
            var effective = await _permissions.GetEffectivePermissionsAsync(user.UserId, false, ct);
            var isAdmin = ProductPermissionRules.IsMapAdministrator(user);
            var scoped = effective.Contains(ProductPermissionRules.Scoped);
            var menus = ProductPermissionRules.Menus.Where(m =>
            {
                if (isAdmin) return true;
                if (scoped) return effective.Contains(ProductPermissionRules.MenuPrefix + m.Key);
                if (m.Key == "settings") return applicationSettings == null
                    ? effective.Contains(AdminPermissionCatalog.ProductAgentAdmin) || effective.Contains(AdminPermissionCatalog.Super)
                    : applicationSettings.AdminIds.Contains(user.UserId);
                if (m.Key == "versions" && effective.Contains(AdminPermissionCatalog.ProductAgentVersionApply)) return true;
                return (effective.Contains(AdminPermissionCatalog.ProductAgentUse) || effective.Contains(AdminPermissionCatalog.Super))
                    && (m.Key != "review" || effective.Contains(AdminPermissionCatalog.ReviewAgentUse) || effective.Contains(AdminPermissionCatalog.Super));
            }).Select(m => m.Key).ToArray();
            var legacyReview = new Dictionary<string, string> { [ProductPermissionRules.ReviewViewAll] = AdminPermissionCatalog.ReviewAgentViewAll,
                [ProductPermissionRules.ReviewManage] = AdminPermissionCatalog.ReviewAgentManage, [ProductPermissionRules.ReviewAppeal] = AdminPermissionCatalog.ReviewAgentAppealReview };
            rows.Add(new { user.UserId, user.Username, user.DisplayName, systemRoleKey = user.SystemRoleKey ?? (isAdmin ? "admin" : "none"), isMapAdmin = isAdmin, menus,
                permissions = ProductPermissionRules.Menus.Where(m => menus.Contains(m.Key)).SelectMany(m => m.Functions)
                    .Where(key => isAdmin || effective.Contains(key) || (!scoped && (effective.Contains(AdminPermissionCatalog.Super)
                        || (legacyReview.TryGetValue(key, out var oldKey) && effective.Contains(oldKey))))).ToArray() });
        }
        return Ok(ApiResponse<object>.Ok(new { schemaVersion = 1, revision = configuration?.Revision ?? "none", enabled = configuration != null,
            menus = ProductPermissionRules.Menus, functions = ProductPermissionRules.Functions, users = rows }));
    }

    [HttpPost("preview")]
    [RequestSizeLimit(16 * 1024 * 1024)]
    public async Task<IActionResult> Preview([FromBody] ProductPermissionWorkbook request, CancellationToken ct)
    {
        if (!await IsMapAdmin(ct)) return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有MAP管理员可以导入产品权限表。"));
        try
        {
            var current = await Read(ct);
            if ((current?.Revision ?? "none") != request.ExpectedRevision) return Conflict(ApiResponse<object>.Fail("PRODUCT_PERMISSION_CONFLICT", "权限已被其他管理员更新，请重新导出并核对。"));
            var directory = await _db.Users.Find(_ => true).Limit(5001).ToListAsync(ct);
            if (directory.Count > 5000) throw new ArgumentException("人员目录超过单次导入上限。");
            var rows = ProductPermissionRules.Normalize(request, directory);
            var candidate = new ProductPermissionConfiguration { Users = rows };
            var changes = new List<object>();
            foreach (var user in directory.Where(x => !ProductPermissionRules.IsMapAdministrator(x)))
            {
                var before = await _permissions.GetEffectivePermissionsAsync(user.UserId, false, ct);
                var after = ProductPermissionRules.Apply(user, before, candidate);
                var beforeProduct = before.Where(x => x.StartsWith("product-agent.", StringComparison.Ordinal)).OrderBy(x => x).ToArray();
                var afterProduct = after.Where(x => x.StartsWith("product-agent.", StringComparison.Ordinal)).OrderBy(x => x).ToArray();
                if (!beforeProduct.SequenceEqual(afterProduct)) changes.Add(new { user.UserId, user.Username, user.DisplayName,
                    before = beforeProduct, after = afterProduct, omitted = !rows.Any(x => x.UserId == user.UserId) });
            }
            return Ok(ApiResponse<object>.Ok(new { revision = current?.Revision ?? "none", people = rows.Count,
                omittedCount = directory.Count(x => !ProductPermissionRules.IsMapAdministrator(x) && !rows.Any(r => r.UserId == x.UserId)),
                administratorCount = directory.Count(ProductPermissionRules.IsMapAdministrator), changes,
                notice = "整本覆盖：未列出的非MAP管理员将失去产品管理权限；MAP管理员保留全部菜单。其他应用、MAP角色及独立评审授权不变。" }));
        }
        catch (ArgumentException ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    [HttpPost("import")]
    [RequestSizeLimit(16 * 1024 * 1024)]
    public async Task<IActionResult> Import([FromBody] ProductPermissionWorkbook request, CancellationToken ct)
    {
        if (!await IsMapAdmin(ct)) return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有MAP管理员可以导入产品权限表。"));
        try
        {
            var directory = await _db.Users.Find(_ => true).Limit(5001).ToListAsync(ct);
            if (directory.Count > 5000) throw new ArgumentException("人员目录超过单次导入上限。");
            var normalized = ProductPermissionRules.Normalize(request, directory);
            var previous = await Read(ct);
            var candidate = new ProductPermissionConfiguration { Id = ProductPermissionRules.ConfigurationId, Users = normalized,
                PreviousRevision = previous?.Revision, PreviousUsers = previous?.Users,
                UpdatedBy = this.GetRequiredUserId(), UpdatedAt = DateTime.UtcNow };
            if (request.ExpectedRevision == "none")
            {
                try { await _db.ProductPermissionConfigurations.InsertOneAsync(candidate, cancellationToken: ct); }
                catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
                { return Conflict(ApiResponse<object>.Fail("PRODUCT_PERMISSION_CONFLICT", "权限已被其他管理员更新，未覆盖任何配置，请重新预览。")); }
            }
            else
            {
                var result = await _db.ProductPermissionConfigurations.ReplaceOneAsync(
                    x => x.Id == ProductPermissionRules.ConfigurationId && x.Revision == request.ExpectedRevision, candidate,
                    cancellationToken: ct);
                if (result.MatchedCount != 1) return Conflict(ApiResponse<object>.Fail("PRODUCT_PERMISSION_CONFLICT", "权限已被其他管理员更新，未覆盖任何配置，请重新预览。"));
            }
            return Ok(ApiResponse<object>.Ok(new { revision = candidate.Revision, people = normalized.Count, candidate.UpdatedAt }));
        }
        catch (ArgumentException ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }
}
