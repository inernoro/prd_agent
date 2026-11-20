using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public sealed class CdsSsoSessions(CdsSsoSettings settings, CdsSsoClient client, MongoDbContext db, IDataProtectionProvider protection)
{
    private const string SessionPrefix = "cds-";
    internal static readonly TimeSpan RedeemLifetime = TimeSpan.FromMinutes(1);
    private readonly IMongoCollection<CdsSsoSession> _sessions = db.CdsSsoSessions;
    private readonly IDataProtector _protector = protection.CreateProtector("MAP.CdsSso.Session.v1", settings.Scope);

    internal static bool IsDelegated(string? sessionKey) => sessionKey?.StartsWith(SessionPrefix, StringComparison.Ordinal) == true;
    internal static string SessionKey(string proof) => SessionPrefix + proof;

    internal async Task<bool> AddAsync(string sessionKey, CdsSsoDelegation delegation, CancellationToken ct)
    {
        try
        {
            await _sessions.InsertOneAsync(new CdsSsoSession
            {
                Id = SessionId(sessionKey),
                ExpiresAt = delegation.ExpiresAt,
                RedeemBy = DateTime.UtcNow.Add(RedeemLifetime),
                Ciphertext = _protector.Protect(JsonSerializer.Serialize(delegation))
            }, cancellationToken: ct);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            return false;
        }
    }

    internal async Task<CdsSsoDelegation?> RedeemAsync(string sessionKey, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var id = SessionId(sessionKey);
        var session = await _sessions.FindOneAndUpdateAsync(
            x => x.Id == id && !x.Redeemed && x.RedeemBy > now && x.ExpiresAt > now,
            Builders<CdsSsoSession>.Update.Set(x => x.Redeemed, true), cancellationToken: ct);
        return Read(session);
    }

    internal async Task<bool> IsCurrentAsync(string sessionKey, string userId, string? role, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var id = SessionId(sessionKey);
        var delegation = Read(await _sessions.Find(x => x.Id == id && x.Redeemed && x.ExpiresAt > now).FirstOrDefaultAsync(ct));
        if (delegation is null || delegation.LocalAccount != userId) return false;

        var user = await FindLoginUserAsync(userId, ct);
        if (user is not null && user.Role.ToString() == role && await IsAuthorizedAsync(delegation, ct)) return true;

        await _sessions.DeleteOneAsync(x => x.Id == id, ct);
        return false;
    }

    internal async Task<bool> IsAuthorizedAsync(CdsSsoDelegation delegation, CancellationToken ct)
    {
        if (delegation.ExpiresAt <= DateTime.UtcNow || settings.LocalAccount(delegation.Subject) != delegation.LocalAccount) return false;
        var identity = await client.GetIdentityAsync(delegation.AccessToken, ct);
        return identity?.Subject == delegation.Subject;
    }

    internal async Task<User?> FindLoginUserAsync(string localAccount, CancellationToken ct)
    {
        if (localAccount == AdminPermissionCatalog.RootUserId) return null;
        var user = await db.Users.Find(u => u.UserId == localAccount).FirstOrDefaultAsync(ct);
        return user is { Status: UserStatus.Active, UserType: UserType.Human, MustResetPassword: false } ? user : null;
    }

    private CdsSsoDelegation? Read(CdsSsoSession? session) => session is null ? null
        : JsonSerializer.Deserialize<CdsSsoDelegation>(_protector.Unprotect(session.Ciphertext));

    // Derive the ID from the unguessable handoff, so MongoDB enforces one callback using its native _id index.
    private string SessionId(string key)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{settings.Scope}|{key}"));
        return new Guid(hash.AsSpan(0, 16)).ToString("N");
    }
}
