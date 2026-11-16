using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>从仅正式服务可读的一次性加密信封初始化；管理员配置始终优先。</summary>
public static class ProductClaimWebhookBootstrap
{
    public const string SeedDirectory = "/data/dataprotection-keys/product-claim-webhook-seed";

    public static async Task<bool> TryInitializeAsync(MongoDbContext db, IDataProtectionProvider protection,
        IConfiguration configuration, string seedDirectory = SeedDirectory)
    {
        if (DeploymentAuthority.IsCdsBranchPreview(configuration)
            || !DeploymentAuthority.CanRunSharedScheduledWork(configuration)) return false;
        var keyPath = Path.Combine(seedDirectory, "private.pem");
        var envelopePath = Path.Combine(seedDirectory, "url.enc");
        if (!File.Exists(keyPath) || !File.Exists(envelopePath)) return false;
        var existing = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId)
            .FirstOrDefaultAsync())?.ClaimWebhook;
        if (existing?.InitializedAt != null || !string.IsNullOrEmpty(existing?.ProtectedUrl)) return false;
        string url;
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportFromPem(await File.ReadAllTextAsync(keyPath));
            var plaintext = rsa.Decrypt(await File.ReadAllBytesAsync(envelopePath), RSAEncryptionPadding.OaepSHA256);
            try { url = Encoding.UTF8.GetString(plaintext).Trim(); }
            finally { CryptographicOperations.ZeroMemory(plaintext); }
        }
        // 另一实例已完成初始化并移除信封时，无需报错或重复初始化。
        catch (FileNotFoundException) { return false; }
        if (!ProductClaimWebhookPayload.IsValidWebhook(url))
            throw new InvalidOperationException("默认Webhook地址无效，初始化未执行");

        var now = DateTime.UtcNow;
        var config = new ProductClaimWebhookConfig {
            Enabled = true, NotifyInternal = true, NotifyFormal = true, InitializedAt = now,
            ProtectedUrl = protection.CreateProtector(ProductClaimWebhookController.ProtectionPurpose).Protect(url),
        };
        await db.ProductAgentSettings.UpdateOneAsync(x => x.Id == ProductAgentSettings.SingletonId,
            Builders<ProductAgentSettings>.Update.SetOnInsert(x => x.UpdatedAt, now),
            new UpdateOptions { IsUpsert = true }, CancellationToken.None);
        var filter = Builders<ProductAgentSettings>.Filter;
        var result = await db.ProductAgentSettings.UpdateOneAsync(
            filter.Eq(x => x.Id, ProductAgentSettings.SingletonId)
                & filter.Eq("ClaimWebhook.InitializedAt", (DateTime?)null)
                & (filter.Eq("ClaimWebhook.ProtectedUrl", (string?)null) | filter.Eq("ClaimWebhook.ProtectedUrl", "")),
            Builders<ProductAgentSettings>.Update.Set(x => x.ClaimWebhook, config)
                .Set(x => x.UpdatedBy, "system:claim-webhook-bootstrap").Set(x => x.UpdatedAt, now),
            cancellationToken: CancellationToken.None);
        if (result.ModifiedCount != 1) return false;
        // 已转存为正式DataProtection密文，一次性传输私钥和信封不再保留。
        foreach (var path in new[] { envelopePath, keyPath })
        {
            try { File.Delete(path); }
            catch (IOException) { /* 初始化已完成；残留文件由部署清理，不重新覆盖配置。 */ }
            catch (UnauthorizedAccessException) { /* 同上。 */ }
        }
        return true;
    }
}
