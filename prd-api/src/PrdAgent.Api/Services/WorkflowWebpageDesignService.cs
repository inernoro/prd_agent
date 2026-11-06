using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>服务器在权限检查后传入，不能从工作流 Variables 或远端正文构造。</summary>
public sealed record WorkflowDesignInvocation(
    string UserId, string OperationId, string NodeId,
    string? ExecutionId = null, string? ExecutionOwnerUserId = null);

public sealed class WorkflowDesignException(string code, string message) : InvalidOperationException(message)
{
    public string Code { get; } = code;
}

public sealed record WorkflowDesignPackage(byte[] Content, string FileName);

public interface IWorkflowWebpageDesignService
{
    Task<CapsuleExecutor.CapsuleResult> ExecuteAsync(WorkflowNode node, Dictionary<string, string> variables,
        List<ExecutionArtifact> inputs, WorkflowDesignInvocation invocation, CapsuleExecutor.EmitEventDelegate? emit = null);
    Task CancelExecutionAsync(string executionId);
    Task<WorkflowDesignPackage> DownloadPackageAsync(string runId, string userId);
    Task<HostedSite> ResolveDeliveryAsync(ExecutionArtifact artifact, WorkflowDesignInvocation? invocation);
}

/// <summary>仅连接工作流与已有公共设计任务；执行、预算、完整包安全和版本由原服务负责。</summary>
public sealed class WorkflowWebpageDesignService(
    MongoDbContext db, IRunQueue queue, IRunEventStore events,
    IDesignArtifactProviderCatalog providers, ILlmGateway gateway,
    IHostedSiteService sites, IHostedSiteRevisionService revisions, IAssetStorage storage,
    IDesignArtifactCancellationCoordinator cancellation,
    ILogger<WorkflowWebpageDesignService> logger) : IWorkflowWebpageDesignService
{
    private static readonly TimeSpan EventTtl = TimeSpan.FromHours(24);

    internal static (string Caller, string ModelType) RouteFor(string nodeType) => nodeType switch
    {
        CapsuleTypes.WebpageGenerator => (AppCallerRegistry.WorkflowAgent.WebpageGenerator.Code, ModelTypes.Code),
        CapsuleTypes.ReportGenerator => (AppCallerRegistry.WorkflowAgent.ReportGenerator.Chat, ModelTypes.Chat),
        _ => throw new InvalidOperationException("该工作流节点不是网页报告，未发送设计请求"),
    };

    public async Task<CapsuleExecutor.CapsuleResult> ExecuteAsync(
        WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputs,
        WorkflowDesignInvocation invocation, CapsuleExecutor.EmitEventDelegate? emit = null)
    {
        if (string.IsNullOrWhiteSpace(invocation.UserId) || string.IsNullOrWhiteSpace(invocation.OperationId)
            || invocation.NodeId != node.NodeId)
            throw Error("WORKFLOW_DESIGN_IDENTITY_INVALID", "网页报告缺少有效任务身份，原输入已保留");
        await RequireInvocationAsync(invocation);
        var route = RouteFor(node.NodeType);
        var title = CapsuleExecutor.ReplaceVariables(CapsuleExecutor.GetConfigString(node, "title") ?? node.Name, variables);
        var instruction = CapsuleExecutor.ReplaceVariables(CapsuleExecutor.GetConfigString(node, "reportTemplate") ?? "", variables);
        instruction = $"请将所附工作流资料制作成可阅读、可下载的完整 HTML 网页报告。{instruction}\n视觉风格：{CapsuleExecutor.GetConfigString(node, "style") ?? "由 OpenDesign 选择合适风格"}。图表：{CapsuleExecutor.GetConfigString(node, "includeCharts") ?? "true"}。优先自包含交付；如需本地资源，交付完整 index.html/assets 文件包。内容组织、设计和自查由原生技能负责。";
        var sourceText = JsonSerializer.Serialize(inputs.Select(item => new { item.ArtifactId, item.Name, item.MimeType, item.InlineContent }));
        if (Encoding.UTF8.GetByteCount(sourceText) + Encoding.UTF8.GetByteCount(instruction) > 800_000)
            throw Error("WORKFLOW_DESIGN_INPUT_TOO_LARGE", "报告资料超过设计工作区容量，原输入已保留，请缩小本节点输入后再试");
        if (!inputs.Any(item => !string.IsNullOrWhiteSpace(item.InlineContent)))
            throw Error("WORKFLOW_DESIGN_INPUT_MISSING", "没有可读取的报告资料，原节点输入已保留");
        var fingerprint = Hash(JsonSerializer.Serialize(new { route.Caller, route.ModelType, title, instruction, sourceText,
            slots = node.OutputSlots.Select(slot => new { slot.SlotId, slot.Name, slot.DataType }) }));
        var runId = Hash($"workflow-design-v1\n{invocation.UserId}\n{invocation.OperationId}\n{node.NodeId}")[..32];
        var run = await db.DesignArtifactRuns.Find(item => item.Id == runId).FirstOrDefaultAsync(CancellationToken.None);
        var created = false;
        if (run == null)
        {
            var capability = await providers.FindAsync(invocation.UserId, DesignArtifactRuntimes.OpenDesign, CancellationToken.None);
            if (capability is not { Enabled: true } || !capability.ArtifactTypes.Contains(DesignArtifactTypes.WebPage)
                || !capability.Operations.Contains(DesignArtifactOperations.Generate)
                || !capability.SourceSurfaces.Contains(DesignArtifactSourceSurfaces.Workflow))
                throw Error("WORKFLOW_DESIGN_UNAVAILABLE", "设计服务暂不可用，报告未开始生成，原输入已保留");
            // 元数据不占恢复探针；由原caller的网关目录选择，MAP不另选一个全局设计池。
            var model = await gateway.ResolveModelMetadataAsync(route.Caller, route.ModelType, ct: CancellationToken.None);
            if (!model.Success || model.IsFallback || (string.IsNullOrWhiteSpace(model.ModelGroupId)
                    && string.IsNullOrWhiteSpace(model.LogicalModelPublicId)))
                throw Error("WORKFLOW_DESIGN_ROUTE_UNAVAILABLE", "原报告调用方没有可用的设计模型授权，未切换其他模型池，原输入已保留");
            var now = DateTime.UtcNow;
            run = new DesignArtifactRun
            {
                Id = runId, DeploymentSlug = DeploymentScope.Current, UserId = invocation.UserId,
                Runtime = DesignArtifactRuntimes.OpenDesign, ArtifactType = DesignArtifactTypes.WebPage,
                Operation = DesignArtifactOperations.Generate, SourceSurface = DesignArtifactSourceSurfaces.Workflow,
                RuntimeConnectionId = capability.ConnectionId, Title = title.Length > 200 ? title[..200] : title,
                Instruction = instruction, UserSuppliedContentHash = Hash(instruction),
                WorkflowSource = new WorkflowDesignSource { OperationId = invocation.OperationId, ExecutionId = invocation.ExecutionId,
                    NodeId = node.NodeId, NodeType = node.NodeType, InputFingerprint = fingerprint },
                LlmRequestPolicy = new DesignArtifactLlmRequestPolicy
                { ModelPoolId = model.ModelGroupId, Model = model.LogicalModelPublicId },
                UploadedSources = [new DesignUploadedSource { AttachmentId = Hash(sourceText)[..32], FileName = "workflow-input.json",
                    MimeType = "application/json", Content = sourceText, ContentHash = Hash(sourceText) }],
                InputAuthority = DesignArtifactInputAuthorities.UserSupplied,
                Progress = 2, PhaseCode = DesignArtifactPhaseCodes.Queued, Phase = "网页报告已进入设计队列",
                CreatedAt = now, UpdatedAt = now, FirstVisibleFeedbackAt = now, LastProgressAt = now,
            };
            DesignArtifactBriefFactory.Freeze(run, null);
            WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(run, capability, null);
            try { await db.DesignArtifactRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None); created = true; }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            { run = await db.DesignArtifactRuns.Find(item => item.Id == runId).SingleAsync(CancellationToken.None); }
        }
        if (run.UserId != invocation.UserId || run.WorkflowSource?.OperationId != invocation.OperationId
            || run.WorkflowSource.NodeId != node.NodeId || run.WorkflowSource.InputFingerprint != fingerprint
            || run.WorkflowSource.NodeType != node.NodeType || run.Runtime != DesignArtifactRuntimes.OpenDesign)
            throw Error("WORKFLOW_DESIGN_CONFLICT", "该报告操作的输入或来源已变化，未新发模型请求");
        if (invocation.ExecutionId != null && invocation.OperationId == invocation.ExecutionId)
            await db.WorkflowExecutions.UpdateOneAsync(item => item.Id == invocation.ExecutionId
                    && item.TriggeredBy == invocation.ExecutionOwnerUserId && item.NodeExecutions.Any(n => n.NodeId == node.NodeId),
                Builders<WorkflowExecution>.Update.Set("NodeExecutions.$.DesignRunId", run.Id), cancellationToken: CancellationToken.None);
        try
        {
            if (created) await events.SetRunAsync(RunKinds.DesignArtifact, new RunMeta { RunId = run.Id, Kind = RunKinds.DesignArtifact,
                CreatedByUserId = run.UserId, CreatedAt = run.CreatedAt, Status = run.Status }, EventTtl, ct: CancellationToken.None);
            if (run.Status == RunStatuses.Queued)
                await queue.EnqueueAsync(RunKinds.DesignArtifact, run.Id, CancellationToken.None);
        }
        catch (Exception ex) { logger.LogWarning(ex, "工作流设计任务投影/入队待原恢复器处理 runId={RunId}", run.Id); }
        while (true)
        {
            if (invocation.ExecutionId != null && invocation.OperationId == invocation.ExecutionId)
            {
                var execution = await db.WorkflowExecutions.Find(item => item.Id == invocation.ExecutionId)
                    .Project(item => new { item.Status }).FirstOrDefaultAsync(CancellationToken.None);
                if (execution?.Status == WorkflowExecutionStatus.Cancelled && run.CancelRequestedAt == null
                    && run.Status is RunStatuses.Queued or RunStatuses.Running)
                    await RequestCancellationAsync(run);
            }
            run = await db.DesignArtifactRuns.Find(item => item.Id == runId && item.UserId == invocation.UserId)
                .SingleAsync(CancellationToken.None);
            if (emit != null) await emit("node-design-progress", new { nodeId = node.NodeId, nodeName = node.Name,
                designRunId = run.Id, phase = run.Phase, phaseCode = run.PhaseCode, progress = run.Progress,
                elapsedSeconds = (int)(DateTime.UtcNow - run.CreatedAt).TotalSeconds,
                model = run.ResolvedModel, platform = run.ResolvedPlatform, status = run.Status });
            if (run.Status == RunStatuses.Done && run.PublishBindingOperationId != null)
                return await ProjectAsync(run, node);
            if (run.Status is RunStatuses.Error or RunStatuses.Cancelled)
                throw Error(run.Status == RunStatuses.Cancelled ? "WORKFLOW_DESIGN_CANCELLED" : run.LifecycleFailureCode ?? "WORKFLOW_DESIGN_FAILED",
                    run.Status == RunStatuses.Cancelled ? "网页报告任务已取消，原输入和历史报告仍保留" : "网页报告设计未完成，原输入和历史报告仍保留，请查看任务诊断");
            await Task.Delay(1000, CancellationToken.None);
        }
    }

    private async Task RequireInvocationAsync(WorkflowDesignInvocation invocation)
    {
        if (invocation.ExecutionId == null) return; // 已认证的单舱测试；operationId由控制器生成。
        var execution = await db.WorkflowExecutions.Find(item => item.Id == invocation.ExecutionId
                && item.TriggeredBy == invocation.ExecutionOwnerUserId && item.NodeSnapshot.Any(n => n.NodeId == invocation.NodeId))
            .FirstOrDefaultAsync(CancellationToken.None);
        if (execution == null) throw Error("WORKFLOW_DESIGN_FORBIDDEN", "报告来源不存在或无权访问");
        if (invocation.OperationId == invocation.ExecutionId && execution.Status == WorkflowExecutionStatus.Cancelled)
            throw Error("WORKFLOW_DESIGN_CANCELLED", "工作流已取消，未开始新的设计任务");
    }

    private async Task<CapsuleExecutor.CapsuleResult> ProjectAsync(DesignArtifactRun run, WorkflowNode node)
    {
        if (run.ContractVersion != DesignArtifactContractVersions.Current || run.ManifestValidation == null
            || run.Manifest == null || run.PublishBindingOperationId == null || run.ArtifactSiteId != run.ProducedArtifactSiteId
            || run.ArtifactRevisionId != run.ProducedArtifactRevisionId || string.IsNullOrWhiteSpace(run.ArtifactSiteId)
            || string.IsNullOrWhiteSpace(run.ArtifactRevisionId))
            throw Error("WORKFLOW_DESIGN_DELIVERY_PENDING", "报告文件正在完成安全保存，原任务身份已保留，请重新查看同一任务");
        var revision = await revisions.GetAsync(run.ArtifactSiteId, run.ArtifactRevisionId, run.UserId, CancellationToken.None);
        var site = await sites.GetByIdAsync(run.ArtifactSiteId, run.UserId, CancellationToken.None);
        if (revision?.SourceRunId != run.Id || revision.Status != HostedSiteRevisionStatuses.Published
            || site == null || revision.PublishedContentVersion == null || revision.PublishedEntryCosKey == null)
            throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告完整版本暂不可读取，未改动历史报告");
        var url = HostedSiteService.AppendVersion(storage.BuildUrlForKey(revision.PublishedEntryCosKey), revision.PublishedContentVersion.Value);
        var html = revision.Html;
        var artifact = CapsuleExecutor.MakeTextArtifact(node,
            node.NodeType == CapsuleTypes.ReportGenerator ? "report" : "webpage-out",
            string.IsNullOrWhiteSpace(run.Title) ? "网页报告" : run.Title, html, "text/html");
        artifact.ArtifactId = run.Id;
        artifact.CosUrl = url;
        artifact.DesignDelivery = new WorkflowDesignDelivery { RunId = run.Id, SiteId = site.Id, RevisionId = revision.Id,
            Url = url, DownloadPath = $"/api/workflow-agent/artifacts/{Uri.EscapeDataString(run.Id)}/package", PackageHash = run.VersionBoundary?.PackageHash ?? "", FileCount = revision.VerifiedFiles.Count };
        return new([artifact], $"网页报告已由 OpenDesign 完成并安全保存。设计任务：{run.Id}；完整文件：{revision.VerifiedFiles.Count}。模型：{run.ResolvedModel ?? "未报告"}。");
    }

    private async Task RequestCancellationAsync(DesignArtifactRun run)
    {
        try { await cancellation.RequestAsync(run.Id, run.UserId, CancellationToken.None); }
        catch (DesignArtifactLifecycleException ex) when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
        {
            // 同一任务的观察者与显式取消可以并发；只有已持久化的取消意图才等价重放。
            var current = await db.DesignArtifactRuns.Find(item => item.Id == run.Id && item.UserId == run.UserId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (current?.CancelRequestedAt == null) throw;
        }
    }

    public async Task CancelExecutionAsync(string executionId)
    {
        var runs = await db.DesignArtifactRuns.Find(item => item.SourceSurface == DesignArtifactSourceSurfaces.Workflow
            && item.WorkflowSource != null && item.WorkflowSource.ExecutionId == executionId
            && item.WorkflowSource.OperationId == executionId && (item.Status == RunStatuses.Queued || item.Status == RunStatuses.Running))
            .ToListAsync(CancellationToken.None);
        foreach (var run in runs) await RequestCancellationAsync(run);
    }

    public async Task<HostedSite> ResolveDeliveryAsync(ExecutionArtifact artifact, WorkflowDesignInvocation? invocation)
    {
        if (artifact.DesignDelivery == null || invocation?.ExecutionId == null)
            throw Error("WORKFLOW_DESIGN_FORBIDDEN", "缺少报告发布的真实执行来源，未发布内容");
        await RequireInvocationAsync(invocation);
        var delivery = artifact.DesignDelivery;
        var execution = await db.WorkflowExecutions.Find(item => item.Id == invocation.ExecutionId
            && item.TriggeredBy == invocation.ExecutionOwnerUserId).SingleAsync(CancellationToken.None);
        var sourceIds = execution.EdgeSnapshot.Where(edge => edge.TargetNodeId == invocation.NodeId).Select(edge => edge.SourceNodeId).ToArray();
        var source = execution.NodeExecutions.Where(item => sourceIds.Contains(item.NodeId))
            .SelectMany(item => item.OutputArtifacts).SingleOrDefault(item => item.ArtifactId == artifact.ArtifactId);
        var run = await db.DesignArtifactRuns.Find(item => item.Id == delivery.RunId && item.UserId == invocation.UserId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (!SameDelivery(source?.DesignDelivery, delivery) || run?.WorkflowSource == null
            || !sourceIds.Contains(run.WorkflowSource.NodeId) || run.Status != RunStatuses.Done
            || run.ArtifactSiteId != delivery.SiteId || run.ArtifactRevisionId != delivery.RevisionId
            || run.VersionBoundary?.PackageHash != delivery.PackageHash)
            throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告来源或完整版本不匹配，未发布内容");
        var origin = execution;
        for (var depth = 0; origin.Id != run.WorkflowSource.ExecutionId && depth < 16; depth++)
        {
            if (origin.TriggerType != "resume" || string.IsNullOrWhiteSpace(origin.ResumedFromExecutionId))
                throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告缺少可信的续跑来源，未发布内容");
            var parent = await db.WorkflowExecutions.Find(item => item.Id == origin.ResumedFromExecutionId
                && item.TriggeredBy == invocation.ExecutionOwnerUserId).FirstOrDefaultAsync(CancellationToken.None);
            var inherited = parent?.NodeExecutions.Where(item => item.NodeId == run.WorkflowSource.NodeId
                && item.Status == NodeExecutionStatus.Completed).SelectMany(item => item.OutputArtifacts)
                .SingleOrDefault(item => item.ArtifactId == artifact.ArtifactId);
            if (parent == null || parent.WorkflowId != origin.WorkflowId || !SameDelivery(inherited?.DesignDelivery, delivery))
                throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告继承的完整版本不匹配，未发布内容");
            origin = parent;
        }
        if (origin.Id != run.WorkflowSource.ExecutionId || run.WorkflowSource.OperationId != origin.Id)
            throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告来源任务不匹配，未发布内容");
        var site = await sites.GetByIdAsync(delivery.SiteId, invocation.UserId, CancellationToken.None);
        if (site == null || site.SourceRef != run.Id
            || (!string.IsNullOrEmpty(site.PublishedRevisionId) && site.PublishedRevisionId != delivery.RevisionId))
            throw Error("WORKFLOW_DESIGN_CONFLICT", "报告线上版本已变化，未覆盖当前内容");
        var publications = new MongoHostedSitePrivateSourceStore(db);
        var revision = await publications.FindRevisionAsync(site.Id, delivery.RevisionId, CancellationToken.None);
        if (revision == null
            || revision.Status != HostedSiteRevisionStatuses.Published || revision.SourceRunId != run.Id
            || revision.CreatedByUserId != run.UserId
            || (string.IsNullOrEmpty(site.PublishedRevisionId) && revision.Source != HostedSiteRevisionSources.Baseline))
            throw Error("WORKFLOW_DESIGN_CONFLICT", "报告线上版本已变化，未覆盖当前内容");
        // 入口服务给出有效内容版本（含旧站点回退值）；只读查询不创建快照或修补指针。
        var entry = await sites.GetEditableEntryHtmlAsync(site.Id, invocation.UserId, CancellationToken.None);
        var current = await publications.FindCurrentRevisionAsync(site.Id, entry.ContentVersion, CancellationToken.None);
        if (current?.Id != revision.Id || entry.Site.SourceRef != run.Id
            || (!string.IsNullOrEmpty(entry.Site.PublishedRevisionId) && entry.Site.PublishedRevisionId != revision.Id))
            throw Error("WORKFLOW_DESIGN_CONFLICT", "报告线上版本已变化，未覆盖当前内容");
        return entry.Site;
    }

    private static bool SameDelivery(WorkflowDesignDelivery? left, WorkflowDesignDelivery right) =>
        left != null && left.RunId == right.RunId && left.SiteId == right.SiteId
        && left.RevisionId == right.RevisionId && left.PackageHash == right.PackageHash && left.FileCount == right.FileCount;

    public async Task<WorkflowDesignPackage> DownloadPackageAsync(string runId, string userId)
    {
        var run = await db.DesignArtifactRuns.Find(item => item.Id == runId && item.UserId == userId
            && item.SourceSurface == DesignArtifactSourceSurfaces.Workflow).FirstOrDefaultAsync(CancellationToken.None);
        if (run?.WorkflowSource == null) throw Error("WORKFLOW_DESIGN_FORBIDDEN", "无权下载该报告");
        if (run.Status != RunStatuses.Done || run.ManifestValidation == null || run.VersionBoundary == null
            || run.ArtifactSiteId != run.ProducedArtifactSiteId || run.ArtifactRevisionId != run.ProducedArtifactRevisionId
            || string.IsNullOrEmpty(run.ArtifactSiteId) || string.IsNullOrEmpty(run.ArtifactRevisionId))
            throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告完整版本尚未就绪，原报告仍保留");
        var revision = await revisions.GetAsync(run.ArtifactSiteId, run.ArtifactRevisionId, userId, CancellationToken.None);
        if (revision?.SourceRunId != run.Id || revision.Status != HostedSiteRevisionStatuses.Published)
            throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告来源版本不匹配，未下载内容");
        try { _ = HostedSitePreviewAccessService.ComputePackageFingerprint(revision.VerifiedFiles); }
        catch (InvalidOperationException) { throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告资源校验未通过，未下载内容"); }
        var hash = DesignArtifactWorkspaceContract.ComputePublicArtifactRevision(revision.VerifiedFiles.Select(file =>
            new DesignArtifactManifestFile(file.Path, file.Sha256, file.Content.LongLength, file.MimeType)));
        if (hash != run.VersionBoundary.PackageHash)
            throw Error("WORKFLOW_DESIGN_DELIVERY_INVALID", "报告完整包身份不匹配，未下载内容");
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var file in revision.VerifiedFiles)
            {
                DesignArtifactPublicPath.TryNormalize(file.Path, out var path);
                using var entry = zip.CreateEntry(path, CompressionLevel.Fastest).Open();
                await entry.WriteAsync(file.Content, CancellationToken.None);
            }
        return new(output.ToArray(), $"report-{run.Id}.zip");
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static WorkflowDesignException Error(string code, string message) => new(code, message);
}
