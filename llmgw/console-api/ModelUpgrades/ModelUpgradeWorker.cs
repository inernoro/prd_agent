using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Provisioning;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed class ModelUpgradeWorker(ModelUpgradeService service, ILogger<ModelUpgradeWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await service.TickAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception e) { logger.LogError("模型更新调度失败，异常类型 {Type}", e.GetType().Name); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
public sealed partial class ModelUpgradeService
{
    public async Task TickAsync(CancellationToken ct)
    {
        if (DeploymentBlockReason is not null) return;
        var now = DateTime.UtcNow;
        var filter = Builders<ModelUpgradeState>.Filter.Where(s => (s.PendingSwitch != null || s.PendingAction != "" || s.Policy.Enabled && s.NextCheckAt <= now)
            && (s.LeaseUntil == null || s.LeaseUntil < now));
        var pending = await States.Find(filter).Limit(20).ToListAsync(ct);
        foreach (var snapshot in pending)
        {
            ct.ThrowIfCancellationRequested();
            var token = Guid.NewGuid().ToString("N");
            var s = await States.FindOneAndUpdateAsync(filter & Builders<ModelUpgradeState>.Filter.Where(x => x.Id == snapshot.Id && x.Version == snapshot.Version),
                Builders<ModelUpgradeState>.Update.Set(x => x.LeaseToken, token).Set(x => x.LeaseUntil, DateTime.UtcNow.AddMinutes(3)).Inc(x => x.Version, 1),
                new FindOneAndUpdateOptions<ModelUpgradeState> { ReturnDocument = ReturnDocument.After }, ct);
            if (s is null) continue;
            string? audit = null;
            var action = s.PendingAction;
            try
            {
                await RequireActorAsync(s);
                if (s.PendingSwitch is not null)
                {
                    await RecoverSwitchAsync(s);
                    throw new ModelUpgradeException("INTERRUPTED_SWITCH", "已恢复中断切换的保留版本，请刷新并重新确认操作。");
                }
                if (action.Length == 0) { action = "check"; s.ExecutionRequestedBy = "scheduled"; }
                if (s.OutcomeUnknown && !(action == "validate" && s.ValidationMode == "evidence" && !string.IsNullOrWhiteSpace(s.EvidenceRequestId)))
                    throw new ModelUpgradeException("OUTCOME_UNKNOWN", "上次验收结果未知，自动操作已停止；请提供原请求真实证据核验，禁止重发。");
                if (action != "await-validation") audit = await AuditBeginAsync(s, action);
                s.PendingAction = "";
                switch (action)
                {
                    case "check": await CheckAsync(s, ct); break;
                    case "validate": await ValidateAsync(s); break;
                    case "await-validation": s.PendingAction = action; await PollValidationAsync(s); break;
                    case "promote": await SwitchAsync(s, false); break;
                    case "rollback": await SwitchAsync(s, true); break;
                    default: throw new ModelUpgradeException("INVALID_ACTION", "更新动作无效，请重新配置策略。");
                }
                if (action == "await-validation" && s.PendingAction != "await-validation") audit = await AuditBeginAsync(s, "validate");
                if (action != "await-validation" || s.PendingAction != "await-validation") History(s, action == "await-validation" ? "validate" : action, s.PendingAction == "await-validation" ? "queued" : "succeeded", s.Message, s.Candidate?.ValidationRequestId);
                if (audit is not null) await AuditCompleteAsync(s, audit, true);
            }
            catch (Exception ex)
            {
                if (action is "validate" or "await-validation" && !s.OutcomeUnknown && ex is not ModelUpgradeException { Code: "CANARY_EXPIRED_UNSENT" }) s.ValidationStatus = "failed";
                s.PendingAction = ""; s.Phase = ex is ModelUpgradeException ? "blocked" : "failed";
                s.Message = ex is ModelUpgradeException known ? known.Message : "后台操作未完成，原线路未确认改变；请核对诊断后重试。";
                History(s, action == "await-validation" ? "validate" : action, "blocked", s.Message, s.Candidate?.ValidationRequestId);
                if (audit is not null) await AuditCompleteAsync(s, audit, false);
                logger.LogWarning("模型更新 {Id} {Action} 未完成，异常类型 {Type}", s.LogicalModelId, action, ex.GetType().Name);
            }
            finally
            {
                s.NextCheckAt = s.Policy.Enabled ? ModelUpgradeRules.NextCheckAt(s.NextCheckAt, DateTime.UtcNow, s.Policy.CheckIntervalHours) : null;
                // Persist with lease token CAS, then release by a token-scoped update.
                await PersistAsync(s);
                await States.UpdateOneAsync(x => x.Id == s.Id && x.TenantId == s.TenantId && x.LeaseToken == token,
                    Builders<ModelUpgradeState>.Update.Set(x => x.LeaseToken, null).Set(x => x.LeaseUntil, null), cancellationToken: CancellationToken.None);
            }
        }
    }
    private async Task RequireActorAsync(ModelUpgradeState s)
    {
        var user = await gateway.GetCollection<BsonDocument>("llmgw_console_users").Find(F.And(F.Eq("_id", s.ActorConsoleUserId), F.Eq("IsActive", true))).AnyAsync(CancellationToken.None);
        var membership = await gateway.GetCollection<LlmGwMembership>("llmgw_memberships").Find(x => x.TenantId == s.TenantId && x.UserId == s.ActorConsoleUserId && x.Status == "active").FirstOrDefaultAsync(CancellationToken.None);
        var tenant = await gateway.GetCollection<LlmGwTenant>("llmgw_tenants").Find(x => x.Id == s.TenantId && x.Status == "active").FirstOrDefaultAsync(CancellationToken.None);
        if (!user || membership is null || tenant is null || !LlmGwPermissions.Allows(membership.Role, LlmGwPermissions.ConfigWrite)
            || !TenantOwnerAuthority.IsEffectiveOwner(tenant, membership))
            throw new ModelUpgradeException("POLICY_ACTOR_REVOKED", "策略创建者已失去配置权限，后台已停止；请由当前管理员重新保存策略。");
    }
}
