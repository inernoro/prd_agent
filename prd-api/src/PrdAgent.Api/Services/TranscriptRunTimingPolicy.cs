using Microsoft.Extensions.Configuration;

namespace PrdAgent.Api.Services;

internal static class TranscriptRunTimingPolicy
{
    internal const string WatchdogTimeoutKey = "TRANSCRIPT_WATCHDOG_TIMEOUT_SECONDS";
    internal const int DefaultWatchdogTimeoutSeconds = 1800;
    internal const int MinimumWatchdogTimeoutSeconds = 300;
    internal const int MaximumWatchdogTimeoutSeconds = 7200;
    internal const int AsrDeadlineSafetyMarginSeconds = 120;

    internal static TimeSpan ResolveWatchdogTimeout(IConfiguration configuration)
    {
        var configured = configuration.GetValue<int?>(WatchdogTimeoutKey)
            ?? DefaultWatchdogTimeoutSeconds;
        return TimeSpan.FromSeconds(Math.Clamp(
            configured,
            MinimumWatchdogTimeoutSeconds,
            MaximumWatchdogTimeoutSeconds));
    }

    internal static TimeSpan ResolveAsrProcessingDeadline(IConfiguration configuration)
    {
        var watchdogSeconds = (int)ResolveWatchdogTimeout(configuration).TotalSeconds;
        return TimeSpan.FromSeconds(watchdogSeconds - AsrDeadlineSafetyMarginSeconds);
    }
}
