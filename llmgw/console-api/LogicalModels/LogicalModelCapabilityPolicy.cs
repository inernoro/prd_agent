using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 逻辑模型能力的**写入侧**判据。
///
/// 唯一权威定义在 <c>prd-api/src/PrdAgent.Core/Models/GatewayCapabilityContract.cs</c>
/// （运行时 ModelResolver 与 llmgw serving readiness 都直接引用它）。
/// 本项目按既定架构不引用 PrdAgent.*（见 docker-compose.yml 注释：剥离失败不波及主站，
/// 镜像构建上下文也只有 llmgw/console-api），因此这里保留一份**镜像**。
///
/// 镜像不是「再写一遍判据」——两张表由守卫测试
/// <c>prd-api/tests/PrdAgent.Api.Tests/Gateway/GatewayCapabilityContractMirrorGuardTests.cs</c>
/// 逐条比对，任何一侧新增规范能力或历史别名而另一侧没跟上，CI 立刻变红。
/// 2026-08-13 事故的根因正是「写入侧只认 image_generation、运行时也只认 image_generation，
/// 而正式数据是 image-gen」——两份判据各自漂移，没有任何东西发现它们已经不一致。
/// </summary>
public static class LogicalModelCapabilityPolicy
{
    /// <summary>能力契约版本，必须与 GatewayCapabilityContract.SchemaVersion 相同。</summary>
    public const int SchemaVersion = 1;

    /// <summary>承载契约版本的字段名，必须与 GatewayCapabilityContract.SchemaVersionField 相同。</summary>
    public const string SchemaVersionField = "CapabilitySchemaVersion";

    public const string ImageGeneration = "image_generation";
    public const string ImageLayering = "image_layering";

    public static readonly IReadOnlyList<string> ImageScenarioCapabilities =
        ["text2img", "img2img", "vision_generation"];

    /// <summary>规范能力全集。与 GatewayCapabilityContract.KnownCapabilities 逐条对齐。</summary>
    public static readonly IReadOnlySet<string> CanonicalCapabilities = new HashSet<string>(StringComparer.Ordinal)
    {
        "image_generation", "text2img", "img2img", "vision_generation", "image_layering",
        "chat", "intent", "vision", "code", "long_context", "embedding", "rerank",
        "asr", "tts", "video_generation", "audio_generation", "moderation",
        "function_calling", "tool_calling", "tools",
        "image_input", "multimodal", "image",
        "thinking", "reasoning",
        "structured_output", "json_schema", "json_mode", "response_format",
        "logprobs", "top_logprobs", "token_logprobs",
        "parallel_tool_calls", "parallel_tools", "parallel_function_calling",
    };

