using System.Reflection;
using System.Runtime.ExceptionServices;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Infrastructure.Database;

/// <summary>统一拦截持久任务取消与删除。新 ITaskAuthorizedRun 集合自动适用，不依赖 Controller 记得撤销。</summary>
public class TaskLifecycleMongoDatabase : DispatchProxy
{
    private IMongoDatabase _inner = null!;
    private Func<ITaskExecutionCoordinator> _coordinator = null!;
    private string _tenant = GatewayTenantDefaults.InternalTenantId;
    public static IMongoDatabase Wrap(IMongoDatabase inner, Func<ITaskExecutionCoordinator> coordinator, string? tenant = null)
    {
        var proxy = Create<IMongoDatabase, TaskLifecycleMongoDatabase>();
        var state = (TaskLifecycleMongoDatabase)proxy;
        state._inner = inner; state._coordinator = coordinator; state._tenant = tenant ?? GatewayTenantDefaults.InternalTenantId;
        return proxy;
    }
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        var result = InvokeInner(method!, _inner, args);
        if (method!.Name == nameof(IMongoDatabase.GetCollection) && method.IsGenericMethod
            && (typeof(ITaskAuthorizedRun).IsAssignableFrom(method.GetGenericArguments()[0])
                || method.GetGenericArguments()[0] == typeof(User) || method.GetGenericArguments()[0] == typeof(AgentApiKey)))
            return typeof(TaskLifecycleMongoCollection<>).MakeGenericType(method.GetGenericArguments()[0])
                .GetMethod(nameof(TaskLifecycleMongoCollection<User>.Wrap))!
                .Invoke(null, new[] { result, _coordinator, (object)this, _tenant });
        return result is IMongoDatabase database ? Wrap(database, _coordinator, _tenant) : result;
    }
    internal static object? InvokeInner(MethodInfo method, object target, object?[]? args)
    {
        try { return method.Invoke(target, args); }
        catch (TargetInvocationException e) when (e.InnerException is not null)
        { ExceptionDispatchInfo.Capture(e.InnerException).Throw(); throw; }
    }
}

