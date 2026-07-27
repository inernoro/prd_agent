using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>MAP 用户读取、发布和回滚教程双链图谱。</summary>
[ApiController]
[Route("api/document-store/stores/{storeId}/tutorial-link-graph")]
[Authorize]
public sealed class DocumentStoreTutorialLinkGraphController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ITeamService _teams;
    private readonly TutorialLinkGraphService _graphs;

    public DocumentStoreTutorialLinkGraphController(
        MongoDbContext db,
        ITeamService teams,
        TutorialLinkGraphService graphs)
    {
        _db = db;
        _teams = teams;
        _graphs = graphs;
    }

    [HttpGet]
    public async Task<IActionResult> Get(string storeId, [FromQuery] string publisher, CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(publisher)) return Invalid("publisher 无效");
        var store = await _db.DocumentStores.Find(item => item.Id == storeId).FirstOrDefaultAsync(ct);
        if (store == null || !await CanReadAsync(store)) return NotFoundResult();
        var graph = await _graphs.GetAsync(storeId, publisher, ct);
        return Ok(ApiResponse<object>.Ok(DocumentStorePublisherTutorialLinkGraphControllerProjector.Project(graph)));
    }

    [HttpPut("draft")]
    public async Task<IActionResult> SaveDraft(
        string storeId,
        [FromBody] TutorialLinkGraphDraftRequest request,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)) return Invalid("publisher 无效");
        if (!await CanWriteAsync(storeId, ct)) return NotFoundResult();
        return Mutation(await _graphs.SaveDraftAsync(
            storeId,
            request.Publisher,
            request.Graph,
            request.ExpectedDraftSha256,
            this.GetRequiredUserId(),
            ct));
    }

    [HttpPost("publish")]
    public async Task<IActionResult> Publish(
        string storeId,
        [FromBody] TutorialLinkGraphPublishRequest request,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)) return Invalid("publisher 无效");
        if (!await CanWriteAsync(storeId, ct)) return NotFoundResult();
        return Mutation(await _graphs.PublishAsync(
            storeId,
            request.Publisher,
            request.ExpectedDraftSha256,
            request.ExpectedPublishedSha256,
            this.GetRequiredUserId(),
            ct));
    }

    [HttpPost("rollback")]
    public async Task<IActionResult> Rollback(
        string storeId,
        [FromBody] TutorialLinkGraphRollbackRequest request,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)) return Invalid("publisher 无效");
        if (!await CanWriteAsync(storeId, ct)) return NotFoundResult();
        return Mutation(await _graphs.RollbackAsync(
            storeId,
            request.Publisher,
            request.VersionId,
            request.ExpectedPublishedSha256,
            this.GetRequiredUserId(),
            ct));
    }

    private async Task<bool> CanReadAsync(DocumentStore store)
    {
        if (string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal)) return true;
        var userId = this.GetRequiredUserId();
        if (store.OwnerId == userId) return true;
        var teamIds = await _teams.GetMyTeamIdsAsync(userId);
        return store.SharedTeamIds?.Any(teamIds.Contains) == true;
    }

    private async Task<bool> CanWriteAsync(string storeId, CancellationToken ct)
    {
        var store = await _db.DocumentStores.Find(item => item.Id == storeId).FirstOrDefaultAsync(ct);
        if (store == null) return false;
        if (string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal)) return true;
        var userId = this.GetRequiredUserId();
        if (store.OwnerId == userId) return true;
        var teamIds = await _teams.GetMyTeamIdsAsync(userId);
        return store.SharedTeamIds?.Any(teamIds.Contains) == true;
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

internal static class DocumentStorePublisherTutorialLinkGraphControllerProjector
{
    internal static object Project(TutorialLinkGraph? graph)
        => new
        {
            exists = graph != null,
            draft = graph?.Draft,
            published = graph?.Published,
            updatedAt = graph?.UpdatedAt,
            history = graph == null
                ? Array.Empty<object>()
                : graph.Versions.OrderByDescending(version => version.PublishedAt).Select(version => (object)new
                {
                    version.VersionId,
                    version.Revision.GraphSha256,
                    version.Revision.SourceRevision,
                    version.Revision.VerifiedAtCommit,
                    version.PublishedAt,
                    version.PublishedBy,
                    version.RolledBackFromVersionId,
                }).ToArray(),
        };
}
