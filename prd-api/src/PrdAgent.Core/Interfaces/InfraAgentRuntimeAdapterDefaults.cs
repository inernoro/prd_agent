namespace PrdAgent.Core.Interfaces;

public static class InfraAgentRuntimeAdapterDefaults
{
    public const string RuntimeAdapterEnvVar = "INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER";
    public const string OfficialClaudeAgentSdk = "claude-agent-sdk";

    public static string ResolveSidecarRuntimeAdapter()
    {
        var value = Environment.GetEnvironmentVariable(RuntimeAdapterEnvVar);
        return string.IsNullOrWhiteSpace(value) ? OfficialClaudeAgentSdk : value.Trim();
    }
}
