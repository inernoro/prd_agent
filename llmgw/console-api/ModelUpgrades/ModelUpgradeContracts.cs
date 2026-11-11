using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Bson;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed class ModelSuccessor
{
    public string ProviderId { get; set; } = "";
    public string FromModel { get; set; } = "";
    public string ToModel { get; set; } = "";
    public string DocumentationUrl { get; set; } = "";
    public List<string> Capabilities { get; set; } = [];
}

public class ModelUpgradePolicy
{
    public bool Enabled { get; set; }
    public string Mode { get; set; } = "manual";
    public bool AutoValidate { get; set; }
    public int CheckIntervalHours { get; set; } = 24;
    [BsonRepresentation(BsonType.Decimal128)]
    public decimal? MaxValidationCostUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)]
    public decimal? CanaryUnitCostUpperBoundUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)]
    public decimal? MaxDailyCostUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)]
    public decimal? MaxPriceIncreasePercent { get; set; }
    public string ValidationAppCallerCode { get; set; } = "";
    public List<ModelSuccessor> Successors { get; set; } = [];
}

public sealed class ModelUpgradePolicyWrite : ModelUpgradePolicy { public long Version { get; set; } }
public sealed class ModelUpgradeAction { public long Version { get; set; } public string? RequestId { get; set; } public string Mode { get; set; } = "evidence"; }
public sealed class ModelUpgradeTarget
{
    public string OfferingId { get; set; } = "";
    public string ModelId { get; set; } = "";
    public string ProviderId { get; set; } = "";
    public string UpstreamModelId { get; set; } = "";
}
public sealed class ModelUpgradeRouteSnapshot
{
    public string OfferingId { get; set; } = "";
    public string LogicalModelId { get; set; } = "";
    public string ModelId { get; set; } = "";
    public string UpstreamModelId { get; set; } = "";
    public string OfferingVersion { get; set; } = "";
    public DateTime? OfferingUpdatedAt { get; set; }
    public string Protocol { get; set; } = "";
    public string? EndpointPath { get; set; }
}
public sealed class ModelUpgradeCandidate
{
    public string ModelId { get; set; } = "";
    public string ProviderId { get; set; } = "";
    public string UpstreamModelId { get; set; } = "";
    public string DocumentationUrl { get; set; } = "";
    public DateTime DiscoveredAt { get; set; }
    public string? ValidationRequestId { get; set; }
    public DateTime? ValidatedAt { get; set; }
    public string Fingerprint { get; set; } = "";
    public ModelUpgradeRouteSnapshot? ValidationRoute { get; set; }
}
public sealed class ModelUpgradeGates
{
    public bool Capabilities { get; set; }
    public bool Price { get; set; }
    public bool Budget { get; set; }
    public bool Validation { get; set; }
}
public sealed class ModelUpgradeHistory
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Action { get; set; } = "";
    public string Status { get; set; } = "";
    public string Message { get; set; } = "";
    public string? RequestId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
public sealed class ModelUpgradeDiscoveryItem
{
    public string ProviderId { get; set; } = "";
    public string UpstreamModelId { get; set; } = "";
    public string Status { get; set; } = "unconfirmed";
    public string Message { get; set; } = "官方目录已发现，尚未确认继任关系、导入和能力。";
}
public sealed class ModelUpgradeView
{
    public string LogicalModelId { get; set; } = "";
    public string PublicId { get; set; } = "";
    public string Name { get; set; } = "";
    public string IdentityKind { get; set; } = "fixed";
    public List<string> Aliases { get; set; } = [];
    public string ModelType { get; set; } = "";
    public long Version { get; set; }
    public ModelUpgradePolicy Policy { get; set; } = new();
    public string Phase { get; set; } = "idle";
    public string Message { get; set; } = "尚未配置自动更新策略。";
    public ModelUpgradeTarget? Current { get; set; }
    public ModelUpgradeCandidate? Candidate { get; set; }
    public ModelUpgradeGates Gates { get; set; } = new();
    public List<ModelUpgradeDiscoveryItem> Discoveries { get; set; } = [];
    public string ValidationStatus { get; set; } = "not-run";
    public DateTime? LastCheckedAt { get; set; }
    public DateTime? NextCheckAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public List<ModelUpgradeHistory> History { get; set; } = [];
    public bool CanPromote { get; set; }
    public bool CanRollback { get; set; }
    public string? ActionDisabledReason { get; set; }
    public string ValidationMode { get; set; } = "evidence";
    public string[] ValidationModes { get; set; } = ["evidence", "canary"];
}

[BsonIgnoreExtraElements]
public sealed class ModelUpgradeState
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = "";
    public string LogicalModelId { get; set; } = "";
    public long Version { get; set; }
    public ModelUpgradePolicy Policy { get; set; } = new();
    public string Phase { get; set; } = "idle";
    public string Message { get; set; } = "尚未检查。";
    public ModelUpgradeTarget? Current { get; set; }
    public ModelUpgradeCandidate? Candidate { get; set; }
    public ModelUpgradeGates Gates { get; set; } = new();
    public List<ModelUpgradeDiscoveryItem> Discoveries { get; set; } = [];
    public string ValidationStatus { get; set; } = "not-run";
    public DateTime? LastCheckedAt { get; set; }
    public DateTime? NextCheckAt { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<ModelUpgradeHistory> History { get; set; } = [];
    public string ActorConsoleUserId { get; set; } = "";
    public string ActorUserId { get; set; } = "";
    public string ActorUsername { get; set; } = "";
    public string PendingAction { get; set; } = "";
    public string? EvidenceRequestId { get; set; }
    public string ValidationMode { get; set; } = "evidence";
    public string ExecutionRequestedBy { get; set; } = "manual";
    public string? LeaseToken { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public string BudgetDate { get; set; } = "";
    [BsonRepresentation(BsonType.Decimal128)]
    public decimal ReservedCostUsd { get; set; }
    public bool OutcomeUnknown { get; set; }
    public ModelUpgradeSwitch? LastPromotion { get; set; }
    public ModelUpgradeSwitch? PendingSwitch { get; set; }
}
public sealed class ModelUpgradeSwitch
{
    public string OperationId { get; set; } = "";
    public string PreviousOfferingId { get; set; } = "";
    public string NewOfferingId { get; set; } = "";
    public bool RolledBack { get; set; }
}

public sealed class ModelUpgradeException(string code, string message, int status = 409) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}
