using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Infrastructure.LlmGateway;

[BsonIgnoreExtraElements]
public sealed class GatewayServiceKeyRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string KeyHash { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public string SourceSystem { get; set; } = "external";
    public List<string> AppCallerCodes { get; set; } = new();
    public List<string> IngressProtocols { get; set; } = new();
    public List<string> Scopes { get; set; } = new();
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastUsedAt { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayBudgetMonthRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string AppCallerCode { get; set; } = string.Empty;
    public string RequestType { get; set; } = string.Empty;
    public DateTime MonthStart { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal BudgetUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReservedUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal SpentUsd { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class GatewayBudgetReservationRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string AppCallerCode { get; set; } = string.Empty;
    public string RequestType { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public DateTime MonthStart { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReservedUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? SettledUsd { get; set; }
    public string Status { get; set; } = "reserved";
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddHours(24);
}

[BsonIgnoreExtraElements]
public sealed class GatewayRequestExecutionRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string AppCallerCode { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public string Operation { get; set; } = string.Empty;
    public string Fingerprint { get; set; } = string.Empty;
    public string Status { get; set; } = "running";
    public string? ResponseJson { get; set; }
    public string? ErrorCode { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(7);
}

[BsonIgnoreExtraElements]
public sealed class GatewayMultipartObjectRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string RequestId { get; set; } = string.Empty;
    public string RefKey { get; set; } = string.Empty;
    public string Sha256 { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string Status { get; set; } = "uploaded";
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddHours(24);
    public DateTime? DeletedAt { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayProviderConcurrencySlotRecord
{
    public string Id { get; set; } = string.Empty;
    public string ResourceKey { get; set; } = string.Empty;
    public int Slot { get; set; }
    public string LeaseId { get; set; } = string.Empty;
    public string OwnerInstance { get; set; } = string.Empty;
    public DateTime AcquiredAt { get; set; }
    public DateTime ExpiresAt { get; set; }
}
