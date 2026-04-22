using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// Agent 开放接口登记管理（P3 基础设施）—— 平台管理员级 CRUD。
///
/// 每条记录声明"某个 Agent 在 path Y 开放了一个 HTTP 接口，需要 scope Z 调用"。
/// 登记后 AgentApiKeysController 会认识该 scope，允许用户创建带对应范围的 Key。
///
/// 权限：reuse OpenPlatformManage（与"开放平台"语义一致）。
/// 未来可以升级成允许 Agent 作者本人登记（对应 app-identity.md 里的 Owner 模型）。
/// </summary>
[ApiController]
[Route("api/admin/agent-open-endpoints")]
[Authorize]
[AdminController("agent-open-api", AdminPermissionCatalog.OpenPlatformManage)]
public class AgentOpenEndpointsController : ControllerBase
{
    private static readonly HashSet<string> AllowedMethods = new(StringComparer.OrdinalIgnoreCase)
    {
        "GET", "POST", "PATCH", "PUT", "DELETE",
    };

    private static readonly Regex AgentKeyPattern =
        new(@"^[a-z0-9][a-z0-9\-]{0,63}$", RegexOptions.Compiled);

    // scope 格式走全站共享的 AgentScopeFormat，别在这里再自己写一遍
    // 否则 Endpoint 登记能过但 Key 创建过不了、或反过来的 hidden schema drift

    private readonly MongoDbContext _db;

    public AgentOpenEndpointsController(MongoDbContext db)
    {
        _db = db;
    }