public class TaskLifecycleMongoCollection<T> : DispatchProxy where T : class
{
    private IMongoCollection<T> _inner = null!;
    private Func<ITaskExecutionCoordinator> _coordinator = null!;
    private string _tenant = GatewayTenantDefaults.InternalTenantId;
    private IMongoDatabase _database = null!;
    public static IMongoCollection<T> Wrap(IMongoCollection<T> inner, Func<ITaskExecutionCoordinator> coordinator, IMongoDatabase database, string tenant)
    {
        var proxy = Create<IMongoCollection<T>, TaskLifecycleMongoCollection<T>>();
        var state = (TaskLifecycleMongoCollection<T>)proxy;
        state._inner = inner; state._coordinator = coordinator; state._database = database; state._tenant = tenant;
        return proxy;
    }
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var method = targetMethod ?? throw new ArgumentNullException(nameof(targetMethod));
        args ??= Array.Empty<object?>();
        if (method.Name == "get_Database") return _database;
        if (method.Name is "BulkWrite" or "BulkWriteAsync" or "MapReduce" or "MapReduceAsync" or "AggregateToCollection" or "AggregateToCollectionAsync" or "OfType")
            throw new NotSupportedException("持久任务批量写入须逐条经过平台生命周期检查，请使用带过滤条件的更新或删除。");
        var mutation = method.Name.StartsWith("Update", StringComparison.Ordinal)
            || method.Name.StartsWith("Replace", StringComparison.Ordinal) || method.Name.StartsWith("Delete", StringComparison.Ordinal)
            || method.Name.StartsWith("FindOneAnd", StringComparison.Ordinal);
        if (!mutation)
        {
            var result = TaskLifecycleMongoDatabase.InvokeInner(method, _inner, args);
            return result is IMongoCollection<T> collection ? Wrap(collection, _coordinator, _database, _tenant) : result;
        }
        if (method.ReturnType == typeof(Task)) return InvokeAsync(method, args);
        if (method.ReturnType.IsGenericType && method.ReturnType.GetGenericTypeDefinition() == typeof(Task<>))
            return typeof(TaskLifecycleMongoCollection<T>).GetMethod(nameof(InvokeResultAsync), BindingFlags.Instance | BindingFlags.NonPublic)!
                .MakeGenericMethod(method.ReturnType.GetGenericArguments()[0]).Invoke(this, new object[] { method, args });
        BeforeMutationAsync(method.Name, args).GetAwaiter().GetResult();
        return TaskLifecycleMongoDatabase.InvokeInner(method, _inner, args);
    }
    private async Task InvokeAsync(MethodInfo method, object?[] args)
    {
        await BeforeMutationAsync(method.Name, args);
        await (Task)TaskLifecycleMongoDatabase.InvokeInner(method, _inner, args)!;
    }
    private async Task<TResult> InvokeResultAsync<TResult>(MethodInfo method, object?[] args)
    {
        await BeforeMutationAsync(method.Name, args);
        return await (Task<TResult>)TaskLifecycleMongoDatabase.InvokeInner(method, _inner, args)!;
    }
    private async Task BeforeMutationAsync(string method, object?[] args)
    {
        // 迟到执行者不能继续写任务状态；普通用户读取、取消和非任务 CRUD 不依赖运行租约。
        var coordinator = _coordinator();
        if (TaskExecutionContext.Current?.Lease is { } lease && !await coordinator.ValidateAsync(lease, false, CancellationToken.None))
            throw new TaskExecutionAdmissionException("TASK_EXECUTION_LEASE_INVALID", "本次执行已失效，未继续更新任务；请查看当前任务状态。");
        var cancel = method.Contains("Delete", StringComparison.Ordinal);
        BsonDocument? set = null;
        var update = args.OfType<UpdateDefinition<T>>().FirstOrDefault();
        if (update is not null)
        {
            var rendered = update.Render(new RenderArgs<T>(_inner.DocumentSerializer, BsonSerializer.SerializerRegistry));
            var stages = rendered.IsBsonArray ? rendered.AsBsonArray.Select(x => x.AsBsonDocument)
                : new[] { rendered.AsBsonDocument };
            set = new BsonDocument();
            foreach (var stage in stages)
            foreach (var operation in stage)
            {
                if (rendered.IsBsonArray && operation.Name is not ("$set" or "$addFields"))
                    throw new NotSupportedException("任务管道只支持字段更新，取消与授权字段须使用明确的值。");
                if (operation.Name is "$set" or "$setOnInsert" or "$addFields")
                {
                    foreach (var field in operation.Value.AsBsonDocument)
                    {
                        var value = field.Value;
                        if (rendered.IsBsonArray && IsLifecycleField(field.Name))
                        {
                            if (value is BsonDocument literal && literal.ElementCount == 1 && literal.TryGetValue("$literal", out var unwrapped)) value = unwrapped;
                            else if (value.IsBsonDocument || value.IsBsonArray || value.IsString && value.AsString.StartsWith('$'))
                                throw new NotSupportedException("任务取消或授权字段须使用明确的值，不能用未核验表达式计算。");
                        }
                        set[field.Name] = value;
                        cancel |= IsCancellation(field.Name, value);
                    }
                }
                else if (operation.Name == "$currentDate" && operation.Value.AsBsonDocument.Contains("CancelRequestedAt")) cancel = true;
                else if (operation.Name == "$rename" && operation.Value.AsBsonDocument.Any(x => IsLifecycleField(x.Name) || x.Value.IsString && IsLifecycleField(x.Value.AsString)))
                    throw new NotSupportedException("取消与授权字段不能通过重命名修改。");
            }
        }
        var replacement = args.OfType<T>().FirstOrDefault();
        if (replacement is not null) cancel |= replacement.ToBsonDocument().Any(field => IsCancellation(field.Name, field.Value));
        var authorizationChange = typeof(T) == typeof(User) && (cancel || set?.Contains("Status") == true || replacement is not null)
            || typeof(T) == typeof(AgentApiKey) && (cancel || replacement is not null || set?.Names.Any(n => n is "RevokedAt" or "IsActive" or "Scopes" or "ScopeMode" or "ApiKeyHash" or "OwnerUserId" or "ExpiresAt") == true);
        if (!cancel && typeof(ITaskAuthorizedRun).IsAssignableFrom(typeof(T))
            && (set?.Contains("Status") == true || set?.Contains("State") == true || replacement is not null))
        {
            var filterIndex = Array.FindIndex(args, x => x is FilterDefinition<T>);
            if (filterIndex >= 0)
            {
                var original = (FilterDefinition<T>)args[filterIndex]!;
                FilterDefinition<T> open = new BsonDocument
                {
                    ["CancelRequested"] = new BsonDocument("$ne", true),
                    ["CancelRequestedAt"] = BsonNull.Value,
                    ["Status"] = new BsonDocument("$nin", CancelledValues("Status")),
                    ["State"] = new BsonDocument("$nin", CancelledValues("State"))
                };
                var nextPermit = replacement is ITaskAuthorizedRun next ? next.TaskPermitId
                    : set?.GetValue("TaskPermitId", BsonNull.Value) is { IsString: true } proposed ? proposed.AsString : null;
                // 只有已获得新许可且一并替换引用的明确重试可离开取消状态。
                if (TaskExecutionContext.Current?.Lease is { } fresh && nextPermit == fresh.PermitId)
                    open |= Builders<T>.Filter.Ne("TaskPermitId", nextPermit);
                args[filterIndex] = original & open;
            }
        }
        if (!cancel && !authorizationChange) return;
        var filter = args.OfType<FilterDefinition<T>>().FirstOrDefault()
            ?? throw new InvalidOperationException("任务取消或删除缺少明确的对象条件。");
        var query = _inner.Find(filter);
        var sort = args.Where(x => x is not null).Select(x => x!.GetType().GetProperty("Sort")?.GetValue(x))
            .OfType<SortDefinition<T>>().FirstOrDefault();
        if (sort is not null) query = query.Sort(sort);
        var documents = await query.Limit(method.Contains("Many", StringComparison.Ordinal) ? 1001 : 1).ToListAsync(CancellationToken.None);
        if (documents.Count > 1000) throw new TaskExecutionAdmissionException("TASK_CANCEL_SCOPE_TOO_LARGE", "本次操作涉及任务过多，未执行；请缩小范围后重试。", 400);
        if (typeof(ITaskAuthorizedRun).IsAssignableFrom(typeof(T)) && documents.Count > 0)
        {
            // 撤销与业务写之间若有人明确重新提交，新代次不能被旧取消或删除覆盖。
            var snapshots = documents.Select(document =>
            {
                var bson = document.ToBsonDocument();
                if (!bson.TryGetValue("_id", out var id)) throw new InvalidOperationException("任务缺少稳定存储身份。");
                return (FilterDefinition<T>)new BsonDocument { ["_id"] = id,
                    ["TaskPermitId"] = bson.GetValue("TaskPermitId", BsonNull.Value) };
            });
            var index = Array.FindIndex(args, x => x is FilterDefinition<T>);
            args[index] = filter & Builders<T>.Filter.Or(snapshots);
        }
        foreach (var document in documents)
        {
            if (authorizationChange)
            {
                var target = replacement?.ToBsonDocument() ?? set ?? new BsonDocument();
                if (document is User user)
                {
                    if (!cancel && (!target.TryGetValue("Status", out var desiredStatus)
                        || replacement is not null && desiredStatus == document.ToBsonDocument().GetValue("Status", BsonNull.Value))) continue;
                    var enabled = !cancel && (target.TryGetValue("Status", out var status)
                        ? status.IsInt32 && status.AsInt32 == (int)UserStatus.Active || status.IsString && status.AsString.Equals("Active", StringComparison.OrdinalIgnoreCase)
                        : user.Status == UserStatus.Active);
                    await coordinator.ChangeActorAuthorizationAsync(_tenant, user.UserId, enabled, CancellationToken.None);
                }
                else if (document is AgentApiKey key)
                {
                    var previous = document.ToBsonDocument();
                    if (!cancel && (replacement is not null || set?.Contains("IsActive") != true) && !new[] { "RevokedAt", "IsActive", "Scopes", "ScopeMode", "ApiKeyHash", "OwnerUserId", "ExpiresAt" }
                        .Any(name => target.TryGetValue(name, out var desired) && desired != previous.GetValue(name, BsonNull.Value))) continue;
                    var enabled = !cancel && !(target.TryGetValue("RevokedAt", out var revoked) && !revoked.IsBsonNull)
                        && (!target.TryGetValue("IsActive", out var active) || active.IsBoolean && active.AsBoolean);
                    await coordinator.ChangeCredentialAuthorizationAsync(_tenant, $"agent-apikey:{key.Id}", enabled, CancellationToken.None);
                }
                continue;
            }
            if (document is not ITaskAuthorizedRun task || string.IsNullOrWhiteSpace(task.TaskPermitId)) continue; // 旧记录本身没有可用的新执行授权。
            foreach (var reference in References(document))
                await coordinator.RevokeAsync(reference.Permit, reference.Run, CancellationToken.None);

        }
    }
    private static IEnumerable<(string Permit, string Run)> References(object document, string? parent = null)
    {
        if (document is not ITaskAuthorizedRun task || string.IsNullOrWhiteSpace(task.TaskPermitId)) yield break;
        var type = document.GetType();
        var run = type.GetProperty("TurnId")?.GetValue(document) as string
            ?? type.GetProperty("RunId")?.GetValue(document) as string
            ?? type.GetProperty("Id")?.GetValue(document) as string;
        if (document is VideoGenScene scene && parent is not null) run = $"{parent}_scene_{scene.Index}";
        if (string.IsNullOrWhiteSpace(run)) throw new InvalidOperationException("任务缺少平台可识别的执行对象。");
        yield return (task.TaskPermitId, run);
        foreach (var property in type.GetProperties())
            if (property.GetValue(document) is System.Collections.IEnumerable children && property.PropertyType != typeof(string))
                foreach (var child in children)
                    if (child is ITaskAuthorizedRun)
                        foreach (var reference in References(child, run)) yield return reference;
    }
    private static BsonArray CancelledValues(string field)
    {
        var values = new BsonArray { "cancelled", "Cancelled", "canceled", "Canceled" };
        var type = typeof(T).GetProperty(field)?.PropertyType;
        if (type?.IsEnum == true && Enum.TryParse(type, "Cancelled", out var value)) values.Add(Convert.ToInt32(value));
        return values;
    }
    private static bool IsLifecycleField(string field) => field is "CancelRequested" or "CancelRequestedAt" or "Status" or "State"
        or "TaskPermitId" or "RevokedAt" or "IsActive" or "Scopes" or "ScopeMode" or "ApiKeyHash" or "OwnerUserId" or "ExpiresAt";
    private static bool IsCancellation(string field, BsonValue value)
    {
        if (field == "CancelRequested") return value.IsBoolean && value.AsBoolean;
        if (field == "CancelRequestedAt") return !value.IsBsonNull;
        if (field is not ("Status" or "State")) return false;
        if (value.IsString) return value.AsString.Equals("cancelled", StringComparison.OrdinalIgnoreCase)
            || value.AsString.Equals("canceled", StringComparison.OrdinalIgnoreCase);
        var property = typeof(T).GetProperty(field);
        return property?.PropertyType.IsEnum == true && value.IsInt32
            && Enum.GetName(property.PropertyType, value.AsInt32)?.Equals("Cancelled", StringComparison.OrdinalIgnoreCase) == true;
    }
}
