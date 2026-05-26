using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 毒舌秘书 - 跨会话画像（Profile）
///
/// 用户画像与会话 / 消息 / 任务彼此独立：
/// - 一个用户一条 PaUserProfile（UserId unique）
/// - LLM 在 chat 末尾输出 `update_profile` JSON 时由 Controller 异步落盘
/// - Auto 立即注入 prompt，Suggest 等用户在画像面板确认才注入
/// </summary>
public partial class PaAgentController
{
    /// <summary>注入到 SystemPrompt 的 memory 数量上限，避免 token 爆炸</summary>
    private const int MaxInjectMemories = 10;

    /// <summary>注入到 SystemPrompt 的 memory 总字符数上限</summary>
    private const int MaxInjectMemoryChars = 1500;

    /// <summary>单次 update_profile 最多接受的 patches 条数</summary>
    private const int MaxPatchesPerUpdate = 3;

    /// <summary>单条 memory text 上限</summary>
    private const int MaxMemoryTextChars = 60;

    // ──────────────────────────────────────────────────────────────────
    // Profile CRUD
    // ──────────────────────────────────────────────────────────────────

    /// <summary>读取当前用户画像，不存在时返回空骨架（不入库）</summary>
    [HttpGet("profile")]
    public async Task<IActionResult> GetProfile()
    {
        var userId = GetUserId();
        var profile = await _db.PaUserProfiles
            .Find(p => p.UserId == userId)
            .FirstOrDefaultAsync();

        profile ??= new PaUserProfile
        {
            UserId = userId,
            DisplayNameCache = GetDisplayName() ?? string.Empty,
        };

        return Ok(ApiResponse<PaUserProfile>.Ok(profile));
    }

    public class UpdateProfileRequest
    {
        public PaWorkRhythm? Rhythm { get; set; }
        public PaUserPreferences? Preferences { get; set; }
    }

    /// <summary>批量更新 rhythm / preferences（不动 memories 列表本身）</summary>
    [HttpPut("profile")]
    public async Task<IActionResult> UpdateProfile([FromBody] UpdateProfileRequest req)
    {
        var userId = GetUserId();
        var profile = await EnsureProfileAsync(userId);

        if (req.Rhythm != null) profile.Rhythm = req.Rhythm;
        if (req.Preferences != null) profile.Preferences = req.Preferences;
        profile.UpdatedAt = DateTime.UtcNow;
        profile.LastActiveAt = DateTime.UtcNow;

        await _db.PaUserProfiles.ReplaceOneAsync(
            p => p.Id == profile.Id, profile,
            new ReplaceOptions { IsUpsert = true });

        return Ok(ApiResponse<PaUserProfile>.Ok(profile));
    }

    public class CreateMemoryRequest
    {
        public string Kind { get; set; } = PaMemoryKind.Fact;
        public string Text { get; set; } = string.Empty;
    }

