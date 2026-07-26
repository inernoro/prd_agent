using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>项目级发布器维护教程双链图谱的受控接口。</summary>
[ApiController]
[Route("api/open/document-store/publisher/stores/{storeId}/tutorial-link-graph")]
[Authorize(AuthenticationSchemes = "ApiKey")]
[RequireScope(DocumentStoreOpenApiController.ScopeWrite)]
public sealed class DocumentStorePublisherTutorialLinkGraphController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly TutorialLinkGraphService _graphs;

    public DocumentStorePublisherTutorialLinkGraphController(MongoDbContext db, TutorialLinkGraphService graphs)
    {
        _db = db;
        _graphs = graphs;
    }

    [HttpGet]
    public async Task<IActionResult> Get(string storeId, [FromQuery] string publisher, CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(publisher)) return Invalid("publisher 无效");
        if (await LoadOwnedGenericStoreAsync(storeId, ct) == null) return NotFoundResult();
        return Ok(ApiResponse<object>.Ok(DocumentStorePublisherTutorialLinkGraphControllerProjector.Project(
            await _graphs.GetAsync(storeId, publisher, ct))));
    }

    [HttpPut("draft")]
    public async Task<IActionResult> SaveDraft(
        string storeId,
        [FromBody] TutorialLinkGraphDraftRequest request,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)) return Invalid("publisher 无效");
        if (await LoadOwnedGenericStoreAsync(storeId, ct) == null) return NotFoundResult();
        var result = await _graphs.SaveDraftAsync(
            storeId,
            request.Publisher,
            request.Graph,
            request.ExpectedDraftSha256,
            GetBoundUserId(),
            ct);
        return Mutation(result);
    }

    [HttpPost("publish")]
    public async Task<IActionResult> Publish(
        string storeId,
        [FromBody] TutorialLinkGraphPublishRequest request,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)) return Invalid("publisher 无效");
        if (await LoadOwnedGenericStoreAsync(storeId, ct) == null) return NotFoundResult();
        var result = await _graphs.PublishAsync(
            storeId,
            request.Publisher,
            request.ExpectedDraftSha256,
            request.ExpectedPublishedSha256,
            GetBoundUserId(),
            ct);
        return Mutation(result);
    }

    [HttpPost("rollback")]
    public async Task<IActionResult> Rollback(
        string storeId,
        [FromBody] TutorialLinkGraphRollbackRequest request,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)) return Invalid("publisher 无效");
        if (await LoadOwnedGenericStoreAsync(storeId, ct) == null) return NotFoundResult();
        var result = await _graphs.RollbackAsync(
            storeId,
            request.Publisher,
            request.VersionId,
            request.ExpectedPublishedSha256,
            GetBoundUserId(),
            ct);
        return Mutation(result);
    }

    private async Task<DocumentStore?> LoadOwnedGenericStoreAsync(string storeId, CancellationToken ct)
    {
        var ownerId = GetBoundUserId();
        return await _db.DocumentStores.Find(store => store.Id == storeId
                                                      && store.OwnerId == ownerId
                                                      && store.PmProjectId == null
                                                      && store.ProductKnowledgeRef == null
                                                      && store.ShituCategoryRef == null)
            .FirstOrDefaultAsync(ct);
    }

    private string GetBoundUserId()
    {
        var userId = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(userId)) throw new UnauthorizedAccessException("Missing boundUserId claim");
        return userId;
    }

    private IActionResult Mutation(TutorialLinkGraphMutationResult result)
        => result.Status switch
        {
            TutorialLinkGraphMutationStatus.Success => Ok(ApiResponse<object>.Ok(
                DocumentStorePublisherTutorialLinkGraphControllerProjector.Project(result.Graph))),
            TutorialLinkGraphMutationStatus.Stale => StatusCode(
                StatusCodes.Status409Conflict,
                ApiResponse<object>.Fail(ErrorCodes.STALE_UPDATE, result.Message ?? "图谱已变化")),
            _ => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Message ?? "图谱无效")),
        };

    private BadRequestObjectResult Invalid(string message)
        => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message));

    private NotFoundObjectResult NotFoundResult()
        => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));
}

public sealed class TutorialLinkGraphDraftRequest
{
    public string Publisher { get; set; } = string.Empty;
    public string? ExpectedDraftSha256 { get; set; }
    public TutorialLinkGraphRevision Graph { get; set; } = new();
}

public sealed class TutorialLinkGraphPublishRequest
{
    public string Publisher { get; set; } = string.Empty;
    public string ExpectedDraftSha256 { get; set; } = string.Empty;
    public string? ExpectedPublishedSha256 { get; set; }
}

public sealed class TutorialLinkGraphRollbackRequest
{
    public string Publisher { get; set; } = string.Empty;
    public string VersionId { get; set; } = string.Empty;
    public string ExpectedPublishedSha256 { get; set; } = string.Empty;
}