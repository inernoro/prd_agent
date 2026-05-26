using System.Text;
using Markdig;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 网页/知识库自定义分类服务实现。
///
/// 生成路径分两种：
/// - Markdown：稳固的即时生成路径。Markdig 渲染 → 包壳 HTML →
///   IHostedSiteService.CreateFromContentAsync（web）或写入 DocumentEntry + ParsedPrd（document-store）。
/// - skill：暂为 best-effort/延后。skill 执行依赖 LLM/run-worker 异步链路，
///   wave 1 不在此构建半成品 LLM 管线，直接返回 { generated = false, reason }，
///   优先保证 Markdown 路径稳固（见 .claude/rules/no-rootless-tree.md：缺什么明确暴露）。
/// </summary>
public class WebFolderService : IWebFolderService
{
    private readonly MongoDbContext _db;
    private readonly IHostedSiteService _hostedSites;
    private readonly IDocumentService _documents;
    private readonly ILogger<WebFolderService> _logger;

    public WebFolderService(
        MongoDbContext db,
        IHostedSiteService hostedSites,
        IDocumentService documents,
        ILogger<WebFolderService> logger)
    {
        _db = db;
        _hostedSites = hostedSites;
        _documents = documents;
        _logger = logger;
    }

    public async Task<WebFolder> CreateAsync(string userId, WebFolder input, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var category = new WebFolder
        {
            OwnerUserId = userId,
            Name = (input.Name ?? string.Empty).Trim(),
            Description = input.Description?.Trim(),
            SortOrder = input.SortOrder,
            GeneratorType = WebFolderGeneratorType.All.Contains(input.GeneratorType)
                ? input.GeneratorType
                : WebFolderGeneratorType.None,
            GeneratorSkillId = string.IsNullOrWhiteSpace(input.GeneratorSkillId) ? null : input.GeneratorSkillId.Trim(),
            GeneratorMarkdown = input.GeneratorMarkdown,
            GenerateTarget = WebFolderGenerateTarget.All.Contains(input.GenerateTarget)
                ? input.GenerateTarget
                : WebFolderGenerateTarget.Web,
            GenerateStoreId = string.IsNullOrWhiteSpace(input.GenerateStoreId) ? null : input.GenerateStoreId.Trim(),
            CreatedAt = now,
            UpdatedAt = now,
        };

        await _db.WebCategories.InsertOneAsync(category, cancellationToken: ct);
        _logger.LogInformation("[web-folder] Created {Id} '{Name}' by {UserId}", category.Id, category.Name, userId);
        return category;
    }

    public async Task<List<WebFolder>> ListAsync(string userId, CancellationToken ct = default)
    {
        return await _db.WebCategories
            .Find(c => c.OwnerUserId == userId)
            .Sort(Builders<WebFolder>.Sort
                .Ascending(c => c.SortOrder)
                .Ascending(c => c.CreatedAt))
            .ToListAsync(ct);
    }

