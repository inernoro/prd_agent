using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.Security;

/// <summary>MAP 与 serving 共用的稳定部署边界。来自部署配置，绝不读取请求来源头。</summary>
public static class TaskPermitDeployment
{
    public static string Resolve(IConfiguration configuration)
    {
        var project = configuration["CDS_PROJECT_ID"]?.Trim();
        if (!string.IsNullOrEmpty(project))
        {
            var branch = configuration["VITE_GIT_BRANCH"]?.Trim();
            // CDS 必须提供被平台强制注入的分支身份；不能用可自配队列前缀扩大作用域。
            if (string.IsNullOrEmpty(branch))
                throw new InvalidOperationException("预览任务缺少平台分支身份，无法签发或接受执行许可。");
            return $"{project}::{branch}";
        }
        return configuration[DeploymentAuthority.DeploymentIdentityKey]?.Trim() is { Length: > 0 } identity
            ? identity : "prd-agent:production";
    }
}
