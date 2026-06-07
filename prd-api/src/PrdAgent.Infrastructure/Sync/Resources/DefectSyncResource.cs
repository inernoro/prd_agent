using System.Text.Json;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Sync.Resources;

/// <summary>
/// 缺陷管理（DefectReport）跨节点互传 — **单向 push-only**。
///
/// 设计抉择：
/// - SupportsBidirectional = false：缺陷天然单向流动（测试环境提交 → 正式环境归档 / 处理人通知），
///   双向合并语义会污染状态机（resolved 被对端的 draft 覆盖等）。
/// - 列出条目以「DefectProject」为粒度：每个项目下的缺陷打包成一个 bundle（与知识库的 storeId 同思路）。
/// - 个人粒度的散列缺陷（未关联项目）不在本互传范围。
/// - 附件只传引用 URL（同名 URL 在跨环境通常不可达），接收侧标注「附件待手动下载」。
/// - 流转状态字段（assignee / status / version 等）原样传输，对端按本节点 schema 落库；
///   不在本节点 schema 的字段进 record.Extras，向下兼容。
/// </summary>
public class DefectSyncResource : ISyncableResource
{
    private const string LineageKey = "syncLineageId";

    private readonly MongoDbContext _db;
    private readonly ILogger<DefectSyncResource> _logger;

    public DefectSyncResource(MongoDbContext db, ILogger<DefectSyncResource> logger)
    {
        _db = db;
        _logger = logger;
    }

    public string ResourceType => "defect-agent";
    public string DisplayName => "缺陷管理";
    public bool SupportsBidirectional => false;  // 单向 push-only
    public int SchemaVersion => 1;

