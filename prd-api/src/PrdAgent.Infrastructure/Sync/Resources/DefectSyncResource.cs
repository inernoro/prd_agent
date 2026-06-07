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
        // PR #742 review P1 fix：必须按 actor 视角过滤，否则任意登录用户可越权拉所有缺陷项目。
        // - 受信对端节点（IsPeerSystem，来自 HMAC 验签通过的 export 请求）：全域
        // - 本节点管理员（IsAdmin = Super / AI 超级访问）：全域
        // - 普通用户：仅放行自己作为 OwnerUserId 的项目（不暴露其他人项目里的缺陷）
        //
        // 个人散列缺陷（无 ProjectId）不可通过本接口互传，避免一次拷一整个用户名下零散缺陷。
        var baseFilter = Builders<DefectProject>.Filter.Eq(p => p.IsArchived, false);
        var visibleFilter = (actor.IsPeerSystem || actor.IsAdmin)
            ? baseFilter
            : Builders<DefectProject>.Filter.And(
                baseFilter,
                Builders<DefectProject>.Filter.Eq(p => p.OwnerUserId, actor.UserId));
        var projects = await _db.DefectProjects
            .Find(visibleFilter)
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
        // 双闸门：即便上层 transfer 已用 ListItemsAsync 做了集合判定，本方法仍独立校验 actor 是否可读，
        // 避免对端 export 端点或未来旁路调用绕过授权。
        if (!actor.IsPeerSystem && !actor.IsAdmin && project.OwnerUserId != actor.UserId) return null;

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
                // PR #742 review P2：必须同时 match ProjectId，否则若同 id 已存在于其它项目，
                // 会误把对端的更新写到无关项目里。我们只在「同 id 且同项目」时认作同一条；
                // 同 id 但不同项目 → 当成新建（避免跨项目串号）。
                var lineageId = r.LineageId;
                var existing = await _db.DefectReports
                    .Find(d => d.Id == lineageId && d.ProjectId == project.Id)
                    .FirstOrDefaultAsync(ct);

                var meta = r.Metadata ?? new Dictionary<string, string>();
                string? Get(string k) => meta.TryGetValue(k, out var v) && !string.IsNullOrEmpty(v) ? v : null;

                // PR #742 review fix：消化 export 写入 Extras 的 attachments / structuredData，
                // 否则附件元数据和结构化字段在对端被静默丢弃。
                List<DefectAttachment>? attachments = null;
                if (r.Extras.TryGetValue("attachments", out var attEl) && attEl.ValueKind == JsonValueKind.Array)
                {
                    try
                    {
                        attachments = new List<DefectAttachment>();
                        foreach (var item in attEl.EnumerateArray())
                        {
                            attachments.Add(new DefectAttachment
                            {
                                FileName = item.TryGetProperty("fileName", out var fn) ? fn.GetString() ?? string.Empty : string.Empty,
                                MimeType = item.TryGetProperty("mimeType", out var mt) ? mt.GetString() ?? string.Empty : string.Empty,
                                FileSize = item.TryGetProperty("size", out var sz) && sz.TryGetInt64(out var lz) ? lz : 0,
                                Url = item.TryGetProperty("url", out var u) ? u.GetString() ?? string.Empty : string.Empty,
                                Type = item.TryGetProperty("type", out var tt) ? tt.GetString() ?? "file" : "file",
                                Description = "（由对端互传带入，URL 在本节点环境可能不可达，需手动重传）",
                            });
                        }
                    }
                    catch { attachments = null; }
                }
                Dictionary<string, string>? structured = null;
                if (r.Extras.TryGetValue("structuredData", out var sdEl) && sdEl.ValueKind == JsonValueKind.Object)
                {
                    try
                    {
                        structured = new Dictionary<string, string>();
                        foreach (var prop in sdEl.EnumerateObject())
                            structured[prop.Name] = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() ?? string.Empty : prop.Value.ToString();
                    }
                    catch { structured = null; }
                }

                if (existing != null)
                {
                    if (addOnly) { skipped++; continue; }
                    // PR #742 review P2：no-op 比对必须覆盖所有可更新字段，否则只改 priority / resolution /
                    // assigneeName / attachments / structuredData 的工作流更新会被错误地判为「无变化」而静默跳过。
                    var existingAttSig = JsonSerializer.Serialize((existing.Attachments ?? new List<DefectAttachment>())
                        .Select(a => new { a.FileName, a.Url, a.FileSize }).OrderBy(a => a.FileName + a.Url));
                    var newAttSig = JsonSerializer.Serialize((attachments ?? new List<DefectAttachment>())
                        .Select(a => new { a.FileName, a.Url, a.FileSize }).OrderBy(a => a.FileName + a.Url));
                    var existingStructSig = JsonSerializer.Serialize((existing.StructuredData ?? new Dictionary<string, string>())
                        .OrderBy(kv => kv.Key, StringComparer.Ordinal));
                    var newStructSig = JsonSerializer.Serialize((structured ?? new Dictionary<string, string>())
                        .OrderBy(kv => kv.Key, StringComparer.Ordinal));
                    if (existing.RawContent == r.Content
                        && existing.Title == r.Title
                        && existing.Status == (Get("status") ?? existing.Status)
                        && existing.Severity == (Get("severity") ?? existing.Severity)
                        && existing.Priority == (Get("priority") ?? existing.Priority)
                        && existing.Resolution == (Get("resolution") ?? existing.Resolution)
                        && existing.AssigneeName == (Get("assigneeName") ?? existing.AssigneeName)
                        && existingAttSig == newAttSig
                        && existingStructSig == newStructSig)
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
                        .Set(x => x.AssigneeName, Get("assigneeName") ?? existing.AssigneeName)
                        .Set(x => x.ProjectId, project.Id)
                        .Set(x => x.ProjectName, project.Name)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow);
                    if (attachments != null) u = u.Set(x => x.Attachments, attachments);
                    if (structured != null) u = u.Set(x => x.StructuredData, structured);
                    await _db.DefectReports.UpdateOneAsync(d => d.Id == lineageId, u, cancellationToken: ct);
                    updated++;
                }
                else
                {
                    // 跨项目串号兜底：若同 id 存在于其它项目，不插入以免 DuplicateKey；当成 skipped 并记日志。
                    var crossProject = await _db.DefectReports
                        .Find(d => d.Id == lineageId && d.ProjectId != project.Id)
                        .FirstOrDefaultAsync(ct);
                    if (crossProject != null)
                    {
                        _logger.LogWarning("[peer-sync] defect lineage {LineageId} already exists in different project {Other}, skipping insert to target {Target}",
                            lineageId, crossProject.ProjectId, project.Id);
                        skipped++;
                        continue;
                    }
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
                        Attachments = attachments ?? new List<DefectAttachment>(),
                        StructuredData = structured ?? new Dictionary<string, string>(),
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
