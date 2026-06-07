using System.Security.Cryptography;
using System.Text;
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
        // PR #742 review fix（多轮闭环）：缺陷 bundle 是项目级整体导出（含他人提交/指派的报告）。
        // DefectAgentController.ListDefects 对非管理员只放行 ReporterId/AssigneeId == userId，
        // 这里若按"项目 OwnerUserId"放行就让非管理员的项目 owner 能通过 peer-sync 越权拉走全项目所有
        // 报告——绕过了正常 API 的可见性。
        // 收敛为：仅以下两类可在 peer-sync 列/导出缺陷项目：
        //   - PeerSystem（HMAC 验签通过的对端 export 请求）
        //   - 本节点 defect-agent.manage 持有者（含 super，被 HasPermission 自动放行）
        // 个人散列缺陷（无 ProjectId）始终不互传。
        var canSeeAll = actor.IsPeerSystem
            || actor.HasPermission("defect-agent.manage");
        if (!canSeeAll)
            return Array.Empty<SyncItemSummary>();
        var visibleFilter = Builders<DefectProject>.Filter.Eq(p => p.IsArchived, false);
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
        // 双闸门：与 ListItemsAsync 同口径 — 只放行 PeerSystem / defect-agent.manage。
        // 项目 OwnerUserId 路径已撤销（PR #742 review fix），避免非管理员的项目 owner 越权
        // 拉走他人提交/指派的全项目报告，与 DefectAgentController.ListDefects 的可见性对齐。
        var canRead = actor.IsPeerSystem || actor.HasPermission("defect-agent.manage");
        if (!canRead) return null;

        var defects = await _db.DefectReports
            .Find(d => d.ProjectId == project.Id && !d.IsDeleted)
            .SortByDescending(d => d.CreatedAt)
            .ToListAsync(ct);

        // 找项目负责人的用户名/邮箱，用于接收侧归属对齐
        User? owner = null;
        if (!string.IsNullOrWhiteSpace(project.OwnerUserId))
            owner = await _db.Users.Find(u => u.UserId == project.OwnerUserId).FirstOrDefaultAsync(ct);

        // PR #742 review Medium fix：预取所有 reporter/assignee 的 username/email，让接收侧能按
        // 用户名/邮箱对齐到自己节点的真实用户，而不是统一归到项目 owner。
        var userIds = defects.SelectMany(d => new[] { d.ReporterId, d.AssigneeId })
            .Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s!).Distinct().ToList();
        var usersById = userIds.Count == 0
            ? new Dictionary<string, User>()
            : (await _db.Users.Find(Builders<User>.Filter.In(u => u.UserId, userIds)).ToListAsync(ct))
                .ToDictionary(u => u.UserId, u => u);

        var records = new List<SyncRecord>();
        foreach (var d in defects)
        {
            // 业务字段塞进 metadata（避免 v2 加字段时破坏 schema）。已知字段值用 String 表达，
            // 未知字段或对端不识别由 Extras 兜底向下兼容。
            // PR #742 review fix：attachments / structuredData 即使为空也必须在 extras 里显式 emit
            // 空数组 / 空对象 —— 否则源端清空后接收方收到的是缺 key，永远当成「没变」无法清。
            // PR #742 review Medium fix：除显示名外还带 username/email，接收侧据此对齐到本地真实用户
            User? reporterUser = !string.IsNullOrWhiteSpace(d.ReporterId) && usersById.TryGetValue(d.ReporterId!, out var rep) ? rep : null;
            User? assigneeUser = !string.IsNullOrWhiteSpace(d.AssigneeId) && usersById.TryGetValue(d.AssigneeId!, out var asg) ? asg : null;
            var meta = new Dictionary<string, string>
            {
                [LineageKey] = d.Id,
                ["defectNo"] = d.DefectNo ?? string.Empty,
                ["status"] = d.Status ?? string.Empty,
                ["severity"] = d.Severity ?? string.Empty,
                ["priority"] = d.Priority ?? string.Empty,
                ["reporterName"] = d.ReporterName ?? string.Empty,
                ["reporterUserName"] = reporterUser?.Username ?? string.Empty,
                ["reporterEmail"] = reporterUser?.Email ?? string.Empty,
                ["assigneeName"] = d.AssigneeName ?? string.Empty,
                ["assigneeUserName"] = assigneeUser?.Username ?? string.Empty,
                ["assigneeEmail"] = assigneeUser?.Email ?? string.Empty,
                ["createdAt"] = d.CreatedAt.ToString("O"),
                ["resolvedAt"] = d.ResolvedAt?.ToString("O") ?? string.Empty,
                ["resolution"] = d.Resolution ?? string.Empty,
            };

            // 附件只传引用元数据（URL），不内联二进制；空数组也要 emit 让对端能识别"源端已清空"。
            var extras = new Dictionary<string, JsonElement>();
            var attRefs = (d.Attachments ?? new List<DefectAttachment>()).Select(a => new
            {
                fileName = a.FileName,
                mimeType = a.MimeType,
                size = a.FileSize,
                url = a.Url,
                type = a.Type,
            }).ToList();
            extras["attachments"] = JsonSerializer.SerializeToElement(attRefs);
            if (attRefs.Count > 0)
                extras["attachmentsNote"] = JsonSerializer.SerializeToElement(
                    "附件保留为引用 URL；对端环境网络不可达时需手动重新上传");

            // structuredData 也传过去（保留原始结构），空对象也要 emit
            extras["structuredData"] = JsonSerializer.SerializeToElement(d.StructuredData ?? new Dictionary<string, string>());

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
        // PR #742 review P2 fix：string.GetHashCode() 每个 .NET 进程随机化，跨节点 / 重启永不一致
        // → 漂移检测永远报"不同步"。改用 SHA-256，与 DocumentStoreSyncResource 同款稳定算法。
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", parts)));
        return Convert.ToHexString(hash).ToLowerInvariant();
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
            // PR #742 review P2/High 二次修订：之前为了规避 defect_projects.Key 唯一索引冲突而"同 Key 直接复用既有项目"
            // 引入了新 High：跨环境 push 时 targetKey 是对端项目 Id，若本地不存在对应 Id，会落到一个仅 slug 同名的
            // 无关项目里造成数据串号。正确语义是"用指定的 Id 创建新项目，Key 用后缀保证唯一不抢占他人的 slug"。
            var baseKey = (bundle.Item.Name ?? "imported").ToLowerInvariant().Trim().Replace(' ', '-');
            if (string.IsNullOrWhiteSpace(baseKey)) baseKey = "imported-" + DateTime.UtcNow.Ticks.ToString("x");

            string newId = !string.IsNullOrWhiteSpace(key) ? key : Guid.NewGuid().ToString("N");
            // 若 Key 已被占用 → 加 -peer-{shortid} 后缀使新项目独立存在，**不复用别人的项目**
            var keyTaken = await _db.DefectProjects.Find(p => p.Key == baseKey).AnyAsync(ct);
            string finalKey = keyTaken ? $"{baseKey}-peer-{newId[..Math.Min(8, newId.Length)]}" : baseKey;

            project = new DefectProject
            {
                Id = newId,
                Name = string.IsNullOrWhiteSpace(bundle.Item.Name) ? "（来自对端的缺陷项目）" : bundle.Item.Name,
                Key = finalKey,
                Description = bundle.Item.Description,
                OwnerUserId = ownerUserId,
                OwnerName = ownerName,
            };
            try { await _db.DefectProjects.InsertOneAsync(project, cancellationToken: ct); }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 竞态 - 在 lookup 后他人插入了同 Key。改 Key 再试一次，使用 GUID 后缀，几乎不可能再冲突。
                project.Key = $"{baseKey}-peer-{Guid.NewGuid().ToString("N")[..12]}";
                try { await _db.DefectProjects.InsertOneAsync(project, cancellationToken: ct); }
                catch (MongoWriteException ex2)
                {
                    // 如果 Id 维度也撞了（极罕见，需要 newId 已经被占），抛出明确错误而非串号落库。
                    throw new InvalidOperationException(
                        $"无法创建缺陷项目（Id={newId}，Key={project.Key}）：{ex2.Message}");
                }
            }
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
                // PR #742 review P2 fix：必须区分 key 缺失 vs key 存在且空值 ——
                //   - key 缺失 = 源端未携带该字段的信息（保留现状）
                //   - key 存在但 v=空 = 源端【显式清空】（同步到 null/null-ts）
                // 旧版 Get 把两者混为 null 导致清除操作无法跨节点传递。
                string? Resolved(string k, string? current)
                {
                    if (!meta.TryGetValue(k, out var v)) return current; // 缺失 = 保留
                    return string.IsNullOrEmpty(v) ? null : v;            // 存在但空 = 显式清
                }
                DateTime? ResolvedTs(string k, DateTime? current)
                {
                    if (!meta.TryGetValue(k, out var v)) return current;
                    if (string.IsNullOrEmpty(v)) return null;
                    return DateTime.TryParse(v, out var dt) ? dt.ToUniversalTime() : current;
                }
                // 保留 Get 给只读 metadata（如 defectNo / createdAt / reporterName / assigneeName）用——
                // 这些字段空值就当不存在合理。下方业务字段都改走 Resolved 走"显式清"语义。
                string? Get(string k) => meta.TryGetValue(k, out var v) && !string.IsNullOrEmpty(v) ? v : null;

                // PR #742 review fix：消化 export 写入 Extras 的 attachments / structuredData，
                // 否则附件元数据和结构化字段在对端被静默丢弃。
                // 现在 export 必 emit 这两 key（即便空），此处只要 key 存在就 set（含空清空语义）；
                // key 不存在则不动（向下兼容旧 bundle）。
                List<DefectAttachment>? attachments = null;
                bool hasAttachmentsKey = r.Extras.TryGetValue("attachments", out var attEl) && attEl.ValueKind == JsonValueKind.Array;
                if (hasAttachmentsKey)
                {
                    attachments = new List<DefectAttachment>();
                    try
                    {
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
                    catch { attachments = new List<DefectAttachment>(); }
                }
                Dictionary<string, string>? structured = null;
                bool hasStructuredKey = r.Extras.TryGetValue("structuredData", out var sdEl) && sdEl.ValueKind == JsonValueKind.Object;
                if (hasStructuredKey)
                {
                    structured = new Dictionary<string, string>();
                    try
                    {
                        foreach (var prop in sdEl.EnumerateObject())
                            structured[prop.Name] = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() ?? string.Empty : prop.Value.ToString();
                    }
                    catch { structured = new Dictionary<string, string>(); }
                }
                // 解析 resolvedAt：源端解决/重新打开时 timestamp 必须搬过来，否则分析的"解决耗时"会断。
                // 走 ResolvedTs 支持源端把"重开"传过来（resolvedAt = "" → 清回 null）。

                if (existing != null)
                {
                    if (addOnly) { skipped++; continue; }
                    // PR #742 review P2：no-op 比对必须覆盖所有可更新字段，否则只改 priority / resolution /
                    // assigneeName / attachments / structuredData 的工作流更新会被错误地判为「无变化」而静默跳过。
                    // PR #742 review P2 fix：旧版 bundle 不带 attachments/structuredData key 时
                    // (hasAttachmentsKey/hasStructuredKey 为 false)，update 路径会保留旧值；no-op 比对
                    // 也必须按"保留"对待，否则把本地非空字段当成"对端清空"，每次同步都 false drift。
                    var existingAttSig = JsonSerializer.Serialize((existing.Attachments ?? new List<DefectAttachment>())
                        .Select(a => new { a.FileName, a.Url, a.FileSize }).OrderBy(a => a.FileName + a.Url));
                    var newAttSig = hasAttachmentsKey
                        ? JsonSerializer.Serialize((attachments ?? new List<DefectAttachment>())
                            .Select(a => new { a.FileName, a.Url, a.FileSize }).OrderBy(a => a.FileName + a.Url))
                        : existingAttSig;
                    var existingStructSig = JsonSerializer.Serialize((existing.StructuredData ?? new Dictionary<string, string>())
                        .OrderBy(kv => kv.Key, StringComparer.Ordinal));
                    var newStructSig = hasStructuredKey
                        ? JsonSerializer.Serialize((structured ?? new Dictionary<string, string>())
                            .OrderBy(kv => kv.Key, StringComparer.Ordinal))
                        : existingStructSig;
                    // 用 Resolved 让 no-op 比对正确处理"源端显式清空"（用空字符串 vs 缺失 key 区分）。
                    var newStatus = Resolved("status", existing.Status);
                    var newSeverity = Resolved("severity", existing.Severity);
                    var newPriority = Resolved("priority", existing.Priority);
                    var newResolution = Resolved("resolution", existing.Resolution);
                    var newAssignee = Resolved("assigneeName", existing.AssigneeName);
                    var newResolvedAt = ResolvedTs("resolvedAt", existing.ResolvedAt);
                    // PR #742 review Medium fix：update 路径也要按 username/email 重新对齐 reporter
                    // 和 assignee，否则显示名变了但 ReporterId/AssigneeId 永远保留首次 insert 时的兜底
                    // 旧值（项目 owner），破坏 reporter/assignee 过滤与工作流。
                    string? newReporterId = existing.ReporterId;
                    string? newReporterName = existing.ReporterName;
                    if (!string.IsNullOrWhiteSpace(Get("reporterUserName")) || !string.IsNullOrWhiteSpace(Get("reporterEmail")))
                    {
                        var (rId, rName) = await ResolveUserAsync(
                            Get("reporterUserName"), Get("reporterEmail"), Get("reporterName"),
                            existing.ReporterId, existing.ReporterName, ct);
                        newReporterId = rId;
                        newReporterName = rName;
                    }
                    else if (!string.IsNullOrWhiteSpace(Get("reporterName")))
                    {
                        newReporterName = Get("reporterName");
                    }
                    string? newAssigneeId = existing.AssigneeId;
                    string? newAssigneeName = newAssignee; // 同 Resolved("assigneeName") 行为
                    if (!string.IsNullOrWhiteSpace(Get("assigneeUserName")) || !string.IsNullOrWhiteSpace(Get("assigneeEmail")))
                    {
                        var (aId, aName) = await ResolveUserAsync(
                            Get("assigneeUserName"), Get("assigneeEmail"), Get("assigneeName"),
                            existing.AssigneeId, existing.AssigneeName, ct);
                        newAssigneeId = aId;
                        if (!string.IsNullOrWhiteSpace(aName)) newAssigneeName = aName;
                    }
                    // no-op 比对同时纳入 IsDeleted —— 本地软删的条目即便其他字段未变也要走 update 路径
                    // 恢复 IsDeleted=false（PR #742 review fix 同条）。
                    if (!existing.IsDeleted
                        && existing.RawContent == r.Content
                        && existing.Title == r.Title
                        && existing.Status == newStatus
                        && existing.Severity == newSeverity
                        && existing.Priority == newPriority
                        && existing.Resolution == newResolution
                        && existing.AssigneeName == newAssigneeName
                        && existing.AssigneeId == newAssigneeId
                        && existing.ReporterId == newReporterId
                        && existing.ReporterName == newReporterName
                        && existing.ResolvedAt == newResolvedAt
                        && existingAttSig == newAttSig
                        && existingStructSig == newStructSig)
                    {
                        skipped++;
                        continue;
                    }
                    var u = Builders<DefectReport>.Update
                        .Set(x => x.Title, r.Title)
                        .Set(x => x.RawContent, r.Content ?? string.Empty)
                        .Set(x => x.Status, newStatus ?? string.Empty)
                        .Set(x => x.Severity, newSeverity)
                        .Set(x => x.Priority, newPriority)
                        .Set(x => x.Resolution, newResolution)
                        .Set(x => x.AssigneeId, newAssigneeId)
                        .Set(x => x.AssigneeName, newAssigneeName)
                        .Set(x => x.ReporterId, newReporterId ?? existing.ReporterId)
                        .Set(x => x.ReporterName, newReporterName)
                        .Set(x => x.ResolvedAt, newResolvedAt)
                        // PR #742 review Medium fix：清掉本地软删标记。Export 只会发非删除的条目，
                        // 源端再次推送此条目 = 它在源端是活的；若本地此前被软删，应"复活"，否则
                        // 同步看似成功但 UI 仍隐藏该缺陷。
                        .Set(x => x.IsDeleted, false)
                        .Set(x => x.DeletedAt, (DateTime?)null)
                        .Set(x => x.DeletedBy, (string?)null)
                        .Set(x => x.ProjectId, project.Id)
                        .Set(x => x.ProjectName, project.Name)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow);
                    // hasAttachmentsKey/hasStructuredKey 表示 export 端 emit 了该 key（含清空语义）→
                    // 即便集合为空也要 .Set 让对端清掉；key 缺失（旧 bundle）才保留旧值。
                    if (hasAttachmentsKey) u = u.Set(x => x.Attachments, attachments ?? new List<DefectAttachment>());
                    if (hasStructuredKey) u = u.Set(x => x.StructuredData, structured ?? new Dictionary<string, string>());
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

                    // PR #742 review P2 fix：DefectNo 有唯一索引 uniq_defect_reports_no。
                    // test/prod 各自独立生成的同 DefectNo（如 DEF-2026-0001）冲突时直接 InsertOne 会
                    // DuplicateKey 报错，整条 import 算 failed。改为：保留源端编号优先；同号被占即加
                    // -peer-{shortLineage} 后缀；竞态时再用 GUID 后缀兜底。
                    var srcDefectNo = Get("defectNo") ?? string.Empty;
                    string finalDefectNo = srcDefectNo;
                    if (!string.IsNullOrWhiteSpace(srcDefectNo))
                    {
                        var noTaken = await _db.DefectReports.Find(d => d.DefectNo == srcDefectNo).AnyAsync(ct);
                        if (noTaken)
                            finalDefectNo = $"{srcDefectNo}-peer-{lineageId[..Math.Min(8, lineageId.Length)]}";
                    }

                    // PR #742 review Medium fix：按 reporterUserName / reporterEmail 对齐到本地用户；
                    // 未命中才退回项目 owner（同 doc-store 的兜底逻辑），避免所有 import 全部归项目 owner。
                    var (reporterId, reporterName) = await ResolveUserAsync(
                        Get("reporterUserName"), Get("reporterEmail"), Get("reporterName"), ownerUserId, ownerName, ct);
                    // assignee 可以为空 - 只在 bundle 带了对齐字段时才尝试
                    string? assigneeId = null;
                    var assigneeDisplayName = Resolved("assigneeName", null);
                    if (!string.IsNullOrWhiteSpace(Get("assigneeUserName")) || !string.IsNullOrWhiteSpace(Get("assigneeEmail")))
                    {
                        var (aId, aName) = await ResolveUserAsync(
                            Get("assigneeUserName"), Get("assigneeEmail"), Get("assigneeName"), null, null, ct);
                        assigneeId = aId;
                        if (!string.IsNullOrWhiteSpace(aName)) assigneeDisplayName = aName;
                    }
                    var defect = new DefectReport
                    {
                        Id = lineageId,
                        DefectNo = finalDefectNo,
                        Title = r.Title,
                        RawContent = r.Content ?? string.Empty,
                        Status = Resolved("status", "submitted") ?? "submitted",
                        Severity = Resolved("severity", null),
                        Priority = Resolved("priority", null),
                        Resolution = Resolved("resolution", null),
                        ReporterId = reporterId ?? ownerUserId,
                        ReporterName = reporterName,
                        AssigneeId = assigneeId,
                        AssigneeName = assigneeDisplayName,
                        ProjectId = project.Id,
                        ProjectName = project.Name,
                        CreatedAt = parsedCreated,
                        UpdatedAt = DateTime.UtcNow,
                        ResolvedAt = ResolvedTs("resolvedAt", null),
                        Attachments = attachments ?? new List<DefectAttachment>(),
                        StructuredData = structured ?? new Dictionary<string, string>(),
                    };
                    try
                    {
                        await _db.DefectReports.InsertOneAsync(defect, cancellationToken: ct);
                    }
                    catch (MongoWriteException dupEx) when (dupEx.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                    {
                        // 竞态：DefectNo / lineage 同号正好被另一并发 import 抢插。retry 一次：DefectNo 加 GUID 后缀。
                        defect.DefectNo = $"{srcDefectNo}-peer-{Guid.NewGuid().ToString("N")[..12]}";
                        try { await _db.DefectReports.InsertOneAsync(defect, cancellationToken: ct); }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[peer-sync] insert defect 二次竞态失败 lineage={LineageId} no={No}", lineageId, defect.DefectNo);
                            failed++;
                            continue;
                        }
                    }
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

    /// <summary>按 username → email 对齐到本地用户；未命中退回 fallbackUserId/Name（可为 null）。
    /// PR #742 review Medium fix：导入缺陷的 reporter/assignee 不能统一归到项目 owner。</summary>
    private async Task<(string? userId, string? displayName)> ResolveUserAsync(
        string? username, string? email, string? displayNameFromMeta,
        string? fallbackUserId, string? fallbackName, CancellationToken ct)
    {
        User? user = null;
        if (!string.IsNullOrWhiteSpace(username))
            user = await _db.Users.Find(u => u.Username == username).FirstOrDefaultAsync(ct);
        if (user == null && !string.IsNullOrWhiteSpace(email))
            user = await _db.Users.Find(u => u.Email == email).FirstOrDefaultAsync(ct);
        if (user != null)
        {
            var n = !string.IsNullOrWhiteSpace(user.DisplayName) ? user.DisplayName : user.Username;
            return (user.UserId, n);
        }
        return (fallbackUserId, !string.IsNullOrWhiteSpace(displayNameFromMeta) ? displayNameFromMeta : fallbackName);
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
