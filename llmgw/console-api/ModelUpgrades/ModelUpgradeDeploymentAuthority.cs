namespace PrdAgent.LlmGw.ModelUpgrades;

/// <summary>仅约束模型升级任务，不放宽 MAP 通用周期任务授权。</summary>
public static class ModelUpgradeDeploymentAuthority
{
    public const string WorkerEnabledKey = "LlmGateway:ModelUpgrades:WorkerEnabled";
    public const string WorkerDeploymentKey = "LlmGateway:ModelUpgrades:WorkerDeployment";

    public static string? BlockReason(IConfiguration? configuration)
    {
        if (configuration is null || !bool.TryParse(configuration[WorkerEnabledKey], out var enabled) || !enabled)
            return "当前部署未启用模型更新执行器，请到已授权的 main 或正式入口操作。";
        var expected = configuration[WorkerDeploymentKey];
        if (string.IsNullOrWhiteSpace(expected))
            return "当前部署未登记模型更新执行身份，请由管理员核对执行器部署配置。";
        var project = configuration["CDS_PROJECT_ID"];
        if (!string.IsNullOrWhiteSpace(project))
        {
            // The real branch is injected by CDS; a feature cannot inherit main authority from project env.
            if (!string.Equals(configuration["VITE_GIT_BRANCH"], "main", StringComparison.Ordinal))
                return "模型更新仅允许 CDS main 执行，当前预览分支只可查看；请前往 main 入口。";
            if (!string.Equals(expected, project + "::main", StringComparison.Ordinal))
                return "模型更新执行身份与当前 CDS main 不匹配，请由管理员核对部署配置。";
        }
        else
        {
            var identity = configuration["Deployment:Identity"];
            if (string.IsNullOrWhiteSpace(identity) || !string.Equals(expected, identity, StringComparison.Ordinal))
                return "模型更新执行身份与当前正式部署不匹配，请到已授权入口操作或核对部署配置。";
        }
        return null;
    }
}
