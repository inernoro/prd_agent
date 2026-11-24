using System.Text.Json.Nodes;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Services;

internal static class TapdDraftSmoke
{
    private sealed record ExpectedFields(string Step, string Actual, string Expected);

    private static readonly ExpectedFields[] Expected =
    [
        new("筛选", "503", "北岸"),
        new("上传", "FILE_EMPTY", "inventory.csv"),
        new("保存", "CONFIG_LOCKED", "3"),
    ];

    public static bool Passes(int index, string? upstreamBody)
    {
        if (!TapdDraftSmokeWire.IsScenario(index) || string.IsNullOrWhiteSpace(upstreamBody)) return false;
        try
        {
            var content = JsonNode.Parse(upstreamBody)?["choices"]?[0]?["message"]?["content"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(content)) return false;

            var draft = TapdBugAgentService.ParseDraftFromLlm(content);
            var fixture = Expected[index];
            return !string.IsNullOrWhiteSpace(draft.Title)
                && Contains(draft.Steps, fixture.Step)
                && Contains(draft.ActualResult, fixture.Actual)
                && Contains(draft.ExpectedResult, fixture.Expected)
                && !Contains(draft.ExpectedResult, fixture.Actual);
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException or ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    private static bool Contains(IEnumerable<string> lines, string marker)
        => lines.Any(line => line.Contains(marker, StringComparison.OrdinalIgnoreCase));
}
