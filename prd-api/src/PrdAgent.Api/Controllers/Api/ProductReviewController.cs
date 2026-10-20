using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using static PrdAgent.Api.Controllers.Api.ReviewAgentController;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>产品管理专用入口，只委托既有处理方法；不注册或改变独立评审原路由。</summary>
[ApiController]
[Route("api/product/review")]
[Authorize]
[AdminController(AppKey, AdminPermissionCatalog.ProductAgentUse)]
public sealed class ProductReviewController : ControllerBase
{
    private const string AppKey = "product-agent";
    private ReviewAgentController? _inner;
    private ReviewAgentController Inner
    {
        get
        {
            if (_inner == null)
            {
                _inner = ActivatorUtilities.CreateInstance<ReviewAgentController>(HttpContext.RequestServices);
                _inner.ControllerContext = ControllerContext;
            }
            return _inner;
        }
    }

    [HttpGet("dimensions")]
    public Task<IActionResult> GetDimensions(CancellationToken ct) => Inner.GetDimensions(ct);

    [HttpPut("dimensions")]
    public Task<IActionResult> UpdateDimensions([FromBody] List<ReviewDimensionConfig> dimensions, CancellationToken ct) => Inner.UpdateDimensions(dimensions, ct);

    [HttpPost("submissions")]
    public Task<IActionResult> CreateSubmission([FromBody] CreateReviewSubmissionRequest req, CancellationToken ct) => Inner.CreateSubmission(req, ct);

    [HttpGet("submissions")]
    public Task<IActionResult> GetMySubmissions(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        [FromQuery] string? filter = null,
        CancellationToken ct = default) => Inner.GetMySubmissions(page, pageSize, filter, ct);

    [HttpGet("submissions/all")]
    public Task<IActionResult> GetAllSubmissions(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? submitterId = null,
        [FromQuery] string? filter = null,
        CancellationToken ct = default) => Inner.GetAllSubmissions(page, pageSize, submitterId, filter, ct);

    [HttpGet("submitters")]
    public Task<IActionResult> GetSubmitters(CancellationToken ct) => Inner.GetSubmitters(ct);

    [HttpGet("leaderboard")]
    public Task<IActionResult> GetLeaderboard(
        [FromQuery] string startMonth,
        [FromQuery] string endMonth,
        [FromQuery] string groupBy = "submitter",
        CancellationToken ct = default) => Inner.GetLeaderboard(startMonth, endMonth, groupBy, ct);

    [HttpGet("submissions/{id}")]
    public Task<IActionResult> GetSubmission(string id, CancellationToken ct) => Inner.GetSubmission(id, ct);

    [HttpPost("submissions/{id}/rerun")]
    public Task<IActionResult> RerunSubmission(string id, CancellationToken ct) => Inner.RerunSubmission(id, ct);

    [HttpPost("submissions/{id}/reupload-after-error")]
    public Task<IActionResult> ReuploadAfterError(string id, [FromBody] ReuploadRequest req, CancellationToken ct) => Inner.ReuploadAfterError(id, req, ct);

    [HttpPost("submissions/{id}/reupload-on-failure")]
    public Task<IActionResult> ReuploadOnFailure(string id, [FromBody] ReuploadRequest req, CancellationToken ct) => Inner.ReuploadOnFailure(id, req, ct);

    [HttpGet("submissions/{id}/results")]
    public Task<IActionResult> GetSubmissionResults(string id, CancellationToken ct) => Inner.GetSubmissionResults(id, ct);

    [HttpPost("submissions/{id}/appeal")]
    public Task<IActionResult> CreateAppeal(string id, [FromBody] CreateAppealRequest req, CancellationToken ct) => Inner.CreateAppeal(id, req, ct);

    [HttpGet("submissions/{id}/appeals")]
    public Task<IActionResult> ListAppeals(string id, CancellationToken ct) => Inner.ListAppeals(id, ct);

    [HttpPost("appeals/{appealId}/approve")]
    public Task<IActionResult> ApproveAppeal(string appealId, [FromBody] ResolveAppealRequest req, CancellationToken ct) => Inner.ApproveAppeal(appealId, req, ct);

    [HttpPost("appeals/{appealId}/reject")]
    public Task<IActionResult> RejectAppeal(string appealId, [FromBody] ResolveAppealRequest req, CancellationToken ct) => Inner.RejectAppeal(appealId, req, ct);

    [HttpPost("submissions/{id}/reupload")]
    public Task<IActionResult> ReuploadSubmission(string id, [FromBody] ReuploadRequest req, CancellationToken ct) => Inner.ReuploadSubmission(id, req, ct);

    [HttpPost("appeals/upload-image")]
        [RequestSizeLimit(5 * 1024 * 1024)]
    public Task<IActionResult> UploadAppealImage([FromForm] IFormFile file, CancellationToken ct) => Inner.UploadAppealImage(file, ct);

    [HttpGet("submissions/{id}/result/stream")]
        [Produces("text/event-stream")]
    public Task StreamReviewResult(string id, CancellationToken cancellationToken) => Inner.StreamReviewResult(id, cancellationToken);

    [HttpGet("webhooks")]
    public Task<IActionResult> ListWebhooks() => Inner.ListWebhooks();

    [HttpPost("webhooks")]
    public Task<IActionResult> CreateWebhook([FromBody] CreateReviewWebhookRequest req) => Inner.CreateWebhook(req);

    [HttpPut("webhooks/{webhookId}")]
    public Task<IActionResult> UpdateWebhook(string webhookId, [FromBody] UpdateReviewWebhookRequest req) => Inner.UpdateWebhook(webhookId, req);

    [HttpDelete("webhooks/{webhookId}")]
    public Task<IActionResult> DeleteWebhook(string webhookId) => Inner.DeleteWebhook(webhookId);

    [HttpPost("webhooks/test")]
    public Task<IActionResult> TestWebhook([FromBody] TestReviewWebhookRequest req) => Inner.TestWebhook(req);
}