    public class UpsertRequest
    {
        public string AgentKey { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
        public string HttpMethod { get; set; } = "POST";
        public string Path { get; set; } = string.Empty;
        public List<string>? RequiredScopes { get; set; }
        public List<string>? AllowedCallerUserIds { get; set; }
        public string? RequestExampleJson { get; set; }
        public string? ResponseExampleJson { get; set; }
        public bool IsActive { get; set; } = true;
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? agentKey, CancellationToken ct)
    {
        var filter = string.IsNullOrWhiteSpace(agentKey)
            ? Builders<AgentOpenEndpoint>.Filter.Empty
            : Builders<AgentOpenEndpoint>.Filter.Eq(e => e.AgentKey, agentKey.Trim());
        var items = await _db.AgentOpenEndpoints
            .Find(filter)
            .SortByDescending(e => e.UpdatedAt)
            .Limit(500)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items = items.Select(ToDto) }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> GetById(string id, CancellationToken ct)
    {
        var item = await _db.AgentOpenEndpoints.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (item == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Endpoint 不存在"));
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(item) }));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertRequest req, CancellationToken ct)
    {
        var (ok, reason) = Validate(req);
        if (!ok) return BadRequest(ApiResponse<object>.Fail("INVALID_REQUEST", reason!));

        var now = DateTime.UtcNow;
        var entity = new AgentOpenEndpoint
        {
            Id = Guid.NewGuid().ToString("N"),
            AgentKey = req.AgentKey.Trim(),
            Title = req.Title.Trim(),
            Description = req.Description.Trim(),
            HttpMethod = req.HttpMethod.ToUpperInvariant(),
            Path = req.Path.Trim(),
            RequiredScopes = NormalizeList(req.RequiredScopes),
            AllowedCallerUserIds = NormalizeList(req.AllowedCallerUserIds),
            RequestExampleJson = string.IsNullOrWhiteSpace(req.RequestExampleJson) ? null : req.RequestExampleJson.Trim(),
            ResponseExampleJson = string.IsNullOrWhiteSpace(req.ResponseExampleJson) ? null : req.ResponseExampleJson.Trim(),
            IsActive = req.IsActive,
            RegisteredBy = this.GetRequiredUserId(),
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.AgentOpenEndpoints.InsertOneAsync(entity, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(entity) }));
    }

    [HttpPatch("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpsertRequest req, CancellationToken ct)
    {
        var existing = await _db.AgentOpenEndpoints.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        if (existing == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Endpoint 不存在"));

        var (ok, reason) = Validate(req);
        if (!ok) return BadRequest(ApiResponse<object>.Fail("INVALID_REQUEST", reason!));

        var update = Builders<AgentOpenEndpoint>.Update
            .Set(e => e.AgentKey, req.AgentKey.Trim())
            .Set(e => e.Title, req.Title.Trim())
            .Set(e => e.Description, req.Description.Trim())
            .Set(e => e.HttpMethod, req.HttpMethod.ToUpperInvariant())
            .Set(e => e.Path, req.Path.Trim())
            .Set(e => e.RequiredScopes, NormalizeList(req.RequiredScopes))
            .Set(e => e.AllowedCallerUserIds, NormalizeList(req.AllowedCallerUserIds))
            .Set(e => e.RequestExampleJson, string.IsNullOrWhiteSpace(req.RequestExampleJson) ? null : req.RequestExampleJson.Trim())
            .Set(e => e.ResponseExampleJson, string.IsNullOrWhiteSpace(req.ResponseExampleJson) ? null : req.ResponseExampleJson.Trim())
            .Set(e => e.IsActive, req.IsActive)
            .Set(e => e.UpdatedAt, DateTime.UtcNow);
        await _db.AgentOpenEndpoints.UpdateOneAsync(e => e.Id == id, update, cancellationToken: ct);

        var reloaded = await _db.AgentOpenEndpoints.Find(e => e.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { item = reloaded == null ? null : ToDto(reloaded) }));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var result = await _db.AgentOpenEndpoints.DeleteOneAsync(e => e.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Endpoint 不存在"));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    private static (bool ok, string? reason) Validate(UpsertRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.AgentKey) || !AgentKeyPattern.IsMatch(req.AgentKey.Trim()))
            return (false, "AgentKey 非法（必须是 kebab-case，如 `report-agent`）");
        if (string.IsNullOrWhiteSpace(req.Title) || req.Title.Length > 80)
            return (false, "Title 不能为空且不超过 80 字符");
        if (string.IsNullOrWhiteSpace(req.Description) || req.Description.Length > 400)
            return (false, "Description 不能为空且不超过 400 字符");
        if (string.IsNullOrWhiteSpace(req.HttpMethod) || !AllowedMethods.Contains(req.HttpMethod.Trim()))
            return (false, $"HttpMethod 非法，允许: {string.Join(" / ", AllowedMethods)}");
        if (string.IsNullOrWhiteSpace(req.Path) || !req.Path.StartsWith("/", StringComparison.Ordinal))
            return (false, "Path 必须以 `/` 开头的绝对路径");
        if (req.Path.Length > 256)
            return (false, "Path 过长（不超过 256 字符）");

        var scopes = NormalizeList(req.RequiredScopes);
        if (scopes.Count == 0)
            return (false, "至少声明一个 scope");
        var invalid = scopes.Where(s => !AgentScopeFormat.Pattern.IsMatch(s)).ToList();
        if (invalid.Count > 0)
            return (false, $"scope 格式非法: {string.Join(", ", invalid)}（应为 `agent.{{agent-key}}:{{action}}`）");

        return (true, null);
    }

    private static List<string> NormalizeList(IEnumerable<string>? input)
    {
        if (input == null) return new List<string>();
        return input
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static object ToDto(AgentOpenEndpoint e) => new
    {
        e.Id,
        e.AgentKey,
        e.Title,
        e.Description,
        e.HttpMethod,
        e.Path,
        requiredScopes = e.RequiredScopes ?? new List<string>(),
        allowedCallerUserIds = e.AllowedCallerUserIds ?? new List<string>(),
        e.RequestExampleJson,
        e.ResponseExampleJson,
        e.IsActive,
        e.RegisteredBy,
        e.CreatedAt,
        e.UpdatedAt,
        e.LinkedMarketplaceSkillId,
    };
}
