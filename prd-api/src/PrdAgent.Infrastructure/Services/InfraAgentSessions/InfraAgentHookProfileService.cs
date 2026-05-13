using Microsoft.AspNetCore.Http;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.InfraAgentSessions;

public class InfraAgentHookProfileService : IInfraAgentHookProfileService
{
    private readonly MongoDbContext _db;

    public InfraAgentHookProfileService(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<List<InfraAgentHookProfileView>> ListAsync(string userId, CancellationToken ct)
    {
        var items = await _db.InfraAgentHookProfiles
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(100)
            .ToListAsync(ct);
        return items.Select(ToView).ToList();
    }

    public async Task<InfraAgentHookProfileView> CreateAsync(
        string userId,
        UpsertInfraAgentHookProfileRequest request,
        CancellationToken ct)
    {
        var hasHook = !string.IsNullOrWhiteSpace(request.BeforeStart)
            || !string.IsNullOrWhiteSpace(request.AfterStart)
            || !string.IsNullOrWhiteSpace(request.BeforeStop)
            || !string.IsNullOrWhiteSpace(request.AfterStop);
        if (!hasHook)
        {
            throw new InfraAgentHookProfileException(
                "hook_body_required",
                "至少需要配置一个 Hook 动作",
                StatusCodes.Status400BadRequest);
        }

        var now = DateTime.UtcNow;
        var item = new InfraAgentHookProfile
        {
            UserId = userId,
            Name = NormalizeName(request.Name),
            BeforeStart = NormalizeOptional(request.BeforeStart),
            AfterStart = NormalizeOptional(request.AfterStart),
            BeforeStop = NormalizeOptional(request.BeforeStop),
            AfterStop = NormalizeOptional(request.AfterStop),
            FailurePolicy = NormalizeFailurePolicy(request.FailurePolicy),
            TimeoutSeconds = Math.Clamp(request.TimeoutSeconds ?? 30, 1, 300),
            CreatedAt = now,
            UpdatedAt = now
        };
        await _db.InfraAgentHookProfiles.InsertOneAsync(item, cancellationToken: ct);
        return ToView(item);
    }

    private static string NormalizeName(string? value)
    {
        var normalized = NormalizeOptional(value);
        return string.IsNullOrWhiteSpace(normalized) ? "CDS Agent Hook" : normalized;
    }

    private static string NormalizeFailurePolicy(string? value)
    {
        return value == InfraAgentHookFailurePolicies.Continue
            ? InfraAgentHookFailurePolicies.Continue
            : InfraAgentHookFailurePolicies.BlockStart;
    }

    private static string? NormalizeOptional(string? value)
    {
        var normalized = value?.Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private static InfraAgentHookProfileView ToView(InfraAgentHookProfile item) => new(
        item.Id,
        item.UserId,
        item.Name,
        item.BeforeStart,
        item.AfterStart,
        item.BeforeStop,
        item.AfterStop,
        item.FailurePolicy,
        item.TimeoutSeconds,
        item.CreatedAt,
        item.UpdatedAt);
}