    public async Task<WebFolder?> UpdateAsync(string id, string userId, WebFolder patch, CancellationToken ct = default)
    {
        var existing = await _db.WebCategories
            .Find(c => c.Id == id && c.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (existing == null) return null;

        var ub = Builders<WebFolder>.Update;
        var updates = new List<UpdateDefinition<WebFolder>>();

        if (patch.Name != null)
            updates.Add(ub.Set(c => c.Name, patch.Name.Trim()));
        if (patch.Description != null)
            updates.Add(ub.Set(c => c.Description, patch.Description.Trim()));
        updates.Add(ub.Set(c => c.SortOrder, patch.SortOrder));
        if (WebFolderGeneratorType.All.Contains(patch.GeneratorType))
            updates.Add(ub.Set(c => c.GeneratorType, patch.GeneratorType));
        updates.Add(ub.Set(c => c.GeneratorSkillId,
            string.IsNullOrWhiteSpace(patch.GeneratorSkillId) ? null : patch.GeneratorSkillId.Trim()));
        updates.Add(ub.Set(c => c.GeneratorMarkdown, patch.GeneratorMarkdown));
        if (WebFolderGenerateTarget.All.Contains(patch.GenerateTarget))
            updates.Add(ub.Set(c => c.GenerateTarget, patch.GenerateTarget));
        updates.Add(ub.Set(c => c.GenerateStoreId,
            string.IsNullOrWhiteSpace(patch.GenerateStoreId) ? null : patch.GenerateStoreId.Trim()));
        updates.Add(ub.Set(c => c.UpdatedAt, DateTime.UtcNow));

        await _db.WebCategories.UpdateOneAsync(
            c => c.Id == id && c.OwnerUserId == userId,
            ub.Combine(updates),
            cancellationToken: ct);

        return await _db.WebCategories
            .Find(c => c.Id == id && c.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<bool> DeleteAsync(string id, string userId, CancellationToken ct = default)
    {
        var result = await _db.WebCategories.DeleteOneAsync(
            c => c.Id == id && c.OwnerUserId == userId, ct);
        return result.DeletedCount > 0;
    }

    public async Task<object> GenerateAsync(string id, string userId, CancellationToken ct = default)
    {
        var category = await _db.WebCategories
            .Find(c => c.Id == id && c.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (category == null)
            return new { generated = false, reason = "分类不存在或无权访问" };

        // ── skill 生成：best-effort，wave 1 延后（依赖 LLM/run-worker 异步链路）──
        if (category.GeneratorType == WebFolderGeneratorType.Skill)
        {
            _logger.LogInformation(
                "[web-folder] Generate {Id} skill path deferred (skillId={SkillId})",
                category.Id, category.GeneratorSkillId);
            return new
            {
                generated = false,
                reason = "skill 生成需异步执行（依赖 LLM 调用链），暂仅支持 Markdown 即时生成",
            };
        }

        // ── Markdown 生成 ──
        if (category.GeneratorType == WebFolderGeneratorType.Markdown)
        {
            var markdown = category.GeneratorMarkdown ?? string.Empty;
            if (string.IsNullOrWhiteSpace(markdown))
                return new { generated = false, reason = "该分类未配置 Markdown 模板内容" };

            var title = $"{category.Name} {DateTime.Now:yyyy-MM-dd HH:mm}";

            if (category.GenerateTarget == WebFolderGenerateTarget.DocumentStore)
            {
                return await GenerateDocumentEntryAsync(category, userId, markdown, title, ct);
            }

            // 默认 web 目标
            var html = RenderMarkdownToHtml(markdown, title);
            var site = await _hostedSites.CreateFromContentAsync(
                userId, html, title, category.Description,
                sourceType: "category-gen", sourceRef: category.Id,
                tags: null, folder: category.Name, ct);

            _logger.LogInformation(
                "[web-folder] Generated web page {SiteId} from category {CategoryId}", site.Id, category.Id);

            return new
            {
                generated = true,
                target = WebFolderGenerateTarget.Web,
                siteId = site.Id,
                title = site.Title,
                siteUrl = site.SiteUrl,
                entryFile = site.EntryFile,
            };
        }

        // ── none ──
        return new { generated = false, reason = "该分类未绑定生成器" };
    }

    /// <summary>生成知识库条目：校验 store 归属 → 创建 ParsedPrd → 写 DocumentEntry → 计数 +1</summary>
    private async Task<object> GenerateDocumentEntryAsync(
        WebFolder category, string userId, string markdown, string title, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(category.GenerateStoreId))
            return new { generated = false, reason = "生成目标为知识库，但未指定知识库空间 ID" };

        var store = await _db.DocumentStores
            .Find(s => s.Id == category.GenerateStoreId)
            .FirstOrDefaultAsync(ct);
        if (store == null)
            return new { generated = false, reason = "指定的知识库空间不存在" };
        if (store.OwnerId != userId)
            return new { generated = false, reason = "无权写入该知识库空间" };

        // 解析正文为 ParsedPrd（镜像 DocumentStoreController.UpdateEntryContent 的创建路径）
        var parsed = await _documents.ParseAsync(markdown);
        parsed.Title = title;
        await _documents.SaveAsync(parsed);

        var summary = markdown.Length > 200 ? markdown[..200] : markdown;
        var contentIndex = markdown.Length > 2000 ? markdown[..2000] : markdown;

        var entry = new DocumentEntry
        {
            StoreId = store.Id,
            ParentId = null,
            IsFolder = false,
            DocumentId = parsed.Id,
            Title = title,
            Summary = summary.Trim(),
            SourceType = DocumentSourceType.Import,
            ContentType = "text/markdown",
            ContentIndex = contentIndex.Trim(),
            CreatedBy = userId,
            UpdatedBy = userId,
            LastChangedAt = DateTime.UtcNow,
        };

        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: ct);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<PrdAgent.Core.Models.DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation(
            "[web-folder] Generated document entry {EntryId} in store {StoreId} from category {CategoryId}",
            entry.Id, store.Id, category.Id);

        return new
        {
            generated = true,
            target = WebFolderGenerateTarget.DocumentStore,
            storeId = store.Id,
            entryId = entry.Id,
            documentId = parsed.Id,
            title = entry.Title,
        };
    }

    /// <summary>Markdig 渲染 Markdown → 安全 HTML，包一层最小 HTML 壳。关闭原始 HTML 透传防 XSS。</summary>
    private static string RenderMarkdownToHtml(string markdown, string title)
    {
        var pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .UseSoftlineBreakAsHardlineBreak()
            .DisableHtml()
            .Build();
        var bodyHtml = Markdig.Markdown.ToHtml(markdown, pipeline);
        var safeTitle = HtmlEscape(title);

        var sb = new StringBuilder();
        sb.AppendLine("<!DOCTYPE html>");
        sb.AppendLine("<html lang=\"zh-CN\">");
        sb.AppendLine("<head>");
        sb.AppendLine("  <meta charset=\"UTF-8\" />");
        sb.AppendLine("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />");
        sb.Append("  <title>").Append(safeTitle).AppendLine("</title>");
        sb.AppendLine("  <style>");
        sb.AppendLine("    :root{color-scheme:light dark;}");
        sb.AppendLine("    body{margin:0;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2328;background:#fff;}");
        sb.AppendLine("    .markdown-body{max-width:780px;margin:0 auto;}");
        sb.AppendLine("    .markdown-body h1,.markdown-body h2,.markdown-body h3{border-bottom:1px solid #eaecef;padding-bottom:0.3em;margin-top:1.8em;}");
        sb.AppendLine("    .markdown-body pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto;}");
        sb.AppendLine("    .markdown-body code{background:rgba(175,184,193,0.2);padding:.2em .4em;border-radius:6px;font-size:85%;}");
        sb.AppendLine("    .markdown-body pre code{background:transparent;padding:0;}");
        sb.AppendLine("    .markdown-body img{max-width:100%;}");
        sb.AppendLine("    .markdown-body blockquote{border-left:4px solid #d0d7de;padding:0 1em;color:#57606a;margin:0;}");
        sb.AppendLine("    .markdown-body table{border-collapse:collapse;}");
        sb.AppendLine("    .markdown-body th,.markdown-body td{border:1px solid #d0d7de;padding:6px 13px;}");
        sb.AppendLine("    @media (prefers-color-scheme: dark){");
        sb.AppendLine("      body{background:#0d1117;color:#e6edf3;}");
        sb.AppendLine("      .markdown-body h1,.markdown-body h2,.markdown-body h3{border-bottom-color:#30363d;}");
        sb.AppendLine("      .markdown-body pre{background:#161b22;}");
        sb.AppendLine("      .markdown-body code{background:rgba(110,118,129,0.4);}");
        sb.AppendLine("      .markdown-body blockquote{border-left-color:#30363d;color:#8b949e;}");
        sb.AppendLine("      .markdown-body th,.markdown-body td{border-color:#30363d;}");
        sb.AppendLine("    }");
        sb.AppendLine("  </style>");
        sb.AppendLine("</head>");
        sb.AppendLine("<body>");
        sb.AppendLine("  <article class=\"markdown-body\">");
        sb.AppendLine(bodyHtml);
        sb.AppendLine("  </article>");
        sb.AppendLine("</body>");
        sb.AppendLine("</html>");
        return sb.ToString();
    }

    private static string HtmlEscape(string s)
        => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
