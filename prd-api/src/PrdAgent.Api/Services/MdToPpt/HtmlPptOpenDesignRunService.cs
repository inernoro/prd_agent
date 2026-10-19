using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.MdToPpt;

public sealed record HtmlPptOpenDesignInput(
    string SourceContent,
    string OutlineJson,
    int TargetPages,
    string Theme,
    string Instruction,
    string? ParentRunId = null,
    string? ParentPackageHash = null,
    string? StyleInstruction = null,
    string? ManualEditHtml = null);

public interface IHtmlPptOpenDesignRunService
{
    Task<DesignArtifactRun> QueueAsync(MdToPptRun compatibilityRun, HtmlPptOpenDesignInput input, CancellationToken ct);
}

/// <summary>
/// 把 PPT 的兼容 Run 与统一 DesignArtifact 队列绑定。大纲规划仍走原有快速路径；任何新成品
/// 与修改都只在这里创建 OpenDesign 任务，不保留静态模板或直连模型的第二执行入口。
/// </summary>
public sealed class HtmlPptOpenDesignRunService : IHtmlPptOpenDesignRunService
{
    private static readonly TimeSpan RunTtl = TimeSpan.FromHours(24);
    private readonly MongoDbContext _db;
    private readonly IDesignArtifactProviderCatalog _providers;
    private readonly IRunQueue _queue;
    private readonly IRunEventStore _events;
    private readonly IDesignGenerationSettingsService _designSettings;
    private readonly IConfiguration _configuration;
    private readonly ILogger<HtmlPptOpenDesignRunService> _logger;

