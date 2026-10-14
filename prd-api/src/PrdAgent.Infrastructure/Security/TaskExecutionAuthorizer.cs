using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using MongoDB.Bson;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Security;

/// <summary>统一出口只接受平台注册的任务引用，不能由业务自行声明人工来源。</summary>
public sealed class TaskExecutionAuthorizer(LlmGatewayDataContext data, IConfiguration configuration)
    : ITaskExecutionAuthorizer
{
    public async Task AuthorizeOutboundAsync(HttpRequestMessage message, string appCallerCode,
        GatewayRequestContext? context, CancellationToken ct)
    {
        try { await AuthorizeCoreAsync(message, appCallerCode, context, ct); }
        catch (Exception error) when (error is MongoException or TimeoutException)
        {
            throw new TaskExecutionAdmissionException("TASK_ADMISSION_UNAVAILABLE",
                "任务保护暂时无法核验，本次调用已停止；请稍后重试。", 503);
        }
    }

    private async Task AuthorizeCoreAsync(HttpRequestMessage message, string appCallerCode,
        GatewayRequestContext? context, CancellationToken ct)
    {
        var identity = TaskExecutionContext.Current;
        if (identity is null || !ValidPermitId(identity.PermitId))
            throw Denied("TASK_EXECUTION_NOT_ADMITTED", "本次任务没有获得执行许可，已停止模型调用；请重新明确提交操作。");
        var permits = data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
        GatewayTaskPermitRecord? permit;
        try { permit = await permits.Find(x => x.Id == identity.PermitId).FirstOrDefaultAsync(ct); }
        catch (Exception error) when (error is MongoException or TimeoutException)
        {
            throw new TaskExecutionAdmissionException("TASK_ADMISSION_UNAVAILABLE",
                "任务保护暂时无法核验，本次调用已停止；请稍后重试。", 503);
        }
        var now = DateTime.UtcNow;
        var deployment = TaskPermitDeployment.Resolve(configuration);
        var tenant = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } value
            ? value : GatewayTenantDefaults.InternalTenantId;
        if (permit is null || permit.RevokedAt is not null || permit.ExpiresAt <= now
            || permit.CreatedAt > now || permit.ExpiresAt <= permit.CreatedAt
            || permit.ExpiresAt - permit.CreatedAt > GatewayTaskPermitRecord.MaximumLifetime
            || permit.MaxCalls is <= 0 or > GatewayTaskPermitRecord.MaximumCalls
            || permit.MaxRuns is <= 0 or > GatewayTaskPermitRecord.MaximumRuns
            || permit.CallCount < 0 || permit.CallCount >= permit.MaxCalls
            || permit.BoundRunIds.Count > permit.MaxRuns || !TaskExecutionOrigins.IsKnown(permit.Origin)
            || permit.Origin == TaskExecutionOrigins.Scheduled && permit.AllowDelegatedSubjects)
            throw Denied("TASK_PERMIT_INVALID", "本次任务的执行许可已失效或额度已用尽；请核对任务状态后重新提交。");
        if (permit.SourceDeployment != deployment || permit.TenantId != tenant
            || !permit.AllowedAppCallerCodes.Contains(appCallerCode, StringComparer.Ordinal)
            || string.IsNullOrWhiteSpace(permit.ActorUserId)
            || string.IsNullOrWhiteSpace(permit.TriggerCredentialId)
            || string.IsNullOrWhiteSpace(permit.SourceTask)
            || context?.TenantId is { Length: > 0 } requestedTenant && requestedTenant != tenant)
            throw Denied("TASK_PERMIT_SCOPE_DENIED", "本次调用超出已批准任务的执行范围，已停止；请核对操作与任务归属。");

        var runId = identity.RunId ?? context?.RunId;
        var subject = context?.UserId is { Length: > 0 } declaredSubject ? declaredSubject
            : permit.SubjectUserIds.Count == 1 ? permit.SubjectUserIds[0] : permit.ActorUserId;
        // 调度器身份只表示执行来源，业务归属必须由调度准入预先批准。
        if (!permit.SubjectUserIds.Contains(subject, StringComparer.Ordinal)
            && (permit.Origin == TaskExecutionOrigins.Scheduled || subject != permit.ActorUserId))
        {
            if (!permit.AllowDelegatedSubjects || string.IsNullOrWhiteSpace(identity.RunId))
                throw Denied("TASK_PERMIT_SUBJECT_DENIED", "本次调用的业务归属超出已批准范围，已停止；请核对任务归属。");
            // 只有平台注册的管理续跑动作允许委托；原任务由控制器现有 ACL 核验，数量有界。
            var subjectFilter = Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.Id, permit.Id)
                & Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.RevokedAt, null)
                & Builders<GatewayTaskPermitRecord>.Filter.Gt(x => x.ExpiresAt, now)
                & new BsonDocumentFilterDefinition<GatewayTaskPermitRecord>(new BsonDocument("$or", new BsonArray
                {
                    new BsonDocument("SubjectUserIds", subject),
                    new BsonDocument("$expr", new BsonDocument("$lt", new BsonArray
                    { new BsonDocument("$size", "$SubjectUserIds"), "$MaxRuns" }))
                }));
            var subjectPermit = await permits.FindOneAndUpdateAsync(subjectFilter,
                Builders<GatewayTaskPermitRecord>.Update.AddToSet(x => x.SubjectUserIds, subject),
                new FindOneAndUpdateOptions<GatewayTaskPermitRecord> { ReturnDocument = ReturnDocument.After }, ct);
            if (subjectPermit is null)
                throw Denied("TASK_PERMIT_SUBJECT_DENIED", "本次任务的业务归属超过已批准范围，已停止；请缩小范围后提交。");
            permit = subjectPermit;
        }
        if (!string.IsNullOrWhiteSpace(runId) && !permit.BoundRunIds.Contains(runId, StringComparer.Ordinal))
        {
            // 父任务下的实体数量同样有界。没有为每个子 Run 重发新额度。
            var filter = Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.Id, permit.Id)
                & Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.SourceDeployment, deployment)
                & Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.RevokedAt, null)
                & Builders<GatewayTaskPermitRecord>.Filter.Gt(x => x.ExpiresAt, now)
                & new BsonDocumentFilterDefinition<GatewayTaskPermitRecord>(new BsonDocument("$or", new BsonArray
                {
                    new BsonDocument("BoundRunIds", runId),
                    new BsonDocument("$expr", new BsonDocument("$lt", new BsonArray
                    { new BsonDocument("$size", "$BoundRunIds"), "$MaxRuns" }))
                }));
            var updated = await permits.FindOneAndUpdateAsync(filter,
                Builders<GatewayTaskPermitRecord>.Update.AddToSet(x => x.BoundRunIds, runId),
                new FindOneAndUpdateOptions<GatewayTaskPermitRecord> { ReturnDocument = ReturnDocument.After }, ct);
            if (updated is null)
                throw Denied("TASK_RUN_RANGE_EXCEEDED", "本次任务包含的执行对象超过平台批准范围，已停止新增执行；请缩小范围后提交。");
            permit = updated;
        }

        message.Headers.Remove("X-Gateway-Task-Permit");
        message.Headers.TryAddWithoutValidation("X-Gateway-Task-Permit", permit.Id);
        message.Headers.Remove("X-Gateway-Execution-Origin");
        message.Headers.TryAddWithoutValidation("X-Gateway-Execution-Origin", permit.Origin);
        message.Headers.Remove("X-Gateway-Source-Deployment");
        if (context is not null)
        {
            context.TaskPermitId = permit.Id;
            context.ExecutionOrigin = permit.Origin;
            context.TriggerCredentialId = permit.TriggerCredentialId;
            context.TriggerActorUserId = permit.ActorUserId;
            context.SourceDeployment = permit.SourceDeployment;
            context.SourceTask = permit.SourceTask;
            context.TenantId = permit.TenantId;
            context.UserId = subject;
            if (identity.RunId is { Length: > 0 } && context.RunId != identity.RunId
                && string.IsNullOrWhiteSpace(context.LogicalRequestId))
                context.LogicalRequestId = context.RunId;
            context.RunId = runId;
        }
    }

    public static bool ValidPermitId(string? value)
        => value is { Length: 32 } && value.All(char.IsAsciiHexDigit);
    private static TaskExecutionAdmissionException Denied(string code, string message) => new(code, message);
}
