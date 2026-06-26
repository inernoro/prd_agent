using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 把 CDS 验收中心的验收报告导入 MAP 知识库（DocumentStore）。
///
/// 设计要点（用户 2026-06-25 定调「鉴权一次搞定，不要反复握手」）：
/// - **复用已有的全局 key**：直接拿 MAP「系统互联」里已授权的 CDS 连接（InfraConnection，
///   Partner=="cds"）的 PartnerBaseUrl + 解密后的长效令牌，作为 `X-AI-Access-Key` 调 CDS。
///   不走 peer-sync 配对码/HMAC 握手，一把全局 key 走到底；也支持显式传 baseUrl+key（测试用）。
/// - **走现成协议**：CDS 已有 `GET /api/reports?updatedSince=&projectId=`（列表，带 projectSlug/
///   verdict/updatedAt）+ `GET /api/reports/:id/raw`（正文），都接受全局 key。无需新协议。
/// - **增量 + 可重跑**：以目标库的 PeerSyncLastAt 作水位，`updatedSince` 只取更新过的；正文 SHA256
///   未变则跳过。反复调用只增量同步，零重复鉴权。
/// </summary>
public class CdsReportImportService
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    private readonly MongoDbContext _db;
    private readonly IInfraConnectionService _infra;
    private readonly IDocumentService _documentService;
    private readonly DocumentStoreAssetNormalizer _assetNormalizer;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<CdsReportImportService> _logger;

    public CdsReportImportService(
        MongoDbContext db,
        IInfraConnectionService infra,
        IDocumentService documentService,
        DocumentStoreAssetNormalizer assetNormalizer,
        IHttpClientFactory httpClientFactory,
        ILogger<CdsReportImportService> logger)
    {
        _db = db;
        _infra = infra;
        _documentService = documentService;
        _assetNormalizer = assetNormalizer;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<CdsReportImportResult> ImportAsync(string userId, CdsReportImportOptions opts, CancellationToken ct)
    {
        var (baseUrl, key) = await ResolveCdsCredentialsAsync(opts, ct);

        // 1) find-or-create 目标库（AppKey=cds-reports，每个用户一份「CDS 验收报告」镜像库）
        var store = await ResolveStoreAsync(userId, opts.StoreId, ct);

        // 增量水位只对「默认全量镜像」语义成立：无 projectId 过滤 + 与上次同一个 CDS 源。
        // 共享的 PeerSyncLastAt 是「上次拉全量到哪」的游标；一旦过滤（指定 projectId）或换了
        // CDS 源，复用它会让 updatedSince 把另一作用域里更早更新的报告永久跳过 —— 例如先导项目 A
        // 把游标戳到 now，再导项目 B 时 B 的旧报告 updatedAt < now 就被漏掉（Codex P2）。
        // 故过滤/换源导入一律全量扫描，靠正文 contentHash 去重保证幂等，且**不回写**共享水位。
        var isDefaultScopeImport =
            string.IsNullOrWhiteSpace(opts.ProjectId)
            && (string.IsNullOrWhiteSpace(store.PeerSyncNodeBaseUrl)
                || string.Equals(store.PeerSyncNodeBaseUrl.TrimEnd('/'), baseUrl, StringComparison.OrdinalIgnoreCase));
        var useIncrementalCursor = isDefaultScopeImport && !opts.Full;

        // 2) 列表（增量水位 = 库的 PeerSyncLastAt，仅默认全量镜像启用）
        var listUrl = $"{baseUrl}/api/reports";
        var query = new List<string>();
        if (!string.IsNullOrWhiteSpace(opts.ProjectId))
            query.Add("projectId=" + Uri.EscapeDataString(opts.ProjectId!));
        if (useIncrementalCursor && store.PeerSyncLastAt.HasValue)
            query.Add("updatedSince=" + Uri.EscapeDataString(store.PeerSyncLastAt.Value.ToUniversalTime().ToString("o")));
        if (query.Count > 0) listUrl += "?" + string.Join("&", query);

        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(60);

        List<CdsReportListItem> reports;
        using (var req = new HttpRequestMessage(HttpMethod.Get, listUrl))
        {
            req.Headers.Add("X-AI-Access-Key", key);
            using var resp = await client.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
                throw new InvalidOperationException($"CDS 报告列表接口返回 {(int)resp.StatusCode}");
            var parsed = await resp.Content.ReadFromJsonAsync<CdsReportListResponse>(JsonOpts, ct);
            reports = parsed?.Reports ?? new List<CdsReportListItem>();
        }

        var result = new CdsReportImportResult
        {
            StoreId = store.Id,
            StoreName = store.Name,
            CdsBaseUrl = baseUrl,
            Total = reports.Count,
        };
        var watermark = store.PeerSyncLastAt ?? DateTime.MinValue;

        // 3) 逐条拉正文 + 增量 upsert
        foreach (var r in reports)
        {
            ct.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(r.Id)) { result.Failed++; continue; }
            try
            {
                var rawUrl = $"{baseUrl}/api/reports/{Uri.EscapeDataString(r.Id)}/raw";
                string content;
                using (var rreq = new HttpRequestMessage(HttpMethod.Get, rawUrl))
                {
                    rreq.Headers.Add("X-AI-Access-Key", key);
                    using var rresp = await client.SendAsync(rreq, ct);
                    if (!rresp.IsSuccessStatusCode)
                    {
                        result.Failed++;
                        result.Messages.Add($"{r.Title}: 正文 {(int)rresp.StatusCode}");
                        continue;
                    }
                    content = await rresp.Content.ReadAsStringAsync(ct);
                }

                var hash = Sha256Hex(content.Replace("\r\n", "\n"));
                var existFilter = Builders<DocumentEntry>.Filter.And(
                    Builders<DocumentEntry>.Filter.Eq(e => e.StoreId, store.Id),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.cdsReportId", r.Id));
                var existing = await _db.DocumentEntries.Find(existFilter).FirstOrDefaultAsync(ct);
                if (existing != null && existing.ContentHash == hash)
                {
                    // 正文未变，但元数据（verdict/title/projectSlug/updatedAt）可能改了——CDS 列表正是因
                    // updatedAt 变化才增量返回它。若整条跳过又推进水位，MAP 镜像会永久保留旧标题/标签/
                    // 元数据（Codex P2）。故只跳过昂贵的正文解析+资产归一化，仍轻量同步元数据/标签。
                    var (mTitle, mTags, mMeta) = BuildEntryMeta(r, baseUrl);
                    var metaChanged = existing.Title != mTitle
                        || !(existing.Tags ?? new List<string>()).SequenceEqual(mTags)
                        || !MetadataEquals(existing.Metadata, mMeta);
                    if (metaChanged)
                    {
                        await _db.DocumentEntries.UpdateOneAsync(
                            e => e.Id == existing.Id,
                            Builders<DocumentEntry>.Update
                                .Set(e => e.Title, mTitle)
                                .Set(e => e.Tags, mTags)
                                .Set(e => e.Metadata, mMeta)
                                .Set(e => e.UpdatedBy, userId)
                                .Set(e => e.LastChangedAt, DateTime.UtcNow)
                                .Set(e => e.UpdatedAt, DateTime.UtcNow),
                            cancellationToken: ct);
                        result.Updated++;
                    }
                    else
                    {
                        result.Skipped++;
                    }
                    TrackWatermark(r, ref watermark);
                    continue;
                }

                // CDS 报告是自包含 HTML（内联 base64 图片）。MAP 知识库正文禁止 data:image
                // （DocumentStoreAssetNormalizer 会硬拒，避免分享页破图）。故先归一化：把 base64 抽出 →
                // 存进统一资产库 IAssetStorage（SHA256 去重）→ 正文改写成正式 HTTPS 图链。
                // 与 PUT /entries/{id}/content 同一条归一化路径，导入不再绕过它。
                string storeContent;
                try
                {
                    var norm = await _assetNormalizer.NormalizeAsync(
                        content, null, new DocumentStoreAssetNormalizationOptions("prd-agent"), ct);
                    storeContent = norm.Content;
                }
                catch (Exception nex)
                {
                    result.Failed++;
                    result.Messages.Add($"{r.Title}: 图片归一化失败 {nex.Message}");
                    _logger.LogWarning(nex, "[cds-report-import] 资产归一化失败 reportId={ReportId}", r.Id);
                    continue;
                }

                // 正文按内容寻址存进 ParsedPrd（与上传/导入同一渲染路径；已无 data:image）
                var (entryTitle, tags, metadata) = BuildEntryMeta(r, baseUrl);
                var parsedDoc = await _documentService.ParseAsync(storeContent);
                parsedDoc.Title = entryTitle;
                await _documentService.SaveAsync(parsedDoc);

                var contentIndex = storeContent.Length > 2000 ? storeContent[..2000] : storeContent;

                if (existing == null)
                {
                    var entry = new DocumentEntry
                    {
                        StoreId = store.Id,
                        Title = parsedDoc.Title,
                        DocumentId = parsedDoc.Id,
                        SourceType = DocumentSourceType.Import,
                        ContentType = string.Equals(r.Format, "html", StringComparison.OrdinalIgnoreCase) ? "text/html" : "text/markdown",
                        ContentIndex = contentIndex,
                        ContentHash = hash,
                        SourceUrl = rawUrl,
                        Tags = tags,
                        Metadata = metadata,
                        CreatedBy = userId,
                        UpdatedBy = userId,
                        LastChangedAt = DateTime.UtcNow,
                    };
                    await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: ct);
                    await _db.DocumentStores.UpdateOneAsync(
                        s => s.Id == store.Id,
                        Builders<DocumentStore>.Update.Inc(s => s.DocumentCount, 1).Set(s => s.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: ct);
                    result.Imported++;
                }
                else
                {
                    await _db.DocumentEntries.UpdateOneAsync(
                        e => e.Id == existing.Id,
                        Builders<DocumentEntry>.Update
                            .Set(e => e.DocumentId, parsedDoc.Id)
                            .Set(e => e.Title, parsedDoc.Title)
                            .Set(e => e.ContentIndex, contentIndex)
                            .Set(e => e.ContentHash, hash)
                            .Set(e => e.Tags, tags)
                            .Set(e => e.Metadata, metadata)
                            .Set(e => e.UpdatedBy, userId)
                            .Set(e => e.LastChangedAt, DateTime.UtcNow)
                            .Set(e => e.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: ct);
                    result.Updated++;
                }
                TrackWatermark(r, ref watermark);
            }
            catch (Exception ex)
            {
                result.Failed++;
                result.Messages.Add($"{r.Title}: {ex.Message}");
                _logger.LogWarning(ex, "[cds-report-import] 导入报告失败 reportId={ReportId}", r.Id);
            }
        }

        // 4) 落同步摘要（下次只增量）
        var updates = new List<UpdateDefinition<DocumentStore>>
        {
            Builders<DocumentStore>.Update.Set(s => s.PeerSyncStatus, "idle"),
            Builders<DocumentStore>.Update.Set(s => s.PeerSyncNodeName, "CDS 验收中心"),
            Builders<DocumentStore>.Update.Set(s => s.PeerSyncNodeBaseUrl, baseUrl),
            Builders<DocumentStore>.Update.Set(s => s.PeerSyncLastResult, $"导入 {result.Imported} 新 / {result.Updated} 更新 / {result.Skipped} 跳过 / {result.Failed} 失败"),
            Builders<DocumentStore>.Update.Set(s => s.UpdatedAt, DateTime.UtcNow),
        };
        // 只有默认全量镜像才回写增量游标 PeerSyncLastAt；过滤/换源导入若回写，会污染默认镜像的
        // updatedSince 游标，使另一作用域的旧报告被永久跳过（Codex P2）。
        if (isDefaultScopeImport)
        {
            var newWatermark = watermark > DateTime.MinValue ? watermark : DateTime.UtcNow;
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.PeerSyncLastAt, newWatermark));
        }
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<DocumentStore>.Update.Combine(updates),
            cancellationToken: ct);

        _logger.LogInformation(
            "[cds-report-import] 完成 store={StoreId} total={Total} imported={Imported} updated={Updated} skipped={Skipped} failed={Failed}",
            store.Id, result.Total, result.Imported, result.Updated, result.Skipped, result.Failed);
        return result;
    }

    private async Task<(string baseUrl, string key)> ResolveCdsCredentialsAsync(CdsReportImportOptions opts, CancellationToken ct)
    {
        // 显式传入（测试 / 无连接时）优先
        if (!string.IsNullOrWhiteSpace(opts.CdsBaseUrl) && !string.IsNullOrWhiteSpace(opts.CdsAccessKey))
            return (opts.CdsBaseUrl!.TrimEnd('/'), opts.CdsAccessKey!);

        // 复用「系统互联」已授权的 CDS 全局连接
        InfraConnection? conn;
        if (!string.IsNullOrWhiteSpace(opts.ConnectionId))
            conn = await _infra.GetRawAsync(opts.ConnectionId!, ct);
        else
            conn = await _db.InfraConnections
                .Find(c => c.Partner == "cds" && c.Status == "active")
                .SortByDescending(c => c.UpdatedAt)
                .FirstOrDefaultAsync(ct);

        if (conn == null)
            throw new InvalidOperationException("未找到可用的 CDS 系统互联连接。请先在「系统互联」授权 CDS，或显式传 cdsBaseUrl + cdsAccessKey。");

        var token = await _infra.TryUnprotectLongTokenAsync(conn.Id, ct, revokeOnFailure: false);
        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException("CDS 连接的全局令牌已失效，请到「系统互联」重新授权 CDS。");
        if (string.IsNullOrWhiteSpace(conn.PartnerBaseUrl))
            throw new InvalidOperationException("CDS 连接缺少 baseUrl。");

        return (conn.PartnerBaseUrl.TrimEnd('/'), token!);
    }

    private async Task<DocumentStore> ResolveStoreAsync(string userId, string? storeId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(storeId))
        {
            var existing = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync(ct);
            if (existing == null) throw new InvalidOperationException("指定的目标知识库不存在。");
            // 鉴权：只允许导入到自己拥有的知识库。否则登录用户拿到别人的私有 storeId 就能
            // 把 CDS 报告写进那个库(Codex review P2)。CDS 报告镜像按设计就是导入自己的库；
            // 团队共享 / PM 项目成员的写入语义仍走常规 document-store 写端点。
            if (existing.OwnerId != userId)
                throw new InvalidOperationException("无权写入指定的目标知识库（只能导入到自己拥有的知识库）。");
            return existing;
        }

        var store = await _db.DocumentStores
            .Find(s => s.OwnerId == userId && s.AppKey == "cds-reports")
            .FirstOrDefaultAsync(ct);
        if (store != null) return store;

        store = new DocumentStore
        {
            Name = "CDS 验收报告",
            Description = "从 CDS 验收中心同步的验收报告（只读镜像，按 contentHash 增量）。",
            OwnerId = userId,
            AppKey = "cds-reports",
            Tags = new List<string> { "CDS", "验收" },
        };
        await _db.DocumentStores.InsertOneAsync(store, cancellationToken: ct);
        return store;
    }

    private static void TrackWatermark(CdsReportListItem r, ref DateTime watermark)
    {
        if (DateTime.TryParse(r.UpdatedAt, out var ua))
        {
            var u = ua.ToUniversalTime();
            if (u > watermark) watermark = u;
        }
    }

    /// <summary>从 CDS 列表项构造 MAP 条目的标题/标签/元数据（不依赖正文，可在 contentHash 命中时复用）。</summary>
    private static (string title, List<string> tags, Dictionary<string, string> metadata) BuildEntryMeta(CdsReportListItem r, string baseUrl)
    {
        var title = string.IsNullOrWhiteSpace(r.Title) ? "CDS 验收报告" : r.Title!;
        var metadata = new Dictionary<string, string>
        {
            ["cdsReportId"] = r.Id,
            ["cdsProjectId"] = r.ProjectId ?? string.Empty,
            ["cdsProjectSlug"] = r.ProjectSlug ?? string.Empty,
            ["verdict"] = r.Verdict ?? string.Empty,
            ["cdsUpdatedAt"] = r.UpdatedAt ?? string.Empty,
            ["cdsSourceBaseUrl"] = baseUrl,
        };
        var tags = string.IsNullOrWhiteSpace(r.Verdict)
            ? new List<string>()
            : new List<string> { VerdictTag(r.Verdict!) };
        return (title, tags, metadata);
    }

    private static bool MetadataEquals(Dictionary<string, string>? a, Dictionary<string, string> b)
    {
        var left = a ?? new Dictionary<string, string>();
        if (left.Count != b.Count) return false;
        foreach (var kv in b)
            if (!left.TryGetValue(kv.Key, out var v) || v != kv.Value) return false;
        return true;
    }

    private static string VerdictTag(string verdict) => verdict switch
    {
        "pass" => "通过",
        "conditional" => "有条件通过",
        "fail" => "不通过",
        _ => verdict,
    };

    private static string Sha256Hex(string input)
    {
        using var sha = SHA256.Create();
        var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(input));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private sealed class CdsReportListResponse
    {
        public List<CdsReportListItem>? Reports { get; set; }
    }

    private sealed class CdsReportListItem
    {
        public string Id { get; set; } = string.Empty;
        public string? Title { get; set; }
        public string? Format { get; set; }
        public string? Verdict { get; set; }
        public string? ProjectId { get; set; }
        public string? ProjectSlug { get; set; }
        public string? CreatedAt { get; set; }
        public string? UpdatedAt { get; set; }
    }
}