    public HtmlPptOpenDesignRunService(
        MongoDbContext db,
        IDesignArtifactProviderCatalog providers,
        IRunQueue queue,
        IRunEventStore events,
        IDesignGenerationSettingsService designSettings,
        IConfiguration configuration,
        ILogger<HtmlPptOpenDesignRunService> logger)
    {
        _db = db;
        _providers = providers;
        _queue = queue;
        _events = events;
        _designSettings = designSettings;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task<DesignArtifactRun> QueueAsync(
        MdToPptRun compatibilityRun,
        HtmlPptOpenDesignInput input,
        CancellationToken ct)
    {
        if (compatibilityRun.Op == "outline")
            throw new InvalidOperationException("大纲规划不能进入 OpenDesign 成品队列");
        if (input.TargetPages is < 1 or > 100 || string.IsNullOrWhiteSpace(input.SourceContent)
            || string.IsNullOrWhiteSpace(input.OutlineJson))
            throw new InvalidOperationException("演示稿冻结输入不完整，请重新确认大纲");

        var capability = await _providers.FindAsync(
            compatibilityRun.UserId,
            DesignArtifactRuntimes.OpenDesign,
            ct);
        var operation = compatibilityRun.Op is "patch" or "manual-edit" or "normalize"
            ? DesignArtifactOperations.Edit
            : DesignArtifactOperations.Generate;
        if (capability == null || !capability.Enabled || !capability.Healthy
            || !capability.ArtifactTypes.Contains(DesignArtifactTypes.HtmlPpt, StringComparer.Ordinal)
            || !capability.Operations.Contains(operation, StringComparer.Ordinal))
            throw new InvalidOperationException(
                capability?.Reason ?? "设计服务暂不可用，演示稿输入已保留，请稍后重试");

        var now = DateTime.UtcNow;
        var sourceHash = Sha256(input.SourceContent);
        var outlineHash = Sha256(input.OutlineJson);
        var manualEditHtml = string.IsNullOrWhiteSpace(input.ManualEditHtml)
            ? null
            : input.ManualEditHtml;
        var manualEditHtmlHash = manualEditHtml == null ? null : Sha256(manualEditHtml);
        var run = new DesignArtifactRun
        {
            Id = compatibilityRun.Id,
            DeploymentSlug = DeploymentScope.Current,
            UserId = compatibilityRun.UserId,
            Status = RunStatuses.Queued,
            ArtifactType = DesignArtifactTypes.HtmlPpt,
            Operation = operation,
            SourceSurface = compatibilityRun.SourceSurface,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            LlmRequestPolicy = DesignArtifactModelSelection.CaptureForNewRun(_configuration),
            RuntimeConnectionId = capability.ConnectionId,
            Instruction = input.Instruction.Trim(),
            Title = compatibilityRun.Title,
            LinkedRunId = compatibilityRun.Id,
            KnowledgeReferences = compatibilityRun.KnowledgeReferences.ToList(),
            UploadedSources =
            [
                new DesignUploadedSource
                {
                    AttachmentId = $"ppt-source-{compatibilityRun.Id}",
                    FileName = "presentation-source.md",
                    MimeType = "text/markdown",
                    Content = input.SourceContent,
                    ContentHash = sourceHash,
                },
            ],
            InputAuthority = compatibilityRun.InputAuthority,
            UserSuppliedContentHash = compatibilityRun.UserSuppliedContentHash ?? sourceHash,
            PresentationInput = new DesignArtifactPresentationInput
            {
                TargetPages = input.TargetPages,
                SourceContent = input.SourceContent,
                SourceContentHash = sourceHash,
                OutlineJson = input.OutlineJson,
                OutlineHash = outlineHash,
                Theme = input.Theme.Trim(),
                ParentRunId = input.ParentRunId,
                ParentPackageHash = input.ParentPackageHash,
                ManualEditHtml = manualEditHtml,
                ManualEditHtmlHash = manualEditHtmlHash,
            },
            Progress = 2,
            PhaseCode = DesignArtifactPhaseCodes.Queued,
            Phase = operation == DesignArtifactOperations.Edit
                ? "演示稿修改任务已进入 OpenDesign 队列"
                : "演示稿生成任务已进入 OpenDesign 队列",
            FirstVisibleFeedbackAt = now,
            LastProgressAt = now,
            CreatedAt = now,
            UpdatedAt = now,
        };

        run.DesignDirection = await _designSettings.FreezeCatalogStyleAsync(
            ResolvePresentationDesignSystem(input.Theme),
            ct);
        if (!string.IsNullOrWhiteSpace(input.StyleInstruction))
        {
            var boundedStyle = input.StyleInstruction.Trim();
            if (boundedStyle.Length > 4_000) boundedStyle = boundedStyle[..4_000];
            run.DesignDirection.StyleDescription = $"{run.DesignDirection.StyleDescription}\n\n本次演示稿冻结的自定义风格要求：\n{boundedStyle}";
            run.DesignDirection.PromptFingerprint = DesignGenerationSettingsService.Fingerprint(run.DesignDirection);
        }

        if (operation == DesignArtifactOperations.Edit && !string.IsNullOrWhiteSpace(input.ParentRunId))
        {
            var parent = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current
                    && item.Id == input.ParentRunId
                    && item.UserId == compatibilityRun.UserId
                    && item.ArtifactType == DesignArtifactTypes.HtmlPpt
                    && item.Status == RunStatuses.Done)
                .FirstOrDefaultAsync(ct)
                ?? throw new InvalidOperationException("演示稿来源版本不存在或无权访问，请恢复自己的完成版本后重试");
            DesignArtifactBriefFactory.TryInheritFrozenContext(
                run,
                parent,
                DesignArtifactContextSources.InheritedSiteSourceRun,
                input.ParentRunId);
        }
        else
        {
            DesignArtifactBriefFactory.Freeze(run, currentHtml: null);
        }
        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(run, capability, currentHtml: null);

        await _db.DesignArtifactRuns.InsertOneAsync(run, cancellationToken: ct);
        await _db.MdToPptRuns.UpdateOneAsync(
            item => item.Id == compatibilityRun.Id && item.UserId == compatibilityRun.UserId,
            Builders<MdToPptRun>.Update
                .Set(item => item.Runtime, DesignArtifactRuntimes.OpenDesign)
                .Set(item => item.Provider, DesignArtifactRuntimes.OpenDesign)
                .Set(item => item.ArtifactContractVersion, DesignArtifactContractVersions.Current)
                .Set(item => item.ArtifactContractSynchronizedAt, null)
                .Set(item => item.UpdatedAt, now),
            cancellationToken: ct);

        try
        {
            await _events.SetRunAsync(RunKinds.DesignArtifact, new RunMeta
            {
                RunId = run.Id,
                Kind = RunKinds.DesignArtifact,
                Status = RunStatuses.Queued,
                CreatedByUserId = run.UserId,
                CreatedAt = now,
                InputJson = JsonSerializer.Serialize(new { artifactType = DesignArtifactTypes.HtmlPpt }),
            }, RunTtl, ct: CancellationToken.None);
            await _events.AppendEventAsync(
                RunKinds.DesignArtifact,
                run.Id,
                "phase",
                new { phaseCode = run.PhaseCode, progress = run.Progress, message = run.Phase },
                RunTtl,
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "演示稿 OpenDesign Redis 投影暂不可用 runId={RunId}", run.Id);
        }

        try
        {
            await _queue.EnqueueAsync(RunKinds.DesignArtifact, run.Id, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "演示稿 OpenDesign 即时入队失败，等待 Mongo 恢复器 runId={RunId}", run.Id);
        }
        return run;
    }

    private static string Sha256(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    internal static string ResolvePresentationDesignSystem(string? theme) => theme?.Trim().ToLowerInvariant() switch
    {
        "tech-dark" => "mission-control",
        "cobalt-grid" => "modern",
        "editorial-ink" => "editorial",
        "warm-zine" => "artistic",
        "swiss-minimal" => "minimal",
        "aurora-gradient" => "gradient",
        "sunset-bold" => "bold",
        "forest-organic" => "warm-editorial",
        "royal-velvet" => "luxury",
        "ocean-glass" => "glassmorphism",
        "atelier-zero" => "atelier-zero",
        "kami-paper" => "kami",
        _ => "storytelling",
    };
}