    /// <summary>手动添加一条 memory（source=manual，立即生效）</summary>
    [HttpPost("profile/memories")]
    public async Task<IActionResult> AddMemory([FromBody] CreateMemoryRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Text))
            return BadRequest(ApiResponse<object>.Fail("CONTENT_EMPTY", "事实文本不能为空"));

        var text = req.Text.Trim();
        if (text.Length > MaxMemoryTextChars)
            text = text[..MaxMemoryTextChars];

        var kind = PaMemoryKind.All.Contains(req.Kind) ? req.Kind : PaMemoryKind.Fact;

        var userId = GetUserId();
        var profile = await EnsureProfileAsync(userId);

        var entry = new PaMemoryEntry
        {
            Kind = kind,
            Text = text,
            Source = PaMemorySource.Manual,
            Status = PaMemoryStatus.Active,
        };
        profile.Memories.Insert(0, entry);
        profile.UpdatedAt = DateTime.UtcNow;
        profile.LastActiveAt = DateTime.UtcNow;

        await _db.PaUserProfiles.ReplaceOneAsync(
            p => p.Id == profile.Id, profile,
            new ReplaceOptions { IsUpsert = true });

        return Ok(ApiResponse<PaMemoryEntry>.Ok(entry));
    }

    /// <summary>把一条 suggest memory 确认为 manual（开始参与注入）</summary>
    [HttpPost("profile/memories/{id}/confirm")]
    public async Task<IActionResult> ConfirmMemory(string id)
    {
        var userId = GetUserId();
        var profile = await _db.PaUserProfiles.Find(p => p.UserId == userId).FirstOrDefaultAsync();
        if (profile == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "画像不存在"));

        var entry = profile.Memories.FirstOrDefault(m => m.Id == id);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "memory 不存在"));

        entry.Source = PaMemorySource.Manual;
        entry.Status = PaMemoryStatus.Active;
        entry.UpdatedAt = DateTime.UtcNow;
        profile.UpdatedAt = DateTime.UtcNow;

        await _db.PaUserProfiles.ReplaceOneAsync(p => p.Id == profile.Id, profile);
        return Ok(ApiResponse<PaMemoryEntry>.Ok(entry));
    }

    /// <summary>删除一条 memory（软删除：status=archived）</summary>
    [HttpDelete("profile/memories/{id}")]
    public async Task<IActionResult> DeleteMemory(string id)
    {
        var userId = GetUserId();
        var profile = await _db.PaUserProfiles.Find(p => p.UserId == userId).FirstOrDefaultAsync();
        if (profile == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "画像不存在"));

        var entry = profile.Memories.FirstOrDefault(m => m.Id == id);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "memory 不存在"));

        entry.Status = PaMemoryStatus.Archived;
        entry.UpdatedAt = DateTime.UtcNow;
        profile.UpdatedAt = DateTime.UtcNow;

        await _db.PaUserProfiles.ReplaceOneAsync(p => p.Id == profile.Id, profile);
        return Ok(ApiResponse<object>.Ok(new { }));
    }

    // ──────────────────────────────────────────────────────────────────
    // Profile injection (consumed by Chat & Review)
    // ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// 加载或创建用户画像；如果用户显示名变了则同步缓存。
    /// 给 Chat / Review 调用，永远返回非 null。
    /// </summary>
    private async Task<PaUserProfile> LoadOrCreateProfileAsync(string userId, string? displayName)
    {
        var profile = await _db.PaUserProfiles
            .Find(p => p.UserId == userId)
            .FirstOrDefaultAsync();

        if (profile == null)
        {
            profile = new PaUserProfile
            {
                UserId = userId,
                DisplayNameCache = displayName ?? string.Empty,
            };
            try
            {
                await _db.PaUserProfiles.InsertOneAsync(profile);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 并发场景：另一个请求刚创建。重读即可。
                profile = await _db.PaUserProfiles.Find(p => p.UserId == userId).FirstOrDefaultAsync()
                          ?? profile;
            }
            return profile;
        }

        if (!string.IsNullOrWhiteSpace(displayName) && profile.DisplayNameCache != displayName)
        {
            profile.DisplayNameCache = displayName;
            await _db.PaUserProfiles.UpdateOneAsync(
                p => p.Id == profile.Id,
                Builders<PaUserProfile>.Update.Set(p => p.DisplayNameCache, displayName));
        }

        return profile;
    }

    private async Task<PaUserProfile> EnsureProfileAsync(string userId)
    {
        return await LoadOrCreateProfileAsync(userId, GetDisplayName());
    }

    /// <summary>
    /// 把画像渲染成插入 SystemPrompt 的纯文本块。
    /// 空骨架返回空串；只注入 active 状态、且 Source 为 manual / auto 的条目（suggest 待确认不入注入）。
    /// </summary>
    private static string BuildProfileBlock(PaUserProfile profile)
    {
        var sb = new StringBuilder();

        var rhythmLines = new List<string>();
        if (profile.Rhythm.TypicalStartHour.HasValue && profile.Rhythm.TypicalEndHour.HasValue)
            rhythmLines.Add($"通常工作时段 {profile.Rhythm.TypicalStartHour:00}:00-{profile.Rhythm.TypicalEndHour:00}:00");
        if (profile.Rhythm.WeekendActive)
            rhythmLines.Add("周末也活跃");
        if (!string.IsNullOrWhiteSpace(profile.Rhythm.PerfectionismLevel))
            rhythmLines.Add($"完美主义倾向：{profile.Rhythm.PerfectionismLevel}");

        var prefLines = new List<string>();
        if (!string.IsNullOrWhiteSpace(profile.Preferences.PreferredAddress))
            prefLines.Add($"喜欢被叫「{profile.Preferences.PreferredAddress}」（覆盖姓名规则）");
        if (profile.Preferences.ForbiddenTopics.Count > 0)
            prefLines.Add($"禁用话题：{string.Join(" / ", profile.Preferences.ForbiddenTopics)}");
        if (!string.IsNullOrWhiteSpace(profile.Preferences.SavageLevel) && profile.Preferences.SavageLevel != "default")
            prefLines.Add($"毒舌强度偏好：{profile.Preferences.SavageLevel}");

        // 注入条目：manual + auto，按 UpdatedAt(或 CreatedAt) 倒序 + 字符上限
        var injectable = profile.Memories
            .Where(m => m.Status == PaMemoryStatus.Active &&
                        (m.Source == PaMemorySource.Manual || m.Source == PaMemorySource.Auto))
            .OrderByDescending(m => m.UpdatedAt ?? m.CreatedAt)
            .ToList();

        var memoryLines = new List<string>();
        var totalChars = 0;
        foreach (var m in injectable)
        {
            if (memoryLines.Count >= MaxInjectMemories) break;
            var line = $"{m.Text}";
            if (totalChars + line.Length > MaxInjectMemoryChars) break;
            memoryLines.Add(line);
            totalChars += line.Length;
        }

        if (rhythmLines.Count == 0 && prefLines.Count == 0 && memoryLines.Count == 0)
            return string.Empty;

        sb.AppendLine();
        sb.AppendLine("# 用户画像（来自历史对话，仅在影响回复时引用，不要复读字段）");
        if (rhythmLines.Count > 0)
        {
            foreach (var line in rhythmLines) sb.AppendLine($"- {line}");
        }
        if (prefLines.Count > 0)
        {
            foreach (var line in prefLines) sb.AppendLine($"- {line}");
        }
        if (memoryLines.Count > 0)
        {
            sb.AppendLine("- 持久事实：");
            var idx = 1;
            foreach (var line in memoryLines) sb.AppendLine($"  {idx++}. {line}");
        }
        return sb.ToString();
    }

    // ──────────────────────────────────────────────────────────────────
    // update_profile JSON parsing
    // ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// 扫描 LLM 完整回复里所有 ```json``` fenced block，找到 `action=="update_profile"` 的那一块，
    /// 解析 patches 并应用到 profile。返回结果用于推 SSE profile 事件。
    /// 任何解析错误吞掉并 log，不影响主流程。
    /// </summary>
    private async Task<object?> TryApplyProfileUpdateAsync(string userId, string fullReply)
    {
        // 扫描所有 json 代码块，逐个尝试匹配 update_profile
        var matches = System.Text.RegularExpressions.Regex.Matches(
            fullReply, @"```json\s*([\s\S]*?)```");

        foreach (System.Text.RegularExpressions.Match m in matches)
        {
            JsonElement root;
            try
            {
                using var doc = JsonDocument.Parse(m.Groups[1].Value);
                root = doc.RootElement.Clone();
            }
            catch
            {
                continue;
            }

            if (!root.TryGetProperty("action", out var actionEl) ||
                actionEl.GetString() != "update_profile")
                continue;

            var confidence = root.TryGetProperty("confidence", out var confEl)
                ? confEl.GetString() : "auto";
            var source = confidence == PaMemorySource.Suggest
                ? PaMemorySource.Suggest
                : PaMemorySource.Auto;

            if (!root.TryGetProperty("patches", out var patchesEl) ||
                patchesEl.ValueKind != JsonValueKind.Array)
                continue;

            var profile = await EnsureProfileAsync(userId);

            var addedMemories = new List<PaMemoryEntry>();
            var changedFields = new List<string>();

            var patchCount = 0;
            foreach (var patchEl in patchesEl.EnumerateArray())
            {
                if (patchCount >= MaxPatchesPerUpdate) break;
                if (patchEl.ValueKind != JsonValueKind.Object) continue;
                patchCount++;

                var op = patchEl.TryGetProperty("op", out var opEl) ? opEl.GetString() : null;

                if (op == "add")
                {
                    var kind = patchEl.TryGetProperty("kind", out var kEl) ? kEl.GetString() : PaMemoryKind.Fact;
                    var text = patchEl.TryGetProperty("text", out var tEl) ? tEl.GetString() : null;
                    if (string.IsNullOrWhiteSpace(text)) continue;
                    text = text.Trim();
                    if (text.Length > MaxMemoryTextChars) text = text[..MaxMemoryTextChars];
                    if (!PaMemoryKind.All.Contains(kind ?? "")) kind = PaMemoryKind.Fact;

                    // 去重：同文本已存在的 active 条目跳过
                    if (profile.Memories.Any(x => x.Status == PaMemoryStatus.Active &&
                                                  string.Equals(x.Text, text, StringComparison.OrdinalIgnoreCase)))
                        continue;

                    var entry = new PaMemoryEntry
                    {
                        Kind = kind!,
                        Text = text,
                        Source = source,
                        Status = PaMemoryStatus.Active,
                    };
                    profile.Memories.Insert(0, entry);
                    addedMemories.Add(entry);
                }
                else if (op == "set")
                {
                    var field = patchEl.TryGetProperty("field", out var fEl) ? fEl.GetString() : null;
                    if (string.IsNullOrWhiteSpace(field)) continue;
                    if (!patchEl.TryGetProperty("value", out var vEl)) continue;

                    if (ApplyFieldSet(profile, field, vEl, source))
                        changedFields.Add(field);
                }
            }

            if (addedMemories.Count == 0 && changedFields.Count == 0)
                continue;

            profile.UpdatedAt = DateTime.UtcNow;
            profile.LastActiveAt = DateTime.UtcNow;
            await _db.PaUserProfiles.ReplaceOneAsync(
                p => p.Id == profile.Id, profile,
                new ReplaceOptions { IsUpsert = true });

            return new
            {
                confidence = source,
                addedMemories = addedMemories.Select(m => new
                {
                    id = m.Id, kind = m.Kind, text = m.Text, source = m.Source,
                }).ToArray(),
                changedFields = changedFields.ToArray(),
            };
        }

        return null;
    }

    /// <summary>
    /// 应用 `op=set` 类型的 patch 到 rhythm / preferences 字段。
    /// 只接受白名单字段；suggest 来源不直接改 rhythm/preferences（这两类不属于 memory，
    /// 走 suggest 没有"确认面板"接得住，所以 suggest 的 set 一律忽略）。
    /// </summary>
    private static bool ApplyFieldSet(PaUserProfile profile, string field, JsonElement valueEl, string source)
    {
        if (source != PaMemorySource.Auto && source != PaMemorySource.Manual) return false;

        switch (field)
        {
            case "rhythm.typicalStartHour":
                if (valueEl.ValueKind == JsonValueKind.Number && valueEl.TryGetInt32(out var s) && s >= 0 && s <= 23)
                {
                    profile.Rhythm.TypicalStartHour = s;
                    return true;
                }
                return false;
            case "rhythm.typicalEndHour":
                if (valueEl.ValueKind == JsonValueKind.Number && valueEl.TryGetInt32(out var e) && e >= 0 && e <= 23)
                {
                    profile.Rhythm.TypicalEndHour = e;
                    return true;
                }
                return false;
            case "rhythm.weekendActive":
                if (valueEl.ValueKind == JsonValueKind.True || valueEl.ValueKind == JsonValueKind.False)
                {
                    profile.Rhythm.WeekendActive = valueEl.GetBoolean();
                    return true;
                }
                return false;
            case "rhythm.perfectionismLevel":
                if (valueEl.ValueKind == JsonValueKind.String)
                {
                    var level = valueEl.GetString();
                    if (level == "low" || level == "mid" || level == "high")
                    {
                        profile.Rhythm.PerfectionismLevel = level;
                        return true;
                    }
                }
                return false;
            case "preferences.preferredAddress":
                if (valueEl.ValueKind == JsonValueKind.String)
                {
                    var addr = valueEl.GetString();
                    if (!string.IsNullOrWhiteSpace(addr) && addr.Length <= 20)
                    {
                        profile.Preferences.PreferredAddress = addr.Trim();
                        return true;
                    }
                }
                return false;
            case "preferences.savageLevel":
                if (valueEl.ValueKind == JsonValueKind.String)
                {
                    var level = valueEl.GetString();
                    if (level == "gentle" || level == "default" || level == "sharp")
                    {
                        profile.Preferences.SavageLevel = level;
                        return true;
                    }
                }
                return false;
            default:
                return false;
        }
    }
}