    // ─── 列出可发送的缺陷项目 ───
    public async Task<IReadOnlyList<SyncItemSummary>> ListItemsAsync(SyncActor actor, CancellationToken ct)
    {
        // 列出所有非归档项目（用户能看到 / 管理员能看到由调用方的鉴权层决定，此处不限）。
        // 个人散列缺陷（无 ProjectId）不可通过本接口互传，避免一次拷一整个用户名下零散缺陷。
        var projects = await _db.DefectProjects
            .Find(p => !p.IsArchived)
            .SortBy(p => p.Name)
            .ToListAsync(ct);
        var ids = projects.Select(p => p.Id).ToList();
        var counts = await _db.DefectReports
            .Aggregate()
            .Match(d => ids.Contains(d.ProjectId!) && !d.IsDeleted)
            .Group(d => d.ProjectId, g => new { ProjectId = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var byProj = counts.ToDictionary(c => c.ProjectId!, c => c.Count);
        return projects.Select(p => new SyncItemSummary
        {
            ItemId = p.Id,
            Name = p.Name,
            Description = p.Description,
            RecordCount = byProj.TryGetValue(p.Id, out var n) ? n : 0,
            UpdatedAt = p.UpdatedAt,
        }).ToList();
    }

    // ─── 导出（计算阶段） ───
    public async Task<SyncResourceBundle?> ExportAsync(string itemId, SyncActor actor, CancellationToken ct)
    {
        var project = await _db.DefectProjects.Find(p => p.Id == itemId).FirstOrDefaultAsync(ct);
        if (project == null) return null;

        var defects = await _db.DefectReports
            .Find(d => d.ProjectId == project.Id && !d.IsDeleted)
            .SortByDescending(d => d.CreatedAt)
            .ToListAsync(ct);

        // 找项目负责人的用户名/邮箱，用于接收侧归属对齐
        User? owner = null;
        if (!string.IsNullOrWhiteSpace(project.OwnerUserId))
            owner = await _db.Users.Find(u => u.UserId == project.OwnerUserId).FirstOrDefaultAsync(ct);

        var records = new List<SyncRecord>();
        foreach (var d in defects)
        {
            // 业务字段塞进 metadata（避免 v2 加字段时破坏 schema）。已知字段值用 String 表达，
            // 未知字段或对端不识别由 Extras 兜底向下兼容。
            var meta = new Dictionary<string, string>
            {
                [LineageKey] = d.Id,
                ["defectNo"] = d.DefectNo ?? string.Empty,
                ["status"] = d.Status ?? string.Empty,
                ["severity"] = d.Severity ?? string.Empty,
                ["priority"] = d.Priority ?? string.Empty,
                ["reporterName"] = d.ReporterName ?? string.Empty,
                ["assigneeName"] = d.AssigneeName ?? string.Empty,
                ["createdAt"] = d.CreatedAt.ToString("O"),
                ["resolvedAt"] = d.ResolvedAt?.ToString("O") ?? string.Empty,
                ["resolution"] = d.Resolution ?? string.Empty,
            };

            // 附件只传引用元数据（URL），不内联二进制。
            var extras = new Dictionary<string, JsonElement>();
            if (d.Attachments != null && d.Attachments.Count > 0)
            {
                var attRefs = d.Attachments.Select(a => new
                {
                    fileName = a.FileName,
                    mimeType = a.MimeType,
                    size = a.FileSize,
                    url = a.Url,
                    type = a.Type,
                }).ToList();
                extras["attachments"] = JsonSerializer.SerializeToElement(attRefs);
                extras["attachmentsNote"] = JsonSerializer.SerializeToElement(
                    "附件保留为引用 URL；对端环境网络不可达时需手动重新上传");
            }

            // structuredData 也传过去（保留原始结构）
            if (d.StructuredData != null && d.StructuredData.Count > 0)
                extras["structuredData"] = JsonSerializer.SerializeToElement(d.StructuredData);

            records.Add(new SyncRecord
            {
                LineageId = d.Id,
                IsFolder = false,
                Title = string.IsNullOrWhiteSpace(d.Title) ? (d.DefectNo ?? d.Id) : d.Title!,
                Summary = d.RawContent != null && d.RawContent.Length > 200 ? d.RawContent[..200] : d.RawContent,
                ContentType = "text/plain",
                FileSize = d.RawContent?.Length ?? 0,
                Tags = string.IsNullOrEmpty(d.Severity) ? null : new List<string> { d.Severity! },
                Content = d.RawContent,
                Metadata = meta,
                Extras = extras,
            });
        }

        return new SyncResourceBundle
        {
            SchemaVersion = SchemaVersion,
            ResourceType = ResourceType,
            Item = new SyncBundleItem
            {
                Key = project.Id,
                Name = project.Name,
                Description = project.Description,
                OwnerUserName = owner?.Username,
                OwnerEmail = owner?.Email,
            },
            Records = records,
        };
    }

    public async Task<string?> ComputeSignatureAsync(string itemId, CancellationToken ct)
    {
        var project = await _db.DefectProjects.Find(p => p.Id == itemId).FirstOrDefaultAsync(ct);
        if (project == null) return null;
        var defects = await _db.DefectReports
            .Find(d => d.ProjectId == project.Id && !d.IsDeleted)
            .Project(d => new { d.Id, d.UpdatedAt, d.Status })
            .ToListAsync(ct);
        var parts = defects
            .Select(d => $"{d.Id}|{d.UpdatedAt.Ticks}|{d.Status}")
            .OrderBy(x => x, StringComparer.Ordinal);
        return string.Join("\n", parts).GetHashCode().ToString("x");
    }

    // ─── 应用（接收阶段：单向 push 接收方） ───
    public async Task<SyncApplyOutcome> ApplyAsync(
        SyncResourceBundle bundle, SyncActor actor, SyncApplyMode mode, string? targetKey, CancellationToken ct)
    {
        var key = !string.IsNullOrWhiteSpace(targetKey) ? targetKey! : bundle.Item.Key;

        // 解析归属：按用户名 → 邮箱 → 操作者兜底
        var (ownerUserId, ownerName, authorMatched) = await ResolveOwnerAsync(bundle.Item, actor, ct);

        var project = string.IsNullOrWhiteSpace(key)
            ? null
            : await _db.DefectProjects.Find(p => p.Id == key).FirstOrDefaultAsync(ct);
        if (project == null)
        {
            project = new DefectProject
            {
                Id = !string.IsNullOrWhiteSpace(key) ? key : Guid.NewGuid().ToString("N"),
                Name = string.IsNullOrWhiteSpace(bundle.Item.Name) ? "（来自对端的缺陷项目）" : bundle.Item.Name,
                Key = (bundle.Item.Name ?? "imported").ToLowerInvariant().Replace(' ', '-'),
                Description = bundle.Item.Description,
                OwnerUserId = ownerUserId,
                OwnerName = ownerName,
            };
            await _db.DefectProjects.InsertOneAsync(project, cancellationToken: ct);
        }

        int created = 0, updated = 0, skipped = 0, failed = 0;
        var addOnly = mode == SyncApplyMode.AddOnly;

        foreach (var r in bundle.Records ?? new List<SyncRecord>())
        {
            try
            {
                // 血缘 = DefectReport.Id（跨节点保留同 id 便于 test↔prod 同库识别）
                var lineageId = r.LineageId;
                var existing = await _db.DefectReports.Find(d => d.Id == lineageId).FirstOrDefaultAsync(ct);

                var meta = r.Metadata ?? new Dictionary<string, string>();
                string? Get(string k) => meta.TryGetValue(k, out var v) && !string.IsNullOrEmpty(v) ? v : null;

                if (existing != null)
                {
                    if (addOnly) { skipped++; continue; }
                    // 内容 + status 无变化 → 跳过避免无意义 bump
                    if (existing.RawContent == r.Content
                        && existing.Title == r.Title
                        && existing.Status == Get("status")
                        && existing.Severity == Get("severity"))
                    {
                        skipped++;
                        continue;
                    }
                    var u = Builders<DefectReport>.Update
                        .Set(x => x.Title, r.Title)
                        .Set(x => x.RawContent, r.Content ?? string.Empty)
                        .Set(x => x.Status, Get("status") ?? existing.Status)
                        .Set(x => x.Severity, Get("severity") ?? existing.Severity)
                        .Set(x => x.Priority, Get("priority") ?? existing.Priority)
                        .Set(x => x.Resolution, Get("resolution") ?? existing.Resolution)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow);
                    await _db.DefectReports.UpdateOneAsync(d => d.Id == lineageId, u, cancellationToken: ct);
                    updated++;
                }
                else
                {
                    DateTime parsedCreated = DateTime.UtcNow;
                    if (Get("createdAt") is string c && DateTime.TryParse(c, out var dt)) parsedCreated = dt.ToUniversalTime();

                    var defect = new DefectReport
                    {
                        Id = lineageId,
                        DefectNo = Get("defectNo") ?? string.Empty,
                        Title = r.Title,
                        RawContent = r.Content ?? string.Empty,
                        Status = Get("status") ?? "submitted",
                        Severity = Get("severity"),
                        Priority = Get("priority"),
                        Resolution = Get("resolution"),
                        ReporterId = ownerUserId,
                        ReporterName = Get("reporterName") ?? ownerName,
                        AssigneeName = Get("assigneeName"),
                        ProjectId = project.Id,
                        ProjectName = project.Name,
                        CreatedAt = parsedCreated,
                        UpdatedAt = DateTime.UtcNow,
                    };
                    await _db.DefectReports.InsertOneAsync(defect, cancellationToken: ct);
                    created++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[peer-sync] apply defect failed: {LineageId}", r.LineageId);
                failed++;
            }
        }

        return new SyncApplyOutcome
        {
            Created = created,
            Updated = updated,
            Skipped = skipped,
            Failed = failed,
            UnmatchedAuthors = authorMatched ? 0 : 1,
            Message = $"新增{created}/更新{updated}/跳过{skipped}" + (failed > 0 ? $"/失败{failed}" : ""),
        };
    }

    private async Task<(string userId, string name, bool matched)> ResolveOwnerAsync(
        SyncBundleItem item, SyncActor actor, CancellationToken ct)
    {
        User? user = null;
        if (!string.IsNullOrWhiteSpace(item.OwnerUserName))
            user = await _db.Users.Find(u => u.Username == item.OwnerUserName).FirstOrDefaultAsync(ct);
        if (user == null && !string.IsNullOrWhiteSpace(item.OwnerEmail))
            user = await _db.Users.Find(u => u.Email == item.OwnerEmail).FirstOrDefaultAsync(ct);
        if (user != null)
        {
            var n = !string.IsNullOrWhiteSpace(user.DisplayName) ? user.DisplayName : user.Username;
            return (user.UserId, n, true);
        }
        return (actor.UserId, actor.UserName, false);
    }
}
