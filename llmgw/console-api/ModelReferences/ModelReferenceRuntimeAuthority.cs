using System.Reflection;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.ModelReferences;

public static class ModelReferenceRuntimeAuthority
{
    public static IRuntimeModelReferenceSnapshotProvider Create(IMongoDatabase map, IConfiguration configuration)
    {
        var identity = configuration["LlmGateway:ModelReferences:MapDeploymentIdentity"]?.Trim() ?? "";
        var informational = typeof(ModelReferenceRuntimeAuthority).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        var split = informational?.IndexOf('+') ?? -1;
        var commit = split >= 0 ? informational![(split + 1)..] : "";
        var project = configuration["CDS_PROJECT_ID"];
        var branch = configuration["VITE_GIT_BRANCH"] ?? configuration["BULLMQ_PREFIX"];
        var revision = new[] { "GIT_COMMIT", "COMMIT_SHA", "GITHUB_SHA", "SOURCE_VERSION", "CDS_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA" }
            .Select(key => configuration[key]).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));
        var durable = ComposeScope(project, branch, null);
        var scope = ComposeScope(project, branch, revision);
        return new MongoRuntimeModelReferenceSnapshotProvider(map, identity, scope, durable, commit);
    }
    // This finite mirror is compared with MAP DeploymentScope.Compose in a regression test.
    public static string? ComposeScope(string? project, string? branch, string? revision)
    {
        if (string.IsNullOrWhiteSpace(project)) return null;
        var scope = string.IsNullOrWhiteSpace(branch) ? project.Trim() : project.Trim() + "::" + branch.Trim();
        return string.IsNullOrWhiteSpace(revision) ? scope : scope + "::revision::" + revision.Trim();
    }
}
