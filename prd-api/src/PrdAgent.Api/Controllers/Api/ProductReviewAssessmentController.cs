using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using static PrdAgent.Api.Controllers.Api.ReviewAssessmentController;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>产品管理专用入口，只委托既有处理方法；不注册或改变独立评审原路由。</summary>
[ApiController]
[Route("api/product/review/assessments")]
[Authorize]
[AdminController(AppKey, AdminPermissionCatalog.ProductAgentUse)]
public sealed class ProductReviewAssessmentController : ControllerBase
{
    private const string AppKey = "product-agent";
    private ReviewAssessmentController? _inner;
    private ReviewAssessmentController Inner
    {
        get
        {
            if (_inner == null)
            {
                _inner = ActivatorUtilities.CreateInstance<ReviewAssessmentController>(HttpContext.RequestServices);
                _inner.ControllerContext = ControllerContext;
            }
            return _inner;
        }
    }

    [HttpPost("")]
    [RequestSizeLimit(11 * 1024 * 1024)]
    public Task<IActionResult> CreateAssessment([FromForm] IFormFile file, [FromForm] string? title, CancellationToken ct) => Inner.CreateAssessment(file, title, ct);

    [HttpGet("")]
    public Task<IActionResult> ListRuns(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] bool all = false,
        CancellationToken ct = default) => Inner.ListRuns(page, pageSize, all, ct);

    [HttpGet("{id}")]
    public Task<IActionResult> GetRun(string id, CancellationToken ct) => Inner.GetRun(id, ct);

    [HttpPost("{id}/rerun")]
    public Task<IActionResult> RerunAssessment(string id, CancellationToken ct) => Inner.RerunAssessment(id, ct);

    [HttpGet("{id}/export")]
    public Task<IActionResult> ExportReport(string id, CancellationToken ct) => Inner.ExportReport(id, ct);

    [HttpGet("{id}/stream")]
        [Produces("text/event-stream")]
    public Task StreamAssessment(string id, CancellationToken cancellationToken) => Inner.StreamAssessment(id, cancellationToken);
}
