using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

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
    private readonly ILogger<GapsController> _logger;

    public GapsController(
        IGapDetectionService gapService,
        IUserService userService,
        ILogger<GapsController> logger)
    {
        _gapService = gapService;
        _userService = userService;
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

