using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services.Changelog;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 更新中心 - 代码级周报
/// 数据源：仓库内的 changelogs/*.md 碎片 + CHANGELOG.md，不依赖数据库。
/// 优先读取本地文件（dev 5 分钟缓存），找不到时自动从 GitHub 拉取（生产 24 小时缓存）。
/// 仅需登录即可访问，无需特殊权限。
/// </summary>
[ApiController]
[Route("api/changelog")]
[Authorize]
[AdminController("changelog", AdminPermissionCatalog.Access)]
public class ChangelogController : ControllerBase
{
    private readonly IChangelogReader _reader;

    public ChangelogController(IChangelogReader reader)
    {
        _reader = reader;
    }

    /// <summary>
    /// 本周更新（从 changelogs/ 碎片读取，按日期倒序）
    /// </summary>
    /// <param name="force">true 时绕过服务端缓存，重新从源拉取（GitHub 路径意味着真实 API 调用）</param>
    [HttpGet("current-week")]
    public async Task<IActionResult> GetCurrentWeek([FromQuery] bool force = false)
    {
        var view = await _reader.GetCurrentWeekAsync(force).ConfigureAwait(false);
        return Ok(ApiResponse<CurrentWeekDto>.Ok(MapCurrentWeek(view)));
    }

    /// <summary>
    /// 历史发布（从 CHANGELOG.md 读取，按版本倒序）
    /// </summary>
    /// <param name="limit">最多返回的版本数量（1..100，默认 20）</param>
    /// <param name="force">true 时绕过服务端缓存，重新从源拉取</param>
    [HttpGet("releases")]
    public async Task<IActionResult> GetReleases([FromQuery] int limit = 20, [FromQuery] bool force = false)
    {
        if (limit <= 0 || limit > 100) limit = 20;
        var view = await _reader.GetReleasesAsync(limit, force).ConfigureAwait(false);
        return Ok(ApiResponse<ReleasesDto>.Ok(MapReleases(view)));
    }

    // ── DTO 映射 ──────────────────────────────────────────────────────

    private static CurrentWeekDto MapCurrentWeek(CurrentWeekView view) => new()
    {
        WeekStart = view.WeekStart.ToString("yyyy-MM-dd"),
        WeekEnd = view.WeekEnd.ToString("yyyy-MM-dd"),
        DataSourceAvailable = view.DataSourceAvailable,
        Source = view.Source,
        FetchedAt = view.FetchedAt.ToString("o"),
        Fragments = view.Fragments.ConvertAll(f => new ChangelogFragmentDto
        {
            FileName = f.FileName,
            Date = f.Date.ToString("yyyy-MM-dd"),
            Entries = f.Entries.ConvertAll(MapEntry),
        }),
    };

    private static ReleasesDto MapReleases(ReleasesView view) => new()
    {
        DataSourceAvailable = view.DataSourceAvailable,
        Source = view.Source,
        FetchedAt = view.FetchedAt.ToString("o"),
        Releases = view.Releases.ConvertAll(r => new ChangelogReleaseDto
        {
            Version = r.Version,
            ReleaseDate = r.ReleaseDate?.ToString("yyyy-MM-dd"),
            Highlights = r.Highlights,
            Days = r.Days.ConvertAll(d => new ChangelogDayDto
            {
                Date = d.Date.ToString("yyyy-MM-dd"),
                CommitTimeUtc = d.CommitTimeUtc?.ToString("o"),
                Entries = d.Entries.ConvertAll(MapEntry),
            }),
        }),
    };

    private static ChangelogEntryDto MapEntry(ChangelogEntry e) => new()
    {
        Type = e.Type,
        Module = e.Module,
        Description = e.Description,
    };

    // ── DTO 定义（前端契约） ──────────────────────────────────────────

    public sealed class ChangelogEntryDto
    {
        public string Type { get; set; } = string.Empty;
        public string Module { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
    }

    public sealed class ChangelogFragmentDto
    {
        public string FileName { get; set; } = string.Empty;
        public string Date { get; set; } = string.Empty;
        public List<ChangelogEntryDto> Entries { get; set; } = new();
    }

    public sealed class CurrentWeekDto
    {
        public string WeekStart { get; set; } = string.Empty;
        public string WeekEnd { get; set; } = string.Empty;
        public bool DataSourceAvailable { get; set; }
        /// <summary>"local" / "github" / "none"</summary>
        public string Source { get; set; } = "none";
        /// <summary>ISO 8601 时间戳</summary>
        public string FetchedAt { get; set; } = string.Empty;
        public List<ChangelogFragmentDto> Fragments { get; set; } = new();
    }

    public sealed class ChangelogDayDto
    {
        public string Date { get; set; } = string.Empty;
        /// <summary>该日期最晚一次 GitHub commit 的 ISO 8601 UTC 时间（仅 github 源可用）</summary>
        public string? CommitTimeUtc { get; set; }
        public List<ChangelogEntryDto> Entries { get; set; } = new();
    }

    public sealed class ChangelogReleaseDto
    {
        public string Version { get; set; } = string.Empty;
        public string? ReleaseDate { get; set; }
        public List<string> Highlights { get; set; } = new();
        public List<ChangelogDayDto> Days { get; set; } = new();
    }

    public sealed class ReleasesDto
    {
        public bool DataSourceAvailable { get; set; }
        public string Source { get; set; } = "none";
        public string FetchedAt { get; set; } = string.Empty;
        public List<ChangelogReleaseDto> Releases { get; set; } = new();
    }
}
