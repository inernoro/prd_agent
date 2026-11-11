using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace PrdAgent.LlmGw.ModelReferences;

public sealed record ReferenceCollection(string Key, string Database, string Collection,
    string Mode, string[] ProjectionPaths, string[] KnownSelectionPaths);

public static class ModelReferenceRegistry
{
    public const string Version = "2026-11-12.v1";
    public static readonly IReadOnlyList<ReferenceCollection> Collections = new ReferenceCollection[]
    {
        new("map.arena-slots", "map", "arena_slots", "business", ["LogicalModelId", "PlatformId", "ModelId"], ["LogicalModelId", "PlatformId", "ModelId"]),
        new("map.lab-experiments", "map", "model_lab_experiments", "business-array", ["SelectedModels.LogicalModelId", "SelectedModels.PlatformId", "SelectedModels.ModelId", "SelectedModels.ModelName"], ["SelectedModels[].LogicalModelId", "SelectedModels[].PlatformId", "SelectedModels[].ModelId", "SelectedModels[].ModelName"]),
        new("map.lab-modelsets", "map", "model_lab_model_sets", "business-array", ["Models.LogicalModelId", "Models.PlatformId", "Models.ModelId", "Models.ModelName"], ["Models[].LogicalModelId", "Models[].PlatformId", "Models[].ModelId", "Models[].ModelName"]),
        new("map.lab-groups", "map", "model_lab_groups", "business-array", ["Models.LogicalModelId", "Models.PlatformId", "Models.ModelId", "Models.ModelName"], ["Models[].LogicalModelId", "Models[].PlatformId", "Models[].ModelId", "Models[].ModelName"]),
        new("map.preferences", "map", "user_preferences", "preferences", ["VisualAgentPreferences.ModelId", "VisualAgentPreferences.ModelAuto", "LiteraryAgentPreferences.ImageModelId", "LiteraryAgentPreferences.ChatModelId"], ["VisualAgentPreferences.ModelId", "LiteraryAgentPreferences.ImageModelId", "LiteraryAgentPreferences.ChatModelId"]),
        new("map.visual-policy", "map", "appsettings", "visual", ["VisualModelPolicy.DefaultModelId", "VisualModelPolicy.Models.ModelId", "VisualModelPolicy.Revision"], ["VisualModelPolicy.DefaultModelId", "VisualModelPolicy.Models[].ModelId"]),
        new("map.agent-key-models", "map", "agent_api_keys", "keys", ["OpenApiChatModels", "OpenApiImageModels", "McpLiteraryImageModelMode", "McpLiteraryImageModelPublicId"], ["OpenApiChatModels", "OpenApiImageModels", "McpLiteraryImageModelMode", "McpLiteraryImageModelPublicId"]),
        new("map.workflow-models", "map", "workflows", "workflow", ["Nodes.NodeId", "Nodes.NodeType", "Nodes.Config.model", "Nodes.Config.runtimeProfileId", "Nodes.Config.sessionId"], ["Nodes[].Config.model"]),
        new("map.video-projects", "map", "video_projects", "scalar", ["DefaultVideoModel"], ["DefaultVideoModel"]),
        new("map.chat-sessions", "map", "chat_agent_sessions", "chat", ["Model", "Deleted", "RunningTurnId"], ["Model"]),
        new("map.speech-profiles", "map", "speech_settings", "blocked", ["Profiles.ModelPoolId", "Profiles.Model", "Profiles.OfferingId"], ["Profiles[].ModelPoolId", "Profiles[].Model", "Profiles[].OfferingId"]),
        new("map.infra-profiles", "map", "infra_agent_runtime_profiles", "independent", ["Model"], ["Model"]),
        new("map.infra-sessions", "map", "infra_agent_sessions", "independent", ["Model", "RuntimeProfileId"], ["Model"]),
        // Versions[].Model is immutable generated-output provenance, deliberately not projected for migration.
        new("map.video-unsubmitted", "map", "video_gen_runs", "video-run", ["Status", "DirectVideoModel", "DirectVideoJobId", "DirectVideoOfferingId", "Scenes.Model", "Scenes.JobId", "Scenes.OfferingId"], ["DirectVideoModel", "DirectVideoOfferingId", "Scenes[].Model", "Scenes[].OfferingId", "Scenes[].Versions[].Model"]),
        new("map.legacy-config", "map", "llmconfigs", "inactive", ["Model", "IsActive"], ["Model"]),
        new("map.legacy-physical", "map", "llmmodels", "inactive", ["PlatformId", "ModelName", "Enabled", "IsMain", "IsIntent", "IsVision", "IsImageGen"], ["PlatformId", "ModelName"]),
        new("map.legacy-pools", "map", "model_groups", "inactive", ["Models.ModelId", "Models.PlatformId"], ["Models[].ModelId", "Models[].PlatformId"]),
        new("map.legacy-callers", "map", "llm_app_callers", "inactive", ["ModelRequirements.ModelGroupIds", "ModelRequirements.ModelGroupId"], ["ModelRequirements[].ModelGroupIds", "ModelRequirements[].ModelGroupId", "ModelRequirements[].ModelType"]),
        // Offering lineage, caller observations and discovery results describe provenance, not dispatch selectors.
        // Active wire, declared pools and approved successors remain projected and checked below.
        new("gateway.fixed-logical-versions", "gateway", "llmgw_model_offerings", "wire", ["LogicalModelId", "TargetId", "TargetKind", "UpstreamModelId", "Enabled"], ["LogicalModelId", "UpstreamModelId", "SupersedesOfferingId", "SupersededByOfferingId"]),
        new("gw.logical-roles", "gateway", "llmgw_logical_models", "roles", ["PublicId", "Aliases", "MigratedFromPoolIds", "DefaultForAppCallerCodes", "IsDefaultForType", "ModelType"], ["MigratedFromPoolIds", "ModelType"]),
        new("gw.legacy-pools", "gateway", "llmgw_model_pools", "inactive", ["Models.ModelId", "Models.PlatformId"], ["Models[].ModelId", "Models[].PlatformId", "ModelType"]),
        new("gw.legacy-callers", "gateway", "llmgw_app_callers", "inactive", ["ModelPoolId", "DefaultModelPoolId", "AllowedModelPoolIds"], ["ModelPoolId", "DefaultModelPoolId", "AllowedModelPoolIds", "ObservedModelPoolIds", "LastObservedModelPoolId"]),
        new("gw.upgrade-policy", "gateway", "llmgw_model_upgrade_policies", "upgrade-policy", ["LogicalModelId", "Policy.Enabled", "Policy.Successors.ProviderId", "Policy.Successors.FromModel", "Policy.Successors.ToModel", "PendingAction", "PendingSwitch.OperationId", "LeaseUntil", "Current.UpstreamModelId", "Candidate.ValidationRoute.LogicalModelId"], ["LogicalModelId", "Policy.Successors[].FromModel", "Policy.Successors[].ToModel", "Discoveries[].UpstreamModelId"]),
    };
    public static readonly IReadOnlyList<string> HistoricalExclusions = new[]
    {
        "arena_battles", "model_lab_runs", "model_lab_run_items", "llmrequestlogs", "openapirequestlogs",
        "image_gen_runs", "image_gen_run_items", "speech_runs", "direct_video_job_ownerships", "design_artifact_runs_v2",
        "llmgw_request_executions", "llmgw_model_upgrade_validation_runs", "submissions", "weekly_reports",
    };
    public static readonly IReadOnlyList<string> ExternalConsumers = new[]
    { "runtime.map-legacy-model", "runtime.chat-agent-default", "runtime.design-route", "runtime.sdk-models" };
    public static readonly string[] MetadataPaths = ["_id", "TenantId", "OwnerUserId", "OwnerAdminId", "UserId", "CreatedBy", "CreatedByUserId", "DeploymentSlug", "EnvironmentId", "Version", "Revision", "UpdatedAt"];
    public static string Hash { get; } = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        Version + "\n" + string.Join("\n", Collections.Select(c => $"{c.Key}|{c.Database}|{c.Collection}|{c.Mode}|{string.Join(',', c.ProjectionPaths)}|{string.Join(',', c.KnownSelectionPaths)}"))
        + "\n" + string.Join("\n", ModelReferenceFieldClassifications.Fields.OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => x.Key + "=" + x.Value))
        + "\n" + string.Join(',', HistoricalExclusions) + "\n" + string.Join(',', ExternalConsumers)))).ToLowerInvariant();
    public static string NormalizePath(string path) => Regex.Replace(path, @"\.\d+(?=\.|$)", "[]");
    public static bool IsSelectionName(string name) => Regex.IsMatch(name,
        @"(^Model$|ModelId$|ModelIds$|ModelName$|ModelPoolId$|ModelPoolIds$|OfferingId$|PlatformId$|^ExpectedModel$|^DefaultModel$|^DefaultVideoModel$|^DirectVideoModel$|^OpenApi(Chat|Image)Models$|^McpLiteraryImageModel)", RegexOptions.IgnoreCase);
}
