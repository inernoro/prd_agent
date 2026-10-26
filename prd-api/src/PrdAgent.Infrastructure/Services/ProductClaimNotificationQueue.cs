using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

public static class ProductClaimNotificationQueue
{
    public static async Task<ProductClaimNotification?> CreateAsync<T>(MongoDbContext db, T snapshot, string? ownerId, bool formal, bool canNotify)
    {
        if (!canNotify) return null;
        var config = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync())?.ClaimWebhook;
        if (config?.Enabled != true || (formal ? !config.NotifyFormal : !config.NotifyInternal)) return null;
        // 只保存通知所需快照，不复制评审记录/附件/历史字段，也不读取其他人员身份。
        object body = snapshot switch {
            ProductInitiation t => new ProductInitiation { TCode = t.TCode, AppName = t.AppName, ProjectType = t.ProjectType,
                VersionType = t.VersionType, NeedUiDesign = t.NeedUiDesign, IsAiPoc = t.IsAiPoc, DemandSource = t.DemandSource,
                PlanName = t.PlanName, PlannedProjectAt = t.PlannedProjectAt, OwnerName = t.OwnerName },
            ProductRelease v => new ProductRelease { VCode = v.VCode, ProjectType = v.ProjectType, VersionType = v.VersionType,
                IsGlobalOpen = v.IsGlobalOpen, DemandSource = v.DemandSource, PlanName = v.PlanName, PlanUrl = v.PlanUrl,
                ProjectMemberNames = v.ProjectMemberNames, PlannedReleaseAt = v.PlannedReleaseAt,
                PlannedTrainingMinutes = v.PlannedTrainingMinutes, OwnerName = v.OwnerName },
            _ => throw new InvalidOperationException("不支持的申领通知类型"),
        };
        return new ProductClaimNotification { OwnerId = ownerId ?? string.Empty, Snapshot = JsonSerializer.Serialize(body, body.GetType()) };
    }
}
