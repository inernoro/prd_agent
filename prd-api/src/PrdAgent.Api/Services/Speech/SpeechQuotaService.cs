using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.Speech;

public sealed class SpeechQuotaService(MongoDbContext db)
{
    public static string LedgerId(SpeechRun run) => SpeechCapabilityPolicy.Hash($"{run.Environment}:{run.OwnerUserId}:{run.ProfileId}");

    public async Task<bool> ReserveAsync(SpeechRun run)
    {
        var id = LedgerId(run);
        var day = DateTime.UtcNow.ToString("yyyy-MM-dd");
        run.QuotaLedgerId = id;
        try
        {
            await db.SpeechQuotaLedgers.UpdateOneAsync(x => x.Id == id,
                Builders<SpeechQuotaLedger>.Update.SetOnInsert(x => x.Id, id).SetOnInsert(x => x.Day, day)
                    .SetOnInsert(x => x.Characters, 0).SetOnInsert(x => x.ActiveRuns, 0)
                    .SetOnInsert(x => x.Reservations, new Dictionary<string, SpeechQuotaReservation>()),
                new UpdateOptions { IsUpsert = true }, CancellationToken.None);
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { }
        // 重置每日字符额度，但保留跨午夜仍在执行的并发槽位。
        await db.SpeechQuotaLedgers.UpdateOneAsync(x => x.Id == id && x.Day != day,
            Builders<SpeechQuotaLedger>.Update.Set(x => x.Day, day).Set(x => x.Characters, 0), cancellationToken: CancellationToken.None);
        var prior = await db.SpeechQuotaLedgers.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (prior?.Reservations.ContainsKey(run.Id) == true) return !prior.Reservations[run.Id].Refunded;
        var filter = Builders<SpeechQuotaLedger>.Filter.Eq(x => x.Id, id)
            & Builders<SpeechQuotaLedger>.Filter.Eq(x => x.Day, day)
            & Builders<SpeechQuotaLedger>.Filter.Lte(x => x.Characters, run.ProfileSnapshot.DailyCharacterQuota - run.CharacterCount)
            & Builders<SpeechQuotaLedger>.Filter.Lt(x => x.ActiveRuns, run.ProfileSnapshot.MaxConcurrentRuns)
            & Builders<SpeechQuotaLedger>.Filter.Exists($"Reservations.{run.Id}", false);
        var update = Builders<SpeechQuotaLedger>.Update.Inc(x => x.Characters, run.CharacterCount).Inc(x => x.ActiveRuns, 1)
            .Set($"Reservations.{run.Id}", new SpeechQuotaReservation { Day = day, Characters = run.CharacterCount });
        var result = await db.SpeechQuotaLedgers.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        return result.ModifiedCount == 1;
    }

    public async Task ReleaseAsync(SpeechRun run, bool refund)
    {
        if (run.QuotaLedgerId == null) return;
        var filter = Builders<SpeechQuotaLedger>.Filter.Eq(x => x.Id, run.QuotaLedgerId)
            & Builders<SpeechQuotaLedger>.Filter.Eq($"Reservations.{run.Id}.Active", true);
        var update = Builders<SpeechQuotaLedger>.Update.Inc(x => x.ActiveRuns, -1).Unset($"Reservations.{run.Id}");
        if (refund)
        {
            var day = DateTime.UtcNow.ToString("yyyy-MM-dd");
            var refundFilter = filter & Builders<SpeechQuotaLedger>.Filter.Eq(x => x.Day, day)
                & Builders<SpeechQuotaLedger>.Filter.Eq($"Reservations.{run.Id}.Day", day);
            var result = await db.SpeechQuotaLedgers.UpdateOneAsync(refundFilter,
                update.Inc(x => x.Characters, -run.CharacterCount), cancellationToken: CancellationToken.None);
            if (result.ModifiedCount == 1) return;
        }
        await db.SpeechQuotaLedgers.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
    }
}