/// <summary>导入参数。</summary>
public class CdsReportImportOptions
{
    /// <summary>复用某个已存的 CDS 系统互联连接（不填则取最近活跃的 Partner=cds 连接）。</summary>
    public string? ConnectionId { get; set; }
    /// <summary>显式 CDS baseUrl（与 cdsAccessKey 一起用，覆盖连接解析，便于测试）。</summary>
    public string? CdsBaseUrl { get; set; }
    /// <summary>显式全局 key（X-AI-Access-Key）。</summary>
    public string? CdsAccessKey { get; set; }
    /// <summary>只拉某 CDS 项目的报告；不填拉全部（含全局）。</summary>
    public string? ProjectId { get; set; }
    /// <summary>目标知识库 Id；不填则 find-or-create「CDS 验收报告」。</summary>
    public string? StoreId { get; set; }
    /// <summary>忽略增量水位，全量重拉。</summary>
    public bool Full { get; set; }
}

/// <summary>导入结果。</summary>
public class CdsReportImportResult
{
    public int Total { get; set; }
    public int Imported { get; set; }
    public int Updated { get; set; }
    public int Skipped { get; set; }
    public int Failed { get; set; }
    public string StoreId { get; set; } = string.Empty;
    public string StoreName { get; set; } = string.Empty;
    public string CdsBaseUrl { get; set; } = string.Empty;
    public List<string> Messages { get; set; } = new();
}