    /// <summary>有限历史别名。与 GatewayCapabilityContract.LegacyAliasMap 逐条对齐。</summary>
    public static readonly IReadOnlyDictionary<string, string> LegacyAliases =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["image-gen"] = "image_generation",
            ["image_gen"] = "image_generation",
            ["text_to_image"] = "image_generation",
            ["text-to-image"] = "image_generation",
            ["image-generation"] = "image_generation",
            ["video-gen"] = "video_generation",
            ["video-generation"] = "video_generation",
            ["audio-gen"] = "audio_generation",
            ["audio-generation"] = "audio_generation",
            ["long-context"] = "long_context",
            ["vision-generation"] = "vision_generation",
            ["image-layering"] = "image_layering",
            ["text2image"] = "text2img",
            ["img2image"] = "img2img",
        };

    public static string? TryCanonicalize(string? raw)
    {
        var token = (raw ?? string.Empty).Trim().ToLowerInvariant();
        if (token.Length == 0) return null;
        if (CanonicalCapabilities.Contains(token)) return token;
        return LegacyAliases.TryGetValue(token, out var canonical) ? canonical : null;
    }

    /// <summary>
    /// 归一化能力数组。落库值 = 规范能力（按首次出现次序）+ 生图场景补齐 + 未知原值。
    /// 未知能力**不丢弃**：原样保留，由 <see cref="Unknown"/> 报出来交给发布门禁点名阻断。
    /// </summary>
    public static List<string> Normalize(string? modelType, IEnumerable<string>? capabilities)
        => NormalizeDetailed(modelType, capabilities).Persisted;

    public static CapabilityNormalization NormalizeDetailed(string? modelType, IEnumerable<string>? capabilities)
    {
        var input = (capabilities ?? []).Select(x => (x ?? string.Empty).Trim()).Where(x => x.Length > 0).ToList();
        var canonical = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var unknown = new List<string>();
        var unknownSeen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var token in input)
        {
            var resolved = TryCanonicalize(token);
            if (resolved is null)
            {
                if (unknownSeen.Add(token)) unknown.Add(token);
                continue;
            }
            if (seen.Add(resolved)) canonical.Add(resolved);
        }

        var isGeneration = string.Equals(modelType?.Trim(), "generation", StringComparison.OrdinalIgnoreCase);
        if (isGeneration
            && seen.Contains(ImageGeneration)
            && !ImageScenarioCapabilities.Any(seen.Contains))
        {
            foreach (var scenario in ImageScenarioCapabilities)
            {
                if (seen.Add(scenario)) canonical.Add(scenario);
            }
        }

        var persisted = canonical.Concat(unknown).ToList();
        var changed = !persisted.SequenceEqual(input, StringComparer.Ordinal);
        return new CapabilityNormalization(persisted, canonical, unknown, changed);
    }

    /// <summary>未识别的能力原值。</summary>
    public static IReadOnlyList<string> Unknown(string? modelType, IEnumerable<string>? capabilities)
        => NormalizeDetailed(modelType, capabilities).Unknown;

    /// <summary>
    /// 幂等能力迁移：把存量逻辑模型的 Capabilities 归一到规范值并盖上契约版本。
    ///
    /// 幂等保证：只有归一结果与现值不同、或契约版本落后时才写；第二次执行 Rewritten=0。
    /// 迁移前统计 + 迁移后回读都在返回值里，未知能力逐个点名（PublicId + 原值），
    /// 交由发布门禁阻断，绝不静默丢弃。
    /// </summary>
    public static async Task<CapabilityMigrationReport> MigrateAsync(
        IMongoCollection<BsonDocument> logicalModels,
        CancellationToken ct)
    {
        var before = new List<CapabilityMigrationFinding>();
        var rewritten = 0;
        var scanned = 0;

        using (var cursor = await logicalModels.Find(FilterDefinition<BsonDocument>.Empty).ToCursorAsync(ct))
        {
            while (await cursor.MoveNextAsync(ct))
            {
                foreach (var doc in cursor.Current)
                {
                    ct.ThrowIfCancellationRequested();
                    scanned++;

                    var id = doc.TryGetValue("_id", out var idValue) ? idValue.ToString() ?? string.Empty : string.Empty;
                    var publicId = doc.TryGetValue("PublicId", out var pv) && pv.IsString ? pv.AsString : id;
                    var modelType = doc.TryGetValue("ModelType", out var mv) && mv.IsString ? mv.AsString : string.Empty;
                    var current = doc.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray
                        ? cv.AsBsonArray.Where(x => x.IsString).Select(x => x.AsString).ToList()
                        : [];
                    var version = doc.TryGetValue(SchemaVersionField, out var sv) && sv.IsInt32 ? sv.AsInt32 : 0;

                    var normalization = NormalizeDetailed(modelType, current);
                    if (normalization.Unknown.Count > 0)
                    {
                        before.Add(new CapabilityMigrationFinding(id, publicId, modelType, normalization.Unknown));
                    }

                    if (!normalization.Changed && version == SchemaVersion) continue;

                    await logicalModels.UpdateOneAsync(
                        Builders<BsonDocument>.Filter.Eq("_id", doc["_id"]),
                        Builders<BsonDocument>.Update
                            .Set("Capabilities", new BsonArray(normalization.Persisted))
                            .Set(SchemaVersionField, SchemaVersion)
                            .Set("UpdatedAt", DateTime.UtcNow),
                        cancellationToken: ct);
                    rewritten++;
                }
            }
        }

        // 迁移后回读：只信数据库回读的结果，不信内存里算过一遍就当成功。
        var residualAliases = 0;
        var stillUnversioned = 0;
        using (var cursor = await logicalModels.Find(FilterDefinition<BsonDocument>.Empty).ToCursorAsync(ct))
        {
            while (await cursor.MoveNextAsync(ct))
            {
                foreach (var doc in cursor.Current)
                {
                    var caps = doc.TryGetValue("Capabilities", out var cv) && cv.IsBsonArray
                        ? cv.AsBsonArray.Where(x => x.IsString).Select(x => x.AsString).ToList()
                        : [];
                    if (caps.Any(c => LegacyAliases.ContainsKey((c ?? string.Empty).Trim().ToLowerInvariant())))
                        residualAliases++;
                    var version = doc.TryGetValue(SchemaVersionField, out var sv) && sv.IsInt32 ? sv.AsInt32 : 0;
                    if (version != SchemaVersion) stillUnversioned++;
                }
            }
        }

        return new CapabilityMigrationReport(scanned, rewritten, residualAliases, stillUnversioned, before);
    }
}

/// <param name="Persisted">应落库的能力数组（规范值在前，未知原值在后）。</param>
/// <param name="Canonical">参与路由判定的规范能力。</param>
/// <param name="Unknown">未识别的能力原值。</param>
/// <param name="Changed">与输入是否不同；迁移据此判断是否需要写。</param>
public sealed record CapabilityNormalization(
    List<string> Persisted,
    List<string> Canonical,
    List<string> Unknown,
    bool Changed);

/// <param name="Id">逻辑模型文档 ID。</param>
/// <param name="PublicId">逻辑模型公开标识（点名用）。</param>
/// <param name="ModelType">模型用途。</param>
/// <param name="UnknownCapabilities">该对象上无法识别的能力原值。</param>
public sealed record CapabilityMigrationFinding(
    string Id,
    string PublicId,
    string ModelType,
    IReadOnlyList<string> UnknownCapabilities);

/// <param name="Scanned">扫描到的逻辑模型总数（迁移前统计）。</param>
/// <param name="Rewritten">实际发生重写的对象数；幂等执行第二次应为 0。</param>
/// <param name="ResidualLegacyAliases">迁移后回读仍带历史别名的对象数；正常必须为 0。</param>
/// <param name="StillUnversioned">迁移后回读契约版本仍不达标的对象数；正常必须为 0。</param>
/// <param name="UnknownFindings">带未知能力的对象清单，逐个点名，交发布门禁阻断。</param>
public sealed record CapabilityMigrationReport(
    int Scanned,
    int Rewritten,
    int ResidualLegacyAliases,
    int StillUnversioned,
    IReadOnlyList<CapabilityMigrationFinding> UnknownFindings)
{
    /// <summary>迁移是否干净：无残留别名、无未打版本、无未知能力。</summary>
    public bool IsClean => ResidualLegacyAliases == 0 && StillUnversioned == 0 && UnknownFindings.Count == 0;
}
