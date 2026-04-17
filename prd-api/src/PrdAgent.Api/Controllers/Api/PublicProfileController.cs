using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 个人公开页 — 聚合展示某用户在 8 个领域中标记为公开的资源。
///
/// 支持的领域：
/// - sites        网页站点 (hosted_sites, Visibility="public")
/// - skills       个人技能 (skills, Visibility="personal" AND IsPublic=true)
/// - documents    文档空间 (document_stores, IsPublic=true)
/// - prompts      文学提示词 (literary_prompts, IsPublic=true)
/// - workspaces   视觉创作工作空间 (image_master_workspaces, IsPublic=true)
/// - emergences   涌现树 (emergence_trees, IsPublic=true)
/// - workflows    工作流 (workflows, IsPublic=true)
///
/// 与点对点分享（ShareLink，/s/**）的区别：
/// - 点对点：用户主动生成链接发给特定对象，私密
/// - 公开页：对应"拖到 Dock 的 🌍 公开槽位"动作，放给所有人看
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/public")]
public class PublicProfileController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IHostedSiteService _siteService;

    // 每个领域一次拉取上限，足够首屏展示；真正深度浏览由各自详情页承担
    private const int PerSectionLimit = 24;

    public PublicProfileController(MongoDbContext db, IHostedSiteService siteService)
    {
        _db = db;
        _siteService = siteService;
    }

    /// <summary>获取个人公开页聚合数据（用户信息 + 8 个领域的公开资源）</summary>
    [HttpGet("u/{username}")]
    public async Task<IActionResult> GetProfile(string username, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(username))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "用户名不能为空"));

        var user = await _db.Users
            .Find(x => x.Username == username && x.Status == UserStatus.Active)
            .FirstOrDefaultAsync(ct);

        if (user == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "用户不存在"));

        var uid = user.UserId;

        // 并行拉取 7 个领域的公开资源
        var sitesTask = _siteService.ListPublicByUserIdAsync(uid, PerSectionLimit, ct);
        var skillsTask = GetPublicSkillsAsync(uid, ct);
        var documentsTask = GetPublicDocumentStoresAsync(uid, ct);
        var promptsTask = GetPublicLiteraryPromptsAsync(uid, ct);
        var workspacesTask = GetPublicWorkspacesAsync(uid, ct);
        var emergencesTask = GetPublicEmergenceTreesAsync(uid, ct);
        var workflowsTask = GetPublicWorkflowsAsync(uid, ct);

        await Task.WhenAll(sitesTask, skillsTask, documentsTask, promptsTask,
                           workspacesTask, emergencesTask, workflowsTask);

        var profile = new
        {
            user = new
            {
                username = user.Username,
                displayName = string.IsNullOrWhiteSpace(user.DisplayName) ? user.Username : user.DisplayName,
                avatarFileName = user.AvatarFileName,
            },
            sites = new
            {
                items = sitesTask.Result.Select(s => new
                {
                    id = s.Id,
                    title = s.Title,
                    description = s.Description,
                    siteUrl = s.SiteUrl,
                    coverImageUrl = s.CoverImageUrl,
                    tags = s.Tags,
                    viewCount = s.ViewCount,
                    publishedAt = s.PublishedAt,
                    updatedAt = s.UpdatedAt,
                }).ToList(),
                total = sitesTask.Result.Count,
            },
            skills = new
            {
                items = skillsTask.Result.Select(s => new
                {
                    id = s.Id,
                    skillKey = s.SkillKey,
                    title = s.Title,
                    description = s.Description,
                    icon = s.Icon,
                    category = s.Category,
                    tags = s.Tags,
                    usageCount = s.UsageCount,
                    publishedAt = s.PublishedAt,
                    updatedAt = s.UpdatedAt,
                }).ToList(),
                total = skillsTask.Result.Count,
            },
            documents = new
            {
                items = documentsTask.Result.Select(d => new
                {
                    id = d.Id,
                    name = d.Name,
                    description = d.Description,
                    coverImageUrl = d.CoverImageUrl,
                    tags = d.Tags,
                    documentCount = d.DocumentCount,
                    viewCount = d.ViewCount,
                    updatedAt = d.UpdatedAt,
                }).ToList(),
                total = documentsTask.Result.Count,
            },
            prompts = new
            {
                items = promptsTask.Result.Select(p => new
                {
                    id = p.Id,
                    title = p.Title,
                    scenarioType = p.ScenarioType,
                    forkCount = p.ForkCount,
                    updatedAt = p.UpdatedAt,
                }).ToList(),
                total = promptsTask.Result.Count,
            },
            workspaces = new
            {
                items = workspacesTask.Result.Select(w => new
                {
                    id = w.Id,
                    title = w.Title,
                    coverAssetId = w.CoverAssetId,
                    publishedAt = w.PublishedAt,
                    updatedAt = w.UpdatedAt,
                }).ToList(),
                total = workspacesTask.Result.Count,
            },
            emergences = new
            {
                items = emergencesTask.Result.Select(e => new
                {
                    id = e.Id,
                    title = e.Title,
                    description = e.Description,
                    nodeCount = e.NodeCount,
                    updatedAt = e.UpdatedAt,
                }).ToList(),
                total = emergencesTask.Result.Count,
            },
            workflows = new
            {
                items = workflowsTask.Result.Select(w => new
                {
                    id = w.Id,
                    name = w.Name,
                    description = w.Description,
                    avatarUrl = w.AvatarUrl,
                    tags = w.Tags,
                    executionCount = w.ExecutionCount,
                    updatedAt = w.UpdatedAt,
                }).ToList(),
                total = workflowsTask.Result.Count,
            },
        };

        return Ok(ApiResponse<object>.Ok(profile));
    }

    // ─── 私有查询方法：统一按 UpdatedAt 倒序 + limit ───

    private async Task<List<Skill>> GetPublicSkillsAsync(string userId, CancellationToken ct)
    {
        // 个人技能发布到广场：Visibility == "personal" AND IsPublic=true AND OwnerUserId == userId
        var filter = Builders<Skill>.Filter.And(
            Builders<Skill>.Filter.Eq(x => x.Visibility, SkillVisibility.Personal),
            Builders<Skill>.Filter.Eq(x => x.IsPublic, true),
            Builders<Skill>.Filter.Eq(x => x.OwnerUserId, userId),
            Builders<Skill>.Filter.Eq(x => x.IsEnabled, true));

        return await _db.Skills.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(PerSectionLimit)
            .ToListAsync(ct);
    }

    private async Task<List<DocumentStore>> GetPublicDocumentStoresAsync(string userId, CancellationToken ct)
    {
        var filter = Builders<DocumentStore>.Filter.And(
            Builders<DocumentStore>.Filter.Eq(x => x.OwnerId, userId),
            Builders<DocumentStore>.Filter.Eq(x => x.IsPublic, true));

        return await _db.DocumentStores.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(PerSectionLimit)
            .ToListAsync(ct);
    }

    private async Task<List<LiteraryPrompt>> GetPublicLiteraryPromptsAsync(string userId, CancellationToken ct)
    {
        var filter = Builders<LiteraryPrompt>.Filter.And(
            Builders<LiteraryPrompt>.Filter.Eq(x => x.OwnerUserId, userId),
            Builders<LiteraryPrompt>.Filter.Eq(x => x.IsPublic, true));

        return await _db.LiteraryPrompts.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(PerSectionLimit)
            .ToListAsync(ct);
    }

    private async Task<List<ImageMasterWorkspace>> GetPublicWorkspacesAsync(string userId, CancellationToken ct)
    {
        var filter = Builders<ImageMasterWorkspace>.Filter.And(
            Builders<ImageMasterWorkspace>.Filter.Eq(x => x.OwnerUserId, userId),
            Builders<ImageMasterWorkspace>.Filter.Eq(x => x.IsPublic, true));

        return await _db.ImageMasterWorkspaces.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(PerSectionLimit)
            .ToListAsync(ct);
    }

    private async Task<List<EmergenceTree>> GetPublicEmergenceTreesAsync(string userId, CancellationToken ct)
    {
        var filter = Builders<EmergenceTree>.Filter.And(
            Builders<EmergenceTree>.Filter.Eq(x => x.OwnerId, userId),
            Builders<EmergenceTree>.Filter.Eq(x => x.IsPublic, true));

        return await _db.EmergenceTrees.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(PerSectionLimit)
            .ToListAsync(ct);
    }

    private async Task<List<Workflow>> GetPublicWorkflowsAsync(string userId, CancellationToken ct)
    {
        // Workflow 同时支持 OwnerUserId 和 CreatedBy 两个字段做归属判定
        var filter = Builders<Workflow>.Filter.And(
            Builders<Workflow>.Filter.Eq(x => x.IsPublic, true),
            Builders<Workflow>.Filter.Or(
                Builders<Workflow>.Filter.Eq(x => x.OwnerUserId, userId),
                Builders<Workflow>.Filter.Eq(x => x.CreatedBy, userId)));

        return await _db.Workflows.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(PerSectionLimit)
            .ToListAsync(ct);
    }
}
