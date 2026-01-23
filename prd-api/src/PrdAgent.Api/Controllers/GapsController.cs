using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 内容缺失控制器
/// </summary>
[ApiController]
[Route("api/v1/groups/{groupId}/gaps")]
[Authorize]
public class GapsController : ControllerBase
{
    private readonly IGapDetectionService _gapService;
    private readonly IUserService _userService;
    private readonly IKnowledgeBaseService _kbService;
    private readonly IGroupService _groupService;
    private readonly ILLMClient _llmClient;
    private readonly IPromptManager _promptManager;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<GapsController> _logger;

    private static string? GetUserId(ClaimsPrincipal user)
    {
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
               ?? user.FindFirst("sub")?.Value
               ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
               ?? user.FindFirst("nameid")?.Value;
    }

    public GapsController(
        IGapDetectionService gapService,
        IUserService userService,
        IKnowledgeBaseService kbService,
        IGroupService groupService,
        ILLMClient llmClient,
        IPromptManager promptManager,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<GapsController> logger)
    {
        _gapService = gapService;
        _userService = userService;
        _kbService = kbService;
        _groupService = groupService;
        _llmClient = llmClient;
        _promptManager = promptManager;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    /// <summary>
    /// 获取群组的内容缺失列表
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<GapListResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetGaps(
        string groupId,
        [FromQuery] GapStatus? status = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        var gaps = await _gapService.GetGapsAsync(groupId, status);
        
        var items = new List<GapItemResponse>();
        foreach (var gap in gaps.Skip((page - 1) * pageSize).Take(pageSize))
        {
            var askedBy = await _userService.GetByIdAsync(gap.AskedByUserId);
            items.Add(new GapItemResponse
            {
                GapId = gap.GapId,
                Question = gap.Question,
                GapType = gap.GapType.ToString().ToLower(),
                AskedBy = askedBy != null ? new AskedByInfo
                {
                    UserId = askedBy.UserId,
                    DisplayName = askedBy.DisplayName,
                    Role = askedBy.Role
                } : null,
                AskedAt = gap.AskedAt,
                Status = gap.Status.ToString().ToLower(),
                Suggestion = gap.Suggestion
            });
        }

        var response = new GapListResponse
        {
            Items = items,
            Total = gaps.Count,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<GapListResponse>.Ok(response));
    }

    /// <summary>
    /// 生成缺口汇总报告
    /// </summary>
    [HttpPost("summary-report")]
    [ProducesResponseType(typeof(ApiResponse<GapSummaryResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateSummaryReport(
        string groupId,
        CancellationToken cancellationToken)
    {
        // 获取群组和文档
        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));
        }

        if (!group.HasKnowledgeBase)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "群组未绑定知识库文档"));
        }

        // 获取知识库文档内容
        var kbDocs = await _kbService.GetActiveDocumentsAsync(groupId);
        var combinedContent = string.Join("\n\n", kbDocs
            .Where(d => d.TextContent != null)
            .Select(d => d.TextContent!));

        // 获取所有缺口
        var gaps = await _gapService.GetGapsAsync(groupId);
        if (gaps.Count == 0)
        {
            return Ok(ApiResponse<GapSummaryResponse>.Ok(new GapSummaryResponse
            {
                TotalGaps = 0,
                Report = "暂无内容缺口记录"
            }));
        }

        // 使用AI生成报告
        var userId = GetUserId(User);
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString(),
            GroupId: groupId,
            SessionId: null,
            UserId: userId,
            ViewRole: "ADMIN",
            DocumentChars: combinedContent.Length,
            DocumentHash: Sha256Hex(combinedContent),
            SystemPromptRedacted: "你是一个专业的产品文档分析师。",
            RequestType: "reasoning",
            RequestPurpose: AppCallerRegistry.Desktop.Gap.SummarizationChat));

        var detector = new AIGapDetector(_llmClient, _promptManager);
        var report = await detector.GenerateSummaryReportAsync(
            combinedContent,
            gaps,
            cancellationToken);

        var response = new GapSummaryResponse
        {
            TotalGaps = gaps.Count,
            PendingCount = gaps.Count(g => g.Status == GapStatus.Pending),
            ResolvedCount = gaps.Count(g => g.Status == GapStatus.Resolved),
            IgnoredCount = gaps.Count(g => g.Status == GapStatus.Ignored),
            ByType = gaps.GroupBy(g => g.GapType)
                .ToDictionary(g => g.Key.ToString(), g => g.Count()),
            Report = report,
            GeneratedAt = DateTime.UtcNow
        };

        return Ok(ApiResponse<GapSummaryResponse>.Ok(response));
    }

    private static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// 更新缺失状态
    /// </summary>
    [HttpPut("{gapId}/status")]
    [ProducesResponseType(typeof(ApiResponse<GapItemResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateStatus(
        string groupId,
        string gapId,
        [FromBody] UpdateGapStatusRequest request)
    {
        try
        {
            var gap = await _gapService.UpdateStatusAsync(gapId, request.Status);
            var askedBy = await _userService.GetByIdAsync(gap.AskedByUserId);

            var response = new GapItemResponse
            {
                GapId = gap.GapId,
                Question = gap.Question,
                GapType = gap.GapType.ToString().ToLower(),
                AskedBy = askedBy != null ? new AskedByInfo
                {
                    UserId = askedBy.UserId,
                    DisplayName = askedBy.DisplayName,
                    Role = askedBy.Role
                } : null,
                AskedAt = gap.AskedAt,
                Status = gap.Status.ToString().ToLower(),
                Suggestion = gap.Suggestion
            };

            return Ok(ApiResponse<GapItemResponse>.Ok(response));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail("GAP_NOT_FOUND", "缺失记录不存在"));
        }
    }

    /// <summary>
    /// 获取未处理的缺失数量
    /// </summary>
    [HttpGet("pending-count")]
    [ProducesResponseType(typeof(ApiResponse<int>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetPendingCount(string groupId)
    {
        var count = await _gapService.GetPendingCountAsync(groupId);
        return Ok(ApiResponse<int>.Ok(count));
    }

    /// <summary>
    /// 获取缺口统计
    /// </summary>
    [HttpGet("stats")]
    [ProducesResponseType(typeof(ApiResponse<GapStatsResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStats(string groupId)
    {
        var gaps = await _gapService.GetGapsAsync(groupId);

        var response = new GapStatsResponse
        {
            TotalGaps = gaps.Count,
            PendingCount = gaps.Count(g => g.Status == GapStatus.Pending),
            ResolvedCount = gaps.Count(g => g.Status == GapStatus.Resolved),
            IgnoredCount = gaps.Count(g => g.Status == GapStatus.Ignored),
            ByType = gaps.GroupBy(g => g.GapType)
                .ToDictionary(g => g.Key.ToString(), g => g.Count()),
            RecentGaps = gaps.OrderByDescending(g => g.AskedAt).Take(5).Select(g => new RecentGapInfo
            {
                GapId = g.GapId,
                Question = g.Question.Length > 100 ? g.Question[..100] + "..." : g.Question,
                GapType = g.GapType.ToString(),
                AskedAt = g.AskedAt
            }).ToList()
        };

        return Ok(ApiResponse<GapStatsResponse>.Ok(response));
    }
}

// 响应模型
public class GapListResponse
{
    public List<GapItemResponse> Items { get; set; } = new();
    public int Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

public class GapItemResponse
{
    public string GapId { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public string GapType { get; set; } = string.Empty;
    public AskedByInfo? AskedBy { get; set; }
    public DateTime AskedAt { get; set; }
    public string Status { get; set; } = string.Empty;
    public string? Suggestion { get; set; }
}

public class AskedByInfo
{
    public string UserId { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
}

public class UpdateGapStatusRequest
{
    public GapStatus Status { get; set; }
}

public class GapSummaryResponse
{
    public int TotalGaps { get; set; }
    public int PendingCount { get; set; }
    public int ResolvedCount { get; set; }
    public int IgnoredCount { get; set; }
    public Dictionary<string, int> ByType { get; set; } = new();
    public string Report { get; set; } = string.Empty;
    public DateTime GeneratedAt { get; set; }
}

public class GapStatsResponse
{
    public int TotalGaps { get; set; }
    public int PendingCount { get; set; }
    public int ResolvedCount { get; set; }
    public int IgnoredCount { get; set; }
    public Dictionary<string, int> ByType { get; set; } = new();
    public List<RecentGapInfo> RecentGaps { get; set; } = new();
}

public class RecentGapInfo
{
    public string GapId { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public string GapType { get; set; } = string.Empty;
    public DateTime AskedAt { get; set; }
}
