using MongoDB.Driver;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    // 编号和快照先持久化，再执行有时限的发送；投递故障不回滚编号。
    private async Task<ProductClaimNotification?> TrySendIssuedClaimAsync(string kind, string id, ProductClaimNotification? notice)
    {
        if (notice?.Status != "pending") return notice;
        try
        {
            return await ProductClaimWebhookWorker.DispatchRecordAsync(kind, id, HttpContext.RequestServices,
                manualDispatch: false) ?? notice;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("版本申领已保存，通知投递未启动。类型 {Kind}，异常类型 {ErrorType}", kind, ex.GetType().Name);
            const string message = "版本号已生成，通知暂未启动；请在设置的版本申领通知中刷新状态或手动补发。";
            if (kind == "T")
                await _db.ProductInitiations.UpdateOneAsync(x => x.Id == id && x.ClaimNotification != null && x.ClaimNotification.Status == "pending",
                    Builders<ProductInitiation>.Update.Set(x => x.ClaimNotification!.Error, message), cancellationToken: CancellationToken.None);
            else
                await _db.ProductReleases.UpdateOneAsync(x => x.Id == id && x.ClaimNotification != null && x.ClaimNotification.Status == "pending",
                    Builders<ProductRelease>.Update.Set(x => x.ClaimNotification!.Error, message), cancellationToken: CancellationToken.None);
            notice.Error = message;
            return notice;
        }
    }
}
