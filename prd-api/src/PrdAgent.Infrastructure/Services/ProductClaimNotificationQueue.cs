using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Infrastructure.Services;

public static class ProductClaimNotificationQueue
{
    public static string DescribeDeploymentBlock(SharedScheduledWorkBlockReason reason) => reason switch
    {
        SharedScheduledWorkBlockReason.SharedStateOptedOut => "当前实例已退出共享任务",
        SharedScheduledWorkBlockReason.BranchPreview => "当前实例被识别为分支预览",
        SharedScheduledWorkBlockReason.DeploymentIdentityMissing => "当前实例缺少部署身份",
        SharedScheduledWorkBlockReason.AuthorizationMissing => "当前实例未配置共享后台任务授权",
        SharedScheduledWorkBlockReason.AuthorizationDisabled => "当前实例已停用共享后台任务",
        SharedScheduledWorkBlockReason.AuthorizationInvalid => "当前实例的共享后台任务授权值无效",
        _ => "当前实例的后台通知任务未获授权",
    };

    public static async Task<ProductClaimNotification?> CreateAsync<T>(
        MongoDbContext db, T snapshot, string? ownerId, bool formal, bool canNotify,
        SharedScheduledWorkBlockReason? deploymentBlock = null)
    {
        if (!canNotify && deploymentBlock is null) return null;
        var config = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync())?.ClaimWebhook;
        if (config?.Enabled != true || (formal ? !config.NotifyFormal : !config.NotifyInternal)) return null;
        if (deploymentBlock is { } reason)
            return new ProductClaimNotification { Status = "blocked", Error = DescribeDeploymentBlock(reason) };
        if (string.IsNullOrWhiteSpace(config.ProtectedUrl))
            return new ProductClaimNotification { Status = "blocked", Error = "尚未配置企微群机器人 Webhook" };
        // 只保存通知所需快照，不复制评审记录/附件/历史字段，也不读取其他人员身份。
        object body = snapshot switch {
            ProductInitiation t => new ProductInitiation { TCode = t.TCode, AppName = t.AppName, ProjectType = t.ProjectType,
                VersionType = t.VersionType, NeedUiDesign = t.NeedUiDesign, IsAiPoc = t.IsAiPoc, DemandSource = t.DemandSource,
                PlanName = t.PlanName, PlannedProjectAt = t.PlannedProjectAt, OwnerName = t.OwnerName },
            ProductRelease v => new ProductRelease { VCode = v.VCode, ProjectType = v.ProjectType, VersionType = v.VersionType, IsTemporaryOptimization = v.IsTemporaryOptimization,
                IsGlobalOpen = v.IsGlobalOpen, DemandSource = v.DemandSource, TapdLinks = v.TapdLinks, PlanName = v.PlanName, PlanUrl = v.PlanUrl,
                ProjectMemberNames = v.ProjectMemberNames, PlannedReleaseAt = v.PlannedReleaseAt,
                PlannedTrainingMinutes = v.PlannedTrainingMinutes, OwnerName = v.OwnerName },
            _ => throw new InvalidOperationException("不支持的申领通知类型"),
        };
        return new ProductClaimNotification { Status = config.DebugMode ? "debug_pending" : "pending",
            OwnerId = ownerId ?? string.Empty, Snapshot = JsonSerializer.Serialize(body, body.GetType()) };
    }
}
