using System.Globalization;
using System.Text.Json;

namespace PrdAgent.Api.Services;

internal sealed record QuickCreationDurationEstimate(object Choice, int TargetSec, int AutoSec, int? FullSec,
    long? Chars, int Scenes, int[] GenerateMin, string Basis, bool TrialDefault, int[] TrialMin);

internal static class QuickCreationDuration
{
    private const double CharactersPerSecond = 4.2;
    private static readonly int[] Options = [60, 180, 300, 600];

    internal static bool TryRead(JsonElement? value, out int? seconds)
    {
        seconds = null;
        if (value is not { } field || field.ValueKind == JsonValueKind.Null
            || (field.ValueKind == JsonValueKind.String && field.GetString() == "auto")) return true;
        if (field.ValueKind != JsonValueKind.Number || !field.TryGetInt32(out var target) || !Options.Contains(target))
            return false;
        seconds = target;
        return true;
    }

    internal static long CountCharacters(IEnumerable<string?> sources) =>
        sources.Sum(content => (long)(content?.Count(character => !char.IsWhiteSpace(character)) ?? 0));

    internal static int SpokenSeconds(long characters) => (int)Math.Round(characters / CharactersPerSecond);

    internal static bool IsWithinTarget(int actual, int target) => Math.Abs(actual - target) <= target * 0.15;

    internal static int Adjust(int target, bool longer)
    {
        var index = Array.IndexOf(Options, target);
        return Options[Math.Clamp(index + (longer ? 1 : -1), 0, Options.Length - 1)];
    }

    internal static string Label(int seconds) => seconds < 60 ? $"{seconds} 秒" : $"{Math.Round(seconds / 60.0)} 分钟";

    internal static QuickCreationDurationEstimate Estimate(long characters, int? selection)
    {
        int? full = characters > 0 ? SpokenSeconds(characters) : null;
        var automatic = full is { } sourceSeconds
            ? Options.Take(3).MinBy(seconds => Math.Abs(seconds - sourceSeconds * 0.35))
            : 60;
        var target = selection ?? automatic;
        var minutes = target / 60;
        int[] generation = [20 + 5 * minutes, 30 + 8 * minutes];
        var choice = selection is null ? $"自动取约 {Label(automatic)}{(full.HasValue ? "讲重点" : "")}" : $"按约 {Label(target)}写分镜";
        var basis = full is { } source ? $"稿件 {characters.ToString("N0", CultureInfo.InvariantCulture)} 字，全文照念约 {Label(source)}；{choice}"
            : $"内容来自对话；{choice}";
        return new QuickCreationDurationEstimate(selection.HasValue ? (object)selection.Value : "auto", target, automatic, full,
            full.HasValue ? characters : null, Math.Clamp((int)Math.Round(target / 14.0), 4, 40), generation, basis,
            target >= 180, [Math.Max(3, (int)Math.Round(generation[0] * 0.12)), Math.Max(5, (int)Math.Round(generation[1] * 0.15))]);
    }
}
