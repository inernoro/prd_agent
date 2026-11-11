using MongoDB.Bson;

namespace PrdAgent.LlmGw.ModelReferences;

/// <summary>Finite typed configuration handlers; no arbitrary string or prompt replacement.</summary>
public static class ModelReferenceAnalysis
{
    public sealed record Analysis(ReferenceConsumerResult Result, List<ReferenceFinding> Items, List<ReferenceDocumentChange> Changes);
    public static IEnumerable<(string Path, BsonValue Value)> Leaves(BsonValue value, string path = "")
    {
        if (value is BsonDocument doc)
            foreach (var e in doc) foreach (var leaf in Leaves(e.Value, path.Length == 0 ? e.Name : path + "." + e.Name)) yield return leaf;
        else if (value is BsonArray array)
            for (var i = 0; i < array.Count; i++) foreach (var leaf in Leaves(array[i], path + "." + i)) yield return leaf;
        else yield return (path, value);
    }
    public static bool TryGet(BsonDocument doc, string path, out BsonValue value)
    {
        value = doc;
        foreach (var part in path.Split('.'))
        {
            if (value is BsonDocument d && d.TryGetValue(part, out var v)) value = v;
            else if (value is BsonArray a && int.TryParse(part, out var i) && i >= 0 && i < a.Count) value = a[i];
            else { value = BsonNull.Value; return false; }
        }
        return true;
    }
    private static string Text(BsonDocument d, string path) => TryGet(d, path, out var value) && value.IsString ? value.AsString : "";
    public static bool Matches(ReferenceIdentity identity, string? value)
        => !string.IsNullOrEmpty(value) && (new[] { identity.LogicalId, identity.OfferingId,
                identity.PhysicalModelId, identity.UpstreamModelId, identity.LogicalId is { Length: > 0 } id ? "pool_" + id : null }
            .Concat(identity.PoolIds).Concat(identity.PoolIds.Select(x => "pool_" + x)).Any(x => !string.IsNullOrEmpty(x) && string.Equals(x, value, StringComparison.Ordinal))
            || PublicMatch(identity, value));
    public static bool PublicMatch(ReferenceIdentity id, string? value)
        => !string.IsNullOrWhiteSpace(value) && new[] { id.PublicId }.Concat(id.Aliases)
            .Any(x => !string.IsNullOrWhiteSpace(x) && string.Equals(x.Trim(), value.Trim(), StringComparison.OrdinalIgnoreCase));
    private static bool PhysicalMatch(ReferenceIdentity id, string platform, string model)
        => !string.IsNullOrEmpty(id.ProviderId) && platform == id.ProviderId && !string.IsNullOrEmpty(model)
            && (model == id.PhysicalModelId || model == id.UpstreamModelId);
    private static bool BusinessMatch(ReferenceIdentity id, BsonDocument doc, string prefix)
    {
        var logical = Text(doc, prefix + "LogicalModelId");
        if (logical.Length > 0) return logical == id.LogicalId;
        var platform = Text(doc, prefix + "PlatformId"); var model = Text(doc, prefix + "ModelId");
        return platform == "logical-model" ? PublicMatch(id, model) : PhysicalMatch(id, platform, model);
    }
    private static string Replacement(ReferenceMigrationMapping m, string previous, bool publicOnly = false)
    {
        if (publicOnly) return m.Target.PublicId ?? "";
        if (previous.StartsWith("pool_", StringComparison.Ordinal)) return m.Target.LogicalId is { Length: > 0 } id ? "pool_" + id : "";
        if (previous == m.Source.LogicalId || m.Source.PoolIds.Contains(previous, StringComparer.Ordinal)) return m.Target.LogicalId ?? "";
        return m.Target.PublicId ?? "";
    }
    public static bool KnownPath(ReferenceCollection c, string path)
    {
        var normalized = ModelReferenceRegistry.NormalizePath(path);
        if (c.KnownSelectionPaths.Contains(normalized, StringComparer.Ordinal)) return true;
        // Actual snapshots are retained; a new Policy.* selection path still fails closed.
        return c.Mode == "upgrade-policy" && new[] { "Current.", "Candidate.", "History[].", "LastPromotion.", "PendingSwitch." }.Any(normalized.StartsWith);
    }
    public static Analysis Analyze(ReferenceCollection c, IReadOnlyList<BsonDocument> docs,
        IReadOnlyList<string> selectionPaths, ReferenceMigrationMapping m)
    {
        var result = new ReferenceConsumerResult { Key = c.Key, Count = docs.Count };
        var findings = new List<ReferenceFinding>(); var changes = new List<ReferenceDocumentChange>();
        foreach (var path in selectionPaths.Where(p => !KnownPath(c, p)).Distinct(StringComparer.Ordinal))
        {
            result.Unknown++; result.Reasons.Add("发现未登记的模型选择字段，请先登记其消费者与迁移方式。");
            findings.Add(new() { ConsumerKey = c.Key, Collection = c.Collection, Path = path, Status = "unknown", Reason = "UNREGISTERED_SELECTION_PATH" });
        }
        foreach (var doc in docs)
        {
            if (m.ScopeConsumerKey is not null && (c.Key != m.ScopeConsumerKey || Text(doc, "_id") != m.ScopeRecordId)) continue;
            if (c.Mode == "chat" && doc.GetValue("Deleted", false) == BsonBoolean.True) continue;
            var change = new ReferenceDocumentChange { ConsumerKey = c.Key, Database = c.Database, Collection = c.Collection, RecordId = Text(doc, "_id") };
            var owner = new[] { "OwnerUserId", "OwnerAdminId", "UserId", "CreatedBy", "CreatedByUserId" }.Select(x => Text(doc, x)).FirstOrDefault(x => x.Length > 0);
            void Finding(string path, string status, string? reason)
            {
                findings.Add(new() { ConsumerKey = c.Key, Collection = c.Collection, RecordId = change.RecordId, OwnerId = owner, Path = path, Status = status, Reason = reason });
                if (status == "excluded") result.Excluded++;
                else if (status == "unknown") result.Unknown++;
                else { result.Affected++; result.Residual++; if (status == "blocked") result.Blocked++; }
                if (reason is not null && !result.Reasons.Contains(reason)) result.Reasons.Add(reason);
            }
            void Set(string path, BsonValue value)
            {
                var exists = TryGet(doc, path, out var before);
                if (!exists || before != value) change.Fields.Add(new() { Path = path, Existed = exists, Before = before.DeepClone(), After = value });
            }
            void Scalar(string path, bool publicOnly = false)
            {
                if (m.ScopePath is not null && m.ScopePath != path) return;
                if (!TryGet(doc, path, out var value) || value.IsBsonNull) return;
                if (!value.IsString) { Finding(path, "unknown", "MODEL_REFERENCE_SCHEMA_INVALID"); return; }
                var text = value.AsString;
                if (m.Source.LogicalId is { Length: > 0 } same && same == m.Target.LogicalId && m.Source.PublicId == m.Target.PublicId && Matches(m.Target, text)) return;
                if (!(publicOnly ? PublicMatch(m.Source, text) : Matches(m.Source, text))) return;
                var next = Replacement(m, text, publicOnly);
                if (next.Length == 0) { Finding(path, "blocked", "TARGET_IDENTITY_REQUIRED"); return; }
                if (next == text) return; // Stable identity already remains stable; wire is handled separately.
                Finding(path, "affected", null); Set(path, next);
            }
            void Business(string prefix)
            {
                if (m.ScopePath is not null && !new[] { prefix + "LogicalModelId", prefix + "ModelId", prefix + "PlatformId" }.Contains(m.ScopePath, StringComparer.Ordinal)) return;
                foreach (var key in new[] { "LogicalModelId", "PlatformId", "ModelId" })
                    if (TryGet(doc, prefix + key, out var raw) && !raw.IsBsonNull && !raw.IsString) { Finding(prefix + key, "unknown", "MODEL_REFERENCE_SCHEMA_INVALID"); return; }
                if (!BusinessMatch(m.Source, doc, prefix)) return;
                if (string.IsNullOrEmpty(m.Target.LogicalId) || string.IsNullOrEmpty(m.Target.PublicId)) { Finding(prefix + "LogicalModelId", "blocked", "TARGET_LOGICAL_ID_REQUIRED"); return; }
                if (Text(doc, prefix + "LogicalModelId") == m.Target.LogicalId && Text(doc, prefix + "ModelId") == m.Target.PublicId && Text(doc, prefix + "PlatformId") == "logical-model") return;
                Finding(prefix + "LogicalModelId", "affected", null);
                Set(prefix + "LogicalModelId", m.Target.LogicalId); Set(prefix + "PlatformId", "logical-model"); Set(prefix + "ModelId", m.Target.PublicId);
            }
            IEnumerable<string> Members(string path)
            {
                if (!TryGet(doc, path, out var value)) return [];
                if (value is not BsonArray array) { Finding(path, "unknown", "MODEL_REFERENCE_SCHEMA_INVALID"); return []; }
                return Enumerable.Range(0, array.Count).Select(i => path + "." + i + ".").ToArray();
            }
            switch (c.Mode)
            {
                case "business": Business(""); break;
                case "business-array": foreach (var prefix in Members(c.Collection == "model_lab_experiments" ? "SelectedModels" : "Models")) Business(prefix); break;
                case "preferences":
                    Scalar("VisualAgentPreferences.ModelId"); Scalar("LiteraryAgentPreferences.ImageModelId"); Scalar("LiteraryAgentPreferences.ChatModelId"); break;
                case "visual":
                    Scalar("VisualModelPolicy.DefaultModelId", true);
                    foreach (var prefix in Members("VisualModelPolicy.Models")) Scalar(prefix + "ModelId", true);
                    if (change.Fields.Count > 0 && TryGet(doc, "VisualModelPolicy.Revision", out var rev) && rev.IsNumeric) Set("VisualModelPolicy.Revision", rev.ToInt64() + 1);
                    break;
                case "keys":
                    foreach (var path in new[] { "OpenApiChatModels", "OpenApiImageModels" })
                        if ((m.ScopePath is null || m.ScopePath == path) && TryGet(doc, path, out var list))
                        {
                            if (list is not BsonArray a || a.Any(x => !x.IsString)) { Finding(path, "unknown", "MODEL_REFERENCE_SCHEMA_INVALID"); continue; }
                            if (!a.Any(x => PublicMatch(m.Source, x.AsString) && !PublicMatch(m.Target, x.AsString))) continue;
                            var seenTarget = false;
                            var next = new BsonArray(a.Select(x => PublicMatch(m.Source, x.AsString) ? m.Target.PublicId ?? "" : x.AsString)
                                .Where(x => x != m.Target.PublicId || !seenTarget && (seenTarget = true)));
                            if (next.Any(x => x.AsString.Length == 0)) Finding(path, "blocked", "TARGET_PUBLIC_ID_REQUIRED");
                            else if (!next.Equals(a)) { Finding(path, "affected", null); Set(path, next); }
                        }
                    if (doc.GetValue("McpLiteraryImageModelMode", BsonNull.Value) == new BsonInt32(1)) Scalar("McpLiteraryImageModelPublicId", true);
                    break;
                case "scalar": Scalar("DefaultVideoModel"); break;
                case "chat":
                    if (Text(doc, "RunningTurnId").Length > 0 && PublicMatch(m.Source, Text(doc, "Model"))) Finding("Model", "blocked", "ACTIVE_CHAT_TURN_MUST_DRAIN");
                    else Scalar("Model", true);
                    break;
                case "workflow":
                    foreach (var prefix in Members("Nodes"))
                    {
                        var value = Text(doc, prefix + "Config.model"); var type = Text(doc, prefix + "NodeType");
                        if (value.Contains("{{", StringComparison.Ordinal) || value.Contains("${", StringComparison.Ordinal)) { Finding(prefix + "Config.model", "unknown", "VARIABLE_MODEL_REQUIRES_EXPLICIT_MAPPING"); continue; }
                        if (type == "claude-sdk") Scalar(prefix + "Config.model", true);
                        else if (PublicMatch(m.Source, value)) Finding(prefix + "Config.model", "blocked", "INDEPENDENT_OR_UNKNOWN_WORKFLOW_RUNTIME");
                    }
                    break;
                case "roles":
                    if (change.RecordId == m.Source.LogicalId && m.Source.LogicalId != m.Target.LogicalId
                        && (doc.GetValue("IsDefaultForType", false) == BsonBoolean.True || doc.GetValue("DefaultForAppCallerCodes", new BsonArray()) is BsonArray { Count: > 0 }))
                        Finding("DefaultForAppCallerCodes", "blocked", "MOVE_DEFAULT_AND_CLAIMS_THROUGH_AUTHORIZED_GATEWAY_FIRST");
                    break;
                case "inactive":
                    foreach (var leaf in Leaves(doc)) if (leaf.Value.IsString && Matches(m.Source, leaf.Value.AsString))
                        Finding(leaf.Path, "excluded", "INACTIVE_LEGACY_METADATA_RUNTIME_AUTHORITY_CHECKED_SEPARATELY");
                    break;
                case "wire":
                    if (!string.IsNullOrEmpty(m.Source.LogicalId) && Text(doc, "LogicalModelId") == m.Source.LogicalId)
                    {
                        Finding("TargetId", "excluded", "SOURCE_OFFERING_MANAGED_BY_EXISTING_GATEWAY_LIFECYCLE");
                        break;
                    }
                    if (doc.GetValue("Enabled", false) == BsonBoolean.True
                        && (change.RecordId == m.Source.OfferingId || Text(doc, "TargetId") == m.Source.PhysicalModelId && !string.IsNullOrEmpty(m.Source.PhysicalModelId)))
                        Finding("TargetId", "blocked", "SWITCH_VALIDATED_OFFERING_THROUGH_GATEWAY_FIRST");
                    break;
                case "video-run":
                    if (Text(doc, "Status") is "Completed" or "Failed" or "Cancelled") break; // Terminal actual wire is immutable history.
                    foreach (var leaf in Leaves(doc).Where(x => x.Path == "DirectVideoModel" || x.Path.EndsWith(".Model", StringComparison.Ordinal)))
                    {
                        if (!leaf.Value.IsString || !Matches(m.Source, leaf.Value.AsString)) continue;
                        var prefix = leaf.Path.Contains('.') ? leaf.Path[..(leaf.Path.LastIndexOf('.') + 1)] : "DirectVideo";
                        var job = Text(doc, prefix + "JobId");
                        Finding(leaf.Path, "blocked", job.Length > 0 ? "SUBMITTED_VIDEO_JOB_MUST_DRAIN" : "UNSUBMITTED_VIDEO_REQUIRES_LIFECYCLE_VALIDATION");
                    }
                    break;
                case "physical":
                    if (PhysicalMatch(m.Source, Text(doc, "PlatformId"), Text(doc, "ModelName"))) Finding("ModelName", "blocked", "RETIRE_LEGACY_PHYSICAL_MIRROR_THROUGH_GATEWAY");
                    break;
                default:
                    if (c.Collection is "model_groups" or "llmgw_model_pools")
                    {
                        foreach (var prefix in Members("Models")) if (PhysicalMatch(m.Source, Text(doc, prefix + "PlatformId"), Text(doc, prefix + "ModelId"))) Finding(prefix + "ModelId", "blocked", "RETIRE_OLD_POOL_MEMBER_THROUGH_GATEWAY");
                    }
                    else foreach (var leaf in Leaves(doc).Where(x => !ModelReferenceRegistry.MetadataPaths.Contains(x.Path)))
                    {
                        if (leaf.Value.IsString && Matches(m.Source, leaf.Value.AsString) && !Matches(m.Target, leaf.Value.AsString))
                            Finding(leaf.Path, "blocked", c.Mode == "independent" ? "INDEPENDENT_SDK_IDENTITY_REQUIRES_EXPLICIT_ATTESTATION" : "REFERENCE_REQUIRES_SPECIALIZED_AUTHORIZED_MIGRATION");
                    }
                    break;
            }
            if (change.Fields.Count > 0)
            {
                foreach (var leaf in Leaves(doc).Where(x => x.Value.IsString || x.Value.IsNumeric || x.Value.IsBoolean || x.Value.IsValidDateTime || x.Value.IsBsonNull)) change.Conditions.Add(new() { Path = leaf.Path, Existed = true, Before = leaf.Value.DeepClone() });
                CaptureArrays(doc, "", change.ArrayLengths);
                // Missing modified fields are part of the CAS, too.
                foreach (var f in change.Fields.Where(x => !x.Existed)) change.Conditions.Add(new() { Path = f.Path, Existed = false });
                changes.Add(change);
            }
        }
        return new(result, findings, changes);
    }
    private static void CaptureArrays(BsonValue value, string path, Dictionary<string, int> output)
    {
        if (value is BsonArray a) { output[path] = a.Count; for (var i = 0; i < a.Count; i++) CaptureArrays(a[i], path + "." + i, output); }
        else if (value is BsonDocument d) foreach (var e in d) CaptureArrays(e.Value, path.Length == 0 ? e.Name : path + "." + e.Name, output);
    }
}
