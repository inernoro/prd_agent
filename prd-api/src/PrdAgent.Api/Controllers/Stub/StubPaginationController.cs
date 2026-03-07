using Microsoft.AspNetCore.Mvc;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Stub;

/// <summary>
/// 内置分页 Mock：用于 smart-http 舱验收测试。
/// 50 条模拟数据，支持 cursor / offset / page 三种分页。
/// 无需额外启动服务，后端自带。
/// </summary>
[ApiController]
[Route("api/v1/stub/pagination")]
public class StubPaginationController : ControllerBase
{
    private static readonly List<object> AllItems = Enumerable.Range(1, 50).Select(i => (object)new
    {
        id = $"item-{i:D3}",
        title = $"Task #{i}",
        status = new[] { "open", "in_progress", "done", "closed" }[(i - 1) % 4],
        priority = new[] { "P0", "P1", "P2", "P3" }[(i - 1) % 4],
        assignee = new[] { "Alice", "Bob", "Charlie", "Diana" }[(i - 1) % 4],
        createdAt = new DateTime(2026, 3, 1 + ((i - 1) % 28)).ToString("yyyy-MM-dd"),
    }).ToList();

    /// <summary>
    /// Cursor 分页 — 数据嵌套在 response.result.list（用于测试 dataPath）
    /// GET /api/v1/stub/pagination/cursor?cursor=0&amp;limit=10
    /// </summary>
    [HttpGet("cursor")]
    public IActionResult CursorList([FromQuery] string cursor = "0", [FromQuery] int limit = 10)
    {
        var startIdx = int.TryParse(cursor, out var c) ? c : 0;
        limit = Math.Clamp(limit, 1, 100);
        var page = AllItems.Skip(startIdx).Take(limit).ToList();
        var hasMore = startIdx + limit < AllItems.Count;

        return Ok(new
        {
            response = new
            {
                result = new
                {
                    list = page,
                    total = AllItems.Count,
                }
            },
            paging = new
            {
                current_cursor = cursor,
                next_cursor = hasMore ? (startIdx + limit).ToString() : (string?)null,
                has_more = hasMore,
            }
        });
    }

    /// <summary>
    /// Offset 分页 — 数据在 data 字段
    /// GET /api/v1/stub/pagination/offset?offset=0&amp;limit=10
    /// </summary>
    [HttpGet("offset")]
    public IActionResult OffsetList([FromQuery] int offset = 0, [FromQuery] int limit = 10)
    {
        limit = Math.Clamp(limit, 1, 100);
        var page = AllItems.Skip(offset).Take(limit).ToList();

        return Ok(new
        {
            data = page,
            total = AllItems.Count,
            offset,
            limit,
        });
    }

    /// <summary>
    /// Page 分页 — 数据在 items 字段
    /// GET /api/v1/stub/pagination/page?page=1&amp;pageSize=10
    /// </summary>
    [HttpGet("page")]
    public IActionResult PageList([FromQuery] int page = 1, [FromQuery] int pageSize = 10)
    {
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(page, 1);
        var startIdx = (page - 1) * pageSize;
        var items = AllItems.Skip(startIdx).Take(pageSize).ToList();

        return Ok(new
        {
            items,
            pageInfo = new
            {
                page,
                pageSize,
                totalPages = (int)Math.Ceiling((double)AllItems.Count / pageSize),
                total = AllItems.Count,
            }
        });
    }
}
