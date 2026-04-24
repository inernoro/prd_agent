using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 外部授权中心（TAPD / 语雀 / GitHub 凭证聚合）。
///
/// - 用户登录后在「我的空间 → 外部授权」管理自己的第三方凭证
/// - 工作流通过 authId 引用本中心的记录，运行时走内部 resolve 接口取明文
/// - 设计见 doc/design.external-authorization.md
///
/// 鉴权：用户 JWT。所有接口强制 UserId 校验，禁止越权访问他人凭证。
/// </summary>
[ApiController]
[Route("api/authorizations")]
[Authorize]
public class ExternalAuthorizationsController : ControllerBase
{
    private readonly IExternalAuthorizationService _service;
    private readonly IEnumerable<IAuthTypeHandler> _handlers;
    private readonly MongoDbContext _db;

    public ExternalAuthorizationsController(
        IExternalAuthorizationService service,
        IEnumerable<IAuthTypeHandler> handlers,
        MongoDbContext db)
    {
        _service = service;
        _handlers = handlers;
        _db = db;
    }

    /// <summary>列出当前用户的所有授权（含 GitHub 只读映射）</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var entities = await _service.ListByUserAsync(userId, ct);

        var result = entities.Select(ToSummary).ToList();

        // 合并 GitHub OAuth 连接（只读映射，不在 external_authorizations 里）
        var github = await _db.GitHubUserConnections
            .Find(g => g.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (github != null)
        {
            result.Insert(0, new
            {
                id = $"github:{github.Id}",
                type = "github",
                name = $"GitHub · {github.GitHubLogin}",
                status = "active",
                metadata = new { login = github.GitHubLogin, avatarUrl = github.AvatarUrl, scopes = github.Scopes },
                lastUsedAt = github.LastUsedAt,
                lastValidatedAt = (DateTime?)null,
                expiresAt = (DateTime?)null,
                createdAt = github.ConnectedAt,
                updatedAt = github.ConnectedAt,
                readOnly = true,
                hint = "由 PR 审查模块 OAuth 授权，此处只读展示",
            });
        }

        return Ok(result);
    }

    /// <summary>获取单条授权详情（含脱敏凭证）</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var entity = await _service.GetAsync(userId, id, ct);
        if (entity == null) return NotFound();

        var maskedCreds = await _service.GetMaskedCredentialsAsync(userId, id, ct);
        return Ok(new
        {
            summary = ToSummary(entity),
            credentials = maskedCreds,
        });
    }

    /// <summary>新建授权</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Type) || string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(new { error = "type 和 name 不能为空" });

        if (req.Credentials == null || req.Credentials.Count == 0)
            return BadRequest(new { error = "credentials 不能为空" });

        if (req.Type == "github")
            return BadRequest(new { error = "GitHub 授权请前往 PR 审查模块发起 OAuth" });

        var userId = this.GetRequiredUserId();
        var entity = await _service.CreateAsync(userId, req.Type, req.Name, req.Credentials, ct);
        return Ok(ToSummary(entity));
    }

    /// <summary>更新授权（名称 或 凭证）</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateRequest req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var entity = await _service.UpdateAsync(userId, id, req.Name, req.Credentials, ct);
            return Ok(ToSummary(entity));
        }
        catch (KeyNotFoundException)
        {
            return NotFound();
        }
    }

    /// <summary>撤销授权</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Revoke(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        await _service.RevokeAsync(userId, id, ct);
        return Ok(new { success = true });
    }

    /// <summary>手动触发验证</summary>
    [HttpPost("{id}/validate")]
    public async Task<IActionResult> Validate(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var result = await _service.ValidateAsync(userId, id, ct);
        return Ok(new
        {
            ok = result.Ok,
            errorMessage = result.ErrorMessage,
            expiresAt = result.ExpiresAt,
            metadata = result.Metadata,
        });
    }

    /// <summary>获取类型元信息（供前端动态渲染表单）</summary>
    [HttpGet("types")]
    [AllowAnonymous]
    public IActionResult GetTypes()
    {
        var types = _handlers.Select(h => new
        {
            typeKey = h.TypeKey,
            displayName = h.DisplayName,
            fields = h.CredentialFields,
        }).ToList();
        return Ok(types);
    }

    private static object ToSummary(ExternalAuthorization a) => new
    {
        id = a.Id,
        type = a.Type,
        name = a.Name,
        status = a.Status,
        metadata = a.Metadata,
        lastUsedAt = a.LastUsedAt,
        lastValidatedAt = a.LastValidatedAt,
        expiresAt = a.ExpiresAt,
        createdAt = a.CreatedAt,
        updatedAt = a.UpdatedAt,
        readOnly = false,
    };

    public class CreateRequest
    {
        public string Type { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public Dictionary<string, string> Credentials { get; set; } = new();
    }

    public class UpdateRequest
    {
        public string? Name { get; set; }
        public Dictionary<string, string>? Credentials { get; set; }
    }
}
